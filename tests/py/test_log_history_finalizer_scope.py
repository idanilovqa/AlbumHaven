"""Task 6 actual Wave A closure capture, separated from persistence tests."""
import copy
from types import SimpleNamespace
import pytest
from music_app.routes import api_wave_a_asgi_routes as routes
from music_app.services import log_history as history

@pytest.mark.parametrize('builder_name,terminal_name',[
    ('_asgi_bridge_queue_finalize_save_task_builder','_bridge_queue_finalize_save_task'),
    ('_asgi_selected_postgres_media_write_queue_finalize_save_task_builder','_selected_postgres_media_write_queue_finalize_save_task'),
    ('_asgi_selected_postgres_structural_tag_edit_queue_finalize_save_task_builder','queue_finalize_structural_tag_edit_save_task'),
])
def test_actual_finalizer_builders_capture_origin_scope_for_late_success_and_failure(monkeypatch,builder_name,terminal_name):
    config={'untouched':'original'};before=copy.deepcopy(config);pending=[];written=[]
    req=SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(config=config)),state=SimpleNamespace())
    monkeypatch.setattr(routes,'_app_config',lambda _request:config)
    monkeypatch.setattr(routes,'_library_state',lambda _request:{})
    monkeypatch.setattr(routes,'_postgres_album_finder_for_track_paths',lambda _request:lambda *_args:[],raising=False)
    monkeypatch.setattr(routes,terminal_name,lambda **kwargs:pending.append(kwargs))
    monkeypatch.setattr(routes,'append_log_history',lambda _config,entry,*,scope:written.append((scope.library_id,entry['action'])))
    monkeypatch.setattr(routes,'log_app_event',lambda _config,_logger,message,*,history_scope,**_kwargs:written.append((history_scope.library_id,message)))
    builder=getattr(routes,builder_name)
    a=builder(req,history_scope=history.HistoryScope(library_id=9,account_id=7,origin_kind='request'))
    b=builder(req,history_scope=history.HistoryScope(library_id=10,account_id=8,origin_kind='request'))
    b(config=config);a(config=config)
    req.state.current_library_id=99
    for callback in pending:
        callback['append_log_history'](config,{'action':'Completed'})
        callback['log_app_event'](config,None,'Rollback failed',history=True,level='error')
    assert written==[(10,'Completed'),(10,'Rollback failed'),(9,'Completed'),(9,'Rollback failed')]
    assert config==before


def test_background_unattributed_event_never_borrows_request_or_config_scope(monkeypatch):
    config={'current_library_id':99,'library_id':88};before=copy.deepcopy(config)
    monkeypatch.setattr(history,'LogHistoryPostgresAdapter',lambda *_args,**_kwargs:pytest.fail('unattributed background event reached scoped store'),raising=False)
    history.append_log_history(config,{'action':'Unattributed scan'},scope=None)
    assert config==before
