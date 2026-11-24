"""Problematic Files maintenance holds one connection of its own for a whole pass (6.5, BI-05 on _maintain).

The batch loops hand that connection to every reader. A reader whose connection argument were dropped would
lease the browse pool (or open a connection) per batch: the contract counts both, at two library sizes.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from tests.py.bounded_interactions import CountingConnection, OperationCounts, _checked_in_entries, measure_scale_pair
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (live fixture)

INTERACTION = "py:services/problematic_index.py#_maintain"
BATCH = 5  # so the small library takes 2 batches and the production-size one 12


def _counted_maintenance(fixture, monkeypatch):
    """Counts the pass's statements, its own connections, every other connection and every pool lease."""
    from contextlib import contextmanager

    from music_app.services import library_browse_postgres as browse
    from music_app.services import problematic_index

    monkeypatch.setenv("ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED", "1")
    monkeypatch.setattr(problematic_index, "queue_maintenance", lambda _repository: None)
    monkeypatch.setattr(problematic_index, "BACKFILL_BATCH", BATCH)
    counted = SimpleNamespace(counts=OperationCounts(), own=[], batches=[], fresh=browse._connect)
    open_worker, pooled = problematic_index._worker_connection, browse._pooled_connection

    def worker_connection(repository):
        counted.own.append(repository)
        return CountingConnection(open_worker(repository), counted.counts)

    @contextmanager
    def counted_pool(*args, **kwargs):
        counted.counts.pool_leases += 1
        with pooled(*args, **kwargs) as connection:
            yield connection

    def counted_fresh(url):
        counted.own.append(url)  # any other connection is one too many
        return counted.fresh(url)

    index_rows = problematic_index._index_rows

    def counted_batch(*args, **kwargs):
        before = counted.counts.sql_statements
        try:
            return index_rows(*args, **kwargs)
        finally:
            counted.batches.append(counted.counts.sql_statements - before)

    monkeypatch.setattr(problematic_index, "_worker_connection", worker_connection)
    monkeypatch.setattr(browse, "_pooled_connection", counted_pool)
    monkeypatch.setattr(browse, "_connect", counted_fresh)
    monkeypatch.setattr(problematic_index, "_index_rows", counted_batch)
    return counted


def _start_pass(counted):
    counted.own.clear()
    counted.batches.clear()
    counted.counts.sql_statements = counted.counts.pool_leases = 0


def test_maintenance_holds_one_connection_of_its_own_and_its_batches_stay_flat(watcher_repair_inventory, monkeypatch):
    from music_app.services import problematic_index
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    fixture = watcher_repair_inventory
    counted = _counted_maintenance(fixture, monkeypatch)
    # The first open's detail is warmed once per process after a pass, on a short pooled read; not the pass's
    # (its own bound is the next test).
    monkeypatch.setattr(problematic_index, "_WARMED", {fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]})

    def run(albums):
        fixture.seed(*(fixture.entry(f"Artist {index:03d}/Album {index:03d}/01.flac", artist=f"Artist {index:03d}",
                                     album=f"Album {index:03d}") for index in range(albums)))
        with counted.fresh(fixture.setup_url) as connection:  # each size starts with no index: the backfill runs
            connection.execute("delete from library.problematic_index_state")
        repository = PostgresLibraryBrowseRepository(fixture.config)
        measured = OperationCounts()
        # The backfill pass (no index yet), then a pass draining a mark on every album.
        for setup in (None, "select library.mark_problematic_album_dirty(library_id, id) from library.local_albums"):
            if setup:
                with counted.fresh(fixture.runtime_url) as connection:
                    connection.execute(setup)
            _start_pass(counted)
            problematic_index._maintain(repository)
            assert problematic_index._RETRY_NOT_BEFORE.get(repository._database_url) is None, "the pass failed"
            assert counted.own == [repository], f"one connection of its own per pass, opened {len(counted.own)}"
            assert len(counted.batches) >= albums // BATCH, counted.batches
            measured.pool_leases += counted.counts.pool_leases
            # Per batch, not per pass: the most statements any one batch ran.
            measured.sql_statements = max(measured.sql_statements, *counted.batches)
        print(f"{albums} albums: largest batch {measured.sql_statements} statements, {measured.pool_leases} pool leases")
        return measured

    entry = _checked_in_entries()[INTERACTION]
    measure_scale_pair(
        interaction_id=INTERACTION,
        small=entry["cardinalities"]["small"],
        large=entry["cardinalities"]["production"],
        run=run,
        budgets=entry["budgets"],
        growth=(entry["growth"]["metric"], entry["growth"]["largeMinusSmallMax"]),
    )


def test_maintenance_warms_the_first_detail_on_at_most_one_pooled_lease_per_process(
    watcher_repair_inventory, monkeypatch,
):
    """6.5: the warm-up excluded above stays once per process. Two passes over a library with a problematic
    album take at most one pooled lease between them, so the warm-up can never become per pass."""
    from music_app.services import problematic_index
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    fixture = watcher_repair_inventory
    counted = _counted_maintenance(fixture, monkeypatch)
    monkeypatch.setattr(problematic_index, "_WARMED", set())
    # Two copies of one release: a duplicate pair, so Problematic Files has a first item to warm.
    fixture.seed(fixture.entry("Pair/One/01.flac", artist="Pair", album="Same Release"),
                 fixture.entry("Pair/Two/01.flac", artist="Pair", album="Same Release"))
    with counted.fresh(fixture.setup_url) as connection:
        connection.execute("delete from library.problematic_index_state")
    repository = PostgresLibraryBrowseRepository(fixture.config)

    leases = []
    for _pass in range(2):
        _start_pass(counted)
        problematic_index._maintain(repository)
        assert problematic_index._RETRY_NOT_BEFORE.get(repository._database_url) is None, "the pass failed"
        leases.append(counted.counts.pool_leases)

    assert repository._database_url in problematic_index._WARMED, "the warm-up ran"
    print(f"pooled leases per pass: {leases}")
    assert sum(leases) <= 1 and leases[1] == 0, "the warm-up takes at most one pooled lease per process"


def test_an_index_batch_refuses_to_run_without_its_callers_connection():
    """The guard the contract rests on: a batch never falls back to a reader's own connection or a lease."""
    from music_app.services import problematic_index

    with pytest.raises(TypeError, match="connection"):
        problematic_index._index_rows(object(), None, 1, [1], include_loose=False)
