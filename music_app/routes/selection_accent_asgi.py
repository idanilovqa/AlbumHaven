"""Private, account-scoped selection accent API for the current web stack."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.services.policy_asgi import require_action
from music_app.services.private_route_boundary import _valid_session_csrf
from music_app.services.selection_accent import (
    PostgresSelectionAccentStore,
    normalize_selection_accent,
)


router = APIRouter()
_PATH = "/api/account/appearance/selection-accent"


def _response(payload: dict, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        payload, status_code=status_code,
        headers={"Cache-Control": "no-store, max-age=0"},
    )


async def _authorize(request: Request, action: str) -> JSONResponse | None:
    try:
        await require_action(action)(request)
    except HTTPException as exc:
        return _response({"detail": exc.detail}, exc.status_code)
    return None


def _store(request: Request) -> PostgresSelectionAccentStore:
    existing = getattr(request.app.state, "selection_accent_store", None)
    if existing is not None:
        return existing
    # The store has no in-memory preference state; every operation uses Postgres.
    return PostgresSelectionAccentStore(getattr(request.app.state, "config", {}))


@router.get(_PATH)
async def get_selection_accent(request: Request) -> JSONResponse:
    denied = await _authorize(request, "account.self.appearance.selection_accent.read")
    if denied is not None:
        return denied
    try:
        preference = await run_in_threadpool(
            _store(request).load, request.state.current_actor.account_id,
        )
    except Exception:
        return _response({"detail": "Selection accent is temporarily unavailable."}, 503)
    return _response({"selection_accent": preference})


@router.put(_PATH)
async def put_selection_accent(request: Request) -> JSONResponse:
    denied = await _authorize(request, "account.self.appearance.selection_accent.update")
    if denied is not None:
        return denied
    if not _valid_session_csrf(request):
        return _response({"detail": "CSRF validation failed."}, 403)
    try:
        raw_payload = await read_bounded_json_object(request)
        if raw_payload is None:
            raise ValueError("Invalid JSON object.")
        payload = normalize_selection_accent(raw_payload)
    except JSONBodyTooLarge:
        return _response({"detail": "Selection accent payload is too large."}, 413)
    except (TypeError, ValueError):
        return _response({"detail": "Selection accent requires a boolean and six-digit hex color."}, 400)
    try:
        preference = await run_in_threadpool(
            _store(request).save, request.state.current_actor.account_id, payload,
        )
    except Exception:
        return _response({"detail": "Selection accent could not be saved. Please retry."}, 503)
    return _response({"selection_accent": preference})
