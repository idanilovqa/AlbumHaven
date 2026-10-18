"""E mounted private HTTP path using actual C2 consent, capture and SQL commit.

Source-authored, NOT RUN. The existing middleware resolver supplies an actor
loaded from the real current-library transaction; it is the authentication
fixture seam, not evidence of browser login/token-store integration. Context,
CSRF, route registration, fixed owner/preparation constructors, source policy,
capture, review witnesses, intent and publication are genuine product owners.
No fabricated token/proof/PNG, SQL result or alternate publishing collaborator.
"""
import asyncio
from copy import deepcopy
from hashlib import sha256
import json
from time import sleep
from uuid import uuid4

import pytest
from starlette.requests import Request

from music_app.routes import owned_album_tops_asgi as routes
from music_app.services import album_top_artwork_preparation as preparation_module
from music_app.services.owned_album_tops import ACCESS, BROWSE, normalize_top_command
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_ui_context import private_ui_context_ref
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error
from tests.py.test_album_top_collaboration_postgres import new_session, member
from tests.py.test_top_artwork_draft_preparation_postgres import command as draft_command
from tests.py.test_top_artwork_publication_retention_postgres import (
    publication_case, POSIX_CAPTURE, durable_snapshot, preparation_header, assert_staging_budget,
)
from tests.py.test_top_artwork_publication_postgres import (
    c2_case, publication_rows, trap_pixels, observe, SECRET, OTHER_SECRET, HEADER,
)
from tests.py.test_owned_album_top_route_boundary import middleware_app, mutation_headers
from tests.py.test_top_artwork_owner_http import http_exchange, json_exchange, route_path
from tests.py.test_top_artwork_owner_sources_postgres import maintenance


def app_for(case, *, current=None, secret=SECRET, key_version=1):
    # Actual runtime authority reloads persisted grants, including capability.view.
    # Do not synthesize an HTTP actor with an unpersisted capability.
    with case.db.service._authorized(case.db.context(current), None) as (_, live, _):
        current = live.actor
    app = middleware_app(case.db.service, current)
    app.state.config = {**case.db.service._config, 'ALBUM_HAVEN_DEPLOYMENT_MODE': 'self_hosted'}
    app.state.auth_policy_config['hmac'] = {'secret': secret, 'key_version': key_version}
    return app


def current_context(app):
    return private_ui_context_ref(Request({'type': 'http', 'app': app,
        'state': {'current_actor': app.state.current_actor_resolver.actor}}))


def request_json(case, app, operation, *, expected=200, **options):
    status, body, headers = json_exchange(app, operation, top_ref=case.top['top_ref'], **options)
    assert status == expected, (status, body)
    if expected == 200:
        assert set(body) == {'status', 'context_ref', 'data'}
        assert body['status'] == 'ready' and body['context_ref'] == current_context(app)
        return body['data']
    return body


def identity(case, kind, payload):
    result = {'top_revision': case.top['revision']}
    if kind == 'draft': result.update(draft_ref=payload['draft_ref'], draft_revision=payload['draft_revision'])
    return result


def http_ready(case, app, kind, *, payload=None):
    observed = request_json(case, app, 'state')
    assert observed['revision'] == case.top['revision']
    if payload is None:
        payload = ({'revision': case.top['revision'], 'request_key': str(uuid4()),
                    'items': deepcopy(case.items)} if kind == 'saved' else draft_command(case))
    payload = {**deepcopy(payload), 'request_generation': observed['request_generation']}
    state = request_json(case, app, 'start', kind=kind, payload=payload)
    rows = payload['items'] if kind == 'saved' else payload['rows']
    included = sum(row['include_artwork'] for row in rows)
    for _ in range(max(1, (included + 3) // 4)):
        if state['state'] == 'ready': break
        state = request_json(case, app, 'advance', kind=kind, preparation_ref=state['preparation_ref'],
            payload={**identity(case, kind, payload), 'preparation_revision': state['preparation_revision'],
                     'request_key': str(uuid4())})
    assert state['state'] == 'ready', 'Preparation did not finish within its real four-row batch bound'
    return state, payload


def http_review(case, app, kind, state, payload, *, action='enable_external', header=None):
    approved = request_json(case, app, 'review', kind=kind, preparation_ref=state['preparation_ref'],
        payload={**identity(case, kind, payload), 'preparation_revision': state['preparation_revision'],
                 **(HEADER if header is None else header), 'action': action})
    if kind == 'saved':
        items = [{key: value for key, value in row.items() if key != 'include_artwork'} for row in payload['items']]
    else:
        items = [{'item_ref': row['selection'].get('item_ref'), 'album_ref': row['selection']['album_ref'],
            'selected_local_album_id': row['selection']['source']['selected_local_album_id'],
            'selected_source_ref': row['selection']['source']['selected_source_ref']} for row in payload['rows']]
    descriptor = {'version': 2, 'kind': kind, 'preparation_ref': state['preparation_ref'],
        'preparation_revision': state['preparation_revision'], 'context_ref': current_context(app),
        'review_witness': approved['review_witness'], 'publication_intent': approved['publication_intent']}
    if kind == 'draft': descriptor.update(draft_ref=payload['draft_ref'], draft_revision=payload['draft_revision'])
    command = {'request_key': str(uuid4()), 'revision': case.top['revision'], **approved['proposed_header'],
        'items': items, 'evidence_revision': approved['metadata_evidence_revision'], 'artwork_publication': descriptor}
    return approved, command


def http_execute(case, app, body, *, action='enable_external', expected=200):
    return request_json(case, app, 'save' if action == 'save' else 'enable', payload=body, expected=expected)


def publish(case, app, *, kind='saved', action='enable_external', payload=None, header=None):
    state, payload = http_ready(case, app, kind, payload=payload)
    approved, body = http_review(case, app, kind, state, payload, action=action, header=header)
    receipt = http_execute(case, app, body, action=action)
    case.top = receipt
    return state, payload, approved, body, receipt


def preview_request(case, kind, state, payload, approved, row):
    return {**identity(case, kind, payload), 'preparation_revision': state['preparation_revision'],
        'review_witness': approved['review_witness'], 'row_ref': row['row_ref'], 'asset_ref': row['artwork_ref']}


def image_response(case, app, kind, state, payload, approved, row):
    return asyncio.run(http_exchange(app, 'preview', kind=kind, top_ref=case.top['top_ref'],
        preparation_ref=state['preparation_ref'], payload=preview_request(case, kind, state, payload, approved, row),
        headers=mutation_headers(app, app.state.current_actor_resolver.actor)))


@POSIX_CAPTURE
@pytest.mark.parametrize('kind', ['saved', 'draft'])
def test_genuine_http_prepare_review_png_then_separate_explicit_publish(c2_case, kind):
    case = c2_case.build(2)
    app = app_for(case)
    state, payload = http_ready(case, app, kind)
    before = durable_snapshot(case)
    approved, body = http_review(case, app, kind, state, payload)
    assert durable_snapshot(case) == before, 'Review must not publish, mutate membership, or consume staging'
    assert approved['proposed_header'] == HEADER and approved['item_count'] == approved['included_count'] == 2
    assert len(approved['items']) == 2 and all(row['included'] for row in approved['items'])
    selected = approved['items'][1]
    status, png, pairs = image_response(case, app, kind, state, payload, approved, selected)
    assert status == 200 and png.startswith(b'\x89PNG\r\n\x1a\n')
    headers = dict(pairs)
    assert headers[b'content-type'] == b'image/png' and int(headers[b'content-length']) == len(png) <= 327680
    assert headers[b'content-encoding'] == b'identity'
    assert headers[b'cache-control'] == b'private, no-store'
    assert headers[b'x-content-type-options'] == b'nosniff' and headers[b'referrer-policy'] == b'no-referrer'
    assert [value for key, value in pairs if key.lower() == b'x-albumhaven-context'] == [current_context(app).encode()]
    with maintenance(case.db) as connection:
        asset = connection.execute('select png,content_digest,byte_length from app.album_top_artwork_assets where ref=%s',
                                   (selected['artwork_ref'],)).fetchone()
    assert png == bytes(asset['png']) and sha256(png).hexdigest() == asset['content_digest']
    assert durable_snapshot(case) == before
    with observe(case) as trace:
        receipt = http_execute(case, app, body)
    case.top = receipt
    header, items, rows, lineage, consumed, seal, operation = publication_rows(case, receipt)
    assert header['contract_version'] == seal['seal_contract_version'] == 2
    assert len(items) == len(rows) == lineage['row_count'] == 2
    assert consumed['publication_ref'] == header['ref'] and seal['sealed_at'] is not None
    assert str(operation['request_key']) == body['request_key']
    assert trace['steps'][-4:] == ['pointer', 'receipt', 'consume', 'finalizer']
    assert_staging_budget(case, 0, 0, 0)
    with maintenance(case.db) as connection:
        assert connection.execute('select 1 from app.album_top_artwork_preparations where ref=%s',
                                  (state['preparation_ref'],)).fetchone() is None


@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('count', [0, 1, 100, 101, 250, 5000])
def test_full_all_excluded_http_vector_needs_no_artwork_observation_but_is_v2(c2_case, kind, count, monkeypatch):
    case = c2_case.build(count, excluded=range(count))
    app = app_for(case)
    trap_pixels(monkeypatch, all_observation=True)
    with observe(case):
        state, payload, approved, body, receipt = publish(case, app, kind=kind)
    assert len(body['items']) == approved['item_count'] == count
    assert approved['included_count'] == approved['total_image_bytes'] == 0
    assert all(row['included'] is False and row['artwork_ref'] is None for row in approved['items'])
    header, items, rows, lineage, consumed, seal, _ = publication_rows(case, receipt)
    assert header['contract_version'] == seal['seal_contract_version'] == 2
    assert len(items) == len(rows) == lineage['row_count'] == count
    assert all(row['included'] is False for row in rows)
    assert_staging_budget(case, 0, 0, 0)


@pytest.mark.parametrize('new_row', [False, True])
def test_genuine_http_source_discovery_preserves_nullable_unsaved_identity(c2_case, new_row, monkeypatch):
    case = c2_case.build(1, excluded=(0,))
    if new_row:
        case.top = case.db.service.execute(case.db.context(), case.db.command('remove', case.top,
            item_refs=[case.items[0]['item_ref']]))
    app = app_for(case)
    payload = {'revision': case.top['revision'], 'draft_ref': str(uuid4()), 'draft_revision': '1',
        'row_ref': str(uuid4()), 'item_ref': None if new_row else case.items[0]['item_ref'],
        'album_ref': case.catalog_refs[0], 'cursor': None, 'limit': 25}
    before = durable_snapshot(case)
    trap_pixels(monkeypatch, all_observation=True)
    result = request_json(case, app, 'sources', payload=payload)
    assert result['item_ref'] == payload['item_ref'] and result['row_ref'] == payload['row_ref']
    assert result['draft_ref'] == payload['draft_ref'] and result['draft_revision'] == '1'
    assert result['next_cursor'] is None and len(result['sources']) == 1
    assert result['sources'][0]['selected_source_ref'] == case.source_refs[0]
    assert result['sources'][0]['selected_local_album_id'] == case.album_ids[0]
    assert durable_snapshot(case) == before


def test_existing_metadata_only_http_preview_enable_and_save_keep_v1(c2_case, monkeypatch):
    case = c2_case.build(1, excluded=(0,))
    app = app_for(case)
    trap_pixels(monkeypatch, all_observation=True)
    def forbidden(*args, **kwargs):
        raise AssertionError('Ordinary v1 route must not construct artwork owners')
    monkeypatch.setattr(routes, 'TopArtworkOwnerService', forbidden)
    monkeypatch.setattr(routes, 'TopArtworkPreparationService', forbidden)
    selected = [{key: value for key, value in row.items() if key != 'include_artwork'} for row in case.items]
    status, preview, _ = json_exchange(app, 'review',
        path=f"/album-tops/{case.top['top_ref']}/publication-preview",
        payload={'revision': case.top['revision'], 'items': selected})
    assert status == 200 and preview['status'] == 'ready'
    body = {'request_key': str(uuid4()), 'revision': case.top['revision'],
        'title': 'Ordinary metadata-only sharing', 'description': '', 'items': selected,
        'evidence_revision': preview['data']['evidence_revision']}
    for action in ('enable_external', 'save'):
        status, result, _ = json_exchange(app, 'save',
            path=f"/album-tops/{case.top['top_ref']}/{action}", payload=body)
        assert status == 200 and result['status'] == 'ready'
        case.top = result['data']
        with maintenance(case.db) as connection:
            row = connection.execute('''select p.contract_version,s.seal_contract_version
                from app.album_list_publications p join app.album_list_publication_seals s
                on s.publication_ref=p.ref where p.ref=%s''',
                (case.top['publication']['publication_ref'],)).fetchone()
            assert row['contract_version'] == row['seal_contract_version'] == 1
            assert connection.execute('select 1 from app.album_top_artwork_publication_lineage where top_ref=%s',
                                      (case.top['top_ref'],)).fetchone() is None
        body = {'request_key': str(uuid4()), 'revision': case.top['revision'],
                'title': 'Ordinary v1 header edit'}


@pytest.mark.parametrize('kind', ['saved', 'draft'])
def test_publishing_header_only_save_requires_fresh_v2_review_and_exact_full_header(c2_case, kind, monkeypatch):
    case = c2_case.build(2, excluded=(0, 1))
    app = app_for(case)
    publish(case, app, kind=kind)
    before = durable_snapshot(case)
    ordinary = {'request_key': str(uuid4()), 'revision': case.top['revision'], 'title': 'No silent v1 downgrade'}
    status, body, _ = json_exchange(app, 'save', path=f"/album-tops/{case.top['top_ref']}/save", payload=ordinary)
    assert status == 409 and body == {'ok': False, 'error': 'artwork_review_required'}
    assert durable_snapshot(case) == before
    trap_pixels(monkeypatch, all_observation=True)
    title = '😀' * 100
    description = 'é' * 1000
    _, _, approved, command, receipt = publish(case, app, kind=kind, action='save',
        header={'title': '  ' + title + '  ', 'description': description})
    assert approved['proposed_header'] == {'title': title, 'description': description}
    assert command['description'] == description and receipt['action'] == 'save'
    assert publication_rows(case, receipt)[0]['description'] == description


@pytest.mark.parametrize('kind', ['saved', 'draft'])
def test_http_exact_retry_after_consumption_rotation_and_new_authorized_session(c2_case, kind, monkeypatch):
    case = c2_case.build(1, excluded=(0,))
    app = app_for(case)
    _, _, _, body, receipt = publish(case, app, kind=kind)
    original = deepcopy(body)
    successor = new_session(case.db, case.db.owner)
    new_app = app_for(case, current=successor, secret=OTHER_SECRET, key_version=2)
    with maintenance(case.db) as connection:
        connection.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s',
                           (case.db.owner.session_id,))
    assert current_context(new_app) != body['artwork_publication']['context_ref']
    trap_pixels(monkeypatch, all_observation=True)
    before = durable_snapshot(case)
    def forbidden(*args, **kwargs):
        raise AssertionError('Exact receipt retry must not discover owner mode or reconstruct staging')
    monkeypatch.setattr(routes, 'TopArtworkOwnerService', forbidden)
    monkeypatch.setattr(routes, 'TopArtworkPreparationService', forbidden)
    with observe(case) as trace:
        replay = http_execute(case, new_app, body)
    assert replay == receipt and body == original and durable_snapshot(case) == before
    assert trace['steps'] == []
    # Distinct direct C2 boundary: optional review-key loss is supported after
    # receipt lookup. This is deliberately not labeled globally keyless HTTP.
    command = normalize_top_command('enable_external', body, top_ref=case.top['top_ref'])
    assert case.db.service.execute(case.db.context(successor), command, cursor_secret=None) == receipt
    assert durable_snapshot(case) == before


@pytest.mark.parametrize('kind', ['saved', 'draft'])
def test_new_operation_with_obsolete_review_is_not_mistaken_for_exact_recovery(c2_case, kind):
    case = c2_case.build(1, excluded=(0,))
    app = app_for(case)
    _, _, _, body, _ = publish(case, app, kind=kind)
    new_app = app_for(case, secret=OTHER_SECRET, key_version=2)
    before = durable_snapshot(case)
    result = http_execute(case, new_app, {**body, 'request_key': str(uuid4())}, expected=409)
    assert result['ok'] is False and result['error'] in {'revision_conflict', 'artwork_preparation_unavailable'}
    assert durable_snapshot(case) == before


@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('field', ['title', 'description', 'items', 'evidence_revision'])
def test_same_operation_key_changed_payload_cannot_replay_old_receipt(c2_case, kind, field):
    case = c2_case.build(2, excluded=(0, 1))
    app = app_for(case)
    _, _, _, body, _ = publish(case, app, kind=kind)
    changed = deepcopy(body)
    if field in ('title', 'description'): changed[field] += ' changed'
    elif field == 'items': changed[field].reverse()
    else: changed[field] = '0' * 64
    before = durable_snapshot(case)
    result = http_execute(case, app, changed, expected=409)
    assert result == {'ok': False, 'error': 'request_key_conflict'}
    assert durable_snapshot(case) == before


def test_actual_new_local_row_keeps_null_until_commit_and_preserves_reviewed_order(c2_case, monkeypatch):
    case = c2_case.build(3, excluded=(0, 1, 2))
    case.top = case.db.service.execute(case.db.context(), case.db.command('remove', case.top,
        item_refs=[case.items[2]['item_ref']]))
    app = app_for(case)
    payload = draft_command(case, new=(2,), order=(2, 0))
    original_rows = deepcopy(payload['rows'])
    before = case.db.snapshot()
    trap_pixels(monkeypatch, all_observation=True)
    state, payload = http_ready(case, app, 'draft', payload=payload)
    approved, body = http_review(case, app, 'draft', state, payload)
    assert case.db.snapshot() == before
    assert body['items'][0]['item_ref'] is None and approved['items'][0]['saved_item_ref'] is None
    assert body['items'][1]['item_ref'] == case.items[0]['item_ref']
    assert payload['rows'] == original_rows
    receipt = http_execute(case, app, body)
    case.top = receipt
    header, items, rows, _, _, _, _ = publication_rows(case, receipt)
    assert [str(row['catalog_ref']) for row in items] == [case.items[2]['album_ref'], case.items[0]['album_ref']]
    assert str(items[0]['item_ref']) not in {case.items[2]['item_ref'], original_rows[0]['row_ref']}
    assert str(items[1]['item_ref']) == case.items[0]['item_ref']
    assert [row['curator_position'] for row in rows] == [1, 2]


@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('field', ['title', 'description', 'action'])
def test_changed_header_or_action_after_full_review_has_no_durable_effect(c2_case, kind, field):
    case = c2_case.build(1, excluded=(0,))
    app = app_for(case)
    state, payload = http_ready(case, app, kind)
    _, body = http_review(case, app, kind, state, payload)
    action = 'enable_external'
    if field == 'action':
        action = 'save'
        body['artwork_publication']['publication_intent']['action'] = action
    else: body[field] += ' altered after review'
    before = durable_snapshot(case)
    with observe(case) as trace:
        result = http_execute(case, app, body, action=action, expected=409)
    assert result == {'ok': False, 'error': 'invalid_or_stale_review'}
    assert trace['steps'] == [] and durable_snapshot(case) == before


@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('change', ['revision', 'revoked'])
def test_actual_link_binding_change_cannot_reuse_prior_review(c2_case, kind, change):
    case = c2_case.build(1, excluded=(0,))
    app = app_for(case)
    publish(case, app, kind=kind)
    state, payload = http_ready(case, app, kind)
    _, body = http_review(case, app, kind, state, payload, action='save')
    # Isolated mutable-link fixture change deliberately holds Top revision fixed;
    # a normal revoke would also exercise the earlier revision-conflict fence.
    with maintenance(case.db) as connection:
        if change == 'revision':
            connection.execute('update app.shared_links set link_revision=link_revision+1 where top_ref=%s',
                               (case.top['top_ref'],))
        else:
            connection.execute("""update app.shared_links set state='revoked',active_publication_ref=null,
                link_revision=link_revision+1,revoked_at=clock_timestamp() where top_ref=%s""", (case.top['top_ref'],))
    before = durable_snapshot(case)
    result = http_execute(case, app, body, action='save', expected=409)
    assert result == {'ok': False, 'error': 'invalid_or_stale_review'}
    assert durable_snapshot(case) == before


@POSIX_CAPTURE
@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('change', ['metadata', 'cover'])
def test_changed_offpage_full_source_is_rejected_for_preview_and_execute(c2_case, kind, change):
    case = c2_case.build(26, excluded=range(25))
    app = app_for(case)
    state, payload = http_ready(case, app, kind)
    approved, body = http_review(case, app, kind, state, payload)
    assert len(approved['items']) == 26 and approved['items'][25]['included']
    # The UI's first 25-row page excludes this changed source. Complete S must
    # still invalidate both preview and final mutation, without implicit drop.
    if change == 'metadata':
        with maintenance(case.db) as connection:
            connection.execute('update library.album_metadata_sources set year=2001 where ref=%s',
                               (case.source_refs[25],))
    else:
        case.cover_paths[25].write_bytes(b'changed-source-after-genuine-capture')
    before = durable_snapshot(case)
    status, raw, _ = image_response(case, app, kind, state, payload, approved, approved['items'][25])
    assert status == 409 and json.loads(raw)['ok'] is False
    result = http_execute(case, app, body, expected=409)
    assert result['ok'] is False and result['error'] in {'invalid_or_stale_review', 'artwork_source_changed'}
    assert durable_snapshot(case) == before


@pytest.mark.parametrize('kind', ['saved', 'draft'])
def test_all_excluded_still_needs_metadata_root_browse_at_review_and_commit(c2_case, kind, monkeypatch):
    case = c2_case.build(1, excluded=(0,))
    app = app_for(case)
    state, payload = http_ready(case, app, kind)
    _, body = http_review(case, app, kind, state, payload)
    trap_pixels(monkeypatch, all_observation=True)
    before = durable_snapshot(case)
    seen = []
    def deny_metadata(context):
        resource = context.resource
        target = (context.action, resource.resource_kind, resource.resource_ref) if resource else None
        seen.append(target)
        return PolicyEvaluationConstraints(request_origin_allowed=target != (BROWSE, 'library_root', str(case.metadata_root)))
    app.state.policy_constraint_resolver = deny_metadata
    denied_review = request_json(case, app, 'review', kind=kind, preparation_ref=state['preparation_ref'],
        payload={**identity(case, kind, payload), 'preparation_revision': state['preparation_revision'],
                 **HEADER, 'action': 'enable_external'}, expected=403)
    assert denied_review == {'ok': False, 'error': 'forbidden'} and durable_snapshot(case) == before
    result = http_execute(case, app, body, expected=403)
    assert result == {'ok': False, 'error': 'forbidden'} and durable_snapshot(case) == before
    assert (BROWSE, 'library_root', str(case.metadata_root)) in seen
    def deny_unused_artwork(context):
        resource = context.resource
        return PolicyEvaluationConstraints(request_origin_allowed=not (
            resource is not None and resource.resource_kind == 'library_root'
            and resource.resource_ref == str(case.artwork_root)))
    app.state.policy_constraint_resolver = deny_unused_artwork
    receipt = http_execute(case, app, body)
    assert publication_rows(case, receipt)[0]['contract_version'] == 2


@POSIX_CAPTURE
@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('scope', ['metadata_source', 'metadata_root', 'artwork_album', 'artwork_root'])
def test_current_exact_scope_denial_blocks_genuine_png_and_final_publication(c2_case, kind, scope):
    case = c2_case.build(2)
    app = app_for(case)
    state, payload = http_ready(case, app, kind)
    approved, body = http_review(case, app, kind, state, payload)
    expected = {'metadata_source': (BROWSE, 'album_metadata_source', case.source_refs[1]),
        'metadata_root': (BROWSE, 'library_root', str(case.metadata_root)),
        'artwork_album': ('library.artwork.read', 'album', str(case.album_ids[1])),
        'artwork_root': (BROWSE, 'library_root', str(case.artwork_root))}[scope]
    seen = []
    def constraints(context):
        resource = context.resource
        target = (context.action, resource.resource_kind, resource.resource_ref) if resource else None
        seen.append(target)
        return PolicyEvaluationConstraints(request_origin_allowed=target != expected)
    app.state.policy_constraint_resolver = constraints
    before = durable_snapshot(case)
    denied_review = request_json(case, app, 'review', kind=kind, preparation_ref=state['preparation_ref'],
        payload={**identity(case, kind, payload), 'preparation_revision': state['preparation_revision'],
                 **HEADER, 'action': 'enable_external'}, expected=403)
    assert denied_review == {'ok': False, 'error': 'forbidden'}
    status, raw, _ = image_response(case, app, kind, state, payload, approved, approved['items'][0])
    assert status == 403 and json.loads(raw) == {'ok': False, 'error': 'forbidden'}
    assert http_execute(case, app, body, expected=403) == {'ok': False, 'error': 'forbidden'}
    assert expected in seen and durable_snapshot(case) == before


@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('step', ['receipt', 'consume', 'finalizer'])
def test_http_named_post_write_failure_rolls_back_complete_transaction(c2_case, kind, step):
    case = c2_case.build(1, excluded=(0,))
    app = app_for(case)
    state, payload = http_ready(case, app, kind)
    _, body = http_review(case, app, kind, state, payload)
    before = durable_snapshot(case)
    raised = []
    def after(connection, sql, params, trace):
        if trace['steps'] and trace['steps'][-1] == step and not raised:
            raised.append(step)
            raise RuntimeError('Synthetic post-success rollback fault')
    with observe(case, after=after) as trace:
        result = http_execute(case, app, body, expected=503)
    assert result['ok'] is False and raised == [step] and step in trace['steps']
    assert durable_snapshot(case) == before


@pytest.mark.parametrize('deadline_kind', ['preparation', 'held_session'])
def test_actual_original_deadline_after_consume_cannot_escape_http_success(c2_case, deadline_kind, record_property):
    case = c2_case.build(1, excluded=(0,))
    app = app_for(case)
    state, payload = http_ready(case, app, 'saved')
    with maintenance(case.db) as connection:
        if deadline_kind == 'preparation':
            deadline = connection.execute("""with t as (select clock_timestamp()+interval '15 seconds' as expiry)
                update app.album_top_artwork_preparations set created_at=t.expiry-interval '60 minutes',
                    expires_at=t.expiry from t where ref=%s returning expires_at""",
                (state['preparation_ref'],)).fetchone()['expires_at']
        else:
            deadline = connection.execute("""update app.account_sessions
                set idle_expires_at=clock_timestamp()+interval '15 seconds' where id=%s returning idle_expires_at""",
                (case.db.owner.session_id,)).fetchone()['idle_expires_at']
    _, body = http_review(case, app, 'saved', state, payload)
    before = durable_snapshot(case)
    drained, waits = [], []
    def after(connection, sql, params, trace):
        if sql == 'set constraints app.artwork_publication_finalize immediate': drained.append(connection)
    def constraints(context):
        if drained and not waits:
            now = drained[0].execute('select clock_timestamp() as now').fetchone()['now']
            assert now < deadline, 'Fixture must reach the intended post-finalizer wait before expiry'
            delay = (deadline - now).total_seconds() + 0.05
            assert 0 < delay <= 15.05
            waits.append(delay)
            sleep(delay)
        return PolicyEvaluationConstraints()
    app.state.policy_constraint_resolver = constraints
    with observe(case, after=after):
        result = http_execute(case, app, body, expected=409 if deadline_kind == 'preparation' else 403)
    assert result == {'ok': False, 'error': 'artwork_preparation_unavailable' if deadline_kind == 'preparation' else 'forbidden'}
    assert len(drained) == len(waits) == 1 and durable_snapshot(case) == before
    record_property('e_http_real_' + deadline_kind + '_wait_seconds', waits[0])


def test_landed_response_loses_context_then_exact_current_retry_recovers_receipt(c2_case, monkeypatch):
    case = c2_case.build(1, excluded=(0,))
    app = app_for(case)
    state, payload = http_ready(case, app, 'saved')
    _, body = http_review(case, app, 'saved', state, payload)
    actual = case.db.service.execute
    landed = []
    def execute_then_rotate(*args, **options):
        receipt = actual(*args, **options)
        landed.append(receipt)
        app.state.auth_policy_config['hmac'] = {'secret': OTHER_SECRET, 'key_version': 2}
        return receipt
    monkeypatch.setattr(case.db.service, 'execute', execute_then_rotate)
    assert http_execute(case, app, body, expected=409) == {'ok': False, 'error': 'stale_context'}
    assert len(landed) == 1 and publication_rows(case, landed[0])[4] is not None
    monkeypatch.setattr(case.db.service, 'execute', actual)
    before = durable_snapshot(case)
    assert http_execute(case, app, body) == landed[0]
    assert durable_snapshot(case) == before


@POSIX_CAPTURE
@pytest.mark.parametrize('kind', ['saved', 'draft'])
def test_exact_start_and_batch_retry_preserve_generation_key_and_capture_once(c2_case, kind, monkeypatch):
    case = c2_case.build(2)
    app = app_for(case)
    observation = request_json(case, app, 'state')
    payload = ({'revision': case.top['revision'], 'request_key': str(uuid4()), 'items': deepcopy(case.items)}
               if kind == 'saved' else draft_command(case))
    payload['request_generation'] = observation['request_generation']
    first = request_json(case, app, 'start', kind=kind, payload=payload)
    before = durable_snapshot(case)
    assert request_json(case, app, 'start', kind=kind, payload=deepcopy(payload)) == first
    assert durable_snapshot(case) == before
    header = preparation_header(case, first['preparation_ref'])
    assert header['request_generation'] == payload['request_generation']
    assert int(header['expires_at'].timestamp()) == payload['request_generation'] + 3600
    actual_capture = preparation_module.capture_artwork
    captures = []
    def capture(*args, **options):
        result = actual_capture(*args, **options)
        captures.append(result.content_digest)
        return result
    monkeypatch.setattr(preparation_module, 'capture_artwork', capture)
    batch = {**identity(case, kind, payload), 'preparation_revision': first['preparation_revision'],
             'request_key': str(uuid4())}
    completed = request_json(case, app, 'advance', kind=kind, preparation_ref=first['preparation_ref'], payload=batch)
    assert completed['state'] == 'ready' and len(captures) == 2
    before_retry = durable_snapshot(case)
    assert request_json(case, app, 'advance', kind=kind,
        preparation_ref=first['preparation_ref'], payload=deepcopy(batch)) == completed
    assert len(captures) == 2 and durable_snapshot(case) == before_retry


@POSIX_CAPTURE
@pytest.mark.parametrize('kind', ['saved', 'draft'])
def test_real_failed_image_is_not_implicitly_excluded_or_published(c2_case, kind):
    case = c2_case.build(1)
    case.cover_paths[0].write_bytes(b'not-a-decodable-image')
    app = app_for(case)
    observation = request_json(case, app, 'state')
    payload = ({'revision': case.top['revision'], 'request_key': str(uuid4()), 'items': deepcopy(case.items)}
               if kind == 'saved' else draft_command(case))
    payload['request_generation'] = observation['request_generation']
    first = request_json(case, app, 'start', kind=kind, payload=payload)
    failed = request_json(case, app, 'advance', kind=kind, preparation_ref=first['preparation_ref'],
        payload={**identity(case, kind, payload), 'preparation_revision': first['preparation_revision'],
                 'request_key': str(uuid4())})
    assert failed['included_count'] == failed['failed_count'] == 1
    assert failed['ready_count'] == failed['byte_length'] == 0
    assert failed['items'][0]['included'] is True and failed['items'][0]['status'] == 'failed'
    before = durable_snapshot(case)
    result = request_json(case, app, 'review', kind=kind, preparation_ref=first['preparation_ref'],
        payload={**identity(case, kind, payload), 'preparation_revision': failed['preparation_revision'],
                 **HEADER, 'action': 'enable_external'}, expected=409)
    assert result == {'ok': False, 'error': 'artwork_preparation_unavailable'}
    assert durable_snapshot(case) == before and before['album_list_publications'] == []
    # Explicitly change the choice, obtain a new preparation/review, and only
    # then publish metadata-only v2. No source fallback or image substitution.
    case.items = [{**row, 'include_artwork': False} for row in case.items]
    _, _, approved, _, receipt = publish(case, app, kind=kind)
    assert approved['included_count'] == 0
    assert publication_rows(case, receipt)[2][0]['included'] is False
