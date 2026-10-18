"""W1 synthetic ownership regressions; no filesystem/native fault is claimed.

Only inert Python objects and bounded, event-controlled workers are used. This
module never loads an app/config, constructs a native binding, or retries an
uncertain raw handle. Execution requires its own root-approved isolated gate.
"""
import gc
import importlib
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import weakref

import pytest


def _checkout_imports():
    here = Path(__file__).resolve(strict=True)
    if here.parts[-3:] != ('tests', 'py', 'test_rooted_cleanup_ownership.py'):
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
WAIT = 5


class FaultStream:
    """No destructor: synthetic disposal does not imply retryable ownership."""
    def __init__(self, fault='success'):
        self.fault = fault
        self.closed = False
        self.close_calls = []
        self.position = 0
        self.on_read = lambda: None

    def close(self):
        self.close_calls.append(threading.get_ident())
        if self.fault == 'before':
            raise OSError('synthetic stream close before disposal')
        self.closed = True
        if self.fault == 'after':
            raise OSError('synthetic stream close after disposal')

    def read(self, count=-1):
        self.on_read()
        assert not self.closed
        data = b'abcdef'[self.position:]
        result = data if count < 0 else data[:count]
        self.position += len(result)
        return result

    def readinto(self, target):
        result = self.read(len(target))
        target[:len(result)] = result
        return len(result)

    def seek(self, offset, whence=0):
        assert not self.closed
        self.position = {0: 0, 1: self.position, 2: 6}[whence] + offset
        return self.position

    def tell(self):
        return self.position

    def writable(self):
        return False

    def fileno(self):
        return 700  # Inert borrowed number; never passed to an OS API.


class Resource:
    def __init__(self, close_fault='success', reader_fault='success'):
        self._cleanup_domain = rooted._CleanupDomain()
        self.observation = SimpleNamespace(platform='posix', size=6)
        self.root_stamp = ('synthetic', 1, 2)
        self.name = 'song.flac'
        self.original_suffix = '.flac'
        self.close_fault = close_fault
        self.reader_fault = reader_fault
        self.closed = False
        self.close_calls = []
        self.readers = []
        self.checks = 0
        self.on_check = lambda: None

    def check(self):
        self.checks += 1
        self.on_check()

    def reader(self):
        stream = FaultStream(self.reader_fault)
        self.readers.append(stream)
        return stream

    def close(self):
        self.close_calls.append(threading.get_ident())
        if self.close_fault == 'before':
            raise OSError('synthetic resource close before disposal')
        self.closed = True
        if self.close_fault == 'after':
            raise OSError('synthetic resource close after disposal')


def opened(**kwargs):
    resource = Resource(**kwargs)
    return rooted.RootedRegularFile(resource), resource


def assert_no_new_work(lease):
    for action in (lease.check, lease.independent_reader, lease.reserve_child_use):
        with pytest.raises(rooted.RootedFileUnavailable):
            action()


def repeated_close(action):
    """Terminal close may report its bounded state, but must not retry I/O."""
    try:
        action()
    except rooted.RootedFileUnavailable as error:
        assert str(error) == 'source_cleanup_incomplete'


@pytest.mark.parametrize('fault', ['success', 'before', 'after'])
def test_resource_close_requires_positive_confirmation_and_never_retries(fault):
    lease, resource = opened(close_fault=fault)
    if fault == 'success':
        lease.close()
    else:
        with pytest.raises(OSError, match='synthetic resource close'):
            lease.close()
    assert lease.drained.is_set() is (fault == 'success')
    assert resource.closed is (fault != 'before')
    assert len(resource.close_calls) == 1
    assert_no_new_work(lease)
    repeated_close(lease.close)
    repeated_close(lease.close)
    assert len(resource.close_calls) == 1
    assert lease.drained.is_set() is (fault == 'success')


@pytest.mark.parametrize('fault', ['before', 'after'])
def test_reader_close_uncertainty_keeps_stream_and_reservation(fault):
    lease, resource = opened(reader_fault=fault)
    reader = lease.independent_reader()
    stream = resource.readers[0]
    ticket = reader._ticket
    with pytest.raises(OSError, match='synthetic stream close'):
        reader.close()
    assert reader.closed and stream.closed is (fault == 'after')
    assert reader._ticket is ticket and ticket.owner is lease
    assert lease._active == lease._readers == 1
    assert not lease.drained.is_set() and not resource.close_calls
    assert_no_new_work(lease)
    with pytest.raises(rooted.RootedFileUnavailable, match='reader_closed'):
        reader.read(1)
    repeated_close(reader.close)
    repeated_close(lease.close)
    assert len(stream.close_calls) == 1
    assert lease._active == lease._readers == 1
    assert not lease.drained.is_set() and not resource.close_calls


@pytest.mark.parametrize('boundary', ['postcheck', 'wrapper'])
@pytest.mark.parametrize('fault', ['success', 'before', 'after'])
def test_unpublished_stream_retains_primary_error_and_cleanup_ticket(monkeypatch, boundary, fault):
    lease, resource = opened(reader_fault=fault)
    primary = RuntimeError('synthetic unpublished operation failure')
    if boundary == 'postcheck':
        def check():
            if resource.checks == 2:
                raise primary
        resource.on_check = check
    else:
        def fail_wrapper(*args):
            raise primary
        monkeypatch.setattr(rooted, 'OwnedReader', fail_wrapper)
    with pytest.raises(RuntimeError) as caught:
        lease.independent_reader()
    assert caught.value is primary
    stream = resource.readers[0]
    assert len(stream.close_calls) == 1
    assert stream.closed is (fault != 'before')
    assert lease._active == lease._readers == (0 if fault == 'success' else 1)
    assert_no_new_work(lease)
    repeated_close(lease.close)
    repeated_close(lease.close)
    assert len(stream.close_calls) == 1
    assert lease.drained.is_set() is (fault == 'success')
    assert len(resource.close_calls) == (1 if fault == 'success' else 0)


def test_safe_readers_finish_after_one_reader_becomes_uncertain():
    lease, resource = opened()
    failed = lease.independent_reader()
    safe = [lease.independent_reader() for _ in range(3)]
    resource.readers[0].fault = 'after'
    with pytest.raises(OSError):
        failed.close()
    assert_no_new_work(lease)
    for reader in safe:
        reader.close()
    repeated_close(lease.close)
    assert lease._active == lease._readers == 1
    assert not lease.drained.is_set() and not resource.close_calls
    assert all(len(stream.close_calls) == 1 for stream in resource.readers)


def test_four_reader_bound_and_child_ticket_until_confirmed_reap():
    lease, resource = opened()
    readers = [lease.independent_reader() for _ in range(4)]
    with pytest.raises(rooted.RootedFileUnavailable, match='reader_limit'):
        lease.independent_reader()
    assert lease.check() is resource.observation
    child = lease.reserve_child_use()
    lease.close()
    for reader in readers:
        reader.close()
    assert lease._active == 1 and lease._readers == 0
    assert not resource.close_calls and not lease.drained.is_set()
    child.close()  # Synthetic confirmed reap, never successful spawn alone.
    child.close()
    assert lease.drained.is_set() and len(resource.close_calls) == 1


def test_simultaneous_close_and_final_reservation_release_dispose_once():
    lease, resource = opened()
    child = lease.reserve_child_use()
    barrier = threading.Barrier(3)
    errors = []
    def run(action):
        try:
            barrier.wait(WAIT)
            action()
        except BaseException as error:
            errors.append(error)
    closer = threading.Thread(target=run, args=(lease.close,), daemon=True)
    reaper = threading.Thread(target=run, args=(child.close,), daemon=True)
    closer.start()
    reaper.start()
    barrier.wait(WAIT)
    closer.join(WAIT)
    reaper.join(WAIT)
    assert not closer.is_alive() and not reaper.is_alive() and not errors
    assert lease.drained.is_set() and len(resource.close_calls) == 1
    lease.close()
    child.close()
    assert len(resource.close_calls) == 1


def test_close_during_blocked_check_is_prompt_and_cannot_signal_drained():
    lease, resource = opened()
    entered, release = threading.Event(), threading.Event()
    errors = []
    def block():
        entered.set()
        assert release.wait(WAIT)
    def run():
        try:
            lease.check()
        except BaseException as error:
            errors.append(error)
    resource.on_check = block
    close_returned = threading.Event()
    def request_close():
        try:
            lease.close()
        except BaseException as error:
            errors.append(error)
        finally:
            close_returned.set()
    worker = threading.Thread(target=run, daemon=True)
    closer = threading.Thread(target=request_close, daemon=True)
    worker.start()
    try:
        assert entered.wait(WAIT)
        closer.start()
        assert close_returned.wait(WAIT), 'logical close blocked behind native check'
        assert not lease.drained.is_set() and not resource.close_calls
        assert lease._active == 1
        assert_no_new_work(lease)
    finally:
        release.set()
        worker.join(WAIT)
        if closer.ident is not None:
            closer.join(WAIT)
    assert not worker.is_alive() and not closer.is_alive()
    assert len(errors) == 1 and str(errors[0]) == 'source_closed'
    assert lease.drained.is_set() and resource.close_calls == [worker.ident]


def test_reader_gate_excludes_physical_close_during_blocked_read():
    lease, resource = opened()
    reader = lease.independent_reader()
    stream = resource.readers[0]
    entered, release, close_started = (threading.Event() for _ in range(3))
    output, errors = [], []
    def blocked():
        entered.set()
        assert release.wait(WAIT)
    def read():
        try:
            output.append(reader.read(1))
        except BaseException as error:
            errors.append(error)
    def close():
        close_started.set()
        try:
            reader.close()
        except BaseException as error:
            errors.append(error)
    stream.on_read = blocked
    reading = threading.Thread(target=read, daemon=True)
    closing = threading.Thread(target=close, daemon=True)
    reading.start()
    try:
        assert entered.wait(WAIT)
        closing.start()
        assert close_started.wait(WAIT)
        lease.close()
        assert not stream.close_calls and not resource.close_calls
        assert not lease.drained.is_set() and lease._active == 1
    finally:
        release.set()
        reading.join(WAIT)
        if closing.ident is not None:
            closing.join(WAIT)
    assert not reading.is_alive() and not closing.is_alive()
    assert output == [b'a'] and not errors
    assert stream.close_calls == resource.close_calls == [closing.ident]
    assert lease.drained.is_set()


class CountingSlots:
    def __init__(self):
        self.semaphore = threading.BoundedSemaphore(6)
        self.releases = []
        self.lock = threading.Lock()

    def acquire(self, *, blocking):
        return self.semaphore.acquire(blocking=blocking)

    def release(self):
        with self.lock:
            self.releases.append(threading.get_ident())
        self.semaphore.release()

    def available(self):
        count = 0
        while self.semaphore.acquire(blocking=False):
            count += 1
        for _ in range(count):
            self.semaphore.release()
        return count


class QueueExecutor:
    """Exactly two original controlled workers; no replacement or cancellation."""
    def __init__(self):
        self.condition = threading.Condition()
        self.entries, self.futures, self.threads = [], [], []
        self.allowed = False
        self.stopping = False
        self.submissions = 0

    def submit(self, function, *args):
        from concurrent.futures import Future
        future = Future()
        with self.condition:
            self.submissions += 1
            self.entries.append((future, function, args))
            self.futures.append(future)
            if len(self.threads) < 2:
                worker = threading.Thread(target=self._run, daemon=True)
                self.threads.append(worker)
                worker.start()
            self.condition.notify_all()
        return future

    def start(self):
        with self.condition:
            self.allowed = True
            self.condition.notify_all()

    def _run(self):
        while True:
            with self.condition:
                while (not self.entries or not self.allowed) and not self.stopping:
                    self.condition.wait()
                if not self.entries:
                    return
                if not self.allowed:
                    return
                future, function, args = self.entries.pop(0)
            assert future.set_running_or_notify_cancel(), 'product cancelled retained work'
            try:
                result = function(*args)
            except BaseException as error:
                future.set_exception(error)
            else:
                future.set_result(result)
            finally:
                # Prevent executor locals from being the test's GC retention oracle.
                future = function = args = result = None

    def join(self):
        with self.condition:
            self.stopping = True
            self.allowed = True
            self.condition.notify_all()
        for worker in self.threads:
            worker.join(WAIT)
            assert not worker.is_alive()


def make_budget(executor):
    budget = rooted.AcquisitionBudget(executor)
    budget._slots = CountingSlots()
    return budget


def test_abandoned_never_started_job_releases_only_on_original_dequeue(monkeypatch):
    executor = QueueExecutor()
    budget = make_budget(executor)
    jobs, calls = [], []
    def timeout(job, _timeout):
        jobs.append(job)
        return False
    def forbidden(*args):
        calls.append(args)
        raise AssertionError('never-started abandoned factory ran')
    monkeypatch.setattr(rooted._AcquisitionJob, 'wait', timeout)
    try:
        with pytest.raises(rooted.RootedFileUnavailable, match='acquisition_deadline'):
            budget.acquire(None, timeout=0, factory=forbidden)
        assert budget._slots.available() == 5 and not budget._slots.releases
        assert not executor.futures[0].cancelled() and not jobs[0]._factory_started
        executor.start()
        assert executor.futures[0].result(timeout=WAIT) is None
    finally:
        executor.join()
    assert not calls
    assert len(budget._slots.releases) == 1
    assert budget._slots.releases[0] in [worker.ident for worker in executor.threads]
    assert budget._slots.releases[0] != threading.get_ident()
    jobs[0].release_once()
    assert budget._slots.available() == 6 and len(budget._slots.releases) == 1


@pytest.mark.parametrize('boundary', ['during_factory', 'completed_before_claim'])
@pytest.mark.parametrize('fault', ['success', 'before', 'after'])
def test_abandoned_lease_cleanup_remains_on_original_worker(monkeypatch, boundary, fault):
    executor = QueueExecutor()
    budget = make_budget(executor)
    factory_entered, factory_release, cleanup_entered, cleanup_release = (
        threading.Event() for _ in range(4))
    lease, resource = opened(close_fault=fault)
    original_close = resource.close
    jobs = []
    def controlled_close():
        cleanup_entered.set()
        assert cleanup_release.wait(WAIT)
        original_close()
    resource.close = controlled_close
    def factory(*args):
        factory_entered.set()
        assert factory_release.wait(WAIT)
        return lease
    def timeout(job, _timeout):
        jobs.append(job)
        executor.start()
        assert factory_entered.wait(WAIT)
        if boundary == 'completed_before_claim':
            factory_release.set()
            assert job.completed.wait(WAIT)
            assert not cleanup_entered.is_set() and not budget._slots.releases
        return False
    monkeypatch.setattr(rooted._AcquisitionJob, 'wait', timeout)
    try:
        with pytest.raises(rooted.RootedFileUnavailable, match='acquisition_deadline'):
            budget.acquire(None, timeout=0, factory=factory)
        assert not budget._slots.releases
        factory_release.set()
        assert cleanup_entered.wait(WAIT)
        assert jobs[0].is_abandoned() and jobs[0].abandon() is False
        assert budget._slots.available() == 5
        assert not lease.drained.is_set() and not budget._slots.releases
    finally:
        factory_release.set()
        cleanup_release.set()
        executor.join()
    job = jobs[0]
    assert len(resource.close_calls) == 1
    worker_id = resource.close_calls[0]
    assert worker_id in [worker.ident for worker in executor.threads]
    assert worker_id != threading.get_ident()
    assert job.is_quarantined() is (fault != 'success')
    assert lease.drained.is_set() is (fault == 'success')
    assert budget._slots.releases == ([worker_id] if fault == 'success' else [])
    assert budget._slots.available() == (6 if fault == 'success' else 5)
    job.release_once()
    repeated_close(lease.close)
    assert len(resource.close_calls) == 1
    assert budget._slots.releases == ([worker_id] if fault == 'success' else [])


def test_clean_factory_error_preserves_identity_and_releases_original_worker(monkeypatch):
    executor = QueueExecutor()
    budget = make_budget(executor)
    primary = RuntimeError('synthetic clean factory rejection')
    def fail(*args):
        raise primary
    def wait(job, timeout):
        executor.start()
        return job.completed.wait(WAIT)
    monkeypatch.setattr(rooted._AcquisitionJob, 'wait', wait)
    try:
        with pytest.raises(RuntimeError) as caught:
            budget.acquire(None, factory=fail)
        assert caught.value is primary
    finally:
        executor.join()
    assert len(budget._slots.releases) == 1 and budget._slots.available() == 6
    assert budget._slots.releases[0] in [worker.ident for worker in executor.threads]
    assert budget._slots.releases[0] != threading.get_ident()


def test_successful_claim_releases_acquisition_slot_before_later_close_failure(monkeypatch):
    executor = QueueExecutor()
    budget = make_budget(executor)
    resource = Resource(close_fault='after')
    created, jobs = [], []
    def factory(*args):
        lease = rooted.RootedRegularFile(resource)
        created.append(lease)
        return lease
    def wait(job, timeout):
        jobs.append(job)
        executor.start()
        return job.completed.wait(WAIT)
    monkeypatch.setattr(rooted._AcquisitionJob, 'wait', wait)
    try:
        lease = budget.acquire(None, factory=factory)
        assert lease is created[0]
    finally:
        executor.join()
    assert budget._slots.available() == 6 and len(budget._slots.releases) == 1
    assert not resource.close_calls and jobs[0]._decision == 'claimed'
    release_thread = budget._slots.releases[0]
    with pytest.raises(OSError):
        lease.close()
    jobs[0].release_once()
    repeated_close(lease.close)
    assert budget._slots.releases == [release_thread]
    assert budget._slots.available() == 6  # No retroactive reacquire.
    assert len(resource.close_calls) == 1 and not lease.drained.is_set()


@pytest.mark.parametrize('mode', ['before_enqueue', 'accepted_then_raise'])
def test_uncertain_submission_retains_capacity_until_original_dequeue(mode):
    calls = []
    class Rejected:
        def submit(self, function, *args):
            self.job_ref = weakref.ref(function.__self__)
            if mode == 'accepted_then_raise':
                self.entry = (function, args)
            raise RuntimeError('synthetic uncertain submit')
    executor = Rejected()
    budget = make_budget(executor)
    def forbidden(*args):
        calls.append(args)
        raise AssertionError('abandoned queue must not construct')
    with pytest.raises(RuntimeError, match='synthetic uncertain submit'):
        budget.acquire(None, factory=forbidden)
    assert budget._slots.available() == 5 and not budget._slots.releases
    gc.collect()
    assert executor.job_ref() is not None
    assert executor.job_ref().is_abandoned()
    if mode == 'accepted_then_raise':
        errors = []
        def original_dequeue():
            try:
                function, args = executor.entry
                function(*args)
            except BaseException as error:
                errors.append(error)
        worker = threading.Thread(target=original_dequeue, daemon=True)
        worker.start()
        worker.join(WAIT)
        assert not worker.is_alive() and not errors
        assert budget._slots.releases == [worker.ident]
        assert budget._slots.available() == 6
    else:
        assert budget._slots.available() == 5 and not budget._slots.releases
    assert not calls


@pytest.mark.parametrize('fault', ['success', 'before', 'after'])
def test_submit_running_then_raise_preserves_worker_cleanup_owner(fault):
    entered, factory_release, cleanup_entered, cleanup_release = (
        threading.Event() for _ in range(4))
    lease, resource = opened(close_fault=fault)
    original_close = resource.close
    errors = []
    def close():
        cleanup_entered.set()
        assert cleanup_release.wait(WAIT)
        original_close()
    resource.close = close
    class RunningThenRaises:
        def submit(self, function, *args):
            self.job = function.__self__
            def run():
                try:
                    function(*args)
                except BaseException as error:
                    errors.append(error)
            self.worker = threading.Thread(target=run, daemon=True)
            self.worker.start()
            assert entered.wait(WAIT)
            raise RuntimeError('synthetic accepted worker submit failure')
    executor = RunningThenRaises()
    budget = make_budget(executor)
    def factory(*args):
        entered.set()
        assert factory_release.wait(WAIT)
        return lease
    try:
        with pytest.raises(RuntimeError, match='synthetic accepted worker'):
            budget.acquire(None, factory=factory)
        assert executor.job._factory_started and executor.job.is_abandoned()
        assert not budget._slots.releases and not resource.close_calls
        factory_release.set()
        assert cleanup_entered.wait(WAIT)
        assert budget._slots.available() == 5 and not budget._slots.releases
    finally:
        factory_release.set()
        cleanup_release.set()
        executor.worker.join(WAIT)
    assert not executor.worker.is_alive()
    assert resource.close_calls == [executor.worker.ident]
    assert executor.job.is_quarantined() is (fault != 'success')
    assert budget._slots.releases == ([executor.worker.ident] if fault == 'success' else [])
    if fault == 'success':
        assert not errors
    else:
        assert len(errors) == 1 and isinstance(errors[0], OSError)


@pytest.mark.parametrize('decision', ['claim', 'abandon', 'expired_claim'])
def test_shared_probe_job_keeps_original_decision_and_release_policy(decision):
    now, releases, outcomes = [0.0], [], []
    result = object()
    job = rooted._SingleReleaseJob(lambda: releases.append(threading.get_ident()),
        deadline=10.0, clock=lambda: now[0], quarantine_cleanup=True)
    job.release_once()
    assert not releases
    def work():
        assert job.start_work()
        outcomes.append(job.publish_and_wait(result))
        job.release_once()
        job.release_once()
    worker = threading.Thread(target=work, daemon=True)
    worker.start()
    try:
        assert job.completed.wait(WAIT)
        assert not releases
        if decision == 'claim':
            assert job.claim() is result
            assert job.abandon() is False
        elif decision == 'abandon':
            assert job.abandon() is True and job.abandon() is False
        else:
            with job._condition:
                now[0] = 10.0
                with pytest.raises(rooted.RootedFileUnavailable, match='artwork_probe_timeout'):
                    job.claim()
            assert job.is_abandoned()
    finally:
        job.abandon()
        worker.join(WAIT)
    assert not worker.is_alive()
    assert outcomes == [decision == 'claim'] and releases == [worker.ident]


@pytest.mark.parametrize('decision', ['claim', 'abandon'])
def test_shared_probe_cleanup_quarantine_never_releases(decision):
    releases, outcomes = [], []
    result = object()
    job = rooted._SingleReleaseJob(lambda: releases.append(threading.get_ident()),
                                  quarantine_cleanup=True)
    failure = OSError('synthetic probe cleanup uncertainty')
    def work():
        assert job.start_work()
        job.report_cleanup_failure(failure)
        outcomes.append(job.publish_and_wait(result))
        job.release_once()
    worker = threading.Thread(target=work, daemon=True)
    worker.start()
    try:
        assert job.completed.wait(WAIT)
        assert job.is_quarantined() and job.cleanup_error is failure
        if decision == 'claim':
            assert job.claim() is result  # Generic owner does not invent a result schema.
        else:
            assert job.abandon()
    finally:
        job.abandon()
        worker.join(WAIT)
    job.release_once()
    assert not worker.is_alive() and not releases
    assert outcomes == [decision == 'claim']


class PartialNative:
    """Actual WindowsBackend acquisition with inert partial ownership only."""
    def __init__(self, fault='before', pending=False):
        self.quarantined = False
        self.fault = fault
        self.pending_mode = pending
        self.storage = SimpleNamespace(label='synthetic pending storage')
        self.pending = None
        self.handles = {100: 'bootstrap'}
        self.opens = 0
        self.close_calls = []
        self.disposed = False
        self.failure = RuntimeError('original partial native factory failure')

    def volume_guid(self, drive_root):
        return '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\'

    def query_dos_device(self, alias):
        text = '\\Device\\HarddiskVolume23\0\0'
        return windows.MultiString(text, len(text.encode('utf-16-le')) // 2, 32768)

    def open(self, request):
        self.opens += 1
        assert self.opens == 1
        return windows.NativeOpenResult(100,
            windows.STATUS_PENDING if self.pending_mode else 0,
            windows.STATUS_PENDING if self.pending_mode else 0,
            0 if self.pending_mode else 1, not self.pending_mode, self.storage)

    def info(self, handle):
        raise self.failure

    def close(self, handle):
        assert handle == 100
        self.close_calls.append(threading.get_ident())
        assert len(self.close_calls) == 1
        if self.fault == 'before':
            raise OSError('synthetic partial close before disposal')
        self.handles.clear()
        self.disposed = True
        if self.fault == 'after':
            raise OSError('synthetic partial close after disposal')

    def quarantine(self, result):
        self.quarantined = True
        self.pending = result
        raise windows.WindowsNativePending('synthetic pending retains ownership')


@pytest.mark.parametrize('fault', ['success', 'before', 'after'])
def test_factory_partial_windows_error_reports_cleanup_separately(monkeypatch, fault):
    executor = QueueExecutor()
    budget = make_budget(executor)
    native = PartialNative(fault)
    backend = windows.WindowsBackend(native)
    jobs = []
    def wait(job, timeout):
        jobs.append(job)
        executor.start()
        return job.completed.wait(WAIT)
    def factory(selection, stamp):
        return rooted.acquire(selection, stamp, backend=backend)
    monkeypatch.setattr(rooted._AcquisitionJob, 'wait', wait)
    selection = rooted.RootSelection('win32', 'C:\\Music', ('song.flac',))
    try:
        with pytest.raises(RuntimeError) as caught:
            budget.acquire(selection, factory=factory)
        assert caught.value is native.failure
    finally:
        executor.join()
    job = jobs[0]
    assert native.close_calls and len(native.close_calls) == 1
    assert native.close_calls[0] in [worker.ident for worker in executor.threads]
    assert native.disposed is (fault != 'before')
    assert job.is_quarantined() is (fault != 'success')
    assert backend._cleanup_domain.is_blocked() is (fault != 'success')
    assert budget._slots.releases == (native.close_calls if fault == 'success' else [])
    assert budget._slots.available() == (6 if fault == 'success' else 5)
    if fault != 'success':
        assert job in budget._jobs and job in budget._quarantined
        assert backend._cleanup_domain._owners


@pytest.mark.parametrize('kind', ['before', 'after', 'pending'])
def test_six_strongly_retained_uncertain_jobs_exhaust_fixed_budget(monkeypatch, kind):
    executor = QueueExecutor()
    budget = make_budget(executor)
    weak_jobs, weak_natives, weak_domains, close_ledgers = [], [], [], []
    selection = rooted.RootSelection('win32', 'C:\\Music', ('song.flac',))
    def wait(job, timeout):
        weak_jobs.append(weakref.ref(job))
        executor.start()
        return job.completed.wait(WAIT)
    monkeypatch.setattr(rooted._AcquisitionJob, 'wait', wait)
    def factory(selection, stamp):
        native = PartialNative(kind if kind != 'pending' else 'before', pending=kind == 'pending')
        backend = windows.WindowsBackend(native)
        weak_natives.append(weakref.ref(native))
        weak_domains.append(weakref.ref(backend._cleanup_domain))
        close_ledgers.append(native.close_calls)
        return rooted.acquire(selection, stamp, backend=backend)
    try:
        for _ in range(6):
            expected = windows.WindowsNativePending if kind == 'pending' else RuntimeError
            with pytest.raises(expected):
                budget.acquire(selection, factory=factory)
        for _ in range(4):
            with pytest.raises(rooted.RootedFileUnavailable, match='acquisition_busy'):
                budget.acquire(selection, timeout=0, factory=factory)
    finally:
        executor.join()
    assert executor.submissions == len(executor.futures) == 6
    assert len(executor.threads) == 2 and not executor.entries
    assert all(future.done() and not future.cancelled() for future in executor.futures)
    executor.futures.clear()  # A discarded Future is not the ownership registry.
    gc.collect()
    assert len(budget._jobs) == len(budget._quarantined) == 6
    assert all(ref() is not None and ref() in budget._jobs for ref in weak_jobs)
    assert all(ref() is not None for ref in weak_natives + weak_domains)
    assert all(ref().is_blocked() and ref()._owners for ref in weak_domains)
    assert not budget._slots.releases and budget._slots.available() == 0
    for ref in weak_jobs:
        assert ref().is_quarantined()
        ref().release_once()
    assert not budget._slots.releases
    assert all(len(calls) == (0 if kind == 'pending' else 1) for calls in close_ledgers)
    assert len(executor.threads) == 2 and executor.submissions == 6


def test_nothrow_resource_cleanup_incomplete_does_not_set_drained():
    lease, resource = opened()
    resource.cleanup_complete = False
    with pytest.raises(rooted.RootedFileUnavailable, match='cleanup'):
        lease.close()
    assert resource.closed and len(resource.close_calls) == 1
    assert not lease.drained.is_set()
    assert_no_new_work(lease)
    repeated_close(lease.close)
    assert not lease.drained.is_set() and len(resource.close_calls) == 1


def test_nothrow_abandoned_lease_with_incomplete_cleanup_keeps_slot(monkeypatch):
    executor = QueueExecutor()
    budget = make_budget(executor)
    calls, jobs = [], []
    class Lease:
        cleanup_complete = False
        def close(self):
            calls.append(threading.get_ident())
    lease = Lease()
    def timeout(job, timeout):
        jobs.append(job)
        executor.start()
        assert job.completed.wait(WAIT)
        return False
    monkeypatch.setattr(rooted._AcquisitionJob, 'wait', timeout)
    try:
        with pytest.raises(rooted.RootedFileUnavailable, match='acquisition_deadline'):
            budget.acquire(None, timeout=0, factory=lambda *_: lease)
    finally:
        executor.join()
    assert len(calls) == 1 and calls[0] in [worker.ident for worker in executor.threads]
    assert jobs[0].is_quarantined() and jobs[0] in budget._jobs
    assert jobs[0] in budget._quarantined
    assert not budget._slots.releases and budget._slots.available() == 5
    jobs[0].release_once()
    assert not budget._slots.releases and len(calls) == 1


def test_claimed_lease_failure_before_worker_release_still_releases_acquisition_once(monkeypatch):
    executor = QueueExecutor()
    budget = make_budget(executor)
    release_entered, allow_release = threading.Event(), threading.Event()
    jobs, resources = [], []
    original_release = rooted._AcquisitionJob.release_once
    def paused_release(job):
        release_entered.set()
        assert allow_release.wait(WAIT)
        original_release(job)
    def factory(*args):
        resource = Resource(close_fault='after')
        resources.append(resource)
        return rooted.RootedRegularFile(resource)
    def wait(job, timeout):
        jobs.append(job)
        executor.start()
        return job.completed.wait(WAIT)
    monkeypatch.setattr(rooted._AcquisitionJob, 'wait', wait)
    monkeypatch.setattr(rooted._AcquisitionJob, 'release_once', paused_release)
    try:
        lease = budget.acquire(None, factory=factory)
        assert release_entered.wait(WAIT)
        assert budget._slots.available() == 5 and not budget._slots.releases
        with pytest.raises(OSError):
            lease.close()
        assert jobs[0].is_quarantined() and jobs[0] in budget._quarantined
        assert budget._slots.available() == 5 and not budget._slots.releases
    finally:
        allow_release.set()
        executor.join()
    assert len(budget._slots.releases) == 1 and budget._slots.available() == 6
    assert budget._slots.releases[0] in [worker.ident for worker in executor.threads]
    assert budget._slots.releases[0] != threading.get_ident()
    original_release(jobs[0])
    repeated_close(lease.close)
    assert len(resources[0].close_calls) == 1 and not lease.drained.is_set()
    assert len(budget._slots.releases) == 1 and budget._slots.available() == 6


@pytest.mark.parametrize('action', ['check', 'independent_reader', 'reserve_child_use'])
def test_reservation_constructor_failure_does_not_create_phantom_use(monkeypatch, action):
    lease, resource = opened()
    primary = MemoryError('synthetic reservation construction failure')
    def fail(*args, **kwargs):
        raise primary
    monkeypatch.setattr(rooted, '_Reservation', fail)
    with pytest.raises(MemoryError) as caught:
        getattr(lease, action)()
    assert caught.value is primary
    assert lease._active == lease._readers == 0
    assert resource.checks == 0 and not resource.readers and not resource.close_calls
    lease.close()
    assert lease.drained.is_set() and len(resource.close_calls) == 1


@pytest.mark.parametrize('fault', ['success', 'before', 'after'])
def test_neutral_initial_resource_record_allocation_failure_keeps_owner(monkeypatch, fault):
    resource = Resource(close_fault=fault)
    primary = MemoryError('synthetic resource record construction failure')
    original = rooted._CleanupRecord
    def fail(owner, kind, closer, value):
        if kind == 'resource':
            raise primary
        return original(owner, kind, closer, value)
    monkeypatch.setattr(rooted, '_CleanupRecord', fail)
    with pytest.raises(MemoryError) as caught:
        rooted.RootedRegularFile(resource)
    assert caught.value is primary and len(resource.close_calls) == 1
    assert resource.closed is (fault != 'before')
    domain = resource._cleanup_domain
    assert domain.is_blocked() is (fault != 'success')
    if fault == 'success':
        assert not domain._owners
    else:
        owner, = domain._owners
        assert owner.failed and owner.subject._resource is resource
        assert not owner.complete
        resource_ref, owner_ref = weakref.ref(resource), weakref.ref(owner)
        del caught, primary, resource, owner, domain
        gc.collect()
        assert owner_ref() is not None and resource_ref() is not None
        assert len(resource_ref().close_calls) == 1


@pytest.mark.parametrize('reservation', ['reader', 'child'])
@pytest.mark.parametrize('fault', ['before', 'after'])
def test_final_reservation_release_cannot_turn_resource_close_failure_into_drained(reservation, fault):
    lease, resource = opened(close_fault=fault)
    use = lease.independent_reader() if reservation == 'reader' else lease.reserve_child_use()
    lease.close()
    assert lease._active == 1 and not resource.close_calls and not lease.drained.is_set()
    with pytest.raises(OSError, match='synthetic resource close'):
        use.close()
    assert lease._active == lease._readers == 0
    assert len(resource.close_calls) == 1 and resource.closed is (fault == 'after')
    assert not lease.drained.is_set() and not lease._disposed
    repeated_close(use.close)
    repeated_close(lease.close)
    assert len(resource.close_calls) == 1 and not lease.drained.is_set()
