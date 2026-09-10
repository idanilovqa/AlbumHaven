"""Transactional emergency credential recovery for the bootstrap owner."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

try:  # pragma: no cover - exercised when the optional runtime driver is present.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - keeps non-Postgres tooling importable.
    psycopg = None
    dict_row = None

from music_app.services.auth_audit_postgres import (
    CredentialAuditReason,
    PostgresSecurityAuditRepository,
    SecurityAuditCategory,
    SecurityAuditOutcome,
)
from music_app.services.auth_bootstrap_postgres import _validate_credential


_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_OWNER_KEY = "local-bootstrap-owner"


@dataclass(frozen=True, slots=True)
class BreakGlassResetResult:
    """Non-secret evidence returned after committed emergency recovery."""

    account_id: int
    credential_version: int
    revoked_sessions: int
    revoked_reset_tokens: int


class PostgresAuthBreakGlassService:
    """Reset the active bootstrap owner and invalidate its lifecycle state."""

    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        connect: Callable[[str], Any] | None = None,
        audit_repository: Any | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(payload.get(_DATABASE_URL_KEY) or "").strip()
        self._argon2 = payload.get("argon2")
        self._active_policy_version = payload.get("argon2_policy_version")
        self._connect = connect or _connect
        self._audit = audit_repository or PostgresSecurityAuditRepository()
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        if not callable(getattr(self._audit, "append_in_transaction", None)):
            raise TypeError("Break-glass audit repository is invalid.")

    def reset_owner(
        self,
        *,
        encoded_hash: str,
        hash_policy_version: int,
        request_ref: str,
    ) -> BreakGlassResetResult:
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for break-glass recovery."
            )
        _validate_credential(
            encoded_hash,
            hash_policy_version,
            argon2=self._argon2,
            active_policy_version=self._active_policy_version,
        )
        now = self._clock()

        try:
            with self._connect(self._database_url) as connection:
                with _transaction(connection):
                    owner = _only_row(
                        connection.execute(
                            """
                            select account_id
                            from app.bootstrap_owners
                            where owner_key = %s
                            for update
                            """,
                            (_OWNER_KEY,),
                        ).fetchall(),
                        "Break-glass owner context is invalid.",
                    )
                    account_id = _positive_field(owner, "account_id", ("account_id",))

                    account = _only_row(
                        connection.execute(
                            """
                            select id, is_active, account_kind
                            from app.accounts
                            where id = %s
                            for update
                            """,
                            (account_id,),
                        ).fetchall(),
                        "Break-glass owner context is invalid.",
                    )
                    account_payload = _row(account, ("id", "is_active", "account_kind"))
                    if (
                        _positive_field(account, "id", ("id", "is_active", "account_kind"))
                        != account_id
                        or account_payload.get("is_active") is not True
                        or account_payload.get("account_kind") != "bootstrap_owner"
                    ):
                        raise RuntimeError("Break-glass owner context is invalid.")

                    credential = _only_row(
                        connection.execute(
                            """
                            select account_id, credential_version
                            from app.account_credentials
                            where account_id = %s
                            for update
                            """,
                            (account_id,),
                        ).fetchall(),
                        "Break-glass credential context is invalid.",
                    )
                    credential_payload = _row(
                        credential, ("account_id", "credential_version")
                    )
                    if (
                        _positive_field(
                            credential, "account_id", ("account_id", "credential_version")
                        )
                        != account_id
                    ):
                        raise RuntimeError("Break-glass credential context is invalid.")
                    previous_version = _positive_field(
                        credential,
                        "credential_version",
                        ("account_id", "credential_version"),
                    )

                    connection.execute(
                        """
                        select id from app.password_reset_tokens
                        where account_id = %s
                        order by id
                        for update
                        """,
                        (account_id,),
                    ).fetchall()
                    connection.execute(
                        """
                        select id from app.account_sessions
                        where account_id = %s
                        order by id
                        for update
                        """,
                        (account_id,),
                    ).fetchall()

                    credential_rows = connection.execute(
                        """
                        update app.account_credentials
                        set encoded_hash = %s,
                            hash_policy_version = %s,
                            credential_version = credential_version + 1,
                            administrator_set = false,
                            password_set_at = %s,
                            updated_at = %s
                        where account_id = %s and credential_version = %s
                        returning credential_version
                        """,
                        (
                            encoded_hash,
                            hash_policy_version,
                            now,
                            now,
                            account_id,
                            previous_version,
                        ),
                    ).fetchall()
                    updated_credential = _only_row(
                        credential_rows,
                        "Break-glass credential update did not complete.",
                    )
                    credential_version = _positive_field(
                        updated_credential,
                        "credential_version",
                        ("credential_version",),
                    )

                    revoked_reset_tokens = len(
                        connection.execute(
                            """
                            update app.password_reset_tokens
                            set revoked_at = %s
                            where account_id = %s
                              and consumed_at is null
                              and revoked_at is null
                            returning id
                            """,
                            (now, account_id),
                        ).fetchall()
                    )
                    connection.execute(
                        """
                        update app.password_reset_transactions
                        set consumed_at = %s
                        where reset_token_id in (
                          select id from app.password_reset_tokens where account_id = %s
                        ) and consumed_at is null
                        returning id
                        """,
                        (now, account_id),
                    ).fetchall()
                    connection.execute(
                        """
                        update app.account_invitation_tokens
                        set revoked_at = %s
                        where account_id = %s
                          and consumed_at is null
                          and revoked_at is null
                        """,
                        (now, account_id),
                    )
                    connection.execute(
                        """
                        update app.account_invitation_transactions
                        set consumed_at = %s
                        where consumed_at is null
                          and invitation_token_id in (
                            select id from app.account_invitation_tokens
                            where account_id = %s
                          )
                        """,
                        (now, account_id),
                    )
                    revoked_sessions = len(
                        connection.execute(
                            """
                            update app.account_sessions
                            set revoked_at = %s, revocation_reason = 'break_glass'
                            where account_id = %s and revoked_at is null
                            returning id
                            """,
                            (now, account_id),
                        ).fetchall()
                    )
                    self._audit.append_in_transaction(
                        connection,
                        category=SecurityAuditCategory.CREDENTIAL,
                        outcome=SecurityAuditOutcome.SUCCESS,
                        reason=CredentialAuditReason.BREAK_GLASS_RESET,
                        actor_account_id=None,
                        target_account_id=account_id,
                        request_ref=request_ref,
                        occurred_at=now,
                        metadata={"argon2_policy_version": hash_policy_version},
                    )
        except (TypeError, ValueError):
            raise
        except Exception:
            raise RuntimeError("Break-glass recovery failed.") from None

        return BreakGlassResetResult(
            account_id=account_id,
            credential_version=credential_version,
            revoked_sessions=revoked_sessions,
            revoked_reset_tokens=revoked_reset_tokens,
        )


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for break-glass recovery.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _transaction(connection: Any) -> Any:
    transaction = getattr(connection, "transaction", None)
    if not callable(transaction):
        raise RuntimeError("Break-glass recovery requires transaction support.")
    return transaction()


def _only_row(rows: object, error: str) -> object:
    values = list(rows or ())
    if len(values) != 1:
        raise RuntimeError(error)
    return values[0]


def _row(value: object, columns: tuple[str, ...]) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return value
    if isinstance(value, (tuple, list)):
        return dict(zip(columns, value, strict=False))
    return {}


def _positive_field(
    value: object, key: str, columns: tuple[str, ...]
) -> int:
    try:
        result = int(_row(value, columns).get(key) or 0)
    except (TypeError, ValueError):
        result = 0
    if result < 1:
        raise RuntimeError("Break-glass persistence context is invalid.")
    return result
