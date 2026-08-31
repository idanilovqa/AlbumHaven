from __future__ import annotations

import asyncio
import json
from pathlib import Path
from collections.abc import Iterable
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs
from urllib.parse import urlencode
from urllib.parse import urlsplit

from tests.py.runtime_testing import configure_test_app_paths


class _BootstrapOwnerResolver:
    def resolve(self, _raw_token):
        from music_app.services.current_actor import ActorState, CurrentActor

        return CurrentActor(
            state=ActorState.ACTIVE,
            account_id=1,
            session_id=1,
            username_display="Rendref",
            is_bootstrap_owner=True,
        )


def configure_test_bootstrap_actor(asgi_app) -> None:
    """Authenticate legacy route-unit requests through the production boundary."""

    if not hasattr(asgi_app.state, "current_actor_resolver"):
        asgi_app.state.current_actor_resolver = _BootstrapOwnerResolver()
    if not hasattr(asgi_app.state, "auth_policy_config"):
        asgi_app.state.auth_policy_config = {
            "hmac": {
                "secret": "test-only-policy-origin-key-32-bytes-minimum",
                "key_version": 1,
            }
        }


def create_test_asgi_app(tmp_path: Path, monkeypatch):
    configure_test_app_paths(tmp_path, monkeypatch)

    from music_app import create_asgi_app

    asgi_app = create_asgi_app()
    asgi_app.state.config["TESTING"] = True
    configure_test_bootstrap_actor(asgi_app)
    return asgi_app


def runtime_app_from_asgi_app(asgi_app):
    return SimpleNamespace(
        config=asgi_app.state.config,
        library_state=asgi_app.state.library_state,
        logger=asgi_app.state.logger,
    )


class TestQueryArgs:
    def __init__(self, values: dict[str, list[str]]):
        self._values = values

    def get(self, key: str, default=None):
        values = self._values.get(key)
        if not values:
            return default
        return values[0]

    def getlist(self, key: str) -> list[str]:
        return list(self._values.get(key, []))


def query_args_from_url(url: str) -> TestQueryArgs:
    return TestQueryArgs(parse_qs(urlsplit(url).query, keep_blank_values=True))


def _route_path(route: object) -> str:
    for attr_name in ("path", "path_format"):
        path = getattr(route, attr_name, None)
        if isinstance(path, str) and path:
            return path
    return ""


def _join_route_paths(prefix: str, path: str) -> str:
    normalized_prefix = str(prefix or "").strip()
    normalized_path = str(path or "").strip()
    if not normalized_prefix:
        return normalized_path or "/"
    if not normalized_path or normalized_path == "/":
        return normalized_prefix
    if normalized_path.startswith(normalized_prefix + "/"):
        return normalized_path
    return normalized_prefix.rstrip("/") + "/" + normalized_path.lstrip("/")


def _iter_route_nodes(root: object) -> Iterable[tuple[object, str]]:
    visited: set[int] = set()

    def walk(node: object, prefix: str = ""):
        node_id = id(node)
        if node_id in visited:
            return
        visited.add(node_id)

        path = _route_path(node)
        joined_path = _join_route_paths(prefix, path) if path else prefix
        yield node, joined_path

        child_containers = (
            getattr(node, "routes", None),
            getattr(getattr(node, "router", None), "routes", None),
            getattr(getattr(node, "app", None), "routes", None),
            getattr(getattr(getattr(node, "app", None), "router", None), "routes", None),
        )
        child_prefix = joined_path if path else prefix
        for child_routes in child_containers:
            if not isinstance(child_routes, Iterable) or isinstance(child_routes, (str, bytes, bytearray)):
                continue
            for child in child_routes:
                yield from walk(child, child_prefix)

    yield from walk(root)


def collect_route_paths(app) -> list[str]:
    paths: list[str] = []
    seen_paths: set[str] = set()
    for _route, path in _iter_route_nodes(app):
        if path and path not in seen_paths:
            seen_paths.add(path)
            paths.append(path)
    return paths


def collect_route_methods(app) -> dict[str, set[str]]:
    route_methods: dict[str, set[str]] = {}
    for route, path in _iter_route_nodes(app):
        methods = getattr(route, "methods", None)
        if path and methods:
            route_methods[path] = {str(method) for method in methods}
    return route_methods


async def run_asgi_request_async(
    app,
    method: str,
    path: str,
    *,
    query: dict[str, object] | None = None,
    headers: dict[str, str] | None = None,
    json_body: Any = None,
    body: bytes = b"",
) -> tuple[int, dict[str, str], bytes]:
    if hasattr(getattr(app, "state", None), "runtime_asset_version"):
        configure_test_bootstrap_actor(app)
    query_string = urlencode(query or {}, doseq=True).encode("ascii")
    request_body = body
    request_headers = [(b"host", b"testserver")]
    for key, value in (headers or {}).items():
        request_headers.append((key.lower().encode("latin1"), value.encode("latin1")))
    if (
        hasattr(getattr(app, "state", None), "runtime_asset_version")
        and method.upper() not in {"GET", "HEAD", "OPTIONS"}
    ):
        from music_app.services.auth_session_csrf import issue_session_csrf

        session = "s" * 43
        csrf = issue_session_csrf(session, app.state.auth_policy_config)
        present = {key for key, _value in request_headers}
        if b"cookie" not in present:
            request_headers.append(
                (
                    b"cookie",
                    (
                        f"__Host-album_haven_session={session}; "
                        f"__Host-album_haven_csrf={csrf}"
                    ).encode("ascii"),
                )
            )
        if b"origin" not in present:
            request_headers.append((b"origin", b"http://testserver"))
        if b"x-album-haven-csrf" not in present:
            request_headers.append((b"x-album-haven-csrf", csrf.encode("ascii")))
    if json_body is not None:
        request_body = json.dumps(json_body).encode("utf-8")
        request_headers.append((b"content-type", b"application/json"))
        request_headers.append((b"content-length", str(len(request_body)).encode("ascii")))
    elif body:
        request_headers.append((b"content-length", str(len(request_body)).encode("ascii")))

    messages: list[dict[str, object]] = []
    request_sent = False

    async def receive() -> dict[str, object]:
        nonlocal request_sent
        if request_sent:
            return {"type": "http.disconnect"}
        request_sent = True
        return {"type": "http.request", "body": request_body, "more_body": False}

    async def send(message: dict[str, object]) -> None:
        messages.append(message)

    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": query_string,
            "headers": request_headers,
            "client": ("testclient", 50000),
            "server": ("testserver", 80),
        },
        receive,
        send,
    )

    start = next(message for message in messages if message["type"] == "http.response.start")
    response_body = b"".join(
        message.get("body", b"")
        for message in messages
        if message["type"] == "http.response.body"
    )
    response_headers = {
        key.decode("latin1").lower(): value.decode("latin1")
        for key, value in start.get("headers", [])
    }
    return int(start["status"]), response_headers, response_body


def run_asgi_request(
    app,
    method: str,
    path: str,
    **kwargs,
) -> tuple[int, dict[str, str], bytes]:
    return asyncio.run(run_asgi_request_async(app, method, path, **kwargs))


def decode_json(body: bytes) -> Any:
    return json.loads(body.decode("utf-8"))
