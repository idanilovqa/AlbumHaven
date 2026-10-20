"""Real R3 actor-lock serialization, not a synthetic same-scope PK race.

The only paused points wrap/forward the real lock or real evaluation. PostgreSQL
pg_blocking_pids proves a waiter is blocked by the first actual transaction.
"""
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock
from time import monotonic, sleep
from uuid import uuid4

import pytest
from library_mix_postgres_support import mix_db, mix_urls
from music_app.services import private_library_authority as authority
from music_app.services import sample_playlist as evaluator
from music_app.services.owned_playlists import PlaylistError
from test_sample_playlist_sources_live import manual_source
from test_sample_playlist_receipts_live import capture, retained, options, sources


def assert_pg_wait(db, waiter, blocker):
    deadline = monotonic() + 10
    with db.connect() as con:
        while monotonic() < deadline:
            if blocker in con.execute("select pg_blocking_pids(%s) as blockers", (waiter,)).fetchone()["blockers"]:
                return
            sleep(0.01)
    pytest.fail("Second capture did not wait on the first real actor-account transaction")


@pytest.mark.parametrize("ending", ["commit", "rollback", "different_input", "expired_after_wait"])
def test_same_actor_real_lock_serializes_capture_then_replay(mix_db, monkeypatch, ending):
    db = mix_db
    parent = manual_source(db)
    key = str(uuid4())
    first_evaluating, second_lock_entered, release = Event(), Event(), Event()
    guard = Lock()
    pids, evaluations = [], []
    real_lock, real_evaluate = authority.lock_admin_accounts, evaluator.evaluate_sample_playlist

    def locked(connection, actor, target):
        assert actor == target == db.owner.account_id
        with guard:
            pids.append(connection.info.backend_pid)
            second = len(pids) == 2
        if second:
            second_lock_entered.set()
        # Never remove/replace/relax the actual FOR UPDATE account lock.
        value = real_lock(connection, actor, target)
        if second and ending == "expired_after_wait":
            db.clock_time += sources.SOURCE_LIFETIME
        return value

    def evaluated(*args, **kwargs):
        result = real_evaluate(*args, **kwargs)
        with guard:
            evaluations.append(result)
            first = len(evaluations) == 1
        if first:
            first_evaluating.set()
            assert release.wait(10), "Test controller did not release first transaction"
            if ending == "rollback":
                raise RuntimeError("rollback first capture")
        return result

    monkeypatch.setattr(authority, "lock_admin_accounts", locked)
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", evaluated)
    pool = ThreadPoolExecutor(max_workers=2)
    try:
        first = pool.submit(capture, db, parent, key=key)
        assert first_evaluating.wait(10)
        second = pool.submit(capture, db, parent, key=key,
            opts=options(songs_per_group=2 if ending == "different_input" else 1))
        assert second_lock_entered.wait(10)
        assert len(pids) == 2 and pids[0] != pids[1]
        assert_pg_wait(db, pids[1], pids[0])
        assert not second.done()
        release.set()
        if ending == "rollback":
            with pytest.raises(RuntimeError, match="rollback first capture"):
                first.result(timeout=10)
            result = second.result(timeout=10)
            assert len(evaluations) == 2
        else:
            result = first.result(timeout=10)
            if ending == "different_input":
                with pytest.raises(PlaylistError, match="request_key_conflict"):
                    second.result(timeout=10)
            elif ending == "expired_after_wait":
                # This variant's fresh-clock injection is installed at lock exit below.
                with pytest.raises(PlaylistError, match="source_expired"):
                    second.result(timeout=10)
            else:
                assert second.result(timeout=10) == result
            assert len(evaluations) == 1
        row, entries = retained(db, key)
        assert str(row["revision"]) == result["source"]["revision"]
        assert len(entries) == len(result["entries"])
    finally:
        release.set()
        pool.shutdown(wait=True, cancel_futures=True)


def test_cross_actor_same_uuid_race_maps_pk_failure_without_foreign_disclosure(mix_db, monkeypatch):
    db = mix_db
    first_parent = manual_source(db)
    with db.connect() as con:
        actor = db.member(con)
    from music_app.services.playlist_complete_sources import CompletePlaylistSources
    from test_sample_playlist_receipts_live import snapshots
    selected = CompletePlaylistSources(playlists=db.service).from_inventory(db.context(actor),
        [f"inventory-track:{db.library}:{db.tracks[i]}" for i in (4, 1, 3)])["data"]
    second_parent = db.service.execute(db.context(actor), db.create_command(selected, title="Other actor parent"))
    key = str(uuid4())
    ready, second_inventory, release = Event(), Event(), Event()
    real_eval, real_read = evaluator.evaluate_sample_playlist, snapshots.inventory.read_inventory
    pids, evaluations = [], []
    guard = Lock()
    def inventory(connection, *args, **kwargs):
        with guard:
            pids.append(connection.info.backend_pid)
            second = len(pids) == 2
        if second: second_inventory.set()
        return real_read(connection, *args, **kwargs)
    def evaluate(*args, **kwargs):
        value = real_eval(*args, **kwargs)
        with guard:
            evaluations.append(value)
            first = len(evaluations) == 1
        if first:
            ready.set()
            assert release.wait(10)
        return value
    monkeypatch.setattr(snapshots.inventory, "read_inventory", inventory)
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", evaluate)
    pool = ThreadPoolExecutor(max_workers=2)
    try:
        first = pool.submit(capture, db, first_parent, key=key)
        assert ready.wait(10)
        second = pool.submit(capture, db, second_parent, key=key, context=db.context(actor))
        assert second_inventory.wait(10)
        assert_pg_wait(db, pids[1], pids[0])
        release.set()
        result = first.result(timeout=10)
        with pytest.raises(PlaylistError, match="duplicate_identity") as error:
            second.result(timeout=10)
        assert str(error.value) == "duplicate_identity"
        row, entries = retained(db, key)
        assert row["actor_account_id"] == db.owner.account_id
        assert str(row["revision"]) == result["source"]["revision"]
        assert len(entries) == len(result["entries"])
        assert len(evaluations) == 2  # No automatic retry after the PK failure.
    finally:
        release.set()
        pool.shutdown(wait=True, cancel_futures=True)

# Imported autouse fixture also protects this independently scheduled module.
from test_sample_playlist_receipts_live import no_provider


def test_disjoint_actor_and_inventory_race_waits_on_actual_header_insert(mix_db, monkeypatch):
    from music_app.services import playlist_complete_sources as complete
    db = mix_db
    parent1 = manual_source(db, (0, 1))
    with db.connect() as con:
        actor = db.member(con)
    selected = complete.CompletePlaylistSources(playlists=db.service).from_inventory(db.context(actor),
        [f"inventory-track:{db.library}:{db.tracks[i]}" for i in (3, 4)])["data"]
    parent2 = db.service.execute(db.context(actor), db.create_command(selected, title="Disjoint collision parent"))
    key = str(uuid4())
    inserted, second_entered, release = Event(), Event(), Event()
    pids, insert_attempts = [], []
    real_header = complete._header
    guard = Lock()
    def header(connection, *args, **kwargs):
        with guard:
            pids.append(connection.info.backend_pid)
            insert_attempts.append(kwargs["source_ref"])
            first = len(pids) == 1
        if not first:
            second_entered.set()
        result = real_header(connection, *args, **kwargs)
        if first:
            inserted.set()
            assert release.wait(10)
        return result
    monkeypatch.setattr(complete, "_header", header)
    pool = ThreadPoolExecutor(max_workers=2)
    try:
        first = pool.submit(capture, db, parent1, key=key)
        assert inserted.wait(10)
        second = pool.submit(capture, db, parent2, key=key, context=db.context(actor))
        assert second_entered.wait(10)
        assert_pg_wait(db, pids[1], pids[0])
        # Both actors and candidate albums/tracks are disjoint. The second has
        # reached real _header, so this is the PK INSERT wait, not inventory.
        release.set()
        result = first.result(timeout=10)
        with pytest.raises(PlaylistError, match="duplicate_identity") as error:
            second.result(timeout=10)
        assert error.value.status_code == 409
        assert insert_attempts == [key, key]
        row, entries = retained(db, key)
        assert row["actor_account_id"] == db.owner.account_id
        assert str(row["revision"]) == result["source"]["revision"]
        assert len(entries) == len(result["entries"])
    finally:
        release.set()
        pool.shutdown(wait=True, cancel_futures=True)


def test_waiting_read_rechecks_actual_committed_create_revocation(mix_db, monkeypatch):
    from music_app.services.owned_playlists import CREATE
    from test_sample_playlist_receipts_live import read
    db = mix_db
    source = capture(db, manual_source(db))
    entered = Event()
    waiter_pid = []
    real_lock = authority.lock_admin_accounts
    def lock(connection, *args):
        waiter_pid.append(connection.info.backend_pid)
        entered.set()
        return real_lock(connection, *args)
    monkeypatch.setattr(authority, "lock_admin_accounts", lock)
    pool = ThreadPoolExecutor(max_workers=1)
    blocker = db.connect()
    try:
        blocker.execute("select id from app.accounts where id=%s for update", (db.owner.account_id,)).fetchall()
        blocker.execute("delete from app.capabilities where account_id=%s and capability_key=%s", (db.owner.account_id, CREATE))
        future = pool.submit(read, db, source)
        assert entered.wait(10)
        assert_pg_wait(db, waiter_pid[0], blocker.info.backend_pid)
        blocker.commit()
        with pytest.raises(PlaylistError) as error:
            future.result(timeout=10)
        assert error.value.status_code == 403
    finally:
        blocker.rollback()
        blocker.close()
        pool.shutdown(wait=True, cancel_futures=True)
