"""W2 actual native-call accounting with wholly inert ABI collaborators.

Source-authored only. Synthetic events are not genuine Windows acceptance.
No app, configuration, database, decoder, native DLL or byte capture is used.
"""
SUITE_NAME = 'test_rooted_windows_operation_context.py'

import gc
import importlib
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
from dataclasses import replace
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


GUID = '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\'
TARGET = '\\Device\\HarddiskVolume23'
SERIAL = 0xFEDCBA9876543210
ROOT = 'C:\\Music'
SELECTION = rooted.RootSelection('win32', ROOT, ('Albums', 'cover.png'))
WAIT = 5


class Clock:
    def __init__(self):
        self.now = 0.0
        self.abandoned = False
    def __call__(self):
        return self.now


def context(clock=None):
    clock = Clock() if clock is None else clock
    return winresolver._Context(10.0, lambda: clock.abandoned, clock=clock), clock


def repeated_close(operation):
    try:
        operation()
    except (OSError, rooted.RootedFileUnavailable, windows.WindowsUnavailable):
        pass


class Scalar:
    def __init__(self, value=None):
        self.value = value


class Buffer:
    def __init__(self, value, units=None):
        self.value = value if type(value) is str else '\0' * value
    def __getitem__(self, index):
        return self.value[index]


class Stream:
    """No destructor, implicit close, real descriptor or image-byte support."""
    def __init__(self, world, descriptor):
        self.world, self.descriptor = world, descriptor
        self.closed = False
    def tell(self):
        self.world.event('stream.tell')
        return self.world.position
    def writable(self):
        self.world.event('stream.writable')
        return self.world.writable
    def close(self):
        self.world.event('stream.close', cleanup=True)
        assert not self.closed, 'physical stream generation retried'
        if self.world.close_fault == 'before':
            raise OSError('synthetic pre-close failure')
        self.world.descriptors.pop(self.descriptor)
        self.closed = True
        if self.world.close_fault == 'after':
            raise OSError('synthetic post-close failure')
    def read(self, *args):
        raise AssertionError('observation unexpectedly read image bytes')
    def readinto(self, *args):
        raise AssertionError('observation unexpectedly read image bytes')
    def seek(self, *args):
        raise AssertionError('reader construction tried to repair position')


class InertABI:
    """Actual CtypesWindowsNative methods; every called foreign operation is inert.

    The structures, byref/pointer/cast/sizeof helpers and kernel/CRT methods are
    plain Python doubles. Nothing imports ctypes, loads a DLL, opens a file or
    sends an integer to an operating-system API. Counts come from production.
    """
    def __init__(self, monkeypatch):
        self.events, self.cleanup_events, self.requests = [], [], []
        self.handles, self.descriptors = {}, {}
        self.next_handle = 100
        self.nodes = {(): ('directory', 1), ('Music',): ('directory', 2),
            ('Music', 'Albums'): ('directory', 3),
            ('Music', 'Albums', 'cover.png'): ('regular', 2 ** 127 + 9)}
        self.on_event = lambda name: None
        self.open_status = None
        self.close_fault = None
        self.position, self.writable = 0, False
        self.descriptor_inheritable = self.handle_inheritable = False
        self.fail_query = None
        self.serial = SERIAL
        self.pending = []
        self.returned = []
        native = self.native = object.__new__(windows.CtypesWindowsNative)
        native.quarantined = False
        native._cleanup_domain = rooted._CleanupDomain()
        native._HANDLE = Scalar
        native._ULONG = Scalar
        native.ctypes = SimpleNamespace(create_unicode_buffer=Buffer,
            cast=lambda value, kind: value, POINTER=lambda kind: kind,
            c_wchar=object(), sizeof=lambda value: 64,
            pointer=lambda value: value, byref=lambda value: value)
        native.UNICODE_STRING = lambda *args: SimpleNamespace(Buffer=args[2])
        native.OBJECT_ATTRIBUTES = lambda *args: SimpleNamespace(
            RootDirectory=args[1], ObjectName=args[2])
        native.IO_STATUS_BLOCK = lambda: SimpleNamespace(Status=0, Information=0)
        native.FILE_STANDARD_INFO = SimpleNamespace
        native.FILE_BASIC_INFO = SimpleNamespace
        native.FILE_ATTRIBUTE_TAG_INFO = SimpleNamespace
        native.FILE_ID_INFO = SimpleNamespace
        native.kernel = SimpleNamespace(
            GetVolumeNameForVolumeMountPointW=self.volume_guid,
            QueryDosDeviceW=self.query_dos_device, GetFileType=self.file_type,
            GetFileInformationByHandleEx=self.file_information,
            GetVolumeInformationByHandleW=self.volume_information,
            CloseHandle=self.close_handle)
        native.ntdll = SimpleNamespace(NtCreateFile=self.nt_create)
        native.quarantine = self.quarantine
        monkeypatch.setitem(sys.modules, 'msvcrt', SimpleNamespace(
            open_osfhandle=self.open_osfhandle, get_osfhandle=self.get_osfhandle))
        monkeypatch.setattr(windows, 'os', SimpleNamespace(
            O_RDONLY=0, O_BINARY=0x8000, O_NOINHERIT=0x80,
            get_inheritable=self.get_inheritable,
            get_handle_inheritable=self.get_handle_inheritable,
            fdopen=self.fdopen, close=self.close_descriptor))

    def event(self, name, *, cleanup=False):
        (self.cleanup_events if cleanup else self.events).append(name)
        self.on_event(name)

    def allocate(self, path):
        handle = self.next_handle
        self.next_handle += 1
        self.handles[handle] = tuple(path)
        return handle

    def volume_guid(self, drive, buffer, capacity):
        self.event('GetVolumeNameForVolumeMountPointW')
        assert drive == 'C:\\' and capacity == 64
        buffer.value = GUID
        return 0 if self.fail_query == 'GetVolumeNameForVolumeMountPointW' else 1

    def query_dos_device(self, alias, buffer, capacity):
        self.event('QueryDosDeviceW')
        assert alias in ('C:', windows.guid_alias(GUID))
        buffer.value = TARGET + '\0\0'
        return 0 if self.fail_query == 'QueryDosDeviceW' else len(buffer.value)

    def nt_create(self, output, access, attrs, iosb, allocation, attributes,
                  sharing, disposition, options, ea, ea_length):
        self.event('NtCreateFile')
        assert disposition == windows.FILE_OPEN and sharing == windows.FILE_SHARE_ALL
        assert allocation is None and attributes == 0 and ea is None and ea_length == 0
        name, parent = attrs.ObjectName.Buffer.value, attrs.RootDirectory
        path = () if parent is None else self.handles[parent] + (name,)
        if parent is None:
            assert name == TARGET + '\\'
        self.requests.append((path, access, options))
        override = self.open_status(path) if callable(self.open_status) else self.open_status
        if override is None and path not in self.nodes:
            override = (0xC0000034, 0x7FFFFFFF, None, 0)
        if override is not None:
            status, io_status, handle, information = override
            output.value = self.allocate(path) if handle == 'usable' else handle
            if io_status is not None:
                iosb.Status = io_status
            iosb.Information = information
            self.returned.append(output.value)
            return status
        output.value = self.allocate(path)
        iosb.Status, iosb.Information = 0, windows.FILE_OPENED
        self.returned.append(output.value)
        return 0

    def file_type(self, handle):
        self.event('GetFileType')
        assert handle in self.handles
        return 0 if self.fail_query == 'GetFileType' else windows.FILE_TYPE_DISK

    def file_information(self, handle, information_class, result, size):
        name = 'GetFileInformationByHandleEx:' + str(information_class)
        self.event(name)
        kind, number = self.nodes[self.handles[handle]]
        attributes = 0x10 if kind == 'directory' else 0x20
        if information_class == 1:
            result.Directory, result.DeletePending = kind == 'directory', False
            result.AllocationSize = result.EndOfFile = 0 if kind == 'directory' else 6
        elif information_class == 9:
            result.FileAttributes, result.ReparseTag = attributes, 0
        elif information_class == 0:
            result.FileAttributes, result.LastWriteTime, result.ChangeTime = attributes, 11, 12
        elif information_class == 18:
            result.VolumeSerialNumber = self.serial
            result.FileId = SimpleNamespace(Identifier=number.to_bytes(16, 'little'))
        else:
            raise AssertionError('unexpected native information class')
        return 0 if self.fail_query == name else 1

    def volume_information(self, handle, volume_name, volume_name_size, serial,
                           maximum, flags, filesystem, capacity):
        self.event('GetVolumeInformationByHandleW')
        assert self.nodes[self.handles[handle]][0] == 'directory'
        serial.value, maximum.value, flags.value = 1, 255, 0
        filesystem.value = 'NTFS'
        return 0 if self.fail_query == 'GetVolumeInformationByHandleW' else 1

    def close_handle(self, handle):
        self.event('CloseHandle', cleanup=True)
        assert handle in self.handles, 'numeric HANDLE generation retried'
        if self.close_fault == 'before':
            return 0
        self.handles.pop(handle)
        if self.close_fault == 'after':
            raise OSError('synthetic CloseHandle post-disposal failure')
        return 1

    def open_osfhandle(self, handle, flags):
        self.event('open_osfhandle')
        assert flags == 0x8080
        self.descriptors[700] = self.handles.pop(handle)
        return 700

    def get_inheritable(self, descriptor):
        self.event('get_inheritable')
        assert descriptor in self.descriptors
        return self.descriptor_inheritable

    def get_osfhandle(self, descriptor):
        self.event('get_osfhandle')
        assert descriptor in self.descriptors
        return 900  # Inert CRT-owned HANDLE, not present in the raw-handle ledger.

    def get_handle_inheritable(self, handle):
        self.event('get_handle_inheritable')
        assert handle == 900
        return self.handle_inheritable

    def fdopen(self, descriptor, mode, buffering):
        self.event('fdopen')
        assert (descriptor, mode, buffering) == (700, 'rb', 0)
        assert descriptor in self.descriptors
        return Stream(self, descriptor)

    def close_descriptor(self, descriptor):
        self.event('descriptor.close', cleanup=True)
        assert descriptor in self.descriptors, 'numeric descriptor generation retried'
        if self.close_fault == 'before':
            raise OSError('synthetic descriptor pre-close failure')
        self.descriptors.pop(descriptor)
        if self.close_fault == 'after':
            raise OSError('synthetic descriptor post-close failure')

    def quarantine(self, storage):
        self.native.quarantined = True
        self.pending.append(storage)
        raise windows.WindowsNativePending('synthetic pending observation only')


INFO_CALLS = ('GetFileType', 'GetFileInformationByHandleEx:1',
              'GetFileInformationByHandleEx:9', 'GetFileInformationByHandleEx:0',
              'GetFileInformationByHandleEx:18')
READER_CALLS = ('open_osfhandle', 'get_inheritable', 'get_osfhandle',
                'get_handle_inheritable', 'fdopen', 'stream.tell', 'stream.writable')


def direct_call(world, ctx, operation):
    """Real native method with its required real W1 owner/record and context."""
    with rooted._CleanupScope(operation_context=ctx):
        owner = rooted._CleanupOwner(world.native._cleanup_domain)
        record = None
        try:
            if operation in ('info', 'volume', 'reader'):
                path = ('Music', 'Albums', 'cover.png') if operation == 'reader' else ()
                handle = world.allocate(path)
                record = owner.reserve('handle', world.native.close, handle)
            elif operation == 'open':
                record = owner.reserve('handle', world.native.close)
            with rooted._CleanupScope(owner=owner, record=record):
                if operation == 'guid':
                    return world.native.volume_guid('C:\\')
                if operation == 'device':
                    return world.native.query_dos_device('C:')
                if operation == 'open':
                    return world.native.open(windows.OpenRequest(TARGET + '\\', None, True))
                if operation == 'info':
                    return world.native.info(handle)
                if operation == 'volume':
                    return world.native.volume_info(handle)
                if operation == 'reader':
                    return world.native.to_reader(handle)
                raise AssertionError('invalid fixed test operation')
        finally:
            repeated_close(owner.close_all)


def assert_counts(world, ctx):
    counts = ctx.counts()
    assert counts.syscalls == len(world.events)
    assert counts.cleanup_attempts == len(world.cleanup_events)
    assert counts.expansions == 0
    assert counts.combined_work == counts.components + counts.syscalls
    assert counts.cleanup_failures <= counts.cleanup_attempts


@pytest.mark.parametrize('operation,expected', [
    ('guid', ('GetVolumeNameForVolumeMountPointW',)),
    ('device', ('QueryDosDeviceW',)), ('open', ('NtCreateFile',)),
    ('info', ('GetFileType', 'GetFileInformationByHandleEx:1',
              'GetFileInformationByHandleEx:9', 'GetFileInformationByHandleEx:0',
              'GetFileInformationByHandleEx:18')),
    ('volume', ('GetVolumeInformationByHandleW',)),
    ('reader', ('open_osfhandle', 'get_inheritable', 'get_osfhandle',
                'get_handle_inheritable', 'fdopen', 'stream.tell', 'stream.writable')),
])
def test_actual_native_success_counts_every_reached_call(monkeypatch, operation, expected):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    direct_call(world, ctx, operation)
    assert tuple(world.events) == expected
    assert_counts(world, ctx)
    assert not world.handles and not world.descriptors and not world.pending
    assert ctx.counts().cleanup_failures == 0


@pytest.mark.parametrize('call', ['GetFileType', 'GetFileInformationByHandleEx:1',
    'GetFileInformationByHandleEx:9', 'GetFileInformationByHandleEx:0',
    'GetFileInformationByHandleEx:18'])
def test_info_early_failure_counts_only_actual_queries(monkeypatch, call):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    world.fail_query = call
    with pytest.raises(windows.WindowsUnavailable):
        direct_call(world, ctx, 'info')
    assert world.events == list(INFO_CALLS[:INFO_CALLS.index(call) + 1])
    assert_counts(world, ctx)
    assert not world.handles


@pytest.mark.parametrize('operation', ['guid', 'device', 'open', 'info', 'volume', 'reader'])
@pytest.mark.parametrize('reason', ['deadline', 'abandoned', 'work'])
def test_pre_call_rejection_dispatches_nothing_and_preserves_known_cleanup(monkeypatch, operation, reason):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    if reason == 'deadline':
        clock.now = 10.0
    elif reason == 'abandoned':
        clock.abandoned = True
    else:
        ctx.syscalls = 262144
    with pytest.raises(resolver._Stop) as caught:
        direct_call(world, ctx, operation)
    assert str(caught.value) == ('artwork_validation_limit' if reason == 'work' else 'artwork_probe_timeout')
    assert world.events == [] and not world.pending
    assert not world.handles and not world.descriptors
    assert ctx.counts().syscalls == (262144 if reason == 'work' else 0)
    assert ctx.counts().cleanup_attempts == len(world.cleanup_events)
    assert ctx.counts().cleanup_failures == 0
    assert not world.native._cleanup_domain.is_blocked()


@pytest.mark.parametrize('operation,call', [
    ('guid', 'GetVolumeNameForVolumeMountPointW'), ('device', 'QueryDosDeviceW'),
    ('open', 'NtCreateFile'), ('info', 'GetFileType'),
    ('info', 'GetFileInformationByHandleEx:1'), ('info', 'GetFileInformationByHandleEx:9'),
    ('info', 'GetFileInformationByHandleEx:0'), ('info', 'GetFileInformationByHandleEx:18'),
    ('volume', 'GetVolumeInformationByHandleW'), ('reader', 'open_osfhandle'),
    ('reader', 'get_inheritable'), ('reader', 'get_osfhandle'),
    ('reader', 'get_handle_inheritable'), ('reader', 'fdopen'),
    ('reader', 'stream.tell'), ('reader', 'stream.writable'),
])
@pytest.mark.parametrize('reason', ['deadline', 'abandoned'])
def test_after_return_rejection_owns_returned_stage_before_cleanup(monkeypatch, operation, call, reason):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    def expire(name):
        if name == call:
            if reason == 'deadline':
                clock.now = 10.0
            else:
                clock.abandoned = True
    world.on_event = expire
    with pytest.raises(resolver._Stop, match='artwork_probe_timeout'):
        direct_call(world, ctx, operation)
    assert world.events[-1] == call
    assert not world.handles and not world.descriptors and not world.pending
    assert_counts(world, ctx)
    assert ctx.counts().cleanup_failures == 0
    assert not world.native._cleanup_domain.is_blocked()
    if operation == 'open':
        assert world.cleanup_events == ['CloseHandle'] and len(world.returned) == 1
    if operation == 'reader':
        expected = 'descriptor.close' if READER_CALLS.index(call) < 4 else 'stream.close'
        assert world.cleanup_events == [expected]


@pytest.mark.parametrize('allowed', [0, 1, 2, 3, 4, 5])
def test_combined_work_equality_and_one_over_at_each_actual_info_call(monkeypatch, allowed):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    ctx.components = 262144 - allowed
    if allowed < 5:
        with pytest.raises(resolver._Stop, match='artwork_validation_limit'):
            direct_call(world, ctx, 'info')
    else:
        direct_call(world, ctx, 'info')
    assert world.events == list(INFO_CALLS[:allowed])
    assert ctx.counts().combined_work == 262144
    assert ctx.counts().syscalls == allowed
    assert ctx.counts().cleanup_attempts == 1 and world.cleanup_events == ['CloseHandle']
    assert not world.handles and not world.pending
    with pytest.raises(resolver._Stop, match='artwork_validation_limit'):
        ctx.before_syscall()
    assert ctx.counts().combined_work == 262144


@pytest.mark.parametrize('field', ['descriptor_inheritable', 'handle_inheritable', 'position', 'writable'])
def test_reader_validation_short_circuit_is_counted_without_repair(monkeypatch, field):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    setattr(world, field, True if field != 'position' else 1)
    with pytest.raises(windows.WindowsUnavailable):
        direct_call(world, ctx, 'reader')
    last = {'descriptor_inheritable': 'get_inheritable',
            'handle_inheritable': 'get_handle_inheritable',
            'position': 'stream.tell', 'writable': 'stream.writable'}[field]
    assert world.events == list(READER_CALLS[:READER_CALLS.index(last) + 1])
    assert_counts(world, ctx)
    assert not world.handles and not world.descriptors


@pytest.mark.parametrize('fault', ['before', 'after'])
@pytest.mark.parametrize('operation', ['open', 'descriptor', 'reader'])
def test_failed_physical_cleanup_counts_once_after_deadline_and_never_retries(monkeypatch, operation, fault):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    world.close_fault = fault
    def expire(name):
        if name == {'open': 'NtCreateFile', 'descriptor': 'open_osfhandle',
                    'reader': 'stream.writable'}[operation]:
            clock.now = 10.0
    world.on_event = expire
    with pytest.raises(resolver._Stop, match='artwork_probe_timeout'):
        direct_call(world, ctx, 'reader' if operation == 'descriptor' else operation)
    assert ctx.counts().cleanup_attempts == ctx.counts().cleanup_failures == 1
    assert len(world.cleanup_events) == 1
    assert world.native._cleanup_domain.is_blocked() and ctx.cleanup_incomplete
    owners = tuple(world.native._cleanup_domain._owners)
    assert owners
    before = list(world.cleanup_events)
    for owner in owners:
        repeated_close(owner.close_all)
        repeated_close(owner.close_all)
    assert world.cleanup_events == before
    assert ctx.counts().cleanup_attempts == ctx.counts().cleanup_failures == 1


@pytest.mark.parametrize('kind', ['root_only', 'regular', 'missing'])
def test_rooted_metadata_observation_never_constructs_reader_or_reads_leaf(monkeypatch, kind):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    backend = windows.WindowsBackend(world.native)
    if kind == 'root_only':
        monkeypatch.setattr(windows, 'WindowsBackend', lambda: backend)
        stamp = rooted.observe_root(rooted.RootObservationSelection('win32', ROOT), operation_context=ctx)
    else:
        selection = SELECTION if kind == 'regular' else rooted.RootSelection(
            'win32', ROOT, ('Albums', 'missing.png'))
        value = rooted.observe_selection(selection, operation_context=ctx, backend=backend)
        assert value.platform == 'win32'
        assert value.leaf_state == ('regular' if kind == 'regular' else 'missing_tail')
        stamp = value.root_stamp
    assert type(stamp) is windows.WindowsRootStamp and stamp.platform == 'win32'
    assert stamp.identity.volume_serial == SERIAL
    assert stamp.identity.file_id == (2).to_bytes(16, 'little')
    assert stamp.selector == windows.SelectorSnapshot('C:', GUID, TARGET, TARGET)
    assert not any(name in READER_CALLS for name in world.events)
    assert all(not access & windows.FILE_READ_DATA for path, access, options in world.requests)
    assert not world.handles and not world.descriptors and not world.pending
    assert_counts(world, ctx)
    assert ctx.counts().components > 0 and not ctx.cleanup_incomplete
    if kind == 'root_only':
        assert all(path in ((), ('Music',)) for path, access, options in world.requests)


@pytest.mark.parametrize('status', [0xC0000034, 0xC000003A])
@pytest.mark.parametrize('io_status', [None, 0, 0x00000103, 0xC0000022])
@pytest.mark.parametrize('handle', [None, 0, -1])
def test_completed_missing_uses_return_status_not_iosb(monkeypatch, status, io_status, handle):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    selection = rooted.RootSelection('win32', ROOT, ('Albums', 'missing.png'))
    world.open_status = lambda path: (status, io_status, handle, 0) if path[-1:] == ('missing.png',) else None
    value = rooted.observe_selection(selection, operation_context=ctx, backend=windows.WindowsBackend(world.native))
    assert value.leaf_state == 'missing_tail'
    assert value.root_stamp.identity.volume_serial == SERIAL
    assert not world.pending and not world.native._cleanup_domain.is_blocked()
    assert not world.handles
    assert_counts(world, ctx)


@pytest.mark.parametrize('status', [0xC000000F, 0xC0000022, 0xC0000043,
                                    0xC0000056, 0xC0000033, 0xC0000275])
@pytest.mark.parametrize('io_status', [None, 0x00000103])
def test_unreviewed_or_denied_status_is_never_missing(monkeypatch, status, io_status):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    world.open_status = lambda path: (status, io_status, None, 0) if path[-1:] == ('missing.png',) else None
    with pytest.raises((rooted.RootedFileUnavailable, windows.WindowsUnavailable)):
        rooted.observe_selection(rooted.RootSelection('win32', ROOT, ('Albums', 'missing.png')),
            operation_context=ctx, backend=windows.WindowsBackend(world.native))
    assert not world.pending and not world.handles
    assert_counts(world, ctx)


@pytest.mark.parametrize('position', ['bootstrap', 'selected_root'])
@pytest.mark.parametrize('status', [0xC0000034, 0xC000003A])
def test_missing_root_or_bootstrap_is_not_a_ready_root(monkeypatch, position, status):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    target = () if position == 'bootstrap' else ('Music',)
    world.open_status = lambda path: (status, None, None, 0) if path == target else None
    backend = windows.WindowsBackend(world.native)
    with pytest.raises((rooted.RootedFileUnavailable, windows.WindowsUnavailable)):
        backend.describe_root(rooted.RootObservationSelection('win32', ROOT), operation_context=ctx)
    assert not world.handles and not world.pending
    assert_counts(world, ctx)


@pytest.mark.parametrize('status', [0xC0000034, 0xC000003A])
@pytest.mark.parametrize('fault', [None, 'before', 'after'])
def test_missing_failure_with_usable_handle_is_cleaned_but_still_unavailable(monkeypatch, status, fault):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    reached = []
    def anomalous(path):
        if path[-1:] == ('missing.png',):
            reached.append(path)
            world.close_fault = fault
            return (status, None, 'usable', 0)
        return None
    world.open_status = anomalous
    with pytest.raises((rooted.RootedFileUnavailable, windows.WindowsUnavailable)):
        rooted.observe_selection(rooted.RootSelection('win32', ROOT, ('Albums', 'missing.png')),
            operation_context=ctx, backend=windows.WindowsBackend(world.native))
    assert len(reached) == 1 and not world.pending
    assert ctx.counts().cleanup_attempts == len(world.cleanup_events)
    assert bool(ctx.counts().cleanup_failures) is (fault is not None)
    assert world.native._cleanup_domain.is_blocked() is (fault is not None)
    before = list(world.cleanup_events)
    for owner in tuple(world.native._cleanup_domain._owners):
        repeated_close(owner.close_all)
    assert world.cleanup_events == before


@pytest.mark.parametrize('io_status', [0, 0x00000103, 0x7FFFFFFF])
def test_true_return_pending_keeps_storage_and_every_live_parent(monkeypatch, io_status):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    before = []
    def pending(path):
        if path == ('Music', 'Albums', 'cover.png'):
            before.append(len(world.cleanup_events))
            return (0x00000103, io_status, 'usable', 1)
        return None
    world.open_status = pending
    backend = windows.WindowsBackend(world.native)
    with pytest.raises(windows.WindowsNativePending):
        rooted.observe_selection(SELECTION, operation_context=ctx, backend=backend)
    assert len(before) == 1 and len(world.cleanup_events) == before[0]
    assert world.pending and world.handles and ctx.cleanup_incomplete
    owners = tuple(backend._cleanup_domain._owners)
    assert owners and any(record.storage is not None and record.state == 'pending'
                          for owner in owners for record in owner.records())
    for owner in owners:
        repeated_close(owner.close_all)
    assert len(world.cleanup_events) == before[0]
    assert_counts(world, ctx)


@pytest.mark.parametrize('phase', ['acquire', 'check', 'reader'])
def test_same_context_survives_acquisition_rechecks_and_reader_wrappers(monkeypatch, phase):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    backend = windows.WindowsBackend(world.native)
    lease = rooted.acquire(SELECTION, backend=backend, operation_context=ctx)
    assert lease._resource._cleanup_owner.operation_context is ctx
    if phase in ('check', 'reader'):
        lease.check()
    if phase == 'reader':
        reader = lease.independent_reader()
        assert world.events.count('stream.tell') == 2
        assert world.events.count('stream.writable') == 2
        before = len(world.cleanup_events)
        reader.close()
        reader.close()
        assert world.cleanup_events[before:] == ['stream.close']
    lease.close()
    assert lease.drained.is_set()
    assert_counts(world, ctx)
    assert not world.handles and not world.descriptors
    assert not ctx.cleanup_incomplete and not ctx._cleanup_owners


@pytest.mark.parametrize('boundary', ['open_osfhandle', 'fdopen'])
@pytest.mark.parametrize('consumed', [False, True])
@pytest.mark.parametrize('route', ['native', 'neutral_lease'])
def test_consuming_call_exception_retains_uncertainty_with_exact_context(monkeypatch, boundary, consumed, route):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    lease = None
    if route == 'neutral_lease':
        lease = rooted.acquire(SELECTION, backend=windows.WindowsBackend(world.native), operation_context=ctx)
    primary = MemoryError('synthetic foreign-return allocation failure')
    saved = world.open_osfhandle if boundary == 'open_osfhandle' else world.fdopen
    recycled = []
    def fail(*args, **kwargs):
        if consumed:
            saved(*args, **kwargs)
            # Model an unobservable consuming side effect and immediate numeric
            # reuse. These are inside the inert foreign call, not extra
            # product-controlled close attempts or claimed kernel counts.
            ledger = world.handles if boundary == 'open_osfhandle' else world.descriptors
            ledger.pop(args[0], None)
            ledger[args[0]] = ('recycled-unrelated',)
            recycled.append((ledger, args[0]))
        else:
            world.event(boundary)
        raise primary
    if boundary == 'open_osfhandle':
        monkeypatch.setattr(sys.modules['msvcrt'], 'open_osfhandle', fail)
    else:
        monkeypatch.setattr(windows.os, 'fdopen', fail)
    cleanup_at_boundary = []
    world.on_event = lambda name: cleanup_at_boundary.append(len(world.cleanup_events)) if name == boundary else None
    with pytest.raises(MemoryError) as caught:
        if route == 'native':
            direct_call(world, ctx, 'reader')
        else:
            lease.independent_reader()
    assert caught.value is primary
    assert len(cleanup_at_boundary) == 1
    assert len(world.cleanup_events) == cleanup_at_boundary[0]
    assert ctx.cleanup_incomplete and world.native._cleanup_domain.is_blocked()
    owners = tuple(world.native._cleanup_domain._owners)
    assert any(record.state == 'uncertain' for owner in owners for record in owner.records())
    if lease is not None:
        assert lease._active == lease._readers == 1 and not lease.drained.is_set()
        repeated_close(lease.close)
        assert lease._active == lease._readers == 1 and not lease.drained.is_set()
    before = list(world.cleanup_events)
    for owner in owners:
        for record in owner.records():
            if record.state == 'uncertain':
                repeated_close(record.close)
    assert world.cleanup_events == before
    assert all(ledger[number] == ('recycled-unrelated',) for ledger, number in recycled)
    assert len(recycled) == int(consumed)
    assert_counts(world, ctx)


@pytest.mark.parametrize('kind,syscalls,components,closes', [
    ('root', 60, 2, 5), ('regular', 94, 6, 9)])
def test_whole_rooted_observation_exact_native_and_component_ledger(monkeypatch, kind, syscalls, components, closes):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    backend = windows.WindowsBackend(world.native)
    if kind == 'root':
        result = backend.describe_root(rooted.RootObservationSelection('win32', ROOT), operation_context=ctx)
        assert type(result) is windows.WindowsRootStamp
    else:
        result = rooted.observe_selection(SELECTION, operation_context=ctx, backend=backend)
        assert result.leaf_state == 'regular'
    assert_counts(world, ctx)
    assert ctx.counts().syscalls == syscalls
    assert ctx.counts().components == components
    assert ctx.counts().cleanup_attempts == closes
    assert not ctx._cleanup_owners and not ctx.cleanup_incomplete


@pytest.mark.parametrize('count', [0, 1, 8, 9])
def test_context_registers_bounded_strong_owners_before_any_native_resource(monkeypatch, count):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    owners = []
    with rooted._CleanupScope(operation_context=ctx):
        for index in range(count):
            if index == 8:
                with pytest.raises(resolver._Stop, match='artwork_probe_unavailable'):
                    rooted._CleanupOwner(world.native._cleanup_domain)
            else:
                owners.append(rooted._CleanupOwner(world.native._cleanup_domain))
    assert len(ctx._cleanup_owners) == len(owners) == min(count, 8)
    assert len(world.native._cleanup_domain._owners) == min(count, 8)
    assert not world.events and not world.cleanup_events
    for owner in owners:
        owner.close_all()
    ctx.assert_discharged()
    assert not ctx._cleanup_owners and not world.native._cleanup_domain._owners


@pytest.mark.parametrize('when', ['before_registration', 'after_registration'])
def test_owner_registration_allocation_failure_unwinds_without_native_dispatch(monkeypatch, when):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    primary = MemoryError('bounded registration allocation')
    original = ctx.register_cleanup_owner
    def reject(owner):
        if when == 'after_registration':
            original(owner)
        raise primary
    ctx.register_cleanup_owner = reject
    with pytest.raises(MemoryError) as caught:
        rooted.observe_selection(SELECTION, operation_context=ctx,
            backend=windows.WindowsBackend(world.native))
    assert caught.value is primary
    assert not ctx._cleanup_owners and not world.native._cleanup_domain._owners
    assert not world.native._cleanup_domain.is_blocked()
    assert not world.events and not world.cleanup_events
    assert ctx.counts() == resolver.WorkCounts()


@pytest.mark.parametrize('reporter', ['attempt', 'failure'])
def test_broken_cleanup_reporting_cannot_skip_the_legal_physical_close(monkeypatch, reporter):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    with rooted._CleanupScope(operation_context=ctx):
        owner = rooted._CleanupOwner(world.native._cleanup_domain)
        handle = world.allocate(())
        record = owner.reserve('handle', world.native.close, handle)
    primary = MemoryError('reporting allocation')
    if reporter == 'attempt':
        def reject():
            raise primary
        ctx.record_cleanup_attempt = reject
    else:
        world.close_fault = 'after'
        def reject():
            raise primary
        ctx.record_cleanup_failure = reject
    clock.now, clock.abandoned = 100.0, True
    with pytest.raises(BaseException):
        record.close()
    assert world.cleanup_events == ['CloseHandle'] and handle not in world.handles
    assert record.state == 'uncertain' and ctx.cleanup_incomplete
    before = list(world.cleanup_events)
    repeated_close(record.close)
    owner.close_all()
    assert world.cleanup_events == before
    assert ctx.counts().syscalls == 0


@pytest.mark.parametrize('operation,call', [('guid', 'GetVolumeNameForVolumeMountPointW'),
    ('device', 'QueryDosDeviceW'), ('volume', 'GetVolumeInformationByHandleW')])
def test_selector_and_volume_failure_count_only_reached_foreign_call(monkeypatch, operation, call):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    world.fail_query = call
    with pytest.raises(windows.WindowsUnavailable):
        direct_call(world, ctx, operation)
    assert world.events == [call]
    assert_counts(world, ctx)
    assert not world.handles and not world.pending


@pytest.mark.parametrize('io_status,information,handle', [
    (0xC0000022, 1, 'usable'), (0, 0, 'usable'), (0, 2, 'usable'),
    (0, 1, None), (0, 1, 0), (0, 1, -1)])
def test_well_formed_completed_success_rejection_keeps_known_safe_close(monkeypatch, io_status, information, handle):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    world.open_status = lambda path: (0, io_status, handle, information) if path == () else None
    with pytest.raises(windows.WindowsUnavailable, match='windows_native_open_failed'):
        rooted.observe_selection(SELECTION, operation_context=ctx,
            backend=windows.WindowsBackend(world.native))
    assert not world.pending and not world.handles
    assert world.cleanup_events == (['CloseHandle'] if handle == 'usable' else [])
    assert_counts(world, ctx)
    assert not ctx.cleanup_incomplete and not world.native._cleanup_domain.is_blocked()


@pytest.mark.parametrize('io_status', [0x00000103, 0x7FFFFFFF])
def test_success_return_with_incomplete_iosb_retains_native_storage(monkeypatch, io_status):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    world.open_status = (0, io_status, 'usable', 1)
    with pytest.raises(windows.WindowsNativePending):
        rooted.observe_selection(SELECTION, operation_context=ctx,
            backend=windows.WindowsBackend(world.native))
    assert world.pending and len(world.handles) == 1 and not world.cleanup_events
    assert ctx.counts().syscalls == 4 and ctx.cleanup_incomplete
    assert_counts(world, ctx)


@pytest.mark.parametrize('field,value', [('completed', 1), ('status', True),
    ('io_status', -1), ('information', 2 ** 64), ('handle', True), ('handle', 2 ** 64)])
def test_backend_malformed_native_result_retains_ownership_without_missing_classification(monkeypatch, field, value):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    actual = world.native.open
    def malformed(request):
        return replace(actual(request), **{field: value})
    monkeypatch.setattr(world.native, 'open', malformed)
    with pytest.raises(windows.WindowsNativePending):
        rooted.observe_selection(SELECTION, operation_context=ctx,
            backend=windows.WindowsBackend(world.native))
    assert world.pending and world.handles and not world.cleanup_events
    assert ctx.cleanup_incomplete and world.native._cleanup_domain.is_blocked()
    assert_counts(world, ctx)


@pytest.mark.parametrize('reason', ['deadline', 'abandoned'])
def test_completed_missing_return_after_deadline_cannot_publish_missing_tail(monkeypatch, reason):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    def missing(path):
        if path[-1:] == ('missing.png',):
            if reason == 'deadline':
                clock.now = 10.0
            else:
                clock.abandoned = True
            return 0xC0000034, None, None, 0
        return None
    world.open_status = missing
    with pytest.raises(resolver._Stop, match='artwork_probe_timeout'):
        rooted.observe_selection(rooted.RootSelection('win32', ROOT, ('Albums', 'missing.png')),
            operation_context=ctx, backend=windows.WindowsBackend(world.native))
    assert not world.pending and not world.handles and not ctx.cleanup_incomplete
    assert_counts(world, ctx)


@pytest.mark.parametrize('mutation', ['parent_identity', 'leaf_identity', 'volume_high_bit',
    'reparse', 'delete_pending', 'volume_not_ntfs', 'selector_change'])
def test_retained_metadata_or_selector_changes_fail_closed_with_real_call_ledger(monkeypatch, mutation):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    information = world.native.kernel.GetFileInformationByHandleEx
    seen = {}
    def changed(handle, kind, result, size):
        answer = information(handle, kind, result, size)
        path = world.handles[handle]
        key = (path, kind)
        seen[key] = seen.get(key, 0) + 1
        if mutation == 'parent_identity' and path == ('Music',) and kind == 18 and seen[key] >= 3:
            result.FileId.Identifier = (2 ** 127 + 2).to_bytes(16, 'little')
        if mutation == 'leaf_identity' and path[-1:] == ('cover.png',) and kind == 18 and seen[key] >= 2:
            result.FileId.Identifier = (2 ** 127 + 10).to_bytes(16, 'little')
        if mutation == 'volume_high_bit' and path == ('Music',) and kind == 18:
            result.VolumeSerialNumber = SERIAL ^ (1 << 63)
        if mutation == 'reparse' and path == ('Music', 'Albums') and kind in (0, 9):
            result.FileAttributes |= windows.FILE_ATTRIBUTE_REPARSE_POINT
            if kind == 9:
                result.ReparseTag = 0xA000000C
        if mutation == 'delete_pending' and path[-1:] == ('cover.png',) and kind == 1:
            result.DeletePending = True
        return answer
    monkeypatch.setattr(world.native.kernel, 'GetFileInformationByHandleEx', changed)
    if mutation == 'volume_not_ntfs':
        original = world.native.kernel.GetVolumeInformationByHandleW
        def wrong_filesystem(*args):
            answer = original(*args)
            args[-2].value = 'FAT32'
            return answer
        monkeypatch.setattr(world.native.kernel, 'GetVolumeInformationByHandleW', wrong_filesystem)
    if mutation == 'selector_change':
        original = world.native.kernel.QueryDosDeviceW
        lookups = []
        def changed_selector(*args):
            answer = original(*args)
            lookups.append(args[0])
            if len(lookups) >= 3:
                args[1].value = '\\Device\\HarddiskVolume24\0\0'
                answer = len(args[1].value)
            return answer
        monkeypatch.setattr(world.native.kernel, 'QueryDosDeviceW', changed_selector)
    with pytest.raises(windows.WindowsUnavailable):
        rooted.observe_selection(SELECTION, operation_context=ctx, backend=windows.WindowsBackend(world.native))
    assert not world.handles and not world.pending and not ctx.cleanup_incomplete
    assert_counts(world, ctx)


@pytest.mark.parametrize('change', ['appeared', 'parent_replaced', 'recheck_denied'])
def test_missing_tail_rechecks_existing_parents_and_same_missing_component(monkeypatch, change):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    missing = ('Music', 'Albums', 'absent')
    visits = []
    def status(path):
        if path == missing:
            visits.append(path)
            if len(visits) == 1:
                if change == 'parent_replaced':
                    world.nodes[('Music', 'Albums')] = ('directory', 2 ** 127 + 3)
                return 0xC000003A, None, None, 0
            if change == 'appeared':
                world.nodes[missing] = ('directory', 4)
                return None
            return 0xC0000022, None, None, 0
        return None
    world.open_status = status
    selection = rooted.RootSelection('win32', ROOT, ('Albums', 'absent', 'tail', 'cover.png'))
    with pytest.raises(windows.WindowsUnavailable):
        rooted.observe_selection(selection, operation_context=ctx, backend=windows.WindowsBackend(world.native))
    assert len(visits) == (1 if change == 'parent_replaced' else 2)
    assert all(path[:3] != missing or len(path) == 3 for path, access, options in world.requests)
    assert not world.handles and not world.pending
    assert_counts(world, ctx)


def test_opaque_reader_pre_dispatch_deadline_keeps_handle_safe_and_neutral_ticket_drained(monkeypatch):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    lease = rooted.acquire(SELECTION, backend=windows.WindowsBackend(world.native), operation_context=ctx)
    resource = lease._resource
    original = resource.check
    checks = []
    def expire_after_third_check():
        result = original()
        checks.append(result)
        if len(checks) == 3:
            clock.now = 10.0
        return result
    monkeypatch.setattr(resource, 'check', expire_after_third_check)
    before = len(world.events)
    with pytest.raises(resolver._Stop, match='artwork_probe_timeout'):
        lease.independent_reader()
    assert len(checks) == 3 and 'open_osfhandle' not in world.events[before:]
    assert not ctx.cleanup_incomplete and not world.native._cleanup_domain.is_blocked()
    assert lease._active == lease._readers == 0
    lease.close()
    assert lease.drained.is_set() and not world.handles and not world.descriptors
    assert_counts(world, ctx)


def test_prepared_native_argument_failure_precedes_count_and_pending_region(monkeypatch):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    primary = MemoryError('argument tuple preparation')
    calls = []
    def failing_byref(value):
        calls.append(value)
        if len(calls) == 2:
            raise primary
        return value
    world.native.ctypes.byref = failing_byref
    with pytest.raises(MemoryError) as caught:
        direct_call(world, ctx, 'open')
    assert caught.value is primary
    assert not world.events and not world.cleanup_events and not world.pending
    assert not ctx.cleanup_incomplete and not world.native._cleanup_domain.is_blocked()


@pytest.mark.parametrize('remaining_calls', [0, 1])
def test_outer_opaque_reader_budget_precheck_never_counts_dispatch_or_enters_rejected_bridge(monkeypatch, remaining_calls):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    lease = rooted.acquire(SELECTION, backend=windows.WindowsBackend(world.native), operation_context=ctx)
    resource = lease._resource
    actual_check, actual_reader = resource.check, world.native.to_reader
    checks, dispatches = [], []
    def set_remaining_at_bridge():
        result = actual_check()
        checks.append(result)
        if len(checks) == 3:  # Neutral admission, inner initial, inner final.
            ctx.components = 262144 - ctx.syscalls - remaining_calls
            assert ctx.components >= 0
        return result
    def opaque_reader(handle):
        dispatches.append(handle)
        return actual_reader(handle)
    monkeypatch.setattr(resource, 'check', set_remaining_at_bridge)
    monkeypatch.setattr(world.native, 'to_reader', opaque_reader)
    before = len(world.events)
    with pytest.raises(resolver._Stop, match='artwork_validation_limit'):
        lease.independent_reader()
    assert len(checks) == 3 and len(dispatches) == remaining_calls
    after = world.events[before:]
    assert after.count('open_osfhandle') == remaining_calls
    assert 'get_inheritable' not in after  # The next foreign call is one over.
    assert ctx.counts().combined_work == 262144
    assert not ctx.cleanup_incomplete and not world.native._cleanup_domain.is_blocked()
    assert lease._active == lease._readers == 0
    lease.close()
    assert lease.drained.is_set() and not world.handles and not world.descriptors
    assert_counts(world, ctx)


@pytest.mark.parametrize('status', [0xC0000034, 0xC000003A])
def test_pointer_width_invalid_handle_normalizes_without_resource_or_missing_guess(monkeypatch, status):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    world.native._HANDLE = lambda value=None: Scalar(2 ** 64 - 1 if value == -1 else value)
    world.open_status = lambda path: (status, None, 2 ** 64 - 1, 0) if path[-1:] == ('missing.png',) else None
    result = rooted.observe_selection(rooted.RootSelection('win32', ROOT, ('Albums', 'missing.png')),
        operation_context=ctx, backend=windows.WindowsBackend(world.native))
    assert result.leaf_state == 'missing_tail'
    assert not world.handles and not world.pending and not ctx.cleanup_incomplete
    assert_counts(world, ctx)


def test_native_calls_run_outside_context_and_owner_state_locks(monkeypatch):
    world, (ctx, clock) = InertABI(monkeypatch), context()
    checked = []
    def verify(name):
        assert ctx._counts_lock.acquire(blocking=False), 'context lock enclosed native dispatch'
        ctx._counts_lock.release()
        owner = rooted._cleanup_current('owner')
        if owner is not None:
            assert owner._lock.acquire(blocking=False), 'cleanup state lock enclosed native dispatch'
            owner._lock.release()
        checked.append(name)
    world.on_event = verify
    lease = rooted.acquire(SELECTION, backend=windows.WindowsBackend(world.native), operation_context=ctx)
    reader = lease.independent_reader()
    reader.close()
    lease.close()
    assert checked and len(checked) == len(world.events) + len(world.cleanup_events)
    assert lease.drained.is_set() and not world.handles and not world.descriptors
    assert_counts(world, ctx)
