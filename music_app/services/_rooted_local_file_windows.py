"""Dormant, fail-closed candidate for local-NTFS rooted file acquisition.

Nothing here loads a Windows DLL at module import. This source has not passed a
native ABI/Windows acceptance gate and must not be wired into a product route.
Only observed reachability and mutation are checked: between-check ancestry,
metadata or device-map ABA, hostile writers, and exclusive-root provenance are
not established. UNC, SUBST, mapped drives, reparse points and non-NTFS volumes
are deliberately unavailable. The kernel/device namespace remains trusted.
All calls require a fixed process security/device-map context without thread
impersonation; enforcing that hosting condition is a separate activation gate.

WindowsBackend is injected behind the neutral lease owner. Its private resource
is single-owner: the neutral owner serializes native operations, reserves every
in-flight operation and reader, and defers physical close until those uses drain.
A raw reader must be wrapped by the neutral owner's reader-local operation guard.
Do not use this private resource as a thread-safe public lease.
"""
from dataclasses import dataclass
import os
import re
import sys


class WindowsUnavailable(RuntimeError):
    """A bounded diagnostic code; native paths/details are not public errors."""


class WindowsNativePending(WindowsUnavailable):
    """Synthetic pending-call signal; real pending calls park their owner."""


FILE_READ_DATA = 0x00000001
FILE_TRAVERSE = 0x00000020
FILE_READ_ATTRIBUTES = 0x00000080
SYNCHRONIZE = 0x00100000
FILE_OPEN = 1
FILE_OPENED = 1
FILE_SHARE_ALL = 7
FILE_NON_DIRECTORY_FILE = 0x00000040
FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020
FILE_OPEN_REPARSE_POINT = 0x00200000
FILE_ATTRIBUTE_DIRECTORY = 0x00000010
FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
FILE_TYPE_DISK = 1
STATUS_SUCCESS = 0
STATUS_PENDING = 0x00000103
MAX_COMPONENTS = 256
MAX_MULTISZ_UNITS = 32768
DIRECTORY_ACCESS = FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE
LEAF_ACCESS = FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE
DIRECTORY_OPTIONS = FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT
LEAF_OPTIONS = DIRECTORY_OPTIONS | FILE_NON_DIRECTORY_FILE

_VOLUME_TARGET = re.compile(r"\\Device\\HarddiskVolume[0-9]+\Z")
_VOLUME_GUID = re.compile(
    r"\\\\\?\\Volume\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-"
    r"[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}\\\Z"
)
_DRIVE_ROOT = re.compile(r"([A-Za-z]):\\(.*)\Z", re.DOTALL)
_RESERVED = frozenset(
    ("CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$")
    + tuple("COM" + digit for digit in "123456789¹²³")
    + tuple("LPT" + digit for digit in "123456789¹²³")
)


@dataclass(frozen=True)
class WindowsIdentity:
    platform: str
    volume_serial: int
    file_id: bytes


@dataclass(frozen=True)
class SelectorSnapshot:
    drive: str
    volume_guid: str
    drive_target: str
    guid_target: str


@dataclass(frozen=True)
class WindowsRootStamp:
    platform: str
    identity: WindowsIdentity
    selector: SelectorSnapshot


@dataclass(frozen=True)
class WindowsObservation:
    platform: str
    root_identity: WindowsIdentity
    leaf_identity: WindowsIdentity
    size: int
    last_write_time: int
    change_time: int
    original_name: str
    original_suffix: str


@dataclass(frozen=True)
class HandleInfo:
    """Every field is required, from independent non-atomic handle queries."""
    file_type: int
    identity: WindowsIdentity
    directory: bool
    delete_pending: bool
    size: int
    last_write_time: int
    change_time: int
    attributes: int
    reparse_tag: int


@dataclass(frozen=True)
class VolumeInfo:
    filesystem: str
    maximum_component_units: int


@dataclass(frozen=True)
class MultiString:
    """Exact initialized output, including both terminating NULs and count."""
    text: str
    count: int
    capacity: int


@dataclass(frozen=True)
class OpenRequest:
    name: str
    parent: object
    directory_candidate: bool

    @property
    def access(self):
        return DIRECTORY_ACCESS if self.directory_candidate else LEAF_ACCESS

    @property
    def options(self):
        return DIRECTORY_OPTIONS if self.directory_candidate else LEAF_OPTIONS


@dataclass(frozen=True)
class NativeOpenResult:
    handle: object
    status: int
    io_status: int
    information: int
    completed: bool
    storage: object = None


@dataclass(frozen=True)
class _Link:
    parent: object
    name: str
    child: object
    identity: WindowsIdentity


def utf16_units(value):
    if not isinstance(value, str) or "\0" in value:
        raise WindowsUnavailable("windows_invalid_name")
    try:
        encoded = value.encode("utf-16-le", "strict")
    except UnicodeError as error:
        raise WindowsUnavailable("windows_invalid_utf16") from error
    # UNICODE_STRING Length and MaximumLength are USHORT byte counts. Keep
    # room for the terminator without permitting MaximumLength overflow.
    if len(encoded) + 2 > 0xFFFF:
        raise WindowsUnavailable("windows_name_too_long")
    return len(encoded) // 2


def validate_component(value, maximum_units=None):
    units = utf16_units(value)
    if (not value or value in (".", "..") or value[-1] in " ."
            or any(ord(char) < 32 or char in '<>:"/\\|?*' for char in value)):
        raise WindowsUnavailable("windows_invalid_component")
    basename = value.split(".", 1)[0].rstrip(" .").upper()
    if basename in _RESERVED:
        raise WindowsUnavailable("windows_reserved_component")
    if maximum_units is not None and units > maximum_units:
        raise WindowsUnavailable("windows_component_too_long")
    return value


def parse_selection(selection, *, require_leaf=True):
    """Pure Windows parsing: no pathlib, cwd, resolve, casefold or expansion."""
    if getattr(selection, "platform", None) != "win32":
        raise WindowsUnavailable("windows_platform_mismatch")
    root_path = getattr(selection, "root_path", None)
    if not isinstance(root_path, str):
        raise WindowsUnavailable("windows_invalid_root")
    utf16_units(root_path)
    match = _DRIVE_ROOT.fullmatch(root_path)
    if match is None:
        raise WindowsUnavailable("windows_root_unavailable")
    drive = match.group(1) + ":"
    rest = match.group(2)
    root_parts = tuple(rest.split("\\")) if rest else ()
    relative_parts = getattr(selection, "relative_parts", None)
    if not isinstance(relative_parts, tuple) or (require_leaf and not relative_parts):
        raise WindowsUnavailable("windows_invalid_relative_parts")
    if len(root_parts) + len(relative_parts) > MAX_COMPONENTS:
        raise WindowsUnavailable("windows_too_many_components")
    for part in root_parts + relative_parts:
        validate_component(part)
    return drive, root_parts, relative_parts


def parse_multisz(value):
    if (not isinstance(value, MultiString) or type(value.count) is not int
            or type(value.capacity) is not int or not isinstance(value.text, str)
            or value.count < 2 or value.capacity > MAX_MULTISZ_UNITS
            or value.capacity < 3 or value.count >= value.capacity
            or not value.text.endswith("\0\0")):
        raise WindowsUnavailable("windows_device_mapping_incomplete")
    try:
        units = len(value.text.encode("utf-16-le", "strict")) // 2
    except UnicodeError as error:
        raise WindowsUnavailable("windows_device_mapping_incomplete") from error
    if units != value.count:
        raise WindowsUnavailable("windows_device_mapping_incomplete")
    values = value.text[:-2].split("\0")
    if not values or any(not item for item in values):
        raise WindowsUnavailable("windows_device_mapping_incomplete")
    for item in values:
        utf16_units(item)
    return tuple(values)


def guid_alias(value):
    if not isinstance(value, str) or _VOLUME_GUID.fullmatch(value) is None:
        raise WindowsUnavailable("windows_volume_guid_unavailable")
    utf16_units(value)
    # QueryDosDevice accepts Volume{GUID}; never the full \\?\ spelling.
    return value[4:-1]


def _identity(value):
    if (not isinstance(value, WindowsIdentity) or value.platform != "win32"
            or type(value.volume_serial) is not int
            or not 0 <= value.volume_serial < 2 ** 64
            or not isinstance(value.file_id, bytes) or len(value.file_id) != 16):
        raise WindowsUnavailable("windows_identity_incomplete")
    return value


def _valid_info(value, *, directory):
    if (not isinstance(value, HandleInfo) or type(value.file_type) is not int
            or value.file_type != FILE_TYPE_DISK
            or type(value.directory) is not bool or type(value.delete_pending) is not bool
            or value.directory != directory or value.delete_pending
            or type(value.size) is not int or value.size < 0 or value.size >= 2 ** 63
            or type(value.last_write_time) is not int
            or not -(2 ** 63) <= value.last_write_time < 2 ** 63
            or type(value.change_time) is not int
            or not -(2 ** 63) <= value.change_time < 2 ** 63
            or type(value.attributes) is not int or not 0 <= value.attributes < 2 ** 32
            or type(value.reparse_tag) is not int or not 0 <= value.reparse_tag < 2 ** 32
            or bool(value.attributes & FILE_ATTRIBUTE_DIRECTORY) != directory
            or value.attributes & FILE_ATTRIBUTE_REPARSE_POINT or value.reparse_tag):
        raise WindowsUnavailable("windows_handle_unavailable")
    _identity(value.identity)
    return value


def _file_state(value):
    return value.identity, value.size, value.last_write_time, value.change_time


def _suffix(name):
    # Match an ordinary final suffix while preserving the originally selected
    # spelling. The playback caller can separately choose its normalized suffix.
    index = name.rfind(".")
    return name[index:] if index > 0 else ""


class WindowsBackend:
    """Private backend; no native loading until a real operation needs it.

    Injected native contract: volume_guid(drive_root), query_dos_device(alias),
    open(OpenRequest), info(handle), volume_info(handle), close(handle), and
    to_reader(handle). to_reader CONSUMES handle even if conversion raises.
    quarantine(result) must retain argument storage and all current owner stack
    frames until completion can be resolved; production parks without returning.
    """
    platform = "win32"

    def __init__(self, native=None):
        self._native = native

    @property
    def native(self):
        if self._native is None:
            self._native = CtypesWindowsNative()
        return self._native

    @property
    def quarantined(self):
        return self._native is not None and bool(self._native.quarantined)

    def _usable(self):
        if self.quarantined:
            raise WindowsUnavailable("windows_backend_quarantined")

    def _selector(self, drive):
        self._usable()
        guid = self.native.volume_guid(drive + "\\")
        alias = guid_alias(guid)
        current_drive = parse_multisz(self.native.query_dos_device(drive))[0]
        current_guid = parse_multisz(self.native.query_dos_device(alias))[0]
        if (current_drive != current_guid
                or _VOLUME_TARGET.fullmatch(current_drive) is None):
            raise WindowsUnavailable("windows_volume_mapping_unavailable")
        return SelectorSnapshot(drive, guid, current_drive, current_guid)

    def _open(self, parent, name, *, directory):
        self._usable()
        request = OpenRequest(name, parent, directory)
        result = self.native.open(request)
        if not isinstance(result, NativeOpenResult):
            raise WindowsUnavailable("windows_native_result_incomplete")
        if (type(result.completed) is not bool or type(result.status) is not int
                or not 0 <= result.status < 2 ** 32 or type(result.io_status) is not int
                or not 0 <= result.io_status < 2 ** 32
                or type(result.information) is not int or result.information < 0):
            self.native.quarantine(result)
            raise WindowsNativePending("windows_native_pending")
        if (not result.completed or result.status == STATUS_PENDING
                or result.io_status == STATUS_PENDING):
            # The native implementation must not free buffers or parent handles.
            # Real bindings park the running owner; fakes may raise the special
            # exception to inspect retained ownership without running native I/O.
            self.native.quarantine(result)
            raise WindowsNativePending("windows_native_pending")
        if (result.status != STATUS_SUCCESS or result.io_status != STATUS_SUCCESS
                or result.information != FILE_OPENED
                or type(result.handle) is not int or result.handle <= 0):
            if type(result.handle) is int and result.handle > 0:
                self.native.close(result.handle)
            raise WindowsUnavailable("windows_native_open_failed")
        return result.handle

    def _info(self, handle, *, directory, volume=None):
        value = _valid_info(self.native.info(handle), directory=directory)
        if volume is not None and value.identity.volume_serial != volume:
            raise WindowsUnavailable("windows_volume_crossing")
        return value

    def _volume(self, handle):
        value = self.native.volume_info(handle)
        if (not isinstance(value, VolumeInfo) or value.filesystem != "NTFS"
                or type(value.maximum_component_units) is not int
                or not 1 <= value.maximum_component_units <= 32766):
            raise WindowsUnavailable("windows_filesystem_unavailable")
        return value

    def _bootstrap(self, drive, handles):
        selector = self._selector(drive)
        root = self._open(None, selector.drive_target + "\\", directory=True)
        handles.append(root)
        info = self._info(root, directory=True)
        volume = self._volume(root)
        if self._selector(drive) != selector:
            raise WindowsUnavailable("windows_bootstrap_changed")
        fresh = self._open(None, selector.drive_target + "\\", directory=True)
        try:
            if (self._info(fresh, directory=True).identity != info.identity
                    or self._volume(fresh) != volume):
                raise WindowsUnavailable("windows_bootstrap_changed")
        finally:
            self.native.close(fresh)
        return root, info.identity, volume, selector

    def _acquire(self, selection, expected_root_stamp, *, directory_only):
        drive, root_parts, relative_parts = parse_selection(
            selection, require_leaf=not directory_only)
        handles = []
        links = []
        resource = None
        try:
            bootstrap, boot_identity, volume, selector = self._bootstrap(drive, handles)
            for part in root_parts + relative_parts:
                validate_component(part, volume.maximum_component_units)
            current = bootstrap
            for name in root_parts:
                child = self._open(current, name, directory=True)
                handles.append(child)
                info = self._info(child, directory=True, volume=boot_identity.volume_serial)
                links.append(_Link(current, name, child, info.identity))
                current = child
            root_identity = self._info(current, directory=True).identity
            stamp = WindowsRootStamp("win32", root_identity, selector)
            if expected_root_stamp is not None and expected_root_stamp != stamp:
                raise WindowsUnavailable("windows_root_changed")
            if not directory_only:
                for name in relative_parts[:-1]:
                    child = self._open(current, name, directory=True)
                    handles.append(child)
                    info = self._info(child, directory=True, volume=boot_identity.volume_serial)
                    links.append(_Link(current, name, child, info.identity))
                    current = child
                name = relative_parts[-1]
                anchor = self._open(current, name, directory=False)
                handles.append(anchor)
                info = self._info(anchor, directory=False, volume=boot_identity.volume_serial)
                observation = WindowsObservation("win32", root_identity, info.identity,
                    info.size, info.last_write_time, info.change_time, name, _suffix(name))
            else:
                anchor, name, observation = None, None, None
            resource = WindowsResource(self, tuple(handles), tuple(links), bootstrap,
                boot_identity, volume, stamp, current, anchor, name, observation)
            resource.check()
            return resource
        except BaseException:
            if resource is not None:
                resource.close()
            elif not self.quarantined:
                for handle in reversed(handles):
                    try:
                        self.native.close(handle)
                    except BaseException:
                        # Attempt every close; preserve the admission failure.
                        pass
            raise

    def acquire(self, selection, expected_root_stamp=None):
        return self._acquire(selection, expected_root_stamp, directory_only=False)

    def describe_root(self, selection):
        resource = self._acquire(selection, None, directory_only=True)
        try:
            return resource.root_stamp
        finally:
            resource.close()


class WindowsResource:
    """Single-owner strategy object, wrapped exclusively by the neutral owner."""
    platform = "win32"

    def __init__(self, backend, handles, links, bootstrap, bootstrap_identity,
            volume, root_stamp, parent, anchor, leaf_name, observation):
        self.backend = backend
        self._handles = handles
        self._links = links
        self._bootstrap = bootstrap
        self._bootstrap_identity = bootstrap_identity
        self._volume = volume
        self.root_stamp = root_stamp
        self._parent = parent
        self._anchor = anchor
        self._leaf_name = leaf_name
        self.observation = observation
        self._closed = False
        self._failed = False

    def _usable(self):
        if self._closed:
            raise WindowsUnavailable("windows_resource_closed")
        if self._failed:
            raise WindowsUnavailable("windows_resource_failed")
        self.backend._usable()

    def _expected_file_state(self):
        obs = self.observation
        return obs.leaf_identity, obs.size, obs.last_write_time, obs.change_time

    def check(self):
        self._usable()
        backend = self.backend
        selector = self.root_stamp.selector
        volume_serial = self._bootstrap_identity.volume_serial
        try:
            if backend._selector(selector.drive) != selector:
                raise WindowsUnavailable("windows_bootstrap_changed")
            fresh = backend._open(None, selector.drive_target + "\\", directory=True)
            try:
                if (backend._info(fresh, directory=True).identity != self._bootstrap_identity
                        or backend._volume(fresh) != self._volume):
                    raise WindowsUnavailable("windows_bootstrap_changed")
            finally:
                backend.native.close(fresh)
            if backend._info(self._bootstrap, directory=True).identity != self._bootstrap_identity:
                raise WindowsUnavailable("windows_bootstrap_changed")
            for link in self._links:
                if backend._info(link.child, directory=True, volume=volume_serial).identity != link.identity:
                    raise WindowsUnavailable("windows_directory_changed")
                check_handle = backend._open(link.parent, link.name, directory=True)
                try:
                    if backend._info(check_handle, directory=True, volume=volume_serial).identity != link.identity:
                        raise WindowsUnavailable("windows_directory_changed")
                finally:
                    backend.native.close(check_handle)
            if self._anchor is not None:
                expected = self._expected_file_state()
                if _file_state(backend._info(self._anchor, directory=False, volume=volume_serial)) != expected:
                    raise WindowsUnavailable("windows_source_changed")
                check_handle = backend._open(self._parent, self._leaf_name, directory=False)
                try:
                    if _file_state(backend._info(check_handle, directory=False, volume=volume_serial)) != expected:
                        raise WindowsUnavailable("windows_source_changed")
                finally:
                    backend.native.close(check_handle)
            if backend._selector(selector.drive) != selector:
                raise WindowsUnavailable("windows_bootstrap_changed")
        except BaseException:
            self._failed = True
            raise
        return self.observation

    def reader(self):
        self._usable()
        if self._anchor is None:
            raise WindowsUnavailable("windows_source_required")
        handle = None
        stream = None
        try:
            self.check()
            handle = self.backend._open(self._parent, self._leaf_name, directory=False)
            info = self.backend._info(handle, directory=False,
                volume=self._bootstrap_identity.volume_serial)
            if _file_state(info) != self._expected_file_state():
                raise WindowsUnavailable("windows_source_changed")
            self.check()
            # The bridge consumes this handle on BOTH success and failure.
            transferred, handle = handle, None
            stream = self.backend.native.to_reader(transferred)
            if stream.tell() != 0 or stream.writable():
                raise WindowsUnavailable("windows_reader_invalid")
            return stream
        except BaseException:
            self._failed = True
            if stream is not None:
                stream.close()
            if handle is not None and not self.backend.quarantined:
                self.backend.native.close(handle)
            raise

    def close(self):
        if self._closed:
            return
        self._closed = True
        if self.backend.quarantined:
            # Real pending calls still own this frame/chain through the parked
            # operation. Never close a handle the kernel might still reference.
            return
        handles, self._handles = self._handles, ()
        first_error = None
        for handle in reversed(handles):
            try:
                self.backend.native.close(handle)
            except BaseException as error:
                if first_error is None:
                    first_error = error
        if first_error is not None:
            raise first_error


class CtypesWindowsNative:
    """Lazy fixed-width ABI candidate. Actual Windows acceptance remains open."""

    def __init__(self):
        if sys.platform != "win32":
            raise WindowsUnavailable("windows_platform_unavailable")
        import ctypes
        import threading
        self.ctypes = ctypes
        self._threading = threading
        self.quarantined = False
        self._pending = None
        if ctypes.sizeof(ctypes.c_wchar) != 2:
            raise WindowsUnavailable("windows_wchar_abi_unavailable")
        ULONG = ctypes.c_uint32
        USHORT = ctypes.c_uint16
        NTSTATUS = ctypes.c_int32
        HANDLE = ctypes.c_void_p
        ULONG_PTR = ctypes.c_size_t
        WCHAR = ctypes.c_wchar
        BOOLEAN = ctypes.c_ubyte
        LARGE_INTEGER = ctypes.c_int64

        class UNICODE_STRING(ctypes.Structure):
            _fields_ = (("Length", USHORT), ("MaximumLength", USHORT),
                ("Buffer", ctypes.POINTER(WCHAR)))

        class OBJECT_ATTRIBUTES(ctypes.Structure):
            _fields_ = (("Length", ULONG), ("RootDirectory", HANDLE),
                ("ObjectName", ctypes.POINTER(UNICODE_STRING)), ("Attributes", ULONG),
                ("SecurityDescriptor", ctypes.c_void_p),
                ("SecurityQualityOfService", ctypes.c_void_p))

        class IO_STATUS_UNION(ctypes.Union):
            _fields_ = (("Status", NTSTATUS), ("Pointer", ctypes.c_void_p))

        class IO_STATUS_BLOCK(ctypes.Structure):
            _anonymous_ = ("value",)
            _fields_ = (("value", IO_STATUS_UNION), ("Information", ULONG_PTR))

        class FILE_STANDARD_INFO(ctypes.Structure):
            _fields_ = (("AllocationSize", LARGE_INTEGER), ("EndOfFile", LARGE_INTEGER),
                ("NumberOfLinks", ULONG), ("DeletePending", BOOLEAN), ("Directory", BOOLEAN))

        class FILE_BASIC_INFO(ctypes.Structure):
            _fields_ = (("CreationTime", LARGE_INTEGER), ("LastAccessTime", LARGE_INTEGER),
                ("LastWriteTime", LARGE_INTEGER), ("ChangeTime", LARGE_INTEGER),
                ("FileAttributes", ULONG))

        class FILE_ATTRIBUTE_TAG_INFO(ctypes.Structure):
            _fields_ = (("FileAttributes", ULONG), ("ReparseTag", ULONG))

        class FILE_ID_128(ctypes.Structure):
            _fields_ = (("Identifier", ctypes.c_ubyte * 16),)

        class FILE_ID_INFO(ctypes.Structure):
            _fields_ = (("VolumeSerialNumber", ctypes.c_uint64), ("FileId", FILE_ID_128))

        self.UNICODE_STRING = UNICODE_STRING
        self.OBJECT_ATTRIBUTES = OBJECT_ATTRIBUTES
        self.IO_STATUS_BLOCK = IO_STATUS_BLOCK
        self.FILE_STANDARD_INFO = FILE_STANDARD_INFO
        self.FILE_BASIC_INFO = FILE_BASIC_INFO
        self.FILE_ATTRIBUTE_TAG_INFO = FILE_ATTRIBUTE_TAG_INFO
        self.FILE_ID_INFO = FILE_ID_INFO
        self._ULONG = ULONG
        self._HANDLE = HANDLE
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.ntdll = ctypes.WinDLL("ntdll", use_last_error=True)
        self.ntdll.NtCreateFile.argtypes = (ctypes.POINTER(HANDLE), ULONG,
            ctypes.POINTER(OBJECT_ATTRIBUTES), ctypes.POINTER(IO_STATUS_BLOCK),
            ctypes.c_void_p, ULONG, ULONG, ULONG, ULONG, ctypes.c_void_p, ULONG)
        self.ntdll.NtCreateFile.restype = NTSTATUS
        self.kernel.GetVolumeNameForVolumeMountPointW.argtypes = (
            ctypes.c_wchar_p, ctypes.POINTER(WCHAR), ULONG)
        self.kernel.GetVolumeNameForVolumeMountPointW.restype = ctypes.c_int32
        self.kernel.QueryDosDeviceW.argtypes = (ctypes.c_wchar_p, ctypes.POINTER(WCHAR), ULONG)
        self.kernel.QueryDosDeviceW.restype = ULONG
        self.kernel.GetFileType.argtypes = (HANDLE,)
        self.kernel.GetFileType.restype = ULONG
        self.kernel.GetFileInformationByHandleEx.argtypes = (HANDLE, ctypes.c_int32,
            ctypes.c_void_p, ULONG)
        self.kernel.GetFileInformationByHandleEx.restype = ctypes.c_int32
        self.kernel.GetVolumeInformationByHandleW.argtypes = (HANDLE,
            ctypes.POINTER(WCHAR), ULONG, ctypes.POINTER(ULONG), ctypes.POINTER(ULONG),
            ctypes.POINTER(ULONG), ctypes.POINTER(WCHAR), ULONG)
        self.kernel.GetVolumeInformationByHandleW.restype = ctypes.c_int32
        self.kernel.CloseHandle.argtypes = (HANDLE,)
        self.kernel.CloseHandle.restype = ctypes.c_int32

    def _available(self):
        if self.quarantined:
            raise WindowsUnavailable("windows_backend_quarantined")

    def volume_guid(self, drive_root):
        self._available()
        if re.fullmatch(r"[A-Za-z]:\\", drive_root) is None:
            raise WindowsUnavailable("windows_invalid_drive_lookup")
        buffer = self.ctypes.create_unicode_buffer(64)
        if not self.kernel.GetVolumeNameForVolumeMountPointW(drive_root, buffer, 64):
            raise WindowsUnavailable("windows_volume_guid_unavailable")
        value = buffer.value
        guid_alias(value)
        return value

    def query_dos_device(self, alias):
        self._available()
        # Bounded single query; truncation/error is unavailable, never a fallback.
        capacity = MAX_MULTISZ_UNITS
        buffer = self.ctypes.create_unicode_buffer(capacity)
        count = int(self.kernel.QueryDosDeviceW(alias, buffer, capacity))
        if not 2 <= count < capacity:
            raise WindowsUnavailable("windows_device_mapping_unavailable")
        return MultiString(buffer[:count], count, capacity)

    def open(self, request):
        self._available()
        if not isinstance(request, OpenRequest):
            raise WindowsUnavailable("windows_invalid_open_request")
        if request.parent is None:
            if (not request.directory_candidate or not request.name.endswith("\\")
                    or _VOLUME_TARGET.fullmatch(request.name[:-1]) is None):
                raise WindowsUnavailable("windows_invalid_bootstrap")
        else:
            validate_component(request.name)
        ctypes = self.ctypes
        units = utf16_units(request.name)
        buffer = ctypes.create_unicode_buffer(request.name, units + 1)
        name = self.UNICODE_STRING(units * 2, (units + 1) * 2,
            ctypes.cast(buffer, ctypes.POINTER(ctypes.c_wchar)))
        attrs = self.OBJECT_ATTRIBUTES(ctypes.sizeof(self.OBJECT_ATTRIBUTES),
            request.parent, ctypes.pointer(name), 0, None, None)
        iosb = self.IO_STATUS_BLOCK()
        # Sentinel distinguishes a successful return without completed IOSB.
        sentinel = 0x7FFFFFFF
        iosb.Status = sentinel
        iosb.Information = 0
        handle = self._HANDLE()
        status = int(self.ntdll.NtCreateFile(ctypes.byref(handle), request.access,
            ctypes.byref(attrs), ctypes.byref(iosb), None, 0, FILE_SHARE_ALL,
            FILE_OPEN, request.options, None, 0)) & 0xFFFFFFFF
        io_status = int(iosb.Status) & 0xFFFFFFFF
        storage = (request, buffer, name, attrs, iosb, handle)
        incomplete = (status == STATUS_PENDING or io_status == STATUS_PENDING
            or status == STATUS_SUCCESS and io_status == sentinel)
        handle_value = -1 if handle.value == self._HANDLE(-1).value else handle.value
        result = NativeOpenResult(handle_value, status, io_status,
            int(iosb.Information), not incomplete, storage)
        if incomplete:
            self.quarantine(result)
        return result

    def quarantine(self, result):
        self.quarantined = True
        self._pending = result
        # No guessed cancellation/completion and no stack-buffer release. The
        # acquisition/check worker, parent handles, argument storage and slot
        # remain owned. The neutral caller deadline does not interrupt this.
        # Resolution needs a separately accepted native completion strategy.
        parked = self._threading.Event()
        while True:
            try:
                parked.wait()
            except BaseException:
                # An asynchronous Python exception is not native completion.
                continue

    def _query(self, handle, information_class, structure):
        value = structure()
        if not self.kernel.GetFileInformationByHandleEx(handle, information_class,
                self.ctypes.byref(value), self.ctypes.sizeof(value)):
            raise WindowsUnavailable("windows_handle_query_failed")
        return value

    def info(self, handle):
        self._available()
        kind = int(self.kernel.GetFileType(handle))
        if kind != FILE_TYPE_DISK:
            raise WindowsUnavailable("windows_not_disk")
        standard = self._query(handle, 1, self.FILE_STANDARD_INFO)
        attributes = self._query(handle, 9, self.FILE_ATTRIBUTE_TAG_INFO)
        basic = self._query(handle, 0, self.FILE_BASIC_INFO)
        identity = self._query(handle, 18, self.FILE_ID_INFO)
        if (standard.Directory not in (0, 1) or standard.DeletePending not in (0, 1)
                or basic.FileAttributes != attributes.FileAttributes
                or standard.AllocationSize < 0 or standard.EndOfFile < 0):
            raise WindowsUnavailable("windows_handle_query_inconsistent")
        return HandleInfo(kind, WindowsIdentity("win32", int(identity.VolumeSerialNumber),
            bytes(identity.FileId.Identifier)), bool(standard.Directory),
            bool(standard.DeletePending), int(standard.EndOfFile),
            int(basic.LastWriteTime), int(basic.ChangeTime),
            int(attributes.FileAttributes), int(attributes.ReparseTag))

    def volume_info(self, handle):
        self._available()
        ctypes = self.ctypes
        serial = self._ULONG()
        maximum = self._ULONG()
        flags = self._ULONG()
        filesystem = ctypes.create_unicode_buffer(64)
        if not self.kernel.GetVolumeInformationByHandleW(handle, None, 0,
                ctypes.byref(serial), ctypes.byref(maximum), ctypes.byref(flags),
                filesystem, 64):
            raise WindowsUnavailable("windows_volume_query_failed")
        # The DWORD serial here is deliberately ignored. Identity uses all 64
        # bits from FILE_ID_INFO plus the complete 128-bit FileId.
        return VolumeInfo(filesystem.value, int(maximum.value))

    def close(self, handle):
        if not self.kernel.CloseHandle(handle):
            raise WindowsUnavailable("windows_close_failed")

    def to_reader(self, handle):
        """Consume HANDLE exactly once, including every conversion failure."""
        descriptor = None
        stream = None
        try:
            import msvcrt
            descriptor = msvcrt.open_osfhandle(handle,
                os.O_RDONLY | os.O_BINARY | os.O_NOINHERIT)
        except BaseException:
            self.close(handle)
            raise
        try:
            if (os.get_inheritable(descriptor)
                    or os.get_handle_inheritable(msvcrt.get_osfhandle(descriptor))):
                raise WindowsUnavailable("windows_reader_inheritable")
            stream = os.fdopen(descriptor, "rb", buffering=0)
            descriptor = None  # The FileIO is now the only close owner.
            if stream.tell() != 0 or stream.writable():
                raise WindowsUnavailable("windows_reader_invalid")
            return stream
        except BaseException:
            if stream is not None:
                stream.close()
            elif descriptor is not None:
                os.close(descriptor)
            raise
