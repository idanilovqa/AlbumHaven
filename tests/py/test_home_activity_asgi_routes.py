"""HTTP activity contracts through the real authenticated policy boundary."""
from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import FastAPI

from music_app.services import home_activity as activity
from music_app.services import private_ui_context
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import install_private_route_boundary, private_action_for_route
from tests.py.asgi_testing import collect_route_paths, create_test_asgi_app, decode_json, run_asgi_request

PRIVATE_FAILURE = "postgresql://private-user:private-password@private-host/private-db"


def actor(account_id=41, *, state=ActorState.ACTIVE, grants=True, membership=True, bootstrap=False):
    return CurrentActor(
        state=state, account_id=account_id, session_id=11,
        current_library_id=73, is_bootstrap_owner=bootstrap,
        library_relationships=(LibraryRelationship(73, "member", False),) if membership else (),
        capability_grants=(CapabilityGrant("library.browse.read", "library", 73),) if grants else (),
    )


def ready():
    return {"status": "ready", "data": {
        "rows": [{"id": "a_safe_opaque_row", "kind": "track", "title": "Track", "artist": "Artist",
                  "album_title": "Album", "listen_count": 1, "last_listened_at": "2026-10-08T11:00:00+00:00",
                  "duration_seconds": 180, "source_label": "Album Haven", "availability": "local",
                  "source_readable": True, "detail_ref": None, "rating": None, "artwork_url": None,
                  "allowed_actions": {"can_view_details": False}}],
        "total_listens": 1, "period_label": "Last week", "range_label": "Oct 1 – Oct 8, 2026",
        "snapshot_ref": "a" * 43, "expires_at": "2026-10-08T13:00:00+00:00", "next_cursor": None,
        "coverage": {"requested_start": "2026-10-01T12:00:00+00:00", "requested_end": "2026-10-08T12:00:00+00:00",
                     "timezone": "UTC", "source_families": ["rendered_local_listen_session"],
                     "observed_start": "2026-10-08T11:00:00+00:00", "observed_end": "2026-10-08T11:00:00+00:00",
                     "complete_for_available_snapshot": True, "complete_for_requested_period": False,
                     "label": "Available stored meaningful listening history."},
    }}


@pytest.fixture
def route_module():
    from music_app.routes import home_activity_asgi_routes
    return home_activity_asgi_routes


def app_for(monkeypatch, route_module, *, current_actor=None, deployment="self_hosted", failure=None):
    calls = []
    resolver = SimpleNamespace(actor=current_actor if current_actor is not None else actor())
    resolver.resolve = lambda _token: resolver.actor

    def read(config, **kwargs):
        calls.append({"config": config, **kwargs})
        if failure is not None:
            raise failure
        return deepcopy(ready())

    monkeypatch.setattr(route_module, "read_home_activity", read)
    # This fixture owns only the HTTP/history seam; native receipt/SQL authority
    # has its own real integration suite. Preserve the route's projection call.
    monkeypatch.setattr(route_module, "ActivityNativeTargets", lambda config: SimpleNamespace(
        project=lambda context, *, origin, rows, constraints: rows))
    app = FastAPI()
    app.state.current_actor_resolver = resolver
    app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": deployment}
    app.state.auth_policy_config = {"hmac": {"secret": "home-activity-test-origin-key-32-bytes-minimum", "key_version": 1}}
    app.include_router(route_module.router)
    install_private_route_boundary(app)
    return app, calls, resolver


def request(app, query=None, *, method="GET"):
    return run_asgi_request(app, method, "/home/activity", query=query,
                            headers={"cookie": "__Host-album_haven_session=" + "s" * 43})


def assert_private(headers):
    values = {part.strip().casefold() for part in headers["cache-control"].split(",")}
    assert {"private", "no-store"} <= values


def expected_context(app, current):
    from starlette.requests import Request

    request = Request({"type": "http", "app": app})
    request.state.current_actor = current
    return private_ui_context.private_ui_context_ref(request)


@pytest.mark.parametrize("deployment", ["hosted", "self_hosted"])
def test_normal_authenticated_member_uses_existing_browse_permission(monkeypatch, route_module, deployment):
    app, calls, _ = app_for(monkeypatch, route_module, deployment=deployment)
    status, headers, body = request(app, {"kind": "tracks", "period": "week"})
    assert status == 200
    assert decode_json(body) == {**ready(), "context_ref": expected_context(app, calls[0]["actor"])}
    assert_private(headers)
    assert len(calls) == 1
    assert calls[0]["actor"].account_id == 41
    assert calls[0]["actor"].current_library_id == 73
    assert calls[0]["query"].kind == "tracks"
    assert calls[0]["query"].period == "week"
    assert calls[0]["allowed_actions_for_resource"]("track", 101).allows("library.browse.read")


def test_route_is_registered_in_the_normal_app_and_has_exact_existing_action(tmp_path, monkeypatch):
    app = create_test_asgi_app(tmp_path, monkeypatch)
    assert "/home/activity" in collect_route_paths(app)
    assert private_action_for_route("GET", "/home/activity") == "library.browse.read"


@pytest.mark.parametrize("current", [CurrentActor.anonymous(), actor(state=ActorState.INACTIVE)])
def test_unauthenticated_and_revoked_actor_receive_private_401_without_read(monkeypatch, route_module, current):
    app, calls, _ = app_for(monkeypatch, route_module, current_actor=current)
    status, headers, body = request(app)
    assert status == 401
    assert_private(headers)
    assert calls == []
    assert "private-password" not in body.decode()


def test_actor_without_browse_grant_is_denied_before_read(monkeypatch, route_module):
    app, calls, _ = app_for(monkeypatch, route_module, current_actor=actor(grants=False))
    status, headers, _ = request(app)
    assert status == 403
    assert_private(headers)
    assert calls == []


@pytest.mark.parametrize("constraint", [
    PolicyEvaluationConstraints(client_surface_allowed=False),
    PolicyEvaluationConstraints(request_origin_allowed=False),
])
def test_existing_client_and_origin_constraints_remain_authoritative(monkeypatch, route_module, constraint):
    app, calls, _ = app_for(monkeypatch, route_module)
    app.state.policy_constraint_resolver = lambda _context: constraint
    status, headers, _ = request(app)
    assert status == 403
    assert_private(headers)
    assert calls == []


@pytest.mark.parametrize("query", [
    {"account_ref": "someone-else"}, {"account_ref": "null"}, {"account_id": "41"}, {"library_id": "73"},
    {"timezone": "UTC"}, {"start": "2020-01-01"}, {"period": "30d"}, {"kind": "friends"},
    {"kind": ["albums", "tracks"]}, {"period": ["week", "all"]},
    {"page_size": "25"}, {"page": "2", "period": "all"}, {"cursor": "private/path"},
    {"snapshot_ref": "../../private"}, {"unknown": "private-password"},
    {"context_ref": "a" * 64},
])
def test_invalid_or_cross_account_query_is_private_422_without_repository_read(monkeypatch, route_module, query):
    app, calls, _ = app_for(monkeypatch, route_module)
    status, headers, body = request(app, query)
    assert status == 422
    assert_private(headers)
    assert calls == []
    assert "private-password" not in body.decode()
    assert "../../private" not in body.decode()


@pytest.mark.parametrize("status_code,code", [(403, "activity_denied"), (410, "activity_snapshot_expired"), (422, "invalid_activity_query")])
def test_expected_service_errors_preserve_status_and_private_cache_policy(monkeypatch, route_module, status_code, code):
    failure = activity.HomeActivityError("Activity is unavailable.", status_code=status_code, code=code)
    app, calls, _ = app_for(monkeypatch, route_module, failure=failure)
    status, headers, body = request(app)
    assert status == status_code
    assert_private(headers)
    assert len(calls) == 1
    assert decode_json(body)["error"] == code


def test_missing_or_failed_persistence_is_safe_unavailable_not_known_empty(monkeypatch, route_module):
    app, calls, _ = app_for(monkeypatch, route_module, failure=RuntimeError(PRIVATE_FAILURE))
    status, headers, body = request(app)
    assert status == 503
    assert_private(headers)
    assert len(calls) == 1
    payload = decode_json(body)
    assert payload.get("status") != "empty"
    assert PRIVATE_FAILURE not in body.decode()
    assert "private-password" not in body.decode()


def test_request_actor_cannot_leak_into_the_next_request(monkeypatch, route_module):
    app, calls, resolver = app_for(monkeypatch, route_module)
    first = request(app)
    assert first[0] == 200
    resolver.actor = actor(52)
    second = request(app)
    assert second[0] == 200
    resolver.actor = actor(41)
    third = request(app)
    assert third[0] == 200
    assert [call["actor"].account_id for call in calls] == [41, 52, 41]
    assert decode_json(first[2])["context_ref"] != decode_json(second[2])["context_ref"]
    assert decode_json(first[2])["context_ref"] == decode_json(third[2])["context_ref"]


def test_initial_route_context_is_authoritative_even_without_a_receipt(monkeypatch, route_module):
    app, calls, resolver = app_for(monkeypatch, route_module)

    def hostile_read(_config, **_kwargs):
        return {**ready(), "context_ref": "f" * 64}

    monkeypatch.setattr(route_module, "read_home_activity", hostile_read)
    status, headers, body = request(app, {"kind": "tracks", "period": "week"})
    assert status == 200
    assert_private(headers)
    expected = expected_context(app, resolver.actor)
    assert expected != "f" * 64
    assert decode_json(body) == {**ready(), "context_ref": expected}


def test_route_passes_resource_policy_with_exact_current_actor_and_library(monkeypatch, route_module):
    app, calls, _ = app_for(monkeypatch, route_module)
    contexts = []

    def constraints(context):
        contexts.append(context)
        return PolicyEvaluationConstraints(deployment_allowed=context.resource is None or context.resource.resource_ref != "101")

    # Configure after the route's scope-wide admission, then inspect the callback.
    assert request(app)[0] == 200
    app.state.policy_constraint_resolver = constraints
    allowed = calls[0]["allowed_actions_for_resource"]("track", 101)
    assert allowed.allows("library.browse.read") is False
    assert contexts[-1].actor.account_id == 41
    assert contexts[-1].library_id == 73
    assert contexts[-1].resource.resource_kind == "track"
    assert contexts[-1].resource.resource_ref == "101"


def test_shared_context_failure_is_a_safe_private_503(monkeypatch, route_module):
    app, _calls, _resolver = app_for(monkeypatch, route_module)

    def unavailable(_request):
        raise private_ui_context.PrivateUIContextError()

    monkeypatch.setattr(route_module, "private_ui_context_ref", unavailable)
    status, headers, body = request(app)
    assert status == 503
    assert_private(headers)
    assert decode_json(body) == {"error": "private_ui_context_unavailable"}
