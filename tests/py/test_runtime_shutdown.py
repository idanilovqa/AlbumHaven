from __future__ import annotations

import asyncio
import threading
from pathlib import Path

import pytest

from music_app.services import runtime_shutdown


class RuntimeShutdownApp:
    def __init__(self) -> None:
        self.library_state: dict[str, object] = {}

    def app_context(self):
        raise AssertionError("runtime shutdown must not enter Flask app_context")


@pytest.fixture
def runtime_carrier() -> RuntimeShutdownApp:
    return RuntimeShutdownApp()


def test_runtime_shutdown_tests_do_not_use_flask_fixtures_or_app_context():
    source = Path(__file__).read_text(encoding="utf-8")

    forbidden = [
        "tests.py." + "flask_fixtures",
        "app." + "app_context(",
        "from " + "flask",
        "app." + "library_state",
    ]

    assert not [pattern for pattern in forbidden if pattern in source]


def test_create_daemon_executor_uses_daemon_worker_threads():
    executor = runtime_shutdown.create_daemon_executor(
        max_workers=1,
        thread_name_prefix="albumhaven-test-shutdown",
    )
    release_event = threading.Event()
    started_event = threading.Event()

    future = executor.submit(lambda: started_event.set() or release_event.wait(timeout=5))
    assert started_event.wait(timeout=2)
    assert executor._threads
    assert all(thread.daemon for thread in executor._threads)

    release_event.set()
    assert future.result(timeout=2) is True
    executor.shutdown(wait=True, cancel_futures=True)


def test_request_runtime_shutdown_cancels_scan_and_cover_work(runtime_carrier, monkeypatch):
    calls: list[str] = []

    monkeypatch.setattr(runtime_shutdown, "_RUNTIME_SHUTDOWN_REQUESTED", False)
    monkeypatch.setattr(
        runtime_shutdown,
        "shutdown_registered_executors",
        lambda **kwargs: calls.append(f"shutdown:{kwargs.get('wait')}:{kwargs.get('cancel_futures')}"),
    )

    from music_app.services import cover_refresh_runtime, state as state_module

    monkeypatch.setattr(
        state_module,
        "cancel_background_refresh_for_state",
        lambda library_state: calls.append(f"scan-cancel:{library_state is runtime_carrier.library_state}") or True,
    )
    monkeypatch.setattr(cover_refresh_runtime, "cancel_cover_refresh", lambda get_state: calls.append("cover-cancel") or True)

    library_state = runtime_carrier.library_state
    library_state["relations_in_progress"] = True
    library_state["relations_phase"] = "Building"

    did_shutdown = runtime_shutdown.request_runtime_shutdown(runtime_carrier)

    assert did_shutdown is True
    assert calls == ["scan-cancel:True", "cover-cancel", "shutdown:False:True"]
    assert library_state["relations_in_progress"] is False
    assert library_state["relations_phase"] == "Idle"


def test_request_runtime_shutdown_uses_app_state_without_entering_app_context(runtime_carrier, monkeypatch):
    calls: list[str] = []

    monkeypatch.setattr(runtime_shutdown, "_RUNTIME_SHUTDOWN_REQUESTED", False)
    monkeypatch.setattr(
        runtime_shutdown,
        "shutdown_registered_executors",
        lambda **kwargs: calls.append(f"shutdown:{kwargs.get('wait')}:{kwargs.get('cancel_futures')}"),
    )

    from music_app.services import cover_refresh_runtime, state as state_module

    monkeypatch.setattr(
        state_module,
        "cancel_background_refresh_for_state",
        lambda library_state: calls.append(f"scan-cancel:{library_state is runtime_carrier.library_state}") or True,
    )
    monkeypatch.setattr(
        cover_refresh_runtime,
        "cancel_cover_refresh",
        lambda get_state: calls.append(f"cover-cancel:{get_state() is runtime_carrier.library_state}") or True,
    )

    library_state = runtime_carrier.library_state
    library_state["relations_in_progress"] = True
    library_state["relations_phase"] = "Building"

    did_shutdown = runtime_shutdown.request_runtime_shutdown(runtime_carrier)

    assert did_shutdown is True
    assert calls == ["scan-cancel:True", "cover-cancel:True", "shutdown:False:True"]
    assert library_state["relations_in_progress"] is False
    assert library_state["relations_phase"] == "Idle"


def test_request_runtime_shutdown_without_app_still_shuts_down_executors(monkeypatch):
    calls: list[str] = []

    monkeypatch.setattr(runtime_shutdown, "_RUNTIME_SHUTDOWN_REQUESTED", False)
    monkeypatch.setattr(
        runtime_shutdown,
        "shutdown_registered_executors",
        lambda **kwargs: calls.append(f"shutdown:{kwargs.get('wait')}:{kwargs.get('cancel_futures')}"),
    )

    assert runtime_shutdown.request_runtime_shutdown() is True
    assert calls == ["shutdown:False:True"]


def test_request_runtime_shutdown_swallows_cancellation_errors_and_marks_relations_idle(runtime_carrier, monkeypatch):
    calls: list[str] = []

    monkeypatch.setattr(runtime_shutdown, "_RUNTIME_SHUTDOWN_REQUESTED", False)
    monkeypatch.setattr(
        runtime_shutdown,
        "shutdown_registered_executors",
        lambda **kwargs: calls.append("shutdown"),
    )

    from music_app.services import cover_refresh_runtime, state as state_module

    def raise_scan_cancel(_library_state):
        calls.append("scan-cancel")
        raise RuntimeError("scan cancel failed")

    def raise_cover_cancel(_get_state):
        calls.append("cover-cancel")
        raise RuntimeError("cover cancel failed")

    monkeypatch.setattr(state_module, "cancel_background_refresh_for_state", raise_scan_cancel)
    monkeypatch.setattr(cover_refresh_runtime, "cancel_cover_refresh", raise_cover_cancel)

    library_state = runtime_carrier.library_state
    library_state["relations_in_progress"] = True
    library_state["relations_phase"] = "Building"

    assert runtime_shutdown.request_runtime_shutdown(runtime_carrier) is True
    assert calls == ["scan-cancel", "cover-cancel", "shutdown"]
    assert library_state["relations_in_progress"] is False
    assert library_state["relations_phase"] == "Idle"


def test_request_runtime_shutdown_is_idempotent(runtime_carrier, monkeypatch):
    calls: list[str] = []

    monkeypatch.setattr(runtime_shutdown, "_RUNTIME_SHUTDOWN_REQUESTED", False)
    monkeypatch.setattr(
        runtime_shutdown,
        "shutdown_registered_executors",
        lambda **kwargs: calls.append("shutdown"),
    )

    assert runtime_shutdown.request_runtime_shutdown(runtime_carrier) is True
    assert runtime_shutdown.request_runtime_shutdown(runtime_carrier) is False
    assert calls == ["shutdown"]


def test_asgi_lifespan_awaits_peak_and_pcm_registry_shutdown_before_runtime_shutdown(monkeypatch):
    from music_app import create_asgi_app
    from music_app.services import lastfm_retry, state as state_module

    calls: list[str] = []

    class RegistryDouble:
        active_connection_count = 0
        active_decoder_count = 0

        async def shutdown(self) -> None:
            await asyncio.sleep(0)
            calls.append("pcm-shutdown")

    class WaveformRegistryDouble:
        active_job_count = 0

        async def shutdown(self) -> None:
            await asyncio.sleep(0)
            calls.append("waveform-shutdown")

    monkeypatch.setattr(
        state_module,
        "hydrate_runtime_library_state_on_startup",
        lambda _runtime: True,
    )
    monkeypatch.setattr(
        state_module,
        "ensure_runtime_relation_projection_ready",
        lambda _runtime: None,
    )
    monkeypatch.setattr(lastfm_retry, "start_lastfm_retry_worker", lambda _runtime: None)
    monkeypatch.setattr(
        lastfm_retry,
        "stop_lastfm_retry_worker",
        lambda _runtime: calls.append("lastfm-stop"),
    )
    monkeypatch.setattr(
        runtime_shutdown,
        "request_runtime_shutdown",
        lambda _runtime: calls.append("runtime-shutdown"),
    )

    app = create_asgi_app()
    app.state.playback_pcm_registry = RegistryDouble()
    app.state.waveform_peaks_registry = WaveformRegistryDouble()

    async def scenario() -> None:
        async with app.router.lifespan_context(app):
            pass

    asyncio.run(scenario())

    assert calls == [
        "lastfm-stop",
        "waveform-shutdown",
        "pcm-shutdown",
        "runtime-shutdown",
    ]


@pytest.mark.parametrize(
    "failure_stage",
    ["waveform-shutdown", "pcm-shutdown", "runtime-shutdown"],
)
def test_asgi_lifespan_attempts_every_cleanup_stage_before_raising(monkeypatch, failure_stage):
    from music_app import create_asgi_app
    from music_app.services import lastfm_retry, state as state_module

    calls: list[str] = []

    def record_or_raise(stage: str) -> None:
        calls.append(stage)
        if stage == failure_stage:
            raise RuntimeError(f"{stage} failed")

    class RegistryDouble:
        active_connection_count = 0
        active_decoder_count = 0

        async def shutdown(self) -> None:
            await asyncio.sleep(0)
            record_or_raise("pcm-shutdown")

    class WaveformRegistryDouble:
        active_job_count = 0

        async def shutdown(self) -> None:
            await asyncio.sleep(0)
            record_or_raise("waveform-shutdown")

    monkeypatch.setattr(
        state_module,
        "hydrate_runtime_library_state_on_startup",
        lambda _runtime: True,
    )
    monkeypatch.setattr(
        state_module,
        "ensure_runtime_relation_projection_ready",
        lambda _runtime: None,
    )
    monkeypatch.setattr(lastfm_retry, "start_lastfm_retry_worker", lambda _runtime: None)
    monkeypatch.setattr(
        lastfm_retry,
        "stop_lastfm_retry_worker",
        lambda _runtime: calls.append("lastfm-stop"),
    )
    monkeypatch.setattr(
        runtime_shutdown,
        "request_runtime_shutdown",
        lambda _runtime: record_or_raise("runtime-shutdown"),
    )

    app = create_asgi_app()
    app.state.playback_pcm_registry = RegistryDouble()
    app.state.waveform_peaks_registry = WaveformRegistryDouble()

    async def scenario() -> None:
        with pytest.raises(RuntimeError, match=f"{failure_stage} failed"):
            async with app.router.lifespan_context(app):
                pass

    asyncio.run(scenario())

    assert calls == [
        "lastfm-stop",
        "waveform-shutdown",
        "pcm-shutdown",
        "runtime-shutdown",
    ]
