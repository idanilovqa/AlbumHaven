"""Additive source-authored tests, unrun. SQL connection is an explicit double.
Real Home append owner, strict accepted tuple owner and safe display are exercised.
Successor of unpublished Home S1 test source: original assertions preserved; SQL double
updated for real keyset/aggregate queries, with additive dense regressions. Frozen inputs unchanged.
"""
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from types import SimpleNamespace

import pytest
from music_app.services import lastfm_home_snapshot as owner
from music_app.services.lastfm_history_model import tuple_digest
from music_app.services.home_activity_postgres import _external_coverage

TIME = 1700000000
LINEAGE = '2023-01-01T00:00:00+00:00'
KEY = (TIME,'Artist','Track','Album')
SCOPE = dict(account_id=1,library_id=2,provider_username='Owner',connection_started_at=LINEAGE)


def native(number=1):
    request = dict(timestamp=TIME,artist='Artist',track='Track',album='Album',album_artist='',track_number='')
    reply = {key:value for key,value in request.items() if key!='track_number'}
    reply['corrected'] = {key:False for key in ('artist','track','album','album_artist')}
    device='11111111-1111-4111-8111-111111111111'
    session=f'22222222-2222-4222-8222-{number:012d}'
    physical=f'1:2:{device}:{session}'
    identity = dict(version=1,provider='lastfm',account_id=1,library_id=2,
        occurrence_id=hashlib.sha256(physical.encode()).hexdigest(),attempt=1,provider_username='Owner',connection_started_at=LINEAGE,
        request=request,reply=reply)
    return dict(id=number,account_id=1,library_id=2,device_id=device,session_id=session,
        source_entry_id=physical,source_family='rendered_local_listen_session',
        measurement_version='rendered-pcm-v1',played_at=datetime.fromtimestamp(TIME,timezone.utc),
        display=dict(id=f'opaque{number}',source_label='Album Haven',last_listened_at='2023-11-14T22:13:20+00:00',
            artist='Safe Artist',title='Safe Track',album_title='Safe Album'),
        payload=dict(id=identity['occurrence_id'],scrobble_retry_count=1,scrobbled=True,
            source_provenance={'kind':'local_playback','provider':'album_haven'},
            scrobble_submission_state='accepted',scrobble_submission_identity=identity,
            title='Track',artist='Artist',album='Album',path='/private/not-exposed'))


def remote(ordinal=1):
    return dict(account_id=1,provider_username='Owner',connection_started_at=LINEAGE,
        played_at=TIME,artist='Artist',track='Track',album='Album',tuple_digest=tuple_digest(KEY),ordinal=ordinal)


class Result:
    def __init__(self, rows=()): self.rows=list(rows)
    def fetchone(self): return self.rows[0] if self.rows else None
    def fetchall(self): return self.rows
    def fetchmany(self, size): return self.rows[:size]

class Cursor:
    def __init__(self,connection,name):self.connection=connection;self.name=name;self.offset=0;self.rows=[]
    def __enter__(self):return self
    def __exit__(self,*args):self.connection.closed.append(self.name)
    def execute(self,sql,args):
        db=self.connection;db.cursor_queries.append((sql,args))
        if self.name.startswith('lastfm_uncertain_'):
            copies=Counter(row['source_entry_id'] for row in db.own)
            def key(row):
                identity=row['payload'].get('scrobble_submission_identity') or {}
                field='reply' if self.name.startswith('lastfm_uncertain_candidates_') and row['payload'].get('scrobble_submission_state')=='accepted' else 'request'
                value=identity.get(field) or {}
                return (int(row['played_at'].timestamp()),)+tuple((value.get(k) is None,value.get(k) or '') for k in ('artist','track','album'))+(row['id'],)
            rows=sorted(db.own,key=key)
            if self.name.startswith('lastfm_uncertain_rows_'):
                rows=[r for r in rows if r['payload'].get('scrobble_submission_state') in ('attempting','sent','uncertain') and r['payload'].get('scrobbled') is not True]
            else:rows=[r for r in rows if copies[r['source_entry_id']]==1]
            self.rows=[dict(row,row_key='listen:event:'+str(row['id']),physical_copies=copies[row['source_entry_id']]) for row in rows]
        elif 'join integration.listen_history' in sql:
            copies=Counter(row['source_entry_id'] for row in db.own)
            def order(row):
                reply=(row['payload'].get('scrobble_submission_identity') or {}).get('reply') or {}
                return tuple((reply.get(k) is None,reply.get(k) or '') for k in ('artist','track','album'))+(row['id'],)
            self.rows=[dict(row,row_key='listen:event:'+str(row['id'])) for row in sorted(db.own,key=order)
                if copies[row['source_entry_id']]==1]
        elif 'lastfm_history_occurrences_v1' in sql:
            self.rows=sorted(db.remote,key=lambda r:(r['artist'],r['track'],r['album'],r['ordinal']))
        else:raise AssertionError(sql)
    def fetchmany(self,size):
        assert size<=256
        rows=self.rows[self.offset:self.offset+size];self.offset+=len(rows);return rows

class Connection:
    def __init__(self, own, remote, *, state='complete', previous=None, completed=1):
        self.own=deepcopy(own);self.remote=deepcopy(remote);self.state=state
        self.previous=previous;self.completed=completed;self.writes=[];self.cursor_queries=[];self.closed=[]
        self.summary_complete=True;self.assessment_counts=0
    def cursor(self,*,name):return Cursor(self,name)
    def execute(self, sql, args=()):
        if 'select count(*) as count from integration.lastfm_history_occurrences' in sql:
            self.assessment_counts+=1
            timestamp,digest,artist,track,album=args[-5:]
            return Result([dict(count=sum((r['played_at'],r['tuple_digest'],r['artist'],r['track'],r['album'])==(timestamp,digest,artist,track,album) for r in self.remote))])
        if 'count(*) filter' in sql:
            return Result([dict(completed=self.completed,unfinished=int(self.state!='complete'))])
        if 'select distinct played_at' in sql:
            return Result([dict(played_at=TIME)] if self.remote and args[-1]<TIME else [])
        if 'select * from integration.lastfm_history_occurrences' in sql:
            after=(args[-3],args[-2]);limit=args[-1]
            return Result(sorted((r for r in self.remote if (r['tuple_digest'],r['ordinal'])>after),
                key=lambda r:(r['tuple_digest'],r['ordinal']))[:limit])
        if 'select id,state' in sql:return Result([dict(id='current',state=self.state,summary_complete=self.summary_complete)] if self.completed or self.state!='complete' else [])
        if 'select id,summary_complete from integration.lastfm_history_generations' in sql:
            return Result([dict(id='current',summary_complete=self.summary_complete)]+([dict(id='previous',summary_complete=self.summary_complete)] if self.previous is not None else []))
        if 'with observed as' in sql:
            other=self.previous if len(args)==4 else self.remote
            counts=lambda rows:Counter((r['artist'],r['track'],r['album']) for r in rows)
            return Result([dict(same=counts(self.remote)==counts(other))])
        if 'join integration.listen_history' in sql:
            copies=Counter(row['source_entry_id'] for row in self.own)
            after,artist,track,album,limit=args[-5:]
            rows=[]
            for row in sorted(self.own,key=lambda r:r['id']):
                reply=(row['payload'].get('scrobble_submission_identity') or {}).get('reply') or {}
                if row['id']>after and copies[row['source_entry_id']]==1 and (reply.get('artist'),reply.get('track'),reply.get('album'))==(artist,track,album):
                    rows.append(dict(row,row_key='listen:event:'+str(row['id'])))
            return Result(rows[:limit])
        if sql.strip().startswith(('insert','update')):
            self.writes.append((sql,args));return Result()
        raise AssertionError(sql)


def run(own=(), imported=(), **kwargs):
    connection=Connection(own,imported,**kwargs)
    scope=SimpleNamespace(account_id=1,library_id=2)
    window=SimpleNamespace(start=None,end=datetime.fromtimestamp(TIME+100,timezone.utc))
    result=owner.append_observations(connection,snapshot_id='snapshot',scope=scope,
        window=window,secret=b'opaque-only',stamp=dict(connected=True,provider_username='Owner',connection_started_at=LINEAGE))
    return result,connection


@pytest.mark.parametrize('n,r,added,matched',[(1,2,1,1),(2,1,0,1),(2,2,0,2),(0,2,2,0)])
def test_genuine_snapshot_append_preserves_multiplicity(n,r,added,matched):
    result,db=run([native(i+1) for i in range(n)],[remote(i+1) for i in range(r)])
    assert result[0]==added and result[1]['matched_rows']==matched
    assert len(db.writes)==added+matched
    assert all('delete' not in sql.lower() and 'integration.listen_history set' not in sql.lower() for sql,_ in db.writes)


@pytest.mark.parametrize('state',['reading','uncertain','connection_changed'])
def test_incomplete_bucket_never_hides_native_or_remote(state):
    result,db=run([native()],[remote()],state=state)
    assert result[0]==1 and result[1]['matched_rows']==0
    assert result[1]['observation_state']=='uncertain'


def test_changed_bucket_does_not_reuse_old_match():
    result,db=run([native()],[remote()],previous=[])
    assert result[0]==1 and result[1]['uncertain_rows']==1


@pytest.mark.parametrize('provenance',[None,{},dict(kind='lastfm_import',provider='lastfm'),dict(kind='foobar_import',provider='foobar')])
def test_non_native_provenance_never_correlates(provenance):
    row=native();row['payload']['source_provenance']=provenance
    result,_=run([row],[remote()]);assert result[0]==1 and result[1]['matched_rows']==0


def test_column_only_acceptance_remains_separate_without_bound_reply():
    row=native();row['scrobble_status']='scrobbled';row['payload'].pop('scrobble_submission_identity')
    result,_=run([row],[remote()]);assert result[0]==1


def test_remote_payload_has_no_native_target_or_send_and_display_is_sanitized():
    row=remote();row.update(track='/private/music.flac',artist={'bad':'value'},album='https://private/path')
    key,payload=owner._remote_row(row,b'secret',uncertain=True)
    assert key.startswith('listen:lastfm:') and payload['id'].startswith('activity_')
    assert not payload['title'] and not payload['artist'] and not payload['album_title']
    assert payload['detail_ref'] is None and payload['allowed_actions']=={'can_view_details':False}
    assert 'scrobble_delivery' not in payload and 'source_entry_id' not in payload
    assert payload['availability']=='unresolved'


def test_empty_success_is_not_never_imported_or_complete_history():
    success,_=run(completed=1);missing,_=run(completed=0)
    assert success[1]['observation_state']=='observed_ranges'
    assert missing[1]['observation_state']=='not_imported'
    assert success[1]['complete_history'] is False
    assert success[1]['provider_snapshot_guaranteed'] is False


@pytest.mark.parametrize('audience,subject,source,kind,enabled',[
    ('own',None,1,'listens',True),('friend',2,2,'listens',False),
    ('comparison',2,2,'listens',False),('own',2,1,'listens',False),
    ('own',None,2,'listens',False),('own',None,1,'tracks',False)])
def test_feature_is_strict_own_account_listens_only(audience,subject,source,kind,enabled):
    scope=SimpleNamespace(account_id=1,source_account_id=source,audience=audience,subject_account_id=subject)
    query=SimpleNamespace(kind=kind)
    assert owner.enabled_for({'LASTFM_HISTORY_IMPORT_ENABLED':True},scope,query) is enabled
    assert not owner.enabled_for({},scope,query)


def test_private_connection_binding_is_never_public_coverage():
    coverage={'_lastfm_history_stamp':dict(provider_username='Owner',connection_started_at=LINEAGE),
        '_album_taste_stamp':{},'lastfm_observations':{'observation_state':'not_imported'}}
    assert _external_coverage(coverage)=={'lastfm_observations':{'observation_state':'not_imported'}}


def test_same_physical_evidence_with_contradictory_echo_names_never_consumes_twice():
    first=native();second=deepcopy(first);second['id']=2
    second['payload']['scrobble_submission_identity']['reply']['track']='Corrected'
    second['payload']['scrobble_submission_identity']['reply']['corrected']['track']=True
    other=remote(1);other['track']='Corrected';other['tuple_digest']=tuple_digest((TIME,'Artist','Corrected','Album'))
    result,_=run([first,second],[remote(),other])
    assert result[0]==2 and result[1]['matched_rows']==0


def test_genuine_repository_checks_receipt_connection_binding_before_yield(monkeypatch):
    from contextlib import nullcontext
    from datetime import timedelta
    from music_app.services.home_activity import HomeActivityError
    from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
    repo=HomeActivityPostgresRepository({})
    scope=SimpleNamespace(account_id=1,session_id='session',library_id=2,source_account_id=1,
        audience='own',subject_account_id=None)
    query=SimpleNamespace(snapshot_ref='A'*43,kind='listens',period='all')
    now=datetime.now(timezone.utc)
    snapshot=dict(coverage={'_lastfm_history_stamp':{'connected':True,'provider_username':'Old'}},
        ledger_revision=1,inventory_revision=1,authority_fingerprint='authority',expires_at=now+timedelta(minutes=5))
    class DB:
        def execute(self,*args):return Result([snapshot])
    monkeypatch.setattr(repo,'_friend_authority',lambda *args:nullcontext(None))
    monkeypatch.setattr(repo,'_authority',lambda *args:'authority')
    monkeypatch.setattr(repo,'_lastfm_stamp',lambda *args:dict(connected=True,provider_username='New'))
    with pytest.raises(HomeActivityError):
        with repo._validated_snapshot(DB(),scope,query,now,object()):
            pytest.fail('Stale connection receipt must not be yielded')


def test_genuine_repository_rechecks_binding_after_consumer(monkeypatch):
    from contextlib import nullcontext
    from datetime import timedelta
    from music_app.services.home_activity import HomeActivityError
    from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
    repo=HomeActivityPostgresRepository({})
    scope=SimpleNamespace(account_id=1,session_id='session',library_id=2,source_account_id=1,
        audience='own',subject_account_id=None)
    query=SimpleNamespace(snapshot_ref='A'*43,kind='listens',period='all')
    now=datetime.now(timezone.utc);stamp={'connected':True,'provider_username':'Owner'}
    snapshot=dict(coverage={'_lastfm_history_stamp':stamp},ledger_revision=1,inventory_revision=1,
        authority_fingerprint='authority',expires_at=now+timedelta(minutes=5))
    class DB:
        def execute(self,*args):return Result([snapshot])
    monkeypatch.setattr(repo,'_friend_authority',lambda *args:nullcontext(None))
    monkeypatch.setattr(repo,'_authority',lambda *args:'authority')
    states=iter([stamp,{'connected':False}])
    monkeypatch.setattr(repo,'_lastfm_stamp',lambda *args:next(states))
    monkeypatch.setattr(repo,'_revisions',lambda *args,**kwargs:(1,1))
    monkeypatch.setattr(repo,'_validate_policy',lambda *args:None)
    monkeypatch.setattr(repo,'_lock_authority',lambda *args:now)
    with pytest.raises(HomeActivityError):
        with repo._validated_snapshot(DB(),scope,query,now,object()) as result:
            assert result[0] is snapshot


def test_account_remote_denial_preserves_native_only_and_never_reads_provider_binding(monkeypatch):
    from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
    repo=HomeActivityPostgresRepository({'LASTFM_HISTORY_IMPORT_ENABLED':True})
    scope=SimpleNamespace(account_id=1,source_account_id=1,subject_account_id=None,audience='own')
    query=SimpleNamespace(kind='listens')
    def policy(*args):return None
    project=SimpleNamespace(policy=policy)
    assert repo._lastfm_stamp(None,scope,query,project) is None
    policy.lastfm_history_read=lambda:False
    monkeypatch.setattr(repo,'_lock_authority',lambda *args:pytest.fail('Denied optional read must not query remote binding'))
    assert repo._lastfm_stamp(None,scope,query,project) is None


def test_actual_account_policy_checks_fixed_action_constraints_and_current_owner():
    from music_app.services.current_actor import CurrentActor,ActorState
    from music_app.services.policy import PolicyContext,RequestOrigin
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    actor=CurrentActor(ActorState.ACTIVE,account_id=1,session_id=2)
    context=PolicyContext.build(actor=actor,action='library.browse.read',library_id=3,
        deployment_mode='self_hosted',request_origin=RequestOrigin('internal','test'),client_surface_class='private_web')
    seen=[]
    def denied(target):
        seen.append(target.action)
        return PolicyEvaluationConstraints(deployment_allowed=False)
    assert not owner.account_read_allowed(context,denied,account_id=1,session_id=2)
    assert seen==['account.self.lastfm.history.read']
    assert owner.account_read_allowed(context,None,account_id=1,session_id=2)
    assert not owner.account_read_allowed(context,None,account_id=9,session_id=2)
    assert not owner.account_read_allowed(context,None,account_id=1,session_id=9)


def test_actual_playlist_owner_rejects_unassociated_remote_receipt_not_fake_track():
    from music_app.services.playlist_activity_sources import _rows
    from music_app.services.owned_playlists import PlaylistError
    entry=dict(canonical_resource=None,facts=dict(title='Remote',artist='Artist',album_title='Album'),
        row_ref='opaque',lineage={'row_key':'listen:lastfm:'+'a'*64})
    with pytest.raises(PlaylistError):
        _rows(None,SimpleNamespace(library_id=2),[entry],config={},constraints=None,current={})


def test_actual_playlist_owner_preserves_existing_unresolved_native_metadata():
    from music_app.services.playlist_activity_sources import _rows
    entry=dict(canonical_resource=None,facts=dict(title='Native',artist='Artist',album_title='Album'),
        row_ref='opaque',lineage={'row_key':'listen:event:1'})
    result=_rows(None,SimpleNamespace(library_id=2),[entry],config={},constraints=None,current={})
    assert result[0]['original_local_track_id'] is None
    assert result[0]['availability']=='unresolved'
    assert result[0]['title']=='Native'


def test_missing_source_order_skips_remote_before_native_inventory_filter():
    from music_app.services.playlist_activity_sources import _rows
    remote_entry=dict(canonical_resource=None,facts=dict(title='Remote'),row_ref='remote',
        lineage={'row_key':'listen:lastfm:'+'a'*64})
    native_entry=dict(canonical_resource=None,facts=dict(title='Native'),row_ref='native',
        lineage={'row_key':'listen:event:1'})
    result=_rows(None,SimpleNamespace(library_id=2),[remote_entry,native_entry],config={},
        constraints=None,current={},preserve_occurrences=True)
    assert len(result)==1 and result[0]['title']=='Native'


def test_dense_bucket_above_old_limit_keeps_every_unmatched_occurrence():
    result,db=run(imported=[remote(i+1) for i in range(20001)])
    assert result[0]==20001 and result[1]['imported_rows']==20001
    assert result[1]['uncertain_rows']==0
    assert len({args[1] for sql,args in db.writes})==20001


def test_tuple_matching_continues_across_both_keyset_boundaries():
    result,db=run([native(i+1) for i in range(300)],[remote(i+1) for i in range(513)])
    assert result[0]==213 and result[1]['matched_rows']==300
    matched=[args[-1] for sql,args in db.writes if sql.strip().startswith('update')]
    assert len(matched)==len(set(matched))==300


def test_invalid_accepted_candidates_do_not_consume_remote_multiplicity():
    rows=[native(i+1) for i in range(300)]
    for row in rows[:260]:row['payload']['source_provenance']={'kind':'foobar_import','provider':'foobar'}
    result,_=run(rows,[remote(i+1) for i in range(50)])
    assert result[0]==10 and result[1]['matched_rows']==40


def test_dense_home_uses_one_native_and_one_remote_query_not_repeated_prefixes():
    result,db=run([native(i+1) for i in range(513)],[remote(i+1) for i in range(700)])
    assert result[1]['matched_rows']==513 and result[0]==187
    assert len(db.cursor_queries)==3 and len(db.closed)==3
    assert sum('with candidates as' in sql for sql,_ in db.cursor_queries)==1
    assert all('id>' not in sql for sql,_ in db.cursor_queries)


def test_summary_readiness_is_required_even_when_completed_generation_is_empty():
    from types import SimpleNamespace
    db=Connection([],[]);db.summary_complete=False
    assert owner._bucket_uncertain(db,SimpleNamespace(account_id=1),SCOPE,TIME) is True
    db.summary_complete=True
    assert owner._bucket_uncertain(db,SimpleNamespace(account_id=1),SCOPE,TIME) is False


def test_exact_tuple_stream_merge_handles_multiple_names_and_native_tail_close():
    a=native(1);b=native(2);c=native(3)
    for row,name in ((a,'A'),(b,'B'),(c,'Z')):
        row['payload']['scrobble_submission_identity']['request']['track']=name
        row['payload']['scrobble_submission_identity']['reply']['track']=name
    first=remote();first['track']='B';first['tuple_digest']=tuple_digest((TIME,'Artist','B','Album'))
    second=remote();second['track']='C';second['tuple_digest']=tuple_digest((TIME,'Artist','C','Album'))
    result,db=run([a,b,c],[first,second])
    assert result[0]==1 and result[1]['matched_rows']==1
    assert len(db.closed)==3
