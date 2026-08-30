from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

try:  # pragma: no cover - exercised only when the optional runtime driver exists.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - keeps the module importable without psycopg.
    psycopg = None
    dict_row = None


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_LOCAL_ACTOR_ID = "local"


def is_track_preferences_postgres_available(config: dict[str, object] | None) -> bool:
    if not isinstance(config, dict):
        return False
    return psycopg is not None and bool(str(config.get(_APP_DATABASE_URL_KEY) or "").strip())


class PostgresTrackPreferencesStore:
    def __init__(
        self,
        config: dict[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def load_store(self) -> dict[str, object]:
        from music_app.services.track_preferences import normalize_track_preferences_store

        rows: dict[str, object] = {}
        with self._connect_to_database() as connection:
            cursor = connection.execute(_load_track_preferences_sql())
            for row in cursor.fetchall():
                row_payload = _row_mapping(row)
                track_key = row_payload.get("track_key")
                if not track_key:
                    continue
                rows[str(track_key)] = {
                    "rating": row_payload.get("rating"),
                    "love_tier": row_payload.get("love_tier"),
                }
        return normalize_track_preferences_store(
            {"actors": {_LOCAL_ACTOR_ID: {"track_preferences": rows}}}
        )

    def load_track_preferences(
        self,
        track_refs: list[str] | tuple[str, ...],
    ) -> dict[str, dict[str, object]]:
        normalized_track_refs = [
            str(track_ref or "").strip()
            for track_ref in track_refs
            if str(track_ref or "").strip()
        ]
        if not normalized_track_refs:
            return {}
        rows: dict[str, dict[str, object]] = {}
        with self._connect_to_database() as connection:
            cursor = connection.execute(
                _load_track_preferences_by_track_refs_sql(),
                {"track_refs": normalized_track_refs},
            )
            for row in cursor.fetchall():
                row_payload = _row_mapping(row)
                track_key = str(row_payload.get("track_key") or "").strip()
                if not track_key:
                    continue
                rows[track_key] = {
                    "rating": row_payload.get("rating"),
                    "love_tier": row_payload.get("love_tier"),
                }
        return rows

    def save_store(self, raw_payload: object) -> dict[str, object]:
        from music_app.services.track_preferences import normalize_track_preferences_store

        normalized_payload = normalize_track_preferences_store(raw_payload)
        local_preferences = _local_track_preferences(normalized_payload)
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            connection.execute(_neutralize_local_track_preferences_sql())
            for track_key, overlay in local_preferences.items():
                if not isinstance(overlay, dict):
                    continue
                cursor = connection.execute(
                    _upsert_local_track_preference_sql(),
                    (track_key, overlay.get("rating"), overlay.get("love_tier")),
                )
                if cursor.fetchone() is None:
                    raise RuntimeError(
                        f"Postgres track preference write did not write row for {track_key!r}."
                    )
        return normalized_payload

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required for Postgres track preferences.")
        return self._connect(self._database_url)


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for Postgres track preferences.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _row_mapping(row: object) -> Mapping[str, object]:
    if isinstance(row, Mapping):
        return row
    if isinstance(row, (tuple, list)) and len(row) >= 3:
        return {"track_key": row[0], "rating": row[1], "love_tier": row[2]}
    return {}


def _local_track_preferences(normalized_payload: dict[str, object]) -> dict[str, object]:
    actors = normalized_payload.get("actors")
    local_actor = actors.get(_LOCAL_ACTOR_ID) if isinstance(actors, dict) else None
    preferences = (
        local_actor.get("track_preferences")
        if isinstance(local_actor, dict) and isinstance(local_actor.get("track_preferences"), dict)
        else {}
    )
    return dict(preferences)


def _ensure_bootstrap_context(connection: Any) -> None:
    cursor = connection.execute(_bootstrap_context_ready_sql())
    if cursor.fetchone() is None:
        raise RuntimeError(
            "Postgres track preferences require the bootstrap local owner/library context."
        )


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
    return (
        _bootstrap_context_sql()
        + """
        select 1 as bootstrap_context_ready
        from bootstrap_context;
    """
    )


def _load_track_preferences_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        select
          app.track_preferences.track_key,
          app.track_preferences.rating,
          app.track_preferences.love_tier
        from app.track_preferences
        join bootstrap_context
          on bootstrap_context.account_id = app.track_preferences.account_id
         and bootstrap_context.library_id = app.track_preferences.library_id
        order by app.track_preferences.track_key;
    """
    )


def _load_track_preferences_by_track_refs_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        select
          app.track_preferences.track_key,
          app.track_preferences.rating,
          app.track_preferences.love_tier
        from app.track_preferences
        join bootstrap_context
          on bootstrap_context.account_id = app.track_preferences.account_id
         and bootstrap_context.library_id = app.track_preferences.library_id
        where app.track_preferences.track_key = any(%(track_refs)s)
        order by app.track_preferences.track_key;
    """
    )


def _neutralize_local_track_preferences_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        update app.track_preferences
        set rating = null,
            love_tier = 'off',
            updated_at = now(),
            metadata = app.track_preferences.metadata
              || '{"source":"runtime_track_preferences_adapter","actor_id":"local","cleared":true}'::jsonb
        from bootstrap_context
        where app.track_preferences.account_id = bootstrap_context.account_id
          and app.track_preferences.library_id = bootstrap_context.library_id;
    """
    )


def _upsert_local_track_preference_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        insert into app.track_preferences (
          account_id,
          library_id,
          track_key,
          rating,
          love_tier,
          metadata
        )
        select
          bootstrap_context.account_id,
          bootstrap_context.library_id,
          %s,
          %s,
          %s,
          '{"source":"runtime_track_preferences_adapter","actor_id":"local"}'::jsonb
        from bootstrap_context
        on conflict (account_id, track_key) do update
          set rating = excluded.rating,
              love_tier = excluded.love_tier,
              library_id = excluded.library_id,
              updated_at = now(),
              metadata = (app.track_preferences.metadata - 'cleared') || excluded.metadata
        returning 1 as saved;
    """
    )
