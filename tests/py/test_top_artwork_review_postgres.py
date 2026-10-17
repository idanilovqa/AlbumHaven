"""Reconstructed dormant B acceptance over the genuine PostgreSQL owners.

NEW RECONSTRUCTION, source-authored and UNRUN. This is not recovered historical
R2 bytes and requires fresh independent review. Reuses the verified recovered
capture/S fixture owners without changing any fixture, role, migration or route.
All successful images use actual <=4-row trusted writes and real POSIX capture.
Explicit hostile fetched-record cases modify observations of real SQL, never
manufacture successful pixels/proofs/authority or bypass immutable storage.

The 5000-ready cases must fit the original 60-minute preparation lifetime. The
200000-physical-file, 100000-logical-track and 250-thumbnail workloads are real
acceptance gates, not measured performance/RSS/latency claims. Original expiry
and session lifetimes are never renewed to make a slow setup pass. Detailed
OLD/NEW/cascade/truncate file-clock coverage belongs to the separate additive
invalidation predecessor test owner. B R2/R3 supersede paged review and repeated
thumbnail metadata capture; nothing here activates public/native routes.
"""
from contextlib import contextmanager
from copy import deepcopy
from datetime import timedelta
from hashlib import sha256
import json
import os
from time import monotonic, sleep
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
import pytest

from music_app.services import album_top_artwork_draft as shared
from music_app.services import album_top_artwork_preparation as preparation
from music_app.services import album_top_artwork_review as review
from music_app.services import album_top_publication_evidence as evidence
from music_app.services import _top_artwork_draft_proof as proof
from music_app.services import artwork_proof_codec as codec
from music_app.services import public_top_artwork_acquisition as acquisition
from music_app.services.album_top_artwork_preparation import TopArtworkPreparationService
from music_app.services.owned_album_tops import ACCESS
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.social_cursors import encode_social_cursor
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error
from tests.py import test_album_top_artwork_preparation_postgres as foundation
from tests.py.test_album_top_artwork_preparation_postgres import artwork, CONTEXT, png_file
from tests.py.test_top_artwork_draft_preparation_postgres import (
    draft_case, command as draft_command, start as start_draft, snapshot,
)
from tests.py.test_top_artwork_draft_capture_postgres import (
    actual_results, claim as draft_claim, complete as draft_complete,
    refreshed as draft_refreshed, advance_draft, read_draft,
)
from tests.py.test_top_artwork_saved_phases_postgres import (
    OwnerTrace, genuine_ready, header, set_cover,
)
from tests.py.test_top_artwork_retention_postgres import cleanup, retire
from tests.py.postgres_runtime_role_contract import assert_runtime_role

SECRET = 'synthetic-private-artwork-review-cursor-secret-only'
OTHER_SECRET = 'synthetic-coordinated-key-rotation-only'
COUNTS = (0, 1, 100, 101, 250, 5000)
KINDS = ('saved', 'draft')
requires_posix_artwork = pytest.mark.skipif(
    os.name != 'posix', reason='Requires genuine POSIX acquisition or typed POSIX inventory')
REVIEW_KEYS = {
    'contract_version', 'kind', 'top_ref', 'top_revision', 'preparation_ref',
    'preparation_revision', 'expires_at', 'review_digest', 'metadata_evidence_revision',
    'item_count', 'included_count', 'total_image_bytes', 'items', 'review_witness',
}
ITEM_KEYS = {
    'row_ref', 'saved_item_ref', 'album_ref', 'position', 'title', 'artist', 'year',
    'track_count', 'included', 'artwork_ref', 'width', 'height',
}
WITNESS_KEYS = {
    'witness_version', 'metadata_generation', 'metadata_evidence_revision',
    'asset_manifest_digest', 'review_digest', 'token',
}
PNG_KEYS = {'content_type', 'content_length', 'body', 'cache_control',
            'x_content_type_options', 'referrer_policy'}


def forbidden(*args, **kwargs):
    raise AssertionError('Forbidden image, metadata, native or mutation collaborator reached')


def runtime_role(case):
    with psycopg.connect(case.db.app_url, row_factory=dict_row) as connection:
        return assert_runtime_role(connection, case.db)


def identities(case, ready, kind, payload=None):
    values = dict(top_ref=case.top['top_ref'], top_revision=case.top['revision'],
        preparation_ref=ready['preparation_ref'], preparation_revision=ready['preparation_revision'],
        context_ref=CONTEXT, cursor_secret=SECRET)
    if kind == 'draft':
        values.update(draft_ref=payload['draft_ref'], draft_revision=payload['draft_revision'])
    return values


def invoke_review(case, ready, kind, payload=None, *, service=None, actor=None, **changes):
    values = identities(case, ready, kind, payload)
    values.update(changes)
    return getattr(service or case.service, 'review_' + kind)(case.db.context(actor), **values)


def invoke_png(case, ready, kind, approved, payload=None, *, service=None, actor=None,
               index=0, head_only=False, **changes):
    item = approved['items'][index]
    values = identities(case, ready, kind, payload)
    values.update(review_witness=approved['review_witness'], row_ref=item['row_ref'],
                  asset_ref=item['artwork_ref'], head_only=head_only)
    values.update(changes)
    return getattr(service or case.service, 'read_' + kind + '_png')(case.db.context(actor), **values)


def ready_case(case, kind, *, new=(), no_images=False):
    """Real bounded trusted writers only; no direct ready/proof/asset writes."""
    runtime_role(case)
    if kind == 'saved':
        if no_images:
            return case.advance(case.start()), None
        # The unchanged saved helper defaults to all rows, including excluded.
        # Pass the actual included batch count from this new caller instead.
        batches = (sum(item['include_artwork'] for item in case.items) + 3) // 4
        return genuine_ready(case, batches=batches), None
    payload = draft_command(case, new=new)
    started = start_draft(case, payload)
    if no_images:
        return advance_draft(case, started, payload), payload
    ready = started
    for _ in range((sum(row['include_artwork'] for row in payload['rows']) + 3) // 4):
        key, lease, refs = draft_claim(case, ready, payload)
        assert 1 <= len(refs) <= 4
        results, pngs = actual_results(case, payload, refs)
        draft_complete(case, ready, payload, key, lease, results, pngs)
        ready = draft_refreshed(case, ready)
    return read_draft(case, ready, payload), payload


def trap_image_capture(case, monkeypatch, *, no_probe=False):
    for name in ('capture', 'describe', 'resolver', '_capture_rows'):
        monkeypatch.setattr(case.service, name, forbidden)
    monkeypatch.setattr(acquisition, '_read_bounded', forbidden)
    monkeypatch.setattr(acquisition, 'sanitize_artwork_pixels', forbidden)
    if no_probe:
        monkeypatch.setattr(case.service, '_draft_probe', forbidden)
        monkeypatch.setattr(preparation, 'resolve_typed_artwork_observations', forbidden)
        monkeypatch.setattr(codec, 'prepare_inventory_binding', forbidden)
        monkeypatch.setattr(codec, 'validate_pair', forbidden)
        monkeypatch.setattr(proof, 'saved_ready_binding', forbidden)
        monkeypatch.setattr(proof, 'ready_binding', forbidden)


def trap_metadata_capture(monkeypatch):
    for name in ('capture', 'capture_artwork_review', 'selection_source', '_source_files'):
        monkeypatch.setattr(evidence, name, forbidden)
    monkeypatch.setattr(review, 'capture_review', forbidden)


def metadata_counter(monkeypatch):
    calls = {'capture': [], 'source': [], 'files': []}
    capture, selection, files = evidence.capture_artwork_review, evidence.selection_source, evidence._source_files

    def counted_capture(connection, context, **kwargs):
        calls['capture'].append(deepcopy(kwargs['items']))
        return capture(connection, context, **kwargs)

    def counted_selection(connection, context, item, constraints):
        calls['source'].append(dict(item))
        return selection(connection, context, item, constraints)

    def counted_files(connection, source):
        result = files(connection, source)
        calls['files'].append((str(source['ref']), len(result)))
        return result

    monkeypatch.setattr(evidence, 'capture_artwork_review', counted_capture)
    monkeypatch.setattr(evidence, 'selection_source', counted_selection)
    monkeypatch.setattr(evidence, '_source_files', counted_files)
    return calls


def exact_png_query(sql):
    return ('octet_length(a.png)' in sql and 'app.album_top_artwork_assets' in sql
        and ('app.album_top_artwork_preparation_items' in sql or 'app.album_top_artwork_draft_items' in sql))


def asset_header_query(sql):
    return ('app.album_top_artwork_assets' in sql and 'sanitizer_contract' in sql
            and 'octet_length(a.png)' not in sql)


def assert_no_mutation(statements):
    denied = ('app.start_top_artwork', 'app.claim_top_artwork', 'app.complete_top_artwork',
        'app.cleanup_top_artwork', 'app.consume_top_', 'app.cancel_top_',
        'library.seal_album_presentation', 'insert into ', 'update app.', 'delete from ')
    assert not any(part in sql for sql in statements for part in denied)


def assert_safe_review(case, result, kind, count):
    assert set(result) == REVIEW_KEYS | ({'draft_ref', 'draft_revision'} if kind == 'draft' else set())
    assert result['contract_version'] == 1 and result['kind'] == kind
    assert result['item_count'] == len(result['items']) == count
    assert result['top_ref'] == case.top['top_ref'] and result['top_revision'] == case.top['revision']
    assert [row['position'] for row in result['items']] == list(range(1, count + 1))
    assert all(set(row) == ITEM_KEYS for row in result['items'])
    witness = result['review_witness']
    assert set(witness) == WITNESS_KEYS
    assert witness['review_digest'] == result['review_digest']
    assert witness['metadata_evidence_revision'] == result['metadata_evidence_revision']
    assert len(evidence.canonical(witness)) <= 5120 and len(witness['token']) <= 4096
    assert len(evidence.canonical(result)) <= 36 * 1024 * 1024
    for field in ('review_digest', 'metadata_evidence_revision'):
        assert len(result[field]) == 64 and set(result[field]) <= set('0123456789abcdef')
    rendered = json.dumps(result)
    for private in (str(case.directory), 'selected_local_album_id', 'selected_source_ref',
        'selected_library_root_id', 'source_stamp', 'acquisition_stamp', 'root_path', 'cover_path',
        'private_path', 'source_facts', 'tracks', 'content_digest', 'inventory_digest', SECRET):
        assert private not in rendered
    for row in result['items']:
        assert row['track_count'] == 1
        if not row['included']:
            assert row['artwork_ref'] is row['width'] is row['height'] is None
        if kind == 'saved':
            assert row['row_ref'] == row['saved_item_ref']


def assert_png(result, *, head_only=False, expected=None):
    assert set(result) == PNG_KEYS
    assert result['content_type'] == 'image/png' and result['cache_control'] == 'private, no-store'
    assert result['x_content_type_options'] == 'nosniff' and result['referrer_policy'] == 'no-referrer'
    assert type(result['body']) is bytes and 1 <= result['content_length'] <= 327680
    if head_only:
        assert result['body'] == b''
    else:
        assert result['body'].startswith(b'\x89PNG\r\n\x1a\n')
        assert len(result['body']) == result['content_length']
        if expected is not None:
            assert result['body'] == expected


def assert_phase_pages(phase, count, kind, *, images):
    pages, sqls = (count + 99) // 100, [sql for sql, _ in phase]
    manifest = ('from app.album_top_artwork_preparation_items i' if kind == 'saved'
                else 'from app.album_top_artwork_draft_items i')
    assert sum(manifest in sql and 'selected_local_album_id' in sql and 'limit 101' in sql for sql in sqls) == pages
    assert sum(sql.startswith('with wanted as') for sql in sqls) == pages
    locked = [params[1] for sql, params in phase if sql.startswith('select id from library.local_albums')]
    assert len(locked) == pages
    assert all(0 < len(ids) <= 100 and ids == sorted(set(ids)) for ids in locked)
    flattened = [value for ids in locked for value in ids]
    assert flattened == sorted(set(flattened))
    prefix = ('select item_ref as row_ref,position,' if kind == 'saved'
              else 'select row_ref,position,source_stamp,acquisition_stamp')
    assert sum(sql.startswith(prefix) for sql in sqls) == (pages if images else 0)
    assert sum(sql.startswith('select id, case when octet_length(root_path)') for sql in sqls) == int(images)


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('count', COUNTS)
def test_complete_no_image_review_one_capture_one_transaction_on_every_host(
        draft_case, monkeypatch, kind, count, record_property):
    # Omit fixture pixels only where no successful image is requested.
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = draft_case.build(count, excluded=range(count))
    ready, payload = ready_case(case, kind, no_images=True)
    trap_image_capture(case, monkeypatch, no_probe=True)
    before, public = snapshot(case), case.publication_state()
    calls = metadata_counter(monkeypatch)
    trace = OwnerTrace(case, monkeypatch)
    result = invoke_review(case, ready, kind, payload)
    assert_safe_review(case, result, kind, count)
    assert result['included_count'] == result['total_image_bytes'] == 0
    assert len(calls['capture']) == 1 and len(calls['source']) == len(calls['files']) == count
    assert len(trace.phases) == 1
    assert_phase_pages(trace.phases[0], count, kind, images=False)
    assert not any(asset_header_query(sql) or exact_png_query(sql) for sql in trace.statements)
    assert len(trace.statements) <= 18 + 2 * count + 3 * ((count + 99) // 100) + int(kind == 'draft')
    assert_no_mutation(trace.statements)
    assert snapshot(case) == before and case.publication_state() == public
    record_property(kind + '_no_image_review_sql_count_' + str(count), len(trace.statements))
    if count:
        with monkeypatch.context() as blocked:
            trap_metadata_capture(blocked)
            assert_error(lambda: invoke_png(case, ready, kind, result, payload,
                asset_ref=str(uuid4())), 'artwork_preparation_unavailable', 409)


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('count', COUNTS[1:])
@requires_posix_artwork
def test_full_review_and_one_png_real_statement_bounds_capture_once_then_zero(
        draft_case, monkeypatch, kind, count, record_property):
    case = draft_case.build(count, same_pixels=True)
    ready, payload = ready_case(case, kind)
    before, public = snapshot(case), case.publication_state()
    trap_image_capture(case, monkeypatch)
    calls, observed, proof_pages = metadata_counter(monkeypatch), [], []

    def fetched(sql, params, rows, phase):
        if 'limit 101' in sql:
            assert len(rows) <= 101
        if 'source_stamp' in sql and 'limit 101' in sql:
            proof_pages.append(len(rows))
        if exact_png_query(sql):
            assert phase == 1 and len(rows) == 1

    trace = OwnerTrace(case, monkeypatch, fetched=fetched)
    actual_probe = case.service._draft_probe

    def probe(value):
        trace.outside('probe')
        assert value['observe_count'] == count
        result = actual_probe(value)
        assert len(result) == count
        observed.append(tuple(result))
        return result

    monkeypatch.setattr(case.service, '_draft_probe', probe)
    began = monotonic()
    approved = invoke_review(case, ready, kind, payload)
    assert_safe_review(case, approved, kind, count)
    assert len(calls['capture']) == 1 and len(calls['source']) == len(calls['files']) == count
    assert len(trace.phases) == 2 and len(observed) == 1
    pages = (count + 99) // 100
    for phase in trace.phases:
        assert_phase_pages(phase, count, kind, images=True)
    assert sum(asset_header_query(sql) for sql in trace.statements) == pages
    assert not any(asset_header_query(sql) for sql, _ in trace.phases[1])
    assert not any(exact_png_query(sql) for sql in trace.statements)
    assert len(trace.statements) <= 35 + 2 * count + 9 * pages + 2 * int(kind == 'draft')
    assert max(proof_pages) == min(count, 101)
    assert_no_mutation(trace.statements)
    record_property(kind + '_review_sql_count_' + str(count), len(trace.statements))
    record_property(kind + '_review_wall_seconds_' + str(count), monotonic() - began)
    assert approved['included_count'] == count and approved['total_image_bytes'] > 0
    assert len({row['artwork_ref'] for row in approved['items']}) == 1
    with case.db.connect() as connection:
        asset = connection.execute('select png,byte_length from app.album_top_artwork_assets where ref=%s',
            (approved['items'][0]['artwork_ref'],)).fetchone()
    assert approved['total_image_bytes'] == count * asset['byte_length']
    with monkeypatch.context() as blocked:
        trap_metadata_capture(blocked)
        for head_only in (False, True):
            trace.phases.clear()
            trace.events.clear()
            observed.clear()
            began = monotonic()
            result = invoke_png(case, ready, kind, approved, payload, index=count - 1, head_only=head_only)
            assert_png(result, head_only=head_only, expected=bytes(asset['png']))
            assert len(trace.phases) == 2 and len(observed) == 1
            for phase in trace.phases:
                assert_phase_pages(phase, count, kind, images=True)
            queries = [(sql, params) for phase in trace.phases for sql, params in phase if exact_png_query(sql)]
            assert len(queries) == 1
            sql, params = queries[0]
            assert all(key in sql for key in ('preparation_ref', 'owner_account_id', 'top_ref', 'included', "'ready'", 'preparation_kind'))
            assert ready['preparation_ref'] in tuple(str(value) for value in params)
            assert approved['items'][-1]['row_ref'] in tuple(str(value) for value in params)
            if head_only:
                assert 'then a.png' not in sql and 'as png' not in sql
            else:
                assert '327680' in sql and 'then a.png' in sql
            assert not any(asset_header_query(sql) for sql in trace.statements)
            assert len(trace.statements) <= 33 + 8 * pages + 2 * int(kind == 'draft')
            assert_no_mutation(trace.statements)
            label = kind + ('_head' if head_only else '_png')
            record_property(label + '_sql_count_' + str(count), len(trace.statements))
            record_property(label + '_wall_seconds_' + str(count), monotonic() - began)
    assert snapshot(case) == before and case.publication_state() == public


@pytest.mark.parametrize('kind', KINDS)
@requires_posix_artwork
def test_original_status_pagination_is_unchanged_around_full_review(draft_case, monkeypatch, kind):
    case = draft_case.build(101, excluded=(100,))
    ready, payload = ready_case(case, kind)
    read = (lambda **kwargs: case.read(ready, **kwargs)) if kind == 'saved' else (
        lambda **kwargs: read_draft(case, ready, payload, **kwargs))
    before = [read(after=0, limit=1), read(after=100, limit=100), read(after=5000, limit=1)]
    approved = invoke_review(case, ready, kind, payload)
    assert len(approved['items']) == 101 and approved['items'][-1]['included'] is False
    with monkeypatch.context() as blocked:
        trap_metadata_capture(blocked)
        assert [read(after=0, limit=1), read(after=100, limit=100), read(after=5000, limit=1)] == before
    assert len(before[0]['items']) == len(before[1]['items']) == 1 and before[2]['items'] == []


@requires_posix_artwork
def test_typed_new_rows_keep_actual_none_reordered_metadata_and_saved_identity(draft_case, monkeypatch):
    case = draft_case.build(3, excluded=(1,))
    case.top = case.db.service.execute(case.db.context(), case.db.command('remove', case.top,
        item_refs=[case.items[2]['item_ref']]))
    payload = draft_command(case, new=(2,), order=(2, 0, 1))
    # start_draft does not return ready_count. Advance before consulting it.
    ready = advance_draft(case, start_draft(case, payload), payload)
    while ready['ready_count'] < ready['included_count']:
        ready = advance_draft(case, ready, payload)
    retained, public = snapshot(case), case.publication_state()
    calls = metadata_counter(monkeypatch)
    approved = invoke_review(case, ready, 'draft', payload)
    assert [row['row_ref'] for row in approved['items']] == [row['row_ref'] for row in payload['rows']]
    assert [row['title'] for row in approved['items']] == ['Artwork album 2', 'Artwork album 0', 'Artwork album 1']
    assert approved['items'][0]['saved_item_ref'] is None
    assert calls['capture'][0][0]['item_ref'] is None and calls['source'][0]['item_ref'] is None
    assert approved['items'][1]['saved_item_ref'] == case.items[0]['item_ref']
    assert approved['items'][2]['artwork_ref'] is None
    assert snapshot(case) == retained and case.publication_state() == public


@pytest.mark.parametrize('kind', KINDS)
@requires_posix_artwork
def test_stateless_independent_workers_restart_and_coordinated_key_rotation(draft_case, monkeypatch, kind):
    case = draft_case.build(2)
    ready, payload = ready_case(case, kind)
    approved, before = invoke_review(case, ready, kind, payload), snapshot(case)
    for head_only in (False, True):
        worker = TopArtworkPreparationService(case.db.service)
        with monkeypatch.context() as blocked:
            trap_metadata_capture(blocked)
            for name in ('capture', 'describe', 'resolver'):
                blocked.setattr(worker, name, forbidden)
            assert_png(invoke_png(case, ready, kind, deepcopy(approved), payload,
                service=worker, head_only=head_only), head_only=head_only)
            assert_error(lambda: invoke_png(case, ready, kind, approved, payload,
                service=worker, cursor_secret=OTHER_SECRET), 'invalid_or_stale_review', 409)
    rotated = invoke_review(case, ready, kind, payload, cursor_secret=OTHER_SECRET)
    assert rotated['review_digest'] == approved['review_digest']
    assert rotated['review_witness']['token'] != approved['review_witness']['token']
    with monkeypatch.context() as blocked:
        trap_metadata_capture(blocked)
        assert_png(invoke_png(case, ready, kind, rotated, payload,
            service=TopArtworkPreparationService(case.db.service), cursor_secret=OTHER_SECRET))
    assert snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('operation', ['review', 'png'])
@pytest.mark.parametrize('key', [None, '', 'too-short', 1, b'not-a-server-string'])
@requires_posix_artwork
def test_missing_or_malformed_server_key_fails_without_automatic_capture(
        draft_case, monkeypatch, kind, operation, key):
    case = draft_case.build(1)
    ready, payload = ready_case(case, kind)
    approved = invoke_review(case, ready, kind, payload)
    trap_metadata_capture(monkeypatch)
    invoke = (lambda: invoke_review(case, ready, kind, payload, cursor_secret=key)) if operation == 'review' else (
        lambda: invoke_png(case, ready, kind, approved, payload, cursor_secret=key))
    assert_error(invoke, 'review_key_unavailable', 503)


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('fault', [
    'missing', 'empty', 'unknown_key', 'boolean_version', 'generation_leading_zero',
    'generation_changed', 'evidence_digest', 'asset_digest', 'review_digest',
    'missing_token', 'oversized_token', 'unicode_token', 'bit_flipped_token',
    'ordinary_cursor', 'forged_plain_observation',
])
@requires_posix_artwork
def test_witness_failures_have_one_sanitized_error_without_thumbnail_recapture(
        draft_case, monkeypatch, kind, fault):
    case = draft_case.build(1)
    ready, payload = ready_case(case, kind)
    approved = invoke_review(case, ready, kind, payload)
    witness = deepcopy(approved['review_witness'])
    if fault == 'missing': witness = None
    elif fault == 'empty': witness = {}
    elif fault == 'unknown_key': witness['private_path'] = '/synthetic/forbidden'
    elif fault == 'boolean_version': witness['witness_version'] = True
    elif fault == 'generation_leading_zero': witness['metadata_generation'] = '0' + witness['metadata_generation']
    elif fault == 'generation_changed': witness['metadata_generation'] = str(int(witness['metadata_generation']) + 1)
    elif fault == 'evidence_digest': witness['metadata_evidence_revision'] = '0' * 64
    elif fault == 'asset_digest': witness['asset_manifest_digest'] = '0' * 64
    elif fault == 'review_digest': witness['review_digest'] = '0' * 64
    elif fault == 'missing_token': witness.pop('token')
    elif fault == 'oversized_token': witness['token'] = 'a' * 4097
    elif fault == 'unicode_token': witness['token'] = '\u00e9'
    elif fault == 'bit_flipped_token':
        token = witness['token']
        witness['token'] = token[:25] + ('A' if token[25] != 'A' else 'B') + token[26:]
    elif fault == 'ordinary_cursor':
        witness['token'] = encode_social_cursor(1, secret=SECRET, scope=['ordinary-list-scope'])
    else:
        witness.update(metadata_generation='0', metadata_evidence_revision='a' * 64,
            asset_manifest_digest='b' * 64, review_digest='c' * 64, token='plaintext')
    trap_metadata_capture(monkeypatch)
    monkeypatch.setattr(case.service, '_draft_probe', forbidden)
    trace, before = OwnerTrace(case, monkeypatch), snapshot(case)
    assert_error(lambda: invoke_png(case, ready, kind, approved, payload,
        review_witness=witness), 'invalid_or_stale_review', 409)
    assert not any(exact_png_query(sql) for sql in trace.statements)
    assert snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('target', ['row', 'asset', 'other_row_asset', 'excluded_row', 'preparation', 'context', 'top_revision'])
@requires_posix_artwork
def test_exact_one_asset_identity_rejects_cross_row_ref_and_scope_substitution(
        draft_case, monkeypatch, kind, target):
    case = draft_case.build(3, excluded=(2,))
    ready, payload = ready_case(case, kind)
    approved = invoke_review(case, ready, kind, payload)
    changes, error = {}, ('artwork_preparation_unavailable', 409)
    if target == 'row': changes['row_ref'] = str(uuid4())
    elif target == 'asset': changes['asset_ref'] = str(uuid4())
    elif target == 'other_row_asset': changes['asset_ref'] = approved['items'][1]['artwork_ref']
    elif target == 'excluded_row': changes['row_ref'] = approved['items'][2]['row_ref']
    elif target == 'preparation': changes['preparation_ref'] = str(uuid4())
    elif target == 'context': changes['context_ref'] = 'b' * 64
    else:
        changes['top_revision'] = str(int(case.top['revision']) + 1)
        error = ('revision_conflict', 409)
    trap_metadata_capture(monkeypatch)
    before = snapshot(case)
    for head_only in (False, True):
        assert_error(lambda: invoke_png(case, ready, kind, approved, payload,
            head_only=head_only, **changes), *error)
    assert snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
@requires_posix_artwork
def test_cross_top_witness_and_asset_cannot_authorize_current_top(draft_case, monkeypatch, kind):
    case = draft_case.build(1)
    first, first_payload = ready_case(case, kind)
    first_review = invoke_review(case, first, kind, first_payload)
    first_top = dict(case.top)
    case.top, _ = case.db.create(refs=case.catalog_refs)
    member = case.db.read(case.top)['items'][0]
    case.items[0] = {**case.items[0], 'item_ref': member['ref']}
    case.payload = {**case.payload, 'revision': case.top['revision'],
        'request_key': str(uuid4()), 'items': case.items}
    second, second_payload = ready_case(case, kind)
    second_review = invoke_review(case, second, kind, second_payload)
    assert first_review['items'][0]['artwork_ref'] != second_review['items'][0]['artwork_ref']
    assert first_top['top_ref'] != case.top['top_ref']
    trap_metadata_capture(monkeypatch)
    assert_error(lambda: invoke_png(case, second, kind, second_review, second_payload,
        review_witness=first_review['review_witness']), 'invalid_or_stale_review', 409)
    assert_error(lambda: invoke_png(case, second, kind, second_review, second_payload,
        asset_ref=first_review['items'][0]['artwork_ref']), 'artwork_preparation_unavailable', 409)


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('scope', ['owner', 'session', 'kind', 'draft_ref', 'draft_revision'])
@requires_posix_artwork
def test_fresh_owner_session_and_preparation_kind_fences_precede_witness_authority(
        draft_case, monkeypatch, kind, scope):
    if kind == 'saved' and scope in ('draft_ref', 'draft_revision'):
        pytest.skip('Typed identity fields apply only to the typed owner')
    case = draft_case.build(1)
    ready, payload = ready_case(case, kind)
    approved = invoke_review(case, ready, kind, payload)
    trap_metadata_capture(monkeypatch)
    if scope == 'owner':
        # The existing owner hides a foreign private Top with its 404 boundary.
        assert_error(lambda: invoke_png(case, ready, kind, approved, payload,
            actor=foundation.member(case.db)), 'top_unavailable', 404)
    elif scope == 'session':
        actor = foundation.new_session(case.db, case.db.owner)
        assert_error(lambda: invoke_png(case, ready, kind, approved, payload,
            actor=actor), 'artwork_preparation_unavailable', 409)
    elif scope == 'kind':
        other = 'draft' if kind == 'saved' else 'saved'
        fake_payload = {'draft_ref': str(uuid4()), 'draft_revision': '1'}
        assert_error(lambda: invoke_png(case, ready, other, approved, fake_payload),
            'artwork_preparation_unavailable', 409)
    else:
        value = str(uuid4()) if scope == 'draft_ref' else str(int(payload['draft_revision']) + 1)
        assert_error(lambda: invoke_png(case, ready, kind, approved, payload,
            **{scope: value}), 'artwork_preparation_unavailable', 409)


def mutate_metadata(case, change, index=-1):
    """Real committed dependency edits; never mutate immutable preparation data."""
    source, album = case.source_refs[index], case.album_ids[index]
    with case.db.connect() as connection:
        if change == 'source_title':
            connection.execute("update library.album_metadata_sources set title=title||' changed' where ref=%s", (source,))
        elif change == 'source_artist':
            connection.execute("update library.album_metadata_sources set artist=artist||' changed' where ref=%s", (source,))
        elif change == 'source_year':
            connection.execute('update library.album_metadata_sources set year=2001 where ref=%s', (source,))
        elif change == 'source_origin':
            connection.execute("update library.album_metadata_sources set title_origin='filename_fallback' where ref=%s", (source,))
        elif change == 'source_state':
            connection.execute("update library.album_metadata_sources set state='invalid' where ref=%s", (source,))
        elif change == 'track_title':
            connection.execute("update library.local_tracks set title=title||' changed' where album_id=%s and library_id=%s", (album, case.db.library))
        elif change == 'track_duration':
            connection.execute('update library.local_tracks set duration_seconds=181 where album_id=%s and library_id=%s', (album, case.db.library))
        elif change == 'track_origin':
            connection.execute("update library.local_tracks set title_origin='filename_fallback' where album_id=%s and library_id=%s", (album, case.db.library))
        elif change == 'artist_name':
            connection.execute("update library.local_artists set name=name||' changed' where library_id=%s and id=(select artist_id from library.local_tracks where album_id=%s limit 1)", (case.db.library, album))
        elif change == 'local_album_title':
            connection.execute("update library.local_albums set title=title||' changed' where id=%s", (album,))
        elif change == 'file_stale':
            # scan_cache_stale is generated by 0021; mutate its real JSON input.
            connection.execute("""update library.local_track_files set metadata=metadata||
                jsonb_build_object('scan_cache',coalesce(metadata->'scan_cache','{}'::jsonb)||'{"stale":true}'::jsonb)
                where metadata_source_ref=%s""", (source,))
        elif change == 'file_association':
            connection.execute('update library.local_track_files set metadata_source_ref=%s where metadata_source_ref=%s', (case.source_refs[0], source))
        elif change == 'physical_container':
            connection.execute('update library.local_track_files set private_path=%s where metadata_source_ref=%s',
                (str(case.metadata_path / 'album-0' / 'unselected-sibling.flac'), source))
        elif change == 'file_insert':
            connection.execute('''insert into library.local_track_files
                (track_id,library_root_id,private_path,content_signature,metadata_source_ref,metadata)
                select track_id,library_root_id,%s,content_signature,metadata_source_ref,metadata
                from library.local_track_files where metadata_source_ref=%s limit 1''',
                (str(case.metadata_path / ('album-' + str(len(case.items) - 1)) / '02-copy.flac'), source))
        elif change == 'track_delete':
            connection.execute('delete from library.local_tracks where library_id=%s and album_id=%s', (case.db.library, album))
        elif change == 'catalog_link':
            connection.execute('delete from library.catalog_album_links where library_id=%s and local_album_id=%s', (case.db.library, album))
        elif change == 'metadata_root':
            connection.execute('update library.library_roots set is_active=false where id=%s', (case.metadata_root,))
        else:
            raise AssertionError('Unknown fixed dependency mutation')


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('change', [
    'source_title', 'source_artist', 'source_year', 'source_origin', 'source_state',
    'track_title', 'track_duration', 'track_origin', 'artist_name', 'local_album_title',
    'file_stale', 'file_association', 'physical_container', 'file_insert', 'track_delete',
    'catalog_link', 'metadata_root',
])
@requires_posix_artwork
def test_off_page_metadata_dependency_invalidates_witness_without_automatic_recapture(
        draft_case, monkeypatch, kind, change):
    case = draft_case.build(101, same_pixels=True)
    ready, payload = ready_case(case, kind)
    approved, before = invoke_review(case, ready, kind, payload), snapshot(case)
    mutate_metadata(case, change)
    fresh_error = change in ('source_origin', 'source_state', 'catalog_link', 'metadata_root')
    fresh_code = 'artwork_preparation_unavailable' if kind == 'draft' else 'evidence_unavailable'
    with monkeypatch.context() as blocked:
        trap_metadata_capture(blocked)
        blocked.setattr(case.service, '_draft_probe', forbidden)
        assert_error(lambda: invoke_png(case, ready, kind, approved, payload, index=0),
            fresh_code if fresh_error else 'invalid_or_stale_review', 409)
    invalid_capture = change in ('source_origin', 'source_state', 'track_origin', 'file_stale',
        'file_association', 'physical_container', 'track_delete', 'catalog_link', 'metadata_root')
    if invalid_capture:
        assert_error(lambda: invoke_review(case, ready, kind, payload),
            fresh_code if fresh_error else 'evidence_unavailable', 409)
    else:
        replacement = invoke_review(case, ready, kind, payload)
        assert replacement['review_digest'] != approved['review_digest']
        assert replacement['metadata_evidence_revision'] != approved['metadata_evidence_revision']
    assert snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
@requires_posix_artwork
def test_cover_change_without_metadata_clock_change_still_fails_full_fresh_s(draft_case, monkeypatch, kind):
    case = draft_case.build(101, same_pixels=True)
    ready, payload = ready_case(case, kind)
    approved = invoke_review(case, ready, kind, payload)
    replacement = png_file(case.artwork_path / 'changed-tail-cover.png', 81)
    set_cover(case, 100, str(replacement))
    with case.db.connect() as connection:
        current = connection.execute('select generation from library.public_metadata_source_state where library_id=%s',
            (case.db.library,)).fetchone()['generation']
    assert str(current) == approved['review_witness']['metadata_generation']
    trap_metadata_capture(monkeypatch)
    monkeypatch.setattr(case.service, '_draft_probe', forbidden)
    assert_error(lambda: invoke_png(case, ready, kind, approved, payload), 'artwork_source_changed', 409)


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('operation', ['review', 'png', 'head'])
@pytest.mark.parametrize('change', ['metadata', 'cover', 'inventory', 'owner', 'session', 'expiry', 'cleanup'])
@requires_posix_artwork
def test_each_outside_gap_rechecks_full_snapshot_authority_original_expiry_and_cleanup(
        draft_case, monkeypatch, kind, operation, change):
    case = draft_case.build(3)
    ready, payload = ready_case(case, kind)
    approved, before = invoke_review(case, ready, kind, payload), snapshot(case)
    actual_probe, changed = case.service._draft_probe, []
    trace = OwnerTrace(case, monkeypatch)
    extra_root = case.directory / 'new-observed-inventory-root'
    extra_root.mkdir()
    replacement = png_file(case.artwork_path / 'gap-tail-cover.png', 37)
    calls = metadata_counter(monkeypatch) if operation == 'review' else None
    if operation != 'review':
        trap_metadata_capture(monkeypatch)

    def probe(value):
        assert not trace.active
        result = actual_probe(value)
        assert len(result) == 3
        if change == 'metadata': mutate_metadata(case, 'source_title')
        elif change == 'cover': set_cover(case, 2, str(replacement))
        elif change == 'cleanup':
            retire(case, ready['preparation_ref'], expired=True)
            reclaimed = cleanup(case)
            assert reclaimed['items_deleted'] == 3 and reclaimed['preparations_deleted'] == 1
        else:
            with case.db.connect() as connection:
                if change == 'inventory': case.root(connection, extra_root)
                elif change == 'owner':
                    connection.execute('update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s',
                        (case.db.owner.account_id,))
                elif change == 'session':
                    connection.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s',
                        (case.db.owner.session_id,))
                else:
                    connection.execute("""with t as (select clock_timestamp()-interval '1 second' as expiry)
                        update app.album_top_artwork_preparations set created_at=t.expiry-interval '60 minutes',
                        expires_at=t.expiry from t where ref=%s""", (ready['preparation_ref'],))
        changed.append(True)
        return result

    monkeypatch.setattr(case.service, '_draft_probe', probe)
    invoke = (lambda: invoke_review(case, ready, kind, payload)) if operation == 'review' else (
        lambda: invoke_png(case, ready, kind, approved, payload, head_only=operation == 'head'))
    expected = ('forbidden', 403) if change in ('owner', 'session') else (
        ('artwork_preparation_unavailable', 409) if change in ('expiry', 'cleanup') else ('artwork_source_changed', 409))
    assert_error(invoke, *expected)
    assert changed == [True] and not any(exact_png_query(sql) for sql in trace.statements)
    if calls is not None:
        assert len(calls['capture']) == 1 and len(calls['files']) == 3
    if change not in ('expiry', 'cleanup'):
        assert snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('operation', ['review', 'png', 'head'])
@pytest.mark.parametrize('denial', ['source', 'artwork', 'root', 'owner', 'session'])
@requires_posix_artwork
def test_final_response_hash_serialization_precede_policy_and_held_session_exit(
        draft_case, monkeypatch, kind, operation, denial):
    case = draft_case.build(2)
    ready, payload = ready_case(case, kind)
    approved = invoke_review(case, ready, kind, payload)
    seen, actual_finish = [], review.finish_review

    def finish(*args, **kwargs):
        result = actual_finish(*args, **kwargs)
        seen.append('review')
        if denial == 'session':
            monkeypatch.setattr(case.db.service, '_clock', lambda: case.db.now + timedelta(hours=2))
        return result

    def executed(sql, params, phase):
        if exact_png_query(sql):
            seen.append('png')
            if denial == 'session':
                monkeypatch.setattr(case.db.service, '_clock', lambda: case.db.now + timedelta(hours=2))

    monkeypatch.setattr(review, 'finish_review', finish)
    trace = OwnerTrace(case, monkeypatch, executed=executed)
    if operation != 'review':
        trap_metadata_capture(monkeypatch)

    def constraints(context):
        resource = context.resource
        blocked = bool(seen) and (
            denial == 'owner' and context.action == ACCESS
            or denial == 'artwork' and context.action == 'library.artwork.read'
            or denial == 'source' and resource is not None and resource.resource_kind == 'album_metadata_source'
            or denial == 'root' and resource is not None and resource.resource_kind == 'library_root'
                and resource.resource_ref == str(case.artwork_root))
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)

    before = snapshot(case)
    invoke = (lambda: invoke_review(case, ready, kind, payload, constraints=constraints)) if operation == 'review' else (
        lambda: invoke_png(case, ready, kind, approved, payload, head_only=operation == 'head', constraints=constraints))
    assert_error(invoke, 'forbidden', 403)
    assert seen == ['review' if operation == 'review' else 'png']
    assert len(trace.phases) == 2 and ('committed', 1) not in trace.events
    assert snapshot(case) == before


@pytest.mark.parametrize('operation', ['review', 'png', 'head'])
@pytest.mark.parametrize('kind', KINDS)
@requires_posix_artwork
def test_actual_database_expiry_after_slow_final_callback_discards_witness_and_bytes(
        draft_case, monkeypatch, operation, kind, record_property):
    case = draft_case.build(1)
    ready, payload = ready_case(case, kind)
    with case.db.connect() as connection:
        deadline = connection.execute("""with t as (select clock_timestamp()+interval '5 seconds' as expiry)
            update app.album_top_artwork_preparations set created_at=t.expiry-interval '60 minutes',
                expires_at=t.expiry from t where ref=%s returning expires_at""",
            (ready['preparation_ref'],)).fetchone()['expires_at']
    approved = invoke_review(case, ready, kind, payload) if operation != 'review' else None
    seen, waited, actual_finish = [], [], review.finish_review

    def finish(*args, **kwargs):
        result = actual_finish(*args, **kwargs)
        seen.append(True)
        return result

    def executed(sql, params, phase):
        if exact_png_query(sql): seen.append(True)

    monkeypatch.setattr(review, 'finish_review', finish)
    trace = OwnerTrace(case, monkeypatch, executed=executed)
    if operation != 'review': trap_metadata_capture(monkeypatch)

    def slow_final(context):
        if seen and not waited:
            with case.db.connect() as connection:
                now = connection.execute('select clock_timestamp() as now').fetchone()['now']
            delay = max(0, (deadline - now).total_seconds()) + 0.05
            sleep(delay)
            waited.append(delay)
        return PolicyEvaluationConstraints()

    invoke = (lambda: invoke_review(case, ready, kind, payload, constraints=slow_final)) if operation == 'review' else (
        lambda: invoke_png(case, ready, kind, approved, payload,
            head_only=operation == 'head', constraints=slow_final))
    assert_error(invoke, 'artwork_preparation_unavailable', 409)
    assert seen == [True] and len(waited) == 1 and ('committed', 1) not in trace.events
    assert trace.statements[-1] == 'select clock_timestamp() as now'
    record_property(kind + '_' + operation + '_slow_final_policy_seconds', waited[0])


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('operation', ['review', 'png', 'head'])
@requires_posix_artwork
def test_failed_real_transaction_exit_never_returns_witness_or_body(draft_case, monkeypatch, kind, operation):
    case = draft_case.build(1)
    ready, payload = ready_case(case, kind)
    approved, before = invoke_review(case, ready, kind, payload), snapshot(case)
    connect, exits = case.db.service._connect, []

    @contextmanager
    def failure_at_exit(*args, **kwargs):
        phase = len(exits)
        exits.append(False)
        with connect(*args, **kwargs) as connection:
            yield connection
            if phase == 1: raise RuntimeError('Synthetic failure before real transaction commit')
        exits[phase] = True

    monkeypatch.setattr(case.db.service, '_connect', failure_at_exit)
    if operation != 'review': trap_metadata_capture(monkeypatch)
    returned = []
    with pytest.raises(RuntimeError, match='before real transaction commit'):
        returned.append(invoke_review(case, ready, kind, payload) if operation == 'review' else
            invoke_png(case, ready, kind, approved, payload, head_only=operation == 'head'))
    assert returned == [] and exits == [True, False] and snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('operation', ['review', 'png', 'head'])
@requires_posix_artwork
def test_full_off_page_proofs_rejected_before_response_and_never_recaptured(
        draft_case, monkeypatch, kind, operation):
    case = draft_case.build(101, same_pixels=True)
    ready, payload = ready_case(case, kind)
    approved, before, touched = invoke_review(case, ready, kind, payload), snapshot(case), []

    def fetched(sql, params, rows, phase):
        if 'source_stamp' in sql and 'limit 101' in sql:
            for row in rows:
                if row['position'] == 101:
                    row['source_stamp'] = {'invalid-proof-projection': True}
                    touched.append(True)

    trace = OwnerTrace(case, monkeypatch, fetched=fetched)
    monkeypatch.setattr(case.service, '_draft_probe', forbidden)
    trap_metadata_capture(monkeypatch)
    invoke = (lambda: invoke_review(case, ready, kind, payload)) if operation == 'review' else (
        lambda: invoke_png(case, ready, kind, approved, payload, head_only=operation == 'head'))
    assert_error(invoke, 'artwork_source_changed', 409)
    assert touched and not any(exact_png_query(sql) for sql in trace.statements)
    assert snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('fault', ['missing', 'extra', 'pending', 'failed', 'asset_ref', 'width'])
@requires_posix_artwork
def test_complete_manifest_cardinality_readiness_and_off_page_asset_binding(
        draft_case, monkeypatch, kind, fault):
    case = draft_case.build(101, same_pixels=True)
    ready, payload = ready_case(case, kind)
    approved, touched = invoke_review(case, ready, kind, payload), []

    def fetched(sql, params, rows, phase):
        if 'selected_local_album_id' not in sql or 'limit 101' not in sql: return
        if 'from app.album_top_artwork_' not in sql or not rows or rows[-1]['position'] != 101: return
        if fault == 'missing': rows.pop()
        elif fault == 'extra': rows.append(dict(rows[-1]))
        elif fault in ('pending', 'failed'): rows[-1]['status'] = fault
        elif fault == 'asset_ref': rows[-1]['asset_ref'] = str(uuid4())
        else: rows[-1]['width'] = 257
        touched.append(True)

    trace = OwnerTrace(case, monkeypatch, fetched=fetched)
    trap_metadata_capture(monkeypatch)
    monkeypatch.setattr(case.service, '_draft_probe', forbidden)
    # Dimensions alter the fresh S digest. Authentication precedes _compact's
    # dimension check; width=257 therefore has the unified witness error.
    error = 'items_changed' if fault in ('missing', 'extra') else (
        'artwork_preparation_unavailable' if fault in ('pending', 'failed') else 'invalid_or_stale_review')
    assert_error(lambda: invoke_png(case, ready, kind, approved, payload), error, 409)
    assert touched and not any(exact_png_query(sql) for sql in trace.statements)


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('head_only', [False, True])
@pytest.mark.parametrize('fault', ['contract', 'mime', 'length', 'width', 'digest', 'wrong_ref', 'missing'])
@requires_posix_artwork
def test_exact_final_asset_header_failure_discards_get_and_head(draft_case, monkeypatch, kind, head_only, fault):
    case = draft_case.build(1)
    ready, payload = ready_case(case, kind)
    approved, before, touched = invoke_review(case, ready, kind, payload), snapshot(case), []

    def fetched(sql, params, rows, phase):
        if not exact_png_query(sql): return
        assert len(rows) == 1 and phase == 1
        item = rows[0]
        if fault == 'contract': item['sanitizer_contract'] = 2
        elif fault == 'mime': item['mime_type'] = 'image/jpeg'
        elif fault == 'length': item['stored_length'] = 327681
        elif fault == 'width': item['width'] += 1
        elif fault == 'digest': item['content_digest'] = '0' * 64
        elif fault == 'wrong_ref': item['ref'] = str(uuid4())
        else: item['ref'] = None
        touched.append(True)

    trace = OwnerTrace(case, monkeypatch, fetched=fetched)
    trap_metadata_capture(monkeypatch)
    assert_error(lambda: invoke_png(case, ready, kind, approved, payload,
        head_only=head_only), 'artwork_preparation_unavailable', 409)
    assert touched == [True] and sum(exact_png_query(sql) for sql in trace.statements) == 1
    assert snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('fault', ['null', 'memoryview', 'bad_signature', 'wrong_hash', 'short', 'oversized'])
@requires_posix_artwork
def test_adversarial_fetched_body_is_rejected_after_real_bounded_select(draft_case, monkeypatch, kind, fault):
    case = draft_case.build(1)
    ready, payload = ready_case(case, kind)
    approved, touched = invoke_review(case, ready, kind, payload), []

    def fetched(sql, params, rows, phase):
        if not exact_png_query(sql): return
        assert 'between 1 and 327680 then a.png' in sql
        item, original = rows[0], rows[0]['png']
        assert type(original) is bytes and original.startswith(b'\x89PNG\r\n\x1a\n')
        if fault == 'null': item['png'] = None
        elif fault == 'memoryview': item['png'] = memoryview(original)
        elif fault == 'bad_signature': item['png'] = b'X' + original[1:]
        elif fault == 'wrong_hash': item['png'] = original[:-1] + bytes([original[-1] ^ 1])
        elif fault == 'short': item['png'] = original[:-1]
        else: item['png'] = b'\x89PNG\r\n\x1a\n' + b'X' * 327673
        touched.append(True)

    OwnerTrace(case, monkeypatch, fetched=fetched)
    trap_metadata_capture(monkeypatch)
    assert_error(lambda: invoke_png(case, ready, kind, approved, payload), 'artwork_preparation_unavailable', 409)
    assert touched == [True]


@pytest.mark.parametrize('kind', KINDS)
@requires_posix_artwork
def test_actual_runtime_role_cannot_mutate_immutable_asset_header_or_png(draft_case, kind):
    case = draft_case.build(1)
    ready, payload = ready_case(case, kind)
    approved, before = invoke_review(case, ready, kind, payload), snapshot(case)
    ref = approved['items'][0]['artwork_ref']
    with psycopg.connect(case.db.app_url, row_factory=dict_row) as connection:
        role = assert_runtime_role(connection, case.db)
        assert connection.execute("select has_table_privilege(%s,'app.album_top_artwork_assets','SELECT') as yes",
            (role,)).fetchone()['yes'] is True
        for privilege in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'):
            assert connection.execute("select has_table_privilege(%s,'app.album_top_artwork_assets',%s) as yes",
                (role, privilege)).fetchone()['yes'] is False
    for column in ('sanitizer_contract', 'mime_type', 'content_digest', 'width', 'height', 'byte_length', 'png'):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with psycopg.connect(case.db.app_url) as connection:
                connection.execute('update app.album_top_artwork_assets set ' + column + '=' + column + ' where ref=%s', (ref,))
    assert snapshot(case) == before


def seed_physical_count(case, index, count):
    """Real alternate-format rows for one actual logical track."""
    assert count >= 1
    with case.db.connect() as connection:
        connection.execute('''insert into library.local_track_files
            (track_id,library_root_id,private_path,content_signature,metadata_source_ref,metadata)
            select f.track_id,f.library_root_id,%s||'/copy-'||n::text||'.flac',
                f.content_signature,f.metadata_source_ref,f.metadata
            from (select * from library.local_track_files where metadata_source_ref=%s order by id limit 1) f
            cross join generate_series(2,%s) n''',
            (str(case.metadata_path / ('album-' + str(index))), case.source_refs[index], count))


def seed_track_count(case, index, count):
    """Real tag-origin tracks and associated physical rows, not fake captures."""
    assert count >= 1
    with case.db.connect() as connection:
        connection.execute('''with inserted as (
            insert into library.local_tracks
                (library_id,artist_id,album_id,track_key,title,disc_number,track_number,
                 duration_seconds,title_origin,artist_origin)
            select t.library_id,t.artist_id,t.album_id,%s||n::text,'Track '||n::text,1,n,
                180,'tag_metadata','tag_metadata'
            from (select * from library.local_tracks where library_id=%s and album_id=%s order by id limit 1) t
            cross join generate_series(2,%s) n returning id,track_number
        ) insert into library.local_track_files
            (track_id,library_root_id,private_path,content_signature,metadata_source_ref,metadata)
            select id,%s,%s||'/track-'||track_number::text||'.flac','synthetic',%s,'{}' from inserted''',
            ('review-tracks:' + case.db.token + ':' + str(index) + ':', case.db.library,
             case.album_ids[index], count, case.metadata_root,
             str(case.metadata_path / ('album-' + str(index))), case.source_refs[index]))


def selected_items(case):
    return [{key: item[key] for key in ('item_ref', 'album_ref', 'selected_local_album_id', 'selected_source_ref')}
            for item in case.items]


def direct_capture_pair(case):
    with case.service._authorized(case.db.context(), None) as (connection, live, _):
        top = case.service._top(connection, live, case.top['top_ref'], case.top['revision'], None)
        ordinary = evidence.capture(connection, live, top=top, items=selected_items(case))
        reviewed = evidence.capture_artwork_review(connection, live, top=top, items=selected_items(case))
    return ordinary, reviewed


@pytest.mark.parametrize('files', [1, 2, 9999, 10000])
def test_genuine_capture_semantic_digest_parity_with_duplicate_physical_formats(draft_case, monkeypatch, files):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = draft_case.build(2, excluded=(0, 1))
    seed_physical_count(case, 0, files)
    runtime_role(case)
    ordinary, reviewed = direct_capture_pair(case)
    assert ordinary == reviewed and len(reviewed['items']) == 2
    assert all(len(row['metadata']['tracks']) == 1 for row in reviewed['items'])
    assert all(row['item']['item_ref'] is not None for row in reviewed['items'])


@pytest.mark.parametrize('total', [199999, 200000, 200002])
def test_actual_review_only_total_physical_file_boundary_and_no_next_source_after_failure(
        draft_case, monkeypatch, total, record_property):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = draft_case.build(22, excluded=range(22))
    counts, remaining = [1] * 22, total - 22
    for index in range(len(counts)):
        added = min(9999, remaining)
        counts[index] += added
        remaining -= added
        seed_physical_count(case, index, counts[index])
    assert remaining == 0 and sum(counts) == total
    ready, _ = ready_case(case, 'saved', no_images=True)
    trap_image_capture(case, monkeypatch, no_probe=True)
    calls, began = metadata_counter(monkeypatch), monotonic()
    if total <= 200000:
        approved = invoke_review(case, ready, 'saved')
        assert approved['item_count'] == 22 and [row['track_count'] for row in approved['items']] == [1] * 22
        assert [size for _, size in calls['files']] == counts
    else:
        assert_error(lambda: invoke_review(case, ready, 'saved'), 'evidence_unavailable', 409)
        assert len(calls['files']) == len(calls['source']) == 21
        assert sum(size for _, size in calls['files']) == 200001
        assert case.source_refs[-1] not in [ref for ref, _ in calls['files']]
    assert len(calls['capture']) == 1
    reviewed_physical_rows = sum(size for _, size in calls['files'])
    # The 200000 physical-row admission cap is review-only. Ordinary v1's
    # established legal duplicate-format semantics remain unchanged.
    with case.service._authorized(case.db.context(), None) as (connection, live, _):
        top = case.service._top(connection, live, case.top['top_ref'], case.top['revision'], None)
        ordinary = evidence.capture(connection, live, top=top, items=selected_items(case))
    assert len(ordinary['items']) == 22
    assert all(len(row['metadata']['tracks']) == 1 for row in ordinary['items'])
    record_property('review_physical_rows_' + str(total), reviewed_physical_rows)
    record_property('review_physical_wall_seconds_' + str(total), monotonic() - began)


@pytest.mark.parametrize('fault', ['physical_overflow', 'logical_overflow'])
def test_real_per_album_file_sentinel_and_logical_track_cap_abort_before_next_source(draft_case, monkeypatch, fault):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = draft_case.build(2, excluded=(0, 1))
    if fault == 'physical_overflow': seed_physical_count(case, 0, 10001)
    else: seed_track_count(case, 0, 5001)
    ready, _ = ready_case(case, 'saved', no_images=True)
    calls, trace = metadata_counter(monkeypatch), OwnerTrace(case, monkeypatch)
    assert_error(lambda: invoke_review(case, ready, 'saved'), 'evidence_unavailable', 409)
    assert len(calls['capture']) == len(calls['source']) == len(calls['files']) == 1
    assert calls['files'][0][1] == (10001 if fault == 'physical_overflow' else 5001)
    queries = [(sql, params) for phase in trace.phases for sql, params in phase
               if sql.startswith('with candidate_ids as materialized')]
    assert len(queries) == 1
    assert queries[0][1][1] == queries[0][1][-1] == queries[0][1][-2] == 10001


@pytest.mark.parametrize('total', [100000, 100001])
def test_actual_total_logical_track_ceiling_and_full_safe_summary_counts(draft_case, monkeypatch, total, record_property):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    count = 20 if total == 100000 else 21
    case = draft_case.build(count, excluded=range(count))
    for index in range(20): seed_track_count(case, index, 5000)
    ready, _ = ready_case(case, 'saved', no_images=True)
    calls, began = metadata_counter(monkeypatch), monotonic()
    if total == 100000:
        result = invoke_review(case, ready, 'saved')
        assert result['item_count'] == 20 and [row['track_count'] for row in result['items']] == [5000] * 20
        assert all('tracks' not in row for row in result['items'])
    else:
        assert_error(lambda: invoke_review(case, ready, 'saved'), 'evidence_unavailable', 409)
    assert sum(size for _, size in calls['files']) == total and len(calls['capture']) == 1
    record_property('review_logical_track_wall_seconds_' + str(total), monotonic() - began)


@pytest.mark.parametrize('kind,state', [
    ('saved', 'pending'), ('saved', 'failed'), ('saved', 'lease'), ('saved', 'unadvanced_excluded'),
    # Only typed included snapshots prepare the POSIX inventory before B's
    # readiness check. Saved/no-image and typed excluded parameters are portable.
    pytest.param('draft', 'pending', marks=requires_posix_artwork),
    pytest.param('draft', 'failed', marks=requires_posix_artwork),
    pytest.param('draft', 'lease', marks=requires_posix_artwork),
    ('draft', 'unadvanced_excluded'),
])
def test_incomplete_preparation_never_implicitly_advances_or_admits(draft_case, monkeypatch, kind, state):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = draft_case.build(1, excluded=(0,) if state == 'unadvanced_excluded' else ())
    payload = draft_command(case) if kind == 'draft' else None
    status = start_draft(case, payload) if kind == 'draft' else case.start()
    if state in ('failed', 'lease'):
        if kind == 'saved':
            key, lease, refs = case.claim(status)
            if state == 'failed':
                case.complete(status, key, lease,
                    [{'item_ref': str(ref), 'status': 'failed', 'error_code': 'artwork_unavailable'} for ref in refs],
                    [None] * len(refs))
        else:
            key, lease, refs = draft_claim(case, status, payload)
            if state == 'failed':
                draft_complete(case, status, payload, key, lease,
                    [{'row_ref': str(ref), 'status': 'failed', 'error_code': 'artwork_unavailable'} for ref in refs],
                    [None] * len(refs))
        status = {**status, 'preparation_revision': str(header(case, status)['revision'])}
    if state == 'unadvanced_excluded' and header(case, status)['state'] == 'ready':
        # An explicitly ready historical saved start is eligible; do not claim
        # that every historical all-excluded SQL start is necessarily pending.
        assert invoke_review(case, status, kind, payload)['included_count'] == 0
        return
    before = snapshot(case)
    trap_metadata_capture(monkeypatch)
    trap_image_capture(case, monkeypatch)
    monkeypatch.setattr(case.service, '_draft_probe', forbidden)
    monkeypatch.setattr(preparation, 'resolve_typed_artwork_observations', forbidden)
    trace = OwnerTrace(case, monkeypatch)
    assert_error(lambda: invoke_review(case, status, kind, payload), 'artwork_preparation_unavailable', 409)
    assert_no_mutation(trace.statements)
    assert snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
def test_requested_preparation_revision_must_match_even_metadata_only(draft_case, monkeypatch, kind):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = draft_case.build(2, excluded=(0, 1))
    ready, payload = ready_case(case, kind, no_images=True)
    trap_metadata_capture(monkeypatch)
    assert_error(lambda: invoke_review(case, ready, kind, payload,
        preparation_revision=str(int(ready['preparation_revision']) + 1)), 'artwork_preparation_unavailable', 409)


@pytest.mark.parametrize('kind', KINDS)
@requires_posix_artwork
def test_final_query_never_bypasses_current_actual_root_browse_before_comparison(draft_case, monkeypatch, kind):
    case = draft_case.build(2)
    ready, payload = ready_case(case, kind)
    approved = invoke_review(case, ready, kind, payload)
    actual_probe, actual_compare = case.service._draft_probe, shared.compare
    denied, checked = [], []

    def probe(value):
        result = actual_probe(value)
        denied.append(True)
        return result

    def constraints(context):
        resource = context.resource
        blocked = bool(denied) and context.action == 'library.browse.read' and resource is not None \
            and resource.resource_kind == 'library_root' and resource.resource_ref == str(case.artwork_root)
        if blocked: checked.append(resource.resource_ref)
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)

    def compare(*args, **kwargs):
        if kind == 'saved':
            assert not denied, 'Saved actual-root Browse must precede digest comparison'
        return actual_compare(*args, **kwargs)

    monkeypatch.setattr(case.service, '_draft_probe', probe)
    monkeypatch.setattr(shared, 'compare', compare)
    trap_metadata_capture(monkeypatch)
    trace = OwnerTrace(case, monkeypatch)
    expected = ('forbidden', 403) if kind == 'saved' else ('artwork_source_changed', 409)
    assert_error(lambda: invoke_png(case, ready, kind, approved, payload, constraints=constraints), *expected)
    assert checked and not any(exact_png_query(sql) for sql in trace.statements)


@pytest.mark.parametrize('kind', KINDS)
@requires_posix_artwork
def test_real_top_and_selected_rows_are_locked_in_both_phases_but_not_during_probe(draft_case, monkeypatch, kind):
    case = draft_case.build(2)
    ready, payload = ready_case(case, kind)
    approved = invoke_review(case, ready, kind, payload)
    actual_probe, locks, gaps = case.service._draft_probe, set(), []

    def executed(sql, params, phase):
        if not sql.startswith('select clock_timestamp() as now') or phase in locks: return
        with pytest.raises(psycopg.errors.LockNotAvailable):
            with case.db.connect() as concurrent:
                concurrent.execute('select ref from app.album_lists where ref=%s for update nowait', (case.top['top_ref'],))
        with pytest.raises(psycopg.errors.LockNotAvailable):
            with case.db.connect() as concurrent:
                concurrent.execute('select id from library.local_albums where id=%s for update nowait', (case.album_ids[-1],))
        locks.add(phase)

    trace = OwnerTrace(case, monkeypatch, executed=executed)

    def probe(value):
        assert not trace.active
        observed = actual_probe(value)
        with case.db.connect() as concurrent:
            concurrent.execute('select ref from app.album_lists where ref=%s for update nowait', (case.top['top_ref'],))
            concurrent.execute('select id from library.local_albums where id=%s for update nowait', (case.album_ids[-1],))
        gaps.append(True)
        return observed

    monkeypatch.setattr(case.service, '_draft_probe', probe)
    trap_metadata_capture(monkeypatch)
    assert_png(invoke_png(case, ready, kind, approved, payload))
    assert locks == {0, 1} and gaps == [True]


@pytest.mark.parametrize('kind', KINDS)
def test_metadata_only_v1_preview_is_independent_of_artwork_review_and_platform(draft_case, monkeypatch, kind):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = draft_case.build(2, excluded=(0, 1))
    ready, payload = ready_case(case, kind, no_images=True)
    trap_image_capture(case, monkeypatch, no_probe=True)
    before = case.publication_state()
    original = case.db.service.publication_preview(case.db.context(), top_ref=case.top['top_ref'],
        payload={'revision': case.top['revision'], 'items': selected_items(case)})
    assert invoke_review(case, ready, kind, payload)['included_count'] == 0
    for name in ('capture_review', 'verify_witness', 'finish_review'):
        monkeypatch.setattr(review, name, forbidden)
    assert case.db.service.publication_preview(case.db.context(), top_ref=case.top['top_ref'],
        payload={'revision': case.top['revision'], 'items': selected_items(case)}) == original
    assert case.publication_state() == before


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('fault', ['contract', 'mime', 'wrong_ref', 'duplicate', 'missing', 'length'])
@requires_posix_artwork
def test_first_review_checks_every_scoped_immutable_asset_header_including_tail(draft_case, monkeypatch, kind, fault):
    case = draft_case.build(101)
    ready, payload = ready_case(case, kind)
    with case.db.connect() as connection:
        table = 'app.album_top_artwork_preparation_items' if kind == 'saved' else 'app.album_top_artwork_draft_items'
        tail_ref = str(connection.execute('select asset_ref from ' + table + ' where preparation_ref=%s and position=101',
            (ready['preparation_ref'],)).fetchone()['asset_ref'])
    calls, touched = metadata_counter(monkeypatch), []

    def fetched(sql, params, rows, phase):
        if not asset_header_query(sql) or tail_ref not in [str(row['ref']) for row in rows]: return
        assert phase == 0 and len(params[0]) <= 100
        assert 'top_ref=%s and library_id=%s and owner_account_id=%s' in sql
        item = next(row for row in rows if str(row['ref']) == tail_ref)
        if fault == 'contract': item['sanitizer_contract'] = 2
        elif fault == 'mime': item['mime_type'] = 'image/jpeg'
        elif fault == 'wrong_ref': item['ref'] = str(uuid4())
        elif fault == 'duplicate': rows.append(dict(item))
        elif fault == 'missing': rows.remove(item)
        else: item['byte_length'] = 327681
        touched.append(True)

    trace = OwnerTrace(case, monkeypatch, fetched=fetched)
    monkeypatch.setattr(case.service, '_draft_probe', forbidden)
    before = snapshot(case)
    assert_error(lambda: invoke_review(case, ready, kind, payload), 'artwork_preparation_unavailable', 409)
    assert touched == [True] and len(calls['capture']) == 1 and len(calls['files']) == 101
    assert len(trace.phases) == 1 and snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('operation', ['review', 'png'])
@pytest.mark.parametrize('field,value', [
    ('top_ref', 'FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF'),
    ('top_ref', '00000000-0000-0000-0000-000000000000'),
    ('top_revision', True), ('preparation_revision', False),
    ('context_ref', 'A' * 64), ('context_ref', 'a' * 63),
])
def test_actual_owner_identity_normalization_precedes_authority_connection(
        draft_case, monkeypatch, kind, operation, field, value):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = draft_case.build(1, excluded=(0,))
    ready, payload = ready_case(case, kind, no_images=True)
    approved = invoke_review(case, ready, kind, payload)
    monkeypatch.setattr(case.db.service, '_connect', forbidden)
    changes = {field: value}
    invoke = (lambda: invoke_review(case, ready, kind, payload, **changes)) if operation == 'review' else (
        lambda: invoke_png(case, ready, kind, approved, payload, asset_ref=str(uuid4()), **changes))
    assert_error(invoke, 'invalid_command', 422)


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('value', [None, 0, 1, 'true', 'false', [], {}])
def test_png_head_only_is_a_strict_boolean_at_actual_owner_boundary(draft_case, monkeypatch, kind, value):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = draft_case.build(1, excluded=(0,))
    ready, payload = ready_case(case, kind, no_images=True)
    approved = invoke_review(case, ready, kind, payload)
    monkeypatch.setattr(case.db.service, '_connect', forbidden)
    assert_error(lambda: invoke_png(case, ready, kind, approved, payload,
        asset_ref=str(uuid4()), head_only=value), 'invalid_command', 422)


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('extra', [{'after': 1}, {'limit': 1}, {'expected_review_digest': 'a' * 64},
    {'path': '/must-not-be-admitted'}, {'source': {}}, {'review_digest': 'a' * 64}])
def test_full_review_has_no_pagination_or_caller_source_extension_points(draft_case, monkeypatch, kind, extra):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = draft_case.build(0)
    ready, payload = ready_case(case, kind, no_images=True)
    monkeypatch.setattr(case.db.service, '_connect', forbidden)
    with pytest.raises(TypeError): invoke_review(case, ready, kind, payload, **extra)


@pytest.mark.parametrize('kind', KINDS)
@requires_posix_artwork
def test_retained_png_does_not_read_or_resanitize_replaced_and_deleted_leaf_files(draft_case, monkeypatch, kind):
    case = draft_case.build(2)
    ready, payload = ready_case(case, kind)
    approved = invoke_review(case, ready, kind, payload)
    original = [invoke_png(case, ready, kind, approved, payload, index=index)['body'] for index in (0, 1)]
    before = snapshot(case)
    png_file(case.cover_paths[0], 251)
    case.cover_paths[1].unlink()
    trap_image_capture(case, monkeypatch)
    trap_metadata_capture(monkeypatch)
    for index, body in enumerate(original):
        result = invoke_png(case, ready, kind, approved, payload, index=index)
        assert_png(result, expected=body)
        assert sha256(result['body']).digest() == sha256(body).digest()
    assert snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('change', ['unrelated_file_metadata', 'excluded_cover'])
@requires_posix_artwork
def test_irrelevant_non_dependency_edits_do_not_invent_metadata_generation_changes(draft_case, monkeypatch, kind, change):
    case = draft_case.build(2, excluded=(1,))
    ready, payload = ready_case(case, kind)
    approved = invoke_review(case, ready, kind, payload)
    if change == 'excluded_cover':
        set_cover(case, 1, 'different-excluded-cover-choice.png')
    else:
        with case.db.connect() as connection:
            connection.execute("""update library.local_track_files
                set metadata=metadata||'{"review_test_unrelated_note":"ordinary nondependency"}'::jsonb
                where metadata_source_ref=%s""", (case.source_refs[0],))
    with case.db.connect() as connection:
        generation = connection.execute('select generation from library.public_metadata_source_state where library_id=%s',
            (case.db.library,)).fetchone()['generation']
    assert str(generation) == approved['review_witness']['metadata_generation']
    trap_metadata_capture(monkeypatch)
    assert_png(invoke_png(case, ready, kind, approved, payload))


@pytest.mark.parametrize('kind', KINDS)
@requires_posix_artwork
def test_two_hundred_fifty_real_thumbnails_never_recapture_metadata_or_require_affinity(
        draft_case, monkeypatch, kind, record_property):
    case = draft_case.build(250, same_pixels=True)
    ready, payload = ready_case(case, kind)
    approved = invoke_review(case, ready, kind, payload)
    trap_metadata_capture(monkeypatch)
    trace = OwnerTrace(case, monkeypatch)
    workers = [TopArtworkPreparationService(case.db.service), TopArtworkPreparationService(case.db.service)]
    timings, counts, began = [], [], monotonic()
    for index in range(250):
        trace.phases.clear()
        trace.events.clear()
        start = monotonic()
        result = invoke_png(case, ready, kind, approved, payload, service=workers[index % 2], index=index)
        timings.append(monotonic() - start)
        assert_png(result)
        assert len(trace.phases) == 2 and sum(exact_png_query(sql) for sql in trace.statements) == 1
        assert len(trace.statements) <= (57 if kind == 'saved' else 59)
        counts.append(len(trace.statements))
    # Measurements inform later root acceptance; correctness cannot invent an
    # acceptable universal SLA or claim encoded bytes equal measured RSS.
    record_property(kind + '_250_thumbnail_total_seconds', monotonic() - began)
    record_property(kind + '_250_thumbnail_p95_seconds', sorted(timings)[237])
    record_property(kind + '_250_thumbnail_max_seconds', max(timings))
    record_property(kind + '_250_thumbnail_sql_total', sum(counts))


@pytest.mark.skipif(os.name != 'nt', reason='Native Windows unsupported-image boundary')
def test_windows_cannot_review_pending_images_by_manufacturing_posix_capture_success(artwork, monkeypatch):
    case = artwork.build(1)
    pending = case.start()
    before = case.snapshot()
    trap_image_capture(case, monkeypatch, no_probe=True)
    trap_metadata_capture(monkeypatch)
    assert_error(lambda: invoke_review(case, pending, 'saved'), 'artwork_preparation_unavailable', 409)
    assert case.snapshot() == before


@pytest.mark.parametrize('kind', KINDS)
def test_safe_summary_allowlist_preserves_approved_tag_text_without_track_or_source_fields(draft_case, monkeypatch, kind):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = draft_case.build(1, excluded=(0,))
    title = 'Title with a tag-supplied /path-looking string and "quotes" \u00e9'
    artist = 'Artist \\tag\\text "quotes" \u00e9'
    # Real public metadata rejects controls; successful fixture text contains
    # literal backslashes/quotes/multibyte text and no newline or tab.
    with case.db.connect() as connection:
        connection.execute('update library.album_metadata_sources set title=%s,artist=%s where ref=%s',
            (title, artist, case.source_refs[0]))
    ready, payload = ready_case(case, kind, no_images=True)
    approved = invoke_review(case, ready, kind, payload)
    assert set(approved['items'][0]) == ITEM_KEYS
    assert approved['items'][0]['title'] == title and approved['items'][0]['artist'] == artist
    assert 'tracks' not in approved['items'][0] and approved['items'][0]['artwork_ref'] is None


@pytest.mark.parametrize('kind', KINDS)
def test_capture_generation_must_equal_fresh_s_generation_without_retry(draft_case, monkeypatch, kind):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = draft_case.build(1, excluded=(0,))
    ready, payload = ready_case(case, kind, no_images=True)
    actual_capture, calls = evidence.capture_artwork_review, []

    def mismatched(connection, context, **kwargs):
        actual = actual_capture(connection, context, **kwargs)
        calls.append(True)
        return {**actual, 'generation': actual['generation'] + 1}

    monkeypatch.setattr(evidence, 'capture_artwork_review', mismatched)
    before = snapshot(case)
    assert_error(lambda: invoke_review(case, ready, kind, payload), 'artwork_preparation_unavailable', 409)
    assert calls == [True] and snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('change', ['root_identity', 'tail_symlink'])
@requires_posix_artwork
def test_native_root_or_off_target_symlink_change_cannot_use_unchanged_database_witness(draft_case, monkeypatch, kind, change):
    case = draft_case.build(3)
    ready, payload = ready_case(case, kind)
    approved = invoke_review(case, ready, kind, payload)
    if change == 'root_identity':
        case.artwork_path.rename(case.directory / 'original-artwork-root')
        case.artwork_path.mkdir()
    else:
        case.cover_paths[-1].unlink()
        case.cover_paths[-1].symlink_to(case.cover_paths[0])
    with case.db.connect() as connection:
        generation = connection.execute('select generation from library.public_metadata_source_state where library_id=%s',
            (case.db.library,)).fetchone()['generation']
    assert str(generation) == approved['review_witness']['metadata_generation']
    trap_metadata_capture(monkeypatch)
    trap_image_capture(case, monkeypatch)
    trace = OwnerTrace(case, monkeypatch)
    assert_error(lambda: invoke_png(case, ready, kind, approved, payload), 'artwork_source_changed', 409)
    assert len(trace.phases) == 1 and not any(exact_png_query(sql) for sql in trace.statements)
