import asyncio
from pathlib import Path

import pytest
from fastapi import FastAPI

from music_app.services.current_actor import CurrentActor
from music_app.services.private_route_boundary import (
    csrf_mode_for_route,
    install_private_route_boundary,
    private_action_for_route,
)


def test_production_factory_installs_private_route_boundary():
    source = (Path(__file__).resolve().parents[2] / "music_app" / "__init__.py").read_text(
        encoding="utf-8"
    )

    assert "install_private_route_boundary(app)" in source


def test_private_routes_have_explicit_action_classification():
    from music_app import create_asgi_app

    app = create_asgi_app()
    missing = []
    for route in app.routes:
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", None)
        if methods is None and type(route).__name__ == "APIWebSocketRoute":
            methods = {"WEBSOCKET"}
        for method in methods or ():
            if method == "HEAD":
                continue
            if path in {"/health", "/login", "/favicon.ico", "/static"}:
                continue
            action = private_action_for_route(method, path)
            csrf_mode = csrf_mode_for_route(method, path)
            expected_csrf = (
                "none"
                if method in {"GET", "HEAD", "OPTIONS", "WEBSOCKET"}
                else "route_form"
                if (method, path) == ("POST", "/logout")
                else "session_header"
            )
            if action is None or csrf_mode != expected_csrf:
                missing.append((method, path))

    assert missing == []


@pytest.mark.parametrize(
    ("method", "path", "action"),
    [
        ("GET", "/status", "app.status.read"),
        ("GET", "/", "app.shell.read"),
        ("GET", "/track", "library.media.read"),
        ("POST", "/refresh-api", "library.refresh"),
        ("POST", "/utilities/edit-tags", "library.files.edit_tags"),
        ("POST", "/playback/session/scrobble", "integration.lastfm.scrobble"),
        ("POST", "/loops/delete", "library.loops.delete"),
        ("POST", "/playlists/{playlist_ref}/items", "library.playlists.items.manage"),
        ("POST", "/logout", "auth.session.logout"),
    ],
)
def test_representative_routes_use_specific_action_keys(method, path, action):
    assert private_action_for_route(method, path) == action


def test_write_inventory_classifies_header_and_route_owned_csrf():
    assert csrf_mode_for_route("POST", "/logout") == "route_form"
    assert csrf_mode_for_route("POST", "/refresh-api") == "session_header"
    assert csrf_mode_for_route("GET", "/status") == "none"
    assert csrf_mode_for_route("WEBSOCKET", "/playback/pcm") == "none"
    assert private_action_for_route("WEBSOCKET", "/playback/pcm") == "library.media.stream"


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

    @app.get("/track")
    async def track():
        return {"media": True}

    @app.post("/mutation")
    async def mutation():
        return {"changed": True}

    install_private_route_boundary(app)
    return app, resolver


async def _request_async(app, path, *, method="GET", cookie=None, query="", headers=None):
    request_headers = [(b"host", b"music.test")]
    if cookie:
        request_headers.append((b"cookie", cookie.encode("ascii")))
    for key, value in (headers or {}).items():
        request_headers.append((key.lower().encode("ascii"), value.encode("ascii")))
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
            "query_string": query.encode("ascii"),
            "headers": request_headers,
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


def test_media_resource_is_privacy_minimized_before_policy_and_resolved_after_auth():
    actor = CurrentActor(
        state=__import__("music_app.services.current_actor", fromlist=["ActorState"]).ActorState.ACTIVE,
        account_id=7,
        session_id=11,
        username_display="Rendref",
        is_bootstrap_owner=True,
    )
    app, _ = _app(actor)
    contexts = []
    app.state.policy_constraint_resolver = lambda context: (
        contexts.append(context)
        or __import__(
            "music_app.services.policy_evaluator",
            fromlist=["PolicyEvaluationConstraints"],
        ).PolicyEvaluationConstraints()
    )

    status, _ = _request(
        app,
        "/track",
        query="path=C%3A%5CMusic%5Cprivate.mp3",
    )

    assert status == 200
    assert contexts[0].resource.resource_kind == "media"
    assert contexts[0].resource.resource_ref.startswith("hmac:v7:")
    assert "Music" not in repr(contexts[0])


def test_private_write_requires_same_origin_session_bound_double_submit_csrf():
    from music_app.services.auth_session_csrf import issue_session_csrf

    actor = CurrentActor(
        state=__import__("music_app.services.current_actor", fromlist=["ActorState"]).ActorState.ACTIVE,
        account_id=7,
        session_id=11,
        username_display="Rendref",
        is_bootstrap_owner=True,
    )
    app, _ = _app(actor)
    session = "s" * 43
    csrf = issue_session_csrf(session, app.state.auth_policy_config)

    missing_status, _ = _request(app, "/mutation", method="POST")
    valid_status, valid_body = _request(
        app,
        "/mutation",
        method="POST",
        cookie=(
            f"__Host-album_haven_session={session}; "
            f"__Host-album_haven_csrf={csrf}"
        ),
        headers={"origin": "https://music.test", "x-album-haven-csrf": csrf},
    )

    assert missing_status == 403
    assert valid_status == 200
    assert valid_body == b'{"changed":true}'
