"""Atomic protected mutations for Members & Access."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import re
from typing import Any, Iterator

from music_app.services.admin_authority import (
    ADMIN_LIBRARY_AUTHORITY_SQL, ADMIN_TARGET_PROTECTION_SQL, lock_admin_accounts,
)
from music_app.services.capability_assignments import (
    ASSIGNABLE_CAPABILITY_KEYS, AssignmentConflict, build_assignment, read_assignment, access_revision as assignment_revision,
    store_assignment,
)

try:  # pragma: no cover - exercised with the optional runtime driver.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


_RECENT_AUTH_WINDOW = timedelta(minutes=10)
_FUTURE_SKEW = timedelta(minutes=5)
_REQUEST_REFERENCE = re.compile(r"[A-Za-z0-9._:-]{1,128}")


class RecentAuthenticationRequired(PermissionError):
    pass


class DestructiveConfirmationRequired(ValueError):
    pass


def lock_current_actor_session(connection: Any, *, actor_account_id: int,
                               actor_session_id: object,
                               clock: Callable[[], datetime],
                               require_recent_auth: bool = True) -> datetime:
    """Revalidate the admitted session after its account authority lock."""
    try:
        session_id = _positive_id(actor_session_id)
    except ValueError:
        raise RecentAuthenticationRequired("Recent authentication is required.") from None
    rows = connection.execute(
        """
        select id, account_id, authenticated_at, idle_expires_at,
               absolute_expires_at, revoked_at
        from app.account_sessions
        where id = %s and account_id = %s
        for update
        """, (session_id, actor_account_id),
    ).fetchall()
    now = _aware_utc(clock())
    if len(rows) != 1 or not isinstance(rows[0], Mapping):
        raise RecentAuthenticationRequired("Recent authentication is required.")
    row = rows[0]
    if (row.get("id") != session_id or row.get("account_id") != actor_account_id
            or row.get("revoked_at") is not None
            or _aware_utc(row.get("idle_expires_at")) <= now
            or _aware_utc(row.get("absolute_expires_at")) <= now):
        raise RecentAuthenticationRequired("Recent authentication is required.")
    authenticated = _aware_utc(row.get("authenticated_at"))
    if (authenticated > now + _FUTURE_SKEW
            or (require_recent_auth and now - authenticated > _RECENT_AUTH_WINDOW)):
        raise RecentAuthenticationRequired("Recent authentication is required.")
    return now


class PostgresAdminMemberMutationService:
    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        connect: Callable[[str], Any] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(
            payload.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
        ).strip()
        if not self._database_url:
            raise RuntimeError("Database configuration is required for account management.")
        self._connect = connect or _connect
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def update_account(
        self,
        *,
        actor_account_id: object,
        actor_session_id: object,
        actor_authenticated_at: object,
        library_id: object,
        target_account_id: object,
        is_active: object,
        current_library_access: object,
        capability_keys: Iterable[object],
        confirm_disable: object,
        confirm_remove_access: object,
        request_ref: str,
        role_keys: object = None,
        access_revision: object = None,
    ) -> None:
        actor_id = _positive_id(actor_account_id)
        target_id = _positive_id(target_account_id)
        current_library_id = _positive_id(library_id)
        active = _boolean(is_active)
        access = _boolean(current_library_access)
        disable_confirmed = _boolean(confirm_disable)
        removal_confirmed = _boolean(confirm_remove_access)
        assignment = (build_assignment(role_keys, capability_keys, allow_empty=not access)
                      if role_keys is not None else None)
        capabilities = assignment.effective_keys if assignment is not None else _capabilities(capability_keys, allow_empty=not access)
        reference = _request_ref(request_ref)
        now = self._recent_now(actor_authenticated_at)

        try:
            with self._operation() as connection:
                locked = self._lock_authority_and_target(
                    connection,
                    actor_account_id=actor_id,
                    library_id=current_library_id,
                    target_account_id=target_id,
                )
                now = lock_current_actor_session(connection, actor_account_id=actor_id,
                    actor_session_id=actor_session_id, clock=self._clock)
                if locked.get("target_is_bootstrap_owner") is True:
                    if not active or not access:
                        raise PermissionError("The bootstrap owner is protected.")
                    # Owner capabilities are inherited; saving their displayed
                    # values must not replace the owner membership or grants.
                    return
                current_keys = tuple(locked.get("current_capability_keys") or ())
                previous = read_assignment(locked.get("access_assignment"), current_keys)
                if assignment is not None:
                    expected = assignment_revision(previous, current_keys,
                        active=locked.get("target_is_active") is True,
                        access=locked.get("target_has_library_access") is True)
                    if not isinstance(access_revision, str) or access_revision != expected:
                        raise AssignmentConflict("Access changed. Reload this user before saving again.")
                elif previous.role_keys:
                    raise AssignmentConflict("This user has assigned roles. Reload before changing permissions.")
                if actor_id == target_id and (not active or not access or "capability.admin" not in capabilities):
                    raise PermissionError("Keep Admin and library access on your own account.")
                if locked.get("target_is_active") is True and not active and not disable_confirmed:
                    raise DestructiveConfirmationRequired("Account disable confirmation is required.")
                if (
                    locked.get("target_has_library_access") is True
                    and not access
                    and not removal_confirmed
                ):
                    raise DestructiveConfirmationRequired("Library removal confirmation is required.")
                connection.execute(
                    """
                    update app.accounts
                    set is_active = %s,
                        disabled_at = case when %s then null else %s end,
                        disabled_reason = case when %s then null else 'administrator_disabled' end,
                        updated_at = %s
                    where id = %s
                    """,
                    (active, active, now, active, now, target_id),
                )
                if access:
                    connection.execute(
                        """
                        insert into library.library_memberships (
                          library_id, account_id, membership_role, updated_at
                        ) values (%s, %s, 'member', %s)
                        on conflict (library_id, account_id) do update
                        set membership_role = excluded.membership_role,
                            updated_at = excluded.updated_at
                        """,
                        (current_library_id, target_id, now),
                    )
                else:
                    connection.execute(
                        """
                        delete from library.library_memberships
                        where library_id = %s and account_id = %s
                        """,
                        (current_library_id, target_id),
                    )
                connection.execute(
                    """
                    update app.capabilities set revoked_at = %s
                    where account_id = %s and scope_kind = 'library'
                      and scope_id = %s and revoked_at is null
                      and (%s or capability_key = any(%s))
                    """,
                    (now, target_id, current_library_id, not access, sorted(ASSIGNABLE_CAPABILITY_KEYS)),
                )
                if access:
                    for capability_key in capabilities:
                        connection.execute(
                            """
                            insert into app.capabilities (
                              account_id, capability_key, scope_kind, scope_id,
                              granted_at, revoked_at
                            ) values (%s, %s, 'library', %s, %s, null)
                            """,
                            (target_id, capability_key, current_library_id, now),
                        )
                if assignment is not None:
                    store_assignment(connection, account_id=target_id, library_id=current_library_id,
                        assignment=assignment if access else build_assignment((), (), allow_empty=True))
                if not active:
                    connection.execute(
                        """
                        update app.account_sessions
                        set revoked_at = %s,
                            revocation_reason = 'administrator_disabled'
                        where account_id = %s and revoked_at is null
                        """,
                        (now, target_id),
                    )
                    connection.execute(
                        """
                        update app.account_invitation_tokens
                        set revoked_at = %s
                        where account_id = %s
                          and consumed_at is null
                          and revoked_at is null
                        """,
                        (now, target_id),
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
                        (now, target_id),
                    )
                connection.execute(
                    """
                    insert into app.security_audit_events (
                      actor_account_id, target_account_id, event_category,
                      outcome, reason_code, request_ref, occurred_at, metadata
                    ) values (%s, %s, 'account_management', 'success',
                              'account_updated', %s, %s,
                              jsonb_build_object(
                                'is_active', %s,
                                'current_library_access', %s,
                                'capability_count', %s
                              ))
                    """,
                    (
                        actor_id,
                        target_id,
                        reference,
                        now,
                        active,
                        access,
                        len(capabilities) if access else 0,
                    ),
                )
        except (PermissionError, ValueError):
            raise
        except Exception:
            raise RuntimeError("Account management persistence failed.") from None

    def revoke_sessions(
        self,
        *,
        actor_account_id: object,
        actor_session_id: object,
        actor_authenticated_at: object,
        library_id: object,
        target_account_id: object,
        confirmed: object,
        request_ref: object,
    ) -> None:
        actor_id = _positive_id(actor_account_id)
        target_id = _positive_id(target_account_id)
        current_library_id = _positive_id(library_id)
        if not _boolean(confirmed):
            raise DestructiveConfirmationRequired("Session revocation confirmation is required.")
        reference = _request_ref(request_ref)
        now = self._recent_now(actor_authenticated_at)
        try:
            with self._operation() as connection:
                self._lock_authority_and_target(
                    connection,
                    actor_account_id=actor_id,
                    library_id=current_library_id,
                    target_account_id=target_id,
                )
                now = lock_current_actor_session(connection, actor_account_id=actor_id,
                    actor_session_id=actor_session_id, clock=self._clock)
                connection.execute(
                    """
                    update app.account_sessions
                    set revoked_at = %s,
                        revocation_reason = 'administrator_revoked'
                    where account_id = %s and revoked_at is null
                    """,
                    (now, target_id),
                )
                connection.execute(
                    """
                    insert into app.security_audit_events (
                      actor_account_id, target_account_id, event_category,
                      outcome, reason_code, request_ref, occurred_at, metadata
                    ) values (%s, %s, 'session', 'success',
                              'sessions_revoked', %s, %s, '{}'::jsonb)
                    """,
                    (actor_id, target_id, reference, now),
                )
        except (PermissionError, ValueError):
            raise
        except Exception:
            raise RuntimeError("Session revocation persistence failed.") from None

    def _recent_now(self, authenticated_at: object) -> datetime:
        now = _aware_utc(self._clock())
        authenticated = _aware_utc(authenticated_at)
        if authenticated > now + _FUTURE_SKEW or now - authenticated > _RECENT_AUTH_WINDOW:
            raise RecentAuthenticationRequired("Recent authentication is required.")
        return now

    @staticmethod
    def _lock_authority_and_target(
        connection: Any,
        *,
        actor_account_id: int,
        library_id: int,
        target_account_id: int,
    ) -> Mapping[str, object]:
        lock_admin_accounts(connection, actor_account_id, target_account_id)
        rows = connection.execute(
            f"""
            with locked_accounts as (
              select id, account_kind, is_active, disabled_at, metadata
              from app.accounts
              where id in (%s, %s)
              order by id for update
            ), locked_library as (
              select id, owner_account_id from library.libraries
              where id = %s for update
            )
            select actor.id as actor_account_id,
                   locked_library.id as library_id,
                   target.id as target_account_id,
                   (target.is_active is true and target.disabled_at is null) as target_is_active,
                   target.metadata -> 'library_access_assignments_v1'
                     -> locked_library.id::text as access_assignment,
                   coalesce((select array_agg(capability_key order by capability_key)
                     from app.capabilities where account_id = target.id
                     and scope_kind = 'library' and scope_id = locked_library.id
                     and revoked_at is null), array[]::text[]) as current_capability_keys,
                   exists (
                     select 1 from app.bootstrap_owners
                     where account_id = target.id
                       and owner_key = 'local-bootstrap-owner'
                   ) as target_is_bootstrap_owner,
                   exists (
                     select 1 from library.library_memberships
                     where library_id = locked_library.id
                       and account_id = target.id
                   ) as target_has_library_access
            from locked_accounts actor
            join locked_library on true
            join locked_accounts target on target.id = %s
            where actor.id = %s and actor.is_active is true
              and actor.disabled_at is null
              and {ADMIN_LIBRARY_AUTHORITY_SQL}
              and {ADMIN_TARGET_PROTECTION_SQL}
              and target.account_kind in ('bootstrap_owner', 'managed_user')
              and (
                target.id = locked_library.owner_account_id
                or exists (
                  select 1 from library.library_memberships scoped_membership
                  where scoped_membership.library_id = locked_library.id
                    and scoped_membership.account_id = target.id
                )
                or exists (
                  select 1 from app.capabilities prior_access
                  where prior_access.account_id = target.id
                    and prior_access.scope_kind = 'library'
                    and prior_access.scope_id = locked_library.id
                )
              )
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
            raise PermissionError("Account management is not permitted.")
        return rows[0]

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
        raise ValueError("Account management reference is invalid.")
    return value


def _boolean(value: object) -> bool:
    if not isinstance(value, bool):
        raise ValueError("Account management flag is invalid.")
    return value


def _capabilities(values: Iterable[object], *, allow_empty: bool = False) -> tuple[str, ...]:
    try:
        received = tuple(values)
    except TypeError:
        raise ValueError("Account management capabilities are invalid.") from None
    if (
        (not received and not allow_empty)
        or any(not isinstance(item, str) for item in received)
        or len(set(received)) != len(received)
        or any(item not in ASSIGNABLE_CAPABILITY_KEYS for item in received)
    ):
        raise ValueError("Account management capabilities are invalid.")
    return tuple(sorted(received))


def _request_ref(value: object) -> str:
    if not isinstance(value, str) or _REQUEST_REFERENCE.fullmatch(value) is None:
        raise ValueError("Account management request reference is invalid.")
    return value


def _aware_utc(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RecentAuthenticationRequired("Recent authentication is required.")
    return value.astimezone(timezone.utc)


def _connect(database_url: str):
    if psycopg is None:
        raise RuntimeError("psycopg is required for account management.")
    return psycopg.connect(database_url, row_factory=dict_row)
