"""Seed only a fresh job-owned personal-album producer baseline; never reset or repair.

Admitted only for the Linux Loved/favorites batches or the freshly provisioned Windows
persistent-contract database, before any test fixtures use that database.
No database URLs or credentials are changed, exported, read or printed.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
from uuid import UUID

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ("app", "integration", "library", "ops", "catalog")
MIGRATION_OWNED = frozenset({
    ("app", "client_surface_classes"), ("app", "deployment_mode_rules"),
    ("app", "e2e_problematic_file_fixture_seeds"), ("ops", "schema_migrations"),
})
FRESH_COUNTS = {("catalog", "popularity_api_refresh_state"): 1,
                ("integration", "playback_capture_budget"): 1}
SEEDED_COUNTS = {
    **FRESH_COUNTS, ("app", "social_profiles"): 1, ("app", "friend_policies"): 1,
    ("app", "accounts"): 1, ("app", "bootstrap_owners"): 1,
    ("library", "libraries"): 1,
    ("library", "public_metadata_source_state"): 1,
    ("library", "gallery_projection_state"): 1,
}
CLOCK_TABLES = ("public_metadata_source_state", "gallery_projection_state")


@dataclass(frozen=True)
class Identity:
    database: str
    setup_role: str
    runtime_role: str
    setup_url: str
    runtime_url: str
    marker: Path


def bootstrap_social_baseline(connection, library, baseline=None):
    """Verify only the canonical trigger-created rows; never adopt or repair drift."""
    owners = connection.execute("""select a.id as account_id,a.account_kind,
        a.metadata as account_metadata,b.metadata as owner_metadata
        from app.bootstrap_owners b join app.accounts a on a.id=b.account_id
        join library.libraries l on l.owner_account_id=a.id
        where b.owner_key='local-bootstrap-owner' and l.id=%s
          and l.name='Local Library' and l.library_kind='local'""", (library,)).fetchall()
    source = {"source": "isolated_e2e_launcher"}
    if (type(library) is not int or library <= 0 or len(owners) != 1
            or type(owners[0]["account_id"]) is not int or owners[0]["account_id"] <= 0
            or owners[0]["account_kind"] != "bootstrap_owner"
            or owners[0]["account_metadata"] != source or owners[0]["owner_metadata"] != source):
        raise RuntimeError("Canonical social baseline owner differs.")
    owner = owners[0]["account_id"]
    profiles = connection.execute("""select to_jsonb(p) as data from app.social_profiles p
        where account_id=%s""", (owner,)).fetchall()
    policies = connection.execute("""select to_jsonb(p) as data,isfinite(updated_at) as finite
        from app.friend_policies p where library_id=%s""", (library,)).fetchall()
    if len(profiles) != 1 or len(policies) != 1:
        raise RuntimeError("Canonical trigger-created social rows are missing or duplicated.")
    profile, policy = profiles[0]["data"], policies[0]["data"]
    if (not isinstance(profile, dict) or set(profile) != {"account_id", "account_ref"}
            or type(profile["account_id"]) is not int or profile["account_id"] != owner
            or not isinstance(profile["account_ref"], str)):
        raise RuntimeError("Canonical social profile differs.")
    try:
        valid_ref = str(UUID(profile["account_ref"])) == profile["account_ref"]
    except (ValueError, AttributeError, TypeError):
        valid_ref = False
    if not valid_ref:
        raise RuntimeError("Canonical social profile UUID is invalid.")
    if (not isinstance(policy, dict)
            or set(policy) != {"library_id", "auto_friend", "updated_by_account_id", "updated_at"}
            or type(policy["library_id"]) is not int or policy["library_id"] != library
            or policy["auto_friend"] is not False or policy["updated_by_account_id"] is not None
            or policy["updated_at"] is None or policies[0]["finite"] is not True):
        raise RuntimeError("Canonical friend policy defaults differ.")
    current = {"profile": dict(profile), "policy": dict(policy)}
    if baseline is not None and current != baseline:
        raise RuntimeError("Canonical social baseline changed; quarantine required.")
    return current


def plain_file(path):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or path.is_symlink()
            or getattr(info, "st_file_attributes", 0) & 0x400):
        raise RuntimeError("A plain job-owned file is required.")
    return info


def job_identity(env):
    if env.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Only the explicit GitHub Actions job may initialize.")
    run, attempt = env.get("GITHUB_RUN_ID", ""), env.get("GITHUB_RUN_ATTEMPT", "")
    if not re.fullmatch(r"[1-9][0-9]*", run) or not re.fullmatch(r"[1-9][0-9]*", attempt):
        raise RuntimeError("Invalid job identity.")
    platform = env.get("RUNNER_OS")
    if platform == "Linux":
        if env.get("GITHUB_JOB") != "test_feature_batches_linux" or env.get("FEATURE_BATCH") not in {"loved_backend", "favorites_backend", "capture_backend"}:
            raise RuntimeError("Only an allowlisted Loved, favorites or capture feature batch may initialize this service.")
        suffix = f"tops_{run}_{attempt}"
    elif platform == "Windows":
        if env.get("GITHUB_JOB") != "test_python":
            raise RuntimeError("Only the persistent Python contract job may initialize.")
        suffix = f"py_contract_{run}_{attempt}"
    else:
        raise RuntimeError("Unsupported runner platform.")
    if len(suffix) > 35:
        raise RuntimeError("Job identity exceeds admitted role bounds.")
    database = "album_haven_ci_" + suffix
    setup_role, runtime_role = "album_haven_migrator_" + suffix, "album_haven_app_" + suffix
    # Match each guarded provisioner exactly; Windows omits its default port.
    authority = "127.0.0.1:5432" if platform == "Linux" else "127.0.0.1"
    setup = f"postgresql://{setup_role}@{authority}/{database}"
    runtime = f"postgresql://{runtime_role}@{authority}/{database}"
    if (env.get("DATABASE_MIGRATOR_URL"), env.get("DATABASE_APP_URL")) != (setup, runtime):
        raise RuntimeError("Database URLs do not match this fresh job.")
    if platform == "Linux" and env.get("ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL") != runtime:
        raise RuntimeError("The Loved contract database must be this job's database.")
    temp = Path(env.get("RUNNER_TEMP", ""))
    if not temp.is_absolute() or not temp.is_dir() or temp.is_symlink():
        raise RuntimeError("An absolute plain runner temporary directory is required.")
    filename = database + ".pgpass" if platform == "Linux" else f"album-haven-postgres-{suffix}.pgpass"
    pgpass = temp / filename
    if env.get("PGPASSFILE") != str(pgpass):
        raise RuntimeError("PGPASSFILE does not exactly match the original job-local password file.")
    if env.get("PGPASSWORD"):
        raise RuntimeError("A PGPASSWORD override is not permitted for job-local password-file authentication.")
    info = plain_file(pgpass)  # Metadata only: never open credential contents.
    if platform == "Linux":
        if stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
            raise RuntimeError("Private owned Linux password-file metadata is required.")
    else:
        state_path = temp / "album-haven-python-contract-postgres.state.json"
        plain_file(state_path)
        state = json.loads(state_path.read_text(encoding="utf-8-sig"))
        expected = {"schemaVersion": 1, "suffix": suffix, "database": database,
                    "roles": {"migrator": setup_role, "app": runtime_role,
                              "readonly": "album_haven_readonly_" + suffix},
                    "pgpass": str(pgpass), "host": "127.0.0.1", "port": 5432}
        if state != expected or env.get("ALBUM_HAVEN_CI_DATABASE") != database:
            raise RuntimeError("Persistent Windows provisioner ownership does not match.")
    return Identity(database, setup_role, runtime_role, setup, runtime,
                    temp / (database + ".loved-bootstrap-attempt"))


@contextmanager
def bounded_connections():
    # The supported seed opens its own ordinary libpq connection. These bounds
    # therefore cover that connection as well as all explicit verification reads.
    values = {"PGCONNECT_TIMEOUT": "10",
              "PGOPTIONS": "-c statement_timeout=30000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=30000"}
    before = {key: os.environ.get(key) for key in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, value in before.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def assert_identity(connection, identity, *, setup):
    role = identity.setup_role if setup else identity.runtime_role
    base = "album_haven_migrator" if setup else "album_haven_app"
    row = connection.execute("""select current_database() as database,current_user as role,
        current_setting('server_version_num')::integer / 10000 as major,
        rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
        pg_has_role(current_user,%s,'USAGE') as inherited
        from pg_roles where rolname=current_user""", (base,)).fetchone()
    if row != dict(database=identity.database, role=role, major=17, rolsuper=False,
                   rolcreatedb=False, rolcreaterole=False, rolreplication=False,
                   rolbypassrls=False, inherited=True):
        raise RuntimeError("Unexpected database or role identity.")
    grants = connection.execute("""select
        not exists(select 1 from pg_roles where pg_has_role(current_user,oid,'MEMBER')
          and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) as safe,
        pg_has_role(current_user,'album_haven_migrator','MEMBER') as migrator""").fetchone()
    if grants != {"safe": True, "migrator": setup}:
        raise RuntimeError("Unexpected inherited privileges.")


def assert_migration_ledger(connection, root=ROOT):
    paths = sorted((root / "migrations" / "postgres").glob("*.sql"))
    expected = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths if p.is_file()}
    if not expected:
        raise RuntimeError("The checked-out migration set is empty.")
    rows = connection.execute("select migration_name,checksum from ops.schema_migrations").fetchall()
    actual = {row["migration_name"]: row["checksum"] for row in rows}
    if len(rows) != len(actual) or actual != expected:
        raise RuntimeError("The ledger does not exactly match every checked-out migration.")


def assert_counts(connection, expected):
    from psycopg import sql
    rows = connection.execute("""select n.nspname as schema_name,c.relname as table_name
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=any(%s) and c.relkind in ('r','p')
        order by n.nspname,c.relname""", (list(SCHEMAS),)).fetchall()
    tables = {(row["schema_name"], row["table_name"]) for row in rows}
    if not (MIGRATION_OWNED | set(SEEDED_COUNTS)).issubset(tables):
        raise RuntimeError("Required migrated relations are missing.")
    for schema, table in sorted(tables - MIGRATION_OWNED):
        count = connection.execute(sql.SQL("select count(*) as count from {}.{}").format(
            sql.Identifier(schema), sql.Identifier(table))).fetchone()["count"]
        if count != expected.get((schema, table), 0):
            raise RuntimeError(f"Unexpected application baseline: {schema}.{table}.")


def refresh_state(connection):
    rows = connection.execute("""select provider,lease_token,lease_until,next_attempt_at,
        isfinite(next_attempt_at) as finite from catalog.popularity_api_refresh_state""").fetchall()
    if (len(rows) != 1 or rows[0]["provider"] != "lastfm" or rows[0]["lease_token"] is not None
            or rows[0]["lease_until"] is not None or rows[0]["finite"] is not True):
        raise RuntimeError("Unexpected migration-owned refresh singleton.")
    return dict(rows[0])


def capture_budget_state(connection):
    """Only migration0142's untouched global zero-budget singleton is fresh."""
    rows = connection.execute("""select id,account_id,is_global,reserved_bytes,rate_tokens,
        rate_updated_at,isfinite(rate_updated_at) as finite
        from integration.playback_capture_budget""").fetchall()
    if (len(rows) != 1 or type(rows[0]["id"]) is not int or rows[0]["id"] <= 0
            or rows[0]["account_id"] is not None or rows[0]["is_global"] is not True
            or rows[0]["reserved_bytes"] != 0 or rows[0]["rate_tokens"] != 8
            or rows[0]["finite"] is not True):
        raise RuntimeError("Unexpected migration-owned capture budget singleton.")
    return dict(rows[0])


def assert_seed(connection):
    rows = connection.execute("""select a.account_kind,a.metadata as account_metadata,
        b.owner_key,b.metadata as owner_metadata,l.id,l.name,l.library_kind,l.metadata
        from app.bootstrap_owners b join app.accounts a on a.id=b.account_id
        join library.libraries l on l.owner_account_id=b.account_id""").fetchall()
    source = {"source": "isolated_e2e_launcher"}
    if len(rows) != 1:
        raise RuntimeError("The canonical bootstrap identity is not unique.")
    row = rows[0]
    if (type(row["id"]) is not int or row["id"] <= 0 or row["account_kind"] != "bootstrap_owner"
            or row["owner_key"] != "local-bootstrap-owner" or row["name"] != "Local Library"
            or row["library_kind"] != "local" or any(row[key] != source
                for key in ("account_metadata", "owner_metadata", "metadata"))):
        raise RuntimeError("The supported bootstrap baseline differs.")
    return row["id"]


def bootstrap_clocks(connection, library):
    from psycopg import sql
    result = {}
    for table in CLOCK_TABLES:
        rows = connection.execute(sql.SQL("select library_id,generation,last_invalidation_xid::text as xid from library.{}").format(sql.Identifier(table))).fetchall()
        if (len(rows) != 1 or rows[0]["library_id"] != library
                or type(rows[0]["generation"]) is not int or rows[0]["generation"] < 1
                or not isinstance(rows[0]["xid"], str) or not re.fullmatch(r"[1-9][0-9]*", rows[0]["xid"])):
            raise RuntimeError("Unexpected supported-bootstrap invalidation clocks.")
        result[table] = dict(rows[0])
    return result


def initialize(identity, isolated, *, root=ROOT):
    # An exclusive durable attempt marker prevents stale-lease recovery from
    # accidentally turning a failed or already completed initialization into repair.
    with identity.marker.open("x", encoding="utf-8") as marker:
        marker.write("Fresh Loved bootstrap attempted; never reuse this job database.\n")
    lease = isolated.IsolatedDatabaseOwnershipLock(database_url=identity.runtime_url, wait_seconds=10)
    lease.acquire()
    # No finally-release: any failure quarantines this disposable job.
    with bounded_connections():
        isolated.resolve_isolated_database_urls({isolated.SETUP_DATABASE_ENV: identity.setup_url,
                                               isolated.RUNTIME_DATABASE_ENV: identity.runtime_url})
        with isolated._connect(identity.setup_url) as connection:
            assert_identity(connection, identity, setup=True)
            assert_migration_ledger(connection, root)
            assert_counts(connection, FRESH_COUNTS)
            refresh = refresh_state(connection)
            capture_budget = capture_budget_state(connection)
        with isolated._connect(identity.runtime_url) as connection:
            assert_identity(connection, identity, setup=False)
        isolated.assert_runtime_grants(identity.runtime_url)
        isolated.seed_bootstrap_owner_and_library(identity.setup_url)
        with isolated._connect(identity.setup_url) as connection:
            assert_identity(connection, identity, setup=True)
            assert_migration_ledger(connection, root)
            assert_counts(connection, SEEDED_COUNTS)
            library = assert_seed(connection)
            social = bootstrap_social_baseline(connection, library)
            clocks = bootstrap_clocks(connection, library)
            if capture_budget_state(connection) != capture_budget:
                raise RuntimeError("Migration-owned capture budget changed during seed.")
            if refresh_state(connection) != refresh:
                raise RuntimeError("Migration-owned refresh state changed during seed.")
        with isolated._connect(identity.runtime_url) as connection:
            assert_identity(connection, identity, setup=False)
            bootstrap_social_baseline(connection, library, social)
            if capture_budget_state(connection) != capture_budget:
                raise RuntimeError("Committed capture budget changed.")
            if assert_seed(connection) != library or bootstrap_clocks(connection, library) != clocks:
                raise RuntimeError("Committed bootstrap identity or clocks changed.")
    lease.release()


def main():
    identity = job_identity(os.environ)
    sys.path.insert(0, str(ROOT))
    from tests.e2e.support import isolatedPostgres
    initialize(identity, isolatedPostgres)
    print("Validated fresh Loved bootstrap identity; no database routing changed.")


if __name__ == "__main__":
    main()
