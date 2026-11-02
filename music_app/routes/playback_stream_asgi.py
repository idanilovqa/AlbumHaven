from __future__ import annotations

from music_app.services.loop_request_scope import saved_loop_scope

import asyncio
import anyio
from contextlib import suppress
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import json
import logging
import math
import subprocess
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse, Response
from starlette.websockets import WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

from music_app.services.library_roots import resolve_configured_media_path
from music_app.services.loops import resolve_loop_media_path
from music_app.services.playback_encoded import (
    INITIAL_ENCODED_CREDIT_BYTES,
    EncodedStream,
    fallback_sample_rate,
    open_encoded_stream,
    read_flac_layout,
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
from music_app.services.waveform_peaks import (
    WAVEFORM_ANALYZER_VERSION,
    WaveformPeaksBusyError,
)
from music_app.services.policy_asgi import require_action


MAX_PLAYBACK_CONNECTIONS = 6
MAX_PLAYBACK_DECODERS = 8
MAX_DECODERS_PER_CONNECTION = 2
MAX_CONTROL_MESSAGE_BYTES = 16_384
MIN_PCM_SAMPLE_RATE = 8_000
MAX_PCM_SAMPLE_RATE = 192_000
MAX_CREDIT_FRAMES_PER_MESSAGE = MAX_PCM_SAMPLE_RATE
MAX_TRACK_DURATION_SECONDS = 86_400
MAX_TRACK_PATH_CHARACTERS = 32_768
PCM_STREAM_SEND_COOPERATIVE_PAUSE_SECONDS = 0.001
PCM_CLEANUP_JOIN_SECONDS = 5.0
CAPTURE_ADMISSION_WAIT_SECONDS = 0.25
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
        resolve_loop_media_path(
            request.app.state.config,
            requested_loop_id,
            **loop_scope,
        )
        if loop_scope is not None
        else resolve_configured_media_path(request.app.state.config, requested_path)
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
            stat = resolved_path.stat()
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
            current_stat = resolved_path.stat()
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


def _capture_source_event(metadata: PcmStreamMetadata) -> dict[str, object] | None:
    if metadata.capture_source_id is None:
        return None
    return {
        "version": "decoded-pcm-observation-v1",
        "observationId": metadata.capture_source_id,
        "coordinateBasis": metadata.capture_coordinate_basis,
        **({"requestedStart48": metadata.requested_start_frame}
           if metadata.capture_local_coordinates else {}),
        "sourceBase48": metadata.capture_source_base48,
        "extentFrames48": metadata.capture_extent_frames48,
    }


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
        **({"captureSource": _capture_source_event(metadata)}
           if metadata.capture_source_id is not None else {}),
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


@dataclass(slots=True, eq=False)
class _PlaybackStream:
    decoder: PcmDecoderProcess | EncodedStream
    generation: int
    stream_id: int
    role: str
    sequence: int = 0
    credit_task: asyncio.Task[None] | None = None
    release_task: asyncio.Task[None] | None = None
    capture_admission: tuple | None = None
    coverage_mode: str = 'legacy'
    rate_capture_authority: tuple | None = None
    rate_capture_admission: object | None = None
    rate_capture_owner: str | None = None
    rate_capture_raw_path: str | None = None
    rate_capture_opened_at: datetime | None = None
    rate_capture_descriptor: dict | None = None
    rate_capture_publication_started: bool = False
    absolute_admission_task: asyncio.Task[bool] | None = None
    absolute_settlement_task: asyncio.Task[None] | None = None


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
        from music_app.services.playback_pcm_fd_capability import shutdown_fd_capture
        results = await asyncio.gather(
            *(connection.shutdown() for connection in connections),
            shutdown_fd_capture(),
            return_exceptions=True,
        )
        failures = _gathered_failures(results)
        if failures:
            details = "; ".join(_format_cleanup_failure(failure) for failure in failures)
            raise RuntimeError(f"playback registry shutdown failed: {details}")


async def _settled_capture_call(function, *args, **kwargs):
    """Bound thread admission; retain the actual worker until it settles."""
    async def admitted_worker():
        # Cancels a waiter for the existing AnyIO thread limiter. Once running,
        # run_in_threadpool retains its synchronous worker until settlement.
        with anyio.move_on_after(CAPTURE_ADMISSION_WAIT_SECONDS):
            return await run_in_threadpool(function, *args, **kwargs)
        return None
    task = asyncio.create_task(admitted_worker())
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        # Cancelling an asyncio waiter cannot cancel a synchronous DB operation.
        # Retain it here rather than release the existing lifecycle prematurely.
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        with suppress(Exception):
            task.result()
        raise


class _PlaybackPcmConnection:
    def __init__(self, registry: PlaybackPcmRegistry, websocket: WebSocket) -> None:
        self._registry = registry
        self._websocket = websocket
        self._streams_by_id: dict[int, _PlaybackStream] = {}
        self._streams_by_role: dict[str, _PlaybackStream] = {}
        self._completed_streams_by_role: dict[str, tuple[int, int]] = {}
        self._finalize_task: asyncio.Task[None] | None = None
        self._retiring_streams: set[_PlaybackStream] = set()
        self._send_lock = asyncio.Lock()
        self._pending_opens: set[asyncio.Task[object]] = set()
        self._absolute_capture_owners: dict[int, _PlaybackStream] = {}
        self._rate_capture_tasks: set[asyncio.Task[object]] = set()
        self._pending_credit_tasks: set[asyncio.Task[None]] = set()
        self._retire_tasks: set[asyncio.Task[None]] = set()
        self._transport_failed = asyncio.Event()
        self._closed = False
        self._finalized = False

    def _rate_capture_authority(self):
        """Capture the authorized open's actor, not a later active selection."""
        try:
            config = getattr(self._websocket.app.state, 'config', {})
            if (not isinstance(config, Mapping) or config.get('ALBUM_HAVEN_POSITION_CAPTURE_ENABLED') is not True
                    or config.get('ALBUM_HAVEN_NATIVE_RATE_CAPTURE_ENABLED') is not True):
                return None
            from music_app.services.playback_capture import capture_scope
            from music_app.services.policy import PolicyContext
            from music_app.services.policy_asgi import _deployment_mode, _request_origin
            from music_app.services.client_surfaces import client_surface_from_request
            actor = self._websocket.state.current_actor
            context = PolicyContext.build(actor=actor, action='library.media.read',
                library_id=actor.current_library_id, deployment_mode=_deployment_mode(self._websocket),
                request_origin=_request_origin(self._websocket),
                client_surface_class=client_surface_from_request(self._websocket))
            constraints = getattr(self._websocket.app.state, 'policy_constraint_resolver', None)
            database_url = config.get('ALBUM_HAVEN_APP_DATABASE_URL')
            if ((constraints is not None and not callable(constraints))
                    or not isinstance(database_url, str) or not database_url.strip()):
                return None
            scope = capture_scope(context, getattr(self._websocket.app.state, 'auth_policy_config', {}))
            return database_url, context, constraints, scope
        except Exception:
            return None

    def _schedule_rate_capture(self, authority, admission, owner_uuid, raw_path,
                               resolved_path, command, decoder, opened_at, descriptor=None):
        # The bounded optional worker never holds up audio or creates a decoder.
        if authority is None or len(self._rate_capture_tasks) >= MAX_DECODERS_PER_CONNECTION:
            return None
        try:
            from music_app.services.playback_decoder_observation import DecoderAdmission
            from music_app.services.playback_rate_observation import rate_capture_descriptor, publish_open_rate_map
            if (type(admission) is not DecoderAdmission or admission.path != raw_path
                    or admission.resolved_path != str(resolved_path)
                    or admission.resolved_path != str(command.path)
                    or admission.resolved_path != str(decoder.command.path)):
                return None
            descriptor = descriptor or rate_capture_descriptor(owner_uuid, command, decoder)
            if descriptor is None:
                return None
            if ((getattr(decoder, 'rate_capture_requires_positions', False)
                    or getattr(decoder, 'rate_capture_requires_origin', False))
                    and not getattr(decoder, 'rate_capture_origin_confirmed', False)):
                return descriptor
            database_url, context, constraints, _scope = authority
            facts = decoder.rate_capture_facts
            def enabled():
                config = getattr(self._websocket.app.state, 'config', {})
                return (isinstance(config, Mapping) and config.get('ALBUM_HAVEN_POSITION_CAPTURE_ENABLED') is True
                    and config.get('ALBUM_HAVEN_NATIVE_RATE_CAPTURE_ENABLED') is True)
            task = asyncio.create_task(_settled_capture_call(publish_open_rate_map,
                database_url, context, admission, facts, descriptor, opened_at,
                constraints=constraints, enabled=enabled))
            self._rate_capture_tasks.add(task)
            task.add_done_callback(self._observe_rate_capture)
            return descriptor
        except Exception:
            return None

    def _observe_rate_capture(self, task):
        self._rate_capture_tasks.discard(task)
        if not task.cancelled():
            task.exception()

    def _rate_positions(self, stream, chunk):
        descriptor = stream.rate_capture_descriptor
        if (stream.coverage_mode == 'native' and descriptor is not None
                and getattr(stream.decoder, 'rate_capture_requires_origin', False)):
            # Encoded seeks carry a pending whole-window map. Publish only after
            # the same decoder has observed its actual first source-sample PTS.
            # Missing or mismatched proof does not delay or change audio bytes.
            if (not stream.rate_capture_publication_started
                    and stream.decoder.rate_capture_origin_confirmed):
                scheduled = self._schedule_rate_capture(stream.rate_capture_authority,
                    stream.rate_capture_admission, stream.rate_capture_owner, stream.rate_capture_raw_path,
                    stream.decoder.command.path, stream.decoder.command, stream.decoder,
                    stream.rate_capture_opened_at, descriptor=descriptor)
                if scheduled is not None:
                    stream.rate_capture_publication_started = True
            return None
        if (stream.coverage_mode != 'native' or descriptor is None
                or descriptor.get('delivery_positions') != 'per-packet'):
            return None
        try:
            ranges = stream.decoder.rate_capture_ranges(chunk)
            if not ranges:
                return None
            if not stream.rate_capture_publication_started:
                scheduled = self._schedule_rate_capture(stream.rate_capture_authority,
                    stream.rate_capture_admission, stream.rate_capture_owner, stream.rate_capture_raw_path,
                    stream.decoder.command.path, stream.decoder.command, stream.decoder,
                    stream.rate_capture_opened_at, descriptor=descriptor)
                if scheduled is not None:
                    stream.rate_capture_publication_started = True
            return dict(type='rate-positions', generation=stream.generation,
                streamId=stream.stream_id, sequence=stream.sequence,
                frameCount=chunk.frame_count, map_ref=descriptor['map_ref'],
                ranges=[list(item) for item in ranges])
        except Exception:
            # Optional proof failure cannot alter the PCM packet or fail playback.
            return None

    async def _prepare_rate_capture_admission(self, authority, owner_uuid, raw_path, resolved_path):
        if (authority is None or self._closed
                or len(self._rate_capture_tasks) >= MAX_DECODERS_PER_CONNECTION):
            return None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + CAPTURE_ADMISSION_WAIT_SECONDS
        try:
            from music_app.services.playback_decoder_observation import DecoderAdmission, prepare_decoder_admission
            from music_app.services.playback_rate_observation import valid_rate_owner_uuid
            if not valid_rate_owner_uuid(owner_uuid) or loop.time() >= deadline:
                return None
            database_url, context, constraints, scope = authority
            task = asyncio.create_task(_settled_capture_call(prepare_decoder_admission,
                database_url, context, raw_path, resolved_path, scope, constraints=constraints))
            self._rate_capture_tasks.add(task)
            task.add_done_callback(self._observe_rate_capture)
            # A timeout abandons this result, not the synchronous worker. Keep
            # its optional slot and connection ownership until physical settlement.
            completed, _pending = await asyncio.wait({task}, timeout=max(0, deadline - loop.time()))
            if task not in completed or task.cancelled() or loop.time() > deadline or self._closed:
                return None
            admission = task.result()
            if (type(admission) is not DecoderAdmission or admission.path != raw_path
                    or admission.resolved_path != str(resolved_path)):
                return None
            return admission
        except Exception:
            # Unavailable evidence cannot deny the already-authorized audio open.
            return None

    async def _prepare_capture_admission(self, raw_path, resolved_path, start_frame, sample_rate):
        config = getattr(self._websocket.app.state, 'config', {})
        if (not isinstance(config, Mapping) or config.get('ALBUM_HAVEN_POSITION_CAPTURE_ENABLED') is not True
                or sample_rate != 48000 or start_frame > 2**53 - 1):
            return None
        try:
            from music_app.services.playback_decoder_observation import prepare_decoder_admission
            from music_app.services.playback_capture import capture_scope
            from music_app.services.policy import PolicyContext
            from music_app.services.policy_asgi import _deployment_mode, _request_origin
            from music_app.services.client_surfaces import client_surface_from_request
            actor = self._websocket.state.current_actor  # Already refreshed by the actual open policy.
            context = PolicyContext.build(actor=actor, action='library.media.read', library_id=actor.current_library_id,
                deployment_mode=_deployment_mode(self._websocket), request_origin=_request_origin(self._websocket),
                client_surface_class=client_surface_from_request(self._websocket))
            constraints = getattr(self._websocket.app.state, 'policy_constraint_resolver', None)
            if constraints is not None and not callable(constraints):
                return None
            database_url = config.get('ALBUM_HAVEN_APP_DATABASE_URL')
            if not isinstance(database_url, str) or not database_url.strip():
                return None
            scope = capture_scope(context, getattr(self._websocket.app.state, 'auth_policy_config', {}))
            admission = await _settled_capture_call(prepare_decoder_admission, database_url, context,
                raw_path, resolved_path, scope, constraints=constraints)
            return (database_url, context, constraints, admission) if admission is not None else None
        except Exception:
            # Optional evidence never supplies media authority or blocks playback
            # after optional admission failure. No private driver/path details.
            return None

    async def _record_capture_open(self, stream):
        if stream.capture_admission is None:
            return
        database_url, context, constraints, admission = stream.capture_admission
        def enabled():
            config = getattr(self._websocket.app.state, 'config', {})
            return isinstance(config, Mapping) and config.get('ALBUM_HAVEN_POSITION_CAPTURE_ENABLED') is True
        try:
            from music_app.services.playback_decoder_observation import record_decoder_open
            stored = await _settled_capture_call(record_decoder_open, database_url, context, admission,
                stream.decoder.command, stream.decoder.metadata, constraints=constraints, enabled=enabled)
            if stored is not True:
                stream.capture_admission = None
        except Exception:
            stream.capture_admission = None

    def _absolute_capture_enabled(self):
        config = getattr(self._websocket.app.state, 'config', {})
        return (isinstance(config, Mapping)
            and config.get('ALBUM_HAVEN_POSITION_CAPTURE_ENABLED') is True
            and config.get('ALBUM_HAVEN_WAV_ABSOLUTE_CAPTURE_ENABLED') is True)

    async def _record_absolute_open(self, stream):
        if stream.capture_admission is None or not self._owns_stream(stream):
            return False
        database_url, context, constraints, admission = stream.capture_admission
        metadata = stream.decoder.absolute_metadata
        if metadata is None:
            return False
        try:
            from music_app.services.playback_decoder_observation import record_decoder_open
            stored = await _settled_capture_call(record_decoder_open, database_url, context, admission,
                stream.decoder.command, metadata, constraints=constraints, enabled=self._absolute_capture_enabled)
            return stored is True and self._owns_stream(stream) and self._absolute_capture_enabled()
        except Exception:
            return False

    def _absolute_positions(self, stream, chunk):
        ranges = getattr(chunk, 'verified_absolute_ranges', ())
        metadata = getattr(stream.decoder, 'absolute_metadata', None)
        if not isinstance(ranges, tuple) or not ranges or len(ranges) > 32 or metadata is None or not self._absolute_capture_enabled():
            return None
        if stream.absolute_admission_task is None:
            if len(self._absolute_capture_owners) >= 2:
                return None
            self._absolute_capture_owners[id(stream)] = stream
            # Never wait for storage in the audio path; this chunk remains local.
            stream.absolute_admission_task = asyncio.create_task(self._record_absolute_open(stream))
            return None
        task = stream.absolute_admission_task
        if not task.done() or task.cancelled() or task.exception() is not None or task.result() is not True:
            return None
        if len(ranges) > 32:
            return None
        end = 0
        for item in ranges:
            if not isinstance(item, tuple) or len(item) != 3:
                return None
            offset, source, frames = item
            if (any(type(value) is not int for value in (offset, source, frames))
                    or offset < end or frames <= 0 or source < 0 or source + frames > 2**53 - 1
                    or offset + frames > chunk.frame_count):
                return None
            end = offset + frames
        return dict(type='capture-positions', generation=stream.generation, streamId=stream.stream_id,
            sequence=stream.sequence, frameCount=chunk.frame_count,
            observationId=metadata.capture_source_id, ranges=ranges)

    async def _settle_absolute_capture(self, stream, complete, capture_admission):
        task = stream.absolute_admission_task
        if task is None:
            return
        # Keep ownership until the existing bounded capture worker physically settles.
        cancelled = False
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                cancelled = True
            except Exception:
                break
        if cancelled:
            raise asyncio.CancelledError
        if (not complete or task.cancelled() or task.exception() is not None or task.result() is not True
                or capture_admission is None):
            return
        metadata = getattr(stream.decoder, 'absolute_metadata', None)
        if metadata is None or metadata.capture_extent_frames48 is None:
            return
        database_url, context, constraints, admission = capture_admission
        try:
            from music_app.services.playback_decoder_observation import record_decoder_eof
            await _settled_capture_call(record_decoder_eof, database_url, context, admission,
                stream.decoder.command, metadata, constraints=constraints, enabled=self._absolute_capture_enabled)
        except Exception:
            pass

    def _start_absolute_settlement(self, stream, complete):
        if stream.absolute_admission_task is None or stream.absolute_settlement_task is not None:
            return
        task = asyncio.create_task(self._settle_absolute_capture(stream, complete, stream.capture_admission))
        stream.absolute_settlement_task = task
        def settled(result):
            if not result.cancelled():
                result.exception()
            admission = stream.absolute_admission_task
            # Cancellation can happen before this coroutine executes at all.
            # In that case retain the original admission task itself, without
            # restarting work or opening another optional owner slot.
            if not admission.done():
                admission.add_done_callback(settled)
                return
            self._absolute_capture_owners.pop(id(stream), None)
        task.add_done_callback(settled)

    async def _record_capture_eof(self, stream, metadata):
        if stream.capture_admission is None:
            return
        database_url, context, constraints, admission = stream.capture_admission
        stream.capture_admission = None
        def enabled():
            config = getattr(self._websocket.app.state, 'config', {})
            return isinstance(config, Mapping) and config.get('ALBUM_HAVEN_POSITION_CAPTURE_ENABLED') is True
        try:
            from music_app.services.playback_decoder_observation import record_decoder_eof
            await _settled_capture_call(record_decoder_eof, database_url, context, admission,
                stream.decoder.command, metadata, constraints=constraints, enabled=enabled)
        except Exception:
            # Missing/failed durable facts stay unknown. Client EOF is not a fallback.
            pass

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

    async def _send_stream_bytes(self, stream: _PlaybackStream, payload: bytes, positions=None) -> bool:
        async with self._send_lock:
            if not self._owns_stream(stream):
                return False
            if positions is not None:
                await self._send_json_unlocked(positions)
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
                    "coverageMode": stream.coverage_mode,
                    "generation": stream.generation,
                    "streamId": stream.stream_id,
                    "role": stream.role,
                    "emittedFrames": stream.decoder.emitted_frames,
                    "authoritativeTotalFrames": metadata.authoritative_total_frames,
                    **({"captureSource": _capture_source_event(metadata)}
                       if stream.coverage_mode == 'legacy' and metadata.capture_source_id is not None else {}),
                }
            )
            if not self._owns_stream(stream):
                return False
            self._completed_streams_by_role[stream.role] = (
                stream.generation,
                stream.stream_id,
            )
            self._streams_by_id.pop(stream.stream_id, None)
            if self._streams_by_role.get(stream.role) is stream:
                self._streams_by_role.pop(stream.role, None)
        # Register retirement before any optional persistence await. The actual
        # release owner retains both per-connection and global capacity.
        await self._join_cleanup(self._start_release(stream, cancel=False, eof_metadata=metadata))
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
        if command_type == "probe":
            return await self._probe(control)
        if command_type == "open":
            return await self._open(control)
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
            resolve_configured_media_path(self._websocket.app.state.config, raw_path)
            if raw_path
            else None
        )
        if resolved_path is None:
            await self.reject(CLOSE_MEDIA_NOT_FOUND)
            return False
        size_bytes = 0
        lossless_bits_per_second = 0.0
        try:
            sample_rate = await asyncio.to_thread(read_native_sample_rate, resolved_path)
            size_bytes = await asyncio.to_thread(lambda: resolved_path.stat().st_size)
            if resolved_path.suffix.lower() == ".flac":
                layout = await asyncio.to_thread(read_flac_layout, resolved_path)
                if layout is not None:
                    header, first_audio_byte, end_byte, native_rate, total_samples = layout
                    if end_byte > first_audio_byte >= 0 and native_rate > 0 and total_samples > 0:
                        lossless_bits_per_second = (
                            (len(header) + end_byte - first_audio_byte) * 8 * native_rate
                            / total_samples
                        )
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
                **({"losslessBitsPerSecond": lossless_bits_per_second}
                   if lossless_bits_per_second > 0 else {}),
            }
        )
        return True

    async def _open(self, control: dict[str, Any]) -> bool:
        task = asyncio.create_task(self._open_tracked(control))
        self._pending_opens.add(task)
        try:
            return await task
        finally:
            self._pending_opens.discard(task)

    async def _open_tracked(self, control: dict[str, Any]) -> bool:
        if self._closed or not await self._authorize_media_read():
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
        if (
            not codecs_valid
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
        if (self._retiring_streams and len(self._streams_by_id)
                + len(self._retiring_streams) >= MAX_DECODERS_PER_CONNECTION):
            # Promotion can request its next continuity immediately. Give the
            # outgoing decoder's existing release a bounded chance to settle,
            # rather than reject a normal transition or free its slot early.
            await asyncio.wait(
                {stream.release_task for stream in self._retiring_streams},
                timeout=PCM_CLEANUP_JOIN_SECONDS,
            )
            if self._closed:
                return False
        if len(self._streams_by_id) + len(self._retiring_streams) >= MAX_DECODERS_PER_CONNECTION:
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
        stream: _PlaybackStream | None = None
        coverage_mode = 'native' if 'trackingOwnerUuid' in control else 'legacy'
        rate_authority = self._rate_capture_authority() if coverage_mode == 'native' else None
        rate_admission = None

        def retain_start(decoder: PcmDecoderProcess | EncodedStream) -> None:
            nonlocal stream
            stream = _PlaybackStream(
                decoder=decoder, generation=generation, stream_id=stream_id, role=role,
                capture_admission=capture_admission, coverage_mode=coverage_mode,
                rate_capture_authority=rate_authority, rate_capture_admission=rate_admission,
                rate_capture_owner=control.get('trackingOwnerUuid'),
                rate_capture_raw_path=raw_path, rate_capture_opened_at=opened_at)
            self._streams_by_id[stream_id] = stream
            self._streams_by_role[role] = stream

        try:
            capture_admission = None
            rate_admission = await self._prepare_rate_capture_admission(
                rate_authority, control.get('trackingOwnerUuid'), raw_path, resolved_path)
            if self._closed:
                await self._registry.release_decoder()
                return False
            opened_at = datetime.now(timezone.utc)
            decoder = await open_encoded_stream(
                command,
                codecs=frozenset(raw_codecs),
                quality=quality,
            )
            if decoder is not None:
                retain_start(decoder)
            else:
                # Existing decoder reservation bounds optional work as well as the
                # subprocess. Invalid role/capacity requests never reach this lookup.
                capture_admission = (await self._prepare_capture_admission(raw_path, resolved_path, start_frame, sample_rate)
                    if coverage_mode == 'legacy' else None)
                if self._closed:
                    await self._registry.release_decoder()
                    return False
                # Existing admission enables local output counting, never an absolute seek offset.
                if capture_admission is not None and start_frame > 0:
                    command = replace(command, capture_local_coordinates=True,
                        capture_absolute_coordinates=self._absolute_capture_enabled())
                if (coverage_mode == 'native' and rate_authority is not None
                        and self._absolute_capture_enabled()
                        and sample_rate in (44100, 48000)
                        and resolved_path.suffix.lower() in {'.wav', '.wave'}):
                    from music_app.services.playback_rate_observation import valid_rate_owner_uuid
                    if valid_rate_owner_uuid(control.get('trackingOwnerUuid')):
                        # Reuse Source's existing checksum-bound WAV observer;
                        # these flags do not grant legacy publication authority.
                        command = replace(command, capture_local_coordinates=True,
                            capture_absolute_coordinates=True)
                decoder = await PcmDecoderProcess.start(command, on_start=retain_start)
                # Persist actual decoder UUID/source before publishing its metadata.
                # Failure leaves audio usable but no partial source qualification.
                await self._record_capture_open(stream)
                if decoder.metadata.capture_local_coordinates and stream.capture_admission is None:
                    # Do not advertise a local stream whose server-open admission failed.
                    decoder.metadata = replace(decoder.metadata, capture_source_base48=None,
                        capture_local_coordinates=False)
        except BaseException as error:
            if stream is None:
                await self._registry.release_decoder()
            else:
                self._retire_stream_unlocked(stream)
            if not isinstance(error, Exception):
                raise
            if self._closed:
                return False
            if isinstance(error, SampleRateMismatch):
                await self._send_json(
                    {
                        "type": "rate-mismatch",
                        "generation": generation,
                        "streamId": stream_id,
                        "sampleRate": error.native_rate,
                        "fallbackSampleRate": fallback_sample_rate(error.native_rate),
                    }
                )
                return True
            await self._send_decoder_error(
                generation=generation, stream_id=stream_id, role=role, error=error)
            return True

        self._completed_streams_by_role.pop(role, None)
        for completed_role, completed_stream in list(self._completed_streams_by_role.items()):
            if completed_stream == (generation, stream_id):
                self._completed_streams_by_role.pop(completed_role, None)
        self._streams_by_id[stream_id] = stream
        self._streams_by_role[role] = stream
        if self._closed:
            self._retire_stream_unlocked(stream)
            return False
        metadata_event = _metadata_event(decoder.metadata, role=role, encoded=_encoded_fields(decoder))
        metadata_event['coverageMode'] = coverage_mode
        if coverage_mode == 'native':
            metadata_event.pop('captureSource', None)
            metadata_event['rateCapture'] = self._schedule_rate_capture(
                rate_authority, rate_admission, control.get('trackingOwnerUuid'), raw_path,
                resolved_path, command, decoder, opened_at)
            stream.rate_capture_descriptor = metadata_event['rateCapture']
        await self._send_json(metadata_event)
        if isinstance(decoder, EncodedStream):
            decoder.grant_credit(INITIAL_ENCODED_CREDIT_BYTES)
            self._start_credit_drain(stream)
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

        stream.decoder.grant_credit(frames)
        self._start_credit_drain(stream)
        return True

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
                if chunk.frame_count:
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
                    positions = (self._rate_positions(stream, chunk) if stream.coverage_mode == 'native'
                        else self._absolute_positions(stream, chunk))
                    if not await self._send_stream_bytes(stream, payload, positions):
                        return
                    _log_slow_stream_step("socket send", stream, send_started_at)
                    stream.sequence += 1
                    await asyncio.sleep(PCM_STREAM_SEND_COOPERATIVE_PAUSE_SECONDS)
                    continue

                metadata = await stream.decoder.finish()
                if getattr(stream.decoder, 'rate_capture_requires_origin', False):
                    # A final stderr observation may settle after the last byte
                    # read. Publication is still optional and never awaited.
                    self._rate_positions(stream, None)
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
            # A failed/stalled error notification must not defer child cleanup.
            self._retire_stream_unlocked(stream)
            try:
                await self._send_decoder_error(
                    generation=stream.generation,
                    stream_id=stream.stream_id,
                    role=stream.role,
                    error=error,
                )
            except WebSocketDisconnect:
                self._closed = True
                self._transport_failed.set()
            await self._join_cleanup(stream.release_task)

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

        for retiring in self._retiring_streams:
            if (retiring.generation, retiring.stream_id) == (generation, stream_id):
                await self._join_cleanup(retiring.release_task)
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

    async def _join_cleanup(self, task: asyncio.Task[None]) -> None:
        completed, _ = await asyncio.wait({task}, timeout=PCM_CLEANUP_JOIN_SECONDS)
        if not completed:
            raise RuntimeError("playback cleanup unresolved; capacity remains unavailable")
        task.result()

    async def _remove_stream(self, stream: _PlaybackStream, *, cancel: bool = True) -> None:
        if self._streams_by_id.get(stream.stream_id) is stream:
            self._streams_by_id.pop(stream.stream_id, None)
            if self._streams_by_role.get(stream.role) is stream:
                self._streams_by_role.pop(stream.role, None)
        await self._join_cleanup(self._start_release(stream, cancel=cancel))

    async def _retire_stream(self, stream: _PlaybackStream) -> None:
        # Fence future sends and start cleanup without waiting on a blocked
        # transport send. An already dispatched frame cannot be recalled.
        self._retire_stream_unlocked(stream)
        if stream.release_task is not None:
            await self._join_cleanup(stream.release_task)

    def _retire_stream_unlocked(self, stream: _PlaybackStream) -> None:
        if self._streams_by_id.get(stream.stream_id) is stream:
            self._streams_by_id.pop(stream.stream_id, None)
            if self._streams_by_role.get(stream.role) is stream:
                self._streams_by_role.pop(stream.role, None)
        self._start_release(stream, cancel=True)

    def _start_release(self, stream: _PlaybackStream, *, cancel: bool, eof_metadata=None) -> asyncio.Task[None]:
        if stream.release_task is None:
            self._retiring_streams.add(stream)
            if cancel and not isinstance(stream.decoder, EncodedStream):
                stream.decoder.request_cancel()
            stream.release_task = asyncio.create_task(self._release_stream(
                stream, cancel=cancel, caller=asyncio.current_task(), eof_metadata=eof_metadata))
            self._retire_tasks.add(stream.release_task)
            stream.release_task.add_done_callback(self._observe_release)
        return stream.release_task

    def _observe_release(self, task: asyncio.Task[None]) -> None:
        if task.cancelled() or task.exception() is not None:
            _LOGGER.error("Playback cleanup failed; its reservation remains unavailable")
        else:
            self._retire_tasks.discard(task)

    async def _cancel_stream_credit_task(self, stream: _PlaybackStream, *, caller=None) -> None:
        credit_task = stream.credit_task
        current_task = asyncio.current_task()
        if (credit_task is not None and credit_task is not current_task
                and credit_task is not caller and not credit_task.done()):
            credit_task.cancel()
            await asyncio.gather(credit_task, return_exceptions=True)

    async def _release_stream(self, stream: _PlaybackStream, *, cancel: bool, caller=None, eof_metadata=None) -> None:
        # This retained observer may outlive a bounded close/disconnect request.
        # It does not retry signals and cannot release a still-live reservation.
        await self._cancel_stream_credit_task(stream, caller=caller)
        self._start_absolute_settlement(stream, complete=eof_metadata is not None)
        if eof_metadata is not None:
            await self._record_capture_eof(stream, eof_metadata)
        if cancel:
            if isinstance(stream.decoder, EncodedStream):
                await stream.decoder.cancel()
            else:
                try:
                    await stream.decoder.cancel()
                except RuntimeError:
                    _LOGGER.warning("Playback cleanup unresolved; retaining decoder capacity")
                await stream.decoder.wait_closed()
        await self._registry.release_decoder()
        self._retiring_streams.discard(stream)

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
        if self._finalize_task is None:
            self._closed = True
            # An open may itself be rejecting the connection. Do not wait on
            # that initiating task from its own retained finalizer.
            caller = asyncio.current_task()
            self._finalize_task = asyncio.create_task(
                self._finalize_once(close_code=close_code, caller=caller))
            self._finalize_task.add_done_callback(_observe_cancelled_task)
        await self._join_cleanup(self._finalize_task)

    async def _finalize_once(self, *, close_code: int | None, caller) -> None:
        pending = [task for task in self._pending_opens if task is not caller]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        for stream in list(self._streams_by_id.values()):
            self._retire_stream_unlocked(stream)
        pending_credit = [task for task in self._pending_credit_tasks
                          if task is not caller and not task.done()]
        for task in pending_credit:
            task.cancel()
        if pending_credit:
            await asyncio.gather(*pending_credit, return_exceptions=True)
        self._completed_streams_by_role.clear()
        if close_code is not None:
            # The retained finalizer owns transport close too. Its caller has a
            # bounded join, but connection capacity requires actual completion.
            await self._websocket.close(code=close_code)
        tasks = list(self._retire_tasks)
        if tasks:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            failures = _gathered_failures(results)
            if failures:
                details = "; ".join(_format_cleanup_failure(error) for error in failures)
                raise RuntimeError(f"playback connection cleanup failed: {details}")
        if self._retiring_streams:
            raise RuntimeError("playback cleanup unresolved; capacity remains unavailable")
        optional = [(stream.absolute_settlement_task
                     if stream.absolute_settlement_task is not None and not stream.absolute_settlement_task.done()
                     else stream.absolute_admission_task)
                    for stream in self._absolute_capture_owners.values()]
        optional.extend(self._rate_capture_tasks)
        if optional:
            await asyncio.gather(*(asyncio.shield(task) for task in optional), return_exceptions=True)
        await self._registry.release_connection(self)
        self._finalized = True


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
