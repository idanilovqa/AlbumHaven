"""Task 6 authenticated route boundaries; no production implementation yet."""
import asyncio
import copy
from types import SimpleNamespace
from tests.py.asgi_testing import configure_test_bootstrap_actor, run_asgi_request
import pytest
from fastapi import FastAPI, HTTPException
from starlette.datastructures import QueryParams
from music_app.routes import api_read_asgi_routes as routes
from music_app.services import current_actor_asgi, private_route_boundary as boundary


def actor(library=9):
    return SimpleNamespace(account_id=7,current_library_id=library,is_authenticated=True,
        library_relationships=(SimpleNamespace(library_id=library,membership_role='owner',is_primary_owner=True),))

def request(config=None, library=9):
    payload={'query':{'text':'Album','event_ids':['event-a']},'snapshot':'captured','library_id':88,'account_id':99}
    async def body(): return payload
    return SimpleNamespace(actor=actor(library),json=body,query_params=QueryParams('text=Album&sources=scan&sources=edit&library_id=88&account_id=99&snapshot=captured&page_size=500'),headers={},
        state=SimpleNamespace(),app=SimpleNamespace(state=SimpleNamespace(config=config or {'untouched':'original'})))

@pytest.fixture
def scoped(monkeypatch):
    async def resolve(req): return req.actor
    monkeypatch.setattr(current_actor_asgi,'current_actor_from_request',resolve)
    monkeypatch.setattr(routes,'current_actor_from_request',resolve,raising=False)
    monkeypatch.setattr(routes,'_app_config',lambda req:req.app.state.config)
    monkeypatch.setattr(routes,'allowed_actions_for_request',lambda *_args:SimpleNamespace(as_payload=lambda:{}))

@pytest.mark.parametrize('method,path,action',[('GET','/utilities/log-history','library.logs.read'),('POST','/utilities/log-history/export','library.logs.export')])
def test_history_perimeter_requires_its_exact_capability_before_handler(monkeypatch,method,path,action):
    calls=[]; app=FastAPI(); configure_test_bootstrap_actor(app)
    async def forbidden_handler(): pytest.fail('denied history request reached operational store')
    app.add_api_route(path,forbidden_handler,methods=[method])
    def require(requested,**_kwargs):
        async def deny(_request): calls.append(requested);raise HTTPException(403,'Denied')
        return deny
    monkeypatch.setattr(boundary,'require_action',require)
    boundary.install_private_route_boundary(app)
    status, _headers, _body = run_asgi_request(app,method,path)
    assert status==403 and calls==[action]

@pytest.mark.parametrize('operation',['read','export'])
def test_history_routes_forward_only_actor_scope_and_shared_normalized_query(monkeypatch,scoped,operation):
    calls=[]; req=request(); before=copy.deepcopy(req.app.state.config)
    def store(config,**values):
        calls.append(values);return {'items':[],'snapshot':'captured','revision':'3','next_cursor':None,'count':0}
    monkeypatch.setattr(routes,'load_log_history_snapshot',store)
    monkeypatch.setattr(routes,'export_log_history',store,raising=False)
    fn=routes.utilities_log_history if operation=='read' else routes.utilities_log_history_export
    response=asyncio.run(fn(req));assert response.status_code==200
    assert calls and calls[0]['scope'].account_id==7 and calls[0]['scope'].library_id==9
    assert calls[0]['query'].text=='Album' and calls[0]['snapshot']=='captured'
    if operation=='read': assert set(calls[0]['query'].sources)=={'scan','edit'}
    else: assert tuple(calls[0]['query'].event_ids)==('event-a',)
    assert req.app.state.config==before

@pytest.mark.parametrize('operation',['read','export'])
def test_history_routes_fail_closed_for_foreign_current_library_relationship(monkeypatch,scoped,operation):
    req=request();req.actor.library_relationships=(SimpleNamespace(library_id=88),)
    def forbidden(*_args,**_kwargs):pytest.fail('unrelated library reached history persistence')
    monkeypatch.setattr(routes,'load_log_history_snapshot',forbidden)
    monkeypatch.setattr(routes,'export_log_history',forbidden,raising=False)
    fn=routes.utilities_log_history if operation=='read' else routes.utilities_log_history_export
    try: response=asyncio.run(fn(req))
    except HTTPException as error: assert error.status_code in (403,404)
    else: assert response.status_code in (403,404)


def test_status_revision_uses_current_scope_outside_scan_lock_and_never_mutates_cached_payload(monkeypatch,scoped):
    class Lock:
        held=False
        def __enter__(self):self.held=True;return self
        def __exit__(self,*_args):self.held=False
    lock=Lock(); shared={'scan_in_progress':False,'log_history_revision':'cached-wrong-library'}
    calls=[]; config={'untouched':True}; before=copy.deepcopy(config)
    def revision(_config,*,scope):
        assert not lock.held, 'history DB I/O must occur outside cold-scan handoff lock'
        calls.append(scope.library_id);return f'library-{scope.library_id}'
    monkeypatch.setattr(routes,'_library_state',lambda _request:{})
    monkeypatch.setattr(routes,'_build_status_payload_from_state',lambda _state:shared)
    monkeypatch.setattr(routes,'_project_library_watch_health_for_request',lambda _request:{})
    monkeypatch.setattr(routes,'load_log_history_revision',revision)
    for library in (9,10):
        req=request(config,library);req.app.state.cold_scan_handoff_lock=lock
        response=asyncio.run(routes.status(req))
        assert f'library-{library}'.encode() in response.body
    assert calls==[9,10] and shared['log_history_revision']=='cached-wrong-library' and config==before

def test_export_grant_without_read_grant_cannot_read_or_download_history(monkeypatch):
    app=FastAPI(); configure_test_bootstrap_actor(app); app.include_router(routes.router);requested=[]
    def require(action,**_kwargs):
        async def check(_request):
            requested.append(action)
            if action=='library.logs.read': raise HTTPException(403,'Read denied')
        return check
    monkeypatch.setattr(boundary,'require_action',require)
    monkeypatch.setattr(routes,'require_action',require,raising=False)
    monkeypatch.setattr(boundary,'_valid_session_csrf',lambda _request:True)
    async def current(_request):return actor()
    monkeypatch.setattr(current_actor_asgi,'current_actor_from_request',current)
    monkeypatch.setattr(routes,'_app_config',lambda _request:{})
    monkeypatch.setattr(routes,'export_log_history',lambda *_args,**_kwargs:pytest.fail('export-only grant reached history read'),raising=False)
    boundary.install_private_route_boundary(app)
    status, _headers, _body = run_asgi_request(app,'POST','/utilities/log-history/export',json_body={'query':{}})
    assert status==403 and 'library.logs.read' in requested
