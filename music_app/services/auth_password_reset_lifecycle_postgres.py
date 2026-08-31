"""Clean-URL password-reset lifecycle exchange and atomic completion."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
import hmac
import re
from typing import Any, Iterator

from music_app.services.auth_audit_postgres import (
    RecoveryAuditReason,
    SecurityAuditCategory,
    SecurityAuditOutcome,
)
from music_app.services.auth_passwords import PasswordCredential, hash_password
from music_app.services.auth_tokens import (
    IssuedOpaqueToken,
    hash_opaque_token,
    issue_opaque_token,
)

try:  # pragma: no cover - exercised when the optional runtime driver is present.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_LIFECYCLE_SECONDS = 15 * 60
_REQUEST_REFERENCE = re.compile(r"[A-Za-z0-9._:-]{1,128}")
_CONTEXT_COLUMNS = (
    "transaction_id",
    "reset_token_id",
    "account_id",
    "username_display",
    "contact_email",
    "credential_version",
    "is_active",
    "disabled_at",
    "reset_expires_at",
    "transaction_expires_at",
    "reset_consumed_at",
    "reset_revoked_at",
    "transaction_consumed_at",
)


class ResetCompletionOutcome(str, Enum):
    SUCCESS = "success"
    INVALID = "invalid"


@dataclass(frozen=True, repr=False, slots=True)
class IssuedResetTransaction:
    raw_token: str
    transaction_id: int
    expires_at: datetime

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(raw_token=<redacted>, "
            f"transaction_id={self.transaction_id!r}, expires_at={self.expires_at!r})"
        )


class PostgresPasswordResetLifecycleService:
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
                "ALBUM_HAVEN_APP_DATABASE_URL is required for password reset."
            )
        argon2 = payload.get("argon2")
        if not isinstance(argon2, Mapping):
            raise ValueError("Password reset configuration is invalid.")
        self._argon2 = dict(argon2)
        self._policy_version = _positive_integer(
            payload.get("argon2_policy_version"), "Argon2 policy version"
        )
        if not callable(token_issuer) or not callable(password_hasher):
            raise TypeError("Password reset provider is invalid.")
        if not callable(breached_checker):
            raise TypeError("Password reset screening provider is invalid.")
        if not callable(getattr(audit_repository, "append_in_transaction", None)):
            raise TypeError("Password reset audit repository is invalid.")
        self._connect = connect or _connect
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._token_issuer = token_issuer
        self._password_hasher = password_hasher
        self._breached_checker = breached_checker
        self._audit = audit_repository

    def exchange_reset_token(
        self,
        raw_reset_token: object,
        *,
        request_ref: object,
    ) -> IssuedResetTransaction | None:
        request_ref = _request_ref(request_ref)
        digest = _digest(raw_reset_token)
        if digest is None:
            return None
        issued = _issued_token(self._token_issuer)
        now = _aware_utc(self._clock())
        expires_at = now + timedelta(seconds=_LIFECYCLE_SECONDS)
        try:
            with self._operation() as connection:
                rows = connection.execute(
                    """
                    select null::bigint as transaction_id,
                           reset_token.id as reset_token_id,
                           account.id as account_id,
                           account.username_display,
                           account.contact_email,
                           credential.credential_version,
                           account.is_active, account.disabled_at,
                           reset_token.expires_at as reset_expires_at,
                           null::timestamptz as transaction_expires_at,
                           reset_token.consumed_at as reset_consumed_at,
                           reset_token.revoked_at as reset_revoked_at,
                           null::timestamptz as transaction_consumed_at
                    from app.password_reset_tokens reset_token
                    join app.accounts account on account.id = reset_token.account_id
                    join app.account_credentials credential
                      on credential.account_id = account.id
                    where reset_token.purpose = 'password_reset'
                      and reset_token.token_hash = %s
                      and reset_token.credential_version = credential.credential_version
                      and reset_token.consumed_at is null
                      and reset_token.revoked_at is null
                      and reset_token.expires_at > %s
                      and account.is_active is true
                      and account.disabled_at is null
                    for share of reset_token, account, credential
                    """,
                    (digest, now),
                ).fetchall()
                if len(rows) != 1:
                    return None
                context = _row(rows[0], _CONTEXT_COLUMNS)
                reset_token_id = _positive_integer(
                    context.get("reset_token_id"), "reset token id"
                )
                inserted = connection.execute(
                    """
                    insert into app.password_reset_transactions (
                      reset_token_id, transaction_hash, created_at, expires_at
                    ) values (%s, %s, %s, %s)
                    returning id
                    """,
                    (reset_token_id, issued.digest, now, expires_at),
                ).fetchall()
                transaction_id = _single_id(inserted, "transaction id")
            return IssuedResetTransaction(
                raw_token=issued.raw,
                transaction_id=transaction_id,
                expires_at=expires_at,
            )
        except Exception:
            raise RuntimeError("Password reset exchange failed.") from None

    def validate_transaction(self, raw_transaction: object) -> bool:
        digest = _digest(raw_transaction)
        if digest is None:
            return False
        now = _aware_utc(self._clock())
        try:
            with self._operation() as connection:
                return self._transaction_context(connection, digest, now) is not None
        except Exception:
            raise RuntimeError("Password reset validation failed.") from None

    def complete_reset(
        self,
        raw_transaction: object,
        *,
        new_password: object,
        request_ref: object,
    ) -> ResetCompletionOutcome:
        request_ref = _request_ref(request_ref)
        digest = _digest(raw_transaction)
        if digest is None or not isinstance(new_password, str):
            return ResetCompletionOutcome.INVALID
        now = _aware_utc(self._clock())
        try:
            with self._operation() as connection:
                snapshot = self._transaction_context(connection, digest, now)
            if snapshot is None:
                return ResetCompletionOutcome.INVALID
            account_id = _positive_integer(snapshot.get("account_id"), "account id")
            credential_version = _positive_integer(
                snapshot.get("credential_version"), "credential version"
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
                if not self._lock_current_context(
                    connection,
                    snapshot,
                    digest,
                    now,
                ):
                    self._append_audit(
                        connection,
                        outcome=SecurityAuditOutcome.INVALID,
                        reason=RecoveryAuditReason.RESET_INVALID,
                        target_account_id=account_id,
                        request_ref=request_ref,
                        now=now,
                    )
                    return ResetCompletionOutcome.INVALID
                credential_update = connection.execute(
                    """
                    update app.account_credentials
                    set encoded_hash = %s, hash_policy_version = %s,
                        credential_version = credential_version + 1,
                        administrator_set = false, password_set_at = %s,
                        updated_at = %s
                    where account_id = %s and credential_version = %s
                    """,
                    (
                        credential.encoded_hash,
                        credential.policy_version,
                        now,
                        now,
                        account_id,
                        credential_version,
                    ),
                )
                _require_updated(credential_update)
                reset_token_id = _positive_integer(
                    snapshot.get("reset_token_id"), "reset token id"
                )
                reset_update = connection.execute(
                    """
                    update app.password_reset_tokens
                    set consumed_at = %s
                    where id = %s and consumed_at is null and revoked_at is null
                    """,
                    (now, reset_token_id),
                )
                _require_updated(reset_update)
                connection.execute(
                    """
                    update app.password_reset_tokens
                    set revoked_at = %s
                    where account_id = %s and id <> %s
                      and consumed_at is null and revoked_at is null
                    """,
                    (now, account_id, reset_token_id),
                )
                connection.execute(
                    """
                    update app.password_reset_transactions
                    set consumed_at = %s
                    where reset_token_id in (
                      select id from app.password_reset_tokens where account_id = %s
                    ) and consumed_at is null
                    """,
                    (now, account_id),
                )
                connection.execute(
                    """
                    update app.account_sessions
                    set revoked_at = %s, revocation_reason = 'password_reset'
                    where account_id = %s and revoked_at is null
                    """,
                    (now, account_id),
                )
                self._append_audit(
                    connection,
                    outcome=SecurityAuditOutcome.SUCCESS,
                    reason=RecoveryAuditReason.RESET_COMPLETED,
                    target_account_id=account_id,
                    request_ref=request_ref,
                    now=now,
                )
            return ResetCompletionOutcome.SUCCESS
        except (TypeError, ValueError):
            raise
        except Exception:
            raise RuntimeError("Password reset completion failed.") from None

    def _transaction_context(
        self, connection: Any, digest: bytes, now: datetime
    ) -> Mapping[str, object] | None:
        rows = connection.execute(
            """
            select app.password_reset_transactions.id as transaction_id,
                   app.password_reset_tokens.id as reset_token_id,
                   app.accounts.id as account_id,
                   app.accounts.username_display, app.accounts.contact_email,
                   app.account_credentials.credential_version,
                   app.accounts.is_active, app.accounts.disabled_at,
                   app.password_reset_tokens.expires_at as reset_expires_at,
                   app.password_reset_transactions.expires_at as transaction_expires_at,
                   app.password_reset_tokens.consumed_at as reset_consumed_at,
                   app.password_reset_tokens.revoked_at as reset_revoked_at,
                   app.password_reset_transactions.consumed_at as transaction_consumed_at
            from app.password_reset_transactions
            join app.password_reset_tokens
              on app.password_reset_tokens.id = app.password_reset_transactions.reset_token_id
            join app.accounts on app.accounts.id = app.password_reset_tokens.account_id
            join app.account_credentials
              on app.account_credentials.account_id = app.accounts.id
            where app.password_reset_transactions.transaction_hash = %s
              and app.password_reset_transactions.consumed_at is null
              and app.password_reset_transactions.expires_at > %s
              and app.password_reset_tokens.purpose = 'password_reset'
              and app.password_reset_tokens.consumed_at is null
              and app.password_reset_tokens.revoked_at is null
              and app.password_reset_tokens.expires_at > %s
              and app.password_reset_tokens.credential_version =
                  app.account_credentials.credential_version
              and app.accounts.is_active is true
              and app.accounts.disabled_at is null
            """,
            (digest, now, now),
        ).fetchall()
        if not rows:
            return None
        if len(rows) != 1:
            raise RuntimeError
        return _row(rows[0], _CONTEXT_COLUMNS)

    def _lock_current_context(
        self,
        connection: Any,
        snapshot: Mapping[str, object],
        digest: bytes,
        now: datetime,
    ) -> bool:
        account_id = _positive_integer(snapshot.get("account_id"), "account id")
        reset_id = _positive_integer(snapshot.get("reset_token_id"), "reset token id")
        transaction_id = _positive_integer(
            snapshot.get("transaction_id"), "transaction id"
        )
        credential_version = _positive_integer(
            snapshot.get("credential_version"), "credential version"
        )
        accounts = connection.execute(
            """
            select id, is_active, disabled_at from app.accounts
            where id = %s for update
            """,
            (account_id,),
        ).fetchall()
        credentials = connection.execute(
            """
            select account_id, credential_version from app.account_credentials
            where account_id = %s for update
            """,
            (account_id,),
        ).fetchall()
        resets = connection.execute(
            """
            select id, account_id, credential_version, expires_at,
                   consumed_at, revoked_at
            from app.password_reset_tokens where id = %s for update
            """,
            (reset_id,),
        ).fetchall()
        transactions = connection.execute(
            """
            select id, reset_token_id, expires_at, consumed_at
            from app.password_reset_transactions
            where id = %s and transaction_hash = %s for update
            """,
            (transaction_id, digest),
        ).fetchall()
        connection.execute(
            """
            select id from app.account_sessions
            where account_id = %s and revoked_at is null
            order by created_at, id for update
            """,
            (account_id,),
        ).fetchall()
        if not all(len(rows) == 1 for rows in (accounts, credentials, resets, transactions)):
            return False
        account = _row(accounts[0], ("id", "is_active", "disabled_at"))
        stored_credential = _row(credentials[0], ("account_id", "credential_version"))
        reset = _row(
            resets[0],
            ("id", "account_id", "credential_version", "expires_at", "consumed_at", "revoked_at"),
        )
        transaction = _row(
            transactions[0], ("id", "reset_token_id", "expires_at", "consumed_at")
        )
        return bool(
            account.get("is_active") is True
            and account.get("disabled_at") is None
            and stored_credential.get("credential_version") == credential_version
            and reset.get("credential_version") == credential_version
            and reset.get("consumed_at") is None
            and reset.get("revoked_at") is None
            and _timestamp(reset.get("expires_at")) > now
            and transaction.get("consumed_at") is None
            and _timestamp(transaction.get("expires_at")) > now
        )

    def _append_audit(
        self,
        connection: Any,
        *,
        outcome: SecurityAuditOutcome,
        reason: RecoveryAuditReason,
        target_account_id: int,
        request_ref: str,
        now: datetime,
    ) -> None:
        self._audit.append_in_transaction(
            connection,
            category=SecurityAuditCategory.PASSWORD_RECOVERY,
            outcome=outcome,
            reason=reason,
            actor_account_id=None,
            target_account_id=target_account_id,
            request_ref=request_ref,
            occurred_at=now,
            metadata=None,
        )

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


def _issued_token(provider: Callable[[], object]) -> IssuedOpaqueToken:
    value = provider()
    if not isinstance(value, IssuedOpaqueToken):
        raise RuntimeError("Password reset transaction issuance failed.")
    try:
        expected = hash_opaque_token(value.raw)
    except (TypeError, ValueError):
        raise RuntimeError("Password reset transaction issuance failed.") from None
    if not hmac.compare_digest(expected, value.digest):
        raise RuntimeError("Password reset transaction issuance failed.")
    return value


def _request_ref(value: object) -> str:
    if not isinstance(value, str) or _REQUEST_REFERENCE.fullmatch(value) is None:
        raise ValueError("Password reset request reference is invalid.")
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
        raise ValueError(f"Password reset {field} is invalid.")
    return value


def _required_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value or "\r" in value or "\n" in value:
        raise RuntimeError(f"Password reset {field} is invalid.")
    return value


def _timestamp(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RuntimeError
    return value.astimezone(timezone.utc)


def _aware_utc(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RuntimeError("Password reset clock is invalid.")
    return value.astimezone(timezone.utc)


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for password reset.")
    return psycopg.connect(database_url, row_factory=dict_row)
