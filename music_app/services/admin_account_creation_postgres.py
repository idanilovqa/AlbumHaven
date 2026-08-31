"""Atomic Postgres persistence for administrator-created managed accounts."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from music_app.services.admin_account_creation import CreatedAccount
from music_app.services.auth_passwords import PasswordCredential

try:  # pragma: no cover - exercised with the optional runtime driver.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


_IDENTITY_CONSTRAINTS = frozenset(
    {"accounts_username_normalized_idx", "accounts_contact_email_normalized_idx"}
)


class ManagedAccountIdentityConflict(ValueError):
    pass


class PostgresAdminAccountRepository:
    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(
            payload.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
        ).strip()
        if not self._database_url:
            raise RuntimeError("Database configuration is required for account creation.")
        self._connect = connect or _connect

    def create_account(
        self,
        *,
        actor_account_id: int,
        library_id: int,
        username_display: str,
        username_normalized: str,
        contact_email: str,
        contact_email_normalized: str,
        credential: PasswordCredential,
        capability_keys: tuple[str, ...],
    ) -> CreatedAccount:
        _positive_id(actor_account_id)
        _positive_id(library_id)
        if not isinstance(credential, PasswordCredential):
            raise ValueError("Managed account credential is invalid.")
        try:
            with self._connect(self._database_url) as connection:
                with connection.transaction():
                    authority = connection.execute(
                        """
                        select owner.account_id as actor_account_id,
                               library.id as library_id
                        from app.bootstrap_owners owner
                        join app.accounts account
                          on account.id = owner.account_id
                         and account.is_active is true
                         and account.disabled_at is null
                        join library.libraries library
                          on library.id = %s
                         and library.owner_account_id = account.id
                        where owner.account_id = %s
                          and owner.owner_key = 'local-bootstrap-owner'
                        for update of account, library
                        """,
                        (library_id, actor_account_id),
                    ).fetchall()
                    if len(authority) != 1:
                        raise PermissionError(
                            "Administrator account creation is not permitted."
                        )
                    account_id = _returned_id(
                        connection.execute(
                            """
                            insert into app.accounts (
                              display_name, account_kind, username_display,
                              username_normalized, contact_email,
                              contact_email_normalized, is_active
                            ) values (%s, %s, %s, %s, %s, %s, true)
                            returning id
                            """,
                            (
                                username_display,
                                "managed_user",
                                username_display,
                                username_normalized,
                                contact_email,
                                contact_email_normalized,
                            ),
                        ).fetchall()
                    )
                    connection.execute(
                        """
                        insert into app.account_credentials (
                          account_id, encoded_hash, hash_algorithm,
                          hash_policy_version, credential_version,
                          administrator_set
                        ) values (%s, %s, 'argon2id', %s, 1, true)
                        """,
                        (
                            account_id,
                            credential.encoded_hash,
                            credential.policy_version,
                        ),
                    )
                    connection.execute(
                        """
                        insert into library.library_memberships (
                          library_id, account_id, membership_role
                        ) values (%s, %s, 'member')
                        """,
                        (library_id, account_id),
                    )
                    for capability_key in capability_keys:
                        connection.execute(
                            """
                            insert into app.capabilities (
                              account_id, capability_key, scope_kind, scope_id
                            ) values (%s, %s, 'library', %s)
                            """,
                            (account_id, capability_key, library_id),
                        )
                    welcome_outbox_id = _returned_id(
                        connection.execute(
                            """
                            insert into app.mail_outbox (
                              account_id, message_category, delivery_status,
                              next_attempt_at
                            ) values (%s, 'welcome', 'pending', now())
                            returning id
                            """,
                            (account_id,),
                        ).fetchall()
                    )
                    connection.execute(
                        """
                        insert into app.security_audit_events (
                          actor_account_id, target_account_id, event_category,
                          outcome, reason_code, metadata
                        ) values (%s, %s, 'account_management', 'success',
                                  'account_created', '{}'::jsonb)
                        """,
                        (actor_account_id, account_id),
                    )
        except Exception as exc:
            constraint = getattr(getattr(exc, "diag", None), "constraint_name", None)
            if constraint in _IDENTITY_CONSTRAINTS:
                raise ManagedAccountIdentityConflict(
                    "Username or contact email is already in use."
                ) from None
            raise
        return CreatedAccount(
            account_id=account_id,
            welcome_outbox_id=welcome_outbox_id,
        )


def _positive_id(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("Managed account reference is invalid.")
    return value


def _returned_id(rows: object) -> int:
    if not isinstance(rows, list) or len(rows) != 1:
        raise RuntimeError("Managed account persistence failed.")
    row = rows[0]
    value = row.get("id") if isinstance(row, Mapping) else None
    return _positive_id(value)


def _connect(database_url: str):
    if psycopg is None:
        raise RuntimeError("psycopg is required for account creation.")
    return psycopg.connect(database_url, row_factory=dict_row)
