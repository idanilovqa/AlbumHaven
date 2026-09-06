"""Postgres domain records for durable scan and watcher work."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256
import json
from pathlib import Path
import re
from typing import Any

from music_app.services.jobs.models import EnqueueJob, JobKind
from music_app.services.jobs.registry import policy_for
from music_app.services.jobs.repository_postgres import PostgresJobRepository
from music_app.services.library_event_coordinator import (
    TargetedMove,
    TargetedReconciliationRequest,
)


@dataclass(frozen=True, slots=True)
class ScanJobEnqueueResult:
    intent_id: int
    job_id: int


@dataclass(frozen=True, slots=True)
class ClaimedFullScanIntent:
    intent_id: int
    library_id: int
    initiating_account_id: int
    mode: str
    force: bool
    root_ids: tuple[str, ...]


def _connect(database_url: str) -> Any:
    import psycopg
    from psycopg.rows import dict_row

    return psycopg.connect(database_url, row_factory=dict_row)


def _positive_id(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _optional_positive_id(value: object, name: str) -> int | None:
    if value is None:
        return None
    return _positive_id(value, name)


def _bounded_text(value: object, name: str, *, maximum: int = 128) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > maximum
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError(f"{name} must be a nonblank bounded string")
    return value.strip()


def _producer_request_key(value: object) -> str:
    key = _bounded_text(value, "producer_request_key", maximum=256)
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9:_-]{0,255}", key) is None:
        raise ValueError("producer_request_key must be an opaque identifier")
    return key


def _row_mapping(row: object) -> Mapping[str, Any]:
    if not isinstance(row, Mapping):
        raise RuntimeError("scan job repository returned an invalid row")
    return row


class PostgresScanJobRepository:
    """Compose private scan intent writes with path-free generic jobs."""

    def __init__(
        self,
        *,
        database_url: str,
        connect_to_database: Callable[[str], Any] | None = None,
        job_repository: Any | None = None,
    ) -> None:
        self._database_url = str(database_url or "").strip()
        self._connect_to_database = connect_to_database or _connect
        self._job_repository = job_repository or PostgresJobRepository(
            database_url=self._database_url,
            connect_to_database=self._connect_to_database,
        )

    def _connect(self) -> Any:
        if not self._database_url:
            raise RuntimeError("scan job database URL is required")
        return self._connect_to_database(self._database_url)

    def enqueue_full_scan(
        self,
        *,
        library_id: int,
        account_id: int,
        capability_key: str,
        request_origin_ref: str,
        deployment_mode: str,
        client_surface: str,
        root_ids: Iterable[str],
        mode: str,
        force: bool,
        scheduled_at: datetime,
    ) -> ScanJobEnqueueResult:
        library_id = _positive_id(library_id, "library_id")
        account_id = _positive_id(account_id, "account_id")
        capability_key = _bounded_text(capability_key, "capability_key")
        request_origin_ref = _bounded_text(
            request_origin_ref, "request_origin_ref", maximum=1024
        )
        deployment_mode = _bounded_text(deployment_mode, "deployment_mode")
        client_surface = _bounded_text(client_surface, "client_surface")
        mode = _bounded_text(mode, "mode")
        if not isinstance(force, bool):
            raise ValueError("force must be a boolean")
        logical_roots = tuple(
            dict.fromkeys(_bounded_text(value, "root_id") for value in root_ids)
        )
        if not logical_roots:
            raise ValueError("at least one root_id is required")

        with self._connect() as connection:
            resolved = self._resolve_roots(connection, library_id, logical_roots)
            root_database_ids = [resolved[root_id] for root_id in logical_roots]
            try:
                row = connection.execute(
                    """
                    select intent_id, job_id
                      from library.create_full_scan_intent(
                        %(library_id)s, %(account_id)s, %(capability_key)s,
                        %(request_origin_ref)s, %(deployment_mode)s,
                        %(client_surface)s, %(mode)s, %(force)s,
                        %(root_ids)s, %(accepted_at)s
                      )
                    """,
                    {
                        "library_id": library_id,
                        "account_id": account_id,
                        "capability_key": capability_key,
                        "request_origin_ref": request_origin_ref,
                        "deployment_mode": deployment_mode,
                        "client_surface": client_surface,
                        "mode": mode,
                        "force": force,
                        "root_ids": root_database_ids,
                        "accepted_at": scheduled_at,
                    },
                ).fetchone()
            except Exception as exc:
                if (
                    getattr(exc, "sqlstate", None) == "P0001"
                    and "full scan request origin is invalid" in str(exc)
                ):
                    raise ValueError(
                        "request origin is missing or no longer accepted"
                    ) from None
                raise
            intent_id = _positive_id(
                _row_mapping(row).get("intent_id"), "intent_id"
            )
            existing_job_id = _optional_positive_id(
                _row_mapping(row).get("job_id"), "job_id"
            )
            if existing_job_id is not None:
                return ScanJobEnqueueResult(intent_id, existing_job_id)
            policy = policy_for(JobKind.FULL_SCAN)
            job_id = self._job_repository.enqueue_in_transaction(
                connection,
                EnqueueJob(
                    kind=JobKind.FULL_SCAN,
                    subject_kind="full_scan_intent",
                    subject_ref=str(intent_id),
                    parameters={"intent_id": intent_id},
                    account_id=account_id,
                    library_id=library_id,
                    capability_key=capability_key,
                    request_origin_ref=request_origin_ref,
                    deployment_mode=deployment_mode,
                    client_surface=client_surface,
                    idempotency_key=f"full-scan-intent:{intent_id}",
                    scheduled_at=scheduled_at,
                    max_attempts=policy.max_attempts,
                ),
            )
            self._link_intent(connection, "full_scan", intent_id, job_id)
            return ScanJobEnqueueResult(intent_id, job_id)

    def enqueue_targeted_reconciliation(
        self,
        *,
        library_id: int,
        request: TargetedReconciliationRequest,
        deployment_mode: str,
        client_surface: str,
        scheduled_at: datetime,
        producer_request_key: str | None = None,
    ) -> ScanJobEnqueueResult:
        library_id = _positive_id(library_id, "library_id")
        if not isinstance(request, TargetedReconciliationRequest):
            raise ValueError("targeted reconciliation request is invalid")
        deployment_mode = _bounded_text(deployment_mode, "deployment_mode")
        client_surface = _bounded_text(client_surface, "client_surface")
        logical_root_ids = tuple(
            dict.fromkeys(
                [request.root_id]
                + [move.source_root_id for move in request.moves]
                + [move.destination_root_id for move in request.moves]
            )
        )
        logical_root_ids = tuple(
            _bounded_text(value, "root_id") for value in logical_root_ids
        )

        with self._connect() as connection:
            resolved = self._resolve_roots(connection, library_id, logical_root_ids)
            moves = [
                {
                    "destination_path": str(move.destination),
                    "destination_root_id": resolved[move.destination_root_id],
                    "is_directory": bool(move.is_directory),
                    "ordinal": ordinal,
                    "source_path": str(move.source),
                    "source_root_id": resolved[move.source_root_id],
                }
                for ordinal, move in enumerate(request.moves)
            ]
            active_paths = sorted(str(path) for path in request.paths)
            deleted_paths = sorted(str(path) for path in request.deleted_paths)
            deleted_subtrees = sorted(str(path) for path in request.deleted_subtrees)
            canonical_payload = json.dumps(
                {
                    "active_paths": active_paths,
                    "deleted_paths": deleted_paths,
                    "deleted_subtrees": deleted_subtrees,
                    "moves": moves,
                    "primary_root_id": resolved[request.root_id],
                },
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
                sort_keys=True,
            )
            request_digest = sha256(canonical_payload.encode("utf-8")).hexdigest()
            accepted_request_key = (
                _producer_request_key(producer_request_key)
                if producer_request_key is not None
                else request_digest
            )
            row = connection.execute(
                """
                select intent_id, job_id
                  from library.create_targeted_reconciliation_intent(
                    %(library_id)s, %(primary_root_id)s,
                    %(producer_request_key)s, %(request_digest)s,
                    %(deployment_mode)s, %(client_surface)s,
                    %(active_paths)s, %(deleted_paths)s,
                    %(deleted_subtrees)s, %(moves_json)s::jsonb,
                    %(accepted_at)s
                  )
                """,
                {
                    "library_id": library_id,
                    "primary_root_id": resolved[request.root_id],
                    "producer_request_key": accepted_request_key,
                    "request_digest": request_digest,
                    "deployment_mode": deployment_mode,
                    "client_surface": client_surface,
                    "active_paths": active_paths,
                    "deleted_paths": deleted_paths,
                    "deleted_subtrees": deleted_subtrees,
                    "moves_json": json.dumps(
                        moves, ensure_ascii=False, separators=(",", ":"), sort_keys=True
                    ),
                    "accepted_at": scheduled_at,
                },
            ).fetchone()
            intent_id = _positive_id(
                _row_mapping(row).get("intent_id"), "intent_id"
            )
            existing_job_id = _optional_positive_id(
                _row_mapping(row).get("job_id"), "job_id"
            )
            if existing_job_id is not None:
                return ScanJobEnqueueResult(intent_id, existing_job_id)
            policy = policy_for(JobKind.TARGETED_RECONCILIATION)
            job_id = self._job_repository.enqueue_in_transaction(
                connection,
                EnqueueJob(
                    kind=JobKind.TARGETED_RECONCILIATION,
                    subject_kind="targeted_reconciliation_intent",
                    subject_ref=str(intent_id),
                    parameters={"intent_id": intent_id},
                    account_id=None,
                    library_id=library_id,
                    capability_key=None,
                    request_origin_ref=None,
                    deployment_mode=deployment_mode,
                    client_surface=client_surface,
                    idempotency_key=(
                        f"targeted-reconciliation-request:{accepted_request_key}"
                    ),
                    scheduled_at=scheduled_at,
                    max_attempts=policy.max_attempts,
                ),
            )
            self._link_intent(connection, "targeted_reconciliation", intent_id, job_id)
            return ScanJobEnqueueResult(intent_id, job_id)

    def load_claimed_full_scan(
        self, *, job_id: int, worker_id: str, lease_token: str
    ) -> ClaimedFullScanIntent:
        parameters = {
            "job_id": _positive_id(job_id, "job_id"),
            "worker_id": _bounded_text(worker_id, "worker_id"),
            "lease_token": _bounded_text(lease_token, "lease_token"),
        }
        with self._connect() as connection:
            row = connection.execute(
                """
                select *
                  from library.load_claimed_full_scan_intent(
                    %(job_id)s, %(worker_id)s, %(lease_token)s
                  )
                """,
                parameters,
            ).fetchone()
        payload = _row_mapping(row)
        return ClaimedFullScanIntent(
            intent_id=_positive_id(payload.get("intent_id"), "intent_id"),
            library_id=_positive_id(payload.get("library_id"), "library_id"),
            initiating_account_id=_positive_id(
                payload.get("initiating_account_id"), "initiating_account_id"
            ),
            mode=_bounded_text(payload.get("mode"), "mode"),
            force=bool(payload.get("force")),
            root_ids=tuple(
                _bounded_text(value, "root_id")
                for value in payload.get("logical_root_ids") or ()
            ),
        )

    def load_claimed_targeted_reconciliation(
        self, *, job_id: int, worker_id: str, lease_token: str
    ) -> TargetedReconciliationRequest:
        parameters = {
            "job_id": _positive_id(job_id, "job_id"),
            "worker_id": _bounded_text(worker_id, "worker_id"),
            "lease_token": _bounded_text(lease_token, "lease_token"),
        }
        with self._connect() as connection:
            row = connection.execute(
                """
                select *
                  from library.load_claimed_targeted_reconciliation_intent(
                    %(job_id)s, %(worker_id)s, %(lease_token)s
                  )
                """,
                parameters,
            ).fetchone()
        payload = _row_mapping(row)
        moves_payload = payload.get("moves") or []
        return TargetedReconciliationRequest(
            root_id=_bounded_text(payload.get("logical_root_id"), "root_id"),
            paths=frozenset(Path(value) for value in payload.get("active_paths") or ()),
            deleted_paths=frozenset(
                Path(value) for value in payload.get("deleted_paths") or ()
            ),
            deleted_subtrees=frozenset(
                Path(value) for value in payload.get("deleted_subtrees") or ()
            ),
            moves=tuple(
                TargetedMove(
                    source=Path(item["source_path"]),
                    destination=Path(item["destination_path"]),
                    source_root_id=str(item["source_root_ref"]),
                    destination_root_id=str(item["destination_root_ref"]),
                    is_directory=bool(item.get("is_directory")),
                )
                for item in moves_payload
                if isinstance(item, Mapping)
            ),
        )

    @staticmethod
    def _resolve_roots(
        connection: Any, library_id: int, logical_root_ids: tuple[str, ...]
    ) -> dict[str, int]:
        rows = connection.execute(
            """
            select metadata ->> 'root_id' as logical_root_id,
                   id as root_id, library_id, is_active
              from library.library_roots
             where metadata ->> 'root_id' = any(%(logical_root_ids)s)
               and library_id = %(library_id)s
               and is_active is true
            """,
            {"library_id": library_id, "logical_root_ids": list(logical_root_ids)},
        ).fetchall()
        resolved: dict[str, int] = {}
        for raw_row in rows:
            row = _row_mapping(raw_row)
            logical = str(row.get("logical_root_id") or "")
            if (
                logical in logical_root_ids
                and row.get("library_id") == library_id
                and row.get("is_active") is True
            ):
                if logical in resolved:
                    raise ValueError("ambiguous library root identity")
                resolved[logical] = _positive_id(row.get("root_id"), "root_id")
        if set(resolved) != set(logical_root_ids):
            raise ValueError("one or more library roots are missing or inactive")
        return resolved

    @staticmethod
    def _link_intent(
        connection: Any, kind: str, intent_id: int, job_id: int
    ) -> None:
        row = connection.execute(
            """
            select intent_id
              from library.link_scan_intent_job(
                %(kind)s, %(intent_id)s, %(job_id)s
              )
            """,
            {"kind": kind, "intent_id": intent_id, "job_id": job_id},
        ).fetchone()
        linked_id = _positive_id(
            _row_mapping(row).get("intent_id"), "linked intent_id"
        )
        if linked_id != intent_id:
            raise RuntimeError("scan intent job link did not match the accepted intent")


__all__ = [
    "ClaimedFullScanIntent",
    "PostgresScanJobRepository",
    "ScanJobEnqueueResult",
]
