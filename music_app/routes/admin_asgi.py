"""Protected administrator account-management endpoints."""

from __future__ import annotations

import json
import threading

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.services.admin_account_creation import AdminAccountCreationService
from music_app.services.admin_account_creation_postgres import (
    ManagedAccountIdentityConflict,
    PostgresAdminAccountRepository,
)
from music_app.services.auth_passwords import PasswordPolicyError


router = APIRouter()
_MAX_BODY_BYTES = 16_384
_FIELDS = frozenset(
    {"username", "contact_email", "password", "capability_keys"}
)


@router.post("/admin/accounts", status_code=201)
async def create_managed_account(request: Request):
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
    return JSONResponse(
        {
            "account_id": result.account_id,
            "welcome_outbox_id": result.welcome_outbox_id,
            "active": True,
        },
        status_code=201,
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
