from __future__ import annotations

from pathlib import Path

import pytest

from music_app.services.library_roots_postgres import (
    PostgresLibraryRootSettingsStore,
    is_library_roots_postgres_available,
)


class _FakeCursor:
    def __init__(self, rows=None):
        self._rows = list(rows or [])

    def fetchone(self):
        if not self._rows:
            return None
        return self._rows[0]

    def fetchall(self):
        return list(self._rows)


class _FakeTransaction:
    def __init__(self, connection: "_FakeConnection"):
        self._connection = connection

    def __enter__(self):
        self._connection.transaction_entries += 1
        return self

    def __exit__(self, exc_type, exc, traceback):
        self._connection.transaction_exits += 1
        return False


class _FakeConnection:
    def __init__(self, *, rows=None, bootstrap_ready=True, upsert_returns=True):
        self.rows = list(rows or [])
        self.bootstrap_ready = bootstrap_ready
        self.upsert_returns = upsert_returns
        self.operations: list[dict[str, object]] = []
        self.closed = False
        self.transaction_entries = 0
        self.transaction_exits = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.closed = True
        return False

    def transaction(self):
        return _FakeTransaction(self)

    def execute(self, sql, params=None):
        sql_text = str(sql)
        self.operations.append({"sql": sql_text, "params": params})
        lowered = sql_text.lower()
        if "bootstrap_context_ready" in lowered:
            return _FakeCursor([{"bootstrap_context_ready": 1}] if self.bootstrap_ready else [])
        if "insert into library.library_root_settings" in lowered:
            return _FakeCursor([{"saved": 1}] if self.upsert_returns else [])
        if "insert into library.library_roots" in lowered:
            return _FakeCursor([{"saved": 1}] if self.upsert_returns else [])
        if "from library.library_root_settings" in lowered:
            return _FakeCursor(self.rows)
        return _FakeCursor()


def test_library_roots_postgres_availability_requires_url_and_callable_driver(monkeypatch):
    class FakePsycopg:
        def connect(self):
            raise AssertionError("availability should not open a database connection")

    monkeypatch.setattr("music_app.services.library_roots_postgres.psycopg", FakePsycopg())

    assert not is_library_roots_postgres_available({})
    assert is_library_roots_postgres_available(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"}
    )


def test_library_roots_postgres_availability_requires_driver(monkeypatch):
    monkeypatch.setattr("music_app.services.library_roots_postgres.psycopg", None)

    assert not is_library_roots_postgres_available(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"}
    )


def test_postgres_library_root_settings_loads_and_normalizes_payload(tmp_path):
    main_root = tmp_path / "Main"
    hoard_root = tmp_path / "Hoard"
    connection = _FakeConnection(
        rows=[
            {
                "settings_payload": {
                    "main_library_roots": [
                        {
                            "id": "main",
                            "path": f" {main_root} ",
                            "layout_mode": "genre/artist",
                        }
                    ],
                    "hoarding_library_roots": [{"id": "hoard", "path": str(hoard_root)}],
                    "move_policy": {
                        "preferred_main_write_root": str(main_root),
                        "move_new_arrivals_to": "hoard",
                    },
                }
            }
        ]
    )
    store = PostgresLibraryRootSettingsStore(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        },
        connect=lambda database_url: connection,
    )

    payload = store.load_settings()

    assert payload["main_library_roots"] == [
        {"id": "main", "path": str(main_root.resolve(strict=False)), "layout_mode": "genre/artist"}
    ]
    assert payload["hoarding_library_roots"] == [
        {"id": "hoard", "path": str(hoard_root.resolve(strict=False))}
    ]
    assert payload["move_policy"] == {
        "preferred_main_write_root": "main",
        "move_new_arrivals_to": "hoard",
    }
    assert any("app.bootstrap_owners" in operation["sql"] for operation in connection.operations)
    assert connection.closed


def test_postgres_library_root_settings_missing_row_returns_uninitialized_settings():
    connection = _FakeConnection(rows=[])
    store = PostgresLibraryRootSettingsStore(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        },
        connect=lambda database_url: connection,
    )

    payload = store.load_settings()

    assert payload == {
        "version": 1,
        "main_library_roots": [],
        "hoarding_library_roots": [],
        "new_arrivals_roots": [],
        "move_policy": {},
    }


def test_postgres_library_root_settings_reuses_caller_snapshot_connection(tmp_path):
    main_root = (tmp_path / "Music").resolve(strict=False)
    connection = _FakeConnection(
        rows=[
            {
                "settings_payload": {
                    "version": 1,
                    "main_library_roots": [
                        {
                            "id": "main",
                            "path": str(main_root),
                            "layout_mode": "artist",
                        }
                    ],
                    "hoarding_library_roots": [],
                    "new_arrivals_roots": [],
                    "move_policy": {},
                }
            }
        ]
    )
    store = PostgresLibraryRootSettingsStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: (_ for _ in ()).throw(
            AssertionError("caller-owned snapshot must not open another connection")
        ),
    )

    payload = store.load_settings(connection=connection)

    assert payload["main_library_roots"][0]["path"] == str(main_root)
    assert not connection.closed


@pytest.mark.parametrize("row", [{}, {"settings_payload": None}, {"settings_payload": []}])
def test_postgres_library_root_settings_malformed_row_fails_loudly(row):
    connection = _FakeConnection(rows=[row])
    store = PostgresLibraryRootSettingsStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda database_url: connection,
    )

    with pytest.raises(ValueError, match="settings_payload|JSON object"):
        store.load_settings()


@pytest.mark.parametrize(
    "secondary_keys",
    [
        ("hoarding_library_roots",),
        ("new_arrivals_roots",),
        ("hoarding_library_roots", "new_arrivals_roots"),
    ],
    ids=["hoard-only", "arrivals-only", "both-secondary-only"],
)
def test_postgres_library_root_settings_load_rejects_secondary_roots_without_main(
    tmp_path,
    secondary_keys,
):
    payload = {
        key: [{"id": f"{key}-1", "path": str(tmp_path / key)}]
        for key in secondary_keys
    }
    connection = _FakeConnection(rows=[{"settings_payload": payload}])
    store = PostgresLibraryRootSettingsStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda database_url: connection,
    )

    with pytest.raises(ValueError, match="At least one Main Library root"):
        store.load_settings()


def test_postgres_library_root_settings_save_writes_all_table_families(tmp_path, monkeypatch):
    monkeypatch.setattr("music_app.services.library_roots_postgres.Jsonb", None)
    connection = _FakeConnection()
    store = PostgresLibraryRootSettingsStore(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        },
        connect=lambda database_url: connection,
    )

    saved = store.save_settings(
        {
            "main_library_roots": [
                {
                    "id": "main",
                    "path": str(tmp_path / "Main"),
                    "layout_mode": "genre/artist",
                }
            ],
            "hoarding_library_roots": [{"id": "hoard", "path": str(tmp_path / "Hoard")}],
            "move_policy": {
                "preferred_main_write_root": "main",
                "move_new_arrivals_to": "hoard",
            },
        }
    )

    sql_text = "\n".join(operation["sql"].lower() for operation in connection.operations)
    assert "insert into library.library_root_settings" in sql_text
    assert "insert into library.library_roots" in sql_text
    assert "update library.library_roots" in sql_text
    assert "delete from library.move_policy_settings" in sql_text
    assert "insert into library.move_policy_settings" in sql_text
    assert "insert into library.library_root_provenance" in sql_text
    assert "where not exists" in sql_text
    assert "source_family" in sql_text
    assert "library_root_settings_runtime" in sql_text
    assert connection.transaction_entries == 1
    assert connection.transaction_exits == 1

    settings_operation = next(
        operation
        for operation in connection.operations
        if "insert into library.library_root_settings" in operation["sql"].lower()
    )
    assert settings_operation["params"][0] == "genre/artist"
    main_path = str((tmp_path / "Main").resolve(strict=False))
    hoard_path = str((tmp_path / "Hoard").resolve(strict=False))
    assert settings_operation["params"][1] == {
        main_path: {
            "root_id": "main",
            "category": "main_library",
            "category_key": "main_library_roots",
        },
        hoard_path: {
            "root_id": "hoard",
            "category": "hoard",
            "category_key": "hoarding_library_roots",
        },
    }
    assert settings_operation["params"][2]["main_library_roots"][0]["id"] == "main"
    assert settings_operation["params"][2]["source"] == "library_root_settings_runtime"

    root_operations = [
        operation
        for operation in connection.operations
        if "insert into library.library_roots" in operation["sql"].lower()
    ]
    root_payloads = {operation["params"][2]["root_id"]: operation["params"] for operation in root_operations}
    assert root_payloads["main"][1] == "main_library"
    assert root_payloads["hoard"][1] == "hoard"
    assert root_payloads["main"][2]["source"] == "library_root_settings_runtime"

    deactivate_operation = next(
        operation
        for operation in connection.operations
        if "update library.library_roots" in operation["sql"].lower()
        and "is_active = false" in operation["sql"].lower()
    )
    assert deactivate_operation["params"] == (2, [main_path, hoard_path])
    assert "root_path <> all" in deactivate_operation["sql"].lower()
    assert "metadata ->> 'root_id'" not in deactivate_operation["sql"].lower()
    assert "metadata - 'deactivated'" in sql_text

    policy_operations = [
        operation
        for operation in connection.operations
        if "insert into library.move_policy_settings" in operation["sql"].lower()
    ]
    assert {
        operation["params"][0]: operation["params"][1]["root_id"]
        for operation in policy_operations
    } == {"preferred_main_write_root": "main", "move_new_arrivals_to": "hoard"}

    provenance_operations = [
        operation
        for operation in connection.operations
        if "insert into library.library_root_provenance" in operation["sql"].lower()
    ]
    assert len(provenance_operations) == 2
    assert provenance_operations[0]["params"][1] == "library_root_settings_runtime"
    assert saved["move_policy"] == {
        "preferred_main_write_root": "main",
        "move_new_arrivals_to": "hoard",
    }
    assert connection.closed


def test_postgres_library_root_settings_save_raises_when_bootstrap_context_is_missing(tmp_path):
    connection = _FakeConnection(bootstrap_ready=False)
    store = PostgresLibraryRootSettingsStore(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        },
        connect=lambda database_url: connection,
    )

    with pytest.raises(RuntimeError, match="bootstrap local owner/library"):
        store.save_settings({"main_library_roots": [{"id": "main", "path": str(tmp_path / "Main")}]})

    assert not any(
        "insert into library.library_roots" in operation["sql"].lower()
        for operation in connection.operations
    )
    assert connection.closed


def test_postgres_library_root_settings_save_raises_when_upsert_writes_no_row(tmp_path):
    connection = _FakeConnection(upsert_returns=False)
    store = PostgresLibraryRootSettingsStore(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        },
        connect=lambda database_url: connection,
    )

    with pytest.raises(RuntimeError, match="did not write"):
        store.save_settings({"main_library_roots": [{"id": "main", "path": str(tmp_path / "Main")}]})


@pytest.mark.parametrize("payload", [None, [], {}, {"main_library_roots": []}])
def test_postgres_library_root_settings_save_rejects_missing_or_malformed_roots(payload):
    connection = _FakeConnection()
    store = PostgresLibraryRootSettingsStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda database_url: connection,
    )

    with pytest.raises(ValueError, match="JSON object|At least one Main Library root"):
        store.save_settings(payload)

    assert connection.operations == []


@pytest.mark.parametrize(
    "secondary_keys",
    [
        ("hoarding_library_roots",),
        ("new_arrivals_roots",),
        ("hoarding_library_roots", "new_arrivals_roots"),
    ],
    ids=["hoard-only", "arrivals-only", "both-secondary-only"],
)
def test_postgres_library_root_settings_save_rejects_secondary_roots_without_main(
    tmp_path,
    secondary_keys,
):
    payload = {
        key: [{"id": f"{key}-1", "path": str(tmp_path / key)}]
        for key in secondary_keys
    }
    connection = _FakeConnection()
    store = PostgresLibraryRootSettingsStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda database_url: connection,
    )

    with pytest.raises(ValueError, match="At least one Main Library root"):
        store.save_settings(payload)

    assert connection.operations == []
