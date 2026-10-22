"""Bounded native route and real boundary registration for offline source jobs."""
import asyncio
from dataclasses import replace
from uuid import uuid4

import pytest

from music_app.routes import owned_album_tops_asgi as routes
from music_app.services.private_route_boundary import private_action_for_route, csrf_mode_for_route
from test_owned_album_top_route_boundary import request, decoded


REF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'


class Service:
    def __init__(self):
        self.calls = []

    def submit(self, context, **kwargs):
        self.calls.append(('submit', context, kwargs))
        return {'job_ref': REF, 'status': 'completed', 'top_ref': None}

    def list(self, context, **kwargs):
        self.calls.append(('list', context, kwargs))
        return {'jobs': [], 'next_cursor': None}

    def read(self, context, **kwargs):
        self.calls.append(('read', context, kwargs))
        return {'job_ref': REF, 'status': 'running'}

    process = read
    cancel = read


def source_request(service, **kwargs):
    req = request(None, **kwargs)
    req.app.state.album_top_source_import_service = service
    return req


def test_submit_and_read_have_private_context_bound_responses():
    service = Service()
    req = source_request(service, payload={'request_key': str(uuid4())})
    response = asyncio.run(routes.submit_album_top_source_import(req))
    assert response.status_code == 200
    assert decoded(response)['data']['top_ref'] is None
    assert decoded(response)['context_ref']
    assert response.headers['cache-control'] == 'private, no-store'
    assert len(service.calls) == 1
    response = asyncio.run(routes.read_album_top_source_import(source_request(service), REF))
    assert response.status_code == 200 and decoded(response)['data']['status'] == 'running'


@pytest.mark.parametrize('operation', ['submit', 'list', 'read', 'process', 'cancel'])
def test_context_changed_during_worker_cannot_publish_old_scope(monkeypatch, operation):
    service = Service()
    req = source_request(service, payload={})
    async def work(callback, *args, **kwargs):
        result = callback(*args, **kwargs)
        req.state.current_actor = replace(req.state.current_actor, session_id=99)
        return result
    monkeypatch.setattr(routes, 'run_in_threadpool', work)
    response = asyncio.run(routes._source_import_request(req, operation,
        REF if operation in ('read', 'process', 'cancel') else None))
    assert response.status_code == 409 and decoded(response)['error'] == 'stale_context'
    assert 'data' not in decoded(response)


def test_duplicate_context_rejected_before_work():
    service = Service()
    req = source_request(service, payload={})
    witness = next(value for name, value in req.scope['headers'] if name == b'x-albumhaven-context')
    req.scope['headers'].append((b'X-AlbumHaven-Context', witness))
    response = asyncio.run(routes.submit_album_top_source_import(req))
    assert response.status_code == 409 and service.calls == []


@pytest.mark.parametrize('raw', [b'[]', b'{', b'null', b'"' + b'x' * (512 * 1024) + b'"'])
def test_bounded_invalid_transport_never_reaches_worker(raw):
    service = Service()
    response = asyncio.run(routes.submit_album_top_source_import(source_request(service, raw=raw)))
    assert response.status_code in (413, 422) and service.calls == []


def test_control_commands_reject_hidden_payload_and_query():
    service = Service()
    for operation in ('process', 'cancel'):
        response = asyncio.run(routes._source_import_request(
            source_request(service, payload={'content': 'replacement'}), operation, REF))
        assert response.status_code == 422
    response = asyncio.run(routes.read_album_top_source_import(
        source_request(service, query={'actor_account_id': '42'}), REF))
    assert response.status_code == 422 and service.calls == []


def test_real_boundary_and_route_precedence():
    paths = [('GET', '/album-tops/source-imports'), ('POST', '/album-tops/source-imports'),
        ('GET', '/album-tops/source-imports/{job_ref}'),
        ('POST', '/album-tops/source-imports/{job_ref}/process'),
        ('POST', '/album-tops/source-imports/{job_ref}/cancel')]
    for method, path in paths:
        assert private_action_for_route(method, path) == 'library.album_tops.create'
        assert csrf_mode_for_route(method, path) == ('none' if method == 'GET' else 'session_header')
        assert any(route.path == path and method in route.methods for route in routes.router.routes)
    registered = [route.path for route in routes.router.routes]
    assert registered.index('/album-tops/source-imports') < registered.index('/album-tops/{top_ref}')
