from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timezone
import hashlib
import json
from typing import Any

try:  # pragma: no cover - exercised only when the optional runtime driver exists.
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover - allows import-time diagnostics without the Postgres driver.
    psycopg = None
    dict_row = None
    Jsonb = None


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_SOURCE = "runtime_listen_history_adapter"
_BACKFILL_SOURCE = "phase_6_json_file_backfill"


def is_listen_history_postgres_available(config: dict[str, object] | None) -> bool:
    if not isinstance(config, dict):
        return False
    database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
    return bool(database_url) and psycopg is not None and callable(getattr(psycopg, "connect", None))


class PostgresListenHistoryAdapter:
    def __init__(
        self,
        config: dict[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def load_items(self) -> list[dict[str, object]]:
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            rows = list(connection.execute(_load_listen_history_sql()).fetchall())
        return [_listen_history_item_from_row(row) for row in rows]

    def load_scrobbled_play_count_lookup(
        self,
        track_refs: list[str] | tuple[str, ...],
    ) -> dict[str, int]:
        normalized_track_refs = [
            normalize_track_ref(track_ref)
            for track_ref in track_refs
            if normalize_track_ref(track_ref)
        ]
        if not normalized_track_refs:
            return {}
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            rows = list(
                connection.execute(
                    _load_scrobbled_play_count_lookup_sql(),
                    {"track_refs": normalized_track_refs},
                ).fetchall()
            )
        lookup: dict[str, int] = {}
        for row in rows:
            payload = _row_mapping(row, ("track_key", "scrobble_count"))
            track_key = normalize_track_ref(payload.get("track_key"))
            if not track_key:
                continue
            lookup[track_key] = int(payload.get("scrobble_count") or 0)
        return lookup

    def save_items(self, items: list[dict[str, object]]) -> None:
        normalized_items = [dict(item) for item in items if isinstance(item, dict)]
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                connection.execute(_delete_listen_history_sql())
                for index, item in enumerate(normalized_items):
                    source_entry_id = _source_entry_id(item, index)
                    connection.execute(
                        _insert_listen_history_sql(),
                        (
                            _listen_history_track_key(item),
                            _listen_history_timestamp(item) or datetime.now(timezone.utc).isoformat(),
                            source_entry_id,
                            _scrobble_status(item),
                            str(item.get("request_origin") or "").strip() or None,
                            _jsonb(
                                {
                                    "source": _SOURCE,
                                    "source_entry_id": source_entry_id,
                                    "source_payload": item,
                                }
                            ),
                        ),
                    )

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required for Postgres listen history.")
        return self._connect(self._database_url)


class _NoopTransaction:
    def __enter__(self) -> "_NoopTransaction":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        pass


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for Postgres listen history.")
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


def _row_mapping(row: object, tuple_fields: tuple[str, ...]) -> dict[str, object]:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if isinstance(row, (tuple, list)):
        return {
            field_name: row[index]
            for index, field_name in enumerate(tuple_fields)
            if index < len(row)
        }
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


def _ensure_bootstrap_context(connection: Any) -> None:
    if _first_row(connection.execute(_bootstrap_context_ready_sql())) is None:
        raise RuntimeError("Postgres listen history requires the bootstrap local owner/library context.")


def _listen_history_item_from_row(row: object) -> dict[str, object]:
    payload = _row_mapping(
        row,
        (
            "track_key",
            "played_at",
            "source_entry_id",
            "scrobble_status",
            "request_origin",
            "metadata",
        ),
    )
    metadata = payload.get("metadata")
    if isinstance(metadata, Mapping) and isinstance(metadata.get("source_payload"), Mapping):
        item = dict(metadata["source_payload"])
    else:
        item = {}
    if not item.get("id"):
        item["id"] = str(payload.get("source_entry_id") or "").strip()
    if not item.get("track_ref") and payload.get("track_key"):
        item["track_ref"] = str(payload["track_key"])
    if not item.get("recorded_at") and payload.get("played_at"):
        item["recorded_at"] = str(payload["played_at"])
    if "scrobbled" not in item and payload.get("scrobble_status"):
        item["scrobbled"] = str(payload["scrobble_status"]) == "scrobbled"
    if not item.get("request_origin") and payload.get("request_origin"):
        item["request_origin"] = str(payload["request_origin"])
    return item


def _listen_history_track_key(row: dict[str, object]) -> str | None:
    for key in ("track_ref", "path", "track_key"):
        normalized = normalize_track_ref(row.get(key))
        if normalized:
            return normalized
    return None


def normalize_track_ref(value: object) -> str:
    return str(value or "").strip()


def _listen_history_timestamp(row: dict[str, object]) -> str | None:
    for key in ("recorded_at", "played_at", "ended_at", "started_at"):
        value = str(row.get(key) or "").strip()
        if value:
            return value
    return None


def _source_entry_id(row: dict[str, object], index: int) -> str:
    explicit_id = str(row.get("id") or "").strip()
    if explicit_id:
        return explicit_id
    payload = json.dumps({"source_index": index, "row": row}, sort_keys=True, default=str)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _scrobble_status(row: dict[str, object]) -> str | None:
    if row.get("scrobble_status"):
        return str(row["scrobble_status"])
    if row.get("scrobbled"):
        return "scrobbled"
    if row.get("scrobble_eligible"):
        return "pending"
    return None


def _bootstrap_context_sql() -> str:
    return """
        with bootstrap_context as (
          select
            app.bootstrap_owners.account_id,
            library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
    """


def _bootstrap_context_ready_sql() -> str:
    return _bootstrap_context_sql() + " select 1 as bootstrap_context_ready from bootstrap_context;"


def _load_listen_history_sql() -> str:
    return (
        _bootstrap_context_sql()
        + f"""
        select
          integration.listen_history.track_key,
          integration.listen_history.played_at,
          integration.listen_history.source_entry_id,
          integration.listen_history.scrobble_status,
          integration.listen_history.request_origin,
          integration.listen_history.metadata
        from integration.listen_history
        join bootstrap_context
          on bootstrap_context.library_id = integration.listen_history.library_id
         and bootstrap_context.account_id = integration.listen_history.account_id
        where integration.listen_history.source_family in ('{_SOURCE}', '{_BACKFILL_SOURCE}')
        order by integration.listen_history.played_at, integration.listen_history.id;
    """
    )


def _load_scrobbled_play_count_lookup_sql() -> str:
    return (
        _bootstrap_context_sql()
        + f"""
        select
          integration.listen_history.track_key,
          count(*)::int as scrobble_count
        from integration.listen_history
        join bootstrap_context
          on bootstrap_context.library_id = integration.listen_history.library_id
         and bootstrap_context.account_id = integration.listen_history.account_id
        where integration.listen_history.source_family in ('{_SOURCE}', '{_BACKFILL_SOURCE}')
          and integration.listen_history.scrobble_status = 'scrobbled'
          and integration.listen_history.track_key = any(%(track_refs)s)
        group by integration.listen_history.track_key
        order by integration.listen_history.track_key;
    """
    )


def _delete_listen_history_sql() -> str:
    return (
        _bootstrap_context_sql()
        + f"""
        delete from integration.listen_history
        using bootstrap_context
        where integration.listen_history.library_id = bootstrap_context.library_id
          and integration.listen_history.account_id = bootstrap_context.account_id
          and integration.listen_history.source_family in ('{_SOURCE}', '{_BACKFILL_SOURCE}');
    """
    )


def _insert_listen_history_sql() -> str:
    return (
        _bootstrap_context_sql()
        + f"""
        insert into integration.listen_history (
          library_id,
          account_id,
          track_key,
          played_at,
          listen_source,
          source_family,
          source_entry_id,
          scrobble_status,
          request_origin,
          metadata
        )
        select
          bootstrap_context.library_id,
          bootstrap_context.account_id,
          %s,
          %s::timestamptz,
          'local',
          '{_SOURCE}',
          %s,
          %s,
          %s,
          %s::jsonb
        from bootstrap_context;
    """
    )
