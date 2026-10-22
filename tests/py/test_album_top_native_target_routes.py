"""Saved Top native Details transport uses the existing private Browse boundary."""
import asyncio
from dataclasses import replace
from urllib.parse import urlencode

import pytest

from music_app.routes import owned_album_tops_asgi as routes
from music_app.services.current_actor import ActorState, CurrentActor
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import private_action_for_route
from music_app.services.private_ui_context import private_ui_context_ref
from tests.py.test_owned_album_top_route_boundary import (
    TOP, ITEM, BROWSE, Service, actor, request, decoded, middleware_app, asgi_response, mutation_headers,
)


PATH = f'/album-tops/{TOP}/items/{ITEM}/native-target'
QUERY = {'revision': '3', 'inventory_album_ref': 'inventory-album:73:501'}


@pytest.fixture
def resolver(monkeypatch):
    calls = []

    class Targets:
        def __init__(self, service):
            self.service = service

        def resolve(self, context, **options):
            calls.append((self.service, context, options))
            return {'native_target': {'album_ref': 'synthetic-native-key',
                'allowed_actions': {'can_view_details': True, 'can_play_album': False}}}

    monkeypatch.setattr(routes, 'AlbumTopNativeTargets', Targets)
    return calls


def target_request(service=None, **options):
    req = request(service or Service(), query=options.pop('query', QUERY), **options)
    req.scope.update(method='GET', path=PATH)
    return req


def test_route_passes_only_exact_context_bound_details_identity(resolver):
    service = Service()
    constraint_resolver = lambda _: PolicyEvaluationConstraints()
    req = target_request(service, constraints=constraint_resolver)
    response = routes.read_album_top_native_target(req, TOP, ITEM)
    assert response.status_code == 200
    assert decoded(response) == {'status': 'ready', 'context_ref': private_ui_context_ref(req),
        'data': {'native_target': {'album_ref': 'synthetic-native-key',
            'allowed_actions': {'can_view_details': True, 'can_play_album': False}}}}
    passed_service, context, options = resolver[0]
    assert passed_service is service and context.actor is req.state.current_actor
    assert context.action == BROWSE and context.library_id == 73
    assert options == {**QUERY, 'top_ref': TOP, 'item_ref': ITEM,
        'context_ref': private_ui_context_ref(req), 'constraints': constraint_resolver}
    assert private_action_for_route('GET', '/album-tops/{top_ref}/items/{item_ref}/native-target') == BROWSE
    assert any(route.path == '/album-tops/{top_ref}/items/{item_ref}/native-target'
               and 'GET' in route.methods for route in routes.router.routes)


@pytest.mark.parametrize('query', [{}, {'revision': '3'}, {'inventory_album_ref': QUERY['inventory_album_ref']},
    {**QUERY, 'intent': 'play'}, {**QUERY, 'album_ref': 'untrusted'},
    [*QUERY.items(), ('revision', '3')], [*QUERY.items(), ('revision', '4')],
    [*QUERY.items(), ('inventory_album_ref', QUERY['inventory_album_ref'])]])
def test_missing_extra_or_duplicate_query_is_rejected_before_resolver(resolver, query):
    response = routes.read_album_top_native_target(target_request(query=query), TOP, ITEM)
    assert response.status_code == 422 and decoded(response) == {'ok': False, 'error': 'invalid_query'}
    assert resolver == []


@pytest.mark.parametrize('header', [None, '', '0' * 63, '0' * 64, 'é' * 64])
def test_missing_malformed_or_stale_context_is_rejected_before_resolver(resolver, header):
    response = routes.read_album_top_native_target(target_request(context_header=header), TOP, ITEM)
    assert response.status_code == 409 and decoded(response) == {'ok': False, 'error': 'stale_context'}
    assert resolver == []


def test_duplicate_context_headers_cannot_be_folded_into_one_valid_witness(resolver):
    req = target_request()
    ref = private_ui_context_ref(req)
    req.scope['headers'].append((b'X-AlbumHaven-Context', ref.encode()))
    response = routes.read_album_top_native_target(req, TOP, ITEM)
    assert response.status_code == 409 and decoded(response) == {'ok': False, 'error': 'stale_context'}
    assert resolver == []


@pytest.mark.parametrize('field,value', [('account_id', 42), ('session_id', 9), ('current_library_id', 74)])
def test_context_from_another_actor_session_or_library_cannot_resolve(resolver, field, value):
    old = target_request()
    req = target_request(current_actor=replace(old.state.current_actor, **{field: value}),
                         context_header=private_ui_context_ref(old))
    response = routes.read_album_top_native_target(req, TOP, ITEM)
    assert response.status_code == 409 and decoded(response)['error'] == 'stale_context'
    assert resolver == []


@pytest.mark.parametrize('code,status', [('forbidden', 403), ('top_unavailable', 404),
    ('item_unavailable', 404), ('native_binding_changed', 409), ('revision_conflict', 409)])
def test_denials_return_only_private_error_envelope(monkeypatch, code, status):
    class Denied:
        def __init__(self, service):
            pass

        def resolve(self, *args, **kwargs):
            raise AlbumTopError(code, status)

    monkeypatch.setattr(routes, 'AlbumTopNativeTargets', Denied)
    response = routes.read_album_top_native_target(target_request(), TOP, ITEM)
    assert response.status_code == status
    assert decoded(response) == {'ok': False, 'error': code}


@pytest.mark.parametrize('field,value', [('revision', '01'), ('revision', '0'),
    ('inventory_album_ref', 'inventory-album:73:0'), ('inventory_album_ref', 'inventory-album:73:501\n')])
def test_real_service_validation_rejects_bad_query_values_without_database(field, value):
    response = routes.read_album_top_native_target(target_request(object(), query={**QUERY, field: value}), TOP, ITEM)
    assert response.status_code == 422 and decoded(response) == {'ok': False, 'error': 'invalid_command'}


@pytest.mark.parametrize('denial', ['anonymous', 'inactive', 'ungranted'])
def test_actual_asgi_boundary_denies_unauthorized_native_target_before_handler(resolver, denial):
    current = (CurrentActor.anonymous() if denial == 'anonymous' else
        replace(actor(), state=ActorState.INACTIVE) if denial == 'inactive' else
        replace(actor(), capability_grants=()))
    app = middleware_app(Service(), current)
    status, body, headers = asyncio.run(asgi_response(app, 'GET', PATH))
    assert status == (403 if denial == 'ungranted' else 401)
    assert body == {'detail': 'Action not permitted.' if denial == 'ungranted' else 'Authentication required.'}
    assert headers[b'cache-control'] == b'private, no-store'
    assert resolver == []


def test_actual_asgi_get_dispatches_exact_query_with_current_private_context(resolver):
    current = actor()
    app = middleware_app(Service(), current)

    async def with_query(scope, receive, send):
        await app({**scope, 'query_string': urlencode(QUERY).encode()}, receive, send)

    status, body, headers = asyncio.run(asgi_response(with_query, 'GET', PATH,
        headers=mutation_headers(app, current)))
    assert status == 200 and body['status'] == 'ready'
    assert headers[b'cache-control'] == b'private, no-store'
    assert len(resolver) == 1
    options = dict(resolver[0][2])
    assert isinstance(options.pop('constraints'), PolicyEvaluationConstraints)
    assert options == {**QUERY, 'top_ref': TOP, 'item_ref': ITEM,
                       'context_ref': body['context_ref']}
    assert body['data']['native_target'] == {'album_ref': 'synthetic-native-key',
        'allowed_actions': {'can_view_details': True, 'can_play_album': False}}
