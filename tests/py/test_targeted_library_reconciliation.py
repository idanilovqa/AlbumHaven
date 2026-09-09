from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

import pytest


class RecordingRepository:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def persist_targeted_inventory_mutation(self, **kwargs):
        self.calls.append(kwargs)
        return {
            "inventory_mutation_revision": 12,
            "affected_album_keys": ["broadcast::tender buttons"],
        }


def _request(
    *,
    root_id: str = "main",
    paths: tuple[Path, ...] = (),
    deleted_paths: tuple[Path, ...] = (),
    deleted_subtrees: tuple[Path, ...] = (),
    preserved_subtrees: tuple[Path, ...] = (),
    moves: tuple[tuple[Path, Path], ...] = (),
):
    return SimpleNamespace(
        root_id=root_id,
        paths=paths,
        deleted_paths=deleted_paths,
        deleted_subtrees=deleted_subtrees,
        preserved_subtrees=preserved_subtrees,
        moves=moves,
    )


@pytest.mark.parametrize("unstable", [False, True])
def test_incoming_directory_move_reconciles_contained_descendants_atomically(tmp_path, unstable):
    from music_app.services.library_watch import normalize_library_event
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler

    root = tmp_path / "Music"
    album = root / "Owner" / "Imported"
    first = album / "01.flac"
    second = album / "Disc 2" / "02.flac"
    second.parent.mkdir(parents=True)
    first.write_bytes(b"one")
    second.write_bytes(b"two")
    outside = tmp_path / "private.flac"
    outside.write_bytes(b"outside")
    (album / "escape.flac").symlink_to(outside)
    roots = [{"id": "main", "path": str(root), "category": "main_library_roots"}]
    requests = []
    coordinator = LibraryEventCoordinator(emit_request=requests.append, wait=lambda _seconds: None)
    event = normalize_library_event("moved", tmp_path / "old-location", roots=roots, destination=album, is_directory=True)
    assert event is not None
    coordinator.accept(event)
    coordinator.flush()
    assert len(requests) == 1
    repository = RecordingRepository()
    parsed = []
    samples = 0

    def stat(path):
        nonlocal samples
        samples += 1
        return SimpleNamespace(st_size=samples if unstable and path == second else path.stat().st_size, st_mtime_ns=1)

    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}}, repository=repository, root_definitions=roots,
        metadata_reader=lambda path: parsed.append(path) or {"path": str(path), "album": "Imported", "album_artist": "Owner", "artist": "Owner", "title": path.stem},
        stat_path=stat, wait=lambda _seconds: None,
    )
    result = reconciler.reconcile(requests[0])
    if unstable:
        assert result.health == "stable_write_unavailable"
        assert parsed == [] and repository.calls == []
    else:
        assert set(parsed) == {first, second}
        assert len(repository.calls) == 1
        assert set(repository.calls[0]["active_file_entries"]) == {str(first), str(second)}


def test_targeted_reconciler_parses_only_requested_files_and_never_full_scans(
    tmp_path,
    monkeypatch,
):
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )
    from music_app.services import library_indexing

    root = tmp_path / "Music"
    requested = root / "Broadcast" / "Tender Buttons" / "01.mp3"
    requested.parent.mkdir(parents=True)
    requested.write_bytes(b"media")
    parsed: list[Path] = []
    repository = RecordingRepository()
    monkeypatch.setattr(
        library_indexing,
        "scan_library_file_cache",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("targeted reconciliation must not run the full scanner")
        ),
    )

    reconciler = TargetedLibraryReconciler(
        {"IMAGE_EXTENSIONS": {".jpg"}},
        repository=repository,
        root_definitions=[
            {"id": "main", "path": root, "category": "main_library_roots"}
        ],
        metadata_reader=lambda path: (
            parsed.append(path)
            or {
                "path": str(path),
                "album": "Tender Buttons",
                "album_artist": "Broadcast",
                "artist": "Broadcast",
                "title": "I Found the F",
                "track_number": 1,
                "disc_number": 1,
                "mtime": 1.0,
                "size": 5,
            }
        ),
    )

    result = reconciler.reconcile(_request(paths=(requested,)))

    assert parsed == [requested]
    assert result.revision == 12
    assert result.affected_album_keys == ("broadcast::tender buttons",)
    assert not hasattr(result, "paths")
    assert repository.calls[0]["root_id"] == "main"
    entries = repository.calls[0]["active_file_entries"]
    assert list(entries) == [str(requested)]
    assert entries[str(requested)]["library_root_id"] == "main"
    assert entries[str(requested)]["library_root_category"] == "main_library"


def test_targeted_reconciler_rebuilds_complete_album_folder_from_sibling_files(
    tmp_path,
):
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )

    root = tmp_path / "Music"
    album = root / "Artist" / "Album"
    requested = album / "01.flac"
    sibling = album / "02.flac"
    album.mkdir(parents=True)
    requested.write_bytes(b"one")
    sibling.write_bytes(b"two")
    parsed: list[Path] = []
    repository = RecordingRepository()

    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}, "IMAGE_EXTENSIONS": set()},
        repository=repository,
        root_definitions=[
            {"id": "main", "path": root, "category": "main_library_roots"}
        ],
        metadata_reader=lambda path: (
            parsed.append(path)
            or {
                "path": str(path),
                "album": "Album",
                "album_artist": "Artist",
                "artist": "Artist",
                "title": path.stem,
                "mtime": 1.0,
                "size": path.stat().st_size,
            }
        ),
    )

    reconciler.reconcile(_request(paths=(requested,)))

    assert parsed == [requested, sibling]
    assert set(repository.calls[0]["active_file_entries"]) == {
        str(requested),
        str(sibling),
    }


@pytest.mark.parametrize(
    ("category", "layout_mode", "album_relative", "first_disc_name"),
    [
        ("main_library_roots", "artist", "Owner/Multi Disc Album", "Disc 1"),
        (
            "main_library_roots",
            "genre/artist",
            "Rock/Owner/Multi Disc Album",
            "Disc 1",
        ),
        ("main_library_roots", "album-at-root", "Multi Disc Album", "Disc 1"),
        ("hoarding_library_roots", None, "Multi Disc Album", "Disc 1"),
        ("new_arrivals_roots", None, "Multi Disc Album", "Disc 1"),
        ("new_arrivals_roots", None, "Multi Disc Album", "CD1 (Bonus)"),
    ],
    ids=["artist", "genre-artist", "album-at-root", "hoard", "arrivals", "bonus-disc"],
)
def test_targeted_reconciler_rebuilds_all_disc_folders_for_one_album(
    tmp_path,
    category,
    layout_mode,
    album_relative,
    first_disc_name,
):
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )

    root = tmp_path / "Music"
    album = root / album_relative
    changed = album / first_disc_name / "01.flac"
    untouched_guest = album / "Disc 2" / "02.flac"
    unrelated = album.parent / "Unrelated Album" / "01.flac"
    changed.parent.mkdir(parents=True)
    untouched_guest.parent.mkdir(parents=True)
    unrelated.parent.mkdir(parents=True)
    changed.write_bytes(b"one")
    untouched_guest.write_bytes(b"two")
    unrelated.write_bytes(b"unrelated")
    parsed: list[Path] = []
    repository = RecordingRepository()

    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}, "IMAGE_EXTENSIONS": set()},
        repository=repository,
        root_definitions=[
            {
                "id": "main",
                "path": root,
                "category": category,
                **({"layout_mode": layout_mode} if layout_mode is not None else {}),
            }
        ],
        metadata_reader=lambda path: (
            parsed.append(path)
            or {
                "path": str(path),
                "album": "Multi Disc Album",
                "album_artist": "Owner",
                "artist": "Owner feat. Guest" if path == untouched_guest else "Owner",
                "title": path.stem,
                "disc_number": 2 if path == untouched_guest else 1,
                "mtime": 1.0,
                "size": path.stat().st_size,
            }
        ),
    )

    reconciler.reconcile(_request(paths=(changed,)))

    assert set(parsed) == {changed, untouched_guest}
    assert set(repository.calls[0]["active_file_entries"]) == {
        str(changed),
        str(untouched_guest),
    }


@pytest.mark.parametrize("requested_relative", ["loose.flac", "CD1 (Bonus)/01.flac"])
def test_targeted_reconciler_keeps_root_album_expansion_out_of_unrelated_albums(
    tmp_path, monkeypatch, requested_relative
):
    from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler

    root = tmp_path / "Music"
    expected = {root / name for name in (
        "loose.flac", "02.flac", "CD1 (Bonus)/01.flac", "Disc 2/03.flac"
    )}
    unrelated = root / "Artist" / "Unrelated Album" / "01.flac"
    for media_path in expected | {unrelated}:
        media_path.parent.mkdir(parents=True, exist_ok=True)
        media_path.write_bytes(b"media")
    parsed: list[Path] = []
    enumerated: list[Path] = []
    original_scandir = os.scandir

    def record_scandir(directory):
        enumerated.append(Path(directory))
        return original_scandir(directory)

    monkeypatch.setattr(os, "scandir", record_scandir)
    repository = RecordingRepository()
    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}, "IMAGE_EXTENSIONS": set()},
        repository=repository,
        root_definitions=[{"id": "main", "path": root, "category": "main_library_roots"}],
        metadata_reader=lambda path: parsed.append(path) or {
            "path": str(path), "album": "Root Album", "album_artist": "Owner",
            "artist": "Owner", "title": path.stem, "mtime": 1.0, "size": 5,
        },
    )

    reconciler.reconcile(_request(paths=(root / requested_relative,)))

    assert set(parsed) == expected
    assert set(repository.calls[0]["active_file_entries"]) == {str(path) for path in expected}
    assert not any(path.is_relative_to(root / "Artist") for path in enumerated)


def test_targeted_reconciler_enumerates_each_affected_directory_once(tmp_path):
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )

    root = tmp_path / "Music"
    album = root / "Artist" / "Album"
    album.mkdir(parents=True)
    tracks = tuple(album / f"{number:02}.flac" for number in range(1, 5))
    for track in tracks:
        track.write_bytes(b"media")
    repository = RecordingRepository()
    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}, "IMAGE_EXTENSIONS": set()},
        repository=repository,
        root_definitions=[
            {"id": "main", "path": root, "category": "main_library_roots"}
        ],
        metadata_reader=lambda path: {
            "path": str(path),
            "album": "Album",
            "album_artist": "Artist",
            "artist": "Artist",
            "title": path.stem,
            "mtime": 1.0,
            "size": 5,
        },
    )
    original = reconciler._supported_album_media
    enumerated_directories: list[Path] = []

    def record_enumeration(directory: Path):
        enumerated_directories.append(directory)
        return original(directory)

    reconciler._supported_album_media = record_enumeration

    reconciler.reconcile(_request(paths=tracks))

    assert enumerated_directories == [album]
    assert set(repository.calls[0]["active_file_entries"]) == {
        str(track) for track in tracks
    }


def test_targeted_reconciler_holds_track_reservations_while_reading_and_persisting(
    tmp_path,
):
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )

    root = tmp_path / "Music"
    album = root / "Artist" / "Album"
    requested = album / "01.flac"
    sibling = album / "02.flac"
    album.mkdir(parents=True)
    requested.write_bytes(b"one")
    sibling.write_bytes(b"two")
    events: list[str] = []
    acquired_keys: list[set[str]] = []

    class Lease:
        def release(self) -> None:
            events.append("released")

    class Repository(RecordingRepository):
        def persist_targeted_inventory_mutation(self, **kwargs):
            assert events == ["acquired", "read", "read"]
            events.append("persisted")
            return super().persist_targeted_inventory_mutation(**kwargs)

    def acquire(keys: set[str]) -> Lease:
        acquired_keys.append(keys)
        events.append("acquired")
        return Lease()

    repository = Repository()
    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}, "IMAGE_EXTENSIONS": set()},
        repository=repository,
        root_definitions=[{"id": "main", "path": root}],
        metadata_reader=lambda path: (
            events.append("read")
            or {
                "path": str(path),
                "album": "Album",
                "album_artist": "Artist",
                "artist": "Artist",
                "title": path.stem,
                "mtime": 1.0,
                "size": path.stat().st_size,
            }
        ),
        reservation_acquirer=acquire,
    )

    reconciler.reconcile(_request(paths=(requested,)))

    assert events == ["acquired", "read", "read", "persisted", "released"]
    expected_suffixes = {
        str(requested.resolve(strict=False)).casefold(),
        str(sibling.resolve(strict=False)).casefold(),
    }
    assert {
        key.removeprefix("path:").casefold()
        for key in acquired_keys[0]
    } == expected_suffixes


def test_targeted_reconciler_loads_current_exception_overrides_for_each_mutation(
    tmp_path,
):
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )

    root = tmp_path / "Music"
    track = root / "Artist" / "Album" / "01.flac"
    track.parent.mkdir(parents=True)
    track.write_bytes(b"media")
    repository = RecordingRepository()
    current_overrides = {str(track): "Non-album rarity"}
    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}, "IMAGE_EXTENSIONS": set()},
        repository=repository,
        root_definitions=[{"id": "main", "path": root}],
        metadata_reader=lambda path: {
            "path": str(path),
            "album": "Album",
            "album_artist": "Artist",
            "artist": "Artist",
            "title": path.stem,
            "mtime": 1.0,
            "size": path.stat().st_size,
        },
        exception_overrides_provider=lambda: dict(current_overrides),
    )

    reconciler.reconcile(_request(paths=(track,)))
    current_overrides[str(track)] = ""
    reconciler.reconcile(_request(paths=(track,)))

    first_entry = repository.calls[0]["active_file_entries"][str(track)]
    second_entry = repository.calls[1]["active_file_entries"][str(track)]
    assert first_entry["exception_type"] == "Non-album rarity"
    assert second_entry["exception_type"] is None


def test_targeted_reconciler_keeps_move_endpoints_in_one_repository_mutation(tmp_path):
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )

    root = tmp_path / "Music"
    source = root / "Old" / "01.flac"
    destination = root / "New" / "01.flac"
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"media")
    repository = RecordingRepository()
    reconciler = TargetedLibraryReconciler(
        {"IMAGE_EXTENSIONS": set()},
        repository=repository,
        root_definitions=[
            {"id": "main", "path": root, "category": "main_library_roots"}
        ],
        metadata_reader=lambda path: {
            "path": str(path),
            "album": "New",
            "album_artist": "Artist",
            "artist": "Artist",
            "title": "Track",
            "mtime": 1.0,
            "size": 5,
        },
    )

    move = SimpleNamespace(
        source=source,
        destination=destination,
        source_root_id="main",
        destination_root_id="main",
    )
    reconciler.reconcile(_request(moves=(move,)))

    assert len(repository.calls) == 1
    assert repository.calls[0]["deleted_paths"] == (str(source),)
    assert repository.calls[0]["moves"] == (
        {
            "source_path": str(source),
            "destination_path": str(destination),
            "source_root_id": "main",
            "destination_root_id": "main",
        },
    )
    assert list(repository.calls[0]["active_file_entries"]) == [str(destination)]


def test_targeted_reconciler_uses_destination_root_identity_for_cross_root_move(tmp_path):
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )

    source_root = tmp_path / "Main"
    destination_root = tmp_path / "Hoard"
    source = source_root / "Old" / "01.flac"
    destination = destination_root / "New" / "01.flac"
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"media")
    repository = RecordingRepository()
    reconciler = TargetedLibraryReconciler(
        {"IMAGE_EXTENSIONS": set()},
        repository=repository,
        root_definitions=[
            {"id": "main", "path": source_root, "category": "main_library_roots"},
            {"id": "hoard", "path": destination_root, "category": "hoarding_library_roots"},
        ],
        metadata_reader=lambda path: {
            "path": str(path),
            "album": "New",
            "album_artist": "Artist",
            "artist": "Artist",
            "title": "Track",
            "mtime": 1.0,
            "size": 5,
        },
    )
    move = SimpleNamespace(
        source=source,
        destination=destination,
        source_root_id="main",
        destination_root_id="hoard",
    )

    reconciler.reconcile(_request(moves=(move,)))

    entry = repository.calls[0]["active_file_entries"][str(destination)]
    assert entry["library_root_id"] == "hoard"
    assert entry["library_root_category"] == "hoard"
    assert repository.calls[0]["moves"][0]["source_root_id"] == "main"
    assert repository.calls[0]["moves"][0]["destination_root_id"] == "hoard"


@pytest.mark.parametrize("cross_root", [False, True], ids=["same-root", "cross-root"])
def test_directory_move_reads_only_supported_media_in_destination_subtree(tmp_path, cross_root):
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )

    root = tmp_path / "Music"
    destination_root = tmp_path / "Hoard" if cross_root else root
    destination_root_id = "hoard" if cross_root else "main"
    source = root / "Artist" / "Old Album"
    destination = destination_root / "Artist" / "New Album"
    disc = destination / "Disc 1"
    disc.mkdir(parents=True)
    first_track = destination / "01.flac"
    second_track = disc / "02.mp3"
    first_track.write_bytes(b"first")
    second_track.write_bytes(b"second")
    (destination / "cover.jpg").write_bytes(b"cover")
    (destination / "notes.txt").write_text("notes", encoding="utf-8")
    outside = (root if cross_root else tmp_path) / "Outside" / "private.flac"
    outside.parent.mkdir(parents=True)
    outside.write_bytes(b"private media")
    (destination / "03.flac").symlink_to(outside)
    root_definitions = [
        {"id": "main", "path": root, "category": "main_library_roots"}
    ]
    if cross_root:
        root_definitions.append(
            {"id": "hoard", "path": destination_root, "category": "hoarding_library_roots"}
        )
    parsed: list[Path] = []
    repository = RecordingRepository()
    reconciler = TargetedLibraryReconciler(
        {
            "SUPPORTED_EXTENSIONS": {".flac", ".mp3"},
            "IMAGE_EXTENSIONS": {".jpg"},
        },
        repository=repository,
        root_definitions=root_definitions,
        metadata_reader=lambda path: (
            parsed.append(path)
            or {
                "path": str(path),
                "album": "New Album",
                "album_artist": "Artist",
                "artist": "Artist",
                "title": path.stem,
                "mtime": 1.0,
                "size": path.stat().st_size,
            }
        ),
    )
    move = SimpleNamespace(
        source=source,
        destination=destination,
        source_root_id="main",
        destination_root_id=destination_root_id,
        is_directory=True,
    )

    reconciler.reconcile(_request(moves=(move,)))

    assert set(parsed) == {first_track, second_track}
    assert destination not in parsed
    assert repository.calls[0]["deleted_subtrees"] == (str(source),)
    assert set(repository.calls[0]["active_file_entries"]) == {
        str(first_track),
        str(second_track),
    }
    assert repository.calls[0]["moves"] == ({
        "source_path": str(source),
        "destination_path": str(destination),
        "source_root_id": "main",
        "destination_root_id": destination_root_id,
        "is_directory": True,
    },)
    assert {
        entry["library_root_id"]
        for entry in repository.calls[0]["active_file_entries"].values()
    } == {destination_root_id}


def test_targeted_reconciler_ignores_non_media_file_events(tmp_path):
    from music_app.services.targeted_library_reconciliation import (
        TargetedReconciliationResult,
        TargetedLibraryReconciler,
    )

    root = tmp_path / "Music"
    cover = root / "Artist" / "Album" / "cover.jpg"
    cover.parent.mkdir(parents=True)
    cover.write_bytes(b"cover")
    parsed: list[Path] = []
    repository = RecordingRepository()
    reconciler = TargetedLibraryReconciler(
        {
            "SUPPORTED_EXTENSIONS": {".flac", ".mp3"},
            "IMAGE_EXTENSIONS": {".jpg"},
        },
        repository=repository,
        root_definitions=[
            {"id": "main", "path": root, "category": "main_library_roots"}
        ],
        metadata_reader=lambda path: parsed.append(path) or {},
    )

    result = reconciler.reconcile(_request(paths=(cover,)))

    assert result == TargetedReconciliationResult(0, ())
    assert parsed == []
    assert repository.calls == []


def test_targeted_reconciler_rejects_destructive_work_for_unhealthy_root(tmp_path):
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )

    root = tmp_path / "Music"
    repository = RecordingRepository()
    reconciler = TargetedLibraryReconciler(
        {},
        repository=repository,
        root_definitions=[
            {"id": "main", "path": root, "category": "main_library_roots"}
        ],
    )

    result = reconciler.reconcile(
        _request(deleted_paths=(root / "missing.flac",)),
        root_healthy=False,
    )

    assert result.health == "root_unhealthy"
    assert result.revision == 0
    assert repository.calls == []


def test_targeted_reconciler_passes_root_scoped_deleted_subtrees_without_scanning(tmp_path):
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )

    root = tmp_path / "Music"
    deleted_album = root / "Artist" / "Deleted Album"
    repository = RecordingRepository()
    reconciler = TargetedLibraryReconciler(
        {},
        repository=repository,
        root_definitions=[
            {"id": "main", "path": root, "category": "main_library_roots"}
        ],
    )

    reconciler.reconcile(_request(deleted_subtrees=(deleted_album,)))

    assert repository.calls[0]["root_id"] == "main"
    assert repository.calls[0]["deleted_subtrees"] == (str(deleted_album),)
    assert repository.calls[0]["active_file_entries"] == {}


def test_targeted_reconciler_rejects_paths_outside_the_claimed_root(tmp_path):
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )

    root = tmp_path / "Music"
    outside = tmp_path / "Elsewhere" / "track.flac"
    outside.parent.mkdir()
    outside.write_bytes(b"media")
    repository = RecordingRepository()
    reconciler = TargetedLibraryReconciler(
        {},
        repository=repository,
        root_definitions=[
            {"id": "main", "path": root, "category": "main_library_roots"}
        ],
        metadata_reader=lambda path: {"path": str(path)},
    )

    result = reconciler.reconcile(_request(paths=(outside,)))

    assert result.health == "invalid_path"
    assert repository.calls == []


def test_targeted_reconciler_replaces_live_root_definitions(tmp_path):
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )

    old_root = tmp_path / "Old"
    new_root = tmp_path / "New"
    track = new_root / "Artist" / "Album" / "01.flac"
    track.parent.mkdir(parents=True)
    track.write_bytes(b"media")
    repository = RecordingRepository()
    reconciler = TargetedLibraryReconciler(
        {},
        repository=repository,
        root_definitions=[{"id": "old", "path": old_root}],
        metadata_reader=lambda path: {
            "path": str(path),
            "album": "Album",
            "album_artist": "Artist",
            "artist": "Artist",
            "title": "Track",
            "mtime": 1.0,
            "size": 5,
        },
    )

    reconciler.replace_roots([{"id": "new", "path": new_root}])
    result = reconciler.reconcile(_request(root_id="new", paths=(track,)))

    assert result.health == "healthy"
    assert repository.calls[0]["root_id"] == "new"
    assert repository.calls[0]["active_file_entries"][str(track)]["library_root_id"] == "new"


def test_targeted_projection_invalidation_clears_browse_and_utility_caches(monkeypatch):
    from music_app.services import state

    invalidated: list[str] = []
    monkeypatch.setattr(
        state,
        "invalidate_problematic_albums_payload_cache",
        lambda library_state: invalidated.append("problems"),
        raising=False,
    )
    monkeypatch.setattr(
        state,
        "invalidate_utility_rules_payload_cache",
        lambda library_state: invalidated.append("rules"),
        raising=False,
    )
    monkeypatch.setattr(
        state,
        "invalidate_postgres_utility_projection_cache",
        lambda **kwargs: invalidated.append("postgres"),
        raising=False,
    )
    library_state = {
        "_view_payload_root_browse_cache": {"cached": True},
        "inventory_mutation_revision": 3,
    }

    state.invalidate_targeted_library_projections(
        library_state,
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://example"},
        revision=4,
        affected_album_keys=("artist::album",),
    )

    assert library_state["_view_payload_root_browse_cache"] == {}
    assert library_state["inventory_mutation_revision"] == 4
    assert library_state["targeted_inventory_album_keys"] == ("artist::album",)
    assert invalidated == ["problems", "rules", "postgres"]


def test_committed_inventory_callbacks_publish_monotonic_revisions(monkeypatch):
    from threading import Event, Thread
    from music_app.services import state

    invalidations = []
    monkeypatch.setattr(state, "invalidate_problematic_albums_payload_cache", lambda _: invalidations.append("problems"))
    monkeypatch.setattr(state, "invalidate_utility_rules_payload_cache", lambda _: invalidations.append("rules"))
    monkeypatch.setattr(state, "invalidate_postgres_utility_projection_cache", lambda **_: invalidations.append("postgres"))
    library_state = {"inventory_mutation_revision": 3, "_view_payload_root_browse_cache": {"old": True}}
    older_committed = Event()
    release_older_callback = Event()
    failures = []

    def delayed_older_publication():
        try:
            older_committed.set()
            assert release_older_callback.wait(2)
            state.invalidate_targeted_library_projections(library_state, {}, revision=4, affected_album_keys=("old",))
        except BaseException as error:
            failures.append(error)

    worker = Thread(target=delayed_older_publication, daemon=True)
    worker.start()
    try:
        assert older_committed.wait(2)
        state.invalidate_targeted_library_projections(library_state, {}, revision=5, affected_album_keys=("new",))
        assert library_state["inventory_mutation_revision"] == 5
        library_state["_view_payload_root_browse_cache"]["since-newer-callback"] = True
    finally:
        release_older_callback.set()
        worker.join(2)
    assert not worker.is_alive()
    assert not failures
    assert library_state["inventory_mutation_revision"] == 5
    assert library_state["_view_payload_root_browse_cache"] == {}
    assert invalidations == ["problems", "rules", "postgres"] * 2


@pytest.fixture
def changing_media_stat(monkeypatch):
    original_stat = Path.stat
    samples = {}
    changing_paths = set()

    def stat_path(path, *args, **kwargs):
        result = original_stat(path, *args, **kwargs)
        if path not in changing_paths:
            return result
        samples[path] = samples.get(path, 0) + 1
        signature = SimpleNamespace(**{
            name: getattr(result, name) for name in dir(result) if name.startswith("st_")
        })
        signature.st_size += samples[path]
        signature.st_mtime_ns += samples[path]
        return signature

    monkeypatch.setattr(Path, "stat", stat_path)
    return changing_paths, samples


def test_targeted_reconciler_does_not_reintroduce_coordinator_rejected_sibling(
    tmp_path, changing_media_stat,
):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEvent, LibraryEventKind
    from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler

    root = tmp_path / "Music"
    album = root / "Artist" / "Album"
    album.mkdir(parents=True)
    ready, changing = album / "01.flac", album / "02.flac"
    ready.write_bytes(b"ready")
    changing.write_bytes(b"still being copied")
    changing_media_stat[0].add(changing)
    parsed, results, requests, problems = [], [], [], []
    repository = RecordingRepository()
    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}, "IMAGE_EXTENSIONS": set()},
        repository=repository,
        root_definitions=[{"id": "main", "path": root}],
        metadata_reader=lambda path: parsed.append(path) or {"path": str(path)},
    )

    def reconcile(request):
        requests.append(request)
        results.append(reconciler.reconcile(request))

    coordinator = LibraryEventCoordinator(
        emit_request=reconcile, emit_problem=problems.append,
        wait=lambda _seconds: None, max_stable_attempts=2,
    )
    try:
        coordinator.accept(LibraryEvent(LibraryEventKind.MODIFIED, "main", ready))
        coordinator.accept(LibraryEvent(LibraryEventKind.MODIFIED, "main", changing))
        coordinator.flush()
    finally:
        coordinator.stop()

    assert requests[0].paths == frozenset({ready})
    assert problems[0].code == "stable_write_unavailable"
    assert parsed == []
    assert repository.calls == []
    assert results[0].health == "stable_write_unavailable"
    assert results[0].revision == 0


@pytest.mark.parametrize("cross_root", [False, True], ids=["same-root", "cross-root"])
def test_targeted_reconciler_rejects_unstable_directory_move_without_partial_deletion(
    tmp_path, changing_media_stat, cross_root,
):
    from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler

    source_root = tmp_path / "Music"
    destination_root = tmp_path / "Hoard" if cross_root else source_root
    destination_root_id = "hoard" if cross_root else "main"
    source = source_root / "Artist" / "Old Album"
    destination = destination_root / "Artist" / "New Album"
    disc = destination / "Disc 1"
    disc.mkdir(parents=True)
    ready, changing = destination / "01.flac", disc / "02.flac"
    ready.write_bytes(b"ready")
    changing.write_bytes(b"still being copied")
    changing_media_stat[0].add(changing)
    parsed = []
    repository = RecordingRepository()
    roots = [{"id": "main", "path": source_root}]
    if cross_root:
        roots.append({"id": "hoard", "path": destination_root})
    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}, "IMAGE_EXTENSIONS": set()},
        repository=repository, root_definitions=roots,
        metadata_reader=lambda path: parsed.append(path) or {"path": str(path)},
    )
    move = SimpleNamespace(
        source=source, destination=destination, source_root_id="main",
        destination_root_id=destination_root_id, is_directory=True,
    )

    result = reconciler.reconcile(_request(moves=(move,)))

    assert parsed == []
    assert repository.calls == []
    assert result.health == "stable_write_unavailable"
    assert result.revision == 0


def test_targeted_reconciler_samples_expanded_targets_in_shared_rounds_under_reservation(tmp_path):
    from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler

    root = tmp_path / "Music"
    album = root / "Artist" / "Album"
    album.mkdir(parents=True)
    tracks = tuple(album / f"{number:02}.flac" for number in range(1, 9))
    for track in tracks:
        track.write_bytes(b"media")
    samples, waits, parsed = [], [], []
    reservation_held = False
    repository = RecordingRepository()

    class Reservation:
        def release(self):
            nonlocal reservation_held
            reservation_held = False

    def acquire(_keys):
        nonlocal reservation_held
        reservation_held = True
        return Reservation()

    def stat_path(path):
        assert reservation_held
        assert parsed == []
        samples.append(path)
        return (5, 10)

    def read(path):
        assert reservation_held
        assert len(samples) == 2 * len(tracks)
        parsed.append(path)
        return {"path": str(path)}

    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}, "IMAGE_EXTENSIONS": set()},
        repository=repository, root_definitions=[{"id": "main", "path": root}],
        metadata_reader=read, reservation_acquirer=acquire,
        stat_path=stat_path, wait=waits.append,
    )

    result = reconciler.reconcile(_request(paths=tracks))

    assert result.health == "healthy"
    assert samples == [*tracks, *tracks]
    assert len(waits) == 1
    assert set(parsed) == set(tracks)
    assert len(repository.calls) == 1
    assert not reservation_held


@pytest.mark.parametrize("failure", [PermissionError, FileNotFoundError])
def test_targeted_reconciler_sampling_failure_preserves_pending_deletions(tmp_path, failure):
    from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler

    root = tmp_path / "Music"
    track = root / "Artist" / "Album" / "01.flac"
    track.parent.mkdir(parents=True)
    track.write_bytes(b"media")
    repository = RecordingRepository()
    parsed, waits = [], []

    def stat_path(_path):
        raise failure("unavailable during sampling")

    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}, "IMAGE_EXTENSIONS": set()},
        repository=repository, root_definitions=[{"id": "main", "path": root}],
        metadata_reader=lambda path: parsed.append(path) or {},
        stat_path=stat_path, wait=waits.append, max_stable_attempts=3,
    )

    result = reconciler.reconcile(_request(paths=(track,), deleted_paths=(track.parent / "old.flac",)))

    assert result.health == "stable_write_unavailable"
    assert result.revision == 0
    assert parsed == []
    assert repository.calls == []
    assert len(waits) == 2


def test_targeted_reconciler_stop_cancels_sampling_without_publication(tmp_path):
    from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler

    root = tmp_path / "Music"
    track = root / "Artist" / "Album" / "01.flac"
    track.parent.mkdir(parents=True)
    track.write_bytes(b"media")
    repository = RecordingRepository()
    samples, parsed, releases = [], [], []
    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}, "IMAGE_EXTENSIONS": set()},
        repository=repository, root_definitions=[{"id": "main", "path": root}],
        metadata_reader=lambda path: parsed.append(path) or {},
        stat_path=lambda path: samples.append(path) or (5, 10),
        wait=lambda _seconds: reconciler.stop(),
        reservation_acquirer=lambda _keys: SimpleNamespace(release=lambda: releases.append(True)),
    )

    result = reconciler.reconcile(_request(paths=(track,)))

    assert result.health == "cancelled"
    assert samples == [track]
    assert parsed == []
    assert repository.calls == []
    assert releases == [True]
    assert reconciler.reconcile(_request(paths=(track,))).health == "cancelled"
    assert samples == [track]


def test_targeted_reconciler_deletion_only_does_not_sample_media(tmp_path):
    from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler

    root = tmp_path / "Music"
    repository = RecordingRepository()
    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}},
        repository=repository, root_definitions=[{"id": "main", "path": root}],
        stat_path=lambda _path: pytest.fail("deletions must not sample missing files"),
        wait=lambda _seconds: pytest.fail("deletions must not wait for stable writes"),
    )

    result = reconciler.reconcile(_request(deleted_paths=(root / "missing.flac",)))

    assert result.health == "healthy"
    assert repository.calls[0]["deleted_paths"] == (str(root / "missing.flac"),)


class StatefulTargetedRepository(RecordingRepository):
    """Model the production mutation's root-scoped active-path stale exclusion."""

    def __init__(self, active_files):
        super().__init__()
        self.active_files = set(active_files)

    def persist_targeted_inventory_mutation(self, **kwargs):
        result = super().persist_targeted_inventory_mutation(**kwargs)
        active = {
            (entry["library_root_id"], Path(path))
            for path, entry in kwargs["active_file_entries"].items()
        }
        deletions = [
            (kwargs["root_id"], Path(path), False) for path in kwargs["deleted_paths"]
        ] + [
            (kwargs["root_id"], Path(path), True) for path in kwargs["deleted_subtrees"]
        ] + [
            (move["source_root_id"], Path(move["source_path"]), move.get("is_directory", False))
            for move in kwargs["moves"]
        ]
        self.active_files.update(active)
        self.active_files.difference_update({
            item for item in self.active_files - active
            if any(item[0] == root_id and (item[1] == path or subtree and path in item[1].parents)
                   for root_id, path, subtree in deletions)
        })
        return result


@pytest.mark.parametrize("names", [("Z", "A", "M"), ("A", "Z", "M")], ids=["reverse", "forward"])
@pytest.mark.parametrize("cross_root", [False, True], ids=["same-root", "cross-root"])
@pytest.mark.parametrize("directory", [False, True], ids=["file", "directory"])
@pytest.mark.parametrize("sequence", ["undo", "chain", "replacement", "recreated"])
def test_coalesced_moves_preserve_final_persisted_files(
    tmp_path, names, cross_root, directory, sequence,
):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEvent, LibraryEventKind
    from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler

    roots = {
        name: {"id": name if cross_root else "main", "path": tmp_path / name if cross_root else tmp_path / "Music"}
        for name in names
    }
    locations = [Path(roots[name]["path"]) / "Artist" / name for name in names]
    filenames = ("01.flac", "Disc 1/02.flac") if directory else ("01.flac",)

    def populate(location):
        for filename in filenames:
            track = location / filename
            track.parent.mkdir(parents=True, exist_ok=True)
            track.write_bytes(b"media")

    populate(locations[0])
    if sequence == "replacement":
        populate(locations[2])
    initial = {
        (root["id"], track.resolve()) for root in roots.values()
        for track in Path(root["path"]).rglob("*.flac")
    }
    repository = StatefulTargetedRepository(initial)
    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}, "IMAGE_EXTENSIONS": set()},
        repository=repository, root_definitions=list(roots.values()), wait=lambda _seconds: None,
        metadata_reader=lambda path: {"path": str(path), "album": path.parent.name, "artist": "Artist"},
    )
    coordinator = LibraryEventCoordinator(emit_request=reconciler.reconcile, wait=lambda _seconds: None)

    def move(source_index, destination_index):
        source = locations[source_index] if directory else locations[source_index] / filenames[0]
        destination = locations[destination_index] if directory else locations[destination_index] / filenames[0]
        destination.parent.mkdir(parents=True, exist_ok=True)
        source.rename(destination)
        assert coordinator.accept(LibraryEvent(
            LibraryEventKind.MOVED, roots[names[source_index]]["id"], source,
            destination=destination, destination_root_id=roots[names[destination_index]]["id"],
            is_directory=directory,
        ))

    try:
        move(0, 1)
        if sequence == "undo":
            move(1, 0)
        elif sequence == "chain":
            move(1, 2)
        elif sequence == "replacement":
            move(2, 0)
        else:
            populate(locations[0])
            for filename in filenames:
                assert coordinator.accept(LibraryEvent(
                    LibraryEventKind.CREATED, roots[names[0]]["id"], locations[0] / filename,
                ))
        coordinator.flush()
    finally:
        coordinator.stop()
        reconciler.stop()

    expected = {
        (root["id"], track.resolve()) for root in roots.values()
        for track in Path(root["path"]).rglob("*.flac")
    }
    assert repository.active_files == expected
    assert coordinator._pending_entry_count == 0


@pytest.mark.parametrize("directory", [False, True], ids=["file", "directory"])
@pytest.mark.parametrize("failure", ["changing", "unreadable"])
@pytest.mark.parametrize("cross_root", [False, True])
def test_unstable_move_undo_blocks_overlapping_stale_publication(tmp_path, directory, failure, cross_root):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEvent, LibraryEventKind
    from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler

    source_root, destination_root = tmp_path / "Z", tmp_path / "A" if cross_root else tmp_path / "Z"
    source_root_id, destination_root_id = "Z-root", "A-root" if cross_root else "Z-root"
    source, destination = source_root / "Z Album", destination_root / "A Album"
    source.mkdir(parents=True)
    track = source / "01.flac"
    track.write_bytes(b"media")
    if not directory:
        source, destination = track, destination / "01.flac"
    initial = {(source_root_id, track.resolve())}
    repository = StatefulTargetedRepository(initial)
    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}}, repository=repository,
        root_definitions=[{"id": source_root_id, "path": source_root}, {"id": destination_root_id, "path": destination_root}],
        wait=lambda _seconds: None,
    )
    problems = []
    samples = 0

    def stat_path(path):
        nonlocal samples
        if path == source:
            if failure == "unreadable":
                raise PermissionError("copy not readable")
            samples += 1
            return (samples, samples)
        return path.stat()

    coordinator = LibraryEventCoordinator(
        emit_request=reconciler.reconcile, emit_problem=problems.append,
        stat_path=stat_path, wait=lambda _seconds: None,
    )
    try:
        coordinator.accept(LibraryEvent(
            LibraryEventKind.MOVED, source_root_id, source, destination=destination,
            destination_root_id=destination_root_id, is_directory=directory,
        ))
        coordinator.accept(LibraryEvent(
            LibraryEventKind.MOVED, destination_root_id, destination, destination=source,
            destination_root_id=source_root_id, is_directory=directory,
        ))
        coordinator.flush()
    finally:
        coordinator.stop()
        reconciler.stop()

    assert repository.calls == []
    assert repository.active_files == initial
    assert {problem.root_id for problem in problems} == {source_root_id, destination_root_id}
    assert {problem.code for problem in problems} == {"stable_write_unavailable"}


def test_preserved_subtree_expands_supported_live_files_inside_atomic_deletion(tmp_path, monkeypatch):
    from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler

    root = tmp_path / "Music"
    album = root / "Artist" / "Album"
    track = album / "Disc 1" / "01.flac"
    track.parent.mkdir(parents=True)
    track.write_bytes(b"media")
    (album / "note.txt").write_text("note")
    outside = tmp_path / "Outside" / "private.flac"
    outside.parent.mkdir(parents=True)
    outside.write_bytes(b"private")
    (album / "external.flac").symlink_to(outside)
    (album / "external-directory").symlink_to(outside.parent, target_is_directory=True)
    unrelated = root / "Other Artist" / "Unrelated" / "01.flac"
    unrelated.parent.mkdir(parents=True)
    unrelated.write_bytes(b"unrelated")
    original_scandir = os.scandir
    traversed = []

    def scandir(path):
        traversed.append(Path(path).resolve())
        return original_scandir(path)

    monkeypatch.setattr(os, "scandir", scandir)
    missing = album / "old.flac"
    repository = StatefulTargetedRepository({("main", track), ("main", missing)})
    parsed = []
    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}}, repository=repository,
        root_definitions=[{"id": "main", "path": root}], wait=lambda _seconds: None,
        metadata_reader=lambda path: parsed.append(path) or {"path": str(path)},
    )

    result = reconciler.reconcile(_request(deleted_subtrees=(album,), preserved_subtrees=(album,)))

    assert result.health == "healthy"
    assert parsed == [track]
    assert repository.active_files == {("main", track)}
    assert len(repository.calls) == 1
    assert traversed and all(path == album or album in path.parents for path in traversed)


def test_preserved_subtree_outside_root_is_rejected_before_expansion(tmp_path):
    from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler

    root = tmp_path / "Music"
    repository = RecordingRepository()
    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}}, repository=repository,
        root_definitions=[{"id": "main", "path": root}],
        metadata_reader=lambda _path: pytest.fail("invalid subtree must not be parsed"),
    )
    reconciler._supported_media_descendants = lambda _path: pytest.fail("invalid subtree must not be expanded")

    result = reconciler.reconcile(_request(deleted_paths=(root / "old.flac",), preserved_subtrees=(tmp_path / "Outside",)))

    assert result.health == "invalid_path"
    assert repository.calls == []


@pytest.mark.parametrize("scope", ["preserved", "moved"])
@pytest.mark.parametrize("nested", [False, True], ids=["root", "child"])
def test_unreadable_reconciliation_subtree_never_publishes_partial_deletion(tmp_path, monkeypatch, scope, nested):
    from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler

    root = tmp_path / "Music"
    album = root / "Artist" / "Album"
    track = album / "Disc 1" / "01.flac"
    track.parent.mkdir(parents=True)
    track.write_bytes(b"media")
    denied = track.parent if nested else album
    original_scandir = os.scandir

    def scandir(path):
        if Path(path) == denied:
            raise PermissionError("scoped directory unavailable")
        return original_scandir(path)

    monkeypatch.setattr(os, "scandir", scandir)
    repository = RecordingRepository()
    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}}, repository=repository,
        root_definitions=[{"id": "main", "path": root}], wait=lambda _seconds: None,
        metadata_reader=lambda _path: pytest.fail("incomplete enumeration must not parse media"),
    )
    request = (
        _request(deleted_subtrees=(album,), preserved_subtrees=(album,))
        if scope == "preserved" else _request(moves=(SimpleNamespace(
            source=root / "Old Album", destination=album, source_root_id="main",
            destination_root_id="main", is_directory=True,
        ),))
    )

    with pytest.raises(PermissionError, match="scoped directory unavailable"):
        reconciler.reconcile(request)

    assert repository.calls == []
