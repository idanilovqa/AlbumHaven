from __future__ import annotations

from dataclasses import dataclass, fields, is_dataclass
from datetime import datetime, timezone
from inspect import Parameter, signature
from pathlib import Path
from threading import Event, Thread
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
        if not self._thread.is_alive():
            self._joined_attempt.record_joined()

    def is_alive(self):
        return self._thread.is_alive()


class BackgroundThreadFactory:
    def __init__(self, joined_attempt):
        self.joined_attempt = joined_attempt

    def __call__(self, target, name):
        return BackgroundThread(target, name, self.joined_attempt)


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
