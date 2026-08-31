"""Bounded retention cleanup for privacy-minimized security audit events."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timedelta, timezone
from typing import Any

try:  # pragma: no cover - exercised when the optional driver is installed.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - keeps non-Postgres tooling importable.
    psycopg = None
    dict_row = None


_MINIMUM_RETENTION_SECONDS = 90 * 24 * 60 * 60
_MAXIMUM_BATCH_SIZE = 10_000


class PostgresSecurityAuditCleanupService:
    """Delete at most one old-event batch through a maintenance-owned role."""

    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        connect: Callable[[str], Any] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(
            payload.get("ALBUM_HAVEN_MIGRATOR_DATABASE_URL") or ""
        ).strip()
        retention = payload.get("audit_retention_seconds")
        if not self._database_url:
            raise RuntimeError("Security audit cleanup database is not configured.")
        if (
            isinstance(retention, bool)
            or not isinstance(retention, int)
            or retention < _MINIMUM_RETENTION_SECONDS
        ):
            raise ValueError("Security audit cleanup retention is invalid.")
        self._retention = timedelta(seconds=retention)
        self._connect = connect or _connect
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def cleanup(self, *, batch_size: object) -> int:
        if (
            isinstance(batch_size, bool)
            or not isinstance(batch_size, int)
            or not 1 <= batch_size <= _MAXIMUM_BATCH_SIZE
        ):
            raise ValueError("Security audit cleanup batch size is invalid.")
        cutoff = _aware_utc(self._clock()) - self._retention
        try:
            with self._connect(self._database_url) as connection:
                transaction = getattr(connection, "transaction", None)
                if not callable(transaction):
                    raise RuntimeError
                with transaction():
                    rows = connection.execute(
                        """
                        with candidates as (
                          select id
                          from app.security_audit_events
                          where occurred_at < %s
                          order by occurred_at, id
                          limit %s
                          for update skip locked
                        )
                        delete from app.security_audit_events audit
                        using candidates
                        where audit.id = candidates.id
                        returning audit.id
                        """,
                        (cutoff, batch_size),
                    ).fetchall()
            return len(rows)
        except Exception:
            raise RuntimeError("Security audit cleanup failed.") from None


def _aware_utc(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RuntimeError("Security audit cleanup clock is invalid.")
    return value.astimezone(timezone.utc)


def _connect(database_url: str):
    if psycopg is None:
        raise RuntimeError("psycopg is required for security audit cleanup.")
    return psycopg.connect(database_url, row_factory=dict_row)
