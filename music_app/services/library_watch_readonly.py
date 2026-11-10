"""Clear Windows Read-only on stable, supported files in watched roots."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
import ctypes
from ctypes import wintypes
from pathlib import Path
import stat
import sys


def prepare_stable_library_file(
    path: Path,
    signature: tuple[int, int],
    *,
    roots: Iterable[Path | Mapping[str, object]],
    supported_extensions: Iterable[str],
    image_extensions: Iterable[str],
    logger: object,
    is_cancelled: Callable[[], bool] | None = None,
) -> None:
    """Prepare one already-stable reconciliation target before media reads."""
    if sys.platform != "win32" or (is_cancelled is not None and is_cancelled()):
        return
    try:
        # Inspect the incoming entry before resolve can follow a replacement.
        incoming = path.lstat()
        if not stat.S_ISREG(incoming.st_mode) or (
            getattr(incoming, "st_file_attributes", 0)
            & stat.FILE_ATTRIBUTE_REPARSE_POINT
        ):
            return
        resolved = path.resolve(strict=False)
        extensions = {
            str(extension).casefold()
            for extension in (*supported_extensions, *image_extensions)
        }
        if resolved.suffix.casefold() not in extensions:
            return
        for root in roots:
            root_path = root.get("path") if isinstance(root, Mapping) else root
            if root_path and resolved.is_relative_to(
                Path(str(root_path)).resolve(strict=False)
            ):
                break
        else:
            return
        current = resolved.stat()
        if not stat.S_ISREG(current.st_mode) or (
            current.st_size, current.st_mtime_ns
        ) != signature:
            return
        _clear_windows_readonly(resolved, is_cancelled=is_cancelled)
    except Exception:
        logger.warning(
            "Unable to clear Windows Read-only attribute for a stable library file.",
            exc_info=True,
        )


def _clear_windows_readonly(
    path: Path, *, is_cancelled: Callable[[], bool] | None = None,
) -> bool:
    """Change only the Read-only bit; a repeated attribute event is a no-op."""
    if is_cancelled is not None and is_cancelled():
        return False
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    get_attributes = kernel32.GetFileAttributesW
    get_attributes.argtypes = [wintypes.LPCWSTR]
    get_attributes.restype = wintypes.DWORD
    set_attributes = kernel32.SetFileAttributesW
    set_attributes.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
    set_attributes.restype = wintypes.BOOL

    attributes = get_attributes(str(path))
    if attributes == 0xFFFFFFFF:  # INVALID_FILE_ATTRIBUTES
        raise ctypes.WinError(ctypes.get_last_error())
    if not attributes & stat.FILE_ATTRIBUTE_READONLY:
        return False
    # Do not mutate a directory or reparse point that replaced the sampled file.
    if attributes & (stat.FILE_ATTRIBUTE_DIRECTORY | stat.FILE_ATTRIBUTE_REPARSE_POINT):
        return False
    writable_attributes = attributes & ~stat.FILE_ATTRIBUTE_READONLY
    if is_cancelled is not None and is_cancelled():
        return False
    if not set_attributes(str(path), writable_attributes or stat.FILE_ATTRIBUTE_NORMAL):
        raise ctypes.WinError(ctypes.get_last_error())
    return True
