"""Generic Top route context forwarding; source-authored, normal imports only.

These contracts exercise the existing handlers and middleware with a service
double. They do not establish SQL behavior, browser acceptance, or publication.
"""
import asyncio
from dataclasses import replace

import pytest

from music_app.routes import owned_album_tops_asgi as routes
from music_app.services.owned_album_tops import AlbumTopError, BROWSE, CREATE, MAX_TOP_COMMAND_BYTES
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_ui_context import private_ui_context_ref
from tests.py.test_owned_album_top_route_boundary import (
    ALBUM, ITEM, REQUEST, TOP, actor, asgi_response, decoded,
    middleware_app, mutation_headers, request,
)


DRAFT = '11111111-1111-4111-8111-111111111111'
ACQUISITION = '22222222-2222-4222-8222-222222222222'
ADMISSION = '33333333-3333-4333-8333-333333333333'
LOCAL = {'kind': 'local_catalog', 'album_ref': ALBUM}
PENDING = {'kind': 'remote_acquisition', 'acquisition_ref': ACQUISITION,
           'evidence_version': 'a' * 64}
RETAINED = {'kind': 'remote_retained', 'admission_ref': ADMISSION,
            'evidence_version': 'b' * 64}


class ContextService:
    """The keyword is required so dropping it cannot quietly pass these tests."""

    def __init__(self, error=None):
        self.calls = []
        self.error = error

    def execute(self, context, command, *, context_ref, constraints=None):
        self.calls.append(('execute', context, command, context_ref, constraints))
        if self.error is not None:
            raise self.error
        return {'top_ref': TOP, 'revision': '2', 'request_key': command.request_key,
                'action': command.action}

    def read(self, context, *, top_ref, context_ref, constraints=None):
        self.calls.append(('read', context, top_ref, context_ref, constraints))
        if self.error is not None:
            raise self.error
        return {'top_ref': top_ref, 'revision': '1', 'items': [],
                'edit_draft': {'item_selections': [
                    {'kind': 'existing', 'item_ref': ITEM, 'album_ref': ALBUM,
                     'source': dict(RETAINED)},
                ]}}


def body(action, changes):
    return {'request_key': REQUEST, **({'revision': '1'} if action != 'create' else {}), **changes}


def mutate(req, action):
    return asyncio.run(routes.create_album_top(req) if action == 'create'
                       else routes.mutate_album_top(req, TOP, action))


@pytest.mark.parametrize('action,changes', [
    ('create', {'title': '  Mixed Top  ', 'draft_ref': DRAFT, 'selections': [LOCAL, PENDING]}),
    ('add', {'selections': [LOCAL, PENDING]}),
    ('add', {'selections': [RETAINED]}),
    ('save', {'item_selections': [
        {'kind': 'existing', 'item_ref': ITEM, 'album_ref': ALBUM, 'source': RETAINED},
        {'kind': 'new_remote', 'source': PENDING},
    ]}),
    ('copy', {}), ('remove', {'item_refs': [ITEM]}), ('reorder', {'item_order': [ITEM]}),
    ('enable_external', {'evidence_revision': 'c' * 64}),
    ('create', {'title': 'Local Top', 'album_refs': [ALBUM]}),
    ('save', {'title': 'Local edit'}), ('add', {'album_refs': [ALBUM]}),
])
def test_generic_mutations_forward_validated_server_context_without_wire_field(action, changes):
    service = ContextService()
    resolver = lambda _: PolicyEvaluationConstraints()
    req = request(service, payload=body(action, changes), constraints=resolver)
    expected = private_ui_context_ref(req)

    response = mutate(req, action)

    assert response.status_code == 200
    assert decoded(response)['context_ref'] == expected
    assert len(service.calls) == 1
    operation, context, command, context_ref, constraints = service.calls[0]
    assert operation == 'execute' and context_ref == expected
    assert context.actor is req.state.current_actor and context.library_id == 73
    assert context.action == (CREATE if action == 'create' else BROWSE)
    assert constraints is resolver
    assert command.action == action and command.request_key == REQUEST
    assert command.top_ref == (None if action == 'create' else TOP)
    assert 'context_ref' not in command.data
    if 'selections' in changes:
        assert command.data['selections'] == changes['selections']
    if 'item_selections' in changes:
        assert command.data['item_selections'] == changes['item_selections']
    if action == 'create':
        assert command.data['title'] == changes['title'].strip()


@pytest.mark.parametrize('header', [None, '', '0' * 64])
def test_working_read_derives_context_without_requiring_or_trusting_mutation_header(header):
    service = ContextService()
    resolver = lambda _: PolicyEvaluationConstraints()
    req = request(service, context_header=header, constraints=resolver)
    expected = private_ui_context_ref(req)

    response = routes.read_album_top(req, TOP)

    assert response.status_code == 200
    assert decoded(response)['context_ref'] == expected
    assert decoded(response)['data']['edit_draft']['item_selections'][0]['source'] == RETAINED
    operation, context, ref, forwarded, constraints = service.calls[0]
    assert operation == 'read' and ref == TOP and forwarded == expected
    assert context.actor is req.state.current_actor and context.action == BROWSE
    assert constraints is resolver


@pytest.mark.parametrize('header', [None, '', '0' * 63, '0' * 64, 'e' * 65, 'é' * 64])
@pytest.mark.parametrize('action', ['create', 'add', 'save', 'copy'])
def test_context_denials_happen_before_generic_execute(header, action):
    service = ContextService()
    req = request(service, payload={}, context_header=header)
    response = mutate(req, action)
    assert response.status_code == 409
    assert decoded(response) == {'ok': False, 'error': 'stale_context'}
    assert service.calls == []


@pytest.mark.parametrize('duplicate_name', [b'x-albumhaven-context', b'X-AlbumHaven-Context'])
def test_duplicate_context_headers_never_reach_generic_execute(duplicate_name):
    service = ContextService()
    req = request(service, payload=body('copy', {}))
    req.scope['headers'].append((duplicate_name, private_ui_context_ref(req).encode('ascii')))
    response = mutate(req, 'copy')
    assert response.status_code == 409 and decoded(response)['error'] == 'stale_context'
    assert service.calls == []


@pytest.mark.parametrize('field,value', [('account_id', 42), ('session_id', 9), ('current_library_id', 74)])
def test_context_from_another_actor_session_or_library_is_never_forwarded(field, value):
    service = ContextService()
    old = request(service)
    req = request(service, payload=body('copy', {}),
                  current_actor=replace(old.state.current_actor, **{field: value}),
                  context_header=private_ui_context_ref(old))
    response = mutate(req, 'copy')
    assert response.status_code == 409 and decoded(response)['error'] == 'stale_context'
    assert service.calls == []


@pytest.mark.parametrize('entry', ['create', 'read'])
@pytest.mark.parametrize('failure', ['missing_actor', 'signing_unavailable'])
def test_unavailable_server_context_fails_before_service(entry, failure):
    service = ContextService()
    req = request(service, payload=body('create', {'title': 'Top'}), no_actor=failure == 'missing_actor')
    if failure == 'signing_unavailable':
        req.app.state.auth_policy_config['hmac']['key_version'] = 0
    response = routes.read_album_top(req, TOP) if entry == 'read' else mutate(req, 'create')
    assert response.status_code == (403 if failure == 'missing_actor' else 503)
    assert decoded(response)['error'] == ('forbidden' if failure == 'missing_actor'
                                         else 'private_ui_context_unavailable')
    assert service.calls == []


@pytest.mark.parametrize('location', ['body', 'query'])
def test_client_context_cannot_override_server_context(location):
    service = ContextService()
    payload = body('create', {'title': 'Mixed Top', 'draft_ref': DRAFT, 'selections': [LOCAL, PENDING]})
    query = {}
    (payload if location == 'body' else query)['context_ref'] = 'd' * 64
    response = mutate(request(service, payload=payload, query=query), 'create')
    assert response.status_code == 422 and decoded(response)['error'] == 'invalid_command'
    assert service.calls == []


def test_working_read_rejects_client_context_query_before_service():
    service = ContextService()
    response = routes.read_album_top(request(service, query={'context_ref': 'd' * 64}), TOP)
    assert response.status_code == 422 and decoded(response)['error'] == 'invalid_command'
    assert service.calls == []


@pytest.mark.parametrize('mode', ['declared', 'streamed'])
def test_context_forwarding_preserves_existing_command_size_limit(mode):
    service = ContextService()
    req = request(service, raw=b'{}',
                  headers={'content-length': str(MAX_TOP_COMMAND_BYTES + 1)} if mode == 'declared' else {},
                  chunks=[b' ' * MAX_TOP_COMMAND_BYTES, b' '] if mode == 'streamed' else None)
    response = mutate(req, 'create')
    assert response.status_code == 413 and decoded(response)['error'] == 'command_too_large'
    assert service.calls == []


@pytest.mark.parametrize('entry', ['read', 'copy'])
@pytest.mark.parametrize('code,status', [('forbidden', 403), ('top_unavailable', 404),
                                        ('remote_evidence_unavailable', 409)])
def test_forwarding_preserves_service_authority_and_evidence_errors(entry, code, status):
    service = ContextService(error=AlbumTopError(code, status))
    req = request(service, payload=body('copy', {}))
    response = routes.read_album_top(req, TOP) if entry == 'read' else mutate(req, 'copy')
    assert response.status_code == status and decoded(response) == {'ok': False, 'error': code}
    assert len(service.calls) == 1 and service.calls[0][3] == private_ui_context_ref(req)


def test_real_middleware_forwards_authenticated_context_only_after_csrf_checks():
    service, current = ContextService(), actor()
    app = middleware_app(service, current)
    headers = mutation_headers(app, current)
    payload = body('create', {'title': 'Mixed Top', 'draft_ref': DRAFT, 'selections': [LOCAL, PENDING]})
    invalid = {key: value for key, value in headers.items() if key != 'x-album-haven-csrf'}
    status, _, _ = asyncio.run(asgi_response(app, 'POST', '/album-tops', headers=invalid, payload=payload))
    assert status == 403 and service.calls == []

    status, result, response_headers = asyncio.run(asgi_response(
        app, 'POST', '/album-tops', headers=headers, payload=payload))
    assert status == 200 and result['context_ref'] == headers['x-albumhaven-context']
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert len(service.calls) == 1 and service.calls[0][3] == result['context_ref']
    assert service.calls[0][1].actor is current


def test_real_middleware_working_read_needs_no_mutation_context_header():
    service, current = ContextService(), actor()
    app = middleware_app(service, current)
    authenticated = mutation_headers(app, current)
    status, result, response_headers = asyncio.run(asgi_response(
        app, 'GET', '/album-tops/' + TOP, headers={'cookie': authenticated['cookie']}))
    assert status == 200 and result['context_ref'] == authenticated['x-albumhaven-context']
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert len(service.calls) == 1 and service.calls[0][0] == 'read'
    assert service.calls[0][3] == result['context_ref'] and service.calls[0][1].actor is current
