"""Atomic Postgres composition for durable Last.fm scrobble retry jobs."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
import json
import re
from typing import Any

try:  # pragma: no cover - optional driver import is environment-specific.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None

from music_app.services.jobs.models import EnqueueJob
from music_app.services.jobs.repository_postgres import PostgresJobRepository


_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")
_MAX_DOMAIN_ATTEMPTS = 5


@dataclass(frozen=True)
class AcceptedLastfmRetry:
    pending_scrobble_id: int
    job_id: int
    row_revision: int
    accepted_attempt: int


@dataclass(frozen=True)
class DueLastfmPending:
    pending_scrobble_id: int
    account_id: int
    library_id: int
    active_session_id: int
    previous_attempts: int


def _default_connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for durable Last.fm retry jobs")
    return psycopg.connect(database_url, row_factory=dict_row)


def _positive(name: str, value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _nonnegative(name: str, value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a nonnegative integer")
    return value


def _bounded(name: str, value: object, *, maximum: int) -> str:
    normalized = str(value or "").strip()
    if (
        not normalized
        or len(normalized) > maximum
        or _CONTROL_CHARACTER.search(normalized)
    ):
        raise ValueError(f"{name} must be a bounded nonblank string")
    return normalized


def _aware(name: str, value: object) -> datetime:
    if (
        not isinstance(value, datetime)
        or value.tzinfo is None
        or value.utcoffset() is None
    ):
        raise ValueError(f"{name} must be a timezone-aware datetime")
    return value


def _mapping(row: object) -> dict[str, object]:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    return {}


class PostgresLastfmRetryJobRepository:
    """Own stable pending identities and one generic job per accepted attempt."""

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

    def list_due_pending(
        self, *, now: datetime, limit: int = 100
    ) -> tuple[DueLastfmPending, ...]:
        now = _aware("now", now)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("limit must be between one and 100")
        with self._connect() as connection:
            rows = connection.execute(
                _list_due_pending_sql(), {"now": now, "limit": limit}
            ).fetchall()
        due: list[DueLastfmPending] = []
        for raw_row in rows:
            row = _mapping(raw_row)
            due.append(
                DueLastfmPending(
                    pending_scrobble_id=_positive(
                        "pending_scrobble_id", row.get("pending_scrobble_id")
                    ),
                    account_id=_positive("account_id", row.get("account_id")),
                    library_id=_positive("library_id", row.get("library_id")),
                    active_session_id=_positive(
                        "active_session_id", row.get("active_session_id")
                    ),
                    previous_attempts=_nonnegative(
                        "previous_attempts", row.get("previous_attempts")
                    ),
                )
            )
        return tuple(due)

    def accept_retryable_pending(
        self,
        *,
        account_id: int,
        library_id: int,
        source_family: str,
        source_key: str,
        track_key: str,
        played_at: datetime,
        previous_attempts: int,
        next_attempt_at: datetime,
        active_session_id: int,
        request_origin_ref: str | None,
        deployment_mode: str,
        client_surface: str,
        payload: Mapping[str, object],
    ) -> AcceptedLastfmRetry:
        previous_attempts = _nonnegative("previous_attempts", previous_attempts)
        if previous_attempts >= _MAX_DOMAIN_ATTEMPTS:
            raise ValueError("previous_attempts must be fewer than five")
        account_id = _positive("account_id", account_id)
        library_id = _positive("library_id", library_id)
        active_session_id = _positive("active_session_id", active_session_id)
        values = {
            "account_id": account_id,
            "library_id": library_id,
            "source_family": _bounded("source_family", source_family, maximum=128),
            "source_key": _bounded("source_key", source_key, maximum=512),
            "track_key": _bounded("track_key", track_key, maximum=1024),
            "played_at": _aware("played_at", played_at),
            "attempt_count": previous_attempts,
            "accepted_attempt": previous_attempts + 1,
            "next_attempt_at": _aware("next_attempt_at", next_attempt_at),
            "active_session_id": active_session_id,
            "payload": json.dumps(dict(payload), ensure_ascii=False, allow_nan=False),
        }
        with self._connect() as connection:
            row = _mapping(connection.execute(_accept_pending_sql(), values).fetchone())
            if not row:
                raise ValueError("pending scrobble is terminal, stale, or malformed")
            return self._compose_job(
                connection=connection,
                row=row,
                account_id=account_id,
                library_id=library_id,
                active_session_id=active_session_id,
                request_origin_ref=request_origin_ref,
                deployment_mode=deployment_mode,
                client_surface=client_surface,
                scheduled_at=values["next_attempt_at"],
            )

    def adopt_due_pending(
        self,
        *,
        pending_scrobble_id: int,
        account_id: int,
        library_id: int,
        active_session_id: int,
        request_origin_ref: str | None,
        deployment_mode: str,
        client_surface: str,
        now: datetime,
    ) -> AcceptedLastfmRetry:
        return self._accept_due_pending(
            pending_scrobble_id=pending_scrobble_id,
            account_id=account_id,
            library_id=library_id,
            active_session_id=active_session_id,
            request_origin_ref=request_origin_ref,
            deployment_mode=deployment_mode,
            client_surface=client_surface,
            now=now,
            expected_previous_attempts=None,
        )

    def accept_next_attempt(
        self,
        *,
        pending_scrobble_id: int,
        account_id: int,
        library_id: int,
        active_session_id: int,
        expected_previous_attempts: int,
        request_origin_ref: str | None,
        deployment_mode: str,
        client_surface: str,
        now: datetime,
    ) -> AcceptedLastfmRetry:
        expected_previous_attempts = _nonnegative(
            "expected_previous_attempts", expected_previous_attempts
        )
        if expected_previous_attempts >= _MAX_DOMAIN_ATTEMPTS:
            raise ValueError("expected_previous_attempts must be fewer than five")
        return self._accept_due_pending(
            pending_scrobble_id=pending_scrobble_id,
            account_id=account_id,
            library_id=library_id,
            active_session_id=active_session_id,
            request_origin_ref=request_origin_ref,
            deployment_mode=deployment_mode,
            client_surface=client_surface,
            now=now,
            expected_previous_attempts=expected_previous_attempts,
        )

    def _accept_due_pending(
        self,
        *,
        pending_scrobble_id: int,
        account_id: int,
        library_id: int,
        active_session_id: int,
        request_origin_ref: str | None,
        deployment_mode: str,
        client_surface: str,
        now: datetime,
        expected_previous_attempts: int | None,
    ) -> AcceptedLastfmRetry:
        values = {
            "pending_scrobble_id": _positive(
                "pending_scrobble_id", pending_scrobble_id
            ),
            "account_id": _positive("account_id", account_id),
            "library_id": _positive("library_id", library_id),
            "active_session_id": _positive("active_session_id", active_session_id),
            "now": _aware("now", now),
            "expected_previous_attempts": expected_previous_attempts,
        }
        with self._connect() as connection:
            row = _mapping(connection.execute(_adopt_due_sql(), values).fetchone())
            if not row:
                raise ValueError("pending scrobble is not due or cannot be adopted")
            return self._compose_job(
                connection=connection,
                row=row,
                account_id=values["account_id"],
                library_id=values["library_id"],
                active_session_id=values["active_session_id"],
                request_origin_ref=request_origin_ref,
                deployment_mode=deployment_mode,
                client_surface=client_surface,
                scheduled_at=values["now"],
            )

    def _compose_job(
        self,
        *,
        connection: Any,
        row: Mapping[str, object],
        account_id: int,
        library_id: int,
        active_session_id: int,
        request_origin_ref: str | None,
        deployment_mode: str,
        client_surface: str,
        scheduled_at: datetime,
    ) -> AcceptedLastfmRetry:
        pending_id = _positive(
            "pending_scrobble_id", row.get("pending_scrobble_id")
        )
        accepted_attempt = _positive(
            "accepted_attempt", row.get("accepted_attempt")
        )
        row_revision = _nonnegative("row_revision", row.get("row_revision"))
        current_job_id = row.get("current_job_id")
        if current_job_id is not None:
            return AcceptedLastfmRetry(
                pending_scrobble_id=pending_id,
                job_id=_positive("current_job_id", current_job_id),
                row_revision=row_revision,
                accepted_attempt=accepted_attempt,
            )

        command = EnqueueJob(
            kind="lastfm_scrobble_retry",
            subject_kind="pending_scrobble",
            subject_ref=str(pending_id),
            parameters={"active_session_ref": str(active_session_id)},
            account_id=account_id,
            library_id=library_id,
            capability_key="integration.lastfm.scrobble",
            request_origin_ref=request_origin_ref,
            deployment_mode=_bounded(
                "deployment_mode", deployment_mode, maximum=128
            ),
            client_surface=_bounded("client_surface", client_surface, maximum=128),
            idempotency_key=(
                f"lastfm-scrobble:{pending_id}:attempt:{accepted_attempt}"
            ),
            scheduled_at=scheduled_at,
            max_attempts=1,
            scope_version=row_revision + 1,
            resource_revision=accepted_attempt,
        )
        job_id = self._job_repository.enqueue_in_transaction(connection, command)
        linked = _mapping(
            connection.execute(
                _link_job_sql(),
                {
                    "pending_scrobble_id": pending_id,
                    "row_revision": row_revision,
                    "accepted_attempt": accepted_attempt,
                    "active_session_id": active_session_id,
                    "job_id": job_id,
                },
            ).fetchone()
        )
        if not linked:
            raise RuntimeError("pending scrobble job link was concurrently replaced")
        return AcceptedLastfmRetry(
            pending_scrobble_id=pending_id,
            job_id=_positive("job_id", job_id),
            row_revision=row_revision + 1,
            accepted_attempt=accepted_attempt,
        )


def _accept_pending_sql() -> str:
    return """
        insert into integration.pending_scrobbles (
          account_id, library_id, track_key, played_at, attempt_count,
          next_attempt_at, status, payload, row_revision, accepted_attempt,
          active_session_id, last_provider_disposition, repair_reason_code
        ) values (
          %(account_id)s, %(library_id)s, %(track_key)s, %(played_at)s,
          %(attempt_count)s, %(next_attempt_at)s, 'accepted',
          %(payload)s::jsonb || jsonb_build_object(
            'source_family', %(source_family)s::text,
            'source_key', %(source_key)s::text,
            'account_id', %(account_id)s::text,
            'library_id', %(library_id)s::text
          ), 0, %(accepted_attempt)s, %(active_session_id)s, null, null
        )
        on conflict (
          account_id, library_id, (payload->>'source_family'),
          (payload->>'source_key')
        ) where account_id is not null and library_id is not null
          and payload ? 'source_family' and payload ? 'source_key'
        do update set
          track_key = case when integration.pending_scrobbles.current_job_id is null
                           then excluded.track_key else integration.pending_scrobbles.track_key end,
          played_at = case when integration.pending_scrobbles.current_job_id is null
                           then excluded.played_at else integration.pending_scrobbles.played_at end,
          next_attempt_at = case when integration.pending_scrobbles.current_job_id is null
                                 then excluded.next_attempt_at else integration.pending_scrobbles.next_attempt_at end,
          status = case when integration.pending_scrobbles.current_job_id is null
                        then 'accepted' else integration.pending_scrobbles.status end,
          payload = case when integration.pending_scrobbles.current_job_id is null
                         then excluded.payload else integration.pending_scrobbles.payload end,
          accepted_attempt = coalesce(
            integration.pending_scrobbles.accepted_attempt,
            excluded.accepted_attempt
          ),
          active_session_id = case when integration.pending_scrobbles.current_job_id is null
                                   then excluded.active_session_id else integration.pending_scrobbles.active_session_id end,
          row_revision = case when integration.pending_scrobbles.current_job_id is null
                              then integration.pending_scrobbles.row_revision + 1
                              else integration.pending_scrobbles.row_revision end,
          updated_at = case when integration.pending_scrobbles.current_job_id is null
                            then now() else integration.pending_scrobbles.updated_at end
        where integration.pending_scrobbles.attempt_count = excluded.attempt_count
          and integration.pending_scrobbles.status not in (
            'permanent', 'exhausted', 'completed', 'canceled', 'ambiguous'
          )
          and (
            integration.pending_scrobbles.accepted_attempt is null or
            integration.pending_scrobbles.accepted_attempt = excluded.accepted_attempt
          )
        returning id as pending_scrobble_id, row_revision,
                  accepted_attempt, current_job_id
    """


def _list_due_pending_sql() -> str:
    return """
        select pending.id as pending_scrobble_id,
               pending.account_id,
               pending.library_id,
               active_session.id as active_session_id,
               pending.attempt_count as previous_attempts
          from integration.pending_scrobbles as pending
          join lateral (
            select session.id
              from integration.lastfm_sessions as session
             where session.account_id = pending.account_id
               and session.is_active
             order by session.updated_at desc, session.id desc
             limit 1
          ) as active_session on true
         where pending.status in ('pending', 'retry_wait')
           and pending.current_job_id is null
           and pending.attempt_count < 5
           and (pending.next_attempt_at is null or pending.next_attempt_at <= %(now)s)
         order by pending.next_attempt_at nulls first, pending.id
         limit %(limit)s
    """


def _adopt_due_sql() -> str:
    return """
        update integration.pending_scrobbles as pending
           set accepted_attempt = case
                 when pending.accepted_attempt is null
                   or pending.accepted_attempt <= pending.attempt_count
                   then pending.attempt_count + 1
                 else pending.accepted_attempt
               end,
               active_session_id = %(active_session_id)s,
               status = 'accepted',
               repair_reason_code = pending.repair_reason_code,
               row_revision = pending.row_revision + 1,
               updated_at = %(now)s
         where pending.id = %(pending_scrobble_id)s
           and pending.account_id = %(account_id)s
           and pending.library_id = %(library_id)s
           and pending.current_job_id is null
           and pending.attempt_count < 5
           and (
             %(expected_previous_attempts)s::integer is null or
             pending.attempt_count = %(expected_previous_attempts)s::integer
           )
           and pending.status in ('pending', 'retry_wait')
           and (pending.next_attempt_at is null or pending.next_attempt_at <= %(now)s)
        returning pending.id as pending_scrobble_id, pending.row_revision,
                  pending.accepted_attempt, pending.current_job_id
    """


def _link_job_sql() -> str:
    return """
        update integration.pending_scrobbles as pending
           set current_job_id = %(job_id)s,
               request_origin_id = (
                 select job.request_origin_id from ops.jobs as job
                  where job.id = %(job_id)s
               ),
               row_revision = pending.row_revision + 1,
               updated_at = now()
         where pending.id = %(pending_scrobble_id)s
           and pending.row_revision = %(row_revision)s
           and pending.accepted_attempt = %(accepted_attempt)s
           and pending.active_session_id = %(active_session_id)s
           and pending.current_job_id is null
        returning true as linked
    """
