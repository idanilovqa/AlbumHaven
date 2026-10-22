"""Real Goals routes, private middleware, session resolver and PostgreSQL owner.

Only public MusicBrainz transport facts are fixtures. No service/policy success
stub or inventory is installed. Normal isolated PostgreSQL CI is required.
"""
import asyncio
import json
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
from fastapi import FastAPI

from music_app.routes.listening_goals_asgi import router
from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
from music_app.services.current_actor_postgres import PostgresCurrentActorResolver
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import install_private_route_boundary
from tests.py.test_listening_goals_postgres import db, urls


SECRET = 'synthetic-goals-http-session-policy-key-32-bytes'


def application(database):
    app = FastAPI()
    config = {'ALBUM_HAVEN_APP_DATABASE_URL': database.app_url,
              'ALBUM_HAVEN_DEPLOYMENT_MODE': 'self_hosted'}
    app.state.config = config
    app.state.auth_policy_config = {'hmac': {'secret': SECRET, 'key_version': 1}}
    sessions = PostgresAuthSessionService(config, clock=lambda: database.now)
    app.state.current_actor_resolver = PostgresCurrentActorResolver(config, session_service=sessions)
    app.state.listening_goals_service = database.service
    app.include_router(router)
    install_private_route_boundary(app)
    return app


def headers(app, database, actor=None):
    actor = actor or database.owner
    token = database.session_tokens[actor.session_id]
    csrf = issue_session_csrf(token, app.state.auth_policy_config)
    return {'cookie': f'__Host-album_haven_session={token}; __Host-album_haven_csrf={csrf}',
            'origin': 'https://music.test', 'x-album-haven-csrf': csrf}


async def request_async(app, method, target, *, headers=None, payload=None):
    # Same real ASGI request/response convention as test_owned_album_top_route_boundary,
    # extended solely to split a normal query string for the history endpoint.
    parsed = urlsplit(target)
    body = b'' if payload is None else json.dumps(payload).encode()
    received = False
    finished = asyncio.Event()
    messages = []

    async def receive():
        nonlocal received
        if not received:
            received = True
            return {'type': 'http.request', 'body': body, 'more_body': False}
        await finished.wait()
        return {'type': 'http.disconnect'}

    async def send(message):
        messages.append(message)
        if message['type'] == 'http.response.body' and not message.get('more_body', False):
            finished.set()

    supplied = {'host': 'music.test', 'content-type': 'application/json',
                'content-length': str(len(body)), **(headers or {})}
    await app({'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
        'method': method, 'scheme': 'https', 'path': parsed.path, 'raw_path': parsed.path.encode(),
        'query_string': parsed.query.encode(), 'headers': [(k.encode(), v.encode()) for k, v in supplied.items()],
        'client': ('127.0.0.1', 50000), 'server': ('music.test', 443)}, receive, send)
    start = next(item for item in messages if item['type'] == 'http.response.start')
    content = b''.join(item.get('body', b'') for item in messages if item['type'] == 'http.response.body')
    return start['status'], json.loads(content), dict(start['headers'])


def request(app, method, target, **kwargs):
    return asyncio.run(request_async(app, method, target, **kwargs))


def ready(app, method, target, **kwargs):
    status, body, response_headers = request(app, method, target, **kwargs)
    assert status == 200, body
    assert body['status'] == 'ready'
    assert response_headers[b'cache-control'] == b'private, no-store'
    return body['data']


def add_payload(evidence, *, revision='1'):
    return {'request_key': str(uuid4()), 'revision': revision, 'period': 'week', 'timezone_name': 'UTC',
            'evidence_ref': evidence['evidence_ref'], 'evidence_version': evidence['evidence_version']}


def test_actual_session_no_library_remote_add_read_reset_history_and_receipt(db):
    app = application(db)
    auth = headers(app, db)
    resolved = app.state.current_actor_resolver.resolve(db.session_tokens[db.owner.session_id])
    assert resolved.account_id == db.owner.account_id
    assert resolved.session_id == db.owner.session_id
    assert resolved.current_library_id is None and resolved.library_relationships == ()
    before = ready(app, 'GET', '/account/goals', headers=auth)
    assert before['goal_ref'] is None and before['revision'] == '1'
    assert all(view['cycle'] is None and view['total'] == 0 for view in before['periods'].values())
    group = db.group()
    evidence = ready(app, 'POST', '/account/goals/remote-evidence', headers=auth,
                     payload={'release_group_id': group})
    command = add_payload(evidence)
    added = ready(app, 'POST', '/account/goals/add', headers=auth, payload=command)
    assert added['changed'] is True and added['revision'] == '2'
    assert ready(app, 'POST', '/account/goals/add', headers=auth, payload=command) == added
    state = ready(app, 'GET', '/account/goals', headers=auth)
    assert state['goal_ref'] == added['goal_ref']
    assert state['albums'][0]['catalog_ref'] == added['catalog_ref']
    assert all(view['album_refs'] == [added['catalog_ref']] for view in state['periods'].values())
    assert '/private/never-a-goal-source.flac' not in json.dumps(state)
    assert 'private.example.test' not in json.dumps(state)
    reset = {'request_key': str(uuid4()), 'revision': state['revision'], 'period': 'week',
             'timezone_name': 'UTC', 'expected_cycle_id': state['periods']['week']['cycle']['cycle_id']}
    reset_receipt = ready(app, 'POST', '/account/goals/reset', headers=auth, payload=reset)
    assert reset_receipt['changed'] is True and reset_receipt['revision'] == '3'
    after = ready(app, 'GET', '/account/goals', headers=auth)
    assert after['periods']['week']['album_refs'] == state['periods']['week']['album_refs']
    assert after['periods']['week']['cycle']['cycle_id'] != reset['expected_cycle_id']
    for period in ('month', 'six-months', 'year'):
        assert after['periods'][period] == state['periods'][period]
    history = ready(app, 'GET', '/account/goals/history?period=week', headers=auth)
    assert [cycle['cycle_id'] for cycle in history['cycles']] == [reset['expected_cycle_id']]
    assert history['cycles'][0]['albums'][0]['catalog_ref'] == added['catalog_ref']
    acknowledged = ready(app, 'GET', '/account/goals/operations/' + command['request_key'], headers=auth)
    assert acknowledged == {'status': 'committed', 'receipt': added}
    assert acknowledged['receipt']['revision'] != after['revision']
    with db.connect() as connection:
        assert connection.execute('select count(*) as n from library.library_memberships where account_id=%s',
                                  (db.owner.account_id,)).fetchone()['n'] == 0
        assert connection.execute('select count(*) as n from library.catalog_album_links where catalog_ref=%s',
                                  (added['catalog_ref'],)).fetchone()['n'] == 0


@pytest.mark.parametrize('path', ['/account/goals', '/account/goals/history?period=week',
    '/account/goals/operations/7d023ef8-d7fc-4c5a-95ce-86d763c6f63b'])
def test_unauthenticated_reads_are_private_and_never_acquire_provider_facts(db, path):
    status, body, response_headers = request(application(db), 'GET', path)
    assert status == 401 and body == {'detail': 'Authentication required.'}
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert db.provider_calls == []


@pytest.mark.parametrize('failure', ['missing_header', 'missing_cookie', 'cross_origin', 'different_session'])
def test_evidence_requires_real_session_csrf_before_provider(db, failure):
    app = application(db)
    auth = headers(app, db)
    if failure == 'missing_header':
        auth.pop('x-album-haven-csrf')
    elif failure == 'missing_cookie':
        auth['cookie'] = '__Host-album_haven_session=' + db.session_tokens[db.owner.session_id]
    elif failure == 'cross_origin':
        auth['origin'] = 'https://other.example.test'
    else:
        other = db.other_actor()
        wrong = issue_session_csrf(db.session_tokens[other.session_id], app.state.auth_policy_config)
        auth['cookie'] = '__Host-album_haven_session=' + db.session_tokens[db.owner.session_id] + '; __Host-album_haven_csrf=' + wrong
        auth['x-album-haven-csrf'] = wrong
    status, body, response_headers = request(app, 'POST', '/account/goals/remote-evidence',
        headers=auth, payload={'release_group_id': db.group()})
    assert status == 403 and body == {'detail': 'CSRF validation failed.'}
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert db.provider_calls == []


@pytest.mark.parametrize('constraints', [
    PolicyEvaluationConstraints(deployment_allowed=False),
    PolicyEvaluationConstraints(client_surface_allowed=False),
    PolicyEvaluationConstraints(request_origin_allowed=False),
])
def test_intrinsic_self_authority_still_obeys_all_narrowing_constraints(db, constraints):
    app = application(db)
    app.state.policy_constraint_resolver = lambda context: constraints
    status, body, response_headers = request(app, 'POST', '/account/goals/remote-evidence',
        headers=headers(app, db), payload={'release_group_id': db.group()})
    assert status == 403 and body == {'detail': 'Action not permitted.'}
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert db.provider_calls == []


@pytest.mark.parametrize('extra', [{'account_id': 999}, {'library_id': 999},
    {'title': 'Browser assertion'}, {'source_url': 'https://private.example.test'}])
def test_remote_evidence_rejects_browser_authority_or_metadata(db, extra):
    app = application(db)
    status, body, response_headers = request(app, 'POST', '/account/goals/remote-evidence',
        headers=headers(app, db), payload={'release_group_id': db.group(), **extra})
    assert status == 400 and body == {'ok': False, 'error': 'invalid_command'}
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert db.provider_calls == []


def test_other_account_cannot_admit_handle_or_read_own_receipt(db):
    app = application(db)
    auth = headers(app, db)
    evidence = ready(app, 'POST', '/account/goals/remote-evidence', headers=auth,
                     payload={'release_group_id': db.group()})
    payload = add_payload(evidence)
    own = ready(app, 'POST', '/account/goals/add', headers=auth, payload=payload)
    other = db.other_actor()
    other_headers = headers(app, db, other)
    status, body, _ = request(app, 'POST', '/account/goals/add', headers=other_headers, payload=payload)
    assert status == 409 and body == {'ok': False, 'error': 'evidence_unavailable'}
    other_state = ready(app, 'GET', '/account/goals', headers=other_headers)
    assert other_state['goal_ref'] is None and other_state['albums'] == []
    assert ready(app, 'GET', '/account/goals/operations/' + payload['request_key'],
                 headers=other_headers) == {'status': 'unknown'}
    assert ready(app, 'GET', '/account/goals', headers=auth)['goal_ref'] == own['goal_ref']


def test_real_session_revocation_blocks_read_and_write(db):
    app = application(db)
    auth = headers(app, db)
    ready(app, 'GET', '/account/goals', headers=auth)
    with db.connect() as connection:
        connection.execute('update app.account_sessions set revoked_at=%s where id=%s',
                           (db.now, db.owner.session_id))
    for method, path, payload in [('GET', '/account/goals', None),
        ('POST', '/account/goals/remote-evidence', {'release_group_id': db.group()})]:
        status, body, response_headers = request(app, method, path, headers=auth, payload=payload)
        assert status == 401 and body == {'detail': 'Authentication required.'}
        assert response_headers[b'cache-control'] == b'private, no-store'
    assert db.provider_calls == []


def test_payload_bound_and_query_rejection_are_no_store(db):
    app = application(db)
    auth = headers(app, db)
    for target, payload, expected in [
        ('/account/goals/remote-evidence', {'release_group_id': 'a' * 9000}, 413),
        ('/account/goals/remote-evidence?account_id=999', {'release_group_id': db.group()}, 400),
    ]:
        status, body, response_headers = request(app, 'POST', target, headers=auth, payload=payload)
        assert status == expected
        assert body['ok'] is False
        assert response_headers[b'cache-control'] == b'private, no-store'
    assert db.provider_calls == []


@pytest.mark.parametrize('field,value', [('account_id', 999), ('library_id', 999),
    ('occurred_at', '2026-01-01T00:00:00+00:00'), ('catalog_ref', '7d023ef8-d7fc-4c5a-95ce-86d763c6f63b')])
def test_add_cannot_supply_authority_identity_or_server_time(db, field, value):
    app = application(db)
    auth = headers(app, db)
    evidence = ready(app, 'POST', '/account/goals/remote-evidence', headers=auth,
                     payload={'release_group_id': db.group()})
    before = db.snapshot()
    status, body, response_headers = request(app, 'POST', '/account/goals/add', headers=auth,
        payload={**add_payload(evidence), field: value})
    assert status == 400 and body == {'ok': False, 'error': 'invalid_command'}
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert db.snapshot() == before


@pytest.mark.parametrize('malformation', ['identity', 'date', 'artist'])
def test_provider_malformed_facts_do_not_become_ready_evidence(db, malformation):
    app = application(db)
    group = db.group()
    if malformation == 'identity':
        db.payloads[group]['id'] = str(uuid4())
    elif malformation == 'date':
        db.payloads[group]['first-release-date'] = '2026-02-30'
    else:
        db.payloads[group]['artist-credit'] = []
    before = db.snapshot()
    status, body, response_headers = request(app, 'POST', '/account/goals/remote-evidence',
        headers=headers(app, db), payload={'release_group_id': group})
    assert status == 503 and body['ok'] is False
    assert body['error'] in {'provider_identity_changed', 'invalid_provider_metadata'}
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert db.snapshot() == before
    assert len(db.provider_calls) == 1


@pytest.mark.parametrize('failure', ['actor', 'provider', 'repository', 'configuration'])
def test_unexpected_goals_failures_have_generic_private_perimeter(db, monkeypatch, failure):
    app = application(db)
    auth = headers(app, db)
    private_detail = 'synthetic-private-database-location-and-provider-detail'

    def fail(*args, **kwargs):
        raise RuntimeError(private_detail)

    if failure == 'actor':
        monkeypatch.setattr(app.state.current_actor_resolver, 'resolve', fail)
    elif failure == 'provider':
        monkeypatch.setattr(db.service, '_provider', fail)
    elif failure == 'repository':
        monkeypatch.setattr(db.service, 'read', fail)
    else:
        del app.state.listening_goals_service
        app.state.config = {'ALBUM_HAVEN_DEPLOYMENT_MODE': 'self_hosted'}
    method = 'POST' if failure == 'provider' else 'GET'
    path = '/account/goals/remote-evidence' if failure == 'provider' else '/account/goals'
    before = db.snapshot()
    status, body, response_headers = request(app, method, path, headers=auth,
        payload={'release_group_id': db.group()} if method == 'POST' else None)
    assert status == 503
    assert body == {'ok': False, 'error': 'goals_unavailable'}
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert private_detail not in json.dumps(body)
    assert db.snapshot() == before


def test_goals_error_perimeter_does_not_swallow_task_cancellation(db, monkeypatch):
    app = application(db)

    def cancel(*args, **kwargs):
        raise asyncio.CancelledError()

    monkeypatch.setattr(app.state.current_actor_resolver, 'resolve', cancel)
    # Invoke the actual registered dispatch to isolate this error perimeter from
    # ASGI framework task-group exception normalization. Disconnect is separately
    # exercised through the complete application below.
    from starlette.requests import Request
    dispatch = next(item.kwargs['dispatch'] for item in app.user_middleware
                    if item.kwargs.get('dispatch', None) is not None
                    and item.kwargs['dispatch'].__name__ == 'require_private_authentication')
    supplied = {'host': 'music.test', **headers(app, db)}
    incoming = Request({'type': 'http', 'method': 'GET', 'scheme': 'https',
        'path': '/account/goals', 'query_string': b'', 'app': app,
        'headers': [(key.encode(), value.encode()) for key, value in supplied.items()],
        'client': ('127.0.0.1', 50000), 'server': ('music.test', 443)})

    async def unexpected_next(request):
        pytest.fail('Cancelled actor resolution must not reach the route')

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(dispatch(incoming, unexpected_next))


def test_actual_disconnect_while_provider_waits_cancels_without_persisting_evidence(db, monkeypatch):
    from threading import Event
    from time import monotonic
    from music_app.services.remote_album_evidence import RemoteAlbumEvidenceError

    app = application(db)
    started, observed, finished = Event(), Event(), Event()
    group = db.group()
    before = db.snapshot()

    def waiting_provider(ref, *, user_agent, should_cancel):
        assert ref == group
        started.set()
        try:
            deadline = monotonic() + 10
            pause = Event()
            while not should_cancel():
                assert monotonic() < deadline, 'Actual disconnect must reach the provider cancellation predicate'
                pause.wait(0.01)
            observed.set()
            raise RemoteAlbumEvidenceError('provider_cancelled')
        finally:
            finished.set()

    monkeypatch.setattr(db.service, '_provider', waiting_provider)

    async def disconnected_request():
        body = json.dumps({'release_group_id': group}).encode()
        first = True
        messages = []
        supplied = {'host': 'music.test', 'content-type': 'application/json',
                    'content-length': str(len(body)), **headers(app, db)}

        async def receive():
            nonlocal first
            if first:
                first = False
                return {'type': 'http.request', 'body': body, 'more_body': False}
            # is_disconnected() performs a nonblocking receive probe. Once
            # started, supply the queued disconnect without an await checkpoint.
            if not started.is_set():
                assert await asyncio.to_thread(started.wait, 10), 'Provider must be running before disconnect'
            return {'type': 'http.disconnect'}

        async def send(message):
            messages.append(message)

        await asyncio.wait_for(app({'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
            'method': 'POST', 'scheme': 'https', 'path': '/account/goals/remote-evidence',
            'raw_path': b'/account/goals/remote-evidence', 'query_string': b'',
            'headers': [(key.encode(), value.encode()) for key, value in supplied.items()],
            'client': ('127.0.0.1', 50000), 'server': ('music.test', 443)}, receive, send), 15)
        assert await asyncio.to_thread(finished.wait, 5)
        assert observed.is_set()
        assert not any(item['type'] == 'http.response.start' and item['status'] == 200 for item in messages)

    asyncio.run(disconnected_request())
    assert db.snapshot() == before
