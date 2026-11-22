"""Playback and waveforms start real ffmpeg on the Selector loop that serves Windows deployments.

That loop has no subprocess transports on Windows, so every fake process factory passes where the
served app fails: nothing here replaces the process boundary.
"""

from __future__ import annotations

import ast
import asyncio
import json
from pathlib import Path
import shutil
import struct
import subprocess

import pytest

from music_app.routes import playback_stream_asgi
from music_app.services import mp3_gapless
from music_app.services.ffmpeg_runtime import resolve_ffmpeg_executable
from music_app.services.waveform_peaks import WaveformPeaksRegistry, build_waveform_peaks
from tests.py.asgi_testing import run_asgi_request_async
from tests.py.asgi_websocket_testing import websocket_session
from tests.py.selector_loop_testing import children, on_selector_loop  # noqa: F401
from tests.py.test_playback_stream_asgi import open_command, playback_app  # noqa: F401


REPOSITORY = Path(__file__).resolve().parents[2]
RATE = 44_100
SECONDS = 10
FRAMES = RATE * SECONDS
ENCODINGS = {
    "wav": ("-c:a", "pcm_s16le"),
    "flac": ("-c:a", "flac"),
    "m4a": ("-c:a", "aac", "-b:a", "128k"),
    "mp3": ("-c:a", "libmp3lame", "-b:a", "192k", "-id3v2_version", "0"),
}
SUBPROCESS_TRANSPORT_APIS = {
    "create_subprocess_exec",
    "create_subprocess_shell",
    "subprocess_exec",
    "subprocess_shell",
    "connect_read_pipe",
    "connect_write_pipe",
}


@pytest.fixture(scope="module")
def ffmpeg() -> str:
    executable = resolve_ffmpeg_executable()
    assert executable, "The supported playback runtime requires FFmpeg"
    return executable


@pytest.fixture(scope="module")
def media(tmp_path_factory, ffmpeg) -> dict[str, Path]:
    directory = tmp_path_factory.mktemp("selector-loop-media")
    files = {}
    for suffix, encoding in ENCODINGS.items():
        files[suffix] = directory / f"track.{suffix}"
        subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i",
             f"anoisesrc=amplitude=0.3:duration={SECONDS}:sample_rate={RATE}:seed=7",
             "-ac", "2", *encoding, str(files[suffix])],
            check=True,
        )
    # FFmpeg ignores the boundaries of a lowercase LAME tag, which is what needs the trim probe.
    tagged = bytearray(files["mp3"].read_bytes())
    tag = min(at for name in (b"Lavc", b"Lavf") if (at := tagged.find(name, 0, 400)) >= 0)
    tagged[tag:tag + 4] = b"lame"
    files["trimmed.mp3"] = directory / "trimmed.mp3"
    files["trimmed.mp3"].write_bytes(tagged)
    return files


@pytest.fixture
def library_track(playback_app, media):
    def place(name: str) -> Path:
        path = Path(playback_app.state.config["MUSIC_DIR"]) / "Artist" / "Album" / media[name].name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(media[name], path)
        return path.resolve()

    return place


def decoded(ffmpeg: str, source: bytes | Path, *output: str) -> bytes:
    streamed = isinstance(source, bytes)
    return subprocess.run(
        [ffmpeg, "-loglevel", "error", "-i", "pipe:0" if streamed else str(source), *output,
         "-f", "f32le", "-c:a", "pcm_f32le", "-ac", "2", "pipe:1"],
        input=source if streamed else None,
        capture_output=True,
        check=True,
    ).stdout


async def next_message(socket) -> dict:
    # The socket helper waits 2 s; a child process may start slower than that on a busy runner.
    for _attempt in range(15):
        try:
            return await socket.receive_message()
        except asyncio.TimeoutError:
            continue
    raise AssertionError("playback sent nothing for 30 seconds")


async def play_to_the_end(app, path: Path, **changes) -> tuple[dict, bytes, dict]:
    async with websocket_session(app, "/playback/pcm") as socket:
        await socket.send_json(open_command(path, sampleRate=RATE, durationSeconds=SECONDS, **changes))
        metadata = json.loads((await next_message(socket))["text"])
        assert metadata["type"] == "metadata", f"playback refused the track: {metadata}"
        credit = {"type": "credit", "generation": 1, "streamId": 1}
        if "codec" not in metadata:
            await socket.send_json({**credit, "frames": RATE})
        audio = bytearray()
        sequence = 0
        while True:
            message = await next_message(socket)
            if message.get("bytes") is None:
                event = json.loads(message["text"])
                assert event["type"] == "eos", f"playback stopped early: {event}"
                return metadata, bytes(audio), event
            frame = message["bytes"]
            _generation, _stream, received_sequence, amount = struct.unpack(">IIII", frame[8:24])
            assert received_sequence == sequence
            sequence += 1
            audio += frame[24:]
            await socket.send_json({**credit, "frames": amount})


@pytest.mark.parametrize("start_seconds", [0, 4], ids=["from-start", "seek"])
@pytest.mark.parametrize("name", ["wav", "m4a"])
def test_a_format_decoded_here_plays_to_its_end(
    playback_app, library_track, children, ffmpeg, media, name, start_seconds,
):
    path = library_track(name)

    metadata, audio, eos = on_selector_loop(
        play_to_the_end(playback_app, path, startFrame=start_seconds * RATE)
    )

    assert "codec" not in metadata
    assert len(audio) // 8 == eos["emittedFrames"]
    if name == "wav":
        assert audio == decoded(ffmpeg, media[name])[start_seconds * RATE * 8:]
    else:
        assert len(audio) // 8 == pytest.approx(FRAMES - start_seconds * RATE, abs=2048)
    assert all(child.poll() is not None for child in children)


def test_a_flac_seek_streams_every_remaining_sample_as_flac(
    playback_app, library_track, children, ffmpeg, media,
):
    path = library_track("flac")

    metadata, audio, _eos = on_selector_loop(
        play_to_the_end(playback_app, path, startFrame=4 * RATE, codecs=["mp3", "flac"])
    )

    assert metadata["codec"] == "flac"
    assert decoded(ffmpeg, audio) == decoded(ffmpeg, media["flac"])[4 * RATE * 8:]
    assert all(child.poll() is not None for child in children)


@pytest.mark.parametrize("start_seconds", [0, 4], ids=["from-start", "seek"])
def test_flac_at_320_streams_the_whole_track_as_mp3(
    playback_app, library_track, children, ffmpeg, start_seconds,
):
    path = library_track("flac")

    metadata, audio, _eos = on_selector_loop(
        play_to_the_end(
            playback_app, path, startFrame=start_seconds * RATE, codecs=["mp3", "flac"], quality="320",
        )
    )

    assert metadata["codec"] == "mp3"
    expected = FRAMES - start_seconds * RATE
    assert metadata["totalFrames"] == expected
    assert len(decoded(ffmpeg, audio)) // 8 >= expected
    assert all(child.poll() is not None for child in children)


def test_mp3_decoded_here_keeps_its_gapless_trim(playback_app, library_track, children):
    path = library_track("trimmed.mp3")

    metadata, audio, _eos = on_selector_loop(play_to_the_end(playback_app, path))

    assert "codec" not in metadata
    assert len(audio) // 8 == FRAMES
    assert all(child.poll() is not None for child in children)


def test_the_gapless_probe_reports_the_trim_ffmpeg_ignores(media, ffmpeg, children):
    info = on_selector_loop(mp3_gapless.ignored_mp3_gapless_info(media["trimmed.mp3"], ffmpeg))

    assert info is not None
    assert info.end_sample - info.first_sample == FRAMES
    assert all(child.poll() is not None for child in children)


@pytest.mark.parametrize("name", ["wav", "flac", "m4a", "mp3", "trimmed.mp3"])
def test_a_waveform_is_built_for_every_format(media, children, name):
    peaks = on_selector_loop(
        build_waveform_peaks(media[name], bins=280, cancel_event=asyncio.Event())
    )

    assert len(peaks.left) == len(peaks.right) == 280
    assert min(peaks.left[:270]) > 0
    assert all(child.poll() is not None for child in children)


def test_the_waveform_route_answers_with_peaks(playback_app, library_track, monkeypatch):
    path = library_track("m4a")
    playback_app.state.waveform_peaks_registry = WaveformPeaksRegistry()

    async def stays_connected(_request):
        await asyncio.Event().wait()

    # The ASGI helper hangs up as soon as it sent the request, which would cancel the build.
    monkeypatch.setattr(playback_stream_asgi, "_wait_for_http_disconnect", stays_connected)

    status, _headers, body = on_selector_loop(
        run_asgi_request_async(playback_app, "GET", "/playback/waveform", query={"path": str(path)})
    )

    assert status == 200
    peaks = json.loads(body)
    assert peaks["sampleCount"] == len(peaks["left"]) == 280
    assert max(peaks["left"]) > 0


def test_a_cancelled_waveform_reaps_its_decoder(media, children):
    async def scenario():
        cancel = asyncio.Event()
        building = asyncio.create_task(build_waveform_peaks(media["wav"], bins=280, cancel_event=cancel))
        while not children:
            await asyncio.sleep(0.005)
        cancel.set()
        with pytest.raises(asyncio.CancelledError):
            await building

    on_selector_loop(scenario())

    assert children and all(child.poll() is not None for child in children)


def test_a_disconnect_mid_stream_reaps_the_decoder(playback_app, library_track, children):
    path = library_track("wav")

    async def scenario():
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await socket.send_json(open_command(path, sampleRate=RATE, durationSeconds=SECONDS))
            metadata = json.loads((await next_message(socket))["text"])
            assert metadata["type"] == "metadata", f"playback refused the track: {metadata}"
            await socket.send_json({"type": "credit", "generation": 1, "streamId": 1, "frames": 1024})
            assert (await next_message(socket))["bytes"]

    on_selector_loop(scenario())

    assert children and all(child.poll() is not None for child in children)
    assert playback_app.state.playback_pcm_registry.active_decoder_count == 0


def test_the_app_never_uses_the_event_loop_subprocess_transports():
    used = []
    for path in [*(REPOSITORY / "music_app").rglob("*.py"), *REPOSITORY.glob("*.py")]:
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8-sig"))):
            if isinstance(node, ast.Attribute):
                names = {node.attr}
            elif isinstance(node, ast.ImportFrom):
                names = {alias.name for alias in node.names}
            else:
                continue
            if names & SUBPROCESS_TRANSPORT_APIS:
                used.append(f"{path.relative_to(REPOSITORY).as_posix()}:{node.lineno}")

    assert used == [], "these raise NotImplementedError on Windows' Selector loop; use start_child_process"
