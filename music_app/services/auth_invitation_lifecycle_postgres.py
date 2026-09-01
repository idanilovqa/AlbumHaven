"""Clean-URL managed-account invitation exchange and completion."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import re
from typing import Any, Iterator

from music_app.services.auth_audit_postgres import (
    InvitationAuditReason,
    SecurityAuditCategory,
    SecurityAuditOutcome,
)
from music_app.services.auth_invitation_models import (
    INVITATION_DB_PURPOSE,
    INVITATION_TRANSACTION_SECONDS,
    InvitationCompletionOutcome,
    IssuedInvitationTransaction,
    validated_issued_invitation_token,
)
from music_app.services.auth_passwords import PasswordCredential, hash_password
from music_app.services.auth_tokens import hash_opaque_token, issue_opaque_token

try:  # pragma: no cover - exercised when the optional runtime driver is present.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_REQUEST_REFERENCE = re.compile(r"[A-Za-z0-9._:-]{1,128}")
_CONTEXT_COLUMNS = (
    "transaction_id",
    "invitation_token_id",
    "account_id",
    "username_display",
    "contact_email",
    "is_active",
    "disabled_at",
    "invitation_expires_at",
    "transaction_expires_at",
    "invitation_consumed_at",
    "invitation_revoked_at",
    "transaction_consumed_at",
)


class PostgresInvitationLifecycleService:
    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        connect: Callable[[str], Any] | None = None,
        clock: Callable[[], datetime] | None = None,
        token_issuer: Callable[[], object] = issue_opaque_token,
        password_hasher: Callable[..., PasswordCredential] = hash_password,
        breached_checker: Callable[[str], bool],
        audit_repository: Any,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(payload.get(_DATABASE_URL_KEY) or "").strip()
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for account invitation."
            )
        argon2 = payload.get("argon2")
        if not isinstance(argon2, Mapping):
            raise ValueError("Account invitation configuration is invalid.")
        self._argon2 = dict(argon2)
        self._policy_version = _positive_integer(
            payload.get("argon2_policy_version"), "Argon2 policy version"
        )
        if not callable(token_issuer) or not callable(password_hasher):
            raise TypeError("Account invitation provider is invalid.")
        if not callable(breached_checker):
            raise TypeError("Account invitation screening provider is invalid.")
        if not callable(getattr(audit_repository, "append_in_transaction", None)):
            raise TypeError("Account invitation audit repository is invalid.")
        self._connect = connect or _connect
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._token_issuer = token_issuer
        self._password_hasher = password_hasher
        self._breached_checker = breached_checker
        self._audit = audit_repository

    def exchange_invitation_token(
        self,
        raw_invitation_token: object,
        *,
        request_ref: object,
    ) -> IssuedInvitationTransaction | None:
        reference = _request_ref(request_ref)
        digest = _digest(raw_invitation_token)
        if digest is None:
            return None
        now = _aware_utc(self._clock())
        try:
            with self._operation() as connection:
                rows = connection.execute(
                    """
                    select invitation.id as invitation_token_id,
                           account.id as account_id,
                           account.username_display,
                           account.contact_email
                    from app.account_invitation_tokens invitation
                    join app.accounts account on account.id = invitation.account_id
                    left join app.account_credentials credential
                      on credential.account_id = account.id
                    where invitation.purpose = %s
                      and invitation.token_hash = %s
                      and invitation.consumed_at is null
                      and invitation.revoked_at is null
                      and invitation.expires_at > %s
                      and account.account_kind = 'managed_user'
                      and account.is_active is true
                      and account.disabled_at is null
                      and credential.account_id is null
                    for update of account, invitation
                    """,
                    (INVITATION_DB_PURPOSE, digest, now),
                ).fetchall()
                if len(rows) != 1:
                    return None
                context = _row(
                    rows[0],
                    (
                        "invitation_token_id",
                        "account_id",
                        "username_display",
                        "contact_email",
                    ),
                )
                invitation_token_id = _positive_integer(
                    context.get("invitation_token_id"), "invitation token id"
                )
                issued = validated_issued_invitation_token(self._token_issuer)
                expires_at = now + timedelta(
                    seconds=INVITATION_TRANSACTION_SECONDS
                )
                inserted = connection.execute(
                    """
                    insert into app.account_invitation_transactions (
                      invitation_token_id, transaction_hash, created_at, expires_at
                    ) values (%s, %s, %s, %s)
                    on conflict (invitation_token_id) do nothing
                    returning id
                    """,
                    (invitation_token_id, issued.digest, now, expires_at),
                ).fetchall()
                if not inserted:
                    return None
                transaction_id = _single_id(inserted, "transaction id")
            return IssuedInvitationTransaction(
                raw_token=issued.raw,
                transaction_id=transaction_id,
                expires_at=expires_at,
            )
        except Exception:
            raise RuntimeError("Account invitation exchange failed.") from None

    def validate_transaction(self, raw_transaction: object) -> bool:
        digest = _digest(raw_transaction)
        if digest is None:
            return False
        now = _aware_utc(self._clock())
        try:
            with self._operation() as connection:
                return self._transaction_context(connection, digest, now) is not None
        except Exception:
            raise RuntimeError("Account invitation validation failed.") from None

    def complete_invitation(
        self,
        raw_transaction: object,
        *,
        new_password: object,
        request_ref: object,
    ) -> InvitationCompletionOutcome:
        reference = _request_ref(request_ref)
        digest = _digest(raw_transaction)
        if digest is None or not isinstance(new_password, str):
            return InvitationCompletionOutcome.INVALID
        now = _aware_utc(self._clock())
        try:
            with self._operation() as connection:
                snapshot = self._transaction_context(connection, digest, now)
            if snapshot is None:
                return InvitationCompletionOutcome.INVALID
            account_id = _positive_integer(snapshot.get("account_id"), "account id")
            invitation_token_id = _positive_integer(
                snapshot.get("invitation_token_id"), "invitation token id"
            )
            transaction_id = _positive_integer(
                snapshot.get("transaction_id"), "transaction id"
            )
            credential = self._password_hasher(
                new_password,
                username=_required_text(snapshot.get("username_display"), "username"),
                email=_required_text(snapshot.get("contact_email"), "contact email"),
                breached_checker=self._breached_checker,
                argon2=self._argon2,
                policy_version=self._policy_version,
            )
            if not isinstance(credential, PasswordCredential):
                raise RuntimeError

            with self._operation() as connection:
                accounts = connection.execute(
                    """
                    select id, account_kind, is_active, disabled_at
                    from app.accounts where id = %s for update
                    """,
                    (account_id,),
                ).fetchall()
                credentials = connection.execute(
                    """
                    select account_id from app.account_credentials
                    where account_id = %s for update
                    """,
                    (account_id,),
                ).fetchall()
                invitations = connection.execute(
                    """
                    select id, account_id, purpose, expires_at,
                           consumed_at, revoked_at
                    from app.account_invitation_tokens
                    where id = %s for update
                    """,
                    (invitation_token_id,),
                ).fetchall()
                transactions = connection.execute(
                    """
                    select id, invitation_token_id, expires_at, consumed_at
                    from app.account_invitation_transactions
                    where id = %s and transaction_hash = %s for update
                    """,
                    (transaction_id, digest),
                ).fetchall()
                connection.execute(
                    """
                    select id from app.password_reset_tokens
                    where account_id = %s order by id for update
                    """,
                    (account_id,),
                ).fetchall()
                connection.execute(
                    """
                    select id from app.account_sessions
                    where account_id = %s order by id for update
                    """,
                    (account_id,),
                ).fetchall()

                if not (
                    len(accounts) == len(invitations) == len(transactions) == 1
                ):
                    return InvitationCompletionOutcome.INVALID
                if credentials:
                    return InvitationCompletionOutcome.INVALID
                account = _row(
                    accounts[0], ("id", "account_kind", "is_active", "disabled_at")
                )
                invitation = _row(
                    invitations[0],
                    (
                        "id",
                        "account_id",
                        "purpose",
                        "expires_at",
                        "consumed_at",
                        "revoked_at",
                    ),
                )
                transaction = _row(
                    transactions[0],
                    ("id", "invitation_token_id", "expires_at", "consumed_at"),
                )
                if not (
                    account.get("account_kind") == "managed_user"
                    and account.get("is_active") is True
                    and account.get("disabled_at") is None
                    and invitation.get("account_id") == account_id
                    and invitation.get("purpose") == INVITATION_DB_PURPOSE
                    and invitation.get("consumed_at") is None
                    and invitation.get("revoked_at") is None
                    and _timestamp(invitation.get("expires_at")) > now
                    and transaction.get("invitation_token_id")
                    == invitation_token_id
                    and transaction.get("consumed_at") is None
                    and _timestamp(transaction.get("expires_at")) > now
                ):
                    return InvitationCompletionOutcome.INVALID

                connection.execute(
                    """
                    insert into app.account_credentials (
                      account_id, encoded_hash, hash_algorithm,
                      hash_policy_version, credential_version,
                      administrator_set, password_set_at, updated_at
                    ) values (%s, %s, 'argon2id', %s, 1, false, %s, %s)
                    """,
                    (
                        account_id,
                        credential.encoded_hash,
                        credential.policy_version,
                        now,
                        now,
                    ),
                )
                _require_updated(
                    connection.execute(
                        """
                        update app.account_invitation_tokens set consumed_at = %s
                        where id = %s and consumed_at is null
                          and revoked_at is null and expires_at > %s
                        """,
                        (now, invitation_token_id, now),
                    )
                )
                _require_updated(
                    connection.execute(
                        """
                        update app.account_invitation_transactions
                        set consumed_at = %s
                        where id = %s and consumed_at is null and expires_at > %s
                        """,
                        (now, transaction_id, now),
                    )
                )
                connection.execute(
                    """
                    update app.account_invitation_tokens set revoked_at = %s
                    where account_id = %s and id <> %s
                      and consumed_at is null and revoked_at is null
                    """,
                    (now, account_id, invitation_token_id),
                )
                connection.execute(
                    """
                    update app.password_reset_tokens set revoked_at = %s
                    where account_id = %s
                      and consumed_at is null and revoked_at is null
                    """,
                    (now, account_id),
                )
                self._audit.append_in_transaction(
                    connection,
                    category=SecurityAuditCategory.ACCOUNT_INVITATION,
                    outcome=SecurityAuditOutcome.SUCCESS,
                    reason=InvitationAuditReason.INVITATION_ACCEPTED,
                    actor_account_id=None,
                    target_account_id=account_id,
                    request_ref=reference,
                    occurred_at=now,
                    metadata=None,
                )
            return InvitationCompletionOutcome.SUCCESS
        except (TypeError, ValueError):
            raise
        except Exception:
            raise RuntimeError("Account invitation completion failed.") from None

    def _transaction_context(
        self,
        connection: Any,
        digest: bytes,
        now: datetime,
    ) -> Mapping[str, object] | None:
        rows = connection.execute(
            """
            select transaction.id as transaction_id,
                   invitation.id as invitation_token_id,
                   account.id as account_id,
                   account.username_display,
                   account.contact_email,
                   account.is_active,
                   account.disabled_at,
                   invitation.expires_at as invitation_expires_at,
                   transaction.expires_at as transaction_expires_at,
                   invitation.consumed_at as invitation_consumed_at,
                   invitation.revoked_at as invitation_revoked_at,
                   transaction.consumed_at as transaction_consumed_at
            from app.account_invitation_transactions transaction
            join app.account_invitation_tokens invitation
              on invitation.id = transaction.invitation_token_id
            join app.accounts account on account.id = invitation.account_id
            left join app.account_credentials credential
              on credential.account_id = account.id
            where transaction.transaction_hash = %s
              and transaction.consumed_at is null
              and transaction.expires_at > %s
              and invitation.purpose = %s
              and invitation.consumed_at is null
              and invitation.revoked_at is null
              and invitation.expires_at > %s
              and account.account_kind = 'managed_user'
              and account.is_active is true
              and account.disabled_at is null
              and credential.account_id is null
            """,
            (digest, now, INVITATION_DB_PURPOSE, now),
        ).fetchall()
        if not rows:
            return None
        if len(rows) != 1:
            raise RuntimeError
        return _row(rows[0], _CONTEXT_COLUMNS)

    @contextmanager
    def _operation(self) -> Iterator[Any]:
        with self._connect(self._database_url) as connection:
            transaction = getattr(connection, "transaction", None)
            if not callable(transaction):
                raise RuntimeError
            with transaction():
                yield connection


def _digest(value: object) -> bytes | None:
    try:
        return hash_opaque_token(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _request_ref(value: object) -> str:
    if not isinstance(value, str) or _REQUEST_REFERENCE.fullmatch(value) is None:
        raise ValueError("Account invitation request reference is invalid.")
    return value


def _row(value: object, columns: tuple[str, ...]) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return value
    if isinstance(value, (tuple, list)):
        return dict(zip(columns, value, strict=False))
    return {}


def _single_id(rows: list[object], field: str) -> int:
    if len(rows) != 1:
        raise RuntimeError
    return _positive_integer(_row(rows[0], ("id",)).get("id"), field)


def _require_updated(cursor: object) -> None:
    if getattr(cursor, "rowcount", None) != 1:
        raise RuntimeError


def _positive_integer(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"Account invitation {field} is invalid.")
    return value


def _required_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value or "\r" in value or "\n" in value:
        raise RuntimeError(f"Account invitation {field} is invalid.")
    return value


def _timestamp(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RuntimeError
    return value.astimezone(timezone.utc)


def _aware_utc(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RuntimeError("Account invitation clock is invalid.")
    return value.astimezone(timezone.utc)


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for account invitation.")
    return psycopg.connect(database_url, row_factory=dict_row)
