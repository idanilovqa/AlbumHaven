import asyncio
import json

from fastapi import FastAPI

from music_app.services.admin_account_creation import CreatedAccount
from music_app.services.current_actor import ActorState, CurrentActor


class Service:
    def __init__(self):
        self.calls = []

    def create_account(self, **kwargs):
        self.calls.append(kwargs)
        return CreatedAccount(account_id=41, welcome_outbox_id=51)


def _app():
    from music_app.routes.admin_asgi import router

    app = FastAPI()
    service = Service()
    app.state.admin_account_creation_service = service

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
    return app, service


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


def test_admin_account_route_creates_immediate_account_without_echoing_password():
    app, service = _app()
    payload = {
        "username": "member.one",
        "contact_email": "member+one@example.test",
        "password": "private reusable passphrase",
        "capability_keys": ["library.browse.read", "library.media.read"],
    }

    status, body = _request(app, payload)

    assert status == 201
    assert body == b'{"account_id":41,"welcome_outbox_id":51,"active":true}'
    assert service.calls[0]["actor"].account_id == 7
    assert service.calls[0]["password"] == payload["password"]
    assert payload["password"].encode() not in body


def test_admin_account_route_rejects_unknown_or_malformed_fields_before_service():
    app, service = _app()

    status, body = _request(
        app,
        {
            "username": "member.one",
            "contact_email": "member@example.test",
            "password": "private reusable passphrase",
            "capability_keys": [],
            "is_admin": True,
        },
    )

    assert status == 400
    assert body == b'{"detail":"Account request was invalid."}'
    assert service.calls == []
