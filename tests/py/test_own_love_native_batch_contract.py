"""Own-love batch HTTP admission, with explicitly synthetic transport inputs.

The accepted native-target HTTP fixture supplies the real router, boundary,
context and CSRF owners unchanged. Its actor/service inputs are transport-only
doubles, not SQL acceptance. The companion PostgreSQL module uses real issued
sessions, guarded transactions, witness SQL and the actual native resolvers.
"""
import asyncio
import json

import pytest
from starlette.requests import Request

from music_app.routes.private_search_asgi import _native_command
from music_app.services.private_route_boundary import csrf_mode_for_route, private_action_for_route
from music_app.services.private_search_postgres import normalize_native_search_batch_command
from music_app.services.view_search import PrivateSearchError
from tests.py.test_own_love_native_target_contract import (
    BROWSE, HMAC, QUERY, REF, route as native_route,
)

COMMAND = {'resource_refs': [REF], 'intent': 'metadata'}
LIMIT = 16 * 1024


class BatchTransport:
    def __init__(self):
        self.calls, self.unavailable, self.error = [], set(), None

    def resolve_native_targets(self, context, **kwargs):
        self.calls.append((context, kwargs))
        if self.error is not None:
            raise self.error
        results = [{'resource_ref': ref, 'status': 'unavailable'} if ref in self.unavailable else
            {'resource_ref': ref, 'status': 'ready', 'native_target': {'inventory_track_ref': ref}}
            for ref in kwargs['resource_refs']]
        return {'status': 'ready', 'contract_version': 'own-love-native-batch-v1',
            'context_ref': kwargs['context_ref'], 'data': {'intent': kwargs['intent'], 'results': results}}

    def resolve_native_target(self, *_args, **_kwargs):
        pytest.fail('Batch admission issued singleton native requests')

    def read(self, *_args, **_kwargs):
        pytest.fail('Batch/listener admission fell through to a Search read')


@pytest.fixture
def route(native_route):
    native_route.service = BatchTransport()
    native_route.app.state.private_search_service = native_route.service
    original = native_route.call

    def call(**options):
        options.setdefault('path', '/search/native-targets')
        options.setdefault('command', COMMAND)
        return original(**options)

    native_route.call = call
    return native_route


def denied(route, expected=400, **options):
    status, payload = route.call(**options)
    assert status == expected, payload
    assert not route.service.calls
    assert 'data' not in payload and 'results' not in payload
    return payload


def test_only_the_exact_post_uses_browse_session_csrf_and_private_no_store(route):
    assert private_action_for_route('POST', '/search/native-targets') == BROWSE
    for method in ('GET', 'PUT', 'PATCH', 'DELETE'):
        assert private_action_for_route(method, '/search/native-targets') is None
    assert private_action_for_route('POST', '/search/native-targets/extra') is None
    assert csrf_mode_for_route('POST', '/search/native-targets') == 'session_header'
    matches = [item for item in route.app.routes if getattr(item, 'path', '') == '/search/native-targets']
    assert len(matches) == 1 and matches[0].methods == {'POST'}
    status, payload = route.call()
    assert status == 200 and set(payload) == {'status', 'contract_version', 'context_ref', 'data'}
    assert payload['status'] == 'ready' and payload['contract_version'] == 'own-love-native-batch-v1'
    assert payload['context_ref'] == route.context_ref()
    assert payload['data'] == {'intent': 'metadata', 'results': [
        {'resource_ref': REF, 'status': 'ready', 'native_target': {'inventory_track_ref': REF}}]}
    context, command = route.service.calls[0]
    assert context.actor == route.actor and context.library_id == 17 and context.action == BROWSE
    assert command['cursor_secret'] == HMAC['hmac']['secret']
    assert command['request'].criteria.as_payload()['subject'] == 'self'
    assert command['request'].presentation == 'tracks'


@pytest.mark.parametrize('intent', ['metadata', 'play'])
def test_one_hundred_unique_candidates_preserve_selected_order_and_intent(route, intent):
    refs = [f'inventory-track:17:{index}' for index in range(100, 0, -1)]
    status, payload = route.call(command={'resource_refs': refs, 'intent': intent})
    assert status == 200 and len(route.service.calls) == 1
    assert route.service.calls[0][1]['resource_refs'] == refs
    assert payload['data']['intent'] == intent
    assert [item['resource_ref'] for item in payload['data']['results']] == refs
    assert len(payload['data']['results']) == len(set(refs)) == 100


@pytest.mark.parametrize('refs', [[], [REF] * 2, [f'inventory-track:17:{n}' for n in range(1, 102)],
    REF, None, True, {}, [None], [True], [[REF]], [17]])
def test_ordered_nonempty_unique_list_is_bounded_before_service_entry(route, refs):
    denied(route, command={'resource_refs': refs, 'intent': 'metadata'})


@pytest.mark.parametrize('ref', ['/private/song.flac', 'track:canonical', 'activity_secret',
    'inventory-album:17:29', 'inventory-artist:17:29', 'inventory-track:017:29',
    'inventory-track:17:0', 'inventory-track:17:-1', 'inventory-track:17:٢٩',
    'inventory-track:17:9223372036854775808', 'inventory-track:9223372036854775808:1',
    'inventory-track:17:29\n'])
def test_batch_rejects_non_inventory_and_malformed_or_overflowing_candidates(route, ref):
    denied(route, command={'resource_refs': [ref], 'intent': 'play'})


@pytest.mark.parametrize('intent', ['details', 'queue', '', None, True, {}, ['play']])
def test_batch_has_only_metadata_and_play_intents(route, intent):
    denied(route, command={'resource_refs': [REF], 'intent': intent})


@pytest.mark.parametrize('command', [[], {}, {'resource_refs': [REF]}, {'intent': 'play'},
    {'resource_ref': REF, 'intent': 'metadata'}, 'text', False])
def test_command_has_exactly_two_required_fields(route, command):
    denied(route, command=command)


@pytest.mark.parametrize('key', ['actor', 'subject', 'library_id', 'path', 'native_target',
    'canonical_track_ref', 'origin', 'grant', 'cursor', 'row_ref', 'playlist_ref', 'source', 'revision'])
def test_no_caller_authority_or_source_receipt_is_accepted(route, key):
    denied(route, command={**COMMAND, key: 'injected'})


@pytest.mark.parametrize('body', [
    b'{"resource_refs":["inventory-track:17:29"],"intent":"play","intent":"metadata"}',
    b'{"resource_refs":["inventory-track:17:29"],"resource_refs":[],"intent":"play"}',
    b'{"resource_refs":[{"a":1,"a":2}],"intent":"play"}', b'null', b'{', b'\xff', b'[]',
    b' ' * (LIMIT + 1),
])
def test_duplicate_keys_malformed_utf8_json_and_oversize_are_rejected(route, body):
    denied(route, body=body, headers={'content-type': 'application/json'})


@pytest.mark.parametrize('length', ['-1', '1.0', str(LIMIT + 1), '999999', 'invalid', '١٦'])
def test_bad_content_length_is_rejected_before_dispatch(route, length):
    denied(route, body=json.dumps(COMMAND).encode(),
        headers={'content-type': 'application/json', 'content-length': length})


def test_exact_body_limit_and_content_type_parameters_are_supported(route):
    body = json.dumps(COMMAND).encode()
    status, _ = route.call(body=body + b' ' * (LIMIT - len(body)),
        headers={'content-type': 'Application/JSON; charset=utf-8'})
    assert status == 200 and len(route.service.calls) == 1


@pytest.mark.parametrize('content_type', ['text/plain', '', 'multipart/form-data', 'application/x-www-form-urlencoded'])
def test_batch_requires_json_content_type(route, content_type):
    denied(route, body=json.dumps(COMMAND).encode(), headers={'content-type': content_type})


def test_declared_short_body_does_not_bypass_actual_stream_bound(route):
    denied(route, body=json.dumps(COMMAND).encode() + b' ' * LIMIT,
        headers={'content-type': 'application/json', 'content-length': '1'})


@pytest.mark.parametrize('extra', [0, 1])
def test_chunked_body_is_bounded_across_all_chunks_without_content_length(extra):
    body = json.dumps(COMMAND).encode()
    chunks = [body[:7], body[7:], b' ' * (LIMIT - len(body)), b' ' * extra]

    async def receive():
        chunk = chunks.pop(0)
        return {'type': 'http.request', 'body': chunk, 'more_body': bool(chunks)}

    request = Request({'type': 'http', 'method': 'POST', 'path': '/search/native-targets',
        'headers': [(b'content-type', b'application/json')], 'query_string': b''}, receive=receive)
    if extra:
        with pytest.raises(PrivateSearchError):
            asyncio.run(_native_command(request, batch=True))
    else:
        assert asyncio.run(_native_command(request, batch=True)) == COMMAND


@pytest.mark.parametrize('key', ['actor', 'subject', 'library_id', 'path', 'origin', 'grant',
    'search_cursor', 'search_sidebar_cursor', 'search_detail_album_ref', 'search_sidebar_only',
    'search_page_size', 'omit_sidebar', 'payload_tier', 'gallery_display', 'cursor'])
def test_query_cannot_smuggle_page_cursor_or_authority(route, key):
    denied(route, query={**QUERY, key: '1'})


@pytest.mark.parametrize('key,value', [('q', [':loved', ':obsessed']), ('artist', ['A', 'B']),
    ('all_artists', ['1', '1']), ('search_presentation', ['tracks', 'tracks'])])
def test_duplicate_single_value_query_parameters_are_not_collapsed(route, key, value):
    denied(route, query={**QUERY, key: value})


def test_exact_selected_artist_and_categories_use_existing_own_love_normalization(route):
    query = {'surface': 'albums', 'q': 'love:loved -:obsessed', 'artist': '  Native Artist  ',
        'search_presentation': 'tracks', 'category': ['main_library', 'hoard', 'main_library']}
    status, _ = route.call(query=query)
    assert status == 200
    request = route.service.calls[0][1]['request']
    assert request.artist == 'Native Artist' and request.all_artists is False
    assert request.categories == ('hoard', 'main_library') and request.criteria.tiers() == ('loved',)


@pytest.mark.parametrize('query', [
    {'q': ':loved'}, {**QUERY, 'search_presentation': 'albums'},
    {**QUERY, 'all_artists': '0'}, {**QUERY, 'artist': 'A'},
    {**QUERY, 'surface': 'playlists'}, {**QUERY, 'surface': 'album_tops'},
    {**QUERY, 'q': '@listener'}, {**QUERY, 'q': '@listener :tracks listened:all'},
    {**QUERY, 'q': ':loved listened:all'}, {**QUERY, 'q': 'name :loved'},
])
def test_only_current_own_love_track_search_with_explicit_selection_is_admitted(route, query):
    denied(route, query=query)


@pytest.mark.parametrize('supplied', [None, '', '0' * 64, 'a' * 63, 'é' * 64])
def test_exact_current_context_is_required(route, supplied):
    assert denied(route, expected=409, headers={'x-albumhaven-context': supplied})['error_code'] == 'stale_context'


@pytest.mark.parametrize('headers', [
    {'x-album-haven-csrf': None}, {'x-album-haven-csrf': 'wrong'},
    {'cookie': '__Host-album_haven_session=' + 's' * 43},
    {'origin': 'https://other.example'}, {'origin': None},
])
def test_same_origin_session_header_csrf_is_required_before_dispatch(route, headers):
    denied(route, expected=403, headers=headers)


def test_browse_denial_and_anonymous_actor_remain_no_store(route):
    from music_app.services.current_actor import CurrentActor
    route.denied = True
    denied(route, expected=403)
    route.denied = False
    route.actor = CurrentActor.anonymous()
    denied(route, expected=401)


def test_item_unavailable_keeps_exact_order_without_partial_identity_or_reason(route):
    other = 'inventory-track:17:30'
    route.service.unavailable.add(other)
    status, payload = route.call(command={'resource_refs': [other, REF], 'intent': 'play'})
    assert status == 200
    assert payload['data']['results'] == [
        {'resource_ref': other, 'status': 'unavailable'},
        {'resource_ref': REF, 'status': 'ready', 'native_target': {'inventory_track_ref': REF}}]


@pytest.mark.parametrize('code,status', [('private_search_forbidden', 403),
    ('search_native_target_retry_required', 409), ('private_search_unavailable', 503)])
def test_whole_typed_failure_is_never_a_ready_empty_batch(route, code, status):
    route.service.error = PrivateSearchError(code, status)
    actual, payload = route.call()
    assert actual == status and payload['error_code'] == code
    assert 'data' not in payload and 'results' not in payload and len(route.service.calls) == 1


@pytest.mark.parametrize('owner', ['service', 'actor', 'policy'])
def test_infrastructure_failures_are_private_even_before_route_entry(route, owner):
    from types import SimpleNamespace

    def unavailable(*_args, **_kwargs):
        raise RuntimeError('select private_path from /private/music')

    if owner == 'service':
        route.service.error = RuntimeError('select private_path from /private/music')
    elif owner == 'actor':
        route.app.state.current_actor_resolver = SimpleNamespace(resolve=unavailable)
    else:
        route.app.state.policy_constraint_resolver = unavailable
    status, payload = route.call()
    assert status == 503 and payload['error_code'] == 'private_search_unavailable'
    assert 'data' not in payload and 'select' not in json.dumps(payload) and '/private/music' not in json.dumps(payload)


def test_normalizer_preserves_maximum_bigint_candidates_without_float_coercion():
    ref = 'inventory-track:9223372036854775807:9223372036854775807'
    assert normalize_native_search_batch_command([ref], 'metadata') == [(9223372036854775807, 9223372036854775807)]


@pytest.mark.parametrize('query', ['@listener', '@listener :tracks listened:all'])
def test_listener_http_read_gate_remains_held(route, query):
    denied(route, query={'surface': 'albums', 'q': query}, path='/view-data', method='GET')
