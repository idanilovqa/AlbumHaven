"""Public ASGI login boundary for local Album Haven authentication."""

from __future__ import annotations

import hmac
import ipaddress
import threading
from collections.abc import Mapping
from inspect import isawaitable
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool

from music_app.services.auth_audit_postgres import PostgresSecurityAuditRepository
from music_app.services.auth_login_postgres import LoginOutcome, PostgresLoginAuthService
from music_app.services.auth_password_reset_request_postgres import (
    PostgresPasswordResetRequestService,
)
from music_app.services.auth_password_reset_lifecycle_postgres import (
    PostgresPasswordResetLifecycleService,
    ResetCompletionOutcome,
)
from music_app.services.auth_passwords import PasswordPolicyError
from music_app.services.auth_preauth_postgres import PostgresPreAuthCsrfService
from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
from music_app.services.auth_sessions_postgres import SessionRevocationReason
from music_app.services.auth_session_csrf import (
    issue_session_csrf,
    matches_session_csrf,
)
from music_app.services.auth_reset_csrf import issue_reset_csrf, matches_reset_csrf
from music_app.services.auth_tokens import hash_opaque_token


router = APIRouter()

_PREAUTH_COOKIE = "__Host-album_haven_login_csrf"
_FORGOT_PREAUTH_COOKIE = "__Host-album_haven_forgot_csrf"
_RESET_TRANSACTION_COOKIE = "__Host-album_haven_reset"
_SESSION_COOKIE = "__Host-album_haven_session"
_SESSION_CSRF_COOKIE = "__Host-album_haven_csrf"
_FORM_CONTENT_TYPE = "application/x-www-form-urlencoded"
_MAXIMUM_BODY_BYTES = 8_192
_FALLBACK_TEMPLATES = Jinja2Templates(
    directory=str(Path(__file__).resolve().parent.parent / "templates")
)


def _no_store(response: Response) -> Response:
    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


def _render_login(
    request: Request,
    token: str,
    *,
    failed: bool,
    return_to: str,
) -> Response:
    templates = getattr(request.app.state, "templates", _FALLBACK_TEMPLATES)
    return templates.TemplateResponse(
        request,
        "login.html",
        {
            "request": request,
            "csrf_token": token,
            "failed": failed,
            "return_to": return_to,
        },
    )


def _render_recovery(
    request: Request,
    *,
    token: str | None,
    sent: bool,
) -> Response:
    templates = getattr(request.app.state, "templates", _FALLBACK_TEMPLATES)
    response = templates.TemplateResponse(
        request,
        "password-recovery.html",
        {
            "request": request,
            "csrf_token": token,
            "sent": sent,
        },
    )
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


def _render_reset(
    request: Request,
    *,
    csrf_token: str | None,
    completed: bool = False,
    password_invalid: bool = False,
) -> Response:
    templates = getattr(request.app.state, "templates", _FALLBACK_TEMPLATES)
    response = templates.TemplateResponse(
        request,
        "password-reset.html",
        {
            "request": request,
            "csrf_token": csrf_token,
            "completed": completed,
            "password_invalid": password_invalid,
        },
    )
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


def _cookie_secure(request: Request, config: Mapping[str, object]) -> bool | None:
    peer = _ip_address(request.client.host if request.client else None)
    if _peer_is_trusted_proxy(peer, config):
        forwarded_scheme = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().casefold()
        return True if forwarded_scheme == "https" else None
    if request.url.scheme == "https":
        return True
    if request.url.scheme == "http" and peer is not None and peer.is_loopback and _host_is_loopback(request.url.hostname):
        return True
    return None


def _policy_config(request: Request) -> Mapping[str, object]:
    injected = getattr(request.app.state, "auth_policy_config", None)
    if isinstance(injected, Mapping):
        return injected
    lock = getattr(request.app.state, "auth_service_lock", None)
    if lock is None:
        lock = threading.Lock()
        request.app.state.auth_service_lock = lock
    with lock:
        cached = getattr(request.app.state, "auth_policy_config", None)
        if isinstance(cached, Mapping):
            return cached
        from config import build_auth_config

        payload = dict(build_auth_config())
        runtime = getattr(request.app.state, "config", {})
        payload["ALBUM_HAVEN_APP_DATABASE_URL"] = str(
            runtime.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
        ).strip()
        request.app.state.auth_policy_config = payload
        return payload


def _services(request: Request):
    preauth = getattr(request.app.state, "auth_preauth_service", None)
    login = getattr(request.app.state, "auth_login_service", None)
    if preauth is not None and login is not None:
        return preauth, login
    config = _policy_config(request)
    lock = getattr(request.app.state, "auth_service_lock", None)
    if lock is None:
        lock = threading.Lock()
        request.app.state.auth_service_lock = lock
    with lock:
        preauth = getattr(request.app.state, "auth_preauth_service", None)
        login = getattr(request.app.state, "auth_login_service", None)
        if preauth is None:
            preauth = PostgresPreAuthCsrfService(config)
            request.app.state.auth_preauth_service = preauth
        if login is None:
            sessions = PostgresAuthSessionService(config)
            request.app.state.auth_session_service = sessions
            audit = PostgresSecurityAuditRepository()
            login = PostgresLoginAuthService(
                config, session_service=sessions, audit_repository=audit
            )
            request.app.state.auth_login_service = login
    return preauth, login


def _reset_request_service(request: Request):
    existing = getattr(request.app.state, "password_reset_request_service", None)
    if existing is not None:
        return existing
    config = _policy_config(request)
    lock = getattr(request.app.state, "auth_service_lock", None)
    if lock is None:
        lock = threading.Lock()
        request.app.state.auth_service_lock = lock
    with lock:
        existing = getattr(request.app.state, "password_reset_request_service", None)
        if existing is None:
            existing = PostgresPasswordResetRequestService(
                config,
                audit_repository=PostgresSecurityAuditRepository(),
            )
            request.app.state.password_reset_request_service = existing
    return existing


def _reset_lifecycle_service(request: Request):
    existing = getattr(request.app.state, "password_reset_lifecycle_service", None)
    if existing is not None:
        return existing
    config = _policy_config(request)
    lock = getattr(request.app.state, "auth_service_lock", None)
    if lock is None:
        lock = threading.Lock()
        request.app.state.auth_service_lock = lock
    with lock:
        existing = getattr(request.app.state, "password_reset_lifecycle_service", None)
        if existing is None:
            checker = getattr(request.app.state, "breached_password_checker", None)
            if checker is None:
                from music_app.services.auth_breached_passwords import (
                    HibpRangePasswordChecker,
                )

                checker = HibpRangePasswordChecker()
                request.app.state.breached_password_checker = checker
            existing = PostgresPasswordResetLifecycleService(
                config,
                breached_checker=checker,
                audit_repository=PostgresSecurityAuditRepository(),
            )
            request.app.state.password_reset_lifecycle_service = existing
    return existing


async def _login_page(
    request: Request,
    *,
    status_code: int,
    failed: bool,
    return_to: object | None = None,
) -> Response:
    try:
        config = _policy_config(request)
        secure = _cookie_secure(request, config)
        if secure is None:
            return _generic_bad_request()
        preauth, _ = _services(request)
        issued = await run_in_threadpool(preauth.issue_login_token)
        resolved_return_to = _safe_return_path(
            request.query_params.get("return_to") if return_to is None else return_to
        )
        response = _render_login(
            request,
            issued.raw_token,
            failed=failed,
            return_to=resolved_return_to,
        )
    except Exception:
        return _generic_unavailable()
    response.status_code = status_code
    response.set_cookie(
        _PREAUTH_COOKIE,
        issued.raw_token,
        max_age=600,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/",
    )
    return _no_store(response)


def _generic_bad_request() -> HTMLResponse:
    return _no_store(HTMLResponse("Sign-in request was invalid.", status_code=400))


def _generic_unavailable() -> HTMLResponse:
    return _no_store(HTMLResponse("Sign-in is temporarily unavailable.", status_code=503))


@router.get("/login", response_class=HTMLResponse)
async def get_login(request: Request) -> HTMLResponse:
    return await _login_page(request, status_code=200, failed=False)


@router.post("/login")
async def post_login(request: Request) -> Response:
    try:
        config = _policy_config(request)
    except Exception:
        return _generic_unavailable()
    secure = _cookie_secure(request, config)
    if secure is None or not _same_origin(request, config):
        return _generic_bad_request()
    payload = await _form_payload(request)
    if payload is None:
        return _generic_bad_request()
    cookie_token = request.cookies.get(_PREAUTH_COOKIE)
    form_token = payload["csrf_token"]
    if not _tokens_match(cookie_token, form_token):
        return _generic_bad_request()

    try:
        preauth, login = _services(request)
        consumed = await run_in_threadpool(preauth.consume_login_token, form_token)
    except Exception:
        return _generic_unavailable()
    if consumed is not True:
        return _generic_bad_request()

    source_key, source_class = _request_source(request, config)
    try:
        result = await run_in_threadpool(
            login.authenticate,
            entered_username=payload["username"],
            password=payload["password"],
            source_key=source_key,
            user_agent=request.headers.get("user-agent"),
            request_ref=uuid4().hex,
            source_class=source_class,
        )
    except Exception:
        return await _login_page(
            request,
            status_code=503,
            failed=True,
            return_to=payload.get("return_to"),
        )

    if result.outcome is not LoginOutcome.SUCCESS or result.session is None:
        return await _login_page(
            request,
            status_code=401,
            failed=True,
            return_to=payload.get("return_to"),
        )

    response = RedirectResponse(_safe_return_path(payload.get("return_to")), status_code=303)
    response.set_cookie(
        _SESSION_COOKIE,
        result.session.raw_token,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/",
    )
    response.set_cookie(
        _SESSION_CSRF_COOKIE,
        issue_session_csrf(result.session.raw_token, config),
        httponly=False,
        secure=secure,
        samesite="lax",
        path="/",
    )
    response.delete_cookie(
        _PREAUTH_COOKIE,
        path="/",
        secure=secure,
        httponly=True,
        samesite="lax",
    )
    return _no_store(response)


@router.get("/forgot-password", response_class=HTMLResponse)
async def get_forgot_password(request: Request) -> Response:
    try:
        config = _policy_config(request)
        secure = _cookie_secure(request, config)
        if secure is None:
            return _generic_bad_request()
        preauth, _ = _services(request)
        issued = await run_in_threadpool(preauth.issue_forgot_token)
        response = _render_recovery(
            request,
            token=issued.raw_token,
            sent=False,
        )
    except Exception:
        return _generic_recovery_unavailable()
    response.set_cookie(
        _FORGOT_PREAUTH_COOKIE,
        issued.raw_token,
        max_age=600,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/",
    )
    return _no_store(response)


@router.post("/forgot-password", response_class=HTMLResponse)
async def post_forgot_password(
    request: Request,
    background_tasks: BackgroundTasks,
) -> Response:
    try:
        config = _policy_config(request)
    except Exception:
        return _generic_recovery_unavailable()
    secure = _cookie_secure(request, config)
    if secure is None or not _same_origin(request, config):
        return _generic_recovery_bad_request()
    payload = await _form_payload(
        request,
        allowed=frozenset({"candidate", "csrf_token"}),
        required=frozenset({"candidate", "csrf_token"}),
    )
    if payload is None or not _tokens_match(
        request.cookies.get(_FORGOT_PREAUTH_COOKIE), payload.get("csrf_token")
    ):
        return _generic_recovery_bad_request()
    try:
        preauth, _ = _services(request)
        consumed = await run_in_threadpool(
            preauth.consume_forgot_token,
            payload["csrf_token"],
        )
    except Exception:
        return _generic_recovery_unavailable()
    if consumed is not True:
        return _generic_recovery_bad_request()

    source_key, source_class = _request_source(request, config)
    try:
        service = _reset_request_service(request)
        result = await run_in_threadpool(
            service.request_reset,
            candidate=payload["candidate"],
            source_key=source_key,
            request_ref=uuid4().hex,
            source_class=source_class,
        )
    except Exception:
        result = None

    delivery = getattr(result, "delivery", None)
    if delivery is not None:
        background_tasks.add_task(_deliver_password_reset, request.app, delivery)
    response = _render_recovery(request, token=None, sent=True)
    response.background = background_tasks
    response.delete_cookie(
        _FORGOT_PREAUTH_COOKIE,
        path="/",
        secure=secure,
        httponly=True,
        samesite="lax",
    )
    return _no_store(response)


def _generic_recovery_bad_request() -> HTMLResponse:
    response = HTMLResponse("Password recovery request was invalid.", status_code=400)
    response.headers["Referrer-Policy"] = "no-referrer"
    return _no_store(response)


def _generic_recovery_unavailable() -> HTMLResponse:
    response = HTMLResponse("Password recovery is temporarily unavailable.", status_code=503)
    response.headers["Referrer-Policy"] = "no-referrer"
    return _no_store(response)


async def _deliver_password_reset(app, delivery) -> None:
    try:
        callback = getattr(app.state, "password_reset_delivery", None)
        if callable(callback):
            result = callback(delivery)
            if isawaitable(result):
                await result
            return
        from config import build_mail_config
        from music_app.services.auth_mail_outbox_postgres import deliver_password_reset

        mail_config = build_mail_config()
        if mail_config.get("password_reset_enabled") is not True:
            return
        await deliver_password_reset(
            delivery,
            config=mail_config,
            database_url=app.state.auth_policy_config[
                "ALBUM_HAVEN_APP_DATABASE_URL"
            ],
        )
    except Exception:
        # Public response and token issuance remain independent of SMTP outcome.
        return


@router.get("/reset-password", response_class=HTMLResponse)
async def get_reset_password(request: Request) -> Response:
    try:
        config = _policy_config(request)
        secure = _cookie_secure(request, config)
        if secure is None:
            return _generic_reset_invalid()
        service = _reset_lifecycle_service(request)
    except Exception:
        return _generic_reset_unavailable()

    stored_token = getattr(request.state, "password_reset_link_token", None)
    stored_purpose = getattr(request.state, "password_reset_link_purpose", None)
    stored_valid = getattr(request.state, "password_reset_link_query_valid", None)
    query_pairs = list(request.query_params.multi_items())
    if stored_valid is not None:
        supplied_token = stored_token
        supplied_purpose = stored_purpose
        query_valid = stored_valid is True
    else:
        supplied_token = request.query_params.get("token")
        supplied_purpose = request.query_params.get("purpose")
        query_valid = (
            not query_pairs
            or (
                len(query_pairs) == 2
                and sum(key == "purpose" for key, _value in query_pairs) == 1
                and sum(key == "token" for key, _value in query_pairs) == 1
            )
        )
    if supplied_token is not None or supplied_purpose is not None:
        if (
            not query_valid
            or supplied_purpose != "password-reset"
            or not supplied_token
        ):
            return _generic_reset_invalid()
        try:
            issued = await run_in_threadpool(
                service.exchange_reset_token,
                supplied_token,
                request_ref=uuid4().hex,
            )
        except Exception:
            return _generic_reset_unavailable()
        if issued is None:
            return _generic_reset_invalid()
        response = RedirectResponse("/reset-password", status_code=303)
        response.set_cookie(
            _RESET_TRANSACTION_COOKIE,
            issued.raw_token,
            max_age=15 * 60,
            httponly=True,
            secure=secure,
            samesite="lax",
            path="/",
        )
        response.headers["Referrer-Policy"] = "no-referrer"
        return _no_store(response)

    raw_transaction = request.cookies.get(_RESET_TRANSACTION_COOKIE)
    try:
        valid = await run_in_threadpool(
            service.validate_transaction,
            raw_transaction,
        )
        if not valid:
            return _generic_reset_invalid()
        csrf_token = issue_reset_csrf(raw_transaction, config)
    except Exception:
        return _generic_reset_unavailable()
    return _no_store(_render_reset(request, csrf_token=csrf_token))


@router.post("/reset-password", response_class=HTMLResponse)
async def post_reset_password(request: Request) -> Response:
    try:
        config = _policy_config(request)
        secure = _cookie_secure(request, config)
    except Exception:
        return _generic_reset_unavailable()
    if secure is None or not _same_origin(request, config):
        return _generic_reset_invalid()
    payload = await _form_payload(
        request,
        allowed=frozenset(
            {"new_password", "confirm_password", "csrf_token"}
        ),
        required=frozenset(
            {"new_password", "confirm_password", "csrf_token"}
        ),
    )
    raw_transaction = request.cookies.get(_RESET_TRANSACTION_COOKIE)
    if (
        payload is None
        or payload["new_password"] != payload["confirm_password"]
        or not matches_reset_csrf(
            raw_transaction,
            payload["csrf_token"],
            config,
        )
    ):
        return _generic_reset_invalid()
    try:
        service = _reset_lifecycle_service(request)
        outcome = await run_in_threadpool(
            service.complete_reset,
            raw_transaction,
            new_password=payload["new_password"],
            request_ref=uuid4().hex,
        )
    except PasswordPolicyError:
        response = _render_reset(
            request,
            csrf_token=payload["csrf_token"],
            password_invalid=True,
        )
        response.status_code = 400
        return _no_store(response)
    except Exception:
        return _generic_reset_unavailable()
    if outcome is not ResetCompletionOutcome.SUCCESS:
        response = _generic_reset_invalid()
    else:
        response = _render_reset(request, csrf_token=None, completed=True)
    response.delete_cookie(
        _RESET_TRANSACTION_COOKIE,
        path="/",
        secure=secure,
        httponly=True,
        samesite="lax",
    )
    return _no_store(response)


def _generic_reset_invalid() -> HTMLResponse:
    response = HTMLResponse(
        "This password reset link is invalid or expired.", status_code=400
    )
    response.headers["Referrer-Policy"] = "no-referrer"
    return _no_store(response)


def _generic_reset_unavailable() -> HTMLResponse:
    response = HTMLResponse("Password reset is temporarily unavailable.", status_code=503)
    response.headers["Referrer-Policy"] = "no-referrer"
    return _no_store(response)


def _session_service(request: Request):
    sessions = getattr(request.app.state, "auth_session_service", None)
    if sessions is not None:
        return sessions
    config = _policy_config(request)
    lock = getattr(request.app.state, "auth_service_lock", None)
    if lock is None:
        lock = threading.Lock()
        request.app.state.auth_service_lock = lock
    with lock:
        sessions = getattr(request.app.state, "auth_session_service", None)
        if sessions is None:
            sessions = PostgresAuthSessionService(config)
            request.app.state.auth_session_service = sessions
    return sessions


@router.post("/logout")
async def post_logout(request: Request) -> Response:
    try:
        config = _policy_config(request)
    except Exception:
        return _no_store(HTMLResponse("Logout is temporarily unavailable.", status_code=503))
    secure = _cookie_secure(request, config)
    if secure is None or not _same_origin(request, config):
        return _no_store(HTMLResponse("Logout request was invalid.", status_code=400))
    payload = await _form_payload(
        request,
        allowed=frozenset({"csrf_token"}),
        required=frozenset({"csrf_token"}),
    )
    raw_session = request.cookies.get(_SESSION_COOKIE)
    csrf_cookie = request.cookies.get(_SESSION_CSRF_COOKIE)
    if (
        payload is None
        or not _safe_text_match(payload["csrf_token"], csrf_cookie)
        or not matches_session_csrf(raw_session, payload["csrf_token"], config)
    ):
        return _no_store(HTMLResponse("Logout request was invalid.", status_code=400))
    try:
        sessions = _session_service(request)
        await run_in_threadpool(
            sessions.revoke_current,
            raw_session,
            SessionRevocationReason.LOGOUT,
        )
    except Exception:
        return _no_store(HTMLResponse("Logout is temporarily unavailable.", status_code=503))

    response = RedirectResponse("/login", status_code=303)
    for cookie_name, httponly in (
        (_SESSION_COOKIE, True),
        (_SESSION_CSRF_COOKIE, False),
    ):
        response.delete_cookie(
            cookie_name,
            path="/",
            secure=secure,
            httponly=httponly,
            samesite="lax",
        )
    return _no_store(response)


def _safe_text_match(left: object, right: object) -> bool:
    if not isinstance(left, str) or not isinstance(right, str):
        return False
    try:
        return hmac.compare_digest(left, right)
    except TypeError:
        return False


def _tokens_match(cookie_token: object, form_token: object) -> bool:
    try:
        cookie_digest = hash_opaque_token(cookie_token)  # type: ignore[arg-type]
        form_digest = hash_opaque_token(form_token)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    return hmac.compare_digest(cookie_digest, form_digest)


async def _form_payload(
    request: Request,
    *,
    allowed: frozenset[str] = frozenset(
        {"username", "password", "csrf_token", "return_to"}
    ),
    required: frozenset[str] = frozenset(
        {"username", "password", "csrf_token"}
    ),
) -> dict[str, str] | None:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().casefold()
    if content_type != _FORM_CONTENT_TYPE:
        return None
    try:
        content_length = int(request.headers.get("content-length", "0"))
    except ValueError:
        return None
    if content_length < 1 or content_length > _MAXIMUM_BODY_BYTES:
        return None
    body = await request.body()
    if len(body) != content_length or len(body) > _MAXIMUM_BODY_BYTES:
        return None
    try:
        pairs = parse_qsl(
            body.decode("utf-8"),
            keep_blank_values=True,
            strict_parsing=True,
            max_num_fields=8,
        )
    except (UnicodeDecodeError, ValueError):
        return None
    values: dict[str, str] = {}
    for key, value in pairs:
        if key not in allowed or key in values:
            return None
        values[key] = value
    if not required.issubset(values):
        return None
    return values


def _same_origin(request: Request, config: Mapping[str, object]) -> bool:
    trusted = config.get("trusted_origins")
    origins = {str(item) for item in trusted} if isinstance(trusted, (tuple, list)) else set()
    origin = request.headers.get("origin")
    if origin is not None:
        if origin in origins:
            return True
        peer = _ip_address(request.client.host if request.client else None)
        return bool(
            request.url.scheme == "http"
            and peer is not None
            and peer.is_loopback
            and not _peer_is_trusted_proxy(peer, config)
            and _host_is_loopback(request.url.hostname)
            and origin == f"http://{request.url.netloc}"
        )
    referer = request.headers.get("referer")
    if not referer:
        return False
    try:
        parsed = urlsplit(referer)
        return f"{parsed.scheme}://{parsed.netloc}" in origins
    except Exception:
        return False


def _request_source(request: Request, config: Mapping[str, object]) -> tuple[str, str]:
    peer_text = request.client.host if request.client else "unknown"
    peer = _ip_address(peer_text)
    if _peer_is_trusted_proxy(peer, config):
        forwarded_ip = _forwarded_client_address(
            request.headers.get("x-forwarded-for", ""), config
        )
        return (
            str(forwarded_ip) if forwarded_ip is not None else str(peer),
            "trusted_proxy",
        )
    if peer is not None and peer.is_loopback:
        return peer_text, "loopback"
    if peer is not None and peer.is_private:
        return peer_text, "private"
    return peer_text, "public"


def _ip_address(value: object):
    try:
        return ipaddress.ip_address(str(value))
    except ValueError:
        return None


def _peer_is_trusted_proxy(peer, config: Mapping[str, object]) -> bool:
    if peer is None:
        return False
    configured = config.get("trusted_proxies")
    if not isinstance(configured, (tuple, list)):
        return False
    for value in configured:
        try:
            if peer in ipaddress.ip_network(str(value), strict=False):
                return True
        except ValueError:
            continue
    return False


def _forwarded_client_address(value: str, config: Mapping[str, object]):
    hops = [item.strip() for item in value.split(",") if item.strip()]
    parsed_hops = [_ip_address(item) for item in hops]
    if not parsed_hops or any(item is None for item in parsed_hops):
        return None
    for hop in reversed(parsed_hops):
        if not _peer_is_trusted_proxy(hop, config):
            return hop
    return parsed_hops[0]


def _host_is_loopback(value: object) -> bool:
    if str(value or "").casefold() == "localhost":
        return True
    address = _ip_address(value)
    return bool(address is not None and address.is_loopback)


def _safe_return_path(value: object) -> str:
    if not isinstance(value, str) or not value.startswith("/") or value.startswith("//"):
        return "/"
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        return "/"
    try:
        decoded = value
        for _ in range(3):
            next_value = unquote(decoded)
            if next_value == decoded:
                break
            decoded = next_value
        parsed = urlsplit(decoded)
    except Exception:
        return "/"
    if (
        parsed.scheme
        or parsed.netloc
        or "\\" in decoded
        or not decoded.startswith("/")
        or decoded.startswith("//")
    ):
        return "/"
    return value
