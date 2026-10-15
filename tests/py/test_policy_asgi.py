import asyncio

import pytest

from fastapi import FastAPI, Request, Response

from music_app.services.auth_config import build_auth_config
from music_app.services.current_actor import (
    ActorState,
    CapabilityGrant,
    CurrentActor,
    LibraryRelationship,
)
from music_app.services.policy_asgi import require_action
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import (
    install_private_route_boundary,
    private_action_for_route,
)


class Resolver:
    def __init__(self, actor):
        self.actor = actor
        self.calls = []

    def resolve(self, token):
        self.calls.append(token)
        return self.actor


def _actor(*, bootstrap=False, state=ActorState.ACTIVE, library_id=None, grants=()):
    return CurrentActor(
        state=state,
        account_id=7 if state is not ActorState.ANONYMOUS else None,
        session_id=11 if state is not ActorState.ANONYMOUS else None,
        username_display="Rendref" if state is not ActorState.ANONYMOUS else None,
        is_bootstrap_owner=bootstrap,
        current_library_id=library_id,
        library_relationships=(LibraryRelationship(library_id, "member", bootstrap),)
        if library_id is not None and state is ActorState.ACTIVE
        else (),
        capability_grants=tuple(grants),
    )


def _app(actor, *, constraints=None, action="library.read"):
    app = FastAPI()
    resolver = Resolver(actor)
    app.state.current_actor_resolver = resolver
    app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"}
    app.state.auth_policy_config = {
        "hmac": {"secret": "0123456789abcdef0123456789abcdef", "key_version": 7}
    }
    if constraints is not None:
        app.state.policy_constraint_resolver = lambda context: constraints

    @app.get("/private")
    async def private(_result=__import__("fastapi").Depends(require_action(action))):
        return {"ok": True, "reason": _result.decision.reason_code}

    return app, resolver


async def _request_async(
    app, *, cookie=None, client="203.0.113.8", path="/private", method="GET"
):
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
            "client": (client, 50000),
            "server": ("music.test", 443),
        },
        receive,
        send,
    )
    start = next(item for item in messages if item["type"] == "http.response.start")
    body = b"".join(item.get("body", b"") for item in messages if item["type"] == "http.response.body")
    return start["status"], body


def _request(app, **kwargs):
    return asyncio.run(_request_async(app, **kwargs))


def test_missing_or_invalid_authentication_returns_stable_401():
    for actor in (CurrentActor.anonymous(), _actor(state=ActorState.INACTIVE)):
        app, _ = _app(actor)
        status, body = _request(app)
        assert status == 401
        assert body == b'{"detail":"Authentication required."}'


def test_authenticated_policy_denial_returns_stable_403():
    app, resolver = _app(_actor())

    status, body = _request(
        app, cookie="__Host-album_haven_session=opaque-session"
    )

    assert status == 403
    assert body == b'{"detail":"Action not permitted."}'
    assert resolver.calls == ["opaque-session"]


def test_bootstrap_owner_is_allowed_and_actor_is_resolved_once():
    app, resolver = _app(_actor(bootstrap=True, library_id=23))

    status, body = _request(
        app, cookie="__Host-album_haven_session=opaque-session"
    )

    assert status == 200
    assert body == b'{"ok":true,"reason":"bootstrap_owner"}'
    assert resolver.calls == ["opaque-session"]


@pytest.mark.parametrize("secret", ["0123456789abcdef0123456789abcdef", "é" * 16])
def test_authenticated_constraint_denial_is_403_and_origin_key_is_minimized(secret):
    captured = []
    app, _ = _app(
        _actor(bootstrap=True),
        constraints=PolicyEvaluationConstraints(client_surface_allowed=False),
    )
    app.state.auth_policy_config = build_auth_config({
        "ALBUM_HAVEN_AUTH_HMAC_SECRET": secret,
        "ALBUM_HAVEN_AUTH_HMAC_KEY_VERSION": "7",
        "ALBUM_HAVEN_BOOTSTRAP_USERNAME": "Rendref",
        "ALBUM_HAVEN_BOOTSTRAP_EMAIL": "rendref@example.test",
        "ALBUM_HAVEN_PUBLIC_BASE_URL": "https://music.test",
    })
    app.state.policy_constraint_resolver = lambda context: (
        captured.append(context) or PolicyEvaluationConstraints(client_surface_allowed=False)
    )

    status, _ = _request(app, client="198.51.100.44")

    assert status == 403
    assert captured[0].client_surface_class == "private_web"
    assert captured[0].request_origin.origin_type == "network"
    assert captured[0].request_origin.origin_key.startswith("hmac:v7:")
    assert captured[0].request_origin.origin_key != "198.51.100.44"
    assert "198.51.100.44" not in repr(captured[0].request_origin)


def test_single_current_library_is_applied_to_a_library_scoped_grant():
    actor = CurrentActor(
        state=ActorState.ACTIVE,
        account_id=9,
        session_id=12,
        username_display="member",
        current_library_id=23,
        library_relationships=(LibraryRelationship(23, "member", False),),
        capability_grants=(CapabilityGrant("library.read", "library", 23),),
    )
    app, _ = _app(actor)

    status, body = _request(app)

    assert status == 200
    assert body == b'{"ok":true,"reason":"explicit_grant"}'


def test_account_management_grants_are_scoped_to_the_current_library():
    actor = CurrentActor(
        state=ActorState.ACTIVE,
        account_id=9,
        session_id=12,
        username_display="library administrator",
        current_library_id=23,
        library_relationships=(LibraryRelationship(23, "administrator", False),),
        capability_grants=(CapabilityGrant("accounts.read", "library", 23),),
    )
    app, _ = _app(actor, action="accounts.read")

    status, body = _request(app)

    assert status == 200
    assert body == b'{"ok":true,"reason":"explicit_grant"}'


@pytest.mark.parametrize("action", ["app.shell.read", "app.bootstrap.read", "app.status.read"])
def test_shell_read_aliases_resolve_the_current_library_scope(action):
    actor = CurrentActor(
        state=ActorState.ACTIVE,
        account_id=9,
        session_id=12,
        current_library_id=23,
        library_relationships=(LibraryRelationship(23, "member", False),),
        capability_grants=(CapabilityGrant("library.browse.read", "library", 23),),
    )
    app, _ = _app(actor, action=action)

    status, _body = _request(app)

    assert status == 200


def _boundary_probe_app(actor):
    """Exercise the real middleware; probe handlers are not production routes."""
    app, resolver = _app(actor)
    entered = []
    contexts = []
    app.state.policy_constraint_resolver = lambda context: (
        contexts.append(context) or PolicyEvaluationConstraints()
    )

    async def probe(request: Request):
        entered.append((request.method, request.url.path))
        return Response(status_code=204)

    for method, path in (
        ("GET", "/track"), ("GET", "/bootstrap-data"),
        ("GET", "/"), ("GET", "/status"),
        ("GET", "/account"), ("POST", "/logout"),
    ):
        app.add_api_route(path, probe, methods=[method])
    install_private_route_boundary(app)
    return app, resolver, entered, contexts


@pytest.mark.parametrize(("path", "action"), [
    ("/track", "library.media.read"),
    ("/bootstrap-data", "app.bootstrap.read"),
    ("/", "app.shell.read"),
    ("/status", "app.status.read"),
])
@pytest.mark.parametrize("authority", [
    "ordinary", "bootstrap", "global_action", "global_capabilities",
])
def test_real_private_boundary_rejects_no_library_before_handler(path, action, authority):
    grants = (
        (CapabilityGrant(action, "global", None),)
        if authority == "global_action"
        else (CapabilityGrant("capability.view", "global", None),
              CapabilityGrant("capability.play", "global", None))
        if authority == "global_capabilities"
        else ()
    )
    actor = _actor(bootstrap=authority == "bootstrap", grants=grants)
    app, resolver, entered, contexts = _boundary_probe_app(actor)
    assert private_action_for_route("GET", path) == action

    status, body = _request(
        app, path=path, cookie="__Host-album_haven_session=opaque-session",
    )

    assert status == 403
    assert body == b'{"detail":"Action not permitted."}'
    assert entered == []
    assert resolver.calls == ["opaque-session"]
    assert len(contexts) == 1
    assert contexts[0].action == action
    assert contexts[0].library_id is None
    assert contexts[0].actor.current_library_id is None
    assert contexts[0].actor.library_relationships == ()
    assert app.state.policy_evaluator.evaluate(contexts[0]).decision.reason_code == "library_required"


@pytest.mark.parametrize(("method", "path", "action"), [
    ("GET", "/account", "account.self.read"),
    ("POST", "/logout", "auth.session.logout"),
])
@pytest.mark.parametrize("bootstrap", [False, True])
def test_real_private_boundary_admits_no_library_account_and_logout_probe(method, path, action, bootstrap):
    # This checks policy/middleware admission only. The actual account page,
    # logout form CSRF/session revocation, and Goals routes need separate tests.
    app, resolver, entered, contexts = _boundary_probe_app(_actor(bootstrap=bootstrap))
    assert private_action_for_route(method, path) == action

    status, _body = _request(
        app, path=path, method=method,
        cookie="__Host-album_haven_session=opaque-session",
    )

    assert status == 204
    assert entered == [(method, path)]
    assert resolver.calls == ["opaque-session"]
    assert len(contexts) == 1
    assert contexts[0].action == action
    assert contexts[0].library_id is None
    if action.startswith("account.self."):
        assert contexts[0].target_account_id == 7


@pytest.mark.parametrize("action", ["account.self.goals.read", "account.self.goals.write"])
@pytest.mark.parametrize("bootstrap", [False, True])
def test_account_goals_dependency_remains_available_without_library(action, bootstrap):
    # The real require_action dependency is exercised, not a Goals endpoint.
    app, resolver = _app(_actor(bootstrap=bootstrap), action=action)

    status, body = _request(
        app, cookie="__Host-album_haven_session=opaque-session",
    )

    assert status == 200
    assert body == (
        b'{"ok":true,"reason":"bootstrap_owner"}' if bootstrap
        else b'{"ok":true,"reason":"account_self_service"}'
    )
    assert resolver.calls == ["opaque-session"]
