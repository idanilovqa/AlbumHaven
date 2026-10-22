"""Dormant retained-file readers and narrowly inherited FFmpeg source launcher.

No authority is granted by opening a file: future caller must hold canonical
media permission. Source observations are mutation checks, not content hashes.
No pathname input fallback, file copying, broker or installed-software change.
This path-only helper does not prove root confinement or current-library authority.
"""
import asyncio
from dataclasses import dataclass
from pathlib import Path
import os
import stat
import subprocess
import sys

from music_app.services.ffmpeg_runtime import hidden_subprocess_creation_flags
from music_app.services.ffmpeg_source_capability import DEFAULT_SOURCE_CAPABILITY_PROBE


class SourceUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class FileObservation:
    device: int
    inode: int
    size: int
    mtime_ns: int
    ctime_ns: int


def _observation(info):
    if not stat.S_ISREG(info.st_mode):
        raise SourceUnavailable('source_not_regular')
    return FileObservation(info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class PosixReaders:
    """Each open gets its own offset; checked against the still-open anchor.

    A replacement pathname is never accepted as equivalent. Decoder/probe receive
    only the checked fd, never this pathname. No /proc dependency is required.
    """
    platform = 'posix'

    def open(self, path):
        # Nonblocking prevents a replaced FIFO from waiting for a writer before
        # fstat can reject it. It does not bound general filesystem latency.
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            _observation(os.fstat(descriptor))
            return os.fdopen(descriptor, 'rb', buffering=0)
        except BaseException:
            os.close(descriptor)
            raise

    def reopen(self, anchor, path):
        return self.open(path)

    def value(self, reader):
        return reader.fileno()

    def inheritance(self, reader):
        return {'pass_fds': (reader.fileno(),), 'close_fds': True}


class WindowsReaders:
    platform = 'win32'

    def __init__(self):
        if sys.platform != 'win32':
            raise SourceUnavailable('windows_adapter_requires_windows')
        # Lazy stdlib bindings: importing this module does not load Windows APIs.
        import ctypes
        from ctypes import wintypes
        self.ctypes = ctypes
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
            wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
        self.kernel.CreateFileW.restype = wintypes.HANDLE
        self.kernel.ReOpenFile.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD)
        self.kernel.ReOpenFile.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        self.kernel.CloseHandle.restype = wintypes.BOOL

    def _file(self, handle):
        import msvcrt
        if handle == self.ctypes.c_void_p(-1).value or handle is None:
            raise self.ctypes.WinError(self.ctypes.get_last_error())
        try:
            descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        except BaseException:
            self.kernel.CloseHandle(handle)
            raise
        try:
            return os.fdopen(descriptor, 'rb', buffering=0)
        except BaseException:
            os.close(descriptor)
            raise

    def open(self, path):
        # GENERIC_READ; share read/write/delete to avoid silently blocking editors;
        # OPEN_EXISTING, synchronous FILE_ATTRIBUTE_NORMAL, never OVERLAPPED.
        return self._file(self.kernel.CreateFileW(str(path), 0x80000000, 7, None, 3, 0x80, None))

    def reopen(self, anchor, path):
        # ReOpenFile binds the same object without resolving the mutable pathname.
        return self._file(self.kernel.ReOpenFile(self.value(anchor), 0x80000000, 7, 0))

    def value(self, reader):
        import msvcrt
        return msvcrt.get_osfhandle(reader.fileno())

    def inheritance(self, reader):
        startup = subprocess.STARTUPINFO()
        startup.lpAttributeList = {'handle_list': [self.value(reader)]}
        return {'startupinfo': startup, 'close_fds': True}

    def get_inheritable(self, handle):
        return os.get_handle_inheritable(handle)

    def set_inheritable(self, handle, value):
        os.set_handle_inheritable(handle, value)


class RetainedPlaybackSource:
    @classmethod
    def from_rooted_lease(cls, lease, *, original_suffix):
        """Transfer ownership after validation; dormant, never pathname-backed.

        On validation failure the caller still owns lease. Launch integration is
        deliberately blocked until child-use ownership through reap is wired.
        """
        if (type(original_suffix) is not str or len(original_suffix) > 32
                or (original_suffix and not original_suffix.startswith('.'))
                or any(c in original_suffix for c in ('/', '\\', '\x00', ':'))):
            raise SourceUnavailable('source_suffix_invalid')
        observation = lease.check()
        if original_suffix.lower() != lease.original_suffix.lower():
            raise SourceUnavailable('source_suffix_changed')
        platform = getattr(observation, 'platform', None)
        if platform not in ('posix', 'win32'):
            raise SourceUnavailable('source_platform_invalid')
        source = cls.__new__(cls)
        source.original_suffix = original_suffix.lower()
        # Only transport methods are reused. No native initialization or path open.
        source.backend = (WindowsReaders.__new__(WindowsReaders)
                          if platform == 'win32' else PosixReaders())
        source._closed = source._failed = source._launching = False
        source._cleanup_task = None
        source.observation = observation
        lease.claim_adapter()
        source._rooted_lease = lease
        return source

    def __init__(self, path, *, backend=None, fstat=os.fstat, path_stat=None):
        self.path = Path(path).absolute()
        self.original_suffix = self.path.suffix.lower()
        self.backend = backend or (WindowsReaders() if sys.platform == 'win32' else PosixReaders())
        self._fstat = fstat
        self._path_stat = path_stat or (lambda value: value.stat())
        self._anchor = None
        self._closed = False
        self._failed = False
        self._launching = False
        self._cleanup_task = None
        self._anchor = self.backend.open(self.path)
        try:
            self.observation = _observation(self._fstat(self._anchor.fileno()))
            self.check()
        except BaseException:
            self.close()
            raise

    def check(self):
        if hasattr(self, '_rooted_lease'):
            if self._closed:
                raise SourceUnavailable('source_closed')
            if self._failed:
                raise SourceUnavailable('source_failed')
            try:
                observation = self._rooted_lease.check()
                if self._closed or self._failed:
                    raise SourceUnavailable('source_closed' if self._closed else 'source_failed')
                return observation
            except BaseException:
                self._failed = True
                raise
        if self._closed or self._anchor is None:
            raise SourceUnavailable('source_closed')
        if self._failed:
            raise SourceUnavailable('source_failed')
        try:
            if (_observation(self._fstat(self._anchor.fileno())) != self.observation or
                    _observation(self._path_stat(self.path)) != self.observation):
                raise SourceUnavailable('source_changed')
        except OSError as error:
            self._failed = True
            raise SourceUnavailable('source_changed') from error
        except SourceUnavailable:
            self._failed = True
            raise
        return self.observation

    def reader(self):
        if hasattr(self, '_rooted_lease'):
            self.check()
            reader = None
            try:
                reader = self._rooted_lease.independent_reader()
                if self._closed or self._failed:
                    raise SourceUnavailable('source_closed' if self._closed else 'source_failed')
                return reader
            except BaseException:
                self._failed = True
                if reader is not None:
                    reader.close()
                raise
        self.check()
        reader = None
        try:
            reader = self.backend.reopen(self._anchor, self.path)
            if _observation(self._fstat(reader.fileno())) != self.observation:
                raise SourceUnavailable('source_changed')
            self.check()
            return reader
        except BaseException:
            self._failed = True
            if reader is not None:
                reader.close()
            raise

    def close(self):
        if self._launching or self._cleanup_task is not None and not self._cleanup_task.done():
            raise SourceUnavailable('source_launch_in_progress')
        if not self._closed:
            self._closed = True
            if hasattr(self, '_rooted_lease'):
                self._rooted_lease.close()
                return
            if self._anchor is not None:
                self._anchor.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


async def start_retained_process(source, capability, before_input, after_input, *,
                                 probe=DEFAULT_SOURCE_CAPABILITY_PROBE,
                                 spawn=asyncio.create_subprocess_exec):
    """Return a subprocess to the existing decoder/probe lifecycle owner.

    On success the child owns its inherited reader; the parent reader closes
    immediately. Caller retains source through all observations and reaps child.
    No arbitrary kwargs can broaden inheritance. Native asyncio's spawn contract
    cleans up a child when creation is cancelled before return; fake factories
    must obey that same ownership contract. No process is started on unavailable
    capability. Future callers may then choose ordinary playback explicitly.
    """
    if hasattr(source, '_rooted_lease'):
        raise SourceUnavailable('rooted_launch_not_integrated')
    if source._launching or source._cleanup_task is not None and not source._cleanup_task.done():
        raise SourceUnavailable('source_launch_in_progress')
    if (not capability.available or not probe.matches(capability) or
            capability.protocol != ('handle' if source.backend.platform == 'win32' else 'fd')):
        raise SourceUnavailable('capability_unavailable')
    if (not isinstance(before_input, (tuple, list)) or not isinstance(after_input, (tuple, list)) or
            any(not isinstance(value, str) for value in (*before_input, *after_input))):
        raise ValueError('invalid_process_arguments')
    source._launching = True
    reader = None
    previous = None
    handle = None
    process = None

    async def abort_child():
        source._failed = True
        if process is None:
            return
        async def reap():
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            async def drain(stream):
                if stream is not None:
                    while await stream.read(8192):
                        pass
            # A pipe error must not skip wait or abandon the other pipe owner.
            results = await asyncio.gather(drain(process.stdout), drain(process.stderr),
                                           process.wait(), return_exceptions=True)
            for result in results:
                if isinstance(result, BaseException):
                    raise result
        if source._cleanup_task is None:
            source._cleanup_task = asyncio.create_task(reap())
            def finished(done):
                if not done.cancelled():
                    done.exception()
            source._cleanup_task.add_done_callback(finished)
        task = source._cleanup_task
        try:
            await asyncio.wait_for(asyncio.shield(task), 2.0)
        except BaseException:
            raise SourceUnavailable('source_child_cleanup_incomplete') from None

    try:
        reader = source.reader()
        value = source.backend.value(reader)
        options = source.backend.inheritance(reader)
        if source.backend.platform == 'win32':
            handle = value
            previous = source.backend.get_inheritable(handle)
            source.backend.set_inheritable(handle, True)
        source.check()
        if not probe.matches(capability):
            raise SourceUnavailable('executable_changed')
        process = await spawn(capability.identity.path, '-nostdin', *before_input,
            '-' + capability.protocol, str(value), '-i', capability.protocol + ':', *after_input,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, creationflags=hidden_subprocess_creation_flags(),
            **options)
        source.check()
    except BaseException:
        await abort_child()
        raise
    finally:
        try:
            if handle is not None and previous is not None:
                try:
                    source.backend.set_inheritable(handle, previous)
                except BaseException:
                    await abort_child()
                    raise
        finally:
            try:
                if reader is not None:
                    try:
                        reader.close()
                    except BaseException:
                        await abort_child()
                        raise
            finally:
                source._launching = False
    return process


# Dormant shared ownership. No instance or background work is created on import.
import threading as _ownership_threading

_TRANSFER_LOCK = _ownership_threading.Lock()


class _SourceInterest:
    def __init__(self, owner, kind):
        self.owner, self.kind, self.live = owner, kind, True


class _SourcePin:
    def __init__(self, owner, interest):
        self._owner, self._interest = owner, interest
        self._gate = _ownership_threading.Lock()
        self._released = False

    def check(self):
        # This operation-local gate also prevents release during physical I/O.
        with self._gate:
            if self._released:
                raise SourceUnavailable('pin_released')
            self._owner._validate_pin(self)
            result = self._owner._source.check()
            self._owner._validate_pin(self)
            return result

    def reader(self):
        with self._gate:
            if self._released or self._interest.kind != 'playback':
                raise SourceUnavailable('playback_pin_required')
            self._owner._validate_pin(self)
            # Rooted reader owns its independent reservation after this returns.
            return self._owner._source.reader()

    def release(self):
        with self._gate:
            if self._released:
                return
            with self._owner._state:
                if self not in self._owner._live_pins:
                    raise SourceUnavailable('source_pin_invalid')
                self._owner._live_pins.remove(self)
                self._owner._pins[self._interest.kind] -= 1
                self._released = True
        self._owner.try_close()


class ChildResponsibility:
    """Trusted future launch lifecycle ticket; never infers reap from EOF/kill.

    Callers must retain this ticket through ambiguous spawn cancellation and
    pipe/inheritance cleanup. There is deliberately no automatic __exit__.
    """
    def __init__(self, owner):
        self._owner = owner
        self._gate = _ownership_threading.Lock()
        self._rooted_ticket = None
        self._phase = 'reserving'
        self._settlement = None

    def mark_launched(self):
        with self._gate:
            if self._phase != 'launching':
                raise SourceUnavailable('child_state_invalid')
            self._phase = 'launched'

    def release_no_child(self, *, proved_no_child, cleanup_complete):
        if proved_no_child is not True or cleanup_complete is not True:
            raise SourceUnavailable('child_cleanup_unproven')
        self._settle('no_child', None)

    def release_after_reap(self, *, wait_result, cleanup_complete):
        # An actual successful process.wait() result, asserted by its trusted
        # lifecycle owner. bool, returncode inspection and EOF are not proof.
        if type(wait_result) is not int or cleanup_complete is not True:
            raise SourceUnavailable('child_reap_unproven')
        self._settle('reaped', wait_result)

    def _settle(self, kind, result):
        with self._gate:
            if self._settlement is not None:
                if self._settlement != (kind, result):
                    raise SourceUnavailable('child_settlement_conflict')
                return
            required = 'launching' if kind == 'no_child' else 'launched'
            if self._phase != required:
                raise SourceUnavailable('child_state_invalid')
            self._phase = 'settling'
            try:
                self._rooted_ticket.close()
            except BaseException:
                self._phase = 'cleanup_failed'
                # Keep owner responsibility charged; never retry uncertain close.
                raise
            self._settlement = (kind, result)
            self._phase = 'settled'
            with self._owner._state:
                if self._owner._child is not self:
                    raise SourceUnavailable('child_owner_mismatch')
                self._owner._child = None
        self._owner.try_close()


class SharedPlaybackSourceOwner:
    """Exclusive rooted source owner with separate P/E/operation lifetimes."""
    @classmethod
    def create(cls, source):
        from music_app.services.rooted_local_file import RootedRegularFile
        if type(source) is not RetainedPlaybackSource:
            raise SourceUnavailable('retained_source_required')
        rooted = getattr(source, '_rooted_lease', None)
        if type(rooted) is not RootedRegularFile:
            raise SourceUnavailable('accepted_rooted_source_required')
        owner = cls.__new__(cls)
        owner._state = _ownership_threading.Lock()
        owner._source, owner._rooted = source, rooted
        owner._p = _SourceInterest(owner, 'playback')
        owner._e = None
        owner._pins = {'playback': 0, 'evidence': 0}
        owner._live_pins = set()
        owner._child = None
        owner._close_state = 'pending'
        owner._close_attempted = False
        result = (owner, owner._p)  # Allocate transfer result before consuming claim.
        # One scalar marker on the source, never a growing global identity map.
        # Allocation precedes transfer. No source/rooted I/O under these locks.
        with _TRANSFER_LOCK:
            with rooted._state:
                if (getattr(source, '_shared_owner_claimed', False)
                        or source._closed or source._failed or source._launching
                        or source._cleanup_task is not None
                        or not rooted._adapter_claimed or rooted._closing
                        or rooted._failed or rooted._active):
                    raise SourceUnavailable('source_ownership_unavailable')
                source._shared_owner_claimed = True
        return result

    def _validate_locked(self, interest):
        expected = self._p if interest is self._p else self._e
        if (interest is None or interest is not expected or not interest.live
                or self._close_attempted):
            raise SourceUnavailable('source_interest_unavailable')

    def _validate_interest(self, interest):
        with self._state:
            self._validate_locked(interest)

    def _validate_pin(self, pin):
        with self._state:
            if pin not in self._live_pins:
                raise SourceUnavailable('source_pin_invalid')
            self._validate_locked(pin._interest)

    def attach_evidence(self, playback_token):
        token = _SourceInterest(self, 'evidence')
        with self._state:
            if playback_token is not self._p:
                raise SourceUnavailable('playback_token_required')
            self._validate_locked(playback_token)
            if self._e is not None:
                raise SourceUnavailable('evidence_already_attached')
            self._e = token
        return token

    def _pin(self, token, kind, limit):
        pin = _SourcePin(self, token)
        with self._state:
            if token is not (self._p if kind == 'playback' else self._e):
                raise SourceUnavailable('source_token_invalid')
            self._validate_locked(token)
            if self._pins[kind] >= limit:
                raise SourceUnavailable('source_pin_capacity')
            self._live_pins.add(pin)
            self._pins[kind] += 1
        return pin

    def pin_playback(self, token):
        return self._pin(token, 'playback', 4)

    def pin_evidence(self, token):
        # Registry owns generation checks and its fixed scheduler reservation.
        return self._pin(token, 'evidence', 2)

    def begin_child(self, playback_token):
        ticket = ChildResponsibility(self)
        with self._state:
            if playback_token is not self._p:
                raise SourceUnavailable('playback_token_required')
            self._validate_locked(playback_token)
            if self._child is not None:
                raise SourceUnavailable('child_capacity')
            self._child = ticket
        try:
            ticket._rooted_ticket = self._rooted.reserve_child_use()
        except BaseException:
            # Accepted rooted reserve allocates before its atomic increment and
            # cannot raise after acquiring ownership. No arbitrary adapter here.
            with self._state:
                self._child = None
            raise
        ticket._phase = 'launching'
        return ticket

    def release_playback(self, token):
        with self._state:
            if token is not self._p:
                raise SourceUnavailable('playback_token_required')
            if not token.live:
                return
            if self._child is not None or self._pins['playback']:
                raise SourceUnavailable('playback_responsibility_pending')
            token.live = False
        self.try_close()

    def release_evidence(self, token):
        with self._state:
            if token is None or token is not self._e:
                raise SourceUnavailable('evidence_token_required')
            token.live = False
        # Caller must invoke try_close outside registry locks.

    def try_close(self):
        with self._state:
            if self._close_state in ('disposed', 'cleanup_failed', 'closing'):
                return self._close_state if self._close_state != 'closing' else 'pending'
            if (self._p.live or self._e is not None and self._e.live
                    or any(self._pins.values()) or self._child is not None):
                return 'pending'
            attempt = not self._close_attempted
            self._close_attempted = True
            self._close_state = 'closing'
        try:
            if attempt:
                self._source.close()
            failed = self._rooted.cleanup_failed is True
            disposed = (self._rooted.cleanup_complete is True
                        and self._rooted.drained.is_set() and not failed)
            status = 'cleanup_failed' if failed else ('disposed' if disposed else 'pending')
        except BaseException:
            status = 'cleanup_failed'
        with self._state:
            self._close_state = status
        return status
