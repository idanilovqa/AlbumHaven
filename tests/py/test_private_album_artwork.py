"""Existing image renderer behind live account/library/Album authority."""
from dataclasses import replace
from pathlib import Path

import pytest
from PIL import Image

from music_app.services.current_actor import CapabilityGrant
from music_app.services.private_album_artwork import PrivateAlbumArtwork,album_artwork_url
from music_app.services.private_library_authority import PrivateLibraryAuthorityError
from music_app.services.private_native_targets import NativeTargetError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_activity_native_targets_postgres import native_activity,capture
from tests.py.test_friend_home_activity import social_ledger
from tests.py.test_home_activity_postgres_integration import database_urls,mutable_ledger


@pytest.fixture
def artwork(native_activity):
    state,ctx,native,_=native_activity
    with state['db'].connect() as con:
        path=Path(con.execute('select private_path from library.local_track_files where track_id=%s',
            (state['data']['tracks'][0]['id'],)).fetchone()['private_path']).parent/'cover.png'
        Image.new('RGB',(4,4),'red').save(path)
        path.write_bytes(path.read_bytes()+b'PRIVATE-APPENDED-BYTES')
        con.execute('update library.local_albums set cover_path=%s where id=%s',(str(path),state['data']['album']))
        con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,'library.artwork.read','library',%s)",
            (ctx.actor.account_id,ctx.library_id))
    ctx=replace(ctx,actor=replace(ctx.actor,capability_grants=(*ctx.actor.capability_grants,
        CapabilityGrant('library.artwork.read','library',ctx.library_id))))
    service=PrivateAlbumArtwork(state['db'].config,resolver=native.targets.media_resolver)
    return state,ctx,service,path,native


def test_current_id_artwork_is_sanitized_and_private_without_media_permission(artwork):
    state,ctx,service,path,_=artwork
    with state['db'].connect() as con:
        con.execute("update app.capabilities set revoked_at=now() where account_id=%s and capability_key='library.media.read'",(ctx.actor.account_id,))
    url=album_artwork_url(ctx,state['data']['album'])
    assert str(path) not in url
    response=service.read(ctx,url.rsplit('/',1)[1])
    assert response.media_type=='image/png' and response.body.startswith(b'\x89PNG')
    assert b'PRIVATE-APPENDED-BYTES' not in response.body
    assert response.headers['cache-control']=='private, no-store'


@pytest.mark.parametrize('revocation',['grants','membership','session'])
def test_stale_context_cannot_serve_artwork_after_authority_changes(artwork,revocation):
    state,ctx,service,_,_=artwork
    ref=f"inventory-album:{ctx.library_id}:{state['data']['album']}"
    with state['db'].connect() as con:
        if revocation=='grants':
            # Legacy Browse/Media aliases and Social->View also grant Artwork.
            # Revoke effective authority, not only its redundant direct grant.
            con.execute('update app.capabilities set revoked_at=now() where account_id=%s',(ctx.actor.account_id,))
        elif revocation=='membership':con.execute('delete from library.library_memberships where account_id=%s and library_id=%s',(ctx.actor.account_id,ctx.library_id))
        else:con.execute('update app.account_sessions set revoked_at=now() where id=%s',(ctx.actor.session_id,))
    with pytest.raises(PrivateLibraryAuthorityError):service.read(ctx,ref)


def test_artwork_requires_album_policy_and_current_library_root_agreement(artwork):
    state,ctx,service,path,_=artwork
    ref=f"inventory-album:{ctx.library_id}:{state['data']['album']}"
    def deny(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not(context.action=='library.artwork.read' and context.resource is not None))
    assert album_artwork_url(ctx,state['data']['album'],constraints=deny) is None
    with pytest.raises(PrivateLibraryAuthorityError):service.read(ctx,ref,constraints=deny)
    service.resolver=lambda config,value,**kwargs:Path('/outside/cover.png') if kwargs else path
    with pytest.raises(NativeTargetError):service.read(ctx,ref)
    with pytest.raises(NativeTargetError):service.read(ctx,f"inventory-album:{ctx.library_id+1}:{state['data']['album']}")


def test_activity_projection_reuses_same_safe_album_url_for_known_tracks(artwork):
    state,ctx,_,path,native=artwork
    origin,rows=capture((state,ctx,native,[]))
    result=native.project(ctx,origin=origin,rows=rows)
    expected=album_artwork_url(ctx,state['data']['album'])
    assert expected and all(row['artwork_url']==expected for row in result)
    assert str(path) not in repr(result)


def test_artwork_transport_is_registered_and_hides_unexpected_errors(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from music_app.routes import private_album_artwork_asgi as route
    from music_app.services.private_route_boundary import private_action_for_route
    from tests.py.test_owned_playlist_route_boundary import request,Service
    assert private_action_for_route('GET','/library/album-artwork/{album_ref}')=='library.artwork.read'
    def fail(*args,**kwargs):raise RuntimeError('/private/path/with-secret')
    monkeypatch.setattr(route,'PrivateAlbumArtwork',lambda config:SimpleNamespace(read=fail))
    response=asyncio.run(route.private_album_artwork(request(Service()),'inventory-album:73:501'))
    assert response.status_code==503 and response.body==b''
    assert response.headers['cache-control']=='private, no-store'


def test_playlist_projection_uses_existing_album_identity_and_artwork_grant_only():
    from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
    from tests.py.owned_playlist_testing import context,item_row,inventory_row
    ctx=context()
    ctx=replace(ctx,actor=replace(ctx.actor,capability_grants=(*ctx.actor.capability_grants,
        CapabilityGrant('library.artwork.read','library',ctx.library_id))))
    row=PostgresOwnedPlaylistsService._track_row(ctx,item_row(),inventory_row())
    assert row['artwork_url']==f'/library/album-artwork/inventory-album:{ctx.library_id}:501'
    def deny(context):return PolicyEvaluationConstraints(request_origin_allowed=context.action!='library.artwork.read')
    assert PostgresOwnedPlaylistsService._track_row(ctx,item_row(),inventory_row(),constraints=deny)['artwork_url'] is None
