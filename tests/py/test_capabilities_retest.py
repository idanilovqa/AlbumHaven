"""Reported demo regressions, tested without a production database connection."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import json

import pytest

from music_app.services.capabilities import CAPABILITY_KEYS, ROLE_PRESETS
from music_app.services.capability_assignments import build_assignment, read_assignment, access_revision, CAPABILITY_LABELS
from music_app.services.admin_member_mutation_postgres import PostgresAdminMemberMutationService, RecentAuthenticationRequired, lock_current_actor_session
from music_app.services.local_folder_access import can_open_client_folder
from music_app.services import postgres_connections
from test_capability_ui import projection

NOW = datetime(2026, 9, 27, tzinfo=timezone.utc)


def test_repair_and_old_rules_grants_both_grant_all_maintenance_actions():
    from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor
    from music_app.services.policy import PolicyContext, RequestOrigin
    from music_app.services.policy_evaluator import PolicyEvaluator
    for key in ['capability.repair', 'capability.rules']:
        actor = CurrentActor(state=ActorState.ACTIVE, account_id=7, session_id=8,
            capability_grants=(CapabilityGrant(key, 'library', 23),))
        for action in ['library.problems.read', 'library.files.repair', 'library.rules.read',
                       'library.rules.manage', 'library.logs.read', 'library.logs.export']:
            context = PolicyContext.build(actor=actor, action=action, library_id=23,
                deployment_mode='self_hosted', request_origin=RequestOrigin('network', 'test'),
                client_surface_class='private_web')
            assert PolicyEvaluator().evaluate(context).decision.allowed, (key, action)
    assert len(CAPABILITY_LABELS) == 10
    assert CAPABILITY_LABELS['capability.repair'] == 'Repair / Rules / Logs'
    assert 'capability.rules' not in CAPABILITY_LABELS


def test_retired_rules_key_is_canonicalized_without_losing_saved_owner_role():
    assignment = build_assignment(['owner'], [])
    old_live_keys = (*assignment.effective_keys, 'capability.rules')
    assert read_assignment(assignment.as_payload(), old_live_keys) == assignment
    assert build_assignment([], ['capability.rules']).capability_keys == ('capability.repair',)
    assert read_assignment({'version': 1, 'role_keys': [], 'capability_keys': ['capability.rules']},
        ['capability.rules']).capability_keys == ('capability.repair',)


@pytest.mark.parametrize('role', ['viewer', 'listener', 'musician', 'admin'])
def test_all_cover_lookup_entry_points_are_hidden_without_cover_authority(role):
    ui = projection([role])
    for selector in ['[data-open-track-modal-cover-lookup]', '[data-toggle-cover-lookup-drawer]',
                     '[data-open-cover-lookup-task]', '#cover-lookup-modal']:
        assert selector in ui['denied_selectors']
    assert not ui['allowed_actions'].get('library.covers.lookup', False)


def test_tag_editing_web_ceiling_is_not_silently_removed():
    assert '#track-modal-edit-tags' in projection(['owner'])['denied_selectors']
    assert '#track-modal-edit-tags' not in projection(['owner', 'admin'])['denied_selectors']
    assert '#track-modal-edit-tags' in projection(['owner', 'admin'], 'mobile')['denied_selectors']


@pytest.mark.parametrize('peer,host,headers,platform,env,expected', [
    ('127.0.0.1', 'localhost', {}, 'win32', {}, True),
    ('::1', '::1', {}, 'darwin', {}, True),
    ('127.0.0.1', 'localhost', {}, 'linux', {'DISPLAY': ':0'}, True),
    ('127.0.0.1', 'localhost', {}, 'linux', {}, False),
    ('192.168.1.15', '192.168.1.10', {}, 'win32', {}, False),
    ('203.0.113.10', 'albumhaven-capabilities-demo.onrender.com', {}, 'linux', {}, False),
    ('127.0.0.1', 'localhost', {'x-forwarded-for': '192.168.1.15'}, 'win32', {}, False),
    ('127.0.0.1', 'remote.example', {}, 'win32', {}, False),
    ('203.0.113.10', 'localhost', {}, 'win32', {}, False),
])
def test_folder_launcher_requires_the_same_direct_desktop(peer, host, headers, platform, env, expected):
    request = SimpleNamespace(client=SimpleNamespace(host=peer), url=SimpleNamespace(hostname=host), headers=headers)
    assert can_open_client_folder(request, platform=platform, environ=env) is expected


class Result:
    def __init__(self, rows=()): self.rows = list(rows)
    def fetchall(self): return list(self.rows)


class Connection:
    def __init__(self, *, session_changes=None, authorized=True):
        self.keys = ['capability.view']
        self.assignment = None
        self.authorized = authorized
        self.operations = []
        self.events = []
        self.session = dict(id=11, account_id=7, authenticated_at=NOW-timedelta(days=5),
            idle_expires_at=NOW+timedelta(days=30), absolute_expires_at=NOW+timedelta(days=85), revoked_at=None)
        self.session.update(session_changes or {})
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def transaction(self):
        outer = self
        class Transaction:
            def __enter__(self): outer.events.append('begin')
            def __exit__(self, error, *args): outer.events.append('rollback' if error else 'commit')
        return Transaction()
    def execute(self, sql, params=()):
        sql = ' '.join(sql.lower().split())
        self.operations.append((sql, params))
        if 'as current_capability_keys' in sql:
            return Result([dict(target_is_active=True, target_has_library_access=True,
                target_is_bootstrap_owner=False, current_capability_keys=list(self.keys), access_assignment=self.assignment)] if self.authorized else [])
        if 'from app.account_sessions' in sql: return Result([self.session])
        if sql.startswith('update app.capabilities'): self.keys = []
        if sql.startswith('insert into app.capabilities'): self.keys.append(params[1])
        if sql.startswith('update app.accounts') and 'library_access_assignments_v1' in sql:
            self.assignment = json.loads(params[1])
        return Result()


def test_active_admin_can_save_repeatedly_after_days_without_password_prompt():
    connection = Connection()
    service = PostgresAdminMemberMutationService({'ALBUM_HAVEN_APP_DATABASE_URL': 'postgresql://test'},
        connect=lambda _: connection, clock=lambda: NOW)
    revision = access_revision(read_assignment(None, connection.keys), connection.keys, active=True, access=True)
    for capabilities in [('capability.view', 'capability.repair'), ('capability.view', 'capability.change_covers')]:
        saved = service.update_account(actor_account_id=7, actor_session_id=11,
            actor_authenticated_at=NOW-timedelta(days=5), library_id=9, target_account_id=41,
            is_active=True, current_library_access=True, capability_keys=capabilities,
            confirm_disable=False, confirm_remove_access=False, request_ref='in-place-test',
            role_keys=[], access_revision=revision)
        assert set(connection.keys) == set(capabilities)
        expected = access_revision(read_assignment(connection.assignment, connection.keys), connection.keys, active=True, access=True)
        assert saved['access_revision'] == expected
        assert saved['access_revision'] != revision
        revision = saved['access_revision']
    assert connection.events == ['begin', 'commit', 'begin', 'commit']


@pytest.mark.parametrize('changes', [
    {'revoked_at': NOW}, {'idle_expires_at': NOW}, {'absolute_expires_at': NOW},
    {'account_id': 99}, {'authenticated_at': NOW+timedelta(hours=1)},
])
def test_removed_step_up_does_not_allow_expired_revoked_or_wrong_account_sessions(changes):
    connection = Connection(session_changes=changes)
    with pytest.raises(RecentAuthenticationRequired):
        lock_current_actor_session(connection, actor_account_id=7, actor_session_id=11, clock=lambda: NOW)
    assert not any(sql.startswith(('update ', 'insert ', 'delete ')) for sql, _ in connection.operations)


def test_pool_reuses_transport_but_returns_a_separate_checkout_for_each_request(monkeypatch):
    pools = []
    class FakePool:
        def __init__(self, **kwargs): self.kwargs = kwargs; self.checkouts = []; self.closed = False; pools.append(self)
        def connection(self):
            checkout = object(); self.checkouts.append(checkout); return checkout
        def close(self): self.closed = True
    postgres_connections.close_pools()
    monkeypatch.setattr(postgres_connections, 'ConnectionPool', FakePool)
    first = postgres_connections.pooled_connection('postgresql://test-one')
    second = postgres_connections.pooled_connection('postgresql://test-one')
    third = postgres_connections.pooled_connection('postgresql://test-two')
    assert len(pools) == 2
    assert first is not second and second is not third
    assert pools[0].kwargs['max_size'] == 4
    assert len(pools[0].checkouts) == 2
    postgres_connections.close_pools()
    assert all(pool.closed for pool in pools)
