"""Whether a missing library file was deleted or its drive or share cannot be reached."""

from __future__ import annotations

import os
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


def library_root_missing_reason(root_path: object) -> str:
    """Files a watcher reports gone under a readable root were deleted; otherwise unreachable."""
    root = str(root_path or "").strip()
    return MISSING_DELETED if root and folder_is_readable(root) else MISSING_UNREACHABLE


def missing_reason_for_path(root: Path | str | None, path: Path | str) -> str:
    """Deleted when the root and every existing folder above the file can be read.

    Walking up from the file, the first folder that exists must be readable and inside a
    readable root; any folder that cannot be listed means the drive or share is unreachable.
    """
    if root is None or not folder_is_readable(root):
        return MISSING_UNREACHABLE
    root_path = Path(root)
    for parent in Path(path).parents:
        if parent == root_path or root_path not in parent.parents:
            return MISSING_DELETED
        try:
            exists = parent.exists()
        except OSError:
            return MISSING_UNREACHABLE
        if exists:
            return MISSING_DELETED if folder_is_readable(parent) else MISSING_UNREACHABLE
    return MISSING_DELETED
