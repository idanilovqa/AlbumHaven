"""Durable library writer ownership; unused until writer integration is approved."""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from typing import Any

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


_SOURCE_FAMILY = "library_writer_ownership_v1"
_TASK_KEY = "library-writer"


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for Postgres library ownership.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _require_text(value: object, field: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a nonempty string.")


def _bootstrap_library_id(connection: Any) -> int:
    row = connection.execute("""
        select libraries.id as library_id
        from app.bootstrap_owners owners
        join library.libraries libraries on libraries.owner_account_id = owners.account_id
        where owners.owner_key = 'local-bootstrap-owner'
          and libraries.name = 'Local Library' and libraries.library_kind = 'local'
        limit 1
    """).fetchone()
    if row is None:
        raise RuntimeError("Postgres library ownership requires the bootstrap local library context.")
    return row["library_id"]


class PostgresLibraryOperationRepository:
    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        self._connect = connect or _connect

    def _connection(self) -> Any:
        if not self._database_url:
            raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required for Postgres library ownership.")
        return self._connect(self._database_url)

    def claim(self, *, owner_token: str, owner_identity: dict, operation: str) -> bool:
        _require_text(owner_token, "owner_token")
        _require_text(operation, "operation")
        if not isinstance(owner_identity, dict):
            raise ValueError("owner_identity must contain the complete process identity.")
        for field in ("host", "process_started_at", "instance_id"):
            _require_text(owner_identity.get(field), f"owner_identity.{field}")
        pid = owner_identity.get("pid")
        if type(pid) is not int or pid <= 0:
            raise ValueError("owner_identity.pid must be a positive integer.")
        metadata = json.dumps({
            "source_family": _SOURCE_FAMILY,
            "owner_token": owner_token,
            "owner_identity": owner_identity,
            "operation": operation,
        })
        with self._connection() as connection:
            library_id = _bootstrap_library_id(connection)
            row = connection.execute("""
                insert into ops.cover_lookup_tasks (
                    library_id, task_key, status, requested_at, completed_at,
                    album_key, selected_cover_private_path, provider_payload, metadata
                ) values (%s, %s, 'running', now(), null, null, null, '{}'::jsonb, %s::jsonb)
                on conflict (library_id, (metadata->>'source_family'), task_key)
                  where library_id is not null and metadata ? 'source_family'
                do update set status = excluded.status,
                    requested_at = excluded.requested_at, completed_at = null,
                    album_key = null, selected_cover_private_path = null,
                    provider_payload = '{}'::jsonb, error_message = null,
                    metadata = excluded.metadata
                where ops.cover_lookup_tasks.status = 'released'
                returning id
            """, (library_id, _TASK_KEY, metadata)).fetchone()
        # Exiting the connection commits; an uncertain commit must propagate.
        return row is not None

    def release(self, *, owner_token: str) -> bool:
        _require_text(owner_token, "owner_token")
        with self._connection() as connection:
            library_id = _bootstrap_library_id(connection)
            row = connection.execute("""
                update ops.cover_lookup_tasks set status = 'released', completed_at = now()
                where library_id = %s and metadata->>'source_family' = %s
                  and task_key = %s and status = 'running'
                  and metadata->>'owner_token' = %s
                returning id
            """, (library_id, _SOURCE_FAMILY, _TASK_KEY, owner_token)).fetchone()
        return row is not None

    def read_owner(self) -> dict | None:
        with self._connection() as connection:
            library_id = _bootstrap_library_id(connection)
            row = connection.execute("""
                select metadata from ops.cover_lookup_tasks
                where library_id = %s and metadata->>'source_family' = %s
                  and task_key = %s and status = 'running'
            """, (library_id, _SOURCE_FAMILY, _TASK_KEY)).fetchone()
        return dict(row["metadata"]) if row is not None else None
