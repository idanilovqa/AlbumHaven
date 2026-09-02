"""Bounded cleanup for expired durable authentication throttle buckets."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from typing import Any

try:  # pragma: no cover - exercised when the optional driver is installed.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


_MAXIMUM_BATCH_SIZE = 10_000


class PostgresAuthThrottleCleanupService:
    """Delete one expired bucket batch without racing active authentication."""

    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        connect: Callable[[str], Any] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(
            payload.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
        ).strip()
        if not self._database_url:
            raise RuntimeError("Authentication throttle cleanup database is not configured.")
        self._connect = connect or _connect
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def cleanup(self, *, batch_size: object) -> int:
        if (
            isinstance(batch_size, bool)
            or not isinstance(batch_size, int)
            or not 1 <= batch_size <= _MAXIMUM_BATCH_SIZE
        ):
            raise ValueError("Authentication throttle cleanup batch size is invalid.")
        cutoff = _aware_utc(self._clock())
        try:
            with self._connect(self._database_url) as connection:
                with connection.transaction():
                    rows = connection.execute(
                        """
                        with candidates as (
                          select id
                          from app.auth_throttles
                          where window_expires_at <= %s
                            and (blocked_until is null or blocked_until <= %s)
                          order by window_expires_at, id
                          limit %s
                          for update skip locked
                        )
                        delete from app.auth_throttles throttle
                        using candidates
                        where throttle.id = candidates.id
                        returning throttle.id
                        """,
                        (cutoff, cutoff, batch_size),
                    ).fetchall()
            return len(rows)
        except Exception:
            raise RuntimeError("Authentication throttle cleanup failed.") from None


def _aware_utc(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RuntimeError("Authentication throttle cleanup clock is invalid.")
    return value.astimezone(timezone.utc)


def _connect(database_url: str):
    if psycopg is None:
        raise RuntimeError("psycopg is required for authentication throttle cleanup.")
    return psycopg.connect(database_url, row_factory=dict_row)
