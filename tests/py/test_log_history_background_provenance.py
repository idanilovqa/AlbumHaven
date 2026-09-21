"""Task 6 provenance from actual background factories and retry iteration."""
import copy
from dataclasses import FrozenInstanceError
import pytest
from music_app.services import state, lastfm_retry, listen_history_postgres as repository, log_history


def test_retry_captures_persisted_entry_scope_separately_from_forged_payload(monkeypatch):
    config={'library_id':999};before=copy.deepcopy(config);callbacks=[];writes=[];updates=[]
    entries=[repository.PendingListenEntry(entry={'id':'same','library_id':88,'account_id':77},account_id=1,library_id=9,row_id=101),
             repository.PendingListenEntry(entry={'id':'same','library_id':88,'account_id':77},account_id=2,library_id=10,row_id=102)]
    monkeypatch.setattr(lastfm_retry,'lastfm_api_enabled',lambda _config:True)
    monkeypatch.setattr(lastfm_retry,'load_pending_scrobble_entries',lambda *_args,**_kwargs:entries)
    monkeypatch.setattr(lastfm_retry,'pending_scrobble_count',lambda _config:0)
    monkeypatch.setattr(lastfm_retry,'record_retry_summary',lambda *_args:None)
    monkeypatch.setattr(lastfm_retry,'log_app_event',lambda _config,_logger,message,*,history_scope,**_kwargs:writes.append((history_scope.account_id,history_scope.library_id,message)))
    monkeypatch.setattr(lastfm_retry,'update_listen_history_entry',lambda *args,**kwargs:updates.append(kwargs),raising=False)
    def attempt(_config,entry,**dependencies):
        assert isinstance(entry,dict) and entry['library_id']==88
        callbacks.append(dependencies)
        return {'attempted':True,'succeeded':False,'failed':True}
    monkeypatch.setattr(lastfm_retry,'process_pending_scrobble_attempt',attempt)
    lastfm_retry.retry_pending_lastfm_scrobbles(config)
    for callback in reversed(callbacks):
        callback['log_lastfm_scrobble_event']('Retry failed',level='error',payload={'library_id':66},error='Failure')
        callback['update_listen_history_entry'](config,'same',{'scrobbled':True})
    assert writes==[(2,10,'Retry failed'),(1,9,'Retry failed')]
    assert [(call['account_id'],call['library_id'],call['row_id']) for call in updates]==[(2,10,102),(1,9,101)]
    assert config==before


def test_pending_listen_provenance_cannot_be_mutated_by_payload_processing():
    wrapped=repository.PendingListenEntry(entry={'id':'a'},account_id=1,library_id=9,row_id=101)
    with pytest.raises((FrozenInstanceError,AttributeError,TypeError)):
        wrapped.library_id=88


def test_bounded_error_recorders_keep_library_generation_counters_and_summary_ids_distinct(monkeypatch):
    emitted=[];counters={};config={'library_id':999};before=copy.deepcopy(config)
    monkeypatch.setattr(state,'_SCAN_FILE_ERROR_HISTORY_LIMIT',1)
    monkeypatch.setattr(state,'log_app_event',lambda _config,_logger,action,*,history_scope,**fields:emitted.append((history_scope.library_id,action,fields)))
    a=state._bounded_file_error_history_recorder(config,None,scan_generation=3,counter_state=counters,
        history_scope=log_history.HistoryScope(library_id=9,origin_kind='background'))
    b=state._bounded_file_error_history_recorder(config,None,scan_generation=3,counter_state=counters,
        history_scope=log_history.HistoryScope(library_id=10,origin_kind='background'))
    a('A file');b('B file');a('A omitted');b('B omitted')
    assert [(library,action) for library,action,_ in emitted]==[(9,'A file'),(10,'B file'),(9,'Additional library file errors omitted'),(10,'Additional library file errors omitted')]
    assert emitted[2][2]['id']!=emitted[3][2]['id']
    assert config==before
