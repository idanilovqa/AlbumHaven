from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path
import struct
import subprocess
import wave

import pytest

from music_app.services.playback_pcm import (
    PcmDecoderProcess,
    PcmOpenCommand,
    PcmStreamMetadata,
    pack_pcm_frame,
)


SAMPLE_RATE = 48_000
BYTES_PER_STEREO_FRAME = 8


def open_command(path: Path = Path("fixture.wav"), **changes) -> PcmOpenCommand:
    command = PcmOpenCommand(
        generation=7,
        stream_id=41,
        role="current",
        path=path,
        start_frame=0,
        sample_rate=SAMPLE_RATE,
        provisional_duration_seconds=60.0,
    )
    return replace(command, **changes)


class FakeProcess:
    def __init__(self, *, stdout: bytes = b"", stderr: bytes = b"", returncode: int = 0):
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(stdout)
        self.stdout.feed_eof()
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_data(stderr)
        self.stderr.feed_eof()
        self.stdin = None
        self.returncode = None
        self._exit_code = returncode
        self.wait_calls = 0
        self.terminate_calls = 0

    async def wait(self) -> int:
        self.wait_calls += 1
        self.returncode = self._exit_code
        return self._exit_code

    def terminate(self) -> None:
        self.terminate_calls += 1
        self.returncode = self._exit_code


class FragmentingStream:
    def __init__(self, *fragments: bytes) -> None:
        self._fragments = list(fragments)
        self.read_sizes: list[int] = []

    async def read(self, size: int) -> bytes:
        self.read_sizes.append(size)
        if not self._fragments:
            return b""
        fragment = self._fragments.pop(0)
        if len(fragment) <= size:
            return fragment
        self._fragments.insert(0, fragment[size:])
        return fragment[:size]


def factory_for(process: FakeProcess, calls: list[tuple[tuple[object, ...], dict[str, object]]]):
    async def factory(*args, **kwargs):
        calls.append((args, kwargs))
        return process

    return factory


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"generation": -1}, "generation"),
        ({"stream_id": 0}, "stream_id"),
        ({"role": "next"}, "role"),
        ({"start_frame": -1}, "start_frame"),
        ({"sample_rate": 0}, "sample_rate"),
        ({"provisional_duration_seconds": -0.1}, "duration"),
    ],
)
def test_pcm_open_command_rejects_invalid_values(changes, message):
    with pytest.raises((TypeError, ValueError), match=message):
        open_command(**changes)


def test_pcm_open_command_normalizes_path_and_is_immutable(tmp_path):
    command = open_command(tmp_path / "song.wav")
    assert isinstance(command.path, Path)
    with pytest.raises((AttributeError, TypeError)):
        command.stream_id = 99


def test_pack_pcm_frame_uses_versioned_header_and_exact_payload():
    payload = struct.pack("<ffff", 0.25, -0.25, 0.5, -0.5)
    message = pack_pcm_frame(
        generation=7,
        stream_id=41,
        role="current",
        sequence=3,
        frame_count=2,
        pcm=payload,
    )

    assert len(message[:24]) == 24
    assert message[:4] == b"AHPC"
    assert struct.unpack(">BBHIIII", message[4:24]) == (1, 0, 0, 7, 41, 3, 2)
    assert message[24:] == payload


def test_pack_pcm_frame_rejects_payload_that_is_not_stereo_frame_aligned():
    with pytest.raises(ValueError, match="frame|align|payload"):
        pack_pcm_frame(
            generation=7,
            stream_id=41,
            role="current",
            sequence=0,
            frame_count=1,
            pcm=b"\0" * (BYTES_PER_STEREO_FRAME - 1),
        )


def test_decoder_builds_path_independent_accurate_seek_and_f32le_stereo_command(tmp_path):
    async def scenario() -> None:
        calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
        process = FakeProcess()
        source = tmp_path / "music with spaces.wav"
        decoder = await PcmDecoderProcess.start(
            open_command(source, start_frame=72_000),
            ffmpeg_executable="ffmpeg-test",
            process_factory=factory_for(process, calls),
        )
        await decoder.finish()

        args, kwargs = calls[0]
        assert args[0] == "ffmpeg-test"
        assert args[args.index("-i") + 1] == str(source)
        assert args.index("-ss") < args.index("-i")
        assert float(args[args.index("-ss") + 1]) == pytest.approx(1.5)
        assert args[args.index("-f") + 1] == "f32le"
        assert args[args.index("-acodec") + 1] == "pcm_f32le"
        assert args[args.index("-ac") + 1] == "2"
        assert args[args.index("-ar") + 1] == str(SAMPLE_RATE)
        assert args[-1] == "pipe:1"
        assert kwargs["stdout"] is asyncio.subprocess.PIPE
        assert kwargs["stderr"] is asyncio.subprocess.PIPE
        assert kwargs["stdin"] is asyncio.subprocess.DEVNULL
        assert "creationflags" in kwargs

    asyncio.run(scenario())


def test_decoder_uses_bounded_preroll_and_residual_seek_for_encoded_input(tmp_path):
    async def scenario() -> None:
        calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
        process = FakeProcess()
        source = tmp_path / "encoded.mp3"
        decoder = await PcmDecoderProcess.start(
            open_command(source, start_frame=72_000),
            ffmpeg_executable="ffmpeg-test",
            process_factory=factory_for(process, calls),
        )
        await decoder.finish()

        args, _kwargs = calls[0]
        input_index = args.index("-i")
        seek_indexes = [index for index, value in enumerate(args) if value == "-ss"]
        assert len(seek_indexes) == 2
        input_seek_index, residual_seek_index = seek_indexes
        input_seek_seconds = float(args[input_seek_index + 1])
        residual_seek_seconds = float(args[residual_seek_index + 1])
        assert input_seek_index < input_index < residual_seek_index
        assert input_seek_seconds == pytest.approx(1.5 - 0.25)
        assert input_seek_seconds > 0
        assert residual_seek_seconds == pytest.approx(0.25)
        assert 0 < residual_seek_seconds <= 0.25

    asyncio.run(scenario())


def test_decoder_never_reads_more_than_reserved_credit():
    async def scenario() -> None:
        calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
        process = FakeProcess(stdout=b"\0" * (1024 * BYTES_PER_STEREO_FRAME))
        decoder = await PcmDecoderProcess.start(
            open_command(),
            ffmpeg_executable="ffmpeg-test",
            process_factory=factory_for(process, calls),
        )
        decoder.grant_credit(256)
        chunk = await decoder.read_credited_frames(max_frames=1024)

        assert chunk.frame_count == 256
        assert len(chunk.pcm) == 256 * BYTES_PER_STEREO_FRAME
        assert decoder.outstanding_credit_frames == 0
        await decoder.cancel()

    asyncio.run(scenario())


def test_short_read_returns_only_complete_stereo_frames_and_restores_unused_credit():
    async def scenario() -> None:
        calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
        process = FakeProcess(stdout=b"x" * (3 * BYTES_PER_STEREO_FRAME))
        decoder = await PcmDecoderProcess.start(
            open_command(),
            ffmpeg_executable="ffmpeg-test",
            process_factory=factory_for(process, calls),
        )
        decoder.grant_credit(10)
        chunk = await decoder.read_credited_frames(max_frames=10)

        assert chunk.frame_count == 3
        assert len(chunk.pcm) == 3 * BYTES_PER_STEREO_FRAME
        assert decoder.outstanding_credit_frames == 7
        metadata = await decoder.finish()
        assert metadata.authoritative_total_frames == 3

    asyncio.run(scenario())


def test_continuity_read_coalesces_fragments_until_reserved_credit_is_filled():
    async def scenario() -> None:
        calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
        frames = [bytes([value]) * BYTES_PER_STEREO_FRAME for value in range(1, 5)]
        process = FakeProcess()
        process.stdout = FragmentingStream(*frames)
        decoder = await PcmDecoderProcess.start(
            open_command(role="continuity"),
            ffmpeg_executable="ffmpeg-test",
            process_factory=factory_for(process, calls),
        )
        decoder.grant_credit(4)

        chunk = await decoder.read_credited_frames(max_frames=4)

        assert chunk.frame_count == 4
        assert chunk.pcm == b"".join(frames)
        assert decoder.outstanding_credit_frames == 0
        assert process.stdout.read_sizes == [32, 24, 16, 8]
        await decoder.cancel()

    asyncio.run(scenario())


def test_current_read_returns_first_fragment_and_preserves_remaining_credit():
    async def scenario() -> None:
        calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
        frames = [bytes([value]) * BYTES_PER_STEREO_FRAME for value in range(1, 5)]
        process = FakeProcess()
        process.stdout = FragmentingStream(*frames)
        decoder = await PcmDecoderProcess.start(
            open_command(role="current"),
            ffmpeg_executable="ffmpeg-test",
            process_factory=factory_for(process, calls),
        )
        decoder.grant_credit(4)

        chunk = await decoder.read_credited_frames(max_frames=4)

        assert chunk.frame_count == 1
        assert chunk.pcm == frames[0]
        assert decoder.outstanding_credit_frames == 3
        assert process.stdout.read_sizes == [32]
        await decoder.cancel()

    asyncio.run(scenario())


def test_promoted_continuity_read_uses_current_delivery_role():
    async def scenario() -> None:
        calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
        frames = [bytes([value]) * BYTES_PER_STEREO_FRAME for value in range(1, 5)]
        process = FakeProcess()
        process.stdout = FragmentingStream(*frames)
        decoder = await PcmDecoderProcess.start(
            open_command(role="continuity"),
            ffmpeg_executable="ffmpeg-test",
            process_factory=factory_for(process, calls),
        )
        decoder.grant_credit(4)

        chunk = await decoder.read_credited_frames(
            max_frames=4,
            delivery_role="current",
        )

        assert chunk.frame_count == 1
        assert chunk.pcm == frames[0]
        assert decoder.outstanding_credit_frames == 3
        assert process.stdout.read_sizes == [32]
        await decoder.cancel()

    asyncio.run(scenario())


def test_decoder_drains_large_stderr_concurrently_and_caps_diagnostic_tail():
    async def scenario() -> None:
        calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
        stderr = b"prefix-marker\n" + b"z" * 200_000 + b"\ntail-marker"
        process = FakeProcess(stdout=b"\0" * BYTES_PER_STEREO_FRAME, stderr=stderr)
        decoder = await PcmDecoderProcess.start(
            open_command(),
            ffmpeg_executable="ffmpeg-test",
            process_factory=factory_for(process, calls),
        )
        decoder.grant_credit(1)
        assert (await decoder.read_credited_frames(max_frames=1)).frame_count == 1
        await decoder.finish()

        assert len(decoder.stderr_tail) <= 64 * 1024
        assert decoder.stderr_tail.endswith("tail-marker")
        assert "prefix-marker" not in decoder.stderr_tail

    asyncio.run(scenario())


def test_clean_eos_returns_authoritative_total_from_timeline_start():
    async def scenario() -> None:
        calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
        process = FakeProcess(stdout=b"\0" * (4 * BYTES_PER_STEREO_FRAME))
        decoder = await PcmDecoderProcess.start(
            open_command(start_frame=100),
            ffmpeg_executable="ffmpeg-test",
            process_factory=factory_for(process, calls),
        )
        decoder.grant_credit(20)
        chunk = await decoder.read_credited_frames(max_frames=20)
        assert chunk.frame_count == 4

        metadata = await decoder.finish()
        assert isinstance(metadata, PcmStreamMetadata)
        assert metadata.timeline_start_frame == 100
        assert metadata.authoritative_total_frames == 104
        assert process.wait_calls == 1

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("process", "message"),
    [
        (FakeProcess(stderr=b"decoder exploded", returncode=23), "decoder exploded"),
        (FakeProcess(stdout=b"partial", returncode=0), "truncated|align|partial"),
    ],
)
def test_decoder_rejects_nonzero_exit_and_truncated_pcm(process, message):
    async def scenario() -> None:
        calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
        decoder = await PcmDecoderProcess.start(
            open_command(),
            ffmpeg_executable="ffmpeg-test",
            process_factory=factory_for(process, calls),
        )
        decoder.grant_credit(5)
        with pytest.raises(RuntimeError, match=message):
            await decoder.read_credited_frames(max_frames=2)
        assert decoder.outstanding_credit_frames == 5

    asyncio.run(scenario())


def test_decoder_restores_reserved_credit_once_when_stdout_read_fails():
    class FailingStream:
        async def read(self, _size: int) -> bytes:
            raise OSError("stdout read failed")

    async def scenario() -> None:
        calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
        process = FakeProcess()
        process.stdout = FailingStream()
        decoder = await PcmDecoderProcess.start(
            open_command(),
            ffmpeg_executable="ffmpeg-test",
            process_factory=factory_for(process, calls),
        )
        decoder.grant_credit(5)

        with pytest.raises(OSError, match="stdout read failed"):
            await decoder.read_credited_frames(max_frames=2)
        assert decoder.outstanding_credit_frames == 5
        await decoder.cancel()

    asyncio.run(scenario())


def test_cancel_terminates_and_waits_for_the_exact_started_process():
    class DrainObservedStream(asyncio.StreamReader):
        def __init__(self, drained: asyncio.Event) -> None:
            super().__init__()
            self._drained = drained

        async def read(self, n: int = -1) -> bytes:
            data = await super().read(n)
            if not data:
                self._drained.set()
            return data

    class StdoutDrainRequiredProcess(FakeProcess):
        def __init__(self) -> None:
            super().__init__()
            self.stdout_drained = asyncio.Event()
            self.wait_entered = asyncio.Event()
            self.stdout = DrainObservedStream(self.stdout_drained)
            self.stdout.feed_data(b"unread-pcm")
            self.stdout.feed_eof()

        async def wait(self) -> int:
            self.wait_calls += 1
            self.wait_entered.set()
            await asyncio.wait_for(self.stdout_drained.wait(), timeout=1)
            self.returncode = self._exit_code
            return self._exit_code

    async def scenario() -> None:
        calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
        started = StdoutDrainRequiredProcess()
        unrelated = FakeProcess()
        decoder = await PcmDecoderProcess.start(
            open_command(),
            ffmpeg_executable="ffmpeg-test",
            process_factory=factory_for(started, calls),
        )

        await decoder.cancel()
        await decoder.cancel()

        assert started.stdout.at_eof() is True
        assert started.wait_entered.is_set() is True
        assert started.stdout_drained.is_set() is True
        assert started.terminate_calls == 1
        assert started.wait_calls == 1
        assert decoder._stderr_task.done() is True
        await decoder._stderr_task
        assert unrelated.terminate_calls == 0
        assert unrelated.wait_calls == 0

    asyncio.run(scenario())


def test_cancel_retries_the_exact_failed_wait_instead_of_reporting_false_success():
    class FailingWaitProcess(FakeProcess):
        async def wait(self) -> int:
            self.wait_calls += 1
            raise RuntimeError("process wait failed")

    async def scenario() -> None:
        calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
        process = FailingWaitProcess()
        decoder = await PcmDecoderProcess.start(
            open_command(),
            ffmpeg_executable="ffmpeg-test",
            process_factory=factory_for(process, calls),
        )

        with pytest.raises(RuntimeError, match="process wait failed"):
            await decoder.cancel()
        failed_wait_task = decoder._wait_task
        assert failed_wait_task is not None

        with pytest.raises(RuntimeError, match="process wait failed"):
            await decoder.cancel()

        assert decoder._wait_task is failed_wait_task
        assert process.terminate_calls == 1
        assert process.wait_calls == 1
        await decoder._stderr_task

    asyncio.run(scenario())


def _write_seek_fixture(path: Path, *, frames: int = 9_600) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        for frame in range(frames):
            sample = 12_000 if frame >= frames // 2 else 0
            output.writeframesraw(struct.pack("<hh", sample, sample))


def _decode_fixture(path: Path, *, start_frame: int, frames: int):
    async def scenario():
        decoder = await PcmDecoderProcess.start(open_command(path, start_frame=start_frame))
        decoder.grant_credit(frames)
        pcm = bytearray()
        try:
            while decoder.outstanding_credit_frames > 0:
                chunk = await decoder.read_credited_frames(
                    max_frames=decoder.outstanding_credit_frames
                )
                if chunk.frame_count == 0:
                    break
                pcm.extend(chunk.pcm)
        finally:
            await decoder.cancel()
        return struct.unpack(f"<{len(pcm) // 4}f", pcm)

    return asyncio.run(scenario())


def test_lossless_seek_starts_at_the_requested_generated_sentinel(tmp_path):
    source = tmp_path / "sentinel.wav"
    _write_seek_fixture(source)

    samples = _decode_fixture(source, start_frame=4_800, frames=8)

    assert len(samples) == 16
    assert all(sample == pytest.approx(12_000 / 32_768, abs=0.002) for sample in samples)


def test_vbr_seek_is_codec_tolerant_around_requested_sentinel(tmp_path):
    imageio_ffmpeg = pytest.importorskip("imageio_ffmpeg")
    source = tmp_path / "sentinel.wav"
    encoded = tmp_path / "sentinel-vbr.mp3"
    _write_seek_fixture(source, frames=48_000)
    result = subprocess.run(
        [
            imageio_ffmpeg.get_ffmpeg_exe(),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-codec:a",
            "libmp3lame",
            "-q:a",
            "4",
            str(encoded),
        ],
        capture_output=True,
        check=False,
    )
    if result.returncode:
        pytest.skip(f"bundled FFmpeg cannot encode MP3: {result.stderr.decode(errors='replace')}")

    samples = _decode_fixture(encoded, start_frame=24_000, frames=256)
    average = sum(samples) / len(samples)

    assert len(samples) == 512
    assert average == pytest.approx(12_000 / 32_768, abs=0.08)
