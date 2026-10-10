"""Strict Queue occurrence and mutation-receipt contracts."""
from uuid import uuid4
import pytest
from music_app.services.owned_playlists import PlaylistError, normalize_playlist_command


def test_queue_keeps_duplicate_occurrences_in_authored_order():
    from music_app.services.playlist_queue_sources import normalize_occurrences
    values=[{'kind':'inventory','track_ref':'inventory-track:7:9'}]*2
    assert normalize_occurrences(values,7)==values


@pytest.mark.parametrize('value',[None,[],[{}],[{'kind':'inventory','track_ref':'inventory-track:8:9'}],
    [{'kind':'inventory','track_ref':'inventory-track:7:9','path':'private'}],
    [{'kind':'playlist','track_ref':'inventory-track:7:9','playlist_ref':str(uuid4()),'revision':'01','item_ref':str(uuid4())}],
    [{'kind':'activity','track_ref':'inventory-track:7:9','origin':{},'row_ref':'invented'}]])
def test_queue_rejects_incomplete_forged_or_cross_library_occurrences(value):
    from music_app.services.playlist_queue_sources import normalize_occurrences
    with pytest.raises(PlaylistError):normalize_occurrences(value,7)


def test_add_guard_is_part_of_original_command_digest():
    body={'revision':'1','request_key':str(uuid4()),'track_refs':['inventory-track:7:9']}
    target=str(uuid4())
    ordinary=normalize_playlist_command('add',body,playlist_ref=target)
    guard={'source_protocol':'complete_inventory_selection_v1',
        'source':{'kind':'library','ref':str(uuid4()),'revision':str(uuid4())},'entry_refs':[str(uuid4())]}
    guarded=normalize_playlist_command('add',{**body,'source_guard':guard},playlist_ref=target)
    assert guarded.data['source_guard']==guard
    assert guarded.digest!=ordinary.digest
    for change in ({'source_protocol':'library_selection_v1'},{'entry_refs':[]},{'extra':True}):
        with pytest.raises(PlaylistError):
            normalize_playlist_command('add',{**body,'source_guard':{**guard,**change}},playlist_ref=target)


def test_queue_route_uses_browse_and_protects_context_and_exact_body(monkeypatch):
    import asyncio
    import json
    from music_app.routes import playlist_complete_sources_asgi as routes
    from music_app.routes import owned_playlists_asgi
    from music_app.services import playlist_queue_sources as queue
    from music_app.services.owned_playlists import BROWSE
    from music_app.services.private_route_boundary import _PRIVATE_ROUTE_ACTIONS
    from tests.py.test_playlist_collaboration_routes import request,Service,context
    service=Service()
    calls=[]
    monkeypatch.setattr(routes,'_context',lambda req,action:(calls.append(action) or context(),None))
    monkeypatch.setattr(owned_playlists_asgi,'_context_ref',lambda req:'a'*64)
    monkeypatch.setattr(queue,'capture',lambda owner,ctx,occurrences,**kwargs:{'status':'ready','data':{'occurrences':occurrences}})
    body={'occurrences':[{'kind':'inventory','track_ref':'inventory-track:7:9'}]}
    response=asyncio.run(routes.playlist_queue_selection_source(request(body,service)))
    assert response.status_code==200 and calls==[BROWSE]
    assert response.headers['cache-control']=='private, no-store'
    assert _PRIVATE_ROUTE_ACTIONS[('POST','/playlists/creation-source/queue')]==BROWSE
    for supplied,fresh,code in ((body,False,'stale_context'),({**body,'extra':True},True,'invalid_command')):
        response=asyncio.run(routes.playlist_queue_selection_source(request(supplied,service,fresh=fresh)))
        assert json.loads(response.body)['error']==code
