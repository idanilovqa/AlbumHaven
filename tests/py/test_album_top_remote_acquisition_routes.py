"""Private Top acquisition HTTP and cancellation contracts.

The real router, middleware, context, R-A service and PostgreSQL authority run in
these tests. Only provider results and the authenticated actor-resolution seam
are synthetic; no provider HTTP or app factory/config import is needed.
"""
import asyncio
from dataclasses import replace
from datetime import timedelta
import json
from threading import Event
from uuid import uuid4

import pytest
from starlette.requests import Request

from music_app.routes import owned_album_tops_asgi as routes
from music_app.services import album_top_remote_acquisition as acquisition
from music_app.services.current_actor import CurrentActor, ActorState
from music_app.services.owned_album_tops import BROWSE, CREATE, ITEMS
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import csrf_mode_for_route, private_action_for_route
from music_app.services.private_ui_context import private_ui_context_ref
from music_app.services.remote_album_evidence import RemoteAlbumEvidenceError
from tests.py.test_owned_album_top_route_boundary import middleware_app, mutation_headers
from tests.py.test_album_top_collaboration_postgres import member, write, new_session
from tests.py.remote_top_postgres_support import db, urls, remote, payload, prepared_payload, destination, evidence
from tests.py.test_owned_album_tops_postgres import assert_error

SEARCH = '/album-top-catalog/remote-search'
ACQUIRE = '/album-top-catalog/remote-acquisitions'
PATHS = (SEARCH, ACQUIRE)


def body_for(path, command):
    return ({'destination': command['destination'], 'title': 'Remote album', 'artist': ''}
            if path == SEARCH else command)


def application(remote, current=None):
    app = middleware_app(remote.db.service, current or remote.db.owner)
    app.state.album_top_remote_acquisition_service = remote.service
    app.state.config['MUSICBRAINZ_USER_AGENT'] = 'AlbumHaven-Synthetic-Contract/1.0'
    return app


def http_command(remote, app, path, target=None, *, actor=None, context_ref=None):
    """Prepare only acquisition, using the actual request actor/context binding."""
    actor = actor or remote.db.owner
    if path == SEARCH:
        return payload(target)
    ref = context_ref or mutation_headers(app, actor)['x-albumhaven-context']
    return remote.prepare_v2(target, actor=actor, context_ref=ref)


async def response(app, method, path, *, headers=None, payload=None, raw=None, extra_headers=(),
                   query=b'', declared_length=None):
    """Actual ASGI request, preserving duplicate header bytes and connection life."""
    content = (b'' if payload is None else json.dumps(payload).encode()) if raw is None else raw
    received = False
    finished = asyncio.Event()
    messages = []

    async def receive():
        nonlocal received
        if not received:
            received = True
            return {'type': 'http.request', 'body': content, 'more_body': False}
        await finished.wait()
        return {'type': 'http.disconnect'}

    async def send(message):
        messages.append(message)
        if message['type'] == 'http.response.body' and not message.get('more_body', False):
            finished.set()

    fields = {'host': 'music.test', 'content-type': 'application/json',
              'content-length': str(len(content)) if declared_length is None else declared_length,
              **(headers or {})}
    raw_headers = [(key.encode('ascii'), value.encode('latin1')) for key, value in fields.items()]
    raw_headers.extend(extra_headers)
    await app({'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
        'method': method, 'scheme': 'https', 'path': path, 'raw_path': path.encode(),
        'query_string': query, 'headers': raw_headers,
        'client': ('127.0.0.1', 50000), 'server': ('music.test', 443)}, receive, send)
    start = next(value for value in messages if value['type'] == 'http.response.start')
    data = b''.join(value.get('body', b'') for value in messages if value['type'] == 'http.response.body')
    return start['status'], json.loads(data) if data else None, dict(start['headers'])


def call(app, path, **options):
    return asyncio.run(response(app, 'POST', path, **options))


def ready(result):
    status, body, headers = result
    assert status == 200 and body['status'] == 'ready'
    assert headers[b'cache-control'] == b'private, no-store'
    assert body['data']['context_ref'] == body['context_ref']
    return body['data']


def test_complete_current_top_route_inventory_and_csrf_includes_exact_new_posts():
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
        ('POST', SEARCH): BROWSE,
        ('POST', ACQUIRE): BROWSE,
        ('POST', '/album-top-catalog/remote-preparations'): BROWSE,
        ('GET', '/album-top-catalog/remote-preparations'): BROWSE,
        ('POST', '/album-top-catalog/remote-preparations/maintain'): BROWSE,
        ('POST', '/album-top-catalog/remote-preparations/{preparation_ref}/close'): BROWSE,
    }
    actual = {(method, route.path) for route in routes.router.routes for method in route.methods}
    assert actual == set(expected)
    for (method, path), action in expected.items():
        assert private_action_for_route(method, path) == action
        assert csrf_mode_for_route(method, path) == ('none' if method in {'GET', 'HEAD'} else 'session_header')
    for path in PATHS:
        for method in ('GET', 'HEAD', 'PUT', 'PATCH', 'DELETE'):
            assert private_action_for_route(method, path) is None
        for alias in (path + '/', path.upper(), path + '/extra'):
            assert private_action_for_route('POST', alias) is None


@pytest.mark.parametrize('path', PATHS)
def test_exact_private_route_uses_real_service_and_server_context_without_top_or_goals_writes(remote, path):
    app = application(remote)
    auth = mutation_headers(app, remote.db.owner)
    command = http_command(remote, app, path)
    before = remote.unrelated()
    data = ready(call(app, path, headers=auth, payload=body_for(path, command)))
    assert data['context_ref'] == auth['x-albumhaven-context']
    assert data['destination'] == command['destination']
    summary = data['candidates'][0] if path == SEARCH else data['album']
    assert summary['source_kind'] == 'remote_summary'
    assert summary['metadata_coverage'] == 'album_summary_only'
    assert summary['track_metadata_status'] == 'unavailable' and summary['track_count'] is None
    assert not {'tracks', 'artwork', 'album_ref', 'catalog_ref', 'local_path', 'media_ref'} & summary.keys()
    assert len(remote.calls) == 1 and remote.unrelated() == before
    if path == SEARCH:
        assert data['limit'] == 10 and len(data['candidates']) == 1
        assert 'acquisition_ref' not in data and remote.rows() == []
    else:
        assert data['request_key'] == command['request_key']
        assert data['version'] == 2 and data['state'] == 'pending'
        assert data['preparation_ref'] == command['preparation_ref']
        row = remote.rows()[0]
        assert str(row['ref']) == data['acquisition_ref']
        assert str(row['preparation_ref']) == command['preparation_ref']
        state = remote.c2_state()
        assert state['album_top_remote_attempts'][0]['state'] == 'pending'
        assert state['album_top_remote_preparations'][0]['pending_count'] == 1
        assert state['album_top_remote_preparations'][0]['attempt_count'] == 1
        assert state['album_top_remote_pending_budgets'][0]['pending_bytes'] == row['facts_bytes']
        assert row['context_ref'] == auth['x-albumhaven-context']
        assert row['original_session_id'] == remote.db.owner.session_id
        assert row['actor_account_id'] == row['destination_owner_account_id'] == remote.db.owner.account_id
        assert (row['expires_at'] - row['created_at']).total_seconds() == 1800


@pytest.mark.parametrize('path', PATHS)
def test_default_composition_reuses_top_owner_and_existing_musicbrainz_user_agent(remote, monkeypatch, path):
    app = application(remote)
    del app.state.album_top_remote_acquisition_service
    monkeypatch.setattr(acquisition, 'fetch_release_group_evidence', remote.provider)
    monkeypatch.setattr(acquisition, 'search_release_group_candidates', remote.searcher)
    data = ready(call(app, path, headers=mutation_headers(app, remote.db.owner),
                      payload=body_for(path, http_command(remote, app, path))))
    assert data['context_ref'] and len(remote.calls) == 1
    assert remote.calls[0][-1]['user_agent'] == app.state.config['MUSICBRAINZ_USER_AGENT']


@pytest.mark.parametrize('path', PATHS)
@pytest.mark.parametrize('role', ['editor', 'viewer', 'server_reader', 'private_stranger'])
def test_actual_named_editor_can_prepare_but_read_access_alone_cannot(remote, path, role):
    current = member(remote.db)
    top, _ = remote.db.create(refs=[])
    if role in {'editor', 'viewer'}:
        top, _ = write(remote.db, 'grant_' + role, top, account_id=current.account_id, role=role)
    elif role == 'server_reader':
        top, _ = write(remote.db, 'visibility', top, visibility='server_shared')
    app = application(remote, current)
    auth = mutation_headers(app, current)
    if path == ACQUIRE and role == 'editor':
        command = http_command(remote, app, path, destination(top), actor=current)
    else:
        command = payload(destination(top))
        if path == ACQUIRE:
            command = {'version': 2, 'preparation_ref': str(uuid4()), **command}
            assert_error(lambda: remote.begin_v2(destination(top), actor=current,
                context_ref=auth['x-albumhaven-context']),
                'top_unavailable' if role == 'private_stranger' else 'forbidden',
                404 if role == 'private_stranger' else 403)
    before = remote.unrelated()
    c2_before = remote.c2_state()
    result = call(app, path, headers=mutation_headers(app, current), payload=body_for(path, command))
    if role == 'editor':
        data = ready(result)
        assert data['destination'] == destination(top) and len(remote.calls) == 1
        if path == ACQUIRE:
            assert remote.rows()[0]['actor_account_id'] == current.account_id
            assert remote.rows()[0]['destination_owner_account_id'] == remote.db.owner.account_id
    else:
        status, body, headers = result
        assert status == (404 if role == 'private_stranger' else 403)
        assert body['error'] == ('top_unavailable' if role == 'private_stranger' else 'forbidden')
        assert headers[b'cache-control'] == b'private, no-store'
        assert remote.calls == [] and remote.rows() == []
        assert remote.c2_state() == c2_before
    assert remote.unrelated() == before


@pytest.mark.parametrize('path', PATHS)
@pytest.mark.parametrize('failure', ['anonymous', 'inactive', 'browse', 'csrf', 'origin', 'context', 'missing_context'])
def test_real_private_perimeter_refuses_before_provider_or_pending_write(remote, path, failure):
    current = (CurrentActor.anonymous() if failure == 'anonymous' else
               replace(remote.db.owner, state=ActorState.INACTIVE) if failure == 'inactive' else
               member(remote.db, grants=()) if failure == 'browse' else remote.db.owner)
    app = application(remote, current)
    auth = mutation_headers(app, remote.db.owner)
    command = http_command(remote, app, path)
    c2_before = remote.c2_state()
    if failure == 'csrf':
        auth.pop('x-album-haven-csrf')
    elif failure == 'origin':
        auth['origin'] = 'https://other.test'
    elif failure == 'context':
        auth['x-albumhaven-context'] = '0' * 64
    elif failure == 'missing_context':
        auth.pop('x-albumhaven-context')
    before = remote.unrelated()
    status, body, headers = call(app, path, headers=auth, payload=body_for(path, command))
    assert status == (401 if failure in {'anonymous', 'inactive'} else 409 if 'context' in failure else 403)
    assert headers[b'cache-control'] == b'private, no-store'
    assert remote.calls == [] and remote.rows() == [] and remote.unrelated() == before

    assert remote.c2_state() == c2_before


@pytest.mark.parametrize('path', PATHS)
@pytest.mark.parametrize('duplicate', ['same', 'different', 'comma_joined', 'mixed_case'])
def test_exact_single_context_header_is_required(remote, path, duplicate):
    app = application(remote)
    auth = mutation_headers(app, remote.db.owner)
    ref = auth['x-albumhaven-context']
    command = http_command(remote, app, path)
    c2_before = remote.c2_state()
    extra = []
    if duplicate == 'comma_joined':
        auth['x-albumhaven-context'] = ref + ', ' + ref
    elif duplicate == 'mixed_case':
        extra = [(b'X-AlbumHaven-Context', ref.encode())]
    else:
        extra = [(b'x-albumhaven-context', (ref if duplicate == 'same' else '0' * 64).encode())]
    status, body, headers = call(app, path, headers=auth, extra_headers=extra, payload=body_for(path, command))
    assert status == 409 and body == {'ok': False, 'error': 'stale_context'}
    assert headers[b'cache-control'] == b'private, no-store'
    assert remote.calls == [] and remote.rows() == []

    assert remote.c2_state() == c2_before


@pytest.mark.parametrize('path', PATHS)
@pytest.mark.parametrize('field', ['account', 'session', 'library'])
def test_old_private_context_cannot_be_reused_for_current_actor_scope(remote, path, field):
    old = remote.db.owner
    current = member(remote.db) if field == 'account' else new_session(remote.db, old) if field == 'session' else None
    if field == 'library':
        with remote.db.connect() as connection:
            library = remote.db.library_for(connection, old)
            current = remote.db.member(connection, old, library)
    app = application(remote, current)
    auth = mutation_headers(app, current)
    auth['x-albumhaven-context'] = mutation_headers(app, old)['x-albumhaven-context']
    command = http_command(remote, app, path, actor=old, context_ref=auth['x-albumhaven-context'])
    c2_before = remote.c2_state()
    status, body, headers = call(app, path, headers=auth, payload=body_for(path, command))
    assert status == 409 and body['error'] == 'stale_context'
    assert headers[b'cache-control'] == b'private, no-store'
    assert remote.calls == [] and remote.rows() == []

    assert remote.c2_state() == c2_before


@pytest.mark.parametrize('path', PATHS)
@pytest.mark.parametrize('case', ['extra_authority', 'extra_facts', 'missing_destination', 'invalid_destination',
                                 'query', 'nonobject', 'malformed', 'oversized', 'declared_large', 'invalid_length'])
def test_bounded_exact_input_never_reaches_provider(remote, path, case):
    app = application(remote)
    body = body_for(path, http_command(remote, app, path))
    c2_before = remote.c2_state()
    options = {'payload': body}
    expected = 422
    if case == 'extra_authority':
        body['context_ref'] = 'a' * 64
    elif case == 'extra_facts':
        body['album'] = {'title': 'Fabricated', 'tracks': []}
    elif case == 'missing_destination':
        body.pop('destination')
    elif case == 'invalid_destination':
        body['destination'] = {'kind': 'create', 'draft_ref': '00000000-0000-0000-0000-000000000000'}
    elif case == 'query':
        options['query'] = b'owner=1'
    elif case == 'nonobject':
        options['raw'] = b'[]'
    elif case == 'malformed':
        options['raw'] = b'{'
    elif case == 'oversized':
        options['raw'] = b' ' * 4097
        expected = 413
    elif case == 'declared_large':
        options['declared_length'] = '4097'
        expected = 413
    else:
        options['declared_length'] = 'invalid'
    status, response_body, headers = call(app, path, headers=mutation_headers(app, remote.db.owner), **options)
    assert status == expected
    assert response_body['error'] == ('command_too_large' if expected == 413 else 'invalid_command')
    assert headers[b'cache-control'] == b'private, no-store'
    assert remote.calls == [] and remote.rows() == []

    assert remote.c2_state() == c2_before


@pytest.mark.parametrize('path', PATHS)
def test_exact_body_limit_accepts_existing_valid_shape(remote, path):
    app = application(remote)
    body = json.dumps(body_for(path, http_command(remote, app, path))).encode()
    data = ready(call(app, path, headers=mutation_headers(app, remote.db.owner),
                      raw=body + b' ' * (4096 - len(body))))
    assert data['context_ref'] and len(remote.calls) == 1


def test_search_artist_is_optional_but_title_and_provider_bounds_are_real(remote):
    app = application(remote)
    auth = mutation_headers(app, remote.db.owner)
    command = payload()
    data = ready(call(app, SEARCH, headers=auth, payload={'destination': command['destination'], 'title': 'Album'}))
    assert data['limit'] == 10 and remote.calls[-1][2] == ''
    before = len(remote.calls)
    for changes in ({'title': ''}, {'title': 'x' * 101}, {'artist': None}, {'artist': 'x' * 101}):
        status, body, headers = call(app, SEARCH, headers=auth, payload={**body_for(SEARCH, command), **changes})
        assert status == 422 and body['error'] == 'invalid_search_query'
        assert headers[b'cache-control'] == b'private, no-store'
    assert len(remote.calls) == before and remote.rows() == []


@pytest.mark.parametrize('path', PATHS)
@pytest.mark.parametrize('method,suffix', [('GET', ''), ('HEAD', ''), ('PUT', ''), ('POST', '/extra'), ('POST', '/')])
def test_other_methods_and_aliases_never_enter_preparation(remote, path, method, suffix):
    app = application(remote)
    command = payload() if path == SEARCH else {'version': 2, 'preparation_ref': str(uuid4()), **payload()}
    before = remote.unrelated(), remote.c2_state()
    status, body, headers = asyncio.run(response(app, method, path + suffix,
        headers=mutation_headers(app, remote.db.owner), payload=body_for(path, command)))
    assert status == 403
    assert body == {'detail': 'Action not permitted.'}
    assert headers[b'cache-control'] == b'private, no-store'
    assert remote.calls == [] and remote.rows() == []

    assert (remote.unrelated(), remote.c2_state()) == before


def test_exact_acquisition_http_retry_returns_first_facts_without_provider_refresh(remote):
    app = application(remote)
    auth = mutation_headers(app, remote.db.owner)
    command = http_command(remote, app, ACQUIRE)
    first = ready(call(app, ACQUIRE, headers=auth, payload=command))
    before = remote.rows()
    c2_before = remote.c2_state()
    remote.facts = evidence(title='Later provider title')
    assert ready(call(app, ACQUIRE, headers=auth, payload=command)) == first
    assert len(remote.calls) == 1 and remote.rows() == before
    status, body, headers = call(app, ACQUIRE, headers=auth,
                                payload={**command, 'destination': destination()})
    assert status == 409 and body['error'] == 'remote_evidence_unavailable'
    assert len(remote.calls) == 1 and remote.rows() == before

    status, body, headers = call(app, ACQUIRE, headers=auth, payload={**command, 'release_group_id': str(uuid4())})
    assert status == 409 and body['error'] == 'request_key_conflict'
    assert headers[b'cache-control'] == b'private, no-store'
    assert len(remote.calls) == 1 and remote.rows() == before and remote.c2_state() == c2_before


# Expired expansion moved to remote_consumption_expiry_acceptance.py; unexecuted.
@pytest.mark.parametrize('state', ['retired'])
def test_http_expired_or_retired_retry_never_refreshes_provider_evidence(remote, state):
    app = application(remote)
    auth = mutation_headers(app, remote.db.owner)
    command = http_command(remote, app, ACQUIRE)
    acquired = ready(call(app, ACQUIRE, headers=auth, payload=command))
    remote.retire_pending(acquired['acquisition_ref'])
    before = remote.rows(), remote.c2_state()
    assert before[0][0]['context_ref'] == auth['x-albumhaven-context'] and before[0][0]['retired_at'] is not None
    status, body, headers = call(app, ACQUIRE, headers=auth, payload=command)
    assert status == 409 and body['error'] == 'remote_preparation_unavailable'
    assert headers[b'cache-control'] == b'private, no-store'
    assert len(remote.calls) == 1 and (remote.rows(), remote.c2_state()) == before


@pytest.mark.parametrize('path', PATHS)
@pytest.mark.parametrize('action', [BROWSE, CREATE, ITEMS])
@pytest.mark.parametrize('stage', ['before', 'after_provider'])
def test_actual_current_action_constraints_fence_provider_and_response(remote, path, action, stage):
    top = remote.db.create(refs=[])[0] if action == ITEMS else None
    changed = [stage == 'before']
    def constraints(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not (changed[0] and context.action == action))
    app = application(remote)
    command = http_command(remote, app, path, destination(top))
    c2_before = remote.c2_state()
    app.state.policy_constraint_resolver = constraints
    remote.provider_hook = lambda: changed.__setitem__(0, True)
    before = remote.unrelated()
    status, body, headers = call(app, path, headers=mutation_headers(app, remote.db.owner),
                                payload=body_for(path, command))
    assert status == 403
    assert headers[b'cache-control'] == b'private, no-store'
    assert len(remote.calls) == (0 if stage == 'before' else 1)
    assert remote.rows() == [] and remote.unrelated() == before

    if path == ACQUIRE and stage == 'after_provider':
        assert remote.c2_state() == next(iter(remote.reservation_states.values()))
    else:
        assert remote.c2_state() == c2_before


def test_final_session_expiry_after_actual_http_insert_rolls_back_pending(remote):
    app = application(remote)
    command = http_command(remote, app, ACQUIRE)
    now = [remote.db.now]
    remote.db.service._clock = lambda: now[0]
    inserted = []
    def after(sql, connection):
        if sql.startswith('select app.finish_top_remote_attempt('):
            inserted.append(connection.execute('select count(*) as n from app.album_top_remote_acquisitions where actor_account_id=%s',
                                               (remote.db.owner.account_id,)).fetchone()['n'])
            now[0] += timedelta(days=2)
    remote.after_statement = after
    before = remote.unrelated()
    status, body, headers = call(app, ACQUIRE, headers=mutation_headers(app, remote.db.owner), payload=command)
    assert status == 403 and body['error'] == 'forbidden'
    assert headers[b'cache-control'] == b'private, no-store'
    assert inserted == [1] and remote.rows() == [] and remote.unrelated() == before

    assert remote.c2_state() == next(iter(remote.reservation_states.values()))


@pytest.mark.parametrize('path', PATHS)
@pytest.mark.parametrize('error_kind', ['provider', 'unexpected', 'actor_resolver'])
def test_service_and_early_perimeter_failures_remain_private_no_store(remote, path, error_kind):
    app = application(remote)
    command = http_command(remote, app, path)
    c2_before = remote.c2_state()
    failure_calls = []
    def fail(*args, **options):
        failure_calls.append((args, options))
        if error_kind == 'provider':
            raise RemoteAlbumEvidenceError('provider_unavailable')
        raise RuntimeError('must not expose provider URLs or private exception details')
    if error_kind == 'actor_resolver':
        app.state.current_actor_resolver.resolve = fail
    else:
        remote.service.provider = remote.service.searcher = fail
    status, body, headers = call(app, path, headers=mutation_headers(app, remote.db.owner), payload=body_for(path, command))
    assert status == 503
    if path == ACQUIRE and error_kind == 'provider':
        context_ref = mutation_headers(app, remote.db.owner)['x-albumhaven-context']
        expected = {**command, 'context_ref': context_ref, 'state': 'failed', 'error': 'provider_unavailable'}
        expected.pop('release_group_id')
        assert body == {'status': 'ready', 'data': expected, 'context_ref': context_ref}
        state = remote.c2_state()
        assert state['album_top_remote_attempts'][0]['state'] == 'failed'
        assert state['album_top_remote_preparations'][0]['attempt_count'] == 1
        budget = state['album_top_remote_pending_budgets'][0]
        assert budget['pending_count'] == budget['pending_bytes'] == budget['reservation_count'] == 0
        assert call(app, path, headers=mutation_headers(app, remote.db.owner), payload=command) == (status, body, headers)
        assert remote.c2_state() == state and len(failure_calls) == 1
    else:
        assert body == {'ok': False, 'error': 'provider_unavailable' if error_kind == 'provider' else 'remote_acquisition_unavailable'}
        if path == ACQUIRE and error_kind == 'unexpected':
            assert remote.c2_state()['album_top_remote_attempts'][0]['state'] == 'reserved'
        else:
            assert remote.c2_state() == c2_before
    assert headers[b'cache-control'] == b'private, no-store'
    assert remote.rows() == []


def test_acquisition_route_enforces_prepared_pending_capacity_before_provider(remote):
    app = application(remote)
    auth = mutation_headers(app, remote.db.owner)
    command = http_command(remote, app, ACQUIRE)
    parent, target = {'preparation_ref': command['preparation_ref']}, command['destination']
    for _ in range(512):
        body = prepared_payload(parent, target)
        reservation = remote.reserve_v2(body, context_ref=auth['x-albumhaven-context'])
        assert reservation['dispatch'] is True
        remote.finish_v2(body, reservation, context_ref=auth['x-albumhaven-context'])
    before = remote.rows(), remote.c2_state(), remote.unrelated()
    status, body, headers = call(app, ACQUIRE, headers=auth, payload=command)
    assert status == 429 and body['status'] == 'ready'
    assert body['data']['state'] == 'limit' and body['data']['resource'] == 'attempts'
    assert body['data']['error'] == 'remote_acquisition_limit'
    assert body['data']['version'] == 2 and body['data']['preparation_ref'] == command['preparation_ref']
    assert body['data']['context_ref'] == body['context_ref'] == auth['x-albumhaven-context']
    assert headers[b'cache-control'] == b'private, no-store'
    assert remote.calls == [] and (remote.rows(), remote.c2_state(), remote.unrelated()) == before
    # Real reclaimable-state maintenance_required is independently preserved by
    # A's resource-specific progress contracts; this full live parent is limit.


def test_new_preparation_http_does_not_activate_generic_typed_membership_or_remote_read(remote):
    from music_app.services.owned_album_tops import normalize_top_command
    app = application(remote)
    auth = mutation_headers(app, remote.db.owner)
    command = http_command(remote, app, ACQUIRE)
    acquired = ready(call(app, ACQUIRE, headers=auth, payload=command))
    create = {'request_key': str(uuid4()), 'title': 'Private gated remote Top',
        'draft_ref': command['destination']['draft_ref'],
        'selections': [{'kind': 'remote_acquisition', 'acquisition_ref': acquired['acquisition_ref'],
                        'evidence_version': acquired['evidence_version']}]}
    before = remote.unrelated()
    status, body, headers = call(app, '/album-tops', headers=auth, payload=create)
    assert status == 409 and body['error'] == 'remote_membership_unavailable'
    assert headers[b'cache-control'] == b'private, no-store'
    assert remote.unrelated() == before and len(remote.calls) == 1
    # Only this explicit server-side test setup invokes the already reviewed R-B
    # gate. The actual GET must still refuse instead of returning a legacy draft.
    saved = remote.db.service.execute(remote.db.context(), normalize_top_command('create', create),
                                      context_ref=auth['x-albumhaven-context'])
    before = remote.unrelated()
    status, body, headers = asyncio.run(response(app, 'GET', '/album-tops/' + saved['top_ref'], headers=auth))
    assert status == 409 and body['error'] == 'remote_membership_unavailable'
    assert headers[b'cache-control'] == b'private, no-store'
    assert remote.unrelated() == before and len(remote.calls) == 1


def direct_request(app, current, path, command, disconnected, *, observer_error=False):
    """Real Request whose connection stays live until the explicit test event."""
    auth = mutation_headers(app, current)
    content = json.dumps(body_for(path, command)).encode()
    consumed = False
    async def receive():
        nonlocal consumed
        if not consumed:
            consumed = True
            return {'type': 'http.request', 'body': content, 'more_body': False}
        if disconnected.is_set():
            return {'type': 'http.disconnect'}
        await asyncio.sleep(60)
        return {'type': 'http.disconnect'}
    req = Request({'type': 'http', 'method': 'POST', 'path': path, 'raw_path': path.encode(),
        'scheme': 'https', 'app': app, 'query_string': b'', 'state': {'current_actor': current},
        'headers': [(key.encode(), value.encode()) for key, value in {
            'host': 'music.test', 'content-type': 'application/json', 'content-length': str(len(content)), **auth}.items()],
        'client': ('127.0.0.1', 50000), 'server': ('music.test', 443)}, receive)
    if observer_error:
        async def failed_observer():
            raise RuntimeError('Observer failed')
        req.is_disconnected = failed_observer
    return req


def assert_watcher_retired():
    assert not [task for task in asyncio.all_tasks() if not task.done()
                and getattr(task.get_coro(), '__name__', '') == '_watch_remote_disconnect']


@pytest.mark.parametrize('path', PATHS)
@pytest.mark.parametrize('point', ['before_provider', 'during_provider', 'after_insert', 'observer_failure'])
def test_real_disconnect_or_observer_failure_prevents_pending_commit_and_retires_watcher(remote, path, point):
    if path == SEARCH and point == 'after_insert':
        # This variant observes the final authority phase rather than an insert:
        # search is read-only and must never invent a write just for a test.
        point = 'after_final_read'
    app = application(remote)
    command = http_command(remote, app, path)
    c2_before = remote.c2_state()
    commit_start = len(remote.reservation_commits)
    disconnected = Event()
    if point == 'before_provider':
        disconnected.set()
    req = direct_request(app, remote.db.owner, path, command, disconnected,
                         observer_error=point == 'observer_failure')
    after_boundary = []
    def cancel_during_provider():
        if point == 'during_provider':
            disconnected.set()
            token = remote.calls[-1][-1]['should_cancel']
            for _ in range(300):
                if token():
                    return
                Event().wait(0.01)
            raise AssertionError('Actual disconnect watcher did not signal cancellation')
    remote.provider_hook = cancel_during_provider
    def after(sql, connection):
        boundary = sql.startswith('select app.finish_top_remote_attempt(')
        if point == 'after_final_read':
            boundary = bool(remote.calls) and sql.startswith('select capability_key,scope_kind,scope_id from app.capabilities')
        if boundary and point in {'after_insert', 'after_final_read'}:
            after_boundary.append(sql)
            disconnected.set()
            token = remote.calls[-1][-1]['should_cancel']
            for _ in range(300):
                if token():
                    return
                Event().wait(0.01)
            raise AssertionError('Actual disconnect watcher did not observe the final boundary')
    remote.after_statement = after
    before = remote.unrelated()
    async def run():
        result = await (routes.search_album_top_remote(req) if path == SEARCH else routes.acquire_album_top_remote(req))
        assert_watcher_retired()
        return result
    result = asyncio.run(run())
    assert result.status_code == 503
    assert json.loads(result.body) == {'ok': False, 'error': 'provider_cancelled'}
    assert result.headers['cache-control'] == 'private, no-store'
    assert remote.rows() == [] and remote.unrelated() == before
    if point in {'after_insert', 'after_final_read'}:
        assert after_boundary
    if remote.calls:
        assert remote.calls[-1][-1]['should_cancel']()

    committed = remote.reservation_commits[commit_start:]
    if path == ACQUIRE and committed:
        assert len(committed) == 1
        assert remote.c2_state() == committed[0][1]
        assert committed[0][1]['album_top_remote_attempts'][0]['state'] == 'reserved'
    else:
        assert remote.c2_state() == c2_before


@pytest.mark.parametrize('path', PATHS)
def test_handler_preserves_task_cancellation_and_retires_actual_watcher(remote, path):
    app = application(remote)
    command = http_command(remote, app, path)
    entered, release, completed = Event(), Event(), Event()
    operation_name = 'search_candidates' if path == SEARCH else 'acquire'
    original = getattr(remote.service, operation_name)
    def observed_operation(*args, **options):
        try:
            return original(*args, **options)
        finally:
            completed.set()
    setattr(remote.service, operation_name, observed_operation)
    def blocked_provider():
        entered.set()
        assert release.wait(5), 'Cancellation test did not release its provider'
    remote.provider_hook = blocked_provider
    req = direct_request(app, remote.db.owner, path, command, Event())
    async def run():
        task = asyncio.create_task(routes.search_album_top_remote(req) if path == SEARCH else routes.acquire_album_top_remote(req))
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
            assert remote.calls[-1][-1]['should_cancel']()
        finally:
            release.set()
            if not task.done():
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
    asyncio.run(run())
    # The actual operation completion, not a momentary absence of connections
    # during provider I/O, proves the worker has retired before fixture cleanup.
    assert completed.wait(5)
    assert not remote.active_connections and remote.rows() == []

    if path == ACQUIRE:
        assert remote.c2_state() == next(iter(remote.reservation_states.values()))


@pytest.mark.parametrize('path', PATHS)
def test_completed_preparation_is_never_rewrapped_in_a_replaced_request_context(remote, path):
    app = application(remote)
    original_actor = remote.db.owner
    command = http_command(remote, app, path, actor=original_actor)
    req = direct_request(app, original_actor, path, command, Event())
    original_ref = private_ui_context_ref(req)
    replacement = new_session(remote.db, original_actor)
    remote.provider_hook = lambda: setattr(req.state, 'current_actor', replacement)
    async def run():
        result = await (routes.search_album_top_remote(req) if path == SEARCH else routes.acquire_album_top_remote(req))
        assert_watcher_retired()
        return result
    result = asyncio.run(run())
    assert private_ui_context_ref(req) != original_ref
    assert result.status_code == 409 and json.loads(result.body) == {'ok': False, 'error': 'stale_context'}
    assert result.headers['cache-control'] == 'private, no-store'
    assert len(remote.calls) == 1
    if path == ACQUIRE:
        # The old authenticated operation may already have committed. A changed
        # request identity cannot receive that DTO under the replacement context.
        assert len(remote.rows()) == 1
        assert remote.rows()[0]['context_ref'] == original_ref
        assert remote.rows()[0]['original_session_id'] == original_actor.session_id
    else:
        assert remote.rows() == []


@pytest.mark.parametrize('identity', ['https://other.test/release-group/id', 123,
                                     '00000000-0000-0000-0000-000000000000'])
def test_acquisition_identity_cannot_be_a_provider_url_or_fabricated_native_id(remote, identity):
    app = application(remote)
    command = {**http_command(remote, app, ACQUIRE), 'release_group_id': identity}
    c2_before = remote.c2_state()
    status, body, headers = call(app, ACQUIRE, headers=mutation_headers(app, remote.db.owner), payload=command)
    assert status == 422 and body['error'] == 'invalid_release_group_id'
    assert headers[b'cache-control'] == b'private, no-store'
    assert remote.calls == [] and remote.rows() == []

    assert remote.c2_state() == c2_before
