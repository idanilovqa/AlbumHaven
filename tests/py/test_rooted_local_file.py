"""Synthetic lifecycle contracts; authored only, no native APIs or app startup."""
import asyncio
from io import BytesIO
import threading
from types import SimpleNamespace

import pytest

from music_app.services import rooted_local_file as rooted
from music_app.services import retained_playback_source as retained


class Resource:
    def __init__(self):
        self.observation = SimpleNamespace(platform='posix', size=6)
        self.root_stamp = ('posix', 1, 2)
        self.original_suffix = '.mp3'
        self.closed = 0
        self.changed = False
        self.readers = []
        self.on_check = lambda: None

    def check(self):
        self.on_check()
        if self.changed:
            raise rooted.RootedFileUnavailable('source_changed')

    def reader(self):
        stream = BytesIO(b'abcdef')
        self.readers.append(stream)
        return stream

    def close(self):
        self.closed += 1


def opened():
    resource = Resource()
    return rooted.RootedRegularFile(resource), resource


def test_independent_offsets_and_deferred_close():
    lease, resource = opened()
    first, second = lease.independent_reader(), lease.independent_reader()
    assert first.read(2) == b'ab'
    assert second.read(1) == b'a'
    lease.close()
    assert resource.closed == 0
    with pytest.raises(rooted.RootedFileUnavailable, match='source_closed'):
        lease.independent_reader()
    first.close()
    assert resource.closed == 0
    second.close()
    assert resource.closed == 1 and lease.drained.is_set()
    lease.close()
    second.close()
    assert resource.closed == 1


def test_failed_check_stays_failed_after_restoration():
    lease, resource = opened()
    resource.changed = True
    with pytest.raises(rooted.RootedFileUnavailable):
        lease.check()
    resource.changed = False
    with pytest.raises(rooted.RootedFileUnavailable, match='source_failed'):
        lease.check()
    lease.close()
    assert resource.closed == 1


def test_four_reader_limit_does_not_poison_existing_lease():
    lease, resource = opened()
    readers = [lease.independent_reader() for _ in range(4)]
    with pytest.raises(rooted.RootedFileUnavailable, match='reader_limit'):
        lease.independent_reader()
    assert lease.check() is resource.observation
    for reader in readers:
        reader.close()
    lease.close()


def test_child_reservation_survives_parent_reader_close_until_reap():
    lease, resource = opened()
    reader = lease.independent_reader()
    child = lease.reserve_child_use()
    reader.close()
    lease.close()
    assert resource.closed == 0
    child.close()  # Represents confirmed child reap, never successful spawn alone.
    assert resource.closed == 1
    child.close()
    assert resource.closed == 1


def test_close_state_changes_while_native_check_is_blocked():
    lease, resource = opened()
    entered, release = threading.Event(), threading.Event()
    errors = []
    def blocked():
        entered.set()
        assert release.wait(2)
    def run():
        try:
            lease.check()
        except BaseException as error:
            errors.append(error)
    resource.on_check = blocked
    worker = threading.Thread(target=run)
    worker.start()
    try:
        assert entered.wait(2)
        lease.close()
        assert resource.closed == 0
        with pytest.raises(rooted.RootedFileUnavailable, match='source_closed'):
            lease.reserve_child_use()
    finally:
        release.set()
        worker.join(2)
    assert not worker.is_alive()
    assert len(errors) == 1 and 'source_closed' in str(errors[0])
    assert resource.closed == 1


def test_reader_close_waits_for_read_without_closing_live_stream():
    lease, resource = opened()
    entered, release, close_started = threading.Event(), threading.Event(), threading.Event()
    class BlockingStream(BytesIO):
        def read(self, size=-1):
            entered.set()
            assert release.wait(2)
            assert not self.closed
            return super().read(size)
    stream = BlockingStream(b'abc')
    resource.reader = lambda: stream
    reader = lease.independent_reader()
    output = []
    reading = threading.Thread(target=lambda: output.append(reader.read(1)))
    def closing():
        close_started.set()
        reader.close()
    closer = threading.Thread(target=closing)
    reading.start()
    try:
        assert entered.wait(2)
        closer.start()
        assert close_started.wait(2)
        lease.close()
        assert not stream.closed and resource.closed == 0
    finally:
        release.set()
        reading.join(2)
        if closer.ident is not None:
            closer.join(2)
    assert output == [b'a'] and stream.closed and resource.closed == 1
    with pytest.raises(rooted.RootedFileUnavailable, match='reader_closed'):
        reader.read(1)


def test_reader_postcheck_failure_closes_unpublished_stream():
    lease, resource = opened()
    checks = []
    def check():
        checks.append(1)
        if len(checks) == 2:
            raise rooted.RootedFileUnavailable('changed')
    resource.on_check = check
    with pytest.raises(rooted.RootedFileUnavailable):
        lease.independent_reader()
    assert resource.readers[0].closed
    lease.close()
    assert resource.closed == 1


def test_rooted_adapter_has_no_path_and_preserves_sticky_local_failure():
    lease, resource = opened()
    source = retained.RetainedPlaybackSource.from_rooted_lease(lease, original_suffix='.MP3')
    assert source.original_suffix == '.mp3' and not hasattr(source, 'path')
    source._failed = True
    with pytest.raises(retained.SourceUnavailable, match='source_failed'):
        source.check()
    source.close()
    assert resource.closed == 1
    with pytest.raises(retained.SourceUnavailable, match='source_closed'):
        source.reader()


def test_adapter_validation_failure_does_not_take_ownership():
    lease, resource = opened()
    with pytest.raises(retained.SourceUnavailable):
        retained.RetainedPlaybackSource.from_rooted_lease(lease, original_suffix='/bad')
    assert resource.closed == 0
    lease.check()
    lease.close()


def test_lease_cannot_transfer_to_two_adapters():
    lease, resource = opened()
    first = retained.RetainedPlaybackSource.from_rooted_lease(lease, original_suffix='.mp3')
    with pytest.raises(rooted.RootedFileUnavailable, match='source_ownership_unavailable'):
        retained.RetainedPlaybackSource.from_rooted_lease(lease, original_suffix='.mp3')
    assert resource.closed == 0
    first.close()
    assert resource.closed == 1


def test_rooted_launch_is_explicitly_deferred_before_probe_or_spawn():
    lease, resource = opened()
    source = retained.RetainedPlaybackSource.from_rooted_lease(lease, original_suffix='.mp3')
    with pytest.raises(retained.SourceUnavailable, match='rooted_launch_not_integrated'):
        asyncio.run(retained.start_retained_process(source, None, (), ()))
    source.close()


@pytest.mark.parametrize('root,parts', [
    ('relative', ('a',)), ('//server/share', ('a',)), ('/a/../b', ('a',)),
    ('/a//b', ('a',)), ('/a/', ('a',)), ('/', ()), ('/', ('..',)),
    ('/', ('a/b',)), ('/', ('\x00',)),
])
def test_posix_lexical_rejection_before_open(root, parts):
    with pytest.raises(rooted.RootedFileUnavailable):
        rooted._posix_selection(rooted.RootSelection('posix', root, parts))


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


class ControlledExecutor:
    """At most two synthetic worker threads; queued futures never auto-start."""
    def __init__(self, workers=2):
        self.limit, self.threads, self.futures = workers, [], []

    def submit(self, function, *args):
        from concurrent.futures import Future
        future = Future()
        self.futures.append(future)
        if len(self.threads) < self.limit:
            # Mark running before submit returns, removing cancellation timing.
            assert future.set_running_or_notify_cancel()
            def run():
                try:
                    result = function(*args)
                except BaseException as error:
                    future.set_exception(error)
                else:
                    future.set_result(result)
            worker = threading.Thread(target=run, daemon=True)
            self.threads.append(worker)
            worker.start()
        return future

    def join(self):
        for worker in self.threads:
            worker.join(3)
            assert not worker.is_alive()


def make_budget(executor):
    budget = rooted.AcquisitionBudget(executor)
    budget._slots = CountingSlots()
    return budget


def test_completion_between_timeout_detection_and_abandonment_keeps_worker_owner(monkeypatch):
    executor = ControlledExecutor()
    budget = make_budget(executor)
    timeout_seen, publish_abandon = threading.Event(), threading.Event()
    factory_release, close_entered, close_release = (threading.Event() for _ in range(3))
    job_seen, errors, closes = [], [], []
    def delayed_timeout(job, timeout):
        job_seen.append(job)
        timeout_seen.set()  # Deadline observed; caller not yet publishing abandonment.
        assert publish_abandon.wait(3)
        return False
    monkeypatch.setattr(rooted._AcquisitionJob, 'wait', delayed_timeout)
    class Lease:
        def close(self):
            closes.append(threading.get_ident())
            close_entered.set()
            assert close_release.wait(3)
    def factory(*_):
        assert factory_release.wait(3)
        return Lease()
    def call():
        try:
            budget.acquire(None, timeout=0, factory=factory)
        except BaseException as error:
            errors.append(error)
    caller = threading.Thread(target=call)
    caller.start()
    try:
        assert timeout_seen.wait(3)
        factory_release.set()
        assert job_seen[0].completed.wait(3)
        assert not budget._slots.releases and not closes
        # Completion is waiting for caller arbitration, retaining its slot.
        publish_abandon.set()
        assert close_entered.wait(3)
        caller.join(3)
        assert not caller.is_alive()
        assert len(errors) == 1 and str(errors[0]) == 'acquisition_deadline'
        assert closes == [executor.threads[0].ident]
        assert closes[0] != caller.ident and not budget._slots.releases
        # Exhaust the other five slots: cleanup's slot is still unavailable.
        spare = [budget._slots.semaphore.acquire(blocking=False) for _ in range(6)]
        assert spare == [True] * 5 + [False]
        with pytest.raises(rooted.RootedFileUnavailable, match='acquisition_busy'):
            budget.acquire(None, timeout=0, factory=factory)
        for _ in range(5):
            budget._slots.semaphore.release()
        assert len(executor.threads) == len(executor.futures) == 1
        # Repeated abandonment cannot steal cleanup; no completion/cancel callback
        # owns slot release in this protocol.
        assert job_seen[0].abandon() is False
        assert not budget._slots.releases and len(closes) == 1
    finally:
        factory_release.set()
        publish_abandon.set()
        close_release.set()
        caller.join(3)
        executor.join()
    assert budget._slots.releases == [executor.threads[0].ident]
    assert len(closes) == 1


def test_abandonment_before_completion_cleanup_is_never_on_caller(monkeypatch):
    executor = ControlledExecutor()
    budget = make_budget(executor)
    factory_release, close_entered, close_release = (threading.Event() for _ in range(3))
    closes = []
    factory_entered = threading.Event()
    class Lease:
        def close(self):
            closes.append(threading.get_ident())
            close_entered.set()
            assert close_release.wait(3)
    def factory(*_):
        factory_entered.set()
        assert factory_release.wait(3)
        return Lease()
    def timeout_after_start(job, timeout):
        assert factory_entered.wait(3)
        return False
    monkeypatch.setattr(rooted._AcquisitionJob, 'wait', timeout_after_start)
    try:
        with pytest.raises(rooted.RootedFileUnavailable, match='acquisition_deadline'):
            budget.acquire(None, timeout=0, factory=factory)
        assert not budget._slots.releases
        factory_release.set()
        assert close_entered.wait(3)
        assert closes == [executor.threads[0].ident]
        assert not budget._slots.releases
    finally:
        factory_release.set()
        close_release.set()
        executor.join()
    assert budget._slots.releases == [executor.threads[0].ident]


def test_successful_delivery_is_claimed_without_cleanup():
    executor = ControlledExecutor()
    budget = make_budget(executor)
    lease, resource = opened()
    assert budget.acquire(None, factory=lambda *_: lease) is lease
    executor.join()
    assert resource.closed == 0
    assert budget._slots.releases == [executor.threads[0].ident]
    lease.close()
    assert resource.closed == 1


def test_abandoned_queued_entry_retains_capacity_without_future_cancel():
    executor = ControlledExecutor(workers=0)
    budget = make_budget(executor)
    def forbidden(*_):
        raise AssertionError('queued factory must not run')
    with pytest.raises(rooted.RootedFileUnavailable, match='acquisition_deadline'):
        budget.acquire(None, timeout=0, factory=forbidden)
    assert not executor.futures[0].cancelled()
    assert len(budget._slots.releases) == 0 and not executor.threads


def test_factory_failure_releases_but_generic_submit_rejection_quarantines_capacity():
    executor = ControlledExecutor()
    budget = make_budget(executor)
    failure = RuntimeError('synthetic factory failure')
    def factory(*_):
        raise failure
    with pytest.raises(RuntimeError) as caught:
        budget.acquire(None, factory=factory)
    assert caught.value is failure
    executor.join()
    assert budget._slots.releases == [executor.threads[0].ident]
    class RejectedExecutor:
        def submit(self, *_):
            raise RuntimeError('submit rejected')
    rejected = make_budget(RejectedExecutor())
    for _ in range(6):
        with pytest.raises(RuntimeError, match='submit rejected'):
            rejected.acquire(None)
    assert not rejected._slots.releases
    with pytest.raises(rooted.RootedFileUnavailable, match='acquisition_busy'):
        rejected.acquire(None)


def test_hung_acquisition_keeps_two_workers_without_replacement(monkeypatch):
    executor = ControlledExecutor()
    budget = make_budget(executor)
    release = threading.Event()
    entered = [threading.Event(), threading.Event()]
    calls = []
    waits = []
    def deadline_after_running_start(job, timeout):
        index = len(waits)
        waits.append(job)
        if index < 2:
            assert entered[index].wait(3)
        return False
    monkeypatch.setattr(rooted._AcquisitionJob, 'wait', deadline_after_running_start)
    def factory(*_):
        index = len(calls)
        calls.append(threading.get_ident())
        entered[index].set()
        assert release.wait(3)
        raise RuntimeError('late acquisition failed')
    try:
        for index in range(2):
            with pytest.raises(rooted.RootedFileUnavailable, match='acquisition_deadline'):
                budget.acquire(None, timeout=0, factory=factory)
            assert entered[index].wait(3)
        assert not budget._slots.releases
        with pytest.raises(rooted.RootedFileUnavailable, match='acquisition_deadline'):
            budget.acquire(None, timeout=0, factory=factory)
        assert len(calls) == len(executor.threads) == 2
        assert not executor.futures[2].cancelled()
        assert not budget._slots.releases  # Retained queued work still owns a slot.
    finally:
        release.set()
        executor.join()
    assert len(budget._slots.releases) == 2


class RetainedQueueExecutor:
    """Model retained work items, dequeued only by its two original workers."""
    def __init__(self):
        self.condition = threading.Condition()
        self.entries, self.futures, self.threads = [], [], []
        self.stopping = False

    def submit(self, function, *args):
        from concurrent.futures import Future
        future = Future()
        with self.condition:
            self.entries.append((future, function, args))
            self.futures.append(future)
            if len(self.threads) < 2:
                worker = threading.Thread(target=self.run, daemon=True)
                self.threads.append(worker)
                worker.start()
            self.condition.notify_all()
        return future

    def run(self):
        while True:
            with self.condition:
                while not self.entries and not self.stopping:
                    self.condition.wait()
                if not self.entries:
                    return
                future, function, args = self.entries.pop(0)
            if future.set_running_or_notify_cancel():
                try:
                    value = function(*args)
                except BaseException as error:
                    future.set_exception(error)
                else:
                    future.set_result(value)

    def join(self):
        with self.condition:
            self.stopping = True
            self.condition.notify_all()
        for worker in self.threads:
            worker.join(3)
            assert not worker.is_alive()


def test_two_hung_workers_four_retained_queued_entries_bound_repeated_timeouts(monkeypatch):
    executor = RetainedQueueExecutor()
    budget = make_budget(executor)
    entered = [threading.Event(), threading.Event()]
    releases = [threading.Event(), threading.Event()]
    factory_calls, wait_jobs = [], []
    def factory(index, stamp):
        factory_calls.append((index, threading.get_ident()))
        assert index < 2, 'abandoned queued factory must never run'
        entered[index].set()
        assert releases[index].wait(3)
        raise RuntimeError('late running failure')
    def deadline(job, timeout):
        index = len(wait_jobs)
        wait_jobs.append(job)
        if index < 2:
            assert entered[index].wait(3)
        return False
    monkeypatch.setattr(rooted._AcquisitionJob, 'wait', deadline)
    try:
        for index in range(6):
            with pytest.raises(rooted.RootedFileUnavailable, match='acquisition_deadline'):
                budget.acquire(index, timeout=0, factory=factory)
        assert len(executor.entries) == 4
        assert len(executor.futures) == len(wait_jobs) == 6
        assert not budget._slots.releases
        assert all(not future.cancelled() for future in executor.futures)
        for _ in range(20):
            with pytest.raises(rooted.RootedFileUnavailable, match='acquisition_busy'):
                budget.acquire(99, timeout=0, factory=factory)
        assert len(executor.entries) == 4 and len(executor.futures) == 6
        assert len(executor.threads) == 2
        assert [index for index, _ in factory_calls] == [0, 1]
        # Free exactly one original worker. It discards all four abandoned jobs.
        releases[0].set()
        executor.futures[0].result(timeout=3)
        for future in executor.futures[2:]:
            assert future.result(timeout=3) is None
        assert not executor.entries
        assert len(budget._slots.releases) == 5
        assert budget._slots.releases == [factory_calls[0][1]] * 5
        assert [index for index, _ in factory_calls] == [0, 1]
        assert not executor.futures[1].done()
        assert len(executor.threads) == 2
    finally:
        for release in releases:
            release.set()
        executor.join()
    assert len(budget._slots.releases) == 6
    assert all(future.done() and not future.cancelled() for future in executor.futures)
    assert all(job._released for job in wait_jobs)
    assert all(not job._factory_started for job in wait_jobs[2:])


def test_submit_accepts_then_raises_retains_slot_until_original_worker_discards():
    class AcceptedThenRaises:
        def submit(self, function, *args):
            self.function, self.args = function, args
            raise RuntimeError('accepted before thread-start failure')
    executor = AcceptedThenRaises()
    budget = make_budget(executor)
    calls, errors = [], []
    def factory(*_):
        calls.append(1)
        raise AssertionError('pre-start abandoned factory must not run')
    with pytest.raises(RuntimeError, match='accepted before'):
        budget.acquire(None, factory=factory)
    job = executor.function.__self__
    assert job._decision == 'abandoned' and not job._factory_started
    assert not budget._slots.releases and not calls
    spare = [budget._slots.semaphore.acquire(blocking=False) for _ in range(6)]
    assert spare == [True] * 5 + [False]
    for _ in range(5):
        budget._slots.semaphore.release()
    def dequeue():
        try:
            executor.function(*executor.args)
        except BaseException as error:
            errors.append(error)
    original_worker = threading.Thread(target=dequeue)
    original_worker.start()
    original_worker.join(3)
    assert not original_worker.is_alive() and not errors and not calls
    assert budget._slots.releases == [original_worker.ident]
    job.release_once()
    assert budget._slots.releases == [original_worker.ident]


def test_submit_running_before_raise_closes_late_lease_on_original_worker():
    entered, factory_release, close_entered, close_release = (
        threading.Event() for _ in range(4))
    closes, errors = [], []
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
            assert entered.wait(3)
            raise RuntimeError('worker accepted before submit failure')
    class Lease:
        def close(self):
            closes.append(threading.get_ident())
            close_entered.set()
            assert close_release.wait(3)
    def factory(*_):
        entered.set()
        assert factory_release.wait(3)
        return Lease()
    executor = RunningThenRaises()
    budget = make_budget(executor)
    try:
        with pytest.raises(RuntimeError, match='worker accepted'):
            budget.acquire(None, factory=factory)
        assert executor.job._factory_started and executor.job._decision == 'abandoned'
        assert not budget._slots.releases and not closes
        factory_release.set()
        assert close_entered.wait(3)
        assert closes == [executor.worker.ident]
        assert closes[0] != threading.get_ident()
        assert not budget._slots.releases
    finally:
        factory_release.set()
        close_release.set()
        executor.worker.join(3)
    assert not executor.worker.is_alive() and not errors
    assert closes == budget._slots.releases == [executor.worker.ident]


def test_extracted_posix_chain_preserves_flags_links_and_error_type(monkeypatch):
    from contextlib import ExitStack
    from pathlib import PurePosixPath
    calls, closed = [], []
    infos = {
        10: SimpleNamespace(st_mode=0o040755, st_dev=1, st_ino=10),
        11: SimpleNamespace(st_mode=0o040755, st_dev=1, st_ino=11),
        12: SimpleNamespace(st_mode=0o040755, st_dev=1, st_ino=12),
    }
    names = {(10, 'root'): 11, (11, 'album'): 12}
    def open_file(name, flags, *, dir_fd=None):
        calls.append((name, flags, dir_fd))
        return 10 if dir_fd is None else names[(dir_fd, name)]
    def stat_file(name, *, dir_fd, follow_symlinks):
        assert follow_symlinks is False
        return infos[names[(dir_fd, name)]]
    fake_os = SimpleNamespace(O_RDONLY=1, O_DIRECTORY=2, O_NOFOLLOW=4,
        O_CLOEXEC=8, open=open_file, close=closed.append,
        fstat=lambda fd: infos[fd], stat=stat_file)
    monkeypatch.setattr(rooted, 'os', fake_os)
    class FacadeError(ValueError): pass
    with ExitStack() as stack:
        chain = rooted.PosixDirectoryChain(stack, PurePosixPath('/root'), FacadeError)
        chain.descend('album')
        chain.check()
        assert calls == [('/', 15, None), ('root', 15, 10), ('album', 15, 11)]
        names[(11, 'album')] = 11
        with pytest.raises(FacadeError, match='artwork_source_changed'):
            chain.check()
    assert closed == [12, 11, 10]


def test_adapter_rechecks_local_failure_after_blocking_delegate():
    lease, resource = opened()
    source = retained.RetainedPlaybackSource.from_rooted_lease(lease, original_suffix='.mp3')
    def invalidate():
        source._failed = True
    resource.on_check = invalidate
    with pytest.raises(retained.SourceUnavailable, match='source_failed'):
        source.check()
    source.close()


def test_transfer_rejects_outstanding_reader_without_closing_it():
    lease, resource = opened()
    reader = lease.independent_reader()
    with pytest.raises(rooted.RootedFileUnavailable, match='source_ownership_unavailable'):
        retained.RetainedPlaybackSource.from_rooted_lease(lease, original_suffix='.mp3')
    assert reader.read(1) == b'a' and resource.closed == 0
    reader.close()
    lease.close()


@pytest.mark.parametrize('first_kind', ['check', 'reader_open', 'reader_postcheck'])
@pytest.mark.parametrize('queued_kind', ['check', 'reader'])
def test_failure_publication_keeps_io_gate_until_queued_operation_is_poisoned(
        monkeypatch, first_kind, queued_kind):
    lease, resource = opened()
    poison_entered, allow_poison = threading.Event(), threading.Event()
    queued_reserved, queued_attempt = threading.Event(), threading.Event()
    errors, successes, checks = [], [], []

    class TrackedGate:
        def __init__(self):
            self.lock = threading.Lock()
            self.owner = None
        def __enter__(self):
            if threading.current_thread().name == 'queued':
                queued_attempt.set()
            self.lock.acquire()
            self.owner = threading.get_ident()
            return self
        def __exit__(self, *_):
            self.owner = None
            self.lock.release()
    gate = TrackedGate()
    lease._io = gate
    original_poison, original_reserve = lease.poison, lease._reserve
    def reserve(*args, **kwargs):
        ticket = original_reserve(*args, **kwargs)
        if threading.current_thread().name == 'queued':
            queued_reserved.set()
        return ticket
    def paused_poison():
        if threading.current_thread().name == 'failing':
            poison_entered.set()
            assert allow_poison.wait(3)
        original_poison()
    monkeypatch.setattr(lease, '_reserve', reserve)
    monkeypatch.setattr(lease, 'poison', paused_poison)
    fail_at = 2 if first_kind == 'reader_postcheck' else 1
    def nonsticky_check():
        checks.append(threading.current_thread().name)
        if first_kind != 'reader_open' and len(checks) == fail_at:
            raise rooted.RootedFileUnavailable('one_observed_failure')
        # Any later check would succeed without the neutral owner's sticky fence.
    resource.on_check = nonsticky_check
    if first_kind == 'reader_open':
        original_reader = resource.reader
        reader_attempts = []
        def nonsticky_reader():
            reader_attempts.append(1)
            if len(reader_attempts) == 1:
                raise rooted.RootedFileUnavailable('one_observed_failure')
            return original_reader()
        resource.reader = nonsticky_reader
    def operation(kind):
        try:
            result = lease.check() if kind == 'check' else lease.independent_reader()
            successes.append((threading.current_thread().name, result))
        except BaseException as error:
            errors.append((threading.current_thread().name, error))
    first = threading.Thread(target=operation,
        args=('check' if first_kind == 'check' else 'reader',), name='failing')
    queued = threading.Thread(target=operation, args=(queued_kind,), name='queued')
    first.start()
    try:
        assert poison_entered.wait(3)
        queued.start()
        assert queued_reserved.wait(3) and queued_attempt.wait(3)
        # Deterministic ownership assertion, not a sleep hoping the race occurs.
        # In R1 this gate was already released when paused_poison was entered.
        assert gate.owner == first.ident
        assert len(checks) == fail_at and not successes
    finally:
        allow_poison.set()
        first.join(3)
        if queued.ident is not None:
            queued.join(3)
        lease.close()
    assert not first.is_alive() and not queued.is_alive()
    assert not successes and len(checks) == fail_at
    by_thread = dict(errors)
    assert str(by_thread['failing']) == 'one_observed_failure'
    assert str(by_thread['queued']) == 'source_failed'
    assert all(stream.closed for stream in resource.readers)
    assert resource.closed == 1
