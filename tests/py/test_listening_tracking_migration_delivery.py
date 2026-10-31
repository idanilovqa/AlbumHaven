"""Tracking successor registration and transactional runner contracts (no DB)."""
import hashlib
import json
from types import SimpleNamespace

import pytest

from tests.e2e.support import isolatedPostgres as isolated
from tests.py.test_isolated_postgres_migration_ledger import LedgerConnection
from tests.py.listening_tracking_migration_support import (
    ROOT, NAME, INPUT_HASHES, assert_adoption_rejection, decode_inputs,
)


def test_tracking_storage_is_a_single_registered_successor_not_an_alias():
    paths = sorted((ROOT / 'migrations/postgres').glob('0169_*.sql'))
    assert [p.name for p in paths] == [NAME]
    body = paths[0].read_text(encoding='utf-8')
    assert body.strip()
    # This migration is atomic under both normal and isolated ledger runners.
    assert 'create index concurrently' not in body.casefold()


@pytest.fixture
def ledger(tmp_path, monkeypatch):
    directory = tmp_path / 'migrations/postgres'
    directory.mkdir(parents=True)
    paths = [directory / name for name in ('0168_fixture.sql', NAME)]
    for path in paths:
        path.write_text('-- fixture migration ' + path.name + '\n')
    connection = LedgerConnection()
    connection.ledger_exists = True
    connection.ledger[paths[0].name] = hashlib.sha256(paths[0].read_bytes()).hexdigest()
    monkeypatch.setattr(isolated, 'ROOT', tmp_path)
    monkeypatch.setattr(isolated, '_connect', lambda _url: connection)
    def check_role(actual, role):
        assert actual is connection and role == isolated.SETUP_ROLE
        connection.role_checked = True
    monkeypatch.setattr(isolated, '_assert_connected_role', check_role)
    return connection, paths


def test_successor_exact_bytes_are_recorded_and_repeat_is_noop(ledger):
    connection, paths = ledger
    isolated.apply_all_migrations('owned-unit-double')
    assert connection.ledger == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    before = (dict(connection.ledger), list(connection.applied))
    isolated.apply_all_migrations('owned-unit-double')
    assert (connection.ledger, connection.applied) == before


def test_wrong_successor_checksum_rejects_before_any_execution(ledger):
    connection, _ = ledger
    connection.ledger[NAME] = '0' * 64
    with pytest.raises(RuntimeError, match='checksum'):
        isolated.apply_all_migrations('owned-unit-double')
    assert not connection.applied


def test_successor_ledger_failure_rolls_back_ddl_and_ledger(ledger):
    connection, _ = ledger
    before = dict(connection.ledger)
    connection.fail_insert = True
    with pytest.raises(RuntimeError, match='ledger insert'):
        isolated.apply_all_migrations('owned-unit-double')
    assert connection.ledger == before and not connection.applied


@pytest.mark.parametrize('sqlstate,message,accepted', [
    ('P0001', 'Incompatible listening tracking catalog: columns', True),
    ('42601', 'syntax error', False), ('42P01', 'undefined relation', False),
    ('42501', 'permission denied', False), ('P0001', 'unrelated failure', False),
])
def test_negative_oracle_does_not_accept_incidental_failures(sqlstate, message, accepted):
    error = SimpleNamespace(sqlstate=sqlstate, diag=SimpleNamespace(message_primary=message))
    if accepted:
        assert_adoption_rejection(error)
    else:
        with pytest.raises(AssertionError):
            assert_adoption_rejection(error)


@pytest.mark.parametrize('mutation', ['missing', 'duplicate', 'unknown', 'changed-sql', 'extra-field', 'bad-version'])
def test_external_oracle_loader_rejects_untrusted_inputs(monkeypatch, mutation):
    # Tests only the loader; cannot override the real fixed oracle identities in
    # live qualification. Small synthetic inputs avoid embedding private SQL.
    expected = {key: hashlib.sha256(key.encode()).hexdigest() for key in INPUT_HASHES}
    monkeypatch.setattr('tests.py.listening_tracking_migration_support.INPUT_HASHES', expected)
    payload = {'schemaVersion': 1, 'inputs': [{'id': key, 'sql': key} for key in expected]}
    assert decode_inputs(json.dumps(payload)) == {key: key for key in expected}
    if mutation == 'missing': payload['inputs'].pop()
    elif mutation == 'duplicate': payload['inputs'][-1] = payload['inputs'][0]
    elif mutation == 'unknown': payload['inputs'][-1]['id'] = 'unknown'
    elif mutation == 'changed-sql': payload['inputs'][-1]['sql'] += ' '
    elif mutation == 'extra-field': payload['inputs'][-1]['path'] = '/untrusted'
    elif mutation == 'bad-version': payload['schemaVersion'] = True
    with pytest.raises(AssertionError):
        decode_inputs(json.dumps(payload))


def test_all_pre0169_migration_bytes_match_an_exact_independent_checkpoint():
    from tests.py.listening_tracking_migration_support import BASELINES
    inventory = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted((ROOT / 'migrations/postgres').glob('[0-9][0-9][0-9][0-9]_*.sql'))
        if int(p.name[:4]) < 169}
    actual = (max(int(name[:4]) for name in inventory), len(inventory),
              hashlib.sha256(json.dumps(inventory, sort_keys=True, separators=(',', ':')).encode()).hexdigest())
    assert actual in set(BASELINES.values()), 'Unrecognized or rewritten historical migration inventory'


class OperationalLedgerConnection(LedgerConnection):
    """Tuple-row unit double; role admission belongs to the owned live fixture.

    Reuse the existing atomic transaction/ledger failure model, but deliberately
    do not pretend this connection-only operational function checks login roles.
    """
    def execute(self, sql, params=None):
        from tests.py.test_isolated_postgres_migration_ledger import Result
        if str(sql).startswith('-- fixture migration'):
            self.applied.append(sql)
            return Result([])
        result = super().execute(sql, params)
        return Result([tuple(row.values()) if isinstance(row, dict) else row
                       for row in result.fetchall()])


@pytest.fixture
def operational_ledger(tmp_path, monkeypatch):
    from scripts import render_capabilities_demo as operational
    directory = tmp_path / 'migrations/postgres'
    directory.mkdir(parents=True)
    paths = [directory / name for name in ('0168_fixture.sql', NAME)]
    for path in paths:
        path.write_text('-- fixture migration ' + path.name + '\n')
    connection = OperationalLedgerConnection()
    connection.ledger_exists = True
    connection.ledger[paths[0].name] = hashlib.sha256(paths[0].read_bytes()).hexdigest()
    monkeypatch.setattr(operational, 'ROOT', tmp_path)
    return connection, paths, operational.migrate


def test_operational_function_records_exact_bytes_and_repeat_is_noop(operational_ledger):
    connection, paths, migrate = operational_ledger
    migrate(connection)
    assert connection.ledger == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    before = (dict(connection.ledger), list(connection.applied))
    migrate(connection)
    assert (connection.ledger, connection.applied) == before


def test_operational_function_wrong_checksum_rejects_before_execution(operational_ledger):
    connection, _, migrate = operational_ledger
    connection.ledger[NAME] = '0' * 64
    with pytest.raises(RuntimeError, match='checksum'):
        migrate(connection)
    assert not connection.applied


def test_operational_function_ledger_failure_rolls_back_ddl_and_ledger(operational_ledger):
    connection, _, migrate = operational_ledger
    before = dict(connection.ledger)
    connection.fail_insert = True
    with pytest.raises(RuntimeError, match='ledger insert'):
        migrate(connection)
    assert connection.ledger == before and not connection.applied
