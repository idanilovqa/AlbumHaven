"""Ordinary playback cleanup at synthetic subprocess and pipe boundaries.

Exercise the real decoder, route retirement, and registry with synthetic I/O.
Test bodies do not open media, authentication configuration, or a database,
launch ffmpeg, instantiate retained adapters, or patch asyncio globally.
Import/dependency isolation remains a separate execution gate. Events establish
ordering; watchdogs bound test failures.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.routes import playback_stream_asgi as route
from music_app.services import mp3_gapless
from music_app.services import playback_pcm as pcm


_WATCHDOG_SECONDS = 2.0


async def _bounded(awaitable):
    """Unlike wait_for, a failed watchdog never waits for cancellation to settle."""
    task = asyncio.ensure_future(awaitable)
    done, _ = await asyncio.wait({task}, timeout=_WATCHDOG_SECONDS)
    if not done:
        task.cancel()
        task.add_done_callback(_observe)
        pytest.fail("synthetic cleanup test exceeded its watchdog")
    return task.result()


def _observe(task):
    if not task.cancelled():
        task.exception()


@pytest.fixture(autouse=True)
def _short_deadlines(monkeypatch):
    for name, seconds in {
        "_TERMINATE_WAIT_SECONDS": 0.01,
        "_KILL_WAIT_SECONDS": 0.01,
        "_PIPE_DRAIN_SECONDS": 0.01,
        "_CLEANUP_JOIN_SECONDS": 0.05,
        "_EOF_SETTLEMENT_SECONDS": 0.5,
        "_STARTUP_WAIT_SECONDS": 0.5,
    }.items():
        monkeypatch.setattr(pcm, name, seconds)
    monkeypatch.setattr(route, "PCM_CLEANUP_JOIN_SECONDS", 0.08)


class _Pipe:
    def __init__(self, *, blocked=False, error=None):
        self.started = asyncio.Event()
        self.allowed = asyncio.Event()
        if not blocked:
            self.allowed.set()
        self.error = error
        self.eof = False
        self.calls = 0
        self.cancelled_reads = 0
        self.active_reads = 0
        self.max_active_reads = 0

    async def read(self, _size):
        self.calls += 1
        self.active_reads += 1
        self.max_active_reads = max(self.max_active_reads, self.active_reads)
        self.started.set()
        try:
            try:
                await self.allowed.wait()
            except asyncio.CancelledError:
                self.cancelled_reads += 1
                raise
            if self.error is not None:
                raise self.error
            self.eof = True
            return b""
        finally:
            self.active_reads -= 1

    def at_eof(self):
        return self.eof


class _Process:
    """Signals and wait do not imply EOF; each boundary settles independently."""

    def __init__(self, *, kill_exits=True, stdout=None, stderr=None, wait_error=None):
        self.stdout = stdout if stdout is not None else _Pipe()
        self.stderr = stderr if stderr is not None else _Pipe()
        self.returncode = None
        self.kill_exits = kill_exits
        self.wait_error = wait_error
        self.wait_started = asyncio.Event()
        self.exit_allowed = asyncio.Event()
        self.terminate_called = asyncio.Event()
        self.kill_called = asyncio.Event()
        self.terminate_calls = 0
        self.kill_calls = 0
        self.wait_calls = 0
        self.wait_cancellations = 0

    async def wait(self):
        self.wait_calls += 1
        self.wait_started.set()
        try:
            await self.exit_allowed.wait()
        except asyncio.CancelledError:
            self.wait_cancellations += 1
            raise
        if self.wait_error is not None:
            raise self.wait_error
        return self.returncode

    def terminate(self):
        self.terminate_calls += 1
        self.terminate_called.set()  # Deliberately ignored, as a live child can do.

    def kill(self):
        self.kill_calls += 1
        self.kill_called.set()
        if self.kill_exits:
            self.allow_exit(-9)

    def allow_exit(self, code=0):
        self.returncode = code
        self.exit_allowed.set()

    def settle_all(self):
        self.allow_exit()
        for pipe in (self.stdout, self.stderr):
            if pipe is not None:
                pipe.allowed.set()


def _command(stream_id=11, role="current"):
    return pcm.PcmOpenCommand(
        generation=7, stream_id=stream_id, role=role,
        path=Path("synthetic-cleanup.flac"), start_frame=0,
        sample_rate=48_000, provisional_duration_seconds=900,
    )


def _decoder(process):
    return pcm.PcmDecoderProcess(_command(), process)


async def _settle(decoder, process, *callers):
    """Always release synthetic gates, including after an assertion failure."""
    process.settle_all()
    decoder.request_cancel()
    await _bounded(asyncio.gather(
        decoder.wait_closed(), *callers, return_exceptions=True))


class _LateFactory:
    def __init__(self, process):
        self.process = process
        self.entered = asyncio.Event()
        self.allowed = asyncio.Event()
        self.calls = 0
        self.cancellations = 0

    async def __call__(self, *_args, **_kwargs):
        self.calls += 1
        self.entered.set()
        try:
            await self.allowed.wait()
        except asyncio.CancelledError:
            self.cancellations += 1
            raise
        return self.process


@pytest.fixture
def no_probe(monkeypatch):
    async def no_gapless(_path, _executable, *, probe):
        assert type(probe) is mp3_gapless.Mp3GaplessProbe
        return None

    monkeypatch.setattr(mp3_gapless, "ignored_mp3_gapless_info", no_gapless)


@pytest.mark.asyncio
async def test_ignored_terminate_escalates_to_one_kill_and_one_wait():
    process = _Process()
    decoder = _decoder(process)
    try:
        decoder.request_cancel()
        cleanup = decoder._cleanup_task
        await _bounded(asyncio.gather(decoder.cancel(), decoder.cancel()))
        await _bounded(decoder.wait_closed())
        assert decoder._cleanup_task is cleanup
        assert decoder.cleanup_complete
        assert process.terminate_calls == process.kill_calls == process.wait_calls == 1
        assert process.wait_cancellations == 0
        assert decoder.metadata.capture_extent_frames48 is None
        await _bounded(decoder.cancel())
        assert decoder._cleanup_task is cleanup
        assert process.terminate_calls == process.kill_calls == process.wait_calls == 1
    finally:
        await _settle(decoder, process)


@pytest.mark.asyncio
async def test_stubborn_child_is_unresolved_without_canceling_or_restarting_wait():
    process = _Process(kill_exits=False)
    decoder = _decoder(process)
    try:
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(decoder.cancel())
        cleanup, wait = decoder._cleanup_task, decoder._wait_task
        assert cleanup.done() and not wait.done()
        assert not decoder.cleanup_complete
        assert process.returncode is None
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(decoder.cancel())
        assert decoder._cleanup_task is cleanup
        assert decoder._wait_task is wait
        assert process.terminate_calls == process.kill_calls == process.wait_calls == 1
        assert process.wait_cancellations == 0
        process.allow_exit(-9)
        await _bounded(decoder.wait_closed())
        assert decoder.cleanup_complete
        await _bounded(decoder.cancel())
        assert decoder._cleanup_task is cleanup
    finally:
        await _settle(decoder, process)


@pytest.mark.asyncio
@pytest.mark.parametrize("blocked", [(True, False), (False, True), (True, True)])
async def test_stalled_pipes_remain_owned_until_late_eof(blocked):
    process = _Process(stdout=_Pipe(blocked=blocked[0]), stderr=_Pipe(blocked=blocked[1]))
    decoder = _decoder(process)
    try:
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(decoder.cancel())
        assert process.returncode == -9
        assert not decoder.cleanup_complete
        stdout_task, stderr_task = decoder._stdout_discard_task, decoder._stderr_task
        for task, stalled in zip((stdout_task, stderr_task), blocked):
            assert task.done() is not stalled
            assert not task.cancelled()
        process.stdout.allowed.set()
        process.stderr.allowed.set()
        await _bounded(decoder.wait_closed())
        assert decoder.cleanup_complete
        assert decoder._stdout_discard_task is stdout_task
        assert decoder._stderr_task is stderr_task
        assert process.stdout.cancelled_reads == process.stderr.cancelled_reads == 0
        assert process.terminate_calls == process.kill_calls == process.wait_calls == 1
    finally:
        await _settle(decoder, process)


@pytest.mark.asyncio
async def test_cancelled_launch_keeps_callback_owner_and_late_process(no_probe):
    process = _Process()
    factory = _LateFactory(process)
    retained = []
    start = asyncio.create_task(pcm.PcmDecoderProcess.start(
        _command(), ffmpeg_executable="synthetic-not-executed", process_factory=factory,
        on_start=retained.append))
    decoder = None
    try:
        await _bounded(factory.entered.wait())
        assert len(retained) == 1  # Retained before the factory's first await.
        decoder = retained[0]
        launch = decoder._launch_task
        start.cancel()
        with pytest.raises(asyncio.CancelledError):
            await _bounded(start)
        cleanup = decoder._cleanup_task
        assert cleanup is not None
        assert decoder._process is None
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(decoder.cancel())
        assert decoder._launch_task is launch and not launch.done()
        assert not launch.cancelled() and factory.cancellations == 0
        assert decoder._cleanup_task is cleanup and not cleanup.done()
        assert not decoder.cleanup_complete
        factory.allowed.set()
        await _bounded(decoder.wait_closed())
        assert decoder._process is process
        assert decoder.cleanup_complete
        assert factory.calls == process.terminate_calls == process.kill_calls == process.wait_calls == 1
        assert decoder.metadata.authoritative_total_frames is None
        assert decoder.metadata.capture_extent_frames48 is None
    finally:
        factory.allowed.set()
        process.settle_all()
        await _bounded(asyncio.gather(start, return_exceptions=True))
        if decoder is None and retained:
            decoder = retained[0]
        if decoder is not None:
            await _settle(decoder, process)


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["stdout", "stderr", "both"])
async def test_missing_output_pipes_use_same_retained_cleanup(no_probe, missing):
    process = _Process()
    if missing in {"stdout", "both"}:
        process.stdout = None
    if missing in {"stderr", "both"}:
        process.stderr = None
    factory = _LateFactory(process)
    factory.allowed.set()
    retained = []
    try:
        with pytest.raises(RuntimeError, match="output pipes"):
            await _bounded(pcm.PcmDecoderProcess.start(
                _command(), ffmpeg_executable="synthetic-not-executed",
                process_factory=factory, on_start=retained.append))
        assert len(retained) == 1
        decoder = retained[0]
        cleanup = decoder._cleanup_task
        assert cleanup is not None
        await _bounded(decoder.cancel())
        await _bounded(decoder.wait_closed())
        assert decoder._cleanup_task is cleanup
        assert decoder.cleanup_complete
        assert decoder._process is process
        assert process.terminate_calls == process.kill_calls == process.wait_calls == 1
        assert decoder.metadata.capture_extent_frames48 is None
    finally:
        process.settle_all()
        for decoder in retained:
            await _settle(decoder, process)


@pytest.mark.asyncio
async def test_cancelled_read_is_terminal_and_discard_never_overlaps_reader():
    process = _Process(stdout=_Pipe(blocked=True))
    decoder = _decoder(process)
    decoder.grant_credit(1)
    read = asyncio.create_task(decoder.read_credited_frames(max_frames=1))
    try:
        await _bounded(process.stdout.started.wait())
        read.cancel()
        with pytest.raises(asyncio.CancelledError):
            await _bounded(read)
        cleanup = decoder._cleanup_task
        assert cleanup is not None
        assert decoder.emitted_frames == 0
        assert decoder.outstanding_credit_frames == 1
        with pytest.raises(RuntimeError, match="cancelled"):
            await _bounded(decoder.finish())
        with pytest.raises(RuntimeError, match="cancelled"):
            await _bounded(decoder.read_credited_frames(max_frames=1))
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(decoder.cancel())
        assert process.stdout.cancelled_reads == 1
        assert process.stdout.max_active_reads == 1
        process.stdout.allowed.set()
        await _bounded(decoder.wait_closed())
        assert decoder._cleanup_task is cleanup
        assert decoder.cleanup_complete
        assert decoder.metadata.authoritative_total_frames is None
        assert decoder.metadata.capture_extent_frames48 is None
    finally:
        await _settle(decoder, process, read)


@pytest.mark.asyncio
@pytest.mark.parametrize("blocked", ["wait", "stderr"])
async def test_cancelled_eof_never_cancels_settlement_or_publishes_late_extent(blocked):
    process = _Process(kill_exits=False, stderr=_Pipe(blocked=blocked == "stderr"))
    if blocked == "stderr":
        process.allow_exit()
    decoder = _decoder(process)
    decoder.grant_credit(1)
    read = asyncio.create_task(decoder.read_credited_frames(max_frames=1))
    try:
        await _bounded(process.wait_started.wait())
        await _bounded(process.stderr.started.wait())
        read.cancel()
        with pytest.raises(asyncio.CancelledError):
            await _bounded(read)
        wait, stderr = decoder._wait_task, decoder._stderr_task
        assert decoder._cleanup_task is not None
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(decoder.cancel())
        assert not wait.cancelled() and not stderr.cancelled()
        assert process.wait_cancellations == process.stderr.cancelled_reads == 0
        process.settle_all()
        await _bounded(decoder.wait_closed())
        assert decoder._wait_task is wait and decoder._stderr_task is stderr
        assert decoder.cleanup_complete
        assert decoder.metadata.authoritative_total_frames is None
        assert decoder.metadata.capture_extent_frames48 is None
        with pytest.raises(RuntimeError, match="cancelled"):
            await _bounded(decoder.finish())
    finally:
        await _settle(decoder, process, read)


@pytest.mark.asyncio
async def test_eof_timeout_starts_cleanup_without_publishing_extent(monkeypatch):
    monkeypatch.setattr(pcm, "_EOF_SETTLEMENT_SECONDS", 0.03)
    process = _Process()
    decoder = _decoder(process)
    try:
        decoder.grant_credit(1)
        with pytest.raises(RuntimeError, match="EOF settlement timed out"):
            await _bounded(decoder.read_credited_frames(max_frames=1))
        cleanup = decoder._cleanup_task
        assert cleanup is not None
        await _bounded(decoder.wait_closed())
        assert decoder.cleanup_complete
        assert process.terminate_calls == process.kill_calls == process.wait_calls == 1
        assert decoder.metadata.capture_extent_frames48 is None
        assert decoder.metadata.authoritative_total_frames is None
    finally:
        await _settle(decoder, process)


class _Socket:
    def __init__(self):
        self.app = SimpleNamespace(state=SimpleNamespace(config=object()))
        self.events = []
        self.close_codes = []
        self.closed = asyncio.Event()

    async def send_json(self, event):
        self.events.append(event)

    async def send_bytes(self, value):
        self.events.append(value)

    async def close(self, *, code):
        self.close_codes.append(code)
        self.closed.set()


class _Registry(route.PlaybackPcmRegistry):
    def __init__(self):
        super().__init__()
        self.decoder_releases = 0
        self.connection_releases = 0

    async def release_decoder(self):
        self.decoder_releases += 1
        await super().release_decoder()

    async def release_connection(self, connection):
        self.connection_releases += 1
        await super().release_connection(connection)


async def _connection(decoder=None, socket=None):
    registry = _Registry()
    socket = socket if socket is not None else _Socket()
    connection = await _bounded(registry.acquire_connection(socket))
    assert connection is not None
    stream = None
    if decoder is not None:
        assert await _bounded(registry.acquire_decoder())
        stream = route._PlaybackStream(decoder, 7, 11, "current")
        connection._streams_by_id[11] = stream
        connection._streams_by_role["current"] = stream
    return registry, socket, connection, stream


def _close_control():
    return {"generation": 7, "streamId": 11, "reason": "synthetic test"}


def _open_control(stream_id=11, role="current"):
    return {
        "type": "open", "generation": 7, "streamId": stream_id,
        "role": role, "path": "synthetic-cleanup.flac", "startFrame": 0,
        "sampleRate": 48_000, "durationSeconds": 900,
    }


def _route_factory(monkeypatch, factory):
    """Inject only I/O boundaries; preserve the real start and route code."""
    original_start = pcm.PcmDecoderProcess.start

    async def start(cls, command, *, on_start=None):
        return await original_start(
            command, ffmpeg_executable="synthetic-not-executed",
            process_factory=factory, on_start=on_start)

    def permit(_action, **_kwargs):
        async def check(_socket):
            return None
        return check

    monkeypatch.setattr(pcm.PcmDecoderProcess, "start", classmethod(start))
    monkeypatch.setattr(route, "require_action", permit)
    monkeypatch.setattr(route, "resolve_configured_media_path", lambda _config, _path: _command().path)


async def _settle_connection(connection, decoder, process, *callers):
    await _settle(decoder, process, *callers)
    # Failure cases intentionally retain capacity; collect errors, not success.
    await _bounded(asyncio.gather(connection.cleanup(), return_exceptions=True))
    if connection._finalize_task is not None:
        await _bounded(asyncio.gather(connection._finalize_task, return_exceptions=True))


@pytest.mark.asyncio
async def test_cancelled_close_keeps_one_release_and_capacity_until_late_settlement(monkeypatch):
    monkeypatch.setattr(route, "MAX_PLAYBACK_DECODERS", 1)
    process = _Process(kill_exits=False, stdout=_Pipe(blocked=True), stderr=_Pipe(blocked=True))
    decoder = _decoder(process)
    registry, socket, connection, stream = await _connection(decoder)
    close = asyncio.create_task(connection._close_stream(_close_control()))
    try:
        await _bounded(process.terminate_called.wait())
        cleanup, release = decoder._cleanup_task, stream.release_task
        close.cancel()
        with pytest.raises(asyncio.CancelledError):
            await _bounded(close)
        assert not cleanup.cancelled() and not release.cancelled()
        assert stream in connection._retiring_streams
        assert 11 not in connection._streams_by_id
        assert "current" not in connection._streams_by_role
        assert registry.active_decoder_count == 1 and registry.decoder_releases == 0
        assert await _bounded(registry.acquire_decoder()) is False
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(connection._close_stream(_close_control()))
        assert stream.release_task is release and decoder._cleanup_task is cleanup
        assert process.terminate_calls == process.kill_calls == process.wait_calls == 1
        assert not release.done()
        process.allow_exit(-9)
        process.stdout.allowed.set()
        # Stderr is still stalled: a known returncode and stdout EOF are not enough.
        await _bounded(asyncio.shield(decoder._wait_task))
        await _bounded(asyncio.shield(decoder._stdout_discard_task))
        assert not decoder.cleanup_complete and not release.done()
        assert registry.active_decoder_count == 1 and registry.decoder_releases == 0
        process.stderr.allowed.set()
        await _bounded(asyncio.shield(release))
        assert decoder.cleanup_complete
        assert stream not in connection._retiring_streams
        assert registry.active_decoder_count == 0 and registry.decoder_releases == 1
        # A stale internal removal must join the existing release, not decrement
        # another stream's reservation. The real registry masks underflow at zero.
        assert await _bounded(registry.acquire_decoder())
        await _bounded(connection._remove_stream(stream))
        await _bounded(decoder.cancel())
        assert registry.active_decoder_count == 1 and registry.decoder_releases == 1
        await _bounded(registry.release_decoder())
        assert socket.events == []
    finally:
        await _settle_connection(connection, decoder, process, close)


@pytest.mark.asyncio
async def test_cancelled_disconnect_retains_one_finalizer_and_releases_connection_late():
    process = _Process(kill_exits=False)
    decoder = _decoder(process)
    registry, socket, connection, stream = await _connection(decoder)
    shutdown = asyncio.create_task(connection.shutdown())
    try:
        await _bounded(socket.closed.wait())
        await _bounded(process.terminate_called.wait())
        finalizer, release, cleanup = connection._finalize_task, stream.release_task, decoder._cleanup_task
        shutdown.cancel()
        with pytest.raises(asyncio.CancelledError):
            await _bounded(shutdown)
        assert not finalizer.cancelled() and not release.cancelled() and not cleanup.cancelled()
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(connection.cleanup())
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(connection.shutdown())
        assert connection._finalize_task is finalizer
        assert stream.release_task is release and decoder._cleanup_task is cleanup
        assert socket.close_codes == [1001]
        assert not connection._finalized
        assert registry.active_connection_count == registry.active_decoder_count == 1
        assert registry.connection_releases == registry.decoder_releases == 0
        process.allow_exit(-9)
        await _bounded(asyncio.shield(finalizer))
        await _bounded(connection.cleanup())
        await _bounded(connection.shutdown())
        assert connection._finalized
        assert registry.active_connection_count == registry.active_decoder_count == 0
        assert registry.connection_releases == registry.decoder_releases == 1
        assert socket.close_codes == [1001]
    finally:
        await _settle_connection(connection, decoder, process, shutdown)


@pytest.mark.asyncio
async def test_route_cancelled_launch_retains_reservation_until_late_child_reaped(monkeypatch, no_probe):
    process = _Process()
    factory = _LateFactory(process)
    _route_factory(monkeypatch, factory)
    registry, socket, connection, _ = await _connection()
    opening = asyncio.create_task(connection._open(_open_control()))
    stream = None
    try:
        await _bounded(factory.entered.wait())
        stream = connection._streams_by_id[11]
        decoder = stream.decoder
        assert registry.active_decoder_count == 1 and registry.decoder_releases == 0
        assert decoder._process is None and socket.events == []
        opening.cancel()
        with pytest.raises(asyncio.CancelledError):
            await _bounded(opening)
        release, cleanup = stream.release_task, decoder._cleanup_task
        assert release is not None and cleanup is not None
        assert stream in connection._retiring_streams
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(connection.cleanup())
        finalizer = connection._finalize_task
        assert registry.active_decoder_count == registry.active_connection_count == 1
        assert registry.decoder_releases == registry.connection_releases == 0
        assert factory.cancellations == 0 and not decoder._launch_task.cancelled()
        factory.allowed.set()
        await _bounded(asyncio.shield(finalizer))
        assert decoder._process is process and decoder.cleanup_complete
        assert stream.release_task is release and decoder._cleanup_task is cleanup
        assert registry.active_decoder_count == registry.active_connection_count == 0
        assert registry.decoder_releases == registry.connection_releases == 1
        assert process.terminate_calls == process.kill_calls == process.wait_calls == factory.calls == 1
        assert socket.events == []  # No late metadata, PCM or EOF after cancellation.
    finally:
        factory.allowed.set()
        process.settle_all()
        await _bounded(asyncio.gather(opening, return_exceptions=True))
        if stream is not None:
            await _settle_connection(connection, stream.decoder, process)
        else:
            await _bounded(asyncio.gather(connection.cleanup(), return_exceptions=True))


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["stdout", "stderr"])
async def test_route_missing_pipe_retains_live_child_capacity(monkeypatch, no_probe, missing):
    process = _Process(kill_exits=False)
    setattr(process, missing, None)
    factory = _LateFactory(process)
    factory.allowed.set()
    _route_factory(monkeypatch, factory)
    registry, socket, connection, _ = await _connection()
    stream = None
    try:
        assert await _bounded(connection._open(_open_control())) is True
        assert len(connection._retiring_streams) == 1
        stream = next(iter(connection._retiring_streams))
        decoder = stream.decoder
        await _bounded(process.kill_called.wait())
        assert len(socket.events) == 1 and socket.events[0]["type"] == "error"
        assert decoder._process is process and not decoder.cleanup_complete
        assert registry.active_decoder_count == 1 and registry.decoder_releases == 0
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(connection.cleanup())
        assert registry.active_connection_count == 1 and registry.connection_releases == 0
        process.allow_exit(-9)
        await _bounded(asyncio.shield(connection._finalize_task))
        assert decoder.cleanup_complete
        assert registry.active_decoder_count == registry.active_connection_count == 0
        assert registry.decoder_releases == registry.connection_releases == 1
        assert process.terminate_calls == process.kill_calls == process.wait_calls == 1
        assert not any(event["type"] in {"metadata", "eos"} for event in socket.events)
    finally:
        process.settle_all()
        if stream is not None:
            await _settle_connection(connection, stream.decoder, process)
        else:
            await _bounded(asyncio.gather(connection.cleanup(), return_exceptions=True))


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["wait", "stdout", "stderr"])
async def test_failed_wait_or_drain_never_releases_or_rehabilitates_capacity(monkeypatch, failure):
    monkeypatch.setattr(route, "MAX_PLAYBACK_DECODERS", 1)
    process = _Process(
        stdout=_Pipe(error=OSError("synthetic stdout failure") if failure == "stdout" else None),
        stderr=_Pipe(error=OSError("synthetic stderr failure") if failure == "stderr" else None),
        wait_error=OSError("synthetic wait failure") if failure == "wait" else None,
    )
    decoder = _decoder(process)
    registry, _, connection, stream = await _connection(decoder)
    try:
        with pytest.raises(RuntimeError, match="cleanup failed"):
            await _bounded(connection._close_stream(_close_control()))
        release, cleanup = stream.release_task, decoder._cleanup_task
        assert release.done() and cleanup.done()
        assert process.returncode is not None  # Exit alone cannot prove settlement.
        assert not decoder.cleanup_complete
        assert stream in connection._retiring_streams
        assert release in connection._retire_tasks
        assert registry.active_decoder_count == 1 and registry.decoder_releases == 0
        assert await _bounded(registry.acquire_decoder()) is False
        with pytest.raises(RuntimeError, match="cleanup failed"):
            await _bounded(connection._close_stream(_close_control()))
        with pytest.raises(RuntimeError, match="cleanup failed"):
            await _bounded(connection.cleanup())
        assert stream.release_task is release and decoder._cleanup_task is cleanup
        assert registry.active_connection_count == 1 and registry.connection_releases == 0
        assert not connection._finalized
        assert process.wait_calls == 1
        assert process.terminate_calls <= 1 and process.kill_calls <= 1
        assert decoder.metadata.capture_extent_frames48 is None
    finally:
        await _settle_connection(connection, decoder, process)


@pytest.mark.asyncio
async def test_startup_timeout_retains_factory_and_cleans_up_late_child(monkeypatch, no_probe):
    monkeypatch.setattr(pcm, "_STARTUP_WAIT_SECONDS", 0.03)
    process = _Process()
    factory = _LateFactory(process)
    retained = []
    try:
        with pytest.raises(RuntimeError, match="startup timed out"):
            await _bounded(pcm.PcmDecoderProcess.start(
                _command(), ffmpeg_executable="synthetic-not-executed",
                process_factory=factory, on_start=retained.append))
        assert len(retained) == 1 and factory.entered.is_set()
        decoder = retained[0]
        launch, cleanup = decoder._launch_task, decoder._cleanup_task
        assert not launch.done() and cleanup is not None
        assert not decoder.cleanup_complete and decoder._process is None
        assert factory.cancellations == 0
        factory.allowed.set()
        await _bounded(decoder.wait_closed())
        assert decoder._launch_task is launch and decoder._cleanup_task is cleanup
        assert decoder._process is process and decoder.cleanup_complete
        assert process.terminate_calls == process.kill_calls == process.wait_calls == factory.calls == 1
        assert decoder.metadata.authoritative_total_frames is None
    finally:
        factory.allowed.set()
        process.settle_all()
        for decoder in retained:
            await _settle(decoder, process)


@pytest.mark.asyncio
async def test_unobserved_failed_launch_cannot_claim_cleanup_or_release_capacity(monkeypatch, no_probe):
    calls = []

    async def failed_factory(*_args, **_kwargs):
        calls.append(True)
        raise OSError("synthetic factory failure without an observable child")

    _route_factory(monkeypatch, failed_factory)
    registry, socket, connection, _ = await _connection()
    try:
        assert await _bounded(connection._open(_open_control())) is True
        assert len(connection._retiring_streams) == 1
        stream = next(iter(connection._retiring_streams))
        decoder = stream.decoder
        assert decoder._process is None and not decoder.cleanup_complete
        with pytest.raises(RuntimeError, match="cleanup failed"):
            await _bounded(connection.cleanup())
        cleanup, release = decoder._cleanup_task, stream.release_task
        assert cleanup.done() and release.done()
        with pytest.raises(RuntimeError, match="cleanup failed"):
            await _bounded(connection._close_stream(_close_control()))
        assert decoder._cleanup_task is cleanup and stream.release_task is release
        assert len(calls) == 1 and not decoder.cleanup_complete
        assert registry.active_decoder_count == registry.active_connection_count == 1
        assert registry.decoder_releases == registry.connection_releases == 0
        assert socket.events[0]["type"] == "error"
        assert not any(event["type"] in {"metadata", "eos"} for event in socket.events)
    finally:
        await _bounded(asyncio.gather(connection.cleanup(), return_exceptions=True))


@pytest.mark.asyncio
async def test_close_is_bounded_and_starts_cleanup_while_send_lock_is_held():
    process = _Process(kill_exits=False)
    decoder = _decoder(process)
    registry, _, connection, stream = await _connection(decoder)
    await _bounded(connection._send_lock.acquire())
    try:
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(connection._close_stream(_close_control()))
        assert connection._send_lock.locked()
        assert process.terminate_calls == process.kill_calls == process.wait_calls == 1
        assert decoder._cleanup_task is not None and stream.release_task is not None
        assert stream in connection._retiring_streams
        assert not connection._owns_stream(stream)
        assert registry.active_decoder_count == 1 and registry.decoder_releases == 0
    finally:
        connection._send_lock.release()
        await _settle_connection(connection, decoder, process)


class _PausedEosSocket(_Socket):
    def __init__(self):
        super().__init__()
        self.eos_entered = asyncio.Event()
        self.eos_allowed = asyncio.Event()

    async def send_json(self, event):
        if event["type"] == "eos":
            self.eos_entered.set()
            await self.eos_allowed.wait()
        await super().send_json(event)


@pytest.mark.asyncio
async def test_late_eos_send_cannot_remove_replacement_or_install_completed_role():
    process, replacement_process = _Process(), _Process()
    process.allow_exit()
    old, replacement = _decoder(process), _decoder(replacement_process)
    socket = _PausedEosSocket()
    registry, _, connection, stream = await _connection(old, socket)
    send = None
    try:
        old.grant_credit(1)
        await _bounded(old.read_credited_frames(max_frames=1))
        metadata = await _bounded(old.finish())
        assert metadata.capture_extent_frames48 == 0
        send = asyncio.create_task(connection._send_stream_eos(stream, metadata))
        await _bounded(socket.eos_entered.wait())
        assert connection._send_lock.locked()
        connection._retire_stream_unlocked(stream)
        release = stream.release_task
        assert await _bounded(registry.acquire_decoder())
        successor = route._PlaybackStream(replacement, 7, 11, "current")
        connection._streams_by_id[11] = successor
        connection._streams_by_role["current"] = successor
        socket.eos_allowed.set()
        assert await _bounded(send) is False
        await _bounded(asyncio.shield(release))
        assert connection._streams_by_id[11] is successor
        assert connection._streams_by_role["current"] is successor
        assert "current" not in connection._completed_streams_by_role
        assert stream.release_task is release and successor.release_task is None
        assert registry.active_decoder_count == 1 and registry.decoder_releases == 1
        assert old.metadata.capture_extent_frames48 is None
        assert replacement.metadata.capture_extent_frames48 is None
    finally:
        socket.eos_allowed.set()
        process.settle_all()
        replacement_process.settle_all()
        await _settle(old, process, *([send] if send is not None else []))
        await _settle_connection(connection, replacement, replacement_process)


class _CloseSocket(_Socket):
    def __init__(self, *, fail=False):
        super().__init__()
        self.close_allowed = asyncio.Event()
        self.fail = fail
        if fail:
            self.close_allowed.set()

    async def close(self, *, code):
        self.close_codes.append(code)
        self.closed.set()
        await self.close_allowed.wait()
        if self.fail:
            raise OSError("synthetic transport close failure")


@pytest.mark.asyncio
async def test_stalled_transport_close_retains_connection_until_actual_completion():
    socket = _CloseSocket()
    registry, _, connection, _ = await _connection(socket=socket)
    try:
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(connection.shutdown())
        finalizer = connection._finalize_task
        assert socket.closed.is_set() and not finalizer.done()
        assert registry.active_connection_count == 1 and registry.connection_releases == 0
        assert not connection._finalized
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(connection.cleanup())
        assert connection._finalize_task is finalizer and socket.close_codes == [1001]
        socket.close_allowed.set()
        await _bounded(asyncio.shield(finalizer))
        await _bounded(connection.shutdown())
        assert connection._finalized
        assert registry.active_connection_count == 0 and registry.connection_releases == 1
        assert socket.close_codes == [1001]
    finally:
        socket.close_allowed.set()
        await _bounded(asyncio.gather(connection.cleanup(), return_exceptions=True))


@pytest.mark.asyncio
async def test_failed_transport_close_retains_connection_without_repeated_close():
    socket = _CloseSocket(fail=True)
    registry, _, connection, _ = await _connection(socket=socket)
    with pytest.raises(OSError, match="transport close failure"):
        await _bounded(connection.shutdown())
    finalizer = connection._finalize_task
    assert finalizer.done() and not finalizer.cancelled()
    assert registry.active_connection_count == 1 and registry.connection_releases == 0
    assert not connection._finalized
    with pytest.raises(OSError, match="transport close failure"):
        await _bounded(connection.cleanup())
    assert connection._finalize_task is finalizer and socket.close_codes == [1001]


@pytest.mark.asyncio
async def test_retiring_stream_still_consumes_per_connection_admission(monkeypatch, no_probe):
    monkeypatch.setattr(route, "MAX_DECODERS_PER_CONNECTION", 1)
    process = _Process(kill_exits=False)
    decoder = _decoder(process)
    factory = _LateFactory(_Process())
    factory.allowed.set()
    _route_factory(monkeypatch, factory)
    registry, socket, connection, stream = await _connection(decoder)
    try:
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(connection._close_stream(_close_control()))
        assert stream in connection._retiring_streams
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(connection._open(_open_control(stream_id=12)))
        assert socket.close_codes == [route.CLOSE_ADMISSION_EXHAUSTED]
        assert factory.calls == 0
        assert registry.active_decoder_count == 1 and registry.decoder_releases == 0
        assert registry.active_connection_count == 1 and registry.connection_releases == 0
    finally:
        await _settle_connection(connection, decoder, process)


@pytest.mark.asyncio
async def test_cancelled_probe_finishes_without_starting_decoder_child(monkeypatch):
    probe_entered, probe_allowed = asyncio.Event(), asyncio.Event()
    process = _Process()
    factory = _LateFactory(process)
    factory.allowed.set()
    retained = []

    async def gated_probe(_path, _executable, *, probe):
        assert type(probe) is mp3_gapless.Mp3GaplessProbe
        assert len(retained) == 1 and retained[0]._gapless_probe is probe
        probe_entered.set()
        await probe_allowed.wait()
        return None

    monkeypatch.setattr(mp3_gapless, "ignored_mp3_gapless_info", gated_probe)
    start = asyncio.create_task(pcm.PcmDecoderProcess.start(
        _command(), ffmpeg_executable="synthetic-not-executed",
        process_factory=factory, on_start=retained.append))
    try:
        await _bounded(probe_entered.wait())
        assert len(retained) == 1
        decoder = retained[0]
        start.cancel()
        with pytest.raises(asyncio.CancelledError):
            await _bounded(start)
        cleanup = decoder._cleanup_task
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(decoder.cancel())
        assert not decoder.cleanup_complete and factory.calls == 0
        probe_allowed.set()
        await _bounded(decoder.wait_closed())
        assert decoder.cleanup_complete and decoder._process is None
        assert decoder._cleanup_task is cleanup
        assert factory.calls == 0 and process.wait_calls == 0
        assert decoder.metadata.capture_extent_frames48 is None
    finally:
        probe_allowed.set()
        await _bounded(asyncio.gather(start, return_exceptions=True))
        for decoder in retained:
            await _settle(decoder, process)


@pytest.mark.asyncio
@pytest.mark.parametrize("settles", [True, False])
async def test_promoted_successor_waits_for_outgoing_slot_without_early_release(monkeypatch, no_probe, settles):
    outgoing_process = _Process(kill_exits=False)
    incoming_process, next_process = _Process(), _Process()
    outgoing = _decoder(outgoing_process)
    incoming = pcm.PcmDecoderProcess(_command(12, "continuity"), incoming_process)
    factory = _LateFactory(next_process)
    factory.allowed.set()
    _route_factory(monkeypatch, factory)
    checked = asyncio.Event()

    def resolve(_config, _path):
        checked.set()
        return _command().path

    monkeypatch.setattr(route, "resolve_configured_media_path", resolve)
    registry, socket, connection, outgoing_stream = await _connection(outgoing)
    assert await _bounded(registry.acquire_decoder())
    incoming_stream = route._PlaybackStream(incoming, 7, 12, "continuity")
    connection._streams_by_id[12] = incoming_stream
    connection._streams_by_role["continuity"] = incoming_stream
    opening = None
    try:
        assert await _bounded(connection._promote({
            "generation": 7, "streamId": 12,
            "fromRole": "continuity", "toRole": "current",
        })) is True
        assert socket.events[-1]["type"] == "promoted"
        assert connection._streams_by_role["current"] is incoming_stream
        assert outgoing_stream in connection._retiring_streams
        await _bounded(outgoing_process.kill_called.wait())
        opening = asyncio.create_task(connection._open(_open_control(13, "continuity")))
        await _bounded(checked.wait())
        assert not opening.done()
        assert registry.active_decoder_count == 2 and registry.decoder_releases == 0
        assert factory.calls == 0 and outgoing_process.returncode is None
        assert not outgoing_stream.release_task.done()
        if settles:
            outgoing_process.allow_exit(-9)
            assert await _bounded(opening) is True
            assert factory.calls == 1 and outgoing.cleanup_complete
            assert registry.active_decoder_count == 2 and registry.decoder_releases == 1
            assert connection._streams_by_role["current"] is incoming_stream
            assert connection._streams_by_role["continuity"].stream_id == 13
            assert outgoing_stream not in connection._retiring_streams
            assert socket.close_codes == [] and not connection._closed
            assert socket.events[-1]["type"] == "metadata"
            assert socket.events[-1]["streamId"] == 13
        else:
            with pytest.raises(RuntimeError, match="unresolved"):
                await _bounded(opening)
            assert factory.calls == 0
            assert socket.close_codes == [route.CLOSE_ADMISSION_EXHAUSTED]
            assert outgoing_stream in connection._retiring_streams
            assert not outgoing.cleanup_complete
            # Rejection closes and can settle the incoming decoder, but cannot
            # release the stubborn outgoing reservation or the connection.
            await _bounded(asyncio.shield(incoming_stream.release_task))
            assert registry.active_decoder_count == 1 and registry.decoder_releases == 1
            assert registry.active_connection_count == 1 and registry.connection_releases == 0
    finally:
        factory.allowed.set()
        for process in (outgoing_process, incoming_process, next_process):
            process.settle_all()
        if opening is not None:
            await _bounded(asyncio.gather(opening, return_exceptions=True))
        await _settle(outgoing, outgoing_process)
        await _settle_connection(connection, incoming, incoming_process)


class _FailFirstReadPipe(_Pipe):
    def __init__(self):
        super().__init__(error=OSError("synthetic playback read failure"))

    async def read(self, size):
        try:
            return await super().read(size)
        finally:
            self.error = None


class _ErrorSocket(_Socket):
    def __init__(self, *, disconnect):
        super().__init__()
        self.disconnect = disconnect
        self.error_entered = asyncio.Event()
        self.error_allowed = asyncio.Event()
        self.error_cancellations = 0

    async def send_json(self, event):
        if event["type"] == "error":
            self.error_entered.set()
            if self.disconnect:
                raise route.WebSocketDisconnect(code=1006)
            try:
                await self.error_allowed.wait()
            except asyncio.CancelledError:
                self.error_cancellations += 1
                raise
        await super().send_json(event)


@pytest.mark.asyncio
@pytest.mark.parametrize("disconnect", [False, True])
async def test_read_error_starts_cleanup_before_stalled_or_disconnected_error_send(disconnect):
    process = _Process(kill_exits=False, stdout=_FailFirstReadPipe())
    decoder = _decoder(process)
    socket = _ErrorSocket(disconnect=disconnect)
    registry, _, connection, stream = await _connection(decoder, socket)
    credit = None
    try:
        assert await _bounded(connection._credit({
            "generation": 7, "streamId": 11, "frames": 1,
        })) is True
        credit = stream.credit_task
        await _bounded(socket.error_entered.wait())
        await _bounded(process.kill_called.wait())
        cleanup, release = decoder._cleanup_task, stream.release_task
        assert cleanup is not None and release is not None
        assert stream in connection._retiring_streams
        assert not connection._owns_stream(stream)
        assert registry.active_decoder_count == 1 and registry.decoder_releases == 0
        assert process.returncode is None and not decoder.cleanup_complete
        assert not release.done()
        if disconnect:
            assert connection._closed and connection._transport_failed.is_set()
        else:
            assert not credit.done() and not socket.error_allowed.is_set()
            assert socket.error_cancellations == 0
        with pytest.raises(RuntimeError, match="unresolved"):
            await _bounded(connection.cleanup())
        assert credit.done()
        if not disconnect:
            assert credit.cancelled() and socket.error_cancellations == 1
        assert decoder._cleanup_task is cleanup and stream.release_task is release
        assert not release.cancelled()
        assert registry.active_decoder_count == registry.active_connection_count == 1
        assert registry.decoder_releases == registry.connection_releases == 0
        process.allow_exit(-9)
        await _bounded(asyncio.shield(connection._finalize_task))
        assert decoder.cleanup_complete
        assert registry.active_decoder_count == registry.active_connection_count == 0
        assert registry.decoder_releases == registry.connection_releases == 1
        assert process.terminate_calls == process.kill_calls == process.wait_calls == 1
        assert decoder.metadata.capture_extent_frames48 is None
    finally:
        socket.error_allowed.set()
        await _settle_connection(connection, decoder, process, *([credit] if credit is not None else []))
