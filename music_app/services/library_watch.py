"""Filesystem event intake for configured music-library roots."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from threading import Lock
from typing import Protocol


class LibraryEventKind(str, Enum):
    CREATED = "created"
    MODIFIED = "modified"
    DELETED = "deleted"
    MOVED = "moved"
    ROOT_UNAVAILABLE = "root_unavailable"
    OVERFLOW = "overflow"


@dataclass(frozen=True, slots=True)
class LibraryEvent:
    kind: LibraryEventKind
    root_id: str
    path: Path
    destination: Path | None = None
    observed_at: float = 0.0
    destination_root_id: str | None = None
    is_directory: bool = False


class LibraryEventSource(Protocol):
    @property
    def is_alive(self) -> bool: ...

    def start(self, publish: Callable[[LibraryEvent], None]) -> None: ...

    def stop(self, *, timeout: float) -> None: ...

    def replace_roots(self, roots: Iterable[Mapping[str, object]]) -> None: ...


def _resolved_roots(
    roots: Iterable[Mapping[str, object]],
) -> tuple[tuple[str, Path], ...]:
    resolved = []
    for root in roots:
        root_id = str(root.get("id") or "").strip()
        root_path = str(root.get("path") or "").strip()
        if root_id and root_path:
            resolved.append((root_id, Path(root_path).resolve(strict=False)))
    return tuple(resolved)


def _root_for_path(
    path: Path,
    roots: tuple[tuple[str, Path], ...],
) -> tuple[str, Path] | None:
    matches = [
        item
        for item in roots
        if path == item[1] or path.is_relative_to(item[1])
    ]
    return max(matches, key=lambda item: len(item[1].parts), default=None)


def normalize_library_event(
    kind: LibraryEventKind | str,
    path: Path | str,
    *,
    roots: Iterable[Mapping[str, object]],
    destination: Path | str | None = None,
    observed_at: float = 0.0,
    is_directory: bool = False,
) -> LibraryEvent | None:
    if isinstance(kind, LibraryEventKind):
        normalized_kind = kind
    else:
        try:
            normalized_kind = LibraryEventKind(str(kind))
        except ValueError:
            return None
    source_path = Path(path).resolve(strict=False)
    root_definitions = _resolved_roots(roots)
    source_root = _root_for_path(source_path, root_definitions)
    if source_root is None:
        return None
    destination_path = (
        Path(destination).resolve(strict=False)
        if destination is not None
        else None
    )
    if normalized_kind is LibraryEventKind.MOVED:
        if destination_path is None:
            return None
        destination_root = _root_for_path(destination_path, root_definitions)
        if destination_root is None:
            return None
    else:
        destination_root = None
    return LibraryEvent(
        normalized_kind,
        source_root[0],
        source_path,
        destination_path,
        float(observed_at or 0.0),
        destination_root[0] if destination_root is not None else None,
        bool(is_directory),
    )


def watchdog_event_kind(event_type: object) -> LibraryEventKind | None:
    return {
        "created": LibraryEventKind.CREATED,
        "modified": LibraryEventKind.MODIFIED,
        "deleted": LibraryEventKind.DELETED,
        "moved": LibraryEventKind.MOVED,
    }.get(str(event_type or "").strip().casefold())


def publish_watchdog_event(
    event: object,
    *,
    roots: Iterable[Mapping[str, object]],
    publish: Callable[[LibraryEvent], None],
    clock: Callable[[], float],
) -> None:
    kind = watchdog_event_kind(getattr(event, "event_type", ""))
    if kind is None:
        return
    root_definitions = tuple(dict(root) for root in roots)
    observed_at = clock()
    source_path = Path(getattr(event, "src_path", "")).resolve(strict=False)
    if bool(getattr(event, "is_directory", False)) and kind in {
        LibraryEventKind.DELETED,
        LibraryEventKind.MOVED,
    }:
        configured_root = next(
            (
                (root_id, root_path)
                for root_id, root_path in _resolved_roots(root_definitions)
                if source_path == root_path
            ),
            None,
        )
        if configured_root is not None:
            publish(
                LibraryEvent(
                    LibraryEventKind.ROOT_UNAVAILABLE,
                    configured_root[0],
                    configured_root[1],
                    observed_at=observed_at,
                    is_directory=True,
                )
            )
            return
    if getattr(event, "is_directory", False) and kind not in {
        LibraryEventKind.DELETED,
        LibraryEventKind.MOVED,
    }:
        return
    normalized = normalize_library_event(
        kind,
        getattr(event, "src_path", ""),
        destination=getattr(event, "dest_path", None),
        roots=root_definitions,
        observed_at=observed_at,
        is_directory=bool(getattr(event, "is_directory", False)),
    )
    if normalized is not None:
        publish(normalized)


class WatchdogLibraryEventSource:
    def __init__(
        self,
        roots: Iterable[Mapping[str, object]],
        *,
        observer_factory: Callable[[], object] | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._roots = tuple(dict(root) for root in roots)
        self._observer_factory = observer_factory
        self._clock = clock
        self._observer: object | None = None

    @property
    def is_alive(self) -> bool:
        return bool(self._observer is not None and self._observer.is_alive())

    def start(self, publish: Callable[[LibraryEvent], None]) -> None:
        if self._observer is not None:
            raise RuntimeError("Library event source is already started")
        from time import monotonic
        from watchdog.events import FileSystemEventHandler
        from watchdog.observers import Observer

        observer = self._observer_factory() if self._observer_factory else Observer()
        clock = self._clock or monotonic
        roots = self._roots

        class Handler(FileSystemEventHandler):
            def on_any_event(self, event) -> None:
                publish_watchdog_event(
                    event,
                    roots=roots,
                    publish=publish,
                    clock=clock,
                )

        handler = Handler()
        for root_id, root_path in _resolved_roots(roots):
            if not root_path.is_dir():
                publish(
                    LibraryEvent(
                        LibraryEventKind.ROOT_UNAVAILABLE,
                        root_id,
                        root_path,
                        observed_at=clock(),
                    )
                )
                continue
            observer.schedule(handler, str(root_path), recursive=True)
        self._observer = observer
        observer.start()

    def stop(self, *, timeout: float) -> None:
        observer = self._observer
        if observer is None:
            return
        observer.stop()
        observer.join(timeout)
        if observer.is_alive():
            raise RuntimeError("Library event source did not stop before the deadline")
        self._observer = None

    def replace_roots(self, roots: Iterable[Mapping[str, object]]) -> None:
        if self._observer is not None:
            raise RuntimeError("Stop the library event source before replacing roots")
        self._roots = tuple(dict(root) for root in roots)


class LibraryWatchService:
    def __init__(
        self,
        event_source: LibraryEventSource,
        on_event: Callable[[LibraryEvent], None],
        *,
        stop_timeout: float = 5.0,
    ) -> None:
        self._event_source = event_source
        self._on_event = on_event
        self._stop_timeout = float(stop_timeout)
        self._lock = Lock()
        self._started = False

    @property
    def is_alive(self) -> bool:
        return bool(self._started and self._event_source.is_alive)

    def start(self) -> bool:
        with self._lock:
            if self._started:
                return False
            self._event_source.start(self._on_event)
            self._started = True
            return True

    def stop(self) -> bool:
        with self._lock:
            if not self._started:
                return False
            self._started = False
        self._event_source.stop(timeout=self._stop_timeout)
        return True

    def replace_roots(self, roots: Iterable[Mapping[str, object]]) -> bool:
        with self._lock:
            was_started = self._started
        if was_started:
            self.stop()
        replace_roots = getattr(self._event_source, "replace_roots", None)
        if not callable(replace_roots):
            if was_started:
                self.start()
            return False
        replace_roots(roots)
        if was_started:
            self.start()
        return True
