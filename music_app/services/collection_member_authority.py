"""Current same-library member authority for collection collaboration checks.

This projects eligibility only. The caller still owns its resource policy and
must not treat the projected actor as an authenticated requester session.
"""
from dataclasses import replace

from music_app.services.current_actor import ActorState, CapabilityGrant, LibraryRelationship


def collection_member_context(connection, context, account_id, *, lock=False):
    row = connection.execute('''select a.is_active,a.disabled_at,m.membership_role,
        l.owner_account_id=a.id as is_primary_owner,
        exists(select 1 from app.bootstrap_owners b where b.account_id=a.id
            and b.owner_key='local-bootstrap-owner') as is_bootstrap_owner
        from app.accounts a join library.library_memberships m on m.account_id=a.id
        join library.libraries l on l.id=m.library_id
        where a.id=%s and m.library_id=%s''' + (' for share of a,m' if lock else ''), (account_id,context.library_id)).fetchone()
    if row is None or not row['is_active'] or row['disabled_at'] is not None:
        return None
    grants = connection.execute('''select capability_key,scope_kind,scope_id from app.capabilities
        where account_id=%s and revoked_at is null order by id''' + (' for share' if lock else ''),(account_id,)).fetchall()
    actor = replace(context.actor,account_id=account_id,state=ActorState.ACTIVE,is_bootstrap_owner=row['is_bootstrap_owner'],
        library_relationships=(LibraryRelationship(context.library_id,row['membership_role'],row['is_primary_owner']),),
        capability_grants=tuple(CapabilityGrant(g['capability_key'],g['scope_kind'],g['scope_id']) for g in grants))
    return replace(context,actor=actor)
