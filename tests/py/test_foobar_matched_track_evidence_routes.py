"""Actual registered route/worker/read owner. No execution performed."""
import json
import pytest
from tests.py.foobar_account_history_native_testing import checked_native_driver, install, OBS
from tests.py.test_foobar_account_history_native_routes import native_request
from tests.py.foobar_account_route_testing import scheduler, route
from tests.py.foobar_account_service_testing import handles, s
from tests.py.foobar_account_service_readiness_testing import install_catalog
from tests.py.test_foobar_matched_track_evidence import evidence_driver,row
from music_app.services import private_route_boundary as perimeter

PATH='/integrations/foobar/account/history/native/evidence'
VERSION='foobar_account_track_evidence_v1'


def request(monkeypatch,handle,*,value=None,**kwargs):
    req,auth,reads=native_request(monkeypatch,handle,value=value or dict(version=VERSION,track_id='21',family='standard',cursor=None),**kwargs)
    req.scope.update(path=PATH,raw_path=PATH.encode())
    return req,auth,reads


@pytest.mark.asyncio
async def test_actual_registered_track_evidence_route_uses_real_worker_and_projection(monkeypatch):
    db=install(monkeypatch);install_catalog(monkeypatch);evidence_driver(monkeypatch,db,[row(db)])
    handle,=handles(monkeypatch);db.service_owner=handle.owner;scheduler(monkeypatch,handle)
    req,_,reads=request(monkeypatch,handle)
    endpoints=[x for x in route.router.routes if x.path==PATH]
    assert len(endpoints)==1 and endpoints[0].methods=={'POST'}
    response=await endpoints[0].endpoint(req)
    body=json.loads(response.body)
    assert response.status_code==200 and body['protocol']==VERSION
    assert body['result']['items'][0]['count']=='1'
    assert body['result']['items'][0]['evidence_kind']=='enhanced_store'
    assert response.headers['cache-control']=='private, no-store'
    assert len(response.body)<=65536 and not db.physical
    assert reads[0]==2 and handle.owner.current is None


@pytest.mark.asyncio
@pytest.mark.parametrize('value',[
    dict(version=VERSION,track_id='0',family='standard',cursor=None),
    dict(version=VERSION,track_id='21',family='summed',cursor=None),
    dict(version=VERSION,track_id='21',family='standard',cursor={'account_id':'1'}),
])
async def test_malformed_evidence_request_is_400_before_work(monkeypatch,value):
    db=install(monkeypatch);install_catalog(monkeypatch);handle,=handles(monkeypatch)
    req,_,_=request(monkeypatch,handle,value=value)
    response=await route.foobar_account_track_evidence(req)
    assert response.status_code==400 and handle.owner.current is None
    assert json.loads(response.body)['error']=='invalid_evidence_request'


def test_actual_private_perimeter_uses_evidence_protocol_and_browse():
    assert perimeter._PRIVATE_ROUTE_ACTIONS[('POST',PATH)]=='library.browse.read'
    assert PATH in perimeter._FOOBAR_NATIVE_PATHS
    assert perimeter._foobar_response_protocol(PATH)==VERSION


@pytest.mark.asyncio
@pytest.mark.parametrize('failure',['revoked','csrf','origin'])
async def test_real_early_perimeter_error_keeps_evidence_protocol(monkeypatch,failure):
    req,auth,reads=request(monkeypatch,None,csrf=failure!='csrf',
        origin='https://foreign.invalid' if failure=='origin' else 'https://synthetic.invalid')
    if failure=='revoked':auth.revoked=True
    captured,routed={},[]
    req.app.routes=[];req.app.get=lambda path:lambda function:function
    def middleware(kind):
        assert kind=='http'
        def register(function):captured['call']=function;return function
        return register
    req.app.middleware=middleware
    perimeter.install_private_route_boundary(req.app)
    async def handler(req):
        routed.append(True);return await route.foobar_account_track_evidence(req)
    response=await captured['call'](req,handler)
    body=json.loads(response.body)
    assert response.status_code in (401,403) and body['protocol']==VERSION
    assert 'result' not in body and not routed and reads[0]==0
    assert perimeter.csrf_mode_for_route('POST',PATH)=='session_header'
    assert not perimeter._is_public('GET',PATH)


@pytest.mark.asyncio
@pytest.mark.parametrize('failure',['revoked','inactive','library','browse'])
async def test_post_worker_current_authority_withholds_evidence(monkeypatch,failure):
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    db=install(monkeypatch);install_catalog(monkeypatch);evidence_driver(monkeypatch,db,[row(db)])
    handle,=handles(monkeypatch);req,auth,_=request(monkeypatch,handle)
    def changed():
        if failure=='revoked':auth.revoked=True
        elif failure=='inactive':auth.active=False
        elif failure=='library':auth.library_id=8
        else:req.app.state.policy_constraint_resolver=lambda target:PolicyEvaluationConstraints(
            request_origin_allowed=target.action!='library.browse.read')
    scheduler(monkeypatch,handle,after=changed)
    response=await route.foobar_account_track_evidence(req)
    body=json.loads(response.body)
    assert response.status_code in (400,401,403,409) and body['protocol']==VERSION
    assert 'result' not in body and handle.owner.current is None
    assert db.checkouts==db.exits==1 and not db.physical
