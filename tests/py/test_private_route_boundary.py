import asyncio
from pathlib import Path

import pytest
from fastapi import FastAPI

from music_app.services.current_actor import CurrentActor
from music_app.services.private_route_boundary import install_private_route_boundary


def test_production_factory_installs_private_route_boundary():
    source = (Path(__file__).resolve().parents[2] / "music_app" / "__init__.py").read_text(
        encoding="utf-8"
    )

    assert "install_private_route_boundary(app)" in source


class Resolver:
    def __init__(self, actor):
        self.actor = actor
        self.calls = []

    def resolve(self, token):
        self.calls.append(token)
        return self.actor


def _app(actor):
    app = FastAPI()
    resolver = Resolver(actor)
    app.state.current_actor_resolver = resolver
    app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"}
    app.state.auth_policy_config = {
        "hmac": {"secret": "0123456789abcdef0123456789abcdef", "key_version": 7}
    }

    @app.get("/login")
    async def login():
        return {"page": "login"}

    @app.post("/reset-password")
    async def reset_password():
        return {"reset": True}

    @app.get("/favicon.ico")
    async def favicon():
        return {"icon": True}

    @app.get("/status")
    async def status():
        return {"private": True}

    install_private_route_boundary(app)
    return app, resolver


async def _request_async(app, path, *, method="GET", cookie=None):
    headers = [(b"host", b"music.test")]
    if cookie:
        headers.append((b"cookie", cookie.encode("ascii")))
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
            "method": method,
            "scheme": "https",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "headers": headers,
            "client": ("127.0.0.1", 50000),
            "server": ("music.test", 443),
        },
        receive,
        send,
    )
    start = next(item for item in messages if item["type"] == "http.response.start")
    body = b"".join(item.get("body", b"") for item in messages if item["type"] == "http.response.body")
    return start["status"], body


def _request(*args, **kwargs):
    return asyncio.run(_request_async(*args, **kwargs))


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/login"),
        ("POST", "/login"),
        ("GET", "/forgot-password"),
        ("POST", "/forgot-password"),
        ("GET", "/reset-password"),
        ("POST", "/reset-password"),
        ("GET", "/favicon.ico"),
        ("GET", "/static/app.js"),
        ("GET", "/health"),
    ],
)
def test_exact_public_boundary_does_not_resolve_authentication(method, path):
    app, resolver = _app(CurrentActor.anonymous())

    status, _ = _request(app, path, method=method)

    assert status != 401
    assert resolver.calls == []


def test_health_is_public_and_sanitized():
    app, _ = _app(CurrentActor.anonymous())

    status, body = _request(app, "/health")

    assert status == 200
    assert body == b'{"status":"ok"}'


def test_status_and_every_nonpublic_path_require_authentication():
    app, resolver = _app(CurrentActor.anonymous())

    status, body = _request(app, "/status")
    unknown_status, _ = _request(app, "/not-a-public-route")

    assert status == 401
    assert body == b'{"detail":"Authentication required."}'
    assert unknown_status == 401
    assert resolver.calls == [None, None]


def test_authenticated_bootstrap_owner_reaches_private_route():
    actor = CurrentActor(
        state=__import__("music_app.services.current_actor", fromlist=["ActorState"]).ActorState.ACTIVE,
        account_id=7,
        session_id=11,
        username_display="Rendref",
        is_bootstrap_owner=True,
    )
    app, resolver = _app(actor)

    status, body = _request(
        app,
        "/status",
        cookie="__Host-album_haven_session=opaque-session",
    )

    assert status == 200
    assert body == b'{"private":true}'
    assert resolver.calls == ["opaque-session"]
