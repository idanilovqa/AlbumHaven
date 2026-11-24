"""Publish completed album folders while a scan is still reading files.

A full or first scan used to publish nothing until every file was read, then
everything in one transaction under the global inventory-publication lock: a
new library stayed empty for hours and every edit waited behind it. Here the
scan thread hands over each album folder once all its files are read; a
publisher thread writes changed folders in short, bounded batches through the
targeted inventory path, so the gallery fills in while the scan runs and
edits interleave between batches. The scan's final publication stays the
authority for stale-marking, removals and anything a batch could not write.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
import logging
import queue
import threading
import time

PublishBatch = Callable[[str, dict[str, dict[str, object]]], Mapping[str, object]]

_CLOSE = object()


class ProgressiveScanPublisher:
    def __init__(
        self,
        publish_batch: PublishBatch,
        *,
        max_albums: int = 200,
        max_seconds: float = 3.0,
        clock: Callable[[], float] = time.monotonic,
        logger: logging.Logger | None = None,
    ) -> None:
        self._publish_batch = publish_batch
        self._max_albums = max(1, int(max_albums))
        self._max_seconds = max(0.0, float(max_seconds))
        self._clock = clock
        self._logger = logger or logging.getLogger(__name__)
        self._queue: queue.Queue = queue.Queue()
        self._thread = threading.Thread(target=self._run, name="progressive-scan-publication", daemon=True)
        self._cancelled = threading.Event()
        self.revisions: list[int] = []
        self.batches: list[dict[str, float | int]] = []  # files and lock-hold seconds per call
        self.failed_batches = 0
        self.first_published_at: float | None = None

    def start(self) -> "ProgressiveScanPublisher":
        self._thread.start()
        return self

    def submit(
        self,
        root_id: str,
        folders: Mapping[str, Mapping[str, dict[str, object]]],
        root_complete: bool,
        changed_paths: frozenset[str],
    ) -> None:
        """Scan-thread callback: queue folders with a changed file; never blocks."""
        del root_complete  # removals wait for the scan's final, guarded publication
        changed = {
            folder: dict(entries) for folder, entries in folders.items()
            if changed_paths.intersection(entries)
        }
        if changed and not self._cancelled.is_set():
            self._queue.put((str(root_id), changed))

    def close(self, *, cancel: bool = False) -> None:
        """Publish what is queued (or drop it when cancelled) and stop."""
        if cancel:
            self._cancelled.set()
        self._queue.put(_CLOSE)
        self._thread.join()

    def _run(self) -> None:
        pending: dict[str, dict[str, dict[str, object]]] = {}
        album_count = 0
        oldest = None
        while True:
            timeout = None if oldest is None else max(0.0, oldest + self._max_seconds - self._clock())
            try:
                item = self._queue.get(timeout=timeout)
            except queue.Empty:
                item = None
            if item is _CLOSE:
                if not self._cancelled.is_set():
                    self._flush(pending)
                return
            if item is not None:
                root_id, folders = item
                for entries in folders.values():
                    pending.setdefault(root_id, {}).update(entries)
                album_count += len(folders)
                oldest = self._clock() if oldest is None else oldest
            if pending and (album_count >= self._max_albums or self._clock() - oldest >= self._max_seconds):
                if not self._cancelled.is_set():
                    self._flush(pending)
                pending, album_count, oldest = {}, 0, None

    def _flush(self, pending: dict[str, dict[str, dict[str, object]]]) -> None:
        for root_id, entries in pending.items():
            started = self._clock()
            try:
                result = self._publish_batch(root_id, entries)
            except Exception:  # the final publication still writes these files
                self.failed_batches += 1
                self._logger.exception("Progressive scan publication batch failed; the final publication will retry it")
                continue
            revision = int(result.get("inventory_mutation_revision") or 0)
            if revision:
                self.revisions.append(revision)
            if self.first_published_at is None:
                self.first_published_at = time.time()
            self.batches.append({"files": len(entries), "seconds": round(self._clock() - started, 3)})


def contiguous_revision(start: int | None, revisions: list[int]) -> tuple[int | None, bool]:
    """The last revision reached through this scan's own batches alone.

    Returns (revision, interleaved). When another writer committed between two
    batches the chain breaks there, so the final publication still detects that
    writer and merges its changes instead of overwriting them.
    """
    if start is None:
        return None, bool(revisions)
    current = int(start)
    for revision in revisions:
        if revision != current + 1:
            return current, True
        current = revision
    return current, False
