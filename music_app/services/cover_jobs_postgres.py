"""Postgres authority for durable cover tasks and their generic job links."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

try:  # pragma: no cover - optional driver import is environment-specific.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None

from music_app.services.jobs.models import EnqueueJob
from music_app.services.jobs.repository_postgres import PostgresJobRepository


@dataclass(frozen=True)
class AcceptedCoverLookup:
    task_key: str
    task_id: int
    job_id: int
    row_revision: int


def _default_connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for durable cover jobs")
    return psycopg.connect(database_url, row_factory=dict_row)


def _positive(name: str, value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _bounded(name: str, value: object, *, maximum: int) -> str:
    normalized = str(value or "").strip()
    if not normalized or len(normalized) > maximum or any(ord(char) < 32 for char in normalized):
        raise ValueError(f"{name} must be a bounded nonblank string")
    return normalized


def _mapping(row: object) -> dict[str, object]:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    return {}


class PostgresCoverJobRepository:
    """Own atomic cover-domain acceptance and narrow durable task reads."""

    def __init__(
        self,
        *,
        database_url: str,
        connect_to_database: Callable[[str], Any] | None = None,
        job_repository: PostgresJobRepository | Any | None = None,
    ) -> None:
        self._database_url = _bounded("database_url", database_url, maximum=8192)
        self._connect_to_database = connect_to_database or _default_connect
        self._job_repository = job_repository or PostgresJobRepository(
            database_url=self._database_url,
            connect_to_database=self._connect_to_database,
        )

    def _connect(self) -> Any:
        return self._connect_to_database(self._database_url)

    def accept_candidate_lookup(
        self,
        *,
        task_key: str,
        library_id: int,
        album_key: str,
        account_id: int,
        request_origin_ref: str,
        deployment_mode: str,
        client_surface: str,
        candidate_generation: UUID,
        resource_revision: int,
        scheduled_at: datetime,
    ) -> AcceptedCoverLookup:
        task_key = _bounded("task_key", task_key, maximum=128)
        album_key = _bounded("album_key", album_key, maximum=1024)
        library_id = _positive("library_id", library_id)
        account_id = _positive("account_id", account_id)
        if not isinstance(candidate_generation, UUID):
            raise ValueError("candidate_generation must be a UUID")
        if isinstance(resource_revision, bool) or not isinstance(resource_revision, int) or resource_revision < 0:
            raise ValueError("resource_revision must be a nonnegative integer")
        origin_type, separator, origin_key = _bounded(
            "request_origin_ref", request_origin_ref, maximum=1024
        ).partition(":")
        if not separator or not origin_type or not origin_key:
            raise ValueError("request_origin_ref must contain type and key")
        deployment_mode = _bounded("deployment_mode", deployment_mode, maximum=128)
        client_surface = _bounded("client_surface", client_surface, maximum=128)

        scope_sql = """
            select
              album.id as local_album_id,
              min(root.id) as library_root_id
            from library.local_albums as album
            join library.local_tracks as track
              on track.album_id = album.id
             and track.library_id = album.library_id
            join library.local_track_files as file
              on file.track_id = track.id
            join library.library_roots as root
              on root.id = file.library_root_id
             and root.library_id = album.library_id
             and root.is_active is true
            where album.library_id = %(library_id)s
              and album.album_key = %(album_key)s
            group by album.id
            having count(distinct root.id) = 1
        """
        insert_sql = """
            insert into ops.cover_lookup_tasks (
              library_id, task_key, status, requested_at, album_key,
              provider_payload, metadata, local_album_id, library_root_id,
              initiating_account_id, request_origin_id, capability_key,
              deployment_mode, client_surface, candidate_generation,
              resource_revision, row_revision
            ) values (
              %(library_id)s, %(task_key)s, 'pending', %(scheduled_at)s,
              %(album_key)s, '{}'::jsonb,
              jsonb_build_object(
                'source_family', 'durable_cover_lookup',
                'source', 'durable_cover_lookup',
                'source_key', %(task_key)s::text,
                'source_payload', jsonb_build_object('id', %(task_key)s::text)
              ),
              %(local_album_id)s, %(library_root_id)s, %(account_id)s,
              (
                select origin.id from app.request_origins as origin
                 where origin.origin_type = %(origin_type)s
                   and origin.origin_key = %(origin_key)s
                   and origin.client_surface_class = %(client_surface)s
                   and origin.account_id = %(account_id)s
                 order by origin.id desc limit 1
              ),
              'library.covers.lookup', %(deployment_mode)s, %(client_surface)s,
              %(candidate_generation)s, %(resource_revision)s, 0
            )
            on conflict (library_id, (metadata->>'source_family'), task_key)
              where library_id is not null and metadata ? 'source_family'
            do update set task_key = ops.cover_lookup_tasks.task_key
              where ops.cover_lookup_tasks.local_album_id = excluded.local_album_id
                and ops.cover_lookup_tasks.library_root_id = excluded.library_root_id
                and ops.cover_lookup_tasks.initiating_account_id = excluded.initiating_account_id
                and ops.cover_lookup_tasks.candidate_generation = excluded.candidate_generation
                and ops.cover_lookup_tasks.resource_revision = excluded.resource_revision
            returning id as task_id, row_revision
        """
        link_sql = """
            update ops.cover_lookup_tasks
               set job_id = coalesce(job_id, %(job_id)s),
                   row_revision = row_revision + case when job_id is null then 1 else 0 end
             where id = %(task_id)s
               and library_id = %(library_id)s
               and (job_id is null or job_id = %(job_id)s)
            returning id as task_id, row_revision, job_id
        """
        values = {
            "task_key": task_key,
            "library_id": library_id,
            "album_key": album_key,
            "account_id": account_id,
            "origin_type": origin_type,
            "origin_key": origin_key,
            "deployment_mode": deployment_mode,
            "client_surface": client_surface,
            "candidate_generation": candidate_generation,
            "resource_revision": resource_revision,
            "scheduled_at": scheduled_at,
        }
        with self._connect() as connection:
            scope = _mapping(connection.execute(scope_sql, values).fetchone())
            if not scope:
                raise ValueError("cover lookup album/root scope is missing or ambiguous")
            values["local_album_id"] = _positive("local_album_id", scope.get("local_album_id"))
            values["library_root_id"] = _positive("library_root_id", scope.get("library_root_id"))
            task = _mapping(connection.execute(insert_sql, values).fetchone())
            if not task:
                raise ValueError("cover lookup identity conflicts with current resource scope")
            task_id = _positive("task_id", task.get("task_id"))
            command = EnqueueJob(
                kind="cover_lookup",
                subject_kind="cover_lookup_task",
                subject_ref=task_key,
                parameters={"task_id": task_id},
                account_id=account_id,
                library_id=library_id,
                capability_key="library.covers.lookup",
                request_origin_ref=request_origin_ref,
                deployment_mode=deployment_mode,
                client_surface=client_surface,
                idempotency_key=f"cover-lookup:{library_id}:{task_key}",
                scheduled_at=scheduled_at,
                max_attempts=2,
                resource_revision=resource_revision,
            )
            job_id = self._job_repository.enqueue_in_transaction(connection, command)
            linked = _mapping(
                connection.execute(
                    link_sql,
                    {"job_id": job_id, "task_id": task_id, "library_id": library_id},
                ).fetchone()
            )
            if not linked:
                raise RuntimeError("cover lookup job link lost its accepted task")
            return AcceptedCoverLookup(
                task_key=task_key,
                task_id=task_id,
                job_id=_positive("job_id", linked.get("job_id")),
                row_revision=int(linked.get("row_revision") or 0),
            )

    def get_task(self, *, task_key: str, library_id: int) -> dict[str, object] | None:
        values = {
            "library_id": _positive("library_id", library_id),
            "task_key": _bounded("task_key", task_key, maximum=128),
        }
        sql = """
            select *
              from ops.cover_lookup_tasks
             where library_id = %(library_id)s
               and task_key = %(task_key)s
        """
        with self._connect() as connection:
            row = _mapping(connection.execute(sql, values).fetchone())
        return row or None

    def compare_and_set_task(
        self,
        *,
        task_key: str,
        library_id: int,
        expected_row_revision: int,
        allowed_statuses: Sequence[str],
        next_status: str,
        completed_at: datetime | None = None,
    ) -> dict[str, object] | None:
        allowed = [
            _bounded("allowed_status", status, maximum=32) for status in allowed_statuses
        ]
        if not allowed:
            raise ValueError("allowed_statuses must not be empty")
        values = {
            "task_key": _bounded("task_key", task_key, maximum=128),
            "library_id": _positive("library_id", library_id),
            "expected_row_revision": max(0, int(expected_row_revision)),
            "allowed_statuses": allowed,
            "next_status": _bounded("next_status", next_status, maximum=32),
            "completed_at": completed_at,
        }
        sql = """
            update ops.cover_lookup_tasks
               set status = %(next_status)s,
                   completed_at = %(completed_at)s,
                   row_revision = row_revision + 1
             where library_id = %(library_id)s
               and task_key = %(task_key)s
               and row_revision = %(expected_row_revision)s
               and status = any(%(allowed_statuses)s::varchar[])
            returning *
        """
        with self._connect() as connection:
            row = _mapping(connection.execute(sql, values).fetchone())
        return row or None


__all__ = ["AcceptedCoverLookup", "PostgresCoverJobRepository"]
