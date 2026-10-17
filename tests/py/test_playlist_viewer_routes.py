"""Independent viewer-route boundary, freshness and identity regressions."""
import asyncio
import json
from types import SimpleNamespace

import pytest
from starlette.requests import Request

from music_app.routes import owned_playlists_asgi as routes
from music_app.services.owned_playlists import ACCESS, BROWSE, CREATE, PlaylistError
from music_app.services.private_route_boundary import _PRIVATE_ROUTE_ACTIONS
from tests.py.test_playlist_collaboration import P, K, G, context


class Service:
    def __init__(self):
        self.calls = []

    def execute(self, ctx, command, *, constraints):
        self.calls.append((ctx, command, constraints))
        return {'ok': True, 'action': command.action, 'request_key': command.request_key,
                'playlist_id': G if command.action == 'copy' else command.playlist_ref,
                'source_playlist_id': command.playlist_ref, 'revision': '1'}

    def read_sharing(self, ctx, playlist_ref, **kwargs):
        self.calls.append((ctx, playlist_ref, kwargs))
        return {'playlist_id': playlist_ref, 'pending_requests': []}

    def read_edit_requests(self, ctx, **kwargs):
        self.calls.append((ctx, kwargs))
        return {'requests': [], 'next_cursor': None}


def request(service, payload=None, *, query='', fresh=True):
    body = json.dumps(payload or {}).encode()
    async def receive():
        return {'type': 'http.request', 'body': body, 'more_body': False}
    state = SimpleNamespace(owned_playlists_service=service,
                            auth_policy_config={'hmac': {'secret': 'synthetic-secret'}})
    return Request({'type': 'http', 'method': 'POST' if payload is not None else 'GET',
        'path': '/playlists', 'query_string': query.encode(),
        'headers': [(b'content-type', b'application/json'),
                    (b'x-albumhaven-context', (b'a' if fresh else b'b') * 64)],
        'app': SimpleNamespace(state=state)}, receive)


@pytest.fixture
def boundary(monkeypatch):
    seen = []
    def resolve(req, action):
        seen.append(action)
        return context(), 'constraints-marker'
    monkeypatch.setattr(routes, '_context', resolve)
    monkeypatch.setattr(routes, '_context_ref', lambda req: 'a' * 64)
    return seen


@pytest.mark.parametrize('action,extra,coarse', [
    ('request_edit', {}, BROWSE), ('copy', {'title': 'Independent copy'}, CREATE),
    ('decide_edit_request', {'decision': 'approve'}, ACCESS),
])
def test_viewer_write_retains_path_identity_policy_and_private_receipt(boundary, action, extra, coarse):
    service = Service()
    response = asyncio.run(routes._write(request(service, {'revision': '4', 'request_key': K, **extra}),
        action, P, request_ref=G if action == 'decide_edit_request' else None))
    assert response.status_code == 200
    assert boundary == [coarse]
    assert response.headers['cache-control'] == 'private, no-store'
    assert json.loads(response.body)['context_ref'] == 'a' * 64
    ctx, command, constraints = service.calls[0]
    assert constraints == 'constraints-marker'
    assert command.playlist_ref == P and command.request_key == K
    if action == 'decide_edit_request':
        assert command.data['request_ref'] == G
    if action == 'copy':
        assert command.data['title'] == 'Independent copy'
        result = json.loads(response.body)
        assert result['playlist_id'] == G and result['source_playlist_id'] == P


@pytest.mark.parametrize('action', ['request_edit', 'copy', 'decide_edit_request'])
def test_viewer_stale_context_never_enters_service(boundary, action):
    service = Service()
    response = asyncio.run(routes._write(request(service, {'revision': '4', 'request_key': K}, fresh=False), action, P))
    assert response.status_code == 409
    assert json.loads(response.body)['error'] == 'stale_context'
    assert service.calls == []


@pytest.mark.parametrize('injected', [{'request_ref': P}, {'account_id': 99}, {'playlist_id': G}, {'role': 'owner'}])
def test_decision_cannot_override_path_or_inject_authority(boundary, injected):
    service = Service()
    response = asyncio.run(routes.decide_playlist_edit_request(request(service,
        {'revision': '4', 'request_key': K, 'decision': 'approve', **injected}), P, G))
    assert response.status_code == 422
    assert json.loads(response.body)['error'] == 'invalid_command'
    assert service.calls == []


@pytest.mark.parametrize('sharing,query', [(True, 'cursor=next'), (False, 'cursor=next&limit=7')])
def test_viewer_reads_forward_scoped_context_and_signed_pagination(boundary, sharing, query):
    service = Service()
    response = routes.playlist_sharing(request(service, query=query), P) if sharing else routes.playlist_edit_requests(request(service, query=query))
    assert response.status_code == 200 and boundary == [BROWSE]
    assert response.headers['cache-control'] == 'private, no-store'
    assert service.calls[0][0].actor.account_id == context().actor.account_id
    options = service.calls[0][-1]
    assert options['cursor'] == 'next' and options['cursor_secret'] == 'synthetic-secret'
    assert options['constraints'] == 'constraints-marker'
    if not sharing:
        assert options['limit'] == 7


@pytest.mark.parametrize('sharing,query', [
    (True, 'account_id=99'), (True, 'cursor=a&cursor=b'),
    (False, 'owner_account_id=99'), (False, 'limit=5&limit=6'),
    (False, 'limit=-1'), (False, 'limit=1.5'), (False, 'limit=9999'),
])
def test_viewer_reads_reject_scope_injection_and_ambiguous_queries(boundary, sharing, query):
    service = Service()
    response = routes.playlist_sharing(request(service, query=query), P) if sharing else routes.playlist_edit_requests(request(service, query=query))
    assert response.status_code == 422
    assert json.loads(response.body)['error'] == 'invalid_access_query'
    assert service.calls == []


def test_viewer_routes_registered_once_with_exact_existing_capabilities():
    expected = {
        ('GET', '/playlists/{playlist_ref}/sharing'): BROWSE,
        ('GET', '/playlists/edit-requests'): BROWSE,
        ('POST', '/playlists/{playlist_ref}/edit-requests'): BROWSE,
        ('POST', '/playlists/{playlist_ref}/edit-requests/{request_ref}/decision'): ACCESS,
        ('POST', '/playlists/{playlist_ref}/copy'): CREATE,
    }
    registered = [(method, route.path) for route in routes.router.routes for method in route.methods]
    for key, capability in expected.items():
        assert _PRIVATE_ROUTE_ACTIONS[key] == capability
        assert registered.count(key) == 1


def test_request_projection_uses_iso_timestamp_without_private_request_state():
    from datetime import datetime, timezone
    from uuid import UUID
    from music_app.services.playlist_viewer_actions import project_request
    created = datetime(2026, 10, 9, 1, 2, 3, 450000, tzinfo=timezone.utc)
    result = project_request({'request_ref': UUID(G), 'playlist_id': UUID(P), 'title': 'Shared',
        'account_ref': K, 'display_name': 'Reader', 'username_display': 'reader', 'created_at': created,
        'browse_grant_ids': [1, 2], 'requester_account_id': 99, 'status': 'pending'})
    assert result['created_at'] == '2026-10-09T01:02:03.450000+00:00'
    assert datetime.fromisoformat(result['created_at']) == created
    assert result['request_ref'] == G and result['playlist_id'] == P
    assert set(result) == {'request_ref', 'playlist_id', 'title', 'account_ref', 'display_name', 'username_display', 'created_at'}
