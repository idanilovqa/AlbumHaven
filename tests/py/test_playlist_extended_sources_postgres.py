"""Real source receipt/authority/absence tests with uniquely owned SQL and roots."""
from dataclasses import replace
from datetime import datetime, timezone
import json
from uuid import uuid4

import pytest

from music_app.services.current_actor import CapabilityGrant
from music_app.services.owned_playlists import CREATE, MANAGE, ITEMS, PlaylistError, normalize_playlist_command
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services.playlist_complete_sources import CompletePlaylistSources
from music_app.services import playlist_missing_sources as missing
from music_app.services.policy import PolicyContext, RequestOrigin
from tests.py.test_owned_playlist_postgres_integration import db, urls
from tests.py.test_friend_home_activity import social_ledger, friend_read
from tests.py.test_home_activity_postgres_integration import database_urls, mutable_ledger


@pytest.fixture
def activity_playlist(social_ledger):
    state=social_ledger
    with state['db'].connect() as con:
        for action in (CREATE,MANAGE,ITEMS):
            con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)",
                (state['actor'].account_id,action,state['data']['library']))
    state={**state,'actor':replace(state['actor'],capability_grants=(*state['actor'].capability_grants,
        *(CapabilityGrant(action,'library',state['data']['library']) for action in (CREATE,MANAGE,ITEMS))))}
    service=PostgresOwnedPlaylistsService(state['db'].config)
    ctx=PolicyContext.build(actor=state['actor'],action=CREATE,library_id=state['data']['library'],
        deployment_mode='self_hosted',request_origin=RequestOrigin('network','synthetic:source'),client_surface_class='private_web')
    try:
        yield state,service,ctx
    finally:
        with state['db'].connect() as con:
            con.execute("delete from app.playlist_operations where library_id=%s",(state['data']['library'],))
            con.execute("delete from app.playlists where library_id=%s",(state['data']['library'],))


def create_command(data):
    return normalize_playlist_command('create',{'mode':data['mode'],'source_protocol':data['source_protocol'],
        'source':data['source'],'title':'Saved originals','description':'','request_key':str(uuid4()),
        'entry_refs':[row['entry_ref'] for row in data['entries']]})


def capture_activity(state,service,ctx):
    activity=friend_read(state,kind='tracks')['data']
    origin={'audience':'friend','subject_ref':state['peer_ref'],'kind':'tracks','period':'all','snapshot_ref':activity['snapshot_ref']}
    complete=CompletePlaylistSources(playlists=service)
    result=complete.from_activity(ctx,origin,[row['id'] for row in reversed(activity['rows'])])['data']
    return complete,result


def test_friend_activity_selection_saves_originals_without_private_listen_facts(activity_playlist):
    state,service,ctx=activity_playlist
    complete,data=capture_activity(state,service,ctx)
    assert data['source_protocol']=='complete_activity_selection_v1' and data['entries_complete'] is True
    assert all(not any(key in row for key in ('listen_count','rating','love_tier','path','source_lineage')) for row in data['entries'])
    fresh=complete.read(ctx,ref=data['source']['ref'],revision=data['source']['revision'],protocol=data['source_protocol'])['data']
    assert fresh['entries']==data['entries']
    receipt=service.execute(ctx,create_command(data))
    detail=service.read(ctx,playlist_ref=receipt['playlist_id'])['playlist_detail']
    assert [row['title'] for row in detail['track_rows']]==[row['title'] for row in data['entries']]
    assert all(row['source_kind']=='activity' for row in detail['track_rows'])
    assert 'synthetic-private' not in json.dumps(detail)


def test_friend_source_revocation_blocks_save_without_partial_playlist(activity_playlist):
    state,service,ctx=activity_playlist
    _,data=capture_activity(state,service,ctx)
    with state['db'].connect() as con:
        con.execute("update app.friend_connections set state='removed',revision=revision+1 where library_id=%s and low_account_id=%s and high_account_id=%s",state['pair'])
    with pytest.raises(PlaylistError,match='source_unavailable'):
        service.execute(ctx,create_command(data))
    with state['db'].connect() as con:
        assert con.execute('select count(*) as n from app.playlists where library_id=%s',(ctx.library_id,)).fetchone()['n']==0


def test_distinct_unresolved_history_occurrences_survive_without_label_matching(activity_playlist):
    state,service,ctx=activity_playlist
    with state['db'].connect() as con:
        con.execute("update integration.listen_history set track_id=null,track_key='unknown:'||id::text where id=any(%s)",(state['peer_events'],))
    _,data=capture_activity(state,service,ctx)
    assert len(data['entries'])==2
    assert all(row['inventory_track_ref'] is None and row['availability']=='unresolved' for row in data['entries'])
    receipt=service.execute(ctx,create_command(data))
    with state['db'].connect() as con:
        rows=con.execute('select original_local_track_id,local_track_id,source_lineage from app.playlist_items where playlist_ref=%s',(receipt['playlist_id'],)).fetchall()
    assert len(rows)==2 and all(row['local_track_id'] is None and row['original_local_track_id'] is None for row in rows)
    assert len({row['source_lineage']['row_key'] for row in rows})==2


@pytest.fixture
def missing_playlist(db,tmp_path):
    from psycopg.types.json import Jsonb
    root=tmp_path/'owned-library';root.mkdir()
    with db.connect() as con:
        con.execute('update library.library_roots set root_path=%s,metadata=%s where library_id=%s',
            (str(root),Jsonb({'root_id':'owned-missing-root'}),db.library))
        for index,track in enumerate(db.tracks):
            con.execute('update library.local_track_files set private_path=%s where track_id=%s',(str(root/f'{index}.flac'),track))
    receipt,_=db.create()
    with db.connect() as con:
        con.execute('update library.local_track_files set metadata=%s where track_id=any(%s)',
            (Jsonb({'scan_cache':{'stale':True,'stale_marked_at':datetime.now(timezone.utc).isoformat()}}),db.tracks))
    return db,root,receipt


def test_inspect_is_unsaved_and_explicit_save_keeps_only_confirmed_missing(missing_playlist):
    db,root,receipt=missing_playlist
    (root/'1.flac').write_bytes(b'synthetic-file')
    data=missing.inspect(db.service,db.context(),receipt['playlist_id'],receipt['revision'])['data']
    assert data['mode']=='missing' and data['source']=={'kind':'playlist','ref':receipt['playlist_id'],'revision':'1'}
    assert len(data['entries'])==2 and all(row['availability']=='missing' for row in data['entries'])
    assert db.count('playlists')==1
    assert all(parent['completeness']=='incomplete' for parent in data['retained_parent_albums'])
    saved=db.service.execute(db.context(),create_command(data))
    assert db.count('playlists')==2
    assert len(db.service.read(db.context(),playlist_ref=saved['playlist_id'])['playlist_detail']['track_rows'])==2


@pytest.mark.parametrize('change',['offline','unhealthy','unknown_root','reappeared'])
def test_uncertain_or_restored_source_rejects_save_atomically(missing_playlist,change):
    from psycopg.types.json import Jsonb
    db,root,receipt=missing_playlist
    data=missing.inspect(db.service,db.context(),receipt['playlist_id'],'1')['data']
    if change=='offline':root.rmdir()
    elif change=='reappeared':(root/'0.flac').write_bytes(b'synthetic-file')
    else:
        with db.connect() as con:
            if change=='unhealthy':
                con.execute('update library.libraries set metadata=%s where id=%s',
                    (Jsonb({'library_watch_health':{'owned-missing-root':'offline'}}),db.library))
            else:con.execute("update library.library_roots set metadata='{}'::jsonb where library_id=%s",(db.library,))
    with pytest.raises(PlaylistError,match='source_changed'):
        db.service.execute(db.context(),create_command(data))
    assert db.count('playlists')==1 and db.count('playlist_operations')==1


def test_changed_source_playlist_revision_rejects_old_inspect(missing_playlist):
    db,root,receipt=missing_playlist
    data=missing.inspect(db.service,db.context(),receipt['playlist_id'],'1')['data']
    command=normalize_playlist_command('save',{'revision':'1','request_key':str(uuid4()),'title':'Changed'},playlist_ref=receipt['playlist_id'])
    db.service.execute(db.context(),command)
    with pytest.raises(PlaylistError,match='source_changed'):
        db.service.execute(db.context(),create_command(data))
    assert db.count('playlists')==1


def test_known_unhealthy_root_is_not_registered_local_or_confirmed_missing(db):
    from psycopg.types.json import Jsonb
    with db.connect() as con:
        con.execute('update library.library_roots set metadata=%s where library_id=%s',
            (Jsonb({'root_id':'owned-offline'}),db.library))
        con.execute('update library.libraries set metadata=%s where id=%s',
            (Jsonb({'library_watch_health':{'owned-offline':'offline'}}),db.library))
    _,page=db.source()
    assert all(row['availability']=='unresolved' for row in page['entries'])
