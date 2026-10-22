"""Acceptance source for the dormant bounded POSIX artwork observations.

Filesystem cases use real temporary paths and the actual shared directory chain.
Private clocks, barriers and retained executors below test ownership, never image
decoding or fabricated successful pixels. Authoring this file does not authorize
executing it, importing the application, or opening a database/configuration.
"""
from concurrent.futures import Future
from contextlib import ExitStack
from dataclasses import FrozenInstanceError, fields, replace
import os
from pathlib import PurePosixPath
import threading
import time

import pytest

from music_app.services import _top_artwork_resolution as resolver
from music_app.services import rooted_local_file as rooted


requires_posix = pytest.mark.skipif(os.name != 'posix', reason='real POSIX filesystem case')


def uid(number=1):
    return f'00000000-0000-0000-0000-{number:012x}'


def request(roots=(), covers=(), *, expected=None):
    root_values = tuple(resolver.RootInput(index + 1, str(path))
                        for index, path in enumerate(roots))
    rows = tuple(resolver.RowInput(uid(index + 2), index + 1, str(path),
                                  expected if index == 0 else None)
                 for index, path in enumerate(covers))
    return resolver.ResolutionInput(uid(), 'a' * 64, 'posix', resolver.CONTRACT,
                                    root_values, rows, 1)


def regular(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'ordinary test file; no image claim\n')
    return path


def depth(path):
    return 0 if str(path) == '/' else len(str(path).split('/')) - 1


def context(*, deadline=float('inf'), clock=lambda: 0.0,
            abandoned=lambda: False):
    return resolver._Context(deadline, abandoned, clock=clock)


def assert_failure(result, code, *, complete=None):
    assert type(result) is resolver.Failure
    assert result.error_code == code
    assert not hasattr(result, 'rows') and not hasattr(result, 'roots')
    assert set(field.name for field in fields(result)) == {
        'operation_ref', 'snapshot_digest', 'platform', 'resolver_contract',
        'error_code', 'counts', 'counts_complete',
    }
    assert type(result.counts_complete) is bool
    if complete is not None:
        assert result.counts_complete is complete
    for field in fields(result.counts):
        number = getattr(result.counts, field.name)
        assert type(number) is int and number >= 0
    assert result.counts.combined_work == (
        result.counts.components + result.counts.syscalls + result.counts.expansions)


def resolve_observations(value):
    """Await real terminal-worker discharge between unrelated filesystem cases.

    Production claim precedes the worker's slot release by a scheduling turn.
    Admission/lifecycle cases below call their controlled owner directly, so
    this helper never converts production busy/timeout behavior into a queue.
    """
    result = resolver.resolve(value)
    if type(result) is resolver.Failure and not result.counts_complete:
        return result
    owner = resolver._owner
    if owner is not None:
        with owner._lock:
            jobs = tuple(owner._jobs)
        deadline = time.monotonic() + 5
        tick = threading.Event()
        for job in jobs:
            while True:
                with job._condition:
                    discharged = job._released or job._quarantined
                if discharged:
                    break
                assert time.monotonic() < deadline, 'terminal worker did not discharge ownership'
                tick.wait(0.001)
    return result


@pytest.fixture(autouse=True)
def isolated_process_owner(monkeypatch):
    """A process lifetime is reset only by this private test fixture."""
    monkeypatch.setattr(resolver, '_owner', None)
    monkeypatch.setattr(resolver, '_owner_failed', False)
    yield
    owner = resolver._owner
    if owner is not None:
        owner.close()


@pytest.fixture
def root(tmp_path):
    if os.name != 'posix':
        pytest.skip('real POSIX filesystem fixture')
    path = tmp_path / 'library'
    path.mkdir()
    return path


def test_regular_observation_preserves_order_spelling_and_complete_vector(root):
    first = regular(root / 'a' / 'cover.bin')
    second = regular(root / 'b.bin')
    value = request((root,), ('a/cover.bin', str(second), 'missing/cover.bin'))
    result = resolve_observations(value)
    assert type(result) is resolver.Success
    assert (result.operation_ref, result.snapshot_digest, result.platform,
            result.resolver_contract) == (
        value.operation_ref, value.snapshot_digest, 'posix', resolver.CONTRACT)
    assert tuple(row.row_ref for row in result.rows) == tuple(row.row_ref for row in value.rows)
    assert tuple(row.local_album_id for row in result.rows) == (1, 2, 3)
    assert tuple(row.stored_cover_path for row in result.rows) == ('a/cover.bin', str(second), 'missing/cover.bin')
    assert tuple(row.resolved_cover_path for row in result.rows) == (
        str(first), str(second), str(root / 'missing' / 'cover.bin'))
    assert tuple(row.relative_parts for row in result.rows) == (
        ('a', 'cover.bin'), ('b.bin',), ('missing', 'cover.bin'))
    assert tuple(row.leaf_state for row in result.rows) == ('regular', 'regular', 'missing_tail')
    key = ('posix', 1, str(root))
    assert len(result.roots) == 1 and result.roots[0].root_ledger_key == key
    assert all(row.root_ledger_key == key for row in result.rows)
    stamp = result.roots[0].initial
    actual = root.stat()
    assert stamp == result.roots[0].final == rooted.PosixRootStamp('posix', actual.st_dev, actual.st_ino)
    assert set(field.name for field in fields(result.rows[0])) == {
        'row_ref', 'local_album_id', 'stored_cover_path', 'resolved_cover_path',
        'relative_parts', 'root_id', 'root_path', 'root_ledger_key', 'leaf_state',
    }
    assert not any(hasattr(result.rows[0], name) for name in (
        'item_ref', 'mtime_ns', 'ctime_ns', 'leaf_bytes', 'authorization', 'handle'))


def test_results_are_recursively_immutable(root):
    value = request((root,), ('absent.bin',))
    result = resolve_observations(value)
    with pytest.raises(FrozenInstanceError):
        result.snapshot_digest = 'b' * 64
    with pytest.raises(FrozenInstanceError):
        result.rows[0].root_id = 99
    with pytest.raises(FrozenInstanceError):
        result.roots[0].initial.inode = 99
    with pytest.raises(FrozenInstanceError):
        result.counts.syscalls = 99
    assert type(result.rows) is type(result.roots) is tuple
    assert type(result.rows[0].relative_parts) is type(result.rows[0].root_ledger_key) is tuple


@pytest.mark.parametrize('cover', [
    '', '.', '..', './cover', '../cover', 'a/./cover', 'a/../cover',
    'a//cover', 'a/', '/a//cover', '//a/cover', '/a/cover/',
    'https://example.test/cover', 'x://cover', 'a\x00b', '\ud800',
    '/'.join(['x'] * 257), 'é' * 8193,
])
def test_cover_grammar_rejects_before_owner_admission(cover, monkeypatch):
    def forbidden():
        raise AssertionError('invalid input attempted owner startup')
    monkeypatch.setattr(resolver, '_ProbeOwner', forbidden)
    with pytest.raises(resolver.ResolutionInputInvalid) as caught:
        resolve_observations(request(('/library',), (cover,)))
    assert str(caught.value) == 'artwork_source_invalid'
    assert resolver._owner is None


@pytest.mark.parametrize('path', [
    '', 'relative', '//root', '/root/', '/a//b', '/a/./b', '/a/../b',
    '/a\x00b', '/\ud800', '/' + '/'.join(['x'] * 257), '/' + 'é' * 4096,
])
def test_root_grammar_rejects_before_observation(path):
    with pytest.raises(resolver.ResolutionInputInvalid, match='^artwork_source_invalid$'):
        resolve_observations(request((path,), ('cover',)))
    assert resolver._owner is None


@pytest.mark.parametrize('name', ['~cover', r'C:\cover.png', r'part\cover', 'C:cover', 'é.bin'])
def test_posix_tilde_colon_backslash_and_utf8_are_literal(root, name):
    target = regular(root / name)
    result = resolve_observations(request((root,), (name,)))
    assert type(result) is resolver.Success
    assert result.rows[0].resolved_cover_path == str(target)
    assert result.rows[0].relative_parts == (name,)


def test_missing_leaf_and_plain_missing_suffix_are_valid_observations(root):
    result = resolve_observations(request((root,), ('missing', 'missing/child/cover')))
    assert type(result) is resolver.Success
    assert all(row.leaf_state == 'missing_tail' for row in result.rows)
    assert result.rows[1].relative_parts == ('missing', 'child', 'cover')


@pytest.mark.parametrize('target', [
    'album/./cover', 'album//cover', 'album/../cover', './cover',
    '~literal/cover', r'C:\literal/cover',
])
def test_relative_symlink_target_stack_uses_posix_tokens(root, target):
    (root / 'album').mkdir()
    regular(root / 'album' / 'cover')
    regular(root / 'cover')
    regular(root / '~literal' / 'cover')
    regular(root / r'C:\literal' / 'cover')
    (root / 'link').symlink_to(target)
    result = resolve_observations(request((root,), ('link',)))
    assert type(result) is resolver.Success
    expected = root / ('album/cover' if target in ('album/./cover', 'album//cover')
                       else '~literal/cover' if target.startswith('~')
                       else r'C:\literal/cover' if target.startswith('C:') else 'cover')
    assert result.rows[0].resolved_cover_path == str(expected)
    assert result.counts.expansions == 1


def test_absolute_target_resets_and_root_parent_tokens_clamp(root):
    target = regular(root / 'cover')
    (root / 'link').symlink_to('///../../' + str(target).lstrip('/').replace('/', '//'))
    result = resolve_observations(request((root,), ('link',)))
    assert type(result) is resolver.Success
    assert result.rows[0].resolved_cover_path == str(target)


def test_dangling_symlink_plain_target_remains_missing_tail(root):
    (root / 'link').symlink_to('missing/./child//cover')
    result = resolve_observations(request((root,), ('link',)))
    assert type(result) is resolver.Success
    assert result.rows[0].resolved_cover_path == str(root / 'missing' / 'child' / 'cover')
    assert result.rows[0].leaf_state == 'missing_tail'


@pytest.mark.parametrize('target,cover', [
    ('missing/../cover', 'link'), ('missing/./../cover', 'link'),
    ('missing/..', 'link/cover'), ('missing/child/../../cover', 'link'),
])
def test_parent_anywhere_after_enoent_aborts_whole_operation(root, target, cover):
    regular(root / 'good')
    regular(root / 'cover')
    (root / 'link').symlink_to(target)
    value = request((root,), ('good', cover))
    result = resolve_observations(value)
    assert_failure(result, 'artwork_unavailable')
    assert result.operation_ref == value.operation_ref
    assert result.counts.candidates == 2


@pytest.mark.parametrize('target', ['cover/', 'album/', 'album/.', 'album/..'])
def test_terminal_directory_requirement_and_directory_targets_are_unavailable(root, target):
    regular(root / 'cover')
    (root / 'album').mkdir()
    (root / 'link').symlink_to(target)
    assert_failure(resolve_observations(request((root,), ('link',))), 'artwork_unavailable')


@pytest.mark.parametrize('cover', ['cover/child', 'link/child'])
def test_regular_file_with_remaining_components_is_indeterminate(root, cover):
    regular(root / 'cover')
    (root / 'link').symlink_to('cover')
    assert_failure(resolve_observations(request((root,), (cover,))), 'artwork_unavailable')


def test_final_directory_fifo_and_root_equal_never_become_artwork(root):
    (root / 'directory').mkdir()
    os.mkfifo(root / 'fifo')
    for cover in ('directory', 'fifo', str(root), '/'):
        assert_failure(resolve_observations(request((root,), (cover,))), 'artwork_unavailable')


def test_symlink_loop_fails_operation_at_candidate_expansion_bound(root):
    (root / 'loop').symlink_to('loop')
    result = resolve_observations(request((root,), ('loop',)))
    assert_failure(result, 'artwork_validation_limit')
    assert result.counts.expansions == 40


@pytest.mark.parametrize('count,success', [(39, True), (40, True), (41, False)])
def test_real_link_expansion_boundary(root, count, success):
    regular(root / 'cover')
    for index in range(count):
        (root / f'link{index}').symlink_to('cover' if index + 1 == count else f'link{index + 1}')
    result = resolve_observations(request((root,), ('link0',)))
    if success:
        assert type(result) is resolver.Success and result.counts.expansions == count
    else:
        assert_failure(result, 'artwork_validation_limit')
        assert result.counts.expansions == 40


@pytest.mark.parametrize('tokens,success', [(255, True), (256, True), (257, False)])
def test_readlink_token_cap_counts_dots_before_discard(root, tokens, success):
    regular(root / 'cover')
    (root / 'link').symlink_to('/'.join(['.'] * (tokens - 1) + ['cover']))
    result = resolve_observations(request((root,), ('link',)))
    if success:
        assert type(result) is resolver.Success
        assert result.counts.components >= tokens
    else:
        assert_failure(result, 'artwork_validation_limit')


def test_expanded_pending_limit_includes_original_suffix(root):
    (root / 'link').symlink_to('/'.join(['.'] * 255 + ['missing']))
    result = resolve_observations(request((root,), ('link/cover',)))
    assert_failure(result, 'artwork_validation_limit')


def test_pending_encoded_bytes_are_bounded_before_enqueue_of_nested_targets(root):
    for index in range(10):
        target = '/'.join([f'link{index + 1}'] + ['x' * 200] * 9)
        (root / f'link{index}').symlink_to(target)
    cover = '/'.join(['link0'] + ['y' * 190] * 80)
    value = resolver._validate(request((root,), (cover,)))
    counted = context()
    with pytest.raises(resolver._Stop, match='^artwork_validation_limit$'):
        resolver._run(value, counted)
    # The tenth target would retain >32768 bytes but <256 tokens. Rejection
    # happens before enqueue/expansion charge or observing any missing tail.
    assert counted.expansions == 9
    assert counted.components == depth(root) + 10
    assert counted.cleanup_attempts == 0


def test_non_utf8_readlink_result_fails_without_private_os_text(root):
    os.symlink(b'\xff', os.fsencode(root / 'link'))
    result = resolve_observations(request((root,), ('link',)))
    assert_failure(result, 'artwork_unavailable', complete=True)


def test_short_final_target_does_not_hide_intermediate_component_overflow(root):
    # The target has 255 tokens and would end at a short existing file. Its
    # intermediate 257-component stack is forbidden before any later pops.
    for _ in range(130 - depth(root)):
        root = root / 'd'
        root.mkdir()
    regular(root / 'cover')
    nested = root
    for _ in range(127):
        nested = nested / 'd'
        nested.mkdir()
    target = '/'.join(['d'] * 127 + ['..'] * 127 + ['cover'])
    (root / 'link').symlink_to(target)
    result = resolve_observations(request((root,), ('link',)))
    assert_failure(result, 'artwork_validation_limit')


def test_absolute_resolution_ignores_unrelated_physical_root_failure(root, tmp_path):
    target = regular(root / 'cover')
    unrelated = regular(tmp_path / 'not-a-directory')
    value = request((root, unrelated), (str(target),))
    result = resolve_observations(value)
    assert type(result) is resolver.Success
    assert result.rows[0].root_id == 1 and result.counts.candidates == 1


def test_relative_outside_root_candidate_can_be_skipped(root, tmp_path):
    other = tmp_path / 'other'
    outside = tmp_path / 'outside'
    other.mkdir()
    target = regular(root / 'cover')
    regular(outside / 'cover')
    (other / 'cover').symlink_to(outside / 'cover')
    result = resolve_observations(request((root, other), ('cover',)))
    assert type(result) is resolver.Success
    assert result.rows[0].resolved_cover_path == str(target)
    assert result.counts.candidates == 2


def test_indeterminate_later_candidate_aborts_even_after_earlier_success(root, tmp_path):
    regular(root / 'cover')
    bad = regular(tmp_path / 'not-a-directory')
    result = resolve_observations(request((root, bad), ('cover',)))
    assert_failure(result, 'artwork_unavailable')
    assert result.counts.candidates == 2


def test_two_distinct_relative_paths_are_ambiguous(root, tmp_path):
    other = tmp_path / 'other'
    regular(root / 'cover')
    regular(other / 'cover')
    assert_failure(resolve_observations(request((root, other), ('cover',))), 'artwork_unavailable')


def test_duplicate_roots_dedup_exact_paths_and_choose_lowest_id(root):
    target = regular(root / 'cover')
    result = resolve_observations(request((root, root), ('cover',)))
    assert type(result) is resolver.Success
    assert result.rows[0].root_id == 1 and result.rows[0].resolved_cover_path == str(target)
    assert len(result.roots) == 1 and result.counts.candidates == 2


def test_containing_root_selection_uses_components_then_numeric_id(root):
    nested = root / 'album'
    target = regular(nested / 'cover')
    result = resolve_observations(request((root, nested, nested), (str(target),)))
    assert type(result) is resolver.Success
    assert result.rows[0].root_id == 2
    assert result.rows[0].root_path == str(nested)
    assert result.rows[0].relative_parts == ('cover',)


def test_anchor_root_is_less_specific_than_one_component_root(root):
    target = regular(root / 'cover')
    one_component = '/' + str(target).split('/')[1]
    result = resolve_observations(request(('/', one_component), (str(target),)))
    assert type(result) is resolver.Success
    assert result.rows[0].root_id == 2
    assert result.rows[0].root_path == one_component
    assert result.counts.unique_root_components == 1


def test_component_prefix_and_case_are_not_string_or_casefold_matches(root):
    regular(root / 'Cover')
    regular(root / 'cover')
    result = resolve_observations(request((root,), ('Cover', 'cover')))
    assert type(result) is resolver.Success
    assert result.rows[0].resolved_cover_path != result.rows[1].resolved_cover_path
    assert not resolver._below(str(root) + '-sibling/cover', str(root))


def test_selected_root_probe_failure_does_not_fall_back_to_parent(root, monkeypatch):
    nested = root / 'album'
    target = regular(nested / 'cover')
    observed = []
    real_probe = resolver.observe_root
    def replace_selected_root(selection, *, operation_context):
        observed.append(selection.root_path)
        if len(observed) == 1:
            nested.rename(root / 'saved-album')
            nested.symlink_to(root / 'saved-album', target_is_directory=True)
        return real_probe(selection, operation_context=operation_context)
    monkeypatch.setattr(resolver, 'observe_root', replace_selected_root)
    result = resolve_observations(request((root, nested), (str(target),)))
    assert_failure(result, 'artwork_unavailable')
    assert observed == [str(nested)]


@pytest.mark.parametrize('phase', ['initial', 'final'])
def test_ordinary_selected_root_oserror_is_unavailable_with_complete_cleanup(root, monkeypatch, phase):
    real_probe = resolver.observe_root
    calls = []
    def disappear_before_probe(selection, *, operation_context):
        calls.append(selection.root_path)
        if len(calls) == (1 if phase == 'initial' else 2):
            root.rename(root.with_name('gone-library'))
        return real_probe(selection, operation_context=operation_context)
    monkeypatch.setattr(resolver, 'observe_root', disappear_before_probe)
    result = resolve_observations(request((root,), ('missing',)))
    assert_failure(result, 'artwork_unavailable', complete=True)
    assert len(calls) == (1 if phase == 'initial' else 2)
    assert result.counts.cleanup_failures == 0
    assert result.counts.cleanup_attempts == (depth(root) if phase == 'initial' else 2 * depth(root) + 1)


def test_initial_final_root_identity_mismatch_aborts_complete_result(root, monkeypatch):
    regular(root / 'cover')
    original = resolver.observe_root
    calls = []
    def replace_between_checkpoints(selection, *, operation_context):
        calls.append(selection.root_path)
        if len(calls) == 2:
            root.rename(root.with_name('old-library'))
            root.mkdir()
            regular(root / 'cover')
        return original(selection, operation_context=operation_context)
    monkeypatch.setattr(resolver, 'observe_root', replace_between_checkpoints)
    result = resolve_observations(request((root,), ('cover',)))
    assert_failure(result, 'artwork_source_changed')
    assert calls == [str(root), str(root)]
    assert result.counts.cleanup_attempts == 2 * (depth(root) + 1)


def test_ready_proof_compares_fresh_selection_but_not_leaf_bytes(root):
    target = regular(root / 'cover')
    initial = resolve_observations(request((root,), ('cover',)))
    observed = initial.rows[0]
    expected = resolver.ExpectedSelection(1, str(root), str(target), ('cover',), initial.roots[0].initial)
    target.write_bytes(b'different ordinary bytes, same root')
    ready = resolve_observations(request((root,), ('cover',), expected=expected))
    assert type(ready) is resolver.Success
    assert ready.rows[0] == observed
    assert ready.counts.candidates == 1 and ready.counts.syscalls > 0
    other = regular(root / 'other')
    target.unlink()
    target.symlink_to(other)
    assert_failure(resolve_observations(request((root,), ('cover',), expected=expected)), 'artwork_source_changed')


def test_ready_root_stamp_change_is_observed_even_with_unchanged_path(root):
    regular(root / 'cover')
    initial = resolve_observations(request((root,), ('cover',)))
    expected = resolver.ExpectedSelection(1, str(root), str(root / 'cover'), ('cover',), initial.roots[0].initial)
    root.rename(root.with_name('old-library'))
    root.mkdir()
    regular(root / 'cover')
    assert_failure(resolve_observations(request((root,), ('cover',), expected=expected)), 'artwork_source_changed')


def test_ready_proof_root_identity_and_relative_parts_must_match_fresh_selection(root):
    target = regular(root / 'cover')
    first = resolve_observations(request((root,), ('cover',)))
    stamp = first.roots[0].initial
    for expected in (
        resolver.ExpectedSelection(2, str(root), str(target), ('cover',), stamp),
        resolver.ExpectedSelection(1, str(root), str(root / 'other'), ('other',), stamp),
    ):
        result = resolve_observations(request((root,), ('cover',), expected=expected))
        assert_failure(result, 'artwork_source_changed', complete=True)
        assert result.counts.candidates == 1 and result.counts.syscalls > 0


def test_each_row_is_resolved_again_without_path_cache(root, monkeypatch):
    target = regular(root / 'cover')
    calls = []
    real_walk = resolver._walk
    def remove_after_first(path, operation_context):
        result = real_walk(path, operation_context)
        calls.append(path)
        if len(calls) == 1:
            target.unlink()
        return result
    monkeypatch.setattr(resolver, '_walk', remove_after_first)
    result = resolve_observations(request((root,), ('cover', 'cover')))
    assert type(result) is resolver.Success
    assert len(calls) == 2
    assert tuple(row.leaf_state for row in result.rows) == ('regular', 'missing_tail')


def test_ledger_is_unique_ordered_operation_local_and_not_a_root_handle_cache(root, tmp_path):
    other = tmp_path / 'other'
    first = regular(root / 'cover')
    second = regular(other / 'cover')
    value = request((root, other), (str(second), str(first), str(second)))
    result = resolve_observations(value)
    assert type(result) is resolver.Success
    assert tuple(entry.root_ledger_key[1] for entry in result.roots) == (1, 2)
    assert result.counts.unique_root_components == depth(root) + depth(other)
    assert result.counts.cleanup_attempts == 2 * (depth(root) + depth(other) + 2)
    again = resolve_observations(replace(value, operation_ref=uid(99)))
    assert type(again) is resolver.Success and again.counts == result.counts


@pytest.mark.parametrize('changes', [
    {'operation_ref': None}, {'operation_ref': uid().upper().replace('0', 'A', 1)},
    {'operation_ref': '00000000-0000-0000-0000-000000000000'},
    {'snapshot_digest': 'A' * 64}, {'snapshot_digest': 'a' * 63},
    {'platform': 'win32'}, {'resolver_contract': 'unknown'},
    {'ceilings_version': True}, {'ceilings_version': 2}, {'roots': []}, {'rows': []},
])
def test_invalid_envelope_has_fixed_exception_and_zero_work(changes):
    with pytest.raises(resolver.ResolutionInputInvalid) as caught:
        resolve_observations(replace(request(('/library',), ('cover',)), **changes))
    assert str(caught.value) == 'artwork_source_invalid'
    assert resolver._owner is None


@pytest.mark.parametrize('number', [True, False, 0, -1, 2 ** 63, 1.0, '1'])
def test_root_and_album_identifiers_require_exact_bounded_int(number):
    value = request(('/library',), ('cover',))
    for changed in (
        replace(value, roots=(resolver.RootInput(number, '/library'),)),
        replace(value, rows=(replace(value.rows[0], local_album_id=number),)),
    ):
        with pytest.raises(resolver.ResolutionInputInvalid, match='^artwork_source_invalid$'):
            resolve_observations(changed)
    assert resolver._owner is None


def test_unknown_fields_types_and_subclasses_do_not_enter_owner():
    with pytest.raises(TypeError):
        resolver.ResolutionInput(**{**request().__dict__, 'connection': object()})
    with pytest.raises(resolver.ResolutionInputInvalid):
        resolve_observations(request().__dict__)
    class DerivedRoot(resolver.RootInput):
        pass
    value = replace(request(('/library',), ('cover',)), roots=(DerivedRoot(1, '/library'),))
    with pytest.raises(resolver.ResolutionInputInvalid):
        resolve_observations(value)


@pytest.mark.parametrize('record_name', ['envelope', 'root', 'row', 'expected', 'stamp'])
@pytest.mark.parametrize('mutation', ['extra', 'replace_key', 'missing'])
def test_exact_original_record_field_sets_are_checked_before_copy(record_name, mutation):
    stamp = rooted.PosixRootStamp('posix', 1, 2)
    expected = resolver.ExpectedSelection(1, '/library', '/library/cover', ('cover',), stamp)
    value = request(('/library',), ('cover',), expected=expected)
    records = {'envelope': value, 'root': value.roots[0], 'row': value.rows[0],
               'expected': expected, 'stamp': stamp}
    record = records[record_name]
    if mutation != 'extra':
        del record.__dict__[next(iter(record.__dict__))]
    if mutation != 'missing':
        object.__setattr__(record, 'unexpected_private_field', object())
    with pytest.raises(resolver.ResolutionInputInvalid) as caught:
        resolve_observations(value)
    assert str(caught.value) == 'artwork_source_invalid'
    assert resolver._owner is None


def test_malformed_fields_never_invoke_caller_conversion_or_comparison():
    class Trap:
        def __eq__(self, other):
            raise AssertionError('caller equality was invoked')
        def __str__(self):
            raise AssertionError('caller string conversion was invoked')
        def __iter__(self):
            raise AssertionError('caller iteration was invoked')
    value = request(('/library',), ('cover',))
    trap = Trap()
    cases = [replace(value, **{name: trap}) for name in (
        'operation_ref', 'snapshot_digest', 'platform', 'resolver_contract',
        'roots', 'rows', 'ceilings_version')]
    cases.extend((
        replace(value, roots=(replace(value.roots[0], root_path=trap),)),
        replace(value, rows=(replace(value.rows[0], stored_cover_path=trap),)),
        replace(value, rows=(replace(value.rows[0], stored_cover_path=None),)),
    ))
    for candidate in cases:
        with pytest.raises(resolver.ResolutionInputInvalid, match='^artwork_source_invalid$'):
            resolve_observations(candidate)
    assert resolver._owner is None


def test_full_manifest_validation_precedes_any_first_row_filesystem_work(root):
    regular(root / 'cover')
    value = request((root,), ('cover', 'second'))
    value = replace(value, rows=(value.rows[0], replace(value.rows[1], stored_cover_path=None)))
    with pytest.raises(resolver.ResolutionInputInvalid, match='^artwork_source_invalid$'):
        resolve_observations(value)
    assert resolver._owner is None


def test_duplicate_or_unsorted_ids_and_duplicate_row_refs_reject():
    value = request(('/a', '/b'), ('cover', 'cover'))
    for changed in (
        replace(value, roots=tuple(reversed(value.roots))),
        replace(value, roots=(value.roots[0], value.roots[0])),
        replace(value, rows=(value.rows[0], value.rows[0])),
    ):
        with pytest.raises(resolver.ResolutionInputInvalid):
            resolve_observations(changed)


def test_invalid_expected_selection_rejects_before_admission():
    stamp = rooted.PosixRootStamp('posix', 1, 2)
    expected = resolver.ExpectedSelection(1, '/library', '/library/cover', ('cover',), stamp)
    for bad in (
        replace(expected, root_id=True), replace(expected, root_path='/library/'),
        replace(expected, resolved_cover_path='/elsewhere/cover'),
        replace(expected, relative_parts=['cover']), replace(expected, relative_parts=()),
        replace(expected, relative_parts=('../cover',)),
        replace(expected, root_stamp=replace(stamp, platform='win32')),
        replace(expected, root_stamp=replace(stamp, device=True)),
        replace(expected, root_stamp=replace(stamp, inode=-1)),
        replace(expected, root_stamp=replace(stamp, inode=2 ** 64)),
    ):
        with pytest.raises(resolver.ResolutionInputInvalid):
            resolve_observations(request(('/library',), ('cover',), expected=bad))
    assert resolver._owner is None


@pytest.mark.parametrize('count', [0, 257, 4096])
def test_expected_tuple_count_rejects_before_expected_path_work(count, monkeypatch):
    stamp = rooted.PosixRootStamp('posix', 1, 2)
    expected = resolver.ExpectedSelection(1, '/proof-root', '/proof-root/cover', ('x',) * count, stamp)
    calls = []
    original = resolver._path
    def observed_path(value, **options):
        calls.append(value)
        assert value not in ('/proof-root', '/proof-root/cover'), 'unbounded expected vector reached path work'
        return original(value, **options)
    monkeypatch.setattr(resolver, '_path', observed_path)
    with pytest.raises(resolver.ResolutionInputInvalid, match='^artwork_source_invalid$'):
        resolve_observations(request(('/library',), ('cover',), expected=expected))
    assert calls == ['/library', 'cover']
    assert resolver._owner is None


@pytest.mark.parametrize('part', ['x' * 16385, 'é' * 8193, '\ud800'])
def test_expected_component_character_and_utf8_limits_reject_before_admission(part):
    expected = resolver.ExpectedSelection(1, '/library', '/library/cover', (part,),
                                         rooted.PosixRootStamp('posix', 1, 2))
    with pytest.raises(resolver.ResolutionInputInvalid, match='^artwork_source_invalid$'):
        resolve_observations(request(('/library',), ('cover',), expected=expected))
    assert resolver._owner is None


def test_expected_relative_vector_256_parts_and_utf8_payload_subset_boundaries():
    stamp = rooted.PosixRootStamp('posix', 1, 2)
    parts = ('x',) * 256
    expected = resolver.ExpectedSelection(1, '/', '/' + '/'.join(parts), parts, stamp)
    assert len(resolver._validate(request(('/',), ('cover',), expected=expected)).rows[0].expected.relative_parts) == 256
    # The enclosing canonical path's leading slash remains part of its limit.
    part = 'é' * 8191 + 'x'
    expected = resolver.ExpectedSelection(1, '/', '/' + part, (part,), stamp)
    assert len(resolver._validate(request(('/',), ('cover',), expected=expected)).rows[0].expected.relative_parts[0].encode('utf-8')) == 16383
    excessive = replace(expected, relative_parts=('x' * 8193, 'y' * 8192))
    with pytest.raises(resolver.ResolutionInputInvalid, match='^artwork_source_invalid$'):
        resolve_observations(request(('/',), ('cover',), expected=excessive))
    assert resolver._owner is None


def test_admission_copies_records_and_recursively_immutable_values():
    stamp = rooted.PosixRootStamp('posix', 1, 2)
    expected = resolver.ExpectedSelection(1, '/library', '/library/cover', ('cover',), stamp)
    caller = request(('/library',), ('cover',), expected=expected)
    admitted = resolver._validate(caller)
    # Frozen dataclasses prevent ordinary mutation; copied admission must also
    # isolate references held by a caller that deliberately bypasses that guard.
    object.__setattr__(caller.roots[0], 'root_path', '/changed')
    object.__setattr__(caller.rows[0], 'stored_cover_path', 'changed')
    object.__setattr__(expected, 'resolved_cover_path', '/changed/cover')
    object.__setattr__(stamp, 'inode', 99)
    assert admitted.roots[0].root_path == '/library'
    assert admitted.rows[0].stored_cover_path == 'cover'
    assert admitted.rows[0].expected.resolved_cover_path == '/library/cover'
    assert admitted.rows[0].expected.root_stamp.inode == 2


def test_empty_rows_bypass_owner_but_still_validate_input(monkeypatch):
    def forbidden():
        raise AssertionError('empty operation performed artwork admission')
    monkeypatch.setattr(resolver, '_ProbeOwner', forbidden)
    result = resolve_observations(request(('/unrelated/nonexistent',), ()))
    assert type(result) is resolver.Success and result.rows == result.roots == ()
    assert result.counts == resolver.WorkCounts()
    with pytest.raises(resolver.ResolutionInputInvalid):
        resolve_observations(request(('/invalid/',), ()))
    assert_failure(resolve_observations(request((), ('cover',))), 'artwork_unavailable')


def test_candidate_multiplication_is_rejected_before_owner_and_filesystem(monkeypatch):
    def forbidden():
        raise AssertionError('preflight overflow attempted submission')
    monkeypatch.setattr(resolver, '_ProbeOwner', forbidden)
    value = request(('/one', '/two', '/three', '/four'), ('cover',) * 4097)
    result = resolve_observations(value)
    assert_failure(result, 'artwork_validation_limit')
    assert result.counts == resolver.WorkCounts()


def test_root_and_row_vector_limits_and_aggregate_payload_preflight():
    accepted = request(tuple(f'/root{index}' for index in range(1024)), ())
    assert type(resolve_observations(accepted)) is resolver.Success
    with pytest.raises(resolver.ResolutionInputInvalid):
        resolve_observations(request(tuple(f'/root{index}' for index in range(1025)), ()))
    maximum = request(('/',), ('missing',) * 5000)
    assert len(resolver._validate(maximum).rows) == 5000
    with pytest.raises(resolver.ResolutionInputInvalid):
        resolve_observations(request(('/',), ('missing',) * 5001))
    # Every individual spelling fits; only the encoded aggregate exceeds 32 MiB.
    cover = '/'.join(['x' * 128] * 100)
    with pytest.raises(resolver.ResolutionInputInvalid):
        resolve_observations(request(('/',), (cover,) * 3000))
    assert resolver._owner is None


def test_lexical_byte_and_component_boundaries_are_utf8_counts():
    for text, root in [('/' + 'x' * 8191, True), ('x' * 16384, False),
                       ('/' + '/'.join(['x'] * 256), True),
                       ('/'.join(['x'] * 256), False)]:
        resolver._path(text, root=root)
    for text, root in [('/' + 'x' * 8192, True), ('x' * 16385, False),
                       ('/' + 'é' * 4096, True), ('é' * 8193, False)]:
        with pytest.raises(resolver.ResolutionInputInvalid):
            resolver._path(text, root=root)
    assert resolver._canonical(['x' * 16383]) == '/' + 'x' * 16383
    with pytest.raises(resolver._Stop, match='artwork_validation_limit'):
        resolver._canonical(['x' * 16384])
    assert resolver._canonical(['x'] * 256).count('/') == 256
    with pytest.raises(resolver._Stop, match='artwork_validation_limit'):
        resolver._canonical(['x'] * 257)


@pytest.mark.parametrize('field,limit,method,args', [
    ('candidates', 16384, 'candidate', ()),
    ('expansions', 1024, 'expansion', (0,)),
    ('unique_root_components', 8192, 'root_components', (1,)),
])
def test_counter_boundaries_do_not_reset_or_overcharge(field, limit, method, args):
    counted = context()
    setattr(counted, field, limit - 1)
    getattr(counted, method)(*args)
    assert getattr(counted, field) == limit
    with pytest.raises(resolver._Stop, match='^artwork_validation_limit$'):
        getattr(counted, method)(*args)
    assert getattr(counted, field) == limit


@pytest.mark.parametrize('method,args', [('charge_component', ()), ('before_syscall', ()), ('expansion', (1,))])
def test_combined_budget_has_one_shared_final_unit(method, args):
    counted = context()
    counted.components = 100000
    counted.syscalls = 162143
    getattr(counted, method)(*args)
    assert counted.counts().combined_work == 262144
    before = counted.counts()
    with pytest.raises(resolver._Stop, match='^artwork_validation_limit$'):
        counted.before_syscall()
    assert counted.counts() == before


def test_aggregate_expansion_bytes_accept_limit_and_reject_next_byte():
    counted = context()
    counted.expansion_bytes = 1024 * 1024 - 1
    counted.expansion(1)
    assert counted.expansion_bytes == 1024 * 1024
    with pytest.raises(resolver._Stop, match='^artwork_validation_limit$'):
        counted.expansion(1)
    assert counted.expansion_bytes == 1024 * 1024 and counted.expansions == 1


@pytest.mark.parametrize('method,args', [
    ('candidate', ()), ('charge_component', ()), ('before_syscall', ()),
    ('expansion', (1,)), ('root_components', (1,)),
])
def test_each_work_primitive_checks_deadline_and_abandonment_first(method, args):
    for counted in (context(deadline=1, clock=lambda: 1), context(abandoned=lambda: True)):
        with pytest.raises(resolver._Stop, match='^artwork_probe_timeout$'):
            getattr(counted, method)(*args)
        assert counted.counts() == resolver.WorkCounts()


class TrackedContext(resolver._Context):
    def __init__(self, **kwargs):
        super().__init__(kwargs.pop('deadline', float('inf')), lambda: False,
                         clock=kwargs.pop('clock', lambda: 0.0))
        self.registered = []
        self.live = set()
        self.maximum_live = 0

    def register_close(self, fd):
        callback = super().register_close(fd)
        self.registered.append(fd)
        self.live.add(fd)
        self.maximum_live = max(self.maximum_live, len(self.live))
        def close():
            try:
                callback()
            finally:
                self.live.remove(fd)
        return close


@pytest.mark.parametrize('anchor', [False, True])
def test_root_only_observation_exact_formula_and_actual_registered_cleanup(root, anchor):
    selected = '/' if anchor else str(root)
    counted = TrackedContext()
    stamp = rooted.observe_root(rooted.RootObservationSelection('posix', selected), operation_context=counted)
    info = os.stat(selected)
    assert stamp == rooted.PosixRootStamp('posix', info.st_dev, info.st_ino)
    d = depth(selected)
    assert counted.components == d
    assert counted.syscalls == 3 + 4 * d
    assert counted.cleanup_attempts == len(counted.registered) == d + 1
    assert counted.maximum_live == d + 1 and not counted.live
    for fd in counted.registered:
        with pytest.raises(OSError):
            os.fstat(fd)
    assert counted.cleanup_failures == 0


@pytest.mark.parametrize('exists', [False, True])
def test_real_row_and_two_root_probes_have_complete_exact_counts(root, exists):
    if exists:
        regular(root / 'cover')
    result = resolve_observations(request((root,), ('cover',)))
    assert type(result) is resolver.Success
    d = depth(root)
    assert result.counts == resolver.WorkCounts(
        candidates=1, components=3 * d + 1, syscalls=9 * d + 7 + int(exists),
        expansions=0, combined_work=12 * d + 8 + int(exists),
        unique_root_components=d, cleanup_attempts=2 * (d + 1), cleanup_failures=0)


@requires_posix
def test_root_only_256_descendants_own_at_most_257_handles(tmp_path):
    deepest = tmp_path
    for _ in range(256 - depth(deepest)):
        deepest = deepest / 'd'
        deepest.mkdir()
    counted = TrackedContext()
    rooted.observe_root(rooted.RootObservationSelection('posix', str(deepest)), operation_context=counted)
    assert counted.components == 256 and counted.syscalls == 1027
    assert counted.maximum_live == counted.cleanup_attempts == 257
    assert not counted.live
    with pytest.raises(rooted.RootedFileUnavailable, match='source_invalid'):
        rooted.observe_root(rooted.RootObservationSelection('posix', str(deepest / 'one-too-many')),
                            operation_context=context())


@pytest.mark.parametrize('path', ['', 'relative', '//a', '/a/', '/a//b', '/a/./b', '/a/../b', '/a\x00b', '/\ud800'])
def test_root_only_invalid_grammar_has_no_counted_work(path):
    counted = context()
    with pytest.raises(rooted.RootedFileUnavailable, match='source_invalid'):
        rooted.observe_root(rooted.RootObservationSelection('posix', path), operation_context=counted)
    assert counted.counts() == resolver.WorkCounts()


@pytest.mark.parametrize('reason', ['limit', 'deadline'])
def test_root_probe_closes_already_owned_handles_after_work_cutoff(root, reason):
    clock_value = [0.0]
    counted = TrackedContext(deadline=1, clock=lambda: clock_value[0])
    original = counted.register_close
    def stop_after_ownership(fd):
        callback = original(fd)
        if reason == 'limit':
            counted.syscalls = 262144
        else:
            clock_value[0] = 1.0
        return callback
    counted.register_close = stop_after_ownership
    expected = 'artwork_validation_limit' if reason == 'limit' else 'artwork_probe_timeout'
    with pytest.raises(resolver._Stop, match=expected):
        rooted.observe_root(rooted.RootObservationSelection('posix', str(root)), operation_context=counted)
    assert len(counted.registered) == counted.cleanup_attempts == 1
    assert counted.cleanup_failures == 0 and not counted.live


def test_shared_counters_include_final_probe_and_failure_cleanup(root):
    value = resolver._validate(request((root,), ('missing', 'missing')))
    counted = TrackedContext()
    probe_work = depth(root) + 3 + 4 * depth(root)
    # Two missing walks cost two units per root-plus-leaf component. Leave
    # exactly the initial-probe units, so the fresh final probe cannot start.
    walk_work = 2 * 2 * (depth(root) + 1)
    counted.components = 262144 - probe_work - walk_work
    with pytest.raises(resolver._Stop, match='artwork_validation_limit'):
        resolver._run(value, counted)
    assert counted.candidates == 2
    assert counted.cleanup_attempts == depth(root) + 1
    assert counted.counts().combined_work == 262144 and not counted.live


def test_counted_close_callback_is_idempotent_even_after_fd_number_reuse(root):
    counted = context()
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    close = counted.register_close(descriptor)
    close()
    replacement = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        close()
        assert counted.cleanup_attempts == 1 and counted.cleanup_failures == 0
        assert os.fstat(replacement).st_ino == root.stat().st_ino
    finally:
        os.close(replacement)


def test_failed_close_is_counted_once_and_never_retried_against_reused_fd(root):
    counted = context()
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    close = counted.register_close(descriptor)
    # A deliberately invalidated descriptor produces a real close failure;
    # no global OS monkeypatch or fabricated successful resource is involved.
    os.close(descriptor)
    with pytest.raises(OSError):
        close()
    assert counted.cleanup_attempts == counted.cleanup_failures == 1
    assert counted._uncertain_fds == [descriptor]
    replacement = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        close()
        assert counted.cleanup_attempts == counted.cleanup_failures == 1
        assert os.fstat(replacement).st_ino == root.stat().st_ino
    finally:
        os.close(replacement)


def test_exitstack_registration_failure_discharges_exactly_once(root):
    counted = context()
    class RetainThenRaise(ExitStack):
        def callback(self, callback, *args, **kwargs):
            super().callback(callback, *args, **kwargs)
            raise RuntimeError('private registration failure')
    replacement = None
    try:
        with RetainThenRaise() as stack:
            with pytest.raises(RuntimeError, match='registration failure'):
                rooted.PosixDirectoryChain(stack, PurePosixPath(root), operation_context=counted)
            assert counted.cleanup_attempts == 1
            replacement = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        # ExitStack retained the callback before raising. Its later invocation
        # must not close a new descriptor that happens to reuse the same number.
        assert os.fstat(replacement).st_ino == root.stat().st_ino
        assert counted.cleanup_attempts == 1 and counted.cleanup_failures == 0
    finally:
        if replacement is not None:
            os.close(replacement)


def test_close_callback_construction_failure_closes_owned_fd_exactly_once(root, monkeypatch):
    counted = context()
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    class FailingThreading:
        def Lock(self):
            raise RuntimeError('private callback construction failure')
    # Replace only the resolver's module reference after its count lock exists;
    # the global threading module and all real OS operations remain untouched.
    monkeypatch.setattr(resolver, 'threading', FailingThreading())
    with pytest.raises(RuntimeError, match='callback construction failure'):
        counted.register_close(descriptor)
    assert counted.cleanup_attempts == 1 and counted.cleanup_failures == 0
    with pytest.raises(OSError):
        os.fstat(descriptor)
    replacement = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        assert os.fstat(replacement).st_ino == root.stat().st_ino
        assert counted.cleanup_attempts == 1 and counted.cleanup_failures == 0
    finally:
        os.close(replacement)


def test_concurrent_counter_snapshots_are_consistent_and_immutable():
    counted = context()
    begun, release, finished = threading.Event(), threading.Event(), threading.Event()
    snapshots, errors = [], []
    def writer():
        try:
            counted.charge_component()
            begun.set()
            assert release.wait(5)
            for _ in range(12000):
                counted.charge_component()
                counted.before_syscall()
        except BaseException as error:
            errors.append(error)
        finally:
            finished.set()
    worker = threading.Thread(target=writer, daemon=True)
    worker.start()
    try:
        assert begun.wait(5)
        first = counted.counts()
        snapshots.append(first)
        release.set()
        while not finished.wait(0.0001):
            snapshots.append(counted.counts())
        snapshots.append(counted.counts())
    finally:
        release.set()
        worker.join(5)
    assert not worker.is_alive() and not errors
    assert first.components == 1 and first.syscalls == 0
    assert snapshots[-1].components == 12001 and snapshots[-1].syscalls == 12000
    assert all(item.combined_work == item.components + item.syscalls + item.expansions
               for item in snapshots)


def test_output_budget_header_and_each_fixed_field_charge_are_exact():
    value = request(('/music/é',), ('cover',))
    text = lambda item: 4 + len(item.encode('utf-8'))
    key = ('posix', 1, '/music/é')
    key_size = 4 + text('posix') + 8 + text('/music/é')
    stamp_size = text('posix') + 8 + 8
    expected_header = 1 + sum(text(item) for item in (
        value.operation_ref, value.snapshot_digest, value.platform, value.resolver_contract)) + 4 + 4 + 8 * 8
    assert resolver._OutputBudget(value).used == expected_header
    assert resolver._key_size(key) == key_size
    assert resolver._root_size(key) == key_size + 2 * stamp_size
    expected_row = (text(value.rows[0].row_ref) + 8 + text('cover') + text('/music/é/cover')
        + 4 + text('cover') + 8 + text('/music/é') + key_size + text('missing_tail'))
    assert resolver._row_size(value.rows[0].row_ref, 'cover', '/music/é/cover',
                             ('cover',), '/music/é', key, 'missing_tail') == expected_row


def test_output_budget_exact_limit_accepts_then_rejects_without_retention():
    budget = resolver._OutputBudget(request())
    budget.reserve(32 * 1024 * 1024 - budget.used - 1)
    assert budget.used == 32 * 1024 * 1024 - 1
    budget.reserve(1)
    assert budget.used == 32 * 1024 * 1024
    with pytest.raises(resolver._Stop, match='^artwork_validation_limit$'):
        budget.reserve(1)
    assert budget.used == 32 * 1024 * 1024


@pytest.mark.parametrize('kind', ['root', 'row'])
def test_omitted_key_tuple_prefix_would_cross_output_ceiling(kind):
    value = request(('/music',), ('cover',))
    text = lambda item: 4 + len(item.encode('utf-8'))
    key = ('posix', 1, '/music')
    key_size = 4 + text('posix') + 8 + text('/music')
    if kind == 'root':
        expected = key_size + 2 * (text('posix') + 16)
        actual = resolver._root_size(key)
    else:
        expected = (text(value.rows[0].row_ref) + 8 + text('cover') + text('/music/cover')
            + 4 + text('cover') + 8 + text('/music') + key_size + text('missing_tail'))
        actual = resolver._row_size(value.rows[0].row_ref, 'cover', '/music/cover',
                                   ('cover',), '/music', key, 'missing_tail')
    assert actual == expected
    budget = resolver._OutputBudget(value)
    budget.reserve(32 * 1024 * 1024 - budget.used - (expected - 4))
    before = budget.used
    # Omitting exactly the key's four-byte tuple prefix would fit here.
    with pytest.raises(resolver._Stop, match='^artwork_validation_limit$'):
        budget.reserve(actual)
    assert budget.used == before
    exact = resolver._OutputBudget(value)
    exact.reserve(32 * 1024 * 1024 - exact.used - expected)
    exact.reserve(actual)
    assert exact.used == 32 * 1024 * 1024


def test_repeated_shared_root_output_is_charged_for_every_row(root, monkeypatch):
    regular(root / 'cover')
    reservations = []
    original = resolver._OutputBudget.reserve
    def recording(budget, size):
        reservations.append(size)
        return original(budget, size)
    monkeypatch.setattr(resolver._OutputBudget, 'reserve', recording)
    value = request((root,), ('cover', 'cover', 'cover'))
    result = resolve_observations(value)
    assert type(result) is resolver.Success
    key = ('posix', 1, str(root))
    row_size = resolver._row_size(value.rows[0].row_ref, 'cover', str(root / 'cover'),
                                 ('cover',), str(root), key, 'regular')
    assert reservations == [resolver._root_size(key), row_size, row_size, row_size]


@requires_posix
def test_small_input_long_shared_root_cannot_expand_past_output_budget(tmp_path):
    maximum = os.pathconf(tmp_path, 'PC_PATH_MAX')
    if 0 < maximum < len(str(tmp_path).encode('utf-8')) + 15 * 201 + 16:
        pytest.skip('host pathname ceiling cannot represent this real long-root fixture')
    long_root = tmp_path
    for _ in range(15):
        long_root = long_root / ('r' * 200)
        long_root.mkdir()
    value = resolver._validate(request((long_root,), ('missing',) * 5000))
    # Input contains the long root once; each output row repeats it in the
    # resolved path, selected root, and root ledger key. No fake observations.
    counted = context()
    with pytest.raises(resolver._Stop, match='^artwork_validation_limit$'):
        resolver._run(value, counted)
    assert 1 < counted.candidates < 5000
    assert counted.counts().combined_work < 262144
    assert counted.cleanup_attempts == depth(long_root) + 1
    assert counted.cleanup_failures == 0


@pytest.mark.parametrize('rows,success', [(1023, True), (1024, True), (1025, False)])
def test_expansion_budget_is_shared_across_rows(root, rows, success):
    (root / 'link').symlink_to('missing')
    value = resolver._validate(request((root,), ('link',) * rows))
    counted = context()
    if success:
        result = resolver._run(value, counted)
        assert type(result) is resolver.Success and counted.expansions == rows
    else:
        with pytest.raises(resolver._Stop, match='^artwork_validation_limit$'):
            resolver._run(value, counted)
        assert counted.expansions == 1024 and counted.candidates == 1025


def test_no_context_chain_and_legacy_describe_root_keep_existing_callback_policy(root):
    class RecordingStack(ExitStack):
        def __init__(self):
            super().__init__()
            self.callbacks = []
        def callback(self, callback, *args, **kwargs):
            self.callbacks.append((callback, args, kwargs))
            return super().callback(callback, *args, **kwargs)
    stack = RecordingStack()
    with stack:
        chain = rooted.PosixDirectoryChain(stack, PurePosixPath(root))
        chain.check()
        assert len(stack.callbacks) == depth(root) + 1
        assert all(callback is os.close and len(args) == 1 and not kwargs
                   for callback, args, kwargs in stack.callbacks)
    selection = rooted.RootSelection('posix', str(root), ('cover',))
    old = rooted.describe_root(selection)
    new = rooted.observe_root(rooted.RootObservationSelection('posix', str(root)), operation_context=context())
    assert old == new


def test_no_context_chain_keeps_custom_error_factory_on_real_identity_change(root):
    class ExistingFacadeError(ValueError):
        pass
    with ExitStack() as stack:
        chain = rooted.PosixDirectoryChain(stack, PurePosixPath(root), ExistingFacadeError)
        root.rename(root.with_name('old-library'))
        root.mkdir()
        with pytest.raises(ExistingFacadeError, match='^artwork_source_changed$'):
            chain.check()


class Slots:
    def __init__(self, maximum):
        self.semaphore = threading.BoundedSemaphore(maximum)
        self.releases = []
        self.lock = threading.Lock()

    def acquire(self, *, blocking):
        return self.semaphore.acquire(blocking=blocking)

    def release(self):
        with self.lock:
            self.releases.append(threading.get_ident())
        self.semaphore.release()


class RetainedExecutor:
    """A private retained-queue hook; no automatic work or cancellation."""
    def __init__(self, *, submit_error=None, on_submit=None):
        self.entries = []
        self.threads = []
        self.submit_error = submit_error
        self.on_submit = on_submit
        self.shutdown_calls = []

    def submit(self, function, *args):
        future = Future()
        self.entries.append((future, function, args))
        if self.on_submit is not None:
            self.on_submit()
        if self.submit_error is not None:
            raise self.submit_error
        return future

    def start(self, index):
        future, function, args = self.entries[index]
        def run():
            assert future.set_running_or_notify_cancel()
            try:
                result = function(*args)
            except BaseException as error:
                future.set_exception(error)
            else:
                future.set_result(result)
        worker = threading.Thread(target=run, daemon=True)
        self.threads.append(worker)
        worker.start()
        return worker

    def shutdown(self, *, wait, cancel_futures):
        self.shutdown_calls.append((wait, cancel_futures))

    def join(self):
        for worker in self.threads:
            worker.join(5)
            assert not worker.is_alive()


def controlled_owner(monkeypatch, executor=None):
    import concurrent.futures
    executor = executor if executor is not None else RetainedExecutor()
    startups = []
    def factory(*, max_workers, thread_name_prefix):
        startups.append((max_workers, thread_name_prefix))
        return executor
    monkeypatch.setattr(concurrent.futures, 'ThreadPoolExecutor', factory)
    owner = resolver._ProbeOwner()
    owner._slots = Slots(2)
    assert startups == [(2, 'artwork-probe')]
    return owner, executor, startups


def start_call(function):
    results, errors = [], []
    def call():
        try:
            results.append(function())
        except BaseException as error:
            errors.append(error)
    caller = threading.Thread(target=call, daemon=True)
    caller.start()
    return caller, results, errors


def test_two_submitted_abandoned_jobs_remain_busy_until_original_dequeue(monkeypatch):
    owner, executor, startups = controlled_owner(monkeypatch)
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', lambda self, timeout: False)
    value = request(('/unused',), ('cover',))
    for _ in range(2):
        assert_failure(owner.resolve(value), 'artwork_probe_timeout', complete=False)
    busy = owner.resolve(value)
    assert_failure(busy, 'artwork_probe_busy', complete=True)
    assert busy.counts == resolver.WorkCounts()
    assert len(executor.entries) == 2 and len(startups) == 1
    assert not owner._slots.releases
    assert not any(entry[0].cancelled() for entry in executor.entries)
    executor.start(0)
    executor.start(1)
    executor.join()
    assert len(owner._slots.releases) == 2
    assert set(owner._slots.releases) <= {worker.ident for worker in executor.threads}
    owner.close()
    assert executor.shutdown_calls == [(False, False)]


def test_submit_enqueue_then_raise_retains_capacity_and_never_cancels(monkeypatch):
    executor = RetainedExecutor(submit_error=RuntimeError('private submit detail'))
    owner, executor, startups = controlled_owner(monkeypatch, executor)
    value = request(('/unused',), ('cover',))
    for _ in range(2):
        result = owner.resolve(value)
        assert_failure(result, 'artwork_probe_unavailable', complete=False)
        assert 'private' not in repr(result)
    assert_failure(owner.resolve(value), 'artwork_probe_busy', complete=True)
    assert len(executor.entries) == 2 and not owner._slots.releases
    for index in range(2):
        assert not executor.entries[index][0].cancelled()
        executor.start(index)
    executor.join()
    assert len(owner._slots.releases) == 2 and len(startups) == 1
    owner.close()


def test_caller_interrupt_abandons_but_cannot_release_or_cancel(monkeypatch):
    owner, executor, _ = controlled_owner(monkeypatch)
    interrupt = KeyboardInterrupt()
    def interrupted_wait(self, timeout):
        raise interrupt
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', interrupted_wait)
    with pytest.raises(KeyboardInterrupt) as caught:
        owner.resolve(request(('/unused',), ('cover',)))
    assert caught.value is interrupt
    assert not owner._slots.releases and not executor.entries[0][0].cancelled()
    executor.start(0)
    executor.join()
    assert owner._slots.releases == [executor.threads[0].ident]
    owner.close()


def test_submit_overhead_consumes_absolute_ten_second_deadline(monkeypatch):
    now = [100.0]
    executor = RetainedExecutor(on_submit=lambda: now.__setitem__(0, 111.0))
    owner, executor, _ = controlled_owner(monkeypatch, executor)
    monkeypatch.setattr(resolver.time, 'monotonic', lambda: now[0])
    waits = []
    def wait(self, timeout):
        waits.append(timeout)
        return False
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', wait)
    assert_failure(owner.resolve(request(('/unused',), ('cover',))), 'artwork_probe_timeout', complete=False)
    assert waits == [0.0]
    job = executor.entries[0][2][0]
    assert job._deadline == 110.0
    assert not owner._slots.releases
    executor.start(0)
    executor.join()
    assert len(owner._slots.releases) == 1
    owner.close()


def test_completed_unclaimed_jobs_still_consume_both_slots(root, monkeypatch):
    owner, executor, _ = controlled_owner(monkeypatch)
    decision = threading.Event()
    completed = [threading.Event(), threading.Event()]
    seen = []
    lock = threading.Lock()
    def gated_wait(job, timeout):
        with lock:
            index = len(seen)
            seen.append(job)
        executor.start(index)
        assert job.completed.wait(5)
        completed[index].set()
        assert decision.wait(5)
        return True
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', gated_wait)
    value = request((root,), ('missing',))
    first = start_call(lambda: owner.resolve(value))
    second = None
    try:
        assert completed[0].wait(5)
        second = start_call(lambda: owner.resolve(value))
        assert completed[1].wait(5)
        assert_failure(owner.resolve(value), 'artwork_probe_busy')
        assert not owner._slots.releases
        assert len(executor.entries) == len(executor.threads) == 2
    finally:
        decision.set()
        first[0].join(5)
        if second is not None:
            second[0].join(5)
        executor.join()
        owner.close()
    assert not first[2] and not second[2]
    assert type(first[1][0]) is type(second[1][0]) is resolver.Success
    assert len(owner._slots.releases) == 2


def test_parked_workers_hold_slots_after_timeout_and_shutdown(root, monkeypatch):
    owner, executor, startups = controlled_owner(monkeypatch)
    parked = [threading.Event(), threading.Event()]
    release = threading.Event()
    real_run = resolver._run
    calls = []
    def blocked(value, operation_context):
        index = len(calls)
        calls.append(threading.get_ident())
        parked[index].set()
        assert release.wait(5)
        return real_run(value, operation_context)
    monkeypatch.setattr(resolver, '_run', blocked)
    waits = []
    def timed_out(job, timeout):
        index = len(waits)
        waits.append(job)
        executor.start(index)
        assert parked[index].wait(5)
        return False
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', timed_out)
    try:
        for _ in range(2):
            assert_failure(owner.resolve(request((root,), ('missing',))), 'artwork_probe_timeout')
        assert_failure(owner.resolve(request((root,), ('missing',))), 'artwork_probe_busy')
        assert not owner._slots.releases
        owner.close()
        assert_failure(owner.resolve(request((root,), ('missing',))), 'artwork_probe_unavailable')
        assert executor.shutdown_calls == [(False, False)]
        assert len(startups) == 1 and len(executor.threads) == 2
    finally:
        release.set()
        executor.join()
    assert len(owner._slots.releases) == 2


def test_actual_cleanup_pending_retains_descriptors_slots_and_incomplete_counts(root, monkeypatch):
    owner, executor, _ = controlled_owner(monkeypatch)
    entered = [threading.Event(), threading.Event()]
    finish = threading.Event()
    retained = []
    original_register = resolver._Context.register_close
    def blocked_register(operation_context, fd):
        callback = original_register(operation_context, fd)
        if hasattr(operation_context, '_test_retained_close'):
            return callback
        index = len(retained)
        retained.append(fd)
        operation_context._test_retained_close = fd
        def close():
            entered[index].set()
            assert finish.wait(5)
            callback()
        return close
    monkeypatch.setattr(resolver._Context, 'register_close', blocked_register)
    waits = []
    def timeout_during_cleanup(job, timeout):
        index = len(waits)
        waits.append(job)
        executor.start(index)
        assert entered[index].wait(5)
        return False
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', timeout_during_cleanup)
    snapshots = []
    try:
        for _ in range(2):
            result = owner.resolve(request((root,), ('missing',)))
            assert_failure(result, 'artwork_probe_timeout', complete=False)
            assert result.counts.cleanup_attempts == depth(root)
            snapshots.append(result.counts)
        for fd in retained:
            os.fstat(fd)
        assert not owner._slots.releases
        assert_failure(owner.resolve(request((root,), ('missing',))), 'artwork_probe_busy', complete=True)
        owner.close()
        for fd in retained:
            os.fstat(fd)
        assert not owner._slots.releases
    finally:
        finish.set()
        executor.join()
        owner.close()
    assert len(owner._slots.releases) == 2
    for fd in retained:
        with pytest.raises(OSError):
            os.fstat(fd)
    assert all(item.cleanup_attempts == depth(root) for item in snapshots)


def test_shutdown_preserves_production_event_wait_until_remaining_deadline(monkeypatch):
    now = [100.0]
    executor = RetainedExecutor(on_submit=lambda: now.__setitem__(0, 109.5))
    owner, executor, _ = controlled_owner(monkeypatch, executor)
    monkeypatch.setattr(resolver.time, 'monotonic', lambda: now[0])
    waiting = threading.Event()
    waits = []
    original_wait = rooted._SingleReleaseJob.wait
    def observed_real_wait(job, timeout):
        waits.append(timeout)
        waiting.set()
        return original_wait(job, timeout)
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', observed_real_wait)
    caller, results, errors = start_call(lambda: owner.resolve(request(('/unused',), ('missing',))))
    try:
        assert waiting.wait(5)
        job = executor.entries[0][2][0]
        owner.close()
        assert job.is_abandoned() and not job.completed.is_set()
        assert original_wait(job, 0) is False
        assert not owner._slots.releases
        assert not executor.entries[0][0].cancelled()
        executor.start(0)
        executor.join()
        # Pre-start discard releases ownership but does not set completion.
        # The real Event.wait therefore uses its original remaining timeout;
        # this is deliberately not a prompt-shutdown-wakeup assertion.
        assert not job.completed.is_set() and original_wait(job, 0) is False
        caller.join(5)
        assert not caller.is_alive() and not errors
        assert waits == [0.5]
        assert_failure(results[0], 'artwork_probe_timeout', complete=False)
    finally:
        owner.close()
        caller.join(5)
    assert len(owner._slots.releases) == 1


def test_startup_failure_is_latched_without_replacement_owner(monkeypatch):
    attempts = []
    def fail():
        attempts.append(1)
        raise RuntimeError('private executor startup detail')
    monkeypatch.setattr(resolver, '_ProbeOwner', fail)
    value = request(('/unused',), ('cover',))
    for _ in range(3):
        result = resolve_observations(value)
        assert_failure(result, 'artwork_probe_unavailable', complete=True)
        assert result.counts == resolver.WorkCounts()
    assert attempts == [1] and resolver._owner_failed and resolver._owner is None


def test_lazy_process_owner_is_reused_and_closed_owner_is_not_replaced(root, monkeypatch):
    original = resolver._ProbeOwner
    owners = []
    def make():
        value = original()
        owners.append(value)
        return value
    monkeypatch.setattr(resolver, '_ProbeOwner', make)
    value = request((root,), ('missing',))
    assert type(resolve_observations(value)) is resolver.Success
    assert type(resolve_observations(value)) is resolver.Success
    assert len(owners) == 1
    owners[0].close()
    assert_failure(resolve_observations(value), 'artwork_probe_unavailable')
    assert len(owners) == 1


def test_probe_job_claim_rechecks_absolute_expiry_under_decision_lock():
    now, released = [0.0], []
    job = rooted._SingleReleaseJob(lambda: released.append(threading.get_ident()),
        deadline=10.0, clock=lambda: now[0], quarantine_cleanup=True)
    decisions = []
    def worker():
        assert job.start_work()
        decisions.append(job.publish_and_wait(object()))
        job.release_once()
        job.release_once()
    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    try:
        assert job.completed.wait(5)
        assert not released
        with job._condition:
            now[0] = 10.0
            with pytest.raises(rooted.RootedFileUnavailable, match='^artwork_probe_timeout$'):
                job.claim()
        assert job.is_abandoned()
    finally:
        job.abandon()
        thread.join(5)
    assert not thread.is_alive() and decisions == [False]
    assert released == [thread.ident]


def test_pending_probe_cannot_release_and_claim_abandon_are_single_decisions():
    releases = []
    job = rooted._SingleReleaseJob(lambda: releases.append(1), quarantine_cleanup=True)
    job.release_once()
    assert not releases
    assert job.abandon() is True and job.abandon() is False
    assert job.start_work() is False
    assert job.publish_and_wait(object()) is False
    job.release_once()
    job.release_once()
    assert releases == [1]
    with pytest.raises(rooted.RootedFileUnavailable, match='acquisition_claim_invalid'):
        job.claim()


def test_successful_claim_and_cleanup_quarantine_are_separate_lifetimes():
    released, result = [], object()
    job = rooted._SingleReleaseJob(lambda: released.append(1), quarantine_cleanup=True)
    worker = threading.Thread(target=lambda: (job.publish_and_wait(result), job.release_once()), daemon=True)
    worker.start()
    try:
        assert job.completed.wait(5)
        job.report_cleanup_failure(OSError('uncertain close'))
        assert job.is_quarantined()
        # The owner publishes only a bounded Failure on this path. The generic
        # job tests its decision/slot mechanics without fabricating observations.
        assert job.claim() is result
        assert job.abandon() is False
    finally:
        job.abandon()
        worker.join(5)
    job.release_once()
    assert not worker.is_alive() and not released


def test_reported_cleanup_failure_returns_no_success_and_permanently_loses_slot(root, monkeypatch):
    owner, executor, _ = controlled_owner(monkeypatch)
    original = resolver._run
    def real_work_then_uncertain_cleanup(value, operation_context):
        result = original(value, operation_context)
        operation_context.report_cleanup_failure()
        return result
    monkeypatch.setattr(resolver, '_run', real_work_then_uncertain_cleanup)
    started = []
    def run_and_wait(job, timeout):
        index = len(started)
        started.append(job)
        executor.start(index)
        return job.completed.wait(5)
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', run_and_wait)
    for _ in range(2):
        result = owner.resolve(request((root,), ('missing',)))
        assert_failure(result, 'artwork_probe_unavailable', complete=True)
        assert result.counts.cleanup_failures == 1
        assert result.counts.cleanup_attempts == 2 * (depth(root) + 1)
    executor.join()
    assert_failure(owner.resolve(request((root,), ('missing',))), 'artwork_probe_busy')
    assert not owner._slots.releases and all(job.is_quarantined() for job in started)
    owner.close()


@pytest.mark.parametrize('ordinary_probe_error', [False, True])
def test_actual_counted_close_failure_overrides_probe_error_and_quarantines_owner(root, monkeypatch, ordinary_probe_error):
    owner, executor, startups = controlled_owner(monkeypatch)
    selected = [root / 'one', root / 'two']
    for path in selected:
        path.mkdir()
    original_probe = resolver.observe_root
    def maybe_break_selected_root(selection, *, operation_context):
        if ordinary_probe_error:
            path = selected[0] if selection.root_path == str(selected[0]) else selected[1]
            saved = path.with_name(path.name + '-saved')
            path.rename(saved)
            path.symlink_to(saved, target_is_directory=True)
        return original_probe(selection, operation_context=operation_context)
    monkeypatch.setattr(resolver, 'observe_root', maybe_break_selected_root)
    original_register = resolver._Context.register_close
    contexts = []
    def failing_actual_close(operation_context, fd):
        callback = original_register(operation_context, fd)
        if hasattr(operation_context, '_test_failed_fd'):
            return callback
        operation_context._test_failed_fd = fd
        contexts.append(operation_context)
        attempted = [False]
        def close():
            if not attempted[0]:
                attempted[0] = True
                os.close(fd)
            # The actual counted callback now receives EBADF, records uncertain
            # ownership, and must never retry that descriptor number.
            callback()
        return close
    monkeypatch.setattr(resolver._Context, 'register_close', failing_actual_close)
    jobs = []
    def start_and_wait(job, timeout):
        index = len(jobs)
        jobs.append(job)
        executor.start(index)
        return job.completed.wait(5)
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', start_and_wait)
    try:
        for path in selected:
            result = owner.resolve(request((path,), ('missing',)))
            assert_failure(result, 'artwork_probe_unavailable', complete=True)
            assert result.counts.cleanup_failures == 1
            assert result.counts.cleanup_attempts == depth(path) + (0 if ordinary_probe_error else 1)
        executor.join()
        assert len(contexts) == len(jobs) == len(owner._quarantined) == 2
        for job, operation_context in zip(jobs, contexts):
            assert job.is_quarantined() and owner._quarantined[job] is operation_context
            assert operation_context._uncertain_fds == [operation_context._test_failed_fd]
            job.release_once()
            assert operation_context.counts().cleanup_failures == 1
        assert not owner._slots.releases
        assert_failure(owner.resolve(request(('/unused',), ('missing',))), 'artwork_probe_busy', complete=True)
        assert len(startups) == 1 and len(executor.entries) == 2
    finally:
        owner.close()
        executor.join()
    assert not owner._slots.releases


def test_real_filesystem_and_cleanup_operations_run_outside_all_state_locks(root, monkeypatch):
    owner, executor, _ = controlled_owner(monkeypatch)
    (root / 'link').symlink_to('missing')
    active, operations, violations = [], [], []
    watched = ('lstat', 'readlink', 'open', 'fstat', 'stat', 'close')
    originals = {name: getattr(os, name) for name in watched}
    def wrap(name):
        def checked(*args, **kwargs):
            job, operation_context = active[0]
            acquired = []
            def inspect_locks():
                for lock in (owner._lock, job._condition, operation_context._counts_lock):
                    available = lock.acquire(blocking=False)
                    acquired.append(available)
                    if available:
                        lock.release()
            observer = threading.Thread(target=inspect_locks, daemon=True)
            observer.start()
            observer.join(2)
            if observer.is_alive() or acquired != [True, True, True]:
                violations.append((name, tuple(acquired), observer.is_alive()))
                raise AssertionError('filesystem operation entered under a state lock')
            operations.append(name)
            return originals[name](*args, **kwargs)
        return checked
    wrappers = {name: wrap(name) for name in watched}
    class LocalOSProxy:
        def __getattr__(self, name):
            if name in wrappers:
                return wrappers[name]
            if name in ('supports_dir_fd', 'supports_follow_symlinks'):
                actual = getattr(os, name)
                # Preserve actual platform support; only a wrapper around an
                # already-supported native operation earns membership.
                return actual | {wrappers[key] for key in watched if originals[key] in actual}
            return getattr(os, name)
    proxy = LocalOSProxy()
    monkeypatch.setattr(resolver, 'os', proxy)
    monkeypatch.setattr(rooted, 'os', proxy)
    def start_and_wait(job, timeout):
        operation_context = executor.entries[0][2][2]
        active.append((job, operation_context))
        executor.start(0)
        return job.completed.wait(5)
    monkeypatch.setattr(rooted._SingleReleaseJob, 'wait', start_and_wait)
    try:
        result = owner.resolve(request((root,), ('link',)))
        executor.join()
        assert not violations
        assert type(result) is resolver.Success
        assert set(operations) == set(watched)
        assert len(owner._slots.releases) == 1
    finally:
        owner.close()
        executor.join()


def test_unexpected_worker_error_is_bounded_and_preserves_terminal_counts(monkeypatch):
    def fail(value, operation_context):
        operation_context.charge_component()
        raise RuntimeError('secret path /private/library')
    monkeypatch.setattr(resolver, '_run', fail)
    result = resolve_observations(request(('/unused',), ('cover',)))
    assert_failure(result, 'artwork_probe_unavailable', complete=True)
    assert result.counts.components == 1
    assert 'secret' not in repr(result) and '/private' not in repr(result)


def test_legacy_acquisition_defaults_remain_two_workers_six_outstanding(monkeypatch):
    import concurrent.futures
    executor = RetainedExecutor()
    startups = []
    def make(*, max_workers, thread_name_prefix):
        startups.append((max_workers, thread_name_prefix))
        return executor
    monkeypatch.setattr(concurrent.futures, 'ThreadPoolExecutor', make)
    budget = rooted.AcquisitionBudget()
    assert startups == [(2, 'rooted-source')]
    waits = []
    def timeout(job, duration):
        waits.append(duration)
        return False
    monkeypatch.setattr(rooted._AcquisitionJob, 'wait', timeout)
    for _ in range(6):
        with pytest.raises(rooted.RootedFileUnavailable, match='^acquisition_deadline$'):
            budget.acquire(None)
    with pytest.raises(rooted.RootedFileUnavailable, match='^acquisition_busy$'):
        budget.acquire(None)
    assert waits == [2.0] * 6 and len(executor.entries) == 6
    assert not any(entry[0].cancelled() for entry in executor.entries)
    for index in range(6):
        executor.start(index)
    executor.join()


@pytest.mark.parametrize('timeout', [True, False, -1, 2.001, None, '1'])
def test_legacy_acquisition_timeout_validation_is_unchanged(timeout):
    executor = RetainedExecutor()
    budget = rooted.AcquisitionBudget(executor)
    with pytest.raises(rooted.RootedFileUnavailable, match='^acquisition_deadline_invalid$'):
        budget.acquire(None, timeout=timeout)
    assert not executor.entries


def test_legacy_acquisition_delivers_same_lease_without_disposal(monkeypatch):
    executor = RetainedExecutor()
    budget = rooted.AcquisitionBudget(executor)
    budget._slots = Slots(6)
    closed, calls = [], []
    class Lease:
        def close(self):
            closed.append(threading.get_ident())
    lease, selected, stamp = Lease(), object(), object()
    def factory(selection, expected_root_stamp):
        calls.append((selection, expected_root_stamp))
        return lease
    def start_and_wait(job, timeout):
        executor.start(0)
        return job.completed.wait(5)
    monkeypatch.setattr(rooted._AcquisitionJob, 'wait', start_and_wait)
    assert budget.acquire(selected, stamp, factory=factory) is lease
    executor.join()
    assert calls == [(selected, stamp)] and not closed
    assert budget._slots.releases == [executor.threads[0].ident]
    lease.close()
    assert len(closed) == 1


def test_legacy_cleanup_failure_releases_once_without_probe_quarantine(monkeypatch):
    executor = RetainedExecutor()
    budget = rooted.AcquisitionBudget(executor)
    budget._slots = Slots(6)
    entered, finish = threading.Event(), threading.Event()
    closes = []
    class Lease:
        def close(self):
            closes.append(threading.get_ident())
            raise OSError('legacy disposal failure')
    def factory(*args):
        entered.set()
        assert finish.wait(5)
        return Lease()
    def abandon_after_start(job, timeout):
        executor.start(0)
        assert entered.wait(5)
        return False
    monkeypatch.setattr(rooted._AcquisitionJob, 'wait', abandon_after_start)
    try:
        with pytest.raises(rooted.RootedFileUnavailable, match='^acquisition_deadline$'):
            budget.acquire(None, factory=factory)
        assert not budget._slots.releases
    finally:
        finish.set()
        executor.join()
    job = executor.entries[0][1].__self__
    assert type(executor.entries[0][0].exception()) is OSError
    assert not job.is_quarantined() and job.cleanup_error is not None
    assert closes == budget._slots.releases == [executor.threads[0].ident]


def test_legacy_factory_error_identity_and_uncertain_submission_policy(monkeypatch):
    executor = RetainedExecutor()
    budget = rooted.AcquisitionBudget(executor)
    budget._slots = Slots(6)
    failure = RuntimeError('factory error identity')
    def factory(*args):
        raise failure
    monkeypatch.setattr(rooted._AcquisitionJob, 'wait',
        lambda job, timeout: (executor.start(0), job.completed.wait(5))[1])
    with pytest.raises(RuntimeError) as caught:
        budget.acquire(None, factory=factory)
    executor.join()
    assert caught.value is failure and len(budget._slots.releases) == 1
    rejected = RetainedExecutor(submit_error=RuntimeError('enqueued then raised'))
    budget = rooted.AcquisitionBudget(rejected)
    budget._slots = Slots(6)
    for _ in range(6):
        with pytest.raises(RuntimeError, match='enqueued then raised'):
            budget.acquire(None)
    with pytest.raises(rooted.RootedFileUnavailable, match='acquisition_busy'):
        budget.acquire(None)
    assert not budget._slots.releases
    for index in range(6):
        assert not rejected.entries[index][0].cancelled()
        rejected.start(index)
    rejected.join()
    assert len(budget._slots.releases) == 6
