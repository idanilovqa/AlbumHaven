"""Source-authored codec tests; no native/filesystem acceptance is implied."""

import builtins
from copy import deepcopy
from dataclasses import FrozenInstanceError
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

import pytest

from music_app.services import artwork_proof_codec as codec


POSIX = 'artwork-posix-bounded-selection-v1'
WINDOWS = 'artwork-win32-lexical-selection-v1'
LEGACY_SOURCE = {
    'library_id': 1, 'local_album_id': 2, 'artwork_root_id': 3,
    'artwork_root_path': '/music', 'stored_cover_path': 'album/cover.jpg',
    'resolved_cover_path': '/music/album/cover.jpg',
    'relative_parts': ['album', 'cover.jpg'], 'root_device': 2049, 'root_inode': 42,
}
LEGACY_ACQUISITION = {
    'file': {'device': 2049, 'inode': 43, 'size': 123,
             'mtime_ns': 1700000000000000000, 'ctime_ns': 1700000000000000001},
    'input_bytes': 123, 'input_pixels': 4096,
}
INVENTORY_BYTES = (
    b'{"inventory_version":1,"library_id":1,"platform":"posix",'
    b'"resolver_contract":"artwork-posix-bounded-selection-v1","roots":['
    b'{"browse_eligible":true,"root_id":3,"root_path":"/music"}]}'
)
INVENTORY_DIGEST = '37f1382fcaa6937a25252f6b7a3a05428845ca3a40a07d7d63922c933db94dbb'
SOURCE_BYTES = (
    b'{"artwork_root_id":3,"artwork_root_path":"/music","descriptor_version":2,'
    b'"library_id":1,"local_album_id":2,"platform":"posix",'
    b'"relative_parts":["album","cover.jpg"],"resolved_cover_path":"/music/album/cover.jpg",'
    b'"root":{"device":"2049","inode":"42"},"selection_context":{'
    b'"inventory_digest":"0000000000000000000000000000000000000000000000000000000000000000",'
    b'"resolver_contract":"artwork-posix-bounded-selection-v1","version":1},'
    b'"stored_cover_path":"album/cover.jpg"}'
)
SOURCE_DIGEST = 'e492569aec61ddbbbab6d498c95eda8869ddf773b9c7958094374d4c83c7bd41'
WINDOWS_SOURCE_BYTES = (
    br'{"artwork_root_id":3,"artwork_root_path":"C:\\music","descriptor_version":2,'
    br'"library_id":1,"local_album_id":2,"platform":"win32",'
    br'"relative_parts":["album","cover.jpg"],"resolved_cover_path":"C:\\music\\album\\cover.jpg",'
    br'"root":{"file_id":"0123456789abcdef0123456789abcdef","selector":{"drive":"C:",'
    br'"drive_target":"\\Device\\HarddiskVolume12","guid_target":"\\Device\\HarddiskVolume12",'
    br'"volume_guid":"\\\\?\\Volume{01234567-89AB-cdef-0123-456789abcdef}\\"},'
    br'"volume_serial":"18446744073709551615"},"selection_context":{'
    br'"inventory_digest":"0000000000000000000000000000000000000000000000000000000000000000",'
    br'"resolver_contract":"artwork-win32-lexical-selection-v1","version":1},'
    br'"stored_cover_path":"album/cover.jpg"}'
)
WINDOWS_SOURCE_DIGEST = '43a4bb2c2eaf07e177e125e4cf1bd5aa2b72a6a525ad676dcfd9771a01b8d126'
POSIX_ACQUISITION_BYTES = (
    b'{"acquisition_version":2,"descriptor_digest":'
    b'"e492569aec61ddbbbab6d498c95eda8869ddf773b9c7958094374d4c83c7bd41",'
    b'"file":{"ctime_ns":"-1","device":"2049","inode":"43",'
    b'"mtime_ns":"1700000000000000000","size":123},'
    b'"input_bytes":123,"input_pixels":4096,"platform":"posix"}'
)
WINDOWS_ACQUISITION_BYTES = (
    b'{"acquisition_version":2,"descriptor_digest":'
    b'"43a4bb2c2eaf07e177e125e4cf1bd5aa2b72a6a525ad676dcfd9771a01b8d126",'
    b'"file":{"change_time":"9223372036854775807","last_write_time":"-9223372036854775808",'
    b'"leaf_identity":{"file_id":"ffffffffffffffffffffffffffffffff",'
    b'"volume_serial":"18446744073709551615"},'
    b'"root_identity":{"file_id":"0123456789abcdef0123456789abcdef",'
    b'"volume_serial":"18446744073709551615"},"size":123},'
    b'"input_bytes":123,"input_pixels":4096,"platform":"win32"}'
)
# Plain SHA256 of acquisition canonical bytes, not a new persisted digest domain.
POSIX_ACQUISITION_SHA256 = '5621ef2bde0c3ec314befdfbd527374980a57bef2cc1b236eb226caee2bc4d03'
WINDOWS_ACQUISITION_SHA256 = 'dab7c21e785dff87cf368f40e7935847c638ebafce42b3b75996a889f6f2d3d7'


def inventory(platform='posix'):
    return {
        'inventory_version': 1, 'library_id': 1, 'platform': platform,
        'resolver_contract': POSIX if platform == 'posix' else WINDOWS,
        'roots': [{'root_id': 3, 'root_path': '/music' if platform == 'posix' else 'C:\\music',
                   'browse_eligible': True}],
    }


def source(platform='posix', *, bound=False):
    value = deepcopy(LEGACY_SOURCE)
    del value['root_device'], value['root_inode']
    value.update(descriptor_version=2, platform=platform, root={'device': '2049', 'inode': '42'},
                 selection_context={'version': 1, 'resolver_contract': POSIX,
                                    'inventory_digest': '0' * 64})
    if platform == 'win32':
        value.update(artwork_root_path='C:\\music', resolved_cover_path='C:\\music\\album\\cover.jpg')
        value['root'] = {
            'volume_serial': '18446744073709551615', 'file_id': '0123456789abcdef' * 2,
            'selector': {'drive': 'C:',
                         'volume_guid': '\\\\?\\Volume{01234567-89AB-cdef-0123-456789abcdef}\\',
                         'drive_target': '\\Device\\HarddiskVolume12',
                         'guid_target': '\\Device\\HarddiskVolume12'},
        }
        value['selection_context']['resolver_contract'] = WINDOWS
    if bound:
        value['selection_context']['inventory_digest'] = codec.inventory_digest(inventory(platform))
    return value


def acquisition(descriptor):
    if descriptor['platform'] == 'posix':
        info = {'device': '2049', 'inode': '43', 'size': 123,
                'mtime_ns': '1700000000000000000', 'ctime_ns': '-1'}
    else:
        root = {key: descriptor['root'][key] for key in ('volume_serial', 'file_id')}
        info = {'root_identity': root, 'leaf_identity': dict(root, file_id='f' * 32),
                'size': 123, 'last_write_time': '-9223372036854775808',
                'change_time': '9223372036854775807'}
    return {'acquisition_version': 2, 'platform': descriptor['platform'],
            'descriptor_digest': codec.descriptor_digest(descriptor), 'file': info,
            'input_bytes': 123, 'input_pixels': 4096}


def rejected(function, value):
    with pytest.raises(codec.InvalidArtworkProof, match='^artwork_proof_invalid$') as error:
        function(value)
    assert str(error.value) == 'artwork_proof_invalid'


def test_legacy_golden_object_roundtrip_and_insertion_order():
    assert codec.source_object(codec.parse_source(LEGACY_SOURCE)) == LEGACY_SOURCE
    assert list(codec.source_object(LEGACY_SOURCE)) == list(LEGACY_SOURCE)
    assert codec.acquisition_object(LEGACY_ACQUISITION) == LEGACY_ACQUISITION
    assert codec.validate_pair(LEGACY_SOURCE, LEGACY_ACQUISITION)
    # JSONB semantics: key order/whitespace do not have a legacy canonical contract.
    text = json.dumps(dict(reversed(list(LEGACY_SOURCE.items()))), indent=2)
    assert codec.source_object(text) == LEGACY_SOURCE
    rejected(codec.canonical_source_bytes, LEGACY_SOURCE)
    rejected(codec.canonical_acquisition_bytes, LEGACY_ACQUISITION)


def test_legacy_root_unicode_large_identity_and_negative_timestamps():
    value = deepcopy(LEGACY_SOURCE)
    value.update(artwork_root_path='/', stored_cover_path='雪/🎵.jpg',
                 resolved_cover_path='/雪/🎵.jpg', relative_parts=['雪', '🎵.jpg'],
                 root_device=1 << 80, root_inode=1 << 90)
    assert codec.source_object(value) == value
    info = deepcopy(LEGACY_ACQUISITION)
    info['file'].update(device=1 << 80, inode=1 << 90, mtime_ns=-1, ctime_ns=1 << 90)
    assert codec.acquisition_object(info) == info


def test_legacy_raw_integer_over_default_digit_threshold_without_global_changes():
    before = getattr(sys, 'get_int_max_str_digits', lambda: None)()
    text = json.dumps(LEGACY_SOURCE, separators=(',', ':')).replace(
        '"root_device":2049', '"root_device":' + '9' * 5000)
    assert len(text.encode()) < codec.SOURCE_LIMIT
    expected = deepcopy(LEGACY_SOURCE)
    expected['root_device'] = 10 ** 5000 - 1
    assert codec.source_object(text) == expected
    assert codec.source_object(expected) == expected
    observed = json.dumps(LEGACY_ACQUISITION, separators=(',', ':')).replace(
        '"ctime_ns":1700000000000000001', '"ctime_ns":-' + '9' * 1500)
    assert len(observed.encode()) < codec.ACQUISITION_LIMIT
    assert codec.acquisition_object(observed)['file']['ctime_ns'] == -(10 ** 1500 - 1)
    assert getattr(sys, 'get_int_max_str_digits', lambda: None)() == before


def test_inventory_giant_integer_rejects_before_any_decimal_conversion(monkeypatch):
    def no_conversion(_text):
        raise AssertionError('oversized inventory numeric token reached conversion')

    text = INVENTORY_BYTES.decode().replace('"library_id":1', '"library_id":' + '9' * 5000)
    assert len(text.encode()) < codec.INVENTORY_LIMIT
    monkeypatch.setattr(codec, '_local_decimal', no_conversion)
    rejected(codec.parse_inventory, text)


def test_v2_and_nonidentity_legacy_numeric_tokens_have_local_small_bounds(monkeypatch):
    original = codec._local_decimal

    def guarded(text):
        assert len(text) <= 20
        return original(text)

    monkeypatch.setattr(codec, '_local_decimal', guarded)
    for original_source in (source(), LEGACY_SOURCE):
        text = json.dumps(original_source, separators=(',', ':')).replace(
            '"library_id":1', '"library_id":' + '9' * 5000)
        rejected(codec.parse_source, text)


def test_unicode_legacy_object_and_transport_do_not_gain_v2_ascii_limit():
    root = '/' + 'é' * 4000
    legacy = deepcopy(LEGACY_SOURCE)
    legacy.update(artwork_root_path=root, stored_cover_path=root + '/x',
                  resolved_cover_path=root + '/x', relative_parts=['x'])
    ascii_json = json.dumps(legacy, ensure_ascii=True, separators=(',', ':'))
    utf8_json = json.dumps(legacy, ensure_ascii=False, separators=(',', ':'))
    assert len(ascii_json.encode()) > codec.SOURCE_LIMIT
    assert len(utf8_json.encode()) < codec.SOURCE_LIMIT
    assert codec.source_object(legacy) == legacy
    assert codec.source_object(utf8_json.encode()) == legacy
    rejected(codec.parse_source, ascii_json)  # transport bound, not object semantics
    new = source()
    for key in ('artwork_root_path', 'stored_cover_path', 'resolved_cover_path', 'relative_parts'):
        new[key] = legacy[key]
    rejected(codec.parse_source, new)  # v2 canonical-byte bound


def test_exact_canonical_and_independent_digest_vectors():
    assert codec.canonical_inventory_bytes(inventory()) == INVENTORY_BYTES
    assert codec.inventory_digest(inventory()) == INVENTORY_DIGEST
    assert codec.canonical_source_bytes(source()) == SOURCE_BYTES
    assert codec.descriptor_digest(source()) == SOURCE_DIGEST
    # Pinned vectors were independently hashed from literal shell input, not this codec.
    assert hashlib.sha256(b'AlbumHaven/artwork-root-inventory/v1\0' + INVENTORY_BYTES).hexdigest() == INVENTORY_DIGEST
    assert codec.canonical_source_bytes(dict(reversed(list(source().items())))) == SOURCE_BYTES


def test_independent_windows_descriptor_and_both_acquisition_goldens():
    # Expected bytes/digests are literal and independently hashed with printf/sha256sum.
    assert codec.canonical_source_bytes(source('win32')) == WINDOWS_SOURCE_BYTES
    assert codec.descriptor_digest(source('win32')) == WINDOWS_SOURCE_DIGEST
    assert codec.source_object(WINDOWS_SOURCE_BYTES) == source('win32')
    for raw, digest in ((POSIX_ACQUISITION_BYTES, POSIX_ACQUISITION_SHA256),
                        (WINDOWS_ACQUISITION_BYTES, WINDOWS_ACQUISITION_SHA256)):
        expected = json.loads(raw)
        assert codec.canonical_acquisition_bytes(expected) == raw
        assert hashlib.sha256(codec.canonical_acquisition_bytes(expected)).hexdigest() == digest
        descriptor = source(expected['platform'])
        assert codec.validate_pair(descriptor, expected)


def test_complete_unicode_canonical_source_literal():
    value = source()
    value['stored_cover_path'] = 'é/🎵.jpg'
    expected = (
        b'{"artwork_root_id":3,"artwork_root_path":"/music","descriptor_version":2,'
        b'"library_id":1,"local_album_id":2,"platform":"posix",'
        b'"relative_parts":["album","cover.jpg"],"resolved_cover_path":"/music/album/cover.jpg",'
        b'"root":{"device":"2049","inode":"42"},"selection_context":{'
        b'"inventory_digest":"0000000000000000000000000000000000000000000000000000000000000000",'
        b'"resolver_contract":"artwork-posix-bounded-selection-v1","version":1},'
        br'"stored_cover_path":"\u00e9/\ud83c\udfb5.jpg"}'
    )
    assert codec.canonical_source_bytes(value) == expected


def test_canonical_escape_bytes_no_normalization():
    value = source()
    value['stored_cover_path'] = 'é/🎵/"\\\b\f\n\r\t\x01\x7f'
    encoded = codec.canonical_source_bytes(value)
    assert b'"stored_cover_path":"\\u00e9/\\ud83c\\udfb5/\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u007f"' in encoded
    assert not encoded.endswith(b'\n')
    other = deepcopy(value)
    other['stored_cover_path'] = value['stored_cover_path'].replace('é', 'e\u0301')
    assert codec.descriptor_digest(value) != codec.descriptor_digest(other)


@pytest.mark.parametrize('platform', ['posix', 'win32'])
def test_versioned_roundtrip_pair_and_inventory_binding(platform):
    descriptor = source(platform, bound=True)
    observed = acquisition(descriptor)
    parsed_source, parsed_acquisition = codec.validate_pair(descriptor, observed)
    assert codec.source_object(parsed_source) == descriptor
    assert codec.acquisition_object(parsed_acquisition) == observed
    assert codec.bind_inventory(parsed_source, inventory(platform))
    assert codec.source_object(codec.canonical_source_bytes(descriptor)) == descriptor
    assert codec.acquisition_object(codec.canonical_acquisition_bytes(observed)) == observed


def test_values_are_immutable_copies_and_emit_fresh_objects():
    original = source()
    parsed = codec.parse_source(original)
    original['root']['inode'] = '9'
    emitted = codec.source_object(parsed)
    assert emitted['root']['inode'] == '42'
    emitted['relative_parts'].append('changed')
    assert codec.source_object(parsed)['relative_parts'] == ['album', 'cover.jpg']
    with pytest.raises(FrozenInstanceError):
        parsed._tree = None
    # Frozen wrapper construction itself is not a validation bypass.
    rejected(codec.parse_source, codec.SourceProof(None))


@pytest.mark.parametrize('bad', [True, False, None, 1.0, '1', 0, -1, 1 << 63])
def test_exact_identifier_types_and_ranges(bad):
    value = source()
    value['library_id'] = bad
    rejected(codec.parse_source, value)


@pytest.mark.parametrize('bad', ['', '-1', '+1', '01', '-0', '1.0', ' 1', '１',
                                 '18446744073709551616', 1, True, None])
def test_u64_rejections(bad):
    value = source()
    value['root']['inode'] = bad
    rejected(codec.parse_source, value)
    value = source('win32')
    value['root']['volume_serial'] = bad
    rejected(codec.parse_source, value)


@pytest.mark.parametrize('good', ['0', '18446744073709551615'])
def test_u64_boundaries(good):
    value = source()
    value['root'] = {'device': good, 'inode': good}
    assert codec.parse_source(value)


@pytest.mark.parametrize('bad', ['-9223372036854775809', '9223372036854775808',
                                 '-0', '+0', '00', ' 1', 1, True])
def test_signed_timestamp_rejections(bad):
    descriptor = source()
    observed = acquisition(descriptor)
    observed['file']['mtime_ns'] = bad
    rejected(codec.parse_acquisition, observed)


@pytest.mark.parametrize('good', ['-9223372036854775808', '0', '9223372036854775807'])
def test_signed_timestamp_boundaries(good):
    observed = acquisition(source())
    observed['file']['mtime_ns'] = good
    assert codec.parse_acquisition(observed)


@pytest.mark.parametrize('bad', ['A' * 32, 'f' * 31, 'f' * 33, 'g' * 32, '', None])
def test_full_file_id_exact_lowercase(bad):
    value = source('win32')
    value['root']['file_id'] = bad
    rejected(codec.parse_source, value)


@pytest.mark.parametrize('bad', [None, True, 1, 3, '2', 2.0])
def test_unknown_and_noninteger_versions(bad):
    value = source()
    value['descriptor_version'] = bad
    rejected(codec.parse_source, value)


def test_exact_keys_versions_platforms_and_sole_resolver_name():
    for original in (source(), deepcopy(LEGACY_SOURCE)):
        missing = deepcopy(original)
        del missing['library_id']
        rejected(codec.parse_source, missing)
        extra = deepcopy(original)
        extra['unrecognized'] = 1
        rejected(codec.parse_source, extra)
    legacy = deepcopy(LEGACY_SOURCE)
    legacy['platform'] = 'posix'
    rejected(codec.parse_source, legacy)
    for bad in ('windows', 'nt', 'POSIX', None):
        value = source()
        value['platform'] = bad
        rejected(codec.parse_source, value)
    for bad in ('artwork-posix-selection-v1', 'typed-posix-v1', WINDOWS, 'unknown'):
        value = source()
        value['selection_context']['resolver_contract'] = bad
        rejected(codec.parse_source, value)
    value = source()
    value['selection_context']['version'] = 2
    rejected(codec.parse_source, value)


@pytest.mark.parametrize('bad', [b'\xef\xbb\xbf{}', b'\xff', '{', '[]', 'null', 'true',
                                 '{"library_id":1,"library_id":1}',
                                 '{"file":{"size":1,"size":2}}',
                                 '{"library_id":NaN}', '{"library_id":Infinity}',
                                 ' ' * (codec.SOURCE_LIMIT + 1)])
def test_raw_text_and_duplicate_key_rejections(bad):
    rejected(codec.parse_source, bad)


@pytest.mark.parametrize('kind', ['source', 'acquisition', 'inventory'])
@pytest.mark.parametrize('nested', [False, True])
def test_duplicate_keys_in_otherwise_valid_schema_last_value_would_pass(kind, nested):
    if kind == 'source':
        parser, value = codec.parse_source, source()
        field, replacement = ('"device":"2049"', '"device":"0","device":"2049"') if nested else (
            '"library_id":1', '"library_id":2,"library_id":1')
    elif kind == 'acquisition':
        parser, value = codec.parse_acquisition, json.loads(POSIX_ACQUISITION_BYTES)
        field, replacement = ('"size":123', '"size":0,"size":123') if nested else (
            '"input_bytes":123', '"input_bytes":0,"input_bytes":123')
    else:
        parser, value = codec.parse_inventory, inventory()
        field, replacement = ('"root_id":3', '"root_id":2,"root_id":3') if nested else (
            '"library_id":1', '"library_id":2,"library_id":1')
    raw = json.dumps(value, separators=(',', ':'))
    assert parser(raw)
    duplicate = raw.replace(field, replacement, 1)
    assert duplicate != raw
    # The ordinary decoder would erase the duplicate and produce exactly valid value.
    assert json.loads(duplicate) == value
    rejected(parser, duplicate)


@pytest.mark.parametrize('kind', ['source', 'acquisition', 'inventory'])
@pytest.mark.parametrize('depth', [32, 800])
def test_deep_raw_json_rejected_locally_before_schema(kind, depth, monkeypatch):
    parser = getattr(codec, 'parse_' + kind)
    raw = '[' * depth + '0' + ']' * depth
    assert len(raw) < codec.ACQUISITION_LIMIT  # within even the smallest transport cap

    def no_schema(_value):
        raise AssertionError('deep raw input passed decoder depth boundary')

    monkeypatch.setattr(codec, '_' + kind, no_schema)
    rejected(parser, raw)


@pytest.mark.parametrize('wrapper,parser', [(codec.SourceProof, codec.parse_source),
                                           (codec.AcquisitionProof, codec.parse_acquisition),
                                           (codec.InventoryProof, codec.parse_inventory)])
def test_malformed_frozen_wrapper_shapes_depth_and_cycles(wrapper, parser):
    deep = 0
    for _ in range(32):
        deep = (deep,)
    cyclic = codec._Object(())
    object.__setattr__(cyclic, 'items', (('cycle', cyclic),))
    malformed = [None, codec._Object(42), codec._Object([]), codec._Object((1,)),
                 codec._Object((('a', 1, 2),)), codec._Object(((1, 'bad'),)),
                 codec._Object((('duplicate', 1), ('duplicate', 2))),
                 codec._Object((('deep', deep),)), cyclic]
    for tree in malformed:
        rejected(parser, wrapper(tree))


def test_surrogates_and_nul_rejected_in_objects_and_json():
    for bad in ('\ud800', '\udfff', 'x\x00y'):
        value = source()
        value['stored_cover_path'] = bad
        rejected(codec.parse_source, value)
        rejected(codec.parse_source, json.dumps(value))


@pytest.mark.parametrize('root,cover,relative', [
    ('//music', '//music/x', ['x']), ('/music/', '/music/x', ['x']),
    ('/music/../other', '/music/../other/x', ['x']), ('music', 'music/x', ['x']),
    ('/music', '/other/x', ['x']), ('/music', '/music/x', []),
    ('/music', '/music/x', ['.']), ('/music', '/music/x', ['..']),
    ('/music', '/music/a/x', ['a/x']), ('/music', '/music/x', ('x',)),
])
def test_posix_lexical_shape_rejections(root, cover, relative):
    value = source()
    value.update(artwork_root_path=root, resolved_cover_path=cover, relative_parts=relative)
    rejected(codec.parse_source, value)


def test_posix_byte_and_component_boundaries():
    value = source()
    value.update(artwork_root_path='/' + 'x' * 8191, resolved_cover_path='/' + 'x' * 8191 + '/a',
                 relative_parts=['a'])
    assert codec.parse_source(value)
    value['artwork_root_path'] += 'x'
    rejected(codec.parse_source, value)
    value = source()
    value.update(artwork_root_path='/', relative_parts=['a'] * 255,
                 resolved_cover_path='/' + '/'.join(['a'] * 255))
    assert codec.parse_source(value)
    value['relative_parts'].append('a')
    value['resolved_cover_path'] += '/a'
    rejected(codec.parse_source, value)


@pytest.mark.parametrize('name', ['CON.jpg', 'CON .jpg', 'con  .jpg', 'LPT¹.png', 'COM9',
                                  'NUL', 'CLOCK$.x', 'x.', 'x ', '.', '..', '',
                                  'a:b', 'a/b', 'a\\b', 'a\x01b', 'a?b', 'a*b',
                                  'a<b', 'a>b', 'a|b', 'a"b', 'x' * 256, '🎵' * 128])
def test_windows_components_and_exact_r3_reserved_algorithm(name):
    value = source('win32')
    value.update(relative_parts=[name], resolved_cover_path='C:\\music\\' + name)
    rejected(codec.parse_source, value)


@pytest.mark.parametrize('name', ['console.jpg', 'COM10.jpg', '🎵' * 127 + 'x', 'x' * 255])
def test_windows_component_utf16_boundaries(name):
    value = source('win32')
    value.update(relative_parts=[name], resolved_cover_path='C:\\music\\' + name)
    assert codec.parse_source(value)


@pytest.mark.parametrize('path', ['\\\\server\\share', '\\\\?\\C:\\music', 'C:music',
                                  'C:/music', 'C:\\music\\', 'C:\\a\\..\\music'])
def test_windows_root_namespace_rejections(path):
    value = source('win32')
    value['artwork_root_path'] = path
    rejected(codec.parse_source, value)


def test_windows_selectors_exact_case_and_alias_shape():
    value = source('win32')
    selector = value['root']['selector']
    assert selector['volume_guid'][4:-1] == 'Volume{01234567-89AB-cdef-0123-456789abcdef}'
    for key, bad in [('drive', 'c:'), ('volume_guid', 'Volume{01234567-89AB-cdef-0123-456789abcdef}'),
                     ('volume_guid', selector['volume_guid'][:-1]),
                     ('drive_target', '\\Device\\Mup'), ('guid_target', '\\Device\\HarddiskVolume13')]:
        changed = deepcopy(value)
        changed['root']['selector'][key] = bad
        rejected(codec.parse_source, changed)
    changed = deepcopy(value)
    changed['root']['selector']['volume_guid'] = selector['volume_guid'].replace('89AB', '89ab')
    assert codec.parse_source(changed)
    assert codec.descriptor_digest(value) != codec.descriptor_digest(changed)


def test_windows_drive_root_join_and_leaf_cross_volume_rejected():
    value = source('win32')
    value.update(artwork_root_path='C:\\', resolved_cover_path='C:\\cover.jpg', relative_parts=['cover.jpg'])
    assert codec.parse_source(value)
    observed = acquisition(value)
    observed['file']['leaf_identity']['volume_serial'] = '0'
    rejected(codec.parse_acquisition, observed)


@pytest.mark.parametrize('field,bad', [('input_bytes', 0), ('input_bytes', 16777217),
                                     ('input_bytes', True), ('input_pixels', 0),
                                     ('input_pixels', 16000001), ('input_pixels', 1.0)])
def test_acquisition_resource_scalar_limits(field, bad):
    value = acquisition(source())
    value[field] = bad
    rejected(codec.parse_acquisition, value)


def test_acquisition_size_equality_and_posix_mount_semantics():
    descriptor = source()
    value = acquisition(descriptor)
    value['file']['size'] += 1
    rejected(codec.parse_acquisition, value)
    value = acquisition(descriptor)
    value['file']['device'] = '9999'
    assert codec.validate_pair(descriptor, value)  # POSIX mount crossing is preserved.


def test_pair_recomputes_descriptor_digest_and_rejects_mix():
    descriptor = source()
    observed = acquisition(descriptor)
    observed['descriptor_digest'] = 'f' * 64
    with pytest.raises(codec.InvalidArtworkProof):
        codec.validate_pair(descriptor, observed)
    observed = acquisition(descriptor)
    descriptor['stored_cover_path'] = 'other.jpg'
    with pytest.raises(codec.InvalidArtworkProof):
        codec.validate_pair(descriptor, observed)
    for left, right in [(LEGACY_SOURCE, acquisition(source())), (source(), LEGACY_ACQUISITION),
                        (source(), acquisition(source('win32')))]:
        with pytest.raises(codec.InvalidArtworkProof):
            codec.validate_pair(left, right)
    descriptor = source('win32')
    observed = acquisition(descriptor)
    observed['file']['root_identity']['file_id'] = '0' * 32
    with pytest.raises(codec.InvalidArtworkProof):
        codec.validate_pair(descriptor, observed)


def test_inventory_binding_recomputes_digest_not_membership_only():
    descriptor = source(bound=True)
    current = inventory()
    assert codec.bind_inventory(descriptor, current)
    current['roots'].append({'root_id': 4, 'root_path': '/other', 'browse_eligible': False})
    with pytest.raises(codec.InvalidArtworkProof):
        codec.bind_inventory(descriptor, current)
    descriptor['selection_context']['inventory_digest'] = codec.inventory_digest(current)
    assert codec.bind_inventory(descriptor, current)
    current['roots'][1]['browse_eligible'] = True
    with pytest.raises(codec.InvalidArtworkProof):
        codec.bind_inventory(descriptor, current)


@pytest.mark.parametrize('mutation', ['missing', 'denied', 'path', 'library', 'platform'])
def test_inventory_binding_scope_and_membership(mutation):
    descriptor = source(bound=True)
    current = inventory()
    if mutation == 'missing':
        current['roots'] = []
    elif mutation == 'denied':
        current['roots'][0]['browse_eligible'] = False
    elif mutation == 'path':
        current['roots'][0]['root_path'] = '/different'
    elif mutation == 'library':
        current['library_id'] = 2
    else:
        current = inventory('win32')
    descriptor['selection_context']['inventory_digest'] = codec.inventory_digest(current)
    with pytest.raises(codec.InvalidArtworkProof):
        codec.bind_inventory(descriptor, current)


def test_inventory_complete_order_duplicates_and_bounds():
    current = inventory()
    current['roots'].append({'root_id': 4, 'root_path': '/music', 'browse_eligible': False})
    assert len(codec.inventory_object(current)['roots']) == 2  # duplicate paths remain
    reversed_roots = deepcopy(current)
    reversed_roots['roots'].reverse()
    rejected(codec.parse_inventory, reversed_roots)
    duplicate = deepcopy(current)
    duplicate['roots'][1]['root_id'] = 3
    rejected(codec.parse_inventory, duplicate)
    invalid_policy = deepcopy(current)
    invalid_policy['roots'][0]['browse_eligible'] = 1
    rejected(codec.parse_inventory, invalid_policy)
    invalid_version = deepcopy(current)
    invalid_version['inventory_version'] = 2
    rejected(codec.parse_inventory, invalid_version)
    current['roots'] = [{'root_id': number, 'root_path': '/music', 'browse_eligible': True}
                        for number in range(1, 1025)]
    assert codec.parse_inventory(current)
    current['roots'].append({'root_id': 1025, 'root_path': '/music', 'browse_eligible': True})
    rejected(codec.parse_inventory, current)


def test_inventory_keeps_exact_nonselected_path_spelling_and_empty_inventory():
    current = inventory()
    current['roots'].append({'root_id': 4, 'root_path': '/a//b/', 'browse_eligible': False})
    assert codec.inventory_object(current)['roots'][1]['root_path'] == '/a//b/'
    changed = deepcopy(current)
    changed['roots'][1]['root_path'] = '/a/b'
    assert codec.inventory_digest(current) != codec.inventory_digest(changed)
    current['roots'] = []
    assert codec.parse_inventory(current)
    with pytest.raises(codec.InvalidArtworkProof):
        codec.bind_inventory(LEGACY_SOURCE, current)


def test_no_artwork_null_is_not_a_forged_proof():
    for parser in (codec.parse_source, codec.parse_acquisition, codec.parse_inventory):
        rejected(parser, None)


def test_acquisition_canonical_size_limit_is_enforced(monkeypatch):
    # Valid exact schema normally fits comfortably; exercise the actual bounded encoder.
    value = acquisition(source())
    size = len(codec.canonical_acquisition_bytes(value))
    monkeypatch.setattr(codec, 'ACQUISITION_LIMIT', size)
    assert codec.parse_acquisition(value)
    monkeypatch.setattr(codec, 'ACQUISITION_LIMIT', size - 1)
    rejected(codec.parse_acquisition, value)
    assert codec.parse_acquisition(LEGACY_ACQUISITION)  # object legacy has no new limit


def test_source_import_and_codec_operations_have_no_native_or_owner_io(monkeypatch):
    # Read source before installing I/O traps; then evaluate only when tests are authorized.
    text = Path(codec.__file__).read_text(encoding='utf-8')
    original_import = builtins.__import__
    original_open = builtins.open
    imports = []

    def guarded_import(name, *args, **kwargs):
        imports.append(name)
        if name not in ('collections', 'dataclasses', 'hashlib', 'json', 're', 'types', 'weakref'):
            raise AssertionError('unexpected codec import: ' + name)
        return original_import(name, *args, **kwargs)

    def no_io(*args, **kwargs):
        raise AssertionError('codec attempted I/O')

    name = '_isolated_artwork_proof_codec_test'
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader=None))
    monkeypatch.setitem(sys.modules, name, module)
    # Trap only the isolated module; pytest and unrelated modules keep their own
    # normal builtins, including while an exception is being reported.
    module_builtins = dict(vars(builtins), __import__=guarded_import, open=no_io)
    module.__dict__['__builtins__'] = module_builtins
    try:
        exec(compile(text, '<pure-artwork-codec>', 'exec'), module.__dict__)
        assert imports == ['collections', 'dataclasses', 'hashlib', 'json', 're', 'types', 'weakref']
        descriptor = source(bound=True)
        assert module.bind_inventory(descriptor, inventory())
        assert module.validate_pair(descriptor, acquisition(descriptor))
        assert module.bind_prepared_inventory(descriptor, module.prepare_inventory_binding(inventory()))
    finally:
        # Functions created by exec retain this dictionary. Restore its entries
        # before control returns to pytest, on success and on every failure path.
        module_builtins['__import__'] = original_import
        module_builtins['open'] = original_open


# Prepared-inventory additions compose with the published module-local harness.
# Its allowlist/order includes only the three additional pure standard modules.
UNICODE_INVENTORY_BYTES = (
    b'{"inventory_version":1,"library_id":1,"platform":"posix",'
    b'"resolver_contract":"artwork-posix-bounded-selection-v1","roots":['
    b'{"browse_eligible":true,"root_id":3,"root_path":"/music"},'
    br'{"browse_eligible":false,"root_id":4,"root_path":"/\u00e9/\ud83c\udfb5/\"\\\b\f\n\r\t\u0001\u007f"}]}'
)
# Independently hashed from literal shell input with the published domain + NUL.
UNICODE_INVENTORY_DIGEST = 'b842686fb2b473bcab0e78df9ca1dc0dd79cd8cb7ba92e53981d9cebcd0d6b10'


def _published_inventory_binding(descriptor, current):
    """Test-only copy of the pre-change binding predicates, for differential cases."""
    descriptor = codec.source_object(descriptor)
    current = codec.inventory_object(current)
    if 'descriptor_version' not in descriptor:
        raise codec.InvalidArtworkProof()
    context = descriptor['selection_context']
    if (descriptor['library_id'] != current['library_id']
            or descriptor['platform'] != current['platform']
            or context['resolver_contract'] != current['resolver_contract']
            or context['inventory_digest'] != codec.inventory_digest(current)):
        raise codec.InvalidArtworkProof()
    selected = next((root for root in current['roots']
                     if root['root_id'] == descriptor['artwork_root_id']), None)
    if (selected is None or not selected['browse_eligible']
            or selected['root_path'] != descriptor['artwork_root_path']):
        raise codec.InvalidArtworkProof()
    return descriptor, current


def _binding_outcome(function, descriptor, current):
    try:
        return ('accepted', function(descriptor, current))
    except codec.InvalidArtworkProof as error:
        return ('rejected', str(error))


def _existing_api_objects(descriptor, current):
    parsed_source, parsed_inventory = codec.bind_inventory(descriptor, current)
    assert type(parsed_source) is codec.SourceProof
    assert type(parsed_inventory) is codec.InventoryProof
    return codec.source_object(parsed_source), codec.inventory_object(parsed_inventory)


def _prepared_api_objects(descriptor, current):
    prepared = codec.prepare_inventory_binding(current)
    bound = codec.bind_prepared_inventory(descriptor, prepared)
    assert type(bound) is codec.SourceProof
    return codec.source_object(bound), codec.inventory_object(current)


def _codec_input(value, kind, form):
    if form == 'object':
        return deepcopy(value)
    if form == 'text':
        return json.dumps(value, ensure_ascii=False, indent=2)
    if form == 'bytes':
        return json.dumps(value, ensure_ascii=False, indent=2).encode('utf-8')
    return getattr(codec, 'parse_' + kind)(value)


@pytest.mark.parametrize('platform', ['posix', 'win32'])
@pytest.mark.parametrize('source_form', ['object', 'text', 'bytes', 'wrapper'])
@pytest.mark.parametrize('inventory_form', ['object', 'text', 'bytes', 'wrapper'])
def test_prepared_binding_preserves_all_published_input_forms(platform, source_form, inventory_form):
    descriptor = _codec_input(source(platform, bound=True), 'source', source_form)
    current = _codec_input(inventory(platform), 'inventory', inventory_form)
    expected = _binding_outcome(_published_inventory_binding, descriptor, current)
    assert expected[0] == 'accepted'
    assert _binding_outcome(_existing_api_objects, descriptor, current) == expected
    assert _binding_outcome(_prepared_api_objects, descriptor, current) == expected


@pytest.mark.parametrize('case', [
    'source_library', 'source_local', 'source_root_id', 'source_root_path',
    'source_platform', 'source_resolver', 'source_context_version', 'source_digest',
    'source_version', 'source_legacy', 'source_boolean_id', 'source_extra_key',
    'inventory_library', 'inventory_platform', 'inventory_resolver', 'inventory_version',
    'inventory_extra_key', 'inventory_boolean_id', 'inventory_root_boolean',
    'inventory_root_missing', 'inventory_root_denied', 'inventory_root_path',
    'inventory_root_duplicate', 'inventory_root_order', 'inventory_root_overflow',
    'inventory_root_bad_text', 'inventory_unselected_spelling',
    'inventory_new_root_stale_digest', 'inventory_new_root_fresh_digest',
])
def test_prepared_and_existing_binding_match_published_predicates(case):
    descriptor = source(bound=True)
    current = inventory()
    fresh_digest = False
    if case == 'source_library':
        descriptor['library_id'] = 2
    elif case == 'source_local':
        descriptor['local_album_id'] = 99  # The inventory never binds local_album_id.
    elif case == 'source_root_id':
        descriptor['artwork_root_id'] = 4
    elif case == 'source_root_path':
        descriptor.update(artwork_root_path='/other', resolved_cover_path='/other/album/cover.jpg')
    elif case == 'source_platform':
        descriptor = source('win32', bound=True)
    elif case == 'source_resolver':
        descriptor['selection_context']['resolver_contract'] = WINDOWS
    elif case == 'source_context_version':
        descriptor['selection_context']['version'] = 2
    elif case == 'source_digest':
        descriptor['selection_context']['inventory_digest'] = 'f' * 64
    elif case == 'source_version':
        descriptor['descriptor_version'] = 1
    elif case == 'source_legacy':
        descriptor = deepcopy(LEGACY_SOURCE)
    elif case == 'source_boolean_id':
        descriptor['library_id'] = True
    elif case == 'source_extra_key':
        descriptor['extra'] = 1
    elif case == 'inventory_library':
        current['library_id'] = 2
        fresh_digest = True
    elif case == 'inventory_platform':
        current = inventory('win32')
        fresh_digest = True
    elif case == 'inventory_resolver':
        current['resolver_contract'] = WINDOWS
    elif case == 'inventory_version':
        current['inventory_version'] = 2
    elif case == 'inventory_extra_key':
        current['extra'] = 1
    elif case == 'inventory_boolean_id':
        current['library_id'] = True
    elif case == 'inventory_root_boolean':
        current['roots'][0]['browse_eligible'] = 1
    elif case == 'inventory_root_missing':
        current['roots'] = []
        fresh_digest = True
    elif case == 'inventory_root_denied':
        current['roots'][0]['browse_eligible'] = False
        fresh_digest = True
    elif case == 'inventory_root_path':
        current['roots'][0]['root_path'] = '/other'
        fresh_digest = True
    elif case == 'inventory_root_duplicate':
        current['roots'].append(deepcopy(current['roots'][0]))
    elif case == 'inventory_root_order':
        current['roots'].append({'root_id': 2, 'root_path': '/other', 'browse_eligible': True})
    elif case == 'inventory_root_overflow':
        current['roots'] = [{'root_id': number, 'root_path': '/music', 'browse_eligible': True}
                            for number in range(1, 1026)]
    elif case == 'inventory_root_bad_text':
        current['roots'][0]['root_path'] = '/bad\x00root'
    else:
        path = '/a//b/' if case == 'inventory_unselected_spelling' else '/other'
        current['roots'].append({'root_id': 4, 'root_path': path, 'browse_eligible': False})
        fresh_digest = case != 'inventory_new_root_stale_digest'
    if fresh_digest:
        descriptor['selection_context']['inventory_digest'] = codec.inventory_digest(current)
    expected = _binding_outcome(_published_inventory_binding, descriptor, current)
    assert _binding_outcome(_existing_api_objects, descriptor, current) == expected
    assert _binding_outcome(_prepared_api_objects, descriptor, current) == expected
    assert expected[0] == ('accepted' if case in (
        'source_local', 'inventory_unselected_spelling', 'inventory_new_root_fresh_digest')
        else 'rejected')


@pytest.mark.parametrize('current', [
    None, True, 1, (), [], codec.InventoryProof(None), codec.SourceProof(None),
    b'\xff', b'\xef\xbb\xbf{}', '{', 'null', '[]',
    '{"inventory_version":1,"inventory_version":1}',
])
def test_prepare_inventory_preserves_untrusted_input_rejections(current):
    rejected(codec.parse_inventory, current)
    rejected(codec.prepare_inventory_binding, current)


def test_prepare_rejects_prepared_input_and_does_not_change_legacy_pair():
    prepared = codec.prepare_inventory_binding(inventory())
    rejected(codec.prepare_inventory_binding, prepared)
    rejected(codec.parse_inventory, prepared)
    rejected(lambda value: codec.bind_inventory(source(bound=True), value), prepared)
    rejected(lambda value: codec.bind_prepared_inventory(value, prepared), LEGACY_SOURCE)
    left, right = codec.validate_pair(LEGACY_SOURCE, LEGACY_ACQUISITION)
    assert codec.source_object(left) == LEGACY_SOURCE
    assert codec.acquisition_object(right) == LEGACY_ACQUISITION


def test_prepared_digest_summary_goldens_and_exact_unicode_spelling():
    prepared = codec.prepare_inventory_binding(INVENTORY_BYTES)
    assert (prepared.digest, prepared.library_id, prepared.platform,
            prepared.resolver_contract, prepared.root_count) == (
                INVENTORY_DIGEST, 1, 'posix', POSIX, 1)
    unicode_inventory = inventory()
    unicode_inventory['roots'].append({
        'root_id': 4, 'root_path': '/é/🎵/"\\\b\f\n\r\t\x01\x7f', 'browse_eligible': False,
    })
    assert codec.canonical_inventory_bytes(unicode_inventory) == UNICODE_INVENTORY_BYTES
    assert codec.inventory_digest(unicode_inventory) == UNICODE_INVENTORY_DIGEST
    assert codec.prepare_inventory_binding(unicode_inventory).digest == UNICODE_INVENTORY_DIGEST
    assert hashlib.sha256(b'AlbumHaven/artwork-root-inventory/v1\0'
                          + UNICODE_INVENTORY_BYTES).hexdigest() == UNICODE_INVENTORY_DIGEST
    changed = deepcopy(unicode_inventory)
    changed['roots'][1]['root_path'] = changed['roots'][1]['root_path'].replace('é', 'e\u0301')
    assert codec.prepare_inventory_binding(changed).digest != UNICODE_INVENTORY_DIGEST
    assert codec.canonical_source_bytes(source()) == SOURCE_BYTES
    assert codec.canonical_source_bytes(source('win32')) == WINDOWS_SOURCE_BYTES


def test_prepare_enforces_existing_canonical_inventory_cap_once(monkeypatch):
    monkeypatch.setattr(codec, 'INVENTORY_LIMIT', len(INVENTORY_BYTES))
    assert codec.prepare_inventory_binding(inventory()).digest == INVENTORY_DIGEST
    monkeypatch.setattr(codec, 'INVENTORY_LIMIT', len(INVENTORY_BYTES) - 1)
    rejected(codec.prepare_inventory_binding, inventory())
    rejected(codec.parse_inventory, inventory())


def test_prepared_immutable_copy_and_each_source_is_reparsed():
    current = inventory()
    descriptor = source(bound=True)
    prepared = codec.prepare_inventory_binding(current)
    old_source, old_inventory = codec.bind_inventory(descriptor, current)
    current['roots'][0]['root_path'] = '/changed'
    current['roots'][0]['browse_eligible'] = False
    current['roots'].clear()
    current['library_id'] = 99
    assert prepared.digest == INVENTORY_DIGEST
    assert prepared.root_count == 1
    bound = codec.bind_prepared_inventory(descriptor, prepared)
    descriptor['root']['inode'] = '99'
    assert codec.source_object(bound)['root']['inode'] == '42'
    assert codec.source_object(old_source)['root']['inode'] == '42'
    assert codec.inventory_object(old_inventory) == inventory()
    assert codec.source_object(codec.bind_prepared_inventory(descriptor, prepared))['root']['inode'] == '99'
    descriptor['selection_context']['inventory_digest'] = 'f' * 64
    rejected(lambda value: codec.bind_prepared_inventory(value, prepared), descriptor)


def test_prepared_context_has_no_public_constructor_dictionary_or_setter():
    for args, kwargs in (((), {}), ((inventory(),), {}),
                         ((), {'digest': INVENTORY_DIGEST}),
                         ((), {'already_validated': True})):
        rejected(lambda _ignored: codec.PreparedInventoryBinding(*args, **kwargs), None)
    prepared = codec.prepare_inventory_binding(inventory())
    assert not hasattr(prepared, '__dict__')
    for name in ('digest', 'library_id', 'platform', 'resolver_contract', 'root_count',
                 '_state', '_state_identity', '_roots_identity', 'extra'):
        rejected(lambda _ignored, name=name: setattr(prepared, name, None), None)
        rejected(lambda _ignored, name=name: delattr(prepared, name), None)
    with pytest.raises(TypeError):
        prepared._state.roots[3] = None
    with pytest.raises(AttributeError):
        prepared._state.digest = 'f' * 64
    with pytest.raises(AttributeError):
        prepared._state.roots[3].root_path = '/changed'


def test_fabricated_empty_subclass_and_borrowed_state_contexts_reject():
    class Subclass(codec.PreparedInventoryBinding):
        pass

    prepared = codec.prepare_inventory_binding(inventory())
    values = [None, inventory(), INVENTORY_BYTES, INVENTORY_BYTES.decode(),
              codec.parse_inventory(inventory()), codec.parse_source(source(bound=True)),
              prepared._state, lambda: prepared,
              object.__new__(codec.PreparedInventoryBinding), object.__new__(Subclass)]
    borrowed = object.__new__(codec.PreparedInventoryBinding)
    for slot in ('_state', '_state_identity', '_roots_identity'):
        object.__setattr__(borrowed, slot, getattr(prepared, slot))
    values.append(borrowed)
    for malformed in values:
        rejected(lambda value: codec.bind_prepared_inventory(source(bound=True), value), malformed)
    rejected(lambda _ignored: Subclass(), None)
    for slot in ('_state', '_state_identity', '_roots_identity'):
        malformed = codec.prepare_inventory_binding(inventory())
        object.__delattr__(malformed, slot)
        rejected(lambda value: codec.bind_prepared_inventory(source(bound=True), value), malformed)
        rejected(lambda value: value.digest, malformed)


def test_prepared_raw_state_replacement_and_exact_state_shape_reject():
    prepared = codec.prepare_inventory_binding(inventory())
    replacement = prepared._state._replace(digest='f' * 64)
    object.__setattr__(prepared, '_state', replacement)
    rejected(lambda value: codec.bind_prepared_inventory(source(bound=True), value), prepared)
    for malformed in (None, {}, (), lambda: None,
                      tuple.__new__(codec._PreparedInventoryState, ()),
                      tuple.__new__(codec._PreparedInventoryState, (None,) * 9)):
        prepared = codec.prepare_inventory_binding(inventory())
        object.__setattr__(prepared, '_state', malformed)
        object.__setattr__(prepared, '_state_identity', malformed)
        rejected(lambda value: codec.bind_prepared_inventory(source(bound=True), value), prepared)


@pytest.mark.parametrize('field,bad', [
    ('marker', None), ('owner', None), ('owner', lambda: None),
    ('library_id', True), ('library_id', 0), ('library_id', 1 << 63),
    ('platform', 'POSIX'), ('platform', None), ('resolver_contract', WINDOWS),
    ('digest', 'A' * 64), ('digest', ''), ('digest', None),
    ('root_count', True), ('root_count', -1), ('root_count', 1025), ('root_count', 0),
    ('roots', {}), ('roots', None), ('roots', lambda: None),
])
def test_prepared_defensive_scalar_checks_reject_whitebox_corruption(field, bad):
    # Deliberately rewrite private state to exercise defensive checks. This is not
    # a claim of security against a caller that rewrites valid private codec state.
    prepared = codec.prepare_inventory_binding(inventory())
    state = prepared._state._replace(**{field: bad})
    object.__setattr__(prepared, '_state', state)
    object.__setattr__(prepared, '_state_identity', state)
    rejected(lambda value: codec.bind_prepared_inventory(source(bound=True), value), prepared)


def test_prepared_misuse_never_invokes_arbitrary_mapping_or_callback():
    class Tripwire:
        def __getitem__(self, key):
            raise AssertionError('untrusted index access')

        def __iter__(self):
            raise AssertionError('untrusted index iteration')

        def __len__(self):
            raise AssertionError('untrusted index length')

        def __getattr__(self, name):
            raise AssertionError('untrusted attribute access')

        def __call__(self):
            raise AssertionError('untrusted callback')

    attack = Tripwire()
    for bad_state in (attack, {'digest': INVENTORY_DIGEST}, lambda: None):
        prepared = codec.prepare_inventory_binding(inventory())
        object.__setattr__(prepared, '_state', bad_state)
        object.__setattr__(prepared, '_state_identity', bad_state)
        rejected(lambda value: codec.bind_prepared_inventory(source(bound=True), value), prepared)
    for bad_index in (attack, {}, codec.MappingProxyType(attack)):
        prepared = codec.prepare_inventory_binding(inventory())
        state = prepared._state._replace(roots=bad_index)
        object.__setattr__(prepared, '_state', state)
        object.__setattr__(prepared, '_state_identity', state)
        rejected(lambda value: codec.bind_prepared_inventory(source(bound=True), value), prepared)
    prepared = codec.prepare_inventory_binding(inventory())
    state = prepared._state._replace(owner=codec.ref(prepared, lambda _value: None))
    object.__setattr__(prepared, '_state', state)
    object.__setattr__(prepared, '_state_identity', state)
    rejected(lambda value: codec.bind_prepared_inventory(source(bound=True), value), prepared)


@pytest.mark.parametrize('entry', [
    None, {}, (3, '/music', True),
    codec._PreparedRoot(True, '/music', True), codec._PreparedRoot(4, '/music', True),
    codec._PreparedRoot(0, '/music', True), codec._PreparedRoot(1 << 63, '/music', True),
    codec._PreparedRoot(3, None, True), codec._PreparedRoot(3, '/bad\x00root', True),
    codec._PreparedRoot(3, '/bad\ud800root', True), codec._PreparedRoot(3, '/' + 'x' * 8192, True),
    codec._PreparedRoot(3, '/music', 1), codec._PreparedRoot(3, '/music', False),
    codec._PreparedRoot(3, '/other', True),
    tuple.__new__(codec._PreparedRoot, (3, '/music', True, 'extra')),
])
def test_prepared_binding_defensively_checks_exact_selected_immutable_entry(entry, monkeypatch):
    # Defect injection inside the factory verifies the selected-entry check itself.
    # A caller has no public index setter or mutable backing dictionary.
    monkeypatch.setattr(codec, '_prepared_root_index', lambda roots: codec.MappingProxyType({3: entry}))
    prepared = codec.prepare_inventory_binding(inventory())
    rejected(lambda value: codec.bind_prepared_inventory(source(bound=True), value), prepared)


def test_prepared_contexts_are_distinct_and_drop_without_a_reference_cycle():
    first = codec.prepare_inventory_binding(inventory())
    second = codec.prepare_inventory_binding(inventory())
    assert first is not second
    assert first._state is not second._state
    assert first._state.roots is not second._state.roots
    assert first.digest == second.digest
    first_reference = codec.ref(first)
    second_reference = codec.ref(second)
    del first
    assert first_reference() is None
    assert codec.bind_prepared_inventory(source(bound=True), second)
    del second
    assert second_reference() is None


def test_5000_prepared_bindings_1024_roots_have_constant_complete_inventory_work(monkeypatch, record_property):
    import time
    import tracemalloc

    current = inventory()
    current['roots'] = [{'root_id': number, 'root_path': '/music', 'browse_eligible': True}
                        for number in range(1, 1025)]
    counts = dict(validation=0, encoding=0, hashing=0, copying=0, indexing=0,
                  indexed_roots=0, source_parse=0, lookup=0,
                  root_id_access=0, root_path_access=0, browse_eligible_access=0)
    original_inventory = codec._inventory
    original_canonical = codec._canonical
    original_hash = codec.hashlib.sha256
    original_freeze = codec._freeze
    original_index = codec._prepared_root_index
    original_source = codec.parse_source
    original_lookup = codec._selected_prepared_root

    def checked_inventory(value):
        counts['validation'] += 1
        return original_inventory(value)

    def checked_canonical(value, limit):
        if type(value) is dict and 'inventory_version' in value:
            counts['encoding'] += 1
        return original_canonical(value, limit)

    def checked_hash(value=b'', *args, **kwargs):
        if type(value) is bytes and value.startswith(codec._INVENTORY_DOMAIN):
            counts['hashing'] += 1
        return original_hash(value, *args, **kwargs)

    def checked_freeze(value):
        if type(value) is dict and 'inventory_version' in value:
            counts['copying'] += 1
        return original_freeze(value)

    def checked_index(roots):
        counts['indexing'] += 1
        counts['indexed_roots'] += len(roots)
        return original_index(roots)

    def checked_source(value):
        counts['source_parse'] += 1
        return original_source(value)

    def checked_lookup(state, root_id):
        counts['lookup'] += 1
        return original_lookup(state, root_id)

    def forbidden_whole_inventory_helper(*args, **kwargs):
        raise AssertionError('public whole-inventory helper used by prepared binding')

    monkeypatch.setattr(codec, '_inventory', checked_inventory)
    monkeypatch.setattr(codec, '_canonical', checked_canonical)
    monkeypatch.setattr(codec.hashlib, 'sha256', checked_hash)
    monkeypatch.setattr(codec, '_freeze', checked_freeze)
    monkeypatch.setattr(codec, '_prepared_root_index', checked_index)
    monkeypatch.setattr(codec, 'parse_source', checked_source)
    monkeypatch.setattr(codec, '_selected_prepared_root', checked_lookup)
    for name in ('parse_inventory', 'inventory_object', 'inventory_digest', 'canonical_inventory_bytes'):
        monkeypatch.setattr(codec, name, forbidden_whole_inventory_helper)
    for name in ('root_id', 'root_path', 'browse_eligible'):
        getter = getattr(codec._PreparedRoot, name)

        def counted_getter(root, name=name, getter=getter):
            counts[name + '_access'] += 1
            return getter.__get__(root, type(root))

        monkeypatch.setattr(codec._PreparedRoot, name, property(counted_getter))
    tracing_owned = not tracemalloc.is_tracing()
    if tracing_owned:
        tracemalloc.start()
    wall_started = time.perf_counter()
    cpu_started = time.process_time()
    try:
        prepared = codec.prepare_inventory_binding(current)
        descriptor = source()
        descriptor['selection_context']['inventory_digest'] = prepared.digest
        for number in range(5000):
            descriptor['local_album_id'] = number + 1
            descriptor['artwork_root_id'] = number % 1024 + 1
            assert type(codec.bind_prepared_inventory(descriptor, prepared)) is codec.SourceProof
        python_current, python_peak = tracemalloc.get_traced_memory()
        record_property('prepared_5000_1024_wall_seconds', time.perf_counter() - wall_started)
        record_property('prepared_5000_1024_cpu_seconds', time.process_time() - cpu_started)
        record_property('prepared_5000_1024_python_current_bytes', python_current)
        record_property('prepared_5000_1024_python_peak_bytes', python_peak)
    finally:
        if tracing_owned:
            tracemalloc.stop()
    try:
        import resource
    except ImportError:
        record_property('prepared_process_peak_rss_bytes', 'unavailable_on_this_platform')
    else:
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        record_property('prepared_process_peak_rss_bytes', peak if sys.platform == 'darwin' else peak * 1024)
    # Codec-only CPU/Python-memory/process-RSS observations do not establish DB-held
    # time, an isolated RSS delta, or acceptable thresholds; the owner measures those.
    assert counts == dict(validation=1, encoding=1, hashing=1, copying=1, indexing=1,
                          indexed_roots=1024, source_parse=5000, lookup=5000,
                          root_id_access=10000, root_path_access=10000,
                          browse_eligible_access=10000)
