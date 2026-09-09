from __future__ import annotations

from pathlib import Path
from threading import Event, Thread

import pytest


def _event(
    kind,
    root: Path,
    relative: str,
    *,
    destination: str | None = None,
    is_directory: bool = False,
):
    from music_app.services.library_reconciliation import LibraryEvent

    return LibraryEvent(
        kind=kind,
        root_id="root-1",
        path=root / relative,
        destination=root / destination if destination else None,
        observed_at=1.0,
        is_directory=is_directory,
    )


def test_duplicate_modifications_coalesce_by_album_directory(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    path = tmp_path / "Artist" / "Album" / "01.flac"
    samples = iter(((100, 10), (100, 10)))
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        stat_path=lambda _path: next(samples),
        wait=lambda _seconds: None,
    )

    coordinator.accept(_event(LibraryEventKind.MODIFIED, tmp_path, "Artist/Album/01.flac"))
    coordinator.accept(_event(LibraryEventKind.MODIFIED, tmp_path, "Artist/Album/01.flac"))
    coordinator.flush()

    assert len(emitted) == 1
    assert emitted[0].paths == frozenset({path})


def test_rapid_multi_file_copy_emits_one_album_request(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        stat_path=lambda _path: (100, 10),
        wait=lambda _seconds: None,
    )
    coordinator.accept(_event(LibraryEventKind.CREATED, tmp_path, "Artist/Album/01.flac"))
    coordinator.accept(_event(LibraryEventKind.CREATED, tmp_path, "Artist/Album/02.flac"))
    coordinator.flush()

    assert len(emitted) == 1
    assert emitted[0].paths == frozenset(
        {
            tmp_path / "Artist" / "Album" / "01.flac",
            tmp_path / "Artist" / "Album" / "02.flac",
        }
    )


def test_create_then_delete_emits_only_deleted_path(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    coordinator = LibraryEventCoordinator(emit_request=emitted.append)
    event_path = "Artist/Album/01.flac"
    coordinator.accept(_event(LibraryEventKind.CREATED, tmp_path, event_path))
    coordinator.accept(_event(LibraryEventKind.DELETED, tmp_path, event_path))
    coordinator.flush()

    assert emitted[0].paths == frozenset()
    assert emitted[0].deleted_paths == frozenset({tmp_path / event_path})


def test_delete_then_recreate_emits_only_active_path(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        stat_path=lambda _path: (100, 10),
        wait=lambda _seconds: None,
    )
    event_path = "Artist/Album/01.flac"
    coordinator.accept(_event(LibraryEventKind.DELETED, tmp_path, event_path))
    coordinator.accept(_event(LibraryEventKind.CREATED, tmp_path, event_path))
    coordinator.flush()

    assert emitted[0].paths == frozenset({tmp_path / event_path})
    assert emitted[0].deleted_paths == frozenset()
    assert emitted[0].deleted_subtrees == frozenset()


def test_delete_then_replacement_move_clears_destination_deletion(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        stat_path=lambda _path: (100, 10),
        wait=lambda _seconds: None,
    )
    replaced_path = "Artist/Album/01.flac"
    coordinator.accept(_event(LibraryEventKind.DELETED, tmp_path, replaced_path))
    coordinator.accept(
        _event(
            LibraryEventKind.MOVED,
            tmp_path,
            "Artist/Album/replacement.tmp",
            destination=replaced_path,
        )
    )
    coordinator.flush()

    assert len(emitted[0].moves) == 1
    assert emitted[0].moves[0].destination == tmp_path / replaced_path
    assert emitted[0].deleted_paths == frozenset()
    assert emitted[0].deleted_subtrees == frozenset()


def test_cross_root_replacement_move_clears_destination_group_deletion(
    tmp_path: Path,
):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEvent, LibraryEventKind

    emitted = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        max_pending_groups=1,
        max_pending_entries=2,
        stat_path=lambda _path: (100, 10),
        wait=lambda _seconds: None,
    )
    source = tmp_path / "Source Root" / "replacement.tmp"
    destination = tmp_path / "Destination Root" / "Artist" / "Album" / "01.flac"
    coordinator.accept(
        LibraryEvent(LibraryEventKind.DELETED, "destination-root", destination)
    )
    coordinator.accept(
        LibraryEvent(
            LibraryEventKind.MOVED,
            "source-root",
            source,
            destination=destination,
            destination_root_id="destination-root",
        )
    )
    coordinator.flush()

    assert len(emitted) == 1
    assert emitted[0].moves[0].destination == destination
    assert emitted[0].deleted_paths == frozenset()
    assert emitted[0].deleted_subtrees == frozenset()


def test_created_child_preserves_pending_deleted_directory_ancestor(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        stat_path=lambda _path: (100, 10),
        wait=lambda _seconds: None,
    )
    track = tmp_path / "Artist" / "Album" / "01.flac"
    coordinator.accept(
        _event(
            LibraryEventKind.DELETED,
            tmp_path,
            "Artist/Album",
        )
    )
    coordinator.accept(
        _event(LibraryEventKind.CREATED, tmp_path, "Artist/Album/01.flac")
    )
    coordinator.flush()

    assert len(emitted) == 2
    deletion_request = next(
        request for request in emitted if request.deleted_subtrees
    )
    assert deletion_request.paths == frozenset({track})
    assert deletion_request.deleted_paths == frozenset({track.parent})
    assert deletion_request.deleted_subtrees == frozenset({track.parent})


def test_cross_root_moved_child_preserves_pending_destination_directory_ancestor(
    tmp_path: Path,
):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEvent, LibraryEventKind

    emitted = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        stat_path=lambda _path: (100, 10),
        wait=lambda _seconds: None,
    )
    deleted_directory = tmp_path / "Destination Root" / "Artist" / "Album"
    source = tmp_path / "Source Root" / "replacement.tmp"
    destination = deleted_directory / "01.flac"
    coordinator.accept(
        LibraryEvent(
            LibraryEventKind.DELETED,
            "z-destination-root",
            deleted_directory,
            is_directory=True,
        )
    )
    coordinator.accept(
        LibraryEvent(
            LibraryEventKind.MOVED,
            "a-source-root",
            source,
            destination=destination,
            destination_root_id="z-destination-root",
        )
    )
    coordinator.flush()

    assert len(emitted) == 2
    move_request = next(request for request in emitted if request.moves)
    deletion_request = next(
        request for request in emitted if request.deleted_subtrees
    )
    assert move_request.root_id == "a-source-root"
    assert move_request.moves[0].destination == destination
    assert deletion_request.root_id == "z-destination-root"
    assert deletion_request.paths == frozenset({destination})
    assert deletion_request.deleted_paths == frozenset()
    assert deletion_request.deleted_subtrees == frozenset({deleted_directory})


def test_directory_delete_is_emitted_as_deleted_subtree(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    coordinator = LibraryEventCoordinator(emit_request=emitted.append)
    album_directory = tmp_path / "Artist" / "Deleted Album"
    coordinator.accept(
        _event(
            LibraryEventKind.DELETED,
            tmp_path,
            "Artist/Deleted Album",
            is_directory=True,
        )
    )
    coordinator.flush()

    assert emitted[0].deleted_paths == frozenset()
    assert emitted[0].deleted_subtrees == frozenset({album_directory})


def test_windows_file_typed_delete_is_also_reconciled_as_a_possible_subtree(
    tmp_path: Path,
):
    """Windows watchdog reports removed directories as FileDeletedEvent."""
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    album_directory = tmp_path / "Artist" / "Deleted Album"
    coordinator = LibraryEventCoordinator(emit_request=emitted.append)

    coordinator.accept(
        _event(
            LibraryEventKind.DELETED,
            tmp_path,
            "Artist/Deleted Album",
            is_directory=False,
        )
    )
    coordinator.flush()

    assert emitted[0].deleted_paths == frozenset({album_directory})
    assert emitted[0].deleted_subtrees == frozenset({album_directory})


def test_move_keeps_source_and_destination_in_one_request(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        stat_path=lambda _path: (100, 10),
        wait=lambda _seconds: None,
    )
    coordinator.accept(
        _event(
            LibraryEventKind.MOVED,
            tmp_path,
            "Artist/Album/01.flac",
            destination="Artist/Album/02.flac",
        )
    )
    coordinator.flush()

    assert len(emitted) == 1
    [move] = emitted[0].moves
    assert move.source == tmp_path / "Artist" / "Album" / "01.flac"
    assert move.destination == tmp_path / "Artist" / "Album" / "02.flac"
    assert move.source_root_id == "root-1"
    assert move.destination_root_id == "root-1"


def test_directory_move_preserves_subtree_semantics(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        stat_path=lambda _path: (100, 10),
        wait=lambda _seconds: None,
    )
    coordinator.accept(
        _event(
            LibraryEventKind.MOVED,
            tmp_path,
            "Artist/Old Album",
            destination="Artist/New Album",
            is_directory=True,
        )
    )
    coordinator.flush()

    assert emitted[0].moves[0].is_directory is True


def test_bounded_groups_emit_overflow_before_dropping_new_work(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    health = []
    coordinator = LibraryEventCoordinator(
        emit_request=lambda _request: None,
        emit_health_event=health.append,
        max_pending_groups=1,
    )
    assert coordinator.accept(
        _event(LibraryEventKind.DELETED, tmp_path, "Artist/First/01.flac")
    ) is True
    assert coordinator.accept(
        _event(LibraryEventKind.DELETED, tmp_path, "Artist/Second/01.flac")
    ) is False

    assert [event.kind for event in health] == [LibraryEventKind.OVERFLOW]


@pytest.mark.parametrize("kind", ["created", "deleted", "moved"])
def test_default_entry_budget_bounds_a_burst_inside_one_group(tmp_path: Path, kind):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    health = []
    coordinator = LibraryEventCoordinator(
        emit_request=lambda _request: None,
        emit_health_event=health.append,
    )
    accepted = []
    for index in range(5_000):
        accepted.append(coordinator.accept(_event(
            LibraryEventKind(kind),
            tmp_path,
            f"Artist/Album/{index:05}.flac",
            destination=f"Artist/Album/renamed-{index:05}.flac" if kind == "moved" else None,
        )))

    assert not all(accepted), "a single directory bypassed the bounded event queue"
    assert all(event.kind is LibraryEventKind.OVERFLOW for event in health)
    assert len(health) == accepted.count(False)
    assert coordinator._pending_entry_count <= 4_096
    coordinator.stop()
    assert coordinator._pending_entry_count == 0


def test_entry_budget_counts_coalesced_changes_and_releases_flushed_work(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        max_pending_entries=3,
        stat_path=lambda _path: (100, 10),
        wait=lambda _seconds: None,
    )
    deleted = _event(LibraryEventKind.DELETED, tmp_path, "Artist/Album/01.flac")
    second = _event(LibraryEventKind.CREATED, tmp_path, "Artist/Album/02.flac")
    replacement = _event(LibraryEventKind.CREATED, tmp_path, "Artist/Album/01.flac")
    move = _event(
        LibraryEventKind.MOVED, tmp_path, "Artist/Album/02.flac",
        destination="Artist/Album/renamed.flac",
    )
    for event in (deleted, second, deleted, replacement, move, move):
        assert coordinator.accept(event) is True
    assert coordinator.accept(_event(
        LibraryEventKind.CREATED, tmp_path, "Artist/Album/03.flac"
    )) is True
    assert coordinator.accept(_event(
        LibraryEventKind.CREATED, tmp_path, "Artist/Album/04.flac"
    )) is False
    coordinator.flush()

    assert len(emitted) == 1
    assert emitted[0].paths == frozenset({replacement.path, tmp_path / "Artist/Album/03.flac"})
    assert emitted[0].deleted_paths == emitted[0].deleted_subtrees == frozenset()
    assert [(item.source, item.destination) for item in emitted[0].moves] == [
        (move.path, move.destination)
    ]
    assert coordinator._pending_entry_count == 0
    for index in range(3):
        assert coordinator.accept(_event(
            LibraryEventKind.CREATED, tmp_path, f"Artist/Another/{index}.flac"
        )) is True
    assert coordinator.accept(_event(
        LibraryEventKind.CREATED, tmp_path, "Artist/Another/overflow.flac"
    )) is False
    coordinator.stop()
    assert coordinator._pending_entry_count == 0


@pytest.mark.parametrize("cross_root_move", [False, True])
@pytest.mark.parametrize("limit", ["entries", "groups"])
def test_overflow_does_not_partially_preserve_children_in_deleted_ancestors(
    tmp_path: Path, cross_root_move, limit,
):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEvent, LibraryEventKind

    emitted = []
    health = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        emit_health_event=health.append,
        max_pending_entries=2 if limit == "entries" else 10,
        max_pending_groups=1 if limit == "groups" else 10,
        stat_path=lambda _path: (100, 10),
        wait=lambda _seconds: None,
    )
    deleted = tmp_path / "Artist/Album"
    assert coordinator.accept(LibraryEvent(
        LibraryEventKind.DELETED, "destination-root", deleted, is_directory=True,
    )) is True
    child = deleted / "01.flac"
    event = (
        LibraryEvent(
            LibraryEventKind.MOVED, "source-root", tmp_path / "Source/01.flac",
            destination=child, destination_root_id="destination-root",
        ) if cross_root_move else
        LibraryEvent(LibraryEventKind.CREATED, "destination-root", child)
    )
    assert coordinator.accept(event) is False
    assert {item.root_id for item in health} == (
        {"source-root", "destination-root"} if cross_root_move else {"destination-root"}
    )
    assert all(item.kind is LibraryEventKind.OVERFLOW for item in health)
    coordinator.flush()

    assert len(emitted) == 1
    assert emitted[0].deleted_subtrees == frozenset({deleted})
    assert emitted[0].paths == frozenset()
    assert emitted[0].moves == ()
    assert coordinator._pending_entry_count == 0


def test_group_overflow_keeps_deleted_destination_of_rejected_replacement(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        max_pending_groups=1,
        stat_path=lambda _path: (100, 10),
        wait=lambda _seconds: None,
    )
    deleted = _event(LibraryEventKind.DELETED, tmp_path, "Artist/Album/01.flac")
    active = _event(LibraryEventKind.CREATED, tmp_path, "Artist/Album/02.flac")
    assert coordinator.accept(deleted) is True
    assert coordinator.accept(active) is True
    assert coordinator.accept(_event(
        LibraryEventKind.MOVED, tmp_path, "Source/replacement.tmp",
        destination="Artist/Album/01.flac",
    )) is False
    coordinator.flush()

    assert len(emitted) == 1
    assert emitted[0].deleted_paths == emitted[0].deleted_subtrees == frozenset({deleted.path})
    assert emitted[0].paths == frozenset({active.path})


def test_cross_root_move_overflow_marks_every_affected_root_unhealthy(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEvent, LibraryEventKind

    health = []
    coordinator = LibraryEventCoordinator(
        emit_request=lambda _request: None,
        emit_health_event=health.append,
        max_pending_groups=1,
    )
    assert coordinator.accept(
        LibraryEvent(
            LibraryEventKind.DELETED,
            "existing-root",
            tmp_path / "Existing" / "01.flac",
        )
    ) is True

    assert coordinator.accept(
        LibraryEvent(
            LibraryEventKind.MOVED,
            "source-root",
            tmp_path / "Source" / "replacement.tmp",
            destination=tmp_path / "Destination" / "01.flac",
            destination_root_id="destination-root",
        )
    ) is False

    assert [event.kind for event in health] == [
        LibraryEventKind.OVERFLOW,
        LibraryEventKind.OVERFLOW,
    ]
    assert {event.root_id for event in health} == {
        "source-root",
        "destination-root",
    }


def test_overflow_health_callback_can_reenter_coordinator_without_locking(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    class ReentryDetectingLock:
        def __init__(self):
            self.entered = False

        def __enter__(self):
            assert self.entered is False, "health callback re-entered the coordinator lock"
            self.entered = True

        def __exit__(self, *_args):
            self.entered = False

    coordinator = None
    health = []

    def record_health(event):
        health.append(event)
        assert coordinator is not None
        coordinator.accept(
            _event(LibraryEventKind.DELETED, tmp_path, "Artist/First/02.flac")
        )

    coordinator = LibraryEventCoordinator(
        emit_request=lambda _request: None,
        emit_health_event=record_health,
        max_pending_groups=1,
    )
    coordinator._lock = ReentryDetectingLock()
    coordinator.accept(_event(LibraryEventKind.DELETED, tmp_path, "Artist/First/01.flac"))

    assert coordinator.accept(
        _event(LibraryEventKind.DELETED, tmp_path, "Artist/Second/01.flac")
    ) is False
    assert [event.kind for event in health] == [LibraryEventKind.OVERFLOW]


def test_auto_schedule_flushes_within_maximum_delay_under_continuous_events(
    tmp_path: Path,
):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    now = [0.0]
    timers = []

    class FakeTimer:
        def __init__(self, delay, callback):
            self.delay = delay
            self.callback = callback
            self.cancelled = False
            self.daemon = False

        def start(self):
            timers.append(self)

        def cancel(self):
            self.cancelled = True

    emitted = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        stat_path=lambda _path: (100, 10),
        wait=lambda _seconds: None,
        debounce_seconds=0.5,
        max_flush_delay_seconds=2.0,
        auto_schedule=True,
        clock=lambda: now[0],
        timer_factory=FakeTimer,
    )

    for index in range(6):
        coordinator.accept(
            _event(
                LibraryEventKind.CREATED,
                tmp_path,
                f"Artist/Album-{index}/01.flac",
            )
        )
        now[0] += 0.4

    assert timers[-1].delay == pytest.approx(0.0)
    timers[-1].callback()
    assert len(emitted) == 6


def test_auto_schedule_coalesces_events_while_one_scheduled_flush_is_running(
    tmp_path: Path,
):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    flush_entered = Event()
    release_flush = Event()
    pending_flushed = Event()
    emitted = []
    worker_errors = []
    timers = []

    class ImmediateThreadTimer:
        def __init__(self, _delay, callback):
            self.callback = callback
            self.cancelled = False
            self.daemon = False
            self.started = Event()
            self.thread = Thread(target=self._run, daemon=True)

        def _run(self):
            self.started.set()
            try:
                self.callback()
            except BaseException as error:
                worker_errors.append(error)

        def start(self):
            timers.append(self)
            self.thread.start()

        def cancel(self):
            self.cancelled = True

    def block_first_emit(request):
        emitted.append(request)
        if len(emitted) == 1:
            flush_entered.set()
            assert release_flush.wait(timeout=3.0)
        else:
            pending_flushed.set()

    coordinator = LibraryEventCoordinator(
        emit_request=block_first_emit,
        stat_path=lambda _path: (100, 10),
        wait=lambda _seconds: None,
        debounce_seconds=0,
        max_flush_delay_seconds=0,
        auto_schedule=True,
        timer_factory=ImmediateThreadTimer,
    )
    try:
        coordinator.accept(
            _event(LibraryEventKind.CREATED, tmp_path, "Artist/Album/01.flac")
        )
        assert flush_entered.wait(timeout=3.0)

        for number in range(2, 12):
            coordinator.accept(
                _event(
                    LibraryEventKind.CREATED,
                    tmp_path,
                    f"Artist/Album/{number:02}.flac",
                )
            )

        assert len(timers) == 1
        release_flush.set()
        assert pending_flushed.wait(timeout=3.0)
        assert len(timers) == 2
        assert [request.paths for request in emitted] == [
            frozenset({tmp_path / "Artist/Album/01.flac"}),
            frozenset(
                tmp_path / f"Artist/Album/{number:02}.flac"
                for number in range(2, 12)
            ),
        ]
    finally:
        coordinator.stop()
        release_flush.set()
        for timer in timers:
            timer.thread.join(timeout=3.0)

    assert all(not timer.thread.is_alive() for timer in timers)
    if worker_errors:
        raise worker_errors[0]


@pytest.mark.parametrize("group_count", [1, 10])
def test_flush_samples_all_groups_and_moves_with_one_shared_wait(tmp_path: Path, group_count):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    waits = []
    samples = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        stat_path=lambda path: samples.append(path) or (100, 10),
        wait=waits.append,
    )
    targets = set()
    for index in range(1_000):
        moving = bool(index % 2)
        event = _event(
            LibraryEventKind.MOVED if moving else LibraryEventKind.CREATED,
            tmp_path, f"Artist/Album-{index % group_count}/{index}.flac",
            destination=f"Destination/Album-{index % group_count}/{index}.flac" if moving else None,
        )
        assert coordinator.accept(event) is True
        targets.add(event.destination if moving else event.path)
    coordinator.flush()

    assert len(waits) == 1, "stability waits must be shared across the entire flush"
    assert waits == [0.1]
    assert len(samples) == 2 * len(targets)
    assert set(samples) == targets
    assert len(emitted) == group_count
    assert sum(len(request.paths) for request in emitted) == 500
    assert sum(len(request.moves) for request in emitted) == 500


def test_flush_batches_mixed_dispositions_and_deduplicates_failed_destination_health(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEvent, LibraryEventKind

    ready = tmp_path / "Ready/01.flac"
    transient = tmp_path / "Transient/01.flac"
    missing = tmp_path / "Missing/01.flac"
    destination = tmp_path / "Destination/Album/01.flac"
    another_failed = tmp_path / "Destination/Album/02.flac"
    outcomes = {
        ready: ((100, 10), (100, 10)),
        transient: ((100, 10), PermissionError("busy"), (100, 10), (100, 10)),
        missing: ((100, 10), FileNotFoundError()),
        destination: (PermissionError("busy"),),
        another_failed: (PermissionError("busy"),),
    }
    samples = []
    waits = []
    emitted = []
    problems = []

    def stat_path(path):
        samples.append(path)
        values = outcomes[path]
        value = values[min(samples.count(path) - 1, len(values) - 1)]
        if isinstance(value, Exception):
            raise value
        return value

    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append, emit_problem=problems.append,
        stat_path=stat_path, wait=waits.append,
    )
    for path in (ready, transient, missing):
        coordinator.accept(LibraryEvent(LibraryEventKind.CREATED, "main-root", path))
    coordinator.accept(LibraryEvent(
        LibraryEventKind.DELETED, "destination-root", destination.parent, is_directory=True,
    ))
    coordinator.accept(LibraryEvent(
        LibraryEventKind.CREATED, "destination-root", another_failed,
    ))
    for root_id in ("source-a", "source-b"):
        coordinator.accept(LibraryEvent(
            LibraryEventKind.MOVED, root_id, tmp_path / root_id / "01.flac",
            destination=destination, destination_root_id="destination-root",
        ))
    coordinator.flush()

    assert waits == [0.1] * 3
    assert {path: samples.count(path) for path in outcomes} == {
        ready: 2, transient: 4, missing: 2, destination: 4, another_failed: 4,
    }
    assert {path for request in emitted for path in request.paths} == {ready, transient}
    assert {path for request in emitted for path in request.deleted_paths} == {missing}
    # Failed live descendants block the overlapping parent deletion instead of
    # publishing a partial mutation that would stale those unverified files.
    assert not any(request.deleted_subtrees for request in emitted)
    assert not any(request.moves for request in emitted)
    assert [(problem.code, problem.root_id) for problem in problems] == [
        ("stable_write_unavailable", root_id)
        for root_id in ("destination-root", "source-a", "source-b")
    ]


def test_stop_during_shared_sampling_wait_suppresses_health_and_requests(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    problems = []
    samples = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append, emit_problem=problems.append,
        stat_path=lambda path: samples.append(path) or (100, 10),
        wait=lambda _seconds: coordinator.stop(),
    )
    for index in range(2):
        coordinator.accept(_event(
            LibraryEventKind.CREATED, tmp_path, f"Artist/Album-{index}/01.flac",
        ))
    coordinator.flush()

    assert len(samples) == 2
    assert emitted == problems == []
    assert coordinator._pending_entry_count == 0


def test_stable_write_retries_transient_sharing_violation(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    calls = []
    samples = iter((PermissionError("busy"), (100, 10), (100, 10)))

    def stat_path(_path):
        calls.append("stat")
        value = next(samples)
        if isinstance(value, Exception):
            raise value
        return value

    emitted = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        stat_path=stat_path,
        wait=lambda _seconds: calls.append("wait"),
        max_stable_attempts=3,
    )
    coordinator.accept(_event(LibraryEventKind.CREATED, tmp_path, "Artist/Album/01.flac"))
    coordinator.flush()

    assert emitted[0].paths == frozenset({tmp_path / "Artist/Album/01.flac"})
    assert "wait" in calls


def test_disappearance_during_sampling_becomes_delete(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    samples = iter(((100, 10), FileNotFoundError()))

    def stat_path(_path):
        value = next(samples)
        if isinstance(value, Exception):
            raise value
        return value

    emitted = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        stat_path=stat_path,
        wait=lambda _seconds: None,
    )
    path = tmp_path / "Artist/Album/01.flac"
    coordinator.accept(_event(LibraryEventKind.MODIFIED, tmp_path, "Artist/Album/01.flac"))
    coordinator.flush()

    assert emitted[0].paths == frozenset()
    assert emitted[0].deleted_paths == frozenset({path})


def test_exhausted_sharing_violation_reports_problem_without_request(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    problems = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        emit_problem=problems.append,
        stat_path=lambda _path: (_ for _ in ()).throw(PermissionError("busy")),
        wait=lambda _seconds: None,
        max_stable_attempts=2,
    )
    coordinator.accept(_event(LibraryEventKind.CREATED, tmp_path, "Artist/Album/01.flac"))
    coordinator.flush()

    assert emitted == []
    assert problems[0].code == "stable_write_unavailable"
    assert problems[0].root_id == "root-1"


def test_cross_root_move_stability_failure_marks_every_affected_root_unhealthy(
    tmp_path: Path,
):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEvent, LibraryEventKind

    emitted = []
    problems = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        emit_problem=problems.append,
        stat_path=lambda _path: (_ for _ in ()).throw(PermissionError("busy")),
        wait=lambda _seconds: None,
        max_stable_attempts=2,
    )
    coordinator.accept(
        LibraryEvent(
            LibraryEventKind.MOVED,
            "source-root",
            tmp_path / "Source" / "replacement.tmp",
            destination=tmp_path / "Destination" / "01.flac",
            destination_root_id="destination-root",
        )
    )
    coordinator.flush()

    assert emitted == []
    assert {problem.code for problem in problems} == {"stable_write_unavailable"}
    assert {problem.root_id for problem in problems} == {
        "source-root",
        "destination-root",
    }


def test_stop_cancels_pending_work_without_stability_waits_and_rejects_new_events(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    waits = []
    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        stat_path=lambda _path: (100, 10),
        wait=waits.append,
    )
    coordinator.accept(_event(LibraryEventKind.MODIFIED, tmp_path, "Artist/Album/01.flac"))

    assert coordinator.stop() is True
    assert emitted == []
    assert waits == []
    assert coordinator.stop() is False
    assert coordinator.accept(
        _event(LibraryEventKind.DELETED, tmp_path, "Artist/Album/02.flac")
    ) is False


def test_stop_returns_while_an_existing_flush_is_blocked_in_filesystem_io(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    stat_started = Event()
    release_stat = Event()
    stop_finished = Event()
    emitted = []

    def blocking_stat(_path):
        stat_started.set()
        assert release_stat.wait(timeout=3.0)
        return (100, 10)

    coordinator = LibraryEventCoordinator(
        emit_request=emitted.append,
        stat_path=blocking_stat,
    )
    coordinator.accept(_event(LibraryEventKind.MODIFIED, tmp_path, "Artist/Album/01.flac"))
    flush_thread = Thread(target=coordinator.flush, daemon=True)
    flush_thread.start()
    assert stat_started.wait(timeout=3.0)

    def stop_coordinator():
        coordinator.stop()
        stop_finished.set()

    stop_thread = Thread(target=stop_coordinator, daemon=True)
    stop_thread.start()
    try:
        assert stop_finished.wait(timeout=1.0)
    finally:
        release_stat.set()
        stop_thread.join(timeout=3.0)
        flush_thread.join(timeout=3.0)

    assert not stop_thread.is_alive()
    assert not flush_thread.is_alive()
    assert emitted == []


def test_concurrent_flushes_preserve_delete_then_recreation_order(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    deleted_emit_started = Event()
    release_deleted_emit = Event()
    second_flush_finished = Event()
    emitted = []

    def emit_request(request):
        if request.deleted_paths:
            deleted_emit_started.set()
            assert release_deleted_emit.wait(timeout=3.0)
        emitted.append(request)

    coordinator = LibraryEventCoordinator(
        emit_request=emit_request,
        stat_path=lambda _path: (100, 10),
        wait=lambda _seconds: None,
    )
    path = tmp_path / "Artist/Album/01.flac"
    coordinator.accept(_event(LibraryEventKind.DELETED, tmp_path, "Artist/Album/01.flac"))
    first_flush = Thread(target=coordinator.flush, daemon=True)
    first_flush.start()
    assert deleted_emit_started.wait(timeout=3.0)

    coordinator.accept(_event(LibraryEventKind.CREATED, tmp_path, "Artist/Album/01.flac"))

    def flush_recreation():
        coordinator.flush()
        second_flush_finished.set()

    second_flush = Thread(target=flush_recreation, daemon=True)
    second_flush.start()
    try:
        assert not second_flush_finished.wait(timeout=0.2)
    finally:
        release_deleted_emit.set()
        first_flush.join(timeout=3.0)
        second_flush.join(timeout=3.0)

    assert not first_flush.is_alive()
    assert not second_flush.is_alive()
    assert [request.deleted_paths for request in emitted] == [frozenset({path}), frozenset()]
    assert [request.paths for request in emitted] == [frozenset(), frozenset({path})]
