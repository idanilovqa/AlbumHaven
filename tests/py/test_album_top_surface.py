"""Native Top shell routing, without browser E2E or persistence claims."""
from dataclasses import replace
import json
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest
from fastapi import FastAPI
from starlette.datastructures import QueryParams
from starlette.requests import Request

from music_app.routes import api_read_asgi_routes, owned_album_tops_asgi, web_asgi
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.playlist_read_seams import build_view_surface_payload, resolve_active_view_surface
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import install_private_route_boundary
from music_app.services.private_ui_context import private_ui_context_ref
from music_app.services.shell_layout_seams import build_shell_layout_payload
from tests.py.asgi_testing import run_asgi_request


TOP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
HMAC = {"hmac": {"secret": "synthetic-top-shell-context-key-32-bytes", "key_version": 1}}


def actor():
    return CurrentActor(state=ActorState.ACTIVE, account_id=41, session_id=8, current_library_id=73,
        library_relationships=(LibraryRelationship(73, "member", False),),
        capability_grants=(CapabilityGrant("capability.view", "library", 73),))


def request(query=None, *, current_actor=None, no_actor=False, constraints=None):
    app = SimpleNamespace(state=SimpleNamespace(
        config={"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"},
        auth_policy_config={"hmac": dict(HMAC["hmac"])}, policy_constraint_resolver=constraints,
    ))
    return Request({"type": "http", "method": "GET", "path": "/view-data", "app": app,
        "state": {} if no_actor else {"current_actor": current_actor or actor()}, "scheme": "https",
        "client": ("192.0.2.10", 50000), "server": ("music.test", 443),
        "query_string": urlencode(query or {"surface": "album_tops"}).encode(), "headers": []})


def decoded(response):
    assert response.headers["cache-control"] == "private, no-store"
    return json.loads(response.body)


@pytest.fixture(autouse=True)
def no_top_repository_access(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("The navigation shell must not read Top data or instantiate a Top repository")
    monkeypatch.setattr(owned_album_tops_asgi, "_service", forbidden)


def test_album_tops_is_a_live_surface_inside_the_shared_shell():
    assert resolve_active_view_surface(" ALBUM_TOPS ") == "album_tops"
    surface = build_view_surface_payload("album_tops")
    assert surface["active"] == "album_tops"
    assert "album_tops" in surface["supported"]
    assert "album_tops" not in surface["reserved"]
    shell = build_shell_layout_payload(active_surface="album_tops", selected_artist="Old artist")
    assert shell["kind"] == "shared_media_shell"
    assert shell["slots"]["navigation_rail"]["content_kind"] == "album_tops_sidebar"
    assert shell["slots"]["main_content"] == {"surface_ref": "album_tops", "content_kind": "album_tops"}
    assert shell["slots"]["contextual_pane"]["active_pane"] == "album_tops"
    assert shell["slots"]["contextual_pane"]["is_visible"] is False
    assert shell["slots"]["bottom_player"]["is_persistent"] is True


@pytest.mark.parametrize("top_ref", [None, TOP])
@pytest.mark.parametrize("omit_sidebar", [False, True])
def test_native_view_data_contains_only_navigation_and_empty_gallery_state(top_ref, omit_sidebar):
    query = {"surface": "album_tops"}
    if top_ref:
        query["top_ref"] = top_ref
    if omit_sidebar:
        query["omit_sidebar"] = "1"
    req = request(query)
    response = api_read_asgi_routes.view_data(req)
    assert response.status_code == 200
    payload = decoded(response)
    assert payload["surface"]["active"] == "album_tops"
    assert payload["top_ref"] == top_ref
    assert payload["context_ref"] == private_ui_context_ref(req)
    assert payload["payload_tier"] == "full" and payload["initial_view_partial"] is False
    for field in ("artist_groups", "artists_sidebar", "non_album_tracks"):
        assert payload[field] == []
    assert payload["album_count"] == payload["artist_count"] == 0
    assert not {"tops", "items", "title", "allowed_actions", "playlist_detail", "playlist_index",
                "local_path", "music_dir", "owner_account_id", "account_id", "library_id"} & payload.keys()


@pytest.mark.parametrize("query,error", [
    ({"surface": "album_tops", "top_ref": "not-a-uuid"}, "invalid_command"),
    ({"surface": "album_tops", "top_ref": TOP.upper()}, "invalid_command"),
    ({"surface": "album_tops", "owner_account_id": "99"}, "invalid_query"),
    ({"surface": "album_tops", "playlist_id": TOP}, "invalid_query"),
    ({"surface": "album_tops", "q": "stale artist search"}, "invalid_query"),
    ([("surface", "album_tops"), ("surface", "albums")], "invalid_query"),
    ([("surface", "album_tops"), ("top_ref", TOP), ("top_ref", TOP)], "invalid_query"),
])
def test_native_descriptor_rejects_ambiguous_or_foreign_query_fields(query, error):
    response = owned_album_tops_asgi.album_top_view_response(request(query))
    assert response.status_code == 422
    assert decoded(response) == {"ok": False, "error": error}


@pytest.mark.parametrize("denial", ["missing", "anonymous", "inactive", "ungranted", "wrong_library"])
def test_native_descriptor_requires_authenticated_current_library_browse(denial):
    current = actor()
    if denial == "anonymous":
        current = CurrentActor.anonymous()
    elif denial == "inactive":
        current = replace(current, state=ActorState.INACTIVE)
    elif denial == "ungranted":
        current = replace(current, capability_grants=())
    elif denial == "wrong_library":
        current = replace(current, current_library_id=74)
    response = api_read_asgi_routes.view_data(request(current_actor=current, no_actor=denial == "missing"))
    assert response.status_code == 403
    assert decoded(response) == {"ok": False, "error": "forbidden"}


def test_native_descriptor_preserves_narrowing_constraints():
    seen = []
    def constraints(context):
        seen.append(context)
        return PolicyEvaluationConstraints(request_origin_allowed=False)
    req = request(constraints=constraints)
    response = api_read_asgi_routes.view_data(req)
    assert response.status_code == 403 and decoded(response)["error"] == "forbidden"
    assert len(seen) == 1
    assert seen[0].action == "library.browse.read"
    assert seen[0].actor is req.state.current_actor and seen[0].library_id == 73


def test_unavailable_private_context_cannot_produce_an_unstamped_descriptor():
    req = request()
    req.app.state.auth_policy_config["hmac"]["key_version"] = 0
    response = api_read_asgi_routes.view_data(req)
    assert response.status_code == 503
    assert decoded(response) == {"ok": False, "error": "private_ui_context_unavailable"}


@pytest.mark.parametrize("denial", ["anonymous", "inactive", "ungranted"])
def test_composed_middleware_denials_remain_private_no_store(denial):
    current = (CurrentActor.anonymous() if denial == "anonymous" else
               replace(actor(), state=ActorState.INACTIVE) if denial == "inactive" else
               replace(actor(), capability_grants=()))
    app = FastAPI()
    app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"}
    app.state.auth_policy_config = HMAC
    app.state.current_actor_resolver = SimpleNamespace(resolve=lambda _token: current)
    app.include_router(api_read_asgi_routes.router)
    install_private_route_boundary(app)
    status, headers, body = run_asgi_request(app, "GET", "/view-data", query={"surface": "album_tops"})
    assert status == (403 if denial == "ungranted" else 401)
    assert headers["cache-control"] == "private, no-store"
    assert json.loads(body) == {"detail": "Action not permitted." if denial == "ungranted" else "Authentication required."}


@pytest.mark.parametrize("top_ref", [None, TOP])
def test_direct_page_bootstrap_keeps_top_identity_without_browse_or_top_queries(monkeypatch, top_ref):
    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)
    monkeypatch.setattr(web_asgi, "get_primary_music_root", lambda _config: Path("/synthetic-test-library"))
    def forbidden(*_args, **_kwargs):
        pytest.fail("Direct Album Top entry must not build a library gallery projection")
    monkeypatch.setattr(web_asgi, "PostgresLibraryBrowseRepository", forbidden)
    query = {"surface": "album_tops", **({"top_ref": top_ref} if top_ref else {})}
    payload, _elapsed, _preview = web_asgi._build_bootstrap_payload(
        query_args=QueryParams(query), config={}, logger=None, library_state={},
        query_raw="", selected_artist="", refreshed=False, request_started_epoch_ms=1,
    )
    initial = payload["initial_view"]
    assert initial["surface"]["active"] == "album_tops" and initial["top_ref"] == top_ref
    assert initial["shell_layout"]["slots"]["main_content"]["content_kind"] == "album_tops"
    assert initial["artist_groups"] == initial["artists_sidebar"] == []
    assert not {"tops", "items", "playlist_detail", "playlist_index"} & initial.keys()
    assert payload["bootstrap"]["startupHydration"]["required"] is False
