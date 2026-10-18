"""Versioned seals, immutable closure, real deferred commit and runtime ACLs.

This file exercises the additive C-1 SQL surface in the existing admitted real
PostgreSQL database. It deliberately does not activate C-2, D or native UI, nor
claim canonical/HMAC/current-policy validation from a trusted SQL writer. No test
result is asserted merely because source authoring or static review succeeded.
"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from hashlib import sha256
from queue import Queue
from time import monotonic, sleep
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import pytest

from tests.py.test_top_artwork_publication_retention_postgres import (
    ADMIT, MAP, SEAL, CONSUME, CONSUMED, CONTEXT, ZERO, POSIX_CAPTURE, RETAINED,
    publication_case, db, urls, runtime, uncommitted, durable_snapshot, preparation_header,
    assert_staging_budget, command,
)
from tests.py.postgres_runtime_role_contract import assert_runtime_role


def raw_header(case, connection, *, version=2, fingerprint=None):
    latest = connection.execute('''select coalesce(max(publication_revision),0) as n
        from app.album_list_publications where top_ref=%s''', (case.top['top_ref'],)).fetchone()['n']
    ref = str(uuid4())
    header = [ref, case.top['top_ref'], case.db.library, latest + 1,
              int(case.top['revision']) + 1, case.db.owner.account_id,
              'Historical header', 'No artwork interpretation', version, fingerprint or '7' * 64]
    connection.execute('''insert into app.album_list_publications
        (ref,top_ref,library_id,publication_revision,approved_top_revision,approved_by_account_id,
         title,description,contract_version,content_fingerprint)
        values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''', header)
    return ref, header


def old_sealed_publication(case, connection):
    ref, header = raw_header(case, connection, version=1)
    connection.execute('select app.seal_album_list_publication(%s,0,%s)',
                       (ref, Jsonb(['album-list-publication-seal-v1', header, []])))
    return ref


def build_through_mapping(case, connection, staged):
    build = case.start_build(connection, staged)
    case.apply(connection, build)
    case.mapping(connection, build)
    case.map_pages(connection, build)
    return build


def logical_fingerprint(connection, lineage, rows):
    """Independent R3 digest chain using PostgreSQL's actual JSONB serialization.

    Python supplies the exact specified arrays/domains and hash framing. Only
    scalar/compact leaves cross SQL; full source/acquisition proofs never do.
    """
    def encoded(value):
        return connection.execute('select %s::jsonb::text as value',
                                  (Jsonb(value),)).fetchone()['value'].encode('utf-8')
    def digest(label, value):
        return sha256(label.encode('utf-8') + b'\0' + encoded(value)).digest()
    def text(value):
        return None if value is None else str(value)
    header = [2, text(lineage['top_ref']), lineage['library_id'], lineage['owner_account_id'],
        lineage['preparation_kind'], text(lineage['preparation_ref']), lineage['preparation_revision'],
        lineage['old_top_revision'], lineage['approved_top_revision'], lineage['action'],
        lineage['normalized_title'], lineage['normalized_description'], lineage['evidence_revision'],
        lineage['review_digest'], lineage['full_s_digest'], lineage['intent_digest'], lineage['row_count']]
    state = digest('artwork-publication-logical-v2/header', header)
    for row in rows:
        value = [row['curator_position'], row['row_kind'], text(row['draft_ref']), row['draft_revision'],
                 text(row['row_ref']), text(row['saved_item_ref']), text(row['catalog_ref']),
                 row['local_album_id'], text(row['metadata_source_ref']), row['metadata_root_id'],
                 row['included'], row['staged_proof_value_digest'], text(row['staged_asset_ref'])]
        leaf = digest('artwork-publication-logical-v2/row', value)
        state = sha256(b'artwork-publication-logical-v2/step\0' + state + leaf).digest()
    return digest('artwork-publication-logical-v2/final', [len(rows), state.hex()]).hex()


@pytest.mark.parametrize('kind,count', [('saved', 0), ('saved', 3), ('draft', 0), ('draft', 3)])
def test_r3_exact_jsonb_logical_fingerprint_before_actual_member_mapping(publication_case, kind, count):
    case = publication_case.build(count, excluded=range(count))
    if kind == 'draft' and count:
        case.top, _ = case.db.create(refs=[])
        payload = command(case, new=range(count), order=tuple(reversed(range(count))))
    else:
        payload = None
    staged = case.stage(kind, payload=payload)
    with runtime(case) as connection:
        build = case.start_build(connection, staged)
        lineage = connection.execute('select * from app.album_top_artwork_publication_lineage where publication_ref=%s',
                                     (build['ref'],)).fetchone()
        rows = connection.execute('''select * from app.album_top_artwork_publication_logical_rows
            where publication_ref=%s order by curator_position''', (build['ref'],)).fetchall()
        assert logical_fingerprint(connection, lineage, rows) == build['fingerprint']
        assert len(build['fingerprint']) == 64 and build['fingerprint'] != '0' * 64
        assert connection.execute('''select count(*) as n from app.album_list_publication_items
            where publication_ref=%s''', (build['ref'],)).fetchone()['n'] == 0
        for field in ('normalized_title', 'normalized_description', 'evidence_revision', 'intent_digest'):
            changed = {**lineage, field: 'Changed header' if field.startswith('normalized') else 'f' * 64}
            assert logical_fingerprint(connection, changed, rows) != build['fingerprint']
        if count > 1:
            reordered = deepcopy(rows)
            reordered[0], reordered[1] = reordered[1], reordered[0]
            assert logical_fingerprint(connection, lineage, reordered) != build['fingerprint']
            changed = deepcopy(rows)
            changed[-1]['metadata_source_ref'] = uuid4()
            assert logical_fingerprint(connection, lineage, changed) != build['fingerprint']
        case.apply(connection, build)
        case.mapping(connection, build)
        case.map_pages(connection, build)
        case.seal(connection, build)
        case.point(connection, build)
        case.receipt(connection, build)
        case.consume(connection, build)
        assert connection.execute('select content_fingerprint from app.album_list_publications where ref=%s',
                                  (build['ref'],)).fetchone()['content_fingerprint'] == build['fingerprint']


def test_direct_runtime_v2_header_outside_admission_is_deferred_and_rolls_back(publication_case):
    case = publication_case.build(0)
    before = durable_snapshot(case)
    connection = psycopg.connect(case.db.app_url, row_factory=dict_row)
    try:
        connection.execute("set local lock_timeout='5s'")
        connection.execute("set local statement_timeout='120s'")
        assert_runtime_role(connection, case.db)
        ref, _ = raw_header(case, connection)
        opened = connection.execute('select * from app.album_list_publication_seals where publication_ref=%s',
                                    (ref,)).fetchone()
        assert opened['seal_contract_version'] == 2 and opened['sealed_at'] is None
        # The INSERT itself succeeds; the actual transaction-end failure is
        # required even when the admission helper was bypassed completely.
        with pytest.raises(psycopg.Error):
            connection.commit()
        connection.rollback()
    finally:
        connection.close()
    assert durable_snapshot(case) == before


@pytest.mark.parametrize('missing', ['abandoned', 'unsealed', 'no_pointer', 'no_receipt',
                                    'wrong_receipt', 'no_consume', 'revoked_after_consume',
                                    'redirected_after_consume', 'working_after_consume', 'header_after_consume'])
def test_real_commit_rejects_every_incomplete_v2_finalization(publication_case, missing):
    case = publication_case.build(1, excluded=(0,))
    prior = None
    if missing == 'redirected_after_consume':
        with runtime(case) as connection:
            prior = old_sealed_publication(case, connection)
    staged = case.stage()
    before = durable_snapshot(case)
    connection = psycopg.connect(case.db.app_url, row_factory=dict_row)
    try:
        connection.execute("set local lock_timeout='5s'")
        connection.execute("set local statement_timeout='120s'")
        assert_runtime_role(connection, case.db)
        build = case.start_build(connection, staged)
        if missing != 'abandoned':
            case.apply(connection, build)
            case.mapping(connection, build)
            case.map_pages(connection, build)
        if missing not in ('abandoned', 'unsealed'):
            case.seal(connection, build)
        if missing not in ('abandoned', 'unsealed', 'no_pointer'):
            case.point(connection, build)
        if missing in ('wrong_receipt', 'no_consume', 'revoked_after_consume', 'redirected_after_consume',
                       'working_after_consume', 'header_after_consume'):
            case.receipt(connection, build, **({'digest': 'f' * 64} if missing == 'wrong_receipt' else {}))
        if missing in ('revoked_after_consume', 'redirected_after_consume',
                       'working_after_consume', 'header_after_consume'):
            case.consume(connection, build)
            # Terminal closure is now frozen at the mutation boundary, even
            # if a caller has already drained all deferred finalizers.
            with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState) as caught:
                if missing == 'revoked_after_consume':
                    connection.execute('''update app.shared_links set state='revoked',active_publication_ref=null,
                        revoked_at=clock_timestamp(),link_revision=link_revision+1 where top_ref=%s''',
                        (case.top['top_ref'],))
                elif missing == 'redirected_after_consume':
                    connection.execute('''update app.shared_links set active_publication_ref=%s
                        where top_ref=%s''', (prior, case.top['top_ref']))
                elif missing == 'working_after_consume':
                    connection.execute('delete from app.album_list_items where top_ref=%s', (case.top['top_ref'],))
                else:
                    connection.execute('update app.album_lists set title=%s where ref=%s',
                                       ('Changed after consumption', case.top['top_ref']))
            assert caught.value.diag.constraint_name == 'top_artwork_publication_closure'
        else:
            with pytest.raises(psycopg.Error):
                connection.commit()
        connection.rollback()
    finally:
        connection.close()
    assert durable_snapshot(case) == before


def test_valid_default_deferred_order_commits_but_premature_immediate_fails(publication_case):
    case = publication_case.build(0)
    staged = case.stage()
    before = durable_snapshot(case)
    with pytest.raises(psycopg.Error):
        with uncommitted(case) as connection:
            build = build_through_mapping(case, connection, staged)
            case.seal(connection, build)
            case.point(connection, build)
            connection.execute('set constraints all immediate')
    assert durable_snapshot(case) == before
    build = case.publish(staged)
    with runtime(case) as connection:
        row = connection.execute('select * from app.album_top_artwork_publication_consumptions where publication_ref=%s',
                                 (build['ref'],)).fetchone()
        assert row['removed_items'] == 0 and row['seal_digest'] == build['seal_digest']
        connection.execute('set constraints all immediate')


@pytest.mark.parametrize('field', ['action', 'key', 'digest', 'session', 'publication', 'receipt_revision'])
def test_consume_checks_the_existing_exact_operation_receipt(publication_case, field):
    case = publication_case.build(0)
    staged = case.stage()
    before = durable_snapshot(case)
    with pytest.raises(psycopg.Error):
        with uncommitted(case) as connection:
            build = build_through_mapping(case, connection, staged)
            case.seal(connection, build)
            case.point(connection, build)
            changes = {'action': {'action': 'save'}, 'key': {'key': str(uuid4())},
                       'digest': {'digest': 'f' * 64}, 'session': {'session': case.db.owner.session_id + 1},
                       'publication': {'publication': None},
                       'receipt_revision': {'receipt_changes': {'revision': '999'}}}[field]
            case.receipt(connection, build, **changes)
            case.consume(connection, build)
    assert durable_snapshot(case) == before


@pytest.mark.parametrize('fault', ['foreign_uuid', 'duplicate_uuid', 'wrong_original',
                                  'wrong_order', 'missing', 'extra_key', 'boolean_position',
                                  'null_item', 'wrong_presentation', 'header_changed', 'source_changed'])
def test_mapping_and_seal_reject_invalid_actual_membership_atomically(publication_case, fault):
    case = publication_case.build(3, excluded=(0, 1, 2))
    staged = case.stage('draft', payload=command(case, order=(2, 0)))
    before = durable_snapshot(case)
    with pytest.raises(psycopg.Error):
        with uncommitted(case) as connection:
            build = case.start_build(connection, staged)
            case.apply(connection, build)
            mappings = case.mapping(connection, build)
            if fault == 'foreign_uuid': mappings[0]['item_ref'] = str(uuid4())
            elif fault == 'duplicate_uuid': mappings[1]['item_ref'] = mappings[0]['item_ref']
            elif fault == 'wrong_original': mappings[0]['original_position'] += 20
            elif fault == 'wrong_order':
                mappings[0]['item_ref'], mappings[1]['item_ref'] = mappings[1]['item_ref'], mappings[0]['item_ref']
            elif fault == 'missing': mappings.pop()
            elif fault == 'extra_key': mappings[0]['asset_ref'] = str(uuid4())
            elif fault == 'boolean_position': mappings[0]['curator_position'] = True
            elif fault == 'null_item': mappings[0]['item_ref'] = None
            elif fault == 'wrong_presentation': mappings[0]['presentation_ref'] = mappings[1]['presentation_ref']
            elif fault == 'header_changed':
                connection.execute('update app.album_lists set title=%s where ref=%s', ('Unreviewed title', case.top['top_ref']))
            else:
                connection.execute('''update app.album_list_item_publication_sources set selected_source_ref=%s
                    where item_ref=%s''', (case.items[1]['selected_source_ref'], mappings[0]['item_ref']))
            case.map_pages(connection, build, mappings)
            case.seal(connection, build)
    assert durable_snapshot(case) == before


@pytest.mark.parametrize('shape', ['null', 'object', 'empty', 'page_101'])
def test_mapping_transport_page_limit_is_enforced_before_writes(publication_case, shape):
    case = publication_case.build(101, excluded=range(101))
    staged = case.stage()
    before = durable_snapshot(case)
    with pytest.raises(psycopg.Error):
        with uncommitted(case) as connection:
            build = case.start_build(connection, staged)
            case.apply(connection, build)
            mappings = case.mapping(connection, build)
            supplied = {'null': None, 'object': {}, 'empty': [], 'page_101': mappings}[shape]
            connection.execute('select app.map_top_artwork_publication_page(%s,%s)',
                               (build['ref'], Jsonb(supplied)))
    assert durable_snapshot(case) == before


def test_unadmitted_mapping_wrong_expected_seal_and_unsealed_pointer_reject(publication_case):
    case = publication_case.build(1, excluded=(0,))
    staged = case.stage()
    for fault in ('no_admission', 'wrong_seal', 'unsealed_pointer'):
        before = durable_snapshot(case)
        with pytest.raises(psycopg.Error):
            with uncommitted(case) as connection:
                if fault == 'no_admission':
                    ref, _ = raw_header(case, connection)
                    connection.execute('select app.map_top_artwork_publication_page(%s,%s)',
                        (ref, Jsonb([{'curator_position': 1, 'item_ref': case.items[0]['item_ref'],
                                    'original_position': 1, 'presentation_ref': str(uuid4()),
                                    'descriptor_witness': None}])))
                else:
                    build = build_through_mapping(case, connection, staged)
                    if fault == 'wrong_seal': case.seal(connection, build, '0' * 64)
                    else: case.point(connection, build)
        assert durable_snapshot(case) == before


@pytest.mark.parametrize('field,value', [('title', ' untrimmed '), ('title', ''), ('title', 'x' * 101),
    ('description', 'x' * 1001), ('title', 'control\n'), ('description', 'control\x7f'),
    ('evidence_revision', 'A' * 64), ('review_digest', ''), ('intent_digest', None),
    ('full_s_digest', 'z' * 64), ('asset_manifest_digest', '0' * 65),
    ('link_state', 'enabled'), ('link_revision', 1), ('action', 'save')])
def test_admission_header_commitments_and_link_binding_reject_malformed_values(publication_case, field, value):
    case = publication_case.build(0)
    staged = case.stage()
    before = durable_snapshot(case)
    with pytest.raises(psycopg.Error):
        with uncommitted(case) as connection:
            case.start_build(connection, staged, **{field: value})
    assert durable_snapshot(case) == before


def test_v1_contract_and_historical_open_generation_are_preserved(publication_case):
    case = publication_case.build(0)
    with runtime(case) as connection:
        historical, _ = raw_header(case, connection, version=1)
        sealed = old_sealed_publication(case, connection)
        original = connection.execute('select * from app.album_list_publications where ref=%s', (sealed,)).fetchone()
        original_seal = connection.execute('select * from app.album_list_publication_seals where publication_ref=%s',
                                           (sealed,)).fetchone()
        connection.execute('''insert into app.shared_links
            (ref,top_ref,library_id,state,active_publication_ref,link_revision,enabled_at)
            values(%s,%s,%s,'enabled',%s,1,clock_timestamp())''',
            (str(uuid4()), case.top['top_ref'], case.db.library, sealed))
    staged = case.stage()
    case.publish(staged)
    with runtime(case) as connection:
        assert connection.execute('select * from app.album_list_publications where ref=%s', (sealed,)).fetchone() == original
        assert connection.execute('select * from app.album_list_publication_seals where publication_ref=%s',
                                  (sealed,)).fetchone() == original_seal
        assert connection.execute('select sealed_at from app.album_list_publication_seals where publication_ref=%s',
                                  (historical,)).fetchone()['sealed_at'] is None
        assert connection.execute('''select count(*) as n from catalog.album_presentation_versions
            where contract_version<>1''').fetchone()['n'] == 0


def test_v1_sealer_cannot_close_a_v2_header(publication_case):
    case = publication_case.build(0)
    staged = case.stage()
    before = durable_snapshot(case)
    with pytest.raises(psycopg.Error):
        with uncommitted(case) as connection:
            build = case.start_build(connection, staged)
            row = connection.execute('select * from app.album_list_publications where ref=%s', (build['ref'],)).fetchone()
            header = [str(row['ref']), str(row['top_ref']), row['library_id'], row['publication_revision'],
                row['approved_top_revision'], row['approved_by_account_id'], row['title'], row['description'],
                row['contract_version'], row['content_fingerprint']]
            connection.execute('select app.seal_album_list_publication(%s,0,%s)',
                (build['ref'], Jsonb(['album-list-publication-seal-v1', header, []])))
    assert durable_snapshot(case) == before


def test_runtime_acl_private_helpers_fixed_paths_and_no_disposable_foreign_keys(publication_case):
    case = publication_case.build(0)
    with runtime(case) as connection:
        role = assert_runtime_role(connection, case.db)
        for signature in (ADMIT, MAP, SEAL, CONSUME, CONSUMED):
            assert connection.execute("select has_function_privilege(%s,%s,'EXECUTE') as yes",
                                      (role, signature)).fetchone()['yes'] is True
            function = connection.execute('''select p.prosecdef,p.proconfig,
                exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
                  where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
                from pg_proc p where p.oid=%s::regprocedure''', (signature,)).fetchone()
            assert function['prosecdef'] is True
            assert 'search_path=pg_catalog' in function['proconfig']
            assert function['public_execute'] is False
            assert connection.execute("select has_function_privilege('album_haven_readonly',%s,'EXECUTE') as yes",
                                      (signature,)).fetchone()['yes'] is False
        helpers = connection.execute('''select p.oid::regprocedure::text as signature
            from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='app' and p.proname like '\\_artwork_publication\\_%' escape '\\'
            order by p.proname''').fetchall()
        assert helpers
        helpers += [
            {'signature': 'app.start_top_artwork_preparation_saved_v2(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb,bigint)'},
            {'signature': 'app._start_top_artwork_draft_preparation_v1(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,bigint,uuid,bigint,text,jsonb)'},
        ]
        for function in helpers:
            assert connection.execute("select has_function_privilege(%s,%s,'EXECUTE') as yes",
                                      (role, function['signature'])).fetchone()['yes'] is False
        for table in RETAINED:
            name = 'app.' + table
            for privilege in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'):
                assert connection.execute('select has_table_privilege(%s,%s,%s) as yes',
                                          (role, name, privilege)).fetchone()['yes'] is False
            assert connection.execute("select has_table_privilege('album_haven_readonly',%s,'SELECT') as yes",
                                      (name,)).fetchone()['yes'] is False
        forbidden = connection.execute('''select c.conrelid::regclass::text as relation,
                c.confrelid::regclass::text as target from pg_constraint c
            where c.contype='f' and c.conrelid=any(%s::regclass[])
              and c.confrelid=any(array['app.album_top_artwork_preparations'::regclass,
                'app.album_top_artwork_preparation_items'::regclass,
                'app.album_top_artwork_draft_items'::regclass,'app.account_sessions'::regclass,
                'app.album_list_items'::regclass])''', (['app.' + table for table in RETAINED],)).fetchall()
        assert forbidden == []
    # Actual statements under the genuine nonsuperuser login, not grant
    # metadata alone. Zero affected rows still require the forbidden privilege.
    for table in RETAINED:
        for statement in (f'insert into app.{table} select * from app.{table} where false',
                          f'delete from app.{table} where false', f'truncate app.{table}'):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with uncommitted(case) as connection:
                    connection.execute(statement)


@POSIX_CAPTURE
def test_postseal_content_and_retained_asset_mutation_are_closed(publication_case):
    case = publication_case.build(1)
    build = case.publish(case.stage())
    before = durable_snapshot(case)
    statements = [
        ('update app.album_list_publications set title=title where ref=%s', (build['ref'],)),
        ('update app.album_list_publication_seals set content_digest=content_digest where publication_ref=%s', (build['ref'],)),
        ('update app.album_top_artwork_assets set png=png where top_ref=%s', (case.top['top_ref'],)),
        ('delete from app.album_top_artwork_publication_consumptions where publication_ref=%s', (build['ref'],)),
        ('select app.map_top_artwork_publication_page(%s,%s)', (build['ref'], Jsonb(build['mapping']))),
        ('select app.seal_top_artwork_publication(%s,%s)', (build['ref'], build['seal_digest'])),
        ('select app.consume_top_artwork_publication(%s)', (build['ref'],)),
    ]
    for statement, parameters in statements:
        with pytest.raises(psycopg.Error):
            with uncommitted(case) as connection:
                connection.execute(statement, parameters)
        assert durable_snapshot(case) == before
    # Runtime cannot INSERT private children at all. Even the trusted migrator
    # cannot exploit INSERT-after-seal: the fixed before-row guard runs first.
    with case.db.connect() as connection:
        with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState) as caught:
            connection.execute('''insert into app.album_top_artwork_publication_logical_rows
                select * from app.album_top_artwork_publication_logical_rows where publication_ref=%s''',
                (build['ref'],))
        assert caught.value.diag.constraint_name == 'top_artwork_publication_open'
        connection.rollback()
    assert durable_snapshot(case) == before


@pytest.mark.parametrize('checkpoint', ['applied', 'presentations', 'first_page', 'mapped',
                                      'sealed', 'pointed', 'receipt', 'consumed'])
def test_real_sql_failure_rolls_back_all_working_and_retained_state(publication_case, checkpoint):
    case = publication_case.build(101, excluded=range(101))
    staged = case.stage('draft', payload=command(case, order=tuple(reversed(range(101)))))
    before = durable_snapshot(case)
    with pytest.raises(psycopg.errors.DivisionByZero):
        with uncommitted(case) as connection:
            build = case.start_build(connection, staged)
            case.apply(connection, build)
            if checkpoint == 'applied': connection.execute('select 1/0')
            mappings = case.mapping(connection, build)
            if checkpoint == 'presentations': connection.execute('select 1/0')
            connection.execute('select app.map_top_artwork_publication_page(%s,%s)',
                               (build['ref'], Jsonb(mappings[:100])))
            if checkpoint == 'first_page': connection.execute('select 1/0')
            connection.execute('select app.map_top_artwork_publication_page(%s,%s)',
                               (build['ref'], Jsonb(mappings[100:])))
            if checkpoint == 'mapped': connection.execute('select 1/0')
            case.seal(connection, build)
            if checkpoint == 'sealed': connection.execute('select 1/0')
            case.point(connection, build)
            if checkpoint == 'pointed': connection.execute('select 1/0')
            case.receipt(connection, build)
            if checkpoint == 'receipt': connection.execute('select 1/0')
            case.consume(connection, build)
            connection.execute('select 1/0')
    assert durable_snapshot(case) == before


@POSIX_CAPTURE
def test_cleanup_really_blocks_on_transfer_then_preserves_publication_pin(publication_case):
    case = publication_case.build(1)
    staged = case.stage()
    pid_queue = Queue()
    def reclaim():
        with runtime(case) as other:
            pid_queue.put(other.execute('select pg_backend_pid() as pid').fetchone()['pid'])
            return other.execute('select app.cleanup_top_artwork_preparations(%s,%s,%s,%s) as value',
                (case.top['top_ref'], case.db.library, case.db.owner.account_id,
                 int(case.top['revision']) + 1)).fetchone()['value']
    with ThreadPoolExecutor(max_workers=1) as pool:
        with runtime(case) as connection:
            build = build_through_mapping(case, connection, staged)
            case.seal(connection, build)
            case.point(connection, build)
            case.receipt(connection, build)
            case.consume(connection, build)
            blocker = connection.execute('select pg_backend_pid() as pid').fetchone()['pid']
            future = pool.submit(reclaim)
            waiting = pid_queue.get(timeout=3)
            observed = False
            deadline = monotonic() + 3
            while monotonic() < deadline:
                with case.db.connect() as observer:
                    observed = observer.execute('select %s=any(pg_blocking_pids(%s)) as blocked',
                                                (blocker, waiting)).fetchone()['blocked']
                if observed:
                    break
                sleep(0.02)
            assert observed, 'No real PostgreSQL lock wait was observed'
            assert not future.done()
        result = future.result(timeout=10)
    assert result['assets_deleted'] == 0
    state = durable_snapshot(case)
    assert len(state['album_top_artwork_assets']) == 1
    assert len(state['album_top_artwork_publication_rows']) == 1
    assert len(state['album_top_artwork_publication_consumptions']) == 1
    assert_staging_budget(case, 0, 0, 0)


def test_original_deadline_after_receipt_and_consumption_still_rejects_commit(publication_case):
    case = publication_case.build(0)
    staged = case.stage()
    with case.db.connect() as setup:
        expiry = setup.execute('''with deadline as (select clock_timestamp()+interval '5 seconds' as expiry)
            update app.album_top_artwork_preparations set created_at=expiry-interval '60 minutes',
                expires_at=expiry from deadline where ref=%s returning expires_at''',
            (staged['ref'],)).fetchone()['expires_at']
    before = durable_snapshot(case)
    connection = psycopg.connect(case.db.app_url, row_factory=dict_row)
    try:
        connection.execute("set local lock_timeout='5s'")
        connection.execute("set local statement_timeout='120s'")
        assert_runtime_role(connection, case.db)
        build = build_through_mapping(case, connection, staged)
        case.seal(connection, build)
        case.point(connection, build)
        case.receipt(connection, build)
        case.consume(connection, build)
        # Wait against the actual database deadline after all mutation work.
        # This is a clock-fence test, not a sleep-based assertion of lock order.
        connection.execute('select pg_sleep(greatest(0,extract(epoch from (%s::timestamptz-clock_timestamp())))+0.02)',
                           (expiry,))
        assert connection.execute('select clock_timestamp()>=%s as expired', (expiry,)).fetchone()['expired']
        with pytest.raises(psycopg.Error):
            connection.commit()
        connection.rollback()
    finally:
        connection.close()
    assert durable_snapshot(case) == before


def test_distinct_tops_serialize_on_the_one_account_budget(publication_case):
    case = publication_case.build(0)
    second, _ = case.db.create(refs=[])
    staged = case.stage()
    pids = Queue()
    def reserve_other_top():
        with runtime(case) as other:
            pids.put(other.execute('select pg_backend_pid() as pid').fetchone()['pid'])
            return str(other.execute('select app.start_top_artwork_preparation('
                + ','.join(['%s'] * 11) + ') as ref',
                (str(uuid4()), second['top_ref'], case.db.library, case.db.owner.account_id,
                 case.db.owner.session_id, CONTEXT, int(second['revision']), str(uuid4()),
                 'f' * 64, Jsonb([]), staged['header']['request_generation'])).fetchone()['ref'])
    with ThreadPoolExecutor(max_workers=1) as pool:
        with runtime(case) as connection:
            build = build_through_mapping(case, connection, staged)
            case.seal(connection, build)
            case.point(connection, build)
            case.receipt(connection, build)
            case.consume(connection, build)
            blocker = connection.execute('select pg_backend_pid() as pid').fetchone()['pid']
            future = pool.submit(reserve_other_top)
            waiting = pids.get(timeout=3)
            deadline, observed = monotonic() + 3, False
            while monotonic() < deadline:
                with case.db.connect() as observer:
                    observed = observer.execute('select %s=any(pg_blocking_pids(%s)) as blocked',
                                                (blocker, waiting)).fetchone()['blocked']
                if observed:
                    break
                sleep(0.02)
            assert observed and not future.done()
        admitted = future.result(timeout=10)
    with case.db.connect() as connection:
        actual = connection.execute('select top_ref from app.album_top_artwork_preparations where ref=%s',
                                    (admitted,)).fetchone()['top_ref']
        assert str(actual) == second['top_ref']
        budgets = connection.execute('''select scope_ref,preparation_count,item_count,proof_bytes
            from app.album_top_artwork_budgets where owner_account_id=%s''',
            (case.db.owner.account_id,)).fetchall()
    by_scope = {str(row['scope_ref']): row for row in budgets}
    assert by_scope[case.top['top_ref']]['preparation_count'] == 0
    assert by_scope[second['top_ref']]['preparation_count'] == 1
    assert by_scope[ZERO]['preparation_count'] == 1
    assert by_scope[ZERO]['item_count'] == 0 and by_scope[ZERO]['proof_bytes'] == 1024


@pytest.mark.parametrize('identity', ['preparation', 'owner', 'session', 'context', 'preparation_revision', 'top_revision'])
def test_admission_rechecks_exact_private_preparation_identity(publication_case, identity):
    case = publication_case.build(0)
    staged = case.stage()
    before = durable_snapshot(case)
    with pytest.raises(psycopg.Error):
        with uncommitted(case) as connection:
            generation = connection.execute('''select generation from library.public_metadata_source_state
                where library_id=%s''', (case.db.library,)).fetchone()['generation']
            arguments = [str(uuid4()), staged['ref'], case.db.owner.account_id, case.db.owner.session_id,
                CONTEXT, staged['header']['revision'], int(case.top['revision']), 'enable_external',
                'Reviewed title', '', '1' * 64, '2' * 64, '3' * 64, '4' * 64, '5' * 64,
                generation, str(uuid4()), '6' * 64, 'no_link', None]
            index, value = {'preparation': (1, str(uuid4())), 'owner': (2, case.db.owner.account_id + 999999),
                            'session': (3, case.db.owner.session_id + 1), 'context': (4, 'b' * 64),
                            'preparation_revision': (5, staged['header']['revision'] + 1),
                            'top_revision': (6, int(case.top['revision']) + 1)}[identity]
            arguments[index] = value
            connection.execute('select app.admit_top_artwork_publication('
                               + ','.join(['%s'] * 20) + ')', arguments)
    assert durable_snapshot(case) == before


@POSIX_CAPTURE
def test_scoped_asset_fk_rejects_another_tops_real_asset(publication_case):
    case = publication_case.build(1)
    cached = case.results([case.items[0]['item_ref']])
    published = case.publish(case.stage(cached_results=cached))
    original_top, original_items, original_payload = case.top, case.items, case.payload
    other_top, _ = case.db.create(refs=case.catalog_refs)
    other_items = case.db.read(other_top)['items']
    case.top = other_top
    case.items = [{**old, 'item_ref': row['ref']} for old, row in zip(original_items, other_items)]
    case.payload = {**original_payload, 'revision': other_top['revision'], 'items': case.items}
    foreign = case.stage(cached_results=cached)
    with case.db.connect() as connection:
        foreign_asset = connection.execute('''select asset_ref from app.album_top_artwork_preparation_items
            where preparation_ref=%s''', (foreign['ref'],)).fetchone()['asset_ref']
    case.top, case.items, case.payload = original_top, original_items, original_payload
    before = durable_snapshot(case)
    with case.db.connect() as connection:
        binding = connection.execute('''select array_agg(a.attname::text order by k.ordinality) as columns
            from pg_constraint c cross join lateral unnest(c.conkey) with ordinality k(attnum,ordinality)
            join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
            where c.contype='f' and c.conrelid='app.album_top_artwork_publication_rows'::regclass
              and c.confrelid='app.album_top_artwork_assets'::regclass group by c.oid''').fetchone()
        assert binding['columns'] == ['asset_ref', 'top_ref', 'library_id', 'owner_account_id']
        # Isolate the actual composite FK as migrator. The runtime already has
        # no child UPDATE grant; disabling only this named immutability trigger
        # does not disable foreign keys or grant any production capability.
        connection.execute('''alter table app.album_top_artwork_publication_rows
            disable trigger artwork_publication_immutable''')
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            connection.execute('''update app.album_top_artwork_publication_rows set asset_ref=%s
                where publication_ref=%s''', (foreign_asset, published['ref']))
        connection.rollback()
    assert durable_snapshot(case) == before


def test_retained_content_seal_is_stable_across_later_session_timezones(publication_case):
    case = publication_case.build(0)
    build = case.publish(case.stage())
    before = durable_snapshot(case)
    for zone in ('Pacific/Auckland', 'America/Los_Angeles', 'UTC'):
        with runtime(case) as connection:
            connection.execute("select set_config('TimeZone',%s,true)", (zone,))
            # Rechecking this existing pointer invokes the actual seal guard;
            # no new publication or receipt is created in the later session.
            connection.execute('''update app.shared_links set active_publication_ref=active_publication_ref
                where top_ref=%s''', (case.top['top_ref'],))
            row = connection.execute('select content_digest from app.album_list_publication_seals where publication_ref=%s',
                                     (build['ref'],)).fetchone()
            assert row['content_digest'] == build['seal_digest']
    assert durable_snapshot(case) == before


def test_physical_staging_deletion_cannot_substitute_for_consume_attestation(publication_case):
    case = publication_case.build(0)
    staged = case.stage()
    before = durable_snapshot(case)
    connection = case.db.connect()
    try:
        connection.execute("set local lock_timeout='5s'")
        connection.execute("set local statement_timeout='120s'")
        # Migrator-only deletion isolates the deferred invariant. Runtime's
        # DELETE denial is tested separately; no trigger is disabled here.
        assert connection.execute('select rolsuper from pg_roles where rolname=current_user').fetchone()['rolsuper'] is False
        build = build_through_mapping(case, connection, staged)
        case.seal(connection, build)
        case.point(connection, build)
        case.receipt(connection, build)
        connection.execute('delete from app.album_top_artwork_preparations where ref=%s', (staged['ref'],))
        assert preparation_header(case, staged['ref'], connection) is None
        with pytest.raises(psycopg.Error):
            connection.commit()
        connection.rollback()
    finally:
        connection.close()
    assert durable_snapshot(case) == before


def test_second_consume_in_same_transaction_cannot_release_reservations_twice(publication_case):
    case = publication_case.build(1, excluded=(0,))
    staged = case.stage()
    with runtime(case) as connection:
        build = build_through_mapping(case, connection, staged)
        case.seal(connection, build)
        case.point(connection, build)
        case.receipt(connection, build)
        case.consume(connection, build)
        with pytest.raises(psycopg.Error):
            with connection.transaction():
                case.consume(connection, build)
        budgets = connection.execute('''select preparation_count,item_count,proof_bytes
            from app.album_top_artwork_budgets where owner_account_id=%s''',
            (case.db.owner.account_id,)).fetchall()
        assert len(budgets) == 2 and all(row == {'preparation_count': 0, 'item_count': 0, 'proof_bytes': 0}
                                         for row in budgets)
    assert_staging_budget(case, 0, 0, 0)
