from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from music_app.routes import api_view_payload_helpers
from music_app.services import edit_state as edit_state_module
from music_app.services.edit_state import (
    find_album_dicts_by_track_paths,
    refresh_changed_files_in_cache,
    update_cache_entry_after_repairs,
)


def test_find_album_dicts_by_track_paths_returns_matching_album_dicts(tmp_path):
    track_path = str((tmp_path / "Artist" / "Album" / "song.mp3").resolve())
    track = SimpleNamespace(
        path=track_path,
        title="Song",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Test Artist",
        album="Test Album",
        album_artist="Test Artist",
        year="2001",
        release_date=None,
        edition="",
        album_rating=0,
        exception_type=None,
        cover_path=None,
        duration_seconds=0,
    )
    matching_album = SimpleNamespace(
        tracks=[track],
        key="album-1",
        name="Test Album",
        album_artist="Test Artist",
        artists=["Test Artist"],
        cover_path=None,
        year="2001",
        edition="",
        album_rating=0,
        total_duration_seconds=0,
        is_compilation=False,
    )

    matches = find_album_dicts_by_track_paths([matching_album], {track_path})

    assert len(matches) == 1
    assert matches[0]["key"] == "album-1"
    assert matches[0]["album_artist"] == "Test Artist"
    assert matches[0]["name"] == "Test Album"
    assert matches[0]["tracks"][0]["path"] == track_path
    assert matches[0]["tracks"][0]["title"] == "Song"


def test_edit_state_module_does_not_expose_flask_state_fallbacks():
    assert not hasattr(edit_state_module, "state")
    assert not hasattr(edit_state_module, "find_albums_by_track_paths")


def test_cache_entry_album_key_uses_service_owned_loose_track_album_detection(monkeypatch):
    monkeypatch.setattr(api_view_payload_helpers, "_is_loose_track_album_value", lambda _value: False)

    album_key = edit_state_module._cache_entry_album_key(
        {
            "album": "!Non album",
            "album_artist": "Mono",
            "exception_type": "",
        },
        set(),
    )

    assert album_key is None


def test_update_cache_entry_after_repairs_uses_module_logger_without_flask_context(monkeypatch):
    warnings: list[tuple[str, tuple[object, ...]]] = []

    class CapturingLogger:
        def warning(self, message, *args):
            warnings.append((message, args))

    monkeypatch.setattr(edit_state_module, "logger", CapturingLogger())

    updated = update_cache_entry_after_repairs(
        Path("missing-song.mp3"),
        {"title": "Old", "exception_type": ""},
        {"title": "New"},
    )

    assert updated["title"] == "New"
    assert warnings == [
        (
            "Could not stat repaired file %s: %s",
            (Path("missing-song.mp3"), warnings[0][1][1]),
        )
    ]


def test_update_cache_entry_after_year_repair_keeps_precise_release_date_in_sync(
    tmp_path,
):
    track_path = tmp_path / "song.mp3"
    track_path.write_bytes(b"audio")

    updated = update_cache_entry_after_repairs(
        track_path,
        {
            "year": 2004,
            "release_date": "2004-07-16",
        },
        {"year": "2014"},
    )

    assert updated["year"] == "2014"
    assert updated["release_date"] == "2014"


def test_refresh_changed_files_in_cache_uses_explicit_dependencies_without_flask_context(tmp_path, monkeypatch):
    track_path = tmp_path / "song.mp3"
    track_path.write_bytes(b"audio")
    cache_path = tmp_path / "cache.json"
    config = {"CACHE_PATH": cache_path, "DATA_DIR": tmp_path}
    scheduled: list[tuple[dict[str, object], Path, dict[str, object]]] = []

    monkeypatch.setattr(edit_state_module, "load_exception_overrides", lambda received_config: {"ignored": received_config})
    monkeypatch.setattr(
        edit_state_module,
        "read_metadata_for_file",
        lambda path: {
            "path": str(path),
            "album": "Album",
            "album_artist": "Artist",
            "title": "New",
        },
    )
    monkeypatch.setattr(
        edit_state_module,
        "apply_exception_override",
        lambda entry, overrides: entry.update({"override_seen": overrides["ignored"] is config}),
    )
    monkeypatch.setattr(edit_state_module, "load_separate_release_keys", lambda received_config: {"release-key"})
    monkeypatch.setattr(
        edit_state_module,
        "rebuild_affected_albums_in_state",
        lambda st, previous, updated, changed, keys: st.update({"rebuilt_with": (changed, keys)}),
    )
    monkeypatch.setattr(
        edit_state_module,
        "schedule_cache_updates_save_for_config",
        lambda received_config, path, payload: scheduled.append((received_config, path, payload)),
    )

    changed = refresh_changed_files_in_cache(
        {"separate_release_keys": set()},
        {str(track_path): {"path": str(track_path), "title": "Old"}},
        {str(track_path)},
        config=config,
        logger=None,
    )

    assert changed is True
    assert scheduled == [
            (
                config,
                cache_path,
                {
                str(track_path): {
                    "path": str(track_path),
                    "album": "Album",
                    "album_artist": "Artist",
                    "title": "New",
                    "override_seen": True,
                }
            },
        )
    ]


def test_refresh_changed_files_in_cache_requires_explicit_config():
    try:
        refresh_changed_files_in_cache({}, {}, {"song.mp3"})
    except TypeError as exc:
        assert "config" in str(exc)
    else:
        raise AssertionError("refresh_changed_files_in_cache should require explicit config")
