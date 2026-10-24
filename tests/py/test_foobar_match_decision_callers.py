"""Authored only: actual route/auth/CSRF/service/reconciliation/repository owners."""
import json
from dataclasses import replace
import pytest
from tests.py.foobar_account_match_testing import (
    install, command, apply, preview, m, requested_context, SOURCE, OBS, OP,
)
from tests.py.foobar_account_service_testing import s, handles, PolicyEvaluationConstraints
from tests.py.foobar_account_service_readiness_testing import install_catalog
from tests.py.foobar_account_route_testing import request, scheduler, route

OP2='99999999-9999-4999-8999-999999999999'


def begin(handle,cmd):
    ticket=handle.begin_match_apply(context=requested_context(7),
        constraints=PolicyEvaluationConstraints(),command=cmd)
    handle.owner.current.stage=s._Stage.RUNNING
    return ticket


def test_service_uncertain_ack_genuine_preview_then_exact_replay_only(monkeypatch):
    db,_=install(monkeypatch); handle,=handles(monkeypatch)
    cmd=command(); ticket=begin(handle,cmd); operation=handle.owner.current
    db.lose_ack=True
    result,outcome=s._call_bounded(handle.owner,operation)
    assert outcome is s._Outcome.SUCCESS and result.operation_ref==OP
    assert operation.command is cmd and operation.ticket is ticket
    assert db.calls.count(m._INSERT)==1 and db.calls.count(m._BIND)==1
    # First Apply postwrite verification + reconciliation Preview + second Apply.
    assert db.calls.count(m._REPLAY)==4 and db.commits==3


def test_service_max_two_attempts_only_after_genuine_unchanged_preview(monkeypatch):
    db,_=install(monkeypatch); handle,=handles(monkeypatch)
    cmd=command(); begin(handle,cmd); db.fail_sql=m._INSERT
    result,outcome=s._call_bounded(handle.owner,handle.owner.current)
    assert result is None and outcome is s._Outcome.UNAVAILABLE
    assert db.calls.count(m._INSERT)==2 and db.calls.count(m._REPLAY)==3
    assert handle.owner.current.command is cmd and not db.history


def test_service_never_adopts_preview_refreshed_pair_after_failed_attempt(monkeypatch):
    db,_=install(monkeypatch)
    original=command(); old=apply(original)
    # Simulate first attempted write unavailable at driver boundary. A genuine
    # independent committed decision supplies the newer row, not a fake preview.
    updated=preview(command(operation_ref=OP2)).command
    newer=apply(updated)
    newer_history=dict(db.history); newer_bindings=dict(db.bindings)
    db.history.pop((1,SOURCE,OP2)); db.bindings[(1,SOURCE,OBS,7)]={
        'decision_ref':old.decision_ref,'match_version':old.match_version,
        'action':old.action,'track_key':'synthetic-key'}
    pending=replace(updated,operation_ref="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    handle,=handles(monkeypatch); begin(handle,pending)
    execute=db.execute
    def failed_write(sql,params=None,**kwargs):
        if sql==m._INSERT:
            db.calls.append(sql)
            raise OSError('synthetic rolled back first attempt')
        return execute(sql,params,**kwargs)
    monkeypatch.setattr(db,'execute',failed_write)
    # Controlled scheduler backoff boundary installs concurrent committed rows.
    def wait(operation):
        db.history=dict(newer_history); db.bindings=dict(newer_bindings)
        return True
    monkeypatch.setattr(handle.owner,'wait_retry',wait)
    before=db.calls.count(m._INSERT)
    result,outcome=s._call_bounded(handle.owner,handle.owner.current)
    assert result is None and outcome is s._Outcome.UNAVAILABLE
    assert handle.owner.current.command is pending
    assert db.bindings==newer_bindings and len(db.history)==2
    assert db.calls.count(m._INSERT)==before+1


@pytest.mark.asyncio
@pytest.mark.parametrize('kind',['match-preview','match-apply'])
@pytest.mark.parametrize('failure',['missing_csrf','revoked','inactive'])
async def test_match_routes_real_auth_failures_before_body_and_admission(monkeypatch,kind,failure):
    handle,=handles(monkeypatch)
    req,auth,reads=request(monkeypatch,json.dumps(m.command_to_mapping(command())).encode(),
        handle=handle,csrf=failure!='missing_csrf')
    auth.revoked=failure=='revoked'; auth.active=failure!='inactive'
    response=await route._run(req,kind)
    assert response.status_code in (401,403) and reads[0]==0 and handle.owner.current is None


@pytest.mark.asyncio
@pytest.mark.parametrize('changed_session',[False,True])
async def test_real_match_preview_apply_routes_and_response_continuity(monkeypatch,changed_session):
    db,_=install(monkeypatch); install_catalog(monkeypatch); handle,=handles(monkeypatch)
    cmd=command()
    req,auth,reads=request(monkeypatch,json.dumps(m.command_to_mapping(cmd)).encode(),handle=handle)
    req.scope['path']='/integrations/foobar/account/match-preview'
    scheduler(monkeypatch,handle)
    response=await route.foobar_account_match_preview(req)
    assert response.status_code==200
    plan=json.loads(response.body)['result']
    assert plan['command']==m.command_to_mapping(cmd) and plan['next_match_version']==1
    assert not db.history
    req,auth,reads=request(monkeypatch,json.dumps(plan['command']).encode(),handle=handle)
    req.scope['path']='/integrations/foobar/account/match-apply'
    scheduler(monkeypatch,handle,after=(lambda:setattr(auth,'session_id',4)) if changed_session else None)
    response=await route.foobar_account_match_apply(req)
    assert response.status_code==(409 if changed_session else 200)
    assert len(db.history)==1 and handle.owner.current is None and handle.owner.next_ticket==3
    data=json.loads(response.body)
    if changed_session:
        assert 'result' not in data
    else:
        assert data['result']['command']==plan['command'] and data['result']['match_version']==1
    assert response.headers['cache-control']=='private, no-store'


@pytest.mark.asyncio
async def test_match_duplicate_command_rejected_without_service_admission(monkeypatch):
    handle,=handles(monkeypatch)
    raw=json.dumps(m.command_to_mapping(command())).encode()
    raw=raw[:-1]+b',"library_id":8}'
    req,auth,reads=request(monkeypatch,raw,handle=handle)
    response=await route.foobar_account_match_apply(req)
    assert response.status_code==400 and handle.owner.current is None
