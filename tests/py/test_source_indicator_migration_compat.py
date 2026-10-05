"""The one historical migration rename must not replay SQL or rewrite ledgers."""
import hashlib
from pathlib import Path

import pytest
from scripts.migration_compat import source_indicator_ledger

ROOT = Path(__file__).resolve().parents[2]
OLD = '0080_library_source_indicators.sql'
NEW = '0082_library_source_indicators.sql'
CHECKSUM = 'e1a292e50a08e4043d2ce3ceda13b87ad90462deb898590c147bab492a01b5e1'


@pytest.mark.parametrize('source_name,ledger_names', [
    (NEW, (OLD,)), (OLD, (NEW,)), (NEW, (OLD, NEW)), (OLD, (OLD, NEW)),
    (NEW, (NEW,)), (OLD, (OLD,)), (NEW, ()),
])
def test_exact_alias_preserves_original_ledger(source_name, ledger_names):
    applied = {name: CHECKSUM for name in ledger_names}
    original = applied.copy()
    compatible = source_indicator_ledger(applied, {source_name: CHECKSUM})
    assert compatible == ({source_name: CHECKSUM} if ledger_names else {})
    assert applied == original


@pytest.mark.parametrize('source_name,ledger_name', [(NEW, OLD), (OLD, NEW), (NEW, NEW)])
@pytest.mark.parametrize('bad_source', [False, True])
def test_alias_checksum_conflicts_fail_closed(source_name, ledger_name, bad_source):
    with pytest.raises(RuntimeError, match='checksum'):
        source_indicator_ledger({ledger_name: CHECKSUM if bad_source else 'wrong'},
                      {source_name: 'wrong' if bad_source else CHECKSUM})


def test_unrelated_unknown_identity_is_not_removed():
    assert source_indicator_ledger({'9999_unknown.sql': 'x'}, {NEW: CHECKSUM}) == {'9999_unknown.sql': 'x'}


def test_alias_without_either_source_file_is_not_removed():
    assert source_indicator_ledger({OLD: CHECKSUM}, {}) == {OLD: CHECKSUM}


def test_canonical_migration_keeps_historical_bytes():
    path = ROOT / 'migrations' / 'postgres' / NEW
    assert path.is_file(), 'Missing canonical0082 migration'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == CHECKSUM
    assert not path.with_name(OLD).exists()


@pytest.mark.parametrize('source_name,ledger_name', [(NEW, OLD), (OLD, NEW)])
def test_demo_reader_does_not_replay_alias(tmp_path, monkeypatch, source_name, ledger_name):
    from scripts import render_capabilities_demo as demo

    class Connection:
        def execute(self, sql):
            assert sql in {
                "select to_regclass('ops.schema_migrations')",
                'select migration_name, checksum from ops.schema_migrations',
            }, 'Migration SQL or ledger writes must not execute'
            return self

        def fetchone(self):
            return ('ops.schema_migrations',)

        def fetchall(self):
            return [(ledger_name, CHECKSUM)]

    migration_root = tmp_path / 'migrations' / 'postgres'
    migration_root.mkdir(parents=True)
    (migration_root / source_name).write_bytes((ROOT / 'migrations' / 'postgres' / NEW).read_bytes())
    monkeypatch.setattr(demo, 'ROOT', tmp_path)
    demo.migrate(Connection())
