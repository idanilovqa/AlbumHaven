"""Actual final Artist lock and post-receipt witness fences; no fake SQL."""
from time import monotonic
import pytest
from tests.py.remote_top_postgres_support import remote, db, urls, sql_error
from tests.py.remote_top_retention_postgres_support import retained
from tests.py.test_album_top_remote_membership_postgres import mixed, record_owner_sql
from tests.py.test_album_top_remote_artist_scope_postgres import (
    artist_remote, identity, scoped_command, ARTIST, OTHER, OUTSIDE,
)
from tests.py.test_owned_album_tops_postgres import assert_error


def test_final_nowait_conflict_rolls_back_receipt_catalog_retention_and_consumption(artist_remote):
    case = artist_remote
    command, _ = scoped_command(case)
    before = case.snapshot()
    observed = []
    with case.db.connect() as writer:
        writer.execute("set local lock_timeout='1s'")
        writer.execute("set local statement_timeout='3s'")
        def after(sql, connection):
            if sql.startswith('insert into app.album_list_operations '):
                writer.execute('update library.local_artists set mbid=%s::uuid where library_id=%s and id=%s',
                    (OTHER, case.db.library, case.db.scope_artists[0]))
                observed.append(True)
        case.remote.after_statement = after
        started = monotonic()
        try:
            assert_error(lambda: case.execute(command), 'artist_scope_changed', 409)
            assert monotonic()-started < 3, 'Final Artist conflict must not wait for the writer'
        finally:
            case.remote.after_statement = None
            writer.rollback()
    assert observed == [True]
    assert case.snapshot() == before


@pytest.mark.parametrize('index,field,value', [
    (0, 'mbid', OTHER), (0, 'mbid_assertion_state', 'conflicting'),
    (0, 'evidence_source', 'different_verified_source'),
    (1, 'mbid', OUTSIDE),
])
def test_committed_identity_change_after_receipt_rejects_even_unknown_witness_rows(artist_remote, index, field, value):
    case = artist_remote
    identity(case, 1, None, 'missing', None)
    command, _ = scoped_command(case, mode='family')
    before = case.snapshot()
    observed = []
    def after(sql, connection):
        if sql.startswith('insert into app.album_list_operations '):
            with case.db.connect() as writer:
                writer.execute("set local lock_timeout='1s'")
                writer.execute("set local statement_timeout='3s'")
                cast = '::uuid' if field == 'mbid' else ''
                writer.execute('update library.local_artists set '+field+'=%s'+cast+' where library_id=%s and id=%s',
                    (value, case.db.library, case.db.scope_artists[index]))
            observed.append(True)
    case.remote.after_statement = after
    try:
        assert_error(lambda: case.execute(command), 'artist_scope_changed', 409)
    finally:
        case.remote.after_statement = None
    assert observed == [True]
    assert case.snapshot() == before


def test_final_artist_share_lock_blocks_writer_until_owner_transaction_commits(artist_remote):
    case = artist_remote
    command, _ = scoped_command(case)
    observed = []
    def after(sql, connection):
        if 'library.local_artists' in sql and 'for share' in sql and 'nowait' in sql and not observed:
            with case.db.connect() as writer:
                writer.execute("set local lock_timeout='100ms'")
                writer.execute("set local statement_timeout='2s'")
                sql_error(writer, '55P03', lambda: writer.execute(
                    'update library.local_artists set mbid=%s::uuid where library_id=%s and id=%s',
                    (OTHER, case.db.library, case.db.scope_artists[0])))
            observed.append(True)
    case.remote.after_statement = after
    try:
        with record_owner_sql(case.db) as statements:
            result = case.execute(command)
    finally:
        case.remote.after_statement = None
    assert observed == [True]
    receipt_index = next(i for i, (_, sql, _) in enumerate(statements)
        if sql.startswith('insert into app.album_list_operations '))
    artist_locks = [i for i, (_, sql, _) in enumerate(statements)
        if 'library.local_artists' in sql and ('for share' in sql or 'for update' in sql)]
    assert artist_locks and min(artist_locks) > receipt_index
    identity(case, 0, OTHER)
    assert len(case.read(result)['items']) == 1
