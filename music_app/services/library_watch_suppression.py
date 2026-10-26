"""Suppress redundant watcher work for app-owned library file mutations."""

from __future__ import annotations

import os
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path
from threading import Lock
from time import monotonic


class LibraryWatchSuppression:
    def __init__(
        self,
        *,
        grace_seconds: float = 5.0,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        self._grace_seconds = max(0.0, float(grace_seconds))
        self._clock = clock
        self._entries: dict[str, tuple[int, float]] = {}
        self._lock = Lock()

    @staticmethod
    def _key(path: Path | str) -> str:
        return os.path.normcase(str(Path(path).resolve(strict=False)))

    @contextmanager
    def suppress(self, paths: Iterable[Path | str]) -> Iterator[None]:
        keys = tuple(dict.fromkeys(self._key(path) for path in paths))
        with self._lock:
            now = self._clock()
            for key in keys:
                active, expires_at = self._entries.get(key, (0, now))
                self._entries[key] = (active + 1, expires_at)
        try:
            yield
        finally:
            with self._lock:
                expires_at = self._clock() + self._grace_seconds
                for key in keys:
                    active, _previous_expiry = self._entries.get(key, (1, expires_at))
                    self._entries[key] = (max(0, active - 1), expires_at)

    def contains(self, path: Path | str) -> bool:
        key = self._key(path)
        with self._lock:
            now = self._clock()
            expired = [
                entry_key
                for entry_key, (active, expires_at) in self._entries.items()
                if active <= 0 and expires_at < now
            ]
            for entry_key in expired:
                self._entries.pop(entry_key, None)
            entry = self._entries.get(key)
            if entry is None:
                return False
            active, expires_at = entry
            return active > 0 or expires_at >= now


library_watch_suppression = LibraryWatchSuppression()


def suppress_library_watch_events(paths: Iterable[Path | str]):
    return library_watch_suppression.suppress(paths)


def is_library_watch_event_suppressed(path: Path | str) -> bool:
    return library_watch_suppression.contains(path)
