"""AUTHORED ONLY: genuine router/policy/service dispatch, with named I/O seams.

No execution, live authentication, database connection, SQL, or app factory is
claimed. The actor loader is a platform seam; require_action, PolicyEvaluator,
_capture authority and continuity digests are real. The service-entry cases stop
at current_library_transaction instead of fabricating successful persistence.
Separate post-worker cases replace only read_local_album_metrics' return boundary
so actual route reauthorization/response behavior can be challenged explicitly.
"""
import asyncio
from dataclasses import replace
import json
from urllib.parse import urlencode

from fastapi import FastAPI
from starlette.requests import Request
import pytest

from music_app.routes import playback_capture_asgi as routes
from music_app.services import local_album_listening as reader
from music_app.services import policy_asgi
from music_app.services.current_actor import ActorState, CurrentActor, LibraryRelationship
from music_app.services.playback_capture import CaptureError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints, PolicyEvaluator
from music_app.services.private_route_boundary import private_action_for_route, csrf_mode_for_route
from music_app.services.private_ui_context import private_ui_context_ref

PATH = '/playback/capture/position/album-metrics'


def prepared(monkeypatch, *, query=None, chunks=(), enabled=True):
    app = FastAPI()
    app.state.config = {'ALBUM_HAVEN_APP_DATABASE_URL': 'postgresql://synthetic-never-connected',
                        'ALBUM_HAVEN_POSITION_CAPTURE_ENABLED': enabled}
    app.state.auth_policy_config = {'hmac': {'secret': 'synthetic-local-metrics-route-key-32-bytes', 'key_version': 2}}
    actor = CurrentActor(state=ActorState.ACTIVE, account_id=7, session_id=11,
        is_bootstrap_owner=True, current_library_id=3,
        library_relationships=(LibraryRelationship(3, 'member', False),))
    state = {'actor': actor, 'events': [], 'storage': [], 'contexts': []}
    def constraints(context):
        state['contexts'].append(context)
        return state.get('constraints', PolicyEvaluationConstraints())
    app.state.policy_constraint_resolver = constraints
    async def load_actor(request, *, refresh=False):
        assert refresh is True
        state['events'].append('actor')
        request.state.current_actor = state['actor']
        return state['actor']
    # Replace the request actor's external loading, never require_action or the
    # policy evaluator. Denial tests below use the same genuine policy path.
    monkeypatch.setattr(policy_asgi, 'current_actor_from_request', load_actor)
    messages = iter(chunks)
    async def receive():
        state['events'].append('body')
        try:
            return {'type': 'http.request', 'body': next(messages), 'more_body': True}
        except StopIteration:
            return {'type': 'http.request', 'body': b'', 'more_body': False}
    scope = {'type': 'http', 'http_version': '1.1', 'method': 'GET', 'path': PATH,
        'raw_path': PATH.encode(), 'root_path': '', 'query_string': query if query is not None else urlencode({'album_key': 'album / one'}).encode(),
        'scheme': 'https', 'server': ('music.test', 443), 'client': ('127.0.0.1', 1),
        'app': app, 'headers': [(b'host', b'music.test')]}
    req = Request(scope, receive)
    req.state.current_actor = actor
    marker = private_ui_context_ref(req)
    scope['headers'].append((b'x-albumhaven-context', marker.encode()))
    state.update(request=req, marker=marker, resolver=constraints)
    def stop_at_transaction(*args, **kwargs):
        state['events'].append('storage')
        state['storage'].append((args, kwargs))
        raise CaptureError('capture_unavailable', 503)
    monkeypatch.setattr(reader, 'current_library_transaction', stop_at_transaction)
    app.include_router(routes.router)
    return req, state


async def dispatch(req):
    sent = []
    async def send(value):
        sent.append(value)
    await req.app(req.scope, req.receive, send)
    start = next(value for value in sent if value['type'] == 'http.response.start')
    body = b''.join(value.get('body', b'') for value in sent if value['type'] == 'http.response.body')
    return start['status'], json.loads(body), dict(start['headers'])


def run(req):
    return asyncio.run(dispatch(req))


def error(result, status, code, *, private=True):
    actual, body, headers = result
    assert actual == status
    assert body == {'ok': False, 'error': code, 'retryable': status in (429, 503)}
    if private:
        assert headers[b'cache-control'] == b'private, no-store'


def test_real_registered_get_dispatch_reaches_real_reader_transaction_entry(monkeypatch):
    req, state = prepared(monkeypatch)
    error(run(req), 503, 'capture_unavailable')
    assert state['events'] == ['actor', 'body', 'storage']
    assert isinstance(req.app.state.policy_evaluator, PolicyEvaluator)
    assert req.state.policy_evaluation.decision.allowed is True
    assert len(state['storage']) == 1
    args, kwargs = state['storage'][0]
    assert args[0] == 'postgresql://synthetic-never-connected'
    assert args[1].actor.account_id == 7 and args[1].library_id == 3
    assert args[1].action == 'library.media.read'
    assert kwargs['constraints'] is state['resolver']
    assert kwargs['read_only'] is True and kwargs['inventory_publication_first'] is True
    assert kwargs['connect'] is reader._bounded_connection


def test_registered_get_has_private_media_policy_and_no_state_changing_csrf_mode():
    matches = [route for route in routes.router.routes if route.path == PATH]
    assert len(matches) == 1 and matches[0].methods == {'GET'}
    assert matches[0].endpoint is routes.playback_local_album_metrics
    assert private_action_for_route('GET', PATH) == 'library.media.read'
    assert csrf_mode_for_route('GET', PATH) == 'none'


@pytest.mark.parametrize('enabled', [False, None, 1, 'true'])
def test_disabled_position_gate_precedes_actor_body_and_storage(monkeypatch, enabled):
    req, state = prepared(monkeypatch, enabled=enabled, chunks=[b'private'])
    error(run(req), 503, 'capture_unavailable')
    assert state['events'] == [] and state['storage'] == []


@pytest.mark.parametrize('kind', ['anonymous', 'inactive', 'constraint'])
def test_actual_policy_denies_without_body_or_storage(monkeypatch, kind):
    req, state = prepared(monkeypatch, chunks=[b'private'])
    if kind == 'anonymous':
        state['actor'] = CurrentActor.anonymous()
    elif kind == 'inactive':
        state['actor'] = replace(state['actor'], state=ActorState.INACTIVE)
    else:
        state['constraints'] = PolicyEvaluationConstraints(request_origin_allowed=False)
    error(run(req), 401 if kind in ('anonymous', 'inactive') else 403,
          'authentication_required' if kind in ('anonymous', 'inactive') else 'capture_forbidden')
    assert state['events'] == ['actor'] and state['storage'] == []
    assert req.state.policy_evaluation.decision.allowed is False


@pytest.mark.parametrize('headers', [[], [(b'x-albumhaven-context', b'wrong')],
    [(b'x-albumhaven-context', b'\xff' * 64)],
    [(b'x-albumhaven-context', b'@valid'), (b'x-albumhaven-context', b'@valid')]])
def test_context_header_is_single_ascii_server_bound_before_body(monkeypatch, headers):
    req, state = prepared(monkeypatch, chunks=[b'private'])
    req.scope['headers'] = [(b'host', b'music.test')] + [
        (key, state['marker'].encode() if value == b'@valid' else value) for key, value in headers]
    error(run(req), 409, 'capture_scope_changed')
    assert state['events'] == ['actor'] and state['storage'] == []


@pytest.mark.parametrize('query', [b'', b'other=album', b'album_key=a&album_key=b',
    b'album_key=a&extra=1', urlencode({'album_key': 'a' * 1025}).encode(),
    urlencode({'album_key': '\u00e9' * 513}).encode()])
def test_query_requires_one_bounded_utf8_album_key_before_body(monkeypatch, query):
    req, state = prepared(monkeypatch, query=query, chunks=[b'private'])
    error(run(req), 422, 'invalid_album_key')
    assert state['events'] == ['actor'] and state['storage'] == []


def test_empty_album_key_reaches_real_reader_validation_but_not_transaction(monkeypatch):
    req, state = prepared(monkeypatch, query=b'album_key=')
    error(run(req), 422, 'invalid_album_key')
    assert state['events'] == ['actor', 'body'] and state['storage'] == []


def test_1024_utf8_byte_key_reaches_transaction_instead_of_character_count_cutoff(monkeypatch):
    req, state = prepared(monkeypatch, query=urlencode({'album_key': '\u00e9' * 512}).encode())
    error(run(req), 503, 'capture_unavailable')
    assert len(state['storage']) == 1


def test_get_rejects_first_nonempty_stream_chunk_without_reading_the_remainder(monkeypatch):
    req, state = prepared(monkeypatch, chunks=[b'not permitted', b'never consumed'])
    error(run(req), 422, 'invalid_album_key')
    assert state['events'] == ['actor', 'body'] and state['storage'] == []


def test_non_get_method_is_not_dispatched_to_metrics_or_storage(monkeypatch):
    req, state = prepared(monkeypatch)
    req.scope['method'] = 'POST'
    status, _body, headers = run(req)
    assert status == 405 and headers[b'allow'] == b'GET'
    assert state['events'] == [] and state['storage'] == []


def post_worker_seam(monkeypatch, state, after=lambda: None):
    """Named response boundary only; not a successful real-database assertion."""
    calls = []
    def result(database, context, album_key, **kwargs):
        calls.append((database, context, album_key, kwargs))
        after()
        return {'ok': True, 'album_key': album_key, 'context_ref': 'must-not-be-echoed'}
    monkeypatch.setattr(reader, 'read_local_album_metrics', result)
    return calls


def test_post_worker_response_uses_recomputed_server_context_and_private_headers(monkeypatch):
    req, state = prepared(monkeypatch)
    calls = post_worker_seam(monkeypatch, state)
    status, body, headers = run(req)
    assert status == 200 and len(calls) == 1
    assert body == {'ok': True, 'album_key': 'album / one', 'context_ref': state['marker']}
    assert calls[0][3]['constraints'] is state['resolver']
    assert state['events'] == ['actor', 'body', 'actor']
    assert headers[b'cache-control'] == b'private, no-store'


@pytest.mark.parametrize('change', ['account', 'library', 'session', 'gate', 'policy'])
def test_post_worker_rechecks_actual_authority_and_context_before_reply(monkeypatch, change):
    req, state = prepared(monkeypatch)
    def after():
        if change == 'account':
            state['actor'] = replace(state['actor'], account_id=8)
        elif change == 'library':
            state['actor'] = replace(state['actor'], current_library_id=4,
                library_relationships=(LibraryRelationship(4, 'member', False),))
        elif change == 'session':
            state['actor'] = replace(state['actor'], session_id=12)
        elif change == 'gate':
            req.app.state.config['ALBUM_HAVEN_POSITION_CAPTURE_ENABLED'] = False
        else:
            state['constraints'] = PolicyEvaluationConstraints(request_origin_allowed=False)
    calls = post_worker_seam(monkeypatch, state, after)
    status = 503 if change == 'gate' else 403 if change == 'policy' else 409
    code = 'capture_unavailable' if change == 'gate' else 'capture_forbidden' if change == 'policy' else 'capture_scope_changed'
    error(run(req), status, code)
    assert len(calls) == 1 and state['storage'] == []


def test_unexpected_database_error_is_sanitized(monkeypatch):
    req, state = prepared(monkeypatch)
    def fail(*args, **kwargs):
        raise RuntimeError('private filename /music/hidden.flac token=not-for-response')
    monkeypatch.setattr(reader, 'current_library_transaction', fail)
    error(run(req), 503, 'capture_unavailable')


def test_refreshed_actor_replaces_stale_request_state_before_reader_dispatch(monkeypatch):
    req, state = prepared(monkeypatch)
    req.state.current_actor = replace(state['actor'], account_id=999, session_id=999)
    error(run(req), 503, 'capture_unavailable')
    context = state['storage'][0][0][1]
    assert context.actor.account_id == 7 and context.actor.session_id == 11


@pytest.mark.parametrize('configuration', ['missing database', 'noncallable resolver'])
def test_invalid_server_configuration_fails_before_body_and_transaction(monkeypatch, configuration):
    req, state = prepared(monkeypatch, chunks=[b'private'])
    if configuration == 'missing database':
        req.app.state.config.pop('ALBUM_HAVEN_APP_DATABASE_URL')
    else:
        req.app.state.policy_constraint_resolver = object()
    error(run(req), 503, 'capture_unavailable')
    assert state['events'] == ['actor'] and state['storage'] == []
