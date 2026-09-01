import asyncio
import json
from datetime import datetime, timezone

from fastapi import FastAPI

from music_app.services.admin_account_creation import CreatedAccount
from music_app.services.auth_invitation_models import InvitationDelivery
from music_app.services.current_actor import ActorState, CurrentActor


DELIVERY = InvitationDelivery(
    outbox_id=51, invitation_token_id=61, account_id=41,
    recipient="member+one@example.test", username="member.one",
    raw_token="A" * 43,
    expires_at=datetime(2026, 9, 4, 12, 30, tzinfo=timezone.utc),
)


class Service:
    def __init__(self, invitation_delivery=None):
        self.calls = []
        self.invitation_delivery = invitation_delivery

    def create_account(self, **kwargs):
        self.calls.append(kwargs)
        return CreatedAccount(account_id=41, invitation_delivery=self.invitation_delivery)


def _app(invitation_delivery=None):
    from music_app.routes.admin_asgi import router

    app = FastAPI()
    service = Service(invitation_delivery)
    app.state.admin_account_creation = service
    app.state.admin_account_creation_service = service
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
            is_bootstrap_owner=True,
        )
        return await call_next(request)

    app.include_router(router)
    return app, service, deliveries


async def _request_async(app, payload):
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
            "path": "/admin/accounts",
            "raw_path": b"/admin/accounts",
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
    return start["status"], response


def _request(app, payload):
    return asyncio.run(_request_async(app, payload))


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
