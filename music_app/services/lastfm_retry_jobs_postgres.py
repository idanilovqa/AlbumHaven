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
    job_id: int | None
    row_revision: int
    accepted_attempt: int


@dataclass(frozen=True)
class DueLastfmPending:
    pending_scrobble_id: int
    account_id: int
    library_id: int
    active_session_id: int
    previous_attempts: int


@dataclass(frozen=True)
class ClaimedLastfmAttempt:
    pending_scrobble_id: int
    row_revision: int
    accepted_attempt: int
    listen_id: str
    payload: Mapping[str, object]


@dataclass(frozen=True)
class LastfmAttemptFinalization:
    domain_status: str
    next_job_id: int | None
    row_revision: int


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

    @staticmethod
    def _claim_values(**values: object) -> dict[str, object]:
        return {
            "pending_scrobble_id": _positive(
                "pending_scrobble_id", values["pending_scrobble_id"]
            ),
            "active_session_id": _positive(
                "active_session_id", values["active_session_id"]
            ),
            "job_id": _positive("job_id", values["job_id"]),
            "attempt": _positive("attempt", values["attempt"]),
            "worker_id": _bounded("worker_id", values["worker_id"], maximum=128),
            "lease_token": _bounded(
                "lease_token", values["lease_token"], maximum=256
            ),
            "now": _aware("now", values["now"]),
        }

    def validate_claimed_retry(self, **values: object) -> bool:
        parameters = self._claim_values(**values)
        parameters.update(
            {
                "account_id": _positive("account_id", values["account_id"]),
                "library_id": _positive("library_id", values["library_id"]),
                "row_revision": _nonnegative(
                    "row_revision", values["row_revision"]
                ),
                "accepted_attempt": _positive(
                    "accepted_attempt", values["accepted_attempt"]
                ),
            }
        )
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    """
                    select ops.validate_claimed_lastfm_retry(
                      %(pending_scrobble_id)s, %(active_session_id)s,
                      %(account_id)s, %(library_id)s, %(job_id)s,
                      %(attempt)s, %(worker_id)s, %(lease_token)s, %(now)s,
                      %(row_revision)s, %(accepted_attempt)s
                    ) as valid
                    """,
                    parameters,
                ).fetchone()
            )
        return bool(row.get("valid"))

    def load_claimed_session_secret(self, **values: object) -> str | None:
        parameters = self._claim_values(**values)
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    """
                    select * from ops.load_claimed_lastfm_session_secret(
                      %(pending_scrobble_id)s, %(active_session_id)s,
                      %(job_id)s, %(attempt)s, %(worker_id)s,
                      %(lease_token)s, %(now)s
                    )
                    """,
                    parameters,
                ).fetchone()
            )
        secret = row.get("session_key_encrypted")
        if secret is None:
            return None
        if not isinstance(secret, str) or not secret or len(secret) > 8192:
            raise RuntimeError("claimed Last.fm session secret is invalid")
        return secret

    def begin_claimed_attempt(self, **values: object) -> ClaimedLastfmAttempt:
        parameters = self._claim_values(**values)
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    """
                    select * from ops.begin_claimed_lastfm_attempt(
                      %(pending_scrobble_id)s, %(active_session_id)s,
                      %(job_id)s, %(attempt)s, %(worker_id)s,
                      %(lease_token)s, %(now)s
                    )
                    """,
                    parameters,
                ).fetchone()
            )
        payload = row.get("payload")
        if not row or not isinstance(payload, Mapping):
            raise ValueError("claimed Last.fm attempt is stale or malformed")
        return ClaimedLastfmAttempt(
            pending_scrobble_id=_positive(
                "pending_scrobble_id", row.get("pending_scrobble_id")
            ),
            row_revision=_nonnegative("row_revision", row.get("row_revision")),
            accepted_attempt=_positive(
                "accepted_attempt", row.get("accepted_attempt")
            ),
            listen_id=_bounded("listen_id", row.get("listen_id"), maximum=512),
            payload=dict(payload),
        )

    def cancel_claimed_before_send(self, **values: object) -> bool:
        parameters = self._claim_values(**values)
        parameters["reason_code"] = _bounded(
            "reason_code", values["reason_code"], maximum=128
        )
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    """
                    select ops.cancel_claimed_lastfm_before_send(
                      %(pending_scrobble_id)s, %(active_session_id)s,
                      %(job_id)s, %(attempt)s, %(worker_id)s,
                      %(lease_token)s, %(now)s, %(reason_code)s
                    ) as canceled
                    """,
                    parameters,
                ).fetchone()
            )
        return bool(row.get("canceled"))

    def finalize_claimed_attempt(self, **values: object) -> LastfmAttemptFinalization:
        parameters = self._claim_values(**values)
        parameters.update(
            {
                "expected_row_revision": _nonnegative(
                    "expected_row_revision", values["expected_row_revision"]
                ),
                "disposition": _bounded(
                    "disposition", values["disposition"], maximum=48
                ),
                "reason_code": _bounded(
                    "reason_code", values["reason_code"], maximum=128
                ),
                "history_updates": json.dumps(
                    dict(values["history_updates"]),
                    ensure_ascii=False,
                    allow_nan=False,
                ),
            }
        )
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    """
                    select * from ops.finish_claimed_lastfm_attempt(
                      %(pending_scrobble_id)s, %(active_session_id)s,
                      %(job_id)s, %(attempt)s, %(worker_id)s,
                      %(lease_token)s, %(now)s, %(expected_row_revision)s,
                      %(disposition)s, %(reason_code)s,
                      %(history_updates)s::jsonb
                    )
                    """,
                    parameters,
                ).fetchone()
            )
        if not row:
            raise ValueError("claimed Last.fm attempt could not be finalized")
        next_job_id = row.get("next_job_id")
        return LastfmAttemptFinalization(
            domain_status=_bounded(
                "domain_status", row.get("domain_status"), maximum=48
            ),
            next_job_id=(
                None if next_job_id is None else _positive("next_job_id", next_job_id)
            ),
            row_revision=_nonnegative("row_revision", row.get("row_revision")),
        )

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

    def accept_playback_failure(
        self,
        *,
        account_id: int,
        library_id: int,
        listen_id: str,
        entry: Mapping[str, object],
        retry_count: int,
        error: str,
        request_origin_ref: str,
        deployment_mode: str,
        client_surface: str,
        now: datetime,
        reauthentication_required: bool = False,
    ) -> AcceptedLastfmRetry:
        """Atomically bind a known-not-sent playback failure to the active session."""

        account_id = _positive("account_id", account_id)
        library_id = _positive("library_id", library_id)
        retry_count = _positive("retry_count", retry_count)
        if retry_count >= _MAX_DOMAIN_ATTEMPTS:
            raise ValueError("retry_count must leave a durable retry attempt")
        listen_id = _bounded("listen_id", listen_id, maximum=512)
        now = _aware("now", now)
        values = {
            "account_id": account_id,
            "library_id": library_id,
            "source_family": "runtime_lastfm_sync_state_adapter",
            "source_key": listen_id,
            "track_key": _bounded(
                "track_key",
                entry.get("track_ref") or entry.get("path") or "opaque-listen",
                maximum=1024,
            ),
            "played_at": now,
            "attempt_count": retry_count,
            "accepted_attempt": retry_count + 1,
            "next_attempt_at": now,
            "payload": json.dumps(
                {"source_payload": dict(entry)}, ensure_ascii=False, allow_nan=False
            ),
        }
        with self._connect() as connection:
            session = _mapping(
                connection.execute(
                    """
                    select id from integration.lastfm_sessions
                     where account_id = %(account_id)s and is_active
                     order by id desc limit 1 for share
                    """,
                    values,
                ).fetchone()
            )
            if not session:
                raise ValueError("active Last.fm session is unavailable")
            active_session_id = _positive("active_session_id", session.get("id"))
            values["active_session_id"] = active_session_id
            if reauthentication_required:
                row = _mapping(
                    connection.execute(_hold_reauthentication_sql(), values).fetchone()
                )
                if not row:
                    raise ValueError("pending scrobble could not be held")
                return AcceptedLastfmRetry(
                    pending_scrobble_id=_positive(
                        "pending_scrobble_id", row.get("pending_scrobble_id")
                    ),
                    job_id=None,
                    row_revision=_nonnegative(
                        "row_revision", row.get("row_revision")
                    ),
                    accepted_attempt=retry_count,
                )
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
                scheduled_at=now,
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

    def release_after_reauthentication(
        self,
        *,
        account_id: int,
        library_id: int,
        request_origin_ref: str,
        deployment_mode: str,
        client_surface: str,
        now: datetime,
        limit: int = 100,
    ) -> tuple[AcceptedLastfmRetry, ...]:
        """Compose bounded due/held work against the newly active session only."""

        values = {
            "account_id": _positive("account_id", account_id),
            "library_id": _positive("library_id", library_id),
            "now": _aware("now", now),
            "limit": limit,
        }
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("limit must be between one and 100")
        released: list[AcceptedLastfmRetry] = []
        with self._connect() as connection:
            session = _mapping(
                connection.execute(
                    """
                    select id from integration.lastfm_sessions
                     where account_id = %(account_id)s and is_active
                     order by id desc limit 1 for share
                    """,
                    values,
                ).fetchone()
            )
            if not session:
                return ()
            active_session_id = _positive("active_session_id", session.get("id"))
            rows = connection.execute(
                """
                with candidates as (
                  select pending.id
                    from integration.pending_scrobbles as pending
                   where pending.account_id = %(account_id)s
                     and pending.library_id = %(library_id)s
                     and pending.attempt_count < 5
                     and (
                       pending.status = 'reauthentication_required' or
                       (pending.status in ('pending', 'retry_wait')
                        and pending.current_job_id is null
                        and pending.next_attempt_at <= %(now)s)
                     )
                   order by pending.next_attempt_at nulls first, pending.id
                   for update skip locked
                   limit %(limit)s
                )
                update integration.pending_scrobbles as pending
                   set status = 'accepted',
                       accepted_attempt = pending.attempt_count + 1,
                       active_session_id = %(active_session_id)s,
                       current_job_id = null,
                       next_attempt_at = %(now)s,
                       row_revision = pending.row_revision + 1,
                       updated_at = %(now)s
                  from candidates
                 where pending.id = candidates.id
                returning pending.id as pending_scrobble_id,
                          pending.row_revision,
                          pending.accepted_attempt,
                          pending.current_job_id
                """,
                {**values, "active_session_id": active_session_id},
            ).fetchall()
            for raw_row in rows:
                released.append(
                    self._compose_job(
                        connection=connection,
                        row=_mapping(raw_row),
                        account_id=values["account_id"],
                        library_id=values["library_id"],
                        active_session_id=active_session_id,
                        request_origin_ref=request_origin_ref,
                        deployment_mode=deployment_mode,
                        client_surface=client_surface,
                        scheduled_at=values["now"],
                    )
                )
        return tuple(released)

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


def _hold_reauthentication_sql() -> str:
    return """
        insert into integration.pending_scrobbles (
          account_id, library_id, track_key, played_at, attempt_count,
          next_attempt_at, status, payload, row_revision, accepted_attempt,
          active_session_id, last_provider_disposition, repair_reason_code
        ) values (
          %(account_id)s, %(library_id)s, %(track_key)s, %(played_at)s,
          %(attempt_count)s, null, 'reauthentication_required',
          %(payload)s::jsonb || jsonb_build_object(
            'source_family', %(source_family)s::text,
            'source_key', %(source_key)s::text,
            'account_id', %(account_id)s::text,
            'library_id', %(library_id)s::text
          ), 0, null, %(active_session_id)s,
          'reauthentication_required', 'lastfm_reauthentication_required'
        )
        on conflict (
          account_id, library_id, (payload->>'source_family'),
          (payload->>'source_key')
        ) where account_id is not null and library_id is not null
          and payload ? 'source_family' and payload ? 'source_key'
        do update set
          status = 'reauthentication_required',
          attempt_count = excluded.attempt_count,
          next_attempt_at = null,
          current_job_id = null,
          accepted_attempt = null,
          active_session_id = excluded.active_session_id,
          last_provider_disposition = 'reauthentication_required',
          repair_reason_code = 'lastfm_reauthentication_required',
          row_revision = integration.pending_scrobbles.row_revision + 1,
          updated_at = now()
        where integration.pending_scrobbles.status not in (
          'completed', 'permanent', 'exhausted', 'canceled', 'ambiguous'
        )
        returning id as pending_scrobble_id, row_revision
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
