"""Ignore and Unignore stay bounded while a publication holds the library (deadlock part 3, 6.5, 2026-11-24).

One synthetic library is seeded at two sizes (20 and 200 unrelated albums). The real app answers the Ignore and
Unignore routes while another transaction holds the inventory publication lock, as a scan or save does. Each
request's statements and its wait for that lock are counted: the wait stays under a second and nothing grows
with the library. The drain that applies the kept intents afterwards reads and writes only those intents.
"""
import contextlib
import threading
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
DRAIN_THREAD = "albumhaven-ignored-repair-intents"


def _entry(music_dir, relative, album, number=1, year=2026):
    path = Path(music_dir) / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"media fixture")
    return {"path": str(path), "mtime": path.stat().st_mtime, "size": path.stat().st_size, "album": album,
            "album_artist": "Owner", "artist": "Owner", "title": f"{album} song {number}", "track_number": number,
            "disc_number": 1, "duration_seconds": 180, "year": year, "edition": "", "album_rating": 0,
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
        # The page case's albums sort first: one with two problems (no cover, no year), one with one.
        entries += [_entry(music_dir, "Owner/A Kept Album/01.flac", "A Kept Album", year=None),
                    _entry(music_dir, "Owner/A Pending Album/01.flac", "A Pending Album")]
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
    """Every statement the app's connections run for the measured work, and the time each spends on the
    publication lock. The background drain a pending Ignore queues is its own interaction (measured below):
    its statements are left out, even when one ends after the request did."""
    original = psycopg.Connection.execute

    def execute(self, query, params=None, *args, **kwargs):
        if threading.current_thread().name.startswith(DRAIN_THREAD):
            return original(self, query, params, *args, **kwargs)
        started = time.perf_counter()
        cursor = None
        try:
            cursor = original(self, query, params, *args, **kwargs)
            return cursor
        finally:
            counts.count("sql_statements")
            if PUBLICATION_LOCK in str(query):
                counts.count("lock_wait_ms", (time.perf_counter() - started) * 1000)
            if cursor is not None and "select intents.id" in str(query):
                counts.count("pending_intent_rows", max(cursor.rowcount, 0))

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
    "py:routes/api_wave_a_asgi_routes.py#create_problem_ignores": (_ignore, {"sql_statements": 11, "lock_wait_ms": 1000}),
    "py:routes/api_wave_a_asgi_routes.py#revert_problem_ignore": (_unignore, {"sql_statements": 9, "lock_wait_ms": 1000}),
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
        budgets={"sql_statements": 6}, growth=("sql_statements", 0),
    )


def test_live_rules_route_lays_pending_intents_over_its_page_without_growing(seeded_app, monkeypatch):
    """6.5's overlay proof through the Rules route: with an Ignore stored, another pending and a pending Unignore of
    the stored one, the real route shows the pending ones as made. Its statements do not grow with the library."""
    from music_app.services import ignored_repair_intents
    from tests.py.asgi_testing import decode_json, run_asgi_request

    seed, setup_url = seeded_app
    # The intents stay pending while the route reads them.
    monkeypatch.setattr(ignored_repair_intents, "queue_drain", lambda _config: None)

    def run(unrelated):
        app, _config = seed(unrelated)
        stored = _album_problem(app)
        assert _ignore(app, stored) == "applied"
        pending = {"row_key": f"{stored['album_key']}::problem-album::missing-year", "scope": "album",
                   "album_key": stored["album_key"]}
        with psycopg.connect(setup_url) as connection:
            # A second rule kept back by a publication, as the bounded write records it.
            connection.execute(
                """insert into library.ignored_repair_intents (library_id, action, repair_keys, album_keys)
                   select id, 'upsert', array[%s], jsonb_build_object(%s::text, %s::text)
                   from library.libraries where name = 'Local Library'""",
                (pending["row_key"], pending["row_key"], pending["album_key"]))
        # A rule whose file is no longer in the library (owner, 11-24), stored as any rule is.
        gone = "C:/No Longer Here/03 Song.flac::problem-file::missing-year"
        from music_app.services.rule_state_postgres import RuleStatePostgresAdapter

        assert RuleStatePostgresAdapter(_config).upsert_ignored_repair_keys({gone}) == "applied"
        with _held_publication(setup_url):
            assert _unignore(app, stored) == "pending"
        counts = OperationCounts()
        with _counted(counts):
            status, _headers, body = run_asgi_request(app, "GET", "/utilities/rules")
        assert status == 200, body
        rule = next(rule for rule in decode_json(body)["rules"] if rule.get("key") == "problem-ignores")
        items = {item["row_key"]: item for item in rule.get("items") or []}
        shown = set(items)
        assert pending["row_key"] in shown and stored["row_key"] not in shown
        # The gone target is told in the same read; the present one is not.
        assert items[gone]["target_missing"] is True and items[gone]["missing_name"] == "No Longer Here/03 Song.flac"
        assert items[pending["row_key"]]["target_missing"] is False
        counts.count("returned_rows", len(shown))
        return counts

    measure_scale_pair(
        interaction_id="py:routes/api_wave_a_asgi_routes.py#utility_rules",
        small=SIZES[0], large=SIZES[1], run=run,
        budgets={"sql_statements": 0, "returned_rows": 1}, growth=("sql_statements", 0),
    )


def _page(app, limit="50"):
    from tests.py.asgi_testing import decode_json, run_asgi_request

    status, _headers, body = run_asgi_request(app, "GET", "/utilities/problematic-files", query={"limit": limit})
    assert status == 200, body
    return {item["name"]: item for item in decode_json(body)["items"]}


def _album_rows(app, item_key):
    from tests.py.asgi_testing import decode_json, run_asgi_request

    status, _headers, body = run_asgi_request(app, "GET", "/utilities/problematic-files/detail",
                                              query={"album_key": item_key})
    assert status == 200, body
    return {row["reason"]: {"row_key": row["row_key"], "scope": "album", "album_key": row["album_key"]}
            for row in decode_json(body)["album_problem_rows"]}


def test_live_problematic_files_page_lays_pending_intents_over_its_page_without_growing(seeded_app, monkeypatch):
    """6.5's overlay proof through the Problematic Files page (problematic_index.read_page): with an Ignore stored,
    a pending Unignore of it and a pending Ignore of another album's only problem, the real page shows both as
    made. Its statements do not grow with the library."""
    from music_app.services import ignored_repair_intents, problematic_index
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    seed, setup_url = seeded_app
    monkeypatch.setattr(ignored_repair_intents, "queue_drain", lambda _config: None)

    def run(unrelated):
        app, config = seed(unrelated)
        repository = PostgresLibraryBrowseRepository(config)
        problematic_index.prepare_for_serving(repository)
        page = _page(app)
        kept = _album_rows(app, page["A Kept Album"]["key"])
        pending = _album_rows(app, page["A Pending Album"]["key"])
        assert "Missing cover art" in kept and len(kept) >= 2 and list(pending) == ["Missing cover art"]
        assert _ignore(app, kept["Missing cover art"]) == "applied"
        problematic_index.prepare_for_serving(repository)
        assert "Missing cover art" not in _page(app)["A Kept Album"]["problem_reasons"]
        with _held_publication(setup_url):
            assert _unignore(app, kept["Missing cover art"]) == "pending"
            assert _ignore(app, pending["Missing cover art"]) == "pending"
        counts = OperationCounts()
        with _counted(counts):
            shown = _page(app)
        assert "Missing cover art" in shown["A Kept Album"]["problem_reasons"]
        assert "A Pending Album" not in shown
        counts.count("returned_rows", len(shown))
        return counts

    measure_scale_pair(
        interaction_id="py:routes/api_read_asgi_routes.py#utilities_problematic_files",
        small=SIZES[0], large=SIZES[1], run=run,
        budgets={"sql_statements": 0}, growth=("sql_statements", 0),
        # Calibration only: the registration of this proof waits for 6.5 (one entrypoint, one testIdentity).
        registry={"interactions": [{
            "id": "py:routes/api_read_asgi_routes.py#utilities_problematic_files",
            "cardinalities": {"small": SIZES[0], "production": SIZES[1]},
            "budgets": {"sql_statements": 0}, "growth": {"metric": "sql_statements", "largeMinusSmallMax": 0},
        }]},
    )


def test_live_detail_reads_only_its_own_pending_intents_however_many_others_wait(seeded_app, monkeypatch):
    """6.5 (11-24): Album Details reads the pending intents its own rows name (and any pending replacement of
    every rule), never every pending intent: with 2 kept for this album and 50 for others, it reads 2."""
    from music_app.services import ignored_repair_intents, rule_state_postgres
    from tests.py.asgi_testing import decode_json, run_asgi_request

    seed, setup_url = seeded_app
    monkeypatch.setattr(ignored_repair_intents, "queue_drain", lambda _config: None)
    # Each held write gives up after 50 ms instead of 500: the case makes 52 of them.
    monkeypatch.setattr(rule_state_postgres, "PUBLICATION_WAIT_MS", 50)
    app, _config = seed(SIZES[1])
    # The route's largest page: the two named albums and the 50 others it needs all fit.
    page = _page(app, limit="200")
    kept = _album_rows(app, page["A Kept Album"]["key"])
    others = [_album_rows(app, page[f"Album {index:05d}"]["key"])["Missing cover art"] for index in range(50)]
    second = next(reason for reason in kept if reason != "Missing cover art")
    assert _ignore(app, kept["Missing cover art"]) == "applied"
    with _held_publication(setup_url):
        assert _unignore(app, kept["Missing cover art"]) == "pending"
        assert _ignore(app, kept[second]) == "pending"
        for problem in others:
            assert _ignore(app, problem) == "pending"
    counts = OperationCounts()
    with _counted(counts):
        status, _headers, body = run_asgi_request(app, "GET", "/utilities/problematic-files/detail",
                                                  query={"album_key": page["A Kept Album"]["key"]})
    assert status == 200, body
    reasons = {row["reason"] for row in decode_json(body)["album_problem_rows"]}
    assert "Missing cover art" in reasons and second not in reasons
    assert counts.pending_intent_rows == 2, counts
