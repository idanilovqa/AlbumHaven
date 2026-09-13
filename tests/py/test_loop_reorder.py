"""Live scoped-order contracts. CI supplies its isolated contract database URL.

Local: provision with scripts/ci/bootstrap-windows-postgres.ps1 and export that
owned database's app URL as ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL.
Only uniquely created accounts/libraries are cleaned; no schema-wide cleanup.
"""
from __future__ import annotations
import os
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from urllib.parse import urlparse
import pytest
from music_app.services import saved_loops_postgres as module

@pytest.fixture
def scoped_store():
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
    url = os.environ.get('ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL', '').strip()
    if not url:
        pytest.skip('Live saved-loop contract requires the CI isolated Postgres contract URL.')
    parsed = urlparse(url)
    assert parsed.hostname in {'localhost', '127.0.0.1', '::1'}
    assert re.fullmatch(r'(?:album_haven_ci_|pytest_|album_haven_fake_e2e)[a-z0-9_]*', parsed.path.lstrip('/'))
    setup_url = os.environ.get('DATABASE_MIGRATOR_URL', '').strip()
    assert setup_url, 'CI provisioning must supply DATABASE_MIGRATOR_URL for uniquely owned fixture cleanup'
    assert urlparse(setup_url).hostname == parsed.hostname and urlparse(setup_url).path == parsed.path
    accounts, libraries = [], []
    def connect(): return psycopg.connect(setup_url, row_factory=dict_row)
    token = uuid.uuid4().hex
    def scope(connection, account=None):
        if account is None:
            username = f'loop-order-{token}-{len(accounts)}'
            account = connection.execute('insert into app.accounts(display_name,username_display,username_normalized,contact_email,contact_email_normalized) values(%s,%s,%s,%s,%s) returning id', (username,username,username,username+'@example.test',username+'@example.test')).fetchone()['id']
            accounts.append(account)
        library = connection.execute('insert into library.libraries(owner_account_id,name) values(%s,%s) returning id', (account, f'loop-order-{token}-{len(libraries)}')).fetchone()['id']
        libraries.append(library)
        track = connection.execute('insert into library.local_tracks(library_id,track_key,title,duration_seconds) values(%s,%s,%s,120) returning id', (library, f'track-{token}', 'Same display title')).fetchone()['id']
        return {'account_id': account, 'library_id': library, 'song_key': f'track:{track}', 'track_id': track}
    def seed(connection, scope, loop_id, position, *, unresolved=False):
        connection.execute('insert into app.saved_loops(account_id,library_id,track_id,loop_key,start_seconds,end_seconds,metadata) values(%s,%s,%s,%s,10,20,%s)', (scope['account_id'], scope['library_id'], None if unresolved else scope['track_id'], loop_id, Jsonb({'source_index':position,'source_payload':{'name':loop_id,'original_start_seconds':10}})))
    try:
        with connect() as connection:
            own = scope(connection)
            other_actor = scope(connection)
            other_library = scope(connection, own['account_id'])
            for target in [own, other_actor, other_library]:
                seed(connection, target, 'a', 0); seed(connection, target, 'b', 1)
            seed(connection, own, 'historic-unresolved', 2, unresolved=True)
        yield {'adapter':module.SavedLoopsPostgresAdapter({'ALBUM_HAVEN_APP_DATABASE_URL':url}), 'own':own,'other_actor':other_actor,'other_library':other_library,'connect':connect,'seed':seed}
    finally:
        with connect() as connection:
            for library in libraries: connection.execute('delete from library.libraries where id=%s', (library,))
            for account in accounts: connection.execute('delete from app.accounts where id=%s', (account,))

def scope_args(scope): return {key:scope[key] for key in ('account_id','library_id')}
def reorder(store, ids, revision=0, scope=None):
    target = scope or store['own']
    return store['adapter'].reorder_scoped_loops(**scope_args(target), song_key=target['song_key'], expected_revision=revision, ordered_ids=ids)

def test_order_persists_only_current_actor_library_song_and_keeps_row_ids(scoped_store):
    store = scoped_store
    with store['connect']() as connection:
        before = connection.execute('select id,loop_key,metadata from app.saved_loops where account_id=%s and library_id=%s order by id', tuple(scope_args(store['own']).values())).fetchall()
    result = reorder(store, ['b','a'])
    assert result['ordered_ids'] == ['b','a'] and result['order_revision'] == 1
    assert reorder(store, ['b','a'], 1)['order_revision'] == 1
    assert reorder(store, ['a','b'], scope=store['other_actor'])['order_revision'] == 0
    assert reorder(store, ['a','b'], scope=store['other_library'])['order_revision'] == 0
    with store['connect']() as connection:
        after = connection.execute('select id,loop_key,metadata from app.saved_loops where account_id=%s and library_id=%s order by id', tuple(scope_args(store['own']).values())).fetchall()
    assert [(row['id'],row['loop_key']) for row in after] == [(row['id'],row['loop_key']) for row in before]
    assert [row['metadata']['source_payload'] for row in after] == [row['metadata']['source_payload'] for row in before]

@pytest.mark.parametrize('ids', [['a'],['a','a'],['a','foreign'],['a','b','extra'],[],['a',None]])
def test_invalid_membership_never_silently_appends_drops_or_writes(scoped_store, ids):
    with pytest.raises(module.LoopOrderError) as caught: reorder(scoped_store, ids)
    assert caught.value.status_code in {400,404}
    assert reorder(scoped_store, ['a','b'])['order_revision'] == 0

@pytest.mark.parametrize('revision', [-1,True,1.5,'0',None])
def test_revision_requires_nonnegative_integer(scoped_store, revision):
    with pytest.raises(module.LoopOrderError) as caught: reorder(scoped_store, ['b','a'], revision)
    assert caught.value.status_code == 400
    assert reorder(scoped_store, ['a','b'])['order_revision'] == 0

def test_stale_order_returns_only_current_scoped_snapshot(scoped_store):
    reorder(scoped_store, ['b','a'])
    with pytest.raises(module.LoopOrderError) as caught: reorder(scoped_store, ['a','b'])
    assert caught.value.status_code == 409
    assert caught.value.payload['ordered_ids'] == ['b','a']
    assert caught.value.payload['order_revision'] == 1
    assert caught.value.payload['song_key'] == scoped_store['own']['song_key']

def test_foreign_song_is_not_visible_even_if_loop_keys_match(scoped_store):
    target = {**scoped_store['own'], 'song_key':scoped_store['other_actor']['song_key']}
    with pytest.raises(module.LoopOrderError) as caught: reorder(scoped_store, ['b','a'], scope=target)
    assert caught.value.status_code == 404

def test_two_concurrent_reorders_with_same_token_have_one_commit(scoped_store):
    barrier = Barrier(2)
    def attempt():
        barrier.wait(timeout=5)
        try: return ('ok', reorder(scoped_store, ['b','a']))
        except module.LoopOrderError as error: return ('error', error.status_code)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _:attempt(), range(2)))
    assert sorted(item[0] for item in results) == ['error','ok']
    assert next(value for kind,value in results if kind == 'error') == 409

def test_unresolved_historical_rows_remain_owned_visible_and_not_reorderable(scoped_store):
    adapter = scoped_store['adapter']; args = scope_args(scoped_store['own'])
    rows = adapter.load_scoped_loops(**args)
    historical = next(row for row in rows if row['id']=='historic-unresolved')
    assert historical['song_identity_status']=='unresolved'
    assert historical['song_key'] is None and historical['order_revision'] is None
    assert historical['can_reorder'] is False
    assert adapter.get_scoped_loop(**args, loop_id='historic-unresolved')['id']=='historic-unresolved'
    with pytest.raises(module.LoopOrderError): reorder(scoped_store, ['b','a','historic-unresolved'])

def test_delete_advances_same_song_revision_and_preserves_tombstone(scoped_store):
    store=scoped_store; args=scope_args(store['own'])
    reorder(store,['a','b'])
    store['adapter'].delete_scoped_loop(**args,loop_id='a')
    with pytest.raises(module.LoopOrderError) as caught: reorder(store,['b'])
    assert caught.value.status_code==409 and caught.value.payload['order_revision']==1
    assert caught.value.payload['ordered_ids']==['b']
    assert store['adapter'].get_scoped_loop(**args,loop_id='a') is None
    with store['connect']() as connection:
        row=connection.execute('select metadata from app.saved_loops where account_id=%s and library_id=%s and loop_key=%s', (*args.values(),'a')).fetchone()
    assert row and row['metadata']['source_payload']['original_start_seconds']==10

def test_unresolved_delete_does_not_change_resolved_song_revision(scoped_store):
    store=scoped_store
    store['adapter'].delete_scoped_loop(**scope_args(store['own']),loop_id='historic-unresolved')
    assert reorder(store,['a','b'])['order_revision']==0

def test_nested_creation_uses_parent_song_and_invalidates_old_order(scoped_store):
    store=scoped_store; args=scope_args(store['own'])
    reorder(store,['a','b'])
    store['adapter'].add_scoped_loop(**args,item={'id':'new-child','parent_loop_id':'a','song_key':store['other_actor']['song_key'],'start_seconds':1,'end_seconds':3,'name':'Child','path':'owned-output'})
    with pytest.raises(module.LoopOrderError) as caught: reorder(store,['new-child','a','b'])
    assert caught.value.status_code==409 and caught.value.payload['order_revision']==1
    assert caught.value.payload['ordered_ids']==['new-child','a','b']
    assert store['adapter'].get_scoped_loop(**args,loop_id='new-child')['song_key']==store['own']['song_key']
@pytest.mark.parametrize('operation', ['create','delete'])
def test_membership_writers_wait_for_the_same_song_order_lock(scoped_store, operation):
    from concurrent.futures import TimeoutError
    from threading import Event
    store=scoped_store; args=scope_args(store['own'])
    reorder(store,['a','b'])
    entered=Event()
    def mutate():
        entered.set()
        if operation=='delete': return store['adapter'].delete_scoped_loop(**args,loop_id='a')
        return store['adapter'].add_scoped_loop(**args,item={'id':'new-child','parent_loop_id':'a','start_seconds':1,'end_seconds':3,'name':'Child','path':'owned-output'})
    with ThreadPoolExecutor(max_workers=1) as pool:
        with store['connect']() as lock:
            lock.execute('select revision from app.saved_loop_orders where account_id=%s and library_id=%s and track_id=%s for update', (*args.values(),store['own']['track_id']))
            future=pool.submit(mutate)
            assert entered.wait(timeout=2)
            with pytest.raises(TimeoutError): future.result(timeout=0.15)
        future.result(timeout=5)
    ids=['b'] if operation=='delete' else ['new-child','a','b']
    assert reorder(store,ids,1)['order_revision']==1
@pytest.mark.parametrize('foreign', [False,True])
def test_direct_creation_derives_song_only_from_exact_current_library_file(scoped_store,tmp_path,foreign):
    store=scoped_store; args=scope_args(store['own'])
    source=tmp_path/'source.flac'; source.write_bytes(b'fixture')
    target=store['other_actor'] if foreign else store['own']
    with store['connect']() as connection:
        connection.execute('insert into library.local_track_files(track_id,private_path) values(%s,%s)',(target['track_id'],str(source.resolve())))
    item={'id':'direct-child','source_path':str(source.resolve()),'song_key':store['other_actor']['song_key'],'start_seconds':1,'end_seconds':3,'name':'Direct','path':'owned-output','artist':'Same display title','title':'Same display title'}
    if foreign:
        with pytest.raises(module.LoopOrderError) as caught: store['adapter'].add_scoped_loop(**args,item=item)
        assert caught.value.status_code==404
    else:
        store['adapter'].add_scoped_loop(**args,item=item)
        assert store['adapter'].get_scoped_loop(**args,loop_id='direct-child')['song_key']==store['own']['song_key']
def test_invalid_cross_library_track_relation_is_preserved_as_unresolved(scoped_store):
    store=scoped_store; args=scope_args(store['own'])
    with store['connect']() as connection:
        connection.execute('update app.saved_loops set track_id=%s where account_id=%s and library_id=%s and loop_key=%s',(store['other_actor']['track_id'],*args.values(),'a'))
    row=store['adapter'].get_scoped_loop(**args,loop_id='a')
    assert row['song_identity_status']=='unresolved' and row['song_key'] is None
    assert row['can_reorder'] is False
    with store['connect']() as connection:
        original=connection.execute('select track_id from app.saved_loops where account_id=%s and library_id=%s and loop_key=%s',(*args.values(),'a')).fetchone()
    assert original['track_id']==store['other_actor']['track_id'], 'read must not reassign historical evidence'
def test_direct_creation_rejects_window_beyond_authoritative_track_duration(scoped_store,tmp_path):
    store=scoped_store; args=scope_args(store['own'])
    source=tmp_path/'source.flac'; source.write_bytes(b'fixture')
    with store['connect']() as connection:
        connection.execute('insert into library.local_track_files(track_id,private_path) values(%s,%s)',(store['own']['track_id'],str(source.resolve())))
    with pytest.raises(module.LoopOrderError) as caught:
        store['adapter'].add_scoped_loop(**args,item={'id':'oversized','source_path':str(source.resolve()),'start_seconds':0,'end_seconds':121,'duration_seconds':9999,'name':'Invalid range','path':'owned-output'})
    assert caught.value.status_code==400
    assert store['adapter'].get_scoped_loop(**args,loop_id='oversized') is None

def test_direct_subsecond_source_uses_truncated_zero_duration_interval(scoped_store,tmp_path):
    store=scoped_store;args=scope_args(store['own'])
    source=tmp_path/'short.flac';source.write_bytes(b'fixture')
    with store['connect']() as connection:
        connection.execute('update library.local_tracks set duration_seconds=0 where id=%s',(store['own']['track_id'],))
        connection.execute('insert into library.local_track_files(track_id,private_path) values(%s,%s)',(store['own']['track_id'],str(source.resolve())))
    item={'id':'short','source_path':str(source.resolve()),'start_seconds':0,'end_seconds':.5,'name':'Short','path':'owned-output'}
    created=store['adapter'].add_scoped_loop(**args,item=item)
    assert created['end_seconds']==.5
    with pytest.raises(module.LoopOrderError) as caught:
        store['adapter'].add_scoped_loop(**args,item={**item,'id':'too-long','end_seconds':1})
    assert caught.value.status_code==400
