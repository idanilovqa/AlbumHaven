"""Counted on real Postgres: one album's open costs the same at any library size (guard backlog case 50)."""
from __future__ import annotations

from contextlib import contextmanager
import os
from pathlib import Path
from uuid import uuid4

from PIL import Image
import pytest

from music_app.services import local_cover_inventory as inventory
from tests.e2e.support import isolatedPostgres


_ROWS_READ = """select coalesce(sum(coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0)), 0)::bigint as rows_read
  from pg_stat_xact_user_tables where relname = 'local_cover_inventories'"""


class Counting:
    """A connection that notes the rows each transaction read and wrote in the listing table."""

    def __init__(self, connection, counts):
        self.connection, self.counts = connection, counts

    def execute(self, sql, params=None):
        cursor = self.connection.execute(sql, params)
        if not sql.lstrip().lower().startswith("select"):
            self.counts["written"] += cursor.rowcount
        return cursor

    def note_reads(self):
        self.counts["read"] = max(self.counts["read"], self.connection.execute(_ROWS_READ).fetchone()["rows_read"])

    def commit(self):
        self.note_reads()
        self.connection.commit()


@pytest.mark.parametrize("library_size", [1000, 16000])
def test_open_refresh_and_delete_touch_one_row_at_any_library_size(library_size, tmp_path):
    if not os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV) or not os.environ.get(isolatedPostgres.RUNTIME_DATABASE_ENV):
        pytest.skip("Dedicated isolated Postgres URLs are required.")
    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    prefix = inventory.root_key(Path(f"/counted-{uuid4()}"))
    album = tmp_path / "Album"
    album.mkdir()
    Image.new("RGB", (20, 20), "red").save(album / "cover.jpg")
    keys = [inventory.root_key(album)]
    counts = {"read": 0, "written": 0}

    @contextmanager
    def connect(url):
        with isolatedPostgres._connect(url) as connection:
            counting = Counting(connection, counts)
            yield counting
            counting.note_reads()

    def measured(action):
        counts.update(read=0, written=0)
        result = action()
        return result, dict(counts)

    repository = inventory.LocalCoverInventoryRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}, connect=connect,
    )
    worker = inventory.LocalCoverInventoryWorker({"IMAGE_EXTENSIONS": {".jpg"}}, repository=repository)
    try:
        with isolatedPostgres._connect(setup_url) as connection:
            # A library of stored listings, every one left pending as on a restored copy.
            connection.execute(
                f"""insert into library.local_cover_inventories (library_id, root_path, revision, indexed_revision)
                    select ({inventory.LIBRARY_ID_SQL}), %s::text || '-' || number, 2, 1
                    from generate_series(1, %s::integer) as number""",
                (prefix, library_size),
            )
            connection.commit()
            connection.execute("analyze library.local_cover_inventories")
            connection.commit()

        worker.refresh(album)
        _, refreshed = measured(lambda: worker.refresh(album))
        assert refreshed["read"] <= 2 and refreshed["written"] == 0, "an unchanged open"

        row, opened = measured(lambda: repository.get([album]))
        assert opened["read"] <= 2 and opened["written"] == 0
        assert row[keys[0]]["complete"]

        Image.new("RGB", (30, 30), "blue").save(album / "back.jpg")
        _, changed = measured(lambda: worker.refresh(album))
        assert changed["read"] <= 4 and changed["written"] == 1, "a change the watcher missed"

        _, deleted = measured(lambda: worker.remove_path(album, album / "back.jpg"))
        assert deleted["read"] <= 4 and deleted["written"] == 1

        def idle():
            worker.start()
            worker.close()

        _, idled = measured(idle)
        assert idled == {"read": 0, "written": 0}, "a restart over a stale backlog, left idle"
    finally:
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                "delete from library.local_cover_inventories where root_path = any(%s::text[]) or starts_with(root_path, %s)",
                (keys, prefix),
            )
            connection.commit()
