"""Ordinary PCM capture coordinates; synthetic pipes, no media or database.

These additive tests exercise the real decoder and route code. They do not
instantiate retained/rooted adapters, launch ffmpeg, or open authentication files.
"""
from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path
from uuid import UUID

import pytest

from music_app.routes.playback_stream_asgi import (
    PlaybackPcmRegistry,
    _PlaybackPcmConnection,
    _PlaybackStream,
    _capture_source_event,
    _metadata_event,
)
from music_app.services.playback_pcm import PcmDecoderProcess, PcmOpenCommand


class _Process:
    """Only the ordinary asyncio subprocess/pipe boundary is fake."""

    def __init__(self, data=b"", *, exit_code=0, stdout=None):
        self.stdout = stdout if stdout is not None else asyncio.StreamReader()
        if stdout is None:
            self.stdout.feed_data(data)
            self.stdout.feed_eof()
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_eof()
        self.returncode = None
        self.exit_code = exit_code
        self.wait_started = asyncio.Event()
        self.exit_allowed = asyncio.Event()
        self.exit_allowed.set()
        self.terminated = 0

    async def wait(self):
        self.wait_started.set()
        await self.exit_allowed.wait()
        self.returncode = self.exit_code
        return self.returncode

    def terminate(self):
        self.terminated += 1
        self.exit_code = -15
        self.exit_allowed.set()


class _FailOnceReader:
    def __init__(self, error):
        self.error = error

    async def read(self, _size):
        if self.error is not None:
            error, self.error = self.error, None
            raise error
        return b""

    def at_eof(self):
        return self.error is None


def _decoder(data=b"", *, start=0, rate=48_000, stream_id=11, **process_options):
    process = _Process(data, **process_options)
    command = PcmOpenCommand(
        generation=7, stream_id=stream_id, role="current",
        path=Path("synthetic-capture-source.flac"), start_frame=start,
        sample_rate=rate, provisional_duration_seconds=900,
    )
    return PcmDecoderProcess(command, process), process


async def _consume(decoder, frames):
    decoder.grant_credit(frames + 1)
    chunk = await decoder.read_credited_frames(max_frames=frames + 1)
    assert chunk.frame_count == frames
    assert len(chunk.pcm) == frames * 8
    assert decoder.metadata.capture_extent_frames48 is None
    eof = await decoder.read_credited_frames(max_frames=1)
    assert eof.frame_count == 0
    return await decoder.finish()


@pytest.mark.asyncio
async def test_zero_origin_observations_are_distinct_and_only_own_eof_sets_extent():
    first, _ = _decoder(bytes(3 * 8))
    second, _ = _decoder(bytes(5 * 8))  # Even identical command IDs are not identity.
    try:
        first_id = first.metadata.capture_source_id
        second_id = second.metadata.capture_source_id
        assert first_id != second_id
        assert str(UUID(first_id)) == first_id and UUID(first_id).version == 4
        assert str(UUID(second_id)) == second_id and UUID(second_id).version == 4
        for decoder in (first, second):
            source = _metadata_event(decoder.metadata, role="current")["captureSource"]
            assert source == {
                "version": "decoded-pcm-observation-v1",
                "observationId": decoder.metadata.capture_source_id,
                "coordinateBasis": "decoded-output-zero",
                "sourceBase48": 0,
                "extentFrames48": None,
            }
        metadata = await _consume(first, 3)
        assert metadata.capture_source_id == first_id
        assert metadata.capture_extent_frames48 == metadata.authoritative_total_frames == 3
        assert metadata.provisional_total_frames == 900 * 48_000
        assert second.metadata.capture_extent_frames48 is None
        assert second.metadata.authoritative_total_frames is None
        assert (await _consume(second, 5)).capture_extent_frames48 == 5
        assert first.metadata.capture_extent_frames48 == 3
    finally:
        await asyncio.gather(first.cancel(), second.cancel())


@pytest.mark.asyncio
async def test_clean_empty_eof_is_zero_extent_not_provisional_duration():
    decoder, _ = _decoder()
    try:
        decoder.grant_credit(1)
        assert (await decoder.read_credited_frames(max_frames=1)).frame_count == 0
        metadata = await decoder.finish()
        assert metadata.capture_extent_frames48 == 0
        assert metadata.authoritative_total_frames == 0
        assert metadata.provisional_total_frames > 0
    finally:
        await decoder.cancel()


@pytest.mark.asyncio
@pytest.mark.parametrize("start,rate", [(1, 48_000), (48_000, 48_000), (0, 44_100), (0, 96_000)])
async def test_seek_and_other_rates_keep_capture_coordinates_unknown(start, rate):
    decoder, _ = _decoder(bytes(2 * 8), start=start, rate=rate)
    try:
        initial = _capture_source_event(decoder.metadata)
        assert initial["observationId"] == decoder.metadata.capture_source_id
        assert initial["coordinateBasis"] == "unknown"
        assert initial["sourceBase48"] is None
        metadata = await _consume(decoder, 2)
        assert metadata.authoritative_total_frames == start + 2
        assert metadata.capture_extent_frames48 is None
        assert _capture_source_event(metadata) == initial
    finally:
        await decoder.cancel()


@pytest.mark.asyncio
async def test_no_credit_and_unread_stdout_cannot_establish_extent():
    decoder, _ = _decoder(bytes(8))
    try:
        assert (await decoder.read_credited_frames(max_frames=1)).frame_count == 0
        with pytest.raises(RuntimeError, match="before stdout"):
            await decoder.finish()
        assert decoder.metadata.capture_extent_frames48 is None
        assert decoder.metadata.authoritative_total_frames is None
    finally:
        await decoder.cancel()


@pytest.mark.asyncio
async def test_nonzero_process_exit_never_publishes_extent():
    decoder, _ = _decoder(bytes(8), exit_code=1)
    try:
        decoder.grant_credit(2)
        assert (await decoder.read_credited_frames(max_frames=2)).frame_count == 1
        with pytest.raises(RuntimeError, match="exited with code 1"):
            await decoder.read_credited_frames(max_frames=1)
        assert decoder.metadata.capture_extent_frames48 is None
        assert decoder.metadata.authoritative_total_frames is None
    finally:
        await decoder.cancel()


@pytest.mark.asyncio
async def test_truncated_frame_poison_survives_later_successful_finish():
    decoder, _ = _decoder(bytes(9))
    try:
        decoder.grant_credit(2)
        with pytest.raises(RuntimeError, match="truncated partial PCM"):
            await decoder.read_credited_frames(max_frames=2)
        assert decoder.emitted_frames == 0
        assert decoder.metadata.capture_extent_frames48 is None
        metadata = await decoder.finish()
        assert metadata.capture_extent_frames48 is None
    finally:
        await decoder.cancel()


@pytest.mark.asyncio
@pytest.mark.parametrize("error_type", [OSError, asyncio.CancelledError])
async def test_failed_or_cancelled_read_cannot_be_rehabilitated_by_clean_eof(error_type):
    decoder, _ = _decoder(stdout=_FailOnceReader(error_type("synthetic read interruption")))
    try:
        decoder.grant_credit(1)
        with pytest.raises(error_type):
            await decoder.read_credited_frames(max_frames=1)
        assert decoder.metadata.capture_extent_frames48 is None
        if error_type is asyncio.CancelledError:
            with pytest.raises(RuntimeError, match="cancelled"):
                await decoder.finish()
            assert decoder.metadata.authoritative_total_frames is None
        else:
            metadata = await decoder.finish()
            assert metadata.authoritative_total_frames == 0
            assert metadata.capture_extent_frames48 is None
    finally:
        await decoder.cancel()


@pytest.mark.asyncio
async def test_cancel_clears_completed_extent_and_prevents_further_reads():
    decoder, _ = _decoder(bytes(8))
    await _consume(decoder, 1)
    await decoder.cancel()
    assert decoder.metadata.capture_extent_frames48 is None
    with pytest.raises(RuntimeError, match="cancelled"):
        await decoder.finish()
    with pytest.raises(RuntimeError, match="cancelled"):
        await decoder.read_credited_frames(max_frames=1)


@pytest.mark.asyncio
async def test_cancel_during_exit_settlement_cannot_publish_late_extent():
    decoder, process = _decoder()
    process.exit_allowed.clear()
    decoder.grant_credit(1)
    read = asyncio.create_task(decoder.read_credited_frames(max_frames=1))
    try:
        await process.wait_started.wait()
        await decoder.cancel()
        with pytest.raises(RuntimeError, match="cancelled"):
            await read
        assert process.terminated == 1
        assert decoder.metadata.capture_extent_frames48 is None
        assert decoder.metadata.authoritative_total_frames is None
    finally:
        process.exit_allowed.set()
        await asyncio.gather(read, decoder.cancel(), return_exceptions=True)


class _Socket:
    def __init__(self):
        self.events = []

    async def send_json(self, event):
        self.events.append(event)

    async def send_bytes(self, data):
        self.events.append(data)


@pytest.mark.asyncio
async def test_real_route_drain_preserves_metadata_pcm_eof_identity_and_rejects_replay():
    decoder, _ = _decoder(bytes(3 * 8))
    socket = _Socket()
    registry = PlaybackPcmRegistry()
    assert await registry.acquire_decoder()
    connection = _PlaybackPcmConnection(registry, socket)
    stream = _PlaybackStream(decoder=decoder, generation=7, stream_id=11, role="current")
    connection._streams_by_id[11] = stream
    connection._streams_by_role["current"] = stream
    try:
        await connection._send_json(_metadata_event(decoder.metadata, role=stream.role))
        decoder.grant_credit(4)
        await connection._drain_stream_credit(stream)
        metadata, pcm, eof = socket.events
        assert metadata["type"] == "metadata"
        assert metadata["captureSource"]["extentFrames48"] is None
        assert pcm[:4] == b"AHPC" and len(pcm) == 24 + 3 * 8
        assert eof["type"] == "eos"
        assert eof["generation"] == metadata["generation"] == 7
        assert eof["streamId"] == metadata["streamId"] == 11
        assert eof["role"] == metadata["role"] == "current"
        assert eof["captureSource"]["observationId"] == metadata["captureSource"]["observationId"]
        assert eof["captureSource"]["extentFrames48"] == eof["emittedFrames"] == eof["authoritativeTotalFrames"] == 3
        assert registry.active_decoder_count == 0
        assert await connection._send_stream_eos(stream, decoder.metadata) is False
        assert len(socket.events) == 3
    finally:
        await decoder.cancel()


@pytest.mark.asyncio
async def test_route_cannot_emit_retired_decoder_eof_under_reused_stream_id():
    old, _ = _decoder()
    current, _ = _decoder()
    socket = _Socket()
    connection = _PlaybackPcmConnection(PlaybackPcmRegistry(), socket)
    retired = _PlaybackStream(old, 7, 11, "current")
    replacement = _PlaybackStream(current, 7, 11, "current")
    connection._streams_by_id[11] = replacement
    connection._streams_by_role["current"] = replacement
    try:
        old.grant_credit(1)
        await old.read_credited_frames(max_frames=1)
        assert await connection._send_stream_eos(retired, await old.finish()) is False
        assert socket.events == []
        assert connection._streams_by_id[11] is replacement
        assert current.metadata.capture_extent_frames48 is None
    finally:
        await asyncio.gather(old.cancel(), current.cancel())


@pytest.mark.asyncio
async def test_metadata_rejects_forged_coordinate_and_extent_claims():
    decoder, _ = _decoder()
    try:
        metadata = decoder.metadata
        for changes in (
            {"capture_source_base48": 1}, {"capture_source_base48": True},
            {"capture_source_base48": 0, "sample_rate": 44_100},
            {"capture_source_base48": 0, "requested_start_frame": 1},
            {"capture_source_base48": 0, "timeline_start_frame": 1},
            {"capture_source_id": "00000000-0000-1000-8000-000000000000"},
            {"capture_extent_frames48": 3, "authoritative_total_frames": 2},
            {"capture_extent_frames48": 2**53, "authoritative_total_frames": 2**53},
        ):
            with pytest.raises((TypeError, ValueError)):
                replace(metadata, **changes)
        legacy = replace(metadata, capture_source_id=None, capture_source_base48=None)
        assert _capture_source_event(legacy) is None
        assert "captureSource" not in _metadata_event(legacy, role="current")
    finally:
        await decoder.cancel()
