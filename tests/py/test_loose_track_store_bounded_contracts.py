"""The Loose Tracks store's background owners hold their own connections, never a lease per batch (case 64, BI-05).

Both entrypoints run ``loose_track_store.prepare``: the start-up owner thread and the loose-tracks utility
prewarm. A build loads every batch on the connection it holds for the whole build, and a drain batch on the
connection it opened for that batch. The loader leases a connection of its own only when none is passed;
the contract counts every pool lease and every fallback connection, and each batch's statements, at two
library sizes.
"""
from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace

from tests.py.bounded_interactions import CountingConnection, OperationCounts, _checked_in_entries, measure_scale_pair
from tests.py.test_isolated_postgres_live import (  # noqa: F401 (live fixture)
    _loose_library,
    isolatedPostgres,
    watcher_repair_inventory,
)

OWNER = "py:services/loose_track_store.py#LooseTrackStoreOwner._run"
PREWARM = "py:services/library_browse_postgres.py#PostgresLibraryBrowseRepository._run_utility_projection_prewarm"
BATCH = 5  # so the small library takes 2 build batches and the production-size one 400


def _counted_store(fixture, monkeypatch):
    """A repository whose owned connections are counted, with every pool lease and loader fallback counted."""
    from music_app.services import library_browse_postgres as browse
    from music_app.services import loose_track_store

    monkeypatch.setattr(loose_track_store, "BUILD_BATCH", BATCH)
    monkeypatch.setattr(loose_track_store, "DRAIN_BATCH", BATCH)
    counted = SimpleNamespace(counts=OperationCounts(), opened=0, loads=[], drains=[])
    repository = browse.PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    owned = repository._owned_connection_context

    @contextmanager
    def counted_owned():
        counted.opened += 1
        with owned() as connection:
            yield CountingConnection(connection, counted.counts)

    pooled = browse._pooled_connection

    @contextmanager
    def counted_pool(*args, **kwargs):
        counted.counts.pool_leases += 1
        with pooled(*args, **kwargs) as connection:
            yield connection

    inventory = repository._inventory_repository
    own_inventory_connection = inventory._connect_to_database

    def counted_inventory_connection():
        # The loader's own connection (a lease from the shared pool in production): what a batch must never take.
        counted.counts.pool_leases += 1
        return own_inventory_connection()

    load, drain = loose_track_store._load_candidates, loose_track_store.drain

    def counted_load(*args, **kwargs):
        counted.loads.append(counted.counts.sql_statements)
        return load(*args, **kwargs)

    def counted_drain(*args, **kwargs):
        before = counted.counts.sql_statements
        try:
            return drain(*args, **kwargs)
        finally:
            counted.drains.append(counted.counts.sql_statements - before)

    monkeypatch.setattr(repository, "_owned_connection_context", counted_owned)
    monkeypatch.setattr(browse, "_pooled_connection", counted_pool)
    monkeypatch.setattr(inventory, "_connect_to_database", counted_inventory_connection)
    monkeypatch.setattr(loose_track_store, "_load_candidates", counted_load)
    monkeypatch.setattr(loose_track_store, "drain", counted_drain)
    return repository, counted


def _measure_store(fixture, monkeypatch, interaction_id, prepare_once):
    """Runs the entrypoint twice per library size: the start-up build, then a drain of a mark on every track."""
    from music_app.services import loose_track_store

    def run(tracks):
        loose = tracks // 2
        _loose_library(fixture, tracks - loose, loose=loose)
        with isolatedPostgres._connect(fixture.setup_url) as connection:  # each size starts with no store
            connection.execute("delete from library.non_album_track_store_state")
        repository, counted = _counted_store(fixture, monkeypatch)
        measured = OperationCounts()
        for setup in (None, "select library.mark_loose_track(library_id, id) from library.local_tracks"):
            if setup:
                with isolatedPostgres._connect(fixture.setup_url) as connection:
                    connection.execute(setup)
            counted.opened, counted.loads, counted.drains = 0, [], []
            counted.counts.sql_statements = counted.counts.pool_leases = 0
            prepare_once(repository)
            with isolatedPostgres._connect(fixture.setup_url) as connection:
                state = connection.execute("select status from library.non_album_track_store_state").fetchone()
                marks = connection.execute("select count(*) as marks from library.non_album_track_marks").fetchone()
            assert state["status"] == "ready" and marks["marks"] == 0, "the pass built the store and drained every mark"
            drain_batches = len(counted.drains)
            # The state read, then (start-up only) the build's owner session, its state write and its batch
            # connection, then one connection per drain batch, the last finding nothing.
            expected = 1 + (3 if setup is None else 0) + drain_batches
            assert counted.opened == expected, f"opened {counted.opened} connections, expected {expected}"
            build_loads = counted.loads[: len(counted.loads) - (drain_batches - 1)]
            build_batches = [after - before for before, after in zip(build_loads, build_loads[1:])]
            if setup is None:
                assert len(build_loads) >= tracks // BATCH, build_loads
            measured.pool_leases += counted.counts.pool_leases
            # Per batch, not per pass: the most statements any one build or drain batch ran.
            measured.sql_statements = max(measured.sql_statements, *build_batches, *counted.drains)
        print(f"{tracks} tracks: largest batch {measured.sql_statements} statements, {measured.pool_leases} pool leases")
        assert loose_track_store.BUILD_BATCH == BATCH
        return measured

    entry = _checked_in_entries()[interaction_id]
    measure_scale_pair(
        interaction_id=interaction_id,
        small=entry["cardinalities"]["small"],
        large=entry["cardinalities"]["production"],
        run=run,
        budgets=entry["budgets"],
        growth=(entry["growth"]["metric"], entry["growth"]["largeMinusSmallMax"]),
    )


def test_the_store_owner_builds_and_drains_on_connections_of_its_own_and_its_batches_stay_flat(
    watcher_repair_inventory, monkeypatch,
):
    from music_app.services.loose_track_store import LooseTrackStoreOwner

    def prepare_once(repository):
        owner = LooseTrackStoreOwner(watcher_repair_inventory.config, repository_factory=lambda: repository)
        assert owner.run_once() is None, "the pass failed"

    _measure_store(watcher_repair_inventory, monkeypatch, OWNER, prepare_once)


def test_the_loose_tracks_prewarm_builds_and_drains_on_connections_of_its_own_and_its_batches_stay_flat(
    watcher_repair_inventory, monkeypatch,
):
    from music_app.services import library_browse_postgres as browse

    requeued = []
    monkeypatch.setattr(browse.PostgresLibraryBrowseRepository, "queue_utility_projection_prewarm",
                        lambda self, kind: requeued.append(kind))

    def prepare_once(repository):
        cache_key = repository._utility_projection_cache_key("loose-tracks")
        repository._run_utility_projection_prewarm(
            "loose-tracks", cache_key, browse._UTILITY_PROJECTION_GENERATIONS.get(cache_key, 0),
        )
        assert requeued == [], "the prewarm ran once, with no replay"

    _measure_store(watcher_repair_inventory, monkeypatch, PREWARM, prepare_once)
