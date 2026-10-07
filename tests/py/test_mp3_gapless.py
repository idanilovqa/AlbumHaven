from __future__ import annotations

import array
import asyncio
import math
import subprocess
import wave
from pathlib import Path

import pytest

from music_app.services.ffmpeg_runtime import resolve_ffmpeg_executable
from music_app.services.playback_pcm import PcmDecoderProcess, PcmOpenCommand


def _tag_crc(payload: bytes) -> int:
    crc = 0
    for value in payload:
        crc ^= value << 8
        for _ in range(8):
            crc = ((crc << 1) ^ (0x8005 if crc & 0x8000 else 0)) & 0xffff
    return crc


@pytest.fixture(scope="module")
def encoded_gapless_pair(tmp_path_factory):
    directory = tmp_path_factory.mktemp("mp3-gapless")
    executable = resolve_ffmpeg_executable()
    assert executable, "The supported playback runtime requires FFmpeg"
    source = directory / "intentional-silence.wav"
    samples = array.array("h")
    for frame in range(132300):
        sample = 0 if frame < 2205 or frame >= 130095 else round(
            12000 * math.sin(frame * 2 * math.pi * 443 / 44100)
            + 3000 * math.sin(frame * 2 * math.pi * 137 / 44100)
        )
        samples.extend((sample, -sample))
    with wave.open(str(source), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(44100)
        output.writeframes(samples.tobytes())
    encoded = directory / "encoded.mp3"
    subprocess.run([
        executable, "-v", "error", "-i", str(source), "-c:a", "libmp3lame",
        "-q:a", "4", str(encoded),
    ], capture_output=True, check=True)
    data = bytearray(encoded.read_bytes())
    audio_offset = 0
    if data[:3] == b"ID3":
        audio_offset = 10 + sum(value << shift for value, shift in zip(data[6:10], (21, 14, 7, 0)))
    marker = next(offset for offset in range(audio_offset, audio_offset + 192)
                  if data[offset:offset + 4] in (b"Xing", b"Info"))
    flags = int.from_bytes(data[marker + 4:marker + 8], "big")
    tag = marker + 8 + sum(size for bit, size in ((1, 4), (2, 4), (4, 100), (8, 4)) if flags & bit)
    files = {}
    for name, encoder in (("recognized", b"LAME3.100"), ("mixed_case", b"Lame3.100")):
        variant = bytearray(data)
        variant[tag:tag + 9] = encoder
        variant[tag + 34:tag + 36] = _tag_crc(variant[audio_offset:tag + 34]).to_bytes(2, "big")
        files[name] = directory / f"{name}.mp3"
        files[name].write_bytes(variant)
    return files


def _decode(path: Path, *, sample_rate: int, start_frame: int):
    async def run():
        decoder = await PcmDecoderProcess.start(PcmOpenCommand(
            generation=1, stream_id=1, role="current", path=path,
            start_frame=start_frame, sample_rate=sample_rate,
            provisional_duration_seconds=3.1,
        ))
        samples = array.array("f")
        try:
            decoder.grant_credit(sample_rate * 4)
            while True:
                chunk = await decoder.read_credited_frames(max_frames=4096)
                if not chunk.frame_count:
                    metadata = await decoder.finish()
                    break
                samples.frombytes(chunk.pcm)
            return samples, metadata
        finally:
            await decoder.cancel()
    return asyncio.run(run())


@pytest.mark.parametrize("sample_rate", [44100, 48000])
@pytest.mark.parametrize("position", [0, 1.25, 2.9])
def test_mixed_case_gapless_tag_matches_native_decoder_without_removing_intentional_silence(
    encoded_gapless_pair, sample_rate, position,
):
    start_frame = round(position * sample_rate)
    expected, reference_metadata = _decode(encoded_gapless_pair["recognized"],
                                         sample_rate=sample_rate, start_frame=start_frame)
    actual, metadata = _decode(encoded_gapless_pair["mixed_case"],
                              sample_rate=sample_rate, start_frame=start_frame)
    assert len(actual) == len(expected)
    assert metadata.authoritative_total_frames == reference_metadata.authoritative_total_frames
    assert max(abs(left - right) for left, right in zip(actual, expected)) < 0.00001
    if position == 0:
        assert len(actual) // 2 == sample_rate * 3
        quiet_frames = round(.025 * sample_rate)
        assert max(abs(value) for value in actual[:quiet_frames * 2]) < 0.0001
        assert max(abs(value) for value in actual[-quiet_frames * 2:]) < 0.0001


def test_waveform_uses_the_same_gapless_sample_origin_and_duration(encoded_gapless_pair):
    from music_app.services.waveform_peaks import _audio_duration_seconds, build_waveform_peaks

    async def run():
        expected = await build_waveform_peaks(encoded_gapless_pair["recognized"], bins=120, cancel_event=asyncio.Event())
        actual = await build_waveform_peaks(encoded_gapless_pair["mixed_case"], bins=120, cancel_event=asyncio.Event())
        assert actual == expected
    assert _audio_duration_seconds(encoded_gapless_pair["mixed_case"]) == pytest.approx(3)
    asyncio.run(run())


@pytest.mark.parametrize(("delay", "padding"), [(0, 0), (576, 100), (576, 529), (576, 1440)])
def test_padding_and_crc_follow_native_decoder_semantics(encoded_gapless_pair, tmp_path, delay, padding):
    data = bytearray(encoded_gapless_pair["mixed_case"].read_bytes())
    tag = data.index(b"Lame3.100")
    data[tag + 21:tag + 24] = ((delay << 12) | padding).to_bytes(3, "big")
    data[tag + 34:tag + 36] = b"\x00\x00"  # Native FFmpeg accepts a mismatched tag CRC.
    mixed = tmp_path / "mixed.mp3"
    mixed.write_bytes(data)
    data[tag:tag + 4] = b"LAME"
    recognized = tmp_path / "recognized.mp3"
    recognized.write_bytes(data)
    actual, metadata = _decode(mixed, sample_rate=48000, start_frame=0)
    expected, reference = _decode(recognized, sample_rate=48000, start_frame=0)
    assert len(actual) == len(expected)
    assert metadata.authoritative_total_frames == reference.authoritative_total_frames
    assert max(abs(left - right) for left, right in zip(actual, expected)) < .00001


@pytest.mark.parametrize("damage", ["sync", "flags", "count", "truncated", "encoder"])
def test_invalid_headers_cannot_trigger_sample_trimming(encoded_gapless_pair, tmp_path, damage):
    from music_app.services.mp3_gapless import read_mp3_gapless_info

    data = bytearray(encoded_gapless_pair["mixed_case"].read_bytes())
    marker = data.index(b"Xing")
    if damage == "sync":
        data[marker - 36] = 0
    elif damage == "flags":
        data[marker + 4:marker + 8] = (65535).to_bytes(4, "big")
    elif damage == "count":
        data[marker + 8:marker + 12] = (0xffffffff).to_bytes(4, "big")
    elif damage == "encoder":
        tag = data.index(b"Lame3.100")
        data[tag:tag + 4] = b"Junk"
    else:
        data = data[:marker + 9]
    path = tmp_path / "invalid.mp3"
    path.write_bytes(data)
    assert read_mp3_gapless_info(path) is None


def test_probe_reads_through_fragmented_headers_and_avoids_double_trimming(monkeypatch):
    from music_app.services import mp3_gapless

    async def run():
        class Process:
            returncode = None
            stdout = asyncio.StreamReader()
            async def wait(self):
                self.returncode = 0
                return 0
        process = Process()
        async def launch(*_args, **_kwargs):
            process.stdout.feed_data(b"#codec_id 0: mp3\n")
            async def finish():
                await asyncio.sleep(0)
                process.stdout.feed_data(b"0, 0, S=1, Skip Samples, 10\n")
                process.stdout.feed_eof()
            asyncio.create_task(finish())
            return process
        monkeypatch.setattr(mp3_gapless, "read_mp3_gapless_info", lambda _path: mp3_gapless.Mp3GaplessInfo(44100, 132300, 576, 1000))
        monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
        assert await mp3_gapless.ignored_mp3_gapless_info(Path("fixture.mp3"), "ffmpeg") is None
    asyncio.run(run())


@pytest.mark.parametrize("cancellation_kind", ["event", "task"])
def test_probe_cancellation_reaps_its_exact_process(monkeypatch, cancellation_kind):
    from music_app.services import mp3_gapless

    async def run():
        class Process:
            returncode = None
            kills = 0
            waits = 0
            stdout = asyncio.StreamReader()
            def kill(self):
                self.kills += 1
                self.returncode = -9
                self.stdout.feed_eof()
            async def wait(self):
                self.waits += 1
                return self.returncode
        process = Process()
        launched = asyncio.Event()
        async def launch(*_args, **_kwargs):
            launched.set()
            return process
        monkeypatch.setattr(mp3_gapless, "read_mp3_gapless_info", lambda _path: mp3_gapless.Mp3GaplessInfo(44100, 132300, 576, 1000))
        monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
        event = asyncio.Event()
        task = asyncio.create_task(mp3_gapless.ignored_mp3_gapless_info(Path("fixture.mp3"), "ffmpeg", cancel_event=event))
        await launched.wait()
        if cancellation_kind == "event":
            event.set()
        else:
            task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert process.kills == process.waits == 1
    asyncio.run(run())
