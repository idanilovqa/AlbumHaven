"""Sanitized public and operator projections for durable job health."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any


_MAX_STATUS_COUNT = 2_147_483_647
_WORKER_READY_SECONDS = 90
_WORKER_DEGRADED_SECONDS = 300
_ACTIVE_LIFECYCLES = frozenset({"starting", "running", "draining"})
_WORKER_IDENTIFIER = re.compile(r"[^\x00-\x1f\x7f]{1,128}\Z")

_WORKER_QUERY = """
    select instance_id, lifecycle_state, last_heartbeat_at
      from ops.worker_instances
     where lifecycle_state in ('starting', 'running', 'draining')
     order by last_heartbeat_at desc nulls last, started_at desc, instance_id
     limit 1
"""

_JOB_AGGREGATE_QUERY = """
    select count(*) filter (where state = 'queued') as queued_count,
           count(*) filter (where state = 'running') as running_count,
           count(*) filter (where state = 'retry_wait') as retry_count,
           count(*) filter (where state = 'failed') as failed_count,
           count(*) filter (where state = 'ambiguous') as ambiguous_count,
           min(scheduled_at) filter (
             where state in ('queued', 'retry_wait')
           ) as oldest_queued_at,
           min(started_at) filter (
             where state = 'running'
           ) as oldest_claimed_at
      from ops.jobs
"""


def _default_connect(database_url: str) -> Any:
    import psycopg
    from psycopg.rows import dict_row

    return psycopg.connect(database_url, row_factory=dict_row)


def _require_aware_now(now: datetime) -> None:
    if (
        not isinstance(now, datetime)
        or now.tzinfo is None
        or now.utcoffset() is None
    ):
        raise ValueError("now must be a timezone-aware datetime")


def _age_seconds(now: datetime, timestamp: Any) -> int:
    if (
        not isinstance(timestamp, datetime)
        or timestamp.tzinfo is None
        or timestamp.utcoffset() is None
    ):
        raise ValueError("status timestamp must be timezone-aware")
    return max(0, int((now - timestamp).total_seconds()))


def _optional_age_seconds(now: datetime, timestamp: Any) -> int:
    return 0 if timestamp is None else _age_seconds(now, timestamp)


def _bounded_count(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("status count must be an integer")
    return min(_MAX_STATUS_COUNT, max(0, value))


def _worker_projection(
    row: Mapping[str, Any] | None, now: datetime
) -> tuple[str, dict[str, Any] | None]:
    if row is None:
        return "worker_unavailable", None

    instance_id = row.get("instance_id")
    lifecycle_state = row.get("lifecycle_state")
    heartbeat_at = row.get("last_heartbeat_at")
    if (
        not isinstance(instance_id, str)
        or not _WORKER_IDENTIFIER.fullmatch(instance_id)
        or lifecycle_state
        not in {"starting", "running", "draining", "stopped"}
    ):
        raise ValueError("worker status row is invalid")
    if lifecycle_state == "stopped" or heartbeat_at is None:
        return "worker_unavailable", None

    heartbeat_age = _age_seconds(now, heartbeat_at)
    if heartbeat_age > _WORKER_DEGRADED_SECONDS:
        status = "worker_unavailable"
    elif lifecycle_state == "draining" or heartbeat_age > _WORKER_READY_SECONDS:
        status = "worker_degraded"
    elif lifecycle_state in _ACTIVE_LIFECYCLES:
        status = "worker_ready"
    else:
        status = "worker_unavailable"

    return status, {
        "instance_id": instance_id,
        "lifecycle_state": lifecycle_state,
        "heartbeat_age_seconds": heartbeat_age,
    }


def _public_unavailable() -> dict[str, str]:
    return {"status": "ok", "worker_status": "worker_unavailable"}


def _empty_jobs() -> dict[str, int]:
    return {
        "queued_count": 0,
        "running_count": 0,
        "retry_count": 0,
        "failed_count": 0,
        "ambiguous_count": 0,
        "oldest_queue_age_seconds": 0,
        "claim_lag_seconds": 0,
    }


def _operator_unavailable() -> dict[str, Any]:
    return {
        "worker_status": "worker_unavailable",
        "worker": None,
        "jobs": _empty_jobs(),
    }


class PostgresJobStatusService:
    """Read coarse health or bounded aggregate status in short transactions."""

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
            raise RuntimeError("durable job database URL is required")
        return self._connect_to_database(self._database_url)

    def public_health(self, now: datetime) -> dict[str, str]:
        _require_aware_now(now)
        try:
            with self._connect() as connection:
                row = connection.execute(_WORKER_QUERY).fetchone()
            if row is not None and not isinstance(row, Mapping):
                raise ValueError("worker status row is invalid")
            worker_status, _worker = _worker_projection(row, now)
            return {"status": "ok", "worker_status": worker_status}
        except Exception:
            return _public_unavailable()

    def operator_status(self, now: datetime) -> dict[str, Any]:
        _require_aware_now(now)
        try:
            with self._connect() as connection:
                worker_row = connection.execute(_WORKER_QUERY).fetchone()
                aggregate_row = connection.execute(_JOB_AGGREGATE_QUERY).fetchone()
            if worker_row is not None and not isinstance(worker_row, Mapping):
                raise ValueError("worker status row is invalid")
            if not isinstance(aggregate_row, Mapping):
                raise ValueError("job status aggregate row is invalid")

            worker_status, worker = _worker_projection(worker_row, now)
            jobs = {
                "queued_count": _bounded_count(aggregate_row.get("queued_count")),
                "running_count": _bounded_count(aggregate_row.get("running_count")),
                "retry_count": _bounded_count(aggregate_row.get("retry_count")),
                "failed_count": _bounded_count(aggregate_row.get("failed_count")),
                "ambiguous_count": _bounded_count(
                    aggregate_row.get("ambiguous_count")
                ),
                "oldest_queue_age_seconds": _optional_age_seconds(
                    now, aggregate_row.get("oldest_queued_at")
                ),
                "claim_lag_seconds": _optional_age_seconds(
                    now, aggregate_row.get("oldest_claimed_at")
                ),
            }
            return {
                "worker_status": worker_status,
                "worker": worker,
                "jobs": jobs,
            }
        except Exception:
            return _operator_unavailable()


__all__ = ["PostgresJobStatusService"]
