from __future__ import annotations

import asyncio
from concurrent.futures import Future
from pathlib import Path
from threading import Event, Thread
from types import SimpleNamespace

import pytest

from music_app.services import save_tasks as save_tasks_module
from music_app.services.save_tasks import (
    create_save_task,
    finalize_save_task,
    finalize_structural_tag_edit_save_task,
    queue_finalize_save_task,
    save_task_result,
)


def _explicit_config(tmp_path: Path) -> dict[str, object]:
    data_dir = (tmp_path / "data").resolve()
    music_dir = (tmp_path / "music").resolve()
    data_dir.mkdir()
    music_dir.mkdir()
    return {
        "CACHE_PATH": data_dir / "library_cache.json",
        "DATA_DIR": data_dir,
        "MUSIC_DIR": music_dir,
    }


def _logger_stub() -> SimpleNamespace:
    return SimpleNamespace(
        debug=lambda *args, **kwargs: None,
        error=lambda *args, **kwargs: None,
        exception=lambda *args, **kwargs: None,
        info=lambda *args, **kwargs: None,
        warning=lambda *args, **kwargs: None,
    )


def _durable_save_finalize_kwargs(
    tmp_path: Path,
    *,
    schedule_cache_updates_save,
) -> dict[str, object]:
    return {
        "config": _explicit_config(tmp_path),
        "logger": _logger_stub(),
        "get_state": lambda: {"albums": [], "file_cache": {}, "relation_views": {}},
        "rebuild_affected_albums_in_state": lambda *args, **kwargs: None,
        "build_relation_views": lambda albums, config: {},
        "schedule_cache_updates_save": schedule_cache_updates_save,
        "append_log_history": lambda config, entry: None,
        "log_app_event": lambda *args, **kwargs: None,
        "find_albums_by_track_paths": lambda track_paths: [],
        "find_problematic_album_by_track_paths": lambda track_paths: None,
        "updated_file_cache": {"track-1.mp3": {"path": "track-1.mp3", "album": "New Album"}},
        "previous_file_cache": {"track-1.mp3": {"path": "track-1.mp3", "album": "Old Album"}},
        "changed_paths": {"track-1.mp3"},
        "requested_track_paths": {"track-1.mp3"},
        "separate_release_keys": set(),
        "changed_field_names": {"album"},
        "structural_edit_fields": {"album"},
        "log_entry": {"action": "Album name tag changed"},
    }


def test_create_save_task_returns_pending_payload():
    task_id = create_save_task("repair-tags")

    payload = save_task_result(task_id)

    assert payload["id"] == task_id
    assert payload["kind"] == "repair-tags"
    assert payload["status"] == "pending"
    assert payload["created_at"]


def test_queue_finalize_save_task_can_complete_inline_before_return(tmp_path):
    task_id = create_save_task("edit-tags")
    observed: list[str] = []
    persistence = Future()
    persistence.set_result(
        {"relation_views": {}, "relations_last_built": 1.0}
    )

    queue_finalize_save_task(
        task_id=task_id,
        wait_for_completion=True,
        **_durable_save_finalize_kwargs(
            tmp_path,
            schedule_cache_updates_save=lambda *_args, **_kwargs: (
                observed.append("persisted") or persistence
            ),
        ),
    )

    assert observed == ["persisted"]
    assert save_task_result(task_id)["status"] == "completed"


def test_queue_finalize_save_task_inline_exposes_commit_failure_before_return(tmp_path):
    task_id = create_save_task("edit-tags")
    persistence = Future()
    persistence.set_exception(RuntimeError("postgres commit failed"))

    queue_finalize_save_task(
        task_id=task_id,
        wait_for_completion=True,
        **_durable_save_finalize_kwargs(
            tmp_path,
            schedule_cache_updates_save=lambda *_args, **_kwargs: persistence,
        ),
    )

    result = save_task_result(task_id)
    assert result["status"] == "failed"
    assert result["error"] == "postgres commit failed"


def test_finalize_save_task_records_rolled_back_intent_after_verified_compensation(
    tmp_path,
):
    task_id = create_save_task("edit-tags")
    persistence = Future()
    persistence.set_exception(RuntimeError("postgres commit failed"))
    outcomes: list[tuple[bool, str]] = []

    finalize_save_task(
        task_id,
        **_durable_save_finalize_kwargs(
            tmp_path,
            schedule_cache_updates_save=lambda *_args, **_kwargs: persistence,
        ),
        compensate_save_task=lambda **_kwargs: None,
        record_scoped_persistence_failure=(
            lambda compensation_succeeded, error: outcomes.append(
                (compensation_succeeded, str(error))
            )
        ),
    )

    assert outcomes == [(True, "postgres commit failed")]


def test_finalize_save_task_keeps_intent_recoverable_when_compensation_fails(
    tmp_path,
):
    task_id = create_save_task("edit-tags")
    persistence = Future()
    persistence.set_exception(RuntimeError("postgres commit failed"))
    outcomes: list[tuple[bool, str]] = []

    finalize_save_task(
        task_id,
        **_durable_save_finalize_kwargs(
            tmp_path,
            schedule_cache_updates_save=lambda *_args, **_kwargs: persistence,
        ),
        compensate_save_task=lambda **_kwargs: (_ for _ in ()).throw(
            RuntimeError("media rollback failed")
        ),
        record_scoped_persistence_failure=(
            lambda compensation_succeeded, error: outcomes.append(
                (compensation_succeeded, str(error))
            )
        ),
    )

    assert outcomes == [(False, "media rollback failed")]


def test_finalize_save_task_marks_task_completed(tmp_path, monkeypatch):
    config = _explicit_config(tmp_path)
    logger = _logger_stub()
    task_id = create_save_task("edit-tags")
    state_payload = {
        "albums": [{"key": "album-1"}],
        "file_cache": {},
        "relation_views": {"existing": True},
    }
    scheduled_payloads: list[tuple[object, dict[str, object]]] = []
    log_entries: list[dict[str, object]] = []
    rebuild_calls: list[tuple[set[str], set[str]]] = []
    legacy_relation_build_calls: list[list[object]] = []
    committed_relation_state = {
        "relation_views": {
            "artists": ["Canonical Artist"],
            "artists_sidebar": [{"artist": "Canonical Artist", "count": 1}],
            "family_to_artists": {},
            "folder_related": {"Canonical Artist": set()},
            "sidebar_families": [],
            "alias_to_canonical": {"Canonical Artist": "Canonical Artist"},
            "canonical_to_aliases": {"Canonical Artist": ["Canonical Artist"]},
        },
        "relations_last_built": 55.0,
    }
    persistence_future: Future[dict[str, object]] = Future()
    persistence_future.set_result(committed_relation_state)
    monkeypatch_payloads = []
    monkeypatch.setattr(
        save_tasks_module,
        "save_cache_to_disk_for_config",
        lambda config, cache_path, file_cache, root_identity, last_scan, **kwargs: monkeypatch_payloads.append(
            (config, cache_path, dict(file_cache), root_identity, last_scan, dict(kwargs))
        ),
    )
    monkeypatch.setattr(save_tasks_module, "library_root_cache_identity", lambda config: "identity-1")

    def schedule_save(cache_path, payload, _baseline):
        scheduled_payloads.append((cache_path, payload))
        return persistence_future

    def legacy_relation_builder(albums, _config):
        legacy_relation_build_calls.append(list(albums))
        raise AssertionError("canonical committed relation state must be installed directly")

    finalize_save_task(
        task_id,
        config=config,
        logger=logger,
        get_state=lambda: state_payload,
        rebuild_affected_albums_in_state=lambda st, previous_file_cache, updated_file_cache, changed_paths, separate_release_keys: rebuild_calls.append(
            (set(changed_paths), set(separate_release_keys))
        ),
        build_relation_views=legacy_relation_builder,
        schedule_cache_updates_save=schedule_save,
        append_log_history=lambda config, entry: log_entries.append(dict(entry)),
        log_app_event=lambda *args, **kwargs: None,
        find_albums_by_track_paths=lambda track_paths: [{"key": "album-1", "paths": sorted(track_paths)}],
        find_problematic_album_by_track_paths=lambda track_paths: {"key": "problem-1", "paths": sorted(track_paths)},
        updated_file_cache={
            "track-1.mp3": {"path": "track-1.mp3", "title": "Song"},
            "track-2.mp3": {"path": "track-2.mp3", "title": "Other"},
        },
        previous_file_cache={"track-1.mp3": {"path": "track-1.mp3", "title": "Old Song"}},
        changed_paths={"track-1.mp3"},
        requested_track_paths={"track-1.mp3"},
        separate_release_keys={"sep-1"},
        changed_field_names={"album_artist"},
        structural_edit_fields={"album_artist", "year"},
        log_entry={"action": "Library save completed", "artist": "Test Artist"},
    )

    payload = save_task_result(task_id)

    assert state_payload["file_cache"]["track-1.mp3"]["title"] == "Song"
    assert rebuild_calls == [({"track-1.mp3"}, {"sep-1"})]
    assert legacy_relation_build_calls == []
    assert state_payload["relation_views"] == committed_relation_state["relation_views"]
    assert state_payload["relations_last_built"] == 55.0
    assert scheduled_payloads == [
        (config["CACHE_PATH"], {"track-1.mp3": {"path": "track-1.mp3", "title": "Song"}}),
    ]
    assert log_entries == [{"action": "Library save completed", "artist": "Test Artist"}]
    assert payload["status"] == "completed"
    assert payload["requires_view_refresh"] is True
    assert payload["updated_albums"] == [{"key": "album-1", "paths": ["track-1.mp3"]}]
    assert payload["updated_problematic_album"] == {"key": "problem-1", "paths": ["track-1.mp3"]}
    assert payload["log_entry"] == {"action": "Library save completed", "artist": "Test Artist"}
    assert payload["completed_at"]


def test_finalize_save_task_merges_only_changed_entries_into_live_state(tmp_path):
    config = _explicit_config(tmp_path)
    logger = _logger_stub()
    task_id = create_save_task("edit-tags")
    state_payload = {
        "albums": [],
        "file_cache": {
            "selected.mp3": {"path": "selected.mp3", "title": "Old"},
            "concurrent.mp3": {"path": "concurrent.mp3", "title": "Concurrent"},
        },
        "relation_views": {},
    }
    rebuilt_caches = []

    finalize_save_task(
        task_id,
        config=config,
        logger=logger,
        get_state=lambda: state_payload,
        rebuild_affected_albums_in_state=lambda _st, _previous, updated, *_args: rebuilt_caches.append(
            dict(updated)
        ),
        build_relation_views=lambda albums, config: {},
        schedule_cache_updates_save=lambda cache_path, payload, _baseline: None,
        append_log_history=lambda config, entry: None,
        log_app_event=lambda *args, **kwargs: None,
        find_albums_by_track_paths=lambda track_paths: [],
        find_problematic_album_by_track_paths=lambda track_paths: None,
        updated_file_cache={
            "selected.mp3": {"path": "selected.mp3", "title": "New"},
        },
        previous_file_cache={
            "selected.mp3": {"path": "selected.mp3", "title": "Old"},
        },
        changed_paths={"selected.mp3"},
        requested_track_paths={"selected.mp3"},
        separate_release_keys=set(),
        changed_field_names={"exception_type"},
        structural_edit_fields={"exception_type"},
        log_entry={"action": "Library save completed"},
    )

    assert state_payload["file_cache"] == {
        "selected.mp3": {"path": "selected.mp3", "title": "New"},
        "concurrent.mp3": {"path": "concurrent.mp3", "title": "Concurrent"},
    }
    assert rebuilt_caches == [state_payload["file_cache"]]


def test_finalize_save_task_three_way_merges_changed_entry_with_live_cover(
    tmp_path,
):
    task_id = create_save_task("edit-tags")
    old_cover = "C:/Music/Artist/Album/old-cover.jpg"
    selected_cover = "C:/Music/Artist/Album/selected-cover.jpg"
    later_selected_cover = "C:/Music/Artist/Album/later-selected-cover.jpg"
    previous_entry = {
        "path": "selected.mp3",
        "title": "Old Title",
        "cover_path": old_cover,
        "cover_revision": "old-cover",
    }
    updated_entry = {
        **previous_entry,
        "title": "New Title",
    }
    state_payload = {
        "albums": [],
        "file_cache": {
            "selected.mp3": {
                **previous_entry,
                "cover_path": selected_cover,
                "cover_revision": "selected-cover",
            },
        },
        "relation_views": {},
    }
    scheduled_payloads: list[dict[str, dict[str, object]]] = []
    persisted_entries: list[dict[str, object]] = []

    def schedule_request_delta(_cache_path, payload, baseline):
        scheduled_payloads.append(
            {
                path: dict(entry)
                for path, entry in payload.items()
            }
        )
        latest_entry = {
            **state_payload["file_cache"]["selected.mp3"],
            "cover_path": later_selected_cover,
            "cover_revision": "later-selected-cover",
        }
        state_payload["file_cache"]["selected.mp3"] = dict(latest_entry)
        persisted_entries.append(
            save_tasks_module._rebase_non_cover_cache_entry_changes(
                baseline_file_cache=baseline,
                changed_entries=payload,
                latest_file_cache={"selected.mp3": latest_entry},
            )["selected.mp3"]
        )

    finalize_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: state_payload,
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: None,
        build_relation_views=lambda _albums, _config: {},
        schedule_cache_updates_save=schedule_request_delta,
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={"selected.mp3": updated_entry},
        previous_file_cache={"selected.mp3": previous_entry},
        changed_paths={"selected.mp3"},
        requested_track_paths={"selected.mp3"},
        separate_release_keys=set(),
        changed_field_names={"title"},
        structural_edit_fields={"album"},
        log_entry={"action": "Tags edited"},
    )

    assert save_task_result(task_id)["status"] == "completed"
    assert state_payload["file_cache"]["selected.mp3"] == {
        **updated_entry,
        "cover_path": later_selected_cover,
        "cover_revision": "later-selected-cover",
    }
    assert scheduled_payloads == [{"selected.mp3": updated_entry}]
    assert persisted_entries == [
        {
            **updated_entry,
            "cover_path": later_selected_cover,
            "cover_revision": "later-selected-cover",
        }
    ]


def test_finalize_relation_rebuild_preserves_cover_selected_after_initial_rebase(
    tmp_path,
    monkeypatch,
):
    task_id = create_save_task("edit-tags")
    track_path = "C:/Music/Kaipa/Kaipa/01 Musiken är ljuset.mp3"
    old_cover = "C:/Music/Kaipa/Kaipa/Art/Back.jpg"
    selected_cover = "C:/Music/Kaipa/Kaipa/cover.jpg"
    previous_entry = {
        "path": track_path,
        "album_artist": "Kaipa",
        "title": "Musiken är ljuset",
        "cover_path": old_cover,
        "cover_revision": "old-cover",
    }
    requested_entry = {
        **previous_entry,
        "album_artist": "Kaipa (Sweden)",
    }
    state_payload = {
        "albums": [],
        "file_cache": {track_path: dict(previous_entry)},
        "relation_views": {},
        "last_scan": 1.0,
    }
    durable_file_cache = {track_path: dict(previous_entry)}
    full_snapshot_publications: list[dict[str, dict[str, object]]] = []
    legacy_relation_build_calls: list[list[object]] = []
    committed_relation_state = {
        "relation_views": {
            "artists": ["Kaipa (Sweden)"],
            "artists_sidebar": [{"artist": "Kaipa (Sweden)", "count": 1}],
            "family_to_artists": {},
            "folder_related": {"Kaipa (Sweden)": set()},
            "sidebar_families": [],
            "alias_to_canonical": {"Kaipa (Sweden)": "Kaipa (Sweden)"},
            "canonical_to_aliases": {"Kaipa (Sweden)": ["Kaipa (Sweden)"]},
        },
        "relations_last_built": 55.0,
    }
    persistence_future: Future[dict[str, object]] = Future()
    persistence_future.set_result(committed_relation_state)

    def select_cover_during_relation_rebuild(*_args, **_kwargs):
        selected_entry = {
            **state_payload["file_cache"][track_path],
            "cover_path": selected_cover,
            "cover_revision": "selected-cover",
        }
        state_payload["file_cache"] = {
            **state_payload["file_cache"],
            track_path: dict(selected_entry),
        }
        durable_file_cache[track_path] = dict(selected_entry)

    def publish_full_snapshot(
        _config,
        _cache_path,
        file_cache,
        _root_identity,
        _last_scan,
        **_kwargs,
    ):
        full_snapshot_publications.append(
            {
                path: dict(entry)
                for path, entry in file_cache.items()
            }
        )
        durable_file_cache.clear()
        durable_file_cache.update(
            {
                path: dict(entry)
                for path, entry in file_cache.items()
            }
        )

    def publish_request_delta(_cache_path, payload, baseline):
        rebased = save_tasks_module._rebase_non_cover_cache_entry_changes(
            baseline_file_cache=baseline,
            changed_entries=payload,
            latest_file_cache=durable_file_cache,
        )
        durable_file_cache.clear()
        durable_file_cache.update(rebased)
        return persistence_future

    def legacy_relation_builder(albums, _config):
        legacy_relation_build_calls.append(list(albums))
        raise AssertionError("canonical committed relation state must be installed directly")

    monkeypatch.setattr(
        save_tasks_module,
        "save_cache_to_disk_for_config",
        publish_full_snapshot,
    )
    monkeypatch.setattr(
        save_tasks_module,
        "library_root_cache_identity",
        lambda _config: "root",
    )

    finalize_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: state_payload,
        rebuild_affected_albums_in_state=select_cover_during_relation_rebuild,
        build_relation_views=legacy_relation_builder,
        schedule_cache_updates_save=publish_request_delta,
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={track_path: requested_entry},
        previous_file_cache={track_path: previous_entry},
        changed_paths={track_path},
        requested_track_paths={track_path},
        separate_release_keys=set(),
        changed_field_names={"album_artist"},
        structural_edit_fields={"album_artist"},
        log_entry={"action": "Album artist edited"},
    )

    assert save_task_result(task_id)["status"] == "completed"
    assert legacy_relation_build_calls == []
    assert state_payload["relation_views"] == committed_relation_state["relation_views"]
    assert state_payload["relations_last_built"] == 55.0
    assert state_payload["file_cache"][track_path]["cover_path"] == selected_cover
    assert state_payload["file_cache"][track_path]["cover_revision"] == (
        "selected-cover"
    )
    assert all(
        snapshot[track_path]["cover_path"] == selected_cover
        and snapshot[track_path]["cover_revision"] == "selected-cover"
        for snapshot in full_snapshot_publications
    )
    assert durable_file_cache[track_path]["album_artist"] == "Kaipa (Sweden)"
    assert durable_file_cache[track_path]["cover_path"] == selected_cover
    assert durable_file_cache[track_path]["cover_revision"] == "selected-cover"


def test_finalize_save_task_preserves_cover_selected_after_live_snapshot(
    tmp_path,
):
    task_id = create_save_task("edit-tags")
    track_path = "C:/Music/Kaipa/Kaipa/01 Musiken är ljuset.mp3"
    old_cover = "C:/Music/Kaipa/Kaipa/Art/Back.jpg"
    selected_cover = "C:/Music/Kaipa/Kaipa/cover.jpg"
    previous_entry = {
        "path": track_path,
        "title": "Old Title",
        "cover_path": old_cover,
        "cover_revision": "old-cover",
    }
    requested_entry = {
        **previous_entry,
        "title": "Queued Title",
    }
    state_payload = {
        "albums": [],
        "file_cache": {track_path: dict(previous_entry)},
        "relation_views": {},
    }
    cover_selection_committed: list[bool] = []

    class SelectCoverAfterLiveSnapshot(dict):
        def get(self, key, default=None):
            if not cover_selection_committed:
                state_payload["file_cache"] = {
                    track_path: {
                        **state_payload["file_cache"][track_path],
                        "cover_path": selected_cover,
                        "cover_revision": "selected-cover",
                    }
                }
                cover_selection_committed.append(True)
            return super().get(key, default)

    finalize_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: state_payload,
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: None,
        build_relation_views=lambda _albums, _config: {},
        schedule_cache_updates_save=lambda *_args, **_kwargs: None,
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache=SelectCoverAfterLiveSnapshot(
            {track_path: requested_entry}
        ),
        previous_file_cache={track_path: previous_entry},
        changed_paths={track_path},
        requested_track_paths={track_path},
        separate_release_keys=set(),
        changed_field_names={"title"},
        structural_edit_fields={"album"},
        log_entry={"action": "Tags edited"},
    )

    assert cover_selection_committed == [True]
    assert save_task_result(task_id)["status"] == "completed"
    assert state_payload["file_cache"][track_path]["title"] == "Queued Title"
    assert state_payload["file_cache"][track_path]["cover_path"] == selected_cover
    assert state_payload["file_cache"][track_path]["cover_revision"] == (
        "selected-cover"
    )


def test_finalize_save_task_rejects_live_same_field_conflict_without_overwrite(
    tmp_path,
):
    task_id = create_save_task("edit-tags")
    previous_entry = {
        "path": "selected.mp3",
        "title": "Old Title",
    }
    live_entry = {
        "path": "selected.mp3",
        "title": "Concurrent Title",
    }
    state_payload = {
        "albums": [],
        "file_cache": {"selected.mp3": dict(live_entry)},
        "relation_views": {},
    }
    scheduled_payloads: list[object] = []

    finalize_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: state_payload,
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: None,
        build_relation_views=lambda _albums, _config: {},
        schedule_cache_updates_save=lambda *_args: scheduled_payloads.append(
            _args
        ),
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={
            "selected.mp3": {
                **previous_entry,
                "title": "Queued Title",
            }
        },
        previous_file_cache={"selected.mp3": previous_entry},
        changed_paths={"selected.mp3"},
        requested_track_paths={"selected.mp3"},
        separate_release_keys=set(),
        changed_field_names={"title"},
        structural_edit_fields={"album"},
        log_entry={"action": "Tags edited"},
    )

    payload = save_task_result(task_id)
    assert payload["status"] == "failed"
    assert "title" in payload["error"]
    assert state_payload["file_cache"]["selected.mp3"] == live_entry
    assert scheduled_payloads == []


def test_finalize_save_task_uses_direct_callbacks_without_framework_context(tmp_path):
    framework_symbols = ("current_app", "has_app_context", "Flask")
    config = _explicit_config(tmp_path)
    logger = _logger_stub()
    task_id = create_save_task("edit-tags")
    state_payload = {
        "albums": [{"key": "album-1"}],
        "file_cache": {},
        "relation_views": {"existing": True},
    }
    observed: dict[str, object] = {}
    legacy_relation_build_calls: list[list[object]] = []
    committed_relation_state = {
        "relation_views": {
            "artists": ["Canonical Artist"],
            "artists_sidebar": [{"artist": "Canonical Artist", "count": 1}],
            "family_to_artists": {},
            "folder_related": {"Canonical Artist": set()},
            "sidebar_families": [],
            "alias_to_canonical": {"Canonical Artist": "Canonical Artist"},
            "canonical_to_aliases": {"Canonical Artist": ["Canonical Artist"]},
        },
        "relations_last_built": 55.0,
    }
    persistence_future: Future[dict[str, object]] = Future()
    persistence_future.set_result(committed_relation_state)

    def legacy_relation_builder(albums, _config):
        legacy_relation_build_calls.append(list(albums))
        raise AssertionError("canonical committed relation state must be installed directly")

    finalize_save_task(
        task_id,
        config=config,
        logger=logger,
        get_state=lambda: state_payload,
        rebuild_affected_albums_in_state=lambda *args, **kwargs: observed.setdefault(
            "direct_callback_called",
            True,
        ),
        build_relation_views=legacy_relation_builder,
        schedule_cache_updates_save=lambda _cache_path, _payload, _baseline: persistence_future,
        append_log_history=lambda config, entry: None,
        log_app_event=lambda *args, **kwargs: None,
        find_albums_by_track_paths=lambda track_paths: [],
        find_problematic_album_by_track_paths=lambda track_paths: None,
        updated_file_cache={"track-1.mp3": {"path": "track-1.mp3", "title": "Song"}},
        previous_file_cache={},
        changed_paths={"track-1.mp3"},
        requested_track_paths={"track-1.mp3"},
        separate_release_keys=set(),
        changed_field_names={"title"},
        structural_edit_fields={"title"},
        log_entry={"action": "Library save completed"},
    )

    payload = save_task_result(task_id)

    for symbol in framework_symbols:
        assert not hasattr(save_tasks_module, symbol)
    assert observed["direct_callback_called"] is True
    assert legacy_relation_build_calls == []
    assert state_payload["relation_views"] == committed_relation_state["relation_views"]
    assert state_payload["relations_last_built"] == 55.0
    assert payload["status"] == "completed"


def test_finalize_save_task_keeps_non_structural_changes_without_view_refresh(tmp_path):
    config = _explicit_config(tmp_path)
    logger = _logger_stub()
    task_id = create_save_task("edit-tags")
    state_payload = {
        "albums": [{"key": "album-1"}],
        "file_cache": {},
        "relation_views": {"existing": True},
    }

    finalize_save_task(
        task_id,
        config=config,
        logger=logger,
        get_state=lambda: state_payload,
        rebuild_affected_albums_in_state=lambda *args, **kwargs: None,
        build_relation_views=lambda albums, config: {"rebuilt": True},
        schedule_cache_updates_save=lambda cache_path, payload, _baseline: None,
        append_log_history=lambda config, entry: None,
        log_app_event=lambda *args, **kwargs: None,
        find_albums_by_track_paths=lambda track_paths: [{"key": "album-1"}],
        find_problematic_album_by_track_paths=lambda track_paths: None,
        updated_file_cache={"track-1.mp3": {"path": "track-1.mp3", "title": "New Song"}},
        previous_file_cache={"track-1.mp3": {"path": "track-1.mp3", "title": "Old Song"}},
        changed_paths={"track-1.mp3"},
        requested_track_paths={"track-1.mp3"},
        separate_release_keys=set(),
        changed_field_names={"title"},
        structural_edit_fields={"album_artist", "year", "exception_type"},
        log_entry={"action": "Library save completed"},
    )

    payload = save_task_result(task_id)

    assert payload["status"] == "completed"
    assert payload["requires_view_refresh"] is False
    assert state_payload["relation_views"] == {"existing": True}


def test_finalize_save_task_installs_relation_views_from_single_guarded_save(
    tmp_path,
    monkeypatch,
):
    config = _explicit_config(tmp_path)
    logger = _logger_stub()
    task_id = create_save_task("edit-tags")
    state_payload = {
        "albums": [{"key": "album-1"}],
        "file_cache": {},
        "relation_views": {"existing": True},
        "last_scan": 44.0,
        "relations_last_built": 0.0,
    }
    committed_relation_state = {
        "relation_views": {
            "artists": ["Artist"],
            "folder_related": {},
            "family_to_artists": {},
            "sidebar_families": [],
        },
        "relations_last_built": 55.0,
    }
    persistence_future: Future[dict[str, object]] = Future()
    persistence_future.set_result(committed_relation_state)
    scheduled_saves: list[
        tuple[Path, dict[str, dict[str, object]], dict[str, dict[str, object]]]
    ] = []

    def schedule_guarded_save(cache_path, changed_entries, baseline):
        scheduled_saves.append(
            (
                cache_path,
                {path: dict(entry) for path, entry in changed_entries.items()},
                {path: dict(entry) for path, entry in baseline.items()},
            )
        )
        return persistence_future

    monkeypatch.setattr(
        save_tasks_module,
        "save_cache_to_disk_for_config",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("relation rebuild must not issue a second full snapshot")
        ),
    )

    finalize_save_task(
        task_id,
        config=config,
        logger=logger,
        get_state=lambda: state_payload,
        rebuild_affected_albums_in_state=lambda *args, **kwargs: None,
        build_relation_views=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("committed relation state must be installed directly")
        ),
        schedule_cache_updates_save=schedule_guarded_save,
        append_log_history=lambda config, entry: None,
        log_app_event=lambda *args, **kwargs: None,
        find_albums_by_track_paths=lambda track_paths: [],
        find_problematic_album_by_track_paths=lambda track_paths: None,
        updated_file_cache={"track-1.mp3": {"path": "track-1.mp3", "title": "Song"}},
        previous_file_cache={},
        changed_paths={"track-1.mp3"},
        requested_track_paths={"track-1.mp3"},
        separate_release_keys=set(),
        changed_field_names={"album_artist"},
        structural_edit_fields={"album_artist"},
        log_entry={"action": "Library save completed"},
    )

    assert scheduled_saves == [
        (
            config["CACHE_PATH"],
            {"track-1.mp3": {"path": "track-1.mp3", "title": "Song"}},
            {},
        )
    ]
    assert state_payload["relation_views"] == committed_relation_state["relation_views"]
    assert state_payload["relations_last_built"] == 55.0


def test_scoped_postgres_exception_finalizer_avoids_global_cache_publication(
    tmp_path,
    monkeypatch,
):
    config = _explicit_config(tmp_path)
    task_id = create_save_task("edit-tags")
    state_payload = {
        "albums": [{"key": "unrelated-album"}],
        "file_cache": {
            "unrelated.mp3": {
                "path": "unrelated.mp3",
                "title": "Unrelated",
            },
        },
        "relation_views": {"artists": ["Existing Artist"]},
        "relations_last_built": 42.0,
    }
    scheduled_payloads: list[dict[str, object]] = []
    full_publications: list[dict[str, object]] = []
    monkeypatch.setattr(
        save_tasks_module,
        "save_cache_to_disk_for_config",
        lambda _config, _cache_path, file_cache, *_args, **_kwargs: full_publications.append(
            dict(file_cache)
        ),
    )

    finalize_save_task(
        task_id,
        config=config,
        logger=_logger_stub(),
        get_state=lambda: state_payload,
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: (
            _ for _ in ()
        ).throw(
            AssertionError(
                "scoped Postgres exception edits must not rebuild albums "
                "from a partial cache"
            )
        ),
        build_relation_views=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError(
                "scoped Postgres exception edits must not rebuild global relation views"
            )
        ),
        schedule_cache_updates_save=lambda _cache_path, payload, _baseline: scheduled_payloads.append(
            dict(payload)
        ),
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: [
            {"key": "postgres-updated-album"}
        ],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={
            "selected.mp3": {
                "path": "selected.mp3",
                "title": "Selected",
                "exception_type": "Non-album rarity",
            },
        },
        previous_file_cache={
            "selected.mp3": {
                "path": "selected.mp3",
                "title": "Selected",
                "exception_type": "",
            },
        },
        changed_paths={"selected.mp3"},
        requested_track_paths={"selected.mp3"},
        separate_release_keys=set(),
        changed_field_names={"exception_type"},
        structural_edit_fields={"exception_type"},
        log_entry={"action": "Tags edited"},
        scoped_postgres_exception_only=True,
    )

    result = save_task_result(task_id)
    assert result["status"] == "completed"
    assert result["updated_albums"] == [{"key": "postgres-updated-album"}]
    assert full_publications == []
    assert state_payload["albums"] == [{"key": "unrelated-album"}]
    assert state_payload["relation_views"] == {"artists": ["Existing Artist"]}
    assert state_payload["relations_last_built"] == 42.0
    assert state_payload["file_cache"]["unrelated.mp3"]["title"] == "Unrelated"
    assert state_payload["file_cache"]["selected.mp3"]["exception_type"] == (
        "Non-album rarity"
    )
    assert scheduled_payloads == []


def test_scoped_postgres_exception_finalizer_normalizes_empty_live_value_during_rebase(
    tmp_path,
):
    task_id = create_save_task("edit-tags")
    track_path = "C:/Music/Artist/Album/normalized-rarity.mp3"
    unrelated_path = "C:/Music/Other Artist/Other Album/unrelated.mp3"
    state_payload = {
        "albums": [],
        "file_cache": {
            track_path: {
                "path": track_path,
                "exception_type": None,
            },
            unrelated_path: {
                "path": unrelated_path,
                "exception_type": None,
            },
        },
        "relation_views": {},
    }

    finalize_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: state_payload,
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: None,
        build_relation_views=lambda *_args, **_kwargs: {},
        schedule_cache_updates_save=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError(
                "already committed exception overrides must not use generic cache persistence"
            )
        ),
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={
            track_path: {
                "path": track_path,
                "exception_type": "Non-album rarity",
            }
        },
        previous_file_cache={
            track_path: {
                "path": track_path,
                "exception_type": "",
            }
        },
        changed_paths={track_path},
        requested_track_paths={track_path},
        separate_release_keys=set(),
        changed_field_names={"exception_type"},
        structural_edit_fields={"exception_type"},
        log_entry={"action": "Exception override edited"},
        scoped_postgres_exception_only=True,
    )

    payload = save_task_result(task_id)
    assert payload["status"] == "completed"
    assert "error" not in payload
    assert "warnings" not in payload
    assert state_payload["file_cache"][track_path]["exception_type"] == (
        "Non-album rarity"
    )
    assert state_payload["file_cache"][unrelated_path]["exception_type"] is None


def test_scoped_postgres_exception_finalizer_warns_on_selected_path_conflict(
    tmp_path,
):
    task_id = create_save_task("edit-tags")
    track_path = "C:/Music/Artist/Album/conflicting-rarity.mp3"
    state_payload = {
        "albums": [],
        "file_cache": {
            track_path: {
                "path": track_path,
                "exception_type": "Interview",
            }
        },
        "relation_views": {},
    }

    finalize_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: state_payload,
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: None,
        build_relation_views=lambda *_args, **_kwargs: {},
        schedule_cache_updates_save=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError(
                "already committed exception overrides must not use generic cache persistence"
            )
        ),
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={
            track_path: {
                "path": track_path,
                "exception_type": "Non-album rarity",
            }
        },
        previous_file_cache={
            track_path: {
                "path": track_path,
                "exception_type": "",
            }
        },
        changed_paths={track_path},
        requested_track_paths={track_path},
        separate_release_keys=set(),
        changed_field_names={"exception_type"},
        structural_edit_fields={"exception_type"},
        log_entry={"action": "Exception override edited"},
        scoped_postgres_exception_only=True,
    )

    payload = save_task_result(task_id)
    assert payload["status"] == "completed"
    assert "error" not in payload
    assert "exception_type" in " ".join(payload["warnings"])
    assert state_payload["file_cache"][track_path]["exception_type"] == "Interview"


def test_scoped_postgres_exception_finalizer_warns_when_runtime_invalidation_fails(
    tmp_path,
    monkeypatch,
):
    task_id = create_save_task("edit-tags")
    track_path = "C:/Music/Artist/Album/exception-only.mp3"
    state_payload = {
        "albums": [],
        "file_cache": {
            track_path: {
                "path": track_path,
                "exception_type": "",
            }
        },
        "relation_views": {},
    }
    monkeypatch.setattr(
        "music_app.services.problematic_albums.invalidate_problematic_albums_payload_cache",
        lambda _state: (_ for _ in ()).throw(
            RuntimeError("runtime invalidation unavailable")
        ),
    )

    finalize_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: state_payload,
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: None,
        build_relation_views=lambda *_args, **_kwargs: {},
        schedule_cache_updates_save=lambda *_args, **_kwargs: (
            _ for _ in ()
        ).throw(
            AssertionError(
                "already committed exception overrides must not use generic cache persistence"
            )
        ),
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={
            track_path: {
                "path": track_path,
                "exception_type": "Non-album rarity",
            }
        },
        previous_file_cache={
            track_path: {
                "path": track_path,
                "exception_type": "",
            }
        },
        changed_paths={track_path},
        requested_track_paths={track_path},
        separate_release_keys=set(),
        changed_field_names={"exception_type"},
        structural_edit_fields={"exception_type"},
        log_entry={"action": "Exception override edited"},
        scoped_postgres_exception_only=True,
    )

    payload = save_task_result(task_id)
    assert payload["status"] == "completed"
    assert "error" not in payload
    assert "runtime invalidation unavailable" in " ".join(
        payload["warnings"]
    ).lower()


def test_finalize_save_task_marks_task_failed_when_rebuild_raises(tmp_path):
    config = _explicit_config(tmp_path)
    logger = _logger_stub()
    task_id = create_save_task("repair-tags")

    finalize_save_task(
        task_id,
        config=config,
        logger=logger,
        get_state=lambda: {"albums": [], "file_cache": {}, "relation_views": {}},
        rebuild_affected_albums_in_state=lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("boom")),
        build_relation_views=lambda albums, config: {},
        schedule_cache_updates_save=lambda cache_path, payload, _baseline: None,
        append_log_history=lambda config, entry: None,
        log_app_event=lambda *args, **kwargs: None,
        find_albums_by_track_paths=lambda track_paths: [],
        find_problematic_album_by_track_paths=lambda track_paths: None,
        updated_file_cache={},
        previous_file_cache={},
        changed_paths=set(),
        requested_track_paths={"track-1.mp3"},
        separate_release_keys=set(),
        changed_field_names=set(),
        structural_edit_fields={"album_artist"},
        log_entry={"action": "Library save completed"},
    )

    payload = save_task_result(task_id)

    assert payload["status"] == "failed"
    assert payload["error"] == "boom"
    assert payload["completed_at"]


def test_finalize_save_task_waits_for_durable_cache_write_before_completing(tmp_path):
    task_id = create_save_task("edit-tags")
    durable_write: Future[None] = Future()
    write_scheduled = Event()
    history_entries: list[dict[str, object]] = []
    success_events: list[tuple[str, str]] = []

    def schedule_cache_updates_save(
        _cache_path,
        _changed_entries,
        _baseline_file_cache,
    ):
        write_scheduled.set()
        return durable_write

    finalize_kwargs = _durable_save_finalize_kwargs(
        tmp_path,
        schedule_cache_updates_save=schedule_cache_updates_save,
    )
    finalize_kwargs["append_log_history"] = (
        lambda _config, entry: history_entries.append(dict(entry))
    )
    finalize_kwargs["log_app_event"] = (
        lambda _config, _logger, message, *, level="info", **_fields: success_events.append(
            (str(message), str(level))
        )
    )
    finalizer = Thread(
        target=finalize_save_task,
        args=(task_id,),
        kwargs=finalize_kwargs,
        daemon=True,
    )
    finalizer.start()

    assert write_scheduled.wait(timeout=1.0)
    assert finalizer.is_alive()
    assert save_task_result(task_id)["status"] != "completed"
    assert history_entries == []
    assert success_events == []

    durable_write.set_result(None)
    finalizer.join(timeout=1.0)

    assert not finalizer.is_alive()
    assert save_task_result(task_id)["status"] == "completed"
    assert history_entries == [{"action": "Album name tag changed"}]
    assert success_events == [("Album name tag changed", "info")]


def test_finalize_save_task_fails_when_durable_cache_write_fails(tmp_path):
    task_id = create_save_task("edit-tags")
    durable_write: Future[None] = Future()
    durable_write.set_exception(RuntimeError("Postgres track-file metadata write failed"))

    finalize_save_task(
        task_id,
        **_durable_save_finalize_kwargs(
            tmp_path,
            schedule_cache_updates_save=lambda _cache_path, _changed_entries, _baseline: durable_write,
        ),
    )

    payload = save_task_result(task_id)

    assert payload["status"] == "failed"
    assert payload["error"] == "Postgres track-file metadata write failed"
    assert payload["completed_at"]


def test_finalize_save_task_reports_completed_with_warnings_after_durable_write(
    tmp_path,
):
    task_id = create_save_task("edit-tags")
    durable_write: Future[None] = Future()
    durable_write.set_result(None)

    finalize_kwargs = _durable_save_finalize_kwargs(
        tmp_path,
        schedule_cache_updates_save=lambda _cache_path, _changed_entries, _baseline: durable_write,
    )
    finalize_kwargs.update(
        append_log_history=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("history unavailable")
        ),
        log_app_event=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("event log unavailable")
        ),
        find_albums_by_track_paths=lambda _paths: (_ for _ in ()).throw(
            RuntimeError("album refresh unavailable")
        ),
        find_problematic_album_by_track_paths=lambda _paths: (_ for _ in ()).throw(
            RuntimeError("problematic refresh unavailable")
        ),
    )

    finalize_save_task(task_id, **finalize_kwargs)

    payload = save_task_result(task_id)
    assert payload["status"] == "completed"
    assert "error" not in payload
    warning_text = " ".join(payload["warnings"]).lower()
    assert "history unavailable" in warning_text
    assert "event log unavailable" in warning_text
    assert "album refresh unavailable" in warning_text
    assert "problematic refresh unavailable" in warning_text


def test_structural_tag_edit_save_task_completes_only_after_targeted_commit(tmp_path):
    task_id = create_save_task("edit-tags")
    state = {
        "albums": [],
        "file_cache": {
            "other.mp3": {"path": "other.mp3", "album": "Other Album"},
        },
    }
    events: list[str] = []

    def persist_structural_tag_edit(**kwargs):
        events.append("committed")
        assert save_task_result(task_id)["status"] != "completed"
        assert kwargs["changed_paths"] == {"track-1.mp3"}
        assert kwargs["changed_field_names"] == {"album"}
        return {"album_rows_updated": 1}

    def find_canonical_albums(_paths):
        events.append("canonical-albums")
        assert save_task_result(task_id)["status"] != "completed"
        return [{"key": "canonical-new-album", "name": "New Album"}]

    finalize_structural_tag_edit_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: state,
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: events.append(
            "memory-rebuilt"
        ),
        persist_structural_tag_edit=persist_structural_tag_edit,
        append_log_history=lambda _config, _entry: events.append("history"),
        log_app_event=lambda *_args, **_kwargs: events.append("event"),
        find_albums_by_track_paths=find_canonical_albums,
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={
            "track-1.mp3": {"path": "track-1.mp3", "album": "New Album"},
        },
        previous_file_cache={
            "track-1.mp3": {"path": "track-1.mp3", "album": "Old Album"},
        },
        changed_paths={"track-1.mp3"},
        requested_track_paths={"track-1.mp3"},
        separate_release_keys=set(),
        changed_field_names={"album"},
        structural_edit_fields={"album"},
        relation_projection_edit_fields={"album_artist", "artist"},
        log_entry={"action": "Tags edited"},
    )

    assert events.index("committed") < events.index("canonical-albums")
    assert state["file_cache"]["other.mp3"]["album"] == "Other Album"
    assert state["file_cache"]["track-1.mp3"]["album"] == "New Album"
    terminal_task = save_task_result(task_id)
    assert terminal_task["status"] == "completed"
    assert terminal_task["updated_albums"] == [
        {"key": "canonical-new-album", "name": "New Album"}
    ]
    assert "warnings" not in terminal_task


def test_structural_year_edit_publishes_committed_separate_release_key_before_rebuild(
    tmp_path,
):
    task_id = create_save_task("edit-tags")
    state = {
        "albums": [],
        "file_cache": {
            "track-1.mp3": {
                "path": "track-1.mp3",
                "album": "Year Split Album",
                "year": 2004,
            },
        },
        "separate_release_keys": set(),
    }
    rebuilt_keys: list[set[str]] = []
    release_key = "year split artist::year split album"

    def rebuild_with_committed_release_key(
        current_state,
        _previous,
        _current,
        _paths,
        separate_release_keys,
    ):
        assert current_state["separate_release_keys"] == {release_key}
        rebuilt_keys.append(set(separate_release_keys))

    finalize_structural_tag_edit_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: state,
        rebuild_affected_albums_in_state=rebuild_with_committed_release_key,
        persist_structural_tag_edit=lambda **_kwargs: {
            "album_rows_updated": 1,
            "separate_release_key": release_key,
        },
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={
            "track-1.mp3": {
                "path": "track-1.mp3",
                "album": "Year Split Album",
                "year": 2014,
            },
        },
        previous_file_cache={
            "track-1.mp3": {
                "path": "track-1.mp3",
                "album": "Year Split Album",
                "year": 2004,
            },
        },
        changed_paths={"track-1.mp3"},
        requested_track_paths={"track-1.mp3"},
        separate_release_keys=set(),
        changed_field_names={"year"},
        structural_edit_fields={"album", "year"},
        log_entry={"action": "Year edited"},
    )

    assert save_task_result(task_id)["status"] == "completed"
    assert state["separate_release_keys"] == {release_key}
    assert rebuilt_keys == [{release_key}]


def test_structural_tag_edit_runtime_refresh_preserves_cover_selected_after_commit(
    tmp_path,
):
    task_id = create_save_task("edit-tags")
    track_path = "C:/Music/Kaipa/Kaipa/01 Musiken är ljuset.mp3"
    old_cover = "C:/Music/Kaipa/Kaipa/Art/Back.jpg"
    selected_cover = "C:/Music/Kaipa/Kaipa/cover.jpg"
    previous_entry = {
        "path": track_path,
        "album": "Kaipa",
        "cover_path": old_cover,
        "cover_revision": "old-cover",
    }
    requested_entry = {
        **previous_entry,
        "album": "Kaipa Remastered",
    }
    state = {
        "albums": [],
        "file_cache": {track_path: dict(previous_entry)},
    }
    rebuilt_entries: list[dict[str, object]] = []

    def commit_then_select_cover(**_kwargs):
        state["file_cache"][track_path] = {
            **state["file_cache"][track_path],
            "cover_path": selected_cover,
            "cover_revision": "selected-cover",
        }
        return {"album_rows_updated": 1}

    finalize_structural_tag_edit_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: state,
        rebuild_affected_albums_in_state=(
            lambda _st, _previous, current, *_args: rebuilt_entries.append(
                dict(current[track_path])
            )
        ),
        persist_structural_tag_edit=commit_then_select_cover,
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={track_path: requested_entry},
        previous_file_cache={track_path: previous_entry},
        changed_paths={track_path},
        requested_track_paths={track_path},
        separate_release_keys=set(),
        changed_field_names={"album"},
        structural_edit_fields={"album"},
        log_entry={"action": "Album renamed"},
    )

    assert save_task_result(task_id)["status"] == "completed"
    assert state["file_cache"][track_path]["album"] == "Kaipa Remastered"
    assert state["file_cache"][track_path]["cover_path"] == selected_cover
    assert state["file_cache"][track_path]["cover_revision"] == "selected-cover"
    assert rebuilt_entries == [
        {
            **requested_entry,
            "cover_path": selected_cover,
            "cover_revision": "selected-cover",
        }
    ]


def test_structural_tag_edit_reports_auxiliary_warnings_after_canonical_commit(tmp_path):
    task_id = create_save_task("edit-tags")
    compensations: list[dict[str, object]] = []

    finalize_structural_tag_edit_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: {"albums": [], "file_cache": {}},
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: (
            _ for _ in ()
        ).throw(RuntimeError("memory refresh unavailable")),
        persist_structural_tag_edit=lambda **_kwargs: {"album_rows_updated": 1},
        compensate_structural_tag_edit=lambda **kwargs: compensations.append(
            dict(kwargs)
        ),
        append_log_history=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("history unavailable")
        ),
        log_app_event=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("event log unavailable")
        ),
        find_albums_by_track_paths=lambda _paths: [
            {"key": "canonical-new-album", "name": "New Album"}
        ],
        find_problematic_album_by_track_paths=lambda _paths: (_ for _ in ()).throw(
            RuntimeError("problematic refresh unavailable")
        ),
        updated_file_cache={
            "track-1.mp3": {"path": "track-1.mp3", "album": "New Album"},
        },
        previous_file_cache={
            "track-1.mp3": {"path": "track-1.mp3", "album": "Old Album"},
        },
        changed_paths={"track-1.mp3"},
        requested_track_paths={"track-1.mp3"},
        separate_release_keys=set(),
        changed_field_names={"album"},
        structural_edit_fields={"album"},
        log_entry={"action": "Tags edited"},
    )

    payload = save_task_result(task_id)
    assert payload["status"] == "completed"
    assert "error" not in payload
    warning_text = " ".join(payload["warnings"]).lower()
    assert "memory refresh unavailable" in warning_text
    assert "history unavailable" in warning_text
    assert "event log unavailable" in warning_text
    assert "problematic refresh unavailable" in warning_text
    assert payload["updated_albums"] == [
        {"key": "canonical-new-album", "name": "New Album"}
    ]
    assert compensations == []


def test_structural_tag_edit_canonical_reconciliation_error_cannot_publish_success(
    tmp_path,
):
    task_id = create_save_task("edit-tags")
    events: list[str] = []

    finalize_structural_tag_edit_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: {"albums": [], "file_cache": {}},
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: events.append(
            "memory-rebuilt"
        ),
        persist_structural_tag_edit=lambda **_kwargs: events.append("committed") or {
            "album_rows_updated": 1
        },
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: (_ for _ in ()).throw(
            RuntimeError("canonical album reconciliation unavailable")
        ),
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={
            "track-1.mp3": {"path": "track-1.mp3", "album": "New Album"},
        },
        previous_file_cache={
            "track-1.mp3": {"path": "track-1.mp3", "album": "Old Album"},
        },
        changed_paths={"track-1.mp3"},
        requested_track_paths={"track-1.mp3"},
        separate_release_keys=set(),
        changed_field_names={"album"},
        structural_edit_fields={"album"},
        log_entry={"action": "Tags edited"},
    )

    assert events == ["committed", "memory-rebuilt"]
    terminal_task = save_task_result(task_id)
    assert terminal_task["status"] == "failed"
    assert terminal_task["error"] == "canonical album reconciliation unavailable"
    assert terminal_task.get("updated_albums") in (None, [])


def test_structural_tag_edit_save_task_fails_without_publishing_memory_on_commit_error(
    tmp_path,
):
    task_id = create_save_task("edit-tags")
    state = {
        "albums": [],
        "file_cache": {
            "track-1.mp3": {"path": "track-1.mp3", "album": "Old Album"},
        },
    }
    events: list[str] = []
    history_entries: list[dict[str, object]] = []
    app_events: list[tuple[tuple[object, ...], dict[str, object]]] = []

    finalize_structural_tag_edit_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: state,
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: events.append(
            "memory-rebuilt"
        ),
        persist_structural_tag_edit=lambda **_kwargs: (_ for _ in ()).throw(
            RuntimeError("structural tag edit commit failed")
        ),
        append_log_history=lambda _config, entry: history_entries.append(dict(entry)),
        log_app_event=lambda *args, **kwargs: app_events.append((args, kwargs)),
        find_albums_by_track_paths=lambda _paths: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={
            "track-1.mp3": {"path": "track-1.mp3", "album": "New Album"},
        },
        previous_file_cache={
            "track-1.mp3": {"path": "track-1.mp3", "album": "Old Album"},
        },
        changed_paths={"track-1.mp3"},
        requested_track_paths={"track-1.mp3"},
        separate_release_keys=set(),
        changed_field_names={"album"},
        structural_edit_fields={"album"},
        log_entry={
            "action": "Tags edited",
            "artist": "Artist",
            "album": "Old Album",
            "file_count": 1,
            "files": ["track-1.mp3"],
        },
    )

    assert events == []
    assert state["file_cache"]["track-1.mp3"]["album"] == "Old Album"
    payload = save_task_result(task_id)
    assert payload["status"] == "failed"
    assert payload["error"] == "structural tag edit commit failed"
    failure_entry = payload["log_entry"]
    assert failure_entry["action"] == "Tag edit failed"
    assert failure_entry["artist"] == "Artist"
    assert failure_entry["album"] == "Old Album"
    assert failure_entry["files"] == ["track-1.mp3"]
    assert failure_entry["error"] == "structural tag edit commit failed"
    assert history_entries == [failure_entry]
    assert len(app_events) == 1
    assert app_events[0][0][2] == "Tag edit failed"
    assert app_events[0][1]["level"] == "error"


def test_structural_tag_edit_commit_failure_compensates_media_before_reporting_failure(
    tmp_path,
):
    task_id = create_save_task("edit-tags")
    compensations: list[dict[str, object]] = []
    outcomes: list[tuple[bool, str]] = []

    finalize_structural_tag_edit_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: {"albums": [], "file_cache": {}},
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: None,
        persist_structural_tag_edit=lambda **_kwargs: (_ for _ in ()).throw(
            RuntimeError("commit failed")
        ),
        compensate_structural_tag_edit=lambda **kwargs: compensations.append(
            dict(kwargs)
        ),
        record_scoped_persistence_failure=(
            lambda compensation_succeeded, error: outcomes.append(
                (compensation_succeeded, str(error))
            )
        ),
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={
            "track.mp3": {"path": "track.mp3", "album": "New Album"},
        },
        previous_file_cache={
            "track.mp3": {"path": "track.mp3", "album": "Old Album"},
        },
        changed_paths={"track.mp3"},
        requested_track_paths={"track.mp3"},
        separate_release_keys=set(),
        changed_field_names={"album"},
        structural_edit_fields={"album"},
        log_entry={"action": "Tags edited"},
    )

    assert compensations == [
        {
            "changed_paths": {"track.mp3"},
            "previous_file_entries": {
                "track.mp3": {"path": "track.mp3", "album": "Old Album"}
            },
            "updated_file_entries": {
                "track.mp3": {"path": "track.mp3", "album": "New Album"}
            },
            "changed_field_names": {"album"},
        }
    ]
    assert outcomes == [(True, "commit failed")]
    assert save_task_result(task_id)["status"] == "failed"


def test_structural_tag_edit_resource_keys_normalize_album_and_paths(
    tmp_path,
    monkeypatch,
):
    lower_track_path = (
        tmp_path / "Artist" / "Old Album" / ".." / "Old Album" / "song.mp3"
    )
    upper_track_path = (
        tmp_path / "Artist" / "Old Album" / ".." / "Old Album" / "SONG.mp3"
    )
    monkeypatch.setattr(save_tasks_module.os.path, "normcase", lambda value: value)

    keys = save_tasks_module.structural_tag_edit_resource_keys(
        " Artist::Old Album ",
        {str(lower_track_path), str(upper_track_path)},
    )

    assert keys == {
        "album:artist::old album",
        f"path:{str(lower_track_path.resolve(strict=False))}",
        f"path:{str(upper_track_path.resolve(strict=False))}",
    }


def test_structural_tag_edit_reservations_allow_disjoint_resources_to_overlap():
    first_lease = save_tasks_module.acquire_structural_tag_edit_reservation(
        {"album:artist::first", "path:first.mp3"}
    )
    second_acquired = Event()
    second_released = Event()

    def acquire_second():
        lease = save_tasks_module.acquire_structural_tag_edit_reservation(
            {"album:artist::second", "path:second.mp3"}
        )
        second_acquired.set()
        lease.release()
        second_released.set()

    second_thread = Thread(target=acquire_second, daemon=True)
    second_thread.start()
    try:
        assert second_acquired.wait(timeout=1.0)
        assert second_released.wait(timeout=1.0)
    finally:
        first_lease.release()
        second_thread.join(timeout=1.0)


def test_overlapping_structural_tag_edit_reservations_preserve_submission_order():
    blocker = save_tasks_module.acquire_structural_tag_edit_reservation(
        {"path:first.mp3"}
    )
    first_started = Event()
    first_acquired = Event()
    release_first = Event()
    second_started = Event()
    second_acquired = Event()
    acquisition_order: list[str] = []

    def acquire_first():
        first_started.set()
        lease = save_tasks_module.acquire_structural_tag_edit_reservation(
            {"path:first.mp3", "path:shared.mp3"}
        )
        acquisition_order.append("first")
        first_acquired.set()
        release_first.wait(timeout=2.0)
        lease.release()

    def acquire_second():
        second_started.set()
        lease = save_tasks_module.acquire_structural_tag_edit_reservation(
            {"path:shared.mp3", "path:second.mp3"}
        )
        acquisition_order.append("second")
        second_acquired.set()
        lease.release()

    first_thread = Thread(target=acquire_first, daemon=True)
    second_thread = Thread(target=acquire_second, daemon=True)
    first_thread.start()
    assert first_started.wait(timeout=1.0)
    second_thread.start()
    assert second_started.wait(timeout=1.0)
    assert second_acquired.wait(timeout=0.15) is False

    blocker.release()
    assert first_acquired.wait(timeout=1.0)
    assert second_acquired.wait(timeout=0.15) is False
    release_first.set()
    assert second_acquired.wait(timeout=1.0)
    first_thread.join(timeout=1.0)
    second_thread.join(timeout=1.0)
    assert acquisition_order == ["first", "second"]


def test_structural_tag_edit_reservation_is_held_through_commit_and_live_state(
    tmp_path,
):
    resource_keys = {"album:artist::old album", "path:track.mp3"}
    lease = save_tasks_module.acquire_structural_tag_edit_reservation(resource_keys)
    competitor_acquired = Event()
    competitor_release = Event()
    observed_stages: list[str] = []

    def compete_for_same_resources():
        competing_lease = (
            save_tasks_module.acquire_structural_tag_edit_reservation(resource_keys)
        )
        competitor_acquired.set()
        competitor_release.wait(timeout=2.0)
        competing_lease.release()

    competitor = Thread(target=compete_for_same_resources, daemon=True)
    competitor.start()

    def persist(**_kwargs):
        assert competitor_acquired.is_set() is False
        observed_stages.append("committed")
        return {"album_rows_updated": 1}

    def run_state_mutation(action):
        assert competitor_acquired.is_set() is False
        observed_stages.append("live-state-entered")
        result = action()
        assert competitor_acquired.is_set() is False
        observed_stages.append("live-state-finished")
        return result

    task_id = create_save_task("edit-tags")
    finalize_structural_tag_edit_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: {
            "albums": [],
            "file_cache": {
                "track.mp3": {
                    "path": "track.mp3",
                    "album": "Old Album",
                }
            },
        },
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: None,
        persist_structural_tag_edit=persist,
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={
            "track.mp3": {"path": "track.mp3", "album": "New Album"},
        },
        previous_file_cache={
            "track.mp3": {"path": "track.mp3", "album": "Old Album"},
        },
        changed_paths={"track.mp3"},
        requested_track_paths={"track.mp3"},
        separate_release_keys=set(),
        changed_field_names={"album"},
        structural_edit_fields={"album"},
        log_entry={"action": "Tags edited"},
        run_state_mutation=run_state_mutation,
        structural_tag_edit_reservation=lease,
    )

    try:
        assert observed_stages == [
            "committed",
            "live-state-entered",
            "live-state-finished",
        ]
        assert competitor_acquired.wait(timeout=1.0)
    finally:
        competitor_release.set()
        competitor.join(timeout=1.0)


def test_structural_tag_edit_reservation_is_released_when_commit_fails(tmp_path):
    resource_keys = {"album:artist::old album", "path:track.mp3"}
    lease = save_tasks_module.acquire_structural_tag_edit_reservation(resource_keys)
    task_id = create_save_task("edit-tags")

    finalize_structural_tag_edit_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: {"albums": [], "file_cache": {}},
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: None,
        persist_structural_tag_edit=lambda **_kwargs: (_ for _ in ()).throw(
            RuntimeError("commit failed")
        ),
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={
            "track.mp3": {"path": "track.mp3", "album": "New Album"},
        },
        previous_file_cache={
            "track.mp3": {"path": "track.mp3", "album": "Old Album"},
        },
        changed_paths={"track.mp3"},
        requested_track_paths={"track.mp3"},
        separate_release_keys=set(),
        changed_field_names={"album"},
        structural_edit_fields={"album"},
        log_entry={"action": "Tags edited"},
        structural_tag_edit_reservation=lease,
    )

    replacement_acquired = Event()

    def acquire_replacement():
        replacement = (
            save_tasks_module.acquire_structural_tag_edit_reservation(resource_keys)
        )
        replacement_acquired.set()
        replacement.release()

    replacement_thread = Thread(target=acquire_replacement, daemon=True)
    replacement_thread.start()
    assert replacement_acquired.wait(timeout=1.0)
    replacement_thread.join(timeout=1.0)
    assert save_task_result(task_id)["status"] == "failed"


def test_async_reservation_cancellation_preserves_fifo_and_releases_grant():
    manager = save_tasks_module.StructuralTagEditReservationManager()
    blocker = manager.acquire({"path:shared.mp3"})

    async def wait_until_waiting(count: int) -> None:
        for _attempt in range(100):
            if len(manager._waiting) >= count:
                return
            await asyncio.sleep(0.01)
        raise AssertionError(f"Expected {count} queued reservation waiters")

    async def scenario() -> None:
        first = asyncio.create_task(
            manager.acquire_async({"path:shared.mp3", "path:first.mp3"})
        )
        second = asyncio.create_task(
            manager.acquire_async({"path:shared.mp3", "path:second.mp3"})
        )
        await wait_until_waiting(2)

        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first

        blocker.release()
        second_lease = await asyncio.wait_for(second, timeout=1.0)
        second_lease.release()

        race_blocker = manager.acquire({"path:race.mp3"})
        racing = asyncio.create_task(manager.acquire_async({"path:race.mp3"}))
        await wait_until_waiting(1)
        race_blocker.release()
        racing.cancel()
        try:
            racing_lease = await racing
        except asyncio.CancelledError:
            pass
        else:
            racing_lease.release()

        replacement = await asyncio.wait_for(
            manager.acquire_async({"path:race.mp3"}),
            timeout=1.0,
        )
        replacement.release()

    try:
        asyncio.run(scenario())
    finally:
        blocker.release()


def test_regular_finalizer_holds_reservation_through_durable_and_live_state(
    tmp_path,
):
    stages: list[str] = []

    class Lease:
        released = False

        def release(self):
            assert stages == ["durable", "live-state"]
            self.released = True
            stages.append("released")

    lease = Lease()
    persistence_future: Future[None] = Future()
    persistence_future.set_result(None)
    task_id = create_save_task("edit-tags")

    def schedule(*_args):
        assert lease.released is False
        stages.append("durable")
        return persistence_future

    def mutate(action):
        assert lease.released is False
        result = action()
        assert lease.released is False
        stages.append("live-state")
        return result

    finalize_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: {
            "albums": [],
            "file_cache": {"track.mp3": {"path": "track.mp3", "title": "Old"}},
            "relation_views": {},
        },
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: None,
        build_relation_views=lambda *_args, **_kwargs: {},
        schedule_cache_updates_save=schedule,
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={"track.mp3": {"path": "track.mp3", "title": "New"}},
        previous_file_cache={"track.mp3": {"path": "track.mp3", "title": "Old"}},
        changed_paths={"track.mp3"},
        requested_track_paths={"track.mp3"},
        separate_release_keys=set(),
        changed_field_names={"title"},
        structural_edit_fields={"album"},
        log_entry={"action": "Tags edited"},
        run_state_mutation=mutate,
        structural_tag_edit_reservation=lease,
    )

    assert stages == ["durable", "live-state", "released"]
    assert save_task_result(task_id)["status"] == "completed"


def test_regular_finalizer_queue_failure_releases_reservation(
    monkeypatch,
):
    releases: list[str] = []
    lease = SimpleNamespace(release=lambda: releases.append("released"))
    monkeypatch.setattr(
        save_tasks_module._SAVE_TASK_EXECUTOR,
        "submit",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("queue unavailable")
        ),
    )

    with pytest.raises(RuntimeError, match="queue unavailable"):
        save_tasks_module.queue_finalize_save_task(
            structural_tag_edit_reservation=lease,
        )

    assert releases == ["released"]


def test_regular_finalizer_durable_failure_releases_reservation(tmp_path):
    releases: list[str] = []
    lease = SimpleNamespace(release=lambda: releases.append("released"))
    persistence_future: Future[None] = Future()
    persistence_future.set_exception(RuntimeError("database unavailable"))
    task_id = create_save_task("edit-tags")

    finalize_save_task(
        task_id,
        config=_explicit_config(tmp_path),
        logger=_logger_stub(),
        get_state=lambda: {
            "albums": [],
            "file_cache": {"track.mp3": {"path": "track.mp3", "title": "Old"}},
            "relation_views": {},
        },
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: None,
        build_relation_views=lambda *_args, **_kwargs: {},
        schedule_cache_updates_save=lambda *_args: persistence_future,
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={"track.mp3": {"path": "track.mp3", "title": "New"}},
        previous_file_cache={"track.mp3": {"path": "track.mp3", "title": "Old"}},
        changed_paths={"track.mp3"},
        requested_track_paths={"track.mp3"},
        separate_release_keys=set(),
        changed_field_names={"title"},
        structural_edit_fields={"album"},
        log_entry={"action": "Tags edited"},
        structural_tag_edit_reservation=lease,
    )

    assert releases == ["released"]
    assert save_task_result(task_id)["status"] == "failed"
