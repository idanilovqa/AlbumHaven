"""Shared administrator authority for the existing managed-account services."""
from __future__ import annotations

from music_app.services.current_actor import CapabilityGrant, CurrentActor

# Fixed SQL aliases, never request input. Callers check active actor state and
# acquire account locks before evaluating this predicate for a mutation.
# Named Owner is deliberately not an alternative to capability.admin.
ADMIN_LIBRARY_AUTHORITY_SQL = """
(
  exists (
    select 1 from app.bootstrap_owners bootstrap_authority
    where bootstrap_authority.account_id = actor.id
      and bootstrap_authority.owner_key = 'local-bootstrap-owner'
      and locked_library.owner_account_id = actor.id
  )
  or (
    exists (
      select 1 from library.library_memberships admin_membership
      where admin_membership.account_id = actor.id
        and admin_membership.library_id = locked_library.id
    )
    and exists (
      select 1 from app.capabilities admin_grant
      where admin_grant.account_id = actor.id
        and admin_grant.capability_key = 'capability.admin'
        and admin_grant.revoked_at is null
        and ((admin_grant.scope_kind = 'library' and admin_grant.scope_id = locked_library.id)
          or (admin_grant.scope_kind = 'global' and admin_grant.scope_id is null))
    )
  )
)
"""

# Delegated administrators cannot modify/recover/revoke the protected account.
ADMIN_TARGET_PROTECTION_SQL = """
(
  not exists (select 1 from app.bootstrap_owners protected_target
              where protected_target.account_id = target.id)
  or exists (select 1 from app.bootstrap_owners protected_actor
             where protected_actor.account_id = actor.id
               and protected_actor.owner_key = 'local-bootstrap-owner')
)
"""


def is_library_administrator(actor: CurrentActor, library_id: int) -> bool:
    if not actor.is_authenticated or not any(
        relationship.library_id == library_id for relationship in actor.library_relationships
    ):
        return False
    return actor.is_bootstrap_owner or any(
        isinstance(grant, CapabilityGrant) and grant.capability_key == "capability.admin"
        and ((grant.scope_kind == "library" and grant.scope_id == library_id)
             or (grant.scope_kind == "global" and grant.scope_id is None))
        for grant in actor.capability_grants
    )


def lock_admin_accounts(connection, actor_account_id: int, target_account_id: int) -> None:
    # Complete any wait before starting the statement that checks live grants.
    # All managed-account capability writes use these same ordered row locks.
    connection.execute(
        """
        with locked_accounts as (
          select id from app.accounts where id in (%s, %s) order by id for update
        ) select id from locked_accounts
        """, (actor_account_id, target_account_id),
    ).fetchall()
