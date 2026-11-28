"""Map decoded MP3 samples to file bytes so clients never decide boundaries."""

from __future__ import annotations

from array import array
from collections import OrderedDict
from dataclasses import dataclass
import logging
import sys
import threading
from pathlib import Path
import zlib

from music_app.services.mp3_gapless import parse_mp3_frame_header, read_mp3_gapless_info
from music_app.services.postgres_connections import pooled_connection


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


_logger = logging.getLogger(__name__)
# Where scanned maps are kept across restarts (library.mp3_stream_maps, one row per file): the
# database URL and whether this app may write it (a browse-only app only reads).
_store: tuple[str, bool] | None = None


def configure_stream_map_store(config) -> None:
    """Keeps scanned maps in this app's database, so the first play after a restart reads one row
    instead of scanning the whole file."""
    global _store
    database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
    _store = (database_url, config.get("SHARED_LIBRARY_BROWSE_ONLY") is not True) if database_url else None


def _packed_frame_sizes(stream_map: Mp3StreamMap) -> bytes:
    offsets = stream_map.frame_offsets
    sizes = array("I", (offsets[index + 1] - offsets[index] for index in range(len(offsets) - 1)))
    if sys.byteorder != "little":
        sizes.byteswap()
    return zlib.compress(sizes.tobytes(), 6)


def _unpacked_frame_offsets(first_offset: int, packed: bytes) -> array:
    sizes = array("I")
    sizes.frombytes(zlib.decompress(packed))
    if sys.byteorder != "little":
        sizes.byteswap()
    offsets = array("Q", [first_offset])
    for size in sizes:
        offsets.append(offsets[-1] + size)
    return offsets


_MAP_COLUMNS = """sample_rate, samples_per_frame, first_sample, end_sample, end_byte,
                  first_frame_offset, frame_sizes"""


def _row_stream_map(row) -> Mp3StreamMap:
    return Mp3StreamMap(
        sample_rate=row["sample_rate"],
        samples_per_frame=row["samples_per_frame"],
        frame_offsets=_unpacked_frame_offsets(row["first_frame_offset"], bytes(row["frame_sizes"])),
        end_byte=row["end_byte"],
        first_sample=row["first_sample"],
        end_sample=row["end_sample"],
    )


def _stored_stream_maps(keys: list[tuple[str, int, int]]) -> dict[tuple[str, int, int], Mp3StreamMap]:
    """The kept maps of these exact file versions, in one query; none when they cannot be read."""
    if _store is None or not keys:
        return {}
    wanted = set(keys)
    try:
        with pooled_connection(_store[0]) as connection:
            rows = connection.execute(
                f"""select media_path, size_bytes, mtime_ns, {_MAP_COLUMNS}
                    from library.mp3_stream_maps where media_path = any(%s)""",
                ([key[0] for key in keys],),
            ).fetchall()
        return {
            key: _row_stream_map(row)
            for row in rows
            if (key := (row["media_path"], row["size_bytes"], row["mtime_ns"])) in wanted
        }
    except Exception:
        _logger.warning("Kept MP3 frame maps could not be read; the files are scanned instead.", exc_info=True)
        return {}


def _keep_stream_maps(scanned: list[tuple[tuple[str, int, int], Mp3StreamMap]]) -> None:
    """Keeps freshly scanned maps, all in one transaction."""
    if _store is None or not _store[1] or not scanned:
        return
    try:
        with pooled_connection(_store[0]) as connection:
            with connection.cursor() as cursor:
                cursor.executemany(
                    """insert into library.mp3_stream_maps (
                           media_path, size_bytes, mtime_ns, sample_rate, samples_per_frame, first_sample,
                           end_sample, end_byte, first_frame_offset, frame_sizes, updated_at)
                       values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                       on conflict (media_path) do update set
                           size_bytes = excluded.size_bytes, mtime_ns = excluded.mtime_ns,
                           sample_rate = excluded.sample_rate, samples_per_frame = excluded.samples_per_frame,
                           first_sample = excluded.first_sample, end_sample = excluded.end_sample,
                           end_byte = excluded.end_byte, first_frame_offset = excluded.first_frame_offset,
                           frame_sizes = excluded.frame_sizes, updated_at = now()""",
                    [(path, size, mtime_ns, stream_map.sample_rate, stream_map.samples_per_frame,
                      stream_map.first_sample, stream_map.end_sample, stream_map.end_byte,
                      stream_map.frame_offsets[0], _packed_frame_sizes(stream_map))
                     for (path, size, mtime_ns), stream_map in scanned],
                )
    except Exception:
        _logger.warning("MP3 frame maps could not be kept; they are scanned again after a restart.", exc_info=True)


# The most recently used maps in memory, keyed by (path, size, modified time).
_MEMORY_SIZE = 64
_memory: OrderedDict[tuple[str, int, int], Mp3StreamMap | None] = OrderedDict()
_memory_guard = threading.Lock()


def _remembered(key) -> tuple[bool, Mp3StreamMap | None]:
    with _memory_guard:
        if key not in _memory:
            return False, None
        _memory.move_to_end(key)
        return True, _memory[key]


def _remember(key, stream_map: Mp3StreamMap | None) -> None:
    with _memory_guard:
        _memory[key] = stream_map
        _memory.move_to_end(key)
        while len(_memory) > _MEMORY_SIZE:
            _memory.popitem(last=False)


def forget_stream_maps() -> None:
    """Drops the maps held in memory (tests, and nothing else)."""
    with _memory_guard:
        _memory.clear()


def _cached_stream_map(path: str, size: int, mtime_ns: int) -> Mp3StreamMap | None:
    key = (path, size, mtime_ns)
    known, stream_map = _remembered(key)
    if known:
        return stream_map
    stream_map = _stored_stream_maps([key]).get(key)
    if stream_map is None:
        stream_map = read_mp3_stream_map(Path(path))
        if stream_map is not None:
            _keep_stream_maps([(key, stream_map)])
    _remember(key, stream_map)
    return stream_map


# One scan per file at a time: a stream open waits for the scan the queue's preparation already
# started (`/playback/refs`) instead of reading the whole file a second time beside it.
_scans: dict[tuple[str, int, int], threading.Lock] = {}
_scans_guard = threading.Lock()


def mp3_stream_map(path: Path) -> Mp3StreamMap | None:
    key = _stat_key(path)
    if key is None:
        return None
    with _scans_guard:
        scan = _scans.setdefault(key, threading.Lock())
    try:
        with scan:
            return _cached_stream_map(*key)
    finally:
        with _scans_guard:
            if _scans.get(key) is scan and not scan.locked():
                del _scans[key]


def _stat_key(path: Path) -> tuple[str, int, int] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return (str(path), stat.st_size, stat.st_mtime_ns)


def prepare_mp3_stream_maps(paths: list[Path]) -> None:
    """Readies the maps of a queue's files: the kept ones in one query, the rest scanned one file
    at a time (each beside any stream open of it) and kept in one transaction."""
    keys = [key for key in map(_stat_key, paths) if key is not None]
    missing = [key for key in keys if not _remembered(key)[0]]
    for key, stream_map in _stored_stream_maps(missing).items():
        _remember(key, stream_map)
    scanned = []
    for key in missing:
        with _scans_guard:
            scan = _scans.setdefault(key, threading.Lock())
        try:
            with scan:
                if _remembered(key)[0]:
                    continue
                stream_map = read_mp3_stream_map(Path(key[0]))
                _remember(key, stream_map)
                if stream_map is not None:
                    scanned.append((key, stream_map))
        finally:
            with _scans_guard:
                if _scans.get(key) is scan and not scan.locked():
                    del _scans[key]
    _keep_stream_maps(scanned)
