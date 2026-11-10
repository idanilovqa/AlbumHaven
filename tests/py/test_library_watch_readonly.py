from __future__ import annotations

import json
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest


_READONLY = 0x1
_NORMAL = 0x80
_OTHER_FLAGS = 0x2 | 0x4 | 0x20
_LOGGER = logging.getLogger("album_haven.tests.readonly_watcher")


class _WindowsFunction:
    def __init__(self, call):
        self.call = call

    def __call__(self, *args):
        return self.call(*args)


@pytest.fixture
def windows_attributes(monkeypatch):
    from music_app.services import library_watch_readonly as readonly

    attributes = {}
    calls = []
    errors = {}

    def get_attributes(path):
        path = Path(path)
        calls.append(("get_attributes", path))
        return 0xFFFFFFFF if errors.get("read") else attributes[path]

    def set_attributes(path, value):
        path = Path(path)
        calls.append(("set_attributes", path, value))
        if errors.get("write"):
            return 0
        attributes[path] = value
        return 1

    kernel32 = SimpleNamespace(
        GetFileAttributesW=_WindowsFunction(get_attributes),
        SetFileAttributesW=_WindowsFunction(set_attributes),
    )
    monkeypatch.setattr(readonly.sys, "platform", "win32")
    monkeypatch.setattr(
        readonly.ctypes, "WinDLL", lambda *_args, **_kwargs: kernel32, raising=False,
    )
    monkeypatch.setattr(readonly.ctypes, "get_last_error", lambda: 5, raising=False)
    monkeypatch.setattr(
        readonly.ctypes, "WinError", lambda *_args: PermissionError("attribute access denied"),
        raising=False,
    )
    return SimpleNamespace(module=readonly, values=attributes, calls=calls, errors=errors)


def _signature(path):
    value = path.stat()
    return value.st_size, value.st_mtime_ns


def _prepare(windows, path, *, root=None, signature=None, is_cancelled=None):
    windows.module.prepare_stable_library_file(
        path, signature if signature is not None else _signature(path),
        roots=[{"id": "main", "path": str(root or path.parent)}],
        supported_extensions=(".flac", ".mp3", ".wav"),
        image_extensions=(".jpg", ".png", ".webp"), logger=_LOGGER,
        is_cancelled=is_cancelled,
    )


@pytest.mark.parametrize("suffix", [".flac", ".MP3", ".wav", ".jpg", ".PNG", ".webp"])
@pytest.mark.parametrize("attributes", [_READONLY, _READONLY | _OTHER_FLAGS, _OTHER_FLAGS])
def test_adapter_clears_only_readonly_and_is_idempotent(tmp_path, windows_attributes, suffix, attributes):
    windows = windows_attributes
    path = tmp_path / f"file{suffix}"
    path.write_bytes(b"synthetic")
    windows.values[path] = attributes
    for _ in range(3):
        _prepare(windows, path)
    assert windows.values[path] == (attributes & ~_READONLY or _NORMAL)
    assert len([call for call in windows.calls if call[0] == "set_attributes"]) == int(bool(attributes & _READONLY))


@pytest.mark.parametrize("platform", ["linux", "darwin"])
def test_non_windows_adapter_preserves_permissions(tmp_path, windows_attributes, monkeypatch, platform):
    windows = windows_attributes
    monkeypatch.setattr(windows.module.sys, "platform", platform)
    path = tmp_path / "track.flac"
    path.write_bytes(b"synthetic")
    path.chmod(0o444)
    mode = path.stat().st_mode
    _prepare(windows, path)
    assert path.stat().st_mode == mode
    assert windows.calls == []


@pytest.mark.parametrize("case", ["unsupported", "directory", "outside-root", "root-removed", "symlink-inside", "symlink-outside", "changed", "cancelled", "reparse"])
def test_adapter_revalidates_candidate_before_mutation(tmp_path, windows_attributes, monkeypatch, case):
    import stat

    windows = windows_attributes
    root = tmp_path / "library"
    root.mkdir()
    path = root / ("notes.txt" if case == "unsupported" else "track.flac")
    if case == "directory":
        path.mkdir()
    elif case.startswith("symlink"):
        target = (root if case == "symlink-inside" else tmp_path) / "target.flac"
        target.write_bytes(b"synthetic")
        path.symlink_to(target)
    else:
        path.write_bytes(b"synthetic")
    signature = _signature(path)
    if case == "changed":
        signature = (signature[0] + 1, signature[1])
    if case == "reparse":
        original_lstat = Path.lstat

        def reparse_lstat(self, *args, **kwargs):
            if self == path:
                return SimpleNamespace(st_mode=stat.S_IFREG, st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT)
            return original_lstat(self, *args, **kwargs)

        monkeypatch.setattr(Path, "lstat", reparse_lstat)
    roots = [] if case == "root-removed" else [{"path": str(root / "other" if case == "outside-root" else root)}]
    windows.module.prepare_stable_library_file(
        path, signature, roots=roots, supported_extensions=(".flac",),
        image_extensions=(".jpg",), logger=_LOGGER,
        is_cancelled=lambda: case == "cancelled",
    )
    assert windows.calls == []


@pytest.mark.parametrize("failure", ["read", "write", "stat"])
def test_adapter_failure_is_observable(tmp_path, windows_attributes, monkeypatch, caplog, failure):
    windows = windows_attributes
    path = tmp_path / "track.flac"
    path.write_bytes(b"synthetic")
    signature = _signature(path)
    windows.values[path] = _READONLY | _OTHER_FLAGS
    if failure == "stat":
        original_stat = Path.stat

        def inaccessible_stat(self, *args, **kwargs):
            if self == path:
                raise PermissionError("post-stability read failed")
            return original_stat(self, *args, **kwargs)

        monkeypatch.setattr(Path, "stat", inaccessible_stat)
    else:
        windows.errors[failure] = True
    with caplog.at_level(logging.WARNING, logger=_LOGGER.name):
        _prepare(windows, path, signature=signature)
    assert windows.values[path] == _READONLY | _OTHER_FLAGS
    assert any(record.name == _LOGGER.name and record.levelno >= logging.WARNING for record in caplog.records)


@pytest.mark.parametrize("stop_at", ["preparation-stat", "get-attributes"])
def test_adapter_cancellation_before_write_preserves_attributes(tmp_path, windows_attributes, monkeypatch, stop_at):
    windows = windows_attributes
    path = tmp_path / "track.flac"
    path.write_bytes(b"synthetic")
    signature = _signature(path)
    windows.values[path] = _READONLY | _OTHER_FLAGS
    cancelled = []
    if stop_at == "preparation-stat":
        original_stat = Path.stat

        def stop_during_stat(self, *args, **kwargs):
            value = original_stat(self, *args, **kwargs)
            if self == path:
                cancelled.append(True)
            return value

        monkeypatch.setattr(Path, "stat", stop_during_stat)
    else:
        kernel32 = windows.module.ctypes.WinDLL("kernel32", use_last_error=True)
        original_get = kernel32.GetFileAttributesW.call

        def stop_during_get(target):
            value = original_get(target)
            cancelled.append(True)
            return value

        monkeypatch.setattr(kernel32.GetFileAttributesW, "call", stop_during_get)
    _prepare(windows, path, signature=signature, is_cancelled=lambda: bool(cancelled))
    assert cancelled
    assert not any(call[0] == "set_attributes" for call in windows.calls)
    assert windows.values[path] == _READONLY | _OTHER_FLAGS


@pytest.mark.parametrize("owner", ["library_event_coordinator.py", "library_watch_readonly.py", "targeted_library_reconciliation.py"])
def test_readonly_owners_select_both_problematic_files_targets(owner):
    mapping = json.loads((Path(__file__).parents[1] / "ci" / "performance-change-impact.json").read_text(encoding="utf-8"))
    path = f"music_app/services/{owner}"
    assert path in mapping["requiredPaths"]
    selected = {target for rule in mapping["rules"] if path in rule["paths"] for target in rule["targets"]}
    assert {"utility-problematic-files", "problematic-files-focused"} <= selected
