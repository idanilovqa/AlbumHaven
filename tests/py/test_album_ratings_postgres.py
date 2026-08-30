from __future__ import annotations

import importlib
import importlib.util
from collections.abc import Iterable, Mapping
from typing import Any

import pytest


SERVICE_MODULE = "music_app.services.album_ratings_postgres"
DATABASE_URL = "postgresql://album_haven_app@localhost/album_haven_test"


class FakeCursor:
    def __init__(self, rows: Iterable[object] = ()) -> None:
        self._rows = list(rows)

    def fetchall(self) -> list[object]:
        return list(self._rows)

    def fetchone(self) -> object | None:
        return self._rows[0] if self._rows else None


class FakeTransaction:
    def __init__(self, connection: "FakeConnection") -> None:
        self._connection = connection

    def __enter__(self) -> "FakeTransaction":
        self._connection.transaction_entries += 1
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self._connection.transaction_exits += 1


class FakeConnection:
    def __init__(
        self,
        *,
        context_rows: Iterable[object] = ({"account_id": 11, "library_id": 22},),
        load_rows: Iterable[object] = (),
        write_results: Iterable[Iterable[object]] = (),
    ) -> None:
        self.context_rows = list(context_rows)
        self.load_rows = list(load_rows)
        self.write_results = [list(rows) for rows in write_results]
        self.operations: list[tuple[str, object]] = []
        self.transaction_entries = 0
        self.transaction_exits = 0

    def __enter__(self) -> "FakeConnection":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        pass

    def transaction(self) -> FakeTransaction:
        return FakeTransaction(self)

    def execute(self, sql: str, params: object = None) -> FakeCursor:
        self.operations.append((sql, params))
        normalized_sql = " ".join(str(sql).lower().split())
        if "bootstrap_context_ready" in normalized_sql:
            return FakeCursor(self.context_rows)
        if "from app.album_ratings" in normalized_sql and "insert into" not in normalized_sql:
            return FakeCursor(self.load_rows)
        if "insert into app.album_ratings" in normalized_sql:
            rows = self.write_results.pop(0) if self.write_results else []
            return FakeCursor(rows)
        return FakeCursor()


@pytest.fixture
def ratings_module():
    if importlib.util.find_spec(SERVICE_MODULE) is None:
        pytest.skip("Postgres album-ratings service is not present yet.")
    return importlib.import_module(SERVICE_MODULE)


def _service(ratings_module, connection: FakeConnection, *, config: dict[str, object] | None = None):
    return ratings_module.PostgresAlbumRatingsService(
        config or {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL},
        connect=lambda database_url: connection,
    )


def _normalized_operations(connection: FakeConnection) -> list[tuple[str, object]]:
    return [(" ".join(sql.lower().split()), params) for sql, params in connection.operations]


def _write_operations(connection: FakeConnection) -> list[tuple[str, object]]:
    return [
        (sql, params)
        for sql, params in _normalized_operations(connection)
        if "insert into app.album_ratings" in sql
    ]


def _flatten_values(value: object) -> list[object]:
    if isinstance(value, Mapping):
        flattened: list[object] = []
        for item in value.values():
            flattened.extend(_flatten_values(item))
        return flattened
    if isinstance(value, list | tuple | set):
        flattened = []
        for item in value:
            flattened.extend(_flatten_values(item))
        return flattened
    return [value]


def test_postgres_album_ratings_service_module_exists():
    assert importlib.util.find_spec(SERVICE_MODULE) is not None, (
        "missing app-owned album ratings service: "
        "music_app/services/album_ratings_postgres.py"
    )


def test_album_rating_load_requires_configured_database_url(ratings_module):
    service = ratings_module.PostgresAlbumRatingsService({}, connect=lambda _url: None)

    with pytest.raises(RuntimeError, match="ALBUM_HAVEN_APP_DATABASE_URL"):
        service.load_album_ratings(["album-a"])


def test_album_rating_load_fails_loudly_without_bootstrap_owner_library_context(
    ratings_module,
):
    connection = FakeConnection(context_rows=[])

    with pytest.raises(RuntimeError, match="bootstrap local library context"):
        _service(ratings_module, connection).load_album_ratings(["album-a"])


def test_album_rating_load_is_batched_and_preserves_explicit_null_row_existence(
    ratings_module,
):
    connection = FakeConnection(
        load_rows=[
            {
                "album_key": "numeric-album",
                "rating": 8,
                "provenance": "explicit_import",
            },
            {
                "album_key": "cleared-album",
                "rating": None,
                "provenance": "explicit_clear",
            },
        ]
    )

    result = _service(ratings_module, connection).load_album_ratings(
        [" numeric-album ", "cleared-album", "missing-album", "numeric-album", ""]
    )

    assert result == {
        "numeric-album": {"rating": 8, "provenance": "explicit_import"},
        "cleared-album": {"rating": None, "provenance": "explicit_clear"},
    }
    load_operations = [
        (sql, params)
        for sql, params in _normalized_operations(connection)
        if "from app.album_ratings" in sql
    ]
    assert len(load_operations) == 1
    load_sql, load_params = load_operations[0]
    assert "app.bootstrap_owners" in load_sql
    assert "local-bootstrap-owner" in load_sql
    assert "app.album_ratings.account_id = bootstrap_context.account_id" in load_sql
    assert "app.album_ratings.library_id = bootstrap_context.library_id" in load_sql
    assert "album_key = any" in load_sql
    assert {"numeric-album", "cleared-album", "missing-album"}.issubset(
        set(_flatten_values(load_params))
    )


def test_album_rating_load_reuses_caller_owned_connection_without_owning_its_lifecycle(
    ratings_module,
):
    lifecycle: list[str] = []

    class CallerOwnedConnection(FakeConnection):
        def __enter__(self):
            lifecycle.append("enter")
            return self

        def __exit__(self, exc_type, exc, tb):
            lifecycle.append("exit")

        def commit(self):
            lifecycle.append("commit")

        def rollback(self):
            lifecycle.append("rollback")

        def close(self):
            lifecycle.append("close")

    connection = CallerOwnedConnection(
        load_rows=[
            {
                "album_key": "album-a",
                "rating": 9,
                "provenance": "manual",
            }
        ]
    )
    service = ratings_module.PostgresAlbumRatingsService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL},
        connect=lambda _database_url: pytest.fail(
            "caller-owned rating reads must not open a second Postgres connection"
        ),
    )

    result = service.load_album_ratings(["album-a"], connection=connection)

    assert result == {
        "album-a": {"rating": 9, "provenance": "manual"},
    }
    assert lifecycle == []
    assert connection.transaction_entries == 0
    assert connection.transaction_exits == 0


def test_explicit_import_reads_persisted_tag_ratings_and_reports_exact_counts(
    ratings_module,
):
    connection = FakeConnection(
        write_results=[
            [{"created": 2, "authority_skipped": 1, "failed": 3}]
        ]
    )

    result = _service(ratings_module, connection).import_missing_tag_ratings()

    assert result == {"created": 2, "authority_skipped": 1, "failed": 3}
    assert connection.transaction_entries == 1
    assert connection.transaction_exits == 1
    [(sql, params)] = _write_operations(connection)
    assert "library.local_albums" in sql
    assert "library.local_albums.metadata -> 'tag_album_rating' as tag_album_rating" in sql
    assert "library.local_albums.metadata -> 'album_rating'" not in sql
    assert "insert into app.album_ratings" in sql
    assert "on conflict (account_id, library_id, album_key) do nothing" in sql
    assert "returning" in sql
    assert "between 1 and 10" in sql
    assert "explicit_import" in sql or "explicit_import" in _flatten_values(params)


def test_file_tag_scan_uses_callers_transaction_ignores_absent_and_rejects_invalid_ratings(
    ratings_module,
):
    connection = FakeConnection(
        write_results=[
            [{"created": 1, "authority_skipped": 1, "failed": 0}]
        ]
    )

    def unexpected_connect(_database_url: str) -> Any:
        raise AssertionError("scan publication must reuse its caller-owned Postgres transaction")

    service = ratings_module.PostgresAlbumRatingsService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL},
        connect=unexpected_connect,
    )
    result = service.seed_missing_album_ratings_in_transaction(
        connection,
        [
            {"album_key": "new-album", "tag_album_rating": 7},
            {"album_key": "cleared-authority", "tag_album_rating": 9},
            {"album_key": "missing-rating", "tag_album_rating": None},
            {"album_key": "zero-rating", "tag_album_rating": 0},
            {"album_key": "high-rating", "tag_album_rating": 11},
            {"album_key": "string-rating", "tag_album_rating": "8"},
            {"album_key": "fractional-rating", "tag_album_rating": 8.5},
            {"album_key": "boolean-rating", "tag_album_rating": True},
        ],
        source="file_tag_scan",
    )

    assert result == {"created": 1, "authority_skipped": 1, "failed": 5}
    assert connection.transaction_entries == 0
    assert connection.transaction_exits == 0
    [(sql, params)] = _write_operations(connection)
    assert "on conflict (account_id, library_id, album_key) do nothing" in sql
    assert "unnest" in sql or "jsonb_to_recordset" in sql
    flattened_params = _flatten_values(params)
    assert "new-album" in flattened_params
    assert "cleared-authority" in flattened_params
    for rejected in (
        "missing-rating",
        "zero-rating",
        "high-rating",
        "string-rating",
        "fractional-rating",
        "boolean-rating",
    ):
        assert rejected not in flattened_params


def test_file_tag_scan_is_idempotent_and_null_rows_count_as_authority_skipped(
    ratings_module,
):
    connection = FakeConnection(
        write_results=[
            [{"created": 2, "authority_skipped": 0, "failed": 0}],
            [{"created": 0, "authority_skipped": 2, "failed": 0}],
        ]
    )
    service = _service(ratings_module, connection)
    candidates = [
        {"album_key": "rated-album", "tag_album_rating": 10},
        {"album_key": "cleared-album", "tag_album_rating": 6},
    ]

    first = service.seed_missing_album_ratings_in_transaction(
        connection,
        candidates,
        source="file_tag_scan",
    )
    second = service.seed_missing_album_ratings_in_transaction(
        connection,
        candidates,
        source="file_tag_scan",
    )

    assert first == {"created": 2, "authority_skipped": 0, "failed": 0}
    assert second == {"created": 0, "authority_skipped": 2, "failed": 0}
    assert len(_write_operations(connection)) == 2
    for sql, _params in _write_operations(connection):
        assert "rating is null" not in sql
        assert "on conflict (account_id, library_id, album_key) do nothing" in sql


def test_file_tag_scan_deduplicates_logical_album_candidates_before_the_set_write(
    ratings_module,
):
    connection = FakeConnection(
        write_results=[[{"created": 1, "authority_skipped": 0, "failed": 0}]]
    )

    result = _service(ratings_module, connection).seed_missing_album_ratings_in_transaction(
        connection,
        [
            {"album_key": "same-album", "tag_album_rating": 9},
            {"album_key": " same-album ", "tag_album_rating": 9},
        ],
        source="file_tag_scan",
    )

    assert result == {"created": 1, "authority_skipped": 0, "failed": 0}
    [(_sql, params)] = _write_operations(connection)
    assert _flatten_values(params).count("same-album") == 1


def test_seed_rejects_unknown_provenance_before_writing(ratings_module):
    connection = FakeConnection()

    with pytest.raises(ValueError, match="source"):
        _service(ratings_module, connection).seed_missing_album_ratings_in_transaction(
            connection,
            [{"album_key": "album-a", "tag_album_rating": 8}],
            source="generic_snapshot_save",
        )

    assert connection.operations == []


def test_seed_sql_scopes_conflict_identity_by_account_library_and_album_key(
    ratings_module,
):
    connection = FakeConnection(
        write_results=[[{"created": 1, "authority_skipped": 0, "failed": 0}]]
    )

    _service(ratings_module, connection).seed_missing_album_ratings_in_transaction(
        connection,
        [{"album_key": "shared-key", "tag_album_rating": 5}],
        source="file_tag_scan",
    )

    [(sql, _params)] = _write_operations(connection)
    assert "app.bootstrap_owners" in sql
    assert "local-bootstrap-owner" in sql
    assert "library.libraries.owner_account_id" in sql
    assert "library.local_albums.library_id = bootstrap_context.library_id" in sql
    assert "library.local_albums.album_key" in sql
    assert "on conflict (account_id, library_id, album_key) do nothing" in sql


def test_seed_sql_types_source_parameters_for_postgres_parameter_inference(
    ratings_module,
):
    connection = FakeConnection(
        write_results=[[{"created": 1, "authority_skipped": 0, "failed": 0}]]
    )

    _service(ratings_module, connection).seed_missing_album_ratings_in_transaction(
        connection,
        [{"album_key": "typed-source", "tag_album_rating": 8}],
        source="file_tag_scan",
    )

    [(sql, params)] = _write_operations(connection)
    assert "eligible.rating, %s::text, jsonb_build_object('source', %s::text)" in sql
    assert params == (["typed-source"], [8], "file_tag_scan", "file_tag_scan")
