"""Exact catalog fences through real runtime roles and PostgreSQL contention.

Only provider evidence is synthetic. No SQL results, role privileges, production
authority decisions, lock operations or membership mutations are replaced.
"""
from concurrent.futures import ThreadPoolExecutor
from time import monotonic, sleep
from uuid import uuid4

import pytest

from tests.py.postgres_runtime_role_contract import assert_runtime_role
from tests.py.remote_top_postgres_support import db, urls, remote, evidence, runtime, sql_error
from tests.py.remote_top_retention_postgres_support import retained
from tests.py.test_album_top_remote_membership_postgres import mixed, pending
from tests.py.test_album_top_remote_consumption_postgres import trace_owner
from tests.py.test_owned_album_tops_postgres import assert_error


IDENTITY_TABLE = 'catalog.release_group_provider_identities'
LOCK_SIGNATURE = 'app.lock_top_remote_catalog_identity(text,text,text,uuid)'
LOCK_SQL = 'select app.lock_top_remote_catalog_identity(%s,%s,%s,%s) as locked'
IDENTITY_SQL = ('select catalog_ref from catalog.release_group_provider_identities '
    'where provider=%s and entity_kind=%s and external_id=%s and catalog_ref=%s')


def lock_identity(connection, identity):
    return connection.execute(LOCK_SQL, identity).fetchone()['locked']


@pytest.fixture
def identities(mixed):
    external_ids = sorted(str(uuid4()) for _ in range(2))
    mixed.external_ids.extend(external_ids)
    rows = [('musicbrainz', 'release-group', external, catalog)
        for external, catalog in zip(external_ids, mixed.db.album_refs[:2])]
    assert len(rows) == 2
    with mixed.db.connect() as connection:
        for row in rows:
            connection.execute('''insert into catalog.release_group_provider_identities
                (provider,entity_kind,external_id,catalog_ref) values(%s,%s,%s,%s)''', row)
    return rows


def test_identity_helper_has_exact_definer_acl_without_catalog_update(mixed, identities):
    with runtime(mixed.db) as connection:
        runtime_role = assert_runtime_role(connection, mixed.db)
        assert lock_identity(connection, identities[0]) is True
        for statement in (
                IDENTITY_SQL + ' for share',
                'update catalog.release_group_provider_identities set catalog_ref=catalog_ref where false',
                'delete from catalog.release_group_provider_identities where false',
                'truncate catalog.release_group_provider_identities'):
            params = identities[0] if statement.startswith('select') else None
            sql_error(connection, '42501', lambda statement=statement, params=params:
                connection.execute(statement, params))
        for role in dict.fromkeys(('album_haven_app', runtime_role)):
            privileges = connection.execute('''select
                has_table_privilege(%s,%s,'SELECT') as can_select,
                has_table_privilege(%s,%s,'INSERT') as can_insert,
                has_any_column_privilege(%s,%s,'UPDATE') as can_update,
                has_table_privilege(%s,%s,'DELETE') as can_delete,
                has_table_privilege(%s,%s,'TRUNCATE') as can_truncate''', (role, IDENTITY_TABLE) * 5).fetchone()
            assert privileges == {'can_select': True, 'can_insert': True, 'can_update': False,
                'can_delete': False, 'can_truncate': False}
    with mixed.db.connect() as connection:
        actual = connection.execute('''select p.prosecdef,p.proconfig,p.provolatile,r.rolsuper,
            p.proowner=c.relowner as catalog_owner,
            has_function_privilege('album_haven_app',p.oid,'EXECUTE') as runtime,
            has_function_privilege(%s,p.oid,'EXECUTE') as connected,
            has_function_privilege('album_haven_readonly',p.oid,'EXECUTE') as readonly
            from pg_proc p join pg_roles r on r.oid=p.proowner
            join pg_class c on c.oid=%s::regclass where p.oid=%s::regprocedure''',
            (runtime_role, IDENTITY_TABLE, LOCK_SIGNATURE)).fetchone()
        assert actual == {'prosecdef': True, 'proconfig': ['search_path=pg_catalog'], 'provolatile': 'v',
            'rolsuper': False, 'catalog_owner': True, 'runtime': True, 'connected': True, 'readonly': False}
        assert connection.execute('''select count(*) as n from pg_proc p cross join lateral
            aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            where p.oid=%s::regprocedure and a.grantee=0''', (LOCK_SIGNATURE,)).fetchone()['n'] == 0


def test_identity_helper_rejects_invalid_or_changed_tuples_without_locks_or_dml(mixed, identities):
    identity = identities[0]
    cases = [(*identity[:index], None, *identity[index + 1:]) for index in range(4)]
    cases.extend([
        ('other', *identity[1:]),
        (identity[0], 'release', *identity[2:]),
        (*identity[:2], 'not-an-identity', identity[3]),
        (*identity[:2], 'g' * 36, identity[3]),
        (*identity[:2], identity[2] + chr(10), identity[3]),
        (*identity[:2], 'A62A2E84-F917-451E-B16B-34532DD965A5', identity[3]),
        (*identity[:2], '00000000-0000-0000-0000-000000000000', identity[3]),
        (*identity[:2], str(uuid4()), identity[3]),
        (*identity[:3], identities[1][3]),
        (*identity[:3], str(uuid4())),
    ])
    before = mixed.snapshot()
    with runtime(mixed.db) as connection:
        assert_runtime_role(connection, mixed.db)
        for changed in cases:
            assert lock_identity(connection, changed) is False, changed
        sql_error(connection, '22P02', lambda: lock_identity(connection, (*identity[:3], 'not-a-uuid')))
        # Every false case leaves both stored mappings available to an independent
        # writer. This also catches helpers that lock first and validate later.
        with mixed.db.connect() as probe:
            for row in identities:
                assert probe.execute(IDENTITY_SQL + ' for no key update nowait', row).fetchone()
    assert mixed.snapshot() == before


@pytest.mark.parametrize('end_transaction', ['commit', 'rollback'])
def test_identity_helper_fences_only_exact_row_until_transaction_end(mixed, identities, end_transaction):
    before = mixed.snapshot()
    with runtime(mixed.db) as connection:
        assert_runtime_role(connection, mixed.db)
        assert lock_identity(connection, identities[0]) is True
        assert lock_identity(connection, identities[0]) is True
        with mixed.db.connect() as probe:
            # NO KEY UPDATE distinguishes the required SHARE fence from the
            # weaker KEY SHARE lock, which would permit a catalog remapping.
            sql_error(probe, '55P03', lambda: probe.execute(
                IDENTITY_SQL + ' for no key update nowait', identities[0]).fetchone())
            assert probe.execute(IDENTITY_SQL + ' for no key update nowait', identities[1]).fetchone()
            assert probe.execute('select id from app.accounts where id=%s for update nowait',
                (mixed.db.owner.account_id,)).fetchone()
        getattr(connection, end_transaction)()
        with mixed.db.connect() as probe:
            assert probe.execute(IDENTITY_SQL + ' for no key update nowait', identities[0]).fetchone()
    assert mixed.snapshot() == before


def wait_for_identity_block(case, trace, future, blocker_pid):
    deadline = monotonic() + 3
    with case.db.connect() as connection:
        while monotonic() < deadline:
            if future.done():
                future.result()
                pytest.fail('Membership completed before reaching the blocked identity')
            waiting = [entry for entry in trace.selected('member')
                if 'app.lock_top_remote_catalog_identity(' in entry['sql'] and not entry['completed']]
            for entry in waiting:
                blockers = connection.execute('select pg_blocking_pids(%s) as blockers',
                    (entry['pid'],)).fetchone()['blockers']
                if blocker_pid in blockers:
                    return
            sleep(.01)
    pytest.fail('Membership did not enter the expected exact-identity PostgreSQL wait')


@pytest.mark.parametrize('reverse', [False, True])
def test_all_identity_fences_precede_any_admission_wait(mixed, identities, reverse):
    top, _ = mixed.db.create(refs=[])
    facts = [evidence(mbid=row[2], title='Identity fence ' + row[2]) for row in identities]
    acquired = [mixed.acquire(top, facts=fact) for fact in facts]
    top = mixed.execute(mixed.command('add', top, selections=[pending(row) for row in acquired]))
    items = mixed.read(top)['items']
    top = mixed.execute(mixed.command('remove', top, item_refs=[row['ref'] for row in items]))
    admissions = mixed.rows('album_top_remote_admissions')
    assert len(admissions) == 2
    acquired = [mixed.acquire(top, facts=fact) for fact in facts]
    selected = acquired[::-1] if reverse else acquired
    command = mixed.command('add', top, selections=[pending(row) for row in selected])
    provider_calls = len(mixed.remote.calls)
    with trace_owner(mixed) as trace, ThreadPoolExecutor(max_workers=1) as pool:
        with mixed.db.connect() as blocker:
            assert blocker.execute(IDENTITY_SQL + ' for update', identities[-1]).fetchone()
            future = pool.submit(trace.call, 'member', lambda: mixed.execute(command))
            try:
                wait_for_identity_block(mixed, trace, future, blocker.info.backend_pid)
                entries = trace.selected('member')
                mapping = [entry for entry in entries if entry['sql'].startswith(
                    'select catalog_ref from catalog.release_group_provider_identities')]
                fences = [entry for entry in entries if 'app.lock_top_remote_catalog_identity(' in entry['sql']]
                assert [entry['params'][2] for entry in mapping] == [row[2] for row in identities]
                assert all(entry['completed'] for entry in mapping)
                assert [entry['params'] for entry in fences] == identities
                assert [entry['completed'] for entry in fences] == [True, False]
                assert max(entry['order'] for entry in mapping) < min(entry['order'] for entry in fences)
                assert not any('app.retain_top_remote_acquisition(' in entry['sql'] for entry in entries)
                with mixed.db.connect() as probe:
                    sql_error(probe, '55P03', lambda: probe.execute(
                        IDENTITY_SQL + ' for no key update nowait', identities[0]).fetchone())
                    # Both historical admission rows remain unfenced while the
                    # final identity waits. No result-row mocks prove this.
                    locked = probe.execute('''select ref from app.album_top_remote_admissions
                        where top_ref=%s order by catalog_ref,ref for update nowait''',
                        (top['top_ref'],)).fetchall()
                    assert {row['ref'] for row in locked} == {row['ref'] for row in admissions}
            finally:
                blocker.rollback()
        result = future.result(timeout=10)
    entries = trace.selected('member')
    fences = [entry for entry in entries if 'app.lock_top_remote_catalog_identity(' in entry['sql']]
    retained_calls = [entry for entry in entries if 'app.retain_top_remote_acquisition(' in entry['sql']]
    assert len(fences) == len(retained_calls) == 2 and all(entry['completed'] for entry in fences)
    assert max(entry['order'] for entry in fences) < min(entry['order'] for entry in retained_calls)
    assert [entry['params'][-1] for entry in retained_calls] == sorted(row[3] for row in identities)
    assert mixed.rows('album_top_remote_admissions') == admissions
    assert [row['title'] for row in mixed.read(result)['items']] == [
        fact.title for fact in (facts[::-1] if reverse else facts)]
    assert len(mixed.remote.calls) == provider_calls


@pytest.mark.parametrize('change', ['delete', 'remap'])
def test_identity_change_after_mapping_preserves_conflict_and_atomic_rollback(mixed, identities, change):
    identity = identities[0]
    top, _ = mixed.db.create(refs=[])
    acquired = mixed.acquire(top, facts=evidence(mbid=identity[2]))
    command = mixed.command('add', top, selections=[pending(acquired)])
    before = mixed.snapshot()
    changed = []

    def before_fence(entry, connection):
        if 'app.lock_top_remote_catalog_identity(' not in entry['sql'] or changed:
            return
        # A trusted concurrent writer changes only this fixture's exact mapping,
        # after the real mapper SELECT and before the real definer SELECT.
        with mixed.db.connect() as writer:
            if change == 'delete':
                writer.execute('''delete from catalog.release_group_provider_identities
                    where provider=%s and entity_kind=%s and external_id=%s and catalog_ref=%s''', identity)
            else:
                writer.execute('''update catalog.release_group_provider_identities set catalog_ref=%s
                    where provider=%s and entity_kind=%s and external_id=%s and catalog_ref=%s''',
                    (identities[1][3], *identity))
        changed.append(True)

    try:
        with trace_owner(mixed) as trace:
            trace.before = before_fence
            assert_error(lambda: mixed.execute(command), 'identity_conflict', 409)
        assert changed == [True]
    finally:
        if changed:
            with mixed.db.connect() as writer:
                if change == 'delete':
                    writer.execute('''insert into catalog.release_group_provider_identities
                        (provider,entity_kind,external_id,catalog_ref) values(%s,%s,%s,%s)''', identity)
                else:
                    writer.execute('''update catalog.release_group_provider_identities set catalog_ref=%s
                        where provider=%s and entity_kind=%s and external_id=%s''', (identity[3], *identity[:3]))
    assert mixed.snapshot() == before
