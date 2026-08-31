"""Recent-auth refresh for sensitive administrator actions."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
import re
from typing import Any, Iterator

from music_app.services.auth_audit_postgres import (
    CredentialAuditReason,
    SecurityAuditCategory,
    SecurityAuditOutcome,
)
from music_app.services.auth_passwords import PasswordVerification, verify_password

try:  # pragma: no cover - exercised with the optional runtime driver.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


_REQUEST_REFERENCE = re.compile(r"[A-Za-z0-9._:-]{1,128}")


class AdminReauthenticationOutcome(str, Enum):
    SUCCESS = "success"
    INVALID = "invalid"
    STALE = "stale"


@dataclass(frozen=True, repr=False, slots=True)
class _Snapshot:
    encoded_hash: str
    hash_policy_version: int
    credential_version: int


class PostgresAdminReauthenticationService:
    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        connect: Callable[[str], Any] | None = None,
        clock: Callable[[], datetime] | None = None,
        verifier: Callable[..., PasswordVerification] = verify_password,
        audit_repository: Any,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(
            payload.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
        ).strip()
        argon2 = payload.get("argon2")
        if not self._database_url or not isinstance(argon2, Mapping):
            raise RuntimeError("Administrator reauthentication is not configured.")
        policy_version = payload.get("argon2_policy_version")
        if isinstance(policy_version, bool) or not isinstance(policy_version, int) or policy_version < 1:
            raise ValueError("Administrator reauthentication policy is invalid.")
        if not callable(verifier) or not callable(
            getattr(audit_repository, "append_in_transaction", None)
        ):
            raise TypeError("Administrator reauthentication provider is invalid.")
        self._argon2 = dict(argon2)
        self._policy_version = policy_version
        self._connect = connect or _connect
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._verifier = verifier
        self._audit = audit_repository

    def reauthenticate(
        self,
        *,
        account_id: object,
        session_id: object,
        password: object,
        request_ref: object,
    ) -> AdminReauthenticationOutcome:
        account = _positive_id(account_id)
        session = _positive_id(session_id)
        reference = _request_ref(request_ref)
        now = _aware_utc(self._clock())
        if not isinstance(password, str):
            return AdminReauthenticationOutcome.INVALID
        snapshot = self._snapshot(account)
        if snapshot is None:
            return AdminReauthenticationOutcome.STALE
        verification = self._verifier(
            password,
            snapshot.encoded_hash,
            stored_policy_version=snapshot.hash_policy_version,
            argon2=self._argon2,
            current_policy_version=self._policy_version,
        )
        if not isinstance(verification, PasswordVerification) or not verification.valid:
            with self._operation() as connection:
                self._append_audit(
                    connection,
                    outcome=SecurityAuditOutcome.INVALID,
                    reason=CredentialAuditReason.ADMINISTRATOR_REAUTHENTICATION_INVALID,
                    account_id=account,
                    request_ref=reference,
                    occurred_at=now,
                )
            return AdminReauthenticationOutcome.INVALID
        try:
            with self._operation() as connection:
                locked = connection.execute(
                    """
                    select account.id as account_id, account.is_active,
                           account.disabled_at, credential.encoded_hash,
                           credential.credential_version,
                           session.id as session_id
                    from app.accounts account
                    join app.account_credentials credential
                      on credential.account_id = account.id
                    join app.account_sessions session
                      on session.account_id = account.id and session.id = %s
                     and session.revoked_at is null
                     and session.idle_expires_at > %s
                     and session.absolute_expires_at > %s
                    where account.id = %s
                    for update of account, credential, session
                    """,
                    (session, now, now, account),
                ).fetchall()
                if len(locked) != 1 or not isinstance(locked[0], Mapping):
                    return AdminReauthenticationOutcome.STALE
                row = locked[0]
                if not (
                    row.get("is_active") is True
                    and row.get("disabled_at") is None
                    and row.get("encoded_hash") == snapshot.encoded_hash
                    and row.get("credential_version") == snapshot.credential_version
                    and row.get("session_id") == session
                ):
                    return AdminReauthenticationOutcome.STALE
                connection.execute(
                    """
                    update app.account_sessions
                    set authenticated_at = %s, last_seen_at = %s
                    where id = %s and account_id = %s and revoked_at is null
                    """,
                    (now, now, session, account),
                )
                self._append_audit(
                    connection,
                    outcome=SecurityAuditOutcome.SUCCESS,
                    reason=CredentialAuditReason.ADMINISTRATOR_REAUTHENTICATED,
                    account_id=account,
                    request_ref=reference,
                    occurred_at=now,
                )
            return AdminReauthenticationOutcome.SUCCESS
        except Exception:
            raise RuntimeError("Administrator reauthentication persistence failed.") from None

    def _snapshot(self, account_id: int) -> _Snapshot | None:
        with self._operation() as connection:
            rows = connection.execute(
                """
                select account.id as account_id, account.is_active,
                       account.disabled_at, credential.encoded_hash,
                       credential.hash_policy_version,
                       credential.credential_version
                from app.accounts account
                join app.account_credentials credential
                  on credential.account_id = account.id
                where account.id = %s
                """,
                (account_id,),
            ).fetchall()
        if len(rows) != 1 or not isinstance(rows[0], Mapping):
            return None
        row = rows[0]
        if row.get("is_active") is not True or row.get("disabled_at") is not None:
            return None
        encoded_hash = row.get("encoded_hash")
        if not isinstance(encoded_hash, str) or not encoded_hash:
            raise RuntimeError
        return _Snapshot(
            encoded_hash=encoded_hash,
            hash_policy_version=_positive_id(row.get("hash_policy_version")),
            credential_version=_positive_id(row.get("credential_version")),
        )

    def _append_audit(
        self,
        connection: Any,
        *,
        outcome: SecurityAuditOutcome,
        reason: CredentialAuditReason,
        account_id: int,
        request_ref: str,
        occurred_at: datetime,
    ) -> None:
        self._audit.append_in_transaction(
            connection,
            category=SecurityAuditCategory.CREDENTIAL,
            outcome=outcome,
            reason=reason,
            actor_account_id=account_id,
            target_account_id=account_id,
            request_ref=request_ref,
            occurred_at=occurred_at,
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


def _positive_id(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("Administrator reauthentication reference is invalid.")
    return value


def _request_ref(value: object) -> str:
    if not isinstance(value, str) or _REQUEST_REFERENCE.fullmatch(value) is None:
        raise ValueError("Administrator reauthentication request reference is invalid.")
    return value


def _aware_utc(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RuntimeError("Administrator reauthentication clock is invalid.")
    return value.astimezone(timezone.utc)


def _connect(database_url: str):
    if psycopg is None:
        raise RuntimeError("psycopg is required for administrator reauthentication.")
    return psycopg.connect(database_url, row_factory=dict_row)
