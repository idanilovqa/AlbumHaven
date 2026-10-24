"""AUTHORED ONLY; real route/auth/session/CSRF/policy/codec/service owners.

Requires pytest async support later. No ASGI app boot or real executor here.
"""
import json

import pytest
from fastapi import HTTPException

from tests.py.foobar_account_route_testing import route,request,scheduler
from tests.py.foobar_account_service_testing import (
    s,handles,install_db,install_reconciliation,prepare,apply_command,PolicyEvaluationConstraints,p,f,
)
from tests.py.foobar_account_service_readiness_testing import install_catalog


@pytest.mark.asyncio
async def test_real_authorization_and_csrf_build_real_current_actor(monkeypatch):
    req,db,reads=request(monkeypatch,b'{}')
    ctx,constraints,identity=await route._authorize(req)
    assert identity==(1,3) and ctx.actor.account_id==1 and ctx.actor.session_id==3
    assert ctx.library_id==7 and ctx.actor.current_library_id==7
    assert type(constraints) is PolicyEvaluationConstraints
    assert any('from app.account_sessions s' in sql for sql in db.calls)
    assert any('app.accounts.id as account_id' in sql for sql in db.calls)
    assert reads[0]==0


@pytest.mark.asyncio
@pytest.mark.parametrize('failure',['missing_csrf','foreign_origin','revoked','inactive'])
async def test_real_route_auth_failures_do_not_consume_body_or_slot(monkeypatch,failure):
    handle,=handles(monkeypatch)
    req,db,reads=request(monkeypatch,b'{}',handle=handle,csrf=failure!='missing_csrf',
        origin='https://other.invalid' if failure=='foreign_origin' else 'https://synthetic.invalid')
    db.revoked=failure=='revoked'
    db.active=failure!='inactive'
    response=await route._run(req,'apply')
    assert response.status_code in (401,403)
    assert reads[0]==0 and handle.owner.current is None


@pytest.mark.asyncio
async def test_real_route_retains_server_constraint_resolver_by_reference(monkeypatch):
    req,unused,unused_reads=request(monkeypatch,b'{}')
    calls=[]
    def resolver(ctx):
        calls.append(ctx.action)
        return PolicyEvaluationConstraints()
    req.app.state.policy_constraint_resolver=resolver
    ctx,actual,identity=await route._authorize(req)
    assert actual is resolver and calls and identity==(1,3)
    def deny(ctx):
        return PolicyEvaluationConstraints(request_origin_allowed=False)
    req.app.state.policy_constraint_resolver=deny
    with pytest.raises(HTTPException) as failure:
        await route._authorize(req)
    assert failure.value.status_code==403


@pytest.mark.asyncio
@pytest.mark.parametrize('changed_session',[False,True])
@pytest.mark.parametrize('lost_ack',[False,True])
async def test_actual_route_apply_uses_one_ticket_and_rechecks_session_before_delivery(monkeypatch,changed_session,lost_ack):
    db=install_db(monkeypatch)
    unused,receipt=prepare(db)
    install_reconciliation(monkeypatch,db)
    install_catalog(monkeypatch)
    handle,=handles(monkeypatch)
    cmd=apply_command(receipt,7)
    body=json.dumps(route.apply_command.apply_command_to_mapping(cmd),separators=(',',':')).encode()
    req,auth,unused_reads=request(monkeypatch,body,handle=handle)
    steps=scheduler(monkeypatch,handle,
        after=(lambda:setattr(auth,'session_id',4)) if changed_session else None)
    db.lose_ack=lost_ack
    response=await route._run(req,'apply')
    data=json.loads(response.body)
    assert response.status_code==(409 if changed_session else 200)
    if changed_session:
        assert data['error']=='stale_import'
        assert 'result' not in data
    else:
        assert data['result']['state']=='committed'
        assert data['result']['terminal']==json.loads(db.receipt['terminal'])
    assert response.headers['cache-control']=='private, no-store'
    assert handle.owner.next_ticket==2 and handle.owner.current is None
    assert len(steps)==1 and db.calls.count(f._COMMIT_SQL)==1


@pytest.mark.asyncio
async def test_disabled_or_busy_service_rejects_before_body_read(monkeypatch):
    req,unused,reads=request(monkeypatch,b'{}',handle=None)
    response=await route._run(req,'apply')
    assert response.status_code==503 and reads[0]==0
    handle,=handles(monkeypatch)
    ticket=handle.begin_status(context=(await route._authorize(req))[0],
        constraints=PolicyEvaluationConstraints(),source_ref='11111111-1111-4111-8111-111111111111',
        generation=1,receipt_ref='44444444-4444-4444-8444-444444444444')
    req.app.state.foobar_account_import_service=handle
    response=await route._run(req,'apply')
    assert response.status_code==503 and reads[0]==0
    assert handle.owner.current.ticket is ticket


@pytest.mark.parametrize('body',[
    b'{"x":1,"x":2}',b'{"x":true}',b'{"x":[]}',b'{"x":{}}',
    b'{"x":NaN}',b'{"x":1.0}',b'{"x":-1}',b'{"x":1e3}',b'[]',
    b' '*2049,b'{"x":92233720368547758080}',
])
def test_command_bounds_and_duplicate_keys_rejected_by_actual_decoder(body):
    with pytest.raises(route._Invalid):
        route._command_json(body)


def test_actual_decoder_and_mapper_require_original_matching_field():
    value={'version':'foobar_account_apply_command_v4',
        'source_ref':'11111111-1111-4111-8111-111111111111','generation':1,
        'request_key':'33333333-3333-4333-8333-333333333333',
        'receipt_ref':'44444444-4444-4444-8444-444444444444',
        'decision_sha256':'a'*64,'matching_library_id':None}
    decoded=route._command_json(json.dumps(value).encode())
    cmd=route.apply_command.apply_command_from_mapping(decoded)
    assert cmd.matching_library_id is None
    del decoded['matching_library_id']
    with pytest.raises(route.apply_command.ApplyInvalid):
        route.apply_command.apply_command_from_mapping(decoded)


@pytest.mark.asyncio
async def test_duplicate_headers_and_actual_body_limit_fail_before_admission(monkeypatch):
    handle,=handles(monkeypatch)
    req,unused,reads=request(monkeypatch,b'{}',handle=handle,
        headers=((b'content-length',b'2'),))
    response=await route._run(req,'apply')
    assert response.status_code==400 and handle.owner.current is None and reads[0]==0
    req,unused,reads=request(monkeypatch,b' '*2049,handle=handle)
    response=await route._run(req,'apply')
    assert response.status_code==400 and handle.owner.current is None and reads[0]==0


@pytest.mark.asyncio
async def test_route_cancellation_abandons_but_cannot_release_running_worker_slot(monkeypatch):
    db=install_db(monkeypatch)
    unused,receipt=prepare(db)
    handle,=handles(monkeypatch)
    cmd=apply_command(receipt,7)
    req,unused,unused_reads=request(monkeypatch,
        json.dumps(route.apply_command.apply_command_to_mapping(cmd)).encode(),handle=handle)
    async def cancellation_at_running_scheduler_boundary(delay):
        handle.owner.current.stage=s._Stage.RUNNING
        raise route.asyncio.CancelledError()
    monkeypatch.setattr(route.asyncio,'sleep',cancellation_at_running_scheduler_boundary)
    with pytest.raises(route.asyncio.CancelledError):
        await route._run(req,'apply')
    assert handle.owner.current.stage is s._Stage.RUNNING
    assert handle.owner.current.abandoned and not handle.available
    assert db.source_row is None  # Scheduling fixture paused before native call.
