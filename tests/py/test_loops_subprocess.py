from __future__ import annotations

from types import SimpleNamespace

from music_app.services import loops
from music_app.services import ffmpeg_runtime


def test_loop_ffmpeg_processes_suppress_windows_console_windows(tmp_path, monkeypatch):
    calls: list[dict[str, object]] = []

    def fake_run(command, **kwargs):
        calls.append({"command": command, "kwargs": kwargs})
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    source_path = tmp_path / "source.mp3"
    source_path.write_bytes(b"audio")
    monkeypatch.setattr(loops.tempfile, "tempdir", str(tmp_path))
    monkeypatch.setattr(loops, "_resolve_ffmpeg_executable", lambda: "ffmpeg.exe")
    monkeypatch.setattr(loops.subprocess, "run", fake_run)

    output_path = loops.create_loop_file(
        {"DATA_DIR": tmp_path / "app-data"},
        source_path,
        1.0,
        2.0,
        "loop-1",
    )
    loops._run_ffmpeg(["ffmpeg.exe", "-version"])

    assert output_path.name == "loop-1.mp3"
    assert len(calls) == 2
    assert all(
        call["kwargs"]["creationflags"] == loops._NO_WINDOW_CREATION_FLAGS
        for call in calls
    )


def test_loops_preserves_monkeypatchable_shared_runtime_alias():
    assert loops._resolve_ffmpeg_executable is ffmpeg_runtime.resolve_ffmpeg_executable


def test_loops_uses_shared_hidden_subprocess_flags():
    assert loops._NO_WINDOW_CREATION_FLAGS == ffmpeg_runtime.hidden_subprocess_creation_flags()
