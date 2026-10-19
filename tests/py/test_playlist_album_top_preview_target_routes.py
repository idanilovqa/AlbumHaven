"""Native preview target transport preserves the private context boundary."""
import asyncio
import json
from uuid import uuid4

from test_owned_album_top_route_boundary import request, Service
from music_app.routes import owned_album_tops_asgi as routes
from music_app.services import playlist_album_top_previews as previews
from music_app.services.private_route_boundary import private_action_for_route


def test_preview_target_route_is_registered_and_context_bound(monkeypatch):
    calls = []
    class Targets:
        def __init__(self, tops):
            pass

        def resolve_album(self, context, **options):
            calls.append(options)
            return {'preview_ref': options['preview_ref'], 'album_ref': options['album_ref']}

    monkeypatch.setattr(previews, 'PlaylistAlbumTopPreviews', Targets)
    ref, album = str(uuid4()), str(uuid4())
    response = asyncio.run(routes.resolve_playlist_album_top_member(request(Service()), ref, album))
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'private, no-store'
    assert json.loads(response.body)['data']['album_ref'] == album
    assert calls[0]['preview_ref'] == ref and len(calls[0]['context_ref']) == 64
    assert private_action_for_route('GET', '/album-tops/playlist-previews/{preview_ref}/albums/{album_ref}/native-target') == 'library.browse.read'
    for options, expected in [({'context_header': 'b' * 64}, 409), ({'query': {'intent': 'play'}}, 422)]:
        response = asyncio.run(routes.resolve_playlist_album_top_member(request(Service(), **options), ref, album))
        assert response.status_code == expected
    assert len(calls) == 1
