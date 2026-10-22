"""W1 synthetic native/CRT ownership; no genuine kernel failure is asserted.

Injected native operations and ctypes-__new__ bridge seams only. No DLL, app,
configuration, decoder or real file descriptor is opened by these cases.
"""
import gc
import importlib
from pathlib import Path
import sys
from types import SimpleNamespace
import weakref

import pytest


def _checkout_imports():
    here = Path(__file__).resolve(strict=True)
    if here.parts[-3:] != ('tests', 'py', 'test_rooted_windows_cleanup_ownership.py'):
        raise AssertionError('unexpected synthetic suite origin')
    root = here.parents[2]
    expected = {
        'music_app': root / 'music_app/__init__.py',
        'music_app.services': root / 'music_app/services/__init__.py',
        'music_app.services.rooted_local_file':
            root / 'music_app/services/rooted_local_file.py',
        'music_app.services._rooted_local_file_windows':
            root / 'music_app/services/_rooted_local_file_windows.py',
    }
    if not all(path.is_file() for path in expected.values()):
        raise AssertionError('incomplete trusted checkout')
    # Coexist with ordinary whole-repository collection. Only this suite's
    # actual dependencies are origin-checked; unrelated prior imports are not
    # this module's authority to reject. No global import policy is installed.
    for name, path in expected.items():
        module = sys.modules.get(name)
        if module is not None and (not getattr(module, '__file__', None)
                or Path(module.__file__).resolve(strict=True) != path):
            raise AssertionError('product import escaped trusted checkout')
    added = str(root) not in sys.path
    if added:
        sys.path.insert(0, str(root))
    try:
        neutral = importlib.import_module('music_app.services.rooted_local_file')
        native = importlib.import_module('music_app.services._rooted_local_file_windows')
        for name, path in expected.items():
            if Path(sys.modules[name].__file__).resolve(strict=True) != path:
                raise AssertionError('product import escaped trusted checkout')
    finally:
        if added:
            sys.path.remove(str(root))
    return neutral, native

rooted, windows = _checkout_imports()


GUID = '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\'
TARGET = '\\Device\\HarddiskVolume23'
SERIAL = 0xFEDCBA9876543210
SELECTION = rooted.RootSelection('win32', 'C:\\Music', ('Albums', 'song.FLAC'))


def identity(number, serial=SERIAL):
    return windows.WindowsIdentity('win32', serial, number.to_bytes(16, 'little'))


def directory(number):
    return windows.HandleInfo(1, identity(number), True, False, 0, 11, 12, 0x10, 0)


def regular(number):
    return windows.HandleInfo(1, identity(number), False, False, 6, 21, 22, 0x20, 0)


def multisz(*items):
    text = '\0'.join(items) + '\0\0'
    return windows.MultiString(text, len(text.encode('utf-16-le')) // 2, 32768)


class NativeStream:
    """Plain stream: GC cannot silently retry an uncertain synthetic close."""
    def __init__(self, native, handle):
        self.native, self.handle = native, handle
        self.position = 0
        self.closed = False
        self.close_calls = 0
        self.invalid = False
        self.fault = 'success'

    def tell(self):
        return 1 if self.invalid else self.position

    def writable(self):
        return False

    def read(self, count=-1):
        assert not self.closed
        data = self.native.data[self.position:]
        result = data if count < 0 else data[:count]
        self.position += len(result)
        return result

    def seek(self, offset, whence=0):
        assert not self.closed
        self.position = {0: 0, 1: self.position, 2: 6}[whence] + offset
        return self.position

    def close(self):
        self.close_calls += 1
        if self.fault == 'before':
            raise OSError('synthetic stream close before disposal')
        self.native.close(self.handle)
        self.closed = True
        if self.fault == 'after':
            raise OSError('synthetic stream close after disposal')


class Native:
    """Generation-aware inert authority implementing the established native seam."""
    def __init__(self):
        self.quarantined = False
        self.pending = None
        self.nodes = {'boot': directory(1), 'music': directory(2),
                      'albums': directory(3), 'leaf': regular(2 ** 120 + 4)}
        self.links = {('boot', 'Music'): 'music', ('music', 'Albums'): 'albums',
                      ('albums', 'song.FLAC'): 'leaf'}
        self.handles = {}
        self.generations = {}
        self.next_handle = 100
        self.next_generation = 1
        self.opened = []
        self.attempted = []
        self.closed = []
        self.requests = []
        self.faults = {}
        self.data = b'abcdef'
        self.volume = windows.VolumeInfo('NTFS', 255)
        self.on_open = None
        self.on_info = None
        self.on_close = None
        self.streams = []
        self.transferred = []

    def volume_guid(self, drive_root):
        assert drive_root == 'C:\\'
        return GUID

    def query_dos_device(self, alias):
        assert alias in ('C:', windows.guid_alias(GUID))
        return multisz(TARGET)

    def allocate(self, node, *, number=None):
        handle = self.next_handle if number is None else number
        if number is None:
            self.next_handle += 1
        assert handle not in self.handles
        generation = self.next_generation
        self.next_generation += 1
        self.handles[handle] = node
        self.generations[handle] = generation
        self.opened.append((handle, generation, node))
        return handle

    def open(self, request):
        self.requests.append(request)
        if self.on_open is not None:
            result = self.on_open(request)
            if result is not None:
                return result
        node = 'boot' if request.parent is None else self.links[
            (self.handles[request.parent], request.name)]
        handle = self.allocate(node)
        return windows.NativeOpenResult(handle, 0, 0, 1, True)

    def info(self, handle):
        if self.on_info is not None:
            result = self.on_info(handle, self.handles[handle])
            if result is not None:
                return result
        return self.nodes[self.handles[handle]]

    def volume_info(self, handle):
        assert self.handles[handle] == 'boot'
        return self.volume

    def close(self, handle):
        assert handle in self.handles, 'duplicate or ownerless native close'
        generation = self.generations[handle]
        self.attempted.append((handle, generation))
        assert self.attempted.count((handle, generation)) == 1, 'generation retried'
        fault = self.faults.get(handle, 'success')
        if fault == 'before':
            raise OSError('synthetic native close before disposal')
        if fault == 'false':
            return False
        del self.handles[handle]
        del self.generations[handle]
        self.closed.append((handle, generation))
        if self.on_close is not None:
            self.on_close(handle, generation)
        if fault == 'after':
            raise OSError('synthetic native close after disposal')
        return None  # Established injected-native close contract.

    def to_reader(self, handle):
        self.transferred.append((handle, self.generations[handle]))
        stream = NativeStream(self, handle)
        self.streams.append(stream)
        return stream

    def quarantine(self, result):
        # Synthetic return via exception exposes retention; it proves no completion.
        self.quarantined = True
        self.pending = result
        raise windows.WindowsNativePending('windows_native_pending')


def opened():
    native = Native()
    backend = windows.WindowsBackend(native)
    resource = backend.acquire(SELECTION)
    return native, backend, resource


def assert_attempted_once(native):
    assert len(native.attempted) == len(set(native.attempted))
    assert len(native.closed) == len(set(native.closed))


def assert_completed_safe_cleanup(native, failed_handle, fault):
    assert_attempted_once(native)
    assert native.handles == ({failed_handle: next(node for handle, _, node in native.opened
        if handle == failed_handle)} if fault in ('before', 'false') else {})
    assert {handle for handle, _ in native.attempted} == {handle for handle, _, _ in native.opened}


def unresolved_handle(backend, handle):
    assert backend._cleanup_domain.is_blocked()
    records = [record for owner in backend._cleanup_domain._owners for record in owner.records()
               if record.kind == 'handle' and record.value == handle and record.state == 'uncertain']
    assert len(records) == 1
    return records[0]


def repeated_close(action):
    try:
        action()
    except (rooted.RootedFileUnavailable, windows.WindowsUnavailable) as error:
        assert 'cleanup' in str(error) or 'quarantined' in str(error)


@pytest.mark.parametrize('scope', ['bootstrap', 'selected_root', 'intermediate', 'leaf'])
@pytest.mark.parametrize('fault', ['before', 'after'])
def test_pre_resource_primary_failure_closes_all_safe_retained_owners(scope, fault):
    native = Native()
    backend = windows.WindowsBackend(native)
    primary = OSError('original admission failure')
    chosen = []
    target_node = {'bootstrap': 'boot', 'selected_root': 'music',
                   'intermediate': 'albums', 'leaf': 'leaf'}[scope]
    def fail_info(handle, node):
        if node == 'leaf':
            target = next(number for number, _, name in native.opened if name == target_node)
            native.faults[target] = fault
            chosen.append(target)
            raise primary
    native.on_info = fail_info
    with pytest.raises(OSError) as caught:
        backend.acquire(SELECTION)
    assert caught.value is primary and len(chosen) == 1
    assert_completed_safe_cleanup(native, chosen[0], fault)
    unresolved_handle(backend, chosen[0])
    before = list(native.attempted)
    with pytest.raises(windows.WindowsUnavailable):
        backend.acquire(SELECTION)
    assert native.attempted == before


@pytest.mark.parametrize('scope,index', [
    ('bootstrap_freshness', 1), ('first_check_bootstrap', 5),
    ('first_check_root', 6), ('first_check_intermediate', 7),
    ('first_check_leaf', 8),
])
@pytest.mark.parametrize('fault', ['before', 'after'])
def test_temporary_scope_preserves_validation_error_and_uncertain_owner(scope, index, fault):
    native = Native()
    backend = windows.WindowsBackend(native)
    primary = OSError('synthetic ' + scope + ' validation failure')
    failed = []
    def fail_info(handle, node):
        if len(native.opened) == index + 1 and handle == native.opened[index][0]:
            native.faults[handle] = fault
            failed.append(handle)
            raise primary
    native.on_info = fail_info
    with pytest.raises(OSError) as caught:
        backend.acquire(SELECTION)
    assert caught.value is primary and len(failed) == 1
    assert_completed_safe_cleanup(native, failed[0], fault)
    unresolved_handle(backend, failed[0])
    before = list(native.attempted)
    with pytest.raises(windows.WindowsUnavailable):
        backend.describe_root(SELECTION)
    assert native.attempted == before


@pytest.mark.parametrize('fault', ['success', 'before', 'after', 'false'])
def test_completed_failed_open_owns_returned_handle_and_preserves_open_error(fault):
    native = Native()
    backend = windows.WindowsBackend(native)
    def failed_open(request):
        handle = native.allocate('boot')
        native.faults[handle] = fault
        return windows.NativeOpenResult(handle, 0xC0000022, 0, 1, True)
    native.on_open = failed_open
    with pytest.raises(windows.WindowsUnavailable, match='native_open_failed'):
        backend.acquire(SELECTION)
    assert len(native.opened) == len(native.attempted) == 1
    assert_completed_safe_cleanup(native, native.opened[0][0], fault)
    if fault == 'success':
        assert not backend._cleanup_domain.is_blocked() and not backend._cleanup_domain._owners
    else:
        unresolved_handle(backend, native.opened[0][0])


@pytest.mark.parametrize('failure', ['bootstrap_info', 'volume', 'root_mismatch',
                                     'bootstrap_identity', 'volume_mismatch',
                                     'resource_constructor', 'first_resource_check'])
@pytest.mark.parametrize('fault', ['before', 'after'])
def test_admission_and_construction_boundaries_keep_all_native_owners(monkeypatch, failure, fault):
    native = Native()
    backend = windows.WindowsBackend(native)
    primary = OSError('synthetic ' + failure + ' rejection')
    expected = None
    failed = []
    def arm_first():
        handle = native.opened[0][0]
        native.faults[handle] = fault
        failed.append(handle)
    if failure == 'bootstrap_info':
        def info(handle, node):
            arm_first()
            raise primary
        native.on_info = info
    elif failure == 'volume':
        def volume(handle):
            arm_first()
            raise primary
        native.volume_info = volume
    elif failure in ('bootstrap_identity', 'volume_mismatch'):
        def info(handle, node):
            if len(native.opened) == 2 and handle == native.opened[-1][0]:
                arm_first()
                if failure == 'bootstrap_identity':
                    return directory(900)
                native.volume = windows.VolumeInfo('NTFS', 254)
        native.on_info = info
    elif failure == 'root_mismatch':
        expected = object()
        def info(handle, node):
            if node == 'music' and not failed:
                arm_first()
        native.on_info = info
    elif failure == 'resource_constructor':
        def constructor(*args, **kwargs):
            arm_first()
            raise primary
        monkeypatch.setattr(windows, 'WindowsResource', constructor)
    else:
        def check(self):
            arm_first()
            raise primary
        monkeypatch.setattr(windows.WindowsResource, 'check', check)
    if failure in ('bootstrap_identity', 'volume_mismatch'):
        with pytest.raises(windows.WindowsUnavailable, match='bootstrap_changed'):
            backend.acquire(SELECTION, expected)
    elif failure == 'root_mismatch':
        with pytest.raises(windows.WindowsUnavailable, match='root_changed'):
            backend.acquire(SELECTION, expected)
    else:
        with pytest.raises(OSError) as caught:
            backend.acquire(SELECTION, expected)
        assert caught.value is primary
    assert len(failed) == 1
    assert_completed_safe_cleanup(native, failed[0], fault)


@pytest.mark.parametrize('scope', ['reader_info', 'reader_postcheck_bootstrap',
                                   'reader_postcheck_root', 'reader_postcheck_intermediate',
                                   'reader_postcheck_leaf'])
@pytest.mark.parametrize('fault', ['before', 'after'])
def test_reader_pretransfer_scopes_retain_uncertainty_without_bridge(scope, fault):
    native, backend, resource = opened()
    start = len(native.opened)
    index = start + {'reader_info': 4, 'reader_postcheck_bootstrap': 5,
                     'reader_postcheck_root': 6, 'reader_postcheck_intermediate': 7,
                     'reader_postcheck_leaf': 8}[scope]
    primary = OSError('synthetic ' + scope + ' validation failure')
    failed = []
    def info(handle, node):
        if len(native.opened) == index + 1 and handle == native.opened[index][0]:
            failed.append(handle)
            native.faults[handle] = fault
            raise primary
    native.on_info = info
    with pytest.raises(OSError) as caught:
        resource.reader()
    assert caught.value is primary and len(failed) == 1 and not native.transferred
    repeated_close(resource.close)
    assert_completed_safe_cleanup(native, failed[0], fault)
    unresolved_handle(backend, failed[0])
    before = list(native.attempted)
    repeated_close(resource.close)
    with pytest.raises(windows.WindowsUnavailable):
        resource.reader()
    assert native.attempted == before


@pytest.mark.parametrize('fault', ['before', 'after', 'false'])
def test_resource_close_attempts_every_safe_owner_and_does_not_retry(fault):
    native, backend, resource = opened()
    target = resource._anchor
    native.faults[target] = fault
    lease = rooted.RootedRegularFile(resource)
    with pytest.raises((OSError, windows.WindowsUnavailable, rooted.RootedFileUnavailable)):
        lease.close()
    assert not lease.drained.is_set()
    assert_completed_safe_cleanup(native, target, fault)
    generation = unresolved_handle(backend, target)
    before = list(native.attempted)
    repeated_close(lease.close)
    repeated_close(resource.close)
    assert native.attempted == before and not lease.drained.is_set()
    assert unresolved_handle(backend, target) is generation


def test_recycled_numeric_handle_is_not_reclosed_after_raised_success():
    native, backend, resource = opened()
    target = resource._anchor
    old_generation = native.generations[target]
    native.faults[target] = 'after'
    replacement = []
    def reuse(handle, generation):
        if handle == target and generation == old_generation:
            native.allocate('unrelated-recycled-number', number=target)
            replacement.append(native.generations[target])
    native.on_close = reuse
    with pytest.raises(OSError):
        resource.close()
    assert len(replacement) == 1 and replacement[0] != old_generation
    before = list(native.attempted)
    repeated_close(resource.close)
    assert native.attempted == before
    assert native.handles == {target: 'unrelated-recycled-number'}
    assert (target, replacement[0]) not in native.attempted


@pytest.mark.parametrize('stage', ['bridge', 'descriptor_inheritance', 'handle_inheritance',
                                   'fdopen', 'stream_position', 'stream_writable',
                                   'descriptor_bind', 'stream_bind'])
@pytest.mark.parametrize('fault', ['success', 'before', 'after'])
def test_crt_conversion_failure_keeps_exactly_one_current_stage(monkeypatch, stage, fault):
    # __new__ plus controlled msvcrt/os is the existing trusted bridge seam.
    native = object.__new__(windows.CtypesWindowsNative)
    native._cleanup_domain = rooted._CleanupDomain()
    native.quarantined = False
    primary = OSError('synthetic ' + stage + ' conversion failure')
    attempted, disposed, flags = [], [], []
    class Stream:
        closed = False
        def tell(self):
            return 1 if stage == 'stream_position' else 0
        def writable(self):
            return stage == 'stream_writable'
        def close(self):
            cleanup('stream', self)
    stream = Stream()
    def cleanup(kind, value):
        attempted.append((kind, value))
        if fault == 'before':
            raise OSError('synthetic cleanup before disposal')
        disposed.append((kind, value))
        if kind == 'stream':
            value.closed = True
        if fault == 'after':
            raise OSError('synthetic cleanup after disposal')
    native.close = lambda handle: cleanup('handle', handle)
    def open_osfhandle(handle, value):
        assert handle == 500
        flags.append(value)
        if stage == 'bridge':
            raise primary
        return 700
    def fdopen(descriptor, mode, buffering):
        assert (descriptor, mode, buffering) == (700, 'rb', 0)
        if stage == 'fdopen':
            raise primary
        return stream
    monkeypatch.setitem(sys.modules, 'msvcrt', SimpleNamespace(
        open_osfhandle=open_osfhandle, get_osfhandle=lambda descriptor: 500))
    monkeypatch.setattr(windows, 'os', SimpleNamespace(
        O_RDONLY=0, O_BINARY=0x8000, O_NOINHERIT=0x80,
        get_inheritable=lambda descriptor: stage == 'descriptor_inheritance',
        get_handle_inheritable=lambda handle: stage == 'handle_inheritance',
        fdopen=fdopen, close=lambda descriptor: cleanup('descriptor', descriptor)))
    if stage in ('descriptor_bind', 'stream_bind'):
        original_bind = rooted._CleanupRecord.bind
        target_kind = 'descriptor' if stage == 'descriptor_bind' else 'stream'
        def fail_bind(record, *args, **kwargs):
            if record.kind == target_kind:
                raise primary
            return original_bind(record, *args, **kwargs)
        monkeypatch.setattr(rooted._CleanupRecord, 'bind', fail_bind)
    expected_kind = ('handle' if stage == 'bridge' else 'descriptor'
        if stage in ('descriptor_inheritance', 'handle_inheritance', 'fdopen', 'descriptor_bind') else 'stream')
    expected_value = {'handle': 500, 'descriptor': 700, 'stream': stream}[expected_kind]
    with pytest.raises((OSError, windows.WindowsUnavailable)) as caught:
        native.to_reader(500)
    if stage in ('bridge', 'fdopen', 'descriptor_bind', 'stream_bind'):
        assert caught.value is primary
    else:
        assert str(caught.value) == ('windows_reader_inheritable'
            if stage in ('descriptor_inheritance', 'handle_inheritance') else 'windows_reader_invalid')
    assert flags == [0x8080]
    if stage in ('bridge', 'fdopen'):
        # A transfer call may consume its input and then fail before returning.
        # Even this fake's pre-consumption raise cannot prove safe numeric retry.
        assert attempted == disposed == []
        assert native._cleanup_domain.is_blocked()
        owner, = native._cleanup_domain._owners
        record, = owner.records()
        assert record.kind == expected_kind and record.value == expected_value
        assert record.state == 'uncertain' and owner.failed and not owner.complete
        repeated_close(record.close)
        repeated_close(owner.close_all)
        gc.collect()
        assert attempted == disposed == []
    else:
        assert attempted == [(expected_kind, expected_value)]
        assert disposed == ([] if fault == 'before' else [(expected_kind, expected_value)])
        assert native._cleanup_domain.is_blocked() is (fault != 'success')
        if fault != 'success':
            assert native._cleanup_domain._owners
            gc.collect()
            assert attempted == [(expected_kind, expected_value)]


def test_successful_crt_transfer_preserves_identity_noninheritance_and_zero_offset(monkeypatch):
    native = object.__new__(windows.CtypesWindowsNative)
    native._cleanup_domain = rooted._CleanupDomain()
    native.quarantined = False
    closed_handles, closed_fds, flags, queries = [], [], [], []
    class Stream:
        close_calls = 0
        def tell(self):
            return 0
        def writable(self):
            return False
        def close(self):
            self.close_calls += 1
    stream = Stream()
    native.close = closed_handles.append
    def bridge(handle, value):
        assert handle == 500
        flags.append(value)
        return 700
    def get_inheritable(descriptor):
        queries.append(('descriptor', descriptor))
        return False
    def get_handle_inheritable(handle):
        queries.append(('handle', handle))
        return False
    def fdopen(descriptor, mode, buffering):
        assert (descriptor, mode, buffering) == (700, 'rb', 0)
        return stream
    monkeypatch.setitem(sys.modules, 'msvcrt', SimpleNamespace(
        open_osfhandle=bridge, get_osfhandle=lambda descriptor: 500))
    monkeypatch.setattr(windows, 'os', SimpleNamespace(O_RDONLY=0, O_BINARY=0x8000,
        O_NOINHERIT=0x80, get_inheritable=get_inheritable,
        get_handle_inheritable=get_handle_inheritable, fdopen=fdopen,
        close=closed_fds.append))
    assert native.to_reader(500) is stream
    assert flags == [0x8080] and queries == [('descriptor', 700), ('handle', 500)]
    assert not closed_handles and not closed_fds and not stream.close_calls
    stream.close()
    assert stream.close_calls == 1 and not native._cleanup_domain.is_blocked()


@pytest.mark.parametrize('stage', ['descriptor', 'stream'])
def test_reused_crt_number_is_not_retried_after_close_then_raise(monkeypatch, stage):
    native = object.__new__(windows.CtypesWindowsNative)
    native._cleanup_domain = rooted._CleanupDomain()
    native.quarantined = False
    calls, generation = [], [1]
    class Stream:
        closed = False
        def tell(self):
            return 1
        def writable(self):
            return False
        def close(self):
            calls.append(('stream', generation[0]))
            self.closed = True
            generation[0] = 2  # Reuse is synthetic; no real fd is touched.
            raise OSError('close completed then wrapper raised')
    stream = Stream()
    def descriptor_close(fd):
        assert fd == 700
        calls.append(('descriptor', generation[0]))
        generation[0] = 2
        raise OSError('close completed then wrapper raised')
    native.close = lambda handle: pytest.fail('HANDLE close after successful CRT transfer')
    monkeypatch.setitem(sys.modules, 'msvcrt', SimpleNamespace(
        open_osfhandle=lambda handle, flags: 700, get_osfhandle=lambda fd: 500))
    monkeypatch.setattr(windows, 'os', SimpleNamespace(O_RDONLY=0, O_BINARY=0x8000,
        O_NOINHERIT=0x80, get_inheritable=lambda fd: stage == 'descriptor',
        get_handle_inheritable=lambda handle: False,
        fdopen=lambda *args, **kwargs: stream, close=descriptor_close))
    with pytest.raises(windows.WindowsUnavailable, match='windows_reader_'):
        native.to_reader(500)
    assert calls == [(stage, 1)] and generation == [2]
    assert native._cleanup_domain.is_blocked()
    # Retained ownership cannot be discarded by local binding/stream collection.
    owner_refs = [weakref.ref(owner) for owner in native._cleanup_domain._owners]
    del stream, native
    gc.collect()
    assert all(ref() is not None for ref in owner_refs)
    assert calls == [(stage, 1)]


@pytest.mark.parametrize('pending_at', [1, 5])
@pytest.mark.parametrize('shape', ['status_pending', 'iosb_pending', 'not_completed',
                                   'invalid_completed', 'invalid_status', 'invalid_information'])
def test_synthetic_pending_retains_storage_and_chain_without_parent_close(pending_at, shape):
    native = Native()
    backend = windows.WindowsBackend(native)
    class Storage:
        pass
    storage = Storage()
    snapshot, pending_handles = [], []
    def pending(request):
        if len(native.requests) != pending_at:
            return None
        snapshot.extend(native.attempted)
        handle = native.allocate('leaf' if request.parent is not None else 'boot')
        pending_handles.append(handle)
        status = windows.STATUS_PENDING if shape == 'status_pending' else 0
        io_status = windows.STATUS_PENDING if shape == 'iosb_pending' else 0
        completed = False if shape == 'not_completed' else 1 if shape == 'invalid_completed' else True
        if shape == 'invalid_status':
            status = None
        information = -1 if shape == 'invalid_information' else 1
        return windows.NativeOpenResult(handle, status, io_status, information, completed, storage)
    native.on_open = pending
    with pytest.raises(windows.WindowsNativePending):
        backend.acquire(SELECTION)
    assert backend.quarantined and native.pending.storage is storage
    assert len(pending_handles) == 1 and pending_handles[0] in native.handles
    assert native.attempted == snapshot  # Pending arguments can still reference parents.
    domain = backend._cleanup_domain
    assert domain.is_blocked() and domain._owners
    assert any(record.state == 'pending' for owner in domain._owners for record in owner.records())
    before = list(native.attempted)
    with pytest.raises(windows.WindowsUnavailable):
        backend.acquire(SELECTION)
    with pytest.raises(windows.WindowsUnavailable):
        backend.describe_root(SELECTION)
    assert native.attempted == before


@pytest.mark.parametrize('fault', ['before', 'after'])
def test_pending_resource_check_never_signals_neutral_drained(fault):
    native, backend, resource = opened()
    lease = rooted.RootedRegularFile(resource)
    storage = object()
    before = list(native.attempted)
    parents = dict(native.handles)
    def pending(request):
        handle = native.allocate('boot')
        return windows.NativeOpenResult(handle, windows.STATUS_PENDING,
            windows.STATUS_PENDING, 0, False, storage)
    native.on_open = pending
    # Fault labels prove no close callback, whether it would fail before or after.
    native.faults.update({handle: fault for handle in parents})
    with pytest.raises(windows.WindowsNativePending):
        lease.check()
    repeated_close(lease.close)
    assert not lease.drained.is_set()
    assert all(native.handles[handle] == node for handle, node in parents.items())
    assert native.attempted == before
    assert backend._cleanup_domain.is_blocked()
    assert resource._cleanup_owner.failed and not resource.cleanup_complete


@pytest.mark.parametrize('action', ['acquire', 'describe_root'])
@pytest.mark.parametrize('fault', ['before', 'after'])
def test_direct_backend_failure_is_strongly_retained_and_domain_isolated(action, fault):
    healthy_native = Native()
    healthy = windows.WindowsBackend(healthy_native)
    failed_native = Native()
    failed = windows.WindowsBackend(failed_native)
    domain = failed._cleanup_domain
    assert domain is not healthy._cleanup_domain
    assert domain is not windows.WindowsBackend()._cleanup_domain
    primary = OSError('direct synthetic admission failure')
    def fail_info(handle, node):
        failed_native.faults[handle] = fault
        raise primary
    failed_native.on_info = fail_info
    with pytest.raises(OSError) as caught:
        getattr(failed, action)(SELECTION)
    assert caught.value is primary
    assert domain.is_blocked() and domain._owners
    owner_refs = [weakref.ref(owner) for owner in domain._owners]
    native_ref, backend_ref, domain_ref = weakref.ref(failed_native), weakref.ref(failed), weakref.ref(domain)
    attempts = failed_native.attempted
    del caught, primary, fail_info, failed_native, failed, domain
    gc.collect()
    assert native_ref() is not None and domain_ref() is not None
    assert all(ref() is not None for ref in owner_refs)
    assert len(attempts) == 1
    rebound = windows.WindowsBackend(native_ref())
    assert rebound._cleanup_domain is domain_ref()
    with pytest.raises(windows.WindowsUnavailable):
        rebound.acquire(SELECTION)
    resource = healthy.acquire(SELECTION)
    resource.close()
    assert not healthy_native.handles and not healthy._cleanup_domain.is_blocked()
    assert len(attempts) == 1


def test_default_native_domain_is_fixed_and_injected_domains_do_not_poison_it(monkeypatch):
    first, second = windows.WindowsBackend(), windows.WindowsBackend()
    assert first._cleanup_domain is second._cleanup_domain
    default = first._cleanup_domain
    assert not default.is_blocked()
    def forbidden():
        raise AssertionError('synthetic suite must never construct real native binding')
    monkeypatch.setattr(windows, 'CtypesWindowsNative', forbidden)
    native, fake, resource = opened()
    assert fake._cleanup_domain is not default
    native.faults[resource._anchor] = 'after'
    with pytest.raises(OSError):
        resource.close()
    assert fake._cleanup_domain.is_blocked() and not default.is_blocked()
    another_native, another, safe_resource = opened()
    safe_resource.close()
    assert not another_native.handles and not another._cleanup_domain.is_blocked()
    assert first._cleanup_domain is second._cleanup_domain is default
    assert not hasattr(default, 'reset') and not hasattr(fake, 'reset')


def test_claimed_windows_lease_failure_blocks_same_domain_without_reacquiring_capacity():
    # A successful claim transfers the live lease; only acquisition capacity ends.
    from concurrent.futures import ThreadPoolExecutor
    native = Native()
    backend = windows.WindowsBackend(native)
    executor = ThreadPoolExecutor(max_workers=2)
    budget = rooted.AcquisitionBudget(executor)
    try:
        lease = budget.acquire(SELECTION, factory=lambda selection, stamp:
            rooted.acquire(selection, stamp, backend=backend))
        resource = lease._resource
    finally:
        executor.shutdown(wait=True)
    assert not budget._jobs
    available = [budget._slots.acquire(blocking=False) for _ in range(7)]
    assert available == [True] * 6 + [False]
    for _ in range(6):
        budget._slots.release()
    native.faults[resource._anchor] = 'after'
    with pytest.raises(OSError):
        lease.close()
    assert not lease.drained.is_set() and backend._cleanup_domain.is_blocked()
    assert resource._cleanup_owner in backend._cleanup_domain._owners
    before = len(native.requests)
    with pytest.raises(windows.WindowsUnavailable):
        backend.acquire(SELECTION)
    assert len(native.requests) == before
    assert len(budget._jobs) == 1
    assert all(job._released and job.is_quarantined() for job in budget._jobs)
    repeated_close(lease.close)
    available = [budget._slots.acquire(blocking=False) for _ in range(7)]
    assert available == [True] * 6 + [False]
    for _ in range(6):
        budget._slots.release()


@pytest.mark.parametrize('fault', ['before', 'after'])
def test_failed_published_reader_keeps_neutral_reservation_and_strong_stream(fault):
    native, backend, resource = opened()
    lease = rooted.RootedRegularFile(resource)
    reader = lease.independent_reader()
    stream = native.streams[-1]
    stream.fault = fault
    with pytest.raises(OSError):
        reader.close()
    assert lease._active == lease._readers == 1 and reader._ticket.owner is lease
    assert not lease.drained.is_set() and backend._cleanup_domain.is_blocked()
    assert stream.closed is (fault == 'after') and stream.close_calls == 1
    neutral_owner = lease._cleanup_owner
    assert neutral_owner in backend._cleanup_domain._owners
    assert any(record.value is reader._stream and record.reservation is reader._ticket
               and record.state == 'uncertain' for record in neutral_owner.records())
    assert reader._stream._record.value is stream
    assert reader._stream._record.state == 'uncertain'
    repeated_close(reader.close)
    repeated_close(lease.close)
    refs = tuple(weakref.ref(value) for value in (lease, reader._ticket, stream, neutral_owner))
    del lease, reader, stream, neutral_owner, resource, backend, native
    gc.collect()
    assert all(ref() is not None for ref in refs)
    retained_lease, ticket, retained_stream, owner = (ref() for ref in refs)
    assert ticket.owner is retained_lease and retained_stream.close_calls == 1
    assert not retained_lease.drained.is_set() and owner.failed


@pytest.mark.parametrize('boundary', ['record_constructor', 'registration_after_insert', 'bind'])
@pytest.mark.parametrize('scope,index', [
    ('retained_bootstrap', 0), ('bootstrap_freshness', 1), ('selected_root', 2),
    ('intermediate', 3), ('leaf', 4), ('check_bootstrap', 5),
    ('check_root', 6), ('check_intermediate', 7), ('check_leaf', 8),
])
def test_native_bookkeeping_failure_has_no_unowned_returned_handle(monkeypatch, boundary, scope, index):
    native = Native()
    backend = windows.WindowsBackend(native)
    primary = MemoryError('synthetic bookkeeping failure at ' + scope)
    fired = []
    if boundary == 'record_constructor':
        original = rooted._CleanupRecord
        def constructor(*args, **kwargs):
            if not fired and len(native.requests) == index:
                fired.append(boundary)
                raise primary
            return original(*args, **kwargs)
        monkeypatch.setattr(rooted, '_CleanupRecord', constructor)
    elif boundary == 'registration_after_insert':
        original = rooted._CleanupOwner.reserve
        def reserve(owner, *args, **kwargs):
            record = original(owner, *args, **kwargs)
            if not fired and len(native.requests) == index:
                fired.append(boundary)
                raise primary
            return record
        monkeypatch.setattr(rooted._CleanupOwner, 'reserve', reserve)
    else:
        original = rooted._CleanupRecord.bind
        def bind(record, *args, **kwargs):
            if not fired and len(native.requests) == index + 1:
                fired.append(boundary)
                raise primary
            return original(record, *args, **kwargs)
        monkeypatch.setattr(rooted._CleanupRecord, 'bind', bind)
    with pytest.raises(MemoryError) as caught:
        backend.acquire(SELECTION)
    assert caught.value is primary and fired == [boundary]
    assert len(native.requests) == index + (1 if boundary == 'bind' else 0)
    assert_attempted_once(native)
    assert not native.handles
    assert {handle for handle, _, _ in native.opened} == {handle for handle, _ in native.attempted}
    assert not backend._cleanup_domain.is_blocked()
    assert not backend._cleanup_domain._owners


@pytest.mark.parametrize('fault', ['before', 'after'])
def test_bind_failure_after_returned_handle_preserves_primary_and_uncertainty(monkeypatch, fault):
    native = Native()
    backend = windows.WindowsBackend(native)
    primary = MemoryError('synthetic handle commit failure')
    original = rooted._CleanupRecord.bind
    fired = []
    def bind(record, *args, **kwargs):
        if not fired and len(native.requests) == 5:
            handle = native.opened[-1][0]
            native.faults[handle] = fault
            fired.append(handle)
            raise primary
        return original(record, *args, **kwargs)
    monkeypatch.setattr(rooted._CleanupRecord, 'bind', bind)
    with pytest.raises(MemoryError) as caught:
        backend.acquire(SELECTION)
    assert caught.value is primary and len(fired) == 1
    assert_completed_safe_cleanup(native, fired[0], fault)
    owner, = backend._cleanup_domain._owners
    record, = [record for record in owner.records() if record.state == 'uncertain']
    assert record.value == fired[0]
    assert owner.failed and backend._cleanup_domain.is_blocked()


def test_malformed_native_result_is_retained_without_guessing_cleanup():
    native = Native()
    backend = windows.WindowsBackend(native)
    class OpaqueResult:
        def __init__(self):
            self.handle = native.allocate('boot')
            self.storage = object()
    result = OpaqueResult()
    native.on_open = lambda request: result
    with pytest.raises(windows.WindowsUnavailable):
        backend.acquire(SELECTION)
    assert native.handles and not native.attempted
    assert backend._cleanup_domain.is_blocked()
    assert any(record.state in ('pending', 'uncertain')
        for owner in backend._cleanup_domain._owners for record in owner.records())
    result_ref = weakref.ref(result)
    native.on_open = None
    del result
    gc.collect()
    assert result_ref() is not None and not native.attempted


@pytest.mark.parametrize('boundary', ['result_packaging', 'information_extract', 'handle_extract'])
@pytest.mark.parametrize('fault', ['success', 'before', 'after'])
def test_ctypes_open_postcall_allocation_boundary_owns_synthetic_output(monkeypatch, boundary, fault):
    """No ctypes function is called: every struct/pointer/native call is a fake."""
    native = object.__new__(windows.CtypesWindowsNative)
    domain = rooted._CleanupDomain()
    owner = rooted._CleanupOwner(domain)
    native._cleanup_domain = domain
    native.quarantined = False
    primary = MemoryError('synthetic completed native output allocation failure')
    entered, close_calls, disposed = [], [], []
    class Handle:
        def __init__(self, value=None):
            self.raw_value = value
        @property
        def value(self):
            if boundary == 'handle_extract' and entered and self.raw_value == 500:
                raise primary
            return self.raw_value
    class Information:
        def __int__(self):
            raise primary
    native._HANDLE = Handle
    native.ctypes = SimpleNamespace(
        create_unicode_buffer=lambda text, units: SimpleNamespace(text=text, units=units),
        cast=lambda value, kind: value, POINTER=lambda kind: kind, c_wchar=object(),
        sizeof=lambda kind: 48, pointer=lambda value: value, byref=lambda value: value)
    native.UNICODE_STRING = lambda *args: SimpleNamespace(fields=args)
    native.OBJECT_ATTRIBUTES = lambda *args: SimpleNamespace(fields=args)
    native.IO_STATUS_BLOCK = lambda: SimpleNamespace(Status=0, Information=0)
    def nt_create(handle, access, attrs, iosb, *args):
        assert rooted._cleanup_current('record') is record
        assert record.storage is not None  # Storage precedes the synthetic call.
        handle.raw_value = 500
        iosb.Status = 0
        iosb.Information = Information() if boundary == 'information_extract' else 1
        entered.append(1)
        return 0
    native.ntdll = SimpleNamespace(NtCreateFile=nt_create)
    def close(handle):
        close_calls.append(handle)
        if fault == 'before':
            raise OSError('synthetic native cleanup before disposal')
        disposed.append(handle)
        if fault == 'after':
            raise OSError('synthetic native cleanup after disposal')
    native.close = close
    def quarantine(value):
        native.quarantined = True
        native._pending = value
        raise windows.WindowsNativePending('synthetic pending inspection only')
    native.quarantine = quarantine
    record = owner.reserve('handle', native.close)
    if boundary == 'result_packaging':
        def packaging(*args):
            raise primary
        monkeypatch.setattr(windows, 'NativeOpenResult', packaging)
    expected_error = windows.WindowsNativePending if boundary == 'handle_extract' else MemoryError
    with rooted._CleanupScope(owner=owner, record=record):
        with pytest.raises(expected_error) as caught:
            native.open(windows.OpenRequest(TARGET + '\\', None, True))
    assert entered == [1]
    if boundary == 'handle_extract':
        assert caught.value.__context__ is primary
        assert record.state in ('pending', 'uncertain') and record.storage is not None
        owner.close_all()
        assert not close_calls and not disposed
        assert domain.is_blocked() and not owner.complete
    else:
        assert caught.value is primary
        assert record.value == 500
        if fault == 'success':
            owner.close_all()
        else:
            with pytest.raises(OSError):
                owner.close_all()
        assert close_calls == [500]
        assert disposed == ([] if fault == 'before' else [500])
        assert owner.complete is (fault == 'success')
        assert domain.is_blocked() is (fault != 'success')
    before = list(close_calls)
    repeated_close(owner.close_all)
    assert close_calls == before


@pytest.mark.parametrize('boundary', ['stream_validation', 'reader_wrapper'])
@pytest.mark.parametrize('fault', ['success', 'before', 'after'])
def test_windows_unpublished_stream_failure_keeps_exact_stream_owner(monkeypatch, boundary, fault):
    native, backend, resource = opened()
    primary = MemoryError('synthetic Windows reader wrapper failure')
    original_bridge = native.to_reader
    def bridge(handle):
        stream = original_bridge(handle)
        stream.fault = fault
        stream.invalid = boundary == 'stream_validation'
        return stream
    native.to_reader = bridge
    if boundary == 'reader_wrapper':
        def wrapper(*args):
            raise primary
        monkeypatch.setattr(windows, '_TrackedWindowsReader', wrapper)
    expected_error = windows.WindowsUnavailable if boundary == 'stream_validation' else MemoryError
    with pytest.raises(expected_error) as caught:
        resource.reader()
    if boundary == 'reader_wrapper':
        assert caught.value is primary
    else:
        assert str(caught.value) == 'windows_reader_invalid'
    stream, = native.streams
    assert stream.close_calls == 1 and stream.closed is (fault != 'before')
    assert backend._cleanup_domain.is_blocked() is (fault != 'success')
    repeated_close(resource.close)
    assert native.handles == ({stream.handle: 'leaf'} if fault == 'before' else {})
    assert_attempted_once(native)
    assert stream.close_calls == 1
    assert resource.cleanup_complete is (fault == 'success')
    if fault != 'success':
        assert any(record.value is stream and record.kind == 'stream'
            and record.state == 'uncertain' for record in resource._cleanup_owner.records())
    repeated_close(resource.close)
    assert stream.close_calls == 1


@pytest.mark.parametrize('boundary', ['record_constructor', 'registration_after_insert'])
@pytest.mark.parametrize('fault', ['success', 'before', 'after'])
def test_standalone_crt_initial_registration_failure_still_consumes_handle(monkeypatch, boundary, fault):
    native = object.__new__(windows.CtypesWindowsNative)
    domain = rooted._CleanupDomain()
    native._cleanup_domain = domain
    native.quarantined = False
    primary = MemoryError('synthetic standalone CRT registration failure')
    attempts, disposed, converted = [], [], []
    def close(handle):
        attempts.append(handle)
        if fault == 'before':
            raise OSError('synthetic input HANDLE close before disposal')
        disposed.append(handle)
        if fault == 'after':
            raise OSError('synthetic input HANDLE close after disposal')
    native.close = close
    def forbidden_conversion(handle, flags):
        converted.append(handle)
        raise AssertionError('conversion ran without registered input owner')
    monkeypatch.setitem(sys.modules, 'msvcrt', SimpleNamespace(open_osfhandle=forbidden_conversion))
    if boundary == 'record_constructor':
        def fail_record(*args, **kwargs):
            raise primary
        monkeypatch.setattr(rooted, '_CleanupRecord', fail_record)
    else:
        original = rooted._CleanupOwner.reserve
        def fail_reserve(owner, *args, **kwargs):
            original(owner, *args, **kwargs)
            raise primary
        monkeypatch.setattr(rooted._CleanupOwner, 'reserve', fail_reserve)
    with pytest.raises(MemoryError) as caught:
        native.to_reader(500)
    assert caught.value is primary and not converted
    assert attempts == [500] and disposed == ([] if fault == 'before' else [500])
    assert domain.is_blocked() is (fault != 'success')
    if fault == 'success':
        assert not domain._owners
    else:
        assert domain._owners and all(owner.failed for owner in domain._owners)
        refs = tuple(weakref.ref(owner) for owner in domain._owners)
        del native, domain, caught, primary
        gc.collect()
        assert all(ref() is not None for ref in refs)
        assert attempts == [500]


@pytest.mark.parametrize('boundary', ['stream_validation', 'reader_wrapper'])
@pytest.mark.parametrize('fault', ['before', 'after'])
def test_cross_layer_unpublished_native_stream_keeps_neutral_reservation(monkeypatch, boundary, fault):
    native, backend, resource = opened()
    lease = rooted.RootedRegularFile(resource)
    primary = MemoryError('synthetic cross-layer reader wrapper failure')
    original_bridge = native.to_reader
    def bridge(handle):
        stream = original_bridge(handle)
        stream.fault = fault
        stream.invalid = boundary == 'stream_validation'
        return stream
    native.to_reader = bridge
    if boundary == 'reader_wrapper':
        def wrapper(*args):
            raise primary
        monkeypatch.setattr(windows, '_TrackedWindowsReader', wrapper)
    expected = windows.WindowsUnavailable if boundary == 'stream_validation' else MemoryError
    with pytest.raises(expected) as caught:
        lease.independent_reader()
    if boundary == 'reader_wrapper':
        assert caught.value is primary
    else:
        assert str(caught.value) == 'windows_reader_invalid'
    stream, = native.streams
    assert stream.close_calls == 1 and stream.closed is (fault == 'after')
    assert resource.cleanup_failed and not resource.cleanup_complete
    assert lease._active == lease._readers == 1
    assert not lease.drained.is_set() and not resource._closed
    neutral_record, = [record for record in lease._cleanup_owner.records()
                       if record.kind == 'reader']
    assert neutral_record.value is None and neutral_record.state == 'uncertain'
    assert neutral_record.reservation.owner is lease
    assert any(record.value is stream and record.state == 'uncertain'
               for record in resource._cleanup_owner.records())
    before = list(native.attempted)
    repeated_close(lease.close)
    repeated_close(lease.close)
    assert stream.close_calls == 1 and native.attempted == before
    assert lease._active == lease._readers == 1 and not lease.drained.is_set()
    with pytest.raises(rooted.RootedFileUnavailable):
        lease.independent_reader()
    refs = tuple(weakref.ref(value) for value in (lease, neutral_record, stream))
    del caught, primary, bridge, original_bridge, stream, native, backend, resource, lease, neutral_record
    gc.collect()
    assert all(ref() is not None for ref in refs)
    assert refs[0]()._active == 1 and refs[2]().close_calls == 1


@pytest.mark.parametrize('boundary', ['open_osfhandle', 'fdopen'])
@pytest.mark.parametrize('failure', ['before_consumption', 'after_consumption', 'recycled_numbers'])
@pytest.mark.parametrize('route', ['standalone', 'backend_resource', 'neutral_lease'])
def test_transfer_call_uncertainty_never_retries_numeric_ownership(monkeypatch, boundary, failure, route):
    """Synthetic transfer/return gap; no real HANDLE, descriptor or DLL exists."""
    native = Native()
    converter = object.__new__(windows.CtypesWindowsNative)
    converter.quarantined = False
    backend = resource = lease = neutral_record = None
    if route == 'standalone':
        domain = native._cleanup_domain = rooted._CleanupDomain()
        input_handle = native.allocate('leaf')
    else:
        backend = windows.WindowsBackend(native)
        resource = backend.acquire(SELECTION)
        domain = backend._cleanup_domain
        input_handle = None  # The actual backend opens its own reader HANDLE.
        if route == 'neutral_lease':
            lease = rooted.RootedRegularFile(resource)
    converter._cleanup_domain = domain
    primary = MemoryError('synthetic ' + boundary + ' return allocation failure')
    cleanup_attempts, calls = [], []
    ledger = SimpleNamespace(handle=None, original_generation=None,
        descriptor_generation=None, stream_generation=None, recycled_generation=None)
    original_close = native.close
    def close_handle(handle, native=native, original_close=original_close):
        # Default-bound authority matches a bound native closer after this
        # test deletes its local cells before checking production retention.
        # Observe even an illegal attempt on an already-consumed numeric HANDLE.
        cleanup_attempts.append(('handle', handle, native.generations.get(handle)))
        return original_close(handle)
    def close_descriptor(descriptor):
        cleanup_attempts.append(('descriptor', descriptor, ledger.descriptor_generation))
        raise AssertionError('numeric descriptor cleanup after uncertain transfer')
    native.close = converter.close = close_handle
    native.to_reader = converter.to_reader
    def consume_handle(handle):
        assert native.handles.pop(handle) == 'leaf'
        assert native.generations.pop(handle) == ledger.original_generation
        ledger.descriptor_generation = ledger.original_generation
    def recycle_numbers():
        # Model the failed callee having disposed its owned resource before
        # allocation raises; both reused numbers now identify unrelated owners.
        ledger.descriptor_generation = 'unrelated descriptor generation'
        ledger.stream_generation = None
        native.allocate('unrelated recycled HANDLE', number=ledger.handle)
        ledger.recycled_generation = native.generations[ledger.handle]
        assert ledger.recycled_generation != ledger.original_generation
    def open_handle(handle, flags):
        assert flags == 0x8080
        calls.append(('open_osfhandle', handle))
        ledger.handle = handle
        ledger.original_generation = native.generations[handle]
        if boundary == 'open_osfhandle' and failure == 'before_consumption':
            raise primary
        consume_handle(handle)
        if boundary == 'open_osfhandle':
            if failure == 'recycled_numbers':
                recycle_numbers()
            raise primary
        return 700
    def open_stream(descriptor, mode, buffering):
        assert (descriptor, mode, buffering) == (700, 'rb', 0)
        calls.append(('fdopen', descriptor))
        assert boundary == 'fdopen'
        if failure != 'before_consumption':
            ledger.stream_generation = ledger.descriptor_generation
            ledger.descriptor_generation = None
        if failure == 'recycled_numbers':
            recycle_numbers()
        raise primary
    monkeypatch.setitem(sys.modules, 'msvcrt', SimpleNamespace(
        open_osfhandle=open_handle, get_osfhandle=lambda descriptor: ledger.handle))
    monkeypatch.setattr(windows, 'os', SimpleNamespace(O_RDONLY=0, O_BINARY=0x8000,
        O_NOINHERIT=0x80, close=close_descriptor,
        get_inheritable=lambda descriptor: False,
        get_handle_inheritable=lambda handle: False, fdopen=open_stream))
    with pytest.raises(MemoryError) as caught:
        if route == 'standalone':
            converter.to_reader(input_handle)
        elif route == 'backend_resource':
            resource.reader()
        else:
            lease.independent_reader()
    assert caught.value is primary
    assert calls == ([('open_osfhandle', ledger.handle)] if boundary == 'open_osfhandle'
                     else [('open_osfhandle', ledger.handle), ('fdopen', 700)])
    assert not any(kind == 'descriptor' or number == ledger.handle
                   for kind, number, generation in cleanup_attempts)
    owner = (next(iter(domain._owners)) if route == 'standalone'
             else resource._cleanup_owner)
    record, = [entry for entry in owner.records() if entry.state == 'uncertain']
    assert (record.kind, record.value) == (('handle', ledger.handle)
        if boundary == 'open_osfhandle' else ('descriptor', 700))
    assert owner.failed and not owner.complete and domain.is_blocked()
    assert domain in rooted._LIVE_CLEANUP_DOMAINS and owner in domain._owners
    if failure == 'before_consumption':
        if boundary == 'open_osfhandle':
            assert native.generations[ledger.handle] == ledger.original_generation
            assert ledger.descriptor_generation is None
        else:
            assert ledger.handle not in native.handles
            assert ledger.descriptor_generation == ledger.original_generation
        assert ledger.stream_generation is None
    elif failure == 'after_consumption':
        assert ledger.handle not in native.handles
        assert (ledger.descriptor_generation, ledger.stream_generation) == (
            (ledger.original_generation, None) if boundary == 'open_osfhandle'
            else (None, ledger.original_generation))
    else:
        assert native.handles[ledger.handle] == 'unrelated recycled HANDLE'
        assert native.generations[ledger.handle] == ledger.recycled_generation
        assert ledger.descriptor_generation == 'unrelated descriptor generation'
    if route == 'neutral_lease':
        neutral_record, = [entry for entry in lease._cleanup_owner.records()
                           if entry.kind == 'reader']
        assert neutral_record.value is None and neutral_record.state == 'uncertain'
        assert neutral_record.reservation.owner is lease
        assert lease._active == lease._readers == 1
        assert not lease.drained.is_set() and not resource._closed
        before = list(cleanup_attempts)
        repeated_close(lease.close)
        repeated_close(lease.close)
        assert cleanup_attempts == before
        assert lease._active == lease._readers == 1 and not lease.drained.is_set()
        with pytest.raises(rooted.RootedFileUnavailable):
            lease.independent_reader()
    elif route == 'backend_resource':
        # A failed transfer does not prevent other positively owned handles
        # from being closed once by an explicit resource close.
        safe_generations = {(handle, generation) for handle, generation in native.generations.items()
                            if handle != ledger.handle}
        repeated_close(resource.close)
        assert safe_generations.issubset(set(native.closed))
        assert resource.cleanup_failed and not resource.cleanup_complete
    else:
        repeated_close(owner.close_all)
    before = list(cleanup_attempts)
    repeated_close(record.close)
    repeated_close(record.close)
    if route != 'neutral_lease':
        repeated_close(owner.close_all)
    assert cleanup_attempts == before
    assert not any(kind == 'descriptor' or number == ledger.handle
                   for kind, number, generation in cleanup_attempts)
    calls_before = list(calls)
    requests_before = len(native.requests)
    if route == 'standalone':
        with pytest.raises(rooted.RootedFileUnavailable):
            converter.to_reader(ledger.handle)
    else:
        with pytest.raises(windows.WindowsUnavailable):
            backend.acquire(SELECTION)
    assert calls == calls_before and len(native.requests) == requests_before
    # Remove fake module roots and exception frames before checking strong GC
    # retention by the production domain, rather than by this test's patcher.
    refs = tuple(weakref.ref(value) for value in
        (native, converter, domain, owner, record, resource, lease, neutral_record)
        if value is not None)
    monkeypatch.undo()
    del caught, primary, original_close, close_handle, close_descriptor
    del consume_handle, recycle_numbers, open_handle, open_stream
    del native, converter, domain, owner, record, resource, backend, lease, neutral_record
    gc.collect()
    assert all(ref() is not None for ref in refs)
    assert cleanup_attempts == before
