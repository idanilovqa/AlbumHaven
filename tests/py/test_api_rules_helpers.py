from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from music_app.routes.api_rules_helpers import build_utility_rules_payload


def _config(tmp_path):
    return {"MUSIC_DIR": tmp_path / "Music"}


def _album(*, key: str, name: str, album_artist: str, artists: list[str] | None = None):
    return SimpleNamespace(
        key=key,
        name=name,
        album_artist=album_artist,
        artists=artists or [album_artist],
        cover_path=None,
        year="1999",
        edition="",
        album_rating=0,
        total_duration_seconds=0,
        tracks=[],
        is_compilation=False,
    )


def test_build_utility_rules_payload_reuses_alias_views_and_serializes_only_ignored_version_albums(tmp_path):
    config = _config(tmp_path)
    ignored_row_path = str((Path(config["MUSIC_DIR"]) / "Artist" / "Album" / "song.mp3").resolve())
    serialized_keys = []

    def fake_album_to_dict(album):
        serialized_keys.append(album.key)
        return {"key": album.key, "name": album.name}

    payload = build_utility_rules_payload(
        config=config,
        albums=[
            _album(key="ignored-album", name="Ignored Album", album_artist="Canonical Artist"),
            _album(key="other-album", name="Other Album", album_artist="Other Artist"),
        ],
        file_cache={
            ignored_row_path: {
                "path": ignored_row_path,
                "album": "Problem Album",
                "album_artist": "Problem Alias",
                "artist": "Problem Alias",
                "year": "2001",
            },
        },
        ignored_version_keys={"ignored-album"},
        ignored_repair_keys={f"{ignored_row_path}::album_artist"},
        album_to_dict=fake_album_to_dict,
        alias_to_canonical={"Problem Alias": "Canonical Artist"},
    )

    assert serialized_keys == ["ignored-album"]
    assert payload["rules"][0]["albums"] == [{"key": "ignored-album", "name": "Ignored Album"}]
    assert payload["rules"][1]["items"][0]["problem_reason"] == "Artist name variant differs from canonical"


def test_build_utility_rules_payload_does_not_rebuild_alias_views_when_none_are_available(tmp_path):
    config = _config(tmp_path)
    ignored_row_path = str((Path(config["MUSIC_DIR"]) / "Artist" / "Album" / "song.mp3").resolve())

    payload = build_utility_rules_payload(
        config=config,
        albums=[],
        file_cache={
            ignored_row_path: {
                "path": ignored_row_path,
                "album": "Problem Album",
                "album_artist": "Problem Alias",
                "artist": "Problem Alias",
                "year": "2001",
            },
        },
        ignored_version_keys=set(),
        ignored_repair_keys={f"{ignored_row_path}::album_artist"},
        album_to_dict=lambda album: {"key": album.key, "name": album.name},
        alias_to_canonical=None,
    )

    assert payload["rules"][1]["items"][0]["problem_reason"] == ""


def test_build_utility_rules_payload_uses_saved_key_as_fallback_album_label(tmp_path):
    payload = build_utility_rules_payload(
        config=_config(tmp_path),
        albums=[],
        file_cache={},
        ignored_version_keys={"helloween"},
        ignored_repair_keys=set(),
        album_to_dict=lambda album: {"key": album.key, "name": album.name},
        alias_to_canonical=None,
    )

    assert payload["rules"][0]["albums"] == [{
        "key": "helloween",
        "album_ref": "helloween",
        "name": "Helloween",
        "album_artist": "",
        "year": "",
        "edition": "",
        "tracks": [],
    }]
