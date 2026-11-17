"""Track order and matched edition (owner 2026-11-16): one test per rule, with negatives.

Owner case: Dream Evil, "The Book Of Heavy Metal": local track 11 "The Mirror" was paired by
position with the release's "Only for the Night". Hand-built in that shape: the same tracks
with two swapped, every duration distinct. Nothing calls MusicBrainz.
"""
from __future__ import annotations

from music_app.services.musicbrainz_release_identity import _complete
from music_app.services.musicbrainz_track_order import pair_tracks

GROUP = "7c5e1b8a-0d2f-4a7e-9b1c-000000000001"
CHOSEN = "7c5e1b8a-0d2f-4a7e-9b1c-0000000000a1"
EXACT = "7c5e1b8a-0d2f-4a7e-9b1c-0000000000a2"
OTHER = "7c5e1b8a-0d2f-4a7e-9b1c-0000000000a3"
TITLES = ["The Book of Heavy Metal", "Into the Fire", "Let Me Out", "Crusaders' Anthem", "No Way",
          "The Sledge", "M.O.D.", "Unbreakable Chain", "Tired", "Chasing the Dragon", "The Mirror",
          "Only for the Night"]
SECONDS = [262, 228, 251, 305, 219, 244, 237, 268, 276, 233, 290, 315]


def _local(order=range(12), titles=TITLES):
    return [{"title": titles[index], "duration_seconds": SECONDS[index], "disc_number": 1, "track_number": number}
            for number, index in enumerate(order, start=1)]


def _release(release_id, order=range(12), titles=TITLES):
    return {"id": release_id, "release_group_id": GROUP, "artist_credit": [], "media": [{
        "position": 1, "title": None, "track_count": 12,
        "tracks": [{"position": number, "title": titles[index], "length": SECONDS[index] * 1000, "artist_credit": []}
                   for number, index in enumerate(order, start=1)]}]}


# MusicBrainz lists "Only for the Night" before "The Mirror"; the local files the reverse.
SWAPPED = [*range(10), 11, 10]


# Pairing -------------------------------------------------------------------------------

def test_the_same_order_is_order_exact_with_no_pairing_to_store():
    assert pair_tracks(_local(), _release(CHOSEN)) == {"quality": "order_exact", "pairing": [], "aligned": 12}


def test_dream_evil_the_mirror_pairs_by_content_not_by_position():
    paired = pair_tracks(_local(), _release(CHOSEN, SWAPPED))
    assert paired["quality"] == "reordered"
    assert {(row["track_number"], row["release_position"]) for row in paired["pairing"]} >= {(11, 12), (12, 11)}
    assert all(row["disc_number"] == row["release_disc"] == 1 for row in paired["pairing"])
    assert len(paired["pairing"]) == 12


def test_duration_pairs_a_track_whose_title_differs_when_it_is_unambiguous():
    titles = TITLES[:10] + ["Track 11", "Only for the Night"]
    paired = pair_tracks(_local(titles=titles), _release(CHOSEN, SWAPPED))
    assert paired["quality"] == "reordered"
    assert {"disc_number": 1, "track_number": 11, "release_disc": 1, "release_position": 12} in paired["pairing"]


def test_near_equal_durations_without_a_title_match_are_ambiguous():
    seconds = SECONDS[:10] + [300, 301]
    local = [{**track, "title": f"Unknown {track['track_number']}", "duration_seconds": seconds[index]}
             if index >= 10 else track for index, track in enumerate(_local())]
    release = _release(CHOSEN)
    for index in (10, 11):
        release["media"][0]["tracks"][index]["length"] = seconds[21 - index] * 1000
    assert pair_tracks(local, release) == {"quality": "ambiguous", "pairing": [], "aligned": 10}


def test_a_title_mismatch_with_no_duration_within_tolerance_is_ambiguous_too():
    local = _local(titles=TITLES[:10] + ["Unknown", "Only for the Night"])
    local[10]["duration_seconds"] = 100
    assert pair_tracks(local, _release(CHOSEN))["quality"] == "ambiguous"


# Edition choice ------------------------------------------------------------------------

class _Mirror:
    """The resolver's budgeted mirror, replaying hand-built answers."""

    def __init__(self, editions, tracklists, remaining=100):
        self.remaining, self.calls = remaining, []
        self._editions, self._tracklists = editions, tracklists

    def call(self, method, *args, **_kwargs):
        if self.remaining <= 0:
            return None
        self.remaining -= 1
        self.calls.append((method, *args))
        if method == "lookup_release_group":
            return {"classification": "complete", "release_group": {"id": GROUP, "title": "The Book of Heavy Metal"}}
        if method == "release_group_editions":
            return {"classification": "complete", "releases": self._editions}
        if method == "lookup_release_tracklist":
            return {"classification": "complete", "release": self._tracklists[args[0]]}
        raise AssertionError(method)


def _decide(local, chosen, editions, tracklists, *, remaining=100):
    result = {"local_album_id": 1, "local_title": "The Book of Heavy Metal", "state": "release",
              "release_group_mbid": GROUP, "release_mbid": CHOSEN, "disc_position": None, "signals": [],
              "diagnostic": None}
    mirror = _Mirror(editions, tracklists, remaining)
    outcome = _complete([{"id": 1, "title": "The Book of Heavy Metal", "tracks": local}], [result], mirror,
                        {CHOSEN: chosen})
    return outcome["albums"][0], mirror.calls, outcome["releases"]


def _edition(release_id, count=12, date="2004"):
    return {"id": release_id, "track_count": count, "date": date}


def test_an_exact_order_edition_is_preferred_over_the_reordered_one_first_chosen():
    result, calls, releases = _decide(
        _local(), _release(CHOSEN, SWAPPED), [_edition(CHOSEN), _edition(OTHER, 15), _edition(EXACT)],
        {EXACT: _release(EXACT)})
    assert (result["release_mbid"], result["edition"]) == (
        EXACT, {"match_quality": "order_exact", "track_pairing": [], "track_order_differs": False})
    assert EXACT in releases
    # One browse and only the same-length certain candidate's tracklist.
    assert [call[0] for call in calls] == ["lookup_release_group", "release_group_editions", "lookup_release_tracklist"]


def test_without_an_exact_edition_the_closest_keeps_its_pairing_and_the_note():
    result, _calls, _releases = _decide(
        _local(), _release(CHOSEN, SWAPPED), [_edition(CHOSEN), _edition(OTHER)],
        {OTHER: _release(OTHER, [*range(8), 9, 8, 11, 10])})
    assert result["release_mbid"] == CHOSEN
    assert result["edition"]["match_quality"] == "reordered"
    assert result["edition"]["track_order_differs"] is True
    assert len(result["edition"]["track_pairing"]) == 12


def test_an_edition_whose_tracks_differ_is_never_chosen_for_its_order():
    other_titles = ["Something Else"] * 12
    result, _calls, _releases = _decide(
        _local(), _release(CHOSEN, SWAPPED), [_edition(CHOSEN), _edition(OTHER)],
        {OTHER: _release(OTHER, titles=other_titles)})
    assert result["release_mbid"] == CHOSEN


def test_an_order_exact_choice_costs_no_extra_request():
    _result, calls, _releases = _decide(_local(), _release(CHOSEN), [], {})
    assert [call[0] for call in calls] == ["lookup_release_group"]


def test_a_spent_budget_keeps_the_first_choice():
    result, _calls, _releases = _decide(_local(), _release(CHOSEN, SWAPPED), [_edition(EXACT)],
                                        {EXACT: _release(EXACT)}, remaining=1)
    assert (result["release_mbid"], result["edition"]["match_quality"]) == (CHOSEN, "reordered")


def test_an_ambiguous_album_stores_no_pairing_and_the_note():
    seconds = SECONDS[:10] + [300, 301]
    local = [{**track, "title": f"Unknown {track['track_number']}", "duration_seconds": seconds[index]}
             if index >= 10 else track for index, track in enumerate(_local())]
    chosen = _release(CHOSEN)
    for index in (10, 11):
        chosen["media"][0]["tracks"][index]["length"] = seconds[21 - index] * 1000
    result, _calls, _releases = _decide(local, chosen, [_edition(CHOSEN)], {})
    assert result["edition"] == {"match_quality": "ambiguous", "track_pairing": [], "track_order_differs": True}


def test_only_a_certain_release_stores_its_edition_track_order():
    from datetime import datetime, timezone

    from music_app.services.musicbrainz_release_identity_postgres import _album_row

    edition = {"match_quality": "reordered", "track_pairing": [{"disc_number": 1, "track_number": 11,
                                                                "release_disc": 1, "release_position": 12}],
               "track_order_differs": True}
    now = datetime(2026, 11, 16, tzinfo=timezone.utc)
    stored = _album_row({"state": "release", "edition": edition}, {}, now)
    assert (stored["match_quality"], stored["track_pairing"], stored["track_order_differs"]) == (
        "reordered", edition["track_pairing"], True)
    stored = _album_row({"state": "release_group", "edition": edition}, {}, now)
    assert (stored["match_quality"], stored["track_pairing"], stored["track_order_differs"]) == (None, [], False)


def test_the_edition_browse_counts_audio_tracks_only():
    from music_app.services.musicbrainz_client import MusicBrainzClient

    def get_json(url, _agent):
        assert "release-group=" in url and "inc=media" in url
        return {"releases": [{"id": EXACT, "date": "2004-05-03", "media": [
            {"format": "CD", "track-count": 12}, {"format": "DVD-Video", "track-count": 5}]}]}, {"status": "network"}

    client = MusicBrainzClient(base_url="http://127.0.0.1:5050/ws/2", user_agent="Test", get_json=get_json)
    assert client.release_group_editions(GROUP)["releases"] == [{"id": EXACT, "date": "2004-05-03", "track_count": 12}]
