"""Initialize only the fresh disposable popularity CI lane; never reset or repair.

Run after bootstrap-linux-tops-postgres.py in its exclusively assigned service.
A failed initialization quarantines the job: no retry, cleanup or URL export.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import re
import stat
import sys

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ("app", "integration", "library", "ops", "catalog")
MIGRATION_OWNED = frozenset({
    ("app", "client_surface_classes"),
    ("app", "deployment_mode_rules"),
    ("app", "e2e_problematic_file_fixture_seeds"),
    ("ops", "schema_migrations"),
})
FRESH_COUNTS = {("catalog", "popularity_api_refresh_state"): 1}
CLOCK_TABLES = ("public_metadata_source_state", "gallery_projection_state")
INITIALIZED_COUNTS = {
    **FRESH_COUNTS,
    ("library", "public_metadata_source_state"): 1,
    ("library", "gallery_projection_state"): 1,
    ("app", "accounts"): 1,
    ("app", "bootstrap_owners"): 1,
    ("library", "libraries"): 1,
    ("library", "relation_alias_endpoint_publications"): 1,
}


def assert_application_counts(connection, expected):
    from psycopg import sql

    tables = connection.execute("""select n.nspname as schema_name,c.relname as table_name
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=any(%s) and c.relkind in ('r','p')
        order by n.nspname,c.relname""", (list(SCHEMAS),)).fetchall()
    actual_tables = {(row["schema_name"], row["table_name"]) for row in tables}
    if not MIGRATION_OWNED.issubset(actual_tables) or not set(INITIALIZED_COUNTS).issubset(actual_tables):
        raise RuntimeError("Required migrated application relations are missing.")
    for schema, table in sorted(actual_tables - MIGRATION_OWNED):
        count = connection.execute(sql.SQL("select count(*) as count from {}.{}").format(
            sql.Identifier(schema), sql.Identifier(table))).fetchone()["count"]
        if count != expected.get((schema, table), 0):
            raise RuntimeError(f"Unexpected application baseline: {schema}.{table}.")


def assert_refresh_singleton(connection, baseline=None):
    rows = connection.execute("""select provider,lease_token,lease_until,next_attempt_at,
        isfinite(next_attempt_at) as finite from catalog.popularity_api_refresh_state""").fetchall()
    if (len(rows) != 1 or rows[0]["provider"] != "lastfm"
            or rows[0]["lease_token"] is not None or rows[0]["lease_until"] is not None
            or rows[0]["finite"] is not True):
        raise RuntimeError("Unexpected migration-owned popularity refresh singleton.")
    if baseline is not None and rows[0] != baseline:
        raise RuntimeError("Migration-owned popularity refresh state changed during initialization.")
    return dict(rows[0])


def assert_bootstrap_clocks(connection, library, baseline=None):
    from psycopg import sql

    clocks = {}
    for table in CLOCK_TABLES:
        rows = connection.execute(sql.SQL("""select library_id,generation,
            last_invalidation_xid::text as xid from library.{}""").format(sql.Identifier(table))).fetchall()
        if (len(rows) != 1 or rows[0]["library_id"] != library
                or type(rows[0]["generation"]) is not int or rows[0]["generation"] < 1
                or not isinstance(rows[0]["xid"], str)
                or not re.fullmatch(r"[0-9]+", rows[0]["xid"]) or int(rows[0]["xid"]) < 1):
            raise RuntimeError("Unexpected supported-bootstrap invalidation clock.")
        current = dict(rows[0])
        if baseline is not None:
            previous = baseline[table]
            if (current["generation"] < previous["generation"]
                    or int(current["xid"]) < int(previous["xid"])
                    or (current["generation"] == previous["generation"] and current["xid"] != previous["xid"])):
                raise RuntimeError("Bootstrap invalidation clock evidence regressed or changed inconsistently.")
        clocks[table] = current
    return clocks


def assert_migration_ledger(connection):
    paths = sorted((ROOT / "migrations" / "postgres").glob("*.sql"))
    expected = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in paths if path.is_file()}
    if "0140_create_relation_alias_endpoints.sql" not in expected:
        raise RuntimeError("Composed endpoint migration 0140 is required.")
    rows = connection.execute("select migration_name,checksum from ops.schema_migrations").fetchall()
    actual = {row["migration_name"]: row["checksum"] for row in rows}
    if len(rows) != len(actual) or actual != expected:
        raise RuntimeError("Migration ledger does not exactly match the checked-out source.")


def assert_identity(connection, database, role, base_role):
    row = connection.execute("""select current_database() as database,current_user as role,
        current_setting('server_version_num')::integer / 10000 as major,
        rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
        pg_has_role(current_user,%s,'USAGE') as inherited
        from pg_roles where rolname=current_user""", (base_role,)).fetchone()
    if row != dict(database=database, role=role, major=17, rolsuper=False,
                   rolcreatedb=False, rolcreaterole=False, rolreplication=False,
                   rolbypassrls=False, inherited=True):
        raise RuntimeError("Unexpected disposable database or role privileges.")
    privileges = connection.execute("""select
        not exists(select 1 from pg_roles where pg_has_role(current_user,oid,'MEMBER')
          and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) as safe,
        pg_has_role(current_user,'album_haven_migrator','MEMBER') as migrator""").fetchone()
    if not privileges["safe"] or privileges["migrator"] != (base_role == "album_haven_migrator"):
        raise RuntimeError("Unexpected inherited role authority.")
    connection.execute("set statement_timeout='30s'")
    connection.execute("set lock_timeout='10s'")


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_OS") != "Linux":
        raise RuntimeError("Initialization is restricted to the Linux GitHub Actions lane.")
    run_id, attempt = os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"]
    suffix = f"tops_{run_id}_{attempt}"
    if not re.fullmatch(r"tops_[0-9]+_[0-9]+", suffix) or len(suffix) > 35:
        raise RuntimeError("Invalid job identity.")
    database = "album_haven_ci_" + suffix
    setup_role, runtime_role = "album_haven_migrator_" + suffix, "album_haven_app_" + suffix
    setup_url = f"postgresql://{setup_role}@127.0.0.1:5432/{database}"
    runtime_url = f"postgresql://{runtime_role}@127.0.0.1:5432/{database}"
    readonly_role = "album_haven_readonly_" + suffix
    readonly_url = f"postgresql://{readonly_role}@127.0.0.1:5432/{database}"
    if (os.environ.get("DATABASE_MIGRATOR_URL"), os.environ.get("DATABASE_APP_URL")) != (setup_url, runtime_url):
        raise RuntimeError("URLs must be the exact freshly provisioned job identities.")
    temp = Path(os.environ["RUNNER_TEMP"])
    pgpass = temp / (database + ".pgpass")
    if (not temp.is_absolute() or not temp.is_dir() or pgpass.is_symlink()
            or os.environ.get("PGPASSFILE") != str(pgpass) or not pgpass.is_file()
            or stat.S_IMODE(pgpass.stat().st_mode) != 0o600 or pgpass.stat().st_uid != os.getuid()
            or os.environ.get("PGPASSWORD")):
        raise RuntimeError("Private job-local pgpass authentication is required.")
    sys.path.insert(0, str(ROOT))
    from psycopg.types.json import Jsonb
    from tests.e2e.support import isolatedPostgres
    from music_app.services.cache import serialize_relation_views
    from music_app.services.relation_projection_postgres import (
        RELATION_PROJECTION_METADATA_KEY, build_ready_relation_projection_metadata,
        build_relation_views_from_postgres_rows, relation_source_fingerprint,
        relation_projection_stale_reason, replace_relation_alias_endpoints_in_transaction,
    )

    exports = {isolatedPostgres.SETUP_DATABASE_ENV: setup_url,
               isolatedPostgres.RUNTIME_DATABASE_ENV: runtime_url,
               "ALBUM_HAVEN_POPULARITY_READONLY_DATABASE_URL": readonly_url}
    isolatedPostgres.resolve_isolated_database_urls(exports)
    lease = isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=runtime_url)
    lease.acquire()
    # Deliberately release only after every check and export succeeds. Failure
    # leaves the owner marker; this disposable job must stop, never repair/reuse.
    with isolatedPostgres._connect(setup_url) as con:
        assert_identity(con, database, setup_role, isolatedPostgres.SETUP_ROLE)
        assert_migration_ledger(con)
        assert_application_counts(con, FRESH_COUNTS)
        refresh_baseline = assert_refresh_singleton(con)
    with isolatedPostgres._connect(runtime_url) as con:
        assert_identity(con, database, runtime_role, isolatedPostgres.RUNTIME_ROLE)
        for table in ("library.relation_alias_endpoint_publications", "library.relation_alias_endpoints"):
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"):
                actual = con.execute("select has_table_privilege(current_user,%s,%s) as allowed",
                                     (table, privilege)).fetchone()["allowed"]
                if actual != (privilege == "SELECT"):
                    raise RuntimeError("Unexpected runtime endpoint table privileges.")
        for function in ("library.replace_relation_alias_endpoints(jsonb)", "library.relation_alias_endpoints_ready(bigint)"):
            if not con.execute("select has_function_privilege(current_user,%s,'EXECUTE') as allowed",
                               (function,)).fetchone()["allowed"]:
                raise RuntimeError("Runtime endpoint function execution is unavailable.")
    # Existing provisioner created this login and its private pgpass entry.
    # Validate before exporting; never read/copy the pgpass or expand authority.
    import psycopg
    from psycopg.rows import dict_row
    with psycopg.connect(readonly_url, row_factory=dict_row, connect_timeout=10,
            options="-c statement_timeout=15000 -c lock_timeout=10000") as con:
        assert_identity(con, database, readonly_role, "album_haven_readonly")
        if con.execute("select pg_has_role(current_user,'album_haven_app','MEMBER') as app").fetchone()["app"]:
            raise RuntimeError("Readonly login unexpectedly inherits writer authority.")
        for table in ("library.relation_alias_endpoint_publications", "library.relation_alias_endpoints"):
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"):
                actual = con.execute("select has_table_privilege(current_user,%s,%s) as allowed",
                                     (table, privilege)).fetchone()["allowed"]
                if actual != (privilege == "SELECT"):
                    raise RuntimeError("Unexpected readonly endpoint table privileges.")
        for function, expected in (("library.replace_relation_alias_endpoints(jsonb)", False),
                                   ("library.relation_alias_endpoints_ready(bigint)", True)):
            if con.execute("select has_function_privilege(current_user,%s,'EXECUTE') as allowed",
                           (function,)).fetchone()["allowed"] != expected:
                raise RuntimeError("Unexpected readonly endpoint function privileges.")
    isolatedPostgres.seed_bootstrap_owner_and_library(setup_url)
    with isolatedPostgres._connect(setup_url) as con:
        assert_identity(con, database, setup_role, isolatedPostgres.SETUP_ROLE)
        seeded_counts = dict(INITIALIZED_COUNTS)
        seeded_counts[("library", "relation_alias_endpoint_publications")] = 0
        assert_application_counts(con, seeded_counts)
        seeded_library = con.execute("select id from library.libraries").fetchone()["id"]
        clock_baseline = assert_bootstrap_clocks(con, seeded_library)
        assert_refresh_singleton(con, refresh_baseline)
    views = serialize_relation_views(build_relation_views_from_postgres_rows({}, []))
    now = datetime.now(timezone.utc)
    metadata = build_ready_relation_projection_metadata(relation_source_fingerprint([]),
        reason="popularity_bootstrap", duration_ms=0, built_at=now.isoformat(), source_row_count=0)
    cache = {"relation_views": views, RELATION_PROJECTION_METADATA_KEY: metadata,
             "relations_last_built": now.timestamp()}
    if relation_projection_stale_reason(cache) or any(views.values()):
        raise RuntimeError("The real builder did not produce complete empty ready relations.")
    with isolatedPostgres._connect(runtime_url) as con:
        assert_identity(con, database, runtime_role, isolatedPostgres.RUNTIME_ROLE)
        rows = con.execute("""select l.id from library.libraries l
            join app.bootstrap_owners b on b.account_id=l.owner_account_id
            join app.accounts a on a.id=b.account_id
            where b.owner_key='local-bootstrap-owner' and a.account_kind='bootstrap_owner'
              and l.name='Local Library' and l.library_kind='local'""").fetchall()
        if len(rows) != 1:
            raise RuntimeError("The supported bootstrap selector is not unique.")
        library = rows[0]["id"]
        if library != seeded_library:
            raise RuntimeError("Supported bootstrap library identity changed.")
        con.execute("""update library.libraries set metadata=metadata ||
            jsonb_build_object('scan_cache',%s::jsonb),updated_at=now() where id=%s""", (Jsonb(cache), library))
        status = replace_relation_alias_endpoints_in_transaction(con, views,
            metadata=metadata, relations_last_built=now.timestamp(), stored=True)
        if status != "ready" or not con.execute(
                "select library.relation_alias_endpoints_ready(%s) as ready", (library,)).fetchone()["ready"]:
            raise RuntimeError("The real empty endpoint publication is not ready.")
    with isolatedPostgres._connect(setup_url) as con:
        assert_identity(con, database, setup_role, isolatedPostgres.SETUP_ROLE)
        assert_migration_ledger(con)
        assert_application_counts(con, INITIALIZED_COUNTS)
        assert_refresh_singleton(con, refresh_baseline)
        assert_bootstrap_clocks(con, library, clock_baseline)
    with isolatedPostgres._connect(runtime_url) as con:
        assert_identity(con, database, runtime_role, isolatedPostgres.RUNTIME_ROLE)
        if not con.execute("select library.relation_alias_endpoints_ready(%s) as ready",
                           (library,)).fetchone()["ready"]:
            raise RuntimeError("Committed empty endpoint baseline is not ready.")
    # The provisioner's PGPASSFILE remains unchanged and is never read or printed.
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as stream:
        for key, value in exports.items():
            stream.write(f"{key}={value}\n")
    lease.release()
    print("Validated fresh popularity bootstrap lane with real empty ready endpoints.")


if __name__ == "__main__":
    main()
