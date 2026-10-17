"""Additive Loose preference contracts at the existing /view-data owner.

Direct calls are route-function units. The composed tests use the actual router,
private middleware, actor-cache adapter and policy evaluator, with isolated
browse/inventory/taste repositories. Neither group is production-app startup,
authentication persistence, SQL, browser or end-to-end evidence. Normal config
imports and the existing ASGI harness are prerequisites; do not stub or bypass
them to obtain a test result.
"""

from copy import deepcopy
from dataclasses import replace
import json
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest
from fastapi import FastAPI
from starlette.requests import Request

from music_app.routes import api_read_asgi_routes as routes
from music_app.services import track_preferences
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
from music_app.services.library_inventory_postgres import PostgresLibraryInventoryRepository
from music_app.services.policy import ResourceScope
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import install_private_route_boundary


PATH = "/synthetic/loose-preference/one.flac"
OTHER_PATH = "/synthetic/loose-preference/two.flac"
UNREADABLE_PATH = "/synthetic/loose-preference/denied.flac"
CANONICAL = "track:loose-preference-one"
HMAC = {"hmac": {"secret": "synthetic-loose-preference-context-key-32-bytes", "key_version": 1}}
BROWSE = "library.browse.read"
MANAGE = "library.track_preferences.manage"


def actor(account_id=41, library_id=73):
    return CurrentActor(
        state=ActorState.ACTIVE, account_id=account_id, session_id=8,
        current_library_id=library_id,
        library_relationships=(LibraryRelationship(library_id, "member", False),),
        capability_grants=(CapabilityGrant(BROWSE, "library", library_id),),
    )


def row(path=PATH, **fields):
    # Real native Loose DTOs have a path and need not already contain track_id.
    return {"path": path, "title": "Same title", "artist": "Fixture Artist",
            "duration_seconds": 181, "year": 2024, "reason_label": "Unmarked", **fields}


def selected(path=PATH, track_id=101, canonical=CANONICAL, *, active=True, tier="off", rating=None):
    return {"track_id": track_id, "track_key": canonical, "track_ref": path,
            "is_active_path": active, "rating": rating, "love_tier": tier}


def candidate(path=PATH, track_id=101):
    # This is the existing inventory repository's result shape, not a new DTO.
    return {"track_id": track_id, "private_path": path, "track_key": CANONICAL,
            "track_title": "Same title"}


def stale_row(path=PATH):
    stale = {"rating": 5, "love_tier": "obsessed", "allowed_actions": {
        "can_rate": True, "can_set_love_tier": True, "client_surface_class": "web"}}
    return row(path, track_preference_state="available", track_preference=deepcopy(stale),
               track_preference_overlay=deepcopy(stale), can_edit_preferences=True,
               canonical_track_ref="track:stale-other-actor",
               inventory_track_ref="inventory-track:999:999")


@pytest.fixture
def harness(monkeypatch):
    """Only producer/repository I/O seams are isolated; policy stays real."""
    state = SimpleNamespace(
        current=actor(), inventory_library=73, candidates=[candidate()],
        selections={PATH: selected()}, payload={"non_album_tracks": [row()],
            "artist_groups": [], "artists_sidebar": [], "marker": {"keep": [1, 2]}},
        calls=[], contexts=[], unreadable_ids=set(), read_only_ids=set(),
        library_state={"albums": [], "scan_in_progress": False},
    )

    def constraints(context):
        state.contexts.append(context)
        state.calls.append(("policy", context.action, context.resource))
        denied = (
            context.resource is not None and context.resource.resource_kind == "track"
            and ((context.action == BROWSE and context.resource.resource_ref in state.unreadable_ids)
                 or (context.action == MANAGE and context.resource.resource_ref in state.read_only_ids))
        )
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)

    def producer(name):
        def build(_repository, **_kwargs):
            state.calls.append(("producer", name))
            return state.payload  # Deliberately shared to expose cache mutation.
        return build

    for method in (
        "build_root_startup_preview_payload", "build_root_sidebar_payload",
        "build_selected_artist_payload", "build_search_payload", "build_root_album_browse_payload",
    ):
        monkeypatch.setattr(PostgresLibraryBrowseRepository, method, producer(method))

    def fallback(**_kwargs):
        state.calls.append(("producer", "build_view_payload"))
        return state.payload

    def transient_page(payload, _params, **_kwargs):
        state.calls.append(("producer", "build_transient_root_gallery_page"))
        return payload

    def inventory_library(_repository):
        state.calls.append(("inventory_library",))
        return state.inventory_library

    def inventory_candidates(_repository, *, private_paths=None, limit=1000, **kwargs):
        paths = list(private_paths or ())
        assert paths, "Empty paths would turn the real repository call into an unrestricted inventory query"
        assert len(paths) == len(set(paths))
        assert len(paths) <= limit <= 5000
        assert not kwargs.get("track_ids"), "Displayed paths, not a broad ID query, own this read"
        state.calls.append(("inventory", paths, limit))
        return deepcopy(state.candidates)

    def taste(_store, refs, *, account_id, library_id):
        paths = list(refs)
        state.calls.append(("taste", paths, account_id, library_id))
        assert paths and len(paths) == len(set(paths))
        assert len(paths) <= 5000
        # Return only requested values, as the real store does. A fixture must
        # not mask a missing read by returning a preselected global dictionary.
        return deepcopy({path: state.selections[path] for path in paths if path in state.selections})

    monkeypatch.setattr(routes, "build_view_payload", fallback)
    monkeypatch.setattr(routes, "build_transient_root_gallery_page", transient_page)
    monkeypatch.setattr(routes, "_hydrate_cached_library_for_asgi", lambda _request: None)
    monkeypatch.setattr(routes, "_log_view_data_request_from_asgi", lambda *_args: None)
    monkeypatch.setattr(routes, "log_app_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(routes, "select_runtime_persistence_adapter",
                        lambda *_args: SimpleNamespace(effective_backend=routes.PERSISTENCE_BACKEND_POSTGRES))
    monkeypatch.setattr(PostgresLibraryInventoryRepository, "load_inventory_library_id", inventory_library)
    monkeypatch.setattr(PostgresLibraryInventoryRepository, "load_non_album_candidates", inventory_candidates)
    monkeypatch.setattr(track_preferences.PostgresTrackPreferencesStore, "load_track_preferences", taste)
    # Same ordinary unit seam as test_album_preference_receipts.py. It does not
    # replace config.py or bypass module imports, and makes no persistence claim.
    monkeypatch.setattr(track_preferences, "_require_postgres_track_preferences_selection", lambda _config: None)
    state.constraints = constraints
    return state


def request_for(state, query=None, *, include_actor=True):
    app = SimpleNamespace(state=SimpleNamespace(
        config={"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"},
        auth_policy_config=deepcopy(HMAC), library_state=state.library_state,
        policy_constraint_resolver=state.constraints,
    ))
    return Request({"type": "http", "method": "GET", "path": "/view-data", "app": app,
        "state": {"current_actor": state.current} if include_actor else {}, "scheme": "https",
        "client": ("192.0.2.10", 50000), "server": ("music.test", 443),
        "query_string": urlencode({"surface": "albums"} if query is None else query).encode(), "headers": []})


def read(state, query=None):
    response = routes.view_data(request_for(state, query))
    assert response.status_code == 200
    return json.loads(response.body)


def calls(state, kind):
    return [call for call in state.calls if call[0] == kind]


def assert_available(value, *, tier="off", canonical=CANONICAL, track_id=101, library_id=73, editable=True):
    assert value["track_preference_state"] == "available"
    assert value["canonical_track_ref"] == canonical
    assert value["inventory_track_ref"] == f"inventory-track:{library_id}:{track_id}"
    assert value["track_preference"]["love_tier"] == tier
    assert value["track_preference"]["allowed_actions"]["can_set_love_tier"] is editable
    assert value["track_preference"]["allowed_actions"]["can_rate"] is editable
    assert value["can_edit_preferences"] is editable


def assert_unknown(value):
    assert value["track_preference_state"] == "unavailable"
    assert value.get("canonical_track_ref") is None
    assert value.get("inventory_track_ref") is None
    assert value["can_edit_preferences"] is False
    assert value["track_preference"]["allowed_actions"]["can_set_love_tier"] is False
    assert value["track_preference"]["allowed_actions"]["can_rate"] is False
    assert value["track_preference"]["rating"] is None
    assert value["track_preference"]["love_tier"] == "off"
    # A neutral overlay is fine; an old private overlay must not survive.
    if "track_preference_overlay" in value:
        assert value["track_preference_overlay"]["love_tier"] == "off"
        assert value["track_preference_overlay"]["allowed_actions"]["can_set_love_tier"] is False


@pytest.mark.parametrize("tier,rating", [("off", None), ("loved", 4), ("obsessed", 5)])
def test_route_unit_projects_guarded_selection_without_mutating_shared_payload(harness, tier, rating):
    harness.payload["non_album_tracks"] = [stale_row()]
    harness.selections[PATH] = selected(tier=tier, rating=rating)
    before = deepcopy(harness.payload)
    result = read(harness)
    assert_available(result["non_album_tracks"][0], tier=tier)
    assert result["non_album_tracks"][0]["track_preference"]["rating"] == rating
    assert harness.payload == before
    assert result["marker"] == before["marker"]
    assert calls(harness, "taste") == [("taste", [PATH], 41, 73)]
    assert calls(harness, "inventory_library") == [("inventory_library",)]
    assert calls(harness, "inventory")[0][1] == [PATH]


def test_route_unit_reads_each_actor_independently_and_reuses_no_cached_taste(harness):
    before = deepcopy(harness.payload)
    first = read(harness)
    harness.current = actor(account_id=42)
    harness.selections[PATH] = selected(tier="obsessed")
    second = read(harness)
    assert_available(first["non_album_tracks"][0], tier="off")
    assert_available(second["non_album_tracks"][0], tier="obsessed")
    assert calls(harness, "taste") == [("taste", [PATH], 41, 73), ("taste", [PATH], 42, 73)]
    assert harness.payload == before


def test_route_unit_current_library_scope_is_used_in_lookup_and_receipt(harness):
    harness.current = actor(account_id=42, library_id=74)
    harness.inventory_library = 74
    result = read(harness)
    assert_available(result["non_album_tracks"][0], library_id=74)
    assert calls(harness, "taste") == [("taste", [PATH], 42, 74)]
    relevant = [context for context in harness.contexts if context.resource == ResourceScope("track", "101")]
    assert {context.action for context in relevant} == {BROWSE, MANAGE}
    assert all(context.actor is harness.current and context.library_id == 74 for context in relevant)


@pytest.mark.parametrize("tier", ["off", "loved", "obsessed"])
def test_route_unit_read_only_receipt_keeps_known_tier_and_uses_exact_manage_resource(harness, tier):
    harness.read_only_ids = {"101"}
    harness.selections[PATH] = selected(tier=tier)
    result = read(harness)
    assert_available(result["non_album_tracks"][0], tier=tier, editable=False)
    relevant = [context for context in harness.contexts if context.action == MANAGE]
    assert relevant and all(context.resource == ResourceScope("track", "101") for context in relevant)
    assert all(context.actor is harness.current and context.library_id == 73 for context in relevant)


def test_route_unit_browse_denial_excludes_path_before_any_personal_read(harness):
    harness.payload["non_album_tracks"] = [stale_row(UNREADABLE_PATH), row()]
    harness.candidates = [candidate(UNREADABLE_PATH, 102), candidate()]
    harness.selections[UNREADABLE_PATH] = selected(UNREADABLE_PATH, 102, tier="obsessed")
    harness.unreadable_ids = {"102"}
    result = read(harness)
    assert_unknown(result["non_album_tracks"][0])
    assert_available(result["non_album_tracks"][1])
    assert calls(harness, "taste") == [("taste", [PATH], 41, 73)]
    personal_index = next(index for index, event in enumerate(harness.calls) if event[0] == "taste")
    assert ("policy", BROWSE, ResourceScope("track", "101")) in harness.calls[:personal_index]
    assert ("policy", BROWSE, ResourceScope("track", "102")) in harness.calls[:personal_index]
    assert not any(context.action == MANAGE and context.resource == ResourceScope("track", "102")
                   for context in harness.contexts)


@pytest.mark.parametrize("inventory_library", [None, True, 74])
def test_route_unit_inventory_library_mismatch_cannot_read_personal_taste(harness, inventory_library):
    harness.inventory_library = inventory_library
    harness.payload["non_album_tracks"] = [stale_row()]
    assert_unknown(read(harness)["non_album_tracks"][0])
    assert calls(harness, "taste") == []


@pytest.mark.parametrize("candidates", [
    [], [candidate(track_id=102)], [candidate(), candidate(track_id=102)],
    [candidate(track_id=True)], [candidate(track_id=None)], [candidate(track_id="101")],
])
def test_route_unit_unresolved_or_conflicting_inventory_never_reaches_taste(harness, candidates):
    harness.payload["non_album_tracks"] = [row(track_id=101)]
    harness.candidates = candidates
    assert_unknown(read(harness)["non_album_tracks"][0])
    assert calls(harness, "taste") == []


@pytest.mark.parametrize("selection", [
    {}, {PATH: selected(track_id=102)}, {PATH: selected(active=False)},
    {PATH: selected(canonical="")}, {PATH: selected(canonical=None)},
    {PATH: selected(canonical=101)}, {PATH: selected(track_id=True)},
])
def test_route_unit_missing_or_unguarded_selection_is_unknown_not_known_off(harness, selection):
    harness.payload["non_album_tracks"] = [stale_row()]
    harness.selections = selection
    assert_unknown(read(harness)["non_album_tracks"][0])
    assert calls(harness, "taste") == [("taste", [PATH], 41, 73)]


def test_route_unit_filters_unresolved_paths_instead_of_omitting_expected_id_entries(harness):
    harness.payload["non_album_tracks"] = [row(), stale_row(OTHER_PATH)]
    harness.selections[OTHER_PATH] = selected(OTHER_PATH, 777, "track:unresolved-trap", tier="obsessed")
    result = read(harness)["non_album_tracks"]
    assert_available(result[0])
    assert_unknown(result[1])
    assert calls(harness, "taste") == [("taste", [PATH], 41, 73)]


def test_route_unit_repeated_display_aliases_share_one_guarded_lookup(harness):
    harness.payload["non_album_tracks"] = [row(track_id=101), row(), row(track_id=101)]
    result = read(harness)["non_album_tracks"]
    assert len(result) == 3
    for value in result:
        assert_available(value)
    assert calls(harness, "taste") == [("taste", [PATH], 41, 73)]


def test_route_unit_conflicting_alias_identity_denies_every_alias_but_keeps_other_rows(harness):
    harness.payload["non_album_tracks"] = [row(track_id=101), row(OTHER_PATH), row(track_id=102)]
    harness.candidates.append(candidate(OTHER_PATH, 103))
    harness.selections[OTHER_PATH] = selected(OTHER_PATH, 103, "track:second-distinct", tier="loved")
    result = read(harness)["non_album_tracks"]
    assert [value["path"] for value in result] == [PATH, OTHER_PATH, PATH]
    assert_unknown(result[0])
    assert_unknown(result[2])
    assert_available(result[1], tier="loved", canonical="track:second-distinct", track_id=103)
    assert calls(harness, "taste") == [("taste", [OTHER_PATH], 41, 73)]


def test_route_unit_same_title_distinct_paths_keep_distinct_identity_and_taste(harness):
    harness.payload["non_album_tracks"] = [row(OTHER_PATH), row()]
    harness.candidates.append(candidate(OTHER_PATH, 103))
    harness.selections[OTHER_PATH] = selected(OTHER_PATH, 103, "track:second-distinct", tier="obsessed")
    result = read(harness)["non_album_tracks"]
    assert [value["path"] for value in result] == [OTHER_PATH, PATH]
    assert_available(result[0], tier="obsessed", canonical="track:second-distinct", track_id=103)
    assert_available(result[1])


@pytest.mark.parametrize("rows", [[], [stale_row("")], [stale_row("   ")]])
def test_route_unit_empty_paths_do_not_trigger_unrestricted_inventory_or_taste(harness, rows):
    harness.payload["non_album_tracks"] = rows
    result = read(harness)["non_album_tracks"]
    assert len(result) == len(rows)
    for value in result:
        assert_unknown(value)
    assert calls(harness, "inventory") == []
    assert calls(harness, "taste") == []


def test_route_unit_over_5000_distinct_display_paths_remain_unknown_without_population_loss(harness):
    harness.payload["non_album_tracks"] = [stale_row(f"/synthetic/loose-overflow/{index}.flac")
                                           for index in range(5001)]
    before = deepcopy(harness.payload)
    result = read(harness)["non_album_tracks"]
    assert [value["path"] for value in result] == [value["path"] for value in before["non_album_tracks"]]
    for value in result:
        assert_unknown(value)
    assert calls(harness, "inventory") == []
    assert calls(harness, "taste") == []
    assert harness.payload == before


def test_route_unit_exactly_5000_display_paths_have_complete_bounded_resolution(harness):
    paths = [f"/synthetic/loose-boundary/{index}.flac" for index in range(5000)]
    harness.payload["non_album_tracks"] = [row(path) for path in paths]
    harness.candidates = [candidate(path, index + 101) for index, path in enumerate(paths)]
    harness.selections = {path: selected(path, index + 101, f"track:boundary-{index}")
                          for index, path in enumerate(paths)}
    result = read(harness)["non_album_tracks"]
    assert [value["path"] for value in result] == paths
    for index, value in enumerate(result):
        assert_available(value, canonical=f"track:boundary-{index}", track_id=index + 101)
    assert len(calls(harness, "inventory")) == 1
    assert calls(harness, "inventory")[0][2] == 5000
    assert len(calls(harness, "taste")) == 1
    assert set(calls(harness, "taste")[0][1]) == set(paths)


def test_route_unit_projection_does_not_walk_other_nested_representations(harness):
    # Album representations have separate owners. Only the actual
    # top-level non_album_tracks population participates in this projection.
    subject = stale_row(OTHER_PATH)
    harness.payload["artist_groups"] = [{"artist": "Other", "albums": [{"tracks": [subject]}]}]
    before = deepcopy(harness.payload)
    result = read(harness)
    assert_available(result["non_album_tracks"][0])
    assert result["artist_groups"] == before["artist_groups"]
    assert harness.payload == before
    assert calls(harness, "taste") == [("taste", [PATH], 41, 73)]


@pytest.mark.parametrize("source_fields", [
    {"read_only_subject": True},
    {"source_readable": False},
    {"allowed_actions": {"can_read": False}},
])
def test_route_unit_subject_or_unreadable_source_cannot_obtain_own_preference(harness, source_fields):
    # These are existing native source-container guards (the Album read owner
    # and NativePlaytables already enforce them), not new endpoint parameters.
    harness.payload.update(deepcopy(source_fields))
    harness.payload["non_album_tracks"] = [stale_row()]
    before = deepcopy(harness.payload)
    result = read(harness)
    assert_unknown(result["non_album_tracks"][0])
    assert result["non_album_tracks"][0]["title"] == before["non_album_tracks"][0]["title"]
    for key, value in source_fields.items():
        assert result[key] == value
    assert calls(harness, "taste") == []
    assert harness.payload == before


def test_route_unit_subject_row_is_excluded_while_unrelated_own_sibling_enriches(harness):
    subject = stale_row(OTHER_PATH)
    subject["read_only_subject"] = True
    harness.payload["non_album_tracks"] = [subject, row()]
    harness.candidates.append(candidate(OTHER_PATH, 103))
    harness.selections[OTHER_PATH] = selected(OTHER_PATH, 103, "track:subject-copy", tier="loved")
    before = deepcopy(harness.payload)
    result = read(harness)["non_album_tracks"]
    assert [value["path"] for value in result] == [OTHER_PATH, PATH]
    assert result[0]["read_only_subject"] is True
    assert_unknown(result[0])
    assert_available(result[1])
    assert calls(harness, "taste") == [("taste", [PATH], 41, 73)]
    assert harness.payload == before


PRODUCER_CASES = [
    pytest.param({"gallery_page_size": "50"}, "build_root_startup_preview_payload", False, id="root-startup-page"),
    pytest.param({"gallery_page_size": "50", "gallery_cursor": "synthetic-cursor"},
                 "build_root_startup_preview_payload", False, id="root-next-page"),
    pytest.param({"payload_tier": "full", "gallery_page_size": "50"},
                 "build_root_startup_preview_payload", False, id="root-full-page"),
    pytest.param({"payload_tier": "sidebar"}, "build_root_sidebar_payload", False, id="root-sidebar"),
    pytest.param({"artist": "Fixture Artist"}, "build_selected_artist_payload", False, id="selected-artist"),
    pytest.param({"q": "Fixture"}, "build_search_payload", False, id="search"),
    pytest.param({}, "build_root_album_browse_payload", False, id="root-full"),
    pytest.param({}, "build_view_payload", True, id="transient"),
    pytest.param({"gallery_page_size": "50"}, "build_transient_root_gallery_page", True, id="transient-page"),
    pytest.param({"surface": "library"}, "build_view_payload", False, id="ordinary-fallback"),
]


def enable_transient(state):
    state.library_state.update(scan_in_progress=True, scan_generation=1,
        active_scan_preview_state={"scan_generation": 1, "publication_state": {},
            "browse_snapshot": {"albums": [{"key": "transient"}], "file_cache": {}, "separate_release_keys": set()}})


@pytest.mark.parametrize("query,producer,transient", PRODUCER_CASES)
def test_route_unit_every_ordinary_producer_enters_request_local_projection(harness, query, producer, transient):
    if transient:
        enable_transient(harness)
    before = deepcopy(harness.payload)
    result = read(harness, {"surface": "albums", **query})
    assert ("producer", producer) in calls(harness, "producer")
    assert_available(result["non_album_tracks"][0])
    assert calls(harness, "taste") == [("taste", [PATH], 41, 73)]
    assert harness.payload == before


def composed_app(state):
    app = FastAPI()
    app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"}
    app.state.auth_policy_config = deepcopy(HMAC)
    app.state.library_state = state.library_state
    app.state.policy_constraint_resolver = state.constraints

    def resolve(token):
        state.calls.append(("actor", token))
        return state.current

    app.state.current_actor_resolver = SimpleNamespace(resolve=resolve)
    app.include_router(routes.router)
    install_private_route_boundary(app)
    return app


def asgi_get(app, query):
    # Keep the repository's established harness as a prerequisite. Importing it
    # here lets direct units collect without inventing a replacement harness.
    from tests.py.asgi_testing import run_asgi_request
    return run_asgi_request(app, "GET", "/view-data", query=query,
        headers={"cookie": "__Host-album_haven_session=" + "s" * 43})


def assert_private(headers):
    assert {"private", "no-store"} <= {part.strip().casefold()
                                        for part in headers["cache-control"].split(",")}


@pytest.mark.parametrize("query,producer,transient", PRODUCER_CASES)
def test_composed_route_all_ordinary_producers_use_authenticated_context_and_private_headers(
    harness, query, producer, transient,
):
    if transient:
        enable_transient(harness)
    status, headers, body = asgi_get(composed_app(harness), {"surface": "albums", **query})
    assert status == 200
    assert_private(headers)
    assert_available(json.loads(body)["non_album_tracks"][0])
    assert ("producer", producer) in calls(harness, "producer")
    assert calls(harness, "actor") == [("actor", "s" * 43)]
    assert calls(harness, "taste") == [("taste", [PATH], 41, 73)]
    assert all(context.actor is harness.current for context in harness.contexts)


@pytest.mark.parametrize("current,status", [
    (CurrentActor.anonymous(), 401),
    (replace(actor(), state=ActorState.INACTIVE), 401),
    (replace(actor(), capability_grants=()), 403),
    (replace(actor(), library_relationships=()), 403),
])
@pytest.mark.parametrize("query", [{"surface": "albums"}, {"surface": "library"},
                                  {"surface": "albums", "payload_tier": "sidebar"}])
def test_composed_route_auth_denials_are_private_before_producer_or_personal_read(harness, current, status, query):
    harness.current = current
    actual, headers, _body = asgi_get(composed_app(harness), query)
    assert actual == status
    assert_private(headers)
    assert calls(harness, "producer") == []
    assert calls(harness, "inventory") == []
    assert calls(harness, "taste") == []


def test_composed_route_track_browse_denial_still_returns_private_unknown_row(harness):
    harness.unreadable_ids = {"101"}
    harness.payload["non_album_tracks"] = [stale_row()]
    status, headers, body = asgi_get(composed_app(harness), {"surface": "albums"})
    assert status == 200
    assert_private(headers)
    assert_unknown(json.loads(body)["non_album_tracks"][0])
    assert calls(harness, "taste") == []


@pytest.mark.parametrize("current", [
    replace(actor(), is_bootstrap_owner=True, library_relationships=()),
    replace(actor(), is_bootstrap_owner=True, current_library_id=None),
    replace(actor(), is_bootstrap_owner=True, account_id=True),
])
def test_composed_route_bootstrap_permission_cannot_replace_explicit_preference_scope(harness, current):
    # The normal policy allows the bootstrap owner. The stronger personal scope
    # check must still require a typed account and current library membership.
    harness.current = current
    status, headers, _body = asgi_get(composed_app(harness), {"surface": "albums"})
    assert status == 403
    assert_private(headers)
    assert calls(harness, "taste") == []


def test_composed_route_personal_scope_revocation_is_private_and_emits_no_receipt(harness, monkeypatch):
    from music_app.services.track_preferences_postgres import TrackPreferenceScopeError

    def revoked(_store, _refs, **_scope):
        raise TrackPreferenceScopeError("Track preference scope is unavailable.")

    monkeypatch.setattr(track_preferences.PostgresTrackPreferencesStore, "load_track_preferences", revoked)
    status, headers, body = asgi_get(composed_app(harness), {"surface": "albums"})
    assert status == 403
    assert_private(headers)
    payload = json.loads(body)
    assert "non_album_tracks" not in payload
    assert "canonical_track_ref" not in body.decode()


@pytest.mark.parametrize("surface", ["album_tops", "playlists"])
def test_composed_route_separate_top_and_playlist_dispatch_never_uses_loose_taste(harness, surface):
    app = composed_app(harness)
    # A Playlist service unit seam keeps the genuine existing route dispatcher
    # and context handling. No alternate /view-data handler is registered.
    subject_row = {"title": "Subject track", "track_preference": {"love_tier": "obsessed"}}
    app.state.owned_playlists_service = SimpleNamespace(read=lambda *_args, **_kwargs: {
        "playlist_detail": {"tracks": [deepcopy(subject_row)]}})
    status, headers, body = asgi_get(app, {"surface": surface})
    assert status == 200
    assert_private(headers)
    payload = json.loads(body)
    assert payload["non_album_tracks"] == []
    if surface == "playlists":
        assert payload["playlist_detail"]["tracks"] == [subject_row]
    assert calls(harness, "producer") == []
    assert calls(harness, "inventory_library") == []
    assert calls(harness, "inventory") == []
    assert calls(harness, "taste") == []
