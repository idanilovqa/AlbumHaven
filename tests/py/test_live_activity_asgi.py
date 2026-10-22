from types import SimpleNamespace
from dataclasses import replace
import pytest

from music_app.routes import live_activity_asgi as routes
from music_app.services.current_actor import CapabilityGrant
from music_app.services.private_route_boundary import private_action_for_route
from tests.py.test_home_activity_asgi_routes import actor,app_for,expected_context,assert_private
from tests.py.asgi_testing import run_asgi_request,decode_json


def test_new_presence_routes_have_explicit_private_actions():
    assert private_action_for_route('GET','/home/activity/now-playing')=='library.browse.read'
    assert private_action_for_route('POST','/playback/session/presence-source')=='library.media.read'
    assert private_action_for_route('POST','/playback/session/presence')=='library.browse.read'


def test_live_read_returns_null_not_completed_history(monkeypatch):
    from music_app.routes import home_activity_asgi_routes
    app,_,_=app_for(monkeypatch,home_activity_asgi_routes)
    calls=[]
    monkeypatch.setattr(routes,'LiveActivityPostgres',lambda _:SimpleNamespace(read=lambda context,**kw:calls.append(kw)))
    status,headers,body=run_asgi_request(app,'GET','/home/activity/now-playing',headers={'cookie':'__Host-album_haven_session='+'s'*43})
    assert status==200 and decode_json(body)['data'] is None
    assert_private(headers)
    assert len(calls)==1


def test_live_reader_rejects_unknown_query_and_masks_backend_failure(monkeypatch):
    from music_app.routes import home_activity_asgi_routes
    app,_,_=app_for(monkeypatch,home_activity_asgi_routes)
    status,_,_=run_asgi_request(app,'GET','/home/activity/now-playing',query={'account_id':'42'},headers={'cookie':'__Host-album_haven_session='+'s'*43})
    assert status==422
    def fail(*args,**kwargs):raise RuntimeError('private-password-or-path')
    monkeypatch.setattr(routes,'LiveActivityPostgres',lambda _:SimpleNamespace(read=fail))
    status,headers,body=run_asgi_request(app,'GET','/home/activity/now-playing',headers={'cookie':'__Host-album_haven_session='+'s'*43})
    assert status==503 and b'private-password-or-path' not in body
    assert_private(headers)


@pytest.mark.parametrize('path,method',[('/playback/session/presence-source','source'),('/playback/session/presence','update')])
def test_publisher_requires_csrf_same_origin_and_current_ui_context(monkeypatch,path,method):
    from music_app.routes import home_activity_asgi_routes
    from music_app.services.auth_session_csrf import issue_session_csrf
    current=actor()
    current=replace(current,capability_grants=(*current.capability_grants,CapabilityGrant('library.media.read','library',73)))
    app,_,_=app_for(monkeypatch,home_activity_asgi_routes,current_actor=current)
    calls=[]
    monkeypatch.setattr(routes,'LiveActivityPostgres',lambda _:SimpleNamespace(**{method:lambda *a,**kw:calls.append(a) or {'state':'paused'}}))
    base={'cookie':'__Host-album_haven_session='+'s'*43}
    status,headers,_=run_asgi_request(app,'POST',path,headers=base,json_body={})
    assert status==403 and not calls
    assert_private(headers)
    csrf=issue_session_csrf('s'*43,app.state.auth_policy_config)
    headers={**base,'cookie':base['cookie']+'; __Host-album_haven_csrf='+csrf,'x-album-haven-csrf':csrf,
             'origin':'http://testserver','x-albumhaven-context':expected_context(app,current)}
    status,_,_=run_asgi_request(app,'POST',path,headers={**headers,'origin':'https://foreign.test'},json_body={})
    assert status==403 and not calls
    status,_,_=run_asgi_request(app,'POST',path,headers={**headers,'x-albumhaven-context':'0'*64},json_body={})
    assert status==409 and not calls
    status,response_headers,body=run_asgi_request(app,'POST',path,headers=headers,json_body={})
    assert status==200 and len(calls)==1
    assert decode_json(body)['data']=={'state':'paused'}
    assert_private(response_headers)
