"""Real mounted popularity HTTP boundary; source-only authored, not executed.

Uses the real current-actor/session resolver, real policy, and runtime-role SQL.
The unmodified resolver selects the supported bootstrap library for a real member.
No application bootstrap, configuration module, or handler-only perimeter proof.
"""
import asyncio
from dataclasses import replace
import json
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest
from starlette.requests import Request

from tests.py.popularity_search_postgres_support import (
    mix_urls, popular_db, owner, SECRET, assert_wire, assert_native,
)

PATHS = {
    'bindings': '/search/popularity-native-bindings',
    'single': '/search/popularity-native-target',
    'batch': '/search/popularity-native-targets',
}
METHODS = ('read', 'project_bindings', 'resolve_target', 'resolve_targets')


def search_error(payload, code='invalid_private_search_request', status=400, location=None):
    assert payload == {'ok': False, 'error_code': code,
        'error': 'Invalid search request.' if status == 400 else 'Search is unavailable.',
        'location': location}


async def exchange(app, method, path, *, query, headers, chunks):
    """Drive actual ASGI middleware/router, including streaming without a length.

    Keep the connection open until the last response body. Premature disconnect
    can cancel a BaseHTTPMiddleware response and hide a perimeter regression.
    """
    sent, index, complete = [], 0, asyncio.Event()
    async def receive():
        nonlocal index
        if index < len(chunks):
            body = chunks[index]
            index += 1
            return {'type': 'http.request', 'body': body, 'more_body': index < len(chunks)}
        await complete.wait()
        return {'type': 'http.disconnect'}
    async def send(message):
        sent.append(message)
        if message['type'] == 'http.response.body' and not message.get('more_body', False):
            complete.set()
    await app({'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
        'method': method, 'scheme': 'http', 'path': path, 'raw_path': path.encode('ascii'),
        'query_string': urlencode(query or {}, doseq=True).encode('ascii'),
        'headers': [(b'host', b'testserver'), *[(k.encode('ascii'), v.encode('latin1')) for k, v in headers.items()]],
        'client': ('192.0.2.10', 50000), 'server': ('testserver', 80)}, receive, send)
    start = next(item for item in sent if item['type'] == 'http.response.start')
    response_headers = {k.decode().lower(): v.decode() for k, v in start['headers']}
    raw = b''.join(item.get('body', b'') for item in sent if item['type'] == 'http.response.body')
    return start['status'], response_headers, raw


@pytest.fixture
def mounted_popularity(popular_db):
    from fastapi import FastAPI
    from music_app.routes.api_read_asgi_routes import router
    from music_app.services.auth_session_csrf import issue_session_csrf
    from music_app.services.auth_tokens import issue_opaque_token
    from music_app.services.current_actor_postgres import PostgresCurrentActorResolver
    from music_app.services.private_route_boundary import install_private_route_boundary
    from music_app.services.private_ui_context import private_ui_context_ref

    db = popular_db
    issued = issue_opaque_token()
    with db.connect() as con:
        con.execute('update app.account_sessions set session_token_hash=%s where id=%s',
                    (issued.digest, db.owner.session_id))
        con.execute('update app.capabilities set revoked_at=clock_timestamp() where account_id=%s',
                    (db.owner.account_id,))
        con.execute("""insert into app.capabilities(account_id,capability_key,scope_kind,scope_id)
            values(%s,'capability.view','library',%s)""", (db.owner.account_id, db.library))
    app = FastAPI()
    app.state.config = {**db.config, 'ALBUM_HAVEN_DEPLOYMENT_MODE': 'self_hosted'}
    app.state.auth_policy_config = {'hmac': {'secret': SECRET, 'key_version': 1}}
    app.state.library_state = {}
    from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
    sessions = PostgresAuthSessionService(app.state.config, connect=db.app_connect)
    resolver = PostgresCurrentActorResolver(app.state.config, connect=db.app_connect, session_service=sessions)
    app.state.current_actor_resolver = resolver
    app.state.private_popularity_search_service = owner(db)
    app.include_router(router)
    install_private_route_boundary(app)
    current = resolver.resolve(issued.raw)
    assert current.current_library_id == db.library
    assert any(item.library_id == db.library for item in current.library_relationships)
    assert current.is_authenticated and not current.is_bootstrap_owner
    assert [(g.capability_key, g.scope_kind, g.scope_id) for g in current.capability_grants] == [
        ('capability.view', 'library', db.library)]
    csrf = issue_session_csrf(issued.raw, app.state.auth_policy_config)
    context = private_ui_context_ref(Request({'type': 'http', 'method': 'GET', 'path': '/view-data',
        'app': app, 'state': {'current_actor': current}, 'headers': [], 'query_string': b''}))
    f = SimpleNamespace(app=app, db=db, context=context)
    def call(path='/view-data', *, method=None, body=None, raw=None, chunks=None, query=None, change_headers=None):
        method = method or ('POST' if path != '/view-data' else 'GET')
        headers = {'cookie': f'__Host-album_haven_session={issued.raw}; __Host-album_haven_csrf={csrf}',
            'origin': 'http://testserver', 'x-album-haven-csrf': csrf, 'x-albumhaven-context': context}
        if body is not None or raw is not None or chunks is not None:
            headers['content-type'] = 'application/json'
        for key, value in (change_headers or {}).items():
            if value is None:
                headers.pop(key, None)
            else:
                headers[key] = value
        if chunks is None:
            chunks = [raw if raw is not None else json.dumps(body).encode() if body is not None else b'']
        status, response_headers, wire = asyncio.run(exchange(app, method, path, query=query,
            headers=headers, chunks=chunks))
        assert {'private', 'no-store'} <= {v.strip() for v in response_headers.get('cache-control', '').split(',')}
        assert SECRET not in wire.decode() and 'postgresql://' not in wire.decode()
        return status, json.loads(wire)
    f.call = call
    status, f.result = call(query={'surface': 'albums', 'q': ':popular'})
    assert status == 200
    assert_wire(f.result)
    assert f.result['tracks'], 'Native route tests require real selected fixture rows'
    return f


def command(f, operation):
    refs = [row['id'] for row in f.result['tracks']]
    result = {'result_token': f.result['native']['result_token']}
    result['row_ref' if operation == 'single' else 'row_refs'] = refs[0] if operation == 'single' else refs
    if operation != 'bindings':
        result['intent'] = 'metadata'
    return result


def forbid_service(f, monkeypatch):
    calls = []
    def forbidden(*args, **kwargs):
        calls.append(True)
        raise AssertionError('Rejected request reached popularity service')
    for method in METHODS:
        monkeypatch.setattr(f.app.state.private_popularity_search_service, method, forbidden)
    return calls


def test_real_view_dispatch_never_enters_ordinary_or_transient_browse(mounted_popularity, monkeypatch):
    from music_app.routes import api_read_asgi_routes as api
    from music_app.routes import private_search_asgi as routes
    calls = []
    def forbidden(*args, **kwargs):
        calls.append(True)
        raise AssertionError('Popularity query reached another browse owner')
    for name in ('_library_state', '_transient_scan_view_response'):
        monkeypatch.setattr(api, name, forbidden)
    monkeypatch.setattr(routes.PostgresPrivateSearchService, 'read', forbidden)
    monkeypatch.setattr(routes.PostgresListenerSearch, 'read_live', forbidden)
    f = mounted_popularity
    for query in (':popular', ':tracks genre:jazz :popular', ':popular per_artist:2'):
        status, value = f.call(query={'q': query, 'surface': 'albums'})
        assert status == 200
        assert_wire(value)
        assert value['query'] == query
    assert not calls


@pytest.mark.parametrize('operation', PATHS)
def test_all_native_routes_real_sql_and_exact_schema(mounted_popularity, operation):
    from music_app.services.private_route_boundary import private_action_for_route, csrf_mode_for_route
    f = mounted_popularity
    path = PATHS[operation]
    assert {route.path: route.methods for route in f.app.routes if route.path in PATHS.values()} == {
        value: {'POST'} for value in PATHS.values()}
    assert private_action_for_route('POST', path) == 'library.browse.read'
    assert csrf_mode_for_route('POST', path) == 'session_header'
    status, payload = f.call(path, body=command(f, operation))
    assert status == 200
    refs = [row['id'] for row in f.result['tracks']]
    assert_native(payload, f.result, operation, refs[:1] if operation == 'single' else refs)


@pytest.mark.parametrize('operation', PATHS)
@pytest.mark.parametrize('change', [
    {'x-album-haven-csrf': None}, {'x-album-haven-csrf': 'wrong'},
    {'origin': 'https://foreign.example'}, {'origin': None},
])
def test_csrf_and_origin_reject_before_service(mounted_popularity, operation, change, monkeypatch):
    f = mounted_popularity
    calls = forbid_service(f, monkeypatch)
    status, payload = f.call(PATHS[operation], body=command(f, operation), change_headers=change)
    assert status == 403 and payload == {'detail': 'CSRF validation failed.'}
    assert not calls


@pytest.mark.parametrize('operation', PATHS)
@pytest.mark.parametrize('origin_mode', ['referer', 'trusted'])
def test_existing_referer_and_trusted_origin_policy_is_preserved(mounted_popularity, operation, origin_mode):
    f = mounted_popularity
    if origin_mode == 'referer':
        change = {'origin': None, 'referer': 'http://testserver/library'}
    else:
        f.app.state.auth_policy_config['trusted_origins'] = ['https://trusted.example']
        change = {'origin': 'https://trusted.example'}
    status, value = f.call(PATHS[operation], body=command(f, operation), change_headers=change)
    assert status == 200 and value['status'] == 'ready'


@pytest.mark.parametrize('operation', PATHS)
@pytest.mark.parametrize('failure', ['anonymous', 'revoked', 'actor_infrastructure', 'policy_infrastructure'])
def test_early_actor_and_policy_errors_exact_private_envelopes(mounted_popularity, operation, failure, monkeypatch):
    f = mounted_popularity
    calls = forbid_service(f, monkeypatch)
    def broken(*args, **kwargs):
        raise RuntimeError('postgresql://must-not-leak/' + SECRET)
    change = {}
    if failure == 'anonymous':
        change['cookie'] = ''
    elif failure == 'revoked':
        with f.db.connect() as con:
            con.execute('update app.capabilities set revoked_at=clock_timestamp() where account_id=%s',
                        (f.db.owner.account_id,))
    elif failure == 'actor_infrastructure':
        monkeypatch.setattr(f.app.state.current_actor_resolver, 'resolve', broken)
    else:
        f.app.state.policy_constraint_resolver = broken
    status, payload = f.call(PATHS[operation], body=command(f, operation), change_headers=change)
    if failure == 'anonymous':
        assert status == 401 and payload == {'detail': 'Authentication required.'}
    elif failure == 'revoked':
        assert status == 403 and payload == {'detail': 'Action not permitted.'}
    else:
        assert status == 503
        search_error(payload, 'private_search_unavailable', 503)
    assert not calls


@pytest.mark.parametrize('operation', ['read', *PATHS])
@pytest.mark.parametrize('context', [None, 'bad', 'f' * 64])
def test_context_guard_precedes_sql(mounted_popularity, operation, context, monkeypatch):
    f = mounted_popularity
    calls = forbid_service(f, monkeypatch)
    status, payload = f.call('/view-data' if operation == 'read' else PATHS[operation],
        query={'q': ':popular'} if operation == 'read' else None,
        body=None if operation == 'read' else command(f, operation),
        change_headers={'x-albumhaven-context': context})
    assert status == 409
    search_error(payload, 'stale_context', 409)
    assert not calls


@pytest.mark.parametrize('operation', ['read', *PATHS])
def test_service_infrastructure_failure_is_never_ready_empty(mounted_popularity, operation, monkeypatch):
    f = mounted_popularity
    def broken(*args, **kwargs):
        raise RuntimeError('postgresql://must-not-leak/' + SECRET)
    method = {'read': 'read', 'bindings': 'project_bindings', 'single': 'resolve_target', 'batch': 'resolve_targets'}[operation]
    monkeypatch.setattr(f.app.state.private_popularity_search_service, method, broken)
    status, payload = f.call('/view-data' if operation == 'read' else PATHS[operation],
        query={'q': ':popular'} if operation == 'read' else None,
        body=None if operation == 'read' else command(f, operation))
    assert status == 503
    search_error(payload, 'private_search_unavailable', 503)


@pytest.mark.parametrize('operation', PATHS)
@pytest.mark.parametrize('malformed', ['duplicate', 'nested_duplicate', 'array', 'utf8', 'stream_overflow',
    'length_overflow', 'length_negative', 'length_unicode', 'content_type', 'query'])
def test_actual_streamed_body_admission(mounted_popularity, operation, malformed, monkeypatch):
    f = mounted_popularity
    calls = forbid_service(f, monkeypatch)
    options = {'body': command(f, operation)}
    if malformed == 'duplicate':
        options = {'chunks': [b'{"result_token":"a",', b'"result_token":"b"}']}
    elif malformed == 'nested_duplicate':
        options = {'raw': b'{"x":{"a":1,"a":2}}'}
    elif malformed == 'array': options = {'body': []}
    elif malformed == 'utf8': options = {'raw': b'\xff'}
    elif malformed == 'stream_overflow': options = {'chunks': [b' ' * 8192, b' ' * 8192, b' ']}
    elif malformed.startswith('length_'):
        options['change_headers'] = {'content-length': {'length_overflow': '16385',
            'length_negative': '-1', 'length_unicode': '\xb2'}[malformed]}
    elif malformed == 'content_type': options['change_headers'] = {'content-type': 'text/plain'}
    else: options['query'] = {'q': ':popular'}
    status, payload = f.call(PATHS[operation], **options)
    assert status == 400
    search_error(payload)
    assert not calls


@pytest.mark.parametrize('operation', PATHS)
def test_exact_16_kib_chunked_valid_command_is_accepted(mounted_popularity, operation):
    f = mounted_popularity
    raw = json.dumps(command(f, operation)).encode()
    assert len(raw) < 16384
    raw += b' ' * (16384 - len(raw))
    status, value = f.call(PATHS[operation], chunks=[raw[:8000], raw[8000:]],
        change_headers={'content-length': '16384'})
    assert status == 200 and value['status'] == 'ready'


@pytest.mark.parametrize('operation', PATHS)
@pytest.mark.parametrize('override', ['context', 'target_account_id', 'allowed_actions', 'subject_taste',
    'library_id', 'configuration', 'prelock', 'origin', 'hint'])
def test_authority_fields_never_reach_service(mounted_popularity, operation, override, monkeypatch):
    f = mounted_popularity
    calls = forbid_service(f, monkeypatch)
    body = {**command(f, operation), override: None}
    status, payload = f.call(PATHS[operation], body=body)
    assert status == 400
    search_error(payload)
    assert not calls


@pytest.mark.parametrize('intent,target_kind', [('metadata', 'album'), ('play', 'album'),
    ('details', None), ('details', True), ('details', []), ('details', 'artist'), ('details', 'Album')])
def test_present_target_kind_has_exact_422_semantics(mounted_popularity, intent, target_kind, monkeypatch):
    f = mounted_popularity
    calls = forbid_service(f, monkeypatch)
    body = {**command(f, 'single'), 'intent': intent, 'target_kind': target_kind}
    status, payload = f.call(PATHS['single'], body=body)
    assert status == 422
    search_error(payload, 'invalid_command', 422)
    assert not calls


@pytest.mark.parametrize('operation', PATHS)
@pytest.mark.parametrize('invalid', ['empty_token', 'unicode_token', 'long_token', 'wrong_row', 'null_row'])
def test_invalid_token_and_row_syntax_precedes_service(mounted_popularity, operation, invalid, monkeypatch):
    f = mounted_popularity
    calls = forbid_service(f, monkeypatch)
    body = command(f, operation)
    if invalid.endswith('token'):
        body['result_token'] = {'empty_token': '', 'unicode_token': '\u2603', 'long_token': 'a' * 4097}[invalid]
    else:
        ref = 'activity_' + 'a' * 64 if invalid == 'wrong_row' else None
        body['row_ref' if operation == 'single' else 'row_refs'] = ref if operation == 'single' else [ref]
    status, payload = f.call(PATHS[operation], body=body)
    assert status == 400
    search_error(payload)
    assert not calls


@pytest.mark.parametrize('path', ['/search/native-target', '/search/native-targets'])
def test_own_love_endpoint_rejects_popularity_dialect(mounted_popularity, path, monkeypatch):
    from music_app.routes import private_search_asgi as routes
    calls = []
    def forbidden(*args, **kwargs): calls.append(True); raise AssertionError('Wrong owner')
    monkeypatch.setattr(routes.PostgresPrivateSearchService, '__init__', forbidden)
    status, payload = mounted_popularity.call(path, query={'q': ':popular'},
        body={'resource_ref': 'x', 'intent': 'metadata'})
    assert status == 400
    search_error(payload)
    assert not calls


@pytest.mark.parametrize('operation', PATHS)
def test_listener_endpoints_reject_popularity_rows_before_service(mounted_popularity, operation, monkeypatch):
    from music_app.routes import private_search_asgi as routes
    calls = []
    def forbidden(*args, **kwargs): calls.append(True); raise AssertionError('Wrong owner')
    monkeypatch.setattr(routes.PostgresListenerSearch, '__init__', forbidden)
    status, payload = mounted_popularity.call(PATHS[operation].replace('popularity-', 'listener-'),
        body=command(mounted_popularity, operation))
    assert status == 422
    search_error(payload, 'invalid_command', 422)
    assert not calls


@pytest.mark.parametrize('operation', ['bindings', 'batch'])
@pytest.mark.parametrize('refs_kind', ['empty', 'duplicate', 'too_many', 'string'])
def test_batch_row_bounds_before_capture(mounted_popularity, operation, refs_kind, monkeypatch):
    f = mounted_popularity
    calls = forbid_service(f, monkeypatch)
    body = command(f, operation)
    ref = f.result['tracks'][0]['id']
    body['row_refs'] = {'empty': [], 'duplicate': [ref, ref],
        'too_many': ['popular_' + format(i, '064x') for i in range(101)], 'string': ref}[refs_kind]
    status, payload = f.call(PATHS[operation], body=body)
    assert status == 400
    search_error(payload)
    assert not calls


@pytest.mark.parametrize('operation,intent', [('single', None), ('single', 'Metadata'),
    ('single', 'download'), ('batch', 'details'), ('batch', True)])
def test_unsupported_intents_are_422_before_capture(mounted_popularity, operation, intent, monkeypatch):
    f = mounted_popularity
    calls = forbid_service(f, monkeypatch)
    status, payload = f.call(PATHS[operation], body={**command(f, operation), 'intent': intent})
    assert status == 422
    search_error(payload, 'invalid_command', 422)
    assert not calls


@pytest.mark.parametrize('target_kind', ['omitted', 'album'])
def test_single_details_accepts_only_album_parent(mounted_popularity, target_kind):
    f = mounted_popularity
    body = {**command(f, 'single'), 'intent': 'details'}
    if target_kind != 'omitted': body['target_kind'] = target_kind
    status, value = f.call(PATHS['single'], body=body)
    assert status == 200
    assert_native(value, f.result, 'single', [body['row_ref']])


def test_native_order_and_browse_does_not_imply_play(mounted_popularity):
    f = mounted_popularity
    refs = list(reversed([row['id'] for row in f.result['tracks']]))
    for operation in ('bindings', 'batch'):
        body = {**command(f, operation), 'row_refs': refs}
        if operation == 'batch': body['intent'] = 'play'
        status, value = f.call(PATHS[operation], body=body)
        assert status == 200
        assert_native(value, f.result, operation, refs)
        if operation == 'bindings':
            assert all(item['allowed_actions']['can_play'] is False for item in value['data']['items'])
        else:
            assert all(item['status'] == 'unavailable' and item['native_target'] is None
                       for item in value['data']['items'])


def test_read_and_native_do_not_write_jobs_or_cached_evidence(mounted_popularity):
    import re
    from tests.py.popularity_search_postgres_support import observed_connection
    f = mounted_popularity
    statements = []
    def inspect(connection, sql, params):
        statements.append(sql)
        assert re.search(r'\b(?:insert\s+into|delete\s+from|update\s+(?:app|library|catalog)\.)',
                         sql, re.IGNORECASE) is None, 'Search must not mutate cache/jobs/preferences'
    def jobs():
        with f.db.connect() as con:
            return con.execute('select to_jsonb(j) as row from library.popularity_refresh_jobs j '
                               'where library_id=%s order by to_jsonb(j)::text', (f.db.library,)).fetchall()
    before = jobs()
    f.app.state.private_popularity_search_service = owner(f.db, connect=observed_connection(before=inspect))
    status, result = f.call(query={'q': ':popular'})
    assert status == 200
    assert_wire(result)
    for operation in PATHS:
        status, value = f.call(PATHS[operation], body=command(f, operation))
        assert status == 200 and value['status'] == 'ready'
    assert statements and jobs() == before


@pytest.mark.parametrize('operation', PATHS)
def test_publication_token_is_not_a_page_cursor_and_expiry_is_http_409(mounted_popularity, operation):
    from datetime import timedelta
    f = mounted_popularity
    status, payload = f.call(query={'q': ':popular', 'search_cursor': f.result['native']['result_token']})
    assert status == 400
    search_error(payload)
    f.db.clock_time += timedelta(minutes=31)
    status, payload = f.call(PATHS[operation], body=command(f, operation))
    assert status == 409
    search_error(payload, 'search_cursor_restart_required', 409)


@pytest.mark.parametrize('field', ['artist', 'all_artists', 'omit_sidebar', 'payload_tier',
    'search_sidebar_cursor', 'target_account_id'])
def test_read_rejects_other_dialect_parameters_without_fallback(mounted_popularity, field, monkeypatch):
    f = mounted_popularity
    calls = forbid_service(f, monkeypatch)
    status, payload = f.call(query={'q': ':popular', field: '1'})
    assert status == 400
    search_error(payload)
    assert not calls


def test_unicode_located_error_preserves_original_query_offsets(mounted_popularity, monkeypatch):
    f = mounted_popularity
    calls = forbid_service(f, monkeypatch)
    query = ':popular genre:\u00e9 nope'
    status, payload = f.call(query={'q': query})
    assert status == 400
    search_error(payload, 'unsupported_private_search_combination', 400,
                 {'start': query.index('nope'), 'end': len(query)})
    assert not calls


# Reuse the unchanged cold-shell fixture. It controls only ordinary repository
# persistence/root lookup; real classification, preview and hydration stay live.
# The full-app cold_http fixture is intentionally not used here: its asgi_app
# bootstrap is outside this source-only test packet's approved setup boundary.
from tests.py.test_global_love_search_cold_shell import ordinary_artist_repository


@pytest.mark.parametrize('query', [':popular', 'sort:popular', '  :popular  ',
    ':tracks genre:"progressive rock" :popular per_artist:2',
    ':popular :albums', ':popular @someone', ':popular love:loved'])
@pytest.mark.parametrize('artist', ['', 'Requested Artist'])
@pytest.mark.parametrize('presentation', ['albums', 'tracks'])
def test_real_cold_bootstrap_classifies_popularity_as_private_shell(
        ordinary_artist_repository, query, artist, presentation):
    from urllib.parse import parse_qs, urlsplit
    from tests.py.test_global_love_search_cold_shell import bootstrap, PRIVATE_ROOT
    payload = bootstrap(query, artist=artist, presentation=presentation)
    initial = payload['initial_view']
    assert initial['query'] == query and initial['selected_artist'] == artist
    for field in ('artist_groups', 'primary_artist_groups', 'family_artist_groups',
                  'artists_sidebar', 'non_album_tracks'):
        assert not initial.get(field), f'Ordinary rows escaped through cold {field}'
    assert 'music_dir' not in initial
    assert payload['bootstrap']['startupPreview']['renderedGalleryMarkup'] is False
    hydration = payload['bootstrap']['startupHydration']
    assert hydration['required'] is True
    assert hydration['embeddedViewPatch'] is None
    endpoint = urlsplit(hydration['endpoint'])
    assert endpoint.path == '/view-data'
    params = parse_qs(endpoint.query, keep_blank_values=True)
    assert params['q'] == [query]
    assert params['artist'] == [artist]
    assert params['search_presentation'] == [presentation]
    assert 'payload_tier' not in params, 'popularity cold hydration must not invent an unsupported option'
    serialized = json.dumps(payload)
    for forbidden in (PRIVATE_ROOT, 'Unfiltered Artist', 'Unfiltered Family Album', 'music_dir'):
        assert forbidden not in serialized


def test_real_cold_bootstrap_preserves_duplicate_and_visibility_input_for_guarded_rejection(
        ordinary_artist_repository):
    from urllib.parse import parse_qsl, urlsplit
    from starlette.datastructures import QueryParams
    from music_app.routes import web_asgi
    pairs = [('surface', 'albums'), ('q', ':popular'), ('q', ':popular :albums'),
             ('category', 'main'), ('category', 'hoarding'), ('gallery_scope', 'all')]
    payload = web_asgi._build_bootstrap_payload(query_args=QueryParams(pairs), config={},
        logger=None, library_state={}, query_raw=':popular', selected_artist='',
        refreshed=False, request_started_epoch_ms=1)[0]
    hydration = payload['bootstrap']['startupHydration']
    assert hydration['required'] is True and hydration['embeddedViewPatch'] is None
    assert parse_qsl(urlsplit(hydration['endpoint']).query, keep_blank_values=True) == pairs
    assert payload['bootstrap']['startupPreview']['renderedGalleryMarkup'] is False


def test_ordinary_cold_bootstrap_still_uses_real_preview_builder(ordinary_artist_repository):
    from tests.py.test_global_love_search_cold_shell import bootstrap
    payload = bootstrap('ordinary text')
    assert payload['initial_view']['artist_groups'][0]['albums'][0]['name'] == 'Unfiltered Family Album'
    assert payload['bootstrap']['startupPreview']['renderedGalleryMarkup'] is True


@pytest.mark.parametrize('query', [':popular', 'sort:popular', ':popular per_artist:2'])
@pytest.mark.parametrize('presentation', [None, 'tracks'])
def test_valid_cold_popularity_endpoint_reaches_real_middleware(
        ordinary_artist_repository, mounted_popularity, query, presentation):
    from urllib.parse import parse_qsl, urlsplit
    from starlette.datastructures import QueryParams
    from music_app.routes import web_asgi
    pairs = [('q', query)]
    if presentation is not None:
        pairs.append(('search_presentation', presentation))
    payload = web_asgi._build_bootstrap_payload(query_args=QueryParams(pairs), config={},
        logger=None, library_state={}, query_raw=query, selected_artist='',
        refreshed=False, request_started_epoch_ms=1)[0]
    assert payload['initial_view']['search_presentation'] == 'tracks'
    hydration = payload['bootstrap']['startupHydration']
    assert hydration['required'] is True and hydration['embeddedViewPatch'] is None
    endpoint = urlsplit(hydration['endpoint'])
    assert endpoint.path == '/view-data'
    generated = parse_qsl(endpoint.query, keep_blank_values=True)
    assert generated == [*pairs, ('surface', 'albums')]
    status, result = mounted_popularity.call(endpoint.path, query=generated)
    assert status == 200
    assert_wire(result)
    assert result['query'] == query and result['tracks']


@pytest.mark.parametrize('extras', [ [('payload_tier', 'full')],
    [('payload_tier', 'full'), ('payload_tier', 'full')],
    [('search_presentation', 'tracks'), ('search_presentation', 'albums')],
    [('q', ':popular per_artist:3')] ])
def test_cold_popularity_preserves_supplied_invalid_pairs_for_real_rejection(
        ordinary_artist_repository, mounted_popularity, extras, monkeypatch):
    from urllib.parse import parse_qsl, urlsplit
    from starlette.datastructures import QueryParams
    from music_app.routes import web_asgi
    pairs = [('surface', 'albums'), ('q', ':popular'), *extras]
    payload = web_asgi._build_bootstrap_payload(query_args=QueryParams(pairs), config={},
        logger=None, library_state={}, query_raw=':popular', selected_artist='',
        refreshed=False, request_started_epoch_ms=1)[0]
    endpoint = urlsplit(payload['bootstrap']['startupHydration']['endpoint'])
    generated = parse_qsl(endpoint.query, keep_blank_values=True)
    assert generated == pairs
    calls = forbid_service(mounted_popularity, monkeypatch)
    status, result = mounted_popularity.call(endpoint.path, query=generated)
    assert status == 400
    search_error(result)
    assert not calls


@pytest.mark.parametrize('query', [':loved', '@maya', '@maya :tracks listened:all'])
def test_cold_nonpopularity_modes_keep_existing_hydration_options(ordinary_artist_repository, query):
    from tests.py.test_global_love_search_cold_shell import bootstrap
    from urllib.parse import parse_qs, urlsplit
    payload = bootstrap(query, artist='', presentation='tracks')
    params = parse_qs(urlsplit(payload['bootstrap']['startupHydration']['endpoint']).query)
    assert params['payload_tier'] == ['full']
    assert params['q'] == [query] and params['search_presentation'] == ['tracks']


@pytest.mark.parametrize('query', [
    [('surface','albums'),('q',':popular')],
    [('surface','albums'),('q','@listener')],
    [('surface','albums'),('q',':loved')],
    [('surface','albums'),('q',':popular'),('q','ordinary')],
    [('surface','albums'),('q','ordinary'),('q',':popular')],
    [('surface','albums'),('q',':popular genre:"unterminated')],
    [('surface','albums'),('q',':popular'),('search_page_size','bad')],
    [('surface','albums'),('q','ordinary'),('search_cursor','bad')],
])
def test_early_real_resolver_failure_has_private_search_envelope(mounted_popularity, monkeypatch, query):
    """Fault the actual resolver before routing; retain raw duplicate query pairs."""
    f = mounted_popularity
    calls = forbid_service(f, monkeypatch)
    from music_app.routes import api_read_asgi_routes as api
    from music_app.routes import private_search_asgi as routes
    def unexpected_owner(*args, **kwargs):
        calls.append(True)
        raise AssertionError('Early resolver failure entered a Search or ordinary owner')
    monkeypatch.setattr(routes.PostgresPrivateSearchService, 'read', unexpected_owner)
    monkeypatch.setattr(routes.PostgresListenerSearch, 'read_live', unexpected_owner)
    for name in ('_library_state', '_transient_scan_view_response'):
        monkeypatch.setattr(api, name, unexpected_owner)
    marker = 'private-resolver-database-marker-28f9'
    reached = []
    def fail(_token):
        reached.append(True)
        raise RuntimeError(marker)
    monkeypatch.setattr(f.app.state.current_actor_resolver, 'resolve', fail)
    status, headers, raw = asyncio.run(exchange(f.app, 'GET', '/view-data',
        query=query, headers={}, chunks=[b'']))
    assert reached == [True] and calls == []
    assert status == 503
    assert {'private','no-store'} <= {x.strip() for x in headers['cache-control'].split(',')}
    search_error(json.loads(raw), 'private_search_unavailable', 503)
    assert marker.encode() not in raw


def _exception_contains_identity(error, expected):
    if error is expected:
        return True
    return any(_exception_contains_identity(child, expected)
               for child in getattr(error, 'exceptions', ()))


@pytest.mark.parametrize('query', [
    [('surface','albums'),('q','ordinary')],
    [('surface','playlists'),('q',':popular')],
    [('surface','album_tops'),('q',':popular')],
])
def test_early_resolver_failure_does_not_change_non_search_surfaces(mounted_popularity, monkeypatch, query):
    f = mounted_popularity
    calls = forbid_service(f, monkeypatch)
    failure = RuntimeError('ordinary-resolver-failure')
    def fail(_token):
        raise failure
    monkeypatch.setattr(f.app.state.current_actor_resolver, 'resolve', fail)
    with pytest.raises(BaseException) as caught:
        asyncio.run(exchange(f.app, 'GET', '/view-data', query=query, headers={}, chunks=[b'']))
    assert _exception_contains_identity(caught.value, failure)
    assert calls == []


@pytest.mark.parametrize('cancellation', [False, True])
def test_private_read_resolver_baseexceptions_are_not_translated(mounted_popularity, monkeypatch, cancellation):
    class ResolverStopped(BaseException):
        pass
    f = mounted_popularity
    calls = forbid_service(f, monkeypatch)
    failure = asyncio.CancelledError('resolver cancelled') if cancellation else ResolverStopped('resolver stopped')
    def fail(_token):
        raise failure
    monkeypatch.setattr(f.app.state.current_actor_resolver, 'resolve', fail)
    with pytest.raises(BaseException) as caught:
        asyncio.run(exchange(f.app, 'GET', '/view-data',
            query=[('surface','albums'),('q',':popular')], headers={}, chunks=[b'']))
    assert _exception_contains_identity(caught.value, failure)
    assert calls == []
