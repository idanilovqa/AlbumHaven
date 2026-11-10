"""Map decoded MP3 samples to file bytes so clients never decide boundaries."""

from __future__ import annotations

from array import array
from dataclasses import dataclass
import threading
from functools import lru_cache
from pathlib import Path

from music_app.services.mp3_gapless import parse_mp3_frame_header, read_mp3_gapless_info


# Earlier frames rebuild the bit reservoir and the overlap of the first kept frame.
_SEEK_PREROLL_FRAMES = 8
_MAX_TRAILING_JUNK_BYTES = 4096
_TRAILER_MARKERS = (b"TAG", b"APETAGEX", b"LYRICS")

@dataclass(frozen=True, slots=True)
class Mp3ByteWindow:
    start_byte: int
    end_byte: int
    skip_frames: int
    total_frames: int


@dataclass(frozen=True, slots=True, eq=False)
class Mp3StreamMap:
    sample_rate: int
    samples_per_frame: int
    frame_offsets: array
    end_byte: int
    first_sample: int
    end_sample: int

    @property
    def total_frames(self) -> int:
        return self.end_sample - self.first_sample

    def window(self, start_frame: int) -> Mp3ByteWindow:
        """Return the bytes to send and the exact decoder samples to keep."""
        kept_start = self.first_sample + min(start_frame, self.total_frames)
        audio_frame = min(kept_start // self.samples_per_frame, len(self.frame_offsets) - 1)
        first_sent_frame = max(0, audio_frame - _SEEK_PREROLL_FRAMES)
        return Mp3ByteWindow(
            start_byte=self.frame_offsets[first_sent_frame],
            end_byte=self.end_byte,
            skip_frames=kept_start - first_sent_frame * self.samples_per_frame,
            total_frames=self.end_sample - kept_start,
        )


def _audio_start(data: bytes) -> int | None:
    """Skip every leading ID3v2 tag and its zero padding, as FFmpeg does."""
    offset = 0
    while data[offset:offset + 3] == b"ID3":
        header = data[offset:offset + 10]
        if len(header) < 10 or any(value & 128 for value in header[6:10]):
            return None
        offset += 10 + sum(value << shift for value, shift in zip(header[6:10], (21, 14, 7, 0)))
        offset += 10 if header[3] == 4 and header[5] & 16 else 0
        while offset < len(data) and data[offset] == 0:
            offset += 1
    return offset


def _is_metadata_frame(data: bytes, offset: int, version: int) -> bool:
    word = int.from_bytes(data[offset:offset + 4], "big")
    mono = (word >> 6) & 3 == 3
    side_info = (17 if mono else 32) if version == 3 else (9 if mono else 17)
    marker = offset + 4 + (0 if word & (1 << 16) else 2) + side_info
    return (
        data[marker:marker + 4] in (b"Xing", b"Info")
        or data[offset + 36:offset + 40] == b"VBRI"
    )


def read_mp3_stream_map(path: Path) -> Mp3StreamMap | None:
    """Scan every frame; any file that is not plain CBR/VBR Layer III returns None."""
    if path.suffix.lower() != ".mp3":
        return None
    try:
        data = path.read_bytes()
    except OSError:
        return None
    audio_offset = offset = _audio_start(data)
    if offset is None:
        return None
    first = parse_mp3_frame_header(data, offset)
    if first is None:
        return None
    version, sample_rate, _frame_bytes, samples_per_frame = first
    if _is_metadata_frame(data, offset, version):
        offset += first[2]
    frame_offsets = array("Q")
    while True:
        header = parse_mp3_frame_header(data, offset)
        if header is None:
            break
        if header[0] != version or header[1] != sample_rate:
            return None
        if offset + header[2] > len(data):
            break
        frame_offsets.append(offset)
        offset += header[2]
    remaining = len(data) - offset
    if (
        not frame_offsets
        or (remaining > _MAX_TRAILING_JUNK_BYTES
            and not data.startswith(_TRAILER_MARKERS, offset))
    ):
        return None
    encoded_samples = len(frame_offsets) * samples_per_frame
    gapless = read_mp3_gapless_info(path, any_encoder=True, audio_offset=audio_offset)
    first_sample = gapless.first_sample if gapless is not None else 0
    end_sample = min(gapless.end_sample, encoded_samples) if gapless is not None else encoded_samples
    if first_sample >= end_sample:
        return None
    return Mp3StreamMap(
        sample_rate=sample_rate,
        samples_per_frame=samples_per_frame,
        frame_offsets=frame_offsets,
        end_byte=offset,
        first_sample=first_sample,
        end_sample=end_sample,
    )


@lru_cache(maxsize=64)
def _cached_stream_map(path: str, _size: int, _mtime_ns: int) -> Mp3StreamMap | None:
    return read_mp3_stream_map(Path(path))


# One scan per file at a time: a stream open waits for the scan the queue's preparation already
# started (`/playback/refs`) instead of reading the whole file a second time beside it.
_scans: dict[tuple[str, int, int], threading.Lock] = {}
_scans_guard = threading.Lock()


def mp3_stream_map(path: Path) -> Mp3StreamMap | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    key = (str(path), stat.st_size, stat.st_mtime_ns)
    with _scans_guard:
        scan = _scans.setdefault(key, threading.Lock())
    try:
        with scan:
            return _cached_stream_map(*key)
    finally:
        with _scans_guard:
            if _scans.get(key) is scan and not scan.locked():
                del _scans[key]
