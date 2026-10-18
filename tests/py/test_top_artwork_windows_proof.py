"""W3 pure proof contracts with real codec/inventory and legacy vectors.

Source-authored only, no genuine native, application or decoder evidence.
"""
import ast
from copy import deepcopy
from dataclasses import replace
import hashlib
import importlib
import json
from pathlib import Path
import sys

import pytest


def _checkout_imports():
    here = Path(__file__).resolve(strict=True)
    if here.parts[-3:] != ('tests', 'py', 'test_top_artwork_windows_proof.py'):
        raise AssertionError('unexpected synthetic suite origin')
    root = here.parents[2]
    names = ('rooted_local_file', '_rooted_local_file_windows', '_top_artwork_resolution',
             '_top_artwork_resolution_windows', 'artwork_pixels',
             'public_top_artwork_acquisition', '_top_artwork_capture_windows',
             'artwork_proof_codec', 'current_actor', 'client_surfaces', 'capabilities',
             'allowed_actions', 'policy', 'policy_evaluator', 'owned_album_tops',
             '_top_artwork_draft_proof')
    expected = {'music_app': root / 'music_app/__init__.py',
                'music_app.services': root / 'music_app/services/__init__.py'}
    expected.update({'music_app.services.' + name: root / ('music_app/services/' + name + '.py')
                     for name in names})
    for name, path in expected.items():
        assert path.is_file(), 'incomplete trusted checkout'
        module = sys.modules.get(name)
        if module is not None:
            assert getattr(module, '__file__', None) and Path(module.__file__).resolve(strict=True) == path
    added = str(root) not in sys.path
    if added:
        sys.path.insert(0, str(root))
    try:
        modules = tuple(importlib.import_module('music_app.services.' + name) for name in names)
        for name, path in expected.items():
            assert Path(sys.modules[name].__file__).resolve(strict=True) == path
    finally:
        if added:
            sys.path.remove(str(root))
    return modules


(rooted, windows, resolution, winresolution, pixels, facade, capture, codec,
 current_actor, client_surfaces, capabilities, allowed_actions, policy,
 policy_evaluator, tops, proof) = _checkout_imports()
ROOT = 'C:\\Music'
GUID = '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\'
TARGET = '\\Device\\HarddiskVolume23'
CONTRACT = 'artwork-win32-lexical-selection-v1'
ROW = '00000000-0000-4000-8000-000000000001'
OFFPAGE = '00000000-0000-4000-8000-000000000002'
OP = '00000000-0000-4000-8000-000000000003'


def stamp():
    return windows.WindowsRootStamp('win32', windows.WindowsIdentity('win32', 2 ** 64 - 1,
        bytes.fromhex('fedcba98765432100123456789abcdef')),
        windows.SelectorSnapshot('C:', GUID, TARGET, TARGET))


def inventory():
    return {'inventory_version': 1, 'library_id': 1, 'platform': 'win32',
        'resolver_contract': CONTRACT, 'roots': [
            {'root_id': 3, 'root_path': ROOT, 'browse_eligible': True},
            {'root_id': 7, 'root_path': 'D:\\OffPage', 'browse_eligible': False}]}


def observed():
    key = ('win32', 3, ROOT)
    root = resolution.RootObservation(key, stamp(), stamp())
    row = resolution.RowObservation(ROW, 2, 'album\\cover.jpg',
        ROOT + '\\album\\cover.jpg', ('album', 'cover.jpg'), 3, ROOT, key, 'regular')
    # The full observation vector contains an off-page item on the same root;
    # the complete inventory also includes an unused/noneligible root.
    other = replace(row, row_ref=OFFPAGE, local_album_id=4)
    expected = resolution.ExpectedSelection(3, ROOT, row.resolved_cover_path,
                                            row.relative_parts, stamp())
    request = resolution.ResolutionInput(OP, 'a' * 64, 'win32', CONTRACT,
        (resolution.RootInput(3, ROOT), resolution.RootInput(7, 'D:\\OffPage')),
        (resolution.RowInput(ROW, 2, row.stored_cover_path, expected),
         resolution.RowInput(OFFPAGE, 4, other.stored_cover_path, expected)))
    result = resolution.Success(OP, 'a' * 64, 'win32', CONTRACT,
        (row, other), (root,), resolution.WorkCounts())
    return request, result, row, root


def capture_value(descriptor):
    info = windows.WindowsObservation('win32', stamp().identity,
        windows.WindowsIdentity('win32', 2 ** 64 - 1, b'\xff' * 16), 123,
        -(2 ** 63), 2 ** 63 - 1, 'cover.jpg', '.jpg')
    # Proof consumes capture metadata; PNG decoding/container validation belongs
    # to capture and is independently covered by the capture suite.
    return facade.CapturedArtwork(descriptor, info, b'proof-only', 'a' * 64, 1, 1, 123, 4096)


def pair():
    _, _, row, root = observed()
    prepared = codec.prepare_inventory_binding(inventory())
    descriptor, source = proof.source_base(1, row, root, prepared)
    result = capture_value(descriptor)
    return prepared, descriptor, result, proof.captured_pair(result, source)


def rejected(call):
    with pytest.raises((tops.AlbumTopError, codec.InvalidArtworkProof,
                        facade.ArtworkAcquisitionUnavailable, resolution.ResolutionInputInvalid,
                        windows.WindowsUnavailable, TypeError, ValueError)):
        call()


def test_real_complete_inventory_draft_saved_canonical_parity(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError('pure proof attempted native work')
    monkeypatch.setattr(rooted, 'acquire', denied)
    prepared, descriptor, result, (source, acquisition, text) = pair()
    _, _, row, root = observed()
    saved_descriptor, saved_source = proof.windows_saved_source_base(1, row, root, prepared)
    assert saved_descriptor == descriptor and saved_source == source
    assert proof.windows_saved_captured_pair(result, saved_source) == (source, acquisition, text)
    checked_source, checked_acquisition = codec.validate_pair(source, acquisition)
    assert text == codec.canonical_source_bytes(checked_source).decode('ascii')
    assert len(text.encode('ascii')) <= 65536
    assert len(codec.canonical_acquisition_bytes(checked_acquisition)) <= 2048
    assert source['selection_context']['inventory_digest'] == codec.inventory_digest(inventory())
    assert source['root']['volume_serial'] == '18446744073709551615'
    assert source['root']['file_id'] == 'fedcba98765432100123456789abcdef'
    assert acquisition['file']['leaf_identity']['file_id'] == 'f' * 32
    assert acquisition['file']['last_write_time'] == '-9223372036854775808'
    assert acquisition['file']['change_time'] == '9223372036854775807'
    expected = resolution.ExpectedSelection(3, ROOT, descriptor.resolved_cover_path,
                                            descriptor.relative_parts, descriptor.root_stamp)
    binding = proof.ready_binding(source, acquisition, prepared, library_id=1, local_album_id=2)
    assert binding == (expected, codec.descriptor_digest(source),
        hashlib.sha256(codec.canonical_acquisition_bytes(acquisition)).hexdigest())
    assert proof.windows_saved_ready_binding(source, acquisition, prepared,
        library_id=1, local_album_id=2, stored_cover_path=descriptor.stored_cover_path) == binding


@pytest.mark.parametrize('change', ['offpage_path', 'offpage_eligibility', 'added_root',
    'selected_ineligible', 'selected_path', 'library', 'platform'])
def test_current_complete_inventory_binding_rejects_drift(change):
    _, _, _, (source, acquisition, _) = pair()
    value = inventory()
    if change == 'offpage_path':
        value['roots'][1]['root_path'] = 'D:\\Moved'
    elif change == 'offpage_eligibility':
        value['roots'][1]['browse_eligible'] = True
    elif change == 'added_root':
        value['roots'].append({'root_id': 9, 'root_path': 'E:\\New', 'browse_eligible': False})
    elif change == 'selected_ineligible':
        value['roots'][0]['browse_eligible'] = False
    elif change == 'selected_path':
        value['roots'][0]['root_path'] = 'C:\\Other'
    elif change == 'library':
        value['library_id'] = 2
    else:
        value.update(platform='posix', resolver_contract=resolution.CONTRACT)
    prepared = codec.prepare_inventory_binding(value)
    rejected(lambda: proof.ready_binding(source, acquisition, prepared, library_id=1, local_album_id=2))
    rejected(lambda: proof.windows_saved_ready_binding(source, acquisition, prepared,
        library_id=1, local_album_id=2, stored_cover_path=source['stored_cover_path']))


@pytest.mark.parametrize('field,value', [('library_id', True), ('library_id', 2),
    ('local_album_id', True), ('local_album_id', 4),
    ('stored_cover_path', 'ALBUM\\cover.jpg'), ('stored_cover_path', b'album\\cover.jpg')])
def test_saved_v2_exact_current_scope_and_cover(field, value):
    prepared, _, _, (source, acquisition, _) = pair()
    kwargs = dict(library_id=1, local_album_id=2, stored_cover_path=source['stored_cover_path'])
    kwargs[field] = value
    rejected(lambda: proof.windows_saved_ready_binding(source, acquisition, prepared, **kwargs))


def test_full_checked_observation_vector_keeps_offpage_expected_binding():
    request, result, row, root = observed()
    assert proof.checked_observations(result, request) == {
        ROW: (row, root), OFFPAGE: (result.rows[1], root)}
    changed = replace(result.rows[1], relative_parts=('else.jpg',),
                      resolved_cover_path=ROOT + '\\else.jpg')
    rejected(lambda: proof.checked_observations(replace(result, rows=(row, changed)), request))


@pytest.mark.parametrize('case', ['row_missing', 'row_duplicate', 'row_reordered', 'row_extra',
    'root_missing', 'root_unused', 'root_duplicate', 'root_reordered', 'ledger_list',
    'ledger_platform', 'ledger_bool_id', 'root_final', 'root_selector', 'root_posix',
    'request_platform', 'request_contract', 'result_platform', 'result_contract',
    'operation', 'snapshot', 'row_state', 'row_stored', 'row_resolved', 'row_parts_list'])
def test_complete_ledger_exact_types_order_and_expected_rejections(case):
    request, result, row, root = observed()
    if case == 'row_missing':
        result = replace(result, rows=(row,))
    elif case == 'row_duplicate':
        result = replace(result, rows=(row, row))
    elif case == 'row_reordered':
        result = replace(result, rows=tuple(reversed(result.rows)))
    elif case == 'row_extra':
        object.__setattr__(row, 'extra', 1)
    elif case == 'root_missing':
        result = replace(result, roots=())
    elif case in ('root_unused', 'root_reordered'):
        other_stamp = replace(stamp(), selector=replace(stamp().selector, drive='D:'))
        other = resolution.RootObservation(('win32', 7, 'D:\\OffPage'), other_stamp, other_stamp)
        result = replace(result, roots=(root, other) if case == 'root_unused' else (other, root))
    elif case == 'root_duplicate':
        result = replace(result, roots=(root, root))
    elif case.startswith('ledger_'):
        key = {'ledger_list': list(row.root_ledger_key),
               'ledger_platform': ('posix', 3, ROOT), 'ledger_bool_id': ('win32', True, ROOT)}[case]
        result = replace(result, rows=(replace(row, root_ledger_key=key), result.rows[1]))
    elif case in ('root_final', 'root_selector', 'root_posix'):
        if case == 'root_final':
            value = replace(stamp(), identity=replace(stamp().identity, file_id=b'x' * 16))
        elif case == 'root_selector':
            value = replace(stamp(), selector=replace(stamp().selector, guid_target='\\Device\\HarddiskVolume24'))
        else:
            value = rooted.PosixRootStamp('posix', 1, 2)
        result = replace(result, roots=(replace(root, final=value),))
    elif case.startswith('request_'):
        request = replace(request, **{'platform' if case == 'request_platform' else 'resolver_contract': 'posix'})
    elif case.startswith('result_'):
        result = replace(result, **{'platform' if case == 'result_platform' else 'resolver_contract': 'posix'})
    elif case == 'operation':
        result = replace(result, operation_ref=ROW)
    elif case == 'snapshot':
        result = replace(result, snapshot_digest='b' * 64)
    else:
        changes = {'row_state': {'leaf_state': 'directory'}, 'row_stored': {'stored_cover_path': 'other.jpg'},
            'row_resolved': {'resolved_cover_path': 'C:\\Other\\cover.jpg'},
            'row_parts_list': {'relative_parts': list(row.relative_parts)}}[case]
        result = replace(result, rows=(replace(row, **changes), result.rows[1]))
    rejected(lambda: proof.checked_observations(result, request))


@pytest.mark.parametrize('target,path,value', [
    ('source', ('extra',), 1), ('source', ('platform',), 'posix'),
    ('source', ('root', 'volume_serial'), 1), ('source', ('root', 'volume_serial'), '01'),
    ('source', ('root', 'file_id'), 'F' * 32), ('source', ('root', 'file_id'), 'f' * 31),
    ('source', ('root', 'selector', 'extra'), 1),
    ('source', ('root', 'selector', 'drive'), 'D:'),
    ('source', ('selection_context', 'resolver_contract'), resolution.CONTRACT),
    ('acquisition', ('extra',), 1), ('acquisition', ('platform',), 'posix'),
    ('acquisition', ('descriptor_digest',), '0' * 64),
    ('acquisition', ('file', 'root_identity', 'file_id'), '0' * 32),
    ('acquisition', ('file', 'leaf_identity', 'volume_serial'), '1'),
    ('acquisition', ('file', 'last_write_time'), 0),
    ('acquisition', ('file', 'last_write_time'), '-9223372036854775809'),
    ('acquisition', ('file', 'change_time'), '9223372036854775808'),
    ('acquisition', ('file', 'change_time'), '-0'),
    ('acquisition', ('input_bytes',), 122), ('acquisition', ('input_pixels',), True),
])
def test_real_codec_pair_rejects_noncanonical_unknown_or_mixed_fields(target, path, value):
    prepared, _, _, (source, acquisition, _) = pair()
    object_ = source if target == 'source' else acquisition
    for part in path[:-1]:
        object_ = object_[part]
    object_[path[-1]] = value
    rejected(lambda: codec.validate_pair(source, acquisition))
    rejected(lambda: proof.ready_binding(source, acquisition, prepared, library_id=1, local_album_id=2))


@pytest.mark.parametrize('case', ['source_extra', 'source_scope', 'source_stamp', 'source_subclass',
    'capture_subclass', 'observation_extra', 'observation_subclass', 'root_identity',
    'leaf_volume', 'size_bool', 'timestamp_bool', 'input_bytes', 'input_pixels'])
def test_capture_pair_exact_boundary(case):
    _, descriptor, result, (source, _, _) = pair()
    if case == 'source_extra':
        object.__setattr__(descriptor, 'extra', 1)
    elif case == 'source_scope':
        result = replace(result, source=replace(descriptor, local_album_id=5))
    elif case == 'source_stamp':
        result = replace(result, source=replace(descriptor, root_stamp=replace(stamp(),
            identity=replace(stamp().identity, file_id=b'x' * 16))))
    elif case == 'source_subclass':
        class Child(capture.WindowsArtworkSourceDescriptor):
            pass
        result = replace(result, source=Child(**descriptor.__dict__))
    elif case == 'capture_subclass':
        class Child(facade.CapturedArtwork):
            pass
        result = Child(**result.__dict__)
    elif case == 'observation_extra':
        object.__setattr__(result.file_observation, 'extra', 1)
    elif case == 'observation_subclass':
        class Child(windows.WindowsObservation):
            pass
        result = replace(result, file_observation=Child(**result.file_observation.__dict__))
    elif case in ('root_identity', 'leaf_volume', 'size_bool', 'timestamp_bool'):
        info = result.file_observation
        values = {'root_identity': {'root_identity': replace(info.root_identity, file_id=b'x' * 16)},
            'leaf_volume': {'leaf_identity': replace(info.leaf_identity, volume_serial=1)},
            'size_bool': {'size': True}, 'timestamp_bool': {'last_write_time': True}}
        result = replace(result, file_observation=replace(info, **values[case]))
    else:
        result = replace(result, **{case: 122 if case == 'input_bytes' else 16000001})
    rejected(lambda: proof.captured_pair(result, source))
    rejected(lambda: proof.windows_saved_captured_pair(result, source))


def test_nonidentity_original_names_do_not_change_proof():
    _, _, result, (source, acquisition, text) = pair()
    changed = replace(result, file_observation=replace(result.file_observation,
        original_name='different-name', original_suffix='.different'))
    assert proof.captured_pair(changed, source) == (source, acquisition, text)


def test_missing_tail_is_a_valid_selection_but_never_capture_evidence():
    _, _, row, root = observed()
    descriptor, value = proof.windows_saved_source_base(1, replace(row, leaf_state='missing_tail'),
        root, codec.prepare_inventory_binding(inventory()))
    assert descriptor.root_stamp == stamp() and value['descriptor_version'] == 2


LEGACY_SOURCE = {
    'library_id': 1, 'local_album_id': 2, 'artwork_root_id': 3,
    'artwork_root_path': '/music', 'stored_cover_path': 'album/cover.jpg',
    'resolved_cover_path': '/music/album/cover.jpg', 'relative_parts': ['album', 'cover.jpg'],
    'root_device': 2049, 'root_inode': 42,
}
LEGACY_ACQUISITION = {
    'file': {'device': 2049, 'inode': 43, 'size': 123,
             'mtime_ns': 1700000000000000000, 'ctime_ns': 1700000000000000001},
    'input_bytes': 123, 'input_pixels': 4096,
}


def test_legacy_saved_v1_literal_objects_return_arity_and_hash_vectors():
    key = ('posix', 3, '/music')
    stamp_ = rooted.PosixRootStamp('posix', 2049, 42)
    root = resolution.RootObservation(key, stamp_, stamp_)
    row = resolution.RowObservation(ROW, 2, 'album/cover.jpg', '/music/album/cover.jpg',
        ('album', 'cover.jpg'), 3, '/music', key, 'regular')
    descriptor, source = proof.saved_source_base(1, row, root)
    assert type(descriptor) is facade.ArtworkSourceDescriptor and source == LEGACY_SOURCE
    info = facade.ArtworkFileObservation(**LEGACY_ACQUISITION['file'])
    captured = facade.CapturedArtwork(descriptor, info, b'legacy', 'a' * 64, 1, 1, 123, 4096)
    result = proof.saved_captured_pair(captured, source)
    assert type(result) is tuple and len(result) == 2
    assert result == (LEGACY_SOURCE, LEGACY_ACQUISITION)
    bound = proof.saved_ready_binding(source, LEGACY_ACQUISITION,
        library_id=1, local_album_id=2, stored_cover_path='album/cover.jpg')
    assert bound[0] == resolution.ExpectedSelection(3, '/music', '/music/album/cover.jpg',
                                                  ('album', 'cover.jpg'), stamp_)
    assert bound[1:] == LEGACY_HASHES
    assert proof._SAVED_SOURCE_DOMAIN == b'AlbumHaven/saved-artwork-source-observation/v1\x00'
    assert proof._SAVED_ACQUISITION_DOMAIN == b'AlbumHaven/saved-artwork-acquisition-observation/v1\x00'


def test_saved_v1_and_windows_v2_entrypoints_are_not_interchangeable():
    prepared, _, result, (source, acquisition, _) = pair()
    rejected(lambda: proof.saved_captured_pair(result, source))
    rejected(lambda: proof.saved_ready_binding(source, acquisition,
        library_id=1, local_album_id=2, stored_cover_path=source['stored_cover_path']))
    rejected(lambda: proof.windows_saved_ready_binding(LEGACY_SOURCE, LEGACY_ACQUISITION,
        prepared, library_id=1, local_album_id=2, stored_cover_path='album/cover.jpg'))


def test_legacy_helper_bodies_are_byte_identical_to_frozen_reference():
    text = Path(proof.__file__).read_text(encoding='utf-8')
    tree = ast.parse(text)
    for name, digest in LEGACY_BODY_HASHES.items():
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
        assert hashlib.sha256(ast.get_source_segment(text, node).encode('utf-8')).hexdigest() == digest


def test_application_callers_remain_dormant_posix_and_saved_v1():
    folder = Path(proof.__file__).parent
    draft = (folder / 'album_top_artwork_draft.py').read_text(encoding='utf-8')
    phases = (folder / '_top_artwork_preparation_phases.py').read_text(encoding='utf-8')
    saved = (folder / '_top_artwork_saved.py').read_text(encoding='utf-8')
    for text in (draft, phases, saved):
        assert 'windows_saved_' not in text
        assert 'WindowsArtworkSourceDescriptor' not in text
    assert "'posix'" in draft
    assert 'saved_ready_binding' in phases
    assert 'saved_captured_pair' in phases
    for module in (capture, proof, facade):
        tree = ast.parse(Path(module.__file__).read_text(encoding='utf-8'))
        imports = [n for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))]
        assert not any(isinstance(n, ast.ImportFrom) and n.module and
                       ('config' in n.module or 'database' in n.module) for n in imports)


LEGACY_HASHES = ('f92d4f88db15f9ceea6f71b2b864828a1b6d27b021af80c9e2b6895185e0147c', 'f652f1501c4afceb1c9208390b7f67767ab7a19e185f820a2228312066a0493a')
LEGACY_BODY_HASHES = {'_legacy_source': '0889f0b6434335ace61b978a87567f5cdba494948e627380453fe4c7f901dd6f', '_bounded_legacy_bytes': 'ba70cf6f3ace821b7842b3e740acadc1a24f44d235dc6233dc5d707e483b8e8d', 'saved_ready_binding': '19674ff57c3da51e35640262daf3480fa5bf5e716158961ff4e3a2e184532c1f', 'saved_source_base': '0e11a7efa44aea6f11016b4b907b4ae7b4c91e1fc5110cc298f2c5b7c582a1e9', 'saved_captured_pair': 'fee3cfe7401ae27e47a7c1f80dbce89634a655ae7d820f759cd99126d91167db'}
