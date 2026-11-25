"""A relation publication commits both of its stamps in one transaction, whoever used its pooled connection before.

`library.local_relation_views` serves nothing while the two stamps differ, and readiness then refuses.
Only an explicit full publication repairs that state: never startup and never a request.
Real pool, real setters, generated files and a throwaway database only.
"""
from types import SimpleNamespace

import pytest

from music_app.services import gallery_projection_postgres as gallery
from music_app.services import listen_history, postgres_connections, problematic_index, state
from music_app.services import library_browse_postgres as browse
from music_app.services import relation_projection_postgres as relations
from music_app.services import scan_cache_persistence as scan
from music_app.services import scoped_relation_projection as scoped
from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401


class _Library(SimpleNamespace):
    def __repr__(self):  # pytest prints the arguments of failed tests; the database URLs carry passwords
        return "<generated library>"


class _Logger:
    def __getattr__(self, _name):
        return lambda *_args, **_kwargs: None


@pytest.fixture
def library(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    entries = {}
    for name in ("First", "Second", "Third"):
        entry = fixture.entry(f"{name}/Album {name}/01.flac", artist=name, album=f"Album {name}")
        entry["album_artist"] = name
        entries[entry["path"]] = entry
    postgres_connections.close_pools()
    # The suite switches the Problematic Files index off; its maintenance is one of the setters under test.
    config = {**fixture.config, problematic_index.ENABLED_KEY: "1"}
    yield _Library(fixture=fixture, config=config, setup_url=fixture.setup_url,
                   runtime_url=fixture.runtime_url, entries=entries)
    postgres_connections.close_pools()


def _store_inventory(library):
    """Tracks and files but no relation publication yet, like a freshly restored fixture database."""
    library.fixture.adapter.save_snapshot(
        "unused.json", library.entries, "watcher-repair", 1.0,
        observed_library_root_ids={root["id"] for root in library.fixture.roots},
    )


def _pooled(library):
    with postgres_connections.leased_connection(library.runtime_url) as connection:
        return connection.info.backend_pid, connection.autocommit


def _maintain_index(repository):
    """One background maintenance pass, as startup, saves and watcher passes queue it."""
    problematic_index.queue_maintenance(repository)
    problematic_index.wait_for_background_work()
    readiness = problematic_index.serving_readiness(repository)
    assert readiness["problematic_index"] == "ready", "the index maintenance did not run"


def _index_maintenance(library, _monkeypatch):
    _maintain_index(browse.PostgresLibraryBrowseRepository(library.config))


def _index_refresh(library, _monkeypatch):
    repository = browse.PostgresLibraryBrowseRepository(library.config)
    _maintain_index(repository)
    postgres_connections.close_pools()  # only the refresh may have used the publisher's connection
    with isolatedPostgres._connect(library.setup_url) as connection:
        connection.execute(
            """insert into library.problematic_index_dirty_albums (library_id, album_id)
               select library_id, id from library.local_albums order by id limit 1
               on conflict do nothing"""
        )
    _pooled(library)
    refreshed = problematic_index.refresh(repository)
    assert refreshed, "the index refresh did not run"
    with isolatedPostgres._connect(library.setup_url) as connection:
        left = connection.execute("select count(*) as n from library.problematic_index_dirty_albums").fetchone()["n"]
    assert left == 0, "the refresh did not take its evaluating path"


def _listen_history_connection(library, _monkeypatch):
    with listen_history.listen_history_connection(library.config) as connection:
        connection.execute("select 1")


def _metadata_repair_lease(library, _monkeypatch):
    lease = scan.PostgresScanCacheAdapter(library.config).try_acquire_metadata_repair_lease()
    assert lease is not None
    lease.release()


def _failed_revision_read(library, monkeypatch):
    def fail(_connection):
        raise RuntimeError("revision read failed")

    with monkeypatch.context() as patched:
        patched.setattr(scan, "_load_inventory_mutation_revision", fail)
        with pytest.raises(RuntimeError, match="revision read failed"):
            scan.PostgresScanCacheAdapter(library.config).save_snapshot(
                "unused.json", library.entries, "watcher-repair", 2.0,
            )


SETTERS = {
    "no_setter": lambda _library, _monkeypatch: None,
    "save_snapshot_failed_revision_read": _failed_revision_read,
    "problematic_index_maintenance": _index_maintenance,
    "problematic_index_refresh": _index_refresh,
    "listen_history_connection": _listen_history_connection,
    "metadata_repair_lease": _metadata_repair_lease,
}


def _gallery_refresh_of_a_request(library, connect):
    """What a gallery request without a projection schedules, with that repository's own connect."""
    gallery.ensure_gallery_projection_ready(library.config, connect=connect)


def _final_scan_publication(library, connect):
    scan.PostgresScanCacheAdapter(library.config, connect=connect).save_snapshot(
        "unused.json", library.entries, "watcher-repair", 3.0, rebuild_relation_projection=True,
        observed_library_root_ids={root["id"] for root in library.fixture.roots},
    )


PUBLISHERS = {
    "gallery_refresh_of_a_request": (_gallery_refresh_of_a_request, browse._connect),
    "final_scan_publication": (_final_scan_publication, scan._connect),
}


def _publication(library):
    with isolatedPostgres._connect(library.setup_url) as connection:
        return connection.execute(
            """select current.last_publication_xid::text as state_xid,
                      compatibility.last_publication_xid::text as compatibility_xid,
                      current.initialized_at,
                      library.local_relation_views(current.library_id) as views
               from library.local_relation_projection_state current
               join library.local_relation_compatibility_state compatibility using (library_id)"""
        ).fetchone()


@pytest.mark.parametrize("publisher", PUBLISHERS)
@pytest.mark.parametrize("setter", SETTERS)
def test_the_next_borrower_publishes_both_stamps_in_one_transaction(library, monkeypatch, setter, publisher):
    _store_inventory(library)
    postgres_connections.close_pools()
    _pooled(library)
    SETTERS[setter](library, monkeypatch)
    released_pid, _autocommit = _pooled(library)
    publish, real_connect = PUBLISHERS[publisher]
    borrowed = []

    def connect(url):
        connection = real_connect(url)
        borrowed.append((connection.info.backend_pid, connection.autocommit))
        return connection

    publish(library, connect)

    assert borrowed and borrowed[0][0] == released_pid, "the publisher did not borrow the released connection"
    published = _publication(library)
    assert published is not None, "nothing was published"
    assert published["state_xid"] == published["compatibility_xid"], (
        f"two transactions: state {published['state_xid']}, compatibility {published['compatibility_xid']}; "
        f"borrowed with autocommit {sorted({autocommit for _pid, autocommit in borrowed})}"
    )
    assert published["views"], "the published relation views are not served"


@pytest.fixture
def broken_publication(library):
    library.fixture.seed(*library.entries.values())
    healthy = _publication(library)
    assert healthy["state_xid"] == healthy["compatibility_xid"] and healthy["views"]
    with isolatedPostgres._connect(library.setup_url) as connection:
        connection.execute(
            "update library.local_relation_compatibility_state set last_publication_xid = pg_current_xact_id()"
        )
    broken = _publication(library)
    assert broken["state_xid"] != broken["compatibility_xid"] and broken["views"] is None
    postgres_connections.close_pools()
    return SimpleNamespace(healthy=healthy, broken=broken)


def _startup(library):
    app = SimpleNamespace(config=library.config, library_state={}, logger=_Logger())
    with pytest.raises(RuntimeError, match="requires explicit startup reconciliation: missing_projection"):
        state.ensure_runtime_relation_projection_ready(app)


def _request(library):
    # The relation step of a request's gallery refresh, on that repository's pooled connect.
    with pytest.raises(RuntimeError, match="requires explicit startup reconciliation: missing_projection"):
        relations.ensure_relation_projection_ready(library.config, connect=browse._connect)


def _projected_gallery_request(library):
    # A gallery that is already projected never reaches that step.
    assert gallery.ensure_gallery_projection_ready(library.config, connect=browse._connect) == {"built": 0}


def _pending_publication(library):
    assert scoped.ensure_pending_relation_projection_ready(library.config) == {"initialized": True, "updated": False}


@pytest.mark.parametrize("entry", (_startup, _request, _projected_gallery_request, _pending_publication), ids=lambda entry: entry.__name__[1:])
def test_startup_and_requests_never_rebuild_a_broken_publication(library, broken_publication, monkeypatch, entry):
    def forbid(*_args, **_kwargs):
        pytest.fail("rebuilt the whole library's relations on startup or a request")

    monkeypatch.setattr(relations, "build_relation_views_from_postgres_rows", forbid)
    entry(library)
    assert _publication(library) == broken_publication.broken


def _explicit_initialization(library):
    scoped.initialize_scoped_relation_projection(library.config)


def _explicit_full_scan(library):
    _final_scan_publication(library, scan._connect)


@pytest.mark.parametrize(
    "repair", (_explicit_initialization, _explicit_full_scan), ids=lambda repair: repair.__name__[1:],
)
def test_an_explicit_full_publication_repairs_a_broken_publication(library, broken_publication, repair):
    repair(library)
    repaired = _publication(library)
    assert repaired["state_xid"] == repaired["compatibility_xid"]
    assert repaired["views"] == broken_publication.healthy["views"]
    assert relations.ensure_relation_projection_ready(library.config)["ready"]
