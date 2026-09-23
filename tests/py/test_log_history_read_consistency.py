"""Read/retention concurrency and real diagnostic redaction regressions."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
import pytest
from music_app.services import log_history as history
from tests.py.test_log_history_postgres import log_store, subject, query, entry, ids


@pytest.mark.parametrize('operation',['page','export'])
def test_concurrent_prune_after_snapshot_validation_never_returns_silent_partial_history(log_store,operation):
    adapter,scope=subject(log_store)
    adapter.append(entry(log_store,'owned-a'),scope=scope)
    adapter.append(entry(log_store,'owned-b',1),scope=scope)
    captured=adapter.page(scope=scope,query=query())['snapshot']
    reached=Event();resume=Event()
    original_connect=adapter.connect
    class Connection:
        def __init__(self,connection):self.connection=connection
        def __enter__(self):self.connection.__enter__();return self
        def __exit__(self,*args):return self.connection.__exit__(*args)
        def __getattr__(self,name):return getattr(self.connection,name)
        def execute(self,sql,*args,**kwargs):
            if str(sql).lstrip().lower().startswith('with visible as'):
                reached.set()
                assert resume.wait(5), 'test failed to release bounded read gate'
            return self.connection.execute(sql,*args,**kwargs)
    reader=history.LogHistoryPostgresAdapter(log_store['config'],connect=lambda url:Connection(original_connect(url)))
    def read():
        try:return getattr(reader,operation)(scope=scope,query=query(),snapshot=captured)
        except history.LogHistoryQueryError as error:return error
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending=pool.submit(read)
        assert reached.wait(5), 'reader did not reach records query after snapshot validation'
        try:adapter.prune(scope=scope,now=log_store['now']+timedelta(days=91))
        finally:resume.set()
        result=pending.result(timeout=5)
    if isinstance(result,history.LogHistoryQueryError):assert result.status_code==410
    else:assert ids(result)==['owned-a','owned-b'], 'snapshot cannot claim success after losing rows to concurrent retention'


@pytest.mark.parametrize('diagnostic,private_fragment',[
    ('Could not open "C:/Private Music/Secret Album/Hidden Track.flac" for analysis','Hidden Track'),
    ('Could not open "/srv/Private Music/Secret Album/Hidden Track.flac" for analysis','Hidden Track'),
    ('Could not open "\\\\server\\Private Music\\Secret Album\\Hidden Track.flac" for analysis','Hidden Track'),
    ('Authorization: Bearer opaque-sensitive-session-value','opaque-sensitive-session-value'),
])
def test_diagnostic_redaction_removes_entire_quoted_path_and_bearer_credential(diagnostic,private_fragment):
    projected=history._normalize_log_history_item({'id':'safe-event','action':'Failure','error':diagnostic,'artist':'AC/DC'})
    assert private_fragment not in projected['error']
    assert 'Private Music' not in projected['error'] and 'Secret Album' not in projected['error']
    assert projected['artist']=='AC/DC'
