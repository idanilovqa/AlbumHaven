"""Task 6 actual Postgres paging/version/export contracts; no schema-wide cleanup."""
from __future__ import annotations
import json
import os
import re
import uuid
from datetime import datetime,timedelta,timezone
from urllib.parse import urlparse
import pytest
from music_app.services import log_history as history

@pytest.fixture
def log_store():
    import psycopg
    from psycopg.rows import dict_row
    runtime=os.environ.get('ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL','').strip()
    if not runtime: pytest.skip('Live log history contracts require the CI isolated contract database URL.')
    setup=os.environ.get('DATABASE_MIGRATOR_URL','').strip()
    parsed=urlparse(runtime)
    assert parsed.hostname in {'localhost','127.0.0.1','::1'}
    assert re.fullmatch(r'(?:album_haven_ci_|pytest_|album_haven_fake_e2e)[a-z0-9_]*',parsed.path.lstrip('/'))
    assert setup and urlparse(setup).hostname==parsed.hostname and urlparse(setup).path==parsed.path
    def connect(): return psycopg.connect(setup,row_factory=dict_row)
    account=None; libraries=[]
    try:
        with connect() as connection:
            name='log-contract-'+uuid.uuid4().hex
            account=connection.execute('insert into app.accounts(display_name,username_display,username_normalized,contact_email,contact_email_normalized) values(%s,%s,%s,%s,%s) returning id',(name,name,name,name+'@example.test',name+'@example.test')).fetchone()['id']
            for index in range(2):
                libraries.append(connection.execute('insert into library.libraries(owner_account_id,name) values(%s,%s) returning id',(account,f'{name}-{index}')).fetchone()['id'])
        config={'ALBUM_HAVEN_APP_DATABASE_URL':runtime}
        yield {'config':config,'connect':connect,'runtime':runtime,'libraries':libraries,'account':account,'now':datetime.now(timezone.utc).replace(microsecond=0)}
    finally:
        with connect() as connection:
            for library in libraries: connection.execute('delete from library.libraries where id=%s',(library,))
            if account is not None: connection.execute('delete from app.accounts where id=%s',(account,))

def subject(store,index=0):
    return history.LogHistoryPostgresAdapter(store['config']),history.HistoryScope(library_id=store['libraries'][index],account_id=store['account'],origin_kind='request')
def query(**fields): return history.normalize_log_history_query(fields)
def entry(store,event_id,offset=0,**fields):
    return {'id':event_id,'timestamp':(store['now']+timedelta(seconds=offset)).isoformat(),'action':'Tags edited','source':'scanner','level':'info',**fields}
def ids(result): return [item['id'] for item in result['items']]

def test_keyset_same_timestamp_has_no_gaps_and_export_uses_identical_snapshot(log_store):
    adapter,scope=subject(log_store)
    for key in ['c','a','b']: adapter.append(entry(log_store,key),scope=scope)
    first=adapter.page(scope=scope,query=query(),page_size=2)
    second=adapter.page(scope=scope,query=query(),page_size=2,cursor=first['next_cursor'],snapshot=first['snapshot'])
    assert ids(first)+ids(second)==['a','b','c']
    assert not second['next_cursor']
    exported=adapter.export(scope=scope,query=query(),snapshot=first['snapshot'])
    assert ids(exported)==ids(first)+ids(second) and exported['count']==3

def test_backdated_arrivals_and_same_id_updates_cannot_change_captured_snapshot(log_store):
    adapter,scope=subject(log_store)
    adapter.append(entry(log_store,'same',message='First summary'),scope=scope)
    snapshot=adapter.page(scope=scope,query=query())['snapshot']
    adapter.append(entry(log_store,'same',message='Updated summary'),scope=scope)
    adapter.append(entry(log_store,'backdated',-3600),scope=scope)
    old=adapter.export(scope=scope,query=query(),snapshot=snapshot)
    assert ids(old)==['same'] and old['items'][0]['message']=='First summary'
    latest=adapter.export(scope=scope,query=query())
    assert ids(latest)==['backdated','same']
    assert latest['items'][1]['message']=='Updated summary'
    assert ids(adapter.export(scope=scope,query=query(text='First summary')))==[], 'filter after selecting the latest visible version'

def test_normalized_half_open_filter_is_identical_for_page_and_export(log_store):
    adapter,scope=subject(log_store)
    for key,offset,source,action,message in [('start',0,'scanner','Tags edited','Album target'),('end',60,'scanner','Tags edited','Album target'),('source',20,'browser','Tags edited','Album target'),('type',20,'scanner','Library status error','Album target'),('text',20,'scanner','Tags edited','Different')]:
        adapter.append(entry(log_store,key,offset,source=source,action=action,message=message),scope=scope)
    filtered=query(from_utc=log_store['now'].isoformat(),to_utc=(log_store['now']+timedelta(seconds=60)).isoformat(),sources=['scanner'],event_types=['Tags edited'],text='Album target')
    page=adapter.page(scope=scope,query=filtered)
    assert ids(page)==['start']
    assert ids(adapter.export(scope=scope,query=filtered,snapshot=page['snapshot']))==['start']
    assert ids(adapter.export(scope=scope,query=query(event_ids=['end'])))==['end']

def test_library_scope_and_cursor_query_binding_cannot_be_broadened(log_store):
    adapter,scope=subject(log_store); _,other=subject(log_store,1)
    for key in ['a','b']: adapter.append(entry(log_store,key),scope=scope)
    adapter.append(entry(log_store,'foreign'),scope=other)
    filtered=query(sources=['scanner'])
    first=adapter.page(scope=scope,query=filtered,page_size=1)
    assert ids(adapter.export(scope=other,query=query()))==['foreign']
    for target,filters,cursor in [(other,filtered,first['next_cursor']),(scope,query(),first['next_cursor']),(scope,filtered,str(first['next_cursor'])+'tampered')]:
        with pytest.raises(history.LogHistoryQueryError) as caught:
            adapter.page(scope=target,query=filters,cursor=cursor,snapshot=first['snapshot'])
        assert caught.value.status_code in (400,403,404)
    with pytest.raises(history.LogHistoryQueryError): adapter.export(scope=other,query=filtered,snapshot=first['snapshot'])

def test_page_size_is_bounded_at_500(log_store):
    adapter,scope=subject(log_store)
    adapter.append(entry(log_store,'seed'),scope=scope)
    with log_store['connect']() as connection:
        head=connection.execute('select revision from ops.log_history_heads where library_id=%s for update',(scope.library_id,)).fetchone()['revision']
        connection.execute("insert into ops.log_history_events(library_id,event_id,revision,event_timestamp,recorded_at,payload) select %s,'page-'||n::text,%s+n,%s,%s,jsonb_build_object('id','page-'||n::text,'action','Tags edited','timestamp',%s::text) from generate_series(1,500) n",(scope.library_id,head,log_store['now'],log_store['now'],log_store['now'].isoformat()))
        connection.execute('update ops.log_history_heads set revision=%s where library_id=%s',(head+500,scope.library_id))
    default_page=adapter.page(scope=scope,query=query())
    assert len(default_page['items'])==500 and default_page['next_cursor']
    try: result=adapter.page(scope=scope,query=query(),page_size=10000)
    except history.LogHistoryQueryError as error: assert error.status_code==400
    else: assert len(result['items'])<=500

def test_retention_uses_recording_time_and_only_prunes_requested_library(log_store):
    adapter,scope=subject(log_store); _,other=subject(log_store,1)
    adapter.append(entry(log_store,'backdated',-100*86400),scope=scope)
    adapter.append(entry(log_store,'expired'),scope=scope)
    adapter.append(entry(log_store,'foreign-expired'),scope=other)
    captured=adapter.page(scope=scope,query=query())['snapshot']
    with log_store['connect']() as connection:
        connection.execute('update ops.log_history_events set recorded_at=%s where library_id=any(%s) and event_id in (%s,%s)',(log_store['now']-timedelta(days=91),log_store['libraries'],'expired','foreign-expired'))
    adapter.prune(scope=scope,now=log_store['now'])
    assert ids(adapter.page(scope=scope,query=query()))==['backdated']
    with log_store['connect']() as connection:
        assert connection.execute('select count(*) as total from ops.log_history_events where library_id=%s and event_id=%s',(other.library_id,'foreign-expired')).fetchone()['total']==1
    with pytest.raises(history.LogHistoryQueryError) as caught: adapter.export(scope=scope,query=query(),snapshot=captured)
    assert caught.value.status_code in (409,410)

def test_scope_redaction_happens_before_storage_and_projection(log_store):
    adapter,scope=subject(log_store)
    unsafe='Failed C:\\private\\artist\\track.flac and \\\\server\\share\\track.flac and /home/owner/music/song.flac token=private-token https://user:password@example.test/file'
    adapter.append(entry(log_store,'safe',message=unsafe,paths=['C:/private/track.flac'],token='private-token',nested={'secret':'nested-secret'},artist='AC/DC'),scope=scope)
    result=adapter.export(scope=scope,query=query())
    serialized=json.dumps(result)
    with log_store['connect']() as connection:
        payload=connection.execute('select payload from ops.log_history_events where library_id=%s and event_id=%s',(scope.library_id,'safe')).fetchone()['payload']
    for content in [serialized,json.dumps(payload)]:
        for private in ['private-token','nested-secret','user:password','track.flac','song.flac']:
            assert private not in content
    assert result['items'][0]['artist']=='AC/DC'
    from psycopg.types.json import Jsonb
    with log_store['connect']() as connection:
        connection.execute('update ops.log_history_events set payload=%s where library_id=%s and event_id=%s',(Jsonb(entry(log_store,'safe',message=unsafe,nested={'secret':'nested-secret'})),scope.library_id,'safe'))
    historical=json.dumps(adapter.export(scope=scope,query=query()))
    assert 'nested-secret' not in historical and 'private-token' not in historical and 'song.flac' not in historical

def test_100001_event_export_refuses_instead_of_returning_a_truncated_success(log_store):
    adapter,scope=subject(log_store)
    adapter.append(entry(log_store,'seed'),scope=scope)
    with log_store['connect']() as connection:
        head=connection.execute('select revision from ops.log_history_heads where library_id=%s for update',(scope.library_id,)).fetchone()['revision']
        connection.execute("insert into ops.log_history_events(library_id,event_id,revision,event_timestamp,recorded_at,payload) select %s,'bulk-'||n::text,%s+n,%s,%s,jsonb_build_object('id','bulk-'||n::text,'action','Tags edited','source','scanner','timestamp',%s::text) from generate_series(1,100000) n",(scope.library_id,head,log_store['now'],log_store['now'],log_store['now'].isoformat()))
        connection.execute('update ops.log_history_heads set revision=%s where library_id=%s',(head+100000,scope.library_id))
    with pytest.raises(history.LogHistoryQueryError) as caught: adapter.export(scope=scope,query=query())
    assert caught.value.status_code==413
    with log_store['connect']() as connection:
        connection.execute('delete from ops.log_history_events where library_id=%s and event_id=%s',(scope.library_id,'bulk-100000'))
    permitted=adapter.export(scope=scope,query=query())
    assert permitted['count']==100000 and len(permitted['items'])==100000

def test_append_serialization_prevents_late_lower_revisions_entering_old_snapshot(log_store):
    import psycopg
    from psycopg.rows import dict_row
    from concurrent.futures import ThreadPoolExecutor,TimeoutError
    from threading import Event
    adapter,scope=subject(log_store)
    adapter.append(entry(log_store,'seed'),scope=scope)
    ready,release=Event(),Event()
    class GatedConnection:
        def __init__(self): self.connection=psycopg.connect(log_store['runtime'],row_factory=dict_row)
        def __getattr__(self,name): return getattr(self.connection,name)
        def __enter__(self): self.connection.__enter__(); return self
        def __exit__(self,*args):
            ready.set()
            assert release.wait(timeout=10)
            return self.connection.__exit__(*args)
    gated=history.LogHistoryPostgresAdapter(log_store['config'],connect=lambda _url:GatedConnection())
    with ThreadPoolExecutor(max_workers=3) as pool:
        first=pool.submit(gated.append,entry(log_store,'first'),scope=scope)
        try:
            assert ready.wait(timeout=3)
            second=pool.submit(adapter.append,entry(log_store,'second'),scope=scope)
            with pytest.raises(TimeoutError): second.result(timeout=0.15)
            before=pool.submit(adapter.page,scope=scope,query=query()).result(timeout=2)
            assert ids(before)==['seed']
        finally: release.set()
        first.result(timeout=5); second.result(timeout=5)
    assert ids(adapter.export(scope=scope,query=query(),snapshot=before['snapshot']))==['seed']
    assert set(ids(adapter.export(scope=scope,query=query())))=={'seed','first','second'}