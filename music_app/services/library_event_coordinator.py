"""Deterministic debounce and stable-write coordination for library events."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock, Timer
from time import monotonic, sleep

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
    paths: frozenset[Path] = frozenset()
    deleted_paths: frozenset[Path] = frozenset()
    deleted_subtrees: frozenset[Path] = frozenset()
    moves: tuple[TargetedMove, ...] = ()


@dataclass(frozen=True, slots=True)
class CoordinatorProblem:
    code: str
    root_id: str


@dataclass(slots=True)
class _PendingGroup:
    root_id: str
    directory: Path
    active_paths: set[Path] = field(default_factory=set)
    deleted_paths: set[Path] = field(default_factory=set)
    deleted_subtrees: set[Path] = field(default_factory=set)
    moves: dict[tuple[Path, Path], TargetedMove] = field(default_factory=dict)


class LibraryEventCoordinator:
    def __init__(
        self,
        *,
        emit_request: Callable[[TargetedReconciliationRequest], None],
        emit_health_event: Callable[[LibraryEvent], None] | None = None,
        emit_problem: Callable[[CoordinatorProblem], None] | None = None,
        stat_path: Callable[[Path], object] | None = None,
        wait: Callable[[float], None] | None = None,
        max_pending_groups: int = 256,
        max_stable_attempts: int = 4,
        stable_sample_interval: float = 0.1,
        debounce_seconds: float = 0.5,
        max_flush_delay_seconds: float = 5.0,
        auto_schedule: bool = False,
        clock: Callable[[], float] | None = None,
        timer_factory: Callable[[float, Callable[[], None]], Timer] | None = None,
    ) -> None:
        self._emit_request = emit_request
        self._emit_health_event = emit_health_event or (lambda _event: None)
        self._emit_problem = emit_problem or (lambda _problem: None)
        self._stat_path = stat_path or Path.stat
        self._wait = wait or sleep
        self._max_pending_groups = max(1, int(max_pending_groups))
        self._max_stable_attempts = max(2, int(max_stable_attempts))
        self._stable_sample_interval = max(0.0, float(stable_sample_interval))
        self._debounce_seconds = max(0.0, float(debounce_seconds))
        self._max_flush_delay_seconds = max(
            self._debounce_seconds,
            float(max_flush_delay_seconds),
        )
        self._auto_schedule = bool(auto_schedule)
        self._clock = clock or monotonic
        self._timer_factory = timer_factory or Timer
        self._pending: dict[tuple[str, Path], _PendingGroup] = {}
        self._lock = Lock()
        self._timer: Timer | None = None
        self._pending_started_at: float | None = None
        self._stopped = False

    def accept(self, event: LibraryEvent) -> bool:
        if event.kind in {LibraryEventKind.ROOT_UNAVAILABLE, LibraryEventKind.OVERFLOW}:
            self._emit_health_event(event)
            return True
        group_key = (event.root_id, event.path.parent)
        overflow_events: tuple[LibraryEvent, ...] = ()
        with self._lock:
            if self._stopped:
                return False
            if event.kind is LibraryEventKind.MOVED and event.destination is not None:
                self._clear_superseded_deletions(
                    event.destination_root_id or event.root_id,
                    event.destination,
                )
            elif event.kind is not LibraryEventKind.DELETED:
                self._clear_superseded_deletions(event.root_id, event.path)
            group = self._pending.get(group_key)
            if group is None:
                if len(self._pending) >= self._max_pending_groups:
                    affected_roots = {event.root_id: event.path.parent}
                    if (
                        event.kind is LibraryEventKind.MOVED
                        and event.destination is not None
                    ):
                        affected_roots[
                            event.destination_root_id or event.root_id
                        ] = event.destination.parent
                    overflow_events = tuple(
                        LibraryEvent(
                            LibraryEventKind.OVERFLOW,
                            root_id,
                            path,
                            observed_at=event.observed_at,
                        )
                        for root_id, path in affected_roots.items()
                    )
                else:
                    group = _PendingGroup(event.root_id, event.path.parent)
                    self._pending[group_key] = group
            if not overflow_events:
                self._coalesce(group, event)
                if self._auto_schedule:
                    self._schedule_flush_locked()
                return True
        for overflow_event in overflow_events:
            self._emit_health_event(overflow_event)
        return False

    def _clear_superseded_deletions(self, root_id: str, live_path: Path) -> None:
        for group_key, group in tuple(self._pending.items()):
            if group.root_id != root_id:
                continue
            if live_path in group.deleted_paths or live_path in group.deleted_subtrees:
                group.deleted_subtrees.discard(live_path)
                group.deleted_paths.discard(live_path)
            if any(subtree in live_path.parents for subtree in group.deleted_subtrees):
                group.active_paths.add(live_path)
            if not (
                group.active_paths
                or group.deleted_paths
                or group.deleted_subtrees
                or group.moves
            ):
                self._pending.pop(group_key, None)

    def _coalesce(self, group: _PendingGroup, event: LibraryEvent) -> None:
        if event.kind is LibraryEventKind.DELETED:
            group.active_paths.discard(event.path)
            if event.is_directory:
                group.deleted_subtrees.add(event.path)
            else:
                group.deleted_paths.add(event.path)
                # Windows watchdog can emit FileDeletedEvent for a directory
                # because the path no longer exists when it is classified.
                # Treat the path as a possible subtree as well. The persistence
                # predicate uses a separator boundary, so ordinary file paths
                # cannot stale similarly prefixed siblings.
                group.deleted_subtrees.add(event.path)
            return
        if event.kind is LibraryEventKind.MOVED and event.destination is not None:
            group.active_paths.discard(event.path)
            group.deleted_paths.discard(event.path)
            move = TargetedMove(
                event.path,
                event.destination,
                event.root_id,
                event.destination_root_id or event.root_id,
                event.is_directory,
            )
            group.moves[(move.source, move.destination)] = move
            return
        group.deleted_paths.discard(event.path)
        group.deleted_subtrees.discard(event.path)
        group.active_paths.add(event.path)

    def _schedule_flush_locked(self) -> None:
        now = self._clock()
        if self._pending_started_at is None:
            self._pending_started_at = now
        maximum_delay_remaining = max(
            0.0,
            self._max_flush_delay_seconds - (now - self._pending_started_at),
        )
        if self._timer is not None:
            self._timer.cancel()
        timer = self._timer_factory(
            min(self._debounce_seconds, maximum_delay_remaining),
            self.flush,
        )
        timer.daemon = True
        self._timer = timer
        timer.start()

    def flush(self) -> None:
        with self._lock:
            pending = list(self._pending.values())
            self._pending.clear()
            timer = self._timer
            self._timer = None
            self._pending_started_at = None
        if timer is not None:
            timer.cancel()
        for group in sorted(
            pending,
            key=lambda item: (item.root_id, str(item.directory).casefold()),
        ):
            self._emit_group(group)

    def _emit_group(self, group: _PendingGroup) -> None:
        ready: set[Path] = set()
        deleted = set(group.deleted_paths)
        deleted_subtrees = set(group.deleted_subtrees)
        for path in sorted(group.active_paths, key=lambda value: str(value).casefold()):
            disposition = self._stable_disposition(path, group.root_id)
            if disposition == "ready":
                ready.add(path)
            elif disposition == "deleted":
                deleted.add(path)

        ready_moves = []
        for move in sorted(
            group.moves.values(),
            key=lambda value: (str(value.source).casefold(), str(value.destination).casefold()),
        ):
            disposition = self._stable_disposition(
                move.destination,
                move.destination_root_id,
                related_root_ids=(move.source_root_id,),
            )
            if disposition == "ready":
                ready_moves.append(move)
            elif disposition == "deleted":
                if move.is_directory:
                    deleted_subtrees.add(move.source)
                else:
                    deleted.add(move.source)
        if not ready and not deleted and not deleted_subtrees and not ready_moves:
            return
        self._emit_request(
            TargetedReconciliationRequest(
                root_id=group.root_id,
                paths=frozenset(ready),
                deleted_paths=frozenset(deleted),
                deleted_subtrees=frozenset(deleted_subtrees),
                moves=tuple(ready_moves),
            )
        )

    def _stable_disposition(
        self,
        path: Path,
        root_id: str,
        *,
        related_root_ids: tuple[str, ...] = (),
    ) -> str:
        previous: tuple[int, int] | None = None
        for attempt in range(self._max_stable_attempts):
            try:
                current = _stat_signature(self._stat_path(path))
            except FileNotFoundError:
                return "deleted"
            except (OSError, PermissionError):
                current = None
            if current is not None and current == previous:
                return "ready"
            previous = current
            if attempt + 1 < self._max_stable_attempts:
                self._wait(self._stable_sample_interval)
        for affected_root_id in dict.fromkeys((root_id, *related_root_ids)):
            self._emit_problem(
                CoordinatorProblem("stable_write_unavailable", affected_root_id)
            )
        return "problem"

    def stop(self) -> bool:
        with self._lock:
            if self._stopped:
                return False
            self._stopped = True
        self.flush()
        return True


def _stat_signature(value: object) -> tuple[int, int]:
    if isinstance(value, tuple) and len(value) >= 2:
        return int(value[0]), int(value[1])
    return int(getattr(value, "st_size")), int(getattr(value, "st_mtime_ns"))
