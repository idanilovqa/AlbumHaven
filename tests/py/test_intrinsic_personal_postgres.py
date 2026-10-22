"""Real Postgres contracts; missing isolated configuration is a setup error.

Only root executes this proposal. Each mutating case owns a fresh library and
accounts. The normal migrated app runtime is required; no substitute modules.
"""
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import os
import re
from types import SimpleNamespace
from urllib.parse import urlparse
from uuid import uuid4

import pytest

from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.friends_postgres import PostgresFriendsStore, FriendScopeError, authorized_friend_read
from music_app.services.home_activity import ActivityScope, HomeActivityError
from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
from music_app.services.private_library_authority import current_library_transaction, PrivateLibraryAuthorityError
from music_app.services.policy import PolicyContext, RequestOrigin


@pytest.fixture(scope='module')
def isolated_urls():
    app = os.environ.get('ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL', '')
    setup = os.environ.get('DATABASE_MIGRATOR_URL', '')
    assert app and setup, 'Root must supply real isolated runtime and migrator URLs before execution'
    a, b = urlparse(app), urlparse(setup)
    for parsed in (a, b):
        assert parsed.scheme in {'postgres', 'postgresql'}
        assert parsed.hostname in {'localhost', '127.0.0.1', '::1'}
        assert re.fullmatch(r'(?:album_haven_ci_|pytest_|album_haven_fake_e2e)[a-z0-9_]*', parsed.path.lstrip('/'))
        assert not parsed.query, 'No connection overrides'
    assert (a.hostname, a.port, a.path) == (b.hostname, b.port, b.path)
    return app, setup


def connect(url):
    import psycopg
    from psycopg.rows import dict_row
    return psycopg.connect(url, row_factory=dict_row)


@pytest.fixture
def personal_db(isolated_urls):
    runtime, setup = isolated_urls
    ids = []
    library = None
    now = datetime.now(timezone.utc)
    try:
        with connect(setup) as c:
            for _ in range(3):
                name = 'personal-' + uuid4().hex
                ids.append(c.execute('''insert into app.accounts(display_name,account_kind,username_display,
                    username_normalized,contact_email,contact_email_normalized)
                    values(%s,'managed_user',%s,%s,%s,%s) returning id''',
                    (name, name, name, name+'@example.test', name+'@example.test')).fetchone()['id'])
            library = c.execute('insert into library.libraries(owner_account_id,name) values(%s,%s) returning id',
                (ids[0], 'Personal '+uuid4().hex)).fetchone()['id']
            sessions = {}
            for account in ids:
                c.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'member')", (account, library))
                sessions[account] = c.execute('''insert into app.account_sessions(account_id,session_token_hash,
                    created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
                    values(%s,%s,%s,%s,%s,%s,%s) returning id''',
                    (account, sha256(uuid4().bytes).digest(), now, now, now,
                     now+timedelta(hours=12), now+timedelta(days=7))).fetchone()['id']
        f = SimpleNamespace(runtime=runtime, setup=setup, a=ids[0], b=ids[1], c=ids[2], library=library,
            sessions=sessions, store=PostgresFriendsStore({'ALBUM_HAVEN_APP_DATABASE_URL': runtime}, connect=connect))
        yield f
    finally:
        with connect(setup) as c:
            if library is not None:
                c.execute('delete from app.activity_snapshots where library_id=%s', (library,))
                c.execute('delete from library.libraries where id=%s', (library,))
            if ids:
                c.execute('delete from app.accounts where id=any(%s)', (ids,))


def grant(f, key, accounts=None, *, scope='library'):
    with connect(f.setup) as c:
        for account in accounts or (f.a, f.b):
            c.execute('insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,%s,%s)',
                (account, key, scope, f.library if scope == 'library' else None))


def args(f, actor=None, target=None):
    return {'account_id': actor or f.a, 'library_id': f.library, 'target_account_id': target or f.b}


def befriend(f):
    pending = f.store.transition(**args(f), actor_session_id=f.sessions[f.a], action='request')
    return f.store.transition(**args(f, f.b, f.a), actor_session_id=f.sessions[f.b],
        action='accept', expected_revision=pending['revision'])


def actor_context(f, key):
    return PolicyContext.build(actor=CurrentActor(state=ActorState.ACTIVE, account_id=f.a,
        session_id=f.sessions[f.a], current_library_id=f.library,
        library_relationships=(LibraryRelationship(f.library, 'member', False),),
        capability_grants=(CapabilityGrant(key, 'library', f.library),)),
        action='library.browse.read', library_id=f.library, deployment_mode='self_hosted',
        request_origin=RequestOrigin('network', 'hmac:personal-postgres'), client_surface_class='private_web')


@pytest.mark.parametrize('key', ['capability.view', 'library.browse.read', 'capability.play'])
@pytest.mark.parametrize('scope', ['library', 'global'])
def test_browse_eligible_members_discover_request_accept_and_read_without_social(personal_db, key, scope):
    f = personal_db
    grant(f, key, scope=scope)
    discovered = f.store.list_members(account_id=f.a, library_id=f.library, mode='discover')['members']
    assert [row['account_id'] for row in discovered] == [f.b]
    with connect(f.runtime) as c, pytest.raises(FriendScopeError):
        with authorized_friend_read(c, **args(f)):
            pytest.fail('Unaccepted friendship exposed data')
    assert befriend(f)['state'] == 'accepted'
    assert f.store.notifications(account_id=f.a, library_id=f.library)['notifications']
    with connect(f.runtime) as c:
        with authorized_friend_read(c, **args(f)) as profile:
            assert profile['account_id'] == f.b
        scope_value = ActivityScope(f.a, f.sessions[f.a], f.library, f.b, 'friend')
        with HomeActivityPostgresRepository._friend_authority(c, scope_value) as authority:
            assert authority['profile']['account_id'] == f.b
            assert authority['fingerprint']
        HomeActivityPostgresRepository._authority(c, scope_value, datetime.now(timezone.utc))
    with connect(f.setup) as c:
        assert c.execute("select count(*) as n from app.capabilities where account_id=any(%s) and capability_key='capability.social'", ([f.a, f.b],)).fetchone()['n'] == 0


@pytest.mark.parametrize('key', ['capability.view', 'library.browse.read'])
@pytest.mark.parametrize('subject', ['a', 'b'])
@pytest.mark.parametrize('change', ['revoke', 'membership', 'inactive'])
def test_live_friend_and_home_access_closes_when_either_member_loses_browse(personal_db, key, subject, change):
    f = personal_db
    grant(f, key)
    befriend(f)
    account = getattr(f, subject)
    with connect(f.setup) as c:
        if change == 'revoke':
            c.execute('update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s', (account, key))
        elif change == 'membership':
            c.execute('delete from library.library_memberships where account_id=%s and library_id=%s', (account, f.library))
        else:
            c.execute('update app.accounts set is_active=false where id=%s', (account,))
    with pytest.raises(FriendScopeError):
        f.store.profile(**args(f))
    with connect(f.runtime) as c, pytest.raises(HomeActivityError):
        with HomeActivityPostgresRepository._friend_authority(c, ActivityScope(f.a, f.sessions[f.a], f.library, f.b, 'friend')):
            pytest.fail('Revoked friend remained readable')


@pytest.mark.parametrize('key', ['capability.view', 'library.browse.read'])
@pytest.mark.parametrize('change', ['grant', 'session', 'membership'])
def test_stale_request_actor_is_revalidated_against_current_durable_authority(personal_db, key, change):
    f = personal_db
    grant(f, key)
    value = actor_context(f, key)
    with connect(f.setup) as c:
        if change == 'grant':
            c.execute('update app.capabilities set revoked_at=now() where account_id=%s', (f.a,))
        elif change == 'session':
            c.execute('update app.account_sessions set revoked_at=now() where id=%s', (f.sessions[f.a],))
        else:
            c.execute('delete from library.library_memberships where account_id=%s and library_id=%s', (f.a, f.library))
    with pytest.raises(PrivateLibraryAuthorityError):
        with current_library_transaction(f.runtime, value, connect=connect):
            pytest.fail('Stale request context bypassed live authority')


@pytest.mark.parametrize('key', ['capability.view', 'library.browse.read', 'capability.play'])
@pytest.mark.parametrize('scope', ['library', 'global'])
def test_automatic_friends_reacts_to_new_effective_browse_grants_without_backfill(personal_db, key, scope):
    f = personal_db
    with connect(f.setup) as c:
        c.execute('update app.friend_policies set auto_friend=true where library_id=%s', (f.library,))
    grant(f, key, (f.a,), scope=scope)
    grant(f, key, (f.b,), scope=scope)
    with connect(f.setup) as c:
        row = c.execute('select state,origin from app.friend_connections where library_id=%s', (f.library,)).fetchone()
        assert row and (row['state'], row['origin']) == ('accepted', 'automatic')
        assert c.execute("select count(*) as n from app.capabilities where account_id=any(%s) and capability_key='capability.social'", ([f.a, f.b],)).fetchone()['n'] == 0


@pytest.mark.parametrize('state', ['removed', 'pending'])
def test_automatic_friends_never_overwrites_tombstones_or_requests(personal_db, state):
    f = personal_db
    grant(f, 'capability.view')
    low, high = sorted((f.a, f.b))
    with connect(f.setup) as c:
        c.execute('''insert into app.friend_connections(library_id,low_account_id,high_account_id,
            requester_account_id,state,origin) values(%s,%s,%s,%s,%s,'request')''', (f.library, low, high, f.a, state))
        c.execute('update app.friend_policies set auto_friend=true where library_id=%s', (f.library,))
        c.execute('select app.sync_automatic_friends(%s)', (f.library,))
        c.execute('update app.accounts set is_active=false where id=%s', (f.b,))
        c.execute('update app.accounts set is_active=true where id=%s', (f.b,))
        row = c.execute('select state,origin from app.friend_connections where library_id=%s', (f.library,)).fetchone()
        assert (row['state'], row['origin']) == (state, 'request')


def test_bootstrap_new_membership_does_not_insert_social_grants(personal_db):
    f = personal_db
    with connect(f.setup) as c:
        owner = c.execute("select account_id from app.bootstrap_owners where owner_key='local-bootstrap-owner'").fetchone()
        assert owner is not None, 'Normal isolated bootstrap prerequisite must exist'
        account = owner['account_id']
        before = c.execute('select id,capability_key,scope_kind,scope_id,revoked_at from app.capabilities where account_id=%s order by id', (account,)).fetchall()
        c.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'owner')", (account, f.library))
        after = c.execute('select id,capability_key,scope_kind,scope_id,revoked_at from app.capabilities where account_id=%s order by id', (account,)).fetchall()
        assert after == before


@pytest.mark.parametrize('key', ['capability.view', 'library.browse.read'])
def test_friend_read_holds_effective_browse_grant_lock_until_projection_finishes(personal_db, key):
    from psycopg.errors import LockNotAvailable
    f = personal_db
    grant(f, key)
    befriend(f)
    with connect(f.runtime) as reader:
        with authorized_friend_read(reader, **args(f)):
            with pytest.raises(LockNotAvailable):
                with connect(f.setup) as revoker:
                    revoker.execute("set local lock_timeout='200ms'")
                    revoker.execute('update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s', (f.b, key))
    with connect(f.setup) as c:
        c.execute('update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s', (f.b, key))
    with connect(f.runtime) as c, pytest.raises(FriendScopeError):
        with authorized_friend_read(c, **args(f)):
            pytest.fail('Completed revocation was ignored')


@pytest.mark.parametrize('key', ['capability.view', 'library.browse.read'])
def test_home_friend_fingerprint_changes_on_browse_grant_replacement(personal_db, key):
    f = personal_db
    grant(f, key)
    befriend(f)
    scope = ActivityScope(f.a, f.sessions[f.a], f.library, f.b, 'friend')
    with connect(f.runtime) as c:
        with HomeActivityPostgresRepository._friend_authority(c, scope) as first:
            fingerprint = first['fingerprint']
    with connect(f.setup) as c:
        c.execute('update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s', (f.b, key))
    grant(f, key, (f.b,))
    with connect(f.runtime) as c:
        with HomeActivityPostgresRepository._friend_authority(c, scope) as second:
            assert second['fingerprint'] != fingerprint


@pytest.mark.parametrize('key', ['capability.view', 'library.browse.read'])
def test_restoring_browse_grant_triggers_automatic_friend_eligibility(personal_db, key):
    f = personal_db
    grant(f, key)
    with connect(f.setup) as c:
        c.execute('update app.capabilities set revoked_at=now() where account_id=%s', (f.b,))
        c.execute('update app.friend_policies set auto_friend=true where library_id=%s', (f.library,))
        c.execute('select app.sync_automatic_friends(%s)', (f.library,))
        assert c.execute('select count(*) as n from app.friend_connections where library_id=%s', (f.library,)).fetchone()['n'] == 0
        c.execute('update app.capabilities set revoked_at=null where account_id=%s and capability_key=%s', (f.b, key))
        row = c.execute('select state,origin from app.friend_connections where library_id=%s', (f.library,)).fetchone()
        assert row and (row['state'], row['origin']) == ('accepted', 'automatic')


def test_revoking_redundant_social_does_not_revoke_remaining_view_eligibility(personal_db):
    f = personal_db
    grant(f, 'capability.view')
    grant(f, 'capability.social')
    befriend(f)
    with connect(f.setup) as c:
        c.execute("update app.capabilities set revoked_at=now() where account_id=any(%s) and capability_key='capability.social'", ([f.a, f.b],))
    with connect(f.runtime) as c:
        with authorized_friend_read(c, **args(f)) as profile:
            assert profile['account_id'] == f.b
        with HomeActivityPostgresRepository._friend_authority(c, ActivityScope(f.a, f.sessions[f.a], f.library, f.b, 'friend')) as authority:
            assert authority['fingerprint']


def test_intrinsic_social_does_not_override_unfriending(personal_db):
    f = personal_db
    grant(f, 'capability.view')
    accepted = befriend(f)
    f.store.transition(**args(f), actor_session_id=f.sessions[f.a], action='unfriend', expected_revision=accepted['revision'])
    with connect(f.runtime) as c, pytest.raises(FriendScopeError):
        with authorized_friend_read(c, **args(f)):
            pytest.fail('Intrinsic social bypassed relationship privacy')


@pytest.mark.parametrize('key', ['capability.view', 'library.browse.read'])
def test_wrong_library_browse_grant_cannot_make_a_member_socially_eligible(personal_db, key):
    f = personal_db
    grant(f, key, (f.a,))
    with connect(f.setup) as c:
        # Account-scoped authority cannot stand in for this library's browse grant.
        c.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'account',%s)", (f.b, key, f.b))
    assert f.store.list_members(account_id=f.a, library_id=f.library, mode='discover')['members'] == []
    with pytest.raises(FriendScopeError):
        f.store.transition(**args(f), actor_session_id=f.sessions[f.a], action='request')
