"""Synthetic authority cases, authored but not run. No real DB assertions."""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone
import inspect
from types import SimpleNamespace

import pytest
from music_app.services import foobar_account_authority as subject
from music_app.services.current_actor import ActorState, CapabilityGrant, LibraryRelationship
from music_app.services.foobar_source_postgres import SourceUnavailable, SourceStale
from tests.py.test_account_source_selection import context


class Cursor:
    def __init__(self, rows):
        self.rows = rows
        self.closed = False
    def fetchmany(self, maximum):
        assert maximum == 2
        return self.rows
    def close(self):
        self.closed = True


class Connection:
    def __init__(self):
        self.rows = [dict(id=1, is_active=True, disabled_at=None)]
        self.events = []
    def execute(self, sql, args=None):
        assert 'library' not in sql.lower()
        self.events.append(('execute', sql, args))
        return Cursor(self.rows)


@pytest.fixture
def environment(monkeypatch):
    connection = Connection()
    @contextmanager
    def pooled(database_url):
        connection.events.append(('begin',))
        try:
            yield connection
        except Exception:
            connection.events.append(('rollback',))
            raise
        else:
            connection.events.append(('commit',))
    def session(conn, *, actor_account_id, actor_session_id, clock):
        assert conn is connection and actor_account_id == 1 and actor_session_id == 11
        assert any('for update' in e[1] for e in connection.events if e[0] == 'execute')
        connection.events.append(('session',))
        return datetime.now(timezone.utc)
    class Evaluator:
        def evaluate(self, ctx, *, constraints=None):
            assert ctx.action == 'account.self.foobar.write'
            assert ctx.library_id is None and ctx.target_account_id == ctx.actor.account_id
            connection.events.append(('policy',))
            return SimpleNamespace(decision=SimpleNamespace(allowed=True))
    monkeypatch.setattr(subject, 'pooled_connection', pooled)
    monkeypatch.setattr(subject, '_foobar_taste_connection', lambda conn: None)
    monkeypatch.setattr(subject, 'lock_current_actor_session', session)
    monkeypatch.setattr(subject, 'PolicyEvaluator', Evaluator)
    return connection


def test_no_library_context_locks_account_then_session_and_rechecks_before_commit(environment):
    with subject.current_foobar_account_transaction('synthetic', context()) as (conn, live, now):
        assert conn is environment and live.library_id is None
        conn.events.append(('body',))
    kinds = [e[0] for e in environment.events]
    assert kinds.count('session') == 2
    assert kinds.count('policy') == 3
    assert kinds.index('session') < kinds.index('body')
    assert kinds[-3:] == ['session', 'policy', 'commit']
    sql = '\n'.join(e[1] for e in environment.events if e[0] == 'execute')
    assert 'app.accounts' in sql and 'for update' in sql
    assert 'read committed' in sql


def test_ambient_library_admin_authority_is_removed():
    ctx = context()
    ctx = replace(ctx, library_id=55, actor=replace(ctx.actor,
        current_library_id=55, is_bootstrap_owner=True,
        library_relationships=(LibraryRelationship(55, 'owner', True),),
        capability_grants=(CapabilityGrant('admin', 'global', None),)))
    clean = subject.account_foobar_context(ctx)
    assert clean.library_id is None and clean.actor.current_library_id is None
    assert clean.actor.library_relationships == () and clean.actor.capability_grants == ()
    assert not clean.actor.is_bootstrap_owner
    assert clean.actor.account_id == 1 and clean.actor.session_id == 11


@pytest.mark.parametrize('rows', [[], [dict(id=2, is_active=True, disabled_at=None)],
    [dict(id=1, is_active=False, disabled_at=None)],
    [dict(id=1, is_active=True, disabled_at=datetime(2026, 10, 23))],
    [dict(id=True, is_active=True, disabled_at=None)],
    [dict(id=1, is_active=True, disabled_at=None, extra=1)]])
def test_missing_disabled_wrong_or_malformed_account_fails_before_body(environment, rows):
    environment.rows = rows
    with pytest.raises(SourceStale):
        with subject.current_foobar_account_transaction('synthetic', context()):
            pytest.fail('untrusted account reached body')
    assert environment.events[-1] == ('rollback',)
    assert not any(e[0] == 'session' for e in environment.events)


@pytest.mark.parametrize('fail_call', [1, 2])
def test_stale_session_before_or_after_body_prevents_commit(environment, monkeypatch, fail_call):
    calls = []
    def session(*args, **kwargs):
        calls.append(None)
        if len(calls) == fail_call:
            raise subject.RecentAuthenticationRequired()
        return datetime.now(timezone.utc)
    monkeypatch.setattr(subject, 'lock_current_actor_session', session)
    with pytest.raises(SourceStale):
        with subject.current_foobar_account_transaction('synthetic', context()):
            assert fail_call == 2
    assert environment.events[-1] == ('rollback',)
    assert ('commit',) not in environment.events


@pytest.mark.parametrize('deny_call', [1, 2, 3])
def test_policy_denial_at_every_authority_boundary_prevents_success(environment, monkeypatch, deny_call):
    calls = []
    class Evaluator:
        def evaluate(self, ctx, *, constraints=None):
            calls.append(ctx.action)
            return SimpleNamespace(decision=SimpleNamespace(allowed=len(calls) != deny_call))
    monkeypatch.setattr(subject, 'PolicyEvaluator', Evaluator)
    with pytest.raises(SourceStale):
        with subject.current_foobar_account_transaction('synthetic', context()):
            assert deny_call == 3
    assert ('commit',) not in environment.events
    assert calls == ['account.self.foobar.write'] * deny_call


def test_constraint_exception_is_not_policy_denial(environment):
    def broken(ctx):
        raise SourceStale()
    with pytest.raises(SourceUnavailable) as error:
        subject.require_account_foobar(context(), broken)
    assert type(error.value) is SourceUnavailable


@pytest.mark.parametrize('account,session', [(True, 11), (1, True), (0, 11), (1, 0), (2**63, 11)])
def test_invalid_native_account_session_ids_fail(account, session):
    with pytest.raises(SourceStale):
        subject.account_foobar_context(context(account, session))


def test_other_target_account_cannot_gain_self_authority():
    with pytest.raises(SourceStale):
        subject.account_foobar_context(replace(context(), target_account_id=2))


def test_inactive_snapshot_cannot_reactivate_itself():
    ctx = context()
    with pytest.raises(SourceStale):
        subject.account_foobar_context(replace(ctx, actor=replace(ctx.actor, state=ActorState.INACTIVE)))


@pytest.mark.parametrize('field', ['deployment_allowed', 'client_surface_allowed', 'request_origin_allowed'])
def test_real_evaluator_applies_each_narrowing_constraint(field):
    # No environment fixture: this deliberately exercises the real evaluator.
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    assert subject.require_account_foobar(context()).target_account_id == 1
    constraints = PolicyEvaluationConstraints(**{field: False})
    with pytest.raises(SourceStale):
        subject.require_account_foobar(context(), constraints)
    with pytest.raises(SourceStale):
        subject.require_account_foobar(context(), lambda target: constraints)


@pytest.mark.parametrize('value', [True, {}, (), 'allowed', object()])
def test_real_resolver_malformed_return_is_operational_failure(value):
    with pytest.raises(SourceUnavailable) as error:
        subject.require_account_foobar(context(), lambda target: value)
    assert type(error.value) is SourceUnavailable


@pytest.mark.parametrize('exception', [RuntimeError, PermissionError, SourceStale])
def test_real_resolver_exception_is_operational_failure(exception):
    def broken(target):
        raise exception()
    with pytest.raises(SourceUnavailable) as error:
        subject.require_account_foobar(context(), broken)
    assert type(error.value) is SourceUnavailable


def test_body_failure_rolls_back_and_does_not_commit(environment):
    class BodyFailure(Exception):
        pass
    with pytest.raises(BodyFailure):
        with subject.current_foobar_account_transaction('synthetic', context()):
            raise BodyFailure()
    assert environment.events[-1] == ('rollback',)
    assert ('commit',) not in environment.events


@pytest.mark.parametrize('failure', [None, 'fetch', 'close'])
def test_account_cursor_closed_on_success_and_fetch_failure(environment, monkeypatch, failure):
    class CursorFailure(RuntimeError):
        pass
    class GuardCursor(Cursor):
        def fetchmany(self, maximum):
            if failure == 'fetch':
                raise CursorFailure()
            return super().fetchmany(maximum)
        def close(self):
            self.closed = True
            if failure == 'close':
                raise CursorFailure()
    cursor = GuardCursor(environment.rows)
    original = environment.execute
    def execute(sql, args=None):
        result = original(sql, args)
        return cursor if 'from app.accounts' in sql else result
    monkeypatch.setattr(environment, 'execute', execute)
    if failure:
        with pytest.raises(CursorFailure):
            with subject.current_foobar_account_transaction('synthetic', context()):
                pytest.fail('cursor error must precede body')
        assert environment.events[-1] == ('rollback',)
    else:
        with subject.current_foobar_account_transaction('synthetic', context()):
            assert cursor.closed
        assert environment.events[-1] == ('commit',)
    assert cursor.closed
