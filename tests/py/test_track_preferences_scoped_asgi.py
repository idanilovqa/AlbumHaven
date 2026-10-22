"""Real authenticated POST and fresh HTTP read contracts, with real middleware."""
from __future__ import annotations

import json
from dataclasses import replace
from types import SimpleNamespace

import pytest

from tests.py.track_taste_testing import (
    OwnedWorkers, assert_taste_locations, observe_lock_wait,
    taste, taste_app, taste_database,
)
from tests.py.test_track_preferences_postgres import change_scope


def own_request_connections(taste, taste_app, monkeypatch, work):
    """Retain real auth/persistence while capturing every request DB handle."""
    from music_app.services import track_preferences as service
    from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
    from music_app.services.current_actor_postgres import PostgresCurrentActorResolver
    from music_app.services.track_preferences_postgres import PostgresTrackPreferencesStore
    sessions = PostgresAuthSessionService(taste.config, connect=work.runtime_connection)
    resolver = PostgresCurrentActorResolver(taste.config, session_service=sessions,
                                           connect=work.runtime_connection)
    monkeypatch.setattr(taste_app.app.state, "current_actor_resolver", resolver)
    class Store(PostgresTrackPreferencesStore):
        def __init__(self, config):
            super().__init__(config, connect=work.runtime_connection)
    monkeypatch.setattr(service, "PostgresTrackPreferencesStore", Store)


def post(client, track, values, *, ref=None, **kwargs):
    return client.request("POST", "/track-preferences", json_body={
        "track_ref": ref or track["paths"][0], "track_preference": values,
    }, **kwargs)


def get_album(client, taste, **kwargs):
    return client.request("GET", "/album-details", query={"album_key": taste.album_key}, **kwargs)


def assert_no_store(headers):
    assert {part.strip().casefold() for part in headers["cache-control"].split(",")} == {"private", "no-store"}


def use_published_scan_snapshot(taste, taste_app, track, monkeypatch):
    from music_app.services import album_details
    from tests.py.test_track_taste_album_details import cached_payload
    source = cached_payload(taste, track, track)
    snapshot = {"albums": [SimpleNamespace(key=taste.album_key)], "file_cache": {}, "separate_release_keys": set()}
    taste_app.app.state.library_state.update(
        albums=[], scan_in_progress=True, scan_generation=7,
        active_scan_preview_state={"scan_generation": 7,
            "publication_state": snapshot, "browse_snapshot": snapshot},
    )
    # Preserve the real published scan routing, inventory provenance query,
    # preference repository and authorization. Only cached serialization is
    # supplied as a complete pre-request fixture, never rewritten mid-request.
    monkeypatch.setattr(album_details, "album_to_dict", lambda *_args, **_kwargs: source)


@pytest.mark.parametrize("history", ["logical", "path", "none"])
@pytest.mark.parametrize("post_alias", ["logical", "path"])
@pytest.mark.parametrize("read_path", ["sql", "scan"])
def test_member_post_round_trips_own_taste_through_fresh_path_emitting_get(taste, taste_app, monkeypatch, history, post_alias, read_path):
    track = taste.add_track("roundtrip")
    if read_path == "scan":
        use_published_scan_snapshot(taste, taste_app, track, monkeypatch)
    a_id = taste.seed_preference(taste.a, track, rating=1, love_tier="obsessed")
    a_before = taste.row(a_id)
    b_id = None
    if history != "none":
        b_id = taste.seed_preference(taste.b, track, key=track["key"] if history == "logical" else track["paths"][0])
    ref = track["key"] if post_alias == "logical" else track["paths"][0]

    status, headers, result = post(taste_app, track, {"rating": 4, "love_tier": "loved"}, ref=ref)

    assert status == 200, result
    assert_no_store(headers)
    assert result["ok"] is True
    assert result["track_ref"] == ref
    assert result["actor_id"] == str(taste.b)
    assert result["library_id"] == taste.l1 and type(result["library_id"]) is int
    status, headers, fresh = get_album(taste_app, taste)
    assert status == 200, fresh
    assert_no_store(headers)
    assert_taste_locations(fresh["album"], track["paths"][0], rating=4, love_tier="loved", editable=True)
    assert taste.row(a_id) == a_before
    b_rows = [r for r in taste.rows() if r["account_id"] == taste.b]
    assert len(b_rows) == 1
    assert b_rows[0]["track_key"] == (track["paths"][0] if history == "path" else track["key"])
    if b_id is not None:
        assert b_rows[0]["id"] == b_id
    status, _, owner = get_album(taste_app, taste, account=taste.a)
    assert status == 200
    assert_taste_locations(owner["album"], track["paths"][0], rating=1, love_tier="obsessed", editable=True)


def test_body_and_query_targets_cannot_select_another_actor_or_library(taste, taste_app, monkeypatch):
    track = taste.add_track("target-hints")
    use_published_scan_snapshot(taste, taste_app, track, monkeypatch)
    a_id = taste.seed_preference(taste.a, track, rating=1)
    before = taste.row(a_id)
    hints = {"actor_id": str(taste.a), "account_id": taste.a,
             "library_id": taste.l2, "target_account_id": taste.a}
    status, _, result = taste_app.request("POST", "/track-preferences", query=hints, json_body={
        **hints, "track_ref": track["paths"][0], "track_preference": {"rating": 5},
    })
    assert status == 200, result
    assert (result["actor_id"], result["library_id"]) == (str(taste.b), taste.l1)
    assert taste.row(a_id) == before
    status, _, fresh = taste_app.request("GET", "/album-details", query={"album_key": taste.album_key, **hints})
    assert status == 200, fresh
    assert_taste_locations(fresh["album"], track["paths"][0], rating=5, love_tier="off", editable=True)


def test_scan_route_uses_inventory_owner_provenance_when_current_library_differs(taste, taste_app, monkeypatch):
    from music_app.services import album_details
    track = taste.add_track("independent-provenance")
    taste.seed_preference(taste.b, track, rating=4, love_tier="loved")
    use_published_scan_snapshot(taste, taste_app, track, monkeypatch)

    def forbidden_private_lookup(*_args, **_kwargs):
        raise AssertionError("mismatched route inventory provenance loaded private taste")
    monkeypatch.setattr(album_details, "build_track_preference_overlay_lookup", forbidden_private_lookup)
    # CurrentActor legitimately selects the oldest local library owned by the
    # bootstrap account. The inventory owner independently selects its library
    # named Local Library. Prepare different selections before any HTTP request;
    # do not replace the real actor resolver or the inventory-owner query.
    assert taste.l1 < taste.l2
    with taste.connect() as connection:
        original_names = {row["id"]: row["name"] for row in connection.execute(
            "select id,name from library.libraries where id=any(%s)", ([taste.l1, taste.l2],),
        ).fetchall()}
    try:
        with taste.connect() as connection:
            connection.execute("update library.libraries set name=%s where id=%s", (taste.prefix + " Actor Library", taste.l1))
            connection.execute("update library.libraries set name='Local Library' where id=%s", (taste.l2,))
            inventory = connection.execute("""select l.id from app.bootstrap_owners o
                join library.libraries l on l.owner_account_id=o.account_id
                where o.owner_key='local-bootstrap-owner' and l.name='Local Library'
                  and l.library_kind='local'""").fetchone()
            assert inventory["id"] == taste.l2
            valid_source = connection.execute("""select t.id,t.library_id,f.scan_cache_stale,p.rating
                from library.local_track_files f join library.local_tracks t on t.id=f.track_id
                join app.track_preferences p on p.track_key=t.track_key
                  and p.library_id=t.library_id and p.account_id=%s
                where f.private_path=%s""", (taste.b, track["paths"][0])).fetchone()
            assert valid_source == {"id": track["id"], "library_id": taste.l1,
                                    "scan_cache_stale": False, "rating": 4}
        actor = taste_app.app.state.current_actor_resolver.resolve(taste_app.tokens[taste.b])
        assert actor.account_id == taste.b and actor.current_library_id == taste.l1
        before = taste.rows()
        status, headers, body = get_album(taste_app, taste)
        assert status == 200, body
        assert_no_store(headers)
        assert_taste_locations(body["album"], track["paths"][0], rating=None, love_tier="off", editable=False)
        assert taste.rows() == before
    finally:
        with taste.connect() as connection:
            # Restore owned fixture naming after requests, in collision-safe order.
            connection.execute("update library.libraries set name=%s where id=%s", (original_names[taste.l2], taste.l2))
            connection.execute("update library.libraries set name=%s where id=%s", (original_names[taste.l1], taste.l1))


@pytest.mark.parametrize("bad", [True, False, 4.0, 4.5, "4", "4/5", [4], {}, 0, 6, -1])
def test_live_rating_rejects_coercion_without_persisting(taste, taste_app, bad):
    track = taste.add_track("strict-rating")
    taste.seed_preference(taste.b, track)
    before = taste.rows()
    status, headers, body = post(taste_app, track, {"rating": bad})
    assert status == 400, body
    assert_no_store(headers)
    assert body["ok"] is False
    assert taste.rows() == before


@pytest.mark.parametrize("bad", [None, "", " ", True, 1, [], {}, "favorite"])
def test_live_love_rejects_invalid_values_without_persisting(taste, taste_app, bad):
    track = taste.add_track("strict-love")
    before = taste.rows()
    status, headers, body = post(taste_app, track, {"love_tier": bad})
    assert status == 400, body
    assert_no_store(headers)
    assert taste.rows() == before


@pytest.mark.parametrize("value,normalized", [(" LoVeD ", "loved"), (" OBSESSED ", "obsessed"), (" OFF ", "off")])
def test_live_love_case_and_whitespace_normalize(taste, taste_app, value, normalized):
    track = taste.add_track("valid-love")
    status, _, body = post(taste_app, track, {"love_tier": value})
    assert status == 200, body
    assert body["track_preference"]["love_tier"] == normalized


def test_http_partial_clear_and_empty_patch_retain_durable_row_and_intent(taste, taste_app):
    track = taste.add_track("http-clear")
    preference_id = taste.seed_preference(taste.b, track, rating=4, love_tier="obsessed")
    for values, expected in (({"rating": None}, (None, "obsessed")),
                             ({"love_tier": "off"}, (None, "off"))):
        status, headers, body = post(taste_app, track, values)
        assert status == 200, body
        assert_no_store(headers)
        assert (body["track_preference"]["rating"], body["track_preference"]["love_tier"]) == expected
    before = taste.rows()
    status, _, body = post(taste_app, track, {})
    assert status == 200, body
    assert taste.rows() == before
    assert taste.row(preference_id)["metadata"]["rating_explicit"] is True
    assert taste.row(preference_id)["metadata"]["love_tier_explicit"] is True


def test_actual_importer_logical_key_is_visible_in_fresh_path_emitting_album(taste, taste_app):
    from psycopg.types.json import Jsonb
    from tests.py.test_migrate_app_data_to_postgres import _load_script_module
    track = taste.add_track("imported")
    b_id = taste.seed_preference(taste.b, track, rating=2, love_tier="off")
    before = taste.row(b_id)
    with taste.connect(runtime=True) as connection:
        connection.execute(_load_script_module()._upsert_track_preference_sql(),
            (track["key"], 5, "obsessed", Jsonb({"source": "phase_6_json_file_backfill", "actor_id": "local"})))
    status, _, body = get_album(taste_app, taste, account=taste.a)
    assert status == 200, body
    assert_taste_locations(body["album"], track["paths"][0], rating=5, love_tier="obsessed", editable=True)
    assert taste.row(b_id) == before


def test_taste_post_has_no_shared_inventory_album_listen_or_provider_side_effects(taste, taste_app):
    track = taste.add_track("side-effects")
    tables = ("library.local_tracks", "library.local_track_files", "app.album_ratings",
              "integration.listen_history", "integration.lastfm_loved_tracks", "integration.pending_scrobbles")
    def snapshot():
        from psycopg import sql
        with taste.connect() as connection:
            return {table: connection.execute(sql.SQL(
                "select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]'::jsonb) as rows from {} t"
            ).format(sql.Identifier(*table.split(".")))).fetchone()["rows"] for table in tables}
    before = snapshot()
    status, _, body = post(taste_app, track, {"rating": 4, "love_tier": "obsessed"})
    assert status == 200, body
    assert snapshot() == before


def test_numeric_resource_policy_applies_to_both_post_aliases_and_each_read_row(taste, taste_app):
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    blocked = taste.add_track("blocked", paths=[f"/fixture/{taste.prefix}/Música.flac", f"C:\\Fixture\\{taste.prefix}\\denied.flac"])
    allowed = taste.add_track("allowed")
    contexts = []
    def constraints(context):
        contexts.append(context)
        denied = (context.action == "library.track_preferences.manage"
                  and context.resource is not None
                  and context.resource.resource_ref == str(blocked["id"]))
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    taste_app.app.state.policy_constraint_resolver = constraints
    before = taste.rows()
    for ref in [blocked["key"], *blocked["paths"]]:
        status, headers, body = post(taste_app, blocked, {"rating": 5}, ref=ref)
        assert status == 403, body
        assert_no_store(headers)
    assert taste.rows() == before
    status, _, body = post(taste_app, allowed, {"rating": 4})
    assert status == 200, body
    status, _, body = get_album(taste_app, taste)
    assert status == 200, body
    blocked_rows = [row for row in body["album"]["tracks"] if row.get("path") in blocked["paths"]]
    # The established album serializer emits one representative file per
    # logical track. Both active paths remain valid POST aliases above.
    assert len(blocked_rows) == 1
    representative_path = blocked_rows[0]["path"]
    assert_taste_locations(body["album"], representative_path, rating=None, love_tier="off", editable=False)
    for rows in (body["album"]["track_rows"], body["album"]["gallery_list_block"]["track_rows"]):
        assert [row["track_ref"] for row in rows if row.get("track_ref") in blocked["paths"]] == [representative_path]
    assert_taste_locations(body["album"], allowed["paths"][0], rating=4, love_tier="off", editable=True)
    resources = [c.resource for c in contexts if c.action == "library.track_preferences.manage" and c.resource is not None]
    assert resources
    assert all(r.resource_kind == "track" and r.resource_ref.isascii() and r.resource_ref.isdecimal() for r in resources)
    assert {r.resource_ref for r in resources} == {str(blocked["id"]), str(allowed["id"])}


def test_read_only_member_keeps_own_values_and_never_gets_write_actions(taste, taste_app):
    track = taste.add_track("read-only")
    taste.seed_preference(taste.a, track, rating=5)
    taste.seed_preference(taste.b, track, rating=2)
    with taste.connect() as connection:
        connection.execute("update app.capabilities set revoked_at=now() where account_id=%s and capability_key='library.track_preferences.manage'", (taste.b,))
    before = taste.rows()
    status, _, body = get_album(taste_app, taste)
    assert status == 200, body
    assert_taste_locations(body["album"], track["paths"][0], rating=2, love_tier="loved", editable=False)
    status, headers, _ = post(taste_app, track, {"rating": 4})
    assert status == 403
    assert_no_store(headers)
    assert taste.rows() == before


@pytest.mark.parametrize("case,expected", [("anonymous", 401), ("inactive", 401), ("revoked", 403),
    ("wrong-grant-library", 403), ("nonmember-bootstrap", 403), ("no-library", 403), ("csrf", 403)])
def test_middleware_failures_are_private_no_store_and_do_not_write(taste, taste_app, case, expected):
    from music_app.services.current_actor import CurrentActor
    track = taste.add_track("denied")
    headers = {}
    if case == "anonymous":
        headers["cookie"] = ""
    elif case == "csrf":
        headers["x-album-haven-csrf"] = "invalid"
    elif case in {"nonmember-bootstrap", "no-library"}:
        actor = replace(taste.actor(), is_bootstrap_owner=True,
                        library_relationships=() if case == "nonmember-bootstrap" else taste.actor().library_relationships,
                        current_library_id=None if case == "no-library" else taste.l1)
        taste_app.app.state.current_actor_resolver = SimpleNamespace(resolve=lambda _token: actor)
    else:
        with taste.connect() as connection:
            if case == "inactive":
                connection.execute("update app.accounts set is_active=false, disabled_at=now() where id=%s", (taste.b,))
            elif case == "revoked":
                connection.execute("update app.capabilities set revoked_at=now() where account_id=%s", (taste.b,))
            else:
                connection.execute("update app.capabilities set scope_id=%s where account_id=%s", (taste.l2, taste.b))
    before = taste.rows()
    status, response_headers, _ = post(taste_app, track, {"rating": 4}, headers=headers)
    assert status == expected
    assert_no_store(response_headers)
    assert taste.rows() == before
    if case != "csrf":
        status, response_headers, _ = get_album(taste_app, taste, headers=headers)
        assert status == expected
        assert_no_store(response_headers)


@pytest.mark.parametrize("constraint", ["deployment_allowed", "client_surface_allowed", "request_origin_allowed"])
def test_existing_policy_constraints_still_narrow_library_level_authority(taste, taste_app, constraint):
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    track = taste.add_track("constraint")
    taste_app.app.state.policy_constraint_resolver = lambda _context: PolicyEvaluationConstraints(**{constraint: False})
    status, headers, _ = post(taste_app, track, {"rating": 4})
    assert status == 403
    assert_no_store(headers)
    assert taste.rows() == []


@pytest.mark.parametrize("case,status_expected", [("missing", 404), ("foreign", 404), ("history-conflict", 409)])
def test_identity_error_is_opaque_no_store_and_preserves_history(taste, taste_app, case, status_expected):
    track = taste.add_track("identity", library_id=taste.l2 if case == "foreign" else taste.l1)
    ref = track["paths"][0]
    if case == "missing":
        ref = f"/fixture/{taste.prefix}/missing.flac"
    elif case == "history-conflict":
        taste.seed_preference(taste.b, track, rating=2)
        taste.seed_preference(taste.b, track, key=ref, rating=5)
    before = taste.rows()
    status, headers, body = post(taste_app, track, {"rating": 3}, ref=ref)
    assert status == status_expected, body
    assert_no_store(headers)
    assert body["ok"] is False
    assert ref not in json.dumps(body)
    assert "rating" not in body and "track_preference" not in body
    assert taste.rows() == before


@pytest.mark.parametrize("query,expected", [({}, 400), ({"album_key": "not-present"}, 404)])
def test_album_handler_failures_are_no_store(taste_app, query, expected):
    status, headers, _ = taste_app.request("GET", "/album-details", query=query)
    assert status == expected
    assert_no_store(headers)


@pytest.mark.parametrize("change", ["membership", "disabled", "stale", "relink"])
@pytest.mark.parametrize("values", [{"rating": 5}, {}])
def test_real_post_rechecks_scope_changed_after_resource_authorization(taste, taste_app, monkeypatch, change, values):
    from music_app.routes import api_wave_b_asgi_routes as routes
    track = taste.add_track("authorized-before-change")
    taste.add_track("relink-target")
    taste.seed_preference(taste.b, track)
    before = taste.rows()
    original = routes.save_track_preference
    entered = []
    with OwnedWorkers(taste.database) as work:
        own_request_connections(taste, taste_app, monkeypatch, work)
        phase = work.barrier()
        def pause_after_authorization(*args, **kwargs):
            entered.append(kwargs["expected_track_id"])
            phase.pause()
            return original(*args, **kwargs)
        monkeypatch.setattr(routes, "save_track_preference", pause_after_authorization)
        writer = work.start(lambda: post(taste_app, track, values))
        assert phase.reached.wait(2)
        mutation = work.start(lambda: change_scope(taste, track, change, connect=work.setup_connection))
        work.finish(mutation)
        assert not mutation.errors, mutation.errors
        assert not writer.done.is_set(), "POST escaped the authorization barrier before competing commit"
        phase.release.set()
    assert entered == [track["id"]]
    assert not writer.errors, writer.errors
    status, headers, body = writer.result[0]
    assert status == (403 if change in {"membership", "disabled"} else 404), body
    assert_no_store(headers)
    assert taste.rows() == before


@pytest.mark.parametrize("change", ["membership", "disabled", "stale", "relink", "collision", "history-selection"])
def test_real_post_revalidates_after_upsert_lock_wait_before_commit(taste, taste_app, monkeypatch, change):
    paths = [f"/fixture/{taste.prefix}/active.flac", f"/fixture/{taste.prefix}/historical.flac"] if change == "history-selection" else None
    track = taste.add_track("wait-M", paths=paths)
    taste.add_track("other")
    preference_id = taste.seed_preference(taste.b, track)
    if change == "history-selection":
        # Legitimate stale-P2 history becomes eligible without an importer or
        # cross-track ambiguity while the real preference update is blocked.
        with taste.connect() as connection:
            connection.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true') where private_path=%s", (track["paths"][1],))
        taste.seed_preference(taste.b, track, key=track["paths"][1], rating=1, love_tier="off")
    before = taste.rows()
    with OwnedWorkers(taste.database) as work:
        own_request_connections(taste, taste_app, monkeypatch, work)
        with taste.connect() as blocker:
            blocker.execute("select id from app.track_preferences where id=%s for update", (preference_id,))
            writer = work.start(lambda: post(taste_app, track, {"rating": 5, "love_tier": "obsessed"}))
            assert work.connected.wait(2)
            observe_lock_wait(taste, work.pids)
            mutation = work.start(lambda: change_scope(taste, track, change, connect=work.setup_connection))
            work.finish(mutation)
            assert not mutation.errors, mutation.errors
            assert not writer.done.is_set(), "POST did not remain blocked through competing commit"
        # Exiting the inner transaction releases the row blocker even when the
        # bounded competing mutation fails; the shared owner drains both jobs.
    assert not writer.errors, writer.errors
    status, headers, body = writer.result[0]
    assert status == (403 if change in {"membership", "disabled"} else 409 if change in {"collision", "history-selection"} else 404), body
    assert_no_store(headers)
    assert taste.rows() == before
    if change == "history-selection":
        assert body["ok"] is False
        assert "track_preference" not in body and "rating" not in body
        assert all(alias not in json.dumps(body) for alias in [track["key"], *track["paths"]])
        with taste.connect() as connection:
            files = connection.execute("select track_id, private_path, scan_cache_stale from library.local_track_files where track_id=%s order by private_path", (track["id"],)).fetchall()
            assert {row["private_path"] for row in files} == set(track["paths"])
            assert all(row["track_id"] == track["id"] and row["scan_cache_stale"] is False for row in files)
