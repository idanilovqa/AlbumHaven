"""Own-love native HTTP admission; transport doubles are not SQL authority proof.

The real API router, private perimeter, context owner and CSRF validator run.
The separate PostgreSQL suite exercises live witnesses and native resolution.
"""
import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from starlette.requests import Request

from music_app.routes import api_read_asgi_routes as routes
from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import (
    csrf_mode_for_route, install_private_route_boundary, private_action_for_route,
)
from music_app.services.private_ui_context import private_ui_context_ref
from music_app.services.view_search import PrivateSearchError
from tests.py.asgi_testing import run_asgi_request

BROWSE = 'library.browse.read'
HMAC = {'hmac': {'secret': 'synthetic-own-love-native-context-key-32-bytes', 'key_version': 1}}
REF = 'inventory-track:17:29'
COMMAND = {'resource_ref': REF, 'intent': 'metadata'}
QUERY = {'surface': 'albums', 'q': ':loved', 'all_artists': '1', 'search_presentation': 'tracks'}


class NativeTransport:
    def __init__(self):
        self.calls = []
        self.error = None

    def resolve_native_target(self, context, **kwargs):
        self.calls.append((context, kwargs))
        if self.error is not None:
            raise self.error
        return {'status': 'ready', 'contract_version': 'own-love-native-v1',
            'context_ref': kwargs['context_ref'], 'data': {
                'resource_ref': kwargs['resource_ref'], 'intent': kwargs['intent'],
                'native_target': {'inventory_track_ref': REF}}}

    def read(self, *_args, **_kwargs):
        pytest.fail('Native/listener admission fell through to ordinary own-love reads')


@pytest.fixture
def route(monkeypatch):
    f = SimpleNamespace(service=NativeTransport(), denied=False)
    f.actor = CurrentActor(state=ActorState.ACTIVE, account_id=11, session_id=13,
        current_library_id=17, library_relationships=(LibraryRelationship(17, 'member', False),),
        capability_grants=(CapabilityGrant(BROWSE, 'library', 17),))
    f.app = FastAPI()
    f.app.state.config = {'ALBUM_HAVEN_DEPLOYMENT_MODE': 'self_hosted'}
    f.app.state.auth_policy_config = HMAC
    f.app.state.current_actor_resolver = SimpleNamespace(resolve=lambda _token: f.actor)
    f.app.state.private_search_service = f.service
    f.app.state.policy_constraint_resolver = lambda _context: PolicyEvaluationConstraints(request_origin_allowed=not f.denied)
    f.app.include_router(routes.router)
    install_private_route_boundary(f.app)

    def forbidden(*_args, **_kwargs):
        pytest.fail('Native admission entered an ordinary browse fallback')

    for name in ('build_view_payload', '_hydrate_cached_library_for_asgi', 'build_album_detail_payload'):
        monkeypatch.setattr(routes, name, forbidden)

    def context_ref():
        request = Request({'type': 'http', 'method': 'POST', 'path': '/search/native-target',
            'app': f.app, 'state': {'current_actor': f.actor}, 'headers': [], 'query_string': b''})
        return private_ui_context_ref(request)

    f.context_ref = context_ref
    f.session = 's' * 43
    f.csrf = issue_session_csrf(f.session, HMAC)

    def call(*, query=None, command=None, body=None, headers=None, path='/search/native-target', method='POST'):
        selected = {'cookie': f'__Host-album_haven_session={f.session}; __Host-album_haven_csrf={f.csrf}',
            'origin': 'http://testserver', 'x-album-haven-csrf': f.csrf,
            'x-albumhaven-context': context_ref() or ''}
        for key, value in (headers or {}).items():
            if value is None:
                selected.pop(key, None)
            else:
                selected[key] = value
        options = {'body': body} if body is not None else {'json_body': COMMAND if command is None else command}
        status, response_headers, raw = run_asgi_request(f.app, method, path,
            query=QUERY if query is None else query, headers=selected, **options)
        assert {'private', 'no-store'} <= {part.strip().lower() for part in response_headers['cache-control'].split(',')}
        return status, json.loads(raw)

    f.call = call
    return f


def denied(route, expected=400, **options):
    status, payload = route.call(**options)
    assert status == expected, payload
    assert not route.service.calls
    assert 'data' not in payload and 'native_target' not in payload
    return payload


def test_exact_post_is_private_browse_and_uses_existing_session_csrf(route):
    assert private_action_for_route('POST', '/search/native-target') == BROWSE
    assert private_action_for_route('GET', '/search/native-target') is None
    assert csrf_mode_for_route('POST', '/search/native-target') == 'session_header'
    status, payload = route.call()
    assert status == 200
    assert payload == {'status': 'ready', 'contract_version': 'own-love-native-v1',
        'context_ref': route.context_ref(), 'data': {**COMMAND, 'native_target': {'inventory_track_ref': REF}}}
    context, call = route.service.calls[0]
    assert context.actor == route.actor and context.library_id == 17 and context.action == BROWSE
    assert call['resource_ref'] == REF and call['intent'] == 'metadata'
    assert call['cursor_secret'] == HMAC['hmac']['secret']
    assert call['request'].criteria.as_payload()['subject'] == 'self'
    assert call['request'].cursor is None and call['request'].sidebar_cursor is None


@pytest.mark.parametrize('ref,intent', [
    ('inventory-track:17:29', 'play'), ('inventory-track:17:29', 'details'),
    ('inventory-album:17:31', 'details'),
])
def test_transport_passes_exact_candidate_and_intent_without_canonical_rewriting(route, ref, intent):
    status, payload = route.call(command={'resource_ref': ref, 'intent': intent})
    assert status == 200
    assert payload['data']['resource_ref'] == ref and payload['data']['intent'] == intent
    assert route.service.calls[0][1]['resource_ref'] == ref


@pytest.mark.parametrize('ref,intent', [
    ('/private/song.flac', 'play'), ('track:canonical', 'play'), ('activity_secret', 'metadata'),
    ('inventory-track:017:29', 'play'), ('inventory-track:17:0', 'play'),
    ('inventory-track:17:-1', 'play'), ('inventory-track:17:٢٩', 'play'),
    ('inventory-track:17:9223372036854775808', 'play'), ('inventory-track:17:29\n', 'play'),
    ('inventory-album:17:31', 'metadata'), ('inventory-album:17:31', 'play'),
    ('inventory-artist:17:31', 'details'), (True, 'play'), (None, 'play'),
    ('inventory-track:17:29', None), ('inventory-track:17:29', 'queue'),
])
def test_only_bounded_inventory_candidates_and_supported_intents_are_admitted(route, ref, intent):
    denied(route, command={'resource_ref': ref, 'intent': intent})


@pytest.mark.parametrize('key', ['actor', 'subject', 'library_id', 'path', 'native_target',
    'canonical_track_ref', 'origin', 'grant', 'cursor', 'result_cursor', 'row_ref'])
def test_no_caller_authority_or_canonical_replacement_in_json(route, key):
    denied(route, command={**COMMAND, key: 'injected'})


@pytest.mark.parametrize('command', [[], {}, {'resource_ref': REF}, {'intent': 'play'}, 'text', False])
def test_json_object_has_exactly_two_required_fields(route, command):
    denied(route, command=command)


@pytest.mark.parametrize('body', [
    b'{"resource_ref":"inventory-track:17:29","intent":"play","intent":"details"}',
    b'{"resource_ref":"inventory-track:17:29","resource_ref":"inventory-track:17:30","intent":"play"}',
    b'null', b'{', b'\xff', b'[]', b' ' * 1025,
])
def test_malformed_duplicate_and_oversized_json_never_enters_service(route, body):
    denied(route, body=body, headers={'content-type': 'application/json'})


@pytest.mark.parametrize('content_type', ['text/plain', 'application/x-www-form-urlencoded', '', 'multipart/form-data'])
def test_native_body_requires_json_content_type(route, content_type):
    denied(route, body=json.dumps(COMMAND).encode(), headers={'content-type': content_type})


def test_bounded_json_whitespace_and_content_type_parameters_are_supported(route):
    body = json.dumps(COMMAND).encode()
    status, _ = route.call(body=body + b' ' * (1024 - len(body)),
        headers={'content-type': 'Application/JSON; charset=utf-8'})
    assert status == 200 and len(route.service.calls) == 1


@pytest.mark.parametrize('length', ['-1', '1.0', '1025', '99999', 'invalid'])
def test_invalid_or_oversized_declared_lengths_fail_before_dispatch(route, length):
    denied(route, body=json.dumps(COMMAND).encode(),
        headers={'content-type': 'application/json', 'content-length': length})


def test_actual_stream_bound_is_enforced_despite_a_small_declared_length(route):
    denied(route, body=json.dumps(COMMAND).encode() + b' ' * 1024,
        headers={'content-type': 'application/json', 'content-length': '1'})


@pytest.mark.parametrize('key', ['actor', 'subject', 'library_id', 'path', 'origin', 'grant',
    'search_cursor', 'search_sidebar_cursor', 'search_detail_album_ref', 'search_sidebar_only',
    'search_page_size', 'omit_sidebar', 'payload_tier', 'gallery_display', 'cursor'])
def test_no_extra_query_or_cursor_credentials(route, key):
    denied(route, query={**QUERY, key: '1'})


@pytest.mark.parametrize('key,value', [('q', [':loved', ':obsessed']), ('artist', ['A', 'B']),
    ('all_artists', ['1', '1']), ('search_presentation', ['tracks', 'albums'])])
def test_duplicate_single_value_parameters_are_not_collapsed(route, key, value):
    denied(route, query={**QUERY, key: value})


def test_category_multivalues_and_retained_artist_scope_use_the_existing_normalizer(route):
    query = {'surface': 'albums', 'q': 'love:loved -:obsessed', 'artist': '  Native Artist  ',
        'search_presentation': 'albums', 'category': ['main_library', 'hoard', 'main_library']}
    status, _ = route.call(query=query)
    assert status == 200
    request = route.service.calls[0][1]['request']
    assert request.artist == 'Native Artist' and request.all_artists is False
    assert request.categories == ('hoard', 'main_library')
    assert request.query == query['q'] and request.criteria.tiers() == ('loved',)


@pytest.mark.parametrize('query', [
    {'q': ':loved'}, {'q': ':loved', 'all_artists': '0'},
    {'q': ':loved', 'artist': 'A', 'all_artists': '1'},
    {**QUERY, 'surface': 'playlists'}, {**QUERY, 'surface': 'album_tops'},
    {**QUERY, 'q': '@listener'}, {**QUERY, 'q': '@listener :tracks listened:all'},
    {**QUERY, 'q': ':loved listened:all'}, {**QUERY, 'q': 'name :loved'},
])
def test_native_admission_does_not_expand_grammar_or_guess_selection(route, query):
    denied(route, query=query)


@pytest.mark.parametrize('supplied', [None, '', '0' * 64, 'a' * 63, 'é' * 64])
def test_exact_current_context_is_required(route, supplied):
    payload = denied(route, expected=409, headers={'x-albumhaven-context': supplied})
    assert payload['error_code'] == 'stale_context'


@pytest.mark.parametrize('headers', [
    {'x-album-haven-csrf': None}, {'x-album-haven-csrf': 'wrong'},
    {'cookie': '__Host-album_haven_session=' + 's' * 43},
    {'origin': 'https://other.example'}, {'origin': None},
])
def test_same_origin_and_session_bound_csrf_are_enforced_before_native_dispatch(route, headers):
    denied(route, expected=403, headers=headers)


def test_browse_denial_and_anonymous_actor_are_no_store_without_service_entry(route):
    route.denied = True
    denied(route, expected=403)
    route.denied = False
    route.actor = CurrentActor.anonymous()
    denied(route, expected=401)


@pytest.mark.parametrize('code,status', [('private_search_forbidden', 403),
    ('item_unavailable', 404), ('search_native_target_retry_required', 409),
    ('private_search_unavailable', 503)])
def test_current_typed_failures_remain_failures_without_fallback(route, code, status):
    route.service.error = PrivateSearchError(code, status)
    actual, payload = route.call()
    assert actual == status and payload['error_code'] == code
    assert 'data' not in payload and len(route.service.calls) == 1


def test_infrastructure_errors_are_private_and_never_leak_paths_or_sql(route):
    route.service.error = RuntimeError('select private_path from /private/music')
    status, payload = route.call()
    assert status == 503 and payload['error_code'] == 'private_search_unavailable'
    assert 'select' not in json.dumps(payload) and '/private/music' not in json.dumps(payload)


@pytest.mark.parametrize('owner', ['actor', 'policy'])
def test_failures_before_route_admission_are_typed_and_no_store(route, owner):
    def unavailable(*_args, **_kwargs):
        raise RuntimeError('private session or policy infrastructure detail')

    if owner == 'actor':
        route.app.state.current_actor_resolver = SimpleNamespace(resolve=unavailable)
    else:
        route.app.state.policy_constraint_resolver = unavailable
    payload = denied(route, expected=503)
    assert payload['error_code'] == 'private_search_unavailable'
    assert 'infrastructure detail' not in json.dumps(payload)


@pytest.mark.parametrize('query', ['@listener', '@listener :tracks listened:all'])
def test_listener_http_gate_remains_closed_on_the_actual_read_router(route, query):
    denied(route, query={'surface': 'albums', 'q': query}, path='/view-data', method='GET')
