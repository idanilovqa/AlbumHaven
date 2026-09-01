import asyncio
import json
from datetime import datetime, timezone

from fastapi import FastAPI
import pytest

from music_app.services.admin_account_creation import CreatedAccount
from music_app.services.auth_invitation_models import CopiedInvitation, InvitationDelivery
from music_app.services.admin_member_mutation_postgres import RecentAuthenticationRequired
from music_app.services.current_actor import ActorState, CurrentActor


DELIVERY = InvitationDelivery(
    outbox_id=51, invitation_token_id=61, account_id=41,
    recipient="member+one@example.test", username="member.one",
    raw_token="A" * 43,
    expires_at=datetime(2026, 9, 4, 12, 30, tzinfo=timezone.utc),
)
COPIED = CopiedInvitation(
    invitation_url=(
        "https://example.test/accept-invitation?"
        "purpose=account-invitation&token=" + "B" * 43
    ),
    expires_at=datetime(2026, 9, 4, 12, 30, tzinfo=timezone.utc),
)


class Service:
    def __init__(self, invitation_delivery=None):
        self.calls = []
        self.invitation_delivery = invitation_delivery

    def create_account(self, **kwargs):
        self.calls.append(kwargs)
        return CreatedAccount(account_id=41, invitation_delivery=self.invitation_delivery)


class InvitationService:
    def __init__(self, *, copied=COPIED, delivery=DELIVERY, error=None):
        self.copied = copied
        self.delivery = delivery
        self.error = error
        self.copy_calls = []
        self.send_calls = []

    def issue_copy(self, **kwargs):
        self.copy_calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.copied

    def queue_email(self, **kwargs):
        self.send_calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.delivery


def _app(invitation_delivery=None, *, invitation_service=None, invitation_enabled=True):
    from music_app.routes.admin_asgi import router

    app = FastAPI()
    service = Service(invitation_delivery)
    app.state.admin_account_creation = service
    app.state.admin_account_creation_service = service
    app.state.admin_account_invitation_service = invitation_service or InvitationService()
    app.state.mail_config = {"invitation_enabled": invitation_enabled}
    deliveries = []

    async def deliver(delivery):
        deliveries.append(delivery)

    app.state.invitation_delivery = deliver

    @app.middleware("http")
    async def actor(request, call_next):
        request.state.current_actor = CurrentActor(
            state=ActorState.ACTIVE,
            account_id=7,
            session_id=11,
            username_display="Rendref",
            authenticated_at=datetime(2026, 9, 1, 12, 25, tzinfo=timezone.utc),
            is_bootstrap_owner=True,
            current_library_id=9,
        )
        return await call_next(request)

    app.include_router(router)
    return app, service, deliveries


async def _request_async(app, payload, *, path="/admin/accounts", include_headers=False):
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
            "method": "POST",
            "scheme": "https",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "headers": [
                (b"host", b"music.test"),
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
    response = b"".join(item.get("body", b"") for item in messages if item["type"] == "http.response.body")
    result = (start["status"], response)
    return (*result, start["headers"]) if include_headers else result


def _request(app, payload, **kwargs):
    return asyncio.run(_request_async(app, payload, **kwargs))


def test_admin_account_route_creates_pending_account_without_password():
    app, service, deliveries = _app()
    payload = {
        "username": "member.one",
        "contact_email": "member+one@example.test",
        "capability_keys": ["library.browse.read", "library.media.read"],
        "send_invitation": False,
    }

    status, body = _request(app, payload)

    assert status == 201
    assert body == b'{"account_id":41,"pending":true,"invitation_queued":false}'
    assert service.calls[0]["actor"].account_id == 7
    assert service.calls[0]["send_invitation"] is False
    assert len(service.calls[0]["request_ref"]) == 32
    assert "password" not in service.calls[0]
    assert b"password" not in body.lower()
    assert deliveries == []


def test_admin_invitation_actions_are_exposed_to_the_roster_policy_projection():
    from music_app.routes import admin_asgi

    assert "accounts.invitation.copy" in admin_asgi._ADMIN_ACTIONS
    assert "accounts.invitation.send" in admin_asgi._ADMIN_ACTIONS


def test_admin_account_route_queues_exact_invitation_delivery():
    app, service, deliveries = _app(DELIVERY)
    status, body = _request(app, {
        "username": "member.one", "contact_email": "member+one@example.test",
        "capability_keys": ["library.browse.read"], "send_invitation": True,
    })
    assert status == 201
    assert body == b'{"account_id":41,"pending":true,"invitation_queued":true}'
    assert service.calls[0]["send_invitation"] is True
    assert deliveries == [DELIVERY]
    assert DELIVERY.raw_token.encode() not in body


def test_admin_account_route_rejects_password_as_an_extra_field_before_service():
    app, service, deliveries = _app()

    status, body = _request(
        app,
        {
            "username": "member.one",
            "contact_email": "member@example.test",
            "password": "private reusable passphrase",
            "capability_keys": [],
            "send_invitation": False,
        },
    )

    assert status == 400
    assert body == b'{"detail":"Account request was invalid."}'
    assert service.calls == []
    assert deliveries == []


def test_copy_invitation_route_returns_exact_token_response_and_security_headers():
    invitation_service = InvitationService()
    app, _service, _deliveries = _app(invitation_service=invitation_service)

    status, body, headers = _request(
        app,
        {},
        path="/admin/accounts/41/invitation/copy",
        include_headers=True,
    )

    assert status == 200
    assert json.loads(body) == {
        "invitation_url": COPIED.invitation_url,
        "expires_at": "2026-09-04T12:30:00+00:00",
    }
    received_headers = {
        key.decode("latin-1").casefold(): value.decode("latin-1")
        for key, value in headers
    }
    assert received_headers["cache-control"] == "no-store, max-age=0"
    assert received_headers["referrer-policy"] == "no-referrer"
    assert invitation_service.copy_calls == [{
        "actor_account_id": 7,
        "actor_authenticated_at": datetime(2026, 9, 1, 12, 25, tzinfo=timezone.utc),
        "library_id": 9,
        "target_account_id": 41,
        "request_ref": invitation_service.copy_calls[0]["request_ref"],
    }]
    assert len(invitation_service.copy_calls[0]["request_ref"]) == 32


def test_send_invitation_route_queues_exact_delivery_and_returns_no_token():
    invitation_service = InvitationService()
    app, _service, deliveries = _app(invitation_service=invitation_service)

    status, body = _request(
        app,
        {},
        path="/admin/accounts/41/invitation/send",
    )

    assert status == 202
    assert body == b'{"accepted":true}'
    assert invitation_service.send_calls[0]["actor_account_id"] == 7
    assert invitation_service.send_calls[0]["actor_authenticated_at"] == datetime(
        2026, 9, 1, 12, 25, tzinfo=timezone.utc
    )
    assert invitation_service.send_calls[0]["library_id"] == 9
    assert invitation_service.send_calls[0]["target_account_id"] == 41
    assert len(invitation_service.send_calls[0]["request_ref"]) == 32
    assert deliveries == [DELIVERY]
    assert DELIVERY.raw_token.encode() not in body


def test_send_invitation_route_rejects_disabled_mail_before_service():
    invitation_service = InvitationService()
    app, _service, deliveries = _app(
        invitation_service=invitation_service,
        invitation_enabled=False,
    )

    status, body = _request(
        app,
        {},
        path="/admin/accounts/41/invitation/send",
    )

    assert status == 409
    assert body == b'{"detail":"Invitation email is not configured."}'
    assert invitation_service.send_calls == []
    assert deliveries == []


@pytest.mark.parametrize(
    ("error", "expected_status", "expected_detail"),
    [
        (
            RecentAuthenticationRequired("stale"),
            409,
            "Recent authentication is required.",
        ),
        (PermissionError("private"), 403, "Action not permitted."),
        (RuntimeError("private"), 503, "Invitation link is temporarily unavailable."),
    ],
)
def test_copy_invitation_route_maps_failures_without_leaking_details(
    error, expected_status, expected_detail
):
    invitation_service = InvitationService(error=error)
    app, _service, _deliveries = _app(invitation_service=invitation_service)

    status, body = _request(
        app,
        {},
        path="/admin/accounts/41/invitation/copy",
    )

    assert status == expected_status
    assert json.loads(body) == {"detail": expected_detail}
    assert b"private" not in body


@pytest.mark.parametrize(
    ("error", "expected_status", "expected_detail"),
    [
        (
            RecentAuthenticationRequired("stale"),
            409,
            "Recent authentication is required.",
        ),
        (PermissionError("private"), 403, "Action not permitted."),
        (RuntimeError("private"), 503, "Invitation email is temporarily unavailable."),
    ],
)
def test_send_invitation_route_maps_failures_without_leaking_details(
    error, expected_status, expected_detail
):
    invitation_service = InvitationService(error=error)
    app, _service, deliveries = _app(invitation_service=invitation_service)

    status, body = _request(
        app,
        {},
        path="/admin/accounts/41/invitation/send",
    )

    assert status == expected_status
    assert json.loads(body) == {"detail": expected_detail}
    assert b"private" not in body
    assert deliveries == []
