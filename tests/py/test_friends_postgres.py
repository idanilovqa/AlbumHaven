"""Independent Postgres contracts for same-server Social authority and lifecycle."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from uuid import uuid4

import pytest

from music_app.services.friends_postgres import (
    FriendConflictError, FriendScopeError, PostgresFriendsStore, authorized_friend_read,
)
from tests.e2e.support import isolatedPostgres
from tests.py.track_taste_testing import taste_database


@pytest.fixture
def friends(taste_database):
    prefix='friends-'+uuid4().hex
    with isolatedPostgres._connect(taste_database.setup_url) as c:
        main=c.execute("select min(id) as id from library.libraries where library_kind='local'").fetchone()['id']
        ids=[]
        for suffix in ('a','b','c','outsider'):
            name=prefix+'-'+suffix
            ids.append(c.execute("""insert into app.accounts(display_name,account_kind,username_display,username_normalized,contact_email,contact_email_normalized)
                values(%s,'managed_user',%s,%s,%s,%s) returning id""",(name,name,name,name+'@example.test',name+'@example.test')).fetchone()['id'])
        library=c.execute("insert into library.libraries(owner_account_id,name) values(%s,%s) returning id",(ids[0],prefix)).fetchone()['id']
        for account in ids[:3]:
            for lid in (library,main):
                c.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'member')",(account,lid))
                for key in ('capability.social','capability.view'):
                    c.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)",(account,key,lid))
        c.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,'capability.admin','library',%s)",(ids[0],library))
    fixture=SimpleNamespace(database=taste_database,prefix=prefix,a=ids[0],b=ids[1],c=ids[2],outsider=ids[3],library=library,main=main,
        config={'ALBUM_HAVEN_APP_DATABASE_URL':taste_database.runtime_url})
    from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
    sessions=PostgresAuthSessionService(fixture.config)
    fixture.sessions={account:sessions.issue_session(account).session_id for account in ids[:3]}
    fixture.store=PostgresFriendsStore(fixture.config,connect=isolatedPostgres._connect)
    fixture.connect=lambda:isolatedPostgres._connect(taste_database.setup_url)
    with fixture.connect() as c:
        fixture.refs={row['account_id']:str(row['account_ref']) for row in c.execute('select account_id,account_ref from app.social_profiles where account_id=any(%s)',(ids,)).fetchall()}
    fixture.args=lambda actor=None,target=None:{'account_id':actor or fixture.a,'library_id':library,
        **({'target_account_id':target} if target else {})}
    fixture.write_args=lambda actor=None,target=None:{**fixture.args(actor,target),'actor_session_id':fixture.sessions[actor or fixture.a]}
    try:
        yield fixture
    finally:
        with fixture.connect() as c:
            c.execute('delete from app.accounts where id=any(%s)',(ids,))
            c.execute('delete from library.libraries where id=%s',(library,))


def befriend(f, *, library=None):
    args={'account_id':f.a,'library_id':library or f.library,'target_account_id':f.b,'actor_session_id':f.sessions[f.a]}
    request=f.store.transition(**args,action='request')
    accepted=f.store.transition(**{**args,'account_id':f.b,'target_account_id':f.a,'actor_session_id':f.sessions[f.b]},action='accept',expected_revision=request['revision'])
    return accepted


def test_request_accept_retry_and_private_notifications(friends):
    f=friends
    result=f.store.transition(**f.write_args(target=f.b),action='request')
    assert result['state']=='pending' and result['direction']=='outgoing'
    assert f.store.transition(**f.write_args(target=f.b),action='request')==result
    assert len(f.store.notifications(**f.args(f.b))['notifications'])==1
    assert f.store.notifications(**f.args(f.c))['notifications']==[]
    with pytest.raises(FriendConflictError):
        f.store.transition(**f.write_args(target=f.b),action='accept',expected_revision=result['revision'])
    with pytest.raises(FriendConflictError):
        f.store.transition(**f.write_args(f.b,f.a),action='request')
    result=f.store.transition(**f.write_args(f.b,f.a),action='accept',expected_revision=result['revision'])
    assert result['state']=='accepted'
    assert len(f.store.list_members(**f.args())['members'])==1
    with f.connect() as c:
        with authorized_friend_read(c,**f.args(target=f.b)) as profile:
            assert profile['account_id']==f.b
            assert set(profile)=={'account_id','account_ref','display_name','username_display','relationship_revision'}
    notice=f.store.notifications(**f.args())['notifications'][0]
    assert notice['kind']=='friend_accepted'
    with pytest.raises(FriendScopeError):
        f.store.mark_notification_read(**f.write_args(f.c),notification_id=notice['id'])
    assert f.store.mark_notification_read(**f.write_args(),notification_id=notice['id'])['read']


@pytest.mark.parametrize('action,actor', [('decline','b'),('cancel','a')])
def test_request_ends_and_stale_revision_cannot_accept_reconnection(friends,action,actor):
    f=friends
    req=f.store.transition(**f.write_args(target=f.b),action='request')
    acting=getattr(f,actor); target=f.b if acting==f.a else f.a
    ended=f.store.transition(**f.write_args(acting,target),action=action,expected_revision=req['revision'])
    assert ended['state']=={'decline':'declined','cancel':'cancelled'}[action]
    fresh=f.store.transition(**f.write_args(target=f.b),action='request')
    with pytest.raises(FriendConflictError):
        f.store.transition(**f.write_args(f.b,f.a),action='accept',expected_revision=req['revision'])
    assert fresh['revision']>req['revision']


@pytest.mark.parametrize('change', ['disable','remove-membership','revoke-social'])
@pytest.mark.parametrize('subject', ['a','b'])
def test_current_authority_revocation_hides_profile_history_and_taste(friends,change,subject):
    f=friends; befriend(f); target=getattr(f,subject)
    with f.connect() as c:
        if change=='disable':
            c.execute('update app.accounts set is_active=false where id=%s',(target,))
        elif change=='remove-membership':
            c.execute('delete from library.library_memberships where account_id=%s and library_id=%s',(target,f.library))
        else:
            c.execute("update app.capabilities set revoked_at=now() where account_id=%s and scope_id=%s and capability_key='capability.social'",(target,f.library))
    with pytest.raises(FriendScopeError):
        f.store.profile(**f.args(target=f.b))
    with pytest.raises(FriendScopeError):
        f.store.compare_taste(**f.write_args(target=f.b))
    with f.connect() as c, pytest.raises(FriendScopeError):
        with authorized_friend_read(c,**f.args(target=f.b)):
            pytest.fail('Revoked friend history became visible.')


def test_unfriend_remains_after_automatic_policy_toggles_and_reactivation(friends):
    f=friends
    assert f.store.policy(**f.write_args())=={'auto_friend':False}
    assert f.store.policy(**f.write_args(),auto_friend=True)=={'auto_friend':True}
    relation=f.store.profile(**f.args(target=f.b))['relationship']
    assert relation['state']=='accepted' and relation['origin']=='automatic'
    f.store.transition(**f.write_args(target=f.b),action='unfriend',expected_revision=relation['revision'])
    f.store.policy(**f.write_args(),auto_friend=False)
    assert f.store.profile(**f.args(target=f.c))['relationship']['state']=='accepted'
    f.store.policy(**f.write_args(),auto_friend=True)
    with f.connect() as c:
        c.execute('update app.accounts set is_active=false where id=%s',(f.b,))
        c.execute('update app.accounts set is_active=true where id=%s',(f.b,))
    assert f.store.profile(**f.args(target=f.b))['relationship']['state']=='removed'
    with pytest.raises(FriendScopeError):
        f.store.compare_taste(**f.write_args(target=f.b))
    assert befriend(f)['state']=='accepted'


def test_auto_policy_connects_newly_eligible_accounts_but_not_pending_requests(friends):
    f=friends
    request=f.store.transition(**f.write_args(target=f.b),action='request')
    with f.connect() as c:
        c.execute("update app.capabilities set revoked_at=now() where account_id=%s and scope_id=%s and capability_key='capability.social'",(f.c,f.library))
    f.store.policy(**f.write_args(),auto_friend=True)
    assert f.store.profile(**f.args(target=f.b))['relationship']['state']=='pending'
    with f.connect() as c:
        c.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,'capability.social','library',%s)",(f.c,f.library))
    assert f.store.profile(**f.args(target=f.c))['relationship']['state']=='accepted'
    assert f.store.transition(**f.write_args(f.b,f.a),action='accept',expected_revision=request['revision'])['state']=='accepted'


def test_cross_library_self_outsider_and_non_admin_fail_closed(friends):
    f=friends; befriend(f)
    for target in (f.a,f.outsider):
        with pytest.raises(FriendScopeError):
            f.store.profile(**f.args(target=target))
    with pytest.raises(FriendScopeError):
        f.store.policy(**f.write_args(f.b),auto_friend=True)
    assert f.store.profile(account_id=f.a,library_id=f.main,target_account_id=f.b)['relationship']['state']=='none'
    with pytest.raises(FriendScopeError):
        f.store.compare_taste(account_id=f.a,library_id=f.main,target_account_id=f.b,actor_session_id=f.sessions[f.a])


def test_concurrent_reciprocal_requests_create_one_pending_pair(friends):
    f=friends
    def send(actor,target):
        try:
            return f.store.transition(**f.write_args(actor,target),action='request')['state']
        except FriendConflictError:
            return 'conflict'
    with ThreadPoolExecutor(max_workers=2) as executor:
        jobs=[executor.submit(send,f.a,f.b),executor.submit(send,f.b,f.a)]
        assert sorted(job.result(timeout=10) for job in jobs)==['conflict','pending']
    with f.connect() as c:
        assert c.execute('select count(*) as n from app.friend_connections where library_id=%s',(f.library,)).fetchone()['n']==1
        assert c.execute('select count(*) as n from app.friend_notifications where library_id=%s',(f.library,)).fetchone()['n']==1


def test_discovery_paging_and_literal_query_never_expose_private_account_fields(friends):
    f=friends
    page=f.store.list_members(**f.args(),mode='discover',limit=1)
    assert len(page['members'])==1 and page['next_after']
    next_page=f.store.list_members(**f.args(),mode='discover',after=page['next_after'],limit=1)
    assert next_page['members'][0]['account_id']!=page['members'][0]['account_id']
    assert f.store.list_members(**f.args(),mode='discover',query='%')['members']==[]
    assert f.store.list_members(**f.args(),mode='discover',query='_')['members']==[]
    assert set(page['members'][0])=={'account_id','account_ref','display_name','username_display','relationship'}


def test_taste_projection_uses_current_scoped_preferences_without_paths(friends):
    f=friends;befriend(f)
    with f.connect() as c:
        artist=c.execute("insert into library.local_artists(library_id,artist_key,name) values(%s,%s,'Artist') returning id",(f.library,f.prefix)).fetchone()['id']
        album=c.execute("insert into library.local_albums(library_id,artist_id,album_key,title) values(%s,%s,%s,'Album') returning id",(f.library,artist,f.prefix)).fetchone()['id']
        track=c.execute("insert into library.local_tracks(library_id,artist_id,album_id,track_key,title) values(%s,%s,%s,%s,'Track') returning id",(f.library,artist,album,f.prefix)).fetchone()['id']
        c.execute("insert into library.local_track_files(track_id,private_path) values(%s,%s)",(track,'/private/'+f.prefix+'.flac'))
        for account,rating,love in [(f.a,1,'loved'),(f.b,5,'obsessed')]:
            c.execute("insert into app.track_preferences(account_id,library_id,track_key,rating,love_tier) values(%s,%s,%s,%s,%s)",(account,f.library,f.prefix,rating,love))
        c.execute("insert into app.album_ratings(account_id,library_id,album_key,rating,provenance) values(%s,%s,%s,9,'fixture')",(f.b,f.library,f.prefix))
    result=f.store.compare_taste(**f.write_args(target=f.b))
    assert len(result['rows'])==1
    assert result['rows'][0]['own_rating']==1 and result['rows'][0]['friend_rating']==5
    assert '/private/' not in str(result) and f.prefix not in str(result)
    assert f.store.compare_taste(**f.write_args(target=f.b),kind='albums')['rows'][0]['friend_rating']==9
    from music_app.services.friends_postgres import load_friend_taste
    with f.connect() as c:
        frozen=load_friend_taste(c,**f.args(target=f.b),kind='tracks',resource_ids=[track])
        assert frozen['items'][track]['friend_rating']==5
    with f.connect() as c:
        c.execute('update app.track_preferences set rating=3 where account_id=%s and library_id=%s',(f.b,f.library))
    with f.connect() as c:
        changed=load_friend_taste(c,**f.args(target=f.b),kind='tracks',resource_ids=[track])
        assert changed['revision']!=frozen['revision']
        assert changed['items'][track]['friend_rating']==3
        c.execute("""update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache}',
            coalesce(metadata->'scan_cache','{}'::jsonb) || '{"stale":true}'::jsonb,true)
            where track_id=%s""",(track,))
    assert f.store.compare_taste(**f.write_args(target=f.b))['rows']==[]


@pytest.mark.parametrize('kind',['membership','grant','account'])
def test_repeatable_read_guard_rejects_scope_revoked_after_snapshot(friends,kind):
    from psycopg.errors import SerializationFailure
    f=friends;befriend(f)
    with f.connect() as reader:
        reader.execute('set transaction isolation level repeatable read')
        reader.execute('select count(*) from app.accounts').fetchone()
        with f.connect() as writer:
            if kind=='membership':
                writer.execute('delete from library.library_memberships where account_id=%s and library_id=%s',(f.b,f.library))
            elif kind=='grant':
                writer.execute("update app.capabilities set revoked_at=now() where account_id=%s and scope_id=%s and capability_key='capability.social'",(f.b,f.library))
            else:
                writer.execute('update app.accounts set is_active=false where id=%s',(f.b,))
        with pytest.raises(SerializationFailure):
            with authorized_friend_read(reader,**f.args(target=f.b)):
                pytest.fail('A stale snapshot authorized friend data.')
        reader.rollback()


@pytest.mark.parametrize('kind',['membership','grant','pair'])
def test_authorized_read_holds_scope_and_relationship_until_consumer_finishes(friends,kind):
    from psycopg.errors import LockNotAvailable
    f=friends;befriend(f)
    with f.connect() as reader:
        with authorized_friend_read(reader,**f.args(target=f.b)):
            with pytest.raises(LockNotAvailable):
                with f.connect() as writer:
                    writer.execute("set local lock_timeout='100ms'")
                    if kind=='membership':
                        writer.execute('delete from library.library_memberships where account_id=%s and library_id=%s',(f.b,f.library))
                    elif kind=='grant':
                        writer.execute("update app.capabilities set revoked_at=now() where account_id=%s and scope_id=%s and capability_key='capability.social'",(f.b,f.library))
                    else:
                        writer.execute("update app.friend_connections set state='removed' where library_id=%s and low_account_id=%s and high_account_id=%s",(f.library,min(f.a,f.b),max(f.a,f.b)))


def test_automatic_backfill_does_not_wait_on_unrelated_admin_account_or_library_locks(friends):
    f=friends
    with f.connect() as admin:
        admin.execute('select id from app.accounts where id=%s for update',(f.b,)).fetchone()
        admin.execute('select id from library.libraries where id=%s for update',(f.library,)).fetchone()
        with f.connect() as enabling:
            enabling.execute("set local lock_timeout='500ms'")
            enabling.execute('update app.friend_policies set auto_friend=true where library_id=%s',(f.library,))
            enabling.execute('select app.sync_automatic_friends(%s)',(f.library,))
    assert f.store.profile(**f.args(target=f.b))['relationship']['state']=='accepted'


@pytest.mark.parametrize('mode', ['viewer','listener','musician','owner','admin','multiple','legacy','custom','stale','no-access'])
def test_social_default_migration_preserves_exact_custom_and_no_access_assignments(friends,mode):
    import json
    from pathlib import Path
    from music_app.services.capabilities import ROLE_PRESETS,effective_capability_keys
    f=friends
    roles=['viewer','admin'] if mode=='multiple' else [mode] if mode in ROLE_PRESETS else []
    grants=set(effective_capability_keys(set().union(*(ROLE_PRESETS[key] for key in roles))))-{'capability.social'}
    assignment={'version':1,'role_keys':roles,'capability_keys':[]}
    if mode=='legacy':
        grants={'library.browse.read','library.media.read','library.resources.read','library.playlists.create','library.discovery.read'}
        assignment=None
    if mode in {'custom','stale','no-access'}:
        grants={'capability.view'}
        assignment={'version':1,'role_keys':[],'capability_keys':['capability.view']} if mode=='custom' else {'version':1,'role_keys':['listener'],'capability_keys':[]}
    migration=Path(__file__).resolve().parents[2]/'migrations/postgres/0090_create_same_server_friends.sql'
    sql=migration.read_text().split('-- Only exact recorded standard assignments')[1].split('-- This invoker-rights function')[0]
    sql=sql[sql.index('with role_grants'):]
    with f.connect() as c:
        c.execute('delete from app.capabilities where account_id=%s and scope_id=%s',(f.b,f.library))
        for key in grants:
            c.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)",(f.b,key,f.library))
        c.execute("update app.accounts set metadata=jsonb_build_object('library_access_assignments_v1',%s::jsonb) where id=%s",
                  (json.dumps({str(f.library):assignment}) if assignment else '{}',f.b))
        if mode=='no-access':
            c.execute('delete from library.library_memberships where account_id=%s and library_id=%s',(f.b,f.library))
        before=c.execute('select metadata from app.accounts where id=%s',(f.b,)).fetchone()['metadata']
        c.execute(sql)
        after={row['capability_key'] for row in c.execute('select capability_key from app.capabilities where account_id=%s and scope_id=%s and revoked_at is null',(f.b,f.library)).fetchall()}
        assert after == grants|({'capability.social'} if mode not in {'custom','stale','no-access'} else set())
        assert c.execute('select metadata from app.accounts where id=%s',(f.b,)).fetchone()['metadata']==before
        c.rollback()


def test_runtime_role_cannot_readonly_export_or_rewrite_identity_mappings(friends):
    f=friends
    tables=('social_profiles','friend_connections','friend_policies','friend_notifications')
    with f.connect() as c:
        readonly=c.execute("select exists(select 1 from pg_roles where rolname='album_haven_readonly') as present").fetchone()['present']
        for table in tables:
            if readonly:
                assert not c.execute("select has_table_privilege('album_haven_readonly',%s,'SELECT') as allowed",('app.'+table,)).fetchone()['allowed']
            assert not c.execute("select has_table_privilege('album_haven_app',%s,'DELETE') as allowed",('app.'+table,)).fetchone()['allowed']
            assert c.execute("select has_table_privilege('album_haven_app',%s,'SELECT') as allowed",('app.'+table,)).fetchone()['allowed']
        assert not c.execute("select has_table_privilege('album_haven_app','app.social_profiles','UPDATE') as allowed").fetchone()['allowed']
        assert not c.execute("select coalesce(bool_or(acl.privilege_type is not null),false) as allowed from pg_class r cross join lateral aclexplode(r.relacl) acl where r.oid='app.friend_connections'::regclass and acl.grantee=0").fetchone()['allowed']


@pytest.mark.parametrize('operation',['request','policy','notice'])
def test_mutations_recheck_session_revoked_while_waiting_for_account(friends,monkeypatch,operation):
    from threading import Event
    from music_app.services import friends_postgres as service
    f=friends
    notice=None
    if operation=='notice':
        f.store.transition(**f.write_args(f.b,f.a),action='request')
        notice=f.store.notifications(**f.args())['notifications'][0]['id']
    entered=Event()
    original=service.lock_admin_accounts
    def observe(connection,*args):
        entered.set()
        return original(connection,*args)
    monkeypatch.setattr(service,'lock_admin_accounts',observe)
    def mutate():
        if operation=='request':
            return f.store.transition(**f.write_args(target=f.b),action='request')
        if operation=='policy':
            return f.store.policy(**f.write_args(),auto_friend=True)
        return f.store.mark_notification_read(**f.write_args(),notification_id=notice)
    executor=ThreadPoolExecutor(max_workers=1)
    try:
        with f.connect() as blocker:
            blocker.execute('select id from app.accounts where id=%s for update',(f.a,))
            future=executor.submit(mutate)
            assert entered.wait(5)
            blocker.execute('update app.account_sessions set revoked_at=now() where id=%s',(f.sessions[f.a],))
        with pytest.raises(FriendScopeError):
            future.result(timeout=10)
    finally:
        executor.shutdown(wait=True,cancel_futures=True)
    if operation=='request':
        assert f.store.profile(**f.args(target=f.b))['relationship']['state']=='none'
    elif operation=='notice':
        assert f.store.notifications(**f.args())['notifications'][0]['read_at'] is None
    else:
        with f.connect() as c:
            assert c.execute('select auto_friend from app.friend_policies where library_id=%s',(f.library,)).fetchone()['auto_friend'] is False


def test_standalone_taste_read_rejects_session_revoked_during_account_lock_wait(friends,monkeypatch):
    from contextlib import contextmanager
    from threading import Event
    from music_app.services import friends_postgres as service
    f=friends;befriend(f)
    entered=Event()
    original=service.authorized_friend_read
    @contextmanager
    def observe(connection,**kwargs):
        entered.set()
        with original(connection,**kwargs) as scope:
            yield scope
    monkeypatch.setattr(service,'authorized_friend_read',observe)
    executor=ThreadPoolExecutor(max_workers=1)
    try:
        with f.connect() as blocker:
            blocker.execute('select id from app.accounts where id=%s for update',(f.a,))
            future=executor.submit(f.store.compare_taste,**f.write_args(target=f.b))
            assert entered.wait(5)
            blocker.execute('update app.account_sessions set revoked_at=now() where id=%s',(f.sessions[f.a],))
        with pytest.raises(FriendScopeError):
            future.result(timeout=10)
    finally:
        executor.shutdown(wait=True,cancel_futures=True)


def test_standalone_taste_read_holds_session_through_projection_and_rechecks_expiry(friends,monkeypatch):
    from psycopg.errors import LockNotAvailable
    from music_app.services import friends_postgres as service
    f=friends;befriend(f)
    original=service.read_friend_taste_page
    def checkpoint(connection,**kwargs):
        with pytest.raises(LockNotAvailable):
            with f.connect() as revoker:
                revoker.execute("set local lock_timeout='100ms'")
                revoker.execute('update app.account_sessions set revoked_at=now() where id=%s',(f.sessions[f.a],))
        result=original(connection,**kwargs)
        connection.execute("update app.account_sessions set idle_expires_at=now()-interval '1 second' where id=%s",(f.sessions[f.a],))
        return result
    monkeypatch.setattr(service,'read_friend_taste_page',checkpoint)
    with pytest.raises(FriendScopeError):
        f.store.compare_taste(**f.write_args(target=f.b))
