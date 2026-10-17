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
