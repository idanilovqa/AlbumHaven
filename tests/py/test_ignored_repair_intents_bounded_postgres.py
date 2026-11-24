"""Ignore and Unignore stay bounded while a publication holds the library (deadlock part 3, 6.5, 2026-11-24).

One synthetic library is seeded at two sizes (20 and 200 unrelated albums). The real app answers the Ignore and
Unignore routes while another transaction holds the inventory publication lock, as a scan or save does. Each
request's statements and its wait for that lock are counted: the wait stays under a second and nothing grows
with the library. The drain that applies the kept intents afterwards reads and writes only those intents.
"""
import contextlib
import time
from pathlib import Path

import psycopg
import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.bounded_interactions import OperationCounts, measure_scale_pair
from tests.py.test_isolated_postgres_live import (
    _dedicated_database_urls_or_skip,
    _drop_application_schemas,
    _finish_live_startup,
)

SIZES = (20, 200)
HOLD_INVENTORY_PUBLICATION = "select pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'))"
PUBLICATION_LOCK = "hashtext('album-haven:local-inventory-publication')"


def _entry(music_dir, relative, album, number=1):
    path = Path(music_dir) / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"media fixture")
    return {"path": str(path), "mtime": path.stat().st_mtime, "size": path.stat().st_size, "album": album,
            "album_artist": "Owner", "artist": "Owner", "title": f"{album} song {number}", "track_number": number,
            "disc_number": 1, "duration_seconds": 180, "year": 2026, "edition": "", "album_rating": 0,
            "library_root_id": "intents-main", "library_root_category": "main_library", "exception_type": None}


@pytest.fixture
def seeded_app(monkeypatch, tmp_path):
    import config as app_config
    from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
    from tests.py.asgi_testing import create_test_asgi_app

    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)

    def seed(unrelated):
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        monkeypatch.setenv("ALBUM_HAVEN_APP_DATABASE_URL", runtime_url)
        monkeypatch.setattr(app_config.Config, "ALBUM_HAVEN_APP_DATABASE_URL", runtime_url)
        app = create_test_asgi_app(tmp_path / f"app-{unrelated}", monkeypatch)
        config = app.state.config
        config["ALBUM_HAVEN_APP_DATABASE_URL"] = runtime_url
        music_dir = Path(config["MUSIC_DIR"])
        PostgresLibraryRootSettingsStore(config).save_settings({
            "main_library_roots": [{"id": "intents-main", "path": str(music_dir), "layout_mode": "artist"}],
            "hoarding_library_roots": [], "new_arrivals_roots": []})
        entries = [_entry(music_dir, "Owner/Ignored Album/01.flac", "Ignored Album")]
        entries += [_entry(music_dir, f"Other {index:05d}/Album {index:05d}/01.flac", f"Album {index:05d}")
                    for index in range(unrelated)]
        PostgresScanCacheAdapter(config, connect=isolatedPostgres._connect).save_snapshot(
            Path("unused-intents.json"), {entry["path"]: entry for entry in entries}, "intents-bounded", 1.0,
            observed_library_root_ids={"intents-main"})
        _finish_live_startup(config)
        return app, config

    try:
        yield seed, setup_url
    finally:
        isolatedPostgres.reset_application_tables(setup_url)


@contextlib.contextmanager
def _counted(counts):
    """Every statement the app's connections run, and the time each spends on the publication lock."""
    original = psycopg.Connection.execute

    def execute(self, query, params=None, *args, **kwargs):
        started = time.perf_counter()
        try:
            return original(self, query, params, *args, **kwargs)
        finally:
            counts.count("sql_statements")
            if PUBLICATION_LOCK in str(query):
                counts.count("lock_wait_ms", (time.perf_counter() - started) * 1000)

    psycopg.Connection.execute = execute
    try:
        yield counts
    finally:
        psycopg.Connection.execute = original


@contextlib.contextmanager
def _held_publication(setup_url):
    """A scan's or save's publication: the inventory lock, held by another transaction until the block ends."""
    connection = psycopg.connect(setup_url)
    try:
        connection.execute(HOLD_INVENTORY_PUBLICATION)
        yield
    finally:
        connection.rollback()
        connection.close()


def _album_problem(app):
    """The seeded album's first album-scope problem, as Problematic Files offers it to Ignore."""
    from tests.py.asgi_testing import decode_json, run_asgi_request

    status, _headers, body = run_asgi_request(app, "GET", "/utilities/problematic-files")
    assert status == 200, body
    item = next(item for item in decode_json(body)["items"] if item["name"] == "Ignored Album")
    status, _headers, body = run_asgi_request(app, "GET", "/utilities/problematic-files/detail",
                                              query={"album_key": item["key"]})
    assert status == 200, body
    row = decode_json(body)["album_problem_rows"][0]
    return {"row_key": row["row_key"], "scope": "album", "album_key": row["album_key"]}


def _ignore(app, problem):
    from tests.py.asgi_testing import decode_json, run_asgi_request

    status, _headers, body = run_asgi_request(app, "POST", "/utilities/rules/problem-ignores",
                                              json_body={"items": [problem]})
    assert status == 200, body
    return decode_json(body)["status"]


def _unignore(app, problem):
    from tests.py.asgi_testing import decode_json, run_asgi_request

    status, _headers, body = run_asgi_request(app, "POST", "/utilities/rules/problem-ignores/revert",
                                              json_body={"row_key": problem["row_key"]})
    assert status == 200, body
    return decode_json(body)["status"]


# The routes' budgets (tests/ci/bounded-interactions.json): a held publication is waited on for at most
# PUBLICATION_WAIT_MS (500), so a request's wait stays under a second, and the statements do not grow.
ROUTES = {
    "py:routes/api_wave_a_asgi_routes.py#create_problem_ignores": (_ignore, {"sql_statements": 40, "lock_wait_ms": 1000}),
    "py:routes/api_wave_a_asgi_routes.py#revert_problem_ignore": (_unignore, {"sql_statements": 20, "lock_wait_ms": 1000}),
}


def test_live_ignore_routes_answer_pending_within_a_second_during_a_held_publication(seeded_app):
    from music_app.services import ignored_repair_intents

    seed, setup_url = seeded_app
    for interaction_id, (route, budgets) in ROUTES.items():

        def run(unrelated, route=route):
            app, _config = seed(unrelated)
            problem = _album_problem(app)
            if route is _unignore:
                assert _ignore(app, problem) == "applied"
            counts = OperationCounts()
            with _held_publication(setup_url), _counted(counts):
                assert route(app, problem) == "pending"
            ignored_repair_intents.wait_for_background_work()
            return counts

        measure_scale_pair(interaction_id=interaction_id, small=SIZES[0], large=SIZES[1], run=run,
                           budgets=budgets, growth=("sql_statements", 0))


def test_live_drain_applies_only_the_kept_intents(seeded_app, monkeypatch):
    from music_app.services import ignored_repair_intents

    seed, setup_url = seeded_app
    # This drain alone applies the two kept intents.
    monkeypatch.setattr(ignored_repair_intents, "queue_drain", lambda _config: None)

    def run(unrelated):
        app, config = seed(unrelated)
        problem = _album_problem(app)
        with _held_publication(setup_url):
            assert _ignore(app, problem) == "pending"
            assert _unignore(app, problem) == "pending"
        counts = OperationCounts()
        with _counted(counts):
            assert ignored_repair_intents.drain(config) == 2
        return counts

    measure_scale_pair(
        interaction_id="py:services/ignored_repair_intents.py#_drain_queued",
        small=SIZES[0], large=SIZES[1], run=run,
        budgets={"sql_statements": 12}, growth=("sql_statements", 0),
    )
