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
        report_admission_failure=lambda _root_ids: None,
    )
    event = _event()

    assert coordinator.accept(event) is True
    assert committed == [event]


def test_distinct_events_are_not_rejected_by_process_local_capacity():
    accepted = []
    coordinator = LibraryEventCoordinator(
        lambda event: accepted.append(event),
        record_problem=lambda _problem: None,
        report_admission_failure=lambda _root_ids: None,
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
        report_admission_failure=lambda _root_ids: None,
    )

    assert coordinator.accept(LibraryEvent(kind, "root-a", Path("C:/Music"))) is True
    assert accepted == []
    assert problems == [CoordinatorProblem(kind.value, "root-a")]


def test_admission_failure_propagates_without_reporting_success():
    def fail(_event):
        raise RuntimeError("database unavailable")

    coordinator = LibraryEventCoordinator(
        fail,
        record_problem=lambda _problem: None,
        report_admission_failure=lambda _root_ids: None,
    )

    with pytest.raises(RuntimeError, match="database unavailable"):
        coordinator.accept(_event())


def test_exact_admission_failure_reports_source_and_move_destination_then_reraises():
    reported = []
    coordinator = LibraryEventCoordinator(
        lambda _event: (_ for _ in ()).throw(
            RuntimeError("database unavailable")
        ),
        record_problem=lambda _problem: None,
        report_admission_failure=lambda root_ids: reported.append(root_ids),
    )
    event = LibraryEvent(
        LibraryEventKind.MOVED,
        "root-a",
        Path("C:/Music/A/old.flac"),
        destination=Path("D:/Music/B/new.flac"),
        destination_root_id="root-b",
    )

    with pytest.raises(RuntimeError, match="database unavailable"):
        coordinator.accept(event)

    assert reported == [("root-a", "root-b")]


def test_non_move_admission_failure_ignores_stray_destination_root_id():
    reported = []
    coordinator = LibraryEventCoordinator(
        lambda _event: (_ for _ in ()).throw(
            RuntimeError("database unavailable")
        ),
        record_problem=lambda _problem: None,
        report_admission_failure=reported.append,
    )
    event = LibraryEvent(
        LibraryEventKind.CREATED,
        "root-a",
        Path("C:/Music/A/new.flac"),
        destination_root_id="root-b",
    )

    with pytest.raises(RuntimeError, match="database unavailable"):
        coordinator.accept(event)

    assert reported == [("root-a",)]


def test_exact_reporter_failure_preserves_original_admission_exception_object():
    original = RuntimeError("database unavailable")
    reported = []

    def report(root_ids):
        reported.append(root_ids)
        raise LookupError("recovery reporter unavailable")

    coordinator = LibraryEventCoordinator(
        lambda _event: (_ for _ in ()).throw(original),
        record_problem=lambda _problem: None,
        report_admission_failure=report,
    )
    event = LibraryEvent(
        LibraryEventKind.MOVED,
        "root-a",
        Path("C:/Music/A/old.flac"),
        destination=Path("D:/Music/B/new.flac"),
        destination_root_id="root-b",
    )

    with pytest.raises(RuntimeError) as caught:
        coordinator.accept(event)

    assert caught.value is original
    assert reported == [("root-a", "root-b")]


def test_dirty_admission_failure_reports_one_root_then_reraises():
    reported = []
    coordinator = LibraryEventCoordinator(
        lambda _event: None,
        record_problem=lambda _problem: (_ for _ in ()).throw(
            RuntimeError("database unavailable")
        ),
        report_admission_failure=lambda root_ids: reported.append(root_ids),
    )

    with pytest.raises(RuntimeError, match="database unavailable"):
        coordinator.accept(
            LibraryEvent(
                LibraryEventKind.OVERFLOW,
                "root-a",
                Path("C:/Music/A"),
            )
        )

    assert reported == [("root-a",)]


def test_dirty_reporter_failure_preserves_original_problem_exception_object():
    original = RuntimeError("database unavailable")
    reported = []

    def report(root_ids):
        reported.append(root_ids)
        raise LookupError("recovery reporter unavailable")

    coordinator = LibraryEventCoordinator(
        lambda _event: None,
        record_problem=lambda _problem: (_ for _ in ()).throw(original),
        report_admission_failure=report,
    )

    with pytest.raises(RuntimeError) as caught:
        coordinator.accept(
            LibraryEvent(
                LibraryEventKind.ROOT_UNAVAILABLE,
                "root-a",
                Path("C:/Music/A"),
            )
        )

    assert caught.value is original
    assert reported == [("root-a",)]


def test_same_root_move_reports_one_logical_id():
    reported = []
    coordinator = LibraryEventCoordinator(
        lambda _event: (_ for _ in ()).throw(
            RuntimeError("database unavailable")
        ),
        record_problem=lambda _problem: None,
        report_admission_failure=lambda root_ids: reported.append(root_ids),
    )
    event = LibraryEvent(
        LibraryEventKind.MOVED,
        "root-a",
        Path("C:/Music/A/old.flac"),
        destination=Path("C:/Music/A/new.flac"),
        destination_root_id="root-a",
    )

    with pytest.raises(RuntimeError, match="database unavailable"):
        coordinator.accept(event)

    assert reported == [("root-a",)]


def test_coordinator_has_no_process_local_capacity_retry_or_suspension_controls():
    parameters = signature(LibraryEventCoordinator).parameters
    coordinator = LibraryEventCoordinator(
        lambda _event: None,
        record_problem=lambda _problem: None,
        report_admission_failure=lambda _root_ids: None,
    )

    assert set(parameters) == {
        "accept_event",
        "record_problem",
        "report_admission_failure",
    }
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
        report_admission_failure=lambda _root_ids: None,
    )

    assert coordinator.stop() is True
    assert coordinator.stop() is False
    assert coordinator.accept(_event()) is False
    assert accepted == []
