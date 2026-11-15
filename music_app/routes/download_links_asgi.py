"""Cookie-less download links (``android_download_links``) for an allowlist of download routes.

``POST /downloads/links`` sits behind the private route boundary (signed in, session CSRF). It
links only a path on the allowlist below, and only when the current actor passes that route's own
authorization. ``GET /downloads/<token>`` is public: it re-runs that authorization for the account
the token names, which must still be active, and streams the file with ``Cache-Control: no-store``.
Access logs record ``/downloads/[redacted]``; no response or log names a file's location.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from music_app.routes.access_log_redaction import redact_access_log_paths
from music_app.routes.api_integration_helpers import resolve_foobar_asset
from music_app.routes.auth_asgi import _policy_config
from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.services.android_download_links import LINK_PREFIX, DownloadLinks
from music_app.services.current_actor_asgi import current_actor_for_account
from music_app.services.policy_asgi import require_action
from music_app.services.private_route_boundary import private_action_for_route

_NO_STORE = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
_MAX_BODY_BYTES = 2048

router = APIRouter()
redact_access_log_paths(LINK_PREFIX)


@dataclass(frozen=True)
class _File:
    path: Path
    media_type: str
    filename: str


def _foobar_asset(asset_key: str) -> _File | None:
    try:
        definition, path = resolve_foobar_asset(asset_key)
    except KeyError:
        return None
    return _File(path, definition["mime_type"], definition["filename"]) if path.is_file() else None


# Each download a link may name: its exact same-origin path, the GET route whose boundary action
# authorizes it, and the file for the path's one parameter.
_ALLOWLIST = (
    (re.compile(r"/utilities/integrations/foobar/assets/([a-z0-9][a-z0-9-]{0,127})\?download=1"),
     "/utilities/integrations/foobar/assets/{asset_key}", _foobar_asset),
)


async def _allowed_file(request: Request, path) -> _File | None:
    """The file [path] names when it is allowlisted and the request's actor passes its route's authorization."""
    for pattern, route_path, resolve in _ALLOWLIST:
        match = pattern.fullmatch(path) if isinstance(path, str) else None
        if match is None:
            continue
        try:
            await require_action(private_action_for_route("GET", route_path))(request)
        except HTTPException:
            return None
        return resolve(match.group(1))
    return None


def _links(request: Request) -> DownloadLinks:
    """The app's one link signer, built on first use because the auth policy loads lazily."""
    state = request.app.state
    links = getattr(state, "download_links", None)
    if links is None:
        links = state.download_links = DownloadLinks(_policy_config(request))
    return links


@router.post("/downloads/links")
async def issue_download_link(request: Request) -> Response:
    try:
        payload = await read_bounded_json_object(request, max_bytes=_MAX_BODY_BYTES)
    except JSONBodyTooLarge:
        payload = None
    links = _links(request)
    if payload is None or not links.available or await _allowed_file(request, payload.get("path")) is None:
        return JSONResponse({"detail": "Download unavailable.", "code": "download_unavailable"},
                            status_code=403, headers=_NO_STORE)
    return JSONResponse(links.issue(request.state.current_actor.account_id, payload["path"]), headers=_NO_STORE)


@router.api_route("/downloads/{token}", methods=["GET", "HEAD"])
async def download_by_link(request: Request, token: str) -> Response:
    grant = _links(request).resolve(token)
    file = None
    if grant is not None:
        account_id, path = grant
        await current_actor_for_account(request, account_id)
        file = await _allowed_file(request, path)
    if file is None:
        return Response("Download link is not valid.", status_code=403, media_type="text/plain", headers=_NO_STORE)
    return FileResponse(file.path, media_type=file.media_type, filename=file.filename, headers=_NO_STORE)
