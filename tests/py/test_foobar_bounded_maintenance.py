"""Authored only. Genuine owner/Prepare/Apply over the retained SQL driver.

The fixed-query adapter models metadata DML and rollback, not PostgreSQL plans,
triggers, locks, catalog deparser behavior or runtime memory.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
import json
import pytest
from music_app.services import foobar_account_import_maintenance as m
from tests.py.foobar_account_import_jobs_testing import *


def install_maintenance(monkeypatch):
    db=install(monkeypatch)
    execute,dispatch,pool=db.execute,db.dispatch,db.pool
    state={'ready':True,'fail_after_tombstone':False,'maintenance_calls':[]}
    def wrapped_execute(sql,params=None,**kwargs):
        if sql in (m._INDEXES,m.import_readiness._SCHEMA_SQL):
            db.calls.append(sql)
            field='ready' if sql==m._INDEXES else 'structural_ready'
            return db.cursor([{field:state['ready']}])
        return execute(sql,params,**kwargs)
    def wrapped_dispatch(sql,params):
        known=(m._CANDIDATES.format(after=''),m._CANDIDATES.format(after=m._AFTER),
            m._JOB_OWNER,m._KEYS,m._TOMBSTONE,m._DELETE_RECEIPT,m._OLDEST_RECEIPT,
            m._OLDEST_JOB.format(state='claimed'),m._OLDEST_JOB.format(state='ready'),
            m._RETIRE,m._RETIRED_KEYS,m._DELETE_KEY)
        if sql not in known:return dispatch(sql,params)
        x=json.loads(params[0]);scope=(x['account_id'],x['source_ref'])
        assert x['account_id']==db.tx_account and scope in db.locked_sources
        state['maintenance_calls'].append((sql,deepcopy(x)))
        receipts=[r for r in db.receipts.values() if tuple(r['header'][i] for i in (0,3))==scope]
        attempts=[(k,a) for k,a in db.attempts.items() if k[:2]==scope]
        if sql.startswith(m._CANDIDATES.split('{after}')[0]):
            rows=[dict(expires_at=r['expires_at'],generation=r['header'][4],receipt_ref=r['receipt_ref'],
                prepare_key=r['prepare_key'],apply_key=r['apply_key'],state=r['state'],
                created_at=r['created_at'],ready_until=r['ready_until'],committed_at=r['committed_at'])
                for r in receipts if m._timestamp(r['expires_at'])<=x['observed_at']]
            order=lambda r:(m._timestamp(r['expires_at']),r['generation'],r['receipt_ref'])
            if 'expires_at' in x:rows=[r for r in rows if order(r)>(x['expires_at'],x['generation'],x['receipt_ref'])]
            return sorted(rows,key=order)[:21]
        if sql==m._JOB_OWNER:
            return [dict(job_ref=k[2],batch_no=a['batch_no'],attempt_no=a['attempt_no'])
                for k,a in attempts if a['generation']==x['generation'] and a['prepare_key']==x['prepare_key']]
        if sql==m._KEYS:
            return sorted([dict(request_key=k,**{n:v[n] for n in ('operation','state','receipt_ref','original_receipt_ref')})
                for k,v in db.keys.items() if db.key_scopes[k]==scope+(x['generation'],)
                and v['original_receipt_ref']==x['receipt_ref']],key=lambda r:r['operation'])[:3]
        if sql==m._TOMBSTONE:
            k=db.keys[x['request_key']]
            assert k['state']=='active' and k['receipt_ref']==x['receipt_ref']
            k.update(state='tombstone',receipt_ref=None)
            db.key_times[x['request_key']].update(retired_at=db.now,retired_reason='expired')
            return [{'request_key':x['request_key']}]
        if sql==m._DELETE_RECEIPT:
            if state['fail_after_tombstone']:raise OSError('synthetic delete failure')
            r=db.receipts[x['receipt_ref']]
            assert m._timestamp(r['expires_at'])<=x['observed_at']
            assert all(k['receipt_ref']!=x['receipt_ref'] for k in db.keys.values())
            del db.receipts[x['receipt_ref']]
            if db.receipt is r:db.receipt=None
            return [{'receipt_ref':x['receipt_ref']}]
        if sql==m._OLDEST_RECEIPT:
            return [] if not receipts else [{'generation':min(r['header'][4] for r in receipts)}]
        if sql in (m._OLDEST_JOB.format(state='claimed'),m._OLDEST_JOB.format(state='ready')):
            kind='claimed' if "a.state='claimed'" in sql else 'ready'
            values=[a['generation'] for _,a in attempts if a['state']==kind]
            return [] if not values else [{'generation':min(values)}]
        if sql==m._RETIRE:
            assert db.retired_through<=x['floor']<db.current_generation
            db.retired_through=x['floor'];return [{'retired_through':x['floor']}]
        if sql==m._RETIRED_KEYS:
            return sorted([dict(generation=db.key_scopes[k][2],request_key=k,state=v['state'])
                for k,v in db.keys.items() if db.key_scopes[k][:2]==scope and db.key_scopes[k][2]<=x['floor']],
                key=lambda r:(r['generation'],r['request_key']))[:101]
        if sql==m._DELETE_KEY:
            assert db.keys[x['request_key']]['state']=='tombstone'
            assert x['generation']<=db.retired_through
            for attr in ('keys','key_scopes','key_times'):getattr(db,attr).pop(x['request_key'])
            return [{'request_key':x['request_key']}]
        raise AssertionError('Unhandled maintenance SQL')
    @contextmanager
    def rollback_fence(url):
        floor=db.retired_through;commits=db.commits
        try:
            with pool(url) as value:yield value
        except BaseException:
            # The retained boundary models table rollback; extend only the new
            # scalar retirement field, not the actual transaction owner.
            if db.commits==commits:db.retired_through=floor
            raise
    monkeypatch.setattr(db,'execute',wrapped_execute)
    monkeypatch.setattr(db,'dispatch',wrapped_dispatch)
    monkeypatch.setattr(account_authority,'pooled_connection',rollback_fence)
    return db,state


def maintain(ctx,source=SOURCE,cursor=None):
    return m.maintain_foobar_source(URL,ctx,request=m.MaintenanceRequest(source,cursor))


def age(db,days=10):
    db.now+=timedelta(days=days)
    db.current_generation+=days


def test_actual_confirmed_receipt_expires_without_source_or_checkpoint_loss(monkeypatch):
    db,state=install_maintenance(monkeypatch)
    ctx,cmd,batch,upload=start(db)
    try:
        prepare(ctx,batch,upload);batch=status(ctx,cmd).current_batch;apply(ctx,batch)
        before=deepcopy((db.source_rows,db.source_versions,db.history_projections,db.attempts,db.job_rows))
        age(db);result=maintain(ctx)
        assert result.inspected==result.removed_receipts==1 and result.protected_receipts==0
        assert result.removed_keys==2 and not db.receipts and not db.keys
        assert before==(db.source_rows,db.source_versions,db.history_projections,db.attempts,db.job_rows)
        recovered=status(ctx,cmd)
        assert recovered.confirmed_through==cmd.total_rows
        assert recovered.current_batch is None
        assert not any('foobar_import_revisions_v2' in sql or 'foobar_history' in sql
            for sql,_ in state['maintenance_calls'])
    finally:upload.close()


def test_expired_ready_job_is_protected_and_generation_cannot_cross_it(monkeypatch):
    db,_=install_maintenance(monkeypatch);ctx,cmd,batch,upload=start(db)
    try:
        prepare(ctx,batch,upload);before=deepcopy((db.receipts,db.keys,db.attempts,db.job_rows))
        age(db);result=maintain(ctx)
        assert result.protected_receipts==1 and result.removed_receipts==result.removed_keys==0
        assert result.retired_through<batch.prepare_command.generation
        assert before==(db.receipts,db.keys,db.attempts,db.job_rows)
    finally:upload.close()


def test_claimed_job_without_receipt_also_blocks_retirement(monkeypatch):
    db,_=install_maintenance(monkeypatch);ctx,cmd,batch,upload=start(db)
    try:
        age(db);result=maintain(ctx)
        assert result.inspected==0 and result.retired_through<batch.prepare_command.generation
        assert row(db,cmd,batch)['state']=='claimed'
    finally:upload.close()


def test_tombstone_and_delete_are_one_real_transaction(monkeypatch):
    db,state=install_maintenance(monkeypatch);ctx,cmd,batch,upload=start(db)
    try:
        prepare(ctx,batch,upload);apply(ctx,status(ctx,cmd).current_batch);age(db)
        before=snapshot(db);floor=db.retired_through;state['fail_after_tombstone']=True
        with pytest.raises(OSError):maintain(ctx)
        assert snapshot(db)==before and db.retired_through==floor
        assert any(sql==m._TOMBSTONE for sql,_ in state['maintenance_calls'])
    finally:upload.close()


def test_partial_schema_fails_before_metadata_mutation(monkeypatch):
    db,state=install_maintenance(monkeypatch);state['ready']=False
    with pytest.raises(m.SourceUnavailable):maintain(requested_context(None))
    assert not state['maintenance_calls']


def test_bounded_expiry_cursor_reaches_all_receipts_without_recounting_history(monkeypatch):
    db,_=install_maintenance(monkeypatch)
    for i in range(41):
        ctx,cmd,batch,upload=start(db,job_ref='55555555-5555-4555-8555-%012x'%(i+1))
        try:prepare(ctx,batch,upload);apply(ctx,status(ctx,cmd).current_batch)
        finally:upload.close()
    before=deepcopy((db.source_rows,db.source_versions,db.history_projections,db.attempts,db.job_rows))
    age(db);first=maintain(ctx);second=maintain(ctx,cursor=first.next_cursor)
    third=maintain(ctx,cursor=second.next_cursor)
    assert [r.inspected for r in (first,second,third)]==[20,20,1]
    assert first.next_cursor and second.next_cursor and third.next_cursor is None
    assert sum(r.removed_receipts for r in (first,second,third))==41
    assert sum(r.removed_keys for r in (first,second,third))==82
    assert before==(db.source_rows,db.source_versions,db.history_projections,db.attempts,db.job_rows)
    assert not db.receipts and not db.keys


def test_lost_commit_ack_is_not_retried_and_fresh_pass_reports_only_current_work(monkeypatch):
    db,state=install_maintenance(monkeypatch);ctx,cmd,batch,upload=start(db)
    try:
        prepare(ctx,batch,upload);apply(ctx,status(ctx,cmd).current_batch);age(db)
        commits=db.commits;db.lose_ack=True
        with pytest.raises(OSError):maintain(ctx)
        assert db.commits==commits+1 and not db.receipts and not db.keys
        first_dml=len([1 for sql,_ in state['maintenance_calls'] if sql==m._DELETE_RECEIPT])
        result=maintain(ctx)
        assert result.inspected==result.removed_receipts==result.removed_keys==0
        assert len([1 for sql,_ in state['maintenance_calls'] if sql==m._DELETE_RECEIPT])==first_dml
        assert status(ctx,cmd).confirmed_through==cmd.total_rows
    finally:upload.close()


def test_corrupt_confirmed_checkpoint_cannot_license_receipt_expiry(monkeypatch):
    db,_=install_maintenance(monkeypatch);ctx,cmd,batch,upload=start(db)
    try:
        prepare(ctx,batch,upload);apply(ctx,status(ctx,cmd).current_batch);age(db)
        db.job_rows[(1,SOURCE,cmd.job_ref)]['confirmed_through']=0
        db.job_rows[(1,SOURCE,cmd.job_ref)]['next_batch_no']=1
        before=deepcopy((db.receipts,db.keys,db.attempts))
        with pytest.raises(m.SourceUnavailable):maintain(ctx)
        assert before==(db.receipts,db.keys,db.attempts)
    finally:upload.close()


def test_read_only_or_revoked_account_cannot_run_maintenance(monkeypatch):
    db,state=install_maintenance(monkeypatch)
    db.accounts[1]=False
    with pytest.raises(jobs.SourceStale):maintain(requested_context(None))
    assert not state['maintenance_calls']


@pytest.mark.parametrize('cursor',[m.MaintenanceCursor('bad',1,SOURCE),
    m.MaintenanceCursor('2026-10-23T00:00:00.000000+00:00',True,SOURCE),
    m.MaintenanceCursor('2026-10-23T00:00:00.000000+00:00',1,'bad')])
def test_malformed_cursor_is_rejected_before_checkout(cursor):
    with pytest.raises(jobs.gate.PrepareInvalid):m.validate_request(m.MaintenanceRequest(SOURCE,cursor))


def test_retired_key_101_sentinel_limits_delete_to_100_then_explicit_continuation(monkeypatch):
    db,state=install_maintenance(monkeypatch)
    for i in range(51):
        ctx,cmd,batch,upload=start(db,job_ref='77777777-7777-4777-8777-%012x'%(i+1))
        try:prepare(ctx,batch,upload);apply(ctx,status(ctx,cmd).current_batch)
        finally:upload.close()
    before=deepcopy((db.source_rows,db.source_versions,db.history_projections,db.attempts,db.job_rows))
    age(db)
    first=maintain(ctx);second=maintain(ctx,cursor=first.next_cursor)
    third=maintain(ctx,cursor=second.next_cursor)
    assert [r.removed_receipts for r in (first,second,third)]==[20,20,11]
    assert first.removed_keys==second.removed_keys==0
    assert third.removed_keys==100 and third.more_retired_keys is True
    assert third.next_cursor is None and len(db.keys)==2
    assert 'limit 101' in m._RETIRED_KEYS
    fourth=maintain(ctx)
    assert fourth.inspected==fourth.removed_receipts==0
    assert fourth.removed_keys==2 and fourth.more_retired_keys is False
    assert not db.keys and not db.receipts
    assert before==(db.source_rows,db.source_versions,db.history_projections,db.attempts,db.job_rows)
    assert len([1 for sql,_ in state['maintenance_calls'] if sql==m._DELETE_KEY])==102


def test_other_authenticated_account_cannot_expire_first_accounts_source(monkeypatch):
    db,state=install_maintenance(monkeypatch);ctx,cmd,batch,upload=start(db)
    try:
        prepare(ctx,batch,upload);apply(ctx,status(ctx,cmd).current_batch);age(db)
        other=replace(ctx,actor=replace(ctx.actor,account_id=2,session_id=5),target_account_id=2)
        before=snapshot(db)
        with pytest.raises((jobs.SourceStale,m.SourceUnavailable)):maintain(other,SOURCE)
        assert snapshot(db)==before and not state['maintenance_calls']
    finally:upload.close()


def test_cleanup_preserves_other_sources_and_other_accounts_metadata(monkeypatch):
    db,_=install_maintenance(monkeypatch);ctx,cmd,batch,upload=start(db)
    try:
        prepare(ctx,batch,upload);apply(ctx,status(ctx,cmd).current_batch)
        own=next(iter(db.receipts.values()))
        foreign_receipts={};foreign_keys={};foreign_scopes={};foreign_times={}
        # Existing foreign metadata is synthetic persisted state. Its payload
        # is never admitted/used as a proof by this operation's genuine owner.
        for i,(account,source) in enumerate(((1,OTHER_SOURCE),(2,OTHER_SOURCE)),1):
            receipt=deepcopy(own)
            ref='88888888-8888-4888-8888-%012x'%i
            header=list(receipt['header']);header[0]=account;header[3]=source
            receipt.update(header=tuple(header),receipt_ref=ref)
            for j,role in enumerate(('prepare','apply'),1):
                key='99999999-9999-4999-8999-%012x'%(i*10+j)
                original_key=own[role+'_key'];value=deepcopy(db.keys[original_key])
                value.update(receipt_ref=ref,original_receipt_ref=ref)
                foreign_keys[key]=value;foreign_scopes[key]=(account,source,header[4])
                foreign_times[key]=deepcopy(db.key_times[original_key]);receipt[role+'_key']=key
            foreign_receipts[ref]=receipt
        db.receipts.update(deepcopy(foreign_receipts));db.keys.update(deepcopy(foreign_keys))
        db.key_scopes.update(deepcopy(foreign_scopes));db.key_times.update(deepcopy(foreign_times))
        age(db);result=maintain(ctx)
        assert result.removed_receipts==1 and result.removed_keys==2
        assert db.receipts==foreign_receipts and db.keys==foreign_keys
        assert db.key_scopes==foreign_scopes and db.key_times==foreign_times
    finally:upload.close()


def test_inconsistent_unconfirmed_attempt_does_not_license_committed_receipt_expiry(monkeypatch):
    db,_=install_maintenance(monkeypatch);ctx,cmd,batch,upload=start(db)
    try:
        prepare(ctx,batch,upload);batch=status(ctx,cmd).current_batch;apply(ctx,batch)
        assert next(iter(db.receipts.values()))['state']=='committed'
        # Deliberate contradictory stored proof, NOT a normal lost-ack state:
        # actual Apply confirms the checkpoint atomically with the receipt.
        row(db,cmd,batch).update(state='ready',terminal_bytes=None,terminal_sha256=None,committed_revision=None)
        before=deepcopy((db.receipts,db.keys,db.attempts,db.job_rows))
        age(db);result=maintain(ctx)
        assert result.inspected==result.protected_receipts==1
        assert result.removed_receipts==result.removed_keys==0
        assert result.retired_through<batch.prepare_command.generation
        assert before==(db.receipts,db.keys,db.attempts,db.job_rows)
    finally:upload.close()
