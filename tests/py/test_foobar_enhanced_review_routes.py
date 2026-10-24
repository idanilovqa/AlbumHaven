"""Authored-only actual route, session/CSRF and service owner; no test run."""
import json
from dataclasses import replace
import pytest
from tests.py.foobar_enhanced_review_testing import *
from tests.py.foobar_account_route_testing import request,scheduler,route
from tests.py.foobar_account_service_testing import handles,s
from tests.py.foobar_account_service_readiness_testing import install_catalog
from music_app.services import private_route_boundary as perimeter
PATH='/integrations/foobar/account/enhanced/review'
PROTOCOL='foobar_enhanced_review_v1'
BODY=b'SQLite format 3\0'+b'x'*84

def wire():
    return dict(version=PROTOCOL,source_ref=SOURCE,generation=1,expected_revision='0',
        request_ref=REQUEST,offset=0,previous_upload_sha256=None)

def enhanced_request(monkeypatch,handle=None,*,value=None,body=BODY,**kwargs):
    req,auth,reads=request(monkeypatch,body,handle=handle,**kwargs)
    req.scope.update(path=PATH,raw_path=PATH.encode())
    req.scope['headers'][:]=[(key,value) for key,value in req.scope['headers'] if key!=b'content-type']
    req.scope['headers'] += [(b'content-type',b'application/vnd.sqlite3'),
        (b'x-album-haven-foobar-bytes',str(len(body)).encode()),
        (b'x-albumhaven-foobar-command',json.dumps(wire() if value is None else value).encode())]
    req.state.current_actor=context().actor
    marker=route.foobar_account_ui_context_ref(req)
    del req.state.current_actor
    req.scope['headers'].append((b'x-albumhaven-foobar-context',marker.encode()))
    return req,auth,reads

def decoded(response):
    assert response.headers['cache-control']=='private, no-store'
    value=json.loads(response.body)
    assert value['protocol']==PROTOCOL
    return value

def endpoint():
    entries=[entry for entry in route.router.routes if entry.path==PATH]
    assert len(entries)==1 and entries[0].methods=={'POST'}
    assert entries[0].endpoint is route.foobar_account_enhanced_review
    return entries[0].endpoint

@pytest.mark.asyncio
async def test_registered_review_route_runs_real_service_owner_without_persistence(monkeypatch):
    db=install(monkeypatch); install_catalog(monkeypatch); stream(monkeypatch,[record()])
    handle,=handles(monkeypatch); db.service_owner=handle.owner; steps=scheduler(monkeypatch,handle)
    req,auth,reads=enhanced_request(monkeypatch,handle)
    response=await endpoint()(req); value=decoded(response)
    assert response.status_code==200 and value['result']['persistence']=='not_applied'
    assert value['result']['local_entries']=='1' and value['result']['cached_lastfm_entries']=='1'
    assert value['result']['local_evidence']=='incomplete_possibly_seeded'
    assert value['result']['cached_lastfm']=='separate_not_local_plays'
    assert len(value['context_ref'])==64 and handle.owner.current is None
    assert len(steps)==1 and db.checkouts==db.exits==3 and not db.driver_errors
    assert '/synthetic/' not in response.body.decode() and 'artifact.sqlite' not in response.body.decode()

@pytest.mark.asyncio
@pytest.mark.parametrize('failure',['revoked','csrf','origin','marker'])
async def test_early_authentication_and_context_failure_never_reads_upload(monkeypatch,failure):
    db=install(monkeypatch); handle,=handles(monkeypatch)
    req,auth,reads=enhanced_request(monkeypatch,handle,csrf=failure!='csrf',
        origin='https://foreign.invalid' if failure=='origin' else 'https://synthetic.invalid')
    if failure=='revoked': auth.revoked=True
    if failure=='marker':
        req.scope['headers'][:]=[(k,v) for k,v in req.scope['headers'] if k!=b'x-albumhaven-foobar-context']
    response=await endpoint()(req)
    assert response.status_code in (400,401,403,409) and 'result' not in decoded(response)
    assert reads[0]==0 and db.checkouts==0 and handle.owner.current is None

@pytest.mark.asyncio
@pytest.mark.parametrize('failure',['session','revoked','marker'])
async def test_post_worker_fresh_identity_rejects_result(monkeypatch,failure):
    db=install(monkeypatch); install_catalog(monkeypatch); stream(monkeypatch,[record()])
    handle,=handles(monkeypatch); req,auth,reads=enhanced_request(monkeypatch,handle)
    def changed():
        if failure=='session': auth.session_id=4
        elif failure=='revoked': auth.revoked=True
        else: req.scope['headers'][:]=[(k,v) for k,v in req.scope['headers'] if k!=b'x-albumhaven-foobar-context']
    scheduler(monkeypatch,handle,after=changed)
    response=await endpoint()(req)
    assert response.status_code in (400,401,403,409) and 'result' not in decoded(response)
    assert handle.owner.current is None and db.checkouts==db.exits==3

@pytest.mark.asyncio
@pytest.mark.parametrize('change',['version','revision','extra','offset','length','encoding','content_type'])
async def test_exact_upload_and_command_contract_rejects_before_admission(monkeypatch,change):
    handle,=handles(monkeypatch); value=wire()
    if change=='version': value['version']='foobar_account_review_v3'
    if change=='revision': value['expected_revision']=0
    if change=='extra': value['coherent']=True
    if change=='offset': value['offset']=1
    req,auth,reads=enhanced_request(monkeypatch,handle,value=value)
    if change in ('length','content_type'):
        name=b'content-length' if change=='length' else b'content-type'
        req.scope['headers'][:]=[(k,v) for k,v in req.scope['headers'] if k!=name]
        req.scope['headers'].append((name,b'101' if change=='length' else b'text/tab-separated-values'))
    if change=='encoding': req.scope['headers'].append((b'content-encoding',b'gzip'))
    response=await endpoint()(req)
    assert response.status_code==400 and 'result' not in decoded(response)
    assert reads[0]==0 and handle.owner.current is None

@pytest.mark.asyncio
async def test_backpressure_never_polls_receive_beside_stream(monkeypatch):
    accepted=[]; attempts=[0]; waits=[]
    class Request:
        async def stream(self):
            yield b'a'*100
            yield b'b'*100
        async def is_disconnected(self): raise AssertionError('second ASGI receive owner')
    class Handle:
        def offer_enhanced_upload(self,ticket,chunk):
            attempts[0]+=1
            if attempts[0]%2: return False
            accepted.append(chunk); return True
        def finish_enhanced_upload(self,ticket): accepted.append('finished')
    async def paused(delay): waits.append(delay)
    monkeypatch.setattr(route.asyncio,'sleep',paused)
    await route._enhanced_upload_body(Request(),Handle(),object())
    assert accepted==[b'a'*100,b'b'*100,'finished'] and waits==[.01,.01]

@pytest.mark.asyncio
@pytest.mark.parametrize('failure',['csrf','origin','revoked'])
async def test_actual_private_perimeter_uses_enhanced_protocol(monkeypatch,failure):
    req,auth,reads=enhanced_request(monkeypatch,csrf=failure!='csrf',
        origin='https://foreign.invalid' if failure=='origin' else 'https://synthetic.invalid')
    if failure=='revoked': auth.revoked=True
    captured={}; routed=[]
    req.app.routes=[]; req.app.get=lambda path:lambda function:function
    def middleware(kind):
        assert kind=='http'
        def register(function): captured['call']=function; return function
        return register
    req.app.middleware=middleware; perimeter.install_private_route_boundary(req.app)
    async def next_handler(request): routed.append(True); return await endpoint()(request)
    response=await captured['call'](req,next_handler)
    assert response.status_code in (401,403) and 'result' not in decoded(response)
    assert not routed and reads[0]==0
    assert perimeter.private_action_for_route('POST',PATH)=='account.self.foobar.write'
    assert perimeter.csrf_mode_for_route('POST',PATH)=='session_header'
    assert not perimeter._is_public('GET',PATH)

def test_three_live_chunk_logical_charge_is_explicit_not_rss_claim():
    assert s.enhanced_upload.UPLOAD_LOGICAL_BYTES==3*s.enhanced_upload.MAX_CHUNK_BYTES+65536

@pytest.mark.parametrize('mutation',['negative_count','false_count','bad_hash','missing_item',
    'bad_cursor','raw_path_state','bad_provenance','invented_zero','duplicate_ordinal'])
def test_strict_review_wire_rejects_semantically_inconsistent_result(monkeypatch,mutation):
    install(monkeypatch); stream(monkeypatch,[record(),record(2)])
    result=invoke(); item=result.items[0]
    if mutation=='negative_count': result=replace(result,records=-1)
    elif mutation=='false_count': result=replace(result,local_entries=False)
    elif mutation=='bad_hash': result=replace(result,upload_sha256='bad')
    elif mutation=='missing_item': result=replace(result,items=result.items[:1])
    elif mutation=='bad_cursor': result=replace(result,next_offset=1)
    elif mutation=='raw_path_state': result=replace(result,items=(replace(item,data_state='/private/path'),result.items[1]))
    elif mutation=='bad_provenance': result=replace(result,items=(replace(item,local_provenance='complete_events'),result.items[1]))
    elif mutation=='invented_zero': result=replace(result,items=(replace(item,data_state='null',local_provenance=None),result.items[1]))
    else: result=replace(result,items=(item,replace(result.items[1],ordinal=0)))
    with pytest.raises(owner.SourceUnavailable): route._enhanced_wire(result,command())

@pytest.mark.asyncio
async def test_disconnect_during_intake_abandons_exact_operation_without_dispatch(monkeypatch):
    from starlette.requests import ClientDisconnect
    db=install(monkeypatch); handle,=handles(monkeypatch)
    req,auth,reads=enhanced_request(monkeypatch,handle)
    async def gone(): raise ClientDisconnect()
    req._receive=gone
    response=await endpoint()(req)
    assert response.status_code==503 and 'result' not in decoded(response)
    assert handle.owner.current is None and handle.owner.next_ticket==2 and db.checkouts==0
