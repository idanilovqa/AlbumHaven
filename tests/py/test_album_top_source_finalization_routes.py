"""Actual native create/unlock/evidence transport boundaries for source imports."""
import asyncio
from dataclasses import replace
from uuid import uuid4

import pytest

from music_app.routes import owned_album_tops_asgi as routes
from music_app.services import album_top_source_finalization as source
from music_app.services.private_route_boundary import private_action_for_route, csrf_mode_for_route
from test_owned_album_top_route_boundary import request, decoded, Service, TOP


def body():
    ref = str(uuid4())
    return {'request_key': ref, 'title': 'Source', 'source_review': {'job_ref': ref, 'revision': '3',
        'rows': [{'row_ref': '1', 'selection': {'kind': 'local_catalog', 'album_ref': str(uuid4())}}]}}


def test_source_creation_uses_existing_create_owner_and_unlock_uses_existing_mutation():
    service = Service()
    response = asyncio.run(routes.create_album_top(request(service, payload=body())))
    assert response.status_code == 200 and 'source_review' in service.calls[0][2].data
    response = asyncio.run(routes.mutate_album_top(request(service, payload={
        'request_key': str(uuid4()), 'revision': '3'}), TOP, 'unlock_source'))
    assert response.status_code == 200 and service.calls[-1][2].action == 'unlock_source'


@pytest.mark.parametrize('action', ['create', 'unlock_source'])
def test_new_source_writes_fence_context_after_thread_work(monkeypatch, action):
    service = Service()
    req = request(service, payload=body() if action == 'create' else {
        'request_key': str(uuid4()), 'revision': '3'})
    async def work(callback, *args, **kwargs):
        result = callback(*args, **kwargs)
        req.state.current_actor = replace(req.state.current_actor, session_id=99)
        return result
    monkeypatch.setattr(routes, 'run_in_threadpool', work)
    response = asyncio.run(routes._mutate(req, action, None if action == 'create' else TOP))
    assert response.status_code == 409 and decoded(response)['error'] == 'stale_context'
    assert 'data' not in decoded(response)


def test_private_evidence_transport_is_context_fenced_and_normal_browse(monkeypatch):
    req = request(Service(), query={'revision': '3'})
    def read(*args, **kwargs):
        return {'source': {'content': '<script>inert()</script>'}}
    monkeypatch.setattr(source, 'read_source', read)
    response = asyncio.run(routes.read_album_top_import_source(req, TOP))
    assert response.status_code == 200 and response.headers['content-type'].startswith('application/json')
    assert response.headers['cache-control'] == 'private, no-store'
    assert decoded(response)['data']['source']['content'] == '<script>inert()</script>'
    async def stale(callback, *args, **kwargs):
        value = callback(*args, **kwargs)
        req.state.current_actor = replace(req.state.current_actor, session_id=99)
        return value
    monkeypatch.setattr(routes, 'run_in_threadpool', stale)
    response = asyncio.run(routes.read_album_top_import_source(req, TOP))
    assert response.status_code == 409 and 'data' not in decoded(response)
    path = '/album-tops/{top_ref}/import-source'
    assert private_action_for_route('GET', path) == 'library.browse.read'
    assert csrf_mode_for_route('GET', path) == 'none'
