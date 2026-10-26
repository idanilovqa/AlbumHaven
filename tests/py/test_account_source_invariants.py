"""Authored, not executed. Synthetic/pure assertions are not database evidence."""
import ast
from datetime import datetime, timedelta, timezone
import inspect
from pathlib import Path

import pytest
from music_app.services import foobar_default_source as subject
from music_app.services import foobar_account_authority as authority
from music_app.services.foobar_source_postgres import SourceUnavailable

REF = '7147f513-5981-482f-b280-73e0a1de125a'


def stream():
    now = datetime(2026, 10, 23, 7, 0, tzinfo=timezone.utc)
    return dict(source_ref=REF, revision=7, current_generation=20749,
                retired_through=20748, created_at=now-timedelta(hours=1),
                updated_at=now, clock_high_water=now, observed_at=now,
                isolation='read committed')


@pytest.mark.parametrize('field,value', [
    ('revision', True), ('revision', -1), ('revision', 2**63),
    ('current_generation', True), ('current_generation', 0),
    ('current_generation', 2**31), ('retired_through', True),
    ('retired_through', -1), ('retired_through', 20749),
    ('source_ref', '00000000-0000-4000-8000-000000000000'),
    ('isolation', 'repeatable read'), ('observed_at', None),
    ('created_at', datetime(2026, 10, 23)),
])
def test_stream_rejects_malformed_or_mismatched_rows(field, value):
    row = stream()
    row[field] = value
    with pytest.raises(SourceUnavailable):
        subject._stream([row], REF)


@pytest.mark.parametrize('rows', [[], (), None, [{}], [stream(), stream()]])
def test_stream_rejects_wrong_shape(rows):
    with pytest.raises(SourceUnavailable):
        subject._stream(rows, REF)


def test_stream_rejects_unknown_columns():
    row = stream()
    row['account_id'] = 2
    with pytest.raises(SourceUnavailable):
        subject._stream([row], REF)


@pytest.mark.parametrize('field', ['revision', 'retired_through'])
def test_touch_cannot_mutate_revision_or_retirement(field):
    previous = stream()
    current = dict(previous)
    current[field] += 1
    with pytest.raises(SourceUnavailable):
        subject._stream([current], REF, previous=previous)


@pytest.mark.parametrize('field', ['observed_at', 'clock_high_water', 'updated_at'])
def test_touch_rejects_backwards_time(field):
    previous = stream()
    current = dict(previous)
    current[field] -= timedelta(microseconds=1)
    with pytest.raises(SourceUnavailable):
        subject._stream([current], REF, previous=previous)


def test_touch_accepts_later_trigger_sample():
    previous = stream()
    current = dict(previous)
    current['updated_at'] += timedelta(microseconds=1)
    current['clock_high_water'] += timedelta(microseconds=2)
    current['observed_at'] += timedelta(microseconds=3)
    assert subject._stream([current], REF, previous=previous) is current


def test_old_entrypoint_has_no_v2_call_edge():
    text = inspect.getsource(subject.select_default_foobar_source)
    assert 'select_account_foobar_source' not in text
    assert 'current_account_transaction' not in text
    assert 'current_library_transaction' in text
    assert '_default_ref(live.actor.account_id, live.library_id)' in text or \
        '_default_ref(live.actor.account_id,live.library_id)' in text


def test_new_entrypoint_returns_after_transaction_exit():
    tree = ast.parse(inspect.getsource(subject.select_account_foobar_source))
    owners = [node for node in ast.walk(tree) if isinstance(node, ast.With)]
    assert len(owners) == 1
    assert not any(isinstance(node, ast.Return) for node in ast.walk(owners[0]))
    assert any(isinstance(node, ast.Return) for node in ast.walk(tree))
    assert '.commit(' not in inspect.getsource(subject.select_account_foobar_source)


def test_legacy_entrypoint_matches_frozen_baseline():
    # Local fixture has no product imports and catches even subtle accidental
    # edits to the legacy function. Candidate-only new imports may differ.
    baseline = Path(__file__).with_name('legacy_select_default_source.txt').read_text()
    assert ast.dump(ast.parse(inspect.getsource(subject.select_default_foobar_source))) == \
        ast.dump(ast.parse(baseline))


def test_v2_statements_are_bounded_account_only_and_cannot_mutate_ownership():
    assert 'limit 17' in subject._ACCOUNT_LIST.lower()
    assert 'for update of s' in subject._ACCOUNT_READ.lower()
    for sql in (subject._ACCOUNT_LIST, subject._ACCOUNT_READ,
                subject._ACCOUNT_INSERT, subject._ACCOUNT_TOUCH):
        assert sql.count('%b') == 1
        assert 'library' not in sql.lower()
        assert 'integration.foobar_import_streams_v2' in sql
        assert 'evidence_bytes' not in sql and 'prepared_bytes' not in sql
        assert 'delete ' not in sql.lower()
    touch = subject._ACCOUNT_TOUCH.replace(' ', '').lower()
    for forbidden in ('revision=', 'retired_through=', 'created_at=', 'is_default='):
        assert forbidden not in touch
    assert 'is_default' in subject._ACCOUNT_INSERT and 'true' in subject._ACCOUNT_INSERT


@pytest.mark.parametrize('failure', [None, 'fetch', 'close'])
def test_real_query_closes_cursor_and_propagates_fetch_or_close_failure(failure):
    class CursorFailure(RuntimeError):
        pass
    class Cursor:
        closed = False
        def fetchmany(self, maximum):
            assert maximum == 2
            if failure == 'fetch':
                raise CursorFailure()
            return [{'synthetic': True}]
        def close(self):
            self.closed = True
            if failure == 'close':
                raise CursorFailure()
    cursor = Cursor()
    class Connection:
        def execute(self, sql, args, *, binary):
            assert args == (b'[]',) and binary is True
            return cursor
    if failure:
        with pytest.raises(CursorFailure):
            subject._query(Connection(), 'synthetic statement', b'[]', maximum=1)
    else:
        assert subject._query(Connection(), 'synthetic statement', b'[]', maximum=1) == [{'synthetic': True}]
    assert cursor.closed


def test_stream_rejects_backwards_generation_without_other_row_mutation():
    previous = stream()
    previous['retired_through'] -= 2
    current = dict(previous)
    current['current_generation'] -= 1
    with pytest.raises(SourceUnavailable):
        subject._stream([current], REF, previous=previous)
