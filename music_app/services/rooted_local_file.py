"""Private rooted-file ownership; observations are not authority/content hashes.

Windows remains dormant and native-unaccepted. No pathname fallback, DB, image
decoder or process launcher lives here. State locks never enclose native I/O.
"""
from contextlib import ExitStack
from dataclasses import dataclass
import os
from pathlib import PurePosixPath
import stat
import threading
import time


class RootedFileUnavailable(ValueError):
    pass


@dataclass(frozen=True)
class RootSelection:
    platform: str
    root_path: str
    relative_parts: tuple[str, ...]


@dataclass(frozen=True)
class RootObservationSelection:
    """An honest root-only selection; no fabricated leaf is required."""
    platform: str
    root_path: str


@dataclass(frozen=True)
class PosixRootStamp:
    platform: str
    device: int
    inode: int


@dataclass(frozen=True)
class PosixObservation:
    platform: str
    device: int
    inode: int
    size: int
    mtime_ns: int
    ctime_ns: int


def _directory_identity(info, error=RootedFileUnavailable):
    if not stat.S_ISDIR(info.st_mode):
        raise error('artwork_root_unavailable')
    return info.st_dev, info.st_ino


class PosixDirectoryChain:
    """Existing artwork walk, with its exception factory supplied by the facade."""
    def __init__(self, stack, root, error=RootedFileUnavailable, *,
                 operation_context=None):
        self.stack = stack
        self.error = error
        self.operation_context = operation_context
        self.links = []
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        if operation_context is not None:
            operation_context.before_syscall()
        self.fd = os.open('/', flags)
        if operation_context is None:
            stack.callback(os.close, self.fd)
        else:
            self._register_counted_close(self.fd)
            operation_context.before_syscall()
        _directory_identity(os.fstat(self.fd), error)
        for part in root.parts[1:]:
            self.descend(part)

    def _register_counted_close(self, fd):
        # The fixed context closes on callback-construction failure and returns
        # an idempotent token. If registration itself fails after retaining the
        # callback, immediate cleanup and later ExitStack cleanup cannot double
        # close a recycled descriptor. Legacy None behavior is untouched.
        close = self.operation_context.register_close(fd)
        try:
            self.stack.callback(close)
        except BaseException:
            close()
            raise

    def descend(self, part):
        parent = self.fd
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        context = self.operation_context
        if context is not None:
            context.charge_component()
            context.before_syscall()
        child = os.open(part, flags, dir_fd=parent)
        if context is None:
            self.stack.callback(os.close, child)
        else:
            self._register_counted_close(child)
            context.before_syscall()
        identity = _directory_identity(os.fstat(child), self.error)
        self.links.append((parent, part, child, identity))
        self.fd = child

    def check(self):
        for parent, name, child, expected in self.links:
            if self.operation_context is not None:
                self.operation_context.before_syscall()
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if self.operation_context is None:
                if (_directory_identity(current, self.error) != expected or
                        _directory_identity(os.fstat(child), self.error) != expected):
                    raise self.error('artwork_source_changed')
            elif _directory_identity(current, self.error) != expected:
                raise self.error('artwork_source_changed')
            else:
                self.operation_context.before_syscall()
                if _directory_identity(os.fstat(child), self.error) != expected:
                    raise self.error('artwork_source_changed')


def _posix_selection(selection):
    if (type(selection) is not RootSelection or selection.platform != 'posix'
            or type(selection.root_path) is not str
            or type(selection.relative_parts) is not tuple):
        raise RootedFileUnavailable('source_invalid')
    text = selection.root_path
    if (not text.startswith('/') or text.startswith('//') or '\x00' in text
            or len(text.encode('utf-8')) > 8192):
        raise RootedFileUnavailable('source_invalid')
    root_parts = text.split('/')[1:]
    if text == '/':
        root_parts = []
    parts = (*root_parts, *selection.relative_parts)
    if not selection.relative_parts or len(parts) > 256:
        raise RootedFileUnavailable('source_invalid')
    if any(type(p) is not str or not p or p in ('.', '..') or '/' in p
           or '\x00' in p for p in parts):
        raise RootedFileUnavailable('source_invalid')
    if len('/'.join(selection.relative_parts).encode('utf-8')) > 16384:
        raise RootedFileUnavailable('source_invalid')
    return PurePosixPath(text)


def _posix_observation(info):
    if not stat.S_ISREG(info.st_mode):
        raise RootedFileUnavailable('source_not_regular')
    return PosixObservation('posix', info.st_dev, info.st_ino, info.st_size,
                            info.st_mtime_ns, info.st_ctime_ns)


def _require_posix():
    if (os.name != 'posix' or any(not hasattr(os, f) for f in
            ('O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_CLOEXEC'))
            or os.open not in os.supports_dir_fd
            or os.stat not in os.supports_dir_fd
            or os.stat not in os.supports_follow_symlinks):
        raise RootedFileUnavailable('platform_unavailable')


class PosixResource:
    def __init__(self, selection, expected_root_stamp=None):
        _require_posix()
        root = _posix_selection(selection)
        self.stack = ExitStack()
        try:
            self.chain = PosixDirectoryChain(self.stack, root)
            device, inode = _directory_identity(os.fstat(self.chain.fd))
            self.root_stamp = PosixRootStamp('posix', device, inode)
            if expected_root_stamp is not None and self.root_stamp != expected_root_stamp:
                raise RootedFileUnavailable('source_changed')
            for part in selection.relative_parts[:-1]:
                self.chain.descend(part)
            self.parent, self.name = self.chain.fd, selection.relative_parts[-1]
            self.original_suffix = PurePosixPath(self.name).suffix.lower()
            self.observation = _posix_observation(os.stat(self.name,
                dir_fd=self.parent, follow_symlinks=False))
            self.anchor = self._open()
            self.stack.callback(self.anchor.close)
            self.check()
        except BaseException:
            self.stack.close()
            raise

    def _open(self):
        fd = os.open(self.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK |
                     os.O_CLOEXEC, dir_fd=self.parent)
        try:
            if _posix_observation(os.fstat(fd)) != self.observation:
                raise RootedFileUnavailable('source_changed')
            return os.fdopen(fd, 'rb', buffering=0)
        except BaseException:
            os.close(fd)
            raise

    def check(self):
        self.chain.check()
        if (_posix_observation(os.fstat(self.anchor.fileno())) != self.observation
                or _posix_observation(os.stat(self.name, dir_fd=self.parent,
                    follow_symlinks=False)) != self.observation):
            raise RootedFileUnavailable('source_changed')

    def reader(self):
        return self._open()

    def close(self):
        self.stack.close()


class _Reservation:
    def __init__(self, owner, reader=False):
        self.owner, self.reader = owner, reader
        self.lock = threading.Lock()

    def close(self):
        with self.lock:
            owner, self.owner = self.owner, None
        if owner is not None:
            owner._release(self.reader)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class OwnedReader:
    """Reader-local gate protects read/seek against physical close.

fileno is borrowed only: callers must retain this reader and prohibit concurrent
close while an external consumer uses it. Child lifetime requires a separate lease
reservation through reap; a raw descriptor is never a transferable ownership token.
"""
    def __init__(self, stream, ticket):
        self._stream, self._ticket = stream, ticket
        self._gate = threading.Lock()
        self._state = threading.Lock()
        self._closing = False

    def _call(self, method, *args):
        with self._gate:
            with self._state:
                if self._closing:
                    raise RootedFileUnavailable('reader_closed')
            return getattr(self._stream, method)(*args)

    def read(self, size=-1):
        return self._call('read', size)

    def readinto(self, buffer):
        return self._call('readinto', buffer)

    def seek(self, offset, whence=0):
        return self._call('seek', offset, whence)

    def tell(self):
        return self._call('tell')

    def fileno(self):
        return self._call('fileno')

    @property
    def closed(self):
        with self._state:
            return self._closing

    def close(self):
        with self._state:
            self._closing = True
        with self._gate:
            if self._ticket is not None:
                ticket, self._ticket = self._ticket, None
                try:
                    self._stream.close()
                finally:
                    ticket.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class RootedRegularFile:
    """One resource owner; no state mutex held during resource/native methods."""
    def __init__(self, resource):
        self._resource = resource
        self.observation = resource.observation
        self.root_stamp = resource.root_stamp
        self.original_name = getattr(resource.observation, 'original_name',
                                     getattr(resource, 'name', ''))
        self.original_suffix = getattr(resource.observation, 'original_suffix',
                                       getattr(resource, 'original_suffix', ''))
        self._state, self._io = threading.Lock(), threading.Lock()
        self._closing = self._failed = self._disposed = False
        self._adapter_claimed = False
        self._active = self._readers = 0
        self.drained = threading.Event()

    def _reserve(self, reader=False):
        with self._state:
            if self._closing or self._failed:
                raise RootedFileUnavailable('source_closed' if self._closing else 'source_failed')
            if reader and self._readers >= 4:
                raise RootedFileUnavailable('reader_limit')
            self._active += 1
            self._readers += int(reader)
        return _Reservation(self, reader)

    def _release(self, reader=False):
        dispose = False
        with self._state:
            self._active -= 1
            self._readers -= int(reader)
            if self._closing and not self._active and not self._disposed:
                self._disposed = dispose = True
        if dispose:
            try:
                self._resource.close()
            finally:
                self.drained.set()

    def _publish(self):
        with self._state:
            if self._closing or self._failed:
                raise RootedFileUnavailable('source_closed' if self._closing else 'source_failed')

    def poison(self):
        with self._state:
            self._failed = True

    def check(self):
        with self._reserve():
            with self._io:
                try:
                    self._publish()
                    self._resource.check()
                    self._publish()
                except BaseException:
                    # Publish failure before the next reserved operation can
                    # enter this gate, even if the resource itself is not sticky.
                    self.poison()
                    raise
                return self.observation

    def independent_reader(self):
        ticket = self._reserve(reader=True)
        stream = None
        try:
            with self._io:
                try:
                    self._publish()
                    self._resource.check()
                    stream = self._resource.reader()
                    self._resource.check()
                    self._publish()
                    owned = OwnedReader(stream, ticket)
                except BaseException:
                    self.poison()
                    raise
            return owned
        except BaseException:
            try:
                if stream is not None:
                    stream.close()
            finally:
                ticket.close()
            raise

    def reserve_child_use(self):
        """Dormant contract: owner must hold ticket until child is reaped."""
        return self._reserve()

    def claim_adapter(self):
        """Single transfer into a retained adapter; caller relinquishes ownership."""
        with self._state:
            if self._closing or self._failed or self._adapter_claimed or self._active:
                raise RootedFileUnavailable('source_ownership_unavailable')
            self._adapter_claimed = True

    def close(self):
        dispose = False
        with self._state:
            self._closing = True
            if not self._active and not self._disposed:
                self._disposed = dispose = True
        if dispose:
            try:
                self._resource.close()
            finally:
                self.drained.set()


def acquire(selection, expected_root_stamp=None, *, backend=None):
    """Dormant acquisition; caller owns off-loop admission and abandonment budget."""
    if type(selection) is not RootSelection:
        raise RootedFileUnavailable('source_invalid')
    if backend is not None:
        resource = backend.acquire(selection, expected_root_stamp)
    elif selection.platform == 'posix':
        resource = PosixResource(selection, expected_root_stamp)
    elif selection.platform == 'win32':
        from music_app.services._rooted_local_file_windows import WindowsBackend
        resource = WindowsBackend().acquire(selection, expected_root_stamp)
    else:
        raise RootedFileUnavailable('platform_unavailable')
    try:
        return RootedRegularFile(resource)
    except BaseException:
        resource.close()
        raise


def describe_root(selection, *, backend=None):
    """Comparison only, never an authorization grant or persistent open lease."""
    if type(selection) is not RootSelection:
        raise RootedFileUnavailable('source_invalid')
    if backend is not None:
        return backend.describe_root(selection)
    if selection.platform == 'win32':
        from music_app.services._rooted_local_file_windows import WindowsBackend
        return WindowsBackend().describe_root(selection)
    _require_posix()
    root = _posix_selection(selection)
    with ExitStack() as stack:
        chain = PosixDirectoryChain(stack, root)
        device, inode = _directory_identity(os.fstat(chain.fd))
        chain.check()
        return PosixRootStamp('posix', device, inode)


def _posix_root_observation_selection(selection):
    if (type(selection) is not RootObservationSelection
            or type(selection.platform) is not str
            or selection.platform != 'posix'
            or type(selection.root_path) is not str):
        raise RootedFileUnavailable('source_invalid')
    text = selection.root_path
    if len(text) > 8192:
        raise RootedFileUnavailable('source_invalid')
    try:
        encoded = text.encode('utf-8')
    except UnicodeError:
        raise RootedFileUnavailable('source_invalid') from None
    if (not text.startswith('/') or text.startswith('//') or '\x00' in text
            or len(encoded) > 8192):
        raise RootedFileUnavailable('source_invalid')
    parts = [] if text == '/' else text.split('/')[1:]
    if len(parts) > 256 or any(not part or part in ('.', '..') for part in parts):
        raise RootedFileUnavailable('source_invalid')
    return PurePosixPath(text)


def observe_root(selection, *, operation_context):
    """Bounded root-only observation; no leaf identity or authority is implied."""
    root = _posix_root_observation_selection(selection)
    _require_posix()
    with ExitStack() as stack:
        chain = PosixDirectoryChain(stack, root,
                                    operation_context=operation_context)
        chain.check()
        if operation_context is not None:
            operation_context.before_syscall()
        device, inode = _directory_identity(os.fstat(chain.fd))
        return PosixRootStamp('posix', device, inode)


class _SingleReleaseJob:
    """Shared decision and single-release owner with fixed optional policies.

    Only an original executor worker releases after dequeue/discard or completed
    delivery/cleanup. Even a submit exception can mean the job was enqueued: the
    caller abandons but never releases uncertain capacity or cancels the Future.
    The probe adapter alone enables deadline-at-claim and cleanup quarantine;
    acquisition keeps its original defaults and lease disposal policy.
    """
    def __init__(self, release, *, deadline=None, clock=None,
                 quarantine_cleanup=False):
        self._release_slot = release
        self._condition = threading.Condition()
        self.completed = threading.Event()
        self._decision = None
        self._factory_started = False
        self._released = False
        self._result = None
        self._error = None
        self.cleanup_error = None
        self._deadline = deadline
        self._clock = time.monotonic if clock is None else clock
        self._quarantine_cleanup = quarantine_cleanup
        self._quarantined = False

    def _expire_locked(self):
        if self._deadline is None or self._clock() < self._deadline:
            return False
        if self._decision is None:
            self._decision = 'abandoned'
            self._condition.notify_all()
        return True

    def start_work(self):
        with self._condition:
            if self._expire_locked() or self._decision == 'abandoned':
                return False
            # Shared linearization point: later abandonment is in-flight.
            self._factory_started = True
            return True

    def check_active(self):
        with self._condition:
            return not self._expire_locked() and self._decision is None

    def is_abandoned(self):
        with self._condition:
            return self._decision == 'abandoned'

    def is_quarantined(self):
        with self._condition:
            return self._quarantined

    def report_cleanup_failure(self, error=None):
        with self._condition:
            self.cleanup_error = error
            if self._quarantine_cleanup:
                self._quarantined = True

    def release_once(self):
        with self._condition:
            if self._released or self._quarantined:
                return
            if self._quarantine_cleanup and self._decision is None:
                # The probe policy cannot release completed-but-unclaimed or
                # otherwise undecided ownership. Legacy behavior is unchanged.
                return
            self._released = True
        self._release_slot()

    def wait(self, timeout):
        return self.completed.wait(timeout)

    def claim(self):
        with self._condition:
            if self._expire_locked():
                raise RootedFileUnavailable('artwork_probe_timeout')
            if not self.completed.is_set() or self._decision is not None:
                raise RootedFileUnavailable('acquisition_claim_invalid')
            self._decision = 'claimed'
            result, error = self._result, self._error
            self._condition.notify_all()
        if error is not None:
            raise error
        return result

    def abandon(self):
        with self._condition:
            if self._decision is not None:
                return False
            self._decision = 'abandoned'
            self._condition.notify_all()
            return True

    def publish_and_wait(self, result, error=None):
        """Called only by the worker to await the synchronized caller decision.

        Return whether the result was claimed. Probe cleanup must finish first;
        a quarantined probe publishes its bounded failure, never a success. The
        legacy adapter retains its lease until delivery or abandoned disposal.
        This owner knows neither the probe result schema nor resource I/O.
        """
        with self._condition:
            self._expire_locked()
            self._result, self._error = result, error
            self.completed.set()
            while self._decision is None:
                self._condition.wait()
            return self._decision == 'claimed'


class _AcquisitionJob(_SingleReleaseJob):
    """Legacy lease adapter; deadline and cleanup quarantine remain disabled."""

    def run(self, factory, selection, expected_root_stamp):
        try:
            if not self.start_work():
                # Dequeue proves this retained queue entry can release capacity.
                return
            try:
                lease = factory(selection, expected_root_stamp)
                error = None
            except BaseException as caught:
                lease, error = None, caught
            if not self.publish_and_wait(lease, error) and lease is not None:
                # Same bounded acquisition worker, still owning its slot.
                try:
                    lease.close()
                except BaseException as caught:
                    self.report_cleanup_failure(caught)
                    raise
        finally:
            self.release_once()


class AcquisitionBudget:
    """Explicitly instantiated off-loop owner, two workers plus four queued.

    A timeout abandons delivery, not native execution. Hung workers keep their
    slots forever; no replacement thread or native cancellation is attempted.
    Caller must not call this blocking method on an event-loop thread.
    Factory must return a newly acquired, unshared lease with no external reader
    reservations; the budget owns it exclusively until the caller claims it.
    """
    def __init__(self, executor=None):
        from concurrent.futures import ThreadPoolExecutor
        self._executor = executor or ThreadPoolExecutor(max_workers=2,
            thread_name_prefix='rooted-source')
        self._slots = threading.BoundedSemaphore(6)

    def acquire(self, selection, expected_root_stamp=None, *, timeout=2.0,
                factory=acquire):
        if type(timeout) not in (int, float) or not 0 <= timeout <= 2:
            raise RootedFileUnavailable('acquisition_deadline_invalid')
        if not self._slots.acquire(blocking=False):
            raise RootedFileUnavailable('acquisition_busy')
        job = _AcquisitionJob(self._slots.release)
        try:
            self._executor.submit(job.run, factory, selection, expected_root_stamp)
        except BaseException:
            # ThreadPoolExecutor may enqueue before thread creation raises.
            # Generic exceptions do not prove rejection. Keep the slot until a
            # worker actually discards/cleans the job; if none ever does, this is
            # bounded capacity loss. Never replace that budget to recover it.
            job.abandon()
            raise
        try:
            if not job.wait(timeout):
                raise RootedFileUnavailable('acquisition_deadline') from None
            return job.claim()
        except BaseException:
            # Do not cancel a queued Future: cancellation does not remove the
            # executor's retained work item, so it cannot justify a slot release.
            job.abandon()
            raise
