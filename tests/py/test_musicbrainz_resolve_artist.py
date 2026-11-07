from __future__ import annotations

from urllib.parse import parse_qs, urlparse

from music_app.services.musicbrainz_client import MusicBrainzClient
from music_app.services.musicbrainz_enrichment import resolve_artist
from tests.py.musicbrainz_test_mirror import OK, albums, release_groups_payload, release_paths


GERMAN = "00000000-0000-4000-8000-000000000011"
TRANCE = "00000000-0000-4000-8000-000000000012"
OTHER = "00000000-0000-4000-8000-000000000013"


def _client(release_groups, *, artists=None, search=None, fail_browse=False):
    calls: list[str] = []
    artists = artists or {
        GERMAN: {"id": GERMAN, "name": "Axxis", "type": "Group", "country": "DE",
                 "disambiguation": "German hard rock band"},
        TRANCE: {"id": TRANCE, "name": "Axxis", "type": "Group", "disambiguation": "trance duo"},
        OTHER: {"id": OTHER, "name": "Axis Mundi", "type": "Group"},
    }
    # Search results carry the display facts, as on the mirror.
    search = search or [
        {"id": GERMAN, "name": "Axxis", "score": 100, "type": "Group", "country": "DE",
         "disambiguation": "German hard rock band"},
        {"id": TRANCE, "name": "Axxis", "score": 100, "type": "Group", "disambiguation": "trance duo"},
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
            artist = query["artist"][0]
            return release_groups_payload(artist, release_groups.get(artist, []),
                                          offset=int(query.get("offset", ["0"])[0])), OK
        answered = release_paths(url)
        if answered is not None:
            return answered
        mbid = parsed.path.rsplit("/", 1)[-1]
        return artists[mbid], OK

    client = MusicBrainzClient(base_url="https://mirror.test/ws/2/", user_agent="Test", get_json=get_json)
    return client, calls


def _context(*titles):
    return {"local_artist_id": 7, "local_name": "Axxis", "albums": albums(*titles)}


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
    # One search page, one release-group page per name-matching candidate, the
    # agreeing album's release and tracklist, then one lookup of the winner:
    # Axxis with two same-name candidates costs 6.
    client, calls = _client({GERMAN: ["Kingdom of the Night"], TRANCE: ["Dancefloor Mix"]})

    resolve_artist(_context("Kingdom of the Night"), client=client)

    assert len(calls) == 6
    assert sum("/artist/?" in url for url in calls) == 1
    assert sum("/release-group" in url for url in calls) == 2
    assert sum("/release?" in url or "/release/" in url for url in calls) == 2


def test_edition_suffixes_and_punctuation_do_not_hide_album_agreement():
    from music_app.services.musicbrainz_client import release_title_key

    assert release_title_key("Abbey Road (Remastered 2009)") == release_title_key("Abbey Road")
    assert release_title_key("Once [Deluxe Edition]") == release_title_key("Once")
    assert release_title_key("Sgt. Pepper's Lonely Hearts Club Band") == release_title_key(
        "Sgt Pepper’s Lonely Hearts Club Band".replace("’", "'")
    )
    assert release_title_key("Реки времён") == release_title_key("реки времён")
    client, _calls = _client({GERMAN: ["Kingdom of the Night"], TRANCE: ["Dancefloor Mix"]})

    outcome = resolve_artist(_context("Kingdom of the Night (Remastered)"), client=client)

    assert outcome["classification"] == "found"
    assert outcome["artist"]["mbid"] == GERMAN


AINA_INDIE = "3db93384-68e2-4d74-b26d-b36859704625"
AINA_OPERA = "70794157-c217-4847-b33a-6accafbe953e"
_AINA_ARTISTS = {
    AINA_INDIE: {"id": AINA_INDIE, "name": "Aina", "type": "Group", "country": "ES", "disambiguation": "Spanish indie band"},
    AINA_OPERA: {"id": AINA_OPERA, "name": "Aina", "type": "Group", "disambiguation": "metal opera"},
}
_AINA_RELEASE_GROUPS = {
    AINA_INDIE: ["Sevens", "Aina", "Bipartite", "Peel Session EP", "Chrysanthemum"],
    AINA_OPERA: ["Days of Rising Doom: The Metal Opera"],
}


def _aina_context(hint):
    return {"local_artist_id": 26, "local_name": "Aina",
            "albums": albums("Days Of Rising Doom - The Metal Opera"), "hinted_artist_mbids": [hint]}


def test_aina_stored_last_fm_mbid_never_beats_the_album_evidence():
    """Owner review: Aina was matched to the Spanish indie band through its stored Last.fm MBID."""
    client, _calls = _client(_AINA_RELEASE_GROUPS, artists=_AINA_ARTISTS, search=[
        {"id": AINA_INDIE, "name": "Aina", "score": 100}, {"id": AINA_OPERA, "name": "Aina", "score": 100},
    ])

    outcome = resolve_artist(_aina_context(AINA_INDIE), client=client)

    assert outcome["classification"] == "found"
    assert outcome["artist"]["mbid"] == AINA_OPERA
    assert outcome["evidence_summary"] == "MusicBrainz search evidence agreed."


def test_a_stored_mbid_without_album_agreement_is_never_accepted_on_its_own():
    client, _calls = _client(_AINA_RELEASE_GROUPS, artists=_AINA_ARTISTS, search=[])

    outcome = resolve_artist(_aina_context(AINA_INDIE), client=client)

    assert outcome["classification"] == "unconfirmed"
    assert [candidate["artist_mbid"] for candidate in outcome["candidates"]] == [AINA_INDIE]


def test_a_stored_mbid_still_finds_an_artist_search_misses_when_the_albums_agree():
    client, _calls = _client(_AINA_RELEASE_GROUPS, artists=_AINA_ARTISTS, search=[])

    outcome = resolve_artist(_aina_context(AINA_OPERA), client=client)

    assert outcome["classification"] == "found"
    assert outcome["artist"]["mbid"] == AINA_OPERA


def test_a_stale_stored_mbid_is_ignored_rather_than_failing_the_lookup():
    stale = "00000000-0000-4000-8000-0000000000ff"

    def get_json(url, _user_agent, **_kwargs):
        parsed = urlparse(url)
        if parsed.path.endswith("/artist/"):
            return {"count": 1, "artists": [{"id": AINA_OPERA, "name": "Aina", "score": 100}]}, OK
        if parsed.path.endswith("/release-group"):
            return release_groups_payload(AINA_OPERA, ["Days of Rising Doom: The Metal Opera"]), OK
        if release_paths(url) is not None:
            return release_paths(url)
        mbid = parsed.path.rsplit("/", 1)[-1]
        if mbid == stale:
            return None, {"status": "network", "http_status": 404, "cache_hit": False}
        return _AINA_ARTISTS[mbid], OK

    client = MusicBrainzClient(base_url="https://mirror.test/ws/2/", user_agent="Test", get_json=get_json)

    outcome = resolve_artist(_aina_context(stale), client=client)

    assert outcome["classification"] == "found"
    assert outcome["artist"]["mbid"] == AINA_OPERA


def test_a_spent_request_budget_never_accepts_before_every_candidate_is_scored(monkeypatch):
    from music_app.services import musicbrainz_enrichment

    # Room for the search and the first candidate only; the second is never scored.
    monkeypatch.setattr(musicbrainz_enrichment, "_MAX_REQUESTS_PER_ARTIST", 4)
    client, _calls = _client({GERMAN: ["Kingdom of the Night"], TRANCE: ["Kingdom of the Night"]})

    outcome = resolve_artist(_context("Kingdom of the Night"), client=client)

    assert outcome["classification"] == "ambiguous"
    assert {candidate["artist_mbid"] for candidate in outcome["candidates"]} == {GERMAN, TRANCE}
