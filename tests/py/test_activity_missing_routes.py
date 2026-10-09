"""Direct transport boundaries; no middleware or real database claims."""
import asyncio
import pytest
from music_app.routes import playlist_complete_sources_asgi as routes
from music_app.services import playlist_activity_missing as missing
from tests.py.test_owned_playlist_route_boundary import request, Service, decoded
from tests.py.owned_playlist_testing import SOURCE, SOURCE_REVISION

PAYLOAD = {'origin': {'audience': 'own', 'subject_ref': None, 'kind': 'tracks',
    'period': 'week', 'snapshot_ref': 's' * 43}, 'row_refs': None}


@pytest.mark.parametrize('probe', [False, True])
def test_eligibility_and_explicit_capture_are_separate_actions(monkeypatch, probe):
    calls = []
    def inspect(owner, ctx, origin, refs, *, constraints, probe):
        calls.append((owner, ctx, origin, refs, probe))
        return {'status': 'ready', 'data': {'can_inspect_missing': True} if probe else {'capture_ref': SOURCE}}
    monkeypatch.setattr(missing, 'inspect', inspect)
    service = Service()
    response = asyncio.run((routes.activity_missing_eligibility if probe else routes.activity_missing_capture)(
        request(service, payload=PAYLOAD)))
    assert response.status_code == 200
    assert decoded(response)['status'] == 'ready'
    assert len(calls) == 1 and calls[0][0] is service
    assert calls[0][2:] == (PAYLOAD['origin'], None, probe)


@pytest.mark.parametrize('probe', [False, True])
@pytest.mark.parametrize('header', [None, '', 'wrong'])
def test_stale_context_stops_both_actions_before_source_read(monkeypatch, probe, header):
    monkeypatch.setattr(missing, 'inspect', lambda *a, **k: pytest.fail('Stale context reached source'))
    response = asyncio.run(routes._activity_missing(request(Service(), payload=PAYLOAD, header=header), probe=probe))
    assert response.status_code == 409 and decoded(response)['error'] == 'stale_context'


@pytest.mark.parametrize('payload', [{}, {'origin': {}}, {**PAYLOAD, 'actor_id': 42}, {**PAYLOAD, 'entries': []}])
def test_client_cannot_supply_receipts_rows_or_authority(monkeypatch, payload):
    monkeypatch.setattr(missing, 'inspect', lambda *a, **k: pytest.fail('Invalid payload reached source'))
    response = asyncio.run(routes.activity_missing_capture(request(Service(), payload=payload)))
    assert response.status_code == 422 and decoded(response)['error'] == 'invalid_command'


def test_retained_read_never_allocates_another_capture(monkeypatch):
    calls = []
    monkeypatch.setattr(missing, 'inspect', lambda *a, **k: pytest.fail('Reload allocated a capture'))
    def retained(owner, ctx, ref, revision, *, constraints):
        calls.append((ref, revision))
        return {'status': 'ready', 'data': {'capture_ref': ref}}
    monkeypatch.setattr(missing, 'read_capture', retained)
    response = routes.retained_activity_missing_capture(request(Service(), query={
        'source_ref': SOURCE, 'source_revision': SOURCE_REVISION}))
    assert response.status_code == 200 and decoded(response)['data']['capture_ref'] == SOURCE
    assert calls == [(SOURCE, SOURCE_REVISION)]


@pytest.mark.parametrize('query', [{}, {'source_ref': SOURCE},
    {'source_ref': SOURCE, 'source_revision': SOURCE_REVISION, 'origin': 'other'}])
def test_retained_read_rejects_incomplete_or_extra_descriptor(monkeypatch, query):
    monkeypatch.setattr(missing, 'read_capture', lambda *a, **k: pytest.fail('Invalid query reached source'))
    response = routes.retained_activity_missing_capture(request(Service(), query=query))
    assert response.status_code == 422 and decoded(response)['error'] == 'invalid_source_query'


@pytest.mark.parametrize('method,path,csrf', [
    ('POST', '/playlists/creation-source/activity-missing/eligibility', 'session_header'),
    ('POST', '/playlists/creation-source/activity-missing', 'session_header'),
    ('GET', '/playlists/creation-source/activity-missing', 'none'),
])
def test_missing_activity_routes_use_create_perimeter_and_existing_csrf_policy(method, path, csrf):
    from music_app.services.private_route_boundary import private_action_for_route, csrf_mode_for_route
    # A missing mapping silently falls back to app.access in real middleware;
    # direct handler/service tests cannot detect that perimeter regression.
    assert private_action_for_route(method, path) == 'library.playlists.create'
    assert csrf_mode_for_route(method, path) == csrf
