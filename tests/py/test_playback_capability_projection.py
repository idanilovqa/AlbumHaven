from __future__ import annotations

import asyncio
import json
from threading import Lock
from types import SimpleNamespace

import pytest

from music_app.services.allowed_actions import AllowedActions
from music_app.services.current_actor import ActorState, CurrentActor, LibraryRelationship


@pytest.fixture
def projection(monkeypatch):
    from music_app.routes import api_read_asgi_routes as reads
    from music_app.routes import web_asgi as web

    grants = set()
    observed = []
    request = SimpleNamespace(
        state=SimpleNamespace(current_actor=CurrentActor(
            state=ActorState.ACTIVE, account_id=1, session_id=1, current_library_id=1,
            library_relationships=(LibraryRelationship(1, 'owner', True),),
        )),
        app=SimpleNamespace(state=SimpleNamespace(config={}, library_state={}, cold_scan_handoff_lock=Lock(), auth_policy_config=None, runtime_asset_version='test-assets')),
        cookies={},
    )

    def allowed(current_request, actions, **_kwargs):
        assert current_request is request
        observed.append(tuple(actions))
        return AllowedActions(tuple(action for action in actions if action in grants))

    monkeypatch.setattr(reads, 'allowed_actions_for_request', allowed)
    monkeypatch.setattr(web, 'allowed_actions_for_request', allowed)
    monkeypatch.setattr(reads, '_project_library_watch_health_for_request', lambda _request: {})
    monkeypatch.setattr(reads, 'load_log_history_revision', lambda _config, **_scope: 'epoch:0')
    monkeypatch.setattr(reads, 'load_loops', lambda _config, **_scope: [{'id': 'owned-loop'}])
    return reads, web, request, grants, observed


def test_status_projects_current_loop_create_grant_without_retaining_cached_authority(projection, monkeypatch):
    reads, _web, request, grants, observed = projection
    shared_status = {'scan_in_progress': False}
    monkeypatch.setattr(reads, '_build_status_payload_from_state', lambda _state: shared_status)
    grants.add('library.loops.create')
    allowed = json.loads(asyncio.run(reads.status(request)).body)
    assert allowed['allowed_actions']['library.loops.create'] is True
    grants.clear()
    denied = json.loads(asyncio.run(reads.status(request)).body)
    assert denied.get('allowed_actions', {}).get('library.loops.create') is not True
    assert any('library.loops.create' in actions for actions in observed)


def test_saved_loops_project_each_effective_action_without_role_inference(projection):
    reads, _web, request, grants, _observed = projection
    grants.update({'library.loops.read', 'library.loops.delete'})
    response = json.loads(asyncio.run(reads.utilities_loops(request)).body)
    assert response['loops'] == [{'id': 'owned-loop', 'cover_url': ''}]
    assert response['allowed_actions'].get('library.loops.delete') is True
    assert response['allowed_actions'].get('library.loops.create') is not True
    assert response['allowed_actions'].get('library.loops.reorder') is not True
    grants.clear()
    response = json.loads(asyncio.run(reads.utilities_loops(request)).body)
    assert response.get('allowed_actions', {}) == {}


def test_index_boot_projection_is_effective_request_authority_and_is_recomputed(projection, monkeypatch):
    _reads, web, request, grants, observed = projection
    captured = []
    request.app.state.templates = SimpleNamespace(TemplateResponse=lambda _request, _name, context: captured.append(context) or context)
    monkeypatch.setattr(web, '_runtime_asset_version', lambda: 'test-assets')
    monkeypatch.setattr(web, 'issue_session_csrf', lambda *_args: 'test-csrf')
    grants.add('library.loops.create')
    first = web._template_response(request, {})
    assert first['playback_allowed_actions'].allows('library.loops.create')
    grants.clear()
    second = web._template_response(request, {})
    assert not second['playback_allowed_actions'].allows('library.loops.create')
    assert first['playback_allowed_actions'].allows('library.loops.create'), 'subsequent requests must not mutate earlier projections'
    assert any('library.loops.create' in actions for actions in observed)
