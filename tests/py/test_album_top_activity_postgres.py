"""Activity integration against the existing isolated PostgreSQL fixture owner."""
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Event
from datetime import timedelta

from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from music_app.services.postgres_connections import pooled_connection

import pytest

from music_app.services.owned_album_tops import normalize_top_command
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error, CURSOR_SECRET
from tests.py.test_album_top_collaboration_postgres import member, shared


def activity_command(top, active, revision="0", key=None):
    return normalize_top_command("set_activity", {"request_key": key or str(uuid4()),
        "active": active, "activity_revision": revision}, top_ref=top["top_ref"])


def completion_command(db, top, completed, *, revision="0", album=0):
    return normalize_top_command("set_manual_completion", {"request_key": str(uuid4()),
        "album_ref": db.album_refs[album], "completed": completed,
        "progress_revision": revision}, top_ref=top["top_ref"])


def state_snapshot(db):
    with db.connect() as connection:
        return {table: connection.execute(f"select * from app.{table} where library_id=%s "
            "order by account_id,top_ref" + (",revision" if table.endswith("transitions") else
                ",catalog_ref" if table.endswith("item_progress") else ""),
            (db.library,)).fetchall() for table in (
                "album_list_activity", "album_list_activity_transitions", "album_list_item_progress")}


def test_absent_activity_defaults_active_without_read_side_effects(db):
    top, _ = db.create()
    before = db.snapshot(), state_snapshot(db)
    detail = db.read(top)
    assert detail["top_viewer_overlay"]["activity"] == {"active": True, "activity_revision": "0"}
    assert detail["allowed_actions"]["can_set_activity"]
    assert detail["allowed_actions"]["can_manage_own_progress"]
    listed = db.service.list(db.context(), cursor_secret=CURSOR_SECRET)["tops"]
    assert listed[0]["top_viewer_overlay"]["activity"] == detail["top_viewer_overlay"]["activity"]
    assert (db.snapshot(), state_snapshot(db)) == before


def test_pause_retains_marks_and_rejects_both_fresh_progress_directions(db):
    top, _ = db.create()
    mark = completion_command(db, top, True)
    completed = db.service.execute(db.context(), mark)
    original_progress = state_snapshot(db)["album_list_item_progress"]
    shared_before = db.snapshot()
    paused = db.service.execute(db.context(), activity_command(top, False))
    assert paused["active"] is False and paused["activity_revision"] == "1"
    detail = db.read(top)
    assert detail["top_viewer_overlay"]["item_progress"][db.album_refs[0]]["manual_completed_at"] == completed["manual_completed_at"]
    assert detail["allowed_actions"]["can_set_activity"]
    assert not detail["allowed_actions"]["can_manage_own_progress"]
    before = db.snapshot(), state_snapshot(db)
    for command in (completion_command(db, top, False, revision="1"),
                    completion_command(db, top, True, album=1)):
        assert_error(lambda: db.service.execute(db.context(), command), "top_inactive", 409)
    assert (db.snapshot(), state_snapshot(db)) == before
    assert state_snapshot(db)["album_list_item_progress"] == original_progress
    assert db.snapshot()["tops"] == shared_before["tops"]
    assert db.snapshot()["items"] == shared_before["items"]
    assert db.service.execute(db.context(), mark) == completed
    assert (db.snapshot(), state_snapshot(db)) == before
    db.service.execute(db.context(), activity_command(top, True, "1"))
    db.service.execute(db.context(), completion_command(db, top, True, album=1))
    assert original_progress[0] in state_snapshot(db)["album_list_item_progress"]


def test_two_listeners_have_independent_activity_and_progress(db):
    other = member(db)
    top = shared(db)
    db.service.execute(db.context(), activity_command(top, False))
    detail = db.service.read(db.context(other), top_ref=top["top_ref"])
    assert detail["top_viewer_overlay"]["activity"]["active"]
    assert detail["allowed_actions"]["can_manage_own_progress"]
    db.service.execute(db.context(other), completion_command(db, top, True))
    assert db.read(top)["top_viewer_overlay"]["activity"]["active"] is False
    assert db.read(top)["top_viewer_overlay"]["item_progress"][db.album_refs[0]]["manual_completed_at"] is None


def test_replay_is_historical_and_noop_does_not_append_history(db):
    top, _ = db.create()
    activate = activity_command(top, True)
    receipt = db.service.execute(db.context(), activate)
    assert receipt["changed"] is False and receipt["activity_revision"] == "0"
    baseline = state_snapshot(db)
    db.service.execute(db.context(), activity_command(top, True))
    assert state_snapshot(db) == baseline
    db.service.execute(db.context(), activity_command(top, False))
    paused = state_snapshot(db), db.snapshot()
    assert db.service.execute(db.context(), activate) == receipt
    assert (state_snapshot(db), db.snapshot()) == paused
    assert db.read(top)["top_viewer_overlay"]["activity"]["active"] is False
    conflict = activity_command(top, False, key=activate.request_key)
    assert_error(lambda: db.service.execute(db.context(), conflict), "request_key_conflict", 409)
    assert_error(lambda: db.service.execute(db.context(), activity_command(top, True)),
        "activity_revision_conflict", 409)
    assert (state_snapshot(db), db.snapshot()) == paused


def test_initial_stale_revision_rolls_back_baseline_and_receipt(db):
    top, _ = db.create()
    before = state_snapshot(db), db.snapshot()
    assert_error(lambda: db.service.execute(db.context(), activity_command(top, False, "2")),
        "activity_revision_conflict", 409)
    assert (state_snapshot(db), db.snapshot()) == before


def test_pause_and_progress_serialize_at_existing_account_lock(db):
    top, _ = db.create()
    pause_locked, release_pause, progress_waiting = Event(), Event(), Event()

    class ObservedConnection:
        def __init__(self, real, pausing):
            self.real, self.pausing = real, pausing

        def execute(self, sql, params=()):
            account_lock = "from app.accounts" in sql.lower() and "for update" in sql.lower()
            if account_lock and not self.pausing:
                progress_waiting.set()
            result = self.real.execute(sql, params)
            if account_lock and self.pausing:
                pause_locked.set()
                assert release_pause.wait(5), "Pause lock checkpoint was not released"
            return result

    def connector(pausing):
        @contextmanager
        def connect(url):
            with pooled_connection(url) as real:
                yield ObservedConnection(real, pausing)
        return connect

    config = {"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url}
    pausing = PostgresOwnedAlbumTopsService(config, connect=connector(True))
    marking = PostgresOwnedAlbumTopsService(config, connect=connector(False))
    with ThreadPoolExecutor(max_workers=2) as pool:
        pause = pool.submit(pausing.execute, db.context(), activity_command(top, False))
        try:
            assert pause_locked.wait(5)
            mark = pool.submit(marking.execute, db.context(), completion_command(db, top, True))
            assert progress_waiting.wait(5)
        finally:
            release_pause.set()
        assert pause.result(timeout=10)["active"] is False
        assert_error(lambda: mark.result(timeout=10), "top_inactive", 409)
    assert state_snapshot(db)["album_list_item_progress"] == []


def test_expired_session_cannot_replay_activity_or_append_progress(db):
    top, _ = db.create()
    command = activity_command(top, False)
    db.service.execute(db.context(), command)
    with db.connect() as connection:
        connection.execute("update app.account_sessions set idle_expires_at=%s where id=%s",
            (db.now - timedelta(seconds=1), db.owner.session_id))
    before = state_snapshot(db), db.snapshot()
    for attempted in (command, activity_command(top, True, "1"), completion_command(db, top, True)):
        assert_error(lambda: db.service.execute(db.context(), attempted), "forbidden", 403)
    assert (state_snapshot(db), db.snapshot()) == before


def test_activity_history_is_append_only_for_runtime_and_private(db):
    expected = {"app.album_list_activity": {"SELECT", "INSERT", "UPDATE"},
        "app.album_list_activity_transitions": {"SELECT", "INSERT"}}
    with db.connect() as connection:
        for table, allowed in expected.items():
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
                actual = connection.execute("""select has_table_privilege('album_haven_app',%s,%s) as app,
                    has_table_privilege('album_haven_readonly',%s,%s) as readonly""",
                    (table, privilege, table, privilege)).fetchone()
                assert actual == {"app": privilege in allowed, "readonly": False}
            assert connection.execute("""select count(*) as n from pg_class c cross join lateral
                aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) p
                where c.oid=%s::regclass and p.grantee=0""", (table,)).fetchone()["n"] == 0


@pytest.mark.parametrize("operation", ["pause", "progress", "replay"])
def test_activity_session_expiry_while_waiting_for_parent_denies_without_writes(db, operation):
    top, _ = db.create()
    replay = activity_command(top, True)
    db.service.execute(db.context(), replay)
    command = {"pause": activity_command(top, False),
        "progress": completion_command(db, top, True), "replay": replay}[operation]
    reached_parent = Event()
    observed_now = [db.now]

    class Connection:
        def __init__(self, real):
            self.real = real

        def execute(self, sql, params=()):
            normalized = " ".join(sql.lower().split())
            if "select * from app.album_lists" in normalized and "for share" in normalized:
                reached_parent.set()
            return self.real.execute(sql, params)

    @contextmanager
    def connect(url):
        with pooled_connection(url) as real:
            yield Connection(real)

    service = PostgresOwnedAlbumTopsService({"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url},
        connect=connect, clock=lambda: observed_now[0])
    before = state_snapshot(db), db.snapshot()
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.connect() as blocker:
            blocker.execute("select ref from app.album_lists where ref=%s for update", (top["top_ref"],))
            future = pool.submit(service.execute, db.context(), command)
            assert reached_parent.wait(5), "Activity must reach the held parent lock"
            observed_now[0] = db.now + timedelta(days=2)
        assert_error(lambda: future.result(timeout=10), "forbidden", 403)
    assert (state_snapshot(db), db.snapshot()) == before


@pytest.mark.parametrize("loss", ["revoke", "delete"])
@pytest.mark.parametrize("kind", ["activity", "progress"])
def test_private_receipt_rechecks_access_after_parent_wait(db, loss, kind):
    from tests.py.test_album_top_collaboration_postgres import write

    viewer = member(db)
    top, _ = db.create()
    granted, _ = write(db, "grant_viewer", top, account_id=viewer.account_id, role="viewer")
    command = activity_command(top, True) if kind == "activity" else completion_command(db, top, True)
    db.service.execute(db.context(viewer), command)
    reached_parent = Event()

    class Connection:
        def __init__(self, real):
            self.real = real

        def execute(self, sql, params=()):
            if "select * from app.album_lists" in " ".join(sql.lower().split()):
                reached_parent.set()
            return self.real.execute(sql, params)

    @contextmanager
    def connect(url):
        with pooled_connection(url) as real:
            yield Connection(real)

    service = PostgresOwnedAlbumTopsService({"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url}, connect=connect)
    private_before = state_snapshot(db)
    receipts_before = db.snapshot()["operations"]
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.connect() as blocker:
            blocker.execute("select ref from app.album_lists where ref=%s for update", (top["top_ref"],))
            future = pool.submit(service.execute, db.context(viewer), command)
            assert reached_parent.wait(5), "Replay must reach the held parent lock"
            if loss == "revoke":
                blocker.execute("delete from app.album_list_access_grants where ref=%s", (granted["grant_ref"],))
            else:
                blocker.execute("update app.album_lists set deleted_at=now() where ref=%s", (top["top_ref"],))
        assert_error(lambda: future.result(timeout=10), "top_unavailable", 404)
    assert state_snapshot(db) == private_before
    assert db.snapshot()["operations"] == receipts_before
    assert db.service.list(db.context(viewer), cursor_secret=CURSOR_SECRET)["tops"] == []
    assert_error(lambda: service.execute(db.context(viewer), activity_command(top, False)),
        "top_unavailable", 404)
    assert state_snapshot(db) == private_before
    assert db.snapshot()["operations"] == receipts_before


@pytest.mark.parametrize("corruption", ["missing_baseline", "baseline_time", "revision_gap", "nonmonotonic"])
def test_activity_toggle_rejects_corrupt_retained_history_without_repair(db, corruption):
    from music_app.services.album_top_activity import ActivityError

    top, _ = db.create()
    db.service.execute(db.context(), activity_command(top, False))
    db.service.execute(db.context(), activity_command(top, True, "1"))
    key = (db.owner.account_id, db.library, top["top_ref"])
    with db.connect() as connection:
        if corruption == "missing_baseline":
            connection.execute("delete from app.album_list_activity_transitions where account_id=%s and library_id=%s and top_ref=%s and revision=0", key)
        elif corruption == "baseline_time":
            connection.execute("update app.album_list_activity set started_at=started_at-interval '1 second' where account_id=%s and library_id=%s and top_ref=%s", key)
        elif corruption == "revision_gap":
            connection.execute("delete from app.album_list_activity_transitions where account_id=%s and library_id=%s and top_ref=%s and revision=1", key)
        else:
            connection.execute("update app.album_list_activity_transitions set occurred_at=occurred_at-interval '1 day' where account_id=%s and library_id=%s and top_ref=%s and revision=2", key)
    before = state_snapshot(db), db.snapshot()
    with pytest.raises(ActivityError):
        db.service.execute(db.context(), activity_command(top, False, "2"))
    assert (state_snapshot(db), db.snapshot()) == before


def test_private_activity_never_changes_guest_or_member_publication_payload(db):
    from music_app.services.policy import RequestOrigin
    from music_app.services.public_album_tops_postgres import PostgresPublicAlbumTopsService

    config = {"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url,
        "ALBUM_HAVEN_PUBLIC_SHARING_ENABLED": True,
        "ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN": "https://albums.example.test",
        "ALBUM_HAVEN_PUBLIC_BASE_URL": "https://albums.example.test"}
    owner = PostgresOwnedAlbumTopsService(config)
    public = PostgresPublicAlbumTopsService(config)
    top, _ = db.create(refs=[])
    preview = owner.publication_preview(db.context(), top_ref=top["top_ref"],
        payload={"revision": top["revision"], "items": []})
    published = owner.execute(db.context(), db.command("enable_external", top,
        items=[], evidence_revision=preview["evidence_revision"]))
    share_ref = published["publication"]["share_ref"]
    viewer = member(db)

    def guest():
        return public.read_guest(share_ref=share_ref,
            request_origin=RequestOrigin("network", config["ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN"]),
            cursor_secret=CURSOR_SECRET)

    def member_publication():
        return public.read_published(db.context(viewer), top_ref=top["top_ref"],
            share_ref=share_ref, context_ref="a" * 64, cursor_secret=CURSOR_SECRET)

    before_guest, before_member = guest(), member_publication()
    owner.execute(db.context(), activity_command(top, False))
    assert db.read(top)["top_viewer_overlay"]["activity"]["active"] is False
    assert guest() == before_guest
    assert member_publication() == before_member
    forbidden = {"top_viewer_overlay", "activity", "activity_revision", "active", "item_progress", "manual_completed_at", "can_set_activity", "can_manage_own_progress"}

    def assert_public(value):
        if isinstance(value, dict):
            assert forbidden.isdisjoint(value)
            for child in value.values():
                assert_public(child)
        elif isinstance(value, list):
            for child in value:
                assert_public(child)

    assert_public(guest())
    assert_public(member_publication())
    assert_error(lambda: db.service.read(db.context(viewer), top_ref=top["top_ref"]), "top_unavailable", 404)


@pytest.mark.parametrize("operation", ["pause", "progress"])
def test_private_event_time_is_sampled_after_parent_wait(db, operation):
    top, _ = db.create()
    # Establish activity using the ordinary service clock, later than db.now.
    db.service.execute(db.context(), activity_command(top, True))
    command = activity_command(top, False) if operation == "pause" else completion_command(db, top, True)
    reached_parent = Event()
    observed_now = [db.now]
    after_wait = db.now + timedelta(minutes=1)

    class Connection:
        def __init__(self, real):
            self.real = real

        def execute(self, sql, params=()):
            normalized = " ".join(sql.lower().split())
            if "select * from app.album_lists" in normalized and "for share" in normalized:
                reached_parent.set()
            return self.real.execute(sql, params)

    @contextmanager
    def connect(url):
        with pooled_connection(url) as real:
            real.execute("set local statement_timeout='8s'")
            yield Connection(real)

    service = PostgresOwnedAlbumTopsService({"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url},
        connect=connect, clock=lambda: observed_now[0])
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.connect() as blocker:
            blocker.execute("select ref from app.album_lists where ref=%s for update", (top["top_ref"],))
            future = pool.submit(service.execute, db.context(), command)
            assert reached_parent.wait(5), "Private mutation must reach the held parent lock"
            observed_now[0] = after_wait
        receipt = future.result(timeout=10)
    assert receipt["changed"] is True
    state = state_snapshot(db)
    if operation == "pause":
        assert receipt["active"] is False and receipt["activity_revision"] == "1"
        assert state["album_list_activity_transitions"][-1]["occurred_at"] == after_wait
    else:
        assert state["album_list_item_progress"][0]["manual_completed_at"] == after_wait
