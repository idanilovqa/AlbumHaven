from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

try:  # pragma: no cover - exercised only when the optional runtime driver exists.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - keeps non-Postgres tooling importable.
    psycopg = None
    dict_row = None


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"


class PostgresVirtualArtistSnapshotStore:
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
        refs = [str(row["virtual_artist_ref"]) for row in normalized_rows]
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                connection.execute(_mark_removed_snapshot_rows_sql(), (len(refs), refs))
                for row in normalized_rows:
                    cursor = connection.execute(
                        _upsert_snapshot_row_sql(),
                        (
                            row["virtual_artist_ref"],
                            row["candidate_ref"],
                            row["provider"],
                            row["provider_artist_id"],
                            row["display_name"],
                            row["sort_name"],
                            row["disambiguation_text"],
                            row["default_release_scope"],
                            row["created_at"],
                            row["expires_at"],
                        ),
                    )
                    if _first_row(cursor) is None:
                        raise RuntimeError(
                            "Postgres virtual artist snapshot write did not write a row."
                        )

    def load_recent_lookup_rows(self) -> list[dict[str, object]]:
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            rows = list(connection.execute(_load_recent_lookup_rows_sql()).fetchall())
        return [_recent_lookup_row_from_database(row) for row in rows]

    def save_recent_lookup_rows(self, rows: list[dict[str, object]]) -> None:
        normalized_rows = [
            row for row in (_normalize_recent_lookup_row(item) for item in rows) if row
        ]
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                connection.execute(_mark_removed_recent_lookup_rows_sql())
                for row in normalized_rows:
                    cursor = connection.execute(
                        _upsert_recent_lookup_row_sql(),
                        (
                            row["actor_key"],
                            row["virtual_artist_ref"],
                            row["active_release_scope"],
                            row["recorded_at"],
                        ),
                    )
                    if _first_row(cursor) is None:
                        raise RuntimeError(
                            "Postgres virtual artist recent lookup write did not write a row."
                        )

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError(
                "Virtual artist snapshot runtime persistence is Postgres-only."
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
            "Virtual artist snapshot runtime persistence is Postgres-only."
        )
    return psycopg.connect(database_url, row_factory=dict_row)


def _transaction(connection: Any) -> Any:
    transaction = getattr(connection, "transaction", None)
    if callable(transaction):
        return transaction()
    return _NoopTransaction()


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


def _normalize_snapshot_row(row: object) -> dict[str, object] | None:
    if not isinstance(row, dict):
        return None
    virtual_artist_ref = _text(row.get("virtual_artist_ref"))
    if not virtual_artist_ref:
        return None
    return {
        "virtual_artist_ref": virtual_artist_ref,
        "candidate_ref": _text(row.get("candidate_ref")),
        "provider": _text(row.get("provider")) or "musicbrainz",
        "provider_artist_id": _text(row.get("provider_artist_id")),
        "display_name": _text(row.get("display_name")),
        "sort_name": _text(row.get("sort_name")),
        "disambiguation_text": _text(row.get("disambiguation_text")),
        "default_release_scope": _text(row.get("default_release_scope")) or "studio_ep",
        "created_at": _text(row.get("created_at")),
        "expires_at": _text(row.get("expires_at")),
    }


def _normalize_recent_lookup_row(row: object) -> dict[str, object] | None:
    if not isinstance(row, dict):
        return None
    actor_key = _text(row.get("actor_key"))
    virtual_artist_ref = _text(row.get("virtual_artist_ref"))
    if not actor_key or not virtual_artist_ref:
        return None
    return {
        "actor_key": actor_key,
        "virtual_artist_ref": virtual_artist_ref,
        "active_release_scope": _text(row.get("active_release_scope")) or "studio_ep",
        "recorded_at": _text(row.get("recorded_at")) or None,
    }


def _snapshot_row_from_database(row: object) -> dict[str, object]:
    row_payload = _row_mapping(row)
    return {
        "virtual_artist_ref": _text(row_payload.get("virtual_artist_ref")),
        "candidate_ref": _text(row_payload.get("candidate_ref")),
        "provider": _text(row_payload.get("provider")) or "musicbrainz",
        "provider_artist_id": _text(row_payload.get("provider_artist_id")),
        "display_name": _text(row_payload.get("display_name")),
        "sort_name": _text(row_payload.get("sort_name")),
        "disambiguation_text": _text(row_payload.get("disambiguation_text")),
        "default_release_scope": _text(row_payload.get("default_release_scope")),
        "created_at": _text(row_payload.get("created_at")),
        "expires_at": _text(row_payload.get("expires_at")),
    }


def _recent_lookup_row_from_database(row: object) -> dict[str, object]:
    row_payload = _row_mapping(row)
    return {
        "actor_key": _text(row_payload.get("actor_key")),
        "virtual_artist_ref": _text(row_payload.get("virtual_artist_ref")),
        "active_release_scope": _text(row_payload.get("active_release_scope")),
        "recorded_at": _text(row_payload.get("recorded_at")) or None,
    }


def _ensure_bootstrap_context(connection: Any) -> None:
    if _first_row(connection.execute(_bootstrap_context_ready_sql())) is None:
        raise RuntimeError(
            "Postgres virtual artist snapshots require the bootstrap local owner context."
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
          app.virtual_artist_snapshots.virtual_artist_ref,
          app.virtual_artist_snapshots.candidate_ref,
          app.virtual_artist_snapshots.provider,
          app.virtual_artist_snapshots.provider_artist_id,
          app.virtual_artist_snapshots.display_name,
          app.virtual_artist_snapshots.sort_name,
          app.virtual_artist_snapshots.disambiguation_text,
          app.virtual_artist_snapshots.default_release_scope,
          app.virtual_artist_snapshots.created_at,
          app.virtual_artist_snapshots.expires_at
        from app.virtual_artist_snapshots
        join bootstrap_context
          on bootstrap_context.account_id = app.virtual_artist_snapshots.account_id
        where app.virtual_artist_snapshots.metadata ->> 'removed' is distinct from 'true'
        order by app.virtual_artist_snapshots.created_at desc,
                 app.virtual_artist_snapshots.virtual_artist_ref;
    """
    )


def _mark_removed_snapshot_rows_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        update app.virtual_artist_snapshots
           set metadata = app.virtual_artist_snapshots.metadata
                 || '{"removed":true,"source":"runtime_virtual_artist_snapshot_adapter"}'::jsonb,
               updated_at = now()
        from bootstrap_context
        where app.virtual_artist_snapshots.account_id = bootstrap_context.account_id
          and (
            %s = 0
            or app.virtual_artist_snapshots.virtual_artist_ref <> all(%s::text[])
          );
    """
    )


def _upsert_snapshot_row_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        insert into app.virtual_artist_snapshots (
          account_id,
          virtual_artist_ref,
          candidate_ref,
          provider,
          provider_artist_id,
          display_name,
          sort_name,
          disambiguation_text,
          default_release_scope,
          created_at,
          expires_at,
          metadata
        )
        select
          bootstrap_context.account_id,
          %s,
          %s,
          %s,
          %s,
          %s,
          %s,
          %s,
          %s,
          %s::timestamptz,
          %s::timestamptz,
          '{"source":"runtime_virtual_artist_snapshot_adapter"}'::jsonb
        from bootstrap_context
        on conflict (account_id, virtual_artist_ref) do update
          set candidate_ref = excluded.candidate_ref,
              provider = excluded.provider,
              provider_artist_id = excluded.provider_artist_id,
              display_name = excluded.display_name,
              sort_name = excluded.sort_name,
              disambiguation_text = excluded.disambiguation_text,
              default_release_scope = excluded.default_release_scope,
              created_at = excluded.created_at,
              expires_at = excluded.expires_at,
              metadata = excluded.metadata,
              updated_at = now()
        returning 1 as saved;
    """
    )


def _load_recent_lookup_rows_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        select
          app.virtual_artist_recent_lookups.actor_key,
          app.virtual_artist_recent_lookups.virtual_artist_ref,
          app.virtual_artist_recent_lookups.active_release_scope,
          app.virtual_artist_recent_lookups.recorded_at
        from app.virtual_artist_recent_lookups
        join bootstrap_context
          on bootstrap_context.account_id = app.virtual_artist_recent_lookups.account_id
        where app.virtual_artist_recent_lookups.metadata ->> 'removed' is distinct from 'true'
        order by app.virtual_artist_recent_lookups.recorded_at desc,
                 app.virtual_artist_recent_lookups.id desc;
    """
    )


def _mark_removed_recent_lookup_rows_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        update app.virtual_artist_recent_lookups
           set metadata = app.virtual_artist_recent_lookups.metadata
                 || '{"removed":true,"source":"runtime_virtual_artist_snapshot_adapter"}'::jsonb,
               updated_at = now()
        from bootstrap_context
        where app.virtual_artist_recent_lookups.account_id = bootstrap_context.account_id;
    """
    )


def _upsert_recent_lookup_row_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        insert into app.virtual_artist_recent_lookups (
          account_id,
          actor_key,
          virtual_artist_ref,
          active_release_scope,
          recorded_at,
          metadata
        )
        select
          bootstrap_context.account_id,
          %s,
          %s,
          %s,
          coalesce(%s::timestamptz, now()),
          '{"source":"runtime_virtual_artist_snapshot_adapter"}'::jsonb
        from bootstrap_context
        on conflict (account_id, actor_key, virtual_artist_ref) do update
          set active_release_scope = excluded.active_release_scope,
              recorded_at = excluded.recorded_at,
              metadata = excluded.metadata,
              updated_at = now()
        returning 1 as saved;
    """
    )
