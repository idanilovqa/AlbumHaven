"""ASGI request-scoped CurrentActor resolution and caching."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
import threading

from fastapi import Request
from starlette.concurrency import run_in_threadpool

from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
from music_app.services.current_actor import CurrentActor
from music_app.services.current_actor_postgres import PostgresCurrentActorResolver


_SESSION_COOKIE = "__Host-album_haven_session"


async def current_actor_from_request(request: Request, *, refresh: bool = False) -> CurrentActor:
    """Resolve and cache the actor, bypassing request state when refresh is required."""

    if not refresh and hasattr(request.state, "current_actor"):
        cached = request.state.current_actor
        if not isinstance(cached, CurrentActor):
            raise RuntimeError("Current actor request cache is invalid.")
        return cached
    resolver = _resolver(request)
    raw_session_token = request.cookies.get(_SESSION_COOKIE)
    if refresh:
        actor = await run_in_threadpool(resolver.resolve, raw_session_token)
    else:
        inflight = getattr(request.app.state, "current_actor_inflight", None)
        if inflight is None:
            inflight = {}
            request.app.state.current_actor_inflight = inflight
        inflight_key = (id(resolver), raw_session_token)
        resolution = inflight.get(inflight_key)
        if resolution is None or resolution.done():
            resolution = asyncio.create_task(
                run_in_threadpool(
                    resolver.resolve, raw_session_token
                )
            )
            inflight[inflight_key] = resolution

            def _clear_inflight(done) -> None:
                if inflight.get(inflight_key) is done:
                    inflight.pop(inflight_key, None)
                if not done.cancelled():
                    done.exception()

            resolution.add_done_callback(_clear_inflight)
        actor = await asyncio.shield(resolution)
    if not isinstance(actor, CurrentActor):
        raise RuntimeError("Current actor resolver returned invalid context.")
    request.state.current_actor = actor
    return actor


def _resolver(request: Request):
    existing = getattr(request.app.state, "current_actor_resolver", None)
    if existing is not None:
        return existing
    lock = getattr(request.app.state, "auth_service_lock", None)
    if lock is None:
        lock = threading.Lock()
        request.app.state.auth_service_lock = lock
    with lock:
        existing = getattr(request.app.state, "current_actor_resolver", None)
        if existing is not None:
            return existing
        config = _policy_config(request)
        sessions = getattr(request.app.state, "auth_session_service", None)
        if sessions is None:
            sessions = PostgresAuthSessionService(config)
            request.app.state.auth_session_service = sessions
        resolver = PostgresCurrentActorResolver(
            config,
            session_service=sessions,
        )
        request.app.state.current_actor_resolver = resolver
        return resolver


def _policy_config(request: Request) -> Mapping[str, object]:
    configured = getattr(request.app.state, "auth_policy_config", None)
    if isinstance(configured, Mapping):
        return configured
    from config import build_auth_config

    payload = dict(build_auth_config())
    runtime = getattr(request.app.state, "config", {})
    payload["ALBUM_HAVEN_APP_DATABASE_URL"] = str(
        runtime.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
    ).strip()
    request.app.state.auth_policy_config = payload
    return payload
