"""Pure adapter and fixed collaborator contracts; no native success substitute."""
from copy import deepcopy
from dataclasses import replace
import hashlib
import json
import os
from types import SimpleNamespace
from uuid import UUID

import pytest

from music_app.services import _top_artwork_draft_proof as proof
from music_app.services import _top_artwork_resolution as resolution
from music_app.services import album_top_artwork_draft as draft
from music_app.services import album_top_publication_evidence as evidence
from music_app.services import artwork_proof_codec as codec
from music_app.services import public_top_artwork_acquisition as acquisition_owner
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.rooted_local_file import PosixRootStamp
from tests.py.test_artwork_proof_codec import (
    LEGACY_SOURCE, LEGACY_ACQUISITION, inventory, source, acquisition,
)

ROW = '00000000-0000-4000-8000-000000000001'
OP = '00000000-0000-4000-8000-000000000002'
CATALOG = '00000000-0000-4000-8000-000000000003'
SOURCE = '00000000-0000-4000-8000-000000000004'


def observed():
    stamp = PosixRootStamp('posix', 2049, 42)
    key = ('posix', 3, '/music')
    root = resolution.RootObservation(key, stamp, stamp)
    row = resolution.RowObservation(ROW, 2, 'album/cover.jpg', '/music/album/cover.jpg',
        ('album', 'cover.jpg'), 3, '/music', key, 'regular')
    request = resolution.ResolutionInput(OP, 'a' * 64, 'posix', resolution.CONTRACT,
        (resolution.RootInput(3, '/music'),),
        (resolution.RowInput(ROW, 2, 'album/cover.jpg'),))
    result = resolution.Success(OP, 'a' * 64, 'posix', resolution.CONTRACT,
        (row,), (root,), resolution.WorkCounts())
    return request, result, row, root


def assert_changed(call):
    with pytest.raises(AlbumTopError) as caught:
        call()
    assert caught.value.code == 'artwork_source_changed'
    assert caught.value.status_code == 409


def test_new_selection_preserves_actual_none_separate_from_row_identity():
    row = {'row_ref': ROW, 'saved_item_ref': None, 'catalog_ref': UUID(CATALOG),
           'selected_local_album_id': 2, 'selected_source_ref': UUID(SOURCE)}
    item = draft.source_item(row)
    assert item == {'item_ref': None, 'album_ref': CATALOG,
                   'selected_local_album_id': 2, 'selected_source_ref': SOURCE}
    row['saved_item_ref'] = UUID(OP)
    assert draft.source_item(row)['item_ref'] == OP


def test_ready_binding_recomputes_pair_and_exact_scope_without_io(monkeypatch):
    value = source(bound=True)
    prepared = codec.prepare_inventory_binding(inventory())
    def denied(*args, **kwargs):
        raise AssertionError('unexpected native access')
    monkeypatch.setattr(proof, 'artwork_source_from_observation', denied)
    expected, digest, acquired = proof.ready_binding(value, acquisition(value), prepared,
        library_id=1, local_album_id=2)
    assert expected == resolution.ExpectedSelection(3, '/music', '/music/album/cover.jpg',
        ('album', 'cover.jpg'), PosixRootStamp('posix', 2049, 42))
    assert digest == codec.descriptor_digest(value)
    assert acquired == hashlib.sha256(codec.canonical_acquisition_bytes(acquisition(value))).hexdigest()
    assert_changed(lambda: proof.ready_binding(value, acquisition(value), prepared,
        library_id=9, local_album_id=2))
    assert_changed(lambda: proof.ready_binding(value, acquisition(value), prepared,
        library_id=1, local_album_id=9))


def test_noncanonical_witness_is_not_a_canonical_pair():
    value = source(bound=True)
    acquired = acquisition(value)
    # A JSONB-equal witness can pass SQL's bounded witness model. The consumer
    # independently recomputes canonical bytes and rejects this claimed digest.
    acquired['descriptor_digest'] = hashlib.sha256(b'noncanonical witness').hexdigest()
    with pytest.raises(codec.InvalidArtworkProof):
        proof.ready_binding(value, acquired, codec.prepare_inventory_binding(inventory()),
            library_id=1, local_album_id=2)


def test_observation_identity_root_and_expected_comparison():
    request, result, row, root = observed()
    assert proof.checked_observations(result, request) == {ROW: (row, root)}
    expected = resolution.ExpectedSelection(3, '/music', row.resolved_cover_path,
        row.relative_parts, root.initial)
    request = replace(request, rows=(replace(request.rows[0], expected=expected),))
    assert proof.checked_observations(result, request)[ROW] == (row, root)
    assert_changed(lambda: proof.checked_observations(replace(result, snapshot_digest='b' * 64), request))
    assert_changed(lambda: proof.checked_observations(replace(result, operation_ref=ROW), request))
    assert_changed(lambda: proof.checked_observations(replace(result, roots=()), request))
    assert_changed(lambda: proof.checked_observations(replace(result, rows=(replace(row,
        relative_parts=('other.jpg',)),)), request))
    assert_changed(lambda: proof.checked_observations(replace(result, roots=(replace(root,
        final=PosixRootStamp('posix', 2049, 43)),)), request))


@pytest.mark.parametrize('field,value', [('row_ref', OP), ('local_album_id', 9),
    ('stored_cover_path', 'changed.jpg'), ('leaf_state', 'directory'),
    ('root_ledger_key', ('posix', 9, '/music'))])
def test_substituted_observation_never_escapes(field, value):
    request, result, row, _ = observed()
    assert_changed(lambda: proof.checked_observations(
        replace(result, rows=(replace(row, **{field: value}),)), request))


@pytest.mark.parametrize('code', ['artwork_source_invalid', 'artwork_unavailable',
    'artwork_source_changed', 'artwork_validation_limit', 'artwork_probe_busy',
    'artwork_probe_timeout', 'artwork_probe_unavailable', '/private/path'])
def test_failure_has_no_partial_observations_or_sensitive_message(code):
    request, _, _, _ = observed()
    result = resolution.Failure(OP, 'a' * 64, 'posix', resolution.CONTRACT,
        code, resolution.WorkCounts(), False)
    with pytest.raises(AlbumTopError) as caught:
        proof.checked_observations(result, request)
    assert caught.value.code == (code if code.startswith('artwork_') else 'artwork_probe_unavailable')
    assert '/private' not in str(caught.value)


@pytest.mark.skipif(os.name != 'posix', reason='legacy descriptor uses host POSIX Path grammar')
def test_observation_conversion_reuses_legacy_descriptor_without_probing(monkeypatch):
    _, _, row, root = observed()
    def denied(*args, **kwargs):
        raise AssertionError('unexpected native access')
    monkeypatch.setattr(acquisition_owner, 'describe_artwork_source', denied)
    monkeypatch.setattr(acquisition_owner, '_require_platform', denied)
    monkeypatch.setattr(acquisition_owner, '_DirectoryChain', denied)
    descriptor, value = proof.source_base(1, row, root, codec.prepare_inventory_binding(inventory()))
    assert type(descriptor) is acquisition_owner.ArtworkSourceDescriptor
    assert descriptor.root_device == 2049 and descriptor.root_inode == 42
    assert value == source(bound=True)
    captured = acquisition_owner.CapturedArtwork(descriptor,
        acquisition_owner.ArtworkFileObservation(2049, 43, 123, 1700000000000000000, -1),
        b'synthetic bytes used only by pure adapter', 'a' * 64, 10, 10, 123, 4096)
    actual_source, actual_acquisition, canonical = proof.captured_pair(captured, value)
    assert actual_source == value and actual_acquisition == acquisition(value)
    assert canonical.encode('ascii') == codec.canonical_source_bytes(value)
    assert_changed(lambda: proof.captured_pair(replace(captured,
        source=replace(descriptor, root_inode=99)), value))


def test_bounded_encoding_counts_utf8_before_join_and_enforces_completion_limit():
    assert draft.bounded_json(['é'], 6) == '["é"]'
    with pytest.raises(AlbumTopError) as caught:
        draft.bounded_json(['é'], 5)
    assert caught.value.code == 'artwork_validation_limit'
    assert len(draft.result_json('a' * (1024 * 1024 - 2))) == 1024 * 1024
    with pytest.raises(AlbumTopError):
        draft.result_json('a' * (1024 * 1024 - 1))


def test_latest_key_recovery_is_not_receipt_history():
    header = {'revision': 4, 'completed_request_key': UUID(OP), 'completed_from_revision': 3}
    draft.require_revision(header, 4)
    draft.require_revision(header, 3, OP)
    for revision, key in [(2, OP), (3, ROW), (3, None)]:
        with pytest.raises(AlbumTopError) as caught:
            draft.require_revision(header, revision, key)
        assert caught.value.code == 'artwork_preparation_unavailable'


def test_exact_page_rejects_invalid_shape_before_any_sql():
    connection = SimpleNamespace(execute=lambda *args: pytest.fail('unexpected SQL'))
    live = SimpleNamespace(library_id=1)
    valid = {'row_ref': ROW, 'item_ref': None, 'album_ref': CATALOG,
        'selected_local_album_id': 2, 'selected_source_ref': SOURCE,
        'selected_library_root_id': 3, 'include_artwork': False}
    for selections in ([], [valid] * 101, [dict(valid, include_artwork=1)],
                       [dict(valid, item_ref='None')], [dict(valid, extra=True)], [valid, valid]):
        with pytest.raises(AlbumTopError):
            evidence.artwork_selection_page(connection, live, selections, None)


@pytest.mark.skipif(os.name != 'posix', reason='legacy descriptor uses host POSIX Path grammar')
def test_full_observation_producer_subset_rejects_primitive_256_descendants():
    _, _, row, root = observed()
    root = replace(root, root_ledger_key=('posix', 3, '/'))
    for count, valid in [(255, True), (256, False)]:
        parts = ('x',) * count
        selected = replace(row, root_id=3, root_path='/', root_ledger_key=root.root_ledger_key,
            resolved_cover_path='/' + '/'.join(parts), relative_parts=parts)
        if valid:
            descriptor, value = proof.observation_source(1, selected, root, 'a' * 64)
            assert len(descriptor.relative_parts) == 255
            assert codec.parse_source(value)
        else:
            with pytest.raises(acquisition_owner.ArtworkAcquisitionUnavailable):
                proof.observation_source(1, selected, root, 'a' * 64)


# Fixed byte strings, independently hashed as raw domain + UTF-8 bytes. These
# are private operation hashes, not persisted/canonical legacy proof digests.
SAVED_SOURCE_BYTES = (
    b'{"artwork_root_id":3,"artwork_root_path":"/music","library_id":1,'
    b'"local_album_id":2,"relative_parts":["album","cover.jpg"],'
    b'"resolved_cover_path":"/music/album/cover.jpg","root_device":2049,'
    b'"root_inode":42,"stored_cover_path":"album/cover.jpg"}'
)
SAVED_ACQUISITION_BYTES = (
    b'{"file":{"ctime_ns":1700000000000000001,"device":2049,"inode":43,'
    b'"mtime_ns":1700000000000000000,"size":123},"input_bytes":123,"input_pixels":4096}'
)
SAVED_SOURCE_HASH = 'f92d4f88db15f9ceea6f71b2b864828a1b6d27b021af80c9e2b6895185e0147c'
SAVED_ACQUISITION_HASH = 'f652f1501c4afceb1c9208390b7f67767ab7a19e185f820a2228312066a0493a'


def saved_binding(value=None, acquired=None, **scope):
    return proof.saved_ready_binding(LEGACY_SOURCE if value is None else value,
        LEGACY_ACQUISITION if acquired is None else acquired,
        **dict({'library_id': 1, 'local_album_id': 2,
                'stored_cover_path': 'album/cover.jpg'}, **scope))


def test_saved_ready_hash_goldens_never_call_v2_or_native_apis(monkeypatch):
    value, acquired = deepcopy(LEGACY_SOURCE), deepcopy(LEGACY_ACQUISITION)
    before = deepcopy((value, acquired))
    def denied(*args, **kwargs):
        raise AssertionError('saved legacy proof entered v2/native API')
    for name in ('canonical_source_bytes', 'canonical_acquisition_bytes',
                 'descriptor_digest', 'bind_prepared_inventory', 'prepare_inventory_binding'):
        monkeypatch.setattr(codec, name, denied)
    monkeypatch.setattr(proof, 'artwork_source_from_observation', denied)
    monkeypatch.setattr(resolution, 'resolve', denied)
    expected, source_hash, acquisition_hash = saved_binding(value, acquired)
    assert expected == resolution.ExpectedSelection(3, '/music', '/music/album/cover.jpg',
        ('album', 'cover.jpg'), PosixRootStamp('posix', 2049, 42))
    assert proof._bounded_legacy_bytes(value, codec.SOURCE_LIMIT) == SAVED_SOURCE_BYTES
    assert proof._bounded_legacy_bytes(acquired, codec.ACQUISITION_LIMIT) == SAVED_ACQUISITION_BYTES
    assert source_hash == SAVED_SOURCE_HASH
    assert acquisition_hash == SAVED_ACQUISITION_HASH
    assert source_hash == hashlib.sha256(
        b'AlbumHaven/saved-artwork-source-observation/v1\x00' + SAVED_SOURCE_BYTES).hexdigest()
    assert acquisition_hash == hashlib.sha256(
        b'AlbumHaven/saved-artwork-acquisition-observation/v1\x00' + SAVED_ACQUISITION_BYTES).hexdigest()
    assert source_hash != hashlib.sha256(SAVED_SOURCE_BYTES).hexdigest()
    assert acquisition_hash != hashlib.sha256(SAVED_ACQUISITION_BYTES).hexdigest()
    assert (value, acquired) == before
    assert list(value) == list(LEGACY_SOURCE)
    assert list(acquired) == list(LEGACY_ACQUISITION)


def test_saved_legacy_transport_and_object_bytes_are_unchanged():
    raw_source = json.dumps(dict(reversed(list(LEGACY_SOURCE.items()))), indent=2).encode('utf-8')
    raw_acquisition = json.dumps(LEGACY_ACQUISITION, indent=4).encode('utf-8')
    original = raw_source, raw_acquisition
    assert saved_binding(raw_source, raw_acquisition) == saved_binding()
    assert (raw_source, raw_acquisition) == original
    assert codec.source_object(raw_source) == LEGACY_SOURCE
    assert codec.acquisition_object(raw_acquisition) == LEGACY_ACQUISITION
    for function, value in ((codec.canonical_source_bytes, raw_source),
                            (codec.descriptor_digest, raw_source),
                            (codec.canonical_acquisition_bytes, raw_acquisition)):
        with pytest.raises(codec.InvalidArtworkProof):
            function(value)


def test_saved_transient_hash_uses_exact_utf8_not_ascii_escaping():
    value = deepcopy(LEGACY_SOURCE)
    value.update(stored_cover_path='雪/🎵.jpg', resolved_cover_path='/music/雪/🎵.jpg',
                 relative_parts=['雪', '🎵.jpg'])
    expected, digest, acquired = saved_binding(value, stored_cover_path='雪/🎵.jpg')
    assert digest == 'a0d9a86b6ff0064acc05eac983a44326c4f8e7ea57a0e3c341fafe2a73821890'
    assert acquired == SAVED_ACQUISITION_HASH
    assert expected.relative_parts == ('雪', '🎵.jpg')
    encoded = proof._bounded_legacy_bytes(value, codec.SOURCE_LIMIT)
    assert '雪'.encode('utf-8') in encoded and b'\\u96ea' not in encoded
    assert proof._bounded_legacy_bytes(['é'], 6) == '["é"]'.encode('utf-8')
    with pytest.raises(AlbumTopError) as caught:
        proof._bounded_legacy_bytes(['é'], 5)
    assert caught.value.code == 'artwork_validation_limit'


def test_proof_adapters_reject_cross_kind_and_mixed_pairs():
    typed = source(bound=True)
    typed_acquisition = acquisition(typed)
    assert_changed(lambda: saved_binding(typed, typed_acquisition))
    with pytest.raises(codec.InvalidArtworkProof):
        proof.ready_binding(LEGACY_SOURCE, LEGACY_ACQUISITION,
            codec.prepare_inventory_binding(inventory()), library_id=1, local_album_id=2)
    for value, acquired in ((LEGACY_SOURCE, typed_acquisition), (typed, LEGACY_ACQUISITION)):
        with pytest.raises(codec.InvalidArtworkProof):
            saved_binding(value, acquired)


@pytest.mark.parametrize('changes', [
    {'library_id': 9}, {'local_album_id': 9}, {'library_id': True},
    {'stored_cover_path': None}, {'stored_cover_path': ''},
    {'stored_cover_path': 'different/cover.jpg'}, {'stored_cover_path': 'é' * 8193},
])
def test_saved_current_cover_and_exact_scope_reject_before_expectation(monkeypatch, changes):
    def denied(*args, **kwargs):
        raise AssertionError('ready expectation constructed before exact current binding')
    monkeypatch.setattr(resolution, 'ExpectedSelection', denied)
    assert_changed(lambda: saved_binding(**changes))


def test_saved_exact_current_cover_utf8_boundary_is_not_normalized():
    path = '/music/' + 'é' * 8188 + 'x'
    assert len(path.encode('utf-8')) == 16384
    value = deepcopy(LEGACY_SOURCE)
    value.update(stored_cover_path=path, resolved_cover_path=path,
                 relative_parts=[path[len('/music/'):]])
    assert saved_binding(value, stored_cover_path=path)[0].resolved_cover_path == path
    assert_changed(lambda: saved_binding(value, stored_cover_path=path + 'x'))


@pytest.mark.parametrize('path', ['album//cover.jpg', './album/cover.jpg',
    'album/../cover.jpg', '../album/cover.jpg', '/music//album/cover.jpg',
    'album/cover.jpg/', '//music/album/cover.jpg'])
def test_legacy_stored_spellings_outside_bounded_grammar_fail_closed(path, monkeypatch):
    value = dict(LEGACY_SOURCE, stored_cover_path=path)
    # Valid legacy storage is deliberately a broader contract than this resolver.
    assert codec.source_object(value) == value
    def denied(*args, **kwargs):
        raise AssertionError('unsupported legacy grammar reached an expectation')
    monkeypatch.setattr(resolution, 'ExpectedSelection', denied)
    assert_changed(lambda: saved_binding(value, stored_cover_path=path))
    assert value['stored_cover_path'] == path


@pytest.mark.parametrize('field', ['root_device', 'root_inode'])
def test_saved_root_identity_is_bounded_before_conversion(field, monkeypatch):
    for boundary in (0, (1 << 64) - 1):
        expected, _, _ = saved_binding(dict(LEGACY_SOURCE, **{field: boundary}))
        assert getattr(expected.root_stamp, 'device' if field == 'root_device' else 'inode') == boundary
    value = dict(LEGACY_SOURCE, **{field: 1 << 64})
    assert codec.source_object(value) == value
    def denied(*args, **kwargs):
        raise AssertionError('out-of-range root identity reached a primitive')
    monkeypatch.setattr(resolution, 'ExpectedSelection', denied)
    assert_changed(lambda: saved_binding(value))
    assert value[field] == 1 << 64


@pytest.mark.parametrize('which,changes', [
    ('source', {'extra': 'untrusted'}), ('source', {'library_id': True}),
    ('source', {'relative_parts': ('album', 'cover.jpg')}),
    ('acquisition', {'extra': 'untrusted'}), ('acquisition', {'input_bytes': 122}),
    ('acquisition', {'input_pixels': True}), ('acquisition', {'input_pixels': 16_000_001}),
])
def test_saved_pair_keeps_strict_legacy_schema_and_input_bounds(which, changes):
    value, acquired = deepcopy(LEGACY_SOURCE), deepcopy(LEGACY_ACQUISITION)
    (value if which == 'source' else acquired).update(changes)
    with pytest.raises(codec.InvalidArtworkProof):
        saved_binding(value, acquired)


def test_saved_acquisition_identity_stays_legacy_and_is_not_source_linkage():
    acquired = deepcopy(LEGACY_ACQUISITION)
    acquired['file'].update(device=1 << 80, inode=1 << 90, mtime_ns=-1, ctime_ns=1 << 90)
    expected, source_hash, acquisition_hash = saved_binding(acquired=acquired)
    assert expected.root_stamp == PosixRootStamp('posix', 2049, 42)
    assert source_hash == SAVED_SOURCE_HASH and acquisition_hash != SAVED_ACQUISITION_HASH
    assert acquired['file']['device'] == 1 << 80
    assert codec.acquisition_object(acquired) == acquired
    # The immutable row/asset and trusted completion owner supply association;
    # a made-up descriptor digest must not be introduced into the legacy pair.
    assert 'descriptor_digest' not in acquired


def test_saved_acquisition_transport_budget_rejects_before_retaining_hash():
    acquired = deepcopy(LEGACY_ACQUISITION)
    acquired['file']['inode'] = 1 << 7000
    assert codec.acquisition_object(acquired) == acquired
    with pytest.raises(AlbumTopError) as caught:
        saved_binding(acquired=acquired)
    assert caught.value.code == 'artwork_validation_limit'


def test_saved_ready_observation_allows_missing_leaf_but_not_new_selected_root():
    request, result, row, root = observed()
    expected, _, _ = saved_binding()
    request = replace(request, rows=(replace(request.rows[0], expected=expected),))
    missing = replace(row, leaf_state='missing_tail')
    assert proof.checked_observations(replace(result, rows=(missing,)), request)[ROW] == (missing, root)
    key = ('posix', 4, '/music/album')
    changed_root = replace(root, root_ledger_key=key)
    changed_row = replace(row, root_id=4, root_path='/music/album',
        relative_parts=('cover.jpg',), root_ledger_key=key)
    request = replace(request, roots=request.roots + (resolution.RootInput(4, '/music/album'),))
    assert_changed(lambda: proof.checked_observations(
        replace(result, rows=(changed_row,), roots=(changed_root,)), request))


@pytest.mark.skipif(os.name != 'posix', reason='legacy descriptor uses host POSIX Path grammar')
def test_saved_observation_and_capture_emit_exact_legacy_objects_without_v2(monkeypatch):
    _, _, row, root = observed()
    def denied(*args, **kwargs):
        raise AssertionError('legacy conversion attempted a v2/native operation')
    for name in ('canonical_source_bytes', 'canonical_acquisition_bytes',
                 'descriptor_digest', 'bind_prepared_inventory', 'prepare_inventory_binding'):
        monkeypatch.setattr(codec, name, denied)
    monkeypatch.setattr(acquisition_owner, 'describe_artwork_source', denied)
    monkeypatch.setattr(acquisition_owner, '_require_platform', denied)
    monkeypatch.setattr(acquisition_owner, '_DirectoryChain', denied)
    descriptor, base = proof.saved_source_base(1, row, root)
    assert type(descriptor) is acquisition_owner.ArtworkSourceDescriptor
    assert base == LEGACY_SOURCE
    captured = acquisition_owner.CapturedArtwork(descriptor,
        acquisition_owner.ArtworkFileObservation(2049, 43, 123, 1700000000000000000, -1),
        b'synthetic bytes used only by pure adapter', 'a' * 64, 10, 10, 123, 4096)
    source_stamp, acquisition_stamp = proof.saved_captured_pair(captured, base)
    expected_acquisition = deepcopy(LEGACY_ACQUISITION)
    expected_acquisition['file']['ctime_ns'] = -1
    assert source_stamp == base == LEGACY_SOURCE
    assert acquisition_stamp == expected_acquisition
    assert type(source_stamp['root_device']) is int
    assert type(acquisition_stamp['file']['mtime_ns']) is int
    assert_changed(lambda: proof.saved_captured_pair(captured, source(bound=True)))
    assert_changed(lambda: proof.saved_captured_pair(
        replace(captured, source=replace(descriptor, root_inode=99)), base))
    assert_changed(lambda: proof.saved_captured_pair(
        replace(captured, source=replace(descriptor, relative_parts=['album', 'cover.jpg'])), base))
    for field, value in (('input_bytes', 122), ('input_pixels', 16_000_001)):
        with pytest.raises(codec.InvalidArtworkProof):
            proof.saved_captured_pair(replace(captured, **{field: value}), base)


def test_saved_admission_facts_have_private_copying_constructor():
    with pytest.raises(AlbumTopError):
        draft._SavedAdmission()
    source = {'ref': SOURCE, 'cover_path': None}
    scope = {'selected_local_album_id': 2, 'selected_source_ref': SOURCE,
             'selected_library_root_id': 3}
    admitted = draft._saved_admission([(source, scope)])
    source['cover_path'] = '/untrusted/later-change'
    scope['selected_library_root_id'] = 99
    assert admitted.facts[0][0]['cover_path'] is None
    assert admitted.facts[0][1]['selected_library_root_id'] == 3
    with pytest.raises(TypeError):
        admitted.facts[0][0]['cover_path'] = 'changed'
    for malformed in ({}, [(source,)], [(source, scope, {})], [({}, None)], [({}, {})] * 5001):
        with pytest.raises(AlbumTopError):
            draft._saved_admission(malformed)
