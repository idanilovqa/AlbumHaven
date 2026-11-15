"""Seek tables: where in an encoded stream's bytes each position can be decoded from.

The server is the one place that reads a file's frames. It sends a stream's table with the stream,
so every client seeks inside the bytes it already received by looking positions up, with no
second parser on any client and no round trip (the way Spotify seeks inside its download).

A table lists entries of (byte offset, decoder sample): decoding the stream's bytes from that offset
yields decoder output from that sample on, counted from the stream's first decoded sample.
``lookup`` is the reference every client implements; tests/fixtures/playback-seek-table-v1.json
holds vectors from it for the clients' own tests.
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
import re

from music_app.services.mp3_stream_map import Mp3ByteWindow, Mp3StreamMap


# Tables stay small enough to send with every stream from its first frame.
MAX_ENTRIES = 2048
# `_SEEK_PREROLL_FRAMES` of mp3_stream_map: frames decoded before the target to rebuild the bit
# reservoir and the overlap of the first kept frame.
MP3_PREROLL_FRAMES = 8
# `read_flac_layout`'s minimal header: fLaC, the STREAMINFO block header and STREAMINFO.
FLAC_HEADER_BYTES = 42
_FLAC_SYNC = re.compile(rb"\xff[\xf8\xf9]")
_MAX_FLAC_TABLE_FILE_BYTES = 64 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class SeekTable:
    """Byte offsets and decoder samples, ending with the stream's end as a last entry."""

    prefix_bytes: int
    preroll_frames: int
    offsets: tuple[int, ...]
    samples: tuple[int, ...]

    def event(self, *, generation: int, stream_id: int) -> dict[str, object]:
        return {
            "type": "seek-table",
            "generation": generation,
            "streamId": stream_id,
            "prefixBytes": self.prefix_bytes,
            "prerollFrames": self.preroll_frames,
            "offsets": list(self.offsets),
            "samples": list(self.samples),
        }


@dataclass(frozen=True, slots=True)
class LocalWindow:
    prefix_bytes: int
    byte_offset: int
    skip_frames: int
    total_frames: int


def _stride(count: int) -> int:
    return max(1, -(-count // MAX_ENTRIES))


def mp3_seek_table(stream_map: Mp3StreamMap, window: Mp3ByteWindow) -> SeekTable:
    """The table of an MP3 stream sent from ``window``: every stride-th frame from its first."""
    offsets = stream_map.frame_offsets
    first = next(index for index, offset in enumerate(offsets) if offset == window.start_byte)
    frames = range(first, len(offsets), _stride(len(offsets) - first))
    spf = stream_map.samples_per_frame
    return SeekTable(
        prefix_bytes=0,
        preroll_frames=MP3_PREROLL_FRAMES * spf,
        offsets=tuple(offsets[frame] - window.start_byte for frame in frames)
        + (window.end_byte - window.start_byte,),
        samples=tuple((frame - first) * spf for frame in frames) + ((len(offsets) - first) * spf,),
    )


def _crc8(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def _flac_frame_header(data: bytes, offset: int, fixed_block_size: int) -> tuple[int, int] | None:
    """(first sample, block size) of a valid FLAC frame header at ``offset``, or None."""
    if offset + 16 > len(data):
        return None
    variable = data[offset + 1] == 0xF9
    block_code, rate_code = data[offset + 2] >> 4, data[offset + 2] & 0x0F
    third = data[offset + 3]
    if block_code == 0 or rate_code == 15 or third >> 4 > 10 or (third >> 1) & 7 == 3 or third & 1:
        return None
    position = offset + 4
    lead = data[position]
    extra = next((count for count, (mask, value) in enumerate(
        ((0x80, 0x00), (0xE0, 0xC0), (0xF0, 0xE0), (0xF8, 0xF0), (0xFC, 0xF8), (0xFE, 0xFC), (0xFF, 0xFE)),
    ) if lead & mask == value), None)
    if extra is None:
        return None
    number = lead if extra == 0 else lead & (0x3F >> extra)
    position += 1
    for _ in range(extra):
        continuation = data[position]
        if continuation & 0xC0 != 0x80:
            return None
        number = (number << 6) | (continuation & 0x3F)
        position += 1
    if block_code == 1:
        block_size = 192
    elif block_code <= 5:
        block_size = 576 << (block_code - 2)
    elif block_code == 6:
        block_size = data[position] + 1
        position += 1
    elif block_code == 7:
        block_size = int.from_bytes(data[position:position + 2], "big") + 1
        position += 2
    else:
        block_size = 256 << (block_code - 8)
    position += {12: 1, 13: 2, 14: 2}.get(rate_code, 0)
    if _crc8(data[offset:position]) != data[position]:
        return None
    if variable:
        return number, block_size
    return (number * fixed_block_size, block_size) if fixed_block_size else None


def read_flac_seek_table(path: Path, first_audio_byte: int, end_byte: int) -> SeekTable | None:
    """Scans every frame, by sync code, CRC-8 and sample continuity, of a FLAC sent from its start."""
    if end_byte > _MAX_FLAC_TABLE_FILE_BYTES:
        return None
    try:
        data = path.read_bytes()
    except OSError:
        return None
    streaminfo = data[8:8 + 34] if data[:4] == b"fLaC" else b""
    if len(streaminfo) != 34:
        return None
    min_block, max_block = int.from_bytes(streaminfo[0:2], "big"), int.from_bytes(streaminfo[2:4], "big")
    fixed = max_block if min_block == max_block else 0
    total_samples = int.from_bytes(streaminfo[10:18], "big") & ((1 << 36) - 1)
    frames: list[tuple[int, int]] = []
    expected = 0
    search = first_audio_byte
    while (match := _FLAC_SYNC.search(data, search, end_byte)) is not None:
        header = _flac_frame_header(data, match.start(), fixed)
        if header is not None and header[0] == expected:
            frames.append((match.start(), header[0]))
            expected = header[0] + header[1]
            search = match.start() + 10
        else:
            search = match.start() + 1
    if not frames:
        return None
    chosen = frames[::_stride(len(frames))]
    return SeekTable(
        prefix_bytes=FLAC_HEADER_BYTES,
        preroll_frames=0,
        offsets=tuple(FLAC_HEADER_BYTES + offset - first_audio_byte for offset, _ in chosen)
        + (FLAC_HEADER_BYTES + end_byte - first_audio_byte,),
        samples=tuple(sample for _, sample in chosen) + (total_samples or expected,),
    )


@lru_cache(maxsize=64)
def _cached_flac_seek_table(path: str, first_audio_byte: int, end_byte: int, _size: int, _mtime_ns: int):
    return read_flac_seek_table(Path(path), first_audio_byte, end_byte)


def flac_seek_table(path: Path, first_audio_byte: int, end_byte: int) -> SeekTable | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return _cached_flac_seek_table(str(path), first_audio_byte, end_byte, stat.st_size, stat.st_mtime_ns)


def lookup(
    table: SeekTable,
    *,
    initial_skip: int,
    initial_total: int,
    stream_start: int,
    target: int,
    received_bytes: int,
    ended: bool,
) -> LocalWindow | None:
    """The reference client lookup: where to decode ``target`` from the bytes received so far.

    ``initial_skip`` and ``initial_total`` are the stream's metadata (skipFrames and totalFrames),
    ``stream_start`` its requested start frame. A target whose bytes have not all arrived has no
    window: its decoding would wait on the network.
    """
    offset_in_stream = target - stream_start
    if offset_in_stream < 0 or offset_in_stream >= initial_total:
        return None
    kept = initial_skip + offset_in_stream
    entry = max(0, bisect.bisect_right(table.samples, max(0, kept - table.preroll_frames)) - 1)
    after = bisect.bisect_right(table.samples, kept)
    if after >= len(table.samples) or (table.offsets[after] > received_bytes and not ended):
        return None
    return LocalWindow(
        prefix_bytes=table.prefix_bytes,
        byte_offset=table.offsets[entry],
        skip_frames=kept - table.samples[entry],
        total_frames=initial_total - offset_in_stream,
    )
