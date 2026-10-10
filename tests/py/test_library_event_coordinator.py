from inspect import signature
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


def test_storage_failure_is_not_replayed_by_a_later_admission():
    available = False
    accepted = []
    durable_problems = []

    def accept_event(event):
        if not available:
            raise RuntimeError("database unavailable")
        accepted.append(event)

    coordinator = LibraryEventCoordinator(
        accept_event,
        record_problem=durable_problems.append,
    )

    with pytest.raises(RuntimeError, match="database unavailable"):
        coordinator.accept(_event())

    available = True
    later = _event(1)
    assert coordinator.accept(later) is True
    assert accepted == [later]
    assert durable_problems == []


def test_coordinator_has_no_process_local_capacity_retry_or_suspension_controls():
    parameters = signature(LibraryEventCoordinator).parameters
    coordinator = LibraryEventCoordinator(
        lambda _event: None,
        record_problem=lambda _problem: None,
    )

    assert set(parameters) == {"accept_event", "record_problem"}
    assert {
        "_pending",
        "_pending_problems",
        "_pending_entry_count",
        "_retry_pending",
        "_retry_timer",
        "_retry_timer_factory",
        "_retry_delay_seconds",
        "max_pending_groups",
        "suspend_targeted_reconciliation",
        "resume_targeted_reconciliation",
    }.isdisjoint(vars(coordinator))
    assert not hasattr(coordinator, "suspend_targeted_reconciliation")
    assert not hasattr(coordinator, "resume_targeted_reconciliation")


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
