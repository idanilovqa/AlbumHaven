import asyncio
from datetime import datetime, timezone
import json

from fastapi import FastAPI

from music_app.services.admin_members_postgres import (
    AdminMemberSummary,
    AdminMembersRoster,
)
from music_app.services.admin_reauthentication_postgres import (
    AdminReauthenticationOutcome,
)
from music_app.services.admin_mail_actions_postgres import AdminMailActionResult
from music_app.services.auth_password_reset_request_postgres import PasswordResetDelivery
from music_app.services.auth_tokens import issue_opaque_token
from music_app.services.current_actor import (
    ActorState,
    CapabilityGrant,
    CurrentActor,
    LibraryRelationship,
)


NOW = datetime(2026, 8, 31, 22, 0, tzinfo=timezone.utc)


class Service:
    def __init__(self):
        self.calls = []
        self.update_calls = []
        self.revoke_calls = []
        self.reauthentication_calls = []
        self.welcome_calls = []
        self.reset_calls = []

    def load_roster(self, **kwargs):
        self.calls.append(kwargs)
        return AdminMembersRoster(
            library_id=9,
            library_name="Rendref's Library",
            members=(
                AdminMemberSummary(
                    account_id=7,
                    username="Rendref",
                    contact_email="rendref@example.test",
                    is_active=True,
                    is_bootstrap_owner=True,
                    membership_role="owner",
                    capability_keys=(),
                    welcome_status=None,
                    active_session_count=1,
                    last_active_at=NOW,
                    has_credential=True,
                    account_status="Enabled",
                    invitation_delivery_status=None,
                ),
                AdminMemberSummary(
                    account_id=41,
                    username="test.user+1",
                    contact_email="test.user+1@example.test",
                    is_active=True,
                    is_bootstrap_owner=False,
                    membership_role="member",
                    capability_keys=(
                        "library.browse.read",
                        "library.playlists.create",
                    ),
                    welcome_status=None,
                    active_session_count=0,
                    last_active_at=None,
                    has_credential=False,
                    account_status="Pending invitation",
                    invitation_delivery_status="sent",
                ),
                AdminMemberSummary(
                    account_id=42,
                    username="disabled.user",
                    contact_email="disabled.user@example.test",
                    is_active=False,
                    is_bootstrap_owner=False,
                    membership_role="member",
                    capability_keys=("library.browse.read",),
                    welcome_status=None,
                    active_session_count=0,
                    last_active_at=None,
                    has_credential=False,
                    account_status="Disabled",
                    invitation_delivery_status="failed",
                ),
            ),
        )

    def update_account(self, **kwargs):
        self.update_calls.append(kwargs)

    def revoke_sessions(self, **kwargs):
        self.revoke_calls.append(kwargs)

    def reauthenticate(self, **kwargs):
        self.reauthentication_calls.append(kwargs)
        return AdminReauthenticationOutcome.SUCCESS

    def queue_welcome(self, **kwargs):
        self.welcome_calls.append(kwargs)
        return AdminMailActionResult(welcome_outbox_id=71)

    def queue_password_reset(self, **kwargs):
        self.reset_calls.append(kwargs)
        return AdminMailActionResult(
            password_reset_delivery=PasswordResetDelivery(
                outbox_id=72,
                account_id=41,
                recipient="listener@example.test",
                raw_token="never-render-this-token",
            )
        )


def _app(actor_override=None, *, invitation_enabled=True):
    from music_app.routes.admin_asgi import router

    app = FastAPI()
    service = Service()
    app.state.admin_members_service = service
    app.state.admin_member_mutation_service = service
    app.state.admin_reauthentication_service = service
    app.state.admin_mail_action_service = service
    app.state.welcome_delivery = lambda _outbox_id: None
    app.state.password_reset_delivery = lambda _delivery: None
    app.state.mail_config = {"invitation_enabled": invitation_enabled}
    app.state.auth_policy_config = {
        "hmac": {"secret": "s" * 48, "key_version": 1},
        "trusted_origins": ["https://music.test"],
    }

    @app.middleware("http")
    async def actor(request, call_next):
        request.state.current_actor = actor_override or CurrentActor(
            state=ActorState.ACTIVE,
            account_id=7,
            session_id=11,
            username_display="Rendref",
            authenticated_at=NOW,
            is_bootstrap_owner=True,
            current_library_id=9,
            library_relationships=(LibraryRelationship(9, "owner", True),),
        )
        return await call_next(request)

    app.include_router(router)
    return app, service


async def _get_async(app, path, session):
    messages = []
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "https",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "headers": [
                (b"host", b"music.test"),
                (b"cookie", f"__Host-album_haven_session={session}".encode("ascii")),
            ],
            "client": ("127.0.0.1", 50000),
            "server": ("music.test", 443),
        },
        receive,
        send,
    )
    start = next(item for item in messages if item["type"] == "http.response.start")
    headers = {
        key.decode("latin-1"): value.decode("latin-1")
        for key, value in start["headers"]
    }
    body = b"".join(
        item.get("body", b"") for item in messages if item["type"] == "http.response.body"
    ).decode("utf-8")
    return start["status"], headers, body


def _get(app, path):
    session = issue_opaque_token(random_bytes=lambda count: bytes(range(count))).raw
    return asyncio.run(_get_async(app, path, session))


async def _json_request_async(app, method, path, session, payload):
    body = json.dumps(payload).encode("utf-8")
    messages = []
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message):
        messages.append(message)

    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "https",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "headers": [
                (b"host", b"music.test"),
                (b"cookie", f"__Host-album_haven_session={session}".encode("ascii")),
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
            "client": ("127.0.0.1", 50000),
            "server": ("music.test", 443),
        },
        receive,
        send,
    )
    start = next(item for item in messages if item["type"] == "http.response.start")
    response = b"".join(
        item.get("body", b"") for item in messages if item["type"] == "http.response.body"
    )
    return start["status"], response


def _json_request(app, method, path, payload):
    session = issue_opaque_token(random_bytes=lambda count: bytes(range(count))).raw
    return asyncio.run(_json_request_async(app, method, path, session, payload))


def test_members_roster_renders_operational_state_without_credentials_or_paths():
    app, service = _app()

    status, headers, body = _get(app, "/admin/members")

    assert status == 200
    assert headers["cache-control"] == "no-store, max-age=0"
    assert "Users &amp; access" in body
    assert "test.user+1@example.test" in body
    assert "Pending invitation" in body
    assert "Invitation sent" in body
    assert "Disabled" in body
    assert "encoded_hash" not in body
    assert "root_path" not in body
    assert service.calls == [{"actor_account_id": 7, "library_id": 9}]


def test_members_add_and_edit_are_in_place_pages_with_back_navigation():
    app, _service = _app()

    new_status, _headers, new_body = _get(app, "/admin/accounts/new")
    edit_status, _headers, edit_body = _get(app, "/admin/accounts/41")

    assert new_status == 200
    assert "Add user" in new_body
    assert "one-time invitation link" in new_body
    assert 'name="send_invitation"' in new_body
    assert 'name="password"' not in new_body
    assert "Back to users" in new_body
    assert "Plus-addressing remains intact." in new_body
    assert edit_status == 200
    assert "Edit user" in edit_body
    assert "test.user+1" in edit_body
    assert "Listener · Customized" in edit_body
    assert "Send password reset email" not in edit_body
    assert "Resend welcome email" not in edit_body
    assert "Back to users" in edit_body
    assert "modal" not in edit_body.casefold()
    assert '"accounts.manage": true' in edit_body
    assert '"accounts.membership.manage": true' in edit_body
    assert '"accounts.capabilities.manage": true' in edit_body


def test_roster_renders_invitation_menu_only_for_server_eligible_pending_account():
    app, _service = _app()

    status, _headers, body = _get(app, "/admin/members")

    assert status == 200
    assert 'data-admin-roster' in body
    assert 'data-member-menu-trigger="41"' in body
    assert 'aria-haspopup="menu"' in body
    assert 'aria-expanded="false"' in body
    assert 'role="menu"' in body
    assert 'data-copy-invitation="41"' in body
    assert 'data-send-invitation="41"' in body
    assert 'data-copy-invitation="7"' not in body
    assert 'data-copy-invitation="42"' not in body
    assert 'data-send-invitation="7"' not in body
    assert 'data-send-invitation="42"' not in body
    assert 'data-invitation-copy-fallback' in body
    assert 'data-roster-reauth-panel' in body
    assert '/static/js/admin-members.js' in body


def test_roster_hides_send_invitation_when_email_is_disabled_but_keeps_copy():
    app, _service = _app(invitation_enabled=False)

    status, _headers, body = _get(app, "/admin/members")

    assert status == 200
    assert 'data-copy-invitation="41"' in body
    assert 'data-send-invitation="41"' not in body


def test_members_controls_follow_server_derived_allowed_actions():
    limited = CurrentActor(
        state=ActorState.ACTIVE,
        account_id=8,
        session_id=12,
        username_display="limited.admin",
        authenticated_at=NOW,
        is_bootstrap_owner=False,
        current_library_id=9,
        library_relationships=(LibraryRelationship(9, "member", False),),
        capability_grants=(CapabilityGrant("accounts.read", "library", 9),),
    )
    app, _service = _app(limited)

    status, _headers, body = _get(app, "/admin/accounts/41")
    roster_status, _headers, roster_body = _get(app, "/admin/members")

    assert status == 200
    assert roster_status == 200
    assert '"accounts.read": true' in body
    assert 'data-admin-action="reset"' not in body
    assert 'data-admin-action="welcome"' not in body
    assert 'data-admin-action="revoke"' not in body
    assert "Save changes" not in body
    assert 'data-copy-invitation="41"' not in roster_body
    assert 'data-send-invitation="41"' not in roster_body
    assert 'data-member-menu-trigger="41"' not in roster_body
    assert 'href="/admin/accounts/41"' not in roster_body

    update_status, update_body = _json_request(
        app,
        "PATCH",
        "/admin/accounts/41",
        {
            "is_active": True,
            "current_library_access": True,
            "capability_keys": ["library.browse.read"],
            "confirm_disable": False,
            "confirm_remove_access": False,
        },
    )
    assert update_status == 403
    assert update_body == b'{"detail":"Action not permitted."}'
    assert _service.update_calls == []


def test_member_update_and_session_revoke_use_bounded_confirmed_contracts():
    app, service = _app()
    update_payload = {
        "is_active": False,
        "current_library_access": True,
        "capability_keys": ["library.browse.read"],
        "confirm_disable": True,
        "confirm_remove_access": False,
    }

    update_status, update_body = _json_request(
        app, "PATCH", "/admin/accounts/41", update_payload
    )
    revoke_status, revoke_body = _json_request(
        app, "POST", "/admin/accounts/41/sessions/revoke", {"confirmed": True}
    )

    assert update_status == 200
    assert update_body == b'{"updated":true}'
    assert service.update_calls[0]["actor_account_id"] == 7
    assert service.update_calls[0]["target_account_id"] == 41
    assert service.update_calls[0]["is_active"] is False
    assert revoke_status == 200
    assert revoke_body == b'{"revoked":true}'
    assert service.revoke_calls[0]["target_account_id"] == 41
    assert service.revoke_calls[0]["confirmed"] is True


def test_admin_recent_auth_refresh_verifies_only_the_acting_account_password():
    app, service = _app()

    status, body = _json_request(
        app,
        "POST",
        "/admin/reauthenticate",
        {"password": "administrator private password"},
    )

    assert status == 200
    assert body == b'{"refreshed":true}'
    assert service.reauthentication_calls[0]["account_id"] == 7
    assert service.reauthentication_calls[0]["session_id"] == 11
    assert service.reauthentication_calls[0]["password"] == "administrator private password"
    assert b"administrator private password" not in body


def test_admin_mail_routes_return_ambiguous_secret_free_responses():
    app, service = _app()

    welcome_status, welcome_body = _json_request(
        app, "POST", "/admin/accounts/41/welcome", {}
    )
    reset_status, reset_body = _json_request(
        app, "POST", "/admin/accounts/41/password-reset", {}
    )

    assert welcome_status == 202
    assert reset_status == 202
    assert welcome_body == b'{"accepted":true}'
    assert reset_body == b'{"accepted":true}'
    assert b"71" not in welcome_body
    assert b"72" not in reset_body
    assert b"listener@example.test" not in reset_body
    assert b"never-render-this-token" not in reset_body
    assert service.welcome_calls[0]["actor_account_id"] == 7
    assert service.welcome_calls[0]["target_account_id"] == 41
    assert service.reset_calls[0]["target_account_id"] == 41
