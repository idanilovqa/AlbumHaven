from __future__ import annotations

from types import SimpleNamespace

from music_app.services.edit_tag_timings import EditTagTimingRecorder
from music_app.services.save_tasks import (
    create_save_task,
    finalize_structural_tag_edit_save_task,
    save_task_result,
)


class _FakeClock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


def test_edit_tag_timing_recorder_accumulates_repeated_phases():
    clock = _FakeClock()
    recorder = EditTagTimingRecorder("save-123", clock=clock)

    with recorder.measure("media_writes"):
        clock.advance(0.010)
    with recorder.measure("media_writes"):
        clock.advance(0.005)

    assert recorder.snapshot()["phase_timings_ms"] == {"media_writes": 15.0}


def test_edit_tag_timing_snapshot_never_contains_private_context():
    recorder = EditTagTimingRecorder("save-123")

    recorder.observe_pool_lease(
        "released",
        {
            "workload": "default",
            "wait_ms": 4.0,
            "held_ms": 8.0,
            "pool_size": 4,
            "pool_available": 3,
            "requests_waiting": 2,
            "private_path": r"D:\Music\Secret\01.mp3",
        },
    )

    snapshot = recorder.snapshot()
    assert snapshot["pool_lease_timings_ms"] == {
        "default": {"held_ms": 8.0, "wait_ms": 4.0},
    }
    assert snapshot["pool_lease_counts"] == {
        "default": {
            "acquired": 0,
            "pool_available_min": 3,
            "pool_size_max": 4,
            "released": 1,
            "requests_waiting_max": 2,
            "timeout": 0,
        },
    }
    assert "Secret" not in repr(snapshot)


def test_edit_tag_timing_recorder_preserves_zero_pool_available_minimum():
    recorder = EditTagTimingRecorder("save-123")

    recorder.observe_pool_lease(
        "acquired",
        {"workload": "default", "pool_available": 0},
    )
    recorder.observe_pool_lease(
        "released",
        {"workload": "default", "pool_available": 3},
    )

    assert recorder.snapshot()["pool_lease_counts"]["default"][
        "pool_available_min"
    ] == 0


def test_structural_save_task_publishes_recorder_snapshot_with_legacy_timings():
    task_id = create_save_task("edit-tags")
    recorder = EditTagTimingRecorder(task_id)
    recorder.record("reservation_wait", 1.0)
    recorder.observe_pool_lease(
        "released",
        {
            "workload": "default",
            "held_ms": 2.0,
            "wait_ms": 3.0,
            "pool_size": 4,
            "pool_available": 3,
            "requests_waiting": 0,
        },
    )

    finalize_structural_tag_edit_save_task(
        task_id,
        config={},
        logger=SimpleNamespace(exception=lambda *_args, **_kwargs: None),
        get_state=lambda: {"file_cache": {}},
        rebuild_affected_albums_in_state=lambda *_args, **_kwargs: None,
        persist_structural_tag_edit=lambda **_kwargs: {},
        append_log_history=lambda *_args, **_kwargs: None,
        log_app_event=lambda *_args, **_kwargs: None,
        find_albums_by_track_paths=lambda _paths: [],
        find_problematic_album_by_track_paths=lambda _paths: None,
        updated_file_cache={},
        previous_file_cache={},
        changed_paths=set(),
        requested_track_paths=set(),
        separate_release_keys=set(),
        changed_field_names=set(),
        structural_edit_fields=set(),
        log_entry={},
        timing_recorder=recorder,
    )

    task = save_task_result(task_id)
    assert task["operation_id"] == task_id
    assert task["phase_timings_ms"]["reservation_wait"] == 1.0
    assert task["phase_timings_ms"]["postgres_commit"] >= 0
    assert task["pool_lease_timings_ms"]["default"] == {
        "held_ms": 2.0,
        "wait_ms": 3.0,
    }
    assert task["pool_lease_counts"]["default"]["released"] == 1
    assert task["timings"]["postgres_ms"] >= 0
    assert task["timings"]["finalization_ms"] >= 0
