"""Bounded route delegation, not middleware or live browser acceptance."""
import asyncio
from dataclasses import replace
import json
from uuid import uuid4
import pytest
from tests.py.test_owned_playlist_route_boundary import request, Service
from music_app.routes import owned_playlists_asgi as routes
from music_app.services.playlist_filter_preferences import DEFAULT_FILTERS


@pytest.fixture
def calls(monkeypatch):
    calls = []
    class Preferences:
        def __init__(self, owner):
            assert isinstance(owner, Service)
        def read(self, context, playlist_ref, **options):
            calls.append(("read", context, playlist_ref, options))
            return {"playlist_ref": playlist_ref, "revision": "1", "filters": None, "expires_at": None}
        def execute(self, context, command, **options):
            calls.append(("write", context, command, options))
            return {"ok": True, "revision": "2"}
    monkeypatch.setattr(routes, "PlaylistFilterPreferences", Preferences)
    return calls


def test_read_and_write_delegate_exact_resource_and_existing_preference_actions(calls):
    ref = str(uuid4())
    response = routes.playlist_filter_preferences(request(Service()), ref)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert calls[0][1].action == routes.PREFERENCE_READ
    assert calls[0][2] == ref
    body = {"revision": "1", "request_key": str(uuid4()), "filters": {**DEFAULT_FILTERS, "query": "Track"}}
    response = asyncio.run(routes.update_playlist_filter_preferences(request(Service(), payload=body), ref))
    assert response.status_code == 200 and len(json.loads(response.body)["context_ref"]) == 64
    assert calls[1][1].action == routes.PREFERENCE_WRITE
    assert calls[1][2].playlist_ref == ref and calls[1][2].data["filters"] == body["filters"]


@pytest.mark.parametrize("header", [None, "", "a" * 64])
def test_stale_context_never_writes(calls, header):
    response = asyncio.run(routes.update_playlist_filter_preferences(request(Service(), payload={}, header=header), str(uuid4())))
    assert response.status_code == 409 and calls == []


def test_bounded_payload_and_invalid_draft_never_reach_service(calls):
    response = asyncio.run(routes.update_playlist_filter_preferences(request(Service(), raw=b"{" + b" " * 4096 + b"}"), str(uuid4())))
    assert response.status_code == 413 and calls == []
    body = {"revision": "1", "request_key": str(uuid4()), "filters": {"query": "partial"}}
    response = asyncio.run(routes.update_playlist_filter_preferences(request(Service(), payload=body), str(uuid4())))
    assert response.status_code == 400 and calls == []


@pytest.mark.parametrize("patch", [{"minDuration": 10 ** 400}, {"query": "\ud800"},
    {"query": "\U0001f600" * 101}, {"style": "\U0001f600" * 51}, {"style": "\ufeffRock"}])
def test_bounded_numeric_and_unicode_inputs_fail_before_service(calls, patch):
    body = {"revision": "1", "request_key": str(uuid4()), "filters": {**DEFAULT_FILTERS, **patch}}
    raw = json.dumps(body).encode()
    assert len(raw) < 4096
    response = asyncio.run(routes.update_playlist_filter_preferences(request(Service(), raw=raw), str(uuid4())))
    assert response.status_code == 400 and calls == []


def test_duplicate_context_witness_is_rejected_even_when_values_match(calls):
    req = request(Service(), payload={})
    witness = next(value for key, value in req.scope["headers"] if key == b"x-albumhaven-context")
    req.scope["headers"].append((b"x-albumhaven-context", witness))
    response = asyncio.run(routes.update_playlist_filter_preferences(req, str(uuid4())))
    assert response.status_code == 409 and calls == []


@pytest.mark.parametrize("field", ["account_id", "session_id", "current_library_id"])
def test_post_thread_scope_change_cannot_publish_old_acknowledgement(calls, monkeypatch, field):
    body = {"revision": "1", "request_key": str(uuid4()), "filters": None}
    req = request(Service(), payload=body)
    async def run(fn, *args, **kwargs):
        result = fn(*args, **kwargs)
        actor = req.state.current_actor
        req.state.current_actor = replace(actor, **{field: getattr(actor, field) + 1})
        return result
    monkeypatch.setattr(routes, "run_in_threadpool", run)
    response = asyncio.run(routes.update_playlist_filter_preferences(req, str(uuid4())))
    assert response.status_code == 409 and len(calls) == 1
    assert "context_ref" not in json.loads(response.body)


def test_read_scope_change_cannot_publish_old_filter_values(calls, monkeypatch):
    req = request(Service())
    original = routes.PlaylistFilterPreferences.read
    def read(self, *args, **kwargs):
        result = original(self, *args, **kwargs)
        actor = req.state.current_actor
        req.state.current_actor = replace(actor, session_id=actor.session_id + 1)
        return result
    monkeypatch.setattr(routes.PlaylistFilterPreferences, "read", read)
    response = routes.playlist_filter_preferences(req, str(uuid4()))
    assert response.status_code == 409 and len(calls) == 1
    assert "filters" not in json.loads(response.body)
