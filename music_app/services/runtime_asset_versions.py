"""Reuse static content digests only while native change detection stays reliable."""
from __future__ import annotations

import atexit
import os
from threading import Lock


class _WindowsDirectoryChanges:
    def __init__(self, root):
        import ctypes
        from ctypes import wintypes

        self._root = root
        stat = root.stat()
        if not stat.st_ino:
            raise OSError("Static directory identity is unavailable.")
        self._identity = (stat.st_dev, stat.st_ino)
        self._ctypes = ctypes
        self._api = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = (
            ("FindFirstChangeNotificationW", [wintypes.LPCWSTR, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            ("FindNextChangeNotification", [wintypes.HANDLE], wintypes.BOOL),
            ("FindCloseChangeNotification", [wintypes.HANDLE], wintypes.BOOL),
            ("WaitForSingleObject", [wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
        )
        for name, arguments, result in signatures:
            function = getattr(self._api, name)
            function.argtypes, function.restype = arguments, result
        # Names, directories, sizes and writes; reads do not invalidate assets.
        self._handle = self._api.FindFirstChangeNotificationW(str(root), True, 0x1B)
        if self._handle == ctypes.c_void_p(-1).value:
            self._handle = None
            raise ctypes.WinError(ctypes.get_last_error())

    def changed(self):
        if self._handle is None:
            raise OSError("Asset change notification is closed.")
        stat = self._root.stat()
        if (stat.st_dev, stat.st_ino) != self._identity:
            raise OSError("The static asset directory was replaced.")
        result = self._api.WaitForSingleObject(self._handle, 0)
        if result == 258:  # WAIT_TIMEOUT: no changes.
            return False
        if result != 0 or not self._api.FindNextChangeNotification(self._handle):
            raise self._ctypes.WinError(self._ctypes.get_last_error())
        return True

    def close(self):
        if self._handle is not None:
            handle, self._handle = self._handle, None
            self._api.FindCloseChangeNotification(handle)


def _directory_signal(root):
    return _WindowsDirectoryChanges(root) if os.name == "nt" else None


class RuntimeAssetVersionCache:
    """One bounded static-root cache, with no worker thread or polling timer."""

    def __init__(self, notification_factory=_directory_signal):
        self._factory = notification_factory
        self._lock = Lock()
        self._root = None
        self._signal = None
        self._version = None

    def _close(self):
        if self._signal is not None:
            self._signal.close()
        self._signal = self._root = self._version = None

    def close(self):
        with self._lock:
            self._close()

    def get(self, root, build):
        with self._lock:
            if root != self._root:
                self._close()
                self._root = root
                try:
                    self._signal = self._factory(root)
                except OSError:
                    self._signal = None
            if self._signal is not None:
                try:
                    if self._signal.changed():
                        self._version = None
                except OSError:
                    self._signal.close()
                    self._signal = self._version = None
            if self._signal is None:
                return build()
            if self._version is None:
                version = build()
                self._version = None if version == "missing" else version
                return version
            return self._version


runtime_asset_version_cache = RuntimeAssetVersionCache()
atexit.register(runtime_asset_version_cache.close)
