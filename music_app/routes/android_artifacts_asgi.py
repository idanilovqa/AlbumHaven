"""Public Android update artifacts (Update Manifest v1 and immutable APKs).

Files come from the directory named by ``ALBUM_HAVEN_ANDROID_ARTIFACTS_DIR``, which holds one
``stable`` and one ``sandbox`` subdirectory. Only a channel's ``manifest.json`` and its flat
``*.apk`` files are served; there is no listing, and nothing reveals the configured location.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse, PlainTextResponse, Response

ARTIFACTS_DIR_ENV = "ALBUM_HAVEN_ANDROID_ARTIFACTS_DIR"
ARTIFACTS_PREFIX = "/artifacts/android/"
_CHANNELS = frozenset({"stable", "sandbox"})
_APK_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.apk")
_MANIFEST_HEADERS = {"Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"}
_APK_HEADERS = {"Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"}

router = APIRouter()


def _not_found() -> Response:
    return PlainTextResponse("Not found.", status_code=404, headers={"Cache-Control": "no-store"})


def _artifact_file(channel: str, name: str) -> Path | None:
    root = str(os.environ.get(ARTIFACTS_DIR_ENV) or "").strip()
    if not root or channel not in _CHANNELS:
        return None
    channel_dir = Path(root) / channel
    candidate = channel_dir / name
    try:
        # Symlinks and anything resolving outside the channel directory are not artifacts.
        if candidate.is_symlink() or candidate.resolve().parent != channel_dir.resolve():
            return None
    except OSError:
        return None
    return candidate if candidate.is_file() else None


@router.api_route("/artifacts/android/{channel}/manifest.json", methods=["GET", "HEAD"])
async def android_manifest(channel: str) -> Response:
    path = _artifact_file(channel, "manifest.json")
    if path is None:
        return _not_found()
    return FileResponse(path, media_type="application/json", headers=_MANIFEST_HEADERS)


@router.api_route("/artifacts/android/{channel}/{name}", methods=["GET", "HEAD"])
async def android_apk(channel: str, name: str) -> Response:
    path = _artifact_file(channel, name) if _APK_NAME.fullmatch(name) else None
    if path is None:
        return _not_found()
    return FileResponse(path, media_type="application/vnd.android.package-archive", headers=_APK_HEADERS)
