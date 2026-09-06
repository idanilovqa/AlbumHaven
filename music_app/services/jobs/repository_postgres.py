"""Short-transaction Postgres repository for the durable job ledger."""

from __future__ import annotations

import json
import re
import secrets
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
from typing import Any

from .models import (
    ClaimedJob,
    EnqueueJob,
    JobCancellationDisposition,
    JobCancellationResult,
    JobHeartbeatResult,
    JobState,
    JobStatusSnapshot,
    JobTransitionResult,
    StaleLeaseReconciliationResult,
)
from .registry import policy_for, validate_enqueue


_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")
_REASON_CODE = re.compile(r"[a-z][a-z0-9_]{0,127}\Z")
_POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807
_TERMINAL_STATES = frozenset(
    {JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELED, JobState.AMBIGUOUS}
)
_FINISH_STATES = _TERMINAL_STATES | {JobState.RETRY_WAIT}


def _default_connect(database_url: str) -> Any:
    import psycopg
    from psycopg.rows import dict_row

    return psycopg.connect(database_url, row_factory=dict_row)


def _kind_value(command: EnqueueJob) -> str:
    return command.kind.value if hasattr(command.kind, "value") else str(command.kind)


def _require_aware_datetime(name: str, value: datetime) -> None:
    if (
        not isinstance(value, datetime)
        or value.tzinfo is None
        or value.utcoffset() is None
    ):
        raise ValueError(f"{name} must be a timezone-aware datetime")


def _require_positive_integer(name: str, value: int) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value <= 0
        or value > _POSTGRES_BIGINT_MAX
    ):
        raise ValueError(f"{name} must be a positive integer")


def _require_bounded_identifier(name: str, value: str, maximum: int = 128) -> None:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > maximum
        or _CONTROL_CHARACTER.search(value)
    ):
        raise ValueError(f"{name} must be a nonblank bounded identifier")


def _require_reason_code(value: str) -> None:
    if not isinstance(value, str) or not _REASON_CODE.fullmatch(value):
        raise ValueError("outcome reason_code must be a closed lowercase code")


class PostgresJobRepository:
    """Persist and lease registered jobs without exposing generic ledger rows."""

    def __init__(
        self,
        *,
        database_url: str,
        connect_to_database: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(database_url or "").strip()
        self._connect_to_database = connect_to_database or _default_connect

    def _connect(self) -> Any:
        if not self._database_url:
            raise RuntimeError("durable job database_url is required")
        return self._connect_to_database(self._database_url)

    def enqueue(self, command: EnqueueJob) -> int:
        validate_enqueue(command)
        if command.request_origin_ref is not None:
            origin_type, separator, origin_key = command.request_origin_ref.partition(":")
            if not separator or not origin_type or not origin_key:
                raise ValueError("request origin reference must contain type and key")
        with self._connect() as connection:
            return self.enqueue_in_transaction(connection, command)

    def enqueue_in_transaction(self, connection: Any, command: EnqueueJob) -> int:
        """Enqueue through an existing transaction owned by a domain service."""

        validate_enqueue(command)
        kind = _kind_value(command)
        policy = policy_for(command.kind)
        values = {
            "kind": kind,
            "subject_kind": command.subject_kind,
            "subject_ref": command.subject_ref,
            "parameters": json.dumps(
                dict(command.parameters),
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
                sort_keys=True,
            ),
            "account_id": command.account_id,
            "library_id": command.library_id,
            "capability_key": command.capability_key,
            "request_origin_ref": command.request_origin_ref,
            "deployment_mode": command.deployment_mode,
            "client_surface": command.client_surface,
            "idempotency_key": command.idempotency_key,
            "scheduled_at": command.scheduled_at,
            "max_attempts": command.max_attempts,
            "recovery_policy": policy.recovery_policy.value,
            "priority": command.priority,
            "scope_version": command.scope_version,
            "resource_revision": command.resource_revision,
        }
        request_origin_id = None
        request_origin_sql = """
            select id as request_origin_id
              from app.request_origins
             where origin_type = %(request_origin_type)s
               and origin_key = %(request_origin_key)s
               and client_surface_class = %(client_surface)s
               and account_id is not distinct from %(account_id)s
             order by id desc
             limit 1
        """
        if command.request_origin_ref is not None:
            request_origin_type, separator, request_origin_key = (
                command.request_origin_ref.partition(":")
            )
            if not separator or not request_origin_type or not request_origin_key:
                raise ValueError("request origin reference must contain type and key")
            values["request_origin_type"] = request_origin_type
            values["request_origin_key"] = request_origin_key
        insert_sql = """
            insert into ops.jobs (
              kind, subject_kind, subject_ref, parameters, account_id,
              library_id, capability_key, request_origin_id, deployment_mode,
              client_surface, idempotency_key, scheduled_at, max_attempts,
              recovery_policy, priority, scope_version, resource_revision
            )
            select
              %(kind)s, %(subject_kind)s, %(subject_ref)s,
              %(parameters)s::jsonb, %(account_id)s, %(library_id)s,
              %(capability_key)s, %(request_origin_id)s, %(deployment_mode)s,
              %(client_surface)s, %(idempotency_key)s, %(scheduled_at)s,
              %(max_attempts)s, %(recovery_policy)s, %(priority)s,
              %(scope_version)s, %(resource_revision)s
            on conflict do nothing
            returning id as job_id
        """
        lookup_sql = """
            select id as job_id
              from ops.jobs
             where kind = %(kind)s
               and coalesce(account_id, 0) = coalesce(%(account_id)s, 0)
               and coalesce(library_id, 0) = coalesce(%(library_id)s, 0)
               and subject_kind = %(subject_kind)s
               and subject_ref = %(subject_ref)s
               and idempotency_key = %(idempotency_key)s
               and request_origin_id is not distinct from %(request_origin_id)s
        """
        if command.request_origin_ref is not None:
            origin_row = connection.execute(request_origin_sql, values).fetchone()
            if origin_row is None:
                raise ValueError("request origin is missing or no longer accepted")
            request_origin_id = int(origin_row["request_origin_id"])
        values["request_origin_id"] = request_origin_id
        row = connection.execute(insert_sql, values).fetchone()
        if row is None:
            row = connection.execute(lookup_sql, values).fetchone()
        if row is None:
            raise RuntimeError("idempotent job enqueue could not be resolved")
        return int(row["job_id"])

    def claim(
        self, *, worker_id: str, now: datetime, lease_seconds: int
    ) -> ClaimedJob | None:
        _require_bounded_identifier("worker_id", worker_id)
        _require_aware_datetime("now", now)
        if (
            isinstance(lease_seconds, bool)
            or not isinstance(lease_seconds, int)
            or lease_seconds < 1
            or lease_seconds > 86400
        ):
            raise ValueError("lease_seconds must be a bounded positive integer")

        lease_token = secrets.token_urlsafe(32)
        lease_expires_at = now + timedelta(seconds=lease_seconds)
        statement = """
            with candidate as (
              select id, state as prior_state
                from ops.jobs as jobs
               where state in ('queued', 'retry_wait')
                 and scheduled_at <= %(now)s
                 and cancel_requested_at is null
                 and attempt_count < max_attempts
               order by priority desc, scheduled_at, id
               for update skip locked
               limit 1
            ), claimed as (
              update ops.jobs as jobs
                 set state = 'running',
                     attempt_count = jobs.attempt_count + 1,
                     lease_owner = %(worker_id)s,
                     lease_token = %(lease_token)s,
                     lease_expires_at = %(lease_expires_at)s,
                     heartbeat_at = %(now)s,
                     started_at = coalesce(jobs.started_at, %(now)s),
                     updated_at = %(now)s
                from candidate
               where jobs.id = candidate.id
               returning jobs.id as job_id, jobs.kind, jobs.subject_kind,
                         jobs.subject_ref, jobs.parameters, jobs.account_id,
                         jobs.library_id, jobs.capability_key,
                         jobs.request_origin_id, jobs.deployment_mode,
                         jobs.client_surface, jobs.idempotency_key,
                         jobs.attempt_count as attempt, jobs.max_attempts,
                         jobs.lease_owner as worker_id, jobs.lease_token,
                         jobs.lease_expires_at, jobs.scheduled_at, jobs.priority,
                         jobs.scope_version, jobs.resource_revision,
                         candidate.prior_state
            ), transitioned as (
              insert into ops.job_transitions (
                job_id, prior_state, next_state, attempt_count, reason_code,
                retry_decision, worker_instance_id, transitioned_at
              )
              select job_id, prior_state, 'running', attempt, 'claimed',
                     'none', worker_id, %(now)s
                from claimed
              returning job_id
            )
            select claimed.job_id, claimed.kind, claimed.subject_kind,
                   claimed.subject_ref, claimed.parameters, claimed.account_id,
                   claimed.library_id, claimed.capability_key,
                   claimed.request_origin_id, claimed.deployment_mode,
                   claimed.client_surface, claimed.idempotency_key,
                   claimed.attempt, claimed.max_attempts, claimed.worker_id,
                   claimed.lease_token, claimed.lease_expires_at,
                   claimed.scheduled_at, claimed.priority,
                   claimed.scope_version, claimed.resource_revision
              from claimed
              join transitioned using (job_id)
        """
        with self._connect() as connection:
            row = connection.execute(
                statement,
                {
                    "worker_id": worker_id,
                    "lease_token": lease_token,
                    "lease_expires_at": lease_expires_at,
                    "now": now,
                },
            ).fetchone()
            return None if row is None else self._claimed_job(row)

    def heartbeat(
        self,
        claim: ClaimedJob,
        *,
        now: datetime,
        lease_seconds: int,
    ) -> JobHeartbeatResult:
        _require_aware_datetime("now", now)
        if (
            isinstance(lease_seconds, bool)
            or not isinstance(lease_seconds, int)
            or lease_seconds < 1
            or lease_seconds > 86400
        ):
            raise ValueError("lease_seconds must be a bounded positive integer")
        statement = """
            update ops.jobs
               set heartbeat_at = %(now)s,
                   lease_expires_at = %(lease_expires_at)s,
                   updated_at = %(now)s
             where id = %(job_id)s
               and state = 'running'
               and attempt_count = %(attempt)s
               and lease_token = %(lease_token)s
               and lease_owner = %(worker_id)s
               and lease_expires_at > %(now)s
            returning id as job_id,
                      cancel_requested_at is not null as cancel_requested
        """
        with self._connect() as connection:
            row = connection.execute(
                statement,
                {
                    "now": now,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "job_id": claim.job_id,
                    "attempt": claim.attempt,
                    "lease_token": claim.lease_token,
                    "worker_id": claim.worker_id,
                },
            ).fetchone()
            if row is None:
                return JobHeartbeatResult(active=False, cancel_requested=False)
            return JobHeartbeatResult(
                active=True, cancel_requested=bool(row["cancel_requested"])
            )

    def request_cancel(
        self, job_id: int, *, actor_account_id: int, now: datetime
    ) -> JobCancellationResult:
        _require_positive_integer("job_id", job_id)
        _require_positive_integer("actor_account_id", actor_account_id)
        _require_aware_datetime("now", now)
        statement = """
            select job_id, prior_state, next_state, reason_code, transition_recorded
              from ops.request_job_cancellation(
                %(job_id)s, %(actor_account_id)s, %(now)s
              )
        """
        with self._connect() as connection:
            row = connection.execute(
                statement,
                {
                    "job_id": job_id,
                    "actor_account_id": actor_account_id,
                    "now": now,
                },
            ).fetchone()
            if row is None:
                raise RuntimeError("job cancellation did not return a disposition")
            returned_job_id = int(row["job_id"])
            reason_code = str(row["reason_code"])
            prior_state = row["prior_state"]
            next_state = row["next_state"]
            transition_recorded = bool(row["transition_recorded"])
            if returned_job_id != job_id:
                raise RuntimeError("job cancellation result coherence failure")
            if reason_code in {"canceled", "immediate_canceled"} and (
                prior_state in {"queued", "retry_wait"}
                and next_state == "canceled"
                and transition_recorded
            ):
                disposition = JobCancellationDisposition.IMMEDIATE_CANCELED
            elif reason_code in {"cancel_requested", "running_requested"} and (
                prior_state == "running"
                and next_state == "running"
                and not transition_recorded
            ):
                disposition = JobCancellationDisposition.RUNNING_REQUESTED
            elif reason_code == "terminal_noop" and (
                prior_state in {"succeeded", "failed", "canceled", "ambiguous"}
                and next_state == prior_state
                and not transition_recorded
            ):
                disposition = JobCancellationDisposition.NOOP
            elif reason_code in {"not_found", "noop"} and (
                prior_state is None and next_state is None and not transition_recorded
            ):
                disposition = JobCancellationDisposition.NOOP
            else:
                raise RuntimeError("job cancellation result coherence failure")
            return JobCancellationResult(
                job_id=returned_job_id, disposition=disposition
            )

    def finish(
        self,
        claim: ClaimedJob,
        outcome: JobTransitionResult,
        *,
        now: datetime,
    ) -> bool:
        _require_aware_datetime("now", now)
        try:
            next_state = (
                outcome.next_state
                if isinstance(outcome.next_state, JobState)
                else JobState(outcome.next_state)
            )
        except (TypeError, ValueError) as exc:
            raise ValueError("outcome state is invalid") from exc
        if next_state not in _FINISH_STATES:
            raise ValueError("outcome state cannot finish a running job")
        _require_reason_code(outcome.reason_code)

        is_retry = next_state is JobState.RETRY_WAIT
        if is_retry:
            if outcome.scheduled_at is None:
                raise ValueError("retry outcome requires scheduled_at")
            _require_aware_datetime("retry scheduled_at", outcome.scheduled_at)
            if claim.attempt >= claim.max_attempts:
                raise ValueError("retry outcome exceeds the attempt limit")
        elif outcome.scheduled_at is not None:
            raise ValueError("terminal outcome cannot include retry scheduled_at")

        state_value = next_state.value
        retry_decision = "scheduled" if is_retry else "none"
        completed_at = None if is_retry else now
        statement = f"""
            with updated as (
              update ops.jobs
                 set state = '{state_value}',
                     scheduled_at = coalesce(%(scheduled_at)s, scheduled_at),
                     completed_at = %(completed_at)s,
                     outcome_code = %(reason_code)s,
                     lease_owner = null,
                     lease_token = null,
                     lease_expires_at = null,
                     heartbeat_at = null,
                     updated_at = %(now)s
               where id = %(job_id)s
                 and state = 'running'
                 and attempt_count = %(attempt)s
                 and lease_token = %(lease_token)s
                 and lease_owner = %(worker_id)s
                 and lease_expires_at > %(now)s
              returning id as job_id, attempt_count
            ), transitioned as (
              insert into ops.job_transitions (
                job_id, prior_state, next_state, attempt_count, reason_code,
                retry_decision, next_due_at, worker_instance_id, transitioned_at
              )
              select job_id, 'running', '{state_value}', attempt_count,
                     %(reason_code)s, '{retry_decision}', %(scheduled_at)s,
                     %(worker_id)s, %(now)s
                from updated
              returning job_id
            )
            select job_id from transitioned
        """
        with self._connect() as connection:
            row = connection.execute(
                statement,
                {
                    "scheduled_at": outcome.scheduled_at,
                    "completed_at": completed_at,
                    "reason_code": outcome.reason_code,
                    "now": now,
                    "job_id": claim.job_id,
                    "attempt": claim.attempt,
                    "lease_token": claim.lease_token,
                    "worker_id": claim.worker_id,
                },
            ).fetchone()
            return row is not None

    def reconcile_stale_leases(
        self, *, now: datetime, limit: int
    ) -> StaleLeaseReconciliationResult:
        _require_aware_datetime("now", now)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 1000:
            raise ValueError("stale lease limit must be between 1 and 1000")
        statement = """
            with stale as (
              select id, attempt_count, max_attempts, recovery_policy,
                     cancel_requested_at,
                     recovery_policy = 'retry_safe'
                       and attempt_count < max_attempts as can_retry
                from ops.jobs
               where state = 'running'
                 and lease_expires_at <= %(now)s
               order by lease_expires_at, id
               for update skip locked
               limit %(limit)s
            ), updated as (
              update ops.jobs as jobs
                 set state = case
                       when stale.cancel_requested_at is not null
                        and stale.recovery_policy = 'retry_safe' then 'canceled'
                       when stale.recovery_policy = 'ambiguous_on_stale_lease' then 'ambiguous'
                       when stale.can_retry then 'retry_wait'
                       when stale.recovery_policy = 'retry_safe' then 'failed'
                       else 'ambiguous'
                     end,
                     scheduled_at = case
                       when stale.cancel_requested_at is not null
                        and stale.recovery_policy = 'retry_safe' then jobs.scheduled_at
                       when stale.can_retry then %(now)s
                       else jobs.scheduled_at
                     end,
                     completed_at = case
                       when stale.cancel_requested_at is not null
                        and stale.recovery_policy = 'retry_safe' then %(now)s
                       when stale.can_retry then null
                       else %(now)s
                     end,
                     outcome_code = case
                       when stale.cancel_requested_at is not null
                        and stale.recovery_policy = 'retry_safe' then 'stale_lease_canceled'
                       when stale.can_retry then 'stale_lease_retry'
                       when stale.recovery_policy = 'retry_safe' then 'attempts_exhausted'
                       else 'stale_lease_ambiguous'
                     end,
                     lease_owner = null,
                     lease_token = null,
                     lease_expires_at = null,
                     heartbeat_at = null,
                     updated_at = %(now)s
                from stale
               where jobs.id = stale.id
               returning jobs.id as job_id, jobs.state as next_state,
                         jobs.attempt_count, stale.recovery_policy,
                         jobs.scheduled_at, jobs.outcome_code
            ), transitioned as (
              insert into ops.job_transitions (
                job_id, prior_state, next_state, attempt_count, reason_code,
                retry_decision, next_due_at, transitioned_at
              )
              select job_id, 'running', next_state, attempt_count, outcome_code,
                     case when next_state = 'retry_wait' then 'scheduled'
                          when next_state = 'failed'
                           and recovery_policy = 'retry_safe' then 'exhausted'
                          else 'none' end,
                     case when next_state = 'retry_wait' then scheduled_at else null end,
                     %(now)s
                from updated
              returning job_id, next_state
            )
            select
              count(*) filter (where next_state = 'retry_wait')::bigint as retried_count,
              count(*) filter (where next_state = 'failed')::bigint as failed_count,
              count(*) filter (where next_state = 'ambiguous')::bigint as ambiguous_count,
              count(*) filter (where next_state = 'canceled')::bigint as canceled_count
              from transitioned
        """
        with self._connect() as connection:
            row = connection.execute(
                statement, {"now": now, "limit": limit}
            ).fetchone()
            return StaleLeaseReconciliationResult(
                retried_count=int(row["retried_count"]),
                failed_count=int(row["failed_count"]),
                ambiguous_count=int(row["ambiguous_count"]),
                canceled_count=int(row["canceled_count"]),
            )

    def status(self, *, now: datetime) -> JobStatusSnapshot:
        _require_aware_datetime("now", now)
        statement = """
            with job_counts as (
              select
                count(*) filter (where state = 'queued')::bigint as queued_count,
                count(*) filter (where state = 'running')::bigint as running_count,
                count(*) filter (where state = 'retry_wait')::bigint as retry_wait_count,
                count(*) filter (where state = 'failed')::bigint as failed_count,
                count(*) filter (where state = 'ambiguous')::bigint as ambiguous_count,
                min(scheduled_at) filter (
                  where state in ('queued', 'retry_wait') and scheduled_at <= %(now)s
                ) as oldest_runnable_at
              from ops.jobs
            ), worker_health as (
              select max(last_heartbeat_at) as latest_worker_heartbeat_at
                from ops.worker_instances
               where lifecycle_state in ('starting', 'running', 'draining')
            )
            select job_counts.queued_count, job_counts.running_count,
                   job_counts.retry_wait_count, job_counts.failed_count,
                   job_counts.ambiguous_count, job_counts.oldest_runnable_at,
                   worker_health.latest_worker_heartbeat_at
              from job_counts cross join worker_health
        """
        with self._connect() as connection:
            row = connection.execute(statement, {"now": now}).fetchone()
            if row is None:
                return JobStatusSnapshot(0, 0, 0, 0, 0, None, None)
            return JobStatusSnapshot(
                queued_count=int(row["queued_count"]),
                running_count=int(row["running_count"]),
                retry_wait_count=int(row["retry_wait_count"]),
                failed_count=int(row["failed_count"]),
                ambiguous_count=int(row["ambiguous_count"]),
                oldest_runnable_at=row["oldest_runnable_at"],
                latest_worker_heartbeat_at=row["latest_worker_heartbeat_at"],
            )

    @staticmethod
    def _claimed_job(row: Mapping[str, Any]) -> ClaimedJob:
        return ClaimedJob(
            job_id=int(row["job_id"]),
            kind=str(row["kind"]),
            subject_kind=str(row["subject_kind"]),
            subject_ref=str(row["subject_ref"]),
            parameters=row["parameters"],
            account_id=row["account_id"],
            library_id=row["library_id"],
            capability_key=row["capability_key"],
            request_origin_id=(
                None if row["request_origin_id"] is None else int(row["request_origin_id"])
            ),
            deployment_mode=str(row["deployment_mode"]),
            client_surface=str(row["client_surface"]),
            idempotency_key=str(row["idempotency_key"]),
            attempt=int(row["attempt"]),
            max_attempts=int(row["max_attempts"]),
            worker_id=str(row["worker_id"]),
            lease_token=str(row["lease_token"]),
            lease_expires_at=row["lease_expires_at"],
            scheduled_at=row["scheduled_at"],
            priority=int(row["priority"]),
            scope_version=(
                None if row["scope_version"] is None else int(row["scope_version"])
            ),
            resource_revision=(
                None
                if row["resource_revision"] is None
                else int(row["resource_revision"])
            ),
        )
