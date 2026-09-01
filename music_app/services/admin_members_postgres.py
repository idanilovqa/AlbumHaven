"""Protected Members & Access read model backed by the current Postgres library."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterator

try:  # pragma: no cover - exercised when the optional runtime driver is present.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


@dataclass(frozen=True, slots=True)
class AdminMemberSummary:
    account_id: int
    username: str
    contact_email: str
    is_active: bool
    is_bootstrap_owner: bool
    membership_role: str | None
    capability_keys: tuple[str, ...]
    welcome_status: str | None
    active_session_count: int
    last_active_at: datetime | None
    has_credential: bool
    account_status: str
    invitation_delivery_status: str | None


@dataclass(frozen=True, slots=True)
class AdminMembersRoster:
    library_id: int
    library_name: str
    members: tuple[AdminMemberSummary, ...]


class PostgresAdminMembersService:
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
            raise RuntimeError("Database configuration is required for Members & Access.")
        self._connect = connect or _connect
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def load_roster(
        self,
        *,
        actor_account_id: object,
        library_id: object,
    ) -> AdminMembersRoster:
        actor_id = _positive_id(actor_account_id)
        current_library_id = _positive_id(library_id)
        now = _aware_utc(self._clock())
        try:
            with self._operation() as connection:
                rows = connection.execute(
                    """
                    with authority as (
                      select library.libraries.id as library_id,
                             library.libraries.name as library_name
                      from app.bootstrap_owners
                      join app.accounts actor
                        on actor.id = app.bootstrap_owners.account_id
                       and actor.is_active is true and actor.disabled_at is null
                      join library.libraries
                        on library.libraries.id = %s
                       and library.libraries.owner_account_id = actor.id
                      where app.bootstrap_owners.account_id = %s
                        and app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
                    )
                    select authority.library_id, authority.library_name,
                           account.id as account_id,
                           account.username_display, account.contact_email,
                           account.is_active, account.disabled_at,
                           (owner.account_id is not null) as is_bootstrap_owner,
                           membership.membership_role,
                           coalesce(capability.capability_keys, array[]::text[])
                             as capability_keys,
                           welcome.delivery_status as welcome_status,
                           (credential.account_id is not null) as has_credential,
                           invitation_delivery.delivery_status
                             as invitation_delivery_status,
                           coalesce(session.active_session_count, 0)
                             as active_session_count,
                           session.last_active_at
                    from authority
                    join app.accounts account
                      on account.account_kind in ('bootstrap_owner', 'managed_user')
                    left join app.bootstrap_owners owner
                      on owner.account_id = account.id
                     and owner.owner_key = 'local-bootstrap-owner'
                    left join app.account_credentials credential
                      on credential.account_id = account.id
                    left join library.library_memberships membership
                      on membership.account_id = account.id
                     and membership.library_id = authority.library_id
                    left join lateral (
                      select array_agg(capability_key order by capability_key)
                               as capability_keys
                      from app.capabilities
                      where account_id = account.id and revoked_at is null
                        and scope_kind = 'library'
                        and scope_id = authority.library_id
                    ) capability on true
                    left join lateral (
                      select delivery_status
                      from app.mail_outbox
                      where account_id = account.id and message_category = 'welcome'
                      order by created_at desc, id desc limit 1
                    ) welcome on true
                    left join lateral (
                      select delivery_status
                      from app.mail_outbox
                      where account_id = account.id
                        and message_category = 'account_invitation'
                      order by created_at desc, id desc limit 1
                    ) invitation_delivery on true
                    left join lateral (
                      select count(*)::integer as active_session_count,
                             max(last_seen_at) as last_active_at
                      from app.account_sessions
                      where account_id = account.id and revoked_at is null
                        and idle_expires_at > %s and absolute_expires_at > %s
                    ) session on true
                    order by (owner.account_id is not null) desc,
                             account.username_normalized, account.id
                    """,
                    (current_library_id, actor_id, now, now),
                ).fetchall()
            if not rows:
                raise PermissionError("Members & Access is not permitted.")
            parsed = tuple(_member(row) for row in rows)
            first = _row(rows[0])
            roster_library_id = _positive_id(first.get("library_id"))
            if roster_library_id != current_library_id:
                raise RuntimeError
            return AdminMembersRoster(
                library_id=roster_library_id,
                library_name=_required_text(first.get("library_name"), "library name"),
                members=parsed,
            )
        except PermissionError:
            raise
        except Exception:
            raise RuntimeError("Members & Access persistence failed.") from None

    @contextmanager
    def _operation(self) -> Iterator[Any]:
        with self._connect(self._database_url) as connection:
            transaction = getattr(connection, "transaction", None)
            if not callable(transaction):
                raise RuntimeError
            with transaction():
                yield connection


def _member(value: object) -> AdminMemberSummary:
    row = _row(value)
    capabilities = row.get("capability_keys")
    if not isinstance(capabilities, (list, tuple)) or any(
        not isinstance(item, str) or not item for item in capabilities
    ):
        raise RuntimeError
    active_count = row.get("active_session_count")
    if isinstance(active_count, bool) or not isinstance(active_count, int) or active_count < 0:
        raise RuntimeError
    is_active = row.get("is_active") is True and row.get("disabled_at") is None
    has_credential = row.get("has_credential") is True
    return AdminMemberSummary(
        account_id=_positive_id(row.get("account_id")),
        username=_required_text(row.get("username_display"), "username"),
        contact_email=_required_text(row.get("contact_email"), "contact email"),
        is_active=is_active,
        is_bootstrap_owner=row.get("is_bootstrap_owner") is True,
        membership_role=_optional_text(row.get("membership_role")),
        capability_keys=tuple(sorted(set(capabilities))),
        welcome_status=_optional_text(row.get("welcome_status")),
        active_session_count=active_count,
        last_active_at=_optional_datetime(row.get("last_active_at")),
        has_credential=has_credential,
        account_status=_account_status(
            is_active=is_active, has_credential=has_credential
        ),
        invitation_delivery_status=_optional_text(
            row.get("invitation_delivery_status")
        ),
    )


def _account_status(*, is_active: bool, has_credential: bool) -> str:
    if not is_active:
        return "Disabled"
    return "Enabled" if has_credential else "Pending invitation"


def _row(value: object) -> Mapping[str, object]:
    return value if isinstance(value, Mapping) else {}


def _positive_id(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("Members & Access reference is invalid.")
    return value


def _required_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value or "\r" in value or "\n" in value:
        raise RuntimeError(f"Members & Access {field} is invalid.")
    return value


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value or "\r" in value or "\n" in value:
        raise RuntimeError
    return value


def _aware_utc(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RuntimeError
    return value.astimezone(timezone.utc)


def _optional_datetime(value: object) -> datetime | None:
    return None if value is None else _aware_utc(value)


def _connect(database_url: str):
    if psycopg is None:
        raise RuntimeError("psycopg is required for Members & Access.")
    return psycopg.connect(database_url, row_factory=dict_row)
