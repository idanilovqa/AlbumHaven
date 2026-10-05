"""Cover progress uses completed albums and includes preparation in elapsed time."""

from threading import RLock
from types import SimpleNamespace

import pytest

from music_app.services.cover_refresh_runtime import (
    build_cover_progress_status, _reset_cover_refresh_progress, execute_cover_refresh_request,
    _handle_cover_refresh_failure, cancel_cover_refresh,
)


def test_cover_progress_elapsed_includes_preparation_but_eta_uses_execution():
    status = build_cover_progress_status({
        "covers_in_progress": True,
        "covers_started_monotonic": 100.0,
        "covers_execution_started_monotonic": 160.0,
        "covers_processed": 25,
        "covers_total": 100,
    }, now=280.0)
    assert status["covers_elapsed_seconds"] == 180.0
    assert status["covers_estimated_remaining_seconds"] == 360.0


def test_cover_progress_unknown_timing_does_not_invent_eta():
    status = build_cover_progress_status({"covers_in_progress": True}, now=280.0)
    assert status["covers_elapsed_seconds"] is None
    assert status["covers_estimated_remaining_seconds"] is None


def test_new_run_discards_previous_run_timing():
    state = {"covers_execution_started_monotonic": 10.0, "covers_finished_monotonic": 20.0}
    _reset_cover_refresh_progress(state, in_progress=True)
    assert state["covers_started_monotonic"] > 0
    assert state["covers_execution_started_monotonic"] is None
    assert state["covers_finished_monotonic"] is None
    assert build_cover_progress_status(state)["covers_estimated_remaining_seconds"] is None
    assert build_cover_progress_status(state)["covers_phase"] == "preparing"


def test_finished_run_elapsed_is_frozen_and_has_no_active_eta():
    status = build_cover_progress_status({
        "covers_in_progress": False,
        "covers_started_monotonic": 100.0,
        "covers_execution_started_monotonic": 160.0,
        "covers_finished_monotonic": 280.0,
        "covers_processed": 25,
        "covers_total": 100,
    }, now=900.0)
    assert status["covers_elapsed_seconds"] == 180.0
    assert status["covers_estimated_remaining_seconds"] is None
    assert status["covers_phase"] == "finished"


@pytest.mark.parametrize("fails", [False, True])
def test_executor_terminal_paths_freeze_timing(fails):
    state = {"cover_generation": 1, "covers_started_monotonic": 1.0}
    context = SimpleNamespace(
        library_state=state, cover_generation=1, scan_generation=0,
        file_cache={}, separate_release_keys=set(), image_extensions=set(),
        user_agent="test", cover_cache=None,
    )

    def fail_executor(**kwargs):
        raise RuntimeError("executor failed")

    kwargs = dict(
        context=context, cache_lock=RLock(), jobs=[{}] if fails else [],
        run_cover_jobs=fail_executor, log_cover_refresh_completion=lambda **kwargs: None,
        config={}, logger=None, log_app_event=None, mode="manual-bulk",
        allow_apple_web_fallback=False, allow_apple_web_fallback_when_has_cover=False,
    )
    if fails:
        with pytest.raises(RuntimeError, match="executor failed"):
            execute_cover_refresh_request(**kwargs)
    else:
        execute_cover_refresh_request(**kwargs)
    assert state["covers_in_progress"] is False
    assert state["covers_finished_monotonic"] > 0
    assert state["covers_outcome"] == ("failed" if fails else "completed")
    assert build_cover_progress_status(state)["covers_estimated_remaining_seconds"] is None


def test_failure_preserves_completed_counters_and_reports_failed():
    state = {"covers_processed": 3, "covers_total": 10, "covers_downloaded": 2}
    _handle_cover_refresh_failure(state, RuntimeError("failed"))
    assert state["covers_processed"] == 3
    assert state["covers_total"] == 10
    assert state["covers_downloaded"] == 2
    assert build_cover_progress_status(state)["covers_outcome"] == "failed"


def test_cancellation_is_not_completion():
    state = {"covers_in_progress": True, "cover_generation": 1, "covers_processed": 3, "covers_total": 10}
    assert cancel_cover_refresh(lambda: state)
    assert state["covers_outcome"] == "cancelled"
    assert state["covers_processed"] == 3
