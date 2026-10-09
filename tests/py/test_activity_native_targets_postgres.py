"""Real receipt/current-authority checks around existing native media owners."""
from dataclasses import replace
from pathlib import Path

import pytest

from music_app.services.current_actor import CapabilityGrant
from music_app.services.activity_native_targets import ActivityNativeTargets
from music_app.services.home_activity import ActivityQuery, ActivityScope, ComparisonQuery, HomeActivityError, read_home_activity
from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_library_authority import PrivateLibraryAuthorityError
from music_app.services.private_native_targets import NativeTargetError
from tests.py.test_friend_home_activity import social_ledger,friend_read,social_read
from tests.py.test_home_activity_postgres_integration import database_urls,mutable_ledger,NOW,allow_all


@pytest.fixture
def native_activity(social_ledger,tmp_path):
    from psycopg.types.json import Jsonb
    state=social_ledger;db=state['db'];library=state['data']['library']
    root=tmp_path/'library';root.mkdir()
    with db.connect() as con:
        root_id=con.execute('insert into library.library_roots(library_id,root_path,metadata) values(%s,%s,%s) returning id',
            (library,str(root),Jsonb({'root_id':'native-root'}))).fetchone()['id']
        for index,track in enumerate(state['data']['tracks']):
            path=root/f'{index}.flac';path.write_bytes(b'synthetic-native-fixture')
            con.execute('update library.local_track_files set library_root_id=%s,private_path=%s where track_id=%s',
                (root_id,str(path),track['id']))
        for action in ('library.media.read','library.playlists.create','library.playlists.items.manage'):
            con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)",
                (state['actor'].account_id,action,library))
    actor=replace(state['actor'],capability_grants=(*state['actor'].capability_grants,
        *(CapabilityGrant(action,'library',library) for action in ('library.media.read','library.playlists.create','library.playlists.items.manage'))))
    state={**state,'actor':actor}
    context=PolicyContext.build(actor=actor,action='library.browse.read',library_id=library,deployment_mode='self_hosted',
        request_origin=RequestOrigin('network','synthetic:native'),client_surface_class='private_web')
    probes=[]
    def media(config,path,**kwargs):
        probes.append(path)
        candidate=Path(path).resolve()
        allowed=kwargs.get('configured_root_paths',(root,))
        if not any(candidate.is_relative_to(Path(base).resolve()) for base in allowed) or not candidate.is_file():return None
        return candidate
    service=ActivityNativeTargets(db.config,media_resolver=media)
    return state,context,service,probes


def capture(value,kind='tracks',*,comparison=False):
    state,_,_,_=value
    if comparison:
        response=read_home_activity(state['db'].config,actor=state['actor'],subject_account_id=state['peer'],comparison=True,
            query=ComparisonQuery(kind=kind,period='all'),
            allowed_actions_for_resource=social_read,now=NOW)
    else:response=friend_read(state,kind=kind)
    origin={'audience':'comparison' if comparison else 'friend','subject_ref':state['peer_ref'],'kind':kind,'period':'all',
            'snapshot_ref':response['data']['snapshot_ref']}
    return origin,response['data']['rows']


def test_exact_friend_receipt_can_resolve_native_play_without_exposing_path_in_projection(native_activity):
    state,ctx,service,probes=native_activity
    origin,rows=capture(native_activity)
    projected=service.project(ctx,origin=origin,rows=rows)
    assert projected[0]['allowed_actions']['can_resolve_native_play'] is True
    assert projected[0]['allowed_actions']['can_select_for_playlist'] is True
    assert projected[0]['inventory_track_ref'].startswith(f'inventory-track:{ctx.library_id}:')
    assert 'path' not in projected[0]
    result=service.resolve(ctx,origin=origin,row_ref=rows[0]['id'],intent='play')
    assert result['origin']==origin and result['row_ref']==rows[0]['id']
    assert result['native_target']['path'] in probes and Path(result['native_target']['path']).is_file()


@pytest.mark.parametrize('kind',['tracks','albums','artists'])
def test_details_resolve_current_target_from_exact_receipt_subject(native_activity,kind):
    state,ctx,service,probes=native_activity
    origin,rows=capture(native_activity,kind)
    projected=service.project(ctx,origin=origin,rows=rows)
    target=projected[0]['artist_target' if kind=='artists' else 'album_target']
    assert target['ref']==rows[0]['id'] and target['allowed_actions']['can_view_details'] is True
    result=service.resolve(ctx,origin=origin,row_ref=rows[0]['id'],intent='details')
    assert ('artist_ref' if kind=='artists' else 'album_ref') in result['native_target']
    assert 'path' not in result['native_target'] and not probes


def test_comparison_taste_authority_is_not_dropped_by_native_revalidation(native_activity):
    state,ctx,service,probes=native_activity
    origin,rows=capture(native_activity,comparison=True)
    def deny_taste(context):
        return PolicyEvaluationConstraints(request_origin_allowed=context.action!='library.social.taste.read')
    with pytest.raises(HomeActivityError):
        service.resolve(ctx,origin=origin,row_ref=rows[0]['id'],intent='play',constraints=deny_taste)
    assert not probes


def test_media_or_track_browse_denial_never_resolves_a_private_path(native_activity):
    state,ctx,service,probes=native_activity
    origin,rows=capture(native_activity)
    def constraints(context):
        denied=context.action=='library.media.read'
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    projected=service.project(ctx,origin=origin,rows=rows,constraints=constraints)
    assert projected[0]['allowed_actions']['can_resolve_native_play'] is False
    with pytest.raises(NativeTargetError,match='forbidden'):
        service.resolve(ctx,origin=origin,row_ref=rows[0]['id'],intent='play',constraints=constraints)
    assert not probes
    def deny_track(context):
        denied=context.action=='library.browse.read' and context.resource is not None and context.resource.resource_kind=='track'
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    projected=service.project(ctx,origin=origin,rows=rows,constraints=deny_track)
    assert all(row['inventory_track_ref'] is None and not row['allowed_actions']['can_select_for_playlist'] for row in projected)


@pytest.mark.parametrize('change',['unfriend','session'])
def test_revoked_private_source_cannot_be_used_as_native_authority(native_activity,change):
    state,ctx,service,probes=native_activity
    origin,rows=capture(native_activity)
    with state['db'].connect() as con:
        if change=='unfriend':
            con.execute("update app.friend_connections set state='removed',revision=revision+1 where library_id=%s and low_account_id=%s and high_account_id=%s",state['pair'])
        else:con.execute('update app.account_sessions set revoked_at=now() where id=%s',(ctx.actor.session_id,))
    with pytest.raises((HomeActivityError,PrivateLibraryAuthorityError)):
        service.resolve(ctx,origin=origin,row_ref=rows[0]['id'],intent='play')
    assert not probes


def test_playlist_export_stays_track_only_despite_new_native_album_reader(native_activity):
    state,ctx,service,probes=native_activity
    origin,rows=capture(native_activity,'albums')
    repository=HomeActivityPostgresRepository(state['db'].config)
    scope=ActivityScope(ctx.actor.account_id,ctx.actor.session_id,ctx.library_id,state['peer'],'friend')
    query=ActivityQuery(kind='albums',period='all',snapshot_ref=origin['snapshot_ref'])
    with state['db'].connect() as con:
        con.execute('select 1')
        with pytest.raises(HomeActivityError):
            repository.read_selection(con,scope=scope,query=query,row_refs=[rows[0]['id']],allowed_actions_for_resource=social_read)


def test_reciprocal_friend_native_reads_do_not_deadlock_account_locks(native_activity):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    state,ctx,service,_=native_activity
    with state['db'].session(state['peer'],ctx.library_id) as peer:
        peer=replace(peer,capability_grants=(*peer.capability_grants,CapabilityGrant('capability.social','library',ctx.library_id)))
        peer_ctx=replace(ctx,actor=peer)
        with state['db'].connect() as con:
            own_ref=str(con.execute('select account_ref from app.social_profiles where account_id=%s',(ctx.actor.account_id,)).fetchone()['account_ref'])
        origin,rows=capture(native_activity)
        other=read_home_activity(state['db'].config,actor=peer,subject_account_id=ctx.actor.account_id,
            query=ActivityQuery(kind='tracks',period='all'),allowed_actions_for_resource=social_read,now=NOW)['data']
        peer_origin={'audience':'friend','subject_ref':own_ref,'kind':'tracks','period':'all','snapshot_ref':other['snapshot_ref']}
        barrier=Barrier(2)
        def project(actor_context,descriptor,data):
            barrier.wait(timeout=5)
            return service.project(actor_context,origin=descriptor,rows=data)
        with ThreadPoolExecutor(max_workers=2) as pool:
            first=pool.submit(project,ctx,origin,rows)
            second=pool.submit(project,peer_ctx,peer_origin,other['rows'])
            assert first.result(timeout=15) and second.result(timeout=15)


def test_committed_activity_creation_replay_survives_later_unfriend(native_activity):
    from music_app.services.playlist_complete_sources import CompletePlaylistSources
    from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
    from tests.py.test_playlist_extended_sources_postgres import create_command
    state,ctx,_,_=native_activity
    origin,rows=capture(native_activity)
    service=PostgresOwnedPlaylistsService(state['db'].config)
    data=CompletePlaylistSources(playlists=service).from_activity(ctx,origin,[rows[0]['id']])['data']
    assert data['entries'][0]['source_row_ref']==rows[0]['id']
    command=create_command(data)
    first=service.execute(ctx,command)
    try:
        with state['db'].connect() as con:
            con.execute("update app.friend_connections set state='removed',revision=revision+1 where library_id=%s and low_account_id=%s and high_account_id=%s",state['pair'])
        replay=service.execute(ctx,command)
        assert replay==first
    finally:
        with state['db'].connect() as con:
            con.execute('delete from app.playlist_operations where library_id=%s',(ctx.library_id,))
            con.execute('delete from app.playlists where library_id=%s',(ctx.library_id,))


def test_persisted_native_queue_revalidates_membership_revision_and_media(native_activity):
    from music_app.services.playlist_complete_sources import CompletePlaylistSources
    from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
    from music_app.services.playlist_native_targets import PlaylistNativeTargets
    from music_app.services.owned_playlists import PlaylistError
    from tests.py.test_playlist_extended_sources_postgres import create_command
    state,ctx,native,_=native_activity
    origin,rows=capture(native_activity)
    owner=PostgresOwnedPlaylistsService(state['db'].config)
    data=CompletePlaylistSources(playlists=owner).from_activity(ctx,origin,[row['id'] for row in rows])['data']
    receipt=owner.execute(ctx,create_command(data))
    service=PlaylistNativeTargets(state['db'].config,playlists=owner,media_resolver=native.targets.media_resolver)
    try:
        with state['db'].connect() as con:
            refs=[str(row['ref']) for row in con.execute('select ref from app.playlist_items where playlist_ref=%s order by position',
                (receipt['playlist_id'],)).fetchall()]
        result=service.queue(ctx,playlist_ref=receipt['playlist_id'],revision=receipt['revision'],item_refs=list(reversed(refs)),starting_item_ref=refs[0])
        assert [row['playlist_item_id'] for row in result['tracks']]==list(reversed(refs))
        with pytest.raises(PlaylistError,match='revision_conflict'):
            service.queue(ctx,playlist_ref=receipt['playlist_id'],revision='999',item_refs=refs,starting_item_ref=refs[0])
        with state['db'].connect() as con:
            con.execute("update app.capabilities set revoked_at=now() where account_id=%s and capability_key='library.media.read'",(ctx.actor.account_id,))
        with pytest.raises(PlaylistError,match='item_unavailable'):
            service.queue(ctx,playlist_ref=receipt['playlist_id'],revision=receipt['revision'],item_refs=refs,starting_item_ref=refs[0])
    finally:
        with state['db'].connect() as con:
            con.execute('delete from app.playlist_operations where library_id=%s',(ctx.library_id,))
            con.execute('delete from app.playlists where library_id=%s',(ctx.library_id,))
