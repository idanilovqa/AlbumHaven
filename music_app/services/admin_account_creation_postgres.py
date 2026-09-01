"""Atomic Postgres persistence for administrator-created managed accounts."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from typing import Any

from music_app.services.admin_account_creation import CreatedAccount
from music_app.services.auth_invitation_models import InvitationDelivery
from music_app.services.auth_tokens import IssuedOpaqueToken

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
        capability_keys: tuple[str, ...],
        invitation: IssuedOpaqueToken | None,
        invitation_expires_at: datetime | None,
        created_at: datetime,
        request_ref: str,
    ) -> CreatedAccount:
        _positive_id(actor_account_id)
        _positive_id(library_id)
        created_at = _aware_utc(created_at)
        if invitation is None and invitation_expires_at is not None:
            raise ValueError("Managed account invitation expiry is invalid.")
        if invitation is not None:
            if not isinstance(invitation, IssuedOpaqueToken):
                raise ValueError("Managed account invitation is invalid.")
            invitation_expires_at = _aware_utc(invitation_expires_at)
            if invitation_expires_at <= created_at:
                raise ValueError("Managed account invitation expiry is invalid.")
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
                    invitation_delivery = None
                    if invitation is not None:
                        token_id = _returned_id(
                            connection.execute(
                                """
                                insert into app.account_invitation_tokens (
                                  account_id, token_hash, purpose, created_at,
                                  expires_at, request_ref
                                ) values (%s, %s, 'account_invitation', %s, %s, %s)
                                returning id
                                """,
                                (
                                    account_id,
                                    invitation.digest,
                                    created_at,
                                    invitation_expires_at,
                                    request_ref,
                                ),
                            ).fetchall()
                        )
                        outbox_id = _returned_id(
                            connection.execute(
                                """
                                insert into app.mail_outbox (
                                  account_id, invitation_token_id,
                                  message_category, delivery_status, created_at
                                ) values (%s, %s, 'account_invitation', 'pending', %s)
                                returning id
                                """,
                                (account_id, token_id, created_at),
                            ).fetchall()
                        )
                        invitation_delivery = InvitationDelivery(
                            outbox_id=outbox_id,
                            invitation_token_id=token_id,
                            account_id=account_id,
                            recipient=contact_email,
                            username=username_display,
                            raw_token=invitation.raw,
                            expires_at=invitation_expires_at,
                        )
                    connection.execute(
                        """
                        insert into app.security_audit_events (
                          actor_account_id, target_account_id, event_category,
                          outcome, reason_code, request_ref, occurred_at, metadata
                        ) values (%s, %s, 'account_management', 'success',
                                  'account_created_pending_invitation', %s, %s,
                                  '{}'::jsonb)
                        """,
                        (actor_account_id, account_id, request_ref, created_at),
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
            invitation_delivery=invitation_delivery,
        )


def _positive_id(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("Managed account reference is invalid.")
    return value


def _aware_utc(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValueError("Managed account timestamp is invalid.")
    return value.astimezone(timezone.utc)


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
