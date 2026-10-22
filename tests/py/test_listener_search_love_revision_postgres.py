"""0139 trigger ownership and actual two-connection revision serialization."""
from contextlib import contextmanager
import psycopg
import pytest
from tests.py.listener_search_live_support import (
    database_urls,mutable_ledger,social_ledger,read,service,seed_preference,revision,
    Workers,observe_blocker,runtime_connect,
)


def test_epoch_column_trigger_and_security_definer_are_isolated(mutable_ledger):
    state = mutable_ledger
    with state['db'].connect() as con:
        column = con.execute("""select is_nullable,column_default,data_type from information_schema.columns
            where table_schema='app' and table_name='activity_source_revisions' and column_name='love_revision'""").fetchone()
        assert column['is_nullable']=='NO' and column['data_type']=='bigint'
        assert column['column_default'] in ('0','0::bigint')
        functions = con.execute("""select proname,prosecdef,proconfig,
            exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
                where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute,
            has_function_privilege('album_haven_app',p.oid,'EXECUTE') as app_execute
            from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='app' and proname=any(%s)""",
            (['bump_listener_search_love_revision','invalidate_listener_search_love'],)).fetchall()
        assert len(functions)==2
        for row in functions:
            assert row['prosecdef'] and row['proconfig']==['search_path=pg_catalog']
            assert row['public_execute'] is False and row['app_execute'] is False
        trigger = con.execute("""select pg_get_triggerdef(oid) as definition from pg_trigger
            where tgrelid='app.track_preferences'::regclass and tgname='listener_search_love_change'""").fetchone()
        assert 'AFTER INSERT OR DELETE OR UPDATE' in trigger['definition'] or 'AFTER INSERT OR UPDATE OR DELETE' in trigger['definition']
        assert 'FOR EACH ROW' in trigger['definition']


@pytest.mark.parametrize('sql', [
    'select app.bump_listener_search_love_revision(%s,%s)',
    'update app.activity_source_revisions set love_revision=love_revision+1 where library_id=%s and account_id=%s',
    'update app.activity_source_revisions set revision=revision+1 where library_id=%s and account_id=%s',
])
def test_runtime_cannot_execute_bump_or_update_either_counter(mutable_ledger,sql):
    state = mutable_ledger
    read(state)
    before = revision(state)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with runtime_connect(state['db'].app_url) as con:
            con.execute(sql,(state['data']['library'],state['actor'].account_id))
    assert revision(state)==before


@pytest.mark.parametrize('change',['love','key','track_id','delete','noop','rating'])
def test_epoch_tracks_only_persisted_love_identity_changes(mutable_ledger,change):
    state = mutable_ledger
    read(state)
    initial = revision(state)
    pref = seed_preference(state,state['data']['tracks'][0],love='off',rating=3)
    inserted = revision(state)
    assert inserted['love_revision']==initial['love_revision']+1
    assert inserted['revision']==initial['revision']
    with state['db'].connect() as con:
        if change=='delete':con.execute('delete from app.track_preferences where id=%s',(pref,))
        else:
            assignment = {'love':"love_tier='loved'",'key':"track_key=track_key || '-new'",
                'track_id':'track_id='+str(state['data']['tracks'][0]['id']),
                'noop':'love_tier=love_tier','rating':'rating=4'}[change]
            con.execute('update app.track_preferences set '+assignment+' where id=%s',(pref,))
    after = revision(state)
    assert after['revision']==inserted['revision']
    assert after['love_revision']==inserted['love_revision']+int(change not in {'noop','rating'})


def test_positive_scope_move_bumps_both_and_legacy_null_only_positive(social_ledger):
    state = social_ledger
    read(state)
    read(state,subject=state['peer'])
    track = state['data']['tracks'][0]
    pref = seed_preference(state,track)
    a,b = revision(state),revision(state,state['peer'])
    with state['db'].connect() as con:
        con.execute('update app.track_preferences set account_id=%s where id=%s',(state['peer'],pref))
    assert revision(state)['love_revision']==a['love_revision']+1
    assert revision(state,state['peer'])['love_revision']==b['love_revision']+1
    legacy = seed_preference(state,state['data']['tracks'][1],library=None)
    a = revision(state)
    with state['db'].connect() as con:
        con.execute('update app.track_preferences set library_id=%s where id=%s',(state['data']['library'],legacy))
    assert revision(state)['love_revision']==a['love_revision']+1
    with state['db'].connect() as con:
        con.execute('update app.track_preferences set library_id=null where id=%s',(legacy,))
    assert revision(state)['love_revision']==a['love_revision']+2


def test_reader_first_love_writer_waits_for_real_receipt_share_lock(mutable_ledger,monkeypatch):
    state = mutable_ledger
    pref = seed_preference(state,state['data']['tracks'][0])
    owner = type(service(state))
    original = owner._history_receipt
    with Workers() as work:
        reached,release,pause = work.barrier()
        pids = []
        @contextmanager
        def observed(self,con,*args,**kwargs):
            with original(self,con,*args,**kwargs) as receipt:
                pids.append(con.info.backend_pid)
                pause()
                yield receipt
        monkeypatch.setattr(owner,'_history_receipt',observed)
        reader = work.start(lambda:read(state,suffix=' :loved',connect=work.connections))
        assert reached.wait(8)
        writer_pid = []
        def write():
            with work.connections(state['db'].app_url) as con:
                writer_pid.append(con.info.backend_pid)
                con.execute("update app.track_preferences set love_tier='off' where id=%s",(pref,))
        writer = work.start(write)
        import time
        deadline=time.monotonic()+8
        while not writer_pid and time.monotonic()<deadline:time.sleep(.01)
        assert writer_pid
        observe_blocker(state['db'],writer_pid[0],pids[0])
        release.set()
        result=reader.result(timeout=8)
        writer.result(timeout=8)
    assert len(result['tracks'])==1
    assert all(c.closed for c in work.connections.items)
    monkeypatch.setattr(owner,'_history_receipt',original)
    assert read(state,suffix=' :loved')['tracks']==[]


def test_writer_first_read_observes_committed_epoch_and_love(mutable_ledger):
    from music_app.services.private_search_contract import PrivateSearchError
    from music_app.services.private_listener_search_cursor import decode_listener_search_token
    from tests.py.listener_search_live_support import SECRET
    state=mutable_ledger
    pref=seed_preference(state,state['data']['tracks'][0],love='off')
    # Capture before the writer so this request only validates the old receipt.
    first=read(state,limit=1)
    before=revision(state)
    with state['db'].connect() as con:
        snapshots=con.execute('select count(*) as n from app.activity_snapshots where account_id=%s',
            (state['actor'].account_id,)).fetchone()['n']
    with Workers() as work:
        with runtime_connect(state['db'].app_url) as writer:
            writer.execute("update app.track_preferences set love_tier='loved' where id=%s",(pref,))
            reader=work.start(lambda:read(state,limit=1,cursor=first['page']['next_cursor'],connect=work.connections))
            # Existing Home revision acquisition is FOR SHARE NOWAIT. A held
            # writer revision must produce unavailable/rollback, not a wait.
            with pytest.raises(PrivateSearchError) as caught:
                reader.result(timeout=8)
            assert caught.value.status_code==503
            assert caught.value.code=='private_search_unavailable'
            assert 'postgresql://' not in str(caught.value)
            assert 'track_preferences' not in str(caught.value)
            assert work.connections.items and all(con.closed for con in work.connections.items)
            with state['db'].connect() as con:
                assert con.execute('select count(*) as n from app.activity_snapshots where account_id=%s',
                    (state['actor'].account_id,)).fetchone()['n']==snapshots
        # Writer commits only after the failed reader has fully rolled back.
    after=revision(state)
    assert after['love_revision']==before['love_revision']+1
    assert after['revision']==before['revision']
    current=read(state,suffix=' :loved')
    assert [row['title'] for row in current['tracks']]==['Track 0000']
    token=decode_listener_search_token(current['native']['result_token'],secret=SECRET,purpose='result')
    assert token['scope']['love_revision']==after['love_revision']
    # Love-only changes do not invalidate an otherwise valid history receipt.
    assert read(state,limit=1,cursor=first['page']['next_cursor'])['status']=='ready'


def test_opposite_single_row_scope_moves_serialize_in_canonical_scope_order(social_ledger):
    state=social_ledger
    first=seed_preference(state,state['data']['tracks'][0])
    second=seed_preference(state,state['data']['tracks'][1],account=state['peer'])
    before_a,before_b=revision(state),revision(state,state['peer'])
    with Workers() as work:
        reached,release,pause=work.barrier()
        first_pid=[]
        def move_first():
            with work.connections(state['db'].app_url) as con:
                first_pid.append(con.info.backend_pid)
                con.execute('update app.track_preferences set account_id=%s where id=%s',(state['peer'],first))
                pause()
        one=work.start(move_first)
        assert reached.wait(8)
        second_pid=[]
        def move_second():
            with work.connections(state['db'].app_url) as con:
                second_pid.append(con.info.backend_pid)
                con.execute('update app.track_preferences set account_id=%s where id=%s',(state['actor'].account_id,second))
        two=work.start(move_second)
        import time
        deadline=time.monotonic()+8
        while not second_pid and time.monotonic()<deadline:time.sleep(.01)
        assert second_pid
        observe_blocker(state['db'],second_pid[0],first_pid[0])
        release.set()
        one.result(timeout=8);two.result(timeout=8)
    assert revision(state)['love_revision']==before_a['love_revision']+2
    assert revision(state,state['peer'])['love_revision']==before_b['love_revision']+2
