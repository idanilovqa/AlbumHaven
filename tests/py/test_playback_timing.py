"""The opt-in playback timing lines: off they cost nothing, on they say where a press waited.

Every value is a number or a word from a fixed list, so no path, title or token can reach a line.
"""

import asyncio
import re
import threading
import time
from pathlib import Path

import pytest

from music_app.routes import playback_stream_asgi
from music_app.services import playback_io, playback_timing, waveform_peaks
from tests.py.asgi_websocket_testing import websocket_session
from tests.py.test_playback_stream_asgi import (  # noqa: F401 - pytest fixtures
    decoder_factory,
    media_path,
    open_command,
    playback_app,
)

TIMING_LOGGER = "music_app.services.playback_timing"
SAFE_LINE = re.compile(r"Playback timing event=[a-z-]+( [a-z0-9_]+=(-|-?\d+|[a-z][a-z-]{0,23}))*")
START_REPORT = {
    "type": "start-report",
    "generation": 1,
    "audibleStreamId": 1,
    "prepared": False,
    "pressedAtEpochMs": 1_795_000_000_000,
    "openMs": 12,
    "metadataMs": 80,
    "firstBytesMs": 95,
    "decodedMs": 101,
    "audibleMs": 140,
}


@pytest.fixture
def timing_on(monkeypatch, caplog):
    monkeypatch.setattr(playback_timing, "ENABLED", True)
    caplog.set_level("INFO", logger=TIMING_LOGGER)

    def lines(event=None):
        found = [r.getMessage() for r in caplog.records if r.name == TIMING_LOGGER]
        for line in found:
            assert SAFE_LINE.fullmatch(line), line
        return [
            dict(pair.split("=", 1) for pair in line.split(" ")[2:])
            for line in found
            if event is None or line.split(" ")[2] == f"event={event}"
        ]

    return lines


def test_timing_is_off_unless_switched_on_and_then_logs_and_starts_nothing(
    playback_app, media_path, decoder_factory, monkeypatch, caplog,
):
    monkeypatch.setattr(playback_timing, "ENABLED", False)
    caplog.set_level("INFO", logger=TIMING_LOGGER)
    work = lambda: None
    assert playback_timing.timed_work("refresh", work) is work

    async def scenario():
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await socket.send_json(open_command(media_path))
            metadata = await socket.receive_json()
            assert metadata["type"] == "metadata"
            assert "timing" not in metadata
            # A page that still reports is heard and not refused.
            await socket.send_json(START_REPORT)
            await socket.send_json({"type": "credit", "generation": 1, "streamId": 1, "frames": 1})
            await socket.receive_bytes()
            assert playback_app.state.playback_pcm_registry._loop_watch is None

    asyncio.run(scenario())
    assert [r for r in caplog.records if r.name == TIMING_LOGGER] == []


def test_an_open_and_a_refresh_only_probe_split_where_they_waited(
    playback_app, media_path, decoder_factory, timing_on, caplog,
):
    async def scenario():
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await socket.send_json(open_command(media_path))
            metadata = await socket.receive_json()
            assert metadata["type"] == "metadata"
            assert metadata["timing"] is True, "the page is asked to report its presses"
            await socket.send_json(
                {"type": "probe", "requestId": 9, "path": str(media_path), "authorityOnly": True}
            )
            assert (await socket.receive_json())["type"] == "probe-result"

    asyncio.run(scenario())
    by_kind = {line["kind"]: line for line in timing_on("control")}
    assert set(by_kind) == {"open", "refresh-probe"}
    assert by_kind["open"]["generation"] == by_kind["open"]["id"] == "1"
    assert by_kind["refresh-probe"]["id"] == "9"
    for line in by_kind.values():
        for measured in (
            "refresh_wait_ms", "refresh_ms", "resolve_wait_ms", "resolve_ms", "send_lock_wait_ms",
        ):
            assert line[measured].isdigit(), (measured, line)
        assert line["mp3_scan_ms"] == "-"
        assert int(line["sent_at"]) >= int(line["received_at"]) > 1_600_000_000_000
    assert media_path.name not in caplog.text
    assert str(media_path.parent) not in caplog.text


def test_an_mp3_open_times_its_frame_scan(playback_app, media_path, decoder_factory, timing_on, monkeypatch):
    from music_app.services import playback_encoded

    mp3 = media_path.with_name("track.mp3")
    mp3.write_bytes(b"not-really-mp3")
    monkeypatch.setattr(playback_stream_asgi, "mp3_stream_map", lambda _path: None)
    monkeypatch.setattr(playback_encoded, "mp3_stream_map", lambda _path: None)

    async def scenario():
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await socket.send_json(open_command(mp3, codecs=["mp3"]))
            await socket.receive_json()

    asyncio.run(scenario())
    [line] = timing_on("control")
    assert line["mp3_scan_ms"].isdigit()


def test_socket_lines_name_its_accept_close_and_late_heartbeats(playback_app, timing_on, monkeypatch):
    monkeypatch.setattr(playback_timing, "HEARTBEAT_LATE_SECONDS", -1)

    async def scenario():
        async with websocket_session(playback_app, "/playback/pcm?heartbeat=100") as socket:
            assert (await socket.receive_json())["type"] == "heartbeat"
            await socket.send_json({"type": "nonsense"})
            while (await socket.receive_message())["type"] != "websocket.close":
                pass

    asyncio.run(scenario())
    [accepted] = timing_on("socket-accepted")
    [closed] = timing_on("socket-closed")
    assert closed["socket"] == accepted["socket"]
    assert closed["code"] == "4400"
    assert timing_on("heartbeat-late")


def test_a_client_start_report_becomes_one_line(playback_app, timing_on):
    async def scenario():
        async with websocket_session(playback_app, "/playback/pcm?heartbeat=100") as socket:
            await socket.send_json({**START_REPORT, "prepared": True, "firstBytesMs": None, "decodedMs": None})
            await socket.receive_json()

    asyncio.run(scenario())
    [line] = timing_on("client-start")
    assert line["kind"] == "prepared"
    assert (line["open_ms"], line["metadata_ms"], line["audible_ms"]) == ("12", "80", "140")
    assert (line["first_bytes_ms"], line["decoded_ms"]) == ("-", "-")


@pytest.mark.parametrize(
    "change",
    [
        {"path": "C:/Music/Secret Album/secret.flac"},
        {"openMs": "Secret Album"},
        {"pressedAtEpochMs": "token"},
        {"prepared": "Secret"},
    ],
    ids=["extra-field", "text-duration", "text-time", "text-flag"],
)
def test_a_client_start_report_can_carry_no_text(playback_app, timing_on, caplog, change):
    async def scenario():
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await socket.send_json({**START_REPORT, **change})
            assert await socket.receive_close() == 4400

    asyncio.run(scenario())
    assert timing_on("client-start") == []
    assert "secret" not in caplog.text.lower()


def test_a_late_event_loop_is_reported(timing_on):
    async def scenario():
        watch = asyncio.create_task(playback_timing.watch_event_loop())
        await asyncio.sleep(0.01)
        time.sleep(0.24)  # the blocked loop under test
        await asyncio.sleep(0.15)
        watch.cancel()
        await asyncio.gather(watch, return_exceptions=True)

    asyncio.run(scenario())
    assert int(timing_on("loop-late")[0]["late_ms"]) >= 100


def test_a_wait_for_a_playback_thread_is_reported(timing_on):
    all_busy = threading.Barrier(playback_io._EXECUTOR._max_workers)

    def occupy():
        all_busy.wait(5)
        time.sleep(0.2)

    async def scenario():
        held = [
            asyncio.create_task(playback_io.run_playback_io(occupy))
            for _ in range(playback_io._EXECUTOR._max_workers)
        ]
        await asyncio.sleep(0)
        await playback_io.run_playback_io(lambda: None)
        await asyncio.gather(*held)

    asyncio.run(scenario())
    assert max(int(line["wait_ms"]) for line in timing_on("thread-wait")) >= 100


@pytest.mark.parametrize("outcome", ["done", "stopped", "failed"])
def test_a_waveform_build_says_when_it_ran_and_how_many_ran_with_it(timing_on, caplog, outcome):
    async def builder(_path, **_options):
        if outcome == "stopped":
            raise asyncio.CancelledError
        if outcome == "failed":
            raise RuntimeError("decode failed")
        return waveform_peaks.WaveformPeaks((0.0,), (0.0,), 1)

    async def scenario():
        registry = waveform_peaks.WaveformPeaksRegistry(builder=builder)
        await asyncio.gather(registry.run(Path("Secret Album/secret.flac"), bins=280), return_exceptions=True)
        await asyncio.gather(registry.shutdown(), return_exceptions=True)

    asyncio.run(scenario())
    [started] = timing_on("waveform-started")
    [ended] = timing_on("waveform-ended")
    assert started["running"] == "1"
    assert ended["outcome"] == outcome
    assert ended["elapsed_ms"].isdigit()
    assert "secret" not in caplog.text.lower()
