"""Fixed W0 native scenarios. Only the isolated supervised child runs this file.

No app factory, config, DB, decoder, network, shell, ACL or device-map mutation.
The parent kills/reaps a hung child and records failure; this is NOT product I/O
cancellation, failed-close recovery, counted-probe acceptance or activation.
"""
import ctypes
import importlib
import importlib.abc
import itertools
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys

SCENARIOS = (
    'abi_selector', 'ordinary_reads', 'missing_and_kinds',
    'rename_root', 'rename_intermediate', 'rename_leaf', 'content_mutations',
    'wrong_expected_root', 'sharing_denial', 'locked_read',
    'junction_root', 'junction_intermediate', 'junction_leaf',
    'reader_lifecycle', 'repeated_cleanup',
)
PAYLOAD = b'W0-owned-inert-bytes-0123456789'
MAX_RESULT = 16384
REPARSE = 0x400
MOUNT_POINT = 0xA0000003
INVALID_HANDLE = ctypes.c_void_p(-1).value


class CaseFailure(RuntimeError):
    pass


def require(condition, code):
    if not condition:
        raise CaseFailure(code)


def plain_chain(path):
    """Check every existing lexical component before path-based fixture I/O."""
    require(path.is_absolute() and re.fullmatch(r'[A-Za-z]:', path.drive),
            'host_not_direct_drive')
    current = Path(path.anchor)
    for component in (None, *path.parts[1:]):
        if component is not None:
            require(component not in ('.', '..'), 'unsafe_component')
            current = current / component
        value = current.lstat()
        require(stat.S_ISDIR(value.st_mode) and
                not value.st_file_attributes & REPARSE, 'unsafe_root_chain')


def owner_marker(path, nonce):
    value = path.lstat()
    require(stat.S_ISREG(value.st_mode) and value.st_size == 32 and
            not value.st_file_attributes & REPARSE, 'owner_marker_kind')
    require(path.read_text('ascii') == nonce, 'owner_marker_changed')


def bootstrap():
    require(sys.flags.isolated == 1 and sys.flags.no_site == 1 and
            sys.dont_write_bytecode and __debug__, 'interpreter_not_isolated')
    helper = Path(__file__).resolve(strict=True)
    require(helper.parts[-3:] == ('tests', 'windows_native',
            'rooted_windows_acceptance_worker.py'), 'helper_origin')
    root = helper.parents[2]
    expected = {
        'music_app': root / 'music_app/__init__.py',
        'music_app.services': root / 'music_app/services/__init__.py',
        'music_app.services._rooted_local_file_windows':
            root / 'music_app/services/_rooted_local_file_windows.py',
        'music_app.services.rooted_local_file':
            root / 'music_app/services/rooted_local_file.py',
    }
    require(all(path.is_file() for path in expected.values()), 'checkout_incomplete')
    require(not any(name == 'music_app' or name.startswith('music_app.')
                    or name == 'config' for name in sys.modules), 'unexpected_preimport')
    class ImportBoundary(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            if (fullname == 'config' or fullname.startswith('config.') or
                    fullname == 'app' or fullname.startswith('app.') or
                    (fullname.startswith('music_app.') and fullname not in expected)):
                raise CaseFailure('unexpected_product_import')
            return None  # Genuine normal import machinery, never a substitute module.

    sys.meta_path.insert(0, ImportBoundary())
    sys.path.insert(0, str(root))
    windows = importlib.import_module('music_app.services._rooted_local_file_windows')
    neutral = importlib.import_module('music_app.services.rooted_local_file')
    for name, path in expected.items():
        require(Path(sys.modules[name].__file__).resolve(strict=True) == path,
                'module_origin')
    require({name for name in sys.modules
             if name == 'music_app' or name.startswith('music_app.')} == set(expected)
            and 'config' not in sys.modules, 'unexpected_product_import')
    return windows, neutral


class Oracle:
    """Independent fixed Win32 signatures and raw byte layouts; no product structs."""
    def __init__(self):
        c = ctypes
        self.kernel = c.WinDLL('kernel32', use_last_error=True)
        self.advapi = c.WinDLL('advapi32', use_last_error=True)
        H, D, B, P = c.c_void_p, c.c_uint32, c.c_int32, c.c_void_p
        self.bind(self.kernel, 'CreateFileW', H,
                  (c.c_wchar_p, D, D, P, D, D, H))
        self.bind(self.kernel, 'CloseHandle', B, (H,))
        self.bind(self.kernel, 'GetFileInformationByHandleEx', B, (H, c.c_int32, P, D))
        self.bind(self.kernel, 'GetFileType', D, (H,))
        self.bind(self.kernel, 'GetDriveTypeW', D, (c.c_wchar_p,))
        self.bind(self.kernel, 'GetCurrentThread', H, ())
        self.bind(self.advapi, 'OpenThreadToken', B, (H, D, B, c.POINTER(H)))
        self.bind(self.kernel, 'DeviceIoControl', B,
                  (H, D, P, D, P, D, c.POINTER(D), P))
        self.bind(self.kernel, 'LockFile', B, (H, D, D, D, D))
        self.bind(self.kernel, 'UnlockFile', B, (H, D, D, D, D))
        self.bind(self.kernel, 'ReadFile', B, (H, P, D, c.POINTER(D), P))
        self.handles = set()
        self.opened = self.closed = 0
        self.locked = None

    @staticmethod
    def bind(dll, name, result, args):
        function = getattr(dll, name)
        function.restype, function.argtypes = result, args

    def no_impersonation(self):
        token = ctypes.c_void_p()
        ctypes.set_last_error(0)
        found = self.advapi.OpenThreadToken(self.kernel.GetCurrentThread(),
                                           0x0008, 1, ctypes.byref(token))
        if found:
            require(bool(self.kernel.CloseHandle(token)), 'token_close_failed')
            raise CaseFailure('host_thread_impersonation')
        require(ctypes.get_last_error() == 1008, 'thread_token_unavailable')

    def open(self, path, *, directory=False, access=0x80, share=7):
        handle = self.kernel.CreateFileW(str(path), access, share, None, 3,
                                        0x00200000 | (0x02000000 if directory else 0), None)
        require(handle not in (None, INVALID_HANDLE), 'oracle_open_failed')
        require(handle not in self.handles, 'oracle_handle_reused_while_owned')
        self.handles.add(handle)
        self.opened += 1
        return handle

    def close(self, handle):
        require(handle in self.handles, 'oracle_close_not_owned')
        require(bool(self.kernel.CloseHandle(handle)), 'oracle_close_failed')
        self.handles.remove(handle)
        self.closed += 1

    def query(self, handle, kind, size):
        buffer = ctypes.create_string_buffer(size)
        require(bool(self.kernel.GetFileInformationByHandleEx(
            handle, kind, buffer, size)), 'oracle_query_failed')
        return buffer.raw

    def info(self, path, *, directory=False):
        handle = self.open(path, directory=directory)
        try:
            identity = self.query(handle, 18, 24)
            standard = self.query(handle, 1, 24)
            basic = self.query(handle, 0, 40)
            attributes = self.query(handle, 9, 8)
            return {
                'serial': int.from_bytes(identity[:8], 'little'),
                'file_id': identity[8:24],
                'size': struct.unpack_from('<q', standard, 8)[0],
                'delete_pending': standard[20], 'directory': standard[21],
                'last_write': struct.unpack_from('<q', basic, 16)[0],
                'change': struct.unpack_from('<q', basic, 24)[0],
                'attributes': struct.unpack_from('<I', attributes)[0],
                'tag': struct.unpack_from('<I', attributes, 4)[0],
                'type': int(self.kernel.GetFileType(handle)),
            }
        finally:
            self.close(handle)

    def junction(self, link, target):
        # Both paths were created from fixed names inside the exclusive fixture.
        link.mkdir()
        substitute = ('\\??\\' + str(target)).encode('utf-16-le')
        printable = str(target).encode('utf-16-le')
        names = substitute + b'\0\0' + printable + b'\0\0'
        payload = struct.pack('<IHHHHHH', MOUNT_POINT, 8 + len(names), 0,
                              0, len(substitute), len(substitute) + 2,
                              len(printable)) + names
        require(len(payload) < 16384, 'junction_buffer_bound')
        handle = self.open(link, directory=True, access=0x40000000)
        try:
            buffer = ctypes.create_string_buffer(payload)
            returned = ctypes.c_uint32()
            require(bool(self.kernel.DeviceIoControl(handle, 0x000900A4,
                buffer, len(payload), None, 0, ctypes.byref(returned), None)),
                'junction_creation_failed')
        finally:
            self.close(handle)
        info = self.info(link, directory=True)
        require(info['attributes'] & REPARSE and info['tag'] == MOUNT_POINT,
                'junction_precondition_missing')

    def lock(self, handle):
        require(self.locked is None and bool(self.kernel.LockFile(handle, 0, 0, 4, 0)),
                'byte_lock_setup_failed')
        self.locked = handle

    def unlock(self):
        if self.locked is not None:
            require(bool(self.kernel.UnlockFile(self.locked, 0, 0, 4, 0)),
                    'byte_lock_release_failed')
            self.locked = None

    def cleanup(self):
        errors = []
        try:
            self.unlock()
        except BaseException as error:
            errors.append(error)
        for handle in tuple(self.handles):
            try:
                self.close(handle)
            except BaseException as error:
                errors.append(error)
        require(not errors and not self.handles and self.opened == self.closed,
                'oracle_cleanup_failed')


class RecordedStream:
    def __init__(self, stream, owner, generation):
        self.stream, self.owner, self.generation = stream, owner, generation

    def __getattr__(self, name):
        return getattr(self.stream, name)

    def close(self):
        if self.generation in self.owner.streams:
            self.stream.close()
            require(self.stream.closed, 'crt_close_not_complete')
            del self.owner.streams[self.generation]
            self.owner.stream_closes += 1


class RecordingNative:
    """Transparent forwarding; only successful actual ownership events are counted."""
    def __init__(self, real):
        self.real = real
        self.active, self.streams = {}, {}
        self.generation = self.opens = self.closes = self.transfers = self.stream_closes = 0
        self.statuses = {}
        self.relative = self.supplementary = self.leaf_attempts = 0

    def __getattr__(self, name):
        return getattr(self.real, name)

    def open(self, request):
        result = self.real.open(request)
        require(result.completed, 'unexpected_native_pending')
        self.statuses[result.status] = self.statuses.get(result.status, 0) + 1
        self.relative += int(request.parent is not None)
        self.leaf_attempts += int(not request.directory_candidate)
        self.supplementary += int(any(ord(char) > 0xffff for char in request.name))
        if result.status == 0:
            require(result.io_status == 0 and result.information == 1,
                    'native_success_without_completion')
        if isinstance(result.handle, int) and result.handle > 0:
            require(result.handle not in self.active, 'native_handle_still_owned')
            self.generation += 1
            self.active[result.handle] = self.generation
            self.opens += 1
        return result

    def close(self, handle):
        require(handle in self.active, 'native_close_not_owned')
        self.real.close(handle)
        del self.active[handle]
        self.closes += 1

    def to_reader(self, handle):
        require(handle in self.active, 'native_transfer_not_owned')
        generation = self.active.pop(handle)
        # The real bridge consumes on failure too. Never guess ownership and
        # double-close a recycled handle if it raises; the scenario must fail.
        stream = self.real.to_reader(handle)
        wrapped = RecordedStream(stream, self, generation)
        self.streams[generation] = wrapped
        self.transfers += 1
        return wrapped

    def complete(self):
        require(not self.active and not self.streams and
                self.opens == self.closes + self.transfers and
                self.transfers == self.stream_closes, 'native_cleanup_incomplete')


class Fixture:
    def __init__(self, case, nonce, windows, neutral):
        self.case, self.nonce, self.w, self.n = case, nonce, windows, neutral
        self.oracle = Oracle()
        self.oracle.no_impersonation()
        require(self.oracle.kernel.GetDriveTypeW(case.anchor) == 3,
                'host_not_fixed_drive')
        self.root = case / 'root'
        self.root.mkdir()
        (self.root / 'middle').mkdir()
        self.leaf = self.root / 'middle' / 'leaf.BIN'
        self.leaf.write_bytes(PAYLOAD)
        (self.root / 'empty').write_bytes(b'')
        (self.root / 'unicode-\U0001f3b5.BIN').write_bytes(PAYLOAD)
        self.native = RecordingNative(windows.CtypesWindowsNative())
        self.backend = windows.WindowsBackend(self.native)
        self.leases = []
        self.readers = []
        self.junctions = set()
        self.checks = {}
        self.selector = self.backend._selector(case.drive)
        root_handle = self.oracle.open(self.root, directory=True)
        try:
            volume = self.native.volume_info(root_handle)
            require(volume.filesystem == 'NTFS' and
                    1 <= volume.maximum_component_units <= 32766, 'host_not_ntfs')
        finally:
            self.oracle.close(root_handle)

    def selection(self, root=None, parts=('middle', 'leaf.BIN')):
        return self.n.RootSelection('win32', str(self.root if root is None else root), parts)

    def acquire(self, *, root=None, parts=('middle', 'leaf.BIN'), expected=None,
                backend=None):
        lease = self.n.acquire(self.selection(root, parts), expected,
                               backend=self.backend if backend is None else backend)
        self.leases.append(lease)
        return lease

    def reader(self, lease):
        reader = lease.independent_reader()
        self.readers.append(reader)
        return reader

    def rejects(self, function, expected=None):
        try:
            value = function()
        except (self.w.WindowsUnavailable, self.n.RootedFileUnavailable) as error:
            if expected is not None:
                require(str(error) == expected, 'wrong_bounded_rejection')
            return
        else:
            if hasattr(value, 'close'):
                value.close()
            raise CaseFailure('expected_rejection_missing')

    def compare(self, lease, path):
        actual = self.oracle.info(path)
        root = self.oracle.info(self.root, directory=True)
        observation = lease.observation
        require(root['type'] == 1 and root['directory'] == 1 and
                root['delete_pending'] == 0 and root['tag'] == 0 and
                not root['attributes'] & REPARSE, 'root_not_ordinary')
        require(observation.root_identity.volume_serial == root['serial'] and
                observation.root_identity.file_id == root['file_id'], 'root_identity_mismatch')
        require(observation.leaf_identity.volume_serial == actual['serial'] and
                observation.leaf_identity.file_id == actual['file_id'] and
                observation.size == actual['size'] and
                observation.last_write_time == actual['last_write'] and
                observation.change_time == actual['change'], 'leaf_observation_mismatch')
        require(actual['type'] == 1 and actual['directory'] == 0 and
                actual['delete_pending'] == 0 and actual['tag'] == 0 and
                not actual['attributes'] & REPARSE, 'leaf_not_ordinary')

    def cleanup(self):
        errors = []
        for reader in reversed(self.readers):
            try:
                reader.close()
            except BaseException as error:
                errors.append(error)
        for lease in reversed(self.leases):
            try:
                lease.close()
            except BaseException as error:
                errors.append(error)
        for operation in (self.oracle.cleanup, self.native.complete):
            try:
                operation()
            except BaseException as error:
                errors.append(error)
        require(not errors, 'owned_resource_cleanup_failed')
        self.oracle.no_impersonation()
        require(self.backend._selector(self.case.drive) == self.selector,
                'host_mapping_changed')
        owner_marker(self.case / '.owner', self.nonce)
        owner_marker(self.case.parent.parent / '.owner', self.nonce)
        clean_owned_tree(self.case, self.junctions)


def clean_owned_tree(case, junctions):
    """Bounded, explicit, no-follow walk; unknown entries/reparse tags are retained."""
    allowed = {'root', 'root-old', 'middle', 'middle-old', 'leaf.BIN',
               'leaf-old.BIN', 'empty', 'unicode-\U0001f3b5.BIN', 'other', 'target', 'regular'}
    seen = 0

    def visit(directory, depth):
        nonlocal seen
        require(depth <= 6, 'cleanup_depth_bound')
        plain_chain(directory)
        with os.scandir(directory) as iterator:
            entries = [Path(entry.path) for entry in itertools.islice(iterator, 33)]
        require(len(entries) <= 32, 'cleanup_entry_bound')
        for entry in entries:
            if directory == case and entry.name == '.owner':
                continue
            seen += 1
            require(seen <= 64 and entry.name in allowed, 'cleanup_unknown_entry')
            plain_chain(entry.parent)
            value = entry.lstat()
            if value.st_file_attributes & REPARSE:
                require(entry in junctions and
                        getattr(value, 'st_reparse_tag', 0) == MOUNT_POINT and
                        value.st_file_attributes & 0x10, 'cleanup_unknown_reparse')
                os.rmdir(entry)  # Remove the junction entry itself; never recurse.
            elif stat.S_ISDIR(value.st_mode):
                visit(entry, depth + 1)
                plain_chain(entry)
                entry.rmdir()
            else:
                require(stat.S_ISREG(value.st_mode), 'cleanup_unknown_kind')
                entry.unlink()
        plain_chain(directory)

    visit(case, 0)
    require({entry.name for entry in case.iterdir()} == {'.owner'}, 'cleanup_incomplete')


def abi_selector(f):
    c, native = ctypes, f.native.real
    layouts = {
        'UNICODE_STRING': (16, {'Length': 0, 'MaximumLength': 2, 'Buffer': 8}),
        'OBJECT_ATTRIBUTES': (48, {'Length': 0, 'RootDirectory': 8, 'ObjectName': 16,
                                  'Attributes': 24, 'SecurityDescriptor': 32,
                                  'SecurityQualityOfService': 40}),
        'IO_STATUS_BLOCK': (16, {'value': 0, 'Information': 8}),
        'FILE_STANDARD_INFO': (24, {'AllocationSize': 0, 'EndOfFile': 8,
                                  'NumberOfLinks': 16, 'DeletePending': 20, 'Directory': 21}),
        'FILE_BASIC_INFO': (40, {'CreationTime': 0, 'LastAccessTime': 8,
                               'LastWriteTime': 16, 'ChangeTime': 24, 'FileAttributes': 32}),
        'FILE_ATTRIBUTE_TAG_INFO': (8, {'FileAttributes': 0, 'ReparseTag': 4}),
        'FILE_ID_INFO': (24, {'VolumeSerialNumber': 0, 'FileId': 8}),
    }
    for name, (size, fields) in layouts.items():
        structure = getattr(native, name)
        require(c.sizeof(structure) == size and all(
            getattr(structure, field).offset == offset for field, offset in fields.items()),
            'native_abi_layout')
    H, U, B, W = c.c_void_p, c.c_uint32, c.c_int32, c.c_wchar
    signatures = (
        (native.ntdll.NtCreateFile, c.c_int32, (c.POINTER(H), U,
            c.POINTER(native.OBJECT_ATTRIBUTES), c.POINTER(native.IO_STATUS_BLOCK),
            c.c_void_p, U, U, U, U, c.c_void_p, U)),
        (native.kernel.GetVolumeNameForVolumeMountPointW, B,
            (c.c_wchar_p, c.POINTER(W), U)),
        (native.kernel.QueryDosDeviceW, U, (c.c_wchar_p, c.POINTER(W), U)),
        (native.kernel.GetFileType, U, (H,)),
        (native.kernel.GetFileInformationByHandleEx, B, (H, c.c_int32, c.c_void_p, U)),
        (native.kernel.GetVolumeInformationByHandleW, B,
            (H, c.POINTER(W), U, c.POINTER(U), c.POINTER(U), c.POINTER(U),
             c.POINTER(W), U)),
        (native.kernel.CloseHandle, B, (H,)),
    )
    require(all(function.restype is result and tuple(function.argtypes) == arguments
                for function, result, arguments in signatures), 'native_abi_signatures')
    # One path MUST use a completely uninjected WindowsBackend constructor.
    plain = f.w.WindowsBackend()
    stamp = f.n.describe_root(f.selection(parts=()), backend=plain)
    lease = f.acquire(expected=stamp, backend=plain)
    require(f.reader(lease).read() == PAYLOAD, 'uninjected_read')
    unicode_lease = f.acquire(parts=('unicode-\U0001f3b5.BIN',))
    require(f.reader(unicode_lease).read() == PAYLOAD, 'unicode_read')
    require(f.native.relative > 0 and f.native.supplementary > 0 and
            f.native.statuses.get(0, 0) > 0, 'actual_relative_open_missing')
    selector = f.selector
    require(f.w.parse_multisz(native.query_dos_device(selector.drive))[0] ==
            f.w.parse_multisz(native.query_dos_device(f.w.guid_alias(selector.volume_guid)))[0]
            == selector.drive_target == selector.guid_target, 'selector_mismatch')
    f.checks['abi_and_selector'] = True


def ordinary_reads(f):
    stamp = f.n.describe_root(f.selection(parts=()), backend=f.backend)
    lease = f.acquire(expected=stamp)
    f.compare(lease, f.leaf)
    require(lease.check() == lease.observation and lease.original_name == 'leaf.BIN'
            and lease.original_suffix == '.BIN', 'ordinary_observation')
    first, second = f.reader(lease), f.reader(lease)
    require(first.tell() == second.tell() == 0 and first.read(3) == PAYLOAD[:3]
            and second.tell() == 0 and second.read() == PAYLOAD, 'independent_positions')
    import msvcrt
    for reader in (first, second):
        fd = reader.fileno()
        require(not os.get_inheritable(fd) and
                not os.get_handle_inheritable(msvcrt.get_osfhandle(fd)), 'reader_inheritable')
        try:
            os.write(fd, b'x')
        except OSError:
            pass
        else:
            raise CaseFailure('read_only_write_succeeded')
    require(f.leaf.read_bytes() == PAYLOAD, 'read_only_bytes_changed')
    empty = f.acquire(parts=('empty',))
    require(f.reader(empty).read() == b'' and empty.observation.size == 0, 'zero_byte_file')
    f.compare(empty, f.root / 'empty')
    f.checks['ordinary_reads'] = True


def missing_and_kinds(f):
    before = sum(f.native.statuses.values())
    for root, parts in ((f.case / 'absent', ('leaf.BIN',)),
                        (f.root, ('absent', 'leaf.BIN')), (f.root, ('middle', 'absent')),
                        (f.root, ('middle',)), (f.root, ('empty', 'leaf.BIN')),
                        (f.root / 'empty', ('leaf.BIN',))):
        f.rejects(lambda root=root, parts=parts: f.acquire(root=root, parts=parts))
    require(sum(f.native.statuses.values()) > before and
            any(status != 0 for status in f.native.statuses), 'real_failed_open_missing')
    f.checks['missing_and_kind_failures'] = True


def rename_case(f, kind):
    lease = f.acquire()
    old = {'root': f.root, 'intermediate': f.root / 'middle', 'leaf': f.leaf}[kind]
    renamed = old.with_name({'root': 'root-old', 'intermediate': 'middle-old',
                             'leaf': 'leaf-old.BIN'}[kind])
    old.rename(renamed)
    if kind == 'leaf':
        old.write_bytes(PAYLOAD)
    else:
        old.mkdir()
    f.rejects(lease.check)
    if kind == 'leaf':
        old.unlink()
    else:
        old.rmdir()
    renamed.rename(old)
    f.rejects(lease.check, 'source_failed')
    f.checks['rename_and_sticky_failure'] = True


def content_mutations(f):
    lease = f.acquire()
    f.leaf.write_bytes(PAYLOAD + b'changed-length')
    f.rejects(lease.check)
    f.leaf.write_bytes(PAYLOAD)
    f.rejects(lease.check, 'source_failed')
    lease.close()
    same = f.acquire()
    before = f.oracle.info(f.leaf)
    # Set a genuinely different last-write time on this generated file, without
    # assuming a sleep or filesystem timestamp granularity proves a mutation.
    f.leaf.write_bytes(b'Z' * len(PAYLOAD))
    info = f.leaf.stat()
    os.utime(f.leaf, ns=(info.st_atime_ns, info.st_mtime_ns + 2_000_000_000))
    after = f.oracle.info(f.leaf)
    require(after['size'] == before['size'] and
            (after['last_write'], after['change']) !=
            (before['last_write'], before['change']), 'same_size_precondition_missing')
    f.rejects(same.check)
    f.checks['observed_content_mutations'] = True


def wrong_expected_root(f):
    other = f.case / 'other'
    other.mkdir()
    stamp = f.n.describe_root(f.selection(other, ()), backend=f.backend)
    relative_before = f.native.relative
    leaf_attempts = f.native.leaf_attempts
    f.rejects(lambda: f.acquire(expected=stamp), 'windows_root_changed')
    # Root identity, not a fabricated stamp; the leaf is independently absent
    # here, so a root mismatch must precede any leaf-name open.
    f.leaf.unlink()
    f.rejects(lambda: f.acquire(expected=stamp), 'windows_root_changed')
    require(f.native.relative > relative_before and f.native.leaf_attempts == leaf_attempts,
            'wrong_root_leaf_checkpoint')
    f.checks['actual_wrong_root_rejected'] = True


def sharing_denial(f):
    blocker = f.oracle.open(f.leaf, access=0x80000000, share=0)
    try:
        f.rejects(lambda: f.acquire(), 'windows_native_open_failed')
        require(f.native.statuses.get(0xC0000043, 0) > 0, 'sharing_denial_not_observed')
    finally:
        f.oracle.close(blocker)
    require(f.reader(f.acquire()).read() == PAYLOAD, 'sharing_release_did_not_recover')
    f.checks['genuine_sharing_denial'] = True


def locked_read(f):
    blocker = f.oracle.open(f.leaf, access=0x80000000)
    f.oracle.lock(blocker)
    probe = f.oracle.open(f.leaf, access=0x80000000)
    try:
        buffer = ctypes.create_string_buffer(4)
        count = ctypes.c_uint32()
        ctypes.set_last_error(0)
        require(not f.oracle.kernel.ReadFile(probe, buffer, 4, ctypes.byref(count), None)
                and ctypes.get_last_error() == 33, 'lock_denial_precondition_missing')
        lease = f.acquire()
        reader = f.reader(lease)
        try:
            reader.read(4)
        except OSError as error:
            require(getattr(error, 'winerror', None) == 33 or error.errno == 13,
                    'wrong_crt_read_denial')
        else:
            raise CaseFailure('locked_read_succeeded')
    finally:
        f.oracle.close(probe)
        f.oracle.unlock()
        f.oracle.close(blocker)
    require(f.reader(f.acquire()).read() == PAYLOAD, 'lock_release_did_not_recover')
    f.checks['genuine_lock_denial'] = True


def junction_case(f, kind):
    target = f.case / 'target'
    target.mkdir()
    (target / 'leaf.BIN').write_bytes(PAYLOAD)
    if kind == 'root':
        link = f.case / 'other'
        root, parts = link, ('leaf.BIN',)
    elif kind == 'intermediate':
        link = f.root / 'other'
        root, parts = f.root, ('other', 'leaf.BIN')
    else:
        link = f.root / 'other'
        root, parts = f.root, ('other',)
    f.junctions.add(link)  # Known even if native fixture construction fails.
    f.oracle.junction(link, target)
    f.rejects(lambda: f.acquire(root=root, parts=parts),
              'windows_handle_unavailable' if kind != 'leaf' else None)
    f.checks['genuine_junction_rejected'] = True


def reader_lifecycle(f):
    lease = f.acquire()
    readers = [f.reader(lease) for _ in range(4)]
    opens = f.native.opens
    f.rejects(lease.independent_reader, 'reader_limit')
    require(f.native.opens == opens, 'fifth_reader_opened_native_resource')
    lease.close()
    require(not lease.drained.is_set(), 'drained_before_readers_close')
    f.rejects(lease.independent_reader, 'source_closed')
    f.rejects(lease.check, 'source_closed')
    for reader in readers[:-1]:
        require(reader.read(1) == PAYLOAD[:1], 'retained_reader_lost')
        reader.close()
        require(not lease.drained.is_set(), 'drained_before_final_reader')
    require(readers[-1].read() == PAYLOAD, 'last_reader_lost')
    readers[-1].close()
    require(lease.drained.is_set(), 'ordinary_drain_missing')
    f.native.complete()
    f.checks['ordinary_reader_ownership'] = True


def repeated_cleanup(f):
    for _ in range(8):
        lease = f.acquire()
        reader = f.reader(lease)
        require(reader.read() == PAYLOAD, 'repeat_read')
        reader.close()
        lease.close()
        f.native.complete()
        f.rejects(lambda: f.acquire(parts=('middle', 'absent')))
        f.native.complete()
    f.checks['bounded_repeated_cleanup'] = True


DISPATCH = {
    'abi_selector': abi_selector, 'ordinary_reads': ordinary_reads,
    'missing_and_kinds': missing_and_kinds,
    'rename_root': lambda f: rename_case(f, 'root'),
    'rename_intermediate': lambda f: rename_case(f, 'intermediate'),
    'rename_leaf': lambda f: rename_case(f, 'leaf'),
    'content_mutations': content_mutations, 'wrong_expected_root': wrong_expected_root,
    'sharing_denial': sharing_denial, 'locked_read': locked_read,
    'junction_root': lambda f: junction_case(f, 'root'),
    'junction_intermediate': lambda f: junction_case(f, 'intermediate'),
    'junction_leaf': lambda f: junction_case(f, 'leaf'),
    'reader_lifecycle': reader_lifecycle, 'repeated_cleanup': repeated_cleanup,
}


def main():
    result = {'version': 1, 'scenario': 'invalid', 'ok': False, 'cleanup': False,
              'checks': {}, 'counts': {}, 'host': {}, 'error': 'worker_not_admitted'}
    fixture = None
    try:
        require(len(sys.argv) == 4 and sys.argv[1] in SCENARIOS, 'scenario_not_admitted')
        scenario, case_text, nonce = sys.argv[1:]
        result['scenario'] = scenario
        require(sys.platform == 'win32' and sys.implementation.name == 'cpython' and
                sys.version_info[:2] == (3, 11) and ctypes.sizeof(ctypes.c_void_p) == 8 and
                ctypes.sizeof(ctypes.c_wchar) == 2, 'host_not_admitted')
        run = Path(os.environ['ALBUMHAVEN_W0_ROOT'])
        case = Path(case_text)
        require(re.fullmatch(r'[a-f0-9]{32}', nonce) is not None and
                case == run / 'scenarios' / scenario and
                run.name == 'albumhaven-w0-' + os.environ['GITHUB_RUN_ID'] + '-' +
                os.environ['GITHUB_RUN_ATTEMPT'], 'fixture_not_admitted')
        require(run.parent == Path(os.environ['RUNNER_TEMP']), 'fixture_parent')
        plain_chain(case)
        owner_marker(run / '.owner', nonce)
        owner_marker(case / '.owner', nonce)
        require({entry.name for entry in case.iterdir()} == {'.owner'}, 'fixture_ownership')
        windows, neutral = bootstrap()
        fixture = Fixture(case, nonce, windows, neutral)
        version = sys.getwindowsversion()
        result['host'] = {'platform': 'win32', 'python': list(sys.version_info[:3]),
                          'pointer_bytes': 8, 'wchar_bytes': 2,
                          'windows_build': version.build, 'ntfs': True,
                          'no_thread_token_observed': True}
        DISPATCH[scenario](fixture)
        result['checks'] = fixture.checks
        result['ok'] = True
        result['error'] = ''
    except BaseException as error:
        result['error'] = (str(error) if type(error) is CaseFailure else type(error).__name__)
        if not re.fullmatch(r'[A-Za-z0-9_]{1,80}', result['error']):
            result['error'] = 'bounded_worker_failure'
    finally:
        if fixture is not None:
            try:
                fixture.cleanup()
                result['cleanup'] = True
            except BaseException:
                result['ok'] = False
                result['error'] = 'owned_cleanup_failed'
            result['counts'] = {
                'native_opens': fixture.native.opens, 'native_closes': fixture.native.closes,
                'crt_transfers': fixture.native.transfers,
                'crt_closes': fixture.native.stream_closes,
                'oracle_opens': fixture.oracle.opened, 'oracle_closes': fixture.oracle.closed,
            }
    encoded = json.dumps(result, sort_keys=True, separators=(',', ':')).encode('ascii')
    if len(encoded) > MAX_RESULT:
        encoded = b'{"version":1,"ok":false,"error":"result_bound"}'
    sys.stdout.buffer.write(encoded + b'\n')
    sys.stdout.buffer.flush()
    return 0 if result['ok'] and result['cleanup'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
