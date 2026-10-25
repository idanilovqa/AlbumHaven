from __future__ import annotations

import base64
import binascii
import json
from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any

from music_app.services.postgres_connections import pooled_connection as _pooled_connection

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
_ACTIVE_STATUSES = ("pending", "running")
_FINISHED_STATUSES = ("completed", "failed", "canceled")
_MAX_NOTIFICATION_PAGE_SIZE = 50
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
        self._use_shared_connection_pool = connect is None
        self._connect = connect or _connect

    def load_notifications(self) -> list[dict[str, object]]:
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            rows = list(connection.execute(_load_notifications_sql()).fetchall())
        tasks = [_task_from_row(row) for row in rows]
        return [task for task in tasks if str(task.get("id") or "").strip()]

    def load_notification(self, task_id: str) -> dict[str, object] | None:
        normalized_id = str(task_id or "").strip()
        if not normalized_id:
            return None
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            row = connection.execute(_load_notification_sql(), (normalized_id,)).fetchone()
        task = _task_from_row(row) if row is not None else {}
        return task if str(task.get("id") or "").strip() else None

    def load_notification_summaries(self) -> list[dict[str, object]]:
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            rows = list(
                connection.execute(_load_notification_summaries_sql()).fetchall()
            )
        summaries = [
            _compact_notification_summary(_notification_summary_from_row(row))
            for row in rows
        ]
        return [
            summary
            for summary in summaries
            if str(summary.get("id") or "").strip()
        ]

    def count_notifications(self) -> dict[str, int]:
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            return _count_notifications(connection)

    def interrupt_stale_notifications(
        self,
        *,
        stale_before: datetime,
        completed_at: datetime,
    ) -> set[str]:
        message = "Cover art lookup stopped before it could finish."
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                cursor = connection.execute(
                    _interrupt_stale_notifications_sql(),
                    (
                        completed_at,
                        message,
                        completed_at,
                        completed_at,
                        message,
                        list(_SOURCE_FAMILIES),
                        list(_ACTIVE_STATUSES),
                        stale_before,
                    ),
                )
                rows = list(cursor.fetchall())
        return {
            _text(_row_mapping(row).get("task_key"))
            for row in rows
            if _text(_row_mapping(row).get("task_key"))
        }

    def load_notification_summary_page(
        self,
        *,
        limit: int,
        cursor: str | None,
        active_only: bool,
    ) -> dict[str, object]:
        page_size = max(1, min(int(limit), _MAX_NOTIFICATION_PAGE_SIZE))
        cursor_values = _decode_notification_cursor(cursor) if cursor else None
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            counts = _count_notifications(connection)
            params: list[object] = [list(_SOURCE_FAMILIES)]
            if active_only:
                params.append(list(_ACTIVE_STATUSES))
            if cursor_values is not None:
                params.extend(cursor_values)
            params.append(page_size + 1)
            rows = list(
                connection.execute(
                    _load_notification_summary_page_sql(
                        has_cursor=cursor_values is not None,
                        active_only=active_only,
                    ),
                    tuple(params),
                ).fetchall()
            )

        page_rows = rows[:page_size]
        items = [
            _compact_notification_summary(_notification_summary_from_row(row))
            for row in page_rows
        ]
        next_cursor = None
        if len(rows) > page_size and page_rows:
            last_row = _row_mapping(page_rows[-1])
            next_cursor = _encode_notification_cursor(
                _timestamp_text(last_row.get("effective_timestamp")),
                _text(last_row.get("task_key")),
            )
        return {"items": items, "next_cursor": next_cursor, "counts": counts}

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
        if self._use_shared_connection_pool:
            return _pooled_connection(self._database_url, workload="default")
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


def _count_notifications(connection: Any) -> dict[str, int]:
    row = _row_mapping(
        _first_row(
            connection.execute(
                _count_notifications_sql(),
                (
                    list(_ACTIVE_STATUSES),
                    list(_FINISHED_STATUSES),
                    list(_ACTIVE_STATUSES),
                    list(_SOURCE_FAMILIES),
                ),
            )
        )
        or {}
    )
    return {
        "total_count": int(row.get("total_count") or 0),
        "active_count": int(row.get("active_count") or 0),
        "finished_count": int(row.get("finished_count") or 0),
    }


def _encode_notification_cursor(timestamp: str, task_key: str) -> str:
    payload = json.dumps(
        {"timestamp": timestamp, "task_key": task_key},
        separators=(",", ":"),
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_notification_cursor(cursor: str) -> tuple[str, str]:
    try:
        encoded = cursor.encode("ascii")
        padding = b"=" * (-len(encoded) % 4)
        decoded = base64.b64decode(encoded + padding, altchars=b"-_", validate=True)
        payload = json.loads(decoded.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError
        timestamp = payload.get("timestamp")
        task_key = payload.get("task_key")
        if not isinstance(timestamp, str) or not timestamp.strip():
            raise ValueError
        if not isinstance(task_key, str) or not task_key.strip():
            raise ValueError
        parsed_timestamp = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        if parsed_timestamp.tzinfo is None:
            raise ValueError
    except (UnicodeError, ValueError, TypeError, binascii.Error, json.JSONDecodeError) as exc:
        raise ValueError("Invalid notification cursor.") from exc
    return parsed_timestamp.isoformat(), task_key.strip()


def _compact_notification_summary(summary: dict[str, object]) -> dict[str, object]:
    compact = dict(summary)
    current_user_cover_path = compact.pop("current_user_cover_path", None)
    current_user_cover_revision = compact.pop("current_user_cover_revision", None)
    if current_user_cover_path:
        from music_app.services.startup_bootstrap import build_startup_cover_url

        compact["current_user_cover_preview_url"] = build_startup_cover_url(
            {
                "cover_path": current_user_cover_path,
                "cover_revision": current_user_cover_revision,
            }
        )
    for key in (
        "track_paths",
        "selected_cover_private_path",
        "selected_cover_path",
        "local_cover_path",
        "cover_path",
    ):
        compact.pop(key, None)
    album_payload = compact.get("album_payload")
    if isinstance(album_payload, Mapping):
        album_payload = dict(album_payload)
        if album_payload.get("cover_path"):
            from music_app.services.startup_bootstrap import build_startup_cover_url

            album_payload["cover_preview_url"] = build_startup_cover_url(album_payload)
        compact["album_payload"] = {
            str(key): value
            for key, value in album_payload.items()
            if str(key)
            not in {
                "tracks",
                "selected_cover_private_path",
                "selected_cover_path",
                "local_cover_path",
                "cover_path",
            }
        }
    return compact


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
    authoritative_key = _text(album_payload_dict.get("key"))
    if authoritative_key:
        return authoritative_key
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


def _notification_summary_from_row(row: object) -> dict[str, object]:
    summary = _row_mapping(row).get("task_summary")
    return dict(summary) if isinstance(summary, Mapping) else {}


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


def _load_notification_sql() -> str:
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
          and ops.cover_lookup_tasks.task_key = %s
        limit 1;
    """
    ).replace(
        "%s::text[]",
        f"array[{', '.join(repr(item) for item in _SOURCE_FAMILIES)}]::text[]",
        1,
    )


def _load_notification_summaries_sql() -> str:
    return (
        _bootstrap_context_sql()
        + f"""
        select jsonb_strip_nulls(
            jsonb_build_object(
                'type', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'type',
                'artist', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'artist',
                'album', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album',
                'year', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'year',
                'progress', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'progress',
                'progress_label', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'progress_label',
                'message', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'message',
                'result_kind', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'result_kind',
                'started_at', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'started_at',
                'updated_at', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'updated_at',
                'finished_at', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'finished_at',
                'cancel_requested', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'cancel_requested',
                'caa_empty_notice', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'caa_empty_notice',
                'selected_candidate_id', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'selected_candidate_id',
                'best_candidate_id', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'best_candidate_id',
                'candidate_revision', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'candidate_revision',
                'candidate_updated_at', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'candidate_updated_at'
            )
            || jsonb_build_object(
                'id', ops.cover_lookup_tasks.task_key,
                'status', ops.cover_lookup_tasks.status,
                'created_at', ops.cover_lookup_tasks.requested_at,
                'notification_completed_at', coalesce(
                    nullif(ops.cover_lookup_tasks.metadata ->> 'notification_completed_at', ''),
                    ops.cover_lookup_tasks.completed_at::text
                ),
                'notification_expires_at', coalesce(
                    ops.cover_lookup_tasks.metadata ->> 'notification_expires_at',
                    ''
                ),
                'notification_action_taken', coalesce(
                    (ops.cover_lookup_tasks.metadata ->> 'notification_action_taken')::boolean,
                    false
                ),
                'possible_match_count', (
                    select count(*)
                    from jsonb_array_elements(
                        coalesce(
                            ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'possible_matches',
                            ops.cover_lookup_tasks.provider_payload -> 'possible_matches',
                            '[]'::jsonb
                        )
                    ) as candidate
                    where coalesce(candidate ->> 'art_kind', 'cover') = 'cover'
                ),
                'current_user_cover_path', case
                    when current_album.metadata ->> 'cover_selection_origin' = 'user'
                    then current_album.cover_path
                    else null
                end,
                'current_user_cover_revision', case
                    when current_album.metadata ->> 'cover_selection_origin' = 'user'
                    then current_album.metadata ->> 'cover_revision'
                    else null
                end,
                'best_candidate_preview_url', (
                    select coalesce(
                        nullif(candidate ->> 'thumbnail_url', ''),
                        nullif(candidate ->> 'preview_url', ''),
                        nullif(candidate ->> 'url', '')
                    )
                    from jsonb_array_elements(
                        coalesce(
                            ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'possible_matches',
                            ops.cover_lookup_tasks.provider_payload -> 'possible_matches',
                            '[]'::jsonb
                        )
                    ) with ordinality as candidates(candidate, ordinal)
                    where coalesce(candidate ->> 'art_kind', 'cover') = 'cover'
                    order by case
                        when candidate ->> 'id' = ops.cover_lookup_tasks.metadata -> 'source_payload' ->> 'best_candidate_id'
                        then 0 else 1
                    end, ordinal
                    limit 1
                ),
                'album_payload', case
                    when jsonb_typeof(ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload') = 'object'
                    then jsonb_strip_nulls(jsonb_build_object(
                        'album_id', coalesce(
                            ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'id',
                            ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'album_id'
                        ),
                        'key', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'key',
                        'name', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'name',
                        'album', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'album',
                        'album_artist', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'album_artist',
                        'artist', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'artist',
                        'year', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'year',
                        'cover_path', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'cover_path',
                        'cover_preview_url', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'cover_preview_url',
                        'cover_revision', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'cover_revision',
                        'remote_cover_url', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'remote_cover_url',
                        'remote_cover_thumbnail_url', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'remote_cover_thumbnail_url',
                        'remote_cover_source', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'remote_cover_source',
                        'remote_cover_source_label', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'remote_cover_source_label',
                        'remote_cover_album_url', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'remote_cover_album_url',
                        'remote_cover_width', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'remote_cover_width',
                        'tracks', coalesce((
                            select jsonb_agg(jsonb_build_object('path', track ->> 'path'))
                            from jsonb_array_elements(
                                coalesce(
                                    ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'tracks',
                                    '[]'::jsonb
                                )
                            ) as track
                            where nullif(track ->> 'path', '') is not null
                        ), '[]'::jsonb)
                    ))
                    else null
                end
            )
        ) as task_summary
        from ops.cover_lookup_tasks
        join bootstrap_context
          on bootstrap_context.library_id = ops.cover_lookup_tasks.library_id
        {_current_notification_album_joins_sql()}
        where ops.cover_lookup_tasks.metadata ->> 'source_family' = any(%s::text[])
          and {_actionable_notification_predicate_sql()}
        order by
            coalesce(ops.cover_lookup_tasks.completed_at, ops.cover_lookup_tasks.requested_at) desc,
            ops.cover_lookup_tasks.task_key desc;
        """
    ).replace("%s::text[]", f"array[{', '.join(repr(item) for item in _SOURCE_FAMILIES)}]::text[]")


def _count_notifications_sql() -> str:
    return (
        _bootstrap_context_sql()
        + f"""
        select
          count(*)::int as total_count,
          count(*) filter (
            where ops.cover_lookup_tasks.status = any(%s::text[])
              and coalesce(
                ops.cover_lookup_tasks.metadata -> 'source_payload'
                  -> 'job_contract' ->> 'job_kind',
                ''
              ) <> 'save_remote_selection'
          )::int as active_count,
          count(*) filter (
            where ops.cover_lookup_tasks.status = any(%s::text[])
               or (
                 ops.cover_lookup_tasks.status = any(%s::text[])
                 and ops.cover_lookup_tasks.metadata -> 'source_payload'
                   -> 'job_contract' ->> 'job_kind' = 'save_remote_selection'
               )
          )::int as finished_count
        from ops.cover_lookup_tasks
        join bootstrap_context
          on bootstrap_context.library_id = ops.cover_lookup_tasks.library_id
        {_current_notification_album_joins_sql()}
        where ops.cover_lookup_tasks.metadata ->> 'source_family' = any(%s::text[])
          and {_actionable_notification_predicate_sql()};
        """
    )


def _load_notification_summary_page_sql(*, has_cursor: bool, active_only: bool) -> str:
    filters = [
        "ops.cover_lookup_tasks.metadata ->> 'source_family' = any(%s::text[])",
        _actionable_notification_predicate_sql(),
    ]
    if active_only:
        filters.append("ops.cover_lookup_tasks.status = any(%s::text[])")
    if has_cursor:
        filters.append(
            "(coalesce(ops.cover_lookup_tasks.completed_at, "
            "ops.cover_lookup_tasks.requested_at), ops.cover_lookup_tasks.task_key) "
            "< (%s::timestamptz, %s)"
        )
    where_sql = "\n          and ".join(filters)
    return (
        _bootstrap_context_sql()
        + f"""
        select
          jsonb_strip_nulls(
            jsonb_build_object(
              'type', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'type',
              'artist', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'artist',
              'album', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album',
              'year', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'year',
              'progress', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'progress',
              'progress_label', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'progress_label',
              'message', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'message',
              'result_kind', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'result_kind',
              'started_at', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'started_at',
              'updated_at', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'updated_at',
              'finished_at', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'finished_at',
              'cancel_requested', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'cancel_requested',
              'caa_empty_notice', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'caa_empty_notice',
              'selected_candidate_id', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'selected_candidate_id',
              'best_candidate_id', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'best_candidate_id',
              'candidate_revision', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'candidate_revision',
              'candidate_updated_at', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'candidate_updated_at',
              'job_kind', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'job_contract' -> 'job_kind'
            )
            || jsonb_build_object(
              'id', ops.cover_lookup_tasks.task_key,
              'status', ops.cover_lookup_tasks.status,
              'created_at', ops.cover_lookup_tasks.requested_at,
              'notification_completed_at', coalesce(
                nullif(ops.cover_lookup_tasks.metadata ->> 'notification_completed_at', ''),
                ops.cover_lookup_tasks.completed_at::text
              ),
              'notification_expires_at', coalesce(
                ops.cover_lookup_tasks.metadata ->> 'notification_expires_at',
                ''
              ),
              'notification_action_taken', coalesce(
                (ops.cover_lookup_tasks.metadata ->> 'notification_action_taken')::boolean,
                false
              ),
              'possible_match_count', (
                select count(*)
                from jsonb_array_elements(
                  coalesce(
                    ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'possible_matches',
                    ops.cover_lookup_tasks.provider_payload -> 'possible_matches',
                    '[]'::jsonb
                  )
                ) as candidate
                where coalesce(candidate ->> 'art_kind', 'cover') = 'cover'
              ),
              'current_user_cover_path', case
                when current_album.metadata ->> 'cover_selection_origin' = 'user'
                then current_album.cover_path
                else null
              end,
              'current_user_cover_revision', case
                when current_album.metadata ->> 'cover_selection_origin' = 'user'
                then current_album.metadata ->> 'cover_revision'
                else null
              end,
              'best_candidate_preview_url', (
                select coalesce(
                  nullif(candidate ->> 'thumbnail_url', ''),
                  nullif(candidate ->> 'preview_url', ''),
                  nullif(candidate ->> 'url', '')
                )
                from jsonb_array_elements(
                  coalesce(
                    ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'possible_matches',
                    ops.cover_lookup_tasks.provider_payload -> 'possible_matches',
                    '[]'::jsonb
                  )
                ) with ordinality as candidates(candidate, ordinal)
                where coalesce(candidate ->> 'art_kind', 'cover') = 'cover'
                order by case
                  when candidate ->> 'id' = ops.cover_lookup_tasks.metadata -> 'source_payload' ->> 'best_candidate_id'
                  then 0 else 1
                end, ordinal
                limit 1
              ),
              'album_payload', case
                when jsonb_typeof(
                  ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload'
                ) = 'object'
                then jsonb_strip_nulls(jsonb_build_object(
                  'album_id', coalesce(
                    ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'id',
                    ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'album_id'
                  ),
                  'key', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'key',
                  'name', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'name',
                  'album', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'album',
                  'album_artist', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'album_artist',
                  'artist', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'artist',
                  'year', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'year',
                  'cover_path', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'cover_path',
                  'cover_preview_url', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'cover_preview_url',
                  'cover_revision', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'cover_revision',
                  'remote_cover_url', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'remote_cover_url',
                  'remote_cover_thumbnail_url', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'remote_cover_thumbnail_url',
                  'remote_cover_source', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'remote_cover_source',
                  'remote_cover_source_label', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'remote_cover_source_label',
                  'remote_cover_album_url', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'remote_cover_album_url',
                  'remote_cover_width', ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' -> 'remote_cover_width'
                ))
                else null
              end
            )
          ) as task_summary,
          coalesce(
            ops.cover_lookup_tasks.completed_at,
            ops.cover_lookup_tasks.requested_at
          ) as effective_timestamp,
          ops.cover_lookup_tasks.task_key
        from ops.cover_lookup_tasks
        join bootstrap_context
          on bootstrap_context.library_id = ops.cover_lookup_tasks.library_id
        {_current_notification_album_joins_sql()}
        where {where_sql}
        order by
          coalesce(
            ops.cover_lookup_tasks.completed_at,
            ops.cover_lookup_tasks.requested_at
          ) desc,
          ops.cover_lookup_tasks.task_key desc
        limit %s;
        """
    )


def _current_notification_album_joins_sql() -> str:
    return """
        cross join lateral (
          select
            case
              when coalesce(
                ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' ->> 'album_id',
                ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' ->> 'id',
                ''
              ) ~ '^[1-9][0-9]*$'
              then coalesce(
                ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' ->> 'album_id',
                ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' ->> 'id'
              )::bigint
              else null
            end,
            nullif(
              ops.cover_lookup_tasks.metadata -> 'source_payload' -> 'album_payload' ->> 'key',
              ''
            )
        ) as identity(album_id, album_key)
        left join library.local_albums as current_album_by_id
          on current_album_by_id.library_id = ops.cover_lookup_tasks.library_id
         and current_album_by_id.id = identity.album_id
         and (identity.album_key is null or current_album_by_id.album_key = identity.album_key)
        left join library.local_albums as current_album_by_key
          on identity.album_id is null
         and current_album_by_key.library_id = ops.cover_lookup_tasks.library_id
         and current_album_by_key.album_key = identity.album_key
        cross join lateral (
          select
            coalesce(current_album_by_id.id, current_album_by_key.id),
            coalesce(current_album_by_id.cover_path, current_album_by_key.cover_path),
            coalesce(current_album_by_id.metadata, current_album_by_key.metadata),
            exists (
              select 1
              from library.local_tracks as current_track
              join library.local_track_files as current_file
                on current_file.track_id = current_track.id
               and current_file.scan_cache_stale is false
              where current_track.album_id = coalesce(
                current_album_by_id.id,
                current_album_by_key.id
              )
            )
        ) as current_album(album_id, cover_path, metadata, has_active_tracks)
    """


def _actionable_notification_predicate_sql() -> str:
    return "(ops.cover_lookup_tasks.status in ('pending', 'running') or current_album.has_active_tracks)"


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


def _interrupt_stale_notifications_sql() -> str:
    return _bootstrap_context_sql() + """
        update ops.cover_lookup_tasks
        set status = 'failed',
            completed_at = %s::timestamptz,
            error_message = %s,
            metadata = ops.cover_lookup_tasks.metadata || jsonb_build_object(
                'notification_action_taken', false,
                'notification_completed_at', %s::timestamptz::text,
                'notification_expires_at', '',
                'source_payload',
                    coalesce(
                        ops.cover_lookup_tasks.metadata -> 'source_payload',
                        '{}'::jsonb
                    ) || jsonb_build_object(
                        'status', 'failed',
                        'progress', 100,
                        'progress_label', 'Interrupted',
                        'result_kind', 'interrupted',
                        'finished_at', %s::timestamptz::text,
                        'message', %s::text
                    )
            )
        from bootstrap_context
        where ops.cover_lookup_tasks.library_id = bootstrap_context.library_id
          and ops.cover_lookup_tasks.metadata ->> 'source_family' = any(%s::text[])
          and ops.cover_lookup_tasks.status = any(%s::text[])
          and greatest(
                nullif(
                    ops.cover_lookup_tasks.metadata -> 'source_payload'
                        ->> 'candidate_updated_at',
                    ''
                )::timestamptz,
                nullif(
                    ops.cover_lookup_tasks.metadata -> 'source_payload' ->> 'updated_at',
                    ''
                )::timestamptz,
                nullif(
                    ops.cover_lookup_tasks.metadata -> 'source_payload' ->> 'started_at',
                    ''
                )::timestamptz,
                ops.cover_lookup_tasks.requested_at
          ) <= %s::timestamptz
        returning ops.cover_lookup_tasks.task_key;
    """


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
