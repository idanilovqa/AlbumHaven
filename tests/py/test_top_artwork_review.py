"""Pure dormant review contracts. Authored source; no native/DB success claim."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from types import SimpleNamespace
from uuid import UUID

import pytest

from music_app.services import album_top_artwork_review as review
from music_app.services import album_top_artwork_draft as draft
from music_app.services import album_top_publication_evidence as evidence
from music_app.services import social_cursors
from music_app.services.owned_album_tops import AlbumTopError

SECRET = 'private-review-test-secret-only-0123456789'
PNG = b'\x89PNG\r\n\x1a\n' + b'test bytes'
PNG_DIGEST = 'ca878be24e26a456fe84802654d1c1d42c0956df112e25a5aea01c2b70eca03c'
BASE_KEYS = {'contract_version', 'kind', 'top_ref', 'top_revision', 'preparation_ref',
    'preparation_revision', 'expires_at', 'review_digest', 'metadata_evidence_revision',
    'item_count', 'included_count', 'total_image_bytes', 'items', 'review_witness'}
ITEM_KEYS = {'row_ref', 'saved_item_ref', 'album_ref', 'position', 'title', 'artist',
    'year', 'track_count', 'included', 'artwork_ref', 'width', 'height'}


def uid(number):
    return '00000000-0000-4000-8000-' + format(number, '012x')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False).encode('utf-8')


def snapshot(*, kind='draft', included=True, count=1):
    header = {'ref': UUID(uid(2)), 'top_ref': UUID(uid(1)), 'library_id': 7,
        'owner_account_id': 8, 'original_session_id': 9, 'context_ref': 'c' * 64,
        'top_revision': 3, 'revision': 5, 'request_generation': 17,
        'expires_at': datetime(2026, 10, 17, 4, tzinfo=timezone.utc),
        'preparation_kind': kind, 'state': 'ready', 'item_count': count,
        'draft_ref': UUID(uid(3)) if kind == 'draft' else None,
        'draft_revision': 11 if kind == 'draft' else None,
        'baseline_digest': 'b' * 64 if kind == 'draft' else None,
        'lease_ref': None, 'lease_expires_at': None, 'batch_request_key': None,
        'batch_from_revision': None, 'batch_items': None}
    rows = []
    for index in range(count):
        row_ref = uid(11 + index * 100)
        rows.append({'row_ref': row_ref, 'saved_item_ref': row_ref if kind == 'saved' else None,
            'row_kind': 'existing' if kind == 'saved' else 'new_local',
            'catalog_ref': uid(21 + index * 100), 'position': index + 1,
            'selected_local_album_id': 100 + index, 'selected_source_ref': uid(41 + index * 100),
            'included': included, 'status': 'ready' if included else 'excluded', 'error_code': None,
            'asset_ref': UUID(uid(31 + index * 100)) if included else None,
            'content_digest': PNG_DIGEST if included else None,
            'width': 2 if included else None, 'height': 3 if included else None,
            'byte_length': len(PNG) if included else None,
            'proof_digest': 'a' * 64 if included else None,
            'acquisition_digest': 'f' * 64 if included else None})
    return {'header': header, 'rows': rows, 'kind': kind, 'digest': 'd' * 64,
            'metadata_generation': 23, 'included_count': count if included else 0}


def asset_record(row):
    return {'ref': row['asset_ref'], 'sanitizer_contract': 1, 'mime_type': 'image/png',
        'content_digest': row['content_digest'], 'width': row['width'], 'height': row['height'],
        'byte_length': row['byte_length'], 'stored_length': row['byte_length'], 'png': PNG}


class Result:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class Connection:
    """Records fixed SQL only; supplies no transaction/authority or IO method."""
    def __init__(self, value):
        self.value, self.calls, self.replace = value, [], None

    def execute(self, sql, params):
        self.calls.append((sql, params))
        if sql.startswith('select ref,sanitizer_contract,mime_type,'):
            wanted = set(params[0])
            found = {str(row['asset_ref']): asset_record(row) for row in self.value['rows']
                     if row['included'] and str(row['asset_ref']) in wanted}
            rows = list(found.values())
        else:
            assert sql.startswith('select a.ref,a.sanitizer_contract,a.mime_type,')
            rows = [asset_record(row) for row in self.value['rows']
                    if row['row_ref'] == params[1] and str(row['asset_ref']) == params[-1]]
        return Result(self.replace(rows) if self.replace else rows)


def fail(code, call, status=409):
    with pytest.raises(AlbumTopError) as caught:
        call()
    assert (caught.value.code, caught.value.status_code, str(caught.value)) == (code, status, code)


def unavailable(call):
    fail('artwork_preparation_unavailable', call)


def install_capture(monkeypatch, value, *, title='Title', artist='Artist'):
    calls = []
    def capture(connection, live, *, top, items, constraints):
        calls.append((connection, live, top, items, constraints))
        assert items == [draft.source_item(row) for row in value['rows']]
        return {'generation': value['metadata_generation'], 'evidence_revision': 'e' * 64,
            'items': [{'item': item, 'source': {'private_path': '/not-returned'},
                'metadata': {'album_ref': item['album_ref'], 'title': title, 'artist': artist,
                    'year': 2026, 'tracks': [{'title': 'private track detail'}]},
                'evidence_digest': 'a' * 64} for item in items]}
    monkeypatch.setattr(evidence, 'capture_artwork_review', capture)
    return calls


def captured(monkeypatch, value, **text):
    calls = install_capture(monkeypatch, value, **text)
    connection = Connection(value)
    live = SimpleNamespace(library_id=7, actor=SimpleNamespace(account_id=8, session_id=9))
    top = {'ref': UUID(uid(1)), 'revision': 3}
    state = review.capture_review(connection, live, top, value, kind=value['kind'], constraints=None)
    return state, connection, calls


def issued(monkeypatch, value, **text):
    state, connection, calls = captured(monkeypatch, value, **text)
    response = review.finish_review(value, state, kind=value['kind'], cursor_secret=SECRET)
    return response, state, connection, calls


@pytest.mark.parametrize('included,asset_digest,review_digest', [
    (True, '1088374f9eadeb6feb5bfd8662edead735c706a828e6680b95e240194fc28738',
           '24229b44cedc7272819ee50994649970dcc16dd9ec66fbd07fe724bcebc8d0bd'),
    (False, '4381c59503a079fbaef5c8d33031de7da5c7e2dad52fe887c3d3582c847dd908',
            'd323609e87fb2582d93d61ab0dc8f475a53e3494480de6866986330f75ff8643')])
def test_frozen_tuple_bytes_domains_and_actual_null(monkeypatch, included, asset_digest, review_digest):
    value = snapshot(included=included)
    row = [uid(11), None, uid(21), 1, included, *([uid(31), PNG_DIGEST, 2, 3, 18, 1,
           'image/png', 'a' * 64, 'f' * 64] if included else [None] * 9)]
    identity = ['7', '8', '9', 'c' * 64, uid(1), '3', uid(2), '5', '17',
                '2026-10-17T04:00:00+00:00', uid(3), '11', 'b' * 64]
    expected = [['private-top-artwork-asset-manifest-v1', 1, [row]],
                ['private-top-artwork-review-v1', 1, 'draft', *identity, 'd' * 64,
                 'e' * 64, asset_digest, [row]]]
    observed = []
    def digest(data):
        observed.append(deepcopy(data))
        return hashlib.sha256(canonical(data)).hexdigest()
    monkeypatch.setattr(evidence, 'digest', digest)
    assert review._compact(value, kind='draft', metadata_evidence_revision='e' * 64) == (
        asset_digest, review_digest, 18 if included else 0)
    assert observed == expected
    assert hashlib.sha256(canonical(expected[0])).hexdigest() == asset_digest
    assert hashlib.sha256(canonical(expected[1])).hexdigest() == review_digest
    assert b',null,' in canonical(expected[0]) and b'"None"' not in canonical(expected[0])


@pytest.mark.parametrize('kind', ['saved', 'draft'])
def test_complete_safe_summary_exact_allowlist_and_single_capture(monkeypatch, kind):
    value = snapshot(kind=kind, count=101)
    response, state, connection, calls = issued(monkeypatch, value)
    assert len(calls) == 1 and len(connection.calls) == 2
    assert set(response) == BASE_KEYS | ({'draft_ref', 'draft_revision'} if kind == 'draft' else set())
    assert len(response['items']) == 101
    assert [item['position'] for item in response['items']] == list(range(1, 102))
    assert all(set(item) == ITEM_KEYS for item in response['items'])
    if kind == 'draft':
        assert all(item['saved_item_ref'] is None for item in response['items'])
    else:
        assert all(item['saved_item_ref'] == item['row_ref'] for item in response['items'])
    encoded = canonical(response)
    for private in (b'/not-returned', b'private track detail', b'selected_source_ref', b'proof_digest',
                    b'content_digest', b'root_id', b'"tracks"', b'"source"'):
        assert private not in encoded
    assert 'token' not in state and 'cursor_secret' not in state and 'tracks' not in state
    assert response['total_image_bytes'] == 101 * len(PNG)
    assert response['review_witness']['review_digest'] == response['review_digest']


@pytest.mark.parametrize('count', [0, 1, 100, 101, 250, 5000])
def test_complete_header_pages_bounded_100_and_order(monkeypatch, count):
    value = snapshot(count=count)
    state, connection, calls = captured(monkeypatch, value)
    assert len(state['items']) == count and len(calls) == 1
    assert len(connection.calls) == (count + 99) // 100
    for sql, params in connection.calls:
        assert 1 <= len(params[0]) <= 100
        assert params[1:] == (value['header']['top_ref'], 7, 8)
        assert 'limit 101' in sql and 'png' not in sql


def test_dedup_assets_do_not_dedup_logical_bytes(monkeypatch):
    value = snapshot(count=101)
    for row in value['rows']:
        row['asset_ref'] = UUID(uid(31))
    state, connection, _ = captured(monkeypatch, value)
    assert state['total_image_bytes'] == 101 * len(PNG)
    assert [len(params[0]) for _, params in connection.calls] == [1, 1]
    value = snapshot(count=410)
    for row in value['rows']:
        row['asset_ref'], row['byte_length'] = UUID(uid(31)), review._MAX_PNG
    fail('artwork_validation_limit', lambda: review._compact(value, kind='draft', metadata_evidence_revision='e' * 64))
    value['rows'].pop()
    value['header']['item_count'] = value['included_count'] = 409
    assert review._compact(value, kind='draft', metadata_evidence_revision='e' * 64)[2] == 409 * review._MAX_PNG
    last = snapshot(count=410)['rows'][-1]
    last['asset_ref'] = UUID(uid(31))
    last['byte_length'] = review._MAX_IMAGES - 409 * review._MAX_PNG
    value['rows'].append(last)
    value['header']['item_count'] = value['included_count'] = 410
    assert review._compact(value, kind='draft', metadata_evidence_revision='e' * 64)[2] == review._MAX_IMAGES
    last['byte_length'] += 1
    fail('artwork_validation_limit', lambda: review._compact(value, kind='draft', metadata_evidence_revision='e' * 64))


@pytest.mark.parametrize('field,bad', [('state', 'preparing'), ('revision', 6), ('lease_ref', uid(88)),
    ('lease_expires_at', datetime(2026, 10, 17, tzinfo=timezone.utc)),
    ('batch_request_key', uid(90)), ('batch_from_revision', 5), ('batch_items', [])])
def test_complete_ready_revision_and_all_lease_fields(field, bad):
    value = snapshot()
    value['header'][field] = bad
    unavailable(lambda: review.require_ready(value, '5'))


@pytest.mark.parametrize('revision', [5, True, '05', '0', ' 5', '+5', '5' * 100000])
def test_ready_revision_scalar_bounds_precede_numeric_work(revision):
    unavailable(lambda: review.require_ready(snapshot(), revision))


@pytest.mark.parametrize('field,bad', [('status', 'pending'), ('status', 'failed'), ('error_code', 'artwork_limit'),
    ('included', 1), ('position', True), ('proof_digest', None), ('acquisition_digest', 'A' * 64)])
def test_complete_ready_vector_checks_offpage(field, bad):
    value = snapshot(count=101)
    value['rows'][-1][field] = bad
    unavailable(lambda: review.require_ready(value, '5'))


def test_excluded_nulls_and_no_asset_sql(monkeypatch):
    value = snapshot(included=False, count=101)
    response, _, connection, calls = issued(monkeypatch, value)
    assert len(calls) == 1 and connection.calls == []
    assert response['included_count'] == response['total_image_bytes'] == 0
    assert all(item['artwork_ref'] is item['width'] is item['height'] is None for item in response['items'])
    value['rows'][-1]['asset_ref'] = uid(31)
    unavailable(lambda: review.require_ready(value, '5'))


@pytest.mark.parametrize('value', [None, True, 0, -7, 9223372036854775807,
    '', 'x', '"\\\b\f\n\r\t\x00\x1f\x7f', 'é水😀\u2028\u2029',
    [], [True, None, '水'], {'z': ['😀', 123], 'a': {'quote': '"\\'}}])
def test_exact_canonical_json_size_with_escaping_multibyte_and_envelope(value):
    size = len(canonical(value))
    assert review._json_size(value, size) == size
    fail('artwork_validation_limit', lambda: review._json_size(value, size - 1))


@pytest.mark.parametrize('value', ['x' * 100000, 10**1000, '\ud800', [0] * 5001, object()])
def test_oversized_or_invalid_scalar_rejected_without_aggregate_encoder(monkeypatch, value):
    monkeypatch.setattr(evidence, 'canonical', lambda *a, **k: pytest.fail('must not encode first'))
    fail('artwork_validation_limit', lambda: review._json_size(value, 64))


def test_compact_exact_limit_before_aggregate_hash(monkeypatch):
    value = snapshot()
    observed = []
    original = evidence.digest
    def record(data):
        observed.append(len(canonical(data)))
        return original(data)
    monkeypatch.setattr(evidence, 'digest', record)
    expected = review._compact(value, kind='draft', metadata_evidence_revision='e' * 64)
    maximum = max(observed)
    monkeypatch.setattr(review, '_MAX_BINDING', maximum)
    assert review._compact(value, kind='draft', metadata_evidence_revision='e' * 64) == expected
    monkeypatch.setattr(review, '_MAX_BINDING', maximum - 1)
    observed.clear()
    fail('artwork_validation_limit', lambda: review._compact(value, kind='draft', metadata_evidence_revision='e' * 64))
    assert observed == []


def test_full_summary_exact_final_boundary_and_preappend_failure(monkeypatch):
    value = snapshot(count=2)
    response, state, _, _ = issued(monkeypatch, value, title='"\\é😀' * 250, artist='水' * 1000)
    exact = len(canonical(response))
    monkeypatch.setattr(review, '_MAX_SUMMARY', exact)
    assert len(canonical(review.finish_review(value, state, kind='draft', cursor_secret=SECRET))) == exact
    monkeypatch.setattr(review, '_MAX_SUMMARY', exact - 1)
    original = evidence.canonical
    def refuse_response(data):
        assert type(data) is not dict or 'review_witness' not in data, 'oversized response encoded'
        return original(data)
    monkeypatch.setattr(evidence, 'canonical', refuse_response)
    fail('artwork_validation_limit', lambda: review.finish_review(value, state, kind='draft', cursor_secret=SECRET))
    pending = {**review._response_header(value, state, 'draft'), 'items': [], 'review_witness': None}
    monkeypatch.setattr(review, '_MAX_SUMMARY', len(canonical(pending)) + len(canonical(state['items'][0])) - 1)
    fail('artwork_validation_limit', lambda: captured(monkeypatch, value, title='"\\é😀' * 250, artist='水' * 1000))


def test_full_witness_size_exact_before_cursor_decode(monkeypatch):
    witness = {'witness_version': 1, 'metadata_generation': '0', 'metadata_evidence_revision': 'a' * 64,
        'asset_manifest_digest': 'b' * 64, 'review_digest': 'c' * 64, 'token': 'x'}
    base = len(canonical(witness)) - 1
    # Backslashes are ASCII but require two canonical JSON bytes each.
    remainder = review._MAX_WITNESS - base
    token = '\\' * (remainder // 2) + ('x' if remainder % 2 else '')
    witness['token'] = token
    assert len(token) <= 4096 and len(canonical(witness)) == 5120
    assert review.normalize_witness(witness) == witness
    witness['token'] += 'x'
    fail('invalid_or_stale_review', lambda: review.normalize_witness(witness))


@pytest.mark.parametrize('change', [lambda w: None, lambda w: {}, lambda w: {**w, 'extra': 1},
    lambda w: {k: v for k, v in w.items() if k != 'token'}, lambda w: {**w, 'witness_version': True},
    lambda w: {**w, 'witness_version': 2}, lambda w: {**w, 'metadata_generation': 23},
    lambda w: {**w, 'metadata_generation': '023'}, lambda w: {**w, 'metadata_generation': '-1'},
    lambda w: {**w, 'metadata_generation': '9223372036854775808'},
    lambda w: {**w, 'metadata_generation': '1' * 100000}, lambda w: {**w, 'token': None},
    lambda w: {**w, 'token': ''}, lambda w: {**w, 'token': 'x' * 4097},
    lambda w: {**w, 'token': 'é'}, lambda w: {**w, 'review_digest': 'A' * 64}])
def test_unified_invalid_witness_shape_before_decode(monkeypatch, change):
    value = snapshot()
    response, _, _, _ = issued(monkeypatch, value)
    monkeypatch.setattr(review, 'decode_social_cursor', lambda *a, **k: pytest.fail('invalid shape decoded'))
    fail('invalid_or_stale_review', lambda: review.verify_witness(value,
        change(response['review_witness']), kind='draft', cursor_secret=SECRET))


def test_valid_witness_has_no_request_state_or_worker_affinity(monkeypatch):
    value = snapshot()
    response, state, connection, _ = issued(monkeypatch, value)
    witness = deepcopy(response['review_witness'])
    state.clear()
    connection.calls.clear()
    assert review.verify_witness(deepcopy(value), witness, kind='draft', cursor_secret=SECRET) is None
    assert connection.calls == []
    scope = ['private-top-artwork-reviewed-metadata-v1', 1, 'draft', '7', '8', '9', 'c' * 64,
        uid(1), '3', uid(2), '5', '17', '2026-10-17T04:00:00+00:00', uid(3), '11', 'b' * 64,
        'd' * 64, 'e' * 64, witness['asset_manifest_digest'], witness['review_digest']]
    assert social_cursors.decode_social_cursor(witness['token'], secret=SECRET, scope=scope) == 24
    fail('invalid_or_stale_review', lambda: review.verify_witness(value, witness,
        kind='draft', cursor_secret=SECRET + '-rotated'))


@pytest.mark.parametrize('field,value', [('library_id', 70), ('owner_account_id', 80),
    ('original_session_id', 90), ('context_ref', '0' * 64), ('top_ref', UUID(uid(1000))),
    ('top_revision', 4), ('ref', UUID(uid(1001))), ('revision', 6), ('request_generation', 18),
    ('expires_at', datetime(2026, 10, 17, 5, tzinfo=timezone.utc)),
    ('draft_ref', UUID(uid(1002))), ('draft_revision', 12), ('baseline_digest', '0' * 64)])
def test_witness_cannot_cross_any_fresh_scope(monkeypatch, field, value):
    current = snapshot()
    response, _, _, _ = issued(monkeypatch, current)
    current['header'][field] = value
    fail('invalid_or_stale_review', lambda: review.verify_witness(current, response['review_witness'],
        kind='draft', cursor_secret=SECRET))


@pytest.mark.parametrize('change', [lambda v: v.update(metadata_generation=24),
    lambda v: v.update(digest='0' * 64), lambda v: v['rows'][-1].update(content_digest='0' * 64),
    lambda v: v['rows'][-1].update(proof_digest='0' * 64),
    lambda v: v['rows'][-1].update(acquisition_digest='0' * 64),
    lambda v: v['rows'][-1].update(asset_ref=UUID(uid(9999))),
    lambda v: v['rows'][-1].update(width=4)])
def test_genuine_witness_stale_generation_or_complete_offpage_binding(monkeypatch, change):
    value = snapshot(count=101)
    response, state, _, _ = issued(monkeypatch, value)
    change(value)
    fail('invalid_or_stale_review', lambda: review.verify_witness(value, response['review_witness'],
        kind='draft', cursor_secret=SECRET))
    fail('invalid_or_stale_review', lambda: review.finish_review(value, state,
        kind='draft', cursor_secret=SECRET))


@pytest.mark.parametrize('field', ['metadata_generation', 'metadata_evidence_revision',
                                  'asset_manifest_digest', 'review_digest', 'token'])
def test_plain_field_substitution_and_cipher_corruption_same_failure(monkeypatch, field):
    value = snapshot()
    response, _, _, _ = issued(monkeypatch, value)
    witness = dict(response['review_witness'])
    witness[field] = ('24' if field == 'metadata_generation' else
        witness[field][:20] + ('A' if witness[field][20] != 'A' else 'B') + witness[field][21:]
        if field == 'token' else '0' * 64)
    fail('invalid_or_stale_review', lambda: review.verify_witness(value, witness,
        kind='draft', cursor_secret=SECRET))


def test_ordinary_cursor_and_cross_kind_are_not_review_witnesses(monkeypatch):
    value = snapshot()
    response, _, _, _ = issued(monkeypatch, value)
    witness = dict(response['review_witness'])
    witness['token'] = social_cursors.encode_social_cursor(24, secret=SECRET, scope=['ordinary-list'])
    fail('invalid_or_stale_review', lambda: review.verify_witness(value, witness, kind='draft', cursor_secret=SECRET))
    saved = snapshot(kind='saved')
    fail('invalid_or_stale_review', lambda: review.verify_witness(saved,
        response['review_witness'], kind='saved', cursor_secret=SECRET))


@pytest.mark.parametrize('secret', [None, '', 'short', b'x' * 32, '\ud800' * 32])
def test_missing_key_separate_sanitized_server_failure(monkeypatch, secret):
    value = snapshot()
    response, state, _, _ = issued(monkeypatch, value)
    monkeypatch.setattr(review, 'encode_social_cursor', lambda *a, **k: pytest.fail('invalid key encoded'))
    monkeypatch.setattr(review, 'decode_social_cursor', lambda *a, **k: pytest.fail('invalid key decoded'))
    fail('review_key_unavailable', lambda: review.require_key(secret), 503)
    fail('review_key_unavailable', lambda: review.finish_review(value, state, kind='draft', cursor_secret=secret), 503)
    fail('review_key_unavailable', lambda: review.verify_witness(value,
        response['review_witness'], kind='draft', cursor_secret=secret), 503)


def test_zero_and_maximum_generation_position(monkeypatch):
    for generation in (0, 9223372036854775807):
        value = snapshot()
        value['metadata_generation'] = generation
        response, _, _, _ = issued(monkeypatch, value)
        assert response['review_witness']['metadata_generation'] == str(generation)
        review.verify_witness(value, response['review_witness'], kind='draft', cursor_secret=SECRET)


@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('head_only', [False, True])
def test_exact_png_target_headers_and_zero_metadata_io(monkeypatch, kind, head_only):
    value = snapshot(kind=kind, count=101)
    response, _, connection, _ = issued(monkeypatch, value)
    def denied(*args, **kwargs):
        pytest.fail('PNG must not recapture metadata or perform filesystem/decoder IO')
    for name in ('capture', 'capture_artwork_review', 'selection_source', '_source_files'):
        monkeypatch.setattr(evidence, name, denied)
    import os
    from music_app.services import artwork_proof_codec as codec
    monkeypatch.setattr(os, 'open', denied)
    monkeypatch.setattr(codec, 'prepare_inventory_binding', denied)
    connection.calls.clear()
    review.verify_witness(value, response['review_witness'], kind=kind, cursor_secret=SECRET)
    row = value['rows'][-1]
    result = review.read_png(connection, value, kind=kind, row_ref=row['row_ref'],
        asset_ref=str(row['asset_ref']), head_only=head_only)
    assert result == {'content_type': 'image/png', 'content_length': len(PNG),
        'body': b'' if head_only else PNG, 'cache_control': 'private, no-store',
        'x_content_type_options': 'nosniff', 'referrer_policy': 'no-referrer'}
    assert len(connection.calls) == 1
    sql, params = connection.calls[0]
    assert params == (value['header']['ref'], row['row_ref'], value['header']['top_ref'], 7, 8, str(row['asset_ref']))
    assert "i.preparation_kind='" + kind + "'" in sql
    assert "i.included is true and i.status='ready' and i.asset_ref=%s" in sql
    assert 'a.library_id=i.library_id and a.owner_account_id=i.owner_account_id' in sql
    if head_only:
        assert ' as png' not in sql and 'then a.png' not in sql
    else:
        assert 'case when octet_length(a.png) between 1 and 327680 then a.png end as png' in sql


def test_head_never_accesses_fetched_bytea(monkeypatch):
    value = snapshot()
    connection = Connection(value)
    class NoBody(dict):
        def __getitem__(self, key):
            assert key != 'png', 'HEAD accessed bytea'
            return super().__getitem__(key)
    connection.replace = lambda rows: [NoBody({key: data for key, data in row.items() if key != 'png'}) for row in rows]
    result = review.read_png(connection, value, kind='draft', row_ref=uid(11), asset_ref=uid(31), head_only=True)
    assert result['body'] == b''


@pytest.mark.parametrize('head_only', [False, True])
@pytest.mark.parametrize('field,bad', [('ref', UUID(uid(777))), ('sanitizer_contract', True),
    ('sanitizer_contract', 2), ('mime_type', 'image/jpeg'), ('content_digest', '0' * 64),
    ('width', 3), ('height', True), ('byte_length', len(PNG) + 1),
    ('stored_length', 0), ('stored_length', review._MAX_PNG + 1)])
def test_corrupt_target_header_and_length_fail_closed(head_only, field, bad):
    value = snapshot()
    connection = Connection(value)
    connection.replace = lambda rows: [{**row, field: bad} for row in rows]
    unavailable(lambda: review.read_png(connection, value, kind='draft', row_ref=uid(11),
        asset_ref=uid(31), head_only=head_only))


@pytest.mark.parametrize('bad', [None, bytearray(PNG), b'X' * len(PNG), PNG[:-1],
    PNG[:-1] + b'X', PNG + b'x' * review._MAX_PNG])
def test_corrupt_get_body_returns_no_result(bad):
    value = snapshot()
    connection = Connection(value)
    connection.replace = lambda rows: [{**row, 'png': bad} for row in rows]
    unavailable(lambda: review.read_png(connection, value, kind='draft', row_ref=uid(11),
        asset_ref=uid(31), head_only=False))


@pytest.mark.parametrize('row_ref,asset_ref', [(uid(999), uid(31)), (uid(11), uid(999))])
def test_target_substitution_rejects_before_any_asset_sql(row_ref, asset_ref):
    value = snapshot()
    connection = Connection(value)
    unavailable(lambda: review.read_png(connection, value, kind='draft', row_ref=row_ref,
        asset_ref=asset_ref, head_only=False))
    assert connection.calls == []


def test_missing_target_and_header_cardinality_fail_closed(monkeypatch):
    value = snapshot()
    connection = Connection(value)
    connection.replace = lambda rows: []
    unavailable(lambda: review.read_png(connection, value, kind='draft', row_ref=uid(11),
        asset_ref=uid(31), head_only=True))
    install_capture(monkeypatch, value)
    unavailable(lambda: review.capture_review(connection, object(), object(), value, kind='draft', constraints=None))
    connection.replace = lambda rows: rows + rows
    unavailable(lambda: review.capture_review(connection, object(), object(), value, kind='draft', constraints=None))


def test_capture_rejects_different_generation_and_swapped_source_identity(monkeypatch):
    value = snapshot(count=2)
    install_capture(monkeypatch, value)
    collector = evidence.capture_artwork_review
    def changed_generation(*args, **kwargs):
        result = collector(*args, **kwargs)
        result['generation'] += 1
        return result
    monkeypatch.setattr(evidence, 'capture_artwork_review', changed_generation)
    connection = Connection(value)
    unavailable(lambda: review.capture_review(connection, object(), object(), value,
        kind='draft', constraints=None))
    assert connection.calls == []
    def swapped(*args, **kwargs):
        result = collector(*args, **kwargs)
        result['items'].reverse()
        return result
    monkeypatch.setattr(evidence, 'capture_artwork_review', swapped)
    unavailable(lambda: review.capture_review(connection, object(), object(), value,
        kind='draft', constraints=None))


def test_every_asset_header_is_validated_even_after_first_page(monkeypatch):
    value = snapshot(count=101)
    install_capture(monkeypatch, value)
    connection = Connection(value)
    def corrupt_last(rows):
        return [{**row, 'mime_type': 'image/jpeg'} if row['ref'] == value['rows'][-1]['asset_ref']
                else row for row in rows]
    connection.replace = corrupt_last
    unavailable(lambda: review.capture_review(connection, object(), object(), value,
        kind='draft', constraints=None))
    assert len(connection.calls) == 2


def test_token_4096_boundary_and_existing_utf8_key_semantics():
    witness = {'witness_version': 1, 'metadata_generation': '0',
        'metadata_evidence_revision': 'a' * 64, 'asset_manifest_digest': 'b' * 64,
        'review_digest': 'c' * 64, 'token': 'x' * 4096}
    assert review.normalize_witness(witness) == witness
    witness['token'] += 'x'
    fail('invalid_or_stale_review', lambda: review.normalize_witness(witness))
    assert review.require_key('é' * 16) == 'é' * 16
    fail('review_key_unavailable', lambda: review.require_key('é' * 15), 503)
