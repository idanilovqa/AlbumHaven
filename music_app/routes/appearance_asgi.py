"""Account-owned appearance JSON actions and authenticated shell hydration."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.auth_asgi import _policy_config
from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.services.appearance_preferences_postgres import (
    AppearanceLoopStyleForbidden,
    AppearanceRevisionConflict,
    PostgresAppearancePreferencesRepository,
    appearance_client_profile,
    expand_appearance_preferences,
    normalize_appearance_device_profiles,
    normalize_appearance_preferences,
    resolve_appearance_device_profile,
)
from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.policy_asgi import allowed_actions_for_request


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
            repository = _repository(request)
            load = getattr(repository, "load_device_profiles", None)
            client_profile = _client_profile(request)
            if load:
                snapshot = await run_in_threadpool(load, account_id=actor.account_id)
                colors = resolve_appearance_device_profile(snapshot, profile=client_profile)
            else:
                colors = expand_appearance_preferences(await run_in_threadpool(
                    repository.load_preferences, account_id=actor.account_id,
                    client_profile=client_profile,
                ))
        except Exception:
            failed = True
    return {"appearance_preferences": colors, "appearance_load_error": failed}


@router.get("/account/appearance")
async def get_appearance(request: Request) -> JSONResponse:
    try:
        repository = _repository(request)
        load = getattr(repository, "load_device_profiles", None)
        if load:
            colors = await run_in_threadpool(
                load, account_id=request.state.current_actor.account_id,
            )
        else:
            colors = expand_appearance_preferences(await run_in_threadpool(
                repository.load_preferences,
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
        payload = await read_bounded_json_object(request)
        if payload is None:
            raise ValueError("Invalid JSON object.")
        expected_revision = payload.pop("expected_revision", None)
        device_profiles = payload.pop("device_profiles", None)
        action_button_outlines = payload.pop("action_button_outlines", None)
        colors = normalize_appearance_preferences(payload)
        aggregate = "interaction_overrides" in colors
        device_profile_write = device_profiles is not None or action_button_outlines is not None
        if device_profile_write and (device_profiles is None or type(action_button_outlines) is not bool):
            raise ValueError("Device profiles and action-button preference are required together.")
        if device_profile_write and not aggregate:
            raise ValueError("Device profiles require the revision-controlled aggregate.")
        if "loop_control_style" in colors and not aggregate:
            raise ValueError("Loop style writes require a revision-controlled aggregate.")
        if aggregate and (type(expected_revision) is not int or expected_revision < 0):
            raise ValueError("Invalid expected revision.")
        if not aggregate and expected_revision is not None:
            raise ValueError("Unexpected revision.")
        if device_profile_write:
            normalize_appearance_device_profiles(
                device_profiles,
                base_preferences={**colors, "action_button_outlines": action_button_outlines},
            )
    except JSONBodyTooLarge:
        return JSONResponse(
            {"error": "appearance_payload_too_large"},
            status_code=413,
            headers=_NO_STORE,
        )
    except (ValueError, UnicodeDecodeError):
        return JSONResponse({"error": "invalid_appearance"}, status_code=400, headers=_NO_STORE)
    try:
        repository = _repository(request)
        kwargs = {
            "account_id": request.state.current_actor.account_id,
            "preferences": colors,
        }
        if device_profile_write:
            kwargs.update(
                device_profiles=device_profiles,
                action_button_outlines=action_button_outlines,
            )
        else:
            kwargs["client_profile"] = _client_profile(request)
        if aggregate:
            kwargs["expected_revision"] = expected_revision
        if "loop_control_style" in colors or device_profile_write:
            kwargs["allow_loop_control_style"] = allowed_actions_for_request(
                request, ("library.loops.create",),
            ).as_payload().get("library.loops.create") is True
        save = repository.save_device_profiles if device_profile_write else repository.save_preferences
        result = await run_in_threadpool(save, **kwargs)
        saved = result if device_profile_write else expand_appearance_preferences(result)
    except AppearanceLoopStyleForbidden:
        return JSONResponse({"error": "loop_style_forbidden"}, status_code=403, headers=_NO_STORE)
    except AppearanceRevisionConflict as conflict:
        current = conflict.current if device_profile_write else expand_appearance_preferences(conflict.current)
        return JSONResponse({"error": "appearance_conflict", "appearance": current}, status_code=409, headers=_NO_STORE)
    except Exception:
        return JSONResponse({"error": "appearance_unavailable"}, status_code=503, headers=_NO_STORE)
    return JSONResponse(saved, headers=_NO_STORE)
