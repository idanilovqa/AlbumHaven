"""Postgres authority for durable cover tasks and their generic job links."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
import json
from typing import Any
from uuid import UUID

try:  # pragma: no cover - optional driver import is environment-specific.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None

from music_app.services.jobs.repository_postgres import PostgresJobRepository


@dataclass(frozen=True)
class AcceptedCoverLookup:
    task_key: str
    task_id: int
    job_id: int
    row_revision: int


@dataclass(frozen=True)
class ClaimedCoverLookupScope:
    task_key: str
    task_id: int
    row_revision: int
    status: str
    cancel_requested: bool
    album: Mapping[str, object]
    track_paths: tuple[str, ...]
    manual_urls: tuple[str, ...]
    task_payload: Mapping[str, object]


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
        task_payload: Mapping[str, object] | None = None,
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
            "task_payload": json.dumps(dict(task_payload or {}), ensure_ascii=True),
        }
        with self._connect() as connection:
            accepted = _mapping(
                connection.execute(
                    """
                    select * from ops.accept_cover_lookup(
                      %(task_key)s, %(library_id)s, %(album_key)s,
                      %(account_id)s, %(origin_type)s, %(origin_key)s,
                      %(deployment_mode)s, %(client_surface)s,
                      %(candidate_generation)s, %(resource_revision)s,
                      %(scheduled_at)s, %(task_payload)s::jsonb
                    )
                    """,
                    values,
                ).fetchone()
            )
        if not accepted:
            raise RuntimeError("cover lookup acceptance returned no identity")
        return AcceptedCoverLookup(
            task_key=task_key,
            task_id=_positive("task_id", accepted.get("task_id")),
            job_id=_positive("job_id", accepted.get("job_id")),
            row_revision=max(0, int(accepted.get("row_revision") or 0)),
        )

    def current_inventory_revision(self, *, library_id: int) -> int:
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    """
                    select coalesce(
                             nullif(metadata ->> 'inventory_mutation_revision', '')::bigint,
                             0
                           ) as resource_revision
                      from library.libraries
                     where id = %(library_id)s
                    """,
                    {"library_id": _positive("library_id", library_id)},
                ).fetchone()
            )
        if not row:
            raise ValueError("library is unavailable")
        return max(0, int(row.get("resource_revision") or 0))

    @staticmethod
    def _claim_values(**values: object) -> dict[str, object]:
        return {
            "task_key": _bounded("task_key", values["task_key"], maximum=128),
            "task_id": _positive("task_id", values["task_id"]),
            "library_id": _positive("library_id", values["library_id"]),
            "job_id": _positive("job_id", values["job_id"]),
            "attempt": _positive("attempt", values["attempt"]),
            "worker_id": _bounded("worker_id", values["worker_id"], maximum=128),
            "lease_token": _bounded("lease_token", values["lease_token"], maximum=256),
            "now": values["now"],
        }

    def validate_claimed_candidate_lookup(self, **values: object) -> bool:
        parameters = self._claim_values(**values)
        with self._connect() as connection:
            row = connection.execute(
                "select ops.validate_claimed_cover_lookup(%(task_key)s, %(task_id)s, %(library_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s) as valid",
                parameters,
            ).fetchone()
        return bool(_mapping(row).get("valid"))

    def load_claimed_candidate_lookup(
        self, **values: object
    ) -> ClaimedCoverLookupScope | None:
        parameters = self._claim_values(**values)
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    "select * from ops.load_claimed_cover_lookup(%(task_key)s, %(task_id)s, %(library_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s)",
                    parameters,
                ).fetchone()
            )
        if not row:
            return None
        album = row.get("album_payload") or {}
        task_payload = row.get("task_payload") or {}
        if not isinstance(album, Mapping) or not isinstance(task_payload, Mapping):
            raise RuntimeError("claimed cover lookup payload is invalid")
        return ClaimedCoverLookupScope(
            task_key=_bounded("task_key", row.get("task_key"), maximum=128),
            task_id=_positive("task_id", row.get("task_id")),
            row_revision=max(0, int(row.get("row_revision") or 0)),
            status=_bounded("status", row.get("status"), maximum=32),
            cancel_requested=bool(row.get("cancel_requested")),
            album=dict(album),
            track_paths=tuple(str(path) for path in (row.get("track_paths") or ())),
            manual_urls=tuple(str(url) for url in (row.get("manual_urls") or ())),
            task_payload=dict(task_payload),
        )

    def candidate_lookup_cancel_requested(self, **values: object) -> bool:
        parameters = self._claim_values(**values)
        with self._connect() as connection:
            row = connection.execute(
                "select ops.claimed_cover_lookup_cancel_requested(%(task_key)s, %(task_id)s, %(library_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s) as cancel_requested",
                parameters,
            ).fetchone()
        mapped = _mapping(row)
        return not mapped or bool(mapped.get("cancel_requested"))

    def candidate_lookup_cancellation_state(
        self, **values: object
    ) -> tuple[bool, int] | None:
        parameters = self._claim_values(**values)
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    "select * from ops.load_claimed_cover_lookup_cancellation(%(task_key)s, %(task_id)s, %(library_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s)",
                    parameters,
                ).fetchone()
            )
        if not row:
            return None
        return bool(row.get("cancel_requested")), max(
            0, int(row.get("row_revision") or 0)
        )

    def request_candidate_lookup_cancellation(
        self,
        *,
        task_key: str,
        library_id: int,
        actor_account_id: int,
        now: datetime,
    ) -> dict[str, object] | None:
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    "select * from ops.request_cover_lookup_cancellation(%(task_key)s, %(library_id)s, %(actor_account_id)s, %(now)s)",
                    {
                        "task_key": _bounded("task_key", task_key, maximum=128),
                        "library_id": _positive("library_id", library_id),
                        "actor_account_id": _positive(
                            "actor_account_id", actor_account_id
                        ),
                        "now": now,
                    },
                ).fetchone()
            )
        payload = row.get("task_payload") if row else None
        return dict(payload) if isinstance(payload, Mapping) else None

    def publish_claimed_candidate_lookup(
        self,
        *,
        expected_row_revision: int,
        task_payload: Mapping[str, object],
        **values: object,
    ) -> ClaimedCoverLookupScope | None:
        parameters = self._claim_values(**values)
        parameters.update(
            {
                "expected_row_revision": max(0, int(expected_row_revision)),
                "task_payload": json.dumps(dict(task_payload), ensure_ascii=True),
            }
        )
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    "select * from ops.publish_claimed_cover_lookup(%(task_key)s, %(task_id)s, %(library_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s, %(expected_row_revision)s, %(task_payload)s::jsonb)",
                    parameters,
                ).fetchone()
            )
        if not row:
            return None
        return ClaimedCoverLookupScope(
            task_key=str(parameters["task_key"]),
            task_id=int(parameters["task_id"]),
            row_revision=max(0, int(row.get("row_revision") or 0)),
            status=str(row.get("status") or ""),
            cancel_requested=bool(row.get("cancel_requested")),
            album={},
            track_paths=(),
            manual_urls=(),
            task_payload=dict(row.get("task_payload") or task_payload),
        )

    def finalize_claimed_candidate_lookup_canceled(
        self,
        *,
        expected_row_revision: int,
        **values: object,
    ) -> ClaimedCoverLookupScope | None:
        parameters = self._claim_values(**values)
        parameters["expected_row_revision"] = max(0, int(expected_row_revision))
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    "select * from ops.finalize_claimed_cover_lookup_canceled(%(task_key)s, %(task_id)s, %(library_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s, %(expected_row_revision)s)",
                    parameters,
                ).fetchone()
            )
        if not row:
            return None
        return ClaimedCoverLookupScope(
            task_key=str(parameters["task_key"]),
            task_id=int(parameters["task_id"]),
            row_revision=max(0, int(row.get("row_revision") or 0)),
            status=str(row.get("status") or "canceled"),
            cancel_requested=True,
            album={},
            track_paths=(),
            manual_urls=(),
            task_payload=dict(row.get("task_payload") or {}),
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


__all__ = [
    "AcceptedCoverLookup",
    "ClaimedCoverLookupScope",
    "PostgresCoverJobRepository",
]
