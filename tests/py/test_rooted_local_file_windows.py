"""Authored synthetic contracts only; no Windows DLL/ABI acceptance is implied.

These tests were written as source and not executed in this packet. Every native
operation is injected. Production quarantine intentionally never returns; the fake
raises a sentinel only so retained ownership can be examined without hanging.
"""
from dataclasses import replace
import io
import sys
import threading
from types import SimpleNamespace

import pytest

from music_app.services import _rooted_local_file_windows as windows
from music_app.services.rooted_local_file import RootSelection, RootedRegularFile


GUID = "\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\"
TARGET = "\\Device\\HarddiskVolume23"
SERIAL = 0xFEDCBA9876543210
SELECTION = RootSelection("win32", "C:\\Music", ("Albums", "song.FLAC"))


def identity(number, serial=SERIAL):
    return windows.WindowsIdentity("win32", serial, number.to_bytes(16, "little"))


def directory(number):
    return windows.HandleInfo(1, identity(number), True, False, 0, 11, 12, 0x10, 0)


def regular(number):
    return windows.HandleInfo(1, identity(number), False, False, 6, 21, 22, 0x20, 0)


def multisz(*items):
    text = "\0".join(items) + "\0\0"
    return windows.MultiString(text, len(text.encode("utf-16-le")) // 2, 32768)


class FakeReader(io.RawIOBase):
    def __init__(self, native, handle):
        super().__init__()
        self.native, self.handle, self.position = native, handle, 0

    def readable(self):
        return True

    def writable(self):
        return False

    def seekable(self):
        return True

    def tell(self):
        self._checkClosed()
        return self.position

    def read(self, count=-1):
        self._checkClosed()
        self.native.reads += 1
        data = self.native.data
        count = len(data) - self.position if count < 0 else count
        result = data[self.position:self.position + count]
        self.position += len(result)
        return result

    def readinto(self, target):
        result = self.read(len(target))
        target[:len(result)] = result
        return len(result)

    def seek(self, offset, whence=0):
        self._checkClosed()
        origin = {0: 0, 1: self.position, 2: len(self.native.data)}[whence]
        if origin + offset < 0:
            raise ValueError("negative seek")
        self.position = origin + offset
        return self.position

    def close(self):
        if not self.closed:
            self.native.close(self.handle)
        super().close()


class FakeNative:
    def __init__(self):
        self.quarantined = False
        self.pending = None
        self.nodes = {"boot": directory(1), "music": directory(2),
            "albums": directory(3), "leaf": regular(2 ** 120 + 4)}
        self.links = {("boot", "Music"): "music", ("music", "Albums"): "albums",
            ("albums", "song.FLAC"): "leaf"}
        self.handles = {}
        self.next_handle = 100
        self.closed = []
        self.requests = []
        self.reads = 0
        self.data = b"abcdef"
        self.guid = GUID
        self.drive_target = self.guid_target = TARGET
        self.history = ("\\??\\X:\\historical",)
        self.volume = windows.VolumeInfo("NTFS", 255)
        self.volume_lookups = []
        self.alias_lookups = []
        self.selector_count = 0
        self.on_selector = None
        self.on_open = None
        self.on_info = None
        self.bridge_failure = False
        self.transferred = []

    def volume_guid(self, drive_root):
        self.volume_lookups.append(drive_root)
        self.selector_count += 1
        if self.on_selector is not None:
            self.on_selector(self.selector_count)
        return self.guid

    def query_dos_device(self, alias):
        self.alias_lookups.append(alias)
        target = self.drive_target if alias == "C:" else self.guid_target
        return multisz(target, *self.history)

    def open(self, request):
        self.requests.append(request)
        if self.on_open is not None:
            override = self.on_open(request)
            if override is not None:
                return override
        if request.parent is None:
            assert request.name == self.drive_target + "\\"
            node = "boot"
        else:
            node = self.links.get((self.handles[request.parent], request.name))
            if node is None:
                raise windows.WindowsUnavailable("fake_missing_link")
        handle = self.next_handle
        self.next_handle += 1
        self.handles[handle] = node
        return windows.NativeOpenResult(handle, 0, 0, 1, True)

    def info(self, handle):
        node = self.handles[handle]
        if self.on_info is not None:
            override = self.on_info(handle, node)
            if override is not None:
                return override
        return self.nodes[node]

    def volume_info(self, handle):
        assert self.handles[handle] == "boot"
        return self.volume

    def close(self, handle):
        assert handle in self.handles, "duplicate or unowned close"
        self.closed.append(handle)
        del self.handles[handle]

    def to_reader(self, handle):
        self.transferred.append(handle)
        if self.bridge_failure:
            self.close(handle)
            raise OSError("fake bridge consumed handle")
        return FakeReader(self, handle)

    def quarantine(self, result):
        self.quarantined = True
        self.pending = result
        raise windows.WindowsNativePending("windows_native_pending")


def acquire(native=None):
    native = native or FakeNative()
    return native, windows.WindowsBackend(native).acquire(SELECTION)


def assert_all_closed(native):
    assert not native.handles
    assert len(native.closed) == len(set(native.closed))
    assert native.reads == 0


@pytest.mark.parametrize("root", [
    "C:Music", "\\Music", "Music", "C:/Music", "C:\\Music\\", "C:\\Music\\\\Albums",
    "\\\\server\\share", "\\\\?\\C:\\Music", "\\\\.\\C:\\Music", "\\??\\C:\\Music",
    "file://C:/Music", "C:\\..\\Music", "C:\\.\\Music", "C:\\Music:stream", "C:\\NUL.txt",
    "C:\\Music ", "C:\\Music.", "C:\\Music\0bad", "1:\\Music",
])
def test_invalid_root_rejected_before_native_open(root):
    native = FakeNative()
    with pytest.raises(windows.WindowsUnavailable):
        windows.WindowsBackend(native).acquire(replace(SELECTION, root_path=root))
    assert not native.requests
    assert not native.volume_lookups


@pytest.mark.parametrize("part", [
    "", ".", "..", "a/b", "a\\b", "song:stream", "a\0b", "a.", "a ", "CON", "con.mp3",
    "PRN.txt", "AUX", "NUL.wav", "COM1.mp3", "LPT9.mp3", "COM¹.wav", "LPT².wav",
    "COM³.wav", "CONIN$", "CONOUT$", "a?b", "a*b", "a|b", "a<b", "a>b", 'a"b', "a\nb",
    "\ud800", "\udfff",
])
def test_invalid_component_rejected_before_native_open(part):
    native = FakeNative()
    with pytest.raises(windows.WindowsUnavailable):
        windows.WindowsBackend(native).acquire(replace(SELECTION, relative_parts=(part,)))
    assert not native.requests


def test_parsing_preserves_unicode_case_and_drive_spelling():
    selection = RootSelection("win32", "c:\\Müsic", ("Song😀.FLAC",))
    assert windows.parse_selection(selection) == ("c:", ("Müsic",), ("Song😀.FLAC",))
    assert windows.utf16_units("a😀") == 3
    assert windows.validate_component("😀", 2) == "😀"
    with pytest.raises(windows.WindowsUnavailable, match="component_too_long"):
        windows.validate_component("😀", 1)
    with pytest.raises(windows.WindowsUnavailable, match="name_too_long"):
        windows.utf16_units("x" * 32767)


def test_combined_component_limit_and_strict_tuple():
    with pytest.raises(windows.WindowsUnavailable, match="too_many_components"):
        windows.parse_selection(replace(SELECTION, relative_parts=("a",) * 256))
    with pytest.raises(windows.WindowsUnavailable, match="relative_parts"):
        windows.parse_selection(replace(SELECTION, relative_parts=["song"]))
    with pytest.raises(windows.WindowsUnavailable, match="relative_parts"):
        windows.parse_selection(replace(SELECTION, relative_parts=()))
    with pytest.raises(windows.WindowsUnavailable, match="platform"):
        windows.parse_selection(replace(SELECTION, platform="posix"))


def test_guid_alias_is_exact_and_multisz_uses_first_current_mapping():
    assert windows.guid_alias(GUID) == "Volume{01234567-89ab-cdef-0123-456789abcdef}"
    assert windows.parse_multisz(multisz(TARGET, "\\??\\old")) == (TARGET, "\\??\\old")
    supplementary = multisz(TARGET, "old😀")
    assert windows.parse_multisz(supplementary)[1] == "old😀"
    for value in ("Volume{bad}", GUID[:-1], GUID + "other", GUID.replace("Volume", "volume")):
        with pytest.raises(windows.WindowsUnavailable):
            windows.guid_alias(value)


@pytest.mark.parametrize("value", [
    windows.MultiString("x\0", 2, 20), windows.MultiString("\0\0", 2, 20),
    windows.MultiString("x\0\0junk", 8, 20), windows.MultiString("x\0\0", 3, 3),
    windows.MultiString("x\0\0", 2, 20), windows.MultiString("x\0\0y\0\0", 6, 20),
    windows.MultiString("x\0\0", 3, 40000), windows.MultiString("\ud800\0\0", 3, 20),
])
def test_incomplete_or_ambiguous_multisz_is_unavailable(value):
    with pytest.raises(windows.WindowsUnavailable):
        windows.parse_multisz(value)


@pytest.mark.parametrize("target", [
    "\\??\\C:\\Music", "\\Device\\Mup\\server\\share", "\\Device\\LanmanRedirector\\server",
    "\\Device\\HarddiskVolume23\\Music", "\\Device\\HarddiskVolume23\\", "\\Device\\Harddisk0",
    "\\Device\\HarddiskVolume٢٣", "\\Device\\harddiskvolume23",
])
def test_subst_network_unknown_and_appended_path_mappings_rejected(target):
    native = FakeNative()
    native.drive_target = native.guid_target = target
    with pytest.raises(windows.WindowsUnavailable, match="mapping"):
        windows.WindowsBackend(native).acquire(SELECTION)
    assert not native.requests


def test_mismatched_drive_guid_mapping_and_historical_targets_do_not_admit():
    native = FakeNative()
    native.guid_target = "\\Device\\HarddiskVolume24"
    native.history = (TARGET,)
    with pytest.raises(windows.WindowsUnavailable, match="mapping"):
        windows.WindowsBackend(native).acquire(SELECTION)
    assert not native.requests


@pytest.mark.parametrize("boundary", [2, 3, 4])
def test_mapping_change_at_each_acquisition_boundary_fails_closed(boundary):
    native = FakeNative()
    def change(count):
        if count == boundary:
            native.guid_target = "\\Device\\HarddiskVolume24"
    native.on_selector = change
    with pytest.raises(windows.WindowsUnavailable):
        windows.WindowsBackend(native).acquire(SELECTION)
    assert_all_closed(native)


def test_bootstrap_identity_change_rejected_and_root_lookup_never_uses_library_path():
    native = FakeNative()
    root_opens = 0
    def change(request):
        nonlocal root_opens
        if request.parent is None:
            root_opens += 1
            if root_opens == 2:
                native.nodes["boot"] = directory(900)
    native.on_open = change
    with pytest.raises(windows.WindowsUnavailable, match="bootstrap_changed"):
        windows.WindowsBackend(native).acquire(SELECTION)
    assert set(native.volume_lookups) == {"C:\\"}
    assert set(native.alias_lookups) == {"C:", windows.guid_alias(GUID)}
    assert all(request.name == TARGET + "\\" for request in native.requests)
    assert_all_closed(native)


@pytest.mark.parametrize("volume", [windows.VolumeInfo("ReFS", 255),
    windows.VolumeInfo("NTFS", 0), windows.VolumeInfo("NTFS", True),
    windows.VolumeInfo("NTFS", 32767), None])
def test_unsupported_or_incomplete_volume_is_unavailable(volume):
    native = FakeNative()
    native.volume = volume
    with pytest.raises(windows.WindowsUnavailable):
        windows.WindowsBackend(native).acquire(SELECTION)
    assert_all_closed(native)


def test_queried_component_units_checked_before_library_descent():
    native = FakeNative()
    native.volume = windows.VolumeInfo("NTFS", 4)
    with pytest.raises(windows.WindowsUnavailable, match="component_too_long"):
        windows.WindowsBackend(native).acquire(SELECTION)
    assert all(request.parent is None for request in native.requests)
    assert_all_closed(native)


@pytest.mark.parametrize("node", ["boot", "music", "albums", "leaf"])
@pytest.mark.parametrize("tag_only", [False, True])
def test_every_reparse_location_and_any_tag_rejected_before_data(node, tag_only):
    native = FakeNative()
    old = native.nodes[node]
    native.nodes[node] = replace(old, reparse_tag=0x9000001A,
        attributes=old.attributes if tag_only else old.attributes | 0x400)
    with pytest.raises(windows.WindowsUnavailable):
        windows.WindowsBackend(native).acquire(SELECTION)
    assert_all_closed(native)


@pytest.mark.parametrize("node", ["boot", "music", "albums", "leaf"])
def test_wrong_object_type_rejected_before_descent_or_data(node):
    native = FakeNative()
    native.nodes[node] = regular(50) if node != "leaf" else directory(50)
    with pytest.raises(windows.WindowsUnavailable):
        windows.WindowsBackend(native).acquire(SELECTION)
    assert_all_closed(native)


@pytest.mark.parametrize("change", [
    {"file_type": 3}, {"delete_pending": True}, {"directory": 1}, {"size": -1},
    {"size": 2 ** 63}, {"last_write_time": None}, {"change_time": 2 ** 63},
    {"attributes": 0x10}, {"attributes": -1}, {"reparse_tag": 1},
    {"identity": windows.WindowsIdentity("posix", SERIAL, bytes(16))},
    {"identity": windows.WindowsIdentity("win32", 2 ** 64, bytes(16))},
    {"identity": windows.WindowsIdentity("win32", SERIAL, bytes(15))},
])
def test_incomplete_inconsistent_leaf_queries_reject(change):
    native = FakeNative()
    native.nodes["leaf"] = replace(native.nodes["leaf"], **change)
    with pytest.raises(windows.WindowsUnavailable):
        windows.WindowsBackend(native).acquire(SELECTION)
    assert_all_closed(native)


def test_missing_handle_information_rejects_and_closes_every_owned_handle():
    native = FakeNative()
    def missing(handle, node):
        if node == "leaf":
            raise OSError("unsupported FileIdInfo")
    native.on_info = missing
    with pytest.raises(OSError):
        windows.WindowsBackend(native).acquire(SELECTION)
    assert_all_closed(native)


def test_native_directory_recipe_and_full_identity_are_preserved():
    native, resource = acquire()
    assert resource.observation.leaf_identity.file_id == (2 ** 120 + 4).to_bytes(16, "little")
    assert resource.observation.leaf_identity.volume_serial == SERIAL
    assert resource.observation.original_name == "song.FLAC"
    assert resource.observation.original_suffix == ".FLAC"
    for request in native.requests:
        assert request.options & windows.FILE_OPEN_REPARSE_POINT
        assert request.options & windows.FILE_SYNCHRONOUS_IO_NONALERT
        if request.directory_candidate:
            assert request.options == windows.DIRECTORY_OPTIONS
            assert request.access == windows.DIRECTORY_ACCESS
            assert not request.options & windows.FILE_NON_DIRECTORY_FILE
            assert not request.options & 1  # Never FILE_DIRECTORY_FILE.
        else:
            assert request.options == windows.LEAF_OPTIONS
            assert request.access == windows.LEAF_ACCESS
        if request.parent is not None:
            assert "\\" not in request.name and "/" not in request.name
    resource.close()
    resource.close()
    assert_all_closed(native)


def test_expected_stamp_mismatch_precedes_leaf_open_and_describe_has_no_source_open():
    native = FakeNative()
    backend = windows.WindowsBackend(native)
    stamp = backend.describe_root(SELECTION)
    assert stamp.platform == "win32"
    assert all(request.directory_candidate for request in native.requests)
    assert_all_closed(native)
    wrong = replace(stamp, identity=identity(999))
    native.requests.clear()
    with pytest.raises(windows.WindowsUnavailable, match="root_changed"):
        backend.acquire(SELECTION, expected_root_stamp=wrong)
    assert all(request.directory_candidate for request in native.requests)
    assert_all_closed(native)


@pytest.mark.parametrize("binding", [("boot", "Music"), ("music", "Albums"),
    ("albums", "song.FLAC")])
def test_replaced_link_poison_is_sticky_after_restoration(binding):
    native, resource = acquire()
    original = native.links[binding]
    native.nodes["replacement"] = replace(native.nodes[original], identity=identity(1000))
    native.links[binding] = "replacement"
    with pytest.raises(windows.WindowsUnavailable):
        resource.check()
    native.links[binding] = original
    with pytest.raises(windows.WindowsUnavailable, match="resource_failed"):
        resource.check()
    with pytest.raises(windows.WindowsUnavailable, match="resource_failed"):
        resource.reader()
    resource.close()
    assert_all_closed(native)


@pytest.mark.parametrize("field,value", [("size", 7), ("last_write_time", 22),
    ("change_time", 23), ("identity", identity(4)),
    ("identity", identity(2 ** 120 + 4, SERIAL ^ (1 << 63)))])
def test_complete_leaf_observation_changes_poison(field, value):
    native, resource = acquire()
    original = native.nodes["leaf"]
    native.nodes["leaf"] = replace(original, **{field: value})
    with pytest.raises(windows.WindowsUnavailable):
        resource.check()
    native.nodes["leaf"] = original
    with pytest.raises(windows.WindowsUnavailable, match="resource_failed"):
        resource.check()
    resource.close()
    assert_all_closed(native)


def test_directory_timestamps_are_not_equality_guards():
    native, resource = acquire()
    native.nodes["music"] = replace(native.nodes["music"], last_write_time=100, change_time=101)
    assert resource.check() == resource.observation
    resource.close()
    assert_all_closed(native)


def test_between_check_aba_is_explicitly_outside_observation_guarantee():
    native, resource = acquire()
    original = native.links[("music", "Albums")]
    native.links[("music", "Albums")] = "unobserved-other-node"
    native.links[("music", "Albums")] = original
    assert resource.check() == resource.observation
    # This successful check demonstrates the documented limitation; it is not
    # evidence of continuous ancestry or a reason to weaken a detected failure.
    resource.close()
    assert_all_closed(native)


def test_readers_are_fresh_separately_positioned_and_read_only():
    native, resource = acquire()
    assert native.reads == 0
    left, right = resource.reader(), resource.reader()
    assert left.handle != right.handle != resource._anchor
    assert left.tell() == right.tell() == 0
    assert not left.writable() and not right.writable()
    assert left.read(2) == b"ab"
    assert right.read(3) == b"abc"
    assert left.tell() == 2
    assert right.tell() == 3
    left.seek(0)
    assert right.tell() == 3
    left.close()
    right.close()
    resource.close()
    assert not native.handles
    assert len(native.closed) == len(set(native.closed))


def test_failed_bridge_consumes_exactly_once_and_poisons_resource():
    native, resource = acquire()
    native.bridge_failure = True
    with pytest.raises(OSError, match="bridge"):
        resource.reader()
    assert len(native.transferred) == 1
    assert native.closed.count(native.transferred[0]) == 1
    with pytest.raises(windows.WindowsUnavailable, match="resource_failed"):
        resource.reader()
    resource.close()
    assert_all_closed(native)


@pytest.mark.parametrize("status,io_status,information", [
    (1, 0, 1), (0, 1, 1), (0, 0, 2), (0x80000005, 0, 1), (0xC0000022, 0, 1),
])
def test_only_exact_completed_success_opened_is_accepted(status, io_status, information):
    native = FakeNative()
    def status_result(request):
        handle = native.next_handle
        native.next_handle += 1
        native.handles[handle] = "boot"
        return windows.NativeOpenResult(handle, status, io_status, information, True)
    native.on_open = status_result
    with pytest.raises(windows.WindowsUnavailable, match="native_open_failed"):
        windows.WindowsBackend(native).acquire(SELECTION)
    assert_all_closed(native)


@pytest.mark.parametrize("pending_at", [1, 5])
def test_pending_quarantines_and_preserves_argument_and_parent_ownership(pending_at):
    native = FakeNative()
    owned_storage = object()
    def pending(request):
        if len(native.requests) == pending_at:
            handle = native.next_handle
            native.next_handle += 1
            native.handles[handle] = "leaf" if request.parent is not None else "boot"
            return windows.NativeOpenResult(handle, windows.STATUS_PENDING,
                windows.STATUS_PENDING, 0, False, owned_storage)
    native.on_open = pending
    backend = windows.WindowsBackend(native)
    with pytest.raises(windows.WindowsNativePending):
        backend.acquire(SELECTION)
    assert backend.quarantined
    assert native.pending.storage is owned_storage
    assert native.pending.handle in native.handles
    assert native.handles  # No close of any still-referenced parent/anchor.
    assert native.reads == 0
    with pytest.raises(windows.WindowsUnavailable, match="quarantined"):
        backend.acquire(SELECTION)


def test_neutral_owner_enforces_four_readers_and_deferred_close():
    native, resource = acquire()
    lease = RootedRegularFile(resource)
    readers = [lease.independent_reader() for _ in range(4)]
    retained = set(resource._handles)
    with pytest.raises(Exception, match="reader_limit"):
        lease.independent_reader()
    lease.close()
    assert not lease.drained.is_set()
    assert retained.issubset(native.handles)
    with pytest.raises(Exception, match="source_closed"):
        lease.independent_reader()
    for reader in readers:
        reader.close()
    assert lease.drained.is_set()
    assert_all_closed(native)


def test_neutral_close_during_native_check_is_immediate_then_drains():
    native, resource = acquire()
    lease = RootedRegularFile(resource)
    entered, release = threading.Event(), threading.Event()
    errors = []
    def blocked(request):
        if request.parent is None:
            entered.set()
            assert release.wait(5)
    native.on_open = blocked
    def run_check():
        try:
            lease.check()
        except BaseException as error:
            errors.append(error)
    worker = threading.Thread(target=run_check)
    worker.start()
    try:
        assert entered.wait(5)
        retained = set(resource._handles)
        lease.close()
        assert not lease.drained.is_set()
        assert retained.issubset(native.handles)
    finally:
        release.set()
        worker.join(5)
    assert not worker.is_alive()
    assert errors and "source_closed" in str(errors[0])
    assert lease.drained.is_set()
    assert_all_closed(native)


def test_injected_backend_never_constructs_real_native_binding(monkeypatch):
    def forbidden():
        raise AssertionError("native loading is forbidden in synthetic tests")
    monkeypatch.setattr(windows, "CtypesWindowsNative", forbidden)
    native, resource = acquire()
    resource.check()
    resource.close()
    assert_all_closed(native)


@pytest.mark.parametrize("failure", [None, "bridge", "inheritable", "fdopen", "position"])
def test_crt_bridge_noninheritance_and_exact_transfer_with_injected_modules(monkeypatch, failure):
    # Exercise authored bridge logic without constructing/loading native DLLs.
    native = object.__new__(windows.CtypesWindowsNative)
    closed_handles, closed_fds, flags_seen = [], [], []
    native.close = closed_handles.append
    raw = FakeNative()
    raw.handles[500] = "leaf"
    stream = FakeReader(raw, 500)
    if failure == "position":
        stream.position = 1
    def open_osfhandle(handle, flags):
        flags_seen.append(flags)
        assert handle == 500
        if failure == "bridge":
            raise OSError("bridge failed")
        return 700
    def fdopen(fd, mode, buffering):
        assert (fd, mode, buffering) == (700, "rb", 0)
        if failure == "fdopen":
            raise OSError("fdopen failed")
        return stream
    monkeypatch.setitem(sys.modules, "msvcrt", SimpleNamespace(
        open_osfhandle=open_osfhandle, get_osfhandle=lambda fd: 500))
    monkeypatch.setattr(windows, "os", SimpleNamespace(O_RDONLY=0, O_BINARY=0x8000,
        O_NOINHERIT=0x80, get_inheritable=lambda fd: failure == "inheritable",
        get_handle_inheritable=lambda handle: False, fdopen=fdopen,
        close=closed_fds.append))
    if failure is None:
        assert native.to_reader(500) is stream
        assert not closed_handles and not closed_fds
        stream.close()
    else:
        with pytest.raises((OSError, windows.WindowsUnavailable)):
            native.to_reader(500)
        if failure == "bridge":
            assert closed_handles == [500] and not closed_fds
        elif failure in ("inheritable", "fdopen"):
            assert not closed_handles and closed_fds == [700]
        else:
            assert stream.closed and raw.closed == [500]
            assert not closed_handles and not closed_fds
    assert flags_seen == [windows.os.O_RDONLY | 0x8000 | 0x80]


def query_only_native(*, inconsistent=False, fail_class=None):
    """Bypass construction and inject all query outputs; no ctypes/DLL call."""
    native = object.__new__(windows.CtypesWindowsNative)
    native.quarantined = False
    native.kernel = SimpleNamespace(GetFileType=lambda handle: windows.FILE_TYPE_DISK)
    native.FILE_STANDARD_INFO = object()
    native.FILE_ATTRIBUTE_TAG_INFO = object()
    native.FILE_BASIC_INFO = object()
    native.FILE_ID_INFO = object()
    calls = []
    values = {
        1: SimpleNamespace(Directory=0, DeletePending=0, AllocationSize=4096, EndOfFile=6),
        9: SimpleNamespace(FileAttributes=0x20, ReparseTag=0),
        0: SimpleNamespace(FileAttributes=0x80 if inconsistent else 0x20,
            LastWriteTime=21, ChangeTime=22),
        18: SimpleNamespace(VolumeSerialNumber=SERIAL,
            FileId=SimpleNamespace(Identifier=(2 ** 120 + 4).to_bytes(16, "little"))),
    }
    def query(handle, information_class, structure):
        calls.append(information_class)
        if information_class == fail_class:
            raise windows.WindowsUnavailable("windows_handle_query_failed")
        return values[information_class]
    native._query = query
    return native, calls


def test_binding_queries_all_required_information_without_legacy_serial_truncation():
    native, calls = query_only_native()
    info = native.info(100)
    assert calls == [1, 9, 0, 18]
    assert info.identity.volume_serial == SERIAL
    assert info.identity.file_id == (2 ** 120 + 4).to_bytes(16, "little")
    assert (info.size, info.last_write_time, info.change_time) == (6, 21, 22)


@pytest.mark.parametrize("information_class", [1, 9, 0, 18])
def test_any_missing_native_query_is_unavailable(information_class):
    native, calls = query_only_native(fail_class=information_class)
    with pytest.raises(windows.WindowsUnavailable, match="query_failed"):
        native.info(100)
    assert information_class in calls


def test_native_basic_and_attribute_tag_inconsistency_is_unavailable():
    native, calls = query_only_native(inconsistent=True)
    with pytest.raises(windows.WindowsUnavailable, match="inconsistent"):
        native.info(100)
    assert calls == [1, 9, 0, 18]


def test_pre_resource_failure_attempts_all_closes_even_when_one_close_fails():
    native = FakeNative()
    original_close = native.close
    failure_started = False
    attempted = []
    def fail_info(handle, node):
        nonlocal failure_started
        if node == "leaf":
            failure_started = True
            raise OSError("original admission failure")
    def flaky_close(handle):
        if failure_started:
            attempted.append(handle)
        original_close(handle)
        if len(attempted) == 1:
            raise OSError("cleanup failure")
    native.on_info = fail_info
    native.close = flaky_close
    with pytest.raises(OSError, match="original admission failure"):
        windows.WindowsBackend(native).acquire(SELECTION)
    assert len(attempted) == 4  # Leaf, Albums, Music, retained bootstrap.
    assert_all_closed(native)
