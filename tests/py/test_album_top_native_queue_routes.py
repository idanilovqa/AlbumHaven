"""Top native playback POSTs retain Browse, CSRF and private-context boundaries."""
import asyncio
from dataclasses import replace
from types import SimpleNamespace

import pytest

from music_app.routes import owned_album_tops_asgi as routes
from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.current_actor import ActorState, CurrentActor
from music_app.services.owned_album_tops import AlbumTopError, MAX_TOP_COMMAND_BYTES
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import private_action_for_route, csrf_mode_for_route
from music_app.services.private_ui_context import private_ui_context_ref
from tests.py.test_owned_album_top_route_boundary import (
    TOP, ITEM, ALBUM, BROWSE, Service, actor, request, decoded, middleware_app, asgi_response, mutation_headers,
)


SOURCE = {'revision': '3', 'item_ref': ITEM, 'catalog_ref': ALBUM,
    'inventory_album_ref': 'inventory-album:73:501',
    'inventory_track_ref': 'inventory-track:73:701', 'canonical_track_ref': 'canonical-701'}
PAYLOADS = {'capture': {'revision': '3'}, 'resolve': SOURCE}
PATTERNS = {'capture': '/album-tops/{top_ref}/native-queue',
            'resolve': '/album-tops/{top_ref}/native-playback-target'}


def invoke(operation, req):
    method = routes.capture_album_top_native_queue if operation == 'capture' else routes.resolve_album_top_native_playback
    return asyncio.run(method(req, TOP))


def native_request(operation, service=None, **options):
    options.setdefault('payload', PAYLOADS[operation])
    req = request(service or Service(), **options)
    req.scope.update(method='POST', path=PATTERNS[operation].format(top_ref=TOP))
    return req


@pytest.fixture
def resolver(monkeypatch):
    calls = []

    class Queue:
        def __init__(self, service):
            self.service = service

        def capture(self, context, **options):
            calls.append(('capture', self.service, context, options))
            return {'top_ref': TOP, 'revision': '3', 'albums': [], 'unavailable_items': []}

        def resolve(self, context, **options):
            calls.append(('resolve', self.service, context, options))
            return {'top_ref': TOP, 'source': dict(SOURCE), 'native_target': {'track_ref': '/synthetic/701.flac'}}

    monkeypatch.setattr(routes, 'AlbumTopNativeQueue', Queue)
    return calls


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
def test_handler_forwards_only_exact_payload_and_current_authenticated_context(resolver, operation):
    service = Service()
    constraints = lambda _: PolicyEvaluationConstraints()
    req = native_request(operation, service, constraints=constraints)
    response = invoke(operation, req)
    assert response.status_code == 200 and response.headers['cache-control'] == 'private, no-store'
    assert decoded(response)['context_ref'] == private_ui_context_ref(req)
    action, passed_service, context, options = resolver[0]
    assert action == operation and passed_service is service
    assert context.actor is req.state.current_actor and context.library_id == 73 and context.action == BROWSE
    assert options == {'top_ref': TOP, 'payload': PAYLOADS[operation],
                       'context_ref': private_ui_context_ref(req), 'constraints': constraints}
    assert service.calls == []
    assert private_action_for_route('POST', PATTERNS[operation]) == BROWSE
    assert csrf_mode_for_route('POST', PATTERNS[operation]) == 'session_header'
    assert any(route.path == PATTERNS[operation] and route.methods == {'POST'} for route in routes.router.routes)


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
@pytest.mark.parametrize('header', [None, '', '0' * 63, '0' * 64, 'é' * 64])
def test_missing_malformed_or_stale_context_blocks_service(resolver, operation, header):
    response = invoke(operation, native_request(operation, context_header=header))
    assert response.status_code == 409 and decoded(response) == {'ok': False, 'error': 'stale_context'}
    assert response.headers['cache-control'] == 'private, no-store' and resolver == []


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
def test_duplicate_context_header_cannot_be_folded_into_one_witness(resolver, operation):
    req = native_request(operation)
    req.scope['headers'].append((b'X-AlbumHaven-Context', private_ui_context_ref(req).encode()))
    response = invoke(operation, req)
    assert response.status_code == 409 and decoded(response)['error'] == 'stale_context'
    assert resolver == []


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
@pytest.mark.parametrize('field,value', [('account_id', 42), ('session_id', 9), ('current_library_id', 74)])
def test_context_from_another_caller_session_or_library_cannot_resolve(resolver, operation, field, value):
    old = native_request(operation)
    req = native_request(operation, current_actor=replace(old.state.current_actor, **{field: value}),
                         context_header=private_ui_context_ref(old))
    response = invoke(operation, req)
    assert response.status_code == 409 and decoded(response)['error'] == 'stale_context'
    assert resolver == []


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
@pytest.mark.parametrize('field,value', [('account_id', 42), ('session_id', 9), ('current_library_id', 74)])
def test_context_change_after_threaded_resolution_discards_private_target(monkeypatch, operation, field, value):
    req = native_request(operation)
    calls = []

    class Changed:
        def __init__(self, service):
            pass

        def capture(self, *args, **kwargs):
            calls.append(kwargs)
            req.state.current_actor = replace(req.state.current_actor, **{field: value})
            return {'native_target': {'path': '/synthetic/private/forbidden.flac'}}

        resolve = capture

    monkeypatch.setattr(routes, 'AlbumTopNativeQueue', Changed)
    response = invoke(operation, req)
    assert calls and response.status_code == 409
    assert decoded(response) == {'ok': False, 'error': 'stale_context'}
    assert response.headers['cache-control'] == 'private, no-store'


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
@pytest.mark.parametrize('query', [{'revision': '3'}, {'intent': 'play'}, {'account_id': '999'}, {'native_target': '/untrusted'}])
def test_query_cannot_override_body_or_authenticated_scope(resolver, operation, query):
    response = invoke(operation, native_request(operation, query=query))
    assert response.status_code == 422 and decoded(response) == {'ok': False, 'error': 'invalid_command'}
    assert resolver == []


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
@pytest.mark.parametrize('raw', [b'{', b'[]', b'null', b'1', b'"text"', b'\xff'])
def test_real_service_rejects_nonobject_or_malformed_body_before_database(operation, raw):
    response = invoke(operation, native_request(operation, SimpleNamespace(_config={}), raw=raw))
    assert response.status_code == 422 and decoded(response) == {'ok': False, 'error': 'invalid_command'}
    assert response.headers['cache-control'] == 'private, no-store'


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
@pytest.mark.parametrize('extra', ['account_id', 'library_id', 'path', 'native_target', 'intent', 'top_ref', 'request_key'])
def test_exact_command_contract_rejects_browser_identity_or_authority_fields(operation, extra):
    payload = {**PAYLOADS[operation], extra: 'untrusted'}
    response = invoke(operation, native_request(operation, SimpleNamespace(_config={}), payload=payload))
    assert response.status_code == 422 and decoded(response) == {'ok': False, 'error': 'invalid_command'}


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
@pytest.mark.parametrize('case', ['declared_large', 'stream_large', 'invalid_length', 'negative_length', 'length_mismatch'])
def test_body_bound_rejects_declared_and_streamed_overflow(operation, case):
    headers, chunks, status = {}, None, 422
    if case == 'declared_large':
        headers['content-length'] = str(MAX_TOP_COMMAND_BYTES + 1)
        status = 413
    elif case == 'stream_large':
        chunks = [b' ' * MAX_TOP_COMMAND_BYTES, b' ']
        status = 413
    else:
        headers['content-length'] = {'invalid_length': 'oops', 'negative_length': '-1', 'length_mismatch': '3'}[case]
    # The otherwise valid body would reach the absent transaction seam if its
    # invalid length were ignored. No database-shaped substitute can accept it.
    service = SimpleNamespace(_config={})
    response = invoke(operation, native_request(operation, service, headers=headers, chunks=chunks))
    assert response.status_code == status
    assert decoded(response) == {'ok': False, 'error': 'command_too_large' if status == 413 else 'invalid_command'}
    assert response.headers['cache-control'] == 'private, no-store'


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
@pytest.mark.parametrize('code,status', [('forbidden', 403), ('top_unavailable', 404), ('item_unavailable', 404),
    ('native_binding_changed', 409), ('revision_conflict', 409), ('queue_too_large', 422)])
def test_service_denials_return_only_bounded_private_error(monkeypatch, operation, code, status):
    class Denied:
        def __init__(self, service):
            pass

        def capture(self, *args, **kwargs):
            raise AlbumTopError(code, status)

        resolve = capture

    monkeypatch.setattr(routes, 'AlbumTopNativeQueue', Denied)
    response = invoke(operation, native_request(operation))
    assert response.status_code == status and decoded(response) == {'ok': False, 'error': code}
    assert response.headers['cache-control'] == 'private, no-store'


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
@pytest.mark.parametrize('denial', ['anonymous', 'inactive', 'ungranted'])
def test_real_asgi_auth_and_browse_boundary_denies_before_handler(resolver, operation, denial):
    current = (CurrentActor.anonymous() if denial == 'anonymous' else
        replace(actor(), state=ActorState.INACTIVE) if denial == 'inactive' else replace(actor(), capability_grants=()))
    app = middleware_app(Service(), current)
    status, body, headers = asyncio.run(asgi_response(app, 'POST', PATTERNS[operation].format(top_ref=TOP),
                                                     payload=PAYLOADS[operation]))
    assert status == (403 if denial == 'ungranted' else 401)
    assert body == {'detail': 'Action not permitted.' if denial == 'ungranted' else 'Authentication required.'}
    assert headers[b'cache-control'] == b'private, no-store' and resolver == []


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
@pytest.mark.parametrize('invalid', ['missing_header', 'missing_cookie', 'cross_origin', 'different_session'])
def test_real_asgi_csrf_rejects_untrusted_post_before_service(resolver, operation, invalid):
    current = actor()
    app = middleware_app(Service(), current)
    headers = mutation_headers(app, current)
    if invalid == 'missing_header':
        del headers['x-album-haven-csrf']
    elif invalid == 'missing_cookie':
        headers['cookie'] = '__Host-album_haven_session=' + 's' * 43
    elif invalid == 'cross_origin':
        headers['origin'] = 'https://attacker.test'
    else:
        other = issue_session_csrf('A' * 43, app.state.auth_policy_config)
        headers['cookie'] = f"__Host-album_haven_session={'s' * 43}; __Host-album_haven_csrf={other}"
        headers['x-album-haven-csrf'] = other
    status, body, response_headers = asyncio.run(asgi_response(app, 'POST', PATTERNS[operation].format(top_ref=TOP),
                                                              headers=headers, payload=PAYLOADS[operation]))
    assert status == 403 and body == {'detail': 'CSRF validation failed.'}
    assert response_headers[b'cache-control'] == b'private, no-store' and resolver == []


@pytest.mark.parametrize('operation', ['capture', 'resolve'])
def test_real_asgi_post_selects_specific_route_before_generic_mutation(resolver, operation):
    current = actor()
    service = Service()
    app = middleware_app(service, current)
    status, body, headers = asyncio.run(asgi_response(app, 'POST', PATTERNS[operation].format(top_ref=TOP),
        headers=mutation_headers(app, current), payload=PAYLOADS[operation]))
    assert status == 200 and body['status'] == 'ready'
    assert headers[b'cache-control'] == b'private, no-store'
    assert len(resolver) == 1 and resolver[0][0] == operation and service.calls == []
    options = dict(resolver[0][3])
    assert isinstance(options.pop('constraints'), PolicyEvaluationConstraints)
    assert options == {'top_ref': TOP, 'payload': PAYLOADS[operation], 'context_ref': body['context_ref']}
