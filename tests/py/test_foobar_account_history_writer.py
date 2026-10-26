"""AUTHORED ONLY. Actual Prepare/Apply/source hook/finalizer/authority composition.

Known SQL result storage is controlled; no source/projection success, matching,
account authority, writer, finalizer or application receipt is substituted.
"""
from copy import deepcopy
from dataclasses import replace
import inspect
import json
import pytest
from tests.py.foobar_account_history_testing import (
    install, install_existing_genuine, prepare, apply, listed, writer, readiness, codec,
    p, a, f, authority, account_authority, requested_context, SOURCE, URL, CAPACITY,
    payload, FIRST, LAST, digest, materialize,
)
from tests.py.test_foobar_account_existing_chain import (
    prepare as prepare_existing, apply as apply_existing, payload as old_payload,
)
from tests.py.foobar_account_history_driver import current_source


def current_projection(db):
    assert len(db.history_projections) == 1
    scope, stored = next(iter(db.history_projections.items()))
    source, revision = current_source(db, scope[2])
    row = dict(stored, current_revision=revision,
        current_effective_sha256=digest(bytes.fromhex(source[6])), current_display_sha256=digest(bytes.fromhex(source[7])))
    return writer.decode_bound_projection(row), stored


def state(db):
    names = ('receipt', 'receipts', 'keys', 'key_scopes', 'key_times', 'revision',
             'source_rows', 'source_versions', 'history', 'bindings', 'tastes', 'history_projections')
    return deepcopy(tuple(getattr(db, name) for name in names))


def test_actual_apply_commits_source_projection_then_reads_same_current_history(monkeypatch):
    db = install(monkeypatch)
    data = payload(play_count=2, first_played=FIRST, last_played=LAST,
        play_count_enhanced=7, first_played_enhanced=FIRST, last_played_enhanced=LAST)
    command, receipt = prepare(db, library=None, payload=data)
    apply_command, result = apply(db, command, receipt)
    value, stored = current_projection(db)
    assert value.source_revision == db.revision == 1
    assert (value.standard.total, value.enhanced.total) == (2, 7)
    assert stored['projection_sha256'] == digest(stored['projection_bytes'])
    assert db.calls.index(p.source._insert_revisions_sql()) < db.calls.index(writer._UPSERT_SQL)
    assert db.calls.index(writer._UPSERT_SQL) < db.calls.index(writer._VERIFY_SQL) < db.calls.index(f._COMMIT_SQL)
    assert not db.history and not db.bindings and not db.native_calls
    page = listed(db)
    assert len(page.items) == 2 and all(item.projection == value for item in page.items)
    assert [item.kind for item in page.items] == ['unknown_dates_bucket', 'first_boundary']
    assert p.current_foobar_import_transaction is authority.current_foobar_import_transaction
    assert any('from app.account_sessions' in sql for sql in db.calls)
    before = state(db); writes = db.calls.count(writer._UPSERT_SQL)
    replay = a.apply_foobar_import(URL, requested_context(None), command=apply_command, intake_capacity=CAPACITY)
    assert replay == result and state(db) == before and db.calls.count(writer._UPSERT_SQL) == writes


@pytest.mark.parametrize('failure', ['schema', 'upsert', 'verify', 'finalizer'])
def test_actual_apply_late_failure_rolls_back_projection_source_receipt_and_revision(monkeypatch, failure):
    db = install(monkeypatch)
    command, receipt = prepare(db, library=7)
    before = state(db)
    db.fail_sql = {'schema': readiness._SCHEMA_SQL, 'upsert': writer._UPSERT_SQL,
        'verify': writer._VERIFY_SQL, 'finalizer': f._COMMIT_SQL}[failure]
    with pytest.raises(p.SourceUnavailable):
        apply(db, command, receipt)
    assert state(db) == before and db.rollbacks
    if failure == 'schema':
        assert p.source._insert_revisions_sql() not in db.calls
    if failure == 'finalizer':
        assert writer._UPSERT_SQL in db.calls and p.taste._foobar_taste_write_sql() in db.calls
    assert not db.history_projections and not db.source_rows
    assert db.receipt['state'] == 'ready'


def test_postwrite_source_hash_corruption_is_not_accepted_by_projection_hook(monkeypatch):
    db = install(monkeypatch)
    command, receipt = prepare(db, library=None)
    def corrupt(current, sql):
        if sql == writer._UPSERT_SQL:
            next(iter(current.history_projections.values()))['effective_evidence_sha256'] = '0' * 64
    db.history_after = corrupt
    before = state(db)
    with pytest.raises(p.SourceUnavailable): apply(db, command, receipt)
    assert state(db) == before and not db.history_projections
    assert f._COMMIT_SQL not in db.calls


def test_exit_session_revocation_rolls_back_after_genuine_projection_and_finalizer(monkeypatch):
    db = install(monkeypatch)
    command, receipt = prepare(db, library=None)
    before = state(db)
    def revoke(current, sql):
        if sql == writer._VERIFY_SQL: current.sessions[(1, 3)] = False
    db.history_after = revoke
    with pytest.raises(a.FoobarApplyCommitUncertain): apply(db, command, receipt)
    assert state(db) == before and writer._UPSERT_SQL in db.calls
    assert f._COMMIT_SQL in db.calls and db.rollbacks


def test_origin_only_noop_keeps_original_effective_raw_digest_projection_and_revision(monkeypatch):
    db = install_existing_genuine(monkeypatch)
    unused, unused_receipt, unused_original, command = prepare_existing(db, old_payload(19), 1)
    apply_existing(command)
    value, stored = current_projection(db)
    before_projection = deepcopy(stored)
    before_source = deepcopy(db.source_row)
    before_revision = db.revision
    unused, unused_receipt, original, command = prepare_existing(db, old_payload(19, b'ignored-new-origin'), 2)
    assert bytes.fromhex(original[2][0][6]) != bytes.fromhex(before_source[8])
    count = db.calls.count(writer._UPSERT_SQL)
    result = apply_existing(command)
    current, stored = current_projection(db)
    assert stored == before_projection and current == value and db.source_row == before_source
    assert db.revision == before_revision and len(db.revisions) == 1
    assert db.calls.count(writer._UPSERT_SQL) == count
    assert db.calls.count(writer._VERIFY_SQL) == 2
    assert json.loads(result.terminal_bytes)[16:23] == [1, 0, 0, 0, 0, 0, 0]


def test_raw_only_revision_updates_projection_binding_without_replacing_effective_evidence(monkeypatch):
    db = install_existing_genuine(monkeypatch)
    unused, unused_receipt, unused_original, command = prepare_existing(db, old_payload(19), 1)
    apply_existing(command)
    old, stored = current_projection(db)
    effective, display = bytes.fromhex(db.source_row[6]), bytes.fromhex(db.source_row[7])
    unused, unused_receipt, unused_original, command = prepare_existing(db, old_payload('N/A'), 2)
    apply_existing(command)
    current, stored = current_projection(db)
    assert current.source_revision == db.observation_revision == 2 and current.standard.total == 19
    assert current.effective_evidence_sha256 == old.effective_evidence_sha256 == digest(effective)
    assert current.display_sha256 == old.display_sha256 == digest(display)
    assert bytes.fromhex(db.source_row[6]) == effective and bytes.fromhex(db.source_row[7]) == display
    assert bytes.fromhex(db.source_row[8]) != bytes.fromhex(db.revisions[1][8])
    assert db.calls.count(writer._UPSERT_SQL) == 2 and len(db.history_projections) == 1


def test_actual_lower_then_zero_correction_replaces_projection_not_earlier_source_revisions(monkeypatch):
    db = install_existing_genuine(monkeypatch)
    expected = []
    for number, count in enumerate((19, 2, 0), 1):
        unused, unused_receipt, unused_original, command = prepare_existing(db, old_payload(count), number)
        apply_existing(command)
        current, stored = current_projection(db)
        assert current.source_revision == number and current.standard.total == count
        assert current.standard.aggregate_remainder == count  # No first boundary supplied.
        assert len(db.history_projections) == 1 and len(db.revisions) == number
        expected.append(count)
        assert [p.evidence.decode_evidence(bytes.fromhex(db.revisions[r][6]))[
            p.parser.FIELD_NAMES.index('play_count')][2] for r in range(1, number + 1)] == expected
    assert db.observation_inserts == 1 and db.calls.count(writer._UPSERT_SQL) == 3


def test_semantic_noop_missing_projection_is_unavailable_never_rebuilt_from_incoming_origins(monkeypatch):
    db = install_existing_genuine(monkeypatch)
    unused, unused_receipt, unused_original, command = prepare_existing(db, old_payload(19), 1)
    apply_existing(command)
    unused, unused_receipt, unused_original, command = prepare_existing(db, old_payload(19, b'new'), 2)
    db.history_projections.clear()
    source = deepcopy(db.source_row); count = db.calls.count(writer._UPSERT_SQL)
    with pytest.raises(p.SourceUnavailable): apply_existing(command)
    assert db.source_row == source and db.revision == 1 and not db.history_projections
    assert db.calls.count(writer._UPSERT_SQL) == count


def test_projection_hook_is_inside_real_source_savepoint_after_exact_postcheck():
    source = inspect.getsource(p.source.write_foobar_source_on_connection)
    order = ['with connection.transaction():', 'require_foobar_history_on_connection(connection, for_write=True)',
        '_insert_observations_sql()', '_insert_revisions_sql()', '_advance_pointers_sql()',
        'postcheck=True', 'history.maintain_current_history_on_connection(']
    assert [source.index(token) for token in order] == sorted(source.index(token) for token in order)
    tail = source[source.index('history.maintain_current_history_on_connection('):]
    assert tail.index('_authority(live_context, constraints)') < tail.index('return outcomes')
    hook = inspect.getsource(writer.maintain_current_history_on_connection)
    assert 'if change:' in hook and hook.index('if change:') < hook.index('codec.build_account_history_projection')
    assert hook.index('_UPSERT_SQL') < hook.index('_VERIFY_SQL')
    assert not any(token in hook for token in ('commit(', 'pooled_connection', 'lastfm', 'library_id', 'events'))
    assert 'r.evidence_sha256=decode(j->>4' in writer._UPSERT_SQL
    assert 'r.display_sha256=decode(j->>5' in writer._UPSERT_SQL
    assert 'o.current_revision' in writer._UPSERT_SQL and 'o.current_revision' in writer._VERIFY_SQL
