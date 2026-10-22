"""Independent handler-boundary contracts using the existing request/context owner."""
import asyncio

import pytest

from music_app.routes import owned_album_tops_asgi as routes
from tests.py.test_owned_album_top_route_boundary import Service, request, decoded, TOP, ALBUM


class CatalogService(Service):
    def search_inventory_albums(self, context, **options):
        self.calls.append(('search', context, options))
        return {'albums': [], 'next_cursor': None}


@pytest.mark.parametrize('mode', ['artist', 'family'])
def test_search_pairs_scope_and_passes_exact_authenticated_context(mode):
    service = CatalogService()
    req = request(service, query={'root_artist_id': '73', 'scope_mode': mode, 'q': ''})
    response = routes.search_album_top_inventory(req)
    assert response.status_code == 200
    assert decoded(response)['data'] == {'albums': [], 'next_cursor': None}
    assert len(service.calls) == 1
    _, context, options = service.calls[0]
    assert context.actor is req.state.current_actor
    assert options['artist_scope'] == {'root_artist_id': '73', 'mode': mode}
    assert options['query'] == '' and options['top_ref'] is None


@pytest.mark.parametrize('query', [
    {'root_artist_id': '73'}, {'scope_mode': 'artist'},
    {'root_artist_id': '073', 'scope_mode': 'artist'},
    {'root_artist_id': '73', 'scope_mode': 'all'},
    {'root_artist_id': '73', 'scope_mode': 'artist', 'top_ref': TOP},
])
def test_malformed_or_overridden_search_scope_never_reaches_service(query):
    service = CatalogService()
    response = routes.search_album_top_inventory(request(service, query=query))
    assert response.status_code == 422 and decoded(response)['error'] == 'invalid_query'
    assert service.calls == []


@pytest.mark.parametrize('mode', ['artist', 'family'])
def test_unsaved_inventory_admission_forwards_exact_scope_with_existing_identity(mode):
    service = Service()
    scope = {'root_artist_id': '73', 'mode': mode}
    req = request(service, payload={'album_id': 901, 'artist_scope': scope})
    response = asyncio.run(routes.admit_album_top_inventory(req))
    assert response.status_code == 200 and decoded(response)['data'] == {'album_ref': ALBUM}
    assert len(service.calls) == 1
    _, context, options = service.calls[0]
    assert context.actor is req.state.current_actor
    assert options['album_id'] == 901 and options['artist_scope'] == scope


@pytest.mark.parametrize('scope', [None, {}, {'root_artist_id': '073', 'mode': 'artist'},
                                  {'root_artist_id': '73', 'mode': 'artist', 'name': 'Forged'}])
def test_inventory_scope_is_normalized_before_service(scope):
    service = Service()
    response = asyncio.run(routes.admit_album_top_inventory(request(service, payload={'album_id': 901, 'artist_scope': scope})))
    assert response.status_code == 422 and decoded(response)['error'] == 'invalid_command'
    assert service.calls == []
