"""Preview transport delegates only after the existing context/CSRF boundary."""
import asyncio
import json
from uuid import uuid4

import pytest

from test_owned_album_top_route_boundary import request, Service
from music_app.routes import owned_album_tops_asgi as routes
from music_app.services import playlist_album_top_previews as previews


@pytest.fixture
def captured(monkeypatch):
    calls = []
    class PreviewService:
        def __init__(self, tops):
            pass

        def capture(self, context, **options):
            calls.append(('capture', context, options))
            return {'preview_ref': options['payload']['request_key'], 'albums': [], 'report': []}

        def discard(self, context, **options):
            calls.append(('discard', context, options))
            return {'preview_ref': options['preview_ref'], 'discarded': True}

    monkeypatch.setattr(previews, 'PlaylistAlbumTopPreviews', PreviewService)
    return calls


def test_capture_forwards_only_source_revision_and_idempotency_request(captured):
    ref, key = str(uuid4()), str(uuid4())
    response = asyncio.run(routes.capture_playlist_album_top(
        request(Service(), payload={'request_key': key, 'revision': '3'}), ref))
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'private, no-store'
    assert json.loads(response.body)['data']['preview_ref'] == key
    assert captured[0][2]['playlist_ref'] == ref
    assert captured[0][2]['payload'] == {'request_key': key, 'revision': '3'}
    assert len(captured[0][2]['context_ref']) == 64


def test_stale_context_never_captures_or_discards(captured):
    ref = str(uuid4())
    for handler in (routes.capture_playlist_album_top, routes.discard_playlist_album_top):
        response = asyncio.run(handler(request(Service(), payload={}, context_header='b' * 64), ref))
        assert response.status_code == 409
    assert captured == []


def test_oversized_preview_request_is_rejected_before_service(captured):
    response = asyncio.run(routes.capture_playlist_album_top(
        request(Service(), raw=b'{' + b' ' * 4096 + b'}'), str(uuid4())))
    assert response.status_code == 413
    assert captured == []
