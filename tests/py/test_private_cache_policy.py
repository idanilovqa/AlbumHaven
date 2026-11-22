"""The cache policy of private answers, through the app's real middleware and routes.

An answer behind the private boundary without a policy of its own is ``private, no-store``, errors
included, and so is every answer to an address that names a file path, whatever the route says. A
storable policy is a deliberate exception and is listed here, so a new route cannot pick one unseen.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
import re
from urllib.parse import urlencode

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response, StreamingResponse
import pytest

from music_app.services import private_route_boundary
NO_STORE = "private, no-store"
MADE_UP_PATH = "Q:\\Made Up\\Album\\01.flac"
PUBLIC_GET_ROUTES = {
    "/health", "/favicon.ico", "/app-copy-worker.js", "/login", "/forgot-password", "/reset-password",
    "/accept-invitation", "/accept-invitation/continue", "/artifacts/android/download/{token}", "/downloads/{token}",
}


def _answer(app, path: str, query: dict[str, str] | None = None) -> tuple[int, dict[str, str]]:
    """The status and headers of a bare GET: no session, and a failure's answer rather than its exception."""
    sent: list[dict] = []
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET", "scheme": "http",
        "path": path, "raw_path": path.encode(), "root_path": "", "query_string": urlencode(query or {}).encode(),
        "headers": [(b"host", b"testserver")], "client": ("testclient", 1), "server": ("testserver", 80), "app": app,
    }

    async def receive():
        if sent and not sent[-1].get("more_body", sent[-1]["type"] == "http.response.start"):
            return {"type": "http.disconnect"}
        await asyncio.sleep(0)
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    async def call():
        try:
            await app(scope, receive, send)
        except Exception:
            if not sent:
                raise

    asyncio.run(call())
    start = next(message for message in sent if message["type"] == "http.response.start")
    return start["status"], {key.decode().lower(): value.decode() for key, value in start["headers"]}


def _get_routes(routes) -> set[str]:
    found: set[str] = set()
    for route in routes:
        included = getattr(route, "original_router", None)
        if included is not None:
            found |= _get_routes(included.routes)
        elif "GET" in (getattr(route, "methods", None) or ()):
            found.add(route.path)
    return found


def test_every_private_get_route_of_the_app_defaults_to_no_store(asgi_app):
    routes = _get_routes(asgi_app.routes)
    public = {route for route in routes if private_route_boundary._is_public("GET", route)}
    assert public <= PUBLIC_GET_ROUTES, "a new public route is a decision: list it"
    assert len(routes - PUBLIC_GET_ROUTES) > 50

    storable = []
    for route in sorted(routes - PUBLIC_GET_ROUTES):
        address = re.sub(r"\{[^}]+\}", "made-up", route)
        for query in ({}, {"path": MADE_UP_PATH}):
            # Signed out, every private route answers at the boundary: the shared default, not the route's.
            _status, headers = _answer(asgi_app, address, query)
            if "no-store" not in headers.get("cache-control", ""):
                storable.append((route, bool(query), headers.get("cache-control")))

    assert storable == []


def _boundary_app(monkeypatch, policy: str | None = None) -> FastAPI:
    app = FastAPI()
    private_route_boundary.install_private_route_boundary(app)

    async def signed_in(request):
        request.state.current_actor = object()

    def allowed(*_args, **_kwargs):
        async def check(_request):
            return None

        return check

    monkeypatch.setattr(private_route_boundary, "current_actor_from_request", signed_in)
    monkeypatch.setattr(private_route_boundary, "require_action", allowed)
    monkeypatch.setattr(private_route_boundary, "_private_resource", lambda *_args: None)
    monkeypatch.setattr(private_route_boundary, "_refresh_session_csrf_cookie", lambda *_args: None)
    headers = {"Cache-Control": policy} if policy else {}

    @app.get("/json")
    async def json_answer():
        return JSONResponse({"ok": True}, headers=headers)

    @app.get("/missing")
    async def missing():
        return JSONResponse({"ok": False}, status_code=404, headers=headers)

    @app.get("/lines")
    async def lines():
        async def stream():
            yield b"{}\n"

        return StreamingResponse(stream(), media_type="application/x-ndjson", headers=headers)

    @app.get("/bytes")
    async def media():
        return Response(b"audio", media_type="audio/flac", headers=headers)

    @app.get("/fails")
    async def fails():
        raise RuntimeError("made up")

    return app


@pytest.mark.parametrize("path", ["/json", "/missing", "/lines", "/bytes", "/no-such-route"])
def test_an_answer_without_a_policy_of_its_own_is_not_stored(monkeypatch, path):
    _status, headers = _answer(_boundary_app(monkeypatch), path)

    assert headers["cache-control"] == NO_STORE


def test_an_unhandled_failure_is_not_stored(monkeypatch):
    status, headers = _answer(_boundary_app(monkeypatch), "/fails")

    assert status == 500
    assert headers["cache-control"] == NO_STORE


def test_a_deliberate_policy_is_kept(monkeypatch):
    _status, headers = _answer(_boundary_app(monkeypatch, "private, max-age=300"), "/bytes")

    assert headers["cache-control"] == "private, max-age=300"


@pytest.mark.parametrize("query", [
    {"path": MADE_UP_PATH},
    {"track_path": "made-up-relative/01.flac"},
    {"album_key": MADE_UP_PATH},
    {"album_key": "/made-up/album/01.flac"},
    {"album_key": "\\\\made-up-server\\share\\01.flac"},
])
def test_an_address_that_names_a_path_is_never_stored_whatever_the_route_says(monkeypatch, query):
    _status, headers = _answer(_boundary_app(monkeypatch, "private, max-age=300"), "/bytes", query)

    assert headers["cache-control"] == NO_STORE


@pytest.mark.parametrize("query", [
    {"url": "https://images.example/cover.jpg"},
    {"album_key": "ac/dc::back in black"},
    {"v": "2c0558f047ba", "size": "480"},
])
def test_an_address_without_a_path_keeps_a_deliberate_policy(monkeypatch, query):
    _status, headers = _answer(_boundary_app(monkeypatch, "private, max-age=300"), "/bytes", query)

    assert headers["cache-control"] == "private, max-age=300"


def test_every_storable_policy_in_the_source_is_a_listed_decision():
    root = Path(private_route_boundary.__file__).resolve().parents[1]
    found = set()
    for source in root.rglob("*.py"):
        for line in source.read_text(encoding="utf-8").splitlines():
            policy = re.search(r"f?\"((?:public|private), max-age=[^\"]*|no-cache|private, no-cache|public, max-age=[^\"]*)\"", line)
            if policy and ("Cache-Control" in line or "CACHE_CONTROL" in line):
                found.add((source.name, policy.group(1)))

    assert found == {
        ("__init__.py", "public, max-age=31536000, immutable"),  # versioned static assets
        ("api_wave_b_asgi_routes.py", "public, max-age=300"),  # the app's own foobar help assets
        ("api_wave_d_asgi_routes.py", "private, max-age=3600"),  # a candidate image, named by its web URL
        ("playback_control_asgi.py", "private, max-age=3600"),  # notification artwork, named by a token
        ("web_asgi.py", "private, max-age={max_age}"),  # covers by reference
        ("web_asgi.py", "public, max-age=86400"),  # the empty favicon
        ("web_asgi.py", "no-cache"),  # the worker script, public
    }
