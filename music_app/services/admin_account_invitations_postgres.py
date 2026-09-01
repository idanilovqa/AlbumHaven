"""Administrator-authorized managed-account invitation rotation."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import re
from typing import Any
from urllib.parse import urlencode

from music_app.services.admin_member_mutation_postgres import (
    RecentAuthenticationRequired,
)
from music_app.services.auth_audit_postgres import (
    InvitationAuditReason,
    SecurityAuditCategory,
    SecurityAuditOutcome,
)
from music_app.services.auth_invitation_models import (
    INVITATION_DB_PURPOSE,
    INVITATION_MESSAGE_CATEGORY,
    INVITATION_URL_PURPOSE,
    CopiedInvitation,
    InvitationDelivery,
    validated_issued_invitation_token,
)
from music_app.services.auth_tokens import issue_opaque_token
from music_app.services.mail_config import build_public_url

try:  # pragma: no cover - exercised with the optional runtime driver.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


_REQUEST_REFERENCE = re.compile(r"[A-Za-z0-9._:-]{1,128}")
_RECENT_AUTH_WINDOW = timedelta(minutes=10)
_FUTURE_SKEW = timedelta(minutes=5)


@dataclass(frozen=True, repr=False, slots=True)
class _RotatedInvitation:
    outbox_id: int | None
    invitation_token_id: int
    account_id: int
    recipient: str
    username: str
    raw_token: str
    expires_at: datetime

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(outbox_id={self.outbox_id!r}, "
            f"invitation_token_id={self.invitation_token_id!r}, "
            f"account_id={self.account_id!r}, recipient=<redacted>, "
            f"username={self.username!r}, raw_token=<redacted>, "
            f"expires_at={self.expires_at!r})"
        )


class PostgresAdminAccountInvitationService:
    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        connect: Callable[[str], Any] | None = None,
        clock: Callable[[], datetime] | None = None,
        token_issuer: Callable[[], object] = issue_opaque_token,
        audit_repository: Any,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(
            payload.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
        ).strip()
        self._public_base_url = str(payload.get("public_base_url") or "").strip()
        seconds = payload.get("invitation_token_seconds")
        if not self._database_url:
            raise RuntimeError("Database configuration is required for invitations.")
        build_public_url(self._public_base_url, "/accept-invitation")
        if isinstance(seconds, bool) or not isinstance(seconds, int) or seconds < 3_600:
            raise ValueError("Invitation lifetime configuration is invalid.")
        if not callable(token_issuer):
            raise TypeError("Invitation token provider is invalid.")
        if not callable(getattr(audit_repository, "append_in_transaction", None)):
            raise TypeError("Invitation audit repository is invalid.")
        self._invitation_token_seconds = seconds
        self._connect = connect or _connect
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._token_issuer = token_issuer
        self._audit = audit_repository

    def issue_copy(
        self,
        *,
        actor_account_id: object,
        actor_authenticated_at: object,
        library_id: object,
        target_account_id: object,
        request_ref: object,
    ) -> CopiedInvitation:
        delivery = self._issue(
            actor_account_id=actor_account_id,
            actor_authenticated_at=actor_authenticated_at,
            library_id=library_id,
            target_account_id=target_account_id,
            request_ref=request_ref,
            enqueue=False,
        )
        return CopiedInvitation(
            invitation_url=_invitation_url(
                self._public_base_url,
                delivery.raw_token,
            ),
            expires_at=delivery.expires_at,
        )

    def queue_email(
        self,
        *,
        actor_account_id: object,
        actor_authenticated_at: object,
        library_id: object,
        target_account_id: object,
        request_ref: object,
    ) -> InvitationDelivery:
        issued = self._issue(
            actor_account_id=actor_account_id,
            actor_authenticated_at=actor_authenticated_at,
            library_id=library_id,
            target_account_id=target_account_id,
            request_ref=request_ref,
            enqueue=True,
        )
        if issued.outbox_id is None:
            raise RuntimeError("Managed account invitation outbox was not created.")
        return InvitationDelivery(
            outbox_id=issued.outbox_id,
            invitation_token_id=issued.invitation_token_id,
            account_id=issued.account_id,
            recipient=issued.recipient,
            username=issued.username,
            raw_token=issued.raw_token,
            expires_at=issued.expires_at,
        )

    def _issue(
        self,
        *,
        actor_account_id: object,
        actor_authenticated_at: object,
        library_id: object,
        target_account_id: object,
        request_ref: object,
        enqueue: bool,
    ) -> _RotatedInvitation:
        if not isinstance(enqueue, bool):
            raise ValueError("Invitation delivery choice is invalid.")
        now = _aware_utc(self._clock())
        authenticated = _aware_utc(actor_authenticated_at)
        if authenticated > now + _FUTURE_SKEW or now - authenticated > _RECENT_AUTH_WINDOW:
            raise RecentAuthenticationRequired("Recent authentication is required.")
        actor_id = _positive_id(actor_account_id)
        current_library_id = _positive_id(library_id)
        target_id = _positive_id(target_account_id)
        reference = _request_ref(request_ref)
        try:
            with self._operation() as connection:
                return _rotate_invitation_in_transaction(
                    connection=connection,
                    actor_account_id=actor_id,
                    library_id=current_library_id,
                    target_account_id=target_id,
                    request_ref=reference,
                    enqueue=enqueue,
                    now=now,
                    token_issuer=self._token_issuer,
                    invitation_token_seconds=self._invitation_token_seconds,
                    audit_repository=self._audit,
                )
        except (PermissionError, RecentAuthenticationRequired, ValueError):
            raise
        except Exception:
            raise RuntimeError(
                "Managed account invitation persistence failed."
            ) from None

    @contextmanager
    def _operation(self) -> Iterator[Any]:
        with self._connect(self._database_url) as connection:
            transaction = getattr(connection, "transaction", None)
            if not callable(transaction):
                raise RuntimeError("Invitation persistence requires transactions.")
            with transaction():
                yield connection


def _rotate_invitation_in_transaction(
    *,
    connection: Any,
    actor_account_id: int,
    library_id: int,
    target_account_id: int,
    request_ref: str,
    enqueue: bool,
    now: datetime,
    token_issuer: Callable[[], object],
    invitation_token_seconds: int,
    audit_repository: Any,
) -> _RotatedInvitation:
    rows = connection.execute(
        """
        with locked_accounts as (
          select id, account_kind, username_display, contact_email,
                 is_active, disabled_at
          from app.accounts
          where id in (%s, %s)
          order by id for update
        ), locked_library as (
          select id, owner_account_id
          from library.libraries
          where id = %s
          for update
        )
        select target.id, target.username_display, target.contact_email
        from locked_accounts actor
        join app.bootstrap_owners authority
          on authority.account_id = actor.id
         and authority.owner_key = 'local-bootstrap-owner'
        join locked_library on locked_library.owner_account_id = actor.id
        join locked_accounts target on target.id = %s
        join library.library_memberships membership
          on membership.account_id = target.id
         and membership.library_id = locked_library.id
        left join app.bootstrap_owners target_owner
          on target_owner.account_id = target.id
        left join app.account_credentials credential
          on credential.account_id = target.id
        where actor.id = %s
          and actor.is_active is true
          and actor.disabled_at is null
          and target.account_kind = 'managed_user'
          and target.is_active is true
          and target.disabled_at is null
          and target_owner.account_id is null
          and credential.account_id is null
        """,
        (
            actor_account_id,
            target_account_id,
            library_id,
            target_account_id,
            actor_account_id,
        ),
    ).fetchall()
    if len(rows) != 1 or not isinstance(rows[0], Mapping):
        raise PermissionError("Managed account invitation is not permitted.")
    account = rows[0]
    recipient = _required_text(account.get("contact_email"))
    username = _required_text(account.get("username_display"))

    connection.execute(
        """
        select id from app.account_invitation_tokens
        where account_id = %s
        order by id for update
        """,
        (target_account_id,),
    ).fetchall()
    connection.execute(
        """
        update app.account_invitation_tokens
        set revoked_at = %s
        where account_id = %s
          and consumed_at is null
          and revoked_at is null
        """,
        (now, target_account_id),
    )
    issued = validated_issued_invitation_token(token_issuer)
    expires_at = now + timedelta(seconds=invitation_token_seconds)
    token_id = _single_id(
        connection.execute(
            """
            insert into app.account_invitation_tokens (
              account_id, token_hash, purpose, created_at, expires_at, request_ref
            ) values (%s, %s, %s, %s, %s, %s)
            returning id
            """,
            (
                target_account_id,
                issued.digest,
                INVITATION_DB_PURPOSE,
                now,
                expires_at,
                request_ref,
            ),
        ).fetchall(),
        "invitation token id",
    )
    outbox_id = None
    if enqueue:
        outbox_id = _single_id(
            connection.execute(
                """
                insert into app.mail_outbox (
                  account_id, invitation_token_id, message_category,
                  delivery_status, next_attempt_at
                ) values (%s, %s, %s, 'pending', %s)
                returning id
                """,
                (
                    target_account_id,
                    token_id,
                    INVITATION_MESSAGE_CATEGORY,
                    now,
                ),
            ).fetchall(),
            "outbox id",
        )
    audit_repository.append_in_transaction(
        connection,
        category=SecurityAuditCategory.ACCOUNT_INVITATION,
        outcome=SecurityAuditOutcome.SUCCESS,
        reason=(
            InvitationAuditReason.INVITATION_QUEUED
            if enqueue
            else InvitationAuditReason.INVITATION_COPIED
        ),
        actor_account_id=actor_account_id,
        target_account_id=target_account_id,
        request_ref=request_ref,
        occurred_at=now,
        metadata=None,
    )
    return _RotatedInvitation(
        outbox_id=outbox_id,
        invitation_token_id=token_id,
        account_id=target_account_id,
        recipient=recipient,
        username=username,
        raw_token=issued.raw,
        expires_at=expires_at,
    )


def _invitation_url(public_base_url: str, raw_token: str) -> str:
    base = build_public_url(public_base_url, "/accept-invitation")
    return f"{base}?{urlencode({'purpose': INVITATION_URL_PURPOSE, 'token': raw_token})}"


def _positive_id(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("Managed account invitation reference is invalid.")
    return value


def _request_ref(value: object) -> str:
    if not isinstance(value, str) or _REQUEST_REFERENCE.fullmatch(value) is None:
        raise ValueError("Managed account invitation request reference is invalid.")
    return value


def _aware_utc(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RecentAuthenticationRequired("Recent authentication is required.")
    return value.astimezone(timezone.utc)


def _required_text(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError("Managed account invitation persistence failed.")
    return value


def _single_id(rows: object, field: str) -> int:
    values = list(rows or ())
    if len(values) != 1:
        raise RuntimeError(f"Managed account {field} is invalid.")
    row = values[0]
    value = row.get("id") if isinstance(row, Mapping) else None
    try:
        return _positive_id(value)
    except ValueError:
        raise RuntimeError(f"Managed account {field} is invalid.") from None


def _connect(database_url: str):
    if psycopg is None:
        raise RuntimeError("psycopg is required for managed account invitations.")
    return psycopg.connect(database_url, row_factory=dict_row)
