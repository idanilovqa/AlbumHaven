from __future__ import annotations

import math
import logging
from datetime import datetime, timezone
from threading import Event, Lock, Thread, Timer
from time import monotonic
from typing import Callable, Protocol
from uuid import UUID

from music_app.services.watcher_recovery_postgres import (
    WatcherDirtyWriteAttempt,
    WatcherDirtyWriteOutcome,
    WatcherSessionFinishAttempt,
    WatcherSessionFinishOutcome,
    WatcherSessionReplacedError,
)


_LOGGER = logging.getLogger(__name__)
_RETRY_EXECUTION_BUDGET_SECONDS = 1.0


class WatcherSessionRecoveryRepository(Protocol):
    def begin_runtime_session(
        self,
        *,
        library_id: int,
        session_token: UUID,
        logical_root_ids: tuple[str, ...],
        started_at: datetime,
    ) -> tuple[str, ...]: ...

    def expand_runtime_session_participants(
        self,
        *,
        library_id: int,
        session_token: UUID,
        logical_root_ids: tuple[str, ...],
    ) -> None: ...

    def set_runtime_session_participants(
        self,
        *,
        library_id: int,
        session_token: UUID,
        logical_root_ids: tuple[str, ...],
    ) -> None: ...

    def prepare_runtime_session_finish(
        self,
        *,
        library_id: int,
        session_token: UUID,
        operation_deadline: float,
    ) -> WatcherSessionFinishAttempt: ...

    def prepare_overflow_dirty_write(
        self,
        *,
        library_id: int,
        logical_root_ids: tuple[str, ...],
        observed_at: datetime,
        operation_deadline: float,
    ) -> WatcherDirtyWriteAttempt: ...


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _new_thread(target: Callable[[], None], name: str) -> Thread:
    return Thread(target=target, name=name, daemon=True)


def _logical_root_ids(values: tuple[str, ...], *, allow_empty: bool) -> tuple[str, ...]:
    if not isinstance(values, tuple):
        raise ValueError("logical root IDs must be a tuple")
    normalized: set[str] = set()
    for value in values:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("logical root IDs must be nonblank strings")
        normalized.add(value.strip())
    if not allow_empty and not normalized:
        raise ValueError("logical root IDs must not be empty")
    return tuple(sorted(normalized))


def _aware_utc(value: datetime) -> datetime:
    if (
        not isinstance(value, datetime)
        or value.tzinfo is None
        or value.utcoffset() != timezone.utc.utcoffset(value)
    ):
        raise ValueError("clock must return an aware UTC timestamp")
    return value


class WatcherSessionRecoveryController:
    def __init__(
        self,
        repository: WatcherSessionRecoveryRepository,
        *,
        clock: Callable[[], datetime] = _utc_now,
        monotonic_clock: Callable[[], float] = monotonic,
        retry_delay_seconds: float = 1.0,
        cancellation_reserve_seconds: float = 0.5,
        retry_timer_factory: Callable[[float, Callable[[], None]], object] = Timer,
        thread_factory: Callable[[Callable[[], None], str], Thread] = _new_thread,
    ) -> None:
        retry_delay_seconds = float(retry_delay_seconds)
        cancellation_reserve_seconds = float(cancellation_reserve_seconds)
        if not math.isfinite(retry_delay_seconds) or retry_delay_seconds < 0:
            raise ValueError("retry delay must be finite and nonnegative")
        if (
            not math.isfinite(cancellation_reserve_seconds)
            or cancellation_reserve_seconds <= 0
        ):
            raise ValueError("cancellation reserve must be finite and positive")

        self._repository = repository
        self._clock = clock
        self._monotonic_clock = monotonic_clock
        self._retry_delay_seconds = retry_delay_seconds
        self._cancellation_reserve_seconds = cancellation_reserve_seconds
        self._retry_timer_factory = retry_timer_factory
        self._thread_factory = thread_factory

        self._retry_lock = Lock()
        self._thread_start_lock = Lock()
        self._stop_lock = Lock()
        self._thread_started = Event()
        self._thread_started.set()
        self._thread_starting = False
        self._pending: set[str] = set()
        self._in_flight: set[str] = set()
        self._attempt: WatcherDirtyWriteAttempt | WatcherSessionFinishAttempt | None = None
        self._timer: object | None = None
        self._callback_thread: object | None = None
        self._generation = 0
        self._library_id: int | None = None
        self._session_token: UUID | None = None
        self._start_in_progress = False
        self._stopping = False
        self._flush_succeeded = False
        self._session_replaced = False
        self._finished = False
        self._finish_attempted = False

    def start(
        self,
        *,
        library_id: int,
        session_token: UUID,
        logical_root_ids: tuple[str, ...],
        started_at: datetime,
    ) -> tuple[str, ...]:
        root_ids = _logical_root_ids(logical_root_ids, allow_empty=True)
        with self._retry_lock:
            if self._library_id is not None or self._start_in_progress:
                raise RuntimeError("watcher recovery controller is already started")
            self._start_in_progress = True
        try:
            recovered = self._repository.begin_runtime_session(
                library_id=library_id,
                session_token=session_token,
                logical_root_ids=root_ids,
                started_at=started_at,
            )
        except Exception:
            with self._retry_lock:
                self._start_in_progress = False
            raise
        else:
            with self._retry_lock:
                self._library_id = library_id
                self._session_token = session_token
                self._start_in_progress = False
        return recovered

    def report_admission_failure(
        self,
        *,
        logical_root_ids: tuple[str, ...],
    ) -> None:
        root_ids = _logical_root_ids(logical_root_ids, allow_empty=False)
        timer = None
        with self._retry_lock:
            self._require_started_locked()
            if self._stopping or self._finished or self._session_replaced:
                return
            self._pending.update(
                root_id
                for root_id in root_ids
                if root_id not in self._in_flight
            )
            timer = self._schedule_retry_locked()
        if timer is not None:
            timer.start()

    def expand_participants(self, logical_root_ids: tuple[str, ...]) -> None:
        root_ids = _logical_root_ids(logical_root_ids, allow_empty=True)
        library_id, session_token = self._session_identity()
        try:
            self._repository.expand_runtime_session_participants(
                library_id=library_id,
                session_token=session_token,
                logical_root_ids=root_ids,
            )
        except WatcherSessionReplacedError as exc:
            self._replace_and_cleanup(exc)
            raise

    def set_participants(self, logical_root_ids: tuple[str, ...]) -> None:
        root_ids = _logical_root_ids(logical_root_ids, allow_empty=True)
        library_id, session_token = self._session_identity()
        try:
            self._repository.set_runtime_session_participants(
                library_id=library_id,
                session_token=session_token,
                logical_root_ids=root_ids,
            )
        except WatcherSessionReplacedError as exc:
            self._replace_and_cleanup(exc)
            raise

    def stop_retry_and_flush(self, *, deadline: float) -> None:
        deadline = float(deadline)
        if not math.isfinite(deadline):
            raise ValueError("deadline must be finite")

        if not self._acquire_until(self._stop_lock, deadline):
            self._abort_cleanup(session_replaced=False)
            raise RuntimeError("watcher recovery stop deadline is exhausted")
        try:
            timer, attempt, thread = self._begin_cleanup(
                deadline=deadline,
                session_replaced=False,
            )
            if timer is not None:
                timer.cancel()

            if thread is not None:
                self._cancel_and_join(attempt, thread, deadline)

            with self._retry_lock:
                if self._callback_thread is not None or self._attempt is not None:
                    raise RuntimeError("watcher recovery callback did not stop")
                self._pending.update(self._in_flight)
                self._in_flight.clear()
                remaining = tuple(sorted(self._pending))

            if remaining:
                self._run_final_flush(remaining, deadline)

            with self._retry_lock:
                if (
                    self._pending
                    or self._in_flight
                    or self._attempt is not None
                    or self._callback_thread is not None
                ):
                    raise RuntimeError("watcher recovery flush did not commit")
                self._flush_succeeded = True
        finally:
            self._stop_lock.release()

    def finish(self, *, deadline: float) -> bool:
        deadline = float(deadline)
        if not math.isfinite(deadline):
            raise ValueError("deadline must be finite")
        if not self._acquire_until(self._stop_lock, deadline):
            raise RuntimeError("watcher recovery finish deadline is exhausted")
        try:
            with self._retry_lock:
                self._require_started_locked()
                if self._finished:
                    return True
                if not self._flush_succeeded or self._session_replaced:
                    raise RuntimeError("watcher recovery session is not clean")
                if self._finish_attempted:
                    raise RuntimeError("watcher recovery finish already attempted")
                if deadline <= self._monotonic_clock():
                    raise RuntimeError("watcher recovery finish deadline is exhausted")
                self._finish_attempted = True
                library_id = self._library_id
                session_token = self._session_token
            assert library_id is not None and session_token is not None
            attempt = self._repository.prepare_runtime_session_finish(
                library_id=library_id,
                session_token=session_token,
                operation_deadline=deadline,
            )
            try:
                outcome = self._run_final_attempt(attempt, deadline, "finish")
            except WatcherSessionReplacedError:
                with self._retry_lock:
                    self._session_replaced = True
                raise
            if outcome.state != "committed" or outcome.finished is not True:
                raise RuntimeError("watcher recovery session could not be finished")
            with self._retry_lock:
                self._finished = True
            return True
        finally:
            self._stop_lock.release()

    def _session_identity(self) -> tuple[int, UUID]:
        with self._retry_lock:
            self._require_started_locked()
            if self._stopping or self._finished or self._session_replaced:
                raise RuntimeError("watcher recovery session is not active")
            library_id = self._library_id
            session_token = self._session_token
        assert library_id is not None and session_token is not None
        return library_id, session_token

    def _replace_and_cleanup(self, original: WatcherSessionReplacedError) -> None:
        cleanup_deadline = (
            self._monotonic_clock()
            + _RETRY_EXECUTION_BUDGET_SECONDS
            + self._cancellation_reserve_seconds
        )
        try:
            if not self._acquire_until(self._stop_lock, cleanup_deadline):
                self._abort_cleanup(session_replaced=True)
                raise RuntimeError("watcher recovery replacement deadline is exhausted")
            try:
                timer, attempt, thread = self._begin_cleanup(
                    deadline=cleanup_deadline,
                    session_replaced=True,
                )
                if timer is not None:
                    timer.cancel()
                if thread is not None:
                    self._cancel_and_join(attempt, thread, cleanup_deadline)
            finally:
                self._stop_lock.release()
        except Exception as cleanup_error:
            self._log_failure("replacement_cleanup", len(self._in_flight), cleanup_error)
            raise RuntimeError("watcher recovery replacement cleanup failed") from original

    def _begin_cleanup(
        self,
        *,
        deadline: float,
        session_replaced: bool,
    ) -> tuple[object | None, WatcherDirtyWriteAttempt | None, object | None]:
        while True:
            if not self._acquire_until(self._thread_start_lock, deadline):
                self._abort_cleanup(session_replaced=session_replaced)
                raise RuntimeError("watcher recovery cleanup deadline is exhausted")
            try:
                with self._retry_lock:
                    if self._thread_starting:
                        retry_starting = True
                    else:
                        retry_starting = False
                        self._require_started_locked()
                        if self._flush_succeeded and not session_replaced:
                            return None, None, None
                        if self._finished or self._session_replaced:
                            raise RuntimeError(
                                "watcher recovery session cannot be stopped cleanly"
                            )
                        self._session_replaced = session_replaced
                        self._stopping = True
                        self._generation += 1
                        timer = self._timer
                        self._timer = None
                        return timer, self._attempt, self._callback_thread
            finally:
                self._thread_start_lock.release()
            if retry_starting and not self._thread_started.wait(
                max(0.0, deadline - self._monotonic_clock())
            ):
                self._abort_cleanup(session_replaced=session_replaced)
                raise RuntimeError("watcher recovery thread start deadline is exhausted")

    def _abort_cleanup(self, *, session_replaced: bool) -> None:
        with self._retry_lock:
            self._session_replaced = self._session_replaced or session_replaced
            self._stopping = True
            self._generation += 1
            timer = self._timer
            self._timer = None
        if timer is not None:
            timer.cancel()

    def _acquire_until(self, lock: object, deadline: float) -> bool:
        return bool(
            lock.acquire(timeout=max(0.0, deadline - self._monotonic_clock()))
        )

    def _require_started_locked(self) -> None:
        if self._library_id is None or self._session_token is None:
            raise RuntimeError("watcher recovery controller is not started")

    def _schedule_retry_locked(self) -> object | None:
        if (
            not self._pending
            or self._timer is not None
            or self._callback_thread is not None
            or self._attempt is not None
            or self._stopping
        ):
            return None
        self._generation += 1
        generation = self._generation
        timer = self._retry_timer_factory(
            self._retry_delay_seconds,
            lambda: self._retry_timer_fired(generation),
        )
        if hasattr(timer, "daemon"):
            timer.daemon = True
        self._timer = timer
        return timer

    def _retry_timer_fired(self, generation: int) -> None:
        with self._thread_start_lock:
            with self._retry_lock:
                if (
                    generation != self._generation
                    or self._timer is None
                    or self._stopping
                    or self._callback_thread is not None
                ):
                    return
                self._timer = None
                root_ids = tuple(sorted(self._pending))
                if not root_ids:
                    return
                self._pending.difference_update(root_ids)
                self._in_flight.update(root_ids)
                operation_deadline = (
                    self._monotonic_clock()
                    + _RETRY_EXECUTION_BUDGET_SECONDS
                    + self._cancellation_reserve_seconds
                )
                thread = self._thread_factory(
                    lambda: self._execute_reserved(
                        root_ids,
                        generation,
                        operation_deadline,
                    ),
                    "watcher-recovery-retry",
                )
                self._callback_thread = thread
                self._thread_starting = True
                self._thread_started.clear()
        start_error = None
        try:
            thread.start()
        except Exception as exc:
            start_error = exc
        finally:
            with self._retry_lock:
                self._thread_starting = False
                if start_error is not None:
                    if self._callback_thread is thread:
                        self._callback_thread = None
                    self._in_flight.difference_update(root_ids)
                    self._pending.update(root_ids)
                    retry_timer = self._schedule_retry_locked()
                else:
                    retry_timer = None
                self._thread_started.set()
        if start_error is not None:
            self._log_failure("retry_thread_start", len(root_ids), start_error)
            if retry_timer is not None:
                retry_timer.start()
            return
        with self._retry_lock:
            if (
                self._callback_thread is thread
                and self._timer is None
                and not self._stopping
            ):
                watchdog = self._retry_timer_factory(
                    _RETRY_EXECUTION_BUDGET_SECONDS,
                    lambda: self._retry_watchdog_fired(generation, thread),
                )
                if hasattr(watchdog, "daemon"):
                    watchdog.daemon = True
                self._timer = watchdog
            else:
                watchdog = None
        if watchdog is not None:
            watchdog.start()

    def _retry_watchdog_fired(self, generation: int, thread: object) -> None:
        with self._retry_lock:
            if (
                generation != self._generation
                or self._callback_thread is not thread
                or self._timer is None
                or self._stopping
            ):
                return
            self._timer = None
            attempt = self._attempt
            root_count = len(self._in_flight)
        try:
            self._cancel_and_join(
                attempt,
                thread,
                self._monotonic_clock() + self._cancellation_reserve_seconds,
            )
        except Exception as exc:
            self._log_failure("retry_watchdog", root_count, exc)

    def _execute_reserved(
        self,
        root_ids: tuple[str, ...],
        generation: int,
        operation_deadline: float,
    ) -> None:
        attempt = None
        outcome = None
        with self._retry_lock:
            stale_before_prepare = generation != self._generation or self._stopping
        if stale_before_prepare:
            self._complete_attempt(root_ids, None, None)
            return
        try:
            library_id, _ = self._started_identity_for_callback()
            attempt = self._repository.prepare_overflow_dirty_write(
                library_id=library_id,
                logical_root_ids=root_ids,
                observed_at=_aware_utc(self._clock()),
                operation_deadline=operation_deadline,
            )
            with self._retry_lock:
                self._attempt = attempt
                stale = generation != self._generation or self._stopping
            if stale:
                try:
                    attempt.cancel()
                except Exception as exc:
                    self._log_failure("stale_retry_cancel", len(root_ids), exc)
                if not attempt.is_terminal or attempt.outcome is None:
                    return
                outcome = attempt.outcome
            else:
                outcome = attempt.execute()
        except Exception as exc:
            self._log_failure("retry", len(root_ids), exc)
            outcome = None
        timer = self._complete_attempt(root_ids, attempt, outcome)
        if timer is not None:
            timer.start()

    def _started_identity_for_callback(self) -> tuple[int, UUID]:
        with self._retry_lock:
            self._require_started_locked()
            library_id = self._library_id
            session_token = self._session_token
        assert library_id is not None and session_token is not None
        return library_id, session_token

    def _complete_attempt(
        self,
        root_ids: tuple[str, ...],
        attempt: WatcherDirtyWriteAttempt | None,
        outcome: WatcherDirtyWriteOutcome | None,
    ) -> object | None:
        committed: set[str] = set()
        if outcome is not None and outcome.state == "committed":
            committed = set(outcome.committed_root_ids).intersection(root_ids)
        with self._retry_lock:
            if self._attempt is attempt:
                self._attempt = None
            self._callback_thread = None
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            self._in_flight.difference_update(root_ids)
            self._pending.update(set(root_ids) - committed)
            return self._schedule_retry_locked()

    def _cancel_and_join(
        self,
        attempt: WatcherDirtyWriteAttempt | None,
        thread: object,
        deadline: float,
    ) -> None:
        cancel_error = None
        if attempt is not None:
            try:
                attempt.cancel()
            except Exception as exc:
                cancel_error = exc.__class__
        thread.join(max(0.0, deadline - self._monotonic_clock()))
        if thread.is_alive():
            raise RuntimeError("watcher recovery callback did not join")
        if attempt is not None and (not attempt.is_terminal or attempt.outcome is None):
            raise RuntimeError("watcher recovery attempt did not terminate")
        if cancel_error is not None:
            raise RuntimeError("watcher recovery attempt could not be cancelled")

    def _run_final_flush(self, root_ids: tuple[str, ...], deadline: float) -> None:
        if deadline - self._monotonic_clock() <= self._cancellation_reserve_seconds:
            raise RuntimeError("watcher recovery flush deadline is exhausted")
        library_id, _ = self._started_identity_for_callback()
        attempt = self._repository.prepare_overflow_dirty_write(
            library_id=library_id,
            logical_root_ids=root_ids,
            observed_at=_aware_utc(self._clock()),
            operation_deadline=deadline,
        )
        with self._retry_lock:
            self._pending.difference_update(root_ids)
            self._in_flight.update(root_ids)
        outcome = None
        try:
            outcome = self._run_final_attempt(attempt, deadline, "final_flush", len(root_ids))
        finally:
            with self._retry_lock:
                terminated = self._attempt is None and self._callback_thread is None
            if terminated:
                self._complete_attempt(root_ids, attempt, outcome)

    def _run_final_attempt(
        self,
        attempt: WatcherDirtyWriteAttempt | WatcherSessionFinishAttempt,
        deadline: float,
        operation: str,
        root_count: int = 0,
    ) -> WatcherDirtyWriteOutcome | WatcherSessionFinishOutcome:
        errors: list[Exception] = []

        def execute() -> None:
            try:
                attempt.execute()
            except Exception as exc:
                self._log_failure(operation, root_count, exc)
                errors.append(exc)

        if not self._acquire_until(self._thread_start_lock, deadline):
            raise RuntimeError("watcher recovery final operation deadline is exhausted")
        try:
            with self._retry_lock:
                self._attempt = attempt
                thread = self._thread_factory(
                    execute,
                    f"watcher-recovery-{operation}",
                )
                self._callback_thread = thread
                self._thread_starting = True
                self._thread_started.clear()
        finally:
            self._thread_start_lock.release()
        try:
            thread.start()
        except Exception:
            # A start implementation can fail after launching its callback.
            # Keep ownership unless both thread exit and transaction are proved.
            if thread.is_alive():
                self._cancel_and_join(attempt, thread, deadline)
            else:
                attempt.cancel()
            if not thread.is_alive() and attempt.is_terminal and attempt.outcome is not None:
                with self._retry_lock:
                    self._attempt = None
                    self._callback_thread = None
            raise
        finally:
            with self._retry_lock:
                self._thread_starting = False
                self._thread_started.set()

        cancel_at = deadline - self._cancellation_reserve_seconds
        cancel_error = None
        thread.join(max(0.0, cancel_at - self._monotonic_clock()))
        if thread.is_alive():
            try:
                attempt.cancel()
            except Exception as exc:
                cancel_error = exc.__class__
            thread.join(max(0.0, deadline - self._monotonic_clock()))
        if thread.is_alive() or not attempt.is_terminal or attempt.outcome is None:
            raise RuntimeError("watcher recovery final operation did not terminate")
        with self._retry_lock:
            self._attempt = None
            self._callback_thread = None
        if cancel_error is not None:
            raise RuntimeError("watcher recovery final operation cancellation failed")
        if errors:
            raise errors[0]
        return attempt.outcome

    @staticmethod
    def _log_failure(operation: str, root_count: int, exc: BaseException) -> None:
        _LOGGER.warning(
            "watcher recovery operation failed",
            extra={
                "operation": operation,
                "root_count": root_count,
                "exception_class": exc.__class__.__name__,
            },
        )


__all__ = [
    "WatcherSessionRecoveryController",
    "WatcherSessionRecoveryRepository",
]
