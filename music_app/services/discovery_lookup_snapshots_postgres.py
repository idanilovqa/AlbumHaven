from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from typing import Any

try:  # pragma: no cover - exercised only when the optional runtime driver exists.
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover - keeps non-Postgres tooling importable.
    psycopg = None
    dict_row = None
    Jsonb = None


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_SOURCE = "runtime_discovery_lookup_snapshot_adapter"


def is_discovery_lookup_snapshots_postgres_available(
    config: dict[str, object] | None,
) -> bool:
    if not isinstance(config, dict):
        return False
    database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
    return bool(database_url) and psycopg is not None and callable(getattr(psycopg, "connect", None))


class PostgresDiscoveryLookupSnapshotStore:
    def __init__(
        self,
        config: dict[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def load_snapshot_rows(self) -> list[dict[str, object]]:
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            rows = list(connection.execute(_load_snapshot_rows_sql()).fetchall())
        return [_snapshot_row_from_database(row) for row in rows]

    def save_snapshot_rows(self, rows: list[dict[str, object]]) -> None:
        normalized_rows = [
            row for row in (_normalize_snapshot_row(item) for item in rows) if row
        ]
        refs = [str(row["lookup_ref"]) for row in normalized_rows]
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                connection.execute(_mark_removed_snapshot_rows_sql(), (_SOURCE, len(refs), refs))
                for row in normalized_rows:
                    cursor = connection.execute(
                        _upsert_snapshot_row_sql(),
                        (
                            row["lookup_ref"],
                            row["created_at"],
                            row["status"],
                            _jsonb(row["request"]),
                            _jsonb(row["results"]),
                            _SOURCE,
                        ),
                    )
                    if _first_row(cursor) is None:
                        raise RuntimeError(
                            "Postgres discovery lookup snapshot write did not write a row."
                        )

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError(
                "Discovery lookup snapshot runtime persistence is Postgres-only."
            )
        return self._connect(self._database_url)


class _NoopTransaction:
    def __enter__(self) -> "_NoopTransaction":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        pass


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError(
            "Discovery lookup snapshot runtime persistence is Postgres-only."
        )
    return psycopg.connect(database_url, row_factory=dict_row)


def _transaction(connection: Any) -> Any:
    transaction = getattr(connection, "transaction", None)
    if callable(transaction):
        return transaction()
    return _NoopTransaction()


def _jsonb(value: object) -> object:
    if Jsonb is None:
        return value
    return Jsonb(value)


def _row_mapping(row: object) -> dict[str, object]:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    return {}


def _first_row(cursor: object) -> object | None:
    fetchone = getattr(cursor, "fetchone", None)
    if callable(fetchone):
        return fetchone()
    fetchall = getattr(cursor, "fetchall", None)
    rows = list(fetchall()) if callable(fetchall) else []
    return rows[0] if rows else None


def _text(value: object) -> str:
    return str(value or "").strip()


def _serialize_timestamp(value: object) -> str:
    if isinstance(value, datetime):
        return (
            value.astimezone(timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        )
    return _text(value)


def _normalize_snapshot_row(row: object) -> dict[str, object] | None:
    if not isinstance(row, dict):
        return None
    lookup_ref = _text(row.get("lookup_ref"))
    if not lookup_ref:
        return None
    request = row.get("request")
    results = row.get("results")
    return {
        "lookup_ref": lookup_ref,
        "created_at": _text(row.get("created_at")) or None,
        "status": _text(row.get("status")) or "pending_source_integration",
        "request": dict(request) if isinstance(request, dict) else {},
        "results": list(results) if isinstance(results, list) else [],
    }


def _snapshot_row_from_database(row: object) -> dict[str, object]:
    row_payload = _row_mapping(row)
    request = row_payload.get("request_payload")
    results = row_payload.get("results_payload")
    return {
        "lookup_ref": _text(row_payload.get("lookup_ref")),
        "created_at": _serialize_timestamp(row_payload.get("created_at")),
        "status": _text(row_payload.get("status")) or "pending_source_integration",
        "request": dict(request) if isinstance(request, dict) else {},
        "results": list(results) if isinstance(results, list) else [],
    }


def _ensure_bootstrap_context(connection: Any) -> None:
    if _first_row(connection.execute(_bootstrap_context_ready_sql())) is None:
        raise RuntimeError(
            "Postgres discovery lookup snapshots require the bootstrap local owner context."
        )


def _bootstrap_context_sql() -> str:
    return """
        with bootstrap_context as (
          select app.bootstrap_owners.account_id
          from app.bootstrap_owners
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
    """


def _bootstrap_context_ready_sql() -> str:
    return _bootstrap_context_sql() + " select 1 as bootstrap_context_ready from bootstrap_context;"


def _load_snapshot_rows_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        select
          app.discovery_lookup_snapshots.lookup_ref,
          app.discovery_lookup_snapshots.created_at,
          app.discovery_lookup_snapshots.status,
          app.discovery_lookup_snapshots.request_payload,
          app.discovery_lookup_snapshots.results_payload
        from app.discovery_lookup_snapshots
        join bootstrap_context
          on bootstrap_context.account_id = app.discovery_lookup_snapshots.account_id
        where app.discovery_lookup_snapshots.metadata ->> 'removed' is distinct from 'true'
        order by app.discovery_lookup_snapshots.created_at desc,
                 app.discovery_lookup_snapshots.id desc;
    """
    )


def _mark_removed_snapshot_rows_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        update app.discovery_lookup_snapshots
           set metadata = app.discovery_lookup_snapshots.metadata
                 || jsonb_build_object('removed', true, 'source', %s),
               updated_at = now()
        from bootstrap_context
        where app.discovery_lookup_snapshots.account_id = bootstrap_context.account_id
          and (
            %s = 0
            or app.discovery_lookup_snapshots.lookup_ref <> all(%s::text[])
          );
    """
    )


def _upsert_snapshot_row_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        insert into app.discovery_lookup_snapshots (
          account_id,
          lookup_ref,
          created_at,
          status,
          request_payload,
          results_payload,
          metadata
        )
        select
          bootstrap_context.account_id,
          %s,
          coalesce(%s::timestamptz, now()),
          %s,
          %s::jsonb,
          %s::jsonb,
          jsonb_build_object('source', %s)
        from bootstrap_context
        on conflict (account_id, lookup_ref) do update
          set created_at = excluded.created_at,
              status = excluded.status,
              request_payload = excluded.request_payload,
              results_payload = excluded.results_payload,
              metadata = excluded.metadata,
              updated_at = now()
        returning 1 as saved;
    """
    )
