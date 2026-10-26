"""Four portable real-middleware cancellation regressions; no SQL/session proof.

The actor resolver and remote service/provider boundary are explicit unit doubles.
The registered Goals router, private middleware, policy, CSRF, bounded JSON parser
and cancellation watcher are real. No lifespan, socket, DB or provider IO occurs.
"""
import asyncio
from contextlib import suppress
import json
from threading import Event
from time import monotonic

import pytest
from fastapi import FastAPI

from music_app.routes.listening_goals_asgi import router
from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.current_actor import ActorState, CurrentActor
from music_app.services.listening_goals_commands import GoalsError
from music_app.services.private_route_boundary import install_private_route_boundary
from tests.py.test_owned_album_top_route_boundary import Resolver

GROUP = '10000000-0000-4000-8000-000000000001'
SECRET = 'synthetic-goals-disconnect-policy-key-32-bytes'
LOOKUPS = [
    ('evidence', '/account/goals/remote-evidence', {'release_group_id': GROUP},
     (GROUP,), {'evidence_ref': '20000000-0000-4000-8000-000000000001', 'evidence_version': 'a' * 64}),
    ('search', '/account/goals/remote-search', {'title': 'Synthetic album', 'artist': 'Synthetic artist'},
     ('Synthetic album', 'Synthetic artist'), {'limit': 10, 'candidates': []}),
]


class RemoteBoundary:
    """Forward the route's real cancellation predicate to a cooperative provider."""
    def __init__(self, result):
        self.result = result
        self.started, self.release, self.finished = Event(), Event(), Event()
        self.observed = Event()
        self.deadline_reached = False
        self.calls = []
        self.should_cancel = None
        self.cancelled_before_return = None

    def _lookup(self, kind, context, args, *, constraints, should_cancel):
        self.calls.append((kind, context, args, constraints))
        self.should_cancel = should_cancel
        self.started.set()
        try:
            deadline = monotonic() + 5
            while not should_cancel():
                if self.release.wait(0.01):
                    self.cancelled_before_return = should_cancel()
                    return self.result
                if monotonic() >= deadline:
                    # Controlled red diagnostic, not an unbounded background worker.
                    self.deadline_reached = True
                    raise GoalsError('provider_deadline', 503)
            self.observed.set()
            self.cancelled_before_return = True
            raise GoalsError('provider_cancelled', 503)
        finally:
            self.finished.set()

    def acquire_evidence(self, context, group, *, constraints, should_cancel):
        return self._lookup('evidence', context, (group,), constraints=constraints,
                            should_cancel=should_cancel)

    def search_candidates(self, context, title, artist, *, constraints, should_cancel):
        return self._lookup('search', context, (title, artist), constraints=constraints,
                            should_cancel=should_cancel)


@pytest.mark.parametrize('kind,path,payload,arguments,result', LOOKUPS, ids=['evidence', 'search'])
@pytest.mark.parametrize('connection', ['disconnected', 'connected'], ids=['disconnected', 'connected'])
def test_remote_lookup_disconnect_and_cleanup(kind, path, payload, arguments, result, connection):
    actor = CurrentActor(state=ActorState.ACTIVE, account_id=41, session_id=8)
    service = RemoteBoundary(result)
    app = FastAPI()
    app.state.config = {'ALBUM_HAVEN_DEPLOYMENT_MODE': 'self_hosted'}
    app.state.auth_policy_config = {'hmac': {'secret': SECRET, 'key_version': 1}}
    app.state.current_actor_resolver = Resolver(actor)
    app.state.listening_goals_service = service
    app.include_router(router)
    install_private_route_boundary(app)
    token = 's' * 43
    csrf = issue_session_csrf(token, app.state.auth_policy_config)
    body = json.dumps(payload).encode()
    headers = {'host': 'music.test', 'content-type': 'application/json',
               'content-length': str(len(body)), 'origin': 'https://music.test',
               'cookie': '__Host-album_haven_session=' + token + '; __Host-album_haven_csrf=' + csrf,
               'x-album-haven-csrf': csrf}

    async def scenario():
        initial_tasks = set(asyncio.all_tasks())
        first = True
        messages = []
        response_finished = asyncio.Event()
        disconnect_delivered = False

        async def receive():
            nonlocal first, disconnect_delivered
            if first:
                first = False
                return {'type': 'http.request', 'body': body, 'more_body': False}
            if connection == 'disconnected':
                if not service.started.is_set():
                    assert await asyncio.to_thread(service.started.wait, 5), 'Provider did not start'
                disconnect_delivered = True
                return {'type': 'http.disconnect'}
            await response_finished.wait()
            return {'type': 'http.disconnect'}

        async def send(message):
            messages.append(message)
            if message['type'] == 'http.response.body' and not message.get('more_body', False):
                response_finished.set()

        request = asyncio.create_task(app({
            'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
            'method': 'POST', 'scheme': 'https', 'path': path, 'raw_path': path.encode(),
            'query_string': b'', 'headers': [(k.encode(), v.encode()) for k, v in headers.items()],
            'client': ('127.0.0.1', 50000), 'server': ('music.test', 443)}, receive, send))
        try:
            assert await asyncio.to_thread(service.started.wait, 5), 'Provider did not start'
            if connection == 'connected':
                service.release.set()
            await asyncio.wait_for(request, 10)
        finally:
            # Even an unexpected assertion/transport fault must release the worker
            # and await this request's middleware/watcher teardown before returning.
            service.release.set()
            if not request.done():
                request.cancel()
                with suppress(asyncio.CancelledError):
                    await asyncio.wait_for(request, 10)
        assert service.finished.is_set(), 'Provider worker was not joined'
        await asyncio.sleep(0)
        assert not [task for task in asyncio.all_tasks()
                    if task not in initial_tasks and not task.done()], 'Request left pending watcher/middleware tasks'
        assert app.state.current_actor_resolver.tokens == [token]
        assert len(service.calls) == 1
        actual_kind, context, actual_arguments, _constraints = service.calls[0]
        assert actual_kind == kind and actual_arguments == arguments
        assert context.actor is actor and context.target_account_id == actor.account_id
        assert context.library_id is None and context.action == 'account.self.goals.write'
        assert service.should_cancel is not None and service.should_cancel(), 'Route finally did not cancel watcher'
        starts = [message for message in messages if message['type'] == 'http.response.start']
        if connection == 'connected':
            assert service.cancelled_before_return is False and not service.observed.is_set()
            assert not service.deadline_reached
            assert len(starts) == 1 and starts[0]['status'] == 200
            assert dict(starts[0]['headers'])[b'cache-control'] == b'private, no-store'
            response = b''.join(message.get('body', b'') for message in messages
                                if message['type'] == 'http.response.body')
            assert json.loads(response) == {'status': 'ready', 'data': result}
        else:
            assert not any(message['status'] == 200 for message in starts)
            # Finally-set cancellation is NOT sufficient: the running provider
            # must have observed the actual disconnect before its bounded exit.
            assert service.observed.is_set(), 'GOALS_DISCONNECT_NOT_OBSERVED_BY_PROVIDER'
            assert disconnect_delivered and not service.deadline_reached
            assert service.cancelled_before_return is True

    asyncio.run(scenario())
