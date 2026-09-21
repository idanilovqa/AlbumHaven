"""Actual persisted retry row provenance and exact updates."""
import uuid
import pytest
from psycopg.types.json import Jsonb
from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter
from tests.py.test_log_history_postgres import log_store

@pytest.fixture
def pending_rows(log_store):
    rows=[];source='runtime_listen_history_adapter';prefix='retry-provenance-'+uuid.uuid4().hex
    with log_store['connect']() as connection:
        for library in log_store['libraries']:
            item={'id':'shared-public-id','scrobble_eligible':True,'scrobbled':False,'library_id':777,'account_id':888,'marker':f'library-{library}'}
            row=connection.execute('insert into integration.listen_history(account_id,library_id,played_at,source_family,source_entry_id,scrobble_status,metadata) values(%s,%s,now(),%s,%s,%s,%s) returning id',
                (log_store['account'],library,source,prefix+'-'+str(library),'pending',Jsonb({'source_payload':item}))).fetchone()
            rows.append({'row_id':row['id'],'library_id':library,'item':item})
    return rows


def test_pending_adapter_returns_trusted_row_scope_separate_from_payload(log_store,pending_rows,monkeypatch):
    from music_app.services import listen_history_postgres as repository
    # Select only this fixture's configured legacy library. Do not change the
    # actual bootstrap-owner rows or enumerate another library under its credentials.
    account=log_store['account']; library=pending_rows[0]['library_id']
    monkeypatch.setattr(repository,'_bootstrap_context_sql',lambda: f"with bootstrap_context as (select {int(account)}::bigint account_id,{int(library)}::bigint library_id) ")
    adapter=PostgresListenHistoryAdapter(log_store['config'])
    pending=adapter.load_pending_entries(limit=100)
    own={item.row_id:item for item in pending if item.row_id in {row['row_id'] for row in pending_rows}}
    assert len(own)==1 and pending_rows[1]['row_id'] not in own
    for row in pending_rows[:1]:
        wrapped=own[row['row_id']]
        assert wrapped.account_id==log_store['account'] and wrapped.library_id==row['library_id']
        assert wrapped.entry['library_id']==777 and wrapped.entry['account_id']==888


def test_retry_update_touches_only_exact_scoped_persisted_row(log_store,pending_rows):
    adapter=PostgresListenHistoryAdapter(log_store['config']);first,other=pending_rows
    rejected=adapter.update_scoped_entry(account_id=log_store['account'],library_id=other['library_id'],row_id=first['row_id'],entry_id='shared-public-id',updates={'scrobbled':True})
    assert rejected is None
    changed=adapter.update_scoped_entry(account_id=log_store['account'],library_id=first['library_id'],row_id=first['row_id'],entry_id='shared-public-id',updates={'scrobbled':True})
    assert changed['scrobbled'] is True
    with log_store['connect']() as connection:
        rows=connection.execute('select id,metadata from integration.listen_history where id=any(%s)',([first['row_id'],other['row_id']],)).fetchall()
    actual={row['id']:row['metadata']['source_payload'] for row in rows}
    assert actual[first['row_id']]['scrobbled'] is True and actual[other['row_id']]==other['item']
