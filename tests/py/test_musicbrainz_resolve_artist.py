from __future__ import annotations

from urllib.parse import parse_qs, urlparse

from music_app.services.musicbrainz_client import MusicBrainzClient
from music_app.services.musicbrainz_enrichment import resolve_artist
from tests.py.musicbrainz_test_mirror import OK, albums, group_id, release_groups_payload, release_paths


GERMAN = "00000000-0000-4000-8000-000000000011"
TRANCE = "00000000-0000-4000-8000-000000000012"
OTHER = "00000000-0000-4000-8000-000000000013"


def _client(release_groups, *, artists=None, search=None, fail_browse=False, releases=None, discs=None,
            lookups=None):
    calls: list[str] = []
    artists = artists or {
        GERMAN: {"id": GERMAN, "name": "Axxis", "type": "Group", "country": "DE",
                 "disambiguation": "German hard rock band"},
        TRANCE: {"id": TRANCE, "name": "Axxis", "type": "Group", "disambiguation": "trance duo"},
        OTHER: {"id": OTHER, "name": "Axis Mundi", "type": "Group"},
    }
    # Search results carry the display facts, as on the mirror.
    search = search if search is not None else [
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
        answered = release_paths(url, releases=releases, discs=discs, lookups=lookups)
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

    # Room for the search only: no candidate is ever scored, which is not "not found".
    monkeypatch.setattr(musicbrainz_enrichment, "_MAX_REQUESTS_PER_ARTIST", 4)
    client, _calls = _client({GERMAN: ["Kingdom of the Night"], TRANCE: ["Kingdom of the Night"]})

    outcome = resolve_artist(_context("Kingdom of the Night"), client=client)

    assert outcome["classification"] == "ambiguous"
    assert {candidate["artist_mbid"] for candidate in outcome["candidates"]} == {GERMAN, TRANCE}


CELESTE = [f"00000000-0000-4000-8000-0000000001{index:02d}" for index in range(6)]


def _release(artist_mbid, artist_name, title, *, credit=None, release_mbid="00000000-0000-4000-8000-00000000a001"):
    return {"id": release_mbid, "title": title, "date": "2000", "track-count": 2,
            "release-group": {"id": group_id(artist_mbid, title), "title": title},
            "artist-credit": [{"name": credit or artist_name, "artist": {"id": artist_mbid, "name": artist_name}}]}


def test_a_crowded_name_searches_the_albums_before_scoring_its_namesakes():
    """Celeste, Karma, Zodiac: six same-named artists spent the budget before the album search."""
    right = CELESTE[-1]
    artists = {mbid: {"id": mbid, "name": "Celeste"} for mbid in CELESTE}
    client, calls = _client({right: ["Pleine Lune"]}, artists=artists,
                            search=[{"id": mbid, "name": "Celeste", "score": 100} for mbid in CELESTE],
                            releases={"Pleine Lune": [_release(right, "Celeste", "Pleine Lune")]})

    outcome = resolve_artist({"local_artist_id": 9, "local_name": "Celeste", "albums": albums("Pleine Lune")},
                             client=client)

    assert outcome["classification"] == "found"
    assert outcome["artist"]["mbid"] == right
    first_album_search = next(index for index, url in enumerate(calls) if "/release/?" in url)
    first_browse = next(index for index, url in enumerate(calls) if "/release-group?" in url)
    assert first_album_search < first_browse, "the album search runs before any namesake is scored"
    assert sum("/release-group?" in url for url in calls) == 1, "the credited artist decides; no namesake is browsed"


def test_namesakes_left_unscored_never_block_an_album_proven_winner(monkeypatch):
    """Shamaani Duo: one proven candidate stayed Multiple because namesakes went unscored."""
    from music_app.services import musicbrainz_enrichment

    monkeypatch.setattr(musicbrainz_enrichment, "_MAX_NAME_ONLY_CANDIDATES", 1)
    client, _calls = _client({GERMAN: ["Kingdom of the Night"], TRANCE: ["Dancefloor Mix"]})

    outcome = resolve_artist(_context("Kingdom of the Night"), client=client)

    assert outcome["classification"] == "found"
    assert outcome["artist"]["mbid"] == GERMAN


def test_a_credited_release_counts_even_when_browsing_stopped_before_its_group():
    """Tower of Power: the credited release's group was not on the browsed pages."""
    client, _calls = _client({GERMAN: []}, search=[],
                             releases={"Kingdom of the Night": [_release(GERMAN, "Axxis", "Kingdom of the Night")]})

    outcome = resolve_artist(_context("Kingdom of the Night"), client=client)

    assert outcome["classification"] == "found"
    assert outcome["artist"]["mbid"] == GERMAN


def test_a_matched_sibling_and_its_box_set_discs_settle_an_artist_without_release_groups():
    """Devin Townsend Project: three bonus discs of "Contain Us" beside the matched
    "The Devin Townsend Project"."""
    box_set = {"id": "00000000-0000-4000-8000-00000000b001", "title": "Contain Us", "date": "2000",
               "release-group": {"id": group_id(GERMAN, "Contain Us")},
               "media": [{"position": 1, "title": "Ki", "track-count": 13},
                         {"position": 5, "title": "Stuff That Was Almost Stuff", "track-count": 2},
                         {"position": 7, "title": "Dinosaurs", "format": '10" Vinyl', "track-count": 2}]}
    client, calls = _client({GERMAN: ["Contain Us", "Ki"]}, search=[], discs={GERMAN: [box_set]})
    context = {"local_artist_id": 8, "local_name": "Axxis Project",
               "albums": albums("Stuff That Was Almost Stuff", 'Contain Us 10"'),
               "sibling_matches": [{"mbid": GERMAN, "name": "The Axxis Project", "canonical_name": "Axxis"}]}

    outcome = resolve_artist(context, client=client)

    assert outcome["classification"] == "found"
    assert outcome["artist"]["mbid"] == GERMAN
    assert {item["disc_position"] for item in outcome["album_evidence"]} == {5, 7}
    assert sum("inc=media+release-groups" in url for url in calls) == 1


def test_a_sibling_whose_albums_belong_elsewhere_is_not_chosen_by_name():
    """Owner: "Alan Parsons Project" holds Alan Parsons' solo album, not the Project's."""
    client, _calls = _client({GERMAN: ["Other Album"], OTHER: ["The Secret"]}, search=[],
                             releases={"The Secret": [_release(OTHER, "Axis Mundi", "The Secret")]})
    context = {"local_artist_id": 5, "local_name": "Axis Mundi Project", "albums": albums("The Secret"),
               "sibling_matches": [{"mbid": GERMAN, "name": "The Axis Mundi Project", "canonical_name": "Axxis"}]}

    outcome = resolve_artist(context, client=client)

    assert outcome["classification"] == "found"
    assert outcome["artist"]["mbid"] == OTHER
    assert outcome["credit_name"] == "Axis Mundi Project"
    assert outcome["album_evidence"][0]["local_title"] == "The Secret"
    assert set(outcome["album_evidence"][0]["signals"]) == {"year", "track_count", "track_list", "durations"}


def test_a_last_fm_album_identifier_counts_only_when_its_title_agrees():
    release_mbid = "00000000-0000-4000-8000-00000000c001"
    lookup = {**_release(GERMAN, "Axxis", "Kingdom of the Night", release_mbid=release_mbid),
              "media": [{"track-count": 2}]}
    context = {"local_artist_id": 7, "local_name": "Axxis",
               "albums": [{**albums("Kingdom of the Night")[0], "lastfm_release_mbid": release_mbid}]}

    client, _calls = _client({GERMAN: ["Kingdom of the Night"]}, search=[], lookups={release_mbid: lookup})
    outcome = resolve_artist(context, client=client)
    assert outcome["classification"] == "found"
    assert outcome["artist"]["mbid"] == GERMAN

    elsewhere = {**lookup, "release-group": {"id": group_id(GERMAN, "Unrelated"), "title": "Unrelated"},
                 "title": "Unrelated"}
    client, _calls = _client({GERMAN: ["Kingdom of the Night"]}, search=[], lookups={release_mbid: elsewhere})
    assert resolve_artist(context, client=client)["classification"] == "not_found"


def test_last_fm_album_identifiers_never_spend_a_large_discography_s_budget():
    titles = [f"Album {index}" for index in range(20)]
    context = {"local_artist_id": 7, "local_name": "Axxis",
               "albums": [{**album, "lastfm_release_mbid": f"00000000-0000-4000-8000-{index:012d}"}
                          for index, album in enumerate(albums(*titles))]}
    client, calls = _client({GERMAN: titles}, search=[{"id": GERMAN, "name": "Axxis", "score": 100}])

    assert resolve_artist(context, client=client)["classification"] == "found"
    assert sum("inc=release-groups+artist-credits" in url for url in calls) == 6


def test_new_credit_evidence_scores_an_artist_again_with_its_discs():
    from music_app.services.musicbrainz_enrichment import _add_release_credits

    entry = {"mbid": GERMAN, "credits": {}, "releases": {}, "albums": [], "discs_checked": True}
    _add_release_credits(lambda candidate, origin: entry, 0,
                         {"credits": [{"name": "Axxis", "artist_mbid": GERMAN, "artist_name": "Axxis"}]})

    assert "albums" not in entry and "discs_checked" not in entry


def test_albums_left_uncompared_by_the_tracklist_cap_are_compared_before_a_split():
    """12 albums of one band and 6 of another, but only 8 of the 12 had their tracks
    compared: every album still gets its own certain identity, with no margin."""
    german = [f"German {index}" for index in range(12)]
    trance = [f"Trance {index}" for index in range(6)]
    client, _calls = _client({GERMAN: german, TRANCE: trance})
    context = {**_context(*german, *trance)}
    context["albums"] = [{**album, "id": index + 1} for index, album in enumerate(context["albums"])]

    outcome = resolve_artist(context, client=client)

    assert outcome["classification"] == "per_album"
    owners = [item["artist_mbid"] for item in outcome["album_identities"]]
    assert owners.count(GERMAN) == 12 and owners.count(TRANCE) == 6


def test_a_merged_mbid_is_the_same_candidate_as_its_current_artist():
    """Shamaani Duo: the stored Last.fm MBID was merged into Korpiklaani, which the
    name search also finds; the artist tied with itself and stayed a multiple match."""
    merged = "00000000-0000-4000-8000-0000000000aa"
    artists = {GERMAN: {"id": GERMAN, "name": "Axxis", "type": "Group"},
               merged: {"id": GERMAN, "name": "Axxis", "type": "Group"}}
    client, _calls = _client({GERMAN: ["Kingdom of the Night"]}, artists=artists,
                             search=[{"id": GERMAN, "name": "Axxis", "score": 100}])

    outcome = resolve_artist({**_context("Kingdom of the Night"), "hinted_artist_mbids": [merged]}, client=client)

    assert outcome["classification"] == "found"
    assert outcome["artist"]["mbid"] == GERMAN


def test_a_special_purpose_artist_is_never_a_candidate():
    various = "89ad4ac3-39f7-470e-963a-56509c546377"
    client, _calls = _client({various: ["Kingdom of the Night"]}, search=[],
                             releases={"Kingdom of the Night": [_release(various, "Various Artists",
                                                                         "Kingdom of the Night")]})

    assert resolve_artist(_context("Kingdom of the Night"), client=client)["classification"] == "not_found"


def test_a_bonus_disc_tagged_as_its_own_album_is_kept_as_disc_evidence():
    """65daysofstatic: "Bonus EP" is disc 2 of "Silent Running", tagged as a separate album."""
    release = {"id": "00000000-0000-4000-8000-00000000d001", "title": "Silent Running", "date": "2000",
               "release-group": {"id": group_id(GERMAN, "Silent Running")},
               "media": [{"position": 1, "title": "", "track-count": 2},
                         {"position": 2, "title": "", "track-count": 2}]}
    client, _calls = _client({GERMAN: ["Silent Running"], TRANCE: []}, discs={GERMAN: [release]})

    outcome = resolve_artist(_context("Silent Running", "Bonus EP"), client=client)

    assert outcome["classification"] == "found"
    assert outcome["artist"]["mbid"] == GERMAN
    assert "credit_name" not in outcome
    assert [(item["local_title"], item["disc_position"], item["release_mbid"]) for item in outcome["album_evidence"]] == [
        ("Bonus EP", 2, "00000000-0000-4000-8000-00000000d001")]


def test_albums_of_two_same_named_bands_split_the_artist_with_each_album_s_identity():
    """Amarok: each album takes the band whose release it certainly matches."""
    client, _calls = _client({GERMAN: ["Kingdom of the Night", "Axxis II"], TRANCE: ["Dancefloor Mix"]})
    context = {"local_artist_id": 7, "local_name": "Axxis",
               "albums": [{**album, "id": index + 1}
                          for index, album in enumerate(albums("Kingdom of the Night", "Axxis II", "Dancefloor Mix"))]}

    outcome = resolve_artist(context, client=client)

    assert outcome["classification"] == "per_album"
    assert {item["local_album_id"]: item["artist_mbid"] for item in outcome["album_identities"]} == {
        1: GERMAN, 2: GERMAN, 3: TRANCE}
    assert {artist["mbid"] for artist in outcome["artists"]} == {GERMAN, TRANCE}
    assert not any(item["tag_differs"] for item in outcome["album_identities"])


def test_a_certain_album_under_another_name_matches_and_is_marked_for_tag_correction():
    """Jay-Z's "The Grey Album" is Danger Mouse's: the artist takes Danger Mouse, display only."""
    client, _calls = _client({OTHER: ["The Grey Album"]}, search=[],
                             releases={"The Grey Album": [_release(OTHER, "Axis Mundi", "The Grey Album")]})
    context = {"local_artist_id": 9, "local_name": "Jay-Z", "albums": [{**albums("The Grey Album")[0], "id": 5}]}

    outcome = resolve_artist(context, client=client)

    assert outcome["classification"] == "found"
    assert outcome["artist"]["mbid"] == OTHER
    assert outcome["credit_name"] == "Jay-Z"
    assert outcome["album_identities"] == [{
        "local_album_id": 5, "local_title": "The Grey Album", "artist_mbid": OTHER,
        "release_group_mbid": group_id(OTHER, "The Grey Album"), "release_mbid": outcome["album_identities"][0]["release_mbid"],
        "disc_position": None, "signals": ["durations", "track_count", "track_list", "year"], "tag_differs": True}]


def test_a_person_and_the_same_named_band_they_belong_to_are_one_artist():
    """Owner 2026-11-09: Alice Cooper is a person; the 1969-74 albums credited to the group
    he is a member of are still his. One artist-level identity, the person; each album keeps
    its certain MBID, and the group is stored so those identities resolve."""
    person = {"id": GERMAN, "name": "Axxis", "type": "Person", "disambiguation": "the singer",
              "relations": [{"type": "member of band", "direction": "forward",
                             "artist": {"id": TRANCE, "name": "Axxis"}}]}
    artists = {GERMAN: person, TRANCE: {"id": TRANCE, "name": "Axxis", "type": "Group", "disambiguation": "the band"}}
    client, calls = _client({GERMAN: ["Kingdom of the Night", "Axxis II"], TRANCE: ["Dancefloor Mix"]}, artists=artists)
    context = {"local_artist_id": 7, "local_name": "Axxis",
               "albums": [{**album, "id": index + 1}
                          for index, album in enumerate(albums("Kingdom of the Night", "Axxis II", "Dancefloor Mix"))]}

    outcome = resolve_artist(context, client=client)

    assert outcome["classification"] == "found"
    assert outcome["artist"]["mbid"] == GERMAN
    assert {item["local_album_id"]: item["artist_mbid"] for item in outcome["album_identities"]} == {
        1: GERMAN, 2: GERMAN, 3: TRANCE}
    assert {artist["mbid"] for artist in outcome["artists"]} == {GERMAN, TRANCE}
    assert any("inc=artist-rels" in url for url in calls)


def test_another_release_never_replaces_an_album_with_weaker_evidence():
    """Waltari: a box set's title-only disc replaced the album's own agreeing release."""
    from music_app.services.musicbrainz_enrichment import _better_than

    agreeing = {"title": "exact", "level": "agree", "signals": {"year", "track_count", "tracks_differ"}}
    assert not _better_than({"title": "exact", "level": "title", "signals": set()}, agreeing)
    assert _better_than({"title": "exact", "level": "strong", "signals": {"year", "track_list"}}, agreeing)
    # A disc titled exactly beats a partial title at the same level ("Contain Us 10"").
    partial = {"title": "partial", "level": "strong", "signals": {"year", "track_count", "track_list"}}
    assert _better_than({"title": "exact", "level": "strong", "signals": {"year", "track_count"}}, partial)
    assert _better_than({"title": "exact", "level": "title", "signals": set()}, {"title": None, "level": None, "signals": set()})


def test_a_person_s_group_named_otherwise_stays_a_separate_artist():
    """Owner 2026-11-10: "Ольга Арефьева и Ковчег" is her group, a separate artist from her
    solo work, even when MusicBrainz lists her name as the group's alias."""
    person = {"id": GERMAN, "name": "Axxis", "type": "Person",
              "relations": [{"type": "member of band", "direction": "forward",
                             "artist": {"id": TRANCE, "name": "Axxis and the Ark"}}]}
    group = {"id": TRANCE, "name": "Axxis and the Ark", "type": "Group",
             "aliases": [{"name": "Axxis", "locale": None, "primary": False}]}
    search = [{"id": GERMAN, "name": "Axxis", "score": 100, "type": "Person"},
              {"id": TRANCE, "name": "Axxis and the Ark", "score": 90, "type": "Group",
               "aliases": [{"name": "Axxis"}]}]
    client, _calls = _client({GERMAN: ["Kingdom of the Night", "Axxis II"], TRANCE: ["Dancefloor Mix"]},
                             artists={GERMAN: person, TRANCE: group}, search=search)
    context = {"local_artist_id": 7, "local_name": "Axxis",
               "albums": [{**album, "id": index + 1}
                          for index, album in enumerate(albums("Kingdom of the Night", "Axxis II", "Dancefloor Mix"))]}

    outcome = resolve_artist(context, client=client)

    assert outcome["classification"] == "per_album"
    assert {item["local_album_id"]: item["artist_mbid"] for item in outcome["album_identities"]} == {
        1: GERMAN, 2: GERMAN, 3: TRANCE}
