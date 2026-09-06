from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone

import pytest

from music_app.jobs.dispatch import JobHandlerRegistry
from music_app.jobs.worker import PostgresWorkerInstanceRepository, Worker
from music_app.services.jobs.authorization import AuthorizationDecision
from music_app.services.jobs.models import (
    ClaimedJob,
    JobHeartbeatResult,
    JobKind,
    JobState,
    JobTransitionResult,
)


NOW = datetime(2026, 9, 6, 12, 0, tzinfo=timezone.utc)


def claim(kind: str = JobKind.FULL_SCAN.value) -> ClaimedJob:
    return ClaimedJob(
        job_id=41,
        kind=kind,
        subject_kind="library",
        subject_ref="library:7",
        parameters={},
        account_id=11,
        library_id=7,
        capability_key="library.refresh",
        request_origin_id=13,
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        idempotency_key="job:41",
        attempt=1,
        max_attempts=2,
        worker_id="worker-test",
        lease_token="opaque-lease",
        lease_expires_at=NOW + timedelta(minutes=5),
        scheduled_at=NOW,
    )


class Repository:
    def __init__(self, claims=(), heartbeats=(), reconciliation_failure=None):
        self.claims = list(claims)
        self.heartbeats = list(heartbeats)
        self.reconciliation_failure = reconciliation_failure
        self.calls = []
        self.finishes = []

    def reconcile_stale_leases(self, *, now, limit):
        self.calls.append(("reconcile_stale_leases", now, limit))
        if self.reconciliation_failure is not None:
            raise self.reconciliation_failure

    def claim(self, *, worker_id, now, lease_seconds):
        self.calls.append(("claim", worker_id, now, lease_seconds))
        return self.claims.pop(0) if self.claims else None

    def heartbeat(self, claimed, *, now, lease_seconds):
        self.calls.append(("heartbeat", claimed.job_id, now, lease_seconds))
        if self.heartbeats:
            return self.heartbeats.pop(0)
        return JobHeartbeatResult(active=True, cancel_requested=False)

    def finish(self, claimed, outcome, *, now):
        self.calls.append(("finish", claimed.job_id, now))
        self.finishes.append((claimed, outcome))
        return True


class Authorization:
    def __init__(self, decision=AuthorizationDecision(True, "authorized")):
        self.decision = decision
        self.claims = []

    def authorize(self, claimed, now):
        self.claims.append((claimed, now))
        return self.decision


class WorkerInstances:
    def __init__(self):
        self.calls = []

    def record_starting(
        self, *, worker_id, now, compatible_schema_version, handler_fingerprint
    ):
        self.calls.append(
            (
                "starting",
                worker_id,
                now,
                compatible_schema_version,
                handler_fingerprint,
            )
        )

    def record_running(self, *, worker_id, now):
        self.calls.append(("running", worker_id, now))

    def heartbeat(self, *, worker_id, now, lifecycle_state):
        self.calls.append(("heartbeat", worker_id, now, lifecycle_state))

    def record_draining(self, *, worker_id, now, deadline, drain_state):
        self.calls.append(("draining", worker_id, now, deadline, drain_state))

    def record_stopped(self, *, worker_id, now, drain_state):
        self.calls.append(("stopped", worker_id, now, drain_state))


class Connection:
    def __init__(self):
        self.entered = False
        self.exited = False
        self.executions = []

    def __enter__(self):
        self.entered = True
        return self

    def __exit__(self, *_):
        self.exited = True

    def execute(self, statement, parameters):
        assert self.entered and not self.exited
        self.executions.append((statement, parameters))


def registry(handler=lambda claimed, context: JobTransitionResult(JobState.SUCCEEDED, "completed")):
    result = JobHandlerRegistry()
    result.register(JobKind.FULL_SCAN, handler)
    return result


def worker(repository, *, authorization=None, handlers=None, wait=None, **overrides):
    settings = {
        "worker_id": "worker-test",
        "lease_seconds": 300,
        "heartbeat_seconds": 30,
        "poll_seconds": 1,
        "max_idle_backoff_seconds": 5,
        "drain_seconds": 30,
        "clock": lambda: NOW,
        "wait": wait or (lambda event, seconds: event.is_set()),
    }
    settings.update(overrides)
    return Worker(
        repository=repository,
        authorization_service=authorization or Authorization(),
        handlers=handlers or registry(),
        **settings,
    )


def test_handler_registry_rejects_unknown_job_kind():
    with pytest.raises(ValueError, match="unknown job kind"):
        JobHandlerRegistry().register("arbitrary_code", lambda *_: None)


def test_handler_registry_rejects_duplicate_registration():
    handlers = JobHandlerRegistry()
    handlers.register(JobKind.FULL_SCAN, lambda *_: None)

    with pytest.raises(ValueError, match="already registered"):
        handlers.register(JobKind.FULL_SCAN.value, lambda *_: None)


def test_handler_registry_rejects_noncallable_handler():
    with pytest.raises(TypeError, match="callable"):
        JobHandlerRegistry().register(JobKind.FULL_SCAN, object())


def test_run_once_returns_false_when_queue_is_idle():
    repository = Repository()

    assert worker(repository).run_once() is False
    assert repository.finishes == []


def test_run_once_authorizes_dispatches_and_finishes_success():
    claimed = claim()
    repository = Repository([claimed])
    dispatched = []

    def handler(received, context):
        dispatched.append((received, context))
        return JobTransitionResult(JobState.SUCCEEDED, "scan_completed")

    assert worker(repository, handlers=registry(handler)).run_once() is True
    assert dispatched[0][0] is claimed
    assert dispatched[0][1].claim is claimed
    assert dispatched[0][1].lease_active is True
    assert repository.finishes[0][1] == JobTransitionResult(
        JobState.SUCCEEDED, "scan_completed"
    )


def test_authorization_denial_cancels_without_dispatch():
    repository = Repository([claim()])
    authorization = Authorization(AuthorizationDecision(False, "capability_revoked"))
    dispatched = []

    assert worker(
        repository,
        authorization=authorization,
        handlers=registry(lambda *_: dispatched.append(True)),
    ).run_once() is True

    assert dispatched == []
    assert repository.finishes[0][1] == JobTransitionResult(
        JobState.CANCELED, "capability_revoked"
    )


@pytest.mark.parametrize(
    "outcome",
    [
        JobTransitionResult(
            JobState.RETRY_WAIT, "provider_retry", scheduled_at=NOW + timedelta(minutes=1)
        ),
        JobTransitionResult(JobState.AMBIGUOUS, "provider_result_unknown"),
        JobTransitionResult(JobState.FAILED, "handler_failed"),
    ],
)
def test_run_once_persists_typed_handler_outcome(outcome):
    repository = Repository([claim()])

    worker(repository, handlers=registry(lambda *_: outcome)).run_once()

    assert repository.finishes[0][1] is outcome


def test_handler_exception_becomes_bounded_failure_without_exception_text():
    repository = Repository([claim()])

    def fail(*_):
        raise RuntimeError("postgresql://worker:secret@host/private")

    worker(repository, handlers=registry(fail)).run_once()

    outcome = repository.finishes[0][1]
    assert outcome == JobTransitionResult(JobState.FAILED, "handler_failed")
    assert "secret" not in repr(outcome)


def test_lease_loss_during_execution_prevents_stale_finish():
    repository = Repository(
        [claim()], [JobHeartbeatResult(active=False, cancel_requested=False)]
    )
    entered = threading.Event()
    release = threading.Event()

    def handler(*_):
        entered.set()
        assert release.wait(2)
        return JobTransitionResult(JobState.SUCCEEDED, "completed")

    run = threading.Thread(target=worker(repository, handlers=registry(handler)).run_once)
    run.start()
    assert entered.wait(2)
    release.set()
    run.join(2)

    assert not run.is_alive()
    assert any(call[0] == "heartbeat" for call in repository.calls)
    assert repository.finishes == []


def test_heartbeat_continues_during_slow_handler_and_claim_transaction_is_closed():
    repository = Repository([claim()])
    entered = threading.Event()
    heartbeated = threading.Event()
    release = threading.Event()

    original_heartbeat = repository.heartbeat

    def heartbeat(*args, **kwargs):
        result = original_heartbeat(*args, **kwargs)
        heartbeated.set()
        return result

    repository.heartbeat = heartbeat

    def handler(*_):
        entered.set()
        assert heartbeated.wait(2)
        release.wait(2)
        return JobTransitionResult(JobState.SUCCEEDED, "completed")

    run = threading.Thread(target=worker(repository, handlers=registry(handler)).run_once)
    run.start()
    assert entered.wait(2)
    assert heartbeated.wait(2)
    release.set()
    run.join(2)

    assert not run.is_alive()
    assert [call[0] for call in repository.calls][:2] == ["claim", "heartbeat"]
    assert repository.finishes


def test_cancellation_seen_by_heartbeat_is_exposed_to_execution_context():
    repository = Repository(
        [claim()], [JobHeartbeatResult(active=True, cancel_requested=True)]
    )
    observed = []
    heartbeat_seen = threading.Event()

    original_heartbeat = repository.heartbeat

    def heartbeat(*args, **kwargs):
        result = original_heartbeat(*args, **kwargs)
        heartbeat_seen.set()
        return result

    repository.heartbeat = heartbeat

    def handler(_, context):
        assert heartbeat_seen.wait(2)
        observed.append(context.cancel_requested)
        return JobTransitionResult(JobState.CANCELED, "cancel_requested")

    worker(repository, handlers=registry(handler)).run_once()

    assert observed == [True]
    assert repository.finishes[0][1].next_state is JobState.CANCELED


def test_run_applies_exponential_idle_backoff_capped_by_configuration():
    repository = Repository()
    waits = []

    def wait(stop_event, seconds):
        waits.append(seconds)
        if len(waits) == 4:
            stop_event.set()
        return stop_event.is_set()

    worker(
        repository,
        wait=wait,
        max_idle_backoff_seconds=4,
    ).run(threading.Event())

    assert waits == [1, 2, 4, 4]
    assert len([call for call in repository.calls if call[0] == "claim"]) == 4


def test_run_reconciles_stale_leases_before_each_successive_idle_claim_cycle():
    repository = Repository()
    waits = []

    def wait(stop_event, seconds):
        waits.append(seconds)
        if len(waits) == 2:
            stop_event.set()
        return stop_event.is_set()

    worker(repository, wait=wait).run(threading.Event())

    assert repository.calls == [
        ("reconcile_stale_leases", NOW, 1000),
        ("claim", "worker-test", NOW, 300),
        ("reconcile_stale_leases", NOW, 1000),
        ("claim", "worker-test", NOW, 300),
    ]


def test_shutdown_during_blocked_reconciliation_starts_no_claim_or_lingering_thread():
    reconciliation_started = threading.Event()
    release_reconciliation = threading.Event()

    class BlockingReconciliationRepository(Repository):
        def reconcile_stale_leases(self, *, now, limit):
            super().reconcile_stale_leases(now=now, limit=limit)
            reconciliation_started.set()
            assert release_reconciliation.wait(2)

    repository = BlockingReconciliationRepository()
    stop = threading.Event()
    errors = []

    def run_worker():
        try:
            worker(repository).run(stop)
        except BaseException as exc:
            errors.append(exc)

    runner = threading.Thread(target=run_worker, name="test-blocked-reconciliation")
    runner.start()
    assert reconciliation_started.wait(2)
    stop.set()
    release_reconciliation.set()
    runner.join(2)

    assert not runner.is_alive()
    assert errors == []
    assert [call for call in repository.calls if call[0] == "claim"] == []
    assert not any(
        thread.is_alive() and thread.name.startswith("album-haven-job")
        for thread in threading.enumerate()
    )


def test_reconciliation_failure_stops_before_claim_and_closes_worker_lifecycle():
    secret = "postgresql://worker:secret@private-host/jobs"
    repository = Repository(reconciliation_failure=RuntimeError(secret))
    instances = WorkerInstances()
    stop = threading.Event()
    safety_wait_used = []

    def wait(stop_event, _seconds):
        safety_wait_used.append(True)
        stop_event.set()
        return True

    with pytest.raises(
        RuntimeError, match=r"^durable jobs worker execution failed$"
    ) as raised:
        worker(repository, worker_instances=instances, wait=wait).run(stop)

    assert repository.calls == [("reconcile_stale_leases", NOW, 1000)]
    assert safety_wait_used == []
    assert stop.is_set()
    assert [call[0] for call in instances.calls][:2] == ["starting", "running"]
    assert [call[0] for call in instances.calls][-2:] == ["draining", "stopped"]
    assert instances.calls[-1][3] == "complete"
    assert "secret" not in str(raised.value)
    assert "private-host" not in str(raised.value)


def test_run_persists_worker_lifecycle_and_idle_heartbeat():
    repository = Repository()
    instances = WorkerInstances()

    def wait(stop_event, _seconds):
        stop_event.set()
        return True

    worker(repository, wait=wait, worker_instances=instances).run(threading.Event())

    names = [call[0] for call in instances.calls]
    assert names[0:2] == ["starting", "running"]
    assert "heartbeat" in names
    assert names[-2:] == ["draining", "stopped"]
    assert instances.calls[0][3] == 1
    assert instances.calls[0][4] == registry().fingerprint
    assert instances.calls[-2][3] == NOW + timedelta(seconds=30)
    assert instances.calls[-2][4] == "draining"
    assert instances.calls[-1][3] == "complete"


def test_postgres_worker_instance_repository_writes_coherent_short_lifecycle_updates():
    database_url = "postgresql://worker-role:private@db.example/album_haven"
    connections = []

    def connect(received_url):
        assert received_url == database_url
        assert not connections or connections[-1].exited
        connection = Connection()
        connections.append(connection)
        return connection

    instances = PostgresWorkerInstanceRepository(
        database_url=database_url,
        connect_to_database=connect,
    )
    fingerprint = "a" * 64
    deadline = NOW + timedelta(seconds=30)

    instances.record_starting(
        worker_id="worker-test",
        now=NOW,
        compatible_schema_version=1,
        handler_fingerprint=fingerprint,
    )
    instances.record_running(worker_id="worker-test", now=NOW)
    instances.heartbeat(
        worker_id="worker-test", now=NOW, lifecycle_state="running"
    )
    instances.record_draining(
        worker_id="worker-test",
        now=NOW,
        deadline=deadline,
        drain_state="draining",
    )
    instances.record_stopped(
        worker_id="worker-test", now=NOW, drain_state="complete"
    )

    assert len(connections) == 5
    assert all(connection.exited for connection in connections)
    assert all(len(connection.executions) == 1 for connection in connections)
    statements = "\n".join(
        statement for connection in connections for statement, _ in connection.executions
    ).casefold()
    assert statements.count("ops.worker_instances") == 5
    parameters = [
        values for connection in connections for _, values in connection.executions
    ]
    assert parameters[0] == {
        "worker_id": "worker-test",
        "now": NOW,
        "compatible_schema_version": 1,
        "handler_fingerprint": fingerprint,
    }
    assert parameters[3]["deadline"] == deadline
    assert parameters[3]["drain_state"] == "draining"
    assert parameters[4]["drain_state"] == "complete"
    heartbeat_statement = " ".join(connections[2].executions[0][0].split()).casefold()
    has_pre_drain_predicate = any(
        guard in heartbeat_statement
        for guard in (
            "and lifecycle_state = 'running'",
            "and lifecycle_state in ('starting', 'running')",
        )
    )
    has_protective_case = (
        "case" in heartbeat_statement
        and "lifecycle_state" in heartbeat_statement
        and "'draining'" in heartbeat_statement
    )
    assert has_pre_drain_predicate or has_protective_case
    evidence = statements + repr(parameters)
    assert "subject_ref" not in evidence
    assert "parameters" not in evidence
    assert "private@" not in evidence


def test_concurrency_is_bounded_and_shutdown_drains_every_active_handler():
    claims = [claim(), claim(), claim()]
    claims[1] = ClaimedJob(**{**claims[1].__dict__, "job_id": 42})
    claims[2] = ClaimedJob(**{**claims[2].__dict__, "job_id": 43})
    repository = Repository(claims)
    entered_two = threading.Event()
    release = threading.Event()
    lock = threading.Lock()
    active = 0
    maximum_active = 0

    def handler(*_):
        nonlocal active, maximum_active
        with lock:
            active += 1
            maximum_active = max(maximum_active, active)
            if active == 2:
                entered_two.set()
        assert release.wait(2)
        with lock:
            active -= 1
        return JobTransitionResult(JobState.SUCCEEDED, "completed")

    stop = threading.Event()
    runner = threading.Thread(
        target=worker(
            repository,
            handlers=registry(handler),
            concurrency=2,
        ).run,
        args=(stop,),
    )
    runner.start()
    assert entered_two.wait(2)
    stop.set()
    release.set()
    runner.join(2)

    assert not runner.is_alive()
    assert maximum_active == 2
    assert len([call for call in repository.calls if call[0] == "claim"]) == 2
    assert len(repository.finishes) == 2


def test_shutdown_stops_new_claims_and_drains_active_handler_without_lingering_thread():
    claimed = claim()
    repository = Repository([claimed, claim()])
    entered = threading.Event()
    release = threading.Event()
    stop = threading.Event()

    def handler(*_):
        entered.set()
        assert release.wait(2)
        return JobTransitionResult(JobState.SUCCEEDED, "completed")

    runner = threading.Thread(
        target=worker(repository, handlers=registry(handler)).run,
        args=(stop,),
        name="test-worker-runner",
    )
    runner.start()
    assert entered.wait(2)
    stop.set()
    release.set()
    runner.join(2)

    assert not runner.is_alive()
    assert len([call for call in repository.calls if call[0] == "claim"]) == 1
    assert repository.finishes[0][1].next_state is JobState.SUCCEEDED
    assert not any(
        thread.is_alive() and thread.name.startswith("album-haven-job")
        for thread in threading.enumerate()
    )


def test_single_concurrency_shutdown_cancels_managed_handler_within_drain_bound():
    repository = Repository([claim()])
    entered = threading.Event()
    release = threading.Event()
    observed = []

    def handler(_, context):
        entered.set()
        while not context.cancel_requested and not release.wait(0.01):
            pass
        observed.append(context.cancel_requested)
        return JobTransitionResult(JobState.CANCELED, "cancel_requested")

    stop = threading.Event()
    finished = threading.Event()
    errors = []

    def run_worker():
        try:
            worker(
                repository,
                handlers=registry(handler),
                concurrency=1,
                drain_seconds=1,
            ).run(stop)
        except BaseException as exc:
            errors.append(exc)
        finally:
            finished.set()

    runner = threading.Thread(target=run_worker, name="test-single-worker-runner")
    runner.start()
    assert entered.wait(2)
    stop.set()
    stopped_before_manual_release = finished.wait(1.5)
    release.set()
    runner.join(2)

    assert stopped_before_manual_release
    assert not errors
    assert observed == [True]
    assert repository.finishes[0][1].next_state is JobState.CANCELED


def test_worker_instance_heartbeat_failure_is_propagated_without_threading_excepthook():
    repository = Repository()
    instances = WorkerInstances()
    heartbeat_called = threading.Event()
    excepthook_calls = []
    original_excepthook = threading.excepthook

    def fail_heartbeat(**_):
        heartbeat_called.set()
        raise RuntimeError("postgresql://worker:secret@private/subject")

    instances.heartbeat = fail_heartbeat
    threading.excepthook = lambda args: excepthook_calls.append(args)
    try:
        safety_stop_used = []

        def wait(stop_event, _seconds):
            assert heartbeat_called.wait(2)
            if not stop_event.is_set():
                safety_stop_used.append(True)
                stop_event.set()
            return True

        stop = threading.Event()
        with pytest.raises(RuntimeError, match=r"^worker instance heartbeat failed$"):
            worker(
                repository,
                wait=wait,
                worker_instances=instances,
            ).run(stop)
    finally:
        threading.excepthook = original_excepthook

    assert excepthook_calls == []
    assert stop.is_set()
    assert safety_stop_used == []
    assert all(
        "secret" not in repr(call) and "private" not in repr(call)
        for call in instances.calls
    )


def test_parallel_idle_backoff_advances_only_after_each_all_idle_batch():
    class BatchedIdleRepository(Repository):
        def __init__(self):
            super().__init__()
            self._lock = threading.Lock()

        def claim(self, *, worker_id, now, lease_seconds):
            with self._lock:
                self.calls.append(("claim", worker_id, now, lease_seconds))
            return None

    repository = BatchedIdleRepository()
    waits = []

    def wait(stop_event, seconds):
        waits.append(seconds)
        if len(waits) == 3:
            stop_event.set()
        return stop_event.is_set()

    worker(
        repository,
        concurrency=2,
        wait=wait,
        max_idle_backoff_seconds=4,
    ).run(threading.Event())

    assert waits == [1, 2, 4]
    assert len([call for call in repository.calls if call[0] == "claim"]) == 6


def test_drain_timeout_stays_draining_invalidates_lease_and_fails_boundedly():
    repository = Repository([claim()])
    instances = WorkerInstances()
    entered = threading.Event()
    release = threading.Event()
    contexts = []
    closed = []
    baseline_thread_ids = {thread.ident for thread in threading.enumerate()}

    class Closeable:
        def close(self):
            closed.append(True)

    def handler(_, context):
        contexts.append(context)
        entered.set()
        assert release.wait(2)
        return JobTransitionResult(JobState.SUCCEEDED, "completed")

    stop = threading.Event()
    failures = []

    runtime = worker(
        repository,
        handlers=registry(handler),
        concurrency=2,
        drain_seconds=0,
        worker_instances=instances,
        closeables=(Closeable(),),
    )

    def run_worker():
        try:
            runtime.run(stop)
        except BaseException as exc:
            failures.append(exc)

    runner = threading.Thread(target=run_worker, name="test-drain-timeout-runner")
    runner.start()
    assert entered.wait(2)
    stop.set()
    runner.join(2)
    runtime.close()

    assert not runner.is_alive()
    assert len(failures) == 1
    assert str(failures[0]) == "durable jobs worker drain timed out"
    assert contexts[0].cancel_requested is True
    assert contexts[0].lease_active is False
    assert [call[0] for call in instances.calls][-1] == "draining"
    assert not any(call[0] == "stopped" for call in instances.calls)
    assert closed == []

    release.set()
    owned = [
        thread
        for thread in threading.enumerate()
        if thread.ident not in baseline_thread_ids
        and thread.name.startswith("album-haven-job")
    ]
    for thread in owned:
        thread.join(2)
    runtime.close()

    assert repository.finishes == []
    assert closed == [True]
    assert not any(thread.is_alive() for thread in owned)


def test_child_run_once_failure_completed_during_shutdown_is_harvested():
    children_entered = threading.Event()
    allow_failure = threading.Event()

    class FailingRepository(Repository):
        def __init__(self):
            super().__init__()
            self._lock = threading.Lock()
            self._entered = 0

        def claim(self, **_):
            with self._lock:
                self._entered += 1
                if self._entered == 2:
                    children_entered.set()
            assert allow_failure.wait(2)
            raise RuntimeError("secret child failure")

    stop = threading.Event()
    failures = []

    def run_worker():
        try:
            worker(FailingRepository(), concurrency=2).run(stop)
        except BaseException as exc:
            failures.append(exc)

    runner = threading.Thread(target=run_worker, name="test-child-error-runner")
    runner.start()
    assert children_entered.wait(2)
    stop.set()
    allow_failure.set()
    runner.join(2)

    assert not runner.is_alive()
    assert len(failures) == 1
    assert str(failures[0]) == "durable jobs worker execution failed"
    assert "secret" not in str(failures[0])


def test_blocking_instance_heartbeat_times_out_drain_without_stopping_or_closing():
    entered = threading.Event()
    release = threading.Event()
    run_returned = threading.Event()
    failures = []
    closed = []
    baseline_thread_ids = {thread.ident for thread in threading.enumerate()}

    class BlockingWorkerInstances(WorkerInstances):
        def heartbeat(self, **_):
            entered.set()
            assert release.wait(2)

    class Closeable:
        def close(self):
            closed.append(True)

    instances = BlockingWorkerInstances()
    stop = threading.Event()
    runtime = worker(
        Repository(),
        concurrency=1,
        drain_seconds=0,
        worker_instances=instances,
        closeables=(Closeable(),),
    )

    def run_worker():
        try:
            runtime.run(stop)
        except BaseException as exc:
            failures.append(exc)
        finally:
            run_returned.set()

    runner = threading.Thread(target=run_worker, name="test-blocked-instance-heartbeat")
    runner.start()
    assert entered.wait(2)
    stop.set()
    returned_before_release = run_returned.wait(0.25)
    runtime.close()
    closed_before_release = list(closed)

    release.set()
    runner.join(2)
    owned = [
        thread
        for thread in threading.enumerate()
        if thread.ident not in baseline_thread_ids
        and thread.name.startswith("album-haven-worker-heartbeat")
    ]
    for thread in owned:
        thread.join(2)
    runtime.close()

    assert returned_before_release
    assert not runner.is_alive()
    assert len(failures) == 1
    assert str(failures[0]) == "durable jobs worker drain timed out"
    assert [call[0] for call in instances.calls][-1] == "draining"
    assert not any(call[0] == "stopped" for call in instances.calls)
    assert closed_before_release == []
    assert closed == [True]
    assert not any(thread.is_alive() for thread in owned)


def test_blocking_finish_times_out_without_losing_active_context_or_closing():
    finish_entered = threading.Event()
    release_finish = threading.Event()
    contexts = []
    failures = []
    closed = []
    baseline_thread_ids = {thread.ident for thread in threading.enumerate()}

    class BlockingFinishRepository(Repository):
        def finish(self, claimed, outcome, *, now):
            finish_entered.set()
            assert release_finish.wait(2)
            return super().finish(claimed, outcome, now=now)

    class Closeable:
        def close(self):
            closed.append(True)

    def handler(_, context):
        contexts.append(context)
        return JobTransitionResult(JobState.SUCCEEDED, "completed")

    instances = WorkerInstances()
    stop = threading.Event()
    runtime = worker(
        BlockingFinishRepository([claim()]),
        handlers=registry(handler),
        concurrency=2,
        drain_seconds=0,
        worker_instances=instances,
        closeables=(Closeable(),),
    )

    def run_worker():
        try:
            runtime.run(stop)
        except BaseException as exc:
            failures.append(exc)

    runner = threading.Thread(target=run_worker, name="test-blocked-finish-runner")
    runner.start()
    assert finish_entered.wait(2)
    stop.set()
    runner.join(0.25)
    returned_before_release = not runner.is_alive()
    runtime.close()
    closed_before_release = list(closed)

    release_finish.set()
    runner.join(2)
    owned = [
        thread
        for thread in threading.enumerate()
        if thread.ident not in baseline_thread_ids
        and thread.name.startswith(
            ("album-haven-job", "album-haven-worker-heartbeat")
        )
    ]
    for thread in owned:
        thread.join(2)
    runtime.close()

    assert returned_before_release
    assert len(failures) == 1
    assert str(failures[0]) == "durable jobs worker drain timed out"
    assert len(contexts) == 1
    assert contexts[0].cancel_requested is True
    assert contexts[0].lease_active is False
    assert [call[0] for call in instances.calls][-1] == "draining"
    assert not any(call[0] == "stopped" for call in instances.calls)
    assert closed_before_release == []
    assert closed == [True]
    assert not runner.is_alive()
    assert not any(thread.is_alive() for thread in owned)
