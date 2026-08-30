from __future__ import annotations

from pathlib import Path
from threading import Event, Thread
from types import SimpleNamespace

import pytest

from music_app.services import edit_workflows as edit_workflows_module
from music_app.services.edit_workflows import handle_edit_tags_request, handle_repair_album_request
from music_app.services.scan_cache_persistence import (
    StructuralTagEditDestinationConflict,
)
from tests.py.runtime_testing import configure_test_app_paths


@pytest.fixture
def config(tmp_path, monkeypatch):
    paths = configure_test_app_paths(tmp_path, monkeypatch)
    return {
        "DATA_DIR": paths["data_dir"],
        "MUSIC_DIR": paths["music_dir"],
        "CACHE_PATH": paths["cache_path"],
        "COVER_CACHE_PATH": paths["cover_cache_path"],
        "LIBRARY_ROOTS_PATH": paths["library_roots_path"],
        "TESTING": True,
    }


def _logger_stub():
    return SimpleNamespace(
        debug=lambda *args, **kwargs: None,
        info=lambda *args, **kwargs: None,
        warning=lambda *args, **kwargs: None,
        error=lambda *args, **kwargs: None,
        exception=lambda *args, **kwargs: None,
    )


def test_edit_workflows_tests_do_not_use_flask_fixture_or_app_context():
    source = Path(__file__).read_text(encoding="utf-8")

    assert "tests.py." + "flask_fixtures" not in source
    assert "app." + "app_context(" not in source


def test_handle_repair_album_request_queues_explicit_config_logger_without_app(config):
    logger = _logger_stub()
    track_path = str((config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve())
    state_payload = {
        "file_cache": {
            track_path: {
                "path": track_path,
                "title": "Mojibake Song",
                "album": "Album",
                "album_artist": "Artist",
            },
        },
        "relation_views": {"alias_to_canonical": {}},
        "separate_release_keys": set(),
    }
    queued_payloads: list[dict[str, object]] = []

    payload = handle_repair_album_request(
        payload={
            "selected_rows": [f"{track_path}::title"],
            "ignored_rows": [],
            "separate_release_keys": [],
        },
        album={
            "name": "Album",
            "album_artist": "Artist",
            "tracks": [{"path": track_path}],
        },
        requested_track_paths={track_path},
        config=config,
        logger=logger,
        get_state=lambda: state_payload,
        create_save_task=lambda kind: f"task-{kind}",
        queue_finalize_save_task=lambda **kwargs: queued_payloads.append(dict(kwargs)),
        build_text_repairs_for_entry=lambda _entry: {"title": "Fixed Song"},
        build_artist_alias_repairs_for_entry=lambda _entry, _aliases: {},
        build_disc_marker_repairs_for_entry=lambda _entry: {},
        apply_repairs_worker=lambda raw_path, repairs: (raw_path, True, list(repairs)),
        update_cache_entry_after_repairs=lambda path, entry, repairs: {**entry, **repairs, "path": str(path)},
        build_affected_album_dicts=lambda *args, **kwargs: [{"key": "album-1"}],
        find_problematic_album_by_track_paths=lambda track_paths: None,
        find_albums_by_track_paths=lambda track_paths: [{"key": "album-1"}],
        rebuild_affected_albums_in_state=lambda *args, **kwargs: None,
        load_ignored_repair_keys=lambda config: set(),
        save_ignored_repair_keys=lambda config, values: None,
        load_separate_release_keys=lambda config: set(),
        save_separate_release_keys=lambda config, values: None,
        append_log_history=lambda config, entry: None,
        log_app_event=lambda *args, **kwargs: None,
        structural_edit_fields={"title"},
        edit_write_workers=1,
    )

    assert payload["ok"] is True
    assert queued_payloads
    assert queued_payloads[0]["config"] is config
    assert queued_payloads[0]["logger"] is logger
    assert "app" not in queued_payloads[0]


def test_handle_repair_album_request_rejects_ignored_only_problem_exclusion(config):
    durable_album_key = "product artist::studio records"
    projected_album_key = f"{durable_album_key}::year::1988"
    selected_row_key = (
        f"{projected_album_key}::problem-album::undecoded-characters"
    )
    unselected_row_key = (
        f"{projected_album_key}::problem-album::missing-year"
    )
    track_paths = [
        "C:/Music/Product Artist/Studio Records/01.flac",
        "C:/Music/Product Artist/Studio Records/02.flac",
    ]
    album = {
        "key": projected_album_key,
        "name": "?",
        "album_artist": "Product Artist",
        "tracks": [{"path": path} for path in track_paths],
        "album_problem_rows": [
            {
                "row_key": selected_row_key,
                "album_key": durable_album_key,
                "reason": "Undecoded characters",
            },
            {
                "row_key": unselected_row_key,
                "album_key": durable_album_key,
                "reason": "Missing year",
            },
        ],
    }
    saved: list[tuple[set[str], dict[str, str]]] = []

    def save_ignored_repair_keys(
        _config,
        values,
        *,
        album_keys_by_repair_key=None,
    ):
        saved.append(
            (
                set(values),
                dict(album_keys_by_repair_key or {}),
            )
        )

    result = handle_repair_album_request(
        payload={
            "confirmed": True,
            "album": album,
            "selected_rows": [],
            "ignored_rows": [selected_row_key],
            "separate_release_keys": [],
        },
        album=album,
        requested_track_paths=set(track_paths),
        config=config,
        logger=_logger_stub(),
        get_state=lambda: {},
        create_save_task=lambda _kind: (_ for _ in ()).throw(
            AssertionError("album exclusion must not create a save task")
        ),
        queue_finalize_save_task=lambda **_kwargs: (_ for _ in ()).throw(
            AssertionError("album exclusion must not queue a finalizer")
        ),
        build_text_repairs_for_entry=lambda _entry: {},
        build_artist_alias_repairs_for_entry=lambda _entry, _aliases: {},
        build_disc_marker_repairs_for_entry=lambda _entry: {},
        apply_repairs_worker=lambda *_args: (_ for _ in ()).throw(
            AssertionError("album exclusion must not write media")
        ),
        update_cache_entry_after_repairs=lambda *_args: {},
        build_affected_album_dicts=lambda *_args, **_kwargs: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        find_albums_by_track_paths=lambda _paths: [],
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: None,
        load_ignored_repair_keys=lambda _config: {
            "existing::problem-file::missing-year",
            *(f"{path}::album" for path in track_paths),
        },
        save_ignored_repair_keys=save_ignored_repair_keys,
        load_separate_release_keys=lambda _config: set(),
        save_separate_release_keys=lambda _config, _values: None,
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        structural_edit_fields=set(),
        edit_write_workers=1,
    )

    response, status_code = result
    assert status_code == 400
    assert response["ok"] is False
    assert "exclusion" in str(response.get("error") or "").casefold()
    assert saved == []


def test_separate_release_only_repair_path_still_succeeds_and_invalidates_projection(config, monkeypatch):
    from music_app.services import ignored_repairs as ignored_repairs_module
    from music_app.services import library_browse_postgres as library_browse_postgres_module
    from music_app.services import separate_releases as separate_releases_module

    database_url = "postgresql://album_haven_app@localhost/rule-only-repairs"
    config["ALBUM_HAVEN_APP_DATABASE_URL"] = database_url
    invalidations: list[dict[str, object]] = []
    saved_ignored: list[set[str]] = []
    saved_separate: list[set[str]] = []

    class FakeIgnoredAdapter:
        def __init__(self, _config):
            pass

        def save_ignored_repair_keys(self, values):
            saved_ignored.append(set(values))

    class FakeSeparateAdapter:
        def __init__(self, _config):
            pass

        def save_separate_release_keys(self, values):
            saved_separate.append(set(values))

    monkeypatch.setattr(ignored_repairs_module, "select_runtime_persistence_adapter", lambda *_args: None)
    monkeypatch.setattr(ignored_repairs_module, "RuleStatePostgresAdapter", FakeIgnoredAdapter)
    monkeypatch.setattr(separate_releases_module, "select_runtime_persistence_adapter", lambda *_args: None)
    monkeypatch.setattr(separate_releases_module, "RuleStatePostgresAdapter", FakeSeparateAdapter)
    monkeypatch.setattr(
        library_browse_postgres_module,
        "invalidate_postgres_utility_projection_cache",
        lambda **kwargs: invalidations.append(dict(kwargs)),
    )

    track_path = str((config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve())
    state_payload = {
        "file_cache": {
            track_path: {
                "path": track_path,
                "title": "Song",
                "album": "Album",
                "album_artist": "Artist",
            },
        },
        "relation_views": {"alias_to_canonical": {}},
        "separate_release_keys": set(),
    }

    def run(payload):
        return handle_repair_album_request(
            payload=payload,
            album={"name": "Album", "album_artist": "Artist", "tracks": [{"path": track_path}]},
            requested_track_paths={track_path},
            config=config,
            logger=_logger_stub(),
            get_state=lambda: state_payload,
            create_save_task=lambda _kind: (_ for _ in ()).throw(AssertionError("no save task expected")),
            queue_finalize_save_task=lambda **_kwargs: (_ for _ in ()).throw(AssertionError("no finalizer expected")),
            build_text_repairs_for_entry=lambda _entry: {},
            build_artist_alias_repairs_for_entry=lambda _entry, _aliases: {},
            build_disc_marker_repairs_for_entry=lambda _entry: {},
            apply_repairs_worker=lambda *_args: (_ for _ in ()).throw(AssertionError("no file write expected")),
            update_cache_entry_after_repairs=lambda *_args: {},
            build_affected_album_dicts=lambda *_args, **_kwargs: [{"key": "album"}],
            find_problematic_album_by_track_paths=lambda _paths: None,
            find_albums_by_track_paths=lambda _paths: [{"key": "album"}],
            rebuild_affected_albums_in_state=lambda *_args, **_kwargs: None,
            load_ignored_repair_keys=lambda _config: set(),
            save_ignored_repair_keys=ignored_repairs_module.save_ignored_repair_keys,
            load_separate_release_keys=lambda _config: set(),
            save_separate_release_keys=separate_releases_module.save_separate_release_keys,
            append_log_history=lambda *_args, **_kwargs: None,
            log_app_event=lambda *_args, **_kwargs: None,
            structural_edit_fields={"title"},
            edit_write_workers=1,
        )

    no_selected_result = run({
        "selected_rows": [],
        "ignored_rows": [],
        "separate_release_keys": ["artist::album"],
    })
    zero_changed_result = run({
        "selected_rows": [f"{track_path}::title"],
        "ignored_rows": [],
        "separate_release_keys": ["artist::album::deluxe"],
    })

    assert no_selected_result["ok"] is True
    assert no_selected_result["changed_count"] == 0
    assert zero_changed_result["ok"] is True
    assert zero_changed_result["changed_count"] == 0
    assert saved_ignored == []
    assert saved_separate == [
        {"artist::album"},
        {"artist::album", "artist::album::deluxe"},
    ]
    assert invalidations == [
        {"database_url": database_url, "kinds": ("problematic-files",)},
        {"database_url": database_url, "kinds": ("problematic-files",)},
    ]


def test_handle_edit_tags_request_exception_only_uses_override_and_queues_save(config):
    logger = _logger_stub()
    track_path = str((config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve())
    state_payload = {
        "file_cache": {
            track_path: {
                "path": track_path,
                "title": "Song",
                "exception_type": "",
            },
        },
        "separate_release_keys": set(),
    }
    saved_overrides: list[tuple[str, str]] = []
    queued_payloads: list[dict[str, object]] = []

    payload = handle_edit_tags_request(
        album={
            "name": "Test Album",
            "album_artist": "Test Artist",
            "tracks": [{"path": track_path}],
        },
        updates={track_path: {"exception_type": "Non-album rarity"}},
        requested_track_paths={track_path},
        config=config,
        logger=logger,
        get_state=lambda: state_payload,
        create_save_task=lambda kind: f"task-{kind}",
        queue_finalize_save_task=lambda **kwargs: queued_payloads.append(dict(kwargs)),
        apply_repairs_worker=lambda raw_path, repairs: (_ for _ in ()).throw(
            AssertionError("exception-only edits should not call the file repair worker")
        ),
        update_cache_entry_after_repairs=lambda path, entry, repairs: {**entry, **repairs},
        build_affected_album_dicts=lambda *args, **kwargs: [{"key": "album-1"}],
        load_separate_release_keys=lambda config: set(),
        normalize_exception_value=lambda value: str(value or "").strip(),
        append_log_history=lambda config, entry: None,
        log_app_event=lambda *args, **kwargs: None,
        structural_edit_fields={"exception_type"},
        edit_write_workers=1,
        save_track_exception_override=lambda config, raw_path, value: saved_overrides.append((str(raw_path), str(value)))
        or str(value),
    )

    assert payload["ok"] is True
    assert payload["changed_count"] == 1
    assert payload["requires_view_refresh"] is True
    assert payload["updated_album"] == {"key": "album-1"}
    assert payload["save_task_id"] == "task-edit-tags"
    assert payload["committed_values"] == {
        track_path: {"exception_type": "Non-album rarity"}
    }
    assert saved_overrides == [(track_path, "Non-album rarity")]
    assert queued_payloads and queued_payloads[0]["changed_paths"] == {track_path}
    assert queued_payloads[0]["config"] is config
    assert queued_payloads[0]["logger"] is logger
    assert "app" not in queued_payloads[0]


def test_handle_edit_tags_request_does_not_require_flask_context(config):
    logger = _logger_stub()
    track_path = str((config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve())
    state_payload = {
        "file_cache": {
            track_path: {
                "path": track_path,
                "title": "Song",
                "exception_type": "",
            },
        },
        "separate_release_keys": set(),
    }
    queued_payloads: list[dict[str, object]] = []

    payload = handle_edit_tags_request(
        album={
            "name": "Test Album",
            "album_artist": "Test Artist",
            "tracks": [{"path": track_path}],
        },
        updates={track_path: {"exception_type": "Live cut"}},
        requested_track_paths={track_path},
        config=config,
        logger=logger,
        get_state=lambda: state_payload,
        create_save_task=lambda kind: f"task-{kind}",
        queue_finalize_save_task=lambda **kwargs: queued_payloads.append(dict(kwargs)),
        apply_repairs_worker=lambda raw_path, repairs: (_ for _ in ()).throw(
            AssertionError("exception-only edits should not call the file repair worker")
        ),
        update_cache_entry_after_repairs=lambda path, entry, repairs: {**entry, **repairs},
        build_affected_album_dicts=lambda *args, **kwargs: [{"key": "album-1"}],
        load_separate_release_keys=lambda config: set(),
        normalize_exception_value=lambda value: str(value or "").strip(),
        append_log_history=lambda config, entry: None,
        log_app_event=lambda *args, **kwargs: None,
        structural_edit_fields={"exception_type"},
        edit_write_workers=1,
        save_track_exception_override=lambda config, raw_path, value: str(value),
    )

    assert payload["ok"] is True
    assert queued_payloads and queued_payloads[0]["config"] is config


def test_mixed_media_and_exception_failure_compensates_media_before_returning(
    config,
):
    track_path = str(
        (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    )
    media_title = {track_path: "Old Title"}
    media_writes: list[dict[str, str]] = []
    queued_payloads: list[dict[str, object]] = []

    def apply_repairs(raw_path, repairs):
        normalized = dict(repairs)
        media_writes.append(normalized)
        media_title[raw_path] = normalized["title"]
        return raw_path, True, list(normalized)

    result = handle_edit_tags_request(
        album={
            "name": "Album",
            "album_artist": "Artist",
            "tracks": [{"path": track_path}],
        },
        updates={
            track_path: {
                "title": "New Title",
                "exception_type": "",
            }
        },
        requested_track_paths={track_path},
        config=config,
        logger=_logger_stub(),
        get_state=lambda: {
            "file_cache": {
                track_path: {
                    "path": track_path,
                    "title": "Old Title",
                    "album": "Album",
                    "album_artist": "Artist",
                    "exception_type": "Non-album rarity",
                }
            },
            "separate_release_keys": set(),
        },
        create_save_task=lambda _kind: "must-not-create",
        queue_finalize_save_task=lambda **kwargs: queued_payloads.append(dict(kwargs)),
        apply_repairs_worker=apply_repairs,
        update_cache_entry_after_repairs=lambda path, entry, repairs: {
            **entry,
            **repairs,
            "path": str(path),
        },
        build_affected_album_dicts=lambda *_args, **_kwargs: [],
        load_separate_release_keys=lambda _config: set(),
        normalize_exception_value=lambda value: str(value or "").strip(),
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        structural_edit_fields={"exception_type"},
        edit_write_workers=1,
        save_track_exception_override=lambda *_args: pytest.fail(
            "batch exception saver should be used"
        ),
        save_track_exception_overrides=lambda *_args: (_ for _ in ()).throw(
            RuntimeError("exception persistence failed")
        ),
    )

    payload, status_code = result
    assert status_code == 500
    assert payload["ok"] is False
    assert "exception persistence failed" in payload["error"]
    assert media_title[track_path] == "Old Title"
    assert media_writes == [
        {"title": "New Title"},
        {"title": "Old Title"},
    ]
    assert queued_payloads == []


def test_album_rename_prevalidation_rejects_conflict_before_media_write(config):
    track_path = str((config["MUSIC_DIR"] / "Artist" / "Old Album" / "song.mp3").resolve())
    state_payload = {
        "file_cache": {
            track_path: {
                "path": track_path,
                "album": "Old Album",
                "album_artist": "Artist",
                "title": "Song",
            }
        },
        "separate_release_keys": set(),
    }
    media_writes: list[str] = []

    result = handle_edit_tags_request(
        album={
            "name": "Old Album",
            "album_artist": "Artist",
            "tracks": [{"path": track_path}],
        },
        updates={track_path: {"album": "Existing Album"}},
        requested_track_paths={track_path},
        config=config,
        logger=_logger_stub(),
        get_state=lambda: state_payload,
        create_save_task=lambda _kind: "must-not-create",
        queue_finalize_save_task=lambda **_kwargs: None,
        apply_repairs_worker=lambda raw_path, repairs: media_writes.append(raw_path)
        or (raw_path, True, list(repairs)),
        update_cache_entry_after_repairs=lambda path, entry, repairs: {
            **entry,
            **repairs,
            "path": str(path),
        },
        build_affected_album_dicts=lambda *_args, **_kwargs: [],
        load_separate_release_keys=lambda _config: set(),
        normalize_exception_value=lambda value: str(value or "").strip(),
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        structural_edit_fields={"album"},
        edit_write_workers=1,
        save_track_exception_override=lambda *_args: "",
        prevalidate_structural_tag_edit=lambda **_kwargs: (_ for _ in ()).throw(
            StructuralTagEditDestinationConflict(
                "Structural tag persistence rejected the edit because the destination album already exists."
            )
        ),
    )

    payload, status_code = result
    expected_error = (
        "Structural tag persistence rejected the edit because the destination album "
        "already exists."
    )
    assert status_code == 409
    assert payload["ok"] is False
    assert payload["error"] == expected_error
    assert payload["log_entry"]["action"] == "Tag edit failed"
    assert payload["log_entry"]["artist"] == "Artist"
    assert payload["log_entry"]["album"] == "Old Album"
    assert payload["log_entry"]["file_count"] == 1
    assert payload["log_entry"]["files"] == [track_path]
    assert payload["log_entry"]["error"] == expected_error
    assert media_writes == []


def test_album_rename_prevalidation_database_failure_is_server_error_before_media_write(
    config,
):
    track_path = str((config["MUSIC_DIR"] / "Artist" / "Old Album" / "song.mp3").resolve())
    state_payload = {
        "file_cache": {
            track_path: {
                "path": track_path,
                "album": "Old Album",
                "album_artist": "Artist",
                "title": "Song",
            }
        },
        "separate_release_keys": set(),
    }
    media_writes: list[str] = []
    history_entries: list[dict[str, object]] = []
    app_events: list[tuple[tuple[object, ...], dict[str, object]]] = []

    result = handle_edit_tags_request(
        album={
            "name": "Old Album",
            "album_artist": "Artist",
            "tracks": [{"path": track_path}],
        },
        updates={track_path: {"album": "New Album"}},
        requested_track_paths={track_path},
        config=config,
        logger=_logger_stub(),
        get_state=lambda: state_payload,
        create_save_task=lambda _kind: "must-not-create",
        queue_finalize_save_task=lambda **_kwargs: None,
        apply_repairs_worker=lambda raw_path, repairs: media_writes.append(raw_path)
        or (raw_path, True, list(repairs)),
        update_cache_entry_after_repairs=lambda path, entry, repairs: {
            **entry,
            **repairs,
            "path": str(path),
        },
        build_affected_album_dicts=lambda *_args, **_kwargs: [],
        load_separate_release_keys=lambda _config: set(),
        normalize_exception_value=lambda value: str(value or "").strip(),
        append_log_history=lambda _config, entry: history_entries.append(dict(entry)),
        log_app_event=lambda *args, **kwargs: app_events.append((args, kwargs)),
        structural_edit_fields={"album"},
        edit_write_workers=1,
        save_track_exception_override=lambda *_args: "",
        prevalidate_structural_tag_edit=lambda **_kwargs: (_ for _ in ()).throw(
            PermissionError("database permission denied")
        ),
    )

    payload, status = result
    assert status == 500
    assert payload["ok"] is False
    assert payload["error"] == "database permission denied"
    failure_entry = payload["log_entry"]
    assert failure_entry["action"] == "Tag edit failed"
    assert failure_entry["artist"] == "Artist"
    assert failure_entry["album"] == "Old Album"
    assert failure_entry["files"] == [track_path]
    assert failure_entry["error"] == "database permission denied"
    assert history_entries == [failure_entry]
    assert len(app_events) == 1
    assert app_events[0][0][2] == "Tag edit failed"
    assert app_events[0][1]["level"] == "error"
    assert media_writes == []


def test_concurrent_album_rename_failure_compensates_every_successful_media_write(
    config,
):
    first_path = str(
        (config["MUSIC_DIR"] / "Artist" / "Old Album" / "01 first.mp3").resolve()
    )
    second_path = str(
        (config["MUSIC_DIR"] / "Artist" / "Old Album" / "02 second.mp3").resolve()
    )
    file_cache = {
        path: {
            "path": path,
            "album": "Old Album",
            "album_artist": "Artist",
            "title": title,
        }
        for path, title in ((first_path, "First"), (second_path, "Second"))
    }
    media_albums = {first_path: "Old Album", second_path: "Old Album"}
    first_write_completed = Event()
    queued_save_tasks: list[dict[str, object]] = []

    def apply_repairs(raw_path, repairs):
        destination = str(repairs.get("album") or "")
        if raw_path == second_path and destination == "New Album":
            assert first_write_completed.wait(timeout=1.0)
            raise RuntimeError("second write failed")
        media_albums[raw_path] = destination
        if raw_path == first_path and destination == "New Album":
            first_write_completed.set()
        return raw_path, True, list(repairs)

    result = handle_edit_tags_request(
        album={
            "name": "Old Album",
            "album_artist": "Artist",
            "tracks": [{"path": first_path}, {"path": second_path}],
        },
        updates={
            first_path: {"album": "New Album"},
            second_path: {"album": "New Album"},
        },
        requested_track_paths={first_path, second_path},
        config=config,
        logger=_logger_stub(),
        get_state=lambda: {
            "file_cache": file_cache,
            "separate_release_keys": set(),
        },
        create_save_task=lambda _kind: "must-not-create",
        queue_finalize_save_task=lambda **kwargs: queued_save_tasks.append(dict(kwargs)),
        apply_repairs_worker=apply_repairs,
        update_cache_entry_after_repairs=lambda path, entry, repairs: {
            **entry,
            **repairs,
            "path": str(path),
        },
        build_affected_album_dicts=lambda *_args, **_kwargs: [],
        load_separate_release_keys=lambda _config: set(),
        normalize_exception_value=lambda value: str(value or "").strip(),
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        structural_edit_fields={"album"},
        edit_write_workers=2,
        save_track_exception_override=lambda *_args: "",
        prevalidate_structural_tag_edit=lambda **_kwargs: None,
    )

    payload, status_code = result
    expected_error = f"Failed to edit tags for {second_path}: second write failed"
    assert status_code == 500
    assert payload["ok"] is False
    assert payload["error"] == expected_error
    assert payload["log_entry"]["action"] == "Tag edit failed"
    assert payload["log_entry"]["file_count"] == 1
    assert payload["log_entry"]["files"] == [second_path]
    assert payload["log_entry"]["error"] == expected_error
    assert media_albums == {
        first_path: "Old Album",
        second_path: "Old Album",
    }
    assert queued_save_tasks == []


def test_partial_year_write_failure_compensates_with_precise_previous_release_date(
    config,
):
    first_path = str(
        (config["MUSIC_DIR"] / "Artist" / "Album" / "01 first.mp3").resolve()
    )
    second_path = str(
        (config["MUSIC_DIR"] / "Artist" / "Album" / "02 second.mp3").resolve()
    )
    previous_release_date = "2004-07-16"
    media_release_dates = {
        first_path: previous_release_date,
        second_path: previous_release_date,
    }
    media_writes: list[tuple[str, dict[str, str]]] = []

    def apply_repairs(raw_path, repairs):
        normalized_repairs = dict(repairs)
        media_writes.append((raw_path, normalized_repairs))
        if raw_path == second_path and normalized_repairs == {"year": "2014"}:
            raise RuntimeError("second year write failed")
        media_release_dates[raw_path] = normalized_repairs["year"]
        return raw_path, True, list(normalized_repairs)

    changed_files, skipped_files, failure = edit_workflows_module._run_edit_jobs(
        album={
            "name": "Album",
            "album_artist": "Artist",
            "tracks": [{"path": first_path}, {"path": second_path}],
        },
        repair_jobs=[
            (
                first_path,
                {
                    "path": first_path,
                    "year": 2004,
                    "release_date": previous_release_date,
                },
                {"year": "2014"},
            ),
            (
                second_path,
                {
                    "path": second_path,
                    "year": 2004,
                    "release_date": previous_release_date,
                },
                {"year": "2014"},
            ),
        ],
        config=config,
        logger=_logger_stub(),
        apply_repairs_worker=apply_repairs,
        update_cache_entry_after_repairs=lambda *_args: {},
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        updated_file_cache={},
        action_name="Edit tags",
        failure_prefix="Failed to edit tags for",
        edit_write_workers=1,
    )

    assert changed_files == []
    assert skipped_files == []
    assert failure is not None
    assert failure["error"] == (
        f"Failed to edit tags for {second_path}: second year write failed"
    )
    assert media_writes == [
        (first_path, {"year": "2014"}),
        (second_path, {"year": "2014"}),
        (first_path, {"year": previous_release_date}),
    ]
    assert media_release_dates == {
        first_path: previous_release_date,
        second_path: previous_release_date,
    }


def test_three_file_edit_rejects_field_mismatch_and_compensates_all_completed_writes(
    config,
):
    paths = [
        str((config["MUSIC_DIR"] / "Artist" / "Album" / f"0{i} song.mp3").resolve())
        for i in range(1, 4)
    ]
    media_values = {
        path: {"title": f"Old {index}", "album": "Old Album"}
        for index, path in enumerate(paths, start=1)
    }

    def apply_repairs(raw_path, repairs):
        requested = dict(repairs)
        if raw_path == paths[1] and requested.get("album") == "New Album":
            requested.pop("album")
        media_values[raw_path].update(requested)
        return raw_path, bool(requested), list(requested)

    repair_jobs = [
        (
            path,
            {"path": path, **media_values[path]},
            {"title": f"New {index}", "album": "New Album"},
        )
        for index, path in enumerate(paths, start=1)
    ]

    changed_files, skipped_files, failure = edit_workflows_module._run_edit_jobs(
        album={"name": "Old Album", "album_artist": "Artist"},
        repair_jobs=repair_jobs,
        config=config,
        logger=_logger_stub(),
        apply_repairs_worker=apply_repairs,
        update_cache_entry_after_repairs=lambda *_args: {},
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        updated_file_cache={},
        action_name="Edit tags",
        failure_prefix="Failed to edit tags for",
        edit_write_workers=1,
    )

    assert changed_files == []
    assert skipped_files == []
    assert failure is not None
    assert paths[1] in failure["error"]
    assert "album" in failure["error"]
    assert media_values == {
        path: {"title": f"Old {index}", "album": "Old Album"}
        for index, path in enumerate(paths, start=1)
    }


def test_edit_tags_prepares_durable_intent_before_media_and_marks_verified(config):
    track_path = str((config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve())
    events: list[object] = []
    queued: list[dict[str, object]] = []

    result = handle_edit_tags_request(
        album={"name": "Album", "album_artist": "Artist", "tracks": [{"path": track_path}]},
        updates={track_path: {"album": "", "exception_type": ""}},
        requested_track_paths={track_path},
        config=config,
        logger=_logger_stub(),
        get_state=lambda: {
            "file_cache": {
                track_path: {
                    "path": track_path,
                    "album": "Album",
                    "album_artist": "Artist",
                    "exception_type": "Non-album rarity",
                }
            },
            "separate_release_keys": set(),
        },
        create_save_task=lambda _kind: "save-1",
        queue_finalize_save_task=lambda **kwargs: queued.append(dict(kwargs)),
        apply_repairs_worker=lambda path, repairs: events.append(("media", path, dict(repairs)))
        or (path, True, list(repairs)),
        update_cache_entry_after_repairs=lambda path, entry, repairs: {
            **entry,
            **repairs,
            "path": str(path),
        },
        build_affected_album_dicts=lambda *_args, **_kwargs: [],
        load_separate_release_keys=lambda _config: set(),
        normalize_exception_value=lambda value: str(value or "").strip(),
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        structural_edit_fields={"album", "exception_type"},
        edit_write_workers=1,
        save_track_exception_override=lambda *_args: pytest.fail("durable intent defers exceptions"),
        save_track_exception_overrides=lambda *_args: pytest.fail("durable intent defers exceptions"),
        prevalidate_structural_tag_edit=lambda **_kwargs: None,
        prepare_tag_edit_intent=lambda *, changes: events.append(("prepared", changes)) or "intent-1",
        mark_tag_edit_files_verified=lambda intent_id: events.append(("verified", intent_id)),
    )

    assert result["ok"] is True
    assert events == [
        (
            "prepared",
            [
                {
                    "path": track_path,
                    "old_values": {"album": "Album", "exception_type": "Non-album rarity"},
                    "requested_values": {"album": "", "exception_type": ""},
                }
            ],
        ),
        ("media", track_path, {"album": ""}),
        ("verified", "intent-1"),
    ]
    assert queued[0]["tag_edit_intent_id"] == "intent-1"
    assert queued[0]["exception_updates"] == {track_path: ""}


def test_edit_tags_checkpoint_failure_after_media_write_still_queues_intent_finalization(
    config,
):
    track_path = str(
        (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    )
    media_album = {"value": "Album"}
    queued: list[dict[str, object]] = []
    logging_attempts: list[str] = []
    logger = _logger_stub()

    def fail_fallback_log(*_args, **_kwargs):
        logging_attempts.append("fallback")
        raise RuntimeError("fallback logger unavailable")

    logger.exception = fail_fallback_log

    def fail_primary_log(*_args, **_kwargs):
        logging_attempts.append("primary")
        raise RuntimeError("primary logger unavailable")

    def apply_repairs(path, repairs):
        media_album["value"] = repairs["album"]
        return path, True, list(repairs)

    result = handle_edit_tags_request(
        album={
            "name": "Album",
            "album_artist": "Artist",
            "tracks": [{"path": track_path}],
        },
        updates={track_path: {"album": ""}},
        requested_track_paths={track_path},
        config=config,
        logger=logger,
        get_state=lambda: {
            "file_cache": {
                track_path: {
                    "path": track_path,
                    "album": "Album",
                    "album_artist": "Artist",
                }
            },
            "separate_release_keys": set(),
        },
        create_save_task=lambda _kind: "save-1",
        queue_finalize_save_task=lambda **kwargs: queued.append(dict(kwargs)),
        apply_repairs_worker=apply_repairs,
        update_cache_entry_after_repairs=lambda path, entry, repairs: {
            **entry,
            **repairs,
            "path": str(path),
        },
        build_affected_album_dicts=lambda *_args, **_kwargs: [],
        load_separate_release_keys=lambda _config: set(),
        normalize_exception_value=lambda value: str(value or "").strip(),
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=fail_primary_log,
        structural_edit_fields={"album"},
        edit_write_workers=1,
        save_track_exception_override=lambda *_args: "",
        prevalidate_structural_tag_edit=lambda **_kwargs: None,
        prepare_tag_edit_intent=lambda **_kwargs: "intent-1",
        mark_tag_edit_files_verified=lambda _intent_id: (_ for _ in ()).throw(
            RuntimeError("checkpoint unavailable")
        ),
    )

    assert not isinstance(result, tuple), result
    assert result["ok"] is True
    assert logging_attempts == ["primary", "fallback"]
    assert media_album["value"] == ""
    assert len(queued) == 1
    assert queued[0]["tag_edit_intent_id"] == "intent-1"


def test_edit_tags_intent_persistence_failure_does_not_touch_media_or_exception(config):
    track_path = str((config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve())
    media_writes: list[object] = []

    result = handle_edit_tags_request(
        album={"name": "Album", "album_artist": "Artist", "tracks": [{"path": track_path}]},
        updates={track_path: {"title": "New Title", "exception_type": ""}},
        requested_track_paths={track_path},
        config=config,
        logger=_logger_stub(),
        get_state=lambda: {
            "file_cache": {
                track_path: {
                    "path": track_path,
                    "title": "Old Title",
                    "album": "Album",
                    "album_artist": "Artist",
                    "exception_type": "Non-album rarity",
                }
            },
            "separate_release_keys": set(),
        },
        create_save_task=lambda _kind: pytest.fail("failed intent created save task"),
        queue_finalize_save_task=lambda **_kwargs: pytest.fail("failed intent queued finalizer"),
        apply_repairs_worker=lambda *args: media_writes.append(args),
        update_cache_entry_after_repairs=lambda path, entry, repairs: {**entry, **repairs, "path": str(path)},
        build_affected_album_dicts=lambda *_args, **_kwargs: [],
        load_separate_release_keys=lambda _config: set(),
        normalize_exception_value=lambda value: str(value or "").strip(),
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        structural_edit_fields={"album", "exception_type"},
        edit_write_workers=1,
        save_track_exception_override=lambda *_args: pytest.fail("failed intent saved exception"),
        save_track_exception_overrides=lambda *_args: pytest.fail("failed intent saved exceptions"),
        prepare_tag_edit_intent=lambda **_kwargs: (_ for _ in ()).throw(
            RuntimeError("intent database unavailable")
        ),
        mark_tag_edit_files_verified=lambda _intent_id: None,
    )

    payload, status = result
    assert status == 500
    assert payload["ok"] is False
    assert "intent database unavailable" in payload["error"]
    assert media_writes == []


def _reservation_album_rename_kwargs(
    *,
    config,
    track_path: str,
    destination_album: str,
    get_state,
    apply_repairs_worker,
    queue_finalize_save_task,
    acquire_reservation,
    resource_keys: set[str],
):
    return {
        "album": {
            "key": "artist::old album",
            "name": "Old Album",
            "album_artist": "Artist",
            "tracks": [{"path": track_path}],
        },
        "updates": {track_path: {"album": destination_album}},
        "requested_track_paths": {track_path},
        "config": config,
        "logger": _logger_stub(),
        "get_state": get_state,
        "create_save_task": lambda _kind: f"task-{destination_album}",
        "queue_finalize_save_task": queue_finalize_save_task,
        "apply_repairs_worker": apply_repairs_worker,
        "update_cache_entry_after_repairs": (
            lambda path, entry, repairs: {
                **entry,
                **repairs,
                "path": str(path),
            }
        ),
        "build_affected_album_dicts": lambda *_args, **_kwargs: [],
        "load_separate_release_keys": lambda _config: set(),
        "normalize_exception_value": lambda value: str(value or "").strip(),
        "append_log_history": lambda *_args, **_kwargs: None,
        "log_app_event": lambda *_args, **_kwargs: None,
        "structural_edit_fields": {"album"},
        "edit_write_workers": 1,
        "save_track_exception_override": lambda *_args: "",
        "prevalidate_structural_tag_edit": lambda **_kwargs: None,
        "acquire_structural_tag_edit_reservation": acquire_reservation,
        "structural_tag_edit_resource_keys": set(resource_keys),
    }


def test_album_rename_acquires_reservation_before_state_read_and_media_write(
    config,
):
    track_path = str(
        (config["MUSIC_DIR"] / "Artist" / "Old Album" / "song.mp3").resolve()
    )
    resource_keys = {"album:artist::old album", f"path:{track_path}"}
    acquired = Event()
    queued_payloads: list[dict[str, object]] = []

    class Lease:
        released = False

        def release(self):
            self.released = True

    lease = Lease()

    def acquire(keys):
        assert keys == resource_keys
        acquired.set()
        return lease

    def get_state():
        assert acquired.is_set()
        return {
            "file_cache": {
                track_path: {
                    "path": track_path,
                    "album": "Old Album",
                    "album_artist": "Artist",
                    "title": "Song",
                }
            },
            "separate_release_keys": set(),
        }

    def apply_repairs(raw_path, repairs):
        assert acquired.is_set()
        return raw_path, True, list(repairs)

    result = handle_edit_tags_request(
        **_reservation_album_rename_kwargs(
            config=config,
            track_path=track_path,
            destination_album="New Album",
            get_state=get_state,
            apply_repairs_worker=apply_repairs,
            queue_finalize_save_task=lambda **kwargs: queued_payloads.append(
                dict(kwargs)
            ),
            acquire_reservation=acquire,
            resource_keys=resource_keys,
        )
    )

    assert result["ok"] is True
    assert queued_payloads[0]["structural_tag_edit_reservation"] is lease
    assert lease.released is False
    lease.release()


def test_waiting_album_rename_rereads_latest_state_before_writing_later_intent(
    config,
):
    from music_app.services import save_tasks as save_tasks_module

    track_path = str(
        (config["MUSIC_DIR"] / "Artist" / "Old Album" / "song.mp3").resolve()
    )
    resource_keys = save_tasks_module.structural_tag_edit_resource_keys(
        "artist::old album",
        {track_path},
    )
    state = {
        "file_cache": {
            track_path: {
                "path": track_path,
                "album": "Old Album",
                "album_artist": "Artist",
                "title": "Song",
            }
        },
        "separate_release_keys": set(),
    }
    first_queued = Event()
    second_started = Event()
    second_state_read = Event()
    second_completed = Event()
    first_queue_payload: dict[str, object] = {}
    second_queue_payload: dict[str, object] = {}
    physical_writes: list[str] = []

    def apply_repairs(raw_path, repairs):
        physical_writes.append(str(repairs["album"]))
        return raw_path, True, list(repairs)

    def first_queue(**kwargs):
        first_queue_payload.update(kwargs)
        first_queued.set()

    def second_get_state():
        second_state_read.set()
        return state

    def second_queue(**kwargs):
        second_queue_payload.update(kwargs)
        kwargs["structural_tag_edit_reservation"].release()

    first_result = handle_edit_tags_request(
        **_reservation_album_rename_kwargs(
            config=config,
            track_path=track_path,
            destination_album="First Rename",
            get_state=lambda: state,
            apply_repairs_worker=apply_repairs,
            queue_finalize_save_task=first_queue,
            acquire_reservation=(
                save_tasks_module.acquire_structural_tag_edit_reservation
            ),
            resource_keys=resource_keys,
        )
    )
    assert first_result["ok"] is True
    assert first_queued.is_set()

    def run_second_request():
        second_started.set()
        handle_edit_tags_request(
            **_reservation_album_rename_kwargs(
                config=config,
                track_path=track_path,
                destination_album="Second Rename",
                get_state=second_get_state,
                apply_repairs_worker=apply_repairs,
                queue_finalize_save_task=second_queue,
                acquire_reservation=(
                    save_tasks_module.acquire_structural_tag_edit_reservation
                ),
                resource_keys=resource_keys,
            )
        )
        second_completed.set()

    second_thread = Thread(target=run_second_request, daemon=True)
    second_thread.start()
    assert second_started.wait(timeout=1.0)
    assert second_state_read.wait(timeout=0.15) is False

    state["file_cache"][track_path] = {
        **state["file_cache"][track_path],
        "album": "First Rename",
    }
    first_queue_payload["structural_tag_edit_reservation"].release()

    assert second_completed.wait(timeout=1.0)
    second_thread.join(timeout=1.0)
    assert physical_writes == ["First Rename", "Second Rename"]
    assert second_queue_payload["previous_file_cache"][track_path]["album"] == (
        "First Rename"
    )


def test_album_rename_releases_reservation_when_physical_write_fails(config):
    track_path = str(
        (config["MUSIC_DIR"] / "Artist" / "Old Album" / "song.mp3").resolve()
    )

    class Lease:
        released = False

        def release(self):
            self.released = True

    lease = Lease()
    result = handle_edit_tags_request(
        **_reservation_album_rename_kwargs(
            config=config,
            track_path=track_path,
            destination_album="New Album",
            get_state=lambda: {
                "file_cache": {
                    track_path: {
                        "path": track_path,
                        "album": "Old Album",
                        "album_artist": "Artist",
                        "title": "Song",
                    }
                },
                "separate_release_keys": set(),
            },
            apply_repairs_worker=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                RuntimeError("media write failed")
            ),
            queue_finalize_save_task=lambda **_kwargs: None,
            acquire_reservation=lambda _keys: lease,
            resource_keys={"album:artist::old album", f"path:{track_path}"},
        )
    )

    assert result[1] == 500
    assert "media write failed" in result[0]["error"]
    assert lease.released is True


def test_album_rename_releases_reservation_when_finalizer_queue_raises(config):
    track_path = str(
        (config["MUSIC_DIR"] / "Artist" / "Old Album" / "song.mp3").resolve()
    )

    class Lease:
        released = False

        def release(self):
            self.released = True

    lease = Lease()
    with pytest.raises(RuntimeError, match="queue unavailable"):
        handle_edit_tags_request(
            **_reservation_album_rename_kwargs(
                config=config,
                track_path=track_path,
                destination_album="New Album",
                get_state=lambda: {
                    "file_cache": {
                        track_path: {
                            "path": track_path,
                            "album": "Old Album",
                            "album_artist": "Artist",
                            "title": "Song",
                        }
                    },
                    "separate_release_keys": set(),
                },
                apply_repairs_worker=(
                    lambda raw_path, repairs: (
                        raw_path,
                        True,
                        list(repairs),
                    )
                ),
                queue_finalize_save_task=lambda **_kwargs: (
                    _ for _ in ()
                ).throw(RuntimeError("queue unavailable")),
                acquire_reservation=lambda _keys: lease,
                resource_keys={
                    "album:artist::old album",
                    f"path:{track_path}",
                },
            )
        )

    assert lease.released is True


@pytest.mark.parametrize(
    ("failure", "expected_status"),
    [
        (StructuralTagEditDestinationConflict("destination exists"), 409),
        (RuntimeError("prevalidation failed"), 500),
    ],
)
def test_album_rename_releases_reservation_when_prevalidation_fails(
    config,
    failure,
    expected_status,
):
    track_path = str(
        (config["MUSIC_DIR"] / "Artist" / "Old Album" / "song.mp3").resolve()
    )

    class Lease:
        released = False

        def release(self):
            self.released = True

    lease = Lease()
    options = _reservation_album_rename_kwargs(
        config=config,
        track_path=track_path,
        destination_album="New Album",
        get_state=lambda: {
            "file_cache": {
                track_path: {
                    "path": track_path,
                    "album": "Old Album",
                    "album_artist": "Artist",
                    "title": "Song",
                }
            },
            "separate_release_keys": set(),
        },
        apply_repairs_worker=lambda *_args, **_kwargs: pytest.fail(
            "prevalidation must happen before physical writes"
        ),
        queue_finalize_save_task=lambda **_kwargs: pytest.fail(
            "prevalidation failure must not queue a finalizer"
        ),
        acquire_reservation=lambda _keys: lease,
        resource_keys={"album:artist::old album", f"path:{track_path}"},
    )
    options["prevalidate_structural_tag_edit"] = (
        lambda **_kwargs: (_ for _ in ()).throw(failure)
    )

    result = handle_edit_tags_request(**options)

    assert result[1] == expected_status
    assert lease.released is True


def test_album_rename_releases_reservation_when_no_changes_remain(config):
    track_path = str(
        (config["MUSIC_DIR"] / "Artist" / "Old Album" / "song.mp3").resolve()
    )

    class Lease:
        released = False

        def release(self):
            self.released = True

    lease = Lease()
    result = handle_edit_tags_request(
        **_reservation_album_rename_kwargs(
            config=config,
            track_path=track_path,
            destination_album="Old Album",
            get_state=lambda: {
                "file_cache": {
                    track_path: {
                        "path": track_path,
                        "album": "Old Album",
                        "album_artist": "Artist",
                        "title": "Song",
                    }
                },
                "separate_release_keys": set(),
            },
            apply_repairs_worker=lambda *_args, **_kwargs: pytest.fail(
                "no-op must not write media"
            ),
            queue_finalize_save_task=lambda **_kwargs: pytest.fail(
                "no-op must not queue a finalizer"
            ),
            acquire_reservation=lambda _keys: lease,
            resource_keys={"album:artist::old album", f"path:{track_path}"},
        )
    )

    assert result["changed_count"] == 0
    assert not result["save_task_id"]
    assert lease.released is True
