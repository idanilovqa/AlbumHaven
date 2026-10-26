"""Account-self transaction owner for the inactive account-owned Foobar v2 path.

Uses the existing native account/session authority, not a supplied trusted flag.
This scope never authorizes inventory, matching or native library taste writes.
"""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone

from .admin_member_mutation_postgres import lock_current_actor_session, RecentAuthenticationRequired
from .current_actor import CurrentActor, ActorState
from .policy import PolicyContext
from .policy_evaluator import PolicyEvaluator, PolicyEvaluationConstraints
from .postgres_connections import pooled_connection
from .foobar_source_postgres import SourceUnavailable, SourceStale
from .track_preferences_postgres import _foobar_taste_connection

_MAX = 9223372036854775807


def _account_foobar_context(context, action):
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
    return replace(context, action=action, resource=None,
                   target_account_id=context.actor.account_id, library_id=None,
                   actor=replace(context.actor, current_library_id=None,
                                 library_relationships=(), capability_grants=(),
                                 is_bootstrap_owner=False))


def account_foobar_context(context):
    return _account_foobar_context(context, 'account.self.foobar.write')


def account_foobar_read_context(context):
    return _account_foobar_context(context, 'account.self.foobar.read')


def _require_account_foobar(context, constraints, action):
    target = _account_foobar_context(context, action)
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


def require_account_foobar(context, constraints=None):
    return _require_account_foobar(context, constraints, 'account.self.foobar.write')


def require_account_foobar_read(context, constraints=None):
    return _require_account_foobar(context, constraints, 'account.self.foobar.read')


@contextmanager
def _current_foobar_account_transaction(database_url, context, *, constraints, action):
    """Lock authenticated account then native session; commit only on context exit.

    No library requirement, account mapping, RLS, hosted durability or new route.
    Database URL and context are resolved by the future server-owned call site.
    """
    live = _require_account_foobar(context, constraints, action)
    clock = lambda: datetime.now(timezone.utc)
    try:
        with pooled_connection(database_url) as connection:
            connection.execute('set transaction isolation level read committed').close()
            _foobar_taste_connection(connection)
            connection.execute("set local lock_timeout = '250ms'").close()
            connection.execute("set local statement_timeout = '1000ms'").close()
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
            live = _require_account_foobar(live, constraints, action)
            yield connection, live, now
            # The same locked session must still be unexpired before commit.
            lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id, clock=clock)
            _require_account_foobar(live, constraints, action)
    except RecentAuthenticationRequired:
        raise SourceStale() from None


@contextmanager
def current_foobar_account_transaction(database_url, context, *, constraints=None):
    """Unchanged public write authority; callers cannot choose an action."""
    with _current_foobar_account_transaction(database_url, context,
            constraints=constraints, action='account.self.foobar.write') as current:
        yield current


@contextmanager
def current_foobar_account_read_transaction(database_url, context, *, constraints=None):
    """Read authority with the same real account/session locks and exit recheck.

    Row locks require a normal transaction, not SET TRANSACTION READ ONLY. This
    owner performs no source/account mutations and grants no write/library scope.
    The action is a fixed server-owned constant, never a request parameter.
    """
    with _current_foobar_account_transaction(database_url, context,
            constraints=constraints, action='account.self.foobar.read') as current:
        yield current
