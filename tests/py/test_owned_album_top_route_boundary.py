"""Handler and real ASGI middleware contracts, not browser E2E or SQL proof."""
import asyncio
from dataclasses import replace
import json
import sys
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.requests import Request

from music_app.routes import owned_album_tops_asgi as routes
from music_app.routes.bounded_json import read_bounded_json_object
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.owned_album_tops import AlbumTopError, MAX_TOP_COMMAND_BYTES
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import csrf_mode_for_route, install_private_route_boundary, private_action_for_route
from music_app.services.private_ui_context import private_ui_context_ref


REQUEST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TOP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
ALBUM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
ITEM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
BROWSE = "library.browse.read"
CREATE = "library.album_tops.create"


class Service:
    def __init__(self, error=None):
        self.calls = []
        self.error = error

    def execute(self, context, command, *, constraints=None):
        self.calls.append(("execute", context, command, constraints))
        if self.error is not None:
            raise self.error
        return {"top_ref": TOP, "revision": "2", "request_key": command.request_key, "action": command.action}

    def read(self, context, **kwargs):
        self.calls.append(("read", context, kwargs))
        if self.error is not None:
            raise self.error
        return {"top_ref": TOP, "items": [], "revision": "1"}

    def list(self, context, **kwargs):
        self.calls.append(("list", context, kwargs))
        if self.error is not None:
            raise self.error
        return {"tops": [], "allowed_actions": {BROWSE: True, CREATE: True}, "next_cursor": None}

    def admit_inventory_album(self, context, **kwargs):
        self.calls.append(("admit", context, kwargs))
        if self.error is not None:
            raise self.error
        return {"album_ref": ALBUM}


def actor():
    return CurrentActor(state=ActorState.ACTIVE, account_id=41, session_id=8, current_library_id=73,
        library_relationships=(LibraryRelationship(73, "member", False),),
        capability_grants=(CapabilityGrant("capability.view", "library", 73),))


def request(service, *, payload=None, raw=None, headers=None, query=None, current_actor=None,
            no_actor=False, context_header="valid", constraints=None, chunks=None):
    current_actor = actor() if current_actor is None else current_actor
    app = SimpleNamespace(state=SimpleNamespace(
        config={"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"},
        auth_policy_config={"hmac": {"secret": "synthetic-top-route-and-context-key-32-bytes", "key_version": 1}},
        owned_album_tops_service=service, policy_constraint_resolver=constraints,
    ))
    scope = {"type": "http", "method": "POST", "path": "/album-tops", "app": app,
        "state": {} if no_actor else {"current_actor": current_actor}, "scheme": "https",
        "client": ("192.0.2.10", 50000), "server": ("example.test", 443),
        "query_string": urlencode(query or {}).encode(), "headers": []}
    raw_headers = {"content-type": "application/json", **(headers or {})}
    if context_header == "valid" and not no_actor:
        ref = private_ui_context_ref(Request(scope))
        if ref is not None:
            raw_headers["x-albumhaven-context"] = ref
    elif context_header is not None:
        raw_headers["x-albumhaven-context"] = context_header
    scope["headers"] = [(key.encode("ascii"), value.encode("latin1")) for key, value in raw_headers.items()]
    content = json.dumps(payload).encode() if raw is None and payload is not None else raw or b""
    pending = list(chunks) if chunks is not None else [content]

    async def receive():
        if not pending:
            return {"type": "http.disconnect"}
        return {"type": "http.request", "body": pending.pop(0), "more_body": bool(pending)}

    return Request(scope, receive)


def decoded(response):
    assert response.headers["cache-control"] == "private, no-store"
    return json.loads(response.body)


def create_body():
    return {"request_key": REQUEST, "title": "  New Top  ", "album_refs": [ALBUM]}


@pytest.mark.parametrize("action,changes", [
    ("create", {"title": "  New Top  ", "album_refs": [ALBUM]}),
    ("save", {"title": "Changed"}), ("add", {"album_refs": [ALBUM]}),
    ("remove", {"item_refs": [ITEM]}), ("reorder", {"item_order": [ITEM]}), ("delete", {}),
])
def test_mutations_pass_normalized_commands_with_authenticated_context(action, changes):
    service = Service()
    resolver = lambda _: PolicyEvaluationConstraints()
    body = {"request_key": REQUEST, **changes}
    if action != "create":
        body["revision"] = "1"
    req = request(service, payload=body, constraints=resolver,
                  headers={"x-album-haven-client-surface": "desktop"})
    response = asyncio.run(routes.create_album_top(req) if action == "create" else
                           routes.mutate_album_top(req, TOP, action))
    assert response.status_code == 200
    data = decoded(response)
    assert data["status"] == "ready" and data["context_ref"] == private_ui_context_ref(req)
    assert data["data"] == {"top_ref": TOP, "revision": "2", "request_key": REQUEST, "action": action}
    _, context, command, constraints = service.calls[0]
    assert context.actor is req.state.current_actor
    assert context.library_id == 73 and context.client_surface_class == "private_web"
    assert context.action == (CREATE if action == "create" else BROWSE)
    assert constraints is resolver
    assert command.action == action and command.request_key == REQUEST
    assert command.top_ref == (None if action == "create" else TOP)
    if action == "create":
        assert command.data["title"] == "New Top"


@pytest.mark.parametrize("header", [None, "", "0" * 63, "0" * 64, "é" * 64])
@pytest.mark.parametrize("entry", ["create", "save", "admit"])
def test_missing_or_stale_context_prevents_mutation_service_calls(header, entry):
    service = Service()
    req = request(service, payload=create_body(), context_header=header)
    call = (routes.create_album_top(req) if entry == "create" else
            routes.admit_album_top_inventory(req) if entry == "admit" else
            routes.mutate_album_top(req, TOP, "save"))
    response = asyncio.run(call)
    assert response.status_code == 409
    assert decoded(response) == {"ok": False, "error": "stale_context"}
    assert service.calls == []


@pytest.mark.parametrize("field,value", [("account_id", 42), ("session_id", 9), ("current_library_id", 74)])
def test_previous_actor_session_or_library_context_cannot_write(field, value):
    service = Service()
    old = request(service)
    stale = private_ui_context_ref(old)
    req = request(service, current_actor=replace(old.state.current_actor, **{field: value}),
                  context_header=stale, payload=create_body())
    response = asyncio.run(routes.create_album_top(req))
    assert response.status_code == 409 and decoded(response)["error"] == "stale_context"
    assert service.calls == []


@pytest.mark.parametrize("entry", ["create", "read", "list", "admit"])
@pytest.mark.parametrize("state", ["missing", ActorState.ANONYMOUS, ActorState.INACTIVE])
def test_unauthenticated_or_inactive_actor_fails_before_service(entry, state):
    service = Service()
    req = request(service, payload=create_body(), no_actor=state == "missing",
        current_actor=replace(actor(), state=state) if state != "missing" else None)
    response = (routes.read_album_top(req, TOP) if entry == "read" else routes.list_album_tops(req)
                if entry == "list" else asyncio.run(routes.create_album_top(req)
                if entry == "create" else routes.admit_album_top_inventory(req)))
    assert response.status_code == 403
    assert decoded(response) == {"ok": False, "error": "forbidden"}
    assert service.calls == []


@pytest.mark.parametrize("raw", [b"{", b"[]", b"null", b"1", b'"text"', b"\xff"])
def test_malformed_or_nonobject_body_cannot_reach_service(raw):
    service = Service()
    response = asyncio.run(routes.create_album_top(request(service, raw=raw)))
    assert response.status_code == 422 and decoded(response)["error"] == "invalid_command"
    assert service.calls == []


def oversized_json_integer_body():
    limit = sys.get_int_max_str_digits()
    if limit == 0:
        pytest.skip("Interpreter integer-string decoding guard is disabled")
    return b'{"request_key":' + b"9" * (limit + 1) + b',"title":"Numeric request key"}'


def test_shared_bounded_parser_returns_none_for_integer_decoding_guard_failure():
    raw = oversized_json_integer_body()
    req = request(Service(), raw=raw, headers={"content-length": str(len(raw))})
    assert asyncio.run(read_bounded_json_object(req, max_bytes=len(raw))) is None


@pytest.mark.parametrize("raw", [b'{"request_key":01}', b'{"request_key":+1}', b'{"request_key":1e}'])
def test_shared_bounded_parser_returns_none_for_malformed_json_numbers(raw):
    assert asyncio.run(read_bounded_json_object(request(Service(), raw=raw))) is None


def test_top_raw_request_rejects_oversized_json_integer_without_an_internal_error():
    raw = oversized_json_integer_body()
    service = Service()
    response = asyncio.run(routes.create_album_top(request(service, raw=raw)))
    # A guard configured above the transport bound reaches body-size rejection first.
    expected = (413, "command_too_large") if len(raw) > MAX_TOP_COMMAND_BYTES else (422, "invalid_command")
    assert (response.status_code, decoded(response)["error"]) == expected
    assert service.calls == []


@pytest.mark.parametrize("entry,bound", [("create", MAX_TOP_COMMAND_BYTES), ("admit", 1024)])
@pytest.mark.parametrize("case", ["declared_large", "stream_large", "invalid_length", "negative_length", "length_mismatch"])
def test_body_limits_apply_to_declared_and_streamed_bytes_before_service(entry, bound, case):
    service = Service()
    headers, chunks, status = {}, None, 422
    if case == "declared_large":
        headers["content-length"] = str(bound + 1)
        status = 413
    elif case == "stream_large":
        chunks = [b" " * bound, b" "]
        status = 413
    else:
        headers["content-length"] = {"invalid_length": "oops", "negative_length": "-1", "length_mismatch": "3"}[case]
    req = request(service, raw=b"{}", headers=headers, chunks=chunks)
    response = asyncio.run(routes.create_album_top(req) if entry == "create" else routes.admit_album_top_inventory(req))
    assert response.status_code == status
    assert decoded(response)["error"] == ("command_too_large" if status == 413 else "invalid_command")
    assert service.calls == []


@pytest.mark.parametrize("field", ["account_id", "owner_account_id", "library_id", "actor_scope", "local_path", "visibility"])
def test_browser_fields_cannot_override_authenticated_scope_or_resource_policy(field):
    service = Service()
    response = asyncio.run(routes.create_album_top(request(service, payload={**create_body(), field: "untrusted"})))
    assert response.status_code == 422 and decoded(response)["error"] == "invalid_command"
    assert service.calls == []


@pytest.mark.parametrize("entry", ["create", "save", "read", "admit"])
def test_unrecognized_query_fields_are_rejected_before_service(entry):
    service = Service()
    req = request(service, payload=create_body(), query={"account_id": "99"})
    response = (routes.read_album_top(req, TOP) if entry == "read" else asyncio.run(
        routes.create_album_top(req) if entry == "create" else routes.admit_album_top_inventory(req)
        if entry == "admit" else routes.mutate_album_top(req, TOP, "save")))
    assert response.status_code == 422 and decoded(response)["error"] == "invalid_command"
    assert service.calls == []


@pytest.mark.parametrize("action", ["share", "read", "CREATE", "restore", "progress"])
def test_unknown_mutation_action_is_not_dispatched(action):
    service = Service()
    response = asyncio.run(routes.mutate_album_top(request(service, payload=create_body()), TOP, action))
    assert response.status_code == 422 and decoded(response)["error"] == "invalid_command"
    assert service.calls == []


@pytest.mark.parametrize("code,status", [("forbidden", 403), ("top_unavailable", 404),
    ("revision_conflict", 409), ("request_key_conflict", 409), ("top_too_large", 413)])
@pytest.mark.parametrize("entry", ["create", "read", "list", "admit"])
def test_domain_errors_are_bounded_private_no_store_responses(code, status, entry):
    service = Service(error=AlbumTopError(code, status))
    req = request(service, payload={"album_id": 901} if entry == "admit" else create_body())
    response = (routes.read_album_top(req, TOP) if entry == "read" else routes.list_album_tops(req)
                if entry == "list" else asyncio.run(routes.create_album_top(req)
                if entry == "create" else routes.admit_album_top_inventory(req)))
    assert response.status_code == status
    assert decoded(response) == {"ok": False, "error": code}
    assert len(service.calls) == 1


def test_private_read_returns_context_without_requiring_a_mutation_header():
    service = Service()
    req = request(service, context_header=None)
    response = routes.read_album_top(req, TOP)
    assert response.status_code == 200
    assert decoded(response) == {"status": "ready", "data": {"top_ref": TOP, "items": [], "revision": "1"},
                                 "context_ref": private_ui_context_ref(req)}
    assert service.calls[0][2]["top_ref"] == TOP


def test_index_passes_bounded_pagination_context_and_server_secret():
    service = Service()
    req = request(service, query={"cursor": "opaque", "limit": "25"}, context_header=None)
    response = routes.list_album_tops(req)
    assert response.status_code == 200 and decoded(response)["context_ref"] == private_ui_context_ref(req)
    _, context, options = service.calls[0]
    assert context.actor is req.state.current_actor
    assert options["cursor"] == "opaque" and options["limit"] == 25
    assert options["cursor_secret"] == req.app.state.auth_policy_config["hmac"]["secret"]
    assert "cursor_secret" not in decoded(response)["data"]


@pytest.mark.parametrize("query", [{"extra": "x"}, {"limit": "1000"}, {"limit": "-1"},
    {"limit": "1.0"}, {"limit": ""}, {"limit": "١"}, [("limit", "1"), ("limit", "2")]])
def test_index_rejects_unknown_duplicate_and_malformed_query_parameters(query):
    service = Service()
    response = routes.list_album_tops(request(service, query=query))
    assert response.status_code == 422 and decoded(response)["error"] == "invalid_query"
    assert service.calls == []


def test_inventory_admission_passes_only_the_inventory_identity():
    service = Service()
    req = request(service, payload={"album_id": 901})
    response = asyncio.run(routes.admit_album_top_inventory(req))
    assert response.status_code == 200 and decoded(response)["data"] == {"album_ref": ALBUM}
    _, context, options = service.calls[0]
    assert context.actor is req.state.current_actor and context.action == CREATE
    assert options["album_id"] == 901


@pytest.mark.parametrize("payload", [{}, {"album_id": 901, "title": "Browser metadata"}, {"local_path": "/private/music"}])
def test_inventory_admission_rejects_metadata_and_local_paths(payload):
    service = Service()
    response = asyncio.run(routes.admit_album_top_inventory(request(service, payload=payload)))
    assert response.status_code == 422 and decoded(response)["error"] == "invalid_command"
    assert service.calls == []


def test_invalid_context_signing_version_fails_before_service():
    service = Service()
    req = request(service, payload=create_body())
    req.app.state.auth_policy_config["hmac"]["key_version"] = 0
    response = asyncio.run(routes.create_album_top(req))
    assert response.status_code == 503
    assert decoded(response)["error"] == "private_ui_context_unavailable"
    assert service.calls == []


@pytest.mark.parametrize("entry,bound", [("create", MAX_TOP_COMMAND_BYTES), ("admit", 1024)])
def test_body_parser_accepts_exact_byte_limit(entry, bound):
    service = Service()
    raw = json.dumps({"album_id": 901} if entry == "admit" else create_body()).encode()
    raw += b" " * (bound - len(raw))
    req = request(service, raw=raw, headers={"content-length": str(bound)})
    response = asyncio.run(routes.create_album_top(req) if entry == "create" else routes.admit_album_top_inventory(req))
    assert response.status_code == 200 and decoded(response)["status"] == "ready"
    assert len(service.calls) == 1


def test_every_top_route_has_explicit_policy_and_csrf_inventory():
    expected = {
        ("GET", "/album-tops"): BROWSE,
        ("GET", "/album-tops/{top_ref}"): BROWSE,
        ("GET", "/album-tops/edit-requests"): BROWSE,
        ("GET", "/album-tops/{top_ref}/sharing"): BROWSE,
        ("GET", "/album-tops/{top_ref}/access-grants"): "library.album_tops.access.manage",
        ("GET", "/album-tops/{top_ref}/access-candidates"): "library.album_tops.access.manage",
        ("POST", "/album-tops"): CREATE,
        ("POST", "/album-tops/{top_ref}/{action}"): BROWSE,
        ("POST", "/album-top-catalog/inventory"): CREATE,
    }
    actual = {(method, route.path) for route in routes.router.routes for method in route.methods}
    assert actual == set(expected)
    for (method, path), action in expected.items():
        assert private_action_for_route(method, path) == action
        assert csrf_mode_for_route(method, path) == ("none" if method == "GET" else "session_header")


class Resolver:
    def __init__(self, current_actor):
        self.actor = current_actor
        self.tokens = []

    def resolve(self, token):
        self.tokens.append(token)
        return self.actor


def middleware_app(service, current_actor):
    app = FastAPI()
    configured = request(service).app.state
    app.state.config = configured.config
    app.state.auth_policy_config = configured.auth_policy_config
    app.state.owned_album_tops_service = service
    app.state.current_actor_resolver = Resolver(current_actor)
    app.include_router(routes.router)
    install_private_route_boundary(app)
    return app


def mutation_headers(app, current_actor):
    session = "s" * 43
    csrf = issue_session_csrf(session, app.state.auth_policy_config)
    current = private_ui_context_ref(Request({"type": "http", "app": app,
                                            "state": {"current_actor": current_actor}}))
    return {"cookie": f"__Host-album_haven_session={session}; __Host-album_haven_csrf={csrf}",
            "origin": "https://music.test", "x-album-haven-csrf": csrf,
            "x-albumhaven-context": current}


async def asgi_response(app, method, path, *, headers=None, payload=None):
    body = b"" if payload is None else json.dumps(payload).encode()
    received = False
    finished = asyncio.Event()
    messages = []

    async def receive():
        nonlocal received
        if not received:
            received = True
            return {"type": "http.request", "body": body, "more_body": False}
        await finished.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        messages.append(message)
        if message["type"] == "http.response.body" and not message.get("more_body", False):
            finished.set()

    request_headers = {"host": "music.test", "content-type": "application/json",
                       "content-length": str(len(body)), **(headers or {})}
    await app({"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": method, "scheme": "https", "path": path, "raw_path": path.encode(),
        "query_string": b"", "headers": [(key.encode(), value.encode()) for key, value in request_headers.items()],
        "client": ("127.0.0.1", 50000), "server": ("music.test", 443)}, receive, send)
    start = next(message for message in messages if message["type"] == "http.response.start")
    content = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return start["status"], json.loads(content), dict(start["headers"])


@pytest.mark.parametrize("method,path", [("GET", "/album-tops"), ("GET", f"/album-tops/{TOP}"),
    ("POST", "/album-tops"), ("POST", f"/album-tops/{TOP}/save"), ("POST", "/album-top-catalog/inventory")])
@pytest.mark.parametrize("denial", ["anonymous", "inactive", "ungranted"])
def test_real_middleware_auth_and_policy_denials_are_private_no_store(method, path, denial):
    service = Service()
    current = (CurrentActor.anonymous() if denial == "anonymous" else
               replace(actor(), state=ActorState.INACTIVE) if denial == "inactive" else
               replace(actor(), capability_grants=()))
    app = middleware_app(service, current)
    status, body, headers = asyncio.run(asgi_response(app, method, path, payload=create_body()))
    assert status == (403 if denial == "ungranted" else 401)
    assert body == {"detail": "Action not permitted." if denial == "ungranted" else "Authentication required."}
    assert headers[b"cache-control"] == b"private, no-store"
    assert service.calls == [] and app.state.current_actor_resolver.tokens == [None]


@pytest.mark.parametrize("path,payload", [("/album-tops", create_body()),
    (f"/album-tops/{TOP}/save", {"request_key": REQUEST, "revision": "1", "title": "Changed"}),
    ("/album-top-catalog/inventory", {"album_id": 901})])
@pytest.mark.parametrize("invalid", ["missing_header", "missing_cookie", "cross_origin", "different_session"])
def test_real_middleware_rejects_invalid_csrf_before_top_handlers(path, payload, invalid):
    service = Service()
    current = actor()
    app = middleware_app(service, current)
    headers = mutation_headers(app, current)
    if invalid == "missing_header":
        del headers["x-album-haven-csrf"]
    elif invalid == "missing_cookie":
        headers["cookie"] = "__Host-album_haven_session=" + "s" * 43
    elif invalid == "cross_origin":
        headers["origin"] = "https://attacker.test"
    else:
        other = issue_session_csrf("A" * 43, app.state.auth_policy_config)
        headers["cookie"] = f"__Host-album_haven_session={'s' * 43}; __Host-album_haven_csrf={other}"
        headers["x-album-haven-csrf"] = other
    status, body, response_headers = asyncio.run(asgi_response(app, "POST", path, headers=headers, payload=payload))
    assert status == 403 and body == {"detail": "CSRF validation failed."}
    assert response_headers[b"cache-control"] == b"private, no-store"
    assert service.calls == [] and app.state.current_actor_resolver.tokens == ["s" * 43]


@pytest.mark.parametrize("path,payload,operation", [("/album-tops", create_body(), "execute"),
    (f"/album-tops/{TOP}/save", {"request_key": REQUEST, "revision": "1", "title": "Changed"}, "execute"),
    ("/album-top-catalog/inventory", {"album_id": 901}, "admit")])
def test_real_middleware_accepts_same_origin_csrf_and_fresh_ui_context(path, payload, operation):
    service = Service()
    current = actor()
    app = middleware_app(service, current)
    status, body, headers = asyncio.run(asgi_response(app, "POST", path,
        headers=mutation_headers(app, current), payload=payload))
    assert status == 200 and body["status"] == "ready"
    assert headers[b"cache-control"] == b"private, no-store"
    assert len(service.calls) == 1 and service.calls[0][0] == operation
    assert app.state.current_actor_resolver.tokens == ["s" * 43]


@pytest.mark.parametrize("path", ["/album-tops", "/album-top-catalog/inventory"])
def test_real_middleware_overrides_cacheable_downstream_top_responses(path):
    app = FastAPI()
    configured = request(Service()).app.state
    app.state.config = configured.config
    app.state.auth_policy_config = configured.auth_policy_config
    current = actor()
    app.state.current_actor_resolver = Resolver(current)

    @app.post(path)
    async def downstream():
        return JSONResponse({"changed": True}, headers={"Cache-Control": "public, max-age=3600"})

    install_private_route_boundary(app)
    status, body, headers = asyncio.run(asgi_response(app, "POST", path,
        headers=mutation_headers(app, current), payload={}))
    assert status == 200 and body == {"changed": True}
    assert headers[b"cache-control"] == b"private, no-store"
