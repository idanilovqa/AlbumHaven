"""Regression coverage for migrations that cannot run in a transaction."""

from __future__ import annotations

from contextlib import contextmanager

import pytest

from tests.e2e.support import isolatedPostgres as isolated


_READY_0083_INDEX_CONTRACT = {
    "table": "library.local_albums",
    "expression": "lower(btrim(coalesce(metadata->>'artists','')))",
    "access-method": "gin",
    "opclass": "library.gin_trgm_ops",
    "uniqueness": False,
    "predicate": None,
}


class _Result:
    def __init__(self, rows=()):
        self._rows = list(rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class _ConcurrentMigrationConnection:
    def __init__(
        self,
        *,
        fail_concurrent_once: bool = False,
        index_contract: dict[str, object] | None = None,
    ) -> None:
        self._autocommit = False
        self.in_transaction = False
        self.ledger_exists = False
        self.ledger: dict[str, str] = {}
        self.index_exists = False
        self.index_ready = False
        self.fail_concurrent_once = fail_concurrent_once
        self.index_contract = dict(index_contract) if index_contract is not None else None
        self.events: list[str] = []

    @property
    def autocommit(self) -> bool:
        return self._autocommit

    @autocommit.setter
    def autocommit(self, value: bool) -> None:
        if self.in_transaction:
            raise RuntimeError("autocommit changed during a transaction")
        self._autocommit = bool(value)
        self.events.append(f"autocommit={self._autocommit}")

    def __enter__(self):
        return self

    def __exit__(self, error_type, _error, _traceback):
        if error_type is None:
            self.commit()
        return False

    def commit(self) -> None:
        self.events.append("commit")
        self.in_transaction = False

    @contextmanager
    def transaction(self):
        yield

    def execute(self, sql, params=None):
        query = " ".join(str(sql).split()).lower()
        if not self.autocommit:
            self.in_transaction = True
        if "select current_database()" in query:
            return _Result(
                [{"database_name": "album_haven_scan_e2e", "role_name": isolated.SETUP_ROLE}]
            )
        if "to_regclass('ops.schema_migrations')" in query:
            return _Result(
                [{"migration_table": "ops.schema_migrations" if self.ledger_exists else None}]
            )
        if query.startswith("select") and "ops.schema_migrations" in query:
            return _Result(
                [
                    {"migration_name": name, "checksum": checksum}
                    for name, checksum in self.ledger.items()
                ]
            )
        if "insert into ops.schema_migrations" in query:
            self.ledger[str(params[0])] = str(params[1])
            self.events.append(f"ledger:{params[0]}")
            return _Result()
        if "album_haven_0083_index_contract_v1" in query:
            if not self.index_exists or self.index_contract is None:
                state = "missing"
                event = "index-contract:missing"
            else:
                mismatches = [
                    dimension
                    for dimension, expected in _READY_0083_INDEX_CONTRACT.items()
                    if self.index_contract.get(dimension) != expected
                ]
                state = "mismatched" if mismatches else "ready"
                event = (
                    f"index-contract:mismatched:{','.join(mismatches)}"
                    if mismatches
                    else "index-contract:ready"
                )
            self.events.append(event)
            return _Result([{"index_state": state}])
        if "from pg_catalog.pg_index" in query:
            if not self.index_exists:
                return _Result()
            return _Result([{"indisvalid": self.index_ready, "indisready": self.index_ready}])
        if "create index concurrently" in query:
            if not self.autocommit:
                raise RuntimeError("CREATE INDEX CONCURRENTLY cannot run inside a transaction block")
            if self.fail_concurrent_once:
                self.fail_concurrent_once = False
                self.index_exists = True
                self.events.append("concurrent-index-failed")
                raise RuntimeError("simulated concurrent index failure")
            if self.index_exists:
                self.events.append("concurrent-index-exists")
                return _Result()
            self.index_exists = True
            self.index_ready = True
            self.index_contract = dict(_READY_0083_INDEX_CONTRACT)
            self.events.append("concurrent-index")
            return _Result()
        if "drop index concurrently if exists" in query:
            self.index_exists = False
            self.index_ready = False
            self.index_contract = None
            self.events.append("drop-concurrent-index")
            return _Result()
        if "create table ops.schema_migrations" in query:
            self.ledger_exists = True
            return _Result()
        raise AssertionError(f"Unexpected SQL: {sql}")


def test_isolated_migrator_runs_concurrent_index_outside_transaction_and_validates_it(
    tmp_path,
    monkeypatch,
):
    migrations_root = tmp_path / "migrations" / "postgres"
    migrations_root.mkdir(parents=True)
    (migrations_root / "0001_bootstrap.sql").write_text(
        "create table ops.schema_migrations (migration_name text, checksum text);",
        encoding="utf-8",
    )
    concurrent_path = migrations_root / "0002_concurrent_index.sql"
    concurrent_path.write_text(
        "create index concurrently if not exists fixture_idx on fixture_table (id);",
        encoding="utf-8",
    )
    connection = _ConcurrentMigrationConnection()
    monkeypatch.setattr(isolated, "ROOT", tmp_path)
    monkeypatch.setattr(isolated, "_connect", lambda _database_url: connection)

    isolated.apply_all_migrations("postgresql://owned")

    assert connection.index_ready is True
    assert concurrent_path.name in connection.ledger
    assert connection.events.index("commit") < connection.events.index("autocommit=True")
    assert connection.events.index("autocommit=True") < connection.events.index("concurrent-index")
    assert connection.events.index("concurrent-index") < connection.events.index("autocommit=False")


def test_isolated_migrator_cleans_failed_concurrent_index_before_retry(
    tmp_path,
    monkeypatch,
):
    migrations_root = tmp_path / "migrations" / "postgres"
    migrations_root.mkdir(parents=True)
    (migrations_root / "0001_bootstrap.sql").write_text(
        "create table ops.schema_migrations (migration_name text, checksum text);",
        encoding="utf-8",
    )
    concurrent_path = migrations_root / "0002_concurrent_index.sql"
    concurrent_path.write_text(
        "create index concurrently if not exists fixture_idx on fixture_table (id);",
        encoding="utf-8",
    )
    connection = _ConcurrentMigrationConnection(fail_concurrent_once=True)
    monkeypatch.setattr(isolated, "ROOT", tmp_path)
    monkeypatch.setattr(isolated, "_connect", lambda _database_url: connection)

    with pytest.raises(RuntimeError, match="simulated concurrent index failure"):
        isolated.apply_all_migrations("postgresql://owned")

    assert connection.index_exists is False
    isolated.apply_all_migrations("postgresql://owned")

    assert connection.index_ready is True
    assert concurrent_path.name in connection.ledger
    assert connection.events.count("concurrent-index-failed") == 1
    assert connection.events.count("drop-concurrent-index") == 1


def test_isolated_migrator_can_apply_and_ledger_an_aggregate_upgrade_in_stages(
    tmp_path,
    monkeypatch,
):
    migrations_root = tmp_path / "migrations" / "postgres"
    migrations_root.mkdir(parents=True)
    bootstrap_path = migrations_root / "0001_bootstrap.sql"
    bootstrap_path.write_text(
        "create table ops.schema_migrations (migration_name text, checksum text);",
        encoding="utf-8",
    )
    concurrent_path = migrations_root / "0002_concurrent_index.sql"
    concurrent_path.write_text(
        "create index concurrently if not exists fixture_idx on fixture_table (id);",
        encoding="utf-8",
    )
    connection = _ConcurrentMigrationConnection()
    monkeypatch.setattr(isolated, "_connect", lambda _database_url: connection)

    isolated.apply_migrations("postgresql://owned", [bootstrap_path])
    isolated.apply_migrations("postgresql://owned", [concurrent_path])

    assert set(connection.ledger) == {bootstrap_path.name, concurrent_path.name}
    assert connection.index_ready is True
    assert connection.events.index("autocommit=True") < connection.events.index(
        "concurrent-index"
    )
    assert connection.events.index("concurrent-index") < connection.events.index(
        "autocommit=False"
    )


@pytest.mark.parametrize(
    ("wrong_dimension", "wrong_value"),
    [
        ("table", "library.local_tracks"),
        ("expression", "lower(metadata::text)"),
        ("access-method", "btree"),
        ("opclass", "pg_catalog.text_ops"),
        ("uniqueness", True),
        ("predicate", "metadata is not null"),
    ],
)
def test_isolated_migrator_rebuilds_same_name_wrong_0083_index_before_ledger(
    tmp_path,
    monkeypatch,
    wrong_dimension,
    wrong_value,
):
    migrations_root = tmp_path / "migrations" / "postgres"
    migrations_root.mkdir(parents=True)
    (migrations_root / "0001_bootstrap.sql").write_text(
        "create table ops.schema_migrations (migration_name text, checksum text);",
        encoding="utf-8",
    )
    migration_path = migrations_root / "0083_add_album_raw_artist_search_index.sql"
    migration_path.write_text(
        "create index concurrently if not exists "
        "local_albums_normalized_raw_artists_trgm_idx "
        "on library.local_albums using gin ((lower(metadata::text)) library.gin_trgm_ops);",
        encoding="utf-8",
    )
    verifier = (
        tmp_path
        / "scripts"
        / "postgres"
        / "verify_0083_album_raw_artist_index.sql"
    )
    verifier.parent.mkdir(parents=True)
    verifier.write_text(
        "-- album_haven_0083_index_contract_v1\nselect 'ready';\n",
        encoding="utf-8",
    )
    wrong_contract = {**_READY_0083_INDEX_CONTRACT, wrong_dimension: wrong_value}
    connection = _ConcurrentMigrationConnection(index_contract=wrong_contract)
    connection.ledger_exists = True
    connection.index_exists = True
    connection.index_ready = True
    monkeypatch.setattr(isolated, "ROOT", tmp_path)
    monkeypatch.setattr(isolated, "_connect", lambda _database_url: connection)

    isolated.apply_migrations("postgresql://owned", [migration_path])

    assert connection.events.index(
        f"index-contract:mismatched:{wrong_dimension}"
    ) < connection.events.index(
        "drop-concurrent-index"
    )
    assert connection.events.index("drop-concurrent-index") < connection.events.index(
        "concurrent-index"
    )
    assert connection.events.index("index-contract:ready") < connection.events.index(
        f"ledger:{migration_path.name}"
    )
    assert migration_path.name in connection.ledger


def test_live_appearance_aggregate_upgrade_uses_staged_migration_runner() -> None:
    source_path = (
        isolated.ROOT / "tests" / "py" / "test_appearance_migration_live.py"
    )
    source = source_path.read_text(encoding="utf-8")
    aggregate = source[
        source.index("def test_live_legacy_selection_accent_survives_aggregate_upgrade") :
        source.index("def test_live_parchment_pine_migration_preserves_all_existing_preferences")
    ]

    assert "isolatedPostgres.apply_migrations(setup_url, legacy)" in aggregate
    assert "isolatedPostgres.apply_migrations(setup_url, upgrade)" in aggregate
    assert "connection.execute(path.read_text(encoding=\"utf-8\"))" not in aggregate
