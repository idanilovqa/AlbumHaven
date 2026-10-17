"""Fail-closed history checks and real-Postgres scope migration regressions.

Live cases use the existing disposable-database contract and a clearly synthetic
minimal index fixture. They are not the pinned media fixture profile or a full
application migration inventory.
"""
from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts import postgres_migration_compatibility as compatibility
from tests.e2e.support import isolatedPostgres as isolated


ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "migrations" / "postgres"
LEGACY = "0081_scope_track_preferences_by_library.sql"
LEGACY_SHA256 = "90e9ebdc18257df4f85df8da2a6e312fdda81b844dfed6f856792d345eed1d23"
MAIN = "0081_grant_move_policy_settings_delete.sql"
FORWARD = "0087_reconcile_track_preferences_library_scope.sql"
VERIFIER = ROOT / "scripts" / "postgres" / "verify_track_preferences_scope.sql"


def _checksum(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class _Result:
    def __init__(self, rows):
        self.rows = list(rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return list(self.rows)


class _ScopeConnection:
    def __init__(self, state, *, tuple_rows=False):
        self.state = state
        self.tuple_rows = tuple_rows
        self.queries = []

    def execute(self, sql, params=None):
        self.queries.append((str(sql), params))
        assert "album_haven_track_preferences_scope_v1" in str(sql)
        assert params is None
        if self.state is None:
            return _Result([])
        row = (self.state,) if self.tuple_rows else {"scope_state": self.state}
        return _Result([row])


@pytest.fixture
def inventory(tmp_path):
    directory = tmp_path / "migrations" / "postgres"
    (directory / "legacy").mkdir(parents=True)
    for name in (MAIN, FORWARD):
        (directory / name).write_bytes((MIGRATIONS / name).read_bytes())
    (directory / "legacy" / LEGACY).write_bytes((MIGRATIONS / "legacy" / LEGACY).read_bytes())
    verifier = tmp_path / "scripts" / "postgres" / VERIFIER.name
    verifier.parent.mkdir(parents=True)
    verifier.write_bytes(VERIFIER.read_bytes())
    return directory


def _history(directory, *, main=False, home=False, forward=False):
    result = {}
    if main:
        result[MAIN] = _checksum(directory / MAIN)
    if home:
        result[LEGACY] = LEGACY_SHA256
    if forward:
        result[FORWARD] = _checksum(directory / FORWARD)
    return result


@pytest.mark.parametrize(
    ("main", "home", "forward", "state"),
    [(False, False, False, "legacy"), (True, False, False, "legacy"),
     (False, True, False, "scoped"), (True, True, False, "scoped"),
     (True, False, True, "scoped"), (True, True, True, "scoped")],
    ids=["clean-scope", "main-only", "home-only", "both", "repeat-main", "repeat-both"],
)
@pytest.mark.parametrize("tuple_rows", [False, True], ids=["mapping", "tuple"])
def test_known_history_matches_exact_scope_without_rewriting_ledger(
    inventory, main, home, forward, state, tuple_rows,
):
    applied = _history(inventory, main=main, home=home, forward=forward)
    before = dict(applied)
    connection = _ScopeConnection(state, tuple_rows=tuple_rows)
    compatibility.validate_applied_migrations(connection, inventory, applied)
    assert applied == before
    assert len(connection.queries) == 1


@pytest.mark.parametrize("name", [MAIN, LEGACY, FORWARD])
def test_bad_checksum_rejected_before_any_schema_query(inventory, name):
    connection = _ScopeConnection("scoped")
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        compatibility.validate_applied_migrations(connection, inventory, {name: "0" * 64})
    assert connection.queries == []


@pytest.mark.parametrize("archive_state", ["missing", "modified"])
def test_legacy_archive_is_mandatory_exact_evidence(inventory, archive_state):
    archived = inventory / "legacy" / LEGACY
    if archive_state == "missing":
        archived.unlink()
    else:
        archived.write_bytes(archived.read_bytes() + b"\n-- changed\n")
    connection = _ScopeConnection("scoped")
    with pytest.raises(RuntimeError, match="Legacy migration checksum mismatch"):
        compatibility.validate_applied_migrations(connection, inventory, {LEGACY: LEGACY_SHA256})
    assert connection.queries == []


@pytest.mark.parametrize("unknown", ["0081_scope_track_preferences.sql", "0081_unrecognized.sql", "9999_future.sql"])
def test_unknown_history_is_not_silently_grandfathered(inventory, unknown):
    connection = _ScopeConnection("legacy")
    with pytest.raises(RuntimeError, match="Unknown applied migration"):
        compatibility.validate_applied_migrations(connection, inventory, {unknown: LEGACY_SHA256})
    assert connection.queries == []


def test_legacy_sql_cannot_reenter_active_ordinal_inventory(inventory):
    (inventory / LEGACY).write_bytes((inventory / "legacy" / LEGACY).read_bytes())
    connection = _ScopeConnection("scoped")
    with pytest.raises(RuntimeError, match="must not be an active migration"):
        compatibility.validate_applied_migrations(connection, inventory, {})
    assert connection.queries == []


@pytest.mark.parametrize(
    ("home", "forward", "state"),
    [(False, False, "scoped"), (True, False, "legacy"), (False, True, "legacy"),
     (False, False, "mismatched"), (True, False, "mismatched"),
     (False, True, "mismatched"), (False, False, None), (True, False, "unknown")],
)
def test_incompatible_or_incomplete_scope_fails_closed(inventory, home, forward, state):
    connection = _ScopeConnection(state)
    with pytest.raises(RuntimeError, match="Incompatible track preference index state"):
        compatibility.validate_applied_migrations(
            connection, inventory, _history(inventory, home=home, forward=forward),
        )
    assert len(connection.queries) == 1


def test_missing_verifier_never_implies_compatible_schema(inventory):
    (inventory.parents[1] / "scripts" / "postgres" / VERIFIER.name).unlink()
    connection = _ScopeConnection("legacy")
    with pytest.raises(RuntimeError, match="verifier is missing"):
        compatibility.validate_applied_migrations(connection, inventory, {})
    assert connection.queries == []


def test_generic_minimal_migration_fixture_does_not_require_app_scope(inventory):
    (inventory / FORWARD).unlink()
    connection = _ScopeConnection("must not query")
    compatibility.validate_applied_migrations(connection, inventory, _history(inventory, main=True))
    assert connection.queries == []


class _LedgerConnection:
    """Only allow ledger reads; any premature pending SQL fails the test."""
    def __init__(self, applied, *, tuple_rows=False):
        self.applied = applied
        self.tuple_rows = tuple_rows
        self.queries = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=None):
        query = " ".join(str(sql).split()).lower()
        self.queries.append(query)
        if "to_regclass('ops.schema_migrations')" in query:
            return _Result([("ops.schema_migrations",)] if self.tuple_rows else [{"migration_table": "ops.schema_migrations"}])
        if query == "select migration_name, checksum from ops.schema_migrations":
            return _Result(list(self.applied.items()) if self.tuple_rows else [
                {"migration_name": name, "checksum": checksum} for name, checksum in self.applied.items()
            ])
        raise AssertionError("Pending SQL ran before migration-history validation: " + query)


@pytest.mark.parametrize("runner", ["isolated", "demo"])
def test_each_runner_validates_all_history_before_pending_sql(inventory, monkeypatch, runner):
    connection = _LedgerConnection({"0081_unknown_legacy.sql": LEGACY_SHA256}, tuple_rows=runner == "demo")
    if runner == "isolated":
        monkeypatch.setattr(isolated, "ROOT", inventory.parents[1])
        monkeypatch.setattr(isolated, "_connect", lambda _url: connection)
        monkeypatch.setattr(isolated, "_assert_connected_role", lambda *_args: None)
        run = lambda: isolated.apply_migrations("postgresql://owned", [inventory / FORWARD])
    else:
        spec = importlib.util.spec_from_file_location("scope_compat_demo", ROOT / "scripts/render_capabilities_demo.py")
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        monkeypatch.setattr(module, "ROOT", inventory.parents[1])
        run = lambda: module.migrate(connection)
    with pytest.raises(RuntimeError, match="Unknown applied migration"):
        run()
    assert len(connection.queries) == 2


@pytest.fixture
def empty_scope_database(monkeypatch):
    from tests.py.test_isolated_postgres_live import (
        _dedicated_database_urls_or_skip, _drop_application_schemas,
    )

    setup_url, _ = _dedicated_database_urls_or_skip(monkeypatch)
    ownership = isolated.IsolatedDatabaseOwnershipLock(database_url=setup_url)
    ownership.acquire()
    try:
        _drop_application_schemas(setup_url)
        yield SimpleNamespace(setup_url=setup_url)
    finally:
        try:
            _drop_application_schemas(setup_url)
        finally:
            ownership.release()


@pytest.fixture
def scope_database(empty_scope_database):
    setup_url = empty_scope_database.setup_url
    with isolated._connect(setup_url) as connection:
        connection.execute("""
            create schema app;
            create schema ops;
            create table ops.schema_migrations (
                migration_name text primary key, checksum text not null,
                applied_at timestamptz not null default now()
            );
            create table app.track_preferences (
                id bigint generated always as identity primary key,
                account_id bigint not null, library_id bigint, track_key text not null,
                rating integer, metadata jsonb not null default '{}'::jsonb
            );
            create unique index track_preferences_account_track_key_idx
                on app.track_preferences (account_id, track_key);
            insert into app.track_preferences (account_id, library_id, track_key, rating, metadata)
                values (1, 10, 'synthetic-track', 4, '{"retained":true}'),
                       (1, null, 'synthetic-unscoped', 2, '{"retained":true}');
        """)
    return empty_scope_database


def _scope_state(connection):
    return connection.execute(VERIFIER.read_text(encoding="utf-8")).fetchone()["scope_state"]


def _ledger(connection):
    return connection.execute("select * from ops.schema_migrations order by migration_name").fetchall()


def _record(connection, name, checksum):
    connection.execute("insert into ops.schema_migrations (migration_name, checksum) values (%s, %s)", (name, checksum))


@pytest.mark.parametrize("history", ["clean-scope", "main-only", "home-only", "both"])
def test_live_forward_preserves_rows_history_and_repeat_behavior(scope_database, history):
    url = scope_database.setup_url
    with isolated._connect(url) as connection:
        if history in {"main-only", "both"}:
            _record(connection, MAIN, _checksum(MIGRATIONS / MAIN))
        if history in {"home-only", "both"}:
            connection.execute((MIGRATIONS / "legacy" / LEGACY).read_text(encoding="utf-8"))
            _record(connection, LEGACY, LEGACY_SHA256)
        before_rows = connection.execute("select * from app.track_preferences order by id").fetchall()
        before_history = _ledger(connection)
    isolated.apply_migrations(url, [MIGRATIONS / FORWARD])
    with isolated._connect(url) as connection:
        assert _scope_state(connection) == "scoped"
        assert connection.execute("select * from app.track_preferences order by id").fetchall() == before_rows
        first_history = _ledger(connection)
        assert [row for row in first_history if row["migration_name"] != FORWARD] == before_history
        assert next(row for row in first_history if row["migration_name"] == FORWARD)["checksum"] == _checksum(MIGRATIONS / FORWARD)
    isolated.apply_migrations(url, [MIGRATIONS / FORWARD])
    with isolated._connect(url) as connection:
        assert _ledger(connection) == first_history
        assert _scope_state(connection) == "scoped"
        assert connection.execute("select * from app.track_preferences order by id").fetchall() == before_rows
        connection.execute("insert into app.track_preferences (account_id, library_id, track_key) values (1, 11, 'synthetic-track')")
        import psycopg
        with pytest.raises(psycopg.errors.UniqueViolation), connection.transaction():
            connection.execute("insert into app.track_preferences (account_id, library_id, track_key) values (1, null, 'synthetic-unscoped')")


@pytest.mark.parametrize("replacement", [
    "",
    "create index track_preferences_account_track_key_idx on app.track_preferences (account_id, track_key)",
    "create unique index track_preferences_account_track_key_idx on app.track_preferences (track_key, account_id)",
    "create unique index track_preferences_account_track_key_idx on app.track_preferences (account_id, track_key) where library_id is not null",
    "create unique index track_preferences_account_track_key_idx on app.track_preferences (account_id, track_key) include (rating)",
    "create unique index track_preferences_account_track_key_idx on app.track_preferences (account_id, track_key text_pattern_ops)",
    "create unique index track_preferences_account_track_key_idx on app.track_preferences (account_id, track_key) nulls not distinct",
], ids=["missing", "nonunique", "wrong-order", "partial", "include", "wrong-opclass", "wrong-null-contract"])
def test_live_wrong_or_partial_index_fails_before_forward(scope_database, replacement):
    url = scope_database.setup_url
    with isolated._connect(url) as connection:
        connection.execute("drop index app.track_preferences_account_track_key_idx")
        if replacement:
            connection.execute(replacement)
        assert _scope_state(connection) == "mismatched"
        before = connection.execute("select * from app.track_preferences order by id").fetchall()
    with pytest.raises(RuntimeError, match="Incompatible track preference index state"):
        isolated.apply_migrations(url, [MIGRATIONS / FORWARD])
    with isolated._connect(url) as connection:
        assert _ledger(connection) == []
        assert _scope_state(connection) == "mismatched"
        assert connection.execute("select * from app.track_preferences order by id").fetchall() == before


@pytest.mark.parametrize("extra", [
    "create unique index track_preferences_account_library_track_key_idx on app.track_preferences (account_id, library_id, track_key) nulls not distinct",
    "create unique index unrecognized_taste_uniqueness on app.track_preferences (account_id, track_key)",
], ids=["both-indexes", "extra-uniqueness"])
def test_live_ambiguous_index_inventory_is_rejected(scope_database, extra):
    with isolated._connect(scope_database.setup_url) as connection:
        connection.execute(extra)
        assert _scope_state(connection) == "mismatched"
    with pytest.raises(RuntimeError, match="Incompatible track preference index state"):
        isolated.apply_migrations(scope_database.setup_url, [MIGRATIONS / FORWARD])


@pytest.mark.parametrize("target_shape", ["wrong-type", "not-null", "missing"])
def test_live_wrong_target_library_shape_cannot_be_recorded_as_scoped(scope_database, target_shape):
    import psycopg
    url = scope_database.setup_url
    with isolated._connect(url) as connection:
        if target_shape == "wrong-type":
            connection.execute("alter table app.track_preferences alter column library_id type integer")
        elif target_shape == "not-null":
            connection.execute("delete from app.track_preferences where library_id is null")
            connection.execute("alter table app.track_preferences alter column library_id set not null")
        else:
            connection.execute("alter table app.track_preferences drop column library_id")
        before = connection.execute("select * from app.track_preferences order by id").fetchall()
    with pytest.raises((RuntimeError, psycopg.Error)):
        isolated.apply_migrations(url, [MIGRATIONS / FORWARD])
    with isolated._connect(url) as connection:
        assert _ledger(connection) == []
        assert connection.execute("select to_regclass('app.track_preferences_account_track_key_idx') as name").fetchone()["name"] is not None
        assert connection.execute("select to_regclass('app.track_preferences_account_library_track_key_idx') as name").fetchone()["name"] is None
        assert connection.execute("select * from app.track_preferences order by id").fetchall() == before


@pytest.mark.parametrize("history", ["legacy-checksum-mismatch", "unknown-legacy"])
def test_live_unrecognized_history_leaves_schema_and_rows_untouched(scope_database, history):
    url = scope_database.setup_url
    with isolated._connect(url) as connection:
        _record(connection, LEGACY if history == "legacy-checksum-mismatch" else "0081_unknown.sql", "0" * 64)
        before_history = _ledger(connection)
        before_rows = connection.execute("select * from app.track_preferences order by id").fetchall()
    with pytest.raises(RuntimeError, match="checksum mismatch|Unknown applied migration"):
        isolated.apply_migrations(url, [MIGRATIONS / FORWARD])
    with isolated._connect(url) as connection:
        assert _scope_state(connection) == "legacy"
        assert _ledger(connection) == before_history
        assert connection.execute("select * from app.track_preferences order by id").fetchall() == before_rows


def test_live_forward_and_ledger_rollback_atomically(scope_database):
    import psycopg
    url = scope_database.setup_url
    with isolated._connect(url) as connection:
        before_rows = connection.execute("select * from app.track_preferences order by id").fetchall()
    with pytest.raises(psycopg.errors.DivisionByZero):
        with isolated._connect(url) as connection:
            connection.execute((MIGRATIONS / FORWARD).read_text(encoding="utf-8"))
            assert _scope_state(connection) == "scoped"
            _record(connection, FORWARD, _checksum(MIGRATIONS / FORWARD))
            connection.execute("select 1 / 0")
    with isolated._connect(url) as connection:
        assert _scope_state(connection) == "legacy"
        assert _ledger(connection) == []
        assert connection.execute("select * from app.track_preferences order by id").fetchall() == before_rows


@pytest.mark.parametrize("index_sql", [
    "create unique index track_preferences_account_library_track_key_idx on app.track_preferences (account_id, library_id, track_key)",
    "create unique index track_preferences_account_library_track_key_idx on app.track_preferences (account_id, library_id, track_key) nulls not distinct where library_id is not null",
    "create unique index track_preferences_account_library_track_key_idx on app.track_preferences (account_id, track_key, library_id) nulls not distinct",
], ids=["nulls-distinct", "partial-scoped", "wrong-scoped-order"])
def test_live_home_history_with_wrong_scoped_index_blocks_pending_main(scope_database, index_sql):
    url = scope_database.setup_url
    with isolated._connect(url) as connection:
        connection.execute("drop index app.track_preferences_account_track_key_idx")
        connection.execute(index_sql)
        _record(connection, LEGACY, LEGACY_SHA256)
        before_history = _ledger(connection)
        before_rows = connection.execute("select * from app.track_preferences order by id").fetchall()
    # Main0081 targets library.move_policy_settings, deliberately absent in this
    # minimal fixture. Only a history preflight can produce this exact error
    # before attempting the pending main SQL.
    with pytest.raises(RuntimeError, match="Incompatible track preference index state"):
        isolated.apply_migrations(url, [MIGRATIONS / MAIN, MIGRATIONS / FORWARD])
    with isolated._connect(url) as connection:
        assert _scope_state(connection) == "mismatched"
        assert _ledger(connection) == before_history
        assert connection.execute("select * from app.track_preferences order by id").fetchall() == before_rows


def test_live_runner_rolls_back_forward_when_ledger_insert_fails(scope_database):
    import psycopg
    url = scope_database.setup_url
    with isolated._connect(url) as connection:
        connection.execute("""
            create function ops.reject_scope_ledger() returns trigger language plpgsql as $$
            begin
                if new.migration_name = '0087_reconcile_track_preferences_library_scope.sql' then
                    raise exception 'synthetic ledger failure';
                end if;
                return new;
            end $$;
            create trigger reject_scope_ledger before insert on ops.schema_migrations
                for each row execute function ops.reject_scope_ledger();
        """)
        before = connection.execute("select * from app.track_preferences order by id").fetchall()
    with pytest.raises(psycopg.errors.RaiseException, match="synthetic ledger failure"):
        isolated.apply_migrations(url, [MIGRATIONS / FORWARD])
    with isolated._connect(url) as connection:
        assert _scope_state(connection) == "legacy"
        assert _ledger(connection) == []
        assert connection.execute("select * from app.track_preferences order by id").fetchall() == before


def _seed_real_history_rows(connection):
    account = connection.execute("""
        insert into app.accounts (display_name, account_kind, username_display,
            username_normalized, contact_email, contact_email_normalized)
        values ('Synthetic Migration', 'managed_user', 'synthetic-migration',
            'synthetic-migration', 'synthetic-migration@example.test',
            'synthetic-migration@example.test') returning id
    """).fetchone()["id"]
    library = connection.execute("""
        insert into library.libraries (owner_account_id, name)
        values (%s, 'Synthetic Migration Library') returning id
    """, (account,)).fetchone()["id"]
    connection.execute("""
        insert into app.track_preferences (account_id, library_id, track_key, rating, metadata)
        values (%s, %s, 'synthetic-history-track', 4, '{"retained":true}'),
               (%s, null, 'synthetic-history-unscoped', 2, '{"retained":true}')
    """, (account, library, account))


@pytest.mark.parametrize("history", ["clean", "main-only", "home-only", "both"])
def test_live_complete_canonical_history_upgrade_and_repeat(empty_scope_database, history):
    url = empty_scope_database.setup_url
    paths = sorted(MIGRATIONS.glob("*.sql"))
    assert [int(path.name[:4]) for path in paths] == list(range(1, 88))
    home = history in {"home-only", "both"}
    if history == "clean":
        isolated.apply_all_migrations(url)
    else:
        cutoff = "0081_" if history == "home-only" else "0087_"
        prior = [path for path in paths if path.name < cutoff]
        assert len(prior) == (80 if history == "home-only" else 86)
        isolated.apply_migrations(url, prior)
    with isolated._connect(url) as connection:
        _seed_real_history_rows(connection)
        if home:
            connection.execute((MIGRATIONS / "legacy" / LEGACY).read_text(encoding="utf-8"))
            _record(connection, LEGACY, LEGACY_SHA256)
        before_rows = connection.execute("select * from app.track_preferences order by id").fetchall()
        before_history = _ledger(connection)
    isolated.apply_all_migrations(url)
    with isolated._connect(url) as connection:
        assert _scope_state(connection) == "scoped"
        assert connection.execute("select * from app.track_preferences order by id").fetchall() == before_rows
        upgraded = _ledger(connection)
        upgraded_by_name = {row["migration_name"]: row for row in upgraded}
        assert set(upgraded_by_name) == {path.name for path in paths} | ({LEGACY} if home else set())
        for path in paths:
            assert upgraded_by_name[path.name]["checksum"] == _checksum(path)
        for row in before_history:
            assert upgraded_by_name[row["migration_name"]] == row
    isolated.apply_all_migrations(url)
    with isolated._connect(url) as connection:
        assert _ledger(connection) == upgraded
        assert _scope_state(connection) == "scoped"
        assert connection.execute("select * from app.track_preferences order by id").fetchall() == before_rows
