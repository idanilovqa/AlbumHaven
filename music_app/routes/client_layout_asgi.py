"""Authenticated, CSRF-protected account presentation preferences."""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.auth_asgi import _policy_config
from music_app.services.recent_albums import PostgresRecentAlbums
from music_app.services.policy_asgi import _library_scope, allowed_actions_for_request
from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.services.client_layout_preferences import (
    PROFILES, PostgresClientLayoutPreferences, default_preferences, normalize_changes, normalize_profile,
)

router = APIRouter()
_NO_STORE = {"Cache-Control": "no-store, max-age=0"}


def _repository(request: Request):
    return getattr(request.app.state, "client_layout_preferences_repository", None) or PostgresClientLayoutPreferences(_policy_config(request))


async def load_client_layout_context(request: Request) -> dict[str, object]:
    actor = getattr(request.state, "current_actor", None)
    evaluation = getattr(request.state, "policy_evaluation", None)
    surface = getattr(getattr(evaluation, "audit", None), "client_surface_class", "private_web")
    payload = {"account_id": None, "profiles": {}, "load_failed": False, "client_surface_class": surface}
    if actor is not None and actor.is_authenticated and actor.account_id is not None:
        payload["account_id"] = actor.account_id
        payload["profiles"] = {profile: default_preferences(profile) for profile in PROFILES}
        try:
            payload["profiles"] = await run_in_threadpool(_repository(request).load_profiles, account_id=actor.account_id)
        except Exception:
            # Keep the page available, but expose the failure rather than claim sync.
            payload["load_failed"] = True
    return {"client_layout_preferences": payload}


@router.get("/account/layout-preferences")
async def get_layout_preferences(request: Request) -> JSONResponse:
    context = await load_client_layout_context(request)
    payload = context["client_layout_preferences"]
    return JSONResponse(payload, status_code=503 if payload["load_failed"] else 200, headers=_NO_STORE)


@router.put("/account/layout-preferences")
async def put_layout_preferences(request: Request) -> JSONResponse:
    if request.headers.get("X-Album-Haven-Account") != str(request.state.current_actor.account_id):
        return JSONResponse({"error": "account_changed_reload_required"}, status_code=409, headers=_NO_STORE)
    try:
        payload = await read_bounded_json_object(request)
        if not isinstance(payload, dict) or set(payload) != {"profile", "changes"}:
            raise ValueError("Invalid layout preferences.")
        profile = normalize_profile(payload["profile"])
        changes = normalize_changes(payload["changes"])
    except JSONBodyTooLarge:
        return JSONResponse({"error": "layout_payload_too_large"}, status_code=413, headers=_NO_STORE)
    except (ValueError, UnicodeDecodeError):
        return JSONResponse({"error": "invalid_layout_preferences"}, status_code=400, headers=_NO_STORE)
    try:
        preferences = await run_in_threadpool(
            _repository(request).save_changes,
            account_id=request.state.current_actor.account_id,
            profile=profile,
            changes=changes,
        )
    except Exception:
        return JSONResponse({"error": "layout_preferences_unavailable"}, status_code=503, headers=_NO_STORE)
    return JSONResponse({"profile": profile, "preferences": preferences}, headers=_NO_STORE)


@router.get("/home/recent-albums")
async def recent_albums(request: Request) -> JSONResponse:
    actor = request.state.current_actor
    library_id = _library_scope(actor, "library.browse.read", None)
    if library_id is None:
        return JSONResponse({"albums": []}, headers=_NO_STORE)
    repository = getattr(request.app.state, "recent_albums_repository", None) or PostgresRecentAlbums(_policy_config(request))
    try:
        albums = await run_in_threadpool(repository.load, account_id=actor.account_id, library_id=library_id)
    except Exception:
        return JSONResponse({"error": "recent_albums_unavailable"}, status_code=503, headers=_NO_STORE)
    actions = allowed_actions_for_request(request, (
        "library.inventory.manage", "library.files.edit_tags", "library.rules.manage",
        "library.files.open_location", "library.covers.fetch",
    )).as_payload()
    for album in albums:
        album["allowed_actions"] = actions
    return JSONResponse({"albums": albums}, headers=_NO_STORE)
