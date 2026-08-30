from __future__ import annotations

import hashlib
import inspect
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services import library
from music_app.services import library_indexing
from music_app.services.metadata import FILE_METADATA_SCHEMA_VERSION


def test_cooperative_scan_yield_releases_request_threads_at_bounded_intervals(monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr(library_indexing.time, "sleep", sleeps.append)

    library_indexing._cooperative_scan_yield(4)
    library_indexing._cooperative_scan_yield(5)
    library_indexing._cooperative_scan_yield(10)

    assert sleeps == [0.001, 0.001]


def test_ordered_scan_metadata_entries_reads_misses_concurrently_but_yields_discovery_order(
    tmp_path: Path,
    monkeypatch,
):
    paths = [tmp_path / f"{index:02d}.mp3" for index in range(4)]
    file_stats = [
        (path, SimpleNamespace(st_mtime=1.0, st_size=1))
        for path in paths
    ]
    barrier = threading.Barrier(4)
    lock = threading.Lock()
    active_reads = 0
    peak_reads = 0
    completion_order = []

    def read_metadata(path):
        nonlocal active_reads, peak_reads
        with lock:
            active_reads += 1
            peak_reads = max(peak_reads, active_reads)
        barrier.wait(timeout=2)
        time.sleep((4 - int(path.stem)) * 0.03)
        with lock:
            completion_order.append(path.name)
            active_reads -= 1
        return {"path": str(path), "title": path.stem}

    monkeypatch.setattr(library_indexing, "read_metadata_for_file", read_metadata)

    entries = list(
        library_indexing._ordered_scan_metadata_entries(
            {"scan_generation": 7, "scan_in_progress": True},
            file_stats,
            {},
            expected_scan_generation=7,
        )
    )

    assert peak_reads == 4
    assert completion_order != [path.name for path in paths]
    assert [path for path, _stat, _existing, _entry, _read in entries] == paths
    assert [entry["title"] for _path, _stat, _existing, entry, _read in entries] == [
        path.stem for path in paths
    ]
    assert all(read for _path, _stat, _existing, _entry, read in entries)


def test_iter_scandir_entries_reports_directory_read_failure_with_path_and_error(
    tmp_path: Path,
    monkeypatch,
):
    root = tmp_path / "Unreadable Library"
    failures = []

    def fail_scandir(path):
        assert path == root
        raise PermissionError("directory access denied")

    monkeypatch.setattr(library_indexing.os, "scandir", fail_scandir)

    entries = list(
        library_indexing._iter_scandir_entries(
            root,
            record_file_error=lambda action, **fields: failures.append({
                "action": action,
                **fields,
            }),
        )
    )

    assert entries == []
    assert failures == [{
        "action": "Library directory read failed",
        "path": str(root),
        "error": "directory access denied",
        "error_type": "PermissionError",
    }]


def test_iter_scandir_entries_reports_directory_entry_inspection_failure(
    tmp_path: Path,
    monkeypatch,
):
    root = tmp_path / "Library"
    blocked_path = root / "blocked"
    failures = []

    class FailingEntry:
        name = blocked_path.name
        path = str(blocked_path)

        @staticmethod
        def is_dir(*, follow_symlinks):
            assert follow_symlinks is False
            raise PermissionError("entry attributes unavailable")

    class ScanContext:
        def __enter__(self):
            return iter([FailingEntry()])

        def __exit__(self, exc_type, exc, traceback):
            return False

    monkeypatch.setattr(library_indexing.os, "scandir", lambda _path: ScanContext())

    entries = list(
        library_indexing._iter_scandir_entries(
            root,
            record_file_error=lambda action, **fields: failures.append({
                "action": action,
                **fields,
            }),
        )
    )

    assert entries == []
    assert failures == [{
        "action": "Library directory entry inspection failed",
        "path": str(blocked_path),
        "error": "entry attributes unavailable",
        "error_type": "PermissionError",
    }]


def test_cached_cover_metadata_reports_file_inspection_failure(tmp_path: Path):
    missing_cover = tmp_path / "missing-cover.jpg"
    entry = {"cover_path": str(missing_cover)}
    cover_metadata_cache = {}
    failures = []

    library_indexing._apply_cached_local_cover_metadata(
        entry,
        cover_metadata_cache=cover_metadata_cache,
        record_file_error=lambda action, **fields: failures.append({
            "action": action,
            **fields,
        }),
    )

    assert entry["local_cover_width"] is None
    assert entry["local_cover_height"] is None
    assert entry["cover_revision"] is None
    assert failures == [{
        "action": "Library cover file inspection failed",
        "path": str(missing_cover),
        "error": str(missing_cover),
        "error_type": "FileNotFoundError",
    }]


def test_cached_cover_metadata_reports_corrupt_image_decode_failure(tmp_path: Path):
    corrupt_cover = tmp_path / "corrupt-cover.jpg"
    corrupt_cover.write_bytes(b"not-an-image")
    entry = {"cover_path": str(corrupt_cover)}
    failures = []

    library_indexing._apply_cached_local_cover_metadata(
        entry,
        cover_metadata_cache={},
        record_file_error=lambda action, **fields: failures.append({
            "action": action,
            **fields,
        }),
    )

    assert entry["local_cover_width"] is None
    assert entry["local_cover_height"] is None
    assert failures
    assert failures[0]["action"] == "Library cover image decode failed"
    assert failures[0]["path"] == str(corrupt_cover)
    assert failures[0]["error"]
    assert failures[0]["error_type"]


def test_discover_music_files_reports_candidate_stat_failure_with_file_metadata(
    tmp_path: Path,
    monkeypatch,
):
    root = tmp_path / "Library"
    track_path = root / "Artist" / "Album" / "blocked.mp3"
    failures = []

    class FailingEntry:
        name = track_path.name
        path = str(track_path)

        @staticmethod
        def is_dir(*, follow_symlinks):
            assert follow_symlinks is False
            return False

        @staticmethod
        def stat(*, follow_symlinks):
            assert follow_symlinks is False
            raise OSError("file attributes unavailable")

    class ScanContext:
        def __enter__(self):
            return iter([FailingEntry()])

        def __exit__(self, exc_type, exc, traceback):
            return False

    monkeypatch.setattr(library_indexing.os, "scandir", lambda path: ScanContext())

    discovered, album_folder_count, total_bytes = (
        library_indexing._discover_music_files_with_stats(
            {},
            roots=[root],
            supported_extensions={".mp3"},
            expected_scan_generation=None,
            record_file_error=lambda action, **fields: failures.append({
                "action": action,
                **fields,
            }),
        )
    )

    assert discovered == []
    assert album_folder_count == 0
    assert total_bytes == 0
    assert failures == [{
        "action": "Library candidate file stat failed",
        "path": str(track_path),
        "error": "file attributes unavailable",
        "error_type": "OSError",
    }]


def test_ordered_scan_metadata_entries_reports_file_read_failure_before_reraising(
    tmp_path: Path,
    monkeypatch,
):
    track_path = tmp_path / "Artist" / "Album" / "unreadable.mp3"
    failures = []
    file_stats = [(track_path, SimpleNamespace(st_mtime=1.0, st_size=10))]

    def fail_metadata_read(path):
        assert path == track_path
        raise PermissionError("audio file read denied")

    monkeypatch.setattr(library_indexing, "read_metadata_for_file", fail_metadata_read)

    with pytest.raises(PermissionError, match="audio file read denied"):
        list(
            library_indexing._ordered_scan_metadata_entries(
                {"scan_generation": 4, "scan_in_progress": True},
                file_stats,
                {},
                expected_scan_generation=4,
                record_file_error=lambda action, **fields: failures.append({
                    "action": action,
                    **fields,
                }),
            )
        )

    assert failures == [{
        "action": "Library metadata read failed",
        "path": str(track_path),
        "error": "audio file read denied",
        "error_type": "PermissionError",
    }]


def test_estimate_scan_remaining_seconds_uses_blended_progress_and_smoothing():
    early_eta = library_indexing._estimate_scan_remaining_seconds(
        elapsed_seconds=2.0,
        processed=8,
        total=100,
        bytes_processed=8_000,
        total_bytes=100_000,
        samples=[(100.0, 0, 0, 0.0), (102.0, 8, 8_000, 0.08)],
        previous_eta_seconds=0.0,
    )
    assert early_eta == 0.0

    first_eta = library_indexing._estimate_scan_remaining_seconds(
        elapsed_seconds=8.0,
        processed=20,
        total=100,
        bytes_processed=10_000,
        total_bytes=100_000,
        samples=[(100.0, 0, 0, 0.0), (108.0, 20, 10_000, 0.17)],
        previous_eta_seconds=0.0,
    )
    assert round(first_eta, 2) == 39.06

    smoothed_eta = library_indexing._estimate_scan_remaining_seconds(
        elapsed_seconds=10.0,
        processed=24,
        total=100,
        bytes_processed=12_000,
        total_bytes=100_000,
        samples=[(102.0, 4, 2_000, 0.03), (110.0, 24, 12_000, 0.2)],
        previous_eta_seconds=first_eta,
    )
    assert round(smoothed_eta, 2) == 38.61
    assert smoothed_eta < first_eta


def test_scan_library_file_cache_reuses_unchanged_cached_entry(tmp_path: Path, monkeypatch):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    track_path = album_root / "song.mp3"
    cover_path = album_root / "cover.jpg"
    track_path.write_bytes(b"track")
    cover_path.write_bytes(b"cover")

    stat = track_path.stat()
    existing_entry = {
        "path": str(track_path),
        "title": track_path.stem,
        "album": "Album",
        "artist": "Artist",
        "album_artist": "Artist",
        "track_number": None,
        "disc_number": None,
        "disc_number_raw": None,
        "year": 2000,
        "release_date": "2000-01-01",
        "edition": "",
        "album_rating": 0,
        "duration_seconds": 180,
        "mtime": stat.st_mtime,
        "size": stat.st_size,
        "cover_path": str(cover_path),
        "remote_cover_url": "https://example.test/cover.jpg",
        "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
    }
    library_state = {"file_cache": {str(track_path): existing_entry}}

    metadata_calls = []
    override_calls = []
    monkeypatch.setattr(
        library_indexing,
        "read_metadata_for_file",
        lambda path: metadata_calls.append(path) or {
            "path": str(path),
            "title": path.stem,
            "album": "Album",
            "artist": "Artist",
            "album_artist": "Artist",
            "track_number": None,
            "disc_number": None,
            "disc_number_raw": None,
            "year": 2000,
            "release_date": "2000-01-01",
            "edition": "",
            "album_rating": 0,
            "duration_seconds": 180,
            "mtime": path.stat().st_mtime,
            "size": path.stat().st_size,
            "cover_path": str(cover_path),
        },
    )
    monkeypatch.setattr(
        library_indexing,
        "apply_exception_override",
        lambda entry, overrides: override_calls.append((dict(entry), dict(overrides))),
    )

    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        library_state,
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
    )

    assert metadata_calls == []
    assert override_calls == [(existing_entry, {})]
    assert updated_file_cache[str(track_path)]["remote_cover_url"] == "https://example.test/cover.jpg"
    assert library_state["scan_total"] == 1
    assert library_state["scan_processed"] == 1
    assert library_state["scan_current_path"] == ""


def test_scan_library_file_cache_preserves_remote_cover_fields_when_reindexing(tmp_path: Path, monkeypatch):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    track_path = album_root / "song.mp3"
    cover_path = album_root / "cover.jpg"
    track_path.write_bytes(b"track")
    cover_path.write_bytes(b"cover")

    library_state = {
        "file_cache": {
            str(track_path): {
                "path": str(track_path),
                "mtime": 0.0,
                "size": 0,
                "remote_cover_url": "https://example.test/cover.jpg",
                "remote_cover_source_label": "Apple Music",
            }
        }
    }
    monkeypatch.setattr(
        library_indexing,
        "read_metadata_for_file",
        lambda path: {
            "path": str(path),
            "album": "Album",
            "artist": "Artist",
            "mtime": path.stat().st_mtime,
            "size": path.stat().st_size,
            "cover_path": None,
        },
    )
    monkeypatch.setattr(
        library_indexing,
        "apply_exception_override",
        lambda entry, overrides: entry.update({"exception_type": overrides.get(entry["path"])}),
    )

    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        library_state,
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={str(track_path): "Non-album rarity"},
    )

    assert updated_file_cache[str(track_path)]["remote_cover_url"] == "https://example.test/cover.jpg"
    assert updated_file_cache[str(track_path)]["remote_cover_source_label"] == "Apple Music"
    assert updated_file_cache[str(track_path)]["cover_path"] == str(cover_path)
    assert updated_file_cache[str(track_path)]["exception_type"] == "Non-album rarity"


def test_scan_library_file_cache_repairs_missing_cover_paths(tmp_path: Path, monkeypatch):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    track_path = album_root / "song.mp3"
    cover_path = album_root / "cover.jpg"
    track_path.write_bytes(b"track")
    cover_path.write_bytes(b"cover")

    monkeypatch.setattr(
        library_indexing,
        "read_metadata_for_file",
        lambda path: {
            "path": str(path),
            "title": path.stem,
            "album": "Album",
            "artist": "Artist",
            "album_artist": "Artist",
            "track_number": None,
            "disc_number": None,
            "disc_number_raw": None,
            "year": 2000,
            "release_date": "2000-01-01",
            "edition": "",
            "album_rating": 0,
            "duration_seconds": 180,
            "mtime": path.stat().st_mtime,
            "size": path.stat().st_size,
            "cover_path": str(album_root / "missing.jpg"),
        },
    )

    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        {"file_cache": {}},
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
    )

    assert updated_file_cache[str(track_path)]["cover_path"] == str(cover_path)


def test_scan_library_file_cache_reuses_folder_cover_lookup_for_multiple_tracks(tmp_path: Path, monkeypatch):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    first_track = album_root / "song1.mp3"
    second_track = album_root / "song2.mp3"
    cover_path = album_root / "cover.jpg"
    first_track.write_bytes(b"track-1")
    second_track.write_bytes(b"track-2")
    cover_path.write_bytes(b"cover")

    cover_lookup_calls = []
    image_dimension_calls = []

    monkeypatch.setattr(
        library_indexing,
        "read_metadata_for_file",
        lambda path: {
            "path": str(path),
            "title": path.stem,
            "album": "Album",
            "artist": "Artist",
            "album_artist": "Artist",
            "track_number": None,
            "disc_number": None,
            "disc_number_raw": None,
            "year": 2000,
            "release_date": "2000-01-01",
            "edition": "",
            "album_rating": 0,
            "duration_seconds": 180,
            "mtime": path.stat().st_mtime,
            "size": path.stat().st_size,
            "cover_path": None,
        },
    )
    monkeypatch.setattr(
        library_indexing,
        "find_cover_for_track_folder",
        lambda folder, image_extensions: cover_lookup_calls.append((str(folder), tuple(sorted(image_extensions)))) or cover_path,
    )
    monkeypatch.setattr(
        library_indexing,
        "image_dimensions",
        lambda path, **_kwargs: image_dimension_calls.append(str(path)) or (1200, 1200),
    )

    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        {"file_cache": {}},
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
    )

    assert len(updated_file_cache) == 2
    assert cover_lookup_calls == [(str(album_root), (".jpg",))]
    assert image_dimension_calls == [str(cover_path)]
    assert updated_file_cache[str(first_track)]["local_cover_width"] == 1200
    assert updated_file_cache[str(second_track)]["local_cover_height"] == 1200


def test_full_scan_derives_cover_revision_from_same_path_cover_bytes(tmp_path: Path, monkeypatch):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    first_track = album_root / "song1.mp3"
    second_track = album_root / "song2.mp3"
    cover_path = album_root / "cover.jpg"
    first_track.write_bytes(b"track-1")
    second_track.write_bytes(b"track-2")
    original_cover_bytes = b"original-cover-bytes"
    replacement_cover_bytes = b"replacement-cover-bytes"
    cover_path.write_bytes(original_cover_bytes)

    monkeypatch.setattr(
        library_indexing,
        "read_metadata_for_file",
        lambda path: {
            "path": str(path),
            "title": path.stem,
            "album": "Album",
            "artist": "Artist",
            "album_artist": "Artist",
            "mtime": path.stat().st_mtime,
            "size": path.stat().st_size,
            "cover_path": None,
        },
    )
    monkeypatch.setattr(library_indexing, "image_dimensions", lambda _path, **_kwargs: (1200, 1200))
    revision_calls = []
    real_cover_revision_for_path = library_indexing.cover_revision_for_path
    monkeypatch.setattr(
        library_indexing,
        "cover_revision_for_path",
        lambda path: revision_calls.append(path) or real_cover_revision_for_path(path),
    )

    library_state = {"file_cache": {}}
    first_cache, _ = library_indexing.scan_library_file_cache(
        library_state,
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
        use_existing_cache=False,
    )
    original_revision = hashlib.sha256(original_cover_bytes).hexdigest()

    assert {entry["cover_revision"] for entry in first_cache.values()} == {
        original_revision
    }
    assert revision_calls == [cover_path]

    cover_path.write_bytes(replacement_cover_bytes)
    revision_calls.clear()
    library_state["file_cache"] = first_cache
    second_cache, _ = library_indexing.scan_library_file_cache(
        library_state,
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
    )
    replacement_revision = hashlib.sha256(replacement_cover_bytes).hexdigest()

    assert replacement_revision != original_revision
    assert {entry["cover_path"] for entry in second_cache.values()} == {str(cover_path)}
    assert {entry["cover_revision"] for entry in second_cache.values()} == {
        replacement_revision
    }
    assert revision_calls == [cover_path]


def test_scan_library_file_cache_reuses_existing_cover_validation_for_multiple_cached_tracks(tmp_path: Path, monkeypatch):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    first_track = album_root / "song1.mp3"
    second_track = album_root / "song2.mp3"
    cover_path = album_root / "cover.jpg"
    first_track.write_bytes(b"track-1")
    second_track.write_bytes(b"track-2")
    cover_path.write_bytes(b"cover")

    first_stat = first_track.stat()
    second_stat = second_track.stat()
    existing_entry = lambda path, stat: {
        "path": str(path),
        "title": path.stem,
        "album": "Album",
        "artist": "Artist",
        "album_artist": "Artist",
        "track_number": None,
        "disc_number": None,
        "disc_number_raw": None,
        "year": 2000,
        "release_date": "2000-01-01",
        "edition": "",
        "album_rating": 0,
        "duration_seconds": 180,
        "mtime": stat.st_mtime,
        "size": stat.st_size,
        "cover_path": str(cover_path),
        "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
    }

    find_cover_calls = []
    image_dimension_calls = []

    monkeypatch.setattr(
        library_indexing,
        "find_cover_for_track_folder",
        lambda folder, image_extensions: find_cover_calls.append(str(folder)) or cover_path,
    )
    monkeypatch.setattr(
        library_indexing,
        "image_dimensions",
        lambda path, **_kwargs: image_dimension_calls.append(str(path)) or (1400, 1400),
    )

    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        {
            "file_cache": {
                str(first_track): existing_entry(first_track, first_stat),
                str(second_track): existing_entry(second_track, second_stat),
            }
        },
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
    )

    assert len(updated_file_cache) == 2
    assert find_cover_calls == []
    assert image_dimension_calls == [str(cover_path)]
    assert updated_file_cache[str(first_track)]["local_cover_width"] == 1400
    assert updated_file_cache[str(second_track)]["local_cover_height"] == 1400


def test_incremental_scan_reuses_unchanged_persisted_cover_validation(tmp_path: Path, monkeypatch):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    track_path = album_root / "song.mp3"
    cover_path = album_root / "cover.jpg"
    track_path.write_bytes(b"track")
    cover_path.write_bytes(b"cover")
    track_stat = track_path.stat()
    cover_stat = cover_path.stat()
    existing_entry = {
        "path": str(track_path),
        "title": "Song",
        "album": "Album",
        "artist": "Artist",
        "album_artist": "Artist",
        "track_number": 1,
        "disc_number": None,
        "disc_number_raw": None,
        "year": 2000,
        "release_date": "2000-01-01",
        "edition": "",
        "album_rating": 0,
        "duration_seconds": 180,
        "mtime": track_stat.st_mtime,
        "size": track_stat.st_size,
        "cover_path": str(cover_path),
        "cover_revision": "cached-cover-revision",
        "local_cover_width": 1400,
        "local_cover_height": 1400,
        "cover_validation_path": str(cover_path),
        "cover_validation_mtime_ns": cover_stat.st_mtime_ns,
        "cover_validation_size": cover_stat.st_size,
        "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
    }

    monkeypatch.setattr(
        library_indexing,
        "image_dimensions",
        lambda *_args, **_kwargs: pytest.fail("unchanged cover must not be decoded"),
    )
    monkeypatch.setattr(
        library_indexing,
        "cover_revision_for_path",
        lambda *_args, **_kwargs: pytest.fail("unchanged cover must not be rehashed"),
    )

    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        {"file_cache": {str(track_path): existing_entry}},
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
    )

    updated_entry = updated_file_cache[str(track_path)]
    assert updated_entry["cover_revision"] == "cached-cover-revision"
    assert updated_entry["local_cover_width"] == 1400
    assert updated_entry["local_cover_height"] == 1400
    assert updated_entry["cover_validation_path"] == str(cover_path)
    assert updated_entry["cover_validation_mtime_ns"] == cover_stat.st_mtime_ns
    assert updated_entry["cover_validation_size"] == cover_stat.st_size


def test_scan_library_file_cache_tracks_eta_and_album_folder_progress(tmp_path: Path, monkeypatch):
    first_album = tmp_path / "Artist" / "Album"
    second_album = tmp_path / "Artist" / "Other Album" / "Disc 1"
    first_album.mkdir(parents=True)
    second_album.mkdir(parents=True)
    first_track = first_album / "song1.mp3"
    second_track = second_album / "song2.mp3"
    first_track.write_bytes(b"track-1")
    second_track.write_bytes(b"track-2")

    time_values = iter([100.0, 101.0, 102.0, 104.0])
    monkeypatch.setattr(library_indexing.time, "time", lambda: next(time_values))
    monkeypatch.setattr(
        library_indexing,
        "read_metadata_for_file",
        lambda path: {
            "path": str(path),
            "title": path.stem,
            "album": path.parent.name,
            "artist": "Artist",
            "album_artist": "Artist",
            "track_number": None,
            "disc_number": None,
            "disc_number_raw": None,
            "year": 2000,
            "release_date": "2000-01-01",
            "edition": "",
            "album_rating": 0,
            "duration_seconds": 180,
            "mtime": path.stat().st_mtime,
            "size": path.stat().st_size,
            "cover_path": None,
        },
    )

    library_state = {"file_cache": {}}
    updated_file_cache, last_scan = library_indexing.scan_library_file_cache(
        library_state,
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
    )

    assert len(updated_file_cache) == 2
    assert last_scan == 104.0
    assert library_state["scan_total"] == 2
    assert library_state["scan_processed"] == 2
    assert library_state["scan_elapsed_seconds"] == 4.0
    assert library_state["scan_estimated_remaining_seconds"] == 0.0
    assert library_state["scan_files_per_second"] == 1.0
    assert library_state["scan_album_folders_processed"] == 2
    assert library_state["scan_album_folders_total"] == 2


def test_scan_library_file_cache_publishes_partial_albums_during_scan(tmp_path: Path, monkeypatch):
    artist_root = tmp_path / "Artist"
    first_album = artist_root / "Album One"
    second_album = artist_root / "Album Two"
    first_album.mkdir(parents=True)
    second_album.mkdir(parents=True)

    for index in range(250):
        (first_album / f"track-{index:03d}.mp3").write_bytes(b"track")
    (second_album / "track-251.mp3").write_bytes(b"track")

    published_counts = []
    partial_snapshots = []
    original_build = library_indexing.build_albums_from_file_cache

    def counting_build(file_cache, separate_release_keys=None):
        albums = original_build(file_cache, separate_release_keys)
        published_counts.append(len(albums))
        return albums

    monkeypatch.setattr(library_indexing, "build_albums_from_file_cache", counting_build)
    monkeypatch.setattr(
        library_indexing,
        "read_metadata_for_file",
        lambda path: {
            "path": str(path),
            "album": path.parent.name,
            "artist": "Artist",
            "album_artist": "Artist",
            "title": path.stem,
            "track_number": None,
            "disc_number": None,
            "disc_number_raw": None,
            "year": 2000,
            "release_date": "2000-01-01",
            "edition": "",
            "album_rating": 0,
            "duration_seconds": 180,
            "mtime": path.stat().st_mtime,
            "size": path.stat().st_size,
            "cover_path": None,
        },
    )

    library_state = {"file_cache": {}, "albums": [], "separate_release_keys": set()}
    publication_state = {"file_cache": {}, "albums": [], "separate_release_keys": set()}
    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        library_state,
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
        publication_state=publication_state,
        publish_partial_snapshot=lambda: partial_snapshots.append(
            (
                len(publication_state["file_cache"]),
                len(publication_state["albums"]),
            )
        ),
    )

    assert len(updated_file_cache) == 251
    assert published_counts
    assert published_counts[0] == 1
    assert published_counts[-1] == 2
    assert partial_snapshots == [(250, 1)]
    assert len(publication_state["albums"]) == 2


def test_cache_aware_incremental_scan_skips_unchanged_partial_album_publication(
    tmp_path: Path,
    monkeypatch,
):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)

    existing_paths = []
    for index in range(250):
        path = album_root / f"track-{index:03d}.mp3"
        path.write_bytes(b"track")
        existing_paths.append(path)
    new_path = album_root / "track-250.mp3"
    new_path.write_bytes(b"new-track")

    def metadata_for(path: Path) -> dict[str, object]:
        stat = path.stat()
        return {
            "path": str(path),
            "album": "Album",
            "artist": "Artist",
            "album_artist": "Artist",
            "title": path.stem,
            "track_number": None,
            "disc_number": None,
            "disc_number_raw": None,
            "year": 2000,
            "release_date": "2000-01-01",
            "edition": "",
            "album_rating": 0,
            "duration_seconds": 180,
            "mtime": stat.st_mtime,
            "size": stat.st_size,
            "cover_path": None,
            "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
        }

    existing_cache = {
        str(path): metadata_for(path)
        for path in existing_paths
    }
    publication_state = {
        "file_cache": existing_cache,
        "albums": library_indexing.build_albums_from_file_cache(existing_cache),
        "separate_release_keys": set(),
    }
    library_state = {
        "file_cache": existing_cache,
        "albums": publication_state["albums"],
        "separate_release_keys": set(),
    }
    published_input_sizes = []
    partial_snapshots = []
    original_build = library_indexing.build_albums_from_file_cache

    def counting_build(file_cache, separate_release_keys=None):
        published_input_sizes.append(len(file_cache))
        return original_build(file_cache, separate_release_keys)

    def read_new_metadata(path: Path):
        assert path == new_path
        return metadata_for(path)

    monkeypatch.setattr(library_indexing, "build_albums_from_file_cache", counting_build)
    monkeypatch.setattr(library_indexing, "read_metadata_for_file", read_new_metadata)

    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        library_state,
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
        use_existing_cache=True,
        publication_state=publication_state,
        publish_partial_snapshot=lambda: partial_snapshots.append(
            len(publication_state["file_cache"])
        ),
    )

    assert len(updated_file_cache) == 251
    assert published_input_sizes == [251]
    assert partial_snapshots == []
    assert len(publication_state["file_cache"]) == 251
    assert len(publication_state["albums"]) == 1
    assert len(publication_state["albums"][0].tracks) == 251


def test_scan_library_file_cache_stages_publication_while_live_progress_remains_visible(
    tmp_path: Path,
    monkeypatch,
):
    album_root = tmp_path / "New Artist" / "New Album"
    album_root.mkdir(parents=True)
    track_path = album_root / "new-song.mp3"
    track_path.write_bytes(b"track")

    old_file_cache = {
        "old-song.mp3": {
            "path": "old-song.mp3",
            "album": "Old Album",
            "artist": "Old Artist",
            "album_artist": "Old Artist",
            "title": "Old Song",
        }
    }
    old_album = SimpleNamespace(key="old artist::old album", name="Old Album")
    library_state = {
        "file_cache": old_file_cache,
        "albums": [old_album],
        "separate_release_keys": {"old artist::old album"},
        "scan_generation": 3,
        "scan_in_progress": True,
    }
    publication_state = {
        "file_cache": old_file_cache,
        "albums": [old_album],
        "separate_release_keys": {"new artist::new album"},
    }
    monkeypatch.setattr(
        library_indexing,
        "read_metadata_for_file",
        lambda path: {
            "path": str(path),
            "album": "New Album",
            "artist": "New Artist",
            "album_artist": "New Artist",
            "title": "New Song",
            "track_number": 1,
            "disc_number": 1,
            "year": 2026,
            "mtime": path.stat().st_mtime,
            "size": path.stat().st_size,
            "cover_path": None,
        },
    )

    assert "publication_state" in inspect.signature(
        library_indexing.scan_library_file_cache
    ).parameters
    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        library_state,
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
        use_existing_cache=False,
        expected_scan_generation=3,
        publication_state=publication_state,
    )

    assert set(updated_file_cache) == {str(track_path)}
    assert library_state["file_cache"] is old_file_cache
    assert library_state["albums"] == [old_album]
    assert library_state["separate_release_keys"] == {"old artist::old album"}
    assert library_state["scan_total"] == 1
    assert library_state["scan_processed"] == 1
    assert library_state["scan_current_path"] == ""
    assert set(publication_state["file_cache"]) == {str(track_path)}
    assert len(publication_state["albums"]) == 1
    assert publication_state["albums"][0].name == "New Album"


def test_scan_library_file_cache_rereads_unchanged_legacy_rating_metadata_only(
    tmp_path: Path,
    monkeypatch,
):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    legacy_track = album_root / "legacy.mp3"
    complete_track = album_root / "complete.mp3"
    legacy_track.write_bytes(b"legacy")
    complete_track.write_bytes(b"complete")

    def cached_entry(path: Path, *, rating: int | None, complete: bool):
        stat = path.stat()
        entry = {
            "path": str(path),
            "title": path.stem,
            "album": "Album",
            "artist": "Artist",
            "album_artist": "Artist",
            "album_rating": rating,
            "mtime": stat.st_mtime,
            "size": stat.st_size,
            "cover_path": None,
        }
        if complete:
            entry["metadata_schema_version"] = FILE_METADATA_SCHEMA_VERSION
            entry["release_date"] = None
        return entry

    legacy_entry = cached_entry(legacy_track, rating=None, complete=False)
    complete_entry = cached_entry(complete_track, rating=7, complete=True)
    metadata_calls: list[Path] = []

    def read_metadata(path: Path):
        metadata_calls.append(path)
        entry = cached_entry(path, rating=9, complete=True)
        return entry

    monkeypatch.setattr(library_indexing, "read_metadata_for_file", read_metadata)
    monkeypatch.setattr(
        library_indexing,
        "find_cover_for_track_folder",
        lambda *_args, **_kwargs: None,
    )

    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        {
            "file_cache": {
                str(legacy_track): legacy_entry,
                str(complete_track): complete_entry,
            }
        },
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
    )

    assert metadata_calls == [legacy_track]
    assert updated_file_cache[str(legacy_track)]["album_rating"] == 9
    assert (
        updated_file_cache[str(legacy_track)]["metadata_schema_version"]
        == FILE_METADATA_SCHEMA_VERSION
    )
    assert updated_file_cache[str(complete_track)]["album_rating"] == 7


def test_force_scan_preserves_persisted_album_compilation_classification(
    tmp_path: Path,
    monkeypatch,
):
    album_root = tmp_path / "Control Family" / "Non-Compilation Cross-Credits"
    album_root.mkdir(parents=True)
    track_path = album_root / "01.mp3"
    track_path.write_bytes(b"changed-track")
    previous_entry = {
        "path": str(track_path),
        "title": "Control Signal",
        "album": "Non-Compilation Cross-Credits",
        "artist": "Control Signal Partner",
        "album_artist": "Control Signal Lead",
        "track_number": 1,
        "disc_number": 1,
        "disc_number_raw": "1",
        "year": 2026,
        "release_date": "2026-01-01",
        "edition": "",
        "album_rating": None,
        "duration_seconds": 180,
        "mtime": 0.0,
        "size": 0,
        "cover_path": None,
        "is_compilation": False,
        "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
    }
    monkeypatch.setattr(
        library_indexing,
        "read_metadata_for_file",
        lambda path: {
            **previous_entry,
            "path": str(path),
            "mtime": path.stat().st_mtime,
            "size": path.stat().st_size,
        }
        | {"is_compilation": True},
    )
    monkeypatch.setattr(
        library_indexing,
        "find_cover_for_track_folder",
        lambda *_args, **_kwargs: None,
    )

    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        {"file_cache": {str(track_path): previous_entry}},
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
        use_existing_cache=False,
    )

    assert updated_file_cache[str(track_path)]["is_compilation"] is False


def test_partial_scan_publish_schedule_keeps_first_browse_and_bounds_rebuilds():
    checkpoints = [
        processed
        for processed in range(1, 3001)
        if library_indexing._should_publish_partial_scan(processed=processed, total=3000)
    ]

    assert checkpoints == [250, 1250, 2250]
    assert not library_indexing._should_publish_partial_scan(processed=249, total=3000)
    assert not library_indexing._should_publish_partial_scan(processed=3000, total=3000)
    assert not library_indexing._should_publish_partial_scan(processed=200, total=200)


def test_large_album_projection_has_exact_yield_cadence_without_changing_output_order(monkeypatch):
    file_cache = {}
    for index in range(3000):
        artist_number = index // 30
        album_number = index // 3
        path = f"C:/Music/Artist {artist_number:03d}/Album {album_number:04d}/track-{index:04d}.mp3"
        file_cache[path] = {
            "path": path,
            "album": f"Album {album_number:04d}",
            "artist": f"Artist {artist_number:03d}",
            "album_artist": f"Artist {artist_number:03d}",
            "title": f"Track {index % 3 + 1}",
            "track_number": index % 3 + 1,
            "disc_number": 1,
            "year": 2000 + album_number % 20,
            "duration_seconds": 180,
            "cover_path": None,
        }

    sleeps = []
    monkeypatch.setattr(library.time, "sleep", lambda seconds: sleeps.append(seconds))
    albums = library.build_albums_from_file_cache(file_cache)

    assert sleeps == [0] * 28
    assert len(albums) == 1000
    assert [album.name for album in albums[:3]] == ["Album 0000", "Album 0001", "Album 0002"]
    assert [track.title for track in albums[0].tracks] == ["Track 1", "Track 2", "Track 3"]
    assert [album.name for album in albums[-3:]] == ["Album 0997", "Album 0998", "Album 0999"]


def test_album_projection_yields_zero_times_below_large_build_threshold(monkeypatch):
    file_cache = {
        f"C:/Music/Artist/Album {index:04d}/track.mp3": {
            "path": f"C:/Music/Artist/Album {index:04d}/track.mp3",
            "album": f"Album {index:04d}",
            "artist": "Artist",
            "album_artist": "Artist",
            "title": "Track",
        }
        for index in range(999)
    }
    sleeps = []
    monkeypatch.setattr(library.time, "sleep", lambda seconds: sleeps.append(seconds))

    albums = library.build_albums_from_file_cache(file_cache)

    assert len(albums) == 999
    assert sleeps == []


def test_filtered_large_projection_still_yields_by_source_input_cadence(monkeypatch):
    file_cache = {}
    for index in range(3000):
        path = f"C:/Music/Artist/Loose/track-{index:04d}.mp3"
        file_cache[path] = {
            "path": path,
            "album": "Non Album" if index % 2 else "Filtered Album",
            "artist": "Artist",
            "album_artist": "Artist",
            "title": f"Track {index}",
            "exception_type": "non_album" if index % 2 == 0 else "",
        }
    sleeps = []
    monkeypatch.setattr(library.time, "sleep", lambda seconds: sleeps.append(seconds))

    albums = library.build_albums_from_file_cache(file_cache)

    assert albums == []
    assert sleeps == [0] * 12


def test_scan_library_file_cache_bounds_projection_rebuilds_and_keeps_exact_final_state(
    tmp_path: Path,
    monkeypatch,
):
    discovered = []
    expected_paths = set()
    for index in range(3000):
        path = tmp_path / f"Artist {index // 30:03d}" / f"Album {index // 3:04d}" / f"track-{index:04d}.mp3"
        discovered.append((path, SimpleNamespace(st_mtime=1.0, st_size=5)))
        expected_paths.add(str(path))

    stale_path = tmp_path / "Stale Artist" / "Stale Album" / "stale.mp3"
    first_path = discovered[0][0]
    library_state = {
        "file_cache": {
            str(first_path): {
                "path": str(first_path),
                "album": "Old Album Name",
                "artist": "Artist 000",
                "album_artist": "Artist 000",
                "title": "old title",
                "mtime": 0.0,
                "size": 5,
                "cover_path": None,
                "remote_cover_url": "https://example.test/preserved.jpg",
            },
            str(stale_path): {
                "path": str(stale_path),
                "album": "Stale Album",
                "artist": "Stale Artist",
                "album_artist": "Stale Artist",
                "title": "stale",
                "mtime": 0.0,
                "size": 5,
                "cover_path": None,
            },
        },
        "albums": [],
        "separate_release_keys": set(),
    }

    monkeypatch.setattr(
        library_indexing,
        "_discover_music_files_with_stats",
        lambda *_args, **_kwargs: (discovered, 1000, 15_000),
    )
    monkeypatch.setattr(library_indexing, "find_cover_for_track_folder", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        library_indexing,
        "read_metadata_for_file",
        lambda path: {
            "path": str(path),
            "album": path.parent.name,
            "artist": path.parent.parent.name,
            "album_artist": path.parent.parent.name,
            "title": path.stem,
            "track_number": None,
            "disc_number": None,
            "disc_number_raw": None,
            "year": 2000,
            "release_date": "2000-01-01",
            "edition": "",
            "album_rating": 0,
            "duration_seconds": 180,
            "mtime": 1.0,
            "size": 5,
            "cover_path": None,
        },
    )

    publish_counts = []
    published_album_names = []
    published_first_entries = []
    original_publish = library_indexing._publish_partial_scan_albums

    def recording_publish(state, updated_file_cache, **kwargs):
        original_publish(state, updated_file_cache, **kwargs)
        publish_counts.append(len(updated_file_cache))
        published_album_names.append({str(getattr(album, "name", "") or "") for album in state["albums"]})
        published_first_entries.append(dict(state["file_cache"][str(first_path)]))

    monkeypatch.setattr(library_indexing, "_publish_partial_scan_albums", recording_publish)

    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        library_state,
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
    )

    assert publish_counts == [250, 1250, 2250, 3000]
    assert "Album 0000" in published_album_names[0]
    assert "Old Album Name" not in published_album_names[0]
    assert "Stale Album" in published_album_names[0]
    assert published_first_entries[0]["album"] == "Album 0000"
    assert published_first_entries[0]["remote_cover_url"] == "https://example.test/preserved.jpg"
    assert set(updated_file_cache) == expected_paths
    assert set(library_state["file_cache"]) == expected_paths
    assert len(library_state["albums"]) == 1000
    assert "Stale Album" not in published_album_names[-1]
    assert updated_file_cache[str(first_path)]["remote_cover_url"] == "https://example.test/preserved.jpg"


def test_forced_full_rescan_with_existing_projection_builds_only_final_album_state(
    tmp_path: Path,
    monkeypatch,
):
    discovered = [
        (
            tmp_path
            / f"Artist {index // 100:03d}"
            / f"Album {index // 10:04d}"
            / f"track-{index:04d}.mp3",
            SimpleNamespace(st_mtime=1.0, st_size=5),
        )
        for index in range(7_201)
    ]
    existing_path = str(discovered[0][0])
    existing_entry = {
        "path": existing_path,
        "album": "Previously Indexed",
        "artist": "Existing Artist",
        "album_artist": "Existing Artist",
        "title": "Existing Track",
        "mtime": 0.0,
        "size": 5,
        "cover_path": None,
    }
    existing_albums = [SimpleNamespace(name="Previously Indexed")]
    library_state = {
        "file_cache": {existing_path: existing_entry},
        "albums": existing_albums,
        "separate_release_keys": set(),
    }
    publication_state = {
        "file_cache": {existing_path: existing_entry},
        "albums": existing_albums,
        "separate_release_keys": set(),
    }
    projection_input_sizes = []
    partial_snapshots = []

    monkeypatch.setattr(
        library_indexing,
        "_discover_music_files_with_stats",
        lambda *_args, **_kwargs: (discovered, 721, 36_005),
    )
    monkeypatch.setattr(
        library_indexing,
        "read_metadata_for_file",
        lambda path: {
            "path": str(path),
            "album": path.parent.name,
            "artist": path.parent.parent.name,
            "album_artist": path.parent.parent.name,
            "title": path.stem,
            "mtime": 1.0,
            "size": 5,
            "cover_path": None,
        },
    )
    monkeypatch.setattr(
        library_indexing,
        "find_cover_for_track_folder",
        lambda *_args, **_kwargs: None,
    )

    def recording_build(file_cache, _separate_release_keys=None):
        projection_input_sizes.append(len(file_cache))
        return [SimpleNamespace(name="Final Projection")]

    monkeypatch.setattr(
        library_indexing,
        "build_albums_from_file_cache",
        recording_build,
    )

    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        library_state,
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
        use_existing_cache=False,
        publication_state=publication_state,
        publish_partial_snapshot=lambda: partial_snapshots.append(
            len(publication_state["file_cache"])
        ),
    )

    assert projection_input_sizes == [7_201]
    assert partial_snapshots == []
    assert len(updated_file_cache) == 7_201
    assert publication_state["file_cache"] == updated_file_cache
    assert publication_state["albums"][0].name == "Final Projection"


def test_scan_library_file_cache_keeps_existing_library_visible_during_partial_publish(tmp_path: Path, monkeypatch):
    artist_root = tmp_path / "Artist"
    first_album = artist_root / "Album One"
    second_album = artist_root / "Album Two"
    first_album.mkdir(parents=True)
    second_album.mkdir(parents=True)

    for index in range(250):
        (first_album / f"track-{index:03d}.mp3").write_bytes(b"track")
    (second_album / "track-251.mp3").write_bytes(b"track")

    previous_track = artist_root / "Previously Indexed" / "track-000.mp3"
    previous_track.parent.mkdir(parents=True)
    previous_track.write_bytes(b"older-track")
    previous_track_mtime = previous_track.stat().st_mtime
    previous_track_size = previous_track.stat().st_size
    previous_track.unlink()

    published_album_names = []
    original_build = library_indexing.build_albums_from_file_cache

    def recording_build(file_cache, separate_release_keys=None):
        albums = original_build(file_cache, separate_release_keys)
        published_album_names.append(sorted(str(getattr(album, "name", "") or "") for album in albums))
        return albums

    monkeypatch.setattr(library_indexing, "build_albums_from_file_cache", recording_build)
    monkeypatch.setattr(
        library_indexing,
        "read_metadata_for_file",
        lambda path: {
            "path": str(path),
            "album": path.parent.name,
            "artist": "Artist",
            "album_artist": "Artist",
            "title": path.stem,
            "track_number": None,
            "disc_number": None,
            "disc_number_raw": None,
            "year": 2000,
            "release_date": "2000-01-01",
            "edition": "",
            "album_rating": 0,
            "duration_seconds": 180,
            "mtime": path.stat().st_mtime,
            "size": path.stat().st_size,
            "cover_path": None,
        },
    )

    library_state = {
        "file_cache": {
            str(previous_track): {
                "path": str(previous_track),
                "album": "Previously Indexed",
                "artist": "Artist",
                "album_artist": "Artist",
                "title": previous_track.stem,
                "track_number": None,
                "disc_number": None,
                "disc_number_raw": None,
                "year": 1999,
                "release_date": "1999-01-01",
                "edition": "",
                "album_rating": 0,
                "duration_seconds": 180,
                "mtime": previous_track_mtime,
                "size": previous_track_size,
                "cover_path": None,
            },
        },
        "albums": [],
        "separate_release_keys": set(),
    }
    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        library_state,
        roots=[tmp_path],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
        use_existing_cache=False,
    )

    assert len(updated_file_cache) == 251
    assert published_album_names
    assert "Previously Indexed" in published_album_names[0]
    assert ["Album One", "Previously Indexed"] in published_album_names
    assert published_album_names[-1] == ["Album One", "Album Two"]
    assert sorted(str(getattr(album, "name", "") or "") for album in library_state["albums"]) == [
        "Album One",
        "Album Two",
    ]
    assert str(previous_track) not in library_state["file_cache"]


def test_scan_library_file_cache_aggregates_configured_roots_in_order(tmp_path: Path, monkeypatch):
    first_root = tmp_path / "Main Library"
    second_root = tmp_path / "New Arrivals"
    first_track = first_root / "Artist A" / "Album A" / "song-a.mp3"
    second_track = second_root / "Artist B" / "Album B" / "song-b.mp3"
    first_track.parent.mkdir(parents=True)
    second_track.parent.mkdir(parents=True)
    first_track.write_bytes(b"a")
    second_track.write_bytes(b"bb")

    monkeypatch.setattr(
        library_indexing,
        "read_metadata_for_file",
        lambda path: {
            "path": str(path),
            "title": path.stem,
            "album": path.parent.name,
            "artist": path.parent.parent.name,
            "album_artist": path.parent.parent.name,
            "track_number": None,
            "disc_number": None,
            "disc_number_raw": None,
            "year": 2000,
            "release_date": "2000-01-01",
            "edition": "",
            "album_rating": 0,
            "duration_seconds": 180,
            "mtime": path.stat().st_mtime,
            "size": path.stat().st_size,
            "cover_path": None,
        },
    )

    library_state = {"file_cache": {}, "albums": [], "separate_release_keys": set()}
    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        library_state,
        roots=[first_root, second_root],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
    )

    assert list(updated_file_cache) == [str(first_track), str(second_track)]
    assert library_state["scan_total"] == 2
    assert library_state["scan_album_folders_total"] == 2


def test_scan_library_file_cache_persists_root_provenance_for_each_indexed_file(tmp_path: Path, monkeypatch):
    main_root = tmp_path / "Main Library"
    arrivals_root = tmp_path / "New Arrivals"
    main_track = main_root / "Artist A" / "Album A" / "song-a.mp3"
    arrivals_track = arrivals_root / "Artist B" / "Album B" / "song-b.mp3"
    main_track.parent.mkdir(parents=True)
    arrivals_track.parent.mkdir(parents=True)
    main_track.write_bytes(b"a")
    arrivals_track.write_bytes(b"b")

    monkeypatch.setattr(
        library_indexing,
        "read_metadata_for_file",
        lambda path: {
            "path": str(path),
            "title": path.stem,
            "album": path.parent.name,
            "artist": path.parent.parent.name,
            "album_artist": path.parent.parent.name,
            "track_number": None,
            "disc_number": None,
            "disc_number_raw": None,
            "year": 2000,
            "release_date": "2000-01-01",
            "edition": "",
            "album_rating": 0,
            "duration_seconds": 180,
            "mtime": path.stat().st_mtime,
            "size": path.stat().st_size,
            "cover_path": None,
        },
    )

    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        {"file_cache": {}, "albums": [], "separate_release_keys": set()},
        roots=[main_root, arrivals_root],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
        root_definitions=[
            {"id": "main-1", "path": str(main_root), "category": "main_library_roots"},
            {"id": "arrivals-1", "path": str(arrivals_root), "category": "new_arrivals_roots"},
        ],
    )

    assert updated_file_cache[str(main_track)]["library_root_id"] == "main-1"
    assert updated_file_cache[str(main_track)]["library_root_category"] == "main_library"
    assert updated_file_cache[str(arrivals_track)]["library_root_id"] == "arrivals-1"
    assert updated_file_cache[str(arrivals_track)]["library_root_category"] == "new_arrivals"


def test_cache_aware_scan_resolves_root_provenance_once_per_track_folder(
    tmp_path: Path,
    monkeypatch,
):
    main_root = tmp_path / "Main Library"
    arrivals_root = tmp_path / "New Arrivals"
    album_folders = [
        main_root / "Artist A" / "Album A",
        arrivals_root / "Artist B" / "Album B",
    ]
    discovered = []
    existing_file_cache = {}
    for album_index, album_folder in enumerate(album_folders):
        for track_index in range(18):
            path = album_folder / f"track-{track_index + 1:02d}.mp3"
            entry = {
                "path": str(path),
                "title": path.stem,
                "album": album_folder.name,
                "artist": album_folder.parent.name,
                "album_artist": album_folder.parent.name,
                "track_number": track_index + 1,
                "disc_number": 1,
                "year": 2026,
                "release_date": None,
                "mtime": 1.0,
                "size": album_index + 1,
                "cover_path": None,
                "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
            }
            existing_file_cache[str(path)] = entry
            discovered.append(
                (
                    path,
                    SimpleNamespace(
                        st_mtime=entry["mtime"],
                        st_size=entry["size"],
                    ),
                )
            )

    roots = [
        {"id": "main-1", "path": str(main_root), "category": "main_library_roots"},
        {"id": "arrivals-1", "path": str(arrivals_root), "category": "new_arrivals_roots"},
    ]
    root_match_calls = []

    def match_root(configured_roots, path):
        root_match_calls.append(path)
        return configured_roots[0] if path.parent == album_folders[0] else configured_roots[1]

    monkeypatch.setattr(
        library_indexing,
        "_discover_music_files_with_stats",
        lambda *_args, **_kwargs: (discovered, 2, 54),
    )
    monkeypatch.setattr(
        library_indexing,
        "root_definition_for_path",
        match_root,
    )
    monkeypatch.setattr(
        library_indexing,
        "find_cover_for_track_folder",
        lambda *_args, **_kwargs: None,
    )

    updated_file_cache, _ = library_indexing.scan_library_file_cache(
        {
            "file_cache": existing_file_cache,
            "albums": [object()],
        },
        roots=[main_root, arrivals_root],
        supported_extensions={".mp3"},
        image_extensions={".jpg"},
        exception_overrides={},
        root_definitions=roots,
    )

    assert root_match_calls == [
        album_folders[0] / "track-01.mp3",
        album_folders[1] / "track-01.mp3",
    ]
    assert {
        entry["library_root_id"]
        for entry in updated_file_cache.values()
    } == {"main-1", "arrivals-1"}
