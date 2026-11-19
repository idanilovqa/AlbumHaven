"""Wakes live-event streams when Postgres announces a committed library change.

One daemon thread per process LISTENs on album_haven_library_changes and wakes every waiting
stream; streams then read the change log themselves, so a lost notification only delays an
event until the next keepalive read. The same thread learns the current head once it listens,
so application startup never waits for the database, and prunes the log once an hour.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Iterator
from contextlib import contextmanager
import json
import logging
import threading
import time
from types import SimpleNamespace

from music_app.services.library_change_events_postgres import LibraryChangePage

CHANNEL = "album_haven_library_changes"
KEEPALIVE_SECONDS = 25.0
REAUTHORIZE_SECONDS = 300.0
PRUNE_INTERVAL_SECONDS = 3600.0


class LibraryChangeBroker:
    def __init__(
        self,
        *,
        listen: Callable[[threading.Event], Iterable[object]] | None = None,
        prune: Callable[[], object] | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self._listen = listen
        self._prune = prune
        self._logger = logger or logging.getLogger(__name__)
        self._lock = threading.Lock()
        self._waiters: set[tuple[asyncio.AbstractEventLoop, asyncio.Event]] = set()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._head: int | None = None
        self.closing = False

    @property
    def head(self) -> int | None:
        """The latest revision seen by this process, or None until the listener first connects."""
        return self._head

    def note_head(self, revision: int) -> None:
        with self._lock:
            self._head = max(self._head or 0, revision)

    @classmethod
    def for_database(
        cls,
        database_url: str,
        *,
        read_head: Callable[[], int],
        prune: Callable[[], object],
        logger=None,
    ) -> "LibraryChangeBroker":
        def listen(stop: threading.Event) -> Iterable[object]:
            import psycopg

            with psycopg.connect(database_url, autocommit=True, connect_timeout=5) as connection:
                connection.execute(f"listen {CHANNEL}")
                # Read only once listening, so no commit falls between the head and the first notice.
                yield SimpleNamespace(payload=str(read_head()))
                while not stop.is_set():
                    yield from connection.notifies(timeout=1.0)
                    yield None  # heartbeat so the loop can prune and observe stop

        return cls(listen=listen, prune=prune, logger=logger)

    def start(self) -> None:
        if self._listen is None or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="library-change-broker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self.closing = True
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=1)
        self.publish()

    def publish(self) -> None:
        with self._lock:
            waiters = tuple(self._waiters)
        for loop, event in waiters:
            try:
                loop.call_soon_threadsafe(event.set)
            except RuntimeError:  # the stream's loop already closed
                continue

    @contextmanager
    def subscribe(self) -> Iterator[Callable[[float], Awaitable[bool]]]:
        """A waiter registered for the whole stream, so no announcement falls between reads."""
        waiter = (asyncio.get_running_loop(), asyncio.Event())
        with self._lock:
            self._waiters.add(waiter)

        async def wait(timeout: float) -> bool:
            try:
                await asyncio.wait_for(waiter[1].wait(), timeout)
                return True
            except asyncio.TimeoutError:
                return False
            finally:
                waiter[1].clear()

        try:
            yield wait
        finally:
            with self._lock:
                self._waiters.discard(waiter)

    def _run(self) -> None:
        next_prune = 0.0
        backoff = 1.0
        reported = False
        while not self._stop.is_set():
            try:
                for notice in self._listen(self._stop):
                    backoff, reported = 1.0, False
                    if notice is not None:
                        payload = str(getattr(notice, "payload", "") or "")
                        if payload.isdigit():
                            self.note_head(int(payload))
                        self.publish()
                    if self._prune is not None and time.monotonic() >= next_prune:
                        next_prune = time.monotonic() + PRUNE_INTERVAL_SECONDS
                        self._prune()
                    if self._stop.is_set():
                        return
            except Exception:
                if not reported:
                    self._logger.warning("Live library change listener failed; retrying.", exc_info=True)
                    reported = True
                # Streams fall back to reading at every keepalive until the listener returns.
                self.publish()
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 30.0)


def format_page(page: LibraryChangePage) -> list[str]:
    """Server-sent event frames for one page of the change log."""
    if page.resync:
        return [f"id: {page.head}\nevent: resync\ndata: {json.dumps({'head': page.head})}\n\n"]
    return [
        f"id: {event.revision}\nevent: change\n"
        f"data: {json.dumps({'kinds': list(event.kinds), 'refs': event.refs}, ensure_ascii=False, separators=(',', ':'))}\n\n"
        for event in page.events
    ]


async def stream_library_changes(
    *,
    since: int,
    read_page: Callable[[int], Awaitable[LibraryChangePage]],
    wait_for_change: Callable[[float], Awaitable[bool]],
    authorized: Callable[[], Awaitable[bool]],
    is_disconnected: Callable[[], Awaitable[bool]],
    closing: Callable[[], bool] = lambda: False,
    keepalive_seconds: float = KEEPALIVE_SECONDS,
    reauthorize_seconds: float = REAUTHORIZE_SECONDS,
    clock: Callable[[], float] = time.monotonic,
) -> AsyncIterator[str]:
    """Replay from ``since``, then follow new changes until the client leaves or loses access."""
    cursor = since
    reauthorize_at = clock() + reauthorize_seconds
    yield "retry: 3000\n: connected\n\n"
    while True:
        page = await read_page(cursor)
        for frame in format_page(page):
            yield frame
        if page.resync or page.events:
            cursor = page.head if page.resync else page.events[-1].revision
        changed = await wait_for_change(keepalive_seconds)
        if closing() or await is_disconnected():
            return
        if clock() >= reauthorize_at:
            if not await authorized():
                yield "event: unauthorized\ndata: {}\n\n"
                return
            reauthorize_at = clock() + reauthorize_seconds
        if not changed:
            yield ": keepalive\n\n"


def close_streams_on_exit_signal(broker: LibraryChangeBroker, loop: asyncio.AbstractEventLoop) -> None:
    """Chain the server's exit-signal handlers so open streams end as shutdown begins.

    Uvicorn waits for open responses before it runs the application's shutdown, so a stream
    left open would hold every restart for the whole graceful-shutdown timeout. The handler
    only schedules the wake-up on the loop; it takes no lock inside the signal handler.
    """
    import signal

    if threading.current_thread() is not threading.main_thread():
        return
    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        number = getattr(signal, name, None)
        previous = signal.getsignal(number) if number is not None else None
        if not callable(previous):
            continue

        def on_exit(signum, frame, previous=previous):
            broker.closing = True
            try:
                loop.call_soon_threadsafe(broker.publish)
            except RuntimeError:  # that app's loop already closed; never block the exit
                pass
            previous(signum, frame)

        signal.signal(number, on_exit)
