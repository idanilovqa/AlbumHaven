"""Honor validated LAME sample boundaries when the decoder ignores tag casing."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass
import math
from pathlib import Path
import shutil

from music_app.services.ffmpeg_runtime import hidden_subprocess_creation_flags


@dataclass(frozen=True, slots=True)
class Mp3GaplessInfo:
    sample_rate: int
    encoded_frames: int
    encoder_delay: int
    end_padding: int

    @property
    def first_sample(self) -> int:
        return self.encoder_delay + 529

    @property
    def end_sample(self) -> int:
        return self.encoded_frames - max(0, self.end_padding - 529)

    @property
    def duration_seconds(self) -> float:
        return (self.end_sample - self.first_sample) / self.sample_rate

    def decode_filters(self, sample_rate: int, start_frame: int = 0) -> tuple[int, str]:
        # Whole seconds preserve the resampling phase across a bounded seek preroll.
        coarse_seconds = math.floor(max(0, start_frame / sample_rate - .25))
        end = max(self.first_sample, self.end_sample - coarse_seconds * self.sample_rate)
        filters = (
            f"atrim=start_sample={self.first_sample}:end_sample={end},"
            f"asetpts=PTS-STARTPTS,aresample={sample_rate},"
            f"atrim=start_sample={start_frame - coarse_seconds * sample_rate},"
            "asetpts=PTS-STARTPTS"
        )
        return coarse_seconds, filters


def read_mp3_gapless_info(path: Path) -> Mp3GaplessInfo | None:
    """Read one MPEG header frame, never audio samples or an entire ID3 payload."""
    if path.suffix.lower() != ".mp3":
        return None
    try:
        with path.open("rb") as source:
            size = source.seek(0, 2)
            source.seek(0)
            header = source.read(10)
            offset = 0
            if header[:3] == b"ID3":
                if len(header) != 10 or any(value & 128 for value in header[6:10]):
                    return None
                offset = 10 + sum(value << shift for value, shift in zip(header[6:10], (21, 14, 7, 0)))
                if header[3] == 4 and header[5] & 16:
                    offset += 10
            if offset + 4 > size:
                return None
            source.seek(offset)
            frame = source.read(4096)
    except OSError:
        return None
    word = int.from_bytes(frame[:4], "big")
    version, layer = (word >> 19) & 3, (word >> 17) & 3
    bitrate_index, rate_index = (word >> 12) & 15, (word >> 10) & 3
    if word >> 21 != 0x7ff or version == 1 or layer != 1 or bitrate_index in (0, 15) or rate_index == 3:
        return None
    rate = (44100, 48000, 32000)[rate_index] // (1 if version == 3 else 2 if version == 2 else 4)
    rates = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320) if version == 3 else (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)
    frame_size = (144 if version == 3 else 72) * rates[bitrate_index] * 1000 // rate + ((word >> 9) & 1)
    mono = (word >> 6) & 3 == 3
    marker = 4 + (0 if word & (1 << 16) else 2) + ((17 if mono else 32) if version == 3 else (9 if mono else 17))
    if frame_size > len(frame) or frame[marker:marker + 4] not in (b"Xing", b"Info"):
        return None
    flags = int.from_bytes(frame[marker + 4:marker + 8], "big")
    if flags & ~15 or not flags & 1:
        return None
    count = int.from_bytes(frame[marker + 8:marker + 12], "big")
    tag = marker + 8 + sum(length for bit, length in ((1, 4), (2, 4), (4, 100), (8, 4)) if flags & bit)
    if tag + 36 > frame_size or frame[tag:tag + 4].lower() != b"lame" or frame[tag:tag + 4] == b"LAME":
        return None
    if not count or count > (size - offset) // 24:
        return None
    if flags & 2:
        declared_bytes = int.from_bytes(frame[marker + 12:marker + 16], "big")
        if declared_bytes < frame_size or declared_bytes > size - offset:
            return None
    packed = int.from_bytes(frame[tag + 21:tag + 24], "big")
    info = Mp3GaplessInfo(rate, count * (1152 if version == 3 else 576), packed >> 12, packed & 4095)
    # FFmpeg accepts tag CRC mismatches too; bounds, not CRC or silence, define safety.
    return info if info.first_sample < info.end_sample else None


_probe_cache: OrderedDict[tuple, Mp3GaplessInfo | None] = OrderedDict()


def _probe_identity(path: Path, executable: str) -> tuple | None:
    decoder = shutil.which(executable)
    if decoder is None:
        return None
    try:
        identities = []
        for candidate in (path, Path(decoder)):
            resolved = candidate.resolve(strict=True)
            stat = resolved.stat()
            identities.append((str(resolved), stat.st_dev, stat.st_ino, stat.st_size,
                               stat.st_mtime_ns, stat.st_ctime_ns))
        return tuple(identities)
    except OSError:
        return None


async def ignored_mp3_gapless_info(
    path: Path, executable: str, *, cancel_event: asyncio.Event | None = None,
) -> Mp3GaplessInfo | None:
    if cancel_event is not None and cancel_event.is_set():
        raise asyncio.CancelledError
    if path.suffix.lower() != ".mp3":
        return None
    identity = await asyncio.to_thread(_probe_identity, path, executable)
    if cancel_event is not None and cancel_event.is_set():
        raise asyncio.CancelledError
    if identity is not None and identity in _probe_cache:
        _probe_cache.move_to_end(identity)
        return _probe_cache[identity]
    info = await asyncio.to_thread(read_mp3_gapless_info, path)
    if info is None:
        return None
    process = await asyncio.create_subprocess_exec(
        executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(path),
        "-map", "0:a:0", "-c:a", "copy", "-frames:a", "1", "-f", "framecrc", "pipe:1",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        stdin=asyncio.subprocess.DEVNULL, creationflags=hidden_subprocess_creation_flags(),
    )
    async def collect():
        try:
            await process.stdout.readexactly(8193)
        except asyncio.IncompleteReadError as error:
            output = error.partial
        else:
            raise RuntimeError("MP3 boundary probe exceeded its output limit")
        if await process.wait() != 0 or b"#codec_id 0: mp3" not in output:
            raise RuntimeError("MP3 boundary probe failed")
        return output
    collector = asyncio.create_task(collect())
    cancellation = asyncio.create_task(cancel_event.wait()) if cancel_event is not None else None
    tasks = {collector, cancellation} if cancellation is not None else {collector}
    try:
        completed, _ = await asyncio.wait(tasks, timeout=5, return_when=asyncio.FIRST_COMPLETED)
        if cancellation is not None and cancellation in completed:
            raise asyncio.CancelledError
        if collector not in completed:
            raise TimeoutError("MP3 boundary probe timed out")
        output = await collector
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.wait()
        await asyncio.gather(*tasks, return_exceptions=True)
    result = None if b"Skip Samples" in output else info
    current_identity = await asyncio.to_thread(_probe_identity, path, executable) if identity is not None else None
    if cancel_event is not None and cancel_event.is_set():
        raise asyncio.CancelledError
    if identity is not None and identity == current_identity:
        _probe_cache[identity] = result
        _probe_cache.move_to_end(identity)
        while len(_probe_cache) > 128:
            _probe_cache.popitem(last=False)
    return result
