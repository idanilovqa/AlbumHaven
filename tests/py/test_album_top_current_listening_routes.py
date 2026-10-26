"""Authored real registered router/policy/CSRF composition, not executed.

External actor retrieval and transaction entry are explicit fixture boundaries.
No successful SQL or live application-factory qualification is claimed.
"""
import json
from urllib.parse import urlencode
import pytest
from music_app.services import album_top_current_listening as service
from music_app.services.playback_capture import CaptureError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import private_action_for_route,csrf_mode_for_route
from tests.py.test_local_album_listening_routes import prepared,run,error

PATH='/playback/capture/position/top-metrics'
TOP='10000000-0000-4000-8000-000000000001'
ITEM='10000000-0000-4000-8000-000000000002'

def request(monkeypatch,*,advance=False,body=None,**kwargs):
    value=body or dict(top_ref=TOP,top_revision='1',item_ref=ITEM,state_revision='0')
    query=b'' if advance else urlencode(dict(top_ref=TOP,top_revision='1',item_ref=ITEM)).encode()
    req,state=prepared(monkeypatch,query=query,chunks=[json.dumps(value).encode()] if advance else [],**kwargs)
    req.app.state.config['ALBUM_HAVEN_TOP_LISTENING_PRESENTATION_ENABLED']=kwargs.get('enabled',True)
    path=PATH+('/advance' if advance else '')
    req.scope.update(method='POST' if advance else 'GET',path=path,raw_path=path.encode())
    def stop(*args,**kw):state['storage'].append((args,kw));raise CaptureError('capture_unavailable',503)
    monkeypatch.setattr(service,'current_library_transaction',stop)
    return req,state

@pytest.mark.parametrize('advance',[False,True])
def test_actual_top_endpoint_uses_browse_not_media_before_real_service_transaction(monkeypatch,advance):
    req,state=request(monkeypatch,advance=advance)
    def constraints(context):
        state['contexts'].append(context)
        return PolicyEvaluationConstraints(request_origin_allowed=context.action!='library.media.read')
    req.app.state.policy_constraint_resolver=constraints
    error(run(req),503,'capture_unavailable')
    assert len(state['storage'])==1
    assert state['storage'][0][0][1].action=='library.browse.read'
    assert all(c.action!='library.media.read' for c in state['contexts'])
    assert private_action_for_route(req.method,req.url.path)=='library.browse.read'
    assert csrf_mode_for_route(req.method,req.url.path)==('session_header' if advance else 'none')

@pytest.mark.parametrize('enabled',[False,None,1,'true'])
def test_default_off_has_no_actor_body_or_storage_work(monkeypatch,enabled):
    req,state=request(monkeypatch,advance=True,enabled=enabled)
    error(run(req),503,'capture_unavailable');assert state['events']==[] and state['storage']==[]

@pytest.mark.parametrize('revision',['01','-1','1'*17,1,None])
def test_bad_cursor_is_rejected_before_transaction(monkeypatch,revision):
    req,state=request(monkeypatch,advance=True,body=dict(top_ref=TOP,top_revision='1',item_ref=ITEM,state_revision=revision))
    error(run(req),422,'invalid_top_metrics');assert state['storage']==[]

@pytest.mark.asyncio
@pytest.mark.parametrize('case',['valid','missing','different_session','cross_origin'])
async def test_genuine_private_middleware_requires_real_session_csrf(monkeypatch,case):
    import base64
    import httpx
    from music_app.services import private_route_boundary as boundary,policy_asgi
    from music_app.services.auth_session_csrf import issue_session_csrf
    req,state=request(monkeypatch,advance=True)
    async def actor_loader(actual,*,refresh=False):
        actual.state.current_actor=state['actor'];return state['actor']
    monkeypatch.setattr(boundary,'current_actor_from_request',actor_loader)
    monkeypatch.setattr(policy_asgi,'current_actor_from_request',actor_loader)
    boundary.install_private_route_boundary(req.app)
    session=base64.urlsafe_b64encode(b's'*32).decode().rstrip('=')
    other=base64.urlsafe_b64encode(b't'*32).decode().rstrip('=')
    token=issue_session_csrf(other if case=='different_session' else session,req.app.state.auth_policy_config)
    headers={'X-AlbumHaven-Context':state['marker'],'Origin':'https://elsewhere.test' if case=='cross_origin' else 'https://music.test'}
    if case!='missing':headers['X-Album-Haven-CSRF']=token
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=req.app),base_url='https://music.test',
        cookies={'__Host-album_haven_session':session,'__Host-album_haven_csrf':token}) as client:
        response=await client.post(PATH+'/advance',json=dict(top_ref=TOP,top_revision='1',item_ref=ITEM,state_revision='0'),headers=headers)
    assert response.status_code==(503 if case=='valid' else 403)
    assert len(state['storage'])==(1 if case=='valid' else 0)
    assert response.headers['cache-control']=='private, no-store'

@pytest.mark.parametrize('recording',[False,None,'true',True])
def test_presentation_admission_is_independent_of_recording_config(monkeypatch,recording):
    req,state=request(monkeypatch)
    req.app.state.config['ALBUM_HAVEN_POSITION_CAPTURE_ENABLED']=recording
    error(run(req),503,'capture_unavailable')
    assert len(state['storage'])==1
