"""Sealed source ordering and explicit bounds without a database simulator."""
from contextlib import contextmanager
from types import SimpleNamespace
import pytest
from psycopg.pq import TransactionStatus
from music_app.services.home_activity import ActivityQuery, ActivityScope, HomeActivityError
from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
from music_app.services.allowed_actions import AllowedActions
from tests.py.owned_playlist_testing import Connection, Step, NOW

REFS = ['activity_' + digit * 64 for digit in '123']


def setup_reader(monkeypatch, rows, *, total=None):
    reader = HomeActivityPostgresRepository({})
    @contextmanager
    def snapshot(*args):
        yield {'id': 7, 'total_rows': len(rows) if total is None else total, 'relationship_revision': None}, 's' * 43, None
    monkeypatch.setattr(reader, '_validated_snapshot', snapshot)
    connection = Connection([Step('from app.activity_snapshot_rows', rows, clauses=('order by ordinal',))] if rows else [])
    connection.info = SimpleNamespace(transaction_status=TransactionStatus.INTRANS)
    return reader, connection


def read(reader, connection, refs, *, ordinary=False):
    method = reader.read_selection if ordinary else reader.read_missing_selection
    return method(connection, scope=ActivityScope(41, 8, 73),
        query=ActivityQuery(kind='tracks', period='week', snapshot_ref='s' * 43),
        row_refs=refs, allowed_actions_for_resource=lambda *a: AllowedActions(('library.browse.read',)), now=NOW)


def rows():
    return [{'row_key': f'track:{i}', 'payload': {'id': ref, 'title': f'Track {i}'}} for i, ref in enumerate(REFS, 1)]


@pytest.mark.parametrize('selection', [None, list(reversed(REFS))])
def test_full_and_selected_missing_capture_preserve_snapshot_order(monkeypatch, selection):
    reader, connection = setup_reader(monkeypatch, rows())
    assert [entry['row_ref'] for entry in read(reader, connection, selection)] == REFS
    connection.done()


def test_ordinary_selection_keeps_its_existing_user_order(monkeypatch):
    reader, connection = setup_reader(monkeypatch, rows())
    assert [entry['row_ref'] for entry in read(reader, connection, list(reversed(REFS)), ordinary=True)] == list(reversed(REFS))
    connection.done()


def test_oversized_full_snapshot_fails_before_any_row_query(monkeypatch):
    reader, connection = setup_reader(monkeypatch, [], total=5001)
    with pytest.raises(HomeActivityError) as result:
        read(reader, connection, None)
    assert result.value.status_code == 413
    assert not connection.operations


def test_row_limit_defends_against_inconsistent_snapshot_count(monkeypatch):
    stored = [{'row_key': f'track:{i}', 'payload': {'id': 'activity_' + f'{i:064x}'}} for i in range(5001)]
    reader, connection = setup_reader(monkeypatch, stored, total=5000)
    with pytest.raises(HomeActivityError) as result:
        read(reader, connection, None)
    assert result.value.status_code == 413
    connection.done()


@pytest.mark.parametrize('refs', [[], [REFS[0], REFS[0]], ['arbitrary'], REFS * 1667])
def test_invalid_selected_occurrences_fail_before_receipt_query(monkeypatch, refs):
    reader, connection = setup_reader(monkeypatch, [])
    with pytest.raises(HomeActivityError):
        read(reader, connection, refs)
    assert not connection.operations


def test_selected_row_outside_snapshot_fails_closed(monkeypatch):
    reader, connection = setup_reader(monkeypatch, rows()[:2])
    with pytest.raises(HomeActivityError) as result:
        read(reader, connection, REFS)
    assert result.value.status_code == 403
    connection.done()
