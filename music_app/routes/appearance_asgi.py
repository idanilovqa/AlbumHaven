"""Account-owned appearance JSON actions and authenticated shell hydration."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.auth_asgi import _policy_config
from music_app.services.appearance_preferences_postgres import (
    AppearanceRevisionConflict,
    PostgresAppearancePreferencesRepository,
    appearance_client_profile,
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


def _client_profile(request: Request) -> str:
    # Policy owns this classification. Current required web requests are
    # private_web -> desktop; optional/future hosts can supply their trusted class.
    evaluation = getattr(request.state, "policy_evaluation", None)
    trusted_surface = getattr(getattr(evaluation, "audit", None), "client_surface_class", "private_web")
    return appearance_client_profile(trusted_surface)


async def load_appearance_context(request: Request) -> dict[str, object]:
    """Load only this request's actor; never retain preferences in application state."""
    colors = expand_appearance_preferences({"main_surface_color": None, "panel_background_color": None})
    actor = getattr(request.state, "current_actor", None)
    failed = False
    if actor is not None and actor.is_authenticated and actor.account_id is not None:
        try:
            colors = expand_appearance_preferences(await run_in_threadpool(
                _repository(request).load_preferences, account_id=actor.account_id,
                client_profile=_client_profile(request),
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
            client_profile=_client_profile(request),
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
        payload = await request.json()
        expected_revision = payload.pop("expected_revision", None) if isinstance(payload, dict) else None
        colors = normalize_appearance_preferences(payload)
        aggregate = "interaction_overrides" in colors
        if aggregate and (type(expected_revision) is not int or expected_revision < 0):
            raise ValueError("Invalid expected revision.")
        if not aggregate and expected_revision is not None:
            raise ValueError("Unexpected revision.")
    except (ValueError, UnicodeDecodeError):
        return JSONResponse({"error": "invalid_appearance"}, status_code=400, headers=_NO_STORE)
    try:
        kwargs = {
            "account_id": request.state.current_actor.account_id,
            "preferences": colors,
            "client_profile": _client_profile(request),
        }
        if aggregate:
            kwargs["expected_revision"] = expected_revision
        saved = expand_appearance_preferences(await run_in_threadpool(
            _repository(request).save_preferences, **kwargs,
        ))
    except AppearanceRevisionConflict as conflict:
        return JSONResponse({"error": "appearance_conflict", "appearance": expand_appearance_preferences(conflict.current)}, status_code=409, headers=_NO_STORE)
    except Exception:
        return JSONResponse({"error": "appearance_unavailable"}, status_code=503, headers=_NO_STORE)
    return JSONResponse(saved, headers=_NO_STORE)
