from __future__ import annotations

from pathlib import Path
from threading import Event, Lock, Thread
from time import monotonic

from music_app.services.library_event_coordinator import (
    CoordinatorProblem,
    TargetedReconciliationRequest,
)
from music_app.services.targeted_reconciliation_scheduler import (
    TargetedReconciliationScheduler,
)


def _request(root_id: str, *paths: str) -> TargetedReconciliationRequest:
    return TargetedReconciliationRequest(
        root_id=root_id,
        paths=frozenset(Path(path) for path in paths),
    )

def test_burst_beyond_legacy_256_job_limit_is_admitted_without_losing_paths():
    started = Event()
    release = Event()
    reconciled: list[TargetedReconciliationRequest] = []

    def reconcile(request: TargetedReconciliationRequest) -> None:
        if not started.is_set():
            started.set()
            assert release.wait(2)
        reconciled.append(request)

    scheduler = TargetedReconciliationScheduler(
        reconcile=reconcile,
        catch_up=lambda _root_ids: None,
        record_problem=lambda _problem: None,
        clear_recovered=lambda _root_ids: None,
        max_pending_roots=256,
    )
    try:
        assert scheduler.submit(_request("main", "C:/Music/seed.flac"))
        assert started.wait(2)
        expected = {Path(f"C:/Music/Album/{index:03}.flac") for index in range(300)}
        for path in expected:
            assert scheduler.submit(
                TargetedReconciliationRequest("main", paths=frozenset({path}))
            )

        release.set()
        assert scheduler.wait_for_idle(timeout=2)
    finally:
        release.set()
        scheduler.shutdown(wait=True, timeout=2)

    observed = set().union(*(request.paths for request in reconciled))
    assert observed == expected | {Path("C:/Music/seed.flac")}
    assert len(reconciled) <= 2, "same-root burst should collapse into one pending job"


def test_duplicate_pending_paths_are_coalesced_before_reconciliation():
    started = Event()
    release = Event()
    reconciled: list[TargetedReconciliationRequest] = []

    def reconcile(request: TargetedReconciliationRequest) -> None:
        if not started.is_set():
            started.set()
            assert release.wait(2)
        reconciled.append(request)

    scheduler = TargetedReconciliationScheduler(
        reconcile=reconcile,
        catch_up=lambda _root_ids: None,
        record_problem=lambda _problem: None,
        clear_recovered=lambda _root_ids: None,
    )
    repeated = _request("main", "C:/Music/Artist/Album/01.flac")
    try:
        assert scheduler.submit(_request("main", "C:/Music/seed.flac"))
        assert started.wait(2)
        for _ in range(400):
            assert scheduler.submit(repeated)

        release.set()
        assert scheduler.wait_for_idle(timeout=2)
    finally:
        release.set()
        scheduler.shutdown(wait=True, timeout=2)

    duplicate_jobs = [request for request in reconciled if repeated.paths <= request.paths]
    assert len(duplicate_jobs) == 1
    assert duplicate_jobs[0].paths == repeated.paths


def test_saturation_coalesces_overflow_into_one_bounded_root_catch_up():
    started = Event()
    release = Event()
    catch_ups: list[frozenset[str]] = []
    active_catch_ups = 0
    maximum_active_catch_ups = 0
    catch_up_lock = Lock()

    def reconcile(_request: TargetedReconciliationRequest) -> None:
        if not started.is_set():
            started.set()
            assert release.wait(2)

    def catch_up(root_ids: frozenset[str]) -> None:
        nonlocal active_catch_ups, maximum_active_catch_ups
        with catch_up_lock:
            active_catch_ups += 1
            maximum_active_catch_ups = max(maximum_active_catch_ups, active_catch_ups)
        try:
            catch_ups.append(root_ids)
        finally:
            with catch_up_lock:
                active_catch_ups -= 1

    scheduler = TargetedReconciliationScheduler(
        reconcile=reconcile,
        catch_up=catch_up,
        record_problem=lambda _problem: None,
        clear_recovered=lambda _root_ids: None,
        max_pending_roots=2,
    )
    try:
        assert scheduler.submit(_request("active", "C:/Active/01.flac"))
        assert started.wait(2)
        assert scheduler.submit(_request("pending-a", "C:/A/01.flac"))
        assert scheduler.submit(_request("pending-b", "C:/B/01.flac"))
        for index in range(300):
            assert scheduler.submit(
                _request("overflow", f"C:/Overflow/{index:03}.flac")
            )

        release.set()
        assert scheduler.wait_for_idle(timeout=2)
    finally:
        release.set()
        scheduler.shutdown(wait=True, timeout=2)

    assert catch_ups == [frozenset({"overflow"})]
    assert maximum_active_catch_ups == 1


def test_successful_catch_up_clears_durable_warning_only_after_recovery():
    started = Event()
    release = Event()
    problem_recorded = Event()
    calls: list[tuple[str, object]] = []

    def reconcile(_request: TargetedReconciliationRequest) -> None:
        if not started.is_set():
            started.set()
            assert release.wait(2)

    def record_problem(problem: CoordinatorProblem) -> None:
        calls.append(("problem", (problem.code, problem.root_id)))
        problem_recorded.set()

    def catch_up(root_ids: frozenset[str]) -> None:
        calls.append(("catch-up", root_ids))

    def clear_recovered(root_ids: frozenset[str]) -> None:
        calls.append(("clear", root_ids))

    scheduler = TargetedReconciliationScheduler(
        reconcile=reconcile,
        catch_up=catch_up,
        record_problem=record_problem,
        clear_recovered=clear_recovered,
        max_pending_roots=1,
    )
    try:
        assert scheduler.submit(_request("active", "C:/Active/01.flac"))
        assert started.wait(2)
        assert scheduler.submit(_request("pending", "C:/Pending/01.flac"))
        assert scheduler.submit(_request("overflow", "C:/Overflow/01.flac"))
        assert problem_recorded.wait(2)
        assert calls == [("problem", ("overflow", "overflow"))]
        assert not any(kind == "clear" for kind, _value in calls)

        release.set()
        assert scheduler.wait_for_idle(timeout=2)
    finally:
        release.set()
        scheduler.shutdown(wait=True, timeout=2)

    assert calls == [
        ("problem", ("overflow", "overflow")),
        ("catch-up", frozenset({"overflow"})),
        ("clear", frozenset({"overflow"})),
    ]


def test_catch_up_cannot_clear_before_overflow_problem_is_recorded():
    active_started = Event()
    release_active = Event()
    problem_started = Event()
    release_problem = Event()
    catch_up_started = Event()

    def reconcile(_request: TargetedReconciliationRequest) -> None:
        active_started.set()
        assert release_active.wait(2)

    def record_problem(_problem: CoordinatorProblem) -> None:
        problem_started.set()
        assert release_problem.wait(2)

    def catch_up(_root_ids: frozenset[str]) -> None:
        catch_up_started.set()

    scheduler = TargetedReconciliationScheduler(
        reconcile=reconcile,
        catch_up=catch_up,
        record_problem=record_problem,
        clear_recovered=lambda _root_ids: None,
        max_pending_roots=1,
    )
    submitter = None
    try:
        assert scheduler.submit(_request("active", "C:/Active/01.flac"))
        assert active_started.wait(2)
        assert scheduler.submit(_request("pending", "C:/Pending/01.flac"))
        submitter = Thread(
            target=lambda: scheduler.submit(
                _request("overflow", "C:/Overflow/01.flac")
            )
        )
        submitter.start()
        assert problem_started.wait(2)

        release_active.set()
        assert not catch_up_started.wait(0.1)

        release_problem.set()
        submitter.join(2)
        assert not submitter.is_alive()
        assert scheduler.wait_for_idle(timeout=2)
        assert catch_up_started.is_set()
    finally:
        release_active.set()
        release_problem.set()
        submitter and submitter.join(2)
        scheduler.shutdown(wait=True, timeout=2)


def test_failed_catch_up_keeps_durable_warning():
    started = Event()
    release = Event()
    problems: list[CoordinatorProblem] = []
    cleared: list[frozenset[str]] = []

    def reconcile(_request: TargetedReconciliationRequest) -> None:
        if not started.is_set():
            started.set()
            assert release.wait(2)

    def catch_up(_root_ids: frozenset[str]) -> None:
        raise OSError("root temporarily unavailable")

    scheduler = TargetedReconciliationScheduler(
        reconcile=reconcile,
        catch_up=catch_up,
        record_problem=problems.append,
        clear_recovered=cleared.append,
        max_pending_roots=1,
    )
    try:
        assert scheduler.submit(_request("active", "C:/Active/01.flac"))
        assert started.wait(2)
        assert scheduler.submit(_request("pending", "C:/Pending/01.flac"))
        assert scheduler.submit(_request("overflow", "C:/Overflow/01.flac"))
        release.set()
        assert scheduler.wait_for_idle(timeout=2)
    finally:
        release.set()
        scheduler.shutdown(wait=True, timeout=2)

    assert cleared == []
    assert {(problem.code, problem.root_id) for problem in problems} == {
        ("overflow", "overflow"),
        ("reconciliation_failed", "overflow"),
    }


def test_shutdown_is_bounded_and_rejects_new_work_while_active_work_unwinds():
    started = Event()
    release = Event()

    def reconcile(_request: TargetedReconciliationRequest) -> None:
        started.set()
        assert release.wait(2)

    scheduler = TargetedReconciliationScheduler(
        reconcile=reconcile,
        catch_up=lambda _root_ids: None,
        record_problem=lambda _problem: None,
        clear_recovered=lambda _root_ids: None,
    )
    assert scheduler.submit(_request("main", "C:/Music/01.flac"))
    assert started.wait(2)
    assert scheduler.submit(_request("main", "C:/Music/02.flac"))

    before = monotonic()
    scheduler.shutdown(wait=False)
    assert monotonic() - before < 0.1
    assert not scheduler.submit(_request("main", "C:/Music/03.flac"))

    release.set()
    scheduler.shutdown(wait=True, timeout=2)
