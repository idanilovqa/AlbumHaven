"""Real PostgreSQL retained-history, exact-source, and runtime-privilege contracts.

Source-only companion: the root executor runs this in its admitted synthetic DB.
No provider traffic, production configuration, or quota/accounting substitutes.
"""
from uuid import uuid4

import psycopg
import pytest

from tests.py.postgres_runtime_role_contract import assert_runtime_role

from tests.py.remote_top_retention_postgres_support import (
    ATTACH, CLEAR, COPY, LOCK, READ, RETAIN, SIGNATURES, B_SIGNATURES, CONTEXT, destination, evidence,
    invoke, payload, retained, remote, db, urls, runtime, sql_error,
)


def setup_retained(case):
    top = case.top()
    pending = case.pending(top)
    catalog = case.mapping(pending)
    admission = case.retain(top, pending, catalog)
    return top, pending, catalog, admission


def lock_args(case, top, catalog, admission, version):
    return [admission, version, top['top_ref'], case.db.library, case.db.owner.account_id,
            int(top['revision']), catalog]


def copy_args(case, source, source_item, admission, destination_top, actor=None):
    actor = actor or case.db.owner
    row = case.row(admission)
    return [str(uuid4()), source['top_ref'], int(source['revision']), source_item, admission,
            row['evidence_version'], destination_top['top_ref'], case.db.library, actor.account_id,
            int(destination_top['revision']), actor.account_id, actor.session_id, str(row['catalog_ref'])]


def test_runtime_is_select_and_six_narrow_non_superuser_definer_apis(retained):
    case = retained
    with runtime(case.db) as connection:
        runtime_role = assert_runtime_role(connection, case.db)
    with case.db.connect() as connection:
        for table in ('album_top_remote_acquisitions', 'album_top_remote_admissions',
                      'album_list_item_remote_sources', 'album_top_remote_retained_budgets'):
            for privilege in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'):
                actual = connection.execute('''select has_table_privilege('album_haven_app',%s,%s) as runtime,
                    has_table_privilege(%s,%s,%s) as connected,
                    has_table_privilege('album_haven_readonly',%s,%s) as readonly''',
                    ('app.' + table, privilege, runtime_role, 'app.' + table, privilege, 'app.' + table, privilege)).fetchone()
                assert actual == {'runtime': privilege == 'SELECT', 'connected': privilege == 'SELECT', 'readonly': False}
        assert len(SIGNATURES) == 6 and len(B_SIGNATURES) == 3
        for name, arguments in {**SIGNATURES, **B_SIGNATURES}.items():
            signature = name + '(' + arguments + ')'
            row = connection.execute('''select p.prosecdef,p.proconfig,r.rolsuper,
                has_function_privilege('album_haven_app',p.oid,'EXECUTE') as runtime,
                has_function_privilege(%s,p.oid,'EXECUTE') as connected,
                has_function_privilege('album_haven_readonly',p.oid,'EXECUTE') as readonly,
                exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0) as public
                from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=%s::regprocedure''', (runtime_role, signature)).fetchone()
            assert row == {'prosecdef': True, 'proconfig': ['search_path=pg_catalog'],
                           'rolsuper': False, 'runtime': True, 'connected': True, 'readonly': False, 'public': False}
        for signature in ('app.charge_top_remote_retention()', 'app.guard_top_source_exclusivity()',
                          'app.lock_top_remote_membership_scope(uuid,bigint,bigint,bigint)'):
            for role in dict.fromkeys(('album_haven_app', runtime_role)):
                assert connection.execute("select has_function_privilege(%s,%s,'EXECUTE') as allowed",
                                          (role, signature)).fetchone()['allowed'] is False
    with runtime(case.db) as connection:
        assert assert_runtime_role(connection, case.db) == runtime_role
        for table in ('album_top_remote_admissions', 'album_list_item_remote_sources', 'album_top_remote_retained_budgets'):
            sql_error(connection, '42501', lambda table=table: connection.execute('delete from app.' + table + ' where false'))
            sql_error(connection, '42501', lambda table=table: connection.execute('select * from app.' + table + ' for share'))


def test_retention_copies_exact_stored_facts_lineage_and_zero_cost_active_reuse(retained):
    top, pending, catalog, admission = setup_retained(retained)
    row = retained.row(admission)
    source = retained.remote.rows()[0]
    assert row['admission_kind'] == 'acquisition'
    assert row['copied_from_admission_ref'] is row['copy_actor_account_id'] is row['copy_session_id'] is None
    for field in ('provider', 'entity_kind', 'external_id', 'evidence_version', 'title',
                  'artist_display', 'first_release_date', 'primary_type'):
        assert row[field] == source[field]
    assert row['original_acquisition_ref'] == source['ref']
    assert row['original_session_id'] == source['original_session_id']
    assert row['acquired_at'] == source['created_at']
    assert row['admission_deadline'] == source['expires_at']
    assert row['original_context_ref'] == CONTEXT
    pending_before = retained.remote.c2_state()
    before = retained.counts(top)
    assert before == {'admission_count': 1, 'facts_bytes': source['facts_bytes']}
    assert retained.retain(top, pending, catalog) == admission
    assert retained.counts(top) == before
    assert retained.remote.c2_state() == pending_before
    assert pending_before['album_top_remote_attempts'][0]['state'] == 'pending'


@pytest.mark.parametrize('index,value,constraint', [
    (1, lambda: str(uuid4()), 'top_remote_expired'), (2, lambda: 'b' * 64, 'top_remote_expired'),
    (4, lambda: -1, 'top_remote_scope'), (5, lambda: -1, 'top_remote_scope'),
    (6, lambda: -1, 'top_remote_scope'), (7, lambda: -1, 'top_remote_scope'),
    (8, lambda: 'b' * 64, 'top_remote_expired'), (9, lambda: 'create', 'top_remote_expired'),
    (10, lambda: str(uuid4()), 'top_remote_scope'), (11, lambda: 2, 'top_remote_scope'),
    (12, lambda: str(uuid4()), 'top_remote_identity'),
])
def test_pending_binding_rejection_has_no_retention_or_counter_side_effect(retained, index, value, constraint):
    case = retained
    top = case.top(); pending = case.pending(top); catalog = case.mapping(pending)
    args = case.retain_args(top, pending, catalog); args[index] = value()
    c2_before = case.remote.c2_state()
    with runtime(case.db) as connection:
        case.locks(connection, top, pending=pending)
        sql_error(connection, '55000', lambda: invoke(connection, RETAIN, args), constraint=constraint)
    assert case.counts() == {'admission_count': 0, 'facts_bytes': 0}
    assert case.remote.c2_state() == c2_before


def test_create_pending_binds_original_draft_and_actual_destination_top(retained):
    case = retained
    top = case.top(); pending = case.pending(top, kind='create'); catalog = case.mapping(pending)
    args = case.retain_args(top, pending, catalog)
    with runtime(case.db) as connection:
        case.locks(connection, top, pending=pending)
        bad = list(args); bad[10] = str(uuid4())
        sql_error(connection, '55000', lambda: invoke(connection, RETAIN, bad), constraint='top_remote_expired')
        admission = str(invoke(connection, RETAIN, args))
    row = case.row(admission)
    assert str(row['top_ref']) == top['top_ref']
    assert str(row['original_destination_ref']) == pending['destination']['draft_ref']
    assert row['original_destination_kind'] == 'create'


# The exact expired expansion is in remote_consumption_expiry_acceptance.py (unexecuted).
@pytest.mark.parametrize('state', ['retired'])
def test_expired_or_retired_pending_never_enters_retained_history(retained, state):
    case = retained; top = case.top()
    pending = case.pending(top)
    case.remote.retire_pending(pending['acquisition_ref'])
    before = case.remote.c2_state()
    catalog = case.mapping(pending)
    with runtime(case.db) as connection:
        case.locks(connection, top, pending_budget=True)
        sql_error(connection, '55000', lambda: invoke(connection, RETAIN, case.retain_args(top, pending, catalog)), constraint='top_remote_expired')
    assert case.counts()['admission_count'] == 0
    assert case.remote.c2_state() == before


def test_new_facts_cannot_replace_first_same_top_catalog_and_retirement_cannot_be_revived(retained):
    case = retained; top, pending, catalog, admission = setup_retained(case)
    newer = case.pending(top, facts=evidence(mbid=case.remote.facts.release_group_id, title='Changed remote title'))
    with runtime(case.db) as connection:
        case.locks(connection, top, pending=newer)
        sql_error(connection, '55000', lambda: invoke(connection, RETAIN, case.retain_args(top, newer, catalog)), constraint='top_remote_retained_conflict')
    with case.db.connect() as connection:
        connection.execute('update app.album_top_remote_admissions set retired_at=clock_timestamp() where ref=%s', (admission,))
        sql_error(connection, '55000', lambda: connection.execute('update app.album_top_remote_admissions set retired_at=null where ref=%s', (admission,)), constraint='top_remote_facts_immutable')
    with runtime(case.db) as connection:
        case.locks(connection, top, pending=pending)
        sql_error(connection, '55000', lambda: invoke(connection, RETAIN, case.retain_args(top, pending, catalog)), constraint='top_remote_retained_conflict')
        sql_error(connection, '55000', lambda: invoke(connection, LOCK, lock_args(case, top, catalog, admission, pending['evidence_version'])), constraint='top_remote_retained_unavailable')
    assert case.counts(top)['admission_count'] == 1


def test_removed_member_readds_active_expired_original_without_pending_or_quota(retained):
    case = retained; top = case.top(); source = case.seed(top, 1)
    admission, catalog = str(source['ref']), str(source['catalog_ref'])
    item = case.member(top, catalog, admission, source['evidence_version'])
    before = case.counts(top)
    with runtime(case.db) as connection:
        case.locks(connection, top)
        connection.execute('delete from app.album_list_items where ref=%s', (item,))
        assert connection.execute('select * from app.album_list_item_remote_sources where item_ref=%s', (item,)).fetchone() is None
        assert str(invoke(connection, LOCK, lock_args(case, top, catalog, admission, source['evidence_version']))) == admission
    case.member(top, catalog, admission, source['evidence_version'])
    assert case.counts(top) == before
    assert case.row(admission)['admission_deadline'] < case.db.now


@pytest.mark.parametrize('index,value', [(0, lambda: str(uuid4())), (1, lambda: 'b' * 64), (6, lambda: str(uuid4()))])
def test_retained_selector_exact_reference_version_catalog_required(retained, index, value):
    case = retained; top, pending, catalog, admission = setup_retained(case)
    args = lock_args(case, top, catalog, admission, pending['evidence_version']); args[index] = value()
    with runtime(case.db) as connection:
        case.locks(connection, top)
        sql_error(connection, '55000', lambda: invoke(connection, LOCK, args), constraint='top_remote_retained_unavailable')


def test_top_history_exact_20000_boundary_retirement_and_removal_do_not_refund(retained):
    case = retained; top = case.top(); pending = case.pending(top); catalog = case.mapping(pending)
    case.seed(top, 19999, retired=True)
    admission = case.retain(top, pending, catalog)
    assert case.counts(top)['admission_count'] == 20000
    assert case.retain(top, pending, catalog) == admission
    other = case.pending(top, facts=evidence(mbid=str(uuid4())))
    other_catalog = case.mapping(other, case.db.album_refs[1])
    with runtime(case.db) as connection:
        case.locks(connection, top, pending=other)
        sql_error(connection, '55000', lambda: invoke(connection, RETAIN, case.retain_args(top, other, other_catalog)), constraint='top_remote_retained_budget')
    assert case.counts(top)['admission_count'] == 20000


def test_owner_history_exact_100000_boundary_across_tops(retained):
    case = retained; target = case.top(); pending = case.pending(target); catalog = case.mapping(pending)
    for count in (20000, 20000, 20000, 20000, 19999):
        case.seed(case.top(), count, retired=True)
    case.retain(target, pending, catalog)
    assert case.counts()['admission_count'] == 100000
    another = case.top(); acquisition = case.pending(another)
    with runtime(case.db) as connection:
        case.locks(connection, another, pending=acquisition)
        sql_error(connection, '55000', lambda: invoke(connection, RETAIN, case.retain_args(another, acquisition, catalog)), constraint='top_remote_retained_budget')
    assert case.counts(another)['admission_count'] == 0


@pytest.mark.parametrize('scope', ['top', 'owner'])
def test_exact_retained_byte_budget_accepts_last_facts_and_rejects_growth(retained, scope):
    case = retained; target = case.top(); pending = case.pending(target); catalog = case.mapping(pending)
    facts_bytes = case.remote.rows()[0]['facts_bytes']
    if scope == 'top':
        case.seed_bytes(target, 67108864 - facts_bytes)
    else:
        for _ in range(7):
            case.seed_bytes(case.top(), 67108864)
        case.seed_bytes(case.top(), 67108864 - facts_bytes)
    admission = case.retain(target, pending, catalog)
    counts = case.counts(target if scope == 'top' else None)
    assert counts['facts_bytes'] == (67108864 if scope == 'top' else 536870912)
    assert case.retain(target, pending, catalog) == admission
    other = case.pending(target, facts=evidence(mbid=str(uuid4())))
    other_catalog = case.mapping(other, case.db.album_refs[1])
    with runtime(case.db) as connection:
        case.locks(connection, target, pending=other)
        sql_error(connection, '55000', lambda: invoke(connection, RETAIN, case.retain_args(target, other, other_catalog)), constraint='top_remote_retained_budget')
    assert case.counts(target if scope == 'top' else None) == counts


def test_copy_expired_original_preserves_lineage_with_independent_owner_and_copy_time(retained):
    case = retained; source_top = case.top(); source = case.seed(source_top, 1)
    admission, catalog = str(source['ref']), str(source['catalog_ref'])
    item = case.member(source_top, catalog, admission, source['evidence_version'])
    with case.db.connect() as connection:
        actor = case.db.member(connection, case.db.actor(connection), case.db.library)
    target = case.top(actor)
    with runtime(case.db) as connection:
        connection.execute('select id from app.accounts where id=any(%s) order by id for update',
                           (sorted({actor.account_id, source['initiating_actor_account_id']}),))
        connection.execute('select ref from app.album_lists where ref=%s for update', (source_top['top_ref'],))
        copied = str(invoke(connection, COPY, copy_args(case, source_top, item, admission, target, actor)))
    row = case.row(copied)
    assert row['admission_kind'] == 'copy' and str(row['copied_from_admission_ref']) == admission
    assert row['owner_account_id'] == row['copy_actor_account_id'] == actor.account_id
    assert row['copy_session_id'] == actor.session_id
    assert row['admitted_at'] > row['admission_deadline']
    for field in ('initiating_actor_account_id', 'original_session_id', 'original_acquisition_ref',
                  'original_destination_kind', 'original_destination_ref', 'original_context_ref',
                  'acquired_at', 'admission_deadline', 'provider', 'entity_kind', 'external_id',
                  'evidence_version', 'title', 'artist_display', 'first_release_date', 'primary_type'):
        assert row[field] == source[field]
    with case.db.connect() as connection:
        connection.execute('update app.album_top_remote_admissions set retired_at=clock_timestamp() where ref=%s', (admission,))
        connection.execute('update app.album_lists set deleted_at=clock_timestamp() where ref=%s', (source_top['top_ref'],))
    with runtime(case.db) as connection:
        case.locks(connection, target, actor)
        assert str(invoke(connection, LOCK, [copied, row['evidence_version'], target['top_ref'], case.db.library,
            actor.account_id, int(target['revision']), catalog])) == copied
    assert case.row(copied) == row


@pytest.mark.parametrize('field', ['admission_kind', 'copied_from_admission_ref', 'copy_actor_account_id', 'copy_session_id', 'admission_deadline'])
def test_copy_lineage_is_immutable_under_original_whole_row_guard(retained, field):
    case = retained; top = case.top(); source = case.seed(top, 1)
    with case.db.connect() as connection:
        values = {'admission_kind': "'copy'", 'copied_from_admission_ref': "'" + str(uuid4()) + "'::uuid",
                  'copy_actor_account_id': str(case.db.owner.account_id), 'copy_session_id': str(case.db.owner.session_id),
                  'admission_deadline': "admission_deadline+interval '1 day'"}
        sql_error(connection, '55000', lambda: connection.execute('update app.album_top_remote_admissions set ' + field + '=' + values[field] + ' where ref=%s',
            (source['ref'],)), constraint='top_remote_facts_immutable')


@pytest.mark.parametrize('change', ['revision', 'item', 'admission', 'catalog', 'version', 'retired', 'removed'])
def test_copy_requires_exact_current_source_member_bridge_admission(retained, change):
    case = retained; top, pending, catalog, admission = setup_retained(case)
    item = case.member(top, catalog, admission, pending['evidence_version']); target = case.top()
    args = copy_args(case, top, item, admission, target)
    if change in {'revision', 'item', 'admission', 'catalog', 'version'}:
        index = {'revision': 2, 'item': 3, 'admission': 4, 'catalog': 12, 'version': 5}[change]
        args[index] = 2 if change == 'revision' else 'b' * 64 if change == 'version' else str(uuid4())
    else:
        with case.db.connect() as connection:
            if change == 'retired':
                connection.execute('update app.album_top_remote_admissions set retired_at=clock_timestamp() where ref=%s', (admission,))
            else:
                connection.execute('delete from app.album_list_items where ref=%s', (item,))
    with runtime(case.db) as connection:
        case.locks(connection, top)
        sql_error(connection, '55000', lambda: invoke(connection, COPY, args),
            constraint='top_remote_scope' if change == 'revision' else 'top_remote_retained_unavailable')
    assert case.counts(target)['admission_count'] == 0


def test_pending_and_retained_share_fences_hold_until_outer_commit(retained):
    case = retained; top = case.top(); pending = case.pending(top); catalog = case.mapping(pending)
    with runtime(case.db) as first:
        case.locks(first, top, pending=pending)
        admission = str(invoke(first, RETAIN, case.retain_args(top, pending, catalog)))
        with case.db.connect() as other:
            other.execute("set local lock_timeout='150ms'")
            sql_error(other, '55P03', lambda: other.execute('update app.album_top_remote_acquisitions set retired_at=clock_timestamp() where ref=%s',
                (pending['acquisition_ref'],)))
    item = case.member(top, catalog, admission, pending['evidence_version']); target = case.top()
    with runtime(case.db) as first:
        case.locks(first, top)
        copied = str(invoke(first, COPY, copy_args(case, top, item, admission, target)))
        with case.db.connect() as other:
            other.execute("set local lock_timeout='150ms'")
            sql_error(other, '55P03', lambda: other.execute('update app.album_top_remote_admissions set retired_at=clock_timestamp() where ref=%s', (admission,)))
    with case.db.connect() as other:
        other.execute('update app.album_top_remote_admissions set retired_at=clock_timestamp() where ref=%s', (admission,))
    assert case.row(copied)['retired_at'] is None


def test_bidirectional_exclusivity_exact_composites_and_explicit_local_switch(retained):
    case = retained; top, pending, catalog, admission = setup_retained(case)
    item = case.member(top, catalog, admission, pending['evidence_version'])
    album, source = case.local_source(catalog)
    local_args = [top['top_ref'], item, case.db.library, catalog, album, source]
    local_sql = '''insert into app.album_list_item_publication_sources
        (top_ref,item_ref,library_id,catalog_ref,selected_local_album_id,selected_source_ref) values(%s,%s,%s,%s,%s,%s)'''
    with runtime(case.db) as connection:
        case.locks(connection, top)
        sql_error(connection, '23514', lambda: connection.execute(local_sql, local_args), constraint='top_source_exclusive')
        clear = [top['top_ref'], case.db.library, case.db.owner.account_id, int(top['revision']), item, catalog, admission, album, source]
        wrong = list(clear); wrong[-1] = str(uuid4())
        sql_error(connection, '55000', lambda: invoke(connection, CLEAR, wrong), constraint='top_remote_local_unavailable')
        invoke(connection, CLEAR, clear)
        connection.execute(local_sql, local_args)
    with case.db.connect() as connection:
        sql_error(connection, '23514', lambda: connection.execute('''insert into app.album_list_item_remote_sources
            (top_ref,item_ref,library_id,owner_account_id,catalog_ref,admission_ref) values(%s,%s,%s,%s,%s,%s)''',
            (top['top_ref'], item, case.db.library, case.db.owner.account_id, catalog, admission)), constraint='top_source_exclusive')
    with runtime(case.db) as connection:
        case.locks(connection, top)
        invoke(connection, ATTACH, [top['top_ref'], case.db.library, case.db.owner.account_id, 1, item, catalog, admission, pending['evidence_version']])
        assert connection.execute('select * from app.album_list_item_publication_sources where item_ref=%s', (item,)).fetchone() is None
    assert case.counts(top)['admission_count'] == 1


@pytest.mark.parametrize('index', [0, 1, 2, 3, 4, 5])
def test_remote_bridge_rejects_cross_composite_keys(retained, index):
    case = retained; top, pending, catalog, admission = setup_retained(case)
    item = case.member(top, catalog, admission, pending['evidence_version'])
    with case.db.connect() as connection:
        connection.execute('delete from app.album_list_item_remote_sources where item_ref=%s', (item,))
        args = [top['top_ref'], item, case.db.library, case.db.owner.account_id, catalog, admission]
        args[index] = -1 if index in (2, 3) else str(uuid4())
        expected = '23514' if index in (0, 2) else '23503'
        sql_error(connection, expected, lambda: connection.execute('''insert into app.album_list_item_remote_sources
            (top_ref,item_ref,library_id,owner_account_id,catalog_ref,admission_ref) values(%s,%s,%s,%s,%s,%s)''', args))


def test_failed_outer_transaction_rolls_back_admission_member_bridge_and_counters(retained):
    case = retained; top = case.top(); pending = case.pending(top); catalog = case.mapping(pending)
    before = case.db.snapshot()
    c2_before = case.remote.c2_state()
    with pytest.raises(RuntimeError, match='synthetic rollback'):
        with runtime(case.db) as connection:
            case.locks(connection, top, pending=pending)
            admission = invoke(connection, RETAIN, case.retain_args(top, pending, catalog))
            item = str(uuid4())
            connection.execute('''insert into app.album_list_items(ref,top_ref,library_id,catalog_ref,original_position,curator_position)
                values(%s,%s,%s,%s,1,1)''', (item, top['top_ref'], case.db.library, catalog))
            invoke(connection, ATTACH, [top['top_ref'], case.db.library, case.db.owner.account_id, 1, item, catalog, admission, pending['evidence_version']])
            raise RuntimeError('synthetic rollback')
    assert case.db.snapshot() == before and case.remote.c2_state() == c2_before
    assert case.counts() == {'admission_count': 0, 'facts_bytes': 0}
    with case.db.connect() as connection:
        assert connection.execute('select * from app.album_top_remote_admissions where top_ref=%s', (top['top_ref'],)).fetchall() == []


def test_read_fences_share_top_and_retained_row_without_reader_upgrade(retained):
    case = retained; top, pending, catalog, admission = setup_retained(case)
    args = lock_args(case, top, catalog, admission, pending['evidence_version'])
    with runtime(case.db) as first:
        first.execute('select ref from app.album_lists where ref=%s for share', (top['top_ref'],))
        assert str(invoke(first, READ, args)) == admission
        # A separate actual runtime reader can enter while the first holds both
        # SHARE fences. An accidental Top UPDATE upgrade times out here.
        with runtime(case.db) as second:
            second.execute("set local lock_timeout='150ms'")
            second.execute('select ref from app.album_lists where ref=%s for share', (top['top_ref'],))
            assert str(invoke(second, READ, args)) == admission
        with case.db.connect() as retirement:
            retirement.execute("set local lock_timeout='150ms'")
            sql_error(retirement, '55P03', lambda: retirement.execute(
                'update app.album_top_remote_admissions set retired_at=clock_timestamp() where ref=%s', (admission,)))
    with case.db.connect() as retirement:
        retirement.execute('update app.album_top_remote_admissions set retired_at=clock_timestamp() where ref=%s', (admission,))
    with runtime(case.db) as connection:
        sql_error(connection, '55000', lambda: invoke(connection, READ, args), constraint='top_remote_retained_unavailable')


def test_5000_large_unicode_summaries_fit_and_actual_counters_equal_history(retained):
    case = retained; top = case.top()
    case.seed(top, 5000, fact_size=8000)
    assert case.counts(top) == {'admission_count': 5000, 'facts_bytes': 40000000}
    with case.db.connect() as connection:
        totals = connection.execute('''select count(*) as admission_count,sum(app.top_remote_fact_bytes(
            provider,entity_kind,external_id,title,artist_display,first_release_date,primary_type,evidence_version)) as facts_bytes
            from app.album_top_remote_admissions where top_ref=%s''', (top['top_ref'],)).fetchone()
        assert totals == case.counts(top)
        constraint = connection.execute("""select pg_get_constraintdef(oid) as definition from pg_constraint
            where conrelid='app.album_top_remote_admissions'::regclass and conname='top_remote_retained_fact_size'""").fetchone()['definition']
        assert '16384' in constraint and 'top_remote_fact_bytes' in constraint


def test_same_owner_different_tops_share_budget_serialization(retained):
    case = retained
    first_top, second_top = case.top(), case.top()
    first_pending = case.pending(first_top); second_pending = case.pending(second_top)
    catalog = case.mapping(first_pending)
    with runtime(case.db) as first:
        case.locks(first, first_top, pending=first_pending)
        invoke(first, RETAIN, case.retain_args(first_top, first_pending, catalog))
        with runtime(case.db) as second:
            second.execute("set local lock_timeout='150ms'")
            # The second exact Top is unrelated. It is the shared destination
            # owner account lock, acquired before its Top, that must block.
            sql_error(second, '55P03', lambda: invoke(second, RETAIN,
                case.retain_args(second_top, second_pending, catalog)))
    case.retain(second_top, second_pending, catalog)
    assert case.counts()['admission_count'] == 2


def test_ignored_duplicate_insert_does_not_charge_history_twice(retained):
    case = retained; top = case.top(); source = case.seed(top, 1)
    before = case.counts(top)
    with case.db.connect() as connection:
        connection.execute('''insert into app.album_top_remote_admissions
            select * from app.album_top_remote_admissions where ref=%s on conflict(ref) do nothing''', (source['ref'],))
    assert case.counts(top) == before
