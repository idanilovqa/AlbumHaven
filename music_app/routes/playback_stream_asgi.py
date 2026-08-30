from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import dataclass
import json
import math
from typing import Any

from fastapi import APIRouter, Request, WebSocket
from fastapi.responses import JSONResponse, Response
from starlette.websockets import WebSocketDisconnect

from music_app.services.library_roots import resolve_configured_media_path
from music_app.services.loops import resolve_loop_media_path
from music_app.services.playback_pcm import (
    PcmDecoderProcess,
    PcmOpenCommand,
    PcmStreamMetadata,
    pack_pcm_frame,
)
from music_app.services.waveform_peaks import WaveformPeaksBusyError


MAX_PLAYBACK_CONNECTIONS = 6
MAX_PLAYBACK_DECODERS = 8
MAX_DECODERS_PER_CONNECTION = 2
MAX_CREDIT_FRAMES_PER_MESSAGE = 48_000
MAX_CONTROL_MESSAGE_BYTES = 16_384
MIN_PCM_SAMPLE_RATE = 8_000
MAX_PCM_SAMPLE_RATE = 192_000
MAX_TRACK_DURATION_SECONDS = 86_400
MAX_TRACK_PATH_CHARACTERS = 32_768
PCM_STREAM_SEND_COOPERATIVE_PAUSE_SECONDS = 0.001

CLOSE_INVALID_CONTROL = 4400
CLOSE_FORBIDDEN_ORIGIN = 4403
CLOSE_MEDIA_NOT_FOUND = 4404
CLOSE_CREDIT_VIOLATION = 4408
CLOSE_ROLE_CONFLICT = 4409
CLOSE_ADMISSION_EXHAUSTED = 4429

_WEBSOCKET_POST_CLOSE_SEND_ERROR = (
    'Cannot call "send" once a close message has been sent.'
)

_MAX_PROTOCOL_INTEGER = 2_147_483_647
_NORMAL_SHUTDOWN_CODE = 1001

router = APIRouter()


async def _wait_for_http_disconnect(request: Request) -> None:
    while True:
        message = await request.receive()
        if message["type"] == "http.disconnect":
            return


def _observe_cancelled_task(task: asyncio.Task[Any]) -> None:
    with suppress(BaseException):
        task.result()


@router.get("/playback/waveform")
async def playback_waveform(
    request: Request,
    path: str = "",
    loop_id: str = "",
    cachedOnly: str = "",
) -> Response:
    requested_path = str(path or "").strip()
    requested_loop_id = str(loop_id or "").strip()
    if requested_path and requested_loop_id:
        return JSONResponse(
            {"error": "Provide either path or loop_id, not both"},
            status_code=400,
        )
    resolved_path = (
        resolve_loop_media_path(request.app.state.config, requested_loop_id)
        if requested_loop_id
        else resolve_configured_media_path(request.app.state.config, requested_path)
    )
    if resolved_path is None:
        return JSONResponse({"error": "Media file not found"}, status_code=404)

    if cachedOnly == "1":
        try:
            peaks = await request.app.state.waveform_peaks_registry.get_cached(
                resolved_path,
                bins=280,
            )
        except WaveformPeaksBusyError as error:
            return JSONResponse({"error": str(error)}, status_code=429)
        if peaks is None:
            return Response(status_code=204)
        return JSONResponse(
            {
                "left": list(peaks.left),
                "right": list(peaks.right),
                "sampleCount": peaks.sample_count,
            }
        )

    peaks_task = asyncio.create_task(
        request.app.state.waveform_peaks_registry.run(
            resolved_path,
            bins=280,
        )
    )
    disconnect_task = asyncio.create_task(_wait_for_http_disconnect(request))
    try:
        completed, _pending = await asyncio.wait(
            {peaks_task, disconnect_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if disconnect_task in completed:
            if not peaks_task.done():
                peaks_task.cancel()
            await asyncio.gather(peaks_task, return_exceptions=True)
            return Response(status_code=204)
        peaks = await peaks_task
    except WaveformPeaksBusyError as error:
        return JSONResponse({"error": str(error)}, status_code=429)
    finally:
        if not peaks_task.done():
            peaks_task.cancel()
        disconnect_task.cancel()
        disconnect_task.add_done_callback(_observe_cancelled_task)
        await asyncio.gather(peaks_task, return_exceptions=True)

    return JSONResponse(
        {
            "left": list(peaks.left),
            "right": list(peaks.right),
            "sampleCount": peaks.sample_count,
        }
    )


def _gathered_failures(results: list[object]) -> list[BaseException]:
    return [result for result in results if isinstance(result, BaseException)]


def _format_cleanup_failure(error: BaseException) -> str:
    message = str(error)
    return message if message else type(error).__name__


def _bounded_integer(
    value: object,
    *,
    minimum: int,
    maximum: int,
) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < minimum or value > maximum:
        return None
    return value


def _same_origin(websocket: WebSocket) -> bool:
    origin = websocket.headers.get("origin")
    host = websocket.headers.get("host")
    if not origin or not host:
        return False
    scheme = websocket.url.scheme.lower()
    if scheme == "ws":
        scheme = "http"
    elif scheme == "wss":
        scheme = "https"
    return origin == f"{scheme}://{host}"


def _metadata_event(metadata: PcmStreamMetadata, *, role: str) -> dict[str, object]:
    return {
        "type": "metadata",
        "generation": metadata.generation,
        "streamId": metadata.stream_id,
        "role": role,
        "sampleRate": metadata.sample_rate,
        "channels": metadata.channels,
        "provisionalTotalFrames": metadata.provisional_total_frames,
        "requestedStartFrame": metadata.requested_start_frame,
        "timelineStartFrame": metadata.timeline_start_frame,
    }


@dataclass(slots=True, eq=False)
class _PlaybackStream:
    decoder: PcmDecoderProcess
    generation: int
    stream_id: int
    role: str
    sequence: int = 0
    credit_task: asyncio.Task[None] | None = None


class PlaybackPcmRegistry:
    def __init__(self) -> None:
        self._connections: set[_PlaybackPcmConnection] = set()
        self._active_decoder_count = 0
        self._lock = asyncio.Lock()
        self._shutting_down = False

    @property
    def active_connection_count(self) -> int:
        return len(self._connections)

    @property
    def active_decoder_count(self) -> int:
        return self._active_decoder_count

    async def acquire_connection(self, websocket: WebSocket) -> _PlaybackPcmConnection | None:
        async with self._lock:
            if self._shutting_down or len(self._connections) >= MAX_PLAYBACK_CONNECTIONS:
                return None
            connection = _PlaybackPcmConnection(self, websocket)
            self._connections.add(connection)
            return connection

    async def release_connection(self, connection: _PlaybackPcmConnection) -> None:
        async with self._lock:
            self._connections.discard(connection)

    async def acquire_decoder(self) -> bool:
        async with self._lock:
            if self._shutting_down or self._active_decoder_count >= MAX_PLAYBACK_DECODERS:
                return False
            self._active_decoder_count += 1
            return True

    async def release_decoder(self) -> None:
        async with self._lock:
            if self._active_decoder_count > 0:
                self._active_decoder_count -= 1

    async def shutdown(self) -> None:
        async with self._lock:
            self._shutting_down = True
            connections = list(self._connections)
        results = await asyncio.gather(
            *(connection.shutdown() for connection in connections),
            return_exceptions=True,
        )
        failures = _gathered_failures(results)
        if failures:
            details = "; ".join(_format_cleanup_failure(failure) for failure in failures)
            raise RuntimeError(f"playback registry shutdown failed: {details}")


class _PlaybackPcmConnection:
    def __init__(self, registry: PlaybackPcmRegistry, websocket: WebSocket) -> None:
        self._registry = registry
        self._websocket = websocket
        self._streams_by_id: dict[int, _PlaybackStream] = {}
        self._streams_by_role: dict[str, _PlaybackStream] = {}
        self._completed_streams_by_role: dict[str, tuple[int, int]] = {}
        self._cleanup_lock = asyncio.Lock()
        self._send_lock = asyncio.Lock()
        self._pending_opens: set[asyncio.Task[object]] = set()
        self._pending_credit_tasks: set[asyncio.Task[None]] = set()
        self._retire_tasks: set[asyncio.Task[None]] = set()
        self._transport_failed = asyncio.Event()
        self._closed = False
        self._finalized = False

    async def _send_json(self, event: dict[str, Any]) -> None:
        async with self._send_lock:
            await self._send_json_unlocked(event)

    async def _send_json_unlocked(self, event: dict[str, Any]) -> None:
        try:
            await self._websocket.send_json(event)
        except RuntimeError as error:
            if str(error) != _WEBSOCKET_POST_CLOSE_SEND_ERROR:
                raise
            raise WebSocketDisconnect(code=1006) from error

    async def _send_bytes_unlocked(self, payload: bytes) -> None:
        try:
            await self._websocket.send_bytes(payload)
        except RuntimeError as error:
            if str(error) != _WEBSOCKET_POST_CLOSE_SEND_ERROR:
                raise
            raise WebSocketDisconnect(code=1006) from error

    def _owns_stream(self, stream: _PlaybackStream) -> bool:
        return not self._closed and self._streams_by_id.get(stream.stream_id) is stream

    async def _send_stream_bytes(self, stream: _PlaybackStream, payload: bytes) -> bool:
        async with self._send_lock:
            if not self._owns_stream(stream):
                return False
            await self._send_bytes_unlocked(payload)
            return True

    async def _send_stream_eos(
        self,
        stream: _PlaybackStream,
        metadata: PcmStreamMetadata,
    ) -> bool:
        async with self._send_lock:
            if not self._owns_stream(stream):
                return False
            await self._send_json_unlocked(
                {
                    "type": "eos",
                    "generation": stream.generation,
                    "streamId": stream.stream_id,
                    "role": stream.role,
                    "emittedFrames": stream.decoder.emitted_frames,
                    "authoritativeTotalFrames": metadata.authoritative_total_frames,
                }
            )
            self._completed_streams_by_role[stream.role] = (
                stream.generation,
                stream.stream_id,
            )
            self._streams_by_id.pop(stream.stream_id, None)
            if self._streams_by_role.get(stream.role) is stream:
                self._streams_by_role.pop(stream.role, None)
        await self._registry.release_decoder()
        return True

    async def run(self) -> None:
        try:
            await self._websocket.accept()
            while not self._closed:
                message = await self._receive_or_transport_failure()
                message_type = message.get("type")
                if message_type == "websocket.disconnect":
                    break
                if message_type != "websocket.receive":
                    await self.reject(CLOSE_INVALID_CONTROL)
                    break
                if "bytes" in message and message.get("bytes") is not None:
                    await self.reject(CLOSE_INVALID_CONTROL)
                    break
                text = message.get("text")
                if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_CONTROL_MESSAGE_BYTES:
                    await self.reject(CLOSE_INVALID_CONTROL)
                    break
                try:
                    control = json.loads(text)
                except (TypeError, ValueError, json.JSONDecodeError):
                    await self.reject(CLOSE_INVALID_CONTROL)
                    break
                if not isinstance(control, dict):
                    await self.reject(CLOSE_INVALID_CONTROL)
                    break
                if not await self._handle_control(control):
                    break
        except WebSocketDisconnect:
            pass
        finally:
            await self.cleanup()

    async def _receive_or_transport_failure(self) -> dict[str, Any]:
        receive_task = asyncio.create_task(self._websocket.receive())
        failure_task = asyncio.create_task(self._transport_failed.wait())
        await asyncio.wait(
            {receive_task, failure_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if self._transport_failed.is_set():
            if not receive_task.done():
                receive_task.cancel()
            await asyncio.gather(receive_task, return_exceptions=True)
            return {"type": "websocket.disconnect"}
        failure_task.cancel()
        await asyncio.gather(failure_task, return_exceptions=True)
        return receive_task.result()

    async def _handle_control(self, control: dict[str, Any]) -> bool:
        command_type = control.get("type")
        if command_type == "open":
            return await self._open(control)
        if command_type == "credit":
            return await self._credit(control)
        if command_type == "promote":
            return await self._promote(control)
        if command_type == "close":
            return await self._close_stream(control)
        await self.reject(CLOSE_INVALID_CONTROL)
        return False

    async def _open(self, control: dict[str, Any]) -> bool:
        task = asyncio.create_task(self._open_tracked(control))
        self._pending_opens.add(task)
        try:
            return await task
        finally:
            self._pending_opens.discard(task)

    async def _open_tracked(self, control: dict[str, Any]) -> bool:
        if self._closed:
            return False
        generation = _bounded_integer(
            control.get("generation"), minimum=1, maximum=_MAX_PROTOCOL_INTEGER
        )
        stream_id = _bounded_integer(
            control.get("streamId"), minimum=1, maximum=_MAX_PROTOCOL_INTEGER
        )
        start_frame = _bounded_integer(
            control.get("startFrame"), minimum=0, maximum=_MAX_PROTOCOL_INTEGER
        )
        sample_rate = _bounded_integer(
            control.get("sampleRate"),
            minimum=MIN_PCM_SAMPLE_RATE,
            maximum=MAX_PCM_SAMPLE_RATE,
        )
        role = control.get("role")
        duration = control.get("durationSeconds")
        if (
            generation is None
            or stream_id is None
            or start_frame is None
            or sample_rate is None
            or role not in {"current", "continuity"}
            or isinstance(duration, bool)
            or not isinstance(duration, (int, float))
            or not math.isfinite(duration)
            or duration < 0
            or duration > MAX_TRACK_DURATION_SECONDS
        ):
            return await self._reject_open(CLOSE_INVALID_CONTROL)

        raw_path = control.get("path")
        if not isinstance(raw_path, str) or not raw_path:
            return await self._reject_open(CLOSE_MEDIA_NOT_FOUND)
        if len(raw_path) > MAX_TRACK_PATH_CHARACTERS:
            return await self._reject_open(CLOSE_INVALID_CONTROL)
        resolved_path = resolve_configured_media_path(
            self._websocket.app.state.config,
            raw_path,
        )
        if resolved_path is None:
            return await self._reject_open(CLOSE_MEDIA_NOT_FOUND)

        generations = {stream.generation for stream in self._streams_by_id.values()}
        generations.update(
            generation for generation, _stream_id in self._completed_streams_by_role.values()
        )
        if generations and generation not in generations:
            await self._remove_all_streams()
            self._completed_streams_by_role.clear()
        if self._closed:
            return False
        existing_by_id = self._streams_by_id.get(stream_id)
        existing_by_role = self._streams_by_role.get(role)
        if existing_by_id is not None or existing_by_role is not None:
            return await self._reject_open(CLOSE_ROLE_CONFLICT)
        if len(self._streams_by_id) >= MAX_DECODERS_PER_CONNECTION:
            return await self._reject_open(CLOSE_ADMISSION_EXHAUSTED)
        if not await self._registry.acquire_decoder():
            return await self._reject_open(CLOSE_ADMISSION_EXHAUSTED)

        command = PcmOpenCommand(
            generation=generation,
            stream_id=stream_id,
            role=role,
            path=resolved_path,
            start_frame=start_frame,
            sample_rate=sample_rate,
            provisional_duration_seconds=float(duration),
        )
        try:
            decoder = await PcmDecoderProcess.start(command)
        except BaseException as error:
            await self._registry.release_decoder()
            if not isinstance(error, Exception):
                raise
            if self._closed:
                return False
            await self._send_decoder_error(
                generation=generation,
                stream_id=stream_id,
                role=role,
                error=error,
            )
            return True

        stream = _PlaybackStream(
            decoder=decoder,
            generation=generation,
            stream_id=stream_id,
            role=role,
        )
        self._completed_streams_by_role.pop(role, None)
        for completed_role, completed_stream in list(self._completed_streams_by_role.items()):
            if completed_stream == (generation, stream_id):
                self._completed_streams_by_role.pop(completed_role, None)
        self._streams_by_id[stream_id] = stream
        self._streams_by_role[role] = stream
        if self._closed:
            return False
        await self._send_json(_metadata_event(decoder.metadata, role=role))
        return True

    async def _reject_open(self, code: int) -> bool:
        if self._closed:
            return False
        await self.reject(code)
        return False

    async def _credit(self, control: dict[str, Any]) -> bool:
        generation = _bounded_integer(
            control.get("generation"), minimum=1, maximum=_MAX_PROTOCOL_INTEGER
        )
        stream_id = _bounded_integer(
            control.get("streamId"), minimum=1, maximum=_MAX_PROTOCOL_INTEGER
        )
        frames = _bounded_integer(
            control.get("frames"), minimum=1, maximum=MAX_CREDIT_FRAMES_PER_MESSAGE
        )
        if generation is None or stream_id is None or frames is None:
            code = (
                CLOSE_CREDIT_VIOLATION
                if isinstance(control.get("frames"), int)
                and not isinstance(control.get("frames"), bool)
                and control.get("frames", 0) > MAX_CREDIT_FRAMES_PER_MESSAGE
                else CLOSE_INVALID_CONTROL
            )
            await self.reject(code)
            return False
        stream = self._streams_by_id.get(stream_id)
        if stream is None:
            if (generation, stream_id) in self._completed_streams_by_role.values():
                return True
            await self.reject(CLOSE_INVALID_CONTROL)
            return False
        if stream.generation != generation:
            await self.reject(CLOSE_INVALID_CONTROL)
            return False
        if stream.decoder.outstanding_credit_frames + frames > MAX_CREDIT_FRAMES_PER_MESSAGE:
            await self.reject(CLOSE_CREDIT_VIOLATION)
            return False

        stream.decoder.grant_credit(frames)
        if stream.credit_task is None or stream.credit_task.done():
            task = asyncio.create_task(self._drain_stream_credit(stream))
            stream.credit_task = task
            self._pending_credit_tasks.add(task)
            task.add_done_callback(self._pending_credit_tasks.discard)
        return True

    async def _drain_stream_credit(self, stream: _PlaybackStream) -> None:
        try:
            while stream.decoder.outstanding_credit_frames > 0:
                if self._closed or self._streams_by_id.get(stream.stream_id) is not stream:
                    return
                chunk = await stream.decoder.read_credited_frames(
                    max_frames=stream.decoder.outstanding_credit_frames,
                    delivery_role=stream.role,
                )
                if chunk.frame_count:
                    payload = pack_pcm_frame(
                        generation=stream.generation,
                        stream_id=stream.stream_id,
                        role=stream.role,
                        sequence=stream.sequence,
                        frame_count=chunk.frame_count,
                        pcm=chunk.pcm,
                    )
                    if not await self._send_stream_bytes(stream, payload):
                        return
                    stream.sequence += 1
                    await asyncio.sleep(PCM_STREAM_SEND_COOPERATIVE_PAUSE_SECONDS)
                    continue

                metadata = await stream.decoder.finish()
                try:
                    if not await self._send_stream_eos(stream, metadata):
                        return
                except WebSocketDisconnect:
                    await self._remove_stream(stream, cancel=False)
                    raise
                return
        except WebSocketDisconnect:
            self._closed = True
            self._transport_failed.set()
        except Exception as error:
            if self._closed or self._streams_by_id.get(stream.stream_id) is not stream:
                return
            await self._send_decoder_error(
                generation=stream.generation,
                stream_id=stream.stream_id,
                role=stream.role,
                error=error,
            )
            await self._remove_stream(stream)

    async def _promote(self, control: dict[str, Any]) -> bool:
        generation = _bounded_integer(
            control.get("generation"), minimum=1, maximum=_MAX_PROTOCOL_INTEGER
        )
        stream_id = _bounded_integer(
            control.get("streamId"), minimum=1, maximum=_MAX_PROTOCOL_INTEGER
        )
        if (
            generation is None
            or stream_id is None
            or control.get("fromRole") != "continuity"
            or control.get("toRole") != "current"
        ):
            await self.reject(CLOSE_INVALID_CONTROL)
            return False
        role_conflict = False
        async with self._send_lock:
            continuity = self._streams_by_id.get(stream_id)
            completed_continuity = self._completed_streams_by_role.get("continuity")
            continuity_is_active = (
                continuity is not None
                and continuity.generation == generation
                and continuity.role == "continuity"
            )
            continuity_is_completed = completed_continuity == (generation, stream_id)
            if not continuity_is_active and not continuity_is_completed:
                role_conflict = True
            else:
                current = self._streams_by_role.get("current")
                if current is not None:
                    self._retire_stream_unlocked(current)
                self._completed_streams_by_role.pop("current", None)
                self._completed_streams_by_role.pop("continuity", None)
                if continuity_is_active:
                    self._streams_by_role.pop("continuity", None)
                    continuity.role = "current"
                    self._streams_by_role["current"] = continuity
                else:
                    self._completed_streams_by_role["current"] = (generation, stream_id)
                await self._send_json_unlocked(
                    {
                        "type": "promoted",
                        "generation": generation,
                        "streamId": stream_id,
                        "role": "current",
                    }
                )
        if role_conflict:
            await self.reject(CLOSE_ROLE_CONFLICT)
            return False
        return True

    async def _close_stream(self, control: dict[str, Any]) -> bool:
        generation = _bounded_integer(
            control.get("generation"), minimum=1, maximum=_MAX_PROTOCOL_INTEGER
        )
        stream_id = _bounded_integer(
            control.get("streamId"), minimum=1, maximum=_MAX_PROTOCOL_INTEGER
        )
        reason = control.get("reason")
        if (
            generation is None
            or stream_id is None
            or not isinstance(reason, str)
            or not reason
            or len(reason) > 256
        ):
            await self.reject(CLOSE_INVALID_CONTROL)
            return False
        stream = self._streams_by_id.get(stream_id)
        if stream is not None:
            if stream.generation != generation:
                await self.reject(CLOSE_INVALID_CONTROL)
                return False
            await self._retire_stream(stream)
            return True

        completed_stream = (generation, stream_id)
        for role, completed in list(self._completed_streams_by_role.items()):
            if completed == completed_stream:
                self._completed_streams_by_role.pop(role, None)
                return True

        await self.reject(CLOSE_INVALID_CONTROL)
        return False

    async def _send_decoder_error(
        self,
        *,
        generation: int,
        stream_id: int,
        role: str,
        error: Exception,
    ) -> None:
        message = str(error)
        error_code = (
            "truncated_pcm"
            if message == "ffmpeg returned truncated partial PCM frame"
            else "decoder_failed"
        )
        if message.startswith("ffmpeg"):
            message = "FFmpeg" + message[len("ffmpeg") :]
        await self._send_json(
            {
                "type": "error",
                "generation": generation,
                "streamId": stream_id,
                "role": role,
                "code": error_code,
                "message": message,
                "recoverable": False,
            }
        )

    async def _remove_stream(self, stream: _PlaybackStream, *, cancel: bool = True) -> None:
        if self._streams_by_id.get(stream.stream_id) is not stream:
            return
        await self._cancel_stream_credit_task(stream)
        if cancel:
            await stream.decoder.cancel()
        self._streams_by_id.pop(stream.stream_id, None)
        if self._streams_by_role.get(stream.role) is stream:
            self._streams_by_role.pop(stream.role, None)
        await self._registry.release_decoder()

    async def _retire_stream(self, stream: _PlaybackStream) -> None:
        async with self._send_lock:
            self._retire_stream_unlocked(stream)

    def _retire_stream_unlocked(self, stream: _PlaybackStream) -> None:
        if self._streams_by_id.get(stream.stream_id) is not stream:
            return
        self._streams_by_id.pop(stream.stream_id, None)
        if self._streams_by_role.get(stream.role) is stream:
            self._streams_by_role.pop(stream.role, None)
        task = asyncio.create_task(self._release_stream(stream, cancel=True))
        self._retire_tasks.add(task)
        task.add_done_callback(self._retire_tasks.discard)

    async def _cancel_stream_credit_task(self, stream: _PlaybackStream) -> None:
        credit_task = stream.credit_task
        current_task = asyncio.current_task()
        if credit_task is not None and credit_task is not current_task and not credit_task.done():
            credit_task.cancel()
            await asyncio.gather(credit_task, return_exceptions=True)

    async def _release_stream(self, stream: _PlaybackStream, *, cancel: bool) -> None:
        await self._cancel_stream_credit_task(stream)
        if cancel:
            await stream.decoder.cancel()
        await self._registry.release_decoder()

    async def _remove_all_streams(self) -> None:
        results = await asyncio.gather(
            *(self._remove_stream(stream) for stream in list(self._streams_by_id.values())),
            return_exceptions=True,
        )
        failures = _gathered_failures(results)
        if failures:
            details = "; ".join(_format_cleanup_failure(failure) for failure in failures)
            raise RuntimeError(f"playback stream cleanup failed: {details}")

    async def reject(self, code: int) -> None:
        await self._finalize(close_code=code)

    async def shutdown(self) -> None:
        await self._finalize(close_code=_NORMAL_SHUTDOWN_CODE)

    async def cleanup(self) -> None:
        await self._finalize(close_code=None)

    async def _finalize(self, *, close_code: int | None) -> None:
        async with self._cleanup_lock:
            if self._finalized:
                return
            self._closed = True
            failures: list[BaseException] = []
            try:
                current = asyncio.current_task()
                pending = [task for task in self._pending_opens if task is not current]
                if pending:
                    results = await asyncio.gather(*pending, return_exceptions=True)
                    failures.extend(_gathered_failures(results))
                try:
                    await self._remove_all_streams()
                except Exception as error:
                    failures.append(error)
                pending_credit = [
                    task for task in self._pending_credit_tasks
                    if task is not current and not task.done()
                ]
                if pending_credit:
                    results = await asyncio.gather(*pending_credit, return_exceptions=True)
                    failures.extend(_gathered_failures(results))
                pending_retire = [
                    task for task in self._retire_tasks
                    if task is not current and not task.done()
                ]
                if pending_retire:
                    results = await asyncio.gather(*pending_retire, return_exceptions=True)
                    failures.extend(_gathered_failures(results))
                self._completed_streams_by_role.clear()
                if close_code is not None:
                    try:
                        await self._websocket.close(code=close_code)
                    except Exception as error:
                        failures.append(error)
            finally:
                await self._registry.release_connection(self)
                self._finalized = True
            if failures:
                details = "; ".join(
                    _format_cleanup_failure(failure) for failure in failures
                )
                raise RuntimeError(f"playback connection cleanup failed: {details}")


@router.websocket("/playback/pcm")
async def playback_pcm_socket(websocket: WebSocket) -> None:
    if not _same_origin(websocket):
        await websocket.close(code=CLOSE_FORBIDDEN_ORIGIN)
        return
    registry: PlaybackPcmRegistry = websocket.app.state.playback_pcm_registry
    connection = await registry.acquire_connection(websocket)
    if connection is None:
        await websocket.close(code=CLOSE_ADMISSION_EXHAUSTED)
        return
    await connection.run()
