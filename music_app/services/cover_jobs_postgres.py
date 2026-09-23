"""Postgres authority for durable cover tasks and their generic job links."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
import json
from pathlib import Path
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
class AcceptedCoverBulkRefresh:
    task_key: str
    task_id: int
    job_id: int
    row_revision: int
    already_running: bool


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


@dataclass(frozen=True)
class ClaimedCoverRefreshScope:
    task_id: int
    task_key: str
    row_revision: int
    file_cache: Mapping[str, Mapping[str, object]]
    separate_release_keys: tuple[str, ...]
    progress_total: int
    mode: str
    force_search: bool


@dataclass(frozen=True)
class AcceptedCoverRemoteSave:
    task_key: str
    task_id: int
    job_id: int
    row_revision: int
    checkpoint_revision: int


@dataclass(frozen=True)
class ClaimedCoverRemoteSaveScope:
    checkpoint_id: int
    checkpoint: str
    checkpoint_revision: int
    task_revision: int
    candidate_generation: UUID
    candidate_id: str
    selected_candidate: Mapping[str, object]
    library_root_path: str
    track_paths: tuple[str, ...]


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


def _timestamp_text(value: object) -> str:
    return value.isoformat() if isinstance(value, datetime) else str(value or "").strip()


def _candidate_lookup_task_from_row(row: object) -> dict[str, object] | None:
    mapped = _mapping(row)
    task_key = str(mapped.get("task_key") or "").strip()
    payload = mapped.get("provider_payload")
    if not task_key or not isinstance(payload, Mapping):
        return None
    task = dict(payload)
    for private_key in (
        "album_payload",
        "track_paths",
        "path",
        "track_ref",
        "selected_cover_private_path",
        "selected_cover_path",
        "local_cover_path",
        "cover_path",
    ):
        task.pop(private_key, None)
    task["id"] = task_key
    task["status"] = str(mapped.get("status") or task.get("status") or "").strip()
    metadata = mapped.get("metadata")
    metadata = metadata if isinstance(metadata, Mapping) else {}
    task["notification_action_taken"] = bool(
        metadata.get("notification_action_taken")
    )
    completed_at = _timestamp_text(mapped.get("completed_at"))
    if completed_at:
        task["notification_completed_at"] = completed_at
    task["notification_expires_at"] = ""
    return task


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

    def persist_candidate_authority(
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
        recorded_at: datetime,
        task_payload: Mapping[str, object],
        candidates: Sequence[Mapping[str, object]],
        best_candidate_id: str | None,
    ) -> dict[str, object]:
        """Atomically bind synchronous candidates to durable task/snapshot authority."""

        origin_type, separator, origin_key = _bounded(
            "request_origin_ref", request_origin_ref, maximum=1024
        ).partition(":")
        if not separator or not origin_type or not origin_key:
            raise ValueError("request_origin_ref must contain type and key")
        if not isinstance(candidate_generation, UUID):
            raise ValueError("candidate_generation must be a UUID")
        normalized_candidates = [
            dict(candidate) for candidate in candidates if isinstance(candidate, Mapping)
        ]
        if not normalized_candidates:
            raise ValueError("candidate authority requires candidates")
        values = {
            "task_key": _bounded("task_key", task_key, maximum=128),
            "library_id": _positive("library_id", library_id),
            "album_key": _bounded("album_key", album_key, maximum=1024),
            "account_id": _positive("account_id", account_id),
            "origin_type": _bounded("origin_type", origin_type, maximum=64),
            "origin_key": _bounded("origin_key", origin_key, maximum=512),
            "deployment_mode": _bounded(
                "deployment_mode", deployment_mode, maximum=128
            ),
            "client_surface": _bounded(
                "client_surface", client_surface, maximum=128
            ),
            "candidate_generation": candidate_generation,
            "resource_revision": max(0, int(resource_revision)),
            "recorded_at": recorded_at,
            "task_payload": json.dumps(dict(task_payload), ensure_ascii=True),
            "candidates": json.dumps(normalized_candidates, ensure_ascii=True),
            "best_candidate_id": (
                _bounded("best_candidate_id", best_candidate_id, maximum=256)
                if best_candidate_id
                else None
            ),
        }
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    "select * from ops.persist_cover_candidate_authority(%(task_key)s, %(library_id)s, %(album_key)s, %(account_id)s, %(origin_type)s, %(origin_key)s, %(deployment_mode)s, %(client_surface)s, %(candidate_generation)s, %(resource_revision)s, %(recorded_at)s, %(task_payload)s::jsonb, %(candidates)s::jsonb, %(best_candidate_id)s)",
                    values,
                ).fetchone()
            )
        if not row:
            raise ValueError("cover candidate authority scope is unavailable")
        return row

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

    def accept_bulk_refresh(
        self,
        *,
        task_key: str,
        library_id: int,
        account_id: int,
        request_origin_ref: str,
        deployment_mode: str,
        client_surface: str,
        mode: str,
        force_search: bool,
        resource_revision: int,
        scheduled_at: datetime,
    ) -> AcceptedCoverBulkRefresh:
        origin_type, separator, origin_key = _bounded(
            "request_origin_ref", request_origin_ref, maximum=1024
        ).partition(":")
        if not separator:
            raise ValueError("request_origin_ref must contain type and key")
        values = {
            "task_key": _bounded("task_key", task_key, maximum=128),
            "library_id": _positive("library_id", library_id),
            "account_id": _positive("account_id", account_id),
            "origin_type": _bounded("origin_type", origin_type, maximum=64),
            "origin_key": _bounded("origin_key", origin_key, maximum=512),
            "deployment_mode": _bounded(
                "deployment_mode", deployment_mode, maximum=128
            ),
            "client_surface": _bounded(
                "client_surface", client_surface, maximum=128
            ),
            "mode": _bounded("mode", mode, maximum=32),
            "force_search": bool(force_search),
            "resource_revision": max(0, int(resource_revision)),
            "scheduled_at": scheduled_at,
        }
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    "select * from ops.accept_cover_bulk_refresh(%(task_key)s, %(library_id)s, %(account_id)s, %(origin_type)s, %(origin_key)s, %(deployment_mode)s, %(client_surface)s, %(mode)s, %(force_search)s, %(resource_revision)s, %(scheduled_at)s)",
                    values,
                ).fetchone()
            )
        if not row:
            raise ValueError("cover bulk refresh scope is unavailable")
        return AcceptedCoverBulkRefresh(
            task_key=str(values["task_key"]),
            task_id=_positive("task_id", row.get("task_id")),
            job_id=_positive("job_id", row.get("job_id")),
            row_revision=max(0, int(row.get("row_revision") or 0)),
            already_running=bool(row.get("already_running")),
        )

    def request_bulk_refresh_cancellation(
        self, *, library_id: int, account_id: int, now: datetime
    ) -> dict[str, bool]:
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    "select * from ops.request_cover_bulk_refresh_cancellation(%(library_id)s, %(account_id)s, %(now)s)",
                    {
                        "library_id": _positive("library_id", library_id),
                        "account_id": _positive("account_id", account_id),
                        "now": now,
                    },
                ).fetchone()
            )
        return {
            "cancelled": bool(row.get("canceled")),
            "covers_in_progress": bool(row.get("covers_in_progress")),
        }

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

    @staticmethod
    def _candidate_snapshot_mutation_values(
        *,
        album_id: int,
        candidate_generation: UUID,
        operation: str,
        search_kind: str,
        search_started_at: str,
        candidates: Sequence[Mapping[str, object]],
        best_candidate_id: str | None,
        automatic_improvement: bool,
        candidate_id: str | None,
        **_unused: object,
    ) -> dict[str, object]:
        normalized_operation = _bounded(
            "operation", operation, maximum=32
        ).casefold()
        if normalized_operation not in {
            "publish",
            "finish_completed",
            "finish_failed",
            "mark_improvement",
        }:
            raise ValueError("candidate snapshot operation is invalid")
        normalized_kind = _bounded("search_kind", search_kind, maximum=32).casefold()
        if normalized_kind not in {"automatic", "manual"}:
            raise ValueError("candidate snapshot search kind is invalid")
        if not isinstance(candidate_generation, UUID):
            raise ValueError("candidate_generation must be a UUID")
        return {
            "album_id": _positive("album_id", album_id),
            "candidate_generation": candidate_generation,
            "operation": normalized_operation,
            "search_kind": normalized_kind,
            "search_started_at": str(search_started_at or "").strip() or None,
            "candidates": json.dumps(
                [
                    dict(candidate)
                    for candidate in candidates
                    if isinstance(candidate, Mapping)
                ],
                ensure_ascii=True,
            ),
            "best_candidate_id": str(best_candidate_id or "").strip() or None,
            "automatic_improvement": bool(automatic_improvement),
            "candidate_id": str(candidate_id or "").strip() or None,
        }

    def mutate_claimed_lookup_candidate_snapshot(
        self, *, task_key: str, task_id: int, **values: object
    ) -> bool:
        parameters = self._claim_values(
            task_key=task_key, task_id=task_id, **values
        )
        parameters.update(self._candidate_snapshot_mutation_values(**values))
        with self._connect() as connection:
            row = connection.execute(
                "select ops.mutate_claimed_cover_lookup_candidate_snapshot(%(task_key)s, %(task_id)s, %(library_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s, %(album_id)s, %(candidate_generation)s, %(operation)s, %(search_kind)s, %(search_started_at)s::timestamptz, %(candidates)s::jsonb, %(best_candidate_id)s, %(automatic_improvement)s, %(candidate_id)s) as accepted",
                parameters,
            ).fetchone()
        return bool(_mapping(row).get("accepted"))

    def mutate_claimed_refresh_candidate_snapshot(
        self, *, task_id: int, **values: object
    ) -> bool:
        parameters = self._refresh_claim_values(task_id=task_id, **values)
        parameters.update(self._candidate_snapshot_mutation_values(**values))
        with self._connect() as connection:
            row = connection.execute(
                "select ops.mutate_claimed_cover_refresh_candidate_snapshot(%(task_id)s, %(library_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s, %(album_id)s, %(candidate_generation)s, %(operation)s, %(search_kind)s, %(search_started_at)s::timestamptz, %(candidates)s::jsonb, %(best_candidate_id)s, %(automatic_improvement)s, %(candidate_id)s) as accepted",
                parameters,
            ).fetchone()
        return bool(_mapping(row).get("accepted"))

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

    @staticmethod
    def _refresh_claim_values(**values: object) -> dict[str, object]:
        return {
            "task_id": (
                _positive("task_id", values["task_id"])
                if values.get("task_id") is not None
                else None
            ),
            "library_id": _positive("library_id", values["library_id"]),
            "job_id": _positive("job_id", values["job_id"]),
            "attempt": _positive("attempt", values["attempt"]),
            "worker_id": _bounded("worker_id", values["worker_id"], maximum=128),
            "lease_token": _bounded("lease_token", values["lease_token"], maximum=256),
            "now": values["now"],
        }

    def begin_claimed_cover_refresh(
        self,
        *,
        mode: str | None,
        inventory_revision: int | None,
        task_key: str,
        **values: object,
    ) -> ClaimedCoverRefreshScope | None:
        parameters = self._refresh_claim_values(**values)
        parameters.update(
            {
                "mode": str(mode or ""),
                "inventory_revision": max(0, int(inventory_revision or 0)),
                "task_key": _bounded("task_key", task_key, maximum=128),
            }
        )
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    "select * from ops.begin_claimed_cover_refresh(%(library_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s, %(mode)s, %(inventory_revision)s, %(task_key)s)",
                    parameters,
                ).fetchone()
            )
        if not row:
            return None
        raw_file_cache = row.get("file_cache") or {}
        if not isinstance(raw_file_cache, Mapping):
            raise RuntimeError("claimed cover refresh inventory is invalid")
        file_cache = {
            str(path): dict(entry)
            for path, entry in raw_file_cache.items()
            if str(path).strip() and isinstance(entry, Mapping)
        }
        return ClaimedCoverRefreshScope(
            task_id=_positive("task_id", row.get("task_id")),
            task_key=_bounded("task_key", row.get("task_key"), maximum=128),
            row_revision=max(0, int(row.get("row_revision") or 0)),
            file_cache=file_cache,
            separate_release_keys=tuple(
                str(key)
                for key in (row.get("separate_release_keys") or ())
                if str(key).strip()
            ),
            progress_total=max(0, int(row.get("progress_total") or 0)),
            mode=_bounded("mode", row.get("mode"), maximum=32),
            force_search=bool(row.get("force_search")),
        )

    def cover_refresh_cancel_requested(self, **values: object) -> bool:
        parameters = self._refresh_claim_values(**values)
        with self._connect() as connection:
            row = connection.execute(
                "select ops.cover_refresh_cancel_requested(%(task_id)s, %(library_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s) as cancel_requested",
                parameters,
            ).fetchone()
        mapped = _mapping(row)
        return not mapped or bool(mapped.get("cancel_requested"))

    def checkpoint_claimed_cover_refresh(
        self,
        *,
        expected_row_revision: int,
        progress_current: int,
        progress_total: int,
        downloaded_count: int,
        safe_display_label: str,
        **values: object,
    ) -> int | None:
        parameters = self._refresh_claim_values(**values)
        parameters.update(
            {
                "expected_row_revision": max(0, int(expected_row_revision)),
                "progress_current": max(0, int(progress_current)),
                "progress_total": max(0, int(progress_total)),
                "downloaded_count": max(0, int(downloaded_count)),
                "safe_display_label": str(safe_display_label or "")[:256],
            }
        )
        with self._connect() as connection:
            row = connection.execute(
                "select ops.checkpoint_claimed_cover_refresh(%(task_id)s, %(library_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s, %(expected_row_revision)s, %(progress_current)s, %(progress_total)s, %(downloaded_count)s, %(safe_display_label)s) as row_revision",
                parameters,
            ).fetchone()
        revision = _mapping(row).get("row_revision")
        return int(revision) if revision is not None else None

    def finish_claimed_cover_refresh(
        self,
        *,
        expected_row_revision: int,
        next_status: str,
        processed_count: int,
        downloaded_count: int,
        failed_count: int = 0,
        **values: object,
    ) -> bool:
        del failed_count
        parameters = self._refresh_claim_values(**values)
        parameters.update(
            {
                "expected_row_revision": max(0, int(expected_row_revision)),
                "next_status": _bounded("next_status", next_status, maximum=32),
                "processed_count": max(0, int(processed_count)),
                "downloaded_count": max(0, int(downloaded_count)),
            }
        )
        with self._connect() as connection:
            row = connection.execute(
                "select ops.finish_claimed_cover_refresh(%(task_id)s, %(library_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s, %(expected_row_revision)s, %(next_status)s, %(processed_count)s, %(downloaded_count)s) as finished",
                parameters,
            ).fetchone()
        return bool(_mapping(row).get("finished"))

    def persist_claimed_automatic_cover_selection(
        self,
        *,
        track_paths: set[str],
        selected_cover_path: Path,
        cover_revision: str,
        cover_selection_origin: str,
        reject_if_user_controlled: bool,
        expected_cover_selection_origin: str | None = None,
        expected_cover_revision: str | None = None,
        commit_guard: Callable[[Callable[[], object]], object] | None = None,
        **values: object,
    ) -> dict[str, object]:
        parameters = self._refresh_claim_values(**values)
        normalized_paths = sorted(
            {str(path or "").strip() for path in track_paths if str(path or "").strip()}
        )
        if not normalized_paths:
            raise ValueError("claimed cover selection requires track paths")
        origin = _bounded(
            "cover_selection_origin", cover_selection_origin, maximum=32
        ).casefold()
        if origin not in {"automatic", "user"}:
            raise ValueError("cover_selection_origin is invalid")
        expected_origin = str(expected_cover_selection_origin or "").strip() or None
        expected_revision = str(expected_cover_revision or "").strip() or None
        if (expected_origin is None) != (expected_revision is None):
            raise ValueError("expected cover state must be complete")
        parameters.update(
            {
                "track_paths": normalized_paths,
                "selected_cover_path": str(selected_cover_path),
                "cover_revision": _bounded(
                    "cover_revision", cover_revision, maximum=256
                ),
                "cover_selection_origin": origin,
                "reject_if_user_controlled": bool(reject_if_user_controlled),
                "expected_cover_selection_origin": expected_origin,
                "expected_cover_revision": expected_revision,
            }
        )
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    "select * from ops.persist_claimed_automatic_cover_selection(%(task_id)s, %(library_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s, %(track_paths)s, %(selected_cover_path)s, %(cover_revision)s, %(cover_selection_origin)s, %(reject_if_user_controlled)s, %(expected_cover_selection_origin)s, %(expected_cover_revision)s)",
                    parameters,
                ).fetchone()
            )
            result = {
                key: value for key, value in row.items()
            }
            if bool(
                result.get("blocked_by_user_selection")
                or result.get("blocked_by_expected_cover_state")
            ):
                connection.commit()
                return result
            if (
                int(result.get("input_path_count") or 0) != len(normalized_paths)
                or int(result.get("resolved_path_count") or 0) != len(normalized_paths)
                or int(result.get("selected_album_count") or 0) != 1
                or int(result.get("album_rows_updated") or 0) != 1
                or int(result.get("album_track_file_count") or 0)
                != int(result.get("track_file_rows_updated") or 0)
            ):
                raise RuntimeError(
                    "claimed cover persistence lost its resource or lease fence"
                )
            if commit_guard is not None:
                commit_guard(connection.commit)
            return result

    def load_cover_refresh_status(self, *, library_id: int) -> dict[str, object] | None:
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    "select * from ops.load_authorized_cover_refresh_status(%(library_id)s)",
                    {"library_id": _positive("library_id", library_id)},
                ).fetchone()
            )
        return row or None

    def accept_remote_save(
        self,
        *,
        task_key: str,
        library_id: int,
        account_id: int,
        request_origin_ref: str,
        deployment_mode: str,
        client_surface: str,
        candidate_generation: UUID,
        candidate_id: str,
        resource_revision: int,
        scheduled_at: datetime,
    ) -> AcceptedCoverRemoteSave:
        origin_type, separator, origin_key = _bounded(
            "request_origin_ref", request_origin_ref, maximum=1024
        ).partition(":")
        if not separator or not isinstance(candidate_generation, UUID):
            raise ValueError("remote save origin or candidate generation is invalid")
        values = {
            "task_key": _bounded("task_key", task_key, maximum=128),
            "library_id": _positive("library_id", library_id),
            "account_id": _positive("account_id", account_id),
            "origin_type": _bounded("origin_type", origin_type, maximum=64),
            "origin_key": _bounded("origin_key", origin_key, maximum=512),
            "deployment_mode": _bounded(
                "deployment_mode", deployment_mode, maximum=128
            ),
            "client_surface": _bounded(
                "client_surface", client_surface, maximum=128
            ),
            "candidate_generation": candidate_generation,
            "candidate_id": _bounded("candidate_id", candidate_id, maximum=256),
            "resource_revision": max(0, int(resource_revision)),
            "scheduled_at": scheduled_at,
        }
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    "select * from ops.accept_cover_remote_save(%(task_key)s, %(library_id)s, %(account_id)s, %(origin_type)s, %(origin_key)s, %(deployment_mode)s, %(client_surface)s, %(candidate_generation)s, %(candidate_id)s, %(resource_revision)s, %(scheduled_at)s)",
                    values,
                ).fetchone()
            )
        if not row:
            raise ValueError("remote cover candidate scope is unavailable")
        return AcceptedCoverRemoteSave(
            task_key=str(values["task_key"]),
            task_id=_positive("task_id", row.get("task_id")),
            job_id=_positive("job_id", row.get("job_id")),
            row_revision=max(0, int(row.get("row_revision") or 0)),
            checkpoint_revision=max(
                0, int(row.get("checkpoint_revision") or 0)
            ),
        )

    def load_claimed_remote_save(self, **values: object) -> ClaimedCoverRemoteSaveScope | None:
        parameters = self._claim_values(**values)
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    "select * from ops.load_claimed_cover_remote_save(%(task_key)s, %(task_id)s, %(library_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s)",
                    parameters,
                ).fetchone()
            )
        if not row:
            return None
        candidate = row.get("selected_candidate")
        generation = row.get("candidate_generation")
        return ClaimedCoverRemoteSaveScope(
            checkpoint_id=_positive("checkpoint_id", row.get("checkpoint_id")),
            checkpoint=_bounded("checkpoint", row.get("checkpoint"), maximum=32),
            checkpoint_revision=max(
                0, int(row.get("checkpoint_revision") or 0)
            ),
            task_revision=max(0, int(row.get("task_revision") or 0)),
            candidate_generation=(
                generation if isinstance(generation, UUID) else UUID(str(generation))
            ),
            candidate_id=_bounded("candidate_id", row.get("candidate_id"), maximum=256),
            selected_candidate=(dict(candidate) if isinstance(candidate, Mapping) else {}),
            library_root_path=_bounded(
                "library_root_path", row.get("library_root_path"), maximum=8192
            ),
            track_paths=tuple(str(path) for path in (row.get("track_paths") or ())),
        )

    def checkpoint_claimed_remote_save(
        self,
        *,
        checkpoint_id: int,
        expected_row_revision: int,
        next_checkpoint: str,
        artifact_key: UUID | None = None,
        cover_revision: str | None = None,
        reason_code: str | None = None,
        **values: object,
    ) -> int | None:
        parameters = self._refresh_claim_values(**values)
        parameters.update(
            {
                "checkpoint_id": _positive("checkpoint_id", checkpoint_id),
                "expected_row_revision": max(0, int(expected_row_revision)),
                "next_checkpoint": _bounded(
                    "next_checkpoint", next_checkpoint, maximum=32
                ),
                "artifact_key": artifact_key,
                "cover_revision": str(cover_revision or "").strip() or None,
                "reason_code": str(reason_code or "").strip() or None,
            }
        )
        with self._connect() as connection:
            row = connection.execute(
                "select ops.checkpoint_claimed_cover_remote_save(%(checkpoint_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s, %(expected_row_revision)s, %(next_checkpoint)s, %(artifact_key)s, %(cover_revision)s, %(reason_code)s) as row_revision",
                parameters,
            ).fetchone()
        revision = _mapping(row).get("row_revision")
        return int(revision) if revision is not None else None

    def publish_claimed_remote_save(
        self,
        *,
        checkpoint_id: int,
        task_id: int,
        expected_checkpoint_revision: int,
        expected_task_revision: int,
        selected_cover_path: str | None,
        linked_remote: bool,
        **values: object,
    ) -> tuple[int, int] | None:
        parameters = self._refresh_claim_values(**values)
        parameters.update(
            {
                "checkpoint_id": _positive("checkpoint_id", checkpoint_id),
                "task_id": _positive("task_id", task_id),
                "expected_checkpoint_revision": max(
                    0, int(expected_checkpoint_revision)
                ),
                "expected_task_revision": max(0, int(expected_task_revision)),
                "selected_cover_path": str(selected_cover_path or "") or None,
                "linked_remote": bool(linked_remote),
            }
        )
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    "select * from ops.publish_claimed_cover_remote_save(%(checkpoint_id)s, %(task_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s, %(expected_checkpoint_revision)s, %(expected_task_revision)s, %(selected_cover_path)s, %(linked_remote)s)",
                    parameters,
                ).fetchone()
            )
        if not row:
            return None
        return (
            max(0, int(row.get("checkpoint_revision") or 0)),
            max(0, int(row.get("task_revision") or 0)),
        )

    def persist_claimed_remote_cover_selection(
        self,
        *,
        checkpoint_id: int,
        expected_checkpoint_revision: int,
        selected_cover_path: str | None,
        selected_cover_revision: str | None,
        linked_remote: bool,
        **values: object,
    ) -> int | None:
        parameters = self._refresh_claim_values(**values)
        parameters.update(
            {
                "checkpoint_id": _positive("checkpoint_id", checkpoint_id),
                "expected_checkpoint_revision": max(
                    0, int(expected_checkpoint_revision)
                ),
                "selected_cover_path": str(selected_cover_path or "") or None,
                "selected_cover_revision": str(
                    selected_cover_revision or ""
                ).strip()
                or None,
                "linked_remote": bool(linked_remote),
            }
        )
        with self._connect() as connection:
            row = connection.execute(
                "select ops.persist_claimed_remote_cover_selection(%(checkpoint_id)s, %(job_id)s, %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s, %(expected_checkpoint_revision)s, %(selected_cover_path)s, %(selected_cover_revision)s, %(linked_remote)s) as row_revision",
                parameters,
            ).fetchone()
        revision = _mapping(row).get("row_revision")
        return int(revision) if revision is not None else None

    @staticmethod
    def _task_management_values(
        *, actor_account_id: int, library_id: int
    ) -> dict[str, object]:
        return {
            "actor_account_id": _positive("actor_account_id", actor_account_id),
            "library_id": _positive("library_id", library_id),
            "terminal_statuses": ["completed", "failed", "canceled"],
        }

    def list_candidate_lookup_tasks(
        self, *, actor_account_id: int, library_id: int
    ) -> list[dict[str, object]]:
        values = self._task_management_values(
            actor_account_id=actor_account_id, library_id=library_id
        )
        sql = """
            select task_key, status, requested_at, completed_at,
                   provider_payload, metadata
              from ops.cover_lookup_tasks as task
             where task.library_id = %(library_id)s
               and task.metadata ->> 'source_family' = 'durable_cover_lookup'
               and coalesce(task.metadata ->> 'notification_cleared', 'false') <> 'true'
               and exists (
                     select 1
                       from library.libraries as scoped_library
                      where scoped_library.id = task.library_id
                        and (
                          scoped_library.owner_account_id = %(actor_account_id)s
                          or exists (
                            select 1
                              from library.library_memberships as membership
                             where membership.library_id = task.library_id
                               and membership.account_id = %(actor_account_id)s
                          )
                        )
                   )
             order by coalesce(task.completed_at, task.requested_at) desc,
                      task.task_key desc
        """
        with self._connect() as connection:
            rows = connection.execute(sql, values).fetchall()
        return [
            task
            for task in (_candidate_lookup_task_from_row(row) for row in rows)
            if task is not None
        ]

    def clear_completed_candidate_lookup_tasks(
        self,
        *,
        actor_account_id: int,
        library_id: int,
        task_keys: Sequence[str] | None,
    ) -> set[str]:
        values = self._task_management_values(
            actor_account_id=actor_account_id, library_id=library_id
        )
        normalized_keys = [
            _bounded("task_key", task_key, maximum=128)
            for task_key in (task_keys or ())
        ]
        if task_keys is not None and not normalized_keys:
            return set()
        values.update(
            {
                "clear_all": task_keys is None,
                "task_keys": normalized_keys,
            }
        )
        sql = """
            update ops.cover_lookup_tasks as task
               set metadata = jsonb_set(
                     coalesce(task.metadata, '{}'::jsonb),
                     '{notification_cleared}',
                     'true'::jsonb,
                     true
                   ),
                   row_revision = task.row_revision + 1
             where task.library_id = %(library_id)s
               and task.metadata ->> 'source_family' = 'durable_cover_lookup'
               and coalesce(task.metadata ->> 'notification_cleared', 'false') <> 'true'
               and task.status = any(%(terminal_statuses)s::varchar[])
               and (%(clear_all)s or task.task_key = any(%(task_keys)s::text[]))
               and exists (
                     select 1
                       from library.libraries as scoped_library
                      where scoped_library.id = task.library_id
                        and (
                          scoped_library.owner_account_id = %(actor_account_id)s
                          or exists (
                            select 1
                              from library.library_memberships as membership
                             where membership.library_id = task.library_id
                               and membership.account_id = %(actor_account_id)s
                          )
                        )
                   )
            returning task.task_key
        """
        with self._connect() as connection:
            rows = connection.execute(sql, values).fetchall()
        return {
            str(_mapping(row).get("task_key") or "").strip()
            for row in rows
            if str(_mapping(row).get("task_key") or "").strip()
        }

    def mark_candidate_lookup_notification_action_taken(
        self,
        *,
        actor_account_id: int,
        library_id: int,
        task_key: str,
    ) -> dict[str, object] | None:
        values = self._task_management_values(
            actor_account_id=actor_account_id, library_id=library_id
        )
        values["task_key"] = _bounded("task_key", task_key, maximum=128)
        sql = """
            update ops.cover_lookup_tasks as task
               set metadata = jsonb_set(
                     coalesce(metadata, '{}'::jsonb),
                     '{notification_action_taken}',
                     'true'::jsonb,
                     true
                   ),
                   row_revision = row_revision + 1
             where task.library_id = %(library_id)s
               and task.task_key = %(task_key)s
               and task.metadata ->> 'source_family' = 'durable_cover_lookup'
               and coalesce(task.metadata ->> 'notification_cleared', 'false') <> 'true'
               and task.status = any(%(terminal_statuses)s::varchar[])
               and exists (
                     select 1
                       from library.libraries as scoped_library
                      where scoped_library.id = task.library_id
                        and (
                          scoped_library.owner_account_id = %(actor_account_id)s
                          or exists (
                            select 1
                              from library.library_memberships as membership
                             where membership.library_id = task.library_id
                               and membership.account_id = %(actor_account_id)s
                          )
                        )
                   )
            returning task.task_key, task.status, task.requested_at,
                      task.completed_at, task.provider_payload, task.metadata
        """
        with self._connect() as connection:
            row = connection.execute(sql, values).fetchone()
        return _candidate_lookup_task_from_row(row)

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
    "AcceptedCoverBulkRefresh",
    "ClaimedCoverLookupScope",
    "ClaimedCoverRefreshScope",
    "AcceptedCoverRemoteSave",
    "ClaimedCoverRemoteSaveScope",
    "PostgresCoverJobRepository",
]
