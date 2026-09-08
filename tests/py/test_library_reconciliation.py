from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest


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
