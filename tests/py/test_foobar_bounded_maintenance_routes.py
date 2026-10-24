"""Authored actual route/perimeter/single-worker composition; not executed."""
import json
import pytest
from tests.py.test_foobar_bounded_maintenance import install_maintenance,m,SOURCE
from tests.py.foobar_account_job_worker_testing import sign_ui_request
from tests.py.foobar_account_route_testing import scheduler,route,request as raw_request
from tests.py.foobar_account_service_testing import handles,s
from tests.py.foobar_account_service_readiness_testing import install_catalog
from music_app.services import private_route_boundary as perimeter

PATH='/integrations/foobar/account/maintenance'
VERSION='foobar_account_maintenance_v1'


def request(monkeypatch,handle,*,value=None,**kwargs):
    body=json.dumps(value or dict(version=VERSION,source_ref=SOURCE,cursor=None)).encode()
    req,auth,reads=raw_request(monkeypatch,body,handle=handle,**kwargs)
    sign_ui_request(req)
    req.scope.update(path=PATH,raw_path=PATH.encode())
    return req,auth,reads


@pytest.mark.asyncio
async def test_real_registered_maintenance_route_and_worker(monkeypatch):
    db,state=install_maintenance(monkeypatch);install_catalog(monkeypatch)
    handle,=handles(monkeypatch);scheduler(monkeypatch,handle)
    req,_,reads=request(monkeypatch,handle)
    endpoints=[item for item in route.router.routes if item.path==PATH]
    assert len(endpoints)==1 and endpoints[0].methods=={'POST'}
    response=await endpoints[0].endpoint(req);body=json.loads(response.body)
    assert response.status_code==200 and body['protocol']==VERSION
    assert body['result']['source_ref']==SOURCE
    assert body['result']['inspected']==body['result']['removed_receipts']==0
    assert body['result']['history_deleted'] is False and body['result']['job_reconciled'] is False
    assert response.headers['cache-control']=='private, no-store'
    # One JSON body receive plus one bounded disconnect probe.
    assert reads[0]==2 and db.commits==1 and handle.owner.current is None
    assert state['maintenance_calls']


@pytest.mark.asyncio
@pytest.mark.parametrize('value',[
    dict(version=VERSION,source_ref='bad',cursor=None),
    dict(version=VERSION,source_ref=SOURCE,cursor={'generation':1}),
    dict(version='old',source_ref=SOURCE,cursor=None),
])
async def test_bad_maintenance_input_never_dispatches(monkeypatch,value):
    db,state=install_maintenance(monkeypatch);install_catalog(monkeypatch);handle,=handles(monkeypatch)
    req,_,_=request(monkeypatch,handle,value=value)
    response=await route.foobar_account_maintenance(req);body=json.loads(response.body)
    assert response.status_code==400 and body['outcome_uncertain'] is False
    assert not state['maintenance_calls'] and handle.owner.current is None


@pytest.mark.asyncio
@pytest.mark.parametrize('failure',['revoked','csrf','origin'])
async def test_actual_early_boundary_uses_account_write_and_private_protocol(monkeypatch,failure):
    req,auth,reads=request(monkeypatch,None,csrf=failure!='csrf',
        origin='https://foreign.invalid' if failure=='origin' else 'https://synthetic.invalid')
    if failure=='revoked':auth.revoked=True
    captured,routed={},[]
    req.app.routes=[];req.app.get=lambda path:lambda function:function
    def middleware(kind):
        def register(function):captured['call']=function;return function
        return register
    req.app.middleware=middleware;perimeter.install_private_route_boundary(req.app)
    async def handler(req):routed.append(True);return await route.foobar_account_maintenance(req)
    response=await captured['call'](req,handler)
    assert response.status_code in (401,403)
    assert json.loads(response.body)['protocol']==VERSION
    assert not routed and reads[0]==0
    assert perimeter._PRIVATE_ROUTE_ACTIONS[('POST',PATH)]=='account.self.foobar.write'
    assert perimeter.csrf_mode_for_route('POST',PATH)=='session_header'


@pytest.mark.asyncio
async def test_post_worker_revocation_withholds_success_and_marks_uncertainty(monkeypatch):
    db,_=install_maintenance(monkeypatch);install_catalog(monkeypatch);handle,=handles(monkeypatch)
    req,auth,_=request(monkeypatch,handle)
    scheduler(monkeypatch,handle,after=lambda:setattr(auth,'revoked',True))
    response=await route.foobar_account_maintenance(req);body=json.loads(response.body)
    assert response.status_code in (401,403,409) and 'result' not in body
    assert body['outcome_uncertain'] is True and db.commits==1
    assert handle.owner.current is None


@pytest.mark.asyncio
async def test_uncertain_owner_exit_never_redispatches(monkeypatch):
    db,_=install_maintenance(monkeypatch);install_catalog(monkeypatch);handle,=handles(monkeypatch)
    def forbidden(*args,**kwargs):raise AssertionError('Maintenance cannot reconcile/retry')
    monkeypatch.setattr(s,'_reconciled',forbidden)
    db.lose_ack=True;scheduler(monkeypatch,handle)
    req,_,_=request(monkeypatch,handle)
    response=await route.foobar_account_maintenance(req);body=json.loads(response.body)
    assert response.status_code==503 and body['outcome_uncertain'] is True
    assert db.commits==1 and handle.owner.current is None
