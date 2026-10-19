"""Scope/authentication precede bounded body parsing; no private error payloads."""
import asyncio
import json
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from starlette.requests import Request
import pytest

from music_app.routes import playback_capture_asgi as routes
from music_app.services.current_actor import ActorState, CurrentActor, LibraryRelationship
from music_app.services.playback_capture import CaptureError, capture_scope
from music_app.services.policy import PolicyContext, RequestOrigin
from tests.py.test_playback_capture import envelope


def request(monkeypatch, chunks, *, header=True, actor=None):
    app=FastAPI(); app.state.config={'ALBUM_HAVEN_APP_DATABASE_URL':'postgresql://synthetic'}
    app.state.auth_policy_config={'hmac':{'secret':'synthetic-capture-route-secret-32-bytes','key_version':2}}
    actor=actor or CurrentActor(state=ActorState.ACTIVE,account_id=7,session_id=11,current_library_id=3,
        library_relationships=(LibraryRelationship(3,'member',False),))
    # Authentication is separately covered by the private middleware suite. This
    # seam exposes exactly whether the handler reads a body before its guard.
    calls=[]
    def require(action, *, refresh_actor=False):
        assert action=='library.media.read' and refresh_actor
        async def dependency(req):
            calls.append('auth');req.state.current_actor=actor
        return dependency
    monkeypatch.setattr(routes,'require_action',require)
    context=PolicyContext.build(actor=actor,action='library.media.read',library_id=3,
        deployment_mode='self_hosted',request_origin=RequestOrigin('network','synthetic-capture-route'),
        client_surface_class='private_web')
    guard=capture_scope(context,app.state.auth_policy_config)
    messages=iter(chunks)
    async def receive():
        calls.append('body')
        try: chunk=next(messages)
        except StopIteration:return {'type':'http.request','body':b'','more_body':False}
        return {'type':'http.request','body':chunk,'more_body':True}
    scope={'type':'http','method':'POST','path':'/playback/capture/checkpoint','query_string':b'',
           'scheme':'https','server':('music.test',443),'client':('127.0.0.1',1),'app':app,
           'headers':[(b'host',b'music.test'),(b'x-playback-capture-scope',guard.encode() if header else b'wrong')]}
    return Request(scope,receive),calls


def run(request):
    return asyncio.run(routes.playback_capture_checkpoint(request))


def test_scope_switch_stops_before_body(monkeypatch):
    req,calls=request(monkeypatch,[b'private-data'],header=False)
    response=run(req)
    assert response.status_code==409 and calls==['auth']
    assert json.loads(response.body)['error']=='capture_scope_changed'
    assert response.headers['cache-control']=='private, no-store'


def test_auth_failure_stops_before_body(monkeypatch):
    req,calls=request(monkeypatch,[b'private-data'])
    def deny(*args,**kwargs):
        async def dependency(request):raise HTTPException(401,'private detail')
        return dependency
    monkeypatch.setattr(routes,'require_action',deny)
    response=run(req)
    assert response.status_code==401 and not calls
    assert b'private detail' not in response.body


def test_streamed_limit_enforced_without_content_length(monkeypatch):
    req,calls=request(monkeypatch,[b' '*16000,b' '*16000,b' '*1000])
    response=run(req)
    assert response.status_code==413
    assert json.loads(response.body)['error']=='capture_too_large'


def test_callable_constraints_forwarded_without_snapshot(monkeypatch):
    req,calls=request(monkeypatch,[json.dumps(envelope()).encode()])
    req.state.current_actor=CurrentActor(state=ActorState.ACTIVE,account_id=999,session_id=999)
    resolver=lambda context:None
    req.app.state.policy_constraint_resolver=resolver
    seen=[]
    def record(database,context,payload,**kwargs):
        seen.append((database,context,payload,kwargs))
        return {'ok':True}
    monkeypatch.setattr(routes,'record_capture_checkpoint',record)
    assert run(req).status_code==200
    assert seen[0][3]['constraints'] is resolver
    assert seen[0][1].actor.account_id==7
    assert calls[0]=='auth'


def test_driver_errors_are_sanitized_and_retryable(monkeypatch):
    req,_=request(monkeypatch,[json.dumps(envelope()).encode()])
    def failure(*args,**kwargs):raise RuntimeError('secret path /private/music token=hidden')
    monkeypatch.setattr(routes,'record_capture_checkpoint',failure)
    response=run(req)
    assert response.status_code==503
    assert json.loads(response.body)=={'ok':False,'error':'capture_unavailable','retryable':True}


def test_get_context_uses_locked_authority_and_private_headers(monkeypatch):
    req,calls=request(monkeypatch,[])
    checked=[]
    monkeypatch.setattr(routes,'check_capture_context',lambda *args,**kwargs:checked.append((args,kwargs)))
    response=asyncio.run(routes.playback_capture_context(req))
    body=json.loads(response.body)
    assert response.status_code==200 and len(checked)==1
    assert set(body)=={'ok','protocol','expected_scope','source_rate','output_rate'}
    assert body['source_rate']==body['output_rate']==48000
    assert response.headers['cache-control']=='private, no-store'
    assert calls==['auth']


def test_unpaired_surrogate_path_stops_as_nonretryable_schema_error(monkeypatch):
    data=envelope();data['initial_path']='/synthetic/\ud800.flac'
    req,_=request(monkeypatch,[json.dumps(data).encode()])
    response=run(req)
    assert response.status_code==400
    assert json.loads(response.body)=={'ok':False,'error':'invalid_capture','retryable':False}
