"""A split name's undecided albums (owner, 2026-11-18): recordings first, then the folder they
share with one artist's decided albums; disagreements and ties stay undecided."""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

from music_app.services.musicbrainz_enrichment import resolve_artist
from music_app.services.musicbrainz_evidence import (
    album_folders,
    decide_by_folder,
    decide_by_recordings,
    recording_sample,
)
from tests.py.musicbrainz_test_mirror import OK, albums
from tests.py.test_musicbrainz_resolve_artist import GERMAN, TRANCE, _client

LIVE_TRACKS = [{"title": "Dawn Over the Northern Sea", "duration_seconds": 300},
               {"title": "Intro", "duration_seconds": 60},
               {"title": "The Long Way Home Tonight", "duration_seconds": 280},
               {"title": "Ashes in the Harbour", "duration_seconds": 250}]
RELEASE = "00000000-0000-4000-8000-0000000000e1"


def _recording(title, artist, releases=(RELEASE,)):
    return {"id": "00000000-0000-4000-8000-0000000000aa", "title": title,
            "artist-credit": [{"artist": {"id": artist}}], "releases": [{"id": release} for release in releases]}


def test_the_sample_skips_generic_and_short_titles_and_needs_two():
    assert recording_sample(LIVE_TRACKS) == [
        "Dawn Over the Northern Sea", "The Long Way Home Tonight", "Ashes in the Harbour"]
    assert recording_sample([{"title": "Intro"}, {"title": "Track 2"}, {"title": "Only One Real Song"}]) == []


def test_one_artist_holding_two_sampled_titles_takes_the_album():
    sample = ["Dawn Over the Northern Sea", "The Long Way Home Tonight", "Ashes in the Harbour"]
    results = {sample[0]: [{"title": sample[0], "artist_mbids": [GERMAN], "release_mbids": ["r1"]}],
               sample[1]: [{"title": sample[1], "artist_mbids": [GERMAN], "release_mbids": ["r2"]}],
               sample[2]: []}
    outcome = decide_by_recordings(sample, results, [GERMAN, TRANCE])
    assert outcome == {"outcome": "decided", "artist_mbid": GERMAN, "found": {GERMAN: 2, TRANCE: 0},
                       "method": "recordings", "release_mbid": None}


def test_both_holding_the_sample_is_a_tie_unless_one_release_holds_it():
    sample = ["Dawn Over the Northern Sea", "The Long Way Home Tonight"]
    both = {title: [{"title": title, "artist_mbids": [GERMAN], "release_mbids": [f"g-{title}"]},
                    {"title": title, "artist_mbids": [TRANCE], "release_mbids": [f"t-{title}"]}] for title in sample}
    assert decide_by_recordings(sample, both, [GERMAN, TRANCE])["outcome"] == "tie"
    shared = {title: [{"title": title, "artist_mbids": [GERMAN], "release_mbids": ["g-live"]},
                      {"title": title, "artist_mbids": [TRANCE], "release_mbids": [f"t-{title}"]}] for title in sample}
    outcome = decide_by_recordings(sample, shared, [GERMAN, TRANCE])
    assert (outcome["outcome"], outcome["artist_mbid"], outcome["method"], outcome["release_mbid"]) == (
        "decided", GERMAN, "release", "g-live")


def test_under_two_is_weak_evidence_and_nothing_is_none():
    sample = ["Dawn Over the Northern Sea", "The Long Way Home Tonight"]
    one = {sample[0]: [{"title": sample[0], "artist_mbids": [TRANCE], "release_mbids": []}], sample[1]: []}
    assert decide_by_recordings(sample, one, [GERMAN, TRANCE])["outcome"] == "weak"
    assert decide_by_recordings(sample, {title: [] for title in sample}, [GERMAN, TRANCE])["outcome"] == "none"


def test_the_artist_folder_is_the_album_folder_s_parent_and_a_disc_folder_is_part_of_the_album():
    assert album_folders(["3:Amarok PL/Live 2004/CD1", "3:Amarok PL/Live 2004/CD2"]) == (
        "3:Amarok PL/Live 2004", "3:Amarok PL")
    assert album_folders(["3:Amarok PL/Live"]) == ("3:Amarok PL/Live", "3:Amarok PL")
    assert album_folders(["3:Live"]) is None, "an album directly under the root has no artist folder"
    assert album_folders(["3:A/Live", "4:A/Live"]) is None, "files across roots decide nothing"


def test_a_general_folder_decides_nothing():
    decided = {GERMAN: {"3:amarok pl"}, TRANCE: {"3:amarok es"}}
    assert decide_by_folder("3:amarok pl", decided) == GERMAN
    assert decide_by_folder("3:music", {GERMAN: {"3:music"}, TRANCE: {"3:music"}}) is None
    assert decide_by_folder("3:elsewhere", decided) is None


def _split_context(undecided_tracks, undecided_folders, *, manual=None):
    """One certain album per band, each band in its own folder, plus one undecided album."""
    certain = albums("Kingdom of the Night", "Dancefloor Mix")
    folders = [["3:Axxis DE/Kingdom of the Night"], ["3:Axxis Trance/Dancefloor Mix"]]
    rows = [{**album, "id": index + 1, "folders": folders[index]} for index, album in enumerate(certain)]
    rows.append({"id": 3, "title": "Bootleg Live", "year": 2026, "tracks": undecided_tracks,
                 "folders": undecided_folders, **({"identity": manual} if manual else {})})
    return {"local_artist_id": 7, "local_name": "Axxis", "albums": rows}


def _resolve(context, recordings_by_title):
    client, _calls = _client({GERMAN: ["Kingdom of the Night"], TRANCE: ["Dancefloor Mix"]})
    answer = client.get_json
    searched = []

    def get_json(url, user_agent, **kwargs):
        parsed = urlparse(url)
        if parsed.path.endswith("/recording/"):
            title = parse_qs(parsed.query)["query"][0].split('"')[1]
            searched.append(title)
            return {"recordings": recordings_by_title.get(title, [])}, OK
        return answer(url, user_agent, **kwargs)

    client.get_json = get_json
    outcome = resolve_artist(context, client=client)
    assert outcome["classification"] == "per_album"
    return {item["local_album_id"]: item for item in outcome["album_identities"]}, searched


def test_an_undecided_album_goes_to_the_band_its_recordings_lead_to():
    by_album, searched = _resolve(_split_context(LIVE_TRACKS, ["3:Axxis Trance/Bootleg Live"]), {
        "Dawn Over the Northern Sea": [_recording("Dawn Over the Northern Sea", GERMAN)],
        "The Long Way Home Tonight": [_recording("The Long Way Home Tonight", GERMAN)]})
    assert by_album[3]["artist_mbid"] == GERMAN, "recordings outrank the folder"
    assert by_album[3]["method"] == "release", "both recordings are on one release"
    assert by_album[3]["sampled_titles"] == [
        "Dawn Over the Northern Sea", "The Long Way Home Tonight", "Ashes in the Harbour"]
    assert len(searched) == 3, "three searches, one per sampled title"


def test_without_recordings_evidence_the_folder_decides():
    by_album, _searched = _resolve(_split_context(LIVE_TRACKS, ["3:Axxis Trance/Bootleg Live"]), {})
    assert by_album[3]["artist_mbid"] == TRANCE
    assert by_album[3]["method"] == "folder"
    assert by_album[3]["folder"] == "Axxis Trance", "relative to the library root, never absolute"


def test_recordings_and_folder_that_disagree_leave_the_album_undecided():
    # One title under the German band (weak evidence), but the folder is the trance duo's.
    by_album, _searched = _resolve(_split_context(LIVE_TRACKS, ["3:Axxis Trance/Bootleg Live"]), {
        "Dawn Over the Northern Sea": [_recording("Dawn Over the Northern Sea", GERMAN)]})
    assert 3 not in by_album


def test_weak_recordings_that_agree_with_the_folder_decide():
    by_album, _searched = _resolve(_split_context(LIVE_TRACKS, ["3:Axxis Trance/Bootleg Live"]), {
        "Dawn Over the Northern Sea": [_recording("Dawn Over the Northern Sea", TRANCE)]})
    assert (by_album[3]["artist_mbid"], by_album[3]["method"]) == (TRANCE, "folder")


def test_a_tie_on_recordings_never_falls_back_to_the_folder():
    both = {title: [_recording(title, GERMAN, (f"00000000-0000-4000-8000-00000000000{index}",)),
                    _recording(title, TRANCE, (f"00000000-0000-4000-8000-00000000001{index}",))]
            for index, title in enumerate(("Dawn Over the Northern Sea", "The Long Way Home Tonight"))}
    by_album, _searched = _resolve(_split_context(LIVE_TRACKS, ["3:Axxis Trance/Bootleg Live"]), both)
    assert 3 not in by_album


def test_an_album_in_a_general_folder_stays_undecided():
    context = _split_context(LIVE_TRACKS, ["3:Music/Bootleg Live"])
    context["albums"][0]["folders"] = ["3:Music/Kingdom of the Night"]
    context["albums"][1]["folders"] = ["3:Music/Dancefloor Mix"]
    by_album, _searched = _resolve(context, {})
    assert 3 not in by_album


def test_an_owner_s_choice_is_kept_and_never_looked_up():
    context = _split_context(LIVE_TRACKS, ["3:Axxis Trance/Bootleg Live"],
                             manual={"mbid": GERMAN, "source": "manual"})
    by_album, searched = _resolve(context, {
        "Dawn Over the Northern Sea": [_recording("Dawn Over the Northern Sea", TRANCE)],
        "The Long Way Home Tonight": [_recording("The Long Way Home Tonight", TRANCE)]})
    assert 3 not in by_album and searched == []


def test_titles_split_between_two_artists_are_a_mixed_album():
    """Owner 2026-11-21 (Millenium): two sampled titles under one artist and one under the other
    mean the local album holds two releases, so it stays undecided."""
    sample = ["Dawn Over the Northern Sea", "The Long Way Home Tonight", "Ashes in the Harbour"]
    results = {sample[0]: [{"title": sample[0], "artist_mbids": [GERMAN], "release_mbids": ["g"]}],
               sample[1]: [{"title": sample[1], "artist_mbids": [GERMAN], "release_mbids": ["g"]}],
               sample[2]: [{"title": sample[2], "artist_mbids": [TRANCE], "release_mbids": ["t"]}]}
    assert decide_by_recordings(sample, results, [GERMAN, TRANCE]) == {
        "outcome": "mixed", "found": {GERMAN: 2, TRANCE: 1}}
    # The same song under both (a band and its singer) is not a mix: the old rules decide.
    shared = {**results, sample[2]: [{"title": sample[2], "artist_mbids": [GERMAN, TRANCE], "release_mbids": ["g"]}]}
    assert decide_by_recordings(sample, shared, [GERMAN, TRANCE])["outcome"] == "decided"


def test_a_mixed_album_never_falls_back_to_the_folder():
    by_album, _searched = _resolve(_split_context(LIVE_TRACKS, ["3:Axxis Trance/Bootleg Live"]), {
        "Dawn Over the Northern Sea": [_recording("Dawn Over the Northern Sea", GERMAN)],
        "The Long Way Home Tonight": [_recording("The Long Way Home Tonight", GERMAN)],
        "Ashes in the Harbour": [_recording("Ashes in the Harbour", TRANCE)]})
    assert 3 not in by_album, "neither the recordings' leader nor the folder's artist takes it"
