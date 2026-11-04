from __future__ import annotations

from urllib.parse import parse_qs, urlparse

from music_app.services.musicbrainz_client import MusicBrainzClient
from music_app.services.musicbrainz_enrichment import resolve_artist


GERMAN = "00000000-0000-4000-8000-000000000011"
TRANCE = "00000000-0000-4000-8000-000000000012"
OTHER = "00000000-0000-4000-8000-000000000013"
OK = {"status": "network", "http_status": 200, "cache_hit": False}


def _client(release_groups, *, artists=None, search=None, fail_browse=False):
    calls: list[str] = []
    artists = artists or {
        GERMAN: {"id": GERMAN, "name": "Axxis", "type": "Group", "country": "DE",
                 "disambiguation": "German hard rock band"},
        TRANCE: {"id": TRANCE, "name": "Axxis", "type": "Group", "disambiguation": "trance duo"},
        OTHER: {"id": OTHER, "name": "Axis Mundi", "type": "Group"},
    }
    search = search or [
        {"id": GERMAN, "name": "Axxis", "score": 100},
        {"id": TRANCE, "name": "Axxis", "score": 100},
        {"id": OTHER, "name": "Axis Mundi", "score": 60},
    ]

    def get_json(url, _user_agent, **_kwargs):
        calls.append(url)
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        if parsed.path.endswith("/artist/"):
            return {"count": len(search), "artists": search}, OK
        if parsed.path.endswith("/release-group"):
            if fail_browse:
                return None, {"status": "timeout", "cache_hit": False}
            groups = release_groups.get(query["artist"][0], [])
            offset = int(query.get("offset", ["0"])[0])
            page = groups[offset:offset + 100]
            return {"release-group-count": len(groups),
                    "release-groups": [{"title": title} for title in page]}, OK
        mbid = parsed.path.rsplit("/", 1)[-1]
        return artists[mbid], OK

    client = MusicBrainzClient(base_url="https://mirror.test/ws/2/", user_agent="Test", get_json=get_json)
    return client, calls


def _context(*titles):
    return {"local_artist_id": 7, "local_name": "Axxis", "album_titles": list(titles)}


def test_search_match_uses_candidate_release_groups_against_local_albums():
    client, calls = _client({
        GERMAN: ["Kingdom of the Night", "Axxis II", "Matters of Survival"],
        TRANCE: ["Dancefloor Mix"],
    })

    outcome = resolve_artist(_context("Kingdom of the Night", "Axxis II"), client=client)

    assert outcome["classification"] == "found"
    assert outcome["artist"]["mbid"] == GERMAN
    browsed = [url for url in calls if "/release-group" in url]
    assert len(browsed) == 2, "only name-matching candidates need release-group evidence"
    assert not any(OTHER in url for url in calls), "non-matching candidates cost no requests"


def test_ambiguous_candidates_carry_local_album_agreement_and_display_facts():
    client, _calls = _client({
        GERMAN: ["Kingdom of the Night"],
        TRANCE: ["Kingdom of the Night"],
    })

    outcome = resolve_artist(_context("Kingdom of the Night", "Back to the Kingdom"), client=client)

    assert outcome["classification"] == "ambiguous"
    by_mbid = {candidate["artist_mbid"]: candidate for candidate in outcome["candidates"]}
    assert by_mbid[GERMAN]["evidence_summary"] == "1 of 2 albums agree"
    assert by_mbid[GERMAN]["disambiguation"] == "German hard rock band"
    assert by_mbid[GERMAN]["artist_kind"] == "Group"
    assert by_mbid[GERMAN]["country_code"] == "DE"
    assert OTHER not in by_mbid, "a candidate whose name never agrees is not a reviewable choice"


def test_release_group_browse_failure_is_a_provider_outcome_not_a_mismatch():
    client, _calls = _client({}, fail_browse=True)

    outcome = resolve_artist(_context("Kingdom of the Night"), client=client)

    assert outcome["classification"] == "provider_unavailable"


def test_release_group_browse_is_bounded_and_stops_once_local_titles_are_found():
    many = [f"Filler {index}" for index in range(450)] + ["Kingdom of the Night"]
    client, calls = _client({GERMAN: many}, search=[{"id": GERMAN, "name": "Axxis", "score": 100}])

    outcome = resolve_artist(_context("Kingdom of the Night"), client=client)

    browsed = [url for url in calls if "/release-group" in url]
    assert len(browsed) == 5
    assert outcome["classification"] == "found"

    client, calls = _client({GERMAN: ["Kingdom of the Night"] + many},
                            search=[{"id": GERMAN, "name": "Axxis", "score": 100}])
    resolve_artist(_context("Kingdom of the Night"), client=client)
    assert len([url for url in calls if "/release-group" in url]) == 1


def test_request_volume_per_artist_is_bounded_for_backfill_assessment():
    # One search page, then one lookup and one release-group page per
    # name-matching candidate: Axxis with two same-name candidates costs 5.
    client, calls = _client({GERMAN: ["Kingdom of the Night"], TRANCE: ["Dancefloor Mix"]})

    resolve_artist(_context("Kingdom of the Night"), client=client)

    assert len(calls) == 5
    assert sum("/artist/?" in url for url in calls) == 1
    assert sum("/release-group" in url for url in calls) == 2
