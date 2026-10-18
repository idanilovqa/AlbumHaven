"""Real ASGI/authentication/SQL contracts. Source authoring is not execution.

The dedicated initializer baseline is admitted read-only by the support fixture.
Only newly owned accounts, sessions, sources and taste rows are created. No reset,
migration, provider, browser, media access or manufactured authority is involved.
Transport faults and receipt destruction are negative tests, never success stubs.
"""
import asyncio
from copy import deepcopy
import importlib
import json
import sys
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest

from music_app.routes import api_read_asgi_routes as routes
from music_app.services import library_browse_postgres as browse
from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
from music_app.services.current_actor_postgres import PostgresCurrentActorResolver
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_ui_context import private_ui_context_ref
from tests.py.album_favorites_postgres_support import favorites_bootstrap_db


CORE = {
    'album_ref', 'context_ref', 'rating', 'is_favorite', 'favorite_override',
    'favorite_source', 'taste_state', 'preference_revision', 'can_edit',
    'allowed_actions',
}
GROUPS = (
    'artist_groups', 'primary_artist_groups', 'family_artist_groups',
    'related_filter_base_primary_groups', 'related_filter_base_family_groups',
)


def album_nodes(payload):
    """Independent response traversal, including gallery and duplicate aliases."""
    pending = [payload]
    seen = set()
    while pending:
        value = pending.pop()
        if not isinstance(value, (dict, list)) or id(value) in seen:
            continue
        seen.add(id(value))
        if isinstance(value, list):
            pending.extend(value)
            continue
        if 'key' in value and ('album_id' in value or 'name' in value):
            yield value
        for key in ('album', 'albums', 'sections', 'subsections', 'duplicate_sources', *GROUPS):
            if isinstance(value.get(key), (dict, list)):
                pending.append(value[key])


def available(value, *, db, album, context, rating, favorite, revision, override=None, edit=True):
    assert set(value) == CORE, 'No legacy provenance, owner, key, or unverified progress'
    assert value == {
        'album_ref': f'inventory-album:{db.library}:{album["id"]}',
        'context_ref': context, 'rating': rating, 'is_favorite': favorite,
        'favorite_override': override,
        'favorite_source': 'personal' if override is not None else None,
        'taste_state': 'available', 'preference_revision': revision,
        'can_edit': edit, 'allowed_actions': {'can_manage_album_preferences': edit},
    }


def unavailable(value, context):
    assert value == {
        'album_ref': None, 'context_ref': context, 'rating': None,
        'is_favorite': None, 'favorite_override': None, 'favorite_source': None,
        'taste_state': 'unavailable', 'preference_revision': None,
        'can_edit': False, 'allowed_actions': {'can_manage_album_preferences': False},
    }


def private_response(response, status):
    assert response.status == status, response.body
    assert response.headers['cache-control'] == 'private, no-store'
    assert 'SQL' not in response.raw.decode('utf-8')
    return response.body


def bind_real_connections(monkeypatch, db):
    """Replace connection acquisition only; every statement still reaches PG14.

    Register imported pool aliases too: each request must release every owned
    lease before the support fixture can clean up. No SQL/result/policy double.
    """
    from music_app.services import postgres_connections
    original_pool = postgres_connections.pooled_connection

    def registered_pool(url, **kwargs):
        assert set(kwargs) <= {'workload'}
        return db.app_connect(url)

    # Direct psycopg factories used by the actual browse/detail repositories.
    for name in ('library_browse_postgres', 'library_inventory_postgres',
                 'album_ratings_postgres', 'artist_family_postgres'):
        module = importlib.import_module('music_app.services.' + name)
        monkeypatch.setattr(module, '_connect', db.app_connect)
    # Loaded aliases retain the original function object after a module import.
    for name, module in tuple(sys.modules.items()):
        if not name.startswith('music_app.') or module is None:
            continue
        for key, value in tuple(vars(module).items()):
            if value is original_pool:
                monkeypatch.setattr(module, key, registered_pool)
    monkeypatch.setattr(postgres_connections, 'pooled_connection', registered_pool)


class AuthenticatedASGI:
    """Byte/chunk HTTP driver with no automatic fake actor or CSRF injection."""
    def __init__(self, app, db):
        self.app, self.db, self.issued = app, db, {}
        self.sessions = PostgresAuthSessionService(db.config, connect=db.app_connect)
        self.resolver = PostgresCurrentActorResolver(db.config,
            session_service=self.sessions, connect=db.app_connect)
        app.state.current_actor_resolver = self.resolver
        self.issue(db.owner)
        self.issue(db.peer)

    def issue(self, actor):
        issued = self.sessions.issue_session(actor.account_id)
        self.db.sessions.add(issued.session_id)
        self.issued[actor.account_id] = issued
        resolved = self.resolver.resolve(issued.raw_token)
        assert resolved.account_id == actor.account_id
        assert resolved.session_id == issued.session_id
        assert resolved.current_library_id == self.db.library
        assert resolved.is_bootstrap_owner is False
        return resolved

    def context(self, actor=None):
        actor = actor or self.db.owner
        resolved = self.resolver.resolve(self.issued[actor.account_id].raw_token)
        return private_ui_context_ref(SimpleNamespace(
            state=SimpleNamespace(current_actor=resolved), app=self.app))

    def headers(self, actor=None):
        actor = actor or self.db.owner
        token = self.issued[actor.account_id].raw_token
        csrf = issue_session_csrf(token, self.app.state.auth_policy_config)
        return {
            'cookie': f'__Host-album_haven_session={token}; __Host-album_haven_csrf={csrf}',
            'x-album-haven-csrf': csrf, 'x-albumhaven-context': self.context(actor),
            'origin': 'https://testserver', 'content-type': 'application/json',
        }

    def request(self, method, path, *, actor=None, headers=None, query=None,
                payload=None, raw=None, chunks=None, authenticated=True):
        actor = actor or self.db.owner
        supplied = self.headers(actor) if authenticated else {}
        for key, value in (headers or {}).items():
            if value is None:
                supplied.pop(key.lower(), None)
            else:
                supplied[key.lower()] = value
        assert sum(value is not None for value in (payload, raw, chunks)) <= 1
        if payload is not None:
            raw = json.dumps(payload, separators=(',', ':'), allow_nan=False).encode()
        parts = list(chunks) if chunks is not None else [raw or b'']
        assert parts and all(type(part) is bytes for part in parts)

        async def dispatch():
            sent, consumed = [], 0
            completed = asyncio.Event()

            async def receive():
                nonlocal consumed
                if consumed < len(parts):
                    part = parts[consumed]
                    consumed += 1
                    return {'type': 'http.request', 'body': part,
                            'more_body': consumed < len(parts)}
                await completed.wait()
                return {'type': 'http.disconnect'}

            async def send(message):
                sent.append(message)
                if message['type'] == 'http.response.body' and not message.get('more_body', False):
                    completed.set()

            scope = {
                'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
                'method': method, 'scheme': 'https', 'path': path,
                'raw_path': path.encode(), 'query_string': urlencode(query or {}, doseq=True).encode(),
                'headers': [(b'host', b'testserver')] + [
                    (key.encode('latin1'), value.encode('latin1')) for key, value in supplied.items()],
                'client': ('127.0.0.1', 50000), 'server': ('testserver', 443),
            }
            # A transport timeout is a failure, not permission to clean up live SQL.
            try:
                await asyncio.wait_for(self.app(scope, receive, send), timeout=30)
            except BaseException:
                # A cancelled threadpool task might be between DB leases. An
                # empty connection registry alone does not establish its exit.
                self.db.registry.quarantine()
                raise
            start = next(message for message in sent if message['type'] == 'http.response.start')
            body = b''.join(message.get('body', b'') for message in sent
                            if message['type'] == 'http.response.body')
            return SimpleNamespace(status=start['status'], raw=body, consumed=consumed,
                headers={key.decode().lower(): value.decode() for key, value in start['headers']},
                body=json.loads(body))

        return asyncio.run(dispatch())

    def command(self, album, patch, revision=0, *, actor=None, **kwargs):
        actor = actor or self.db.owner
        try:
            return self.request('POST', '/album-preferences', actor=actor, payload={
                'album_ref': f'inventory-album:{self.db.library}:{album["id"]}',
                'expected_revision': revision, 'patch': patch,
            }, **kwargs)
        finally:
            # Covers a real commit followed by a rejected/failed publication.
            # A transport exception has no proved worker drain; do not query or
            # clean up a quarantined fixture, or mask its original exception.
            if not self.db.registry.quarantined:
                self.db.capture_owned_preferences(album, actor)


@pytest.fixture
def favorites_http(favorites_bootstrap_db, asgi_app, monkeypatch):
    db = favorites_bootstrap_db
    asgi_app.state.config.update(db.config)
    asgi_app.state.config['PERSISTENCE_BACKENDS'] = {'library_browse': 'postgres'}
    asgi_app.state.config['ALBUM_HAVEN_UTILITY_PROJECTION_PREWARM_ENABLED'] = False
    bind_real_connections(monkeypatch, db)
    client = AuthenticatedASGI(asgi_app, db)
    yield client
    assert db.registry.drained(), 'All HTTP-owned real SQL leases must drain'


@pytest.mark.parametrize('capability', ['capability.view', 'library.browse.read'])
def test_real_view_and_legacy_browse_members_can_manage_their_own_taste(favorites_http, capability):
    client, db = favorites_http, favorites_http.db
    actor = db.member(capability)
    resolved = client.issue(actor)
    assert {grant.capability_key for grant in resolved.capability_grants} == {capability, 'capability.social'}
    assert all(rel.membership_role == 'member' and not rel.is_primary_owner
               for rel in resolved.library_relationships)
    album = db.albums[0]
    result = private_response(client.command(album, {'favorite': True, 'rating': 7}, actor=actor), 200)
    assert set(result) == {'context_ref', 'album_preference'}
    assert result['context_ref'] == client.context(actor)
    available(result['album_preference'], db=db, album=album, context=result['context_ref'],
              rating=7, favorite=True, override=True, revision=1)
    stored = db.read(album, actor)
    assert stored['rating'] == 7 and stored['favorite_override'] is True
    assert db.read(album, db.peer)['preference_revision'] == 0


def test_clear_partial_patch_noop_and_old_retry_preserve_other_fields(favorites_http):
    client, db = favorites_http, favorites_http.db
    album = db.albums[0]
    first = private_response(client.command(album, {'favorite': True, 'rating': 8}), 200)
    second = private_response(client.command(album, {'rating': None}, 1), 200)
    available(second['album_preference'], db=db, album=album, context=client.context(),
              rating=None, favorite=True, override=True, revision=2)
    before = db.rows(), db.epochs()
    noop = private_response(client.command(album, {'rating': None}, 2), 200)
    assert noop == second
    assert (db.rows(), db.epochs()) == before
    private_response(client.command(album, {'favorite': False}, 2), 200)
    newest = db.rows(), db.epochs()
    private_response(client.command(album, {'favorite': True, 'rating': 8}, 0), 409)
    assert (db.rows(), db.epochs()) == newest
    assert first['album_preference']['preference_revision'] == 1
    assert db.read(album)['favorite'] is False and db.read(album)['rating'] is None


def invalid_body(case, ref):
    base = {'album_ref': ref, 'expected_revision': 0, 'patch': {'favorite': True}}
    if case == 'duplicate-root':
        return ('{"album_ref":' + json.dumps(ref) + ',"expected_revision":0,"expected_revision":1,"patch":{"favorite":true}}').encode()
    if case == 'duplicate-nested':
        return ('{"album_ref":' + json.dumps(ref) + ',"expected_revision":0,"patch":{"favorite":true,"favorite":false}}').encode()
    if case == 'duplicate-escaped':
        return ('{"album_ref":' + json.dumps(ref) + ',"expected_revision":0,"patch":{"favorite":true,"\\u0066avorite":false}}').encode()
    constants = {'nan': 'NaN', 'infinity': 'Infinity', 'negative-infinity': '-Infinity'}
    if case in constants:
        return ('{"album_ref":' + json.dumps(ref) + ',"expected_revision":0,"patch":{"rating":' + constants[case] + '}}').encode()
    raw = {'array': b'[]', 'null': b'null', 'string': b'"object"',
           'malformed': b'{', 'utf8': b'\xff', 'deep': b'[' * 1500 + b']' * 1500,
           'empty': b''}
    if case in raw:
        return raw[case]
    if case.startswith('revision-'):
        base['expected_revision'] = {'bool': True, 'float': 0.0, 'string': '0',
            'negative': -1, 'overflow': 9223372036854775808}[case[9:]]
    elif case.startswith('rating-'):
        base['patch'] = {'rating': {'bool': True, 'float': 7.0, 'string': '7',
            'low': 0, 'high': 11}[case[7:]]}
    elif case.startswith('favorite-'):
        base['patch'] = {'favorite': {'null': None, 'int': 1, 'string': 'true'}[case[9:]]}
    elif case == 'empty-patch':
        base['patch'] = {}
    elif case == 'wire-name-in-patch':
        base['patch'] = {'is_favorite': True}
    elif case == 'array-patch':
        base['patch'] = []
    elif case == 'unknown-nested':
        base['patch']['owner'] = 'someone else'
    elif case == 'spoof-account':
        base['account_id'] = 1
    elif case == 'spoof-subject':
        base['subject_ref'] = 'friend'
    elif case == 'spoof-key':
        base['album_key'] = 'other'
    elif case == 'missing-revision':
        del base['expected_revision']
    elif case == 'noncanonical-ref':
        base['album_ref'] = ref.replace('inventory-album:', 'inventory-album:0', 1)
    elif case == 'foreign-library':
        base['album_ref'] = 'inventory-album:9223372036854775807:1'
    elif case == 'remote-ref':
        base['album_ref'] = 'catalog-album:1'
    else:
        raise AssertionError(case)
    return json.dumps(base, separators=(',', ':')).encode()


@pytest.mark.parametrize('case', [
    'duplicate-root', 'duplicate-nested', 'duplicate-escaped', 'nan', 'infinity',
    'negative-infinity', 'array', 'null', 'string', 'malformed', 'utf8', 'deep', 'empty',
    'revision-bool', 'revision-float', 'revision-string', 'revision-negative', 'revision-overflow',
    'rating-bool', 'rating-float', 'rating-string', 'rating-low', 'rating-high',
    'favorite-null', 'favorite-int', 'favorite-string', 'empty-patch', 'wire-name-in-patch',
    'array-patch', 'unknown-nested', 'spoof-account', 'spoof-subject', 'spoof-key',
    'missing-revision', 'noncanonical-ref', 'foreign-library', 'remote-ref',
])
def test_strict_json_and_command_validation_do_not_write(favorites_http, case):
    client, db = favorites_http, favorites_http.db
    album = db.albums[0]
    before = db.rows(), db.epochs()
    body = invalid_body(case, f'inventory-album:{db.library}:{album["id"]}')
    private_response(client.request('POST', '/album-preferences', raw=body), 400)
    assert (db.rows(), db.epochs()) == before


def test_byte_bound_accepts_4096_and_rejects_4097_even_across_chunks(favorites_http):
    client, db = favorites_http, favorites_http.db
    album = db.albums[0]
    raw = json.dumps({'album_ref': f'inventory-album:{db.library}:{album["id"]}',
        'expected_revision': 0, 'patch': {'favorite': True}}, separators=(',', ':')).encode()
    before = db.rows(), db.epochs()
    private_response(client.request('POST', '/album-preferences',
        chunks=[raw, b' ' * (4096 - len(raw)), b' ']), 400)
    assert (db.rows(), db.epochs()) == before
    try:
        result = private_response(client.request('POST', '/album-preferences',
            chunks=[raw[:17], raw[17:], b' ' * (4096 - len(raw))]), 200)
        assert result['album_preference']['preference_revision'] == 1
    finally:
        if not db.registry.quarantined:
            db.capture_owned_preferences(album, db.owner)


@pytest.mark.parametrize('headers', [
    {'origin': 'https://untrusted.example'}, {'origin': None},
    {'x-album-haven-csrf': 'wrong'}, {'x-album-haven-csrf': None},
    {'cookie': ''},
])
def test_origin_and_csrf_fail_closed_without_writes(favorites_http, headers):
    client, db = favorites_http, favorites_http.db
    before = db.rows(), db.epochs()
    response = client.command(db.albums[0], {'favorite': True}, headers=headers)
    private_response(response, 401 if headers.get('cookie') == '' else 403)
    assert (db.rows(), db.epochs()) == before


def test_anonymous_mutation_is_private_and_never_reaches_storage(favorites_http):
    client, db = favorites_http, favorites_http.db
    before = db.rows(), db.epochs()
    response = client.request('POST', '/album-preferences', authenticated=False,
        payload={'album_ref': f'inventory-album:{db.library}:{db.albums[0]["id"]}',
                 'expected_revision': 0, 'patch': {'favorite': True}})
    private_response(response, 401)
    assert (db.rows(), db.epochs()) == before


@pytest.mark.parametrize('stamp', [None, '', '0' * 64, 'wrong'])
def test_stale_ui_context_rejects_before_write(favorites_http, stamp):
    client, db = favorites_http, favorites_http.db
    before = db.rows(), db.epochs()
    private_response(client.command(db.albums[0], {'favorite': True},
        headers={'x-albumhaven-context': stamp}), 409)
    assert (db.rows(), db.epochs()) == before


def test_other_real_session_context_cannot_authorize_current_actor_command(favorites_http):
    client, db = favorites_http, favorites_http.db
    peer_context = client.context(db.peer)
    assert peer_context != client.context(db.owner)
    before = db.rows(), db.epochs(), db.epochs(db.peer)
    private_response(client.command(db.albums[0], {'favorite': True},
        headers={'x-albumhaven-context': peer_context}), 409)
    assert (db.rows(), db.epochs(), db.epochs(db.peer)) == before


@pytest.mark.parametrize('stage', ['actor', 'policy'])
def test_early_boundary_faults_are_private_no_store(favorites_http, monkeypatch, stage):
    from music_app.services import private_route_boundary
    client, db = favorites_http, favorites_http.db
    supplied = client.headers()
    before = db.rows(), db.epochs()
    if stage == 'actor':
        async def fail_actor(_request):
            raise RuntimeError('private diagnostic must not escape')
        monkeypatch.setattr(private_route_boundary, 'current_actor_from_request', fail_actor)
    else:
        def fail_policy(_context):
            raise RuntimeError('private diagnostic must not escape')
        client.app.state.policy_constraint_resolver = fail_policy
    response = client.request('POST', '/album-preferences', authenticated=False,
        headers=supplied, raw=b'{}')
    private_response(response, 503)
    assert b'private diagnostic' not in response.raw
    assert (db.rows(), db.epochs()) == before


@pytest.mark.parametrize('scope', ['browse', 'manage', 'album'])
def test_current_policy_denies_mutation_using_actual_evaluator(favorites_http, scope):
    client, db = favorites_http, favorites_http.db
    album = db.albums[0]
    def constraints(context):
        denied = (scope == 'browse' and context.action == 'library.browse.read'
            or scope == 'manage' and context.action == 'library.album_preferences.manage'
            or scope == 'album' and context.resource is not None
                and context.resource.resource_kind == 'album'
                and context.resource.resource_ref == str(album['id']))
        return PolicyEvaluationConstraints(deployment_allowed=not denied)
    client.app.state.policy_constraint_resolver = constraints
    before = db.rows(), db.epochs()
    private_response(client.command(album, {'favorite': True}), 403)
    assert (db.rows(), db.epochs()) == before


def test_revoked_durable_view_grant_is_not_replaced_by_cached_actor(favorites_http):
    client, db = favorites_http, favorites_http.db
    headers = client.headers()
    with db.connect() as con:
        con.execute("update app.capabilities set revoked_at=now() where account_id=%s and scope_id=%s and capability_key='capability.view'",
                    (db.owner.account_id, db.library))
    before = db.rows(), db.epochs()
    response = client.request('POST', '/album-preferences', authenticated=False,
        headers=headers, payload={'album_ref': f'inventory-album:{db.library}:{db.albums[0]["id"]}',
                                 'expected_revision': 0, 'patch': {'favorite': True}})
    private_response(response, 403)
    assert (db.rows(), db.epochs()) == before


def test_missing_active_source_returns_non_disclosing_private_404(favorites_http):
    client, db = favorites_http, favorites_http.db
    album = db.albums[0]
    with db.connect() as con:
        con.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true'::jsonb) where id=%s",
                    (album['file'],))
    before = db.rows(), db.epochs()
    result = private_response(client.command(album, {'favorite': True}), 404)
    assert 'album_preference' not in result
    assert (db.rows(), db.epochs()) == before


def test_post_commit_policy_change_suppresses_success_and_read_reconciles(favorites_http, monkeypatch):
    from music_app.services.album_preferences_postgres import PostgresAlbumPreferencesStore
    client, db = favorites_http, favorites_http.db
    original = PostgresAlbumPreferencesStore.patch_preference
    def commit_then_deny(self, *args, **kwargs):
        result = original(self, *args, **kwargs)
        client.app.state.policy_constraint_resolver = lambda context: PolicyEvaluationConstraints(
            deployment_allowed=context.action != 'library.album_preferences.manage')
        return result
    monkeypatch.setattr(PostgresAlbumPreferencesStore, 'patch_preference', commit_then_deny)
    private_response(client.command(db.albums[0], {'favorite': True}), 403)
    state = db.read(db.albums[0])
    assert state['favorite'] is True and state['preference_revision'] == 1
    # A post-commit error is not a rollback or permission to replay revision zero.
    client.app.state.policy_constraint_resolver = lambda _context: PolicyEvaluationConstraints()
    private_response(client.command(db.albums[0], {'favorite': False}), 409)
    assert db.read(db.albums[0])['favorite'] is True


def test_post_commit_newer_write_is_not_published_as_the_older_success(favorites_http, monkeypatch):
    from music_app.services.album_preferences import parse_album_preference_command
    from music_app.services.album_preferences_postgres import PostgresAlbumPreferencesStore
    client, db = favorites_http, favorites_http.db
    original = PostgresAlbumPreferencesStore.patch_preference
    def commit_then_newer(self, command, **kwargs):
        first = original(self, command, **kwargs)
        newer = parse_album_preference_command({
            'album_ref': f'inventory-album:{db.library}:{command.album_id}',
            'expected_revision': first['preference_revision'], 'patch': {'favorite': False},
        }, library_id=db.library)
        second = original(self, newer, **kwargs)
        assert second['favorite'] is False and second['preference_revision'] == 2
        return first
    monkeypatch.setattr(PostgresAlbumPreferencesStore, 'patch_preference', commit_then_newer)
    response = client.command(db.albums[0], {'favorite': True})
    private_response(response, 409)
    assert 'album_preference' not in response.body
    state = db.read(db.albums[0])
    assert state['favorite'] is False and state['preference_revision'] == 2


def test_final_request_actor_change_discards_already_committed_response(favorites_http, monkeypatch):
    client, db = favorites_http, favorites_http.db
    original = routes._commit_album_preference
    def commit_then_switch(request, *args, **kwargs):
        result = original(request, *args, **kwargs)
        request.state.current_actor = client.resolver.resolve(client.issued[db.peer.account_id].raw_token)
        return result
    monkeypatch.setattr(routes, '_commit_album_preference', commit_then_switch)
    response = client.command(db.albums[0], {'favorite': True})
    private_response(response, 409)
    assert 'album_preference' not in response.body
    assert db.read(db.albums[0])['favorite'] is True
    assert db.read(db.albums[0], db.peer)['preference_revision'] == 0


def browse_request(client, surface, *, actor=None):
    album, db = client.db.albums[0], client.db
    if surface == 'detail':
        return client.request('GET', '/album-details', actor=actor, query={'album_key': album['key']})
    query = {'surface': 'albums', 'payload_tier': 'full'}
    if surface == 'selected':
        with db.connect() as con:
            query['artist'] = con.execute('select name from library.local_artists where id=%s',
                                         (album['artist'],)).fetchone()['name']
    elif surface == 'search':
        query.update(q='Favorite Album initial', payload_tier='search_preview')
    else:
        assert surface == 'root'
    return client.request('GET', '/view-data', actor=actor, query=query)


def matching_albums(payload, album):
    values = [value for value in album_nodes(payload) if value.get('key') == album['key']]
    assert values, 'The genuine production row must be present; empty output is not a pass'
    return values


@pytest.mark.parametrize('surface', ['root', 'selected', 'search', 'detail'])
def test_real_browse_and_detail_project_opposing_actors_not_bootstrap(favorites_http, surface):
    client, db = favorites_http, favorites_http.db
    album = db.albums[0]
    db.seed(album, actor=db.bootstrap_owner, rating=10, favorite=True)
    db.patch(album, {'rating': 8, 'favorite': True})
    db.patch(album, {'rating': 2, 'favorite': False}, actor=db.peer)
    before = db.rows(), db.epochs(), db.epochs(db.peer)
    for actor, rating, favorite in ((db.owner, 8, True), (db.peer, 2, False), (db.owner, 8, True)):
        body = private_response(browse_request(client, surface, actor=actor), 200)
        for value in matching_albums(body, album):
            available(value['album_preference'], db=db, album=album, context=client.context(actor),
                      rating=rating, favorite=favorite, override=favorite, revision=1)
            assert value['album_rating'] == rating
            summary = (value.get('gallery_list_block') or {}).get('summary')
            if summary is not None:
                assert summary['album_preference'] == value['album_preference']
                assert summary['album_rating'] == rating
            assert not set(value) & {'album_rating_provenance', 'favorite_override',
                'preference_revision', 'album_preference_overlay', 'to_listen', 'is_relisten'}
        assert 'album_preference_receipt' not in json.dumps(body)
    assert client.context(db.owner) != client.context(db.peer)
    assert (db.rows(), db.epochs(), db.epochs(db.peer)) == before


@pytest.mark.parametrize('surface', ['root', 'selected', 'detail'])
def test_no_row_is_available_unrated_false_without_bootstrap_fallback(favorites_http, surface):
    client, db = favorites_http, favorites_http.db
    album = db.albums[0]
    db.seed(album, actor=db.bootstrap_owner, rating=10, favorite=True)
    body = private_response(browse_request(client, surface), 200)
    for value in matching_albums(body, album):
        available(value['album_preference'], db=db, album=album, context=client.context(),
                  rating=None, favorite=False, revision=0)
        assert value['album_rating'] is None
    assert db.read(album)['preference_id'] is None


@pytest.mark.parametrize('denied', ['browse', 'manage'])
def test_exact_album_policy_is_rechecked_for_browse_projection(favorites_http, denied):
    client, db = favorites_http, favorites_http.db
    album = db.albums[0]
    db.patch(album, {'rating': 6, 'favorite': True})
    action = 'library.browse.read' if denied == 'browse' else 'library.album_preferences.manage'
    client.app.state.policy_constraint_resolver = lambda context: PolicyEvaluationConstraints(
        deployment_allowed=not(context.action == action and context.resource is not None
            and context.resource.resource_kind == 'album'
            and context.resource.resource_ref == str(album['id'])))
    body = private_response(browse_request(client, 'root'), 200)
    for value in matching_albums(body, album):
        if denied == 'browse':
            unavailable(value['album_preference'], client.context())
        else:
            available(value['album_preference'], db=db, album=album, context=client.context(),
                      rating=6, favorite=True, override=True, revision=1, edit=False)


def replace_album_objects(payload, transform):
    """Destroy provenance only in a negative producer-output perturbation."""
    memo = {}
    def visit(value):
        if not isinstance(value, (dict, list)):
            return value
        if id(value) in memo:
            return memo[id(value)]
        if isinstance(value, list):
            result = []
            memo[id(value)] = result
            result.extend(visit(item) for item in value)
            return result
        result = transform(value) if type(value) is browse.AlbumPreferenceCandidate else dict(value)
        memo[id(value)] = result
        for key, item in tuple(result.items()):
            result[key] = visit(item)
        return result
    return visit(payload)


@pytest.mark.parametrize('damage', ['plain-copy', 'wrong-displayed-id', 'wrong-displayed-key', 'missing'])
def test_genuine_candidate_with_lost_or_mismatched_evidence_is_unavailable(favorites_http, monkeypatch, damage):
    client, db = favorites_http, favorites_http.db
    album = db.albums[0]
    db.patch(album, {'rating': 9, 'favorite': True})
    original = browse.PostgresLibraryBrowseRepository.build_root_album_browse_payload
    produced = []
    def damaged(self, **kwargs):
        payload = original(self, **kwargs)
        # This method recurses once to borrow a real production transaction.
        if kwargs.get('_connection') is None and kwargs.get('_artist_loved_roots') is not None:
            return payload
        produced.append(deepcopy(payload))
        def transform(value):
            assert value.album_preference_receipt == (db.library, album['id'], album['key'])
            result = dict(value) if damage == 'plain-copy' else deepcopy(value)
            result['album_preference'] = {'rating': 10, 'is_favorite': True,
                'can_edit': True, 'to_listen': True, 'is_relisten': True,
                'can_toggle_to_listen': True, 'context_ref': 'stale-bootstrap'}
            result['album_rating'] = 10
            result['favorite'] = True
            result['gallery_list_block'] = {'summary': dict(result['album_preference'])}
            if damage == 'wrong-displayed-id':
                result['album_id'] = album['id'] + 1000000
            elif damage == 'wrong-displayed-key':
                result['key'] = album['key'] + ':different'
            elif damage == 'missing':
                result['inventory_status'] = 'missing'
            return result
        return replace_album_objects(payload, transform)
    monkeypatch.setattr(browse.PostgresLibraryBrowseRepository, 'build_root_album_browse_payload', damaged)
    body = private_response(browse_request(client, 'root'), 200)
    assert produced and list(album_nodes(body))
    for value in album_nodes(body):
        unavailable(value['album_preference'], client.context())
        assert value['album_rating'] is None
        assert 'favorite' not in value
        assert value['gallery_list_block']['summary']['album_preference'] == value['album_preference']
        assert 'to_listen' not in value['gallery_list_block']['summary']
    # The route may only personalize its clone, never the retained producer object.
    assert 'stale-bootstrap' not in json.dumps(produced)


def test_real_row_candidate_deepcopy_preserves_receipt_but_plain_copy_loses_it(favorites_http):
    client, db = favorites_http, favorites_http.db
    repository = browse.PostgresLibraryBrowseRepository(client.app.state.config, connect=db.app_connect)
    payload = repository.build_root_album_browse_payload(query_params={'surface': 'albums'})
    source = next(value for value in album_nodes(payload) if value.get('key') == db.albums[0]['key'])
    assert type(source) is browse.AlbumPreferenceCandidate
    receipt = source.album_preference_receipt
    cloned = deepcopy(source)
    assert cloned is not source and cloned.album_preference_receipt is receipt
    assert receipt == (db.library, db.albums[0]['id'], db.albums[0]['key'])
    plain = dict(source)
    assert not hasattr(plain, 'album_preference_receipt')
    assert 'album_preference_receipt' not in json.dumps(source)
    with pytest.raises((AttributeError, TypeError)):
        cloned.album_preference_receipt = receipt


def test_real_transient_legacy_overlay_cannot_restore_bootstrap_taste(favorites_http, monkeypatch):
    """Exercise the real transient overlay before final receiptless projection.

    File-backed metadata has no canonical SQL receipt. This test deliberately
    destroys a genuine producer's receipt before that exact final transient seam;
    it does not manufacture an active scanner or read a real media file.
    """
    client, db = favorites_http, favorites_http.db
    album = db.albums[0]
    db.seed(album, actor=db.bootstrap_owner, rating=10, favorite=True)
    db.patch(album, {'rating': 3, 'favorite': True})
    build = browse.PostgresLibraryBrowseRepository.build_root_album_browse_payload
    project = routes._private_browse_response
    transient_overlay = routes._apply_transient_scan_album_rating_overlays
    observed = []
    def receiptless(self, **kwargs):
        return replace_album_objects(build(self, **kwargs), dict)
    def transient(request, payload, **kwargs):
        return project(request, payload, transient=True)
    def observe_overlay(request, albums):
        observed.extend(value['key'] for value in albums)
        return transient_overlay(request, albums)
    monkeypatch.setattr(browse.PostgresLibraryBrowseRepository, 'build_root_album_browse_payload', receiptless)
    monkeypatch.setattr(routes, '_private_browse_response', transient)
    monkeypatch.setattr(routes, '_apply_transient_scan_album_rating_overlays', observe_overlay)
    body = private_response(browse_request(client, 'root'), 200)
    assert album['key'] in observed, 'The real transient legacy loader must execute'
    for value in matching_albums(body, album):
        unavailable(value['album_preference'], client.context())
        assert value['album_rating'] is None


def test_actual_family_membership_and_decorator_keep_canonical_lineage(favorites_http, monkeypatch):
    """B1 regression: execute the real lossy-copy site, not just its decorator.

    Exact rows come from PostgreSQL. The direct family call intentionally avoids
    changing shared baseline relation metadata. Full family-discovery setup is a
    separate acceptance obligation; no relation-ready receipt is manufactured.
    """
    client, db = favorites_http, favorites_http.db
    album = db.albums[0]
    db.patch(album, {'favorite': True, 'rating': 4})
    repository = browse.PostgresLibraryBrowseRepository(client.app.state.config, connect=db.app_connect)
    with db.app_connect(db.app_url) as con:
        view = browse._root_sidebar_view_state({'surface': 'albums'})
        rows = repository._load_root_album_browse_rows(view, connection=con)
    own_rows = [row for row in rows if row['album_id'] == album['id']]
    assert own_rows and all(row['library_id'] == db.library for row in own_rows)
    family = browse._selected_artist_family_groups_from_preview_rows(
        [own_rows[0]['artist_name']], own_rows, alias_to_canonical={}, canonical_to_aliases={})
    candidates = list(album_nodes({'family_artist_groups': family}))
    assert candidates, 'Real membership selection must return the owned album'
    assert all(type(value) is browse.AlbumPreferenceCandidate for value in candidates)
    for value in candidates:
        assert value.album_preference_receipt == (db.library, album['id'], album['key'])
    original = browse.PostgresLibraryBrowseRepository.build_root_album_browse_payload
    retained = []
    def with_actual_family(self, **kwargs):
        payload = original(self, **kwargs)
        payload['family_artist_groups'] = family
        payload['related_filter_base_family_groups'] = family
        retained.append(deepcopy(payload))
        return payload
    monkeypatch.setattr(browse.PostgresLibraryBrowseRepository, 'build_root_album_browse_payload', with_actual_family)
    result = private_response(browse_request(client, 'root'), 200)
    family_values = list(album_nodes({'family_artist_groups': result['family_artist_groups']}))
    assert family_values
    for value in family_values:
        available(value['album_preference'], db=db, album=album, context=client.context(),
                  rating=4, favorite=True, override=True, revision=1)
    # The shared unpersonalized producer graph is still distinct from the result.
    assert retained and all(value.get('album_preference', {}).get('taste_state') != 'available'
                            for value in album_nodes(retained[-1]))


def test_unpaged_startup_producer_uses_same_final_actor_projection(favorites_http, monkeypatch):
    client, db = favorites_http, favorites_http.db
    album = db.albums[0]
    db.seed(album, actor=db.bootstrap_owner, rating=10, favorite=True)
    db.patch(album, {'rating': 3, 'favorite': False})
    # Unpaged preview avoids the unrelated asynchronous gallery snapshot writer.
    # Both this real producer and the normal final HTTP projector remain intact.
    def startup(self, **kwargs):
        return self.build_root_startup_preview_payload(
            query_params={'surface': 'albums'}, library_state=client.app.state.library_state,
            _artist_loved_roots=kwargs.get('_artist_loved_roots'))
    monkeypatch.setattr(browse.PostgresLibraryBrowseRepository, 'build_root_album_browse_payload', startup)
    body = private_response(browse_request(client, 'root'), 200)
    for value in matching_albums(body, album):
        available(value['album_preference'], db=db, album=album, context=client.context(),
                  rating=3, favorite=False, override=False, revision=1)


def test_captured_generation_cannot_rebind_to_recreated_same_key(favorites_http, monkeypatch):
    client, db = favorites_http, favorites_http.db
    old = db.albums[0]
    repository = browse.PostgresLibraryBrowseRepository(client.app.state.config, connect=db.app_connect)
    captured = repository.build_root_album_browse_payload(query_params={'surface': 'albums'})
    prior = matching_albums(captured, old)
    assert all(type(value) is browse.AlbumPreferenceCandidate for value in prior)
    with db.connect() as con:
        con.execute('delete from library.local_tracks where id=%s and library_id=%s', (old['track'], db.library))
        con.execute('delete from library.local_albums where id=%s and library_id=%s', (old['id'], db.library))
        con.execute('delete from library.local_artists where id=%s and library_id=%s', (old['artist'], db.library))
    replacement = db.add_album('initial')
    assert replacement['key'] == old['key'] and replacement['id'] != old['id']
    db.patch(replacement, {'rating': 9, 'favorite': True})
    # An actual retained producer object, never a recreated candidate receipt.
    monkeypatch.setattr(browse.PostgresLibraryBrowseRepository, 'build_root_album_browse_payload',
                        lambda self, **kwargs: captured)
    body = private_response(browse_request(client, 'root'), 200)
    for value in matching_albums(body, old):
        unavailable(value['album_preference'], client.context())
        assert value['album_rating'] is None
    assert db.read(replacement)['favorite'] is True
    assert all(value.get('album_preference', {}).get('taste_state') != 'available' for value in prior)


def test_1001_genuine_candidates_fail_closed_without_chunk_fallback(favorites_http, monkeypatch):
    from music_app.services import album_preferences_postgres
    client, db = favorites_http, favorites_http.db
    for number in range(1000):
        db.add_album('budget-' + str(number))
    assert len(db.albums) == 1001
    db.patch(db.albums[0], {'rating': 9, 'favorite': True})
    admitted = []
    original = album_preferences_postgres.load_album_preferences_on_connection
    def observe(connection, **kwargs):
        admitted.append(tuple(kwargs['album_ids']))
        return original(connection, **kwargs)
    monkeypatch.setattr(album_preferences_postgres, 'load_album_preferences_on_connection', observe)
    body = private_response(browse_request(client, 'root'), 200)
    values = list(album_nodes(body))
    assert {value['album_id'] for value in values} == {album['id'] for album in db.albums}
    assert admitted == [()], 'The whole-request bound must not become a succession of chunks'
    context = client.context()
    for value in values:
        unavailable(value['album_preference'], context)


def test_public_sanitizer_strips_personal_core_progress_and_summary_without_mutation():
    from music_app.services.library import strip_private_album_preference_overlays
    personal = {key: 'private-sentinel' for key in (
        'album_preference', 'album_preference_overlay', 'album_rating', 'rating',
        'album_rating_source', 'album_rating_provenance', 'rating_provenance',
        'provenance', 'favorite', 'is_favorite', 'album_favorite', 'favorite_override',
        'favorite_source', 'taste_state', 'preference_revision', 'can_edit',
        'can_edit_preferences', 'can_manage_album_preferences', 'inventory_album_ref',
        'canonical_album_ref', 'preference_context_ref', 'context_ref',
        'to_listen', 'is_relisten', 'can_toggle_to_listen', '_album_taste_stamp',
    )}
    personal.update(album_ref='inventory-album:1:2', tag_album_rating=5,
        tag_album_rating_source='file_tag', name='Visible metadata',
        allowed_actions={'can_manage_album_preferences': True,
                         'can_toggle_to_listen': True, 'can_read': True})
    source = {**deepcopy(personal), 'gallery_list_block': {'summary': deepcopy(personal)},
              'duplicate_sources': [deepcopy(personal)]}
    before = deepcopy(source)
    result = strip_private_album_preference_overlays(source)
    assert source == before
    assert result is not source and result['gallery_list_block'] is not source['gallery_list_block']
    for value in (result, result['gallery_list_block']['summary'], result['duplicate_sources'][0]):
        assert not set(value) & (set(personal) - {
            'tag_album_rating', 'tag_album_rating_source', 'name', 'allowed_actions'})
        assert value['tag_album_rating'] == 5 and value['tag_album_rating_source'] == 'file_tag'
        assert value['name'] == 'Visible metadata'
        assert value['allowed_actions'] == {'can_read': True}
    assert 'private-sentinel' not in json.dumps(result)
