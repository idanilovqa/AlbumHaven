from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace


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


def test_directory_move_reads_only_supported_media_in_destination_subtree(tmp_path):
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )

    root = tmp_path / "Music"
    source = root / "Artist" / "Old Album"
    destination = root / "Artist" / "New Album"
    disc = destination / "Disc 1"
    disc.mkdir(parents=True)
    first_track = destination / "01.flac"
    second_track = disc / "02.mp3"
    first_track.write_bytes(b"first")
    second_track.write_bytes(b"second")
    (destination / "cover.jpg").write_bytes(b"cover")
    (destination / "notes.txt").write_text("notes", encoding="utf-8")
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
        destination_root_id="main",
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
