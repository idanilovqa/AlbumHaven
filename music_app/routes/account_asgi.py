"""Authenticated Profile/Account page and self-service password actions."""

from __future__ import annotations

import threading
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool

from music_app.routes.auth_asgi import (
    _form_payload,
    _policy_config,
    _same_origin,
)
from music_app.services.auth_audit_postgres import PostgresSecurityAuditRepository
from music_app.services.auth_passwords import PasswordPolicyError
from music_app.services.auth_profile_password_postgres import (
    PostgresProfilePasswordService,
    ProfilePasswordOutcome,
)
from music_app.services.auth_session_csrf import issue_session_csrf, matches_session_csrf


router = APIRouter()
_SESSION_COOKIE = "__Host-album_haven_session"
_FALLBACK_TEMPLATES = Jinja2Templates(
    directory=str(Path(__file__).resolve().parent.parent / "templates")
)


def _service(request: Request):
    existing = getattr(request.app.state, "profile_password_service", None)
    if existing is not None:
        return existing
    config = _policy_config(request)
    lock = getattr(request.app.state, "auth_service_lock", None)
    if lock is None:
        lock = threading.Lock()
        request.app.state.auth_service_lock = lock
    with lock:
        existing = getattr(request.app.state, "profile_password_service", None)
        if existing is None:
            checker = getattr(request.app.state, "breached_password_checker", None)
            if checker is None:
                from music_app.services.auth_breached_passwords import HibpRangePasswordChecker

                checker = HibpRangePasswordChecker()
                request.app.state.breached_password_checker = checker
            existing = PostgresProfilePasswordService(
                config,
                breached_checker=checker,
                audit_repository=PostgresSecurityAuditRepository(),
            )
            request.app.state.profile_password_service = existing
    return existing


async def _page(
    request: Request,
    *,
    status_code: int = 200,
    error: str | None = None,
) -> Response:
    actor = request.state.current_actor
    raw_session = request.cookies.get(_SESSION_COOKIE)
    try:
        config = _policy_config(request)
        profile = await run_in_threadpool(
            _service(request).load_profile,
            account_id=actor.account_id,
            current_session_id=actor.session_id,
        )
        if profile is None:
            raise RuntimeError
        csrf_token = issue_session_csrf(raw_session, config)
    except Exception:
        return HTMLResponse("Account settings are temporarily unavailable.", status_code=503)
    templates = getattr(request.app.state, "templates", _FALLBACK_TEMPLATES)
    response = templates.TemplateResponse(
        request,
        "account.html",
        {
            "request": request,
            "profile": profile,
            "csrf_token": csrf_token,
            "changed": request.query_params.get("changed") == "1",
            "error": error,
        },
        status_code=status_code,
    )
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


@router.get("/account", response_class=HTMLResponse)
async def get_account(request: Request) -> Response:
    return await _page(request)


@router.post("/account/password")
async def post_account_password(request: Request) -> Response:
    config = _policy_config(request)
    payload = await _form_payload(
        request,
        allowed=frozenset(
            {"current_password", "new_password", "confirm_password", "csrf_token"}
        ),
        required=frozenset(
            {"current_password", "new_password", "confirm_password", "csrf_token"}
        ),
    )
    raw_session = request.cookies.get(_SESSION_COOKIE)
    if (
        payload is None
        or not _same_origin(request, config)
        or payload["new_password"] != payload["confirm_password"]
        or not matches_session_csrf(raw_session, payload["csrf_token"], config)
    ):
        return await _page(request, status_code=400, error="invalid_request")
    actor = request.state.current_actor
    try:
        outcome = await run_in_threadpool(
            _service(request).change_password,
            account_id=actor.account_id,
            current_session_id=actor.session_id,
            current_password=payload["current_password"],
            new_password=payload["new_password"],
            request_ref=uuid4().hex,
        )
    except PasswordPolicyError:
        return await _page(request, status_code=400, error="password_policy")
    except Exception:
        return await _page(request, status_code=503, error="unavailable")
    if outcome is ProfilePasswordOutcome.CURRENT_PASSWORD_INVALID:
        return await _page(request, status_code=400, error="current_password")
    if outcome is not ProfilePasswordOutcome.SUCCESS:
        return await _page(request, status_code=409, error="stale")
    return RedirectResponse("/account?changed=1", status_code=303)


@router.post("/account/password-suggestion/dismiss")
async def post_dismiss_password_suggestion(request: Request) -> Response:
    config = _policy_config(request)
    payload = await _form_payload(
        request,
        allowed=frozenset({"csrf_token"}),
        required=frozenset({"csrf_token"}),
    )
    raw_session = request.cookies.get(_SESSION_COOKIE)
    if (
        payload is None
        or not _same_origin(request, config)
        or not matches_session_csrf(raw_session, payload["csrf_token"], config)
    ):
        return await _page(request, status_code=400, error="invalid_request")
    actor = request.state.current_actor
    try:
        await run_in_threadpool(
            _service(request).dismiss_suggestion,
            account_id=actor.account_id,
            request_ref=uuid4().hex,
        )
    except Exception:
        return await _page(request, status_code=503, error="unavailable")
    return RedirectResponse("/account", status_code=303)
