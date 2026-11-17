"""The one connection a cover run's per-album commits share (no database)."""

from __future__ import annotations

import contextvars
import threading

import pytest

from music_app.services import scan_cache_persistence
from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter, shared_scan_cache_connection

URL = "postgresql://shared-connection-test"
CONFIG = {"ALBUM_HAVEN_APP_DATABASE_URL": URL}


class FakeConnection:
    def __init__(self, log: list[str], name: str):
        self.log = log
        self.name = name
        self.closed = False

    def execute(self, sql, params=None):
        self.log.append(f"{self.name}:execute")

    def commit(self):
        self.log.append(f"{self.name}:commit")

    def rollback(self):
        self.log.append(f"{self.name}:rollback")

    def close(self):
        self.closed = True
        self.log.append(f"{self.name}:close")


@pytest.fixture
def connections(monkeypatch):
    log: list[str] = []
    opened: list[FakeConnection] = []

    def connect(_url):
        connection = FakeConnection(log, f"c{len(opened) + 1}")
        opened.append(connection)
        return connection

    monkeypatch.setattr(scan_cache_persistence, "_connect", connect)
    return log, opened


def _shared():
    return scan_cache_persistence._SHARED_CONNECTION.get()


def test_a_scope_opens_one_connection_and_each_block_is_its_own_transaction(connections):
    log, opened = connections
    with shared_scan_cache_connection(CONFIG):
        assert len(opened) == 1, "opened once, before any album is processed"
        for _ in range(3):
            with _shared().transaction() as connection:
                connection.execute("update")
        with pytest.raises(ValueError):
            with _shared().transaction() as connection:
                connection.execute("update")
                raise ValueError("album failed")
        with _shared().transaction() as connection:
            connection.execute("update")
    assert len(opened) == 1
    assert log == [
        *["c1:execute", "c1:commit"] * 3,
        "c1:execute", "c1:rollback",
        "c1:execute", "c1:commit",
        "c1:close",
    ]
    assert _shared() is None


def test_after_the_connection_breaks_each_later_commit_fails_on_its_own(connections):
    _log, opened = connections
    with shared_scan_cache_connection(CONFIG):
        with pytest.raises(RuntimeError, match="statement failed"):
            with _shared().transaction() as connection:
                connection.rollback = lambda: (_ for _ in ()).throw(OSError("connection lost"))
                raise RuntimeError("statement failed")
        with pytest.raises(RuntimeError, match="unavailable"):
            with _shared().transaction():
                pass
    assert len(opened) == 1 and opened[0].closed


def test_an_unreachable_database_fails_the_commits_not_the_run(monkeypatch):
    monkeypatch.setattr(scan_cache_persistence, "_connect", lambda _url: (_ for _ in ()).throw(OSError("refused")))
    with shared_scan_cache_connection(CONFIG):
        with pytest.raises(RuntimeError, match="unavailable"):
            with _shared().transaction():
                pass


def test_the_shared_commit_needs_the_runs_connection_and_never_opens_its_own(connections):
    _log, opened = connections
    store = PostgresScanCacheAdapter(CONFIG)
    with pytest.raises(RuntimeError, match="shared connection"):
        store.persist_cover_selection_in_shared_transaction(track_paths={"/a.mp3"}, selected_cover_path=None, clear_selection=True)
    with shared_scan_cache_connection({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://another"}):
        with pytest.raises(RuntimeError, match="shared connection"):
            store.persist_cover_selection_in_shared_transaction(track_paths={"/a.mp3"}, selected_cover_path=None, clear_selection=True)
    assert len(opened) == 1, "only the other database's scope connected"


def test_worker_threads_in_a_copied_context_take_turns_on_the_one_connection(connections):
    _log, opened = connections
    inside = threading.Event()
    release = threading.Event()
    order: list[str] = []

    def first():
        with _shared().transaction():
            order.append("first-start")
            inside.set()
            release.wait(5)
            order.append("first-end")

    def second():
        inside.wait(5)
        with _shared().transaction():
            order.append("second")

    with shared_scan_cache_connection(CONFIG):
        threads = [threading.Thread(target=contextvars.copy_context().run, args=(target,)) for target in (first, second)]
        for thread in threads:
            thread.start()
        inside.wait(5)
        threading.Event().wait(0.1)
        assert order == ["first-start"], "the second commit waits for the first transaction"
        release.set()
        for thread in threads:
            thread.join(5)
    assert order == ["first-start", "first-end", "second"]
    assert len(opened) == 1


def test_scopes_do_not_nest(connections):
    _log, opened = connections
    with shared_scan_cache_connection(CONFIG):
        outer = _shared()
        with shared_scan_cache_connection(CONFIG):
            assert _shared() is outer
        assert not opened[0].closed
    assert len(opened) == 1 and opened[0].closed
