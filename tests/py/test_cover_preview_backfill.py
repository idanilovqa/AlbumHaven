from __future__ import annotations

from pathlib import Path
import threading
import time

import pytest


class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return list(self._rows)


class _Connection:
    def __init__(self, rows):
        self._rows = rows
        self.executed = []

    def execute(self, sql):
        self.executed.append(" ".join(str(sql).split()))
        return _Cursor(self._rows)


class _ConnectionContext:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self.connection

    def __exit__(self, exc_type, exc, traceback):
        return False


def test_backfill_loads_distinct_database_cover_paths_and_uses_album_owned_storage(
    tmp_path,
):
    from music_app.services.cover_preview_backfill import CoverPreviewBackfill

    first = tmp_path / "Artist" / "One" / "cover.jpg"
    second = tmp_path / "Artist" / "Two" / "folder.png"
    connection = _Connection([
        {"cover_path": str(first)},
        {"cover_path": str(second)},
    ])
    generated = []
    worker = CoverPreviewBackfill(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@example/library"},
        connect=lambda *_args, **_kwargs: _ConnectionContext(connection),
        generate=lambda source_path, **kwargs: generated.append(
            (Path(source_path), Path(kwargs["cache_root"]), kwargs["max_size"])
        ),
        throttle_seconds=0,
    )

    assert worker.run_once() == 2
    assert generated == [
        (first, first.parent / ".album-haven", 480),
        (second, second.parent / ".album-haven", 480),
    ]
    assert len(connection.executed) == 1
    assert "SELECT DISTINCT cover_path" in connection.executed[0]
    assert "FROM library.local_albums" in connection.executed[0]


def test_backfill_uses_a_bounded_background_pool_checkout(tmp_path):
    from music_app.services.cover_preview_backfill import CoverPreviewBackfill

    connection = _Connection([])
    checkout_calls = []

    def connect(database_url, **kwargs):
        checkout_calls.append((database_url, kwargs))
        return _ConnectionContext(connection)

    worker = CoverPreviewBackfill(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@example/library"},
        connect=connect,
    )

    assert worker.run_once() == 0
    assert checkout_calls == [
        (
            "postgresql://app@example/library",
            {"workload": "background", "checkout_timeout_seconds": 1.0},
        )
    ]


def test_backfill_cleans_previous_relocation_directories_only_for_custom_storage(tmp_path):
    from music_app.services.cover_preview_backfill import CoverPreviewBackfill
    from music_app.services.generated_preview_storage import preview_storage_policy_from_mapping

    source = tmp_path / "album/cover.jpg"
    old = source.parent / ".album-haven"
    (old / "v1/cover_variants/ab").mkdir(parents=True)
    source.write_bytes(b"original art")
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@example/library",
        "_GENERATED_PREVIEW_STORAGE_POLICY": preview_storage_policy_from_mapping({}),
    }
    connection = _Connection([{"cover_path": str(source)}])
    worker = CoverPreviewBackfill(
        config,
        connect=lambda *_args, **_kwargs: _ConnectionContext(connection),
        generate=lambda *_args, **_kwargs: None,
        throttle_seconds=0,
    )
    worker.run_once()
    assert old.exists()
    config["_GENERATED_PREVIEW_STORAGE_POLICY"] = preview_storage_policy_from_mapping(
        {"mode": "custom", "active_root": str(tmp_path / "ssd")}
    )
    worker.run_once()
    assert not old.exists()
    assert source.read_bytes() == b"original art"


def test_backfill_deletes_leftover_album_folder_previews_once_previews_live_elsewhere(tmp_path):
    from music_app.services.cover_preview_backfill import CoverPreviewBackfill
    from music_app.services.generated_preview_storage import preview_storage_policy_from_mapping

    source = tmp_path / "Art Zoyd/1980 - Génération sans futur/cover.jpg"
    old = source.parent / ".album-haven"
    legacy = old / "cover_variants/ab/abcdef.webp"
    current = old / "v1/cover_variants/cd/cdef01.webp"
    for preview in (legacy, current):
        preview.parent.mkdir(parents=True)
        preview.write_bytes(b"generated preview")
    source.write_bytes(b"original art")
    track = source.parent / "01 - Génération sans futur.flac"
    track.write_bytes(b"audio")
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@example/library",
        "_GENERATED_PREVIEW_STORAGE_POLICY": preview_storage_policy_from_mapping({}),
    }
    connection = _Connection([{"cover_path": str(source)}])
    generated = []
    worker = CoverPreviewBackfill(
        config,
        connect=lambda *_args, **_kwargs: _ConnectionContext(connection),
        generate=lambda path, **kwargs: generated.append(Path(kwargs["cache_root"])),
        throttle_seconds=0,
    )
    worker.run_once()
    assert legacy.exists() and current.exists(), "album-folder storage keeps its previews"

    custom_root = tmp_path / "ssd/previews"
    config["_GENERATED_PREVIEW_STORAGE_POLICY"] = preview_storage_policy_from_mapping(
        {"mode": "custom", "active_root": str(custom_root)}
    )
    worker.run_once()
    assert not old.exists(), "no .album-haven folder remains in the music folder"
    assert generated[-1] == custom_root / "v1", "new previews are written to the separate location"
    assert source.read_bytes() == b"original art"
    assert track.read_bytes() == b"audio"


def test_album_folder_preview_removal_keeps_unknown_files(tmp_path):
    from music_app.services.generated_preview_storage import remove_album_folder_previews

    old = tmp_path / "album/.album-haven"
    (old / "v1/cover_variants/ab").mkdir(parents=True)
    (old / "v1/cover_variants/ab/preview.webp").write_bytes(b"generated")
    (old / "notes.txt").write_text("user file")
    remove_album_folder_previews(old)
    assert not (old / "v1").exists()
    assert (old / "notes.txt").read_text() == "user file"


def test_backfill_cleanup_failure_does_not_starve_previews_and_attempts_each_root_once(tmp_path, monkeypatch):
    from music_app.services import cover_preview_backfill as backfill
    from music_app.services.generated_preview_storage import preview_storage_policy_from_mapping

    sources = [tmp_path / "locked/cover.jpg", tmp_path / "locked/front.jpg", tmp_path / "next/cover.jpg"]
    attempts = []
    generated = []

    def cleanup(root):
        attempts.append(root)
        if root.parent.name == "locked":
            raise PermissionError("Legacy preview folder is inaccessible")

    monkeypatch.setattr(backfill, "remove_album_folder_previews", cleanup)
    connection = _Connection([{"cover_path": str(path)} for path in sources])
    worker = backfill.CoverPreviewBackfill(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@example/library",
         "_GENERATED_PREVIEW_STORAGE_POLICY": preview_storage_policy_from_mapping(
             {"mode": "custom", "active_root": str(tmp_path / "ssd")})},
        connect=lambda *_args, **_kwargs: _ConnectionContext(connection),
        generate=lambda path, **_kwargs: generated.append(path), throttle_seconds=0,
    )
    assert worker.run_once() == 3
    assert generated == sources
    assert attempts == [tmp_path / "locked/.album-haven", tmp_path / "next/.album-haven"]


def test_backfill_pauses_for_foreground_activity_then_resumes(tmp_path):
    from music_app.services.cover_preview_backfill import CoverPreviewBackfill

    source = tmp_path / "Artist" / "Album" / "cover.jpg"
    connection = _Connection([{"cover_path": str(source)}])
    generated = threading.Event()
    worker = CoverPreviewBackfill(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@example/library"},
        connect=lambda *_args, **_kwargs: _ConnectionContext(connection),
        generate=lambda *_args, **_kwargs: generated.set(),
        quiet_seconds=0.08,
        throttle_seconds=0,
        rescan_seconds=60,
    )

    worker.note_foreground_activity()
    worker.start()
    try:
        assert not generated.wait(timeout=0.03)
        assert generated.wait(timeout=0.5)
    finally:
        worker.stop(timeout_seconds=1)


def test_backfill_stop_interrupts_foreground_pause_without_generation(tmp_path):
    from music_app.services.cover_preview_backfill import CoverPreviewBackfill

    source = tmp_path / "Artist" / "Album" / "cover.jpg"
    connection = _Connection([{"cover_path": str(source)}])
    generated = []
    worker = CoverPreviewBackfill(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@example/library"},
        connect=lambda *_args, **_kwargs: _ConnectionContext(connection),
        generate=lambda *_args, **_kwargs: generated.append(source),
        quiet_seconds=10,
        throttle_seconds=0,
    )

    worker.note_foreground_activity()
    worker.start()
    deadline = time.monotonic() + 1
    while not worker.is_running and time.monotonic() < deadline:
        time.sleep(0.005)
    worker.stop(timeout_seconds=1)

    assert generated == []
    assert worker.is_running is False


def test_backfill_uses_configured_data_dir_and_cover_revision(tmp_path):
    from music_app.services.cover_preview_backfill import CoverPreviewBackfill

    source = tmp_path / "Artist" / "Album" / "cover.jpg"
    data_dir = tmp_path / "app-data"
    connection = _Connection(
        [{"cover_path": str(source), "cover_revision": "cover-sha256"}]
    )
    generated = []
    worker = CoverPreviewBackfill(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@example/library",
            "DATA_DIR": str(data_dir),
        },
        connect=lambda *_args, **_kwargs: _ConnectionContext(connection),
        generate=lambda source_path, **kwargs: generated.append(
            (
                Path(source_path),
                Path(kwargs["cache_root"]),
                kwargs.get("revision"),
            )
        ),
        throttle_seconds=0,
    )

    assert worker.run_once() == 1
    assert generated == [
        (source, data_dir / "display-cover-cache", "cover-sha256")
    ]
    assert "metadata ->> 'cover_revision'" in connection.executed[0]


@pytest.mark.parametrize("mode", ["album_folders", "custom"])
def test_backfill_honors_storage_policy_without_revision(tmp_path, mode):
    from music_app.services.cover_preview_backfill import CoverPreviewBackfill
    from music_app.services.generated_preview_storage import preview_storage_policy_from_mapping

    source = tmp_path / "Artist" / "Album" / "cover.jpg"
    data_dir = tmp_path / "app-data"
    connection = _Connection([{"cover_path": str(source), "cover_revision": None}])
    generated = []

    policy = preview_storage_policy_from_mapping({
        "mode": mode, "active_root": str(tmp_path / "ssd"),
    })

    worker = CoverPreviewBackfill(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@example/library",
            "DATA_DIR": str(data_dir),
            "_GENERATED_PREVIEW_STORAGE_POLICY": policy,
        },
        connect=lambda *_args, **_kwargs: _ConnectionContext(connection),
        generate=lambda source_path, **kwargs: generated.append(
            (Path(source_path), Path(kwargs["cache_root"]))
        ),
        throttle_seconds=0,
    )

    assert worker.run_once() == 1
    assert generated == [(source, policy.write_cache_root(source))]


@pytest.mark.parametrize("mode", ["album_folders", "custom"])
def test_repeated_unrevisioned_backfill_records_only_policy_destination(tmp_path, mode):
    from PIL import Image
    from music_app.services.cover_preview_backfill import CoverPreviewBackfill
    from music_app.services.covers import resolve_cover_display_variant
    from music_app.services.generated_preview_storage import (
        preview_storage_policy_from_mapping, record_generated_preview,
    )

    source = tmp_path / "album" / "cover.jpg"
    source.parent.mkdir()
    Image.new("RGB", (600, 600), "red").save(source)
    policy = preview_storage_policy_from_mapping({
        "mode": mode, "active_root": str(tmp_path / "ssd"),
    })
    recorded = []

    class Inventory:
        def record_inventory(self, **row):
            recorded.append(row)

    inventory = Inventory()
    connection = _Connection([{"cover_path": str(source), "cover_revision": None}])
    worker = CoverPreviewBackfill(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@example/library",
            "DATA_DIR": str(tmp_path / "app-data"),
            "_GENERATED_PREVIEW_STORAGE_POLICY": policy,
            "_GENERATED_PREVIEW_INVENTORY_RECORDER": lambda source, preview: record_generated_preview(
                inventory, source, preview,
            ),
        },
        connect=lambda *_args, **_kwargs: _ConnectionContext(connection),
        generate=resolve_cover_display_variant,
        throttle_seconds=0,
    )

    for _ in range(3):
        assert worker.run_once() == 1
    assert len(recorded) == 3
    assert len({row["current_path"] for row in recorded}) == 1
    for row in recorded:
        relocation_target = (
            tmp_path / "ssd" / row["managed_relative_path"]
            if mode == "custom" else Path(row["album_preview_path"])
        )
        assert Path(row["current_path"]) == relocation_target
        assert relocation_target.is_file()
    assert not (tmp_path / "app-data" / "display-cover-cache").exists()


def test_inventory_existing_previews_records_album_folder_bytes(tmp_path):
    from music_app.services.cover_preview_backfill import CoverPreviewBackfill

    source = tmp_path / "Artist" / "Album" / "cover.jpg"
    preview = source.parent / ".album-haven" / "cover_variants" / "aa" / "aabb.webp"
    preview.parent.mkdir(parents=True)
    preview.write_bytes(b"preview")
    connection = _Connection([{"cover_path": str(source), "cover_revision": None}])
    recorded = []
    worker = CoverPreviewBackfill(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@example/library",
            "_GENERATED_PREVIEW_INVENTORY_RECORDER": (
                lambda source_path, preview_path: recorded.append(
                    (Path(source_path), Path(preview_path))
                )
            ),
        },
        connect=lambda *_args, **_kwargs: _ConnectionContext(connection),
        throttle_seconds=0,
    )

    assert worker.inventory_existing_previews() == 1
    assert recorded == [(source, preview)]


def test_inventory_existing_previews_does_not_wait_for_foreground_idle(tmp_path):
    from music_app.services.cover_preview_backfill import CoverPreviewBackfill

    source = tmp_path / "Artist" / "Album" / "cover.jpg"
    preview = source.parent / ".album-haven" / "cover_variants" / "aa" / "aabb.webp"
    preview.parent.mkdir(parents=True)
    preview.write_bytes(b"preview")
    connection = _Connection([{"cover_path": str(source), "cover_revision": None}])
    worker = CoverPreviewBackfill(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@example/library",
            "_GENERATED_PREVIEW_INVENTORY_RECORDER": lambda *_args: None,
        },
        connect=lambda *_args, **_kwargs: _ConnectionContext(connection),
        throttle_seconds=0,
    )
    worker._wait_until_idle = lambda: (_ for _ in ()).throw(
        AssertionError("explicit relocation discovery must not wait for HTTP silence")
    )

    assert worker.inventory_existing_previews() == 1


def test_backfill_writes_to_requested_preview_storage_during_relocation(tmp_path):
    from music_app.services.cover_preview_backfill import CoverPreviewBackfill
    from music_app.services.generated_preview_storage import (
        PreviewStoragePolicy,
        PreviewStorageSnapshot,
    )

    source = tmp_path / "Artist" / "Album" / "cover.jpg"
    custom_root = tmp_path / "Generated Previews"
    connection = _Connection([{"cover_path": str(source)}])
    generated = []
    recorder = object()
    policy = PreviewStoragePolicy(
        PreviewStorageSnapshot(
            mode="album_folders",
            requested_mode="custom",
            requested_root=custom_root,
            operation_state="running",
        )
    )
    worker = CoverPreviewBackfill(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@example/library",
            "_GENERATED_PREVIEW_STORAGE_POLICY": policy,
            "_GENERATED_PREVIEW_INVENTORY_RECORDER": recorder,
        },
        connect=lambda *_args, **_kwargs: _ConnectionContext(connection),
        generate=lambda source_path, **kwargs: generated.append(
            (source_path, kwargs["cache_root"], kwargs["on_published"])
        ),
        throttle_seconds=0,
    )

    assert worker.run_once() == 1
    assert generated == [(source, custom_root / "v1", recorder)]
