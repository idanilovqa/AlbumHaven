from __future__ import annotations

import shutil
import subprocess
import sys


def resolve_ffmpeg_executable() -> str | None:
    executable = shutil.which("ffmpeg")
    if executable:
        return executable

    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def hidden_subprocess_creation_flags() -> int:
    if not sys.platform.startswith("win"):
        return 0
    return int(getattr(subprocess, "CREATE_NO_WINDOW", 0))
