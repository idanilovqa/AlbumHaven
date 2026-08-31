import asyncio

from fastapi import FastAPI

from music_app.services.current_actor import (
    ActorState,
    CapabilityGrant,
    CurrentActor,
    LibraryRelationship,
)
from music_app.services.policy_asgi import require_action
from music_app.services.policy_evaluator import PolicyEvaluationConstraints


class Resolver:
    def __init__(self, actor):
        self.actor = actor
        self.calls = []

    def resolve(self, token):
        self.calls.append(token)
        return self.actor


def _actor(*, bootstrap=False, state=ActorState.ACTIVE):
    return CurrentActor(
        state=state,
        account_id=7 if state is not ActorState.ANONYMOUS else None,
        session_id=11 if state is not ActorState.ANONYMOUS else None,
        username_display="Rendref" if state is not ActorState.ANONYMOUS else None,
        is_bootstrap_owner=bootstrap,
    )


def _app(actor, *, constraints=None):
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
    async def private(_result=__import__("fastapi").Depends(require_action("library.read"))):
        return {"ok": True, "reason": _result.decision.reason_code}

    return app, resolver


async def _request_async(app, *, cookie=None, client="203.0.113.8"):
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
            "method": "GET",
            "scheme": "https",
            "path": "/private",
            "raw_path": b"/private",
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
    app, resolver = _app(_actor(bootstrap=True))

    status, body = _request(
        app, cookie="__Host-album_haven_session=opaque-session"
    )

    assert status == 200
    assert body == b'{"ok":true,"reason":"bootstrap_owner"}'
    assert resolver.calls == ["opaque-session"]


def test_authenticated_constraint_denial_is_403_and_origin_key_is_minimized():
    captured = []
    app, _ = _app(
        _actor(bootstrap=True),
        constraints=PolicyEvaluationConstraints(client_surface_allowed=False),
    )
    app.state.policy_constraint_resolver = lambda context: (
        captured.append(context) or PolicyEvaluationConstraints(client_surface_allowed=False)
    )

    status, _ = _request(app, client="198.51.100.44")

    assert status == 403
    assert captured[0].client_surface_class == "private_web"
    assert captured[0].request_origin.origin_type == "network"
    assert captured[0].request_origin.origin_key != "198.51.100.44"
    assert "198.51.100.44" not in repr(captured[0].request_origin)


def test_single_current_library_is_applied_to_a_library_scoped_grant():
    actor = CurrentActor(
        state=ActorState.ACTIVE,
        account_id=9,
        session_id=12,
        username_display="member",
        library_relationships=(LibraryRelationship(23, "member", False),),
        capability_grants=(CapabilityGrant("library.read", "library", 23),),
    )
    app, _ = _app(actor)

    status, body = _request(app)

    assert status == 200
    assert body == b'{"ok":true,"reason":"explicit_grant"}'
