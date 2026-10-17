"""Actual ASGI transport contracts; the service double is not SQL/E2E proof."""
import asyncio

import pytest

from music_app.routes import owned_album_tops_asgi as routes
from music_app.services.owned_album_tops import AlbumTopError, MAX_TOP_COMMAND_BYTES
from tests.py.test_owned_album_top_route_boundary import (
    REQUEST, TOP, Service, actor, asgi_response, decoded, middleware_app,
    mutation_headers, request,
)


def body():
    return {"request_key": REQUEST, "activity_revision": "0", "active": False}


def test_activity_uses_real_middleware_csrf_and_authenticated_command_boundary():
    service, current = Service(), actor()
    app = middleware_app(service, current)
    headers = mutation_headers(app, current)
    path = f"/album-tops/{TOP}/set_activity"
    invalid = {key: value for key, value in headers.items() if key != "x-album-haven-csrf"}
    status, payload, _ = asyncio.run(asgi_response(app, "POST", path, headers=invalid, payload=body()))
    assert status == 403 and service.calls == []
    status, payload, response_headers = asyncio.run(asgi_response(app, "POST", path, headers=headers, payload=body()))
    assert status == 200 and payload["data"]["action"] == "set_activity"
    assert response_headers[b"cache-control"] == b"private, no-store"
    _, context, command, _ = service.calls[0]
    assert context.actor.account_id == current.account_id
    assert command.data == {"activity_revision": "0", "active": False}


@pytest.mark.parametrize("header", [None, "", "0" * 64])
def test_activity_stale_context_does_not_reach_service(header):
    service = Service()
    response = asyncio.run(routes.mutate_album_top(request(service,
        payload=body(), context_header=header), TOP, "set_activity"))
    assert response.status_code == 409 and decoded(response)["error"] == "stale_context"
    assert service.calls == []


@pytest.mark.parametrize("extra", [{"account_id": 99}, {"revision": "1"}, {"occurred_at": "2026-01-01"}])
def test_activity_route_rejects_scope_and_time_injection(extra):
    service = Service()
    response = asyncio.run(routes.mutate_album_top(request(service,
        payload={**body(), **extra}), TOP, "set_activity"))
    assert response.status_code == 422 and service.calls == []


@pytest.mark.parametrize("mode", ["query", "declared", "streamed"])
def test_activity_keeps_query_and_body_bounds(mode):
    service = Service()
    req = request(service, payload=body(), query={"account_id": "99"} if mode == "query" else {},
        headers={"content-length": str(MAX_TOP_COMMAND_BYTES + 1)} if mode == "declared" else {},
        chunks=[b" " * MAX_TOP_COMMAND_BYTES, b" "] if mode == "streamed" else None)
    response = asyncio.run(routes.mutate_album_top(req, TOP, "set_activity"))
    assert response.status_code == (422 if mode == "query" else 413)
    assert service.calls == []


@pytest.mark.parametrize("error", ["top_inactive", "activity_revision_conflict"])
def test_activity_conflicts_keep_the_existing_conflict_envelope(error):
    service = Service(error=AlbumTopError(error, 409))
    response = asyncio.run(routes.mutate_album_top(request(service, payload=body()), TOP, "set_activity"))
    assert response.status_code == 409
    assert decoded(response) == {"ok": False, "error": error}
