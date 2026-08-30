from __future__ import annotations

from collections.abc import Callable, Mapping
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
_PREFERENCE_SCOPE = "local_first_single_viewer"
_SOURCE = "runtime_discovery_center_preferences_adapter"


def is_discovery_center_preferences_postgres_available(
    config: dict[str, object] | None,
) -> bool:
    if not isinstance(config, dict):
        return False
    database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
    return bool(database_url) and psycopg is not None and callable(getattr(psycopg, "connect", None))


class DiscoveryCenterPreferencesPostgresAdapter:
    def __init__(
        self,
        config: dict[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def load_preferences(self) -> dict[str, object]:
        from music_app.services.discovery_center_read_seams import _normalize_preferences

        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            row = _first_row(
                connection.execute(
                    _load_preferences_sql(),
                    (_PREFERENCE_SCOPE,),
                )
            )
        if row is None:
            return _normalize_preferences({})
        row_payload = _row_mapping(row)
        return _normalize_preferences(row_payload.get("preferences_payload"))

    def save_preferences(self, raw_payload: object) -> dict[str, object]:
        from music_app.services.discovery_center_read_seams import _normalize_preferences

        normalized_payload = _normalize_preferences(raw_payload)
        metadata = {
            "source": _SOURCE,
            "source_family": "discovery_center_preferences",
        }
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            cursor = connection.execute(
                _upsert_preferences_sql(),
                (
                    _PREFERENCE_SCOPE,
                    _jsonb(normalized_payload),
                    _jsonb(metadata),
                ),
            )
            if _first_row(cursor) is None:
                raise RuntimeError(
                    "Postgres discovery center preferences write did not write a row."
                )
        return normalized_payload

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for Postgres discovery center preferences."
            )
        return self._connect(self._database_url)


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for Postgres discovery center preferences.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _jsonb(value: object) -> object:
    if Jsonb is None:
        return value
    return Jsonb(value)


def _row_mapping(row: object) -> dict[str, object]:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if isinstance(row, (tuple, list)) and row:
        return {"preferences_payload": row[0]}
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
        raise RuntimeError(
            "Postgres discovery center preferences require the bootstrap local owner context."
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


def _load_preferences_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        select app.user_discovery_preferences.preferences_payload
        from app.user_discovery_preferences
        join bootstrap_context
          on bootstrap_context.account_id = app.user_discovery_preferences.account_id
        where app.user_discovery_preferences.preference_scope = %s
        limit 1;
    """
    )


def _upsert_preferences_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        insert into app.user_discovery_preferences (
          account_id,
          preference_scope,
          preferences_payload,
          metadata
        )
        select
          bootstrap_context.account_id,
          %s,
          %s::jsonb,
          %s::jsonb
        from bootstrap_context
        on conflict (account_id, preference_scope) do update
          set preferences_payload = excluded.preferences_payload,
              metadata = app.user_discovery_preferences.metadata || excluded.metadata,
              updated_at = now()
        returning 1 as saved;
    """
    )
