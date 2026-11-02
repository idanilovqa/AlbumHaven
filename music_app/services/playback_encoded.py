"""Stream encoded audio plus the exact samples a client must keep from it."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path
from typing import BinaryIO, Literal

from music_app.services.ffmpeg_runtime import (
    hidden_subprocess_creation_flags,
    resolve_ffmpeg_executable,
)
from music_app.services.playback_rate_observation import RateCaptureFacts
from music_app.services.mp3_stream_map import mp3_stream_map
from music_app.services.playback_pcm import (
    PcmChunk,
    PcmOpenCommand,
    PcmRole,
    PcmStreamMetadata,
    SampleRateMismatch,
)


Codec = Literal["mp3", "flac"]
Quality = Literal["original", "320"]
MAX_ENCODED_CHUNK_BYTES = 16 * 1024
# Sent with no request, so starts and seeks do not wait a round trip for first audio.
INITIAL_ENCODED_CREDIT_BYTES = 64 * 1024
MAX_ENCODED_CREDIT_BYTES = 1024 * 1024
_LAME_ENCODER_START_SAMPLES = 1105
_MP3_MAX_SAMPLE_RATE = 48_000
_FLAC_MAGIC = b"fLaC"
_FLAC_STREAMINFO_BYTES = 34


def fallback_sample_rate(native_rate: int) -> int:
    """MP3 stops at 48 kHz, so higher rates fall to the nearest rate of their family."""
    if native_rate <= _MP3_MAX_SAMPLE_RATE:
        return native_rate
    return 44_100 if native_rate % 44_100 == 0 else _MP3_MAX_SAMPLE_RATE


class EncodedStream:
    """Same credit interface as PcmDecoderProcess, counted in bytes instead of frames."""

    max_outstanding_credit = MAX_ENCODED_CREDIT_BYTES

    def __init__(
        self,
        command: PcmOpenCommand,
        *,
        codec: Codec,
        skip_frames: int,
        total_frames: int,
        rate_capture_facts: RateCaptureFacts | None = None,
    ) -> None:
        self.command = command
        self.codec = codec
        self.skip_frames = skip_frames
        self.total_frames = total_frames
        self.rate_capture_facts = rate_capture_facts
        self.outstanding_credit_frames = 0
        self.metadata = PcmStreamMetadata(
            generation=command.generation,
            stream_id=command.stream_id,
            role=command.role,
            sample_rate=command.sample_rate,
            channels=2,
            provisional_total_frames=command.start_frame + total_frames,
            requested_start_frame=command.start_frame,
            timeline_start_frame=command.start_frame,
        )

    @property
    def emitted_frames(self) -> int:
        return self.total_frames

    def grant_credit(self, frame_count: int) -> None:
        self.outstanding_credit_frames += frame_count

    async def _read(self, byte_count: int) -> bytes:
        raise NotImplementedError

    async def read_credited_frames(
        self,
        *,
        max_frames: int,
        delivery_role: PcmRole | None = None,
    ) -> PcmChunk:
        data = await self._read(min(max_frames, MAX_ENCODED_CHUNK_BYTES))
        self.outstanding_credit_frames -= len(data)
        return PcmChunk(frame_count=len(data), pcm=data)

    async def finish(self) -> PcmStreamMetadata:
        self.metadata = replace(
            self.metadata,
            authoritative_total_frames=self.command.start_frame + self.total_frames,
        )
        return self.metadata

    async def cancel(self) -> None:
        raise NotImplementedError


class _FileByteStream(EncodedStream):
    def __init__(
        self,
        command: PcmOpenCommand,
        *,
        prefix: bytes = b"",
        start_byte: int,
        end_byte: int,
        **stream: object,
    ) -> None:
        super().__init__(command, **stream)
        self._prefix = prefix
        self._position = start_byte
        self._end_byte = end_byte
        self._file: BinaryIO | None = None
        self._io_task: asyncio.Task[bytes] | None = None
        self._cleanup_task: asyncio.Task[None] | None = None
        self._cancelled = False

    def _read_file(self, byte_count: int) -> bytes:
        # Library drives can be slow, so even opening stays off the event loop.
        self._file = self._file or self.command.path.open("rb")
        self._file.seek(self._position)
        return self._file.read(min(byte_count, self._end_byte - self._position))

    async def _read(self, byte_count: int) -> bytes:
        if self._cancelled:
            raise RuntimeError("Encoded file stream was cancelled")
        if self._io_task is not None:
            raise RuntimeError("Encoded file read is still owned")
        if self._prefix:
            data, self._prefix = self._prefix[:byte_count], self._prefix[byte_count:]
            return data
        self._io_task = asyncio.create_task(asyncio.to_thread(self._read_file, byte_count))
        # Cancelling the credit waiter cannot stop the underlying file worker.
        # Keep its task retained until physical completion, including late open.
        data = await asyncio.shield(self._io_task)
        self._io_task = None
        if self._cancelled:
            raise RuntimeError("Encoded file stream was cancelled")
        self._position += len(data)
        return data

    async def finish(self) -> PcmStreamMetadata:
        await self.cancel()
        return await super().finish()

    async def cancel(self) -> None:
        self._cancelled = True
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._close_after_io())
        await asyncio.shield(self._cleanup_task)

    async def _close_after_io(self) -> None:
        if self._io_task is not None:
            try:
                await asyncio.shield(self._io_task)
            except Exception:
                # A failed read has physically settled; its opened file still
                # belongs to this stream and must be closed before slot release.
                pass
            self._io_task = None
        if self._file is not None:
            self._file.close()
            self._file = None


class _ProcessByteStream(EncodedStream):
    def __init__(
        self,
        command: PcmOpenCommand,
        process: asyncio.subprocess.Process,
        seek_origin=None,
        **stream: object,
    ) -> None:
        super().__init__(command, **stream)
        self._process = process
        self._seek_origin = seek_origin
        self.rate_capture_requires_origin = seek_origin is not None
        self._stderr_task = (asyncio.create_task(self._drain_origin())
                             if seek_origin is not None else None)

    @property
    def rate_capture_origin_confirmed(self):
        return self._seek_origin is not None and self._seek_origin.confirmed

    async def _drain_origin(self):
        # Drain even after proof is unavailable so stderr cannot block audio.
        # This task is owned until the same decoder process actually exits.
        try:
            while chunk := await self._process.stderr.read(8192):
                self._seek_origin.feed(chunk)
        except Exception:
            self._seek_origin.available = False
            self._seek_origin.confirmed = False

    async def _join_origin(self):
        if self._stderr_task is not None:
            await asyncio.shield(self._stderr_task)

    async def _read(self, byte_count: int) -> bytes:
        return await self._process.stdout.read(byte_count)

    async def finish(self) -> PcmStreamMetadata:
        status = await self._process.wait()
        await self._join_origin()
        if status != 0:
            raise RuntimeError(f"ffmpeg exited with code {self._process.returncode}")
        return await super().finish()

    async def cancel(self) -> None:
        if self._process.returncode is None:
            self._process.terminate()
            while await self._process.stdout.read(MAX_ENCODED_CHUNK_BYTES):
                pass
        await self._process.wait()
        await self._join_origin()


def read_flac_layout(path: Path) -> tuple[bytes, int, int, int, int] | None:
    """Return (minimal header, first audio byte, end byte, sample rate, total samples)."""
    try:
        with path.open("rb") as source:
            if source.read(4) != _FLAC_MAGIC:
                return None
            streaminfo = None
            while True:
                header = source.read(4)
                if len(header) != 4:
                    return None
                block_type = header[0] & 0x7f
                block_bytes = int.from_bytes(header[1:], "big")
                if block_type == 0 and block_bytes == _FLAC_STREAMINFO_BYTES:
                    streaminfo = source.read(block_bytes)
                else:
                    source.seek(block_bytes, 1)
                if header[0] & 0x80:
                    break
            first_audio_byte = source.tell()
            end_byte = source.seek(0, 2)
    except OSError:
        return None
    if streaminfo is None or len(streaminfo) != _FLAC_STREAMINFO_BYTES:
        return None
    packed = int.from_bytes(streaminfo[10:18], "big")
    sample_rate = packed >> 44
    total_samples = packed & ((1 << 36) - 1)
    if not sample_rate or not total_samples:
        return None
    # Cover art never travels with the audio: only STREAMINFO precedes the first frame.
    header = _FLAC_MAGIC + b"\x80" + _FLAC_STREAMINFO_BYTES.to_bytes(3, "big") + streaminfo
    return header, first_audio_byte, end_byte, sample_rate, total_samples


async def _start_process(executable: str, *arguments: str, observe_origin=False) -> asyncio.subprocess.Process:
    return await asyncio.create_subprocess_exec(
        executable,
        "-hide_banner",
        "-loglevel",
        "info" if observe_origin else "error",
        *arguments,
        "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE if observe_origin else asyncio.subprocess.DEVNULL,
        stdin=asyncio.subprocess.DEVNULL,
        creationflags=hidden_subprocess_creation_flags(),
    )


async def _open_flac(command: PcmOpenCommand, quality: Quality) -> EncodedStream | None:
    layout = await asyncio.to_thread(read_flac_layout, command.path)
    if layout is None:
        return None
    header, first_audio_byte, end_byte, native_rate, native_samples = layout
    executable = resolve_ffmpeg_executable()
    # Source PTS is measured in the native sample grid. Neither filter changes
    # sample values or rate; -ss and the original encoding/trim stay unchanged.
    observe_seek = command.start_frame > 0
    origin_arguments = (("-copyts",) if observe_seek else ())
    origin_filter = (("-af", f"asettb=expr=1/{native_rate},ashowinfo")
                     if observe_seek else ())
    if quality == "320":
        output_rate = fallback_sample_rate(native_rate)
        if command.sample_rate != output_rate:
            raise ValueError("sample_rate does not match the 320 kbps stream rate")
        total_frames = round(native_samples * output_rate / native_rate) - command.start_frame
        process = await _start_process(
            executable,
            *origin_arguments,
            "-ss", f"{command.start_frame / output_rate:.9f}",
            "-i", str(command.path),
            *origin_filter,
            "-vn", "-ac", "2", "-ar", str(output_rate),
            "-c:a", "libmp3lame", "-b:a", "320k",
            "-write_xing", "0", "-id3v2_version", "0",
            "-f", "mp3",
            observe_origin=observe_seek,
        )
        return _ProcessByteStream(
            command,
            process,
            codec="mp3",
            skip_frames=_LAME_ENCODER_START_SAMPLES,
            total_frames=total_frames,
            rate_capture_facts=RateCaptureFacts(output_rate, native_rate,
                command.start_frame, total_frames, native_samples),
            seek_origin=(_seek_origin(native_rate, output_rate, command.start_frame)
                         if observe_seek else None),
        )
    if command.sample_rate != native_rate:
        raise SampleRateMismatch(native_rate)
    total_frames = native_samples - command.start_frame
    if command.start_frame == 0:
        return _FileByteStream(
            command,
            prefix=header,
            start_byte=first_audio_byte,
            end_byte=end_byte,
            codec="flac",
            skip_frames=0,
            total_frames=total_frames,
            rate_capture_facts=RateCaptureFacts(native_rate, native_rate, 0,
                total_frames, native_samples),
        )
    # FLAC is lossless, so re-framing from the exact sample keeps every source sample.
    process = await _start_process(
        executable,
        *origin_arguments,
        "-ss", f"{command.start_frame / native_rate:.9f}",
        "-i", str(command.path),
        *origin_filter,
        "-vn", "-map_metadata", "-1", "-c:a", "flac", "-f", "flac",
        observe_origin=True,
    )
    return _ProcessByteStream(
        command,
        process,
        codec="flac",
        skip_frames=0,
        total_frames=total_frames,
        rate_capture_facts=RateCaptureFacts(native_rate, native_rate,
            command.start_frame, total_frames, native_samples),
        seek_origin=_seek_origin(native_rate, native_rate, command.start_frame),
    )


def _seek_origin(source_rate, coordinate_rate, start_frame):
    from music_app.services.playback_encoded_seek_observation import EncodedSeekOrigin
    return EncodedSeekOrigin(source_rate=source_rate,
        coordinate_rate=coordinate_rate, start_frame=start_frame)


async def open_encoded_stream(
    command: PcmOpenCommand,
    *,
    codecs: frozenset[str],
    quality: Quality,
) -> EncodedStream | None:
    """Open the file's own encoded form, or None when it must be decoded here."""
    suffix = command.path.suffix.lower()
    if suffix == ".flac" and ("mp3" if quality == "320" else "flac") in codecs:
        return await _open_flac(command, quality)
    if suffix != ".mp3" or "mp3" not in codecs:
        return None
    stream_map = await asyncio.to_thread(mp3_stream_map, command.path)
    if stream_map is None:
        return None
    if command.sample_rate != stream_map.sample_rate:
        raise SampleRateMismatch(stream_map.sample_rate)
    window = stream_map.window(command.start_frame)
    return _FileByteStream(
        command,
        start_byte=window.start_byte,
        end_byte=window.end_byte,
        codec="mp3",
        skip_frames=window.skip_frames,
        total_frames=window.total_frames,
        rate_capture_facts=RateCaptureFacts(stream_map.sample_rate,
            stream_map.sample_rate, min(command.start_frame, stream_map.total_frames),
            window.total_frames, stream_map.total_frames),
    )
