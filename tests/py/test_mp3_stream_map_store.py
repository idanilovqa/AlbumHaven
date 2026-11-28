"""MP3 frame maps kept in Postgres: the first play after a restart reads one row, not the whole file."""

from __future__ import annotations

from array import array
from pathlib import Path

import pytest

from music_app.services import mp3_stream_map as stream_maps
from music_app.services.mp3_stream_map import Mp3StreamMap, configure_stream_map_store
from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import _dedicated_database_urls_or_skip, _drop_application_schemas


def _map(frames: int = 1500, frame_bytes: int = 417) -> Mp3StreamMap:
    # A VBR-like run of frame sizes, starting after a 2 KiB tag.
    offsets = array("Q", [2048])
    for index in range(frames - 1):
        offsets.append(offsets[-1] + frame_bytes + index % 7)
    return Mp3StreamMap(sample_rate=44100, samples_per_frame=1152, frame_offsets=offsets,
                        end_byte=offsets[-1] + frame_bytes, first_sample=1105,
                        end_sample=frames * 1152 - 600)


@pytest.fixture(autouse=True)
def _fresh_cache():
    stream_maps.forget_stream_maps()
    yield
    stream_maps.forget_stream_maps()
    configure_stream_map_store({})


def test_frame_sizes_pack_small_and_unpack_to_the_same_offsets():
    kept = _map()
    packed = stream_maps._packed_frame_sizes(kept)
    assert len(packed) < len(kept.frame_offsets) * 2, "compressed below 2 bytes a frame"
    assert stream_maps._unpacked_frame_offsets(kept.frame_offsets[0], packed) == kept.frame_offsets


def test_a_kept_map_is_used_without_scanning_and_a_scan_is_kept(monkeypatch):
    kept, scanned, written = _map(), _map(frames=10), []
    monkeypatch.setattr(stream_maps, "_stored_stream_maps", lambda keys: {key: kept for key in keys if key[1] == 1})
    monkeypatch.setattr(stream_maps, "_keep_stream_maps", lambda scanned: written.extend(scanned))
    monkeypatch.setattr(stream_maps, "read_mp3_stream_map", lambda _path: scanned)

    assert stream_maps._cached_stream_map("song.mp3", 1, 10) is kept
    assert written == [], "a kept map is not written again"
    assert stream_maps._cached_stream_map("song.mp3", 2, 10) is scanned
    assert written == [(("song.mp3", 2, 10), scanned)]


def test_without_a_store_or_with_a_failing_one_the_file_is_scanned(monkeypatch):
    scanned = _map(frames=10)
    monkeypatch.setattr(stream_maps, "read_mp3_stream_map", lambda _path: scanned)
    configure_stream_map_store({})
    assert stream_maps._cached_stream_map("song.mp3", 1, 10) is scanned

    def unavailable(*_args, **_kwargs):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(stream_maps, "pooled_connection", unavailable)
    configure_stream_map_store({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"})
    stream_maps.forget_stream_maps()
    assert stream_maps._cached_stream_map("song.mp3", 1, 10) is scanned


def test_preparing_a_queue_reads_kept_maps_in_one_query_and_keeps_scans_in_one_write(monkeypatch, tmp_path):
    paths = []
    for name in ("a", "b", "c"):
        path = tmp_path / f"{name}.mp3"
        path.write_bytes(name.encode() * 100)
        paths.append(path)
    kept_key = (str(paths[0]), paths[0].stat().st_size, paths[0].stat().st_mtime_ns)
    reads, writes, scans = [], [], []
    monkeypatch.setattr(stream_maps, "_stored_stream_maps",
                        lambda keys: reads.append(list(keys)) or {kept_key: _map()} if kept_key in keys else reads.append(list(keys)) or {})
    monkeypatch.setattr(stream_maps, "_keep_stream_maps", lambda scanned: writes.append([key for key, _map_ in scanned]))
    monkeypatch.setattr(stream_maps, "read_mp3_stream_map", lambda path: scans.append(path.name) or _map(frames=10))

    stream_maps.prepare_mp3_stream_maps(paths)

    assert len(reads) == 1 and len(reads[0]) == 3, "one query for the whole queue"
    assert scans == ["b.mp3", "c.mp3"], "only the files with no kept map are scanned"
    assert len(writes) == 1 and len(writes[0]) == 2, "and kept in one write"
    stream_maps.prepare_mp3_stream_maps(paths)
    assert len(reads) == 2 and reads[1] == [], "maps already in memory are not asked for again"


def test_a_browse_only_app_reads_kept_maps_but_never_writes_them(monkeypatch):
    calls = []
    monkeypatch.setattr(stream_maps, "pooled_connection", lambda *args, **kwargs: calls.append(args))
    configure_stream_map_store({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused",
                                "SHARED_LIBRARY_BROWSE_ONLY": True})
    stream_maps._keep_stream_maps([(("song.mp3", 1, 10), _map(frames=10))])
    assert calls == []


@pytest.fixture
def stream_map_database(monkeypatch):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    _drop_application_schemas(setup_url)
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    try:
        yield runtime_url
    finally:
        isolatedPostgres.reset_application_tables(setup_url)


def test_postgres_keeps_one_row_per_file_version_and_a_restart_reads_it(stream_map_database, monkeypatch):
    configure_stream_map_store({"ALBUM_HAVEN_APP_DATABASE_URL": stream_map_database})
    kept = _map()
    monkeypatch.setattr(stream_maps, "read_mp3_stream_map", lambda _path: kept)
    assert stream_maps._cached_stream_map("C:/Music/a.mp3", 900_000, 123) is kept

    # A restart: nothing in memory, and the file is never read again for the same version.
    stream_maps.forget_stream_maps()
    monkeypatch.setattr(stream_maps, "read_mp3_stream_map", lambda _path: pytest.fail("scanned again"))
    restored = stream_maps._cached_stream_map("C:/Music/a.mp3", 900_000, 123)
    assert restored.frame_offsets == kept.frame_offsets
    assert (restored.end_byte, restored.first_sample, restored.end_sample) == (kept.end_byte, kept.first_sample, kept.end_sample)

    # A changed file is scanned again and replaces its row.
    stream_maps.forget_stream_maps()
    changed = _map(frames=20)
    monkeypatch.setattr(stream_maps, "read_mp3_stream_map", lambda _path: changed)
    assert stream_maps._cached_stream_map("C:/Music/a.mp3", 950_000, 456) is changed
    with isolatedPostgres._connect(stream_map_database) as connection:
        rows = connection.execute("select size_bytes, mtime_ns from library.mp3_stream_maps").fetchall()
    assert [(row["size_bytes"], row["mtime_ns"]) for row in rows] == [(950_000, 456)]
