"""Opt-in timing lines that say where a playback press waited (`ALBUM_HAVEN_PLAYBACK_TIMING=1`).

Off, every hook is one check. On, each line holds only numbers and words from fixed lists: never a
path, title, account or token. Times of day are epoch milliseconds, so they line up with the page's.
"""

from __future__ import annotations

import asyncio
from contextvars import ContextVar
import logging
import os
import time
from typing import Awaitable, Callable, TypeVar

_T = TypeVar("_T")
ENABLED = os.environ.get("ALBUM_HAVEN_PLAYBACK_TIMING") == "1"
LOOP_WATCH_INTERVAL_SECONDS = 0.1
LOOP_LATE_SECONDS = 0.1
THREAD_WAIT_LOG_SECONDS = 0.1
HEARTBEAT_LATE_SECONDS = 0.5
_LOGGER = logging.getLogger(__name__)
_running_waveform_builds = 0


def log(event: str, **fields: object) -> None:
    values = "".join(f" {key}={'-' if value is None else value}" for key, value in fields.items())
    _LOGGER.info("Playback timing event=%s%s", event, values)


def epoch_ms() -> int:
    return time.time_ns() // 1_000_000


def elapsed_ms(started_at: float) -> int:
    return round((time.perf_counter() - started_at) * 1000)


class ControlTiming:
    """Where one open or probe waited."""

    def __init__(self, socket: int, kind: str, generation: int | None, control_id: int | None) -> None:
        self.socket, self.kind, self.generation, self.control_id = socket, kind, generation, control_id
        self.received_at = epoch_ms()
        self.steps: dict[str, int] = {}

    def mark(self, step: str, value: int) -> None:
        self.steps.setdefault(step, value)

    def timed(self, step: str, work: Callable[..., _T]) -> Callable[..., _T]:
        """`work`, timed from now until a thread runs it, and while it runs."""
        submitted_at = time.perf_counter()

        def run(*args: object) -> _T:
            started_at = time.perf_counter()
            self.mark(f"{step}_wait_ms", round((started_at - submitted_at) * 1000))
            try:
                return work(*args)
            finally:
                self.mark(f"{step}_ms", elapsed_ms(started_at))

        return run

    def log(self) -> None:
        log(
            "control",
            socket=self.socket,
            kind=self.kind,
            generation=self.generation,
            id=self.control_id,
            received_at=self.received_at,
            **{
                step: self.steps.get(step)
                for step in (
                    "refresh_wait_ms", "refresh_ms", "resolve_wait_ms", "resolve_ms", "mp3_scan_ms",
                    "send_lock_wait_ms", "sent_at",
                )
            },
        )


# The open or probe the running task answers; only set while timing is on.
CONTROL: ContextVar[ControlTiming | None] = ContextVar("playback_control_timing", default=None)


def timed_work(step: str, work: Callable[..., _T]) -> Callable[..., _T]:
    timing = CONTROL.get()
    return work if timing is None else timing.timed(step, work)


async def timed_control(timing: ControlTiming, answer: Awaitable[_T]) -> _T:
    CONTROL.set(timing)
    try:
        return await answer
    finally:
        timing.log()


def watched_thread_work(work: Callable[[], _T]) -> Callable[[], _T]:
    submitted_at = time.perf_counter()

    def run() -> _T:
        waited = time.perf_counter() - submitted_at
        started_at = time.perf_counter()
        try:
            return work()
        finally:
            if waited >= THREAD_WAIT_LOG_SECONDS:
                log("thread-wait", wait_ms=round(waited * 1000), work_ms=elapsed_ms(started_at))

    return run


async def watch_event_loop() -> None:
    while True:
        slept_at = time.perf_counter()
        await asyncio.sleep(LOOP_WATCH_INTERVAL_SECONDS)
        late = time.perf_counter() - slept_at - LOOP_WATCH_INTERVAL_SECONDS
        if late >= LOOP_LATE_SECONDS:
            log("loop-late", late_ms=round(late * 1000))


async def timed_waveform_build(build: Awaitable[_T]) -> _T:
    if not ENABLED:
        return await build
    global _running_waveform_builds
    _running_waveform_builds += 1
    started_at = time.perf_counter()
    log("waveform-started", running=_running_waveform_builds)
    outcome = "failed"
    try:
        result = await build
        outcome = "done"
        return result
    except asyncio.CancelledError:
        outcome = "stopped"
        raise
    finally:
        _running_waveform_builds -= 1
        log(
            "waveform-ended",
            outcome=outcome,
            elapsed_ms=elapsed_ms(started_at),
            running=_running_waveform_builds,
        )
