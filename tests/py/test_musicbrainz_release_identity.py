"""Delivery 2 release identity: one test per rule, each with its negative case.

Main-album end (owner 2026-11-08), display track artists for unreadable tags (天門 "She and
Her Cat"), release decisions on matcher-5 evidence and the resulting type. The resolver is
replayed against a fake mirror built from the shared test-mirror helpers.
"""
from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from music_app.services.musicbrainz_client import MusicBrainzClient
from music_app.services.musicbrainz_release_identity import (
    display_track_artists,
    local_discs,
    main_disc_count,
    resolve_album_releases,
)
from tests.py.musicbrainz_test_mirror import OK, group_id, release_groups_payload

ARTIST = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3"


def _tracks(prefix: str, count: int, *, seconds: int = 200) -> list[dict[str, object]]:
    return [{"title": f"{prefix} {number}", "duration_seconds": seconds} for number in range(1, count + 1)]


def _medium(tracks: list[dict[str, object]], *, title: str | None = None, position: int = 1) -> dict[str, object]:
    return {"position": position, "title": title, "track_count": len(tracks),
            "tracks": [{"position": index, "title": track["title"], "length": track["duration_seconds"] * 1000}
                       for index, track in enumerate(tracks, start=1)]}


DISC_1, DISC_2, DISC_3 = _tracks("Main", 9), _tracks("Second", 8), _tracks("Extra", 6)


# Main-album end -------------------------------------------------------------------------

def test_an_unnamed_bonus_disc_becomes_bonus_from_the_original_release():
    original = {"media": [_medium(DISC_1)]}
    deluxe = {"media": [_medium(DISC_1), _medium(DISC_2, position=2)]}
    assert main_disc_count([DISC_1, DISC_2], original=original, matched=deluxe) == {
        "main_disc_count": 1, "source": "original_release"}


def test_a_named_bonus_disc_the_original_album_contains_stays_main():
    original = {"media": [_medium(DISC_1), _medium(DISC_2, title="Bonus", position=2)]}
    assert main_disc_count([DISC_1, DISC_2], original=original, matched=original) == {
        "main_disc_count": 2, "source": "original_release"}


def test_a_two_disc_original_plus_a_third_bonus_disc():
    original = {"media": [_medium(DISC_1), _medium(DISC_2, position=2)]}
    assert main_disc_count([DISC_1, DISC_2, DISC_3], original=original, matched=None)["main_disc_count"] == 2


def test_a_single_disc_is_the_main_album():
    assert main_disc_count([DISC_1], original=None, matched=None) == {"main_disc_count": 1, "source": "single_disc"}


def test_no_match_keeps_the_local_guess():
    assert main_disc_count([DISC_1, DISC_2], original=None, matched=None) is None


def test_an_ambiguous_match_keeps_the_local_guess():
    # The original's single disc is another arrangement: its tracks agree with no local disc.
    original = {"media": [_medium(_tracks("Other", 12))]}
    matched = {"media": [_medium(DISC_1), _medium(DISC_2, position=2)]}
    assert main_disc_count([DISC_1, DISC_2], original=original, matched=matched) is None


def test_medium_titles_on_the_matched_release_decide_without_an_original():
    matched = {"media": [_medium(DISC_1), _medium(DISC_2, position=2, title="Bonus Disc")]}
    assert main_disc_count([DISC_1, DISC_2], original=None, matched=matched) == {
        "main_disc_count": 1, "source": "medium_titles"}


def test_a_bonus_title_before_a_main_disc_is_no_answer():
    matched = {"media": [_medium(DISC_1, title="Bonus"), _medium(DISC_2, position=2)]}
    assert main_disc_count([DISC_1, DISC_2], original=None, matched=matched) is None


def test_local_discs_group_by_disc_number_in_track_order():
    tracks = [{"title": "b", "disc_number": 2, "track_number": 1}, {"title": "a2", "disc_number": 1, "track_number": 2},
              {"title": "a1", "disc_number": None, "track_number": 1}]
    assert [[track["title"] for track in disc] for disc in local_discs(tracks)] == [["a1", "a2"], ["b"]]


# Display track artists --------------------------------------------------------------------

TENMON = "c6f1bd77-2a0f-4f33-a4d6-b1c9c43b3a3e"
RELEASE = {"media": [{"position": 1, "tracks": [
    {"position": 1, "title": "Opening", "artist_credit": [
        {"name": "天門", "artist_mbid": TENMON, "artist_name": "天門", "join_phrase": ""}]},
    {"position": 2, "title": "Closing", "artist_credit": [
        {"name": "Alan Menken", "artist_mbid": ARTIST, "artist_name": "Alan Menken", "join_phrase": " & "},
        {"name": "Howard Ashman", "artist_mbid": TENMON, "artist_name": "Howard Ashman", "join_phrase": ""}]},
]}]}


def test_an_unreadable_track_artist_shows_the_matched_release_credit():
    shown = display_track_artists([{"title": "Opening", "artist": "??", "disc_number": 1, "track_number": 1},
                                   {"title": "Closing", "artist": "", "disc_number": 1, "track_number": 2}], RELEASE)
    assert [(item["track_number"], item["artist"]) for item in shown] == [
        (1, "天門"), (2, "Alan Menken & Howard Ashman")]


def test_a_readable_track_artist_or_another_title_is_never_replaced():
    assert display_track_artists([{"title": "Opening", "artist": "Someone", "disc_number": 1, "track_number": 1},
                                  {"title": "Not Closing", "artist": "??", "disc_number": 1, "track_number": 2}],
                                 RELEASE) == []


# Release decisions on album evidence ------------------------------------------------------

TRACKS = [("Opening", 200), ("Middle", 250), ("Closing", 300)]
RELEASE_ID = "8c290dbc-d78d-32a3-8067-ea418cbcc72d"


def _album(title: str, tracks=TRACKS, album_id: int = 1) -> dict[str, object]:
    return {"id": album_id, "title": title, "year": 2000,
            "tracks": [{"title": name, "duration_seconds": seconds, "disc_number": 1, "track_number": number,
                        "artist": "??" if number == 1 else "Artist"}
                       for number, (name, seconds) in enumerate(tracks, start=1)]}


def _client(*, remote_tracks=TRACKS, group_genres=(("power metal", 2),), titles=("Angels Cry",)):
    def get_json(url, _agent, **_kwargs):
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        if parsed.path.endswith("/release-group") and "artist" in query:
            return release_groups_payload(ARTIST, list(titles)), OK
        if parsed.path.endswith("/release") and "artist" in query:
            return {"release-count": 0, "releases": []}, OK
        if "/release-group/" in parsed.path:
            return {"id": parsed.path.rsplit("/", 1)[-1], "title": titles[0], "primary-type": "Album",
                    "secondary-types": ["Live"], "first-release-date": "2000",
                    "genres": [{"name": name, "count": count} for name, count in group_genres]}, OK
        if parsed.path.endswith("/release") and "release-group" in query:
            return {"releases": [{"id": RELEASE_ID, "date": "2000", "status": "Official",
                                  "media": [{"track-count": len(remote_tracks)}]}]}, OK
        if "/release/" in parsed.path:
            return {"id": RELEASE_ID, "title": titles[0], "date": "2000", "barcode": "731452340221",
                    "release-group": {"id": group_id(ARTIST, titles[0])},
                    "artist-credit": [{"name": "Angra", "joinphrase": "", "artist": {"id": ARTIST, "name": "Angra"}}],
                    "media": [{"position": 1, "track-count": len(remote_tracks), "tracks": [
                        {"position": number, "title": name, "length": seconds * 1000,
                         "artist-credit": [{"name": "Angra", "joinphrase": "", "artist": {"id": ARTIST, "name": "Angra"}}]}
                        for number, (name, seconds) in enumerate(remote_tracks, start=1)]}]}, OK
        raise AssertionError(f"unexpected request {url}")

    return MusicBrainzClient(base_url="http://127.0.0.1:5050/ws/2", user_agent="Test", get_json=get_json)


def _resolve(album, **client_options):
    return resolve_album_releases({"artist_mbid": ARTIST, "canonical_name": "Angra", "local_name": "Angra",
                                   "albums": [album]}, client=_client(**client_options))


def test_title_tracks_and_count_make_a_certain_release_with_its_group_data():
    outcome = _resolve(_album("Angels Cry"))
    [album] = outcome["albums"]
    assert album["state"] == "release" and album["release_mbid"] == RELEASE_ID
    assert album["release_group_mbid"] == group_id(ARTIST, "Angels Cry")
    group = outcome["release_groups"][album["release_group_mbid"]]
    assert (group["primary_type"], group["secondary_types"], group["genres"][0]["name"]) == (
        "Album", ["Live"], "power metal")
    assert outcome["releases"][RELEASE_ID]["barcode"] == "731452340221"
    assert album["track_artists"] == [{"disc_number": 1, "track_number": 1, "artist": "Angra",
                                       "artist_mbids": [ARTIST]}]
    assert album["main_disc"] == {"main_disc_count": 1, "source": "single_disc"}


def test_a_same_titled_release_with_other_tracks_stays_unresolved():
    outcome = _resolve(_album("Angels Cry"), remote_tracks=[("Else", 100), ("Other", 400), ("Third", 90)])
    [album] = outcome["albums"]
    assert (album["state"], album["diagnostic"], album["release_group_mbid"]) == ("unresolved", "tracks_differ", None)
    assert outcome["release_groups"] == {} and outcome["releases"] == {}


def test_an_album_no_release_is_titled_like_stays_unresolved_with_its_reason():
    outcome = _resolve(_album("Holy Land"))
    assert [(album["state"], album["diagnostic"]) for album in outcome["albums"]] == [("unresolved", "no_title_match")]


def test_a_spent_budget_is_retried_never_stored_as_absent(monkeypatch):
    from music_app.services import musicbrainz_release_identity as module
    monkeypatch.setattr(module, "_BASE_REQUESTS", 0)
    monkeypatch.setattr(module, "_REQUESTS_PER_ALBUM", 0)
    outcome = _resolve(_album("Angels Cry"))
    assert [album["diagnostic"] for album in outcome["albums"]] == ["budget_exhausted"]


def test_an_album_the_artist_matcher_left_without_tracks_still_gets_them_compared(monkeypatch):
    # Matcher 5 stops at "strong" (year and count) without fetching tracks; a release
    # needs them, so the release pass fetches them itself.
    from music_app.services import musicbrainz_release_identity as module
    monkeypatch.setattr(module, "_compare_tracks", lambda *args, **kwargs: None)
    [album] = _resolve(_album("Angels Cry"))["albums"]
    assert (album["state"], album["release_mbid"]) == ("release", RELEASE_ID)


def test_without_a_tracklist_to_compare_an_album_is_only_a_release_group():
    # MusicBrainz lists the release but not its tracks: the title and year agree, nothing
    # proves which release it is.
    [album] = _resolve(_album("Angels Cry"), remote_tracks=[])["albums"]
    assert (album["state"], album["release_mbid"], album["diagnostic"]) == ("release_group", None, None)


# Owner example (2026-11-05): 天門 "She and Her Cat", replayed from recorded mirror answers.
# MusicBrainz lists a data track first, the tags are cut at ID3v1's 30 characters and
# write "Main Theme" where MusicBrainz writes "MainTheme".

_FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "musicbrainz"
                        / "delivery-2-release-identity-mirror.json").read_text(encoding="utf-8"))


def _replay_client():
    def get_json(url, _agent, **_kwargs):
        parsed = urlparse(url)
        key = parsed.path.replace("/ws/2", "") + "?" + parsed.query
        assert key in _FIXTURE["responses"], f"unrecorded mirror request {key}"
        return _FIXTURE["responses"][key], OK

    return MusicBrainzClient(base_url="http://127.0.0.1:5050/ws/2", user_agent="Test", get_json=get_json)


def test_she_and_her_cat_is_its_mixed_mode_release_with_its_track_artists():
    [case] = _FIXTURE["cases"]
    outcome = resolve_album_releases(case["context"], client=_replay_client())
    [album] = outcome["albums"]
    assert (album["state"], album["release_mbid"]) == ("release", "dc94c5b7-640a-4344-a5b2-a7041f31034e")
    release = outcome["releases"][album["release_mbid"]]
    assert [track["title"] for track in release["media"][0]["tracks"]][:1] == ["MainTheme"]  # no data track
    assert [item["track_number"] for item in album["track_artists"]] == [1, 2, 3, 4, 5]
    assert {item["artist"] for item in album["track_artists"]} == {"天門"}


def test_spacing_differences_in_track_titles_agree_and_other_words_do_not():
    from music_app.services.musicbrainz_evidence import album_signals
    local = {"tracks": [{"title": "Main Theme", "duration_seconds": 0}, {"title": "Ending Theme", "duration_seconds": 0}]}
    assert "track_list" in album_signals(local, {"tracks": [{"title": "MainTheme"}, {"title": "EndingTheme"}]})
    assert "track_list" not in album_signals(local, {"tracks": [{"title": "Maintenance"}, {"title": "Endings"}]})


def test_a_tag_cut_at_thirty_characters_agrees_with_the_title_it_starts_and_a_short_one_does_not():
    from music_app.services.musicbrainz_evidence import _starts_remote_title
    assert _starts_remote_title("Main Theme (Memory of Prize ve", {"mainthemememoryofprizeversion"})
    assert not _starts_remote_title("Main Theme", {"mainthemememoryofprizeversion"})
    assert not _starts_remote_title("Main Theme (Memory of Prize ve", {"mainthemememoryofprizeve"})


def test_data_tracks_are_dropped_and_audio_tracks_kept():
    from music_app.services.musicbrainz_client import _audio_tracks
    data = {"title": "[data track]", "artist-credit": [
        {"artist": {"id": "33cf029c-63b0-41a0-9855-be2a3665fb3b", "name": "[data]"}}]}
    assert _audio_tracks({"tracks": [data, {"title": "Data"}, {"title": "Song"}]}) == [{"title": "Data"}, {"title": "Song"}]


def test_only_a_mixed_mode_disc_may_hold_one_more_track_than_the_rip():
    from music_app.services.musicbrainz_enrichment import _audio_track_count_may_be
    assert _audio_track_count_may_be({"discs": [{"track_count": 7, "format": "Mixed Mode CD"}]}, 6)
    assert _audio_track_count_may_be({"discs": [{"track_count": 7, "format": "Mixed Mode CD"}]}, 7)
    assert not _audio_track_count_may_be({"discs": [{"track_count": 7, "format": "CD"}]}, 6)
