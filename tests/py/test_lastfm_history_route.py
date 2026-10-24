"""UNRUN route/perimeter tests. No database, credential or provider calls.

Real router, bounded reader and private middleware; explicit actor/policy,
private-context and importer doubles. Session signature verification is doubled,
not represented as cryptographic authentication coverage.
"""
import asyncio
import json
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
import httpx
import pytest

from music_app.routes import lastfm_history_asgi as routes
from music_app.services import private_route_boundary as boundary
from music_app.services.home_activity import HomeActivityError
from music_app.services.private_library_authority import PrivateLibraryAuthorityError

PATH='/home/activity/lastfm/import'
REF='b'*64
COMMAND={'command':'begin','range_start':1700000000,'range_end':1700001000}


@pytest.fixture
def rig(monkeypatch):
    state=SimpleNamespace(calls=[],actions=[],csrf_checks=[],denied=False,actor_failure=False,
        result={'generation':'11111111-1111-4111-8111-111111111111','state':'reading','next_page':1},error=None,
        context_ref=REF,after=None)
    actor=SimpleNamespace(account_id=7,session_id=11,current_library_id=9)
    context=SimpleNamespace(actor=actor,library_id=9)
    app=FastAPI()
    app.state.config={'LASTFM_HISTORY_IMPORT_ENABLED':True}
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
    class Importer:
        def __init__(self,config):
            assert config is app.state.config
        def begin(self,supplied,**kwargs):
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
    monkeypatch.setattr(routes,'LastfmHistoryImport',Importer)
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
    state.app=app
    state.request=request
    return state



def private(response):
    assert response.headers['cache-control']=='private, no-store'
    assert response.headers['x-content-type-options']=='nosniff'


def test_registered_route_uses_account_import_action_and_real_csrf_boundary(rig):
    response=rig.request()
    assert response.status_code==200
    private(response)
    assert rig.actions==['account.self.lastfm.history.write']
    assert rig.csrf_checks==[('synthetic-session','synthetic-csrf')]
    assert rig.calls==[{'range_start':1700000000,'range_end':1700001000,'constraints':'synthetic-constraints'}]


def test_default_off_cannot_enter_importer(rig):
    rig.app.state.config={}
    response=rig.request()
    assert response.status_code==503 and not rig.calls
    private(response)


@pytest.mark.parametrize('headers',[
    {'origin':'https://foreign.invalid'},{'x-album-haven-csrf':'wrong'},
    {'x-album-haven-csrf':''}])
def test_csrf_denial_prevents_provider_or_storage_owner(rig,headers):
    response=rig.request(headers=headers)
    assert response.status_code==403 and not rig.calls
    private(response)


def test_account_policy_denial_never_enters_importer(rig):
    rig.denied=True
    response=rig.request()
    assert response.status_code==403 and not rig.calls
    private(response)


def test_context_continuity_denial_prevents_import(rig):
    response=rig.request(headers={'x-albumhaven-context':'c'*64})
    assert response.status_code==409 and not rig.calls


@pytest.mark.parametrize('extra',[{'username':'Other'},{'account_id':99},{'session_key':'not-accepted'},
    {'source':'foobar'},{'retry_scrobbles':True}])
def test_server_owned_fields_and_send_requests_are_rejected(rig,extra):
    response=rig.request(body=json.dumps({**COMMAND,**extra}))
    assert response.status_code==422 and not rig.calls


def test_oversized_command_and_duplicate_keys_cannot_enter_importer(rig):
    assert rig.request(body='x'*2049).status_code==413
    assert rig.request(body='{"command":"begin","command":"advance"}').status_code==422
    assert not rig.calls


def test_actual_perimeter_maps_read_separately_from_import_and_submission():
    assert boundary.private_action_for_route('POST','/home/activity/lastfm/combined')=='account.self.lastfm.history.read'
    assert boundary.private_action_for_route('POST',PATH)=='account.self.lastfm.history.write'
    assert boundary.private_action_for_route('POST','/home/activity/scrobbles/retry')=='integration.lastfm.scrobbles.submit'
    assert boundary.csrf_mode_for_route('POST',PATH)=='session_header'


def test_prehandler_actor_failure_is_closed_and_private(rig):
    rig.actor_failure=True
    response=rig.request()
    assert response.status_code==503 and not rig.calls
    private(response)
