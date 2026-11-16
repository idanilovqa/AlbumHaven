from __future__ import annotations

import asyncio
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
