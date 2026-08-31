"""Request-scoped actor resolution from durable session and policy state."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from music_app.services.auth_sessions_postgres import (
    PostgresAuthSessionService,
    ResolvedBrowserSession,
)
from music_app.services.current_actor import (
    ActorState,
    CapabilityGrant,
    CurrentActor,
    LibraryRelationship,
)

try:  # pragma: no cover - exercised when the optional driver is installed.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - keeps non-Postgres tooling importable.
    psycopg = None
    dict_row = None


_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"


class PostgresCurrentActorResolver:
    """Resolve one safe actor snapshot after the session authority succeeds."""

    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        session_service: Any | None = None,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(payload.get(_DATABASE_URL_KEY) or "").strip()
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for actor resolution."
            )
        self._sessions = (
            session_service
            if session_service is not None
            else PostgresAuthSessionService(payload)
        )
        self._connect = connect or _connect

    def resolve(self, raw_session_token: object) -> CurrentActor:
        session = self._sessions.resolve_session(raw_session_token)
        if session is None:
            return CurrentActor.anonymous()
        if not isinstance(session, ResolvedBrowserSession):
            raise RuntimeError("Current actor session context is invalid.")

        with self._connect(self._database_url) as connection:
            rows = connection.execute(
                """
                select app.accounts.id as account_id,
                       app.accounts.username_display,
                       app.accounts.display_name,
                       app.accounts.is_active,
                       app.accounts.disabled_at,
                       exists (
                         select 1
                         from app.bootstrap_owners
                         where app.bootstrap_owners.account_id = app.accounts.id
                       ) as is_bootstrap_owner,
                       (
                         select library.libraries.id
                         from app.bootstrap_owners as runtime_owner
                         join library.libraries
                           on library.libraries.owner_account_id = runtime_owner.account_id
                         where runtime_owner.owner_key = 'local-bootstrap-owner'
                         order by library.libraries.id
                         limit 1
                       ) as current_library_id,
                       coalesce((
                         select jsonb_agg(
                           jsonb_build_object(
                             'library_id', library.library_memberships.library_id,
                             'membership_role', library.library_memberships.membership_role,
                             'is_primary_owner',
                               library.libraries.owner_account_id = app.accounts.id
                           ) order by library.library_memberships.library_id
                         )
                         from library.library_memberships
                         join library.libraries
                           on library.libraries.id =
                              library.library_memberships.library_id
                         where library.library_memberships.account_id = app.accounts.id
                       ), '[]'::jsonb) as library_relationships,
                       coalesce((
                         select jsonb_agg(
                           jsonb_build_object(
                             'capability_key', app.capabilities.capability_key,
                             'scope_kind', app.capabilities.scope_kind,
                             'scope_id', app.capabilities.scope_id
                           ) order by app.capabilities.capability_key,
                                      app.capabilities.scope_kind,
                                      app.capabilities.scope_id nulls first
                         )
                         from app.capabilities
                         where app.capabilities.account_id = app.accounts.id
                           and app.capabilities.revoked_at is null
                       ), '[]'::jsonb) as capability_grants
                from app.accounts
                where app.accounts.id = %s
                """,
                (session.account_id,),
            ).fetchall()
        if len(rows) != 1:
            raise RuntimeError("Current actor context is invalid.")
        payload = _mapping(rows[0])
        account_id = _positive_integer(payload.get("account_id"), "account id")
        if account_id != session.account_id:
            raise RuntimeError("Current actor context is invalid.")
        if payload.get("is_active") is not True or payload.get("disabled_at") is not None:
            return CurrentActor(
                state=ActorState.INACTIVE,
                account_id=account_id,
                session_id=session.session_id,
                username_display=_required_text(
                    payload.get("username_display"), "username"
                ),
                display_name=_required_text(payload.get("display_name"), "display name"),
                authenticated_at=session.authenticated_at,
            )
        relationships = _library_relationships(payload.get("library_relationships"))
        current_library_id = _positive_integer(
            payload.get("current_library_id"), "current library id"
        )
        if not any(
            item.library_id == current_library_id for item in relationships
        ):
            raise RuntimeError("Current actor current library context is invalid.")
        return CurrentActor(
            state=ActorState.ACTIVE,
            account_id=account_id,
            session_id=session.session_id,
            username_display=_required_text(payload.get("username_display"), "username"),
            display_name=_required_text(payload.get("display_name"), "display name"),
            authenticated_at=session.authenticated_at,
            is_bootstrap_owner=payload.get("is_bootstrap_owner") is True,
            current_library_id=current_library_id,
            library_relationships=relationships,
            capability_grants=_capability_grants(payload.get("capability_grants")),
        )


def _library_relationships(value: object) -> tuple[LibraryRelationship, ...]:
    if not isinstance(value, list):
        raise RuntimeError("Current actor library context is invalid.")
    relationships = []
    for item in value:
        row = _mapping(item)
        primary = row.get("is_primary_owner")
        if not isinstance(primary, bool):
            raise RuntimeError("Current actor library context is invalid.")
        relationships.append(
            LibraryRelationship(
                library_id=_positive_integer(row.get("library_id"), "library id"),
                membership_role=_required_text(row.get("membership_role"), "role"),
                is_primary_owner=primary,
            )
        )
    return tuple(sorted(relationships, key=lambda item: item.library_id))


def _capability_grants(value: object) -> tuple[CapabilityGrant, ...]:
    if not isinstance(value, list):
        raise RuntimeError("Current actor capability context is invalid.")
    grants = []
    for item in value:
        row = _mapping(item)
        scope_value = row.get("scope_id")
        grants.append(
            CapabilityGrant(
                capability_key=_required_text(
                    row.get("capability_key"), "capability key"
                ),
                scope_kind=_required_text(row.get("scope_kind"), "scope kind"),
                scope_id=(
                    None
                    if scope_value is None
                    else _positive_integer(scope_value, "scope id")
                ),
            )
        )
    return tuple(
        sorted(
            grants,
            key=lambda item: (
                item.capability_key,
                item.scope_kind,
                item.scope_id is not None,
                item.scope_id or 0,
            ),
        )
    )


def _mapping(value: object) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise RuntimeError("Current actor context is invalid.")
    return value


def _positive_integer(value: object, field: str) -> int:
    if isinstance(value, bool):
        raise RuntimeError(f"Current actor {field} is invalid.")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise RuntimeError(f"Current actor {field} is invalid.") from None
    if parsed < 1:
        raise RuntimeError(f"Current actor {field} is invalid.")
    return parsed


def _required_text(value: object, field: str) -> str:
    text = str(value or "").strip()
    if not text or "\r" in text or "\n" in text:
        raise RuntimeError(f"Current actor {field} is invalid.")
    return text


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for actor resolution.")
    return psycopg.connect(database_url, row_factory=dict_row)
