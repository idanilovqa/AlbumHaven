"""Atomic Postgres composition for durable authentication-mail jobs."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
import re
from typing import Any

from music_app.services.jobs.models import EnqueueJob
from music_app.services.jobs.repository_postgres import PostgresJobRepository

try:  # pragma: no cover - optional driver import is environment-specific.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")
_WELCOME_DELAYS = (60, 300, 1_800, 7_200)
_POLICIES = {
    "welcome": ("auth_welcome_delivery", "accounts.welcome.send", 3),
    "account_invitation": (
        "auth_invitation_delivery",
        "accounts.invitation.send",
        1,
    ),
    "password_reset": (
        "auth_password_reset_delivery",
        "accounts.password_reset.send",
        1,
    ),
}


@dataclass(frozen=True)
class AcceptedAuthMailJob:
    outbox_id: int
    job_id: int
    row_revision: int
    accepted_attempt: int


@dataclass(frozen=True, repr=False)
class ClaimedAuthMailDeliveryContext:
    outbox_id: int
    target_account_id: int
    username: str
    recipient: str
    target_credential_version: int | None
    lifecycle_expires_at: datetime | None
    delivery_checkpoint: str
    row_revision: int
    accepted_attempt: int

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(outbox_id={self.outbox_id!r}, "
            f"target_account_id={self.target_account_id!r}, "
            "username=<redacted>, recipient=<redacted>, "
            f"target_credential_version={self.target_credential_version!r}, "
            f"lifecycle_expires_at={self.lifecycle_expires_at!r}, "
            f"delivery_checkpoint={self.delivery_checkpoint!r}, "
            f"row_revision={self.row_revision!r}, "
            f"accepted_attempt={self.accepted_attempt!r})"
        )


@dataclass(frozen=True)
class IssuedAuthMailToken:
    token_id: int
    row_revision: int


@dataclass(frozen=True)
class AuthMailFinalization:
    domain_status: str
    next_job_id: int | None
    row_revision: int


def _default_connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for durable authentication mail")
    return psycopg.connect(database_url, row_factory=dict_row)


def _positive(name: str, value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _nonnegative(name: str, value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a nonnegative integer")
    return value


def _aware(name: str, value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be a timezone-aware datetime")
    return value


def _bounded(name: str, value: object, *, maximum: int = 128) -> str:
    normalized = str(value or "").strip()
    if not normalized or len(normalized) > maximum or _CONTROL_CHARACTER.search(normalized):
        raise ValueError(f"{name} must be a bounded nonblank string")
    return normalized


def _category(value: object) -> str:
    normalized = str(value or "")
    if normalized not in _POLICIES:
        raise ValueError("mail category is invalid")
    return normalized


def _mapping(row: object) -> dict[str, object]:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    return {}


class PostgresAuthMailJobRepository:
    """Own one secret-free generic job for each accepted outbox attempt."""

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
            "outbox_id": _positive("outbox_id", values["outbox_id"]),
            "category": _category(values["category"]),
            "job_id": _positive("job_id", values["job_id"]),
            "attempt": _positive("attempt", values["attempt"]),
            "worker_id": _bounded("worker_id", values["worker_id"]),
            "lease_token": _bounded(
                "lease_token", values["lease_token"], maximum=256
            ),
            "now": _aware("now", values["now"]),
        }

    def validate_claimed_delivery(self, **values: object) -> bool:
        parameters = self._claim_values(**values)
        parameters.update({
            "row_revision": _nonnegative(
                "row_revision", values["row_revision"]
            ),
            "accepted_attempt": _positive(
                "accepted_attempt", values["accepted_attempt"]
            ),
        })
        with self._connect() as connection:
            row = _mapping(connection.execute(
                """
                select ops.validate_claimed_auth_mail(
                  %(outbox_id)s, %(category)s, %(job_id)s, %(attempt)s,
                  %(worker_id)s, %(lease_token)s, %(now)s,
                  %(row_revision)s, %(accepted_attempt)s
                ) as valid
                """,
                parameters,
            ).fetchone())
        return bool(row.get("valid"))

    def load_claimed_delivery_context(
        self, **values: object
    ) -> ClaimedAuthMailDeliveryContext:
        parameters = self._claim_values(**values)
        with self._connect() as connection:
            row = _mapping(connection.execute(
                """
                select * from ops.load_claimed_auth_mail_context(
                  %(outbox_id)s, %(category)s, %(job_id)s, %(attempt)s,
                  %(worker_id)s, %(lease_token)s, %(now)s
                )
                """,
                parameters,
            ).fetchone())
        if not row:
            raise ValueError("claimed authentication mail context is stale")
        credential_version = row.get("target_credential_version")
        expires_at = row.get("lifecycle_expires_at")
        return ClaimedAuthMailDeliveryContext(
            outbox_id=_positive("outbox_id", row.get("outbox_id")),
            target_account_id=_positive(
                "target_account_id", row.get("target_account_id")
            ),
            username=_bounded("username", row.get("username_display"), maximum=512),
            recipient=_bounded("recipient", row.get("contact_email"), maximum=1024),
            target_credential_version=(
                None
                if credential_version is None
                else _positive("target_credential_version", credential_version)
            ),
            lifecycle_expires_at=(
                None
                if expires_at is None
                else _aware("lifecycle_expires_at", expires_at)
            ),
            delivery_checkpoint=_bounded(
                "delivery_checkpoint", row.get("delivery_checkpoint"), maximum=32
            ),
            row_revision=_nonnegative("row_revision", row.get("row_revision")),
            accepted_attempt=_positive(
                "accepted_attempt", row.get("accepted_attempt")
            ),
        )

    def issue_claimed_token_hash(self, **values: object) -> IssuedAuthMailToken:
        parameters = self._claim_values(**values)
        if parameters["category"] not in {"account_invitation", "password_reset"}:
            raise ValueError("mail category does not issue bearer tokens")
        digest = values.get("token_hash")
        if not isinstance(digest, bytes) or len(digest) != 32:
            raise ValueError("token_hash must be a 32-byte digest")
        expires_at = _aware("expires_at", values.get("expires_at"))
        if expires_at <= parameters["now"]:
            raise ValueError("expires_at must be later than now")
        parameters.update({
            "expected_row_revision": _nonnegative(
                "expected_row_revision", values["expected_row_revision"]
            ),
            "token_hash": digest,
            "expires_at": expires_at,
            "request_ref": _bounded(
                "request_ref", values.get("request_ref"), maximum=256
            ),
        })
        with self._connect() as connection:
            row = _mapping(connection.execute(
                """
                select * from ops.issue_claimed_auth_mail_token_hash(
                  %(outbox_id)s, %(category)s, %(job_id)s, %(attempt)s,
                  %(worker_id)s, %(lease_token)s, %(now)s,
                  %(expected_row_revision)s, %(token_hash)s,
                  %(expires_at)s, %(request_ref)s
                )
                """,
                parameters,
            ).fetchone())
        if not row:
            raise ValueError("authentication mail token issuance was rejected")
        return IssuedAuthMailToken(
            token_id=_positive("token_id", row.get("token_id")),
            row_revision=_nonnegative("row_revision", row.get("row_revision")),
        )

    def begin_claimed_send(self, **values: object) -> int:
        parameters = self._claim_values(**values)
        parameters["expected_row_revision"] = _nonnegative(
            "expected_row_revision", values["expected_row_revision"]
        )
        with self._connect() as connection:
            row = _mapping(connection.execute(
                """
                select * from ops.begin_claimed_auth_mail_send(
                  %(outbox_id)s, %(category)s, %(job_id)s, %(attempt)s,
                  %(worker_id)s, %(lease_token)s, %(now)s,
                  %(expected_row_revision)s
                )
                """,
                parameters,
            ).fetchone())
        if not row:
            raise ValueError("authentication mail send checkpoint was rejected")
        return _nonnegative("row_revision", row.get("row_revision"))

    def finalize_claimed_delivery(self, **values: object) -> AuthMailFinalization:
        parameters = self._claim_values(**values)
        disposition = _bounded(
            "disposition", values.get("disposition"), maximum=48
        )
        if disposition not in {
            "delivered",
            "known_not_sent_retryable",
            "known_not_sent_terminal",
            "possible_send_ambiguous",
            "ineligible_before_token",
            "canceled_before_send",
        }:
            raise ValueError("disposition is invalid")
        parameters.update({
            "expected_row_revision": _nonnegative(
                "expected_row_revision", values["expected_row_revision"]
            ),
            "disposition": disposition,
            "reason_code": _bounded(
                "reason_code", values.get("reason_code"), maximum=128
            ),
        })
        with self._connect() as connection:
            row = _mapping(connection.execute(
                """
                select * from ops.finish_claimed_auth_mail(
                  %(outbox_id)s, %(category)s, %(job_id)s, %(attempt)s,
                  %(worker_id)s, %(lease_token)s, %(now)s,
                  %(expected_row_revision)s, %(disposition)s, %(reason_code)s
                )
                """,
                parameters,
            ).fetchone())
        if not row:
            raise ValueError("authentication mail delivery finalization was rejected")
        return AuthMailFinalization(
            domain_status=_bounded(
                "domain_status", row.get("domain_status"), maximum=32
            ),
            next_job_id=(
                None
                if row.get("next_job_id") is None
                else _positive("next_job_id", row.get("next_job_id"))
            ),
            row_revision=_nonnegative("row_revision", row.get("row_revision")),
        )

    def cancel_claimed_before_send(self, **values: object) -> bool:
        parameters = self._claim_values(**values)
        parameters["reason_code"] = _bounded(
            "reason_code", values.get("reason_code"), maximum=128
        )
        with self._connect() as connection:
            row = _mapping(connection.execute(
                """
                select ops.cancel_claimed_auth_mail_before_send(
                  %(outbox_id)s, %(category)s, %(job_id)s, %(attempt)s,
                  %(worker_id)s, %(lease_token)s, %(now)s, %(reason_code)s
                ) as canceled
                """,
                parameters,
            ).fetchone())
        return bool(row.get("canceled"))

    def accept_intent(
        self,
        *,
        category: str,
        account_id: int,
        actor_account_id: int | None,
        library_id: int | None,
        request_origin_ref: str | None,
        deployment_mode: str,
        client_surface: str,
        now: datetime,
    ) -> AcceptedAuthMailJob:
        normalized_category = _category(category)
        if actor_account_id is None and normalized_category != "password_reset":
            raise ValueError("only password reset supports public lifecycle mail")
        if actor_account_id is None and library_id is not None:
            raise ValueError("public lifecycle mail cannot carry actor library scope")
        values = {
            "category": normalized_category,
            "account_id": _positive("account_id", account_id),
            "actor_account_id": (
                None
                if actor_account_id is None
                else _positive("actor_account_id", actor_account_id)
            ),
            "authorization_mode": (
                "public_lifecycle" if actor_account_id is None else "actor"
            ),
            "reset_token_id": None,
            "invitation_token_id": None,
            "now": _aware("now", now),
        }
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    """
                    insert into app.mail_outbox (
                      account_id, reset_token_id, invitation_token_id,
                      message_category, delivery_status, attempt_count,
                      next_attempt_at, claimed_at, sent_at, provider_reference,
                      row_revision, accepted_attempt, current_job_id,
                      actor_account_id, authorization_mode,
                      delivery_checkpoint, provider_disposition,
                      delivery_reason_code, created_at, updated_at
                    ) values (
                      %(account_id)s, %(reset_token_id)s, %(invitation_token_id)s,
                      %(category)s, 'pending', 0, %(now)s, null, null, null,
                      0, 1, null, %(actor_account_id)s, %(authorization_mode)s,
                      'accepted', null, null, %(now)s, %(now)s
                    )
                    returning id as outbox_id, row_revision, accepted_attempt
                    """,
                    values,
                ).fetchone()
            )
            if not row:
                raise RuntimeError("authentication mail intent was not accepted")
            return self._compose_job(
                connection=connection,
                row=row,
                category=values["category"],
                target_account_id=values["account_id"],
                actor_account_id=values["actor_account_id"],
                library_id=library_id,
                request_origin_ref=request_origin_ref,
                deployment_mode=deployment_mode,
                client_surface=client_surface,
                scheduled_at=values["now"],
            )

    def compose_existing_intent_in_transaction(
        self,
        connection: Any,
        *,
        outbox_id: int,
        category: str,
        account_id: int,
        actor_account_id: int | None,
        library_id: int | None,
        request_origin_ref: str | None,
        deployment_mode: str,
        client_surface: str,
        scheduled_at: datetime,
    ) -> AcceptedAuthMailJob:
        normalized_category = _category(category)
        if actor_account_id is None and normalized_category != "password_reset":
            raise ValueError("only password reset supports public lifecycle mail")
        if actor_account_id is None and library_id is not None:
            raise ValueError("public lifecycle mail cannot carry actor library scope")
        values = {
            "outbox_id": _positive("outbox_id", outbox_id),
            "category": normalized_category,
            "account_id": _positive("account_id", account_id),
            "actor_account_id": (
                None
                if actor_account_id is None
                else _positive("actor_account_id", actor_account_id)
            ),
        }
        row = _mapping(
            connection.execute(
                """
                update app.mail_outbox as outbox
                   set actor_account_id = coalesce(
                         outbox.actor_account_id, %(actor_account_id)s
                       ),
                       authorization_mode = case
                         when %(actor_account_id)s is null then 'public_lifecycle'
                         else 'actor'
                       end,
                       row_revision = outbox.row_revision + case
                         when outbox.actor_account_id is null
                           or outbox.authorization_mode <> case
                             when %(actor_account_id)s is null
                               then 'public_lifecycle' else 'actor' end
                         then 1 else 0 end,
                       updated_at = now()
                 where outbox.id = %(outbox_id)s
                   and outbox.account_id = %(account_id)s
                   and outbox.message_category = %(category)s
                   and (
                     outbox.actor_account_id is null or
                     outbox.actor_account_id is not distinct from %(actor_account_id)s
                   )
                   and outbox.delivery_status in ('pending', 'failed')
                   and outbox.accepted_attempt is not null
                returning outbox.id as outbox_id, outbox.account_id,
                          outbox.message_category, outbox.row_revision,
                          outbox.accepted_attempt, outbox.current_job_id,
                          outbox.actor_account_id, outbox.authorization_mode
                """,
                values,
            ).fetchone()
        )
        if not row:
            raise ValueError("mail outbox intent is terminal, stale, or malformed")
        return self._compose_job(
            connection=connection,
            row=row,
            category=values["category"],
            target_account_id=values["account_id"],
            actor_account_id=values["actor_account_id"],
            library_id=library_id,
            request_origin_ref=request_origin_ref,
            deployment_mode=deployment_mode,
            client_surface=client_surface,
            scheduled_at=_aware("scheduled_at", scheduled_at),
        )

    def schedule_next_welcome_attempt(
        self,
        *,
        outbox_id: int,
        account_id: int,
        actor_account_id: int,
        library_id: int | None,
        expected_row_revision: int,
        completed_attempt: int,
        request_origin_ref: str | None,
        deployment_mode: str,
        client_surface: str,
        now: datetime,
    ) -> AcceptedAuthMailJob:
        completed = _positive("completed_attempt", completed_attempt)
        if completed >= 5:
            raise ValueError("completed_attempt must be fewer than five")
        values = {
            "outbox_id": _positive("outbox_id", outbox_id),
            "account_id": _positive("account_id", account_id),
            "actor_account_id": _positive("actor_account_id", actor_account_id),
            "row_revision": _nonnegative("expected_row_revision", expected_row_revision),
            "completed_attempt": completed,
            "accepted_attempt": completed + 1,
            "now": _aware("now", now),
            "next_attempt_at": now + timedelta(seconds=_WELCOME_DELAYS[completed - 1]),
        }
        with self._connect() as connection:
            row = _mapping(
                connection.execute(
                    """
                    update app.mail_outbox
                       set delivery_status = 'pending',
                           attempt_count = %(completed_attempt)s,
                           accepted_attempt = %(accepted_attempt)s,
                           current_job_id = null,
                           next_attempt_at = %(next_attempt_at)s,
                           claimed_at = null,
                           delivery_checkpoint = 'accepted',
                           provider_disposition = 'known_not_sent_retryable',
                           delivery_reason_code = 'known_not_sent_retryable',
                           row_revision = row_revision + 1,
                           updated_at = %(now)s
                     where id = %(outbox_id)s
                       and account_id = %(account_id)s
                       and actor_account_id = %(actor_account_id)s
                       and message_category = 'welcome'
                       and row_revision = %(row_revision)s
                       and accepted_attempt = %(completed_attempt)s
                       and delivery_status = 'sending'
                    returning id as outbox_id, account_id, row_revision,
                              accepted_attempt, current_job_id, next_attempt_at
                    """,
                    values,
                ).fetchone()
            )
            if not row:
                raise ValueError("welcome attempt is stale or cannot be retried")
            return self._compose_job(
                connection=connection,
                row=row,
                category="welcome",
                target_account_id=values["account_id"],
                actor_account_id=values["actor_account_id"],
                library_id=library_id,
                request_origin_ref=request_origin_ref,
                deployment_mode=deployment_mode,
                client_surface=client_surface,
                scheduled_at=_aware("next_attempt_at", row.get("next_attempt_at")),
            )

    def _compose_job(
        self,
        *,
        connection: Any,
        row: Mapping[str, object],
        category: str,
        target_account_id: int,
        actor_account_id: int | None,
        library_id: int | None,
        request_origin_ref: str | None,
        deployment_mode: str,
        client_surface: str,
        scheduled_at: datetime,
    ) -> AcceptedAuthMailJob:
        outbox_id = _positive("outbox_id", row.get("outbox_id"))
        accepted_attempt = _positive("accepted_attempt", row.get("accepted_attempt"))
        row_revision = _nonnegative("row_revision", row.get("row_revision"))
        current_job_id = row.get("current_job_id")
        if current_job_id is not None:
            return AcceptedAuthMailJob(
                outbox_id=outbox_id,
                job_id=_positive("current_job_id", current_job_id),
                row_revision=row_revision,
                accepted_attempt=accepted_attempt,
            )
        kind, actor_capability, maximum = _POLICIES[category]
        capability = None if actor_account_id is None else actor_capability
        command = EnqueueJob(
            kind=kind,
            subject_kind="mail_outbox",
            subject_ref=str(outbox_id),
            parameters={},
            account_id=actor_account_id,
            library_id=library_id,
            capability_key=capability,
            request_origin_ref=request_origin_ref,
            deployment_mode=_bounded("deployment_mode", deployment_mode),
            client_surface=_bounded("client_surface", client_surface),
            idempotency_key=f"auth-mail:{category}:{outbox_id}:attempt:{accepted_attempt}",
            scheduled_at=_aware("scheduled_at", scheduled_at),
            max_attempts=maximum,
            scope_version=row_revision + 1,
            resource_revision=accepted_attempt,
        )
        job_id = self._job_repository.enqueue_in_transaction(connection, command)
        linked = _mapping(
            connection.execute(
                """
                update app.mail_outbox as outbox
                   set current_job_id = %(job_id)s,
                       request_origin_id = (
                         select request_origin_id from ops.jobs where id = %(job_id)s
                       ),
                       row_revision = outbox.row_revision + 1,
                       updated_at = now()
                 where outbox.id = %(outbox_id)s
                   and outbox.account_id = %(account_id)s
                   and outbox.message_category = %(category)s
                   and outbox.row_revision = %(row_revision)s
                   and outbox.accepted_attempt = %(accepted_attempt)s
                   and outbox.current_job_id is null
                returning true as linked
                """,
                {
                    "job_id": job_id,
                    "outbox_id": outbox_id,
                    "account_id": target_account_id,
                    "category": category,
                    "row_revision": row_revision,
                    "accepted_attempt": accepted_attempt,
                },
            ).fetchone()
        )
        if not linked:
            raise RuntimeError("authentication mail job link was concurrently replaced")
        return AcceptedAuthMailJob(
            outbox_id=outbox_id,
            job_id=_positive("job_id", job_id),
            row_revision=row_revision + 1,
            accepted_attempt=accepted_attempt,
        )
