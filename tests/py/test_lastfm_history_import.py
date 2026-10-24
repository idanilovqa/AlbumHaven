"""Authored source-only regressions over genuine importer/repository methods."""
from contextlib import contextmanager
from collections import Counter
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from types import SimpleNamespace

import pytest

from music_app.services import lastfm_history_import as orchestration
from music_app.services.lastfm import LastfmSession
from music_app.services.lastfm_history_model import HistoryStale, HistoryUnavailable, tuple_digest
from music_app.services.lastfm_history_postgres import LastfmHistoryRepository, observation_coverage
from music_app.services.lastfm_history_reader import parse_history_page

GEN='11111111-1111-4111-8111-111111111111'
LEASE='22222222-2222-4222-8222-222222222222'
LINEAGE='2023-01-01T00:00:00+00:00'
TIME=1700000000
SESSION=LastfmSession('Owner','',LINEAGE)


def page(number=1,total=1,timestamp=TIME,*,dense=False):
    count=min(200,total-(number-1)*200)
    tracks=''.join(f'<track><artist>Artist</artist><name>Track</name><album>Album</album>'
        f'<date uts="{timestamp}">date</date></track>' for _ in range(count))
    xml=(f'<lfm status="ok"><recenttracks user="Owner" page="{number}" perPage="200" '
         f'totalPages="{(total+199)//200}" total="{total}">{tracks}</recenttracks></lfm>').encode()
    return parse_history_page(xml,username='Owner',range_start=TIME if dense else TIME-10,range_end=TIME if dense else TIME+10,
        page=number,allow_dense=dense)


def generation(**changes):
    return dict(id=GEN,account_id=1,provider_username='Owner',connection_started_at=LINEAGE,
        range_start=TIME-10,range_end=TIME+10,next_page=1,expected_pages=None,expected_total=None,
        state='reading',reason='',lease_token=LEASE,lease_until=None,dense_second=False,retained_payload_bytes=0,**changes)


class Result:
    def __init__(self,rows):self.rows=rows
    def fetchone(self):return self.rows[0] if self.rows else None
    def fetchall(self):return self.rows
    def fetchmany(self,n):return self.rows[:n]


class Connection:
    def __init__(self,row=None):
        self.row=row or generation();self.calls=[];self.pages=[];self.promoted=[];self.session=SESSION;self.plans=[];self.summaries={};self.account_used=0
    @contextmanager
    def transaction(self):
        saved=deepcopy((self.row,self.pages,self.promoted,self.summaries,self.account_used))
        try:yield
        except Exception:
            self.row,self.pages,self.promoted,self.summaries,self.account_used=saved
            raise
    @contextmanager
    def cursor(self,*,name):
        connection=self
        class Cursor:
            def execute(self,sql,params):
                counts=Counter((item['timestamp'],item['artist'],item['track'],item['album'])
                    for page in connection.pages for item in page['tracks'])
                self.groups=[dict(played_at=k[0],artist=k[1],track=k[2],album=k[3],occurrences=n)
                    for k,n in sorted(counts.items())];self.offset=0
            def fetchmany(self,size):
                values=self.groups[self.offset:self.offset+size];self.offset+=len(values);return values
        yield Cursor()
    def execute(self,sql,params=()):
        self.calls.append((sql,params))
        if sql.startswith('select id') and 'from integration.lastfm_history_backfill_v1' in sql:
            return Result(self.plans)
        if sql.startswith('select history_retained_payload_bytes as used'):
            return Result([{'used':self.account_used}])
        if sql.startswith('update integration.lastfm_settings set history_retained_payload_bytes='):
            self.account_used+=params[0];return Result([{'account_id':params[1]}])
        if sql.startswith('update integration.lastfm_history_generations_v1 set summary_complete='):
            self.row['summary_complete']=True;return Result([])
        if sql.startswith('insert into integration.lastfm_history_generation_tuples_v1'):
            rows=json.loads(params[1]);inserted=[]
            for row in rows:
                key=(params[0],row['played_at'],row['tuple_digest'])
                if key not in self.summaries:
                    self.summaries[key]=row;inserted.append({'payload_bytes':len(json.dumps(row).encode())})
            return Result(inserted)
        if sql.startswith('select s.played_at,s.tuple_digest'):
            rows=json.loads(params[0]);return Result([self.summaries[(params[1],r['played_at'],r['tuple_digest'])] for r in rows])
        if sql.startswith('update integration.lastfm_history_generations_v1 set retained_payload_bytes='):
            self.row['retained_payload_bytes']+=params[0];return Result([])
        if sql.startswith('select count(*) as pages'):
            return Result([{'pages':len(self.pages),'observed':sum(item['observed_count'] for item in self.pages)}])
        if sql.startswith("select (page_data->>'observed_oldest')"):
            values=[p for p in self.pages if p['page']==params[1]]
            return Result([{'oldest':values[0]['observed_oldest']}] if values else [])
        if sql.startswith('select * from integration.lastfm_history_generations_v1') and 'not exists' in sql:
            return Result([])
        if sql.startswith('select * from integration.lastfm_history_generations_v1'):
            return Result([self.row] if params[1]==self.row['account_id'] else [])
        if sql.startswith('select s.provider_username'):
            return Result([dict(provider_username=self.session.username,connected_at=self.session.connected_at)])
        if sql.startswith('insert into integration.lastfm_history_pages_v1'):
            self.pages.append(json.loads(params[4]));return Result([{'payload_bytes':len(params[3].encode())+len(params[4].encode())}])
        if sql.startswith('select page_data'):
            return Result([{'page_data':item} for item in self.pages])
        if sql.startswith('update integration.lastfm_history_generations_v1 set state='):
            self.row.update(state=params[0],reason=params[1],lease_token=None,lease_until=None);return Result([])
        if sql.startswith('update integration.lastfm_history_generations_v1 set next_page='):
            self.row.update(next_page=params[0],expected_pages=params[1],expected_total=params[2],state=params[3]);return Result([self.row])
        if sql.startswith('insert into integration.lastfm_history_occurrences_v1'):
            incoming=json.loads(params[-1]);existing={(r['played_at'],r['tuple_digest'],r['ordinal']) for r in self.promoted}
            new=[r for r in incoming if (r['played_at'],r['tuple_digest'],r['ordinal']) not in existing]
            self.promoted.extend(new);return Result([{'payload_bytes':len(json.dumps(row).encode())} for row in new])
        return Result([])


def repository(connection):
    repo=LastfmHistoryRepository({'ALBUM_HAVEN_APP_DATABASE_URL':'unused'})
    @contextmanager
    def transaction(context,constraints=None):
        yield connection,SimpleNamespace(actor=SimpleNamespace(account_id=1)),datetime.now(timezone.utc)
    repo.transaction=transaction
    return repo


def request():
    return dict(generation=GEN,page=1,lease=LEASE,session=SESSION,range_start=TIME-10,range_end=TIME+10)


def test_actual_commit_persists_raw_page_before_ordinal_promotion():
    connection=Connection();repo=repository(connection)
    result=repo.commit_page(None,request=request(),page=page())
    assert result['state']=='complete'
    assert connection.pages[0]['observed_count']==1
    assert connection.promoted[0]['ordinal']==1
    assert connection.promoted[0]['played_at']==TIME
    statements=[sql for sql,_ in connection.calls]
    assert next(i for i,s in enumerate(statements) if 'insert into integration.lastfm_history_pages' in s)<next(
        i for i,s in enumerate(statements) if 'insert into integration.lastfm_history_occurrences' in s)
    assert not any('delete ' in sql.lower() for sql in statements)


def test_same_second_page_promotes_two_ordinals_not_one():
    connection=Connection();repository(connection).commit_page(None,request=request(),page=page(total=2))
    assert [row['ordinal'] for row in connection.promoted]==[1,2]
    assert len({row['tuple_digest'] for row in connection.promoted})==1


def test_committed_cursor_replay_does_not_fetch_connection_or_provider():
    connection=Connection();connection.row.update(next_page=2,state='complete')
    result=repository(connection).prepare(None,generation=GEN,expected_page=1)
    assert result['status']['replay'] is True
    assert not any(sql.startswith('select s.provider_username') for sql,_ in connection.calls)
    assert not any(sql.startswith('update ') for sql,_ in connection.calls)


def test_foreign_generation_never_returns_a_row():
    connection=Connection();connection.row['account_id']=2
    with pytest.raises(HistoryStale):repository(connection).prepare(None,generation=GEN,expected_page=1)


def test_reconnect_between_read_and_commit_stops_without_promotion():
    connection=Connection();connection.session=LastfmSession('Other','',LINEAGE)
    result=repository(connection).commit_page(None,request=request(),page=page())
    assert result['state']=='connection_changed'
    assert connection.pages==[] and connection.promoted==[]


def test_new_lease_rejects_old_response_without_advancing():
    connection=Connection();connection.row['lease_token']='33333333-3333-4333-8333-333333333333'
    with pytest.raises(HistoryStale):repository(connection).commit_page(None,request=request(),page=page())
    assert connection.pages==[] and connection.row['next_page']==1


def test_live_lease_prevents_parallel_provider_read():
    connection=Connection();connection.row['lease_until']=datetime.now(timezone.utc)+timedelta(seconds=20)
    with pytest.raises(HistoryStale):repository(connection).prepare(None,generation=GEN,expected_page=1)


def test_changed_pagination_keeps_raw_page_but_does_not_promote():
    connection=Connection();connection.row.update(expected_pages=1,expected_total=200)
    result=repository(connection).commit_page(None,request=request(),page=page(total=201))
    assert result['state']=='uncertain' and result['reason']=='pagination_changed'
    assert len(connection.pages)==1 and connection.promoted==[]


def test_actual_service_calls_bounded_reader_then_commit(monkeypatch):
    service=orchestration.LastfmHistoryImport({'ALBUM_HAVEN_APP_DATABASE_URL':'unused'})
    calls=[]
    service.repository=SimpleNamespace(prepare=lambda *a,**k:request(),
        commit_page=lambda *a,**k:calls.append(('commit',k['page'])) or {'state':'complete'})
    monkeypatch.setattr(orchestration,'read_history_page',lambda *a,**k:calls.append(('read',k)) or page())
    assert service.advance(None,generation=GEN,page=1)['state']=='complete'
    assert [name for name,_ in calls]==['read','commit']
    assert calls[0][1]['session'] is SESSION


def test_read_failure_releases_only_own_lease_and_never_commits(monkeypatch):
    service=orchestration.LastfmHistoryImport({'ALBUM_HAVEN_APP_DATABASE_URL':'unused'});calls=[]
    service.repository=SimpleNamespace(prepare=lambda *a,**k:request(),
        release=lambda *a,**k:calls.append(k),commit_page=lambda *a,**k:pytest.fail('must not commit'))
    def fail(*args,**kwargs):raise OSError('offline')
    monkeypatch.setattr(orchestration,'read_history_page',fail)
    with pytest.raises(OSError):service.advance(None,generation=GEN,page=1)
    assert calls[0]['lease']==LEASE


@pytest.mark.parametrize('rows,state,covered',[
    ([], 'not_imported',False),
    ([{'state':'reading','range_start':10,'range_end':20}],'reading',False),
    ([{'state':'uncertain','range_start':10,'range_end':20}],'uncertain',False),
    ([{'state':'complete','range_start':10,'range_end':20}],'observed_range',True),
    ([{'state':'complete','range_start':10,'range_end':14}],'partial',False)])
def test_coverage_distinguishes_unimported_failed_partial_and_observed_zero(rows,state,covered):
    result=observation_coverage(rows,10,20)
    assert result['state']==state and result['requested_range_has_completed_observations'] is covered
    assert result['complete_history'] is False and result['provider_snapshot_guaranteed'] is False


# New dense/quota regressions. SQL, transactions and provider are explicit doubles;
# assertions call the actual repository/service. These tests are authored, unrun.
PLAN='44444444-4444-4444-8444-444444444444'


def dense_connection():
    connection=Connection()
    connection.row.update(range_start=TIME,range_end=TIME,dense_second=True,next_page=101)
    connection.plans=[dict(id=PLAN,revision=7,state='active')]
    return connection


def ticket(**changes):
    result=dict(plan=PLAN,revision=7,generation=GEN,page=101);result.update(changes);return result


def test_stored_dense_second_allows_page_101_with_current_internal_ticket():
    connection=dense_connection()
    prepared=repository(connection).prepare(None,generation=GEN,expected_page=101,plan_ticket=ticket())
    assert prepared['dense_second'] is True and prepared['page']==101
    assert prepared['range_start']==prepared['range_end']==TIME


@pytest.mark.parametrize('bad',[None,{},ticket(revision=6),ticket(page=True),ticket(plan=GEN)])
def test_plan_generation_cannot_bypass_revision_through_manual_prepare(bad):
    connection=dense_connection()
    with pytest.raises(HistoryStale):
        repository(connection).prepare(None,generation=GEN,expected_page=101,plan_ticket=bad)
    assert not any(sql.startswith('update ') for sql,_ in connection.calls)


def test_normal_generation_cannot_request_dense_page_number():
    connection=Connection();connection.row['next_page']=101
    with pytest.raises(HistoryStale):repository(connection).prepare(None,generation=GEN,expected_page=101)


def test_stored_dense_flag_requires_exact_single_second():
    connection=dense_connection();connection.row['range_end']+=1
    with pytest.raises(HistoryUnavailable):
        repository(connection).prepare(None,generation=GEN,expected_page=101,plan_ticket=ticket())


def test_manual_abandon_cannot_mutate_plan_owned_generation():
    connection=dense_connection()
    with pytest.raises(HistoryStale):repository(connection).abandon(None,generation=GEN)
    assert connection.row['state']=='reading'


def test_manual_pending_excludes_plan_owned_generations(monkeypatch):
    from music_app.services import lastfm_history_authority as authority
    connection=Connection()
    @contextmanager
    def read_transaction(*args,**kwargs):
        yield connection,SimpleNamespace(actor=SimpleNamespace(account_id=1)),datetime.now(timezone.utc)
    monkeypatch.setattr(authority,'current_lastfm_history_account_read_transaction',read_transaction)
    # This assertion checks the actual query fence, not a simulated SQL planner.
    repository(connection).pending(None)
    sql=connection.calls[-1][0]
    assert 'not exists' in sql and 'b.generation_id=lastfm_history_generations_v1.id' in sql


@pytest.mark.parametrize('flag',[True,1,None])
def test_commit_rejects_client_dense_flag_for_normal_generation(flag):
    connection=Connection();incoming=request();incoming['dense_second']=flag
    with pytest.raises(HistoryStale):repository(connection).commit_page(None,request=incoming,page=page())
    assert connection.pages==[] and connection.promoted==[]


def test_page_quota_failure_rolls_back_incoming_page_and_keeps_previous_evidence():
    connection=Connection();connection.pages=[{'prior':'retained'}]
    connection.row['retained_payload_bytes']=100;connection.account_used=100
    repo=repository(connection);repo.payload_quota=101
    result=repo.commit_page(None,request=request(),page=page())
    assert result['state']=='uncertain' and result['reason']=='storage_quota'
    assert connection.pages==[{'prior':'retained'}] and connection.promoted==[]
    assert connection.row['retained_payload_bytes']==100 and connection.row['next_page']==1


def test_promotion_quota_failure_rolls_back_page_and_all_new_occurrences():
    connection=Connection();repo=repository(connection)
    evidence=page(total=2)
    from dataclasses import asdict
    normalized=asdict(evidence);normalized.pop('raw_xml')
    # Double reports these exact logical bytes. Real PostgreSQL JSONB formatting
    # is measured by RETURNING octet_length, never inferred by production Python.
    summary=dict(played_at=TIME,tuple_digest=tuple_digest((TIME,'Artist','Track','Album')),
        artist='Artist',track='Track',album='Album',occurrences=2)
    repo.payload_quota=(len(evidence.raw_xml.encode())+len(json.dumps(normalized).encode())
        +len(json.dumps(summary).encode())+1)
    existing={'played_at':TIME-1,'tuple_digest':'old','ordinal':1}
    connection.promoted=[existing]
    result=repo.commit_page(None,request=request(),page=evidence)
    assert result['reason']=='storage_quota' and connection.pages==[]
    assert connection.promoted==[existing] and connection.row['retained_payload_bytes']==0
    assert connection.summaries=={} and not connection.row.get('summary_complete')
    assert connection.account_used==0


def test_streaming_promotion_preserves_more_than_20000_same_second_occurrences():
    connection=Connection();repo=repository(connection)
    connection.pages=[{'tracks':[dict(timestamp=TIME,artist='Artist',track='Track',album='Album')]*20001}]
    budget={'remaining':2*1024*1024*1024,'charged':0}
    repo._promote(connection,connection.row,budget)
    assert len(connection.promoted)==20001
    assert [r['ordinal'] for r in connection.promoted]==list(range(1,20002))
    assert {r['tuple_digest'] for r in connection.promoted}=={tuple_digest((TIME,'Artist','Track','Album'))}
    inserts=[json.loads(params[-1]) for sql,params in connection.calls
        if sql.startswith('insert into integration.lastfm_history_occurrences_v1')]
    assert max(map(len,inserts))<=256
    charged=budget['charged'];repo._promote(connection,connection.row,budget)
    assert len(connection.promoted)==20001 and budget['charged']==charged


def test_manual_service_forwards_only_repository_dense_scope(monkeypatch):
    service=orchestration.LastfmHistoryImport({'ALBUM_HAVEN_APP_DATABASE_URL':'unused'});calls=[]
    trusted={**request(),'dense_second':True,'range_start':TIME,'range_end':TIME,'page':101}
    service.repository=SimpleNamespace(prepare=lambda *a,**k:trusted,
        commit_page=lambda *a,**k:{'state':'reading'})
    monkeypatch.setattr(orchestration,'read_history_page',lambda *a,**k:calls.append(k) or page(number=101,total=20001,dense=True))
    service.advance(None,generation=GEN,page=101)
    assert calls[0]['allow_dense'] is True and calls[0]['range_start']==calls[0]['range_end']==TIME


@pytest.mark.parametrize('limit',[True,False,0,-1,'2147483648',9223372036854775808])
def test_invalid_storage_quota_configuration_is_unavailable(limit):
    with pytest.raises(HistoryUnavailable):
        LastfmHistoryRepository({'ALBUM_HAVEN_APP_DATABASE_URL':'unused','LASTFM_HISTORY_RETAINED_BYTES_LIMIT':limit})


def test_default_quota_and_budget_use_account_counters_not_raw_payload_scan():
    connection=Connection();connection.row['retained_payload_bytes']=3;connection.account_used=17;repo=repository(connection)
    assert repo.payload_quota==2*1024*1024*1024
    budget=repo._budget(connection,1)
    assert budget=={'remaining':repo.payload_quota-17,'charged':0}
    sql,args=connection.calls[-1]
    assert args==(1,) and 'history_retained_payload_bytes' in sql and 'sum(' not in sql and 'where account_id=%s' in sql
    assert 'pages_v1' not in sql and 'occurrences_v1' not in sql


# S2 derived-summary and constant-time quota regressions; source-only, unrun.
def test_complete_generation_persists_summary_before_completion_and_charges_account():
    connection=Connection();repo=repository(connection)
    result=repo.commit_page(None,request=request(),page=page(total=2))
    assert result['state']=='complete' and connection.row['summary_complete'] is True
    summary=list(connection.summaries.values())
    assert len(summary)==1 and summary[0]['occurrences']==2
    assert summary[0]['artist']=='Artist' and summary[0]['track']=='Track'
    assert connection.account_used==connection.row['retained_payload_bytes']>0
    statements=[sql for sql,_ in connection.calls]
    marker=next(i for i,sql in enumerate(statements) if 'set summary_complete=true' in sql)
    completion=next(i for i,sql in enumerate(statements) if 'set next_page=' in sql)
    assert marker<completion


def test_genuine_empty_generation_has_explicit_complete_summary_marker():
    connection=Connection();result=repository(connection).commit_page(None,request=request(),page=page(total=0))
    assert result['state']=='complete' and connection.row['summary_complete'] is True
    assert connection.summaries=={} and connection.promoted==[]


def test_summary_charge_quota_failure_rolls_back_page_summary_and_marker():
    from dataclasses import asdict
    connection=Connection();repo=repository(connection);evidence=page(total=2)
    normalized=asdict(evidence);normalized.pop('raw_xml')
    repo.payload_quota=len(evidence.raw_xml.encode())+len(json.dumps(normalized).encode())+1
    result=repo.commit_page(None,request=request(),page=evidence)
    assert result['reason']=='storage_quota'
    assert connection.summaries=={} and connection.pages==[] and connection.promoted==[]
    assert not connection.row.get('summary_complete') and connection.account_used==0


def test_conflicting_digest_tuple_fails_closed_without_complete_summary(monkeypatch):
    from music_app.services import lastfm_history_postgres as owner
    connection=Connection();repo=repository(connection)
    monkeypatch.setattr(owner,'tuple_digest',lambda key:'a'*64)
    budget={'remaining':100000,'charged':0}
    first=dict(played_at=TIME,artist='Artist',track='Track',album='Album',occurrences=1)
    repo._store_summary(connection,connection.row,[first],budget)
    with pytest.raises(HistoryUnavailable):
        repo._store_summary(connection,connection.row,[{**first,'track':'Different'}],budget)
    assert not connection.row.get('summary_complete')
    assert list(connection.summaries.values())[0]['track']=='Track'


def test_summary_replay_is_noop_but_changed_generation_count_is_conflict():
    connection=Connection();repo=repository(connection);budget={'remaining':100000,'charged':0}
    group=dict(played_at=TIME,artist='Artist',track='Track',album='Album',occurrences=2)
    repo._store_summary(connection,connection.row,[group],budget);charged=budget['charged']
    repo._store_summary(connection,connection.row,[group],budget)
    assert budget['charged']==charged
    with pytest.raises(HistoryUnavailable):
        repo._store_summary(connection,connection.row,[{**group,'occurrences':3}],budget)


def test_missing_account_quota_owner_fails_closed():
    connection=Connection();original=connection.execute
    def execute(sql,params=()):
        if sql.startswith('select history_retained_payload_bytes'):return Result([])
        return original(sql,params)
    connection.execute=execute
    with pytest.raises(HistoryUnavailable):repository(connection)._budget(connection,1)
