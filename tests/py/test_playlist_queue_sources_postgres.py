"""Queue authority survives form loading, duplicates, and mutation retries."""
from dataclasses import replace
from uuid import uuid4
import pytest
from music_app.services.owned_playlists import CREATE, PlaylistError, normalize_playlist_command
from music_app.services import playlist_queue_sources as queue
from tests.py.test_owned_playlist_postgres_integration import db, urls
from tests.py.test_playlist_extended_sources_postgres import activity_playlist, create_command
from tests.py.test_friend_home_activity import social_ledger, friend_read
from tests.py.test_home_activity_postgres_integration import database_urls, mutable_ledger


def inventory(db,index=0):
    return {'kind':'inventory','track_ref':f'inventory-track:{db.library}:{db.tracks[index]}'}


def playlist_occurrence(db,receipt,index=0):
    detail=db.service.read(db.context(),playlist_ref=receipt['playlist_id'])['playlist_detail']
    item=detail['track_rows'][index]
    return {'kind':'playlist','track_ref':f'inventory-track:{db.library}:{db.tracks[index]}',
        'playlist_ref':receipt['playlist_id'],'revision':receipt['revision'],'item_ref':item['playlist_item_id']}


def add_command(data,destination):
    return normalize_playlist_command('add',{'request_key':str(uuid4()),'revision':destination['revision'],
        'track_refs':[row['inventory_track_ref'] for row in data['entries']],
        'source_guard':{key:data[key] for key in ('source_protocol','source')} |
            {'entry_refs':[row['entry_ref'] for row in data['entries']]}},playlist_ref=destination['playlist_id'])


def test_inventory_queue_deduplicates_and_keeps_order_and_exact_retry(db):
    data=queue.capture(db.service,db.context(),[inventory(db,2),inventory(db),inventory(db,2)])['data']
    assert [row['inventory_track_ref'] for row in data['entries']]==[inventory(db,2)['track_ref'],inventory(db)['track_ref']]
    command=create_command(data)
    receipt=db.service.execute(db.context(),command)
    with db.connect() as con:
        con.execute("update app.playlist_creation_sources set expires_at=now()-interval '1 second' where ref=%s",(data['source']['ref'],))
    assert db.service.execute(db.context(),command)==receipt
    with pytest.raises(PlaylistError,match='source_expired'):db.service.execute(db.context(),create_command(data))


@pytest.mark.parametrize('action',['create','add'])
def test_playlist_origin_change_blocks_duplicate_inventory_representative(db,action):
    origin,_=db.create()
    destination,_=db.create(refs=[])
    occurrence=playlist_occurrence(db,origin)
    data=queue.capture(db.service,db.context(),[inventory(db),occurrence])['data']
    assert len(data['entries'])==1
    db.service.execute(db.context(),normalize_playlist_command('save',
        {'title':'Changed source','revision':origin['revision'],'request_key':str(uuid4())},playlist_ref=origin['playlist_id']))
    command=create_command(data) if action=='create' else add_command(data,destination)
    with pytest.raises(PlaylistError,match='source_changed'):db.service.execute(db.context(),command)
    assert db.count('playlists')==2


@pytest.mark.parametrize('action',['create','add'])
def test_friend_revocation_blocks_duplicate_inventory_queue_occurrence(activity_playlist,action):
    state,service,ctx=activity_playlist
    result=friend_read(state,kind='tracks')['data']
    row=result['rows'][0]
    origin={'audience':'friend','subject_ref':state['peer_ref'],'kind':'tracks','period':'all','snapshot_ref':result['snapshot_ref']}
    from music_app.services.playlist_complete_sources import CompletePlaylistSources
    old=CompletePlaylistSources(playlists=service).from_activity(ctx,origin,[row['id']])['data']
    track_ref=old['entries'][0]['inventory_track_ref']
    destination=service.execute(ctx,normalize_playlist_command('create',{'mode':'ordinary','source_protocol':old['source_protocol'],
        'source':old['source'],'title':'Destination','entry_refs':[],'request_key':str(uuid4())}))
    data=queue.capture(service,ctx,[{'kind':'inventory','track_ref':track_ref},
        {'kind':'activity','track_ref':track_ref,'origin':origin,'row_ref':row['id']}])['data']
    with state['db'].connect() as con:
        con.execute("update app.friend_connections set state='removed',revision=revision+1 where library_id=%s and low_account_id=%s and high_account_id=%s",state['pair'])
    with pytest.raises(PlaylistError,match='source_unavailable'):
        service.execute(ctx,create_command(data) if action=='create' else add_command(data,destination))


def test_guard_rejects_identity_substitution_and_other_actor(db):
    data=queue.capture(db.service,db.context(),[inventory(db)])['data']
    destination,_=db.create(refs=[])
    command=add_command(data,destination)
    command.data['track_refs']=[inventory(db,1)['track_ref']]
    with pytest.raises(PlaylistError,match='source_changed'):db.service.execute(db.context(),command)
    with db.connect() as con:other=db.member(con,db.actor(con))
    with pytest.raises(PlaylistError,match='source_unavailable'):db.service.execute(db.context(other),create_command(data))


def test_queue_capture_and_add_do_not_require_create(db):
    destination,_=db.create(refs=[])
    with db.connect() as con:
        con.execute('update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s',(db.owner.account_id,CREATE))
    ctx=db.context(replace(db.owner,capability_grants=tuple(g for g in db.owner.capability_grants if g.capability_key!=CREATE)))
    data=queue.capture(db.service,ctx,[inventory(db)])['data']
    assert db.service.execute(ctx,add_command(data,destination))['added_count']==1
    with pytest.raises(PlaylistError,match='forbidden'):db.service.execute(ctx,create_command(data))


def test_queue_read_revalidates_retained_playlist_authority(db):
    from music_app.services.playlist_complete_sources import CompletePlaylistSources
    origin,_=db.create()
    data=queue.capture(db.service,db.context(),[playlist_occurrence(db,origin)])['data']
    complete=CompletePlaylistSources(playlists=db.service)
    assert complete.read(db.context(),ref=data['source']['ref'],revision=data['source']['revision'])['data']['entries']==data['entries']
    db.service.execute(db.context(),normalize_playlist_command('delete',
        {'revision':origin['revision'],'request_key':str(uuid4())},playlist_ref=origin['playlist_id']))
    with pytest.raises(PlaylistError,match='playlist_unavailable'):
        complete.read(db.context(),ref=data['source']['ref'],revision=data['source']['revision'])


def test_guard_does_not_accept_an_ordinary_inventory_capture(db):
    from music_app.services.playlist_complete_sources import CompletePlaylistSources
    data=CompletePlaylistSources(playlists=db.service).from_inventory(db.context(),[inventory(db)['track_ref']])['data']
    destination,_=db.create(refs=[])
    with pytest.raises(PlaylistError,match='source_changed'):db.service.execute(db.context(),add_command(data,destination))


def test_playlist_occurrence_identity_mismatch_never_captures(db):
    origin,_=db.create()
    occurrence={**playlist_occurrence(db,origin),'track_ref':inventory(db,1)['track_ref']}
    with pytest.raises(PlaylistError,match='source_changed'):queue.capture(db.service,db.context(),[occurrence])


def test_add_retry_is_exact_after_expiry_and_guard_change_conflicts(db):
    data=queue.capture(db.service,db.context(),[inventory(db)])['data']
    destination,_=db.create(refs=[])
    command=add_command(data,destination)
    receipt=db.service.execute(db.context(),command)
    with db.connect() as con:
        con.execute("update app.playlist_creation_sources set expires_at=now()-interval '1 second' where ref=%s",(data['source']['ref'],))
    assert db.service.execute(db.context(),command)==receipt
    command.data['source_guard']['entry_refs']=[str(uuid4())]
    with pytest.raises(PlaylistError,match='idempotency_key_reused'):db.service.execute(db.context(),command)


@pytest.mark.parametrize('change',['expired','session','account'])
def test_uncommitted_queue_cannot_outlive_current_authority(db,change):
    data=queue.capture(db.service,db.context(),[inventory(db)])['data']
    with db.connect() as con:
        if change=='expired':
            con.execute("update app.playlist_creation_sources set expires_at=now()-interval '1 second' where ref=%s",(data['source']['ref'],))
        elif change=='session':
            con.execute('update app.account_sessions set revoked_at=now() where id=%s',(db.owner.session_id,))
        else:con.execute('update app.accounts set is_active=false,disabled_at=now() where id=%s',(db.owner.account_id,))
    with pytest.raises(PlaylistError,match='source_expired' if change=='expired' else 'forbidden'):
        db.service.execute(db.context(),create_command(data))
    assert db.count('playlists')==0


def test_readable_missing_queue_can_create_and_add_without_media_rights(db,tmp_path):
    from psycopg.types.json import Jsonb
    from datetime import datetime,timezone
    root=tmp_path/'readable';root.mkdir()
    with db.connect() as con:
        con.execute('update library.library_roots set root_path=%s,metadata=%s where library_id=%s',
            (str(root),Jsonb({'root_id':'queue-missing'}),db.library))
        con.execute('update library.local_track_files set private_path=%s,metadata=%s where track_id=%s',
            (str(root/'missing.flac'),Jsonb({'scan_cache':{'stale':True,'stale_marked_at':datetime.now(timezone.utc).isoformat()}}),db.tracks[0]))
    destination,_=db.create(refs=[])
    data=queue.capture(db.service,db.context(),[inventory(db)])['data']
    assert data['entries'][0]['availability']=='missing'
    assert db.service.execute(db.context(),create_command(data))['added_count']==1
    assert db.service.execute(db.context(),add_command(data,destination))['added_count']==1


def test_playlist_revoke_wins_before_waiting_queue_write(db):
    from contextlib import contextmanager
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    import psycopg
    from psycopg.rows import dict_row
    from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
    origin,_=db.create()
    data=queue.capture(db.service,db.context(),[playlist_occurrence(db,origin)])['data']
    reached=Event()
    class Connection:
        def __init__(self,real):self.real=real
        def execute(self,sql,params=None):
            if 'order by ref for update' in sql:reached.set()
            return self.real.execute(sql,params)
    @contextmanager
    def connect(url):
        with psycopg.connect(url,row_factory=dict_row) as real:yield Connection(real)
    service=PostgresOwnedPlaylistsService({'ALBUM_HAVEN_APP_DATABASE_URL':db.app_url},connect=connect)
    with db.connect() as blocker:
        blocker.execute('select ref from app.playlists where ref=%s for update',(origin['playlist_id'],))
        with ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(service.execute,db.context(),create_command(data))
            try:
                assert reached.wait(timeout=5)
                blocker.execute('update app.playlists set deleted_at=now(),revision=revision+1 where ref=%s',(origin['playlist_id'],))
                blocker.commit()
                with pytest.raises(PlaylistError,match='playlist_unavailable'):future.result(timeout=10)
            finally:blocker.rollback()
    assert db.count('playlists')==1


def test_selected_queue_holds_source_playlist_until_create_commits(db,monkeypatch):
    import psycopg
    origin,_=db.create()
    data=queue.capture(db.service,db.context(),[playlist_occurrence(db,origin)])['data']
    original=db.service._insert_items
    observed=[]
    def insert(connection,context,playlist_ref,rows,**kwargs):
        with db.connect() as revoke:
            with pytest.raises(psycopg.errors.LockNotAvailable):
                revoke.execute('select ref from app.playlists where ref=%s for update nowait',(origin['playlist_id'],))
        observed.append(True)
        return original(connection,context,playlist_ref,rows,**kwargs)
    monkeypatch.setattr(db.service,'_insert_items',insert)
    assert db.service.execute(db.context(),create_command(data))['added_count']==1
    assert observed==[True]


def test_duplicate_track_from_two_friends_retains_both_subjects(activity_playlist):
    from datetime import timedelta
    from tests.py.test_home_activity_postgres_integration import NOW
    from music_app.services.playlist_complete_sources import CompletePlaylistSources
    state,service,ctx=activity_playlist
    with state['db'].connect() as con:
        peer=state['db'].account(con)
        state['db'].membership(con,peer,state['data']['library'])
        con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,'capability.social','library',%s)",
            (peer,ctx.library_id))
        low,high=sorted((ctx.actor.account_id,peer))
        con.execute("""insert into app.friend_connections(library_id,low_account_id,high_account_id,requester_account_id,state,origin)
            values(%s,%s,%s,%s,'accepted','request')""",(ctx.library_id,low,high,ctx.actor.account_id))
        ref=str(con.execute('select account_ref from app.social_profiles where account_id=%s',(peer,)).fetchone()['account_ref'])
        state['db'].event(con,state['data'],owner=peer,track=state['data']['tracks'][0],played_at=NOW-timedelta(minutes=5))
    second={**state,'peer':peer,'peer_ref':ref}
    occurrences=[]
    for subject in (state,second):
        activity=friend_read(subject,kind='tracks')['data']
        origin={'audience':'friend','subject_ref':subject['peer_ref'],'kind':'tracks','period':'all','snapshot_ref':activity['snapshot_ref']}
        data=CompletePlaylistSources(playlists=service).from_activity(ctx,origin,[row['id'] for row in activity['rows']])['data']
        expected=f"inventory-track:{ctx.library_id}:{state['data']['tracks'][0]['id']}"
        row=next(row for row in data['entries'] if row['inventory_track_ref']==expected)
        occurrences.append({'kind':'activity','track_ref':expected,'origin':origin,'row_ref':row['source_row_ref']})
    data=queue.capture(service,ctx,occurrences)['data']
    assert len(data['entries'])==1
    with state['db'].connect() as con:
        line=con.execute('select source_lineage from app.playlist_creation_entries where ref=%s',(data['entries'][0]['entry_ref'],)).fetchone()['source_lineage']
        assert len(line['occurrences'])==2
        con.execute("update app.friend_connections set state='removed',revision=revision+1 where library_id=%s and low_account_id=%s and high_account_id=%s",(ctx.library_id,low,high))
    with pytest.raises(PlaylistError,match='source_unavailable'):service.execute(ctx,create_command(data))


def test_new_session_cannot_adopt_queue_receipt(db):
    import hashlib
    data=queue.capture(db.service,db.context(),[inventory(db)])['data']
    with db.connect() as con:
        session=con.execute('''insert into app.account_sessions(account_id,session_token_hash,created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,now(),now(),now(),now()+interval '1 hour',now()+interval '1 day') returning id''',
            (db.owner.account_id,hashlib.sha256(uuid4().bytes).digest())).fetchone()['id']
    with pytest.raises(PlaylistError,match='source_unavailable'):
        db.service.execute(db.context(replace(db.owner,session_id=session)),create_command(data))


@pytest.mark.parametrize('origin_kind',['inventory','playlist'])
def test_empty_queue_create_still_revalidates_retained_source(db,origin_kind):
    if origin_kind=='playlist':
        origin,_=db.create()
        occurrence=playlist_occurrence(db,origin)
    else:occurrence=inventory(db)
    data=queue.capture(db.service,db.context(),[inventory(db,1),occurrence])['data']
    command=create_command(data)
    command.data['entry_refs']=[]
    with db.connect() as con:
        if origin_kind=='playlist':
            con.execute('update app.playlists set deleted_at=now(),revision=revision+1 where ref=%s',(origin['playlist_id'],))
        else:con.execute("update library.local_tracks set title='Changed' where id=%s",(db.tracks[0],))
    with pytest.raises(PlaylistError,match='playlist_unavailable' if origin_kind=='playlist' else 'source_changed'):
        db.service.execute(db.context(),command)


def test_empty_queue_create_is_empty_after_successful_all_source_validation(db):
    origin,_=db.create()
    data=queue.capture(db.service,db.context(),[inventory(db,1),playlist_occurrence(db,origin)])['data']
    command=create_command(data);command.data['entry_refs']=[]
    receipt=db.service.execute(db.context(),command)
    assert receipt['added_count']==0
    assert db.service.read(db.context(),playlist_ref=receipt['playlist_id'])['playlist_detail']['track_rows']==[]


@pytest.mark.parametrize('action',['create','add'])
def test_source_expiry_after_inventory_wait_rejects_both_writes(db,action):
    from contextlib import contextmanager
    from datetime import timedelta
    import psycopg
    from psycopg.rows import dict_row
    from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
    data=queue.capture(db.service,db.context(),[inventory(db)])['data']
    destination,_=db.create(refs=[])
    clock=[db.now]
    class Connection:
        def __init__(self,real):self.real=real
        def execute(self,sql,params=None):
            result=self.real.execute(sql,params)
            if 'from library.local_tracks' in sql and 'for update' in sql:clock[0]=db.now+timedelta(minutes=31)
            return result
    @contextmanager
    def connect(url):
        with psycopg.connect(url,row_factory=dict_row) as real:yield Connection(real)
    service=PostgresOwnedPlaylistsService({'ALBUM_HAVEN_APP_DATABASE_URL':db.app_url},connect=connect,clock=lambda:clock[0])
    with pytest.raises(PlaylistError,match='source_expired'):
        service.execute(db.context(),create_command(data) if action=='create' else add_command(data,destination))
    assert db.count('playlists')==1 and db.count('playlist_operations')==1


def test_queue_validation_proofs_do_not_become_saved_musical_lineage(db):
    data=queue.capture(db.service,db.context(),[inventory(db)])['data']
    receipt=db.service.execute(db.context(),create_command(data))
    with db.connect() as con:
        saved=con.execute('select source_lineage,source_entry_ref from app.playlist_items where playlist_ref=%s',(receipt['playlist_id'],)).fetchone()
        retained=con.execute('select source_lineage from app.playlist_creation_entries where ref=%s',(data['entries'][0]['entry_ref'],)).fetchone()['source_lineage']
    assert retained['occurrences']==[inventory(db)]
    assert saved['source_lineage'] is None
    assert str(saved['source_entry_ref'])==data['entries'][0]['entry_ref']


def test_unrelated_library_subject_cannot_become_a_queue_account_lock_target(db):
    from music_app.services.auth_tokens import issue_opaque_token
    with db.connect() as con:
        outsider=db.actor(con)
        foreign=con.execute('insert into library.libraries(owner_account_id,name) values(%s,%s) returning id',
            (outsider.account_id,'Unrelated '+uuid4().hex)).fetchone()['id']
        con.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'owner')",
            (outsider.account_id,foreign))
        subject=str(con.execute('select account_ref from app.social_profiles where account_id=%s',(outsider.account_id,)).fetchone()['account_ref'])
    occurrence={'kind':'activity','track_ref':inventory(db)['track_ref'],'row_ref':'activity_'+'a'*64,
        'origin':{'audience':'friend','subject_ref':subject,'kind':'tracks','period':'all','snapshot_ref':issue_opaque_token().raw}}
    try:
        assert queue.lock_targets(db.service,db.context(),occurrences=[occurrence])==()
        with pytest.raises(PlaylistError,match='source_unavailable'):
            queue.capture(db.service,db.context(),[occurrence])
    finally:
        with db.connect() as con:con.execute('delete from library.libraries where id=%s',(foreign,))
