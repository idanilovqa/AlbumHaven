"""Private Top sharing routes retain the real ASGI authentication boundary."""
import asyncio
from dataclasses import replace

import pytest

from music_app.routes import owned_album_tops_asgi as routes
from music_app.services.current_actor import ActorState, CurrentActor
from music_app.services.owned_album_tops import ACCESS, BROWSE, MAX_TOP_COMMAND_BYTES
from music_app.services.private_route_boundary import csrf_mode_for_route, private_action_for_route
from music_app.services.private_ui_context import private_ui_context_ref
from tests.py.test_album_top_collaboration_commands import CASES
from tests.py.test_owned_album_top_route_boundary import (
    REQUEST, TOP, Service as BaseService, actor, asgi_response, decoded,
    middleware_app, mutation_headers, request,
)


READS = (
    ("/album-tops/edit-requests", "read_edit_requests", BROWSE),
    ("/album-tops/{top_ref}/sharing", "read_sharing", BROWSE),
    ("/album-tops/{top_ref}/access-grants", "read_access", ACCESS),
    ("/album-tops/{top_ref}/access-candidates", "read_access_candidates", ACCESS),
)


class Service(BaseService):
    def _read(self, name, context, top_ref=None, **options):
        self.calls.append((name, context, top_ref, options))
        return {"requests": [], "grants": [], "candidates": [], "pending_requests": [], "next_cursor": None}

    def read_edit_requests(self, context, **options):
        return self._read("read_edit_requests", context, **options)

    def read_sharing(self, context, top_ref, **options):
        return self._read("read_sharing", context, top_ref, **options)

    def read_access(self, context, top_ref, **options):
        return self._read("read_access", context, top_ref, **options)

    def read_access_candidates(self, context, top_ref, **options):
        return self._read("read_access_candidates", context, top_ref, **options)


def read_endpoint(path, req, *, top_ref=TOP):
    endpoint = next(route.endpoint for route in routes.router.routes if route.path == path and "GET" in route.methods)
    return endpoint(req, top_ref) if "{top_ref}" in path else endpoint(req)


@pytest.mark.parametrize("action,extra,_", CASES)
def test_generic_mutation_transport_accepts_only_normalized_collaboration_commands(action, extra, _):
    service = Service()
    req = request(service, payload={"revision": "4", "request_key": REQUEST, **extra})
    response = asyncio.run(routes.mutate_album_top(req, TOP, action))
    assert response.status_code == 200
    assert decoded(response)["context_ref"] == private_ui_context_ref(req)
    assert decoded(response)["data"]["action"] == action
    assert len(service.calls) == 1
    _, context, command, constraints = service.calls[0]
    assert context.actor is req.state.current_actor and context.library_id == 73
    assert command.top_ref == TOP and command.request_key == REQUEST
    assert command.data == {"revision": "4", **extra}


@pytest.mark.parametrize("action,extra,_", CASES)
@pytest.mark.parametrize("header", [None, "", "0" * 64])
def test_collaboration_mutations_reject_stale_context_before_service(action, extra, _, header):
    service = Service()
    response = asyncio.run(routes.mutate_album_top(request(service, context_header=header,
        payload={"revision": "4", "request_key": REQUEST, **extra}), TOP, action))
    assert response.status_code == 409 and decoded(response)["error"] == "stale_context"
    assert service.calls == []


@pytest.mark.parametrize("action,extra,_", CASES)
@pytest.mark.parametrize("mode", ["declared", "streamed"])
def test_all_collaboration_bodies_keep_the_shared_byte_limit(action, extra, _, mode):
    service = Service()
    req = request(service, raw=b"{}", headers={"content-length": str(MAX_TOP_COMMAND_BYTES + 1)} if mode == "declared" else {},
        chunks=[b" " * MAX_TOP_COMMAND_BYTES, b" "] if mode == "streamed" else None)
    response = asyncio.run(routes.mutate_album_top(req, TOP, action))
    assert response.status_code == 413 and decoded(response)["error"] == "command_too_large"
    assert service.calls == []


@pytest.mark.parametrize("path,name,capability", READS)
def test_reads_forward_current_context_private_envelope_and_scoped_cursor(path, name, capability):
    service = Service()
    query = {"cursor": "opaque"}
    if name != "read_sharing":
        query["limit"] = "7"
    if name == "read_access_candidates":
        query["q"] = "Reader"
    req = request(service, query=query, context_header=None)
    response = read_endpoint(path, req)
    assert response.status_code == 200
    assert decoded(response)["context_ref"] == private_ui_context_ref(req)
    operation, context, top_ref, options = service.calls[0]
    assert operation == name and context.actor is req.state.current_actor
    assert context.library_id == 73 and context.action == capability
    assert top_ref == (None if name == "read_edit_requests" else TOP)
    assert options["cursor"] == "opaque"
    assert options["cursor_secret"] == req.app.state.auth_policy_config["hmac"]["secret"]
    assert "cursor_secret" not in decoded(response)["data"]
    if name != "read_sharing":
        assert options["limit"] == 7
    if name == "read_access_candidates":
        assert options["query"] == "Reader"


@pytest.mark.parametrize("path,_,__", READS)
@pytest.mark.parametrize("query", [
    {"account_id": "99"}, {"library_id": "74"}, {"owner_account_id": "99"},
    [("cursor", "one"), ("cursor", "two")],
])
def test_reads_reject_injected_scope_and_ambiguous_queries(path, _, __, query):
    service = Service()
    response = read_endpoint(path, request(service, query=query))
    assert response.status_code == 422 and decoded(response)["error"] == "invalid_query"
    assert service.calls == []


@pytest.mark.parametrize("path,name,_", [read for read in READS if read[1] != "read_sharing"])
@pytest.mark.parametrize("limit", ["0", "101", "-1", "1.5", "", "١", "１", "1000"])
def test_paginated_reads_reject_invalid_or_unbounded_limits(path, name, _, limit):
    service = Service()
    response = read_endpoint(path, request(service, query={"limit": limit}))
    assert response.status_code == 422 and decoded(response)["error"] == "invalid_query"
    assert service.calls == []


@pytest.mark.parametrize("path,_,__", READS)
@pytest.mark.parametrize("state", ["missing", ActorState.ANONYMOUS, ActorState.INACTIVE])
def test_read_identity_fails_before_service(path, _, __, state):
    service = Service()
    req = request(service, no_actor=state == "missing",
        current_actor=replace(actor(), state=state) if state != "missing" else None)
    response = read_endpoint(path, req)
    assert response.status_code == 403 and decoded(response)["error"] == "forbidden"
    assert service.calls == []


@pytest.mark.parametrize("path,_,__", READS[1:])
@pytest.mark.parametrize("ref", ["bad", TOP.upper(), TOP.replace("-", ""), TOP + "\n"])
def test_resource_reads_validate_canonical_top_ref_before_service(path, _, __, ref):
    service = Service()
    response = read_endpoint(path, request(service), top_ref=ref)
    assert response.status_code == 422 and decoded(response)["error"] == "invalid_command"
    assert service.calls == []


def test_read_routes_are_unique_policy_bound_and_static_feed_precedes_top_identity():
    registered = [(method, route.path) for route in routes.router.routes for method in route.methods]
    for path, _, action in READS:
        assert registered.count(("GET", path)) == 1
        assert private_action_for_route("GET", path) == action
        assert csrf_mode_for_route("GET", path) == "none"
    assert registered.index(("GET", "/album-tops/edit-requests")) < registered.index(("GET", "/album-tops/{top_ref}"))
    assert private_action_for_route("POST", "/album-tops/{top_ref}/{action}") == BROWSE
    assert csrf_mode_for_route("POST", "/album-tops/{top_ref}/{action}") == "session_header"


def test_real_asgi_routes_requests_feed_to_its_static_handler():
    service = Service()
    app = middleware_app(service, actor())
    status, body, headers = asyncio.run(asgi_response(app, "GET", "/album-tops/edit-requests"))
    assert status == 200 and body["status"] == "ready"
    assert headers[b"cache-control"] == b"private, no-store"
    assert [call[0] for call in service.calls] == ["read_edit_requests"]


@pytest.mark.parametrize("action,extra,_", CASES)
def test_real_middleware_requires_csrf_then_dispatches_fresh_collaboration_command(action, extra, _):
    service = Service()
    current = actor()
    app = middleware_app(service, current)
    path = f"/album-tops/{TOP}/{action}"
    payload = {"request_key": REQUEST, "revision": "4", **extra}
    headers = mutation_headers(app, current)
    invalid = {key: value for key, value in headers.items() if key != "x-album-haven-csrf"}
    status, body, response_headers = asyncio.run(asgi_response(app, "POST", path, headers=invalid, payload=payload))
    assert status == 403 and body == {"detail": "CSRF validation failed."}
    assert response_headers[b"cache-control"] == b"private, no-store" and service.calls == []
    status, body, response_headers = asyncio.run(asgi_response(app, "POST", path, headers=headers, payload=payload))
    assert status == 200 and body["data"]["action"] == action
    assert response_headers[b"cache-control"] == b"private, no-store"
    assert len(service.calls) == 1


@pytest.mark.parametrize("path,_,__", READS)
@pytest.mark.parametrize("denial", ["anonymous", "inactive", "ungranted"])
def test_real_middleware_guards_all_collaboration_reads(path, _, __, denial):
    current = (CurrentActor.anonymous() if denial == "anonymous" else
        replace(actor(), state=ActorState.INACTIVE) if denial == "inactive" else replace(actor(), capability_grants=()))
    service = Service()
    app = middleware_app(service, current)
    status, body, headers = asyncio.run(asgi_response(app, "GET", path.replace("{top_ref}", TOP)))
    assert status == (403 if denial == "ungranted" else 401)
    assert headers[b"cache-control"] == b"private, no-store" and service.calls == []
