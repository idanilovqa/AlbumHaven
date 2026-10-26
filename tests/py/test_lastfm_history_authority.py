"""UNRUN genuine account authority regressions; database/session lock doubles."""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from psycopg.pq import TransactionStatus

from music_app.services import lastfm_history_authority as authority
from music_app.services.current_actor import CurrentActor, ActorState, LibraryRelationship
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.lastfm_history_model import HistoryStale, HistoryUnavailable


def context():
    actor=CurrentActor(ActorState.ACTIVE,account_id=1,session_id=2,current_library_id=3,
        is_bootstrap_owner=True,library_relationships=(LibraryRelationship(3,'owner',True),))
    return PolicyContext.build(actor=actor,action='library.browse.read',library_id=3,
        deployment_mode='self_hosted',request_origin=RequestOrigin('internal','test'),client_surface_class='private_web')


def test_fixed_account_actions_drop_ambient_library_and_bootstrap_authority():
    write=authority.require_account_lastfm_history(context())
    read=authority.require_account_lastfm_history_read(context())
    assert write.action=='account.self.lastfm.history.write'
    assert read.action=='account.self.lastfm.history.read'
    assert write.target_account_id==1 and write.library_id is None
    assert write.actor.current_library_id is None and not write.actor.is_bootstrap_owner
    assert write.actor.library_relationships==write.actor.capability_grants==()


@pytest.mark.parametrize('actor',[
    CurrentActor.anonymous(),CurrentActor(ActorState.INACTIVE,account_id=1,session_id=2),
    CurrentActor(ActorState.ACTIVE,account_id=True,session_id=2),
    CurrentActor(ActorState.ACTIVE,account_id=1,session_id=None)])
def test_invalid_actor_cannot_acquire_account_scope(actor):
    with pytest.raises(HistoryStale):authority.require_account_lastfm_history(replace(context(),actor=actor))


def test_foreign_explicit_target_is_rejected():
    with pytest.raises(HistoryStale):authority.require_account_lastfm_history(replace(context(),target_account_id=9))


def test_deployment_or_resolver_failure_cannot_grant_access():
    with pytest.raises(HistoryStale):authority.require_account_lastfm_history(context(),PolicyEvaluationConstraints(deployment_allowed=False))
    def fail(_):raise RuntimeError('policy unavailable')
    with pytest.raises(HistoryUnavailable):authority.require_account_lastfm_history(context(),fail)
    with pytest.raises(HistoryUnavailable):authority.require_account_lastfm_history(context(),lambda _:True)


class Cursor:
    def __init__(self,rows):self.rows=rows
    def fetchmany(self,n):return self.rows[:n]
    def close(self):pass


@pytest.fixture
def locks(monkeypatch):
    state=SimpleNamespace(row={'id':1,'is_active':True,'disabled_at':None},calls=[],settled=[],expire=False)
    class Connection:
        autocommit=False
        info=SimpleNamespace(transaction_status=TransactionStatus.INTRANS)
        def execute(self,sql,params=()):
            state.calls.append(('sql',sql,params));return Cursor([state.row])
    @contextmanager
    def pool(url):
        assert url=='unused'
        try:
            yield Connection()
        except Exception:
            state.settled.append('rollback');raise
        else:state.settled.append('commit')
    def lock(connection,**kwargs):
        state.calls.append(('session',kwargs['actor_account_id'],kwargs['actor_session_id']))
        if state.expire and len([c for c in state.calls if c[0]=='session'])==2:
            raise authority.RecentAuthenticationRequired()
        return datetime.now(timezone.utc)
    monkeypatch.setattr(authority,'pooled_connection',pool)
    monkeypatch.setattr(authority,'lock_current_actor_session',lock)
    return state


def test_actual_transaction_locks_account_then_native_session_and_rechecks(locks):
    with authority.current_lastfm_history_account_transaction('unused',context()) as (_,live,_):
        assert live.actor.account_id==1
    assert locks.settled==['commit']
    account_index=next(i for i,c in enumerate(locks.calls) if c[0]=='sql' and 'from app.accounts' in c[1])
    session_indexes=[i for i,c in enumerate(locks.calls) if c[0]=='session']
    assert account_index<session_indexes[0]<session_indexes[1]


@pytest.mark.parametrize('field,value',[('id',2),('is_active',False),('disabled_at','disabled')])
def test_durable_account_state_denies_before_yield(locks,field,value):
    locks.row[field]=value
    with pytest.raises(HistoryStale):
        with authority.current_lastfm_history_account_transaction('unused',context()):pytest.fail('must not enter')
    assert locks.settled==['rollback']


def test_session_expiry_at_exit_rolls_back(locks):
    locks.expire=True
    with pytest.raises(HistoryStale):
        with authority.current_lastfm_history_account_transaction('unused',context()):pass
    assert locks.settled==['rollback']


def test_constraint_recheck_denial_rolls_back(locks):
    count=0
    def constraint(_):
        nonlocal count
        count+=1
        return PolicyEvaluationConstraints(request_origin_allowed=count<3)
    with pytest.raises(HistoryStale):
        with authority.current_lastfm_history_account_transaction('unused',context(),constraints=constraint):pass
    assert locks.settled==['rollback']
