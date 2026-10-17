"""Exercise the actual shared actor and friendship guards on recording SQL.

The entire lock_current_actor_session helper is monkeypatched at its two call
sites. These assertions do not establish actual session expiry/revocation or
PostgreSQL SQL acceptance; those require later database integration tests.
No HTTP admission is supplied by this foundation test.
"""
from dataclasses import replace
from datetime import datetime, timezone

import pytest

from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services import private_library_authority as authority
from music_app.services import private_search_subject as subjects
from music_app.services.private_search_contract import PrivateSearchError, normalize_listener_history_query

NOW = datetime(2026, 10, 16, tzinfo=timezone.utc)


def context():
    return PolicyContext.build(actor=CurrentActor(state=ActorState.ACTIVE,
        account_id=41, session_id=81, current_library_id=73,
        library_relationships=(LibraryRelationship(73, 'member', False),),
        capability_grants=(CapabilityGrant('capability.view', 'library', 73),)),
        action='library.browse.read', library_id=73, deployment_mode='self_hosted',
        request_origin=RequestOrigin('network', 'hmac:listener-search-test'),
        client_surface_class='private_web')


class Rows:
    def __init__(self, rows=()):
        self.rows = list(rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class RecordingConnections:
    def __init__(self):
        self.accounts = {
            41: dict(username='mira', username_display='Mira', display_name='Mira',
                account_ref='20000000-0000-4000-8000-000000000041', active=True, member=True, browse=True),
            42: dict(username='maya', username_display='Maya', display_name='Maya',
                account_ref='20000000-0000-4000-8000-000000000042', active=True, member=True, browse=True),
        }
        self.friend_state = 'accepted'
        self.relationship_revision = 7
        self.calls, self.events = [], []
        self.open_count = self.max_open = self.count = 0
        self.after_hint = None

    def __call__(self, url):
        assert url == 'postgresql://listener-test.invalid/never-connect'
        owner = self
        owner.count += 1
        ordinal = owner.count

        class Connection:
            def __enter__(self):
                owner.open_count += 1
                owner.max_open = max(owner.max_open, owner.open_count)
                owner.events.append(('open', ordinal))
                return self

            def __exit__(self, kind, error, traceback):
                owner.open_count -= 1
                owner.events.append(('close', ordinal, kind))
                if ordinal == 1 and owner.after_hint:
                    owner.after_hint()

            def execute(self, sql, params=None):
                normalized = ' '.join(sql.split())
                owner.calls.append((ordinal, normalized, params))
                return owner.rows(normalized, params)

        return Connection()

    def eligible(self, account):
        row = self.accounts.get(account)
        return bool(row and row['active'] and row['member'] and row['browse'])

    def profile(self, account):
        value = self.accounts[account]
        return {'account_id': account, **{key: value[key] for key in
            ('account_ref', 'username_display', 'display_name')}}

    def rows(self, sql, params):
        if sql.startswith('select a.id as account_id from app.accounts'):
            library_id, username = params
            return Rows({'account_id': account} for account, row in self.accounts.items()
                if library_id == 73 and row['username'] == username and row['active'] and row['member'])
        if sql.startswith('select a.id as account_id,a.username_display'):
            library_id, account, username = params
            row = self.accounts.get(account)
            valid = library_id == 73 and row and row['username'] == username and row['active'] and row['member']
            return Rows([self.profile(account)] if valid else [])
        if sql.startswith('set transaction isolation level'):
            return Rows()
        if sql.startswith('select id,is_active,disabled_at from app.accounts'):
            row = self.accounts.get(params[0])
            return Rows([{'id': params[0], 'is_active': row['active'], 'disabled_at': None}] if row else [])
        if sql.startswith('select m.membership_role,l.owner_account_id'):
            return Rows([{'membership_role': 'member', 'is_primary_owner': False}]
                if self.accounts[params[0]]['member'] else [])
        if sql.startswith('select capability_key,scope_kind,scope_id from app.capabilities'):
            return Rows([{'capability_key': 'capability.view', 'scope_kind': 'library', 'scope_id': 73}]
                if self.accounts[params[0]]['browse'] else [])
        if sql.startswith('select a.id as account_id,p.account_ref::text'):
            return Rows(self.profile(account) for account in params['accounts'] if self.eligible(account))
        if sql.startswith('select * from app.friend_connections'):
            return Rows([{'state': self.friend_state, 'revision': self.relationship_revision}])
        if sql.startswith('select account_id from app.bootstrap_owners'):
            return Rows()
        if sql.startswith('select id from app.accounts where id=any'):
            return Rows({'id': account} for account in params[0] if account in self.accounts)
        if sql.startswith('select id from library.library_memberships where account_id=any'):
            return Rows({'id': account} for account in params['accounts'] if self.accounts[account]['member'])
        if sql.startswith('select id from app.capabilities where account_id=any'):
            return Rows({'id': account} for account in params['accounts'] if self.accounts[account]['browse'])
        raise AssertionError('Unexpected SQL: ' + sql)


@pytest.fixture
def harness(monkeypatch):
    db = RecordingConnections()

    def session(connection, *, actor_account_id, actor_session_id, clock):
        assert actor_account_id == 41 and actor_session_id == 81
        db.events.append(('session', actor_account_id, actor_session_id))
        return clock()

    monkeypatch.setattr(authority, 'lock_current_actor_session', session)
    monkeypatch.setattr(subjects, 'lock_current_actor_session', session)
    service = subjects.PostgresListenerSearchSubjects(
        {'ALBUM_HAVEN_APP_DATABASE_URL': 'postgresql://listener-test.invalid/never-connect'},
        connect=db, clock=lambda: NOW)
    return db, service


@pytest.mark.parametrize('query,expected,action,revision', [
    ('@MIRA', 41, 'library.browse.read', None),
    ('@MaYa', 42, 'library.social.history.read', 7),
])
def test_subject_is_server_resolved_with_actual_authority_owners(harness, query, expected, action, revision):
    db, service = harness
    actor = context()
    with service.authorized(actor, criteria=normalize_listener_history_query(query)) as (connection, scoped, subject):
        assert subject.account_id == expected and subject.history_action == action
        assert subject.relationship_revision == revision
        assert scoped.actor.account_id == 41 and scoped.actor.session_id == 81
        assert scoped.target_account_id == (None if expected == 41 else expected)
        assert subject.listener_payload() == {key: db.profile(expected)[key]
            for key in ('account_ref', 'display_name')} | {'username': db.accounts[expected]['username_display']}
        assert set(subject.listener_payload()) == {'account_ref', 'username', 'display_name'}
        assert db.open_count == 1 and db.count == 2
    assert db.open_count == 0 and db.max_open == 1
    assert db.events.index(('close', 1, None)) < db.events.index(('open', 2))
    isolation = [call for call in db.calls if call[1].startswith('set transaction')]
    assert len(isolation) == 1 and isolation[0][0] == 2
    account_locks = [params[0] for _, sql, params in db.calls
        if sql.startswith('select id from app.accounts where id=any')]
    assert account_locks[0] == sorted({41, expected})
    friend_queries = [sql for _, sql, _ in db.calls if 'from app.friend_connections' in sql]
    assert bool(friend_queries) is (expected != 41)
    assert not any('listen_history' in sql or 'track_preferences' in sql for _, sql, _ in db.calls)


@pytest.mark.parametrize('state', ['none', 'pending', 'removed', 'declined', 'cancelled'])
def test_unaccepted_and_former_friend_never_enters_consumer(harness, state):
    db, service = harness
    db.friend_state = state
    with pytest.raises(PrivateSearchError) as caught:
        with service.authorized(context(), criteria=normalize_listener_history_query('@maya')):
            pytest.fail('Unauthorized listener was exposed')
    assert caught.value.code == 'private_search_forbidden'
    assert caught.value.status_code == 403 and str(caught.value) == 'Search is unavailable.'
    assert db.max_open == 1 and db.open_count == 0


@pytest.mark.parametrize('change', ['unknown', 'disabled', 'cross_library', 'no_browse'])
def test_unknown_or_ineligible_subject_is_indistinguishable(harness, change):
    db, service = harness
    if change == 'unknown':
        db.accounts[42]['username'] = 'someone_else'
    else:
        db.accounts[42][{'disabled': 'active', 'cross_library': 'member', 'no_browse': 'browse'}[change]] = False
    with pytest.raises(PrivateSearchError) as caught:
        with service.authorized(context(), criteria=normalize_listener_history_query('@maya')):
            pytest.fail('Ineligible listener was exposed')
    assert (caught.value.code, caught.value.status_code, str(caught.value)) == (
        'private_search_forbidden', 403, 'Search is unavailable.')
    assert db.open_count == 0


@pytest.mark.parametrize('change', ['rename', 'reassign', 'delete', 'disable', 'leave_library'])
def test_hint_never_authorizes_changed_identity(harness, change):
    db, service = harness

    def mutate():
        if change == 'delete':
            del db.accounts[42]
        elif change in {'rename', 'reassign'}:
            db.accounts[42]['username'] = 'new_maya'
            if change == 'reassign':
                db.accounts[43] = {**db.accounts[42], 'username': 'maya'}
        else:
            db.accounts[42]['active' if change == 'disable' else 'member'] = False

    db.after_hint = mutate
    with pytest.raises(PrivateSearchError) as caught:
        with service.authorized(context(), criteria=normalize_listener_history_query('@maya')):
            pytest.fail('Changed lookup hint was treated as authority')
    assert caught.value.code == 'private_search_forbidden'
    assert db.count == 2 and db.open_count == 0 and db.max_open == 1
    assert not any('from app.friend_connections' in sql for _, sql, _ in db.calls)


def test_caller_supplied_subject_identity_is_rejected_before_lookup(harness):
    db, service = harness
    with pytest.raises(PrivateSearchError):
        with service.authorized(replace(context(), target_account_id=42),
                criteria=normalize_listener_history_query('@maya')):
            pytest.fail('Caller-selected target was accepted')
    with pytest.raises(PrivateSearchError):
        with service.authorized(context(), criteria={'username': 'maya', 'account_id': 42}):
            pytest.fail('Caller-supplied subject object was accepted')
    assert db.count == 0


def test_peer_history_policy_is_separate_and_keeps_actual_listener_target(harness):
    db, service = harness
    checks = []

    def constraints(policy):
        checks.append((policy.action, policy.target_account_id, policy.actor.account_id))
        return PolicyEvaluationConstraints(client_surface_allowed=policy.action != subjects.HISTORY)

    with pytest.raises(PrivateSearchError):
        with service.authorized(context(), criteria=normalize_listener_history_query('@maya'), constraints=constraints):
            pytest.fail('History denial was ignored')
    assert (subjects.HISTORY, 42, 41) in checks
    assert all(actor == 41 for _, _, actor in checks)
    assert db.open_count == 0


def test_consumer_error_closes_actual_authority_transaction(harness):
    db, service = harness
    with pytest.raises(RuntimeError, match='consumer stopped'):
        with service.authorized(context(), criteria=normalize_listener_history_query('@maya')):
            raise RuntimeError('consumer stopped')
    assert db.events[-1] == ('close', 2, RuntimeError)
    assert db.open_count == 0 and db.max_open == 1


def test_final_policy_check_can_retire_result_before_return(harness):
    db, service = harness
    delivered = False
    allowed = True

    def constraints(policy):
        return PolicyEvaluationConstraints(client_surface_allowed=allowed)

    with pytest.raises(PrivateSearchError):
        with service.authorized(context(), criteria=normalize_listener_history_query('@maya'), constraints=constraints):
            allowed = False
        delivered = True
    assert delivered is False and db.open_count == 0
