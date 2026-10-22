"""New routes through the existing real router, context, CSRF and perimeter.

Service spies establish transport only; PostgreSQL behavior is tested separately.
"""
import pytest

from tests.py.test_library_mix_route_boundary import (
    boundary, assert_error, source_response, queue_response, queue_body,
    SOURCE, SOURCE_REVISION, commands, mixes, private_action_for_route, csrf_mode_for_route,
)

BASE = "/playlists/creation-source/artist-popular"
PROTOCOL = "artist_popular_selection_v1"


@pytest.fixture
def artist_boundary(boundary, monkeypatch):
    def record(name, service, context, payload, *, constraints=None, protocol=None):
        assert service is boundary.owner
        assert protocol == (None if name == "regenerate" else PROTOCOL)
        service.record(name, context, payload, constraints)
        response = queue_response() if name == "queue" else source_response()
        return response
    monkeypatch.setattr(mixes, "capture", lambda service, context, payload, **kw: record("capture", service, context, payload, **kw))
    monkeypatch.setattr(mixes, "read_capture", lambda service, context, ref, revision, **kw: record("read", service, context, (ref, revision), **kw))
    monkeypatch.setattr(mixes, "native_queue", lambda service, context, payload, **kw: record("queue", service, context, payload, **kw))
    monkeypatch.setattr(mixes, "regenerate", lambda service, context, payload, **kw: record("regenerate", service, context, payload, **kw))
    return boundary


@pytest.mark.parametrize("method,suffix,action", [
    ("POST", "", commands.CREATE), ("GET", "", commands.CREATE),
    ("POST", "/regenerate", commands.CREATE), ("POST", "/native-queue", commands.BROWSE),
])
def test_artist_routes_have_exact_existing_actions_and_private_envelopes(artist_boundary, method, suffix, action):
    path = BASE + suffix
    assert private_action_for_route(method, path) == action
    assert csrf_mode_for_route(method, path) == ("none" if method == "GET" else "session_header")
    query = {"source_ref": SOURCE, "source_revision": SOURCE_REVISION} if method == "GET" else None
    body = queue_body() if suffix == "/native-queue" else {"recipe": {}, "scope": {}}
    status, headers, result = artist_boundary.request(method, path, payload=body if method == "POST" else None, query=query)
    assert status == 200
    assert headers["cache-control"] == "private, no-store"
    assert result["status"] == "ready"
    assert len(artist_boundary.owner.calls) == 1
    assert artist_boundary.owner.calls[0][3] is artist_boundary.constraints


@pytest.mark.parametrize("suffix", ["", "/regenerate", "/native-queue"])
def test_artist_post_routes_reject_missing_csrf_before_service(artist_boundary, suffix):
    response = artist_boundary.request("POST", BASE + suffix, payload={}, omit=("x-album-haven-csrf",))
    assert response[0] == 403
    assert response[1]["cache-control"] == "private, no-store"
    assert artist_boundary.owner.calls == []


@pytest.mark.parametrize("suffix", ["", "/regenerate", "/native-queue"])
def test_artist_post_routes_reject_stale_context_before_service(artist_boundary, suffix):
    response = artist_boundary.request("POST", BASE + suffix, payload={}, headers={"x-albumhaven-context": "stale"})
    assert response[0] == 409
    assert response[1]["cache-control"] == "private, no-store"
    assert artist_boundary.owner.calls == []


def test_artist_read_rejects_duplicate_source_query(artist_boundary):
    response = artist_boundary.request("GET", BASE, query=[("source_ref", SOURCE), ("source_ref", SOURCE), ("source_revision", SOURCE_REVISION)])
    assert_error(response, "invalid_source_query", 422)
    assert artist_boundary.owner.calls == []
