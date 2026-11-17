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
import threading
from pathlib import Path

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


def _counted(function, counts: OperationCounts, metric: str, depth: _Depth, *, generator: bool = False):
    if generator:
        @functools.wraps(function)
        def iterate(*args, **kwargs):
            if depth.value == 0:
                counts.count(metric)
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
        if depth.value == 0:
            counts.count(metric)
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
    ``Image.open`` binding the interaction uses.
    """
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
