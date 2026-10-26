"""Coalesced, bounded scheduling for targeted library reconciliation."""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass
import logging
from pathlib import Path
from threading import Event, RLock
from typing import Any

from music_app.services.library_event_coordinator import (
    CoordinatorProblem,
    TargetedMove,
    TargetedReconciliationRequest,
)
from music_app.services.runtime_shutdown import create_daemon_executor


@dataclass(frozen=True, slots=True)
class _CatchUpBatch:
    root_ids: frozenset[str]

    @property
    def root_id(self) -> str:
        return min(self.root_ids, default="")


class TargetedReconciliationScheduler:
    """Run one reconciliation at a time and coalesce queued work by root."""

    def __init__(
        self,
        *,
        reconcile: Callable[[TargetedReconciliationRequest], object],
        catch_up: Callable[[frozenset[str]], object],
        record_problem: Callable[[CoordinatorProblem], object],
        clear_recovered: Callable[[frozenset[str]], object],
        max_pending_roots: int = 256,
        executor: Any | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self._reconcile = reconcile
        self._catch_up = catch_up
        self._record_problem = record_problem
        self._clear_recovered = clear_recovered
        self._max_pending_roots = max(1, int(max_pending_roots))
        self._executor = executor or create_daemon_executor(
            max_workers=1,
            thread_name_prefix="albumhaven-targeted-reconciliation",
        )
        self._logger = logger or logging.getLogger("music_app")
        self._lock = RLock()
        self._idle = Event()
        self._idle.set()
        self._active = False
        self._pending: OrderedDict[str, TargetedReconciliationRequest] = OrderedDict()
        self._catch_up_roots: set[str] = set()
        self._failed_catch_up_roots: set[str] = set()
        self._stopped = False

    def submit(self, request: TargetedReconciliationRequest) -> bool:
        affected_roots = _affected_root_ids(request)
        dispatch: TargetedReconciliationRequest | None = None
        overflow_roots: frozenset[str] = frozenset()
        with self._lock:
            if self._stopped:
                return False
            retry_roots = affected_roots.intersection(self._failed_catch_up_roots)
            if retry_roots:
                self._failed_catch_up_roots.difference_update(retry_roots)
                self._catch_up_roots.update(retry_roots)
            if not self._active:
                self._active = True
                self._idle.clear()
                dispatch = request
            else:
                pending = self._pending.get(request.root_id)
                if pending is not None:
                    self._pending[request.root_id] = _merge_requests(pending, request)
                elif len(self._pending) < self._max_pending_roots:
                    self._pending[request.root_id] = request
                else:
                    overflow_roots = affected_roots.difference(
                        self._catch_up_roots,
                        self._failed_catch_up_roots,
                    )
                    self._catch_up_roots.update(affected_roots)
                    # Recovery cannot overtake durable overflow persistence.
                    # The active completion callback must wait for this lock
                    # before it can dispatch and later clear the catch-up.
                    self._record_problems("overflow", overflow_roots)
        if dispatch is not None:
            self._dispatch_request(dispatch)
        return True

    def wait_for_idle(self, *, timeout: float | None = None) -> bool:
        return self._idle.wait(timeout)

    def shutdown(
        self,
        *,
        wait: bool = False,
        timeout: float | None = None,
        cancel_futures: bool = True,
    ) -> bool:
        with self._lock:
            self._stopped = True
            self._pending.clear()
            self._catch_up_roots.clear()
            self._failed_catch_up_roots.clear()
            if not self._active:
                self._idle.set()
        if wait:
            quiesced = self._idle.wait(timeout)
            self._executor.shutdown(
                wait=quiesced,
                cancel_futures=cancel_futures,
            )
            return quiesced
        self._executor.shutdown(wait=False, cancel_futures=cancel_futures)
        return self._idle.is_set()

    def _dispatch_request(self, request: TargetedReconciliationRequest) -> None:
        try:
            future = self._executor.submit(self._reconcile, request)
        except Exception:
            self._logger.exception("Unable to submit targeted library reconciliation.")
            future = None
        if future is None:
            roots = _affected_root_ids(request)
            with self._lock:
                self._catch_up_roots.update(roots)
            self._record_problems("overflow", roots)
            self._advance()
            return
        future.add_done_callback(
            lambda completed: self._complete_request(completed, request)
        )

    def _complete_request(
        self,
        completed: Future,
        request: TargetedReconciliationRequest,
    ) -> None:
        try:
            completed.result()
        except Exception:
            self._logger.exception("Targeted library reconciliation failed.")
            self._record_problems("reconciliation_failed", _affected_root_ids(request))
        self._advance()

    def _dispatch_catch_up(self, root_ids: frozenset[str]) -> None:
        batch = _CatchUpBatch(root_ids)
        try:
            future = self._executor.submit(self._run_catch_up, batch)
        except Exception:
            self._logger.exception("Unable to submit library watcher catch-up.")
            future = None
        if future is None:
            with self._lock:
                self._failed_catch_up_roots.update(root_ids)
            self._record_problems("reconciliation_failed", root_ids)
            self._advance()
            return
        future.add_done_callback(
            lambda completed: self._complete_catch_up(completed, batch)
        )

    def _run_catch_up(self, batch: _CatchUpBatch) -> object:
        return self._catch_up(batch.root_ids)

    def _complete_catch_up(self, completed: Future, batch: _CatchUpBatch) -> None:
        try:
            completed.result()
        except Exception:
            self._logger.exception("Library watcher catch-up failed.")
            with self._lock:
                self._failed_catch_up_roots.update(batch.root_ids)
            self._record_problems("reconciliation_failed", batch.root_ids)
        else:
            try:
                self._clear_recovered(batch.root_ids)
            except Exception:
                self._logger.exception("Unable to clear recovered library watcher health.")
                with self._lock:
                    self._failed_catch_up_roots.update(batch.root_ids)
                self._record_problems("reconciliation_failed", batch.root_ids)
        self._advance()

    def _advance(self) -> None:
        request: TargetedReconciliationRequest | None = None
        catch_up_roots: frozenset[str] = frozenset()
        with self._lock:
            if self._stopped:
                self._active = False
                self._idle.set()
                return
            if self._pending:
                _root_id, request = self._pending.popitem(last=False)
            elif self._catch_up_roots:
                catch_up_roots = frozenset(self._catch_up_roots)
                self._catch_up_roots.clear()
            else:
                self._active = False
                self._idle.set()
                return
        if request is not None:
            self._dispatch_request(request)
        else:
            self._dispatch_catch_up(catch_up_roots)

    def _record_problems(self, code: str, root_ids: frozenset[str]) -> None:
        for root_id in sorted(root_ids):
            try:
                self._record_problem(CoordinatorProblem(code, root_id))
            except Exception:
                self._logger.exception("Unable to persist library watcher health problem.")


def _affected_root_ids(request: TargetedReconciliationRequest) -> frozenset[str]:
    root_ids = {str(request.root_id)}
    for move in request.moves:
        root_ids.add(str(move.source_root_id))
        root_ids.add(str(move.destination_root_id))
    return frozenset(root_id for root_id in root_ids if root_id)


def _merge_requests(
    earlier: TargetedReconciliationRequest,
    later: TargetedReconciliationRequest,
) -> TargetedReconciliationRequest:
    later_deleted_paths = set(later.deleted_paths)
    later_deleted_subtrees = set(later.deleted_subtrees)
    later_move_sources = {move.source for move in later.moves}

    def deleted_later(path: Path) -> bool:
        return (
            path in later_deleted_paths
            or path in later_move_sources
            or any(
                parent == path or parent in path.parents
                for parent in later_deleted_subtrees
            )
        )

    moves: dict[tuple[Path, Path, str, str], TargetedMove] = {
        (
            move.source,
            move.destination,
            move.source_root_id,
            move.destination_root_id,
        ): move
        for move in (*earlier.moves, *later.moves)
    }
    return TargetedReconciliationRequest(
        root_id=earlier.root_id,
        paths=(
            frozenset(path for path in earlier.paths if not deleted_later(path))
            | later.paths
        ),
        deleted_paths=(earlier.deleted_paths - later.paths) | later.deleted_paths,
        deleted_subtrees=earlier.deleted_subtrees | later.deleted_subtrees,
        moves=tuple(moves.values()),
        preserved_subtrees=earlier.preserved_subtrees | later.preserved_subtrees,
    )


__all__ = ("TargetedReconciliationScheduler",)
