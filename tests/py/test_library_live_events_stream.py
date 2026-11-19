from __future__ import annotations

import asyncio
from functools import partial
import threading
from types import SimpleNamespace

from fastapi import HTTPException

from music_app.routes import live_events_asgi
from music_app.services.library_change_broker import (
    LibraryChangeBroker,
    close_streams_on_exit_signal,
    stream_library_changes,
)
from music_app.services.library_change_events_postgres import LibraryChangeEvent, LibraryChangePage
from music_app.services.private_route_boundary import private_action_for_route


def _page(*revisions, head=None, resync=False):
    events = tuple(LibraryChangeEvent(revision, ("inventory",), {}) for revision in revisions)
    return LibraryChangePage(events=events, head=head or (revisions[-1] if revisions else 0), resync=resync)


async def _collect(*, pages, changes, authorized=(True,), disconnect_after=None, clock_step=0.0):
    reads, frames = [], []
    pages, changes, authorized = list(pages), list(changes), list(authorized)
    now = [0.0]

    async def read_page(cursor):
        reads.append(cursor)
        return pages.pop(0) if pages else _page(head=cursor)

    async def wait_for_change(_timeout):
        now[0] += clock_step
        return changes.pop(0)

    async def is_disconnected():
        return disconnect_after is not None and len(reads) >= disconnect_after

    async def is_authorized():
        return authorized.pop(0) if authorized else True

    async for frame in stream_library_changes(
        since=10, read_page=read_page, wait_for_change=wait_for_change, authorized=is_authorized,
        is_disconnected=is_disconnected, reauthorize_seconds=100.0, clock=lambda: now[0],
    ):
        frames.append(frame)
    return reads, frames


def test_stream_replays_from_the_cursor_then_follows_each_announced_change():
    reads, frames = asyncio.run(_collect(
        pages=[_page(11, 12), _page(), _page(13)],
        changes=[True, False, True],
        disconnect_after=3,
    ))

    assert reads == [10, 12, 12]
    assert frames[0] == "retry: 3000\n: connected\n\n"
    assert frames[1:3] == [
        'id: 11\nevent: change\ndata: {"kinds":["inventory"],"refs":{}}\n\n',
        'id: 12\nevent: change\ndata: {"kinds":["inventory"],"refs":{}}\n\n',
    ]
    assert frames[3] == ": keepalive\n\n"
    assert frames[4].startswith("id: 13\nevent: change\n")


def test_stream_sends_resync_and_continues_from_the_head():
    reads, frames = asyncio.run(_collect(
        pages=[_page(head=40, resync=True), _page(41)],
        changes=[True, True],
        disconnect_after=2,
    ))

    assert frames[1] == 'id: 40\nevent: resync\ndata: {"head": 40}\n\n'
    assert reads == [10, 40]


def test_stream_closes_when_the_reader_loses_library_access():
    reads, frames = asyncio.run(_collect(
        pages=[_page(), _page()],
        changes=[False, False, False, False],
        authorized=[True, False],
        clock_step=60.0,
    ))

    # Rechecked once per 100 s interval (at 120 s and 240 s), never per event.
    assert frames[-1] == "event: unauthorized\ndata: {}\n\n"
    assert len(reads) == 4


def test_stream_ends_as_soon_as_the_server_starts_shutting_down():
    closing = [False]

    async def scenario():
        frames = []

        async def read_page(cursor):
            return _page(head=cursor)

        async def wait_for_change(_timeout):
            closing[0] = True
            return True

        async def never():
            return False

        async for frame in stream_library_changes(
            since=3, read_page=read_page, wait_for_change=wait_for_change, authorized=never,
            is_disconnected=never, closing=lambda: closing[0],
        ):
            frames.append(frame)
        return frames

    assert asyncio.run(scenario()) == ["retry: 3000\n: connected\n\n"]


def test_exit_signal_ends_open_streams_before_the_servers_own_handler_runs(monkeypatch):
    import signal

    handled, installed = [], {}
    server_handler = lambda signum, frame: handled.append(("server", signum))
    monkeypatch.setattr(signal, "getsignal", lambda number: server_handler)
    monkeypatch.setattr(signal, "signal", lambda number, handler: installed.__setitem__(number, handler))

    async def scenario():
        broker = LibraryChangeBroker()
        close_streams_on_exit_signal(broker, asyncio.get_running_loop())
        with broker.subscribe() as wait:
            installed[signal.SIGINT](signal.SIGINT, None)
            woke = await wait(1.0)
        return broker.closing, woke

    assert asyncio.run(scenario()) == (True, True)
    assert handled == [("server", signal.SIGINT)]


def test_broker_wakes_subscribers_from_the_listener_thread_and_tracks_the_head():
    async def scenario():
        broker = LibraryChangeBroker()
        with broker.subscribe() as wait:
            assert await wait(0.01) is False
            threading.Thread(target=lambda: (broker.note_head(7), broker.publish())).start()
            assert await wait(2.0) is True
            assert await wait(0.01) is False  # one announcement wakes once
        broker.note_head(3)
        return broker.head

    assert asyncio.run(scenario()) == 7


def test_broker_listener_announces_payload_revisions_prunes_and_reconnects_after_failure():
    attempts, pruned = [], []
    stop_after_second = threading.Event()

    def listen(stop):
        attempts.append(1)
        if len(attempts) == 1:
            raise OSError("connection lost")
        yield SimpleNamespace(payload="15")
        yield None
        stop.set()
        stop_after_second.set()

    broker = LibraryChangeBroker(listen=listen, prune=lambda: pruned.append(1))
    broker._run()  # runs until the listener sets stop

    assert stop_after_second.is_set()
    assert len(attempts) == 2
    assert broker.head == 15
    assert pruned == [1]


def test_live_events_route_is_a_library_read():
    assert private_action_for_route("GET", "/api/live/library-events") == "library.browse.read"


def _request(state, *, headers=None, query=None):
    async def is_disconnected():
        return False

    return SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(**state)),
        headers=headers or {},
        query_params=query or {},
        is_disconnected=is_disconnected,
    )


def _use_actor(monkeypatch, actor):
    async def current_actor(_request, refresh=False):
        return actor

    monkeypatch.setattr(live_events_asgi, "current_actor_from_request", current_actor)


def test_live_events_route_is_unavailable_without_the_change_log_or_before_its_listener_connects(monkeypatch):
    _use_actor(monkeypatch, SimpleNamespace(current_library_id=7, account_id=3))
    connecting = {"library_change_repository": object(), "library_change_broker": LibraryChangeBroker()}

    for state in ({}, connecting):
        response = asyncio.run(live_events_asgi.library_events(_request(state, query={"since": "4"})))
        assert response.status_code == 503


def test_live_events_route_reads_the_actors_scope_from_the_cursor_and_closes_on_lost_access(monkeypatch):
    calls = []

    class Repository:
        def read_since(self, **kwargs):
            calls.append(kwargs)
            return _page(head=9, resync=True)

    def deny(_action, **_kwargs):
        async def dependency(_request):
            raise HTTPException(status_code=403)
        return dependency

    _use_actor(monkeypatch, SimpleNamespace(current_library_id=7, account_id=3))
    monkeypatch.setattr(live_events_asgi, "require_action", deny)
    monkeypatch.setattr(live_events_asgi, "stream_library_changes", partial(
        stream_library_changes, keepalive_seconds=0.01, reauthorize_seconds=0.0,
    ))
    broker = LibraryChangeBroker()
    broker.note_head(9)
    request = _request(
        {"library_change_repository": Repository(), "library_change_broker": broker},
        headers={"last-event-id": "5"},
        query={"since": "1"},
    )

    async def scenario():
        response = await live_events_asgi.library_events(request)
        return response, "".join([chunk async for chunk in response.body_iterator])

    response, body = asyncio.run(scenario())

    assert response.media_type == "text/event-stream"
    assert response.headers["cache-control"] == "no-store"
    assert calls == [{"library_id": 7, "account_id": 3, "since": 5}]
    assert body.index('event: resync\ndata: {"head": 9}') < body.index("event: unauthorized")


def test_missing_or_malformed_cursor_asks_for_a_resync():
    def request(headers=None, query=None):
        return SimpleNamespace(headers=headers or {}, query_params=query or {})

    assert live_events_asgi._cursor(request(query={"since": "12"})) == 12
    assert live_events_asgi._cursor(request(headers={"last-event-id": "13"}, query={"since": "12"})) == 13
    assert live_events_asgi._cursor(request()) == -1
    assert live_events_asgi._cursor(request(query={"since": "-4"})) == -1
