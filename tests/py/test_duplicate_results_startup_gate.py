"""Owner (2026-11-22): the app refuses to start serving a non-empty library whose duplicate
results are not ready.

The in-process cases drive the real lifespan and stop at the first collaborator after the
gate, so no worker ever starts. The process cases run a real uvicorn server, because what a
task scheduler sees (exit code, one line, nothing written) exists only there."""

from __future__ import annotations

import asyncio
import io
import os
from pathlib import Path
import subprocess
import sys
import threading

import pytest

from tests.py.runtime_testing import configure_test_app_paths
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (live fixture)

STEP = "python scripts/prepare_duplicate_results.py"
MIGRATION = "0268_create_album_duplicate_results.sql"
SWITCH = "ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED"
EXIT_CODE = 78
REFUSAL = f"STARTUP REFUSED (exit code {EXIT_CODE}): Album Haven will not start: "
ROOT = Path(__file__).resolve().parents[2]
# The two ways launchers serve: uvicorn.run on the factory, and a Server on a built app.
BY_FACTORY = """import uvicorn
uvicorn.run("music_app:create_asgi_app", factory=True, host="127.0.0.1", port=0)
"""
BY_SERVER = """import asyncio, uvicorn
from music_app import create_asgi_app
config = uvicorn.Config(create_asgi_app(), host="127.0.0.1", port=0, loop="none")
with asyncio.Runner(loop_factory=asyncio.SelectorEventLoop) as runner:
    runner.run(uvicorn.Server(config).serve())
"""


class _PastTheGate(Exception):
    pass


class _Refused(Exception):
    pass


@pytest.fixture
def lifespan(monkeypatch, tmp_path):
    import music_app
    from music_app.services import log_history

    configure_test_app_paths(tmp_path, monkeypatch)
    # conftest switches the index off to keep its backfill away from other tests.
    monkeypatch.setenv(SWITCH, "1")

    def past_the_gate(_config):
        raise _PastTheGate

    def refused(_logger, refusal):
        raise _Refused(str(refusal))

    monkeypatch.setattr(log_history, "resolve_media_host_history_scope", past_the_gate)
    # In process only: the real one ends the process, which the process cases cover.
    monkeypatch.setattr(music_app, "_exit_refusing", refused, raising=False)


@pytest.fixture
def library(watcher_repair_inventory, lifespan, monkeypatch):
    from config import Config

    url = watcher_repair_inventory.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    monkeypatch.setattr(Config, "ALBUM_HAVEN_APP_DATABASE_URL", url)
    monkeypatch.setenv("ALBUM_HAVEN_APP_DATABASE_URL", url)
    return watcher_repair_inventory


def _startup() -> str | None:
    """None when startup goes on to serve; otherwise why it refused."""
    from music_app import create_asgi_app

    app = create_asgi_app()

    async def start():
        async with app.router.lifespan_context(app):
            pass

    try:
        asyncio.run(start())
    except _PastTheGate:
        return None
    except _Refused as refusal:
        return str(refusal)
    raise AssertionError("The lifespan neither refused nor reached its first collaborator.")


def _serve(program: str = BY_FACTORY) -> str:
    """Start a real server and return the one refusal line it must end with."""
    try:
        done = subprocess.run(
            [sys.executable, "-c", program], cwd=ROOT, env=dict(os.environ),
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
        )
    except subprocess.TimeoutExpired:
        pytest.fail("The server did not refuse: it was still running after 60 s.")
    output = done.stdout + done.stderr
    assert done.returncode == EXIT_CODE, output
    lines = [line for line in output.splitlines() if REFUSAL in line]
    assert len(lines) == 1, output
    assert "Traceback" not in output
    for started in ("Application startup complete", "Uvicorn running on"):
        assert started not in output
    return lines[0]


def _seed_album(library):
    library.seed(library.entry("Gate/Album/01.flac", artist="Gate", album="Gate Album"))


def _run_step(library, *arguments) -> int:
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
    from scripts import prepare_duplicate_results

    return prepare_duplicate_results.main(
        list(arguments), stdout=io.StringIO(), stderr=io.StringIO(),
        repository_factory=lambda: PostgresLibraryBrowseRepository(library.config),
    )


def _stored(library):
    import psycopg

    with psycopg.connect(library.runtime_url) as connection:
        return connection.execute(
            """select (select count(*) from library.album_duplicate_results_state),
                      (select count(*) from library.album_duplicate_results)""",
        ).fetchone()


def _whole_database(library):
    import psycopg
    from psycopg import sql

    with psycopg.connect(library.setup_url) as connection:
        tables = connection.execute(
            """select schemaname, tablename from pg_tables
               where schemaname in ('app', 'integration', 'library', 'ops') order by 1, 2""",
        ).fetchall()
        return {
            (schema, table): connection.execute(sql.SQL(
                "select count(*), sum(hashtextextended(t::text, 0)::numeric)::text from {} t"
            ).format(sql.Identifier(schema, table))).fetchone()
            for schema, table in tables
        }


@pytest.mark.parametrize("browse_only", [False, True])
def test_live_startup_refuses_a_library_whose_duplicate_results_are_not_ready(library, monkeypatch, browse_only):
    from config import Config

    monkeypatch.setattr(Config, "SHARED_LIBRARY_BROWSE_ONLY", browse_only, raising=False)
    _seed_album(library)

    refusal = _startup()

    assert refusal and STEP in refusal, refusal
    assert _stored(library) == (0, 0), "The gate only reads: startup never fills."


def test_live_startup_refuses_after_a_failed_step(library, monkeypatch):
    from music_app.services import problematic_index

    _seed_album(library)

    def fail(*_arguments):
        raise RuntimeError("evaluation failed")

    monkeypatch.setattr(problematic_index, "_duplicate_result_rows", fail)
    assert _run_step(library) == 1

    refusal = _startup()

    assert refusal and STEP in refusal, refusal
    assert _stored(library)[1] == 0


@pytest.mark.parametrize("populated", [False, True])
def test_live_startup_refuses_a_database_without_the_migration(library, populated):
    import psycopg

    if populated:
        _seed_album(library)
    with psycopg.connect(library.setup_url) as connection:
        connection.execute("drop table library.album_duplicate_results, library.album_duplicate_results_state")

    refusal = _startup()

    assert refusal and MIGRATION in refusal, refusal


def test_live_startup_refuses_results_of_another_version(library, monkeypatch):
    from music_app.services import problematic_index

    _seed_album(library)
    assert _run_step(library) == 0
    monkeypatch.setattr(problematic_index, "DUPLICATE_RESULTS_VERSION", "next")

    refusal = _startup()

    assert refusal and STEP in refusal, refusal


def test_live_startup_refuses_ready_results_the_switch_keeps_cards_from_reading(library, monkeypatch):
    monkeypatch.setenv(SWITCH, "0")
    assert _startup() is None, "An empty library has no card to get wrong."
    _seed_album(library)
    assert _run_step(library) == 0

    refusal = _startup()

    assert refusal and SWITCH in refusal, refusal


@pytest.mark.parametrize("browse_only", [False, True])
def test_live_startup_serves_an_empty_library_until_it_holds_unfilled_albums(library, monkeypatch, browse_only):
    from config import Config

    monkeypatch.setattr(Config, "SHARED_LIBRARY_BROWSE_ONLY", browse_only, raising=False)
    assert _startup() is None
    assert _stored(library) == (0, 0)
    _seed_album(library)

    refusal = _startup()

    assert refusal and STEP in refusal, refusal


def test_live_startup_serves_once_ready_and_again_after_a_restart(library, monkeypatch):
    from music_app.services import problematic_index

    _seed_album(library)
    assert _run_step(library) == 0
    filled = _stored(library)

    for name in ("_backfill", "_backfill_duplicate_results"):
        monkeypatch.setattr(problematic_index, name, lambda *_args: pytest.fail("startup never fills"))
    assert _startup() is None
    # A restarted process has seen nothing.
    for seen in ("_READY", "_DUPLICATES_READY", "_WARMED"):
        monkeypatch.setattr(problematic_index, seen, set())
    assert _startup() is None
    assert _stored(library) == filled


def test_live_startup_waits_for_a_database_that_comes_up_late(library, monkeypatch, caplog):
    import psycopg
    from music_app.services import problematic_index

    _seed_album(library)
    assert _run_step(library) == 0
    read, attempts = problematic_index._serving_state, []

    def late(*arguments):
        attempts.append(1)
        if len(attempts) < 3:
            raise psycopg.OperationalError("the database system is starting up")
        return read(*arguments)

    monkeypatch.setattr(problematic_index, "_serving_state", late)
    monkeypatch.setattr(problematic_index, "_DATABASE_RETRY_SECONDS", 0)

    assert _startup() is None
    assert len(attempts) == 3
    assert caplog.text.count("Waiting for database ") == 2


def test_live_three_refusals_in_a_row_write_nothing_and_leave_the_fill_free(library):
    _seed_album(library)
    before = _whole_database(library)

    for program in (BY_FACTORY, BY_SERVER, BY_FACTORY):
        assert STEP in _serve(program)

    assert _whole_database(library) == before
    assert _run_step(library) == 0
    assert _startup() is None


@pytest.mark.parametrize("phase", ["fill", "rebuild", "changed albums"])
def test_live_a_restart_during_the_fill_refuses_and_the_fill_finishes(library, monkeypatch, phase):
    import psycopg
    from music_app.services import problematic_index

    _seed_album(library)
    paused_in = "_duplicate_result_rows"
    if phase == "changed albums":
        # Results are already ready while the step's last pass runs.
        assert _run_step(library) == 0
        library.seed(library.entry("Gate/Later/01.flac", artist="Gate", album="Later Album"))
        paused_in = "_drain"
    if phase == "rebuild":
        assert _run_step(library) == 0
        # The slow part of a rebuild can come before the duplicate results' own pass.
        with psycopg.connect(library.setup_url) as connection:
            connection.execute("delete from library.problematic_index_state")
        paused_in = "_index_rows"
    work = getattr(problematic_index, paused_in)
    filling, finish, exit_codes = threading.Event(), threading.Event(), []

    def paused(*arguments, **options):
        filling.set()
        assert finish.wait(180)
        return work(*arguments, **options)

    monkeypatch.setattr(problematic_index, paused_in, paused)
    arguments = ["--rebuild"] if phase == "rebuild" else []
    fill = threading.Thread(target=lambda: exit_codes.append(_run_step(library, *arguments)))
    fill.start()
    try:
        assert filling.wait(30), "The fill never started."
        before = _whole_database(library)
        refusal = _serve()
        assert _whole_database(library) == before
    finally:
        finish.set()
        fill.join(60)

    assert STEP in refusal
    assert exit_codes == [0]
    assert _startup() is None


@pytest.mark.usefixtures("lifespan")
def test_an_unreachable_database_refuses_by_name_after_the_limit(monkeypatch):
    monkeypatch.setenv(
        "ALBUM_HAVEN_APP_DATABASE_URL",
        "postgresql://album_haven_app:not-for-logs@127.0.0.1:9/album_haven_absent",
    )

    line = _serve(
        "from music_app.services import problematic_index\n"
        "problematic_index.DATABASE_WAIT_SECONDS = 1\n" + BY_FACTORY
    )

    assert "album_haven_absent on 127.0.0.1:9" in line
    assert STEP not in line
    assert "not-for-logs" not in line
