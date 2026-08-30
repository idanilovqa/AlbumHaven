from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timezone
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
_SETTINGS_SOURCE = "runtime_lastfm_settings_adapter"
_SYNC_SOURCE = "runtime_lastfm_sync_state_adapter"
_SYNC_BACKFILL_SOURCE = "lastfm_sync_state"


def is_lastfm_postgres_available(config: dict[str, object] | None) -> bool:
    if not isinstance(config, dict):
        return False
    database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
    return bool(database_url) and psycopg is not None and callable(getattr(psycopg, "connect", None))


class LastfmPostgresAdapter:
    def __init__(
        self,
        config: dict[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def load_settings(self) -> dict[str, object]:
        with self._connect_to_database() as connection:
            _ensure_bootstrap_account_context(connection)
            row = _first_row(connection.execute(_load_lastfm_settings_sql()))
        if row is None:
            return {}
        return _settings_from_row(row)

    def save_settings(self, settings: dict[str, object]) -> dict[str, object]:
        normalized = dict(settings)
        username = _text(normalized.get("username")) or None
        session_key = _text(normalized.get("session_key")) or None
        connected_at = _text(normalized.get("connected_at"))
        timezone_name = _text(normalized.get("user_timezone")) or None
        public_settings = {key: value for key, value in normalized.items() if key != "session_key"}
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_account_context(connection)
                connection.execute(
                    _upsert_lastfm_settings_sql(),
                    (
                        username,
                        timezone_name,
                        _jsonb(
                            {
                                "source": _SETTINGS_SOURCE,
                                "settings_payload": public_settings,
                            }
                        ),
                    ),
                )
                if username and session_key:
                    connection.execute(
                        _upsert_lastfm_session_sql(),
                        (
                            username,
                            session_key,
                            _jsonb(
                                {
                                    "source": _SETTINGS_SOURCE,
                                    "connected_at": connected_at,
                                    "source_payload": public_settings,
                                }
                            ),
                        ),
                    )
                    connection.execute(_deactivate_other_lastfm_sessions_sql(), (username,))
                else:
                    connection.execute(_deactivate_lastfm_sessions_sql())
        return settings

    def load_sync_state(self) -> dict[str, object]:
        state = _empty_sync_state()
        with self._connect_to_database() as connection:
            _ensure_bootstrap_library_context(connection)
            pending_rows = list(connection.execute(_load_pending_scrobbles_sql()).fetchall())
            retry_rows = list(connection.execute(_load_scrobble_retry_state_sql()).fetchall())
        for row in pending_rows:
            row_payload = _row_mapping(row, ("source_key", "track_key", "attempt_count", "last_error", "payload"))
            source_key = _text(row_payload.get("source_key"))
            pending_payload = _source_payload(row_payload.get("payload"))
            if source_key and isinstance(pending_payload, Mapping):
                state["pending_scrobbles"][source_key] = dict(pending_payload)
        for row in retry_rows:
            row_payload = _row_mapping(
                row,
                ("source_section", "source_key", "retry_status", "attempt_count", "last_error", "metadata"),
            )
            source_section = _text(row_payload.get("source_section"))
            source_key = _text(row_payload.get("source_key"))
            retry_payload = _source_payload(row_payload.get("metadata"))
            if source_section == "sync_problems" and source_key and isinstance(retry_payload, Mapping):
                state["sync_problems"][source_key] = dict(retry_payload)
            elif source_section == "last_retry_summary" and isinstance(retry_payload, Mapping):
                state["last_retry_summary"] = dict(retry_payload)
        return state

    def save_sync_state(self, sync_state: dict[str, object]) -> dict[str, object]:
        normalized = _normalize_sync_state(sync_state)
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_library_context(connection)
                connection.execute(_delete_pending_scrobbles_sql())
                connection.execute(_delete_scrobble_retry_state_sql())
                for source_key, payload in sorted(normalized["pending_scrobbles"].items()):
                    if not isinstance(payload, dict):
                        continue
                    connection.execute(
                        _upsert_pending_scrobble_sql(),
                        (
                            normalize_track_ref(payload.get("track_ref") or payload.get("path")),
                            _nonnegative_int(payload.get("retry_count")),
                            _jsonb(
                                {
                                    "source": _SYNC_SOURCE,
                                    "source_family": _SYNC_SOURCE,
                                    "source_key": source_key,
                                    "source_payload": payload,
                                }
                            ),
                        ),
                    )
                for source_key, payload in sorted(normalized["sync_problems"].items()):
                    if not isinstance(payload, dict):
                        continue
                    connection.execute(
                        _upsert_scrobble_retry_state_sql(),
                        (
                            None,
                            _text(payload.get("provider")) or "lastfm",
                            _text(payload.get("status")) or "pending_retry",
                            _nonnegative_int(payload.get("retry_count")),
                            _text(payload.get("message") or payload.get("last_error")) or None,
                            _jsonb(
                                {
                                    "source": _SYNC_SOURCE,
                                    "source_family": _SYNC_SOURCE,
                                    "source_section": "sync_problems",
                                    "source_key": source_key,
                                    "source_payload": payload,
                                }
                            ),
                        ),
                    )
                summary = normalized["last_retry_summary"]
                if summary:
                    connection.execute(
                        _upsert_scrobble_retry_state_sql(),
                        (
                            None,
                            "lastfm",
                            "summary",
                            _nonnegative_int(summary.get("attempted")),
                            None,
                            _jsonb(
                                {
                                    "source": _SYNC_SOURCE,
                                    "source_family": _SYNC_SOURCE,
                                    "source_section": "last_retry_summary",
                                    "source_key": "last_retry_summary",
                                    "source_payload": summary,
                                }
                            ),
                        ),
                    )
        return sync_state

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required for Postgres Last.fm state.")
        return self._connect(self._database_url)


class _NoopTransaction:
    def __enter__(self) -> "_NoopTransaction":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        pass


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for Postgres Last.fm state.")
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


def _text(value: object) -> str:
    return str(value or "").strip()


def _nonnegative_int(value: object) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def normalize_track_ref(value: object) -> str:
    return str(value or "").strip()


def _empty_sync_state() -> dict[str, object]:
    return {
        "pending_scrobbles": {},
        "sync_problems": {},
        "last_retry_summary": {},
    }


def _normalize_sync_state(sync_state: dict[str, object]) -> dict[str, dict[str, object]]:
    normalized = _empty_sync_state()
    for key in normalized:
        value = sync_state.get(key) if isinstance(sync_state, dict) else None
        if isinstance(value, dict):
            normalized[key] = dict(value)
    return normalized


def _source_payload(value: object) -> object:
    if isinstance(value, Mapping):
        source_payload = value.get("source_payload")
        if isinstance(source_payload, Mapping):
            return source_payload
    return value


def _settings_from_row(row: object) -> dict[str, object]:
    payload = _row_mapping(
        row,
        (
            "provider_username",
            "timezone_name",
            "settings_payload",
            "session_key_encrypted",
            "connected_at",
        ),
    )
    raw_settings = payload.get("settings_payload")
    if isinstance(raw_settings, Mapping) and isinstance(raw_settings.get("settings_payload"), Mapping):
        settings = dict(raw_settings["settings_payload"])
    elif isinstance(raw_settings, Mapping):
        settings = {
            str(key): value
            for key, value in raw_settings.items()
            if key not in {"source", "source_family", "source_file", "source_path"}
        }
    else:
        settings = {}
    username = _text(payload.get("provider_username"))
    session_key = _text(payload.get("session_key_encrypted"))
    connected_at = _text(payload.get("connected_at"))
    timezone_name = _text(payload.get("timezone_name"))
    if username:
        settings["username"] = username
    if session_key:
        settings["session_key"] = session_key
    if connected_at:
        settings["connected_at"] = connected_at
    if timezone_name:
        settings["user_timezone"] = timezone_name
    return settings


def _ensure_bootstrap_account_context(connection: Any) -> None:
    if _first_row(connection.execute(_bootstrap_account_context_ready_sql())) is None:
        raise RuntimeError("Postgres Last.fm settings require the bootstrap local owner context.")


def _ensure_bootstrap_library_context(connection: Any) -> None:
    if _first_row(connection.execute(_bootstrap_library_context_ready_sql())) is None:
        raise RuntimeError("Postgres Last.fm sync state requires the bootstrap local owner/library context.")


def _bootstrap_account_context_sql() -> str:
    return """
        with bootstrap_context as (
          select app.bootstrap_owners.account_id
          from app.bootstrap_owners
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
    """


def _bootstrap_library_context_sql() -> str:
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


def _bootstrap_account_context_ready_sql() -> str:
    return _bootstrap_account_context_sql() + " select 1 as bootstrap_context_ready from bootstrap_context;"


def _bootstrap_library_context_ready_sql() -> str:
    return _bootstrap_library_context_sql() + " select 1 as bootstrap_context_ready from bootstrap_context;"


def _load_lastfm_settings_sql() -> str:
    return (
        _bootstrap_account_context_sql()
        + """
        select
          integration.lastfm_settings.provider_username,
          integration.lastfm_settings.timezone_name,
          integration.lastfm_settings.settings_payload,
          integration.lastfm_sessions.session_key_encrypted,
          integration.lastfm_sessions.metadata ->> 'connected_at' as connected_at
        from integration.lastfm_settings
        join bootstrap_context
          on bootstrap_context.account_id = integration.lastfm_settings.account_id
        left join integration.lastfm_sessions
          on integration.lastfm_sessions.account_id = integration.lastfm_settings.account_id
         and integration.lastfm_sessions.provider_username is not distinct from integration.lastfm_settings.provider_username
         and integration.lastfm_sessions.is_active
        limit 1;
    """
    )


def _upsert_lastfm_settings_sql() -> str:
    return (
        _bootstrap_account_context_sql()
        + """
        insert into integration.lastfm_settings (
          account_id,
          provider_username,
          timezone_name,
          settings_payload
        )
        select bootstrap_context.account_id, %s, %s, %s::jsonb
        from bootstrap_context
        on conflict (account_id) do update
          set provider_username = excluded.provider_username,
              timezone_name = excluded.timezone_name,
              settings_payload = excluded.settings_payload,
              updated_at = now();
    """
    )


def _deactivate_lastfm_sessions_sql() -> str:
    return (
        _bootstrap_account_context_sql()
        + """
        update integration.lastfm_sessions
        set is_active = false,
            updated_at = now()
        from bootstrap_context
        where integration.lastfm_sessions.account_id = bootstrap_context.account_id
          and integration.lastfm_sessions.is_active;
    """
    )


def _deactivate_other_lastfm_sessions_sql() -> str:
    return (
        _bootstrap_account_context_sql()
        + """
        update integration.lastfm_sessions
        set is_active = false,
            updated_at = now()
        from bootstrap_context
        where integration.lastfm_sessions.account_id = bootstrap_context.account_id
          and integration.lastfm_sessions.is_active
          and integration.lastfm_sessions.provider_username is distinct from %s;
    """
    )


def _upsert_lastfm_session_sql() -> str:
    return (
        _bootstrap_account_context_sql()
        + """
        insert into integration.lastfm_sessions (
          account_id,
          provider_username,
          session_key_encrypted,
          is_active,
          metadata
        )
        select bootstrap_context.account_id, %s, %s, true, %s::jsonb
        from bootstrap_context
        on conflict (account_id, provider_username)
          do update
            set session_key_encrypted = excluded.session_key_encrypted,
                is_active = true,
                updated_at = now(),
                metadata = excluded.metadata;
    """
    )


def _load_pending_scrobbles_sql() -> str:
    return (
        _bootstrap_library_context_sql()
        + f"""
        select
          integration.pending_scrobbles.payload ->> 'source_key' as source_key,
          integration.pending_scrobbles.track_key,
          integration.pending_scrobbles.attempt_count,
          integration.pending_scrobbles.payload ->> 'last_error' as last_error,
          integration.pending_scrobbles.payload
        from integration.pending_scrobbles
        join bootstrap_context
          on bootstrap_context.library_id = integration.pending_scrobbles.library_id
         and bootstrap_context.account_id = integration.pending_scrobbles.account_id
        where integration.pending_scrobbles.payload ->> 'source_family' in ('{_SYNC_SOURCE}', '{_SYNC_BACKFILL_SOURCE}')
        order by integration.pending_scrobbles.payload ->> 'source_key';
    """
    )


def _load_scrobble_retry_state_sql() -> str:
    return (
        _bootstrap_library_context_sql()
        + f"""
        select
          integration.scrobble_retry_state.metadata ->> 'source_section' as source_section,
          integration.scrobble_retry_state.metadata ->> 'source_key' as source_key,
          integration.scrobble_retry_state.retry_status,
          integration.scrobble_retry_state.attempt_count,
          integration.scrobble_retry_state.last_error,
          integration.scrobble_retry_state.metadata
        from integration.scrobble_retry_state
        join bootstrap_context
          on (
            integration.scrobble_retry_state.pending_scrobble_id is not null
            and exists (
              select 1
              from integration.pending_scrobbles
              where integration.pending_scrobbles.id = integration.scrobble_retry_state.pending_scrobble_id
                and integration.pending_scrobbles.library_id = bootstrap_context.library_id
                and integration.pending_scrobbles.account_id = bootstrap_context.account_id
            )
            or (
              integration.scrobble_retry_state.pending_scrobble_id is null
              and integration.scrobble_retry_state.metadata ->> 'account_id' = bootstrap_context.account_id::text
              and integration.scrobble_retry_state.metadata ->> 'library_id' = bootstrap_context.library_id::text
            )
          )
        where integration.scrobble_retry_state.metadata ->> 'source_family' in ('{_SYNC_SOURCE}', '{_SYNC_BACKFILL_SOURCE}')
        order by
          integration.scrobble_retry_state.metadata ->> 'source_section',
          integration.scrobble_retry_state.metadata ->> 'source_key';
    """
    )


def _delete_pending_scrobbles_sql() -> str:
    return (
        _bootstrap_library_context_sql()
        + f"""
        delete from integration.pending_scrobbles
        using bootstrap_context
        where integration.pending_scrobbles.library_id = bootstrap_context.library_id
          and integration.pending_scrobbles.account_id = bootstrap_context.account_id
          and integration.pending_scrobbles.payload ->> 'source_family' in ('{_SYNC_SOURCE}', '{_SYNC_BACKFILL_SOURCE}');
    """
    )


def _delete_scrobble_retry_state_sql() -> str:
    return (
        _bootstrap_library_context_sql()
        + f"""
        delete from integration.scrobble_retry_state
        using bootstrap_context
        where integration.scrobble_retry_state.metadata ->> 'source_family' in ('{_SYNC_SOURCE}', '{_SYNC_BACKFILL_SOURCE}')
          and (
            integration.scrobble_retry_state.pending_scrobble_id is not null
            and exists (
              select 1
              from integration.pending_scrobbles
              where integration.pending_scrobbles.id = integration.scrobble_retry_state.pending_scrobble_id
                and integration.pending_scrobbles.library_id = bootstrap_context.library_id
                and integration.pending_scrobbles.account_id = bootstrap_context.account_id
            )
            or (
              integration.scrobble_retry_state.pending_scrobble_id is null
              and integration.scrobble_retry_state.metadata ->> 'account_id' = bootstrap_context.account_id::text
              and integration.scrobble_retry_state.metadata ->> 'library_id' = bootstrap_context.library_id::text
            )
          )
    """
    )


def _upsert_pending_scrobble_sql() -> str:
    return (
        _bootstrap_library_context_sql()
        + f"""
        insert into integration.pending_scrobbles (
          library_id,
          account_id,
          track_key,
          played_at,
          attempt_count,
          status,
          payload
        )
        select
          bootstrap_context.library_id,
          bootstrap_context.account_id,
          %s,
          '{datetime(1970, 1, 1, tzinfo=timezone.utc).isoformat()}'::timestamptz,
          %s,
          'pending',
          %s::jsonb
            || jsonb_build_object(
              'account_id', bootstrap_context.account_id::text,
              'library_id', bootstrap_context.library_id::text
            )
        from bootstrap_context
        on conflict (
          account_id,
          library_id,
          (payload->>'source_family'),
          (payload->>'source_key')
        )
          where account_id is not null
            and library_id is not null
            and payload ? 'source_family'
            and payload ? 'source_key'
          do update
            set track_key = excluded.track_key,
                attempt_count = excluded.attempt_count,
                status = excluded.status,
                payload = excluded.payload,
                updated_at = now();
    """
    )


def _upsert_scrobble_retry_state_sql() -> str:
    return (
        _bootstrap_library_context_sql()
        + """
        insert into integration.scrobble_retry_state (
          pending_scrobble_id,
          provider_name,
          retry_status,
          attempt_count,
          last_attempt_at,
          last_error,
          metadata
        )
        select
          %s,
          %s,
          %s,
          %s,
          now(),
          %s,
          %s::jsonb
            || jsonb_build_object(
              'account_id', bootstrap_context.account_id::text,
              'library_id', bootstrap_context.library_id::text
            )
        from bootstrap_context
        on conflict (
          (metadata->>'account_id'),
          (metadata->>'library_id'),
          (metadata->>'source_family'),
          (metadata->>'source_section'),
          (metadata->>'source_key')
        )
          where metadata ? 'account_id'
            and metadata ? 'library_id'
            and metadata ? 'source_family'
            and metadata ? 'source_section'
            and metadata ? 'source_key'
          do update
            set pending_scrobble_id = excluded.pending_scrobble_id,
                provider_name = excluded.provider_name,
                retry_status = excluded.retry_status,
                attempt_count = excluded.attempt_count,
                last_attempt_at = excluded.last_attempt_at,
                last_error = excluded.last_error,
                metadata = excluded.metadata;
    """
    )
