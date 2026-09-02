"""Durable, non-gating welcome-mail delivery through the auth outbox."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable

from music_app.services.auth_mail import (
    DeliveryResult,
    compose_invitation_email,
    compose_password_reset_email,
    compose_welcome_email,
    send_auth_email,
)
from music_app.services.auth_invitation_models import (
    INVITATION_DB_PURPOSE,
    INVITATION_MESSAGE_CATEGORY,
    InvitationDelivery,
)
from music_app.services.auth_tokens import hash_opaque_token, matches_opaque_token

try:  # pragma: no cover - exercised when the optional runtime driver is present.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - keeps non-Postgres tooling importable.
    psycopg = None
    dict_row = None


_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_MAX_ATTEMPTS = 5
_RETRY_DELAYS_SECONDS = (60, 300, 1_800, 7_200)
_RETRYABLE_REASONS = frozenset({"timeout", "failed"})
_CLAIM_LEASE = timedelta(hours=1)


@dataclass(frozen=True, slots=True)
class WelcomeClaim:
    outbox_id: int
    account_id: int
    username: str
    recipient: str
    attempt_count: int
    claimed_at: datetime


@dataclass(frozen=True, slots=True)
class AmbiguousWelcomeClaim:
    """A stale send whose provider acceptance cannot be determined safely."""

    outbox_id: int


@dataclass(frozen=True, repr=False, slots=True)
class PasswordResetClaim:
    outbox_id: int
    account_id: int
    username: str
    recipient: str
    attempt_count: int
    claimed_at: datetime

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(outbox_id={self.outbox_id!r}, "
            f"account_id={self.account_id!r}, username=<redacted>, "
            f"recipient=<redacted>, attempt_count={self.attempt_count!r}, "
            f"claimed_at={self.claimed_at!r})"
        )


@dataclass(frozen=True, repr=False, slots=True)
class InvitationClaim:
    outbox_id: int
    invitation_token_id: int
    account_id: int
    username: str
    recipient: str
    expires_at: datetime
    attempt_count: int
    claimed_at: datetime

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(outbox_id={self.outbox_id!r}, "
            f"invitation_token_id={self.invitation_token_id!r}, "
            f"account_id={self.account_id!r}, username=<redacted>, "
            f"recipient=<redacted>, expires_at={self.expires_at!r}, "
            f"attempt_count={self.attempt_count!r}, "
            f"claimed_at={self.claimed_at!r})"
        )


class PostgresWelcomeOutboxService:
    """Claim and finalize one welcome message with SMTP outside transactions."""

    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._database_url = str(config.get(_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect
        self._now = now or (lambda: datetime.now(timezone.utc))

    def claim_welcome(
        self, outbox_id: int
    ) -> WelcomeClaim | AmbiguousWelcomeClaim | None:
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for welcome delivery."
            )
        identifier = _positive_integer(outbox_id, "outbox id")
        now = _aware_utc(self._now())
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                stale_rows = connection.execute(
                    """
                    update app.mail_outbox
                    set delivery_status = 'unknown',
                        next_attempt_at = null
                    where app.mail_outbox.id = %s
                      and app.mail_outbox.message_category = 'welcome'
                      and app.mail_outbox.delivery_status = 'sending'
                      and app.mail_outbox.claimed_at is not null
                      and app.mail_outbox.claimed_at <= %s
                    returning id
                    """,
                    (identifier, now - _CLAIM_LEASE),
                ).fetchall()
                if len(stale_rows) > 1:
                    raise RuntimeError("Welcome stale-claim context is invalid.")
                if stale_rows:
                    return AmbiguousWelcomeClaim(outbox_id=identifier)
                rows = connection.execute(
                    """
                    select outbox.id,
                           outbox.account_id,
                           account.username_display,
                           account.contact_email,
                           outbox.attempt_count
                    from app.mail_outbox outbox
                    join app.accounts account
                      on account.id = outbox.account_id
                    where outbox.id = %s
                      and outbox.message_category = 'welcome'
                      and outbox.delivery_status in ('pending', 'failed')
                      and (
                        outbox.delivery_status = 'pending'
                        or (
                          outbox.next_attempt_at is not null
                          and outbox.next_attempt_at <= %s
                        )
                      )
                      and outbox.attempt_count < %s
                    for update of outbox skip locked
                    """,
                    (identifier, now, _MAX_ATTEMPTS),
                ).fetchall()
                if not rows:
                    return None
                if len(rows) != 1:
                    raise RuntimeError("Welcome outbox claim context is invalid.")
                payload = _row_mapping(
                    rows[0],
                    (
                        "id",
                        "account_id",
                        "username_display",
                        "contact_email",
                        "attempt_count",
                    ),
                )
                attempt_count = _nonnegative_integer(
                    payload.get("attempt_count"), "attempt count"
                ) + 1
                username = _required_text(payload.get("username_display"), "username")
                recipient = _required_text(payload.get("contact_email"), "recipient")
                connection.execute(
                    """
                    update app.mail_outbox
                    set delivery_status = 'sending',
                        attempt_count = %s,
                        claimed_at = %s,
                        next_attempt_at = null
                    where id = %s
                    """,
                    (attempt_count, now, identifier),
                )
        return WelcomeClaim(
            outbox_id=identifier,
            account_id=_positive_integer(payload.get("account_id"), "account id"),
            username=username,
            recipient=recipient,
            attempt_count=attempt_count,
            claimed_at=now,
        )

    def finalize_welcome(
        self, claim: WelcomeClaim, result: DeliveryResult
    ) -> None:
        if not isinstance(claim, WelcomeClaim):
            raise ValueError("Welcome claim is invalid.")
        now = _aware_utc(self._now())
        status, sent_at, next_attempt_at = _final_state(claim, result, now)
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                rows = connection.execute(
                    """
                    select app.mail_outbox.id
                    from app.mail_outbox
                    where app.mail_outbox.id = %s
                      and app.mail_outbox.delivery_status = 'sending'
                      and app.mail_outbox.attempt_count = %s
                      and app.mail_outbox.claimed_at = %s
                    for update
                    """,
                    (claim.outbox_id, claim.attempt_count, claim.claimed_at),
                ).fetchall()
                if len(rows) != 1:
                    raise RuntimeError("Welcome outbox finalization context is invalid.")
                connection.execute(
                    """
                    update app.mail_outbox
                    set delivery_status = %s,
                        sent_at = %s,
                        next_attempt_at = %s,
                        provider_reference = null
                    where id = %s
                      and attempt_count = %s
                      and claimed_at = %s
                    """,
                    (
                        status,
                        sent_at,
                        next_attempt_at,
                        claim.outbox_id,
                        claim.attempt_count,
                        claim.claimed_at,
                    ),
                )


class PostgresPasswordResetOutboxService:
    """Deliver only the reset row matching the in-memory raw token."""

    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._database_url = str(config.get(_DATABASE_URL_KEY) or "").strip()
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for reset delivery."
            )
        self._connect = connect or _connect
        self._now = now or (lambda: datetime.now(timezone.utc))

    def claim_password_reset(self, delivery: object) -> PasswordResetClaim | None:
        outbox_id = _positive_integer(getattr(delivery, "outbox_id", None), "outbox id")
        account_id = _positive_integer(getattr(delivery, "account_id", None), "account id")
        recipient = _required_text(getattr(delivery, "recipient", None), "recipient")
        try:
            digest = hash_opaque_token(getattr(delivery, "raw_token", None))
        except (TypeError, ValueError):
            raise ValueError("Password reset delivery token is invalid.") from None
        now = _aware_utc(self._now())
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                rows = connection.execute(
                    """
                    select outbox.id, outbox.account_id,
                           account.username_display,
                           account.contact_email,
                           outbox.attempt_count
                    from app.mail_outbox outbox
                    join app.password_reset_tokens reset_token
                      on reset_token.id = outbox.reset_token_id
                    join app.accounts account
                      on account.id = outbox.account_id
                    join app.account_credentials credential
                      on credential.account_id = account.id
                    where outbox.id = %s
                      and outbox.account_id = %s
                      and outbox.message_category = 'password_reset'
                      and outbox.delivery_status = 'pending'
                      and outbox.attempt_count = 0
                      and reset_token.token_hash = %s
                      and reset_token.purpose = 'password_reset'
                      and reset_token.credential_version = credential.credential_version
                      and reset_token.consumed_at is null
                      and reset_token.revoked_at is null
                      and reset_token.expires_at > %s
                      and account.is_active is true
                      and account.disabled_at is null
                      and account.contact_email = %s
                    for update of outbox skip locked
                    """,
                    (outbox_id, account_id, digest, now, recipient),
                ).fetchall()
                if not rows:
                    return None
                if len(rows) != 1:
                    raise RuntimeError("Password reset outbox claim context is invalid.")
                payload = _row_mapping(
                    rows[0],
                    ("id", "account_id", "username_display", "contact_email", "attempt_count"),
                )
                claimed_at = now
                connection.execute(
                    """
                    update app.mail_outbox
                    set delivery_status = 'sending', attempt_count = 1,
                        claimed_at = %s, next_attempt_at = null
                    where id = %s and delivery_status = 'pending' and attempt_count = 0
                    """,
                    (claimed_at, outbox_id),
                )
        return PasswordResetClaim(
            outbox_id=outbox_id,
            account_id=account_id,
            username=_required_text(payload.get("username_display"), "username"),
            recipient=recipient,
            attempt_count=1,
            claimed_at=claimed_at,
        )

    def finalize_password_reset(
        self, claim: PasswordResetClaim, result: DeliveryResult
    ) -> None:
        if not isinstance(claim, PasswordResetClaim):
            raise ValueError("Password reset claim is invalid.")
        now = _aware_utc(self._now())
        delivered = bool(getattr(result, "delivered", False)) and str(
            getattr(result, "reason", "")
        ) == "delivered"
        reason = str(getattr(result, "reason", "failed"))
        status = "sent" if delivered else ("unknown" if reason == "unknown" else "failed")
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                rows = connection.execute(
                    """
                    select id from app.mail_outbox
                    where id = %s and message_category = 'password_reset'
                      and delivery_status = 'sending' and attempt_count = 1
                      and claimed_at = %s
                    for update
                    """,
                    (claim.outbox_id, claim.claimed_at),
                ).fetchall()
                if len(rows) != 1:
                    raise RuntimeError("Password reset outbox finalization context is invalid.")
                connection.execute(
                    """
                    update app.mail_outbox
                    set delivery_status = %s, sent_at = %s,
                        next_attempt_at = null, provider_reference = null
                    where id = %s and delivery_status = 'sending'
                      and attempt_count = 1 and claimed_at = %s
                    """,
                    (status, now if delivered else None, claim.outbox_id, claim.claimed_at),
                )


class PostgresInvitationOutboxService:
    """Deliver only the invitation matching the in-memory bearer token."""

    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._database_url = str(config.get(_DATABASE_URL_KEY) or "").strip()
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for invitation delivery."
            )
        self._connect = connect or _connect
        self._now = now or (lambda: datetime.now(timezone.utc))

    def claim_invitation(
        self, delivery: InvitationDelivery
    ) -> InvitationClaim | None:
        if not isinstance(delivery, InvitationDelivery):
            raise ValueError("Invitation delivery is invalid.")
        outbox_id = _positive_integer(delivery.outbox_id, "outbox id")
        invitation_token_id = _positive_integer(
            delivery.invitation_token_id, "invitation token id"
        )
        try:
            token_hash = hash_opaque_token(delivery.raw_token)
        except (TypeError, ValueError):
            return None
        now = _aware_utc(self._now())
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                candidates = connection.execute(
                    """
                    select outbox.id as outbox_id,
                           outbox.account_id as outbox_account_id,
                           outbox.invitation_token_id,
                           invitation.account_id as invitation_account_id
                    from app.mail_outbox outbox
                    join app.account_invitation_tokens invitation
                      on invitation.id = outbox.invitation_token_id
                    join app.accounts account
                      on account.id = invitation.account_id
                    left join app.account_credentials credential
                      on credential.account_id = account.id
                    where outbox.id = %s
                      and invitation.id = %s
                      and outbox.message_category = %s
                      and outbox.delivery_status = 'pending'
                      and outbox.attempt_count = 0
                      and invitation.purpose = %s
                      and invitation.token_hash = %s
                      and invitation.consumed_at is null
                      and invitation.revoked_at is null
                      and invitation.expires_at > %s
                      and account.is_active is true
                      and account.disabled_at is null
                      and credential.account_id is null
                    """,
                    (
                        outbox_id,
                        invitation_token_id,
                        INVITATION_MESSAGE_CATEGORY,
                        INVITATION_DB_PURPOSE,
                        token_hash,
                        now,
                    ),
                ).fetchall()
                if len(candidates) != 1:
                    return None
                candidate = _row_mapping(
                    candidates[0],
                    (
                        "outbox_id",
                        "outbox_account_id",
                        "invitation_token_id",
                        "invitation_account_id",
                    ),
                )
                candidate_outbox_id = _positive_integer(
                    candidate.get("outbox_id"), "outbox id"
                )
                candidate_invitation_id = _positive_integer(
                    candidate.get("invitation_token_id"), "invitation token id"
                )
                outbox_account_id = _positive_integer(
                    candidate.get("outbox_account_id"), "outbox account id"
                )
                account_id = _positive_integer(
                    candidate.get("invitation_account_id"), "account id"
                )
                if not (
                    candidate_outbox_id == outbox_id
                    and candidate_invitation_id == invitation_token_id
                    and outbox_account_id == account_id
                ):
                    return None
                accounts = connection.execute(
                    """
                    select account.id as account_id,
                           account.username_display,
                           account.contact_email
                    from app.accounts account
                    where account.id = %s
                      and account.account_kind = 'managed_user'
                      and account.is_active is true
                      and account.disabled_at is null
                    for update of account
                    """,
                    (account_id,),
                ).fetchall()
                if len(accounts) != 1:
                    return None
                credentials = connection.execute(
                    """
                    select account_id from app.account_credentials
                    where account_id = %s for update
                    """,
                    (account_id,),
                ).fetchall()
                if credentials:
                    return None
                account = _row_mapping(
                    accounts[0],
                    ("account_id", "username_display", "contact_email"),
                )
                username = _required_text(
                    account.get("username_display"), "username"
                )
                recipient = _required_text(
                    account.get("contact_email"), "recipient"
                )
                invitations = connection.execute(
                    """
                    select invitation.id as invitation_token_id,
                           invitation.account_id,
                           invitation.token_hash,
                           invitation.expires_at
                    from app.account_invitation_tokens invitation
                    where invitation.id = %s
                      and invitation.account_id = %s
                      and invitation.purpose = %s
                      and invitation.token_hash = %s
                      and invitation.consumed_at is null
                      and invitation.revoked_at is null
                      and invitation.expires_at > %s
                    for update of invitation
                    """,
                    (
                        invitation_token_id,
                        account_id,
                        INVITATION_DB_PURPOSE,
                        token_hash,
                        now,
                    ),
                ).fetchall()
                if len(invitations) != 1:
                    return None
                invitation = _row_mapping(
                    invitations[0],
                    (
                        "invitation_token_id",
                        "account_id",
                        "token_hash",
                        "expires_at",
                    ),
                )
                expires_at = _aware_utc(invitation.get("expires_at"))
                if not (
                    _positive_integer(
                        invitation.get("invitation_token_id"),
                        "invitation token id",
                    )
                    == invitation_token_id
                    and _positive_integer(
                        invitation.get("account_id"), "account id"
                    )
                    == account_id
                    and matches_opaque_token(
                        delivery.raw_token, invitation.get("token_hash")
                    )
                    and delivery.account_id == account_id
                    and delivery.username == username
                    and delivery.recipient == recipient
                    and _aware_utc(delivery.expires_at) == expires_at
                ):
                    return None
                outboxes = connection.execute(
                    """
                    select outbox.id as outbox_id,
                           outbox.account_id as outbox_account_id,
                           outbox.invitation_token_id
                    from app.mail_outbox outbox
                    where outbox.id = %s
                      and outbox.account_id = %s
                      and outbox.invitation_token_id = %s
                      and outbox.message_category = %s
                      and outbox.delivery_status = 'pending'
                      and outbox.attempt_count = 0
                    for update of outbox
                    """,
                    (
                        outbox_id,
                        account_id,
                        invitation_token_id,
                        INVITATION_MESSAGE_CATEGORY,
                    ),
                ).fetchall()
                if len(outboxes) != 1:
                    return None
                outbox = _row_mapping(
                    outboxes[0],
                    ("outbox_id", "outbox_account_id", "invitation_token_id"),
                )
                if not (
                    _positive_integer(outbox.get("outbox_id"), "outbox id")
                    == outbox_id
                    and _positive_integer(
                        outbox.get("outbox_account_id"), "outbox account id"
                    )
                    == account_id
                    and _positive_integer(
                        outbox.get("invitation_token_id"), "invitation token id"
                    )
                    == invitation_token_id
                ):
                    return None
                claimed_at = now
                claimed = connection.execute(
                    """
                    update app.mail_outbox
                    set delivery_status = 'sending', attempt_count = 1,
                        claimed_at = %s, next_attempt_at = null
                    where id = %s and delivery_status = 'pending'
                      and attempt_count = 0
                    returning id
                    """,
                    (claimed_at, outbox_id),
                ).fetchall()
                if len(claimed) != 1:
                    return None
        return InvitationClaim(
            outbox_id=outbox_id,
            invitation_token_id=invitation_token_id,
            account_id=account_id,
            username=username,
            recipient=recipient,
            expires_at=expires_at,
            attempt_count=1,
            claimed_at=claimed_at,
        )

    def finalize_invitation(
        self, claim: InvitationClaim, result: DeliveryResult
    ) -> None:
        if not isinstance(claim, InvitationClaim):
            raise ValueError("Invitation claim is invalid.")
        now = _aware_utc(self._now())
        delivered = bool(getattr(result, "delivered", False)) and str(
            getattr(result, "reason", "")
        ) == "delivered"
        reason = str(getattr(result, "reason", "failed"))
        status = "sent" if delivered else (
            "unknown" if reason == "unknown" else "failed"
        )
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                rows = connection.execute(
                    """
                    select id from app.mail_outbox
                    where id = %s and message_category = %s
                      and delivery_status = 'sending' and attempt_count = 1
                      and claimed_at = %s
                    for update
                    """,
                    (
                        claim.outbox_id,
                        INVITATION_MESSAGE_CATEGORY,
                        claim.claimed_at,
                    ),
                ).fetchall()
                if len(rows) != 1:
                    raise RuntimeError(
                        "Invitation outbox finalization context is invalid."
                    )
                connection.execute(
                    """
                    update app.mail_outbox
                    set delivery_status = %s, sent_at = %s,
                        next_attempt_at = null, provider_reference = null
                    where id = %s and delivery_status = 'sending'
                      and attempt_count = 1 and claimed_at = %s
                    """,
                    (
                        status,
                        now if delivered else None,
                        claim.outbox_id,
                        claim.claimed_at,
                    ),
                )


async def deliver_welcome(
    outbox_id: int,
    *,
    config: Mapping[str, Any],
    repository: PostgresWelcomeOutboxService,
    composer: Callable[..., Any] = compose_welcome_email,
    sender: Callable[..., Awaitable[DeliveryResult]] = send_auth_email,
) -> DeliveryResult:
    """Attempt one claimed welcome without changing account readiness."""

    claim = repository.claim_welcome(outbox_id)
    if claim is None:
        return DeliveryResult(delivered=False, reason="not_eligible")
    if isinstance(claim, AmbiguousWelcomeClaim):
        return DeliveryResult(delivered=False, reason="unknown")
    try:
        message = composer(
            username=claim.username,
            recipient=claim.recipient,
            config=config,
        )
        result = await sender(message, config=config)
        if not isinstance(result, DeliveryResult):
            result = DeliveryResult(delivered=False, reason="failed")
    except Exception:
        result = DeliveryResult(delivered=False, reason="failed")
    repository.finalize_welcome(claim, result)
    return result


async def deliver_password_reset(
    delivery: object,
    *,
    config: Mapping[str, Any],
    repository: PostgresPasswordResetOutboxService | Any | None = None,
    database_url: str | None = None,
    composer: Callable[..., Any] = compose_password_reset_email,
    sender: Callable[..., Awaitable[DeliveryResult]] = send_auth_email,
) -> DeliveryResult:
    """Attempt the one committed reset without persisting its raw token."""

    if repository is None:
        repository = PostgresPasswordResetOutboxService(
            {_DATABASE_URL_KEY: str(database_url or "").strip()}
        )
    claim = repository.claim_password_reset(delivery)
    if claim is None:
        return DeliveryResult(delivered=False, reason="not_eligible")
    try:
        message = composer(
            username=claim.username,
            recipient=claim.recipient,
            token=getattr(delivery, "raw_token"),
            config=config,
        )
        result = await sender(message, config=config)
        if not isinstance(result, DeliveryResult):
            result = DeliveryResult(delivered=False, reason="failed")
    except Exception:
        result = DeliveryResult(delivered=False, reason="failed")
    repository.finalize_password_reset(claim, result)
    return result


async def deliver_invitation(
    delivery: InvitationDelivery,
    *,
    config: Mapping[str, Any],
    repository: PostgresInvitationOutboxService,
    composer: Callable[..., Any] = compose_invitation_email,
    sender: Callable[..., Awaitable[DeliveryResult]] = send_auth_email,
) -> DeliveryResult:
    """Attempt one committed invitation without persisting its bearer token."""

    claim = repository.claim_invitation(delivery)
    if claim is None:
        return DeliveryResult(delivered=False, reason="not_eligible")
    try:
        bound_delivery = InvitationDelivery(
            outbox_id=claim.outbox_id,
            invitation_token_id=claim.invitation_token_id,
            account_id=claim.account_id,
            recipient=claim.recipient,
            username=claim.username,
            raw_token=delivery.raw_token,
            expires_at=claim.expires_at,
        )
        message = composer(delivery=bound_delivery, config=config)
        result = await sender(message, config=config)
        if not isinstance(result, DeliveryResult):
            result = DeliveryResult(delivered=False, reason="failed")
    except Exception:
        result = DeliveryResult(delivered=False, reason="failed")
    repository.finalize_invitation(claim, result)
    return result


def _final_state(
    claim: WelcomeClaim,
    result: object,
    now: datetime,
) -> tuple[str, datetime | None, datetime | None]:
    delivered = bool(getattr(result, "delivered", False))
    reason = str(getattr(result, "reason", "failed"))
    if delivered and reason == "delivered":
        return "sent", now, None
    if reason == "unknown":
        return "unknown", None, None
    retryable = reason in _RETRYABLE_REASONS and claim.attempt_count < _MAX_ATTEMPTS
    if retryable:
        delay = _RETRY_DELAYS_SECONDS[claim.attempt_count - 1]
        return "failed", None, now + timedelta(seconds=delay)
    return "failed", None, None


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for welcome delivery.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _transaction(connection: Any) -> Any:
    transaction = getattr(connection, "transaction", None)
    if not callable(transaction):
        raise RuntimeError("Welcome delivery requires transaction support.")
    return transaction()


def _row_mapping(row: object, columns: tuple[str, ...]) -> Mapping[str, object]:
    if isinstance(row, Mapping):
        return row
    if isinstance(row, (tuple, list)):
        return dict(zip(columns, row, strict=False))
    return {}


def _positive_integer(value: object, field: str) -> int:
    parsed = _nonnegative_integer(value, field)
    if parsed < 1:
        raise RuntimeError(f"Welcome {field} is invalid.")
    return parsed


def _nonnegative_integer(value: object, field: str) -> int:
    if isinstance(value, bool):
        raise RuntimeError(f"Welcome {field} is invalid.")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise RuntimeError(f"Welcome {field} is invalid.") from None
    if parsed < 0:
        raise RuntimeError(f"Welcome {field} is invalid.")
    return parsed


def _required_text(value: object, field: str) -> str:
    text = str(value or "").strip()
    if not text or "\r" in text or "\n" in text:
        raise RuntimeError(f"Welcome {field} is invalid.")
    return text


def _aware_utc(value: datetime) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RuntimeError("Welcome delivery clock is invalid.")
    return value.astimezone(timezone.utc)
