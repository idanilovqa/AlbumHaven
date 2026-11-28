"""Warm request pools on a throwaway database (11-25): each request-path pool keeps its minimum open past the
idle timeout, and the start-up warm-up runs every workload's first-request reads on each kept connection,
read-only and without a failure, before the first request borrows one."""
import collections
import contextlib
import logging
import time
from pathlib import Path

import psycopg
import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import (
    _dedicated_database_urls_or_skip,
    _drop_application_schemas,
    _finish_live_startup,
)

_WARM_WORKLOADS = ("browse", "default", "cover-references", "cover_inventory")


def _entry(music_dir, relative, number):
    path = Path(music_dir) / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"media fixture")
    return {"path": str(path), "mtime": path.stat().st_mtime, "size": path.stat().st_size, "album": "Warm Album",
            "album_artist": "Owner", "artist": "Owner", "title": f"Song {number}", "track_number": number,
            "disc_number": 1, "duration_seconds": 180, "year": 2026, "edition": "", "album_rating": 0,
            "library_root_id": "warm-main", "library_root_category": "main_library", "exception_type": None}


@pytest.fixture
def warm_app_config(monkeypatch, tmp_path):
    import config as app_config
    from music_app.services import postgres_connections
    from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
    from tests.py.asgi_testing import create_test_asgi_app

    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    _drop_application_schemas(setup_url)
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    monkeypatch.setenv("ALBUM_HAVEN_APP_DATABASE_URL", runtime_url)
    monkeypatch.setattr(app_config.Config, "ALBUM_HAVEN_APP_DATABASE_URL", runtime_url)
    app = create_test_asgi_app(tmp_path / "app", monkeypatch)
    config = app.state.config
    config["ALBUM_HAVEN_APP_DATABASE_URL"] = runtime_url
    music_dir = Path(config["MUSIC_DIR"])
    PostgresLibraryRootSettingsStore(config).save_settings({
        "main_library_roots": [{"id": "warm-main", "path": str(music_dir), "layout_mode": "artist"}],
        "hoarding_library_roots": [], "new_arrivals_roots": []})
    entries = [_entry(music_dir, f"Owner/Warm Album/{number:02d}.flac", number) for number in (1, 2, 3)]
    PostgresScanCacheAdapter(config, connect=isolatedPostgres._connect).save_snapshot(
        Path("unused-warm.json"), {entry["path"]: entry for entry in entries}, "warm-root-identity", 1.0,
        observed_library_root_ids={"warm-main"})
    _finish_live_startup(config)
    postgres_connections.close_pools()
    try:
        yield config, setup_url, runtime_url
    finally:
        postgres_connections.close_pools()
        isolatedPostgres.reset_application_tables(setup_url)


@contextlib.contextmanager
def _statements_by_connection():
    """Every statement each app connection executes, by connection."""
    seen = collections.defaultdict(list)
    original = psycopg.Connection.execute

    def execute(self, query, params=None, *args, **kwargs):
        seen[id(self)].append(query if isinstance(query, str) else repr(query))
        return original(self, query, params, *args, **kwargs)

    psycopg.Connection.execute = execute
    try:
        yield seen
    finally:
        psycopg.Connection.execute = original


def _app_backends(setup_url, runtime_url):
    role = runtime_url.split("//", 1)[1].split("@", 1)[0]
    with isolatedPostgres._connect(setup_url) as connection:
        return connection.execute(
            "select count(*) as count from pg_stat_activity where usename = %s and datname = current_database()",
            (role,),
        ).fetchone()["count"]


def test_live_warm_up_runs_every_first_request_read_on_each_kept_connection_before_the_first_request(
    warm_app_config, monkeypatch, caplog,
):
    from music_app.services import postgres_connections
    from music_app.services.album_cover_candidate_snapshots_postgres import _get_for_album_context_sql
    from music_app.services.library_browse_postgres import _cover_state_rows_by_track_paths_sql
    from music_app.services.postgres_first_requests import first_request_warmers

    config, setup_url, runtime_url = warm_app_config
    monkeypatch.setattr(postgres_connections, "_MAX_IDLE_SECONDS", 0.2)
    caplog.set_level(logging.DEBUG, logger="music_app.services.postgres_first_requests")
    caplog.set_level(logging.WARNING, logger="music_app.services.postgres_connections")

    with _statements_by_connection() as executed:
        postgres_connections.prewarm_connection_pool(runtime_url, warmers=first_request_warmers(config))
        pools = {workload: postgres_connections._pools[(runtime_url, workload)] for workload in _WARM_WORKLOADS}
        kept = {workload: list(pool._pool) for workload, pool in pools.items()}

    assert not [record.getMessage() for record in caplog.records], "every warm-up read succeeds read-only"
    listed = {
        "browse": _cover_state_rows_by_track_paths_sql(),
        "default": _get_for_album_context_sql(),
        "cover-references": "select library_id, private_path, kind, reference from library.cover_references",
        "cover_inventory": "from library.local_cover_inventory_contexts",
    }
    for workload, connections in kept.items():
        assert len(connections) >= postgres_connections.POOL_MIN_CONNECTIONS
        runs = [executed[id(connection)] for connection in connections]
        for statements in runs:
            assert any(listed[workload] in statement for statement in statements), (workload, statements)

    # The first request borrows a connection that already ran its reads.
    with postgres_connections.pooled_connection(runtime_url, workload="browse") as first_request:
        assert id(first_request) in {id(connection) for connection in kept["browse"]}

    # Idle past several idle periods: every request pool still holds its minimum, and nothing more.
    time.sleep(1.5)
    assert {workload: pool.get_stats()["pool_size"] for workload, pool in pools.items()} == dict.fromkeys(
        _WARM_WORKLOADS, postgres_connections.POOL_MIN_CONNECTIONS
    )
    assert _app_backends(setup_url, runtime_url) == len(_WARM_WORKLOADS) * postgres_connections.POOL_MIN_CONNECTIONS
