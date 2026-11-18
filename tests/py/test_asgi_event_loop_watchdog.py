from __future__ import annotations

import asyncio
import importlib
import importlib.metadata
import re
import sys
import threading
import time

import pytest

from tests.py.asgi_testing import (
    EVENT_LOOP_STALL_LIMIT_SECONDS,
    EventLoopStall,
    run_asgi_request,
    run_asgi_request_async,
)


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


@pytest.fixture
def slow_collection_graph():
    """A heap large enough that one full collection takes over 0.35 s here:
    a collector pause sized by the test process, not by request code."""
    import gc

    graph: list[list] = []
    while True:
        graph.extend([] for _ in range(500_000))
        started = time.perf_counter()
        gc.collect()
        if time.perf_counter() - started > 0.35 or len(graph) >= 16_000_000:
            break
    yield graph
    graph.clear()
    gc.collect()


def _timed_collection() -> float:
    import gc

    started = time.perf_counter()
    gc.collect()
    return time.perf_counter() - started


def test_a_long_garbage_collection_on_the_loop_thread_is_not_request_work(slow_collection_graph):
    collected = []

    async def collecting_app(_scope, _receive, send):
        collected.append(_timed_collection())
        await _respond(send)

    status, _headers, _body = run_asgi_request(collecting_app, "GET", "/collecting")

    assert collected[0] > EVENT_LOOP_STALL_LIMIT_SECONDS
    assert status == 204


def _burn_holding_the_gil(seconds: float) -> None:
    deadline = time.thread_time() + seconds
    while time.thread_time() < deadline:
        pass


@pytest.mark.parametrize("block", ["sleep", "gil_cpu"])
def test_blocking_beside_a_garbage_collection_still_fails_and_reports_the_collection(slow_collection_graph, block):
    """Only the collection is taken out: 0.3 s of the request's own blocking,
    sampled or holding the GIL, still fails, and the failure says how much
    collection time was not counted."""
    collected = []

    async def collecting_then_blocking_app(_scope, _receive, send):
        collected.append(_timed_collection())
        if block == "sleep":
            time.sleep(0.3)
        else:
            _burn_holding_the_gil(0.3)
        await _respond(send)

    interval = sys.getswitchinterval()
    if block == "gil_cpu":
        sys.setswitchinterval(5.0)  # The loop thread keeps the GIL, as a long C call would.
    try:
        with pytest.raises(EventLoopStall) as stall:
            run_asgi_request(collecting_then_blocking_app, "GET", f"/collecting-then-{block}")
    finally:
        sys.setswitchinterval(interval)

    reported = re.search(r"; (\d+) ms of garbage collection on the loop thread not counted\)", str(stall.value))
    assert reported is not None, str(stall.value)
    assert int(reported.group(1)) >= int(collected[0] * 1000) - 20
    if block == "sleep":
        assert "time.sleep(0.3)" in str(stall.value)


def test_a_short_gil_holding_block_without_a_collection_still_fails():
    async def gil_holding_app(_scope, _receive, send):
        _burn_holding_the_gil(0.3)
        await _respond(send)

    interval = sys.getswitchinterval()
    sys.setswitchinterval(5.0)
    try:
        with pytest.raises(EventLoopStall) as stall:
            run_asgi_request(gil_holding_app, "GET", "/gil-short")
    finally:
        sys.setswitchinterval(interval)
    assert "; 0 ms of garbage collection on the loop thread not counted)" in str(stall.value)


def test_a_tests_requests_share_one_loop_and_reuse_threadpool_workers_like_a_server():
    """Each request used to run in a new `asyncio.run`, so AnyIO started a new
    worker thread for every sync handler and the loop waited for the operating
    system to start it. A server keeps one loop and its idle workers."""
    import anyio.to_thread

    from tests.py.asgi_testing import close_server_loop

    seen = []

    async def offloading_app(_scope, _receive, send):
        loop_thread = threading.get_ident()
        worker_thread = await anyio.to_thread.run_sync(threading.get_ident)
        seen.append((loop_thread, worker_thread))
        await _respond(send)

    for index in range(5):
        assert run_asgi_request(offloading_app, "GET", f"/offloaded/{index}")[0] == 204

    assert len({loop for loop, _worker in seen}) == 1
    assert len({worker for _loop, worker in seen}) == 1
    assert seen[0][0] != threading.get_ident()

    (worker,) = [thread for thread in threading.enumerate() if thread.ident == seen[0][1]]
    close_server_loop()
    assert not any(thread.ident == seen[0][0] for thread in threading.enumerate())
    worker.join(timeout=5)  # Closing ends the root task, which tells each worker to stop.
    assert not worker.is_alive()


def test_a_request_runs_in_a_copy_of_the_callers_context():
    import contextvars

    marker = contextvars.ContextVar("asgi_testing_marker", default="unset")
    seen = []

    async def reading_app(_scope, _receive, send):
        seen.append(marker.get())
        marker.set("changed by the request")
        await _respond(send)

    token = marker.set("set by the test")
    try:
        run_asgi_request(reading_app, "GET", "/context")
        assert seen == ["set by the test"]
        assert marker.get() == "set by the test"
    finally:
        marker.reset(token)


def test_the_samplers_own_stack_formatting_is_not_counted_as_request_filesystem_work(monkeypatch, tmp_path):
    """Formatting a stalled stack reads source lines (a stat each) on the
    sampler thread; that is the observer's work, so a contract's filesystem
    budget never charges it to the request. Any other thread still counts."""
    import os

    from tests.py.asgi_testing import WATCHDOG_SAMPLER_THREAD_NAME
    from tests.py.bounded_interactions import OperationCounts
    from tests.py.filesystem_operation_counting import count_filesystem_and_media

    counts = OperationCounts()
    with count_filesystem_and_media(monkeypatch, counts):
        for name in (WATCHDOG_SAMPLER_THREAD_NAME, "request-worker"):
            thread = threading.Thread(target=os.stat, args=(tmp_path,), name=name)
            thread.start()
            thread.join()

    assert counts.stat_calls == 1
    assert counts.by_thread["stat_calls"] == {"request-worker": 1}
