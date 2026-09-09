from __future__ import annotations

from pathlib import Path
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
    requests = []
    coordinator = LibraryEventCoordinator(
        emit_request=requests.append,
        emit_health_event=published.append,
    )

    event = SimpleNamespace(
        event_type=event_type,
        src_path=str(root),
        dest_path=str(tmp_path / "moved-music") if event_type == "moved" else None,
        is_directory=is_directory,
    )
    publish_watchdog_event(
        event,
        roots=[{"id": "main", "path": str(root)}],
        publish=coordinator.accept,
        clock=lambda: 4.0,
    )
    coordinator.flush()

    assert requests == []
    assert len(published) == 1
    assert published[0].kind is LibraryEventKind.ROOT_UNAVAILABLE
    assert published[0].root_id == "main"
    assert published[0].path == root.resolve(strict=False)
    assert published[0].is_directory is True
    assert published[0].observed_at == 4.0


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


@pytest.mark.parametrize(
    ("failure", "restart_failure"),
    [("zero_bytes", False), ("notify_enum_dir", False), ("zero_bytes", True)],
)
def test_native_windows_overflow_blocks_destruction_until_manual_recovery(
    monkeypatch, tmp_path: Path, failure: str, restart_failure: bool,
):
    import ctypes
    import os
    import queue
    import struct
    from threading import Event

    if os.name != "nt":
        pytest.skip("Exercises the installed Windows Watchdog native backend")
    from watchdog.observers import read_directory_changes, winapi

    from music_app import _recover_library_watch_after_manual_scan
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_watch import (
        LibraryEventKind, LibraryWatchService, WatchdogLibraryEventSource,
    )

    root = tmp_path / "music"
    root.mkdir()
    track = root / "01.flac"
    track.write_bytes(b"complete")
    roots = [{"id": "main", "path": str(root)}]
    reads = []
    health_seen = Event()
    track_seen = Event()
    published = []
    requests = []
    health = _native_watch_health()
    fail_open = False

    def open_handle(_path):
        if fail_open:
            raise OSError("native directory handle unavailable")
        commands = queue.Queue()
        reads.append(commands)
        return commands

    def read_changes(handle, buffer, _size, _recursive, _flags, nbytes, *_args):
        command = handle.get(timeout=3)
        if command == "zero_bytes":
            return
        if command in {"stop", "notify_enum_dir"}:
            error = OSError("native notification read interrupted")
            error.winerror = 995 if command == "stop" else 1022
            raise error
        assert command == "created"
        name = "01.flac".encode("utf-16-le")
        record = struct.pack("<III", 0, winapi.FILE_ACTION_CREATED, len(name)) + name
        ctypes.memmove(buffer, record, len(record))
        ctypes.cast(nbytes, ctypes.POINTER(winapi.DWORD)).contents.value = len(record)

    monkeypatch.setattr(read_directory_changes, "get_directory_handle", open_handle)
    monkeypatch.setattr(
        read_directory_changes, "close_directory_handle", lambda handle: handle.put("stop"),
    )
    monkeypatch.setattr(winapi, "ReadDirectoryChangesW", read_changes)
    monkeypatch.setattr(winapi, "_is_observed_path_deleted", lambda *_args: False)
    # A failed baseline emitter must not leak a thread exception into other tests.
    monkeypatch.setattr("threading.excepthook", lambda _args: None)

    def record_health(event):
        published.append(event)
        health.record_event(event)
        health_seen.set()

    coordinator = LibraryEventCoordinator(
        emit_request=requests.append,
        emit_health_event=record_health,
        stable_sample_interval=0,
    )

    def publish(event):
        coordinator.accept(event)
        if event.kind is LibraryEventKind.CREATED:
            track_seen.set()

    source = WatchdogLibraryEventSource(roots, clock=lambda: 8.0)
    watcher = LibraryWatchService(source, publish)
    observers = []
    emitters = []
    try:
        watcher.start()
        observers.append(source._observer)
        emitters.extend(source._observer.emitters)
        assert isinstance(emitters[0], read_directory_changes.WindowsApiEmitter)
        reads[-1].put(failure)
        assert health_seen.wait(2), "native notification loss never reached library health"
        assert published[0].kind is LibraryEventKind.OVERFLOW
        assert published[0].root_id == "main"
        assert published[0].path == root.resolve()
        assert published[0].observed_at == 8.0
        assert not health.root_allows_destructive_reconciliation("main")
        coordinator.flush()
        assert requests == []
        assert health.clear_after_scan(
            scan_mode="incremental", observed_root_ids={"main"},
        ) == 0
        assert not health.root_allows_destructive_reconciliation("main")

        recovery = dict(
            health_service=health,
            targeted_reconciler=SimpleNamespace(replace_roots=lambda _roots: None),
            watch_service=watcher,
            root_definitions=roots,
            scan_mode="manual_full_rescan",
            scan_started_at=None,
            observed_root_ids={"main"},
        )
        if restart_failure:
            fail_open = True
            with pytest.raises(OSError, match="native directory handle unavailable"):
                _recover_library_watch_after_manual_scan(**recovery)
            assert not health.root_allows_destructive_reconciliation("main")
            assert published[-1].kind is LibraryEventKind.ROOT_UNAVAILABLE
            assert source._observer is None
            assert not watcher.is_alive
            return
        assert _recover_library_watch_after_manual_scan(**recovery) == 1
        observers.append(source._observer)
        emitters.extend(source._observer.emitters)
        assert len(reads) == 2
        assert watcher.is_alive
        assert health.root_allows_destructive_reconciliation("main")
        reads[-1].put("created")
        assert track_seen.wait(2)
        coordinator.flush()
        assert len(requests) == 1
        assert requests[0].paths == frozenset({track.resolve()})
    finally:
        watcher.stop()
        coordinator.stop()
        assert all(not observer.is_alive() for observer in observers)
        assert all(not emitter.is_alive() for emitter in emitters)
    assert len(published) == 1, "intentional shutdown must not create a health failure"


@pytest.mark.parametrize("termination", ["exception", "early_return"])
def test_native_emitter_termination_is_unhealthy_while_dispatcher_is_alive(
    monkeypatch, tmp_path: Path, termination: str,
):
    from threading import Event

    from watchdog.observers.api import BaseObserver, EventEmitter

    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_watch import (
        LibraryEventKind, LibraryWatchService, WatchdogLibraryEventSource,
    )

    failed_root = tmp_path / "failed"
    healthy_root = tmp_path / "healthy"
    failed_root.mkdir()
    healthy_root.mkdir()
    trigger = Event()
    observed_exceptions = []
    published = []
    requests = []
    health = _native_watch_health()

    class NativeEmitter(EventEmitter):
        def queue_events(self, _timeout):
            if Path(self.watch.path) == failed_root:
                assert trigger.wait(2)
                if termination == "exception":
                    raise OSError("native emitter failure")
                self.stop()
            else:
                self.stopped_event.wait(2)

    monkeypatch.setattr("threading.excepthook", observed_exceptions.append)

    def record_health(event):
        published.append(event)
        health.record_event(event)

    coordinator = LibraryEventCoordinator(
        emit_request=requests.append, emit_health_event=record_health,
    )
    source = WatchdogLibraryEventSource(
        [
            {"id": "failed", "path": str(failed_root)},
            {"id": "healthy", "path": str(healthy_root)},
        ],
        observer_factory=lambda: BaseObserver(NativeEmitter),
        clock=lambda: 9.0,
    )
    watcher = LibraryWatchService(source, coordinator.accept)
    observer = None
    emitters = ()
    try:
        watcher.start()
        observer = source._observer
        emitters = tuple(observer.emitters)
        failed = next(emitter for emitter in emitters if Path(emitter.watch.path) == failed_root)
        trigger.set()
        failed.join(2)
        assert not failed.is_alive()
        assert observer.is_alive(), "the real dispatcher outlives its failed producer"
        assert not watcher.is_alive, "dispatcher liveness must not hide emitter termination"
        assert len(published) == 1
        assert published[0].kind is LibraryEventKind.ROOT_UNAVAILABLE
        assert published[0].root_id == "failed"
        assert published[0].observed_at == 9.0
        assert not health.root_allows_destructive_reconciliation("failed")
        assert health.root_allows_destructive_reconciliation("healthy")
        coordinator.flush()
        assert requests == []
        assert len(observed_exceptions) == (1 if termination == "exception" else 0)
    finally:
        trigger.set()
        watcher.stop()
        coordinator.stop()
        assert observer is None or not observer.is_alive()
        assert all(not emitter.is_alive() for emitter in emitters)
    assert len(published) == 1


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
def test_linux_default_watcher_stays_idle_through_manual_recovery(
    monkeypatch, tmp_path: Path, caplog, platform: str,
):
    import builtins
    import logging
    import sys

    import watchdog.observers

    from music_app import _recover_library_watch_after_manual_scan
    from music_app.services.library_watch import (
        LibraryEvent, LibraryEventKind, LibraryWatchService, WatchdogLibraryEventSource,
    )

    root = tmp_path / "private-music-root"
    root.mkdir()
    roots = [{"id": "main", "path": str(root)}]
    calls = []
    imports = []
    events = []
    health = _native_watch_health()
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
        assert health.root_allows_destructive_reconciliation("main")

        health.record_event(LibraryEvent(LibraryEventKind.OVERFLOW, "main", root, observed_at=1.0))
        assert not health.root_allows_destructive_reconciliation("main")
        reconciler_roots = []
        assert _recover_library_watch_after_manual_scan(
            health_service=health,
            targeted_reconciler=SimpleNamespace(replace_roots=reconciler_roots.append),
            watch_service=watcher,
            root_definitions=roots,
            scan_mode="manual_full_rescan",
            scan_started_at=None,
            observed_root_ids={"main"},
        ) == 1
        assert reconciler_roots == [tuple(roots)]
        assert health.root_allows_destructive_reconciliation("main")

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


def test_scan_does_not_publish_missing_inventory_for_root_with_traversal_error(
    monkeypatch,
    tmp_path: Path,
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
            "Library directory read failed",
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
