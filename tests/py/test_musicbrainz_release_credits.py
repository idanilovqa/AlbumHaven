"""Delivery 2, S2: albums of an artist without an identity, found by their release credits.

One test per rule plus its negative, replayed from the local mirror's recorded answers
(``delivery-2-release-credits-mirror.json``). A negative case is the same album with other
tracks: the same searches find the same releases, and no release is certain.
"""
from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlparse

from music_app.services.musicbrainz_client import MusicBrainzClient, _artist_credit
from music_app.services.musicbrainz_release_identity import resolve_album_releases
from tests.py.musicbrainz_test_mirror import OK

VARIOUS_ARTISTS = "89ad4ac3-39f7-470e-963a-56509c546377"
_FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "musicbrainz"
                       / "delivery-2-release-credits-mirror.json").read_text(encoding="utf-8"))


def _resolve(case: str) -> tuple[dict[str, object], list[dict[str, object]]]:
    def get_json(url, _agent, **_kwargs):
        parsed = urlparse(url)
        key = parsed.path.replace("/ws/2", "") + "?" + parsed.query
        assert key in _FIXTURE["responses"], f"unrecorded mirror request {key}"
        return _FIXTURE["responses"][key], OK

    [context] = [item["context"] for item in _FIXTURE["cases"] if item["case"] == case]
    client = MusicBrainzClient(base_url="http://127.0.0.1:5050/ws/2", user_agent="Test", get_json=get_json)
    outcome = resolve_album_releases(context, client=client)
    [album] = outcome["albums"]
    release = outcome["releases"].get(album.get("release_mbid") or "") or {}
    return album, release.get("artist_credit") or []


def _credit(credit: list[dict[str, object]]) -> list[tuple[object, object]]:
    return [(part["name"], part["join_phrase"]) for part in credit]


# Rule 1: a collaboration's album takes its certain release's credit, in MusicBrainz's order.

def test_a_collaboration_album_takes_each_participant_from_its_certain_release():
    album, credit = _resolve("Alan Menken & Howard Ashman: The Little Mermaid")
    assert album["state"] == "release"
    assert _credit(credit) == [("Alan Menken", " & "), ("Howard Ashman", "")]
    assert all(part["artist_mbid"] for part in credit)


def test_the_credit_follows_musicbrainz_not_the_local_name():
    album, credit = _resolve("Al Di Meola feat Леонид Агутин: Cosmopolitan Life")
    assert album["state"] == "release"
    assert [part["name"] for part in credit] == ["Леонид Агутин", "Al Di Meola"]


def test_a_collaboration_album_whose_tracks_differ_gets_no_credit():
    album, credit = _resolve("Alan Menken & Howard Ashman: The Little Mermaid, other tracks")
    assert (album["state"], album["diagnostic"], credit) == ("unresolved", "tracks_differ", [])


def test_a_join_phrase_keeps_its_spaces():
    credit = _artist_credit([{"name": "Alan Menken", "joinphrase": " & ", "artist": {
        "id": "0f8ae2f4-4b3a-4f33-8f0c-b5eae4a54e95", "name": "Alan Menken"}}])
    assert credit[0]["join_phrase"] == " & "


# Rule 2: "Various Artists" is a display name; it is the credit only when MusicBrainz credits it.

def test_various_artists_is_the_credit_when_musicbrainz_credits_it():
    album, credit = _resolve("Various Artists: Elizabethtown")
    assert album["state"] == "release"
    assert [part["artist_mbid"] for part in credit] == [VARIOUS_ARTISTS]


def test_the_local_various_artists_name_alone_never_makes_the_credit():
    album, credit = _resolve("Various Artists: Elizabethtown, other tracks")
    assert (album["state"], credit) == ("unresolved", [])


def test_a_various_artists_album_musicbrainz_credits_to_a_band_takes_the_band():
    album, credit = _resolve("Various Artists: Black Cat, White Cat")
    assert album["state"] == "release"
    assert [part["artist_name"] for part in credit] == ["Emir Kusturica & The No Smoking Orchestra"]
    assert VARIOUS_ARTISTS not in {part["artist_mbid"] for part in credit}


# Rule 3: a classical album is matched through its performers and keeps MusicBrainz's credit
# order, the composer first (for now).

def test_a_classical_album_keeps_the_composer_first_as_musicbrainz_credits_it():
    album, credit = _resolve("George Frideric Handel; Academy of Ancient Music: Messiah")
    assert album["state"] == "release"
    assert credit[0]["artist_name"] == "George Frideric Handel"
    assert [part["name"] for part in credit[1:3]] == ["Academy of Ancient Music", "Christ Church Cathedral Choir, Oxford"]


def test_a_classical_album_whose_track_titles_are_worded_otherwise_gets_no_credit():
    # Inna Poroshina's tags name the pieces differently ("Theme & Variations in A-flat major,
    # Op.36", MusicBrainz "Theme and Variations, op. 36: Theme"); lengths alone never prove it.
    album, credit = _resolve("Inna Poroshina: Dvořák: Complete Piano Works")
    assert (album["state"], album["diagnostic"], credit) == ("unresolved", "tracks_differ", [])
