"""Real Watchdog dispatcher and producer lifetime regression checks."""

import os
from threading import Event, Timer
from time import monotonic

import pytest
from watchdog.events import FileModifiedEvent
from watchdog.observers.api import BaseObserver, EventEmitter

from music_app.services import library_watch
from tests.py.test_library_reconciliation import _native_watch_health


@pytest.mark.parametrize("failure", ["normalization", "publication"])
def test_dispatch_failure_records_root_health_without_losing_dispatcher(tmp_path, monkeypatch, failure):
    health = _native_watch_health()
    recorded = Event()
    delivered = Event()
    exceptions = []
    monkeypatch.setattr("threading.excepthook", exceptions.append)

    class IdleEmitter(EventEmitter):
        def queue_events(self, _timeout):
            self.stopped_event.wait(2)

    observer = BaseObserver(IdleEmitter)
    original_publish = library_watch.publish_watchdog_event
    failed = False

    def normalize(event, **kwargs):
        nonlocal failed
        if failure == "normalization" and not failed:
            failed = True
            raise RuntimeError("cyclic link cannot resolve")
        return original_publish(event, **kwargs)

    def publish(event):
        nonlocal failed
        if event.kind is library_watch.LibraryEventKind.ROOT_UNAVAILABLE:
            health.record_event(event)
            recorded.set()
        elif failure == "publication" and not failed:
            failed = True
            raise OSError("publication callback failed")
        else:
            delivered.set()

    monkeypatch.setattr(library_watch, "publish_watchdog_event", normalize)
    source = library_watch.WatchdogLibraryEventSource(
        [{"id": "main", "path": str(tmp_path)}], observer_factory=lambda: observer,
    )
    emitters = ()
    try:
        source.start(publish)
        emitters = tuple(observer.emitters)
        watch = emitters[0].watch
        observer.event_queue.put((FileModifiedEvent(str(tmp_path / "first.flac")), watch))
        assert recorded.wait(1), "dispatcher failure must persist unhealthy root state"
        assert not health.root_allows_destructive_reconciliation("main")
        assert observer.is_alive() and all(emitter.is_alive() for emitter in emitters)
        observer.event_queue.put((FileModifiedEvent(str(tmp_path / "second.flac")), watch))
        assert delivered.wait(1), "one bad event must not silently terminate intake"
        assert exceptions == []
    finally:
        source.stop(timeout=2)
        assert not observer.is_alive()
        assert all(not emitter.is_alive() for emitter in emitters)


@pytest.mark.parametrize("blocked_owner", ["dispatcher", "emitter", "emitter_health"])
def test_native_stop_deadline_retains_ownership_until_blocked_callback_exits(tmp_path, blocked_owner):
    entered = Event()
    release = Event()

    emitter_type = EventEmitter
    if os.name == "nt":
        from watchdog.observers.read_directory_changes import WindowsApiEmitter
        emitter_type = WindowsApiEmitter

    class BlockingEmitter(emitter_type):
        def queue_events(self, _timeout):
            if blocked_owner == "emitter":
                entered.set()
                release.wait(2)
            elif blocked_owner == "emitter_health":
                self.stop()
            else:
                self.stopped_event.wait(2)

    observer = BaseObserver(BlockingEmitter)

    def publish(_event):
        if blocked_owner in {"dispatcher", "emitter_health"}:
            entered.set()
            release.wait(2)

    source = library_watch.WatchdogLibraryEventSource(
        [{"id": "main", "path": str(tmp_path)}], observer_factory=lambda: observer,
    )
    emitters = ()
    timer = None
    try:
        source.start(publish)
        emitters = tuple(observer.emitters)
        if blocked_owner == "dispatcher":
            observer.event_queue.put((FileModifiedEvent(str(tmp_path / "song.flac")), emitters[0].watch))
        assert entered.wait(1)
        # Bound the broken baseline too; every thread is released in finally.
        timer = Timer(0.7, release.set)
        timer.start()
        started = monotonic()
        with pytest.raises(RuntimeError, match="deadline"):
            source.stop(timeout=0.05)
        assert monotonic() - started < 0.4
        assert source._observer is observer
        assert observer.is_alive() or any(emitter.is_alive() for emitter in emitters)
        with pytest.raises(RuntimeError, match="Stop"):
            source.replace_roots([])
    finally:
        release.set()
        if timer is not None:
            timer.cancel()
            timer.join(2)
        source.stop(timeout=2)
        assert source._observer is None
        assert not observer.is_alive()
        assert all(not emitter.is_alive() for emitter in emitters)
