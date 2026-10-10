"""Native target transport preserves context stamps, bounded bodies and privacy."""
import asyncio
import json
from types import SimpleNamespace

import pytest
from music_app.routes import playlist_native_targets_asgi as playlist_routes
from music_app.routes import activity_native_targets_asgi as activity_routes
from music_app.services.private_route_boundary import private_action_for_route
from tests.py.test_owned_playlist_route_boundary import request, Service
from tests.py.owned_playlist_testing import PLAYLIST, ITEM_A


@pytest.mark.parametrize('kind',['activity','queue'])
@pytest.mark.parametrize('case',['ready','stale','extra','large'])
def test_native_post_transport(monkeypatch,kind,case):
    calls=[]
    def invoke(context,**kwargs):
        calls.append(kwargs)
        return {'native_target':{'track_ref':'synthetic:native-only'}}
    payload=({'origin':{},'row_ref':'activity_'+'a'*64,'intent':'play'} if kind=='activity'
        else {'revision':'1','item_refs':[ITEM_A],'starting_item_ref':ITEM_A})
    if case=='extra':payload['injected']=True
    if case=='large':payload['padding']='a'*(600*1024)
    req=request(Service(),payload=payload,header='stale' if case=='stale' else 'valid')
    if kind=='activity':
        monkeypatch.setattr(activity_routes,'ActivityNativeTargets',lambda config:SimpleNamespace(resolve=invoke))
        response=asyncio.run(activity_routes.activity_native_target(req))
    else:
        monkeypatch.setattr(playlist_routes,'PlaylistNativeTargets',lambda config,playlists:SimpleNamespace(queue=invoke))
        response=asyncio.run(playlist_routes.playlist_native_queue(req,PLAYLIST))
    assert response.status_code=={'ready':200,'stale':409,'extra':422,'large':413}[case]
    assert {'private','no-store'} <= {part.strip() for part in response.headers['cache-control'].split(',')}
    assert len(calls)==(1 if case=='ready' else 0)
    if case=='ready':assert len(json.loads(response.body)['context_ref'])==64


def test_native_routes_registered_with_read_action():
    for method,path in [('POST','/home/activity/native-target'),('POST','/playlists/{playlist_ref}/native-queue'),
        ('GET','/playlists/{playlist_ref}/items/{item_ref}/native-target')]:
        assert private_action_for_route(method,path)=='library.browse.read'
