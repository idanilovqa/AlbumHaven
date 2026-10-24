"""Accepted-friend history and caller-transaction source export contracts."""
from dataclasses import replace
from datetime import timedelta

import pytest

from music_app.services.allowed_actions import AllowedActions
from music_app.services.current_actor import CapabilityGrant
from music_app.services.home_activity import ActivityQuery, ActivityScope, HomeActivityError, read_home_activity
from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
from tests.py.test_home_activity_postgres_integration import (
    NOW, RetainedRuntimeConnection, allow_all, database_urls,
    mutable_ledger, own_actor, read, static_ledger,
)


def social_read(_kind, _reference):
    return AllowedActions(("library.social.history.read", "library.social.taste.read"))


social_read.scope_wide = True


@pytest.mark.parametrize("subject,audience", [(42, "own"), (None, "friend"), (True, "friend"),
    (0, "friend"), (41, "friend"), (42, "unknown"), (42, [])])
def test_activity_scope_requires_exact_distinct_social_subject(subject, audience):
    expect_status(403, lambda: ActivityScope(41, 11, 73, subject, audience))


@pytest.mark.parametrize("period", ["week", "month", "six", "year", "all"])
def test_comparison_query_always_uses_progressive_receipts(period):
    from music_app.services.auth_tokens import issue_opaque_token
    from music_app.services.home_activity import ComparisonQuery

    token = issue_opaque_token().raw
    query = ComparisonQuery(kind="tracks", period=period, snapshot_ref=token, cursor=token + ".100." + "0" * 64)
    assert query.numbered is False
    expect_status(422, lambda: ComparisonQuery(kind="tracks", period=period, snapshot_ref=token, page=1))
    expect_status(422, lambda: ComparisonQuery(kind="listens", period=period))


@pytest.fixture
def social_ledger(mutable_ledger):
    db, data, current = mutable_ledger["db"], mutable_ledger["data"], mutable_ledger["actor"]
    with db.connect() as connection:
        peer = db.account(connection)
        db.membership(connection, peer, data["library"])
        for account in (current.account_id, peer):
            connection.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) "
                "values(%s,'capability.social','library',%s)", (account, data["library"]))
        low, high = sorted((current.account_id, peer))
        connection.execute("""insert into app.friend_connections(
            library_id,low_account_id,high_account_id,requester_account_id,state,origin)
            values(%s,%s,%s,%s,'accepted','request')""", (data["library"], low, high, current.account_id))
        reference = connection.execute("select account_ref from app.social_profiles where account_id=%s", (peer,)).fetchone()["account_ref"]
        events = [db.event(connection, data, owner=peer, track=track,
                          played_at=NOW - timedelta(minutes=10 + index))
                  for index, track in enumerate(data["tracks"][:2])]
    viewer = replace(current, capability_grants=(*current.capability_grants,
        CapabilityGrant("capability.social", "library", data["library"])))
    return {**mutable_ledger, "actor": viewer, "peer": peer, "peer_ref": str(reference),
            "peer_events": events, "pair": (data["library"], low, high)}


def friend_read(state, *, kind="tracks", period="all", **query):
    return read_home_activity(state["db"].config, actor=state["actor"],
        subject_account_id=state["peer"], query=ActivityQuery(kind=kind, period=period, **query),
        allowed_actions_for_resource=social_read, now=NOW)


def expect_status(status, call):
    with pytest.raises(HomeActivityError) as caught:
        call()
    assert caught.value.status_code == status


@pytest.mark.parametrize("kind,rows", [("tracks", 2), ("albums", 1), ("artists", 1), ("listens", 2)])
def test_friend_history_reads_only_selected_subject_and_echoes_authoritative_ref(social_ledger, kind, rows):
    result = friend_read(social_ledger, kind=kind)
    assert result["account_ref"] == social_ledger["peer_ref"]
    assert result["data"]["total_listens"] == 2
    assert result["data"]["pagination"]["total_rows"] == rows
    assert result["data"]["coverage"]["complete_for_requested_period"] is False
    assert all(row["detail_ref"] is None and not any(row["allowed_actions"].values()) for row in result["data"]["rows"])
    assert "synthetic-private" not in repr(result)
    assert read(social_ledger["db"], social_ledger["actor"])["data"]["total_listens"] == 3


def test_own_and_friend_receipts_never_cross_audiences(social_ledger):
    state = social_ledger
    own = read(state["db"], state["actor"])["data"]
    peer = friend_read(state)["data"]
    expect_status(410, lambda: friend_read(state, snapshot_ref=own["snapshot_ref"], page=1))
    expect_status(410, lambda: read(state["db"], state["actor"], snapshot_ref=peer["snapshot_ref"], page=1))


@pytest.mark.parametrize("change", ["relationship", "viewer_social", "subject_social", "membership", "inactive"])
def test_every_page_rechecks_both_social_accounts_and_the_accepted_relationship(social_ledger, change):
    state = social_ledger
    first = friend_read(state)["data"]
    with state["db"].connect() as connection:
        if change == "relationship":
            connection.execute("update app.friend_connections set state='removed',revision=revision+1 "
                "where library_id=%s and low_account_id=%s and high_account_id=%s", state["pair"])
        elif change in {"viewer_social", "subject_social"}:
            account = state["actor"].account_id if change == "viewer_social" else state["peer"]
            connection.execute("update app.capabilities set revoked_at=clock_timestamp() "
                "where account_id=%s and capability_key='capability.social'", (account,))
        elif change == "membership":
            connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s",
                               (state["peer"], state["data"]["library"]))
        else:
            connection.execute("update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s", (state["peer"],))
    expect_status(403, lambda: friend_read(state, snapshot_ref=first["snapshot_ref"], page=1))


def test_refriending_cannot_revive_a_previous_relationship_receipt(social_ledger):
    state = social_ledger
    first = friend_read(state)["data"]
    with state["db"].connect() as connection:
        connection.execute("update app.friend_connections set state='removed',revision=revision+1 "
            "where library_id=%s and low_account_id=%s and high_account_id=%s", state["pair"])
    with state["db"].connect() as connection:
        connection.execute("update app.friend_connections set state='accepted',revision=revision+1 "
            "where library_id=%s and low_account_id=%s and high_account_id=%s", state["pair"])
    expect_status(410, lambda: friend_read(state, snapshot_ref=first["snapshot_ref"], page=1))
    assert friend_read(state)["data"]["total_listens"] == 2


@pytest.mark.parametrize("operation", ["update", "delete"])
def test_subject_source_repairs_invalidate_viewer_owned_friend_receipts(social_ledger, operation):
    state = social_ledger
    first = friend_read(state)["data"]
    with state["db"].connect() as connection:
        if operation == "delete":
            connection.execute("delete from integration.listen_history where id=%s", (state["peer_events"][0],))
        else:
            connection.execute("update integration.listen_history set finalized=false where id=%s", (state["peer_events"][0],))
    expect_status(410, lambda: friend_read(state, snapshot_ref=first["snapshot_ref"], page=1))
    assert friend_read(state)["data"]["total_listens"] == 1


def test_viewer_history_changes_do_not_retire_unrelated_friend_history(social_ledger):
    state = social_ledger
    first = friend_read(state)["data"]
    with state["db"].connect() as connection:
        connection.execute("update integration.listen_history set finalized=false where id=%s", (state["events"][0],))
    assert friend_read(state, snapshot_ref=first["snapshot_ref"], page=1)["data"] == first


def selection(db, actor, receipt, refs, connection, *, subject=None, allowed=allow_all):
    return HomeActivityPostgresRepository(db.config).read_selection(connection,
        scope=ActivityScope(actor.account_id, actor.session_id, actor.current_library_id,
                            subject, "own" if subject is None else "friend"),
        query=ActivityQuery(kind="tracks", period="all", snapshot_ref=receipt), row_refs=refs,
        allowed_actions_for_resource=allowed, now=NOW)


def test_source_selection_preserves_authored_order_and_minimizes_friend_facts(social_ledger):
    import psycopg

    state = social_ledger
    first = friend_read(state)["data"]
    refs = [row["id"] for row in reversed(first["rows"])]
    with state["db"].connect() as connection:
        txid = connection.execute("select txid_current() as id").fetchone()["id"]
        result = selection(state["db"], state["actor"], first["snapshot_ref"], refs, connection,
                           subject=state["peer"], allowed=social_read)
        assert connection.execute("select txid_current() as id").fetchone()["id"] == txid
        with state["db"].connect() as contender:
            with pytest.raises(psycopg.errors.LockNotAvailable):
                contender.execute("select state from app.friend_connections where library_id=%s "
                    "and low_account_id=%s and high_account_id=%s for update nowait", state["pair"])
    assert [row["row_ref"] for row in result] == refs
    assert [row["canonical_resource"] for row in result] == [
        {"kind": "track", "id": track["id"]} for track in reversed(state["data"]["tracks"][:2])]
    assert all(row["lineage"]["subject_account_id"] == state["peer"] for row in result)
    assert all(set(row["facts"]) == {"kind", "title", "artist", "album_title", "duration_seconds", "source_label", "availability"} for row in result)
    assert "synthetic-private" not in repr(result)


def test_selection_spans_more_than_one_hundred_rows_without_dropping_authored_refs(static_ledger, own_actor):
    db = static_ledger["db"]
    first = read(db, own_actor)["data"]
    rows = list(first["rows"])
    for page in (2, 3):
        rows.extend(read(db, own_actor, snapshot_ref=first["snapshot_ref"], page=page)["data"]["rows"])
    refs = [row["id"] for row in reversed(rows)]
    with db.connect() as connection:
        connection.execute("select 1")
        exported = selection(db, own_actor, first["snapshot_ref"], refs, connection)
    assert len(exported) == 251
    assert [row["row_ref"] for row in exported] == refs


@pytest.mark.parametrize("change", ["account", "membership", "grant"])
def test_selection_read_committed_rechecks_authority_after_row_lock_acquisition(mutable_ledger, change):
    state, changed = mutable_ledger, False
    db, actor = state["db"], state["actor"]
    first = read(db, actor)["data"]

    def before(sql):
        nonlocal changed
        if "select id from app.accounts where id=" in sql and not changed:
            changed = True
            with db.connect() as writer:
                if change == "account":
                    writer.execute("update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s", (actor.account_id,))
                elif change == "membership":
                    writer.execute("delete from library.library_memberships where account_id=%s and library_id=%s",
                                   (actor.account_id, actor.current_library_id))
                else:
                    writer.execute("update app.capabilities set revoked_at=clock_timestamp() where account_id=%s", (actor.account_id,))

    retained = RetainedRuntimeConnection(db, before=before)
    try:
        retained.execute("set transaction isolation level read committed")
        retained.execute("select 1")
        expect_status(403, lambda: selection(db, actor, first["snapshot_ref"], [first["rows"][0]["id"]], retained))
        assert changed
    finally:
        retained.close()


def test_selection_unknown_row_and_wrong_subject_are_denied_without_partial_export(social_ledger):
    state = social_ledger
    first = friend_read(state)["data"]
    with state["db"].connect() as connection:
        connection.execute("select 1")
        expect_status(403, lambda: selection(state["db"], state["actor"], first["snapshot_ref"],
            [first["rows"][0]["id"], "activity_" + "0" * 64], connection, subject=state["peer"], allowed=social_read))
    with state["db"].connect() as connection:
        connection.execute("select 1")
        expect_status(410, lambda: selection(state["db"], state["actor"], first["snapshot_ref"],
            [first["rows"][0]["id"]], connection))


def test_selection_requires_existing_transaction_and_never_starts_an_implicit_write_scope(mutable_ledger):
    db, actor = mutable_ledger["db"], mutable_ledger["actor"]
    first = read(db, actor)["data"]
    with db.connect() as connection:
        expect_status(503, lambda: selection(db, actor, first["snapshot_ref"], [first["rows"][0]["id"]], connection))


def compare(state, *, kind="tracks", period="week", allowed=social_read, **query):
    from music_app.services.home_activity import ComparisonQuery
    return read_home_activity(state["db"].config, actor=state["actor"],
        subject_account_id=state["peer"], comparison=True,
        query=ComparisonQuery(kind=kind, period=period, **query),
        allowed_actions_for_resource=allowed, now=NOW)


@pytest.mark.parametrize("kind,rows", [("tracks", 3), ("albums", 1), ("artists", 1)])
def test_comparison_uses_both_real_scoped_ledgers_and_keeps_unknown_metrics_null(social_ledger, kind, rows):
    result = compare(social_ledger, kind=kind)["data"]
    assert len(result["rows"]) == rows
    assert sum(row["yours"]["listen_count"] for row in result["rows"]) == 3
    assert sum(row["friend"]["listen_count"] for row in result["rows"]) == 2
    assert result["coverage"]["complete_for_requested_period"] is False
    for row in result["rows"]:
        for side in ("yours", "friend"):
            assert row[side]["play_count"] is None
            assert row[side]["full_listen_count"] is None
            assert row[side]["rating"] is None
        assert row["detail_ref"] is None
    assert result.get("pagination") is None


def test_comparison_includes_taste_only_rows_with_known_zero_available_listens_and_freezes_taste(social_ledger):
    state = social_ledger
    db, actor, track = state["db"], state["actor"], state["data"]["tracks"][2]
    with db.connect() as connection:
        connection.execute("update integration.listen_history set played_at=%s where id=%s",
                           (NOW - timedelta(days=30), state["events"][2]))
        connection.execute("""insert into app.track_preferences(account_id,library_id,track_id,track_key,love_tier)
            values(%s,%s,%s,%s,'loved')""", (actor.account_id, actor.current_library_id, track["id"], track["key"]))
    first = compare(state)["data"]
    assert len(first["rows"]) == 3
    taste_only = next(row for row in first["rows"] if row["title"] == track["title"])
    assert taste_only["yours"]["listen_count"] == taste_only["friend"]["listen_count"] == 0
    assert taste_only["yours"]["last_listened_at"] is None
    assert taste_only["yours"]["favorite"] is True
    with db.connect() as connection:
        connection.execute("update app.track_preferences set love_tier='off' where account_id=%s and track_key=%s", (actor.account_id, track["key"]))
    assert compare(state, snapshot_ref=first["snapshot_ref"])["data"] == first
    assert len(compare(state)["data"]["rows"]) == 2


def test_current_taste_denial_retires_a_comparison_even_for_a_taste_only_row(social_ledger):
    state = social_ledger
    db, actor, track = state["db"], state["actor"], state["data"]["tracks"][2]
    with db.connect() as connection:
        connection.execute("update integration.listen_history set played_at=%s where id=%s",
                           (NOW - timedelta(days=30), state["events"][2]))
        connection.execute("""insert into app.track_preferences(account_id,library_id,track_id,track_key,love_tier)
            values(%s,%s,%s,%s,'loved')""", (actor.account_id, actor.current_library_id, track["id"], track["key"]))
    first = compare(state)["data"]

    def denied(kind, reference):
        return AllowedActions(("library.social.history.read",)) if (kind, reference) == ("track", track["id"]) else social_read(kind, reference)

    expect_status(410, lambda: compare(state, allowed=denied, snapshot_ref=first["snapshot_ref"]))


@pytest.mark.parametrize("side", ["yours", "friend"])
def test_either_side_ledger_repair_retires_the_complete_comparison(social_ledger, side):
    state = social_ledger
    first = compare(state)["data"]
    target = state["events"][0] if side == "yours" else state["peer_events"][0]
    with state["db"].connect() as connection:
        connection.execute("update integration.listen_history set finalized=false where id=%s", (target,))
    expect_status(410, lambda: compare(state, snapshot_ref=first["snapshot_ref"]))


def test_comparison_and_friend_activity_receipts_never_cross_audiences(social_ledger):
    state = social_ledger
    activity = friend_read(state, period="week")["data"]
    comparison = compare(state)["data"]
    expect_status(410, lambda: compare(state, snapshot_ref=activity["snapshot_ref"]))
    expect_status(410, lambda: friend_read(state, period="week", snapshot_ref=comparison["snapshot_ref"]))


def test_comparison_never_title_matches_unresolved_events_across_accounts(social_ledger):
    state = social_ledger
    with state["db"].connect() as connection:
        for owner in (state["actor"].account_id, state["peer"]):
            state["db"].event(connection, state["data"], owner=owner,
                track={"id": None, "key": "unresolved-comparison", "path": "/synthetic-private/no-file"})
    rows = compare(state)["data"]["rows"]
    unresolved = [row for row in rows if row["title"] == "Original event title"]
    assert len(unresolved) == 2
    assert all((row["yours"] is None) != (row["friend"] is None) for row in unresolved)
    assert len({row["id"] for row in unresolved}) == 2


def test_long_period_comparison_uses_stable_progressive_cursors(social_ledger):
    import uuid

    state = social_ledger
    with state["db"].connect() as connection:
        for index in range(102):
            key = "comparison-" + uuid.uuid4().hex
            track = connection.execute("""insert into library.local_tracks(
                library_id,album_id,artist_id,track_key,title,duration_seconds)
                values(%s,%s,%s,%s,%s,180) returning id""", (state["data"]["library"],
                state["data"]["album"], state["data"]["artist"], key, f"Comparison {index}")).fetchone()["id"]
            path = "/synthetic-private/" + key
            connection.execute("insert into library.local_track_files(track_id,private_path) values(%s,%s)", (track, path))
            state["db"].event(connection, state["data"], track={"id": track, "key": key, "path": path})
    first = compare(state, period="all")["data"]
    assert len(first["rows"]) == 100 and first["next_cursor"]
    assert first.get("pagination") is None
    second = compare(state, period="all", snapshot_ref=first["snapshot_ref"], cursor=first["next_cursor"])["data"]
    assert len(second["rows"]) == 5 and second["next_cursor"] is None
    assert len({row["id"] for row in first["rows"] + second["rows"]}) == 105
    assert compare(state, period="all", snapshot_ref=first["snapshot_ref"], cursor=first["next_cursor"])["data"] == second


def test_selection_preserves_unresolved_listen_facts_without_claiming_missing(social_ledger):
    state = social_ledger
    with state["db"].connect() as connection:
        state["db"].event(connection, state["data"], owner=state["peer"],
            track={"id": None, "key": "unresolved-selection", "path": "/synthetic-private/no-target"})
    first = friend_read(state, kind="listens")["data"]
    unresolved = next(row for row in first["rows"] if row["availability"] == "unresolved")
    actor = state["actor"]
    with state["db"].connect() as connection:
        connection.execute("select 1")
        exported = HomeActivityPostgresRepository(state["db"].config).read_selection(connection,
            scope=ActivityScope(actor.account_id, actor.session_id, actor.current_library_id, state["peer"], "friend"),
            query=ActivityQuery(kind="listens", period="all", snapshot_ref=first["snapshot_ref"]),
            row_refs=[unresolved["id"]], allowed_actions_for_resource=social_read, now=NOW)
    assert exported[0]["canonical_resource"] is None
    assert exported[0]["facts"]["availability"] == "unresolved"
    assert exported[0]["facts"]["title"] == "Original event title"
    assert "synthetic-private" not in repr(exported)


@pytest.mark.parametrize("endpoint", ["activity", "comparison"])
def test_friend_routes_bind_real_source_target_context_and_resource_policy(social_ledger, endpoint):
    from types import SimpleNamespace
    from fastapi import FastAPI
    from music_app.routes.home_activity_asgi_routes import router
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    from music_app.services.private_route_boundary import install_private_route_boundary
    from tests.py.asgi_testing import decode_json, run_asgi_request

    state = social_ledger
    app = FastAPI()
    app.state.config = state["db"].config
    app.state.current_actor_resolver = SimpleNamespace(resolve=lambda _token: state["actor"])
    app.state.auth_policy_config = {"hmac": {"secret": "friend-route-test-key-at-least-32-bytes", "key_version": 1}}
    contexts = []

    def policy(context):
        contexts.append(context)
        return PolicyEvaluationConstraints()

    app.state.policy_constraint_resolver = policy
    app.include_router(router)
    install_private_route_boundary(app)
    status, headers, body = run_asgi_request(app, "GET", f"/friends/{state['peer_ref']}/{endpoint}",
        query={"kind": "tracks", "period": "week"}, headers={"cookie": "__Host-album_haven_session=" + "s" * 43})
    assert status == 200, decode_json(body)
    result = decode_json(body)
    assert result["account_ref"] == state["peer_ref"]
    assert len(result["context_ref"]) == 64
    assert {"private", "no-store"} <= {part.strip() for part in headers["cache-control"].split(",")}
    assert all(context.target_account_id == state["peer"] for context in contexts if context.resource is not None and context.action.startswith("library.social."))
    assert any(context.resource and context.resource.resource_kind == "track" for context in contexts)
