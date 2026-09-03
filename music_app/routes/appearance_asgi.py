"""Account-owned appearance JSON actions and authenticated shell hydration."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.auth_asgi import _policy_config
from music_app.services.appearance_preferences_postgres import (
    PostgresAppearancePreferencesRepository,
    expand_appearance_preferences,
    normalize_appearance_preferences,
)
from music_app.services.auth_session_csrf import issue_session_csrf


router = APIRouter()
_NO_STORE = {"Cache-Control": "no-store, max-age=0"}


def _repository(request: Request):
    injected = getattr(request.app.state, "appearance_preferences_repository", None)
    if injected is not None:
        return injected
    return PostgresAppearancePreferencesRepository(_policy_config(request))


async def load_appearance_context(request: Request) -> dict[str, object]:
    """Load only this request's actor; never retain preferences in application state."""
    colors = expand_appearance_preferences({"main_surface_color": None, "panel_background_color": None})
    actor = getattr(request.state, "current_actor", None)
    failed = False
    if actor is not None and actor.is_authenticated and actor.account_id is not None:
        try:
            colors = expand_appearance_preferences(await run_in_threadpool(
                _repository(request).load_preferences, account_id=actor.account_id
            ))
        except Exception:
            failed = True
    return {"appearance_preferences": colors, "appearance_load_error": failed}


@router.get("/account/appearance")
async def get_appearance(request: Request) -> JSONResponse:
    try:
        colors = expand_appearance_preferences(await run_in_threadpool(
            _repository(request).load_preferences,
            account_id=request.state.current_actor.account_id,
        ))
        token = issue_session_csrf(
            request.cookies.get("__Host-album_haven_session"), _policy_config(request)
        )
    except Exception:
        return JSONResponse({"error": "appearance_unavailable"}, status_code=503, headers=_NO_STORE)
    return JSONResponse({**colors, "csrf_token": token}, headers=_NO_STORE)


@router.put("/account/appearance")
async def put_appearance(request: Request) -> JSONResponse:
    try:
        colors = normalize_appearance_preferences(await request.json())
    except (ValueError, UnicodeDecodeError):
        return JSONResponse({"error": "invalid_appearance"}, status_code=400, headers=_NO_STORE)
    try:
        saved = expand_appearance_preferences(await run_in_threadpool(
            _repository(request).save_preferences,
            account_id=request.state.current_actor.account_id,
            preferences=colors,
        ))
    except Exception:
        return JSONResponse({"error": "appearance_unavailable"}, status_code=503, headers=_NO_STORE)
    return JSONResponse(saved, headers=_NO_STORE)
