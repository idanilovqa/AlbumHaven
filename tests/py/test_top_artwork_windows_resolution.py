"""W2 immutable full-vector resolver and shared-owner synthetic contracts.

Source-authored only. Synthetic events are not genuine Windows acceptance.
No app, configuration, database, decoder, native DLL or byte capture is used.
"""
SUITE_NAME = 'test_top_artwork_windows_resolution.py'

import gc
import importlib
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import weakref

import pytest


def _checkout_imports():
    here = Path(__file__).resolve(strict=True)
    if here.parts[-3:] != ('tests', 'py', SUITE_NAME):
        raise AssertionError('unexpected synthetic suite origin')
    root = here.parents[2]
    names = ('rooted_local_file', '_rooted_local_file_windows',
             '_top_artwork_resolution', '_top_artwork_resolution_windows')
    expected = {'music_app': root / 'music_app/__init__.py',
                'music_app.services': root / 'music_app/services/__init__.py'}
    expected.update({'music_app.services.' + name: root / ('music_app/services/' + name + '.py')
                     for name in names})
    if not all(path.is_file() for path in expected.values()):
        raise AssertionError('incomplete trusted checkout')
    # Repository suites may share collection with legitimate app fixtures.
    # Verify only these fixed dependency origins; local no-config isolation is
    # the separately reviewed execution command's responsibility.
    for name, path in expected.items():
        module = sys.modules.get(name)
        if module is not None and (not getattr(module, '__file__', None)
                or Path(module.__file__).resolve(strict=True) != path):
            raise AssertionError('unexpected fixed dependency origin')
    inserted = str(root) not in sys.path
    if inserted:
        sys.path.insert(0, str(root))
    try:
        result = tuple(importlib.import_module('music_app.services.' + name) for name in names)
        for name, path in expected.items():
            if Path(sys.modules[name].__file__).resolve(strict=True) != path:
                raise AssertionError('product import escaped trusted checkout')
    finally:
        if inserted:
            sys.path.remove(str(root))
    return result


rooted, windows, resolver, winresolver = _checkout_imports()


from concurrent.futures import Future
from dataclasses import FrozenInstanceError, fields, replace

CONTRACT = 'artwork-win32-lexical-selection-v1'
GUID = '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\'
TARGET = '\\Device\\HarddiskVolume23'
ROOT = 'C:\\Music'
WAIT = 5
MAX_PAYLOAD = 32 * 1024 * 1024


def uid(number=1):
    return f'00000000-0000-0000-0000-{number:012x}'


def stamp(root=ROOT, *, serial=2 ** 64 - 1, number=2 ** 128 - 1):
    return windows.WindowsRootStamp('win32', windows.WindowsIdentity(
        'win32', serial, number.to_bytes(16, 'little')),
        windows.SelectorSnapshot(root[:2], GUID, TARGET, TARGET))


def request(roots=(ROOT,), covers=('cover.png',), *, expected=None, platform='win32'):
    return resolver.ResolutionInput(uid(), 'a' * 64, platform,
        CONTRACT if platform == 'win32' else resolver.CONTRACT,
        tuple(resolver.RootInput(i + 1, path) for i, path in enumerate(roots)),
        tuple(resolver.RowInput(uid(i + 2), i + 1, cover,
                               expected if i == 0 else None)
              for i, cover in enumerate(covers)), 1)


def expectation(root=ROOT, relative=('cover.png',), *, root_id=1):
    return resolver.ExpectedSelection(root_id, root, root.rstrip('\\') + '\\' + '\\'.join(relative),
                                      relative, stamp(root))


def context():
    return winresolver._Context(10.0, lambda: False, clock=lambda: 0.0)


def legal_path(size, *, absolute=True):
    """Exact ASCII byte size with real <=255-unit legal Windows components."""
    prefix = 'C:\\' if absolute else ''
    remaining = size - len(prefix)
    assert remaining >= 1
    parts = []
    while remaining > 255:
        take = min(255, remaining - 2)
        parts.append('x' * take)
        remaining -= take + 1
    parts.append('x' * remaining)
    result = prefix + '\\'.join(parts)
    assert len(result.encode('utf-8')) == size and all(1 <= len(p) <= 255 for p in parts)
    assert len(parts) <= 256
    return result


def assert_failure(result, code, *, complete=None):
    assert type(result) is resolver.Failure and result.error_code == code
    assert not hasattr(result, 'rows') and not hasattr(result, 'roots')
    assert {field.name for field in fields(result)} == {
        'operation_ref', 'snapshot_digest', 'platform', 'resolver_contract',
        'error_code', 'counts', 'counts_complete'}
    if complete is not None:
        assert result.counts_complete is complete
    assert result.counts.combined_work == (result.counts.components +
        result.counts.syscalls + result.counts.expansions)


class Observations:
    """Resolver-only fixed observation seam; no native provenance is asserted.

    Input copying, selection, vector iteration, expected binding, budgets and
    output construction are real. The other NEW suite covers actual call sites.
    """
    def __init__(self, monkeypatch):
        monkeypatch.setattr(winresolver, 'sys', SimpleNamespace(platform='win32'))
        self.roots, self.rows = [], []
        self.values, self.fail, self.states = {}, set(), {}
        self.on_root = lambda selection, ordinal: None
        self.on_row = lambda selection, ordinal: None
        monkeypatch.setattr(winresolver, 'observe_root', self.root)
        monkeypatch.setattr(winresolver, 'observe_selection', self.row)
    def root(self, selection, *, operation_context):
        assert type(selection) is rooted.RootObservationSelection
        assert selection.platform == 'win32'
        operation_context.check()
        self.roots.append((selection, operation_context))
        self.on_root(selection, len(self.roots))
        if selection.root_path in self.fail:
            raise windows.WindowsUnavailable('windows_native_open_failed')
        return self.values.get(selection.root_path, stamp(selection.root_path))
    def row(self, selection, expected_root_stamp=None, *, operation_context):
        assert type(selection) is rooted.RootSelection and selection.platform == 'win32'
        operation_context.check()
        self.rows.append((selection, expected_root_stamp, operation_context))
        self.on_row(selection, len(self.rows))
        current = self.values.get(selection.root_path, stamp(selection.root_path))
        if expected_root_stamp != current:
            raise windows.WindowsUnavailable('windows_root_changed')
        if selection.root_path in self.fail:
            raise windows.WindowsUnavailable('windows_native_open_failed')
        return windows.WindowsSelectionObservation('win32', current,
            self.states.get((selection.root_path, selection.relative_parts), 'regular'))


def run(value):
    return winresolver._run(winresolver._validate(value), context())


@pytest.mark.parametrize('count', [0, 1, 1024, 1025])
def test_root_vector_admits_exact_ceiling_before_io(monkeypatch, count):
    observation = Observations(monkeypatch)
    value = request(tuple('C:\\r' + str(i) for i in range(count)), ())
    if count == 1025:
        with pytest.raises(resolver.ResolutionInputInvalid):
            winresolver._validate(value)
    else:
        copied = winresolver._validate(value)
        assert len(copied.roots) == count
    assert observation.roots == observation.rows == []


@pytest.mark.parametrize('count', [0, 1, 5000, 5001])
def test_row_vector_admits_exact_ceiling_before_io(monkeypatch, count):
    observation = Observations(monkeypatch)
    value = request(covers=('cover.png',) * count)
    if count == 5001:
        with pytest.raises(resolver.ResolutionInputInvalid):
            winresolver._validate(value)
    else:
        copied = winresolver._validate(value)
        assert len(copied.rows) == count
    assert observation.roots == observation.rows == []


@pytest.mark.parametrize('field,value', [
    ('operation_ref', '00000000-0000-0000-0000-000000000000'),
    ('operation_ref', 'A' * 36), ('snapshot_digest', 'A' * 64),
    ('snapshot_digest', 'a' * 63), ('platform', 'posix'), ('platform', True),
    ('resolver_contract', 'artwork-posix-bounded-selection-v1'),
    ('resolver_contract', 'artwork-win32-lexical-selection-v2'),
    ('ceilings_version', True), ('ceilings_version', 2),
    ('roots', []), ('rows', []),
])
def test_closed_header_rejected_before_observation(monkeypatch, field, value):
    observed = Observations(monkeypatch)
    with pytest.raises(resolver.ResolutionInputInvalid):
        winresolver._validate(replace(request(), **{field: value}))
    assert observed.roots == observed.rows == []


@pytest.mark.parametrize('path', ['\\\\server\\share', '\\\\?\\C:\\Music',
    '\\\\.\\C:\\Music', 'C:Music', '\\Music', 'C:/Music', 'C:\\Music\\',
    'C:\\Music\\..', 'C:\\Music\\.', 'C:\\Music:stream', 'C:\\Mu*ic',
    'C:\\Mu?ic', 'C:\\NUL', 'C:\\CON.txt', 'C:\\COM1', 'C:\\LPT¹.txt',
    'C:\\Music.', 'C:\\Music ', 'C:\\a\0b', 'C:\\a\ud800b'])
def test_windows_root_grammar_is_exact_and_has_no_normalization(monkeypatch, path):
    observed = Observations(monkeypatch)
    with pytest.raises(resolver.ResolutionInputInvalid):
        winresolver._validate(request((path,)))
    assert observed.roots == observed.rows == []


@pytest.mark.parametrize('path', ['', '.', '..', 'a\\..\\b', 'a/cover.png',
    '\\cover.png', 'C:cover.png', 'cover.png:stream', 'a\\\\b', 'a\\',
    'NUL.png', 'COM¹.txt', 'cover.png ', 'cover.png.', 'a\n.png', '\udfff'])
def test_stored_path_rejects_ambient_or_ambiguous_grammar(monkeypatch, path):
    observed = Observations(monkeypatch)
    with pytest.raises(resolver.ResolutionInputInvalid):
        winresolver._validate(request(covers=(path,)))
    assert observed.roots == observed.rows == []


@pytest.mark.parametrize('field,size,valid', [('root', 8192, True), ('root', 8193, False),
    ('stored', 16384, True), ('stored', 16385, False)])
def test_strict_utf8_path_limit_equal_and_one_over(field, size, valid):
    path = legal_path(size, absolute=field == 'root')
    value = request((path,), ()) if field == 'root' else request(covers=(path,))
    if valid:
        assert winresolver._validate(value)
    else:
        with pytest.raises(resolver.ResolutionInputInvalid):
            winresolver._validate(value)


@pytest.mark.parametrize('part,valid', [('x' * 255, True), ('x' * 256, False),
    ('😀' * 127 + 'x', True), ('😀' * 128, False)])
def test_component_utf16_limit_does_not_count_python_characters(part, valid):
    value = request(covers=(part,))
    if valid:
        assert winresolver._validate(value).rows[0].stored_cover_path == part
    else:
        with pytest.raises(resolver.ResolutionInputInvalid):
            winresolver._validate(value)


@pytest.mark.parametrize('count,valid', [(255, True), (256, True), (257, False)])
def test_component_vector_limit_is_bounded_before_admission(count, valid):
    value = request(covers=('\\'.join('x' for _ in range(count)),))
    if valid:
        assert winresolver._validate(value)
    else:
        with pytest.raises(resolver.ResolutionInputInvalid):
            winresolver._validate(value)


@pytest.mark.parametrize('target', ['request', 'root', 'row', 'expected', 'stamp', 'identity', 'selector'])
@pytest.mark.parametrize('fault', ['extra_field', 'subclass'])
def test_every_nested_record_is_exact_closed_type(target, fault):
    value = request(expected=expectation())
    row = value.rows[0]
    objects = {'request': value, 'root': value.roots[0], 'row': row,
        'expected': row.expected, 'stamp': row.expected.root_stamp,
        'identity': row.expected.root_stamp.identity, 'selector': row.expected.root_stamp.selector}
    selected = objects[target]
    if fault == 'extra_field':
        object.__setattr__(selected, 'unauthorized', 1)
    else:
        child = type('MutableSubclass', (type(selected),), {})
        replacement = child(**selected.__dict__)
        if target == 'request':
            value = replacement
        elif target == 'root':
            value = replace(value, roots=(replacement,))
        elif target == 'row':
            value = replace(value, rows=(replacement,))
        elif target == 'expected':
            value = replace(value, rows=(replace(row, expected=replacement),))
        elif target == 'stamp':
            value = replace(value, rows=(replace(row, expected=replace(row.expected, root_stamp=replacement)),))
        else:
            root_stamp = replace(row.expected.root_stamp, **{target: replacement})
            value = replace(value, rows=(replace(row, expected=replace(row.expected, root_stamp=root_stamp)),))
    with pytest.raises(resolver.ResolutionInputInvalid):
        winresolver._validate(value)


@pytest.mark.parametrize('target,value', [('serial', True), ('serial', -1), ('serial', 2 ** 64),
    ('file_id', bytearray(16)), ('file_id', b'x' * 15), ('file_id', b'x' * 17),
    ('identity_platform', 'posix'), ('stamp_platform', 'posix'),
    ('drive', 'c:'), ('volume_guid', '\\\\?\\Volume{invalid}\\'),
    ('drive_target', '\\Device\\HarddiskVolume24'), ('guid_target', '\\Device\\HarddiskVolume24')])
def test_expected_windows_identity_and_selector_are_not_posix_placeholders(target, value):
    expected = expectation()
    if target in ('serial', 'file_id', 'identity_platform'):
        field = {'serial': 'volume_serial', 'identity_platform': 'platform'}.get(target, target)
        changed = replace(expected.root_stamp.identity, **{field: value})
        root_stamp = replace(expected.root_stamp, identity=changed)
    elif target == 'stamp_platform':
        root_stamp = replace(expected.root_stamp, platform=value)
    else:
        root_stamp = replace(expected.root_stamp, selector=replace(expected.root_stamp.selector, **{target: value}))
    with pytest.raises(resolver.ResolutionInputInvalid):
        winresolver._validate(request(expected=replace(expected, root_stamp=root_stamp)))


def test_copied_nested_graph_is_immune_to_later_frozen_record_bypass():
    original = request(expected=expectation())
    copied = winresolver._validate(original)
    assert copied == original and copied is not original
    assert copied.roots[0] is not original.roots[0]
    assert copied.rows[0] is not original.rows[0]
    assert copied.rows[0].expected.root_stamp is not original.rows[0].expected.root_stamp
    assert copied.rows[0].expected.root_stamp.identity is not original.rows[0].expected.root_stamp.identity
    assert copied.rows[0].expected.root_stamp.selector is not original.rows[0].expected.root_stamp.selector
    object.__setattr__(original.rows[0].expected.root_stamp.identity, 'volume_serial', 0)
    object.__setattr__(original.rows[0].expected.root_stamp.selector, 'drive_target', '\\Device\\HarddiskVolume99')
    object.__setattr__(original.rows[0], 'stored_cover_path', 'changed.png')
    object.__setattr__(original.roots[0], 'root_path', 'C:\\Changed')
    assert copied == request(expected=expectation())
    with pytest.raises(FrozenInstanceError):
        copied.rows[0].stored_cover_path = 'changed.png'


@pytest.mark.parametrize('stored', ['cover.png', 'C:\\Music\\cover.png'])
@pytest.mark.parametrize('state', ['regular', 'missing_tail'])
def test_full_width_identity_and_missing_observation_are_preserved(monkeypatch, stored, state):
    observed = Observations(monkeypatch)
    observed.states[(ROOT, ('cover.png',))] = state
    value = request(covers=(stored,), expected=expectation())
    result = run(value)
    assert type(result) is resolver.Success
    assert result.platform == 'win32' and result.resolver_contract == CONTRACT
    row, = result.rows
    ledger, = result.roots
    assert row.stored_cover_path == stored and row.resolved_cover_path == ROOT + '\\cover.png'
    assert row.relative_parts == ('cover.png',) and row.leaf_state == state
    assert row.root_ledger_key == ledger.root_ledger_key == ('win32', 1, ROOT)
    assert ledger.initial == ledger.final == stamp()
    assert ledger.initial.identity.volume_serial == 2 ** 64 - 1
    assert ledger.initial.identity.file_id == b'\xff' * 16
    assert len(observed.roots) == 2 and len(observed.rows) == 1
    assert result.counts.candidates == 1 and result.counts.expansions == 0
    assert not hasattr(row, 'body') and not hasattr(row, 'proof')


@pytest.mark.parametrize('roots,stored,selected', [
    (('C:\\', 'C:\\Music', 'C:\\Music\\Albums'), 'C:\\Music\\Albums\\cover.png', 3),
    (('C:\\Music', 'C:\\Music'), 'C:\\Music\\cover.png', 1),
    (('C:\\Music', 'C:\\Music2'), 'C:\\Music2\\cover.png', 2),
    (('C:\\Music', 'c:\\Music'), 'c:\\Music\\cover.png', 2),
])
def test_most_specific_root_exact_boundaries_and_lowest_id_tie(monkeypatch, roots, stored, selected):
    observed = Observations(monkeypatch)
    result = run(request(roots, (stored,)))
    assert result.rows[0].root_id == selected
    assert result.rows[0].root_path == roots[selected - 1]
    assert [x.root_ledger_key[1] for x in result.roots] == [selected]
    assert {selection.root_path for selection, ctx in observed.roots} == {roots[selected - 1]}


@pytest.mark.parametrize('roots,stored', [
    (('C:\\Music',), 'C:\\Music'),
    (('C:\\', 'C:\\Music\\cover.png'), 'C:\\Music\\cover.png'),
    (('C:\\Music',), 'C:\\Musical\\cover.png'),
    (('C:\\Music',), 'c:\\Music\\cover.png'),
])
def test_equal_leaf_or_nonmatching_root_never_falls_back(monkeypatch, roots, stored):
    observed = Observations(monkeypatch)
    with pytest.raises(resolver._Stop, match='artwork_unavailable'):
        run(request(roots, (stored,)))
    assert observed.rows == [] and observed.roots == []


def test_more_specific_policy_denied_root_is_not_removed_for_ancestor_fallback(monkeypatch):
    observed = Observations(monkeypatch)
    roots = ('C:\\Music', 'C:\\Music\\Private')
    observed.fail.add(roots[1])
    value = request(roots, ('C:\\Music\\Private\\cover.png',))
    assert tuple(root.root_path for root in winresolver._validate(value).roots) == roots
    with pytest.raises(resolver._Stop, match='artwork_unavailable'):
        run(value)
    assert [selection.root_path for selection, ctx in observed.roots] == [roots[1]]
    assert observed.rows == []


@pytest.mark.parametrize('roots', [('C:\\Music', 'D:\\Other'),
                                  ('C:\\Music', 'C:\\Music\\Private')])
@pytest.mark.parametrize('state', ['regular', 'missing_tail'])
def test_distinct_relative_candidates_are_ambiguous_even_without_readable_pixels(monkeypatch, roots, state):
    observed = Observations(monkeypatch)
    for root in roots:
        observed.states[(root, ('cover.png',))] = state
    value = winresolver._validate(request(roots, ('cover.png',)))
    ctx = context()
    with pytest.raises(resolver._Stop, match='artwork_unavailable'):
        winresolver._run(value, ctx)
    assert ctx.counts().candidates == len(roots)
    assert observed.rows == observed.roots == []


@pytest.mark.parametrize('changed', ['serial_high_bit', 'file_id_high_bit', 'selector_guid', 'selector_target'])
def test_final_all_root_reobservation_detects_complete_stamp_drift(monkeypatch, changed):
    observed = Observations(monkeypatch)
    original = stamp()
    if changed == 'serial_high_bit':
        altered = replace(original, identity=replace(original.identity, volume_serial=2 ** 63 - 1))
    elif changed == 'file_id_high_bit':
        altered = replace(original, identity=replace(original.identity, file_id=(2 ** 127 - 1).to_bytes(16, 'little')))
    elif changed == 'selector_guid':
        altered = replace(original, selector=replace(original.selector,
            volume_guid='\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdee}\\'))
    else:
        altered = replace(original, selector=replace(original.selector,
            drive_target='\\Device\\HarddiskVolume24', guid_target='\\Device\\HarddiskVolume24'))
    def drift(selection, ordinal):
        if ordinal == 2:
            observed.values[ROOT] = altered
    observed.on_root = drift
    with pytest.raises(resolver._Stop, match='artwork_source_changed'):
        run(request())
    assert len(observed.rows) == 1 and len(observed.roots) == 2


@pytest.mark.parametrize('field', ['root_id', 'root_path', 'resolved_cover_path',
                                  'relative_parts', 'root_stamp'])
def test_off_page_expected_selection_drift_aborts_whole_vector(monkeypatch, field):
    observed = Observations(monkeypatch)
    roots = (ROOT, 'C:\\Other')
    values = {'root_id': 2, 'root_path': 'C:\\Other',
              'resolved_cover_path': ROOT + '\\changed.png',
              'relative_parts': ('changed.png',), 'root_stamp': stamp(number=2 ** 127)}
    expected = expectation()
    if field == 'root_path':
        expected = expectation('C:\\Other')
    elif field in ('resolved_cover_path', 'relative_parts'):
        expected = expectation(relative=('changed.png',))
    else:
        expected = replace(expected, **{field: values[field]})
    value = request(roots, (ROOT + '\\first.png', ROOT + '\\cover.png'))
    value = replace(value, rows=(value.rows[0], replace(value.rows[1], expected=expected)))
    with pytest.raises(resolver._Stop, match='artwork_source_changed'):
        run(value)
    assert len(observed.rows) == 1  # The later row is checked, never just a visible page.
    assert len(observed.roots) == 1


def test_rows_keep_input_order_and_ledger_final_checks_sort_all_selected_root_ids(monkeypatch):
    observed = Observations(monkeypatch)
    roots = ('C:\\First', 'C:\\Second', 'C:\\Third')
    covers = (roots[2] + '\\x.png', roots[0] + '\\y.png', roots[1] + '\\z.png', roots[2] + '\\q.png')
    value = request(roots, covers)
    result = run(value)
    assert tuple(row.row_ref for row in result.rows) == tuple(row.row_ref for row in value.rows)
    assert tuple(row.root_id for row in result.rows) == (3, 1, 2, 3)
    assert tuple(entry.root_ledger_key[1] for entry in result.roots) == (1, 2, 3)
    assert [selection.root_path for selection, ctx in observed.roots] == [
        roots[2], roots[0], roots[1], roots[0], roots[1], roots[2]]
    final_starts = []
    observed = Observations(monkeypatch)
    observed.on_root = lambda selection, ordinal: final_starts.append(len(observed.rows)) if ordinal > 3 else None
    run(value)
    assert final_starts == [4, 4, 4]


@pytest.mark.parametrize('extra', [0, 1])
def test_candidate_aggregate_exact_limit_and_plus_one_before_avoidable_work(monkeypatch, extra):
    observed = Observations(monkeypatch)
    roots = (ROOT,) * 1024  # Distinct IDs, same exact path: one candidate identity.
    covers = ('cover.png',) * 16 + ((ROOT + '\\last.png',) if extra else ())
    value = request(roots, covers)
    if extra:
        def forbidden_owner():
            raise AssertionError('over-limit vector submitted avoidable work')
        monkeypatch.setattr(resolver, '_owner', None)
        monkeypatch.setattr(resolver, '_owner_failed', False)
        monkeypatch.setattr(resolver, '_ProbeOwner', forbidden_owner)
        result = resolver.resolve(value)
        assert_failure(result, 'artwork_validation_limit', complete=True)
        assert result.counts.candidates == 0 and observed.rows == observed.roots == []
    else:
        result = run(value)
        assert result.counts.candidates == 16384 and len(result.rows) == 16
        assert len(result.roots) == 1 and result.rows[0].root_id == 1


@pytest.mark.parametrize('extra', [0, 1])
def test_unique_root_components_exact_limit_and_one_over(monkeypatch, extra):
    observed = Observations(monkeypatch)
    roots = tuple('C:\\' + '\\'.join((f'r{i}',) + ('x',) * 7)
                  for i in range(1024))
    if extra:
        roots = roots[:-1] + (roots[-1] + '\\extra',)
    covers = tuple(root + '\\cover.png' for root in roots)
    ctx = context()
    if extra:
        with pytest.raises(resolver._Stop, match='artwork_validation_limit'):
            winresolver._run(winresolver._validate(request(roots, covers)), ctx)
        assert ctx.counts().unique_root_components == 8184
        assert len(observed.rows) == 1023
    else:
        result = winresolver._run(winresolver._validate(request(roots, covers)), ctx)
        assert result.counts.unique_root_components == 8192
        assert len(result.rows) == len(result.roots) == 1024


@pytest.mark.parametrize('extra', [0, 1])
def test_full_vector_combined_component_work_equality_and_one_over(monkeypatch, extra):
    observed = Observations(monkeypatch)
    ctx = context()
    value = winresolver._validate(request(covers=(ROOT + '\\cover.png',)))
    # Isolate aggregate accounting with already-admitted preceding work. The
    # two actual remaining lexical components are charged by the real runner.
    ctx.syscalls = 262142 + extra
    if extra:
        with pytest.raises(resolver._Stop, match='artwork_validation_limit'):
            winresolver._run(value, ctx)
        assert observed.rows == observed.roots == []
    else:
        result = winresolver._run(value, ctx)
        assert result.counts.combined_work == 262144 and result.counts.components == 2
        assert len(result.rows) == 1
    assert ctx.counts().combined_work == 262144


def input_bytes(value):
    """Independent documented admission accounting, not a product budget shim."""
    total = 512 + sum(len(root.root_path.encode('utf-8')) + 128 for root in value.roots)
    for row in value.rows:
        total += len(row.stored_cover_path.encode('utf-8')) + 256
        if row.expected is not None:
            item = row.expected
            total += (len(item.root_path.encode('utf-8')) +
                len(item.resolved_cover_path.encode('utf-8')) +
                sum(4 + len(part.encode('utf-8')) for part in item.relative_parts) +
                256 + stamp_bytes(item.root_stamp))
    return total


def text_bytes(value):
    return 4 + len(value.encode('utf-8'))


def stamp_bytes(value):
    return (text_bytes(value.platform) + text_bytes(value.identity.platform) + 8 + 16 +
        sum(text_bytes(item) for item in (value.selector.drive, value.selector.volume_guid,
            value.selector.drive_target, value.selector.guid_target)))


def key_bytes(root):
    return 4 + text_bytes('win32') + 8 + text_bytes(root)


def output_bytes(value, states):
    """One selected root; charge repeated fields even when strings are shared."""
    root = value.roots[0].root_path
    total = (1 + sum(text_bytes(item) for item in (value.operation_ref,
        value.snapshot_digest, value.platform, value.resolver_contract)) + 8 + 64)
    total += key_bytes(root) + 2 * stamp_bytes(stamp(root))
    for row, state in zip(value.rows, states, strict=True):
        leaf = row.stored_cover_path[len(root) + 1:]
        assert '\\' not in leaf
        total += (text_bytes(row.row_ref) + 8 + 2 * text_bytes(row.stored_cover_path) +
            4 + text_bytes(leaf) + 8 + text_bytes(root) + key_bytes(root) + text_bytes(state))
    return total


@pytest.mark.parametrize('with_expected', [False, True])
@pytest.mark.parametrize('extra', [0, 1])
def test_real_32_mib_input_equal_and_one_byte_over_before_io(monkeypatch, with_expected, extra):
    observed = Observations(monkeypatch)
    count, target = 4096, MAX_PAYLOAD + extra
    expected = expectation() if with_expected else None
    # Fixed 4096 rows, one root and at most two real legal path strings. No
    # encoder, sparse length lie, limit override, unbounded search or skip.
    baseline = request(covers=('a',) * count)
    if expected is not None:
        baseline = replace(baseline, rows=tuple(replace(row, expected=expected)
                                                for row in baseline.rows))
    fixed = input_bytes(baseline) - count
    width, remainder = divmod(target - fixed, count)
    assert 1 <= width <= width + 1 <= 16384
    paths = (legal_path(width, absolute=False), legal_path(width + 1, absolute=False))
    value = replace(baseline, rows=tuple(replace(row,
        stored_cover_path=paths[int(index < remainder)]) for index, row in enumerate(baseline.rows)))
    assert input_bytes(value) == target
    if extra:
        with pytest.raises(resolver.ResolutionInputInvalid):
            winresolver._validate(value)
    else:
        copied = winresolver._validate(value)
        assert input_bytes(copied) == MAX_PAYLOAD and len(copied.rows) == count
        if with_expected:
            assert all(row.expected.root_stamp == stamp() for row in copied.rows)
            assert copied.rows[0].expected.root_stamp is not expected.root_stamp
    assert observed.roots == observed.rows == []


def output_boundary(target):
    """Bounded constructive fixture: <=8192 scalar trials, 5000 actual rows.

    Each unique leaf starts with its four-digit row index. Increasing a leaf
    byte costs three output bytes. Up to two genuine missing-tail observations
    adjust the residue by five bytes each. No output helper is stubbed.
    """
    count = 5000
    header = 1 + sum(text_bytes(item) for item in (uid(), 'a' * 64, 'win32', CONTRACT)) + 8 + 64
    selected = None
    for root_length in range(4, 8193):
        # ASCII root of this length, fixed 4-byte leaf and regular state.
        base = header + (25 + root_length) + 2 * stamp_bytes(stamp()) + count * (126 + 4 * root_length)
        for missing in (0, 1, 2):
            spare = target - base - 5 * missing
            if spare >= 0 and spare % 3 == 0 and spare // 3 <= count * 251:
                selected = root_length, missing, spare // 3
                break
        if selected is not None:
            break
    assert selected is not None, 'bounded real-output fixture has no exact solution'
    root_length, missing, padding = selected
    root = legal_path(root_length)
    per_row, remainder = divmod(padding, count)
    covers = tuple(root + '\\' + f'{index:04x}' + 'x' * (per_row + int(index < remainder))
                   for index in range(count))
    states = tuple('missing_tail' if index < missing else 'regular' for index in range(count))
    value = request((root,), covers)
    assert input_bytes(value) < MAX_PAYLOAD
    assert output_bytes(value, states) == target
    assert all(len(cover.rsplit('\\', 1)[1]) <= 255 for cover in covers)
    return value, states


@pytest.mark.parametrize('extra', [0, 1])
def test_real_32_mib_output_equal_and_one_byte_over_no_partial_success(monkeypatch, extra):
    observed = Observations(monkeypatch)
    value, states = output_boundary(MAX_PAYLOAD + extra)
    root = value.roots[0].root_path
    for row, state in zip(value.rows, states, strict=True):
        observed.states[(root, (row.stored_cover_path[len(root) + 1:],))] = state
    copied = winresolver._validate(value)
    ctx = context()
    if extra:
        with pytest.raises(resolver._Stop, match='artwork_validation_limit'):
            winresolver._run(copied, ctx)
        assert len(observed.rows) == 5000 and len(observed.roots) == 1
    else:
        result = winresolver._run(copied, ctx)
        assert type(result) is resolver.Success and len(result.rows) == 5000
        assert tuple(row.leaf_state for row in result.rows) == states
        assert len(result.roots) == 1 and len(observed.roots) == 2
        assert output_bytes(value, states) == MAX_PAYLOAD
    assert ctx.counts().candidates == 5000 and ctx.counts().expansions == 0


@pytest.mark.parametrize('extra', [0, 1])
def test_combined_root_relative_components_equal_and_one_over(monkeypatch, extra):
    observed = Observations(monkeypatch)
    root = 'C:\\' + '\\'.join(('x',) * 128)
    relative = '\\'.join(('y',) * (128 + extra))
    value = winresolver._validate(request((root,), (relative,)))
    if extra:
        with pytest.raises(resolver._Stop, match='artwork_validation_limit'):
            winresolver._run(value, context())
        assert observed.roots == observed.rows == []
    else:
        result = winresolver._run(value, context())
        assert result.counts.components == 256 and result.counts.candidates == 1
        assert len(result.rows[0].relative_parts) == 128


@pytest.mark.parametrize('field,bad', [('root_id', True), ('root_id', 0),
    ('local_album_id', True), ('local_album_id', -1), ('row_ref', 'A' * 36)])
def test_exact_identifier_fields_reject_bool_nonpositive_and_noncanonical(field, bad):
    value = request()
    if field == 'root_id':
        value = replace(value, roots=(replace(value.roots[0], root_id=bad),))
    else:
        value = replace(value, rows=(replace(value.rows[0], **{field: bad}),))
    with pytest.raises(resolver.ResolutionInputInvalid):
        winresolver._validate(value)


@pytest.mark.parametrize('kind', ['duplicate_root_id', 'decreasing_root_id', 'duplicate_row_ref'])
def test_full_vector_identity_uniqueness_and_root_order(kind):
    value = request((ROOT, 'C:\\Other'), ('a', 'b'))
    if kind == 'duplicate_root_id':
        value = replace(value, roots=(value.roots[0], replace(value.roots[1], root_id=1)))
    elif kind == 'decreasing_root_id':
        value = replace(value, roots=tuple(reversed(value.roots)))
    else:
        value = replace(value, rows=(value.rows[0], replace(value.rows[1], row_ref=value.rows[0].row_ref)))
    with pytest.raises(resolver.ResolutionInputInvalid):
        winresolver._validate(value)


class NoCancelFuture(Future):
    def cancel(self):
        raise AssertionError('original queued ownership must never be cancelled')


class RetainedExecutor:
    """Bounded executor seam; the real owner/job control admission and release."""
    def __init__(self, *, failure=None, retain_on_failure=True):
        self.entries, self.threads, self.shutdowns = [], [], []
        self.failure, self.retain_on_failure = failure, retain_on_failure
        self.started = set()
    def submit(self, call, *args):
        assert len(self.entries) < 16
        if self.failure is not None and not self.retain_on_failure:
            raise self.failure
        future = NoCancelFuture()
        self.entries.append((future, call, args))
        if self.failure is not None:
            raise self.failure
        return future
    def start(self, index):
        assert index not in self.started and len(self.threads) < 2
        self.started.add(index)
        future, call, args = self.entries[index]
        def work():
            assert future.set_running_or_notify_cancel()
            try:
                result = call(*args)
            except BaseException as error:
                future.set_exception(error)
            else:
                future.set_result(result)
        worker = threading.Thread(target=work, daemon=True)
        self.threads.append(worker)
        worker.start()
    def join(self):
        for worker in self.threads:
            worker.join(WAIT)
            assert not worker.is_alive(), 'original controlled worker did not retire'
        for index in self.started:
            assert self.entries[index][0].exception(timeout=0) is None
    def shutdown(self, *, wait, cancel_futures):
        self.shutdowns.append((wait, cancel_futures))
        assert wait is False and cancel_futures is False


class ObservedSlots:
    """Record release identity around a genuine two-slot BoundedSemaphore."""
    def __init__(self, semaphore):
        self.semaphore, self.releases = semaphore, []
    def acquire(self, *, blocking):
        assert blocking is False
        return self.semaphore.acquire(blocking=False)
    def release(self):
        self.releases.append(threading.get_ident())
        self.semaphore.release()


def controlled_owner(monkeypatch, executor=None):
    import concurrent.futures
    executor = executor if executor is not None else RetainedExecutor()
    startups = []
    def factory(*, max_workers, thread_name_prefix):
        startups.append((max_workers, thread_name_prefix))
        return executor
    monkeypatch.setattr(concurrent.futures, 'ThreadPoolExecutor', factory)
    owner = resolver._ProbeOwner()  # Genuine constructor and shared job policy.
    owner._slots = ObservedSlots(owner._slots)
    monkeypatch.setattr(resolver, '_owner', owner)
    monkeypatch.setattr(resolver, '_owner_failed', False)
    assert startups == [(2, 'artwork-probe')]
    return owner, executor, startups


def platform_request(platform):
    return request() if platform == 'win32' else request(('/music',), ('cover.png',), platform='posix')


def owner_runner(monkeypatch, callback=None):
    """Only filesystem runner is isolated here; real owner/job/context remain."""
    calls = []
    def run(value, ctx):
        calls.append((value, ctx, threading.get_ident()))
        if callback is not None:
            callback(value, ctx)
        ctx.check()
        return resolver.Success(value.operation_ref, value.snapshot_digest, value.platform,
                                value.resolver_contract, (), (), ctx.counts())
    monkeypatch.setattr(resolver, '_run', run)
    monkeypatch.setattr(winresolver, '_run', run)
    return calls


def start_caller(call):
    results, errors = [], []
    def work():
        try:
            results.append(call())
        except BaseException as error:
            errors.append(error)
    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    return thread, results, errors


def finish_caller(caller):
    caller[0].join(WAIT)
    assert not caller[0].is_alive() and not caller[2]
    assert len(caller[1]) == 1
    return caller[1][0]


@pytest.mark.parametrize('order', [('win32', 'posix'), ('posix', 'win32')])
def test_mixed_queued_abandonment_uses_same_two_slots_until_original_dequeue(monkeypatch, order):
    owner, executor, startups = controlled_owner(monkeypatch)
    calls = owner_runner(monkeypatch)
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', lambda job, timeout: False)
    for platform in order:
        result = resolver.resolve(platform_request(platform))
        assert_failure(result, 'artwork_probe_timeout', complete=False)
        assert result.counts == resolver.WorkCounts()
    assert_failure(resolver.resolve(platform_request('win32')), 'artwork_probe_busy', complete=True)
    assert_failure(resolver.resolve(platform_request('posix')), 'artwork_probe_busy', complete=True)
    assert len(executor.entries) == 2 and not owner._slots.releases and calls == []
    assert type(executor.entries[0][2][0]) is type(executor.entries[1][2][0]) is rooted._SingleReleaseJob
    for index in range(2):
        assert not executor.entries[index][0].cancelled()
        executor.start(index)
    executor.join()
    assert not calls and not owner._jobs and not owner._quarantined
    assert set(owner._slots.releases) == {worker.ident for worker in executor.threads}
    assert len(owner._slots.releases) == 2 and startups == [(2, 'artwork-probe')]
    owner.close()
    assert executor.shutdowns == [(False, False)]


@pytest.mark.parametrize('failure,retained', [(RuntimeError('private submission detail'), False),
    (RuntimeError('private submission detail'), True), (KeyboardInterrupt(), True)])
def test_submission_uncertainty_never_releases_or_replaces_capacity(monkeypatch, failure, retained):
    executor = RetainedExecutor(failure=failure, retain_on_failure=retained)
    owner, executor, startups = controlled_owner(monkeypatch, executor)
    calls = owner_runner(monkeypatch)
    for platform in ('win32', 'posix'):
        if isinstance(failure, Exception):
            result = resolver.resolve(platform_request(platform))
            assert_failure(result, 'artwork_probe_unavailable', complete=False)
            assert 'private submission' not in repr(result)
        else:
            with pytest.raises(KeyboardInterrupt) as caught:
                resolver.resolve(platform_request(platform))
            assert caught.value is failure
    assert_failure(resolver.resolve(request()), 'artwork_probe_busy')
    assert not owner._slots.releases and len(owner._jobs) == 2 and not calls
    if retained:
        assert len(executor.entries) == 2
        executor.start(0)
        executor.start(1)
        executor.join()
        assert len(owner._slots.releases) == 2 and not owner._jobs
    else:
        assert not executor.entries  # No invented worker proves a release.
        assert len(owner._jobs) == 2
    assert len(startups) == 1
    owner.close()
    assert executor.shutdowns == [(False, False)]


@pytest.mark.parametrize('order', [('win32', 'posix'), ('posix', 'win32')])
def test_inflight_abandonment_keeps_slots_and_snapshots_until_late_cleanup(monkeypatch, order):
    owner, executor, startups = controlled_owner(monkeypatch)
    entered = [threading.Event(), threading.Event()]
    release = threading.Event()
    physical, contexts = [], []
    def blocking(value, ctx):
        index = order.index(value.platform)
        contexts.append(ctx)
        ctx.charge_component()
        ctx.before_syscall()
        entered[index].set()
        assert release.wait(WAIT)
        if value.platform == 'win32':
            with rooted._CleanupScope(operation_context=ctx):
                rooted._physical_cleanup(lambda: physical.append(threading.get_ident()))
        else:
            # Owner seam only: POSIX close accounting is covered in its old
            # suite. This synthetic hook models one completed safe cleanup.
            with ctx._counts_lock:
                ctx.cleanup_attempts += 1
            physical.append(threading.get_ident())
    owner_runner(monkeypatch, blocking)
    def timeout(job, seconds):
        index = next(i for i, entry in enumerate(executor.entries) if entry[2][0] is job)
        executor.start(index)
        assert entered[index].wait(WAIT)
        return False
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', timeout)
    results = []
    try:
        for platform in order:
            results.append(resolver.resolve(platform_request(platform)))
        for result in results:
            assert_failure(result, 'artwork_probe_timeout', complete=False)
            assert result.counts.components == result.counts.syscalls == 1
            assert result.counts.cleanup_attempts == 0
        assert_failure(resolver.resolve(request()), 'artwork_probe_busy')
        assert not owner._slots.releases and not physical
        owner.close()
        assert not owner._slots.releases and executor.shutdowns == [(False, False)]
    finally:
        release.set()
        executor.join()
        owner.close()
    assert len(physical) == 2 and len(owner._slots.releases) == 2
    assert set(physical) == set(owner._slots.releases)
    assert all(ctx.counts().cleanup_attempts == 1 for ctx in contexts)
    assert all(result.counts.cleanup_attempts == 0 for result in results)
    assert not owner._jobs and len(startups) == 1


@pytest.mark.parametrize('elapsed,accepted', [(9.999, True), (10.0, False), (10.001, False)])
def test_original_ten_second_deadline_is_checked_under_real_claim_lock(monkeypatch, elapsed, accepted):
    now = [100.0]
    monkeypatch.setattr(resolver, 'time', SimpleNamespace(monotonic=lambda: now[0]))
    monkeypatch.setattr(rooted, 'time', SimpleNamespace(monotonic=lambda: now[0]))
    owner, executor, _ = controlled_owner(monkeypatch)
    calls = owner_runner(monkeypatch)
    waits = []
    def completed_then_late(job, timeout):
        waits.append(timeout)
        executor.start(0)
        assert job.completed.wait(WAIT)
        now[0] = 100.0 + elapsed
        return True
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', completed_then_late)
    result = resolver.resolve(request())
    executor.join()
    job, value, ctx = executor.entries[0][2]
    assert waits == [10.0] and job._deadline == ctx.deadline == 110.0
    assert len(calls) == 1 and type(ctx) is winresolver._Context
    if accepted:
        assert type(result) is resolver.Success and job._decision == 'claimed'
    else:
        assert_failure(result, 'artwork_probe_timeout', complete=False)
        assert job._decision == 'abandoned'
    assert owner._slots.releases == [executor.threads[0].ident]
    owner.close()


def test_completed_unclaimed_mixed_results_still_consume_shared_capacity(monkeypatch):
    owner, executor, _ = controlled_owner(monkeypatch)
    owner_runner(monkeypatch)
    decision = threading.Event()
    ready = [threading.Event(), threading.Event()]
    def gated(job, timeout):
        index = next(i for i, entry in enumerate(executor.entries) if entry[2][0] is job)
        executor.start(index)
        assert job.completed.wait(WAIT)
        ready[index].set()
        assert decision.wait(WAIT)
        return True
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', gated)
    callers = []
    try:
        for index, platform in enumerate(('win32', 'posix')):
            callers.append(start_caller(lambda platform=platform: resolver.resolve(platform_request(platform))))
            assert ready[index].wait(WAIT)
        assert_failure(resolver.resolve(request()), 'artwork_probe_busy')
        assert len(owner._jobs) == 2 and not owner._slots.releases
    finally:
        decision.set()
        results = [finish_caller(caller) for caller in callers]
        executor.join()
        owner.close()
    assert all(type(result) is resolver.Success for result in results)
    assert len(owner._slots.releases) == 2 and not owner._jobs


@pytest.mark.parametrize('failure', ['failed_close', 'uncertain_transfer', 'undischarged_owner'])
def test_real_probe_job_quarantines_strong_native_owner_without_acquisition_hooks(monkeypatch, failure):
    owner, executor, _ = controlled_owner(monkeypatch)
    references, physical = [], []
    def leak(value, ctx):
        assert type(ctx._job) is rooted._SingleReleaseJob
        assert not hasattr(ctx._job, '_register_cleanup_owner')
        with rooted._CleanupScope(operation_context=ctx):
            domain = rooted._CleanupDomain()
            native_owner = rooted._CleanupOwner(domain)
            def close(number):
                physical.append(number)
                raise OSError('private close detail')
            record = native_owner.reserve('handle', close, 101)
        references.append((weakref.ref(ctx), weakref.ref(native_owner), weakref.ref(record)))
        if failure == 'failed_close':
            with pytest.raises(OSError):
                native_owner.close_all()
        elif failure == 'uncertain_transfer':
            with record._lock:
                record.state = 'bridge'
            record.uncertain(MemoryError('post-consumption allocation'))
        # Third branch deliberately leaves one actual registered owner. The
        # real shared worker must latch this on normal runner return as well.
    trace = owner_runner(monkeypatch, leak)
    def completed(job, timeout):
        executor.start(len(executor.entries) - 1)
        return job.completed.wait(WAIT)
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', completed)
    result = resolver.resolve(request())
    executor.join()
    assert_failure(result, 'artwork_probe_unavailable', complete=False)
    assert result.counts.cleanup_attempts == int(failure == 'failed_close')
    assert result.counts.cleanup_failures == int(failure == 'failed_close')
    assert not owner._slots.releases and len(owner._quarantined) == 1
    job = next(iter(owner._quarantined))
    assert job.is_quarantined() and job in owner._jobs and job._released is False
    executor.entries.clear()
    executor.threads.clear()
    trace.clear()
    gc.collect()
    assert all(reference() is not None for reference in references[0])
    ctx, native_owner, record = (reference() for reference in references[0])
    assert owner._quarantined[job] is ctx and native_owner in ctx._cleanup_owners
    before = list(physical)
    if failure != 'undischarged_owner':
        native_owner.close_all()
        assert physical == before
    owner.close()
    assert not owner._slots.releases and len(owner._quarantined) == 1


@pytest.mark.parametrize('stage', ['context_allocation', 'owner_registration'])
def test_context_setup_failure_has_no_native_work_or_capacity_leak(monkeypatch, stage):
    owner, executor, _ = controlled_owner(monkeypatch)
    calls = owner_runner(monkeypatch)
    if stage == 'context_allocation':
        def reject(*args, **kwargs):
            raise MemoryError('context allocation')
        monkeypatch.setattr(winresolver, '_Context', reject)
        result = resolver.resolve(request())
        assert_failure(result, 'artwork_probe_unavailable', complete=True)
        assert not executor.entries and not owner._jobs and not owner._slots.releases
    else:
        def reject_owner(value, ctx):
            def reject(*args):
                raise MemoryError('owner registration')
            ctx.register_cleanup_owner = reject
            with rooted._CleanupScope(operation_context=ctx):
                rooted._CleanupOwner(rooted._CleanupDomain())
        owner_runner(monkeypatch, reject_owner)
        monkeypatch.setattr(rooted._SingleReleaseJob, 'wait',
            lambda job, timeout: (executor.start(0), job.completed.wait(WAIT))[1])
        result = resolver.resolve(request())
        executor.join()
        assert_failure(result, 'artwork_probe_unavailable', complete=True)
        assert result.counts == resolver.WorkCounts() and not owner._jobs
        assert len(owner._slots.releases) == 1
    owner.close()


@pytest.mark.parametrize('failed_close', [False, True])
def test_late_windows_cleanup_after_abandonment_releases_or_quarantines_original_job(monkeypatch, failed_close):
    owner, executor, _ = controlled_owner(monkeypatch)
    entered, finish = threading.Event(), threading.Event()
    closes, retained = [], []
    def pending(value, ctx):
        with rooted._CleanupScope(operation_context=ctx):
            native_owner = rooted._CleanupOwner(rooted._CleanupDomain())
            def close(number):
                closes.append((number, threading.get_ident()))
                if failed_close:
                    raise OSError('late native cleanup uncertainty')
            native_owner.reserve('handle', close, 101)
        retained.append((ctx, native_owner))
        entered.set()
        assert finish.wait(WAIT)
        native_owner.close_all()
    owner_runner(monkeypatch, pending)
    def timeout(job, seconds):
        executor.start(0)
        assert entered.wait(WAIT)
        return False
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', timeout)
    try:
        result = resolver.resolve(request())
        assert_failure(result, 'artwork_probe_timeout', complete=False)
        assert result.counts.cleanup_attempts == result.counts.cleanup_failures == 0
        assert not owner._slots.releases and not closes
    finally:
        finish.set()
        executor.join()
    ctx, native_owner = retained[0]
    assert closes == [(101, executor.threads[0].ident)]
    assert ctx.counts().cleanup_attempts == 1
    assert ctx.counts().cleanup_failures == int(failed_close)
    assert ctx.cleanup_incomplete is failed_close
    assert result.counts.cleanup_attempts == result.counts.cleanup_failures == 0
    if failed_close:
        job = executor.entries[0][2][0]
        assert owner._quarantined[job] is ctx and not owner._slots.releases
        assert native_owner in ctx._cleanup_owners
        native_owner.close_all()
        assert closes == [(101, executor.threads[0].ident)]
    else:
        assert owner._slots.releases == [executor.threads[0].ident]
        assert not owner._jobs and not owner._quarantined and not ctx._cleanup_owners
    owner.close()


@pytest.mark.parametrize('value', [None, 'regular', True])
def test_malformed_selection_observation_cannot_publish_partial_success(monkeypatch, value):
    observed = Observations(monkeypatch)
    calls = []
    actual = winresolver.observe_selection
    def bad(selection, expected_root_stamp=None, *, operation_context):
        good = actual(selection, expected_root_stamp, operation_context=operation_context)
        calls.append(good)
        return value if value is None else replace(good, leaf_state=value)
    monkeypatch.setattr(winresolver, 'observe_selection', bad)
    if value == 'regular':
        # A subclass is forbidden even when its declared fields look valid.
        def extra(selection, expected_root_stamp=None, *, operation_context):
            good = actual(selection, expected_root_stamp, operation_context=operation_context)
            class Subclass(windows.WindowsSelectionObservation):
                pass
            return Subclass(good.platform, good.root_stamp, good.leaf_state)
        monkeypatch.setattr(winresolver, 'observe_selection', extra)
    with pytest.raises(resolver._Stop, match='artwork_unavailable'):
        run(request(covers=('first', 'second')))
    assert len(observed.rows) == 1 and len(observed.roots) == 1


@pytest.mark.parametrize('platform', ['win32', 'posix'])
@pytest.mark.parametrize('kind', ['empty', 'no_roots'])
def test_no_avoidable_owner_construction_for_empty_or_unresolvable_vector(monkeypatch, platform, kind):
    def forbidden():
        raise AssertionError('avoidable owner allocation')
    monkeypatch.setattr(resolver, '_owner', None)
    monkeypatch.setattr(resolver, '_owner_failed', False)
    monkeypatch.setattr(resolver, '_ProbeOwner', forbidden)
    value = platform_request(platform)
    value = replace(value, **({'rows': ()} if kind == 'empty' else {'roots': ()}))
    result = resolver.resolve(value)
    if kind == 'empty':
        assert type(result) is resolver.Success and not result.rows and not result.roots
        assert result.counts == resolver.WorkCounts()
    else:
        assert_failure(result, 'artwork_unavailable', complete=True)
    assert resolver._owner is None and resolver._owner_failed is False


@pytest.mark.parametrize('field,maximum', [('root', 8192), ('stored', 16384)])
@pytest.mark.parametrize('extra', [0, 1])
def test_multibyte_utf8_boundary_is_bytes_not_python_length(field, maximum, extra):
    path = legal_path(maximum - 1, absolute=field == 'root')
    path = path.replace('x', 'é', 1 + extra)
    assert len(path) == maximum - 1 and len(path.encode('utf-8')) == maximum + extra
    value = request((path,), ()) if field == 'root' else request(covers=(path,))
    if extra:
        with pytest.raises(resolver.ResolutionInputInvalid):
            winresolver._validate(value)
    else:
        assert winresolver._validate(value) == value


@pytest.mark.parametrize('fault', ['relative_list', 'string_subclass', 'bytes_subclass', 'tuple_subclass'])
def test_nested_mutable_or_coercible_values_are_rejected_before_copy_authority(fault):
    expected = expectation()
    if fault == 'relative_list':
        expected = replace(expected, relative_parts=['cover.png'])
    elif fault == 'string_subclass':
        class Text(str):
            pass
        expected = replace(expected, root_path=Text(ROOT))
    elif fault == 'bytes_subclass':
        class Bytes(bytes):
            pass
        expected = replace(expected, root_stamp=replace(expected.root_stamp,
            identity=replace(expected.root_stamp.identity, file_id=Bytes(b'x' * 16))))
    else:
        class Tuple(tuple):
            pass
        expected = replace(expected, relative_parts=Tuple(('cover.png',)))
    with pytest.raises(resolver.ResolutionInputInvalid):
        winresolver._validate(request(expected=expected))


@pytest.mark.parametrize('trigger', ['deadline', 'abandoned'])
def test_final_post_vector_context_fence_rejects_late_complete_observations(monkeypatch, trigger):
    observed = Observations(monkeypatch)
    now, abandoned = [0.0], [False]
    ctx = winresolver._Context(10.0, lambda: abandoned[0], clock=lambda: now[0])
    def expire(selection, ordinal):
        if ordinal == 2:
            if trigger == 'deadline':
                now[0] = 10.0
            else:
                abandoned[0] = True
    observed.on_root = expire
    with pytest.raises(resolver._Stop, match='artwork_probe_timeout'):
        winresolver._run(winresolver._validate(request()), ctx)
    assert len(observed.rows) == 1 and len(observed.roots) == 2
    assert ctx.counts().cleanup_failures == 0


@pytest.mark.parametrize('error', [FileNotFoundError('not an admitted missing category'),
    OSError('access detail'), windows.WindowsUnavailable('windows_native_open_failed')])
def test_generic_observation_error_never_becomes_missing_tail(monkeypatch, error):
    observed = Observations(monkeypatch)
    def fail(*args, **kwargs):
        raise error
    monkeypatch.setattr(winresolver, 'observe_selection', fail)
    with pytest.raises(resolver._Stop, match='^artwork_unavailable$'):
        run(request())
    assert len(observed.roots) == 1 and not observed.rows


def test_unexpected_worker_error_is_bounded_with_complete_terminal_counts(monkeypatch):
    owner, executor, _ = controlled_owner(monkeypatch)
    def fail(value, ctx):
        ctx.charge_component()
        ctx.before_syscall()
        raise RuntimeError('private native path C:\\Private\\cover.png')
    owner_runner(monkeypatch, fail)
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait',
        lambda job, timeout: (executor.start(0), job.completed.wait(WAIT))[1])
    result = resolver.resolve(request())
    executor.join()
    assert_failure(result, 'artwork_probe_unavailable', complete=True)
    assert result.counts.components == result.counts.syscalls == 1
    assert result.counts.combined_work == 2 and result.counts.cleanup_attempts == 0
    assert 'Private' not in repr(result) and 'native path' not in repr(result)
    assert len(owner._slots.releases) == 1 and not owner._jobs
    owner.close()


@pytest.mark.parametrize('platform', ['win32', 'posix'])
def test_waiting_caller_interruption_abandons_without_cancel_or_slot_release(monkeypatch, platform):
    owner, executor, _ = controlled_owner(monkeypatch)
    calls = owner_runner(monkeypatch)
    interrupted = KeyboardInterrupt()
    def stop(job, timeout):
        raise interrupted
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', stop)
    with pytest.raises(KeyboardInterrupt) as caught:
        resolver.resolve(platform_request(platform))
    assert caught.value is interrupted
    assert not owner._slots.releases and len(owner._jobs) == 1 and not calls
    job = executor.entries[0][2][0]
    assert job.is_abandoned() and not executor.entries[0][0].cancelled()
    executor.start(0)
    executor.join()
    assert not calls and not owner._jobs
    assert owner._slots.releases == [executor.threads[0].ident]
    owner.close()
