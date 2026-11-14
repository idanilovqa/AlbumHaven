"""Delivery 2 release identity: one test per rule, each with its negative case.

Main-album end (owner 2026-11-08), display track artists for unreadable tags (天門 "She and
Her Cat"), release decisions on matcher-5 evidence and the resulting type. The resolver is
replayed against a fake mirror built from the shared test-mirror helpers.
"""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from music_app.services.musicbrainz_client import MusicBrainzClient
from music_app.services.musicbrainz_release_identity import (
    display_track_artists,
    local_discs,
    main_disc_count,
    resolve_album_releases,
    resulting_type,
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


# Resulting type ---------------------------------------------------------------------------

def test_the_resulting_type_joins_primary_and_secondary_types():
    assert resulting_type("Album", ["Live", "Compilation"]) == "Album + Live + Compilation"


def test_no_type_shows_nothing():
    assert resulting_type(None, []) is None


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


@pytest.mark.parametrize("budget_spent", [True])
def test_a_spent_budget_is_retried_never_stored_as_absent(budget_spent, monkeypatch):
    from music_app.services import musicbrainz_release_identity as module
    monkeypatch.setattr(module, "_BASE_REQUESTS", 0)
    monkeypatch.setattr(module, "_REQUESTS_PER_ALBUM", 0)
    outcome = _resolve(_album("Angels Cry"))
    assert [album["diagnostic"] for album in outcome["albums"]] == ["budget_exhausted"]
