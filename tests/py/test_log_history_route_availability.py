"""Task 6 async route availability and bounded storage failures."""
import asyncio
import json
from threading import Event, get_ident
from types import SimpleNamespace
import pytest
from starlette.datastructures import QueryParams
from music_app.routes import api_read_asgi_routes as routes

@pytest.fixture
def route_context(monkeypatch):
    class Lock:
        held=False
        def __enter__(self):self.held=True
        def __exit__(self,*_args):self.held=False
    lock=Lock()
    async def scope(_request,**_kwargs):return SimpleNamespace(account_id=7,library_id=9)
    async def body():return {'query':{}}
    request=SimpleNamespace(json=body,query_params=QueryParams(),state=SimpleNamespace(),app=SimpleNamespace(state=SimpleNamespace(cold_scan_handoff_lock=lock)))
    monkeypatch.setattr(routes,'history_scope_for_request',scope)
    monkeypatch.setattr(routes,'_app_config',lambda _request:{})
    monkeypatch.setattr(routes,'_library_state',lambda _request:{})
    monkeypatch.setattr(routes,'_build_status_payload_from_state',lambda _state:{'scan_in_progress':False,'usable':True})
    monkeypatch.setattr(routes,'_project_library_watch_health_for_request',lambda _request:{})
    monkeypatch.setattr(routes,'allowed_actions_for_request',lambda *_args:SimpleNamespace(as_payload=lambda:{}))
    return request,lock

@pytest.mark.parametrize('operation,dependency',[('utilities_log_history','load_log_history_snapshot'),('utilities_log_history_export','export_log_history'),('status','load_log_history_revision')])
def test_history_database_callback_runs_off_event_loop_and_allows_other_request_work(monkeypatch,route_context,operation,dependency):
    request,lock=route_context
    async def run():
        loop=asyncio.get_running_loop();loop_thread=get_ident();released=Event();events=[]
        def heartbeat():events.append('event-loop-progress');released.set()
        def database(*_args,**_kwargs):
            assert get_ident()!=loop_thread, 'synchronous history database work ran on request event loop'
            assert not lock.held, 'database work held cold-scan lock'
            events.append('database-start');loop.call_soon_threadsafe(heartbeat)
            assert released.wait(5), 'bounded deadlock guard: event loop never progressed while database callback waited'
            events.append('database-end')
            return 'revision' if operation=='status' else {'items':[],'snapshot':'snapshot','next_cursor':None,'revision':'revision','count':0}
        monkeypatch.setattr(routes,dependency,database)
        response=await getattr(routes,operation)(request)
        assert response.status_code==200
        assert events==['database-start','event-loop-progress','database-end']
    asyncio.run(run())

@pytest.mark.parametrize('operation,dependency',[('utilities_log_history','load_log_history_snapshot'),('utilities_log_history_export','export_log_history'),('status','load_log_history_revision')])
def test_history_storage_outage_is_generic_and_status_remains_available(monkeypatch,route_context,operation,dependency):
    request,_lock=route_context
    def unavailable(*_args,**_kwargs):raise RuntimeError('postgresql://owner:private-password@database C:/private/music')
    monkeypatch.setattr(routes,dependency,unavailable)
    response=asyncio.run(getattr(routes,operation)(request))
    payload=json.loads(response.body)
    assert b'private' not in response.body and b'postgresql' not in response.body
    if operation=='status':
        assert response.status_code==200 and payload['usable'] is True and payload['log_history_revision']==''
    else:assert response.status_code==503 and payload['ok'] is False and payload['error']
