"""Synchronous durable admission for normalized library watcher events."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from threading import Lock, RLock, Timer

from music_app.services.library_reconciliation import LibraryEvent, LibraryEventKind


@dataclass(frozen=True, slots=True)
class TargetedMove:
    source: Path
    destination: Path
    source_root_id: str
    destination_root_id: str
    is_directory: bool = False


@dataclass(frozen=True, slots=True)
class TargetedReconciliationRequest:
    root_id: str
    producer_request_key: str | None = None
    paths: frozenset[Path] = frozenset()
    deleted_paths: frozenset[Path] = frozenset()
    deleted_subtrees: frozenset[Path] = frozenset()
    moves: tuple[TargetedMove, ...] = ()
    preserved_subtrees: frozenset[Path] = frozenset()


@dataclass(frozen=True, slots=True)
class CoordinatorProblem:
    code: str
    root_id: str


class LibraryEventCoordinator:
    """Commit each watcher observation before reporting acceptance."""

    def __init__(
        self,
        accept_event: Callable[[LibraryEvent], object],
        *,
        record_problem: Callable[[CoordinatorProblem], object],
        retry_timer_factory: Callable[[float, Callable[[], None]], object] = Timer,
        retry_delay_seconds: float = 1.0,
    ) -> None:
        self._accept_event = accept_event
        self._record_problem = record_problem
        self._lock = Lock()
        self._operation_lock = RLock()
        self._stopped = False
        self._pending_problems: dict[str, CoordinatorProblem] = {}
        self._retry_timer_factory = retry_timer_factory
        self._retry_delay_seconds = max(0.0, float(retry_delay_seconds))
        self._retry_timer: object | None = None

    def accept(self, event: LibraryEvent) -> bool:
        with self._operation_lock:
            with self._lock:
                if self._stopped:
                    return False
            self._retry_pending(raise_error=True)
            if event.kind in {
                LibraryEventKind.ROOT_UNAVAILABLE,
                LibraryEventKind.OVERFLOW,
            }:
                self._record_or_queue(
                    CoordinatorProblem(event.kind.value, event.root_id)
                )
            else:
                try:
                    self._accept_event(event)
                except Exception:
                    root_ids = {event.root_id}
                    if event.destination_root_id:
                        root_ids.add(event.destination_root_id)
                    for root_id in sorted(root_ids):
                        try:
                            self._record_or_queue(
                                CoordinatorProblem("root_unavailable", root_id)
                            )
                        except Exception:
                            pass
                    raise
        return True

    def _record_or_queue(self, problem: CoordinatorProblem) -> None:
        with self._lock:
            self._pending_problems[problem.root_id] = problem
        try:
            self._record_problem(problem)
        except Exception:
            with self._lock:
                self._schedule_retry_locked()
            raise
        with self._lock:
            if self._pending_problems.get(problem.root_id) is problem:
                self._pending_problems.pop(problem.root_id, None)

    def _retry_pending(self, *, raise_error: bool = False) -> None:
        with self._operation_lock:
            with self._lock:
                timer = self._retry_timer
                self._retry_timer = None
                if self._stopped:
                    pending = ()
                else:
                    pending = tuple(self._pending_problems.values())
            cancel = getattr(timer, "cancel", None)
            if callable(cancel):
                cancel()
            first_error: Exception | None = None
            for problem in pending:
                try:
                    self._record_problem(problem)
                except Exception as exc:
                    if first_error is None:
                        first_error = exc
                else:
                    with self._lock:
                        if self._pending_problems.get(problem.root_id) is problem:
                            self._pending_problems.pop(problem.root_id, None)
            with self._lock:
                self._schedule_retry_locked()
            if raise_error and first_error is not None:
                raise first_error

    def _schedule_retry_locked(self) -> None:
        if self._stopped or self._retry_timer is not None or not self._pending_problems:
            return
        timer = self._retry_timer_factory(
            self._retry_delay_seconds,
            lambda: self._retry_pending(raise_error=False),
        )
        timer.daemon = True
        self._retry_timer = timer
        timer.start()

    def stop(self) -> bool:
        with self._lock:
            if self._stopped:
                return False
            self._stopped = True
            timer = self._retry_timer
            self._retry_timer = None
        cancel = getattr(timer, "cancel", None)
        if callable(cancel):
            cancel()
        with self._operation_lock:
            pass
        return True


__all__ = [
    "CoordinatorProblem",
    "LibraryEventCoordinator",
    "TargetedMove",
    "TargetedReconciliationRequest",
]
