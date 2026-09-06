"""Bounded durable-job worker loop and worker-instance persistence."""

from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

from music_app.services.jobs.authorization import AuthorizationDecision
from music_app.services.jobs.models import (
    ClaimedJob,
    JobHeartbeatResult,
    JobState,
    JobTransitionResult,
)

from .dispatch import JobHandlerRegistry


_COMPATIBLE_SCHEMA_VERSION = 1


def create_worker_pool(config: Any, *, pool_factory: Callable[..., Any] | None = None) -> Any:
    """Create the worker's small pool from only its dedicated database URL."""

    if pool_factory is None:
        try:
            from psycopg_pool import ConnectionPool
        except ImportError:
            raise RuntimeError("psycopg_pool is required for the jobs worker") from None
        pool_factory = ConnectionPool
    from psycopg.rows import dict_row

    return pool_factory(
        config.database_url,
        min_size=1,
        max_size=config.concurrency + 1,
        timeout=10,
        kwargs={"row_factory": dict_row},
    )


class ExecutionContext:
    """Thread-safe lease, cancellation, and authorization view for a handler."""

    def __init__(
        self,
        claim: ClaimedJob,
        *,
        authorization_service: Any,
        clock: Callable[[], datetime],
    ) -> None:
        self.claim = claim
        self._authorization_service = authorization_service
        self._clock = clock
        self._lock = threading.Lock()
        self._lease_active = True
        self._cancel_requested = False
        self._finalization_claimed = False

    @property
    def lease_active(self) -> bool:
        with self._lock:
            return self._lease_active

    @property
    def cancel_requested(self) -> bool:
        with self._lock:
            return self._cancel_requested

    def observe_heartbeat(self, result: JobHeartbeatResult) -> None:
        with self._lock:
            self._lease_active = self._lease_active and bool(result.active)
            self._cancel_requested = self._cancel_requested or bool(
                result.cancel_requested
            )

    def mark_lease_lost(self) -> None:
        with self._lock:
            self._lease_active = False

    def request_cancellation(self) -> None:
        with self._lock:
            self._cancel_requested = True

    def reauthorize(self) -> AuthorizationDecision:
        """Recheck current authority at a handler's protected checkpoint."""

        try:
            decision = self._authorization_service.authorize(
                self.claim, self._clock()
            )
        except Exception:
            decision = AuthorizationDecision(False, "authorization_context_invalid")
        if not isinstance(decision, AuthorizationDecision):
            decision = AuthorizationDecision(False, "authorization_context_invalid")
        if not decision.allowed:
            self.request_cancellation()
        return decision

    def finish_if_active(self, finish: Callable[[], None]) -> bool:
        """Serialize finalization against drain-time lease invalidation."""

        with self._lock:
            if not self._lease_active or self._finalization_claimed:
                return False
            self._finalization_claimed = True
        finish()
        return True


class PostgresWorkerInstanceRepository:
    """Write one coherent worker lifecycle update per short transaction."""

    def __init__(
        self,
        *,
        database_url: str,
        connect_to_database: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(database_url or "").strip()
        self._connect_to_database = connect_to_database or _connect_to_database

    def _execute(self, statement: str, parameters: dict[str, Any]) -> None:
        if not self._database_url:
            raise RuntimeError("worker instance database URL is required")
        with self._connect_to_database(self._database_url) as connection:
            connection.execute(statement, parameters)

    def record_starting(
        self,
        *,
        worker_id: str,
        now: datetime,
        compatible_schema_version: int,
        handler_fingerprint: str,
    ) -> None:
        self._execute(
            """
            insert into ops.worker_instances (
              instance_id, lifecycle_state, started_at, last_heartbeat_at,
              compatible_schema_version, registered_handler_fingerprint,
              drain_state, drain_started_at, drain_deadline_at, stopped_at
            ) values (
              %(worker_id)s, 'starting', %(now)s, %(now)s,
              %(compatible_schema_version)s, %(handler_fingerprint)s,
              'none', null, null, null
            )
            on conflict (instance_id) do update set
              lifecycle_state = 'starting',
              started_at = excluded.started_at,
              last_heartbeat_at = excluded.last_heartbeat_at,
              compatible_schema_version = excluded.compatible_schema_version,
              registered_handler_fingerprint = excluded.registered_handler_fingerprint,
              drain_state = 'none',
              drain_started_at = null,
              drain_deadline_at = null,
              stopped_at = null
            """,
            {
                "worker_id": worker_id,
                "now": now,
                "compatible_schema_version": compatible_schema_version,
                "handler_fingerprint": handler_fingerprint,
            },
        )

    def record_running(self, *, worker_id: str, now: datetime) -> None:
        self._execute(
            """
            update ops.worker_instances
               set lifecycle_state = 'running', last_heartbeat_at = %(now)s
             where instance_id = %(worker_id)s
            """,
            {"worker_id": worker_id, "now": now},
        )

    def heartbeat(
        self, *, worker_id: str, now: datetime, lifecycle_state: str
    ) -> None:
        self._execute(
            """
            update ops.worker_instances
               set lifecycle_state = %(lifecycle_state)s,
                   last_heartbeat_at = %(now)s
             where instance_id = %(worker_id)s
               and lifecycle_state in ('starting', 'running')
            """,
            {
                "worker_id": worker_id,
                "now": now,
                "lifecycle_state": lifecycle_state,
            },
        )

    def record_draining(
        self,
        *,
        worker_id: str,
        now: datetime,
        deadline: datetime,
        drain_state: str,
    ) -> None:
        self._execute(
            """
            update ops.worker_instances
               set lifecycle_state = 'draining',
                   last_heartbeat_at = %(now)s,
                   drain_state = %(drain_state)s,
                   drain_started_at = coalesce(drain_started_at, %(now)s),
                   drain_deadline_at = %(deadline)s
             where instance_id = %(worker_id)s
               and lifecycle_state <> 'stopped'
            """,
            {
                "worker_id": worker_id,
                "now": now,
                "deadline": deadline,
                "drain_state": drain_state,
            },
        )

    def record_stopped(
        self, *, worker_id: str, now: datetime, drain_state: str
    ) -> None:
        self._execute(
            """
            update ops.worker_instances
               set lifecycle_state = 'stopped',
                   last_heartbeat_at = %(now)s,
                   drain_state = %(drain_state)s,
                   drain_started_at = coalesce(drain_started_at, %(now)s),
                   stopped_at = %(now)s
             where instance_id = %(worker_id)s
            """,
            {
                "worker_id": worker_id,
                "now": now,
                "drain_state": drain_state,
            },
        )


class Worker:
    """Claim, authorize, dispatch, heartbeat, and finalize durable jobs."""

    def __init__(
        self,
        *,
        repository: Any,
        authorization_service: Any,
        handlers: JobHandlerRegistry,
        worker_id: str | None = None,
        lease_seconds: int,
        heartbeat_seconds: int,
        poll_seconds: int,
        max_idle_backoff_seconds: int,
        drain_seconds: int,
        concurrency: int = 1,
        worker_instances: Any | None = None,
        clock: Callable[[], datetime] | None = None,
        wait: Callable[[threading.Event, float], bool] | None = None,
        closeables: tuple[Any, ...] = (),
        claim_kinds: tuple[str, ...] | None = None,
        due_reconciler: Callable[..., object] | None = None,
    ) -> None:
        self._repository = repository
        self._authorization_service = authorization_service
        self._handlers = handlers
        self._worker_id = worker_id or f"worker-{uuid.uuid4().hex}"
        self._lease_seconds = lease_seconds
        self._heartbeat_seconds = heartbeat_seconds
        self._poll_seconds = poll_seconds
        self._max_idle_backoff_seconds = max_idle_backoff_seconds
        self._drain_seconds = drain_seconds
        self._concurrency = concurrency
        self._worker_instances = worker_instances
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._wait = wait or (lambda event, seconds: event.wait(seconds))
        self._closeables = closeables
        self._claim_kinds = claim_kinds
        self._due_reconciler = due_reconciler
        self._due_reconciliation_failures = 0
        self._contexts_lock = threading.Lock()
        self._active_contexts: set[ExecutionContext] = set()
        self._owned_threads_lock = threading.Lock()
        self._owned_threads: set[threading.Thread] = set()
        self._close_lock = threading.Lock()
        self._closed = False

    def close(self) -> None:
        """Release worker-owned pools after the loop has stopped."""

        with self._close_lock:
            if self._closed:
                return
            with self._owned_threads_lock:
                if any(thread.is_alive() for thread in self._owned_threads):
                    return
            for resource in reversed(self._closeables):
                close = getattr(resource, "close", None)
                if callable(close):
                    close()
            self._closed = True

    @property
    def due_reconciliation_failures(self) -> int:
        return self._due_reconciliation_failures

    def run_once(self) -> bool:
        claim_arguments = {
            "worker_id": self._worker_id,
            "now": self._clock(),
            "lease_seconds": self._lease_seconds,
        }
        if self._claim_kinds is not None:
            claim_arguments["kinds"] = self._claim_kinds
        claimed = self._repository.claim(**claim_arguments)
        if claimed is None:
            return False

        decision = self._authorize(claimed)
        if not decision.allowed:
            self._repository.finish(
                claimed,
                JobTransitionResult(JobState.CANCELED, decision.reason_code),
                now=self._clock(),
            )
            return True

        context = ExecutionContext(
            claimed,
            authorization_service=self._authorization_service,
            clock=self._clock,
        )
        with self._contexts_lock:
            self._active_contexts.add(context)
        heartbeat_stop = threading.Event()
        heartbeat = threading.Thread(
            target=self._heartbeat_job,
            args=(claimed, context, heartbeat_stop),
            name=f"album-haven-job-heartbeat-{claimed.job_id}",
            daemon=True,
        )
        heartbeat.start()
        try:
            try:
                handler = self._handlers.resolve(claimed.kind)
                outcome = handler(claimed, context)
                if not isinstance(outcome, JobTransitionResult):
                    outcome = JobTransitionResult(JobState.FAILED, "handler_failed")
            except Exception:
                outcome = JobTransitionResult(JobState.FAILED, "handler_failed")
        finally:
            heartbeat_stop.set()
            heartbeat.join()
        try:
            context.finish_if_active(
                lambda: self._repository.finish(claimed, outcome, now=self._clock())
            )
        finally:
            with self._contexts_lock:
                self._active_contexts.discard(context)
        return True

    def run(self, stop_event: threading.Event) -> None:
        self._record_startup()
        heartbeat_failed = threading.Event()
        instance_heartbeat = None
        if self._worker_instances is not None:
            instance_heartbeat = threading.Thread(
                target=self._heartbeat_instance,
                args=(stop_event, heartbeat_failed),
                name="album-haven-worker-heartbeat",
                daemon=True,
            )
            self._track_owned_thread(instance_heartbeat)
            instance_heartbeat.start()
        threads: list[threading.Thread] = []
        results: dict[threading.Thread, dict[str, bool]] = {}
        idle_backoff = self._poll_seconds
        execution_failed = False
        try:
            while not stop_event.is_set():
                self._repository.reconcile_stale_leases(
                    now=self._clock(),
                    limit=1000,
                )
                if self._due_reconciler is not None:
                    try:
                        self._due_reconciler(now=self._clock(), limit=100)
                    except Exception:
                        self._due_reconciliation_failures += 1
                if stop_event.is_set():
                    break
                batch = self._launch_batch(results)
                threads.extend(batch)
                while (
                    not stop_event.is_set()
                    and any(thread.is_alive() for thread in batch)
                ):
                    for thread in batch:
                        thread.join(0.01)
                if stop_event.is_set():
                    break
                for thread in batch:
                    thread.join()
                batch_failed, did_work = self._harvest(batch, results)
                for thread in batch:
                    threads.remove(thread)
                if batch_failed:
                    execution_failed = True
                    stop_event.set()
                    break
                if did_work:
                    idle_backoff = self._poll_seconds
                else:
                    self._wait(stop_event, idle_backoff)
                    idle_backoff = min(
                        idle_backoff * 2, self._max_idle_backoff_seconds
                    )
        except BaseException:
            execution_failed = True
            stop_event.set()
        finally:
            self._request_active_cancellation()
            now = self._clock()
            deadline = now + timedelta(seconds=self._drain_seconds)
            monotonic_deadline = time.monotonic() + self._drain_seconds
            self._record_draining(now, deadline)
            instance_complete = self._join_until(
                instance_heartbeat, monotonic_deadline
            )
            runners_complete = self._drain(threads, monotonic_deadline)
            if not instance_complete or not runners_complete:
                self._invalidate_active_contexts()
                raise RuntimeError("durable jobs worker drain timed out") from None
            child_failed, _ = self._harvest(threads, results)
            execution_failed = execution_failed or child_failed
            self._record_stopped("complete")

        if heartbeat_failed.is_set():
            raise RuntimeError("worker instance heartbeat failed") from None
        if execution_failed:
            raise RuntimeError("durable jobs worker execution failed") from None

    def _launch_batch(
        self, results: dict[threading.Thread, dict[str, bool]]
    ) -> list[threading.Thread]:
        batch = []
        for _ in range(self._concurrency):
            result = {"failed": False, "did_work": False}
            thread = threading.Thread(
                target=self._run_once_captured,
                args=(result,),
                name=f"album-haven-job-{uuid.uuid4().hex[:12]}",
                daemon=True,
            )
            results[thread] = result
            batch.append(thread)
            self._track_owned_thread(thread)
            thread.start()
        return batch

    def _run_once_captured(self, result: dict[str, bool]) -> None:
        try:
            result["did_work"] = self.run_once()
        except BaseException:
            result["failed"] = True

    def _harvest(
        self,
        threads: list[threading.Thread],
        results: dict[threading.Thread, dict[str, bool]],
    ) -> tuple[bool, bool]:
        failed = False
        did_work = False
        for thread in tuple(threads):
            if thread.is_alive():
                continue
            result = results.pop(thread, {"failed": True, "did_work": False})
            failed = failed or result["failed"]
            did_work = did_work or result["did_work"]
            with self._owned_threads_lock:
                self._owned_threads.discard(thread)
        return failed, did_work

    def _track_owned_thread(self, thread: threading.Thread) -> None:
        with self._owned_threads_lock:
            self._owned_threads.add(thread)

    def _discard_owned_thread(self, thread: threading.Thread | None) -> None:
        if thread is None or thread.is_alive():
            return
        with self._owned_threads_lock:
            self._owned_threads.discard(thread)

    def _authorize(self, claimed: ClaimedJob) -> AuthorizationDecision:
        try:
            decision = self._authorization_service.authorize(claimed, self._clock())
        except Exception:
            return AuthorizationDecision(False, "authorization_context_invalid")
        if not isinstance(decision, AuthorizationDecision):
            return AuthorizationDecision(False, "authorization_context_invalid")
        return decision

    def _heartbeat_job(
        self,
        claimed: ClaimedJob,
        context: ExecutionContext,
        stop_event: threading.Event,
    ) -> None:
        while not stop_event.is_set():
            try:
                result = self._repository.heartbeat(
                    claimed,
                    now=self._clock(),
                    lease_seconds=self._lease_seconds,
                )
                if not isinstance(result, JobHeartbeatResult):
                    context.mark_lease_lost()
                    return
                context.observe_heartbeat(result)
                if not result.active:
                    return
            except Exception:
                context.mark_lease_lost()
                return
            if stop_event.wait(self._heartbeat_seconds):
                return

    def _record_startup(self) -> None:
        if self._worker_instances is None:
            return
        now = self._clock()
        self._worker_instances.record_starting(
            worker_id=self._worker_id,
            now=now,
            compatible_schema_version=_COMPATIBLE_SCHEMA_VERSION,
            handler_fingerprint=self._handlers.fingerprint,
        )
        self._worker_instances.record_running(worker_id=self._worker_id, now=self._clock())

    def _heartbeat_instance(
        self,
        stop_event: threading.Event,
        heartbeat_failed: threading.Event,
    ) -> None:
        while not stop_event.is_set():
            try:
                self._worker_instances.heartbeat(
                    worker_id=self._worker_id,
                    now=self._clock(),
                    lifecycle_state="running",
                )
            except BaseException:
                heartbeat_failed.set()
                stop_event.set()
                return
            if stop_event.wait(self._heartbeat_seconds):
                return

    def _request_active_cancellation(self) -> None:
        with self._contexts_lock:
            contexts = tuple(self._active_contexts)
        for context in contexts:
            context.request_cancellation()

    def _invalidate_active_contexts(self) -> None:
        with self._contexts_lock:
            contexts = tuple(self._active_contexts)
        for context in contexts:
            context.request_cancellation()
            context.mark_lease_lost()

    def _record_draining(self, now: datetime, deadline: datetime) -> None:
        if self._worker_instances is not None:
            self._worker_instances.record_draining(
                worker_id=self._worker_id,
                now=now,
                deadline=deadline,
                drain_state="draining",
            )

    def _join_until(
        self,
        thread: threading.Thread | None,
        monotonic_deadline: float,
    ) -> bool:
        if thread is None:
            return True
        remaining = max(0.0, monotonic_deadline - time.monotonic())
        thread.join(remaining)
        complete = not thread.is_alive()
        if complete:
            self._discard_owned_thread(thread)
        return complete

    def _drain(
        self,
        threads: list[threading.Thread],
        monotonic_deadline: float,
    ) -> bool:
        for thread in tuple(threads):
            remaining = max(0.0, monotonic_deadline - time.monotonic())
            thread.join(remaining)
        return all(not thread.is_alive() for thread in threads)

    def _record_stopped(self, drain_state: str) -> None:
        if self._worker_instances is not None:
            self._worker_instances.record_stopped(
                worker_id=self._worker_id,
                now=self._clock(),
                drain_state=drain_state,
            )


def _connect_to_database(database_url: str) -> Any:
    try:
        import psycopg
    except ImportError:
        raise RuntimeError("psycopg is required for the jobs worker") from None
    return psycopg.connect(database_url)


__all__ = [
    "ExecutionContext",
    "PostgresWorkerInstanceRepository",
    "Worker",
    "create_worker_pool",
]
