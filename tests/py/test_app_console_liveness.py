from __future__ import annotations

import sys
import types

import app
import pytest


STD_INPUT_HANDLE = -10
ENABLE_QUICK_EDIT_MODE = 0x0040
ENABLE_EXTENDED_FLAGS = 0x0080
INVALID_HANDLE_VALUE = -1


def _console_liveness_seam():
    seam = getattr(app, "_disable_windows_console_quick_edit_mode", None)
    assert callable(seam), (
        "Expected app._disable_windows_console_quick_edit_mode to protect the "
        "console-attached server from QuickEdit/select-mode suspension."
    )
    return seam


class _FakeKernel32:
    def __init__(
        self,
        *,
        handle: int = 73,
        mode: int = ENABLE_QUICK_EDIT_MODE | 0x0007,
        get_mode_succeeds: bool = True,
        set_mode_succeeds: bool = True,
    ) -> None:
        self.handle = handle
        self.mode = mode
        self.get_mode_succeeds = get_mode_succeeds
        self.set_mode_succeeds = set_mode_succeeds
        self.calls: list[tuple[object, ...]] = []

    def GetStdHandle(self, stream_kind: int) -> int:
        self.calls.append(("GetStdHandle", stream_kind))
        return self.handle

    def GetConsoleMode(self, handle: int, mode_pointer) -> int:
        self.calls.append(("GetConsoleMode", handle))
        if not self.get_mode_succeeds:
            return 0
        mode_pointer._obj.value = self.mode
        return 1

    def SetConsoleMode(self, handle: int, mode: int) -> int:
        self.calls.append(("SetConsoleMode", handle, mode))
        return int(self.set_mode_succeeds)


def test_windows_console_liveness_disables_quick_edit_and_retains_other_input_modes():
    kernel32 = _FakeKernel32(mode=ENABLE_QUICK_EDIT_MODE | 0x0007)

    changed = _console_liveness_seam()(
        platform_name="win32",
        kernel32=kernel32,
    )

    assert changed is True
    assert kernel32.calls == [
        ("GetStdHandle", STD_INPUT_HANDLE),
        ("GetConsoleMode", kernel32.handle),
        (
            "SetConsoleMode",
            kernel32.handle,
            (kernel32.mode | ENABLE_EXTENDED_FLAGS) & ~ENABLE_QUICK_EDIT_MODE,
        ),
    ]


def test_windows_console_liveness_leaves_redirected_stdin_unchanged():
    kernel32 = _FakeKernel32(get_mode_succeeds=False)

    changed = _console_liveness_seam()(
        platform_name="win32",
        kernel32=kernel32,
    )

    assert changed is False
    assert kernel32.calls == [
        ("GetStdHandle", STD_INPUT_HANDLE),
        ("GetConsoleMode", kernel32.handle),
    ]


@pytest.mark.parametrize("missing_handle", [0, INVALID_HANDLE_VALUE])
def test_windows_console_liveness_tolerates_missing_console_handle(missing_handle):
    kernel32 = _FakeKernel32(handle=missing_handle)

    changed = _console_liveness_seam()(
        platform_name="win32",
        kernel32=kernel32,
    )

    assert changed is False
    assert kernel32.calls == [("GetStdHandle", STD_INPUT_HANDLE)]


def test_console_liveness_is_a_noop_away_from_windows():
    class _UnexpectedKernel32Access:
        def __getattr__(self, name: str):
            raise AssertionError(f"Non-Windows startup must not access kernel32.{name}")

    changed = _console_liveness_seam()(
        platform_name="linux",
        kernel32=_UnexpectedKernel32Access(),
    )

    assert changed is False


def test_asgi_runner_protects_console_liveness_before_starting_uvicorn(monkeypatch):
    events: list[object] = []
    fake_uvicorn = types.SimpleNamespace(
        run=lambda target, **kwargs: events.append(("uvicorn", target, kwargs))
    )
    monkeypatch.setitem(sys.modules, "uvicorn", fake_uvicorn)
    monkeypatch.setattr(
        app,
        "_disable_windows_console_quick_edit_mode",
        lambda: events.append("console-protected"),
        raising=False,
    )

    app._run_asgi_server(port=5125, reload=False)

    assert events == [
        "console-protected",
        (
            "uvicorn",
            "music_app:create_asgi_app",
            {
                "host": "0.0.0.0",
                "port": 5125,
                "reload": False,
                "factory": True,
            },
        ),
    ]
