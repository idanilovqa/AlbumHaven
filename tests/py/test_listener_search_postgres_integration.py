"""Authored-only Listener Search acceptance against guarded isolated PostgreSQL.

These tests are not execution approval. They import the existing TCP-only
isolated-database fixtures unchanged and exercise real application SQL,
CurrentActor sessions and policy evaluation. No authority helper is replaced.
HTTP admission, browser execution and native media/taste consumers remain held.
Lease sequencing observes only the injected connector. The inherited Home
timezone-settings read opens a separate direct psycopg connection outside that
instrumentation; these tests do not assert absence of all nested connections.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta
from threading import Event
import time
import uuid

import pytest

from music_app.services.activity_native_targets import normalize_native_origin
from music_app.services.capabilities import grant_keys_for_action
from music_app.services.home_activity import ActivityQuery
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_listener_search_cursor import decode_listener_cursor, encode_listener_cursor
from music_app.services.private_listener_search_postgres import PostgresListenerSearch
from music_app.services.private_search_contract import PrivateSearchError
from tests.py.test_home_activity_postgres_integration import (
    NOW, BACKFILL, LEGACY, MEASURED, RetainedRuntimeConnection,
    assert_capture_lock_released, database_urls, expire_session_with_database_clock,
    mutable_ledger, own_actor, read as read_home_receipt, retained_repository, static_ledger,
)
from tests.py.test_friend_home_activity import social_ledger

CONTEXT_REF = "a" * 64
CURSOR_SECRET = "listener-search-real-postgres-contract-secret-20261016"
ENVELOPE_KEYS = {
    "status", "private_search", "contract_version", "context_ref", "query", "criteria",
    "presentation", "listener", "tracks", "page", "history", "native_origin",
}
ROW_KEYS = {
    "id", "kind", "title", "artist", "album_title", "listen_count", "last_listened_at",
    "duration_seconds", "source_label", "source_readable", "availability", "artwork_url",
    "rating", "detail_ref", "allowed_actions",
}
COVERAGE_KEYS = {
    "requested_start", "requested_end", "timezone", "observed_start", "observed_end",
    "source_families", "complete_for_available_snapshot", "complete_for_requested_period", "label",
}


def context_for(actor):
    return PolicyContext.build(
        actor=actor, action="library.browse.read", library_id=actor.current_library_id,
        deployment_mode="self_hosted", client_surface_class="private_web",
        request_origin=RequestOrigin("internal", "listener_search_contract"),
    )


def profile(db, account):
    with db.connect() as connection:
        row = connection.execute("""select a.username_normalized,a.username_display,a.display_name,
            p.account_ref::text from app.accounts a join app.social_profiles p on p.account_id=a.id
            where a.id=%s""", (account,)).fetchone()
    assert row is not None
    return row


def listener_read(state, *, subject=None, query=None, cursor=None, constraints=None,
                  connect=None, now=NOW, context=None, context_ref=CONTEXT_REF):
    actor, db = state["actor"], state["db"]
    if query is None:
        query = "@" + profile(db, actor.account_id if subject is None else subject)["username_normalized"]
    return PostgresListenerSearch(db.config, connect=connect, clock=lambda: now).read(
        context_for(actor) if context is None else context, query=query, context_ref=context_ref,
        cursor_secret=CURSOR_SECRET, cursor=cursor, constraints=constraints,
    )


def expect_search_error(status, code, operation):
    with pytest.raises(PrivateSearchError) as caught:
        operation()
    assert caught.value.status_code == status
    assert caught.value.code == code
    assert "synthetic-private" not in str(caught.value)
    assert "postgresql://" not in str(caught.value)


def assert_envelope(result, *, username, audience, rows, listens, page=1):
    assert set(result) == ENVELOPE_KEYS
    assert result["status"] == ("ready" if result["tracks"] else "empty")
    assert result["private_search"] is True
    assert result["contract_version"] == "listener-history-v1"
    assert result["context_ref"] == CONTEXT_REF
    assert result["presentation"] == "tracks"
    assert result["criteria"] == {
        "subject": {"kind": "username", "username": username},
        "predicate_domain": "tracks", "history": {"period": "all"},
    }
    assert set(result["listener"]) == {"account_ref", "username", "display_name"}
    assert str(uuid.UUID(result["listener"]["account_ref"])) == result["listener"]["account_ref"]
    returned = min(100, max(0, rows - (page - 1) * 100))
    assert set(result["page"]) == {"limit", "number", "returned_count", "total_rows", "has_more", "next_cursor"}
    assert {key: value for key, value in result["page"].items() if key != "next_cursor"} == {
        "limit": 100, "number": page, "returned_count": returned, "total_rows": rows,
        "has_more": page * 100 < rows,
    }
    assert len(result["tracks"]) == returned
    assert (result["page"]["next_cursor"] is not None) is result["page"]["has_more"]
    assert set(result["history"]) == {
        "snapshot_ref", "expires_at", "total_listens", "period_label", "range_label", "coverage",
    }
    assert result["history"]["total_listens"] == listens
    assert datetime.fromisoformat(result["history"]["expires_at"]) == NOW + timedelta(hours=1)
    coverage = result["history"]["coverage"]
    assert set(coverage) == COVERAGE_KEYS
    assert coverage["requested_start"] is None
    assert coverage["requested_end"] == NOW.isoformat()
    assert coverage["complete_for_available_snapshot"] is True
    assert coverage["complete_for_requested_period"] is False
    assert "complete historical coverage is not known" in coverage["label"]
    assert result["native_origin"] == {
        "audience": audience,
        "subject_ref": None if audience == "own" else result["listener"]["account_ref"],
        "kind": "tracks", "period": "all", "snapshot_ref": result["history"]["snapshot_ref"],
    }
    normalized_origin, native_query = normalize_native_origin(result["native_origin"])
    assert normalized_origin == result["native_origin"]
    assert type(native_query) is ActivityQuery
    assert native_query.kind == "tracks" and native_query.period == "all"
    assert native_query.snapshot_ref == result["history"]["snapshot_ref"]
    for row in result["tracks"]:
        assert set(row) == ROW_KEYS
        assert row["id"].startswith("activity_") and len(row["id"]) == 73
        assert row["kind"] == "track" and row["source_readable"] is True
        assert row["rating"] is None and row["detail_ref"] is None and row["artwork_url"] is None
        assert row["allowed_actions"] == {"can_view_details": False}
        assert row["availability"] in {"local", "unresolved"}
    exposed = repr(result)
    for private_fragment in ("synthetic-private", "source_payload", "session_token", "postgresql://", "private_path"):
        assert private_fragment not in exposed


def add_history_rows(state, *, subject=None, count=105):
    """Grow only this mutable fixture's library; retain fixture-owned cleanup."""
    db, data = state["db"], state["data"]
    with db.connect() as connection:
        while len(data["tracks"]) < count:
            index, suffix = len(data["tracks"]), uuid.uuid4().hex
            key = "listener-" + suffix
            track_id = connection.execute("""insert into library.local_tracks(
                library_id,album_id,artist_id,track_key,title,duration_seconds)
                values(%s,%s,%s,%s,%s,240) returning id""",
                (data["library"], data["album"], data["artist"], key, f"Listener {index:04}")).fetchone()["id"]
            track = {"id": track_id, "key": key, "path": f"/synthetic-private-listener/{suffix}.flac"}
            connection.execute("insert into library.local_track_files(track_id,private_path) values(%s,%s)",
                               (track_id, track["path"]))
            data["tracks"].append(track)
            event = db.event(connection, data, track=track, owner=subject,
                             played_at=NOW - timedelta(seconds=index + 1))
            state["events" if subject is None else "peer_events"].append(event)


class SequentialInjectedRuntimeLeases:
    """Injected connector's hint lease, then its retained Home authority lease.

    This records logical overlap only for calls through this connector and
    preserves its Home physical session so advisory locks cannot hide behind
    disconnect. Home's separate direct timezone-settings connection is outside
    these counters. Only one request is made per instance; Home may retry.
    """
    def __init__(self, db, *, before=None, after=None, after_hint=None):
        self.db = db
        self.before, self.after, self.after_hint = before, after, after_hint
        self.home = None
        self.hint_closed = False
        self.active = 0
        self.max_active = 0
        self.events = []
        self.hint_operations = []

    @contextmanager
    def __call__(self, url):
        assert url == self.db.app_url
        assert self.active == 0, "Listener nested a connection inside its current authority lease"
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            if not self.hint_closed:
                assert self.home is None, "Home physical session opened before the hint closed"
                hint = RetainedRuntimeConnection(self.db)
                self.events.append("hint_open")
                try:
                    with hint as connection:
                        yield connection
                finally:
                    self.hint_operations = list(hint.operations)
                    hint.close()
                    assert hint.closed
                    self.hint_closed = True
                    self.events.append("hint_closed")
                if self.after_hint is not None:
                    self.after_hint()
            else:
                if self.home is None:
                    self.home = RetainedRuntimeConnection(self.db, before=self.before, after=self.after)
                    self.events.append("home_open")
                with self.home as connection:
                    yield connection
        finally:
            self.active -= 1

    def close(self):
        if self.home is not None:
            self.home.close()


def assert_no_receipts(state):
    with state["db"].connect() as connection:
        assert connection.execute("select count(*) as n from app.activity_snapshots where account_id=%s",
                                  (state["actor"].account_id,)).fetchone()["n"] == 0


def assert_sequential_injected_leases(leases):
    # This is the injected hint/authority connector, not every database read.
    assert leases.active == 0 and leases.max_active == 1
    assert leases.events[:3] == ["hint_open", "hint_closed", "home_open"]
    assert not any(operation[0] == "sql" and "listen_history" in operation[1]
                   for operation in leases.hint_operations)


def test_self_case_normalized_handle_has_exact_safe_envelope(mutable_ledger):
    state = mutable_ledger
    identity = profile(state["db"], state["actor"].account_id)
    query = "  @" + identity["username_normalized"].upper() + " :TRACKS LISTENED:ALL  "
    result = listener_read(state, query=query)
    assert_envelope(result, username=identity["username_normalized"], audience="own", rows=3, listens=3)
    assert result["query"] == query.strip()
    assert result["listener"] == {
        "account_ref": identity["account_ref"], "username": identity["username_display"],
        "display_name": identity["display_name"],
    }
    assert {row["title"] for row in result["tracks"]} == {"Track 0000", "Track 0001", "Track 0002"}


def test_all_251_rows_continue_without_duplicates_and_preserve_home_receipt(static_ledger, own_actor):
    state = {**static_ledger, "actor": own_actor}
    username = profile(state["db"], own_actor.account_id)["username_normalized"]
    pages, cursor = [], None
    for number in (1, 2, 3):
        result = listener_read(state, query="@" + username, cursor=cursor)
        assert_envelope(result, username=username, audience="own", rows=251, listens=253, page=number)
        home = read_home_receipt(state["db"], own_actor,
            snapshot_ref=result["history"]["snapshot_ref"], page=number)["data"]
        assert result["tracks"] == home["rows"]
        assert result["history"] == {key: home[key] for key in result["history"]}
        pages.append(result)
        cursor = result["page"]["next_cursor"]
    assert cursor is None
    assert [len(page["tracks"]) for page in pages] == [100, 100, 51]
    assert len({row["id"] for page in pages for row in page["tracks"]}) == 251
    assert len({page["history"]["snapshot_ref"] for page in pages}) == 1
    assert pages[0]["history"]["coverage"]["source_families"] == sorted([MEASURED, LEGACY, BACKFILL])
    assert all(page["native_origin"] == pages[0]["native_origin"] for page in pages)
    # Replay is the same frozen second page, not another capture.
    replay = listener_read(state, query="@" + username, cursor=pages[0]["page"]["next_cursor"])
    assert replay["tracks"] == pages[1]["tracks"]
    assert replay["history"] == pages[1]["history"]


def test_known_empty_listener_keeps_truthful_coverage(static_ledger):
    db = static_ledger["db"]
    with db.session(static_ledger["empty"], static_ledger["data"]["library"]) as actor:
        state = {**static_ledger, "actor": actor}
        username = profile(db, actor.account_id)["username_normalized"]
        result = listener_read(state, query="@" + username)
        assert_envelope(result, username=username, audience="own", rows=0, listens=0)
        assert result["history"]["coverage"]["observed_start"] is None
        assert result["history"]["coverage"]["observed_end"] is None
        assert result["history"]["coverage"]["source_families"] == []


def test_accepted_friend_has_only_selected_history_and_friend_origin(social_ledger):
    state = social_ledger
    username = profile(state["db"], state["peer"])["username_normalized"]
    result = listener_read(state, subject=state["peer"])
    assert_envelope(result, username=username, audience="friend", rows=2, listens=2)
    assert result["listener"]["account_ref"] == state["peer_ref"]
    assert "Track 0002" not in {row["title"] for row in result["tracks"]}
    assert listener_read(state)["history"]["total_listens"] == 3


def test_friend_continuation_spans_more_than_one_hundred_rows(social_ledger):
    state = social_ledger
    add_history_rows(state, subject=state["peer"])
    username = profile(state["db"], state["peer"])["username_normalized"]
    first = listener_read(state, subject=state["peer"])
    second = listener_read(state, subject=state["peer"], cursor=first["page"]["next_cursor"])
    # Two fixture peer tracks plus 102 new tracks; the viewer's third is excluded.
    assert_envelope(first, username=username, audience="friend", rows=104, listens=104)
    assert_envelope(second, username=username, audience="friend", rows=104, listens=104, page=2)
    assert len({row["id"] for result in (first, second) for row in result["tracks"]}) == 104
    assert second["native_origin"] == first["native_origin"]


@pytest.mark.parametrize("change", ["former_friend", "viewer_browse", "subject_browse", "subject_membership", "subject_disabled"])
@pytest.mark.parametrize("continuation", [False, True])
def test_current_friend_authority_is_required_at_capture_and_continuation(social_ledger, change, continuation):
    state = social_ledger
    username = profile(state["db"], state["peer"])["username_normalized"]
    cursor = None
    if continuation:
        add_history_rows(state, subject=state["peer"])
        cursor = listener_read(state, subject=state["peer"])["page"]["next_cursor"]
        assert cursor
    with state["db"].connect() as connection:
        if change == "former_friend":
            connection.execute("update app.friend_connections set state='removed',revision=revision+1 "
                               "where library_id=%s and low_account_id=%s and high_account_id=%s", state["pair"])
        elif change in {"viewer_browse", "subject_browse"}:
            account = state["actor"].account_id if change == "viewer_browse" else state["peer"]
            connection.execute("update app.capabilities set revoked_at=clock_timestamp() where account_id=%s and capability_key=any(%s)",
                               (account, sorted(grant_keys_for_action("library.browse.read"))))
        elif change == "subject_membership":
            connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s",
                               (state["peer"], state["data"]["library"]))
        else:
            connection.execute("update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s", (state["peer"],))
    expect_search_error(403, "private_search_forbidden",
                        lambda: listener_read(state, query="@" + username, cursor=cursor))


def test_browse_only_accepted_members_keep_intrinsic_history_without_coarse_social_grants(social_ledger):
    state = social_ledger
    with state["db"].connect() as connection:
        connection.execute("update app.capabilities set revoked_at=clock_timestamp() "
            "where account_id=any(%s) and capability_key='capability.social'",
            ([state["actor"].account_id, state["peer"]],))
    state = {**state, "actor": replace(state["actor"], capability_grants=tuple(
        grant for grant in state["actor"].capability_grants if grant.capability_key != "capability.social"))}
    result = listener_read(state, subject=state["peer"])
    assert result["history"]["total_listens"] == result["page"]["total_rows"] == 2
    assert result["listener"]["account_ref"] == state["peer_ref"]


def test_cross_library_handle_cannot_select_history(mutable_ledger):
    state, db = mutable_ledger, mutable_ledger["db"]
    with db.connect() as connection:
        foreign = db.account(connection)
        other = db.catalog(connection, foreign)
        db.event(connection, other)
    expect_search_error(403, "private_search_forbidden", lambda: listener_read(state, subject=foreign))
    assert_no_receipts(state)


@pytest.mark.parametrize("subject", ["self", "friend"])
def test_caller_target_injection_is_rejected_before_lookup(social_ledger, subject):
    state = social_ledger
    query = "@" + profile(state["db"], state["peer"] if subject == "friend" else state["actor"].account_id)["username_normalized"]
    leases = SequentialInjectedRuntimeLeases(state["db"])
    try:
        expect_search_error(403, "private_search_forbidden", lambda: listener_read(
            state, query=query, connect=leases, context=replace(context_for(state["actor"]), target_account_id=state["peer"])))
        assert leases.events == []
        assert_no_receipts(state)
    finally:
        leases.close()


@pytest.mark.parametrize("change", ["renamed", "reassigned", "disabled", "membership"])
@pytest.mark.parametrize("continuation", [False, True])
def test_stale_hint_fails_exact_locked_mapping_before_ledger(mutable_ledger, change, continuation):
    state, db = mutable_ledger, mutable_ledger["db"]
    actor = state["actor"]
    username = profile(db, actor.account_id)["username_normalized"]
    cursor = None
    if continuation:
        add_history_rows(state)
        cursor = listener_read(state)["page"]["next_cursor"]
    with db.connect() as connection:
        replacement = db.account(connection)
        db.membership(connection, replacement, state["data"]["library"])
    def change_hint():
        with db.connect() as connection:
            if change in {"renamed", "reassigned"}:
                renamed = "listener-" + uuid.uuid4().hex
                connection.execute("update app.accounts set username_display=%s,username_normalized=%s where id=%s",
                                   (renamed, renamed, actor.account_id))
                if change == "reassigned":
                    connection.execute("update app.accounts set username_display=%s,username_normalized=%s where id=%s",
                                       (username, username, replacement))
            elif change == "disabled":
                connection.execute("update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s", (actor.account_id,))
            else:
                connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s",
                                   (actor.account_id, state["data"]["library"]))
    leases = SequentialInjectedRuntimeLeases(db, after_hint=change_hint)
    try:
        expect_search_error(403, "private_search_forbidden",
                            lambda: listener_read(state, query="@" + username, cursor=cursor, connect=leases))
        assert_sequential_injected_leases(leases)
        assert not any(operation[0] == "sql" and "from integration.listen_history h" in operation[1]
                       for operation in leases.home.operations)
        assert not any(operation[0] == "sql" and "select payload from app.activity_snapshot_rows" in operation[1]
                       for operation in leases.home.operations)
        assert_capture_lock_released(db, actor.account_id)
        if not continuation:
            assert_no_receipts(state)
    finally:
        leases.close()


def deny_resource(kind, reference, seen=None):
    def constraints(context):
        if context.resource is not None:
            resource = (context.resource.resource_kind, context.resource.resource_ref)
            if seen is not None:
                seen.add(resource)
            if resource == (kind, str(reference)):
                return PolicyEvaluationConstraints(request_origin_allowed=False)
        return PolicyEvaluationConstraints()
    return constraints


@pytest.mark.parametrize("kind", ["listen_history", "track", "album", "artist"])
@pytest.mark.parametrize("friend", [False, True])
def test_event_and_parent_resource_policy_denies_filter_before_totals(social_ledger, kind, friend):
    state = social_ledger
    event = state["peer_events"][0] if friend else state["events"][0]
    target = {"listen_history": event, "track": state["data"]["tracks"][0]["id"],
              "album": state["data"]["album"], "artist": state["data"]["artist"]}[kind]
    seen = set()
    result = listener_read(state, subject=state["peer"] if friend else None,
                           constraints=deny_resource(kind, target, seen))
    expected = 0 if kind in {"album", "artist"} else (1 if friend else 2)
    assert result["history"]["total_listens"] == expected
    assert result["page"]["total_rows"] == len(result["tracks"]) == expected
    assert (kind, str(target)) in seen
    assert ("account", str(state["peer"] if friend else state["actor"].account_id)) in seen


@pytest.mark.parametrize("kind", ["listen_history", "track", "album", "artist", "account"])
def test_changed_custom_policy_rejects_entire_continuation_including_off_page_rows(mutable_ledger, kind):
    state = mutable_ledger
    add_history_rows(state, count=251)
    first = listener_read(state)
    # The oldest newly added event lies on page 3, outside the requested page 2.
    target = {"listen_history": state["events"][-1], "track": state["data"]["tracks"][-1]["id"],
              "album": state["data"]["album"], "artist": state["data"]["artist"],
              "account": state["actor"].account_id}[kind]
    status, code = (403, "private_search_forbidden") if kind == "account" else (409, "search_cursor_restart_required")
    expect_search_error(status, code, lambda: listener_read(state, cursor=first["page"]["next_cursor"],
                                                           constraints=deny_resource(kind, target)))


@pytest.mark.parametrize("change", ["idle", "absolute", "revoked", "browse"])
@pytest.mark.parametrize("continuation", [False, True])
def test_real_session_and_grant_changes_deny_even_a_stale_active_actor(mutable_ledger, change, continuation):
    state, db, actor = mutable_ledger, mutable_ledger["db"], mutable_ledger["actor"]
    cursor = None
    if continuation:
        add_history_rows(state)
        cursor = listener_read(state)["page"]["next_cursor"]
    with db.connect() as connection:
        if change in {"idle", "absolute"}:
            expire_session_with_database_clock(connection, actor.session_id, change)
            stored = connection.execute("select idle_expires_at,clock_timestamp() as checked from app.account_sessions where id=%s",
                                        (actor.session_id,)).fetchone()
            assert NOW < stored["idle_expires_at"] <= stored["checked"]
        elif change == "revoked":
            connection.execute("update app.account_sessions set revoked_at=clock_timestamp() where id=%s", (actor.session_id,))
        else:
            connection.execute("update app.capabilities set revoked_at=clock_timestamp() "
                               "where account_id=%s and capability_key='library.browse.read'", (actor.account_id,))
    expect_search_error(403, "private_search_forbidden", lambda: listener_read(state, cursor=cursor, now=NOW))
    if not continuation:
        assert_no_receipts(state)


@pytest.mark.parametrize("change", ["source_update", "source_delete", "inventory_title", "inventory_file", "receipt_delete", "receipt_expiry"])
def test_real_source_inventory_and_receipt_changes_require_restart(mutable_ledger, change):
    state, db = mutable_ledger, mutable_ledger["db"]
    add_history_rows(state)
    first = listener_read(state)
    with db.connect() as connection:
        if change == "source_update":
            connection.execute("update integration.listen_history set finalized=false where id=%s", (state["events"][0],))
        elif change == "source_delete":
            connection.execute("delete from integration.listen_history where id=%s", (state["events"][0],))
        elif change == "inventory_title":
            connection.execute("update library.local_tracks set title='Repaired listener title' where id=%s", (state["data"]["tracks"][0]["id"],))
        elif change == "inventory_file":
            connection.execute("update library.local_track_files set metadata='{\"scan_cache\":{\"stale\":true}}'::jsonb where track_id=%s",
                               (state["data"]["tracks"][0]["id"],))
        elif change == "receipt_delete":
            connection.execute("delete from app.activity_snapshots where account_id=%s", (state["actor"].account_id,))
    expect_search_error(409, "search_cursor_restart_required", lambda: listener_read(
        state, cursor=first["page"]["next_cursor"], now=NOW + timedelta(hours=1) if change == "receipt_expiry" else NOW))


def test_refriending_revision_does_not_revive_listener_cursor(social_ledger):
    state = social_ledger
    add_history_rows(state, subject=state["peer"])
    first = listener_read(state, subject=state["peer"])
    for relationship in ("removed", "accepted"):
        with state["db"].connect() as connection:
            connection.execute("update app.friend_connections set state=%s,revision=revision+1 "
                "where library_id=%s and low_account_id=%s and high_account_id=%s", (relationship, *state["pair"]))
    expect_search_error(409, "search_cursor_restart_required",
        lambda: listener_read(state, subject=state["peer"], cursor=first["page"]["next_cursor"]))
    fresh = listener_read(state, subject=state["peer"])
    assert fresh["history"]["snapshot_ref"] != first["history"]["snapshot_ref"]
    assert fresh["history"]["total_listens"] == 104


@pytest.mark.parametrize("friend", [False, True])
def test_injected_connector_capture_lock_commit_repeatable_read_profile_ledger_and_session_order(social_ledger, friend):
    state, db = social_ledger, social_ledger["db"]
    subject = state["peer"] if friend else state["actor"].account_id
    leases = SequentialInjectedRuntimeLeases(db)
    try:
        result = listener_read(state, subject=subject, connect=leases)
        assert result["status"] == "ready"
        assert_sequential_injected_leases(leases)
        operations = leases.home.operations
        indices = lambda fragment: [index for index, operation in enumerate(operations)
                                   if operation[0] == "sql" and fragment in operation[1]]
        gates, isolation = indices("pg_advisory_lock("), indices("set transaction isolation level repeatable read")
        profiles = indices("for share of a,m,p")
        ledger = indices("from integration.listen_history h")
        sessions = [index for index in indices("from app.account_sessions") if "for share nowait" in operations[index][1]]
        assert gates and len(isolation) == 1 and len(profiles) == 2 and ledger and len(sessions) == 1
        expected_accounts = sorted({state["actor"].account_id, subject})
        assert [operations[index][2] for index in gates] == [(f"home-activity:{account}",) for account in expected_accounts]
        assert max(gates) < isolation[0] < profiles[0] < min(ledger) < sessions[0] < profiles[-1]
        assert ("commit",) in operations[max(gates) + 1:isolation[0]]
        assert ("commit",) in operations[profiles[-1] + 1:]
        for index in profiles:
            assert operations[index][2] == (state["data"]["library"], subject,
                                            result["criteria"]["subject"]["username"])
        assert "clock_timestamp()" in operations[sessions[0]][1]
        assert operations[sessions[0]][2] == (state["actor"].session_id, state["actor"].account_id)
        assert not any(operation[0] == "sql" and "account_sessions" in operation[1]
                       and "for update" in operation[1] for operation in operations)
        assert leases.home.closed is False
        for account in expected_accounts:
            assert_capture_lock_released(db, account)
    finally:
        leases.close()


@pytest.mark.parametrize("change", ["idle", "absolute", "revoked", "browse"])
@pytest.mark.parametrize("continuation", [False, True])
def test_authority_changed_during_real_capture_or_page_never_escapes_final_session_check(mutable_ledger, change, continuation):
    state, db, actor = mutable_ledger, mutable_ledger["db"], mutable_ledger["actor"]
    cursor = None
    if continuation:
        add_history_rows(state)
        cursor = listener_read(state)["page"]["next_cursor"]
    captured, release = Event(), Event()
    paused = False
    def after(sql):
        nonlocal paused
        gate = "from app.activity_snapshots" in sql and "for share nowait" in sql if continuation else "from integration.listen_history h" in sql
        if gate and not paused:
            paused = True
            captured.set()
            assert release.wait(10), "Authority-race reader was not released"
    leases = SequentialInjectedRuntimeLeases(db, after=after)
    try:
        with ThreadPoolExecutor(max_workers=1) as workers:
            future = workers.submit(listener_read, state, cursor=cursor, connect=leases)
            try:
                assert captured.wait(10), "Reader did not reach the real capture/page SQL"
                with db.connect() as connection:
                    if change in {"idle", "absolute"}:
                        expire_session_with_database_clock(connection, actor.session_id, change)
                    elif change == "revoked":
                        connection.execute("update app.account_sessions set revoked_at=clock_timestamp() where id=%s", (actor.session_id,))
                    else:
                        connection.execute("update app.capabilities set revoked_at=clock_timestamp() "
                            "where account_id=%s and capability_key='library.browse.read'", (actor.account_id,))
                release.set()
                expect_search_error(403, "private_search_forbidden", lambda: future.result(timeout=20))
            finally:
                release.set()
        assert_sequential_injected_leases(leases)
        assert_capture_lock_released(db, actor.account_id)
        if not continuation:
            assert_no_receipts(state)
    finally:
        leases.close()


def wait_for_real_postgres_lock(db, *, blocked_pid, blocker_pid):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        with db.connect() as connection:
            blocked = connection.execute("select %s=any(pg_blocking_pids(%s)) as blocked",
                                         (blocker_pid, blocked_pid)).fetchone()["blocked"]
        if blocked:
            return
        time.sleep(0.02)
    raise AssertionError("Worker never demonstrably waited on the other reader's real PostgreSQL lock")


@pytest.mark.parametrize("gate", ["profile", "session"])
def test_locked_profile_and_final_actual_session_share_hold_until_reader_commit(mutable_ledger, gate):
    state, db, actor = mutable_ledger, mutable_ledger["db"], mutable_ledger["actor"]
    username = profile(db, actor.account_id)["username_normalized"]
    locked, release, writer_started, writer_committed = Event(), Event(), Event(), Event()
    writer_pid = []
    paused = False
    def after(sql):
        nonlocal paused
        match = "for share of a,m,p" in sql if gate == "profile" else "from app.account_sessions" in sql and "for share nowait" in sql
        if match and not paused:
            paused = True
            locked.set()
            assert release.wait(10), "Locked listener reader was not released"
    def write():
        with db.connect() as connection:
            connection.execute("set local statement_timeout=15000")
            writer_pid.append(connection.info.backend_pid)
            writer_started.set()
            if gate == "profile":
                new_name = "listener-" + uuid.uuid4().hex
                connection.execute("update app.accounts set username_display=%s,username_normalized=%s where id=%s",
                                   (new_name, new_name, actor.account_id))
            else:
                connection.execute("update app.account_sessions set revoked_at=clock_timestamp() where id=%s", (actor.session_id,))
        writer_committed.set()
    leases = SequentialInjectedRuntimeLeases(db, after=after)
    try:
        with ThreadPoolExecutor(max_workers=2) as workers:
            reader = workers.submit(listener_read, state, query="@" + username, connect=leases)
            try:
                assert locked.wait(10), "Reader did not acquire the selected real SHARE lock"
                writer = workers.submit(write)
                assert writer_started.wait(10)
                wait_for_real_postgres_lock(db, blocked_pid=writer_pid[0], blocker_pid=leases.home.info.backend_pid)
                assert not writer_committed.is_set()
                release.set()
                result = reader.result(timeout=20)
                writer.result(timeout=20)
                assert writer_committed.is_set()
            finally:
                release.set()
        assert result["status"] == "ready"
        assert result["listener"]["username"] == username
        assert_sequential_injected_leases(leases)
        assert_capture_lock_released(db, actor.account_id)
        expect_search_error(403, "private_search_forbidden", lambda: listener_read(state, query="@" + username))
    finally:
        leases.close()


def test_source_change_during_listener_capture_retries_real_receipt_without_orphans(mutable_ledger):
    state, db, actor = mutable_ledger, mutable_ledger["db"], mutable_ledger["actor"]
    # Establish revision rows before opening the racing writer, using actual SQL.
    listener_read(state)
    with db.connect() as connection:
        connection.execute("delete from app.activity_snapshots where account_id=%s", (actor.account_id,))
    captured, release = Event(), Event()
    paused = False
    def after(sql):
        nonlocal paused
        if "from integration.listen_history h" in sql and not paused:
            paused = True
            captured.set()
            assert release.wait(10), "Source-race listener capture was not released"
    leases = SequentialInjectedRuntimeLeases(db, after=after)
    try:
        with ThreadPoolExecutor(max_workers=1) as workers:
            future = workers.submit(listener_read, state, connect=leases)
            try:
                assert captured.wait(10), "Listener reader did not reach its real ledger query"
                with db.connect() as connection:
                    connection.execute("update integration.listen_history set finalized=false where id=%s", (state["events"][0],))
                release.set()
                result = future.result(timeout=20)
            finally:
                release.set()
        assert result["history"]["total_listens"] == result["page"]["total_rows"] == 2
        with db.connect() as connection:
            stored = connection.execute("select ready,total_listens,total_rows from app.activity_snapshots where account_id=%s",
                                        (actor.account_id,)).fetchall()
        assert stored == [{"ready": True, "total_listens": 2, "total_rows": 2}]
        assert sum(operation[0] == "sql" and "set transaction isolation level repeatable read" in operation[1]
                   for operation in leases.home.operations) == 2
        assert_sequential_injected_leases(leases)
        assert_capture_lock_released(db, actor.account_id)
    finally:
        leases.close()


@pytest.mark.parametrize("failure", ["projection", "unlock"])
def test_listener_failure_releases_physical_capture_lock_and_no_partial_receipt(mutable_ledger, failure):
    state, db, actor = mutable_ledger, mutable_ledger["db"], mutable_ledger["actor"]
    def before(sql):
        if failure == "unlock" and "pg_advisory_unlock(" in sql:
            raise RuntimeError("synthetic listener unlock transport failure")
    def constraints(context):
        if failure == "projection" and context.resource is not None and context.resource.resource_kind == "listen_history":
            raise RuntimeError("synthetic listener projection failure")
        return PolicyEvaluationConstraints()
    leases = SequentialInjectedRuntimeLeases(db, before=before)
    try:
        with pytest.raises(RuntimeError, match="synthetic listener " + failure):
            listener_read(state, connect=leases, constraints=constraints)
        assert_sequential_injected_leases(leases)
        assert leases.home.closed is (failure == "unlock")
        assert_capture_lock_released(db, actor.account_id)
        if failure == "projection":
            assert_no_receipts(state)
        else:
            # Cleanup uncertainty follows a committed receipt, never partial rows.
            with db.connect() as connection:
                stored = connection.execute("select ready,total_rows from app.activity_snapshots where account_id=%s", (actor.account_id,)).fetchall()
            assert stored == [{"ready": True, "total_rows": 3}]
    finally:
        leases.close()


@pytest.mark.parametrize("first", ["home", "listener"])
def test_home_and_listener_capture_share_the_real_gate_in_both_orders(mutable_ledger, first):
    state, db, actor = mutable_ledger, mutable_ledger["db"], mutable_ledger["actor"]
    captured, release, second_attempting = Event(), Event(), Event()
    paused = False
    def pause_first(sql):
        nonlocal paused
        if "from integration.listen_history h" in sql and not paused:
            paused = True
            captured.set()
            assert release.wait(10), "First Home/Listener capture was not released"
    def note_second(sql):
        if "pg_advisory_lock(" in sql:
            second_attempting.set()
    home = RetainedRuntimeConnection(db,
        before=note_second if first == "listener" else None,
        after=pause_first if first == "home" else None)
    leases = SequentialInjectedRuntimeLeases(db,
        before=note_second if first == "home" else None,
        after=pause_first if first == "listener" else None)
    home_repository = retained_repository(db, home)
    def run_home():
        return read_home_receipt(db, actor, repository=home_repository)["data"]
    def run_listener():
        return listener_read(state, connect=leases)["history"]
    try:
        with ThreadPoolExecutor(max_workers=2) as workers:
            try:
                leading = workers.submit(run_home if first == "home" else run_listener)
                assert captured.wait(10), "Leading reader did not reach its real ledger query"
                following = workers.submit(run_listener if first == "home" else run_home)
                assert second_attempting.wait(10), "Following reader did not attempt the shared capture gate"
                first_connection, second_connection = (home, leases.home) if first == "home" else (leases.home, home)
                wait_for_real_postgres_lock(db, blocked_pid=second_connection.info.backend_pid,
                                           blocker_pid=first_connection.info.backend_pid)
                assert not any(operation[0] == "sql" and "set transaction isolation level repeatable read" in operation[1]
                               for operation in second_connection.operations)
                release.set()
                first_result, second_result = leading.result(timeout=20), following.result(timeout=20)
            finally:
                release.set()
        assert first_result["total_listens"] == second_result["total_listens"] == 3
        assert first_result["snapshot_ref"] != second_result["snapshot_ref"]
        for connection in (home, leases.home):
            operations = connection.operations
            lock_index = next(index for index, operation in enumerate(operations)
                              if operation[0] == "sql" and "pg_advisory_lock(" in operation[1])
            isolation_index = next(index for index, operation in enumerate(operations)
                                   if operation[0] == "sql" and "set transaction isolation level repeatable read" in operation[1])
            assert lock_index < isolation_index
            assert ("commit",) in operations[lock_index + 1:isolation_index]
            assert connection.closed is False
        assert_sequential_injected_leases(leases)
        with db.connect() as connection:
            assert connection.execute("select count(*) as n from app.activity_snapshots where account_id=%s and ready",
                                      (actor.account_id,)).fetchone()["n"] == 2
        # Both complete captures remain valid in the same unchanged Home owner.
        for result in (first_result, second_result):
            assert read_home_receipt(db, actor, snapshot_ref=result["snapshot_ref"], page=1)["data"]["total_listens"] == 3
        assert_capture_lock_released(db, actor.account_id)
    finally:
        release.set()
        home.close()
        leases.close()


def test_denied_event_does_not_hide_an_independently_allowed_meaningful_event_for_same_track(mutable_ledger):
    state, db = mutable_ledger, mutable_ledger["db"]
    with db.connect() as connection:
        allowed_event = db.event(connection, state["data"], played_at=NOW - timedelta(seconds=1))
    seen = set()
    result = listener_read(state, constraints=deny_resource("listen_history", state["events"][0], seen))
    assert result["history"]["total_listens"] == 3
    assert result["page"]["total_rows"] == len(result["tracks"]) == 3
    same_track = [row for row in result["tracks"] if row["title"] == "Track 0000"]
    assert len(same_track) == 1 and same_track[0]["listen_count"] == 1
    assert ("listen_history", str(state["events"][0])) in seen
    assert ("listen_history", str(allowed_event)) in seen


def test_short_unfinalized_and_unresolved_history_keeps_home_meaningful_identity_semantics(mutable_ledger):
    state, db = mutable_ledger, mutable_ledger["db"]
    with db.connect() as connection:
        db.event(connection, state["data"], seconds=9)
        db.event(connection, state["data"], seconds=20, finalized=False)
        missing = "unresolved-listener-" + uuid.uuid4().hex
        event = db.event(connection, state["data"], source=LEGACY,
            payload={"title": "Unresolved listener evidence", "path": "/synthetic-private-listener/" + missing,
                     "track_ref": "/synthetic-private-listener/" + missing})
        connection.execute("update integration.listen_history set track_id=null,track_key=%s where id=%s", (missing, event))
    result = listener_read(state)
    assert result["history"]["total_listens"] == result["page"]["total_rows"] == 4
    unresolved = [row for row in result["tracks"] if row["title"] == "Unresolved listener evidence"]
    assert len(unresolved) == 1
    assert unresolved[0]["availability"] == "unresolved"
    assert unresolved[0]["duration_seconds"] is None
    assert unresolved[0]["rating"] is None and unresolved[0]["detail_ref"] is None
    assert unresolved[0]["allowed_actions"] == {"can_view_details": False}
    assert all(row["listen_count"] == 1 for row in result["tracks"])
    assert "synthetic-private" not in repr(result)


def test_unknown_handle_closes_hint_without_opening_home_or_creating_receipt(mutable_ledger):
    state = mutable_ledger
    leases = SequentialInjectedRuntimeLeases(state["db"])
    try:
        expect_search_error(403, "private_search_forbidden", lambda: listener_read(
            state, query="@missing-" + uuid.uuid4().hex, connect=leases))
        assert leases.events == ["hint_open", "hint_closed"]
        assert leases.hint_closed and leases.home is None
        assert leases.active == 0 and leases.max_active == 1
        assert_no_receipts(state)
    finally:
        leases.close()


@pytest.mark.parametrize("binding", ["account_ref", "relationship_revision"])
def test_signed_cursor_still_requires_actual_locked_subject_and_relationship_binding(social_ledger, binding):
    state = social_ledger
    add_history_rows(state, subject=state["peer"])
    first = listener_read(state, subject=state["peer"])
    payload = decode_listener_cursor(first["page"]["next_cursor"], secret=CURSOR_SECRET)
    if binding == "account_ref":
        payload["scope"][binding] = str(uuid.uuid4())
    else:
        payload["scope"][binding] += 1
    cursor = encode_listener_cursor(payload["snapshot_ref"], payload["page"],
                                   secret=CURSOR_SECRET, scope=payload["scope"])
    leases = SequentialInjectedRuntimeLeases(state["db"])
    try:
        expect_search_error(409, "search_cursor_restart_required", lambda: listener_read(
            state, subject=state["peer"], cursor=cursor, connect=leases))
        assert_sequential_injected_leases(leases)
        assert any(operation[0] == "sql" and "for share of a,m,p" in operation[1]
                   for operation in leases.home.operations)
        assert not any(operation[0] == "sql" and (
            "from integration.listen_history h" in operation[1]
            or "select payload from app.activity_snapshot_rows" in operation[1])
            for operation in leases.home.operations)
    finally:
        leases.close()


def test_handle_reassigned_to_another_current_accepted_friend_requires_restart(social_ledger):
    state, db = social_ledger, social_ledger["db"]
    add_history_rows(state, subject=state["peer"])
    username = profile(db, state["peer"])["username_normalized"]
    first = listener_read(state, query="@" + username)
    with db.connect() as connection:
        replacement = db.account(connection)
        db.membership(connection, replacement, state["data"]["library"])
        low, high = sorted((state["actor"].account_id, replacement))
        connection.execute("""insert into app.friend_connections(
            library_id,low_account_id,high_account_id,requester_account_id,state,origin)
            values(%s,%s,%s,%s,'accepted','request')""",
            (state["data"]["library"], low, high, state["actor"].account_id))
        renamed = "listener-" + uuid.uuid4().hex
        connection.execute("update app.accounts set username_display=%s,username_normalized=%s where id=%s",
                           (renamed, renamed, state["peer"]))
        connection.execute("update app.accounts set username_display=%s,username_normalized=%s where id=%s",
                           (username, username, replacement))
    leases = SequentialInjectedRuntimeLeases(db)
    try:
        expect_search_error(409, "search_cursor_restart_required", lambda: listener_read(
            state, query="@" + username, cursor=first["page"]["next_cursor"], connect=leases))
        assert_sequential_injected_leases(leases)
        assert not any(operation[0] == "sql" and (
            "from integration.listen_history h" in operation[1]
            or "select payload from app.activity_snapshot_rows" in operation[1])
            for operation in leases.home.operations)
        refreshed = listener_read(state, query="@" + username)
        assert refreshed["listener"]["account_ref"] == profile(db, replacement)["account_ref"]
        assert refreshed["listener"]["account_ref"] != first["listener"]["account_ref"]
        assert refreshed["status"] == "empty" and refreshed["page"]["total_rows"] == 0
    finally:
        leases.close()
