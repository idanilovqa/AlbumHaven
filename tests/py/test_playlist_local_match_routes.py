"""Exact local-match transport and the production session-CSRF classification."""
import asyncio
from uuid import uuid4
import pytest

from music_app.routes import playlist_complete_sources_asgi as routes
from music_app.services import playlist_local_matches as matches
from music_app.services.owned_playlists import PlaylistError
from music_app.services.private_route_boundary import csrf_mode_for_route, private_action_for_route
from music_app.services.private_ui_context import private_ui_context_ref
from tests.py.test_owned_playlist_route_boundary import Service, request, decoded
from tests.py.test_playlist_local_matches import body


@pytest.mark.parametrize('accept',[False,True])
def test_local_match_routes_forward_exact_payload_and_current_context(monkeypatch,accept):
    calls=[]
    def action(owner,ctx,payload,*,constraints):
        calls.append((owner,ctx,payload,constraints))
        return {'status':'ready','data':{'entry_ref':payload['entry_ref']}}
    monkeypatch.setattr(matches,'accept' if accept else 'review',action)
    payload=body(**({'review_ref':str(uuid4()),'candidate_ref':str(uuid4())} if accept else {}))
    service=Service();req=request(service,payload=payload)
    response=asyncio.run(routes._match(req,accept=accept))
    assert response.status_code==200 and decoded(response)['context_ref']==private_ui_context_ref(req)
    assert calls[0][0] is service and calls[0][2]==payload
    path='/playlists/creation-source/'+('accept-match' if accept else 'match-candidates')
    assert private_action_for_route('POST',path)=='library.playlists.create'
    assert csrf_mode_for_route('POST',path)=='session_header'


@pytest.mark.parametrize('kind',['stale','missing_actor','extra_field','query','malformed','oversize'])
@pytest.mark.parametrize('accept',[False,True])
def test_invalid_match_transport_never_calls_business_service(monkeypatch,kind,accept):
    calls=[]
    monkeypatch.setattr(matches,'accept' if accept else 'review',lambda *args,**kwargs:calls.append(args))
    payload=body(**({'review_ref':str(uuid4()),'candidate_ref':str(uuid4())} if accept else {}))
    kwargs={'payload':payload};status=422
    if kind=='stale':kwargs['header']='0'*64;status=409
    elif kind=='missing_actor':kwargs['no_actor']=True;status=403
    elif kind=='extra_field':payload['local_track_id']=7
    elif kind=='query':kwargs['query']={'q':'search'}
    elif kind=='malformed':kwargs['raw']=b'['
    else:kwargs['raw']=b' '*(matches.MATCH_BODY_BYTES+1);status=413
    response=asyncio.run(routes._match(request(Service(),**kwargs),accept=accept))
    assert response.status_code==status and decoded(response)['ok'] is False
    assert calls==[]


def test_service_conflict_is_private_no_store(monkeypatch):
    def reject(*args,**kwargs):raise PlaylistError('match_review_changed',409)
    monkeypatch.setattr(matches,'accept',reject)
    response=asyncio.run(routes.playlist_accept_match(request(Service(),payload=body(review_ref=str(uuid4()),candidate_ref=str(uuid4())))))
    assert response.status_code==409 and decoded(response)=={'ok':False,'error':'match_review_changed'}


@pytest.mark.parametrize('path',['/playlists/creation-source/match-candidates','/playlists/creation-source/accept-match'])
def test_production_boundary_requires_session_csrf_before_match_endpoint(path):
    from music_app.services.auth_session_csrf import issue_session_csrf
    from tests.py.owned_playlist_testing import context
    from tests.py.test_private_route_boundary import _app, _request
    actor=context().actor
    app,_=_app(actor)
    reached=[]
    def endpoint():reached.append(True);return {'ok':True}
    app.add_api_route(path,endpoint,methods=['POST'])
    status,_,headers=_request(app,path,method='POST',include_headers=True)
    assert status==403 and reached==[]
    assert (b'cache-control',b'private, no-store') in headers
    token='s'*43
    csrf=issue_session_csrf(token,app.state.auth_policy_config)
    cookies=f'__Host-album_haven_session={token}; __Host-album_haven_csrf={csrf}'
    status,_=_request(app,path,method='POST',cookie=cookies,
        headers={'origin':'https://foreign.test','x-album-haven-csrf':csrf})
    assert status==403 and reached==[]
    status,_=_request(app,path,method='POST',cookie=cookies,
        headers={'origin':'https://music.test','x-album-haven-csrf':csrf})
    assert status==200 and reached==[True]
