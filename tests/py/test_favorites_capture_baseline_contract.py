"""Capture migration admission without importing product/config/DB fixtures."""
import ast
from datetime import datetime, timezone
from pathlib import Path

import pytest


SOURCE = Path(__file__).with_name('album_favorites_postgres_support.py')
CHILD_TABLES = ('session', 'checkpoint', 'run', 'anchor')


def source_tree():
    return ast.parse(SOURCE.read_text(encoding='utf-8'))


@pytest.fixture
def capture_state():
    definitions = [node for node in source_tree().body
                   if isinstance(node, ast.FunctionDef) and node.name == 'capture_budget_state']
    assert len(definitions) == 1
    namespace = {}
    exec(compile(ast.Module(body=definitions, type_ignores=[]), str(SOURCE), 'exec'), namespace)
    return namespace['capture_budget_state']


def pristine_row():
    return dict(id=17, account_id=None, is_global=True, reserved_bytes=0,
                rate_tokens=8, rate_updated_at=datetime(2026, 10, 1, tzinfo=timezone.utc), finite=True)


class Queries:
    def __init__(self, rows, occupied=False):
        self.rows, self.occupied, self.sql = rows, occupied, []

    def execute(self, sql):
        self.sql.append(sql)
        assert sql.lstrip().startswith('select '), 'Admission must never mutate'
        return self

    def fetchone(self):
        assert len(self.sql) == 1 and 'select exists(' in self.sql[-1]
        for table in CHILD_TABLES:
            assert 'integration.playback_capture_' + table in self.sql[-1]
        return {'occupied': self.occupied}

    def fetchall(self):
        assert len(self.sql) == 2
        assert 'from integration.playback_capture_budget' in self.sql[-1]
        assert 'isfinite(rate_updated_at)' in self.sql[-1]
        return self.rows


def test_pristine_singleton_is_read_only_and_snapshot_preserves_every_field(capture_state):
    row = pristine_row()
    con = Queries([row])
    snapshot = capture_state(con)
    assert snapshot == row and snapshot is not row
    assert len(con.sql) == 2
    row['rate_updated_at'] = datetime(2026, 10, 2, tzinfo=timezone.utc)
    assert snapshot != row


@pytest.mark.parametrize('change', [
    'missing', 'duplicate', 'account', 'not-global', 'nonzero', 'spent-tokens',
    'infinite-time', 'zero-id', 'negative-id', 'boolean-id',
])
def test_rejects_nonpristine_budget_without_mutation(capture_state, change):
    row = pristine_row()
    updates = {
        'account': ('account_id', 9), 'not-global': ('is_global', False),
        'nonzero': ('reserved_bytes', 256), 'spent-tokens': ('rate_tokens', 7),
        'infinite-time': ('finite', False), 'zero-id': ('id', 0),
        'negative-id': ('id', -1), 'boolean-id': ('id', True),
    }
    if change in updates:
        key, value = updates[change]
        row[key] = value
    rows = [] if change == 'missing' else [row, dict(row)] if change == 'duplicate' else [row]
    con = Queries(rows)
    with pytest.raises(RuntimeError, match='capture budget singleton'):
        capture_state(con)
    assert len(con.sql) == 2


def test_live_capture_rows_fail_before_budget_adoption(capture_state):
    con = Queries([pristine_row()], occupied=True)
    with pytest.raises(RuntimeError, match='Unexpected capture rows'):
        capture_state(con)
    assert len(con.sql) == 1


def test_bootstrap_counts_singleton_and_snapshots_before_first_write():
    tree = source_tree()
    owner = next(n for n in tree.body if isinstance(n, ast.ClassDef)
                 and n.name == 'BootstrapFavoritesDatabase')
    setup = next(n for n in owner.body if isinstance(n, ast.FunctionDef) and n.name == 'setup')
    expected = next(n.value for n in ast.walk(setup) if isinstance(n, ast.Assign)
                    and any(isinstance(t, ast.Name) and t.id == 'expected' for t in n.targets))
    pairs = {ast.literal_eval(k): v for k, v in zip(expected.keys, expected.values)}
    assert ast.literal_eval(pairs[('integration', 'playback_capture_budget')]) == 1
    assert all(('integration', 'playback_capture_' + table) not in pairs for table in CHILD_TABLES)
    source = ast.get_source_segment(SOURCE.read_text(encoding='utf-8'), setup)
    assert "expected.get(ident,0)" in source  # Unlisted child/unknown tables still require zero.
    assert 'Unknown mutable baseline prohibits test writes' in source
    assert source.index('self.capture_budget_baseline=capture_budget_state(con)') < source.index('insert into ')
    assert "ident==('app','activity_source_revisions')" in source
    assert source.count('playback_capture_budget') == 1  # Count entry only, no bypass exemption.


def test_cleanup_checks_exact_snapshot_before_and_after_owned_deletes():
    tree = source_tree()
    owner = next(n for n in tree.body if isinstance(n, ast.ClassDef)
                 and n.name == 'BootstrapFavoritesDatabase')
    cleanup = next(n for n in owner.body if isinstance(n, ast.FunctionDef) and n.name == 'cleanup')
    checks = [n for n in ast.walk(cleanup) if isinstance(n, ast.Assert)
              and 'capture_budget_state(con)' in ast.unparse(n.test)]
    assert len(checks) == 2
    for check in checks:
        assert ast.unparse(check.test) == 'capture_budget_state(con) == self.capture_budget_baseline'
    writes = [n.lineno for n in ast.walk(cleanup) if isinstance(n, ast.Call)
              and isinstance(n.func, ast.Attribute) and n.func.attr == 'execute'
              and n.args and isinstance(n.args[0], ast.Constant)
              and isinstance(n.args[0].value, str) and n.args[0].value.startswith('delete ')]
    assert writes and checks[0].lineno < min(writes) < max(writes) < checks[1].lineno
    assert all('playback_capture_' not in n.value for n in ast.walk(cleanup)
               if isinstance(n, ast.Constant) and isinstance(n.value, str))


def test_failed_setup_keeps_quarantine_and_never_releases_or_cleans_untrusted_rows():
    fixture = next(n for n in source_tree().body if isinstance(n, ast.FunctionDef)
                   and n.name == 'favorites_bootstrap_db')
    outer_try = next(n for n in fixture.body if isinstance(n, ast.Try))
    final_try = outer_try.finalbody[0]
    assert isinstance(final_try, ast.Try)
    incomplete = final_try.body[0]
    assert isinstance(incomplete, ast.If) and ast.unparse(incomplete.test) == 'not complete'
    assert ast.unparse(incomplete.body[0]) == 'registry.quarantine()'
    assert isinstance(incomplete.body[1], ast.Raise)
    assert ast.unparse(final_try.body[1]) == 'db.cleanup()'
    assert [ast.unparse(n) for n in final_try.orelse] == ['ownership.release()']
    assert [ast.unparse(n) for n in final_try.handlers[0].body] == ['registry.quarantine()', 'raise']
