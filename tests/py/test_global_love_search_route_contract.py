"""Personal Search admission at the existing /view-data boundary.

These are route/security contracts, not PostgreSQL membership evidence. The
existing route and policy middleware are imported normally. No proposed Search
service/module is imported or installed by this fixture.
"""
from dataclasses import replace
import json
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest
from fastapi import FastAPI
from starlette.requests import Request

from music_app.routes import api_read_asgi_routes as routes
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.private_route_boundary import install_private_route_boundary
from music_app.services.private_ui_context import private_ui_context_ref
from tests.py.asgi_testing import run_asgi_request

FORMS = (":loved", "love:loved", ":obsessed", "love:obsessed")
HMAC = {"hmac": {"secret": "synthetic-global-search-context-key-32-bytes", "key_version": 1}}


def actor():
    return CurrentActor(state=ActorState.ACTIVE, account_id=41, session_id=8,
        current_library_id=73, library_relationships=(LibraryRelationship(73, "member", False),),
        capability_grants=(CapabilityGrant("library.browse.read", "library", 73),))


def make_request(query, *, context="valid", current=None, valid_signing=True):
    app = SimpleNamespace(state=SimpleNamespace(
        config={"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"}, library_state={},
        auth_policy_config=HMAC if valid_signing else {"hmac": {"key_version": 0}},
    ))
    scope = {"type": "http", "method": "GET", "path": "/view-data", "app": app,
        "state": {"current_actor": current or actor()}, "scheme": "https",
        "client": ("192.0.2.10", 50000), "server": ("music.test", 443),
        "query_string": urlencode(query, doseq=True).encode("ascii"), "headers": []}
    request = Request(scope)
    if context is not None:
        value = private_ui_context_ref(request) if context == "valid" else context
        scope["headers"] = [(b"x-albumhaven-context", value.encode("ascii"))]
        request = Request(scope)
    return request


@pytest.fixture(autouse=True)
def postgres_route_selection(monkeypatch):
    # Select the existing Postgres branch without reading configuration or a DB.
    monkeypatch.setattr(routes, "select_runtime_persistence_adapter",
        lambda *_args: SimpleNamespace(effective_backend=routes.PERSISTENCE_BACKEND_POSTGRES))


def assert_error(response, status, code):
    assert response.status_code == status
    data = json.loads(response.body)
    assert data.get("error_code", data.get("error")) == code
    assert {"private", "no-store"} <= {
        value.strip().lower() for value in response.headers.get("cache-control", "").split(",")}
    assert not {"artist_groups", "tracks", "sidebar", "artists_sidebar", "music_dir"} & data.keys()
    assert "synthetic-global-search-context-key" not in response.body.decode()
    return data


@pytest.mark.parametrize("query", FORMS)
@pytest.mark.parametrize("context", [None, "bad", "f" * 64])
def test_personal_tokens_require_matching_context_before_candidate_read(query, context):
    response = routes.view_data(make_request({"surface": "albums", "q": query}, context=context))
    assert_error(response, 409, "stale_context")


@pytest.mark.parametrize("query", FORMS)
def test_personal_dispatch_precedes_transient_scan_fallback(monkeypatch, query):
    # A missing-context request must return the real personal error even while
    # the legacy transient branch is eligible. The sentinel makes fallback
    # observable as a response, rather than an absent-module/setup failure.
    from starlette.responses import JSONResponse
    monkeypatch.setattr(routes, "_should_use_transient_scan_browse_state", lambda *_args: True)
    monkeypatch.setattr(routes, "_transient_scan_view_response",
        lambda *_args: JSONResponse({"tracks": [{"title": "Unfiltered scan sentinel"}]}, status_code=200))
    response = routes.view_data(make_request({"surface": "albums", "q": query}, context=None))
    assert_error(response, 409, "stale_context")


@pytest.mark.parametrize("query", FORMS)
def test_context_owner_failure_is_private_service_unavailable(query):
    response = routes.view_data(make_request({"surface": "albums", "q": query},
        context="a" * 64, valid_signing=False))
    assert_error(response, 503, "private_ui_context_unavailable")


@pytest.mark.parametrize("query", [
    ":loved Beatles", ":loved :tracks", ":loved @someone", ":loved year:2000",
    ":loved artist:Beatles", ":loved album:Abbey", "love:loved popularity:10",
])
def test_out_of_slice_personal_combinations_are_located_private_errors(query):
    response = routes.view_data(make_request({"surface": "albums", "q": query}))
    data = assert_error(response, 400, "unsupported_private_search_combination")
    assert isinstance(data["location"], dict)
    assert 0 <= data["location"]["start"] < data["location"]["end"] <= len(query)


@pytest.mark.parametrize("field,value", [
    ("search_page_size", "0"), ("search_page_size", "101"), ("search_page_size", "-1"),
    ("search_page_size", "1.0"), ("search_page_size", " 50"), ("search_page_size", "５０"),
    ("search_presentation", "albums,tracks"), ("search_presentation", "history"),
    ("gallery_page_size", "50"), ("gallery_cursor", "old-root-cursor"),
    ("payload_tier", "search_preview"), ("payload_tier", "sidebar"),
    ("account_id", "99"), ("library_id", "99"), ("owner_account_id", "99"),
    ("search_cursor", "../../private-invalid-cursor"),
    ("search_sidebar_cursor", "../../private-invalid-cursor"),
])
def test_invalid_scalars_and_foreign_scope_cannot_fall_back(field, value):
    response = routes.view_data(make_request({"surface": "albums", "q": ":loved", field: value}))
    assert_error(response, 400, "invalid_private_search_request")
    assert "../../private-invalid-cursor" not in response.body.decode()


@pytest.mark.parametrize("field,value", [
    ("q", ":obsessed"), ("surface", "albums"), ("artist", "Artist"),
    ("search_presentation", "tracks"), ("search_page_size", "50"),
    ("search_cursor", "opaque"), ("search_sidebar_cursor", "opaque"),
    ("omit_sidebar", "1"), ("all_artists", "1"), ("gallery_scope", "all"),
    ("gallery_display", "grid"), ("gallery_display_mode", "grid"),
    ("gallery_scale_percent", "100"), ("payload_tier", "full"),
    ("search_detail_album_ref", "opaque"),
])
def test_duplicate_scalar_parameters_are_rejected_even_when_values_agree(field, value):
    pairs = [("surface", "albums"), ("q", ":loved")]
    pairs = [(key, val) for key, val in pairs if key != field]
    pairs.extend([(field, value), (field, value)])
    assert_error(routes.view_data(make_request(pairs)), 400, "invalid_private_search_request")


@pytest.mark.parametrize("query", [":loved" + " " * 195, ":loved\x00", ":loved" + "é" * 195])
def test_query_limit_is_raw_unicode_codepoints_and_nul_is_rejected(query):
    assert_error(routes.view_data(make_request({"surface": "albums", "q": query})),
        400, "invalid_private_search_request")


@pytest.mark.parametrize("field,value", [
    ("artist", "Artist"), ("all_artists", "1"), ("search_sidebar_cursor", "opaque"),
    ("search_presentation", "albums"),
])
def test_detail_mode_rejects_main_result_selection_parameters(field, value):
    query = {"surface": "albums", "q": ":loved", "search_detail_album_ref": "inventory-album:73:1", field: value}
    assert_error(routes.view_data(make_request(query)), 400, "invalid_private_search_request")


@pytest.mark.parametrize("denial,status", [("anonymous", 401), ("inactive", 401), ("ungranted", 403)])
def test_real_middleware_denies_unauthenticated_or_ungranted_personal_reads(denial, status):
    current = (CurrentActor.anonymous() if denial == "anonymous" else
        replace(actor(), state=ActorState.INACTIVE) if denial == "inactive" else
        replace(actor(), capability_grants=()))
    app = FastAPI()
    app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"}
    app.state.auth_policy_config = HMAC
    app.state.library_state = {}
    app.state.current_actor_resolver = SimpleNamespace(resolve=lambda _token: current)
    app.include_router(routes.router)
    install_private_route_boundary(app)
    actual, headers, body = run_asgi_request(app, "GET", "/view-data", query={"surface": "albums", "q": ":loved"})
    assert actual == status
    assert headers["cache-control"] == "private, no-store"
    assert not {"tracks", "artist_groups", "sidebar"} & json.loads(body).keys()
