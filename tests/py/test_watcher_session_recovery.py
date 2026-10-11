from __future__ import annotations

from dataclasses import dataclass, fields, is_dataclass
from datetime import datetime, timezone
from inspect import Parameter, signature
import logging
from pathlib import Path
from threading import Event, Lock, Thread, current_thread
from time import monotonic
from types import ModuleType, SimpleNamespace
from uuid import UUID

import pytest

from music_app.services.library_event_coordinator import CoordinatorProblem
from music_app.services.library_watch import LibraryEvent


STARTED_AT = datetime(2026, 10, 11, 8, 0, tzinfo=timezone.utc)
SESSION_TOKEN = UUID("00000000-0000-0000-0000-000000000001")


def _controller_type():
    from music_app.services.watcher_session_recovery import (
        WatcherSessionRecoveryController,
    )

    return WatcherSessionRecoveryController


class FakeTimer:
    daemon = False

    def __init__(self, delay, callback):
        self.delay = delay
        self.callback = callback
        self.cancelled = False
        self.started = False

    def start(self):
        self.started = True

    def cancel(self):
        self.cancelled = True

    def fire(self):
        self.callback()


class FakeTimerFactory:
    def __init__(self):
        self.timers = []

    def __call__(self, delay, callback):
        timer = FakeTimer(delay, callback)
        self.timers.append(timer)
        return timer


class InlineThread:
    daemon = True

    def __init__(self, target, name):
        self._target = target
        self.name = name
        self.ident = None
        self._alive = False

    def start(self):
        self.ident = 1
        self._alive = True
        try:
            self._target()
        finally:
            self._alive = False

    def join(self, _timeout=None):
        return None

    def is_alive(self):
        return self._alive


def _inline_thread_factory(target, name):
    return InlineThread(target, name)


class FakeAttempt:
    def __init__(self, state="committed", committed_root_ids=()):
        self.state = state
        self.committed_root_ids = tuple(committed_root_ids)
        self.execute_count = 0
        self.cancel_count = 0
        self.on_terminal = lambda _attempt: None
        self._is_terminal = False
        self._outcome = None

    @property
    def is_terminal(self):
        return self._is_terminal

    @property
    def outcome(self):
        return self._outcome

    def execute(self):
        self.execute_count += 1
        self._outcome = SimpleNamespace(
            state=self.state,
            committed_root_ids=self.committed_root_ids,
        )
        self._is_terminal = True
        self.on_terminal(self)
        return self._outcome

    def cancel(self):
        self.cancel_count += 1


class BlockingAttempt(FakeAttempt):
    def __init__(self):
        super().__init__("rolled_back")
        self.calls = []
        self.entered = Event()
        self._cancelled = Event()
        self._joined_recorded = False
        self._closed = False

    def execute(self):
        self.execute_count += 1
        self.calls.append("execute")
        self.entered.set()
        assert self._cancelled.wait(2.0)
        self._closed = True
        self.calls.append("closed")
        self._outcome = SimpleNamespace(
            state="rolled_back",
            committed_root_ids=(),
        )
        self._is_terminal = True
        self.on_terminal(self)
        return self._outcome

    def cancel(self):
        self.cancel_count += 1
        self.calls.append("cancel")
        self._cancelled.set()

    def record_joined(self):
        if not self._joined_recorded:
            self.calls.append("joined")
            self._joined_recorded = True

    def force_late_commit(self, repository):
        if not (self._closed and self._is_terminal):
            repository.late_commit_count += 1


class BackgroundThread:
    daemon = True

    def __init__(self, target, name, joined_attempt):
        self.name = name
        self._joined_attempt = joined_attempt
        self._thread = Thread(target=target, name=name, daemon=True)

    @property
    def ident(self):
        return self._thread.ident

    def start(self):
        self._thread.start()

    def join(self, timeout=None):
        self._thread.join(timeout)
        if (
            not self._thread.is_alive()
            and hasattr(self._joined_attempt, "record_joined")
        ):
            self._joined_attempt.record_joined()

    def is_alive(self):
        return self._thread.is_alive()


class BackgroundThreadFactory:
    def __init__(self, joined_attempt):
        self.joined_attempt = joined_attempt
        self.threads = []

    def __call__(self, target, name):
        thread = BackgroundThread(target, name, self.joined_attempt)
        self.threads.append(thread)
        return thread


class ImmediateFirstJoinThread(BackgroundThread):
    def join(self, timeout=None):
        if self._joined_attempt.cancel_count == 0:
            return None
        return super().join(timeout)


class ImmediateFirstJoinThreadFactory(BackgroundThreadFactory):
    def __call__(self, target, name):
        thread = ImmediateFirstJoinThread(target, name, self.joined_attempt)
        self.threads.append(thread)
        return thread


class RaisingCancelAttempt(BlockingAttempt):
    def cancel(self):
        super().cancel()
        raise OSError("private C:/music/root-a token=secret")


class NonTerminalCancelAttempt(FakeAttempt):
    def __init__(self):
        super().__init__("rolled_back")

    def cancel(self):
        self.cancel_count += 1


class TerminalCancelAttempt(FakeAttempt):
    def __init__(self):
        super().__init__("rolled_back")

    def cancel(self):
        self.cancel_count += 1
        self._outcome = SimpleNamespace(
            state="rolled_back",
            committed_root_ids=(),
        )
        self._is_terminal = True
        self.on_terminal(self)


class PausedStartThread(BackgroundThread):
    def __init__(self, target, name, joined_attempt, factory):
        super().__init__(target, name, joined_attempt)
        self._factory = factory
        self._started = False

    def start(self):
        self._factory.start_entered.set()
        assert self._factory.release_start.wait(2.0)
        if self._factory.controller._stopping:
            self._factory.started_after_stop = True
        super().start()
        self._started = True

    def join(self, timeout=None):
        if not self._started:
            self._factory.joined_before_start = True
            raise RuntimeError("cannot join thread before it is started")
        return super().join(timeout)


class PausedFirstStartThreadFactory(BackgroundThreadFactory):
    def __init__(self, joined_attempt):
        super().__init__(joined_attempt)
        self.controller = None
        self.start_entered = Event()
        self.release_start = Event()
        self.joined_before_start = False
        self.started_after_stop = False

    def __call__(self, target, name):
        if not self.threads:
            thread = PausedStartThread(
                target,
                name,
                self.joined_attempt,
                self,
            )
        else:
            thread = BackgroundThread(target, name, self.joined_attempt)
        self.threads.append(thread)
        return thread


class JoinGateThread(BackgroundThread):
    def __init__(self, target, name, joined_attempt, join_entered):
        super().__init__(target, name, joined_attempt)
        self._join_entered = join_entered

    def join(self, timeout=None):
        self._join_entered.set()
        return super().join(timeout)


class JoinGateThreadFactory(BackgroundThreadFactory):
    def __init__(self, joined_attempt):
        super().__init__(joined_attempt)
        self.join_entered = Event()

    def __call__(self, target, name):
        thread = JoinGateThread(
            target,
            name,
            self.joined_attempt,
            self.join_entered,
        )
        self.threads.append(thread)
        return thread


class FakeRepository:
    def __init__(self, attempts=()):
        self._attempts = list(attempts)
        self.begin_calls = []
        self.prepare_calls = []
        self.finish_calls = []
        self.late_commit_count = 0
        self.committed_write_count = 0
        self.prepared_attempts = []
        self.controller = None

    def begin_runtime_session(self, **kwargs):
        self.begin_calls.append(kwargs)
        return ()

    def expand_runtime_session_participants(self, **_kwargs):
        return None

    def set_runtime_session_participants(self, **_kwargs):
        return None

    def finish_runtime_session(self, **kwargs):
        self.finish_calls.append(kwargs)
        return True

    def prepare_overflow_dirty_write(self, **kwargs):
        self.prepare_calls.append(kwargs)
        attempt = (
            self._attempts.pop(0)
            if self._attempts
            else FakeAttempt("committed", kwargs["logical_root_ids"])
        )
        attempt.on_terminal = self._record_terminal
        self.prepared_attempts.append(attempt)
        return attempt

    def _record_terminal(self, attempt):
        if attempt.outcome.state == "committed":
            self.committed_write_count += 1


class PrepareGateRepository(FakeRepository):
    def __init__(self, attempts=()):
        super().__init__(attempts)
        self.prepare_entered = Event()
        self.release_prepare = Event()

    def prepare_overflow_dirty_write(self, **kwargs):
        self.prepare_entered.set()
        assert self.release_prepare.wait(2.0)
        return super().prepare_overflow_dirty_write(**kwargs)


def _started_controller(
    repository,
    *,
    clock=lambda: STARTED_AT,
    monotonic_clock=lambda: 10.0,
    timer_factory=None,
    thread_factory=_inline_thread_factory,
    cancellation_reserve_seconds=0.05,
):
    timer_factory = timer_factory or FakeTimerFactory()
    controller = _controller_type()(
        repository,
        clock=clock,
        monotonic_clock=monotonic_clock,
        retry_delay_seconds=0.0,
        cancellation_reserve_seconds=cancellation_reserve_seconds,
        retry_timer_factory=timer_factory,
        thread_factory=thread_factory,
    )
    repository.controller = controller
    assert controller.start(
        library_id=7,
        session_token=SESSION_TOKEN,
        logical_root_ids=("root-a", "root-b"),
        started_at=STARTED_AT,
    ) == ()
    return controller, timer_factory


def _capture_error(errors, callback):
    try:
        callback()
    except Exception as exc:
        errors.append(exc)


def _capture_outcome(outcomes, name, callback):
    try:
        outcomes.append((name, callback()))
    except Exception as exc:
        outcomes.append((name, exc.__class__))


def _wait_for_event_or_thread_exit(thread, timeout):
    thread.join(timeout)
    return not thread.is_alive()


class _StartPublicationGapLock:
    def __init__(self, controller):
        self._lock = Lock()
        self._controller = controller
        self.first_thread = None
        self.gap_open = Event()
        self.release_first = Event()
        self._paused = False

    def acquire(self, *args, **kwargs):
        return self._lock.acquire(*args, **kwargs)

    def release(self):
        self._lock.release()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        should_pause = (
            not self._paused
            and current_thread() is self.first_thread
            and self._controller._start_in_progress is False
            and self._controller._library_id is None
        )
        if should_pause:
            self._paused = True
        self.release()
        if should_pause:
            self.gap_open.set()
            assert self.release_first.wait(2.0)

    def wait_for_gap_or_completion(self, thread):
        if self.gap_open.wait(1.0):
            return True
        thread.join(0.0)
        return not thread.is_alive()


class _DeadlineGateLock:
    def __init__(self):
        self.acquire_entered = Event()
        self.release_waiter = Event()
        self.timed_acquire_requested = False

    def acquire(self, blocking=True, timeout=-1):
        self.acquire_entered.set()
        if not blocking:
            return False
        if timeout is not None and timeout >= 0:
            self.timed_acquire_requested = True
            return False
        assert self.release_waiter.wait(2.0)
        return True

    def release(self):
        return None

    def __enter__(self):
        assert self.acquire()
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        self.release()


class _FalseSampleRaceLock:
    def __init__(self):
        self._lock = Lock()
        self.sample_released = Event()
        self.allow_cleanup_to_continue = Event()
        self._cleanup_acquisitions = 0

    def acquire(self, blocking=True, timeout=-1):
        if not blocking:
            acquired = self._lock.acquire(blocking=False)
        elif timeout is not None and timeout >= 0:
            acquired = self._lock.acquire(timeout=timeout)
        else:
            acquired = self._lock.acquire()
        if acquired and current_thread().name == "false-sample-stop":
            self._cleanup_acquisitions += 1
        return acquired

    def release(self):
        pause_cleanup = (
            current_thread().name == "false-sample-stop"
            and self._cleanup_acquisitions == 1
            and not self.sample_released.is_set()
        )
        self._lock.release()
        if pause_cleanup:
            self.sample_released.set()
            assert self.allow_cleanup_to_continue.wait(2.0)

    def __enter__(self):
        assert self.acquire()
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        self.release()


class StartRaisesThread:
    daemon = True

    def __init__(self, error):
        self.error = error
        self.start_count = 0
        self.join_count = 0
        self.ident = None

    def start(self):
        self.start_count += 1
        raise self.error

    def join(self, _timeout=None):
        self.join_count += 1
        raise RuntimeError("unstarted thread must not be joined")

    def is_alive(self):
        return False


class StartRaisesThenInlineThreadFactory:
    def __init__(self, error):
        self.failed_thread = StartRaisesThread(error)
        self.calls = 0

    def __call__(self, target, name):
        self.calls += 1
        if self.calls == 1:
            return self.failed_thread
        return InlineThread(target, name)


def test_admission_failure_retries_without_another_filesystem_event():
    attempt = FakeAttempt("committed", ("root-a", "root-b"))
    repository = FakeRepository((attempt,))
    controller, timers = _started_controller(repository)

    controller.report_admission_failure(
        logical_root_ids=("root-a", "root-b")
    )
    assert len(timers.timers) == 1
    timers.timers[0].fire()

    assert [call["logical_root_ids"] for call in repository.prepare_calls] == [
        ("root-a", "root-b")
    ]
    assert attempt.execute_count == 1
    assert attempt.outcome.state == "committed"
    assert attempt.outcome.committed_root_ids == ("root-a", "root-b")


def test_failed_retry_stays_pending_until_one_overflow_commit():
    rolled_back = FakeAttempt("rolled_back")
    committed = FakeAttempt("committed", ("root-a",))
    repository = FakeRepository((rolled_back, committed))
    controller, timers = _started_controller(repository)

    controller.report_admission_failure(logical_root_ids=("root-a",))
    timers.timers[0].fire()

    assert rolled_back.execute_count == 1
    assert len(timers.timers) == 2
    timers.timers[1].fire()

    assert committed.execute_count == 1
    assert [call["logical_root_ids"] for call in repository.prepare_calls] == [
        ("root-a",),
        ("root-a",),
    ]
    assert len(timers.timers) == 2


def test_repeated_and_stale_callbacks_do_not_duplicate_occurrences():
    attempt = FakeAttempt("committed", ("root-a",))
    repository = FakeRepository((attempt,))
    controller, timers = _started_controller(repository)

    controller.report_admission_failure(logical_root_ids=("root-a",))
    controller.report_admission_failure(logical_root_ids=("root-a", "root-a"))
    stale_timer = timers.timers[0]
    stale_timer.fire()
    stale_timer.fire()

    assert attempt.execute_count == 1
    assert [call["logical_root_ids"] for call in repository.prepare_calls] == [
        ("root-a",)
    ]


def _controller_owned_values(value, *, excluded_ids, visited=None):
    visited = visited or set()
    if (
        id(value) in excluded_ids
        or id(value) in visited
        or callable(value)
        or isinstance(value, ModuleType)
    ):
        return
    visited.add(id(value))

    if isinstance(value, (datetime, Path, LibraryEvent, CoordinatorProblem, str)):
        yield value
        return
    if isinstance(value, dict):
        for key, item in value.items():
            yield from _controller_owned_values(
                key,
                excluded_ids=excluded_ids,
                visited=visited,
            )
            yield from _controller_owned_values(
                item,
                excluded_ids=excluded_ids,
                visited=visited,
            )
        return
    if isinstance(value, (list, tuple, set, frozenset)):
        for item in value:
            yield from _controller_owned_values(
                item,
                excluded_ids=excluded_ids,
                visited=visited,
            )
        return
    controller_owned = (
        value.__class__.__module__
        == "music_app.services.watcher_session_recovery"
    )
    safe_holder = isinstance(value, SimpleNamespace) or is_dataclass(value)
    slots = tuple(
        slot
        for cls in value.__class__.__mro__
        for slot in (
            (cls.__slots__,)
            if isinstance(getattr(cls, "__slots__", ()), str)
            else getattr(cls, "__slots__", ())
        )
        if slot not in {"__dict__", "__weakref__"}
    )
    if controller_owned or safe_holder or slots:
        yield value
        state = []
        if controller_owned or isinstance(value, SimpleNamespace):
            state.extend(getattr(value, "__dict__", {}).values())
        if is_dataclass(value):
            state.extend(getattr(value, field.name) for field in fields(value))
        state.extend(
            getattr(value, slot)
            for slot in slots
            if hasattr(value, slot)
        )
        for item in state:
            yield from _controller_owned_values(
                item,
                excluded_ids=excluded_ids,
                visited=visited,
            )


def test_controller_state_traversal_finds_forbidden_nested_holder_values():
    private_path = Path("C:/private/music")
    timestamp = datetime(2026, 10, 11, 9, 0, tzinfo=timezone.utc)

    @dataclass(slots=True)
    class Holder:
        value: object

    cycle = SimpleNamespace()
    cycle.self = cycle
    cycle.payload = {private_path: Holder(timestamp)}

    retained = tuple(
        _controller_owned_values(cycle, excluded_ids=set())
    )

    assert private_path in retained
    assert timestamp in retained


def test_controller_state_contains_only_logical_ids():
    repository = FakeRepository()
    controller, timers = _started_controller(repository)

    controller.report_admission_failure(logical_root_ids=("root-a",))
    excluded_ids = {
        id(repository),
        id(timers),
        *(id(timer) for timer in timers.timers),
    }
    retained = tuple(
        _controller_owned_values(controller, excluded_ids=excluded_ids)
    )
    retained_strings = tuple(
        value for value in retained if isinstance(value, str)
    )
    parameters = signature(controller.report_admission_failure).parameters

    assert tuple(parameters) == ("logical_root_ids",)
    assert parameters["logical_root_ids"].kind is Parameter.KEYWORD_ONLY
    assert not any(
        isinstance(value, (datetime, Path, LibraryEvent, CoordinatorProblem))
        for value in retained
    )
    assert retained_strings == ("root-a",)
    assert all(
        "C:" not in value
        and "database" not in value
        and "overflow" not in value
        and "root_unavailable" not in value
        for value in retained_strings
    )


def test_controller_prepares_overflow_with_execution_time_utc_clock():
    now = [STARTED_AT]
    repository = FakeRepository()
    controller, timers = _started_controller(repository, clock=lambda: now[0])

    controller.report_admission_failure(logical_root_ids=("root-a",))
    later = datetime(2026, 10, 11, 8, 5, tzinfo=timezone.utc)
    now[0] = later
    timers.timers[0].fire()

    assert repository.prepare_calls[0]["observed_at"] == later
    assert repository.prepare_calls[0]["observed_at"].tzinfo is timezone.utc


def test_controller_never_calls_repository_while_retry_lock_is_held():
    class LockCheckingRepository(FakeRepository):
        def __init__(self):
            super().__init__()
            self.lock_was_available = None

        def prepare_overflow_dirty_write(self, **kwargs):
            acquired = self.controller._retry_lock.acquire(blocking=False)
            self.lock_was_available = acquired
            if acquired:
                self.controller._retry_lock.release()
            return super().prepare_overflow_dirty_write(**kwargs)

    repository = LockCheckingRepository()
    controller, timers = _started_controller(repository)

    controller.report_admission_failure(logical_root_ids=("root-a",))
    timers.timers[0].fire()

    assert repository.lock_was_available is True


def test_stop_cancels_exact_attempt_joins_and_prevents_late_commit():
    blocked = BlockingAttempt()
    final_commit = FakeAttempt("committed", ("root-a",))
    repository = FakeRepository((blocked, final_commit))
    controller, timers = _started_controller(
        repository,
        monotonic_clock=monotonic,
        thread_factory=BackgroundThreadFactory(blocked),
    )

    controller.report_admission_failure(logical_root_ids=("root-a",))
    timers.timers[0].fire()
    assert blocked.entered.wait(1.0)
    controller.stop_retry_and_flush(deadline=monotonic() + 1.0)
    blocked.force_late_commit(repository)

    assert blocked.calls == ["execute", "cancel", "closed", "joined"]
    assert blocked.is_terminal
    assert blocked.outcome is not None
    assert final_commit.execute_count == 1
    assert repository.late_commit_count == 0


def test_stop_failure_leaves_session_open_and_rejects_finish():
    repository = FakeRepository(
        (FakeAttempt("indeterminate"), FakeAttempt("indeterminate"))
    )
    controller, timers = _started_controller(
        repository,
        monotonic_clock=monotonic,
    )

    controller.report_admission_failure(logical_root_ids=("root-a",))
    timers.timers[0].fire()

    with pytest.raises(RuntimeError):
        controller.stop_retry_and_flush(deadline=monotonic() + 0.5)
    with pytest.raises(RuntimeError):
        controller.finish()

    assert repository.finish_calls == []


def test_report_after_stop_starts_no_write():
    repository = FakeRepository()
    controller, timers = _started_controller(
        repository,
        monotonic_clock=monotonic,
    )
    controller.report_admission_failure(logical_root_ids=("root-a",))
    stale_timers = tuple(timers.timers)
    controller.stop_retry_and_flush(deadline=monotonic() + 0.5)
    prepare_count = len(repository.prepare_calls)
    execute_count = sum(
        attempt.execute_count for attempt in repository.prepared_attempts
    )
    write_count = repository.committed_write_count
    timer_count = len(timers.timers)

    controller.report_admission_failure(logical_root_ids=("root-a",))
    for timer in (*stale_timers, *timers.timers):
        timer.fire()

    assert len(repository.prepare_calls) == prepare_count
    assert sum(
        attempt.execute_count for attempt in repository.prepared_attempts
    ) == execute_count
    assert repository.committed_write_count == write_count
    assert len(timers.timers) == timer_count


def test_default_retry_budget_includes_execution_time_and_cancellation_reserve():
    repository = FakeRepository()
    timers = FakeTimerFactory()
    controller = _controller_type()(
        repository,
        clock=lambda: STARTED_AT,
        monotonic_clock=lambda: 20.0,
        retry_timer_factory=timers,
        thread_factory=_inline_thread_factory,
    )
    repository.controller = controller
    controller.start(
        library_id=7,
        session_token=SESSION_TOKEN,
        logical_root_ids=("root-a",),
        started_at=STARTED_AT,
    )

    controller.report_admission_failure(logical_root_ids=("root-a",))
    timers.timers[0].fire()

    operation_deadline = repository.prepare_calls[0]["operation_deadline"]
    assert operation_deadline - 20.0 >= 1.5


def test_live_retry_cancels_stuck_attempt_and_allows_later_retry():
    blocked = BlockingAttempt()
    committed = FakeAttempt("committed", ("root-a",))
    repository = FakeRepository((blocked, committed))
    timers = FakeTimerFactory()
    threads = BackgroundThreadFactory(blocked)
    controller = _controller_type()(
        repository,
        clock=lambda: STARTED_AT,
        monotonic_clock=lambda: 10.0,
        retry_delay_seconds=0.0,
        cancellation_reserve_seconds=0.05,
        retry_timer_factory=timers,
        thread_factory=threads,
    )
    repository.controller = controller
    controller.start(
        library_id=7,
        session_token=SESSION_TOKEN,
        logical_root_ids=("root-a",),
        started_at=STARTED_AT,
    )

    try:
        controller.report_admission_failure(logical_root_ids=("root-a",))
        timers.timers[0].fire()
        assert blocked.entered.wait(1.0)

        assert len(timers.timers) == 2
        timers.timers[1].fire()
        assert blocked.is_terminal
        assert blocked.cancel_count == 1
        assert not threads.threads[0].is_alive()

        retry_timer = timers.timers[-1]
        assert retry_timer is not timers.timers[1]
        retry_timer.fire()
        assert committed.execute_count == 1
    finally:
        blocked.cancel()
        for thread in threads.threads:
            thread.join(1.0)


def test_retry_start_and_stop_use_one_atomic_thread_ownership_handshake():
    cancelled = TerminalCancelAttempt()
    final_commit = FakeAttempt("committed", ("root-a",))
    repository = FakeRepository((cancelled, final_commit))
    timers = FakeTimerFactory()
    threads = PausedFirstStartThreadFactory(cancelled)
    controller, _ = _started_controller(
        repository,
        monotonic_clock=monotonic,
        timer_factory=timers,
        thread_factory=threads,
    )
    threads.controller = controller
    fire_errors = []
    stop_errors = []

    controller.report_admission_failure(logical_root_ids=("root-a",))
    fire_thread = Thread(
        target=lambda: _capture_error(fire_errors, timers.timers[0].fire),
        daemon=True,
    )
    fire_thread.start()
    assert threads.start_entered.wait(1.0)
    stop_thread = Thread(
        target=lambda: _capture_error(
            stop_errors,
            lambda: controller.stop_retry_and_flush(
                deadline=monotonic() + 1.0
            ),
        ),
        daemon=True,
    )
    stop_thread.start()
    try:
        _wait_for_event_or_thread_exit(stop_thread, 0.2)
    finally:
        threads.release_start.set()
        fire_thread.join(1.0)
        stop_thread.join(1.0)
        cancelled.cancel()
        for thread in threads.threads:
            if thread.ident is not None:
                thread.join(1.0)

    assert fire_errors == []
    assert stop_errors == []
    assert threads.joined_before_start is False
    assert threads.started_after_stop is False


def test_concurrent_final_flush_stops_never_join_an_unstarted_thread():
    final_attempt = BlockingAttempt()
    repository = FakeRepository((final_attempt,))
    threads = PausedFirstStartThreadFactory(final_attempt)
    controller, _ = _started_controller(
        repository,
        monotonic_clock=monotonic,
        thread_factory=threads,
    )
    threads.controller = controller
    controller.report_admission_failure(logical_root_ids=("root-a",))
    errors = []
    first_stop = Thread(
        target=lambda: _capture_error(
            errors,
            lambda: controller.stop_retry_and_flush(
                deadline=monotonic() + 1.0
            ),
        ),
        daemon=True,
    )
    first_stop.start()
    assert threads.start_entered.wait(1.0)
    second_stop = Thread(
        target=lambda: _capture_error(
            errors,
            lambda: controller.stop_retry_and_flush(
                deadline=monotonic() + 1.0
            ),
        ),
        daemon=True,
    )
    second_stop.start()
    try:
        _wait_for_event_or_thread_exit(second_stop, 0.2)
    finally:
        threads.release_start.set()
        final_attempt.cancel()
        first_stop.join(1.0)
        second_stop.join(1.0)
        for thread in threads.threads:
            if thread.ident is not None:
                thread.join(1.0)

    assert not any(
        "before it is started" in str(error) for error in errors
    )
    assert threads.joined_before_start is False


def test_final_flush_cancel_error_still_joins_before_surfacing():
    attempt = RaisingCancelAttempt()
    repository = FakeRepository((attempt,))
    threads = ImmediateFirstJoinThreadFactory(attempt)
    controller, _ = _started_controller(
        repository,
        monotonic_clock=monotonic,
        thread_factory=threads,
    )
    controller.report_admission_failure(logical_root_ids=("root-a",))

    with pytest.raises((OSError, RuntimeError)):
        controller.stop_retry_and_flush(deadline=monotonic() + 1.0)
    calls_before_test_cleanup = tuple(attempt.calls)
    attempt.force_late_commit(repository)
    for thread in threads.threads:
        if thread.ident is not None:
            thread.join(1.0)

    assert calls_before_test_cleanup == (
        "execute",
        "cancel",
        "closed",
        "joined",
    )
    assert repository.late_commit_count == 0


def test_retry_logging_contains_only_sanitized_operation_metadata(caplog):
    class PrivateFailure(RuntimeError):
        pass

    class FailingRepository(FakeRepository):
        def prepare_overflow_dirty_write(self, **kwargs):
            raise PrivateFailure(
                "root-a C:/private/music token=secret params=(7, raw-sql)"
            )

    repository = FailingRepository()
    controller, timers = _started_controller(repository)
    caplog.set_level(
        logging.WARNING,
        logger="music_app.services.watcher_session_recovery",
    )

    controller.report_admission_failure(logical_root_ids=("root-a",))
    timers.timers[0].fire()

    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert record.operation == "retry"
    assert record.root_count == 1
    assert record.exception_class == "PrivateFailure"
    rendered = f"{record.getMessage()} {record.__dict__!r}"
    assert "root-a" not in rendered
    assert "C:/private" not in rendered
    assert "secret" not in rendered
    assert "raw-sql" not in rendered


def test_stale_prepared_attempt_must_terminate_before_handle_is_cleared():
    stale = NonTerminalCancelAttempt()
    final_commit = FakeAttempt("committed", ("root-a",))
    repository = PrepareGateRepository((stale, final_commit))
    threads = JoinGateThreadFactory(stale)
    controller, timers = _started_controller(
        repository,
        monotonic_clock=monotonic,
        thread_factory=threads,
    )
    controller.report_admission_failure(logical_root_ids=("root-a",))
    timers.timers[0].fire()
    assert repository.prepare_entered.wait(1.0)
    errors = []
    stopper = Thread(
        target=lambda: _capture_error(
            errors,
            lambda: controller.stop_retry_and_flush(
                deadline=monotonic() + 1.0
            ),
        ),
        daemon=True,
    )
    stopper.start()
    assert threads.join_entered.wait(1.0)
    repository.release_prepare.set()
    stopper.join(1.0)

    assert len(errors) == 1
    assert isinstance(errors[0], RuntimeError)
    assert stale.cancel_count == 1
    assert stale.is_terminal is False
    assert final_commit.execute_count == 0


def test_concurrent_start_cannot_enter_between_begin_and_identity_publication():
    repository = FakeRepository()
    controller = _controller_type()(repository)
    gap_lock = _StartPublicationGapLock(controller)
    controller._retry_lock = gap_lock
    repository.controller = controller
    outcomes = []

    first = Thread(
        target=lambda: _capture_outcome(
            outcomes,
            "first",
            lambda: controller.start(
                library_id=7,
                session_token=SESSION_TOKEN,
                logical_root_ids=("root-a",),
                started_at=STARTED_AT,
            ),
        ),
        daemon=True,
    )
    gap_lock.first_thread = first
    first.start()
    assert gap_lock.wait_for_gap_or_completion(first)
    second_token = UUID("00000000-0000-0000-0000-000000000002")
    second = Thread(
        target=lambda: _capture_outcome(
            outcomes,
            "second",
            lambda: controller.start(
                library_id=7,
                session_token=second_token,
                logical_root_ids=("root-a",),
                started_at=STARTED_AT,
            ),
        ),
        daemon=True,
    )
    second.start()
    second.join(1.0)
    gap_lock.release_first.set()
    first.join(1.0)
    second.join(1.0)

    assert len(repository.begin_calls) == 1
    assert controller._session_token == SESSION_TOKEN
    assert dict(outcomes) == {"first": (), "second": RuntimeError}


def test_replacement_cleans_owned_retry_without_touching_replacement_session():
    from music_app.services.watcher_recovery_postgres import (
        WatcherSessionReplacedError,
    )

    class ReplacedRepository(FakeRepository):
        def set_runtime_session_participants(self, **_kwargs):
            raise WatcherSessionReplacedError("private replacement token")

    blocked = BlockingAttempt()
    repository = ReplacedRepository((blocked,))
    threads = BackgroundThreadFactory(blocked)
    controller, timers = _started_controller(
        repository,
        monotonic_clock=monotonic,
        thread_factory=threads,
    )
    controller.report_admission_failure(logical_root_ids=("root-a",))
    timers.timers[0].fire()
    assert blocked.entered.wait(1.0)

    with pytest.raises(WatcherSessionReplacedError):
        controller.set_participants(("root-a",))
    try:
        with pytest.raises(RuntimeError):
            controller.stop_retry_and_flush(deadline=monotonic() + 1.0)
        calls_before_test_cleanup = tuple(blocked.calls)
    finally:
        blocked.cancel()
        for thread in threads.threads:
            thread.join(1.0)
    blocked.force_late_commit(repository)

    assert calls_before_test_cleanup == (
        "execute",
        "cancel",
        "closed",
        "joined",
    )
    assert repository.late_commit_count == 0
    assert repository.finish_calls == []


@pytest.mark.parametrize(
    ("operation", "lock_attribute"),
    (
        ("stop", "_thread_start_lock"),
        ("replacement", "_stop_lock"),
    ),
)
def test_cleanup_lock_acquisition_is_bounded_by_its_absolute_deadline(
    operation,
    lock_attribute,
):
    from music_app.services.watcher_recovery_postgres import (
        WatcherSessionReplacedError,
    )

    class ReplacedRepository(FakeRepository):
        def set_runtime_session_participants(self, **_kwargs):
            raise WatcherSessionReplacedError("root-a token=private")

    now = [10.0]
    repository = ReplacedRepository()
    timers = FakeTimerFactory()
    controller, _ = _started_controller(
        repository,
        monotonic_clock=lambda: now[0],
        timer_factory=timers,
    )
    controller.report_admission_failure(logical_root_ids=("root-a",))
    gate = _DeadlineGateLock()
    setattr(controller, lock_attribute, gate)
    errors = []
    completed = Event()

    def invoke_cleanup():
        try:
            if operation == "stop":
                controller.stop_retry_and_flush(deadline=11.0)
            else:
                controller.set_participants(("root-a",))
        except Exception as exc:
            errors.append(exc)
        finally:
            completed.set()

    worker = Thread(
        target=invoke_cleanup,
        name=f"deadline-{operation}",
        daemon=True,
    )
    worker.start()
    assert gate.acquire_entered.wait(1.0)
    now[0] = 12.0
    returned_by_deadline = completed.wait(0.2)
    gate.release_waiter.set()
    worker.join(1.0)

    for timer in tuple(timers.timers):
        timer.fire()

    assert returned_by_deadline is True
    assert errors
    assert controller._flush_succeeded is False
    assert controller._finished is False
    assert repository.prepare_calls == []
    assert repository.committed_write_count == 0
    assert repository.finish_calls == []


def test_final_flush_callback_logs_only_sanitized_failure_metadata(caplog):
    class PrivateFinalFlushFailure(RuntimeError):
        pass

    class ExplodingFinalAttempt(FakeAttempt):
        def execute(self):
            self.execute_count += 1
            self._outcome = SimpleNamespace(
                state="rolled_back",
                committed_root_ids=(),
            )
            self._is_terminal = True
            raise PrivateFinalFlushFailure(
                "root-a C:/private/music token=secret raw-sql=(7)"
            )

    repository = FakeRepository((ExplodingFinalAttempt(),))
    controller, _ = _started_controller(
        repository,
        monotonic_clock=monotonic,
    )
    controller.report_admission_failure(logical_root_ids=("root-a",))
    caplog.set_level(
        logging.WARNING,
        logger="music_app.services.watcher_session_recovery",
    )

    with pytest.raises(RuntimeError):
        controller.stop_retry_and_flush(deadline=monotonic() + 1.0)

    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert record.operation == "final_flush"
    assert record.root_count == 1
    assert record.exception_class == "PrivateFinalFlushFailure"
    rendered = f"{record.getMessage()} {record.__dict__!r}"
    assert "root-a" not in rendered
    assert "C:/private" not in rendered
    assert "secret" not in rendered
    assert "raw-sql" not in rendered


def test_cleanup_atomically_invalidates_retry_reserved_after_false_sample():
    now = [10.0]
    attempt = TerminalCancelAttempt()
    repository = FakeRepository((attempt,))
    timers = FakeTimerFactory()
    threads = PausedFirstStartThreadFactory(attempt)
    controller, _ = _started_controller(
        repository,
        monotonic_clock=lambda: now[0],
        timer_factory=timers,
        thread_factory=threads,
    )
    threads.controller = controller
    race_lock = _FalseSampleRaceLock()
    controller._thread_start_lock = race_lock
    controller.report_admission_failure(logical_root_ids=("root-a",))
    stop_errors = []
    stop_done = Event()
    fire_errors = []
    fire_thread = Thread(
        target=lambda: _capture_error(fire_errors, timers.timers[0].fire),
        name="false-sample-retry",
        daemon=True,
    )
    fire_thread.start()
    retry_reserved = threads.start_entered.wait(0.2)

    def stop_controller():
        try:
            controller.stop_retry_and_flush(deadline=11.0)
        except Exception as exc:
            stop_errors.append(exc)
        finally:
            stop_done.set()

    stopper = Thread(
        target=stop_controller,
        name="false-sample-stop",
        daemon=True,
    )
    stopper.start()
    assert race_lock.sample_released.wait(1.0)
    now[0] = 12.0
    race_lock.allow_cleanup_to_continue.set()
    stop_done.wait(0.2)
    threads.release_start.set()
    fire_thread.join(1.0)
    stopper.join(1.0)
    for thread in threads.threads:
        if thread.ident is not None:
            thread.join(1.0)

    assert retry_reserved is True
    assert fire_errors == []
    assert stop_errors
    assert not any(
        "before it is started" in str(error) for error in stop_errors
    )
    assert threads.joined_before_start is False
    assert repository.prepare_calls == []
    assert repository.committed_write_count == 0
    assert controller._flush_succeeded is False


def test_retry_thread_start_failure_restores_pending_and_allows_retry(caplog):
    class PrivateThreadStartFailure(RuntimeError):
        pass

    error = PrivateThreadStartFailure(
        "root-a C:/private/music token=secret raw-thread-state"
    )
    threads = StartRaisesThenInlineThreadFactory(error)
    repository = FakeRepository()
    timers = FakeTimerFactory()
    controller, _ = _started_controller(
        repository,
        monotonic_clock=lambda: 10.0,
        timer_factory=timers,
        thread_factory=threads,
    )
    caplog.set_level(
        logging.WARNING,
        logger="music_app.services.watcher_session_recovery",
    )
    controller.report_admission_failure(logical_root_ids=("root-a",))
    callback_errors = []

    _capture_error(callback_errors, timers.timers[0].fire)

    assert callback_errors == []
    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert record.operation == "retry_thread_start"
    assert record.root_count == 1
    assert record.exception_class == "PrivateThreadStartFailure"
    rendered = f"{record.getMessage()} {record.__dict__!r}"
    assert "root-a" not in rendered
    assert "C:/private" not in rendered
    assert "secret" not in rendered
    assert "raw-thread-state" not in rendered
    assert controller._pending == {"root-a"}
    assert controller._in_flight == set()
    assert controller._callback_thread is None
    assert controller._attempt is None
    assert threads.failed_thread.join_count == 0
    assert repository.finish_calls == []
    assert len(timers.timers) == 2

    timers.timers[1].fire()

    assert repository.committed_write_count == 1
    controller.stop_retry_and_flush(deadline=11.0)
    assert threads.failed_thread.join_count == 0
