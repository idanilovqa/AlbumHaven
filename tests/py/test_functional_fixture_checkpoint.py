from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


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
    monkeypatch.setattr(checkpoint, "truncate_application_tables", lambda _connection, _tables: None)
    monkeypatch.setattr(
        checkpoint,
        "restore_table",
        lambda _connection, _table: (_ for _ in ()).throw(RuntimeError("copy failed")),
    )

    with pytest.raises(RuntimeError, match="copy failed"):
        checkpoint.restore_checkpoint(connection)

    assert connection.events == ["begin", "rollback"]
