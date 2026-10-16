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
    imports = []

    def guarded_import(name, *args, **kwargs):
        imports.append(name)
        if name not in ('dataclasses', 'hashlib', 'json', 're'):
            raise AssertionError('unexpected codec import: ' + name)
        return original_import(name, *args, **kwargs)

    def no_io(*args, **kwargs):
        raise AssertionError('codec attempted I/O')

    name = '_isolated_artwork_proof_codec_test'
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader=None))
    monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setattr(builtins, '__import__', guarded_import)
    monkeypatch.setattr(builtins, 'open', no_io)
    exec(compile(text, '<pure-artwork-codec>', 'exec'), module.__dict__)
    assert imports == ['dataclasses', 'hashlib', 'json', 're']
    descriptor = source(bound=True)
    assert module.bind_inventory(descriptor, inventory())
    assert module.validate_pair(descriptor, acquisition(descriptor))
