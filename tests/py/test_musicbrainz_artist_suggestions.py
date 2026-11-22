"""What "MusicBrainz: artist undecided" proposes (owner, 2026-11-19; row approved 2026-11-21):
the evidence of a split name's undecided album is kept as a suggestion, which never decides."""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from music_app.services.musicbrainz_enrichment import resolve_artist
from tests.py.musicbrainz_test_mirror import OK
from tests.py.test_musicbrainz_resolve_artist import GERMAN, TRANCE, _client
from tests.py.test_musicbrainz_split_undecided_albums import LIVE_TRACKS, _recording, _split_context

THIRD = "00000000-0000-4000-8000-0000000003bd"
DAWN, HOME, ASHES = "Dawn Over the Northern Sea", "The Long Way Home Tonight", "Ashes in the Harbour"
IN_GENERAL_FOLDER = ["3:Music/Bootleg Live"]
IN_TRANCE_FOLDER = ["3:Axxis Trance/Bootleg Live"]


def _resolve(recordings, folders=IN_GENERAL_FOLDER, *, manual=None, search_fails=False,
             namesakes=(), namesake_search_fails=False, searches=None):
    search = [{"id": GERMAN, "name": "Axxis", "score": 100, "type": "Group", "country": "DE"},
              {"id": TRANCE, "name": "Axxis", "score": 100, "type": "Group", "disambiguation": "trance duo"},
              *({"id": mbid, "name": "Axxis", "score": 90, "disambiguation": "Polish band"} for mbid in namesakes)]
    client, _calls = _client({GERMAN: ["Kingdom of the Night"], TRANCE: ["Dancefloor Mix"]}, search=search)
    answer = client.get_json

    def get_json(url, user_agent, **kwargs):
        parsed = urlparse(url)
        if parsed.path.endswith("/recording/"):
            if search_fails:
                return None, {"status_code": 503, "failure_kind": "http"}
            query = parse_qs(parsed.query)["query"][0]
            if searches is not None:
                searches.append(query)
            if namesake_search_fails and f"arid:{GERMAN}" not in query:
                return None, {"status_code": 503, "failure_kind": "http"}
            # As on the mirror, only recordings of the artists the query names.
            found = [recording for recording in recordings.get(query.split('"')[1], [])
                     if f"arid:{recording['artist-credit'][0]['artist']['id']}" in query]
            return {"recordings": found}, OK
        return answer(url, user_agent, **kwargs)

    client.get_json = get_json
    return resolve_artist(_split_context(LIVE_TRACKS, folders, manual=manual), client=client)


def _suggestion(outcome):
    (suggestion,) = outcome["album_suggestions"]
    assert suggestion["local_album_id"] == 3
    return suggestion, {item["artist_mbid"]: item for item in suggestion["artists"]}


def _undecided(outcome):
    return 3 not in {item["local_album_id"] for item in outcome["album_identities"]}


def test_recordings_that_favour_one_artist_are_suggested_and_decide_nothing():
    outcome = _resolve({DAWN: [_recording(DAWN, GERMAN)]})

    suggestion, artists = _suggestion(outcome)
    assert suggestion["favoured_mbid"] == GERMAN
    assert (artists[GERMAN]["found"], artists[GERMAN]["sampled"]) == (1, 3)
    assert (artists[TRANCE]["found"], artists[TRANCE]["sampled"]) == (0, 3), "every artist of the name is a row"
    assert _undecided(outcome), "a suggestion never decides"


def test_a_mixed_album_suggests_the_artist_with_more_of_its_songs():
    outcome = _resolve({DAWN: [_recording(DAWN, GERMAN)], HOME: [_recording(HOME, GERMAN)],
                        ASHES: [_recording(ASHES, TRANCE)]})

    suggestion, artists = _suggestion(outcome)
    assert suggestion["favoured_mbid"] == GERMAN
    assert (artists[GERMAN]["found"], artists[TRANCE]["found"]) == (2, 1)
    assert _undecided(outcome), "the interim mixed-album guard stands"


def test_evidence_that_favours_neither_artist_suggests_no_one():
    both = {title: [_recording(title, GERMAN, (f"00000000-0000-4000-8000-00000000000{index}",)),
                    _recording(title, TRANCE, (f"00000000-0000-4000-8000-00000000001{index}",))]
            for index, title in enumerate((DAWN, HOME))}
    outcome = _resolve(both)

    suggestion, artists = _suggestion(outcome)
    assert suggestion["favoured_mbid"] is None
    assert artists[GERMAN]["found"] == artists[TRANCE]["found"] == 2
    assert _undecided(outcome)


def test_recordings_that_disagree_with_the_folder_lead_and_the_folder_is_named_by_its_album():
    outcome = _resolve({DAWN: [_recording(DAWN, GERMAN)]}, IN_TRANCE_FOLDER)

    suggestion, artists = _suggestion(outcome)
    assert suggestion["favoured_mbid"] == GERMAN
    assert artists[TRANCE]["folder_album"] == "Dancefloor Mix", "an album title, never a path"
    assert artists[GERMAN]["folder_album"] is None
    assert _undecided(outcome)


@pytest.mark.parametrize("recordings, folders", [
    ({}, IN_GENERAL_FOLDER),
    ({}, IN_TRANCE_FOLDER),
    ({DAWN: [_recording(DAWN, GERMAN)], HOME: [_recording(HOME, GERMAN)]}, IN_GENERAL_FOLDER),
], ids=["no evidence", "folder decided", "recordings decided"])
def test_no_evidence_and_decided_albums_have_no_suggestion(recordings, folders):
    outcome = _resolve(recordings, folders)
    assert outcome["album_suggestions"] == []
    assert outcome["album_suggestions_unchecked"] == []


def test_a_manual_choice_has_no_suggestion():
    outcome = _resolve({DAWN: [_recording(DAWN, TRANCE)]}, manual={"mbid": GERMAN, "source": "manual"})
    assert outcome["album_suggestions"] == []
    assert _undecided(outcome)


def test_an_album_the_mirror_could_not_check_is_reported_so_its_stored_suggestion_is_kept():
    outcome = _resolve({}, search_fails=True)
    assert outcome["album_suggestions"] == []
    assert outcome["album_suggestions_unchecked"] == [3]


def test_a_third_band_of_the_name_is_suggested_and_assigned_nothing():
    outcome = _resolve({DAWN: [_recording(DAWN, THIRD)], HOME: [_recording(HOME, THIRD)]}, namesakes=[THIRD])

    suggestion, artists = _suggestion(outcome)
    assert suggestion["favoured_mbid"] == THIRD
    assert (artists[THIRD]["found"], artists[THIRD]["sampled"]) == (2, 3)
    assert {GERMAN, TRANCE} <= set(artists), "the split's own artists stay rows"
    assert _undecided(outcome), "only the split's own artists are ever chosen automatically"
    assert THIRD not in {item["artist_mbid"] for item in outcome["album_identities"]}
    assert THIRD not in {artist["mbid"] for artist in outcome["artists"]}, "the band joins no split"
    (band,) = outcome["suggested_artists"]
    assert (band["mbid"], band["canonical_name"], band["disambiguation"]) == (THIRD, "Axxis", "Polish band")


def test_a_third_band_without_the_albums_songs_is_not_a_row():
    outcome = _resolve({DAWN: [_recording(DAWN, GERMAN)]}, namesakes=[THIRD])

    _suggested, artists = _suggestion(outcome)
    assert set(artists) == {GERMAN, TRANCE}
    assert outcome["suggested_artists"] == []


def test_a_third_band_and_the_split_with_equal_evidence_suggest_no_one():
    outcome = _resolve({DAWN: [_recording(DAWN, GERMAN), _recording(DAWN, THIRD)]}, namesakes=[THIRD])

    suggestion, artists = _suggestion(outcome)
    assert suggestion["favoured_mbid"] is None
    assert artists[GERMAN]["found"] == artists[THIRD]["found"] == 1


def test_recordings_of_a_third_band_overrule_the_folder_and_leave_the_album_undecided():
    outcome = _resolve({DAWN: [_recording(DAWN, THIRD)]}, IN_TRANCE_FOLDER, namesakes=[THIRD])

    suggestion, _artists = _suggestion(outcome)
    assert suggestion["favoured_mbid"] == THIRD
    assert _undecided(outcome)


def test_the_folder_still_decides_when_no_namesake_has_the_songs():
    assert not _undecided(_resolve({}, IN_TRANCE_FOLDER, namesakes=[THIRD]))


def test_an_album_the_split_decides_costs_no_namesake_search():
    searches = []
    outcome = _resolve({DAWN: [_recording(DAWN, GERMAN)], HOME: [_recording(HOME, GERMAN)]},
                       namesakes=[THIRD], searches=searches)

    assert not _undecided(outcome)
    assert len(searches) == 3 and not any(THIRD in query for query in searches)


def test_the_namesake_search_is_bounded_however_common_the_name():
    namesakes = [f"00000000-0000-4000-8000-{index:012d}" for index in range(400, 430)]
    searches = []

    _resolve({DAWN: [_recording(DAWN, GERMAN)]}, namesakes=namesakes, searches=searches)

    assert len(searches) == 6, "one more search per sampled title"
    assert all(query.count("arid:") <= 5 for query in searches)


def test_a_failed_namesake_search_keeps_the_stored_suggestion():
    outcome = _resolve({DAWN: [_recording(DAWN, GERMAN)]}, namesakes=[THIRD], namesake_search_fails=True)

    assert outcome["album_suggestions"] == []
    assert outcome["album_suggestions_unchecked"] == [3]


def test_a_failed_namesake_search_takes_no_folder_decision_away():
    outcome = _resolve({}, IN_TRANCE_FOLDER, namesakes=[THIRD], namesake_search_fails=True)

    assert not _undecided(outcome)
    assert outcome["album_suggestions_unchecked"] == []
