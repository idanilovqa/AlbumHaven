from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack
from dataclasses import replace
import json
import math
from pathlib import Path
import struct

import pytest

from music_app.routes import playback_stream_asgi
from music_app.services.playback_pcm import PcmChunk, PcmStreamMetadata
from tests.py.asgi_testing import create_test_asgi_app
from tests.py.asgi_testing import decode_json
from tests.py.asgi_testing import run_asgi_request
from tests.py.asgi_websocket_testing import websocket_session


class DecoderDouble:
    def __init__(self, command) -> None:
        self.command = command
        self.metadata = PcmStreamMetadata(
            generation=command.generation,
            stream_id=command.stream_id,
            role=command.role,
            sample_rate=command.sample_rate,
            channels=2,
            provisional_total_frames=round(
                command.provisional_duration_seconds * command.sample_rate
            ),
            requested_start_frame=command.start_frame,
            timeline_start_frame=command.start_frame,
        )
        self.outstanding_credit_frames = 0
        self.emitted_frames = 0
        self.cancel_calls = 0
        self.read_calls = 0
        self.delivery_roles: list[str | None] = []
        self.finish_calls = 0

    def grant_credit(self, frame_count: int) -> None:
        self.outstanding_credit_frames += frame_count

    async def read_credited_frames(
        self,
        *,
        max_frames: int,
        delivery_role: str | None = None,
    ) -> PcmChunk:
        self.read_calls += 1
        self.delivery_roles.append(delivery_role)
        if "decoder-truncated-diagnostic" in self.command.path.name:
            raise RuntimeError("ffmpeg exited with code 1: input packet was truncated")
        if "decoder-failed" in self.command.path.name:
            raise RuntimeError("ffmpeg exited with code 1: decoder fixture failed")
        if "truncated-pcm" in self.command.path.name:
            raise RuntimeError("ffmpeg returned truncated partial PCM frame")
        frame_count = min(max_frames, self.outstanding_credit_frames, 1)
        self.outstanding_credit_frames -= frame_count
        self.emitted_frames += frame_count
        amplitude = min(0.9, max(0.01, self.command.stream_id / 100))
        return PcmChunk(
            frame_count=frame_count,
            pcm=struct.pack("<ff", amplitude, -amplitude) * frame_count,
        )

    async def finish(self) -> PcmStreamMetadata:
        self.finish_calls += 1
        self.metadata = replace(
            self.metadata,
            authoritative_total_frames=self.metadata.timeline_start_frame + self.emitted_frames,
        )
        return self.metadata

    async def cancel(self) -> None:
        self.cancel_calls += 1


class DecoderFactoryDouble:
    def __init__(self) -> None:
        self.instances: list[DecoderDouble] = []

    async def start(self, command) -> DecoderDouble:
        decoder = DecoderDouble(command)
        self.instances.append(decoder)
        return decoder


@pytest.fixture
def playback_app(tmp_path, monkeypatch):
    class FakePostgresLibraryRootSettingsStore:
        def __init__(self, config):
            self._config = config

        def load_settings(self):
            from music_app.services.library_roots import normalize_library_root_settings

            return normalize_library_root_settings(
                {},
                fallback_main_root=Path(self._config["MUSIC_DIR"]).resolve(),
            )

    monkeypatch.setattr(
        "music_app.services.library_roots.PostgresLibraryRootSettingsStore",
        FakePostgresLibraryRootSettingsStore,
    )
    monkeypatch.setattr(
        "music_app.services.state.hydrate_runtime_library_state_on_startup",
        lambda _runtime: True,
    )
    monkeypatch.setattr(
        "music_app.services.state.ensure_runtime_relation_projection_ready",
        lambda _runtime: None,
    )
    monkeypatch.setattr(
        "music_app.services.lastfm_retry.start_lastfm_retry_worker",
        lambda _runtime: None,
    )
    monkeypatch.setattr(
        "music_app.services.lastfm_retry.stop_lastfm_retry_worker",
        lambda _runtime: None,
    )
    monkeypatch.setattr(
        "music_app.services.runtime_shutdown.request_runtime_shutdown",
        lambda _runtime: None,
    )
    app = create_test_asgi_app(tmp_path, monkeypatch)
    app.state.config["ALBUM_HAVEN_APP_DATABASE_URL"] = (
        "postgresql://album_haven_app@localhost/app"
    )
    return app


@pytest.fixture
def media_path(playback_app) -> Path:
    path = Path(playback_app.state.config["MUSIC_DIR"]) / "Artist" / "Album" / "track.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"decoder-boundary-fixture")
    return path.resolve()


@pytest.fixture
def decoder_factory(monkeypatch) -> DecoderFactoryDouble:
    factory = DecoderFactoryDouble()
    monkeypatch.setattr(playback_stream_asgi.PcmDecoderProcess, "start", factory.start)
    return factory


def open_command(media_path: Path, **changes) -> dict[str, object]:
    command: dict[str, object] = {
        "type": "open",
        "generation": 1,
        "streamId": 1,
        "role": "current",
        "path": str(media_path),
        "startFrame": 0,
        "sampleRate": 48_000,
        "durationSeconds": 60,
    }
    command.update(changes)
    return command


def test_pcm_socket_rejects_missing_authentication_before_admission(playback_app):
    from music_app.services.current_actor import CurrentActor

    class AnonymousResolver:
        def resolve(self, _token):
            return CurrentActor.anonymous()

    playback_app.state.current_actor_resolver = AnonymousResolver()

    async def scenario():
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            assert socket.accepted is False
            assert socket.close_code == 4401

    asyncio.run(scenario())


def test_waveform_route_resolves_configured_media_path_and_returns_compact_fixed_bins(
    playback_app,
    media_path,
):
    from music_app.services.waveform_peaks import WaveformPeaks

    class RegistryDouble:
        def __init__(self) -> None:
            self.calls: list[tuple[Path, int]] = []

        async def run(self, path: Path, *, bins: int) -> WaveformPeaks:
            self.calls.append((path, bins))
            return WaveformPeaks(
                left=tuple(index / 280 for index in range(280)),
                right=tuple((280 - index) / 280 for index in range(280)),
                sample_count=280,
            )

    registry = RegistryDouble()
    playback_app.state.waveform_peaks_registry = registry

    status, headers, body = run_asgi_request(
        playback_app,
        "GET",
        "/playback/waveform",
        query={"path": str(media_path)},
    )

    expected = {
        "left": [index / 280 for index in range(280)],
        "right": [(280 - index) / 280 for index in range(280)],
        "sampleCount": 280,
    }
    assert status == 200
    assert registry.calls == [(media_path, 280)]
    assert decode_json(body) == expected
    assert body == json.dumps(expected, separators=(",", ":")).encode("utf-8")
    assert headers["content-type"] == "application/json"
    assert int(headers["content-length"]) == len(body)


def test_waveform_route_resolves_saved_loop_id_through_media_authority_and_bounded_registry(
    playback_app,
    tmp_path,
    monkeypatch,
):
    from music_app.services.waveform_peaks import WaveformPeaks

    saved_loop_path = (tmp_path / "loops" / "saved-loop.wav").resolve()
    saved_loop_path.parent.mkdir(parents=True, exist_ok=True)
    saved_loop_path.write_bytes(b"saved-loop-waveform-fixture")
    resolved_ids: list[str] = []

    def resolve_saved_loop(_config, loop_id: str):
        resolved_ids.append(loop_id)
        return saved_loop_path if loop_id == "saved-loop-42" else None

    class RegistryDouble:
        def __init__(self) -> None:
            self.calls: list[tuple[Path, int]] = []

        async def run(self, path: Path, *, bins: int) -> WaveformPeaks:
            self.calls.append((path, bins))
            return WaveformPeaks(
                left=(0.25,) * bins,
                right=(0.5,) * bins,
                sample_count=bins,
            )

    registry = RegistryDouble()
    playback_app.state.waveform_peaks_registry = registry
    monkeypatch.setattr(
        playback_stream_asgi,
        "resolve_loop_media_path",
        resolve_saved_loop,
        raising=False,
    )

    status, _headers, body = run_asgi_request(
        playback_app,
        "GET",
        "/playback/waveform",
        query={"loop_id": "saved-loop-42"},
    )

    assert status == 200
    assert resolved_ids == ["saved-loop-42"]
    assert registry.calls == [(saved_loop_path, 280)]
    assert decode_json(body) == {
        "left": [0.25] * 280,
        "right": [0.5] * 280,
        "sampleCount": 280,
    }


def test_waveform_route_rejects_simultaneous_path_and_loop_id_before_resolution(
    playback_app,
    media_path,
    monkeypatch,
):
    resolver_calls: list[str] = []

    def reject_resolver(_config, identity):
        resolver_calls.append(str(identity))
        raise AssertionError("mutually exclusive waveform identities must not be resolved")

    class RegistryDouble:
        async def get_cached(self, *_args, **_kwargs):
            raise AssertionError("mutually exclusive waveform identities must not probe cache")

        async def run(self, *_args, **_kwargs):
            raise AssertionError("mutually exclusive waveform identities must not start a job")

    playback_app.state.waveform_peaks_registry = RegistryDouble()
    monkeypatch.setattr(
        playback_stream_asgi,
        "resolve_configured_media_path",
        reject_resolver,
    )
    monkeypatch.setattr(
        playback_stream_asgi,
        "resolve_loop_media_path",
        reject_resolver,
    )

    status, _headers, body = run_asgi_request(
        playback_app,
        "GET",
        "/playback/waveform",
        query={"path": str(media_path), "loop_id": "saved-loop-42"},
    )

    assert status == 400
    assert decode_json(body) == {"error": "Provide either path or loop_id, not both"}
    assert resolver_calls == []


@pytest.mark.parametrize("loop_id", ["missing-loop", "../outside"])
def test_waveform_route_rejects_missing_or_invalid_saved_loop_id_without_starting_job(
    playback_app,
    monkeypatch,
    loop_id,
):
    class RegistryDouble:
        def __init__(self) -> None:
            self.run_calls = 0

        async def run(self, _path: Path, *, bins: int):
            self.run_calls += 1
            raise AssertionError(f"unexpected peak job for {bins} bins")

    resolved_ids: list[str] = []

    def reject_saved_loop(_config, requested_id: str):
        resolved_ids.append(requested_id)
        return None

    monkeypatch.setattr(playback_stream_asgi, "resolve_loop_media_path", reject_saved_loop)
    registry = RegistryDouble()
    playback_app.state.waveform_peaks_registry = registry

    status, _headers, body = run_asgi_request(
        playback_app,
        "GET",
        "/playback/waveform",
        query={"loop_id": loop_id},
    )

    assert status == 404
    assert decode_json(body)["error"]
    assert resolved_ids == [loop_id]
    assert registry.run_calls == 0


def test_waveform_route_cache_only_probe_returns_hit_or_204_without_starting_job(
    playback_app,
    media_path,
):
    from music_app.services.waveform_peaks import WaveformPeaks

    cached = WaveformPeaks(
        left=tuple(index / 280 for index in range(280)),
        right=tuple((280 - index) / 280 for index in range(280)),
        sample_count=280,
    )

    class RegistryDouble:
        def __init__(self) -> None:
            self.calls: list[tuple[Path, int]] = []

        async def get_cached(self, path: Path, *, bins: int) -> WaveformPeaks | None:
            self.calls.append((path, bins))
            return cached if len(self.calls) == 1 else None

        async def run(self, _path: Path, *, bins: int):
            raise AssertionError(f"cache-only probe must not start peak job for {bins} bins")

    registry = RegistryDouble()
    playback_app.state.waveform_peaks_registry = registry

    hit_status, hit_headers, hit_body = run_asgi_request(
        playback_app,
        "GET",
        "/playback/waveform",
        query={"path": str(media_path), "cachedOnly": "1"},
    )
    miss_status, miss_headers, miss_body = run_asgi_request(
        playback_app,
        "GET",
        "/playback/waveform",
        query={"path": str(media_path), "cachedOnly": "1"},
    )

    assert hit_status == 200
    assert decode_json(hit_body) == {
        "left": list(cached.left),
        "right": list(cached.right),
        "sampleCount": 280,
    }
    assert hit_headers["content-type"] == "application/json"
    assert miss_status == 204
    assert miss_body == b""
    assert "content-type" not in miss_headers
    assert registry.calls == [(media_path, 280), (media_path, 280)]


@pytest.mark.parametrize("cached_only", ["true", "yes"])
def test_waveform_route_only_literal_one_selects_cache_only_mode(
    playback_app,
    media_path,
    cached_only,
):
    from music_app.services.waveform_peaks import WaveformPeaks

    expected = WaveformPeaks(
        left=(0.25,) * 280,
        right=(0.5,) * 280,
        sample_count=280,
    )

    class RegistryDouble:
        def __init__(self) -> None:
            self.run_calls: list[tuple[Path, int]] = []

        async def get_cached(self, _path: Path, *, bins: int):
            raise AssertionError(f"cachedOnly={cached_only} must not probe cache for {bins} bins")

        async def run(self, path: Path, *, bins: int) -> WaveformPeaks:
            self.run_calls.append((path, bins))
            return expected

    registry = RegistryDouble()
    playback_app.state.waveform_peaks_registry = registry

    status, _headers, body = run_asgi_request(
        playback_app,
        "GET",
        "/playback/waveform",
        query={"path": str(media_path), "cachedOnly": cached_only},
    )

    assert status == 200
    assert decode_json(body)["sampleCount"] == 280
    assert registry.run_calls == [(media_path, 280)]


def test_waveform_route_rejects_unconfigured_or_missing_media_without_starting_job(
    playback_app,
    tmp_path,
):
    class RegistryDouble:
        def __init__(self) -> None:
            self.run_calls = 0

        async def run(self, _path: Path, *, bins: int):
            self.run_calls += 1
            raise AssertionError(f"unexpected peak job for {bins} bins")

    configured_root = Path(playback_app.state.config["MUSIC_DIR"]).resolve()
    outside_path = (tmp_path / "outside-library.flac").resolve()
    outside_path.write_bytes(b"existing-outside-configured-root")
    missing_configured_path = configured_root / "Artist" / "missing-track.flac"
    assert outside_path.exists()
    assert not outside_path.is_relative_to(configured_root)
    assert not missing_configured_path.exists()
    registry = RegistryDouble()
    playback_app.state.waveform_peaks_registry = registry

    outside_status, _headers, outside_body = run_asgi_request(
        playback_app,
        "GET",
        "/playback/waveform",
        query={"path": str(outside_path)},
    )
    assert outside_status == 404
    assert decode_json(outside_body)["error"]
    assert registry.run_calls == 0

    missing_status, _headers, missing_body = run_asgi_request(
        playback_app,
        "GET",
        "/playback/waveform",
        query={"path": str(missing_configured_path)},
    )

    assert missing_status == 404
    assert decode_json(missing_body)["error"]
    assert registry.run_calls == 0


def test_waveform_route_returns_429_when_application_wide_peak_job_is_occupied(
    playback_app,
    media_path,
):
    from music_app.services.waveform_peaks import WaveformPeaksBusyError

    class BusyRegistryDouble:
        async def run(self, _path: Path, *, bins: int):
            assert bins == 280
            raise WaveformPeaksBusyError("waveform peak job already active")

    playback_app.state.waveform_peaks_registry = BusyRegistryDouble()

    status, _headers, body = run_asgi_request(
        playback_app,
        "GET",
        "/playback/waveform",
        query={"path": str(media_path)},
    )

    assert status == 429
    assert decode_json(body) == {"error": "waveform peak job already active"}


def test_waveform_route_cache_only_probe_returns_429_when_registry_is_shutting_down(
    playback_app,
    media_path,
):
    from music_app.services.waveform_peaks import WaveformPeaksBusyError

    class BusyRegistryDouble:
        def __init__(self) -> None:
            self.run_calls = 0

        async def get_cached(self, path: Path, *, bins: int):
            assert path == media_path
            assert bins == 280
            raise WaveformPeaksBusyError("waveform peak job already active")

        async def run(self, _path: Path, *, bins: int):
            self.run_calls += 1
            raise AssertionError(f"cache-only probe must not start peak job for {bins} bins")

    registry = BusyRegistryDouble()
    playback_app.state.waveform_peaks_registry = registry

    status, _headers, body = run_asgi_request(
        playback_app,
        "GET",
        "/playback/waveform",
        query={"path": str(media_path), "cachedOnly": "1"},
    )

    assert status == 429
    assert decode_json(body) == {"error": "waveform peak job already active"}
    assert registry.run_calls == 0


def test_waveform_busy_response_does_not_wait_for_disconnect_monitor_cancellation(
    playback_app,
    media_path,
):
    from music_app.services.waveform_peaks import WaveformPeaksBusyError

    class BusyRegistryDouble:
        async def run(self, _path: Path, *, bins: int):
            assert bins == 280
            raise WaveformPeaksBusyError("waveform peak job already active")

    async def scenario() -> None:
        playback_app.state.waveform_peaks_registry = BusyRegistryDouble()
        monitor_started = asyncio.Event()
        monitor_cancelled = asyncio.Event()
        release_monitor = asyncio.Event()
        response_started = asyncio.Event()
        messages: list[dict[str, object]] = []
        request_delivered = False

        async def receive() -> dict[str, object]:
            nonlocal request_delivered
            if not request_delivered:
                request_delivered = True
                return {"type": "http.request", "body": b"", "more_body": False}
            monitor_started.set()
            try:
                await release_monitor.wait()
            except asyncio.CancelledError:
                monitor_cancelled.set()
                await release_monitor.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict[str, object]) -> None:
            messages.append(message)
            if message["type"] == "http.response.start":
                response_started.set()

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/playback/waveform",
            "raw_path": b"/playback/waveform",
            "query_string": f"path={media_path}".encode("ascii"),
            "headers": [(b"host", b"testserver")],
            "client": ("testclient", 50000),
            "server": ("testserver", 80),
        }
        request_task = asyncio.create_task(playback_app(scope, receive, send))
        try:
            await asyncio.wait_for(monitor_started.wait(), timeout=1)
            response_wait = asyncio.create_task(response_started.wait())
            completed, _pending = await asyncio.wait({response_wait}, timeout=0.1)
            assert response_wait in completed, (
                "the 429 response was held behind disconnect-monitor cancellation"
            )
            await asyncio.sleep(0)
            assert monitor_cancelled.is_set() is True
            status = next(
                int(message["status"])
                for message in messages
                if message["type"] == "http.response.start"
            )
            assert status == 429
        finally:
            release_monitor.set()
            await asyncio.wait_for(request_task, timeout=1)

    asyncio.run(scenario())


def test_waveform_disconnect_waits_for_exact_peak_cleanup_before_returning_204(
    playback_app,
    media_path,
):
    async def scenario() -> None:
        started = asyncio.Event()
        cleanup_started = asyncio.Event()
        allow_cleanup = asyncio.Event()
        incoming: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        await incoming.put({"type": "http.request", "body": b"", "more_body": False})
        messages: list[dict[str, object]] = []

        class CleanupGatedRegistryDouble:
            async def run(self, _path: Path, *, bins: int):
                assert bins == 280
                started.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    cleanup_started.set()
                    await allow_cleanup.wait()
                    raise

        playback_app.state.waveform_peaks_registry = CleanupGatedRegistryDouble()

        async def receive() -> dict[str, object]:
            return await incoming.get()

        async def send(message: dict[str, object]) -> None:
            messages.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/playback/waveform",
            "raw_path": b"/playback/waveform",
            "query_string": f"path={media_path}".encode("ascii"),
            "headers": [(b"host", b"testserver")],
            "client": ("testclient", 50000),
            "server": ("testserver", 80),
        }
        request_task = asyncio.create_task(playback_app(scope, receive, send))
        try:
            await asyncio.wait_for(started.wait(), timeout=1)
            await incoming.put({"type": "http.disconnect"})
            await asyncio.wait_for(cleanup_started.wait(), timeout=1)
            await asyncio.sleep(0)
            assert request_task.done() is False
            assert not any(message["type"] == "http.response.start" for message in messages)

            allow_cleanup.set()
            await asyncio.wait_for(request_task, timeout=1)
            status = next(
                int(message["status"])
                for message in messages
                if message["type"] == "http.response.start"
            )
            assert status == 204
        finally:
            allow_cleanup.set()
            if not request_task.done():
                request_task.cancel()
                await asyncio.gather(request_task, return_exceptions=True)

    asyncio.run(scenario())


def test_waveform_http_disconnect_cancels_active_job_releases_slot_and_admits_next_request(
    playback_app,
    media_path,
):
    from music_app.services.waveform_peaks import WaveformPeaks, WaveformPeaksRegistry

    async def scenario() -> None:
        started = asyncio.Event()
        ffmpeg_cancelled = asyncio.Event()
        calls = 0

        async def builder(_path: Path, *, bins: int, cancel_event: asyncio.Event):
            nonlocal calls
            calls += 1
            assert bins == 280
            if calls == 1:
                started.set()
                await cancel_event.wait()
                ffmpeg_cancelled.set()
                raise asyncio.CancelledError()
            return WaveformPeaks(
                left=(0.25,) * bins,
                right=(0.5,) * bins,
                sample_count=bins,
            )

        registry = WaveformPeaksRegistry(builder=builder)
        playback_app.state.waveform_peaks_registry = registry
        incoming: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        await incoming.put({"type": "http.request", "body": b"", "more_body": False})
        messages: list[dict[str, object]] = []

        async def receive() -> dict[str, object]:
            return await incoming.get()

        async def send(message: dict[str, object]) -> None:
            messages.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/playback/waveform",
            "raw_path": b"/playback/waveform",
            "query_string": f"path={media_path}".encode("ascii"),
            "headers": [(b"host", b"testserver")],
            "client": ("testclient", 50000),
            "server": ("testserver", 80),
        }
        disconnected_request = asyncio.create_task(
            playback_app(scope, receive, send)
        )
        await asyncio.wait_for(started.wait(), timeout=1)

        second_status = 0
        active_after_disconnect = -1
        try:
            await incoming.put({"type": "http.disconnect"})
            await asyncio.wait_for(disconnected_request, timeout=1)
            assert disconnected_request.done() is True
            first_status = next(
                int(message["status"])
                for message in messages
                if message["type"] == "http.response.start"
            )
            assert first_status == 204
            await asyncio.wait_for(ffmpeg_cancelled.wait(), timeout=1)
            active_after_disconnect = registry.active_job_count
            next_incoming: asyncio.Queue[dict[str, object]] = asyncio.Queue()
            await next_incoming.put(
                {"type": "http.request", "body": b"", "more_body": False}
            )
            next_messages: list[dict[str, object]] = []

            async def receive_next() -> dict[str, object]:
                return await next_incoming.get()

            async def send_next(message: dict[str, object]) -> None:
                next_messages.append(message)

            await playback_app(scope, receive_next, send_next)
            second_status = next(
                int(message["status"])
                for message in next_messages
                if message["type"] == "http.response.start"
            )
        finally:
            await registry.shutdown()

        assert active_after_disconnect == 0
        assert second_status == 200
        assert calls == 2

    asyncio.run(scenario())


async def open_stream(socket, media_path: Path, **changes) -> dict[str, object]:
    await socket.send_json(open_command(media_path, **changes))
    event = await socket.receive_json()
    assert event["type"] == "metadata"
    return event


def assert_pcm_message(
    payload: bytes,
    *,
    generation: int,
    stream_id: int,
    role: str,
    sequence: int,
    frame_count: int,
) -> tuple[float, ...]:
    assert payload[:4] == b"AHPC"
    assert len(payload) == 24 + (frame_count * 8)
    role_code = 0 if role == "current" else 1
    assert struct.unpack(">BBHIIII", payload[4:24]) == (
        1,
        role_code,
        0,
        generation,
        stream_id,
        sequence,
        frame_count,
    )
    samples = struct.unpack(f"<{frame_count * 2}f", payload[24:])
    assert len(samples) == frame_count * 2
    assert all(math.isfinite(sample) for sample in samples)
    assert any(abs(sample) > 0 for sample in samples)
    return samples


def test_pcm_socket_opens_same_origin_authorized_current_role_with_exact_metadata(
    playback_app,
    media_path,
    decoder_factory,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            assert socket.accepted is True
            metadata = await open_stream(
                socket,
                media_path,
                generation=7,
                streamId=41,
                startFrame=240,
                durationSeconds=2.5,
            )

            assert metadata == {
                "type": "metadata",
                "generation": 7,
                "streamId": 41,
                "role": "current",
                "sampleRate": 48_000,
                "channels": 2,
                "provisionalTotalFrames": 120_000,
                "requestedStartFrame": 240,
                "timelineStartFrame": 240,
            }

        assert len(decoder_factory.instances) == 1
        assert decoder_factory.instances[0].cancel_calls == 1

    asyncio.run(scenario())


@pytest.mark.parametrize("origin", [None, "http://foreign.test"], ids=["missing", "foreign"])
def test_pcm_socket_rejects_missing_or_foreign_origin_with_4403(playback_app, origin):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm", origin=origin) as socket:
            assert socket.accepted is False
            assert await socket.receive_close() == 4403

    asyncio.run(scenario())


@pytest.mark.parametrize("path_kind", ["missing", "nonexistent", "outside-root"])
def test_pcm_socket_rejects_unauthorized_or_missing_media_with_4404(
    playback_app,
    media_path,
    decoder_factory,
    tmp_path,
    path_kind,
):
    paths = {
        "missing": None,
        "nonexistent": media_path.with_name("does-not-exist.wav"),
        "outside-root": tmp_path / "outside.wav",
    }
    if path_kind == "outside-root":
        paths[path_kind].write_bytes(b"outside")

    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            command = open_command(media_path)
            if path_kind == "missing":
                command.pop("path")
            else:
                command["path"] = str(paths[path_kind])
            await socket.send_json(command)
            assert await socket.receive_close() == 4404

    asyncio.run(scenario())
    assert decoder_factory.instances == []


@pytest.mark.parametrize(
    ("changes", "case"),
    [
        ({"generation": 0}, "zero-generation"),
        ({"generation": 2_147_483_648}, "oversized-generation"),
        ({"generation": True}, "boolean-generation"),
        ({"streamId": 0}, "zero-stream"),
        ({"streamId": "1"}, "string-stream"),
        ({"role": "next"}, "unknown-role"),
        ({"startFrame": -1}, "negative-offset"),
        ({"startFrame": 1.5}, "fractional-offset"),
        ({"sampleRate": 7_999}, "low-rate"),
        ({"sampleRate": 192_001}, "high-rate"),
        ({"sampleRate": 48_000.0}, "fractional-type-rate"),
        ({"durationSeconds": -1}, "negative-duration"),
        ({"durationSeconds": math.inf}, "infinite-duration"),
        ({"durationSeconds": 86_401}, "oversized-duration"),
    ],
)
def test_pcm_socket_rejects_malformed_open_control_with_4400(
    playback_app,
    media_path,
    decoder_factory,
    changes,
    case,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await socket.send_json(open_command(media_path, **changes))
            assert await socket.receive_close() == 4400, case

    asyncio.run(scenario())
    assert decoder_factory.instances == []


def test_pcm_socket_rejects_oversized_track_path_with_4400_before_starting_decoder(
    playback_app,
    media_path,
    decoder_factory,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await socket.send_json(
                open_command(
                    media_path,
                    path="x" * (playback_stream_asgi.MAX_TRACK_PATH_CHARACTERS + 1),
                )
            )
            assert await socket.receive_close() == 4400

    asyncio.run(scenario())
    assert decoder_factory.instances == []


@pytest.mark.parametrize(
    "payload",
    [
        b"binary-control-is-invalid",
        "{not-json",
        {"type": "unknown"},
        {"type": "credit", "generation": 99, "streamId": 1, "frames": 1},
        {"type": "credit", "generation": 1, "streamId": 99, "frames": 1},
        {"type": "credit", "generation": 1, "streamId": 1, "frames": -1},
        {"type": "credit", "generation": 1, "streamId": 1, "frames": "1"},
    ],
    ids=[
        "binary",
        "invalid-json",
        "unknown-command",
        "unknown-generation",
        "unknown-stream",
        "negative-credit",
        "string-credit",
    ],
)
def test_pcm_socket_rejects_malformed_or_unknown_control_with_4400(
    playback_app,
    media_path,
    decoder_factory,
    payload,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            if isinstance(payload, bytes):
                await socket.send_bytes(payload)
            elif isinstance(payload, str):
                await socket.send_text(payload)
            else:
                await socket.send_json(payload)
            assert await socket.receive_close() == 4400

    asyncio.run(scenario())


def test_pcm_socket_rejects_oversized_control_message_with_4400(playback_app):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await socket.send_text('{"type":"unknown","padding":"' + "x" * 16_384 + '"}')
            assert await socket.receive_close() == 4400

    asyncio.run(scenario())


def test_pcm_socket_rejects_credit_beyond_per_message_capacity_with_4408(
    playback_app,
    media_path,
    decoder_factory,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await open_stream(socket, media_path)
            await socket.send_json(
                {"type": "credit", "generation": 1, "streamId": 1, "frames": 48_001}
            )
            assert await socket.receive_close() == 4408

    asyncio.run(scenario())


def test_pcm_socket_rejects_zero_credit_with_4400_without_reading_or_finishing(
    playback_app,
    media_path,
    decoder_factory,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await open_stream(socket, media_path)
            decoder = decoder_factory.instances[0]

            await socket.send_json(
                {"type": "credit", "generation": 1, "streamId": 1, "frames": 0}
            )

            assert await socket.receive_close() == 4400
            assert decoder.read_calls == 0
            assert decoder.finish_calls == 0

    asyncio.run(scenario())


def test_pcm_socket_drains_one_bounded_credit_across_partial_decoder_chunks(
    playback_app,
    media_path,
    decoder_factory,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await open_stream(socket, media_path)
            decoder = decoder_factory.instances[0]
            await socket.send_json(
                {"type": "credit", "generation": 1, "streamId": 1, "frames": 3}
            )

            for sequence in range(3):
                assert_pcm_message(
                    await socket.receive_bytes(),
                    generation=1,
                    stream_id=1,
                    role="current",
                    sequence=sequence,
                    frame_count=1,
                )
            assert decoder.read_calls == 3
            assert decoder.outstanding_credit_frames == 0
            assert socket.close_code is None

    asyncio.run(scenario())


def test_pcm_socket_processes_replacement_while_partial_credit_drain_is_waiting(
    playback_app,
    media_path,
    decoder_factory,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await open_stream(socket, media_path)
            decoder = decoder_factory.instances[0]
            original_read = decoder.read_credited_frames
            blocked = asyncio.Event()
            release_cancel = asyncio.Event()

            async def read_one_then_wait(
                *, max_frames: int, delivery_role: str | None = None
            ) -> PcmChunk:
                if decoder.read_calls >= 1:
                    await blocked.wait()
                return await original_read(
                    max_frames=max_frames,
                    delivery_role=delivery_role,
                )

            decoder.read_credited_frames = read_one_then_wait

            async def cancel_after_replacement_is_live() -> None:
                decoder.cancel_calls += 1
                await release_cancel.wait()

            decoder.cancel = cancel_after_replacement_is_live
            await socket.send_json(
                {"type": "credit", "generation": 1, "streamId": 1, "frames": 3}
            )
            assert_pcm_message(
                await socket.receive_bytes(),
                generation=1,
                stream_id=1,
                role="current",
                sequence=0,
                frame_count=1,
            )

            await socket.send_json(
                {
                    "type": "close",
                    "generation": 1,
                    "streamId": 1,
                    "reason": "seek-replaced",
                }
            )
            await socket.send_json(open_command(media_path, streamId=2))

            assert await socket.receive_json() == {
                "type": "metadata",
                "generation": 1,
                "streamId": 2,
                "role": "current",
                "sampleRate": 48_000,
                "channels": 2,
                "provisionalTotalFrames": 2_880_000,
                "requestedStartFrame": 0,
                "timelineStartFrame": 0,
            }
            assert decoder.cancel_calls == 1
            release_cancel.set()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "second_open",
    [
        {"streamId": 2, "role": "current"},
        {"streamId": 1, "role": "continuity"},
    ],
    ids=["occupied-role", "conflicting-stream-role"],
)
def test_pcm_socket_rejects_role_or_stream_identity_conflict_with_4409(
    playback_app,
    media_path,
    decoder_factory,
    second_open,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await open_stream(socket, media_path)
            await socket.send_json(open_command(media_path, **second_open))
            assert await socket.receive_close() == 4409

    asyncio.run(scenario())


def test_pcm_registry_rejects_seventh_connection_with_4429(playback_app):
    async def scenario() -> None:
        async with AsyncExitStack() as stack:
            accepted = [
                await stack.enter_async_context(websocket_session(playback_app, "/playback/pcm"))
                for _ in range(6)
            ]
            assert all(socket.accepted for socket in accepted)
            seventh = await stack.enter_async_context(
                websocket_session(playback_app, "/playback/pcm")
            )
            assert seventh.accepted is False
            assert await seventh.receive_close() == 4429

    asyncio.run(scenario())


def test_pcm_registry_rejects_ninth_global_decoder_with_4429(
    playback_app,
    media_path,
    decoder_factory,
):
    async def scenario() -> None:
        async with AsyncExitStack() as stack:
            sockets = [
                await stack.enter_async_context(websocket_session(playback_app, "/playback/pcm"))
                for _ in range(5)
            ]
            stream_id = 1
            for socket in sockets[:4]:
                await open_stream(socket, media_path, streamId=stream_id, role="current")
                stream_id += 1
                await open_stream(socket, media_path, streamId=stream_id, role="continuity")
                stream_id += 1
            await sockets[4].send_json(open_command(media_path, streamId=stream_id))
            assert await sockets[4].receive_close() == 4429

    asyncio.run(scenario())
    assert len(decoder_factory.instances) == 8


def test_pcm_socket_promotes_stable_continuity_decoder_and_acknowledges_before_reuse(
    playback_app,
    media_path,
    decoder_factory,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await open_stream(socket, media_path, generation=7, streamId=41, role="current")
            await open_stream(socket, media_path, generation=7, streamId=42, role="continuity")
            continuity_decoder = decoder_factory.instances[1]

            await socket.send_json(
                {
                    "type": "promote",
                    "generation": 7,
                    "streamId": 42,
                    "fromRole": "continuity",
                    "toRole": "current",
                }
            )
            assert await socket.receive_json() == {
                "type": "promoted",
                "generation": 7,
                "streamId": 42,
                "role": "current",
            }
            assert decoder_factory.instances[1] is continuity_decoder
            assert decoder_factory.instances[0].cancel_calls == 1

            await socket.send_json(
                {"type": "credit", "generation": 7, "streamId": 42, "frames": 1}
            )
            assert_pcm_message(
                await socket.receive_bytes(),
                generation=7,
                stream_id=42,
                role="current",
                sequence=0,
                frame_count=1,
            )
            assert continuity_decoder.delivery_roles == ["current"]

            metadata = await open_stream(
                socket,
                media_path,
                generation=7,
                streamId=43,
                role="continuity",
            )
            assert metadata["streamId"] == 43
            assert len(decoder_factory.instances) == 3

    asyncio.run(scenario())


def test_pcm_promotion_ack_does_not_wait_for_outgoing_credit_task_cleanup(playback_app):
    class DecoderDouble:
        def __init__(self) -> None:
            self.cancel_calls = 0

        async def cancel(self) -> None:
            self.cancel_calls += 1

    class RecordingWebSocketDouble:
        def __init__(self) -> None:
            self.app = playback_app
            self.events: list[dict[str, object]] = []

        async def send_json(self, event: dict[str, object]) -> None:
            self.events.append(event)

    async def scenario() -> None:
        registry = playback_stream_asgi.PlaybackPcmRegistry()
        websocket = RecordingWebSocketDouble()
        connection = await registry.acquire_connection(websocket)
        assert connection is not None
        outgoing_decoder = DecoderDouble()
        incoming_decoder = DecoderDouble()
        current = playback_stream_asgi._PlaybackStream(
            decoder=outgoing_decoder,
            generation=7,
            stream_id=41,
            role="current",
        )
        continuity = playback_stream_asgi._PlaybackStream(
            decoder=incoming_decoder,
            generation=7,
            stream_id=42,
            role="continuity",
        )
        cancellation_started = asyncio.Event()
        allow_cancellation_cleanup = asyncio.Event()

        async def blocked_outgoing_credit() -> None:
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                cancellation_started.set()
                await allow_cancellation_cleanup.wait()
                raise

        current.credit_task = asyncio.create_task(blocked_outgoing_credit())
        await asyncio.sleep(0)
        connection._streams_by_id = {41: current, 42: continuity}
        connection._streams_by_role = {
            "current": current,
            "continuity": continuity,
        }

        promotion = asyncio.create_task(
            connection._promote(
                {
                    "type": "promote",
                    "generation": 7,
                    "streamId": 42,
                    "fromRole": "continuity",
                    "toRole": "current",
                }
            )
        )
        await cancellation_started.wait()
        for _ in range(10):
            await asyncio.sleep(0)
        promotion_returned_before_cleanup = promotion.done()
        events_before_cleanup = list(websocket.events)

        allow_cancellation_cleanup.set()
        assert await promotion is True
        await connection.cleanup()

        assert promotion_returned_before_cleanup is True
        assert events_before_cleanup == [
            {
                "type": "promoted",
                "generation": 7,
                "streamId": 42,
                "role": "current",
            }
        ]
        assert outgoing_decoder.cancel_calls == 1
        assert incoming_decoder.cancel_calls == 1

    asyncio.run(scenario())


@pytest.mark.parametrize("frame_count", [1, 0], ids=["pcm", "eos"])
def test_pcm_promotion_drops_outgoing_read_that_completes_after_retirement(
    playback_app,
    frame_count,
):
    class GatedSendLock:
        def __init__(self) -> None:
            self._lock = asyncio.Lock()
            self.blocked_task: asyncio.Task[None] | None = None
            self.blocked = asyncio.Event()
            self.allow = asyncio.Event()

        async def __aenter__(self) -> None:
            if asyncio.current_task() is self.blocked_task:
                self.blocked.set()
                try:
                    await self.allow.wait()
                except asyncio.CancelledError:
                    await self.allow.wait()
            await self._lock.acquire()

        async def __aexit__(self, *_args) -> None:
            self._lock.release()

    class DecoderDouble:
        def __init__(self) -> None:
            self.outstanding_credit_frames = 1
            self.emitted_frames = 0
            self.cancel_calls = 0
            self.metadata = PcmStreamMetadata(
                generation=7,
                stream_id=41,
                role="current",
                sample_rate=48_000,
                channels=2,
                provisional_total_frames=1,
                requested_start_frame=0,
                timeline_start_frame=0,
            )

        async def cancel(self) -> None:
            self.cancel_calls += 1

    class RecordingWebSocketDouble:
        def __init__(self) -> None:
            self.app = playback_app
            self.events: list[dict[str, object] | bytes] = []

        async def send_json(self, event: dict[str, object]) -> None:
            self.events.append(event)

        async def send_bytes(self, payload: bytes) -> None:
            self.events.append(payload)

    async def scenario() -> None:
        registry = playback_stream_asgi.PlaybackPcmRegistry()
        websocket = RecordingWebSocketDouble()
        connection = await registry.acquire_connection(websocket)
        assert connection is not None
        assert await registry.acquire_decoder() is True
        assert await registry.acquire_decoder() is True
        outgoing_decoder = DecoderDouble()
        incoming_decoder = DecoderDouble()
        current = playback_stream_asgi._PlaybackStream(
            decoder=outgoing_decoder,
            generation=7,
            stream_id=41,
            role="current",
        )
        continuity = playback_stream_asgi._PlaybackStream(
            decoder=incoming_decoder,
            generation=7,
            stream_id=42,
            role="continuity",
        )
        async def complete_read_before_retirement(
            *, max_frames: int, delivery_role: str | None = None
        ) -> PcmChunk:
            del max_frames, delivery_role
            outgoing_decoder.outstanding_credit_frames = 0
            outgoing_decoder.emitted_frames = frame_count
            return PcmChunk(
                frame_count=frame_count,
                pcm=struct.pack("<ff", 0.25, -0.25) * frame_count,
            )

        async def finish() -> PcmStreamMetadata:
            return replace(
                outgoing_decoder.metadata,
                authoritative_total_frames=outgoing_decoder.emitted_frames,
            )

        outgoing_decoder.read_credited_frames = complete_read_before_retirement
        outgoing_decoder.finish = finish
        connection._streams_by_id = {41: current, 42: continuity}
        connection._streams_by_role = {
            "current": current,
            "continuity": continuity,
        }
        send_lock = GatedSendLock()
        connection._send_lock = send_lock
        current.credit_task = asyncio.create_task(connection._drain_stream_credit(current))
        send_lock.blocked_task = current.credit_task
        await send_lock.blocked.wait()

        assert await connection._promote(
            {
                "type": "promote",
                "generation": 7,
                "streamId": 42,
                "fromRole": "continuity",
                "toRole": "current",
            }
        ) is True
        send_lock.allow.set()
        await current.credit_task
        await connection.cleanup()

        assert websocket.events == [
            {
                "type": "promoted",
                "generation": 7,
                "streamId": 42,
                "role": "current",
            }
        ]

    asyncio.run(scenario())


def test_pcm_socket_keeps_one_connection_and_stable_ids_across_three_tracks(
    playback_app,
    media_path,
    decoder_factory,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await open_stream(socket, media_path, generation=7, streamId=41, role="current")
            await open_stream(socket, media_path, generation=7, streamId=42, role="continuity")

            for promoted_id, replacement_id in ((42, 43), (43, 44)):
                await socket.send_json(
                    {
                        "type": "promote",
                        "generation": 7,
                        "streamId": promoted_id,
                        "fromRole": "continuity",
                        "toRole": "current",
                    }
                )
                assert await socket.receive_json() == {
                    "type": "promoted",
                    "generation": 7,
                    "streamId": promoted_id,
                    "role": "current",
                }
                metadata = await open_stream(
                    socket,
                    media_path,
                    generation=7,
                    streamId=replacement_id,
                    role="continuity",
                )
                assert metadata["streamId"] == replacement_id
                assert socket.close_code is None

            assert [decoder.command.stream_id for decoder in decoder_factory.instances] == [
                41,
                42,
                43,
                44,
            ]
            assert decoder_factory.instances[0].cancel_calls == 1
            assert decoder_factory.instances[1].cancel_calls == 1

    asyncio.run(scenario())


def test_pcm_socket_ignores_late_credit_after_current_eos_before_promoting_continuity(
    playback_app,
    media_path,
    decoder_factory,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await open_stream(
                socket,
                media_path,
                generation=7,
                streamId=41,
                role="current",
            )
            await open_stream(
                socket,
                media_path,
                generation=7,
                streamId=42,
                role="continuity",
            )
            current_decoder = decoder_factory.instances[0]
            current_chunks = iter(
                [
                    PcmChunk(frame_count=1, pcm=struct.pack("<ff", 0.41, -0.41)),
                    PcmChunk(frame_count=0, pcm=b""),
                ]
            )

            async def read_finite_current(
                *, max_frames: int, delivery_role: str | None = None
            ) -> PcmChunk:
                assert delivery_role == "current"
                current_decoder.read_calls += 1
                chunk = next(current_chunks)
                assert chunk.frame_count <= max_frames
                current_decoder.outstanding_credit_frames -= chunk.frame_count
                current_decoder.emitted_frames += chunk.frame_count
                return chunk

            current_decoder.read_credited_frames = read_finite_current

            await socket.send_json(
                {"type": "credit", "generation": 7, "streamId": 41, "frames": 1}
            )
            assert_pcm_message(
                await socket.receive_bytes(),
                generation=7,
                stream_id=41,
                role="current",
                sequence=0,
                frame_count=1,
            )
            await socket.send_json(
                {"type": "credit", "generation": 7, "streamId": 41, "frames": 1}
            )
            assert await socket.receive_json() == {
                "type": "eos",
                "generation": 7,
                "streamId": 41,
                "role": "current",
                "emittedFrames": 1,
                "authoritativeTotalFrames": 1,
            }

            await socket.send_json(
                {"type": "credit", "generation": 7, "streamId": 41, "frames": 128}
            )
            await socket.send_json(
                {
                    "type": "promote",
                    "generation": 7,
                    "streamId": 42,
                    "fromRole": "continuity",
                    "toRole": "current",
                }
            )

            assert await socket.receive_json() == {
                "type": "promoted",
                "generation": 7,
                "streamId": 42,
                "role": "current",
            }
            assert socket.close_code is None

    asyncio.run(scenario())


def test_pcm_socket_promotes_an_exact_completed_continuity_head_for_whole_track_repeat(
    playback_app,
    media_path,
    decoder_factory,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await open_stream(
                socket, media_path, generation=7, streamId=41, role="current"
            )
            await open_stream(
                socket, media_path, generation=7, streamId=42, role="continuity"
            )
            continuity_decoder = decoder_factory.instances[1]
            continuity_chunks = iter(
                [
                    PcmChunk(frame_count=1, pcm=struct.pack("<ff", 0.42, -0.42)),
                    PcmChunk(frame_count=0, pcm=b""),
                ]
            )

            async def read_finite_continuity(
                *, max_frames: int, delivery_role: str | None = None
            ) -> PcmChunk:
                assert delivery_role == "continuity"
                continuity_decoder.read_calls += 1
                chunk = next(continuity_chunks)
                assert chunk.frame_count <= max_frames
                continuity_decoder.outstanding_credit_frames -= chunk.frame_count
                continuity_decoder.emitted_frames += chunk.frame_count
                return chunk

            continuity_decoder.read_credited_frames = read_finite_continuity
            await socket.send_json(
                {"type": "credit", "generation": 7, "streamId": 42, "frames": 1}
            )
            assert_pcm_message(
                await socket.receive_bytes(),
                generation=7,
                stream_id=42,
                role="continuity",
                sequence=0,
                frame_count=1,
            )
            await socket.send_json(
                {"type": "credit", "generation": 7, "streamId": 42, "frames": 1}
            )
            assert (await socket.receive_json())["type"] == "eos"

            await socket.send_json(
                {
                    "type": "promote",
                    "generation": 7,
                    "streamId": 42,
                    "fromRole": "continuity",
                    "toRole": "current",
                }
            )
            assert await socket.receive_json() == {
                "type": "promoted",
                "generation": 7,
                "streamId": 42,
                "role": "current",
            }
            replacement = await open_stream(
                socket,
                media_path,
                generation=7,
                streamId=43,
                role="continuity",
            )
            assert replacement["streamId"] == 43
            assert socket.close_code is None

    asyncio.run(scenario())


def test_pcm_socket_accepts_exact_late_close_after_continuity_eos_and_opens_new_generation(
    playback_app,
    media_path,
    decoder_factory,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await open_stream(
                socket,
                media_path,
                generation=1,
                streamId=2,
                role="current",
            )
            await open_stream(
                socket,
                media_path,
                generation=1,
                streamId=3,
                role="continuity",
            )
            continuity_decoder = decoder_factory.instances[1]

            async def read_continuity_eos(
                *, max_frames: int, delivery_role: str | None = None
            ) -> PcmChunk:
                assert delivery_role == "continuity"
                continuity_decoder.read_calls += 1
                assert max_frames == 1
                return PcmChunk(frame_count=0, pcm=b"")

            continuity_decoder.read_credited_frames = read_continuity_eos

            await socket.send_json(
                {"type": "credit", "generation": 1, "streamId": 3, "frames": 1}
            )
            assert await socket.receive_json() == {
                "type": "eos",
                "generation": 1,
                "streamId": 3,
                "role": "continuity",
                "emittedFrames": 0,
                "authoritativeTotalFrames": 0,
            }

            await socket.send_json(
                {
                    "type": "close",
                    "generation": 1,
                    "streamId": 2,
                    "reason": "replacement",
                }
            )
            await socket.send_json(
                {
                    "type": "close",
                    "generation": 1,
                    "streamId": 3,
                    "reason": "replacement",
                }
            )

            metadata = await open_stream(
                socket,
                media_path,
                generation=2,
                streamId=4,
                role="current",
            )
            assert metadata["generation"] == 2
            assert metadata["streamId"] == 4
            assert socket.close_code is None

            await socket.send_json(
                {"type": "credit", "generation": 2, "streamId": 4, "frames": 1}
            )
            assert_pcm_message(
                await socket.receive_bytes(),
                generation=2,
                stream_id=4,
                role="current",
                sequence=0,
                frame_count=1,
            )

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("generation", "stream_id"),
    [(2, 3), (1, 99)],
    ids=["mismatched-generation", "unknown-stream"],
)
def test_pcm_socket_rejects_nonmatching_close_after_continuity_eos_with_4400(
    playback_app,
    media_path,
    decoder_factory,
    generation,
    stream_id,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await open_stream(
                socket,
                media_path,
                generation=1,
                streamId=3,
                role="continuity",
            )
            continuity_decoder = decoder_factory.instances[0]

            async def read_continuity_eos(
                *, max_frames: int, delivery_role: str | None = None
            ) -> PcmChunk:
                assert delivery_role == "continuity"
                assert max_frames == 1
                return PcmChunk(frame_count=0, pcm=b"")

            continuity_decoder.read_credited_frames = read_continuity_eos
            await socket.send_json(
                {"type": "credit", "generation": 1, "streamId": 3, "frames": 1}
            )
            assert (await socket.receive_json())["type"] == "eos"

            await socket.send_json(
                {
                    "type": "close",
                    "generation": generation,
                    "streamId": stream_id,
                    "reason": "replacement",
                }
            )
            assert await socket.receive_close() == 4400

    asyncio.run(scenario())


def test_opening_new_generation_replaces_both_old_roles_without_closing_socket(
    playback_app,
    media_path,
    decoder_factory,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await open_stream(socket, media_path, generation=7, streamId=41, role="current")
            await open_stream(
                socket,
                media_path,
                generation=7,
                streamId=42,
                role="continuity",
            )
            old_current, old_continuity = decoder_factory.instances

            metadata = await open_stream(
                socket,
                media_path,
                generation=8,
                streamId=43,
                role="current",
            )

            assert metadata["generation"] == 8
            assert metadata["streamId"] == 43
            assert old_current.cancel_calls == 1
            assert old_continuity.cancel_calls == 1
            assert len(decoder_factory.instances) == 3
            assert decoder_factory.instances[2].cancel_calls == 0
            assert playback_app.state.playback_pcm_registry.active_decoder_count == 1
            assert socket.close_code is None

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("filename", "error_code"),
    [
        ("decoder-failed.wav", "decoder_failed"),
        ("decoder-truncated-diagnostic.wav", "decoder_failed"),
        ("truncated-pcm.wav", "truncated_pcm"),
    ],
)
def test_decoder_failure_is_stream_scoped_and_socket_accepts_new_generation(
    playback_app,
    media_path,
    decoder_factory,
    filename,
    error_code,
):
    failing_path = media_path.with_name(filename)
    failing_path.write_bytes(b"failure-fixture")

    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await open_stream(socket, failing_path, generation=7, streamId=41)
            await socket.send_json(
                {"type": "credit", "generation": 7, "streamId": 41, "frames": 1}
            )
            error = await socket.receive_json()
            assert error["type"] == "error"
            assert error["generation"] == 7
            assert error["streamId"] == 41
            assert error["role"] == "current"
            assert error["code"] == error_code
            assert error["recoverable"] is False
            assert socket.close_code is None

            metadata = await open_stream(socket, media_path, generation=8, streamId=42)
            assert metadata["generation"] == 8
            assert metadata["streamId"] == 42

    asyncio.run(scenario())


def test_pcm_socket_serializes_current_and_continuity_websocket_sends():
    class ReadBarrier:
        def __init__(self) -> None:
            self.arrival_count = 0
            self.ready = asyncio.Event()

        async def arrive(self) -> None:
            self.arrival_count += 1
            if self.arrival_count == 2:
                self.ready.set()
            await self.ready.wait()

    class CreditedDecoderDouble:
        def __init__(self, read_barrier: ReadBarrier) -> None:
            self.read_barrier = read_barrier
            self.outstanding_credit_frames = 1
            self.emitted_frames = 0
            self.cancel_calls = 0

        async def read_credited_frames(
            self,
            *,
            max_frames: int,
            delivery_role: str | None = None,
        ) -> PcmChunk:
            assert max_frames == 1
            assert delivery_role in {"current", "continuity"}
            await self.read_barrier.arrive()
            self.outstanding_credit_frames = 0
            self.emitted_frames = 1
            amplitude = 0.25 if self.outstanding_credit_frames else 0.5
            return PcmChunk(frame_count=1, pcm=struct.pack("<ff", amplitude, -amplitude))

        async def cancel(self) -> None:
            self.cancel_calls += 1

    class ConcurrentSendRejectingWebSocketDouble:
        def __init__(self) -> None:
            self.send_in_progress = False
            self.overlapping_send_count = 0
            self.pcm_payloads: list[bytes] = []
            self.json_events: list[dict[str, object]] = []

        async def _send(self, collection: list, payload) -> None:
            if self.send_in_progress:
                self.overlapping_send_count += 1
                raise AssertionError("overlapping WebSocket sends")
            self.send_in_progress = True
            try:
                await asyncio.sleep(0)
                collection.append(payload)
            finally:
                self.send_in_progress = False

        async def send_bytes(self, payload: bytes) -> None:
            await self._send(self.pcm_payloads, payload)

        async def send_json(self, event: dict[str, object]) -> None:
            await self._send(self.json_events, event)

    async def scenario() -> None:
        registry = playback_stream_asgi.PlaybackPcmRegistry()
        websocket = ConcurrentSendRejectingWebSocketDouble()
        connection = await registry.acquire_connection(websocket)
        assert connection is not None
        read_barrier = ReadBarrier()
        current = playback_stream_asgi._PlaybackStream(
            decoder=CreditedDecoderDouble(read_barrier),
            generation=1,
            stream_id=1,
            role="current",
        )
        continuity = playback_stream_asgi._PlaybackStream(
            decoder=CreditedDecoderDouble(read_barrier),
            generation=1,
            stream_id=2,
            role="continuity",
        )
        connection._streams_by_id = {1: current, 2: continuity}
        connection._streams_by_role = {
            "current": current,
            "continuity": continuity,
        }

        try:
            drain_results = await asyncio.gather(
                connection._drain_stream_credit(current),
                connection._drain_stream_credit(continuity),
                return_exceptions=True,
            )

            assert drain_results == [None, None]
            assert websocket.overlapping_send_count == 0
            assert len(websocket.pcm_payloads) == 2
            payloads_by_stream = {
                struct.unpack(">BBHIIII", payload[4:24])[4]: payload
                for payload in websocket.pcm_payloads
            }
            assert_pcm_message(
                payloads_by_stream[1],
                generation=1,
                stream_id=1,
                role="current",
                sequence=0,
                frame_count=1,
            )
            assert_pcm_message(
                payloads_by_stream[2],
                generation=1,
                stream_id=2,
                role="continuity",
                sequence=0,
                frame_count=1,
            )
            assert [
                event for event in websocket.json_events if event.get("type") == "error"
            ] == []
            assert connection._closed is False
            assert connection._streams_by_id == {1: current, 2: continuity}
            assert connection._streams_by_role == {
                "current": current,
                "continuity": continuity,
            }
        finally:
            await connection.cleanup()

    asyncio.run(scenario())


def test_pcm_credit_drain_yields_to_unrelated_app_work(monkeypatch):
    class ImmediatelyBufferedDecoderDouble:
        def __init__(self, frame_count: int) -> None:
            self.outstanding_credit_frames = frame_count

        async def read_credited_frames(
            self,
            *,
            max_frames: int,
            delivery_role: str | None = None,
        ) -> PcmChunk:
            assert max_frames == self.outstanding_credit_frames
            assert delivery_role == "current"
            self.outstanding_credit_frames -= 1
            return PcmChunk(frame_count=1, pcm=struct.pack("<ff", 0.25, -0.25))

    class ImmediatelyWritableWebSocketDouble:
        def __init__(self) -> None:
            self.send_count = 0

        async def send_bytes(self, _payload: bytes) -> None:
            self.send_count += 1

    async def scenario() -> None:
        original_sleep = asyncio.sleep
        cooperative_pauses: list[float] = []

        async def recording_sleep(delay: float) -> None:
            cooperative_pauses.append(delay)
            await original_sleep(0)

        monkeypatch.setattr(playback_stream_asgi.asyncio, "sleep", recording_sleep)
        registry = playback_stream_asgi.PlaybackPcmRegistry()
        websocket = ImmediatelyWritableWebSocketDouble()
        connection = playback_stream_asgi._PlaybackPcmConnection(registry, websocket)
        decoder = ImmediatelyBufferedDecoderDouble(frame_count=64)
        stream = playback_stream_asgi._PlaybackStream(
            decoder=decoder,
            generation=1,
            stream_id=1,
            role="current",
        )
        connection._streams_by_id = {1: stream}
        connection._streams_by_role = {"current": stream}
        observed_send_counts: list[int] = []

        async def unrelated_app_work() -> None:
            await original_sleep(0)
            observed_send_counts.append(websocket.send_count)

        await asyncio.gather(
            connection._drain_stream_credit(stream),
            unrelated_app_work(),
        )

        assert observed_send_counts
        assert observed_send_counts[0] < 64
        assert websocket.send_count == 64
        assert len(cooperative_pauses) == 64
        assert all(delay > 0 for delay in cooperative_pauses)

    asyncio.run(scenario())


def test_disconnect_cancels_each_exact_decoder_once_and_releases_registry_counts(
    playback_app,
    media_path,
    decoder_factory,
):
    async def scenario() -> None:
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await open_stream(socket, media_path, streamId=1, role="current")
            await open_stream(socket, media_path, streamId=2, role="continuity")
            assert playback_app.state.playback_pcm_registry.active_decoder_count == 2

        assert [decoder.cancel_calls for decoder in decoder_factory.instances] == [1, 1]
        assert playback_app.state.playback_pcm_registry.active_connection_count == 0
        assert playback_app.state.playback_pcm_registry.active_decoder_count == 0

    asyncio.run(scenario())


def test_disconnect_while_decoder_open_is_pending_does_not_raise_on_metadata_send(
    playback_app,
    media_path,
    monkeypatch,
):
    class DisconnectingDuringOpenWebSocketDouble:
        def __init__(self) -> None:
            self.app = playback_app
            self.client_closed = False
            self.receive_calls = 0

        async def accept(self) -> None:
            pass

        async def receive(self) -> dict[str, object]:
            self.receive_calls += 1
            if self.receive_calls == 1:
                return {
                    "type": "websocket.receive",
                    "text": json.dumps(open_command(media_path)),
                }
            return {"type": "websocket.disconnect", "code": 1000}

        async def send_json(self, _event: dict[str, object]) -> None:
            if self.client_closed:
                raise RuntimeError('Cannot call "send" once a close message has been sent.')

    async def scenario() -> None:
        start_entered = asyncio.Event()
        allow_start = asyncio.Event()
        decoders: list[DecoderDouble] = []

        async def blocked_start(command) -> DecoderDouble:
            decoder = DecoderDouble(command)
            decoders.append(decoder)
            start_entered.set()
            await allow_start.wait()
            return decoder

        monkeypatch.setattr(playback_stream_asgi.PcmDecoderProcess, "start", blocked_start)
        registry = playback_stream_asgi.PlaybackPcmRegistry()
        websocket = DisconnectingDuringOpenWebSocketDouble()
        connection = await registry.acquire_connection(websocket)
        assert connection is not None

        run_task = asyncio.create_task(connection.run())
        await start_entered.wait()
        websocket.client_closed = True
        allow_start.set()

        await run_task

        assert len(decoders) == 1
        assert decoders[0].cancel_calls == 1
        assert registry.active_connection_count == 0
        assert registry.active_decoder_count == 0

    asyncio.run(scenario())


def test_unrelated_metadata_send_runtime_error_still_propagates(
    playback_app,
    media_path,
    decoder_factory,
):
    class FailingMetadataWebSocketDouble:
        def __init__(self) -> None:
            self.app = playback_app

        async def accept(self) -> None:
            pass

        async def receive(self) -> dict[str, object]:
            return {
                "type": "websocket.receive",
                "text": json.dumps(open_command(media_path)),
            }

        async def send_json(self, _event: dict[str, object]) -> None:
            raise RuntimeError("metadata send failed")

    async def scenario() -> None:
        registry = playback_stream_asgi.PlaybackPcmRegistry()
        websocket = FailingMetadataWebSocketDouble()
        connection = await registry.acquire_connection(websocket)
        assert connection is not None

        with pytest.raises(RuntimeError, match="metadata send failed"):
            await connection.run()

        assert len(decoder_factory.instances) == 1
        assert decoder_factory.instances[0].cancel_calls == 1
        assert registry.active_connection_count == 0
        assert registry.active_decoder_count == 0

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("disconnect_send", "expected_cancel_calls", "expected_finish_calls"),
    [
        ("pcm", 1, 0),
        ("eos", 0, 1),
    ],
    ids=["pcm-bytes", "clean-eos-json"],
)
def test_disconnect_during_stream_send_does_not_emit_decoder_error_and_releases_resources(
    playback_app,
    media_path,
    decoder_factory,
    monkeypatch,
    disconnect_send,
    expected_cancel_calls,
    expected_finish_calls,
):
    class DisconnectingPcmWebSocketDouble:
        def __init__(self) -> None:
            self.app = playback_app
            self.controls = [
                open_command(media_path),
                {"type": "credit", "generation": 1, "streamId": 1, "frames": 1},
            ]
            self.decoder_error_send_calls = 0

        async def accept(self) -> None:
            pass

        async def receive(self) -> dict[str, object]:
            return {
                "type": "websocket.receive",
                "text": json.dumps(self.controls.pop(0)),
            }

        async def send_json(self, event: dict[str, object]) -> None:
            if event.get("type") == "error":
                self.decoder_error_send_calls += 1
                raise RuntimeError("Cannot call send once a close message has been sent")
            if disconnect_send == "eos" and event.get("type") == "eos":
                raise playback_stream_asgi.WebSocketDisconnect(code=1006)

        async def send_bytes(self, _payload: bytes) -> None:
            if disconnect_send == "pcm":
                raise playback_stream_asgi.WebSocketDisconnect(code=1006)

    original_start = decoder_factory.start

    async def start_decoder(command):
        decoder = await original_start(command)
        if disconnect_send == "eos":
            async def read_clean_eos(
                *, max_frames: int, delivery_role: str | None = None
            ) -> PcmChunk:
                assert delivery_role == command.role
                decoder.read_calls += 1
                decoder.outstanding_credit_frames = 0
                return PcmChunk(frame_count=0, pcm=b"")

            decoder.read_credited_frames = read_clean_eos
        return decoder

    monkeypatch.setattr(playback_stream_asgi.PcmDecoderProcess, "start", start_decoder)

    async def scenario() -> None:
        registry = playback_stream_asgi.PlaybackPcmRegistry()
        websocket = DisconnectingPcmWebSocketDouble()
        connection = await registry.acquire_connection(websocket)
        assert connection is not None

        await connection.run()

        assert websocket.decoder_error_send_calls == 0
        assert len(decoder_factory.instances) == 1
        assert decoder_factory.instances[0].cancel_calls == expected_cancel_calls
        assert decoder_factory.instances[0].finish_calls == expected_finish_calls
        assert registry.active_connection_count == 0
        assert registry.active_decoder_count == 0

    asyncio.run(scenario())


def test_lifespan_shutdown_closes_live_socket_with_1001_and_leaves_zero_decoders(
    playback_app,
    media_path,
    decoder_factory,
):
    async def scenario() -> None:
        manager = websocket_session(playback_app, "/playback/pcm")
        socket = await manager.__aenter__()
        try:
            async with playback_app.router.lifespan_context(playback_app):
                await open_stream(socket, media_path)
                assert playback_app.state.playback_pcm_registry.active_decoder_count == 1

            assert await socket.receive_close() == 1001
            assert decoder_factory.instances[0].cancel_calls == 1
            assert playback_app.state.playback_pcm_registry.active_connection_count == 0
            assert playback_app.state.playback_pcm_registry.active_decoder_count == 0
        finally:
            await manager.__aexit__(None, None, None)

    asyncio.run(scenario())


def test_decoder_start_that_finishes_after_shutdown_is_cancelled_without_registration(
    playback_app,
    media_path,
    monkeypatch,
):
    class ObservedRegistry(playback_stream_asgi.PlaybackPcmRegistry):
        def __init__(self) -> None:
            super().__init__()
            self.shutdown_started = asyncio.Event()
            self.shutdown_finished = asyncio.Event()

        async def shutdown(self) -> None:
            self.shutdown_started.set()
            try:
                await super().shutdown()
            finally:
                self.shutdown_finished.set()

    class RecordingWebSocketDouble:
        def __init__(self) -> None:
            self.app = playback_app
            self.events: list[dict[str, object]] = []

        async def send_json(self, event: dict[str, object]) -> None:
            self.events.append(event)

        async def close(self, *, code: int) -> None:
            assert code == 1001

    async def scenario() -> None:
        start_entered = asyncio.Event()
        allow_start = asyncio.Event()
        decoders: list[DecoderDouble] = []

        async def blocked_start(command) -> DecoderDouble:
            decoder = DecoderDouble(command)
            decoders.append(decoder)
            start_entered.set()
            await allow_start.wait()
            return decoder

        monkeypatch.setattr(playback_stream_asgi.PcmDecoderProcess, "start", blocked_start)
        registry = ObservedRegistry()
        websocket = RecordingWebSocketDouble()
        connection = await registry.acquire_connection(websocket)
        assert connection is not None

        open_task = asyncio.create_task(connection._open(open_command(media_path)))
        await start_entered.wait()
        shutdown_task = asyncio.create_task(registry.shutdown())
        await registry.shutdown_started.wait()
        shutdown_returned_while_start_was_blocked = registry.shutdown_finished.is_set()

        allow_start.set()
        await asyncio.gather(open_task, shutdown_task)

        assert shutdown_returned_while_start_was_blocked is False
        assert websocket.events == []
        assert len(decoders) == 1
        assert decoders[0].cancel_calls == 1
        assert connection._streams_by_id == {}
        assert connection._streams_by_role == {}
        assert registry.active_decoder_count == 0
        assert registry.active_connection_count == 0

    asyncio.run(scenario())


def test_connection_accept_failure_releases_admitted_registry_slot():
    class AcceptFailureWebSocketDouble:
        async def accept(self) -> None:
            raise RuntimeError("accept failed")

    async def scenario() -> None:
        registry = playback_stream_asgi.PlaybackPcmRegistry()
        connection = await registry.acquire_connection(AcceptFailureWebSocketDouble())
        assert connection is not None

        with pytest.raises(RuntimeError, match="accept failed"):
            await connection.run()

        assert registry.active_connection_count == 0

    asyncio.run(scenario())


def test_registry_shutdown_waits_for_racing_reject_cleanup_when_close_raises():
    class ObservedRegistry(playback_stream_asgi.PlaybackPcmRegistry):
        def __init__(self) -> None:
            super().__init__()
            self.shutdown_started = asyncio.Event()
            self.shutdown_finished = asyncio.Event()

        async def shutdown(self) -> None:
            self.shutdown_started.set()
            try:
                await super().shutdown()
            finally:
                self.shutdown_finished.set()

    class BlockingRejectWebSocketDouble:
        def __init__(self) -> None:
            self.close_entered = asyncio.Event()
            self.allow_close = asyncio.Event()

        async def accept(self) -> None:
            pass

        async def receive(self) -> dict[str, object]:
            return {"type": "unexpected-message"}

        async def close(self, *, code: int) -> None:
            assert code == playback_stream_asgi.CLOSE_INVALID_CONTROL
            self.close_entered.set()
            await self.allow_close.wait()
            raise RuntimeError("reject close failed")

    async def scenario() -> None:
        registry = ObservedRegistry()
        websocket = BlockingRejectWebSocketDouble()
        connection = await registry.acquire_connection(websocket)
        assert connection is not None
        connection_shutdown_entered = asyncio.Event()
        connection_shutdown_returned = asyncio.Event()
        original_connection_shutdown = connection.shutdown

        async def observed_connection_shutdown() -> None:
            connection_shutdown_entered.set()
            try:
                await original_connection_shutdown()
            finally:
                connection_shutdown_returned.set()

        connection.shutdown = observed_connection_shutdown

        run_task = asyncio.create_task(connection.run())
        await websocket.close_entered.wait()
        shutdown_task = asyncio.create_task(registry.shutdown())
        await connection_shutdown_entered.wait()
        connection_shutdown_returned_while_close_was_blocked = (
            connection_shutdown_returned.is_set()
        )

        websocket.allow_close.set()
        results = await asyncio.gather(run_task, shutdown_task, return_exceptions=True)

        assert connection_shutdown_returned_while_close_was_blocked is False
        assert isinstance(results[0], RuntimeError)
        assert registry.active_connection_count == 0

    asyncio.run(scenario())


def test_registry_shutdown_raises_cleanup_failures_after_releasing_healthy_resources():
    class ShutdownWebSocketDouble:
        async def close(self, *, code: int) -> None:
            assert code == 1001
            raise RuntimeError("socket close failed")

    class ShutdownDecoderDouble:
        def __init__(self, *, cancel_error: bool = False) -> None:
            self.cancel_calls = 0
            self.cancel_error = cancel_error

        async def cancel(self) -> None:
            self.cancel_calls += 1
            if self.cancel_error:
                raise RuntimeError("decoder cancel failed")

    async def scenario() -> None:
        registry = playback_stream_asgi.PlaybackPcmRegistry()
        connection = await registry.acquire_connection(ShutdownWebSocketDouble())
        assert connection is not None
        assert await registry.acquire_decoder() is True
        assert await registry.acquire_decoder() is True

        failing_decoder = ShutdownDecoderDouble(cancel_error=True)
        healthy_decoder = ShutdownDecoderDouble()
        current = playback_stream_asgi._PlaybackStream(
            decoder=failing_decoder,
            generation=1,
            stream_id=1,
            role="current",
        )
        continuity = playback_stream_asgi._PlaybackStream(
            decoder=healthy_decoder,
            generation=1,
            stream_id=2,
            role="continuity",
        )
        connection._streams_by_id = {1: current, 2: continuity}
        connection._streams_by_role = {
            "current": current,
            "continuity": continuity,
        }

        with pytest.raises(RuntimeError, match="decoder cancel failed"):
            await registry.shutdown()

        assert failing_decoder.cancel_calls == 1
        assert healthy_decoder.cancel_calls == 1
        assert registry.active_decoder_count == 1
        assert registry.active_connection_count == 0
        assert connection._streams_by_id == {1: current}
        assert connection._streams_by_role == {"current": current}

    asyncio.run(scenario())


def test_registry_shutdown_reports_cancelled_decoder_and_releases_healthy_resources():
    class ShutdownWebSocketDouble:
        def __init__(self) -> None:
            self.close_calls = 0

        async def close(self, *, code: int) -> None:
            assert code == 1001
            self.close_calls += 1

    class ShutdownDecoderDouble:
        def __init__(self, *, cancel_with_cancelled_error: bool = False) -> None:
            self.cancel_calls = 0
            self.cancel_with_cancelled_error = cancel_with_cancelled_error

        async def cancel(self) -> None:
            self.cancel_calls += 1
            if self.cancel_with_cancelled_error:
                raise asyncio.CancelledError()

    async def scenario() -> None:
        registry = playback_stream_asgi.PlaybackPcmRegistry()
        websocket = ShutdownWebSocketDouble()
        connection = await registry.acquire_connection(websocket)
        assert connection is not None
        assert await registry.acquire_decoder() is True
        assert await registry.acquire_decoder() is True

        cancelled_decoder = ShutdownDecoderDouble(cancel_with_cancelled_error=True)
        healthy_decoder = ShutdownDecoderDouble()
        current = playback_stream_asgi._PlaybackStream(
            decoder=cancelled_decoder,
            generation=1,
            stream_id=1,
            role="current",
        )
        continuity = playback_stream_asgi._PlaybackStream(
            decoder=healthy_decoder,
            generation=1,
            stream_id=2,
            role="continuity",
        )
        connection._streams_by_id = {1: current, 2: continuity}
        connection._streams_by_role = {
            "current": current,
            "continuity": continuity,
        }

        with pytest.raises(RuntimeError, match="CancelledError"):
            await registry.shutdown()

        assert cancelled_decoder.cancel_calls == 1
        assert healthy_decoder.cancel_calls == 1
        assert websocket.close_calls == 1
        assert registry.active_decoder_count == 1
        assert registry.active_connection_count == 0
        assert connection._streams_by_id == {1: current}
        assert connection._streams_by_role == {"current": current}

    asyncio.run(scenario())


def test_registry_shutdown_reports_cancelled_connection_shutdown_task():
    class ShutdownWebSocketDouble:
        pass

    async def scenario() -> None:
        registry = playback_stream_asgi.PlaybackPcmRegistry()
        connection = await registry.acquire_connection(ShutdownWebSocketDouble())
        assert connection is not None
        shutdown_calls = 0

        async def cancelled_shutdown() -> None:
            nonlocal shutdown_calls
            shutdown_calls += 1
            raise asyncio.CancelledError()

        connection.shutdown = cancelled_shutdown

        with pytest.raises(RuntimeError, match="CancelledError"):
            await registry.shutdown()

        assert shutdown_calls == 1

    asyncio.run(scenario())
