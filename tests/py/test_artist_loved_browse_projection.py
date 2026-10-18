"""Exact browse receipt capture, staged projection and private response boundaries.

Scripted SQL tests assert orchestration only. The live tests below use unchanged
isolated PostgreSQL fixtures and real current authority, policy and root reads.
No source extraction/exec, import substitution, schema repair or fixture changes.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import FrozenInstanceError, replace
import inspect
import json
from types import SimpleNamespace

import psycopg
import pytest
from fastapi import FastAPI, Request

from music_app.routes import api_read_asgi_routes as routes
from music_app.services import library_browse_postgres as browse
from music_app.services import admin_member_mutation_postgres as sessions
from music_app.services import private_library_authority as authority
from music_app.services.capabilities import capability_keys_for_roles
from music_app.services.policy_evaluator import PolicyEvaluationConstraints, PolicyEvaluator
from music_app.services.private_ui_context import private_ui_context_ref
from music_app.services.private_route_boundary import install_private_route_boundary
from tests.py.owned_playlist_testing import Connection, Step, context, LIBRARY, NOW
from tests.py.test_library_mix_route_boundary import Harness, Owner, Resolver
from library_mix_postgres_support import mix_db, mix_urls
from tests.py.test_artist_loved_persistence_live import loved_db, add_artist, set_aliases

REF = "a" * 64
NAME = "Canonical Artist"
KEY = browse.local_inventory_identity_key(NAME)
ROOT = 9007199254740993
GROUP_FIELDS = ("artist_groups", "primary_artist_groups", "family_artist_groups",
                "related_filter_base_primary_groups", "related_filter_base_family_groups")
BROWSE = "library.browse.read"
CREATE = "library.playlists.create"


def aliases():
    return {"alias_to_canonical": {"Alias": NAME},
            "canonical_to_aliases": {NAME: ["Alias"]}}


def row(identity=ROOT):
    return {"id": identity, "name": NAME, "artist_key": KEY}


def connection(steps=()):
    con = Connection(steps)
    con.autocommit = False
    return con


def receipt(target, kind="group", **changes):
    values = dict(target=target, target_kind=kind, inventory_library_id=LIBRARY,
                  root_artist_id=ROOT, root_artist_key=KEY, artist_ref=NAME,
                  original_alias="Alias")
    return browse.ArtistLovedBrowseRootReceipt(**{**values, **changes})


def copied_payload():
    group = {"artist": NAME, "albums": [], "artist_scope": {"artist_ids": [777]}}
    page = {"artist_ref": NAME, "gallery_payload": {"albums": []}}
    original = {"artist_groups": [group], "primary_artist_groups": [group],
                "artist_page": page, "legacy": {"unchanged": True}}
    memo = {}
    return original, deepcopy(original, memo), memo, [receipt(group), receipt(page, "page")]


def launch(mode="artist", identity=ROOT):
    return {"context_ref": REF, "artist_ref": NAME,
            "descriptor": {"version": 1, "root_artist_id": str(identity), "scope_mode": mode}}


@pytest.fixture
def io(monkeypatch):
    calls = []
    def relation(con, library):
        calls.append((con, library))
        return aliases()
    monkeypatch.setattr(browse, "load_current_library_relation_alias_maps", relation)
    session_calls = []
    def lock(con, **kwargs):
        session_calls.append((con, kwargs))
        return NOW
    monkeypatch.setattr(sessions, "lock_current_actor_session", lock)
    return SimpleNamespace(alias_calls=calls, session_calls=session_calls)


def project(con, payload, memo, receipts, *, supplied=None, constraints=None):
    return browse.project_artist_loved_browse_launches(con,
        context=supplied or context(grants=(BROWSE, CREATE)), constraints=constraints,
        context_ref=REF, receipts=receipts, payload=payload, copy_memo=memo, clock=lambda: NOW)


def test_capture_records_exact_producing_object_and_bigint_without_payload_fields(io):
    target = {"artist": NAME, "artist_display": "Cosmetic alias", "albums": [],
              "artist_scope": {"artist_ids": [777]}}
    before = deepcopy(target)
    con = connection([Step("app.bootstrap_owners", [{"library_id": LIBRARY}]),
        Step("artist_key=any", [row()], (LIBRARY, [KEY]))])
    collected = []
    browse._capture_artist_loved_browse_roots(con,
        targets=[(target, "group", NAME, "Alias")], collector=collected)
    con.done()
    assert len(collected) == 1 and collected[0].target is target
    assert collected[0].root_artist_id == ROOT and collected[0].root_artist_key == KEY
    assert collected[0].inventory_library_id == LIBRARY and collected[0].original_alias == "Alias"
    assert target == before and json.loads(json.dumps(target)) == before
    with pytest.raises(FrozenInstanceError):
        collected[0].root_artist_id = 777


@pytest.mark.parametrize("rows", [[], [row(), row()], [dict(row(), id=True)],
    [dict(row(), id=2**63)], [dict(row(), name="Other")],
    [{"id": 777, "name": "Alias", "artist_key": "alias"}]])
def test_capture_never_falls_back_to_alias_or_first_row(io, rows):
    con = connection([Step("app.bootstrap_owners", [{"library_id": LIBRARY}]),
                      Step("artist_key=any", rows)])
    found = []
    browse._capture_artist_loved_browse_roots(con,
        targets=[({"artist": NAME}, "group", NAME, "Alias")], collector=found)
    assert found == []
    con.done()


@pytest.mark.parametrize("state", [
    {"alias_to_canonical": {"Alias": NAME, " alias ": "Other"}, "canonical_to_aliases": {NAME: ["Alias"]}},
    {"alias_to_canonical": {"Alias": "Other"}, "canonical_to_aliases": {NAME: ["Alias"]}},
    {"alias_to_canonical": {}, "canonical_to_aliases": {NAME: "malformed"}},
    {**aliases(), "projection_stale_reason": "stale"},
])
def test_capture_ambiguous_or_conflicting_alias_is_unavailable(monkeypatch, state):
    monkeypatch.setattr(browse, "load_current_library_relation_alias_maps", lambda *a: state)
    con = connection([Step("app.bootstrap_owners", [{"library_id": LIBRARY}])])
    found = []
    browse._capture_artist_loved_browse_roots(con,
        targets=[({"artist": NAME}, "group", NAME, "Alias")], collector=found)
    assert found == []
    con.done()


@pytest.mark.parametrize("libraries", [[], [{"library_id": LIBRARY}, {"library_id": LIBRARY + 1}],
                                       [{"library_id": True}]])
def test_capture_requires_one_real_inventory_library(libraries):
    con = connection([Step("app.bootstrap_owners", libraries)])
    found = []
    browse._capture_artist_loved_browse_roots(con,
        targets=[({}, "page", NAME, None)], collector=found)
    assert found == []
    con.done()


def test_capture_many_groups_is_two_queries_and_one_alias_load(io):
    targets = [({"artist": NAME, "albums": []}, "group", NAME, "Alias") for _ in range(300)]
    con = connection([Step("app.bootstrap_owners", [{"library_id": LIBRARY}]),
                      Step("artist_key=any", [row()], (LIBRARY, [KEY]))])
    found = []
    browse._capture_artist_loved_browse_roots(con, targets=targets + targets, collector=found)
    assert len(found) == 300 and len(con.operations) == 2 and len(io.alias_calls) == 1
    con.done()


def test_project_is_staged_and_deepcopy_memo_preserves_shared_target(io):
    original, copied, memo, found = copied_payload()
    before = deepcopy(copied)
    con = connection([Step("id=any", [row()], (LIBRARY, [ROOT]), clauses=("for share",))])
    staged = project(con, copied, memo, found)
    assert copied == before and original == before
    assert len(staged) == 2 and staged[0][0] is copied["artist_groups"][0]
    assert staged[0][0] is copied["primary_artist_groups"][0]
    assert staged[0][1:] == ("artist_loved_launch", launch())
    assert staged[1][0] is copied["artist_page"]
    assert staged[1][1:] == ("artist_loved_launches", {"artist": launch(), "family": launch("family")})
    assert len(io.alias_calls) == 1 and len(io.session_calls) == 1
    assert io.session_calls[0][1]["actor_session_id"] == context().actor.session_id
    con.done()


@pytest.mark.parametrize("case", ["equal_unrelated", "missing_memo", "renamed", "wrong_library", "sidebar"])
def test_projection_requires_exact_producer_target_not_equal_display(io, case):
    original, copied, memo, found = copied_payload()
    found = found[:1]
    if case == "equal_unrelated":
        found = [receipt(deepcopy(original["artist_groups"][0]))]
    elif case == "missing_memo": memo = {}
    elif case == "renamed": copied["artist_groups"][0]["artist"] = "Combined name"
    elif case == "wrong_library": found = [replace(found[0], inventory_library_id=LIBRARY + 1)]
    else:
        copied = {"artists_sidebar": copied["artist_groups"]}
    con = connection()
    assert project(con, copied, memo, found) == []
    con.done()


@pytest.mark.parametrize("rows", [[], [row(ROOT + 1)], [dict(row(), artist_key="other")]])
def test_current_id_cannot_rebind_replacement_with_same_name(io, rows):
    _, copied, memo, found = copied_payload()
    con = connection([Step("id=any", rows, (LIBRARY, [ROOT]))])
    assert project(con, copied, memo, found) == []
    con.done()


def test_final_root_policy_recheck_after_wait_can_remove_launch(io):
    _, copied, memo, found = copied_payload()
    calls = []
    def constraints(ctx):
        if ctx.resource is not None:
            calls.append(ctx.resource.resource_ref)
        return PolicyEvaluationConstraints(deployment_allowed=len(calls) <= 2)
    con = connection([Step("id=any", [row()])])
    assert project(con, copied, memo, found, constraints=constraints) == []
    assert calls == [str(ROOT)] * 4


def test_browse_intrinsically_allows_create_without_separate_grant(io):
    supplied = context(grants=(BROWSE,))
    assert PolicyEvaluator().evaluate(replace(supplied, action=CREATE)).decision.allowed
    _, copied, memo, found = copied_payload()
    con = connection([Step("id=any", [row()])])
    assert len(project(con, copied, memo, found, supplied=supplied)) == 2
    con.done()


def test_create_narrowing_denied_by_real_policy_before_root_query(io):
    _, copied, memo, found = copied_payload()
    con = connection()
    seen = []
    def constraints(ctx):
        seen.append(ctx.action)
        return PolicyEvaluationConstraints(request_origin_allowed=ctx.action != CREATE)
    with pytest.raises(authority.PrivateLibraryAuthorityError):
        project(con, copied, memo, found, supplied=context(grants=(BROWSE,)),
                constraints=constraints)
    assert seen == [BROWSE, CREATE]
    con.done()


def test_viewer_library_grants_admit_launch_without_media(io):
    supplied = context(grants=capability_keys_for_roles(("viewer",)))
    assert PolicyEvaluator().evaluate(replace(supplied, action=CREATE)).decision.allowed
    assert not PolicyEvaluator().evaluate(replace(supplied, action="library.media.read")).decision.allowed
    _, copied, memo, found = copied_payload()
    con = connection([Step("id=any", [row()])])
    assert len(project(con, copied, memo, found, supplied=supplied)) == 2


def test_page_with_no_filtered_albums_still_gets_both_intents(io):
    _, copied, memo, found = copied_payload()
    copied["artist_groups"].clear()
    copied["primary_artist_groups"].clear()
    con = connection([Step("id=any", [row()])])
    staged = project(con, copied, memo, found)
    assert len(staged) == 1 and staged[0][0] is copied["artist_page"]
    assert staged[0][2] == {"artist": launch(), "family": launch("family")}


def stale_payload():
    return {**{field: [{"artist": NAME, "artist_loved_launch": launch()}] for field in GROUP_FIELDS},
            "artist_page": {"artist_ref": NAME, "artist_loved_launches": {"artist": launch()}},
            "artists_sidebar": [{"artist": NAME, "artist_loved_launch": launch()}],
            "artist_loved_context_ref": REF, "legacy": {"kept": 17}}


def assert_cleared(body):
    assert body["artist_loved_context_ref"] is None
    for field in GROUP_FIELDS:
        assert all(group["artist_loved_launch"] is None for group in body[field])
    assert body["artist_page"]["artist_loved_launches"] == {"artist": None, "family": None}
    assert "artist_loved_launch" not in body["artists_sidebar"][0]
    assert body["legacy"] == {"kept": 17}


@pytest.fixture
def mounted(monkeypatch):
    """Real private middleware with a test-only mounted finalizer seam.

    This tests the finalizer/middleware, not production /view-data dispatch.
    The mount adds no product route and replaces no authentication or policy.
    """
    app = FastAPI()
    app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"}
    app.state.auth_policy_config = {"hmac": {"secret": "synthetic-route-origin-and-context-key-32", "key_version": 1}}
    resolver = Resolver(context(grants=(BROWSE, CREATE)).actor)
    app.state.current_actor_resolver = resolver
    app.state.policy_constraint_resolver = lambda c: PolicyEvaluationConstraints()
    state = SimpleNamespace(payload=stale_payload(), receipts=(), transient=False)
    monkeypatch.setattr(routes, "_project_missing_album_actions_for_request", lambda *a: None)
    monkeypatch.setattr(routes, "_apply_transient_scan_album_rating_overlays", lambda *a: None)
    @app.get("/view-data")
    def seam(request: Request):
        state.request = request
        return routes._private_browse_response(request, state.payload,
            artist_loved_roots=state.receipts, transient=state.transient)
    install_private_route_boundary(app)
    state.harness = Harness(Owner(), resolver, app, app.state.policy_constraint_resolver)
    return state


def test_mounted_legacy_no_receipts_strips_all_cache_fields_without_mutating_input(mounted):
    before = deepcopy(mounted.payload)
    status, headers, body = mounted.harness.request("GET", "/view-data")
    assert status == 200 and headers["cache-control"] == "private, no-store"
    assert_cleared(body)
    assert mounted.payload == before


@pytest.mark.parametrize("failure", ["exit", "denied", "missing_context", "changed_context", "transient"])
def test_mounted_finalizer_never_publishes_before_successful_authority_exit(mounted, monkeypatch, failure):
    state = mounted
    state.receipts = [receipt(state.payload["artist_groups"][0])]
    state.transient = failure == "transient"
    observed = []
    @contextmanager
    def transaction(url, supplied, **kwargs):
        assert kwargs["read_only"] is True
        if failure == "denied":
            raise authority.PrivateLibraryAuthorityError("denied")
        yield connection(), supplied, NOW
        assert_cleared(observed[0])
        if failure == "exit": raise psycopg.OperationalError("synthetic exit failure")
    def staged(con, *, payload, copy_memo, receipts, **kwargs):
        observed.append(payload)
        assert_cleared(payload)
        target = copy_memo[id(receipts[0].target)]
        assert target is payload["artist_groups"][0]
        return [(target, "artist_loved_launch", launch())]
    monkeypatch.setattr(authority, "current_library_transaction", transaction)
    monkeypatch.setattr(routes, "project_artist_loved_browse_launches", staged)
    if failure in ("missing_context", "changed_context"):
        refs = iter([None] if failure == "missing_context" else [REF, "b" * 64])
        monkeypatch.setattr(routes, "private_ui_context_ref", lambda request: next(refs))
    status, _, body = state.harness.request("GET", "/view-data")
    assert status == 200
    assert_cleared(body)
    assert len(observed) == (1 if failure in ("exit", "changed_context") else 0)


def test_mounted_success_installs_only_after_exit(mounted, monkeypatch):
    mounted.receipts = [receipt(mounted.payload["artist_groups"][0])]
    seen = []
    @contextmanager
    def transaction(url, supplied, **kwargs):
        yield connection(), supplied, NOW
        assert_cleared(seen[0])
        seen.append("exited")
    def staged(con, *, payload, copy_memo, receipts, context_ref, **kwargs):
        seen.append(payload)
        return [(copy_memo[id(receipts[0].target)], "artist_loved_launch",
                 {**launch(), "context_ref": context_ref})]
    monkeypatch.setattr(authority, "current_library_transaction", transaction)
    monkeypatch.setattr(routes, "project_artist_loved_browse_launches", staged)
    status, _, body = mounted.harness.request("GET", "/view-data")
    assert status == 200 and seen[1] == "exited"
    assert body["artist_loved_context_ref"] == mounted.harness.context_ref()
    assert body["artist_groups"][0]["artist_loved_launch"]["descriptor"] == launch()["descriptor"]
    assert mounted.payload["artist_loved_context_ref"] == REF


def test_mounted_early_policy_denial_is_not_descriptor_success(mounted):
    mounted.harness.resolver.actor = context(grants=()).actor
    status, _, body = mounted.harness.request("GET", "/view-data")
    assert status == 403 and "artist_loved_context_ref" not in body


@pytest.mark.parametrize("name", ["build_selected_artist_payload", "build_root_startup_preview_payload",
    "build_root_sidebar_payload", "build_root_album_browse_payload"])
def test_four_producers_keep_collector_optional_for_legacy_callers(name):
    parameter = inspect.signature(getattr(browse.PostgresLibraryBrowseRepository, name)).parameters["_artist_loved_roots"]
    assert parameter.default is None and parameter.kind is inspect.Parameter.KEYWORD_ONLY


# Real disposable PostgreSQL tests. No policy, session, alias or SQL monkeypatch.
# The producing receipt below is deliberately constructed: these tests establish
# fresh admission; scripted capture tests above establish receipt production.
@pytest.fixture
def canonical_db(loved_db):
    db = loved_db
    with db.connect() as con:
        db.browse_root = add_artist(con, db, NAME)
        set_aliases(con, db, {"Alias": NAME}, {NAME: ["Alias"]})
    return db


def live_project(db, *, actor=None, constraints=None, identity=None, library=None):
    group = {"artist": NAME, "albums": []}
    original = {"artist_groups": [group]}
    memo = {}
    copied = deepcopy(original, memo)
    captured = receipt(group, inventory_library_id=db.library if library is None else library,
                       root_artist_id=db.browse_root if identity is None else identity)
    with authority.current_library_transaction(db.app_url, db.context(actor),
            constraints=constraints, connect=db.app_connect, clock=lambda: db.clock_time,
            read_only=True) as (con, live, now):
        staged = browse.project_artist_loved_browse_launches(con, context=live,
            constraints=constraints, context_ref=REF, receipts=[captured],
            payload=copied, copy_memo=memo, clock=lambda: db.clock_time)
        assert copied == original
    return staged


def test_live_viewer_scoped_browse_create_without_media(canonical_db):
    db = canonical_db
    with db.connect() as con:
        actor = db.member(con, actions=capability_keys_for_roles(("viewer",)))
    assert all(g.scope_kind == "library" and g.scope_id == db.library for g in actor.capability_grants)
    assert not PolicyEvaluator().evaluate(replace(db.context(actor), action="library.media.read")).decision.allowed
    staged = live_project(db, actor=actor)
    assert len(staged) == 1 and staged[0][2]["descriptor"]["root_artist_id"] == str(db.browse_root)


@pytest.mark.parametrize("change", ["membership", "create_constraint", "session"])
def test_live_revocation_between_capture_and_fresh_admission(canonical_db, change):
    db = canonical_db
    with db.connect() as con:
        if change == "membership":
            con.execute("delete from library.library_memberships where account_id=%s and library_id=%s",
                        (db.owner.account_id, db.library))
        elif change == "session":
            con.execute("update app.account_sessions set revoked_at=%s where id=%s",
                        (db.now, db.owner.session_id))
    def constraints(ctx):
        return PolicyEvaluationConstraints(
            request_origin_allowed=not (change == "create_constraint" and ctx.action == CREATE))
    with pytest.raises(authority.PrivateLibraryAuthorityError):
        live_project(db, constraints=constraints)


def test_live_separate_create_grant_removal_preserves_intrinsic_browse_create(canonical_db):
    db = canonical_db
    with db.connect() as con:
        con.execute("delete from app.capabilities where account_id=%s and capability_key=%s",
                    (db.owner.account_id, CREATE))
    assert len(live_project(db)) == 1


def test_live_deleted_root_replacement_same_name_never_rebinds(canonical_db):
    db = canonical_db
    original_id = db.browse_root
    with db.connect() as con:
        con.execute("delete from library.local_artists where id=%s", (original_id,))
        replacement = add_artist(con, db, NAME)
    assert replacement != original_id
    assert live_project(db, identity=original_id) == []
    assert len(live_project(db, identity=replacement)) == 1


def test_live_alias_reassignment_after_capture_suppresses_launch(canonical_db):
    db = canonical_db
    with db.connect() as con:
        add_artist(con, db, "Other")
        set_aliases(con, db, {"Alias": "Other"}, {"Other": ["Alias"]})
    assert live_project(db) == []


def test_live_current_root_browse_deny_does_not_require_media(canonical_db):
    db = canonical_db
    def constraints(ctx):
        deny = ctx.resource is not None and ctx.resource.resource_kind == "artist"
        return PolicyEvaluationConstraints(deployment_allowed=not deny)
    assert live_project(db, constraints=constraints) == []


def test_live_library_mismatch_with_same_name_does_not_transfer_receipt(canonical_db):
    db = canonical_db
    with db.connect() as con:
        foreign_id = add_artist(con, db, NAME, library=db.foreign_library)
    assert live_project(db, identity=foreign_id, library=db.foreign_library) == []


@pytest.fixture
def bootstrap_snapshot(mix_urls, tmp_path):
    """Rollback-only producer fixture; never owns or replaces bootstrap rows.

    The unchanged isolated fixture must already have seeded exactly one owner.
    All metadata and uniquely named records exist only in this transaction.
    Fresh-connection cleanup assertions also run after an assertion failure.
    """
    from uuid import uuid4
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
    from music_app.services.relation_projection_postgres import RELATION_PROJECTION_BUILDER_VERSION
    app_url, setup_url = mix_urls
    con = psycopg.connect(setup_url, row_factory=dict_row)
    library = old_metadata = root = None
    name = "Loved snapshot " + uuid4().hex
    alias = "Alias " + name
    try:
        con.execute("set transaction isolation level repeatable read")
        con.execute("set local statement_timeout = '10s'")
        con.execute("set local lock_timeout = '3s'")
        libraries = con.execute("""select l.id,l.metadata from app.bootstrap_owners b
            join library.libraries l on l.owner_account_id=b.account_id
            where b.owner_key='local-bootstrap-owner' and l.name='Local Library'
              and l.library_kind='local' for update of l""").fetchall()
        assert len(libraries) == 1, "Requires the existing isolated bootstrap seed; never repair it"
        library, old_metadata = libraries[0]["id"], deepcopy(libraries[0]["metadata"])
        metadata = deepcopy(old_metadata)
        scan = metadata.setdefault("scan_cache", {})
        relations = scan.setdefault("relation_views", {})
        relations.setdefault("alias_to_canonical", {})[alias] = name
        relations.setdefault("canonical_to_aliases", {})[name] = [alias]
        for key in ("family_to_artists", "folder_related"):
            relations.setdefault(key, {})
        for key in ("artists", "artists_sidebar", "sidebar_families"):
            relations.setdefault(key, [])
        scan.setdefault("relation_projection", {}).update(
            status="ready", builder_version=RELATION_PROJECTION_BUILDER_VERSION,
            source_fingerprint=name, built_from_fingerprint=name)
        con.execute("update library.libraries set metadata=%s where id=%s", (Jsonb(metadata), library))
        root = con.execute("""insert into library.local_artists(library_id,artist_key,name)
            values(%s,%s,%s) returning id""",
            (library, browse.local_inventory_identity_key(name), name)).fetchone()["id"]
        def unexpected_connection(*args, **kwargs):
            pytest.fail("Producer escaped its caller-owned snapshot")
        repository = browse.PostgresLibraryBrowseRepository({
            "ALBUM_HAVEN_APP_DATABASE_URL": app_url,
            "ALBUM_HAVEN_UTILITY_PROJECTION_PREWARM_ENABLED": False,
            "MUSIC_DIR": str(tmp_path)}, connect=unexpected_connection)
        yield SimpleNamespace(connection=con, library=library, root=root,
                              name=name, alias=alias, repository=repository)
    finally:
        try:
            con.rollback()
        finally:
            con.close()
        assert con.closed
        if library is not None:
            with psycopg.connect(setup_url, row_factory=dict_row) as check:
                check.execute("set local statement_timeout = '10s'")
                assert check.execute("select metadata from library.libraries where id=%s",
                                     (library,)).fetchone()["metadata"] == old_metadata
                assert check.execute("select id from library.local_artists where library_id=%s and name=%s",
                                     (library, name)).fetchall() == []


def test_live_selected_producer_empty_filter_retains_exact_page_receipt_and_legacy_dto(bootstrap_snapshot):
    db = bootstrap_snapshot
    params = {"artist": db.alias, "q": "unmatched-" + db.name, "omit_sidebar": "1",
              "primary_filter": "1"}
    found = []
    payload = db.repository.build_selected_artist_payload(query_params=params,
        _connection=db.connection, _artist_loved_roots=found)
    legacy = db.repository.build_selected_artist_payload(query_params=params, _connection=db.connection)
    assert payload == legacy
    assert payload["album_count"] == 0
    page_receipts = [r for r in found if r.target_kind == "page"]
    assert len(page_receipts) == 1
    captured = page_receipts[0]
    assert captured.target is payload["artist_page"]
    assert (captured.inventory_library_id, captured.root_artist_id, captured.root_artist_key,
            captured.artist_ref, captured.original_alias) == (
        db.library, db.root, browse.local_inventory_identity_key(db.name), db.name, db.alias)
    encoded = json.dumps(payload)
    assert "artist_loved" not in encoded and "inventory_library_id" not in encoded


def test_live_capture_uses_same_snapshot_exact_canonical_principal(bootstrap_snapshot):
    db = bootstrap_snapshot
    group = {"artist": db.name, "artist_display": "Unrelated display", "albums": []}
    found = []
    browse._capture_artist_loved_browse_roots(db.connection,
        targets=[(group, "group", db.name, db.alias)], collector=found)
    assert len(found) == 1 and found[0].target is group and found[0].root_artist_id == db.root
    db.connection.execute("delete from library.local_artists where id=%s", (db.root,))
    absent = []
    browse._capture_artist_loved_browse_roots(db.connection,
        targets=[(group, "group", db.name, db.alias)], collector=absent)
    assert absent == []


def test_project_many_receipts_uses_one_root_query_and_alias_load(io):
    groups = [{"artist": NAME, "albums": []} for _ in range(300)]
    original = {"artist_groups": groups}
    memo = {}
    payload = deepcopy(original, memo)
    con = connection([Step("id=any", [row()], (LIBRARY, [ROOT]))])
    staged = project(con, payload, memo, [receipt(group) for group in groups])
    assert len(staged) == 300 and len(con.operations) == 1 and len(io.alias_calls) == 1
    assert payload == original
    con.done()


def test_mounted_schema_error_is_not_silently_treated_as_success(mounted, monkeypatch):
    mounted.receipts = [receipt(mounted.payload["artist_groups"][0])]
    @contextmanager
    def broken(*args, **kwargs):
        raise psycopg.errors.UndefinedTable("synthetic missing schema")
        yield
    monkeypatch.setattr(authority, "current_library_transaction", broken)
    # Call the real finalizer directly: middleware exception grouping varies
    # across supported ASGI versions and is not the contract under assertion.
    request = Request({"type": "http", "app": mounted.harness.app,
        "state": {"current_actor": mounted.harness.resolver.actor},
        "headers": [], "scheme": "https", "client": ("192.0.2.10", 50000),
        "path": "/view-data", "query_string": b"", "method": "GET", "server": ("music.test", 443)})
    with pytest.raises(psycopg.errors.UndefinedTable):
        routes._private_browse_response(request, mounted.payload, artist_loved_roots=mounted.receipts)


@pytest.mark.parametrize("collect", [False, True])
def test_root_full_loader_scope_preserves_legacy_and_collector_transaction(monkeypatch, collect):
    con = connection([Step("set transaction isolation level repeatable read, read only")]
                     if collect else [])
    repository = browse.PostgresLibraryBrowseRepository({
        "ALBUM_HAVEN_APP_DATABASE_URL": "unused-synthetic-url",
        "ALBUM_HAVEN_UTILITY_PROJECTION_PREWARM_ENABLED": False}, connect=lambda url: con)
    seen = []
    def loader(name, result):
        def read(*args, **kwargs):
            seen.append((name, kwargs.get("connection")))
            assert (kwargs.get("connection") is con) if collect else "connection" not in kwargs
            return deepcopy(result)
        return read
    monkeypatch.setattr(repository, "_load_relation_alias_maps", loader("aliases", aliases()))
    monkeypatch.setattr(repository._inventory_repository, "load_support_state",
        loader("support", {"ignored_version_keys": [], "manual_version_links": {}}))
    monkeypatch.setattr(repository, "_load_root_album_browse_rows", loader("albums", []))
    monkeypatch.setattr(repository, "_load_missing_album_rows", loader("missing", []))
    monkeypatch.setattr(repository, "_load_non_album_entries", loader("loose", []))
    monkeypatch.setattr(repository, "_apply_private_album_rating_overlays", loader("ratings", None))
    found = []
    payload = repository.build_root_album_browse_payload(
        **({"_artist_loved_roots": found} if collect else {}))
    assert payload["album_count"] == 0 and found == []
    assert {name for name, _ in seen} == {"aliases", "support", "albums", "missing", "loose", "ratings"}
    assert con.entered == (1 if collect else 0)
    assert con.exits == ([None] if collect else [])
    con.done()


def test_capture_requires_caller_owned_transaction():
    con = connection()
    con.autocommit = True
    with pytest.raises(ValueError, match="transaction"):
        browse._capture_artist_loved_browse_roots(con, targets=[], collector=[])
    con.done()


def test_missing_context_or_bad_reference_cannot_become_admission(io):
    _, payload, memo, found = copied_payload()
    con = connection()
    with pytest.raises(ValueError, match="transaction"):
        browse.project_artist_loved_browse_launches(con, context=None, constraints=None,
            context_ref=REF, receipts=found, payload=payload, copy_memo=memo)
    assert browse.project_artist_loved_browse_launches(con,
        context=context(grants=(BROWSE, CREATE)), constraints=None, context_ref="not-a-ref",
        receipts=found, payload=payload, copy_memo=memo) == []
    con.done()


def test_collaboration_principal_is_not_replaced_by_primary_alias_owner(io, monkeypatch):
    collaboration = NAME + " & Guest"
    key = browse.local_inventory_identity_key(collaboration)
    state = {"alias_to_canonical": {collaboration: NAME},
             "canonical_to_aliases": {NAME: [NAME, collaboration]}}
    monkeypatch.setattr(browse, "load_current_library_relation_alias_maps", lambda *args: state)
    target = {"artist": collaboration, "albums": []}
    current = {"id": ROOT, "name": collaboration, "artist_key": key}
    captured = []
    con = connection([Step("app.bootstrap_owners", [{"library_id": LIBRARY}]),
                      Step("artist_key=any", [current], (LIBRARY, [key]))])
    browse._capture_artist_loved_browse_roots(con,
        targets=[(target, "group", collaboration, collaboration)], collector=captured)
    con.done()
    assert len(captured) == 1 and captured[0].artist_ref == collaboration
    assert captured[0].root_artist_key == key and captured[0].root_artist_id == ROOT
    memo = {}
    payload = deepcopy({"artist_groups": [target]}, memo)
    con = connection([Step("id=any", [current], (LIBRARY, [ROOT]))])
    staged = project(con, payload, memo, captured)
    assert len(staged) == 1
    assert staged[0][2]["artist_ref"] == collaboration
    assert staged[0][2]["descriptor"]["root_artist_id"] == str(ROOT)
    con.done()


def test_live_session_expiry_at_final_post_root_read_check_prevents_staging(canonical_db):
    from datetime import timedelta
    db = canonical_db
    group = {"artist": NAME, "albums": []}
    original = {"artist_groups": [group]}
    memo = {}
    payload = deepcopy(original, memo)
    captured = receipt(group, inventory_library_id=db.library, root_artist_id=db.browse_root)
    final_clock_calls = []
    def after_wait():
        final_clock_calls.append(True)
        # The fixture's real persisted session has a one-day absolute expiry.
        return db.clock_time + timedelta(days=2)
    with pytest.raises(authority.PrivateLibraryAuthorityError):
        with authority.current_library_transaction(db.app_url, db.context(),
                connect=db.app_connect, clock=lambda: db.clock_time,
                read_only=True) as (con, live, now):
            assert now == db.clock_time
            browse.project_artist_loved_browse_launches(con, context=live, constraints=None,
                context_ref=REF, receipts=[captured], payload=payload, copy_memo=memo,
                clock=after_wait)
    assert final_clock_calls == [True] and payload == original


@pytest.mark.parametrize("mode", ["sidebar", "startup", "cached_page", "fresh_page"])
def test_partial_and_paged_producers_capture_fresh_exact_targets_on_current_snapshot(io, monkeypatch, mode):
    from music_app.services import gallery_projection_postgres as gallery
    paged = mode.endswith("page")
    cached = mode == "cached_page"
    steps = [Step("set transaction isolation level repeatable read, read only")]
    if cached:
        steps.append(Step("select", [aliases()]))
    elif paged:
        steps.append(Step("select", []))  # Existing membership loader, not identity authority.
    steps.extend([Step("app.bootstrap_owners", [{"library_id": LIBRARY}]),
                  Step("artist_key=any", [row()], (LIBRARY, [KEY]))])
    con = connection(steps)
    lifecycle = []
    con.rollback = lambda: lifecycle.append("rollback")
    con.close = lambda: lifecycle.append("close")
    repository = browse.PostgresLibraryBrowseRepository({
        "ALBUM_HAVEN_APP_DATABASE_URL": "synthetic-unused",
        "ALBUM_HAVEN_UTILITY_PROJECTION_PREWARM_ENABLED": False}, connect=lambda url: con)
    seen = []
    def loader(name, result):
        def read(*args, **kwargs):
            assert kwargs["connection"] is con
            seen.append(name)
            return deepcopy(result)
        return read
    monkeypatch.setattr(repository, "_load_relation_alias_maps", loader("aliases", aliases()))
    monkeypatch.setattr(repository._inventory_repository, "load_support_state",
        loader("support", {"ignored_version_keys": [], "manual_version_links": {}}))
    monkeypatch.setattr(repository, "_load_root_startup_rows", loader("startup", ([], [])))
    monkeypatch.setattr(repository, "_load_root_sidebar_rows", loader("sidebar", []))
    monkeypatch.setattr(repository, "_load_root_startup_preview_rows", loader("preview", []))
    monkeypatch.setattr(repository, "_load_missing_album_rows", loader("missing", []))
    monkeypatch.setattr(repository, "_load_non_album_entries", loader("loose", []))
    monkeypatch.setattr(repository, "_apply_private_album_rating_overlays", loader("ratings", None))
    # Album hydration is outside this identity orchestration test. Real producer
    # code still constructs cached-page target groups and performs real capture.
    album = {"key": "missing-owned", "album_artist": NAME, "title": "Fixture"}
    group = {"artist": NAME, "albums": [album], "sections": []}
    monkeypatch.setattr(browse, "_root_album_browse_artist_groups", lambda rows: [group])
    monkeypatch.setattr(browse, "_queue_display_cover_variants_for_groups", lambda *args, **kwargs: None)
    page = ([{"artist_id": ROOT, "artist_name": NAME, "album_key": album["key"],
              "missing_album_key": album["key"]}], [], 1,
            {"revision": "unchanged-revision", "has_more": False})
    if paged:
        monkeypatch.setattr(browse, "_missing_album_projection_payloads", lambda *args, **kwargs: [album])
        monkeypatch.setattr(gallery, "gallery_projection_context", lambda connection: {"synthetic": True})
        def cached_read(connection, *args, **kwargs):
            assert connection is con
            return deepcopy(page) if cached else None
        monkeypatch.setattr(gallery, "load_gallery_projection_page", cached_read)
        monkeypatch.setattr(browse, "_prepare_root_gallery_snapshot", lambda *args: "prepared")
        monkeypatch.setattr(browse, "_select_root_gallery_snapshot_page", lambda *args: deepcopy(page))
        monkeypatch.setattr(gallery, "queue_gallery_projection_snapshot", lambda *args, **kwargs: None)
    found = []
    if mode == "sidebar":
        payload = repository.build_root_sidebar_payload(_artist_loved_roots=found)
    else:
        payload = repository.build_root_startup_preview_payload(
            query_params={"gallery_page_size": "50", "gallery_cursor": "owned-cursor", "omit_sidebar": "1"}
                if paged else {}, _artist_loved_roots=found)
    assert len(found) == 1 and found[0].target is payload["artist_groups"][0]
    assert found[0].root_artist_id == ROOT and found[0].inventory_library_id == LIBRARY
    assert found[0].target_kind == "group" and found[0].original_alias is None
    assert lifecycle == ["rollback", "close"] and len(io.alias_calls) == 1
    if paged:
        assert payload["gallery_page"] == page[3]
        assert payload["payload_tier"] == "gallery_page"
        assert "artists_sidebar" not in payload and "non_album_tracks" not in payload
    else:
        assert payload["payload_tier"] == ("sidebar" if mode == "sidebar" else "startup_preview")
    assert "artist_loved" not in json.dumps(payload)
    con.done()


@pytest.fixture
def dispatched(mounted, monkeypatch):
    """Mount the production APIRouter; retain real query-shape dispatch predicates."""
    from starlette.responses import JSONResponse
    from music_app.routes import private_search_asgi, owned_playlists_asgi, owned_album_tops_asgi
    state = mounted
    app = state.harness.app
    app.router.routes[:] = [route for route in app.router.routes if getattr(route, "path", None) != "/view-data"]
    app.include_router(routes.router)
    state.calls = []
    state.backend = routes.PERSISTENCE_BACKEND_POSTGRES
    state.library_state = {"albums": {}}
    state.browse_state = state.library_state
    monkeypatch.setattr(routes, "_library_state", lambda request: state.library_state)
    monkeypatch.setattr(routes, "resolve_active_scan_browse_state", lambda lib: state.browse_state)
    monkeypatch.setattr(routes, "select_runtime_persistence_adapter",
        lambda *args: SimpleNamespace(effective_backend=state.backend))
    monkeypatch.setattr(routes, "_app_logger", lambda request: None)
    monkeypatch.setattr(routes, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(routes, "_log_view_data_request_from_asgi", lambda *args: None)
    monkeypatch.setattr(routes, "_hydrate_cached_library_for_asgi", lambda request: None)
    monkeypatch.setattr(routes, "build_transient_root_gallery_page", lambda payload, *args, **kwargs: payload)
    def producer(name):
        def build(self, **kwargs):
            found = kwargs.get("_artist_loved_roots")
            state.calls.append((name, found))
            payload = {"artist_groups": [{"artist": NAME, "albums": []}]}
            if found is not None:
                found.append(receipt(payload["artist_groups"][0]))
            return payload
        return build
    for name in ("build_root_startup_preview_payload", "build_root_sidebar_payload",
                 "build_selected_artist_payload", "build_root_album_browse_payload", "build_search_payload"):
        monkeypatch.setattr(routes.PostgresLibraryBrowseRepository, name, producer(name))
    def finalize(request, payload, **kwargs):
        found = kwargs.get("artist_loved_roots", ())
        state.calls.append(("finalize", tuple(found), kwargs.get("transient", False)))
        if found:
            assert found[0].target is payload["artist_groups"][0]
        return JSONResponse({"seam": "ordinary", "receipt_count": len(found)})
    monkeypatch.setattr(routes, "_private_browse_response", finalize)
    def fallback(**kwargs):
        state.calls.append(("file_or_transient", None))
        return {"artist_groups": []}
    monkeypatch.setattr(routes, "build_view_payload", fallback)
    def unrelated(name):
        def response(request):
            state.calls.append((name, None))
            return JSONResponse({"seam": name})
        return response
    monkeypatch.setattr(private_search_asgi, "private_search_view_response", unrelated("private_search"))
    monkeypatch.setattr(owned_playlists_asgi, "playlist_view_response", unrelated("playlists"))
    monkeypatch.setattr(owned_album_tops_asgi, "album_top_view_response", unrelated("album_tops"))
    return state


@pytest.mark.parametrize("query,producer", [
    ({"surface": "albums", "artist": NAME}, "build_selected_artist_payload"),
    ({"surface": "albums", "payload_tier": "sidebar"}, "build_root_sidebar_payload"),
    ({"surface": "albums"}, "build_root_album_browse_payload"),
    ({"surface": "albums", "gallery_page_size": "50"}, "build_root_startup_preview_payload"),
])
def test_actual_view_data_dispatch_passes_same_request_local_collector(dispatched, query, producer):
    status, _, body = dispatched.harness.request("GET", "/view-data", query=query)
    assert status == 200 and body == {"seam": "ordinary", "receipt_count": 1}
    assert [entry[0] for entry in dispatched.calls] == [producer, "finalize"]
    found = dispatched.calls[0][1]
    assert isinstance(found, list) and dispatched.calls[1][1] == tuple(found)


@pytest.mark.parametrize("case,query,expected", [
    ("private", {"surface": "albums", "q": ":loved", "all_artists": "1"}, "private_search"),
    ("playlist", {"surface": "playlists"}, "playlists"),
    ("top", {"surface": "album_tops"}, "album_tops"),
    ("file", {"surface": "albums", "omit_sidebar": "1"}, "file_or_transient"),
    ("transient", {"surface": "albums"}, "file_or_transient"),
    ("transient_page", {"surface": "albums", "gallery_page_size": "50"}, "file_or_transient"),
])
def test_actual_view_data_other_surfaces_never_get_loved_collector(dispatched, case, query, expected):
    if case == "file":
        dispatched.backend = "file"
    if case.startswith("transient"):
        dispatched.library_state = {"scan_in_progress": True, "albums": {}}
        dispatched.browse_state = {"albums": {"synthetic": []}, "scan_generation": 1}
    status, _, body = dispatched.harness.request("GET", "/view-data", query=query)
    assert status == 200
    assert dispatched.calls[0][0] == expected
    assert not any(entry[0].startswith("build_") for entry in dispatched.calls)
    finalizers = [entry for entry in dispatched.calls if entry[0] == "finalize"]
    if expected == "file_or_transient":
        assert len(finalizers) == 1 and finalizers[0][1] == ()
        assert finalizers[0][2] is case.startswith("transient")
    else:
        assert finalizers == [] and body == {"seam": expected}


def test_selected_supplementary_sidebar_is_not_independent_launch_owner(dispatched):
    status, _, body = dispatched.harness.request("GET", "/view-data",
        query={"surface": "albums", "artist": NAME, "root_sidebar": "1"})
    assert status == 200 and body["receipt_count"] == 1
    assert [entry[0] for entry in dispatched.calls] == [
        "build_selected_artist_payload", "build_root_sidebar_payload", "finalize"]
    assert dispatched.calls[1][1] is None


@pytest.mark.parametrize("query,error", [
    ({"surface": "albums", "artist": NAME, "unsupported": "1"},
     "unsupported_postgres_selected_artist_browse_request"),
    ({"surface": "albums", "unsupported": "1"},
     "unsupported_postgres_root_album_browse_request"),
])
def test_actual_dispatch_unsupported_shapes_reject_before_producer_or_finalizer(dispatched, query, error):
    status, _, body = dispatched.harness.request("GET", "/view-data", query=query)
    assert status == 400 and body["error_code"] == error
    assert dispatched.calls == []
