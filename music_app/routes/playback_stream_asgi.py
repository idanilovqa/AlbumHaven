from __future__ import annotations

from music_app.services.loop_request_scope import saved_loop_scope

import asyncio
from contextlib import suppress
from dataclasses import dataclass
import json
import logging
import math
from pathlib import Path
import subprocess
import time
from typing import Any, Coroutine

from fastapi import APIRouter, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse, Response
from starlette.websockets import WebSocketDisconnect

from music_app.routes.playback_control_asgi import playback_config
from music_app.services import playback_timing
from music_app.services.library_roots import (
    configured_library_root_paths_snapshot,
    resolve_configured_media_path,
)
from music_app.services.loops import resolve_loop_media_path
from music_app.services.mp3_stream_map import mp3_stream_map
from music_app.services.playback_io import run_playback_io
from music_app.services.playback_seek_table import flac_seek_table
from music_app.services.playback_encoded import (
    INITIAL_ENCODED_CREDIT_BYTES,
    EncodedStream,
    fallback_sample_rate,
    open_encoded_stream,
)
from music_app.services.playback_pcm import (
    PcmDecoderProcess,
    PcmOpenCommand,
    PcmStreamMetadata,
    SampleRateMismatch,
    pack_encoded_frame,
    pack_pcm_frame,
    read_native_sample_rate,
)
from music_app.services.playback_references import PlaybackContractError, PlaybackReferenceService
from music_app.services.waveform_peaks import (
    WAVEFORM_ANALYZER_VERSION,
    WaveformPeaksBusyError,
)
from music_app.services.policy_asgi import require_action


MAX_PLAYBACK_CONNECTIONS = 6
MAX_PLAYBACK_DECODERS = 8
MAX_DECODERS_PER_CONNECTION = 2
# Opens and probes run beside the control loop, closed ones until they finish; past this many the
# loop waits for one, so a client pressing faster than the server answers queues no unbounded work.
MAX_PENDING_CONTROLS_PER_CONNECTION = 4
MAX_CONTROL_MESSAGE_BYTES = 16_384
# A client that asks (`/playback/pcm?heartbeat=<ms>`) hears from the server at least this often.
MIN_HEARTBEAT_MS = 100
MAX_HEARTBEAT_MS = 10_000
MIN_PCM_SAMPLE_RATE = 8_000
MAX_PCM_SAMPLE_RATE = 192_000
MAX_CREDIT_FRAMES_PER_MESSAGE = MAX_PCM_SAMPLE_RATE
MAX_TRACK_DURATION_SECONDS = 86_400
MAX_TRACK_PATH_CHARACTERS = 32_768
PCM_STREAM_SEND_COOPERATIVE_PAUSE_SECONDS = 0
PCM_SLOW_STEP_LOG_SECONDS = 1.0

CLOSE_INVALID_CONTROL = 4400
CLOSE_UNAUTHENTICATED = 4401
CLOSE_FORBIDDEN_ORIGIN = 4403
CLOSE_MEDIA_NOT_FOUND = 4404
CLOSE_CREDIT_VIOLATION = 4408
CLOSE_ROLE_CONFLICT = 4409
CLOSE_ADMISSION_EXHAUSTED = 4429

_WEBSOCKET_POST_CLOSE_SEND_ERROR = (
    'Cannot call "send" once a close message has been sent.'
)

_MAX_PROTOCOL_INTEGER = 2_147_483_647
_MAX_EPOCH_MS = 2**53 - 1
_START_REPORT_DURATIONS = {
    "firstPressMs": "first_press_ms",
    "openMs": "open_ms",
    "metadataMs": "metadata_ms",
    "firstBytesMs": "first_bytes_ms",
    "decodedMs": "decoded_ms",
    "audibleMs": "audible_ms",
}
_UNHEARD_OUTCOMES = {"replaced", "paused", "seek", "stopped", "waiting"}
_UNHEARD_REPORT_DURATIONS = {
    "firstPressMs": "first_press_ms",
    "openMs": "open_ms",
    "metadataMs": "metadata_ms",
    "firstBytesMs": "first_bytes_ms",
    "decodedMs": "decoded_ms",
    "prepareMs": "prepare_ms",
    "endedMs": "ended_ms",
}
_UNHEARD_REPORT_KEYS = {
    "type", "outcome", "prepared", "pressedStreamId", "presses", "pressedAtEpochMs",
    *_UNHEARD_REPORT_DURATIONS,
}
_START_REPORT_KEYS = {
    "type", "generation", "audibleStreamId", "prepared", "presses", "pressedAtEpochMs",
    *_START_REPORT_DURATIONS,
}
_NORMAL_SHUTDOWN_CODE = 1001

router = APIRouter()
_LOGGER = logging.getLogger(__name__)


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
    bins: int = 280,
) -> Response:
    if bins not in {280, 720}:
        return JSONResponse({"error": "Unsupported waveform sample count"}, status_code=400)
    requested_path = str(path or "").strip()
    requested_loop_id = str(loop_id or "").strip()
    if requested_path and requested_loop_id:
        return JSONResponse(
            {"error": "Provide either path or loop_id, not both"},
            status_code=400,
        )
    loop_scope = await saved_loop_scope(request) if requested_loop_id else None
    resolved_path = (
        await asyncio.to_thread(
            resolve_loop_media_path,
            request.app.state.config,
            requested_loop_id,
            **loop_scope,
        )
        if loop_scope is not None
        else await asyncio.to_thread(resolve_configured_media_path, request.app.state.config, requested_path)
    )
    if resolved_path is None:
        return JSONResponse({"error": "Media file not found"}, status_code=404)

    loop_cache = (
        getattr(request.app.state, "saved_loop_waveform_peak_cache_repository", None)
        if loop_scope is not None
        else None
    )
    loop_cache_identity = None
    if loop_cache is not None:
        try:
            stat = await asyncio.to_thread(resolved_path.stat)
        except OSError:
            return JSONResponse({"error": "Media file not found"}, status_code=404)
        loop_cache_identity = {
            **loop_scope,
            "loop_id": requested_loop_id,
            "file_size_bytes": int(stat.st_size),
            "modified_at_ns": int(stat.st_mtime_ns),
            "sample_count": bins,
            "analyzer_version": WAVEFORM_ANALYZER_VERSION,
        }
        try:
            peaks = await asyncio.to_thread(
                loop_cache.get_for_loop,
                **loop_cache_identity,
            )
        except Exception as error:
            _LOGGER.warning("Saved-loop waveform cache read failed: %s", error)
        else:
            if peaks is not None:
                return JSONResponse(
                    {
                        "left": list(peaks.left),
                        "right": list(peaks.right),
                        "sampleCount": peaks.sample_count,
                    }
                )

    if cachedOnly == "1":
        if loop_scope is not None:
            return Response(status_code=204)
        try:
            peaks = await request.app.state.waveform_peaks_registry.get_cached(
                resolved_path,
                bins=bins,
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
            bins=bins,
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

    if loop_cache is not None and loop_cache_identity is not None:
        try:
            current_stat = await asyncio.to_thread(resolved_path.stat)
        except OSError:
            current_stat = None
        if (
            current_stat is not None
            and int(current_stat.st_size) == loop_cache_identity["file_size_bytes"]
            and int(current_stat.st_mtime_ns) == loop_cache_identity["modified_at_ns"]
        ):
            try:
                await asyncio.to_thread(
                    loop_cache.put_for_loop,
                    **loop_cache_identity,
                    peaks=peaks,
                )
            except Exception as error:
                _LOGGER.warning("Saved-loop waveform cache write failed: %s", error)

    return JSONResponse(
        {
            "left": list(peaks.left),
            "right": list(peaks.right),
            "sampleCount": peaks.sample_count,
        }
    )


def _gathered_failures(results: list[object]) -> list[BaseException]:
    return [result for result in results if isinstance(result, BaseException)]


class _PlaybackCleanupError(RuntimeError):
    """Cleanup aggregate containing only operation labels and sanitized failures."""


def _format_cleanup_failure(error: BaseException) -> str:
    # Decoder exceptions can contain private media paths or protocol tokens.
    if isinstance(error, _PlaybackCleanupError):
        return str(error)
    return type(error).__name__


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


def _metadata_event(
    metadata: PcmStreamMetadata,
    *,
    role: str,
    encoded: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        **(encoded or {}),
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


def _encoded_fields(decoder: object) -> dict[str, object] | None:
    if not isinstance(decoder, EncodedStream):
        return None
    return {
        "codec": decoder.codec,
        "skipFrames": decoder.skip_frames,
        "totalFrames": decoder.total_frames,
        "initialCreditBytes": INITIAL_ENCODED_CREDIT_BYTES,
    }


def _resolve_socket_media_path(config: dict[str, object], raw_path: str) -> Path | None:
    """Resolves a client path against the roots snapshot root saves keep current, so a start
    never reads the root settings from the database again."""
    return resolve_configured_media_path(
        config,
        raw_path,
        configured_root_paths=configured_library_root_paths_snapshot(config),
    )


def _decoder_name(decoder: object) -> str:
    return f"encoded-{decoder.codec}" if isinstance(decoder, EncodedStream) else "ffmpeg-pcm"


def _elapsed_ms(started_at: float, at: float | None) -> str:
    return "-" if at is None else str(round((at - started_at) * 1000))


@dataclass(slots=True, eq=False)
class _OpenTicket:
    """An open running beside the control loop; a close of its stream abandons it.

    An abandoned open sends nothing more and cancels the decoder it started; it is not cancelled
    itself, because a decoder start cut off midway could leave its process behind.
    """

    generation: int | None
    abandoned: bool = False


@dataclass(slots=True, eq=False)
class _OpenTiming:
    """Monotonic milestones of one `open`, logged once as one path-free line of fixed keys.

    Every milestone counts from the open's arrival: the media resolved (authorization and
    reference included), the decoder started or refused, the first credit, the first decoded PCM
    and its send. The client's credit gates decoding, so a late first credit is the client's wait.
    """

    generation: int
    stream_id: int
    role: str
    received_at: float
    resolved_at: float | None = None
    decoder_started_at: float | None = None
    first_credit_at: float | None = None
    first_decoded_at: float | None = None
    first_sent_at: float | None = None
    decoder: str = "-"
    logged: bool = False

    def log(self, outcome: str) -> None:
        if self.logged:
            return
        self.logged = True
        _LOGGER.info(
            "Playback stream open generation=%s stream=%s role=%s decoder=%s outcome=%s "
            "resolve_ms=%s decoder_start_ms=%s first_credit_ms=%s first_decoded_ms=%s "
            "first_sent_ms=%s",
            self.generation,
            self.stream_id,
            self.role,
            self.decoder,
            outcome,
            _elapsed_ms(self.received_at, self.resolved_at),
            _elapsed_ms(self.received_at, self.decoder_started_at),
            _elapsed_ms(self.received_at, self.first_credit_at),
            _elapsed_ms(self.received_at, self.first_decoded_at),
            _elapsed_ms(self.received_at, self.first_sent_at),
        )


@dataclass(slots=True, eq=False)
class _PlaybackStream:
    decoder: PcmDecoderProcess
    generation: int
    stream_id: int
    role: str
    sequence: int = 0
    credit_task: asyncio.Task[None] | None = None
    timing: _OpenTiming | None = None

    def log_open_timing(self, outcome: str) -> None:
        if self.timing is not None:
            self.timing.log(outcome)


def _log_slow_stream_step(step: str, stream: _PlaybackStream, started_at: float) -> None:
    elapsed_seconds = time.monotonic() - started_at
    if elapsed_seconds >= PCM_SLOW_STEP_LOG_SECONDS:
        _LOGGER.warning(
            "Playback %s took %.2fs generation=%s stream=%s role=%s sequence=%s",
            step,
            elapsed_seconds,
            stream.generation,
            stream.stream_id,
            stream.role,
            stream.sequence,
        )


class PlaybackPcmRegistry:
    def __init__(self) -> None:
        self._connections: set[_PlaybackPcmConnection] = set()
        self._active_decoder_count = 0
        self._lock = asyncio.Lock()
        self._shutting_down = False
        # Timing only: sockets are numbered, and the loop is watched while any is open.
        self._socket_count = 0
        self._loop_watch: asyncio.Task[None] | None = None

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
            if playback_timing.ENABLED:
                self._socket_count += 1
                connection.timing_socket = self._socket_count
                if self._loop_watch is None:
                    self._loop_watch = asyncio.create_task(playback_timing.watch_event_loop())
            return connection

    async def release_connection(self, connection: _PlaybackPcmConnection) -> None:
        async with self._lock:
            self._connections.discard(connection)
            if self._loop_watch is not None and not self._connections:
                self._loop_watch.cancel()
                self._loop_watch = None

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


def _decoder_error_event(
    *, generation: int, stream_id: int, role: str, error: Exception
) -> dict[str, Any]:
    truncated = str(error) == "ffmpeg returned truncated partial PCM frame"
    return {
        "type": "error",
        "generation": generation,
        "streamId": stream_id,
        "role": role,
        "code": "truncated_pcm" if truncated else "decoder_failed",
        "message": (
            "FFmpeg returned truncated partial PCM frame" if truncated else "Audio decoder failed."
        ),
        "recoverable": False,
    }


class _PlaybackPcmConnection:
    def __init__(self, registry: PlaybackPcmRegistry, websocket: WebSocket) -> None:
        self._registry = registry
        self._websocket = websocket
        self._streams_by_id: dict[int, _PlaybackStream] = {}
        self._streams_by_role: dict[str, _PlaybackStream] = {}
        self._completed_streams_by_role: dict[str, tuple[int, int]] = {}
        self._cleanup_lock = asyncio.Lock()
        self._send_lock = asyncio.Lock()
        # Opens and probes run beside the control loop, so their authority refresh and file work
        # never hold the controls after them: a switch's close and open, or the playing song's
        # credits (measured with the CPU at 100%: a switch waited 1.8-2.3 s behind the open it
        # closed). Shutdown still waits for them.
        self._pending_controls: set[asyncio.Task[bool]] = set()
        self._open_tickets: dict[int, _OpenTicket] = {}
        self._control_failure: BaseException | None = None
        self._pending_credit_tasks: set[asyncio.Task[None]] = set()
        self._retire_tasks: set[asyncio.Task[None]] = set()
        self._transport_failed = asyncio.Event()
        self._heartbeat_task: asyncio.Task[None] | None = None
        self.timing_socket = 0
        self._client_close_code: int | None = None
        self._closed = False
        self._finalized = False

    async def _send_json(self, event: dict[str, Any]) -> None:
        waiting_since = time.perf_counter()
        async with self._send_lock:
            await self._send_answer_unlocked(event, waiting_since)

    async def _send_answer_unlocked(self, event: dict[str, Any], waiting_since: float) -> None:
        timing = playback_timing.CONTROL.get()
        if timing is not None:
            timing.mark("send_lock_wait_ms", playback_timing.elapsed_ms(waiting_since))
        await self._send_json_unlocked(event)
        if timing is not None:
            timing.mark("sent_at", playback_timing.epoch_ms())

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

    def _requested_heartbeat_seconds(self) -> float | None:
        requested = self._websocket.query_params.get("heartbeat", "")
        milliseconds = _bounded_integer(
            int(requested) if requested.isdecimal() else None,
            minimum=MIN_HEARTBEAT_MS,
            maximum=MAX_HEARTBEAT_MS,
        )
        return None if milliseconds is None else milliseconds / 1000

    async def _beat(self, interval_seconds: float) -> None:
        """Tells the client its connection lives, however long the server takes to answer.

        A client cannot tell a connection that died without closing from a busy server by how long
        its answers take (a server with the CPU at 100% answers slowly); it can by
        hearing nothing at all.
        """
        with suppress(WebSocketDisconnect, OSError, RuntimeError):
            while not self._closed:
                due_at = time.perf_counter() + interval_seconds
                await asyncio.sleep(interval_seconds)
                if not self._closed:
                    await self._send_json({"type": "heartbeat"})
                    if playback_timing.ENABLED:
                        late = time.perf_counter() - due_at
                        if late > playback_timing.HEARTBEAT_LATE_SECONDS:
                            playback_timing.log(
                                "heartbeat-late", socket=self.timing_socket, late_ms=round(late * 1000)
                            )

    async def run(self) -> None:
        try:
            await self._websocket.accept()
            if playback_timing.ENABLED:
                playback_timing.log("socket-accepted", socket=self.timing_socket, at=playback_timing.epoch_ms())
            heartbeat_seconds = self._requested_heartbeat_seconds()
            if heartbeat_seconds is not None:
                self._heartbeat_task = asyncio.create_task(self._beat(heartbeat_seconds))
            while not self._closed:
                message = await self._receive_or_transport_failure()
                message_type = message.get("type")
                if message_type == "websocket.disconnect":
                    self._client_close_code = _bounded_integer(message.get("code"), minimum=0, maximum=4999)
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
        if self._control_failure is not None:
            raise self._control_failure

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
        if command_type in ("probe", "open"):
            if len(self._pending_controls) >= MAX_PENDING_CONTROLS_PER_CONNECTION:
                await asyncio.wait(self._pending_controls, return_when=asyncio.FIRST_COMPLETED)
            task = (
                self._start_control(self._timed(control, self._probe(control)))
                if command_type == "probe"
                else self._start_open(control)
            )
            task.add_done_callback(self._control_finished)
            return True
        if command_type == "credit":
            return await self._credit(control)
        if command_type == "promote":
            return await self._promote(control)
        if command_type == "close":
            return await self._close_stream(control)
        if command_type == "stall-report":
            return await self._log_client_stall(control)
        if command_type == "decoder-fallback":
            return await self._log_decoder_fallback(control)
        if command_type == "output-report":
            return await self._log_audio_output(control)
        if command_type == "start-report":
            return await self._log_client_start(control)
        if command_type == "unheard-report":
            return await self._log_client_unheard(control)
        # A paused client's socket carries nothing; proxies close an idle WebSocket after about
        # 100 seconds, so clients that cannot send WebSocket pings send this instead.
        if command_type == "keepalive" and set(control) == {"type"}:
            return True
        await self.reject(CLOSE_INVALID_CONTROL)
        return False

    async def _log_audio_output(self, control: dict[str, Any]) -> bool:
        fields = {
            name: _bounded_integer(
                control.get(name), minimum=0, maximum=_MAX_PROTOCOL_INTEGER
            )
            for name in (
                "sampleRate",
                "baseLatencyMs",
                "outputLatencyMs",
                "underruns",
                "underrunMs",
            )
        }
        stats_available = control.get("statsAvailable")
        if None in fields.values() or not isinstance(stats_available, bool):
            await self.reject(CLOSE_INVALID_CONTROL)
            return False
        _LOGGER.warning(
            "Playback audio output rate=%s base_latency_ms=%s output_latency_ms=%s "
            "underruns=%s underrun_ms=%s stats_available=%s",
            fields["sampleRate"],
            fields["baseLatencyMs"],
            fields["outputLatencyMs"],
            fields["underruns"],
            fields["underrunMs"],
            stats_available,
        )
        return True

    async def _log_client_start(self, control: dict[str, Any]) -> bool:
        """A page's timed press. Numbers only, so a page cannot put text in the log."""
        generation, stream_id, presses = (
            _bounded_integer(control.get(name), minimum=1, maximum=_MAX_PROTOCOL_INTEGER)
            for name in ("generation", "audibleStreamId", "presses")
        )
        pressed_at = _bounded_integer(control.get("pressedAtEpochMs"), minimum=0, maximum=_MAX_EPOCH_MS)
        durations = {
            key: _bounded_integer(control.get(name), minimum=0, maximum=_MAX_PROTOCOL_INTEGER)
            for name, key in _START_REPORT_DURATIONS.items()
        }
        if (
            set(control) != _START_REPORT_KEYS
            or None in (generation, stream_id, presses, pressed_at)
            or not isinstance(control.get("prepared"), bool)
            or any(
                durations[key] is None and control.get(name) is not None
                for name, key in _START_REPORT_DURATIONS.items()
            )
        ):
            await self.reject(CLOSE_INVALID_CONTROL)
            return False
        if playback_timing.ENABLED:
            playback_timing.log(
                "client-start",
                socket=self.timing_socket,
                kind="prepared" if control["prepared"] else "opened",
                generation=generation,
                stream=stream_id,
                pressed_at=pressed_at,
                presses=presses,
                **durations,
            )
        return True

    async def _log_client_unheard(self, control: dict[str, Any]) -> bool:
        """A page's press that did not sound: numbers and one word from a fixed list."""
        outcome, stream_id = control.get("outcome"), control.get("pressedStreamId")
        presses = _bounded_integer(control.get("presses"), minimum=1, maximum=_MAX_PROTOCOL_INTEGER)
        pressed_at = _bounded_integer(control.get("pressedAtEpochMs"), minimum=0, maximum=_MAX_EPOCH_MS)
        durations = {
            key: _bounded_integer(control.get(name), minimum=0, maximum=_MAX_PROTOCOL_INTEGER)
            for name, key in _UNHEARD_REPORT_DURATIONS.items()
        }
        if (
            set(control) != _UNHEARD_REPORT_KEYS
            or not isinstance(outcome, str)
            or outcome not in _UNHEARD_OUTCOMES
            or not isinstance(control.get("prepared"), bool)
            or None in (presses, pressed_at)
            or (
                stream_id is not None
                and _bounded_integer(stream_id, minimum=1, maximum=_MAX_PROTOCOL_INTEGER) is None
            )
            or any(
                durations[key] is None and control.get(name) is not None
                for name, key in _UNHEARD_REPORT_DURATIONS.items()
            )
        ):
            await self.reject(CLOSE_INVALID_CONTROL)
            return False
        if playback_timing.ENABLED:
            playback_timing.log(
                "client-unheard",
                socket=self.timing_socket,
                kind="prepared" if control["prepared"] else "opened",
                outcome=outcome,
                stream=stream_id,
                pressed_at=pressed_at,
                presses=presses,
                **durations,
            )
        return True

    async def _log_decoder_fallback(self, control: dict[str, Any]) -> bool:
        reason = control.get("reason")
        if not isinstance(reason, str) or not reason or len(reason) > 64:
            await self.reject(CLOSE_INVALID_CONTROL)
            return False
        _LOGGER.warning("Playback client fell back to server decoding: %r", reason)
        return True

    async def _log_client_stall(self, control: dict[str, Any]) -> bool:
        fields = {
            name: _bounded_integer(
                control.get(name), minimum=0, maximum=_MAX_PROTOCOL_INTEGER
            )
            for name in ("generation", "streamId", "durationMs", "targetBufferFrames")
        }
        page_visible = control.get("pageVisible")
        if None in fields.values() or not isinstance(page_visible, bool):
            await self.reject(CLOSE_INVALID_CONTROL)
            return False
        _LOGGER.warning(
            "Playback client stall %.2fs generation=%s stream=%s "
            "target_buffer_frames=%s page_visible=%s",
            fields["durationMs"] / 1000,
            fields["generation"],
            fields["streamId"],
            fields["targetBufferFrames"],
            page_visible,
        )
        return True

    async def _authorize_media_read(self) -> bool:
        try:
            await require_action(
                "library.media.read",
                refresh_actor=True,
            )(self._websocket)
        except HTTPException as exc:
            await self.reject(
                CLOSE_UNAUTHENTICATED
                if exc.status_code == 401
                else CLOSE_FORBIDDEN_ORIGIN
            )
            return False
        return True

    async def _probe(self, control: dict[str, Any]) -> bool:
        if not await self._authorize_media_read():
            return False
        request_id = _bounded_integer(
            control.get("requestId"), minimum=1, maximum=_MAX_PROTOCOL_INTEGER
        )
        raw_path = control.get("path")
        if (
            request_id is None
            or not isinstance(raw_path, str)
            or len(raw_path) > MAX_TRACK_PATH_CHARACTERS
        ):
            await self.reject(CLOSE_INVALID_CONTROL)
            return False
        resolved_path = (
            await run_playback_io(
                playback_timing.timed_work("resolve", _resolve_socket_media_path),
                self._websocket.app.state.config,
                raw_path,
            )
            if raw_path
            else None
        )
        if resolved_path is None:
            await self.reject(CLOSE_MEDIA_NOT_FOUND)
            return False
        if control.get("authorityOnly") is True:
            # A press on an already decoded track: refreshed and resolved as an open, nothing read.
            await self._send_json({"type": "probe-result", "requestId": request_id})
            return True
        size_bytes = 0
        try:
            sample_rate = await run_playback_io(read_native_sample_rate, resolved_path)
            size_bytes = await run_playback_io(lambda: resolved_path.stat().st_size)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            _LOGGER.warning("Playback sample rate probe failed: %s", type(error).__name__)
            sample_rate = 0
        await self._send_json(
            {
                "type": "probe-result",
                "requestId": request_id,
                "sampleRate": sample_rate,
                "fallbackSampleRate": fallback_sample_rate(sample_rate),
                "sizeBytes": size_bytes,
            }
        )
        return True

    def _timed(
        self, control: dict[str, Any], answer: Coroutine[Any, Any, bool]
    ) -> Coroutine[Any, Any, bool]:
        if not playback_timing.ENABLED:
            return answer
        is_open = control.get("type") == "open"
        timing = playback_timing.ControlTiming(
            self.timing_socket,
            "open" if is_open else "refresh-probe" if control.get("authorityOnly") is True else "probe",
            _bounded_integer(control.get("generation"), minimum=1, maximum=_MAX_PROTOCOL_INTEGER),
            _bounded_integer(
                control.get("streamId" if is_open else "requestId"), minimum=1, maximum=_MAX_PROTOCOL_INTEGER
            ),
            _bounded_integer(control.get("clientSentAtEpochMs"), minimum=0, maximum=_MAX_EPOCH_MS),
        )
        return playback_timing.timed_control(timing, answer)

    def _start_control(self, work: Coroutine[Any, Any, bool]) -> asyncio.Task[bool]:
        task = asyncio.create_task(work)
        self._pending_controls.add(task)
        task.add_done_callback(self._pending_controls.discard)
        return task

    def _start_open(self, control: dict[str, Any]) -> asyncio.Task[bool]:
        generation = _bounded_integer(
            control.get("generation"), minimum=1, maximum=_MAX_PROTOCOL_INTEGER
        )
        stream_id = _bounded_integer(
            control.get("streamId"), minimum=1, maximum=_MAX_PROTOCOL_INTEGER
        )
        ticket = _OpenTicket(generation)
        # A new generation replaces every stream of the old one, those still opening too.
        for pending in self._open_tickets.values():
            if pending.generation != generation:
                pending.abandoned = True
        if stream_id is not None and stream_id not in self._open_tickets:
            self._open_tickets[stream_id] = ticket
        task = self._start_control(self._timed(control, self._open_tracked(control, ticket)))
        if self._open_tickets.get(stream_id) is ticket:
            task.add_done_callback(lambda _task: self._forget_open_ticket(stream_id, ticket))
        return task

    def _forget_open_ticket(self, stream_id: int, ticket: _OpenTicket) -> None:
        if self._open_tickets.get(stream_id) is ticket:
            del self._open_tickets[stream_id]

    def _control_finished(self, task: asyncio.Task[bool]) -> None:
        """An open or a probe that fails ends the connection, as it did inside the control loop."""
        if task.cancelled():
            return
        error = task.exception()
        if error is None:
            return
        if not isinstance(error, WebSocketDisconnect) and self._control_failure is None:
            self._control_failure = error
        self._closed = True
        self._transport_failed.set()

    async def _send_open_event(self, ticket: _OpenTicket, event: dict[str, Any]) -> None:
        """Sends an open's answer unless a close abandoned the open: nothing follows a close."""
        waiting_since = time.perf_counter()
        async with self._send_lock:
            if not ticket.abandoned:
                await self._send_answer_unlocked(event, waiting_since)

    def _resolve_while_authorizing(
        self, control: dict[str, Any]
    ) -> asyncio.Future[Path | None] | None:
        """Resolves an open's path, and scans an MP3's frames, while the actor refresh runs.

        Under load each waits on the database or the disk; side by side, the open waits for the
        slower one instead of both. The socket was authorized when it connected, nothing is sent
        before the refresh passes, and the scan only fills the frame-map cache the open reads.
        """
        raw_path = control.get("path")
        if (
            not isinstance(raw_path, str)
            or not raw_path
            or len(raw_path) > MAX_TRACK_PATH_CHARACTERS
        ):
            return None
        config = self._websocket.app.state.config
        codecs = control.get("codecs")
        scan_mp3 = (
            raw_path.lower().endswith(".mp3") and isinstance(codecs, list) and "mp3" in codecs
        )

        timing = playback_timing.CONTROL.get()

        def resolve() -> Path | None:
            resolved = _resolve_socket_media_path(config, raw_path)
            if resolved is not None and scan_mp3:
                scan = mp3_stream_map if timing is None else timing.timed("mp3_scan", mp3_stream_map)
                with suppress(Exception):  # The open scans again and reports its own failure.
                    scan(resolved)
            return resolved

        resolution = asyncio.ensure_future(run_playback_io(playback_timing.timed_work("resolve", resolve)))
        self._pending_credit_tasks.add(resolution)
        resolution.add_done_callback(self._pending_credit_tasks.discard)
        # A rejected open never awaits its resolution; its failure must not go unretrieved.
        resolution.add_done_callback(lambda done: done.cancelled() or done.exception())
        return resolution

    async def _open_tracked(self, control: dict[str, Any], ticket: _OpenTicket) -> bool:
        received_at = time.monotonic()
        if self._closed:
            return False
        resolution = self._resolve_while_authorizing(control)
        if not await self._authorize_media_read():
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
        raw_codecs = control.get("codecs", [])
        codecs_valid = isinstance(raw_codecs, list) and all(
            codec in ("mp3", "flac") for codec in raw_codecs
        )
        quality = control.get("quality", "original")
        # Clients that seek inside received bytes ask for the stream's seek table.
        wants_seek_table = control.get("seekTable", False)
        if (
            not isinstance(wants_seek_table, bool)
            or not codecs_valid
            or quality not in ("original", "320")
            or generation is None
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
            return await self._reject_open(ticket, CLOSE_INVALID_CONTROL)

        timing = _OpenTiming(generation, stream_id, role, received_at)
        if "path" in control and "playbackRef" in control:
            return await self._reject_open(ticket, CLOSE_INVALID_CONTROL)
        if "playbackRef" in control:
            try:
                service = PlaybackReferenceService(playback_config(self._websocket))
                resolved_path = await run_playback_io(service.resolve,
                    self._websocket.state.current_actor, control["playbackRef"])
            except PlaybackContractError:
                return await self._reject_open(ticket, CLOSE_MEDIA_NOT_FOUND)
        else:
            raw_path = control.get("path")
            if not isinstance(raw_path, str) or not raw_path:
                return await self._reject_open(ticket, CLOSE_MEDIA_NOT_FOUND)
            if len(raw_path) > MAX_TRACK_PATH_CHARACTERS:
                return await self._reject_open(ticket, CLOSE_INVALID_CONTROL)
            resolved_path = await resolution
        if resolved_path is None:
            return await self._reject_open(ticket, CLOSE_MEDIA_NOT_FOUND)
        timing.resolved_at = time.monotonic()
        if ticket.abandoned:
            return True

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
            return await self._reject_open(ticket, CLOSE_ROLE_CONFLICT)
        if len(self._streams_by_id) >= MAX_DECODERS_PER_CONNECTION:
            return await self._reject_open(ticket, CLOSE_ADMISSION_EXHAUSTED)
        if not await self._registry.acquire_decoder():
            return await self._reject_open(ticket, CLOSE_ADMISSION_EXHAUSTED)

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
            decoder = await open_encoded_stream(
                command,
                codecs=frozenset(raw_codecs),
                quality=quality,
            ) or await PcmDecoderProcess.start(command)
        except BaseException as error:
            timing.decoder_started_at = time.monotonic()
            await self._registry.release_decoder()
            if not isinstance(error, Exception):
                raise
            if self._closed:
                return False
            timing.log("rate_mismatch" if isinstance(error, SampleRateMismatch) else "decoder_error")
            if isinstance(error, SampleRateMismatch):
                await self._send_open_event(
                    ticket,
                    {
                        "type": "rate-mismatch",
                        "generation": generation,
                        "streamId": stream_id,
                        "sampleRate": error.native_rate,
                        "fallbackSampleRate": fallback_sample_rate(error.native_rate),
                    },
                )
                return True
            await self._send_open_event(
                ticket,
                _decoder_error_event(
                    generation=generation, stream_id=stream_id, role=role, error=error
                ),
            )
            return True

        timing.decoder_started_at = time.monotonic()
        if ticket.abandoned:
            await decoder.cancel()
            await self._registry.release_decoder()
            return True
        timing.decoder = _decoder_name(decoder)
        stream = _PlaybackStream(
            decoder=decoder,
            generation=generation,
            stream_id=stream_id,
            role=role,
            timing=timing,
        )
        self._completed_streams_by_role.pop(role, None)
        for completed_role, completed_stream in list(self._completed_streams_by_role.items()):
            if completed_stream == (generation, stream_id):
                self._completed_streams_by_role.pop(completed_role, None)
        self._streams_by_id[stream_id] = stream
        self._streams_by_role[role] = stream
        if self._closed:
            return False
        metadata = _metadata_event(decoder.metadata, role=role, encoded=_encoded_fields(decoder))
        if playback_timing.ENABLED:
            # Asks the page to report where its presses waited (`start-report`).
            metadata["timing"] = True
            # Apart from `timing`, which a server older than the unheard-press line also sends.
            metadata["timingUnheard"] = True
        await self._send_open_event(ticket, metadata)
        if ticket.abandoned:
            return True
        if isinstance(decoder, EncodedStream):
            self._grant_credit(stream, INITIAL_ENCODED_CREDIT_BYTES)
            if wants_seek_table:
                self._send_seek_table(stream, decoder)
        return True

    def _send_seek_table(self, stream: _PlaybackStream, decoder: EncodedStream) -> None:
        """Sends the stream's seek table: at once for MP3, once its frames are scanned for FLAC."""
        async def send() -> None:
            table = decoder.seek_table
            if table is None and decoder.flac_layout is not None:
                table = await asyncio.to_thread(flac_seek_table, *decoder.flac_layout)
            if table is None or self._closed or self._streams_by_id.get(stream.stream_id) is not stream:
                return
            await self._send_json(table.event(generation=stream.generation, stream_id=stream.stream_id))

        task = asyncio.create_task(send())
        self._pending_credit_tasks.add(task)
        task.add_done_callback(self._pending_credit_tasks.discard)

    async def _reject_open(self, ticket: _OpenTicket, code: int) -> bool:
        if ticket.abandoned:
            return True
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
        if (generation, stream_id) in self._completed_streams_by_role.values():
            return True
        stream = self._streams_by_id.get(stream_id) if stream_id is not None else None
        credit_limit = (
            EncodedStream.max_outstanding_credit
            if stream is not None and isinstance(stream.decoder, EncodedStream)
            else MAX_CREDIT_FRAMES_PER_MESSAGE
        )
        frames = _bounded_integer(control.get("frames"), minimum=1, maximum=credit_limit)
        if generation is None or stream_id is None or frames is None:
            code = (
                CLOSE_CREDIT_VIOLATION
                if isinstance(control.get("frames"), int)
                and not isinstance(control.get("frames"), bool)
                and control.get("frames", 0) > credit_limit
                else CLOSE_INVALID_CONTROL
            )
            await self.reject(code)
            return False
        if stream is None or stream.generation != generation:
            await self.reject(CLOSE_INVALID_CONTROL)
            return False
        if stream.decoder.outstanding_credit_frames + frames > credit_limit:
            await self.reject(CLOSE_CREDIT_VIOLATION)
            return False

        self._grant_credit(stream, frames)
        return True

    def _grant_credit(self, stream: _PlaybackStream, amount: int) -> None:
        if stream.timing is not None and stream.timing.first_credit_at is None:
            stream.timing.first_credit_at = time.monotonic()
        stream.decoder.grant_credit(amount)
        self._start_credit_drain(stream)

    def _start_credit_drain(self, stream: _PlaybackStream) -> None:
        if stream.credit_task is None or stream.credit_task.done():
            task = asyncio.create_task(self._drain_stream_credit(stream))
            stream.credit_task = task
            self._pending_credit_tasks.add(task)
            task.add_done_callback(self._pending_credit_tasks.discard)

    async def _drain_stream_credit(self, stream: _PlaybackStream) -> None:
        try:
            while stream.decoder.outstanding_credit_frames > 0:
                if self._closed or self._streams_by_id.get(stream.stream_id) is not stream:
                    return
                read_started_at = time.monotonic()
                chunk = await stream.decoder.read_credited_frames(
                    max_frames=stream.decoder.outstanding_credit_frames,
                    delivery_role=stream.role,
                )
                _log_slow_stream_step("decoder read", stream, read_started_at)
                timing = stream.timing if stream.sequence == 0 else None
                if chunk.frame_count:
                    if timing is not None:
                        timing.first_decoded_at = time.monotonic()
                    payload = (
                        pack_encoded_frame(
                            generation=stream.generation,
                            stream_id=stream.stream_id,
                            role=stream.role,
                            sequence=stream.sequence,
                            payload=chunk.pcm,
                        )
                        if isinstance(stream.decoder, EncodedStream)
                        else pack_pcm_frame(
                            generation=stream.generation,
                            stream_id=stream.stream_id,
                            role=stream.role,
                            sequence=stream.sequence,
                            frame_count=chunk.frame_count,
                            pcm=chunk.pcm,
                        )
                    )
                    send_started_at = time.monotonic()
                    if not await self._send_stream_bytes(stream, payload):
                        return
                    _log_slow_stream_step("socket send", stream, send_started_at)
                    if timing is not None:
                        timing.first_sent_at = time.monotonic()
                        timing.log("first_frame")
                    stream.sequence += 1
                    await asyncio.sleep(PCM_STREAM_SEND_COOPERATIVE_PAUSE_SECONDS)
                    continue

                metadata = await stream.decoder.finish()
                stream.log_open_timing("eos")
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
            stream.log_open_timing("decoder_error")
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
        ticket = self._open_tickets.get(stream_id)
        if ticket is not None and ticket.generation == generation:
            ticket.abandoned = True
            stream = self._streams_by_id.get(stream_id)
            if stream is not None:
                await self._retire_stream(stream)
            return True
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
        await self._send_json(
            _decoder_error_event(generation=generation, stream_id=stream_id, role=role, error=error)
        )

    async def _remove_stream(self, stream: _PlaybackStream, *, cancel: bool = True) -> None:
        if self._streams_by_id.get(stream.stream_id) is not stream:
            return
        stream.log_open_timing("closed")
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
        stream.log_open_timing("closed")
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
            raise _PlaybackCleanupError(
                f"playback stream cleanup failed: decoder cancel failed: {details}"
            )

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
            if playback_timing.ENABLED:
                playback_timing.log(
                    "socket-closed",
                    socket=self.timing_socket,
                    code=close_code if close_code is not None else self._client_close_code,
                    at=playback_timing.epoch_ms(),
                )
            failures: list[BaseException] = []
            if self._heartbeat_task is not None:
                self._heartbeat_task.cancel()
                await asyncio.gather(self._heartbeat_task, return_exceptions=True)
            try:
                current = asyncio.current_task()
                pending = [task for task in self._pending_controls if task is not current]
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
                raise _PlaybackCleanupError(f"playback connection cleanup failed: {details}")


@router.websocket("/playback/pcm")
async def playback_pcm_socket(websocket: WebSocket) -> None:
    if not _same_origin(websocket):
        await websocket.close(code=CLOSE_FORBIDDEN_ORIGIN)
        return
    try:
        await require_action("library.media.read")(websocket)
    except HTTPException as exc:
        await websocket.close(
            code=(
                CLOSE_UNAUTHENTICATED
                if exc.status_code == 401
                else CLOSE_FORBIDDEN_ORIGIN
            )
        )
        return
    registry: PlaybackPcmRegistry = websocket.app.state.playback_pcm_registry
    connection = await registry.acquire_connection(websocket)
    if connection is None:
        await websocket.close(code=CLOSE_ADMISSION_EXHAUSTED)
        return
    await connection.run()
