"""Postgres domain records for durable scan and watcher work."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from hashlib import sha256
import hmac
import json
from pathlib import Path
from types import MappingProxyType
import re
from typing import Any

from music_app.services.jobs.models import (
    EnqueueJob,
    JobCancellationDisposition,
    JobCancellationResult,
    JobKind,
)
from music_app.services.jobs.registry import policy_for
from music_app.services.jobs.repository_postgres import PostgresJobRepository
from music_app.services.library_event_coordinator import (
    TargetedMove,
    TargetedReconciliationRequest,
)
from music_app.services.policy_evaluator import PolicyAudit, PolicyEvaluationResult


@dataclass(frozen=True, slots=True)
class ScanJobEnqueueResult:
    intent_id: int
    job_id: int
    created: bool = field(compare=False)


@dataclass(frozen=True, slots=True)
class ClaimedFullScanIntent:
    intent_id: int
    library_id: int
    initiating_account_id: int
    mode: str
    force: bool
    root_ids: tuple[str, ...]
    inventory_mutation_revision: int
    committed_inventory_revision: int | None


@dataclass(frozen=True, slots=True)
class ClaimedFullScanScope:
    roots: tuple[dict[str, object], ...]
    inventory_mutation_revision: int
    scope_complete: bool
    exception_overrides: Mapping[str, str] = field(
        default_factory=lambda: MappingProxyType({})
    )
    separate_release_keys: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ClaimedTargetedReconciliationIntent:
    intent_id: int
    library_id: int
    request: TargetedReconciliationRequest
    exception_overrides: Mapping[str, str]

    @property
    def root_id(self) -> str:
        return self.request.root_id

    @property
    def paths(self) -> frozenset[Path]:
        return self.request.paths

    @property
    def deleted_paths(self) -> frozenset[Path]:
        return self.request.deleted_paths

    @property
    def deleted_subtrees(self) -> frozenset[Path]:
        return self.request.deleted_subtrees

    @property
    def moves(self) -> tuple[TargetedMove, ...]:
        return self.request.moves


@dataclass(frozen=True, slots=True)
class ClaimedTargetedReconciliationScope:
    roots: tuple[dict[str, object], ...]
    root_healthy: bool
    scope_complete: bool


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


def _nonnegative_int(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a nonnegative integer")
    return value


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


def _approved_policy(
    value: object,
    *,
    action: str,
    library_id: int,
    require_bootstrap_owner: bool = False,
) -> PolicyAudit:
    if not isinstance(value, PolicyEvaluationResult):
        raise PermissionError("scan request is not authorized")
    decision = value.decision
    audit = value.audit
    if (
        not decision.allowed
        or decision.action != action
        or audit.action != action
        or audit.actor_class != "active"
        or audit.library_id != library_id
    ):
        raise PermissionError(f"scan request is not authorized for {action} or library")
    if require_bootstrap_owner and not audit.bootstrap_owner:
        raise PermissionError("cold-start scan requires the bootstrap owner")
    try:
        _positive_id(audit.account_id, "policy account_id")
    except ValueError:
        raise PermissionError("scan request has no authorized account") from None
    return audit


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

    def resolve_local_library_id(self) -> int:
        """Resolve the one bootstrap-owned local library for watcher work."""

        with self._connect() as connection:
            rows = connection.execute(
                """
                select library_record.id as library_id
                  from app.bootstrap_owners as owner_record
                  join library.libraries as library_record
                    on library_record.owner_account_id = owner_record.account_id
                 where owner_record.owner_key = 'local-bootstrap-owner'
                   and library_record.name = 'Local Library'
                   and library_record.library_kind = 'local'
                 order by library_record.id
                 limit 2
                """
            ).fetchall()
        if len(rows) != 1:
            raise RuntimeError("local library scope is unavailable")
        return _positive_id(_row_mapping(rows[0]).get("library_id"), "library_id")

    def enqueue_authorized_full_scan(
        self,
        *,
        policy_evaluation: PolicyEvaluationResult,
        library_id: int,
        request_origin_ref: str,
        root_ids: Iterable[str],
        mode: str,
        force: bool,
        scheduled_at: datetime,
        cold_start: bool = False,
    ) -> ScanJobEnqueueResult:
        """Persist a full-scan request only from its request-scoped policy result."""

        library_id = _positive_id(library_id, "library_id")
        if not isinstance(cold_start, bool):
            raise ValueError("cold_start must be a boolean")
        audit = _approved_policy(
            policy_evaluation,
            action="library.refresh",
            library_id=library_id,
            require_bootstrap_owner=cold_start,
        )
        origin_ref = _bounded_text(
            request_origin_ref, "request_origin_ref", maximum=1024
        )
        origin_type, separator, origin_key = origin_ref.partition(":")
        if (
            separator != ":"
            or not origin_key
            or origin_type != audit.request_origin_type
            or not hmac.compare_digest(
                sha256(origin_ref.encode("utf-8")).hexdigest(),
                audit.request_origin_ref_digest,
            )
        ):
            raise PermissionError("scan request origin does not match authorization")
        return self.enqueue_full_scan(
            library_id=library_id,
            account_id=_positive_id(audit.account_id, "policy account_id"),
            capability_key="library.refresh",
            request_origin_ref=origin_ref,
            deployment_mode=audit.deployment_mode,
            client_surface=audit.client_surface_class,
            root_ids=root_ids,
            mode=mode,
            force=force,
            scheduled_at=scheduled_at,
        )

    def cancel_authorized_full_scan(
        self,
        *,
        policy_evaluation: PolicyEvaluationResult,
        library_id: int,
        now: datetime,
    ) -> JobCancellationResult | None:
        """Request cancellation for the active durable scan in one library."""

        library_id = _positive_id(library_id, "library_id")
        audit = _approved_policy(
            policy_evaluation,
            action="library.refresh.cancel",
            library_id=library_id,
        )
        account_id = _positive_id(audit.account_id, "policy account_id")
        with self._connect() as connection:
            row = connection.execute(
                """
                select job_id, prior_state, next_state, reason_code,
                       transition_recorded
                  from library.request_active_full_scan_cancellation(
                    %(library_id)s, %(account_id)s, %(now)s
                  )
                """,
                {"library_id": library_id, "account_id": account_id, "now": now},
            ).fetchone()
        if row is None:
            return None
        payload = _row_mapping(row)
        job_id = _positive_id(payload.get("job_id"), "job_id")
        reason_code = str(payload.get("reason_code") or "")
        prior_state = payload.get("prior_state")
        next_state = payload.get("next_state")
        transition_recorded = bool(payload.get("transition_recorded"))
        if (
            reason_code == "immediate_canceled"
            and prior_state in {"queued", "retry_wait"}
            and next_state == "canceled"
            and transition_recorded
        ):
            disposition = JobCancellationDisposition.IMMEDIATE_CANCELED
        elif (
            reason_code == "running_requested"
            and prior_state == "running"
            and next_state == "running"
            and not transition_recorded
        ):
            disposition = JobCancellationDisposition.RUNNING_REQUESTED
        else:
            raise RuntimeError("full scan cancellation result coherence failure")
        return JobCancellationResult(job_id=job_id, disposition=disposition)

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
                    select intent_id, job_id, created
                      from library.create_full_scan_intent_v2(
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
            created = _row_mapping(row).get("created")
            if not isinstance(created, bool):
                raise RuntimeError("full scan acceptance disposition is invalid")
            if existing_job_id is not None:
                if created:
                    raise RuntimeError("full scan acceptance disposition is incoherent")
                return ScanJobEnqueueResult(intent_id, existing_job_id, False)
            if not created:
                raise RuntimeError("full scan acceptance disposition is incoherent")
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
            return ScanJobEnqueueResult(intent_id, job_id, True)

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
                return ScanJobEnqueueResult(intent_id, existing_job_id, False)
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
            return ScanJobEnqueueResult(intent_id, job_id, True)

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
                  from library.load_claimed_full_scan_intent_v2(
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
            inventory_mutation_revision=_nonnegative_int(
                payload.get("inventory_mutation_revision"),
                "inventory_mutation_revision",
            ),
            committed_inventory_revision=(
                _nonnegative_int(
                    payload.get("committed_inventory_revision"),
                    "committed_inventory_revision",
                )
                if payload.get("committed_inventory_revision") is not None
                else None
            ),
        )

    def load_claimed_full_scan_scope(
        self,
        *,
        intent_id: int,
        library_id: int,
        job_id: int,
        attempt: int,
        worker_id: str,
        lease_token: str,
        now: datetime,
    ) -> ClaimedFullScanScope:
        parameters = {
            "intent_id": _positive_id(intent_id, "intent_id"),
            "library_id": _positive_id(library_id, "library_id"),
            "job_id": _positive_id(job_id, "job_id"),
            "attempt": _positive_id(attempt, "attempt"),
            "worker_id": _bounded_text(worker_id, "worker_id"),
            "lease_token": _bounded_text(lease_token, "lease_token"),
            "now": now,
        }
        with self._connect() as connection:
            rows = connection.execute(
                """
                select *
                  from library.load_claimed_full_scan_scope(
                    %(intent_id)s, %(library_id)s, %(job_id)s, %(attempt)s,
                    %(worker_id)s, %(lease_token)s, %(now)s
                  )
                """,
                parameters,
            ).fetchall()
        roots: list[dict[str, object]] = []
        scope_complete = True
        inventory_mutation_revision: int | None = None
        exception_overrides: dict[str, str] = {}
        separate_release_keys: tuple[str, ...] = ()
        for raw_row in rows:
            row = _row_mapping(raw_row)
            row_revision = _nonnegative_int(
                row.get("inventory_mutation_revision"),
                "inventory_mutation_revision",
            )
            if (
                inventory_mutation_revision is not None
                and inventory_mutation_revision != row_revision
            ):
                raise RuntimeError("full scan scope revision is inconsistent")
            inventory_mutation_revision = row_revision
            raw_overrides = row.get("exception_overrides") or {}
            if not isinstance(raw_overrides, Mapping):
                raise RuntimeError("full scan exception overrides are invalid")
            exception_overrides = {
                _bounded_text(key, "exception override path", maximum=4096): str(value or "")
                for key, value in raw_overrides.items()
            }
            separate_release_keys = tuple(
                _bounded_text(value, "separate release key", maximum=1024)
                for value in row.get("separate_release_keys") or ()
            )
            roots.append(
                {
                    "id": _bounded_text(row.get("logical_root_id"), "root_id"),
                    "path": Path(
                        _bounded_text(
                            row.get("root_path"), "root_path", maximum=4096
                        )
                    ),
                    "category": _bounded_text(row.get("root_kind"), "root_kind"),
                    "library_id": _positive_id(row.get("library_id"), "library_id"),
                    "is_active": row.get("is_active") is True,
                }
            )
            scope_complete = scope_complete and row.get("scope_complete") is True
        return ClaimedFullScanScope(
            tuple(roots),
            (
                inventory_mutation_revision
                if inventory_mutation_revision is not None
                else 0
            ),
            bool(roots) and scope_complete,
            MappingProxyType(exception_overrides),
            separate_release_keys,
        )

    def checkpoint_claimed_full_scan(
        self,
        *,
        intent_id: int,
        job_id: int,
        attempt: int,
        worker_id: str,
        lease_token: str,
        current: int,
        total: int,
        current_path: str,
        phase: str,
        now: datetime,
    ) -> bool:
        if isinstance(current, bool) or not isinstance(current, int) or current < 0:
            raise ValueError("current must be a nonnegative integer")
        if isinstance(total, bool) or not isinstance(total, int) or total < current:
            raise ValueError("total must be an integer no smaller than current")
        path = str(current_path or "")
        if len(path) > 4096 or any(ord(character) < 32 for character in path):
            raise ValueError("current_path must be bounded text")
        with self._connect() as connection:
            row = connection.execute(
                """
                select library.checkpoint_claimed_full_scan(
                  %(intent_id)s, %(job_id)s, %(attempt)s,
                  %(worker_id)s, %(lease_token)s, %(phase)s,
                  %(current)s, %(total)s, %(current_path)s, %(now)s
                ) as checkpoint_accepted
                """,
                {
                    "intent_id": _positive_id(intent_id, "intent_id"),
                    "job_id": _positive_id(job_id, "job_id"),
                    "attempt": _positive_id(attempt, "attempt"),
                    "worker_id": _bounded_text(worker_id, "worker_id"),
                    "lease_token": _bounded_text(lease_token, "lease_token"),
                    "phase": _bounded_text(phase, "phase", maximum=32),
                    "current": current,
                    "total": total,
                    "current_path": path or None,
                    "now": now,
                },
            ).fetchone()
        return _row_mapping(row).get("checkpoint_accepted") is True

    def publish_claimed_full_scan(
        self,
        *,
        claim: Any,
        intent_id: int,
        expected_inventory_mutation_revision: int,
        inventory: Mapping[str, object],
        observed_root_ids: Iterable[str],
        now: datetime,
    ) -> dict[str, object]:
        roots = tuple(
            dict.fromkeys(_bounded_text(value, "root_id") for value in observed_root_ids)
        )
        if not roots:
            raise ValueError("full scan publication requires observed roots")
        with self._connect() as connection:
            row = connection.execute(
                """
                select * from library.publish_claimed_full_scan(
                  %(intent_id)s, %(job_id)s, %(attempt)s,
                  %(worker_id)s, %(lease_token)s, %(expected_revision)s,
                  %(inventory)s::jsonb, %(root_ids)s, %(now)s
                )
                """,
                {
                    "intent_id": _positive_id(intent_id, "intent_id"),
                    "job_id": _positive_id(claim.job_id, "job_id"),
                    "attempt": _positive_id(claim.attempt, "attempt"),
                    "worker_id": _bounded_text(claim.worker_id, "worker_id"),
                    "lease_token": _bounded_text(claim.lease_token, "lease_token"),
                    "expected_revision": _nonnegative_int(
                        expected_inventory_mutation_revision,
                        "expected_inventory_mutation_revision",
                    ),
                    "inventory": json.dumps(
                        dict(inventory), ensure_ascii=False, separators=(",", ":")
                    ),
                    "root_ids": list(roots),
                    "now": now,
                },
            ).fetchone()
        payload = _row_mapping(row)
        return {
            "publication_won": payload.get("publication_won") is True,
            "inventory_mutation_revision": (
                _nonnegative_int(
                    payload.get("inventory_mutation_revision"),
                    "inventory_mutation_revision",
                )
                if payload.get("inventory_mutation_revision") is not None
                else None
            ),
        }

    def load_authorized_full_scan_status(
        self,
        *,
        policy_evaluation: PolicyEvaluationResult,
        library_id: int,
    ) -> dict[str, object] | None:
        library_id = _positive_id(library_id, "library_id")
        _approved_policy(
            policy_evaluation,
            action="app.status.read",
            library_id=library_id,
        )
        with self._connect() as connection:
            row = connection.execute(
                "select * from library.load_authorized_full_scan_status(%(library_id)s)",
                {"library_id": library_id},
            ).fetchone()
        if row is None:
            return None
        payload = _row_mapping(row)
        return {
            "state": _bounded_text(payload.get("state"), "state", maximum=32),
            "progress_current": _nonnegative_int(
                payload.get("progress_current"), "progress_current"
            ),
            "progress_total": _nonnegative_int(
                payload.get("progress_total"), "progress_total"
            ),
            "current_path": str(payload.get("current_path") or ""),
            "phase": _bounded_text(payload.get("phase"), "phase", maximum=32),
            "mode": _bounded_text(payload.get("mode"), "mode", maximum=32),
            "outcome_code": (
                str(payload.get("outcome_code"))
                if payload.get("outcome_code") is not None
                else None
            ),
            "committed_inventory_revision": (
                _nonnegative_int(
                    payload.get("committed_inventory_revision"),
                    "committed_inventory_revision",
                )
                if payload.get("committed_inventory_revision") is not None
                else None
            ),
        }

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
                  from library.load_claimed_targeted_reconciliation_intent_v2(
                    %(job_id)s, %(worker_id)s, %(lease_token)s
                  )
                """,
                parameters,
            ).fetchone()
        payload = _row_mapping(row)
        moves_payload = payload.get("moves") or []
        request = TargetedReconciliationRequest(
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
        raw_overrides = payload.get("exception_overrides") or {}
        if not isinstance(raw_overrides, Mapping):
            raise RuntimeError("claimed targeted exception overrides are invalid")
        overrides = {
            _bounded_text(path, "exception override path", maximum=4096): str(
                value or ""
            )
            for path, value in raw_overrides.items()
        }
        return ClaimedTargetedReconciliationIntent(
            intent_id=_positive_id(payload.get("intent_id"), "intent_id"),
            library_id=_positive_id(payload.get("library_id"), "library_id"),
            request=request,
            exception_overrides=MappingProxyType(overrides),
        )

    def load_claimed_targeted_reconciliation_scope(
        self,
        *,
        intent_id: int,
        library_id: int,
        job_id: int,
        attempt: int,
        worker_id: str,
        lease_token: str,
        now: datetime,
    ) -> ClaimedTargetedReconciliationScope:
        parameters = {
            "intent_id": _positive_id(intent_id, "intent_id"),
            "library_id": _positive_id(library_id, "library_id"),
            "job_id": _positive_id(job_id, "job_id"),
            "attempt": _positive_id(attempt, "attempt"),
            "worker_id": _bounded_text(worker_id, "worker_id"),
            "lease_token": _bounded_text(lease_token, "lease_token"),
            "now": now,
        }
        with self._connect() as connection:
            rows = connection.execute(
                """
                select *
                  from library.load_claimed_targeted_reconciliation_scope(
                    %(intent_id)s, %(library_id)s, %(job_id)s, %(attempt)s,
                    %(worker_id)s, %(lease_token)s, %(now)s
                  )
                """,
                parameters,
            ).fetchall()
        roots: list[dict[str, object]] = []
        root_healthy = True
        scope_complete = True
        for raw_row in rows:
            row = _row_mapping(raw_row)
            roots.append(
                {
                    "id": _bounded_text(row.get("logical_root_id"), "root_id"),
                    "path": Path(_bounded_text(row.get("root_path"), "root_path", maximum=4096)),
                    "category": _bounded_text(row.get("root_kind"), "root_kind"),
                    "library_id": _positive_id(row.get("library_id"), "library_id"),
                    "is_active": row.get("is_active") is True,
                }
            )
            root_healthy = root_healthy and row.get("root_healthy") is True
            scope_complete = (
                scope_complete and row.get("scope_complete") is True
            )
        return ClaimedTargetedReconciliationScope(
            tuple(roots), root_healthy, bool(roots) and scope_complete
        )

    def fence_targeted_reconciliation_publication(
        self,
        *,
        connection: Any,
        claim: Any,
        intent_id: int,
        commit: Callable[[], object],
        now: datetime,
    ) -> bool:
        row = connection.execute(
            """
            select library.fence_targeted_reconciliation_publication(
              %(intent_id)s, %(job_id)s, %(attempt)s,
              %(worker_id)s, %(lease_token)s, %(now)s
            ) as publication_won
            """,
            {
                "intent_id": _positive_id(intent_id, "intent_id"),
                "job_id": _positive_id(claim.job_id, "job_id"),
                "attempt": _positive_id(claim.attempt, "attempt"),
                "worker_id": _bounded_text(claim.worker_id, "worker_id"),
                "lease_token": _bounded_text(claim.lease_token, "lease_token"),
                "now": now,
            },
        ).fetchone()
        publication_won = _row_mapping(row).get("publication_won") is True
        if not publication_won:
            rollback = getattr(connection, "rollback", None)
            if callable(rollback):
                rollback()
            return False
        commit()
        return True

    def publish_claimed_targeted_reconciliation(
        self,
        *,
        claim: Any,
        intent_id: int,
        inventory: Mapping[str, object],
        stale_scopes: Iterable[Mapping[str, object]],
        now: datetime,
    ) -> dict[str, object]:
        parameters = {
            "intent_id": _positive_id(intent_id, "intent_id"),
            "job_id": _positive_id(claim.job_id, "job_id"),
            "attempt": _positive_id(claim.attempt, "attempt"),
            "worker_id": _bounded_text(claim.worker_id, "worker_id"),
            "lease_token": _bounded_text(claim.lease_token, "lease_token"),
            "inventory": json.dumps(
                dict(inventory), ensure_ascii=False, separators=(",", ":")
            ),
            "stale_scopes": json.dumps(
                [dict(scope) for scope in stale_scopes],
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            "now": now,
        }
        with self._connect() as connection:
            row = connection.execute(
                """
                select *
                  from library.publish_claimed_targeted_reconciliation(
                    %(intent_id)s, %(job_id)s, %(attempt)s,
                    %(worker_id)s, %(lease_token)s,
                    %(inventory)s::jsonb, %(stale_scopes)s::jsonb, %(now)s
                  )
                """,
                parameters,
            ).fetchone()
        payload = _row_mapping(row)
        return {
            "publication_won": payload.get("publication_won") is True,
            "inventory_mutation_revision": int(
                payload.get("inventory_mutation_revision") or 0
            ),
            "affected_album_keys": tuple(
                str(key) for key in payload.get("affected_album_keys") or ()
            ),
        }

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
    "ClaimedFullScanScope",
    "PostgresScanJobRepository",
    "ScanJobEnqueueResult",
]
