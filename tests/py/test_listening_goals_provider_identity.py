"""Configured product identity composition; synthetic transport only, no live IO."""
from functools import partial
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

from music_app.routes import listening_goals_asgi as routes
from music_app.services.listening_goals_postgres import PostgresListeningGoalsService
from music_app.services.remote_album_evidence import RemoteAlbumEvidenceError
from tests.py.test_musicbrainz_strict_evidence_transport import wire, WireResponse, provider_payload, GROUP
from tests.py.test_listening_goals_postgres import db, urls
from tests.py.test_listening_goals_routes import application, headers, request, ready


PRODUCT_IDENTITY = 'AlbumHaven-fixture/2.4 (https://product.example.test/contact)'
MISSING = object()
INVALID_IDENTITIES = [MISSING, None, '', '   ', 123, False, [], {}, 'bad\r\nheader', 'x'*1001]


def configured_request(value=MISSING):
    config = {'ALBUM_HAVEN_APP_DATABASE_URL': 'postgresql://unused.example.test/unused'}
    if value is not MISSING:
        config['MUSICBRAINZ_USER_AGENT'] = value
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(config=config)))


@pytest.mark.parametrize('search', [False, True])
def test_configured_product_identity_reaches_actual_strict_transport_unchanged(wire, search):
    service = routes._service(configured_request(PRODUCT_IDENTITY))
    payload = {'release-groups': [provider_payload()]} if search else provider_payload()
    wire.responses.append(WireResponse(json.dumps(payload).encode()))
    # Exercise the actual composed adapter and shared HTTP handler graph; the
    # imported fixture replaces only the network opening boundary.
    if search:
        facts = service._searcher('Example', '', user_agent=service._user_agent)
        assert facts[0].release_group_id == GROUP
    else:
        facts = service._provider(GROUP, user_agent=service._user_agent)
        assert facts.release_group_id == GROUP
    assert len(wire.requests) == 1
    assert {key.lower(): value for key, value in wire.requests[0][1].items()}['user-agent'] == PRODUCT_IDENTITY
    assert PRODUCT_IDENTITY not in repr(facts)


@pytest.mark.parametrize('value', INVALID_IDENTITIES)
@pytest.mark.parametrize('search', [False, True])
def test_invalid_or_missing_config_is_not_coerced_or_sent_to_transport(wire, value, search):
    service = routes._service(configured_request(value))
    with pytest.raises(RemoteAlbumEvidenceError, match='^invalid_provider_user_agent$'):
        if search:
            service._searcher('Example', '', user_agent=service._user_agent)
        else:
            service._provider(GROUP, user_agent=service._user_agent)
    assert wire.requests == [] and wire.pacing == []


def test_explicit_injected_service_support_is_preserved():
    req = configured_request()
    injected = object()
    req.app.state.listening_goals_service = injected
    assert routes._service(req) is injected


def production_composition(app, database, monkeypatch, value):
    del app.state.listening_goals_service
    if value is not MISSING:
        app.state.config['MUSICBRAINZ_USER_AGENT'] = value
    # Keep actual repository/policy/session/SQL. Supply only the admitted test
    # connection and deterministic clock; no provider or service success stub.
    monkeypatch.setattr(routes, 'PostgresListeningGoalsService', partial(
        PostgresListeningGoalsService, connect=database.connector(), clock=lambda: database.now))


@pytest.mark.parametrize('value', [MISSING, None, 123, 'bad\nheader'])
def test_invalid_identity_returns_safe_errors_but_read_and_reset_still_work(db, wire, monkeypatch, value):
    seeded = db.service.execute(db.context(), db.add_command(db.acquire()))
    app = application(db)
    production_composition(app, db, monkeypatch, value)
    auth = headers(app, db)
    before = db.snapshot()
    for path, payload in [('/account/goals/remote-search', {'title': 'Album', 'artist': ''}),
                          ('/account/goals/remote-evidence', {'release_group_id': GROUP})]:
        status, body, response_headers = request(app, 'POST', path, headers=auth, payload=payload)
        assert status == 503 and body == {'ok': False, 'error': 'invalid_provider_user_agent'}
        assert response_headers[b'cache-control'] == b'private, no-store'
    assert db.snapshot() == before and wire.requests == []
    state = ready(app, 'GET', '/account/goals', headers=auth)
    assert state['goal_ref'] == seeded['goal_ref']
    old_cycle = state['periods']['week']['cycle']['cycle_id']
    receipt = ready(app, 'POST', '/account/goals/reset', headers=auth, payload={
        'request_key': str(uuid4()), 'revision': state['revision'], 'period': 'week',
        'timezone_name': 'UTC', 'expected_cycle_id': old_cycle})
    assert receipt['changed'] and receipt['cycle_id'] != old_cycle
    after = ready(app, 'GET', '/account/goals', headers=auth)
    assert after['periods']['week']['album_refs'] == state['periods']['week']['album_refs']
    assert wire.requests == [] and wire.pacing == []
