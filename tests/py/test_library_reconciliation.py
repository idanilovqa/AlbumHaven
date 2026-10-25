from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Event, Thread
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize("is_directory", [False, True])
@pytest.mark.parametrize("direction", ["enter", "leave"])
def test_boundary_crossing_moves_preserve_the_configured_endpoint(tmp_path, is_directory, direction):
    from music_app.services.library_watch import LibraryEventKind, publish_watchdog_event
    from types import SimpleNamespace

    root = tmp_path / "Music"
    root.mkdir()
    inside = root / ("Album" if is_directory else "track.flac")
    outside = tmp_path / ("OutsideAlbum" if is_directory else "outside.flac")
    source, destination = (outside, inside) if direction == "enter" else (inside, outside)
    events = []
    publish_watchdog_event(
        SimpleNamespace(event_type="moved", src_path=str(source), dest_path=str(destination), is_directory=is_directory),
        roots=[{"id": "main", "path": str(root)}], publish=events.append, clock=lambda: 12.0,
    )
    assert len(events) == 1
    event = events[0]
    assert event.kind is (LibraryEventKind.CREATED if direction == "enter" else LibraryEventKind.DELETED)
    assert event.root_id == "main"
    assert event.path == inside.resolve()
    assert event.destination is None and event.destination_root_id is None
    assert event.is_directory is is_directory
    assert event.observed_at == 12.0


def test_library_events_normalize_against_configured_root(tmp_path: Path):
    from music_app.services.library_reconciliation import (
        LibraryEventKind,
        normalize_library_event,
    )

    root = tmp_path / "music"
    root.mkdir()
    roots = [{"id": "main-root", "path": str(root)}]
    source = root / "Artist" / "Album" / "01.flac"
    destination = root / "Artist" / "Album" / "02.flac"

    created = normalize_library_event("created", source, roots=roots, observed_at=2.0)
    modified = normalize_library_event("modified", source, roots=roots)
    deleted = normalize_library_event("deleted", source, roots=roots)
    moved = normalize_library_event(
        "moved",
        source,
        destination=destination,
        roots=roots,
    )

    assert created is not None
    assert created.kind is LibraryEventKind.CREATED
    assert created.root_id == "main-root"
    assert created.path == source.resolve(strict=False)
    assert created.observed_at == 2.0
    assert modified is not None and modified.kind is LibraryEventKind.MODIFIED
    assert deleted is not None and deleted.kind is LibraryEventKind.DELETED
    assert moved is not None and moved.kind is LibraryEventKind.MOVED
    assert moved.destination == destination.resolve(strict=False)


def test_library_event_normalization_rejects_out_of_root(
    tmp_path: Path,
):
    from music_app.services.library_reconciliation import normalize_library_event

    first = tmp_path / "first"
    second = tmp_path / "second"
    outside = tmp_path / "outside"
    first.mkdir()
    second.mkdir()
    outside.mkdir()
    roots = [
        {"id": "first", "path": str(first)},
        {"id": "second", "path": str(second)},
    ]

    assert normalize_library_event("created", outside / "track.flac", roots=roots) is None
    moved = normalize_library_event(
        "moved",
        first / "track.flac",
        destination=second / "track.flac",
        roots=roots,
    )
    assert moved is not None
    assert moved.root_id == "first"
    assert moved.destination_root_id == "second"


@pytest.mark.parametrize("event_type", ["deleted", "moved"])
@pytest.mark.parametrize(
    ("relative_path", "is_directory"),
    [("Artist/Deleted Album", True), ("Artist/Album/01.flac", False)],
)
def test_watchdog_mapping_keeps_child_delete_and_move_events(
    tmp_path: Path, event_type: str, relative_path: str, is_directory: bool,
):
    from music_app.services.library_reconciliation import (
        LibraryEventKind,
        publish_watchdog_event,
        watchdog_event_kind,
    )

    root = tmp_path / "music"
    root.mkdir()
    roots = [{"id": "main", "path": str(root)}]
    published = []

    event = SimpleNamespace(
        event_type=event_type,
        src_path=str(root / relative_path),
        dest_path=str(root / "Artist" / "Moved Item") if event_type == "moved" else None,
        is_directory=is_directory,
    )

    publish_watchdog_event(event, roots=roots, publish=published.append, clock=lambda: 3.0)

    assert len(published) == 1
    assert published[0].kind is LibraryEventKind(event_type)
    assert published[0].path == (root / relative_path).resolve(strict=False)
    assert published[0].is_directory is is_directory
    assert published[0].destination == (
        (root / "Artist" / "Moved Item").resolve(strict=False)
        if event_type == "moved" else None
    )
    assert watchdog_event_kind("closed") is None
    assert watchdog_event_kind("created") is LibraryEventKind.CREATED


def test_watchdog_ignores_app_owned_cover_write(monkeypatch, tmp_path: Path):
    from music_app.services import library_watch

    root = tmp_path / "music"
    cover = root / "Artist" / "Album" / "cover.jpg"
    published = []
    monkeypatch.setattr(
        library_watch,
        "is_library_watch_event_suppressed",
        lambda path: Path(path) == cover.resolve(strict=False),
    )
    library_watch.publish_watchdog_event(
        SimpleNamespace(event_type="modified", src_path=str(cover), is_directory=False),
        roots=[{"id": "main", "path": str(root)}],
        publish=published.append,
        clock=lambda: 3.0,
    )
    assert published == []


def test_watchdog_ignores_cover_transaction_temp_files(tmp_path: Path):
    from music_app.services.library_reconciliation import publish_watchdog_event

    root = tmp_path / "music"
    artifact = root / "Artist" / "Album" / ".cover.jpg.abc.tmp"
    published = []
    publish_watchdog_event(
        SimpleNamespace(event_type="modified", src_path=str(artifact), is_directory=False),
        roots=[{"id": "main", "path": str(root)}],
        publish=published.append,
        clock=lambda: 3.0,
    )
    assert published == []


def test_external_cover_transaction_rename_is_published_as_cover_creation(tmp_path: Path):
    from music_app.services.library_reconciliation import (
        LibraryEventKind,
        publish_watchdog_event,
    )

    root = tmp_path / "music"
    artifact = root / "Artist" / "Album" / ".cover.jpg.abc.tmp"
    cover = root / "Artist" / "Album" / "cover.jpg"
    published = []
    publish_watchdog_event(
        SimpleNamespace(
            event_type="moved",
            src_path=str(artifact),
            dest_path=str(cover),
            is_directory=False,
        ),
        roots=[{"id": "main", "path": str(root)}],
        publish=published.append,
        clock=lambda: 3.0,
    )
    assert len(published) == 1
    assert published[0].kind is LibraryEventKind.CREATED
    assert published[0].path == cover.resolve(strict=False)


@pytest.mark.parametrize("event_type", ["deleted", "moved"])
@pytest.mark.parametrize("is_directory", [True, False])
def test_watchdog_maps_configured_root_disappearance_to_unavailable_health_event(
    tmp_path: Path, event_type: str, is_directory: bool,
):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import (
        LibraryEventKind,
        publish_watchdog_event,
    )

    root = tmp_path / "music"
    root.mkdir()
    root.rmdir()
    published = []
    admitted = []
    problems = []
    admission_failures = []
    coordinator = LibraryEventCoordinator(
        admitted.append,
        record_problem=problems.append,
        report_admission_failure=admission_failures.append,
    )

    def publish(event):
        published.append(event)
        coordinator.accept(event)

    event = SimpleNamespace(
        event_type=event_type,
        src_path=str(root),
        dest_path=str(tmp_path / "moved-music") if event_type == "moved" else None,
        is_directory=is_directory,
    )
    publish_watchdog_event(
        event,
        roots=[{"id": "main", "path": str(root)}],
        publish=publish,
        clock=lambda: 4.0,
    )

    assert admitted == []
    assert admission_failures == []
    assert len(published) == 1
    assert published[0].kind is LibraryEventKind.ROOT_UNAVAILABLE
    assert published[0].root_id == "main"
    assert published[0].path == root.resolve(strict=False)
    assert published[0].is_directory is True
    assert published[0].observed_at == 4.0
    assert [(problem.code, problem.root_id) for problem in problems] == [
        ("root_unavailable", "main")
    ]


def test_library_watch_service_starts_and_stops_injected_source_once(tmp_path: Path):
    from music_app.services.library_reconciliation import (
        LibraryEvent,
        LibraryEventKind,
        LibraryWatchService,
    )

    events: list[LibraryEvent] = []

    class Source:
        def __init__(self):
            self.started = 0
            self.stopped = 0
            self.is_alive = False

        def start(self, publish):
            self.started += 1
            self.is_alive = True
            publish(
                LibraryEvent(
                    LibraryEventKind.CREATED,
                    "root",
                    tmp_path / "track.flac",
                )
            )

        def stop(self, *, timeout):
            assert timeout == 1.25
            self.stopped += 1
            self.is_alive = False

    source = Source()
    service = LibraryWatchService(source, events.append, stop_timeout=1.25)

    assert service.start() is True
    assert service.start() is False
    assert source.started == 1
    assert len(events) == 1
    assert service.stop() is True
    assert service.stop() is False
    assert source.stopped == 1
    assert source.is_alive is False


def test_library_watch_service_timed_stop_bounds_lock_wait(monkeypatch):
    import time
    from music_app.services import library_watch

    calls = []

    class Lock:
        def acquire(self, *, timeout):
            calls.append(timeout)
            return False

    service = library_watch.LibraryWatchService(None, lambda _event: None)
    service._lock = Lock()
    monkeypatch.setattr(time, "monotonic", lambda: 100.0)
    with pytest.raises(TimeoutError, match="watcher.*deadline"):
        service.stop(timeout=0.25)
    assert calls == [0.25]


def test_library_watch_service_replaces_roots_by_restarting_source():
    from music_app.services.library_reconciliation import LibraryWatchService

    calls = []

    class Source:
        is_alive = False

        def start(self, _publish):
            calls.append("start")

        def stop(self, *, timeout):
            calls.append(("stop", timeout))

        def replace_roots(self, roots):
            calls.append(("roots", tuple(root["id"] for root in roots)))

    service = LibraryWatchService(Source(), lambda _event: None, stop_timeout=2.0)
    service.start()

    assert service.replace_roots([{"id": "new-root", "path": "D:/Music"}]) is True
    assert calls == ["start", ("stop", 2.0), ("roots", ("new-root",)), "start"]


def _capturing_observer():
    class Observer:
        ident = None
        emitters = ()

        def __init__(self):
            self.handlers = []
            self.alive = False

        def schedule(self, handler, _path, *, recursive):
            assert recursive
            self.handlers.append(handler)

        def start(self):
            self.alive = True

        def stop(self):
            self.alive = False

        def join(self, _timeout):
            return None

        def is_alive(self):
            return self.alive

    return Observer()


def test_pre_attribution_dispatch_failure_reports_copied_configured_root_ids(
    monkeypatch, tmp_path: Path,
):
    from music_app.services import library_watch

    private_root = tmp_path / "private-music-root"
    second_root = tmp_path / "second-music-root"
    private_root.mkdir()
    second_root.mkdir()
    roots = (
        {"id": "root-a", "path": private_root},
        {"id": "root-b", "path": second_root},
    )
    observer = _capturing_observer()
    unattributed_reports = []
    monkeypatch.setattr(
        library_watch,
        "publish_watchdog_event",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("normalization failed")
        ),
    )
    source = library_watch.WatchdogLibraryEventSource(
        roots,
        observer_factory=lambda: observer,
        report_unattributed_failure=unattributed_reports.append,
    )
    try:
        source.start(lambda _event: None)
        observer.handlers[0].on_any_event(
            SimpleNamespace(
                event_type="created",
                src_path=str(private_root / "Album" / "track.flac"),
                is_directory=False,
            )
        )
    finally:
        source.stop(timeout=1.0)

    assert unattributed_reports == [("root-a", "root-b")]
    assert all(isinstance(value, str) for value in unattributed_reports[0])
    assert str(private_root) not in repr(unattributed_reports)


def test_replace_roots_normalization_failure_preserves_and_reports_old_roots(
    tmp_path: Path,
):
    from music_app.services.library_watch import WatchdogLibraryEventSource

    original = LookupError("root id conversion failed")

    class FailingRootId:
        def __str__(self):
            raise original

    old_roots = (
        {"id": "root-a", "path": tmp_path / "private-a"},
        {"id": "root-b", "path": tmp_path / "private-b"},
    )
    unattributed_reports = []
    source = WatchdogLibraryEventSource(
        old_roots,
        report_unattributed_failure=unattributed_reports.append,
    )
    old_root_snapshot = source._roots
    old_id_snapshot = source._configured_root_ids

    with pytest.raises(LookupError) as caught:
        source.replace_roots(
            ({"id": FailingRootId(), "path": tmp_path / "replacement"},)
        )

    assert caught.value is original
    assert source._roots == old_root_snapshot
    assert source._configured_root_ids == old_id_snapshot
    assert unattributed_reports == [("root-a", "root-b")]
    assert all(isinstance(root_id, str) for root_id in unattributed_reports[0])
    assert all(str(root["path"]) not in repr(unattributed_reports) for root in old_roots)


def test_pre_attribution_reporter_failure_does_not_stop_later_dispatch(
    monkeypatch, tmp_path: Path,
):
    from music_app.services import library_watch

    root = tmp_path / "music"
    root.mkdir()
    observer = _capturing_observer()
    original = RuntimeError("normalization failed")
    dispatches = []
    unattributed_reports = []

    def publish_event(event, **_kwargs):
        if not dispatches:
            dispatches.append(original)
            raise original
        dispatches.append(event)

    def report(root_ids):
        unattributed_reports.append(root_ids)
        raise LookupError("recovery reporter unavailable")

    monkeypatch.setattr(library_watch, "publish_watchdog_event", publish_event)
    source = library_watch.WatchdogLibraryEventSource(
        ({"id": "root-a", "path": root},),
        observer_factory=lambda: observer,
        report_unattributed_failure=report,
    )
    try:
        source.start(lambda _event: None)
        first = SimpleNamespace(
            event_type="created",
            src_path=str(root / "first.flac"),
            is_directory=False,
        )
        second = SimpleNamespace(
            event_type="created",
            src_path=str(root / "second.flac"),
            is_directory=False,
        )

        observer.handlers[0].on_any_event(first)
        assert source.is_alive
        observer.handlers[0].on_any_event(second)
    finally:
        source.stop(timeout=1.0)

    assert dispatches == [original, second]
    assert unattributed_reports == [("root-a",)]


@pytest.mark.parametrize(
    "reporter_fails",
    [False, True],
    ids=["report-recorded", "reporter-failure-preserves-startup-error"],
)
def test_startup_instrumentation_failure_reports_all_configured_roots_once(
    monkeypatch, tmp_path: Path, reporter_fails: bool,
):
    from music_app.services.library_watch import WatchdogLibraryEventSource

    roots = tuple(
        {"id": root_id, "path": tmp_path / root_id}
        for root_id in ("root-a", "root-b")
    )
    for root in roots:
        Path(root["path"]).mkdir()
    unattributed_reports = []
    startup_failure = RuntimeError("instrumentation failed")

    def report(root_ids):
        unattributed_reports.append(root_ids)
        if reporter_fails:
            raise LookupError("recovery reporter unavailable")

    class Emitter:
        def __init__(self, path):
            self.watch = SimpleNamespace(path=path)
            self.run = lambda: None
            self.alive = True

        def is_alive(self):
            return self.alive

    class Observer:
        ident = None

        def __init__(self):
            self.emitters = set()
            self.alive = False

        def schedule(self, _handler, path, *, recursive):
            assert recursive
            emitter = Emitter(path)
            self.emitters.add(emitter)

        def start(self):
            self.alive = True

        def stop(self):
            self.alive = False
            for emitter in self.emitters:
                emitter.alive = False

        def join(self, _timeout):
            return None

        def is_alive(self):
            return self.alive

    observer = Observer()
    source = WatchdogLibraryEventSource(
        roots,
        observer_factory=lambda: observer,
        report_unattributed_failure=report,
    )
    monkeypatch.setattr(
        source,
        "_instrument_emitter",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(startup_failure),
    )

    with pytest.raises(RuntimeError) as caught:
        source.start(lambda _event: None)

    assert caught.value is startup_failure
    assert unattributed_reports == [("root-a", "root-b")]
    assert all(isinstance(value, str) for value in unattributed_reports[0])
    assert all(not emitter.is_alive() for emitter in observer.emitters)


def test_cross_root_normalized_failure_remains_coordinator_attributed(
    tmp_path: Path,
):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_watch import WatchdogLibraryEventSource

    root_paths = {
        root_id: tmp_path / root_id
        for root_id in ("root-a", "root-b", "root-c")
    }
    for root_path in root_paths.values():
        root_path.mkdir()
    exact_reports = []
    unattributed_reports = []
    coordinator = LibraryEventCoordinator(
        lambda _event: (_ for _ in ()).throw(
            RuntimeError("database unavailable")
        ),
        record_problem=lambda _problem: None,
        report_admission_failure=exact_reports.append,
    )
    observer = _capturing_observer()
    source = WatchdogLibraryEventSource(
        tuple(
            {"id": root_id, "path": root_path}
            for root_id, root_path in root_paths.items()
        ),
        observer_factory=lambda: observer,
        report_unattributed_failure=unattributed_reports.append,
    )
    try:
        source.start(coordinator.accept)
        observer.handlers[0].on_any_event(
            SimpleNamespace(
                event_type="moved",
                src_path=str(root_paths["root-a"] / "old.flac"),
                dest_path=str(root_paths["root-b"] / "new.flac"),
                is_directory=False,
            )
        )
    finally:
        source.stop(timeout=1.0)

    assert exact_reports == [("root-a", "root-b")]
    assert unattributed_reports == []


def test_native_watcher_reattaches_root_when_repair_restores_directory(tmp_path):
    from music_app.services.library_watch import (
        LibraryEventKind,
        WatchdogLibraryEventSource,
    )

    missing = tmp_path / "restored"
    timers = []

    class Timer:
        daemon = False

        def __init__(self, _delay, callback):
            self.callback = callback

        def start(self):
            timers.append(self)

        def cancel(self):
            pass

    class Emitter:
        def __init__(self, path):
            self.watch = SimpleNamespace(path=path)
            self.run = lambda: None
            self.alive = True

        def is_alive(self):
            return self.alive

    class Observer:
        ident = None

        def __init__(self):
            self.emitters = set()
            self.alive = False
            self.scheduled = []

        def schedule(self, _handler, path, *, recursive):
            self.scheduled.append((path, recursive))
            emitter = Emitter(path)
            self.emitters.add(emitter)
            return emitter.watch

        def start(self):
            self.alive = True

        def stop(self):
            self.alive = False
            for emitter in self.emitters:
                emitter.alive = False

        def join(self, _timeout):
            pass

        def is_alive(self):
            return self.alive

    observer = Observer()
    published = []
    source = WatchdogLibraryEventSource(
        ({"id": "restored", "path": missing},),
        observer_factory=lambda: observer,
        retry_timer_factory=Timer,
    )

    source.start(published.append)
    assert published[0].kind is LibraryEventKind.ROOT_UNAVAILABLE
    assert observer.scheduled == []
    assert len(timers) == 1

    missing.mkdir()
    timers.pop().callback()

    assert observer.scheduled == [(str(missing.resolve()), True)]
    assert timers == []
    assert source.is_alive
    source.stop(timeout=1.0)


def test_native_watcher_retry_cannot_attach_after_stop(tmp_path):
    from music_app.services.library_watch import WatchdogLibraryEventSource

    missing = tmp_path / "restored"
    timers = []
    schedule_entered = Event()
    release_schedule = Event()
    stop_returned = Event()

    class Timer:
        daemon = False

        def __init__(self, _delay, callback):
            self.callback = callback

        def start(self):
            timers.append(self)

        def cancel(self):
            pass

    class Emitter:
        def __init__(self, path):
            self.watch = SimpleNamespace(path=path)
            self.run = lambda: None
            self.alive = True

        def is_alive(self):
            return self.alive

    class Observer:
        ident = None

        def __init__(self):
            self.emitters = set()
            self.alive = False
            self.scheduled = []

        def schedule(self, _handler, path, *, recursive):
            schedule_entered.set()
            assert release_schedule.wait(1.0)
            self.scheduled.append((path, recursive))
            emitter = Emitter(path)
            self.emitters.add(emitter)
            return emitter.watch

        def start(self):
            self.alive = True

        def stop(self):
            self.alive = False
            for emitter in self.emitters:
                emitter.alive = False

        def join(self, _timeout):
            pass

        def is_alive(self):
            return self.alive

    observer = Observer()
    source = WatchdogLibraryEventSource(
        ({"id": "restored", "path": missing},),
        observer_factory=lambda: observer,
        retry_timer_factory=Timer,
    )
    source.start(lambda _event: None)
    missing.mkdir()
    retry = Thread(target=timers.pop().callback)
    retry.start()
    assert schedule_entered.wait(1.0)

    def stop_source():
        source.stop(timeout=1.0)
        stop_returned.set()

    stopper = Thread(target=stop_source)
    stopper.start()
    assert not stop_returned.wait(0.05)
    release_schedule.set()
    retry.join(1.0)
    stopper.join(1.0)

    assert not retry.is_alive()
    assert not stopper.is_alive()
    assert observer.scheduled == [(str(missing.resolve()), True)]
    assert all(not emitter.is_alive() for emitter in observer.emitters)


def test_native_watcher_ignores_cancelled_retry_from_previous_run(tmp_path):
    from music_app.services.library_watch import WatchdogLibraryEventSource

    missing = tmp_path / "missing"
    timers = []

    class Timer:
        daemon = False

        def __init__(self, _delay, callback):
            self.callback = callback

        def start(self):
            timers.append(self)

        def cancel(self):
            pass

    class Observer:
        ident = None
        emitters = ()

        def __init__(self):
            self.alive = False

        def start(self):
            self.alive = True

        def stop(self):
            self.alive = False

        def join(self, _timeout):
            pass

        def is_alive(self):
            return self.alive

    observers = iter((Observer(), Observer()))
    source = WatchdogLibraryEventSource(
        ({"id": "missing", "path": missing},),
        observer_factory=lambda: next(observers),
        retry_timer_factory=Timer,
    )
    source.start(lambda _event: None)
    stale_timer = timers.pop()
    source.stop(timeout=1.0)
    source.replace_roots(({"id": "missing", "path": missing},))
    source.start(lambda _event: None)

    assert len(timers) == 1
    current_timer = timers[0]
    stale_timer.callback()

    assert timers == [current_timer]
    source.stop(timeout=1.0)


def test_native_watcher_keeps_retrying_when_reattach_health_write_fails(tmp_path):
    from music_app.services.library_watch import WatchdogLibraryEventSource

    missing = tmp_path / "missing"
    timers = []
    health_write_fails = False

    class Timer:
        daemon = False

        def __init__(self, _delay, callback):
            self.callback = callback

        def start(self):
            timers.append(self)

        def cancel(self):
            pass

    class Observer:
        ident = None
        emitters = ()

        def __init__(self):
            self.alive = False

        def schedule(self, _handler, _path, *, recursive):
            assert recursive
            raise OSError("native attach failed")

        def start(self):
            self.alive = True

        def stop(self):
            self.alive = False

        def join(self, _timeout):
            pass

        def is_alive(self):
            return self.alive

    def publish(_event):
        if health_write_fails:
            raise RuntimeError("database unavailable")

    source = WatchdogLibraryEventSource(
        ({"id": "missing", "path": missing},),
        observer_factory=Observer,
        retry_timer_factory=Timer,
    )
    source.start(publish)
    retry = timers.pop()
    missing.mkdir()
    health_write_fails = True

    retry.callback()

    assert len(timers) == 1
    source.stop(timeout=1.0)


def _native_watch_health():
    from music_app.services.library_watch_health import LibraryWatchHealthService

    class Store:
        def __init__(self):
            self.problems = {}

        def upsert(self, problem):
            self.problems[problem.root_id] = problem

        def load(self):
            return list(self.problems.values())

        def clear(self, root_ids, *, detected_before):
            cleared = 0
            for root_id in root_ids:
                problem = self.problems.get(root_id)
                if problem is not None and problem.detected_at <= detected_before:
                    del self.problems[root_id]
                    cleared += 1
            return cleared

    return LibraryWatchHealthService(Store())


@pytest.mark.parametrize("failure_stage", ["schedule", "thread_start"])
def test_native_watcher_start_failure_records_health_and_cleans_partial_start(
    tmp_path: Path, failure_stage: str,
):
    from watchdog.observers.api import BaseObserver, EventEmitter

    from music_app.services.library_watch import WatchdogLibraryEventSource

    roots = [{"id": name, "path": str(tmp_path / name)} for name in ("first", "second")]
    for root in roots:
        Path(root["path"]).mkdir()
    started = []
    scheduled = []
    health = _native_watch_health()

    class NativeEmitter(EventEmitter):
        def on_thread_start(self):
            if failure_stage == "thread_start" and started:
                raise OSError("native start failed")
            started.append(self)

        def queue_events(self, _timeout):
            self.stopped_event.wait(2)

    class NativeObserver(BaseObserver):
        def schedule(self, *args, **kwargs):
            if failure_stage == "schedule" and scheduled:
                raise OSError("native schedule failed")
            watch = super().schedule(*args, **kwargs)
            scheduled.extend(self.emitters)
            return watch

    observer = NativeObserver(NativeEmitter)
    source = WatchdogLibraryEventSource(roots, observer_factory=lambda: observer)
    try:
        with pytest.raises(OSError, match=f"native {'start' if failure_stage == 'thread_start' else 'schedule'} failed"):
            source.start(health.record_event)
        assert not any(health.root_allows_destructive_reconciliation(root["id"]) for root in roots)
        assert source._observer is None
        assert not observer.is_alive()
        assert all(not emitter.is_alive() for emitter in scheduled)
    finally:
        # Even the unfixed startup path cannot leave a producer behind in RED.
        observer.stop()
        if observer.ident is not None:
            observer.join(2)
        for emitter in scheduled:
            if emitter.ident is not None:
                emitter.join(2)
        assert all(not emitter.is_alive() for emitter in scheduled)


def _recording_watchdog_observer_factory(calls):
    class Observer:
        emitters = ()
        ident = None

        def __init__(self):
            calls.append("construct")
            self.alive = False

        def schedule(self, _handler, root, *, recursive):
            calls.append(("schedule", root, recursive))

        def start(self):
            calls.append("start")
            self.alive = True

        def is_alive(self):
            return self.alive

        def stop(self):
            calls.append("stop")
            self.alive = False

        def join(self, timeout):
            calls.append(("join", timeout))

    return Observer


@pytest.mark.parametrize("platform", ["linux", "linux2"])
def test_linux_default_watcher_stays_idle_without_loading_native_backend(
    monkeypatch, tmp_path: Path, caplog, platform: str,
):
    import builtins
    import logging
    import sys

    import watchdog.observers

    from music_app.services.library_watch import (
        LibraryWatchService,
        WatchdogLibraryEventSource,
    )

    root = tmp_path / "private-music-root"
    root.mkdir()
    roots = [{"id": "main", "path": str(root)}]
    calls = []
    imports = []
    events = []
    source = WatchdogLibraryEventSource(roots)
    watcher = LibraryWatchService(source, events.append)
    original_import = builtins.__import__

    def record_import(name, *args, **kwargs):
        if name == "watchdog" or name.startswith("watchdog."):
            imports.append(name)
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(watchdog.observers, "Observer", _recording_watchdog_observer_factory(calls))
    monkeypatch.setattr(sys, "platform", platform)
    monkeypatch.setattr(builtins, "__import__", record_import)
    caplog.set_level(logging.INFO)
    try:
        assert watcher.start()
        assert calls == [], "Linux must not construct, schedule or start its native observer"
        assert imports == [], "Linux opt-out must precede importing the native backend"
        assert not watcher.is_alive
        assert source._observer is None
        assert events == []

        assert watcher.replace_roots([{"id": "unavailable", "path": str(root / "absent")}])
        assert watcher.stop()
        assert not watcher.stop()
        assert watcher.start()
        assert calls == []
        assert imports == []
        assert events == [], "intentional Linux opt-out must not invent root-health failures"
        assert not watcher.is_alive
        assert "Full Rescan" in caplog.text
        assert str(root) not in caplog.text
    finally:
        watcher.stop()
        assert not source.is_alive


@pytest.mark.parametrize(("platform", "injected"), [("win32", False), ("linux", True)])
def test_windows_default_and_explicit_linux_watcher_sources_still_start(
    monkeypatch, tmp_path: Path, platform: str, injected: bool,
):
    import sys

    import watchdog.observers

    from music_app.services.library_watch import LibraryWatchService, WatchdogLibraryEventSource

    root = tmp_path / "music"
    root.mkdir()
    calls = []
    events = []
    observer_factory = _recording_watchdog_observer_factory(calls)
    monkeypatch.setattr(watchdog.observers, "Observer", observer_factory)
    monkeypatch.setattr(sys, "platform", platform)
    source = WatchdogLibraryEventSource(
        [{"id": "main", "path": str(root)}],
        observer_factory=observer_factory if injected else None,
    )
    watcher = LibraryWatchService(source, events.append)
    try:
        assert watcher.start()
        assert calls == ["construct", ("schedule", str(root.resolve()), True), "start"]
        assert watcher.is_alive
        assert events == []
    finally:
        watcher.stop()
        assert not source.is_alive
    assert calls[-1] == "stop"
    assert events == []


def test_periodic_reconciliation_worker_is_removed():
    from music_app.services import library_reconciliation

    assert not hasattr(library_reconciliation, "run_library_reconciliation_loop")
    assert "periodic_reconciliation" not in Path(library_reconciliation.__file__).read_text(
        encoding="utf-8"
    )


def test_scan_records_only_successfully_observed_root_ids(monkeypatch, tmp_path: Path):
    from music_app.services import state

    available = tmp_path / "available"
    available.mkdir()
    unavailable = tmp_path / "unavailable"
    roots = [
        {"id": "available-root", "path": str(available), "category": "main_library_roots"},
        {"id": "offline-root", "path": str(unavailable), "category": "main_library_roots"},
    ]
    publication_state: dict[str, object] = {}
    captured: dict[str, object] = {}

    monkeypatch.setattr(state, "iter_library_root_paths", lambda _config: [available, unavailable])
    monkeypatch.setattr(state, "get_library_roots", lambda _config: roots)
    monkeypatch.setattr(state, "load_exception_overrides", lambda _config: {})

    def fake_scan(_library_state, **kwargs):
        captured.update(kwargs)
        return {}, 42.0

    monkeypatch.setattr(state, "scan_library_file_cache", fake_scan)

    result = state.scan_music_incremental(
        config={
            "MUSIC_DIR": available,
            "SUPPORTED_EXTENSIONS": {".flac"},
            "IMAGE_EXTENSIONS": {".jpg"},
        },
        logger=SimpleNamespace(),
        library_state={},
        publication_state=publication_state,
    )

    assert result == ({}, 42.0)
    assert captured["roots"] == [available]
    assert publication_state["observed_library_root_ids"] == {"available-root"}


@pytest.mark.parametrize("case_sensitive", [True, False], ids=["posix-distinct-roots", "windows-equivalent-path"])
def test_scan_observed_roots_preserve_filesystem_case_identity(monkeypatch, case_sensitive):
    import ntpath
    import posixpath
    from pathlib import PurePosixPath
    from music_app.services import state

    class ObservedPath(PurePosixPath):
        def resolve(self, strict=False):
            return self

        def exists(self):
            return str(self) == "/media/Music"

    available = ObservedPath("/media/Music")
    unavailable = ObservedPath("/media/music")
    roots = [
        {"id": "available-root", "path": str(available if case_sensitive else unavailable), "category": "main_library_roots"},
    ]
    if case_sensitive:
        roots.append({"id": "offline-root", "path": str(unavailable), "category": "main_library_roots"})
    publication_state = {}
    monkeypatch.setattr(state, "Path", ObservedPath)
    monkeypatch.setattr(state, "normcase", posixpath.normcase if case_sensitive else ntpath.normcase, raising=False)
    monkeypatch.setattr(state, "iter_library_root_paths", lambda _config: [available, unavailable])
    monkeypatch.setattr(state, "get_library_roots", lambda _config: roots)
    monkeypatch.setattr(state, "load_exception_overrides", lambda _config: {})

    def scan(_library_state, **kwargs):
        assert kwargs["roots"] == [available]
        assert publication_state["observed_library_root_ids"] == {"available-root"}, "an unavailable root must never authorize stale-file publication"
        return {}, 42.0

    monkeypatch.setattr(state, "scan_library_file_cache", scan)
    assert state.scan_music_incremental(
        config={"MUSIC_DIR": available, "SUPPORTED_EXTENSIONS": {".flac"}, "IMAGE_EXTENSIONS": {".jpg"}},
        logger=SimpleNamespace(), library_state={}, publication_state=publication_state,
    ) == ({}, 42.0)
    assert publication_state["observed_library_root_ids"] == {"available-root"}


@pytest.mark.parametrize("failure_action", [
    "Library directory read failed",
    "Library directory entry inspection failed",
    "Library candidate file stat failed",
])
def test_scan_does_not_publish_missing_inventory_for_root_with_traversal_error(
    monkeypatch,
    tmp_path: Path,
    failure_action,
):
    from music_app.services import state

    readable = tmp_path / "readable"
    unreadable = tmp_path / "unreadable"
    readable.mkdir()
    unreadable.mkdir()
    roots = [
        {"id": "readable-root", "path": str(readable), "category": "main_library_roots"},
        {"id": "unreadable-root", "path": str(unreadable), "category": "main_library_roots"},
    ]
    publication_state: dict[str, object] = {}

    monkeypatch.setattr(state, "iter_library_root_paths", lambda _config: [readable, unreadable])
    monkeypatch.setattr(state, "get_library_roots", lambda _config: roots)
    monkeypatch.setattr(state, "load_exception_overrides", lambda _config: {})

    def fake_scan(_library_state, **kwargs):
        kwargs["record_file_error"](
            failure_action,
            path=unreadable / "restricted-child",
            error=PermissionError("access denied"),
        )
        assert publication_state["observed_library_root_ids"] == {"readable-root"}
        return {}, 42.0

    monkeypatch.setattr(state, "scan_library_file_cache", fake_scan)

    state.scan_music_incremental(
        config={
            "MUSIC_DIR": readable,
            "SUPPORTED_EXTENSIONS": {".flac"},
            "IMAGE_EXTENSIONS": {".jpg"},
        },
        logger=SimpleNamespace(log=lambda *_args, **_kwargs: None),
        library_state={},
        publication_state=publication_state,
    )

    assert publication_state["observed_library_root_ids"] == {"readable-root"}


def test_stale_publication_is_limited_to_observed_roots_and_preserves_first_timestamp():
    from music_app.services import scan_cache_persistence

    sql = " ".join(scan_cache_persistence._mark_stale_track_files_sql().casefold().split())

    assert "library.library_roots" in sql
    assert "metadata ->> 'root_id'" in sql
    assert "observed_root_ids" in sql
    assert "scan_cache_stale is false" in sql
    assert "stale_marked_at" in sql


def test_stale_publication_does_not_reference_update_target_from_join_on_clause():
    from music_app.services import scan_cache_persistence

    sql = " ".join(scan_cache_persistence._mark_stale_track_files_sql().casefold().split())

    update_clause = sql.split("update library.local_track_files", 1)[1]
    from_clause, where_clause = update_clause.split(" where ", 1)
    assert "library.local_track_files.library_root_id" not in from_clause
    assert (
        "library.library_roots.id = library.local_track_files.library_root_id"
        in where_clause
    )


def test_active_track_file_upsert_clears_prior_stale_timestamp():
    from music_app.services import scan_cache_persistence

    sql = " ".join(scan_cache_persistence._upsert_local_track_file_sql().casefold().split())

    assert "scan_cache,stale_marked_at" in sql
    assert "#-" in sql


@pytest.mark.parametrize("event_type", ["created", "modified", "deleted", "moved"])
@pytest.mark.parametrize("is_directory", [False, True])
def test_derived_cover_preview_events_do_not_enter_reconciliation(tmp_path, event_type, is_directory):
    from music_app.services.library_watch import publish_watchdog_event
    root = tmp_path / "Music"
    source = root / "Album" / ".album-haven" / "cover_variants" / "ab" / "image.jpg.tmp"
    destination = source.with_suffix("")
    events = []
    publish_watchdog_event(
        SimpleNamespace(event_type=event_type, src_path=str(source), dest_path=str(destination), is_directory=is_directory),
        roots=[{"id": "main", "path": str(root)}], publish=events.append, clock=lambda: 1.0,
    )
    assert events == []


def test_watchdog_uses_aware_utc_acceptance_time_without_leaking_cover_variants(
    tmp_path,
):
    from music_app.services.library_watch import publish_watchdog_event

    root = tmp_path / "Music"
    accepted_at = datetime(
        2026,
        10,
        9,
        8,
        30,
        tzinfo=timezone(timedelta(hours=-4)),
    )
    events = []
    publish_watchdog_event(
        SimpleNamespace(
            event_type="created",
            src_path=str(root / "Album" / "track.flac"),
            is_directory=False,
        ),
        roots=[{"id": "main", "path": str(root)}],
        publish=events.append,
        clock=lambda: accepted_at,
    )
    publish_watchdog_event(
        SimpleNamespace(
            event_type="modified",
            src_path=str(
                root
                / "Album"
                / ".album-haven"
                / "cover_variants"
                / "ab"
                / "preview.webp"
            ),
            is_directory=False,
        ),
        roots=[{"id": "main", "path": str(root)}],
        publish=events.append,
        clock=lambda: accepted_at,
    )

    assert len(events) == 1
    assert events[0].observed_at == accepted_at.astimezone(timezone.utc)
    assert events[0].observed_at.tzinfo is timezone.utc


def test_watcher_uses_shared_managed_preview_classifier(tmp_path, monkeypatch):
    from music_app.services import library_watch

    root = tmp_path / "Music"
    source = root / "Album" / "generated.bin"
    events = []
    monkeypatch.setattr(
        library_watch,
        "is_managed_preview_path",
        lambda path: path == source.resolve(strict=False),
    )

    library_watch.publish_watchdog_event(
        SimpleNamespace(event_type="modified", src_path=str(source), is_directory=False),
        roots=[{"id": "main", "path": str(root)}],
        publish=events.append,
        clock=lambda: 1.0,
    )

    assert events == []


@pytest.mark.parametrize("relative", ["Album/track.flac", "Album/cover.jpg", "Album/.album-haven/track.flac", "Album/cover_variants/track.flac"])
def test_source_files_outside_derived_cover_storage_still_publish(tmp_path, relative):
    from music_app.services.library_watch import publish_watchdog_event
    root = tmp_path / "Music"
    events = []
    publish_watchdog_event(
        SimpleNamespace(event_type="modified", src_path=str(root / relative), is_directory=False),
        roots=[{"id": "main", "path": str(root)}], publish=events.append, clock=lambda: 1.0,
    )
    assert len(events) == 1


@pytest.mark.parametrize("leaving_derived", [False, True])
@pytest.mark.parametrize("is_directory", [False, True])
def test_moves_crossing_derived_cover_storage_preserve_user_endpoint(tmp_path, leaving_derived, is_directory):
    from music_app.services.library_watch import LibraryEventKind, publish_watchdog_event
    root = tmp_path / "Music"
    derived = root / "Album/.album-haven/cover_variants/ab/item"
    user = root / "Album/track.flac"
    source, destination = (derived, user) if leaving_derived else (user, derived)
    events = []
    publish_watchdog_event(
        SimpleNamespace(event_type="moved", src_path=str(source), dest_path=str(destination), is_directory=is_directory),
        roots=[{"id": "main", "path": str(root)}], publish=events.append, clock=lambda: 1.0,
    )
    assert len(events) == 1
    assert events[0].kind is (LibraryEventKind.CREATED if leaving_derived else LibraryEventKind.DELETED)
    assert events[0].path == user.resolve()
    assert events[0].destination is None
    assert events[0].is_directory is is_directory


@pytest.mark.parametrize("event_type", ["deleted", "moved"])
def test_derived_cover_storage_case_matches_native_path_semantics(tmp_path, event_type):
    from music_app.services.library_watch import publish_watchdog_event
    root = tmp_path / "Music"
    source = root / "Album/.ALBUM-HAVEN/Cover_Variants/ab/image.jpg.tmp"
    destination = source.with_suffix("")
    events = []
    publish_watchdog_event(
        SimpleNamespace(event_type=event_type, src_path=str(source), dest_path=str(destination), is_directory=False),
        roots=[{"id": "main", "path": str(root)}], publish=events.append, clock=lambda: 1.0,
    )
    assert len(events) == (0 if Path("A") == Path("a") else 1)
