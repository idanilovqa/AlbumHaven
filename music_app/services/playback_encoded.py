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
from music_app.services.mp3_stream_map import mp3_stream_map
from music_app.services.playback_pcm import (
    PcmChunk,
    PcmOpenCommand,
    PcmRole,
    PcmStreamMetadata,
)


Codec = Literal["mp3", "flac"]
Quality = Literal["original", "320"]
MAX_ENCODED_CHUNK_BYTES = 64 * 1024
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
    ) -> None:
        self.command = command
        self.codec = codec
        self.skip_frames = skip_frames
        self.total_frames = total_frames
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

    def _read_file(self, byte_count: int) -> bytes:
        # Library drives can be slow, so even opening stays off the event loop.
        self._file = self._file or self.command.path.open("rb")
        self._file.seek(self._position)
        return self._file.read(min(byte_count, self._end_byte - self._position))

    async def _read(self, byte_count: int) -> bytes:
        if self._prefix:
            data, self._prefix = self._prefix[:byte_count], self._prefix[byte_count:]
            return data
        data = await asyncio.to_thread(self._read_file, byte_count)
        self._position += len(data)
        return data

    async def finish(self) -> PcmStreamMetadata:
        await self.cancel()
        return await super().finish()

    async def cancel(self) -> None:
        if self._file is not None:
            self._file.close()
            self._file = None


class _ProcessByteStream(EncodedStream):
    def __init__(
        self,
        command: PcmOpenCommand,
        process: asyncio.subprocess.Process,
        **stream: object,
    ) -> None:
        super().__init__(command, **stream)
        self._process = process

    async def _read(self, byte_count: int) -> bytes:
        return await self._process.stdout.read(byte_count)

    async def finish(self) -> PcmStreamMetadata:
        if await self._process.wait() != 0:
            raise RuntimeError(f"ffmpeg exited with code {self._process.returncode}")
        return await super().finish()

    async def cancel(self) -> None:
        if self._process.returncode is None:
            self._process.terminate()
            while await self._process.stdout.read(MAX_ENCODED_CHUNK_BYTES):
                pass
        await self._process.wait()


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


async def _start_process(executable: str, *arguments: str) -> asyncio.subprocess.Process:
    return await asyncio.create_subprocess_exec(
        executable,
        "-hide_banner",
        "-loglevel",
        "error",
        *arguments,
        "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        stdin=asyncio.subprocess.DEVNULL,
        creationflags=hidden_subprocess_creation_flags(),
    )


async def _open_flac(command: PcmOpenCommand, quality: Quality) -> EncodedStream | None:
    layout = await asyncio.to_thread(read_flac_layout, command.path)
    if layout is None:
        return None
    header, first_audio_byte, end_byte, native_rate, native_samples = layout
    executable = resolve_ffmpeg_executable()
    if quality == "320":
        output_rate = fallback_sample_rate(native_rate)
        if command.sample_rate != output_rate:
            raise ValueError("sample_rate does not match the 320 kbps stream rate")
        total_frames = round(native_samples * output_rate / native_rate) - command.start_frame
        process = await _start_process(
            executable,
            "-ss", f"{command.start_frame / output_rate:.9f}",
            "-i", str(command.path),
            "-vn", "-ac", "2", "-ar", str(output_rate),
            "-c:a", "libmp3lame", "-b:a", "320k",
            "-write_xing", "0", "-id3v2_version", "0",
            "-f", "mp3",
        )
        return _ProcessByteStream(
            command,
            process,
            codec="mp3",
            skip_frames=_LAME_ENCODER_START_SAMPLES,
            total_frames=total_frames,
        )
    if command.sample_rate != native_rate:
        raise ValueError("sample_rate does not match the file's native rate")
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
        )
    # FLAC is lossless, so re-framing from the exact sample keeps every source sample.
    process = await _start_process(
        executable,
        "-ss", f"{command.start_frame / native_rate:.9f}",
        "-i", str(command.path),
        "-vn", "-map_metadata", "-1", "-c:a", "flac", "-f", "flac",
    )
    return _ProcessByteStream(
        command,
        process,
        codec="flac",
        skip_frames=0,
        total_frames=total_frames,
    )


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
        raise ValueError("sample_rate does not match the file's native rate")
    window = stream_map.window(command.start_frame)
    return _FileByteStream(
        command,
        start_byte=window.start_byte,
        end_byte=window.end_byte,
        codec="mp3",
        skip_frames=window.skip_frames,
        total_frames=window.total_frames,
    )
