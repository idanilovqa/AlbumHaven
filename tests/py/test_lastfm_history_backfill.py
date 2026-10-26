"""Source-authored, UNRUN. Real plan owner; declared storage/provider doubles.

These exercise durable state-machine seams, not PostgreSQL locks or live API
compatibility. Reader's strict evidence parser has separate source tests.
"""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from music_app.services import lastfm_history_backfill as owner
from music_app.services.lastfm import LastfmSession
from music_app.services.lastfm_history_model import HistoryStale, HistoryUnavailable
from music_app.services.lastfm_history_reader import HistoryPage, HistoryRangeTooLarge

LINEAGE='2023-01-01T00:00:00+00:00'
NOW=datetime(2026,1,1,tzinfo=timezone.utc)
PLAN='11111111-1111-4111-8111-111111111111'
GEN='22222222-2222-4222-8222-222222222222'


def plan(**changes):
    return dict(id=PLAN,account_id=1,provider_username='Owner',connection_started_at=LINEAGE,
        upper_cut=999,cursor_end=999,window_seconds=1000,generation_id=GEN,state='active',
        revision=1,completed_windows=0,next_allowed_at=NOW,reason=None,failures=0,
        created_at=NOW,dense_second=False,**changes)


def generation(**changes):
    values=dict(id=GEN,account_id=1,provider_username='Owner',connection_started_at=LINEAGE,
        range_start=0,range_end=999,state='reading',reason='',next_page=1,
        lease_token=None,lease_until=None,completed_at=None,dense_second=False)
    values.update(changes);return values


class Result:
    def __init__(self, rows=()):self.rows=deepcopy(list(rows))
    def fetchone(self):return self.rows[0] if self.rows else None
    def fetchall(self):return self.rows


class DB:
    def __init__(self, state):self.s=state
    def execute(self,sql,args=()):
        self.s.sql.append((sql,args))
        if sql.startswith('update integration.lastfm_history_backfill_v1 set '):
            keys=[part.split('=')[0] for part in sql.split(' set ',1)[1].split(' where ',1)[0].split(',')]
            row=self.s.plans[args[-2]]
            assert row['account_id']==args[-1]
            row.update(zip(keys,args[:-2]));return Result([row])
        if sql.startswith('select * from integration.lastfm_history_backfill_v1'):
            if 'where id=' in sql:
                row=self.s.plans.get(args[0]);return Result([row] if row and row['account_id']==args[1] else [])
            rows=[r for r in self.s.plans.values() if r['account_id']==args[0]]
            if 'is distinct from' in sql:
                rows=[r for r in rows if r['state'] in ('active','paused','blocked')
                    and (r['provider_username'],r['connection_started_at'])!=tuple(args[1:])]
            elif 'provider_username=%s' in sql:
                rows=[r for r in rows if r['state'] in ('active','paused','blocked')
                    and (r['provider_username'],r['connection_started_at'])==tuple(args[1:])]
            return Result(rows[:5])
        if sql.startswith('select count(*)'):
            return Result([{'count':sum(g['state']=='reading' for g in self.s.generations.values())}])
        if sql.startswith('insert into integration.lastfm_history_generations_v1'):
            row=generation();row.update(zip(('id','account_id','provider_username','connection_started_at','range_start','range_end','dense_second'),args))
            self.s.generations[row['id']]=row;return Result([row])
        if sql.startswith('insert into integration.lastfm_history_backfill_v1'):
            row=plan();row.update(zip(('id','account_id','provider_username','connection_started_at','upper_cut','cursor_end','next_allowed_at'),args))
            row.update(generation_id=None,window_seconds=owner.WINDOW_SECONDS)
            self.s.plans[row['id']]=row;return Result([row])
        if sql.startswith('insert into integration.lastfm_history_pages_v1'):
            self.s.pages.append(args);return Result()
        raise AssertionError(sql)


@pytest.fixture
def system(monkeypatch):
    s=SimpleNamespace(plans={PLAN:plan()},generations={GEN:generation()},sql=[],pages=[],now=NOW,
        session=LastfmSession('Owner','',LINEAGE),read_calls=[],prepare_calls=[],commit_calls=[],release_calls=[])
    s.db=DB(s)
    class Repository:
        url='unused'
        @contextmanager
        def transaction(self,*args,**kwargs):yield s.db,SimpleNamespace(actor=SimpleNamespace(account_id=1)),s.now
        def _session(self,*args):return s.session
        def _uuid(self,value):return value
        def _owned(self,connection,account,identity):
            row=s.generations[identity]
            if row['account_id']!=account:raise HistoryStale()
            return deepcopy(row)
        def _stop(self,connection,row,reason,*,state='uncertain'):
            actual=s.generations[row['id']]
            actual.update(state=state,reason=reason,lease_token=None,lease_until=None)
            return deepcopy(actual)
        def prepare(self,context,*,generation,expected_page,constraints,plan_ticket=None):
            s.prepare_calls.append((generation,expected_page));row=s.generations[generation]
            if row['state']!='reading':return {'status':{'state':row['state']}}
            if row['lease_until'] and row['lease_until']>s.now:raise HistoryStale('busy')
            row.update(lease_token=str(uuid4()),lease_until=s.now+timedelta(seconds=30))
            return {'generation':generation,'page':expected_page,'lease':row['lease_token'],
                'session':s.session,'range_start':row['range_start'],'range_end':row['range_end'],'dense_second':row['dense_second']}
        def commit_page(self,context,*,request,page,constraints):
            s.commit_calls.append(request);row=s.generations[request['generation']]
            row.update(state='complete',lease_token=None,lease_until=None)
        def retain_unusable_page(self,connection,row,page,*,reason):
            s.pages.append(page)
            return self._stop(connection,row,reason)
        def release(self,context,*,generation,lease,constraints):
            s.release_calls.append(lease);row=s.generations[generation]
            if row['lease_token']==lease:row.update(lease_token=None,lease_until=None)
    service=object.__new__(owner.LastfmHistoryBackfill);service.config={};service.repository=Repository();s.service=service
    def reader(*args,**kwargs):s.read_calls.append(kwargs);return object()
    monkeypatch.setattr(owner,'read_history_page',reader)
    return s


def test_replayed_revision_and_backoff_are_no_io(system):
    s=system;s.plans[PLAN]['revision']=2
    assert s.service.advance(None,plan=PLAN,revision=1)['revision']==2
    s.plans[PLAN]['next_allowed_at']=NOW+timedelta(seconds=1)
    assert s.service.advance(None,plan=PLAN,revision=2)['revision']==2
    assert s.read_calls==s.prepare_calls==[]


def test_one_advance_reads_one_page_and_zero_window_completes(system):
    s=system;result=s.service.advance(None,plan=PLAN,revision=1)
    assert len(s.read_calls)==len(s.commit_calls)==1
    assert result['state']=='observed' and result['cursor_end']==-1
    assert result['completed_windows']==1 and result['complete_history'] is False
    assert result['provider_snapshot_guaranteed'] is False
    assert result['next_allowed_at']==(NOW+timedelta(seconds=2)).isoformat()


def test_committed_generation_after_crash_is_recovered_without_refetch(system):
    s=system;s.generations[GEN]['state']='complete'
    result=s.service.advance(None,plan=PLAN,revision=1)
    assert result['state']=='observed' and result['completed_windows']==1
    assert s.read_calls==s.prepare_calls==[]
    assert s.service.advance(None,plan=PLAN,revision=result['revision'])['completed_windows']==1


def test_completed_child_window_moves_cursor_without_skipping_older_half(system):
    s=system;s.plans[PLAN]['window_seconds']=500;s.generations[GEN].update(range_start=500,state='complete')
    ticket=s.service._reserve(None,plan=PLAN,revision=1,constraints=None)
    row=s.generations[ticket['generation']]
    assert row['range_start']==0 and row['range_end']==499
    assert s.plans[PLAN]['completed_windows']==1


def test_oversized_generation_crash_recovers_split_with_no_page(system):
    s=system;s.generations[GEN].update(state='uncertain',reason='range_too_large')
    result=s.service.advance(None,plan=PLAN,revision=1)
    assert result['state']=='active' and result['window_seconds']==500 and result['cursor_end']==999
    assert result['reason']=='range_split' and s.read_calls==[]


def test_single_second_budget_enters_dense_mode_without_skipping(system):
    s=system;s.plans[PLAN].update(cursor_end=0,window_seconds=1)
    s.generations[GEN].update(range_end=0,state='uncertain',reason='range_too_large')
    result=s.service.advance(None,plan=PLAN,revision=1)
    assert result['state']=='active' and result['cursor_end']==0
    assert result['reason']=='dense_second' and s.plans[PLAN]['dense_second'] is True
    resumed=s.service.resume(None,plan=PLAN,revision=result['revision'])
    assert resumed['window_seconds']==1 and resumed['cursor_end']==0


def test_reconnect_never_relabels_original_plan(system):
    s=system;s.session=LastfmSession('Other','',LINEAGE)
    result=s.service.advance(None,plan=PLAN,revision=1)
    assert result['state']=='connection_changed' and s.read_calls==[]
    assert s.plans[PLAN]['provider_username']=='Owner'
    assert s.generations[GEN]['state']=='connection_changed'


def test_new_connection_start_retires_old_open_generation_without_deleting_it(system):
    s=system;s.session=LastfmSession('Other','',LINEAGE)
    result=s.service.begin(None)
    assert result['id']!=PLAN and len(s.generations)==1
    assert s.plans[PLAN]['state']==s.generations[GEN]['state']=='connection_changed'
    assert s.plans[PLAN]['provider_username']=='Owner'


def test_start_replay_recovers_existing_plan_without_new_cut(system):
    s=system;s.now=NOW+timedelta(days=1)
    result=s.service.begin(None)
    assert result['id']==PLAN and result['upper_cut']==999
    assert len(s.plans)==1


def test_generation_scope_mismatch_fails_closed(system):
    s=system;s.generations[GEN]['provider_username']='Other'
    with pytest.raises(HistoryUnavailable):s.service.advance(None,plan=PLAN,revision=1)
    assert s.read_calls==[]


def test_failed_reads_keep_cursor_and_pause_after_four(system,monkeypatch):
    s=system
    def failure(*args,**kwargs):s.read_calls.append(kwargs);raise RuntimeError('private upstream error')
    monkeypatch.setattr(owner,'read_history_page',failure)
    revision=1
    for number in range(1,5):
        result=s.service.advance(None,plan=PLAN,revision=revision)
        assert result['cursor_end']==999 and result['reason']=='read_failed'
        assert s.plans[PLAN]['failures']==number
        revision=result['revision'];s.now=s.plans[PLAN]['next_allowed_at']
    assert result['state']=='paused' and len(s.read_calls)==4
    assert 'private' not in repr(result)


def test_busy_generation_lease_is_not_cleared_by_another_reservation(system):
    s=system;s.generations[GEN].update(lease_token='other',lease_until=NOW+timedelta(seconds=30))
    result=s.service.advance(None,plan=PLAN,revision=1)
    assert s.read_calls==s.release_calls==[]
    assert result['next_allowed_at']==(NOW+timedelta(seconds=30)).isoformat()
    assert s.generations[GEN]['lease_token']=='other'


def test_commit_success_then_uncertain_return_uses_durable_truth(system,monkeypatch):
    s=system;commit=s.service.repository.commit_page
    def uncertain(*args,**kwargs):commit(*args,**kwargs);raise RuntimeError('lost return')
    monkeypatch.setattr(s.service.repository,'commit_page',uncertain)
    result=s.service.advance(None,plan=PLAN,revision=1)
    assert result['state']=='observed' and result['completed_windows']==1
    assert len(s.read_calls)==1


def test_pause_during_normal_reply_keeps_page_but_defers_plan_progress(system,monkeypatch):
    s=system
    def reader(*args,**kwargs):
        s.service.pause(None,plan=PLAN,revision=s.plans[PLAN]['revision'])
        return object()
    monkeypatch.setattr(owner,'read_history_page',reader)
    result=s.service.advance(None,plan=PLAN,revision=1)
    assert result['state']=='paused' and s.generations[GEN]['state']=='complete'
    assert result['completed_windows']==0
    resumed=s.service.resume(None,plan=PLAN,revision=result['revision'])
    s.now=s.plans[PLAN]['next_allowed_at']
    final=s.service.advance(None,plan=PLAN,revision=resumed['revision'])
    assert final['state']=='observed' and final['completed_windows']==1


def oversized():
    return HistoryRangeTooLarge(HistoryPage(username='Owner',page=1,per_page=200,total_pages=101,
        total=20200,tracks=(),digest='a'*64,raw_xml='<validated-by-reader-double/>',observed_count=200,
        nowplaying_count=0,observed_newest=999,observed_oldest=999))


def test_pause_during_oversized_reply_preserves_evidence_then_resume_splits(system,monkeypatch):
    s=system;error=oversized()
    def parse(*args,**kwargs):raise error
    monkeypatch.setattr(owner,'parse_history_page',parse)
    def reader(*args,**kwargs):
        s.service.pause(None,plan=PLAN,revision=s.plans[PLAN]['revision'])
        raise error
    monkeypatch.setattr(owner,'read_history_page',reader)
    result=s.service.advance(None,plan=PLAN,revision=1)
    assert result['state']=='paused' and len(s.pages)==1
    assert s.generations[GEN]['state']=='uncertain'
    resumed=s.service.resume(None,plan=PLAN,revision=result['revision'])
    assert resumed['window_seconds']==500 and resumed['cursor_end']==999
    assert resumed['reason']=='range_split'


def test_forged_oversized_exception_cannot_force_split(system,monkeypatch):
    s=system;error=oversized()
    monkeypatch.setattr(owner,'parse_history_page',lambda *args,**kwargs:object())
    def reader(*args,**kwargs):raise error
    monkeypatch.setattr(owner,'read_history_page',reader)
    with pytest.raises(HistoryUnavailable):s.service.advance(None,plan=PLAN,revision=1)
    assert s.pages==[] and s.plans[PLAN]['window_seconds']==1000


@pytest.mark.parametrize('revision',[True,0,-1,'1',1.5,9223372036854775807,9223372036854775808])
def test_invalid_revision_never_touches_storage(system,revision):
    with pytest.raises(HistoryStale):system.service.advance(None,plan=PLAN,revision=revision)
    assert system.sql==[]


def test_status_is_closed_and_does_not_leak_connection_evidence(system):
    result=system.service._status(system.plans[PLAN])
    assert set(result)=={'id','state','revision','upper_cut','cursor_end','window_seconds',
        'completed_windows','next_allowed_at','reason','lower_bound','provider_snapshot_guaranteed','complete_history'}
    assert 'Owner' not in repr(result) and LINEAGE not in repr(result)


def test_unknown_stored_reason_is_not_exposed_as_private_error(system):
    system.plans[PLAN]['reason']='private provider response or path'
    result=system.service._status(system.plans[PLAN])
    assert result['reason']=='uncertain_range' and 'private' not in repr(result)


def test_resume_keeps_failed_page_and_backoff_time(system):
    s=system;s.plans[PLAN].update(state='paused',reason='read_failed',failures=4,
        next_allowed_at=NOW+timedelta(seconds=16))
    result=s.service.resume(None,plan=PLAN,revision=1)
    assert result['state']=='active' and s.plans[PLAN]['generation_id']==GEN
    assert s.generations[GEN]['next_page']==1 and s.plans[PLAN]['failures']==0
    assert result['next_allowed_at']==(NOW+timedelta(seconds=16)).isoformat()
    assert s.service.advance(None,plan=PLAN,revision=result['revision'])['revision']==result['revision']
    assert s.read_calls==[]


def test_existing_four_reading_generations_prevent_new_range(system):
    s=system;s.plans[PLAN]['generation_id']=None
    for index in range(3):
        identity=str(uuid4());s.generations[identity]=generation();s.generations[identity]['id']=identity
    with pytest.raises(HistoryStale):s.service.advance(None,plan=PLAN,revision=1)
    assert len(s.generations)==4 and s.read_calls==[]


def test_pending_uses_genuine_read_transaction_seam_not_write(system,monkeypatch):
    s=system;calls=[]
    @contextmanager
    def read_transaction(url,context,*,constraints):
        calls.append((url,context,constraints))
        yield s.db,SimpleNamespace(actor=SimpleNamespace(account_id=1)),NOW
    monkeypatch.setattr(owner,'current_lastfm_history_account_read_transaction',read_transaction)
    context=object();constraints=object()
    result=s.service.pending(context,constraints=constraints)
    assert calls==[('unused',context,constraints)]
    assert result['plans'][0]['id']==PLAN and s.read_calls==[]


def test_foreign_plan_id_is_not_admitted(system):
    system.plans[PLAN]['account_id']=9
    with pytest.raises(HistoryStale):system.service.advance(None,plan=PLAN,revision=1)
    assert system.read_calls==[]


def test_dense_second_can_advance_past_page_100_without_widening(system):
    s=system;s.plans[PLAN].update(cursor_end=0,window_seconds=1,dense_second=True)
    s.generations[GEN].update(range_end=0,dense_second=True,next_page=101)
    result=s.service.advance(None,plan=PLAN,revision=1)
    assert result['state']=='observed' and len(s.read_calls)==1
    assert s.read_calls[0]['page']==101 and s.read_calls[0]['allow_dense'] is True
    assert s.read_calls[0]['range_start']==s.read_calls[0]['range_end']==0


def test_explicit_quota_resume_preserves_dense_generation_cursor_and_replay(system):
    s=system
    s.plans[PLAN].update(state='blocked',reason='storage_quota',cursor_end=0,
        window_seconds=1,dense_second=True,next_allowed_at=NOW+timedelta(seconds=2))
    s.generations[GEN].update(state='uncertain',reason='storage_quota',range_end=0,
        dense_second=True,next_page=101,expected_pages=125,expected_total=25000,
        retained_payload_bytes=123456)
    s.pages.append('previously committed evidence')
    result=s.service.resume(None,plan=PLAN,revision=1)
    assert result['state']=='active' and result['revision']==2
    assert s.plans[PLAN]['generation_id']==GEN and len(s.generations)==1
    assert s.generations[GEN]['state']=='reading' and s.generations[GEN]['reason']==''
    assert s.generations[GEN]['next_page']==101 and s.generations[GEN]['dense_second'] is True
    assert s.generations[GEN]['expected_pages']==125 and s.generations[GEN]['expected_total']==25000
    assert s.generations[GEN]['retained_payload_bytes']==123456
    assert s.pages==['previously committed evidence'] and s.read_calls==[]
    # Replayed resume does not re-open, replace, reset, charge or read anything.
    before=len(s.sql)
    assert s.service.resume(None,plan=PLAN,revision=1)==result
    assert not any(sql.startswith('update ') for sql,_ in s.sql[before:])
    assert s.service.advance(None,plan=PLAN,revision=2)['revision']==2
    assert s.read_calls==[]
    s.now=NOW+timedelta(seconds=2)
    s.service.advance(None,plan=PLAN,revision=2)
    assert s.prepare_calls==[(GEN,101)] and len(s.read_calls)==1
    assert s.read_calls[0]['allow_dense'] is True and len(s.generations)==1
