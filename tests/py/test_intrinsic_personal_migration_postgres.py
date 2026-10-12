"""Exact 0114 SQL transition in real PostgreSQL, always rolled back.

Requires an exclusive, normally provisioned isolated database still at its
branch's pre-0114 schema. This proves SQL behavior, not runner/ledger plumbing.
Never run against a shared app database or while app/test workers are active.
"""
import os
from pathlib import Path
import re
from urllib.parse import urlparse
from uuid import uuid4

import pytest

MIGRATION = Path(__file__).resolve().parents[2] / 'migrations/postgres/0114_intrinsic_personal_feature_access.sql'


@pytest.fixture
def migration_connection():
    assert os.environ.get('ALBUM_HAVEN_PERSONAL_MIGRATION_TEST') == 'exclusive-isolated-rollback', (
        'Root must explicitly admit this exclusive isolated migration invocation')
    runtime = os.environ.get('ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL', '')
    setup = os.environ.get('DATABASE_MIGRATOR_URL', '')
    assert runtime and setup, 'Normal isolated runtime and migrator configuration is required'
    a, b = urlparse(runtime), urlparse(setup)
    for parsed in (a, b):
        assert parsed.scheme in {'postgres', 'postgresql'}
        assert parsed.hostname in {'localhost', '127.0.0.1', '::1'}
        assert re.fullmatch(r'(?:album_haven_ci_|pytest_|album_haven_fake_e2e)[a-z0-9_]*', parsed.path.lstrip('/'))
        assert not parsed.query
    assert (a.hostname, a.port, a.path) == (b.hostname, b.port, b.path)
    import psycopg
    from psycopg.rows import dict_row
    c = psycopg.connect(setup, row_factory=dict_row)
    try:
        applied = {row['migration_name'] for row in c.execute('select migration_name from ops.schema_migrations').fetchall()}
        predecessors = sorted(path.name for path in MIGRATION.parent.glob('[0-9][0-9][0-9][0-9]_*.sql')
            if int(path.name[:4]) < 114)
        assert predecessors and predecessors[-1] in {
            '0096_create_current_playback_presence.sql', '0113_popularity_source_observations.sql'}
        assert set(predecessors) <= applied, 'All normal branch prerequisite migrations must already be applied'
        assert not any(re.match(r'\d{4}_', name) and int(name[:4]) >= 114 for name in applied), 'Requires pre-0114 schema, never restore old triggers to manufacture it'
        assert c.execute("select 1 from pg_trigger where tgrelid='app.capabilities'::regclass and tgname='friend_social_grant' and not tgisinternal").fetchone(), 'Requires original pre-0114 grant trigger'
        assert c.execute("select 1 from pg_trigger where tgrelid='app.capabilities'::regclass and tgname='friend_browse_grant' and not tgisinternal").fetchone() is None
        yield c
    finally:
        c.rollback()
        c.close()


def snapshot(c, library, accounts):
    return {
        'relationships': c.execute('select * from app.friend_connections where library_id=%s order by low_account_id,high_account_id', (library,)).fetchall(),
        'grants': c.execute('select * from app.capabilities where account_id=any(%s) order by id', (accounts,)).fetchall(),
        'policies': c.execute('select * from app.friend_policies where library_id=%s', (library,)).fetchall(),
        'notifications': c.execute('select * from app.friend_notifications where library_id=%s order by id', (library,)).fetchall(),
    }


def test_exact_forward_migration_preserves_rows_and_does_not_eagerly_friend_members(migration_connection):
    c = migration_connection
    accounts = []
    for _ in range(7):
        name = 'migration-personal-' + uuid4().hex
        accounts.append(c.execute('''insert into app.accounts(display_name,account_kind,username_display,
            username_normalized,contact_email,contact_email_normalized)
            values(%s,'managed_user',%s,%s,%s,%s) returning id''',
            (name, name, name, name+'@example.test', name+'@example.test')).fetchone()['id'])
    library = c.execute('insert into library.libraries(owner_account_id,name) values(%s,%s) returning id',
        (accounts[0], 'Migration '+uuid4().hex)).fetchone()['id']
    for account in accounts:
        c.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'member')", (account, library))
        for key in ('capability.view', 'capability.social', 'library.playlists.manage'):
            c.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)", (account, key, library))
        c.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id,revoked_at) values(%s,'library.track_preferences.manage','library',%s,now())", (account, library))
    for target, state in zip(accounts[1:5], ('accepted', 'declined', 'removed', 'pending')):
        low, high = sorted((accounts[0], target))
        c.execute('''insert into app.friend_connections(library_id,low_account_id,high_account_id,
            requester_account_id,state,origin,revision) values(%s,%s,%s,%s,%s,'request',7)''',
            (library, low, high, accounts[0], state))
    # Direct fixture policy setup does not call the sync function. There are
    # eligible absent pairs which any eager reconciliation would create.
    c.execute('update app.friend_policies set auto_friend=true where library_id=%s', (library,))
    before = snapshot(c, library, accounts)
    assert len(before['relationships']) == 4
    assert {row['state'] for row in before['relationships']} == {'accepted', 'declined', 'removed', 'pending'}
    rights_before = c.execute('''select oid,proowner,proacl,prosecdef,proconfig from pg_proc
        where oid in ('app.sync_automatic_friends(bigint)'::regprocedure,
                      'app.refresh_automatic_friends()'::regprocedure) order by oid''').fetchall()
    c.execute(MIGRATION.read_text(encoding='utf-8'))
    assert snapshot(c, library, accounts) == before
    rights_after = c.execute('''select oid,proowner,proacl,prosecdef,proconfig from pg_proc
        where oid in ('app.sync_automatic_friends(bigint)'::regprocedure,
                      'app.refresh_automatic_friends()'::regprocedure) order by oid''').fetchall()
    assert rights_after == rights_before
    assert c.execute("select 1 from pg_trigger where tgrelid='app.capabilities'::regclass and tgname='friend_social_grant' and not tgisinternal").fetchone() is None
    assert c.execute("select 1 from pg_trigger where tgrelid='app.capabilities'::regclass and tgname='friend_browse_grant' and not tgisinternal").fetchone()
    # An ordinary existing lifecycle event may now reconcile eligible absent
    # pairs, while all pre-existing relationship rows remain byte-for-byte.
    c.execute('update app.accounts set is_active=false where id=%s', (accounts[-1],))
    c.execute('update app.accounts set is_active=true where id=%s', (accounts[-1],))
    after_lifecycle = snapshot(c, library, accounts)
    prior_pairs = {(row['low_account_id'], row['high_account_id']): row for row in before['relationships']}
    current_pairs = {(row['low_account_id'], row['high_account_id']): row for row in after_lifecycle['relationships']}
    assert len(current_pairs) > len(prior_pairs)
    for pair, row in prior_pairs.items():
        assert current_pairs[pair] == row
    assert after_lifecycle['grants'] == before['grants']
