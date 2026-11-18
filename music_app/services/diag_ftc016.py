"""DIAGNOSTIC ONLY (never merge): FTC-PLAYER-016 waveform/ffmpeg timeline."""

from __future__ import annotations

import json
import os
import tempfile
import time

DIAG_PATH = os.path.join(tempfile.gettempdir(), "album-haven-diag-ftc016.log")


def diag(event: str, **fields: object) -> None:
    try:
        with open(DIAG_PATH, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"epochMs": int(time.time() * 1000), "event": event, **fields}) + "\n")
    except Exception:
        pass


def track_name(path: object) -> str:
    return str(path or "").replace("\\", "/").rsplit("/", 1)[-1]
