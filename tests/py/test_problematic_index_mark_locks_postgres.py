"""Clearing the Problematic Files marks never waits on a mark another transaction holds.

A writer marks albums as it changes their rows and marks 0 when it updates the library row. The clear took
the same marks in the opposite order, so a scan or a save died on "deadlock detected".
"""
from __future__ import annotations

from contextlib import contextmanager
from threading import Thread
from time import monotonic, sleep

import psycopg
import pytest
from psycopg.rows import dict_row

from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (live fixture)

# Postgres reports a deadlock after one second; nothing here should need more.
SETTLE_SECONDS = 10


@pytest.fixture
def index(watcher_repair_inventory, monkeypatch):
    from music_app.services import problematic_index
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    fixture = watcher_repair_inventory
    monkeypatch.setenv("ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED", "1")
    monkeypatch.setattr(problematic_index, "queue_maintenance", lambda _repository: None)
    fixture.seed(*(fixture.entry(f"Owner/Album {name}/01.flac", album=f"Album {name}") for name in "ABC"))
    repository = PostgresLibraryBrowseRepository(fixture.config)
    problematic_index.prepare_for_serving(repository)
    return _Index(fixture, repository, problematic_index)


class _Index:
    def __init__(self, fixture, repository, module):
        self.setup_url, self.runtime_url = fixture.setup_url, fixture.runtime_url
        self.repository, self.module = repository, module
        with psycopg.connect(self.setup_url) as connection:
            rows = connection.execute("select id, library_id from library.local_albums order by id").fetchall()
        self.albums = [row[0] for row in rows]
        self.library_id = rows[0][1]

    def mark(self, connection, album_id):
        connection.execute("select library.mark_problematic_album_dirty(%s, %s)", (self.library_id, album_id))

    def committed_marks(self, *album_ids):
        with psycopg.connect(self.setup_url) as connection:
            for album_id in album_ids:
                self.mark(connection, album_id)
        return [row for row in self.marks() if row["album_id"] in album_ids]

    def marks(self):
        with psycopg.connect(self.setup_url, row_factory=dict_row) as connection:
            return connection.execute(
                """select album_id, marked_xid::text as marked_xid from library.problematic_index_dirty_albums
                   where library_id = %s order by album_id""",
                (self.library_id,),
            ).fetchall()

    @contextmanager
    def writer(self, album_id):
        """A transaction that changed the album, so holds its mark until it ends."""
        connection = psycopg.connect(self.setup_url)
        try:
            self.mark(connection, album_id)
            yield connection
        finally:
            connection.rollback()
            connection.close()

    def worker(self):
        return psycopg.connect(self.runtime_url, row_factory=dict_row, autocommit=True)

    def waits_for(self, writer):
        with psycopg.connect(self.setup_url) as connection:
            return connection.execute(
                "select exists (select 1 from pg_stat_activity where %s = any(pg_blocking_pids(pid)))",
                (writer.info.backend_pid,),
            ).fetchone()[0]


class _Clear(Thread):
    def __init__(self, work):
        super().__init__(daemon=True)
        self.work, self.error, self.result = work, None, None
        self.start()

    def run(self):
        try:
            self.result = self.work()
        except Exception as error:
            self.error = error

    def settle(self, index, writer):
        """Until the clear has ended or is waiting for the writer."""
        deadline = monotonic() + SETTLE_SECONDS
        while self.is_alive() and not index.waits_for(writer):
            assert monotonic() < deadline, "The clear neither ended nor waited."
            sleep(0.05)


def _clear_crossing_a_writer(index, clear):
    """The clear runs while a writer holds an album's mark; the writer then marks 0 and commits."""
    album = index.albums[0]
    marks = index.committed_marks(0, album)
    errors = []
    with index.writer(album) as writer:
        worker = _Clear(lambda: clear(marks))
        worker.settle(index, writer)
        try:
            index.mark(writer, 0)
            writer.commit()
        except psycopg.Error as error:
            errors.append(error)
            writer.rollback()
    worker.join(SETTLE_SECONDS)
    assert not worker.is_alive(), "The clear never ended."
    if worker.error:
        errors.append(worker.error)
    assert not errors, [(type(error).__name__, getattr(error, "sqlstate", None)) for error in errors]
    before = {row["album_id"]: row["marked_xid"] for row in marks}
    after = {row["album_id"]: row["marked_xid"] for row in index.marks()}
    assert album in after and after[album] != before[album], "The writer's mark was lost."


def test_drain_crossing_a_writer_never_deadlocks(index):
    def drain(marks):
        with index.worker() as connection:
            index.module._drain(index.repository, connection, index.library_id, marks)

    _clear_crossing_a_writer(index, drain)


def test_backfill_crossing_a_writer_never_deadlocks(index):
    with psycopg.connect(index.setup_url) as connection:
        connection.execute("update library.album_duplicate_results_state set status = 'building'")

    def backfill(_marks):
        with index.worker() as connection:
            index.module._backfill(index.repository, connection, index.library_id, None)

    _clear_crossing_a_writer(index, backfill)


def test_a_pass_clears_marks_after_held_ones_and_tries_each_once(index, monkeypatch):
    held, *free = index.albums
    index.committed_marks(held, *free)
    monkeypatch.setattr(index.module, "BACKFILL_BATCH", 1)  # the held mark alone fills the first batch
    tried = []
    drain = index.module._drain

    def counted(repository, connection, library_id, marks, **options):
        tried.extend(row["album_id"] for row in marks)
        return drain(repository, connection, library_id, marks, **options)

    monkeypatch.setattr(index.module, "_drain", counted)

    def bring_up_to_date():
        with index.worker() as connection:
            index.module._bring_up_to_date(index.repository, connection, index.library_id)

    with index.writer(held) as writer:
        worker = _Clear(bring_up_to_date)
        worker.join(SETTLE_SECONDS)
        ended = not worker.is_alive()
        remaining = [row["album_id"] for row in index.marks()]
        writer.rollback()
    worker.join(SETTLE_SECONDS)

    assert ended, "The pass waited for the held mark."
    assert worker.error is None
    assert remaining == [held]
    assert sorted(tried) == sorted([held, *free])


def test_prepare_for_serving_fails_while_a_mark_is_skipped(index):
    held = index.albums[0]
    index.committed_marks(held)
    with index.writer(held) as writer:
        worker = _Clear(lambda: index.module.prepare_for_serving(index.repository))
        worker.join(SETTLE_SECONDS)
        ended = not worker.is_alive()
        waiting = index.module.serving_readiness(index.repository)["changed_albums_waiting"]
        writer.rollback()
    worker.join(SETTLE_SECONDS)

    assert ended, "The deploy step waited for the held mark."
    assert isinstance(worker.error, index.module.PreparationError)
    assert waiting == 1, "--check would report ready with a mark left."


def test_a_skipped_mark_is_cleared_after_its_writer_rolls_back(index):
    held = index.albums[0]
    index.committed_marks(held)
    with index.writer(held) as writer:
        worker = _Clear(lambda: index.module.refresh(index.repository))
        worker.join(SETTLE_SECONDS)
        ended = not worker.is_alive()
        writer.rollback()  # no publication follows
    worker.join(SETTLE_SECONDS)
    assert ended, "The read waited for the held mark."

    assert index.module.refresh(index.repository) is True
    assert index.marks() == []
