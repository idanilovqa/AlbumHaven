"""Counts real filesystem and media work for backend bounded-interaction contracts.

The seams wrap the real operations (nothing is faked) and count only the
outermost call, so a ``Path.glob`` that scans internally, or a ``Path.exists``
that stats internally, counts once on every Python version.
"""

from __future__ import annotations

import builtins
import contextlib
import functools
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from tests.py.asgi_testing import WATCHDOG_SAMPLER_THREAD_NAME
from tests.py.bounded_interactions import OperationCounts

_ENUMERATIONS = (
    (Path, "iterdir"), (Path, "glob"), (Path, "rglob"),
    (os, "scandir"), (os, "listdir"), (os, "walk"),
)
_STATS = ((Path, "stat"), (Path, "lstat"), (os, "stat"), (os, "lstat"))
_RESOLVES = ((Path, "resolve"), (os.path, "realpath"))
_OPENS = ((Path, "open"), (builtins, "open"), (os, "open"))


class _Depth(threading.local):
    value = 0


# Module-level executors that keep running after the request that queued their
# work: cover preview renders, and the admission step that queues them. The
# patches below are process-wide, so work an earlier test left on them would be
# counted against the interaction being measured.
_BACKGROUND_EXECUTORS = (
    ("music_app.services.covers", (
        "_COVER_VARIANT_ADMISSION_EXECUTOR",
        "_COVER_VARIANT_PREWARM_EXECUTOR",
        "_COVER_VARIANT_INTERACTIVE_EXECUTOR",
        "_COVER_VARIANT_FOREGROUND_EXECUTOR",
    )),
)


def _quiesce(executor, timeout: float) -> None:
    """Returns once every task queued on `executor` before the call has finished:
    one barrier task per worker can only all start after the earlier tasks end."""
    workers = int(getattr(executor, "_max_workers", 1) or 1)
    barrier = threading.Barrier(workers + 1)
    futures = [executor.submit(barrier.wait, timeout) for _ in range(workers)]
    barrier.wait(timeout)
    for future in futures:
        future.result(timeout)


def _join_static_gzip_warmup(timeout: float) -> None:
    """Waits for the static gzip warm-up an earlier app creation started: it
    walks the app's static folder once per process, never for a request."""
    module = sys.modules.get("music_app.services.compressed_static_files")
    if module is None:
        return
    for thread in threading.enumerate():
        if thread.name == module.WARMUP_THREAD_NAME:
            thread.join(timeout)
            if thread.is_alive():
                raise TimeoutError(f"{thread.name} did not finish within {timeout}s")


def quiesce_background_executors(timeout: float = 30.0) -> None:
    """Drains the app's module-level background executors that are loaded, and
    the static gzip warm-up. An admission step may queue renders, so the
    executors are drained in order, twice."""
    _join_static_gzip_warmup(timeout)
    for _round in range(2):
        for module_name, names in _BACKGROUND_EXECUTORS:
            module = sys.modules.get(module_name)
            for name in names if module is not None else ():
                executor = getattr(module, name)
                # A test may stand in its own recorder for an executor; only a
                # real pool has work of its own to drain.
                if isinstance(executor, ThreadPoolExecutor):
                    _quiesce(executor, timeout)


def _observer_thread() -> bool:
    """The event-loop watchdog's sampler: it stats source files to format a
    stall's stack, observer work that is never charged to the request."""
    return threading.current_thread().name == WATCHDOG_SAMPLER_THREAD_NAME


def _record_thread(counts: OperationCounts, metric: str) -> None:
    """Which thread did each counted operation, for a budget failure's report."""
    by_thread = counts.__dict__.setdefault("by_thread", {})
    per_metric = by_thread.setdefault(metric, {})
    name = threading.current_thread().name
    per_metric[name] = per_metric.get(name, 0) + 1


def _counted(function, counts: OperationCounts, metric: str, depth: _Depth, *, generator: bool = False):
    if generator:
        @functools.wraps(function)
        def iterate(*args, **kwargs):
            if depth.value == 0 and not _observer_thread():
                counts.count(metric)
                _record_thread(counts, metric)
            iterator = function(*args, **kwargs)
            while True:
                # Only the enumeration's own steps are nested; work the caller
                # does between items is counted normally.
                depth.value += 1
                try:
                    item = next(iterator)
                except StopIteration:
                    return
                finally:
                    depth.value -= 1
                yield item
        return iterate

    @functools.wraps(function)
    def call(*args, **kwargs):
        if depth.value == 0 and not _observer_thread():
            counts.count(metric)
            _record_thread(counts, metric)
        depth.value += 1
        try:
            return function(*args, **kwargs)
        finally:
            depth.value -= 1
    return call


@contextlib.contextmanager
def count_filesystem_and_media(monkeypatch, counts: OperationCounts, *, media_modules=()):
    """Counts enumerations, stats, path resolutions, opens and media parses while active.

    ``media_modules`` are modules whose module-level ``MutagenFile`` or PIL
    ``Image.open`` binding the interaction uses. Background work earlier tests
    left on the app's module-level executors is drained first, and each
    counted operation records its thread (``counts.by_thread``).
    """
    quiesce_background_executors()
    depth = _Depth()
    with monkeypatch.context() as patch:
        for owner, name in _ENUMERATIONS:
            original = getattr(owner, name)
            generator = owner is Path or name == "walk"
            patch.setattr(owner, name, _counted(original, counts, "filesystem_enumerations", depth, generator=generator))
        for owner, name in _STATS:
            patch.setattr(owner, name, _counted(getattr(owner, name), counts, "stat_calls", depth))
        for owner, name in _RESOLVES:
            patch.setattr(owner, name, _counted(getattr(owner, name), counts, "path_resolves", depth))
        for owner, name in _OPENS:
            patch.setattr(owner, name, _counted(getattr(owner, name), counts, "open_calls", depth))
        for module in media_modules:
            if getattr(module, "MutagenFile", None) is not None:
                patch.setattr(module, "MutagenFile", _counted(module.MutagenFile, counts, "media_parses", depth))
            image = getattr(module, "Image", None)
            if image is not None and hasattr(image, "open"):
                patch.setattr(image, "open", _counted(image.open, counts, "media_parses", depth))
        yield counts
