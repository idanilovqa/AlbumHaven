"""Atomic Postgres persistence for administrator-created managed accounts."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from typing import Any

from music_app.services.admin_account_creation import CreatedAccount
from music_app.services.auth_mail_jobs_postgres import PostgresAuthMailJobRepository

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
        job_repository: Any | None = None,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(
            payload.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
        ).strip()
        if not self._database_url:
            raise RuntimeError("Database configuration is required for account creation.")
        self._connect = connect or _connect
        self._jobs = job_repository or PostgresAuthMailJobRepository(
            database_url=self._database_url,
            connect_to_database=self._connect,
        )

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
        send_invitation: bool,
        invitation_expires_at: datetime | None,
        created_at: datetime,
        request_ref: str,
        request_origin_ref: str | None = None,
        deployment_mode: str = "self_hosted",
        client_surface: str = "private_web",
    ) -> CreatedAccount:
        _positive_id(actor_account_id)
        _positive_id(library_id)
        created_at = _aware_utc(created_at)
        if not isinstance(send_invitation, bool):
            raise ValueError("Managed account invitation choice is invalid.")
        if not send_invitation and invitation_expires_at is not None:
            raise ValueError("Managed account invitation expiry is invalid.")
        if send_invitation:
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
                    invitation_queued = False
                    if send_invitation:
                        outbox_id = _returned_id(
                            connection.execute(
                                """
                                insert into app.mail_outbox (
                                  account_id, message_category, delivery_status,
                                  attempt_count, next_attempt_at, row_revision,
                                  accepted_attempt, actor_account_id,
                                  authorization_mode, delivery_checkpoint,
                                  lifecycle_expires_at, created_at, updated_at
                                ) values (
                                  %s, 'account_invitation', 'pending', 0, %s,
                                  0, 1, %s, 'actor', 'accepted', %s, %s, %s
                                )
                                returning id
                                """,
                                (
                                    account_id, created_at, actor_account_id,
                                    invitation_expires_at, created_at, created_at,
                                ),
                            ).fetchall()
                        )
                        self._jobs.compose_existing_intent_in_transaction(
                            connection, outbox_id=outbox_id,
                            category="account_invitation", account_id=account_id,
                            actor_account_id=actor_account_id,
                            library_id=library_id,
                            request_origin_ref=request_origin_ref,
                            deployment_mode=deployment_mode,
                            client_surface=client_surface,
                            scheduled_at=created_at,
                        )
                        invitation_queued = True
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
            invitation_queued=invitation_queued,
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
