from __future__ import annotations

import logging
import os
from pathlib import Path
import subprocess
import sys

logger = logging.getLogger(__name__)


def open_in_system_file_explorer(paths: list[Path]) -> None:
    if sys.platform.startswith("win"):
        for path in paths:
            try:
                logger.warning("open_in_system_file_explorer: os.startfile(%s)", str(path))
                os.startfile(str(path))  # type: ignore[attr-defined]
                _focus_file_explorer_window(path)
            except Exception as exc:
                logger.exception("open_in_system_file_explorer: os.startfile failed for %s: %s", str(path), exc)
                subprocess.Popen(["explorer", str(path)])
                _focus_file_explorer_window(path)
        return
    if sys.platform == "darwin":
        for path in paths:
            subprocess.Popen(["open", str(path)])
        return
    for path in paths:
        subprocess.Popen(["xdg-open", str(path)])


def _focus_file_explorer_window(path: Path) -> None:
    if not sys.platform.startswith("win"):
        return

    powershell_script = (
        "Start-Sleep -Milliseconds 250; "
        "$ws = New-Object -ComObject WScript.Shell; "
        "$activated = $ws.AppActivate('File Explorer'); "
        "Write-Output ('focused=' + $activated)"
    )
    try:
        logger.warning("open_in_system_file_explorer: attempting Explorer focus for %s", str(path))
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", powershell_script],
            capture_output=True,
            text=True,
            timeout=3,
        )
        logger.warning(
            "open_in_system_file_explorer: focus attempt finished for %s returncode=%s stdout=%r stderr=%r",
            str(path),
            result.returncode,
            result.stdout.strip(),
            result.stderr.strip(),
        )
    except Exception as exc:
        logger.exception("open_in_system_file_explorer: focus attempt failed for %s: %s", str(path), exc)
