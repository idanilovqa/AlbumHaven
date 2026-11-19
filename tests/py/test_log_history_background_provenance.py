"""Task 6 provenance from actual background factories and retry iteration."""
import copy
from dataclasses import FrozenInstanceError
import pytest
from music_app.services import state, listen_history_postgres as repository, log_history


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
