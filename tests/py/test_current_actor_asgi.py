from __future__ import annotations

import asyncio
from threading import Event, Lock

from fastapi import FastAPI, Request

from music_app.services.current_actor import ActorState, CurrentActor


SESSION_COOKIE = "__Host-album_haven_session"
RAW_SESSION = "s" * 43


class Resolver:
    def __init__(self, actor):
        self.actor = actor
        self.received = []

    def resolve(self, raw):
        self.received.append(raw)
        return self.actor


class BlockingResolver(Resolver):
    def __init__(self, actor):
        super().__init__(actor)
        self._lock = Lock()
        self.started = Event()
        self.duplicate_started = Event()
        self.release = Event()

    def resolve(self, raw):
        with self._lock:
            self.received.append(raw)
            if len(self.received) > 1:
                self.duplicate_started.set()
            self.started.set()
        self.release.wait(timeout=1)
        return self.actor


def _request(app, cookie=None):
    headers = []
    if cookie is not None:
        headers.append((b"cookie", f"{SESSION_COOKIE}={cookie}".encode("ascii")))
    return Request(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "https",
            "path": "/",
            "raw_path": b"/",
            "query_string": b"",
            "headers": headers,
            "client": ("127.0.0.1", 50000),
            "server": ("music.test", 443),
            "app": app,
        }
    )


def test_request_actor_resolves_cookie_once_and_caches_exact_actor():
    from music_app.services.current_actor_asgi import current_actor_from_request

    actor = CurrentActor(
        state=ActorState.ACTIVE,
        account_id=41,
        session_id=8,
        username_display="Rendref",
        display_name="Rendref",
        is_bootstrap_owner=True,
    )
    app = FastAPI()
    resolver = Resolver(actor)
    app.state.current_actor_resolver = resolver
    request = _request(app, RAW_SESSION)

    first = asyncio.run(current_actor_from_request(request))
    second = asyncio.run(current_actor_from_request(request))

    assert first is actor and second is actor
    assert request.state.current_actor is actor
    assert resolver.received == [RAW_SESSION]


def test_concurrent_requests_for_same_session_share_inflight_resolution():
    from music_app.services.current_actor_asgi import current_actor_from_request

    actor = CurrentActor(
        state=ActorState.ACTIVE,
        account_id=41,
        session_id=8,
        username_display="Rendref",
        display_name="Rendref",
        is_bootstrap_owner=True,
    )
    app = FastAPI()
    resolver = BlockingResolver(actor)
    app.state.current_actor_resolver = resolver

    async def resolve_burst():
        tasks = [
            asyncio.create_task(current_actor_from_request(_request(app, RAW_SESSION)))
            for _ in range(6)
        ]
        assert await asyncio.to_thread(resolver.started.wait, 1)
        duplicate_started = await asyncio.to_thread(
            resolver.duplicate_started.wait,
            0.1,
        )
        resolver.release.set()
        return duplicate_started, await asyncio.gather(*tasks)

    duplicate_started, actors = asyncio.run(resolve_burst())

    assert duplicate_started is False
    assert actors == [actor] * 6
    assert resolver.received == [RAW_SESSION]


def test_request_actor_passes_missing_cookie_once_and_caches_anonymous():
    from music_app.services.current_actor_asgi import current_actor_from_request

    actor = CurrentActor.anonymous()
    app = FastAPI()
    resolver = Resolver(actor)
    app.state.current_actor_resolver = resolver
    request = _request(app)

    assert asyncio.run(current_actor_from_request(request)) is actor
    assert asyncio.run(current_actor_from_request(request)) is actor
    assert resolver.received == [None]


def test_request_actor_rejects_invalid_resolver_result_without_caching():
    from music_app.services.current_actor_asgi import current_actor_from_request

    app = FastAPI()
    resolver = Resolver({"account_id": 41})
    app.state.current_actor_resolver = resolver
    request = _request(app, RAW_SESSION)

    try:
        asyncio.run(current_actor_from_request(request))
    except RuntimeError as exc:
        assert "actor resolver" in str(exc).casefold()
    else:
        raise AssertionError("invalid actor result must fail closed")
    assert not hasattr(request.state, "current_actor")
