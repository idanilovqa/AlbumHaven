"""Source-authored terminal-closure regressions; no execution claim.

Use actual deferred checks, restricted runtime statements and savepoints. These
SQL-only excluded/empty cases require no image decoder or platform probe. A few
explicit migrator-only mutations isolate guards for tables whose runtime role
already lacks UPDATE/DELETE/INSERT; no privilege or trigger is changed.
"""
from contextlib import contextmanager
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest

from tests.py.test_top_artwork_publication_retention_postgres import (
    publication_case, db, urls, runtime, rows_for, durable_snapshot, CONTEXT,
)
from tests.py.test_top_artwork_publication_seals_postgres import (
    build_through_mapping, old_sealed_publication,
)


@contextmanager
def setup_transaction(case):
    with case.db.connect() as connection:
        connection.execute("set local lock_timeout='5s'")
        connection.execute("set local statement_timeout='120s'")
        assert connection.execute('select rolsuper from pg_roles where rolname=current_user').fetchone()['rolsuper'] is False
        yield connection


def drained_build(case, connection, staged):
    build = build_through_mapping(case, connection, staged)
    case.seal(connection, build)
    case.point(connection, build)
    case.receipt(connection, build)
    case.consume(connection, build)
    attested = connection.execute('''select c.build_xid=pg_current_xact_id() as current_build,
            c.seal_digest,c.removed_items from app.album_top_artwork_publication_consumptions c
        where c.publication_ref=%s''', (build['ref'],)).fetchone()
    assert attested == {'current_build': True, 'seal_digest': build['seal_digest'],
                        'removed_items': len(build['final'])}
    # This is the regression prerequisite: all INSERT finalizers have run
    # successfully before any adversarial later statement is attempted.
    connection.execute('set constraints all immediate')
    return build


def transaction_state(case, connection):
    tables = ('album_lists', 'album_list_items', 'album_list_item_publication_sources',
              'album_list_operations', 'shared_links', 'album_top_artwork_preparations',
              'album_top_artwork_preparation_items', 'album_top_artwork_draft_items',
              'album_top_artwork_publication_consumptions')
    state = {table: rows_for(case, connection, table) for table in tables}
    state['remote_sources'] = connection.execute('''select * from app.album_list_item_remote_sources
        where library_id=%s order by top_ref,item_ref''', (case.db.library,)).fetchall()
    state['budgets'] = connection.execute('''select * from app.album_top_artwork_budgets
        where owner_account_id=%s order by scope_ref''', (case.db.owner.account_id,)).fetchall()
    return state


def reject_without_damage(case, connection, statement, parameters):
    before = transaction_state(case, connection)
    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState) as caught:
        with connection.transaction():
            connection.execute(statement, parameters)
    assert caught.value.diag.constraint_name == 'top_artwork_publication_closure'
    assert transaction_state(case, connection) == before


@pytest.mark.parametrize('mutation', [
    'top_title', 'top_description', 'top_revision', 'top_next_position', 'top_deleted',
    'top_owner', 'top_library', 'top_ref', 'top_ref_in', 'link_revoke', 'link_redirect',
    'link_ref', 'link_revision', 'link_library', 'link_insert', 'link_scope_out', 'link_scope_in', 'item_delete', 'item_insert',
    'item_ref', 'item_catalog', 'item_library', 'item_original', 'item_curator',
    'item_scope_out', 'item_scope_in', 'source_delete', 'source_insert',
    'source_local', 'source_identity', 'source_item', 'source_library', 'source_catalog', 'source_scope_out', 'source_scope_in',
])
def test_drained_closure_rejects_runtime_mutation_and_still_commits(publication_case, mutation):
    case = publication_case.build(2, excluded=(0, 1))
    other, _ = case.db.create(refs=case.catalog_refs)
    with runtime(case) as connection:
        prior = old_sealed_publication(case, connection)
        connection.execute("insert into app.shared_links(ref,top_ref,library_id,state,link_revision) values(%s,%s,%s,'revoked',1)",
                           (str(uuid4()), other['top_ref'], case.db.library))
        other_item = connection.execute('''select * from app.album_list_items
            where top_ref=%s order by curator_position limit 1''', (other['top_ref'],)).fetchone()
        item = case.items[0]
        connection.execute('''insert into app.album_list_item_publication_sources
            (top_ref,item_ref,library_id,catalog_ref,selected_local_album_id,selected_source_ref)
            values(%s,%s,%s,%s,%s,%s)''',
            (other['top_ref'], other_item['ref'], case.db.library, item['album_ref'],
             item['selected_local_album_id'], item['selected_source_ref']))
    staged = case.stage()
    with runtime(case) as connection:
        build = drained_build(case, connection, staged)
        top, item = case.top['top_ref'], build['final'][0]['item_ref']
        statements = {
            'top_title': ('update app.album_lists set title=%s where ref=%s', ('After consume', top)),
            'top_description': ('update app.album_lists set description=%s where ref=%s', ('After consume', top)),
            'top_revision': ('update app.album_lists set revision=revision+1 where ref=%s', (top,)),
            'top_next_position': ('update app.album_lists set next_original_position=next_original_position+1 where ref=%s', (top,)),
            'top_deleted': ('update app.album_lists set deleted_at=clock_timestamp() where ref=%s', (top,)),
            'top_owner': ('update app.album_lists set owner_account_id=owner_account_id+1000000 where ref=%s', (top,)),
            'top_library': ('update app.album_lists set library_id=library_id+1000000 where ref=%s', (top,)),
            'top_ref': ('update app.album_lists set ref=%s where ref=%s', (str(uuid4()), top)),
            'top_ref_in': ('update app.album_lists set ref=%s where ref=%s', (top, other['top_ref'])),
            'link_revoke': ("update app.shared_links set state='revoked',active_publication_ref=null where top_ref=%s", (top,)),
            'link_redirect': ('update app.shared_links set active_publication_ref=%s where top_ref=%s', (prior, top)),
            'link_insert': ("insert into app.shared_links(ref,top_ref,library_id,state,link_revision) values(%s,%s,%s,'revoked',1)", (str(uuid4()), top, case.db.library)),
            'link_library': ('update app.shared_links set library_id=library_id+1000000 where top_ref=%s', (top,)),
            'link_scope_in': ('update app.shared_links set top_ref=%s where top_ref=%s', (top, other['top_ref'])),
            'link_ref': ('update app.shared_links set ref=%s where top_ref=%s', (str(uuid4()), top)),
            'link_revision': ('update app.shared_links set link_revision=link_revision+1 where top_ref=%s', (top,)),
            'link_scope_out': ('update app.shared_links set top_ref=%s where top_ref=%s', (other['top_ref'], top)),
            'item_delete': ('delete from app.album_list_items where ref=%s', (item,)),
            'item_insert': ('''insert into app.album_list_items(ref,top_ref,library_id,catalog_ref,original_position,curator_position)
                select %s,top_ref,library_id,catalog_ref,original_position+100,curator_position+100
                from app.album_list_items where ref=%s''', (str(uuid4()), item)),
            'item_ref': ('update app.album_list_items set ref=%s where ref=%s', (str(uuid4()), item)),
            'item_catalog': ('update app.album_list_items set catalog_ref=%s where ref=%s', (str(uuid4()), item)),
            'item_library': ('update app.album_list_items set library_id=library_id+1000000 where ref=%s', (item,)),
            'item_original': ('update app.album_list_items set original_position=original_position+100 where ref=%s', (item,)),
            'item_curator': ('update app.album_list_items set curator_position=curator_position+100 where ref=%s', (item,)),
            'item_scope_out': ('update app.album_list_items set top_ref=%s where ref=%s', (other['top_ref'], item)),
            'item_scope_in': ('update app.album_list_items set top_ref=%s where ref=%s', (top, other_item['ref'])),
            'source_delete': ('delete from app.album_list_item_publication_sources where top_ref=%s and item_ref=%s', (top, item)),
            'source_insert': ('''insert into app.album_list_item_publication_sources
                select * from app.album_list_item_publication_sources where top_ref=%s and item_ref=%s''', (top, item)),
            'source_item': ('update app.album_list_item_publication_sources set item_ref=%s where top_ref=%s', (str(uuid4()), top)),
            'source_library': ('update app.album_list_item_publication_sources set library_id=library_id+1000000 where top_ref=%s', (top,)),
            'source_catalog': ('update app.album_list_item_publication_sources set catalog_ref=%s where top_ref=%s', (str(uuid4()), top)),
            'source_local': ('update app.album_list_item_publication_sources set selected_local_album_id=selected_local_album_id+1000000 where top_ref=%s', (top,)),
            'source_identity': ('update app.album_list_item_publication_sources set selected_source_ref=%s where top_ref=%s', (str(uuid4()), top)),
            'source_scope_out': ('update app.album_list_item_publication_sources set top_ref=%s where top_ref=%s', (other['top_ref'], top)),
            'source_scope_in': ('update app.album_list_item_publication_sources set top_ref=%s where top_ref=%s', (top, other['top_ref'])),
        }
        reject_without_damage(case, connection, *statements[mutation])
        # Unrelated working state remains writable in the SAME transaction.
        connection.execute('update app.album_lists set title=%s where ref=%s', ('Other Top stays editable', other['top_ref']))
        connection.execute('update app.album_lists set updated_at=clock_timestamp() where ref=%s', (top,))
        connection.execute('update app.album_list_items set curator_position=curator_position where top_ref=%s', (top,))
    # runtime() performed a real successful COMMIT after the rejected savepoint.
    state = durable_snapshot(case)
    assert len(state['album_top_artwork_publication_consumptions']) == 1
    link = next(row for row in state['shared_links'] if str(row['top_ref']) == top)
    assert link['state'] == 'enabled' and str(link['active_publication_ref']) == build['ref']
    assert len([row for row in state['album_list_items'] if str(row['top_ref']) == top]) == 2


@pytest.mark.parametrize('mutation', [
    'receipt_delete', 'receipt_key_out', 'receipt_key_in', 'receipt_actor', 'receipt_library',
    'receipt_session', 'receipt_action', 'receipt_top', 'receipt_digest', 'receipt_publication',
    'receipt_json', 'remote_insert', 'top_delete', 'link_delete',
])
def test_drained_closure_protects_exact_receipt_and_remote_absence_as_trusted_writer(publication_case, mutation):
    case = publication_case.build(1, excluded=(0,))
    staged = case.stage()
    with setup_transaction(case) as connection:
        build = drained_build(case, connection, staged)
        key = build['operation_key']
        other_key = str(uuid4())
        case.receipt(connection, build, key=other_key)
        owner, library = case.db.owner.account_id, case.db.library
        target = ' where actor_account_id=%s and library_id=%s and request_key=%s'
        identities = (owner, library, key)
        fields = {
            'receipt_actor': 'actor_account_id=actor_account_id+1000000',
            'receipt_library': 'library_id=library_id+1000000',
            'receipt_session': 'original_session_id=original_session_id+1',
            'receipt_action': "action='save'",
            'receipt_digest': "command_digest=repeat('f',64)",
            'receipt_publication': 'publication_ref=null',
            'receipt_json': "receipt=jsonb_set(receipt,'{revision}','\"999\"'::jsonb)",
        }
        if mutation in fields:
            statement, parameters = 'update app.album_list_operations set ' + fields[mutation] + target, identities
        elif mutation == 'receipt_top':
            statement, parameters = 'update app.album_list_operations set top_ref=%s' + target, (str(uuid4()), *identities)
        elif mutation == 'receipt_delete':
            statement, parameters = 'delete from app.album_list_operations' + target, identities
        elif mutation == 'receipt_key_out':
            statement, parameters = 'update app.album_list_operations set request_key=%s' + target, (str(uuid4()), *identities)
        elif mutation == 'receipt_key_in':
            statement, parameters = 'update app.album_list_operations set request_key=%s' + target, (key, owner, library, other_key)
        elif mutation == 'remote_insert':
            row = build['final'][0]
            # The closure trigger runs before the existing exclusivity/FK
            # checks. This is a rejection input, never a valid remote admission.
            statement = '''insert into app.album_list_item_remote_sources
                (top_ref,item_ref,library_id,owner_account_id,catalog_ref,admission_ref)
                values(%s,%s,%s,%s,%s,%s)'''
            parameters = (case.top['top_ref'], row['item_ref'], library, owner, row['album_ref'], str(uuid4()))
        elif mutation == 'link_delete':
            statement, parameters = 'delete from app.shared_links where top_ref=%s', (case.top['top_ref'],)
        else:
            statement, parameters = 'delete from app.album_lists where ref=%s', (case.top['top_ref'],)
        reject_without_damage(case, connection, statement, parameters)
        # Unrelated receipt keys and ignored receipt metadata are not frozen.
        connection.execute('update app.album_list_operations set command_digest=%s' + target,
                           ('e' * 64, owner, library, other_key))
        connection.execute('update app.album_list_operations set created_at=clock_timestamp()' + target, identities)
    assert len(durable_snapshot(case)['album_top_artwork_publication_consumptions']) == 1


@pytest.mark.parametrize('kind', ['saved', 'draft'])
def test_drained_closure_rejects_consumed_preparation_uuid_with_a_fresh_key(publication_case, kind):
    case = publication_case.build(0)
    staged = case.stage(kind)
    with runtime(case) as connection:
        build = drained_build(case, connection, staged)
        new_revision = build['top']['revision'] + 1
        statement = 'select app.start_top_artwork_preparation(' + ','.join(['%s'] * 11) + ')'
        arguments = (staged['ref'], case.top['top_ref'], case.db.library, case.db.owner.account_id,
                     case.db.owner.session_id, CONTEXT, new_revision, str(uuid4()), 'a' * 64,
                     Jsonb([]), staged['header']['request_generation'])
        reject_without_damage(case, connection, statement, arguments)
        fresh = str(uuid4())
        assert str(connection.execute(statement, (fresh, *arguments[1:])).fetchone()['start_top_artwork_preparation']) == fresh
        assert connection.execute('select 1 from app.album_top_artwork_preparations where ref=%s', (staged['ref'],)).fetchone() is None
    assert len(durable_snapshot(case)['album_top_artwork_publication_consumptions']) == 1


def test_later_transactions_can_edit_working_state_and_revoke_drained_publication(publication_case):
    case = publication_case.build(1, excluded=(0,))
    staged = case.stage()
    with runtime(case) as connection:
        build = drained_build(case, connection, staged)
    retained = durable_snapshot(case)
    with runtime(case) as connection:
        connection.execute('update app.album_lists set title=%s,revision=revision+1 where ref=%s',
                           ('Later independent edit', case.top['top_ref']))
        connection.execute('delete from app.album_list_items where top_ref=%s', (case.top['top_ref'],))
        connection.execute("update app.shared_links set state='revoked',active_publication_ref=null,link_revision=link_revision+1 where top_ref=%s",
                           (case.top['top_ref'],))
    after = durable_snapshot(case)
    for table in ('album_top_artwork_publication_lineage', 'album_top_artwork_publication_rows',
                  'album_top_artwork_publication_consumptions', 'album_list_publications', 'seals'):
        assert after[table] == retained[table]
    assert after['album_list_items'] == []
    assert after['shared_links'][0]['state'] == 'revoked'
    assert str(after['album_top_artwork_publication_consumptions'][0]['publication_ref']) == build['ref']


@pytest.mark.parametrize('kind', ['saved', 'draft'])
def test_drained_closure_rejects_direct_staging_resurrection_before_foreign_key(publication_case, kind):
    case = publication_case.build(1, excluded=(0,))
    staged = case.stage(kind)
    table = 'album_top_artwork_preparation_items' if kind == 'saved' else 'album_top_artwork_draft_items'
    with setup_transaction(case) as connection:
        old_header = connection.execute('''select to_jsonb(p) as value
            from app.album_top_artwork_preparations p where ref=%s''', (staged['ref'],)).fetchone()['value']
        old_child = connection.execute(f'''select to_jsonb(i) as value
            from app.{table} i where preparation_ref=%s''', (staged['ref'],)).fetchone()['value']
        build = drained_build(case, connection, staged)
        old_header['start_request_key'] = str(uuid4())
        reject_without_damage(case, connection,
            '''insert into app.album_top_artwork_preparations
               select * from jsonb_populate_record(null::app.album_top_artwork_preparations,%s)''',
            (Jsonb(old_header),))
        # All row values are the genuine prior staging row. The header remains
        # absent; assert our BEFORE guard, not a later generic FK failure.
        reject_without_damage(case, connection,
            f'insert into app.{table} select * from jsonb_populate_record(null::app.{table},%s)',
            (Jsonb(old_child),))
    assert len(durable_snapshot(case)['album_top_artwork_publication_consumptions']) == 1


def test_drained_closure_checks_new_preparation_scope_on_identity_update(publication_case):
    case = publication_case.build(0)
    staged = case.stage()
    with setup_transaction(case) as connection:
        build = drained_build(case, connection, staged)
        fresh = str(uuid4())
        connection.execute('select app.start_top_artwork_preparation(' + ','.join(['%s'] * 11) + ')',
            (fresh, case.top['top_ref'], case.db.library, case.db.owner.account_id,
             case.db.owner.session_id, CONTEXT, build['top']['revision'] + 1, str(uuid4()),
             'a' * 64, Jsonb([]), staged['header']['request_generation']))
        reject_without_damage(case, connection,
            'update app.album_top_artwork_preparations set ref=%s where ref=%s',
            (staged['ref'], fresh))
    assert len(durable_snapshot(case)['album_top_artwork_publication_consumptions']) == 1
