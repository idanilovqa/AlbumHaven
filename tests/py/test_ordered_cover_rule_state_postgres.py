"""Bounded real-PostgreSQL qualification of ordered-cover rule-state writes.

Opt in with ALBUM_HAVEN_RULE_STATE_TEST_DATABASE JSON containing exactly host,
port, dbname, user and password for an EMPTY, owned loopback database named
pytest_rule_state_<8-32 hex characters>. No ambient PG/app credentials are used.
Only six queried tables and the unchanged 0104 constraint are installed. This
is not the full migration tree, deployment-role, HTTP, media or UI qualification.
Each case owns its schemas and unique synthetic data; no media is created/read.
"""
import json
import os
from pathlib import Path
import re
from types import SimpleNamespace
from uuid import uuid4

import pytest

from music_app.services.ordered_cover_references import OrderedCoverSelectionConflict
from music_app.services.rule_state_postgres import RuleStatePostgresAdapter

TARGET_ENV = "ALBUM_HAVEN_RULE_STATE_TEST_DATABASE"
METHODS = ["save_exception_overrides", "upsert_exception_overrides"]
MIGRATION = Path(__file__).resolve().parents[2] / "migrations/postgres/0104_add_ordered_cover_metadata_constraint.sql"
SCHEMA = """
create schema app;
create schema library;
create table app.bootstrap_owners (owner_key text primary key, account_id bigint not null unique);
create table library.libraries (id bigint primary key, owner_account_id bigint not null,
 name text not null, library_kind text not null, metadata jsonb not null, updated_at timestamptz);
create table library.local_albums (id bigint primary key,
 library_id bigint not null references library.libraries, title text not null,
 cover_path text, metadata jsonb not null);
create table library.local_tracks (id bigint primary key,
 library_id bigint not null references library.libraries,
 album_id bigint references library.local_albums, track_key text not null);
create table library.local_track_files (id bigint primary key,
 track_id bigint not null references library.local_tracks, private_path text not null unique,
 metadata jsonb not null,
 scan_cache_stale boolean generated always as (
   lower(btrim(coalesce(metadata #>> '{scan_cache,stale}', '')))
   in ('true','t','yes','y','on','1')) stored);
create table library.exception_overrides (id bigint generated always as identity primary key,
 library_id bigint not null references library.libraries,
 track_id bigint references library.local_tracks, track_key text not null,
 override_payload jsonb not null, updated_at timestamptz not null default now(),
 unique(library_id,track_key));
"""


def _explicit_target(raw):
    try:
        target = json.loads(raw)
    except (TypeError, ValueError):
        raise pytest.UsageError("Rule-state target must be an explicit JSON object") from None
    if not isinstance(target, dict) or set(target) != {"host", "port", "dbname", "user", "password"}:
        raise pytest.UsageError("Rule-state target requires exactly host, port, dbname, user, password")
    if (target["host"] not in ("127.0.0.1", "::1")
            or type(target["port"]) is not int or not 1 <= target["port"] <= 65535
            or not isinstance(target["dbname"], str)
            or not re.fullmatch(r"pytest_rule_state_[a-f0-9]{8,32}", target["dbname"])
            or not isinstance(target["user"], str) or not target["user"]
            or not isinstance(target["password"], str)):
        raise pytest.UsageError("Rule-state tests require an explicitly owned isolated loopback database")
    return target


@pytest.fixture
def rule_state_pg():
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

        def connect(*, dictionaries=False):
            return psycopg.connect(**target, passfile=os.devnull, connect_timeout=5,
                sslmode="disable", application_name="ordered-rule-state-synthetic",
                options="-c statement_timeout=10000 -c lock_timeout=5000",
                **({"row_factory": dict_row} if dictionaries else {}))

        with connect() as setup:
            assert setup.execute("select current_database(), current_user").fetchone() == (target["dbname"], target["user"])
            assert setup.execute("""select pg_get_userbyid(datdba) = current_user
                from pg_database where datname=current_database()""").fetchone()[0]
            assert setup.execute("""select count(*) from pg_namespace
                where nspname not in ('pg_catalog','pg_toast','information_schema','public')""").fetchone()[0] == 0, "Refusing occupied schemas"
            assert setup.execute("""select count(*) from pg_class c join pg_namespace n
                on n.oid=c.relnamespace where n.nspname='public'""").fetchone()[0] == 0, "Refusing occupied public schema"
            setup.execute(SCHEMA)
            setup.execute(MIGRATION.read_text(encoding="utf-8"))
        try:
            identity = uuid4().hex
            a, b = (f"/synthetic/rule-state/{identity}/{name}.flac" for name in ("a", "b"))
            album_metadata = {
                "selected_covers": [
                    {"selection_id": "front", "kind": "local", "path": f"/synthetic/{identity}/front.jpg"},
                    {"selection_id": "back", "kind": "remote", "url": "https://synthetic.invalid/back.jpg"}],
                "selected_covers_revision": 3,
                "cover_selection_origin": "manual", "cover_selection_provenance": "explicit",
                "cover_revision": "preserve-manual-revision", "unrelated": {"keep": identity}}
            with connect() as setup:
                setup.execute("insert into app.bootstrap_owners values ('local-bootstrap-owner',1)")
                setup.execute("""insert into library.libraries values
                    (1,1,'Local Library','local','{"inventory_mutation_revision":7,"scan_cache":{"relation_projection":{"status":"ready"}},"unrelated":"keep"}',null)""")
                setup.execute("insert into library.local_albums values (72,1,'Original',%s,%s::jsonb)",
                              (album_metadata["selected_covers"][0]["path"], json.dumps(album_metadata)))
                for index, path in enumerate((a, b), 1):
                    setup.execute("insert into library.local_tracks values (%s,1,72,%s)", (index, path))
                    entry = {"scan_cache": {"file_entry": {"album": "Original", "edition": "", "exception_type": ""}}}
                    setup.execute("insert into library.local_track_files(id,track_id,private_path,metadata) values (%s,%s,%s,%s::jsonb)",
                                  (index, index, path, json.dumps(entry)))
                    setup.execute("""insert into library.exception_overrides(library_id,track_id,track_key,override_payload)
                        values (1,%s,%s,'{"exception_type":"","unrelated":"keep"}')""", (index, path))

            def state():
                # Every observation uses a new connection, outside the writer transaction.
                with connect() as observer:
                    return {table: observer.execute(f"select * from {table} order by 1").fetchall()
                            for table in ("app.bootstrap_owners", "library.libraries", "library.local_albums",
                                          "library.local_tracks", "library.local_track_files", "library.exception_overrides")}

            url = "postgresql://explicit-fixture.invalid/owned-rule-state"

            def adapter_connect(requested):
                assert requested == url
                return connect(dictionaries=True)

            adapter = RuleStatePostgresAdapter({"ALBUM_HAVEN_APP_DATABASE_URL": url}, connect=adapter_connect)
            yield SimpleNamespace(a=a, b=b, connect=connect, state=state, adapter=adapter)
        finally:
            # Only reached after successful creation/commit of these exact owned schemas.
            with connect() as cleanup:
                cleanup.execute("drop schema library cascade; drop schema app cascade")


def _reject_override_writes(fixture):
    """A SQL tripwire makes any attempted mutation fail differently from preflight."""
    with fixture.connect() as setup:
        setup.execute("""create function library.reject_override_write() returns trigger language plpgsql as $$
            begin raise exception 'override mutation reached before rejection'; end $$;
            create trigger reject_override_write before insert or update or delete on library.exception_overrides
            for each row execute function library.reject_override_write()""")


@pytest.mark.parametrize("method", METHODS)
def test_actual_ordered_owner_detach_rejects_before_override_write(rule_state_pg, method):
    s = rule_state_pg
    before = s.state()
    _reject_override_writes(s)
    with pytest.raises(OrderedCoverSelectionConflict, match="ordered cover ownership"):
        getattr(s.adapter, method)({s.a: "Interview", s.b: ""})
    assert s.state() == before


def test_actual_replacement_revealing_scanned_exception_rejects_before_delete(rule_state_pg):
    s = rule_state_pg
    with s.connect() as setup:
        setup.execute("""update library.local_track_files set metadata=jsonb_set(metadata,
            '{scan_cache,file_entry,exception_type}','"Interview"') where private_path=%s""", (s.a,))
    before = s.state()
    _reject_override_writes(s)
    with pytest.raises(OrderedCoverSelectionConflict, match="ordered cover ownership"):
        s.adapter.save_exception_overrides({})
    assert s.state() == before


def _seed_exception_labels(s):
    with s.connect() as setup:
        setup.execute("update library.exception_overrides set override_payload=override_payload || '{\"exception_type\":\"Compilation\"}'::jsonb")


@pytest.mark.parametrize("method", METHODS)
def test_actual_harmless_label_commits_once_preserving_ordered_and_manual_metadata(rule_state_pg, method):
    s = rule_state_pg
    _seed_exception_labels(s)
    before = s.state()
    getattr(s.adapter, method)({s.a: "Interview", s.b: "Compilation"})
    after = s.state()
    for table in before.keys() - {"library.libraries", "library.exception_overrides"}:
        assert after[table] == before[table]
    with s.connect() as observer:
        metadata, updated = observer.execute("select metadata,updated_at from library.libraries where id=1").fetchone()
        assert metadata == {"inventory_mutation_revision": 8, "unrelated": "keep",
                            "scan_cache": {"relation_projection": {"status": "stale"}}}
        assert updated is not None
        assert dict(observer.execute("select track_key,override_payload from library.exception_overrides").fetchall()) == {
            s.a: {"exception_type": "Interview", "unrelated": "keep"},
            s.b: {"exception_type": "Compilation", "unrelated": "keep"}}


@pytest.mark.parametrize("method", METHODS)
def test_actual_revision_sql_failure_rolls_back_prior_override_writes(rule_state_pg, method):
    import psycopg
    s = rule_state_pg
    _seed_exception_labels(s)
    if method == "save_exception_overrides":
        # A dormant key has no active album membership. Replacement must really
        # delete it before the later revision failure, then restore it on rollback.
        with s.connect() as setup:
            setup.execute("""insert into library.exception_overrides(library_id,track_key,override_payload)
                values (1,%s,'{"exception_type":"Compilation","unrelated":"restore-deleted-row"}')""",
                (s.a + ".dormant",))
    before = s.state()
    with s.connect() as setup:
        setup.execute("""create function library.reject_revision_after_writes() returns trigger language plpgsql as $$
            begin
              if (select count(*) from library.exception_overrides
                  where override_payload->>'exception_type'='Interview') <> 2 then
                raise exception 'expected preceding override writes were not visible';
              end if;
              if exists(select 1 from library.exception_overrides where track_id is null) then
                raise exception 'expected replacement deletion was not visible';
              end if;
              raise exception 'synthetic revision failure after both override writes';
            end $$;
            create trigger reject_revision before update on library.libraries
            for each row execute function library.reject_revision_after_writes()""")
    with pytest.raises(psycopg.errors.RaiseException, match="synthetic revision failure after both override writes"):
        getattr(s.adapter, method)({s.a: "Interview", s.b: "Interview"})
    assert s.state() == before
