"""E real ASGI/context/CSRF/bounded-body contracts with explicit service doubles.

Source-authored, NOT RUN. This file establishes adapter behavior only; arbitrary
opaque witness strings below are structurally valid transport fixtures, never
claimed to be authenticated consent. The PostgreSQL companion uses actual C2
capture/review/publication without replacing the fixed service constructors.
"""
import asyncio
from copy import deepcopy
from dataclasses import replace
import inspect
import json
from uuid import uuid4

import pytest
from starlette.requests import Request

from music_app.routes import owned_album_tops_asgi as routes
from music_app.services.current_actor import ActorState, CurrentActor
from music_app.services import album_top_artwork_preparation as preparation_module
from music_app.services import album_top_artwork_draft as artwork_draft
from music_app.services import album_top_publication_sources as publication_sources
from music_app.services.owned_album_tops import AlbumTopError, MAX_TOP_COMMAND_BYTES
from music_app.services.private_route_boundary import (
    _is_public, csrf_mode_for_route, private_action_for_route,
)
from music_app.services.private_ui_context import private_ui_context_ref
from tests.py.test_owned_album_top_route_boundary import (
    actor, middleware_app, mutation_headers, request, decoded, TOP, ITEM, ALBUM, REQUEST,
)

PREPARATION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
DRAFT = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
ROW = '12121212-1212-4121-8121-121212121212'
ASSET = '13131313-1313-4131-8131-131313131313'
SOURCE = '14141414-1414-4141-8141-141414141414'
CONTEXT = 'a' * 64
SMALL = 16 * 1024
LARGE = 2 * 1024 * 1024
PNG_LIMIT = 327680
PNG = b'\x89PNG\r\n\x1a\n' + b'route-byte-fixture'
OPERATIONS = ('state', 'sources', 'start', 'status', 'advance', 'review', 'preview', 'save', 'enable')
PREPARATION_OPERATIONS = ('start', 'status', 'advance', 'review', 'preview')
LEGACY_ROUTES = {
    ('GET', '/album-tops'), ('GET', '/album-tops/public-link/{share_ref}'),
    ('HEAD', '/album-tops/public-link/{share_ref}'), ('GET', '/album-tops/edit-requests'),
    ('GET', '/album-tops/{top_ref}/sharing'), ('GET', '/album-tops/{top_ref}/access-grants'),
    ('GET', '/album-tops/{top_ref}/access-candidates'), ('GET', '/album-tops/{top_ref}'),
    ('POST', '/album-tops'), ('POST', '/album-tops/{top_ref}/publication-preview'),
    ('GET', '/album-tops/{top_ref}/items/{item_ref}/publication-sources'),
    ('POST', '/album-tops/{top_ref}/catalog/inventory'), ('GET', '/album-top-catalog/search'),
    ('POST', '/album-top-catalog/remote-preparations'), ('GET', '/album-top-catalog/remote-preparations'),
    ('POST', '/album-top-catalog/remote-preparations/maintain'),
    ('POST', '/album-top-catalog/remote-preparations/{preparation_ref}/close'),
    ('POST', '/album-top-catalog/remote-search'), ('POST', '/album-top-catalog/remote-acquisitions'),
    ('POST', '/album-tops/{top_ref}/{action}'), ('POST', '/album-top-catalog/inventory'),
}


def route_path(operation, *, top_ref=TOP, kind='saved', preparation_ref=PREPARATION, template=False):
    if template:
        top_ref, kind, preparation_ref = '{top_ref}', '{kind}', '{preparation_ref}'
    prefix = '/album-tops/' + top_ref
    if operation in ('state', 'sources', 'save', 'enable'):
        return prefix + '/artwork-publication' + ('' if operation == 'state' else '/' + operation)
    prefix += '/artwork-preparations/' + kind
    return prefix + ('/start' if operation == 'start' else '/' + preparation_ref + '/' + operation)


def witness():
    return {'witness_version': 1, 'metadata_generation': '1', 'metadata_evidence_revision': '1' * 64,
            'asset_manifest_digest': '2' * 64, 'review_digest': '3' * 64, 'token': 'opaque-review-unit-fixture'}


def descriptor(kind='saved', *, action='enable_external'):
    value = {'version': 2, 'kind': kind, 'preparation_ref': PREPARATION,
        'preparation_revision': '1', 'context_ref': CONTEXT, 'review_witness': witness(),
        'publication_intent': {'version': 1, 'action': action, 'link_state': 'no_link',
            'link_revision': None, 'intent_digest': '4' * 64, 'token': 'opaque-intent-unit-fixture'}}
    if kind == 'draft': value.update(draft_ref=DRAFT, draft_revision='1')
    return value


def body_for(operation, kind='saved'):
    identity = {'top_revision': '1'}
    if kind == 'draft': identity.update(draft_ref=DRAFT, draft_revision='1')
    if operation == 'state': return None
    if operation == 'sources':
        return {'revision': '1', 'draft_ref': DRAFT, 'draft_revision': '1', 'row_ref': ROW,
                'item_ref': None, 'album_ref': ALBUM, 'cursor': None, 'limit': 25}
    if operation == 'start':
        value = {'revision': '1', 'request_key': REQUEST, 'request_generation': 1700000000}
        if kind == 'saved': value['items'] = []
        else: value.update(draft_ref=DRAFT, draft_revision='1', rows=[])
        return value
    if operation == 'status': return {**identity, 'after': 0, 'limit': 25}
    if operation == 'advance': return {**identity, 'preparation_revision': '1', 'request_key': REQUEST}
    if operation == 'review':
        return {**identity, 'preparation_revision': '1', 'title': 'Explicit review',
                'description': 'Complete reviewed description', 'action': 'enable_external'}
    if operation == 'preview':
        return {**identity, 'preparation_revision': '1', 'review_witness': witness(),
                'row_ref': ROW, 'asset_ref': ASSET}
    action = 'save' if operation == 'save' else 'enable_external'
    return {'request_key': REQUEST, 'revision': '1', 'title': 'Explicit review',
            'description': 'Complete reviewed description', 'items': [], 'evidence_revision': '1' * 64,
            'artwork_publication': descriptor(kind, action=action)}


async def http_exchange(app, operation=None, *, path=None, kind='saved', top_ref=TOP,
                        preparation_ref=PREPARATION, method=None, payload=None, raw=None,
                        headers=None, raw_headers=(), query=b'', chunks=None, raw_path=None):
    """Actual mounted ASGI request with finite source-owned body and no socket."""
    path = path or route_path(operation, top_ref=top_ref, kind=kind, preparation_ref=preparation_ref)
    method = method or ('GET' if operation == 'state' else 'POST')
    body = (b'' if payload is None else json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()) if raw is None else raw
    pending = list(chunks) if chunks is not None else [body]
    finished = asyncio.Event()
    messages = []
    async def receive():
        if pending:
            return {'type': 'http.request', 'body': pending.pop(0), 'more_body': bool(pending)}
        await finished.wait()
        return {'type': 'http.disconnect'}
    async def send(message):
        messages.append(message)
        if message['type'] == 'http.response.body' and not message.get('more_body', False):
            finished.set()
    values = {'host': 'music.test', 'content-type': 'application/json', **(headers or {})}
    await app({'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
        'method': method, 'scheme': 'https', 'path': path,
        'raw_path': path.encode() if raw_path is None else raw_path, 'query_string': query,
        'headers': [(key.encode('ascii'), value.encode('latin1')) for key, value in values.items()] + list(raw_headers),
        'client': ('127.0.0.1', 50000), 'server': ('music.test', 443)}, receive, send)
    start = next(message for message in messages if message['type'] == 'http.response.start')
    content = b''.join(message.get('body', b'') for message in messages if message['type'] == 'http.response.body')
    return start['status'], content, list(start['headers'])


def json_exchange(app, operation, *, current=None, **options):
    current = app.state.current_actor_resolver.actor if current is None else current
    options.setdefault('headers', mutation_headers(app, current))
    status, body, pairs = asyncio.run(http_exchange(app, operation, **options))
    headers = dict(pairs)
    assert headers[b'cache-control'] == b'private, no-store'
    return status, json.loads(body), headers


class OwnerDouble:
    """Mutation boundary double; no claim of authenticated tokens or SQL commit."""
    def __init__(self):
        self.calls, self.error, self.after = [], None, None
    def execute(self, context, command, *, constraints=None, context_ref=None, cursor_secret=None):
        self.calls.append(('execute', context, command, constraints, context_ref, cursor_secret))
        if self.after: self.after()
        if self.error: raise self.error
        return {'top_ref': TOP, 'revision': '2', 'request_key': command.request_key,
                'action': command.action, 'publication': {'state': 'enabled', 'share_ref': ASSET,
                'link_revision': '1', 'publication_ref': PREPARATION, 'publication_revision': '1'}}


class ReadDouble:
    def __init__(self, owner):
        self.owner, self.calls, self.error, self.after = owner, [], None, None
    def _result(self, name, context, options):
        self.calls.append((name, context, options))
        if self.after: self.after()
        if self.error: raise self.error
        return {'observed_operation': name}
    def read_state(self, context, *, top_ref, context_ref, constraints=None):
        return self._result('state', context, dict(top_ref=top_ref, context_ref=context_ref, constraints=constraints))
    def read_sources(self, context, *, top_ref, payload, context_ref, cursor_secret, constraints=None):
        publication_sources.validate_draft_request(top_ref=top_ref, payload=payload, context_ref=context_ref)
        return self._result('sources', context, dict(top_ref=top_ref, payload=payload, context_ref=context_ref,
                                                    cursor_secret=cursor_secret, constraints=constraints))


class PreparationDouble:
    """Only fixed approved service methods exist; unknown dispatch must fail."""
    def __init__(self, owner):
        self.owner, self.calls, self.error, self.after = owner, [], None, None
        self.png = {'body': PNG, 'content_type': 'image/png', 'content_length': len(PNG),
                    'cache_control': 'private, no-store', 'x_content_type_options': 'nosniff',
                    'referrer_policy': 'no-referrer'}
    def _result(self, name, context, options):
        self.calls.append((name, context, options))
        if self.after: self.after()
        if self.error: raise self.error
        return self.png if name in ('read_saved_png', 'read_draft_png') else {'observed_operation': name}
    def start(self, context, *, top_ref, payload, context_ref, constraints=None):
        preparation_module._normalize_start(payload)
        return self._result('start', context, dict(top_ref=top_ref, payload=payload, context_ref=context_ref, constraints=constraints))
    def start_draft(self, context, *, top_ref, payload, context_ref, constraints=None):
        artwork_draft.normalize(payload)
        return self._result('start_draft', context, dict(top_ref=top_ref, payload=payload, context_ref=context_ref, constraints=constraints))
    def read(self, context, *, top_ref, preparation_ref, top_revision_value, context_ref, after, limit, constraints=None):
        return self._result('read', context, dict(top_ref=top_ref, preparation_ref=preparation_ref,
            top_revision_value=top_revision_value, context_ref=context_ref, after=after, limit=limit, constraints=constraints))
    def read_draft(self, context, *, top_ref, preparation_ref, top_revision_value, context_ref,
                   draft_ref, draft_revision, after, limit, constraints=None):
        return self._result('read_draft', context, dict(top_ref=top_ref, preparation_ref=preparation_ref,
            top_revision_value=top_revision_value, context_ref=context_ref, draft_ref=draft_ref,
            draft_revision=draft_revision, after=after, limit=limit, constraints=constraints))
    def advance(self, context, *, top_ref, preparation_ref, top_revision_value, preparation_revision,
                request_key, context_ref, constraints=None):
        return self._result('advance', context, dict(top_ref=top_ref, preparation_ref=preparation_ref,
            top_revision_value=top_revision_value, preparation_revision=preparation_revision,
            request_key=request_key, context_ref=context_ref, constraints=constraints))
    def advance_draft(self, context, *, top_ref, preparation_ref, top_revision_value, preparation_revision,
                      request_key, context_ref, draft_ref, draft_revision, constraints=None):
        return self._result('advance_draft', context, dict(top_ref=top_ref, preparation_ref=preparation_ref,
            top_revision_value=top_revision_value, preparation_revision=preparation_revision,
            request_key=request_key, context_ref=context_ref, draft_ref=draft_ref,
            draft_revision=draft_revision, constraints=constraints))
    def review_publication_saved(self, context, *, top_ref, top_revision, preparation_ref,
                                 preparation_revision, context_ref, cursor_secret, title, description,
                                 action, constraints=None):
        return self._result('review_publication_saved', context, dict(top_ref=top_ref, top_revision=top_revision,
            preparation_ref=preparation_ref, preparation_revision=preparation_revision, context_ref=context_ref,
            cursor_secret=cursor_secret, title=title, description=description, action=action, constraints=constraints))
    def review_publication_draft(self, context, *, top_ref, top_revision, preparation_ref,
                                 preparation_revision, context_ref, cursor_secret, title, description,
                                 action, draft_ref, draft_revision, constraints=None):
        return self._result('review_publication_draft', context, dict(top_ref=top_ref, top_revision=top_revision,
            preparation_ref=preparation_ref, preparation_revision=preparation_revision, context_ref=context_ref,
            cursor_secret=cursor_secret, title=title, description=description, action=action,
            draft_ref=draft_ref, draft_revision=draft_revision, constraints=constraints))
    def read_saved_png(self, context, *, top_ref, top_revision, preparation_ref, preparation_revision,
                       context_ref, cursor_secret, review_witness, row_ref, asset_ref, head_only, constraints=None):
        return self._result('read_saved_png', context, dict(top_ref=top_ref, top_revision=top_revision,
            preparation_ref=preparation_ref, preparation_revision=preparation_revision, context_ref=context_ref,
            cursor_secret=cursor_secret, review_witness=review_witness, row_ref=row_ref, asset_ref=asset_ref,
            head_only=head_only, constraints=constraints))
    def read_draft_png(self, context, *, top_ref, top_revision, preparation_ref, preparation_revision,
                       context_ref, cursor_secret, review_witness, row_ref, asset_ref, head_only,
                       draft_ref, draft_revision, constraints=None):
        return self._result('read_draft_png', context, dict(top_ref=top_ref, top_revision=top_revision,
            preparation_ref=preparation_ref, preparation_revision=preparation_revision, context_ref=context_ref,
            cursor_secret=cursor_secret, review_witness=review_witness, row_ref=row_ref, asset_ref=asset_ref,
            head_only=head_only, draft_ref=draft_ref, draft_revision=draft_revision, constraints=constraints))


@pytest.fixture
def adapters(monkeypatch):
    owner = OwnerDouble()
    reads, preparation = ReadDouble(owner), PreparationDouble(owner)
    def owner_factory(actual):
        assert actual is owner
        return reads
    def preparation_factory(actual):
        assert actual is owner
        return preparation
    monkeypatch.setattr(routes, 'TopArtworkOwnerService', owner_factory)
    monkeypatch.setattr(routes, 'TopArtworkPreparationService', preparation_factory)
    return owner, reads, preparation


def all_calls(adapters):
    return [call for service in adapters for call in service.calls]


def test_exact_full_router_inventory_adds_only_nine_private_patterns():
    expected_new = {('GET' if operation == 'state' else 'POST', route_path(operation, template=True))
                    for operation in OPERATIONS}
    actual = [(method, route.path) for route in routes.router.routes for method in route.methods]
    assert len(actual) == len(set(actual))
    assert set(actual) == LEGACY_ROUTES | expected_new
    for method, path in expected_new:
        assert private_action_for_route(method, path) is None  # Existing default-private app.access admission.
        assert csrf_mode_for_route(method, path) == ('none' if method == 'GET' else 'session_header')
        assert not _is_public(method, path)


@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('operation', OPERATIONS)
def test_exact_fixed_service_dispatch_current_context_and_server_owned_key(adapters, operation, kind):
    owner, reads, preparation = adapters
    app = middleware_app(owner, actor())
    payload = body_for(operation, kind)
    status, content, pairs = asyncio.run(http_exchange(app, operation, kind=kind,
        payload=payload, headers=mutation_headers(app, actor())))
    assert status == 200
    expected_context = mutation_headers(app, actor())['x-albumhaven-context']
    if operation == 'preview':
        assert content == PNG
        headers = dict(pairs)
        assert [value for key, value in pairs if key.lower() == b'x-albumhaven-context'] == [expected_context.encode()]
        assert headers[b'content-type'] == b'image/png' and headers[b'content-length'] == str(len(PNG)).encode()
        assert headers[b'content-encoding'] == b'identity'
        assert headers[b'cache-control'] == b'private, no-store'
        assert headers[b'x-content-type-options'] == b'nosniff' and headers[b'referrer-policy'] == b'no-referrer'
        assert b'content-disposition' not in headers and b'etag' not in headers
    else:
        envelope = json.loads(content)
        assert set(envelope) == {'status', 'data', 'context_ref'}
        assert envelope['status'] == 'ready' and envelope['context_ref'] == expected_context
    assert len(all_calls(adapters)) == 1
    if operation in ('save', 'enable'):
        name, context, command, constraints, context_ref, secret = owner.calls[0]
        assert command.action == ('save' if operation == 'save' else 'enable_external')
        assert command.data['artwork_publication'] == payload['artwork_publication']
        assert command.request_key == REQUEST and command.top_ref == TOP
        assert context_ref == expected_context and secret == app.state.auth_policy_config['hmac']['secret']
    else:
        name, context, options = (reads if operation in ('state', 'sources') else preparation).calls[0]
        expected = {'state': 'state', 'sources': 'sources', 'start': 'start' if kind == 'saved' else 'start_draft',
                    'status': 'read' if kind == 'saved' else 'read_draft',
                    'advance': 'advance' if kind == 'saved' else 'advance_draft',
                    'review': 'review_publication_' + kind,
                    'preview': 'read_' + kind + '_png'}[operation]
        assert name == expected and options['top_ref'] == TOP and options['context_ref'] == expected_context
        if operation in ('sources', 'start'): assert options['payload'] == payload
        if operation in ('sources', 'review', 'preview'):
            assert options['cursor_secret'] == app.state.auth_policy_config['hmac']['secret']
        if operation == 'preview': assert options['head_only'] is False
    assert context.actor.account_id == actor().account_id and context.actor.session_id == actor().session_id


@pytest.mark.parametrize('operation', OPERATIONS)
@pytest.mark.parametrize('failure', ['missing', 'wrong', 'duplicate', 'mixed_case_duplicate'])
def test_exactly_one_current_context_header_precedes_every_service(adapters, operation, failure):
    app = middleware_app(adapters[0], actor())
    headers = mutation_headers(app, actor())
    raw_headers = []
    if failure == 'missing': headers.pop('x-albumhaven-context')
    elif failure == 'wrong': headers['x-albumhaven-context'] = '0' * 64
    else:
        raw_headers.append((b'X-AlbumHaven-Context' if failure == 'mixed_case_duplicate'
                            else b'x-albumhaven-context', headers['x-albumhaven-context'].encode()))
    status, body, _ = json_exchange(app, operation, payload=body_for(operation), headers=headers,
                                     raw_headers=raw_headers)
    assert (status, body) == (409, {'ok': False, 'error': 'stale_context'})
    assert all_calls(adapters) == []


@pytest.mark.parametrize('operation', OPERATIONS)
@pytest.mark.parametrize('query', [b'unknown=1', b'&', b'?', b'x=%00'])
def test_any_nonempty_raw_query_is_rejected_before_service(adapters, operation, query):
    app = middleware_app(adapters[0], actor())
    status, body, _ = json_exchange(app, operation, payload=body_for(operation), query=query)
    assert status == 422 and body == {'ok': False, 'error': 'invalid_query'}
    assert all_calls(adapters) == []


@pytest.mark.parametrize('operation', [operation for operation in OPERATIONS if operation != 'state'])
@pytest.mark.parametrize('raw', [b'{', b'[]', b'null', b'1', b'"text"', b'\xff'])
def test_nonobject_or_malformed_json_cannot_reach_any_artwork_service(adapters, operation, raw):
    app = middleware_app(adapters[0], actor())
    status, body, _ = json_exchange(app, operation, raw=raw)
    assert status == 422 and body == {'ok': False, 'error': 'invalid_query' if operation == 'sources' else 'invalid_command'}
    assert all_calls(adapters) == []


@pytest.mark.parametrize('operation', [operation for operation in OPERATIONS if operation != 'state'])
@pytest.mark.parametrize('field', ['context_ref', 'cursor_secret', 'account_id', 'library_id',
                                 'backend', 'local_path', 'head_only'])
def test_extra_body_fields_cannot_select_context_authority_key_or_backend(adapters, operation, field):
    app = middleware_app(adapters[0], actor())
    payload = {**body_for(operation), field: 'untrusted'}
    status, body, _ = json_exchange(app, operation, payload=payload)
    assert status == 422 and body == {'ok': False, 'error': 'invalid_query' if operation == 'sources' else 'invalid_command'}
    assert all_calls(adapters) == []


@pytest.mark.parametrize('operation', [operation for operation in OPERATIONS if operation != 'state'])
@pytest.mark.parametrize('failure', ['declared_over', 'stream_over', 'invalid_length', 'negative_length', 'mismatch'])
def test_fixed_input_byte_ceiling_is_applied_before_service(adapters, operation, failure):
    app = middleware_app(adapters[0], actor())
    bound = LARGE if operation in ('start', 'save', 'enable') else SMALL
    headers = mutation_headers(app, actor())
    options = {'raw': b'{}', 'headers': headers}
    if failure == 'declared_over': headers['content-length'] = str(bound + 1)
    elif failure == 'stream_over': options['chunks'] = [b' ' * bound, b' ']
    else: headers['content-length'] = {'invalid_length': 'no', 'negative_length': '-1', 'mismatch': '3'}[failure]
    status, body, _ = json_exchange(app, operation, **options)
    assert status == (413 if failure.endswith('_over') else 422)
    assert body == {'ok': False, 'error': 'command_too_large' if status == 413 else
                    'invalid_query' if operation == 'sources' else 'invalid_command'}
    assert all_calls(adapters) == []


@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('operation', [operation for operation in OPERATIONS if operation != 'state'])
def test_exact_new_input_limit_is_accepted_without_widening_legacy(adapters, operation, kind):
    app = middleware_app(adapters[0], actor())
    bound = LARGE if operation in ('start', 'save', 'enable') else SMALL
    raw = json.dumps(body_for(operation, kind), separators=(',', ':')).encode()
    assert len(raw) < bound
    raw += b' ' * (bound - len(raw))
    headers = {**mutation_headers(app, actor()), 'content-length': str(bound)}
    status, _, _ = asyncio.run(http_exchange(app, operation, kind=kind, raw=raw, headers=headers))
    assert status == 200 and len(all_calls(adapters)) == 1
    assert MAX_TOP_COMMAND_BYTES == 524288


def test_legacy_save_still_rejects_a_body_over_its_original_limit(adapters):
    app = middleware_app(adapters[0], actor())
    raw = json.dumps({'request_key': REQUEST, 'revision': '1', 'title': 'Ordinary private edit'}).encode()
    raw += b' ' * (MAX_TOP_COMMAND_BYTES + 1 - len(raw))
    status, body, _ = json_exchange(app, 'save', path=f'/album-tops/{TOP}/save', raw=raw)
    assert status == 413 and body == {'ok': False, 'error': 'command_too_large'}
    assert all_calls(adapters) == []


@pytest.mark.parametrize('operation', ['save', 'enable'])
@pytest.mark.parametrize('change', ['absent', 'version_one', 'missing_intent', 'item_selections'])
def test_dedicated_command_routes_never_strip_or_downgrade_descriptor(adapters, operation, change):
    app = middleware_app(adapters[0], actor())
    payload = body_for(operation)
    if change == 'absent': payload.pop('artwork_publication')
    elif change == 'version_one': payload['artwork_publication']['version'] = 1
    elif change == 'missing_intent': payload['artwork_publication'].pop('publication_intent')
    else: payload['item_selections'] = payload.pop('items')
    status, body, _ = json_exchange(app, operation, payload=payload)
    assert status == 422 and body['ok'] is False
    assert all_calls(adapters) == []


@pytest.mark.parametrize('operation', PREPARATION_OPERATIONS)
@pytest.mark.parametrize('kind', ['Saved', 'DRAFT', 'remote', 'read_saved_png', '__dict__'])
def test_kind_dispatch_is_closed_and_never_attribute_selected(adapters, operation, kind):
    app = middleware_app(adapters[0], actor())
    status, body, _ = json_exchange(app, operation, kind=kind, payload=body_for(operation))
    assert status == 422 and body == {'ok': False, 'error': 'invalid_command'}
    assert all_calls(adapters) == []


@pytest.mark.parametrize('operation', OPERATIONS)
@pytest.mark.parametrize('failure', ['anonymous', 'inactive', 'ungranted'])
def test_all_new_routes_remain_inside_actual_private_middleware(adapters, operation, failure):
    current = (CurrentActor.anonymous() if failure == 'anonymous' else
               replace(actor(), state=ActorState.INACTIVE) if failure == 'inactive' else
               replace(actor(), capability_grants=()))
    app = middleware_app(adapters[0], current)
    status, raw, pairs = asyncio.run(http_exchange(app, operation, payload=body_for(operation)))
    assert status == (403 if failure == 'ungranted' else 401)
    assert dict(pairs)[b'cache-control'] == b'private, no-store'
    assert all_calls(adapters) == []


@pytest.mark.parametrize('operation', [operation for operation in OPERATIONS if operation != 'state'])
@pytest.mark.parametrize('failure', ['no_csrf', 'wrong_origin', 'no_cookie'])
def test_every_new_post_keeps_actual_session_csrf_before_handler(adapters, operation, failure):
    app = middleware_app(adapters[0], actor())
    headers = mutation_headers(app, actor())
    if failure == 'no_csrf': headers.pop('x-album-haven-csrf')
    elif failure == 'wrong_origin': headers['origin'] = 'https://elsewhere.example.test'
    else: headers.pop('cookie')
    status, body, _ = json_exchange(app, operation, payload=body_for(operation), headers=headers)
    assert status == 403 and body == {'detail': 'CSRF validation failed.'}
    assert all_calls(adapters) == []


@pytest.mark.parametrize('operation', OPERATIONS)
@pytest.mark.parametrize('error', [AlbumTopError('forbidden', 403), AlbumTopError('revision_conflict', 409),
                                 RuntimeError('/private/path and secret must never escape')])
def test_errors_are_bounded_sanitized_private_responses(adapters, operation, error):
    app = middleware_app(adapters[0], actor())
    for service in adapters: service.error = error
    status, body, _ = json_exchange(app, operation, payload=body_for(operation))
    assert status == (error.status_code if isinstance(error, AlbumTopError) else 503)
    assert set(body) == {'ok', 'error'} and body['ok'] is False
    if isinstance(error, AlbumTopError): assert body['error'] == error.code
    assert '/private/path' not in json.dumps(body) and 'secret' not in json.dumps(body)


@pytest.mark.parametrize('operation', OPERATIONS)
def test_context_change_after_service_cannot_relabel_or_release_old_data(adapters, operation):
    app = middleware_app(adapters[0], actor())
    # Rotation changes the real context digest. No context helper is stubbed.
    def rotate():
        app.state.auth_policy_config['hmac'] = {'secret': 'rotated-e-http-current-auth-key-32-bytes', 'key_version': 2}
    for service in adapters: service.after = rotate
    status, body, pairs = asyncio.run(http_exchange(app, operation, payload=body_for(operation),
        headers=mutation_headers(app, actor())))
    assert status == 409 and json.loads(body) == {'ok': False, 'error': 'stale_context'}
    assert b'route-byte-fixture' not in body and b'observed_operation' not in body
    assert not any(name.lower() == b'x-albumhaven-context' for name, _ in pairs)


async def invoke_actual_handler(req, operation, kind='saved'):
    matches = [route for route in routes.router.routes if route.path == route_path(operation, template=True)]
    assert len(matches) == 1
    kwargs = {'top_ref': TOP}
    if operation in PREPARATION_OPERATIONS: kwargs['kind'] = kind
    if operation in PREPARATION_OPERATIONS and operation != 'start': kwargs['preparation_ref'] = PREPARATION
    result = matches[0].endpoint(req, **kwargs)
    return await result if inspect.isawaitable(result) else result


@pytest.mark.parametrize('operation', OPERATIONS)
@pytest.mark.parametrize('key', [None, '', 'short', 3, '\ud800' * 40])
def test_real_context_helper_rejects_global_key_loss_before_execute(adapters, operation, key):
    req = request(adapters[0], payload=body_for(operation))
    req.scope.update(path=route_path(operation), method='GET' if operation == 'state' else 'POST')
    req.app.state.auth_policy_config['hmac']['secret'] = key
    response = asyncio.run(invoke_actual_handler(req, operation))
    assert response.status_code == 503
    assert decoded(response) == {'ok': False, 'error': 'private_ui_context_unavailable'}
    assert all_calls(adapters) == []


@pytest.mark.parametrize('operation', ['save', 'enable'])
def test_valid_current_key_and_context_forward_old_exact_descriptor_without_discovery(adapters, operation):
    owner, reads, preparation = adapters
    app = middleware_app(owner, actor())
    app.state.auth_policy_config['hmac'] = {'secret': 'rotated-e-http-current-auth-key-32-bytes', 'key_version': 2}
    payload = body_for(operation)
    assert payload['artwork_publication']['context_ref'] != mutation_headers(app, actor())['x-albumhaven-context']
    status, body, _ = json_exchange(app, operation, payload=payload)
    assert status == 200 and len(owner.calls) == 1 and reads.calls == preparation.calls == []
    assert owner.calls[0][2].data['artwork_publication'] == payload['artwork_publication']
    assert body['data']['request_key'] == payload['request_key']
    # This proves adapter ordering, not receipt authentication or a real replay.


@pytest.mark.parametrize('field,value', [
    ('body', b''), ('body', bytearray(PNG)), ('content_length', 0),
    ('content_length', True), ('content_length', len(PNG) + 1),
    ('content_length', PNG_LIMIT + 1), ('content_type', 'image/jpeg'),
    ('content_type', 'image/png; charset=utf-8'), ('cache_control', 'public, max-age=3600'),
    ('x_content_type_options', ''), ('referrer_policy', 'origin'),
])
def test_preview_response_contract_is_checked_before_bytes_escape(adapters, field, value):
    adapters[2].png[field] = value
    app = middleware_app(adapters[0], actor())
    status, body, pairs = asyncio.run(http_exchange(app, 'preview', payload=body_for('preview'),
        headers=mutation_headers(app, actor())))
    assert status == 503 and json.loads(body) == {'ok': False, 'error': 'unavailable'}
    assert b'route-byte-fixture' not in body
    assert not any(key.lower() == b'x-albumhaven-context' for key, _ in pairs)


@pytest.mark.parametrize('size,success', [(PNG_LIMIT, True), (PNG_LIMIT + 1, False)])
def test_preview_exact_transport_byte_limit_and_one_byte_over(adapters, size, success):
    adapters[2].png.update(body=b'x' * size, content_length=size)
    app = middleware_app(adapters[0], actor())
    status, body, pairs = asyncio.run(http_exchange(app, 'preview', payload=body_for('preview'),
        headers=mutation_headers(app, actor())))
    assert status == (200 if success else 503)
    if success: assert body == b'x' * size and int(dict(pairs)[b'content-length']) == size
    else: assert json.loads(body) == {'ok': False, 'error': 'unavailable'}
    # Byte-boundary adapter fixture only. Authentic PNG provenance is tested by
    # the separate actual-capture PostgreSQL path, not these arbitrary bytes.


@pytest.mark.parametrize('operation,bound', [('state', 2 * 1024 * 1024 + 1024),
                                           ('review', 36 * 1024 * 1024 + 1024)])
@pytest.mark.parametrize('over', [False, True])
def test_route_response_utf8_envelope_has_fixed_exact_ceiling(adapters, monkeypatch, operation, bound, over):
    app = middleware_app(adapters[0], actor())
    envelope = {'status': 'ready', 'data': {'padding': ''}, 'context_ref': mutation_headers(app, actor())['x-albumhaven-context']}
    empty_size = len(json.dumps(envelope, ensure_ascii=False, separators=(',', ':')).encode())
    value = {'padding': 'x' * (bound - empty_size + int(over))}
    # The service boundary is deliberately isolated here, to exercise actual
    # envelope accounting without constructing a misleading full review vector.
    method = 'read_state' if operation == 'state' else 'review_publication_saved'
    monkeypatch.setattr(adapters[1] if operation == 'state' else adapters[2], method, lambda *args, **kwargs: value)
    status, content, _ = asyncio.run(http_exchange(app, operation, payload=body_for(operation),
        headers=mutation_headers(app, actor())))
    if over:
        assert status == 409 and json.loads(content) == {'ok': False, 'error': 'artwork_validation_limit'}
    else:
        assert status == 200 and len(content) == bound


def test_owner_state_get_rejects_even_small_unexpected_body(adapters):
    app = middleware_app(adapters[0], actor())
    status, body, _ = json_exchange(app, 'state', raw=b' ')
    assert status == 422 and body == {'ok': False, 'error': 'invalid_command'}
    assert all_calls(adapters) == []


@pytest.mark.parametrize('settings', [None, {}, {'hmac': None}, {'hmac': {}}, {'hmac': {'secret': None}}])
def test_optional_key_adapter_is_not_an_independent_eager_key_validator(settings):
    req = request(OwnerDouble())
    req.app.state.auth_policy_config = settings
    assert routes._artwork_key(req) is None
    # Pure collaborator lookup only. Actual HTTP admission with these global
    # settings must fail as tested above; this does not claim keyless HTTP replay.
