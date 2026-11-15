"""Each playback start step logs one path-free timing line, so a slow first sound can be located."""

import asyncio
import re

from music_app.routes import playback_control_asgi, playback_stream_asgi
from tests.py.asgi_testing import run_asgi_request
from tests.py.asgi_websocket_testing import websocket_session
from tests.py.test_playback_stream_asgi import (  # noqa: F401 - pytest fixtures
    decoder_factory,
    media_path,
    open_command,
    open_stream,
    playback_app,
)

STREAM_LOGGER = "music_app.routes.playback_stream_asgi"
CONTROL_LOGGER = "music_app.routes.playback_control_asgi"
STREAM_OPEN_LINE = re.compile(
    r"Playback stream open generation=(?P<generation>\d+) stream=(?P<stream>\d+) role=(?P<role>\w+) "
    r"decoder=(?P<decoder>[\w-]+) outcome=(?P<outcome>\w+) resolve_ms=(?P<resolve>\d+|-) "
    r"decoder_start_ms=(?P<decoder_start>\d+|-) first_credit_ms=(?P<first_credit>\d+|-) "
    r"first_decoded_ms=(?P<first_decoded>\d+|-) first_sent_ms=(?P<first_sent>\d+|-)$"
)


def stream_open_lines(caplog):
    lines = [record.getMessage() for record in caplog.records if record.name == STREAM_LOGGER]
    return [match.groupdict() for line in lines if (match := STREAM_OPEN_LINE.match(line))]


def control_lines(caplog, step):
    return [record.getMessage() for record in caplog.records
            if record.name == CONTROL_LOGGER and record.getMessage().startswith(f"Playback {step} timing ")]


def test_a_stream_open_logs_each_milestone_once_when_its_first_frame_is_sent(
    playback_app, media_path, decoder_factory, caplog,
):
    async def scenario():
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            with caplog.at_level("INFO", logger=STREAM_LOGGER):
                await open_stream(socket, media_path)
                await socket.send_json({"type": "credit", "generation": 1, "streamId": 1, "frames": 3})
                for _ in range(3):
                    assert (await socket.receive_bytes())[:4] == b"AHPC"

    asyncio.run(scenario())

    [line] = stream_open_lines(caplog)
    assert line["generation"] == "1" and line["stream"] == "1" and line["role"] == "current"
    assert line["decoder"] == "ffmpeg-pcm"
    assert line["outcome"] == "first_frame"
    milestones = [int(line[key]) for key in ("resolve", "decoder_start", "first_credit", "first_decoded", "first_sent")]
    assert milestones == sorted(milestones)
    assert str(media_path) not in caplog.text
    assert media_path.name not in caplog.text


def test_a_refused_rate_logs_how_long_the_decoder_took_to_say_so(playback_app, media_path, monkeypatch, caplog):
    async def refuse(_command):
        raise playback_stream_asgi.SampleRateMismatch(48_000)

    monkeypatch.setattr(playback_stream_asgi.PcmDecoderProcess, "start", refuse)

    async def scenario():
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            with caplog.at_level("INFO", logger=STREAM_LOGGER):
                await socket.send_json(open_command(media_path, sampleRate=44_100))
                assert (await socket.receive_json())["type"] == "rate-mismatch"

    asyncio.run(scenario())

    [line] = stream_open_lines(caplog)
    assert line["outcome"] == "rate_mismatch"
    assert line["decoder"] == "-"
    assert line["decoder_start"] != "-"
    assert (line["first_credit"], line["first_decoded"], line["first_sent"]) == ("-", "-", "-")


def test_a_stream_closed_before_its_first_frame_logs_how_far_it_got(
    playback_app, media_path, decoder_factory, caplog,
):
    async def scenario():
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            with caplog.at_level("INFO", logger=STREAM_LOGGER):
                await open_stream(socket, media_path)
                await socket.send_json({"type": "close", "generation": 1, "streamId": 1, "reason": "replacement"})
                # Controls are handled in order, so this answer follows the close.
                await socket.send_json({"type": "probe", "requestId": 1, "path": ""})
                assert await socket.receive_close() == 4404

    asyncio.run(scenario())

    [line] = stream_open_lines(caplog)
    assert line["outcome"] == "closed"
    assert line["decoder_start"] != "-"
    assert (line["first_credit"], line["first_sent"]) == ("-", "-")


def test_a_first_claim_logs_its_time_and_a_fast_heartbeat_logs_nothing(playback_app, monkeypatch, caplog):
    class Claims:
        def __init__(self, _config):
            pass

        def acquire(self, _actor, **_kwargs):
            return {"protocol": 1, "claimToken": "c" * 43}

    async def no_scrobbling(_request):
        return {}

    monkeypatch.setattr(playback_control_asgi, "PostgresPlaybackClaims", Claims)
    monkeypatch.setattr(playback_control_asgi, "_scrobbling_status", no_scrobbling)
    body = {"protocol": 1, "clientId": "11111111-1111-4111-8111-111111111111", "state": "playing",
            "track": {"playbackRef": "opaque-reference"}}

    with caplog.at_level("INFO", logger=CONTROL_LOGGER):
        status, _, _ = run_asgi_request(playback_app, "PUT", "/playback/state", json_body=body)
        assert status == 200
        status, _, _ = run_asgi_request(playback_app, "PUT", "/playback/state",
                                        json_body={**body, "claimToken": "p" * 43})
        assert status == 200

    [line] = control_lines(caplog, "claim")
    assert re.fullmatch(r"Playback claim timing status=200 elapsed_ms=\d+ renew=False scrobbling_ms=\d+", line)
    assert "c" * 43 not in caplog.text and "p" * 43 not in caplog.text
    assert "opaque-reference" not in caplog.text


def test_reference_batches_log_their_time_and_size_without_naming_a_track(playback_app, monkeypatch, caplog):
    class References:
        def __init__(self, _config):
            pass

        def issue_batch(self, _actor, tracks, on_media=None):
            return {"protocol": 1, "tracks": [{"clientKey": track["clientKey"], "playbackRef": "r"} for track in tracks]}

    monkeypatch.setattr(playback_control_asgi, "PlaybackReferenceService", References)
    track = {"clientKey": "queue-item", "path": "/private/library/song.flac"}

    with caplog.at_level("INFO", logger=CONTROL_LOGGER):
        status, _, _ = run_asgi_request(playback_app, "POST", "/playback/refs",
                                        json_body={"protocol": 1, "tracks": [track, track]})
        assert status == 200
        status, _, _ = run_asgi_request(playback_app, "POST", "/playback/refs", json_body={"protocol": 1, "tracks": []})
        assert status == 400

    issued, refused = control_lines(caplog, "refs")
    assert re.fullmatch(r"Playback refs timing status=200 elapsed_ms=\d+ tracks=2", issued)
    assert re.fullmatch(r"Playback refs timing status=400 elapsed_ms=\d+ tracks=-", refused)
    assert "/private/library" not in caplog.text
