"""Bounded Postgres retention cleanup for the durable job ledger."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
from typing import Any


_TRANSITION_RETENTION = timedelta(days=90)
_TERMINAL_DETAIL_RETENTION = timedelta(days=90)
_TOMBSTONE_RETENTION = timedelta(days=365)
_WORKER_RETENTION = timedelta(days=7)

_DELETE_TRANSITIONS = """
    with candidates as (
      select transition.id
        from ops.job_transitions as transition
        join ops.jobs as job on job.id = transition.job_id
       where transition.transitioned_at < %s
         and job.state in ('succeeded', 'failed', 'canceled')
         and job.audit_hold = false
       order by transition.transitioned_at, transition.id
       for update of transition skip locked
       limit %s
    ), deleted as (
      delete from ops.job_transitions as transition
       using candidates
       where transition.id = candidates.id
       returning transition.id
    )
    select count(*) from deleted
"""

_COMPACT_JOBS = """
    with candidates as (
      select job.id
        from ops.jobs as job
       where job.completed_at < %s
         and job.state in ('succeeded', 'failed', 'canceled')
         and job.audit_hold = false
         and job.tombstoned_at is null
       order by job.completed_at, job.id
       for update of job skip locked
       limit %s
    ), compacted as (
      update ops.jobs as job
         set parameters = '{}'::jsonb,
             request_origin_id = null,
             cancel_requested_at = null,
             cancel_requested_by_account_id = null,
             cancel_reason_code = null,
             tombstoned_at = %s
        from candidates
       where job.id = candidates.id
       returning job.id
    )
    select count(*) from compacted
"""

_DELETE_TOMBSTONES = """
    with candidates as (
      select job.id
        from ops.jobs as job
       where job.tombstoned_at < %s
         and job.state in ('succeeded', 'failed', 'canceled')
         and job.audit_hold = false
         and job.tombstoned_at is not null
         and not exists (
           select 1 from library.full_scan_intents
            where library.full_scan_intents.job_id = job.id
         )
         and not exists (
           select 1 from library.targeted_reconciliation_intents
            where library.targeted_reconciliation_intents.job_id = job.id
         )
         and not exists (
           select 1 from ops.cover_remote_save_checkpoints
            where ops.cover_remote_save_checkpoints.job_id = job.id
         )
       order by job.tombstoned_at, job.id
       for update of job skip locked
       limit %s
    ), deleted as (
      delete from ops.jobs as job
       using candidates
       where job.id = candidates.id
       returning job.id
    )
    select count(*) from deleted
"""

_DELETE_WORKERS = """
    with candidates as (
      select worker.instance_id
        from ops.worker_instances as worker
       where worker.last_heartbeat_at < %s
         and worker.lifecycle_state = 'stopped'
         and not exists (
           select 1
             from ops.jobs as job
            where job.state = 'running'
              and job.lease_owner = worker.instance_id
         )
       order by worker.last_heartbeat_at, worker.instance_id
       for update of worker skip locked
       limit %s
    ), deleted as (
      delete from ops.worker_instances as worker
       using candidates
       where worker.instance_id = candidates.instance_id
       returning worker.instance_id
    )
    select count(*) from deleted
"""


def _default_connect(database_url: str) -> Any:
    import psycopg

    return psycopg.connect(database_url)


def _validate_inputs(*, batch_size: int, now: datetime) -> None:
    if (
        isinstance(batch_size, bool)
        or not isinstance(batch_size, int)
        or not 1 <= batch_size <= 10_000
    ):
        raise ValueError("batch size must be between 1 and 10000")
    if (
        not isinstance(now, datetime)
        or now.tzinfo is None
        or now.utcoffset() is None
    ):
        raise ValueError("cleanup timestamp must be timezone-aware")


def _result_count(result: Any) -> int:
    row = result.fetchone()
    if isinstance(row, Mapping):
        value = row.get("count")
    elif isinstance(row, (tuple, list)) and len(row) == 1:
        value = row[0]
    else:
        raise RuntimeError("job retention result is invalid")
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise RuntimeError("job retention result is invalid")
    return value


class PostgresJobRetentionService:
    """Compact and remove old durable-job records in one bounded transaction."""

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
            raise RuntimeError("job retention database URL is required")
        return self._connect_to_database(self._database_url)

    def cleanup(self, *, batch_size: int, now: datetime) -> dict[str, int]:
        _validate_inputs(batch_size=batch_size, now=now)
        try:
            with self._connect() as connection:
                with connection.transaction():
                    transitions = _result_count(
                        connection.execute(
                            _DELETE_TRANSITIONS,
                            (now - _TRANSITION_RETENTION, batch_size),
                        )
                    )
                    compacted_jobs = _result_count(
                        connection.execute(
                            _COMPACT_JOBS,
                            (
                                now - _TERMINAL_DETAIL_RETENTION,
                                batch_size,
                                now,
                            ),
                        )
                    )
                    tombstones = _result_count(
                        connection.execute(
                            _DELETE_TOMBSTONES,
                            (now - _TOMBSTONE_RETENTION, batch_size),
                        )
                    )
                    worker_instances = _result_count(
                        connection.execute(
                            _DELETE_WORKERS,
                            (now - _WORKER_RETENTION, batch_size),
                        )
                    )
            return {
                "transitions": transitions,
                "compacted_jobs": compacted_jobs,
                "tombstones": tombstones,
                "worker_instances": worker_instances,
            }
        except Exception:
            raise RuntimeError("Job retention cleanup failed") from None


__all__ = ["PostgresJobRetentionService"]
