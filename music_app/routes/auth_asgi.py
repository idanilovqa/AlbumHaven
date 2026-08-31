"""Public ASGI login boundary for local Album Haven authentication."""

from __future__ import annotations

import hmac
import ipaddress
import threading
from collections.abc import Mapping
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit
from uuid import uuid4

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool

from music_app.services.auth_audit_postgres import PostgresSecurityAuditRepository
from music_app.services.auth_login_postgres import LoginOutcome, PostgresLoginAuthService
from music_app.services.auth_preauth_postgres import PostgresPreAuthCsrfService
from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
from music_app.services.auth_tokens import hash_opaque_token


router = APIRouter()

_PREAUTH_COOKIE = "__Host-album_haven_login_csrf"
_SESSION_COOKIE = "__Host-album_haven_session"
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
            audit = PostgresSecurityAuditRepository(config)
            login = PostgresLoginAuthService(
                config, session_service=sessions, audit_repository=audit
            )
            request.app.state.auth_login_service = login
    return preauth, login


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
    response.delete_cookie(
        _PREAUTH_COOKIE,
        path="/",
        secure=secure,
        httponly=True,
        samesite="lax",
    )
    return _no_store(response)


def _tokens_match(cookie_token: object, form_token: object) -> bool:
    try:
        cookie_digest = hash_opaque_token(cookie_token)  # type: ignore[arg-type]
        form_digest = hash_opaque_token(form_token)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    return hmac.compare_digest(cookie_digest, form_digest)


async def _form_payload(request: Request) -> dict[str, str] | None:
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
    allowed = {"username", "password", "csrf_token", "return_to"}
    values: dict[str, str] = {}
    for key, value in pairs:
        if key not in allowed or key in values:
            return None
        values[key] = value
    if not all(key in values for key in ("username", "password", "csrf_token")):
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
