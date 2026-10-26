"""Dedicated capture history account-self authority using existing native session locks.

No Foobar storage, permissions, counts, credentials or library grants are reused.
"""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone

from .admin_member_mutation_postgres import lock_current_actor_session, RecentAuthenticationRequired
from .current_actor import CurrentActor, ActorState
from .policy import PolicyContext
from .policy_evaluator import PolicyEvaluator, PolicyEvaluationConstraints
from .postgres_connections import pooled_connection
from .playback_capture import CaptureError


class SourceUnavailable(CaptureError):
    def __init__(self):
        super().__init__('capture_unavailable',503)


class SourceStale(CaptureError):
    def __init__(self):
        super().__init__('capture_forbidden',403)

_MAX = 9223372036854775807


def _account_capture_history_context(context, action):
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


def account_capture_history_read_context(context):
    return _account_capture_history_context(context, 'account.self.capture.history.read')


def _require_account_capture_history(context, constraints, action):
    target = _account_capture_history_context(context, action)
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


def require_account_capture_history_read(context, constraints=None):
    return _require_account_capture_history(context, constraints, 'account.self.capture.history.read')


@contextmanager
def _current_capture_history_account_transaction(database_url, context, *, constraints, action, connect=None, clock=None):
    """Lock authenticated account then native session; commit only on context exit.

    No library grants, account mapping, RLS or hosted durability are invented.
    Database URL and context are resolved by the server-owned route/service.
    """
    live = _require_account_capture_history(context, constraints, action)
    clock = clock or (lambda: datetime.now(timezone.utc))
    try:
        with (connect or pooled_connection)(database_url) as connection:
            connection.execute('set transaction isolation level read committed')
            from psycopg.pq import TransactionStatus
            if connection.autocommit is not False or connection.info.transaction_status != TransactionStatus.INTRANS:
                raise SourceUnavailable()
            connection.execute("set local lock_timeout = '250ms'")
            connection.execute("set local statement_timeout = '1000ms'")
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
            live = _require_account_capture_history(live, constraints, action)
            yield connection, live, now
            # The same locked session must still be unexpired before commit.
            lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id, clock=clock)
            _require_account_capture_history(live, constraints, action)
    except RecentAuthenticationRequired:
        raise SourceStale() from None


@contextmanager
def current_capture_history_account_read_transaction(database_url, context, *, constraints=None, connect=None, clock=None):
    """Read authority with the same real account/session locks and exit recheck.

    Row locks require a normal transaction, not SET TRANSACTION READ ONLY. This
    owner performs no source/account mutations and grants no write/library scope.
    The action is a fixed server-owned constant, never a request parameter.
    """
    with _current_capture_history_account_transaction(database_url, context,
            constraints=constraints, action='account.self.capture.history.read', connect=connect, clock=clock) as current:
        yield current
