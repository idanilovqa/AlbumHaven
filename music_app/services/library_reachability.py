"""Whether a missing library file was deleted or its drive or share cannot be reached."""

from __future__ import annotations

import os
from collections.abc import Iterable
from pathlib import Path

MISSING_DELETED = "deleted"
MISSING_UNREACHABLE = "unreachable"


def folder_is_readable(path: Path | str) -> bool:
    """A folder exists and can be listed; a dropped drive or share fails here."""
    try:
        with os.scandir(path) as entries:
            next(entries, None)
        return True
    except OSError:
        return False


def missing_reason_for_path(root: Path | str | None, path: Path | str) -> str:
    """Deleted when the root and every existing folder above the file can be read.

    Walking up from the file, the first folder that exists must be readable and inside a
    readable root; any folder that cannot be listed means the drive or share is unreachable.
    """
    if root is None or not folder_is_readable(root):
        return MISSING_UNREACHABLE
    return _MissingReasons().for_path(Path(root), Path(path))


def missing_reasons(
    rows: Iterable[tuple[str, str, str]],
    *,
    unreachable_root_ids: Iterable[str] = (),
    unreachable_paths: Iterable[str] = (),
) -> list[str]:
    """One reason per (path, root id, root path); each folder and root is probed once.

    A file is unreachable when its root could not be read, when it sits under a folder the
    walk failed to read, or when a folder above it (a subfolder on another disk, share or
    junction) cannot be listed now. Otherwise it was deleted.
    """
    unreachable_roots = {str(root_id) for root_id in unreachable_root_ids}
    failed = tuple(_normalized(path) for path in unreachable_paths if str(path).strip())
    reasons = _MissingReasons()
    result: list[str] = []
    for path, root_id, root_path in rows:
        normalized = _normalized(path)
        if str(root_id) in unreachable_roots or any(
            normalized == prefix or normalized.startswith(prefix + "/") for prefix in failed
        ):
            result.append(MISSING_UNREACHABLE)
        elif not root_path or not reasons.root_readable(Path(root_path)):
            result.append(MISSING_UNREACHABLE)
        else:
            result.append(reasons.for_path(Path(root_path), Path(path)))
    return result


class _MissingReasons:
    def __init__(self) -> None:
        self._roots: dict[Path, bool] = {}
        self._folders: dict[Path, str] = {}

    def root_readable(self, root: Path) -> bool:
        if root not in self._roots:
            self._roots[root] = folder_is_readable(root)
        return self._roots[root]

    def for_path(self, root: Path, path: Path) -> str:
        walked: list[Path] = []
        reason = MISSING_DELETED
        for parent in path.parents:
            if parent in self._folders:
                reason = self._folders[parent]
                break
            walked.append(parent)
            if parent == root or root not in parent.parents:
                break
            try:
                exists = parent.exists()
                # A link or junction whose target is gone: its disk or share dropped out.
                dangling = not exists and os.path.lexists(parent)
            except OSError:
                reason = MISSING_UNREACHABLE
                break
            if dangling:
                reason = MISSING_UNREACHABLE
                break
            if exists:
                reason = MISSING_DELETED if folder_is_readable(parent) else MISSING_UNREACHABLE
                break
        for folder in walked:
            self._folders[folder] = reason
        return reason


def _normalized(path: object) -> str:
    return str(path).replace("\\", "/").rstrip("/").casefold()
