"""Android update artifacts (Update Manifest v1 and immutable APKs) for attested app installs.

Files come from the directory named by ``ALBUM_HAVEN_ANDROID_ARTIFACTS_DIR``, which holds one
``stable`` and one ``sandbox`` subdirectory. Only a channel's ``manifest.json`` and its flat
``*.apk`` files are served; there is no listing, and nothing reveals the configured location.

Every route except the short-lived download link sits behind the private route boundary
(signed in, ``app.access``). The manifest and the APK exchange also need a request signed by a
device key this account attested (see ``android_artifact_access``). The exchange returns a
five-minute HMAC link for one file, which ``DownloadManager`` fetches without cookies.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from starlette.concurrency import run_in_threadpool

from music_app.routes.access_log_redaction import redact_access_log_paths
from music_app.routes.auth_asgi import _policy_config
from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_body, read_bounded_json_object
from music_app.services.android_artifact_access import (
    APK_NAME,
    CHANNELS,
    AndroidArtifactAccess,
    ArtifactAccessError,
)

ARTIFACTS_DIR_ENV = "ALBUM_HAVEN_ANDROID_ARTIFACTS_DIR"
DOWNLOAD_PREFIX = "/artifacts/android/download/"
_NO_STORE = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
_MAX_ATTEST_BYTES = 64 * 1024
_DETAILS = {
    "invalid_request": "Invalid artifact request.",
    "signed_out": "Authentication required.",
    "challenge_invalid": "Challenge expired or already used.",
    "too_many_challenges": "Too many open challenges.",
    "attestation_required": "This device is not attested.",
    "attestation_refused": "Device attestation was refused.",
    "signature_invalid": "Request signature is not valid.",
    "attestation_unavailable": "Device attestation is unavailable.",
}

router = APIRouter()
redact_access_log_paths(DOWNLOAD_PREFIX)


def _not_found() -> Response:
    return PlainTextResponse("Not found.", status_code=404, headers=_NO_STORE)


def _refused(error: ArtifactAccessError) -> Response:
    return JSONResponse({"detail": _DETAILS.get(error.code, "Request refused."), "code": error.code},
                        status_code=error.status, headers=_NO_STORE)


def _access(request: Request) -> AndroidArtifactAccess:
    """The app's one access service, built on first use because the auth policy loads lazily."""
    state = request.app.state
    access = getattr(state, "android_artifact_access", None)
    if access is None:
        access = state.android_artifact_access = AndroidArtifactAccess(state.config, _policy_config(request))
    return access


def _artifact_file(channel: str, name: str) -> Path | None:
    root = str(os.environ.get(ARTIFACTS_DIR_ENV) or "").strip()
    if not root or channel not in CHANNELS:
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


async def _json(request: Request, max_bytes: int = 16_384) -> dict:
    try:
        payload = await read_bounded_json_object(request, max_bytes=max_bytes)
    except JSONBodyTooLarge:
        payload = None
    if not payload or type(payload.get("protocol")) is not int or payload["protocol"] != 1:
        raise ArtifactAccessError(400, "invalid_request")
    return payload


async def _require_empty_body(request: Request) -> None:
    try:
        body = await read_bounded_body(request, max_bytes=0)
    except JSONBodyTooLarge:
        body = None
    if body is None:
        raise ArtifactAccessError(400, "invalid_request")


async def _signed(request: Request, channel: str):
    """Verifies the device signature over this bodiless request."""
    return await run_in_threadpool(
        _access(request).verify_signed_request, request.state.current_actor, channel,
        request.method, request.url.path, request.headers,
    )


@router.post("/artifacts/android/challenge")
async def android_artifact_challenge(request: Request) -> Response:
    try:
        payload = await _json(request)
        result = await run_in_threadpool(
            _access(request).issue_challenge, request.state.current_actor,
            payload.get("channel"), payload.get("purpose"),
        )
    except ArtifactAccessError as error:
        return _refused(error)
    return JSONResponse(result, headers=_NO_STORE)


@router.post("/artifacts/android/attest")
async def android_artifact_attest(request: Request) -> Response:
    try:
        payload = await _json(request, _MAX_ATTEST_BYTES)
        result = await run_in_threadpool(
            _access(request).attest, request.state.current_actor,
            payload.get("channel"), payload.get("challenge"), payload.get("chain"),
        )
    except ArtifactAccessError as error:
        return _refused(error)
    return JSONResponse(result, headers=_NO_STORE)


@router.api_route("/artifacts/android/download/{token}", methods=["GET", "HEAD"])
async def android_artifact_download(request: Request, token: str) -> Response:
    grant = await run_in_threadpool(_access(request).resolve_download_token, token)
    path = _artifact_file(grant.channel, grant.name) if grant is not None else None
    if path is None:
        return PlainTextResponse("Download link is not valid.", status_code=403, headers=_NO_STORE)
    return FileResponse(path, media_type="application/vnd.android.package-archive",
                        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})


@router.get("/artifacts/android/{channel}/manifest.json")
async def android_manifest(request: Request, channel: str) -> Response:
    if channel not in CHANNELS:
        return _not_found()
    try:
        await _signed(request, channel)
    except ArtifactAccessError as error:
        return _refused(error)
    path = _artifact_file(channel, "manifest.json")
    if path is None:
        return _not_found()
    return FileResponse(path, media_type="application/json", headers=_NO_STORE)


@router.post("/artifacts/android/{channel}/{name}")
async def android_apk_exchange(request: Request, channel: str, name: str) -> Response:
    """Exchanges the manifest's immutable APK URL for a short-lived download link."""
    if channel not in CHANNELS or not APK_NAME.fullmatch(name):
        return _not_found()
    try:
        await _require_empty_body(request)
        device_key = await _signed(request, channel)
        if _artifact_file(channel, name) is None:
            return _not_found()
        result = await run_in_threadpool(
            _access(request).issue_download_token, request.state.current_actor, device_key, channel, name,
        )
    except ArtifactAccessError as error:
        return _refused(error)
    return JSONResponse(result, headers=_NO_STORE)
