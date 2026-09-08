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
    moves: tuple[tuple[Path, Path], ...] = (),
):
    return SimpleNamespace(
        root_id=root_id,
        paths=paths,
        deleted_paths=deleted_paths,
        deleted_subtrees=deleted_subtrees,
        moves=moves,
    )


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
