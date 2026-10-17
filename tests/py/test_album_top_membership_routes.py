"""Additive authenticated ASGI contracts; normal imports, no configuration bypass."""
import asyncio

import pytest

from music_app.routes import owned_album_tops_asgi as routes
from music_app.services.owned_album_tops import ACCESS, BROWSE, CREATE, MAX_TOP_COMMAND_BYTES
from music_app.services.private_route_boundary import csrf_mode_for_route, private_action_for_route
from music_app.services.private_ui_context import private_ui_context_ref
from tests.py.test_owned_album_top_route_boundary import (
    TOP, ALBUM, ITEM, Service as BaseService, actor, asgi_response, decoded,
    middleware_app, mutation_headers, request,
)

SEARCH = '/album-top-catalog/search'
PREVIEW = '/album-tops/{top_ref}/publication-preview'
SOURCE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
ITEMS = [{'item_ref': ITEM, 'album_ref': ALBUM, 'selected_local_album_id': 11, 'selected_source_ref': SOURCE}]


class Service(BaseService):
    def search_inventory_albums(self, context, **options):
        self.calls.append(('search', context, options))
        return {'albums': [], 'next_cursor': None}

    def publication_preview(self, context, *, top_ref, payload, constraints=None):
        self.calls.append(('preview', context, top_ref, payload, constraints))
        return {'top_ref': top_ref, 'revision': payload['revision'], 'evidence_revision': 'a' * 64, 'items': []}


def endpoint(path, method):
    matches = [route.endpoint for route in routes.router.routes if route.path == path and method in route.methods]
    assert len(matches) == 1, f'Exactly one {method} {path} must own this bounded operation'
    return matches[0]


def search(service, query):
    return endpoint(SEARCH, 'GET')(request(service, query=query, context_header=None))


def preview(service, **options):
    return asyncio.run(endpoint(PREVIEW, 'POST')(request(service, payload={'revision': '7', 'items': ITEMS}, **options), TOP))


def test_search_forwards_only_trimmed_query_current_context_and_edit_purpose():
    service = Service()
    req = request(service, query={'q': '  100%_  ', 'cursor': 'opaque', 'limit': '7', 'top_ref': TOP}, context_header=None)
    response = endpoint(SEARCH, 'GET')(req)
    assert response.status_code == 200
    assert decoded(response) == {'status': 'ready', 'data': {'albums': [], 'next_cursor': None}, 'context_ref': private_ui_context_ref(req)}
    operation, context, options = service.calls[0]
    assert operation == 'search' and context.actor is req.state.current_actor and context.library_id == 73
    assert context.action == BROWSE
    assert options['query'] == '100%_' and options['top_ref'] == TOP and options['cursor'] == 'opaque' and options['limit'] == 7
    assert options['cursor_secret'] == req.app.state.auth_policy_config['hmac']['secret']


@pytest.mark.parametrize('query', [
    {'q': 'a' * 101}, {'q': '\0'}, {'q': 'Album', 'account_id': '99'}, {'library_id': '74'},
    [('q', 'one'), ('q', 'two')], [('top_ref', TOP), ('top_ref', TOP)],
    {'top_ref': 'bad'}, {'limit': '0'}, {'limit': '101'}, {'limit': '1.5'}, {'limit': '１'},
])
def test_search_rejects_ambiguous_scope_identity_and_unbounded_query_before_service(query):
    service = Service()
    response = search(service, query)
    assert response.status_code == 422
    assert service.calls == []


def test_edit_admission_passes_exact_top_identity_without_requiring_create_context():
    service = Service()
    req = request(service, payload={'album_id': 11})
    response = asyncio.run(endpoint('/album-tops/{top_ref}/catalog/inventory', 'POST')(req, TOP))
    assert response.status_code == 200 and decoded(response)['data'] == {'album_ref': ALBUM}
    operation, context, options = service.calls[0]
    assert operation == 'admit' and context.action == BROWSE and context.actor is req.state.current_actor
    assert options['album_id'] == 11 and options['top_ref'] == TOP


@pytest.mark.parametrize('payload', [{'album_id': 11, 'top_ref': 'bad'}, {'album_id': 11, 'top_ref': TOP, 'account_id': 41}, {'album_id': 11, 'role': 'editor'}])
def test_admission_rejects_injected_authority_and_invalid_edit_target(payload):
    service = Service()
    response = asyncio.run(routes.admit_album_top_inventory(request(service, payload=payload)))
    assert response.status_code == 422 and service.calls == []


def test_preview_is_read_only_bounded_and_dispatched_before_generic_mutation():
    service = Service()
    response = preview(service)
    assert response.status_code == 200
    operation, context, ref, payload, _ = service.calls[0]
    assert operation == 'preview' and context.action == ACCESS and ref == TOP
    assert payload == {'revision': '7', 'items': ITEMS}
    registered = [(method, route.path) for route in routes.router.routes for method in route.methods]
    assert registered.index(('POST', PREVIEW)) < registered.index(('POST', '/album-tops/{top_ref}/{action}'))
    assert private_action_for_route('GET', SEARCH) == BROWSE
    assert csrf_mode_for_route('GET', SEARCH) == 'none'
    assert private_action_for_route('POST', PREVIEW) == ACCESS
    assert csrf_mode_for_route('POST', PREVIEW) == 'session_header'


@pytest.mark.parametrize('header', [None, '', '0' * 64])
def test_preview_rejects_stale_context_before_service(header):
    service = Service()
    response = preview(service, context_header=header)
    assert response.status_code == 409 and decoded(response)['error'] == 'stale_context'
    assert service.calls == []


@pytest.mark.parametrize('payload', [{'revision': '7', 'items': ITEMS, 'request_key': TOP}, {'revision': '7', 'items': ITEMS, 'account_id': 41}, {'revision': '7', 'items': [ITEMS[0], ITEMS[0]]}, {'revision': '0', 'items': ITEMS}])
def test_preview_rejects_invalid_complete_draft_before_service(payload):
    service = Service()
    response = asyncio.run(endpoint(PREVIEW, 'POST')(request(service, payload=payload), TOP))
    assert response.status_code == 422 and service.calls == []


@pytest.mark.parametrize('mode', ['declared', 'streamed'])
def test_preview_enforces_shared_command_size_before_parsing(mode):
    service = Service()
    req = request(service, raw=b'{}', headers={'content-length': str(MAX_TOP_COMMAND_BYTES + 1)} if mode == 'declared' else {},
        chunks=[b' ' * MAX_TOP_COMMAND_BYTES, b' '] if mode == 'streamed' else None)
    response = asyncio.run(endpoint(PREVIEW, 'POST')(req, TOP))
    assert response.status_code == 413 and service.calls == []


def test_real_middleware_preview_requires_csrf_and_reaches_read_only_service():
    service, current = Service(), actor()
    app = middleware_app(service, current)
    headers = mutation_headers(app, current)
    path = PREVIEW.replace('{top_ref}', TOP)
    invalid = {key: value for key, value in headers.items() if key != 'x-album-haven-csrf'}
    status, _, _ = asyncio.run(asgi_response(app, 'POST', path, headers=invalid, payload={'revision': '7', 'items': ITEMS}))
    assert status == 403 and service.calls == []
    status, body, response_headers = asyncio.run(asgi_response(app, 'POST', path, headers=headers, payload={'revision': '7', 'items': ITEMS}))
    assert status == 200 and body['data']['evidence_revision'] == 'a' * 64
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert [call[0] for call in service.calls] == ['preview']


@pytest.mark.parametrize('payload', [{'album_id': 11, 'top_ref': TOP}, {'album_id': 11, 'account_id': 41}, {'album_id': 11, 'role': 'editor'}])
def test_resource_admission_rejects_payload_scope_overrides(payload):
    service = Service()
    path = '/album-tops/{top_ref}/catalog/inventory'
    response = asyncio.run(endpoint(path, 'POST')(request(service, payload=payload), TOP))
    assert response.status_code == 422 and service.calls == []
    assert private_action_for_route('POST', path) == BROWSE
    assert csrf_mode_for_route('POST', path) == 'session_header'
