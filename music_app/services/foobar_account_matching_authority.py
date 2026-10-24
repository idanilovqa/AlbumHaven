"""Account transaction and separately locked optional local matching authority.

Uses the existing native account/session authority, not a supplied trusted flag.
Account-self alone never authorizes inventory or taste. Only the separate
matching-context function rebuilds actual current local authority.
"""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone

from .admin_member_mutation_postgres import lock_current_actor_session, RecentAuthenticationRequired
from .current_actor import CurrentActor, ActorState, CapabilityGrant, LibraryRelationship
from .policy import PolicyContext
from .policy_evaluator import PolicyEvaluator, PolicyEvaluationConstraints
from .postgres_connections import pooled_connection
from .foobar_source_postgres import SourceUnavailable, SourceStale
from .track_preferences_postgres import _foobar_taste_connection

_MAX = 9223372036854775807


def account_foobar_context(context):
    if (type(context) is not PolicyContext or type(context.actor) is not CurrentActor
            or context.actor.state is not ActorState.ACTIVE
            or any(type(v) is not int or not 1 <= v <= _MAX
                   for v in (context.actor.account_id, context.actor.session_id))
            or context.target_account_id is not None and (
                type(context.target_account_id) is not int
                or context.target_account_id != context.actor.account_id)):
        raise SourceStale()
    # Drop stale ambient library/admin authority rather than treating it as an
    # account grant. This resulting context cannot authorize local side effects.
    return replace(context, action='account.self.foobar.write', resource=None,
                   target_account_id=context.actor.account_id, library_id=None,
                   actor=replace(context.actor, current_library_id=None,
                                 library_relationships=(), capability_grants=(),
                                 is_bootstrap_owner=False))


def require_account_foobar(context, constraints=None):
    target = account_foobar_context(context)
    try:
        effective = constraints(target) if callable(constraints) else constraints
        if effective is not None and type(effective) is not PolicyEvaluationConstraints:
            raise SourceUnavailable()
        allowed = PolicyEvaluator().evaluate(target, constraints=effective).decision.allowed
        if type(allowed) is not bool:
            raise SourceUnavailable()
    except Exception:
        # Resolver-thrown permission-shaped exceptions are operational failures,
        # not a policy decision and never a reason to grant access.
        raise SourceUnavailable() from None
    if not allowed:
        raise SourceStale()
    return target


@contextmanager
def current_foobar_import_transaction(database_url, context, *, matching_library_id, constraints=None):
    """Lock authenticated account then native session; commit only on context exit.

    No library requirement, account mapping, RLS, hosted durability or new route.
    Database URL and context are resolved by the future server-owned call site.
    """
    if matching_library_id is not None and (type(matching_library_id) is not int or not 1 <= matching_library_id <= _MAX):
        raise SourceUnavailable()
    live = require_account_foobar(context, constraints)
    clock = lambda: datetime.now(timezone.utc)
    try:
        with pooled_connection(database_url) as connection:
            connection.execute('set transaction isolation level read committed')
            _foobar_taste_connection(connection)
            connection.execute("set local lock_timeout = '250ms'")
            connection.execute("set local statement_timeout = '1000ms'")
            if matching_library_id is not None:
                # Same publication-before-account lock order as native inventory owners.
                # This lock reveals no library data and grants no library authority.
                connection.execute("select pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'))")
            cursor = connection.execute(
                'select id,is_active,disabled_at from app.accounts where id=%s for update',
                (live.actor.account_id,))
            try:
                rows = cursor.fetchmany(2)
            finally:
                cursor.close()
            if (type(rows) is not list or len(rows) != 1 or type(rows[0]) is not dict
                    or set(rows[0]) != {'id', 'is_active', 'disabled_at'}
                    or type(rows[0]['id']) is not int or rows[0]['id'] != live.actor.account_id
                    or rows[0]['is_active'] is not True or rows[0]['disabled_at'] is not None):
                raise SourceStale()
            now = lock_current_actor_session(connection,
                actor_account_id=live.actor.account_id, actor_session_id=live.actor.session_id,
                clock=clock)
            live = require_account_foobar(live, constraints)
            yield connection, live, now
            # The same locked session must still be unexpired before commit.
            lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id, clock=clock)
            require_account_foobar(live, constraints)
    except RecentAuthenticationRequired:
        raise SourceStale() from None


def _read_rows(connection, sql, parameters, maximum):
    cursor = connection.execute(sql, parameters)
    try:
        rows = cursor.fetchmany(maximum+1)
        if type(rows) is not list or len(rows) > maximum:
            raise SourceUnavailable()
        return rows
    finally:
        cursor.close()


def lock_foobar_matching_context(connection, account_live, request_context,
                                 matching_library_id, *, constraints=None):
    """Attach actual current native authority only after the account/source lock.

    Original matching ID is command data, not a grant. A committed replay never
    calls this function. Request context comes from the authenticated boundary;
    current membership/bootstrap/grants are rebuilt on this same connection.
    """
    _foobar_taste_connection(connection)
    account = require_account_foobar(account_live, constraints)
    requested = account_foobar_context(request_context)
    if (requested.actor.account_id, requested.actor.session_id) != (
            account.actor.account_id, account.actor.session_id):
        raise SourceStale()
    if matching_library_id is None:
        # Explicit no-library command stays no-library, regardless of ambient UI.
        return account
    if (type(matching_library_id) is not int or not 1 <= matching_library_id <= _MAX
            or type(request_context.library_id) is not int
            or request_context.library_id != matching_library_id
            or type(request_context.actor.current_library_id) is not int
            or request_context.actor.current_library_id != matching_library_id):
        raise SourceStale()
    bootstrap = _read_rows(connection,
        "select account_id from app.bootstrap_owners where account_id=%s and owner_key='local-bootstrap-owner' for share",
        (account.actor.account_id,), 1)
    membership = _read_rows(connection, '''select m.membership_role,l.owner_account_id=%s as is_primary_owner
        from library.library_memberships m join library.libraries l on l.id=m.library_id
        where m.account_id=%s and m.library_id=%s for share of m,l''',
        (account.actor.account_id,account.actor.account_id,matching_library_id), 1)
    if not membership:
        raise SourceStale()
    row = membership[0]
    if (type(row) is not dict or set(row) != {'membership_role','is_primary_owner'}
            or type(row['membership_role']) is not str or not 1 <= len(row['membership_role']) <= 128
            or type(row['is_primary_owner']) is not bool
            or bootstrap and (type(bootstrap[0]) is not dict
                or bootstrap[0] != {'account_id':account.actor.account_id})):
        raise SourceUnavailable()
    grants = _read_rows(connection, '''select capability_key,scope_kind,scope_id from app.capabilities
        where account_id=%s and revoked_at is null order by id for share''',
        (account.actor.account_id,), 5000)
    for grant in grants:
        if (type(grant) is not dict or set(grant) != {'capability_key','scope_kind','scope_id'}
                or type(grant['capability_key']) is not str or not 1 <= len(grant['capability_key']) <= 128
                or grant['scope_kind'] not in ('global','account','library')
                or (grant['scope_id'] is not None if grant['scope_kind']=='global' else
                    type(grant['scope_id']) is not int or not 1 <= grant['scope_id'] <= _MAX)):
            raise SourceUnavailable()
    live = replace(account, library_id=matching_library_id,
        actor=replace(account.actor,current_library_id=matching_library_id,
            is_bootstrap_owner=bool(bootstrap),
            library_relationships=(LibraryRelationship(matching_library_id,row['membership_role'],row['is_primary_owner']),),
            capability_grants=tuple(CapabilityGrant(g['capability_key'],g['scope_kind'],g['scope_id']) for g in grants)))
    from .private_library_authority import require_private_action, PrivateLibraryAuthorityError
    try:
        require_private_action(live,'library.browse.read',constraints=constraints)
    except PrivateLibraryAuthorityError:
        raise SourceStale() from None
    require_account_foobar(account, constraints)
    return live
