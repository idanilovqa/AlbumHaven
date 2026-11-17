from __future__ import annotations

import asyncio
import importlib
import importlib.metadata
import sys
import threading
import time

import pytest

from tests.py.asgi_testing import EventLoopStall, run_asgi_request, run_asgi_request_async


async def _respond(send) -> None:
    await send({"type": "http.response.start", "status": 204, "headers": []})
    await send({"type": "http.response.body", "body": b""})


def test_a_request_that_blocks_the_event_loop_fails_with_the_blocking_stack():
    async def blocking_app(_scope, _receive, send):
        time.sleep(0.4)
        await _respond(send)

    with pytest.raises(EventLoopStall) as stall:
        run_asgi_request(blocking_app, "GET", "/blocking")

    message = str(stall.value)
    assert "blocked the event loop for" in message
    assert "in blocking_app" in message
    assert "time.sleep(0.4)" in message


def test_a_request_that_awaits_keeps_the_event_loop_free():
    async def waiting_app(_scope, _receive, send):
        await asyncio.sleep(0.4)
        await _respond(send)

    status, _headers, _body = run_asgi_request(waiting_app, "GET", "/waiting")

    assert status == 204


def test_concurrent_requests_share_one_sampler_thread():
    """A sampler thread per request would make a burst of concurrent requests
    stall the loop through their own observers."""
    in_flight_threads = []

    async def waiting_app(_scope, _receive, send):
        await asyncio.sleep(0.05)
        in_flight_threads.append(threading.active_count())
        await _respond(send)

    async def burst():
        await run_asgi_request_async(waiting_app, "GET", "/warm")  # starts the shared sampler
        idle_threads = threading.active_count()
        responses = await asyncio.gather(
            *(run_asgi_request_async(waiting_app, "GET", f"/waiting/{index}") for index in range(64))
        )
        return idle_threads, responses

    idle_threads, responses = asyncio.run(burst())

    assert [status for status, _headers, _body in responses] == [204] * 64
    assert max(in_flight_threads) == idle_threads


def test_work_handed_to_a_thread_keeps_the_event_loop_free():
    async def offloading_app(_scope, _receive, send):
        await asyncio.to_thread(time.sleep, 0.4)
        await _respond(send)

    status, _headers, _body = run_asgi_request(offloading_app, "GET", "/offloaded")

    assert status == 204


def _slow_module(tmp_path, monkeypatch, name: str) -> str:
    """A module whose first import blocks for 0.4 s, like a cold heavy import."""
    (tmp_path / f"{name}.py").write_text("import time\ntime.sleep(0.4)\n", encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.delitem(sys.modules, name, raising=False)
    return name


def test_a_first_import_during_a_request_is_not_counted_as_request_work(tmp_path, monkeypatch):
    module = _slow_module(tmp_path, monkeypatch, "watchdog_cold_import")

    async def importing_app(_scope, _receive, send):
        importlib.import_module(module)
        await _respond(send)

    status, _headers, _body = run_asgi_request(importing_app, "GET", "/importing")

    assert status == 204


def test_blocking_work_in_the_same_stall_as_an_import_still_fails(tmp_path, monkeypatch):
    module = _slow_module(tmp_path, monkeypatch, "watchdog_cold_import_then_block")

    async def importing_then_blocking_app(_scope, _receive, send):
        importlib.import_module(module)
        time.sleep(0.4)
        await _respond(send)

    with pytest.raises(EventLoopStall) as stall:
        run_asgi_request(importing_then_blocking_app, "GET", "/importing-then-blocking")

    assert "time.sleep(0.4)" in str(stall.value)


def test_cpu_work_holding_the_gil_fails_even_though_the_sampler_cannot_run():
    async def gil_holding_app(_scope, _receive, send):
        deadline = time.process_time() + 0.4
        while time.process_time() < deadline:
            pass
        await _respond(send)

    interval = sys.getswitchinterval()
    sys.setswitchinterval(5.0)  # The loop thread keeps the GIL, as a long C call would.
    try:
        with pytest.raises(EventLoopStall):
            run_asgi_request(gil_holding_app, "GET", "/gil")
    finally:
        sys.setswitchinterval(interval)


def test_an_unsampled_stall_without_loop_thread_cpu_is_machine_load_not_request_work():
    from tests.py.asgi_testing import EventLoopWatchdog

    watchdog = EventLoopWatchdog()
    watchdog._last_beat = time.monotonic() - 0.6
    watchdog._last_beat_cpu = time.thread_time()
    watchdog._observe()
    assert watchdog._worst_stall == 0.0

    watchdog._last_beat = time.monotonic() - 0.6
    watchdog._last_beat_cpu = time.thread_time() - 0.6
    watchdog._observe()
    assert watchdog._worst_stall > 0.25


def test_cpu_spent_by_other_threads_during_an_unsampled_stall_is_not_charged_to_the_loop():
    """While the loop thread waits for the processor, worker threads of the same
    process may run: their CPU time is not the loop thread's, so the delay is
    machine load, not a blocked loop."""
    from tests.py.asgi_testing import EventLoopWatchdog

    def burn(seconds: float) -> None:
        deadline = time.thread_time() + seconds
        while time.thread_time() < deadline:
            pass

    watchdog = EventLoopWatchdog()
    watchdog._last_beat = time.monotonic() - 0.6
    watchdog._last_beat_cpu = time.thread_time()
    process_before = time.process_time()
    worker = threading.Thread(target=burn, args=(0.4,))
    worker.start()
    worker.join()
    assert time.process_time() - process_before >= 0.3
    watchdog._observe()
    assert watchdog._worst_stall == 0.0


def test_reading_package_metadata_is_request_work_not_import_machinery():
    from tests.py.asgi_testing import _importing

    captured = {}

    def capture():
        captured["frame"] = sys._getframe()

    real_distribution = importlib.metadata.Distribution.from_name

    def from_name(name):
        capture()
        return real_distribution(name)

    try:
        importlib.metadata.Distribution.from_name = staticmethod(from_name)
        importlib.metadata.version("pytest")
    finally:
        importlib.metadata.Distribution.from_name = real_distribution
    assert not _importing(captured["frame"])
