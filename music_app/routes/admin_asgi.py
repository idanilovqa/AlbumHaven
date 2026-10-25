"""Protected administrator account-management endpoints."""

from __future__ import annotations

from collections.abc import Mapping
import json
from pathlib import Path
import threading
from uuid import uuid4

from fastapi import APIRouter, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool

from music_app.routes.appearance_asgi import load_appearance_context
from music_app.routes.bounded_json import read_bounded_json_object
from music_app.services.admin_account_creation import AdminAccountCreationService
from music_app.services.admin_account_creation_postgres import (
    ManagedAccountIdentityConflict,
    PostgresAdminAccountRepository,
)
from music_app.services.admin_account_invitations_postgres import (
    PostgresAdminAccountInvitationService,
)
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
from music_app.services.policy_asgi import (
    allowed_actions_for_request,
    request_origin_ref_for_request,
)
from music_app.services.capability_assignments import AssignmentConflict, assignment_editor, member_role_label
from music_app.services.generated_preview_storage import (
    preview_storage_policy_from_mapping,
    validate_custom_root,
)
from music_app.services.generated_preview_storage_postgres import PreviewStorageConflict
from music_app.services.library_roots import configured_library_root_paths_snapshot


router = APIRouter()
_SESSION_COOKIE = "__Host-album_haven_session"
_FALLBACK_TEMPLATES = Jinja2Templates(
    directory=str(Path(__file__).resolve().parent.parent / "templates")
)
_MAX_BODY_BYTES = 16_384
_FIELDS = frozenset(
    {"username", "contact_email", "capability_keys", "send_invitation"}
)

_CAPABILITY_GROUPS = (
    (
        "Library",
        (
            ("library.browse.read", "View library"),
            ("library.media.read", "Play and download files"),
            ("library.problems.read", "Review library problems"),
            ("library.inventory.manage", "Remove missing library inventory"),
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
            ("library.loops.read", "View saved loops"),
            ("library.loops.media.read", "Play saved loop media"),
            ("library.opinions.read", "View album opinions"),
            ("integration.lastfm.scrobbles.submit", "Submit pending Last.fm scrobbles"),
        ),
    ),
    (
        "Management",
        (
            ("library.rules.read", "View library rules"),
            ("library.logs.read", "View operational logs"),
            ("library.logs.export", "Export operational logs"),
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
    "accounts.invitation.copy",
    "accounts.invitation.send",
    "accounts.reauthenticate",
    "system.preview_storage.read",
    "system.preview_storage.manage",
    "system.preview_storage.cancel",
    "system.preview_storage.retry",
)

_PREVIEW_STORAGE_ACTIVE_STATES = frozenset({"queued", "running", "cancel_requested"})


@router.get("/admin/server", response_class=HTMLResponse)
async def admin_server(request: Request) -> Response:
    return await _render_admin(
        request,
        "admin-server.html",
        allowed_actions=_allowed_actions(request),
    )


@router.get("/admin/server/preview-storage")
async def get_preview_storage(request: Request) -> Response:
    try:
        state = await run_in_threadpool(_preview_storage_repository(request).load)
    except Exception:
        return JSONResponse(
            {"detail": "Album preview storage is temporarily unavailable."},
            status_code=503,
        )
    return _preview_storage_response(state)


@router.put("/admin/server/preview-storage", status_code=202)
async def update_preview_storage(request: Request) -> Response:
    payload = await _bounded_json_object(request)
    if (
        payload is None
        or set(payload) != {"mode", "path", "expected_revision", "confirmed"}
        or payload.get("mode") not in {"album_folders", "custom"}
        or not isinstance(payload.get("path"), str)
        or type(payload.get("expected_revision")) is not int
        or not isinstance(payload.get("confirmed"), bool)
    ):
        return JSONResponse({"detail": "Preview storage request was invalid."}, status_code=400)
    try:
        repository = _preview_storage_repository(request)
        worker = _preview_storage_worker(request)
    except RuntimeError:
        return JSONResponse(
            {"detail": "Album preview storage is temporarily unavailable."},
            status_code=503,
        )
    try:
        current = await run_in_threadpool(repository.load)
    except Exception:
        return JSONResponse(
            {"detail": "Album preview storage is temporarily unavailable."},
            status_code=503,
        )
    if int(current.get("revision") or 0) != payload["expected_revision"]:
        return JSONResponse(
            {"detail": "Preview storage revision conflict. Reload and try again."},
            status_code=409,
        )
    if str(current.get("operation_state") or "idle") in _PREVIEW_STORAGE_ACTIVE_STATES:
        return JSONResponse(
            {"detail": "A preview relocation is already active."}, status_code=409
        )
    if current.get("requested_mode") is not None:
        return JSONResponse(
            {"detail": "Resume or retry the existing preview relocation before choosing another location."},
            status_code=409,
        )
    mode = str(payload["mode"])
    root = str(payload["path"]).strip() or None if mode == "custom" else None
    if _same_preview_storage_location(current, mode=mode, root=root):
        return _preview_storage_response(current, unchanged=True)
    if not payload["confirmed"]:
        return JSONResponse(
            {"detail": "Preview relocation confirmation is required."}, status_code=409
        )
    if mode == "custom":
        try:
            root = str(
                await run_in_threadpool(
                    validate_custom_root,
                    payload["path"],
                    configured_library_root_paths_snapshot(_app_config(request)),
                )
            )
        except ValueError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=400)
        except Exception:
            return JSONResponse(
                {"detail": "Album preview storage validation is temporarily unavailable."},
                status_code=503,
            )
    requested = None
    try:
        requested = await run_in_threadpool(
            repository.request_location,
            mode=mode,
            root=root,
            expected_revision=payload["expected_revision"],
        )
        state = await run_in_threadpool(
            repository.begin_operation,
            operation_id=uuid4().hex,
        )
    except PreviewStorageConflict as exc:
        if requested is not None:
            worker.wake()
        return JSONResponse({"detail": str(exc)}, status_code=409)
    except Exception:
        if requested is not None:
            worker.wake()
        return JSONResponse(
            {"detail": "Album preview relocation could not be started."},
            status_code=503,
        )
    _publish_preview_storage_state(request, state or requested)
    worker.wake()
    return _preview_storage_response(state or requested, status_code=202)


@router.post("/admin/server/preview-storage/cancel", status_code=202)
async def cancel_preview_storage(request: Request) -> Response:
    return await _transition_preview_storage(request, "cancel")


@router.post("/admin/server/preview-storage/retry", status_code=202)
async def retry_preview_storage(request: Request) -> Response:
    return await _transition_preview_storage(request, "retry_failed")


@router.get("/admin/members", response_class=HTMLResponse)
async def members_roster(request: Request) -> Response:
    roster = await _load_roster(request)
    if isinstance(roster, Response):
        return roster
    return await _render_admin(
        request,
        "admin-members.html",
        roster=roster,
        created=request.query_params.get("created") == "1",
        listener_defaults=_LISTENER_DEFAULTS,
        member_role_label=member_role_label,
        allowed_actions=_allowed_actions(request),
        invitation_email_enabled=_invitation_email_enabled(request.app),
    )


@router.get("/admin/accounts/new", response_class=HTMLResponse)
async def new_managed_account(request: Request) -> Response:
    roster = await _load_roster(request)
    if isinstance(roster, Response):
        return roster
    return await _render_admin(
        request,
        "admin-account-detail.html",
        roster=roster,
        member=None,
        capability_groups=_CAPABILITY_GROUPS,
        listener_defaults=_LISTENER_DEFAULTS,
        allowed_actions=_allowed_actions(request),
        invitation_email_enabled=_invitation_email_enabled(request.app),
    )


@router.get("/admin/accounts/{account_id}", response_class=HTMLResponse)
async def edit_managed_account(request: Request, account_id: int) -> Response:
    roster = await _load_roster(request, target_account_id=account_id)
    if isinstance(roster, Response):
        return roster
    member = next((item for item in roster.members if item.account_id == account_id), None)
    if member is None:
        return HTMLResponse("Account was not found.", status_code=404)
    return await _render_admin(
        request,
        "admin-account-detail.html",
        roster=roster,
        member=member,
        capability_groups=_CAPABILITY_GROUPS,
        listener_defaults=_LISTENER_DEFAULTS,
        allowed_actions=_allowed_actions(request, target_account_id=account_id,
            protected_target=member.is_bootstrap_owner),
        invitation_email_enabled=_invitation_email_enabled(request.app),
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
        saved = await run_in_threadpool(
            _mutation_service(request).update_account,
            actor_account_id=actor.account_id,
            actor_session_id=actor.session_id,
            actor_authenticated_at=actor.authenticated_at,
            library_id=actor.current_library_id,
            target_account_id=account_id,
            is_active=payload["is_active"],
            current_library_access=payload["current_library_access"],
            capability_keys=payload["capability_keys"],
            confirm_disable=payload["confirm_disable"],
            confirm_remove_access=payload["confirm_remove_access"],
            request_ref=uuid4().hex,
            **({"role_keys": payload["role_keys"], "access_revision": payload["access_revision"]}
               if "role_keys" in payload else {}),
        )
    except AssignmentConflict as exc:
        return JSONResponse({"detail": str(exc)}, status_code=409)
    except RecentAuthenticationRequired:
        return JSONResponse({"detail": "Session expired. Sign in again."}, status_code=401)
    except DestructiveConfirmationRequired:
        return JSONResponse({"detail": "Explicit confirmation is required."}, status_code=409)
    except PermissionError:
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    except ValueError:
        return JSONResponse({"detail": "Account update was invalid."}, status_code=400)
    except Exception:
        return JSONResponse({"detail": "Account update is temporarily unavailable."}, status_code=503)
    return JSONResponse({"updated": True, **(saved if isinstance(saved, dict) else {})})


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
            actor_session_id=actor.session_id,
            actor_authenticated_at=actor.authenticated_at,
            library_id=actor.current_library_id,
            target_account_id=account_id,
            confirmed=payload["confirmed"],
            request_ref=uuid4().hex,
        )
    except RecentAuthenticationRequired:
        return JSONResponse({"detail": "Session expired. Sign in again."}, status_code=401)
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
    request: Request, account_id: int
) -> Response:
    if await _empty_payload(request) is None:
        return JSONResponse({"detail": "Mail action was invalid."}, status_code=400)
    outcome = await _queue_mail_action(request, account_id, "welcome")
    if isinstance(outcome, Response):
        return outcome
    return JSONResponse({"accepted": True}, status_code=202)


@router.post("/admin/accounts/{account_id}/password-reset", status_code=202)
async def send_managed_account_password_reset(
    request: Request, account_id: int
) -> Response:
    if await _empty_payload(request) is None:
        return JSONResponse({"detail": "Mail action was invalid."}, status_code=400)
    outcome = await _queue_mail_action(request, account_id, "password-reset")
    if isinstance(outcome, Response):
        return outcome
    return JSONResponse({"accepted": True}, status_code=202)


@router.post("/admin/accounts/{account_id}/invitation/copy")
async def copy_managed_account_invitation(
    request: Request, account_id: int
) -> Response:
    try:
        copied = await run_in_threadpool(
            _invitation_service(request).issue_copy,
            actor_account_id=request.state.current_actor.account_id,
            actor_session_id=request.state.current_actor.session_id,
            actor_authenticated_at=request.state.current_actor.authenticated_at,
            library_id=request.state.current_actor.current_library_id,
            target_account_id=account_id,
            request_ref=uuid4().hex,
        )
    except RecentAuthenticationRequired:
        return JSONResponse(
            {"detail": "Session expired. Sign in again."}, status_code=401
        )
    except PermissionError:
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    except Exception:
        return JSONResponse(
            {"detail": "Invitation link is temporarily unavailable."},
            status_code=503,
        )
    return JSONResponse(
        {
            "invitation_url": copied.invitation_url,
            "expires_at": copied.expires_at.isoformat(),
        },
        headers={
            "Cache-Control": "no-store, max-age=0",
            "Referrer-Policy": "no-referrer",
        },
    )


@router.post("/admin/accounts/{account_id}/invitation/send", status_code=202)
async def send_managed_account_invitation(
    request: Request,
    account_id: int,
) -> Response:
    try:
        invitation_enabled = _mail_config(request.app).get("invitation_enabled")
    except Exception:
        return JSONResponse(
            {"detail": "Invitation email is temporarily unavailable."},
            status_code=503,
        )
    if invitation_enabled is not True:
        return JSONResponse(
            {"detail": "Invitation email is not configured."}, status_code=409
        )
    try:
        await run_in_threadpool(
            _invitation_service(request).queue_email,
            actor_account_id=request.state.current_actor.account_id,
            actor_session_id=request.state.current_actor.session_id,
            actor_authenticated_at=request.state.current_actor.authenticated_at,
            library_id=request.state.current_actor.current_library_id,
            target_account_id=account_id,
            request_ref=uuid4().hex,
            **_auth_mail_job_context(request),
        )
    except RecentAuthenticationRequired:
        return JSONResponse(
            {"detail": "Session expired. Sign in again."}, status_code=401
        )
    except PermissionError:
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    except Exception:
        return JSONResponse(
            {"detail": "Invitation email is temporarily unavailable."},
            status_code=503,
        )
    return JSONResponse({"accepted": True}, status_code=202)


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
async def create_managed_account(request: Request):
    payload = await _json_payload(request)
    if payload is None:
        return _invalid()
    if payload["send_invitation"]:
        try:
            invitation_enabled = _mail_config(request.app).get("invitation_enabled")
        except Exception:
            return JSONResponse(
                {"detail": "Invitation email is temporarily unavailable."}, status_code=503
            )
        if invitation_enabled is not True:
            return JSONResponse(
                {"detail": "Invitation email is not configured."}, status_code=409
            )
    try:
        service = _service(request)
        result = await run_in_threadpool(
            service.create_account,
            actor=request.state.current_actor,
            username=payload["username"],
            contact_email=payload["contact_email"],
            capability_keys=payload["capability_keys"],
            send_invitation=payload["send_invitation"],
            request_ref=uuid4().hex,
            **_auth_mail_job_context(request),
            **({"role_keys": payload["role_keys"]} if "role_keys" in payload else {}),
        )
    except RecentAuthenticationRequired:
        return JSONResponse({"detail": "Session expired. Sign in again."}, status_code=401)
    except PermissionError:
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    except ManagedAccountIdentityConflict:
        return JSONResponse(
            {"detail": "Username or contact email is already in use."},
            status_code=409,
        )
    except ValueError:
        return _invalid()
    except Exception:
        return JSONResponse(
            {"detail": "Account creation is temporarily unavailable."},
            status_code=503,
        )
    return JSONResponse(
        {
            "account_id": result.account_id,
            "pending": True,
            "invitation_queued": result.invitation_queued,
        },
        status_code=201,
    )


async def _json_payload(request: Request) -> dict[str, object] | None:
    payload = await _bounded_json_object(request)
    if not isinstance(payload, dict) or set(payload) not in (_FIELDS, _FIELDS | {"role_keys"}):
        return None
    if not all(isinstance(payload[key], str) for key in ("username", "contact_email")):
        return None
    if "role_keys" in payload and not _role_selection(payload["role_keys"]):
        return None
    if not isinstance(payload["send_invitation"], bool):
        return None
    capabilities = payload["capability_keys"]
    if not isinstance(capabilities, list) or any(
        not isinstance(item, str) for item in capabilities
    ):
        return None
    return payload


def _role_selection(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(key, str) for key in value)


async def _management_payload(request: Request) -> dict[str, object] | None:
    payload = await _bounded_json_object(request)
    expected = {
        "is_active",
        "current_library_access",
        "capability_keys",
        "confirm_disable",
        "confirm_remove_access",
    }
    if payload is None or set(payload) not in (expected, expected | {"role_keys", "access_revision"}):
        return None
    if "role_keys" in payload and (
        not _role_selection(payload["role_keys"])
        or not isinstance(payload["access_revision"], str)
        or len(payload["access_revision"]) != 64
    ):
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


async def _transition_preview_storage(request: Request, method_name: str) -> Response:
    if await _empty_payload(request) is None:
        return JSONResponse({"detail": "Preview storage request was invalid."}, status_code=400)
    try:
        repository = _preview_storage_repository(request)
        worker = _preview_storage_worker(request)
        current = await run_in_threadpool(repository.load)
        operation_id = str(current.get("operation_id") or "").strip()
        if not operation_id:
            raise PreviewStorageConflict("No preview relocation is available.")
        state = await run_in_threadpool(getattr(repository, method_name), operation_id)
    except PreviewStorageConflict as exc:
        return JSONResponse({"detail": str(exc)}, status_code=409)
    except Exception:
        return JSONResponse(
            {"detail": "Album preview relocation could not be updated."},
            status_code=503,
        )
    _publish_preview_storage_state(request, state)
    worker.wake()
    return _preview_storage_response(state, status_code=202)


def _same_preview_storage_location(
    state: Mapping[str, object], *, mode: str, root: str | None
) -> bool:
    if str(state.get("mode") or "album_folders") != mode:
        return False
    if mode == "album_folders":
        return True
    active_root = str(state.get("active_root") or "").strip()
    return Path(active_root).resolve(strict=False) == Path(str(root)).resolve(strict=False)


def _preview_storage_response(
    state: Mapping[str, object], *, status_code: int = 200, unchanged: bool = False
) -> JSONResponse:
    payload = {
        **dict(state),
        "failure_summary": list(state.get("failure_summary") or [])[:20],
        "suggested_path": str(
            Path.home() / "Documents" / "Album Haven" / "Generated Previews"
        ),
        **({"unchanged": True} if unchanged else {}),
    }
    return JSONResponse(
        jsonable_encoder(payload),
        status_code=status_code,
        headers={"Cache-Control": "no-store, max-age=0"},
    )


def _publish_preview_storage_state(request: Request, state: Mapping[str, object]) -> None:
    policy = preview_storage_policy_from_mapping(state)
    request.app.state.generated_preview_storage_policy = policy
    _app_config(request)["_GENERATED_PREVIEW_STORAGE_POLICY"] = policy


def _preview_storage_repository(request: Request):
    repository = getattr(
        request.app.state, "generated_preview_storage_repository", None
    )
    if repository is None:
        raise RuntimeError("Generated preview storage is unavailable.")
    return repository


def _preview_storage_worker(request: Request):
    worker = getattr(request.app.state, "generated_preview_relocation", None)
    if worker is None:
        raise RuntimeError("Generated preview relocation is unavailable.")
    return worker


def _app_config(request: Request) -> dict[str, object]:
    config = getattr(request.app.state, "config", None)
    if not isinstance(config, dict):
        raise RuntimeError("Application configuration is unavailable.")
    return config


async def _queue_mail_action(request: Request, account_id: int, action: str):
    actor = request.state.current_actor
    if actor.account_id is None or actor.current_library_id is None:
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    try:
        service = _mail_action_service(request)
    except Exception:
        return JSONResponse(
            {"detail": "Mail action is temporarily unavailable."}, status_code=503
        )
    try:
        method = service.queue_welcome if action == "welcome" else service.queue_password_reset
        return await run_in_threadpool(
            method,
            actor_account_id=actor.account_id,
            actor_session_id=actor.session_id,
            actor_authenticated_at=actor.authenticated_at,
            library_id=actor.current_library_id,
            target_account_id=account_id,
            request_ref=uuid4().hex,
            **_auth_mail_job_context(request),
        )
    except RecentAuthenticationRequired:
        return JSONResponse(
            {"detail": "Session expired. Sign in again."}, status_code=401
        )
    except PermissionError:
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    except ValueError:
        return JSONResponse({"detail": "Mail action was invalid."}, status_code=400)
    except Exception:
        return JSONResponse(
            {"detail": "Mail action is temporarily unavailable."}, status_code=503
        )


def _auth_mail_job_context(request: Request) -> dict[str, str]:
    evaluation = getattr(request.state, "policy_evaluation", None)
    audit = getattr(evaluation, "audit", None)
    actor_id = getattr(request.state.current_actor, "account_id", None)
    origin = request_origin_ref_for_request(request)
    return {
        "request_origin_ref": f"{origin}.account-{actor_id}",
        "deployment_mode": str(
            getattr(audit, "deployment_mode", "self_hosted")
        ),
        "client_surface": str(
            getattr(audit, "client_surface_class", "private_web")
        ),
    }


async def _bounded_json_object(request: Request) -> dict[str, object] | None:
    if request.headers.get("content-type", "").split(";", 1)[0].strip().casefold() != "application/json":
        return None
    try:
        length = int(request.headers.get("content-length", "0"))
    except ValueError:
        return None
    if length < 2 or length > _MAX_BODY_BYTES:
        return None
    try:
        payload = await read_bounded_json_object(request, max_bytes=_MAX_BODY_BYTES)
    except (ValueError, RecursionError):
        return None
    return payload if isinstance(payload, dict) else None


async def _load_roster(request: Request, *, target_account_id: int | None = None):
    actor = request.state.current_actor
    if actor.account_id is None or actor.current_library_id is None:
        return HTMLResponse("Action not permitted.", status_code=403)
    try:
        return await run_in_threadpool(
            _members_service(request).load_roster,
            actor_account_id=actor.account_id,
            library_id=actor.current_library_id,
            **({"target_account_id": target_account_id} if target_account_id is not None else {}),
        )
    except PermissionError:
        return HTMLResponse("Action not permitted.", status_code=403)
    except Exception:
        return HTMLResponse("Members & Access is temporarily unavailable.", status_code=503)


async def _render_admin(request: Request, template: str, **context) -> Response:
    try:
        csrf_token = issue_session_csrf(
            request.cookies.get(_SESSION_COOKIE), request.app.state.auth_policy_config
        )
    except (TypeError, ValueError):
        return HTMLResponse("Members & Access is temporarily unavailable.", status_code=503)
    if template == "admin-account-detail.html":
        context["access_editor"] = assignment_editor(context.get("member"), context["listener_defaults"])
    templates = getattr(request.app.state, "templates", _FALLBACK_TEMPLATES)
    response = templates.TemplateResponse(
        request,
        template,
        {"request": request, "csrf_token": csrf_token,
         "runtime_asset_version": getattr(request.app.state, "runtime_asset_version", ""),
         **await load_appearance_context(request), **context},
    )
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


def _allowed_actions(request: Request, *, target_account_id: int | None = None,
                     protected_target: bool = False):
    actions = (("accounts.read",) if protected_target and not request.state.current_actor.is_bootstrap_owner
               else _ADMIN_ACTIONS)
    return allowed_actions_for_request(
        request, actions, target_account_id=target_account_id
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


def _invitation_service(request: Request):
    existing = getattr(
        request.app.state, "admin_account_invitation_service", None
    )
    if existing is not None:
        return existing
    auth_config = request.app.state.auth_policy_config
    if not isinstance(auth_config, Mapping):
        raise RuntimeError("Invitation configuration is unavailable.")
    mail_config = _mail_config(request.app)
    lock = getattr(request.app.state, "auth_service_lock", None)
    if lock is None:
        lock = threading.Lock()
        request.app.state.auth_service_lock = lock
    with lock:
        existing = getattr(
            request.app.state, "admin_account_invitation_service", None
        )
        if existing is None:
            service_config = dict(auth_config)
            repository_config = getattr(
                request.app.state, "repository_config", None
            )
            if isinstance(repository_config, Mapping):
                database_url = repository_config.get(
                    "ALBUM_HAVEN_APP_DATABASE_URL"
                )
                if database_url:
                    service_config["ALBUM_HAVEN_APP_DATABASE_URL"] = database_url
            service_config["public_base_url"] = (
                mail_config.get("public_base_url")
                or auth_config.get("public_base_url")
            )
            existing = PostgresAdminAccountInvitationService(
                service_config,
                audit_repository=PostgresSecurityAuditRepository(),
            )
            request.app.state.admin_account_invitation_service = existing
    return existing


def _mail_config(app):
    existing = getattr(app.state, "mail_config", None)
    if existing is not None:
        if not isinstance(existing, Mapping):
            raise RuntimeError("Mail configuration is unavailable.")
        return existing
    from config import build_mail_config

    existing = build_mail_config()
    if not isinstance(existing, Mapping):
        raise RuntimeError("Mail configuration is unavailable.")
    app.state.mail_config = existing
    return existing


def _invitation_email_enabled(app) -> bool:
    try:
        return _mail_config(app).get("invitation_enabled") is True
    except Exception:
        return False


def _service(request: Request):
    injected = getattr(request.app.state, "admin_account_creation", None)
    if injected is not None:
        return injected
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
        repository_config = getattr(
            request.app.state, "repository_config", config
        )
        service = AdminAccountCreationService(
            repository=PostgresAdminAccountRepository(repository_config),
            invitation_token_seconds=config["invitation_token_seconds"],
        )
        request.app.state.admin_account_creation_service = service
        return service


def _invalid():
    return JSONResponse({"detail": "Account request was invalid."}, status_code=400)
