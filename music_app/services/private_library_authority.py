"""Locked current-library authority shared by private selection consumers."""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone

from music_app.services.admin_authority import lock_admin_accounts
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session, RecentAuthenticationRequired
from music_app.services.current_actor import ActorState, CapabilityGrant, LibraryRelationship
from music_app.services.policy import PolicyContext
from music_app.services.policy_evaluator import PolicyEvaluator, PolicyEvaluationConstraints
from music_app.services.postgres_connections import pooled_connection


class PrivateLibraryAuthorityError(PermissionError):
    pass


def require_private_action(context, action, *, resource=None, constraints=None):
    target=replace(context,action=action,resource=resource)
    effective=constraints(target) if callable(constraints) else constraints
    if effective is not None and not isinstance(effective,PolicyEvaluationConstraints):
        raise RuntimeError('Private library policy constraints are invalid.')
    if not PolicyEvaluator().evaluate(target,constraints=effective).decision.allowed:
        raise PrivateLibraryAuthorityError('Private library access is unavailable.')


@contextmanager
def current_library_transaction(database_url,context,*,constraints=None,connect=None,clock=None,target_account_id=None,read_only=False):
    if not isinstance(context,PolicyContext):raise PrivateLibraryAuthorityError('Private library access is unavailable.')
    actor=context.actor
    if (not actor.is_authenticated or any(type(value) is not int or value<=0 for value in
        (actor.account_id,actor.session_id,actor.current_library_id,context.library_id))
        or actor.current_library_id!=context.library_id
        or not any(rel.library_id==context.library_id for rel in actor.library_relationships)
        or target_account_id is not None and (type(target_account_id) is not int or target_account_id<=0)):
        raise PrivateLibraryAuthorityError('Private library access is unavailable.')
    require_private_action(context,'library.browse.read',constraints=constraints)
    clock=clock or (lambda:datetime.now(timezone.utc))
    try:
        with (connect or pooled_connection)(database_url) as connection:
            connection.execute('set transaction isolation level read committed')
            if read_only:
                connection.execute('select id from app.accounts where id=any(%s) order by id for share',
                    (sorted({actor.account_id,target_account_id or actor.account_id}),)).fetchall()
            else:
                lock_admin_accounts(connection,actor.account_id,target_account_id or actor.account_id)
            account=connection.execute('select id,is_active,disabled_at from app.accounts where id=%s',
                (actor.account_id,)).fetchone()
            if account is None or account['is_active'] is not True or account['disabled_at'] is not None:
                raise PrivateLibraryAuthorityError('Private library access is unavailable.')
            now=lock_current_actor_session(connection,actor_account_id=actor.account_id,
                actor_session_id=actor.session_id,clock=clock)
            bootstrap=connection.execute("select account_id from app.bootstrap_owners where account_id=%s and owner_key='local-bootstrap-owner' for share",
                (actor.account_id,)).fetchone()
            membership=connection.execute('''select m.membership_role,l.owner_account_id=%s as is_primary_owner
                from library.library_memberships m join library.libraries l on l.id=m.library_id
                where m.account_id=%s and m.library_id=%s for share of m,l''',
                (actor.account_id,actor.account_id,context.library_id)).fetchone()
            if membership is None:raise PrivateLibraryAuthorityError('Private library access is unavailable.')
            grants=connection.execute('''select capability_key,scope_kind,scope_id from app.capabilities
                where account_id=%s and revoked_at is null order by id for share''',(actor.account_id,)).fetchall()
            live=replace(context,actor=replace(actor,state=ActorState.ACTIVE,is_bootstrap_owner=bootstrap is not None,
                library_relationships=(LibraryRelationship(context.library_id,membership['membership_role'],membership['is_primary_owner']),),
                capability_grants=tuple(CapabilityGrant(row['capability_key'],row['scope_kind'],row['scope_id']) for row in grants)))
            require_private_action(live,'library.browse.read',constraints=constraints)
            yield connection,live,now
    except RecentAuthenticationRequired:
        raise PrivateLibraryAuthorityError('Private library access is unavailable.') from None
