"""Independent favorite storage, grants, CAS and real lock acceptance contracts.

Source-only authored. Every DB test requires the existing migrated PostgreSQL 14
persistent CI job. No migration or test execution is implied by this file.
"""
from datetime import timedelta
from threading import Event
import time

import pytest
from psycopg.types.json import Jsonb

from music_app.services.album_preferences import AlbumPreferenceError
from music_app.services.album_preferences_postgres import load_album_preferences_on_connection
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.album_favorites_postgres_support import favorites_db, favorites_bootstrap_db, Workers, observed, await_blocker, deny


def error(status, operation):
    with pytest.raises(AlbumPreferenceError) as caught:
        operation()
    assert caught.value.status == status
    return caught.value


def test_migrated_schema_defaults_constraints_and_no_new_counter_privilege(favorites_db):
    db = favorites_db
    with db.connect() as con:
        cols = {r['column_name']: r for r in con.execute("""select column_name,data_type,is_nullable,column_default
            from information_schema.columns where table_schema='app' and table_name='album_ratings'
            and column_name in ('favorite','preference_revision')""").fetchall()}
        assert cols['favorite']['data_type'] == 'boolean' and cols['favorite']['is_nullable'] == 'YES'
        assert cols['preference_revision']['data_type'] == 'bigint' and cols['preference_revision']['is_nullable'] == 'NO'
        assert cols['preference_revision']['column_default'] in ('1', "'1'::bigint")
        funcs = con.execute("""select p.proname,p.prosecdef,p.proconfig from pg_proc p
            join pg_namespace n on n.oid=p.pronamespace where n.nspname='app'
            and p.proname=any(%s) order by p.proname""",
            (['bump_home_album_taste_revision', 'invalidate_home_album_taste'],)).fetchall()
        assert len(funcs) == 2
        assert all(r['prosecdef'] and 'search_path=pg_catalog' in r['proconfig'] for r in funcs)
        assert con.execute("""select count(*) as n from pg_trigger
            where tgrelid='app.album_ratings'::regclass and tgname='home_album_taste_change'
            and not tgisinternal and tgenabled='O'""").fetchone()['n'] == 1
        for role in ('album_haven_app', 'album_haven_readonly'):
            for function in ('app.bump_home_album_taste_revision(bigint,bigint)', 'app.invalidate_home_album_taste()'):
                assert not con.execute("select has_function_privilege(%s,%s,'EXECUTE') as ok", (role, function)).fetchone()['ok']
            for privilege in ('UPDATE','DELETE','TRUNCATE'):
                assert not con.execute('select has_table_privilege(%s,%s,%s) as ok',
                    (role, 'app.activity_source_revisions', privilege)).fetchone()['ok']
        assert not con.execute("select has_table_privilege('album_haven_app','app.album_ratings','DELETE') as ok").fetchone()['ok']
        # PUBLIC ACL is checked directly, not through a privileged owner.
        assert not con.execute("""select exists(select 1 from pg_proc p
            join pg_namespace n on n.oid=p.pronamespace,
            lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
            where n.nspname='app' and p.proname=any(%s) and acl.grantee=0
              and acl.privilege_type='EXECUTE') as granted""",
            (['bump_home_album_taste_revision','invalidate_home_album_taste'],)).fetchone()['granted']
    # New importer-shaped legacy insert gets defaults; existing rating metadata
    # is preserved by favorite-only edits, without claiming pre-migration replay.
    album = db.albums[0]
    with db.connect() as con:
        row = con.execute("""insert into app.album_ratings(account_id,library_id,album_key,rating,provenance,metadata)
            values(%s,%s,%s,8,'file_tag_scan',%s) returning id,favorite,preference_revision""",
            (db.owner.account_id,db.library,album['key'],Jsonb({'old': [1,2]}))).fetchone()
    db.preference_ids.add(row['id'])
    assert row['favorite'] is None and row['preference_revision'] == 1
    before = db.rows()[0]
    db.patch(album, {'favorite': True}, 1)
    after = db.rows()[0]
    assert (after['rating'],after['provenance'],after['metadata'],after['created_at']) == (
        before['rating'],before['provenance'],before['metadata'],before['created_at'])


@pytest.mark.parametrize('capability', ['capability.view', 'library.browse.read'])
def test_view_and_legacy_browse_users_manage_only_their_own_independent_state(favorites_db, capability):
    db = favorites_db
    actor = db.member(capability)
    album = db.albums[0]
    assert db.read(album,actor)['favorite'] is False
    assert db.read(album,actor)['preference_revision'] == 0
    own = db.patch(album, {'rating': 2,'favorite': True}, actor=actor)
    peer = db.patch(album, {'rating': 9,'favorite': False}, actor=db.peer)
    assert own['account_id'] == actor.account_id and peer['account_id'] == db.peer.account_id
    assert db.read(album,actor)['rating'] == 2 and db.read(album,db.peer)['rating'] == 9
    assert db.read(album,actor)['favorite'] is True and db.read(album,db.peer)['favorite'] is False
    assert db.read(album,db.owner)['rating'] is None
    assert db.read(album,db.owner)['favorite_override'] is None


def test_explicit_false_partial_clear_and_noop_keep_whole_row_import_barrier(favorites_db):
    db = favorites_db
    album = db.albums[0]
    first = db.patch(album, {'favorite': False})
    assert first['favorite'] is False and first['favorite_override'] is False
    assert first['favorite_source'] == 'personal' and first['preference_revision'] == 1
    original = db.rows()[0]
    epoch = db.epochs()
    repeated = db.patch(album, {'favorite': False}, 1)
    assert repeated == first and db.rows()[0] == original and db.epochs() == epoch
    rated = db.patch(album, {'rating': 6}, 1)
    assert rated['favorite_override'] is False and rated['rating'] == 6
    clear = db.patch(album, {'rating': None,'favorite': False}, 2)
    assert clear['preference_revision'] == 3 and clear['rating'] is None
    assert clear['favorite'] is False and clear['favorite_override'] is False
    assert clear['favorite_source'] == 'personal'
    final = db.rows()[0]
    assert final['id'] == original['id'] and final['created_at'] == original['created_at']
    assert final['provenance'] == 'personal_rating' and final['metadata'] == original['metadata']
    error(409, lambda: db.patch(album, {'favorite': True}, 0))
    assert db.rows()[0] == final



def test_existing_null_favorite_becomes_explicit_false_without_replacing_row(favorites_db):
    db = favorites_db
    album = db.albums[0]
    row_id = db.seed(album, rating=7, favorite=None)
    before = next(row for row in db.rows() if row['id'] == row_id)
    assert before['favorite'] is None and before['preference_revision'] == 1
    initial = db.read(album)
    assert initial['favorite'] is False and initial['favorite_override'] is None
    epoch = db.epochs()
    result = db.patch(album, {'favorite': False}, 1)
    after = next(row for row in db.rows() if row['id'] == row_id)
    assert result['favorite'] is False and result['favorite_override'] is False
    assert result['favorite_source'] == 'personal' and result['preference_revision'] == 2
    assert after['favorite'] is False and after['preference_revision'] == 2
    for field in ('id', 'account_id', 'library_id', 'album_key', 'rating', 'provenance', 'metadata', 'created_at'):
        assert after[field] == before[field]
    changed = db.epochs()
    assert changed['album_taste_revision'] == epoch['album_taste_revision'] + 1
    assert (changed['revision'], changed['love_revision']) == (epoch['revision'], epoch['love_revision'])
    assert db.patch(album, {'favorite': False}, 2) == result
    assert next(row for row in db.rows() if row['id'] == row_id) == after
    assert db.epochs() == changed


def test_epoch_detects_revision_only_and_away_back_without_changing_history_or_love(favorites_db):
    db = favorites_db
    album = db.albums[0]
    db.patch(album, {'favorite': True})
    baseline = db.epochs()
    db.patch(album, {'favorite': False}, 1)
    db.patch(album, {'favorite': True}, 2)
    changed = db.epochs()
    assert changed['album_taste_revision'] == baseline['album_taste_revision']+2
    assert (changed['revision'], changed['love_revision']) == (baseline['revision'],baseline['love_revision'])
    with db.connect() as con:
        con.execute('update app.album_ratings set preference_revision=preference_revision+1 where id=%s', (db.rows()[0]['id'],))
    assert db.epochs()['album_taste_revision'] == changed['album_taste_revision']+1
    with db.connect() as con:
        con.execute('update app.album_ratings set rating=rating,favorite=favorite where id=%s', (db.rows()[0]['id'],))
    assert db.epochs()['album_taste_revision'] == changed['album_taste_revision']+1


@pytest.mark.parametrize('fault', ['stale_file','deleted_file','deleted_album'])
def test_unavailable_source_never_mints_false_available_or_writes(favorites_db, fault):
    db = favorites_db
    album = db.albums[0]
    with db.connect() as con:
        if fault == 'stale_file':
            con.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true') where id=%s", (album['file'],))
        elif fault == 'deleted_file':
            con.execute('delete from library.local_track_files where id=%s', (album['file'],))
        elif fault == 'deleted_album':
            con.execute('delete from library.local_albums where id=%s', (album['id'],))
    before = db.rows()
    assert db.read(album) is None
    error(404, lambda: db.patch(album, {'favorite': True}))
    assert db.rows() == before


@pytest.mark.parametrize('fault', ['account','membership','view','session'])
def test_durable_denial_prevents_write(favorites_db, fault):
    db = favorites_db
    with db.connect() as con:
        if fault == 'account':
            con.execute('update app.accounts set is_active=false where id=%s', (db.owner.account_id,))
        elif fault == 'membership':
            con.execute('delete from library.library_memberships where account_id=%s and library_id=%s', (db.owner.account_id,db.library))
        elif fault == 'view':
            con.execute("update app.capabilities set revoked_at=clock_timestamp() where account_id=%s and capability_key='capability.view'", (db.owner.account_id,))
        else:
            con.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s', (db.owner.session_id,))
    error(403, lambda: db.patch(db.albums[0], {'favorite': True}))
    assert db.rows() == []


@pytest.mark.parametrize('existing', [False, True])
@pytest.mark.parametrize('fault', ['session_clock','late_policy'])
def test_final_checks_roll_back_insert_or_update_after_dml(favorites_db, existing, fault):
    db = favorites_db
    album = db.albums[0]
    if existing:
        db.patch(album, {'favorite': False})
    before, epoch = db.rows(), db.epochs()
    changed = Event()
    def after(sql, params, con):
        if 'insert into app.album_ratings' in sql or 'update app.album_ratings' in sql:
            changed.set()
            if fault == 'session_clock':
                db.clock_time = db.now+timedelta(days=2)
    def constraints(ctx):
        return PolicyEvaluationConstraints(request_origin_allowed=not (fault=='late_policy' and changed.is_set()))
    error(403, lambda: db.patch(album, {'favorite': True}, int(existing),
        connect=observed(db,after=after), constraints=constraints))
    assert changed.is_set() and db.rows() == before and db.epochs() == epoch


def test_first_create_race_is_one_commit_and_one_conflict_without_lost_fields(favorites_db):
    db = favorites_db
    album = db.albums[0]
    with Workers(db) as workers:
        barrier = workers.barrier()
        seen = Event()
        def after(sql, params, con):
            if 'insert into app.album_ratings' in sql and not seen.is_set():
                seen.set(); barrier.pause()
        one = workers.start(lambda: db.patch(album, {'favorite': True}, connect=observed(db,after=after)))
        assert barrier.reached.wait(5)
        second_pid = []
        def before(sql, params, con):
            if not second_pid:
                second_pid.append(con.info.backend_pid)
        two = workers.start(lambda: db.patch(album, {'rating': 7}, connect=observed(db,before=before)))
        deadline = time.monotonic()+5
        while not second_pid and time.monotonic()<deadline:
            time.sleep(.01)
        assert second_pid
        # Account UPDATE ownership serializes same-actor writers before CAS.
        first_pid = next(con.info.backend_pid for con in db.registry.items if not con.closed and con.info.backend_pid!=second_pid[0])
        await_blocker(db, second_pid[0], first_pid)
        barrier.release.set()
        workers.finish(one); workers.finish(two)
    assert not one.errors and len(two.errors)==1
    assert isinstance(two.errors[0],AlbumPreferenceError) and two.errors[0].status==409
    state = db.read(album)
    assert state['favorite'] is True and state['rating'] is None and state['preference_revision']==1
    fresh = db.patch(album, {'rating': 7}, 1)
    assert fresh['favorite'] is True and fresh['rating']==7 and len(db.rows())==1
    error(409, lambda: db.patch(album, {'favorite': False}, 1))
    assert db.read(album)==fresh


def test_source_change_committed_while_writer_waits_prevents_write(favorites_db):
    db = favorites_db
    album = db.albums[0]
    with Workers(db) as workers:
        with db.connect() as blocker:
            blocker.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true') where id=%s", (album['file'],))
            reached = Event(); pid = []
            def before(sql, params, con):
                if 'local_track_files' in sql and 'for share' in sql:
                    pid.append(con.info.backend_pid); reached.set()
            job=workers.start(lambda: db.patch(album, {'favorite': True},connect=observed(db,before=before)))
            assert reached.wait(5)
            await_blocker(db,pid[0],blocker.info.backend_pid)
        workers.finish(job)
    assert len(job.errors)==1 and isinstance(job.errors[0],AlbumPreferenceError)
    assert job.errors[0].status in (404,409) and db.rows()==[]


def test_source_witness_cannot_be_removed_until_writer_commits(favorites_db):
    db=favorites_db; album=db.albums[0]
    with Workers(db) as workers:
        held=workers.barrier(); writer_pid=[]
        def after(sql,params,con):
            if 'insert into app.album_ratings' in sql:
                writer_pid.append(con.info.backend_pid); held.pause()
        writer=workers.start(lambda:db.patch(album,{'favorite':True},connect=observed(db,after=after)))
        assert held.reached.wait(5)
        delete_pid=[]; started=Event()
        def remove():
            with db.connect() as con:
                delete_pid.append(con.info.backend_pid); started.set()
                con.execute('delete from library.local_track_files where id=%s',(album['file'],))
        remover=workers.start(remove)
        assert started.wait(5); await_blocker(db,delete_pid[0],writer_pid[0])
        held.release.set(); workers.finish(writer); workers.finish(remover)
    assert not writer.errors and not remover.errors
    assert db.read(album) is None and len(db.rows())==1


def test_row_revision_overflow_rolls_back_both_taste_and_epoch(favorites_db):
    db=favorites_db; album=db.albums[0]
    db.patch(album,{'favorite':True})
    with db.connect() as con:
        con.execute('update app.album_ratings set preference_revision=9223372036854775807 where id=%s',(db.rows()[0]['id'],))
    before,epoch=db.rows(),db.epochs()
    error(503,lambda:db.patch(album,{'favorite':False},9223372036854775807))
    assert db.rows()==before and db.epochs()==epoch


def test_shared_loader_requires_owned_transaction_and_exact_bounded_scope(favorites_db):
    db=favorites_db; album=db.albums[0]
    with db.app_connect(db.app_url) as con:
        con.autocommit=True
        with pytest.raises(RuntimeError):
            load_album_preferences_on_connection(con,account_id=db.owner.account_id,library_id=db.library,album_ids=[album['id']])
    with db.app_connect(db.app_url) as con:
        for invalid in (True,0,'1'):
            with pytest.raises(AlbumPreferenceError):
                load_album_preferences_on_connection(con,account_id=invalid,library_id=db.library,album_ids=[album['id']])
        with pytest.raises(AlbumPreferenceError):
            load_album_preferences_on_connection(con,account_id=db.owner.account_id,library_id=db.library,album_ids=[album['id']]*1001)
        rows=load_album_preferences_on_connection(con,account_id=db.owner.account_id,library_id=db.library,album_ids=[album['id'],album['id']])
        assert list(rows)==[album['id']]
        assert rows[album['id']]['taste_state']=='available' and rows[album['id']]['favorite'] is False


@pytest.mark.parametrize('api',['seed','import'])
@pytest.mark.parametrize('intent',[{'favorite':True},{'rating':None},{'favorite':False,'rating':None},{'favorite':False}])
def test_real_legacy_importer_cannot_overwrite_any_personal_row(favorites_bootstrap_db,api,intent):
    from music_app.services.album_ratings_postgres import PostgresAlbumRatingsService
    db=favorites_bootstrap_db;album=db.albums[0]
    db.patch(album,intent,actor=db.bootstrap_owner)
    before=db.rows();epoch=db.epochs(db.bootstrap_owner)
    with db.connect() as con:
        con.execute("update library.local_albums set metadata=jsonb_set(metadata,'{tag_album_rating}','9') where id=%s",(album['id'],))
    importer=PostgresAlbumRatingsService(db.config,connect=db.app_connect)
    if api=='import':
        counts=importer.import_missing_tag_ratings()
    else:
        with db.app_connect(db.app_url) as con:
            counts=importer.seed_missing_album_ratings_in_transaction(con,[{'album_key':album['key'],'tag_album_rating':9}],source='file_tag_scan')
    assert counts=={'created':0,'authority_skipped':1,'failed':0}
    assert db.rows()==before and db.epochs(db.bootstrap_owner)==epoch


def test_real_import_before_favorite_preserves_metadata_and_favorite_does_not_promote_provenance(favorites_bootstrap_db):
    from music_app.services.album_ratings_postgres import PostgresAlbumRatingsService
    db=favorites_bootstrap_db;album=db.albums[0]
    importer=PostgresAlbumRatingsService(db.config,connect=db.app_connect)
    with db.app_connect(db.app_url) as con:
        counts=importer.seed_missing_album_ratings_in_transaction(con,[{'album_key':album['key'],'tag_album_rating':7}],source='file_tag_scan')
    db.capture_owned_preferences(album,db.bootstrap_owner)
    assert counts=={'created':1,'authority_skipped':0,'failed':0}
    before=db.rows()[0]
    assert before['favorite'] is None and before['preference_revision']==1
    db.patch(album,{'favorite':True},1,actor=db.bootstrap_owner)
    after=db.rows()[0]
    assert after['rating']==7 and after['provenance']==before['provenance']
    assert after['metadata']==before['metadata'] and after['created_at']==before['created_at']
    # Explicit rating intent, even same value, establishes personal provenance.
    epoch=db.epochs(db.bootstrap_owner)
    db.patch(album,{'rating':7},2,actor=db.bootstrap_owner)
    assert db.rows()[0]['provenance']=='personal_rating'
    assert db.epochs(db.bootstrap_owner)['album_taste_revision']==epoch['album_taste_revision']+1


def test_actual_importer_wins_absent_row_race_without_stale_patch_overwrite(favorites_bootstrap_db):
    from music_app.services.album_ratings_postgres import PostgresAlbumRatingsService
    db=favorites_bootstrap_db;album=db.albums[0]
    with Workers(db) as workers:
        importer_held=workers.barrier();started=Event();writer_pid=[];importer_pid=[]
        def import_then_pause():
            with db.app_connect(db.app_url) as con:
                importer_pid.append(con.info.backend_pid)
                result=PostgresAlbumRatingsService(db.config).seed_missing_album_ratings_in_transaction(con,
                    [{'album_key':album['key'],'tag_album_rating':8}],source='file_tag_scan')
                importer_held.pause()
            db.capture_owned_preferences(album,db.bootstrap_owner)
            return result
        importing=workers.start(import_then_pause)
        assert importer_held.reached.wait(5)
        def before(sql,params,con):
            if 'insert into app.album_ratings' in sql:
                writer_pid.append(con.info.backend_pid);started.set()
        writing=workers.start(lambda:db.patch(album,{'favorite':True},actor=db.bootstrap_owner,
            connect=observed(db,before=before)))
        assert started.wait(5)
        await_blocker(db,writer_pid[0],importer_pid[0])
        importer_held.release.set();workers.finish(importing);workers.finish(writing)
    assert not importing.errors and importing.result[0]['created']==1
    assert len(writing.errors)==1 and isinstance(writing.errors[0],AlbumPreferenceError) and writing.errors[0].status==409
    state=db.read(album,db.bootstrap_owner)
    assert state['rating']==8 and state['favorite_override'] is None and state['preference_revision']==1
    assert len(db.rows())==1


def test_trigger_epoch_overflow_aborts_entire_transaction_without_durable_counter_reset(favorites_db):
    import psycopg
    db=favorites_db;album=db.albums[0];db.patch(album,{'favorite':True})
    before,epoch=db.rows(),db.epochs()
    # The artificial exhaustion exists only inside this failing transaction.
    # It never commits and is never followed by a durable counter reset.
    with pytest.raises(psycopg.errors.NumericValueOutOfRange):
        with db.connect() as con:
            con.execute('update app.activity_source_revisions set album_taste_revision=9223372036854775807 where library_id=%s and account_id=%s',
                (db.library,db.owner.account_id))
            con.execute('update app.album_ratings set favorite=false,preference_revision=preference_revision+1 where id=%s',(before[0]['id'],))
    assert db.rows()==before and db.epochs()==epoch


def test_scope_movement_bumps_each_distinct_scope_once(favorites_db):
    db=favorites_db;album=db.albums[0];db.patch(album,{'favorite':True})
    # Ensure two existing rows without resetting either monotonic counter.
    with db.connect() as con:
        con.execute('insert into app.activity_source_revisions(library_id,account_id) values(%s,%s) on conflict do nothing',
            (db.library,db.peer.account_id))
    before_owner,before_peer=db.epochs(),db.epochs(db.peer)
    with db.connect() as con:
        con.execute('update app.album_ratings set account_id=%s where id=%s',(db.peer.account_id,db.rows()[0]['id']))
    assert db.epochs()['album_taste_revision']==before_owner['album_taste_revision']+1
    assert db.epochs(db.peer)['album_taste_revision']==before_peer['album_taste_revision']+1
    assert db.read(album)['favorite'] is False and db.read(album,db.peer)['favorite'] is True


def test_album_cascade_removes_only_its_preference_and_bumps_epoch(favorites_db):
    db=favorites_db;album=db.albums[0];other=db.add_album('protected')
    db.patch(album,{'favorite':True});db.patch(other,{'rating':3})
    protected=next(row for row in db.rows() if row['album_key']==other['key'])
    epoch=db.epochs()
    with db.connect() as con:
        con.execute('delete from library.local_albums where id=%s',(album['id'],))
    assert db.rows()==[protected]
    assert db.epochs()['album_taste_revision']==epoch['album_taste_revision']+1


def test_two_legacy_first_writes_serialize_missing_epoch_without_lost_increment(favorites_db):
    db=favorites_db;first=db.albums[0];second=db.add_album('second-first-write')
    assert db.epochs() is None
    def insert(con,album):
        return con.execute("""insert into app.album_ratings(account_id,library_id,album_key,rating,provenance)
            values(%s,%s,%s,4,'file_tag_scan') returning id""",(db.owner.account_id,db.library,album['key'])).fetchone()['id']
    with Workers(db) as workers:
        held=workers.barrier();one_pid=[];two_pid=[];started=Event()
        def one():
            with db.connect() as con:
                one_pid.append(con.info.backend_pid)
                preference=insert(con,first);held.pause()
            db.preference_ids.add(preference)
        def two():
            with db.connect() as con:
                two_pid.append(con.info.backend_pid);started.set()
                preference=insert(con,second)
            db.preference_ids.add(preference)
        a=workers.start(one);assert held.reached.wait(5)
        b=workers.start(two);assert started.wait(5)
        await_blocker(db,two_pid[0],one_pid[0])
        held.release.set();workers.finish(a);workers.finish(b)
    assert not a.errors and not b.errors
    assert len(db.rows())==2 and db.epochs()['album_taste_revision']==2


def test_scope_move_acquires_lower_epoch_before_higher_epoch(favorites_db):
    db=favorites_db;album=db.albums[0]
    assert db.owner.account_id<db.peer.account_id
    db.patch(album,{'favorite':True},actor=db.peer)
    with db.connect() as con:
        con.execute('insert into app.activity_source_revisions(library_id,account_id) values(%s,%s) on conflict do nothing',
            (db.library,db.owner.account_id))
    row=db.rows()[0]
    with Workers(db) as workers:
        with db.connect() as blocker:
            blocker.execute('select account_id from app.activity_source_revisions where library_id=%s and account_id=%s for update',
                (db.library,db.owner.account_id))
            started=Event();pid=[]
            def move():
                with db.connect() as con:
                    pid.append(con.info.backend_pid);started.set()
                    con.execute('update app.album_ratings set account_id=%s where id=%s',(db.owner.account_id,row['id']))
            writer=workers.start(move);assert started.wait(5)
            await_blocker(db,pid[0],blocker.info.backend_pid)
            # If the trigger touched higher OLD scope first, this NOWAIT would
            # fail. Successful actual lock proves it waits on lower NEW first.
            with db.connect() as observer:
                observer.execute('select account_id from app.activity_source_revisions where library_id=%s and account_id=%s for update nowait',
                    (db.library,db.peer.account_id))
        workers.finish(writer)
    assert not writer.errors and db.read(album)['favorite'] is True


@pytest.mark.parametrize('available',[False,True])
@pytest.mark.parametrize('toggle',[False,True])
def test_mapper_keeps_only_explicit_independent_progress_with_truthful_taste(available,toggle):
    from music_app.services.album_preferences import serialize_own_album_preference
    from music_app.services.listen_through import normalize_album_preference_overlay
    state={'album_id':23,'library_id':29,'account_id':17,'rating':None,'favorite':False,
        'favorite_override':None,'favorite_source':None,'preference_revision':0,'taste_state':'available'}
    progress={'to_listen':True,'is_relisten':True,'can_toggle_to_listen':toggle}
    value=serialize_own_album_preference(state if available else None,library_id=29,
        context_ref='context',can_edit=True,verified_progress=progress,
        expected_account_id=17,expected_album_id=23)
    assert {key:value[key] for key in progress}==progress
    assert value['is_favorite'] is (False if available else None)
    assert value['can_edit'] is available
    # Presence in a cached wire object is not progress provenance. The explicit
    # independently authorized input is needed on every normalization boundary.
    unverified=normalize_album_preference_overlay(value)
    assert not set(progress)&set(unverified)
    verified=normalize_album_preference_overlay(value,verified_progress=progress)
    assert {key:verified[key] for key in progress}==progress
    assert verified['rating'] is None


@pytest.mark.parametrize('progress',[{'to_listen':1},{'is_relisten':None},{'can_toggle_to_listen':'true'},{'rating':9}])
def test_mapper_rejects_nonboolean_or_cross_owner_progress(progress):
    from music_app.services.album_preferences import serialize_own_album_preference
    with pytest.raises(AlbumPreferenceError):
        serialize_own_album_preference(None,library_id=29,context_ref='context',verified_progress=progress)


# Pure admission contracts: no leases, SQL, application startup or credential reads.
def hosted_favorites_environment(tmp_path):
    database = 'album_haven_ci_tops_123_2'
    app = 'postgresql://album_haven_app_tops_123_2@127.0.0.1:5432/'+database
    return {'ALBUM_HAVEN_FAVORITES_TEST_MODE': 'favorites_linux17',
        'GITHUB_ACTIONS': 'true', 'RUNNER_OS': 'Linux',
        'GITHUB_JOB': 'test_feature_batches_linux', 'FEATURE_BATCH': 'favorites_backend',
        'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '2',
        'DATABASE_MIGRATOR_URL': 'postgresql://album_haven_migrator_tops_123_2@127.0.0.1:5432/'+database,
        'DATABASE_APP_URL': app, 'ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL': app,
        'RUNNER_TEMP': str(tmp_path.resolve()), 'PGPASSFILE': str(tmp_path.resolve()/(database+'.pgpass'))}


def test_favorites_admission_default_remains_exact_pg14():
    from tests.py.album_favorites_postgres_support import lane_context, assert_lane_connection
    context=lane_context({})
    assert context=={'mode':'persistent14','major':14}
    assert_lane_connection(context,{},140001,'app')
    for version in (130000,150000,170000):
        with pytest.raises(AssertionError):
            assert_lane_connection(context,{},version,'app')


@pytest.mark.parametrize('key,value', [
    ('ALBUM_HAVEN_FAVORITES_TEST_MODE','17'), ('GITHUB_ACTIONS','false'),
    ('RUNNER_OS','Windows'), ('GITHUB_JOB','test_backend'), ('FEATURE_BATCH','loved_backend'),
    ('GITHUB_RUN_ID','0'), ('GITHUB_RUN_ID','-1'), ('GITHUB_RUN_ID','1'*40),
    ('GITHUB_RUN_ATTEMPT','0'), ('GITHUB_RUN_ATTEMPT','2.0'),
    ('DATABASE_APP_URL','postgresql://other@127.0.0.1:5432/album_haven_ci_tops_123_2'),
    ('DATABASE_MIGRATOR_URL','postgresql://album_haven_migrator_tops_123_2@localhost:5432/album_haven_ci_tops_123_2'),
    ('ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL','postgresql://other/db'),
    ('PGPASSWORD','forbidden-override'), ('RUNNER_TEMP','relative'), ('PGPASSFILE','/tmp/wrong.pgpass'),
])
def test_hosted_favorites_admission_rejects_wrong_environment(tmp_path,key,value):
    from tests.py.album_favorites_postgres_support import lane_context
    env=hosted_favorites_environment(tmp_path);env[key]=value
    with pytest.raises(AssertionError):
        lane_context(env)


@pytest.mark.parametrize('suffix',['?options=-crole=other','#fragment', '?password=secret'])
def test_hosted_favorites_admission_rejects_url_overrides(tmp_path,suffix):
    from tests.py.album_favorites_postgres_support import lane_context
    env=hosted_favorites_environment(tmp_path)
    env['DATABASE_APP_URL']+=suffix
    env['ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL']=env['DATABASE_APP_URL']
    with pytest.raises(AssertionError):
        lane_context(env)


@pytest.mark.parametrize('role',['app','setup'])
def test_hosted_favorites_exact_connected_identity_and_major(tmp_path,role):
    from tests.py.album_favorites_postgres_support import lane_context, assert_lane_connection
    context=lane_context(hosted_favorites_environment(tmp_path))
    row={'database_name':context['database'],'role_name':context[role+'_role']}
    assert_lane_connection(context,row,170001,role)
    for version in (140000,160000,180000):
        with pytest.raises(AssertionError):
            assert_lane_connection(context,row,version,role)
    for key in row:
        with pytest.raises(AssertionError):
            assert_lane_connection(context,{**row,key:'wrong'},170000,role)


def test_hosted_favorites_pgpass_metadata_only(tmp_path,monkeypatch):
    import os
    import stat
    import sys
    from pathlib import Path
    from types import SimpleNamespace
    from tests.py.album_favorites_postgres_support import lane_context, private_pgpass, validate_file_metadata
    # Synthetic facts exercise the POSIX contract portably, not filesystem evidence.
    good=dict(st_mode=stat.S_IFREG|0o600,st_uid=123,st_nlink=1,st_file_attributes=0)
    validate_file_metadata(SimpleNamespace(**good),symlink=False,linux_uid=123)
    for field,value in [('st_mode',stat.S_IFREG|0o644),('st_uid',124),('st_nlink',2),('st_file_attributes',0x400)]:
        with pytest.raises(AssertionError):
            validate_file_metadata(SimpleNamespace(**{**good,field:value}),symlink=False,linux_uid=123)
    with pytest.raises(AssertionError):
        validate_file_metadata(SimpleNamespace(**good),symlink=True,linux_uid=123)
    # Windows checks plain-file/reparse facts without claiming Unix UID/mode support.
    validate_file_metadata(SimpleNamespace(st_mode=stat.S_IFREG|0o666),symlink=False)
    if sys.platform == 'linux':
        context=lane_context(hosted_favorites_environment(tmp_path));path=context['pgpass']
        path.touch(mode=0o600);path.chmod(0o600)
        def forbidden(*args,**kwargs):
            raise AssertionError('Admission must never read pgpass content')
        monkeypatch.setattr(Path,'read_text',forbidden);monkeypatch.setattr(Path,'read_bytes',forbidden)
        private_pgpass(context)
        path.chmod(0o644)
        with pytest.raises(AssertionError):
            private_pgpass(context)
        path.chmod(0o600)
        with monkeypatch.context() as patch:
            patch.setattr(os,'getuid',lambda:path.stat().st_uid+1)
            with pytest.raises(AssertionError):
                private_pgpass(context)
        link=tmp_path/'symlink';link.symlink_to(path)
        with pytest.raises(AssertionError):
            private_pgpass({**context,'pgpass':link})


def windows_favorites_environment(tmp_path):
    env=hosted_favorites_environment(tmp_path)
    suffix='py_contract_123_2';database='album_haven_ci_'+suffix
    env.update(ALBUM_HAVEN_FAVORITES_TEST_MODE='favorites_windows17',RUNNER_OS='Windows',
        GITHUB_JOB='test_python',ALBUM_HAVEN_CI_DATABASE=database,
        DATABASE_MIGRATOR_URL='postgresql://album_haven_migrator_'+suffix+'@127.0.0.1/'+database,
        DATABASE_APP_URL='postgresql://album_haven_app_'+suffix+'@127.0.0.1/'+database,
        PGPASSFILE=str(tmp_path.resolve()/'album-haven-python-combined.pgpass'))
    env['ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL']=env['DATABASE_APP_URL']
    env.pop('FEATURE_BATCH')
    return env


@pytest.mark.parametrize('key,value', [('RUNNER_OS','Linux'),('GITHUB_JOB','test_e2e'),
    ('GITHUB_RUN_ID','0'),('GITHUB_RUN_ATTEMPT','0'),('ALBUM_HAVEN_CI_DATABASE','other'),
    ('DATABASE_APP_URL','postgresql://other@127.0.0.1/db'),('PGPASSFILE','wrong'),('PGPASSWORD','')])
def test_windows_favorites_admission_rejects_wrong_environment(tmp_path,key,value):
    from tests.py.album_favorites_postgres_support import lane_context
    env=windows_favorites_environment(tmp_path);env[key]=value
    with pytest.raises(AssertionError):
        lane_context(env)


def test_windows_favorites_exact_state_identity_and_port_spelling(tmp_path):
    from tests.py.album_favorites_postgres_support import (lane_context,expected_windows_state,
        validate_windows_state,assert_lane_connection)
    env=windows_favorites_environment(tmp_path);context=lane_context(env)
    expected=expected_windows_state(context);validate_windows_state(context,expected)
    for key in expected:
        with pytest.raises(AssertionError):
            validate_windows_state(context,{**expected,key:None})
    for role in expected['roles']:
        with pytest.raises(AssertionError):
            validate_windows_state(context,{**expected,'roles':{**expected['roles'],role:'wrong'}})
    for role in ('app','setup'):
        row={'database_name':context['database'],'role_name':context[role+'_role']}
        assert_lane_connection(context,row,170000,role)
        with pytest.raises(AssertionError):
            assert_lane_connection(context,row,140000,role)
        with pytest.raises(AssertionError):
            assert_lane_connection(context,{**row,'role_name':'wrong'},170000,role)
    for key in ('DATABASE_APP_URL','DATABASE_MIGRATOR_URL','ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL'):
        with pytest.raises(AssertionError):
            lane_context({**env,key:env[key].replace('@127.0.0.1/','@127.0.0.1:5432/')})


def test_windows_favorites_reads_only_provisioner_state(tmp_path,monkeypatch):
    import json
    from pathlib import Path
    from tests.py.album_favorites_postgres_support import lane_context,expected_windows_state,private_pgpass
    context=lane_context(windows_favorites_environment(tmp_path));state=expected_windows_state(context)
    context['pgpass'].touch();Path(state['pgpass']).touch()
    state_path=tmp_path/'album-haven-python-contract-postgres.state.json'
    state_path.write_text(json.dumps(state),encoding='utf-8')
    read_text=Path.read_text
    reads=[]
    def state_only(path,*args,**kwargs):
        assert path==state_path, 'No credential content reads'
        reads.append(path)
        return read_text(path,*args,**kwargs)
    monkeypatch.setattr(Path,'read_text',state_only)
    private_pgpass(context)
    assert reads==[state_path]
    state['roles']['readonly']='wrong'
    state_path.write_text(json.dumps(state),encoding='utf-8')
    with pytest.raises(AssertionError):
        private_pgpass(context)



def test_canonical_trigger_rows_and_no_synthetic_grant_survive_owned_cleanup(favorites_bootstrap_db,monkeypatch):
    db=favorites_bootstrap_db
    before_profile=dict(db.baseline_social_profile)
    before_policy=dict(db.baseline_friend_policy)
    with db.connect() as con:
        db.assert_social_baseline(con)
        assert con.execute('select membership_role from library.library_memberships where account_id=%s and library_id=%s',
            (db.baseline_account,db.library)).fetchone()['membership_role']=='owner'
    db.patch(db.albums[0],{'favorite':True},actor=db.bootstrap_owner)
    real_cleanup=db.cleanup
    def checked_cleanup():
        # The fixture finalizer invokes the real cleanup exactly once. Check the
        # committed result while its ownership lock is still retained.
        real_cleanup()
        with db.connect() as con:
            assert con.execute('select to_jsonb(p) as data from app.social_profiles p').fetchall()==[{'data':before_profile}]
            assert con.execute('select to_jsonb(p) as data from app.friend_policies p').fetchall()==[{'data':before_policy}]
            assert con.execute('select id from app.capabilities').fetchall()==[]
            rows=[r['data'] for r in con.execute('select to_jsonb(m) as data from library.library_memberships m').fetchall()]
            assert rows==db.baseline_memberships
    monkeypatch.setattr(db,'cleanup',checked_cleanup)



@pytest.mark.parametrize('nonfinite',['infinity','-infinity'])
def test_friend_policy_finite_guard_rejects_owned_nonfinite_timestamp(favorites_db,nonfinite):
    from tests.py.album_favorites_postgres_support import require_finite_friend_policy
    db=favorites_db
    # Only this fixture's newly owned library policy is perturbed; the canonical
    # bootstrap baseline is never changed. The invalid value is never committed.
    with db.connect() as con:
        before=con.execute('select to_jsonb(p) as data from app.friend_policies p where library_id=%s',
            (db.library,)).fetchone()['data']
        require_finite_friend_policy(con,db.library)
        try:
            con.execute('update app.friend_policies set updated_at=%s::timestamptz where library_id=%s',
                (nonfinite,db.library))
            with pytest.raises(AssertionError,match='timestamp must be finite'):
                require_finite_friend_policy(con,db.library)
        finally:
            con.rollback()
        require_finite_friend_policy(con,db.library)
        assert con.execute('select to_jsonb(p) as data from app.friend_policies p where library_id=%s',
            (db.library,)).fetchone()['data']==before
