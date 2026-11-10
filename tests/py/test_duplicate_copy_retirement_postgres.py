"""Opt-in real PostgreSQL qualification of internal confirmed-row retirement.

This deliberately does not execute a deletion API or the complete inventory
publisher. Only generated files and an empty explicitly owned loopback database
are used. The production Missing SQL and duplicate read owners are exercised.
"""
from dataclasses import replace
from datetime import datetime, timezone
from itertools import permutations
import json
import os
from pathlib import Path
import re
from types import SimpleNamespace

import pytest

from music_app.services import library_browse_postgres as browse
from music_app.services import duplicate_copy_retirement as retirement
from music_app.services.library_watch_health import LibraryRootUnhealthyError

TARGET_ENV = "ALBUM_HAVEN_DUPLICATE_RETIREMENT_TEST_DATABASE"
CATEGORIES = ("main_library", "hoard", "new_arrivals")
SCHEMA = """
create schema app;
create schema library;
create table app.bootstrap_owners(owner_key text primary key, account_id bigint);
create table library.libraries(id bigint primary key, owner_account_id bigint, name text, library_kind text, metadata jsonb not null default '{}', updated_at timestamptz);
create table library.library_roots(id bigint primary key, library_id bigint references library.libraries, root_kind text, root_path text, is_active boolean, metadata jsonb not null default '{}');
create table library.local_artists(id bigint primary key, library_id bigint, artist_key text, name text, sort_name text);
create table library.local_albums(id bigint primary key, library_id bigint references library.libraries, artist_id bigint references library.local_artists, album_key text, title text, release_year integer, cover_path text, metadata jsonb not null default '{}');
create table library.local_tracks(id bigint primary key, library_id bigint references library.libraries, album_id bigint references library.local_albums, track_key text, title text, duration_seconds numeric, track_number integer, disc_number integer, metadata jsonb not null default '{}');
create table library.local_track_files(id bigint primary key, track_id bigint references library.local_tracks, library_root_id bigint references library.library_roots, private_path text unique, modified_at timestamptz, file_size_bytes bigint, last_seen_at timestamptz, metadata jsonb not null default '{}',
 scan_cache_stale boolean generated always as (lower(btrim(coalesce(metadata #>> '{scan_cache,stale}', ''))) in ('true','t','yes','y','on','1')) stored,
 scan_file_entry_is_object boolean generated always as (jsonb_typeof(metadata #> '{scan_cache,file_entry}') = 'object') stored);
create table library.local_album_featured_artists(album_id bigint references library.local_albums, library_id bigint, artist_id bigint references library.local_artists);
create table library.exception_overrides(id bigint primary key, library_id bigint, track_key text, track_id bigint, override_payload jsonb);
create table library.fixture_user_album_relations(album_id bigint references library.local_albums, user_id bigint, rating integer, favorite boolean);

"""


def _explicit_target(raw):
    try:
        target = json.loads(raw)
    except (TypeError, ValueError):
        raise pytest.UsageError("Retirement PostgreSQL target must be explicit JSON") from None
    if not isinstance(target, dict) or set(target) != {"host", "port", "dbname", "user", "password"}:
        raise pytest.UsageError("Retirement target requires exactly host, port, dbname, user, password")
    if (target["host"] not in ("127.0.0.1", "::1")
            or type(target["port"]) is not int or not 1 <= target["port"] <= 65535
            or not isinstance(target["dbname"], str)
            or not re.fullmatch(r"pytest_duplicate_retirement_[a-f0-9]{16,32}", target["dbname"])
            or not isinstance(target["user"], str) or not target["user"]
            or not isinstance(target["password"], str)):
        raise pytest.UsageError("Retirement tests require a unique owned isolated loopback database")
    return target


@pytest.fixture(autouse=True)
def no_external_transports(monkeypatch):
    """Only the fixture's explicit libpq loopback connection is authorized."""
    import http.client
    import socket
    import subprocess
    import urllib.request
    attempts = []
    def forbidden(*args, **kwargs):
        attempts.append(True)
        pytest.fail("Retirement tests must not contact external services or launch media tools")
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setattr(urllib.request, "urlopen", forbidden)
    monkeypatch.setattr(http.client.HTTPConnection, "connect", forbidden)
    monkeypatch.setattr(http.client.HTTPSConnection, "connect", forbidden)
    monkeypatch.setattr(subprocess, "Popen", forbidden)
    yield
    assert not attempts, "An external transport was attempted even if the caller caught its failure"


@pytest.fixture(scope="module")
def retirement_database():
    raw = os.environ.get(TARGET_ENV)
    if raw is None:
        pytest.skip(f"actual PostgreSQL unqualified: configure empty dedicated {TARGET_ENV}")
    target = _explicit_target(raw)
    import psycopg
    from psycopg.rows import dict_row
    with pytest.MonkeyPatch.context() as patch:
        for name in list(os.environ):
            if name.startswith("PG"):
                patch.delenv(name)
        def connect():
            return psycopg.connect(**target, passfile=os.devnull, connect_timeout=5,
                sslmode="disable", application_name="duplicate-retirement-fixture",
                options="-c statement_timeout=15000 -c lock_timeout=3000", row_factory=dict_row)
        with connect() as admin:
            assert admin.execute("select current_database() as name").fetchone()["name"] == target["dbname"]
            occupied = admin.execute("""select exists(select 1 from pg_namespace where nspname in ('app','library'))
                or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%%'
                and c.relkind in ('r','p','v','m','f','S')) as occupied""").fetchone()["occupied"]
            assert not occupied, "Refusing a nonempty retirement test database"
            assert not admin.execute("select 1 from pg_roles where rolname in ('album_haven_app','pytest_duplicate_retirement_denied')").fetchall(), "Refusing existing fixture roles"
            admin.execute("create role album_haven_app nologin; create role pytest_duplicate_retirement_denied nologin")
            admin.execute(SCHEMA)
            admin.execute((Path(__file__).resolve().parents[2] / "migrations/postgres/0043_create_local_track_waveform_peaks.sql").read_text())
            admin.execute((Path(__file__).resolve().parents[2] / "migrations/postgres/0105_add_confirmed_copy_retirement.sql").read_text())
            admin.execute("grant usage on schema app,library to album_haven_app,pytest_duplicate_retirement_denied")
            admin.execute("grant select on all tables in schema app to album_haven_app")
            admin.execute("grant select,insert,update on all tables in schema library to album_haven_app")
        try:
            yield connect
        finally:
            with connect() as admin:
                admin.execute("drop schema library cascade; drop schema app cascade; drop role album_haven_app; drop role pytest_duplicate_retirement_denied")


@pytest.fixture
def inventory(retirement_database, tmp_path):
    connect = retirement_database
    def seed(*, distinct=True):
        roots, paths = {}, {}
        with connect() as db:
            db.execute("insert into app.bootstrap_owners values ('local-bootstrap-owner',1)")
            db.execute("insert into library.libraries values (1,1,'Local Library','local','{}',now())")
            db.execute("insert into library.local_artists(id,library_id,artist_key,name,sort_name) values (1,1,'artist','Artist','Artist')")
            for i, category in enumerate(CATEGORIES, 1):
                root = tmp_path / category
                root.mkdir(exist_ok=True)
                path = root / 'Release' / '01.flac'
                path.parent.mkdir(exist_ok=True)
                path.write_bytes(b"generated synthetic audio identity")
                roots[i], paths[i] = root, path
                db.execute("insert into library.library_roots values (%s,1,%s,%s,true,%s::jsonb)",
                    (i, category, str(root), json.dumps({"root_id": f"root-{i}"})))
                album_id = i if distinct else 1
                track_id = 10 + i if distinct else 11
                if distinct or i == 1:
                    db.execute("insert into library.local_albums(id,library_id,artist_id,album_key,title,release_year,cover_path,metadata) values (%s,1,1,%s,'Release',2024,null,%s::jsonb)",
                        (album_id, f"artist::release::{album_id}", json.dumps({"album_artist": "Artist"})))
                    db.execute("insert into library.local_tracks(id,library_id,album_id,track_key,title,duration_seconds,track_number,disc_number,metadata) values (%s,1,%s,%s,'Song',120,1,1,'{}')", (track_id, album_id, f"track-{track_id}"))
                    db.execute("insert into library.fixture_user_album_relations values (%s,7,5,true)", (album_id,))
                modified = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
                entry = {"path": str(path), "album": "Release", "album_artist": "Artist", "artist": "Artist",
                         "title": "Song", "year": 2024, "track_number": 1, "disc_number": 1,
                         "duration_seconds": 120, "library_root_id": f"root-{i}", "library_root_category": category}
                db.execute("insert into library.local_track_files(id,track_id,library_root_id,private_path,modified_at,file_size_bytes,last_seen_at,metadata) values (%s,%s,%s,%s,%s,%s,now(),%s::jsonb)",
                    (100 + i, track_id, i, str(path), modified, path.stat().st_size,
                     json.dumps({"scan_cache": {"source": "runtime_scan_cache", "file_entry": entry}})))
                db.execute("insert into library.local_track_waveform_peaks(track_file_id,sample_count,analyzer_version,file_size_bytes,modified_at_ns,left_peaks,right_peaks) values (%s,1,'fixture',1,1,ARRAY[0.0],ARRAY[0.0])", (100 + i,))
        def state():
            with connect() as db:
                return {table: db.execute(f"select * from library.{table} order by 1").fetchall()
                        for table in ("local_albums", "local_tracks", "local_track_files", "fixture_user_album_relations", "local_track_waveform_peaks")}
        def confirmation(selected=1, survivor=3):
            with connect() as db:
                def generation(i):
                    row = db.execute("select id as file_id,track_id,library_root_id as root_id,modified_at,file_size_bytes,last_seen_at from library.local_track_files where id=%s", (100+i,)).fetchone()
                    return retirement.PhysicalFileGeneration(**row)
                return retirement.ConfirmedDuplicateCopyRemoval(library_id=1, selected_files=(generation(selected),), survivor_files=(generation(survivor),), physical_deletion_confirmed=True)
        def apply(confirmation, selected=1, fail=False):
            with connect() as db:
                db.execute("set local role album_haven_app")
                prepared = retirement.prepare_confirmed_duplicate_retirement(db, confirmation, f"root-{selected}")
                result = retirement.retire_confirmed_duplicate_rows(db, prepared)
                if fail:
                    raise RuntimeError("synthetic later publication failure")
                return result
        return SimpleNamespace(connect=connect, roots=roots, paths=paths, state=state, confirmation=confirmation, apply=apply)
    try:
        yield seed
    finally:
        with connect() as db:
            db.execute("truncate library.local_track_waveform_peaks,library.fixture_user_album_relations,library.exception_overrides,library.local_album_featured_artists,library.local_track_files,library.local_tracks,library.local_albums,library.local_artists,library.library_roots,library.libraries,app.bootstrap_owners cascade")


def _missing(connect):
    with connect() as db:
        rows = db.execute(browse._missing_albums_sql(), {"album_key": None}).fetchall()
    return browse._missing_album_projection_payloads(rows)


def _active_projection(connect):
    with connect() as db:
        rows = db.execute("""select a.id as album_id,a.album_key,a.title as album_title,a.release_year as album_release_year,
            a.metadata as album_metadata,ar.name as artist_name,t.track_key,t.title as track_title,t.track_number,t.disc_number,t.duration_seconds,
            f.private_path as file_private_path,f.metadata #> '{scan_cache,file_entry}' as file_entry,
            f.library_root_id as file_library_root_id,r.root_kind as file_library_root_category,f.scan_cache_stale as file_scan_cache_stale
            from library.local_track_files f join library.local_tracks t on t.id=f.track_id
            join library.local_albums a on a.id=t.album_id join library.local_artists ar on ar.id=a.artist_id
            join library.library_roots r on r.id=f.library_root_id where not f.scan_cache_stale order by f.id""").fetchall()
    return browse._problematic_album_projection_payloads(rows)


@pytest.mark.parametrize("distinct", [False, True], ids=["shared-album", "distinct-albums"])
@pytest.mark.parametrize("order", list(permutations((1,2,3))))
def test_actual_retirement_each_category_three_two_one_no_missing(inventory, distinct, order):
    s = inventory(distinct=distinct)
    original = s.state()
    survivor_bytes = s.paths[order[-1]].read_bytes()
    assert all(a["has_duplicate_files"] for a in _active_projection(s.connect))
    for remaining, selected in zip((2,1), order[:2]):
        confirmation = s.confirmation(selected, order[-1])
        s.paths[selected].unlink()  # Explicit synthetic external deletion, never product file I/O.
        s.apply(confirmation, selected)
        after = s.state()
        assert len(after["local_track_files"]) == remaining
        assert len(after["local_track_waveform_peaks"]) == remaining
        for table in ("local_albums", "local_tracks", "fixture_user_album_relations"):
            assert after[table] == original[table]
        assert _missing(s.connect) == []
        projected = _active_projection(s.connect)
        assert projected
        for album in projected:
            assert album["has_duplicate_files"] is (remaining > 1)
            assert ("Duplicate files" in browse._problematic_album_summary_payload(album)["problem_reasons"]) is (remaining > 1)
        assert s.paths[order[-1]].read_bytes() == survivor_bytes
    assert s.state()["local_track_files"] == [row for row in original["local_track_files"] if row["id"] == 100+order[-1]]


@pytest.mark.parametrize("failure", ["unconfirmed", "cross-library", "target-generation", "survivor-generation", "target-present", "survivor-absent", "survivor-stale", "root-inactive", "root-unhealthy", "root-escape", "wrong-release"])
def test_actual_unsafe_confirmation_fails_without_inventory_change(inventory, failure):
    s = inventory()
    confirmation = s.confirmation()
    s.paths[1].unlink()
    if failure == "unconfirmed":
        confirmation = replace(confirmation, physical_deletion_confirmed=False)
    elif failure == "cross-library":
        confirmation = replace(confirmation, library_id=2)
    elif failure in ("target-generation", "survivor-generation"):
        field = "selected_files" if failure == "target-generation" else "survivor_files"
        confirmation = replace(confirmation, **{field: (replace(getattr(confirmation, field)[0], file_size_bytes=999),)})
    elif failure == "target-present":
        s.paths[1].write_bytes(b"replacement")
    elif failure == "survivor-absent":
        s.paths[3].unlink()
    else:
        with s.connect() as db:
            if failure == "survivor-stale":
                db.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true') where id=103")
            elif failure == "root-inactive":
                db.execute("update library.library_roots set is_active=false where id=1")
            elif failure == "root-unhealthy":
                db.execute("update library.libraries set metadata='{\"library_watch_health\":{\"root-1\":{\"state\":\"root_unavailable\"}}}'")
            elif failure == "root-escape":
                db.execute("update library.local_track_files set private_path=%s where id=101", (str(s.roots[2] / 'absent.flac'),))
            elif failure == "wrong-release":
                db.execute("update library.local_albums set title='Other release' where id=3")
    before = s.state()
    with pytest.raises(LibraryRootUnhealthyError if failure == "root-unhealthy" else retirement.DuplicateCopyRetirementConflict):
        s.apply(confirmation)
    assert s.state() == before


def test_actual_later_failure_rolls_back_retirement_and_waveform(inventory):
    s = inventory()
    confirmation = s.confirmation()
    s.paths[1].unlink()
    before = s.state()
    with pytest.raises(RuntimeError, match="later publication failure"):
        s.apply(confirmation, fail=True)
    assert s.state() == before


def test_actual_replay_cannot_retire_new_row_at_same_path(inventory):
    s = inventory()
    confirmation = s.confirmation()
    s.paths[1].unlink()
    s.apply(confirmation)
    before = s.state()
    assert s.apply(confirmation) == 0
    assert s.state() == before
    with s.connect() as db:
        db.execute("""insert into library.local_track_files(id,track_id,library_root_id,private_path,modified_at,file_size_bytes,last_seen_at,metadata)
            select 999,11,1,%s,modified_at,file_size_bytes,last_seen_at,metadata from library.local_track_files where id=103""", (str(s.paths[1]),))
    recreated = s.state()
    assert s.apply(confirmation) == 0
    assert s.state() == recreated


def test_unrelated_stale_album_remains_missing(inventory):
    s = inventory()
    confirmation = s.confirmation()
    s.paths[1].unlink()
    with s.connect() as db:
        db.execute("update library.local_albums set title='Unrelated disappearance' where id=2")
        db.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true') where id=102")
    before = _missing(s.connect)
    assert [a["key"] for a in before] == ["artist::release::2"]
    s.apply(confirmation)
    assert _missing(s.connect) == before


@pytest.mark.parametrize("side", ["selected_files", "survivor_files"])
@pytest.mark.parametrize("field", ["track_id", "root_id", "modified_at", "last_seen_at"])
def test_actual_each_persisted_generation_field_is_required(inventory, side, field):
    from datetime import timedelta
    s = inventory()
    confirmation = s.confirmation()
    s.paths[1].unlink()
    original = getattr(confirmation, side)[0]
    value = getattr(original, field)
    changed = value + (timedelta(seconds=1) if isinstance(value, datetime) else 100)
    confirmation = replace(confirmation, **{side: (replace(original, **{field: changed}),)})
    before = s.state()
    with pytest.raises(retirement.DuplicateCopyRetirementConflict):
        s.apply(confirmation)
    assert s.state() == before


@pytest.mark.parametrize("race", ["selected-reappears", "survivor-disappears", "survivor-bytes-change", "generation-changes"])
def test_actual_revalidation_before_retirement_rolls_back_on_change(inventory, race):
    s = inventory()
    confirmation = s.confirmation()
    s.paths[1].unlink()
    before = s.state()
    with pytest.raises(retirement.DuplicateCopyRetirementConflict):
        with s.connect() as db:
            prepared = retirement.prepare_confirmed_duplicate_retirement(db, confirmation, "root-1")
            if race == "selected-reappears":
                s.paths[1].write_bytes(b"reappeared")
            elif race == "survivor-disappears":
                s.paths[3].unlink()
            elif race == "survivor-bytes-change":
                s.paths[3].write_bytes(b"changed survivor")
            else:
                db.execute("update library.local_track_files set last_seen_at=last_seen_at+interval '1 second' where id=101")
            retirement.retire_confirmed_duplicate_rows(db, prepared)
    assert s.state() == before


def test_actual_unselected_alternate_encode_is_unchanged(inventory):
    s = inventory()
    confirmation = s.confirmation()
    s.paths[1].unlink()
    alternate = s.paths[2].with_suffix('.mp3')
    s.paths[2].rename(alternate)
    with s.connect() as db:
        db.execute("update library.local_track_files set private_path=%s, metadata=jsonb_set(metadata,'{scan_cache,file_entry,path}',to_jsonb(%s::text)) where id=102", (str(alternate), str(alternate)))
    before = s.state()
    data = alternate.read_bytes()
    s.apply(confirmation)
    assert alternate.read_bytes() == data
    assert next(row for row in s.state()["local_track_files"] if row["id"] == 102) == next(row for row in before["local_track_files"] if row["id"] == 102)
    assert all(album["has_duplicate_files"] for album in _active_projection(s.connect))


@pytest.mark.parametrize("extra", [
    {"active_file_entries": {"/synthetic/track.flac": {}}},
    {"deleted_paths": ("/synthetic/track.flac",)},
    {"deleted_subtrees": ("/synthetic",)},
    {"moves": ({"source_path": "/synthetic/track.flac"},)},
])
def test_adapter_refuses_mixed_confirmation_before_database_connection(extra):
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
    def forbidden(_url):
        pytest.fail("Mixed confirmation must fail before opening database")
    adapter = PostgresScanCacheAdapter({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/fixture"}, connect=forbidden)
    with pytest.raises(ValueError):
        adapter.persist_targeted_inventory_mutation(**{
            "root_id": "root-1", "active_file_entries": {}, "confirmed_duplicate_removal": object(), **extra})


@pytest.mark.parametrize("fail", [False, True, "health"])
def test_recording_adapter_uses_same_transaction_retirement_before_publication(monkeypatch, fail):
    """Wiring only. SQL execution correctness belongs to actual PG tests above."""
    from contextlib import nullcontext
    from music_app.services import scan_cache_persistence as persistence
    from test_ordered_cover_scan_preservation import ScanConnection, adapter
    connection = ScanConnection()
    events = []
    confirmation = object()
    prepared = retirement.PreparedDuplicateCopyRetirement(
        ({"id": 101, "private_path": "/synthetic/removed.flac", "album_key": "selected-album"},), ({"configured_root_id": "root-3", "album_key": "survivor-album"},))
    monkeypatch.setattr(retirement.PreparedDuplicateCopyRetirement, "revalidate_files", lambda self: events.append("revalidate"))
    def prepare(actual, request, root):
        assert actual is connection and request is confirmation and root == "root-1"
        events.append("prepare")
        return prepared
    def retire(actual, value):
        assert actual is connection and value is prepared
        events.append("retire")
        return 1
    def publish(actual, config, **kwargs):
        assert actual is connection
        events.append("publish")
        if fail:
            raise RuntimeError("synthetic publication failure")
    monkeypatch.setattr(persistence, "prepare_confirmed_duplicate_retirement", prepare)
    monkeypatch.setattr(persistence, "retire_confirmed_duplicate_rows", retire)
    monkeypatch.setattr(persistence, "_commit_structural_relation_projection", publish)
    monkeypatch.setattr(persistence, "_inventory_rows_from_albums", lambda *args, **kwargs: ([], [], [], [], []))
    subject = adapter(connection, build_albums=lambda *args: [])
    def guard(actual, roots):
        assert actual is connection and roots == ["root-1", "root-3"]
        if fail == "health":
            raise LibraryRootUnhealthyError("synthetic pending survivor health")
        return nullcontext()
    def run():
        return subject.persist_targeted_inventory_mutation(root_id="root-1", active_file_entries={},
            confirmed_duplicate_removal=confirmation, publication_guard=guard)
    if fail == "health":
        with pytest.raises(LibraryRootUnhealthyError):
            run()
    elif fail:
        with pytest.raises(RuntimeError, match="publication failure"):
            run()
    else:
        assert run()["retired_file_count"] == 1
    assert events == (["prepare"] if fail == "health" else ["prepare", "retire", "publish"] + ([] if fail else ["revalidate"]))
    assert connection.commits == (0 if fail else 1)
    assert connection.exited
    assert not any(sql == persistence._mark_targeted_track_files_stale_sql() for sql, _ in connection.operations)


@pytest.mark.parametrize("kind", ["missing", "no-survivor", "overlap", "duplicate-selected", "naive-timestamp"])
def test_confirmation_requires_complete_disjoint_typed_manifest(inventory, kind):
    s = inventory()
    c = s.confirmation()
    s.paths[1].unlink()
    if kind == "missing":
        c = None
    elif kind == "no-survivor":
        c = replace(c, survivor_files=())
    elif kind == "overlap":
        c = replace(c, survivor_files=c.selected_files)
    elif kind == "duplicate-selected":
        c = replace(c, selected_files=c.selected_files * 2)
    else:
        c = replace(c, selected_files=(replace(c.selected_files[0], modified_at=datetime(2026,1,1)),))
    before = s.state()
    with pytest.raises(retirement.DuplicateCopyRetirementConflict):
        s.apply(c)
    assert s.state() == before


def test_actual_symlinked_selected_parent_cannot_prove_absence(inventory):
    s = inventory()
    c = s.confirmation()
    s.paths[1].unlink()
    s.paths[1].parent.rmdir()
    s.paths[1].parent.symlink_to(s.paths[2].parent, target_is_directory=True)
    before = s.state()
    with pytest.raises(retirement.DuplicateCopyRetirementConflict):
        s.apply(c)
    assert s.state() == before


def test_actual_partly_absent_selected_ids_fail_closed(inventory):
    s = inventory()
    c = s.confirmation()
    c = replace(c, selected_files=(*c.selected_files, replace(c.selected_files[0], file_id=999)))
    s.paths[1].unlink()
    before = s.state()
    with pytest.raises(retirement.DuplicateCopyRetirementConflict):
        s.apply(c)
    assert s.state() == before


@pytest.mark.parametrize("root", [1, 3], ids=["selected-root", "survivor-root"])
def test_actual_disappeared_root_is_not_confirmed_file_absence(inventory, root):
    s = inventory()
    c = s.confirmation()
    s.paths[1].unlink()
    s.roots[root].rename(s.roots[root].with_name(s.roots[root].name + '-detached'))
    before = s.state()
    with pytest.raises(retirement.DuplicateCopyRetirementConflict):
        s.apply(c)
    assert s.state() == before


def _function_arguments(confirmation):
    def records(files):
        return [{"id": f.file_id, "track_id": f.track_id, "library_root_id": f.root_id,
                 "file_size_bytes": f.file_size_bytes, "modified_at": f.modified_at.isoformat(),
                 "last_seen_at": f.last_seen_at.isoformat()} for f in files]
    return {"library_id": confirmation.library_id, "selected": records(confirmation.selected_files),
            "survivors": records(confirmation.survivor_files)}


def _call_retirement_function(db, arguments):
    return db.execute("select library.retire_confirmed_duplicate_copy_files(%s,%s::jsonb,%s::jsonb) as id",
        (arguments["library_id"], json.dumps(arguments["selected"]), json.dumps(arguments["survivors"]))).fetchall()


def test_actual_runtime_role_has_function_but_no_direct_delete(inventory):
    import psycopg
    s = inventory()
    confirmation = s.confirmation()
    s.paths[1].unlink()
    before = s.state()
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with s.connect() as db:
            db.execute("set local role album_haven_app")
            db.execute("delete from library.local_track_files where id=101")
    assert s.state() == before
    assert s.apply(confirmation) == 1
    with s.connect() as db:
        properties = db.execute("""select p.prosecdef, p.proconfig,
            has_function_privilege('album_haven_app',p.oid,'EXECUTE') as app_allowed,
            has_function_privilege('pytest_duplicate_retirement_denied',p.oid,'EXECUTE') as other_allowed
            from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='library' and p.proname='retire_confirmed_duplicate_copy_files'""").fetchone()
    assert properties["prosecdef"] is True
    assert properties["proconfig"] == ["search_path=pg_catalog, library"]
    assert properties["app_allowed"] is True and properties["other_allowed"] is False


def test_actual_unapproved_role_cannot_execute_retirement(inventory):
    import psycopg
    s = inventory()
    arguments = _function_arguments(s.confirmation())
    s.paths[1].unlink()
    before = s.state()
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with s.connect() as db:
            db.execute("set local role pytest_duplicate_retirement_denied")
            _call_retirement_function(db, arguments)
    assert s.state() == before


@pytest.mark.parametrize("invalid", ["wrong-library", "changed-selected", "changed-survivor",
    "no-survivor", "overlap", "duplicate", "partial", "stale", "inactive", "wrong-source", "wrong-release", "object"])
def test_actual_security_definer_function_rejects_invalid_generations(inventory, invalid):
    s = inventory()
    arguments = _function_arguments(s.confirmation())
    s.paths[1].unlink()
    if invalid == "wrong-library":
        arguments["library_id"] = 99
    elif invalid == "changed-selected":
        arguments["selected"][0]["file_size_bytes"] += 1
    elif invalid == "changed-survivor":
        arguments["survivors"][0]["file_size_bytes"] += 1
    elif invalid == "no-survivor":
        arguments["survivors"] = []
    elif invalid == "overlap":
        arguments["survivors"] = arguments["selected"]
    elif invalid == "duplicate":
        arguments["selected"] *= 2
    elif invalid == "partial":
        arguments["selected"].append({**arguments["selected"][0], "id": 999})
    elif invalid == "object":
        arguments["selected"] = {}
    else:
        with s.connect() as db:
            if invalid == "stale":
                db.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true') where id=103")
            elif invalid == "inactive":
                db.execute("update library.library_roots set is_active=false where id=3")
            elif invalid == "wrong-source":
                db.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,source}','\"other\"') where id=103")
            else:
                db.execute("update library.local_albums set title='Other release' where id=3")
    before = s.state()
    with s.connect() as db:
        db.execute("set local role album_haven_app")
        assert _call_retirement_function(db, arguments) == []
    assert s.state() == before


def test_actual_non_symlink_redirected_ancestor_fails_closed(inventory, monkeypatch):
    """Portable junction contract: preserve real paths/stat, alter only resolution."""
    s = inventory()
    c = s.confirmation()
    s.paths[1].unlink()
    ancestor = s.paths[1].parent
    assert ancestor.is_symlink() is False
    original_resolve = Path.resolve
    def resolve(path, *args, **kwargs):
        if path == ancestor:
            return s.paths[2].parent
        return original_resolve(path, *args, **kwargs)
    before = s.state()
    monkeypatch.setattr(Path, "resolve", resolve)
    with pytest.raises(retirement.DuplicateCopyRetirementConflict):
        s.apply(c)
    assert s.state() == before


@pytest.mark.parametrize("component", ["root", "ancestor", "selected-file", "survivor-file"])
def test_actual_dangling_reparse_component_is_not_absence(inventory, monkeypatch, component):
    """Portable Windows reparse contract using only the platform stat seam."""
    import stat
    s = inventory()
    c = s.confirmation()
    s.paths[1].unlink()
    target = {"root": s.roots[1], "ancestor": s.paths[1].parent,
              "selected-file": s.paths[1], "survivor-file": s.paths[3]}[component]
    real_lstat, real_exists, real_is_symlink = Path.lstat, Path.exists, Path.is_symlink
    calls = []
    def lstat(path, *args, **kwargs):
        if path == target:
            calls.append(path)
            return SimpleNamespace(st_mode=stat.S_IFDIR if component in ("root", "ancestor") else stat.S_IFREG,
                st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT, st_size=0, st_mtime=0)
        return real_lstat(path, *args, **kwargs)
    monkeypatch.setattr(Path, "lstat", lstat)
    monkeypatch.setattr(Path, "exists", lambda path: False if path == target else real_exists(path))
    monkeypatch.setattr(Path, "is_symlink", lambda path: False if path == target else real_is_symlink(path))
    before = s.state()
    with pytest.raises(retirement.DuplicateCopyRetirementConflict):
        s.apply(c)
    assert calls, "The filesystem boundary must inspect reparse attributes even when exists() is false"
    assert s.state() == before
