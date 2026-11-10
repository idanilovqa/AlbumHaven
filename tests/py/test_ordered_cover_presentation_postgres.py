"""Opt-in real PostgreSQL reads for saved cover presentation.

ALBUM_HAVEN_SELECTED_COVER_TEST_DATABASE is an explicit JSON target containing
host, port, dbname, user and password. It must identify an EMPTY, dedicated
loopback database. The test owns only its synthetic ``library`` schema, seeds
once before reads, and drops only that schema after the module. No user data,
provider calls, migrations, image bytes or persistence SQL are substituted.
The fixture intentionally permits mismatched foreign-library associations to
exercise fail-closed joins. This is not full-schema, deployment-role or UI QA.
"""
from copy import deepcopy
import json
import os
import re
from types import SimpleNamespace
from urllib.parse import quote

import pytest

from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository


TARGET_ENV = "ALBUM_HAVEN_SELECTED_COVER_TEST_DATABASE"
pytestmark = pytest.mark.isolated_app_database(database_fixture="selected_cover_pg_attestation")
SCHEMA = """
create schema library;
create table library.libraries (id bigint primary key);
create table library.library_roots (id bigint primary key,
 library_id bigint not null references library.libraries, is_active boolean not null);
create table library.local_albums (id bigint primary key,
 library_id bigint not null references library.libraries, metadata jsonb not null);
create table library.local_tracks (id bigint primary key,
 album_id bigint not null references library.local_albums,
 library_id bigint not null references library.libraries);
create table library.local_track_files (id bigint primary key,
 track_id bigint not null references library.local_tracks,
 library_root_id bigint not null references library.library_roots,
 private_path text not null unique, metadata jsonb not null,
 scan_cache_stale boolean generated always as (
   lower(btrim(coalesce(metadata #>> '{scan_cache,stale}', '')))
   in ('true','t','yes','y','on','1')) stored);
"""


def _explicit_target(raw):
    try:
        target = json.loads(raw)
    except (TypeError, ValueError):
        raise pytest.UsageError("Selected-cover PostgreSQL target must be an explicit JSON object") from None
    if not isinstance(target, dict) or set(target) != {"host", "port", "dbname", "user", "password"}:
        raise pytest.UsageError("Selected-cover target requires exactly host, port, dbname, user, password")
    if (target["host"] not in ("127.0.0.1", "::1")
            or type(target["port"]) is not int or not 1 <= target["port"] <= 65535
            or not isinstance(target["dbname"], str)
            or not re.fullmatch(r"pytest_ordered_cover_[a-f0-9]{16,32}", target["dbname"])
            or not isinstance(target["user"], str) or not target["user"]
            or not isinstance(target["password"], str)):
        raise pytest.UsageError("Selected-cover tests require an explicitly owned isolated loopback database")
    return target


def _metadata(album_id):
    return {"selected_covers": [
        {"selection_id": "remote-back", "kind": "remote", "url": "https://covers.example.test/back.png"},
        {"selection_id": "local-front", "kind": "local", "path": "/synthetic/album/front.jpg"},
        {"selection_id": "remote-front", "kind": "remote", "url": "https://covers.example.test/front.png"}],
        "selected_covers_revision": 17,
        "selected_covers_last_request": {"mutation_id": "93c9e45b-022e-4336-8e11-32f155591b74", "request_hash": "a" * 64},
        "unrelated": {"album": album_id, "keep": [1, 2, 3]}}


@pytest.fixture(scope="module")
def selected_cover_pg_database():
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

        def connect(*, readonly=False):
            return psycopg.connect(**target, passfile=os.devnull, connect_timeout=5,
                sslmode="disable", application_name="selected-cover-synthetic-read",
                options="-c statement_timeout=10000 -c lock_timeout=5000" + (
                    " -c default_transaction_read_only=on" if readonly else ""),
                **({"row_factory": dict_row} if readonly else {}))

        original = {album: _metadata(album) for album in range(72, 81)}
        with connect() as setup:
            assert setup.execute("select current_database(), current_user").fetchone() == (target["dbname"], target["user"])
            assert setup.execute("""select count(*) from pg_namespace
                where nspname not in ('pg_catalog','pg_toast','information_schema','public')""").fetchone()[0] == 0
            assert setup.execute("""select count(*) from pg_class c join pg_namespace n
                on n.oid=c.relnamespace where n.nspname='public'""").fetchone()[0] == 0
            setup.execute(SCHEMA)
            setup.execute("insert into library.libraries values (23), (24)")
            setup.execute("insert into library.library_roots values (1,23,true), (2,23,false), (3,24,true), (4,23,true)")
            for album, metadata in original.items():
                setup.execute("insert into library.local_albums values (%s,%s,%s::jsonb)",
                    (album, 24 if album == 73 else 23, json.dumps(metadata)))
            # One complete immutable dataset, including intentionally corrupt scope links.
            tracks = [(172,72,23), (173,73,24), (175,75,23), (176,76,23),
                      (177,77,23), (178,78,24), (179,79,23), (180,80,23), (272,72,24)]
            for values in tracks:
                setup.execute("insert into library.local_tracks values (%s,%s,%s)", values)
            files = [(1,172,1,"valid-a",False), (2,172,4,"valid-b",False),
                (3,172,1,"stale",True), (4,172,2,"inactive",False),
                (5,172,3,"foreign-root",False), (6,272,1,"foreign-track",False),
                (7,173,3,"foreign-album",False), (8,175,1,"only-stale",True),
                (9,176,2,"only-inactive",False), (10,178,1,"only-foreign-track",False),
                (11,179,3,"only-foreign-root",False), (12,180,1,"stale-inventory",True),
                (13,180,2,"inactive-inventory",False)]
            for identity, track, root, name, stale in files:
                setup.execute("""insert into library.local_track_files
                    (id,track_id,library_root_id,private_path,metadata) values (%s,%s,%s,%s,%s::jsonb)""",
                    (identity, track, root, "/synthetic/" + name + ".flac", json.dumps({"scan_cache": {"stale": stale}})))
        host = "[::1]" if target["host"] == "::1" else target["host"]
        url = (f"postgresql://{quote(target['user'], safe='')}:{quote(target['password'], safe='')}"
               f"@{host}:{target['port']}/{target['dbname']}")
        try:
            yield SimpleNamespace(connect=connect, original=original, database_url=url)
        finally:
            with connect() as cleanup:
                cleanup.execute("drop schema library cascade")


@pytest.fixture
def selected_cover_pg_attestation(selected_cover_pg_database, isolated_database_safety_token):
    return {"database_url": selected_cover_pg_database.database_url,
            "pytest_isolated_database_safety_token": isolated_database_safety_token}


@pytest.fixture
def selected_cover_pg(selected_cover_pg_database, allow_isolated_app_database):
    fixture = selected_cover_pg_database
    opened = []

    def connect(url):
        assert url == fixture.database_url == allow_isolated_app_database
        opened.append(url)
        return fixture.connect(readonly=True)

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": allow_isolated_app_database}, connect=connect)
    return SimpleNamespace(repository=repository, original=fixture.original,
                           connect=fixture.connect, opened=opened)


def test_actual_selected_artwork_preserves_full_order_metadata_and_active_scope(selected_cover_pg):
    fixture = selected_cover_pg
    row = fixture.repository.load_selected_cover_artwork(album_id=72, library_id=23)
    assert row["album_id"] == 72 and row["library_id"] == 23
    assert row["metadata"] == fixture.original[72]
    assert [item["selection_id"] for item in row["metadata"]["selected_covers"]] == [
        "remote-back", "local-front", "remote-front"]
    assert row["metadata"]["selected_covers_revision"] == 17
    assert set(row["track_paths"]) == {"/synthetic/valid-a.flac", "/synthetic/valid-b.flac"}
    assert len(row["track_paths"]) == 2
    assert len(fixture.opened) == 1


@pytest.mark.parametrize("album_id", [74, 75, 76, 77, 78, 79, 80], ids=[
    "no-tracks", "only-stale", "inactive-root", "track-without-files",
    "foreign-library-track", "foreign-library-root", "mixed-unavailable-inventory"])
def test_actual_unavailable_inventory_keeps_remote_metadata_without_local_paths(selected_cover_pg, album_id):
    row = selected_cover_pg.repository.load_selected_cover_artwork(album_id=album_id, library_id=23)
    assert row == {"album_id": album_id, "library_id": 23,
                   "metadata": selected_cover_pg.original[album_id], "track_paths": []}


@pytest.mark.parametrize("album_id,library_id", [(72,24), (73,23), (999,23), (72,999)])
def test_actual_foreign_or_absent_identity_returns_no_album(selected_cover_pg, album_id, library_id):
    assert selected_cover_pg.repository.load_selected_cover_artwork(album_id=album_id, library_id=library_id) is None


def test_actual_other_library_reads_only_when_explicit_scope_matches(selected_cover_pg):
    row = selected_cover_pg.repository.load_selected_cover_artwork(album_id=73, library_id=24)
    assert row == {"album_id": 73, "library_id": 24, "metadata": selected_cover_pg.original[73],
                   "track_paths": ["/synthetic/foreign-album.flac"]}


@pytest.mark.parametrize("field,value", [("album_id", None), ("album_id", True), ("album_id", 0),
    ("album_id", -1), ("album_id", "72"), ("album_id", 2**63), ("album_id", 72.0),
    ("library_id", False), ("library_id", 0), ("library_id", -1),
    ("library_id", "23"), ("library_id", 2**63), ("library_id", 23.0)])
def test_invalid_scope_is_rejected_without_any_database_connection(selected_cover_pg, field, value):
    assert selected_cover_pg.repository.load_selected_cover_artwork(**{
        "album_id": 72, "library_id": 23, field: value}) is None
    assert selected_cover_pg.opened == []


def test_actual_read_does_not_change_durable_metadata_or_retain_mutable_aliases(selected_cover_pg):
    fixture = selected_cover_pg
    original = deepcopy(fixture.original[72])
    row = fixture.repository.load_selected_cover_artwork(album_id=72, library_id=23)
    row["metadata"]["selected_covers"].reverse()
    row["metadata"]["selected_covers_revision"] = 999
    again = fixture.repository.load_selected_cover_artwork(album_id=72, library_id=23)
    with fixture.connect() as observer:
        metadata = observer.execute("select metadata from library.local_albums where id=72").fetchone()[0]
    assert metadata == again["metadata"] == original
