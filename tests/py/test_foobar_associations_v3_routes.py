"""Real v3 service/routes/auth/status/chain with controlled scheduling only."""
import json
import pytest
from tests.py.foobar_account_associations_v3_testing import (
    install,make_command,p,a,SOURCE,GEN,PAYLOAD,associations,
)
from tests.py.foobar_account_service_testing import handles
from tests.py.foobar_account_service_readiness_testing import install_catalog
from tests.py.foobar_account_route_testing import request,scheduler,route
from tests.py.test_foobar_account_matching_chain import install_status_boundary


def upload_request(monkeypatch,handle,cmd,*,csrf=True):
    req,auth,reads=request(monkeypatch,PAYLOAD,handle=handle,csrf=csrf)
    req.scope['path']='/integrations/foobar/account/prepare'
    req.scope['headers'][:]=[(k,b'text/tab-separated-values' if k==b'content-type' else v)
        for k,v in req.scope['headers']]+[
            (b'x-album-haven-foobar-bytes',str(len(PAYLOAD)).encode()),
            (b'x-albumhaven-foobar-command',json.dumps(p.gate.prepare_command_to_mapping(cmd),separators=(',',':')).encode())]
    return req,auth,reads


@pytest.mark.asyncio
@pytest.mark.parametrize('changed_session',[False,True])
async def test_actual_v3_prepare_status_apply_service_routes(monkeypatch,changed_session):
    db=install(monkeypatch); install_catalog(monkeypatch); handle,=handles(monkeypatch)
    cmd=make_command(db); req,auth,reads=upload_request(monkeypatch,handle,cmd)
    scheduler(monkeypatch,handle)
    response=await route.foobar_account_prepare(req)
    assert response.status_code==200
    ready=json.loads(response.body)
    assert ready['protocol']=='foobar_account_import_v4'
    assert ready['result']['association_review'][0][2:]==['never_decided',True]
    assert handle.owner.current is None and not db.source_rows
    install_status_boundary(monkeypatch,db)
    value=dict(version='foobar_account_status_v3',source_ref=SOURCE,generation=GEN,
        receipt_ref=ready['result']['receipt_ref'])
    req,auth,reads=request(monkeypatch,json.dumps(value).encode(),handle=handle)
    scheduler(monkeypatch,handle)
    native=len(db.native_calls); local=len(db.association_calls)
    response=await route.foobar_account_status(req)
    assert response.status_code==200
    recovered=json.loads(response.body)['result']
    assert recovered['original_prepare_command']==p.gate.prepare_command_to_mapping(cmd)
    assert recovered['association_review']==ready['result']['association_review']
    assert len(db.native_calls)==native and len(db.association_calls)==local
    apply_cmd=a.apply_command.FoobarApplyCommand(SOURCE,GEN,
        '33333333-3333-4333-8333-333333333333',ready['result']['receipt_ref'],
        ready['result']['decision_sha256'],7)
    req,auth,reads=request(monkeypatch,json.dumps(a.apply_command.apply_command_to_mapping(apply_cmd)).encode(),handle=handle)
    scheduler(monkeypatch,handle,after=(lambda:setattr(auth,'session_id',4)) if changed_session else None)
    response=await route.foobar_account_apply(req)
    assert response.status_code==(409 if changed_session else 200)
    assert len(db.history)==1 and db.calls.count(associations._WRITE)==1
    assert handle.owner.current is None and handle.owner.next_ticket==4
    if not changed_session:
        assert json.loads(response.body)['result']['terminal'][22]==1
    else:
        assert 'result' not in json.loads(response.body)


@pytest.mark.asyncio
async def test_real_prepare_csrf_precedes_body_and_admission(monkeypatch):
    db=install(monkeypatch); handle,=handles(monkeypatch)
    req,auth,reads=upload_request(monkeypatch,handle,make_command(db),csrf=False)
    response=await route.foobar_account_prepare(req)
    assert response.status_code==403 and reads[0]==0 and handle.owner.current is None


@pytest.mark.asyncio
@pytest.mark.parametrize('version',[None,'foobar_account_status_v2'])
async def test_v2_status_request_rejected_before_worker_admission(monkeypatch,version):
    handle,=handles(monkeypatch)
    value=dict(source_ref=SOURCE,generation=GEN,receipt_ref=SOURCE)
    if version is not None: value['version']=version
    req,auth,reads=request(monkeypatch,json.dumps(value).encode(),handle=handle)
    response=await route.foobar_account_status(req)
    assert response.status_code==400 and handle.owner.current is None
