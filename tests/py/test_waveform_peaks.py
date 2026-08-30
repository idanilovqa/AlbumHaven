from __future__ import annotations

import asyncio
import math
from pathlib import Path

import pytest

from music_app.services import waveform_peaks
from music_app.services.waveform_peaks import (
    WaveformPeaks,
    WaveformPeaksBusyError,
    WaveformPeaksRegistry,
    build_waveform_peaks,
)


BIN_COUNT = 280
MAX_AGGREGATE_OUTPUT_BYTES_PER_BIN = 160


class FakeStream:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload
        self.read_sizes: list[int] = []
        self.max_returned_bytes = 0
        self.total_returned_bytes = 0

    async def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        if not self._payload:
            return b""
        bounded_size = min(size, 37) if size >= 0 else 37
        chunk, self._payload = self._payload[:bounded_size], self._payload[bounded_size:]
        self.max_returned_bytes = max(self.max_returned_bytes, len(chunk))
        self.total_returned_bytes += len(chunk)
        return chunk


class FakeProcess:
    def __init__(
        self,
        *,
        stdout: FakeStream | None,
        stderr: bytes = b"",
        returncode: int = 0,
    ) -> None:
        self.stdout = stdout
        self.stderr = FakeStream(stderr)
        self._exit_code = returncode
        self.returncode: int | None = None
        self.terminate_calls = 0
        self.wait_calls = 0

    def terminate(self) -> None:
        self.terminate_calls += 1
        self.returncode = self._exit_code

    async def wait(self) -> int:
        self.wait_calls += 1
        self.returncode = self._exit_code
        return self._exit_code


ProcessCall = tuple[tuple[object, ...], dict[str, object]]


def _process_factory(process: FakeProcess, calls: list[ProcessCall]):
    async def create_process(*args, **kwargs):
        calls.append((args, kwargs))
        return process

    return create_process


def _stereo_bin_fixture() -> tuple[bytes, list[float], list[float]]:
    left = [(index + 1) / BIN_COUNT for index in range(BIN_COUNT)]
    right = [(BIN_COUNT - index) / BIN_COUNT for index in range(BIN_COUNT)]
    lines: list[str] = []
    for index, (left_peak, right_peak) in enumerate(zip(left, right, strict=True)):
        lines.extend(
            (
                f"frame:{index} pts:{index} pts_time:{index / BIN_COUNT}",
                f"lavfi.astats.1.Peak_level={20 * math.log10(left_peak):.9f}",
                f"lavfi.astats.2.Peak_level={20 * math.log10(right_peak):.9f}",
            )
        )
    payload = ("\n".join(lines) + "\n").encode("ascii")
    return payload, left, right


def test_build_waveform_peaks_returns_exact_finite_stereo_max_abs_bins_without_retaining_pcm(
    tmp_path,
    monkeypatch,
):
    async def scenario() -> None:
        payload, expected_left, expected_right = _stereo_bin_fixture()
        stdout = FakeStream(payload)
        process = FakeProcess(stdout=stdout)
        calls: list[ProcessCall] = []
        monkeypatch.setattr(
            waveform_peaks.asyncio,
            "create_subprocess_exec",
            _process_factory(process, calls),
        )
        monkeypatch.setattr(
            waveform_peaks,
            "_audio_duration_seconds",
            lambda _path: 2.0,
            raising=False,
        )

        input_path = (tmp_path / "track.flac").resolve()
        result = await build_waveform_peaks(
            input_path,
            bins=BIN_COUNT,
            cancel_event=asyncio.Event(),
        )

        assert result.sample_count == BIN_COUNT
        assert len(result.left) == len(result.right) == BIN_COUNT
        assert result.left == pytest.approx(expected_left)
        assert result.right == pytest.approx(expected_right)
        assert all(math.isfinite(value) and 0 <= value <= 1 for value in (*result.left, *result.right))
        assert stdout.read_sizes
        assert all(0 < size <= waveform_peaks.PCM_READ_CHUNK_BYTES for size in stdout.read_sizes)
        assert stdout.read_sizes[0] == waveform_peaks.PCM_READ_CHUNK_BYTES
        assert stdout.max_returned_bytes < len(payload)
        assert not any(
            isinstance(value, (bytes, bytearray, memoryview))
            for value in (result.left, result.right, result.sample_count)
        )
        assert process.terminate_calls == 0
        assert process.wait_calls == 1
        assert len(calls) == 1
        args, kwargs = calls[0]
        assert str(input_path) in args
        decoder_contract = " ".join(str(value).casefold() for value in args)
        assert "astats" in decoder_contract
        assert "ametadata" in decoder_contract
        assert ("-f", "null") in tuple(zip(args, args[1:]))
        assert kwargs["stdout"] is asyncio.subprocess.PIPE
        assert kwargs["stderr"] is asyncio.subprocess.PIPE

    asyncio.run(scenario())


def test_build_waveform_peaks_bounds_decoder_aggregation_output_by_bins_not_track_duration(
    tmp_path,
    monkeypatch,
):
    async def scenario() -> None:
        aggregate_records, expected_left, expected_right = _stereo_bin_fixture()
        stdout = FakeStream(aggregate_records)
        process = FakeProcess(stdout=stdout)
        calls: list[ProcessCall] = []
        monkeypatch.setattr(
            waveform_peaks.asyncio,
            "create_subprocess_exec",
            _process_factory(process, calls),
        )
        monkeypatch.setattr(
            waveform_peaks,
            "_audio_duration_seconds",
            lambda _path: 28 * 60.0,
            raising=False,
        )

        result = await build_waveform_peaks(
            (tmp_path / "twenty-eight-minute-track.flac").resolve(),
            bins=BIN_COUNT,
            cancel_event=asyncio.Event(),
        )

        assert result.sample_count == BIN_COUNT
        assert result.left == pytest.approx(expected_left)
        assert result.right == pytest.approx(expected_right)
        assert all(
            math.isfinite(value) and 0 <= value <= 1
            for value in (*result.left, *result.right)
        )
        assert stdout.total_returned_bytes <= (
            MAX_AGGREGATE_OUTPUT_BYTES_PER_BIN * BIN_COUNT
        )

        args, _kwargs = calls[0]
        decoder_contract = " ".join(str(value).casefold() for value in args)
        assert "asetnsamples" in decoder_contract
        assert "asetnsamples=n=48000" in decoder_contract
        assert "astats" in decoder_contract
        assert "ametadata" in decoder_contract
        assert ("-ar", "2000") not in tuple(zip(args, args[1:])), (
            "fixed-rate PCM output grows linearly with track duration"
        )

    asyncio.run(scenario())


def test_build_waveform_peaks_downmixes_mono_or_multichannel_input_to_stereo_before_stats(
    tmp_path,
    monkeypatch,
):
    async def scenario() -> None:
        aggregate_records, _left, _right = _stereo_bin_fixture()
        process = FakeProcess(stdout=FakeStream(aggregate_records))
        calls: list[ProcessCall] = []
        monkeypatch.setattr(
            waveform_peaks.asyncio,
            "create_subprocess_exec",
            _process_factory(process, calls),
        )
        monkeypatch.setattr(
            waveform_peaks,
            "_audio_duration_seconds",
            lambda _path: 60.0,
            raising=False,
        )

        await build_waveform_peaks(
            (tmp_path / "mono-source.flac").resolve(),
            bins=BIN_COUNT,
            cancel_event=asyncio.Event(),
        )

        args, _kwargs = calls[0]
        decoder_contract = " ".join(str(value).casefold() for value in args)
        stereo_index = decoder_contract.index("channel_layouts=stereo")
        stats_index = decoder_contract.index("astats")
        assert stereo_index < stats_index

    asyncio.run(scenario())


def test_build_waveform_peaks_rejects_aggregate_output_beyond_per_bin_budget(
    tmp_path,
    monkeypatch,
):
    async def scenario() -> None:
        payload = b"x" * ((MAX_AGGREGATE_OUTPUT_BYTES_PER_BIN * BIN_COUNT) + 1)
        process = FakeProcess(stdout=FakeStream(payload))
        monkeypatch.setattr(
            waveform_peaks.asyncio,
            "create_subprocess_exec",
            _process_factory(process, []),
        )
        monkeypatch.setattr(
            waveform_peaks,
            "_audio_duration_seconds",
            lambda _path: 60.0,
            raising=False,
        )

        with pytest.raises(RuntimeError, match="aggregate output exceeded"):
            await build_waveform_peaks(
                (tmp_path / "oversized-metadata.flac").resolve(),
                bins=BIN_COUNT,
                cancel_event=asyncio.Event(),
            )

    asyncio.run(scenario())


def test_build_waveform_peaks_requires_reliable_duration_before_decoder_launch(
    tmp_path,
    monkeypatch,
):
    async def scenario() -> None:
        launches: list[ProcessCall] = []
        monkeypatch.setattr(
            waveform_peaks,
            "_audio_duration_seconds",
            lambda _path: (_ for _ in ()).throw(RuntimeError("duration unavailable")),
            raising=False,
        )
        monkeypatch.setattr(
            waveform_peaks.asyncio,
            "create_subprocess_exec",
            _process_factory(FakeProcess(stdout=FakeStream(b"")), launches),
        )

        with pytest.raises(RuntimeError, match="duration unavailable"):
            await build_waveform_peaks(
                (tmp_path / "unknown-duration.flac").resolve(),
                bins=BIN_COUNT,
                cancel_event=asyncio.Event(),
            )

        assert launches == []

    asyncio.run(scenario())


def test_build_waveform_peaks_rejects_metadata_frame_missing_one_stereo_channel(
    tmp_path,
    monkeypatch,
):
    async def scenario() -> None:
        payload = b"frame:0 pts:0 pts_time:0\nlavfi.astats.1.Peak_level=-6.020600\n"
        process = FakeProcess(stdout=FakeStream(payload))
        monkeypatch.setattr(
            waveform_peaks.asyncio,
            "create_subprocess_exec",
            _process_factory(process, []),
        )
        monkeypatch.setattr(
            waveform_peaks,
            "_audio_duration_seconds",
            lambda _path: 1.0,
            raising=False,
        )

        with pytest.raises(RuntimeError, match="stereo.*metadata|metadata.*stereo"):
            await build_waveform_peaks(
                (tmp_path / "truncated-stereo.flac").resolve(),
                bins=BIN_COUNT,
                cancel_event=asyncio.Event(),
            )

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("platform_name", "expected_prefix", "expected_creationflags"),
    [
        (
            "win32",
            ("resolved-ffmpeg",),
            0x08000000 | 0x00004000,
        ),
        ("linux", ("nice", "-n", "10", "resolved-ffmpeg"), 0),
    ],
    ids=["windows-hidden-below-normal", "non-windows-nice-10"],
)
def test_build_waveform_peaks_launches_decoder_with_explicit_low_priority_policy(
    tmp_path,
    monkeypatch,
    platform_name,
    expected_prefix,
    expected_creationflags,
):
    async def scenario() -> None:
        aggregate_records = (
            b"frame:0 pts:0 pts_time:0\n"
            b"lavfi.astats.1.Peak_level=-12.041200\n"
            b"lavfi.astats.2.Peak_level=-6.020600\n"
        )
        process = FakeProcess(stdout=FakeStream(aggregate_records))
        calls: list[ProcessCall] = []
        monkeypatch.setattr(waveform_peaks.sys, "platform", platform_name)
        monkeypatch.setattr(
            waveform_peaks.subprocess,
            "CREATE_NO_WINDOW",
            0x08000000,
            raising=False,
        )
        monkeypatch.setattr(
            waveform_peaks.subprocess,
            "BELOW_NORMAL_PRIORITY_CLASS",
            0x00004000,
            raising=False,
        )
        monkeypatch.setattr(
            waveform_peaks,
            "resolve_ffmpeg_executable",
            lambda: "resolved-ffmpeg",
        )
        monkeypatch.setattr(
            waveform_peaks.asyncio,
            "create_subprocess_exec",
            _process_factory(process, calls),
        )
        monkeypatch.setattr(
            waveform_peaks,
            "_audio_duration_seconds",
            lambda _path: 1.0,
            raising=False,
        )

        await build_waveform_peaks(
            (tmp_path / "priority.flac").resolve(),
            bins=1,
            cancel_event=asyncio.Event(),
        )

        assert len(calls) == 1
        args, kwargs = calls[0]
        assert args[: len(expected_prefix)] == expected_prefix
        assert kwargs.get("creationflags", 0) == expected_creationflags
        assert kwargs["stdout"] is asyncio.subprocess.PIPE
        assert kwargs["stderr"] is asyncio.subprocess.PIPE

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("stdout", "returncode", "stderr", "message"),
    [
        (None, 0, b"", "stdout"),
        (FakeStream(b""), 0, b"", "empty"),
        (FakeStream(b"partial"), 0, b"", "truncated|frame|align"),
        (FakeStream(b""), 23, b"decoder failed", "decoder failed|code 23"),
    ],
)
def test_build_waveform_peaks_rejects_missing_empty_truncated_and_nonzero_decoder_output(
    tmp_path,
    monkeypatch,
    stdout,
    returncode,
    stderr,
    message,
):
    async def scenario() -> None:
        process = FakeProcess(stdout=stdout, stderr=stderr, returncode=returncode)
        monkeypatch.setattr(
            waveform_peaks,
            "_audio_duration_seconds",
            lambda _path: 60.0,
        )
        monkeypatch.setattr(
            waveform_peaks.asyncio,
            "create_subprocess_exec",
            _process_factory(process, []),
        )

        with pytest.raises(RuntimeError, match=message):
            await build_waveform_peaks(
                tmp_path / "broken.flac",
                bins=BIN_COUNT,
                cancel_event=asyncio.Event(),
            )

        assert process.wait_calls == 1

    asyncio.run(scenario())


def test_build_waveform_peaks_cancellation_terminates_and_waits_for_exact_process_once(
    tmp_path,
    monkeypatch,
):
    class DrainAfterCancellationStream:
        def __init__(self) -> None:
            self.read_started = asyncio.Event()
            self._read_count = 0

        async def read(self, _size: int = -1) -> bytes:
            self._read_count += 1
            if self._read_count == 1:
                self.read_started.set()
                await asyncio.Event().wait()
                raise AssertionError("unreachable")
            return b""

    async def scenario() -> None:
        stdout = DrainAfterCancellationStream()
        process = FakeProcess(stdout=stdout)
        unrelated = FakeProcess(stdout=FakeStream(b""))
        cancel_event = asyncio.Event()
        monkeypatch.setattr(
            waveform_peaks,
            "_audio_duration_seconds",
            lambda _path: 60.0,
        )
        monkeypatch.setattr(
            waveform_peaks.asyncio,
            "create_subprocess_exec",
            _process_factory(process, []),
        )

        task = asyncio.create_task(
            build_waveform_peaks(
                tmp_path / "track.flac",
                bins=BIN_COUNT,
                cancel_event=cancel_event,
            )
        )
        await asyncio.wait_for(stdout.read_started.wait(), timeout=1)
        cancel_event.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=1)

        assert process.terminate_calls == 1
        assert process.wait_calls == 1
        assert unrelated.terminate_calls == 0
        assert unrelated.wait_calls == 0

    asyncio.run(scenario())


def test_build_waveform_peaks_cancellation_drains_stdout_to_eof_before_process_wait(
    tmp_path,
    monkeypatch,
):
    class DrainRequiredStream:
        def __init__(self) -> None:
            self.initial_read_started = asyncio.Event()
            self.initial_read_cancelled = asyncio.Event()
            self.eof_reached = asyncio.Event()
            self._read_count = 0

        async def read(self, _size: int = -1) -> bytes:
            self._read_count += 1
            if self._read_count == 1:
                self.initial_read_started.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    self.initial_read_cancelled.set()
                    raise
            if self._read_count == 2:
                aggregate_records, _left, _right = _stereo_bin_fixture()
                return aggregate_records
            self.eof_reached.set()
            return b""

    class DrainGatedProcess(FakeProcess):
        def __init__(self, stdout: DrainRequiredStream) -> None:
            super().__init__(stdout=stdout)
            self.stdout = stdout

        async def wait(self) -> int:
            self.wait_calls += 1
            await self.stdout.eof_reached.wait()
            self.returncode = self._exit_code
            return self._exit_code

    async def scenario() -> None:
        stdout = DrainRequiredStream()
        process = DrainGatedProcess(stdout)
        cancel_event = asyncio.Event()
        monkeypatch.setattr(
            waveform_peaks,
            "_audio_duration_seconds",
            lambda _path: 60.0,
        )
        monkeypatch.setattr(
            waveform_peaks.asyncio,
            "create_subprocess_exec",
            _process_factory(process, []),
        )

        task = asyncio.create_task(
            build_waveform_peaks(
                tmp_path / "drain-before-wait.flac",
                bins=BIN_COUNT,
                cancel_event=cancel_event,
            )
        )
        await asyncio.wait_for(stdout.initial_read_started.wait(), timeout=1)
        cancel_event.set()

        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=1)

        assert stdout.initial_read_cancelled.is_set() is True
        assert stdout.eof_reached.is_set() is True
        assert process.terminate_calls == 1
        assert process.wait_calls == 1

    asyncio.run(scenario())


def test_build_waveform_peaks_bounds_retained_stderr_diagnostics_while_draining_pipe(
    tmp_path,
    monkeypatch,
):
    async def scenario() -> None:
        diagnostic_limit = waveform_peaks.MAX_STDERR_DIAGNOSTIC_BYTES
        stderr_payload = (
            b"discarded-prefix-"
            + (b"x" * (diagnostic_limit * 3))
            + b"-retained-tail"
        )
        process = FakeProcess(
            stdout=FakeStream(b""),
            stderr=stderr_payload,
            returncode=23,
        )
        stderr = process.stderr
        monkeypatch.setattr(
            waveform_peaks,
            "_audio_duration_seconds",
            lambda _path: 60.0,
        )
        monkeypatch.setattr(
            waveform_peaks.asyncio,
            "create_subprocess_exec",
            _process_factory(process, []),
        )

        with pytest.raises(RuntimeError) as captured:
            await build_waveform_peaks(
                tmp_path / "large-stderr.flac",
                bins=BIN_COUNT,
                cancel_event=asyncio.Event(),
            )

        message = str(captured.value)
        assert "retained-tail" in message
        assert "discarded-prefix" not in message
        assert len(message.encode("utf-8")) <= diagnostic_limit + 128
        assert stderr.read_sizes
        assert sum(min(size, 37) for size in stderr.read_sizes[:-1]) >= len(stderr_payload)

    asyncio.run(scenario())


def test_build_waveform_peaks_process_exit_during_terminate_preserves_cancellation_and_waits(
    tmp_path,
    monkeypatch,
):
    class DrainAfterCancellationStream:
        def __init__(self) -> None:
            self.read_started = asyncio.Event()
            self._read_count = 0

        async def read(self, _size: int = -1) -> bytes:
            self._read_count += 1
            if self._read_count == 1:
                self.read_started.set()
                await asyncio.Event().wait()
                raise AssertionError("unreachable")
            return b""

    class NaturallyExitedProcess(FakeProcess):
        def terminate(self) -> None:
            self.terminate_calls += 1
            self.returncode = 0
            raise ProcessLookupError("decoder already exited")

    async def scenario() -> None:
        stdout = DrainAfterCancellationStream()
        process = NaturallyExitedProcess(stdout=stdout)
        cancel_event = asyncio.Event()
        monkeypatch.setattr(
            waveform_peaks,
            "_audio_duration_seconds",
            lambda _path: 60.0,
        )
        monkeypatch.setattr(
            waveform_peaks.asyncio,
            "create_subprocess_exec",
            _process_factory(process, []),
        )

        task = asyncio.create_task(
            build_waveform_peaks(
                tmp_path / "natural-exit.flac",
                bins=BIN_COUNT,
                cancel_event=cancel_event,
            )
        )
        await asyncio.wait_for(stdout.read_started.wait(), timeout=1)
        cancel_event.set()

        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=1)

        assert process.terminate_calls == 1
        assert process.wait_calls == 1

    asyncio.run(scenario())


def test_waveform_registry_allows_one_job_rejects_overlap_and_releases_after_completion():
    async def scenario() -> None:
        entered = asyncio.Event()
        release = asyncio.Event()
        observed_cancel_events: list[asyncio.Event] = []

        async def builder(_path: Path, *, bins: int, cancel_event: asyncio.Event):
            assert bins == BIN_COUNT
            observed_cancel_events.append(cancel_event)
            entered.set()
            await release.wait()
            return "peaks"

        registry = WaveformPeaksRegistry(builder=builder)
        first = asyncio.create_task(registry.run(Path("first.flac"), bins=BIN_COUNT))
        await asyncio.wait_for(entered.wait(), timeout=1)
        assert registry.active_job_count == 1

        with pytest.raises(WaveformPeaksBusyError):
            await registry.run(Path("second.flac"), bins=BIN_COUNT)

        release.set()
        assert await asyncio.wait_for(first, timeout=1) == "peaks"
        assert registry.active_job_count == 0
        assert observed_cancel_events[0].is_set() is False

        assert await registry.run(Path("third.flac"), bins=BIN_COUNT) == "peaks"
        assert registry.active_job_count == 0

    asyncio.run(scenario())


def test_waveform_registry_cache_hit_bypasses_builder_and_global_admission_slot(tmp_path):
    async def scenario() -> None:
        path = tmp_path / "cached.flac"
        path.write_bytes(b"cached-source")
        cached = WaveformPeaks(
            left=(0.25,) * BIN_COUNT,
            right=(0.5,) * BIN_COUNT,
            sample_count=BIN_COUNT,
        )

        class CacheRepositoryDouble:
            def __init__(self) -> None:
                self.get_calls: list[dict[str, object]] = []

            def get_for_path(self, **kwargs):
                self.get_calls.append(dict(kwargs))
                return cached

            def put_for_path(self, **_kwargs):
                raise AssertionError("cache hit must not be rewritten")

        cache = CacheRepositoryDouble()

        async def builder(*_args, **_kwargs):
            raise AssertionError("cache hit must bypass FFmpeg")

        registry = WaveformPeaksRegistry(
            builder=builder,
            cache_repository=cache,
            analyzer_version="waveform-peaks-v2",
        )
        result = await registry.run(path, bins=BIN_COUNT)

        assert result is cached
        assert registry.active_job_count == 0
        assert len(cache.get_calls) == 1
        assert cache.get_calls[0] == {
            "private_path": str(path.resolve()),
            "file_size_bytes": path.stat().st_size,
            "modified_at_ns": path.stat().st_mtime_ns,
            "content_signature": None,
            "sample_count": BIN_COUNT,
            "analyzer_version": "waveform-peaks-v2",
        }

    asyncio.run(scenario())


def test_waveform_registry_cache_only_lookup_returns_stable_hit_without_build_or_write(
    tmp_path,
):
    async def scenario() -> None:
        path = tmp_path / "cache-only.flac"
        path.write_bytes(b"cached-source")
        cached = WaveformPeaks(
            left=(0.25,) * BIN_COUNT,
            right=(0.5,) * BIN_COUNT,
            sample_count=BIN_COUNT,
        )

        class CacheRepositoryDouble:
            def __init__(self) -> None:
                self.get_calls: list[dict[str, object]] = []

            def get_for_path(self, **kwargs):
                self.get_calls.append(dict(kwargs))
                return cached

            def put_for_path(self, **_kwargs):
                raise AssertionError("cache-only lookup must never write")

        cache = CacheRepositoryDouble()

        async def builder(*_args, **_kwargs):
            raise AssertionError("cache-only lookup must never build")

        registry = WaveformPeaksRegistry(
            builder=builder,
            cache_repository=cache,
            analyzer_version="waveform-peaks-v2",
        )

        assert await registry.get_cached(path, bins=BIN_COUNT) is cached
        assert registry.active_job_count == 0
        assert cache.get_calls == [
            {
                "private_path": str(path.resolve()),
                "file_size_bytes": path.stat().st_size,
                "modified_at_ns": path.stat().st_mtime_ns,
                "content_signature": None,
                "sample_count": BIN_COUNT,
                "analyzer_version": "waveform-peaks-v2",
            }
        ]

    asyncio.run(scenario())


def test_waveform_registry_cache_only_miss_bypasses_occupied_builder_slot(tmp_path):
    async def scenario() -> None:
        active_path = tmp_path / "active.flac"
        probe_path = tmp_path / "uncached-probe.flac"
        active_path.write_bytes(b"active-source")
        probe_path.write_bytes(b"uncached-source")
        entered = asyncio.Event()
        release = asyncio.Event()
        build_calls: list[Path] = []
        observed_cancel_events: list[asyncio.Event] = []

        class CacheRepositoryDouble:
            def __init__(self) -> None:
                self.get_calls: list[str] = []

            def get_for_path(self, **kwargs):
                self.get_calls.append(str(kwargs["private_path"]))
                return None

            def put_for_path(self, **_kwargs):
                return True

        async def builder(path: Path, *, bins: int, cancel_event: asyncio.Event):
            assert bins == BIN_COUNT
            build_calls.append(path)
            observed_cancel_events.append(cancel_event)
            entered.set()
            await release.wait()
            return WaveformPeaks(
                left=(0.25,) * BIN_COUNT,
                right=(0.5,) * BIN_COUNT,
                sample_count=BIN_COUNT,
            )

        cache = CacheRepositoryDouble()
        registry = WaveformPeaksRegistry(builder=builder, cache_repository=cache)
        active = asyncio.create_task(registry.run(active_path, bins=BIN_COUNT))
        await asyncio.wait_for(entered.wait(), timeout=1)
        assert registry.active_job_count == 1

        assert await asyncio.wait_for(
            registry.get_cached(probe_path, bins=BIN_COUNT),
            timeout=1,
        ) is None
        assert registry.active_job_count == 1
        assert build_calls == [active_path]
        assert observed_cancel_events[0].is_set() is False
        assert cache.get_calls == [str(active_path.resolve()), str(probe_path.resolve())]

        release.set()
        await asyncio.wait_for(active, timeout=1)
        assert registry.active_job_count == 0

    asyncio.run(scenario())


def test_waveform_registry_cache_only_lookup_rejects_identity_changed_during_read(
    tmp_path,
):
    async def scenario() -> None:
        path = tmp_path / "replaced-during-cache-only-read.flac"
        path.write_bytes(b"initial-source")
        cached = WaveformPeaks(
            left=(0.25,) * BIN_COUNT,
            right=(0.5,) * BIN_COUNT,
            sample_count=BIN_COUNT,
        )

        class CacheRepositoryDouble:
            def get_for_path(self, **_kwargs):
                replacement = path.with_suffix(".replacement.flac")
                replacement.write_bytes(b"replacement-source-with-different-size")
                replacement.replace(path)
                return cached

            def put_for_path(self, **_kwargs):
                raise AssertionError("cache-only lookup must never write")

        async def builder(*_args, **_kwargs):
            raise AssertionError("unstable cache identity must not start a build")

        registry = WaveformPeaksRegistry(
            builder=builder,
            cache_repository=CacheRepositoryDouble(),
        )

        assert await registry.get_cached(path, bins=BIN_COUNT) is None
        assert registry.active_job_count == 0

    asyncio.run(scenario())


def test_waveform_registry_cache_only_lookup_honors_shutdown_without_cache_access(
    tmp_path,
):
    async def scenario() -> None:
        path = tmp_path / "cached-after-shutdown.flac"
        path.write_bytes(b"cached-source")

        class CacheRepositoryDouble:
            def get_for_path(self, **_kwargs):
                raise AssertionError("shutdown must reject before cache access")

            def put_for_path(self, **_kwargs):
                raise AssertionError("cache-only lookup must never write")

        registry = WaveformPeaksRegistry(cache_repository=CacheRepositoryDouble())
        await registry.shutdown()

        with pytest.raises(WaveformPeaksBusyError):
            await registry.get_cached(path, bins=BIN_COUNT)

        assert registry.active_job_count == 0

    asyncio.run(scenario())


def test_waveform_registry_rejects_cache_hit_when_file_identity_changes_during_lookup(
    tmp_path,
):
    async def scenario() -> None:
        path = tmp_path / "replaced-during-cache-read.flac"
        path.write_bytes(b"initial-source")
        initial_stat = path.stat()
        current_payload = b"current-source-with-a-different-size"
        cached = WaveformPeaks(
            left=(0.25,) * BIN_COUNT,
            right=(0.5,) * BIN_COUNT,
            sample_count=BIN_COUNT,
        )
        built = WaveformPeaks(
            left=(0.125,) * BIN_COUNT,
            right=(0.75,) * BIN_COUNT,
            sample_count=BIN_COUNT,
        )

        class CacheRepositoryDouble:
            def __init__(self) -> None:
                self.get_calls: list[dict[str, object]] = []
                self.put_calls: list[dict[str, object]] = []

            def get_for_path(self, **kwargs):
                self.get_calls.append(dict(kwargs))
                replacement = path.with_suffix(".replacement.flac")
                replacement.write_bytes(current_payload)
                replacement.replace(path)
                return cached

            def put_for_path(self, **kwargs):
                self.put_calls.append(dict(kwargs))
                return True

        cache = CacheRepositoryDouble()
        build_calls = 0

        async def builder(
            current_path: Path,
            *,
            bins: int,
            cancel_event: asyncio.Event,
        ) -> WaveformPeaks:
            nonlocal build_calls
            build_calls += 1
            assert current_path == path
            assert current_path.read_bytes() == current_payload
            assert bins == BIN_COUNT
            assert cancel_event.is_set() is False
            return built

        registry = WaveformPeaksRegistry(
            builder=builder,
            cache_repository=cache,
            analyzer_version="waveform-peaks-v2",
        )
        result = await registry.run(path, bins=BIN_COUNT)
        current_stat = path.stat()

        assert result is built
        assert build_calls == 1
        assert len(cache.get_calls) == 1
        assert cache.get_calls[0]["file_size_bytes"] == initial_stat.st_size
        assert cache.get_calls[0]["modified_at_ns"] == initial_stat.st_mtime_ns
        assert len(cache.put_calls) == 1
        assert cache.put_calls[0]["peaks"] is built
        assert cache.put_calls[0]["file_size_bytes"] == current_stat.st_size
        assert cache.put_calls[0]["modified_at_ns"] == current_stat.st_mtime_ns

    asyncio.run(scenario())


def test_waveform_registry_cache_miss_stores_only_completed_peaks(tmp_path):
    async def scenario() -> None:
        path = tmp_path / "uncached.flac"
        path.write_bytes(b"uncached-source")
        built = WaveformPeaks(
            left=(0.125,) * BIN_COUNT,
            right=(0.75,) * BIN_COUNT,
            sample_count=BIN_COUNT,
        )

        class CacheRepositoryDouble:
            def __init__(self) -> None:
                self.put_calls: list[dict[str, object]] = []

            def get_for_path(self, **_kwargs):
                return None

            def put_for_path(self, **kwargs):
                self.put_calls.append(dict(kwargs))
                return True

        cache = CacheRepositoryDouble()
        build_calls = 0

        async def builder(_path: Path, *, bins: int, cancel_event: asyncio.Event):
            nonlocal build_calls
            build_calls += 1
            assert bins == BIN_COUNT
            assert cancel_event.is_set() is False
            return built

        registry = WaveformPeaksRegistry(
            builder=builder,
            cache_repository=cache,
            analyzer_version="waveform-peaks-v2",
        )
        assert await registry.run(path, bins=BIN_COUNT) is built

        assert build_calls == 1
        assert len(cache.put_calls) == 1
        assert cache.put_calls[0]["peaks"] is built
        assert cache.put_calls[0]["private_path"] == str(path.resolve())
        assert cache.put_calls[0]["file_size_bytes"] == path.stat().st_size
        assert cache.put_calls[0]["modified_at_ns"] == path.stat().st_mtime_ns

    asyncio.run(scenario())


def test_waveform_registry_shutdown_rejects_cache_hits_without_admitting_work(tmp_path):
    async def scenario() -> None:
        path = tmp_path / "cached-after-shutdown.flac"
        path.write_bytes(b"cached-source")
        cached = WaveformPeaks(
            left=(0.25,) * BIN_COUNT,
            right=(0.5,) * BIN_COUNT,
            sample_count=BIN_COUNT,
        )

        class CacheRepositoryDouble:
            def get_for_path(self, **_kwargs):
                return cached

            def put_for_path(self, **_kwargs):
                raise AssertionError("shutdown must reject before cache publication")

        registry = WaveformPeaksRegistry(
            cache_repository=CacheRepositoryDouble(),
            analyzer_version="waveform-peaks-v2",
        )
        await registry.shutdown()

        with pytest.raises(WaveformPeaksBusyError):
            await registry.run(path, bins=BIN_COUNT)

        assert registry.active_job_count == 0

    asyncio.run(scenario())


def test_waveform_registry_cancellation_never_writes_partial_cache_entry(tmp_path):
    async def scenario() -> None:
        path = tmp_path / "cancelled.flac"
        path.write_bytes(b"cancelled-source")
        entered = asyncio.Event()

        class CacheRepositoryDouble:
            def __init__(self) -> None:
                self.put_calls = 0

            def get_for_path(self, **_kwargs):
                return None

            def put_for_path(self, **_kwargs):
                self.put_calls += 1
                return True

        cache = CacheRepositoryDouble()

        async def builder(_path: Path, *, bins: int, cancel_event: asyncio.Event):
            assert bins == BIN_COUNT
            entered.set()
            await cancel_event.wait()
            raise asyncio.CancelledError()

        registry = WaveformPeaksRegistry(
            builder=builder,
            cache_repository=cache,
            analyzer_version="waveform-peaks-v2",
        )
        task = asyncio.create_task(registry.run(path, bins=BIN_COUNT))
        await asyncio.wait_for(entered.wait(), timeout=1)
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=1)

        assert cache.put_calls == 0
        assert registry.active_job_count == 0

    asyncio.run(scenario())


def test_waveform_registry_shutdown_cancels_and_awaits_the_application_wide_job():
    async def scenario() -> None:
        entered = asyncio.Event()
        cancelled = asyncio.Event()

        async def builder(_path: Path, *, bins: int, cancel_event: asyncio.Event):
            assert bins == BIN_COUNT
            entered.set()
            await cancel_event.wait()
            cancelled.set()
            raise asyncio.CancelledError()

        registry = WaveformPeaksRegistry(builder=builder)
        job = asyncio.create_task(registry.run(Path("track.flac"), bins=BIN_COUNT))
        await asyncio.wait_for(entered.wait(), timeout=1)

        await asyncio.wait_for(registry.shutdown(), timeout=1)

        assert cancelled.is_set() is True
        assert job.done() is True
        with pytest.raises(asyncio.CancelledError):
            await job
        assert registry.active_job_count == 0
        with pytest.raises(WaveformPeaksBusyError):
            await registry.run(Path("after-shutdown.flac"), bins=BIN_COUNT)

    asyncio.run(scenario())


def test_waveform_registry_cancelled_shutdown_finishes_cleanup_before_preserving_cancellation():
    async def scenario() -> None:
        entered = asyncio.Event()
        cleanup_started = asyncio.Event()
        cleanup_release = asyncio.Event()
        builder_finished = asyncio.Event()

        async def event_loop_checkpoint() -> None:
            checkpoint = asyncio.get_running_loop().create_future()
            asyncio.get_running_loop().call_soon(checkpoint.set_result, None)
            await checkpoint

        async def builder(_path: Path, *, bins: int, cancel_event: asyncio.Event):
            assert bins == BIN_COUNT
            entered.set()
            await cancel_event.wait()
            cleanup_started.set()
            await cleanup_release.wait()
            builder_finished.set()
            return "cleanup-result"

        registry = WaveformPeaksRegistry(builder=builder)
        job = asyncio.create_task(registry.run(Path("track.flac"), bins=BIN_COUNT))
        await asyncio.wait_for(entered.wait(), timeout=1)

        shutdown = asyncio.create_task(registry.shutdown())
        await asyncio.wait_for(cleanup_started.wait(), timeout=1)

        shutdown.cancel()
        await event_loop_checkpoint()
        assert shutdown.done() is False
        assert builder_finished.is_set() is False
        assert registry.active_job_count == 1

        shutdown.cancel()
        await event_loop_checkpoint()
        assert shutdown.done() is False
        assert registry.active_job_count == 1

        cleanup_release.set()
        await asyncio.wait_for(builder_finished.wait(), timeout=1)
        assert await asyncio.wait_for(job, timeout=1) == "cleanup-result"
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(shutdown, timeout=1)

        assert registry.active_job_count == 0
        assert registry._active_task is None
        with pytest.raises(WaveformPeaksBusyError):
            await registry.run(Path("after-shutdown.flac"), bins=BIN_COUNT)

    asyncio.run(scenario())


def test_waveform_registry_caller_cancellation_signals_builder_waits_and_releases_admission():
    async def scenario() -> None:
        entered = asyncio.Event()
        builder_completed = asyncio.Event()
        observed_cancel_events: list[asyncio.Event] = []
        calls = 0

        async def builder(_path: Path, *, bins: int, cancel_event: asyncio.Event):
            nonlocal calls
            calls += 1
            assert bins == BIN_COUNT
            observed_cancel_events.append(cancel_event)
            if calls == 1:
                entered.set()
                await cancel_event.wait()
                builder_completed.set()
                return "cancelled-caller-result"
            return "later-result"

        registry = WaveformPeaksRegistry(builder=builder)
        caller = asyncio.create_task(
            registry.run(Path("cancelled.flac"), bins=BIN_COUNT)
        )
        await asyncio.wait_for(entered.wait(), timeout=1)

        caller.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(caller, timeout=1)

        assert observed_cancel_events[0].is_set() is True
        assert builder_completed.is_set() is True
        assert registry.active_job_count == 0
        assert await registry.run(Path("later.flac"), bins=BIN_COUNT) == "later-result"
        assert registry.active_job_count == 0
        assert calls == 2

    asyncio.run(scenario())


def test_waveform_registry_releases_admission_after_repeated_caller_cancellation():
    async def scenario() -> None:
        entered = asyncio.Event()
        cleanup_started = asyncio.Event()
        cleanup_release = asyncio.Event()
        builder_finished = asyncio.Event()
        calls = 0

        async def builder(_path: Path, *, bins: int, cancel_event: asyncio.Event):
            nonlocal calls
            calls += 1
            assert bins == BIN_COUNT
            if calls == 1:
                entered.set()
                await cancel_event.wait()
                cleanup_started.set()
                await cleanup_release.wait()
                builder_finished.set()
                return "first-cleanup-result"
            return "later-result"

        registry = WaveformPeaksRegistry(builder=builder)
        caller = asyncio.create_task(
            registry.run(Path("cancelled-twice.flac"), bins=BIN_COUNT)
        )
        await asyncio.wait_for(entered.wait(), timeout=1)

        caller.cancel()
        await asyncio.wait_for(cleanup_started.wait(), timeout=1)
        caller.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(caller, timeout=1)

        cleanup_release.set()
        await asyncio.wait_for(builder_finished.wait(), timeout=1)
        await asyncio.sleep(0)

        assert registry.active_job_count == 0
        assert await registry.run(Path("later.flac"), bins=BIN_COUNT) == "later-result"
        assert calls == 2

    asyncio.run(scenario())
