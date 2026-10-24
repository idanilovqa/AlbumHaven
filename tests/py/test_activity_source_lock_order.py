"""Reciprocal friend selections retain the global ordered account lock rule."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Barrier

from music_app.services.current_actor import CapabilityGrant
from music_app.services.home_activity import ActivityQuery, read_home_activity
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services.playlist_complete_sources import CompletePlaylistSources
from tests.py.test_activity_native_targets_postgres import native_activity,capture
from tests.py.test_friend_home_activity import social_ledger,social_read
from tests.py.test_home_activity_postgres_integration import database_urls,mutable_ledger,NOW
from tests.py.test_playlist_extended_sources_postgres import create_command


def test_reciprocal_friend_capture_and_save_do_not_deadlock(native_activity):
    state,ctx,_,_=native_activity
    database=state['db']
    with database.connect() as con:
        con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,'library.playlists.create','library',%s)",
            (state['peer'],ctx.library_id))
        own_ref=str(con.execute('select account_ref from app.social_profiles where account_id=%s',(ctx.actor.account_id,)).fetchone()['account_ref'])
    with database.session(state['peer'],ctx.library_id) as peer:
        peer=replace(peer,capability_grants=(*peer.capability_grants,CapabilityGrant('capability.social','library',ctx.library_id),
            CapabilityGrant('library.playlists.create','library',ctx.library_id)))
        peer_ctx=replace(ctx,actor=peer)
        origin,rows=capture(native_activity)
        other=read_home_activity(database.config,actor=peer,subject_account_id=ctx.actor.account_id,
            query=ActivityQuery(kind='tracks',period='all'),allowed_actions_for_resource=social_read,now=NOW)['data']
        peer_origin={'audience':'friend','subject_ref':own_ref,'kind':'tracks','period':'all','snapshot_ref':other['snapshot_ref']}
        barrier=Barrier(2)
        def create(actor,descriptor,entries):
            owner=PostgresOwnedPlaylistsService(database.config)
            barrier.wait(timeout=5)
            data=CompletePlaylistSources(playlists=owner).from_activity(actor,descriptor,[entries[0]['id']])['data']
            barrier.wait(timeout=5)
            return owner.execute(actor,create_command(data))
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                first=pool.submit(create,ctx,origin,rows)
                second=pool.submit(create,peer_ctx,peer_origin,other['rows'])
                assert first.result(timeout=20)['ok'] and second.result(timeout=20)['ok']
        finally:
            with database.connect() as con:
                con.execute('delete from app.playlist_operations where library_id=%s',(ctx.library_id,))
                con.execute('delete from app.playlists where library_id=%s',(ctx.library_id,))
