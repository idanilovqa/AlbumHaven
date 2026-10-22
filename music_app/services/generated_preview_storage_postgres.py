from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import nullcontext
from typing import Any
from uuid import UUID

try:  # pragma: no cover - optional outside the Postgres runtime.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_MODES = frozenset({"album_folders", "custom"})
_TERMINAL_ITEM_STATES = frozenset({"completed", "failed", "skipped"})


class PreviewStorageConflict(RuntimeError):
    pass


def is_generated_preview_storage_postgres_available(
    config: Mapping[str, object] | None,
) -> bool:
    return bool(
        config
        and str(config.get(_DATABASE_URL_KEY) or "").strip()
        and psycopg is not None
    )


class PostgresGeneratedPreviewStorageRepository:
    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def load(self) -> dict[str, object]:
        with self._connect_to_database() as connection:
            row = _first_row(connection.execute(_load_sql()))
        if row is None:
            raise RuntimeError("Generated preview storage singleton is missing.")
        return _row_mapping(row)

    def request_location(
        self,
        *,
        mode: str,
        root: str | None,
        expected_revision: int,
    ) -> dict[str, object]:
        normalized_mode, normalized_root = _validate_location(mode, root)
        if type(expected_revision) is not int or expected_revision < 0:
            raise ValueError("A non-negative expected revision is required.")
        with self._connect_to_database() as connection:
            with _transaction(connection):
                row = _first_row(
                    connection.execute(
                        _request_location_sql(),
                        {
                            "requested_mode": normalized_mode,
                            "requested_root": normalized_root,
                            "expected_revision": expected_revision,
                        },
                    )
                )
        if row is None:
            raise PreviewStorageConflict("Preview storage revision conflict.")
        return _row_mapping(row)

    def begin_operation(
        self,
        *,
        operation_id: str,
    ) -> dict[str, object]:
        normalized_operation_id = str(UUID(str(operation_id)))
        with self._connect_to_database() as connection:
            with _transaction(connection):
                row = _first_row(
                    connection.execute(
                        _begin_operation_sql(),
                        {
                            "operation_id": normalized_operation_id,
                        },
                    )
                )
        if row is None:
            raise PreviewStorageConflict("A preview relocation is already active.")
        return _row_mapping(row)

    def record_inventory(
        self,
        *,
        album_preview_path: str,
        managed_relative_path: str,
        byte_count: int,
        sha256: str,
    ) -> dict[str, object]:
        normalized_sha256 = str(sha256).strip().casefold()
        if byte_count < 0 or len(normalized_sha256) != 64:
            raise ValueError("Generated preview inventory checksum is invalid.")
        with self._connect_to_database() as connection:
            with _transaction(connection):
                row = _first_row(
                    connection.execute(
                        _record_inventory_sql(),
                        {
                            "album_preview_path": str(album_preview_path),
                            "managed_relative_path": str(managed_relative_path),
                            "byte_count": int(byte_count),
                            "sha256": normalized_sha256,
                        },
                    )
                )
        if row is None:
            raise RuntimeError("Generated preview inventory was not recorded.")
        return _row_mapping(row)

    def claim_batch(self, *, operation_id: str, limit: int) -> list[dict[str, object]]:
        if type(limit) is not int or limit < 1 or limit > 100:
            raise ValueError("Preview relocation batch size must be between 1 and 100.")
        with self._connect_to_database() as connection:
            with _transaction(connection):
                rows = list(
                    connection.execute(
                        _claim_batch_sql(),
                        {"operation_id": str(UUID(str(operation_id))), "limit": limit},
                    ).fetchall()
                )
        return [_row_mapping(row) for row in rows]

    def recover_interrupted_items(self, *, operation_id: str) -> int:
        with self._connect_to_database() as connection:
            with _transaction(connection):
                cursor = connection.execute(
                    _recover_interrupted_items_sql(),
                    {"operation_id": str(UUID(str(operation_id)))},
                )
        return int(cursor.rowcount)

    def complete_item(
        self,
        *,
        operation_id: str,
        item_id: int,
        status: str,
        byte_count: int,
        sha256: str,
        error: str | None = None,
    ) -> None:
        normalized_status = str(status or "").strip().casefold()
        if normalized_status not in _TERMINAL_ITEM_STATES:
            raise ValueError("Preview relocation item status is invalid.")
        if byte_count < 0 or len(str(sha256)) != 64:
            raise ValueError("Preview relocation item checksum is invalid.")
        with self._connect_to_database() as connection:
            with _transaction(connection):
                row = _first_row(
                    connection.execute(
                        _complete_item_sql(),
                        {
                            "operation_id": str(UUID(str(operation_id))),
                            "item_id": int(item_id),
                            "status": normalized_status,
                            "byte_count": byte_count,
                            "sha256": str(sha256).casefold(),
                            "last_error": str(error)[:1000] if error else None,
                        },
                    )
                )
        if row is None:
            raise PreviewStorageConflict("Preview relocation item is no longer claimable.")

    def finish_operation(self, operation_id: str) -> dict[str, object]:
        with self._connect_to_database() as connection:
            with _transaction(connection):
                row = _first_row(
                    connection.execute(
                        _finish_operation_sql(),
                        {"operation_id": str(UUID(str(operation_id)))},
                    )
                )
        if row is None:
            raise PreviewStorageConflict("Preview relocation cannot be finished.")
        return _row_mapping(row)

    def cancel(self, operation_id: str) -> dict[str, object]:
        return self._transition(
            _cancel_sql(), operation_id, "Preview relocation is not cancelable."
        )

    def retry_failed(self, operation_id: str) -> dict[str, object]:
        return self._transition(
            _retry_failed_sql(), operation_id, "Preview relocation has no failed items."
        )

    def _transition(
        self, sql: str, operation_id: str, conflict_message: str
    ) -> dict[str, object]:
        with self._connect_to_database() as connection:
            with _transaction(connection):
                row = _first_row(
                    connection.execute(
                        sql, {"operation_id": str(UUID(str(operation_id)))}
                    )
                )
        if row is None:
            raise PreviewStorageConflict(conflict_message)
        return _row_mapping(row)

    def _connect_to_database(self):
        if not self._database_url:
            raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required for preview storage.")
        return self._connect(self._database_url)


def serialize_preview_storage(
    state: Mapping[str, object], *, include_paths: bool
) -> dict[str, object]:
    payload = dict(state)
    if not include_paths:
        payload.pop("active_root", None)
        payload.pop("requested_root", None)
        payload.pop("failure_summary", None)
    return payload


def _connect(database_url: str):
    if psycopg is None:
        raise RuntimeError("psycopg is required for generated preview storage.")
    return psycopg.connect(database_url, row_factory=dict_row, connect_timeout=2)


def _transaction(connection: Any):
    transaction = getattr(connection, "transaction", None)
    return transaction() if callable(transaction) else nullcontext()


def _first_row(cursor: object) -> object | None:
    fetchone = getattr(cursor, "fetchone", None)
    return fetchone() if callable(fetchone) else None


def _row_mapping(row: object) -> dict[str, object]:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    return {}


def _validate_location(mode: str, root: str | None) -> tuple[str, str | None]:
    normalized_mode = str(mode or "").strip().casefold()
    normalized_root = str(root or "").strip() or None
    if normalized_mode not in _MODES:
        raise ValueError("Preview storage mode is invalid.")
    if normalized_mode == "custom" and normalized_root is None:
        raise ValueError("Custom preview storage requires a server path.")
    return normalized_mode, normalized_root if normalized_mode == "custom" else None


def _load_sql() -> str:
    return "select * from app.generated_preview_storage where storage_key = 1;"


def _request_location_sql() -> str:
    return """
        update app.generated_preview_storage
        set requested_mode = %(requested_mode)s,
            requested_root = %(requested_root)s,
            revision = revision + 1,
            updated_at = now()
        where storage_key = 1
          and revision = %(expected_revision)s
          and requested_mode is null
          and operation_state not in ('queued', 'running', 'cancel_requested')
          and operation_state <> 'canceled'
        returning *;
    """


def _begin_operation_sql() -> str:
    return """
        with activated as (
          update app.generated_preview_storage
          set operation_id = %(operation_id)s::uuid,
              operation_state = 'queued',
              total_count = (
                select count(*) from app.generated_preview_inventory
              ),
              completed_count = 0,
              failed_count = 0,
              total_bytes = (
                select coalesce(sum(byte_count), 0)
                from app.generated_preview_inventory
              ),
              completed_bytes = 0,
              cancel_requested = false,
              failure_summary = '[]'::jsonb,
              updated_at = now()
          where storage_key = 1
            and requested_mode is not null
            and operation_state not in ('queued', 'running', 'cancel_requested')
          returning *
        ), staged as (
          insert into app.generated_preview_relocation_items (
            storage_key, operation_id, inventory_id, source_path, target_path,
            expected_bytes, expected_sha256
          )
          select activated.storage_key,
                 activated.operation_id,
                 inventory.id,
                 paths.source_path,
                 paths.target_path,
                 inventory.byte_count,
                 inventory.sha256
          from app.generated_preview_inventory inventory
          cross join activated
          cross join lateral (
            select
              case when activated.mode = 'custom'
                then activated.active_root || '/' || inventory.managed_relative_path
                else inventory.album_preview_path
              end as source_path,
              case when activated.requested_mode = 'custom'
                then activated.requested_root || '/' || inventory.managed_relative_path
                else inventory.album_preview_path
              end as target_path
          ) paths
          where paths.source_path <> paths.target_path
          on conflict (operation_id, inventory_id) do nothing
          returning id
        )
        select activated.* from activated;
    """


def _record_inventory_sql() -> str:
    return """
        insert into app.generated_preview_inventory (
          album_preview_path, managed_relative_path, byte_count, sha256
        ) values (
          %(album_preview_path)s, %(managed_relative_path)s,
          %(byte_count)s, %(sha256)s
        )
        on conflict (managed_relative_path) do update
        set album_preview_path = excluded.album_preview_path,
            byte_count = excluded.byte_count,
            sha256 = excluded.sha256,
            updated_at = now()
        returning *;
    """


def _claim_batch_sql() -> str:
    return """
        with activated as (
          update app.generated_preview_storage
          set operation_state = 'running', updated_at = now()
          where storage_key = 1
            and operation_id = %(operation_id)s::uuid
            and operation_state = 'queued'
          returning storage_key
        ), claimed as (
          select id
          from app.generated_preview_relocation_items
          where operation_id = %(operation_id)s::uuid and status = 'pending'
          order by id
          for update skip locked
          limit %(limit)s
        )
        update app.generated_preview_relocation_items item
        set status = 'running', started_at = now(), attempt_count = attempt_count + 1
        from claimed
        where item.id = claimed.id
        returning item.*;
    """


def _recover_interrupted_items_sql() -> str:
    return """
    update app.generated_preview_relocation_items
    set status = 'pending', started_at = null
    where operation_id = %(operation_id)s::uuid
      and status = 'running';
    """


def _complete_item_sql() -> str:
    return """
        with finished as (
          update app.generated_preview_relocation_items
          set status = %(status)s,
              actual_bytes = %(byte_count)s,
              actual_sha256 = %(sha256)s,
              last_error = %(last_error)s,
              finished_at = now()
          where id = %(item_id)s
            and operation_id = %(operation_id)s::uuid
            and status = 'running'
          returning *
        ), counted as (
          update app.generated_preview_storage storage
          set completed_count = completed_count + case when %(status)s <> 'failed' then 1 else 0 end,
              failed_count = failed_count + case when %(status)s = 'failed' then 1 else 0 end,
              completed_bytes = completed_bytes + case when %(status)s <> 'failed' then %(byte_count)s else 0 end,
              failure_summary = case
                when %(status)s = 'failed' and jsonb_array_length(failure_summary) < 20
                then failure_summary || jsonb_build_array(jsonb_build_object('item_id', %(item_id)s, 'error', %(last_error)s))
                else failure_summary
              end,
              updated_at = now()
          where storage.operation_id = %(operation_id)s::uuid
            and exists (select 1 from finished)
          returning storage.storage_key
        )
        select id from finished;
    """


def _finish_operation_sql() -> str:
    return """
        with skipped as (
          update app.generated_preview_relocation_items item
          set status = 'skipped', finished_at = now()
          from app.generated_preview_storage storage
          where item.operation_id = %(operation_id)s::uuid
            and item.status = 'pending'
            and storage.storage_key = 1
            and storage.operation_id = item.operation_id
            and storage.cancel_requested
          returning item.id
        )
        update app.generated_preview_storage
        set mode = case
              when not cancel_requested and failed_count = 0 then requested_mode
              else mode
            end,
            active_root = case
              when not cancel_requested and failed_count = 0 then requested_root
              else active_root
            end,
            requested_mode = case
              when not cancel_requested and failed_count = 0 then null
              else requested_mode
            end,
            requested_root = case
              when not cancel_requested and failed_count = 0 then null
              else requested_root
            end,
            operation_state = case
              when cancel_requested then 'canceled'
              when failed_count > 0 then 'completed_with_failures'
              else 'completed'
            end,
            revision = revision + 1,
            updated_at = now()
        where storage_key = 1
          and operation_id = %(operation_id)s::uuid
          and operation_state in ('queued', 'running', 'cancel_requested')
          and not exists (
            select 1 from app.generated_preview_relocation_items
            where operation_id = %(operation_id)s::uuid
              and status = 'running'
          )
          and (
            cancel_requested
            or not exists (
              select 1 from app.generated_preview_relocation_items
              where operation_id = %(operation_id)s::uuid
                and status = 'pending'
            )
          )
        returning *;
    """


def _cancel_sql() -> str:
    return """
        update app.generated_preview_storage
        set cancel_requested = true,
            operation_state = 'cancel_requested',
            updated_at = now()
        where storage_key = 1
          and operation_id = %(operation_id)s::uuid
          and operation_state in ('queued', 'running', 'cancel_requested')
        returning *;
    """


def _retry_failed_sql() -> str:
    return """
        with retried as (
          update app.generated_preview_relocation_items item
          set status = 'pending', actual_bytes = null, actual_sha256 = null,
              last_error = null, started_at = null, finished_at = null
          from app.generated_preview_storage storage
          where item.operation_id = %(operation_id)s::uuid
            and item.status in ('failed', 'skipped')
            and storage.storage_key = 1
            and storage.operation_id = item.operation_id
            and storage.operation_state in ('completed_with_failures', 'failed', 'canceled')
          returning item.id
        )
        update app.generated_preview_storage storage
        set operation_state = 'queued', failed_count = 0,
            failure_summary = '[]'::jsonb, cancel_requested = false,
            updated_at = now()
        where storage.storage_key = 1
          and storage.operation_id = %(operation_id)s::uuid
          and storage.operation_state in ('completed_with_failures', 'failed', 'canceled')
          and (
            exists (select 1 from retried)
            or storage.operation_state = 'canceled'
          )
        returning storage.*;
    """
