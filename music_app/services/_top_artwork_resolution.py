"""Dormant bounded POSIX observations. Values convey no database authority.

Only the fixed resolver entry may submit immutable inputs. No connection, policy,
configuration, decoder, provider or image-gate owner belongs in this module.
"""
from collections import deque
from dataclasses import dataclass
import os
import re
import stat
import threading
import time

from music_app.services.rooted_local_file import (
    PosixRootStamp, RootObservationSelection, observe_root,
    RootedFileUnavailable, _SingleReleaseJob, _require_posix,
)

CONTRACT = 'artwork-posix-bounded-selection-v1'
_UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z', re.ASCII)
_DIGEST = re.compile(r'[0-9a-f]{64}\Z', re.ASCII)
_MAX_ID = 9223372036854775807
_MAX_PAYLOAD = 32 * 1024 * 1024
_ERRORS = frozenset(('artwork_source_invalid', 'artwork_unavailable',
    'artwork_source_changed', 'artwork_validation_limit', 'artwork_probe_busy',
    'artwork_probe_timeout', 'artwork_probe_unavailable'))


class ResolutionInputInvalid(ValueError):
    def __init__(self):
        super().__init__('artwork_source_invalid')


class _Stop(ValueError):
    pass


@dataclass(frozen=True)
class RootInput:
    root_id: int
    root_path: str


@dataclass(frozen=True)
class ExpectedSelection:
    root_id: int
    root_path: str
    resolved_cover_path: str
    relative_parts: tuple
    root_stamp: PosixRootStamp


@dataclass(frozen=True)
class RowInput:
    row_ref: str
    local_album_id: int
    stored_cover_path: str
    expected: object = None


@dataclass(frozen=True)
class ResolutionInput:
    operation_ref: str
    snapshot_digest: str
    platform: str
    resolver_contract: str
    roots: tuple
    rows: tuple
    ceilings_version: int = 1


@dataclass(frozen=True)
class WorkCounts:
    candidates: int = 0
    components: int = 0
    syscalls: int = 0
    expansions: int = 0
    combined_work: int = 0
    unique_root_components: int = 0
    cleanup_attempts: int = 0
    cleanup_failures: int = 0


@dataclass(frozen=True)
class RowObservation:
    row_ref: str
    local_album_id: int
    stored_cover_path: str
    resolved_cover_path: str
    relative_parts: tuple
    root_id: int
    root_path: str
    root_ledger_key: tuple
    leaf_state: str


@dataclass(frozen=True)
class RootObservation:
    root_ledger_key: tuple
    initial: PosixRootStamp
    final: PosixRootStamp


@dataclass(frozen=True)
class Success:
    operation_ref: str
    snapshot_digest: str
    platform: str
    resolver_contract: str
    rows: tuple
    roots: tuple
    counts: WorkCounts


@dataclass(frozen=True)
class Failure:
    operation_ref: str
    snapshot_digest: str
    platform: str
    resolver_contract: str
    error_code: str
    counts: WorkCounts
    counts_complete: bool


def _invalid():
    raise ResolutionInputInvalid()


def _identifier(value):
    return type(value) is int and 1 <= value <= _MAX_ID


def _uuid(value):
    return (type(value) is str and len(value) == 36 and _UUID.fullmatch(value) is not None
            and value != '00000000-0000-0000-0000-000000000000')


def _path(value, *, root=False, absolute=False):
    maximum = 8192 if root else 16384
    if type(value) is not str or not value or len(value) > maximum:
        _invalid()
    try:
        size = len(value.encode('utf-8'))
    except UnicodeError:
        _invalid()
    if size > maximum or '\x00' in value or '://' in value:
        _invalid()
    if (root or absolute) and not value.startswith('/'):
        _invalid()
    parts = value.split('/')[1:] if value.startswith('/') else value.split('/')
    if value == '/':
        parts = []
    if len(parts) > 256 or any(not p or p in ('.', '..') for p in parts):
        _invalid()
    return tuple(parts), size


def _record(value, expected_type, fields):
    if type(value) is not expected_type:
        _invalid()
    values = value.__dict__
    # Bound before iterating keys, and reject exotic key comparison callbacks.
    if type(values) is not dict or len(values) != len(fields):
        _invalid()
    if any(type(key) is not str or len(key) > 32 for key in values):
        _invalid()
    if values.keys() != fields:
        _invalid()


def _copy_input(value):
    # Copy the bounded object graph before validation; even a caller bypassing
    # frozen dataclasses with object.__setattr__ cannot mutate an admitted job.
    _record(value, ResolutionInput, {'operation_ref', 'snapshot_digest', 'platform',
        'resolver_contract', 'roots', 'rows', 'ceilings_version'})
    roots, rows = value.roots, value.rows
    if type(roots) is not tuple or len(roots) > 1024 or type(rows) is not tuple or len(rows) > 5000:
        _invalid()
    copied_roots, copied_rows = [], []
    for root in roots:
        _record(root, RootInput, {'root_id', 'root_path'})
        copied_roots.append(RootInput(root.root_id, root.root_path))
    for row in rows:
        _record(row, RowInput, {'row_ref', 'local_album_id', 'stored_cover_path', 'expected'})
        expected = row.expected
        if expected is not None:
            _record(expected, ExpectedSelection, {'root_id', 'root_path',
                'resolved_cover_path', 'relative_parts', 'root_stamp'})
            _record(expected.root_stamp, PosixRootStamp, {'platform', 'device', 'inode'})
            stamp = expected.root_stamp
            expected = ExpectedSelection(expected.root_id, expected.root_path,
                expected.resolved_cover_path, expected.relative_parts,
                PosixRootStamp(stamp.platform, stamp.device, stamp.inode))
        copied_rows.append(RowInput(row.row_ref, row.local_album_id, row.stored_cover_path, expected))
    return ResolutionInput(value.operation_ref, value.snapshot_digest, value.platform,
        value.resolver_contract, tuple(copied_roots), tuple(copied_rows), value.ceilings_version)


def _validate(value):
    """No Failure exists until every input field has been admitted."""
    try:
        value = _copy_input(value)
    except AttributeError:
        _invalid()
    if (type(value) is not ResolutionInput or not _uuid(value.operation_ref)
            or type(value.snapshot_digest) is not str or len(value.snapshot_digest) != 64
            or _DIGEST.fullmatch(value.snapshot_digest) is None
            or type(value.platform) is not str or value.platform != 'posix'
            or type(value.resolver_contract) is not str or value.resolver_contract != CONTRACT
            or type(value.ceilings_version) is not int or value.ceilings_version != 1
            or type(value.roots) is not tuple or len(value.roots) > 1024
            or type(value.rows) is not tuple or len(value.rows) > 5000):
        _invalid()
    payload, last, refs = 512, 0, set()
    for root in value.roots:
        if type(root) is not RootInput or not _identifier(root.root_id) or root.root_id <= last:
            _invalid()
        last = root.root_id
        _, size = _path(root.root_path, root=True)
        payload += size + 128
        if payload > _MAX_PAYLOAD:
            _invalid()
    for row in value.rows:
        if (type(row) is not RowInput or not _uuid(row.row_ref) or row.row_ref in refs
                or not _identifier(row.local_album_id)):
            _invalid()
        refs.add(row.row_ref)
        _, size = _path(row.stored_cover_path)
        payload += size + 256
        expected = row.expected
        if expected is not None:
            if (type(expected) is not ExpectedSelection or not _identifier(expected.root_id)
                    or type(expected.relative_parts) is not tuple
                    or not 1 <= len(expected.relative_parts) <= 256
                    or type(expected.root_stamp) is not PosixRootStamp
                    or type(expected.root_stamp.platform) is not str or expected.root_stamp.platform != 'posix'
                    or type(expected.root_stamp.device) is not int or expected.root_stamp.device < 0
                    or type(expected.root_stamp.inode) is not int or expected.root_stamp.inode < 0):
                _invalid()
            root_parts, size = _path(expected.root_path, root=True)
            cover_parts, cover_size = _path(expected.resolved_cover_path, absolute=True)
            relative_size = 0
            for part in expected.relative_parts:
                # Character bounds precede every scan/encoding; UTF-8 bounds
                # precede retaining/expanding the complete relative vector.
                if type(part) is not str or not 1 <= len(part) <= 16384:
                    _invalid()
                try:
                    part_size = len(part.encode('utf-8'))
                except UnicodeError:
                    _invalid()
                relative_size += part_size
                if (part_size > 16384 or relative_size > 16384
                        or part in ('.', '..') or '/' in part or '\x00' in part):
                    _invalid()
            if tuple(cover_parts) != (*root_parts, *expected.relative_parts):
                _invalid()
            # Proof identities must fit a bounded internal representation too.
            if expected.root_stamp.device.bit_length() > 64 or expected.root_stamp.inode.bit_length() > 64:
                _invalid()
            payload += size + cover_size + relative_size + 256
        if payload > _MAX_PAYLOAD:
            _invalid()
    # All records and nested values are now exact frozen types/immutable tuples.
    return value


def _failure(value, code, counts=WorkCounts(), *, counts_complete=True):
    if code not in _ERRORS:
        code = 'artwork_probe_unavailable'
    return Failure(value.operation_ref, value.snapshot_digest, value.platform,
                   value.resolver_contract, code, counts, counts_complete)


class _Context:
    def __init__(self, deadline, abandoned, clock=None):
        self.deadline, self.abandoned = deadline, abandoned
        self.clock = time.monotonic if clock is None else clock
        self.candidates = self.components = self.syscalls = self.expansions = 0
        self.unique_root_components = self.cleanup_attempts = self.cleanup_failures = 0
        self.expansion_bytes = 0
        self._counts_lock = threading.Lock()
        self._uncertain_fds = []

    def check(self):
        if self.abandoned() or self.clock() >= self.deadline:
            raise _Stop('artwork_probe_timeout')

    def _work(self, field):
        self.check()
        with self._counts_lock:
            if self.components + self.syscalls + self.expansions >= 262144:
                raise _Stop('artwork_validation_limit')
            setattr(self, field, getattr(self, field) + 1)

    def charge_component(self):
        self._work('components')

    def before_syscall(self):
        self._work('syscalls')

    def candidate(self):
        self.check()
        with self._counts_lock:
            if self.candidates >= 16384:
                raise _Stop('artwork_validation_limit')
            self.candidates += 1

    def expansion(self, size):
        if self.expansions >= 1024 or self.expansion_bytes + size > 1024 * 1024:
            raise _Stop('artwork_validation_limit')
        self._work('expansions')
        with self._counts_lock:
            self.expansion_bytes += size

    def root_components(self, count):
        self.check()
        if self.unique_root_components + count > 8192:
            raise _Stop('artwork_validation_limit')
        with self._counts_lock:
            self.unique_root_components += count

    def register_close(self, fd):
        try:
            lock, attempted = threading.Lock(), [False]
            def close():
                with lock:
                    if attempted[0]:
                        return
                    attempted[0] = True
                self._close(fd)
            return close
        except BaseException:
            self._close(fd)
            raise

    def _close(self, fd):
        with self._counts_lock:
            self.cleanup_attempts += 1
        try:
            os.close(fd)
        except BaseException:
            self._uncertain_fds.append(fd)
            self.report_cleanup_failure()
            raise

    def report_cleanup_failure(self):
        with self._counts_lock:
            self.cleanup_failures += 1

    def counts(self):
        with self._counts_lock:
            return WorkCounts(self.candidates, self.components, self.syscalls,
                self.expansions, self.components + self.syscalls + self.expansions,
                self.unique_root_components, self.cleanup_attempts, self.cleanup_failures)


def _canonical(parts):
    value = '/' + '/'.join(parts)
    if len(parts) > 256 or len(value.encode('utf-8')) > 16384:
        raise _Stop('artwork_validation_limit')
    return value


def _walk(path, context):
    """Counted POSIX stack; never Path.resolve, expanduser or cwd."""
    pending = deque(path.split('/')[1:])
    stack, missing, expansions, directory_required = [], False, 0, False
    if not pending or pending == deque(['']):
        raise _Stop('artwork_unavailable')
    while pending:
        context.charge_component()
        part = pending.popleft()
        if part in ('', '.'):
            continue
        if part == '..':
            if missing:
                raise _Stop('artwork_unavailable')
            if stack:
                stack.pop()
            continue
        candidate = _canonical((*stack, part))
        if missing:
            stack.append(part)
            continue
        context.before_syscall()
        try:
            info = os.lstat(candidate)
        except FileNotFoundError:
            missing = True
            stack.append(part)
            continue
        except OSError:
            raise _Stop('artwork_unavailable') from None
        if stat.S_ISLNK(info.st_mode):
            if expansions >= 40:
                raise _Stop('artwork_validation_limit')
            context.before_syscall()
            try:
                target = os.readlink(candidate)
                size = len(target.encode('utf-8'))
            except (OSError, UnicodeError):
                raise _Stop('artwork_unavailable') from None
            if not target or '\x00' in target or size > 16384:
                raise _Stop('artwork_unavailable')
            tokens = target.split('/')
            if len(tokens) > 256 or len(tokens) + len(pending) > 256:
                raise _Stop('artwork_validation_limit')
            if sum(len(p.encode('utf-8')) + 1 for p in (*tokens, *pending)) > 32768:
                raise _Stop('artwork_validation_limit')
            context.expansion(size)
            expansions += 1
            if not pending and target.endswith('/'):
                directory_required = True
            if target.startswith('/'):
                stack = []
            pending.extendleft(reversed(tokens))
            continue
        if pending:
            if not stat.S_ISDIR(info.st_mode):
                raise _Stop('artwork_unavailable')
        elif not stat.S_ISREG(info.st_mode) or directory_required:
            raise _Stop('artwork_unavailable')
        stack.append(part)
    if not stack or directory_required:
        raise _Stop('artwork_unavailable')
    if not missing:
        # A target ending in dot/parent may finish at an already visited
        # directory. Observe the actual final kind rather than infer a leaf.
        context.before_syscall()
        try:
            final = os.lstat(_canonical(stack))
        except FileNotFoundError:
            missing = True
        except OSError:
            raise _Stop('artwork_unavailable') from None
        else:
            if not stat.S_ISREG(final.st_mode):
                raise _Stop('artwork_unavailable')
    return _canonical(stack), 'missing_tail' if missing else 'regular'


def _below(path, root):
    return path.startswith(root + '/') if root != '/' else path.startswith('/') and path != '/'


def _text_size(value):
    # Private budget representation: uint32 length + strict UTF-8 bytes.
    # This is not the persistence codec or a public wire format.
    return 4 + len(value.encode('utf-8'))


def _probe_root(selection, context):
    try:
        return observe_root(selection, operation_context=context)
    except OSError:
        # Ordinary selected-root observation failure has no fallback. The
        # owner separately overrides this result if counted cleanup failed.
        raise _Stop('artwork_unavailable') from None


def _key_size(key):
    return 4 + _text_size(key[0]) + 8 + _text_size(key[2])


def _root_size(key):
    # Key plus two fixed (platform string, uint64 device, uint64 inode) stamps.
    return _key_size(key) + 2 * (_text_size('posix') + 16)


def _row_size(row_ref, stored, resolved, relative, root, key, leaf_state):
    return (_text_size(row_ref) + 8 + _text_size(stored) + _text_size(resolved)
        + 4 + sum(_text_size(part) for part in relative) + 8 + _text_size(root)
        + _key_size(key) + _text_size(leaf_state))


class _OutputBudget:
    def __init__(self, value):
        # Tag, four header strings, two tuple length prefixes, eight uint64
        # counters. Every repeated field is charged, even if Python shares it.
        self.used = (1 + _text_size(value.operation_ref) + _text_size(value.snapshot_digest)
            + _text_size(value.platform) + _text_size(value.resolver_contract) + 8 + 64)

    def reserve(self, size):
        if self.used + size > _MAX_PAYLOAD:
            raise _Stop('artwork_validation_limit')
        self.used += size


def _run(value, context):
    if not value.rows:
        return Success(value.operation_ref, value.snapshot_digest, value.platform,
                       value.resolver_contract, (), (), context.counts())
    _require_posix()
    if not value.roots:
        raise _Stop('artwork_unavailable')
    candidates = sum(1 if row.stored_cover_path.startswith('/') else len(value.roots) for row in value.rows)
    if candidates > 16384:
        raise _Stop('artwork_validation_limit')
    ledger, rows, output = {}, [], _OutputBudget(value)
    for row in value.rows:
        paths = {}
        if row.stored_cover_path.startswith('/'):
            context.candidate()
            resolved, leaf_state = _walk(row.stored_cover_path, context)
            if any(_below(resolved, root.root_path) for root in value.roots):
                paths[resolved] = leaf_state
        else:
            for root in value.roots:
                context.candidate()
                candidate = root.root_path.rstrip('/') + '/' + row.stored_cover_path
                if len(candidate.encode('utf-8')) > 16384 or len(candidate.split('/')) - 1 > 256:
                    raise _Stop('artwork_validation_limit')
                resolved, leaf_state = _walk(candidate, context)
                if _below(resolved, root.root_path):
                    paths[resolved] = leaf_state
        if len(paths) != 1:
            raise _Stop('artwork_unavailable')
        resolved, leaf_state = next(iter(paths.items()))
        roots = [root for root in value.roots if _below(resolved, root.root_path)]
        selected = max(roots, key=lambda root: (
            0 if root.root_path == '/' else len(root.root_path.split('/')) - 1,
            -root.root_id))
        # A more-specific root equal to the leaf is not a fallback candidate.
        if any(root.root_path == resolved for root in value.roots):
            raise _Stop('artwork_unavailable')
        key = ('posix', selected.root_id, selected.root_path)
        if key not in ledger:
            # Reserve both initial and final ledger metadata before retaining
            # the first stamp; no aggregate encoding or partial output escapes.
            output.reserve(_root_size(key))
            context.root_components(0 if selected.root_path == '/' else len(selected.root_path.split('/')) - 1)
            observed = _probe_root(RootObservationSelection('posix', selected.root_path), context)
            if not (0 <= observed.device <= 18446744073709551615
                    and 0 <= observed.inode <= 18446744073709551615):
                raise _Stop('artwork_unavailable')
            ledger[key] = observed
        relative = tuple(resolved[len(selected.root_path.rstrip('/')) + 1:].split('/'))
        expected = row.expected
        if expected is not None and (
                expected.root_id != selected.root_id or expected.root_path != selected.root_path
                or expected.resolved_cover_path != resolved or expected.relative_parts != relative
                or expected.root_stamp != ledger[key]):
            raise _Stop('artwork_source_changed')
        output.reserve(_row_size(row.row_ref, row.stored_cover_path, resolved,
            relative, selected.root_path, key, leaf_state))
        rows.append(RowObservation(row.row_ref, row.local_album_id, row.stored_cover_path,
            resolved, relative, selected.root_id, selected.root_path, key, leaf_state))
    roots = []
    for key in sorted(ledger, key=lambda item: item[1]):
        final = _probe_root(RootObservationSelection(key[0], key[2]), context)
        if final != ledger[key]:
            raise _Stop('artwork_source_changed')
        roots.append(RootObservation(key, ledger[key], final))
    context.check()
    return Success(value.operation_ref, value.snapshot_digest, value.platform,
                   value.resolver_contract, tuple(rows), tuple(roots), context.counts())


class _ProbeOwner:
    """Exactly two outstanding jobs, including abandoned/uncertain work.

    Only process teardown replaces this owner. Blocking callers must be off-loop
    and outside all database transactions; the primitive has no DB dependency.
    """
    def __init__(self):
        from concurrent.futures import ThreadPoolExecutor
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='artwork-probe')
        self._slots = threading.BoundedSemaphore(2)
        self._lock = threading.Lock()
        self._closed = False
        self._jobs = set()
        self._quarantined = {}

    def resolve(self, value):
        deadline = time.monotonic() + 10.0
        with self._lock:
            if self._closed:
                return _failure(value, 'artwork_probe_unavailable')
            if not self._slots.acquire(blocking=False):
                return _failure(value, 'artwork_probe_busy')
            job = _SingleReleaseJob(self._slots.release, deadline=deadline,
                                    quarantine_cleanup=True)
            self._jobs.add(job)
        context = _Context(deadline, job.is_abandoned)
        try:
            self._executor.submit(self._work, job, value, context)
        except BaseException as error:
            # A submit failure may follow enqueue. No caller-side slot release,
            # Future.cancel or replacement executor can prove ownership gone.
            job.abandon()
            if not isinstance(error, Exception):
                raise
            return _failure(value, 'artwork_probe_unavailable', context.counts(), counts_complete=False)
        try:
            if not job.wait(max(0.0, deadline - time.monotonic())):
                job.abandon()
                return _failure(value, 'artwork_probe_timeout', context.counts(), counts_complete=False)
            try:
                return job.claim()
            except RootedFileUnavailable as error:
                job.abandon()
                return _failure(value, str(error), context.counts(), counts_complete=False)
        except BaseException:
            job.abandon()
            raise

    def _work(self, job, value, context):
        try:
            if not job.start_work():
                return
            try:
                result = _run(value, context)
            except _Stop as error:
                result = _failure(value, str(error), context.counts())
            except RootedFileUnavailable as error:
                code = 'artwork_source_changed' if str(error) in (
                    'artwork_source_changed', 'source_changed') else 'artwork_unavailable'
                result = _failure(value, code, context.counts())
            except BaseException:
                result = _failure(value, 'artwork_probe_unavailable', context.counts())
            if context.cleanup_failures:
                job.report_cleanup_failure()
                result = _failure(value, 'artwork_probe_unavailable', context.counts())
            # _run and its ExitStacks have discharged all ownership before this
            # publication. The shared job arbitrates expiry vs synchronized claim.
            job.publish_and_wait(result)
        finally:
            if context.cleanup_failures:
                job.report_cleanup_failure()
            job.release_once()
            with self._lock:
                if job.is_quarantined():
                    self._quarantined[job] = context
                else:
                    self._jobs.discard(job)

    def close(self):
        # Internal process-shutdown hook only. Never cancel retained queue work.
        with self._lock:
            self._closed = True
            jobs = tuple(self._jobs)
        for job in jobs:
            job.abandon()
        self._executor.shutdown(wait=False, cancel_futures=False)


_owner_lock = threading.Lock()
_owner = None
_owner_failed = False


def resolve(value):
    """Fixed dormant entry: immutable values only, no injected collaborators."""
    value = _validate(value)
    if not value.rows:
        return Success(value.operation_ref, value.snapshot_digest, value.platform,
                       value.resolver_contract, (), (), WorkCounts())
    if not value.roots:
        return _failure(value, 'artwork_unavailable')
    required = sum(1 if row.stored_cover_path.startswith('/') else len(value.roots) for row in value.rows)
    if required > 16384:
        return _failure(value, 'artwork_validation_limit')
    global _owner, _owner_failed
    with _owner_lock:
        if _owner_failed:
            return _failure(value, 'artwork_probe_unavailable')
        if _owner is None:
            try:
                _owner = _ProbeOwner()
            except BaseException as error:
                _owner_failed = True
                if not isinstance(error, Exception):
                    raise
                return _failure(value, 'artwork_probe_unavailable')
        owner = _owner
    return owner.resolve(value)
