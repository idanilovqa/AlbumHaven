"""Exact deployed public metadata perimeter and real ASGI router composition."""
import asyncio
import json

import pytest
from fastapi import FastAPI
from starlette.requests import Request

from music_app.routes import public_album_tops_asgi as routes
from music_app.services.current_actor import CurrentActor
from music_app.services.private_route_boundary import (
    install_private_route_boundary, public_share_request_origin, _is_public_share_request,
)
from tests.py.test_owned_album_top_route_boundary import actor, Resolver, request as private_request

SHARE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ITEM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
ORIGIN = "https://public.example.test"
PATH = "/public/album-tops/" + SHARE


class Service:
    def __init__(self):
        self.calls = []
        self.error = None
        self.after = None
    def read_guest(self, **options):
        self.calls.append(options)
        if self.error:
            raise self.error
        if self.after:
            self.after()
        return {"share_ref": SHARE, "publication_ref": ITEM, "publication_revision": "1",
                "title": "Approved metadata", "description": "", "items": [], "next_cursor": None,
                "allowed_actions": {"can_read": True, "can_open_item": True}}


def app_for(service=None, current=None, enabled=True):
    app = FastAPI()
    app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted",
        "ALBUM_HAVEN_PUBLIC_SHARING_ENABLED": enabled,
        "ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN": ORIGIN, "ALBUM_HAVEN_PUBLIC_BASE_URL": ORIGIN}
    app.state.auth_policy_config = private_request(Service()).app.state.auth_policy_config
    app.state.current_actor_resolver = Resolver(current or CurrentActor.anonymous())
    app.state.public_album_tops_service = service or Service()
    app.include_router(routes.router)
    install_private_route_boundary(app)
    return app


async def exchange(app, method="GET", path=PATH, *, raw_path=None, host="public.example.test",
                   scheme="https", query=b"", headers=None):
    messages = []
    finished = asyncio.Event()
    received = False
    async def receive():
        nonlocal received
        if not received:
            received = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await finished.wait()
        return {"type": "http.disconnect"}
    async def send(message):
        messages.append(message)
        if message["type"] == "http.response.body" and not message.get("more_body", False):
            finished.set()
    values = {"host": host, **(headers or {})}
    await app({"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": method, "scheme": scheme, "path": path, "raw_path": raw_path if raw_path is not None else path.encode(),
        "query_string": query, "headers": [(key.encode(), value.encode()) for key, value in values.items()],
        "client": ("192.0.2.10", 3000), "server": (host, 443)}, receive, send)
    response = next(value for value in messages if value["type"] == "http.response.start")
    body = b"".join(value.get("body", b"") for value in messages if value["type"] == "http.response.body")
    return response["status"], body, dict(response["headers"])


def origin_request(**changes):
    scope = {"type": "http", "method": "GET", "path": PATH, "raw_path": PATH.encode(),
        "scheme": "https", "server": ("public.example.test", 443),
        "headers": [(b"host", b"public.example.test")], "query_string": b"", "app": app_for()}
    scope.update(changes)
    return Request(scope)


@pytest.mark.parametrize("method", ["GET", "HEAD"])
@pytest.mark.parametrize("suffix", ["", "/items/" + ITEM])
def test_existing_exact_origin_helper_and_wrapper_admit_only_metadata_shapes(method, suffix):
    path = PATH + suffix
    req = origin_request(method=method, path=path, raw_path=path.encode())
    assert public_share_request_origin(req) == ORIGIN and _is_public_share_request(req) is True


@pytest.mark.parametrize("changes", [
    {"method": "POST"}, {"method": "PUT"}, {"method": "OPTIONS"},
    {"path": PATH + "/"}, {"path": PATH.upper()}, {"path": PATH + "/tracks"},
    {"raw_path": PATH.replace("a", "%61", 1).encode()}, {"raw_path": PATH.encode() + b"/"},
    {"scheme": "http"}, {"headers": [(b"host", b"foreign.example.test")]},
    {"headers": [(b"host", b"public.example.test:444")]},
    {"headers": [(b"host", b"foreign.example.test"), (b"origin", ORIGIN.encode()),
                 (b"x-forwarded-host", b"public.example.test"), (b"x-forwarded-proto", b"https")]},
])
def test_extracted_origin_helper_preserves_rejected_method_raw_path_and_authority(changes):
    req = origin_request(**changes)
    assert public_share_request_origin(req) is None and _is_public_share_request(req) is False


@pytest.mark.parametrize("enabled", [False, "true", 1, None])
def test_explicit_boolean_deployment_opt_in_is_required(enabled):
    req = origin_request()
    req.app.state.config["ALBUM_HAVEN_PUBLIC_SHARING_ENABLED"] = enabled
    assert public_share_request_origin(req) is None and not _is_public_share_request(req)


def test_missing_optional_raw_path_keeps_the_existing_canonical_path_behavior():
    req = origin_request(raw_path=None)
    assert public_share_request_origin(req) == ORIGIN and _is_public_share_request(req)


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE", "OPTIONS"])
def test_no_non_read_method_gains_an_anonymous_service_path(method):
    service = Service()
    status, body, _ = asyncio.run(exchange(app_for(service), method))
    assert status in {401, 403, 405}
    assert service.calls == []


def test_route_itself_rejects_unavailable_origin_even_with_authenticated_request_state():
    req = origin_request(headers=[(b"host", b"foreign.example.test")], state={"current_actor": actor()})
    response = asyncio.run(routes.read_public_album_top(req, SHARE))
    assert response.status_code == 404 and json.loads(response.body) == {"ok": False, "error": "unavailable"}
    assert req.app.state.public_album_tops_service.calls == []


@pytest.mark.parametrize("current", [None, actor()])
@pytest.mark.parametrize("method", ["GET", "HEAD"])
@pytest.mark.parametrize("suffix", ["", "/items/" + ITEM])
def test_guest_and_signed_in_exact_url_use_only_guest_metadata_service(current, method, suffix):
    service = Service()
    app = app_for(service, current)
    status, body, headers = asyncio.run(exchange(app, method, PATH + suffix, query=b"limit=2"))
    assert status == 200
    assert headers[b"cache-control"] == b"private, no-store"
    assert headers[b"x-content-type-options"] == b"nosniff" and headers[b"referrer-policy"] == b"no-referrer"
    assert len(service.calls) == 1
    options = service.calls[0]
    assert options["request_origin"].origin_type == "network" and options["request_origin"].origin_key == ORIGIN
    assert options["share_ref"] == SHARE and options["item_ref"] == (ITEM if suffix else None)
    assert options["limit"] == 2 and options["cursor"] is None
    assert "context" not in options and "context_ref" not in options
    if method == "HEAD":
        assert body == b""
    else:
        value = json.loads(body)
        assert set(value) == {"status", "data"} and value["status"] == "ready"
        assert value["data"]["allowed_actions"] == {"can_read": True, "can_open_item": True}


@pytest.mark.parametrize("query", [b"limit=1&limit=2", b"cursor=a&cursor=b", b"play=1", b"limit=0", b"limit=251"])
def test_query_duplicates_unknown_fields_and_invalid_limits_never_call_service(query):
    service = Service()
    status, body, _ = asyncio.run(exchange(app_for(service), query=query))
    assert status == 400 and json.loads(body)["error"] == "invalid_query"
    assert service.calls == []


@pytest.mark.parametrize("current", [None, actor()])
@pytest.mark.parametrize("failure", ["disabled", "wrong_origin", "encoded_path"])
def test_unavailable_origin_cannot_reach_metadata_even_when_authenticated(current, failure):
    service = Service()
    app = app_for(service, current, enabled=failure != "disabled")
    options = {"host": "foreign.example.test"} if failure == "wrong_origin" else {}
    if failure == "encoded_path":
        options["raw_path"] = PATH.replace("a", "%61", 1).encode()
    status, body, _ = asyncio.run(exchange(app, **options))
    assert status in {401, 403, 404}
    assert service.calls == []


def test_deployment_retirement_during_blocking_read_discards_result():
    service = Service()
    app = app_for(service)
    service.after = lambda: app.state.config.update(ALBUM_HAVEN_PUBLIC_SHARING_ENABLED=False)
    status, body, headers = asyncio.run(exchange(app))
    assert status == 404 and json.loads(body) == {"ok": False, "error": "unavailable"}
    assert headers[b"cache-control"] == b"private, no-store"


@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_unexpected_service_error_is_sanitized_and_head_still_has_no_body(method):
    service = Service()
    service.error = RuntimeError("private path and credential sentinel")
    status, body, headers = asyncio.run(exchange(app_for(service), method))
    assert status == 503
    if method == "HEAD":
        assert body == b""
    else:
        assert json.loads(body) == {"ok": False, "error": "unavailable"}
    assert b"sentinel" not in body and headers[b"referrer-policy"] == b"no-referrer"


def test_public_routes_are_only_the_two_reserved_get_head_pairs():
    assert {(route.path, frozenset(route.methods)) for route in routes.router.routes} == {
        ("/public/album-tops/{share_ref}", frozenset({"GET", "HEAD"})),
        ("/public/album-tops/{share_ref}/items/{item_ref}", frozenset({"GET", "HEAD"}))}


def test_app_composition_source_registers_the_same_router_inside_existing_owner():
    # Structural registration proof only; does not boot app/config or claim E2E.
    import ast
    from pathlib import Path
    source = Path(__file__).resolve().parents[2] / "music_app" / "__init__.py"
    module = ast.parse(source.read_text(encoding="utf-8"))
    owners = [node for node in module.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
              and node.name == "_configure_asgi_app"]
    assert len(owners) == 1
    imports = [node for node in ast.walk(owners[0]) if isinstance(node, ast.ImportFrom)
               and node.module == "music_app.routes.public_album_tops_asgi"]
    assert len(imports) == 1
    assert [(name.name, name.asname) for name in imports[0].names] == [("router", "public_album_tops_asgi_router")]
    calls = [node for node in ast.walk(owners[0]) if isinstance(node, ast.Call)
             and isinstance(node.func, ast.Attribute) and node.func.attr == "include_router"
             and len(node.args) == 1 and isinstance(node.args[0], ast.Name)
             and node.args[0].id == "public_album_tops_asgi_router"]
    assert len(calls) == 1
