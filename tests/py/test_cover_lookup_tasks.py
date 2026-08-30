from __future__ import annotations

import json
from concurrent.futures import Future
from pathlib import Path
from threading import Event, Thread, current_thread

import pytest

from music_app.services.cover_lookup_jobs import build_cover_lookup_job_contract
from music_app.services.cover_lookup_tasks import (
    _merge_cover_lookup_task_with_notification,
    cancel_cover_lookup_task_payload,
    clear_completed_cover_lookup_tasks,
    create_cover_lookup_task,
    cover_lookup_result,
    finalize_cover_lookup_task_canceled,
    list_cover_lookup_tasks,
    mark_cover_lookup_task_notification_action_taken,
    reset_cover_lookup_runtime_state,
    update_cover_lookup_task,
)
from tests.py.runtime_testing import configure_test_app_paths


EXPECTED_ACTIVE_COVER_LOOKUP_MATCH_FIELDS = frozenset({
    "id",
    "source",
    "source_label",
    "lookup_group",
    "url",
    "thumbnail_url",
    "width",
    "height",
    "resolution",
    "area",
    "artist",
    "album",
    "year",
    "score",
    "album_url",
    "query_mode",
    "variant",
    "display_only",
    "art_kind",
    "art_label",
})
EXPECTED_MAX_ACTIVE_COVER_LOOKUP_STRING_CHARS = 2_048
EXPECTED_MAX_ACTIVE_COVER_LOOKUP_MATCHES_JSON_BYTES = 256 * 1_024


@pytest.fixture
def config(tmp_path, monkeypatch):
    paths = configure_test_app_paths(tmp_path, monkeypatch)
    paths["data_dir"].mkdir(parents=True, exist_ok=True)
    paths["music_dir"].mkdir(parents=True, exist_ok=True)
    return {
        "DATA_DIR": paths["data_dir"],
        "MUSIC_DIR": paths["music_dir"],
        "CACHE_PATH": paths["cache_path"],
        "COVER_CACHE_PATH": paths["cover_cache_path"],
        "LIBRARY_ROOTS_PATH": paths["library_roots_path"],
        "TESTING": True,
        "PERSISTENCE_BACKENDS": {"cover_lookup_tasks": "postgres"},
    }


@pytest.fixture(autouse=True)
def isolate_cover_lookup_runtime_state():
    reset_cover_lookup_runtime_state()
    yield
    reset_cover_lookup_runtime_state()


def test_cover_lookup_tasks_tests_do_not_use_flask_fixture_or_app_context():
    source = Path(__file__).read_text(encoding="utf-8")

    assert "tests.py." + "flask_fixtures" not in source
    assert "app." + "app_context(" not in source


def test_live_terminal_completion_beats_stale_persisted_running_timestamp():
    created_at = "2026-07-21T14:18:16.697629+00:00"
    finished_at = "2026-07-21T14:18:34.401339+00:00"

    merged = _merge_cover_lookup_task_with_notification(
        {
            "id": "transitioning-task",
            "status": "completed",
            "created_at": created_at,
            "finished_at": finished_at,
        },
        {
            "id": "transitioning-task",
            "status": "running",
            "created_at": created_at,
            "notification_completed_at": created_at,
        },
    )

    assert merged is not None
    assert merged["notification_completed_at"] == finished_at


def _album_payload(track_path: Path) -> dict[str, object]:
    return {
        "name": "Test Album",
        "album_artist": "Test Artist",
        "year": 2001,
        "edition": "",
        "tracks": [{"path": str(track_path)}],
    }


def _install_fake_notification_adapter(monkeypatch, config, initial_tasks=None):
    persisted_tasks = list(initial_tasks or [])

    class FakeAdapter:
        def __init__(self, _config):
            pass

        def load_notifications(self):
            return list(persisted_tasks)

        def save_notifications(self, tasks):
            persisted_tasks[:] = list(tasks)

    monkeypatch.setattr(
        "music_app.services.cover_lookup_notifications.CoverLookupTasksPostgresAdapter",
        FakeAdapter,
    )
    monkeypatch.setattr(
        "music_app.services.cover_lookup_notifications.select_runtime_persistence_adapter",
        lambda _seam_id, _config: type(
            "Selection",
            (),
            {"effective_backend": "postgres"},
        )(),
    )
    config["PERSISTENCE_BACKENDS"] = {"cover_lookup_tasks": "postgres"}
    return persisted_tasks


def test_cover_lookup_tasks_list_serializes_without_raw_bytes(config, monkeypatch):
    _install_fake_notification_adapter(monkeypatch, config)
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    reset_cover_lookup_runtime_state()
    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    update_cover_lookup_task(
        task_id,
        status="completed",
        finished_at="2026-05-18T00:00:00+00:00",
        possible_matches=[
            {
                "id": "candidate-1",
                "url": "https://images.example/cover.jpg",
                "prefetched_raw_bytes": b"skip-me",
            }
        ],
    )

    tasks = list_cover_lookup_tasks()

    assert [item["id"] for item in tasks] == [task_id]
    assert "prefetched_raw_bytes" not in json.dumps(tasks)


def test_terminal_task_serialization_sanitizes_without_truncating_final_matches(config, monkeypatch):
    _install_fake_notification_adapter(monkeypatch, config)
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    final_matches = [
        {
            "id": f"candidate-{index}",
            "url": f"https://images.example/{index}.jpg",
            "prefetched_raw_bytes": b"remove-me",
            **({
                "album": "Final Album " + ("x" * 5_000),
                "debug": {"raw_results": [{"name": "complete-terminal-detail"}]},
            } if index == 0 else {}),
        }
        for index in range(70)
    ]

    update_cover_lookup_task(
        task_id,
        config=config,
        status="completed",
        finished_at="2026-05-18T00:15:00+00:00",
        possible_matches=final_matches,
    )

    serialized = next(item for item in list_cover_lookup_tasks(config=config) if item["id"] == task_id)
    assert [match["id"] for match in serialized["possible_matches"]] == [
        f"candidate-{index}" for index in range(70)
    ]
    assert serialized["possible_matches"][0]["album"] == "Final Album " + ("x" * 5_000)
    assert serialized["possible_matches"][0]["debug"] == {
        "raw_results": [{"name": "complete-terminal-detail"}]
    }
    assert "prefetched_raw_bytes" not in json.dumps(serialized)


def test_running_task_serialization_bounds_and_deduplicates_partial_matches(config, monkeypatch):
    from music_app.services import cover_lookup_tasks as task_service

    _install_fake_notification_adapter(monkeypatch, config)
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    possible_matches = [
        {"id": "first", "url": "https://images.example/first.jpg"},
        {"id": "first", "url": "https://images.example/duplicate-id.jpg"},
        {"id": "duplicate-url", "url": "https://images.example/first.jpg"},
        *[
            {"id": f"candidate-{index}", "url": f"https://images.example/{index}.jpg"}
            for index in range(70)
        ],
    ]

    update_cover_lookup_task(
        task_id,
        config=config,
        status="running",
        possible_matches=possible_matches,
    )

    assert getattr(task_service, "MAX_ACTIVE_COVER_LOOKUP_MATCHES", None) == 64
    serialized = next(item for item in list_cover_lookup_tasks(config=config) if item["id"] == task_id)
    assert [match["id"] for match in serialized["possible_matches"]] == [
        "first",
        *[f"candidate-{index}" for index in range(63)],
    ]


def test_active_match_payload_is_allowlisted_and_bounded_by_bytes(config, monkeypatch):
    from music_app.services import cover_lookup_tasks as task_service

    assert getattr(task_service, "ACTIVE_COVER_LOOKUP_MATCH_FIELDS", None) == EXPECTED_ACTIVE_COVER_LOOKUP_MATCH_FIELDS
    assert (
        getattr(task_service, "MAX_ACTIVE_COVER_LOOKUP_STRING_CHARS", None)
        == EXPECTED_MAX_ACTIVE_COVER_LOOKUP_STRING_CHARS
    )
    assert (
        getattr(task_service, "MAX_ACTIVE_COVER_LOOKUP_MATCHES_JSON_BYTES", None)
        == EXPECTED_MAX_ACTIVE_COVER_LOOKUP_MATCHES_JSON_BYTES
    )
    persisted_tasks = _install_fake_notification_adapter(monkeypatch, config)
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    huge_text = "provider-detail-" + ("x" * 5_000)
    possible_matches = [
        {
            "id": f"candidate-{index}",
            "source": "discogs",
            "source_label": huge_text,
            "lookup_group": "discogs",
            "url": f"https://images.example/{index}.jpg",
            "thumbnail_url": f"https://images.example/{index}-thumb.jpg",
            "artist": huge_text,
            "album": huge_text,
            "year": 2001,
            "score": 0.9,
            "future_provider_payload": huge_text,
            "debug": {
                "raw_results": [
                    {"name": huge_text, "url": f"https://provider.example/{item_index}"}
                    for item_index in range(12)
                ],
                "probed_contenders": [
                    {"name": huge_text, "url": f"https://probe.example/{item_index}"}
                    for item_index in range(12)
                ],
                "nested_payload": {"body": huge_text},
            },
        }
        for index in range(64)
    ]

    update_cover_lookup_task(
        task_id,
        config=config,
        status="running",
        possible_matches=possible_matches,
    )

    listed_matches = list_cover_lookup_tasks(config=config)[0]["possible_matches"]
    persisted_matches = persisted_tasks[0]["possible_matches"]
    for bounded_matches in (listed_matches, persisted_matches):
        assert len(json.dumps(bounded_matches).encode("utf-8")) <= EXPECTED_MAX_ACTIVE_COVER_LOOKUP_MATCHES_JSON_BYTES
        assert all(set(match) <= EXPECTED_ACTIVE_COVER_LOOKUP_MATCH_FIELDS for match in bounded_matches)
        assert all(
            len(value) <= EXPECTED_MAX_ACTIVE_COVER_LOOKUP_STRING_CHARS
            for match in bounded_matches
            for value in match.values()
            if isinstance(value, str)
        )
        assert all("debug" not in match for match in bounded_matches)


def test_running_partial_snapshot_persists_and_supplements_matching_live_task(config, monkeypatch):
    persisted_tasks = _install_fake_notification_adapter(monkeypatch, config)
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})

    update_cover_lookup_task(
        task_id,
        config=config,
        status="running",
        progress=48,
        progress_label="Checking providers...",
        possible_matches=[{"id": "candidate-1", "url": "https://images.example/cover.jpg"}],
    )

    assert [task["id"] for task in persisted_tasks] == [task_id]
    assert persisted_tasks[0]["status"] == "running"
    assert persisted_tasks[0]["possible_matches"] == [
        {"id": "candidate-1", "url": "https://images.example/cover.jpg"}
    ]
    update_cover_lookup_task(
        task_id,
        status="running",
        progress=49,
        possible_matches=[{"id": "live-only", "url": "https://images.example/live.jpg"}],
    )
    assert cover_lookup_result(task_id)["possible_matches"] == [
        {"id": "live-only", "url": "https://images.example/live.jpg"}
    ]
    listed = list_cover_lookup_tasks(config=config)
    assert [task["id"] for task in listed] == [task_id]
    assert listed[0]["status"] == "running"
    assert listed[0]["progress"] == 49
    assert listed[0]["possible_matches"] == [
        {"id": "live-only", "url": "https://images.example/live.jpg"},
        {"id": "candidate-1", "url": "https://images.example/cover.jpg"}
    ]


def test_candidate_snapshot_diagnostic_preserves_task_candidates_and_notification(config, monkeypatch):
    persisted_tasks = _install_fake_notification_adapter(monkeypatch, config)
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})

    update_cover_lookup_task(
        task_id,
        config=config,
        status="running",
        possible_matches=[{
            "id": "candidate-1",
            "url": "https://images.example/cover.jpg",
        }],
        candidate_snapshot_diagnostic="durable_candidate_persistence_failed",
    )

    live_task = cover_lookup_result(task_id)
    listed_task = list_cover_lookup_tasks(config=config)[0]
    assert live_task["possible_matches"] == [{
        "id": "candidate-1",
        "url": "https://images.example/cover.jpg",
    }]
    assert listed_task["possible_matches"] == live_task["possible_matches"]
    assert listed_task["candidate_snapshot_diagnostic"] == (
        "durable_candidate_persistence_failed"
    )
    assert persisted_tasks[0]["candidate_snapshot_diagnostic"] == (
        "durable_candidate_persistence_failed"
    )


def test_older_running_persistence_cannot_overwrite_newer_completed_save(config, monkeypatch):
    from music_app.services import cover_lookup_tasks as task_service

    unrelated_task = {
        "id": "unrelated-completed-task",
        "status": "completed",
        "result_kind": "no-results",
        "finished_at": "2026-05-18T00:00:00+00:00",
    }
    persisted_tasks = [dict(unrelated_task)]
    older_load_entered = Event()
    release_older_save = Event()
    older_thread_errors: list[BaseException] = []

    def fake_load_notifications(_config):
        snapshot = [dict(task) for task in persisted_tasks]
        if current_thread().name == "older-running-persist":
            older_load_entered.set()
            if not release_older_save.wait(5):
                raise AssertionError("Timed out waiting to release the older persistence call")
        return snapshot

    def fake_save_notifications(_config, tasks):
        persisted_tasks[:] = [dict(task) for task in tasks]

    monkeypatch.setattr(task_service, "load_cover_lookup_notifications", fake_load_notifications)
    monkeypatch.setattr(task_service, "save_cover_lookup_notifications", fake_save_notifications)
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})

    def persist_older_running_snapshot():
        try:
            update_cover_lookup_task(
                task_id,
                config=config,
                status="running",
                progress=52,
                possible_matches=[{"id": "older-partial"}],
            )
        except BaseException as exc:  # pragma: no cover - asserted below
            older_thread_errors.append(exc)

    older_thread = Thread(
        target=persist_older_running_snapshot,
        name="older-running-persist",
    )
    older_thread.start()
    assert older_load_entered.wait(5)

    try:
        update_cover_lookup_task(
            task_id,
            config=config,
            job_contract=build_cover_lookup_job_contract("save_remote_selection"),
            status="completed",
            progress=100,
            finished_at="2026-05-18T00:01:00+00:00",
            result_kind="cover-updated",
            selected_candidate_id="selected-candidate",
            possible_matches=[{"id": "selected-candidate"}],
        )
    finally:
        release_older_save.set()
        older_thread.join(5)

    assert older_thread.is_alive() is False
    assert older_thread_errors == []
    live_task = cover_lookup_result(task_id)
    assert live_task["status"] == "completed"
    assert live_task["job_contract"]["job_kind"] == "save_remote_selection"
    assert live_task["result_kind"] == "cover-updated"
    persisted_by_id = {str(task["id"]): task for task in persisted_tasks}
    assert persisted_by_id[task_id]["status"] == "completed"
    assert persisted_by_id[task_id]["job_contract"]["job_kind"] == "save_remote_selection"
    assert persisted_by_id[task_id]["result_kind"] == "cover-updated"
    assert persisted_by_id["unrelated-completed-task"] == unrelated_task


def test_persisted_running_snapshot_does_not_reappear_after_runtime_reset(config, monkeypatch):
    _install_fake_notification_adapter(
        monkeypatch,
        config,
        initial_tasks=[{
            "id": "persisted-running-task",
            "status": "running",
            "progress": 48,
            "possible_matches": [{"id": "candidate-1", "url": "https://images.example/cover.jpg"}],
        }],
    )

    reset_cover_lookup_runtime_state()

    assert list_cover_lookup_tasks(config=config) == []


def test_candidate_lookup_finalizer_cannot_overwrite_successful_remote_save(config, monkeypatch):
    _install_fake_notification_adapter(monkeypatch, config)
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    update_cover_lookup_task(
        task_id,
        config=config,
        job_contract=build_cover_lookup_job_contract("save_remote_selection"),
        status="completed",
        result_kind="cover-updated",
        selected_candidate_id="candidate-1",
    )

    finalized = finalize_cover_lookup_task_canceled(task_id, config=config)

    assert finalized["status"] == "completed"
    assert finalized["job_contract"]["job_kind"] == "save_remote_selection"
    assert finalized["result_kind"] == "cover-updated"
    assert finalized["selected_candidate_id"] == "candidate-1"


def test_cleared_successful_save_cannot_be_resurrected_by_delayed_candidate_finalizer(
    config,
    monkeypatch,
):
    from music_app.services import cover_lookup_tasks as task_service

    persisted_tasks = _install_fake_notification_adapter(monkeypatch, config)
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    candidate_worker_waiting = Event()
    release_candidate_worker = Event()
    finalizer_results: list[dict[str, object]] = []
    candidate_future = Future()

    def finish_delayed_candidate_worker():
        candidate_worker_waiting.set()
        if not release_candidate_worker.wait(5):
            raise AssertionError("Timed out waiting to release delayed candidate worker")
        finalizer_results.append(finalize_cover_lookup_task_canceled(task_id, config=config))

    candidate_worker = Thread(target=finish_delayed_candidate_worker)
    candidate_worker.start()
    assert candidate_worker_waiting.wait(5)
    task_service.register_cover_lookup_future(task_id, candidate_future)

    update_cover_lookup_task(
        task_id,
        config=config,
        job_contract=build_cover_lookup_job_contract("save_remote_selection"),
        status="completed",
        result_kind="cover-updated",
        selected_candidate_id="candidate-1",
    )
    assert [task["id"] for task in persisted_tasks] == [task_id]

    try:
        assert clear_completed_cover_lookup_tasks([task_id], config=config) == 1
    finally:
        release_candidate_worker.set()
        candidate_worker.join(5)
        candidate_future.set_result(None)

    assert candidate_worker.is_alive() is False
    assert finalizer_results == [{}]
    assert cover_lookup_result(task_id) == {}
    assert persisted_tasks == []
    assert list_cover_lookup_tasks(config=config) == []


def test_cleared_task_reclaims_tombstone_and_persistence_lock_after_last_future_finishes(
    config,
    monkeypatch,
    tmp_path: Path,
):
    from music_app.services import cover_lookup_tasks as task_service

    config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/test"
    monkeypatch.setattr(task_service, "upsert_cover_lookup_notification", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        task_service,
        "delete_cover_lookup_notifications",
        lambda _config, task_ids: set(task_ids),
    )
    reset_cover_lookup_runtime_state()

    for index in range(3):
        track_path = tmp_path / f"album-{index}" / "song.mp3"
        track_path.parent.mkdir(parents=True, exist_ok=True)
        track_path.write_bytes(b"track")
        task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
        candidate_future = Future()
        save_future = Future()
        task_service.register_cover_lookup_future(task_id, candidate_future)
        task_service.register_cover_lookup_future(task_id, save_future)
        update_cover_lookup_task(task_id, config=config, status="completed")

        assert clear_completed_cover_lookup_tasks([task_id], config=config) == 1
        assert task_id in task_service._COVER_LOOKUP_TASK_REVISIONS
        assert task_id in task_service._COVER_LOOKUP_PERSISTENCE_LOCKS
        assert cover_lookup_result(task_id) == {}

        candidate_future.set_result(None)
        assert task_id in task_service._COVER_LOOKUP_TASK_REVISIONS
        assert task_id in task_service._COVER_LOOKUP_PERSISTENCE_LOCKS
        update_cover_lookup_task(task_id, config=config, status="completed", message="late candidate")
        assert cover_lookup_result(task_id) == {}

        save_future.set_result(None)
        assert task_id not in task_service._COVER_LOOKUP_TASK_REVISIONS
        assert task_id not in task_service._COVER_LOOKUP_PERSISTENCE_LOCKS

    assert task_service._COVER_LOOKUP_TASK_REVISIONS == {}
    assert task_service._COVER_LOOKUP_PERSISTENCE_LOCKS == {}


def test_terminal_internal_task_is_reclaimed_without_affecting_clear_counts(tmp_path):
    from music_app.services import cover_lookup_tasks as task_service

    track_path = tmp_path / "Artist" / "Album" / "song.flac"
    task_id, _cancel = task_service.create_cover_lookup_task(
        _album_payload(track_path),
        {str(track_path)},
        internal=True,
    )

    task_service.update_cover_lookup_task(
        task_id,
        status="completed",
        progress=100,
        finished_at="2026-08-04T00:00:00+00:00",
    )

    assert task_service.cover_lookup_result(task_id) == {}
    assert task_service.request_cover_lookup_task_stop(task_id) is False
    assert task_service.list_cover_lookup_tasks() == []
    assert task_service.clear_completed_cover_lookup_tasks() == 0


def test_late_candidate_worker_update_cannot_clobber_successful_remote_save(config, monkeypatch):
    _install_fake_notification_adapter(monkeypatch, config)
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    update_cover_lookup_task(
        task_id,
        config=config,
        job_contract=build_cover_lookup_job_contract("save_remote_selection"),
        status="completed",
        result_kind="cover-updated",
        selected_candidate_id="candidate-1",
        possible_matches=[{"id": "candidate-1"}],
    )

    update_cover_lookup_task(
        task_id,
        config=config,
        job_contract=build_cover_lookup_job_contract("candidate_lookup"),
        status="completed",
        result_kind="candidates-found",
        selected_candidate_id="",
        possible_matches=[{"id": "late-candidate"}],
    )

    task = cover_lookup_result(task_id)
    assert task["job_contract"]["job_kind"] == "save_remote_selection"
    assert task["status"] == "completed"
    assert task["result_kind"] == "cover-updated"
    assert task["selected_candidate_id"] == "candidate-1"
    assert task["possible_matches"] == [{"id": "candidate-1"}]


def test_terminal_update_without_config_updates_live_memory_only(config):
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    reset_cover_lookup_runtime_state()
    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})

    update_cover_lookup_task(
        task_id,
        status="completed",
        finished_at="2026-05-18T00:30:00+00:00",
    )

    assert cover_lookup_result(task_id)["status"] == "completed"
    reset_cover_lookup_runtime_state()
    assert list_cover_lookup_tasks() == []


def test_notification_persistence_uses_explicit_config_without_flask_context(config, monkeypatch):
    from music_app.services import cover_lookup_tasks as task_service

    persisted_tasks: list[dict[str, object]] = []
    seen_configs: list[object] = []

    def fake_load_notifications(config):
        seen_configs.append(config)
        return list(persisted_tasks)

    def fake_save_notifications(config, tasks):
        seen_configs.append(config)
        persisted_tasks[:] = list(tasks)

    monkeypatch.setattr(task_service, "load_cover_lookup_notifications", fake_load_notifications)
    monkeypatch.setattr(task_service, "save_cover_lookup_notifications", fake_save_notifications)
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    reset_cover_lookup_runtime_state()
    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    update_cover_lookup_task(
        task_id,
        status="failed",
        finished_at="2026-05-18T00:45:00+00:00",
        config=config,
    )
    reset_cover_lookup_runtime_state()

    listed = list_cover_lookup_tasks(config=config)
    marked = mark_cover_lookup_task_notification_action_taken(task_id, config=config)
    removed_count = clear_completed_cover_lookup_tasks([task_id], config=config)

    assert [item["id"] for item in listed] == [task_id]
    assert marked is not None
    assert marked["notification_action_taken"] is True
    assert removed_count == 1
    assert persisted_tasks == []
    assert seen_configs and set(map(id, seen_configs)) == {id(config)}


def test_cover_lookup_task_payload_exposes_portable_job_contract(config, monkeypatch):
    _install_fake_notification_adapter(monkeypatch, config)
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    reset_cover_lookup_runtime_state()
    task_id, _ = create_cover_lookup_task(
        _album_payload(track_path),
        {str(track_path)},
        manual_urls=[" https://images.example/manual.jpg "],
    )

    task = cover_lookup_result(task_id)
    serialized = list_cover_lookup_tasks()[0]

    expected_contract = {
        "schema_version": 1,
        "job_family": "cover_lookup",
        "job_kind": "candidate_lookup",
        "runtime_backend": "in_process_executor",
        "durability": "ephemeral",
        "provider_groups": [
            "music_services",
            "manual_urls",
            "bandcamp",
            "cover_art_archive",
            "discogs",
            "artist_website_fallback",
        ],
        "status_contract": {
            "task_id_field": "id",
            "status_field": "status",
            "cancel_requested_field": "cancel_requested",
        },
    }
    assert task["job_contract"] == expected_contract
    assert serialized["job_contract"] == expected_contract
    assert task["manual_urls"] == ["https://images.example/manual.jpg"]


def test_cover_lookup_tasks_notification_action_persists_after_runtime_reset(config, monkeypatch):
    persisted_tasks = _install_fake_notification_adapter(monkeypatch, config)
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    reset_cover_lookup_runtime_state()
    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    update_cover_lookup_task(
        task_id,
        config=config,
        status="failed",
        finished_at="2026-05-18T01:00:00+00:00",
    )
    reset_cover_lookup_runtime_state()

    marked = mark_cover_lookup_task_notification_action_taken(task_id, config=config)

    assert marked is not None
    assert marked["notification_action_taken"] is True
    assert persisted_tasks[0]["id"] == task_id
    assert persisted_tasks[0]["notification_action_taken"] is True


def test_cover_lookup_tasks_clear_completed_removes_persisted_notifications(config, monkeypatch):
    persisted_tasks = _install_fake_notification_adapter(monkeypatch, config)
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    reset_cover_lookup_runtime_state()
    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    update_cover_lookup_task(
        task_id,
        config=config,
        status="completed",
        finished_at="2026-05-18T02:00:00+00:00",
    )
    reset_cover_lookup_runtime_state()

    removed_count = clear_completed_cover_lookup_tasks([task_id], config=config)

    assert removed_count == 1
    assert persisted_tasks == []
    assert list_cover_lookup_tasks(config=config) == []


def test_cover_lookup_tasks_mark_action_taken_uses_postgres_selection_without_touching_file(
    config,
    monkeypatch,
):
    notifications_path = Path(config["DATA_DIR"]) / "cover_lookup_notifications.json"
    notifications_path.write_text(
        json.dumps({"tasks": [{"id": "stale-file-task", "status": "completed"}]}),
        encoding="utf-8",
    )
    persisted_tasks = [
        {
            "id": "postgres-task",
            "status": "completed",
            "finished_at": "2026-05-18T03:00:00+00:00",
        }
    ]

    class FakeAdapter:
        def __init__(self, _config):
            pass

        def load_notifications(self):
            return list(persisted_tasks)

        def save_notifications(self, tasks):
            persisted_tasks[:] = list(tasks)

    monkeypatch.setattr(
        "music_app.services.cover_lookup_notifications.CoverLookupTasksPostgresAdapter",
        FakeAdapter,
    )
    monkeypatch.setattr(
        "music_app.services.cover_lookup_notifications.select_runtime_persistence_adapter",
        lambda _seam_id, _config: type(
            "Selection",
            (),
            {"effective_backend": "postgres"},
        )(),
    )
    config["PERSISTENCE_BACKENDS"] = {"cover_lookup_tasks": "postgres"}

    reset_cover_lookup_runtime_state()
    marked = mark_cover_lookup_task_notification_action_taken("postgres-task", config=config)

    assert marked is not None
    assert marked["notification_action_taken"] is True
    assert persisted_tasks[0]["id"] == "postgres-task"
    assert persisted_tasks[0]["notification_action_taken"] is True
    assert json.loads(notifications_path.read_text(encoding="utf-8")) == {
        "tasks": [{"id": "stale-file-task", "status": "completed"}]
    }


def test_cover_lookup_tasks_clear_completed_uses_postgres_selection_without_touching_file(
    config,
    monkeypatch,
):
    notifications_path = Path(config["DATA_DIR"]) / "cover_lookup_notifications.json"
    notifications_path.write_text(
        json.dumps({"tasks": [{"id": "stale-file-task", "status": "completed"}]}),
        encoding="utf-8",
    )
    persisted_tasks = [
        {
            "id": "postgres-task",
            "status": "completed",
            "finished_at": "2026-05-18T04:00:00+00:00",
        }
    ]

    class FakeAdapter:
        def __init__(self, _config):
            pass

        def load_notifications(self):
            return list(persisted_tasks)

        def save_notifications(self, tasks):
            persisted_tasks[:] = list(tasks)

    monkeypatch.setattr(
        "music_app.services.cover_lookup_notifications.CoverLookupTasksPostgresAdapter",
        FakeAdapter,
    )
    monkeypatch.setattr(
        "music_app.services.cover_lookup_notifications.select_runtime_persistence_adapter",
        lambda _seam_id, _config: type(
            "Selection",
            (),
            {"effective_backend": "postgres"},
        )(),
    )
    config["PERSISTENCE_BACKENDS"] = {"cover_lookup_tasks": "postgres"}

    reset_cover_lookup_runtime_state()
    removed_count = clear_completed_cover_lookup_tasks(["postgres-task"], config=config)

    assert removed_count == 1
    assert persisted_tasks == []
    assert json.loads(notifications_path.read_text(encoding="utf-8")) == {
        "tasks": [{"id": "stale-file-task", "status": "completed"}]
    }


def test_cancel_cover_lookup_task_payload_marks_running_task_cancel_requested(config):
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    reset_cover_lookup_runtime_state()
    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    update_cover_lookup_task(
        task_id,
        status="running",
        progress=62,
        progress_label="Checking Bandcamp...",
        message="Still searching...",
    )

    payload = cancel_cover_lookup_task_payload(task_id)

    assert payload is not None
    assert payload["id"] == task_id
    assert payload["status"] == "running"
    assert payload["cancel_requested"] is True
    assert payload["progress_label"] == "Canceling..."
    assert payload["message"] == "Cancel requested. Finishing the current step..."


def test_cancel_running_cover_lookup_task_does_not_cancel_registered_future(config):
    from music_app.services import cover_lookup_tasks as task_service

    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    registered_future = Future()
    task_service.register_cover_lookup_future(task_id, registered_future)
    update_cover_lookup_task(task_id, status="running")

    payload = cancel_cover_lookup_task_payload(task_id)

    assert payload is not None
    assert payload["status"] == "running"
    assert registered_future.cancelled() is False


def test_canceled_task_rejects_late_provider_completion(config):
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    task_id, _ = create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    update_cover_lookup_task(task_id, status="canceled", progress=100, possible_matches=[])
    update_cover_lookup_task(
        task_id,
        status="completed",
        progress_label="Completed",
        possible_matches=[{"id": "late-apple-result"}],
    )

    payload = cover_lookup_result(task_id)
    assert payload["status"] == "canceled"
    assert payload["possible_matches"] == []
