from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import dataclass, field
import logging
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import TYPE_CHECKING, Awaitable, Callable

from music_app.services.ffmpeg_runtime import resolve_ffmpeg_executable

if TYPE_CHECKING:
    from music_app.services.mp3_gapless import Mp3GaplessInfo


PCM_READ_CHUNK_BYTES = 64 * 1024
MAX_STDERR_DIAGNOSTIC_BYTES = 64 * 1024
MAX_AGGREGATE_OUTPUT_BYTES_PER_BIN = 160
WAVEFORM_ANALYSIS_SAMPLE_RATE = 8_000
WAVEFORM_ANALYZER_VERSION = "waveform-peaks-v3"
# The playing song's waveform decodes as parallel time segments, each covering at least
# this much audio, because the decode itself is the cost of a build.
CURRENT_SONG_SEGMENT_SECONDS = 30.0
CURRENT_SONG_MAX_SEGMENTS = 4
# Distinct playing songs (one per listening device) that may build at the same time.
CURRENT_SONG_MAX_BUILDS = 2
# A seek or reload drops the playing song's request and asks again once playback has
# buffered, so its build keeps going this long for that request to rejoin.
CURRENT_SONG_REJOIN_SECONDS = 5.0
SEGMENT_SEEK_PREROLL_SECONDS = 0.25
# Started decoders kept waiting for playing songs, and the 50 ms chunks they measure.
WARM_DECODERS = 2
WARM_DECODER_CHUNK_FRAMES = 400
# Ceiling on one decoder's output before its duration is known (about 8 hours of audio).
WARM_DECODER_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024
# How often a building waveform is shown so far.
PROGRESS_INTERVAL_SECONDS = 0.1
_EXACT_SEEK_SUFFIXES = frozenset({".wav", ".wave", ".flac", ".aif", ".aiff"})
_CHUNK_PEAK_PATTERN = re.compile(rb"lavfi\.astats\.([12])\.Peak_level=([^\r\n]+)")
_PEAK_LEVEL_PATTERN = re.compile(
    rb"^lavfi\.astats\.(?P<channel>[12])\.Peak_level=(?P<decibels>[^\r\n]+)$"
)
_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class WaveformPeaks:
    left: tuple[float, ...]
    right: tuple[float, ...]
    sample_count: int


class WaveformPeaksBusyError(RuntimeError):
    pass


@dataclass(slots=True)
class _PeakBin:
    left: float
    right: float
    frames: int


def _finite_peak(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return min(1.0, abs(value))


def _audio_duration_seconds(path: Path) -> float:
    from music_app.services.mp3_gapless import read_mp3_gapless_info

    gapless = read_mp3_gapless_info(path)
    if gapless is not None:
        return gapless.duration_seconds
    try:
        from mutagen import File as MutagenFile
    except ImportError as error:  # pragma: no cover - runtime dependency diagnostic.
        raise RuntimeError("mutagen is required for waveform duration probing") from error
    try:
        audio = MutagenFile(path)
    except Exception as error:
        raise RuntimeError("audio duration is unavailable for waveform analysis") from error
    duration = float(getattr(getattr(audio, "info", None), "length", 0.0) or 0.0)
    if not math.isfinite(duration) or duration <= 0:
        raise RuntimeError("audio duration is unavailable for waveform analysis")
    return duration


def _peak_from_decibels(value: bytes) -> float:
    try:
        decibels = float(value.decode("ascii"))
    except (UnicodeDecodeError, ValueError):
        return 0.0
    if not math.isfinite(decibels):
        return 0.0
    return _finite_peak(10 ** (decibels / 20.0))


def _parse_aggregate_records(payload: bytes, *, bins: int) -> list[_PeakBin]:
    peak_bins: list[_PeakBin] = []
    active: dict[int, float] = {}
    saw_frame = False

    def append_active() -> None:
        if not active:
            return
        if set(active) != {1, 2}:
            raise RuntimeError("ffmpeg returned malformed stereo waveform metadata frame")
        peak_bins.append(_PeakBin(active[1], active[2], 1))

    for raw_line in payload.splitlines():
        line = raw_line.strip()
        if line.startswith(b"frame:"):
            saw_frame = True
            append_active()
            active = {}
            continue
        match = _PEAK_LEVEL_PATTERN.match(line)
        if match:
            active[int(match.group("channel"))] = _peak_from_decibels(
                match.group("decibels")
            )
    append_active()
    if not peak_bins:
        if payload and not saw_frame:
            raise RuntimeError("ffmpeg returned truncated waveform metadata frame")
        raise RuntimeError("ffmpeg returned empty waveform aggregate output")
    if len(peak_bins) < bins:
        raise RuntimeError("ffmpeg returned too few waveform metadata frames")
    return peak_bins


def _expand_peak_bins(
    peak_bins: list[_PeakBin],
    *,
    bins: int,
) -> tuple[tuple[float, ...], tuple[float, ...]]:
    source_count = len(peak_bins)
    if source_count == bins:
        return (
            tuple(peak.left for peak in peak_bins),
            tuple(peak.right for peak in peak_bins),
        )
    left: list[float] = []
    right: list[float] = []
    for index in range(bins):
        start = index * source_count // bins
        end = max(start + 1, (index + 1) * source_count // bins)
        window = peak_bins[start:end]
        left.append(max(peak.left for peak in window))
        right.append(max(peak.right for peak in window))
    return tuple(left), tuple(right)


async def _read_stream_tail(
    stream: object | None,
    *,
    limit: int = MAX_STDERR_DIAGNOSTIC_BYTES,
) -> bytes:
    if stream is None:
        return b""
    tail = bytearray()
    while True:
        chunk = await stream.read(PCM_READ_CHUNK_BYTES)  # type: ignore[attr-defined]
        if not chunk:
            return bytes(tail)
        tail.extend(chunk)
        if len(tail) > limit:
            del tail[:-limit]


async def _discard_stream(stream: object | None) -> None:
    if stream is None:
        return
    while await stream.read(PCM_READ_CHUNK_BYTES):  # type: ignore[attr-defined]
        pass


async def _terminate_and_wait(process: asyncio.subprocess.Process) -> int:
    if process.returncode is None:
        with suppress(ProcessLookupError):
            process.terminate()
    return await process.wait()


async def _stop_and_drain_process(
    process: asyncio.subprocess.Process,
    *,
    stdout: object | None,
    stderr_task: asyncio.Task[bytes],
) -> None:
    stdout_discard_task = asyncio.create_task(_discard_stream(stdout))
    try:
        await _terminate_and_wait(process)
    finally:
        await asyncio.gather(stdout_discard_task, stderr_task)


async def _finish_process_cleanup(
    process: asyncio.subprocess.Process,
    *,
    stdout: object | None,
    stderr_task: asyncio.Task[bytes],
) -> None:
    cleanup_task = asyncio.create_task(
        _stop_and_drain_process(
            process,
            stdout=stdout,
            stderr_task=stderr_task,
        )
    )
    while not cleanup_task.done():
        try:
            await asyncio.shield(cleanup_task)
        except asyncio.CancelledError:
            # Cleanup belongs to the decoder task and must survive repeated caller
            # cancellation. The original exception is re-raised by the caller.
            continue
        except BaseException:
            break
    with suppress(BaseException):
        await cleanup_task


async def _cancel_active_read(read_task: asyncio.Task[bytes] | None) -> None:
    if read_task is None or read_task.done():
        return
    read_task.cancel()
    while not read_task.done():
        try:
            await asyncio.shield(read_task)
        except asyncio.CancelledError:
            continue
        except BaseException:
            break
    with suppress(BaseException):
        await read_task


async def _stop_feed(feed_task: asyncio.Future[None] | None) -> None:
    if feed_task is None or feed_task.done():
        return
    feed_task.cancel()
    with suppress(BaseException):
        await feed_task


async def _name_input(process: asyncio.subprocess.Process, path: Path) -> None:
    """Tell a waiting decoder which file to read; it reads the file itself."""
    stdin = process.stdin
    assert stdin is not None
    quoted = path.as_posix().replace("'", "'\\''")
    try:
        stdin.write(f"ffconcat version 1.0\nfile '{quoted}'\n".encode("utf-8"))
        await stdin.drain()
    finally:
        # End of input lets the decoder start; a stopped decoder may already be gone.
        with suppress(OSError):
            stdin.close()


def _warm_decoder_command(executable: str) -> list[str]:
    return [
        executable,
        "-v",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        "pipe:0",
        "-af",
        f"aresample={WAVEFORM_ANALYSIS_SAMPLE_RATE},"
        "aformat=channel_layouts=stereo,"
        f"asetnsamples=n={WARM_DECODER_CHUNK_FRAMES}:p=1,"
        "astats=metadata=1:reset=1:measure_perchannel=Peak_level:measure_overall=none,"
        "ametadata=print:file=-",
        "-f",
        "null",
        "-",
    ]


class WaveformDecoderPool:
    """Idle analysis decoders waiting on stdin for the next playing song's file name.

    Starting ffmpeg takes up to seconds on a saturated host, so the playing song's build
    takes a decoder that already started, and a replacement starts in the background.
    """

    def __init__(self, *, size: int = WARM_DECODERS) -> None:
        self._size = size
        self._idle: list[asyncio.subprocess.Process] = []
        self._filling: asyncio.Task[None] | None = None
        self._closed = False

    def take(self) -> asyncio.subprocess.Process | None:
        # Refilling waits for fill(): a decoder starting now would compete with this build.
        while self._idle:
            decoder = self._idle.pop()
            if decoder.returncode is None:
                return decoder
        return None

    def fill(self) -> None:
        if self._closed or (self._filling is not None and not self._filling.done()):
            return
        self._filling = asyncio.create_task(self._fill())

    async def _fill(self) -> None:
        while not self._closed and len(self._idle) < self._size:
            executable = resolve_ffmpeg_executable()
            if not executable:
                return
            try:
                decoder = await _launch_decoder(
                    _warm_decoder_command(executable),
                    current=True,
                    stdin=asyncio.subprocess.PIPE,
                )
            except Exception as error:
                _LOGGER.warning("Waveform decoder start failed: %s", error)
                return
            if self._closed:
                await _discard_decoder(decoder)
                return
            self._idle.append(decoder)

    async def close(self) -> None:
        self._closed = True
        if self._filling is not None:
            with suppress(BaseException):
                await self._filling
        idle, self._idle = self._idle, []
        await asyncio.gather(*(_discard_decoder(decoder) for decoder in idle))


async def _discard_decoder(decoder: asyncio.subprocess.Process) -> None:
    if decoder.stdin is not None:
        with suppress(OSError):
            decoder.stdin.close()
    await _finish_process_cleanup(
        decoder,
        stdout=decoder.stdout,
        stderr_task=asyncio.create_task(_read_stream_tail(decoder.stderr)),
    )


class _ChunkPeakBins:
    """Fold fixed-size analysis chunks into waveform bins as decoder output arrives."""

    def __init__(self, *, bins: int, duration_seconds: float) -> None:
        self.bins = bins
        self.frames_per_bin = max(
            1, math.ceil(duration_seconds * WAVEFORM_ANALYSIS_SAMPLE_RATE / bins)
        )
        self.peak_bins = [_PeakBin(0.0, 0.0, 0) for _ in range(bins)]
        # Twice the probed length is a corrupt or mislabelled file, not a long song.
        self.chunk_limit = 2 * math.ceil(
            duration_seconds * WAVEFORM_ANALYSIS_SAMPLE_RATE / WARM_DECODER_CHUNK_FRAMES
        ) + bins
        self.chunks = 0
        self._pending = b""
        self._left: float | None = None

    def feed(self, output: bytes) -> None:
        complete, newline, self._pending = (self._pending + output).rpartition(b"\n")
        if not newline:
            self._pending = complete + self._pending
            return
        for channel, decibels in _CHUNK_PEAK_PATTERN.findall(complete):
            peak = _peak_from_decibels(decibels)
            if channel == b"1":
                self._left = peak
                continue
            if self._left is None:
                raise RuntimeError("ffmpeg returned malformed stereo waveform metadata frame")
            self._add(self._left, peak)
            self._left = None

    def _add(self, left: float, right: float) -> None:
        # A chunk counts toward the bin holding its midpoint, or toward every bin it covers
        # when bins are shorter than a chunk, so none stays empty. Audio past the probed
        # duration adds bins that the final expansion folds in.
        start = self.chunks * WARM_DECODER_CHUNK_FRAMES
        self.chunks += 1
        if self.frames_per_bin < WARM_DECODER_CHUNK_FRAMES:
            first = start // self.frames_per_bin
            last = (start + WARM_DECODER_CHUNK_FRAMES - 1) // self.frames_per_bin
        else:
            first = last = (start + WARM_DECODER_CHUNK_FRAMES // 2) // self.frames_per_bin
        while len(self.peak_bins) <= last:
            self.peak_bins.append(_PeakBin(0.0, 0.0, 0))
        for peak in self.peak_bins[first:last + 1]:
            peak.left = max(peak.left, left)
            peak.right = max(peak.right, right)

    def peaks(self) -> WaveformPeaks:
        left, right = _expand_peak_bins(self.peak_bins, bins=self.bins)
        return WaveformPeaks(left=left, right=right, sample_count=self.bins)


async def _build_with_warm_decoder(
    decoder: asyncio.subprocess.Process,
    path: Path,
    *,
    bins: int,
    cancel_event: asyncio.Event,
    progress: Callable[[WaveformPeaks], None] | None,
) -> WaveformPeaks:
    # The decoder starts on the file at once and its output is kept until the duration,
    # read meanwhile, says how chunks fold into bins.
    naming = asyncio.ensure_future(_name_input(decoder, path))
    duration = asyncio.ensure_future(asyncio.to_thread(_audio_duration_seconds, path))
    early_output: list[bytes] = []
    folded: _ChunkPeakBins | None = None
    published_at = 0.0

    def fold(output: bytes) -> None:
        nonlocal folded, published_at
        if folded is None:
            if not duration.done():
                early_output.append(output)
                return
            folded = _ChunkPeakBins(bins=bins, duration_seconds=duration.result())
            output = b"".join(early_output) + output
            early_output.clear()
        folded.feed(output)
        if folded.chunks > folded.chunk_limit:
            raise RuntimeError("ffmpeg waveform aggregate output exceeded its bound")
        now = time.monotonic()
        if progress is not None and folded.chunks and now - published_at >= PROGRESS_INTERVAL_SECONDS:
            published_at = now
            progress(folded.peaks())

    try:
        await _collect_aggregate_output(
            decoder,
            cancel_event=cancel_event,
            limit=WARM_DECODER_OUTPUT_LIMIT_BYTES,
            feed=naming,
            on_output=fold,
        )
        await duration
        fold(b"\n")
    finally:
        if not duration.done():
            with suppress(BaseException):
                await duration
    assert folded is not None
    if not folded.chunks:
        raise RuntimeError("ffmpeg returned empty waveform aggregate output")
    return folded.peaks()


def _segment_count(duration_seconds: float, *, bins: int, current: bool) -> int:
    if not current:
        return 1
    return max(
        1,
        min(
            CURRENT_SONG_MAX_SEGMENTS,
            os.cpu_count() or 1,
            bins,
            math.ceil(duration_seconds / CURRENT_SONG_SEGMENT_SECONDS),
        ),
    )


def _segment_decode_options(
    path: Path,
    *,
    gapless: Mp3GaplessInfo | None,
    start_frame: int,
    end_frame: int | None,
) -> tuple[tuple[str, ...], str]:
    """Return input options and leading filters that decode exactly one segment.

    Frames count at the analysis rate; `end_frame` is None for the last segment.
    """
    start_seconds = start_frame / WAVEFORM_ANALYSIS_SAMPLE_RATE
    if gapless is not None:
        coarse_seconds, filters = gapless.decode_filters(
            round(start_seconds * gapless.sample_rate)
        )
        seek_seconds = float(coarse_seconds)
        input_options: tuple[str, ...] = ("-ss", str(coarse_seconds)) if coarse_seconds else ()
        filters = f"{filters},"
    else:
        # Same policy as playback seeks: encoded formats seek early, then trim exactly.
        preroll = (
            0.0
            if path.suffix.lower() in _EXACT_SEEK_SUFFIXES
            else SEGMENT_SEEK_PREROLL_SECONDS
        )
        seek_seconds = max(0.0, start_seconds - preroll)
        trim_seconds = start_seconds - seek_seconds
        input_options = ("-ss", f"{seek_seconds:.9f}") if seek_seconds else ()
        filters = (
            f"atrim=start={trim_seconds:.9f},asetpts=PTS-STARTPTS," if trim_seconds else ""
        )
    if end_frame is not None:
        # Stop decoding shortly past an interior boundary instead of at the end of the file.
        end_seconds = end_frame / WAVEFORM_ANALYSIS_SAMPLE_RATE
        input_options = (*input_options, "-t", f"{end_seconds - seek_seconds + 1:.9f}")
    return input_options, filters


async def _build_segment_peak_bins(
    executable: str,
    path: Path,
    *,
    input_options: tuple[str, ...],
    source_filters: str,
    frames_per_bin: int,
    segment_bins: int,
    last: bool,
    current: bool,
    cancel_event: asyncio.Event,
) -> list[_PeakBin]:
    segment_frames = frames_per_bin * segment_bins
    # Interior segments end at their exact boundary; the last one keeps any audio past
    # the probed duration, which the final bin expansion folds in.
    length_filter = f"apad=whole_len={segment_frames},"
    if not last:
        length_filter += f"atrim=end_sample={segment_frames},"
    aggregate_filter = (
        f"{source_filters}aresample={WAVEFORM_ANALYSIS_SAMPLE_RATE},"
        "aformat=channel_layouts=stereo,"
        f"{length_filter}"
        f"asetnsamples=n={frames_per_bin}:p=1,"
        "astats=metadata=1:reset=1:measure_perchannel=Peak_level:measure_overall=none,"
        "ametadata=print:file=-"
    )
    process = await _launch_decoder(
        [
            executable,
            "-nostdin",
            "-v",
            "error",
            *input_options,
            "-i",
            str(path),
            "-af",
            aggregate_filter,
            "-f",
            "null",
            "-",
        ],
        current=current,
    )
    payload = await _collect_aggregate_output(
        process,
        cancel_event=cancel_event,
        limit=segment_bins * MAX_AGGREGATE_OUTPUT_BYTES_PER_BIN,
    )
    return _parse_aggregate_records(payload, bins=segment_bins)


async def _launch_decoder(
    command: list[str],
    *,
    current: bool,
    stdin: int | None = None,
) -> asyncio.subprocess.Process:
    # The playing song's short build runs ahead of background load so its waveform arrives
    # with playback even when the host CPU is saturated; prefetch yields to everything.
    creationflags = 0
    if sys.platform.startswith("win"):
        creationflags = int(getattr(subprocess, "CREATE_NO_WINDOW", 0)) | int(
            getattr(
                subprocess,
                "ABOVE_NORMAL_PRIORITY_CLASS" if current else "BELOW_NORMAL_PRIORITY_CLASS",
                0,
            )
        )
    elif not current:
        command = ["nice", "-n", "10", *command]
    return await asyncio.create_subprocess_exec(
        *command,
        stdin=stdin,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=creationflags,
    )


async def _collect_aggregate_output(
    process: asyncio.subprocess.Process,
    *,
    cancel_event: asyncio.Event,
    limit: int,
    feed: Awaitable[None] | None = None,
    on_output: Callable[[bytes], None] | None = None,
) -> bytes:
    """Read a decoder's metadata output to EOF, reaping it on failure or cancellation.

    `feed` writes the decoder's input to its stdin while the output is read. With
    `on_output`, each piece of output goes there as it arrives instead of being kept.
    """
    stderr_task = asyncio.create_task(_read_stream_tail(process.stderr))
    feed_task = asyncio.ensure_future(feed) if feed is not None else None
    cancel_task = asyncio.create_task(cancel_event.wait())
    waited = False
    aggregate_output = bytearray()
    received = 0
    read_task: asyncio.Task[bytes] | None = None

    try:
        if process.stdout is None:
            return_code = await process.wait()
            waited = True
            stderr = await stderr_task
            detail = stderr.decode("utf-8", errors="replace").strip()
            suffix = f": {detail}" if detail else ""
            raise RuntimeError(f"ffmpeg stdout pipe is unavailable{suffix} (code {return_code})")

        while True:
            read_task = asyncio.create_task(process.stdout.read(PCM_READ_CHUNK_BYTES))
            done, _pending = await asyncio.wait(
                {read_task, cancel_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if cancel_task in done:
                read_task.cancel()
                with suppress(BaseException):
                    await read_task
                raise asyncio.CancelledError()
            chunk = await read_task
            read_task = None
            if not chunk:
                break
            received += len(chunk)
            if received > limit:
                raise RuntimeError("ffmpeg waveform aggregate output exceeded its bound")
            if on_output is None:
                aggregate_output.extend(chunk)
            else:
                on_output(chunk)

        if feed_task is not None:
            # A failed input read must not pass for a short song.
            await feed_task
        return_code = await process.wait()
        waited = True
        stderr = await stderr_task
        if return_code:
            detail = stderr.decode("utf-8", errors="replace").strip()
            suffix = f": {detail}" if detail else ""
            raise RuntimeError(f"ffmpeg exited with code {return_code}{suffix}")
        return bytes(aggregate_output)
    except asyncio.CancelledError:
        cancel_event.set()
        await _stop_feed(feed_task)
        await _cancel_active_read(read_task)
        if not waited:
            await _finish_process_cleanup(
                process,
                stdout=process.stdout,
                stderr_task=stderr_task,
            )
            waited = True
        if not stderr_task.done():
            with suppress(BaseException):
                await stderr_task
        raise
    except BaseException:
        await _stop_feed(feed_task)
        await _cancel_active_read(read_task)
        if not waited:
            await _finish_process_cleanup(
                process,
                stdout=process.stdout,
                stderr_task=stderr_task,
            )
            waited = True
        if not stderr_task.done():
            with suppress(BaseException):
                await stderr_task
        raise
    finally:
        cancel_task.cancel()
        with suppress(BaseException):
            await cancel_task


async def _run_segments(
    segments: list[Awaitable[list[_PeakBin]]],
    *,
    cancel_event: asyncio.Event,
) -> list[_PeakBin]:
    """Run segments together; a failure or cancellation stops and reaps every decoder."""
    tasks = [asyncio.ensure_future(segment) for segment in segments]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
    finally:
        if not all(task.done() for task in tasks):
            cancel_event.set()
            await _settle_segment_tasks(tasks)
    for task in tasks:
        if not task.cancelled() and task.exception() is not None:
            raise task.exception()  # type: ignore[misc]
    if any(task.cancelled() for task in tasks):
        raise asyncio.CancelledError()
    return [peak for task in tasks for peak in task.result()]


async def _settle_segment_tasks(tasks: list[asyncio.Future[list[_PeakBin]]]) -> None:
    settled = asyncio.gather(*tasks, return_exceptions=True)
    while not settled.done():
        try:
            await asyncio.shield(settled)
        except asyncio.CancelledError:
            # Every decoder is reaped before the build reports its outcome.
            continue


async def build_waveform_peaks(
    path: Path,
    *,
    bins: int,
    cancel_event: asyncio.Event,
    current: bool = False,
    decoders: WaveformDecoderPool | None = None,
    progress: Callable[[WaveformPeaks], None] | None = None,
) -> WaveformPeaks:
    """Build stereo peaks; the playing song uses a started decoder or parallel segments."""
    if bins < 1:
        raise ValueError("waveform bin count must be positive")

    executable = resolve_ffmpeg_executable()
    if not executable:
        raise RuntimeError("ffmpeg executable is unavailable")
    # A started decoder learns the file from a one-line script, which a line break would
    # break; such a file decodes the slower way instead.
    nameable = not any(character in str(path) for character in "\r\n")
    decoder = decoders.take() if current and decoders is not None and nameable else None
    if decoder is not None:
        return await _build_with_warm_decoder(
            decoder,
            path,
            bins=bins,
            cancel_event=cancel_event,
            progress=progress,
        )
    duration_seconds = await asyncio.to_thread(_audio_duration_seconds, path)
    from music_app.services.mp3_gapless import ignored_mp3_gapless_info

    gapless = await ignored_mp3_gapless_info(path, executable, cancel_event=cancel_event)
    frames_per_bin = max(
        1,
        math.ceil(
            duration_seconds
            * WAVEFORM_ANALYSIS_SAMPLE_RATE
            / bins
        ),
    )
    segment_count = _segment_count(duration_seconds, bins=bins, current=current)
    boundaries = [index * bins // segment_count for index in range(segment_count + 1)]
    segments = []
    for first_bin, end_bin in zip(boundaries, boundaries[1:]):
        last = end_bin == bins
        input_options, source_filters = _segment_decode_options(
            path,
            gapless=gapless,
            start_frame=first_bin * frames_per_bin,
            end_frame=None if last else end_bin * frames_per_bin,
        )
        segments.append(
            _build_segment_peak_bins(
                executable,
                path,
                input_options=input_options,
                source_filters=source_filters,
                frames_per_bin=frames_per_bin,
                segment_bins=end_bin - first_bin,
                last=last,
                current=current,
                cancel_event=cancel_event,
            )
        )
    peak_bins = await _run_segments(segments, cancel_event=cancel_event)
    left, right = _expand_peak_bins(peak_bins, bins=bins)
    return WaveformPeaks(left=left, right=right, sample_count=bins)


@dataclass(eq=False, slots=True)
class _BuildJob:
    key: tuple[str, int]
    current: bool
    cancel_event: asyncio.Event
    task: asyncio.Task[WaveformPeaks] | None = None
    waiters: int = 0
    stopping: bool = False
    # Set while a playing-song build with no callers waits for its song to ask again.
    linger_timer: asyncio.TimerHandle | None = None
    # The waveform built so far, shown to every caller while the build runs.
    partial: WaveformPeaks | None = None
    listeners: set[Callable[[WaveformPeaks], None]] = field(default_factory=set)

    def publish(self, peaks: WaveformPeaks) -> None:
        self.partial = peaks
        for listener in tuple(self.listeners):
            listener(peaks)

    def stop(self) -> None:
        """Cancel the build; callers still waiting get a busy answer, not a cancellation."""
        self.stopping = True
        self.cancel_event.set()
        self.cancel_linger()

    def cancel_linger(self) -> None:
        if self.linger_timer is not None:
            self.linger_timer.cancel()
            self.linger_timer = None


class WaveformPeaksRegistry:
    """Admit waveform builds so the playing song never waits behind a prefetch.

    A build for the playing song starts at once, joins an identical build in flight,
    and cancels every prefetch build. A prefetch build starts only when nothing else
    is building and yields to the next playing-song request.
    """

    def __init__(
        self,
        *,
        builder: Callable[..., Awaitable[WaveformPeaks]] = build_waveform_peaks,
        cache_repository: object | None = None,
        analyzer_version: str = WAVEFORM_ANALYZER_VERSION,
        decoder_pool: WaveformDecoderPool | None = None,
    ) -> None:
        self._builder = builder
        self._cache_repository = cache_repository
        self._analyzer_version = analyzer_version
        self._decoder_pool = decoder_pool
        self._jobs: set[_BuildJob] = set()
        self._shutting_down = False

    @property
    def active_job_count(self) -> int:
        return sum(not job.task.done() for job in self._jobs if job.task is not None)

    def _ensure_open(self) -> None:
        if self._shutting_down:
            raise WaveformPeaksBusyError("waveform peak service is shutting down")

    def _cache_identity(self, path: Path, *, bins: int) -> dict[str, object]:
        stat = path.stat()
        return {
            "private_path": str(path.resolve()),
            "file_size_bytes": int(stat.st_size),
            "modified_at_ns": int(stat.st_mtime_ns),
            "content_signature": None,
            "sample_count": bins,
            "analyzer_version": self._analyzer_version,
        }

    async def _get_cached(
        self,
        identity: dict[str, object],
    ) -> WaveformPeaks | None:
        repository = self._cache_repository
        if repository is None:
            return None
        try:
            cached = await asyncio.to_thread(
                repository.get_for_path,  # type: ignore[attr-defined]
                **identity,
            )
        except Exception as error:
            _LOGGER.warning("Waveform peak cache read failed: %s", error)
            return None
        return cached if isinstance(cached, WaveformPeaks) else None

    async def _get_stable_cached(
        self,
        path: Path,
        *,
        bins: int,
        identity: dict[str, object],
    ) -> WaveformPeaks | None:
        """A cache hit counts only if the file did not change while it was read."""
        cached = await self._get_cached(identity)
        if cached is None:
            return None
        try:
            current_identity = await asyncio.to_thread(self._cache_identity, path, bins=bins)
        except OSError as error:
            _LOGGER.warning("Waveform peak cache identity failed: %s", error)
            return None
        return cached if current_identity == identity else None

    async def get_cached(self, path: Path, *, bins: int) -> WaveformPeaks | None:
        self._ensure_open()
        if self._decoder_pool is not None:
            # A song was just selected: have a decoder ready before its build is asked for.
            self._decoder_pool.fill()
        try:
            cache_identity = await asyncio.to_thread(self._cache_identity, path, bins=bins)
        except OSError as error:
            _LOGGER.warning("Waveform peak cache identity failed: %s", error)
            return None
        cached = await self._get_stable_cached(path, bins=bins, identity=cache_identity)
        self._ensure_open()
        return cached

    async def _build_and_cache(
        self,
        path: Path,
        *,
        bins: int,
        job: _BuildJob,
        cache_identity: dict[str, object] | None,
    ) -> WaveformPeaks:
        try:
            peaks = await self._builder(
                path,
                bins=bins,
                cancel_event=job.cancel_event,
                current=job.current,
                **(
                    {"decoders": self._decoder_pool, "progress": job.publish}
                    if self._decoder_pool is not None
                    else {}
                ),
            )
        except asyncio.CancelledError:
            if job.stopping:
                raise WaveformPeaksBusyError("waveform peak build was stopped") from None
            raise
        repository = self._cache_repository
        if repository is None or cache_identity is None or job.cancel_event.is_set():
            return peaks
        # Show the finished waveform now; the cache write can wait on a busy database.
        job.publish(peaks)
        try:
            if await asyncio.to_thread(self._cache_identity, path, bins=bins) != cache_identity:
                return peaks
            await asyncio.to_thread(
                repository.put_for_path,  # type: ignore[attr-defined]
                **cache_identity,
                peaks=peaks,
            )
        except Exception as error:
            _LOGGER.warning("Waveform peak cache write failed: %s", error)
        return peaks

    def _admit(
        self,
        path: Path,
        *,
        bins: int,
        current: bool,
        cache_identity: dict[str, object] | None,
    ) -> _BuildJob:
        # Admission never awaits, so it is atomic on the event loop.
        self._ensure_open()
        key = (str(path), bins)
        active = [job for job in self._jobs if not job.task.done()]  # type: ignore[union-attr]
        for job in active:
            if job.key == key and not job.stopping and (job.current or not current):
                job.cancel_linger()
                return job
        if current:
            # Another song plays now, so builds nobody waits for give way at once.
            for job in active:
                if not job.current or job.linger_timer is not None:
                    job.stop()
            if sum(job.current and not job.stopping for job in active) >= CURRENT_SONG_MAX_BUILDS:
                raise WaveformPeaksBusyError("waveform peak job already active")
        elif active:
            raise WaveformPeaksBusyError("waveform peak job already active")
        job = _BuildJob(key=key, current=current, cancel_event=asyncio.Event())
        job.task = asyncio.create_task(
            self._build_and_cache(path, bins=bins, job=job, cache_identity=cache_identity)
        )
        self._jobs.add(job)
        job.task.add_done_callback(lambda task, job=job: self._retire(job, task))
        return job

    def _retire(self, job: _BuildJob, task: asyncio.Task[WaveformPeaks]) -> None:
        self._jobs.discard(job)
        if self._decoder_pool is not None and not self._shutting_down:
            # Replace a used decoder once the build no longer competes with its start.
            self._decoder_pool.fill()
        if not task.cancelled():
            # Every caller may have left; consume the outcome so it is never reported unretrieved.
            task.exception()

    async def run(
        self,
        path: Path,
        *,
        bins: int,
        current: bool = False,
        on_progress: Callable[[WaveformPeaks], None] | None = None,
    ) -> WaveformPeaks:
        """Return the song's peaks; `on_progress` sees the waveform built so far.

        The playing song's build starts without waiting for the cache read, which can take
        seconds on a busy database; a cache hit that arrives first answers and stops it.
        """
        self._ensure_open()
        cache_identity: dict[str, object] | None = None
        if self._cache_repository is not None:
            try:
                cache_identity = await asyncio.to_thread(self._cache_identity, path, bins=bins)
            except OSError as error:
                _LOGGER.warning("Waveform peak cache identity failed: %s", error)
        cache_read: asyncio.Task[WaveformPeaks | None] | None = None
        if cache_identity is not None and current:
            cache_read = asyncio.create_task(
                self._get_stable_cached(path, bins=bins, identity=cache_identity)
            )
        elif cache_identity is not None:
            cached = await self._get_stable_cached(path, bins=bins, identity=cache_identity)
            self._ensure_open()
            if cached is not None:
                return cached
            try:
                # The file may have changed while the cache was read.
                cache_identity = await asyncio.to_thread(self._cache_identity, path, bins=bins)
            except OSError as error:
                _LOGGER.warning("Waveform peak cache identity failed: %s", error)
                cache_identity = None
        try:
            job = self._admit(path, bins=bins, current=current, cache_identity=cache_identity)
        except BaseException:
            if cache_read is not None:
                cache_read.cancel()
            raise
        task = job.task
        assert task is not None
        job.waiters += 1
        if on_progress is not None:
            job.listeners.add(on_progress)
            if job.partial is not None:
                on_progress(job.partial)
        try:
            if cache_read is not None:
                await asyncio.wait({cache_read, task}, return_when=asyncio.FIRST_COMPLETED)
                if task.done() and not task.cancelled() and task.exception() is not None:
                    # A failed build still answers from the cache when the cache has it.
                    await asyncio.wait({cache_read})
                cached = cache_read.result() if cache_read.done() else None
                if cached is not None:
                    self._ensure_open()
                    if job.waiters == 1 and not task.done():
                        job.stop()
                    return cached
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            if job.waiters == 1 and not task.done():
                if job.current:
                    # The last caller left: wait briefly for the playing song to ask again.
                    job.linger_timer = asyncio.get_running_loop().call_later(
                        CURRENT_SONG_REJOIN_SECONDS,
                        job.stop,
                    )
                else:
                    job.stop()
                    with suppress(BaseException):
                        await asyncio.shield(task)
            raise
        finally:
            if cache_read is not None:
                cache_read.cancel()
            job.waiters -= 1
            job.listeners.discard(on_progress)

    async def _shutdown_and_release(self) -> None:
        self._shutting_down = True
        tasks = [job.task for job in self._jobs if job.task is not None]
        for job in self._jobs:
            job.stop()
        if tasks:
            await asyncio.wait(tasks)
        if self._decoder_pool is not None:
            await self._decoder_pool.close()

    async def shutdown(self) -> None:
        shutdown_task = asyncio.create_task(self._shutdown_and_release())
        cancellation: asyncio.CancelledError | None = None
        while not shutdown_task.done():
            try:
                await asyncio.shield(shutdown_task)
            except asyncio.CancelledError as exc:
                if cancellation is None:
                    cancellation = exc
                continue

        shutdown_task.result()
        if cancellation is not None:
            raise cancellation
