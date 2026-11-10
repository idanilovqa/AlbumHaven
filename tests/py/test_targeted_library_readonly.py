"""Synthetic-filesystem contracts for reconciler-owned attribute preparation.

The Windows API adapter and recording repository are explicit test boundaries.
The coordinator, reconciler, and enrichment are production implementations.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from test_library_watch_readonly import windows_attributes  # noqa: F401


class RecordingRepository:
    def __init__(self):
        self.calls = []

    def persist_targeted_inventory_mutation(self, **kwargs):
        self.calls.append(kwargs)
        return {"inventory_mutation_revision": 1, "affected_album_keys": [], "new_track_paths": list(kwargs["active_file_entries"])}


def _file(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"synthetic")
    return path


def _request(*paths, moves=(), deleted_paths=(), preserved_subtrees=()):
    return SimpleNamespace(root_id="main", paths=paths, moves=moves, deleted_paths=deleted_paths, deleted_subtrees=(), preserved_subtrees=preserved_subtrees)


def _move(source, destination, *, directory=False, destination_root_id="main"):
    return SimpleNamespace(source=source, destination=destination, source_root_id="main", destination_root_id=destination_root_id, is_directory=directory)


def _harness(root, *, roots=None, stat_path=None, wait=None, prepare=None, windows=None):
    from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler

    roots = roots if roots is not None else [{"id": "main", "path": str(root), "category": "main_library_roots"}]
    repository = RecordingRepository()
    calls, prepared, parsed, waits = [], [], [], []

    def sample(path):
        calls.append(("sample", path))
        return stat_path(path) if stat_path else path.stat()

    def pause(seconds):
        waits.append(seconds)
        if wait:
            wait(seconds)

    def preparation(path, signature, is_cancelled):
        prepared.append((path, signature))
        calls.append(("prepare", path))
        if prepare:
            prepare(path, signature, is_cancelled)
        if windows:
            windows.module.prepare_stable_library_file(
                path, signature, roots=roots, supported_extensions=(".flac", ".mp3"),
                image_extensions=(".jpg", ".png"), logger=logging.getLogger(__name__),
                is_cancelled=is_cancelled,
            )

    def metadata(path):
        parsed.append(path)
        calls.append(("metadata", path))
        return {"path": str(path), "album": "Album", "album_artist": "Artist", "artist": "Artist", "title": path.stem}

    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac", ".mp3"}, "IMAGE_EXTENSIONS": {".jpg", ".png"}},
        root_definitions=roots, repository=repository, metadata_reader=metadata,
        prepare_stable_file=preparation, stat_path=sample, wait=pause,
    )
    return SimpleNamespace(reconciler=reconciler, repository=repository, calls=calls, prepared=prepared, parsed=parsed, waits=waits, roots=roots)


@pytest.mark.parametrize("suffix", [".flac", ".MP3", ".jpg", ".PNG"])
def test_watcher_to_reconciler_normalizes_supported_creation(tmp_path, windows_attributes, suffix):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_watch import publish_watchdog_event

    windows = windows_attributes
    path = _file(tmp_path / "Artist" / "Album" / f"new{suffix}")
    windows.values[path] = 0x1 | 0x2 | 0x20
    h = _harness(tmp_path, windows=windows)
    requests = []

    def emit(request):
        requests.append(request)
        h.reconciler.reconcile(request)

    coordinator = LibraryEventCoordinator(emit_request=emit, wait=lambda _seconds: None)
    publish_watchdog_event(SimpleNamespace(event_type="created", src_path=str(path), dest_path=None, is_directory=False), roots=h.roots, publish=coordinator.accept, clock=lambda: 1.0)
    coordinator.flush()

    assert len(requests) == 1
    assert windows.values[path] == 0x2 | 0x20
    assert h.prepared == [(path, (path.stat().st_size, path.stat().st_mtime_ns))]
    assert h.waits == [0.1]
    assert [entry for entry in h.calls if entry[0] == "sample"] == [("sample", path), ("sample", path)]
    if suffix.lower() in {".jpg", ".png"}:
        assert h.parsed == []
        assert h.repository.calls == []
    else:
        assert h.parsed == [path]
        assert h.calls.index(("prepare", path)) < h.calls.index(("metadata", path))
        assert set(h.repository.calls[0]["active_file_entries"]) == {str(path)}


@pytest.mark.parametrize("cross_root", [False, True])
def test_directory_move_prepares_union_once_without_image_track_rows(tmp_path, windows_attributes, cross_root):
    windows = windows_attributes
    root = tmp_path / "root"
    destination_root = tmp_path / "second" if cross_root else root
    destination = destination_root / "Artist" / "Album"
    audio = _file(destination / "01.flac")
    image = _file(destination / "Disc 2" / "cover.PNG")
    unsupported = _file(destination / "notes.txt")
    roots = [{"id": "main", "path": str(root), "category": "main_library_roots"}]
    if cross_root:
        roots.append({"id": "second", "path": str(destination_root), "category": "main_library_roots"})
    for path in (audio, image, unsupported):
        windows.values[path] = 0x1 | 0x20
    h = _harness(root, roots=roots, windows=windows)
    result = h.reconciler.reconcile(_request(moves=(_move(root / "old", destination, directory=True, destination_root_id="second" if cross_root else "main"),)))
    assert result.health == "healthy"
    assert {path for path, _ in h.prepared} == {audio, image}
    assert len(h.prepared) == 2
    assert windows.values[audio] == windows.values[image] == 0x20
    assert windows.values[unsupported] == 0x1 | 0x20
    assert h.parsed == [audio]
    assert set(h.repository.calls[0]["active_file_entries"]) == {str(audio)}
    assert result.active_track_paths == (str(audio),)
    assert result.new_track_paths == (str(audio),)
    assert h.repository.calls[0]["deleted_subtrees"] == (str(root / "old"),)


def test_requested_file_and_moved_directory_duplicate_is_prepared_once(tmp_path):
    album = tmp_path / "Artist" / "Album"
    track = _file(album / "01.flac")
    image = _file(album / "cover.jpg")
    h = _harness(tmp_path)
    h.reconciler.reconcile(_request(track, image, moves=(_move(tmp_path / "old", album, directory=True),)))
    assert len(h.prepared) == 2
    assert {path for path, _ in h.prepared} == {track, image}
    assert h.parsed == [track]


@pytest.mark.parametrize("suffix", [".flac", ".jpg"])
def test_single_file_move_prepares_only_destination(tmp_path, suffix):
    destination = _file(tmp_path / "Artist" / "Album" / f"new{suffix}")
    source = tmp_path / f"old{suffix}"
    h = _harness(tmp_path)
    result = h.reconciler.reconcile(_request(moves=(_move(source, destination),)))
    assert [path for path, _ in h.prepared] == [destination]
    if suffix == ".jpg":
        assert h.parsed == [] and h.repository.calls == []
    else:
        assert result.revision == 1
        assert h.repository.calls[0]["moves"][0]["destination_path"] == str(destination)


def test_expanded_album_neighbours_are_not_normalized(tmp_path):
    first = _file(tmp_path / "Artist" / "Album" / "Disc 1" / "01.flac")
    sibling = _file(first.parent / "02.flac")
    other_disc = _file(first.parent.parent / "Disc 2" / "03.flac")
    cover = _file(first.parent.parent / "cover.jpg")
    h = _harness(tmp_path)
    h.reconciler.reconcile(_request(first))
    assert {path for path, _ in h.prepared} == {first}
    assert set(h.parsed) == {first, sibling, other_disc}
    assert cover not in h.parsed


def test_preserved_only_survivor_is_not_normalized(tmp_path):
    survivor = _file(tmp_path / "Artist" / "Album" / "01.flac")
    h = _harness(tmp_path)
    h.reconciler.reconcile(_request(deleted_paths=(survivor.parent / "missing.flac",), preserved_subtrees=(survivor.parent,)))
    assert h.prepared == []
    assert h.parsed == [survivor]
    assert len(h.repository.calls) == 1


def test_all_preparation_precedes_metadata_and_cover_discovery(tmp_path, monkeypatch):
    from music_app.services import library_indexing

    track = _file(tmp_path / "Artist" / "Album" / "01.flac")
    cover = _file(track.parent / "cover.jpg")
    h = _harness(tmp_path)
    original = library_indexing.find_cover_for_track_folder
    cover_reads = []

    def find_cover(*args, **kwargs):
        cover_reads.append(True)
        assert {path for path, _ in h.prepared} == {track, cover}
        return original(*args, **kwargs)

    monkeypatch.setattr(library_indexing, "find_cover_for_track_folder", find_cover)
    h.reconciler.reconcile(_request(track, cover))
    assert cover_reads
    first_metadata = next(index for index, call in enumerate(h.calls) if call[0] == "metadata")
    assert all(index < first_metadata for index, call in enumerate(h.calls) if call[0] == "prepare")


@pytest.mark.parametrize("failure", ["changing", "missing", "unreadable"])
@pytest.mark.parametrize("with_audio", [False, True])
def test_image_instability_does_not_discard_valid_inventory(tmp_path, failure, with_audio):
    track = _file(tmp_path / "Artist" / "Album" / "01.flac") if with_audio else None
    cover = _file(tmp_path / "Artist" / "Album" / "cover.jpg")
    missing = tmp_path / "removed.flac"
    count = 0

    def sample(path):
        nonlocal count
        if path == cover:
            count += 1
            if failure == "missing":
                raise FileNotFoundError("image disappeared")
            if failure == "unreadable":
                raise PermissionError("image busy")
            return (count, 1)
        return path.stat()

    h = _harness(tmp_path, stat_path=sample)
    result = h.reconciler.reconcile(_request(*((track, cover) if track else (cover,)), deleted_paths=(missing,)))
    assert result.health == "healthy"
    assert [path for path, _ in h.prepared] == ([track] if track else [])
    assert h.parsed == ([track] if track else [])
    assert len(h.repository.calls) == 1
    assert h.repository.calls[0]["deleted_paths"] == (str(missing),)
    assert set(h.repository.calls[0]["active_file_entries"]) == ({str(track)} if track else set())
    if with_audio:
        assert h.waits == [0.1]
        assert count == 2
    else:
        assert len(h.waits) <= 3 and all(wait == 0.1 for wait in h.waits)


def test_unstable_standalone_image_never_invents_inventory_mutation(tmp_path):
    cover = _file(tmp_path / "cover.jpg")
    samples = []

    def sample(path):
        samples.append(path)
        return len(samples), 1

    h = _harness(tmp_path, stat_path=sample)
    h.reconciler.reconcile(_request(cover))
    assert samples == [cover] * 4
    assert h.waits == [0.1] * 3
    assert h.prepared == h.parsed == h.repository.calls == []


def test_unstable_audio_still_blocks_destructive_publication(tmp_path):
    track = _file(tmp_path / "Artist" / "Album" / "01.flac")
    cover = _file(track.parent / "cover.jpg")
    samples = []

    def sample(path):
        samples.append(path)
        return (len(samples), 1) if path == track else path.stat()

    h = _harness(tmp_path, stat_path=sample)
    result = h.reconciler.reconcile(_request(track, cover, deleted_paths=(tmp_path / "old.flac",)))
    assert result.health == "stable_write_unavailable"
    assert h.prepared == h.parsed == h.repository.calls == []
    assert h.waits == [0.1] * 3


@pytest.mark.parametrize("failure", ["callback", "read", "write"])
def test_preparation_failure_logs_and_preserves_audio_inventory(tmp_path, windows_attributes, caplog, failure):
    windows = windows_attributes
    track = _file(tmp_path / "Artist" / "Album" / "01.flac")
    windows.values[track] = 0x1 | 0x20

    def prepare(*_args):
        if failure == "callback":
            raise OSError("root provider unavailable")

    if failure != "callback":
        windows.errors[failure] = True
    h = _harness(tmp_path, prepare=prepare, windows=windows)
    with caplog.at_level(logging.WARNING):
        result = h.reconciler.reconcile(_request(track))
    assert result.revision == 1
    assert h.parsed == [track]
    assert set(h.repository.calls[0]["active_file_entries"]) == {str(track)}
    assert any(record.levelno >= logging.WARNING for record in caplog.records)


@pytest.mark.parametrize("stop_at", ["wait", "second-sample", "preparation"])
def test_cancellation_prevents_metadata_and_inventory(tmp_path, stop_at):
    track = _file(tmp_path / "Artist" / "Album" / "01.flac")
    samples = []

    def sample(path):
        samples.append(path)
        if stop_at == "second-sample" and len(samples) == 2:
            h.reconciler.stop()
        return path.stat()

    def pause(_seconds):
        if stop_at == "wait":
            h.reconciler.stop()

    def prepare(_path, _signature, is_cancelled):
        if stop_at == "preparation":
            h.reconciler.stop()
            assert is_cancelled()

    h = _harness(tmp_path, stat_path=sample, wait=pause, prepare=prepare)
    result = h.reconciler.reconcile(_request(track))
    assert result.health == "cancelled"
    assert h.parsed == h.repository.calls == []
    assert len(h.prepared) == int(stop_at == "preparation")


@pytest.mark.parametrize("case", ["unsupported", "outside-root", "root-replaced"])
def test_reconciler_never_prepares_ineligible_paths(tmp_path, case):
    root = tmp_path / "root"
    root.mkdir()
    path = _file((tmp_path if case == "outside-root" else root) / ("notes.txt" if case == "unsupported" else "01.flac"))
    h = _harness(root)
    if case == "root-replaced":
        h.reconciler.replace_roots([{"id": "main", "path": str(tmp_path / "replacement")}])
    h.reconciler.reconcile(_request(path))
    assert h.prepared == h.parsed == h.repository.calls == []


def test_current_root_removal_after_sampling_prevents_attribute_write(tmp_path, windows_attributes):
    windows = windows_attributes
    track = _file(tmp_path / "Artist" / "Album" / "01.flac")
    windows.values[track] = 0x1 | 0x20
    roots = [{"id": "main", "path": str(tmp_path), "category": "main_library_roots"}]
    h = _harness(tmp_path, roots=roots, windows=windows, prepare=lambda *_args: roots.clear())
    h.reconciler.reconcile(_request(track))
    assert windows.values[track] == 0x1 | 0x20
    assert not any(call[0] == "set_attributes" for call in windows.calls)


def test_in_root_symlink_replacement_does_not_mutate_matching_neighbour(tmp_path, windows_attributes):
    windows = windows_attributes
    track = _file(tmp_path / "Artist" / "Album" / "01.flac")
    neighbour = _file(tmp_path / "Elsewhere" / "neighbour.flac")
    stable = track.stat()
    os.utime(neighbour, ns=(stable.st_atime_ns, stable.st_mtime_ns))
    windows.values[track] = windows.values[neighbour] = 0x1 | 0x20
    samples = []

    def sample(path):
        value = path.stat()
        samples.append(path)
        if len(samples) == 2:
            path.unlink()
            path.symlink_to(neighbour)
        return value

    h = _harness(tmp_path, windows=windows, stat_path=sample)
    h.reconciler.reconcile(_request(track))
    assert track.is_symlink()
    assert [path for path, _ in h.prepared] == [track]
    assert not any(call[0] == "set_attributes" for call in windows.calls)
    assert windows.values[neighbour] == 0x1 | 0x20
    assert len(h.repository.calls) == 1


def test_repeated_attribute_events_do_not_create_repeated_writes(tmp_path, windows_attributes):
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_watch import LibraryEvent, LibraryEventKind

    windows = windows_attributes
    track = _file(tmp_path / "Artist" / "Album" / "01.flac")
    windows.values[track] = 0x1 | 0x20
    h = _harness(tmp_path, windows=windows)
    coordinator = LibraryEventCoordinator(emit_request=h.reconciler.reconcile, wait=lambda _seconds: None)
    for _ in range(4):
        coordinator.accept(LibraryEvent(LibraryEventKind.MODIFIED, "main", track))
        coordinator.flush()
    assert len(h.repository.calls) == 4
    assert len([call for call in windows.calls if call[0] == "set_attributes"]) == 1


@pytest.mark.parametrize("unstable", [False, True])
def test_image_only_directory_move_samples_images_without_losing_move(tmp_path, unstable):
    image = _file(tmp_path / "Artist" / "Album" / "Disc 2" / "cover.PNG")
    destination = image.parent.parent
    source = tmp_path / "old-album"
    samples = []

    def sample(path):
        samples.append(path)
        return (len(samples), 1) if unstable else path.stat()

    h = _harness(tmp_path, stat_path=sample)
    result = h.reconciler.reconcile(_request(moves=(_move(source, destination, directory=True),)))
    assert result.health == "healthy"
    assert samples == [image] * (4 if unstable else 2)
    assert h.waits == [0.1] * (3 if unstable else 1)
    assert [path for path, _ in h.prepared] == ([] if unstable else [image])
    assert h.parsed == []
    assert len(h.repository.calls) == 1
    mutation = h.repository.calls[0]
    assert mutation["active_file_entries"] == {}
    assert mutation["deleted_subtrees"] == (str(source),)
    assert mutation["moves"][0]["destination_path"] == str(destination)


def test_stable_image_with_pending_deletion_is_prepared_before_publication(tmp_path):
    image = _file(tmp_path / "cover.jpg")
    deleted = tmp_path / "old.flac"
    h = _harness(tmp_path)
    result = h.reconciler.reconcile(_request(image, deleted_paths=(deleted,)))
    assert result.revision == 1
    assert [path for path, _ in h.prepared] == [image]
    assert h.waits == [0.1]
    assert h.parsed == []
    assert h.repository.calls[0]["active_file_entries"] == {}
    assert h.repository.calls[0]["deleted_paths"] == (str(deleted),)


def test_created_directory_prepares_supported_descendants(tmp_path):
    album = tmp_path / "Artist" / "Album"
    audio = _file(album / "Disc 1" / "01.flac")
    image = _file(album / "art" / "cover.jpg")
    _file(album / "notes.txt")
    h = _harness(tmp_path)
    h.reconciler.reconcile(_request(album))
    assert {path for path, _ in h.prepared} == {audio, image}
    assert h.parsed == [audio]
    assert set(h.repository.calls[0]["active_file_entries"]) == {str(audio)}


def test_unreadable_optional_image_entry_does_not_drop_directory_audio(
    tmp_path, windows_attributes, monkeypatch, caplog,
):
    windows = windows_attributes
    album = tmp_path / "Artist" / "Album"
    audio = _file(album / "01.flac")
    image = _file(album / "cover.jpg")
    windows.values[audio] = windows.values[image] = 0x1 | 0x20
    original_scandir = os.scandir
    failed_image_checks = []

    class Entry:
        def __init__(self, entry):
            self._entry = entry

        def __getattr__(self, name):
            return getattr(self._entry, name)

        def is_file(self, *args, **kwargs):
            if Path(self._entry.path) == image:
                failed_image_checks.append(image)
                raise PermissionError("optional image entry is unreadable")
            return self._entry.is_file(*args, **kwargs)

    class Entries:
        def __init__(self, path):
            self._entries = original_scandir(path)

        def __iter__(self):
            return self

        def __next__(self):
            return Entry(next(self._entries))

        def __getattr__(self, name):
            return getattr(self._entries, name)

        def __enter__(self):
            self._entries.__enter__()
            return self

        def __exit__(self, *args):
            return self._entries.__exit__(*args)

    monkeypatch.setattr(os, "scandir", Entries)
    h = _harness(tmp_path, windows=windows)
    with caplog.at_level(logging.WARNING):
        result = h.reconciler.reconcile(_request(album))

    assert failed_image_checks
    assert result.health == "healthy"
    assert result.revision == 1
    assert h.parsed == [audio]
    assert [path for path, _ in h.prepared] == [audio]
    assert len(h.repository.calls) == 1
    assert set(h.repository.calls[0]["active_file_entries"]) == {str(audio)}
    assert windows.values[audio] == 0x20
    assert windows.values[image] == 0x1 | 0x20
    assert not any(call[0] == "set_attributes" and call[1] == image for call in windows.calls)
    assert any(record.levelno >= logging.WARNING for record in caplog.records)


@pytest.mark.parametrize("directory_move", [False, True])
def test_optional_image_normalization_resolve_failure_preserves_audio_inventory(
    tmp_path, windows_attributes, monkeypatch, caplog, directory_move,
):
    windows = windows_attributes
    album = tmp_path / "Artist" / "Album"
    audio = _file(album / "01.flac")
    image = _file(album / "cover.jpg")
    source = tmp_path / "old-album"
    windows.values[audio] = windows.values[image] = 0x1 | 0x20
    original_resolve = Path.resolve
    image_resolves = []

    def resolve(self, *args, **kwargs):
        if self == image:
            image_resolves.append(self)
            # The first resolve is the existing containment validation. Only
            # the subsequent normalization-key lookup fails; all other reads
            # retain the real filesystem behavior.
            if len(image_resolves) == 2:
                raise OSError("optional image normalization lookup failed")
        return original_resolve(self, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", resolve)
    h = _harness(tmp_path, windows=windows)
    request = (
        _request(moves=(_move(source, album, directory=True),))
        if directory_move else _request(album)
    )
    with caplog.at_level(logging.WARNING):
        result = h.reconciler.reconcile(request)

    assert len(image_resolves) >= 2
    assert result.health == "healthy"
    assert result.revision == 1
    assert h.parsed == [audio]
    assert [path for path, _ in h.prepared] == [audio]
    assert len(h.repository.calls) == 1
    mutation = h.repository.calls[0]
    assert set(mutation["active_file_entries"]) == {str(audio)}
    if directory_move:
        assert mutation["deleted_subtrees"] == (str(source),)
        assert mutation["moves"][0]["destination_path"] == str(album)
    assert windows.values[audio] == 0x20
    assert windows.values[image] == 0x1 | 0x20
    assert not any(call[0] == "set_attributes" and call[1] == image for call in windows.calls)
    assert any(record.levelno >= logging.WARNING for record in caplog.records)
