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
