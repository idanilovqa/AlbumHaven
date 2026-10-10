"""Synchronous durable admission for normalized library watcher events."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from threading import Lock

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
    ) -> None:
        self._accept_event = accept_event
        self._record_problem = record_problem
        self._lock = Lock()
        self._stopped = False

    def accept(self, event: LibraryEvent) -> bool:
        with self._lock:
            if self._stopped:
                return False
        if event.kind in {
            LibraryEventKind.ROOT_UNAVAILABLE,
            LibraryEventKind.OVERFLOW,
        }:
            self._record_problem(CoordinatorProblem(event.kind.value, event.root_id))
        else:
            self._accept_event(event)
        return True

    def stop(self) -> bool:
        with self._lock:
            if self._stopped:
                return False
            self._stopped = True
        return True


__all__ = [
    "CoordinatorProblem",
    "LibraryEventCoordinator",
    "TargetedMove",
    "TargetedReconciliationRequest",
]
