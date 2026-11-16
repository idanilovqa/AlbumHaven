from __future__ import annotations

import asyncio
import importlib
import sys
import time

import pytest

from tests.py.asgi_testing import EventLoopStall, run_asgi_request


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


def test_an_unsampled_stall_without_process_cpu_is_machine_load_not_request_work():
    from tests.py.asgi_testing import EventLoopWatchdog

    watchdog = EventLoopWatchdog()
    watchdog._last_beat = time.monotonic() - 0.6
    watchdog._last_beat_cpu = time.process_time()
    watchdog._observe()
    assert watchdog._worst_stall == 0.0

    watchdog._last_beat = time.monotonic() - 0.6
    watchdog._last_beat_cpu = time.process_time() - 0.6
    watchdog._observe()
    assert watchdog._worst_stall > 0.25
