"""Account-only Foobar Settings page; never starts the library/media shell."""
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, Response

from music_app.routes.appearance_asgi import load_appearance_context
from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.foobar_account_ui_context import (
    FOOBAR_ACCOUNT_CONTEXT_SCOPE, FoobarAccountUIContextError,
    foobar_account_ui_context_ref,
)
from music_app.services.policy_asgi import allowed_actions_for_request, require_action


router = APIRouter()
_ACTION = "account.self.foobar.write"
_HEADERS = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}


@router.get("/account/integrations/foobar", response_class=HTMLResponse)
async def get_account_foobar(request: Request) -> Response:
    # Page policy is independent of capability presentation and worker readiness.
    await require_action(_ACTION, refresh_actor=True)(request)
    try:
        appearance = await load_appearance_context(request)
        # Do not sign the actor snapshot from before appearance's asynchronous IO.
        await require_action(_ACTION, refresh_actor=True)(request)
        actor = request.state.current_actor
        marker = foobar_account_ui_context_ref(request)
        if marker is None:
            raise FoobarAccountUIContextError()
        actions = allowed_actions_for_request(
            request, ("accounts.read", _ACTION, "library.browse.read"),
            target_account_id=actor.account_id,
        )
        matching_library_id = actor.current_library_id
        if (type(matching_library_id) is not int
                or not 1 <= matching_library_id <= 9007199254740991
                or not actions.allows("library.browse.read")):
            matching_library_id = None
        csrf_token = issue_session_csrf(
            request.cookies.get("__Host-album_haven_session"),
            request.app.state.auth_policy_config,
        )
    except FoobarAccountUIContextError:
        return HTMLResponse("Foobar settings are temporarily unavailable.", status_code=503, headers=_HEADERS)
    response = request.app.state.templates.TemplateResponse(request, "account-foobar.html", {
        "request": request,
        "runtime_asset_version": getattr(request.app.state, "runtime_asset_version", ""),
        **appearance,
        "account_allowed_actions": actions,
        "account_foobar_allowed": actions.allows(_ACTION),
        "account_foobar_context": marker,
        "account_foobar_scope": FOOBAR_ACCOUNT_CONTEXT_SCOPE,
        "account_foobar_matching_library_id": matching_library_id,
        "csrf_token": csrf_token,
        "settings_section": "foobar",
    })
    response.headers.update(_HEADERS)
    return response


@router.get("/account/foobar-history", response_class=HTMLResponse)
async def get_account_foobar_history(request: Request) -> Response:
    """Own imported evidence is readable without library or mutation grants."""
    action = "account.self.foobar.read"
    await require_action(action, refresh_actor=True)(request)
    try:
        appearance = await load_appearance_context(request)
        await require_action(action, refresh_actor=True)(request)
        actor = request.state.current_actor
        marker = foobar_account_ui_context_ref(request)
        if marker is None:
            raise FoobarAccountUIContextError()
        actions = allowed_actions_for_request(request,
            ("accounts.read", action, "account.self.foobar.write"),
            target_account_id=actor.account_id)
        csrf_token = issue_session_csrf(
            request.cookies.get("__Host-album_haven_session"),
            request.app.state.auth_policy_config)
    except FoobarAccountUIContextError:
        return HTMLResponse("Foobar history is temporarily unavailable.", status_code=503, headers=_HEADERS)
    response = request.app.state.templates.TemplateResponse(request, "account-foobar-history.html", {
        "request": request,
        "runtime_asset_version": getattr(request.app.state, "runtime_asset_version", ""),
        **appearance,
        "account_allowed_actions": actions,
        "account_foobar_history_allowed": actions.allows(action),
        "account_foobar_context": marker,
        "account_foobar_scope": FOOBAR_ACCOUNT_CONTEXT_SCOPE,
        "csrf_token": csrf_token,
        "settings_section": "foobar-history",
    })
    response.headers.update(_HEADERS)
    return response
