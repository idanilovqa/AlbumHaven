"""Real favorite pages, capture/replay and subject-native authority contracts."""
from dataclasses import replace
from datetime import timedelta
import hashlib
from threading import Event

import pytest
from psycopg.types.json import Jsonb

from music_app.services.activity_native_targets import ActivityNativeTargets
from music_app.services.allowed_actions import AllowedActions
from music_app.services.friends_postgres import PostgresFriendsStore, load_friend_taste
from music_app.services.home_activity import ActivityQuery, ComparisonQuery, HomeActivityError, read_home_activity
from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
from music_app.services.policy import ResourceScope
from music_app.services.policy_evaluator import PolicyEvaluator
from tests.py.album_favorites_postgres_support import favorites_db, Workers, observed, deny


def page(db, *, actor=None, peer=None, **kwargs):
    actor,peer=actor or db.owner,peer or db.peer
    return PostgresFriendsStore(db.config,connect=db.app_connect).compare_taste(
        account_id=actor.account_id,library_id=db.library,target_account_id=peer.account_id,
        actor_session_id=actor.session_id,context=db.context(actor),expected_subject_ref=db.ref(peer),
        kind='albums',**kwargs)


def policy(db, actor, peer, constraints=None):
    def allowed(kind,identity):
        actions=[]
        for action in ('library.social.history.read','library.social.taste.read','library.browse.read'):
            ctx=replace(db.context(actor),action=action,resource=ResourceScope(kind,str(identity)),
                target_account_id=None if action=='library.browse.read' else peer.account_id)
            limit=constraints(ctx) if callable(constraints) else constraints
            if PolicyEvaluator().evaluate(ctx,constraints=limit).decision.allowed:
                actions.append(action)
        return AllowedActions(tuple(actions))
    allowed.scope_wide=constraints is None
    return allowed


def capture(db, *, actor=None, peer=None, comparison=True, kind='albums', constraints=None, connect=None, **query):
    actor,peer=actor or db.owner,peer or db.peer
    response=read_home_activity(db.config,actor=actor,subject_account_id=peer.account_id,
        comparison=comparison,query=(ComparisonQuery if comparison else ActivityQuery)(kind=kind,period='all',**query),
        allowed_actions_for_resource=policy(db,actor,peer,constraints),now=db.clock_time,
        repository=HomeActivityPostgresRepository(db.config,connect=connect or db.app_connect))
    token=response['data']['snapshot_ref']
    with db.connect() as con:
        row=con.execute('select id from app.activity_snapshots where token_digest=%s and account_id=%s and library_id=%s',
            (hashlib.sha256(token.encode()).digest(),actor.account_id,db.library)).fetchone()
    assert row is not None
    db.snapshot_ids.add(row['id'])
    return response


def receipt_row(db,token):
    with db.connect() as con:
        return con.execute('select * from app.activity_snapshots where token_digest=%s and library_id=%s',
            (hashlib.sha256(token.encode()).digest(),db.library)).fetchone()


def expired(operation):
    with pytest.raises(HomeActivityError) as caught:
        operation()
    assert caught.value.status_code==410 and caught.value.code=='activity_snapshot_expired'


def test_favorite_only_pages_exclude_false_rows_and_advance_through_denied_candidates(favorites_db):
    db=favorites_db
    albums=[db.albums[0],*[db.add_album(str(i)) for i in range(1,6)]]
    for index,album in enumerate(albums):
        db.patch(album,{'favorite':index!=1},actor=db.owner if index%2 else db.peer)
    first=page(db,limit=1,constraints=deny('library.social.taste.read','album',albums[0]['id']))
    assert first['rows']==[] and first['next_after']==albums[0]['id']
    seen=[];after=first['next_after']
    while after is not None:
        next_page=page(db,limit=1,after=after)
        seen.extend(row['resource_id'] for row in next_page['rows'])
        new=next_page['next_after']
        assert new is None or new>after
        after=new
    assert seen==[a['id'] for a in albums[2:]] and len(seen)==len(set(seen))
    assert page(db,limit=1)['rows'][0]['resource_id']==albums[0]['id']
    assert 'preference_revision' not in repr(page(db))


def test_digest_changes_for_away_back_even_when_favorites_match(favorites_db):
    db=favorites_db;album=db.albums[0]
    db.patch(album,{'favorite':True},actor=db.peer)
    def facts():
        with db.app_connect(db.app_url) as con:
            return load_friend_taste(con,account_id=db.owner.account_id,library_id=db.library,
                target_account_id=db.peer.account_id,kind='albums',resource_ids=[album['id']])
    before=facts()
    db.patch(album,{'favorite':False},1,actor=db.peer)
    db.patch(album,{'favorite':True},2,actor=db.peer)
    after=facts()
    assert before['revision']!=after['revision']
    assert before['items'][album['id']]['friend_favorite'] is after['items'][album['id']]['friend_favorite'] is True


@pytest.mark.parametrize('change',['first_no_history','last_removal','away_back','rating','null_to_false','revision_only','delete_row'])
def test_album_receipt_expires_for_every_complete_population_change(favorites_db,change):
    db=favorites_db;album=db.albums[0]
    added=db.add_album('no-history') if change=='first_no_history' else None
    db.patch(album,{'favorite':True},actor=db.peer)
    if change=='null_to_false':
        # Newly owned legacy-shaped viewer row exists before the captured stamp.
        null_row_id=db.seed(album,rating=7,favorite=None)
        null_before=next(row for row in db.rows() if row['id']==null_row_id)
        assert null_before['favorite'] is None and null_before['preference_revision']==1
    first=capture(db)['data']; token=first['snapshot_ref']
    assert len(first['rows'])==1 and first['rows'][0]['friend']['favorite'] is True
    assert first['rows'][0]['friend']['listen_count']==0
    internal=receipt_row(db,token)
    stamp=internal['coverage']['_album_taste_stamp']
    assert stamp=={'version':1,'library_id':db.library,'viewer_account_id':db.owner.account_id,
        'subject_account_id':db.peer.account_id,'epochs':[
            [db.owner.account_id,db.epochs()['album_taste_revision']],
            [db.peer.account_id,db.epochs(db.peer)['album_taste_revision']]]}
    assert '_album_taste_stamp' not in repr(first)
    if change=='first_no_history':
        db.patch(added,{'favorite':True})
    elif change=='last_removal':
        db.patch(album,{'favorite':False},1,actor=db.peer)
    elif change=='away_back':
        db.patch(album,{'favorite':False},1,actor=db.peer)
        db.patch(album,{'favorite':True},2,actor=db.peer)
    elif change=='rating':
        db.patch(album,{'rating':9},1,actor=db.peer)
    elif change=='null_to_false':
        result=db.patch(album,{'favorite':False},1)
        assert result['favorite_override'] is False and result['preference_revision']==2
        null_after=next(row for row in db.rows() if row['id']==null_row_id)
        assert null_after['favorite'] is False
        assert null_after['created_at']==null_before['created_at']
        assert null_after['rating']==null_before['rating']
    else:
        row=next(r for r in db.rows() if r['account_id']==db.peer.account_id)
        with db.connect() as con:
            if change=='revision_only':
                con.execute('update app.album_ratings set preference_revision=preference_revision+1 where id=%s',(row['id'],))
            else:
                con.execute('delete from app.album_ratings where id=%s',(row['id'],))
    expired(lambda:capture(db,snapshot_ref=token))
    if change in ('last_removal','delete_row'):
        assert capture(db)['data']['rows']==[]


@pytest.mark.parametrize('fault',['missing','version','bool_epoch','duplicate','foreign_library','unknown_key'])
def test_old_or_malformed_stamps_expire_without_repair(favorites_db,fault):
    db=favorites_db;db.patch(db.albums[0],{'favorite':True})
    first=capture(db)['data'];row=receipt_row(db,first['snapshot_ref'])
    coverage=dict(row['coverage']);stamp=dict(coverage['_album_taste_stamp'])
    if fault=='missing':coverage.pop('_album_taste_stamp')
    else:
        if fault=='version':stamp['version']=2
        if fault=='bool_epoch':stamp['epochs']=[[db.owner.account_id,True],[db.peer.account_id,0]]
        if fault=='duplicate':stamp['epochs']=[[db.owner.account_id,0],[db.owner.account_id,0]]
        if fault=='foreign_library':stamp['library_id']=db.library+1
        if fault=='unknown_key':stamp['extra']=True
        coverage['_album_taste_stamp']=stamp
    with db.connect() as con:
        con.execute('update app.activity_snapshots set coverage=%s where id=%s',(Jsonb(coverage),row['id']))
    expired(lambda:capture(db,snapshot_ref=first['snapshot_ref']))
    assert receipt_row(db,first['snapshot_ref'])['coverage']==coverage


@pytest.mark.parametrize('change',['relationship','subject_account','viewer_grant','session','source'])
def test_matching_taste_epoch_never_bypasses_current_authority_or_source(favorites_db,change):
    db=favorites_db;album=db.albums[0];db.patch(album,{'favorite':True},actor=db.peer)
    first=capture(db)['data'];before=db.epochs(db.peer)
    with db.connect() as con:
        if change=='relationship':
            con.execute("update app.friend_connections set state='removed',revision=revision+1 where library_id=%s",(db.library,))
        elif change=='subject_account':
            con.execute('update app.accounts set is_active=false where id=%s',(db.peer.account_id,))
        elif change=='viewer_grant':
            con.execute("update app.capabilities set revoked_at=clock_timestamp() where account_id=%s and capability_key='capability.social'",(db.owner.account_id,))
        elif change=='session':
            con.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s',(db.owner.session_id,))
        else:
            con.execute('delete from library.local_track_files where id=%s',(album['file'],))
    assert db.epochs(db.peer)['album_taste_revision']==before['album_taste_revision']
    with pytest.raises(HomeActivityError) as caught:
        capture(db,snapshot_ref=first['snapshot_ref'])
    assert caught.value.status_code in (403,410)


def test_replay_reads_exact_two_epochs_without_preference_population_scan(favorites_db):
    db=favorites_db;db.patch(db.albums[0],{'favorite':True})
    first=capture(db)['data'];queries=[]
    def before(sql,params,con):queries.append((sql,params))
    replay=capture(db,snapshot_ref=first['snapshot_ref'],connect=observed(db,before=before))['data']
    assert replay==first
    epoch=[(sql,args) for sql,args in queries if 'select account_id,album_taste_revision' in sql]
    assert epoch and all(args==(db.library,sorted([db.owner.account_id,db.peer.account_id])) for _,args in epoch)
    assert not any('from app.album_ratings' in sql for sql,_ in queries)
    assert '_album_taste_stamp' not in repr(replay)


def test_capture_racing_first_insert_cannot_publish_partial_ready_snapshot(favorites_db):
    db=favorites_db;album=db.albums[0]
    # Existing epoch rows avoid a test-orchestration deadlock on capture's
    # initialization INSERT; the preference row itself remains genuinely absent.
    with db.connect() as con:
        for account in (0,db.owner.account_id,db.peer.account_id):
            con.execute('insert into app.activity_source_revisions(library_id,account_id) values(%s,%s) on conflict do nothing',(db.library,account))
    with Workers(db) as workers:
        barrier=workers.barrier();once=Event()
        def after(sql,params,con):
            if 'select account_id,album_taste_revision' in sql and not once.is_set():
                once.set();barrier.pause()
        reader=workers.start(lambda:capture(db,connect=observed(db,after=after)))
        assert barrier.reached.wait(5)
        # Legacy-shaped SQL writer has no new account-lock prefix. This is a
        # genuine missing-row trigger race on the same migrated database.
        db.seed(album,favorite=True)
        barrier.release.set();workers.finish(reader)
    if reader.errors:
        assert len(reader.errors)==1 and isinstance(reader.errors[0],HomeActivityError)
        assert reader.errors[0].status_code in (410,503)
    else:
        # Existing bounded whole-transaction retry may legitimately capture new
        # state. A successful response must contain the newly eligible album.
        assert len(reader.result[0]['data']['rows'])==1
        assert reader.result[0]['data']['rows'][0]['yours']['favorite'] is True
    with db.connect() as con:
        rows=con.execute('select id,ready,coverage from app.activity_snapshots where library_id=%s',(db.library,)).fetchall()
    assert all(row['ready'] and '_album_taste_stamp' in row['coverage'] for row in rows)
    # Failed attempts must have rolled back, not left unregistered snapshots.
    assert {r['id'] for r in rows}<=db.snapshot_ids


@pytest.mark.parametrize('reverse',[False,True])
def test_native_initial_account_lock_order_is_sorted_for_lower_and_higher_subject(favorites_db,reverse):
    db=favorites_db;actor,peer=(db.peer,db.owner) if reverse else (db.owner,db.peer)
    db.patch(db.albums[0],{'favorite':True},actor=peer)
    first=capture(db,actor=actor,peer=peer)['data']
    origin={'audience':'comparison','subject_ref':db.ref(peer),'kind':'albums','period':'all','snapshot_ref':first['snapshot_ref']}
    statements=[]
    def before(sql,params,con):statements.append((sql,params,con.info.backend_pid))
    owner=ActivityNativeTargets(db.config,connect=observed(db,before=before),clock=lambda:db.clock_time)
    result=owner.project(db.context(actor),origin=origin,rows=first['rows'])
    assert len(result)==1
    locks=[(sql,args,pid) for sql,args,pid in statements if 'from app.accounts' in sql and ('for share' in sql or 'for update' in sql)]
    assert locks and list(locks[0][1][0])==sorted([actor.account_id,peer.account_id])
    hint=[pid for sql,args,pid in statements if 'from app.social_profiles' in sql and 'for share' not in sql]
    assert hint and hint[0]!=locks[0][2]
    assert '_album_taste_stamp' not in repr(result)


@pytest.mark.parametrize('blocked',[('library.social.taste.read','account'),('library.social.taste.read','album'),('library.browse.read','album')])
def test_native_taste_admission_uses_account_album_and_viewer_browse_separately(favorites_db,blocked):
    db=favorites_db;album=db.albums[0]
    db.patch(album,{'rating':8,'favorite':True},actor=db.peer)
    # Friend history with no events is valid but has no rows. Capture comparison
    # supplies one taste-only canonical row and must fail closed under denial.
    first=capture(db)['data'];origin={'audience':'comparison','subject_ref':db.ref(),'kind':'albums','period':'all','snapshot_ref':first['snapshot_ref']}
    queried=[]
    def before(sql,params,con):
        if 'left join app.album_ratings' in sql:queried.append(sql)
    service=ActivityNativeTargets(db.config,connect=observed(db,before=before),clock=lambda:db.clock_time)
    with pytest.raises((HomeActivityError,PermissionError)):
        service.project(db.context(),origin=origin,rows=first['rows'],constraints=deny(*blocked))
    assert queried==[], 'Denied exact taste must be filtered before hydration'


def test_subject_mapping_change_after_hint_never_rebinds_taste(favorites_db):
    from uuid import uuid4
    from music_app.services.private_native_targets import NativeTargetError
    db=favorites_db;db.patch(db.albums[0],{'favorite':True},actor=db.peer)
    first=capture(db)['data'];original_ref=db.ref()
    origin={'audience':'comparison','subject_ref':original_ref,'kind':'albums','period':'all','snapshot_ref':first['snapshot_ref']}
    changed=Event(); hydrated=[]
    def after(sql,params,con):
        if 'from app.social_profiles' in sql and 'for share' not in sql and not changed.is_set():
            changed.set()
            with db.connect() as writer:
                writer.execute('update app.social_profiles set account_ref=%s where account_id=%s',(uuid4(),db.peer.account_id))
        if 'left join app.album_ratings' in sql:
            hydrated.append(sql)
    service=ActivityNativeTargets(db.config,connect=observed(db,after=after),clock=lambda:db.clock_time)
    with pytest.raises(NativeTargetError) as caught:
        service.project(db.context(),origin=origin,rows=first['rows'])
    assert changed.is_set() and caught.value.code=='source_unavailable' and not hydrated


def test_friend_native_read_returns_peer_and_listener_path_never_reads_taste(favorites_db):
    db=favorites_db;album=db.albums[0]
    db.add_history(album,db.peer)
    db.patch(album,{'rating':1,'favorite':False})
    db.patch(album,{'rating':9,'favorite':True},actor=db.peer)
    friend=capture(db,comparison=False,kind='albums')['data']
    origin={'audience':'friend','subject_ref':db.ref(),'kind':'albums','period':'all','snapshot_ref':friend['snapshot_ref']}
    service=ActivityNativeTargets(db.config,connect=db.app_connect,clock=lambda:db.clock_time)
    result=service.resolve(db.context(),origin=origin,row_ref=friend['rows'][0]['id'],intent='details')
    taste=result['native_target']['subject_taste']
    assert taste['rating']==9 and taste['favorite'] is True and taste['read_only'] is True
    assert taste['subject_ref']==db.ref() and 'preference_revision' not in repr(taste)
    assert 'can_manage_album_preferences' not in repr(taste)
    tracks=capture(db,comparison=False,kind='tracks')['data']
    track_origin={**origin,'kind':'tracks','snapshot_ref':tracks['snapshot_ref']}
    queries=[]
    def before(sql,params,con):queries.append(sql)
    listener=ActivityNativeTargets(db.config,connect=observed(db,before=before),clock=lambda:db.clock_time)
    projected=listener.project_listener(db.context(),origin=track_origin,row_refs=[tracks['rows'][0]['id']],
        constraints=deny('library.social.taste.read'))
    assert len(projected['bindings'])==1 and 'subject_taste' not in repr(projected)
    assert not any('app.album_ratings' in sql or 'app.track_preferences' in sql for sql in queries)


def test_listener_summary_strips_stamp_without_mutating_internal_coverage(favorites_db):
    from music_app.services.home_activity_postgres import _ListenerReceipt
    db=favorites_db;db.patch(db.albums[0],{'favorite':True})
    first=capture(db)['data'];internal=receipt_row(db,first['snapshot_ref'])
    with db.app_connect(db.app_url) as con:
        con.execute('select 1')
        summary=_ListenerReceipt(con,internal).summary
    assert '_album_taste_stamp' not in summary['coverage']
    assert '_album_taste_stamp' in internal['coverage']
    assert summary['coverage']=={k:v for k,v in internal['coverage'].items() if k!='_album_taste_stamp'}


def test_unrelated_friend_history_receipt_keeps_existing_freshness_after_album_edit(favorites_db):
    db=favorites_db;album=db.albums[0];db.add_history(album)
    first=capture(db,comparison=False,kind='tracks')['data']
    db.patch(album,{'favorite':True},actor=db.peer)
    assert capture(db,comparison=False,kind='tracks',snapshot_ref=first['snapshot_ref'])['data']==first


def test_dynamic_final_account_taste_denial_suppresses_complete_capture(favorites_db):
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    db=favorites_db;db.patch(db.albums[0],{'favorite':True},actor=db.peer)
    published=Event()
    def after(sql,params,con):
        if 'update app.activity_snapshots set ready=true' in sql:
            published.set()
    def constraints(ctx):
        return PolicyEvaluationConstraints(request_origin_allowed=not (
            published.is_set() and ctx.action=='library.social.taste.read'))
    expired(lambda:capture(db,constraints=constraints,connect=observed(db,after=after)))
    assert published.is_set()
    with db.connect() as con:
        assert con.execute('select count(*) as n from app.activity_snapshots where library_id=%s',(db.library,)).fetchone()['n']==0
