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
_SOURCE = "runtime_cover_lookup_notifications_adapter"
_SOURCE_FAMILIES = ("cover_lookup_notifications", _SOURCE)
_PROVIDER_PAYLOAD_KEYS = (
    "possible_matches",
    "manual_urls",
    "selected_candidate_id",
    "caa_empty_notice",
    "job_contract",
)


def is_cover_lookup_tasks_postgres_available(config: dict[str, object] | None) -> bool:
    if not isinstance(config, dict):
        return False
    database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
    return bool(database_url) and psycopg is not None and callable(getattr(psycopg, "connect", None))


class CoverLookupTasksPostgresAdapter:
    def __init__(
        self,
        config: dict[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def load_notifications(self) -> list[dict[str, object]]:
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            rows = list(connection.execute(_load_notifications_sql()).fetchall())
        tasks = [_task_from_row(row) for row in rows]
        return [task for task in tasks if str(task.get("id") or "").strip()]

    def save_notifications(self, tasks: list[dict[str, object]]) -> None:
        normalized_tasks = [
            task
            for task in (_normalize_task(item) for item in (tasks or []))
            if task is not None
        ]
        task_keys = [str(task["id"]) for task in normalized_tasks]
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                connection.execute(_delete_removed_notifications_sql(), (len(task_keys), task_keys))
                for source_index, task in enumerate(normalized_tasks):
                    row = _task_row(task, source_index=source_index)
                    connection.execute(
                        _upsert_notification_sql(),
                        (
                            row["task_key"],
                            row["status"],
                            row["requested_at"],
                            row["completed_at"],
                            row["album_key"],
                            row["selected_cover_private_path"],
                            _jsonb(row["provider_payload"]),
                            row["error_message"],
                            _jsonb(row["metadata"]),
                        ),
                    )

    def upsert_notification(
        self,
        task: dict[str, object],
        *,
        persistence_revision: int | None = None,
    ) -> None:
        normalized_task = _normalize_task(task)
        if normalized_task is None:
            return
        row = _task_row(
            normalized_task,
            source_index=0,
            persistence_revision=persistence_revision,
        )
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                connection.execute(
                    _upsert_notification_sql(),
                    (
                        row["task_key"],
                        row["status"],
                        row["requested_at"],
                        row["completed_at"],
                        row["album_key"],
                        row["selected_cover_private_path"],
                        _jsonb(row["provider_payload"]),
                        row["error_message"],
                        _jsonb(row["metadata"]),
                    ),
                )

    def delete_notifications(self, task_ids: set[str]) -> set[str]:
        normalized_ids = sorted({_text(task_id) for task_id in task_ids if _text(task_id)})
        if not normalized_ids:
            return set()
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                cursor = connection.execute(_delete_notifications_sql(), (normalized_ids,))
                rows = list(cursor.fetchall()) if callable(getattr(cursor, "fetchall", None)) else []
        return {
            _text(_row_mapping(row).get("task_key"))
            for row in rows
            if _text(_row_mapping(row).get("task_key"))
        }

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for Postgres cover lookup tasks."
            )
        return self._connect(self._database_url)


class _NoopTransaction:
    def __enter__(self) -> "_NoopTransaction":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        pass


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for Postgres cover lookup tasks.")
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
            "task_key",
            "status",
            "requested_at",
            "completed_at",
            "album_key",
            "selected_cover_private_path",
            "provider_payload",
            "error_message",
            "metadata",
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
        raise RuntimeError("Postgres cover lookup tasks require the bootstrap local library context.")


def _text(value: object) -> str:
    return str(value or "").strip()


def _timestamp_text(value: object) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return _text(value)


def _sanitize_json_payload(value: object) -> object:
    if isinstance(value, dict):
        sanitized: dict[str, object] = {}
        for key, item in value.items():
            normalized_key = str(key or "")
            if normalized_key in {"prefetched_raw_bytes", "raw_bytes"}:
                continue
            if isinstance(item, bytes):
                continue
            sanitized[normalized_key] = _sanitize_json_payload(item)
        return sanitized
    if isinstance(value, list):
        return [_sanitize_json_payload(item) for item in value]
    if isinstance(value, tuple | set):
        return [_sanitize_json_payload(item) for item in value]
    if isinstance(value, bytes):
        return None
    return value


def _normalize_task(item: object) -> dict[str, object] | None:
    sanitized = _sanitize_json_payload(item)
    if not isinstance(sanitized, dict):
        return None
    task_id = _text(sanitized.get("id"))
    if not task_id:
        return None
    sanitized["id"] = task_id
    return sanitized


def _provider_payload(payload: dict[str, object]) -> dict[str, object]:
    return {key: payload.get(key) for key in _PROVIDER_PAYLOAD_KEYS if key in payload}


def _album_key(payload: dict[str, object]) -> str | None:
    album_payload = payload.get("album_payload")
    album_payload_dict = album_payload if isinstance(album_payload, dict) else {}
    artist = _text(
        payload.get("artist")
        or payload.get("album_artist")
        or album_payload_dict.get("album_artist")
    )
    album = _text(
        payload.get("album")
        or payload.get("name")
        or album_payload_dict.get("name")
        or album_payload_dict.get("album")
    )
    year = _text(payload.get("year") or album_payload_dict.get("year"))
    parts = [_local_inventory_key(part) for part in (artist, album, year) if _text(part)]
    return "|".join(parts) if parts else None


def _local_inventory_key(value: object) -> str:
    return " ".join(_text(value).casefold().split())


def _selected_cover_private_path(payload: dict[str, object]) -> str | None:
    for key in (
        "selected_cover_private_path",
        "selected_cover_path",
        "local_cover_path",
        "cover_path",
    ):
        value = _local_private_cover_path(payload.get(key))
        if value:
            return value
    updated_albums = payload.get("updated_albums")
    if isinstance(updated_albums, list):
        for album in updated_albums:
            if not isinstance(album, dict):
                continue
            for key in (
                "selected_cover_private_path",
                "selected_cover_path",
                "local_cover_path",
                "cover_path",
            ):
                value = _local_private_cover_path(album.get(key))
                if value:
                    return value
    return None


def _local_private_cover_path(value: object) -> str | None:
    candidate = _text(value)
    if candidate and not candidate.lower().startswith(("http://", "https://")):
        return candidate
    return None


def _error_message(payload: dict[str, object], status: str) -> str | None:
    for key in ("error", "error_message", "message"):
        value = _text(payload.get(key))
        if value and (status in {"failed", "canceled"} or key != "message"):
            return value
    return None


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list | tuple | set):
        return []
    return [_text(item) for item in value if _text(item)]


def _task_row(
    payload: dict[str, object],
    *,
    source_index: int,
    persistence_revision: int | None = None,
) -> dict[str, object]:
    task_id = _text(payload.get("id"))
    status = _text(payload.get("status")) or "completed"
    completed_at = _text(payload.get("notification_completed_at")) or None
    if completed_at is None and status.casefold() in {"completed", "failed", "canceled"}:
        completed_at = (
            _text(payload.get("finished_at"))
            or _text(payload.get("updated_at"))
            or _text(payload.get("created_at"))
            or None
        )
    requested_at = _text(payload.get("created_at")) or completed_at or "1970-01-01T00:00:00+00:00"
    provider_payload = _provider_payload(payload)
    metadata = {
        "source_family": _SOURCE,
        "source": _SOURCE,
        "source_key": task_id,
        "source_index": source_index,
        "notification_action_taken": bool(payload.get("notification_action_taken")),
        "notification_completed_at": completed_at,
        "notification_expires_at": _text(payload.get("notification_expires_at")),
        "track_paths": _string_list(payload.get("track_paths")),
        "source_payload": payload,
    }
    if persistence_revision is not None:
        metadata["persistence_revision"] = max(0, int(persistence_revision))
    return {
        "task_key": task_id,
        "status": status,
        "requested_at": requested_at,
        "completed_at": completed_at,
        "album_key": _album_key(payload),
        "selected_cover_private_path": _selected_cover_private_path(payload),
        "provider_payload": provider_payload,
        "error_message": _error_message(payload, status),
        "metadata": metadata,
    }


def _task_from_row(row: object) -> dict[str, object]:
    row_payload = _row_mapping(row)
    metadata = row_payload.get("metadata")
    metadata_dict = metadata if isinstance(metadata, Mapping) else {}
    source_payload = metadata_dict.get("source_payload")
    task = dict(source_payload) if isinstance(source_payload, Mapping) else {}
    task_id = _text(row_payload.get("task_key"))
    status = _text(row_payload.get("status"))
    if task_id:
        task["id"] = task_id
    if status:
        task["status"] = status
    provider_payload = row_payload.get("provider_payload")
    if isinstance(provider_payload, Mapping):
        for key in _PROVIDER_PAYLOAD_KEYS:
            if key in provider_payload and key not in task:
                task[key] = provider_payload.get(key)
    selected_cover = _text(row_payload.get("selected_cover_private_path"))
    if selected_cover and "selected_cover_private_path" not in task:
        task["selected_cover_private_path"] = selected_cover
    error_message = _text(row_payload.get("error_message"))
    if error_message and "error_message" not in task:
        task["error_message"] = error_message
    completed_at = _timestamp_text(row_payload.get("completed_at"))
    if completed_at and not _text(task.get("notification_completed_at")):
        task["notification_completed_at"] = completed_at
    requested_at = _timestamp_text(row_payload.get("requested_at"))
    if requested_at and not _text(task.get("created_at")):
        task["created_at"] = requested_at
    if "notification_action_taken" in metadata_dict:
        task["notification_action_taken"] = bool(metadata_dict.get("notification_action_taken"))
    if "notification_expires_at" in metadata_dict:
        task["notification_expires_at"] = _text(metadata_dict.get("notification_expires_at"))
    return task


def _bootstrap_context_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
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


def _load_notifications_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        select
          ops.cover_lookup_tasks.task_key,
          ops.cover_lookup_tasks.status,
          ops.cover_lookup_tasks.requested_at,
          ops.cover_lookup_tasks.completed_at,
          ops.cover_lookup_tasks.album_key,
          ops.cover_lookup_tasks.selected_cover_private_path,
          ops.cover_lookup_tasks.provider_payload,
          ops.cover_lookup_tasks.error_message,
          ops.cover_lookup_tasks.metadata
        from ops.cover_lookup_tasks
        join bootstrap_context
          on bootstrap_context.library_id = ops.cover_lookup_tasks.library_id
        where ops.cover_lookup_tasks.metadata ->> 'source_family' = any(%s::text[])
        order by
          coalesce(ops.cover_lookup_tasks.completed_at, ops.cover_lookup_tasks.requested_at) desc,
          ops.cover_lookup_tasks.task_key desc;
    """
    ).replace("%s::text[]", f"array[{', '.join(repr(item) for item in _SOURCE_FAMILIES)}]::text[]")


def _delete_removed_notifications_sql() -> str:
    return (
        _bootstrap_context_sql()
        + f"""
        delete from ops.cover_lookup_tasks
        using bootstrap_context
        where ops.cover_lookup_tasks.library_id = bootstrap_context.library_id
          and ops.cover_lookup_tasks.metadata ->> 'source_family' in ({_source_family_sql_list()})
          and (
            %s = 0
            or ops.cover_lookup_tasks.task_key <> all(%s::text[])
          );
    """
    )


def _delete_notifications_sql() -> str:
    return (
        _bootstrap_context_sql()
        + f"""
        delete from ops.cover_lookup_tasks
        using bootstrap_context
        where ops.cover_lookup_tasks.library_id = bootstrap_context.library_id
          and ops.cover_lookup_tasks.metadata ->> 'source_family' in ({_source_family_sql_list()})
          and ops.cover_lookup_tasks.task_key = any(%s::text[])
        returning ops.cover_lookup_tasks.task_key;
    """
    )


def _upsert_notification_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        insert into ops.cover_lookup_tasks (
          library_id,
          task_key,
          status,
          requested_at,
          completed_at,
          album_key,
          selected_cover_private_path,
          provider_payload,
          error_message,
          metadata
        )
        select
          bootstrap_context.library_id,
          %s,
          %s,
          coalesce(%s::timestamptz, '1970-01-01T00:00:00+00:00'::timestamptz),
          %s::timestamptz,
          %s,
          %s,
          %s::jsonb,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict (library_id, (metadata->>'source_family'), task_key)
          where library_id is not null
            and metadata ? 'source_family'
          do update
          set library_id = excluded.library_id,
              status = excluded.status,
              requested_at = excluded.requested_at,
              completed_at = excluded.completed_at,
              album_key = excluded.album_key,
              selected_cover_private_path = excluded.selected_cover_private_path,
              provider_payload = excluded.provider_payload,
              error_message = excluded.error_message,
              metadata = excluded.metadata;
    """
    )


def _source_family_sql_list() -> str:
    return ", ".join(f"'{item}'" for item in _SOURCE_FAMILIES)
