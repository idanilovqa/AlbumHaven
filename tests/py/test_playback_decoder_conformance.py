"""Release gate: the shipped client decoders must match the server reference decode."""

from __future__ import annotations

from array import array
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

from music_app.services.ffmpeg_runtime import resolve_ffmpeg_executable
from music_app.services.mp3_stream_map import read_mp3_stream_map
from music_app.services.playback_encoded import open_encoded_stream, read_flac_layout
from music_app.services.playback_pcm import PcmOpenCommand


REPOSITORY = Path(__file__).resolve().parents[2]
DECODER_SCRIPT = REPOSITORY / "tests/js/support/decode-encoded-stream.cjs"
# The Android app's decoders, built for this host from the same C sources as the APK.
ANDROID_DECODER_SOURCE = REPOSITORY / "apps/android-shell/playback-engine/src/main/cpp/host"
# Different MP3 decoders round differently; this is about -60 dB below full scale.
SAMPLE_TOLERANCE = 0.001
SEEK_FRACTIONS = (0, 0.002, 0.13, 0.37, 0.5, 0.77, 0.97)
NOISE = "anoisesrc=color=pink:amplitude=0.3:duration=6:sample_rate={rate}:seed=7"
MP3_VARIANTS = {
    "cbr-320": (44_100, ("-ac", "2", "-c:a", "libmp3lame", "-b:a", "320k")),
    "cbr-128-48k": (48_000, ("-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k")),
    "vbr": (44_100, ("-ac", "2", "-c:a", "libmp3lame", "-q:a", "2")),
    "no-xing": (44_100, ("-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k", "-write_xing", "0")),
    "mono-mpeg2": (22_050, ("-ac", "1", "-c:a", "libmp3lame", "-q:a", "4")),
    "low-bitrate": (32_000, ("-ac", "2", "-c:a", "libmp3lame", "-b:a", "48k")),
}


@pytest.fixture(scope="module")
def tools() -> tuple[str, str]:
    ffmpeg = resolve_ffmpeg_executable()
    node = shutil.which("node")
    assert ffmpeg and node, "the decoder gate requires ffmpeg and node"
    return ffmpeg, node


def _generate(ffmpeg: str, path: Path, rate: int, *encoding: str) -> None:
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", NOISE.format(rate=rate),
         *encoding, str(path)],
        check=True,
    )


def _reference(ffmpeg: str, path: Path) -> array:
    decoded = subprocess.run(
        [ffmpeg, "-loglevel", "error", "-i", str(path), "-vn", "-f", "f32le",
         "-af", "pan=mono|c0=c0", "-c:a", "pcm_f32le", "pipe:1"],
        check=True,
        capture_output=True,
    ).stdout
    samples = array("f")
    samples.frombytes(decoded)
    return samples


@pytest.fixture(scope="module")
def android_decoder_tool(tmp_path_factory) -> Path:
    cmake = shutil.which("cmake")
    compiler = shutil.which("cc") or shutil.which("gcc") or shutil.which("clang")
    if os.name == "nt" or cmake is None or compiler is None:
        message = "the Android decoder gate builds a POSIX host tool with cmake and a C compiler"
        if os.environ.get("CI"):
            pytest.fail(message)
        pytest.skip(f"{message}; CI runs it")
    build = tmp_path_factory.mktemp("android-decoders")
    for command in (
        [cmake, "-S", str(ANDROID_DECODER_SOURCE), "-B", str(build), "-DCMAKE_BUILD_TYPE=Release"],
        [cmake, "--build", str(build), "--parallel"],
    ):
        subprocess.run(command, check=True, capture_output=True)
    return build / "ah-decode-tool"


@pytest.fixture(params=["web", "android"])
def decode_with_client(request, tools):
    """Every client that ships decoders must match the server reference the same way."""
    if request.param == "web":
        _ffmpeg, node = tools

        def run(codec: str, bytes_path: Path, output_path: Path) -> None:
            request_json = {"codec": codec, "bytesPath": str(bytes_path), "outputPath": str(output_path)}
            subprocess.run([node, str(DECODER_SCRIPT)], input=json.dumps(request_json).encode(),
                           check=True, capture_output=True)
    else:
        tool = request.getfixturevalue("android_decoder_tool")

        def run(codec: str, bytes_path: Path, output_path: Path) -> None:
            subprocess.run([str(tool), codec, str(bytes_path), str(output_path)], check=True, capture_output=True)

    def decode(codec: str, payload: bytes, work: Path) -> array:
        bytes_path = work / "stream.bin"
        output_path = work / "decoded.f32"
        bytes_path.write_bytes(payload)
        run(codec, bytes_path, output_path)
        samples = array("f")
        samples.frombytes(output_path.read_bytes())
        return samples

    return decode


def _assert_exact(kept: array, expected: array, label: str) -> None:
    assert len(kept) == len(expected), f"{label}: eaten or extra samples"
    worst = max((abs(left - right) for left, right in zip(kept, expected)), default=0)
    assert worst < SAMPLE_TOLERANCE, f"{label}: samples differ by {worst}"


@pytest.mark.parametrize("variant", MP3_VARIANTS)
def test_mp3_map_and_client_decoder_match_reference_at_every_seek(
    tools, decode_with_client, tmp_path, variant
):
    ffmpeg, _node = tools
    rate, encoding = MP3_VARIANTS[variant]
    source = tmp_path / f"{variant}.mp3"
    _generate(ffmpeg, source, rate, *encoding)
    reference = _reference(ffmpeg, source)
    stream_map = read_mp3_stream_map(source)
    assert stream_map is not None
    data = source.read_bytes()
    for fraction in SEEK_FRACTIONS:
        start = int(len(reference) * fraction)
        window = stream_map.window(start)
        decoded = decode_with_client("mp3", data[window.start_byte:window.end_byte], tmp_path)
        kept = decoded[window.skip_frames:window.skip_frames + window.total_frames]
        _assert_exact(kept, reference[start:], f"{variant} at {start}")


def _read_stream(command: PcmOpenCommand, *, quality: str = "original") -> tuple[object, bytes]:
    async def scenario():
        stream = await open_encoded_stream(
            command,
            codecs=frozenset({"mp3", "flac"}),
            quality=quality,
        )
        assert stream is not None
        stream.grant_credit(1 << 40)
        payload = bytearray()
        while True:
            chunk = await stream.read_credited_frames(max_frames=1 << 20)
            if not chunk.frame_count:
                await stream.finish()
                return stream, bytes(payload)
            payload += chunk.pcm

    return asyncio.run(scenario())


def _open_command(path: Path, start_frame: int, sample_rate: int) -> PcmOpenCommand:
    return PcmOpenCommand(
        generation=1,
        stream_id=1,
        role="current",
        path=path,
        start_frame=start_frame,
        sample_rate=sample_rate,
        provisional_duration_seconds=6,
    )


@pytest.mark.parametrize("sample_format", ["s16", "s32"])
@pytest.mark.parametrize("fraction", [0, 0.37, 0.77])
def test_flac_stream_keeps_every_source_sample_from_any_position(
    tools, decode_with_client, tmp_path, sample_format, fraction
):
    ffmpeg, _node = tools
    source = tmp_path / "source.flac"
    _generate(ffmpeg, source, 44_100, "-ac", "2", "-c:a", "flac", "-sample_fmt", sample_format)
    reference = _reference(ffmpeg, source)
    start = int(len(reference) * fraction)
    stream, payload = _read_stream(_open_command(source, start, 44_100))
    assert stream.codec == "flac"
    decoded = decode_with_client("flac", payload, tmp_path)
    _assert_exact(decoded[:stream.total_frames], reference[start:], f"flac at {start}")


@pytest.mark.parametrize("fraction", [0, 0.5])
def test_weak_connection_fallback_keeps_the_timeline_exact(
    tools, decode_with_client, tmp_path, fraction
):
    ffmpeg, _node = tools
    source = tmp_path / "source.flac"
    _generate(ffmpeg, source, 44_100, "-ac", "2", "-c:a", "flac")
    reference = _reference(ffmpeg, source)
    start = int(len(reference) * fraction)
    stream, payload = _read_stream(_open_command(source, start, 44_100), quality="320")
    assert stream.codec == "mp3"
    decoded = decode_with_client("mp3", payload, tmp_path)
    kept = decoded[stream.skip_frames:stream.skip_frames + stream.total_frames]
    assert len(kept) == len(reference) - start
    window = 2048
    correlation = sum(
        kept[index] * reference[start + index] for index in range(1000, 1000 + window)
    )
    energy = sum(reference[start + index] ** 2 for index in range(1000, 1000 + window))
    assert correlation / energy > 0.8, "the fallback is not sample-aligned with the source"


def test_flac_header_omits_cover_art_but_keeps_stream_details(tools, tmp_path):
    ffmpeg, _node = tools
    source = tmp_path / "source.flac"
    _generate(ffmpeg, source, 48_000, "-ac", "2", "-c:a", "flac")
    header, first_audio_byte, end_byte, sample_rate, total_samples = read_flac_layout(source)
    assert end_byte == source.stat().st_size
    assert sample_rate == 48_000
    assert total_samples == 288_000
    assert len(header) == 42
    assert source.read_bytes()[first_audio_byte:first_audio_byte + 2][0] == 0xFF


def test_repeated_id3_tags_do_not_hide_the_gapless_header(tools, decode_with_client, tmp_path):
    ffmpeg, _node = tools
    source = tmp_path / "plain.mp3"
    _generate(ffmpeg, source, 44_100, "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k")
    data = source.read_bytes()
    tag_bytes = 10 + sum(
        value << shift for value, shift in zip(data[6:10], (21, 14, 7, 0))
    )
    doubled = tmp_path / "doubled.mp3"
    doubled.write_bytes(data[:tag_bytes] + data)
    stream_map = read_mp3_stream_map(doubled)
    reference = _reference(ffmpeg, doubled)
    assert stream_map.first_sample == 1105
    window = stream_map.window(0)
    decoded = decode_with_client("mp3", doubled.read_bytes()[window.start_byte:window.end_byte], tmp_path)
    kept = decoded[window.skip_frames:window.skip_frames + window.total_frames]
    _assert_exact(kept, reference, "doubled ID3")


def test_files_a_map_cannot_describe_stay_on_server_decoding(tmp_path):
    damaged = tmp_path / "damaged.mp3"
    damaged.write_bytes(b"not an mpeg stream" * 1000)
    assert read_mp3_stream_map(damaged) is None
