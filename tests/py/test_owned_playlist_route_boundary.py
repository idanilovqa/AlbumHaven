"""Direct route transport tests with a stub service and real Request parsing.

These do not exercise app middleware, authenticate a real browser, prove CSRF,
open sockets or establish real SQL behavior. Run on the composed source that
includes the shared private_ui_context owner.
"""
import asyncio
from dataclasses import replace
import json
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest
from starlette.requests import Request

from music_app.routes import owned_playlists_asgi as routes
from music_app.services import owned_playlists as commands
from music_app.services.private_ui_context import private_ui_context_ref
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.owned_playlist_testing import (
    ACCOUNT, SESSION, LIBRARY, REQUEST, PLAYLIST, ITEM_A, SOURCE, SOURCE_REVISION,
    context, create_body,
)


class Service:
    def __init__(self, *, error=None):
        self.calls = []
        self.error = error

    def execute(self, supplied_context, command, *, constraints=None):
        self.calls.append(("execute", supplied_context, command, constraints))
        if self.error is not None:
            raise self.error
        return {"ok": True, "action": command.action, "request_key": command.request_key,
                "playlist_id": PLAYLIST, "revision": "8", "changed": True,
                "actor_scope": {"account_id": ACCOUNT, "library_id": LIBRARY}}

    def begin_source(self, supplied_context, *, constraints=None):
        self.calls.append(("begin", supplied_context, constraints))
        return {"status": "ready", "data": {"source": {"kind": "library", "ref": SOURCE, "revision": SOURCE_REVISION}}}

    def read_source_page(self, supplied_context, **kwargs):
        self.calls.append(("entries", supplied_context, kwargs))
        return {"status": "ready", "data": {"entries": [], "entries_complete": False}}

    def read_operation(self, supplied_context, request_key, *, constraints=None):
        self.calls.append(("operation", supplied_context, request_key, constraints))
        return {"status": "unknown"}

    def read(self, supplied_context, *, constraints=None, **kwargs):
        self.calls.append(("read", supplied_context, constraints, kwargs))
        return {"playlist_index": {"playlists": []}, "playlist_actions": {"can_create": True},
                "playlist_creation_protocol": "library_selection_v1",
                "actor_scope": {"account_id": ACCOUNT, "library_id": LIBRARY}}


def request(service, *, payload=None, raw=None, headers=None, query=None, actor=None,
            no_actor=False, header="valid", constraints=None, chunks=None):
    actor = context().actor if actor is None else actor
    app = SimpleNamespace(state=SimpleNamespace(
        config={"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"},
        auth_policy_config={"hmac": {"secret": "synthetic-route-origin-and-context-key-32", "key_version": 1}},
        owned_playlists_service=service, policy_constraint_resolver=constraints,
    ))
    state = {} if no_actor else {"current_actor": actor}
    raw_headers = {"content-type": "application/json", **(headers or {})}
    scope = {"type": "http", "method": "POST", "path": "/playlists", "app": app,
             "state": state, "scheme": "https", "client": ("192.0.2.10", 50000),
             "server": ("example.test", 443), "query_string": urlencode(query or {}).encode(), "headers": []}
    if header == "valid" and not no_actor:
        raw_headers["x-albumhaven-context"] = private_ui_context_ref(Request(scope))
    elif header is not None:
        raw_headers["x-albumhaven-context"] = header
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


@pytest.mark.parametrize("action,body", [
    ("create", create_body()),
    ("save", {"request_key": REQUEST, "revision": "7", "title": "Changed"}),
    ("add", {"request_key": REQUEST, "revision": "7", "track_refs": ["inventory-track:73:901"]}),
    ("reorder", {"request_key": REQUEST, "revision": "7", "item_order": [ITEM_A]}),
    ("remove", {"request_key": REQUEST, "revision": "7", "item_refs": [ITEM_A]}),
])
def test_write_routes_pass_normalized_commands_with_authenticated_scope_and_freshness_anchor(action, body):
    service = Service()
    resolver = lambda _context: PolicyEvaluationConstraints()
    req = request(service, payload=body, constraints=resolver,
                  headers={"x-album-haven-client-surface": "desktop"})
    response = asyncio.run(routes._write(req, action, None if action == "create" else PLAYLIST))
    assert response.status_code == 200
    payload = decoded(response)
    assert payload["context_ref"] == private_ui_context_ref(req)
    receipt = payload["data"] if action == "create" else payload
    if action == "create":
        assert payload["status"] == "ready"
    assert receipt["request_key"] == REQUEST and receipt["action"] == action
    assert receipt["actor_scope"] == {"account_id": ACCOUNT, "library_id": LIBRARY}
    _, supplied, command, passed_constraints = service.calls[0]
    assert supplied.actor is req.state.current_actor
    assert supplied.library_id == LIBRARY and supplied.client_surface_class == "private_web"
    assert passed_constraints is resolver
    assert command.request_key == REQUEST and command.action == action
    assert command.playlist_ref == (None if action == "create" else PLAYLIST)


@pytest.mark.parametrize("supplied", [None, "", "0" * 64, "0" * 63, "\u00e9" * 64])
@pytest.mark.parametrize("action", ["create", "save"])
def test_missing_malformed_or_stale_context_prevents_any_service_call(supplied, action):
    service = Service()
    req = request(service, payload=create_body(), header=supplied)
    response = asyncio.run(routes._write(req, action, None if action == "create" else PLAYLIST))
    assert response.status_code == 409
    assert decoded(response) == {"ok": False, "error": "stale_context"}
    assert service.calls == []


@pytest.mark.parametrize("field,value", [("session_id", SESSION + 1), ("account_id", ACCOUNT + 1),
                                        ("current_library_id", LIBRARY + 1)])
def test_context_digest_from_previous_actor_session_or_library_cannot_write(field, value):
    service = Service()
    old = request(service)
    stale = private_ui_context_ref(old)
    actor = replace(old.state.current_actor, **{field: value})
    req = request(service, actor=actor, header=stale,
                  payload={"request_key": REQUEST, "revision": "7", "title": "Changed"})
    response = asyncio.run(routes._write(req, "save", PLAYLIST))
    assert response.status_code == 409
    assert decoded(response)["error"] == "stale_context"
    assert service.calls == []


def test_missing_authenticated_actor_is_forbidden_before_service():
    service = Service()
    response = asyncio.run(routes._write(request(service, no_actor=True, payload=create_body()), "create"))
    assert response.status_code == 403
    assert decoded(response) == {"ok": False, "error": "forbidden"}
    assert service.calls == []


@pytest.mark.parametrize("raw", [b"{", b"[]", b"null", b"1", b"\xff"])
def test_malformed_or_non_object_json_cannot_reach_service(raw):
    service = Service()
    response = asyncio.run(routes._write(request(service, raw=raw), "create"))
    assert response.status_code == 422
    assert decoded(response)["error"] == "invalid_command"
    assert service.calls == []


@pytest.mark.parametrize("case", ["declared_large", "stream_large", "invalid_length", "negative_length", "length_mismatch"])
def test_bounded_body_parser_rejects_oversize_and_invalid_content_length_before_service(case):
    service = Service()
    headers, chunks, expected = {}, None, 422
    raw = b"{}"
    if case == "declared_large":
        headers["content-length"] = str(commands.MAX_PLAYLIST_COMMAND_BYTES + 1)
        expected = 413
    elif case == "stream_large":
        chunks = [b" " * commands.MAX_PLAYLIST_COMMAND_BYTES, b" "]
        expected = 413
    else:
        headers["content-length"] = {"invalid_length": "oops", "negative_length": "-1", "length_mismatch": "3"}[case]
    req = request(service, raw=raw, headers=headers, chunks=chunks)
    response = asyncio.run(routes._write(req, "create"))
    assert response.status_code == expected
    assert decoded(response)["error"] == ("command_too_large" if expected == 413 else "invalid_command")
    assert service.calls == []


@pytest.mark.parametrize("field", ["account_id", "owner_account_id", "library_id", "actor_scope"])
def test_body_cannot_override_authenticated_scope(field):
    service = Service()
    response = asyncio.run(routes._write(request(service, payload={**create_body(), field: 999}), "create"))
    assert response.status_code == 422
    assert decoded(response)["error"] == "invalid_command"
    assert service.calls == []


def test_single_delete_normalizes_path_item_ref_to_the_same_remove_command():
    service = Service()
    req = request(service, payload={"request_key": REQUEST, "revision": "7"})
    response = asyncio.run(routes.remove_playlist_item(req, PLAYLIST, ITEM_A))
    assert response.status_code == 200
    assert decoded(response)["action"] == "remove"
    command = service.calls[0][2]
    assert command.data == {"revision": "7", "item_refs": [ITEM_A]}


def test_single_delete_rejects_extra_body_item_refs_before_service():
    service = Service()
    req = request(service, payload={"request_key": REQUEST, "revision": "7", "item_refs": [ITEM_A]})
    response = asyncio.run(routes.remove_playlist_item(req, PLAYLIST, ITEM_A))
    assert response.status_code == 422
    assert decoded(response)["error"] == "invalid_command"
    assert service.calls == []


@pytest.mark.parametrize("code,status", [("forbidden", 403), ("playlist_unavailable", 404),
    ("source_expired", 410), ("revision_conflict", 409), ("idempotency_key_reused", 409)])
def test_service_errors_remain_bounded_private_no_store_transport_results(code, status):
    service = Service(error=commands.PlaylistError(code, status))
    req = request(service, payload={"request_key": REQUEST, "revision": "7", "title": "Changed"})
    response = asyncio.run(routes._write(req, "save", PLAYLIST))
    assert response.status_code == status
    assert decoded(response) == {"ok": False, "error": code}
    assert len(service.calls) == 1


def test_source_begin_requires_context_and_disallows_unrecognized_query_fields():
    service = Service()
    response = routes.begin_playlist_source(request(service, query={"account_id": ACCOUNT}))
    assert response.status_code == 422 and decoded(response)["error"] == "invalid_source_query"
    response = routes.begin_playlist_source(request(service, header=None))
    assert response.status_code == 409 and decoded(response)["error"] == "stale_context"
    assert service.calls == []
    req = request(service)
    response = routes.begin_playlist_source(req)
    assert response.status_code == 200 and decoded(response)["context_ref"] == private_ui_context_ref(req)
    assert len(service.calls) == 1 and service.calls[0][0] == "begin"


@pytest.mark.parametrize("query", [{"extra": "x"}, {"limit": "1000"}, {"limit": "1.0"},
                                   {"limit": "-1"}, {"limit": ""}, {"limit": "\u0661"}])
def test_source_entries_rejects_unknown_fields_and_non_ascii_page_limits(query):
    service = Service()
    response = routes.playlist_source_entries(request(service, query=query))
    assert response.status_code == 422
    assert decoded(response)["error"] == "invalid_source_query"
    assert service.calls == []


def test_source_entries_passes_explicit_source_query_cursor_and_limit_without_promoting_completeness():
    service = Service()
    req = request(service, query={"source_ref": SOURCE, "source_revision": SOURCE_REVISION,
                                  "q": "Needle", "cursor": "opaque", "limit": "25"})
    response = routes.playlist_source_entries(req)
    payload = decoded(response)
    assert response.status_code == 200 and payload["data"]["entries_complete"] is False
    args = service.calls[0][2]
    assert {key: value for key, value in args.items() if key != "constraints"} == {
        "source_ref": SOURCE, "source_revision": SOURCE_REVISION, "query": "Needle", "cursor": "opaque", "limit": 25}


def test_unknown_operation_and_empty_destinations_include_context_and_exact_empty_state():
    service = Service()
    req = request(service)
    operation = decoded(routes.playlist_operation(req, REQUEST))
    assert operation == {"status": "unknown", "context_ref": private_ui_context_ref(req)}
    destinations = decoded(routes.playlist_destinations(req))
    assert destinations["status"] == "empty"
    assert destinations["data"]["destinations"] == []
    assert destinations["data"]["allowed_actions"] == {"can_create": True}
    assert destinations["data"]["playlist_creation_protocol"] == "library_selection_v1"


def test_only_approved_playlist_methods_are_registered():
    registered = {}
    for route in routes.router.routes:
        existing = registered.setdefault(route.path, set())
        assert not existing.intersection(route.methods), "Duplicate Playlist route method"
        existing.update(route.methods)
    assert registered == {
        "/playlists/destinations": {"GET"},
        "/playlists/creation-source/current": {"GET"},
        "/playlists/creation-source/entries": {"GET"},
        "/playlists/operations/{request_key}": {"GET"},
        "/playlists": {"POST"},
        "/playlists/{playlist_ref}": {"PATCH", "DELETE"},
        "/playlists/{playlist_ref}/items": {"POST"},
        "/playlists/{playlist_ref}/items/reorder": {"POST"},
        "/playlists/{playlist_ref}/items/remove": {"POST"},
        "/playlists/{playlist_ref}/items/{playlist_item_ref}": {"DELETE"},
        "/playlists/{playlist_ref}/access-grants": {"GET", "POST"},
        "/playlists/{playlist_ref}/access-candidates": {"GET"},
        "/playlists/{playlist_ref}/access-grants/{grant_ref}": {"DELETE"},
        "/playlists/{playlist_ref}/visibility": {"PATCH"},
        "/playlists/{playlist_ref}/default-sort": {"POST"},
        "/account/playlist-preferences": {"GET", "PUT"},
        "/account/playlist-preferences/operations/{request_key}": {"GET"},
    }
