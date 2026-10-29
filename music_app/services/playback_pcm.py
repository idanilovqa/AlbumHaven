from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
import math
from pathlib import Path
import struct
from typing import Awaitable, Callable, Literal
from uuid import UUID, uuid4

from music_app.services.ffmpeg_runtime import (
    hidden_subprocess_creation_flags,
    resolve_ffmpeg_executable,
)
from music_app.services.mp3_gapless import Mp3GaplessProbe


PcmRole = Literal["current", "continuity"]
_BYTES_PER_STEREO_FRAME = 8
_STDERR_TAIL_LIMIT = 64 * 1024
_ENCODED_SEEK_PREROLL_SECONDS = 0.25
_TERMINATE_WAIT_SECONDS = 1.0
_KILL_WAIT_SECONDS = 1.0
_PIPE_DRAIN_SECONDS = 1.0
_CLEANUP_JOIN_SECONDS = 4.0
_EOF_SETTLEMENT_SECONDS = 3.0
_STARTUP_WAIT_SECONDS = 10.0
_ROLE_CODES: dict[PcmRole, int] = {"current": 0, "continuity": 1}


def _validate_nonnegative_integer(name: str, value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be an integer")
    if value < 0:
        raise ValueError(f"{name} must be nonnegative")
    return value


@dataclass(frozen=True, slots=True)
class PcmOpenCommand:
    generation: int
    stream_id: int
    role: PcmRole
    path: Path
    start_frame: int
    sample_rate: int
    provisional_duration_seconds: float
    capture_local_coordinates: bool = False
    capture_absolute_coordinates: bool = False

    def __post_init__(self) -> None:
        if type(self.capture_local_coordinates) is not bool:
            raise TypeError("capture_local_coordinates must be a boolean")
        if type(self.capture_absolute_coordinates) is not bool:
            raise TypeError("capture_absolute_coordinates must be a boolean")
        _validate_nonnegative_integer("generation", self.generation)
        if self.generation == 0:
            raise ValueError("generation must be positive")
        _validate_nonnegative_integer("stream_id", self.stream_id)
        if self.stream_id == 0:
            raise ValueError("stream_id must be positive")
        if self.role not in _ROLE_CODES:
            raise ValueError("role must be current or continuity")
        object.__setattr__(self, "path", Path(self.path))
        _validate_nonnegative_integer("start_frame", self.start_frame)
        _validate_nonnegative_integer("sample_rate", self.sample_rate)
        if self.sample_rate == 0:
            raise ValueError("sample_rate must be positive")
        duration = self.provisional_duration_seconds
        if isinstance(duration, bool) or not isinstance(duration, (int, float)):
            raise TypeError("duration must be a number")
        if not math.isfinite(duration) or duration < 0:
            raise ValueError("duration must be finite and nonnegative")
        object.__setattr__(self, "provisional_duration_seconds", float(duration))


@dataclass(frozen=True, slots=True)
class PcmStreamMetadata:
    generation: int
    stream_id: int
    role: PcmRole
    sample_rate: int
    channels: int
    provisional_total_frames: int
    requested_start_frame: int
    timeline_start_frame: int
    authoritative_total_frames: int | None = None
    # Same-decoder output coordinates, never a catalog or immutable-file claim.
    capture_source_id: str | None = None
    capture_source_base48: int | None = None
    capture_extent_frames48: int | None = None
    # Local zero is the first output frame of this decoder, NOT the seek target.
    capture_local_coordinates: bool = False
    capture_absolute_coordinates: bool = False

    @property
    def capture_coordinate_basis(self) -> str:
        if self.capture_source_base48 is None:
            return "unknown"
        if self.capture_absolute_coordinates:
            return "decoded-output-absolute-wav48"
        return "decoded-output-local" if self.capture_local_coordinates else "decoded-output-zero"

    def __post_init__(self) -> None:
        _validate_nonnegative_integer("generation", self.generation)
        if self.generation == 0:
            raise ValueError("generation must be positive")
        _validate_nonnegative_integer("stream_id", self.stream_id)
        if self.stream_id == 0:
            raise ValueError("stream_id must be positive")
        if self.role not in _ROLE_CODES:
            raise ValueError("role must be current or continuity")
        _validate_nonnegative_integer("sample_rate", self.sample_rate)
        if self.sample_rate == 0:
            raise ValueError("sample_rate must be positive")
        if self.channels != 2:
            raise ValueError("channels must be stereo")
        for name in (
            "provisional_total_frames",
            "requested_start_frame",
            "timeline_start_frame",
        ):
            _validate_nonnegative_integer(name, getattr(self, name))
        if self.authoritative_total_frames is not None:
            _validate_nonnegative_integer(
                "authoritative_total_frames",
                self.authoritative_total_frames,
            )
            if self.authoritative_total_frames < self.timeline_start_frame:
                raise ValueError(
                    "authoritative_total_frames cannot precede timeline_start_frame"
                )
        if self.capture_source_id is not None:
            if not isinstance(self.capture_source_id, str):
                raise TypeError("capture_source_id must be a string")
            source_id = UUID(self.capture_source_id)
            if str(source_id) != self.capture_source_id or source_id.version != 4:
                raise ValueError("capture_source_id must be a canonical UUID4")
        if type(self.capture_local_coordinates) is not bool:
            raise TypeError("capture_local_coordinates must be a boolean")
        if type(self.capture_absolute_coordinates) is not bool:
            raise TypeError("capture_absolute_coordinates must be a boolean")
        if self.capture_absolute_coordinates and self.capture_local_coordinates:
            raise ValueError("absolute and local coordinates are distinct observations")
        if self.capture_local_coordinates and (self.requested_start_frame <= 0
                or self.capture_source_base48 is None):
            raise ValueError("decoder-local capture requires a nonzero start")
        if self.capture_source_base48 is not None:
            if (type(self.capture_source_base48) is not int
                    or self.capture_source_base48 != 0
                    or self.capture_source_id is None
                    or self.sample_rate != 48_000
                    or self.requested_start_frame > 2**53 - 1
                    or self.timeline_start_frame != self.requested_start_frame
                    or (self.requested_start_frame != 0 and not (self.capture_local_coordinates or self.capture_absolute_coordinates))):
                raise ValueError("capture requires explicit 48 kHz decoder coordinates")
        if self.capture_extent_frames48 is not None:
            _validate_nonnegative_integer("capture_extent_frames48", self.capture_extent_frames48)
            if (self.capture_source_base48 is None
                    or self.capture_extent_frames48 > 2**53 - 1
                    or (self.capture_extent_frames48 if self.capture_absolute_coordinates else
                        self.timeline_start_frame + self.capture_extent_frames48) != self.authoritative_total_frames):
                raise ValueError("capture extent requires matching decoder-output EOF")


@dataclass(frozen=True, slots=True)
class PcmChunk:
    frame_count: int
    pcm: bytes
    verified_absolute_ranges: tuple[tuple[int, int, int], ...] = ()


ProcessFactory = Callable[..., Awaitable[asyncio.subprocess.Process]]


def pack_pcm_frame(
    *,
    generation: int,
    stream_id: int,
    role: PcmRole,
    sequence: int,
    frame_count: int,
    pcm: bytes,
) -> bytes:
    fields = {
        "generation": generation,
        "stream_id": stream_id,
        "sequence": sequence,
        "frame_count": frame_count,
    }
    for name, value in fields.items():
        _validate_nonnegative_integer(name, value)
        if value > 0xFFFFFFFF:
            raise ValueError(f"{name} exceeds the protocol limit")
    if stream_id == 0:
        raise ValueError("stream_id must be positive")
    if role not in _ROLE_CODES:
        raise ValueError("role must be current or continuity")
    if len(pcm) % _BYTES_PER_STEREO_FRAME:
        raise ValueError("PCM payload is not aligned to a complete stereo frame")
    if len(pcm) != frame_count * _BYTES_PER_STEREO_FRAME:
        raise ValueError("PCM payload length does not match frame_count")

    header = b"AHPC" + struct.pack(
        ">BBHIIII",
        1,
        _ROLE_CODES[role],
        0,
        generation,
        stream_id,
        sequence,
        frame_count,
    )
    return header + pcm


class PcmDecoderProcess:
    def __init__(
        self,
        command: PcmOpenCommand,
        process: asyncio.subprocess.Process | None = None,
    ) -> None:
        self.command = command
        self._process = process
        self.metadata = PcmStreamMetadata(
            generation=command.generation,
            stream_id=command.stream_id,
            role=command.role,
            sample_rate=command.sample_rate,
            channels=2,
            provisional_total_frames=round(
                command.provisional_duration_seconds * command.sample_rate
            ),
            requested_start_frame=command.start_frame,
            timeline_start_frame=command.start_frame,
            capture_source_id=str(uuid4()),
            capture_source_base48=(
                0 if command.sample_rate == 48_000 and (command.start_frame == 0
                    or command.capture_local_coordinates and command.start_frame <= 2**53 - 1) else None
            ),
            capture_local_coordinates=(command.capture_local_coordinates and command.start_frame > 0
                and command.sample_rate == 48_000 and command.start_frame <= 2**53 - 1),
        )
        self.outstanding_credit_frames = 0
        self.emitted_frames = 0
        self.stderr_tail = ""
        self._stderr_bytes = bytearray()
        self._stderr_task: asyncio.Task[None] | None = None
        self._launch_task: asyncio.Task[None] | None = None
        self._stdout_read_task: asyncio.Task[bytes] | None = None
        self._stdout_discard_task: asyncio.Task[None] | None = None
        self._wait_task: asyncio.Task[int] | None = None
        self._cleanup_task: asyncio.Task[None] | None = None
        self._gapless_probe = Mp3GaplessProbe()
        self._process_launch_started = process is not None
        self._cancelled = False
        self._capture_failed = False
        self._absolute_observer = None
        self._absolute_source = None
        self.absolute_metadata = None
        self._eos = False
        if process is not None:
            self._stderr_task = asyncio.create_task(self._drain_stderr())

    @classmethod
    async def start(
        cls,
        command: PcmOpenCommand,
        *,
        ffmpeg_executable: str | None = None,
        process_factory: ProcessFactory = asyncio.create_subprocess_exec,
        on_start: Callable[["PcmDecoderProcess"], None] | None = None,
    ) -> "PcmDecoderProcess":
        executable = ffmpeg_executable or resolve_ffmpeg_executable()
        if not executable:
            raise RuntimeError("ffmpeg was not found")

        decoder = cls(command)
        # The route retains this ordinary decoder with its existing reservation
        # before any probe or subprocess await. Cancellation cannot orphan it.
        if on_start is not None:
            on_start(decoder)
        decoder._launch_task = asyncio.create_task(
            decoder._launch(executable, process_factory)
        )
        try:
            completed, _ = await asyncio.wait(
                {decoder._launch_task}, timeout=_STARTUP_WAIT_SECONDS)
            if not completed:
                raise RuntimeError("ffmpeg startup timed out")
            decoder._launch_task.result()
            if decoder._cancelled:
                raise RuntimeError("PCM decoder was cancelled")
            return decoder
        except BaseException:
            decoder.request_cancel()
            raise

    async def _launch(self, executable: str, process_factory: ProcessFactory) -> None:
        command = self.command

        requested_seek_seconds = command.start_frame / command.sample_rate
        input_seek: tuple[str, ...] = ()
        output_seek: tuple[str, ...] = ()
        if command.path.suffix.lower() in {".wav", ".wave", ".flac", ".aif", ".aiff"}:
            input_seek = ("-ss", f"{requested_seek_seconds:.9f}")
        else:
            input_seek_seconds = max(
                0.0,
                requested_seek_seconds - _ENCODED_SEEK_PREROLL_SECONDS,
            )
            input_seek = ("-ss", f"{input_seek_seconds:.9f}")
            output_seek = (
                "-ss",
                f"{requested_seek_seconds - input_seek_seconds:.9f}",
            )

        from music_app.services.mp3_gapless import ignored_mp3_gapless_info

        gapless = await ignored_mp3_gapless_info(
            command.path, executable, probe=self._gapless_probe)
        if self._cancelled:
            return
        audio_filter: tuple[str, ...] = ()
        if gapless is not None:
            coarse_seconds, filters = gapless.decode_filters(command.sample_rate, command.start_frame)
            input_seek = ("-ss", str(coarse_seconds)) if coarse_seconds else ()
            output_seek = ()
            audio_filter = ("-af", filters)
            command = replace(command, provisional_duration_seconds=gapless.duration_seconds)
            self.command = command
            self.metadata = replace(self.metadata, provisional_total_frames=round(
                command.provisional_duration_seconds * command.sample_rate))
        absolute_source = None
        if (command.capture_absolute_coordinates and command.capture_local_coordinates
                and command.start_frame > 0 and command.sample_rate == 48000
                and gapless is None and command.path.suffix.lower() in {".wav", ".wave"}):
            from music_app.services.playback_pcm_fd_capability import fd_capture_ready
            if fd_capture_ready(executable):
                from music_app.services.playback_pcm_wave_source import open_qualified_wave
                absolute_source = await asyncio.to_thread(open_qualified_wave, command.path)
                if self._cancelled:
                    if absolute_source is not None:
                        absolute_source.close()
                    return
        if absolute_source is not None:
            from music_app.services.playback_pcm_position import PcmPositionObserver
            self._absolute_source = absolute_source
            self._absolute_observer = PcmPositionObserver(require_wav_header=True,
                wav_bits=absolute_source.qualification_bits,
                source_frames48=absolute_source.qualification_frames)
            self.absolute_metadata = replace(self.metadata, capture_source_id=str(uuid4()),
                capture_local_coordinates=False, capture_absolute_coordinates=True)
            audio_filter = ("-af", "aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo,asettb=expr=1/48000,ashowinfo")
        self._process_launch_started = True
        try:
            process = await process_factory(
            executable,
            "-hide_banner",
            "-loglevel",
            "info" if absolute_source is not None else "error",
            *(("-copyts", "-nostdin") if absolute_source is not None else ()),
            *input_seek,
            "-i",
            "fd:" if absolute_source is not None else str(command.path),
            *output_seek,
            "-vn",
            *audio_filter,
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "-ac",
            "2",
            "-ar",
            str(command.sample_rate),
            "pipe:1",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=absolute_source if absolute_source is not None else asyncio.subprocess.DEVNULL,
            creationflags=hidden_subprocess_creation_flags(),
        )
        except BaseException:
            self._close_absolute_source()
            raise
        self._process = process
        self._stderr_task = asyncio.create_task(self._drain_stderr())
        if process.stdout is None or process.stderr is None:
            raise RuntimeError("ffmpeg subprocess did not provide output pipes")

    @classmethod
    async def start_retained(
        cls,
        command: PcmOpenCommand,
        *,
        admission,
        capability,
        process_factory: ProcessFactory = asyncio.create_subprocess_exec,
        capability_probe=None,
        pipe_completion=None,
    ) -> "RetainedPcmDecoderProcess":
        """Dormant two-phase entry; caller admits P synchronously before await.

        If this coroutine is never executed, caller must request_cancel on its
        admission in finally. No application route invokes this method.
        """
        from music_app.services.rooted_playback_adapter import RootedPlaybackAdmission

        if type(admission) is not RootedPlaybackAdmission:
            raise TypeError("rooted_admission_required")
        if type(command) is not PcmOpenCommand:
            raise TypeError("pcm_open_command_required")
        options = {"capability": capability, "process_factory": process_factory}
        if capability_probe is not None:
            options["capability_probe"] = capability_probe
        if pipe_completion is not None:
            options["pipe_completion"] = pipe_completion
        # Preclaim rejection has no cancellation authority over another caller.
        claim = admission._claim_start(command, **options)
        try:
            await admission._await_start(claim)
            if admission.gapless is not None:
                command = replace(command,
                    provisional_duration_seconds=admission.gapless.duration_seconds)
            return RetainedPcmDecoderProcess(command, admission)
        except BaseException:
            admission._cancel_start(claim)
            raise

    def grant_credit(self, frame_count: int) -> None:
        _validate_nonnegative_integer("frame_count", frame_count)
        self.outstanding_credit_frames += frame_count

    async def read_credited_frames(
        self,
        *,
        max_frames: int,
        delivery_role: PcmRole | None = None,
    ) -> PcmChunk:
        _validate_nonnegative_integer("max_frames", max_frames)
        if self._cancelled:
            raise RuntimeError("PCM decoder was cancelled")
        reservation = min(max_frames, self.outstanding_credit_frames)
        if reservation == 0:
            return PcmChunk(frame_count=0, pcm=b"")

        self.outstanding_credit_frames -= reservation
        try:
            reservation_bytes = reservation * _BYTES_PER_STEREO_FRAME
            data = bytearray(await self._read_stdout(reservation_bytes))
            if not data:
                await self._complete_eos()
                self.outstanding_credit_frames += reservation
                return PcmChunk(frame_count=0, pcm=b"")

            effective_role = self.command.role if delivery_role is None else delivery_role
            if effective_role == "continuity":
                while len(data) < reservation_bytes:
                    fragment = await self._read_stdout(reservation_bytes - len(data))
                    if not fragment:
                        break
                    data.extend(fragment)

            while len(data) % _BYTES_PER_STEREO_FRAME:
                needed = _BYTES_PER_STEREO_FRAME - (
                    len(data) % _BYTES_PER_STEREO_FRAME
                )
                extra = await self._read_stdout(needed)
                if not extra:
                    await self._settle_eof()
                    raise RuntimeError("ffmpeg returned truncated partial PCM frame")
                data += extra

            frame_count = len(data) // _BYTES_PER_STEREO_FRAME
            self.outstanding_credit_frames += reservation - frame_count
            chunk_start = self.emitted_frames
            self.emitted_frames += frame_count
            pcm = bytes(data)
            ranges = []
            if self._absolute_observer is not None:
                self._check_absolute_source()
                for offset in range(0, len(pcm), 131072):
                    for interval in self._absolute_observer.consume_pcm(pcm[offset:offset + 131072]):
                        begin = max(chunk_start, interval.output_start48)
                        end = min(self.emitted_frames, interval.output_start48 + interval.frames48)
                        if begin < end:
                            ranges.append((begin - chunk_start,
                                interval.source_start48 + begin - interval.output_start48, end - begin))
                self._check_absolute_source()
                if not self._absolute_observer.available or len(ranges) > 32:
                    ranges = []
            return PcmChunk(frame_count=frame_count, pcm=pcm, verified_absolute_ranges=tuple(ranges))
        except BaseException as error:
            self._capture_failed = True
            self.outstanding_credit_frames += reservation
            if isinstance(error, asyncio.CancelledError):
                self.request_cancel()
            raise

    def _check_absolute_source(self):
        if self._absolute_observer is None:
            return
        from music_app.services.playback_pcm_wave_source import qualified_wave_unchanged
        if not qualified_wave_unchanged(self._absolute_source):
            self._absolute_observer.lose('source_changed')

    def _close_absolute_source(self):
        source, self._absolute_source = self._absolute_source, None
        if source is not None:
            source.close()

    async def finish(self) -> PcmStreamMetadata:
        if self._cancelled:
            raise RuntimeError("PCM decoder was cancelled")
        if not self._process.stdout.at_eof():
            raise RuntimeError("cannot finish PCM decoder before stdout reaches end-of-stream")
        await self._complete_eos()
        return self.metadata

    def request_cancel(self) -> None:
        self._gapless_probe.request_cancel()
        if not self._cancelled:
            self._cancelled = True
            self._capture_failed = True
            self.metadata = replace(self.metadata, capture_extent_frames48=None)
            if self._stdout_read_task is not None and not self._stdout_read_task.done():
                self._stdout_read_task.cancel()
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup())
            self._cleanup_task.add_done_callback(self._observe_cleanup)

    @staticmethod
    def _observe_cleanup(task: asyncio.Task[None]) -> None:
        # The retained attempt may finish after its request was cancelled.
        if not task.cancelled():
            task.exception()

    async def cancel(self) -> None:
        self.request_cancel()
        completed, _ = await asyncio.wait(
            {self._cleanup_task}, timeout=_CLEANUP_JOIN_SECONDS)
        if self.cleanup_complete:
            return
        if not completed:
            raise RuntimeError("ffmpeg cleanup unresolved; decoder remains unavailable")
        self._cleanup_task.result()

    async def _cleanup(self) -> None:
        # A launch cannot safely be cancelled while it may own a child.
        # Its route reservation and task remain retained, even after cancel()
        # returns its bounded unresolved result. A late child uses this attempt.
        if self._launch_task is not None:
            try:
                await asyncio.shield(self._launch_task)
            except (Exception, asyncio.CancelledError):
                pass
        self._close_absolute_source()
        await self._gapless_probe.wait_closed()
        if self._process is None:
            if self.cleanup_complete:
                return
            raise RuntimeError("ffmpeg launch failed without settlement; decoder remains unavailable")
        if self._stdout_discard_task is None:
            self._stdout_discard_task = asyncio.create_task(self._discard_stdout())
        wait_task = self._ensure_wait_task()
        if self._process.returncode is None:
            try:
                self._process.terminate()
            except (ProcessLookupError, OSError):
                pass
        await asyncio.wait({wait_task}, timeout=_TERMINATE_WAIT_SECONDS)
        if self._process.returncode is None:
            try:
                self._process.kill()
            except (ProcessLookupError, OSError):
                pass
        await asyncio.wait({wait_task}, timeout=_KILL_WAIT_SECONDS)
        await asyncio.wait(
            {self._stdout_discard_task, self._stderr_task},
            timeout=_PIPE_DRAIN_SECONDS,
        )
        if not self.cleanup_complete:
            raise RuntimeError("ffmpeg cleanup unresolved; decoder remains unavailable")
        self.stderr_tail = self._stderr_bytes.decode(errors="replace")

    @property
    def cleanup_complete(self) -> bool:
        if not self._gapless_probe.cleanup_complete:
            return False
        if self._launch_task is not None and not self._launch_task.done():
            return False
        if self._process is None:
            return (self._launch_task is not None and self._launch_task.done()
                    and not self._process_launch_started)
        tasks = (self._wait_task, self._stdout_discard_task, self._stderr_task)
        return (self._process.returncode is not None
                and all(task is not None and task.done() and not task.cancelled()
                        and task.exception() is None for task in tasks))

    async def wait_closed(self) -> None:
        """Observe late settlement without repeating cleanup or releasing early.

        The route retains this observer and its reservation. Request handlers
        join with a deadline; this is deliberately not a new cleanup attempt.
        """
        if self._cleanup_task is None:
            self.request_cancel()
        await asyncio.gather(asyncio.shield(self._cleanup_task), return_exceptions=True)
        await self._gapless_probe.wait_closed()
        if self._process is not None:
            await asyncio.gather(
                asyncio.shield(self._ensure_wait_task()),
                asyncio.shield(self._stdout_discard_task),
                asyncio.shield(self._stderr_task),
                return_exceptions=True,
            )
        if not self.cleanup_complete:
            raise RuntimeError("ffmpeg cleanup failed; decoder remains unavailable")

    async def _read_stdout(self, size: int) -> bytes:
        if self._stdout_read_task is not None and not self._stdout_read_task.done():
            raise RuntimeError("PCM stdout already has a reader")
        self._stdout_read_task = asyncio.create_task(self._process.stdout.read(size))
        data = await asyncio.shield(self._stdout_read_task)
        if self._cancelled:
            raise RuntimeError("PCM decoder was cancelled")
        return data

    async def _discard_stdout(self) -> None:
        if self._stdout_read_task is not None:
            await asyncio.gather(self._stdout_read_task, return_exceptions=True)
        if self._process.stdout is not None:
            while await self._process.stdout.read(64 * 1024):
                pass

    async def _drain_stderr(self) -> None:
        if self._process.stderr is None:
            return
        while True:
            chunk = await self._process.stderr.read(8192)
            if not chunk:
                break
            if self._absolute_observer is not None:
                self._absolute_observer.feed_stderr(chunk)
            self._stderr_bytes.extend(chunk)
            if len(self._stderr_bytes) > _STDERR_TAIL_LIMIT:
                del self._stderr_bytes[:-_STDERR_TAIL_LIMIT]

    def _ensure_wait_task(self) -> asyncio.Task[int]:
        if self._wait_task is None:
            self._wait_task = asyncio.create_task(self._process.wait())
        return self._wait_task

    async def _settle_eof(self) -> int:
        wait_task = self._ensure_wait_task()
        try:
            _, pending = await asyncio.wait(
                {wait_task, self._stderr_task}, timeout=_EOF_SETTLEMENT_SECONDS)
            if pending:
                self.request_cancel()
                raise RuntimeError("ffmpeg EOF settlement timed out")
            return_code = wait_task.result()
            self._stderr_task.result()
            self.stderr_tail = self._stderr_bytes.decode(errors="replace")
            return return_code
        except BaseException:
            self._capture_failed = True
            self.request_cancel()
            raise

    async def _complete_eos(self) -> None:
        if self._eos:
            return
        return_code = await self._settle_eof()
        if self._cancelled:
            raise RuntimeError("PCM decoder was cancelled")
        if return_code != 0:
            diagnostic = self.stderr_tail.strip()
            detail = f": {diagnostic}" if diagnostic else ""
            raise RuntimeError(f"ffmpeg exited with code {return_code}{detail}")
        self._eos = True
        self._check_absolute_source()
        if self._absolute_observer is not None and self._absolute_observer.finish():
            extent = self._absolute_observer.source_end48
            self.absolute_metadata = replace(self.absolute_metadata,
                authoritative_total_frames=extent, capture_extent_frames48=extent)
        self._close_absolute_source()
        self.metadata = replace(
            self.metadata,
            authoritative_total_frames=(
                self.metadata.timeline_start_frame + self.emitted_frames
            ),
            capture_extent_frames48=(
                self.emitted_frames
                if self.metadata.capture_source_base48 == 0
                and not self._capture_failed and self.emitted_frames <= 2**53 - 1
                else None
            ),
        )


class RetainedPcmDecoderProcess(PcmDecoderProcess):
    """Additive retained facade; it never invokes the ordinary constructor.

    Observation snapshots are local facts, not registry bindings or durable
    telemetry. Ordinary metadata semantics are preserved separately.
    """
    def __init__(self, command: PcmOpenCommand, admission) -> None:
        self.command = command
        self._admission = admission
        self._process = admission._process
        self.metadata = PcmStreamMetadata(
            generation=command.generation, stream_id=command.stream_id,
            role=command.role, sample_rate=command.sample_rate, channels=2,
            provisional_total_frames=round(
                command.provisional_duration_seconds * command.sample_rate),
            requested_start_frame=command.start_frame,
            timeline_start_frame=command.start_frame,
        )

    @classmethod
    async def start(cls, *args, **kwargs):
        raise RuntimeError("use_explicit_retained_admission")

    @property
    def lifecycle_id(self):
        return self._admission.lifecycle_id

    @property
    def emitted_frames(self):
        return self._admission.emitted_frames

    @property
    def outstanding_credit_frames(self):
        return self._admission.outstanding_credit_frames

    @property
    def stderr_tail(self):
        return self._admission.stderr_tail

    def grant_credit(self, frame_count: int) -> None:
        self._admission.grant_credit(frame_count)

    async def read_credited_frames(
        self, *, max_frames: int, delivery_role: PcmRole | None = None,
    ) -> PcmChunk:
        # No allocation after the admission's final PCM publication fence.
        # Retained display metadata is refreshed by finish, separately from
        # the local zero-start evidence candidate.
        return await self._admission.read_credited_frames(
            max_frames=max_frames, delivery_role=delivery_role, chunk_factory=PcmChunk)

    async def finish(self) -> PcmStreamMetadata:
        await self._admission.finish()
        self.metadata = replace(self.metadata, authoritative_total_frames=(
            self.metadata.timeline_start_frame + self.emitted_frames))
        return self.metadata

    async def cancel(self) -> None:
        await self._admission.cancel()

    def request_cancel(self) -> None:
        self._admission.request_cancel()

    def observation_snapshot(self, expected_lifecycle_id):
        return self._admission.observation_snapshot(expected_lifecycle_id)

    def mark_observation_lost(self, expected_lifecycle_id, reason):
        self._admission.mark_observation_lost(expected_lifecycle_id, reason)
