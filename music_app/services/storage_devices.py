"""Identify the physical disk behind a path, so scans read each disk sequentially.

A spinning disk read by several threads at once seeks between files instead of
streaming them. Scans therefore use one reader per physical disk and read
different disks in parallel. Partitions of one disk share a key; when the disk
cannot be identified the volume stands in for it.
"""
from __future__ import annotations

import os
import sys
from functools import lru_cache
from pathlib import Path

_IOCTL_STORAGE_GET_DEVICE_NUMBER = 0x2D1080


@lru_cache(maxsize=64)
def _windows_disk_number(drive: str) -> int | None:
    import ctypes
    from ctypes import wintypes

    class StorageDeviceNumber(ctypes.Structure):
        _fields_ = [("DeviceType", wintypes.DWORD), ("DeviceNumber", wintypes.DWORD), ("PartitionNumber", wintypes.DWORD)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.restype = wintypes.HANDLE
    # Zero access rights: querying the device number needs no read access.
    handle = kernel32.CreateFileW(f"\\\\.\\{drive}", 0, 3, None, 3, 0, None)
    if handle in (None, wintypes.HANDLE(-1).value):
        return None
    try:
        number = StorageDeviceNumber()
        returned = wintypes.DWORD()
        if not kernel32.DeviceIoControl(
            handle, _IOCTL_STORAGE_GET_DEVICE_NUMBER, None, 0,
            ctypes.byref(number), ctypes.sizeof(number), ctypes.byref(returned), None,
        ):
            return None
        return int(number.DeviceNumber)
    finally:
        kernel32.CloseHandle(handle)


def physical_disk_key(path: Path | str) -> str:
    """A key equal for paths on the same physical disk."""
    candidate = Path(path)
    if sys.platform == "win32" and candidate.drive.endswith(":"):
        try:
            number = _windows_disk_number(candidate.drive.upper())
        except Exception:
            number = None
        if number is not None:
            return f"disk:{number}"
    for probe in (candidate, *candidate.parents):
        try:
            return f"volume:{os.stat(probe).st_dev}"
        except OSError:
            continue
    return f"path:{candidate.anchor}"
