"""Task 6 shared query and immutable writer-scope contracts."""
from __future__ import annotations
from dataclasses import FrozenInstanceError
from datetime import datetime, timezone
from types import SimpleNamespace
import pytest
from music_app.services import log_history as history
from music_app.services import app_logging

@pytest.mark.parametrize('payload', [
    {'from_utc':'2026-09-09'}, {'to_utc':'not-a-date'},
    {'from_utc':'2026-09-10T00:00:00Z','to_utc':'2026-09-09T00:00:00Z'},
    {'from_utc':'2026-09-09T00:00:00Z','to_utc':'2026-09-09T00:00:00Z'},
    {'sources':'scan'}, {'event_types':{'error':True}}, {'event_ids':['']},
])
def test_invalid_history_query_is_rejected_before_any_store_access(payload):
    with pytest.raises(history.LogHistoryQueryError) as caught:
        history.normalize_log_history_query(payload)
    assert caught.value.status_code==400

def test_normalized_query_is_immutable_and_equivalent_filters_compare_equal():
    first=history.normalize_log_history_query({'from_utc':'2026-09-09T02:00:00+02:00','to_utc':'2026-09-10T00:00:00Z','sources':[' scan ','scan'],'event_types':['success','error','success'],'text':'  Album  ','event_ids':['b','a','b']})
    second=history.normalize_log_history_query({'from_utc':'2026-09-09T00:00:00Z','to_utc':'2026-09-10T00:00:00+00:00','sources':['scan'],'event_types':['error','success'],'text':'Album','event_ids':['a','b']})
    assert first==second
    with pytest.raises((FrozenInstanceError,AttributeError,TypeError)):
        first.text='different'

def test_history_scope_is_immutable_and_does_not_mutate_shared_configuration():
    scope=history.HistoryScope(library_id=9,account_id=7,origin_kind='request')
    with pytest.raises((FrozenInstanceError,AttributeError,TypeError)):
        scope.library_id=88
    assert scope.library_id==9 and scope.account_id==7

def test_missing_writer_scope_never_uses_configuration_or_a_reader_as_authority(monkeypatch):
    config={'library_id':99,'account_id':88,'HISTORY_LIBRARY_ID':99}
    before=dict(config)
    monkeypatch.setattr(history,'LogHistoryPostgresAdapter',lambda *_args,**_kwargs:pytest.fail('unscoped writer reached persistence'),raising=False)
    history.append_log_history(config,{'action':'Unattributed'},scope=None)
    assert config==before

def test_delayed_and_background_writer_scopes_remain_distinct_without_config_mutation(monkeypatch):
    captured=[]
    class Adapter:
        def __init__(self,_config): pass
        def append(self,entry,*,scope): captured.append((scope,dict(entry))); return entry
    monkeypatch.setattr(history,'LogHistoryPostgresAdapter',Adapter,raising=False)
    config={'unrelated':'unchanged'}
    a=history.HistoryScope(library_id=11,account_id=1,origin_kind='request')
    b=history.HistoryScope(library_id=22,account_id=2,origin_kind='request')
    c=history.HistoryScope(library_id=33,origin_kind='background')
    delayed=lambda:history.append_log_history(config,{'action':'A completion'},scope=a)
    history.append_log_history(config,{'action':'B request'},scope=b)
    history.append_log_history(config,{'action':'C scan'},scope=c)
    delayed()
    assert [scope.library_id for scope,_ in captured]==[22,33,11]
    assert config=={'unrelated':'unchanged'}

def test_shared_logging_consumes_scope_without_serializing_it_and_failure_stays_nonfatal(monkeypatch):
    scope=history.HistoryScope(library_id=9,account_id=7,origin_kind='request')
    captured=[]; messages=[]
    def append(config,entry,*,scope):
        captured.append((dict(entry),scope))
        raise RuntimeError('database unavailable')
    monkeypatch.setattr(app_logging,'append_log_history',append)
    logger=SimpleNamespace(log=lambda _level,message:messages.append(message))
    app_logging.log_app_event({},logger,'Committed save',history=True,history_scope=scope,count=2)
    assert captured and captured[0][1] is scope
    assert 'history_scope' not in captured[0][0]
    assert all('HistoryScope' not in message and 'library_id' not in message for message in messages)