"""Retired raw-copy maintenance at existing worker/repository seams.

Synthetic call-contract/state tests, not live PostgreSQL or concurrent proof.
"""
from copy import deepcopy
import logging

import pytest
from psycopg import OperationalError
from psycopg.errors import LockNotAvailable,QueryCanceled,InsufficientPrivilege
from psycopg_pool import PoolTimeout
from tests.py.foobar_retired_source_cleanup_testing import (
    Worker,Pool,TABLES,service,temporary,
)
from tests.py.foobar_account_service_testing import begin_prepare


@pytest.mark.parametrize('flag',[None,False,True])
def test_retired_cleanup_and_idle_timed_wait_are_independent_of_old_flag(monkeypatch,flag):
    w=Worker(monkeypatch,flag);passes=[]
    monkeypatch.setattr(temporary,'expire_temporary_sources',lambda *a,**k:passes.append(w.clock.now))
    w.script(w.advance,w.advance,w.stop);w.run()
    assert passes==[60,120,180]
    assert len(w.condition.waits)==3 and all(0<t<=60 for t in w.condition.waits)
    assert w.owner.state is service._State.QUIESCENT


@pytest.mark.parametrize('state',['FAULTED','DRAINING','QUIESCENT'])
def test_no_retired_sweep_begins_after_worker_fault_or_shutdown(monkeypatch,state):
    w=Worker(monkeypatch,True);w.owner.state=getattr(service._State,state);passes=[]
    monkeypatch.setattr(temporary,'expire_temporary_sources',lambda *a,**k:passes.append(w.clock.now))
    w.script(w.stop);w.run()
    assert passes==[] and w.condition.waits==[]
    expected=service._State.FAULTED if state=='FAULTED' else service._State.QUIESCENT
    assert w.owner.state is expected


@pytest.mark.parametrize('stage',['INTAKE','DISPATCH','RUNNING','DELIVERY'])
def test_current_upload_or_unsettled_operation_has_priority_over_maintenance(monkeypatch,stage):
    w=Worker(monkeypatch,True);ticket=begin_prepare(w.handle);op=w.owner.current
    op.stage=getattr(service._Stage,stage);passes=[]
    monkeypatch.setattr(temporary,'expire_temporary_sources',lambda *a,**k:passes.append(w.clock.now))
    if stage=='DISPATCH':w.install_dispatch(monkeypatch)
    def done():
        # Test scheduler releases its owned placeholder; no production upload
        # is forced out from under a real invocation.
        w.handle.abandon(ticket)
        if w.owner.current is not None:
            op.stage=service._Stage.DELIVERY;w.handle.abandon(ticket)
        w.stop()
    w.script(done);w.run()
    assert passes==[]
    assert w.owner.state is service._State.QUIESCENT
    if stage=='DISPATCH':assert w.events==['dispatch']


def test_spurious_notifications_do_not_repeat_or_disable_scheduled_cleanup(monkeypatch):
    w=Worker(monkeypatch,False);passes=[]
    monkeypatch.setattr(temporary,'expire_temporary_sources',lambda *a,**k:passes.append(w.clock.now))
    w.script(*(lambda:None for _ in range(4)),w.advance,w.stop);w.run()
    assert passes==[60,120]
    assert all(t is not None and 0<t<=60 for t in w.condition.waits)


def test_admission_during_unlocked_cleanup_is_dispatched_without_lost_notification(monkeypatch):
    w=Worker(monkeypatch,False);w.install_dispatch(monkeypatch)
    def sweep(*args,**kwargs):
        assert not w.condition.locked
        w.events.append('cleanup');w.admit()
    monkeypatch.setattr(temporary,'expire_temporary_sources',sweep)
    w.script(w.stop);w.run()
    assert w.events==['cleanup','admitted','dispatch']
    assert w.condition.waits==[] and w.owner.state is service._State.QUIESCENT


@pytest.mark.parametrize('phase',['acquire','probe','guard'])
@pytest.mark.parametrize('change',['drain','admission'])
def test_maintenance_yields_between_bounded_database_phases(monkeypatch,phase,change):
    w=Worker(monkeypatch,True);p=Pool(monkeypatch,w);w.install_dispatch(monkeypatch)
    def changed(actual):
        if actual!=phase:return
        p.after=None
        if change=='drain':w.stop()
        else:w.admit()
    p.after=changed;w.script(w.stop);w.run();p.check()
    assert len(p.calls)==1
    assert not p.deletes()
    if phase=='acquire':assert not p.probes()
    if phase=='probe':assert not any('for update' in sql for sql in p.sql)
    if phase in ('probe','guard'):assert p.rollbacks==1
    if change=='admission':assert w.events==['admitted','dispatch'] and w.condition.waits==[]
    assert w.owner.state is service._State.QUIESCENT


def test_cleanup_acquires_existing_pool_with_explicit_quarter_second_budget(monkeypatch):
    p=Pool(monkeypatch)
    temporary.expire_temporary_sources('synthetic:no-network')
    p.check()
    assert len(p.calls)==1 and p.calls[0].get('timeout')==0.25
    assert p.calls[0].get('workload','default')=='default'
    assert p.sql[:2]==["set local lock_timeout = '250ms'","set local statement_timeout = '1000ms'"]
    assert len(p.sql)==5 and len(p.probes())==1
    assert 'to_regclass(' in p.sql[2]
    assert p.sql[3]=='select id from integration.foobar_temporary_source_guard_v1 where id=1 for update'
    assert p.sql[4].startswith('delete from integration.foobar_temporary_sources_v1 ')
    assert len(p.deletes())==1 and p.commits==1 and p.rollbacks==0


def test_retirement_cleans_one_unexpired_raw_parent_without_imported_fact_writes(monkeypatch):
    p=Pool(monkeypatch);p.rows={1:{'expired':False,'completed':False},2:{'expired':False,'completed':False}}
    before=deepcopy(p.facts)
    temporary.expire_temporary_sources('synthetic:no-network');p.check()
    assert p.rows=={2:{'expired':False,'completed':False}} and p.chunks=={2:b'synthetic-two'}
    assert p.facts==before and len(p.deletes())==1
    assert all('foobar_import_jobs' not in sql for sql in p.sql)


def test_absent_optional_schema_retried_on_later_pass_then_bounded_cleanup(monkeypatch,caplog):
    w=Worker(monkeypatch,False);p=Pool(monkeypatch,w);p.schema.clear()
    caplog.set_level(logging.WARNING)
    def installed():p.schema=set(TABLES);w.advance()
    w.script(installed,w.stop);w.run();p.check()
    assert len(p.calls)==2 and len(p.probes())==2 and len(p.deletes())==1
    first_probe=p.sql.index(p.probes()[0]);second_probe=p.sql.index(p.probes()[1],first_probe+1)
    assert not any('for update' in sql or sql.startswith('delete ') for sql in p.sql[first_probe:second_probe])
    assert len(p.rows)==1 and not caplog.records
    assert w.owner.state is service._State.QUIESCENT


@pytest.mark.parametrize('missing',sorted(TABLES))
def test_partial_optional_schema_never_deletes_raw_rows_and_diagnoses(monkeypatch,caplog,missing):
    w=Worker(monkeypatch,False);p=Pool(monkeypatch,w);p.schema.remove(missing)
    before=deepcopy((p.rows,p.chunks,p.facts));caplog.set_level(logging.WARNING)
    w.script(w.stop);w.run();p.check()
    assert len(p.calls)==1 and len(p.probes())==1 and not p.deletes()
    assert not any('for update' in sql for sql in p.sql)
    assert (p.rows,p.chunks,p.facts)==before and w.owner.state is service._State.QUIESCENT
    assert any('partial' in r.getMessage().lower() for r in caplog.records)


def test_missing_existing_guard_row_never_deletes_and_is_not_success(monkeypatch,caplog):
    w=Worker(monkeypatch,False);p=Pool(monkeypatch,w);p.guard=False
    caplog.set_level(logging.WARNING);w.script(w.stop);w.run();p.check()
    assert len(p.probes())==1 and not p.deletes() and p.rollbacks==1
    assert any('guard' in r.getMessage().lower() for r in caplog.records)
    assert w.owner.state is service._State.QUIESCENT


@pytest.mark.parametrize('phase,error,category',[
    ('acquire',TimeoutError,'timeout'),('acquire',OSError,'unavailable'),
    ('probe',PermissionError,'denied'),('guard',TimeoutError,'timeout'),
    ('delete',TimeoutError,'timeout'),('delete',RuntimeError,'failed'),
    ('acquire',PoolTimeout,'timeout'),('acquire',OperationalError,'unavailable'),
    ('probe',InsufficientPrivilege,'denied'),('guard',LockNotAvailable,'timeout'),
    ('delete',QueryCanceled,'timeout'),
])
def test_optional_cleanup_failures_are_bounded_rolled_back_sanitized_and_recover(monkeypatch,caplog,phase,error,category):
    w=Worker(monkeypatch,False);p=Pool(monkeypatch,w)
    secret='postgres://private-user:private-password@private-host/db /private/source.sqlite account=991 raw-private-content'
    p.failure=(phase,error(secret));before=deepcopy((p.rows,p.chunks,p.facts))
    caplog.set_level(logging.INFO)
    def recover():
        assert (p.rows,p.chunks,p.facts)==before
        p.failure=None;w.advance()
    w.script(recover,w.stop);w.run();p.check()
    assert len(p.calls)==2 and all(call.get('timeout')==0.25 and call.get('workload','default')=='default' for call in p.calls)
    assert p.rollbacks==(0 if phase=='acquire' else 1)
    assert len(p.rows)==1 and p.facts==before[2]
    assert w.owner.state is service._State.QUIESCENT
    messages=[r.getMessage().lower() for r in caplog.records]
    assert sum(category in message and 'recover' not in message for message in messages)==1
    assert any('recover' in message for message in messages)
    assert all(token not in caplog.text for token in ('private-user','private-password','private-host','source.sqlite','991','raw-private-content'))
    assert all(not r.exc_info for r in caplog.records)


def test_repeated_failure_is_one_attempt_per_cadence_and_does_not_block_admission(monkeypatch,caplog):
    w=Worker(monkeypatch,False);p=Pool(monkeypatch,w);p.failure=('acquire',TimeoutError('private'))
    w.install_dispatch(monkeypatch);caplog.set_level(logging.WARNING)
    w.script(*(lambda:None for _ in range(3)),w.advance,w.admit);w.run();p.check()
    assert len(p.calls)==2 and w.events==['admitted','dispatch']
    assert w.owner.state is service._State.QUIESCENT
    assert len(caplog.records)==2


def test_new_worker_continues_remaining_legacy_backlog_without_resetting_facts(monkeypatch):
    w=Worker(monkeypatch,False);p=Pool(monkeypatch,w);before=deepcopy(p.facts)
    w.script(w.stop);w.run();p.check()
    assert len(p.rows)==1
    next_worker=Worker(monkeypatch,None);p.worker=next_worker
    next_worker.script(next_worker.stop);next_worker.run();p.check()
    assert not p.rows and not p.chunks and p.facts==before
    assert len(p.calls)==2 and len(p.deletes())==2


def test_empty_legacy_backlog_has_bounded_idle_passes_without_warning_flood(monkeypatch,caplog):
    w=Worker(monkeypatch,False);p=Pool(monkeypatch,w);p.rows.clear();p.chunks.clear()
    caplog.set_level(logging.WARNING);w.script(w.advance,w.advance,w.stop);w.run();p.check()
    assert len(p.calls)==3 and len(p.probes())==3 and len(p.deletes())==3
    assert not caplog.records and w.owner.state is service._State.QUIESCENT
