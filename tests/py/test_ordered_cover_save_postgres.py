"""Opt-in actual PostgreSQL Save/lock qualification on a minimal synthetic schema.

Requires ALBUM_HAVEN_ORDERED_SAVE_TEST_DATABASE JSON (host, port, dbname, user,
password) identifying an EMPTY dedicated loopback database. No app/ambient PG
credentials are used. Unlike the constraint-only tests, setup COMMIT is required
for production connections; teardown drops only the fixture-owned schemas.
This is not the full historical migration tree, deployment roles, HTTP, UI,
provider, crash recovery, or performance qualification. All sources are generated
inside tmp_path. No recording SQL connection or persistence helper is substituted.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
import multiprocessing
import os
from pathlib import Path
import re
import threading
import time
from types import SimpleNamespace
from uuid import uuid4

import pytest
from PIL import Image

from music_app.services.cover_mutation import CoverMutationEffect, cover_source_keys
from music_app.services.ordered_cover_references import OrderedCoverSelectionConflict
from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter


TARGET_ENV = "ALBUM_HAVEN_ORDERED_SAVE_TEST_DATABASE"
MIGRATION = (Path(__file__).resolve().parents[2] / "migrations/postgres/0104_add_ordered_cover_metadata_constraint.sql")
# Deliberately minimal queried columns. Generated projections match migration 0021;
# candidate-generation UUID/FK match 0041. Omitted deployment tables are not tested.
SCHEMA = """
create schema app;
create schema library;
create table app.bootstrap_owners (owner_key text primary key, account_id bigint not null unique);
create table library.libraries (id bigint primary key, owner_account_id bigint not null,
 name text not null, library_kind text not null, metadata jsonb not null default '{}', updated_at timestamptz);
create table library.library_roots (id bigint primary key, library_id bigint not null references library.libraries,
 is_active boolean not null, metadata jsonb not null default '{}');
create table library.local_albums (id bigint primary key, library_id bigint not null references library.libraries,
 cover_path text, metadata jsonb not null default '{}');
create table library.local_tracks (id bigint primary key, album_id bigint not null references library.local_albums,
 library_id bigint not null references library.libraries);
create table library.local_track_files (id bigint primary key, track_id bigint not null references library.local_tracks,
 library_root_id bigint not null references library.library_roots, private_path text not null unique, metadata jsonb not null,
 scan_cache_stale boolean generated always as (
   lower(btrim(coalesce(metadata #>> '{scan_cache,stale}', ''))) in ('true','t','yes','y','on','1')) stored,
 scan_file_entry_is_object boolean generated always as (jsonb_typeof(metadata #> '{scan_cache,file_entry}') = 'object') stored);
create table library.library_root_settings (library_id bigint primary key references library.libraries, settings_payload jsonb not null);
create table library.local_album_cover_candidate_snapshots (album_id bigint primary key references library.local_albums on delete cascade,
 search_generation uuid not null, candidates jsonb not null);
"""


def _explicit_target(raw):
    try:
        target = json.loads(raw)
    except (TypeError, ValueError):
        raise pytest.UsageError("Save PostgreSQL target must be an explicit JSON object") from None
    if not isinstance(target, dict) or set(target) != {"host", "port", "dbname", "user", "password"}:
        raise pytest.UsageError("Save target requires exactly host, port, dbname, user, password")
    if (target["host"] not in ("127.0.0.1", "::1")
            or type(target["port"]) is not int or not 1 <= target["port"] <= 65535
            or not isinstance(target["dbname"], str)
            or not re.fullmatch(r"pytest_ordered_cover_[a-f0-9]{16,32}", target["dbname"])
            or not isinstance(target["user"], str) or not target["user"]
            or not isinstance(target["password"], str)):
        raise pytest.UsageError("Save tests require a unique explicitly owned isolated loopback database")
    return target


@pytest.fixture(scope="module")
def save_pg_database():
    raw = os.environ.get(TARGET_ENV)
    if raw is None:
        pytest.skip(f"actual PostgreSQL unqualified: configure empty dedicated {TARGET_ENV}")
    target = _explicit_target(raw)
    import psycopg
    from psycopg.rows import dict_row

    # Applies throughout threaded connections, with no concurrent environment edits.
    with pytest.MonkeyPatch.context() as patch:
        for name in list(os.environ):
            if name.startswith("PG"):
                patch.delenv(name)

        def connect(label="ordered-save-observer", *, dictionaries=False):
            return psycopg.connect(**target, passfile=os.devnull, connect_timeout=5,
                sslmode="disable", application_name=label,
                options="-c statement_timeout=15000 -c lock_timeout=10000",
                **({"row_factory": dict_row} if dictionaries else {}))

        connect.isolated_target = dict(target)
        with connect() as admin:
            assert admin.execute("select current_database(), current_user").fetchone() == (target["dbname"], target["user"])
            occupied = admin.execute("""select exists(select 1 from pg_namespace where nspname in ('app','library'))
                or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%%'
                and c.relkind in ('r','p','v','m','f','S'))""").fetchone()[0]
            assert not occupied, "Refusing a nonempty Save test database"
            admin.execute(SCHEMA)
            admin.execute(MIGRATION.read_text(encoding="utf-8"))
        try:
            yield connect
        finally:
            # We created both schemas only after the empty-target check succeeded.
            with connect() as admin:
                admin.execute("drop schema library cascade; drop schema app cascade")


@pytest.fixture
def saved_pg(save_pg_database, tmp_path):
    connect = save_pg_database
    root = tmp_path / "synthetic-album"
    root.mkdir()
    first, second = root / "front.jpg", root / "back.jpg"
    for path, color in [(first, "red"), (second, "blue")]:
        Image.new("RGB", (12, 12), color).save(path)
    track = root / "track.flac"
    track.write_bytes(b"synthetic identity only; no tag or audio I/O")
    original = {"selected_covers": [
        {"selection_id": "front", "kind": "local", "path": str(first)},
        {"selection_id": "back", "kind": "local", "path": str(second)}],
        "selected_covers_revision": 3, "unrelated": {"keep": True}}
    with connect() as setup:
        setup.execute("insert into app.bootstrap_owners values ('local-bootstrap-owner',1)")
        setup.execute("insert into library.libraries(id,owner_account_id,name,library_kind) values (1,1,'Local Library','local')")
        setup.execute("insert into library.library_roots(id,library_id,is_active) values (1,1,true)")
        setup.execute("insert into library.local_albums values (72,1,%s,%s::jsonb)", (str(first), json.dumps(original)))
        setup.execute("insert into library.local_tracks values (172,72,1)")
        setup.execute("insert into library.local_track_files(id,track_id,library_root_id,private_path,metadata) values (272,172,1,%s,%s::jsonb)",
            (str(track), json.dumps({"scan_cache": {"source": "runtime_scan_cache", "file_entry": {"cover_path": str(first)}}})))
        setup.execute("insert into library.library_root_settings values (1,%s::jsonb)",
            (json.dumps({"main_library_roots": [{"path": str(root)}]}),))
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://explicit-fixture.invalid/owned",
              "_library_root_paths_snapshot": (root,), "IMAGE_EXTENSIONS": {".jpg", ".png"}}

    def adapter(label="ordered-save-main"):
        def open_database(url):
            assert url == config["ALBUM_HAVEN_APP_DATABASE_URL"]
            return connect(label, dictionaries=True)
        return PostgresScanCacheAdapter(dict(config), connect=open_database)

    def save(*, label="ordered-save-main", **overrides):
        return adapter(label).persist_ordered_cover_selection(**{
            "track_paths": {str(track)}, "album_root": root, "expected_album_id": 72,
            "expected_revision": 3, "mutation_id": "9a7263b5-d83b-4892-8684-9b475f7ded41",
            "references": [{"selection_id": "back"}, {"selection_id": "front"}], **overrides})

    def state():
        with connect() as observer:
            return {
                "albums": observer.execute("select id,cover_path,metadata from library.local_albums order by id").fetchall(),
                "files": observer.execute("select id,metadata from library.local_track_files order by id").fetchall(),
                "library": observer.execute("select metadata from library.libraries order by id").fetchall(),
            }
    try:
        yield SimpleNamespace(connect=connect, root=root, first=first, second=second,
            track=track, original=original, adapter=adapter, save=save, state=state)
    finally:
        with connect() as cleanup:
            cleanup.execute("truncate library.local_track_files, library.local_tracks, library.local_album_cover_candidate_snapshots, library.library_root_settings, library.local_albums, library.library_roots, library.libraries, app.bootstrap_owners")


def _wait_for_blocker(connect, label, blocker_pid):
    deadline = time.monotonic() + 5
    with connect() as observer:
        observer.autocommit = True
        while time.monotonic() < deadline:
            rows = observer.execute("""select a.pid from pg_stat_activity a
                join pg_locks l on l.pid=a.pid and not l.granted
                where a.application_name=%s and a.datname=current_database() and %s=any(pg_blocking_pids(a.pid))""",
                (label, blocker_pid)).fetchall()
            if rows:
                return rows[0][0]
            time.sleep(0.01)
    pytest.fail("Expected actual PostgreSQL lock wait was not observed")


@contextmanager
def _source_blocker(saved, path):
    with saved.connect("ordered-save-source-blocker") as blocker:
        key = next(key for key in cover_source_keys(path) if key.startswith("inode:"))
        blocker.execute("select pg_advisory_xact_lock(hashtextextended(%s,0))", ("album-haven:cover-source:" + key,))
        try:
            yield blocker
        finally:
            blocker.rollback()


def test_actual_save_commits_order_projection_receipt_and_idempotent_replay(saved_pg):
    s = saved_pg
    bytes_before = [p.read_bytes() for p in (s.first, s.second)]
    result = s.save()
    assert result["changed"] is True and result["selected_covers_revision"] == 4
    state = s.state()
    album = state["albums"][0]
    assert album[1] == str(s.second)
    assert [x["selection_id"] for x in album[2]["selected_covers"]] == ["back", "front"]
    assert album[2]["selected_covers_last_request"] == result["selected_covers_last_request"]
    assert album[2]["unrelated"] == {"keep": True}
    assert state["files"][0][1]["scan_cache"]["file_entry"]["cover_path"] == str(s.second)
    assert state["library"][0][0]["cover_mutation_revision"] == 1
    replay = s.save()
    assert replay["replayed"] is True and replay["changed"] is False
    assert s.state() == state
    assert [p.read_bytes() for p in (s.first, s.second)] == bytes_before


def test_actual_unchanged_save_records_receipt_without_provenance_or_projection(saved_pg):
    s = saved_pg
    before = s.state()
    result = s.save(references=[{"selection_id": "front"}, {"selection_id": "back"}])
    assert result["changed"] is False and result["selected_covers_revision"] == 3
    after = s.state()
    assert after["files"] == before["files"] and after["library"] == before["library"]
    metadata = after["albums"][0][2]
    assert "cover_selection_origin" not in metadata
    assert {k: v for k, v in metadata.items() if k != "selected_covers_last_request"} == s.original


def test_actual_stale_revision_and_reused_uuid_body_never_mutate(saved_pg):
    s = saved_pg
    s.save()
    before = s.state()
    for request in [
        {"expected_revision": 3, "mutation_id": str(uuid4())},
        {"references": [{"selection_id": "front"}]}]:
        with pytest.raises(OrderedCoverSelectionConflict):
            s.save(**request)
        assert s.state() == before


def test_actual_projection_failure_rolls_back_album_receipt_and_revision(saved_pg):
    import psycopg
    s = saved_pg
    before = s.state()
    with s.connect() as setup:
        setup.execute("""create function library.reject_fixture_projection() returns trigger language plpgsql as $$
            begin raise exception 'synthetic projection failure'; end $$;
            create trigger reject_fixture_projection before update on library.local_track_files
            for each row execute function library.reject_fixture_projection()""")
    try:
        with pytest.raises(psycopg.errors.RaiseException, match="synthetic projection failure"):
            s.save()
        assert s.state() == before
    finally:
        with s.connect() as cleanup:
            cleanup.execute("drop trigger reject_fixture_projection on library.local_track_files; drop function library.reject_fixture_projection()")


def test_actual_commit_guard_refusal_rolls_back_all_staged_writes(saved_pg):
    s = saved_pg
    before = s.state()
    def refuse(commit):
        raise PermissionError("synthetic authority revoked")
    with pytest.raises(PermissionError, match="authority revoked"):
        s.save(commit_guard=refuse)
    assert s.state() == before


def test_actual_competing_saves_wait_then_one_cas_winner(saved_pg):
    s = saved_pg
    reached_guard, release = threading.Event(), threading.Event()
    def guard(commit):
        reached_guard.set()
        assert release.wait(10), "test did not release staged transaction"
        return commit()
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(s.save, label="ordered-save-winner", commit_guard=guard)
        try:
            assert reached_guard.wait(5), "first writer did not reach staged transaction"
            with s.connect() as observer:
                pid = observer.execute("select pid from pg_stat_activity where application_name='ordered-save-winner' and datname=current_database()").fetchone()[0]
            second = pool.submit(s.save, label="ordered-save-loser", mutation_id=str(uuid4()))
            _wait_for_blocker(s.connect, "ordered-save-loser", pid)
        finally:
            release.set()
        assert first.result(timeout=8)["changed"] is True
        with pytest.raises(OrderedCoverSelectionConflict):
            second.result(timeout=8)
    state = s.state()
    assert state["albums"][0][2]["selected_covers_revision"] == 4
    assert state["library"][0][0]["cover_mutation_revision"] == 1


def test_actual_alias_rebound_during_source_lock_wait_fails_closed(saved_pg):
    s = saved_pg
    alias = s.root / "alias.jpg"
    alias.symlink_to(s.first)
    before = s.state()
    with ThreadPoolExecutor(max_workers=1) as pool:
        with _source_blocker(s, s.first) as blocker:
            future = pool.submit(s.save, label="ordered-save-alias", references=[{"kind": "local", "path": str(alias)}])
            _wait_for_blocker(s.connect, "ordered-save-alias", blocker.info.backend_pid)
            alias.unlink()
            alias.symlink_to(s.second)
        with pytest.raises(OrderedCoverSelectionConflict, match="source changed"):
            future.result(timeout=8)
    assert s.state() == before


def test_actual_physical_mutation_of_selected_hardlink_never_calls_media(saved_pg):
    s = saved_pg
    alias = s.root / "hardlink.jpg"
    alias.hardlink_to(s.second)
    before = s.state()
    called = []
    def media(scope):
        called.append(True)
        return CoverMutationEffect(value={})
    with pytest.raises(OrderedCoverSelectionConflict, match="selected by an album"):
        s.adapter().run_cover_mutation(track_paths={str(s.track)}, album_root=s.root,
            source_paths=[alias], affected_paths=[alias], mutate=media, allow_ordered_selection=True)
    assert called == [] and s.state() == before
    assert alias.read_bytes() == s.second.read_bytes()


def test_actual_native_uuid_candidate_and_retained_offline_replay(saved_pg):
    s = saved_pg
    generation = uuid4()
    with s.connect() as setup:
        setup.execute("insert into library.local_album_cover_candidate_snapshots values (72,%s,%s::jsonb)",
            (generation, json.dumps([{"id": "remote-A", "url": "https://synthetic.invalid/Front.jpg", "art_kind": "cover", "width": 20, "height": 20}])))
    references = [{"kind": "remote", "candidate_id": "remote-A", "candidate_generation": str(generation)}]
    result = s.save(references=references)
    assert result["selected_covers"][0]["candidate_generation"] == str(generation)
    assert s.state()["albums"][0][1] is None
    with s.connect() as setup:
        setup.execute("update library.local_album_cover_candidate_snapshots set search_generation=%s,candidates='[]'", (uuid4(),))
    before = s.state()
    replay = s.save(references=references)
    assert replay["replayed"] is True and s.state() == before
    retained = s.save(expected_revision=4, mutation_id=str(uuid4()), references=[{"selection_id": result["selected_covers"][0]["selection_id"]}])
    assert retained["changed"] is False


def test_actual_concrete_versions_do_not_share_saved_ids_or_revision(saved_pg):
    s = saved_pg
    other_track = s.root / "version-track.flac"
    other = {"selected_covers": [{"selection_id": "version-only", "kind": "local", "path": str(s.first)}],
             "selected_covers_revision": 9}
    with s.connect() as setup:
        setup.execute("insert into library.local_albums values (73,1,%s,%s::jsonb)", (str(s.first), json.dumps(other)))
        setup.execute("insert into library.local_tracks values (173,73,1)")
        setup.execute("insert into library.local_track_files(id,track_id,library_root_id,private_path,metadata) values (273,173,1,%s,%s::jsonb)",
            (str(other_track), json.dumps({"scan_cache": {"source": "runtime_scan_cache", "file_entry": {}}})))
    with pytest.raises(OrderedCoverSelectionConflict):
        s.save(references=[{"selection_id": "version-only"}])
    with pytest.raises(OrderedCoverSelectionConflict):
        s.save(track_paths={str(other_track)})
    s.save()
    assert s.state()["albums"][1] == (73, str(s.first), other)



def test_actual_album_no_key_update_allows_candidate_fk_publication(saved_pg):
    s = saved_pg
    reached, release = threading.Event(), threading.Event()
    def guard(commit):
        reached.set()
        assert release.wait(10), "candidate publication test did not release writer"
        return commit()
    with ThreadPoolExecutor(max_workers=1) as pool:
        writer = pool.submit(s.save, commit_guard=guard)
        try:
            assert reached.wait(5)
            # Actual FK KEY SHARE must coexist with Save's NO KEY UPDATE lock.
            with s.connect() as publisher:
                publisher.execute("set local lock_timeout='2000ms'")
                publisher.execute("insert into library.local_album_cover_candidate_snapshots values (72,%s,'[]')", (uuid4(),))
        finally:
            release.set()
        assert writer.result(timeout=8)["changed"] is True
    with s.connect() as observer:
        assert observer.execute("select count(*) from library.local_album_cover_candidate_snapshots where album_id=72").fetchone()[0] == 1


def test_actual_inventory_exclusive_barrier_blocks_save_until_release(saved_pg):
    from music_app.services.relation_projection_postgres import inventory_publication_advisory_lock_sql
    s = saved_pg
    with ThreadPoolExecutor(max_workers=1) as pool:
        with s.connect("ordered-save-inventory-blocker") as blocker:
            blocker.execute(inventory_publication_advisory_lock_sql())
            try:
                writer = pool.submit(s.save, label="ordered-save-inventory-waiter")
                _wait_for_blocker(s.connect, "ordered-save-inventory-waiter", blocker.info.backend_pid)
                assert s.state()["albums"][0][2] == s.original
            finally:
                blocker.rollback()
        assert writer.result(timeout=8)["changed"] is True



def _spawned_save_worker(target, root_text, track_text, label, mutation_id, result_queue):
    """Spawn entrypoint: constructs its own genuine driver and product adapter."""
    try:
        import psycopg
        from psycopg.rows import dict_row
        def connect(_url):
            return psycopg.connect(**target, passfile=os.devnull, connect_timeout=5,
                sslmode="disable", application_name=label, row_factory=dict_row,
                options="-c statement_timeout=15000 -c lock_timeout=10000")
        config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://explicit-fixture.invalid/owned",
                  "_library_root_paths_snapshot": (Path(root_text),), "IMAGE_EXTENSIONS": {".jpg"}}
        adapter = PostgresScanCacheAdapter(config, connect=connect)
        result = adapter.persist_ordered_cover_selection(track_paths={track_text},
            album_root=Path(root_text), expected_album_id=72, expected_revision=3,
            mutation_id=mutation_id,
            references=[{"selection_id": "back"}, {"selection_id": "front"}])
        result_queue.put(("ok", os.getpid(), result))
    except BaseException as exc:
        result_queue.put(("error", os.getpid(), type(exc).__name__, str(exc)))


def test_actual_spawned_process_waits_on_source_lock_then_commits(saved_pg):
    s = saved_pg
    context = multiprocessing.get_context("spawn")
    results = context.Queue()
    child = context.Process(target=_spawned_save_worker,
        args=(s.connect.isolated_target, str(s.root), str(s.track),
              "ordered-save-spawned", str(uuid4()), results))
    started = False
    try:
        with _source_blocker(s, s.second) as blocker:
            child.start()
            started = True
            _wait_for_blocker(s.connect, "ordered-save-spawned", blocker.info.backend_pid)
            assert child.is_alive() and child.pid != os.getpid()
            assert s.state()["albums"][0][2] == s.original
        child.join(timeout=8)
        assert not child.is_alive(), "spawned Save did not finish after advisory lock release"
        assert child.exitcode == 0
        result = results.get(timeout=2)
        assert result[0] == "ok", result
        assert result[1] == child.pid and result[1] != os.getpid()
        assert result[2]["changed"] is True and result[2]["selected_covers_revision"] == 4
        assert s.state()["albums"][0][1] == str(s.second)
        assert s.state()["library"][0][0]["cover_mutation_revision"] == 1
    finally:
        if started and child.is_alive():
            child.terminate()
            child.join(timeout=5)
            assert not child.is_alive(), "spawned worker cleanup failed"
        results.close()
        results.join_thread()



def test_actual_retained_missing_sources_reorder_and_replay_without_recreation(saved_pg):
    s = saved_pg
    s.first.unlink()
    s.second.unlink()
    result = s.save()
    assert result["changed"] is True
    assert [item["path"] for item in result["selected_covers"]] == [str(s.second), str(s.first)]
    committed = s.state()
    replay = s.save()
    assert replay["replayed"] is True and s.state() == committed
    assert not s.first.exists() and not s.second.exists()
    assert list(s.root.iterdir()) == [s.track]


def _legacy_primary_token(saved, *, cover_path, metadata):
    """Model a pre-feature row and derive the selector from actual persisted data."""
    from music_app.services.ordered_cover_selection import current_cover_token
    assert not {"selected_covers", "selected_covers_revision", "selected_covers_last_request"} & metadata.keys()
    with saved.connect() as setup:
        setup.execute("update library.local_albums set cover_path=%s, metadata=%s::jsonb where id=72",
                      (cover_path, json.dumps(metadata)))
    with saved.connect() as observer:
        album_id, library_id, persisted_path, persisted_metadata = observer.execute(
            "select id,library_id,cover_path,metadata from library.local_albums where id=72"
        ).fetchone()
    assert persisted_path == cover_path and persisted_metadata == metadata
    return current_cover_token(album_id=album_id, library_id=library_id,
                               cover_path=persisted_path, metadata=persisted_metadata)


def test_actual_retain_current_missing_legacy_local_then_add_secondary(saved_pg):
    s = saved_pg
    s.first.unlink()
    legacy = {"unrelated": {"keep": True}, "cover_selection_origin": "automatic",
              "cover_selection_provenance": "inherited", "cover_revision": "legacy-revision"}
    token = _legacy_primary_token(s, cover_path=str(s.first), metadata=legacy)
    before = s.state()
    assert before["albums"][0][2] == legacy  # Token reads cannot infer explicit selection.
    source_bytes = s.second.read_bytes()
    references = [{"retain_current": True, "expected_primary": token},
                  {"kind": "local", "path": str(s.second)}]
    result = s.save(expected_revision=0, references=references)
    assert result["changed"] is True and result["selected_covers_revision"] == 1
    assert [item["path"] for item in result["selected_covers"]] == [str(s.first), str(s.second)]
    ids = [item["selection_id"] for item in result["selected_covers"]]
    assert len(set(ids)) == 2 and all(ids)
    persisted = s.state()
    assert persisted["albums"][0][1] == str(s.first)
    assert persisted["albums"][0][2]["unrelated"] == legacy["unrelated"]
    assert persisted["albums"][0][2]["cover_selection_provenance"] == "explicit"
    assert persisted["files"][0][1]["scan_cache"]["file_entry"]["cover_path"] == str(s.first)
    assert persisted["library"][0][0]["cover_mutation_revision"] == 1
    replay = s.save(expected_revision=0, references=references)
    assert replay["replayed"] is True and replay["changed"] is False
    assert [item["selection_id"] for item in replay["selected_covers"]] == ids
    assert s.state() == persisted
    assert not s.first.exists() and s.second.read_bytes() == source_bytes
    assert set(s.root.iterdir()) == {s.second, s.track}


def test_actual_retain_current_legacy_remote_without_candidate_snapshot_or_fetch(saved_pg, monkeypatch):
    import http.client
    import urllib.request
    s = saved_pg
    fetch_attempts = []
    def forbid_fetch(*args, **kwargs):
        fetch_attempts.append(True)
        raise AssertionError("Reference-only retention must not fetch a provider or image")
    monkeypatch.setattr(urllib.request, "urlopen", forbid_fetch)
    monkeypatch.setattr(http.client.HTTPConnection, "connect", forbid_fetch)
    monkeypatch.setattr(http.client.HTTPSConnection, "connect", forbid_fetch)
    remote = {"url": "https://retained.invalid/Front.jpg?edition=A",
              "thumbnail_url": "https://retained.invalid/Small.jpg", "source": "spotify",
              "source_label": "Persisted provider", "album_url": "https://retained.invalid/release",
              "width": 600, "height": 700}
    legacy = {"unrelated": {"keep": True}, "cover_selection_origin": "automatic",
              "cover_selection_provenance": "inherited",
              **{"remote_cover_" + key: value for key, value in remote.items()}}
    token = _legacy_primary_token(s, cover_path=None, metadata=legacy)
    assert s.state()["albums"][0][2] == legacy
    with s.connect() as observer:
        assert observer.execute("select count(*) from library.local_album_cover_candidate_snapshots").fetchone()[0] == 0
    source_bytes = {path: path.read_bytes() for path in (s.first, s.second)}
    references = [{"retain_current": True, "expected_primary": token},
                  {"kind": "local", "path": str(s.second)}]
    result = s.save(expected_revision=0, references=references)
    assert result["changed"] is True and result["selected_covers_revision"] == 1
    primary = result["selected_covers"][0]
    assert {key: value for key, value in primary.items() if key != "selection_id"} == {"kind": "remote", **remote}
    assert result["selected_covers"][1]["path"] == str(s.second)
    persisted = s.state()
    assert persisted["albums"][0][1] is None
    assert persisted["albums"][0][2]["unrelated"] == legacy["unrelated"]
    assert persisted["library"][0][0]["cover_mutation_revision"] == 1
    replay = s.save(expected_revision=0, references=references)
    assert replay["replayed"] is True and replay["selected_covers"] == result["selected_covers"]
    assert s.state() == persisted
    with s.connect() as observer:
        assert observer.execute("select count(*) from library.local_album_cover_candidate_snapshots").fetchone()[0] == 0
    assert fetch_attempts == []
    assert {path: path.read_bytes() for path in source_bytes} == source_bytes
    assert set(s.root.iterdir()) == {s.first, s.second, s.track}
