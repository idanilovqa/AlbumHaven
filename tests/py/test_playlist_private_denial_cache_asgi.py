"""23 portable cache-perimeter cases: real middleware, unit actor/store doubles.

No durable-session/SQL proof, DB fixture, lifespan, network or external provider.
Registered Playlist routes, policy evaluation, CSRF and response middleware are real.
The two explicit sentinel endpoints observe unchanged unrelated/public boundaries.
"""
import asyncio

import pytest
from fastapi import Depends, FastAPI
from fastapi.responses import JSONResponse

from music_app.routes import owned_playlists_asgi as routes
from music_app.services.current_actor import CurrentActor
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import install_private_route_boundary
from tests.py.owned_playlist_testing import PLAYLIST, REQUEST, context, create_body
from tests.py.test_owned_album_top_route_boundary import Resolver, asgi_response, mutation_headers
from tests.py.test_owned_playlist_route_boundary import Service, request


class Preferences:
    """Only the repository/service boundary is doubled; no policy result is supplied."""
    def __init__(self):
        self.calls = []
        self.constructed = []

    def factory(self, config):
        self.constructed.append(config)
        return self

    def read(self, supplied, *, constraints):
        self.calls.append(('read', supplied, None))
        return {'remember_order_mode': True, 'last_order_mode': 'regular',
                'effective_order_mode': 'regular', 'revision': '1'}

    def execute(self, supplied, command, *, constraints):
        self.calls.append(('execute', supplied, command))
        return {'ok': True, 'request_key': command.request_key, 'preferences': {'revision': '2'}}

    def read_operation(self, supplied, key, *, constraints):
        self.calls.append(('operation', supplied, key))
        return {'status': 'unknown'}


@pytest.fixture
def boundary(monkeypatch):
    service, preferences = Service(), Preferences()
    configured = request(service).app.state
    app = FastAPI()
    app.state.config = configured.config
    app.state.auth_policy_config = configured.auth_policy_config
    app.state.owned_playlists_service = service
    app.state.current_actor_resolver = Resolver(context().actor)
    monkeypatch.setattr(routes, 'PostgresPlaylistPreferencesService', preferences.factory)
    entered = []

    def observe_route_entry():
        entered.append('playlist_route')

    # Observer supplies no actor, policy result, authorization or service response.
    app.include_router(routes.router, dependencies=[Depends(observe_route_entry)])

    @app.get('/unrelated-private')
    def unrelated():
        entered.append('unrelated')
        return {'ok': True}

    @app.get('/public/album-tops/{share_ref}')
    def public_sentinel(share_ref: str):
        entered.append('public')
        return JSONResponse({'share_ref': share_ref}, headers={'Cache-Control': 'public, max-age=60'})

    install_private_route_boundary(app)
    return app, service, preferences, entered


def exercise(boundary, *, method, path, payload, preference, failure):
    app, service, preferences, entered = boundary
    actor = app.state.current_actor_resolver.actor
    headers = mutation_headers(app, actor)
    if failure == 'anonymous':
        app.state.current_actor_resolver.actor = CurrentActor.anonymous()
        headers = {}
    elif failure == 'missing_csrf':
        headers.pop('x-album-haven-csrf')
    elif failure == 'forbidden':
        if preference:
            # Own-account preferences are intrinsic. Dropping Browse must not
            # deny them; an existing narrowing constraint is the valid denial.
            app.state.policy_constraint_resolver = lambda _context: PolicyEvaluationConstraints(
                deployment_allowed=False)
        else:
            app.state.current_actor_resolver.actor = context(grants=()).actor
    status, body, response_headers = asyncio.run(asgi_response(
        app, method, path, headers=headers, payload=payload))
    assert app.state.current_actor_resolver.tokens == [None if failure == 'anonymous' else 's' * 43]
    if failure != 'valid':
        expected = {'anonymous': (401, 'Authentication required.'),
                    'missing_csrf': (403, 'CSRF validation failed.'),
                    'forbidden': (403, 'Action not permitted.')}[failure]
        assert status == expected[0]
        assert body == {'detail': expected[1]}
        assert entered == [] and service.calls == [] and preferences.calls == []
        assert preferences.constructed == []
    else:
        assert status == 200, body
        assert entered == ['playlist_route']
        calls = preferences.calls if preference else service.calls
        assert len(calls) == 1
        other_calls = service.calls if preference else preferences.calls
        assert other_calls == []
        assert len(preferences.constructed) == (1 if preference else 0)
        assert body['context_ref'] == headers['x-albumhaven-context']
        call = calls[0]
        assert call[1].actor is actor
        if method in {'POST', 'PATCH', 'PUT'}:
            assert call[0] == 'execute'
            command = call[2]
            assert command.request_key == REQUEST
            if preference:
                assert command.data == {'revision': '1', 'last_order_mode': 'shuffle'}
                assert body['preferences'] == {'revision': '2'}
            else:
                assert command.action == ('create' if method == 'POST' else 'save')
                assert command.playlist_ref == (None if method == 'POST' else PLAYLIST)
                receipt = body['data'] if method == 'POST' else body
                assert receipt['action'] == command.action and receipt['request_key'] == REQUEST
                assert receipt['playlist_id'] == PLAYLIST and receipt['changed'] is True
                if method == 'PATCH':
                    assert command.data == {'revision': '7', 'title': 'Changed'}
        elif '/operations/' in path:
            assert call[0] == 'operation' and call[2] == REQUEST
            assert body == {'status': 'unknown', 'context_ref': headers['x-albumhaven-context']}
        else:
            assert call[0] == 'read'
            assert body['remember_order_mode'] is True and body['revision'] == '1'
    # Last assertion preserves diagnostic proof that the intended fence ran.
    assert response_headers.get(b'cache-control') == b'private, no-store'


@pytest.mark.parametrize('method,path,payload,preference', [
    ('POST', '/playlists', create_body(), False),
    ('PATCH', '/playlists/' + PLAYLIST,
     {'request_key': REQUEST, 'revision': '7', 'title': 'Changed'}, False),
    ('PUT', '/account/playlist-preferences',
     {'request_key': REQUEST, 'revision': '1', 'last_order_mode': 'shuffle'}, True),
], ids=['create', 'update', 'account-preference-write'])
@pytest.mark.parametrize('failure', ['anonymous', 'missing_csrf', 'forbidden', 'valid'],
                         ids=['anonymous', 'missing_csrf', 'forbidden', 'valid'])
def test_private_playlist_write_cache_fences(boundary, method, path, payload, preference, failure):
    exercise(boundary, method=method, path=path, payload=payload, preference=preference, failure=failure)


@pytest.mark.parametrize('path,preference', [
    ('/playlists/operations/' + REQUEST, False),
    ('/account/playlist-preferences', True),
    ('/account/playlist-preferences/operations/' + REQUEST, True),
], ids=['operation-receipt', 'account-preference-read', 'account-preference-receipt'])
@pytest.mark.parametrize('failure', ['anonymous', 'forbidden', 'valid'],
                         ids=['anonymous', 'forbidden', 'valid'])
def test_private_playlist_read_cache_fences(boundary, path, preference, failure):
    exercise(boundary, method='GET', path=path, payload=None, preference=preference, failure=failure)


def test_unrelated_private_auth_denial_does_not_acquire_playlist_cache_policy(boundary):
    app, service, preferences, entered = boundary
    app.state.current_actor_resolver.actor = CurrentActor.anonymous()
    status, body, headers = asyncio.run(asgi_response(app, 'GET', '/unrelated-private'))
    assert status == 401 and body == {'detail': 'Authentication required.'}
    assert b'cache-control' not in headers
    assert entered == [] and service.calls == [] and preferences.calls == []
    assert app.state.current_actor_resolver.tokens == [None]


def test_enabled_public_share_keeps_public_cache_and_bypasses_private_policy(boundary):
    app, service, preferences, entered = boundary
    app.state.config.update(ALBUM_HAVEN_PUBLIC_SHARING_ENABLED=True,
                            ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN='https://music.test')
    app.state.current_actor_resolver.actor = CurrentActor.anonymous()
    status, body, headers = asyncio.run(asgi_response(app, 'GET', '/public/album-tops/' + PLAYLIST))
    assert status == 200 and body == {'share_ref': PLAYLIST}
    assert headers[b'cache-control'] == b'public, max-age=60'
    assert entered == ['public'] and app.state.current_actor_resolver.tokens == []
    assert service.calls == [] and preferences.calls == []
