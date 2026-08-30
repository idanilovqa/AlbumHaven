from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime
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
_SOURCE = "runtime_saved_loops_adapter"


def is_saved_loops_postgres_available(config: dict[str, object] | None) -> bool:
    if not isinstance(config, dict):
        return False
    database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
    return bool(database_url) and psycopg is not None and callable(getattr(psycopg, "connect", None))


class SavedLoopsPostgresAdapter:
    def __init__(
        self,
        config: dict[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def load_loops(self) -> list[dict[str, object]]:
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            rows = list(connection.execute(_load_saved_loops_sql()).fetchall())
        return [_loop_from_row(row) for row in rows]

    def save_loops(self, loops: list[dict[str, object]]) -> None:
        normalized_loops = [
            loop
            for loop in (_normalize_loop(item, source_index=index) for index, item in enumerate(loops or []))
            if loop is not None
        ]
        loop_keys = [str(loop["loop_key"]) for loop in normalized_loops]
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                connection.execute(_mark_removed_saved_loops_sql(), (len(loop_keys), loop_keys))
                for loop in normalized_loops:
                    cursor = connection.execute(
                        _upsert_saved_loop_sql(),
                        {
                            "loop_key": loop["loop_key"],
                            "source_private_path": loop["source_private_path"],
                            "loop_private_path": loop["loop_private_path"],
                            "start_seconds": loop["start_seconds"],
                            "end_seconds": loop["end_seconds"],
                            "created_at": loop["created_at"],
                            "parent_loop_key": loop["metadata"].get("parent_loop_key"),
                            "artist": loop["metadata"].get("source_payload", {}).get("artist"),
                            "album": loop["metadata"].get("source_payload", {}).get("album"),
                            "title": loop["metadata"].get("source_payload", {}).get("title"),
                            "metadata": _jsonb(loop["metadata"]),
                        },
                    )
                    if _first_row(cursor) is None:
                        raise RuntimeError(
                            f"Postgres saved loop write did not write row for {loop['loop_key']!r}."
                        )
                connection.execute(_link_saved_loop_parents_sql())

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required for Postgres saved loops.")
        return self._connect(self._database_url)


class _NoopTransaction:
    def __enter__(self) -> "_NoopTransaction":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        pass


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for Postgres saved loops.")
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
    if isinstance(row, (tuple, list)):
        fields = (
            "loop_key",
            "source_private_path",
            "loop_private_path",
            "start_seconds",
            "end_seconds",
            "created_at",
            "metadata",
            "parent_loop_key",
        )
        return {field: row[index] for index, field in enumerate(fields) if index < len(row)}
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
        raise RuntimeError("Postgres saved loops require the bootstrap local owner/library context.")


def _text(value: object) -> str:
    return str(value or "").strip()


def _float_value(value: object, default: float = 0.0) -> float:
    try:
        return round(float(value), 3)
    except (TypeError, ValueError):
        return default


def _strict_float_value(value: object) -> float | None:
    try:
        return round(float(value), 3)
    except (TypeError, ValueError):
        return None


def _timestamp_text(value: object) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return _text(value)


def _loop_from_row(row: object) -> dict[str, object]:
    row_payload = _row_mapping(row)
    metadata = row_payload.get("metadata")
    metadata_dict = metadata if isinstance(metadata, Mapping) else {}
    source_payload = metadata_dict.get("source_payload")
    loop = dict(source_payload) if isinstance(source_payload, Mapping) else {}

    loop_key = _text(row_payload.get("loop_key"))
    if loop_key:
        loop["id"] = loop_key
    loop_path = _text(row_payload.get("loop_private_path"))
    if loop_path:
        loop["path"] = loop_path
    source_path = _text(row_payload.get("source_private_path"))
    if source_path:
        loop["source_path"] = source_path
    if "start_seconds" in row_payload:
        loop["start_seconds"] = _float_value(row_payload.get("start_seconds"))
    if "end_seconds" in row_payload:
        loop["end_seconds"] = _float_value(row_payload.get("end_seconds"))
    if "duration_seconds" not in loop:
        loop["duration_seconds"] = round(
            _float_value(row_payload.get("end_seconds")) - _float_value(row_payload.get("start_seconds")),
            3,
        )
    parent_loop_key = _text(row_payload.get("parent_loop_key") or metadata_dict.get("parent_loop_key"))
    loop["parent_loop_id"] = parent_loop_key
    created_at = _timestamp_text(row_payload.get("created_at"))
    if created_at and not _text(loop.get("created_at")):
        loop["created_at"] = created_at
    return loop


def _normalize_loop(item: object, *, source_index: int) -> dict[str, object] | None:
    if not isinstance(item, dict):
        return None
    loop_key = _text(item.get("id"))
    if not loop_key:
        return None
    start_seconds = _strict_float_value(item.get("start_seconds"))
    end_seconds = _strict_float_value(item.get("end_seconds"))
    if start_seconds is None or end_seconds is None or end_seconds <= start_seconds:
        return None
    metadata = {
        "source": _SOURCE,
        "source_family": "saved_loops",
        "source_key": loop_key,
        "source_index": source_index,
        "parent_loop_key": _text(item.get("parent_loop_id")),
        "loop_media_storage": "filesystem",
        "pitch_preview_storage": "filesystem",
        "source_payload": dict(item),
    }
    return {
        "loop_key": loop_key,
        "source_private_path": _text(item.get("source_path")) or None,
        "loop_private_path": _text(item.get("path")) or None,
        "start_seconds": start_seconds,
        "end_seconds": end_seconds,
        "created_at": _text(item.get("created_at")) or None,
        "metadata": metadata,
    }


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


def _load_saved_loops_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        select
          saved_loop.loop_key,
          saved_loop.source_private_path,
          saved_loop.loop_private_path,
          saved_loop.start_seconds,
          saved_loop.end_seconds,
          saved_loop.created_at,
          saved_loop.metadata,
          parent_loop.loop_key as parent_loop_key
        from app.saved_loops as saved_loop
        join bootstrap_context
          on bootstrap_context.account_id = saved_loop.account_id
         and bootstrap_context.library_id = saved_loop.library_id
        left join app.saved_loops as parent_loop
          on parent_loop.id = saved_loop.parent_loop_id
        where saved_loop.metadata ->> 'removed' is distinct from 'true'
        order by
          case
            when saved_loop.metadata ->> 'source_index' ~ '^[0-9]+$'
              then (saved_loop.metadata ->> 'source_index')::integer
            else 2147483647
          end,
          saved_loop.created_at desc,
          saved_loop.loop_key;
    """
    )


def _mark_removed_saved_loops_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        update app.saved_loops
           set parent_loop_id = null,
               updated_at = now(),
               metadata = app.saved_loops.metadata
                 || '{"source":"runtime_saved_loops_adapter","removed":true}'::jsonb
        from bootstrap_context
        where app.saved_loops.account_id = bootstrap_context.account_id
          and app.saved_loops.library_id = bootstrap_context.library_id
          and (
            %s = 0
            or app.saved_loops.loop_key <> all(%s::text[])
          );
    """
    )


def _upsert_saved_loop_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        , parent_loop_match as (
          select
            parent_loop.id,
            parent_loop.track_id
          from app.saved_loops as parent_loop
          join bootstrap_context
            on bootstrap_context.account_id = parent_loop.account_id
           and bootstrap_context.library_id = parent_loop.library_id
          where parent_loop.loop_key = nullif(%(parent_loop_key)s, '')
          limit 1
        ),
        source_track_match as (
          select local_track_files.track_id
          from library.local_track_files
          join library.local_tracks
            on library.local_tracks.id = local_track_files.track_id
          join bootstrap_context
            on bootstrap_context.library_id = library.local_tracks.library_id
          where local_track_files.private_path = %(source_private_path)s
          order by local_track_files.last_seen_at desc, local_track_files.id desc
          limit 1
        ),
        metadata_track_candidates as (
          select library.local_tracks.id as track_id
          from library.local_tracks
          join library.local_albums
            on library.local_albums.id = library.local_tracks.album_id
          left join library.local_artists
            on library.local_artists.id = coalesce(
              library.local_tracks.artist_id,
              library.local_albums.artist_id
            )
          join bootstrap_context
            on bootstrap_context.library_id = library.local_tracks.library_id
           and bootstrap_context.library_id = library.local_albums.library_id
          where nullif(btrim(%(title)s), '') is not null
            and nullif(btrim(%(album)s), '') is not null
            and nullif(btrim(%(artist)s), '') is not null
            and lower(btrim(library.local_tracks.title)) = lower(btrim(%(title)s))
            and lower(btrim(library.local_albums.title)) = lower(btrim(%(album)s))
            and lower(btrim(coalesce(library.local_artists.name, ''))) = lower(btrim(%(artist)s))
        ),
        metadata_track_match as (
          select min(track_id) as track_id
          from metadata_track_candidates
          having count(*) = 1
        )
        insert into app.saved_loops (
          account_id,
          library_id,
          track_id,
          loop_key,
          source_private_path,
          loop_private_path,
          start_seconds,
          end_seconds,
          created_at,
          metadata
        )
        select
          bootstrap_context.account_id,
          bootstrap_context.library_id,
          coalesce(
            (select track_id from parent_loop_match),
            (select track_id from source_track_match),
            (select track_id from metadata_track_match)
          ),
          %(loop_key)s,
          %(source_private_path)s,
          %(loop_private_path)s,
          %(start_seconds)s,
          %(end_seconds)s,
          coalesce(%(created_at)s::timestamptz, now()),
          %(metadata)s::jsonb
        from bootstrap_context
        on conflict (account_id, library_id, loop_key)
          where account_id is not null
            and library_id is not null
          do update
          set track_id = coalesce(excluded.track_id, app.saved_loops.track_id),
              source_private_path = excluded.source_private_path,
              loop_private_path = excluded.loop_private_path,
              start_seconds = excluded.start_seconds,
              end_seconds = excluded.end_seconds,
              parent_loop_id = null,
              updated_at = now(),
              metadata = excluded.metadata
        returning 1 as saved;
    """
    )


def _link_saved_loop_parents_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        , parent_loop_match as (
          select
            child_loop.id as child_id,
            parent_loop.id as parent_id,
            parent_loop.track_id
          from app.saved_loops as child_loop
          join bootstrap_context
            on bootstrap_context.account_id = child_loop.account_id
           and bootstrap_context.library_id = child_loop.library_id
          join app.saved_loops as parent_loop
            on parent_loop.account_id = bootstrap_context.account_id
           and parent_loop.library_id = bootstrap_context.library_id
           and parent_loop.loop_key = child_loop.metadata ->> 'parent_loop_key'
          where child_loop.metadata ? 'parent_loop_key'
            and child_loop.metadata ->> 'parent_loop_key' <> ''
            and child_loop.metadata ->> 'removed' is distinct from 'true'
            and parent_loop.metadata ->> 'removed' is distinct from 'true'
        )
        update app.saved_loops as child_loop
           set parent_loop_id = parent_loop_match.parent_id,
               track_id = coalesce(child_loop.track_id, parent_loop_match.track_id),
               updated_at = now()
        from parent_loop_match
        where child_loop.id = parent_loop_match.child_id;
    """
    )
