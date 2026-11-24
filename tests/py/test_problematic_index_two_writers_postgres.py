"""Two writers that mark the same albums never deadlock (deadlock part 3).

A save or scan marks the albums it changes while it holds the inventory publication lock. A Rules writer
(ignored repairs, separate releases) marks the albums its rows name, through triggers, one row at a time.
Without the inventory lock it can take two albums' marks in the other order and die, or kill the save,
with "deadlock detected". Each case drives the real Rules writer against a held save, in both start orders.
"""
from __future__ import annotations

from threading import Event, Thread
from time import monotonic, sleep

import psycopg
import pytest
from psycopg.rows import dict_row

from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (live fixture)

SETTLE_SECONDS = 10
HOLD_INVENTORY_PUBLICATION = "select pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'))"


@pytest.fixture
def library(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    fixture.seed(*(fixture.entry(f"Owner/Album {name}/01.flac", album=f"Album {name}") for name in "AB"))
    return _Library(fixture)


class _Library:
    def __init__(self, fixture):
        self.fixture = fixture
        with psycopg.connect(fixture.setup_url, row_factory=dict_row) as connection:
            rows = connection.execute(
                "select id, library_id, album_key from library.local_albums order by album_key").fetchall()
        # Rules writers walk their keys in sorted order, so `first` is the album they mark first.
        self.first, self.second = rows[0], rows[1]
        self.library_id = rows[0]["library_id"]

    def mark(self, connection, album):
        connection.execute("select library.mark_problematic_album_dirty(%s, %s)", (self.library_id, album["id"]))

    def save(self):
        """A save's transaction: the inventory lock first, then its albums' marks."""
        connection = psycopg.connect(self.fixture.setup_url)
        connection.execute(HOLD_INVENTORY_PUBLICATION)
        return connection

    def waits_on(self, holder):
        return self.waits_on_pid(holder.info.backend_pid)

    def waits_on_pid(self, pid):
        with psycopg.connect(self.fixture.setup_url) as connection:
            return connection.execute(
                "select exists (select 1 from pg_stat_activity where %s = any(pg_blocking_pids(pid)))",
                (pid,),
            ).fetchone()[0]

    def rules(self, pause_after_first_row=None):
        """The real Rules writer; it can pause after the first row it writes (its first album's mark)."""
        from music_app.services.rule_state_postgres import RuleStatePostgresAdapter

        url = self.fixture.runtime_url

        def connect(_database_url):
            return _PausingConnection(psycopg.connect(url, row_factory=dict_row), pause_after_first_row)

        return RuleStatePostgresAdapter(self.fixture.config, connect=connect)


class _PausingConnection:
    def __init__(self, connection, pause):
        self._connection, self._pause, self._written = connection, pause, False
        if pause is not None:
            pause.backend_pid = connection.info.backend_pid

    def execute(self, query, params=None):
        cursor = self._connection.execute(query, params)
        text = str(query).lower()
        if self._pause is not None and not self._written and (
                "insert into library.ignored_repairs" in text or "insert into library.separate_releases" in text):
            self._written = True
            self._pause.reached.set()
            assert self._pause.resume.wait(SETTLE_SECONDS * 3), "The test never resumed the Rules writer."
        return cursor

    def transaction(self):
        return self._connection.transaction()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self._connection.close()


class _Pause:
    def __init__(self):
        self.reached, self.resume, self.backend_pid = Event(), Event(), None


class _Writer(Thread):
    def __init__(self, work):
        super().__init__(daemon=True)
        self.work, self.error = work, None
        self.start()

    def run(self):
        try:
            self.work()
        except Exception as error:
            self.error = error


def _settle(library, writer, holder):
    deadline = monotonic() + SETTLE_SECONDS
    while writer.is_alive() and not library.waits_on(holder):
        assert monotonic() < deadline, "The Rules writer neither ended nor waited."
        sleep(0.05)


def _ignore_both(library, adapter):
    keys = {f"{album['album_key']}::problem-album::rule": album["album_key"] for album in (library.first, library.second)}
    adapter.upsert_ignored_repair_keys(keys, album_keys_by_repair_key=keys)


def _separate_both(library, adapter):
    adapter.save_separate_release_keys([library.first["album_key"], library.second["album_key"]])


WRITERS = {"ignored repairs": _ignore_both, "separate releases": _separate_both}


def _assert_no_deadlock(errors, writer):
    writer.join(SETTLE_SECONDS * 3)
    assert not writer.is_alive(), "The Rules writer never ended."
    failures = [*errors, *([writer.error] if writer.error else [])]
    assert not [error for error in failures if isinstance(error, psycopg.errors.DeadlockDetected)], failures
    assert not failures, failures


@pytest.mark.parametrize("write", WRITERS.values(), ids=WRITERS.keys())
def test_a_rules_writer_started_during_a_save_never_deadlocks_with_it(library, write):
    """The save holds the album the Rules writer marks second; the writer starts; the save marks the other."""
    errors = []
    save = library.save()
    try:
        library.mark(save, library.second)
        writer = _Writer(lambda: write(library, library.rules()))
        _settle(library, writer, save)
        try:
            library.mark(save, library.first)
            save.commit()
        except psycopg.Error as error:
            errors.append(error)
            save.rollback()
    finally:
        save.close()
    _assert_no_deadlock(errors, writer)


@pytest.mark.parametrize("write", WRITERS.values(), ids=WRITERS.keys())
def test_a_save_started_during_a_rules_writer_never_deadlocks_with_it(library, write):
    """The Rules writer holds its first album; a save starts, marks the second, then wants the first."""
    pause = _Pause()
    writer = _Writer(lambda: write(library, library.rules(pause)))
    errors = []

    def save_both():
        save = library.save()
        try:
            library.mark(save, library.second)
            library.mark(save, library.first)
            save.commit()
        except psycopg.Error as error:
            errors.append(error)
            save.rollback()
        finally:
            save.close()

    try:
        assert pause.reached.wait(SETTLE_SECONDS), "The Rules writer never wrote its first row."
        saver = _Writer(save_both)
        deadline = monotonic() + SETTLE_SECONDS
        while saver.is_alive() and not library.waits_on_pid(pause.backend_pid):
            assert monotonic() < deadline, "The save neither ended nor waited for the Rules writer."
            sleep(0.05)
    finally:
        pause.resume.set()
    saver.join(SETTLE_SECONDS * 3)
    assert not saver.is_alive(), "The save never ended."
    _assert_no_deadlock([*errors, *([saver.error] if saver.error else [])], writer)
