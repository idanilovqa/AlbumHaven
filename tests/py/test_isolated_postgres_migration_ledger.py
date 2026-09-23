"""The isolated launcher respects the same migration checksum ledger as bootstrap."""
from contextlib import contextmanager
from copy import deepcopy
import hashlib

import pytest
from tests.e2e.support import isolatedPostgres as isolated


class Result:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class LedgerConnection:
    def __init__(self):
        self.ledger_exists = False
        self.ledger = {}
        self.applied = []
        self.fail_insert = False
        self.role_checked = False

    def __enter__(self):
        self.before = deepcopy((self.ledger_exists, self.ledger, self.applied))
        return self

    def __exit__(self, error_type, error, traceback):
        if error_type:
            self.ledger_exists, self.ledger, self.applied = self.before

    @contextmanager
    def transaction(self):
        before = deepcopy((self.ledger_exists, self.ledger, self.applied))
        try:
            yield
        except Exception:
            self.ledger_exists, self.ledger, self.applied = before
            raise

    def execute(self, sql, params=None):
        query = str(sql).lower()
        if 'to_regclass' in query:
            return Result([{'migration_table': 'ops.schema_migrations' if self.ledger_exists else None}])
        if query.lstrip().startswith('select') and 'ops.schema_migrations' in query:
            if params:
                name = params[0]
                return Result([{'migration_name': name, 'checksum': self.ledger[name]}] if name in self.ledger else [])
            return Result([{'migration_name': name, 'checksum': checksum} for name, checksum in self.ledger.items()])
        if 'insert into ops.schema_migrations' in query:
            if self.fail_insert:
                raise RuntimeError('ledger insert unavailable')
            self.ledger[params[0]] = params[1]
            return Result([])
        if query.startswith('-- fixture migration'):
            assert self.role_checked
            if 'bootstrap' in query:
                self.ledger_exists = True
            self.applied.append(sql)
            return Result([])
        raise AssertionError(f'Unexpected migration harness query: {sql}')


@pytest.fixture
def migration_store(tmp_path, monkeypatch):
    root = tmp_path / 'migrations' / 'postgres'
    root.mkdir(parents=True)
    first = root / '0001_bootstrap.sql'
    second = root / '0002_next.sql'
    first.write_text('-- fixture migration bootstrap\n')
    second.write_text('-- fixture migration next\n')
    connection = LedgerConnection()
    monkeypatch.setattr(isolated, 'ROOT', tmp_path)
    monkeypatch.setattr(isolated, '_connect', lambda _url: connection)
    def check_role(received, role):
        assert received is connection and role == isolated.SETUP_ROLE
        connection.role_checked = True
    monkeypatch.setattr(isolated, '_assert_connected_role', check_role)
    return connection, first, second


def test_pristine_bootstrap_records_exact_bytes_and_second_run_skips(migration_store):
    connection, first, second = migration_store
    isolated.apply_all_migrations('owned-test-url')
    assert connection.ledger == {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (first, second)}
    assert len(connection.applied) == 2
    isolated.apply_all_migrations('owned-test-url')
    assert len(connection.applied) == 2


def test_existing_checksum_mismatch_fails_before_pending_migration(migration_store):
    connection, first, _second = migration_store
    connection.ledger_exists = True
    connection.ledger[first.name] = 'wrong-checksum'
    with pytest.raises(RuntimeError, match='checksum'):
        isolated.apply_all_migrations('owned-test-url')
    assert connection.applied == []


def test_migration_and_ledger_insert_roll_back_together(migration_store):
    connection, first, _second = migration_store
    connection.ledger_exists = True
    connection.ledger[first.name] = hashlib.sha256(first.read_bytes()).hexdigest()
    connection.fail_insert = True
    with pytest.raises(RuntimeError, match='ledger insert'):
        isolated.apply_all_migrations('owned-test-url')
    assert connection.applied == []
    assert list(connection.ledger) == [first.name]
