from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
import math
from pathlib import Path
import struct
from typing import Awaitable, Callable, Literal

from music_app.services.ffmpeg_runtime import (
    hidden_subprocess_creation_flags,
    resolve_ffmpeg_executable,
)


PcmRole = Literal["current", "continuity"]
_BYTES_PER_STEREO_FRAME = 8
_STDERR_TAIL_LIMIT = 64 * 1024
_ENCODED_SEEK_PREROLL_SECONDS = 0.25
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

    def __post_init__(self) -> None:
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


@dataclass(frozen=True, slots=True)
class PcmChunk:
    frame_count: int
    pcm: bytes


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
        process: asyncio.subprocess.Process,
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
        )
        self.outstanding_credit_frames = 0
        self.emitted_frames = 0
        self.stderr_tail = ""
        self._stderr_bytes = bytearray()
        self._stderr_task = asyncio.create_task(self._drain_stderr())
        self._stdout_discard_task: asyncio.Task[None] | None = None
        self._wait_task: asyncio.Task[int] | None = None
        self._cancel_lock = asyncio.Lock()
        self._cancelled = False
        self._eos = False

    @classmethod
    async def start(
        cls,
        command: PcmOpenCommand,
        *,
        ffmpeg_executable: str | None = None,
        process_factory: ProcessFactory = asyncio.create_subprocess_exec,
    ) -> "PcmDecoderProcess":
        executable = ffmpeg_executable or resolve_ffmpeg_executable()
        if not executable:
            raise RuntimeError("ffmpeg was not found")

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

        process = await process_factory(
            executable,
            "-hide_banner",
            "-loglevel",
            "error",
            *input_seek,
            "-i",
            str(command.path),
            *output_seek,
            "-vn",
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
            stdin=asyncio.subprocess.DEVNULL,
            creationflags=hidden_subprocess_creation_flags(),
        )
        if process.stdout is None or process.stderr is None:
            if process.returncode is None:
                process.terminate()
            await process.wait()
            raise RuntimeError("ffmpeg subprocess did not provide output pipes")
        return cls(command, process)

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
            data = bytearray(await self._process.stdout.read(reservation_bytes))
            if not data:
                await self._complete_eos()
                self.outstanding_credit_frames += reservation
                return PcmChunk(frame_count=0, pcm=b"")

            effective_role = self.command.role if delivery_role is None else delivery_role
            if effective_role == "continuity":
                while len(data) < reservation_bytes:
                    fragment = await self._process.stdout.read(
                        reservation_bytes - len(data)
                    )
                    if not fragment:
                        break
                    data.extend(fragment)

            while len(data) % _BYTES_PER_STEREO_FRAME:
                needed = _BYTES_PER_STEREO_FRAME - (
                    len(data) % _BYTES_PER_STEREO_FRAME
                )
                extra = await self._process.stdout.read(needed)
                if not extra:
                    await self._wait_for_exit()
                    await self._finish_stderr()
                    raise RuntimeError("ffmpeg returned truncated partial PCM frame")
                data += extra

            frame_count = len(data) // _BYTES_PER_STEREO_FRAME
            self.outstanding_credit_frames += reservation - frame_count
            self.emitted_frames += frame_count
            return PcmChunk(frame_count=frame_count, pcm=bytes(data))
        except BaseException:
            self.outstanding_credit_frames += reservation
            raise

    async def finish(self) -> PcmStreamMetadata:
        if self._cancelled:
            raise RuntimeError("PCM decoder was cancelled")
        if not self._process.stdout.at_eof():
            raise RuntimeError("cannot finish PCM decoder before stdout reaches end-of-stream")
        await self._complete_eos()
        return self.metadata

    async def cancel(self) -> None:
        async with self._cancel_lock:
            if not self._cancelled:
                self._cancelled = True
                if self._process.returncode is None:
                    self._process.terminate()
                self._stdout_discard_task = asyncio.create_task(self._discard_stdout())

            wait_error: Exception | asyncio.CancelledError | None = None
            try:
                await self._wait_for_exit()
            except (Exception, asyncio.CancelledError) as error:
                wait_error = error
            try:
                if self._stdout_discard_task is not None:
                    await asyncio.shield(self._stdout_discard_task)
            except (Exception, asyncio.CancelledError) as error:
                if wait_error is None:
                    wait_error = error
            try:
                await self._finish_stderr()
            except (Exception, asyncio.CancelledError):
                if wait_error is None:
                    raise
            if wait_error is not None:
                raise wait_error

    async def _discard_stdout(self) -> None:
        try:
            while await self._process.stdout.read(64 * 1024):
                pass
        except Exception:
            # Cancellation cleanup remains best-effort after a prior stdout failure.
            pass

    async def _drain_stderr(self) -> None:
        while True:
            chunk = await self._process.stderr.read(8192)
            if not chunk:
                break
            self._stderr_bytes.extend(chunk)
            if len(self._stderr_bytes) > _STDERR_TAIL_LIMIT:
                del self._stderr_bytes[:-_STDERR_TAIL_LIMIT]

    async def _wait_for_exit(self) -> int:
        if self._wait_task is None:
            self._wait_task = asyncio.create_task(self._process.wait())
        return await asyncio.shield(self._wait_task)

    async def _finish_stderr(self) -> None:
        await self._stderr_task
        self.stderr_tail = self._stderr_bytes.decode(errors="replace")

    async def _complete_eos(self) -> None:
        if self._eos:
            return
        return_code = await self._wait_for_exit()
        await self._finish_stderr()
        if return_code != 0:
            diagnostic = self.stderr_tail.strip()
            detail = f": {diagnostic}" if diagnostic else ""
            raise RuntimeError(f"ffmpeg exited with code {return_code}{detail}")
        self._eos = True
        self.metadata = replace(
            self.metadata,
            authoritative_total_frames=(
                self.metadata.timeline_start_frame + self.emitted_frames
            ),
        )
