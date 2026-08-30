from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from music_app.services.relations import build_artist_alias_views


def _album(*, album_artist: str):
    track_path = Path(f"C:/Music/Test Artist/Shared Folder/{album_artist}/song.mp3")
    return SimpleNamespace(
        album_artist=album_artist,
        artists=[album_artist],
        tracks=[SimpleNamespace(path=str(track_path))],
    )


def test_build_artist_alias_views_merges_possessive_project_name_into_base_artist():
    alias_views = build_artist_alias_views(
        [
            _album(album_artist="Gungfly"),
            _album(album_artist="Rikard Sj\u00f6blom's Gungfly"),
        ],
        Path("C:/Music"),
    )

    assert alias_views["alias_to_canonical"]["Gungfly"] == "Gungfly"
    assert alias_views["alias_to_canonical"]["Rikard Sj\u00f6blom's Gungfly"] == "Gungfly"
    assert alias_views["canonical_to_aliases"]["Gungfly"] == [
        "Gungfly",
        "Rikard Sj\u00f6blom's Gungfly",
    ]


def test_build_artist_alias_views_merges_case_only_artist_variants():
    alias_views = build_artist_alias_views(
        [
            _album(album_artist="Mono"),
            _album(album_artist="MONO"),
        ],
        Path("C:/Music"),
    )

    canonical = alias_views["alias_to_canonical"]["Mono"]
    assert canonical == "Mono"
    assert alias_views["alias_to_canonical"]["MONO"] == canonical
    assert set(alias_views["canonical_to_aliases"][canonical]) == {"Mono", "MONO"}


def test_build_artist_alias_views_merges_punctuation_variants_from_album_artist_when_member_artists_differ():
    alias_views = build_artist_alias_views(
        [
            SimpleNamespace(
                album_artist="Morse Portnoy George",
                artists=["Neal Morse", "Mike Portnoy", "Randy George"],
                tracks=[SimpleNamespace(path="C:/Music/Shared/MPG A/song.mp3")],
            ),
            SimpleNamespace(
                album_artist="Morse, Portnoy & George",
                artists=["Neal Morse", "Mike Portnoy", "Randy George"],
                tracks=[SimpleNamespace(path="C:/Music/Shared/MPG B/song.mp3")],
            ),
        ],
        Path("C:/Music"),
    )

    assert alias_views["alias_to_canonical"]["Morse Portnoy George"] == "Morse Portnoy George"
    assert alias_views["alias_to_canonical"]["Morse, Portnoy & George"] == "Morse Portnoy George"
    assert set(alias_views["canonical_to_aliases"]["Morse Portnoy George"]) >= {
        "Morse Portnoy George",
        "Morse, Portnoy & George",
    }


def test_build_artist_alias_views_keeps_empty_low_value_signatures_isolated():
    alias_views = build_artist_alias_views(
        [
            _album(album_artist="東京事変"),
            _album(album_artist="Борис"),
            _album(album_artist="!!!"),
            _album(album_artist="***"),
        ],
        Path("C:/Music"),
    )

    for artist in ["東京事変", "Борис", "!!!", "***"]:
        assert alias_views["alias_to_canonical"][artist] == artist
        assert alias_views["canonical_to_aliases"][artist] == [artist]
