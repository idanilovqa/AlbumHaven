"""Real private route and query contracts; no SQL or inventory producer doubles."""
import asyncio
import json

import pytest

from music_app.routes import owned_album_tops_asgi as routes
from music_app.services.album_top_publication_sources import validate_request, _position
from music_app.services.current_actor import CurrentActor
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.private_ui_context import private_ui_context_ref
from music_app.services.private_route_boundary import private_action_for_route
from music_app.services.social_cursors import encode_social_cursor
from tests.py.test_owned_album_top_route_boundary import request, middleware_app, actor, TOP, ITEM
from tests.py.test_public_album_top_http import exchange

SECRET = 'synthetic-publication-source-cursor-key-32-bytes'
CONTEXT = 'a' * 64
PATH = f'/album-tops/{TOP}/items/{ITEM}/publication-sources'


class Service:
    def __init__(self):
        self.calls = []
    def read_publication_sources(self, context, **options):
        self.calls.append((context, options))
        return {'top_ref': options['top_ref'], 'item_ref': options['item_ref'],
                'revision': options['revision'], 'album_ref': ITEM, 'sources': [], 'next_cursor': None}


def test_route_passes_exact_identity_context_limit_and_server_secret_without_write_header():
    service = Service()
    req = request(service, query={'revision': '12', 'limit': '5', 'cursor': 'opaque'}, context_header=None)
    response = routes.read_album_top_publication_sources(req, TOP, ITEM)
    assert response.status_code == 200 and response.headers['cache-control'] == 'private, no-store'
    context, values = service.calls[0]
    assert context.actor is req.state.current_actor
    assert values['top_ref'] == TOP and values['item_ref'] == ITEM and values['revision'] == '12'
    assert values['context_ref'] == private_ui_context_ref(req)
    assert values['cursor'] == 'opaque' and values['limit'] == 5
    assert values['cursor_secret'] == req.app.state.auth_policy_config['hmac']['secret']
    assert 'cursor_secret' not in response.body.decode()


@pytest.mark.parametrize('query', [[], [('revision', '1'), ('revision', '2')],
    {'revision': '0'}, {'revision': '01'}, {'revision': '9223372036854775808'},
    {'revision': '1', 'limit': '0'}, {'revision': '1', 'limit': '101'},
    {'revision': '1', 'limit': '١'}, {'revision': '1', 'limit': '1.2'},
    {'revision': '1', 'cursor': ''}, {'revision': '1', 'cursor': 'x' * 4097},
    {'revision': '1', 'library_id': '2'}, [('revision', '1'), ('cursor', 'a'), ('cursor', 'b')]])
def test_route_rejects_invalid_or_duplicate_queries_before_service(query):
    service = Service()
    response = routes.read_album_top_publication_sources(request(service, query=query), TOP, ITEM)
    assert response.status_code == 422 and json.loads(response.body)['error'] == 'invalid_query'
    assert service.calls == []


@pytest.mark.parametrize('changes', [{'revision': 1}, {'limit': True}, {'limit': 101},
    {'cursor': []}, {'context_ref': 'short'}, {'top_ref': 'bad'}, {'item_ref': 'bad'}])
def test_typed_boundary_is_strict(changes):
    with pytest.raises(AlbumTopError) as caught:
        validate_request(**{'top_ref': TOP, 'item_ref': ITEM, 'revision': '1',
                            'context_ref': CONTEXT, **changes})
    assert caught.value.code == 'invalid_query'


def test_composite_cursor_is_bounded_and_preserves_source_uuid_even_zero():
    scope = ['synthetic']
    for local, ref in [(1, 0), (9223372036854775807, (1 << 128) - 1)]:
        token = encode_social_cursor((local << 128) | ref, secret=SECRET, scope=scope)
        actual_local, actual_ref = _position(token, SECRET, scope)
        from uuid import UUID
        assert actual_local == local and UUID(actual_ref).int == ref
    for value in [1, 1 << 191]:
        with pytest.raises(AlbumTopError) as caught:
            _position(encode_social_cursor(value, secret=SECRET, scope=scope), SECRET, scope)
        assert caught.value.code == 'invalid_cursor'


@pytest.mark.parametrize('current,status', [(None, 401), (actor(), 200)])
def test_real_middleware_mounts_only_private_authenticated_read(current, status):
    service = Service()
    app = middleware_app(service, current or CurrentActor.anonymous())
    actual, body, headers = asyncio.run(exchange(app, path=PATH, host='music.test', query=b'revision=1'))
    assert actual == status and headers[b'cache-control'] == b'private, no-store'
    assert len(service.calls) == (1 if status == 200 else 0)


def test_sources_route_is_only_get_and_cannot_invoke_post_mutation():
    matched = [route for route in routes.router.routes if route.path.endswith('/items/{item_ref}/publication-sources')]
    assert len(matched) == 1 and matched[0].methods == {'GET'}
    assert private_action_for_route('GET', matched[0].path) == 'library.browse.read'
