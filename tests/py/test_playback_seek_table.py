"""Seek tables: the server's one index of an encoded stream, which every client looks up."""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess

import pytest

from music_app.services.ffmpeg_runtime import resolve_ffmpeg_executable
from music_app.services.mp3_stream_map import read_mp3_stream_map
from music_app.services.playback_encoded import read_flac_layout
from music_app.services.playback_seek_table import (
    FLAC_HEADER_BYTES,
    MP3_PREROLL_FRAMES,
    SeekTable,
    lookup,
    mp3_seek_table,
    read_flac_seek_table,
)


FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "playback-seek-table-v1.json"
NOISE = "anoisesrc=color=pink:amplitude=0.3:duration={seconds}:sample_rate={rate}:seed=7"


@pytest.fixture(scope="module")
def ffmpeg() -> str:
    executable = resolve_ffmpeg_executable() or shutil.which("ffmpeg")
    assert executable, "seek table tests generate audio with ffmpeg"
    return executable


def _generate(ffmpeg: str, path: Path, seconds: int, *encoding: str) -> Path:
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", NOISE.format(seconds=seconds, rate=44_100),
         *encoding, str(path)],
        check=True,
    )
    return path


def test_a_local_mp3_seek_is_the_servers_own_window(ffmpeg, tmp_path):
    source = _generate(ffmpeg, tmp_path / "a.mp3", 20, "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k")
    stream_map = read_mp3_stream_map(source)
    window = stream_map.window(0)
    table = mp3_seek_table(stream_map, window)
    assert table.preroll_frames == MP3_PREROLL_FRAMES * stream_map.samples_per_frame
    received = window.end_byte - window.start_byte
    for target in (0, 1, 4_000, 123_456, window.total_frames // 2, window.total_frames - 1):
        expected = stream_map.window(target)
        local = lookup(table, initial_skip=window.skip_frames, initial_total=window.total_frames,
                       stream_start=0, target=target, received_bytes=received, ended=True)
        # Every frame is in a short track's table, so the window is exactly the server's.
        assert local.byte_offset == expected.start_byte - window.start_byte
        assert local.skip_frames == expected.skip_frames
        assert local.total_frames == expected.total_frames


def test_a_long_tracks_table_stays_small_and_only_adds_preroll(ffmpeg, tmp_path):
    source = _generate(ffmpeg, tmp_path / "long.mp3", 120, "-ac", "1", "-c:a", "libmp3lame", "-b:a", "32k")
    stream_map = read_mp3_stream_map(source)
    window = stream_map.window(0)
    table = mp3_seek_table(stream_map, window)
    assert len(table.offsets) <= 2049
    target = 3_000_000
    local = lookup(table, initial_skip=window.skip_frames, initial_total=window.total_frames,
                   stream_start=0, target=target, received_bytes=10**9, ended=True)
    server = stream_map.window(target)
    # An earlier frame than the server's, so more preroll, but the kept samples are the same ones.
    assert local.byte_offset <= server.start_byte - window.start_byte
    assert local.skip_frames >= server.skip_frames
    assert (local.skip_frames - server.skip_frames) % stream_map.samples_per_frame == 0
    assert local.total_frames == server.total_frames


def test_a_target_whose_bytes_have_not_arrived_has_no_window(ffmpeg, tmp_path):
    source = _generate(ffmpeg, tmp_path / "a.mp3", 20, "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k")
    stream_map = read_mp3_stream_map(source)
    window = stream_map.window(0)
    table = mp3_seek_table(stream_map, window)
    arguments = dict(initial_skip=window.skip_frames, initial_total=window.total_frames, stream_start=0)
    assert lookup(table, **arguments, target=800_000, received_bytes=50_000, ended=False) is None
    assert lookup(table, **arguments, target=800_000, received_bytes=10**9, ended=False) is not None
    assert lookup(table, **arguments, target=window.total_frames, received_bytes=10**9, ended=True) is None


def test_flac_entries_start_real_frames_after_the_streams_header(ffmpeg, tmp_path):
    source = _generate(ffmpeg, tmp_path / "a.flac", 20, "-ac", "2", "-c:a", "flac")
    header, first_audio_byte, end_byte, _rate, total = read_flac_layout(source)
    table = read_flac_seek_table(source, first_audio_byte, end_byte)
    data = source.read_bytes()
    assert table.prefix_bytes == FLAC_HEADER_BYTES == len(header)
    assert table.samples[0] == 0 and table.samples[-1] == total
    for offset in table.offsets[:-1]:
        file_offset = offset - FLAC_HEADER_BYTES + first_audio_byte
        assert data[file_offset] == 0xFF and data[file_offset + 1] in (0xF8, 0xF9)
    assert table.samples == tuple(sorted(table.samples))
    local = lookup(table, initial_skip=0, initial_total=total, stream_start=0, target=300_000,
                   received_bytes=10**9, ended=True)
    assert 0 <= local.skip_frames < 8192


def test_the_shared_client_vectors_are_the_reference_lookups_answers():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for section in (fixture, fixture["flac"]):
        raw = section["table"]
        table = SeekTable(raw["prefixBytes"], raw["prerollFrames"], tuple(raw["offsets"]), tuple(raw["samples"]))
        for case in section["cases"]:
            window = lookup(table, initial_skip=section["initialSkip"], initial_total=section["initialTotal"],
                            stream_start=section["streamStart"], target=case["target"],
                            received_bytes=case["receivedBytes"], ended=case["ended"])
            assert (None if window is None else {
                "prefixBytes": window.prefix_bytes,
                "byteOffset": window.byte_offset,
                "skipFrames": window.skip_frames,
                "totalFrames": window.total_frames,
            }) == case["window"], case
