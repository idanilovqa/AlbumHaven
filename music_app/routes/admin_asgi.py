"""Protected administrator account-management endpoints."""

from __future__ import annotations

import json
from inspect import isawaitable
from pathlib import Path
import threading
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool

from music_app.services.admin_account_creation import AdminAccountCreationService
from music_app.services.admin_account_creation_postgres import (
    ManagedAccountIdentityConflict,
    PostgresAdminAccountRepository,
)
from music_app.services.auth_passwords import PasswordPolicyError
from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.auth_audit_postgres import PostgresSecurityAuditRepository
from music_app.services.admin_members_postgres import PostgresAdminMembersService
from music_app.services.admin_member_mutation_postgres import (
    DestructiveConfirmationRequired,
    PostgresAdminMemberMutationService,
    RecentAuthenticationRequired,
)
from music_app.services.admin_reauthentication_postgres import (
    AdminReauthenticationOutcome,
    PostgresAdminReauthenticationService,
)
from music_app.services.admin_mail_actions_postgres import (
    PostgresAdminMailActionService,
)
from music_app.services.policy_asgi import allowed_actions_for_request


router = APIRouter()
_SESSION_COOKIE = "__Host-album_haven_session"
_FALLBACK_TEMPLATES = Jinja2Templates(
    directory=str(Path(__file__).resolve().parent.parent / "templates")
)
_MAX_BODY_BYTES = 16_384
_FIELDS = frozenset(
    {"username", "contact_email", "password", "capability_keys"}
)

_CAPABILITY_GROUPS = (
    (
        "Library",
        (
            ("library.browse.read", "View library"),
            ("library.media.read", "Play and download files"),
            ("library.problems.read", "Review library problems"),
            ("library.resources.read", "View library resources"),
        ),
    ),
    (
        "Personal",
        (
            ("library.playlists.create", "Create playlists"),
            ("library.playlists.manage", "Edit own playlists"),
            ("library.playlists.items.manage", "Manage playlist items"),
            ("library.track_preferences.manage", "Track preferences"),
            ("library.discovery.read", "Discovery and listening views"),
        ),
    ),
    (
        "Management",
        (
            ("library.rules.read", "View library rules"),
            ("library.logs.read", "View operational logs"),
            ("library.virtual_discography.read", "View virtual discography"),
        ),
    ),
)
_LISTENER_DEFAULTS = frozenset(
    {
        "library.browse.read",
        "library.media.read",
        "library.resources.read",
        "library.playlists.create",
        "library.discovery.read",
    }
)
_ADMIN_ACTIONS = (
    "accounts.read",
    "accounts.create",
    "accounts.manage",
    "accounts.membership.manage",
    "accounts.capabilities.manage",
    "accounts.sessions.revoke",
    "accounts.welcome.send",
    "accounts.password_reset.send",
    "accounts.reauthenticate",
)


@router.get("/admin/members", response_class=HTMLResponse)
async def members_roster(request: Request) -> Response:
    roster = await _load_roster(request)
    if isinstance(roster, Response):
        return roster
    return _render_admin(
        request,
        "admin-members.html",
        roster=roster,
        created=request.query_params.get("created") == "1",
        listener_defaults=_LISTENER_DEFAULTS,
        allowed_actions=_allowed_actions(request),
    )


@router.get("/admin/accounts/new", response_class=HTMLResponse)
async def new_managed_account(request: Request) -> Response:
    roster = await _load_roster(request)
    if isinstance(roster, Response):
        return roster
    return _render_admin(
        request,
        "admin-account-detail.html",
        roster=roster,
        member=None,
        capability_groups=_CAPABILITY_GROUPS,
        listener_defaults=_LISTENER_DEFAULTS,
        allowed_actions=_allowed_actions(request),
    )


@router.get("/admin/accounts/{account_id}", response_class=HTMLResponse)
async def edit_managed_account(request: Request, account_id: int) -> Response:
    roster = await _load_roster(request)
    if isinstance(roster, Response):
        return roster
    member = next((item for item in roster.members if item.account_id == account_id), None)
    if member is None:
        return HTMLResponse("Account was not found.", status_code=404)
    return _render_admin(
        request,
        "admin-account-detail.html",
        roster=roster,
        member=member,
        capability_groups=_CAPABILITY_GROUPS,
        listener_defaults=_LISTENER_DEFAULTS,
        allowed_actions=_allowed_actions(request, target_account_id=account_id),
    )


@router.patch("/admin/accounts/{account_id}")
async def update_managed_account(request: Request, account_id: int) -> Response:
    payload = await _management_payload(request)
    if payload is None:
        return JSONResponse({"detail": "Account update was invalid."}, status_code=400)
    actor = request.state.current_actor
    if actor.account_id is None or actor.current_library_id is None:
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    decisions = _allowed_actions(request, target_account_id=account_id)
    if not all(
        decisions.allows(action)
        for action in (
            "accounts.manage",
            "accounts.membership.manage",
            "accounts.capabilities.manage",
        )
    ):
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    try:
        await run_in_threadpool(
            _mutation_service(request).update_account,
            actor_account_id=actor.account_id,
            actor_authenticated_at=actor.authenticated_at,
            library_id=actor.current_library_id,
            target_account_id=account_id,
            is_active=payload["is_active"],
            current_library_access=payload["current_library_access"],
            capability_keys=payload["capability_keys"],
            confirm_disable=payload["confirm_disable"],
            confirm_remove_access=payload["confirm_remove_access"],
            request_ref=uuid4().hex,
        )
    except RecentAuthenticationRequired:
        return JSONResponse({"detail": "Recent authentication is required."}, status_code=409)
    except DestructiveConfirmationRequired:
        return JSONResponse({"detail": "Explicit confirmation is required."}, status_code=409)
    except PermissionError:
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    except ValueError:
        return JSONResponse({"detail": "Account update was invalid."}, status_code=400)
    except Exception:
        return JSONResponse({"detail": "Account update is temporarily unavailable."}, status_code=503)
    return JSONResponse({"updated": True})


@router.post("/admin/accounts/{account_id}/sessions/revoke")
async def revoke_managed_account_sessions(request: Request, account_id: int) -> Response:
    payload = await _confirmed_payload(request)
    if payload is None:
        return JSONResponse({"detail": "Session revocation was invalid."}, status_code=400)
    actor = request.state.current_actor
    if actor.account_id is None or actor.current_library_id is None:
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    try:
        await run_in_threadpool(
            _mutation_service(request).revoke_sessions,
            actor_account_id=actor.account_id,
            actor_authenticated_at=actor.authenticated_at,
            library_id=actor.current_library_id,
            target_account_id=account_id,
            confirmed=payload["confirmed"],
            request_ref=uuid4().hex,
        )
    except RecentAuthenticationRequired:
        return JSONResponse({"detail": "Recent authentication is required."}, status_code=409)
    except DestructiveConfirmationRequired:
        return JSONResponse({"detail": "Explicit confirmation is required."}, status_code=409)
    except PermissionError:
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    except ValueError:
        return JSONResponse({"detail": "Session revocation was invalid."}, status_code=400)
    except Exception:
        return JSONResponse({"detail": "Session revocation is temporarily unavailable."}, status_code=503)
    return JSONResponse({"revoked": True})


@router.post("/admin/accounts/{account_id}/welcome", status_code=202)
async def resend_managed_account_welcome(
    request: Request, account_id: int, background_tasks: BackgroundTasks
) -> Response:
    if await _empty_payload(request) is None:
        return JSONResponse({"detail": "Mail action was invalid."}, status_code=400)
    outcome = await _queue_mail_action(request, account_id, "welcome")
    if isinstance(outcome, Response):
        return outcome
    if outcome.welcome_outbox_id is not None:
        background_tasks.add_task(
            _deliver_pending_welcome, request.app, outcome.welcome_outbox_id
        )
    return JSONResponse(
        {"accepted": True}, status_code=202, background=background_tasks
    )


@router.post("/admin/accounts/{account_id}/password-reset", status_code=202)
async def send_managed_account_password_reset(
    request: Request, account_id: int, background_tasks: BackgroundTasks
) -> Response:
    if await _empty_payload(request) is None:
        return JSONResponse({"detail": "Mail action was invalid."}, status_code=400)
    outcome = await _queue_mail_action(request, account_id, "password-reset")
    if isinstance(outcome, Response):
        return outcome
    if outcome.password_reset_delivery is not None:
        background_tasks.add_task(
            _deliver_pending_password_reset,
            request.app,
            outcome.password_reset_delivery,
        )
    return JSONResponse(
        {"accepted": True}, status_code=202, background=background_tasks
    )


@router.post("/admin/reauthenticate")
async def reauthenticate_administrator(request: Request) -> Response:
    payload = await _password_payload(request)
    if payload is None:
        return JSONResponse({"detail": "Reauthentication failed."}, status_code=400)
    actor = request.state.current_actor
    if actor.account_id is None or actor.session_id is None:
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    try:
        outcome = await run_in_threadpool(
            _reauthentication_service(request).reauthenticate,
            account_id=actor.account_id,
            session_id=actor.session_id,
            password=payload["password"],
            request_ref=uuid4().hex,
        )
    except Exception:
        return JSONResponse({"detail": "Reauthentication is temporarily unavailable."}, status_code=503)
    if outcome is AdminReauthenticationOutcome.SUCCESS:
        return JSONResponse({"refreshed": True})
    if outcome is AdminReauthenticationOutcome.INVALID:
        return JSONResponse({"detail": "Reauthentication failed."}, status_code=403)
    return JSONResponse({"detail": "Session changed. Sign in again."}, status_code=409)


@router.post("/admin/accounts", status_code=201)
async def create_managed_account(request: Request, background_tasks: BackgroundTasks):
    payload = await _json_payload(request)
    if payload is None:
        return _invalid()
    try:
        service = _service(request)
        result = await run_in_threadpool(
            service.create_account,
            actor=request.state.current_actor,
            username=payload["username"],
            contact_email=payload["contact_email"],
            password=payload["password"],
            capability_keys=payload["capability_keys"],
        )
    except PermissionError:
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    except ManagedAccountIdentityConflict:
        return JSONResponse(
            {"detail": "Username or contact email is already in use."},
            status_code=409,
        )
    except (PasswordPolicyError, ValueError):
        return _invalid()
    except Exception:
        return JSONResponse(
            {"detail": "Account creation is temporarily unavailable."},
            status_code=503,
        )
    background_tasks.add_task(
        _deliver_pending_welcome,
        request.app,
        result.welcome_outbox_id,
    )
    return JSONResponse(
        {
            "account_id": result.account_id,
            "welcome_outbox_id": result.welcome_outbox_id,
            "active": True,
        },
        status_code=201,
        background=background_tasks,
    )


async def _json_payload(request: Request) -> dict[str, object] | None:
    if request.headers.get("content-type", "").split(";", 1)[0].strip().casefold() != "application/json":
        return None
    try:
        length = int(request.headers.get("content-length", "0"))
    except ValueError:
        return None
    if length < 2 or length > _MAX_BODY_BYTES:
        return None
    body = await request.body()
    if len(body) != length:
        return None
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or set(payload) != _FIELDS:
        return None
    if not all(isinstance(payload[key], str) for key in ("username", "contact_email", "password")):
        return None
    capabilities = payload["capability_keys"]
    if not isinstance(capabilities, list) or any(
        not isinstance(item, str) for item in capabilities
    ):
        return None
    return payload


async def _management_payload(request: Request) -> dict[str, object] | None:
    payload = await _bounded_json_object(request)
    expected = {
        "is_active",
        "current_library_access",
        "capability_keys",
        "confirm_disable",
        "confirm_remove_access",
    }
    if payload is None or set(payload) != expected:
        return None
    if any(
        not isinstance(payload[key], bool)
        for key in (
            "is_active",
            "current_library_access",
            "confirm_disable",
            "confirm_remove_access",
        )
    ):
        return None
    capabilities = payload["capability_keys"]
    if not isinstance(capabilities, list) or any(
        not isinstance(item, str) for item in capabilities
    ):
        return None
    return payload


async def _confirmed_payload(request: Request) -> dict[str, object] | None:
    payload = await _bounded_json_object(request)
    if payload is None or set(payload) != {"confirmed"}:
        return None
    return payload if isinstance(payload["confirmed"], bool) else None


async def _password_payload(request: Request) -> dict[str, object] | None:
    payload = await _bounded_json_object(request)
    if payload is None or set(payload) != {"password"}:
        return None
    return payload if isinstance(payload["password"], str) else None


async def _empty_payload(request: Request) -> dict[str, object] | None:
    payload = await _bounded_json_object(request)
    return payload if payload == {} else None


async def _queue_mail_action(request: Request, account_id: int, action: str):
    actor = request.state.current_actor
    if actor.account_id is None or actor.current_library_id is None:
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    method = (
        _mail_action_service(request).queue_welcome
        if action == "welcome"
        else _mail_action_service(request).queue_password_reset
    )
    try:
        return await run_in_threadpool(
            method,
            actor_account_id=actor.account_id,
            actor_authenticated_at=actor.authenticated_at,
            library_id=actor.current_library_id,
            target_account_id=account_id,
            request_ref=uuid4().hex,
        )
    except RecentAuthenticationRequired:
        return JSONResponse(
            {"detail": "Recent authentication is required."}, status_code=409
        )
    except PermissionError:
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    except ValueError:
        return JSONResponse({"detail": "Mail action was invalid."}, status_code=400)
    except Exception:
        return JSONResponse(
            {"detail": "Mail action is temporarily unavailable."}, status_code=503
        )


async def _bounded_json_object(request: Request) -> dict[str, object] | None:
    if request.headers.get("content-type", "").split(";", 1)[0].strip().casefold() != "application/json":
        return None
    try:
        length = int(request.headers.get("content-length", "0"))
    except ValueError:
        return None
    if length < 2 or length > _MAX_BODY_BYTES:
        return None
    body = await request.body()
    if len(body) != length:
        return None
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


async def _load_roster(request: Request):
    actor = request.state.current_actor
    if actor.account_id is None or actor.current_library_id is None:
        return HTMLResponse("Action not permitted.", status_code=403)
    try:
        return await run_in_threadpool(
            _members_service(request).load_roster,
            actor_account_id=actor.account_id,
            library_id=actor.current_library_id,
        )
    except PermissionError:
        return HTMLResponse("Action not permitted.", status_code=403)
    except Exception:
        return HTMLResponse("Members & Access is temporarily unavailable.", status_code=503)


def _render_admin(request: Request, template: str, **context) -> Response:
    try:
        csrf_token = issue_session_csrf(
            request.cookies.get(_SESSION_COOKIE), request.app.state.auth_policy_config
        )
    except (TypeError, ValueError):
        return HTMLResponse("Members & Access is temporarily unavailable.", status_code=503)
    templates = getattr(request.app.state, "templates", _FALLBACK_TEMPLATES)
    response = templates.TemplateResponse(
        request,
        template,
        {"request": request, "csrf_token": csrf_token, **context},
    )
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


def _allowed_actions(request: Request, *, target_account_id: int | None = None):
    return allowed_actions_for_request(
        request, _ADMIN_ACTIONS, target_account_id=target_account_id
    )


def _members_service(request: Request):
    existing = getattr(request.app.state, "admin_members_service", None)
    if existing is not None:
        return existing
    lock = getattr(request.app.state, "auth_service_lock", None)
    if lock is None:
        lock = threading.Lock()
        request.app.state.auth_service_lock = lock
    with lock:
        existing = getattr(request.app.state, "admin_members_service", None)
        if existing is None:
            existing = PostgresAdminMembersService(request.app.state.auth_policy_config)
            request.app.state.admin_members_service = existing
    return existing


def _mutation_service(request: Request):
    existing = getattr(request.app.state, "admin_member_mutation_service", None)
    if existing is not None:
        return existing
    lock = getattr(request.app.state, "auth_service_lock", None)
    if lock is None:
        lock = threading.Lock()
        request.app.state.auth_service_lock = lock
    with lock:
        existing = getattr(request.app.state, "admin_member_mutation_service", None)
        if existing is None:
            existing = PostgresAdminMemberMutationService(
                request.app.state.auth_policy_config
            )
            request.app.state.admin_member_mutation_service = existing
    return existing


def _reauthentication_service(request: Request):
    existing = getattr(request.app.state, "admin_reauthentication_service", None)
    if existing is not None:
        return existing
    lock = getattr(request.app.state, "auth_service_lock", None)
    if lock is None:
        lock = threading.Lock()
        request.app.state.auth_service_lock = lock
    with lock:
        existing = getattr(request.app.state, "admin_reauthentication_service", None)
        if existing is None:
            existing = PostgresAdminReauthenticationService(
                request.app.state.auth_policy_config,
                audit_repository=PostgresSecurityAuditRepository(),
            )
            request.app.state.admin_reauthentication_service = existing
    return existing


def _mail_action_service(request: Request):
    existing = getattr(request.app.state, "admin_mail_action_service", None)
    if existing is not None:
        return existing
    lock = getattr(request.app.state, "auth_service_lock", None)
    if lock is None:
        lock = threading.Lock()
        request.app.state.auth_service_lock = lock
    with lock:
        existing = getattr(request.app.state, "admin_mail_action_service", None)
        if existing is None:
            existing = PostgresAdminMailActionService(
                request.app.state.auth_policy_config
            )
            request.app.state.admin_mail_action_service = existing
    return existing


def _service(request: Request):
    existing = getattr(request.app.state, "admin_account_creation_service", None)
    if existing is not None:
        return existing
    lock = getattr(request.app.state, "auth_service_lock", None)
    if lock is None:
        lock = threading.Lock()
        request.app.state.auth_service_lock = lock
    with lock:
        existing = getattr(request.app.state, "admin_account_creation_service", None)
        if existing is not None:
            return existing
        config = request.app.state.auth_policy_config
        checker = getattr(request.app.state, "breached_password_checker", None)
        if checker is None:
            from music_app.services.auth_breached_passwords import (
                HibpRangePasswordChecker,
            )

            checker = HibpRangePasswordChecker()
            request.app.state.breached_password_checker = checker
        if not callable(checker):
            raise RuntimeError("Password screening is unavailable.")
        service = AdminAccountCreationService(
            repository=PostgresAdminAccountRepository(config),
            breached_checker=checker,
            argon2=config["argon2"],
            policy_version=config["argon2_policy_version"],
        )
        request.app.state.admin_account_creation_service = service
        return service


def _invalid():
    return JSONResponse({"detail": "Account request was invalid."}, status_code=400)


async def _deliver_pending_welcome(app, outbox_id: int) -> None:
    try:
        delivery = getattr(app.state, "welcome_delivery", None)
        if callable(delivery):
            result = delivery(outbox_id)
            if isawaitable(result):
                await result
            return
        from config import build_mail_config
        from music_app.services.auth_mail_outbox_postgres import (
            PostgresWelcomeOutboxService,
            deliver_welcome,
        )

        mail_config = build_mail_config()
        if mail_config.get("welcome_enabled") is not True:
            return
        repository_config = dict(mail_config)
        repository_config["ALBUM_HAVEN_APP_DATABASE_URL"] = app.state.auth_policy_config[
            "ALBUM_HAVEN_APP_DATABASE_URL"
        ]
        await deliver_welcome(
            outbox_id,
            config=mail_config,
            repository=PostgresWelcomeOutboxService(repository_config),
        )
    except Exception:
        # Account activation and the committed retryable outbox row are non-gating.
        return


async def _deliver_pending_password_reset(app, delivery) -> None:
    try:
        runner = getattr(app.state, "password_reset_delivery", None)
        if callable(runner):
            result = runner(delivery)
            if isawaitable(result):
                await result
            return
        from config import build_mail_config
        from music_app.services.auth_mail_outbox_postgres import (
            PostgresPasswordResetOutboxService,
            deliver_password_reset,
        )

        mail_config = build_mail_config()
        if mail_config.get("password_reset_enabled") is not True:
            return
        repository_config = dict(mail_config)
        repository_config["ALBUM_HAVEN_APP_DATABASE_URL"] = (
            app.state.auth_policy_config["ALBUM_HAVEN_APP_DATABASE_URL"]
        )
        await deliver_password_reset(
            delivery,
            config=mail_config,
            repository=PostgresPasswordResetOutboxService(repository_config),
        )
    except Exception:
        # The committed token and outbox row remain authoritative; send attempts
        # are deliberately non-gating and ambiguous failures are terminal.
        return
