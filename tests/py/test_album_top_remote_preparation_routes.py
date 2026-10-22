"""C2 private transport contracts through the real router and middleware.

The remote service is an explicit recorder, not a replacement SQL authority
test. These cases prove dispatch, bounded input, private perimeter, envelope and
request-lifetime contracts. Actual service/storage tests own transaction claims.
"""
import asyncio
from copy import deepcopy
from dataclasses import replace
import json
from threading import Event

import pytest
from starlette.requests import Request

from music_app.routes import owned_album_tops_asgi as routes
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.owned_album_tops import AlbumTopError, BROWSE, CREATE
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import csrf_mode_for_route, private_action_for_route
from music_app.services.private_ui_context import private_ui_context_ref
from tests.py.test_owned_album_top_route_boundary import (
    Service as TopService, actor, middleware_app, mutation_headers,
)


REQUEST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
DRAFT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
TOP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
PREPARATION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
GROUP = 'c9fdb94c-4975-4ed6-a96f-ef6d80bb7738'
BASE = '/album-top-catalog/remote-preparations'
MAINTAIN = BASE + '/maintain'
CLOSE = BASE + '/' + PREPARATION + '/close'
CLOSE_ROUTE = BASE + '/{preparation_ref}/close'
ACQUIRE = '/album-top-catalog/remote-acquisitions'
SEARCH = '/album-top-catalog/remote-search'
OPERATIONS = ('begin', 'status', 'maintain', 'close', 'acquire', 'search')
PREPARATION_OPERATIONS = ('begin', 'status', 'maintain', 'close')
POST_OPERATIONS = ('begin', 'maintain', 'close', 'acquire', 'search')


def endpoint(operation):
    return ('GET' if operation == 'status' else 'POST', {
        'begin': BASE, 'status': BASE, 'maintain': MAINTAIN, 'close': CLOSE,
        'acquire': ACQUIRE, 'search': SEARCH}[operation])


def payload_for(operation):
    destination = {'kind': 'create', 'draft_ref': DRAFT}
    return {'begin': {'destination': destination, 'form_ref': DRAFT},
        'status': None, 'maintain': {'mode': 'reclaim'}, 'close': {},
        'acquire': {'version': 2, 'preparation_ref': PREPARATION, 'request_key': REQUEST,
                    'destination': destination, 'release_group_id': GROUP},
        'search': {'destination': destination, 'title': 'Synthetic album', 'artist': ''}}[operation]


class RemoteService:
    """Record the real handler's call without pretending to execute authority."""
    def __init__(self, value=None, error=None):
        self.calls = []
        self.value = {'version': 2, 'state': 'ready'} if value is None else value
        self.error = error
        self.hook = None

    def _record(self, operation, context, options):
        self.calls.append((operation, context, options))
        if self.hook is not None:
            self.hook(operation, context, options)
        if self.error is not None:
            raise self.error
        return {**deepcopy(self.value), 'context_ref': options['context_ref']}

    def begin_preparation(self, context, *, payload, context_ref, constraints, should_cancel):
        return self._record('begin', context, dict(payload=payload, context_ref=context_ref,
            constraints=constraints, should_cancel=should_cancel))

    def preparation_status(self, context, *, context_ref, constraints, should_cancel):
        return self._record('status', context, dict(context_ref=context_ref,
            constraints=constraints, should_cancel=should_cancel))

    def maintain_preparations(self, context, *, payload, context_ref, constraints, should_cancel):
        return self._record('maintain', context, dict(payload=payload, context_ref=context_ref,
            constraints=constraints, should_cancel=should_cancel))

    def close_preparation(self, context, *, preparation_ref, payload, context_ref, constraints, should_cancel):
        return self._record('close', context, dict(preparation_ref=preparation_ref, payload=payload,
            context_ref=context_ref, constraints=constraints, should_cancel=should_cancel))

    def acquire(self, context, *, payload, context_ref, constraints, should_cancel):
        return self._record('acquire', context, dict(payload=payload, context_ref=context_ref,
            constraints=constraints, should_cancel=should_cancel))

    def search_candidates(self, context, *, destination, title, artist, context_ref, constraints, should_cancel):
        return self._record('search', context, dict(destination=destination, title=title, artist=artist,
            context_ref=context_ref, constraints=constraints, should_cancel=should_cancel))


def application(service, current=None):
    app = middleware_app(TopService(), actor() if current is None else current)
    app.state.album_top_remote_acquisition_service = service
    return app


async def response(app, method, path, *, headers=None, payload=None, raw=None, extra_headers=(),
                   query=b'', declared_length=None, chunks=None):
    """Actual ASGI request preserving duplicates and connection lifetime."""
    content = (b'' if payload is None else json.dumps(payload).encode()) if raw is None else raw
    pending = list(chunks) if chunks is not None else [content]
    finished = asyncio.Event()
    messages = []

    async def receive():
        if pending:
            return {'type': 'http.request', 'body': pending.pop(0), 'more_body': bool(pending)}
        await finished.wait()
        return {'type': 'http.disconnect'}

    async def send(message):
        messages.append(message)
        if message['type'] == 'http.response.body' and not message.get('more_body', False):
            finished.set()

    fields = {'host': 'music.test', 'content-type': 'application/json',
        'content-length': str(len(content)) if declared_length is None else declared_length, **(headers or {})}
    raw_headers = [(key.encode('ascii'), value.encode('latin1')) for key, value in fields.items()]
    raw_headers.extend(extra_headers)
    await app({'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
        'method': method, 'scheme': 'https', 'path': path, 'raw_path': path.encode(),
        'query_string': query, 'headers': raw_headers,
        'client': ('127.0.0.1', 50000), 'server': ('music.test', 443)}, receive, send)
    start = next(value for value in messages if value['type'] == 'http.response.start')
    data = b''.join(value.get('body', b'') for value in messages if value['type'] == 'http.response.body')
    return start['status'], json.loads(data) if data else None, dict(start['headers'])


def call(app, operation, **options):
    options.setdefault('payload', payload_for(operation))
    return asyncio.run(response(app, *endpoint(operation), **options))


def assert_private(result):
    assert result[2][b'cache-control'] == b'private, no-store'


def test_complete_router_policy_and_csrf_inventory_adds_only_explicit_preparation_methods():
    access = 'library.album_tops.access.manage'
    expected = {
        ('GET', '/album-tops'): BROWSE,
        ('GET', '/album-tops/public-link/{share_ref}'): BROWSE,
        ('HEAD', '/album-tops/public-link/{share_ref}'): BROWSE,
        ('GET', '/album-tops/edit-requests'): BROWSE,
        ('GET', '/album-tops/{top_ref}/sharing'): BROWSE,
        ('GET', '/album-tops/{top_ref}/access-grants'): access,
        ('GET', '/album-tops/{top_ref}/access-candidates'): access,
        ('GET', '/album-tops/{top_ref}'): BROWSE,
        ('POST', '/album-tops'): CREATE,
        ('POST', '/album-tops/{top_ref}/publication-preview'): access,
        ('GET', '/album-tops/{top_ref}/items/{item_ref}/publication-sources'): BROWSE,
        ('POST', '/album-tops/{top_ref}/catalog/inventory'): BROWSE,
        ('GET', '/album-top-catalog/search'): BROWSE,
        ('POST', '/album-tops/{top_ref}/{action}'): BROWSE,
        ('POST', '/album-top-catalog/inventory'): CREATE,
        ('POST', SEARCH): BROWSE, ('POST', ACQUIRE): BROWSE,
        ('GET', BASE): BROWSE, ('POST', BASE): BROWSE,
        ('POST', MAINTAIN): BROWSE, ('POST', CLOSE_ROUTE): BROWSE,
    }
    actual = {(method, route.path) for route in routes.router.routes for method in route.methods}
    assert actual == set(expected)
    for (method, path), action in expected.items():
        assert private_action_for_route(method, path) == action
        assert csrf_mode_for_route(method, path) == ('none' if method in {'GET', 'HEAD'} else 'session_header')
    for path in (BASE, MAINTAIN, CLOSE_ROUTE):
        for method in ('HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'):
            assert private_action_for_route(method, path) is None
        if path != BASE:
            assert private_action_for_route('GET', path) is None
        for alias in (path + '/', path.upper(), path + '/extra'):
            assert private_action_for_route('POST', alias) is None
            assert private_action_for_route('GET', alias) is None


@pytest.mark.parametrize('operation', OPERATIONS)
def test_real_handler_forwards_only_scoped_inputs_and_retires_cancellation_callback(operation):
    service = RemoteService()
    current = actor()
    app = application(service, current)
    resolver = lambda _: PolicyEvaluationConstraints()
    app.state.policy_constraint_resolver = resolver
    auth = mutation_headers(app, current)
    result = call(app, operation, headers=auth)
    assert_private(result)
    assert result[:2] == (200, {'status': 'ready', 'data': {
        'version': 2, 'state': 'ready', 'context_ref': auth['x-albumhaven-context']},
        'context_ref': auth['x-albumhaven-context']})
    assert len(service.calls) == 1
    recorded, context, options = service.calls[0]
    assert recorded == operation and context.actor is current
    assert context.library_id == current.current_library_id and context.action == BROWSE
    assert options['context_ref'] == auth['x-albumhaven-context'] and options['constraints'] is resolver
    assert callable(options['should_cancel']) and options['should_cancel']()
    expected = {'context_ref', 'constraints', 'should_cancel'}
    if operation == 'search':
        expected |= {'destination', 'title', 'artist'}
        assert {key: options[key] for key in ('destination', 'title', 'artist')} == payload_for(operation)
    elif operation != 'status':
        expected.add('payload')
        assert options['payload'] == payload_for(operation)
    if operation == 'close':
        expected.add('preparation_ref')
        assert options['preparation_ref'] == PREPARATION
    assert set(options) == expected and app.state.owned_album_tops_service.calls == []


@pytest.mark.parametrize('operation', OPERATIONS)
@pytest.mark.parametrize('failure', ['anonymous', 'inactive', 'browse'])
def test_actual_private_perimeter_denials_never_enter_remote_service(operation, failure):
    current = (CurrentActor.anonymous() if failure == 'anonymous' else
        replace(actor(), state=ActorState.INACTIVE) if failure == 'inactive' else
        replace(actor(), capability_grants=()))
    service = RemoteService()
    app = application(service, current)
    result = call(app, operation, headers=mutation_headers(app, actor()))
    assert_private(result)
    assert result[0] == (403 if failure == 'browse' else 401)
    assert service.calls == []


@pytest.mark.parametrize('operation', POST_OPERATIONS)
@pytest.mark.parametrize('failure', ['missing_header', 'missing_cookie', 'cross_origin', 'wrong_token'])
def test_every_new_post_requires_real_session_csrf_before_service(operation, failure):
    service = RemoteService()
    app = application(service)
    auth = mutation_headers(app, actor())
    if failure == 'missing_header':
        auth.pop('x-album-haven-csrf')
    elif failure == 'missing_cookie':
        auth['cookie'] = '__Host-album_haven_session=' + 's' * 43
    elif failure == 'cross_origin':
        auth['origin'] = 'https://other.test'
    else:
        auth['x-album-haven-csrf'] = 'invalid'
    result = call(app, operation, headers=auth)
    assert_private(result)
    assert result[0] == 403 and service.calls == []


def test_status_get_needs_context_but_no_mutation_csrf_and_calls_only_status():
    service = RemoteService(value={'version': 2, 'state': 'status', 'parents': [], 'capacity': {}})
    app = application(service)
    auth = mutation_headers(app, actor())
    auth.pop('x-album-haven-csrf')
    auth.pop('origin')
    auth['cookie'] = '__Host-album_haven_session=' + 's' * 43
    result = call(app, 'status', headers=auth)
    assert_private(result)
    assert result[0] == 200 and result[1]['data']['parents'] == []
    assert [item[0] for item in service.calls] == ['status']
    assert 'payload' not in service.calls[0][2]


@pytest.mark.parametrize('operation', PREPARATION_OPERATIONS)
def test_default_composition_reuses_existing_top_owner_and_user_agent(operation, monkeypatch):
    service = RemoteService()
    app = application(service)
    del app.state.album_top_remote_acquisition_service
    app.state.config['MUSICBRAINZ_USER_AGENT'] = 'AlbumHaven-Synthetic-Contract/1.0'
    constructions = []
    def factory(owner, *, user_agent):
        constructions.append((owner, user_agent))
        return service
    monkeypatch.setattr(routes, 'TopRemoteAcquisitionService', factory)
    result = call(app, operation, headers=mutation_headers(app, actor()))
    assert_private(result)
    assert result[0] == 200 and len(service.calls) == 1
    assert constructions == [(app.state.owned_album_tops_service, app.state.config['MUSICBRAINZ_USER_AGENT'])]


@pytest.mark.parametrize('operation', OPERATIONS)
@pytest.mark.parametrize('case', ['missing', 'empty', 'short', 'stale', 'nonascii',
    'same_duplicate', 'different_duplicate', 'mixed_case_duplicate', 'comma_joined'])
def test_context_requires_exactly_one_case_insensitive_raw_header(operation, case):
    service = RemoteService()
    app = application(service)
    auth = mutation_headers(app, actor())
    ref = auth['x-albumhaven-context']
    extra = []
    if case == 'missing':
        auth.pop('x-albumhaven-context')
    elif case in {'empty', 'short', 'stale', 'nonascii', 'comma_joined'}:
        auth['x-albumhaven-context'] = {'empty': '', 'short': ref[:-1], 'stale': '0' * 64,
            'nonascii': 'é' * 64, 'comma_joined': ref + ', ' + ref}[case]
    else:
        name = b'X-AlbumHaven-Context' if case == 'mixed_case_duplicate' else b'x-albumhaven-context'
        extra = [(name, ('0' * 64 if case == 'different_duplicate' else ref).encode())]
    result = call(app, operation, headers=auth, extra_headers=extra)
    assert_private(result)
    assert result[:2] == (409, {'ok': False, 'error': 'stale_context'})
    assert service.calls == []


@pytest.mark.parametrize('operation', PREPARATION_OPERATIONS)
@pytest.mark.parametrize('field,value', [('account_id', 42), ('session_id', 9), ('current_library_id', 74)])
def test_old_actor_session_or_library_header_cannot_access_preparations(operation, field, value):
    service = RemoteService()
    current = replace(actor(), **{field: value})
    if field == 'current_library_id':
        current = replace(current, library_relationships=(LibraryRelationship(value, 'member', False),),
            capability_grants=(CapabilityGrant('capability.view', 'library', value),))
    app = application(service, current)
    auth = mutation_headers(app, current)
    auth['x-albumhaven-context'] = mutation_headers(app, actor())['x-albumhaven-context']
    result = call(app, operation, headers=auth)
    assert_private(result)
    assert result[:2] == (409, {'ok': False, 'error': 'stale_context'})
    assert service.calls == []


@pytest.mark.parametrize('operation', OPERATIONS)
@pytest.mark.parametrize('query', [b'owner=41', b'mode=reclaim', b'preparation_ref=' + PREPARATION.encode(),
    b'limit=32&limit=32', b'&'])
def test_no_operation_accepts_query_authority_or_an_unparsed_query_string(operation, query):
    service = RemoteService()
    app = application(service)
    result = call(app, operation, headers=mutation_headers(app, actor()), query=query)
    assert_private(result)
    assert result[:2] == (422, {'ok': False, 'error': 'invalid_command'})
    assert service.calls == []


@pytest.mark.parametrize('operation', POST_OPERATIONS)
@pytest.mark.parametrize('case', ['missing', 'array', 'null', 'scalar', 'malformed', 'invalid_utf8',
    'extra_context', 'extra_actor', 'extra_state', 'declared_large', 'stream_large',
    'invalid_length', 'negative_length', 'length_mismatch'])
def test_exact_post_shapes_and_4096_byte_bound_fail_before_service(operation, case):
    service = RemoteService()
    app = application(service)
    options = {}
    payload = payload_for(operation)
    expected = (422, 'invalid_command')
    raw_cases = {'missing': b'', 'array': b'[]', 'null': b'null', 'scalar': b'1',
        'malformed': b'{', 'invalid_utf8': b'\xff'}
    if case in raw_cases:
        options['raw'] = raw_cases[case]
    elif case.startswith('extra_'):
        payload[{'extra_context': 'context_ref', 'extra_actor': 'actor_account_id',
                 'extra_state': 'state'}[case]] = 'untrusted'
    elif case == 'declared_large':
        options['declared_length'] = '4097'
        expected = (413, 'command_too_large')
    elif case == 'stream_large':
        # A nonoversized declaration must not hide actual excess streamed bytes.
        options.update(raw=b' ' * 4097, declared_length='4096', chunks=[b' ' * 4096, b' '])
        expected = (413, 'command_too_large')
    else:
        options['declared_length'] = {'invalid_length': 'invalid', 'negative_length': '-1',
                                      'length_mismatch': '1'}[case]
    result = call(app, operation, headers=mutation_headers(app, actor()), payload=payload, **options)
    assert_private(result)
    assert result[:2] == (expected[0], {'ok': False, 'error': expected[1]})
    assert service.calls == []


@pytest.mark.parametrize('operation', POST_OPERATIONS)
def test_exact_4096_byte_body_is_accepted_without_changing_payload(operation):
    service = RemoteService()
    app = application(service)
    raw = json.dumps(payload_for(operation)).encode()
    result = call(app, operation, headers=mutation_headers(app, actor()),
                  raw=raw + b' ' * (4096 - len(raw)), declared_length='4096')
    assert_private(result)
    assert result[0] == 200 and len(service.calls) == 1


@pytest.mark.parametrize('mode', ['reclaim', 'discard_legacy'])
def test_maintenance_mode_is_forwarded_exactly_without_added_target_or_limit(mode):
    service = RemoteService()
    app = application(service)
    result = call(app, 'maintain', headers=mutation_headers(app, actor()), payload={'mode': mode})
    assert_private(result)
    assert result[0] == 200 and len(service.calls) == 1
    assert service.calls[0][2]['payload'] == {'mode': mode}


@pytest.mark.parametrize('field', ['destination', 'form_ref'])
def test_begin_requires_each_field_and_never_accepts_an_insertion_uuid(field):
    service = RemoteService()
    app = application(service)
    payload = payload_for('begin')
    payload.pop(field)
    result = call(app, 'begin', headers=mutation_headers(app, actor()), payload=payload)
    assert result[:2] == (422, {'ok': False, 'error': 'invalid_command'})
    assert_private(result)
    payload = {**payload_for('begin'), 'preparation_ref': PREPARATION}
    result = call(app, 'begin', headers=mutation_headers(app, actor()), payload=payload)
    assert result[:2] == (422, {'ok': False, 'error': 'invalid_command'})
    assert_private(result)
    assert service.calls == []


@pytest.mark.parametrize('version', [None, True, False, 1, 3, 2.0, '2', [], {}])
def test_acquire_dispatch_requires_exact_integer_v2_discriminator(version):
    service = RemoteService()
    app = application(service)
    result = call(app, 'acquire', headers=mutation_headers(app, actor()),
                  payload={**payload_for('acquire'), 'version': version})
    assert_private(result)
    assert result[:2] == (422, {'ok': False, 'error': 'invalid_command'})
    assert service.calls == []


@pytest.mark.parametrize('removed', ['version', 'preparation_ref'])
def test_incomplete_v2_acquire_cannot_fall_back_to_legacy(removed):
    service = RemoteService()
    app = application(service)
    payload = payload_for('acquire')
    payload.pop(removed)
    result = call(app, 'acquire', headers=mutation_headers(app, actor()), payload=payload)
    assert_private(result)
    assert result[:2] == (422, {'ok': False, 'error': 'invalid_command'})
    assert service.calls == []


@pytest.mark.parametrize('error', [None, AlbumTopError('remote_acquisition_version_required', 409)])
def test_exact_legacy_triple_reaches_same_service_for_replay_or_fresh_v1_refusal(error):
    service = RemoteService(value={'acquisition_ref': PREPARATION, 'request_key': REQUEST}, error=error)
    app = application(service)
    legacy = {key: value for key, value in payload_for('acquire').items()
              if key not in {'version', 'preparation_ref'}}
    result = call(app, 'acquire', headers=mutation_headers(app, actor()), payload=legacy)
    assert_private(result)
    assert len(service.calls) == 1 and service.calls[0][2]['payload'] == legacy
    if error is None:
        assert result[0] == 200 and 'version' not in result[1]['data']
    else:
        assert result[:2] == (409, {'ok': False, 'error': 'remote_acquisition_version_required'})


@pytest.mark.parametrize('operation', ('begin', 'status', 'maintain', 'close', 'acquire'))
@pytest.mark.parametrize('state,status', [('ready', 200), ('status', 200), ('closed', 200),
    ('progress', 200), ('complete', 200), ('pending', 200), ('in_flight', 202),
    ('failed', 503), ('maintenance_required', 409), ('limit', 429)])
def test_state_http_mapping_preserves_service_projection_and_private_envelope(operation, state, status):
    value = {'version': 2, 'state': state, 'capacity': {'attempt_slots_remaining': 0}}
    if state == 'in_flight':
        value['retry_after_seconds'] = 1
    elif state == 'failed':
        value['error'] = 'provider_unavailable'
    service = RemoteService(value=value)
    app = application(service)
    auth = mutation_headers(app, actor())
    result = call(app, operation, headers=auth)
    assert_private(result)
    assert result[:2] == (status, {'status': 'ready', 'data': {
        **value, 'context_ref': auth['x-albumhaven-context']}, 'context_ref': auth['x-albumhaven-context']})
    assert len(service.calls) == 1


@pytest.mark.parametrize('operation', OPERATIONS)
@pytest.mark.parametrize('code,status', [('forbidden', 403), ('top_unavailable', 404),
    ('request_key_conflict', 409), ('revision_conflict', 409),
    ('remote_preparation_unavailable', 409), ('remote_preparation_maintenance_required', 409),
    ('remote_acquisition_version_required', 409), ('remote_acquisition_limit', 429),
    ('provider_cancelled', 503), ('provider_unavailable', 503)])
def test_domain_denials_keep_exact_error_without_wrapping_as_success(operation, code, status):
    service = RemoteService(error=AlbumTopError(code, status))
    app = application(service)
    result = call(app, operation, headers=mutation_headers(app, actor()))
    assert_private(result)
    assert result[:2] == (status, {'ok': False, 'error': code})
    assert len(service.calls) == 1 and service.calls[0][2]['should_cancel']()


@pytest.mark.parametrize('operation', OPERATIONS)
@pytest.mark.parametrize('stage', ['service', 'actor_resolver'])
def test_unexpected_handler_or_early_perimeter_failure_is_bounded_private_503(operation, stage):
    error = RuntimeError('Private provider URL, database SQL and account identifiers must not escape')
    service = RemoteService(error=error if stage == 'service' else None)
    app = application(service)
    if stage == 'actor_resolver':
        def fail(_):
            raise error
        app.state.current_actor_resolver.resolve = fail
    result = call(app, operation, headers=mutation_headers(app, actor()))
    assert_private(result)
    assert result[:2] == (503, {'ok': False, 'error': 'remote_acquisition_unavailable'})
    assert len(service.calls) == (1 if stage == 'service' else 0)


@pytest.mark.parametrize('method,path', [
    ('HEAD', BASE), ('PUT', BASE), ('PATCH', BASE), ('DELETE', BASE),
    ('GET', MAINTAIN), ('HEAD', MAINTAIN), ('PUT', MAINTAIN),
    ('GET', CLOSE), ('HEAD', CLOSE), ('DELETE', CLOSE),
    ('POST', BASE + '/'), ('GET', BASE + '/'),
    ('POST', MAINTAIN + '/'), ('POST', CLOSE + '/'),
    ('POST', BASE + '/extra'), ('POST', BASE + '/maintain/extra'),
    ('POST', BASE + '/close'), ('POST', '/album-top-catalog/REMOTE-PREPARATIONS')])
def test_unregistered_methods_and_aliases_never_call_remote_service(method, path):
    service = RemoteService()
    app = application(service)
    result = asyncio.run(response(app, method, path, headers=mutation_headers(app, actor()), payload={}))
    assert_private(result)
    # No exact method/path policy entry means the private boundary evaluates
    # app.access first. This Browse-only actor is denied before framework
    # method-not-allowed, missing-route or slash-redirect behavior can run.
    assert result[:2] == (403, {'detail': 'Action not permitted.'})
    assert service.calls == []


@pytest.mark.parametrize('ref', ['not-a-uuid', PREPARATION.upper(), PREPARATION.replace('-', '')])
def test_close_rejects_malformed_path_identity_before_service(ref):
    service = RemoteService()
    app = application(service)
    result = asyncio.run(response(app, 'POST', BASE + '/' + ref + '/close',
        headers=mutation_headers(app, actor()), payload={}))
    assert_private(result)
    assert result[:2] == (422, {'ok': False, 'error': 'invalid_command'})
    assert service.calls == []


def direct_request(app, operation):
    method, path = endpoint(operation)
    payload = payload_for(operation)
    content = b'' if payload is None else json.dumps(payload).encode()
    consumed = False
    async def receive():
        nonlocal consumed
        if not consumed:
            consumed = True
            return {'type': 'http.request', 'body': content, 'more_body': False}
        await asyncio.sleep(60)
        return {'type': 'http.disconnect'}
    fields = {'host': 'music.test', 'content-type': 'application/json',
              'content-length': str(len(content)), **mutation_headers(app, actor())}
    return Request({'type': 'http', 'method': method, 'path': path, 'raw_path': path.encode(),
        'scheme': 'https', 'app': app, 'query_string': b'', 'state': {'current_actor': actor()},
        'headers': [(key.encode(), value.encode()) for key, value in fields.items()],
        'client': ('127.0.0.1', 50000), 'server': ('music.test', 443)}, receive)


async def invoke_direct(operation, request):
    if operation == 'close':
        return await routes.close_album_top_remote_preparation(request, PREPARATION)
    handler = {'begin': routes.begin_album_top_remote_preparation,
        'status': routes.read_album_top_remote_preparations,
        'maintain': routes.maintain_album_top_remote_preparations,
        'acquire': routes.acquire_album_top_remote, 'search': routes.search_album_top_remote}[operation]
    return await handler(request)


def assert_watcher_retired():
    assert not [task for task in asyncio.all_tasks() if not task.done()
        and getattr(task.get_coro(), '__name__', '') == '_watch_remote_disconnect']


@pytest.mark.parametrize('operation', OPERATIONS)
@pytest.mark.parametrize('replacement', ['account_id', 'session_id', 'current_library_id', 'duplicate_header'])
def test_post_service_context_recheck_never_rewraps_completed_data_in_changed_scope(operation, replacement):
    service = RemoteService()
    app = application(service)
    req = direct_request(app, operation)
    original = private_ui_context_ref(req)
    def change(*_):
        if replacement == 'duplicate_header':
            req.scope['headers'].append((b'X-AlbumHaven-Context', original.encode()))
        else:
            setattr(req.state, 'current_actor', replace(req.state.current_actor,
                **{replacement: getattr(req.state.current_actor, replacement) + 1}))
    service.hook = change
    async def run():
        result = await invoke_direct(operation, req)
        assert_watcher_retired()
        return result
    result = asyncio.run(run())
    assert result.status_code == 409 and json.loads(result.body) == {'ok': False, 'error': 'stale_context'}
    assert result.headers['cache-control'] == 'private, no-store'
    assert len(service.calls) == 1 and service.calls[0][2]['context_ref'] == original
    assert service.calls[0][2]['should_cancel']()
    # The service may already have committed. A late transport refusal proves
    # response retirement, not rollback of an acknowledged server transaction.


@pytest.mark.parametrize('operation', OPERATIONS)
@pytest.mark.parametrize('failure', ['disconnect', 'observer_error'])
def test_actual_disconnect_watcher_retires_response_and_callback(operation, failure):
    service = RemoteService()
    app = application(service)
    req = direct_request(app, operation)
    observed = Event()
    async def disconnected():
        observed.set()
        if failure == 'observer_error':
            raise RuntimeError('Observer failed')
        return True
    req.is_disconnected = disconnected
    def await_cancel(_, context, options):
        for _ in range(500):
            if options['should_cancel']():
                return
            Event().wait(0.01)
        raise AssertionError('Real disconnect observer did not retire callback')
    service.hook = await_cancel
    async def run():
        result = await invoke_direct(operation, req)
        assert_watcher_retired()
        return result
    result = asyncio.run(run())
    assert observed.is_set() and len(service.calls) == 1
    assert result.status_code == 503 and json.loads(result.body) == {'ok': False, 'error': 'provider_cancelled'}
    assert result.headers['cache-control'] == 'private, no-store'
    assert service.calls[0][2]['should_cancel']()


@pytest.mark.parametrize('operation', OPERATIONS)
def test_task_cancellation_propagates_and_retires_watcher_without_abandoning_fixture_worker(operation):
    service = RemoteService()
    app = application(service)
    req = direct_request(app, operation)
    entered, release, completed = Event(), Event(), Event()
    def blocked(_, context, options):
        entered.set()
        assert release.wait(5), 'Cancellation fixture failed to release worker'
    service.hook = blocked
    original = service._record
    def observed_operation(*args, **options):
        try:
            return original(*args, **options)
        finally:
            completed.set()
    service._record = observed_operation
    async def run():
        task = asyncio.create_task(invoke_direct(operation, req))
        try:
            for _ in range(500):
                if entered.is_set():
                    break
                await asyncio.sleep(0.01)
            assert entered.is_set()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert_watcher_retired()
            assert service.calls[0][2]['should_cancel']()
        finally:
            release.set()
            if not task.done():
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
            assert await asyncio.to_thread(completed.wait, 5)
    asyncio.run(run())


@pytest.mark.parametrize('operation', OPERATIONS)
def test_service_cancelled_error_is_never_converted_to_json_success_or_error(operation):
    service = RemoteService(error=asyncio.CancelledError())
    app = application(service)
    req = direct_request(app, operation)
    async def run():
        with pytest.raises(asyncio.CancelledError):
            await invoke_direct(operation, req)
        assert_watcher_retired()
    asyncio.run(run())
    assert len(service.calls) == 1 and service.calls[0][2]['should_cancel']()


@pytest.mark.parametrize('operation', PREPARATION_OPERATIONS)
def test_nonexception_baseexception_also_propagates_and_retires_watcher(operation):
    class StopOperation(BaseException):
        pass
    service = RemoteService(error=StopOperation())
    app = application(service)
    req = direct_request(app, operation)
    async def run():
        with pytest.raises(StopOperation):
            await invoke_direct(operation, req)
        assert_watcher_retired()
    asyncio.run(run())
    assert len(service.calls) == 1 and service.calls[0][2]['should_cancel']()


def test_preparation_routes_do_not_forward_context_to_generic_membership_or_read_owner():
    remote = RemoteService()
    app = application(remote)
    top = app.state.owned_album_tops_service
    auth = mutation_headers(app, actor())
    # The established generic recorder's execute signature accepts constraints
    # only. Forwarding context_ref would fail rather than pretending activation.
    created = asyncio.run(response(app, 'POST', '/album-tops', headers=auth,
        payload={'request_key': REQUEST, 'title': 'Local Top', 'album_refs': []}))
    assert_private(created)
    assert created[0] == 200 and len(top.calls) == 1 and top.calls[0][0] == 'execute'
    read = asyncio.run(response(app, 'GET', '/album-tops/' + TOP, headers=auth))
    assert_private(read)
    assert read[0] == 200 and top.calls[-1][0] == 'read'
    assert 'context_ref' not in top.calls[-1][2]
    assert remote.calls == []
