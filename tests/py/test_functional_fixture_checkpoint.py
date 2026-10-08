from __future__ import annotations

import importlib.util
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest
import psycopg

from tests.e2e.support import isolatedPostgres
from tests.py.test_gallery_projection_mutations_live import gallery_inventory
from tests.py.test_isolated_postgres_live import watcher_repair_inventory


REPO_ROOT = Path(__file__).resolve().parents[2]
CHECKPOINT_PATH = REPO_ROOT / "scripts" / "ci" / "functional-fixture-checkpoint.py"


def _load_checkpoint():
    assert CHECKPOINT_PATH.is_file(), "functional fixture checkpoint module is required"
    spec = importlib.util.spec_from_file_location("functional_fixture_checkpoint", CHECKPOINT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Transaction:
    def __init__(self, events: list[str]):
        self.events = events

    def __enter__(self):
        self.events.append("begin")
        return self

    def __exit__(self, exc_type, _exc, _traceback):
        self.events.append("rollback" if exc_type else "commit")
        return False


class _Connection:
    def __init__(self):
        self.events: list[str] = []

    def transaction(self):
        return _Transaction(self.events)


@pytest.mark.parametrize(
    "database_url",
    [
        "postgresql://album_haven_migrator_job@db.example/album_haven_ci_job",
        "postgresql://album_haven_migrator_job@localhost/album_haven_core",
        "postgresql://album_haven_migrator_other@localhost/album_haven_ci_job",
        "postgresql://album_haven_migrator_job:secret@localhost/album_haven_ci_job",
        "postgresql://album_haven_migrator_job@localhost/album_haven_ci_job?host=db.example",
        "mysql://album_haven_migrator_job@localhost/album_haven_ci_job",
    ],
)
def test_checkpoint_rejects_non_ci_database_authority(database_url):
    checkpoint = _load_checkpoint()

    with pytest.raises(ValueError):
        checkpoint.validate_database_url(database_url)


def test_checkpoint_accepts_exact_loopback_suffix_coupled_migrator():
    checkpoint = _load_checkpoint()

    assert checkpoint.validate_database_url(
        "postgresql://album_haven_migrator_job_17@127.0.0.1/album_haven_ci_job_17"
    ).endswith("/album_haven_ci_job_17")


def test_dependency_order_places_referenced_tables_before_dependents():
    checkpoint = _load_checkpoint()
    tables = (("app", "accounts"), ("library", "libraries"), ("library", "local_albums"))
    dependencies = {
        ("library", "libraries"): {("app", "accounts")},
        ("library", "local_albums"): {("library", "libraries")},
    }

    assert checkpoint.dependency_order(tables, dependencies) == list(tables)


def test_dependency_order_rejects_cycles():
    checkpoint = _load_checkpoint()
    tables = (("library", "local_albums"), ("library", "local_tracks"))

    with pytest.raises(ValueError, match="cycle"):
        checkpoint.dependency_order(
            tables,
            {
                ("library", "local_albums"): {("library", "local_tracks")},
                ("library", "local_tracks"): {("library", "local_albums")},
            },
        )


def test_capture_checkpoint_is_one_transaction_and_records_exact_owned_tables(monkeypatch):
    checkpoint = _load_checkpoint()
    connection = _Connection()
    tables = (("app", "accounts"), ("library", "libraries"))
    captured: list[tuple[str, str]] = []
    monkeypatch.setattr(checkpoint, "owned_application_tables", lambda _connection: tables)
    monkeypatch.setattr(checkpoint, "create_checkpoint_schema", lambda _connection: captured.append(("schema", "created")))
    monkeypatch.setattr(checkpoint, "capture_table", lambda _connection, table: captured.append(table))
    monkeypatch.setattr(checkpoint, "capture_sequences", lambda _connection, owned: captured.append(("sequences", str(len(owned)))))
    monkeypatch.setattr(checkpoint, "record_inventory", lambda _connection, owned: captured.append(("inventory", str(len(owned)))))
    monkeypatch.setattr(
        checkpoint,
        "verify_checkpoint",
        lambda _connection, expected_tables=None: captured.append(
            ("verified", str(len(expected_tables or ())))
        ),
    )

    checkpoint.capture_checkpoint(connection)

    assert connection.events == ["begin", "commit"]
    assert captured == [
        ("schema", "created"),
        ("app", "accounts"),
        ("library", "libraries"),
        ("sequences", "2"),
        ("inventory", "2"),
        ("verified", "2"),
    ]


def test_restore_checkpoint_is_transactional_and_verifies_after_sequences(monkeypatch):
    checkpoint = _load_checkpoint()
    connection = _Connection()
    tables = (("app", "accounts"), ("library", "libraries"))
    events: list[str] = []
    monkeypatch.setattr(checkpoint, "owned_application_tables", lambda _connection: tables)
    monkeypatch.setattr(checkpoint, "checkpoint_inventory", lambda _connection: tables)
    monkeypatch.setattr(checkpoint, "table_dependencies", lambda _connection, _tables: {tables[1]: {tables[0]}})
    monkeypatch.setattr(checkpoint, "suspend_gallery_restore_triggers", lambda *_args: nullcontext())
    monkeypatch.setattr(checkpoint, "truncate_application_tables", lambda _connection, _tables: events.append("truncate"))
    monkeypatch.setattr(checkpoint, "restore_table", lambda _connection, table: events.append(f"restore:{table[0]}.{table[1]}"))
    monkeypatch.setattr(checkpoint, "restore_sequences", lambda _connection: events.append("sequences"))
    monkeypatch.setattr(checkpoint, "analyze_application_tables", lambda _connection, _tables: events.append("analyze"))
    monkeypatch.setattr(checkpoint, "verify_checkpoint", lambda _connection, expected_tables=None: events.append("verify"))

    checkpoint.restore_checkpoint(connection)

    assert connection.events == ["begin", "commit"]
    assert events == [
        "truncate",
        "restore:app.accounts",
        "restore:library.libraries",
        "sequences",
        "analyze",
        "verify",
    ]


def test_analyze_application_tables_refreshes_every_restored_table():
    checkpoint = _load_checkpoint()
    statements = []

    class Connection:
        @staticmethod
        def execute(statement):
            statements.append(statement.as_string(None))

    checkpoint.analyze_application_tables(
        Connection(),
        (("app", "accounts"), ("library", "local_albums")),
    )

    assert statements == [
        'ANALYZE "app"."accounts"',
        'ANALYZE "library"."local_albums"',
    ]


def test_restore_checkpoint_rolls_back_when_a_table_restore_fails(monkeypatch):
    checkpoint = _load_checkpoint()
    connection = _Connection()
    tables = (("app", "accounts"),)
    monkeypatch.setattr(checkpoint, "owned_application_tables", lambda _connection: tables)
    monkeypatch.setattr(checkpoint, "checkpoint_inventory", lambda _connection: tables)
    monkeypatch.setattr(checkpoint, "table_dependencies", lambda _connection, _tables: {})
    monkeypatch.setattr(checkpoint, "suspend_gallery_restore_triggers", lambda *_args: nullcontext())
    monkeypatch.setattr(checkpoint, "truncate_application_tables", lambda _connection, _tables: None)
    monkeypatch.setattr(
        checkpoint,
        "restore_table",
        lambda _connection, _table: (_ for _ in ()).throw(RuntimeError("copy failed")),
    )

    with pytest.raises(RuntimeError, match="copy failed"):
        checkpoint.restore_checkpoint(connection)

    assert connection.events == ["begin", "rollback"]


def test_trigger_suppression_rejects_non_fixture_identity_before_sql():
    checkpoint = _load_checkpoint()
    connection = SimpleNamespace(info=SimpleNamespace(user='album_haven_migrator', host='localhost', dbname='album_haven_core'))
    with pytest.raises(ValueError, match='forbidden'):
        with checkpoint.suspend_gallery_restore_triggers(connection, [('library', 'local_albums')]):
            pytest.fail('production authority must never enter restore suppression')


def _gallery_trigger_modes(connection):
    return connection.execute("""
        select n.nspname, c.relname, t.tgname, t.tgenabled
        from pg_trigger t join pg_class c on c.oid=t.tgrelid
        join pg_namespace n on n.oid=c.relnamespace
        where t.tgfoid='library.invalidate_gallery_projection_statement()'::regprocedure
        order by n.nspname,c.relname,t.tgname
    """).fetchall()


@pytest.fixture
def gallery_trigger_mode_cleanup(gallery_inventory):
    with psycopg.connect(gallery_inventory.setup_url) as connection:
        original_modes = _gallery_trigger_modes(connection)
    try:
        yield gallery_inventory
    finally:
        modes = {'D': 'disable', 'O': 'enable', 'R': 'enable replica', 'A': 'enable always'}
        with psycopg.connect(gallery_inventory.setup_url) as connection:
            for schema, table, name, mode in original_modes:
                connection.execute(psycopg.sql.SQL('alter table {}.{} {} trigger {}').format(
                    psycopg.sql.Identifier(schema), psycopg.sql.Identifier(table),
                    psycopg.sql.SQL(modes[mode]), psycopg.sql.Identifier(name)
                ))


def test_live_checkpoint_restores_ready_gallery_and_preserves_trigger_modes(gallery_trigger_mode_cleanup):
    from music_app.services import gallery_projection_postgres as gallery
    checkpoint = _load_checkpoint()
    fixture = gallery_trigger_mode_cleanup
    # Use every PostgreSQL trigger mode, including an intentionally disabled one.
    with psycopg.connect(fixture.setup_url) as connection:
        connection.execute('alter table library.local_albums enable always trigger gallery_source_insert')
        connection.execute('alter table library.local_albums enable replica trigger gallery_source_delete')
        connection.execute('alter table library.local_artists disable trigger gallery_source_delete')
        modes = _gallery_trigger_modes(connection)
        checkpoint.capture_checkpoint(connection)
        saved_state = connection.execute('select * from library.gallery_projection_state order by library_id').fetchall()
        saved_snapshots = connection.execute('select * from library.gallery_projection_snapshots').fetchall()
        assert saved_snapshots
        connection.execute("update library.local_albums set title=title || ' changed'")
        connection.commit()
        checkpoint.restore_checkpoint(connection)
        checkpoint.verify_checkpoint(connection)
        assert connection.execute('select * from library.gallery_projection_state order by library_id').fetchall() == saved_state
        assert connection.execute('select * from library.gallery_projection_snapshots').fetchall() == saved_snapshots
        assert _gallery_trigger_modes(connection) == modes
        connection.commit()
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        assert gallery.load_gallery_projection_page(connection, fixture.view_state, {}) is not None
    with psycopg.connect(fixture.setup_url) as connection:
        connection.execute("update library.local_albums set title=title || ' next'")
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        assert gallery.load_gallery_projection_page(connection, fixture.view_state, {}) is None


def test_live_failed_checkpoint_restore_rolls_back_data_and_trigger_modes(gallery_inventory, monkeypatch):
    checkpoint = _load_checkpoint()
    fixture = gallery_inventory
    with psycopg.connect(fixture.setup_url) as connection:
        checkpoint.capture_checkpoint(connection)
        connection.execute("update library.local_albums set title=title || ' keep'")
        connection.commit()
        before = connection.execute('select * from library.local_albums order by id').fetchall()
        modes = _gallery_trigger_modes(connection)
        connection.commit()
        original = checkpoint.restore_table
        def fail_after_source_restore(conn, table):
            original(conn, table)
            if table == ('library', 'local_albums'):
                raise RuntimeError('injected restore failure')
        monkeypatch.setattr(checkpoint, 'restore_table', fail_after_source_restore)
        with pytest.raises(RuntimeError, match='injected restore failure'):
            checkpoint.restore_checkpoint(connection)
        assert connection.execute('select * from library.local_albums order by id').fetchall() == before
        assert _gallery_trigger_modes(connection) == modes
        # Corrupt only the disposable checkpoint copy: FK checks must still run
        # while projection invalidation is suspended, and roll back the replay.
        monkeypatch.setattr(checkpoint, 'restore_table', original)
        connection.execute('update ci_functional_checkpoint.library__local_tracks set album_id=-1')
        connection.commit()
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            checkpoint.restore_checkpoint(connection)
        assert connection.execute('select * from library.local_albums order by id').fetchall() == before
        assert _gallery_trigger_modes(connection) == modes
