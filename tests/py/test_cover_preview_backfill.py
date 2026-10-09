from __future__ import annotations

from pathlib import Path
import threading
import time


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
