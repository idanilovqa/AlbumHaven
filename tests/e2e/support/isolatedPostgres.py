from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import os
import re
import tempfile
import time
import uuid
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

if os.name == "nt":
    import msvcrt
else:
    import fcntl


ROOT = Path(__file__).resolve().parents[3]
DATABASE_NAME = "album_haven_fake_e2e"
SETUP_DATABASE_ENV = "ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL"
RUNTIME_DATABASE_ENV = "ALBUM_HAVEN_FAKE_E2E_DATABASE_URL"
SETUP_ROLE = "album_haven_migrator"
RUNTIME_ROLE = "album_haven_app"
_APPLICATION_SCHEMAS = ("app", "integration", "library", "ops")
_MIGRATION_OWNED_TABLES = frozenset(
    {
        ("app", "client_surface_classes"),
        ("app", "deployment_mode_rules"),
        ("app", "e2e_problematic_file_fixture_seeds"),
        ("ops", "schema_migrations"),
    }
)
_RUNTIME_DELETE_TABLES = (
    ("integration", "pending_scrobbles"),
    ("integration", "scrobble_retry_state"),
    ("integration", "listen_history"),
    ("library", "move_policy_settings"),
    ("library", "ignored_versions"),
    ("library", "ignored_repairs"),
    ("library", "manual_versions"),
    ("library", "separate_releases"),
    ("library", "exception_overrides"),
    ("library", "local_album_featured_artists"),
    ("ops", "cover_lookup_tasks"),
)
_REQUIRED_TABLE_PRIVILEGES = ("SELECT", "INSERT", "UPDATE", "DELETE")
_DENIED_TABLE_PRIVILEGES = ("TRUNCATE", "REFERENCES", "TRIGGER")
_DATABASE_LOCK_PATH = Path(tempfile.gettempdir()) / f"{DATABASE_NAME}.lock"
_DATABASE_LOCK_WAIT_SECONDS = 120.0
_DATABASE_LOCK_POLL_SECONDS = 0.2
_DATABASE_LOCK_INCOMPLETE_GRACE_SECONDS = 5.0


class _ProcessIdentityState(Enum):
    PRESENT = "present"
    ABSENT = "absent"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class _ProcessIdentityResult:
    state: _ProcessIdentityState
    identity: str | None = None


def _process_identity(process_id: int) -> _ProcessIdentityResult:
    if os.name != "nt":
        try:
            os.kill(process_id, 0)
        except ProcessLookupError:
            return _ProcessIdentityResult(_ProcessIdentityState.ABSENT)
        except (OSError, ValueError):
            return _ProcessIdentityResult(_ProcessIdentityState.UNKNOWN)
        return _ProcessIdentityResult(_ProcessIdentityState.PRESENT, str(process_id))

    process_query_limited_information = 0x1000
    still_active = 259
    error_invalid_parameter = 87
    kernel32 = ctypes.windll.kernel32
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.GetProcessTimes.argtypes = (
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
    )
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.GetLastError.restype = wintypes.DWORD
    handle = kernel32.OpenProcess(process_query_limited_information, False, process_id)
    if not handle:
        state = (
            _ProcessIdentityState.ABSENT
            if kernel32.GetLastError() == error_invalid_parameter
            else _ProcessIdentityState.UNKNOWN
        )
        return _ProcessIdentityResult(state)
    try:
        exit_code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return _ProcessIdentityResult(_ProcessIdentityState.UNKNOWN)
        if exit_code.value != still_active:
            return _ProcessIdentityResult(_ProcessIdentityState.ABSENT)
        creation = wintypes.FILETIME()
        exit_time = wintypes.FILETIME()
        kernel = wintypes.FILETIME()
        user = wintypes.FILETIME()
        if not kernel32.GetProcessTimes(
            handle,
            ctypes.byref(creation),
            ctypes.byref(exit_time),
            ctypes.byref(kernel),
            ctypes.byref(user),
        ):
            return _ProcessIdentityResult(_ProcessIdentityState.UNKNOWN)
        creation_ticks = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
        return _ProcessIdentityResult(
            _ProcessIdentityState.PRESENT,
            f"{process_id}:{creation_ticks}",
        )
    finally:
        kernel32.CloseHandle(handle)


class IsolatedDatabaseOwnershipLock:
    def __init__(
        self,
        lock_path: Path = _DATABASE_LOCK_PATH,
        wait_seconds: float = _DATABASE_LOCK_WAIT_SECONDS,
        database_label: str = DATABASE_NAME,
    ) -> None:
        self.lock_path = lock_path
        self.wait_seconds = wait_seconds
        self.database_label = database_label
        self.owner_path = lock_path / "owner.json"
        self.reaper_lock_path = lock_path.with_name(f"{lock_path.name}.reaper")
        self.owner_token = uuid.uuid4().hex
        self._acquired = False

    def _owner_record(self) -> dict[str, object]:
        process_id = os.getpid()
        process_identity = _process_identity(process_id)
        if (
            process_identity.state is not _ProcessIdentityState.PRESENT
            or process_identity.identity is None
        ):
            raise RuntimeError("Could not determine the isolated E2E lock owner process identity.")
        return {
            "token": self.owner_token,
            "pid": process_id,
            "process_identity": process_identity.identity,
            "created_at": time.time(),
        }

    def _read_owner(self) -> dict[str, object] | None:
        try:
            owner = json.loads(self.owner_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return None
        return owner if isinstance(owner, dict) else None

    def _incomplete_lock_is_stale(self) -> bool:
        try:
            age_seconds = time.time() - self.lock_path.stat().st_mtime
        except FileNotFoundError:
            return False
        return age_seconds >= _DATABASE_LOCK_INCOMPLETE_GRACE_SECONDS

    @staticmethod
    def _owner_is_stale(owner: dict[str, object]) -> bool:
        try:
            process_id = int(owner["pid"])
            recorded_identity = str(owner["process_identity"])
        except (KeyError, TypeError, ValueError):
            return True
        current_identity = _process_identity(process_id)
        if current_identity.state is _ProcessIdentityState.ABSENT:
            return True
        if current_identity.state is _ProcessIdentityState.UNKNOWN:
            return False
        return current_identity.identity != recorded_identity

    def _remove_stale_lock(self, expected_token: str | None) -> bool:
        reaper_file = self.reaper_lock_path.open("a+b")
        try:
            reaper_file.seek(0)
            if os.name == "nt":
                try:
                    msvcrt.locking(reaper_file.fileno(), msvcrt.LK_NBLCK, 1)
                except OSError:
                    return False
            else:
                try:
                    fcntl.flock(reaper_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError:
                    return False

            owner = self._read_owner()
            if expected_token is not None and str((owner or {}).get("token") or "") != expected_token:
                return False
            if expected_token is None and owner is not None:
                return False
            try:
                self.owner_path.unlink(missing_ok=True)
                self.lock_path.rmdir()
            except OSError:
                return False
            return True
        finally:
            if os.name == "nt":
                try:
                    reaper_file.seek(0)
                    msvcrt.locking(reaper_file.fileno(), msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
            else:
                try:
                    fcntl.flock(reaper_file.fileno(), fcntl.LOCK_UN)
                except OSError:
                    pass
            reaper_file.close()

    def acquire(self) -> None:
        deadline = time.monotonic() + self.wait_seconds
        last_owner: dict[str, object] | None = None
        while True:
            try:
                self.lock_path.mkdir()
            except FileExistsError:
                last_owner = self._read_owner()
                if last_owner is not None and self._owner_is_stale(last_owner):
                    if self._remove_stale_lock(str(last_owner.get("token") or "")):
                        continue
                if last_owner is None and self._incomplete_lock_is_stale():
                    if self._remove_stale_lock(None):
                        continue
                if time.monotonic() >= deadline:
                    owner_summary = last_owner or {"state": "owner metadata incomplete"}
                    raise TimeoutError(
                        f"Timed out waiting {self.wait_seconds:g}s for isolated E2E database "
                        f"{self.database_label!r}; current owner: {owner_summary!r}."
                    )
                time.sleep(_DATABASE_LOCK_POLL_SECONDS)
                continue

            try:
                owner = self._owner_record()
                with self.owner_path.open("x", encoding="utf-8") as owner_file:
                    json.dump(owner, owner_file, sort_keys=True)
                    owner_file.flush()
                    os.fsync(owner_file.fileno())
                self._acquired = True
                return
            except BaseException:
                self.owner_path.unlink(missing_ok=True)
                try:
                    self.lock_path.rmdir()
                except OSError:
                    pass
                raise

    def release(self) -> None:
        if not self._acquired:
            return
        owner = self._read_owner()
        if str((owner or {}).get("token") or "") != self.owner_token:
            raise RuntimeError(
                "Refusing to release the isolated E2E database lock because its owner token changed."
            )
        try:
            self.owner_path.unlink()
            self.lock_path.rmdir()
        finally:
            self._acquired = False


def _database_identity(database_url: str) -> tuple[str, str, int | None, str]:
    parsed = urlparse(database_url)
    return (
        parsed.scheme.casefold(),
        (parsed.hostname or "").casefold(),
        parsed.port,
        Path(parsed.path or "").name.casefold(),
    )


def _database_name(database_url: str) -> str:
    return Path(urlparse(database_url).path or "").name.casefold()


def _database_role(database_url: str) -> str:
    return unquote(urlparse(database_url).username or "").casefold()


def _is_owned_isolated_database_name(database_name: str) -> bool:
    return database_name == DATABASE_NAME or (
        database_name.startswith("album_haven_ci_")
        and re.fullmatch(
            r"[a-z0-9]+(?:_[a-z0-9]+)*",
            database_name.removeprefix("album_haven_ci_"),
        )
        is not None
    )


def _matches_isolated_role(role_name: str, base_role: str) -> bool:
    return role_name == base_role or (
        role_name.startswith(f"{base_role}_")
        and re.fullmatch(
            r"[a-z0-9]+(?:_[a-z0-9]+)*",
            role_name.removeprefix(f"{base_role}_"),
        )
        is not None
    )


def _required_database_url(env: dict[str, str], env_name: str) -> str:
    database_url = str(env.get(env_name) or "").strip()
    if not database_url:
        raise RuntimeError(f"{env_name} is required for isolated fake-data E2E runs.")
    parsed = urlparse(database_url)
    if parsed.password is not None:
        raise RuntimeError(f"{env_name} must not include a password; use pgpass instead.")
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise RuntimeError(f"{env_name} must use a PostgreSQL URL.")
    if parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise RuntimeError(f"{env_name} must use a loopback host.")
    if parsed.query or parsed.params or parsed.fragment:
        raise RuntimeError(f"{env_name} must not include connection parameters.")
    database_name = _database_name(database_url)
    if database_name == "album_haven_core":
        raise RuntimeError(f"{env_name} must not target album_haven_core.")
    if not _is_owned_isolated_database_name(database_name):
        raise RuntimeError(
            f"{env_name} must target {DATABASE_NAME!r} or a strict album_haven_ci_ "
            f"database; got {database_name!r}."
        )
    return database_url


def resolve_isolated_database_urls(
    environ: dict[str, str] | None = None,
) -> tuple[str, str]:
    env = os.environ if environ is None else environ
    setup_url = _required_database_url(env, SETUP_DATABASE_ENV)
    runtime_url = _required_database_url(env, RUNTIME_DATABASE_ENV)
    if _database_identity(setup_url) != _database_identity(runtime_url):
        raise RuntimeError(
            f"{SETUP_DATABASE_ENV} and {RUNTIME_DATABASE_ENV} must identify the same "
            f"{DATABASE_NAME!r} database."
        )
    setup_role = _database_role(setup_url)
    runtime_role = _database_role(runtime_url)
    if not _matches_isolated_role(setup_role, SETUP_ROLE):
        raise RuntimeError(f"{SETUP_DATABASE_ENV} must use role {SETUP_ROLE!r}.")
    if not _matches_isolated_role(runtime_role, RUNTIME_ROLE):
        raise RuntimeError(f"{RUNTIME_DATABASE_ENV} must use role {RUNTIME_ROLE!r}.")
    database_name = _database_name(setup_url)
    if database_name.startswith("album_haven_ci_"):
        suffix = database_name.removeprefix("album_haven_ci_")
        if setup_role != f"{SETUP_ROLE}_{suffix}" or runtime_role != f"{RUNTIME_ROLE}_{suffix}":
            raise RuntimeError(
                "Isolated E2E database and role identities must share one job suffix."
            )
    if setup_role == runtime_role:
        raise RuntimeError("Isolated E2E setup and runtime database roles must differ.")
    return setup_url, runtime_url


def _connect(database_url: str) -> Any:
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as exc:
        raise RuntimeError("psycopg is required for isolated Postgres E2E runs.") from exc
    return psycopg.connect(database_url, row_factory=dict_row)


def _assert_connected_role(connection: Any, expected_role: str) -> None:
    row = connection.execute(
        "select current_database() as database_name, current_user as role_name"
    ).fetchone()
    database_name = str((row or {}).get("database_name") or "").casefold()
    role_name = str((row or {}).get("role_name") or "").casefold()
    expected_connected_role = expected_role
    if database_name.startswith("album_haven_ci_"):
        expected_connected_role = (
            f"{expected_role}_{database_name.removeprefix('album_haven_ci_')}"
        )
    if not _is_owned_isolated_database_name(database_name) or role_name != expected_connected_role:
        raise RuntimeError(
            "Connected Postgres identity does not match the isolated E2E contract: "
            f"database={database_name!r}, role={role_name!r}."
        )


def apply_all_migrations(setup_database_url: str) -> None:
    migrations_root = ROOT / "migrations" / "postgres"
    migration_paths = sorted(path for path in migrations_root.glob("*.sql") if path.is_file())
    if not migration_paths:
        raise RuntimeError(f"No Postgres migrations found under {migrations_root}.")
    with _connect(setup_database_url) as connection:
        _assert_connected_role(connection, SETUP_ROLE)
        for migration_path in migration_paths:
            connection.execute(migration_path.read_text(encoding="utf-8"))


def grant_runtime_role_privileges(
    setup_database_url: str,
    runtime_database_url: str,
) -> None:
    from psycopg import sql

    resolved_setup_url, resolved_runtime_url = resolve_isolated_database_urls(
        {
            SETUP_DATABASE_ENV: setup_database_url,
            RUNTIME_DATABASE_ENV: runtime_database_url,
        }
    )
    runtime_role = _database_role(resolved_runtime_url)
    if runtime_role == RUNTIME_ROLE:
        return
    with _connect(resolved_runtime_url) as runtime_connection:
        _assert_connected_role(runtime_connection, RUNTIME_ROLE)
        membership = runtime_connection.execute(
            "select pg_has_role(current_user, 'album_haven_app', 'MEMBER') as inherited"
        ).fetchone()
    if bool((membership or {}).get("inherited")):
        return

    statement = sql.SQL(
        """
        do $copy_app_privileges$
        declare
          privilege record;
        begin
          for privilege in
            select allowed.privilege_type, namespace.nspname as object_name
            from pg_catalog.pg_namespace namespace
            cross join (values ('USAGE'), ('CREATE')) allowed(privilege_type)
            where namespace.nspname not like 'pg\\_%' escape '\\'
              and namespace.nspname <> 'information_schema'
              and has_schema_privilege(
                'album_haven_app', namespace.oid, allowed.privilege_type
              )
          loop
            execute format(
              'grant %s on schema %I to %I',
              privilege.privilege_type,
              privilege.object_name,
              {runtime_role}
            );
          end loop;

          for privilege in
            select allowed.privilege_type, relation.oid::regclass as object_name
            from pg_catalog.pg_class relation
            join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
            cross join (
              values
                ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
            ) allowed(privilege_type)
            where namespace.nspname not like 'pg\\_%' escape '\\'
              and namespace.nspname <> 'information_schema'
              and relation.relkind in ('r','p','v','m','f')
              and has_table_privilege(
                'album_haven_app', relation.oid, allowed.privilege_type
              )
          loop
            execute format(
              'grant %s on table %s to %I',
              privilege.privilege_type,
              privilege.object_name,
              {runtime_role}
            );
          end loop;

          for privilege in
            select allowed.privilege_type, relation.oid::regclass as object_name
            from pg_catalog.pg_class relation
            join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
            cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) allowed(privilege_type)
            where namespace.nspname not like 'pg\\_%' escape '\\'
              and namespace.nspname <> 'information_schema'
              and relation.relkind='S'
              and has_sequence_privilege(
                'album_haven_app', relation.oid, allowed.privilege_type
              )
          loop
            execute format(
              'grant %s on sequence %s to %I',
              privilege.privilege_type,
              privilege.object_name,
              {runtime_role}
            );
          end loop;

          for privilege in
            select allowed.privilege_type, routine.oid::regprocedure as object_name
            from pg_catalog.pg_proc routine
            join pg_catalog.pg_namespace namespace on namespace.oid=routine.pronamespace
            cross join (values ('EXECUTE')) allowed(privilege_type)
            where namespace.nspname not like 'pg\\_%' escape '\\'
              and namespace.nspname <> 'information_schema'
              and has_function_privilege(
                'album_haven_app', routine.oid, allowed.privilege_type
              )
          loop
            execute format(
              'grant %s on function %s to %I',
              privilege.privilege_type,
              privilege.object_name,
              {runtime_role}
            );
          end loop;
        end
        $copy_app_privileges$;
        """
    ).format(runtime_role=sql.Literal(runtime_role))
    with _connect(resolved_setup_url) as connection:
        _assert_connected_role(connection, SETUP_ROLE)
        connection.execute(statement)


def _reset_owned_table_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        row
        for row in rows
        if (str(row["schemaname"]), str(row["tablename"]))
        not in _MIGRATION_OWNED_TABLES
    ]


def reset_application_tables(setup_database_url: str) -> None:
    from psycopg import sql

    with _connect(setup_database_url) as connection:
        _assert_connected_role(connection, SETUP_ROLE)
        rows = connection.execute(
            """
            select schemaname, tablename
            from pg_catalog.pg_tables
            where schemaname = any(%s)
            order by schemaname, tablename
            """,
            (list(_APPLICATION_SCHEMAS),),
        ).fetchall()
        reset_owned_rows = _reset_owned_table_rows(rows)
        qualified_tables = [
            sql.SQL(".").join(
                (sql.Identifier(row["schemaname"]), sql.Identifier(row["tablename"]))
            )
            for row in reset_owned_rows
        ]
        if not qualified_tables:
            return
        connection.execute(
            sql.SQL("truncate table {} restart identity cascade").format(
                sql.SQL(", ").join(qualified_tables)
            )
        )


def seed_bootstrap_owner_and_library(setup_database_url: str) -> None:
    with _connect(setup_database_url) as connection:
        _assert_connected_role(connection, SETUP_ROLE)
        connection.execute(
            """
            with owner_account as (
              insert into app.accounts (display_name, account_kind, metadata)
              values (
                'Isolated E2E Owner',
                'bootstrap_owner',
                '{"source":"isolated_e2e_launcher"}'::jsonb
              )
              returning id
            ),
            bootstrap_owner as (
              insert into app.bootstrap_owners (account_id, owner_key, metadata)
              select id, 'local-bootstrap-owner', '{"source":"isolated_e2e_launcher"}'::jsonb
              from owner_account
              returning account_id
            )
            insert into library.libraries (owner_account_id, name, library_kind, metadata)
            select
              account_id,
              'Local Library',
              'local',
              '{"source":"isolated_e2e_launcher"}'::jsonb
            from bootstrap_owner
            """
        )


def assert_runtime_connection(runtime_database_url: str) -> None:
    with _connect(runtime_database_url) as connection:
        _assert_connected_role(connection, RUNTIME_ROLE)


def assert_runtime_grants(runtime_database_url: str) -> None:
    with _connect(runtime_database_url) as connection:
        _assert_connected_role(connection, RUNTIME_ROLE)
        table_rows = connection.execute(
            """
            select
              required.schema_name,
              required.table_name,
              privilege.privilege_type,
              has_table_privilege(
                current_user,
                format('%%I.%%I', required.schema_name, required.table_name),
                privilege.privilege_type
              ) as granted
            from unnest(%s::text[], %s::text[]) as required(schema_name, table_name)
            cross join unnest(%s::text[]) as privilege(privilege_type)
            order by required.schema_name, required.table_name, privilege.privilege_type
            """,
            (
                [schema_name for schema_name, _ in _RUNTIME_DELETE_TABLES],
                [table_name for _, table_name in _RUNTIME_DELETE_TABLES],
                list(_REQUIRED_TABLE_PRIVILEGES + _DENIED_TABLE_PRIVILEGES),
            ),
        ).fetchall()
        boundary_row = connection.execute(
            """
            select
              has_schema_privilege(current_user, 'integration', 'USAGE') as integration_schema_usage,
              not has_schema_privilege(current_user, 'integration', 'CREATE') as integration_schema_create_denied,
              has_schema_privilege(current_user, 'library', 'USAGE') as library_schema_usage,
              not has_schema_privilege(current_user, 'library', 'CREATE') as library_schema_create_denied,
              has_schema_privilege(current_user, 'ops', 'USAGE') as ops_schema_usage,
              not has_schema_privilege(current_user, 'ops', 'CREATE') as ops_schema_create_denied,
              has_sequence_privilege(current_user, 'ops.cover_lookup_tasks_id_seq', 'USAGE') as sequence_usage,
              has_sequence_privilege(current_user, 'ops.cover_lookup_tasks_id_seq', 'SELECT') as sequence_select,
              not has_sequence_privilege(current_user, 'ops.cover_lookup_tasks_id_seq', 'UPDATE') as sequence_update_denied
            """
        ).fetchone()
    expected_table_checks = {
        (schema_name, table_name, privilege): privilege in _REQUIRED_TABLE_PRIVILEGES
        for schema_name, table_name in _RUNTIME_DELETE_TABLES
        for privilege in _REQUIRED_TABLE_PRIVILEGES + _DENIED_TABLE_PRIVILEGES
    }
    actual_table_checks = {
        (
            str(row.get("schema_name") or ""),
            str(row.get("table_name") or ""),
            str(row.get("privilege_type") or "").upper(),
        ): bool(row.get("granted"))
        for row in table_rows
    }
    failures = []
    for key, expected_granted in expected_table_checks.items():
        actual_granted = actual_table_checks.get(key)
        if actual_granted is not expected_granted:
            schema_name, table_name, privilege = key
            suffix = "" if expected_granted else " denied"
            failures.append(f"{schema_name}.{table_name} {privilege}{suffix}")

    boundary_checks = {
        "integration schema USAGE": "integration_schema_usage",
        "integration schema CREATE denied": "integration_schema_create_denied",
        "library schema USAGE": "library_schema_usage",
        "library schema CREATE denied": "library_schema_create_denied",
        "ops schema USAGE": "ops_schema_usage",
        "ops schema CREATE denied": "ops_schema_create_denied",
        "cover lookup sequence USAGE": "sequence_usage",
        "cover lookup sequence SELECT": "sequence_select",
        "cover lookup sequence UPDATE denied": "sequence_update_denied",
    }
    failures.extend(
        label
        for label, key in boundary_checks.items()
        if not bool((boundary_row or {}).get(key))
    )
    if failures:
        raise RuntimeError(
            f"Runtime Postgres grants are incomplete or overbroad for {RUNTIME_ROLE}: "
            + ", ".join(failures)
            + "."
        )


def prepare_isolated_database(setup_database_url: str, runtime_database_url: str) -> None:
    reset_application_tables(setup_database_url)
    apply_all_migrations(setup_database_url)
    grant_runtime_role_privileges(setup_database_url, runtime_database_url)
    seed_bootstrap_owner_and_library(setup_database_url)
    assert_runtime_connection(runtime_database_url)
    assert_runtime_grants(runtime_database_url)
