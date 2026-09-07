from __future__ import annotations

from pathlib import Path

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


def test_stop_flushes_pending_work_and_rejects_new_events(tmp_path: Path):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEventKind

    emitted = []
    coordinator = LibraryEventCoordinator(emit_request=emitted.append)
    coordinator.accept(_event(LibraryEventKind.DELETED, tmp_path, "Artist/Album/01.flac"))

    assert coordinator.stop() is True
    assert len(emitted) == 1
    assert coordinator.stop() is False
    assert coordinator.accept(
        _event(LibraryEventKind.DELETED, tmp_path, "Artist/Album/02.flac")
    ) is False
