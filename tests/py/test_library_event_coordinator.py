from pathlib import Path

import pytest

from music_app.services.library_event_coordinator import (
    CoordinatorProblem,
    LibraryEventCoordinator,
)
from music_app.services.library_watch import LibraryEvent, LibraryEventKind


def _event(index: int = 0) -> LibraryEvent:
    return LibraryEvent(
        LibraryEventKind.CREATED,
        "root-a",
        Path(f"C:/Music/{index}.flac"),
    )


def test_accept_returns_only_after_durable_commit():
    committed = []
    coordinator = LibraryEventCoordinator(
        lambda event: committed.append(event),
        record_problem=lambda _problem: None,
    )
    event = _event()

    assert coordinator.accept(event) is True
    assert committed == [event]


def test_distinct_events_are_not_rejected_by_process_local_capacity():
    accepted = []
    coordinator = LibraryEventCoordinator(
        lambda event: accepted.append(event),
        record_problem=lambda _problem: None,
    )

    assert all(coordinator.accept(_event(index)) for index in range(4097))
    assert len(accepted) == 4097


@pytest.mark.parametrize(
    "kind",
    [LibraryEventKind.OVERFLOW, LibraryEventKind.ROOT_UNAVAILABLE],
)
def test_health_event_records_problem_without_exact_admission(kind):
    accepted, problems = [], []
    coordinator = LibraryEventCoordinator(
        accepted.append,
        record_problem=problems.append,
    )

    assert coordinator.accept(LibraryEvent(kind, "root-a", Path("C:/Music"))) is True
    assert accepted == []
    assert problems == [CoordinatorProblem(kind.value, "root-a")]


def test_admission_failure_propagates_without_reporting_success():
    def fail(_event):
        raise RuntimeError("database unavailable")

    coordinator = LibraryEventCoordinator(fail, record_problem=lambda _problem: None)

    with pytest.raises(RuntimeError, match="database unavailable"):
        coordinator.accept(_event())


@pytest.mark.parametrize("failure", ["admission", "mark_dirty"])
def test_database_outage_retries_root_dirty_after_storage_recovers(failure):
    available = False
    durable_problems = []
    scheduled = []

    class Timer:
        daemon = False

        def __init__(self, _delay, callback):
            self.callback = callback

        def start(self):
            scheduled.append(self)

        def cancel(self):
            pass

    def accept_event(_event):
        if failure == "admission" and not available:
            raise RuntimeError("database unavailable")

    def record_problem(problem):
        if not available:
            raise RuntimeError("database unavailable")
        durable_problems.append(problem)

    coordinator = LibraryEventCoordinator(
        accept_event,
        record_problem=record_problem,
        retry_timer_factory=Timer,
    )
    event = (
        _event()
        if failure == "admission"
        else LibraryEvent(
            LibraryEventKind.ROOT_UNAVAILABLE,
            "root-a",
            Path("C:/Music"),
        )
    )

    with pytest.raises(RuntimeError, match="database unavailable"):
        coordinator.accept(event)
    assert len(scheduled) == 1

    available = True
    scheduled.pop().callback()

    assert durable_problems == [CoordinatorProblem("root_unavailable", "root-a")]


def test_stop_is_idempotent_and_rejects_later_events():
    accepted = []
    coordinator = LibraryEventCoordinator(
        accepted.append,
        record_problem=lambda _problem: None,
    )

    assert coordinator.stop() is True
    assert coordinator.stop() is False
    assert coordinator.accept(_event()) is False
    assert accepted == []


def test_cancelled_retry_callback_does_not_write_after_stop():
    available = False
    durable_problems = []
    scheduled = []

    class Timer:
        daemon = False

        def __init__(self, _delay, callback):
            self.callback = callback

        def start(self):
            scheduled.append(self)

        def cancel(self):
            pass

    def record_problem(problem):
        if not available:
            raise RuntimeError("database unavailable")
        durable_problems.append(problem)

    coordinator = LibraryEventCoordinator(
        lambda _event: None,
        record_problem=record_problem,
        retry_timer_factory=Timer,
    )
    event = LibraryEvent(
        LibraryEventKind.ROOT_UNAVAILABLE,
        "root-a",
        Path("C:/Music"),
    )

    with pytest.raises(RuntimeError, match="database unavailable"):
        coordinator.accept(event)
    timer = scheduled.pop()
    coordinator.stop()
    available = True

    timer.callback()

    assert durable_problems == []
