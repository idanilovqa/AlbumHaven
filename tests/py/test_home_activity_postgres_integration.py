"""Synthetic own-activity read receipts against real isolated Postgres tables.

Authoring this file does not authorize database execution. The QA owner supplies
both TCP-only isolated URLs and an already migrated database before admission.
No provider is contacted, no application runtime is replaced, and every source
mutation belongs to its test's uniquely created account and library.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import os
import random
import re
from urllib.parse import urlparse
import uuid

import pytest

from music_app.services import home_activity as activity
from music_app.services.allowed_actions import AllowedActions
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.home_activity_postgres import HomeActivityPostgresRepository

# The isolated database is same-host TCP. Anchor this suite's source and
# receipt times together so real trigger expiry agrees with injected reads.
# Deterministic civil-calendar cases stay fixed in the pure test module.
NOW = datetime.now(timezone.utc)
MEASURED = "rendered_local_listen_session"
LEGACY = "runtime_listen_history_adapter"
BACKFILL = "phase_6_json_file_backfill"


def allow_all(_kind, _resource_id):
    return AllowedActions(("library.browse.read",))


# Models the installed default evaluator, whose current durable grants and
# admission are scope-wide. Custom narrowing callbacks deliberately omit it.
allow_all.scope_wide = True


class ActivityDatabase:
    def __init__(self, app_url, setup_url):
        self.app_url = app_url
        self.setup_url = setup_url
        self.config = {"ALBUM_HAVEN_APP_DATABASE_URL": app_url}
        self.accounts = []
        self.libraries = []
        self.events = []
        self.token = uuid.uuid4().hex

    def connect(self):
        import psycopg
        from psycopg.rows import dict_row
        return psycopg.connect(self.setup_url, row_factory=dict_row)

    def account(self, connection):
        name = "activity-" + uuid.uuid4().hex
        account_id = connection.execute(
            "insert into app.accounts(display_name,account_kind,username_display,username_normalized,contact_email,contact_email_normalized) "
            "values(%s,'managed_user',%s,%s,%s,%s) returning id",
            (name, name, name, name + "@example.test", name + "@example.test"),
        ).fetchone()["id"]
        self.accounts.append(account_id)
        connection.execute("insert into integration.lastfm_settings(account_id,timezone_name) values(%s,'UTC')", (account_id,))
        return account_id

    def membership(self, connection, account_id, library_id):
        connection.execute(
            "insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'member')",
            (account_id, library_id),
        )
        connection.execute(
            "insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,'library.browse.read','library',%s)",
            (account_id, library_id),
        )

    def catalog(self, connection, owner, *, count=1):
        suffix = uuid.uuid4().hex
        library_id = connection.execute(
            "insert into library.libraries(owner_account_id,name) values(%s,%s) returning id", (owner, "Activity " + suffix),
        ).fetchone()["id"]
        self.libraries.append(library_id)
        self.membership(connection, owner, library_id)
        artist_id = connection.execute(
            "insert into library.local_artists(library_id,artist_key,name) values(%s,%s,'Canonical artist') returning id",
            (library_id, "artist-" + suffix),
        ).fetchone()["id"]
        album_id = connection.execute(
            "insert into library.local_albums(library_id,artist_id,album_key,title) values(%s,%s,%s,'Canonical album') returning id",
            (library_id, artist_id, "album-" + suffix),
        ).fetchone()["id"]
        tracks = []
        for index in range(count):
            key = f"activity-{suffix}-{index:04}"
            track_id = connection.execute(
                "insert into library.local_tracks(library_id,album_id,artist_id,track_key,title,duration_seconds) values(%s,%s,%s,%s,%s,240) returning id",
                (library_id, album_id, artist_id, key, f"Track {index:04}"),
            ).fetchone()["id"]
            path = f"/synthetic-private-activity/{suffix}/{index:04}.flac"
            connection.execute("insert into library.local_track_files(track_id,private_path) values(%s,%s)", (track_id, path))
            tracks.append({"id": track_id, "key": key, "path": path, "title": f"Track {index:04}"})
        return {"account": owner, "library": library_id, "artist": artist_id, "album": album_id, "tracks": tracks}

    def event(self, connection, data, *, track=None, owner=None, source=MEASURED, played_at=None, seconds=12.5, finalized=True, payload=None):
        from psycopg.types.json import Jsonb
        selected = data["tracks"][0] if track is None else track
        measured = source == MEASURED
        contents = {
            "title": "Original event title", "artist": "Original artist", "album": "Original album",
            "album_artist": "Original artist", "path": selected["path"], "track_ref": selected["path"],
            "total_listened_seconds": seconds, "max_contiguous_seconds": seconds,
            "source_provenance": {"kind": "local_playback"},
            "private_provider_token": "synthetic-private-token-" + self.token,
        }
        contents.update(payload or {})
        event_id = connection.execute(
            "insert into integration.listen_history(account_id,library_id,track_id,track_key,played_at,source_family,source_entry_id,"
            "measurement_version,measured_listened_seconds,max_measured_contiguous_seconds,finalized,last_sequence,device_id,session_id,metadata) "
            "values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id",
            (data["account"] if owner is None else owner, data["library"], selected["id"], selected["key"],
             NOW - timedelta(hours=1) if played_at is None else played_at, source, uuid.uuid4().hex,
             "rendered-pcm-v1" if measured else None, seconds if measured else None,
             min(seconds, 10) if measured else None, finalized if measured else None, 1 if measured else None,
             uuid.uuid4() if measured else None, uuid.uuid4() if measured else None, Jsonb({"source_payload": contents})),
        ).fetchone()["id"]
        self.events.append(event_id)
        return event_id

    @contextmanager
    def session(self, account_id, library_id, *, bootstrap=False, membership=True):
        with self.connect() as connection:
            session_id = connection.execute(
                "insert into app.account_sessions(account_id,session_token_hash,created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) "
                "values(%s,%s,%s,%s,%s,%s,%s) returning id",
                (account_id, hashlib.sha256(uuid.uuid4().bytes).digest(), NOW - timedelta(minutes=1), NOW, NOW,
                 NOW + timedelta(hours=12), NOW + timedelta(days=7)),
            ).fetchone()["id"]
        actor = CurrentActor(
            state=ActorState.ACTIVE, account_id=account_id, session_id=session_id, current_library_id=library_id,
            is_bootstrap_owner=bootstrap, library_relationships=(LibraryRelationship(library_id, "member", False),) if membership else (),
            capability_grants=(CapabilityGrant("library.browse.read", "library", library_id),),
        )
        try:
            yield actor
        finally:
            with self.connect() as connection:
                connection.execute("delete from app.activity_snapshots where session_id=%s", (session_id,))
                connection.execute("delete from app.account_sessions where id=%s", (session_id,))

    def close(self):
        with self.connect() as connection:
            if self.accounts:
                connection.execute("delete from app.activity_snapshots where account_id=any(%s)", (self.accounts,))
            if self.events:
                connection.execute("delete from integration.listen_history where id=any(%s)", (self.events,))
            for library_id in self.libraries:
                connection.execute("delete from library.libraries where id=%s", (library_id,))
            for account_id in self.accounts:
                connection.execute("delete from app.accounts where id=%s", (account_id,))


@pytest.fixture(scope="module")
def database_urls():
    app_url = os.environ.get("ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL", "")
    setup_url = os.environ.get("DATABASE_MIGRATOR_URL", "")
    if not app_url:
        pytest.skip("Requires separately admitted isolated Postgres contract database; no database coverage ran")
    parsed = urlparse(app_url)
    setup = urlparse(setup_url)
    assert parsed.scheme in {"postgresql", "postgres"}
    assert parsed.hostname in {"localhost", "127.0.0.1", "::1"}, "A TCP-only isolated database is required"
    assert re.fullmatch(r"(?:album_haven_ci_|pytest_|album_haven_fake_e2e)[a-z0-9_]*", parsed.path.lstrip("/"))
    assert setup.scheme in {"postgresql", "postgres"}
    assert setup.hostname in {"localhost", "127.0.0.1", "::1"}
    assert setup.hostname == parsed.hostname and setup.port == parsed.port and setup.path == parsed.path
    assert not parsed.query and not setup.query, "Connection overrides must not bypass fixture scope guards"
    return app_url, setup_url


@pytest.fixture(scope="module")
def static_ledger(database_urls):
    """One complete read dataset shared by tests; no source facts mutate after yield."""
    db = ActivityDatabase(*database_urls)
    try:
        with db.connect() as connection:
            owner = db.account(connection)
            data = db.catalog(connection, owner, count=251)
            event_ids = [db.event(connection, data, track=track, played_at=NOW - timedelta(seconds=index + 1))
                         for index, track in enumerate(data["tracks"])]
            db.event(connection, data, source=LEGACY)
            db.event(connection, data, source=BACKFILL)
            # Duplicate physical file joins must not multiply either occurrence.
            connection.execute("insert into library.local_track_files(track_id,private_path) values(%s,%s)",
                               (data["tracks"][0]["id"], data["tracks"][0]["path"] + ".alternate"))
            other = db.account(connection)
            db.membership(connection, other, data["library"])
            for _ in range(2):
                db.event(connection, data, owner=other)
            other_library = db.catalog(connection, owner, count=1)
            for _ in range(3):
                db.event(connection, other_library)
            empty = db.account(connection)
            db.membership(connection, empty, data["library"])
        yield {"db": db, "data": data, "other": other, "other_library": other_library, "empty": empty, "events": event_ids}
    finally:
        db.close()


@pytest.fixture
def own_actor(static_ledger):
    with static_ledger["db"].session(static_ledger["data"]["account"], static_ledger["data"]["library"]) as current:
        yield current


@pytest.fixture
def mutable_ledger(database_urls):
    """A whole unique scope for each test that changes source, identity or authority."""
    db = ActivityDatabase(*database_urls)
    try:
        with db.connect() as connection:
            owner = db.account(connection)
            data = db.catalog(connection, owner, count=3)
            events = [db.event(connection, data, track=track, played_at=NOW - timedelta(minutes=index + 1))
                      for index, track in enumerate(data["tracks"])]
        with db.session(owner, data["library"]) as current:
            yield {"db": db, "data": data, "actor": current, "events": events}
    finally:
        db.close()


def read(db, actor, *, kind="tracks", period="all", now=NOW, allowed=allow_all, repository=None, **query):
    return activity.read_home_activity(
        db.config, actor=actor, query=activity.ActivityQuery(kind=kind, period=period, **query),
        allowed_actions_for_resource=allowed, now=now,
        repository=repository if repository is not None else HomeActivityPostgresRepository(db.config),
    )


def error_status(call, status):
    with pytest.raises(activity.HomeActivityError) as caught:
        call()
    assert caught.value.status_code == status
    assert "synthetic-private" not in str(caught.value)


@pytest.mark.parametrize("period", ["six", "year", "all"])
def test_numbered_pages_are_100_rows_stable_for_random_jumps_and_last_partial(static_ledger, own_actor, period):
    db = static_ledger["db"]
    initial = read(db, own_actor, period=period)
    first = initial["data"]
    assert initial["status"] == "ready"
    assert first["pagination"] == {"mode": "numbered", "page": 1, "page_size": 100, "total_rows": 251}
    assert len(first["rows"]) == 100
    assert first["total_listens"] == 253
    assert first["next_cursor"] is None
    pages = {1: first}
    order = [1, 2, 3]
    random.Random(73).shuffle(order)
    for page in order:
        result = read(db, own_actor, period=period, snapshot_ref=first["snapshot_ref"], page=page)["data"]
        assert result["pagination"] == {"mode": "numbered", "page": page, "page_size": 100, "total_rows": 251}
        assert result["snapshot_ref"] == first["snapshot_ref"]
        assert result["total_listens"] == 253
        assert result["next_cursor"] is None
        pages[page] = result
    assert pages[1] == first
    assert len(pages[3]["rows"]) == 51
    rows = [row for page in (1, 2, 3) for row in pages[page]["rows"]]
    assert len({row["id"] for row in rows}) == 251
    assert sum(row["listen_count"] for row in rows) == 253
    assert [row["last_listened_at"] for row in rows] == sorted((row["last_listened_at"] for row in rows), reverse=True)
    error_status(lambda: read(db, own_actor, period=period, snapshot_ref=first["snapshot_ref"], page=4), 422)


@pytest.mark.parametrize("period", ["week", "month"])
def test_week_and_calendar_month_are_progressive_not_numbered(static_ledger, own_actor, period):
    db = static_ledger["db"]
    first = read(db, own_actor, period=period)["data"]
    assert first.get("pagination") is None
    assert len(first["rows"]) == 100 and first["next_cursor"]
    second = read(db, own_actor, period=period, snapshot_ref=first["snapshot_ref"], cursor=first["next_cursor"])["data"]
    third = read(db, own_actor, period=period, snapshot_ref=first["snapshot_ref"], cursor=second["next_cursor"])["data"]
    assert len(second["rows"]) == 100 and len(third["rows"]) == 51
    assert third["next_cursor"] is None
    rows = first["rows"] + second["rows"] + third["rows"]
    assert len({row["id"] for row in rows}) == 251
    assert {page["total_listens"] for page in (first, second, third)} == {253}
    assert read(db, own_actor, period=period, snapshot_ref=first["snapshot_ref"], cursor=first["next_cursor"])["data"] == second


@pytest.mark.parametrize("kind,rows", [("tracks", 251), ("albums", 1), ("artists", 1), ("listens", 253)])
def test_all_four_kinds_share_meaningful_event_totals_without_join_duplication(static_ledger, own_actor, kind, rows):
    result = read(static_ledger["db"], own_actor, kind=kind)["data"]
    assert result["total_listens"] == 253
    assert result["pagination"]["total_rows"] == rows
    assert result["coverage"]["source_families"] == sorted([MEASURED, LEGACY, BACKFILL])
    assert result["coverage"]["complete_for_available_snapshot"] is True
    assert result["coverage"]["complete_for_requested_period"] is False
    for row in result["rows"]:
        assert row.get("full_listen_count") is None
        assert row.get("scrobble_count") is None
        assert row.get("lastfm_playcount") is None


@pytest.mark.parametrize("order", [("a", "b", "a"), ("b", "a", "b")])
def test_two_actors_and_separate_libraries_cannot_cross_read_in_either_order(static_ledger, order):
    db, data = static_ledger["db"], static_ledger["data"]
    with db.session(data["account"], data["library"]) as a, db.session(static_ledger["other"], data["library"]) as b:
        actors = {"a": a, "b": b}
        for key in order:
            assert read(db, actors[key])["data"]["total_listens"] == {"a": 253, "b": 2}[key]
    with db.session(data["account"], static_ledger["other_library"]["library"]) as current:
        assert read(db, current)["data"]["total_listens"] == 3


@pytest.mark.parametrize("period", ["week", "all"])
def test_known_empty_has_truthful_coverage_and_long_page_one(static_ledger, period):
    db = static_ledger["db"]
    with db.session(static_ledger["empty"], static_ledger["data"]["library"]) as current:
        result = read(db, current, period=period)
    assert result["status"] == "empty"
    data = result["data"]
    assert data["rows"] == [] and data["total_listens"] == 0
    assert data["coverage"]["observed_start"] is None and data["coverage"]["observed_end"] is None
    assert data["coverage"]["source_families"] == []
    assert data["coverage"]["complete_for_requested_period"] is False
    assert data.get("pagination") == ({"mode": "numbered", "page": 1, "page_size": 100, "total_rows": 0} if period == "all" else None)


def test_receipt_exposes_one_hour_expiry_and_opaque_private_safe_references(static_ledger, own_actor):
    result = read(static_ledger["db"], own_actor, period="week")["data"]
    assert datetime.fromisoformat(result["expires_at"]) == NOW + timedelta(hours=1)
    assert result["snapshot_ref"] and result["next_cursor"]
    public = repr(result)
    assert "synthetic-private" not in public
    assert "source_payload" not in public
    assert "session_token" not in public
    assert "postgresql://" not in public
    assert all(track["path"] not in public for track in static_ledger["data"]["tracks"])


def test_late_insert_is_stable_in_existing_receipt_and_visible_after_explicit_refresh(mutable_ledger):
    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    first = read(db, current)["data"]
    with db.connect() as connection:
        db.event(connection, data, played_at=NOW - timedelta(seconds=1))
    again = read(db, current, snapshot_ref=first["snapshot_ref"], page=1)["data"]
    assert again == first
    refreshed = read(db, current)["data"]
    assert refreshed["snapshot_ref"] != first["snapshot_ref"]
    assert refreshed["total_listens"] == first["total_listens"] + 1


@pytest.mark.parametrize("mutation", ["delete", "qualification", "finalization", "timestamp", "source", "reassignment", "title", "file_stale"])
def test_semantic_source_or_inventory_change_invalidates_the_whole_receipt(mutable_ledger, mutation):
    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    initial = read(db, current)["data"]
    event_id = mutable_ledger["events"][0]
    with db.connect() as connection:
        if mutation == "delete":
            connection.execute("delete from integration.listen_history where id=%s", (event_id,))
        elif mutation == "qualification":
            connection.execute("update integration.listen_history set measured_listened_seconds=9,max_measured_contiguous_seconds=9 where id=%s", (event_id,))
        elif mutation == "finalization":
            connection.execute("update integration.listen_history set finalized=false where id=%s", (event_id,))
        elif mutation == "timestamp":
            connection.execute("update integration.listen_history set played_at=%s where id=%s", (NOW - timedelta(days=500), event_id))
        elif mutation == "source":
            connection.execute("update integration.listen_history set source_family='unsupported-family' where id=%s", (event_id,))
        elif mutation == "reassignment":
            connection.execute("update integration.listen_history set track_id=%s where id=%s", (data["tracks"][1]["id"], event_id))
        elif mutation == "title":
            connection.execute("update library.local_tracks set title='Repaired title' where id=%s", (data["tracks"][0]["id"],))
        else:
            connection.execute("update library.local_track_files set metadata='{\"scan_cache\":{\"stale\":true}}'::jsonb where track_id=%s", (data["tracks"][0]["id"],))
    error_status(lambda: read(db, current, snapshot_ref=initial["snapshot_ref"], page=1), 410)


def test_scrobble_delivery_edits_do_not_invalidate_unchanged_meaningful_history(mutable_ledger):
    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    first = read(db, current)["data"]
    with db.connect() as connection:
        connection.execute(
            "update integration.listen_history set scrobble_status='scrobbled', metadata=jsonb_set(metadata,'{source_payload}',"
            "metadata->'source_payload' || '{\"scrobbled\":true,\"scrobble_retryable\":false,\"scrobble_submission_state\":\"accepted\"}'::jsonb) where id=%s",
            (mutable_ledger["events"][0],),
        )
    assert read(db, current, snapshot_ref=first["snapshot_ref"], page=1)["data"] == first


@pytest.mark.parametrize("authority", ["membership", "account", "session", "grant"])
def test_current_authority_is_rechecked_even_with_a_stale_active_actor(mutable_ledger, authority):
    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    first = read(db, current)["data"]
    with db.connect() as connection:
        if authority == "membership":
            connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s", (data["account"], data["library"]))
        elif authority == "account":
            connection.execute("update app.accounts set is_active=false, disabled_at=%s where id=%s", (NOW, data["account"]))
        elif authority == "session":
            connection.execute("update app.account_sessions set revoked_at=%s where id=%s", (NOW, current.session_id))
        else:
            connection.execute("update app.capabilities set revoked_at=%s where account_id=%s and scope_id=%s", (NOW, data["account"], data["library"]))
    error_status(lambda: read(db, current, snapshot_ref=first["snapshot_ref"], page=1), 403)


def test_bootstrap_flag_cannot_substitute_for_current_durable_membership(mutable_ledger):
    db, data = mutable_ledger["db"], mutable_ledger["data"]
    with db.connect() as connection:
        connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s", (data["account"], data["library"]))
    with db.session(data["account"], data["library"], bootstrap=True) as current:
        error_status(lambda: read(db, current), 403)


@pytest.mark.parametrize("scope_change", ["actor", "session", "library", "kind", "period", "tamper"])
def test_receipt_is_bound_to_exact_actor_session_library_kind_and_period(static_ledger, own_actor, scope_change):
    db, data = static_ledger["db"], static_ledger["data"]
    first = read(db, own_actor)["data"]
    kwargs = {"snapshot_ref": first["snapshot_ref"], "page": 1}
    if scope_change == "kind":
        error_status(lambda: read(db, own_actor, kind="albums", **kwargs), 410)
    elif scope_change == "period":
        error_status(lambda: read(db, own_actor, period="year", **kwargs), 410)
    elif scope_change == "tamper":
        token = first["snapshot_ref"]
        kwargs["snapshot_ref"] = ("a" if token[0] != "a" else "b") + token[1:]
        error_status(lambda: read(db, own_actor, **kwargs), 410)
    else:
        owner = static_ledger["other"] if scope_change == "actor" else data["account"]
        library_id = static_ledger["other_library"]["library"] if scope_change == "library" else data["library"]
        with db.session(owner, library_id) as other:
            error_status(lambda: read(db, other, **kwargs), 410)


def test_progressive_cursor_is_bound_to_its_exact_receipt(static_ledger, own_actor):
    db = static_ledger["db"]
    first = read(db, own_actor, period="week")["data"]
    second = read(db, own_actor, period="week")["data"]
    error_status(lambda: read(db, own_actor, period="week", snapshot_ref=second["snapshot_ref"], cursor=first["next_cursor"]), 422)
    token = first["next_cursor"]
    tampered = ("a" if token[0] != "a" else "b") + token[1:]
    error_status(lambda: read(db, own_actor, period="week", snapshot_ref=first["snapshot_ref"], cursor=tampered), 422)


def test_expiry_at_one_hour_requires_explicit_refresh(mutable_ledger):
    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    first = read(db, current)["data"]
    assert read(db, current, now=NOW + timedelta(hours=1) - timedelta(microseconds=1), snapshot_ref=first["snapshot_ref"], page=1)["data"] == first
    error_status(lambda: read(db, current, now=NOW + timedelta(hours=1), snapshot_ref=first["snapshot_ref"], page=1), 410)
    fresh = read(db, current, now=NOW + timedelta(hours=1))["data"]
    assert fresh["snapshot_ref"] != first["snapshot_ref"]
    assert fresh["total_listens"] == 3


@pytest.mark.parametrize("resource", ["listen_history", "track", "album", "artist"])
def test_policy_denial_filters_rows_and_totals_before_receipt_publication(mutable_ledger, resource):
    db, data = mutable_ledger["db"], mutable_ledger["data"]
    target = {"listen_history": mutable_ledger["events"][0], "track": data["tracks"][0]["id"], "album": data["album"], "artist": data["artist"]}[resource]
    denied = lambda kind, resource_id: AllowedActions(()) if (kind, resource_id) == (resource, target) else allow_all(kind, resource_id)
    result = read(db, mutable_ledger["actor"], allowed=denied)["data"]
    expected = 0 if resource in {"album", "artist"} else 2
    assert result["total_listens"] == expected
    assert result["pagination"]["total_rows"] == expected
    assert len(result["rows"]) == expected


def test_current_custom_resource_denial_retires_old_receipt_before_revealing_totals(mutable_ledger):
    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    first = read(db, current)["data"]
    denied = lambda kind, resource_id: AllowedActions(()) if (kind, resource_id) == ("track", data["tracks"][2]["id"]) else allow_all(kind, resource_id)
    error_status(lambda: read(db, current, allowed=denied, snapshot_ref=first["snapshot_ref"], page=1), 410)


def test_real_query_uses_half_open_bounds_and_qualification_without_changing_ledger(mutable_ledger):
    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    with db.connect() as connection:
        db.event(connection, data, played_at=NOW - timedelta(days=7))
        db.event(connection, data, played_at=NOW)
        db.event(connection, data, played_at=NOW - timedelta(days=7, microseconds=1))
        db.event(connection, data, seconds=10)
        db.event(connection, data, finalized=False)
        db.event(connection, data, source="unsupported-family")
        before = connection.execute("select * from integration.listen_history where account_id=%s order by id", (data["account"],)).fetchall()
    result = read(db, current, kind="listens", period="week")["data"]
    assert result["total_listens"] == 4 and len(result["rows"]) == 4
    with db.connect() as connection:
        after = connection.execute("select * from integration.listen_history where account_id=%s order by id", (data["account"],)).fetchall()
    assert after == before


def test_exact_idless_legacy_alias_resolves_but_fuzzy_titles_do_not(mutable_ledger):
    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    with db.connect() as connection:
        exact = {**data["tracks"][0], "id": None}
        db.event(connection, data, track=exact, source=LEGACY)
        unknown = {"id": None, "key": "unknown-key", "path": "/synthetic-private-activity/no-match.flac"}
        db.event(connection, data, track=unknown, source=LEGACY,
                 payload={"title": "Track 0000", "artist": "Canonical artist", "album": "Canonical album"})
    result = read(db, current)["data"]
    assert result["total_listens"] == 5
    assert result["pagination"]["total_rows"] == 4
    assert sorted(row["listen_count"] for row in result["rows"]) == [1, 1, 1, 2]
    assert [row["availability"] for row in result["rows"]].count("unresolved") == 1


def test_removed_measured_id_does_not_reconnect_when_path_and_key_are_reused(mutable_ledger):
    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    original = data["tracks"][0]
    with db.connect() as connection:
        connection.execute("delete from library.local_tracks where id=%s", (original["id"],))
        replacement = connection.execute(
            "insert into library.local_tracks(library_id,album_id,artist_id,track_key,title,duration_seconds) values(%s,%s,%s,%s,'Replacement track',999) returning id",
            (data["library"], data["album"], data["artist"], original["key"]),
        ).fetchone()["id"]
        connection.execute("insert into library.local_track_files(track_id,private_path) values(%s,%s)", (replacement, original["path"]))
    result = read(db, current)["data"]
    assert result["total_listens"] == 3
    assert all(row["title"] != "Replacement track" for row in result["rows"])
    unresolved = [row for row in result["rows"] if row["availability"] == "unresolved"]
    assert len(unresolved) == 1
    assert unresolved[0]["title"] == "Original event title"
    assert unresolved[0].get("duration_seconds") is None


def test_foreign_nonnull_measured_identity_is_not_repaired_using_local_payload_alias(mutable_ledger):
    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    with db.connect() as connection:
        foreign_owner = db.account(connection)
        foreign = db.catalog(connection, foreign_owner)
        connection.execute("update integration.listen_history set track_id=%s where id=%s", (foreign["tracks"][0]["id"], mutable_ledger["events"][0]))
    result = read(db, current)["data"]
    assert result["total_listens"] == 2
    assert len(result["rows"]) == 2


@pytest.mark.parametrize("foreign_album_artist", [False, True])
def test_cross_library_artist_parents_never_become_own_canonical_group_identity(mutable_ledger, foreign_album_artist):
    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    with db.connect() as connection:
        foreign_owner = db.account(connection)
        foreign = db.catalog(connection, foreign_owner)
        connection.execute("update library.local_tracks set artist_id=%s where id=%s",
                           (foreign["artist"], data["tracks"][0]["id"]))
        if foreign_album_artist:
            connection.execute("update library.local_albums set artist_id=%s where id=%s",
                               (foreign["artist"], data["album"]))
    seen_resources = []

    def policy(kind, reference):
        seen_resources.append((kind, reference))
        return allow_all(kind, reference)

    result = read(db, current, kind="artists", allowed=policy)["data"]
    assert result["total_listens"] == 3
    assert ("artist", foreign["artist"]) not in seen_resources
    if foreign_album_artist:
        assert result["pagination"]["total_rows"] == 2
        assert sorted(row["listen_count"] for row in result["rows"]) == [1, 2]
        assert [row["title"] for row in result["rows"] if row["listen_count"] == 1] == [""]
        assert [row["availability"] for row in result["rows"] if row["listen_count"] == 1] == ["unresolved"]
    else:
        assert result["pagination"]["total_rows"] == 1
        assert result["rows"][0]["listen_count"] == 3
        assert result["rows"][0]["title"] == "Canonical artist"


def test_receipt_limit_retires_oldest_of_three_identical_queries_only(mutable_ledger):
    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    receipts = [read(db, current, now=NOW + timedelta(seconds=index))["data"] for index in range(3)]
    error_status(lambda: read(db, current, now=NOW + timedelta(seconds=3), snapshot_ref=receipts[0]["snapshot_ref"], page=1), 410)
    for result in receipts[1:]:
        assert read(db, current, now=NOW + timedelta(seconds=3), snapshot_ref=result["snapshot_ref"], page=1)["data"] == result
    with db.connect() as connection:
        count = connection.execute("select count(*) as count from app.activity_snapshots where account_id=%s and session_id=%s and expires_at>%s",
                                   (current.account_id, current.session_id, NOW + timedelta(seconds=3))).fetchone()["count"]
    assert count == 2


def test_failed_projection_cannot_leave_a_partially_complete_receipt(mutable_ledger):
    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    calls = 0

    def failure(_kind, _resource_id):
        nonlocal calls
        calls += 1
        if calls > 2:
            raise RuntimeError("synthetic projection interrupted")
        return allow_all(_kind, _resource_id)

    with pytest.raises(RuntimeError, match="synthetic projection interrupted"):
        read(db, current, allowed=failure)
    with db.connect() as connection:
        count = connection.execute("select count(*) as count from app.activity_snapshots where account_id=%s", (current.account_id,)).fetchone()["count"]
    assert count == 0


def test_session_cap_is_enforced_across_different_kinds_and_periods(mutable_ledger):
    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    queries = [(kind, period) for kind in ("tracks", "albums", "artists", "listens") for period in ("week", "month", "six", "year", "all")]
    receipts = []
    for index, (kind, period) in enumerate(queries[:11]):
        receipts.append(read(db, current, kind=kind, period=period, now=NOW + timedelta(seconds=index))["data"])
    with db.connect() as connection:
        count = connection.execute("select count(*) as count from app.activity_snapshots where account_id=%s and session_id=%s and expires_at>%s",
                                   (current.account_id, current.session_id, NOW + timedelta(seconds=11))).fetchone()["count"]
    assert count == 10
    error_status(lambda: read(db, current, kind=queries[0][0], period=queries[0][1], now=NOW + timedelta(seconds=11), snapshot_ref=receipts[0]["snapshot_ref"]), 410)
    last_kind, last_period = queries[10]
    assert read(db, current, kind=last_kind, period=last_period, now=NOW + timedelta(seconds=11), snapshot_ref=receipts[-1]["snapshot_ref"])["data"] == receipts[-1]


def test_actor_cap_spans_sessions_without_retiring_another_actor_receipt(mutable_ledger):
    from contextlib import ExitStack

    db, data = mutable_ledger["db"], mutable_ledger["data"]
    queries = [(kind, period) for kind in ("tracks", "albums", "artists", "listens") for period in ("week", "month", "six", "year", "all")]
    with db.connect() as connection:
        other = db.account(connection)
        db.membership(connection, other, data["library"])
    with ExitStack() as stack:
        actors = [stack.enter_context(db.session(data["account"], data["library"])) for _ in range(3)]
        outsider = stack.enter_context(db.session(other, data["library"]))
        outside_receipt = read(db, outsider)["data"]
        first = None
        for index in range(21):
            current = actors[index // 7]
            kind, period = queries[index % 7]
            result = read(db, current, kind=kind, period=period, now=NOW + timedelta(seconds=index))["data"]
            if first is None:
                first = result
        with db.connect() as connection:
            count = connection.execute("select count(*) as count from app.activity_snapshots where account_id=%s and expires_at>%s",
                                       (data["account"], NOW + timedelta(seconds=21))).fetchone()["count"]
        assert count == 20
        error_status(lambda: read(db, actors[0], kind=queries[0][0], period=queries[0][1], now=NOW + timedelta(seconds=21), snapshot_ref=first["snapshot_ref"]), 410)
        assert read(db, outsider, snapshot_ref=outside_receipt["snapshot_ref"], page=1)["data"] == outside_receipt


def test_source_change_during_materialization_never_publishes_a_mixed_complete_snapshot(mutable_ledger):
    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    changed = False
    # Establish committed source-revision keys before coordinating the race;
    # inserting a conflicting key from this synchronous callback would block
    # behind this test's own uncommitted first-build transaction.
    read(db, current)
    with db.connect() as connection:
        connection.execute("delete from app.activity_snapshots where account_id=%s", (current.account_id,))

    def change_source_once(kind, resource_id):
        nonlocal changed
        if not changed:
            changed = True
            with db.connect() as connection:
                connection.execute("update integration.listen_history set finalized=false where id=%s", (mutable_ledger["events"][-1],))
        return allow_all(kind, resource_id)

    result = read(db, current, allowed=change_source_once)
    assert changed
    assert result["status"] == "ready"
    assert result["data"]["total_listens"] == 2
    assert result["data"]["pagination"]["total_rows"] == 2
    assert len(result["data"]["rows"]) == 2
    assert result["data"]["coverage"]["complete_for_available_snapshot"] is True
    with db.connect() as connection:
        rows = connection.execute("select ready,total_listens,total_rows from app.activity_snapshots where account_id=%s", (current.account_id,)).fetchall()
    assert rows == [{"ready": True, "total_listens": 2, "total_rows": 2}]


def test_repeated_prepublication_conflicts_return_busy_without_partial_or_orphan_receipts(mutable_ledger):
    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    read(db, current)
    with db.connect() as connection:
        connection.execute("delete from app.activity_snapshots where account_id=%s", (current.account_id,))
    changed = 0
    target = mutable_ledger["events"][-1]

    def change_each_attempt(kind, resource_id):
        nonlocal changed
        if kind == "listen_history" and resource_id == target:
            changed += 1
            with db.connect() as connection:
                connection.execute("update integration.listen_history set played_at=played_at-interval '1 second' where id=%s", (target,))
        return allow_all(kind, resource_id)

    with pytest.raises(activity.HomeActivityError) as caught:
        read(db, current, allowed=change_each_attempt)
    assert caught.value.status_code == 503
    assert caught.value.code == "activity_busy"
    assert changed == 2
    with db.connect() as connection:
        count = connection.execute("select count(*) as count from app.activity_snapshots where account_id=%s", (current.account_id,)).fetchone()["count"]
    assert count == 0


def test_new_receipt_cleans_at_most_100_expired_own_rows_and_never_foreign_rows(mutable_ledger):
    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    seed = read(db, current)["data"]
    with db.connect() as connection:
        seed_id = connection.execute("select id from app.activity_snapshots where token_digest=%s", (hashlib.sha256(seed["snapshot_ref"].encode()).digest(),)).fetchone()["id"]
        # Clone receipt headers only into uniquely owned synthetic expired rows.
        # Their ready=false state makes them unusable even before expiry cleanup.
        for _ in range(101):
            connection.execute(
                "insert into app.activity_snapshots(token_digest,row_secret,account_id,session_id,library_id,kind,period,window_start,window_end,timezone,"
                "period_label,range_label,ledger_revision,inventory_revision,authority_fingerprint,qualification_version,created_at,expires_at,ready,subject_account_id,audience) "
                "select %s,row_secret,account_id,session_id,library_id,kind,period,window_start,window_end,timezone,period_label,range_label,"
                "ledger_revision,inventory_revision,authority_fingerprint,qualification_version,%s,%s,false,subject_account_id,audience from app.activity_snapshots where id=%s",
                (hashlib.sha256(uuid.uuid4().bytes).digest(), NOW - timedelta(hours=2), NOW - timedelta(hours=1), seed_id),
            )
        other = db.account(connection)
        db.membership(connection, other, data["library"])
    with db.session(other, data["library"]) as outsider:
        outside = read(db, outsider)["data"]
        with db.connect() as connection:
            connection.execute("update app.activity_snapshots set created_at=%s,expires_at=%s where account_id=%s",
                               (NOW - timedelta(hours=2), NOW - timedelta(hours=1), other))
        read(db, current)
        with db.connect() as connection:
            remaining = connection.execute("select count(*) as count from app.activity_snapshots where account_id=%s and expires_at<=%s", (current.account_id, NOW)).fetchone()["count"]
            foreign = connection.execute("select count(*) as count from app.activity_snapshots where account_id=%s", (other,)).fetchone()["count"]
        assert remaining == 1
        assert foreign == 1


def test_later_page_reads_frozen_rows_without_rebuilding_the_full_history(static_ledger, own_actor, monkeypatch):
    import psycopg
    from psycopg.rows import dict_row

    db = static_ledger["db"]
    first = read(db, own_actor)["data"]
    statements = []

    class CountingConnection:
        def __init__(self, connection):
            self.connection = connection

        def __enter__(self):
            self.connection.__enter__()
            return self

        def __exit__(self, *args):
            return self.connection.__exit__(*args)

        def execute(self, sql, params=()):
            statements.append((" ".join(sql.lower().split()), params))
            return self.connection.execute(sql, params)

        def __getattr__(self, name):
            return getattr(self.connection, name)

    def connect(url):
        assert url == db.app_url
        return CountingConnection(psycopg.connect(url, row_factory=dict_row))

    def forbidden(*_args, **_kwargs):
        raise AssertionError("A numbered jump rebuilt source history")

    monkeypatch.setattr(activity, "build_activity_projection", forbidden)
    repository = HomeActivityPostgresRepository(db.config, connect=connect)
    result = read(db, own_actor, snapshot_ref=first["snapshot_ref"], page=3, repository=repository)["data"]
    assert len(result["rows"]) == 51
    assert result["total_listens"] == 253
    assert result["pagination"]["total_rows"] == 251
    assert statements
    assert all("integration.listen_history" not in sql for sql, _ in statements)
    assert all("activity_snapshot_events" not in sql for sql, _ in statements)
    assert any("activity_snapshot_rows" in sql and "ordinal>" in sql and "ordinal<=" in sql for sql, _ in statements)


def test_streamed_chunks_aggregate_the_same_canonical_group_without_partial_coverage(mutable_ledger, monkeypatch):
    from music_app.services import home_activity_postgres

    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    with db.connect() as connection:
        db.event(connection, data, source=LEGACY, played_at=NOW - timedelta(seconds=20))
        db.event(connection, data, source=BACKFILL, played_at=NOW - timedelta(seconds=30))
    # A small repository fetch batch exercises the real SQL chunk merge; it
    # changes no source population, authorization, or acceptance expectation.
    monkeypatch.setattr(home_activity_postgres, "CHUNK_SIZE", 2)
    result = read(db, current)["data"]
    assert result["total_listens"] == 5
    assert result["pagination"]["total_rows"] == 3
    assert sorted(row["listen_count"] for row in result["rows"]) == [1, 1, 3]
    assert result["rows"][0]["title"] == "Track 0000"
    assert result["rows"][0]["last_listened_at"] == (NOW - timedelta(seconds=20)).isoformat()
    assert result["rows"][0]["source_label"] == "Album Haven / Stored legacy history"
    assert result["coverage"]["source_families"] == sorted([MEASURED, LEGACY, BACKFILL])
    assert result["coverage"]["observed_start"] == (NOW - timedelta(minutes=3)).isoformat()
    assert result["coverage"]["observed_end"] == (NOW - timedelta(seconds=20)).isoformat()
    assert result["coverage"]["complete_for_available_snapshot"] is True


def test_conflicting_exact_legacy_aliases_do_not_choose_an_arbitrary_track(mutable_ledger):
    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    with db.connect() as connection:
        ambiguous = {**data["tracks"][0], "id": None}
        db.event(connection, data, track=ambiguous, source=LEGACY,
                 payload={"track_ref": data["tracks"][1]["path"], "path": data["tracks"][1]["path"]})
    result = read(db, current)["data"]
    assert result["total_listens"] == 4
    assert result["pagination"]["total_rows"] == 4
    unresolved = [row for row in result["rows"] if row["availability"] == "unresolved"]
    assert len(unresolved) == 1 and unresolved[0]["listen_count"] == 1
    assert unresolved[0]["title"] == "Original event title"


def test_stale_legacy_file_alias_cannot_claim_a_current_canonical_identity(mutable_ledger):
    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    with db.connect() as connection:
        connection.execute("update library.local_track_files set metadata='{\"scan_cache\":{\"stale\":true}}'::jsonb where track_id=%s", (data["tracks"][0]["id"],))
        unknown_key = {**data["tracks"][0], "id": None, "key": "noncanonical-legacy-key"}
        db.event(connection, data, track=unknown_key, source=LEGACY)
    result = read(db, current)["data"]
    assert result["total_listens"] == 4
    assert result["pagination"]["total_rows"] == 4
    original = [row for row in result["rows"] if row["title"] == "Original event title"]
    assert len(original) == 1 and original[0]["availability"] == "unresolved"


def test_hostile_payload_scope_fields_cannot_move_history_into_another_actor(mutable_ledger):
    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    with db.connect() as connection:
        other = db.account(connection)
        db.membership(connection, other, data["library"])
        db.event(connection, data, owner=other, payload={"account_id": data["account"], "library_id": data["library"],
                                                       "row_id": mutable_ledger["events"][0], "played_at": NOW.isoformat()})
    own = read(db, current)["data"]
    assert own["total_listens"] == 3
    with db.session(other, data["library"]) as outsider:
        other_result = read(db, outsider)["data"]
    assert other_result["total_listens"] == 1


QUALIFICATION_TRANSITIONS = [
    # Exact measured threshold; first finalization is new evidence.
    (MEASURED, {"seconds": 10}, {"seconds": 10.0}, False, False),
    (MEASURED, {"seconds": 10}, {"seconds": 10.0001}, False, True),
    (MEASURED, {"seconds": 12.5, "finalized": False}, {"seconds": 13, "finalized": False}, False, False),
    (MEASURED, {"seconds": 12.5, "finalized": False}, {"seconds": 12.5, "finalized": True}, False, True),
    (MEASURED, {"seconds": 12.5}, {"seconds": 10}, True, False),
    (MEASURED, {"seconds": 12.5}, {"seconds": 13.5}, True, True),
    # Legacy qualification rounds both finite values to three decimals. Null
    # is a legal payload value; measured NULL facts are forbidden by its schema.
    *[(source, before, after, was_qualified, is_qualified)
      for source in (LEGACY, BACKFILL)
      for before, after, was_qualified, is_qualified in [
          ({"total": 10.0004, "contiguous": 0}, {"total": 10.00049, "contiguous": 0}, False, False),
          ({"total": 10.0004, "contiguous": 0}, {"total": 10.00051, "contiguous": 0}, False, True),
          ({"total": 10.00051, "contiguous": 0}, {"total": 10.0004, "contiguous": 0}, True, False),
          ({"total": 12.5, "contiguous": 0}, {"total": 13.5, "contiguous": 0}, True, True),
          ({"total": None, "contiguous": None}, {"total": None, "contiguous": 10}, False, False),
          ({"total": None, "contiguous": 10}, {"total": None, "contiguous": 10.001}, False, True),
          ({"total": None, "contiguous": 10.001}, {"total": None, "contiguous": None}, True, False),
          ({"total": 11, "contiguous": None}, {"total": 12, "contiguous": None}, True, True),
      ]],
]


def set_qualification(connection, event_id, source, facts):
    from psycopg.types.json import Jsonb

    if source == MEASURED:
        seconds = facts.get("seconds", 12.5)
        connection.execute(
            "update integration.listen_history set measured_listened_seconds=%s,max_measured_contiguous_seconds=%s,finalized=%s where id=%s",
            (seconds, min(seconds, 10), facts.get("finalized", True), event_id),
        )
    else:
        payload = {"total_listened_seconds": facts.get("total", 12.5), "max_contiguous_seconds": facts.get("contiguous", 0)}
        connection.execute(
            "update integration.listen_history set metadata=jsonb_set(metadata,'{source_payload}',metadata->'source_payload' || %s) where id=%s",
            (Jsonb(payload), event_id),
        )


@pytest.mark.parametrize("source,before,after,was_qualified,is_qualified", QUALIFICATION_TRANSITIONS)
def test_first_qualification_is_new_evidence_while_captured_semantic_repairs_retire_receipts(
    mutable_ledger, source, before, after, was_qualified, is_qualified,
):
    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    with db.connect() as connection:
        event_id = db.event(connection, data, source=source)
        set_qualification(connection, event_id, source, before)
    initial = read(db, current, kind="listens")["data"]
    assert initial["total_listens"] == 3 + int(was_qualified)
    with db.connect() as connection:
        retained = connection.execute(
            "select exists(select 1 from app.activity_snapshot_events e join app.activity_snapshots s on s.id=e.snapshot_id "
            "where s.token_digest=%s and e.event_id=%s) as retained",
            (hashlib.sha256(initial["snapshot_ref"].encode()).digest(), event_id),
        ).fetchone()["retained"]
        assert retained is was_qualified
        set_qualification(connection, event_id, source, after)
    if was_qualified:
        error_status(lambda: read(db, current, kind="listens", snapshot_ref=initial["snapshot_ref"], page=1), 410)
    else:
        # Neither an irrelevant repair nor first qualification can rewrite a
        # previously published receipt that never contained this event.
        assert read(db, current, kind="listens", snapshot_ref=initial["snapshot_ref"], page=1)["data"] == initial
    fresh = read(db, current, kind="listens")["data"]
    assert fresh["total_listens"] == 3 + int(is_qualified)
    assert len(fresh["rows"]) == 3 + int(is_qualified)
    assert fresh["snapshot_ref"] != initial["snapshot_ref"]


@pytest.mark.parametrize("source", [MEASURED, LEGACY, BACKFILL])
@pytest.mark.parametrize("qualified", [False, True])
def test_delete_invalidates_only_when_the_deleted_event_was_captured_by_active_receipts(mutable_ledger, source, qualified):
    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    with db.connect() as connection:
        target = db.event(connection, data, source=source, seconds=12.5 if qualified else 10)
    initial = read(db, current, kind="listens")["data"]
    assert initial["total_listens"] == 3 + int(qualified)
    with db.connect() as connection:
        connection.execute("delete from integration.listen_history where id=%s", (target,))
    if qualified:
        error_status(lambda: read(db, current, kind="listens", snapshot_ref=initial["snapshot_ref"], page=1), 410)
    else:
        assert read(db, current, kind="listens", snapshot_ref=initial["snapshot_ref"], page=1)["data"] == initial
    assert read(db, current, kind="listens")["data"]["total_listens"] == 3


class RetainedRuntimeConnection:
    """Real driver connection whose lease exit does not hide leaked session locks."""
    def __init__(self, db, *, before=None, after=None):
        import psycopg
        from psycopg.rows import dict_row

        self.connection = psycopg.connect(db.app_url, row_factory=dict_row, connect_timeout=10,
                                          options="-c statement_timeout=20000")
        self.before = before
        self.after = after
        self.operations = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, _exc, _traceback):
        if not self.connection.closed:
            self.rollback() if exc_type is not None else self.commit()
        return False

    def execute(self, sql, params=()):
        normalized = " ".join(sql.lower().split())
        self.operations.append(("sql", normalized, params))
        if self.before is not None:
            self.before(normalized)
        cursor = self.connection.execute(sql, params)
        if self.after is not None:
            self.after(normalized)
        return cursor

    def commit(self):
        self.connection.commit()
        self.operations.append(("commit",))

    def rollback(self):
        self.connection.rollback()
        self.operations.append(("rollback",))

    def __getattr__(self, name):
        return getattr(self.connection, name)


def retained_repository(db, connection):
    def connect(url):
        assert url == db.app_url
        return connection
    return HomeActivityPostgresRepository(db.config, connect=connect)


def assert_capture_lock_released(db, account_id):
    # The worker's physical connection is deliberately still open here.
    key = f"home-activity:{account_id}"
    with db.connect() as observer:
        acquired = observer.execute("select pg_try_advisory_lock(hashtextextended(%s,0)) as acquired", (key,)).fetchone()["acquired"]
        try:
            assert acquired is True, "A finished activity lease retained its actor session lock"
        finally:
            if acquired:
                observer.execute("select pg_advisory_unlock(hashtextextended(%s,0))", (key,))


def establish_revision_keys_without_receipts(db, current):
    read(db, current)
    with db.connect() as connection:
        connection.execute("delete from app.activity_snapshots where account_id=%s", (current.account_id,))


def source_for_concurrency(db, data, events, source):
    if source == MEASURED:
        return events[-1]
    with db.connect() as connection:
        connection.execute("delete from integration.listen_history where id=%s", (events[-1],))
        return db.event(connection, data, source=source)


def remove_qualification(connection, target, source, operation):
    if operation == "delete":
        connection.execute("delete from integration.listen_history where id=%s", (target,))
    else:
        set_qualification(connection, target, source,
                          {"seconds": 9} if source == MEASURED else {"total": None, "contiguous": 10.0004})


@pytest.mark.parametrize("source", [MEASURED, LEGACY])
@pytest.mark.parametrize("operation", ["update", "delete"])
@pytest.mark.parametrize("first", ["writer", "builder"])
def test_source_update_or_delete_and_capture_serialize_in_both_orders(mutable_ledger, source, operation, first):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    target = source_for_concurrency(db, data, mutable_ledger["events"], source)
    establish_revision_keys_without_receipts(db, current)
    writer_applied, release_writer, writer_committed = Event(), Event(), Event()
    builder_captured, release_builder, builder_lock_attempt = Event(), Event(), Event()
    paused = False

    def before(sql):
        if "pg_advisory_lock(" in sql:
            builder_lock_attempt.set()

    def after(sql):
        nonlocal paused
        if first == "builder" and "from integration.listen_history h" in sql and not paused:
            paused = True
            builder_captured.set()
            assert release_builder.wait(10), "Builder release was not signaled"

    retained = RetainedRuntimeConnection(db, before=before, after=after)
    repository = retained_repository(db, retained)

    def write():
        with db.connect() as connection:
            remove_qualification(connection, target, source, operation)
            writer_applied.set()
            if first == "writer":
                assert release_writer.wait(10), "Writer release was not signaled"
        writer_committed.set()

    try:
        with ThreadPoolExecutor(max_workers=2) as workers:
            try:
                if first == "writer":
                    writer = workers.submit(write)
                    assert writer_applied.wait(10), "Writer did not reach its open transaction"
                    builder = workers.submit(read, db, current, repository=repository)
                    assert builder_lock_attempt.wait(10), "Builder did not attempt the capture gate"
                    release_writer.set()
                else:
                    builder = workers.submit(read, db, current, repository=repository)
                    assert builder_captured.wait(10), "Builder did not capture source rows"
                    writer = workers.submit(write)
                    assert writer_committed.wait(10), "Source trigger blocked behind a running builder"
                    release_builder.set()
                writer.result(timeout=20)
                result = builder.result(timeout=20)["data"]
            finally:
                release_writer.set()
                release_builder.set()
        assert result["total_listens"] == 2
        assert result["pagination"]["total_rows"] == 2
        assert len(result["rows"]) == 2
        with db.connect() as connection:
            stored = connection.execute("select ready,total_listens,total_rows from app.activity_snapshots where account_id=%s", (current.account_id,)).fetchall()
        assert stored == [{"ready": True, "total_listens": 2, "total_rows": 2}]
        assert_capture_lock_released(db, current.account_id)
    finally:
        retained.close()


def test_two_builders_capture_after_predecessor_commit_and_serialize_receipt_caps(mutable_ledger):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    seed = read(db, current)["data"]
    first_captured, release_first, second_attempting = Event(), Event(), Event()
    paused = False

    def first_after(sql):
        nonlocal paused
        if "from integration.listen_history h" in sql and not paused:
            paused = True
            first_captured.set()
            assert release_first.wait(10), "First builder release was not signaled"

    def second_before(sql):
        if "pg_advisory_lock(" in sql:
            second_attempting.set()

    first_connection = RetainedRuntimeConnection(db, after=first_after)
    second_connection = RetainedRuntimeConnection(db, before=second_before)
    try:
        with ThreadPoolExecutor(max_workers=2) as workers:
            try:
                first = workers.submit(read, db, current, now=NOW + timedelta(seconds=1), repository=retained_repository(db, first_connection))
                assert first_captured.wait(10), "First builder did not capture"
                second = workers.submit(read, db, current, now=NOW + timedelta(seconds=2), repository=retained_repository(db, second_connection))
                assert second_attempting.wait(10), "Second builder did not attempt the serialized gate"
                release_first.set()
                first_result = first.result(timeout=20)["data"]
                second_result = second.result(timeout=20)["data"]
            finally:
                release_first.set()
        assert first_result["total_listens"] == second_result["total_listens"] == 3
        with db.connect() as connection:
            active = connection.execute("select count(*) as count from app.activity_snapshots where account_id=%s and expires_at>%s",
                                        (current.account_id, NOW + timedelta(seconds=3))).fetchone()["count"]
        assert active == 2
        error_status(lambda: read(db, current, now=NOW + timedelta(seconds=3), snapshot_ref=seed["snapshot_ref"], page=1), 410)
        for result in (first_result, second_result):
            assert read(db, current, now=NOW + timedelta(seconds=3), snapshot_ref=result["snapshot_ref"], page=1)["data"] == result
        for retained in (first_connection, second_connection):
            lock_index = next(index for index, operation in enumerate(retained.operations) if operation[0] == "sql" and "pg_advisory_lock(" in operation[1])
            isolation_index = next(index for index, operation in enumerate(retained.operations) if operation[0] == "sql" and "set transaction isolation level repeatable read" in operation[1])
            assert lock_index < isolation_index
            assert ("commit",) in retained.operations[lock_index + 1:isolation_index]
        assert_capture_lock_released(db, current.account_id)
    finally:
        first_connection.close()
        second_connection.close()


def test_cap_retirement_after_page_authority_capture_cannot_return_an_old_receipt(mutable_ledger):
    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    first = read(db, current)["data"]
    read(db, current, now=NOW + timedelta(seconds=1))
    retired = False

    def before(sql):
        nonlocal retired
        if "select * from app.activity_snapshots" in sql and not retired:
            retired = True
            # The page transaction has already captured authority at RR. A
            # third same-query receipt retires the oldest before its row lock.
            read(db, current, now=NOW + timedelta(seconds=3))

    retained = RetainedRuntimeConnection(db, before=before)
    try:
        error_status(lambda: read(db, current, now=NOW + timedelta(seconds=3),
            snapshot_ref=first["snapshot_ref"], page=1,
            repository=retained_repository(db, retained)), 410)
        assert retired
        captures = [operation for operation in retained.operations
                    if operation[0] == "sql" and "set transaction isolation level repeatable read" in operation[1]]
        assert len(captures) == 2
    finally:
        retained.close()


def test_a_locked_page_finishes_before_concurrent_receipt_cap_retirement(mutable_ledger):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    import psycopg

    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    first = read(db, current)["data"]
    read(db, current, now=NOW + timedelta(seconds=1))
    page_locked, release_page, retirement_attempted = Event(), Event(), Event()

    def page_after(sql):
        if "select * from app.activity_snapshots" in sql:
            page_locked.set()
            assert release_page.wait(10), "Locked page was not released"

    def creator_before(sql):
        if "update app.activity_snapshots set expires_at=" in sql:
            retirement_attempted.set()

    page_connection = RetainedRuntimeConnection(db, after=page_after)
    creator_connection = RetainedRuntimeConnection(db, before=creator_before)
    try:
        with ThreadPoolExecutor(max_workers=2) as workers:
            try:
                page = workers.submit(read, db, current, now=NOW + timedelta(seconds=3),
                    snapshot_ref=first["snapshot_ref"], page=1,
                    repository=retained_repository(db, page_connection))
                assert page_locked.wait(10), "Page did not acquire its receipt row"
                with db.connect() as contender:
                    with pytest.raises(psycopg.errors.LockNotAvailable):
                        contender.execute("select id from app.activity_snapshots where token_digest=%s for update nowait",
                            (hashlib.sha256(first["snapshot_ref"].encode()).digest(),))
                creator = workers.submit(read, db, current, now=NOW + timedelta(seconds=3),
                    repository=retained_repository(db, creator_connection))
                assert retirement_attempted.wait(10), "Creator did not reach retention"
                release_page.set()
                assert page.result(timeout=20)["data"] == first
                assert creator.result(timeout=20)["data"]["total_listens"] == 3
            finally:
                release_page.set()
        error_status(lambda: read(db, current, now=NOW + timedelta(seconds=3),
            snapshot_ref=first["snapshot_ref"], page=1), 410)
    finally:
        page_connection.close()
        creator_connection.close()


def test_bootstrap_row_removal_during_capture_restarts_before_publication(mutable_ledger):
    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    # Do not replace the database's shared bootstrap identity. A unique row
    # exercises the same account-bound publication lock without granting this
    # test bootstrap privilege or mutating any other actor's authority.
    with db.connect() as connection:
        bootstrap_id = connection.execute(
            "insert into app.bootstrap_owners(account_id,owner_key) values(%s,%s) returning id",
            (current.account_id, "activity-lock-" + uuid.uuid4().hex),
        ).fetchone()["id"]
    removed = False

    def after(sql):
        nonlocal removed
        if "from integration.listen_history h" in sql and not removed:
            removed = True
            with db.connect() as connection:
                connection.execute("delete from app.bootstrap_owners where id=%s", (bootstrap_id,))

    retained = RetainedRuntimeConnection(db, after=after)
    try:
        result = read(db, current, repository=retained_repository(db, retained))["data"]
        assert removed and result["total_listens"] == 3
        captures = [operation for operation in retained.operations
                    if operation[0] == "sql" and "set transaction isolation level repeatable read" in operation[1]]
        assert len(captures) == 2
        with db.connect() as connection:
            assert connection.execute("select count(*) as count from app.activity_snapshots where account_id=%s",
                                      (current.account_id,)).fetchone()["count"] == 1
        assert_capture_lock_released(db, current.account_id)
    finally:
        retained.close()


def test_bootstrap_publication_lock_blocks_later_authority_reassignment(mutable_ledger):
    import psycopg

    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    with db.connect() as connection:
        bootstrap_id = connection.execute(
            "insert into app.bootstrap_owners(account_id,owner_key) values(%s,%s) returning id",
            (current.account_id, "activity-lock-" + uuid.uuid4().hex),
        ).fetchone()["id"]
    checked = False

    def after(sql):
        nonlocal checked
        if "from app.bootstrap_owners where account_id=" in sql:
            with db.connect() as contender:
                with pytest.raises(psycopg.errors.LockNotAvailable):
                    contender.execute("select id from app.bootstrap_owners where id=%s for update nowait", (bootstrap_id,))
            checked = True

    retained = RetainedRuntimeConnection(db, after=after)
    try:
        assert read(db, current, repository=retained_repository(db, retained))["data"]["total_listens"] == 3
        assert checked
        with db.connect() as contender:
            assert contender.execute("select id from app.bootstrap_owners where id=%s for update nowait",
                                     (bootstrap_id,)).fetchone() is not None
    finally:
        retained.close()


@pytest.mark.parametrize("blocked_resource", ["revision", "account", "session", "membership", "grant"])
def test_nowait_publication_contention_returns_busy_once_and_releases_session_lock(mutable_ledger, blocked_resource):
    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    establish_revision_keys_without_receipts(db, current)
    retained = RetainedRuntimeConnection(db)
    locks = {
        "revision": ("select revision from app.activity_source_revisions where library_id=%s and account_id=%s for update", (current.current_library_id, current.account_id)),
        "account": ("select id from app.accounts where id=%s for no key update", (current.account_id,)),
        "session": ("select id from app.account_sessions where id=%s for no key update", (current.session_id,)),
        "membership": ("select id from library.library_memberships where account_id=%s and library_id=%s for update", (current.account_id, current.current_library_id)),
        "grant": ("select id from app.capabilities where account_id=%s and revoked_at is null for update", (current.account_id,)),
    }
    try:
        with db.connect() as blocker:
            blocker.execute(*locks[blocked_resource]).fetchall()
            with pytest.raises(activity.HomeActivityError) as caught:
                read(db, current, repository=retained_repository(db, retained))
            assert caught.value.status_code == 503
            assert caught.value.code == "activity_busy"
            assert getattr(caught.value.__cause__, "sqlstate", None) == "55P03"
            captures = [operation for operation in retained.operations if operation[0] == "sql" and "set transaction isolation level repeatable read" in operation[1]]
            assert len(captures) == 1, "NOWAIT contention must not silently retry"
            assert_capture_lock_released(db, current.account_id)
        with db.connect() as connection:
            assert connection.execute("select count(*) as count from app.activity_snapshots where account_id=%s", (current.account_id,)).fetchone()["count"] == 0
    finally:
        retained.close()


@pytest.mark.parametrize("failure", ["none", "projection", "unlock"])
def test_capture_lease_does_not_return_a_live_session_lock_after_success_or_failure(mutable_ledger, failure):
    db, current = mutable_ledger["db"], mutable_ledger["actor"]

    def before(sql):
        if failure == "unlock" and "pg_advisory_unlock(" in sql:
            raise RuntimeError("synthetic unlock transport failure")

    def policy(kind, resource_id):
        if failure == "projection":
            raise RuntimeError("synthetic projection failure")
        return allow_all(kind, resource_id)

    retained = RetainedRuntimeConnection(db, before=before)
    try:
        if failure == "none":
            assert read(db, current, allowed=policy, repository=retained_repository(db, retained))["data"]["total_listens"] == 3
            assert retained.closed is False
        else:
            with pytest.raises(RuntimeError, match=f"synthetic {failure}"):
                read(db, current, allowed=policy, repository=retained_repository(db, retained))
            assert retained.closed is (failure == "unlock")
        assert_capture_lock_released(db, current.account_id)
    finally:
        retained.close()


def test_higher_isolation_writer_conservatively_invalidates_receipts_outside_its_old_snapshot(mutable_ledger):
    db, current, data = mutable_ledger["db"], mutable_ledger["actor"], mutable_ledger["data"]
    with db.connect() as connection:
        target = db.event(connection, data, source=LEGACY, seconds=10)
    establish_revision_keys_without_receipts(db, current)
    with db.connect() as writer:
        writer.execute("set transaction isolation level repeatable read")
        writer.execute("select count(*) from app.activity_snapshots where account_id=%s", (current.account_id,)).fetchone()
        initial = read(db, current)["data"]
        assert initial["total_listens"] == 3
        set_qualification(writer, target, LEGACY, {"total": 12, "contiguous": None})
    error_status(lambda: read(db, current, snapshot_ref=initial["snapshot_ref"], page=1), 410)
    assert read(db, current)["data"]["total_listens"] == 4


def expire_session_with_database_clock(connection, session_id, expiry):
    if expiry == "idle":
        connection.execute("update app.account_sessions set idle_expires_at=clock_timestamp()-interval '1 microsecond' where id=%s", (session_id,))
    else:
        connection.execute(
            "with clock as (select clock_timestamp()-interval '1 microsecond' as expired) "
            "update app.account_sessions set idle_expires_at=clock.expired,absolute_expires_at=clock.expired from clock where id=%s",
            (session_id,),
        )


@pytest.mark.parametrize("expiry", ["idle", "absolute"])
def test_page_rechecks_actual_database_session_expiry_instead_of_older_injected_capture_time(mutable_ledger, expiry):
    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    initial = read(db, current)["data"]
    with db.connect() as connection:
        expire_session_with_database_clock(connection, current.session_id, expiry)
        persisted = connection.execute("select idle_expires_at,absolute_expires_at,clock_timestamp() as checked from app.account_sessions where id=%s", (current.session_id,)).fetchone()
    assert persisted["idle_expires_at"] <= persisted["checked"]
    assert NOW < persisted["idle_expires_at"], "Fixture must distinguish an old request clock from current DB authority"
    error_status(lambda: read(db, current, now=NOW, snapshot_ref=initial["snapshot_ref"], page=1), 403)


@pytest.mark.parametrize("expiry", ["idle", "absolute"])
def test_session_expiring_after_capture_rolls_back_without_a_ready_receipt(mutable_ledger, expiry):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    establish_revision_keys_without_receipts(db, current)
    captured, release = Event(), Event()
    paused = False

    def after(sql):
        nonlocal paused
        if "from integration.listen_history h" in sql and not paused:
            paused = True
            captured.set()
            assert release.wait(10), "Expired-session capture was not released"

    retained = RetainedRuntimeConnection(db, after=after)
    try:
        with ThreadPoolExecutor(max_workers=1) as workers:
            result = workers.submit(read, db, current, now=NOW, repository=retained_repository(db, retained))
            try:
                assert captured.wait(10), "Builder did not reach source capture"
                with db.connect() as connection:
                    expire_session_with_database_clock(connection, current.session_id, expiry)
                release.set()
                with pytest.raises(activity.HomeActivityError) as caught:
                    result.result(timeout=20)
                assert caught.value.status_code == 403
            finally:
                release.set()
        with db.connect() as connection:
            assert connection.execute("select count(*) as count from app.activity_snapshots where account_id=%s", (current.account_id,)).fetchone()["count"] == 0
        assert_capture_lock_released(db, current.account_id)
    finally:
        retained.close()


ACTIVITY_TABLES = (
    "app.activity_source_revisions", "app.activity_snapshots",
    "app.activity_snapshot_rows", "app.activity_snapshot_events",
)
REVISION_LOCK_FUNCTION = "app.lock_home_activity_revisions(bigint,bigint)"
INTERNAL_ACTIVITY_FUNCTIONS = (
    "app.bump_home_activity_revision(bigint,bigint)",
    "app.home_activity_event_was_captured(bigint,bigint,bigint)",
    "app.home_activity_legacy_facts(jsonb)",
    "app.invalidate_home_activity_event()", "app.invalidate_home_activity_inventory()",
)


@pytest.fixture
def app_role_connection(database_urls):
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(database_urls[0], row_factory=dict_row, connect_timeout=10,
                         options="-c statement_timeout=20000") as connection:
        login = connection.execute("""select rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
            pg_has_role(current_user,'album_haven_app','MEMBER') as app_member
            from pg_roles where rolname=current_user""").fetchone()
        assert login == {
            "rolsuper": False, "rolcreatedb": False, "rolcreaterole": False,
            "rolreplication": False, "rolbypassrls": False, "app_member": True,
        }, "Role tests require an unprivileged login belonging to the application role"
        # Isolated CI may use a unique login inheriting the canonical role.
        # Select that exact role before exercising the unchanged privilege gates.
        connection.execute("set local role album_haven_app")
        role = connection.execute("select current_user as name,rolsuper from pg_roles where rolname=current_user").fetchone()
        assert role == {"name": "album_haven_app", "rolsuper": False}, "Role tests require the actual unprivileged app URL"
        assert connection.execute("select to_regrole('album_haven_readonly') is not null as present").fetchone()["present"] is True
        yield connection


def test_effective_activity_cache_privileges_exclude_readonly_public_and_revision_mutation(app_role_connection):
    connection = app_role_connection
    for table in ACTIVITY_TABLES:
        for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
            effective = connection.execute("select has_table_privilege('album_haven_app',%s,%s) as app,has_table_privilege('album_haven_readonly',%s,%s) as readonly",
                                           (table, privilege, table, privilege)).fetchone()
            expected = privilege == "SELECT" if table == "app.activity_source_revisions" else privilege in {"SELECT", "INSERT", "UPDATE", "DELETE"}
            assert effective == {"app": expected, "readonly": False}, (table, privilege, effective)
        for privilege in ("SELECT", "INSERT", "UPDATE", "REFERENCES"):
            assert connection.execute("select has_any_column_privilege('album_haven_readonly',%s,%s) as allowed", (table, privilege)).fetchone()["allowed"] is False
        public = connection.execute("select count(*) as count from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=%s::regclass and a.grantee=0", (table,)).fetchone()["count"]
        assert public == 0
    for column, expected in (("library_id", True), ("account_id", True), ("revision", False)):
        assert connection.execute("select has_column_privilege('album_haven_app','app.activity_source_revisions',%s,'INSERT') as allowed", (column,)).fetchone()["allowed"] is expected
    for privilege, expected in (("USAGE", True), ("SELECT", True), ("UPDATE", False)):
        row = connection.execute("select has_sequence_privilege('album_haven_app','app.activity_snapshots_id_seq',%s) as app,has_sequence_privilege('album_haven_readonly','app.activity_snapshots_id_seq',%s) as readonly", (privilege, privilege)).fetchone()
        assert row == {"app": expected, "readonly": False}
    assert connection.execute("select count(*) as count from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('S',c.relowner))) a where c.oid='app.activity_snapshots_id_seq'::regclass and a.grantee=0").fetchone()["count"] == 0


def test_only_the_narrow_revision_lock_function_is_executable_by_app(app_role_connection):
    connection = app_role_connection
    for function in (REVISION_LOCK_FUNCTION, *INTERNAL_ACTIVITY_FUNCTIONS):
        row = connection.execute("select has_function_privilege('album_haven_app',%s,'EXECUTE') as app,has_function_privilege('album_haven_readonly',%s,'EXECUTE') as readonly", (function, function)).fetchone()
        assert row == {"app": function == REVISION_LOCK_FUNCTION, "readonly": False}
        assert connection.execute("select count(*) as count from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=%s::regprocedure and a.grantee=0", (function,)).fetchone()["count"] == 0
    definition = connection.execute("select prosecdef,provolatile,proconfig from pg_proc where oid=%s::regprocedure", (REVISION_LOCK_FUNCTION,)).fetchone()
    assert definition["prosecdef"] is True
    assert definition["provolatile"] == "v"
    assert "search_path=pg_catalog" in definition["proconfig"]


def test_app_cannot_update_revision_evidence_or_take_direct_row_locks(mutable_ledger, app_role_connection):
    import psycopg

    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    establish_revision_keys_without_receipts(db, current)
    for statement, params in [
        ("update app.activity_source_revisions set revision=revision where library_id=%s and account_id=%s", (current.current_library_id, current.account_id)),
        ("delete from app.activity_source_revisions where false", ()),
        ("insert into app.activity_source_revisions(library_id,account_id,revision) values(%s,%s,0) on conflict do nothing", (current.current_library_id, current.account_id)),
        ("select revision from app.activity_source_revisions where library_id=%s and account_id=%s for share nowait", (current.current_library_id, current.account_id)),
    ]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with app_role_connection.transaction():
                app_role_connection.execute(statement, params)
    rows = app_role_connection.execute("select * from app.lock_home_activity_revisions(%s,%s)", (current.current_library_id, current.account_id)).fetchall()
    assert {row["account_id"] for row in rows} == {0, current.account_id}
    assert all(type(row["revision"]) is int and row["revision"] >= 0 for row in rows)


@pytest.mark.parametrize("locked_account", ["inventory", "actor"])
def test_narrow_revision_lock_function_takes_and_observes_real_nowait_row_locks(mutable_ledger, app_role_connection, locked_account):
    import psycopg

    db, current = mutable_ledger["db"], mutable_ledger["actor"]
    establish_revision_keys_without_receipts(db, current)
    target = 0 if locked_account == "inventory" else current.account_id
    with db.connect() as blocker:
        blocker.execute("select revision from app.activity_source_revisions where library_id=%s and account_id=%s for update", (current.current_library_id, target)).fetchone()
        with pytest.raises(psycopg.errors.LockNotAvailable):
            with app_role_connection.transaction():
                app_role_connection.execute("select * from app.lock_home_activity_revisions(%s,%s)", (current.current_library_id, current.account_id)).fetchall()
    app_role_connection.execute("select * from app.lock_home_activity_revisions(%s,%s)", (current.current_library_id, current.account_id)).fetchall()
    with db.connect() as contender:
        with pytest.raises(psycopg.errors.LockNotAvailable):
            with contender.transaction():
                contender.execute("select revision from app.activity_source_revisions where library_id=%s and account_id=%s for update nowait", (current.current_library_id, target)).fetchone()
    app_role_connection.commit()
    with db.connect() as contender:
        assert contender.execute("select revision from app.activity_source_revisions where library_id=%s and account_id=%s for update nowait", (current.current_library_id, target)).fetchone() is not None
