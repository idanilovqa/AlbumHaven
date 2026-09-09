"""Filesystem event intake for configured music-library roots."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from enum import Enum
import logging
from pathlib import Path
import sys
from threading import Event, Lock
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
    destination_path = (
        Path(destination).resolve(strict=False)
        if destination is not None
        else None
    )
    if normalized_kind is LibraryEventKind.MOVED:
        if destination_path is None:
            return None
        destination_root = _root_for_path(destination_path, root_definitions)
        if source_root is None and destination_root is None:
            return None
        if source_root is None:
            normalized_kind = LibraryEventKind.CREATED
            source_path, source_root = destination_path, destination_root
            destination_path = destination_root = None
        elif destination_root is None:
            normalized_kind = LibraryEventKind.DELETED
            destination_path = None
    else:
        destination_root = None
    if source_root is None:
        return None
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
    if kind in {
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
        self._emitters: tuple[object, ...] = ()
        self._stopping = Event()

    @property
    def is_alive(self) -> bool:
        return bool(
            self._observer is not None
            and self._observer.is_alive()
            and all(emitter.is_alive() for emitter in self._emitters)
        )

    def _instrument_emitter(self, emitter, *, publish, clock) -> None:
        """Bridge failures before Watchdog discards their native evidence."""
        import os

        watch_path = Path(emitter.watch.path).resolve(strict=False)
        watched_roots = tuple(
            (root_id, root_path)
            for root_id, root_path in _resolved_roots(self._roots)
            if root_path == watch_path
        )

        def report(kind):
            if self._stopping.is_set():
                return
            observed_at = clock()
            for root_id, root_path in watched_roots:
                publish(LibraryEvent(
                    kind, root_id, root_path,
                    observed_at=observed_at, is_directory=True,
                ))

        run = emitter.run

        def run_with_health():
            try:
                run()
            finally:
                # The dispatcher can outlive a failed or self-stopped producer.
                report(LibraryEventKind.ROOT_UNAVAILABLE)

        emitter.run = run_with_health
        if os.name == "nt":
            from watchdog.observers.read_directory_changes import WindowsApiEmitter

            if isinstance(emitter, WindowsApiEmitter):
                read_events = emitter._read_events

                def read_events_with_health():
                    try:
                        events = read_events()
                    except OSError as exc:
                        if getattr(exc, "winerror", None) != 1022:  # ERROR_NOTIFY_ENUM_DIR
                            raise
                        events = []
                    if not events:
                        # Watchdog 4–6 converts the native zero-byte overflow
                        # indication to []. Source shutdown also returns [],
                        # but report() excludes that intentional cancellation.
                        report(LibraryEventKind.OVERFLOW)
                    return events

                emitter._read_events = read_events_with_health

    def start(self, publish: Callable[[LibraryEvent], None]) -> None:
        if self._observer is not None:
            raise RuntimeError("Library event source is already started")
        if sys.platform.startswith("linux") and self._observer_factory is None:
            logging.getLogger(__name__).info(
                "Automatic library updates are disabled on Linux for this release. "
                "Run Full Rescan after library changes."
            )
            return
        from time import monotonic
        from watchdog.events import FileSystemEventHandler
        from watchdog.observers import Observer

        observer = self._observer_factory() if self._observer_factory else Observer()
        clock = self._clock or monotonic
        roots = self._roots
        self._stopping.clear()

        class Handler(FileSystemEventHandler):
            def on_any_event(self, event) -> None:
                publish_watchdog_event(
                    event,
                    roots=roots,
                    publish=publish,
                    clock=clock,
                )

        handler = Handler()
        self._observer = observer
        try:
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
            self._emitters = tuple(getattr(observer, "emitters", ()))
            for emitter in self._emitters:
                self._instrument_emitter(emitter, publish=publish, clock=clock)
            observer.start()
        except Exception:
            # on_thread_start runs before run(), so its failures cannot reach
            # the producer's finally bridge. The whole aborted source is lost.
            self._stopping.set()
            try:
                for root_id, root_path in _resolved_roots(roots):
                    try:
                        publish(LibraryEvent(
                            LibraryEventKind.ROOT_UNAVAILABLE,
                            root_id, root_path, observed_at=clock(), is_directory=True,
                        ))
                    except Exception:
                        # The health service retains failed writes in memory;
                        # continue blocking the remaining affected roots too.
                        continue
            finally:
                self.stop(timeout=5.0)
            raise

    def stop(self, *, timeout: float) -> None:
        observer = self._observer
        if observer is None:
            return
        self._stopping.set()
        observer.stop()
        if getattr(observer, "ident", None) is not None or observer.is_alive():
            observer.join(timeout)
        if observer.is_alive() or any(emitter.is_alive() for emitter in self._emitters):
            raise RuntimeError("Library event source did not stop before the deadline")
        self._observer = None
        self._emitters = ()

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
