from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import dataclass
import logging
import math
from pathlib import Path
import re
import subprocess
import sys
from typing import Awaitable, Callable

from music_app.services.ffmpeg_runtime import resolve_ffmpeg_executable


PCM_READ_CHUNK_BYTES = 64 * 1024
MAX_STDERR_DIAGNOSTIC_BYTES = 64 * 1024
MAX_AGGREGATE_OUTPUT_BYTES_PER_BIN = 160
WAVEFORM_ANALYSIS_SAMPLE_RATE = 8_000
WAVEFORM_ANALYZER_VERSION = "waveform-peaks-v2"
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


def _parse_aggregate_records(payload: bytes, *, bins: int) -> WaveformPeaks:
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
    left, right = _expand_peak_bins(peak_bins, bins=bins)
    return WaveformPeaks(left=left, right=right, sample_count=bins)


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


async def build_waveform_peaks(
    path: Path,
    *,
    bins: int,
    cancel_event: asyncio.Event,
) -> WaveformPeaks:
    if bins < 1:
        raise ValueError("waveform bin count must be positive")

    executable = resolve_ffmpeg_executable()
    if not executable:
        raise RuntimeError("ffmpeg executable is unavailable")
    duration_seconds = await asyncio.to_thread(_audio_duration_seconds, path)
    frames_per_bin = max(
        1,
        math.ceil(
            duration_seconds
            * WAVEFORM_ANALYSIS_SAMPLE_RATE
            / bins
        ),
    )
    padded_frames = frames_per_bin * bins
    aggregate_filter = (
        f"aresample={WAVEFORM_ANALYSIS_SAMPLE_RATE},"
        "aformat=channel_layouts=stereo,"
        f"apad=whole_len={padded_frames},"
        f"asetnsamples=n={frames_per_bin}:p=1,"
        "astats=metadata=1:reset=1:measure_perchannel=Peak_level:measure_overall=none,"
        "ametadata=print:file=-"
    )
    command = [
        executable,
        "-nostdin",
        "-v",
        "error",
        "-i",
        str(path),
        "-af",
        aggregate_filter,
        "-f",
        "null",
        "-",
    ]
    creationflags = 0
    if sys.platform.startswith("win"):
        creationflags = int(getattr(subprocess, "CREATE_NO_WINDOW", 0)) | int(
            getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)
        )
    else:
        command = ["nice", "-n", "10", *command]

    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=creationflags,
    )
    stderr_task = asyncio.create_task(_read_stream_tail(process.stderr))
    cancel_task = asyncio.create_task(cancel_event.wait())
    waited = False
    aggregate_output = bytearray()
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
            aggregate_output.extend(chunk)
            if len(aggregate_output) > bins * MAX_AGGREGATE_OUTPUT_BYTES_PER_BIN:
                raise RuntimeError("ffmpeg waveform aggregate output exceeded its bound")

        return_code = await process.wait()
        waited = True
        stderr = await stderr_task
        if return_code:
            detail = stderr.decode("utf-8", errors="replace").strip()
            suffix = f": {detail}" if detail else ""
            raise RuntimeError(f"ffmpeg exited with code {return_code}{suffix}")
        return _parse_aggregate_records(bytes(aggregate_output), bins=bins)
    except asyncio.CancelledError:
        cancel_event.set()
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


WaveformBuilder = Callable[
    [Path],
    Awaitable[WaveformPeaks],
]


class WaveformPeaksRegistry:
    def __init__(
        self,
        *,
        builder: Callable[..., Awaitable[WaveformPeaks]] = build_waveform_peaks,
        cache_repository: object | None = None,
        analyzer_version: str = WAVEFORM_ANALYZER_VERSION,
    ) -> None:
        self._builder = builder
        self._cache_repository = cache_repository
        self._analyzer_version = analyzer_version
        self._lock = asyncio.Lock()
        self._active_task: asyncio.Task[WaveformPeaks] | None = None
        self._active_cancel_event: asyncio.Event | None = None
        self._release_tasks: set[asyncio.Task[None]] = set()
        self._shutting_down = False

    async def _release_completed_task(self, task: asyncio.Task[WaveformPeaks]) -> None:
        async with self._lock:
            if self._active_task is task and task.done():
                self._active_task = None
                self._active_cancel_event = None

    def _schedule_completed_task_release(self, task: asyncio.Task[WaveformPeaks]) -> None:
        release_task = asyncio.create_task(self._release_completed_task(task))
        self._release_tasks.add(release_task)
        release_task.add_done_callback(self._release_tasks.discard)

    @property
    def active_job_count(self) -> int:
        task = self._active_task
        return int(task is not None and not task.done())

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

    async def get_cached(self, path: Path, *, bins: int) -> WaveformPeaks | None:
        async with self._lock:
            if self._shutting_down:
                raise WaveformPeaksBusyError("waveform peak job already active")
        try:
            cache_identity = self._cache_identity(path, bins=bins)
        except OSError as error:
            _LOGGER.warning("Waveform peak cache identity failed: %s", error)
            return None
        cached = await self._get_cached(cache_identity)
        try:
            current_cache_identity = self._cache_identity(path, bins=bins)
        except OSError as error:
            _LOGGER.warning("Waveform peak cache identity failed: %s", error)
            current_cache_identity = None
        async with self._lock:
            if self._shutting_down:
                raise WaveformPeaksBusyError("waveform peak job already active")
        return cached if current_cache_identity == cache_identity else None

    async def _build_and_cache(
        self,
        path: Path,
        *,
        bins: int,
        cancel_event: asyncio.Event,
        cache_identity: dict[str, object] | None,
    ) -> WaveformPeaks:
        peaks = await self._builder(path, bins=bins, cancel_event=cancel_event)
        repository = self._cache_repository
        if repository is None or cache_identity is None or cancel_event.is_set():
            return peaks
        try:
            if self._cache_identity(path, bins=bins) != cache_identity:
                return peaks
            await asyncio.to_thread(
                repository.put_for_path,  # type: ignore[attr-defined]
                **cache_identity,
                peaks=peaks,
            )
        except Exception as error:
            _LOGGER.warning("Waveform peak cache write failed: %s", error)
        return peaks

    async def run(self, path: Path, *, bins: int) -> WaveformPeaks:
        async with self._lock:
            if self._shutting_down:
                raise WaveformPeaksBusyError("waveform peak job already active")
        cache_identity: dict[str, object] | None = None
        if self._cache_repository is not None:
            try:
                cache_identity = self._cache_identity(path, bins=bins)
            except OSError as error:
                _LOGGER.warning("Waveform peak cache identity failed: %s", error)
            if cache_identity is not None:
                cached = await self._get_cached(cache_identity)
                if cached is not None:
                    try:
                        current_cache_identity = self._cache_identity(path, bins=bins)
                    except OSError as error:
                        _LOGGER.warning("Waveform peak cache identity failed: %s", error)
                        cache_identity = None
                    else:
                        if current_cache_identity == cache_identity:
                            async with self._lock:
                                if self._shutting_down:
                                    raise WaveformPeaksBusyError(
                                        "waveform peak job already active"
                                    )
                            return cached
                        cache_identity = current_cache_identity
        async with self._lock:
            if self._active_task is not None and self._active_task.done():
                self._active_task = None
                self._active_cancel_event = None
            if self._shutting_down or self._active_task is not None:
                raise WaveformPeaksBusyError("waveform peak job already active")
            cancel_event = asyncio.Event()
            task = asyncio.create_task(
                self._build_and_cache(
                    path,
                    bins=bins,
                    cancel_event=cancel_event,
                    cache_identity=cache_identity,
                )
            )
            self._active_cancel_event = cancel_event
            self._active_task = task
            task.add_done_callback(self._schedule_completed_task_release)
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            cancel_event.set()
            with suppress(BaseException):
                await asyncio.shield(task)
            raise
        finally:
            if task.done():
                await asyncio.shield(self._release_completed_task(task))

    async def _shutdown_and_release(self) -> None:
        async with self._lock:
            self._shutting_down = True
            task = self._active_task
            cancel_event = self._active_cancel_event
            if cancel_event is not None:
                cancel_event.set()
        if task is not None:
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
            await asyncio.shield(self._release_completed_task(task))
        while self._release_tasks:
            release_tasks = tuple(self._release_tasks)
            await asyncio.gather(*release_tasks)

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
