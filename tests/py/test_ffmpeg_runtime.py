from __future__ import annotations

from types import SimpleNamespace

from music_app.services import ffmpeg_runtime


def test_resolver_prefers_ffmpeg_on_path(monkeypatch):
    monkeypatch.setattr(ffmpeg_runtime.shutil, "which", lambda name: r"C:\tools\ffmpeg.exe")
    fallback = SimpleNamespace(get_ffmpeg_exe=lambda: (_ for _ in ()).throw(AssertionError("fallback used")))
    monkeypatch.setitem(ffmpeg_runtime.sys.modules, "imageio_ffmpeg", fallback)

    assert ffmpeg_runtime.resolve_ffmpeg_executable() == r"C:\tools\ffmpeg.exe"


def test_resolver_falls_back_to_imageio_ffmpeg(monkeypatch):
    monkeypatch.setattr(ffmpeg_runtime.shutil, "which", lambda name: None)
    fallback = SimpleNamespace(get_ffmpeg_exe=lambda: r"C:\imageio\ffmpeg.exe")
    monkeypatch.setitem(ffmpeg_runtime.sys.modules, "imageio_ffmpeg", fallback)

    assert ffmpeg_runtime.resolve_ffmpeg_executable() == r"C:\imageio\ffmpeg.exe"


def test_resolver_returns_none_when_both_sources_are_unavailable(monkeypatch):
    monkeypatch.setattr(ffmpeg_runtime.shutil, "which", lambda name: None)
    monkeypatch.setitem(
        ffmpeg_runtime.sys.modules,
        "imageio_ffmpeg",
        SimpleNamespace(get_ffmpeg_exe=lambda: (_ for _ in ()).throw(RuntimeError("missing"))),
    )

    assert ffmpeg_runtime.resolve_ffmpeg_executable() is None


def test_hidden_subprocess_flags_follow_the_running_platform(monkeypatch):
    monkeypatch.setattr(ffmpeg_runtime.sys, "platform", "win32")
    monkeypatch.setattr(ffmpeg_runtime.subprocess, "CREATE_NO_WINDOW", 0x08000000, raising=False)
    assert ffmpeg_runtime.hidden_subprocess_creation_flags() == 0x08000000

    monkeypatch.setattr(ffmpeg_runtime.sys, "platform", "linux")
    assert ffmpeg_runtime.hidden_subprocess_creation_flags() == 0
