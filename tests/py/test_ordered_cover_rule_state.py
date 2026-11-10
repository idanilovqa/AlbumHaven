"""Rule-state transaction composition; recording SQL is not live PostgreSQL proof."""
from contextlib import contextmanager
from copy import deepcopy

import pytest

from cover_unit_safety import cover_unit_transports  # noqa: F401
from music_app.services import scan_cache_persistence as persistence
from music_app.services.rule_state_postgres import RuleStatePostgresAdapter

A = '/synthetic/rule-state/a.flac'
B = '/synthetic/rule-state/b.flac'
METHODS = ['save_exception_overrides', 'upsert_exception_overrides']


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return deepcopy(self.rows[0]) if self.rows else None

    def fetchall(self):
        return deepcopy(self.rows)


class Connection:
    """Stage effects and inject query results/errors, never execute database SQL."""
    def __init__(self, *, ordered=False, failure=None):
        self.events = []
        self.operations = []
        self.failure = failure
        self.ordered = ordered
        self.entries = {p: {'album': 'Original', 'edition': '', 'exception_type': ''}
                        for p in (A, B)}
        self.scanned = {A: '', B: ''}
        self.durable = {'overrides': {}, 'revision': 7}
        self.staged = None
        self.affected_rows = None
        self.owner_result = None
        self.revision_result = 8
        self.inserts = 0

    def __enter__(self):
        self.events.append('connect')
        return self

    def __exit__(self, *args):
        self.events.append('close')

    @contextmanager
    def transaction(self):
        assert self.staged is None
        self.staged = deepcopy(self.durable)
        self.events.append('begin')
        try:
            yield
            self.event('commit')
            self.durable = deepcopy(self.staged)
        except BaseException:
            self.events.append('rollback')
            raise
        finally:
            self.staged = None

    def event(self, name):
        self.events.append(name)
        if self.failure == name:
            raise RuntimeError('injected ' + name)

    def execute(self, sql, params=None):
        assert self.staged is not None, 'Every query must share the transaction'
        sql = ' '.join(sql.lower().split())
        self.operations.append((sql, params))
        if 'pg_advisory_xact_lock' in sql:
            self.event('barrier')
        elif 'bootstrap_context_ready' in sql:
            self.event('bootstrap')
            return Cursor([{'bootstrap_context_ready': 1}])
        elif 'scanned_exception_type' in sql:
            self.event('affected')
            if self.affected_rows is not None:
                return Cursor(self.affected_rows)
            keys = params['override_keys']
            return Cursor([{'private_path': p, 'scanned_exception_type': value,
                            'ambiguous_override_binding': False, 'has_ordered_selection': self.ordered}
                           for p, value in self.scanned.items()
                           if p in keys or (params['replace'] and p in self.staged['overrides'])])
        elif 'resolved_entries' in sql:
            self.event('owner')
            result = self.owner_result if self.owner_result is not None else {
                'blocked_by_ordered_selection': False,
                'resolved_entries': [dict(private_path=p, album_id=72,
                                          previous_entry=deepcopy(self.entries[p]))
                                     for p in params['changed_paths']],
                'ordered_albums': [{'id': 72, 'title': 'Original', 'edition': ''}]
                                  if self.ordered else [],
            }
            return Cursor([result])
        elif 'insert into library.exception_overrides' in sql:
            self.inserts += 1
            self.event('insert' if self.inserts == 1 else 'second_insert')
            self.staged['overrides'][params[0]] = deepcopy(getattr(params[1], 'obj', params[1]))
        elif 'delete from library.exception_overrides' in sql:
            self.event('delete')
            keep = set(params[1]) if params else set()
            self.staged['overrides'] = {p: v for p, v in self.staged['overrides'].items() if p in keep}
        elif 'update library.libraries' in sql and 'inventory_mutation_revision' in sql:
            self.event('revision')
            self.staged['revision'] += 1
            return Cursor([{'inventory_mutation_revision': self.revision_result}])
        return Cursor([])


def run(connection, method, values):
    adapter = RuleStatePostgresAdapter(
        {'ALBUM_HAVEN_APP_DATABASE_URL': 'postgresql://unused.invalid/rule_state_unit'},
        connect=lambda _: connection)
    getattr(adapter, method)(values)


@pytest.mark.parametrize('method', METHODS)
def test_current_ordered_owner_blocks_before_exception_effects(method):
    connection = Connection(ordered=True)
    before = deepcopy(connection.durable)
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        run(connection, method, {A: 'Interview', B: 'Interview'})
    assert connection.durable == before
    assert connection.events == ['connect', 'begin', 'barrier', 'bootstrap', 'affected', 'owner', 'rollback', 'close']


@pytest.mark.parametrize('method', METHODS)
def test_legacy_write_commits_only_after_barrier_current_preflight_and_revision(method):
    connection = Connection()
    run(connection, method, {B: 'Interview', A: ' non-album rarity '})
    expected = ['connect', 'begin', 'barrier', 'bootstrap', 'affected', 'owner', 'insert', 'second_insert']
    if method == 'save_exception_overrides':
        expected.append('delete')
    assert connection.events == expected + ['revision', 'commit', 'close']
    assert connection.durable == {'overrides': {A: {'exception_type': 'Non-album rarity'}, B: {'exception_type': 'Interview'}}, 'revision': 8}


@pytest.mark.parametrize('method', METHODS)
@pytest.mark.parametrize('failure', ['barrier', 'bootstrap', 'affected', 'owner', 'second_insert', 'revision', 'commit'])
def test_failure_rolls_back_and_stops_later_effects(method, failure):
    connection = Connection(failure=failure)
    before = deepcopy(connection.durable)
    with pytest.raises(RuntimeError, match='injected ' + failure):
        run(connection, method, {A: 'Interview', B: 'Interview'})
    assert connection.durable == before
    assert connection.events[-3:] == [failure, 'rollback', 'close']


def test_replacement_delete_failure_rolls_back_preceding_upserts():
    connection = Connection(failure='delete')
    before = deepcopy(connection.durable)
    with pytest.raises(RuntimeError, match='injected delete'):
        run(connection, 'save_exception_overrides', {A: 'Interview', B: ''})
    assert connection.durable == before
    assert connection.events[-3:] == ['delete', 'rollback', 'close']


@pytest.mark.parametrize('method', METHODS)
@pytest.mark.parametrize('verdict', [{}, {'blocked_by_ordered_selection': True},
    {'blocked_by_ordered_selection': False, 'resolved_entries': [], 'ordered_albums': []},
    {'blocked_by_ordered_selection': False, 'resolved_entries': [], 'ordered_albums': [None]}])
def test_malformed_or_unresolved_owner_snapshot_fails_closed(method, verdict):
    connection = Connection()
    connection.owner_result = verdict
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        run(connection, method, {A: 'Interview', B: ''})
    assert not any(e in connection.events for e in ('insert', 'delete', 'revision', 'commit'))
    assert connection.events[-2:] == ['rollback', 'close']


@pytest.mark.parametrize('method', METHODS)
@pytest.mark.parametrize('revision', [None, 0])
def test_missing_revision_rolls_back_writes(method, revision):
    connection = Connection()
    connection.revision_result = revision
    before = deepcopy(connection.durable)
    with pytest.raises(RuntimeError, match='revision'):
        run(connection, method, {A: 'Interview', B: ''})
    assert connection.durable == before
    assert connection.events[-2:] == ['rollback', 'close']


def test_empty_upsert_does_not_connect():
    connection = Connection()
    run(connection, 'upsert_exception_overrides', {' ': 'Interview'})
    assert connection.events == []


def test_empty_replacement_checks_removed_override_before_deleting():
    connection = Connection(ordered=True)
    connection.scanned = {A: ''}
    connection.entries[A]['exception_type'] = 'Interview'
    connection.durable['overrides'][A] = {'exception_type': 'Interview'}
    before = deepcopy(connection.durable)
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        run(connection, 'save_exception_overrides', {})
    assert connection.durable == before
    assert 'delete' not in connection.events


def test_removed_override_restores_scanned_exception_not_blank():
    connection = Connection(ordered=True)
    connection.scanned = {A: 'Interview'}
    connection.entries[A]['exception_type'] = 'Compilation'
    connection.durable['overrides'][A] = {'exception_type': 'Compilation'}
    run(connection, 'save_exception_overrides', {})
    assert connection.durable == {'overrides': {}, 'revision': 8}
    assert connection.events.index('owner') < connection.events.index('delete')


@pytest.mark.parametrize('method', METHODS)
def test_inactive_legacy_override_key_remains_writable(method):
    connection = Connection(ordered=True)
    connection.scanned = {}
    run(connection, method, {A: 'Interview'})
    assert connection.durable['overrides'][A] == {'exception_type': 'Interview'}
    assert 'affected' in connection.events and 'owner' not in connection.events
    assert connection.durable['revision'] == 8


@pytest.mark.parametrize('method', METHODS)
def test_same_exception_membership_preserves_ordered_owner(method):
    connection = Connection(ordered=True)
    connection.entries[A]['exception_type'] = 'Compilation'
    run(connection, method, {A: 'Interview'})
    assert connection.durable['overrides'][A] == {'exception_type': 'Interview'}
    assert connection.durable['revision'] == 8


@pytest.mark.parametrize('method', METHODS)
def test_restoring_membership_into_ordered_destination_is_blocked(method):
    connection = Connection()
    connection.owner_result = {
        'blocked_by_ordered_selection': False,
        'resolved_entries': [{'private_path': A, 'album_id': None,
                              'previous_entry': {'album': 'Original', 'edition': '', 'exception_type': 'Interview'}}],
        'ordered_albums': [{'id': 73, 'title': 'Original', 'edition': ''}],
    }
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        run(connection, method, {A: ''})
    assert connection.events[-2:] == ['rollback', 'close']
    assert 'insert' not in connection.events


@pytest.mark.parametrize('method', METHODS)
@pytest.mark.parametrize('rows', [[{}], [{'private_path': None}],
    [{'private_path': A, 'scanned_exception_type': '',
      'ambiguous_override_binding': False, 'has_ordered_selection': False}] * 2])
def test_malformed_affected_file_rows_fail_before_effects(method, rows):
    connection = Connection()
    connection.affected_rows = rows
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        run(connection, method, {A: 'Interview'})
    assert not any(e in connection.events for e in ('insert', 'delete', 'revision', 'commit'))


@pytest.mark.parametrize('method', METHODS)
def test_affected_query_scopes_current_membership_and_replace_removals(method):
    connection = Connection()
    run(connection, method, {' ' + A + ' ': 'Interview'})
    queries = [(sql, params) for sql, params in connection.operations if 'scanned_exception_type' in sql]
    assert len(queries) == 1
    sql, params = queries[0]
    assert params == {'override_keys': [A], 'replace': method == 'save_exception_overrides'}
    assert 'app.bootstrap_owners' in sql and "'local-bootstrap-owner'" in sql
    assert "'local library'" in sql and "'local'" in sql
    assert 'scan_cache_stale is false' in sql
    assert 'library.exception_overrides' in sql
    assert 'override_keys' in sql and 'replace' in sql
    assert 'library_id' in sql and 'track_key' in sql


def test_empty_replacement_without_current_overrides_retains_legacy_clear_behavior():
    connection = Connection()
    run(connection, 'save_exception_overrides', {})
    assert connection.events == ['connect', 'begin', 'barrier', 'bootstrap', 'affected', 'delete', 'revision', 'commit', 'close']
    assert connection.durable == {'overrides': {}, 'revision': 8}


@pytest.mark.parametrize('method', METHODS)
def test_ambiguous_track_binding_is_blocked_with_ordered_owner(method):
    connection = Connection()
    connection.affected_rows = [{'private_path': A, 'scanned_exception_type': '',
                                 'ambiguous_override_binding': True, 'has_ordered_selection': True}]
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        run(connection, method, {A: 'Interview'})
    assert 'insert' not in connection.events and 'delete' not in connection.events
    assert connection.events[-2:] == ['rollback', 'close']


@pytest.mark.parametrize('method', METHODS)
def test_ambiguous_track_binding_without_ordered_owner_preserves_legacy_write(method):
    connection = Connection()
    connection.affected_rows = [{'private_path': A, 'scanned_exception_type': '',
                                 'ambiguous_override_binding': True, 'has_ordered_selection': False}]
    run(connection, method, {A: 'Interview'})
    assert connection.durable['overrides'][A] == {'exception_type': 'Interview'}
    assert connection.durable['revision'] == 8


def test_owner_query_does_not_filter_out_malformed_selected_cover_values():
    connection = Connection(ordered=True)
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        run(connection, 'upsert_exception_overrides', {A: 'Interview'})
    sql = next(sql for sql, _ in connection.operations if 'resolved_entries' in sql)
    # Presence is ownership even for null, empty, scalar or malformed saved sets.
    # SQL-shape assertion only: live JSONB evaluation belongs in PostgreSQL tests.
    assert "album.metadata ? 'selected_covers'" in sql
    assert 'jsonb_array_length' not in sql
    assert "jsonb_typeof(album.metadata -> 'selected_covers')" not in sql
    assert 'for update of album' in sql


def test_replacement_checks_omitted_owner_before_writing_allowed_submitted_key():
    connection = Connection(ordered=True)
    connection.entries[A]['exception_type'] = 'Interview'
    connection.entries[B]['exception_type'] = 'Compilation'
    connection.durable['overrides'] = {B: {'exception_type': 'Compilation'}}
    before = deepcopy(connection.durable)
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        run(connection, 'save_exception_overrides', {A: 'Interview'})
    assert connection.durable == before
    assert 'insert' not in connection.events and 'delete' not in connection.events


def test_upsert_does_not_guard_or_remove_unmentioned_override():
    connection = Connection(ordered=True)
    connection.entries[A]['exception_type'] = 'Interview'
    connection.entries[B]['exception_type'] = 'Compilation'
    connection.durable['overrides'] = {B: {'exception_type': 'Compilation'}}
    run(connection, 'upsert_exception_overrides', {A: 'Interview'})
    owner_params = next(params for sql, params in connection.operations if 'resolved_entries' in sql)
    assert owner_params['changed_paths'] == [A]
    assert connection.durable['overrides'][B] == {'exception_type': 'Compilation'}
    assert 'delete' not in connection.events


@pytest.mark.parametrize('field,value', [
    ('ambiguous_override_binding', None), ('ambiguous_override_binding', 0),
    ('has_ordered_selection', None), ('has_ordered_selection', 'false'),
    ('private_path', ' '), ('private_path', 17),
])
def test_affected_row_typed_fields_fail_closed(field, value):
    connection = Connection()
    row = {'private_path': A, 'scanned_exception_type': '',
           'ambiguous_override_binding': False, 'has_ordered_selection': False}
    row[field] = value
    connection.affected_rows = [row]
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        run(connection, 'upsert_exception_overrides', {A: 'Interview'})
    assert 'owner' not in connection.events and 'insert' not in connection.events


def test_missing_scan_baseline_cannot_be_guessed_for_replacement():
    connection = Connection()
    connection.affected_rows = [{'private_path': A, 'ambiguous_override_binding': False,
                                 'has_ordered_selection': False}]
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        run(connection, 'save_exception_overrides', {})
    assert 'delete' not in connection.events


def test_effective_override_priority_is_null_safe_and_path_first():
    sql = ' '.join(persistence._ordered_cover_edit_updates_conflict_sql().lower().split())
    assert 'order by case when candidate.track_key = files.private_path then 0 else 1 end' in sql
    assert 'candidate.updated_at desc, candidate.id desc' in sql
    assert 'order by (candidate.track_key = files.private_path) desc' not in sql


def test_null_track_key_fallback_is_classified_as_ambiguous():
    sql = ' '.join(persistence._ordered_cover_exception_override_paths_sql().lower().split())
    assert 'fallback.track_key is distinct from files.private_path' in sql
    assert 'fallback.track_key <> files.private_path' not in sql


class NullFallbackConnection(Connection):
    """Model only this fixture's two SQL priorities, not a PostgreSQL executor.

    DESC boolean ordering puts NULL ahead of TRUE by default. Native CASE
    priority instead puts the exact path ahead of a NULL-key same-track row.
    SQL-shape tests above separately bind this model to the intended query.
    """
    def execute(self, sql, params=None):
        text = ' '.join(sql.lower().split())
        if 'resolved_entries' in text:
            if 'order by (candidate.track_key = files.private_path) desc' in text:
                effective_exception = 'Interview'  # NULL-key fallback ranks first.
            elif 'order by case when candidate.track_key = files.private_path then 0 else 1 end' in text:
                effective_exception = ''  # Exact-path override ranks first.
            else:
                pytest.fail('Fixture does not model this override priority expression')
            self.entries[A]['exception_type'] = effective_exception
        return super().execute(sql, params)


def test_null_key_fallback_cannot_hide_ordered_membership_change():
    connection = NullFallbackConnection(ordered=True)
    # Exercise the reused owner guard directly: its completion/publication
    # callers do not pass through the RuleState ambiguity guard.
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        with connection.transaction():
            persistence.assert_ordered_cover_edit_updates_allowed(connection, {A: {'exception_type': 'Interview'}})
    assert connection.events == ['begin', 'owner', 'rollback']


@pytest.mark.parametrize('method', METHODS)
def test_null_key_same_track_override_blocks_rule_state_before_any_effect(method):
    connection = Connection(ordered=True)
    # Controlled query result: a NULL-key same-track fallback is an ambiguous
    # non-path binding even when an exact-path override is also present.
    connection.affected_rows = [{'private_path': A, 'scanned_exception_type': '',
                                 'ambiguous_override_binding': True, 'has_ordered_selection': True}]
    connection.durable['overrides'][A] = {'exception_type': ''}
    before = deepcopy(connection.durable)
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        run(connection, method, {A: 'Interview'})
    assert connection.durable == before
    assert connection.events == ['connect', 'begin', 'barrier', 'bootstrap', 'affected', 'rollback', 'close']
