"""UNRUN route/perimeter tests. No database, credential or provider calls.

Real router, bounded reader and private middleware; explicit actor/policy,
private-context and sender doubles. Session signature verification is doubled,
not represented as cryptographic authentication coverage.
"""
import asyncio
import json
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
import httpx
import pytest

from music_app.routes import activity_native_targets_asgi as routes
from music_app.services import private_route_boundary as boundary
from music_app.services.home_activity import HomeActivityError
from music_app.services.private_library_authority import PrivateLibraryAuthorityError

PATH='/home/activity/scrobbles/retry'
REF='b'*64
ROW='activity_'+'a'*64
ORIGIN={'audience':'own','subject_ref':None,'kind':'listens','period':'all','snapshot_ref':'A'*43}
COMMAND={'origin':ORIGIN,'row_ref':ROW}


@pytest.fixture
def rig(monkeypatch):
    state=SimpleNamespace(calls=[],actions=[],csrf_checks=[],denied=False,actor_failure=False,
        result={'attempted':True,'state':'accepted','result':'attempted'},error=None,
        context_ref=REF,after=None)
    actor=SimpleNamespace(account_id=7,session_id=11,current_library_id=9)
    context=SimpleNamespace(actor=actor,library_id=9)
    app=FastAPI()
    app.state.config={}
    app.state.auth_policy_config={}
    app.include_router(routes.router)
    async def actor_from_request(request):
        if state.actor_failure:
            raise RuntimeError('synthetic-private-error')
        request.state.current_actor=actor
        return actor
    def require(action,**kwargs):
        async def evaluate(request):
            state.actions.append(action)
            if state.denied:
                raise HTTPException(403,'Action not permitted.')
        return evaluate
    def verify(session,supplied,config):
        state.csrf_checks.append((session,supplied))
        return session=='synthetic-session' and supplied=='synthetic-csrf'
    class Sender:
        def __init__(self,config):
            assert config is app.state.config
        def submit(self,supplied,**kwargs):
            assert supplied is context
            state.calls.append(kwargs)
            if state.error:
                raise state.error
            if state.after:
                state.after()
            return state.result
    monkeypatch.setattr(boundary,'current_actor_from_request',actor_from_request)
    monkeypatch.setattr(boundary,'require_action',require)
    monkeypatch.setattr(boundary,'matches_session_csrf',verify)
    monkeypatch.setattr(routes,'native_activity_context',lambda request:(context,'synthetic-constraints'))
    monkeypatch.setattr(routes,'private_ui_context_ref',lambda request:state.context_ref)
    monkeypatch.setattr(routes,'RecentScrobbleRetry',Sender)
    boundary.install_private_route_boundary(app)
    def request(*,body=None,headers=None,cookies=None,path=PATH):
        async def send():
            transport=httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport,base_url='http://testserver',cookies={
                    '__Host-album_haven_session':'synthetic-session',
                    '__Host-album_haven_csrf':'synthetic-csrf',**(cookies or {})}) as client:
                return await client.post(path,content=json.dumps(COMMAND) if body is None else body,
                    headers={'origin':'http://testserver','x-album-haven-csrf':'synthetic-csrf',
                        'x-albumhaven-context':REF,'content-type':'application/json',**(headers or {})})
        return asyncio.run(send())
    state.request=request
    return state


def private(response):
    assert response.headers['cache-control']=='private, no-store'
    assert response.headers['x-content-type-options']=='nosniff'


def test_exact_target_invokes_existing_sender_once_with_only_opaque_locator(rig):
    response=rig.request()
    assert response.status_code==200
    private(response)
    assert rig.actions==['integration.lastfm.scrobbles.submit']
    assert rig.csrf_checks==[('synthetic-session','synthetic-csrf')]
    assert rig.calls==[{'origin':ORIGIN,'row_ref':ROW,'constraints':'synthetic-constraints'}]
    assert response.json()=={'status':'ready','data':{'attempted':True,'result':'attempted'},
        'context_ref':REF,'refresh_required':True}
    assert 'state' not in response.json()['data']


def test_capability_denial_stops_before_sender_and_stays_private(rig):
    rig.denied=True
    response=rig.request()
    assert response.status_code==403 and not rig.calls
    private(response)


@pytest.mark.parametrize('headers,cookies',[
    ({'origin':'https://foreign.invalid'},{}),
    ({'x-album-haven-csrf':''},{}),
    ({'x-album-haven-csrf':'wrong'},{}),
    ({},{'__Host-album_haven_session':'wrong'}),
])
def test_real_csrf_boundary_rejects_before_sender(rig,headers,cookies):
    response=rig.request(headers=headers,cookies=cookies)
    assert response.status_code==403 and not rig.calls
    private(response)


@pytest.mark.parametrize('context',['','wrong','c'*64,'é'*64])
def test_stale_or_malformed_private_context_prevents_sender(rig,context):
    response=rig.request(headers={'x-albumhaven-context':context if context.isascii() else context.encode('utf8')})
    assert response.status_code==409 and not rig.calls
    assert response.json()=={'error':'stale_context','refresh_required':True}
    private(response)


def test_missing_current_private_context_prevents_sender(rig):
    rig.context_ref=None
    response=rig.request()
    assert response.status_code==403 and not rig.calls
    private(response)


@pytest.mark.parametrize('body',['[]','null','{',json.dumps({}),
    json.dumps({**COMMAND,'account_id':7}),json.dumps({**COMMAND,'library_id':9}),
    json.dumps({**COMMAND,'reauthenticated':True}),json.dumps({**COMMAND,'bypass_backoff':True}),
    json.dumps({**COMMAND,'path':'synthetic-private-path'}),
    json.dumps({**COMMAND,'row_ref':91}),json.dumps({**COMMAND,'row_ref':['activity_']}),
    json.dumps({**COMMAND,'row_ref':ROW+'\n'}),json.dumps({**COMMAND,'row_ref':'activity_'+'A'*64}),
])
def test_closed_command_grammar_rejects_extra_identity_flags_and_malformed_rows(rig,body):
    response=rig.request(body=body)
    assert response.status_code==422 and not rig.calls
    private(response)


@pytest.mark.parametrize('changes',[{'audience':'friend','subject_ref':'00000000-0000-4000-8000-000000000001'},
    {'audience':'comparison','subject_ref':'00000000-0000-4000-8000-000000000001'},
    {'audience':'foobar'},{'kind':'tracks'},{'subject_ref':'foreign'},
    {'snapshot_ref':'wrong'},{'account_id':7}])
def test_only_own_listen_snapshot_origin_is_accepted(rig,changes):
    body={'origin':{**ORIGIN,**changes},'row_ref':ROW}
    response=rig.request(body=json.dumps(body))
    assert response.status_code==422 and not rig.calls
    private(response)


def test_stream_limit_and_unexpected_query_prevent_sender(rig):
    response=rig.request(body=' '*2049)
    assert response.status_code==413 and not rig.calls
    private(response)
    response=rig.request(path=PATH+'?account_id=7')
    assert response.status_code==422 and not rig.calls


@pytest.mark.parametrize('result',[
    {'attempted':False,'state':'accepted','result':'not_submitted'},
    {'attempted':False,'state':'delivery_unconfirmed','result':'not_submitted'},
    {'attempted':False,'state':'unknown','result':'not_submitted'},
    {'attempted':False,'state':'not_sent','result':'claim_changed'},
    {'attempted':False,'state':'not_sent','result':'retry_blocked'},
    {'attempted':False,'state':'not_sent','result':'connection_unavailable'},
])
def test_response_never_promotes_local_state_or_invokes_batch_fallback(rig,result):
    rig.result={**result,'private_provider_token':'synthetic-secret','path':'synthetic-private-path'}
    response=rig.request()
    assert response.status_code==200 and len(rig.calls)==1
    assert response.json()['data']=={'attempted':result['attempted'],'result':result['result']}
    assert response.json()['refresh_required'] is True
    assert 'synthetic-' not in response.text


@pytest.mark.parametrize('error,status,code',[
    (PrivateLibraryAuthorityError('synthetic-private-error'),403,'forbidden'),
    (HomeActivityError('synthetic-private-error',410,'private-internal-code'),410,'occurrence_unavailable'),
    (RuntimeError('synthetic-private-error'),503,'scrobble_outcome_unconfirmed'),
])
def test_owner_failure_never_claims_no_attempt_or_exposes_internal_details(rig,error,status,code):
    rig.error=error
    response=rig.request()
    assert response.status_code==status
    assert response.json()=={'error':code,'refresh_required':True}
    private(response)


def test_context_changed_after_attempt_requires_refresh_without_reporting_not_sent(rig):
    rig.after=lambda:setattr(rig,'context_ref','c'*64)
    response=rig.request()
    assert len(rig.calls)==1 and response.status_code==409
    assert response.json()=={'error':'stale_context','refresh_required':True}
    private(response)


@pytest.mark.parametrize('result',[None,{}, {'attempted':1,'result':'attempted'},
    {'attempted':True,'result':'synthetic-secret'},{'attempted':False,'result':[]},
    {'attempted':False,'result':'attempted'},{'attempted':True,'result':'claim_changed'}])
def test_malformed_owner_result_is_failure_safe(rig,result):
    rig.result=result
    response=rig.request()
    assert response.status_code==503
    assert response.json()=={'error':'scrobble_outcome_unconfirmed','refresh_required':True}
    private(response)


def test_outer_actor_failure_is_sanitized_and_private(rig):
    rig.actor_failure=True
    response=rig.request()
    assert response.status_code==503 and not rig.calls
    assert response.json()=={'error':'scrobble_outcome_unconfirmed','refresh_required':True}
    private(response)


def test_capability_and_csrf_registration_preserve_foobar_mapping():
    assert boundary.private_action_for_route('POST',PATH)=='integration.lastfm.scrobbles.submit'
    assert boundary.csrf_mode_for_route('POST',PATH)=='session_header'
    assert boundary.private_action_for_route('POST','/integrations/foobar/account/review/start')=='account.self.foobar.write'
    assert boundary.csrf_mode_for_route('POST','/integrations/foobar/account/review/start')=='session_header'
    assert boundary.private_action_for_route('POST','/integrations/foobar/preview') is None
    assert boundary.private_action_for_route('GET','/integrations/foobar/preview-capabilities') is None
