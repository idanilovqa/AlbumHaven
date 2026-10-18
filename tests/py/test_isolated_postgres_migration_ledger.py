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


class CaptureResetConnection:
    def __init__(self, *, migrated=True, occupied=False, rows=None):
        self.migrated=migrated;self.occupied=occupied
        self.rows=[] if rows is None else rows
        self.inserts=0;self.queries=[];self.role_checked=False

    def __enter__(self):return self
    def __exit__(self,*args):pass

    def execute(self,sql,params=None):
        assert self.role_checked
        query=' '.join(sql.lower().split());self.queries.append(query)
        if 'to_regclass' in query:
            return Result([{'name':'integration.playback_capture_budget' if self.migrated else None}])
        if query.startswith('select exists('):return Result([{'occupied':self.occupied}])
        if query.startswith('select id,account_id,'):return Result(self.rows)
        if query.startswith('insert into integration.playback_capture_budget'):
            self.inserts+=1;self.rows=[capture_budget_row()];return Result([])
        raise AssertionError(query)


def capture_budget_row():
    return dict(id=1,account_id=None,is_global=True,reserved_bytes=0,rate_tokens=8,finite=True)


def setup_capture_reset(monkeypatch,connection):
    monkeypatch.setattr(isolated,'_connect',lambda url:connection)
    def check_role(actual,role):
        assert actual is connection and role==isolated.SETUP_ROLE
        actual.role_checked=True
    monkeypatch.setattr(isolated,'_assert_connected_role',check_role)


def test_initial_migration_global_budget_is_preserved_without_insert(monkeypatch):
    connection=CaptureResetConnection(rows=[capture_budget_row()]);setup_capture_reset(monkeypatch,connection)
    isolated.restore_empty_capture_budget_after_reset('owned-test-url')
    assert connection.inserts==0 and connection.rows==[capture_budget_row()]


def test_reused_database_reset_restores_exactly_one_zero_global_budget(monkeypatch):
    connection=CaptureResetConnection();setup_capture_reset(monkeypatch,connection)
    isolated.restore_empty_capture_budget_after_reset('owned-test-url')
    isolated.restore_empty_capture_budget_after_reset('owned-test-url')
    assert connection.inserts==1 and connection.rows==[capture_budget_row()]


@pytest.mark.parametrize('change',['capture_rows','additional_budget','account_budget','nonzero','spent_tokens','infinite'])
def test_reset_rejects_unexpected_capture_state_without_repair(monkeypatch,change):
    row=capture_budget_row();rows=[row]
    if change=='additional_budget':rows.append(dict(row,id=2))
    elif change=='account_budget':row.update(account_id=7,is_global=False)
    elif change=='nonzero':row['reserved_bytes']=256
    elif change=='spent_tokens':row['rate_tokens']=7
    elif change=='infinite':row['finite']=False
    connection=CaptureResetConnection(occupied=change=='capture_rows',rows=rows)
    setup_capture_reset(monkeypatch,connection)
    with pytest.raises(RuntimeError):isolated.restore_empty_capture_budget_after_reset('owned-test-url')
    assert connection.inserts==0


def test_older_partial_migration_fixture_does_not_create_capture_schema(monkeypatch):
    connection=CaptureResetConnection(migrated=False);setup_capture_reset(monkeypatch,connection)
    isolated.restore_empty_capture_budget_after_reset('owned-test-url')
    assert connection.inserts==0 and len(connection.queries)==1


def test_supported_prepare_restores_only_after_reset_and_migration_completion(monkeypatch):
    calls=[]
    for name in ('reset_application_tables','apply_all_migrations','restore_empty_capture_budget_after_reset',
                 'grant_runtime_role_privileges','seed_bootstrap_owner_and_library',
                 'assert_runtime_connection','assert_runtime_grants'):
        monkeypatch.setattr(isolated,name,lambda *args,owned_name=name:calls.append(owned_name))
    isolated.prepare_isolated_database('setup-owned','runtime-owned')
    assert calls==['reset_application_tables','apply_all_migrations','restore_empty_capture_budget_after_reset',
                   'grant_runtime_role_privileges','seed_bootstrap_owner_and_library',
                   'assert_runtime_connection','assert_runtime_grants']
