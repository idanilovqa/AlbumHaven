"""Genuine PostgreSQL contracts for dormant retained artwork publication.

Run only through the existing admitted synthetic migrator/runtime fixture. These
are source-authored tests, not executed evidence. Successful capture fixtures use
the existing real POSIX acquisition owner; SQL-only empty/excluded cases work
without a decoder. The runtime SQL writer is trusted: these tests do not claim
SQL authenticates HMAC consent or reproduces the strict canonical proof codec.

This module deliberately owns teardown. The older artwork fixture deletes PNGs
before it knows about permanent publication pins and must not wrap this fixture.
"""
from contextlib import contextmanager
from copy import deepcopy
from hashlib import sha256
from math import gcd
import json
import os
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import pytest

from music_app.services import album_top_publication as publication
from music_app.services import album_top_publication_evidence as evidence
from music_app.services import artwork_proof_codec as codec
from tests.py.postgres_runtime_role_contract import assert_runtime_role
from tests.py.test_owned_album_tops_postgres import db, urls
from tests.py import test_album_top_artwork_preparation_postgres as foundation
from tests.py.test_top_artwork_draft_preparation_postgres import command, direct
from tests.py import test_top_artwork_draft_capture_postgres as draft_capture

CONTEXT = foundation.CONTEXT
ZERO = foundation.ZERO
PAGE = 100
MAX_ROWS = 5000
MAX_IMAGES = 128 * 1024 * 1024
MAX_PROOF_RESERVATION = 1024 + MAX_ROWS * 69632
RETAINED = (
    'album_top_artwork_publication_lineage',
    'album_top_artwork_publication_logical_rows',
    'album_top_artwork_publication_baseline',
    'album_top_artwork_publication_rows',
    'album_top_artwork_publication_proofs',
    'album_top_artwork_publication_consumptions',
)
ADMIT = ('app.admit_top_artwork_publication(uuid,uuid,bigint,bigint,text,bigint,'
         'bigint,text,text,text,text,text,text,text,text,bigint,uuid,text,text,bigint)')
MAP = 'app.map_top_artwork_publication_page(uuid,jsonb)'
SEAL = 'app.seal_top_artwork_publication(uuid,text)'
CONSUME = 'app.consume_top_artwork_publication(uuid)'
CONSUMED = 'app.top_artwork_start_consumed(uuid,bigint,bigint,uuid)'
POSIX_CAPTURE = pytest.mark.skipif(
    os.name != 'posix', reason='Requires genuine existing POSIX artwork acquisition')


@contextmanager
def runtime(case):
    with psycopg.connect(case.db.app_url, row_factory=dict_row) as connection:
        assert_runtime_role(connection, case.db)
        connection.execute("set local lock_timeout='5s'")
        connection.execute("set local statement_timeout='120s'")
        yield connection


@contextmanager
def uncommitted(case):
    """Negative statement tests cannot accidentally pass on a later COMMIT error."""
    connection = psycopg.connect(case.db.app_url, row_factory=dict_row)
    try:
        assert_runtime_role(connection, case.db)
        connection.execute("set local lock_timeout='5s'")
        connection.execute("set local statement_timeout='120s'")
        yield connection
    finally:
        connection.rollback()
        connection.close()


def rows_for(case, connection, table):
    # All identifiers below are fixed test-owned literals, never request input.
    if table in ('album_top_artwork_publication_baseline',
                 'album_top_artwork_publication_logical_rows',
                 'album_top_artwork_publication_consumptions'):
        return connection.execute(f'''select r.* from app.{table} r
            join app.album_top_artwork_publication_lineage l using(publication_ref)
            where l.owner_account_id=%s order by 1,2''', (case.db.owner.account_id,)).fetchall()
    if table in RETAINED:
        order = ('top_ref,value_digest' if table == 'album_top_artwork_publication_proofs' else
                 'publication_ref,curator_position' if table == 'album_top_artwork_publication_rows' else
                 'publication_ref')
        return connection.execute(f'select * from app.{table} where owner_account_id=%s order by {order}',
                                  (case.db.owner.account_id,)).fetchall()
    order = {'album_list_operations': 'actor_account_id,library_id,request_key',
             'album_list_item_publication_sources': 'top_ref,item_ref',
             'album_list_publication_items': 'publication_ref,curator_position',
             'album_top_artwork_preparation_items': 'preparation_ref,position',
             'album_top_artwork_draft_items': 'preparation_ref,position'}.get(table, 'ref')
    return connection.execute(f'select * from app.{table} where library_id=%s order by {order}',
                              (case.db.library,)).fetchall()


def durable_snapshot(case):
    with case.db.connect() as connection:
        result = {table: rows_for(case, connection, table) for table in RETAINED}
        for table in ('album_lists', 'album_list_items', 'album_list_item_publication_sources',
                      'album_list_operations', 'shared_links', 'album_list_publications',
                      'album_list_publication_items', 'album_top_artwork_preparations',
                      'album_top_artwork_preparation_items', 'album_top_artwork_draft_items',
                      'album_top_artwork_assets'):
            result[table] = rows_for(case, connection, table)
        result['budgets'] = connection.execute('''select * from app.album_top_artwork_budgets
            where owner_account_id=%s order by scope_ref''', (case.db.owner.account_id,)).fetchall()
        result['seals'] = connection.execute('''select s.* from app.album_list_publication_seals s
            join app.album_list_publications p on p.ref=s.publication_ref
            where p.library_id=%s order by s.publication_ref''', (case.db.library,)).fetchall()
        result['presentations'] = connection.execute('''select p.*,to_jsonb(e) as evidence,to_jsonb(s) as seal
            from catalog.album_presentation_versions p
            join library.album_presentation_evidence e on e.presentation_ref=p.ref
            left join library.album_presentation_seals s on s.presentation_ref=p.ref
            where e.library_id=%s order by p.ref''', (case.db.library,)).fetchall()
        return result


def budget_values(case):
    with case.db.connect() as connection:
        return connection.execute('''select scope_ref,preparation_count,item_count,proof_bytes,
            asset_count,byte_count from app.album_top_artwork_budgets
            where owner_account_id=%s order by scope_ref''', (case.db.owner.account_id,)).fetchall()


def assert_staging_budget(case, headers, items, proof_bytes):
    values = budget_values(case)
    assert len(values) == 2
    assert {str(row['scope_ref']) for row in values} == {ZERO, case.top['top_ref']}
    assert {(row['preparation_count'], row['item_count'], row['proof_bytes'])
            for row in values} == {(headers, items, proof_bytes)}


def preparation_header(case, ref, connection=None):
    if connection is None:
        with case.db.connect() as connection:
            return preparation_header(case, ref, connection)
    return connection.execute('select * from app.album_top_artwork_preparations where ref=%s',
                              (ref,)).fetchone()


class PublicationCase(foundation.ArtworkCase):
    """Reuse actual provenance setup, but own retained-aware resource teardown."""
    def stage(self, kind='saved', *, payload=None, cached_results=None):
        if kind == 'saved':
            payload = payload or {**self.payload, 'revision': self.top['revision'],
                                  'request_key': str(uuid4())}
            # Direct runtime admission isolates the C-1 SQL contract from the
            # separately gated C-2 active-v2 projection/command dispatch.
            admitted = [{'item_ref': row['item_ref'], 'catalog_ref': row['album_ref'],
                'position': position, 'selected_local_album_id': row['selected_local_album_id'],
                'selected_source_ref': row['selected_source_ref'],
                'selected_library_root_id': self.metadata_root, 'included': row['include_artwork']}
                for position, row in enumerate(payload['items'], 1)]
            with runtime(self) as connection:
                ref = str(connection.execute('''select app.start_top_artwork_preparation
                    (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) as ref''',
                    (str(uuid4()), self.top['top_ref'], self.db.library, self.db.owner.account_id,
                     self.db.owner.session_id, CONTEXT, int(self.top['revision']), payload['request_key'],
                     evidence.digest(['sql-publication-test-manifest', admitted]), Jsonb(admitted),
                     payload['request_generation'])).fetchone()['ref'])
        else:
            payload = payload or command(self)
            with runtime(self) as connection:
                ref = str(direct(self, payload, connection=connection))
        while True:
            header = preparation_header(self, ref)
            if header['state'] == 'ready':
                break
            status = {'preparation_ref': ref, 'preparation_revision': str(header['revision'])}
            if kind == 'saved':
                key, lease, chosen = self.claim(status)
                if chosen:
                    if cached_results is None:
                        results, pngs = self.results(chosen)
                    else:
                        results, pngs = deepcopy(cached_results)
                        assert len(results) == len(chosen)
                        for result, item_ref in zip(results, chosen):
                            result['item_ref'] = str(item_ref)
                            result['asset_ref'] = str(uuid4())
                    self.complete(status, key, lease, results, pngs)
            else:
                key, lease, chosen = draft_capture.claim(self, status, payload)
                if chosen:
                    results, pngs = draft_capture.actual_results(self, payload, chosen)
                    draft_capture.complete(self, status, payload, key, lease, results, pngs)
        return {'ref': ref, 'kind': kind, 'payload': payload, 'header': header}

    def start_build(self, connection, staged, **changes):
        top = connection.execute('select * from app.album_lists where ref=%s for update',
                                 (self.top['top_ref'],)).fetchone()
        link = connection.execute('select * from app.shared_links where top_ref=%s for update',
                                  (self.top['top_ref'],)).fetchone()
        generation = connection.execute('''select generation from library.public_metadata_source_state
            where library_id=%s''', (self.db.library,)).fetchone()['generation']
        build = {'ref': str(uuid4()), 'staged': staged, 'top': top,
                 'action': 'enable_external' if link is None or link['state'] != 'enabled' else 'save',
                 'title': 'Reviewed publication', 'description': 'Exact reviewed description',
                 'evidence_revision': '1' * 64, 'review_digest': '2' * 64,
                 'full_s_digest': '3' * 64, 'intent_digest': '4' * 64,
                 'asset_manifest_digest': '5' * 64, 'metadata_generation': generation,
                 'operation_key': str(uuid4()), 'command_digest': '6' * 64,
                 'link_state': link['state'] if link else 'no_link',
                 'link_revision': link['link_revision'] if link else None, 'link': link}
        build.update(changes)
        arguments = (build['ref'], staged['ref'], self.db.owner.account_id, self.db.owner.session_id,
            CONTEXT, staged['header']['revision'], top['revision'], build['action'], build['title'],
            build['description'], build['evidence_revision'], build['review_digest'], build['full_s_digest'],
            build['intent_digest'], build['asset_manifest_digest'], build['metadata_generation'],
            build['operation_key'], build['command_digest'], build['link_state'], build['link_revision'])
        build['fingerprint'] = connection.execute('select app.admit_top_artwork_publication('
            + ','.join(['%s'] * len(arguments)) + ') as value', arguments).fetchone()['value']
        return build

    def apply(self, connection, build):
        staged = build['staged']
        if staged['kind'] == 'saved':
            items = [{key: row[key] for key in ('item_ref', 'album_ref',
                     'selected_local_album_id', 'selected_source_ref')}
                     for row in staged['payload']['items']]
        else:
            items = [{'item_ref': row['selection'].get('item_ref'),
                      'album_ref': row['selection']['album_ref'],
                      'selected_local_album_id': row['selection']['source']['selected_local_album_id'],
                      'selected_source_ref': row['selection']['source']['selected_source_ref']}
                     for row in staged['payload']['rows']]
        current = publication.working_items(connection, build['top'])
        # This is the existing actual membership writer. New IDs are obtained
        # from its real return vector, never predicted by the fixture.
        final = publication.apply_draft(connection, build['top'], items, current)
        connection.execute('''update app.album_lists set revision=revision+1,title=%s,description=%s
            where ref=%s and revision=%s''',
            (build['title'], build['description'], build['top']['ref'], build['top']['revision']))
        build['final'] = final
        return final

    def mapping(self, connection, build):
        staged = build['staged']
        table = 'album_top_artwork_draft_items' if staged['kind'] == 'draft' else 'album_top_artwork_preparation_items'
        mappings = []
        # Keep private proof payloads in bounded pages even in the 5,000-row
        # test. Only compact final mappings are accumulated for page submission.
        for offset in range(0, len(build['final']), PAGE):
            original = connection.execute(
                f'select position,included from app.{table} where preparation_ref=%s and position>%s order by position limit 100',
                (staged['ref'], offset)).fetchall()
            final_page = build['final'][offset:offset + PAGE]
            assert len(original) == len(final_page)
            for final, before in zip(final_page, original):
                source = connection.execute('''select title,artist,year from library.album_metadata_sources
                    where ref=%s and library_id=%s''', (final['selected_source_ref'], self.db.library)).fetchone()
                # A legal minimal presentation through the existing trusted
                # metadata SQL writer. Full metadata recapture is C-2's scope.
                metadata = {'album_ref': final['album_ref'], 'title': source['title'],
                            'artist': source['artist'], 'year': source['year'], 'tracks': []}
                captured = {'source': {'selected_local_album_id': final['selected_local_album_id'],
                             'selected_source_ref': final['selected_source_ref'],
                             'selected_library_root_id': self.metadata_root}, 'metadata': metadata,
                            'evidence_digest': evidence.digest(['C1 SQL metadata writer',
                                final['selected_source_ref'], build['metadata_generation'], metadata])}
                presentation_ref = evidence.admit_presentation(
                    connection, self.db.library, build['metadata_generation'], captured)
                mappings.append({'curator_position': final['curator_position'],
                    'item_ref': final['item_ref'], 'original_position': final['original_position'],
                    'presentation_ref': presentation_ref, 'descriptor_witness': None})
        assert len(mappings) == len(build['final'])
        build['mapping'] = mappings
        return mappings

    def map_pages(self, connection, build, mappings=None):
        mappings = build['mapping'] if mappings is None else mappings
        counts = []
        for offset in range(0, len(mappings), PAGE):
            page = deepcopy(mappings[offset:offset + PAGE])
            if build['staged']['kind'] == 'draft':
                sources = connection.execute('''select position,source_stamp
                    from app.album_top_artwork_draft_items where preparation_ref=%s
                      and position>%s and position<=%s and included order by position''',
                    (build['staged']['ref'], offset, offset + PAGE)).fetchall()
                witnesses = {row['position']: json.dumps(row['source_stamp'], sort_keys=True,
                    separators=(',', ':'), ensure_ascii=True, allow_nan=False) for row in sources}
                for row in page:
                    if row.get('descriptor_witness') is None:
                        row['descriptor_witness'] = witnesses.get(row.get('curator_position'))
            counts.append(connection.execute('select app.map_top_artwork_publication_page(%s,%s) as n',
                (build['ref'], Jsonb(page))).fetchone()['n'])
        assert counts == [len(mappings[offset:offset + PAGE]) for offset in range(0, len(mappings), PAGE)]
        return counts

    def seal(self, connection, build, expected=None):
        build['seal_digest'] = connection.execute('select app.seal_top_artwork_publication(%s,%s) as value',
            (build['ref'], expected)).fetchone()['value']
        return build['seal_digest']

    def point(self, connection, build):
        old = build['link']
        share_ref = str(old['ref']) if old else str(uuid4())
        revision = old['link_revision'] + 1 if old else 1
        connection.execute('''insert into app.shared_links
            (ref,top_ref,library_id,state,active_publication_ref,link_revision,enabled_at)
            values(%s,%s,%s,'enabled',%s,%s,clock_timestamp()) on conflict(top_ref) do update
            set state='enabled',active_publication_ref=excluded.active_publication_ref,
                link_revision=excluded.link_revision,enabled_at=excluded.enabled_at,revoked_at=null''',
            (share_ref, self.top['top_ref'], self.db.library, build['ref'], revision))
        build['share_ref'], build['link_next_revision'] = share_ref, revision

    def receipt(self, connection, build, **changes):
        publication_revision = connection.execute('select publication_revision from app.album_list_publications where ref=%s',
                                                  (build['ref'],)).fetchone()['publication_revision']
        receipt = {'top_ref': self.top['top_ref'], 'revision': str(build['top']['revision'] + 1),
                   'action': build['action'], 'request_key': build['operation_key'],
                   'publication': {'state': 'enabled', 'share_ref': build.get('share_ref', str(uuid4())),
                       'link_revision': str(build.get('link_next_revision', 1)),
                       'publication_ref': build['ref'], 'publication_revision': str(publication_revision)}}
        receipt.update(changes.pop('receipt_changes', {}))
        args = {'actor': self.db.owner.account_id, 'library': self.db.library,
                'key': build['operation_key'], 'session': self.db.owner.session_id,
                'action': build['action'], 'top': self.top['top_ref'], 'digest': build['command_digest'],
                'receipt': Jsonb(receipt), 'publication': build['ref']}
        args.update(changes)
        connection.execute('''insert into app.album_list_operations
            (actor_account_id,library_id,request_key,original_session_id,action,top_ref,
             command_digest,receipt,required_actions,publication_ref)
            values(%(actor)s,%(library)s,%(key)s,%(session)s,%(action)s,%(top)s,
                   %(digest)s,%(receipt)s,'{}',%(publication)s)''', args)
        build['receipt'] = receipt
        return receipt

    def consume(self, connection, build):
        connection.execute('select app.consume_top_artwork_publication(%s)', (build['ref'],))

    def publish(self, staged):
        with runtime(self) as connection:
            build = self.start_build(connection, staged)
            self.apply(connection, build)
            self.mapping(connection, build)
            self.map_pages(connection, build)
            self.seal(connection, build)
            self.point(connection, build)
            self.receipt(connection, build)
            self.consume(connection, build)
        self.top = {**self.top, 'revision': str(build['top']['revision'] + 1)}
        if staged['kind'] == 'draft':
            by_catalog = {row['album_ref']: row for row in self.items}
            self.items = [{**by_catalog[row['album_ref']], 'item_ref': row['item_ref'],
                           'selected_local_album_id': row['selected_local_album_id'],
                           'selected_source_ref': row['selected_source_ref']}
                          for row in build['final']]
        self.payload = {**self.payload, 'revision': self.top['revision'], 'items': self.items}
        return build

    def cleanup(self):
        with runtime(self) as connection:
            return connection.execute('select app.cleanup_top_artwork_preparations(%s,%s,%s,%s) as result',
                (self.top['top_ref'], self.db.library, self.db.owner.account_id,
                 int(self.top['revision']))).fetchone()['result']


def teardown_publications(case):
    """Synthetic DB maintenance with exact named, transactional trigger fences.

    No runtime privilege is changed and no production cleanup API is weakened.
    All references to this owner are removed before the shared db fixture closes.
    """
    with case.db.connect() as connection:
        connection.execute("set local lock_timeout='5s'")
        connection.execute("set local statement_timeout='120s'")
        assert connection.execute('select rolsuper from pg_roles where rolname=current_user').fetchone()['rolsuper'] is False
        # These are only the row-immutability triggers on explicitly owned
        # relations. Foreign keys, generation INSERT guards and deferred
        # finalization triggers remain enabled throughout cleanup.
        named = [(f'app.{table}', 'artwork_publication_immutable') for table in RETAINED]
        named += [('app.album_top_artwork_preparation_items', 'top_artwork_proof_immutable'),
                  ('app.album_top_artwork_draft_items', 'top_artwork_draft_immutable'),
                  ('app.album_top_artwork_assets', 'top_artwork_asset_immutable')]
        for table, trigger in named:
            connection.execute(f'alter table {table} disable trigger {trigger}')
        owner = (case.db.owner.account_id,)
        for table in ('album_top_artwork_publication_consumptions', 'album_top_artwork_publication_rows',
                      'album_top_artwork_publication_logical_rows', 'album_top_artwork_publication_baseline',
                      'album_top_artwork_publication_lineage', 'album_top_artwork_publication_proofs'):
            if table in ('album_top_artwork_publication_baseline',
                         'album_top_artwork_publication_logical_rows',
                         'album_top_artwork_publication_consumptions'):
                connection.execute(f'''delete from app.{table} where publication_ref in
                    (select publication_ref from app.album_top_artwork_publication_lineage
                     where owner_account_id=%s)''', owner)
            else:
                connection.execute(f'delete from app.{table} where owner_account_id=%s', owner)
        connection.execute('delete from app.shared_links where library_id=%s', (case.db.library,))
        connection.execute('delete from app.album_list_publications where library_id=%s', (case.db.library,))
        connection.execute('''delete from catalog.album_presentation_versions where ref in
            (select presentation_ref from library.album_presentation_evidence where library_id=%s)''',
            (case.db.library,))
        for table in ('album_top_artwork_draft_items', 'album_top_artwork_preparation_items',
                      'album_top_artwork_preparations', 'album_top_artwork_assets', 'album_top_artwork_budgets'):
            connection.execute(f'delete from app.{table} where owner_account_id=%s', owner)
        for table, trigger in reversed(named):
            connection.execute(f'alter table {table} enable trigger {trigger}')


@pytest.fixture
def publication_case(db, tmp_path):
    case = PublicationCase(db, tmp_path)
    try:
        with runtime(case):
            pass
        yield case
    finally:
        teardown_publications(case)


@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('count', [0, 1, 100, 101, 250])
def test_exact_excluded_transfer_pages_and_zero_row_lineage(publication_case, kind, count):
    case = publication_case.build(count, excluded=range(count))
    staged = case.stage(kind)
    assert_staging_budget(case, 1, count, 1024 + count * 1024)
    build = case.publish(staged)
    state = durable_snapshot(case)
    lineage = state['album_top_artwork_publication_lineage']
    assert len(lineage) == 1 and lineage[0]['row_count'] == count
    assert lineage[0]['included_count'] == 0
    assert str(lineage[0]['preparation_ref']) == staged['ref']
    assert lineage[0]['old_top_revision'] + 1 == lineage[0]['approved_top_revision']
    assert len(state['album_top_artwork_publication_logical_rows']) == count
    assert len(state['album_top_artwork_publication_rows']) == count
    assert len(state['album_list_publication_items']) == count
    assert state['album_top_artwork_publication_proofs'] == []
    assert state['album_top_artwork_assets'] == []
    assert len(state['album_top_artwork_publication_consumptions']) == 1
    assert state['album_top_artwork_publication_consumptions'][0]['removed_items'] == count
    assert not state['album_top_artwork_preparations']
    assert not state['album_top_artwork_preparation_items']
    assert not state['album_top_artwork_draft_items']
    assert state['seals'][0]['content_digest'] == build['seal_digest']
    assert state['seals'][0]['seal_contract_version'] == 2
    assert_staging_budget(case, 0, 0, 0)
    retained = durable_snapshot(case)
    case.cleanup()
    assert durable_snapshot(case) == retained


@POSIX_CAPTURE
@pytest.mark.parametrize('kind', ['saved', 'draft'])
def test_retained_exact_proofs_assets_and_actual_artwork_root_survive_consumption(publication_case, kind):
    case = publication_case.build(3, same_pixels=True, excluded=(1,))
    staged = case.stage(kind)
    before = durable_snapshot(case)
    staging_table = 'album_top_artwork_draft_items' if kind == 'draft' else 'album_top_artwork_preparation_items'
    original = before[staging_table]
    assets = before['album_top_artwork_assets']
    build = case.publish(staged)
    after = durable_snapshot(case)
    assert after['album_top_artwork_assets'] == assets and len(assets) == 1
    mappings = sorted(after['album_top_artwork_publication_rows'], key=lambda row: row['curator_position'])
    assert [str(row['item_ref']) for row in mappings] == [row['item_ref'] for row in build['final']]
    assert len(after['album_top_artwork_publication_proofs']) == 2
    proofs = {row['value_digest']: row for row in after['album_top_artwork_publication_proofs']}
    with runtime(case) as connection:
        for proof in proofs.values():
            encoded = connection.execute('select %s::jsonb::text as value',
                (Jsonb([str(proof['top_ref']), proof['library_id'], proof['owner_account_id'],
                        proof['proof_version'], proof['source_stamp'], proof['acquisition_stamp']]),)).fetchone()['value']
            assert proof['value_digest'] == sha256(b'artwork-publication-proof-jsonb-v1\0'
                                                   + encoded.encode('utf-8')).hexdigest()
    for actual, initial in zip(mappings, sorted(original, key=lambda row: row['position'])):
        assert actual['included'] is initial['included']
        assert actual['metadata_root_id'] == case.metadata_root
        if actual['included']:
            assert actual['artwork_root_id'] == case.artwork_root != case.metadata_root
            proof = proofs[actual['proof_value_digest']]
            assert proof['source_stamp'] == initial['source_stamp']
            assert proof['acquisition_stamp'] == initial['acquisition_stamp']
            assert actual['asset_ref'] == initial['asset_ref']
            assert proof['proof_version'] == (2 if kind == 'draft' else 1)
        else:
            assert actual['artwork_root_id'] is actual['asset_ref'] is actual['proof_value_digest'] is None
    assert_staging_budget(case, 0, 0, 0)
    assert {(row['asset_count'], row['byte_count']) for row in budget_values(case)} == {
        (1, assets[0]['byte_length'])}
    # Retained history has no FK to the mutable working member vector or the
    # original login session. Deleting those disposable rows cannot remove it.
    with runtime(case) as connection:
        connection.execute('delete from app.album_list_items where top_ref=%s', (case.top['top_ref'],))
    with case.db.connect() as connection:
        connection.execute('delete from app.account_sessions where id=%s', (case.db.owner.session_id,))
    case.cleanup()
    surviving = durable_snapshot(case)
    for table in RETAINED:
        assert surviving[table] == after[table]
    assert surviving['album_top_artwork_assets'] == assets


@pytest.mark.parametrize('included', [False, pytest.param(True, marks=POSIX_CAPTURE)])
@pytest.mark.parametrize('variant', ['new_local', 'reorder_remove', 'replace_source', 'empty'])
def test_actual_apply_draft_n_to_n_plus_one_mapping(publication_case, variant, included):
    case = publication_case.build(3, excluded=() if included else (0, 1, 2))
    initial_items = deepcopy(case.items)
    if variant == 'new_local':
        case.top, _ = case.db.create(refs=[])
        case.payload['revision'] = case.top['revision']
        payload = command(case, new=(0, 1, 2), order=(2, 0, 1))
    elif variant == 'reorder_remove':
        payload = command(case, order=(2, 0))
    elif variant == 'empty':
        payload = command(case, order=())
    else:
        # An independent selected source for the same retained member. No old
        # admission authority is used and the saved item UUID is preserved.
        replacement = str(uuid4())
        with case.db.connect() as connection:
            for item in initial_items:
                connection.execute('''insert into app.album_list_item_publication_sources
                    (top_ref,item_ref,library_id,catalog_ref,selected_local_album_id,selected_source_ref)
                    values(%s,%s,%s,%s,%s,%s)''',
                    (case.top['top_ref'], item['item_ref'], case.db.library, item['album_ref'],
                     item['selected_local_album_id'], item['selected_source_ref']))
            connection.execute('''insert into library.album_metadata_sources
                (ref,library_id,local_album_id,library_root_id,container_identity,path_flavor,
                 capture_builder_version,state,title,artist,year,title_origin,artist_origin)
                select %s,library_id,local_album_id,library_root_id,%s,path_flavor,
                  capture_builder_version,state,title,artist,year,title_origin,artist_origin
                from library.album_metadata_sources where ref=%s''',
                (replacement, str(case.metadata_path / 'replacement-source'), case.items[0]['selected_source_ref']))
        case.items[0]['selected_source_ref'] = replacement
        payload = command(case)
    staged = case.stage('draft', payload=payload)
    with runtime(case) as connection:
        build = case.start_build(connection, staged)
        fingerprint = connection.execute('select content_fingerprint from app.album_list_publications where ref=%s',
                                          (build['ref'],)).fetchone()['content_fingerprint']
        assert fingerprint == build['fingerprint'] and fingerprint != '0' * 64
        logical = connection.execute('''select * from app.album_top_artwork_publication_logical_rows
            where publication_ref=%s order by curator_position''', (build['ref'],)).fetchall()
        if variant == 'new_local':
            assert all(row['saved_item_ref'] is None for row in logical)
            assert connection.execute('select count(*) as n from app.album_list_items where top_ref=%s',
                                      (case.top['top_ref'],)).fetchone()['n'] == 0
        final = case.apply(connection, build)
        case.mapping(connection, build)
        case.map_pages(connection, build)
        case.seal(connection, build)
        case.point(connection, build)
        case.receipt(connection, build)
        case.consume(connection, build)
        assert connection.execute('select content_fingerprint from app.album_list_publications where ref=%s',
                                  (build['ref'],)).fetchone()['content_fingerprint'] == fingerprint
    if variant == 'new_local':
        assert set(row['item_ref'] for row in final).isdisjoint(row['item_ref'] for row in initial_items)
        assert [row['original_position'] for row in final] == [1, 2, 3]
    elif variant == 'reorder_remove':
        assert [row['item_ref'] for row in final] == [initial_items[2]['item_ref'], initial_items[0]['item_ref']]
        assert [row['original_position'] for row in final] == [3, 1]
    elif variant == 'replace_source':
        assert final[0]['item_ref'] == initial_items[0]['item_ref']
        assert final[0]['selected_source_ref'] == replacement
    else:
        assert final == []


@POSIX_CAPTURE
def test_sixty_five_fresh_key_publications_release_slots_and_deduplicate_exact_proof(publication_case):
    case = publication_case.build(1)
    cached = case.results([case.items[0]['item_ref']])
    fingerprints, publications = set(), []
    for number in range(65):
        staged = case.stage(cached_results=cached)
        build = case.publish(staged)
        fingerprints.add(build['fingerprint'])
        publications.append(build['ref'])
        assert_staging_budget(case, 0, 0, 0)
    state = durable_snapshot(case)
    assert len(set(publications)) == len(fingerprints) == 65
    assert len(state['album_top_artwork_publication_lineage']) == 65
    assert len(state['album_top_artwork_publication_rows']) == 65
    assert len(state['album_top_artwork_publication_consumptions']) == 65
    assert len(state['album_top_artwork_publication_proofs']) == 1
    assert len(state['album_top_artwork_assets']) == 1
    before = durable_snapshot(case)
    for _ in range(3):
        case.cleanup()
    assert durable_snapshot(case) == before


@POSIX_CAPTURE
def test_saved_draft_and_publication_pins_share_one_asset_budget(publication_case):
    case = publication_case.build(1)
    cached = case.results([case.items[0]['item_ref']])
    first = case.stage(cached_results=cached)
    # A successor cancels the old header but leaves the retained saved pin.
    drafted = case.stage('draft')
    before = durable_snapshot(case)
    assert len(before['album_top_artwork_assets']) == 1
    assert len(before['album_top_artwork_preparation_items']) == 1
    assert len(before['album_top_artwork_draft_items']) == 1
    build = case.publish(drafted)
    with case.db.connect() as connection:
        connection.execute('''with deadline as (select clock_timestamp()-interval '1 second' as expiry)
            update app.album_top_artwork_preparations set created_at=expiry-interval '60 minutes',
                expires_at=expiry from deadline where ref=%s''', (first['ref'],))
    # Draft pin is now a permanent publication pin. Saved staging may be
    # reclaimed, but the one shared asset/count must remain unchanged.
    case.cleanup()
    after = durable_snapshot(case)
    assert after['album_top_artwork_preparation_items'] == []
    assert after['album_top_artwork_draft_items'] == []
    assert len(after['album_top_artwork_publication_rows']) == 1
    assert after['album_top_artwork_assets'] == before['album_top_artwork_assets']
    assert_staging_budget(case, 0, 0, 0)
    asset = after['album_top_artwork_assets'][0]
    assert {(row['asset_count'], row['byte_count']) for row in budget_values(case)} == {(1, asset['byte_length'])}
    with case.db.connect() as connection:
        connection.execute('update app.album_lists set deleted_at=clock_timestamp() where ref=%s',
                           (case.top['top_ref'],))
    case.cleanup()
    final = durable_snapshot(case)
    assert final['album_top_artwork_assets'] == after['album_top_artwork_assets']
    assert final['album_top_artwork_publication_rows'] == after['album_top_artwork_publication_rows']
    assert str(final['album_top_artwork_publication_rows'][0]['publication_ref']) == build['ref']


@pytest.mark.parametrize('kind', ['saved', 'draft'])
def test_maximum_excluded_publication_and_exact_fifty_pages(publication_case, monkeypatch, kind):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = publication_case.build(MAX_ROWS, excluded=range(MAX_ROWS))
    staged = case.stage(kind)
    with runtime(case) as connection:
        build = case.start_build(connection, staged)
        case.apply(connection, build)
        case.mapping(connection, build)
        assert case.map_pages(connection, build) == [100] * 50
        case.seal(connection, build)
        case.point(connection, build)
        case.receipt(connection, build)
        case.consume(connection, build)
    assert_staging_budget(case, 0, 0, 0)
    with case.db.connect() as connection:
        row = connection.execute('select * from app.album_top_artwork_publication_consumptions where publication_ref=%s',
                                 (build['ref'],)).fetchone()
        assert row['removed_items'] == MAX_ROWS
        assert row['released_proof_bytes'] == 1024 + MAX_ROWS * 1024


@POSIX_CAPTURE
@pytest.mark.parametrize('kind', ['saved', 'draft'])
def test_maximum_included_publication_fits_proof_reservation_independent_of_images(publication_case, kind):
    case = publication_case.build(MAX_ROWS, same_pixels=True)
    staged = case.stage(kind)
    assert MAX_PROOF_RESERVATION == 348161024 > 256 * 1024 * 1024
    assert_staging_budget(case, 1, MAX_ROWS, MAX_PROOF_RESERVATION)
    build = case.publish(staged)
    state = durable_snapshot(case)
    assert len(state['album_top_artwork_publication_rows']) == MAX_ROWS
    assert len(state['album_top_artwork_assets']) == 1
    asset = state['album_top_artwork_assets'][0]
    assert MAX_ROWS * asset['byte_length'] < MAX_IMAGES
    assert state['album_top_artwork_publication_lineage'][0]['proof_reservation'] == MAX_PROOF_RESERVATION
    assert state['album_top_artwork_publication_consumptions'][0]['released_proof_bytes'] == MAX_PROOF_RESERVATION
    assert_staging_budget(case, 0, 0, 0)
    assert len(build['mapping']) == MAX_ROWS


@pytest.mark.parametrize('consumed_kind', ['saved', 'draft'])
@pytest.mark.parametrize('reuse', ['saved', 'draft', 'fresh_generation', 'other_session', 'other_top'])
def test_zero_row_consumed_start_namespace_cannot_readmit(publication_case, consumed_kind, reuse):
    case = publication_case.build(0)
    staged = case.stage(consumed_kind)
    case.publish(staged)
    original_key = staged['payload']['request_key']
    if reuse == 'other_top':
        case.top, _ = case.db.create(refs=[])
    before = durable_snapshot(case)
    with runtime(case) as connection:
        assert connection.execute('select app.top_artwork_start_consumed(%s,%s,%s,%s) as consumed',
            (case.top['top_ref'], case.db.library, case.db.owner.account_id, original_key)).fetchone()['consumed'] is True
    with pytest.raises(psycopg.Error) as caught:
        with uncommitted(case) as connection:
            generation = staged['header']['request_generation'] + (1 if reuse == 'fresh_generation' else 0)
            session = case.db.owner.session_id + (1 if reuse == 'other_session' else 0)
            if reuse == 'draft':
                baseline = connection.execute('select app.top_artwork_draft_baseline(%s,%s,%s,%s) as digest',
                    (case.top['top_ref'], case.db.library, case.db.owner.account_id,
                     int(case.top['revision']))).fetchone()['digest']
                connection.execute('select app.start_top_artwork_draft_preparation('
                    + ','.join(['%s'] * 13) + ')',
                    (str(uuid4()), case.top['top_ref'], case.db.library, case.db.owner.account_id,
                     session, CONTEXT, int(case.top['revision']), original_key, generation,
                     str(uuid4()), 1, baseline, Jsonb([])))
            else:
                connection.execute('select app.start_top_artwork_preparation('
                    + ','.join(['%s'] * 11) + ')',
                    (str(uuid4()), case.top['top_ref'], case.db.library, case.db.owner.account_id,
                     session, CONTEXT, int(case.top['revision']), original_key, 'f' * 64, Jsonb([]), generation))
    assert caught.value.diag.constraint_name == 'top_artwork_preparation_consumed'
    assert durable_snapshot(case) == before
    # A new key is a new operation, including after zero-row consumption.
    case.payload = {**case.payload, 'revision': case.top['revision'], 'request_key': str(uuid4())}
    fresh = case.stage()
    assert fresh['ref'] != staged['ref']


@POSIX_CAPTURE
@pytest.mark.parametrize('mutation', ['source_extra', 'root_boolean', 'relative_boolean',
                                     'acquisition_extra', 'file_boolean', 'input_pixels_boolean',
                                     'source_version', 'acquisition_version', 'missing_root',
                                     'path_oversize', 'input_bytes_oversize', 'input_pixels_oversize'])
def test_legacy_saved_pair_gets_independent_exact_structural_check(publication_case, mutation):
    case = publication_case.build(1)
    results, pngs = case.results([case.items[0]['item_ref']])
    if mutation == 'source_extra':
        results[0]['source_stamp']['extra'] = 'not admitted'
    elif mutation == 'root_boolean':
        results[0]['source_stamp']['root_device'] = True
    elif mutation == 'relative_boolean':
        results[0]['source_stamp']['relative_parts'][0] = True
    elif mutation == 'acquisition_extra':
        results[0]['acquisition_stamp']['extra'] = 1
    elif mutation == 'file_boolean':
        results[0]['acquisition_stamp']['file']['inode'] = True
    elif mutation == 'input_pixels_boolean':
        results[0]['acquisition_stamp']['input_pixels'] = True
    elif mutation == 'source_version':
        results[0]['source_stamp']['descriptor_version'] = 1
    elif mutation == 'acquisition_version':
        results[0]['acquisition_stamp']['acquisition_version'] = 2
    elif mutation == 'missing_root':
        results[0]['source_stamp'].pop('root_inode')
    elif mutation == 'path_oversize':
        results[0]['source_stamp']['stored_cover_path'] = '/' + 'x' * 16384
    elif mutation == 'input_bytes_oversize':
        results[0]['acquisition_stamp']['input_bytes'] = 16777217
        results[0]['acquisition_stamp']['file']['size'] = 16777217
    else:
        results[0]['acquisition_stamp']['input_pixels'] = 16000001
    # The historical saved SQL completion checks only broad source/root scope.
    # This is an intentionally malformed trusted-writer input, not fabricated
    # successful acquisition. C-1 must reject it independently before retain.
    staged = case.stage(cached_results=(results, pngs))
    before = durable_snapshot(case)
    with pytest.raises(psycopg.Error):
        with uncommitted(case) as connection:
            build = case.start_build(connection, staged)
            case.apply(connection, build)
            case.mapping(connection, build)
            case.map_pages(connection, build)
            case.seal(connection, build)
    assert durable_snapshot(case) == before


@POSIX_CAPTURE
@pytest.mark.parametrize('encoding', ['whitespace', 'key_order'])
def test_v2_sql_value_binding_is_not_canonical_codec_authentication(publication_case, encoding):
    case = publication_case.build(1)
    payload = command(case)
    with runtime(case) as connection:
        ref = str(direct(case, payload, connection=connection))
    status = {'preparation_ref': ref, 'preparation_revision': '1'}
    key, lease, chosen = draft_capture.claim(case, status, payload)
    results, pngs = draft_capture.actual_results(case, payload, chosen)
    source = results[0]['source_stamp']
    canonical = results[0]['source_bytes']
    witness = (' ' + canonical + '\n' if encoding == 'whitespace' else
               json.dumps(dict(reversed(list(source.items()))), separators=(',', ':'), ensure_ascii=True))
    assert witness != canonical and json.loads(witness) == source
    results[0]['source_bytes'] = witness
    results[0]['acquisition_stamp']['descriptor_digest'] = sha256(
        b'AlbumHaven/artwork-descriptor/v2\0' + witness.encode('utf-8')).hexdigest()
    with pytest.raises(codec.InvalidArtworkProof):
        codec.validate_pair(source, results[0]['acquisition_stamp'])
    # Structural SQL accepts a bounded witness with the same JSONB value. The
    # strict codec above is the real canonical-byte boundary; this is not a
    # test of the later C-2 consent, inventory or HMAC service integration.
    draft_capture.complete(case, status, payload, key, lease, results, pngs)
    staged = {'ref': ref, 'kind': 'draft', 'payload': payload, 'header': preparation_header(case, ref)}
    with runtime(case) as connection:
        build = case.start_build(connection, staged)
        case.apply(connection, build)
        mappings = case.mapping(connection, build)
        mappings[0]['descriptor_witness'] = witness
        case.map_pages(connection, build, mappings)
        case.seal(connection, build)
        case.point(connection, build)
        case.receipt(connection, build)
        case.consume(connection, build)
    state = durable_snapshot(case)
    assert state['album_top_artwork_publication_proofs'][0]['source_stamp'] == source
    assert state['album_top_artwork_publication_proofs'][0]['acquisition_stamp'] == results[0]['acquisition_stamp']


@POSIX_CAPTURE
def test_exact_value_comparison_rejects_corrupted_dedup_hit(publication_case):
    case = publication_case.build(1)
    cached = case.results([case.items[0]['item_ref']])
    case.publish(case.stage(cached_results=cached))
    with case.db.connect() as connection:
        # Deliberate migrator-only corruption isolates digest-collision defense.
        # Runtime receives no mutation privilege and the hash is not recomputed.
        connection.execute('''alter table app.album_top_artwork_publication_proofs
            disable trigger artwork_publication_immutable''')
        connection.execute('''update app.album_top_artwork_publication_proofs
            set acquisition_stamp=jsonb_set(acquisition_stamp,'{input_pixels}','1'::jsonb)
            where owner_account_id=%s''', (case.db.owner.account_id,))
        connection.execute('''alter table app.album_top_artwork_publication_proofs
            enable trigger artwork_publication_immutable''')
    staged = case.stage(cached_results=cached)
    before = durable_snapshot(case)
    with pytest.raises(psycopg.Error):
        with uncommitted(case) as connection:
            build = case.start_build(connection, staged)
            case.apply(connection, build)
            case.mapping(connection, build)
            case.map_pages(connection, build)
    assert durable_snapshot(case) == before


@POSIX_CAPTURE
def test_general_cleanup_still_limits_512_rows_after_publication_transfer(publication_case):
    case = publication_case.build(513, excluded=range(1, 513))
    cached = case.results([case.items[0]['item_ref']])
    case.publish(case.stage(cached_results=cached))
    stale = case.stage(cached_results=cached)
    with case.db.connect() as connection:
        connection.execute('''with deadline as (select clock_timestamp()-interval '1 second' as expiry)
            update app.album_top_artwork_preparations set state='cancelled',
                created_at=expiry-interval '60 minutes',expires_at=expiry
            from deadline where ref=%s''', (stale['ref'],))
    first = case.cleanup()
    assert first['items_deleted'] == 512 and first['preparations_deleted'] <= 32
    assert first['assets_scanned'] <= 128 and first['assets_deleted'] == 0
    second = case.cleanup()
    assert second['items_deleted'] == 1 and second['preparations_deleted'] == 1
    assert_staging_budget(case, 0, 0, 0)
    state = durable_snapshot(case)
    assert len(state['album_top_artwork_publication_rows']) == 513
    assert len(state['album_top_artwork_assets']) == 1


@POSIX_CAPTURE
def test_general_cleanup_scans_only_128_asset_keys_and_never_reclaims_publication_pin(publication_case):
    case = publication_case.build(129)
    old = case.stage()
    drafted = case.stage('draft', payload=command(case, order=(0,)))
    case.publish(drafted)
    with case.db.connect() as connection:
        connection.execute('''with deadline as (select clock_timestamp()-interval '1 second' as expiry)
            update app.album_top_artwork_preparations set created_at=expiry-interval '60 minutes',
                expires_at=expiry from deadline where ref=%s''', (old['ref'],))
        pin = connection.execute('select asset_ref from app.album_top_artwork_publication_rows where top_ref=%s',
                                 (case.top['top_ref'],)).fetchone()['asset_ref']
    first = case.cleanup()
    assert first['items_deleted'] == 129
    assert first['assets_scanned'] <= 128 and first['assets_deleted'] <= 128
    second = case.cleanup()
    # Start admission may already have advanced the persistent bounded cursor.
    # Either order still scans the complete 129-key cycle in two bounded calls.
    assert sorted([first['assets_scanned'], second['assets_scanned']]) == [1, 128]
    assert first['assets_deleted'] + second['assets_deleted'] == 128
    state = durable_snapshot(case)
    assert len(state['album_top_artwork_assets']) == 1 and state['album_top_artwork_assets'][0]['ref'] == pin
    assert_staging_budget(case, 0, 0, 0)


@POSIX_CAPTURE
@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('count', [1, 100, 101, 250])
def test_included_proofs_cross_exact_100_row_transfer_boundaries(publication_case, kind, count):
    case = publication_case.build(count, same_pixels=True)
    staged = case.stage(kind)
    build = case.publish(staged)
    state = durable_snapshot(case)
    assert len(build['mapping']) == count
    assert len(state['album_top_artwork_publication_rows']) == count
    assert len(state['album_top_artwork_publication_proofs']) == count
    assert len(state['album_top_artwork_assets']) == 1
    assert state['album_top_artwork_publication_lineage'][0]['included_count'] == count
    assert state['album_top_artwork_publication_consumptions'][0]['removed_items'] == count
    assert_staging_budget(case, 0, 0, 0)


# Exact image-budget coverage uses measured, genuinely sanitized PNGs. No
# byte_length override, PNG padding, invented CapturedArtwork or trigger bypass
# is involved. These are source-authored tests; no decoder/DB execution is
# implied by the presence of this fixture. All four cases require POSIX capture.
BOUNDARY_MAX_ROWS = 1024


def _boundary_png(case, label, width, height, *, noise):
    """Write real pixels and measure the actual acquisition/sanitizer output.

    Calibration uses an existing local album ID but does not admit its proof.
    After normal metadata setup, every selected album gets its own real capture
    with its actual persisted cover path and local-album identity.
    """
    path = case.artwork_path / f'budget-{label}.png'
    if noise:
        size = width * height * 3
        pixels = b''.join(sha256(label.encode('ascii') + number.to_bytes(4, 'big')).digest()
                          for number in range((size + 31) // 32))[:size]
        image = foundation.Image.frombytes('RGB', (width, height), pixels)
    else:
        image = foundation.Image.new('RGB', (width, height), (29, 91, 173))
    with image:
        image.save(path, format='PNG')
    source = foundation.describe_artwork_source(library_id=case.db.library,
        local_album_id=case.db.album_ids[0], artwork_root_id=case.artwork_root,
        artwork_root_path=case.artwork_path, stored_cover_path=str(path), resolved_cover_path=path)
    captured = foundation.capture_artwork(source)
    assert (captured.width, captured.height) == (width, height)
    assert captured.content_digest == sha256(captured.png).hexdigest()
    assert 0 < len(captured.png) <= 327680
    return {'path': path, 'length': len(captured.png), 'digest': captured.content_digest,
            'width': width, 'height': height}


def _boundary_counts(total, large, middle, small):
    """Exact bounded three-coin arithmetic; no search over image bytes.

    For each positive large count, the modular inverse gives all possible
    middle counts. The greatest valid middle count minimizes the small count
    because middle > small. At most 1,022 large counts are considered.
    """
    if gcd(middle, small) != 1:
        return None
    inverse = pow(middle, -1, small)
    best = None
    ceiling = min((total - middle - small) // large, BOUNDARY_MAX_ROWS - 2)
    for large_count in range(ceiling, 0, -1):
        remainder = total - large_count * large
        first_middle = (remainder * inverse) % small or small
        last_middle = (remainder - small) // middle
        if last_middle < first_middle:
            continue
        middle_count = first_middle + ((last_middle - first_middle) // small) * small
        small_count = (remainder - middle_count * middle) // small
        counts = (large_count, middle_count, small_count)
        if sum(counts) <= BOUNDARY_MAX_ROWS and (best is None or sum(counts) < sum(best)):
            assert all(count > 0 for count in counts)
            assert sum(count * length for count, length in zip(counts, (large, middle, small))) == total
            best = counts
    return best


def _exact_boundary_case(case, total):
    """Select at most three real assets and at most 1,024 actual album rows.

    Pillow/zlib versions may change encoded lengths. Measure 21 deterministic
    images (one large, four middle, sixteen small), then solve using those exact
    lengths. Failure to find a bounded exact solution is a test failure, never
    a skip, approximation or reason to pad the sanitized output.
    """
    large = _boundary_png(case, 'large', 256, 256, noise=True)
    middle = [_boundary_png(case, f'middle-{edge}', edge, edge, noise=True)
              for edge in range(29, 33)]
    small = [_boundary_png(case, f'small-{width}-{height}', width, height, noise=False)
             for width in range(1, 9) for height in (1, 2)]
    assert 131072 <= large['length'] <= 327680
    assert all(1000 <= row['length'] <= 4096 for row in middle)
    assert all(32 <= row['length'] <= 512 for row in small)
    best = None
    for medium in middle:
        for tiny in small:
            counts = _boundary_counts(total, large['length'], medium['length'], tiny['length'])
            if counts is not None and (best is None or sum(counts) < sum(best[1])):
                best = ((large, medium, tiny), counts)
    assert best is not None, (
        'No exact bounded image-budget fixture for this encoder', total,
        large['length'], [row['length'] for row in middle], [row['length'] for row in small])
    assets, counts = best
    assert len({row['digest'] for row in assets}) == 3
    assert sum(row['length'] for row in assets) < 1024 * 1024
    plan = [asset for asset, count in zip(assets, counts) for _ in range(count)]
    assert len(plan) <= BOUNDARY_MAX_ROWS < MAX_ROWS
    assert sum(row['length'] for row in plan) == total
    case.build(len(plan))
    # Each selected album genuinely points to one of the three shared local
    # source files. The initial tiny PNGs from build remain ordinary tempfiles;
    # no new privileged fixture hook or acquisition substitution is installed.
    with case.db.connect() as connection:
        connection.execute("set local lock_timeout='5s'")
        connection.execute("set local statement_timeout='120s'")
        assert connection.execute('select rolsuper from pg_roles where rolname=current_user').fetchone()['rolsuper'] is False
        for album, asset in zip(case.album_ids, plan):
            connection.execute('update library.local_albums set cover_path=%s where id=%s and library_id=%s',
                               (str(asset['path']), album, case.db.library))
    case.cover_paths = [row['path'] for row in plan]
    return case, {row['digest']: row for row in assets}


def _boundary_complete(case, connection, staged, status, key, lease, results, pngs):
    if staged['kind'] == 'draft':
        draft_capture.complete(case, status, staged['payload'], key, lease, results, pngs,
                               connection=connection)
    else:
        connection.execute('select app.complete_top_artwork_batch(%s,%s,%s,%s,%s,%s,%s,%s,%s)',
            (status['preparation_ref'], case.db.owner.account_id, case.db.owner.session_id,
             CONTEXT, int(status['preparation_revision']), key, lease, Jsonb(results), pngs))


def _boundary_stage(case, kind, target, assets):
    """Use actual runtime admission/claims/completions, four rows at a time.

    0134 already enforces the publication aggregate at batch completion. The
    +1 case must fail there: manufacturing an over-limit ready preparation to
    enter C-1 would bypass an existing invariant and is not this test's scope.
    """
    payload = (command(case) if kind == 'draft' else
               {**case.payload, 'revision': case.top['revision'], 'request_key': str(uuid4())})
    with runtime(case) as connection:
        if kind == 'draft':
            ref = str(direct(case, payload, connection=connection))
        else:
            admitted = [{'item_ref': row['item_ref'], 'catalog_ref': row['album_ref'],
                'position': position, 'selected_local_album_id': row['selected_local_album_id'],
                'selected_source_ref': row['selected_source_ref'],
                'selected_library_root_id': case.metadata_root, 'included': row['include_artwork']}
                for position, row in enumerate(payload['items'], 1)]
            ref = str(connection.execute('select app.start_top_artwork_preparation('
                + ','.join(['%s'] * 11) + ') as ref',
                (str(uuid4()), case.top['top_ref'], case.db.library, case.db.owner.account_id,
                 case.db.owner.session_id, CONTEXT, int(case.top['revision']), payload['request_key'],
                 evidence.digest(['sql-publication-test-manifest', admitted]), Jsonb(admitted),
                 payload['request_generation'])).fetchone()['ref'])
    staged = {'ref': ref, 'kind': kind, 'payload': payload}
    accepted_bytes = accepted_count = 0
    for _ in range((len(case.items) + 3) // 4):
        header = preparation_header(case, ref)
        status = {'preparation_ref': ref, 'preparation_revision': str(header['revision'])}
        assert header['state'] == 'preparing'
        key, lease = str(uuid4()), str(uuid4())
        with runtime(case) as connection:
            if kind == 'draft':
                _, _, chosen = draft_capture.claim(case, status, payload, key=key, lease=lease,
                                                    connection=connection)
            else:
                chosen = connection.execute('select app.claim_top_artwork_batch(%s,%s,%s,%s,%s,%s,%s) as items',
                    (ref, case.db.owner.account_id, case.db.owner.session_id, CONTEXT,
                     int(status['preparation_revision']), key, lease)).fetchone()['items']
        assert 1 <= len(chosen) <= 4
        # Actual file observation and decoder execution happen outside SQL locks.
        results, pngs = (draft_capture.actual_results(case, payload, chosen)
                         if kind == 'draft' else case.results(chosen))
        assert len(results) == len(pngs) == len(chosen)
        for result, png in zip(results, pngs):
            digest = sha256(png).hexdigest()
            assert digest == result['content_digest'] and digest in assets
            expected = assets[digest]
            assert len(png) == expected['length']
            assert (result['width'], result['height']) == (expected['width'], expected['height'])
        next_bytes = accepted_bytes + sum(len(png) for png in pngs)
        next_count = accepted_count + len(chosen)
        if next_bytes > MAX_IMAGES:
            assert next_bytes == target == MAX_IMAGES + 1
            assert next_count == len(case.items)
            # Claim was committed legitimately. Only this completion must roll
            # back; compare after the claim, including its still-live lease.
            before = durable_snapshot(case)
            with pytest.raises(psycopg.errors.CheckViolation) as caught:
                with runtime(case) as connection:
                    _boundary_complete(case, connection, staged, status, key, lease, results, pngs)
            assert caught.value.diag.constraint_name == 'top_artwork_publication_budget'
            assert durable_snapshot(case) == before
            return staged, accepted_bytes, accepted_count
        with runtime(case) as connection:
            _boundary_complete(case, connection, staged, status, key, lease, results, pngs)
        accepted_bytes, accepted_count = next_bytes, next_count
    assert accepted_bytes == target == MAX_IMAGES
    assert accepted_count == len(case.items)
    staged['header'] = preparation_header(case, ref)
    assert staged['header']['state'] == 'ready'
    return staged, accepted_bytes, accepted_count


@POSIX_CAPTURE
@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('excess', [0, 1], ids=['exact-128-MiB', 'one-byte-over'])
def test_exact_publication_image_budget_with_genuine_sanitized_assets(publication_case, kind, excess):
    target = MAX_IMAGES + excess
    assert MAX_IMAGES == 134217728
    case, assets = _exact_boundary_case(publication_case, target)
    staged, accepted_bytes, accepted_count = _boundary_stage(case, kind, target, assets)
    table = ('album_top_artwork_draft_items' if kind == 'draft'
             else 'album_top_artwork_preparation_items')
    with runtime(case) as connection:
        actual = connection.execute(f'''select count(*) as n,coalesce(sum(a.byte_length),0) as bytes
            from app.{table} i join app.album_top_artwork_assets a on a.ref=i.asset_ref
            where i.preparation_ref=%s and i.included and i.status='ready' ''',
            (staged['ref'],)).fetchone()
    assert (actual['n'], actual['bytes']) == (accepted_count, accepted_bytes)
    assert_staging_budget(case, 1, len(case.items), 1024 + len(case.items) * 69632)
    if excess:
        assert accepted_bytes < MAX_IMAGES and accepted_count < len(case.items)
        state = durable_snapshot(case)
        assert all(state[table] == [] for table in RETAINED)
        assert state['album_list_publications'] == [] and state['shared_links'] == []
        assert preparation_header(case, staged['ref'])['state'] == 'preparing'
        return

    # Equality must survive C-1 admission, mapping, seal, pointer, operation
    # receipt, consumption and the actual transaction commit.
    build = case.publish(staged)
    with runtime(case) as connection:
        retained = connection.execute('''select count(*) as n,sum(a.byte_length) as bytes
            from app.album_top_artwork_publication_rows r
            join app.album_top_artwork_assets a on a.ref=r.asset_ref
            where r.publication_ref=%s and r.included''', (build['ref'],)).fetchone()
        actual_assets = connection.execute('''select * from app.album_top_artwork_assets
            where top_ref=%s and owner_account_id=%s''',
            (case.top['top_ref'], case.db.owner.account_id)).fetchall()
    assert (retained['n'], retained['bytes']) == (len(case.items), MAX_IMAGES)
    assert len(actual_assets) == len(assets) == 3
    for asset in actual_assets:
        expected = assets[asset['content_digest']]
        assert asset['byte_length'] == len(asset['png']) == expected['length']
        assert sha256(asset['png']).hexdigest() == asset['content_digest']
        assert (asset['sanitizer_contract'], asset['mime_type'], asset['width'], asset['height']) == (
            1, 'image/png', expected['width'], expected['height'])
    physical_bytes = sum(row['byte_length'] for row in actual_assets)
    assert physical_bytes < 1024 * 1024 < MAX_IMAGES
    assert {(row['asset_count'], row['byte_count']) for row in budget_values(case)} == {(3, physical_bytes)}
    assert_staging_budget(case, 0, 0, 0)
    committed = durable_snapshot(case)
    assert committed['album_top_artwork_publication_consumptions'][0]['removed_items'] == len(case.items)
    case.cleanup()
    assert durable_snapshot(case) == committed


def _track_budget_mapping(case, connection, build, counts):
    """Trusted normalized SQL presentation fixtures, not metadata recapture.

    Each actual presentation is independently sealed with at most 5,000 real
    track rows. Only the aggregate across presentations is under test; no claim
    is made that these synthetic titles came from 100,000 local media files.
    """
    assert len(counts) == len(build['final']) <= 21
    mappings = []
    for final, count in zip(build['final'], counts):
        assert 0 < count <= 5000
        source = connection.execute('''select title,artist,year from library.album_metadata_sources
            where ref=%s and library_id=%s''',
            (final['selected_source_ref'], case.db.library)).fetchone()
        metadata = {'album_ref': final['album_ref'], 'title': source['title'],
            'artist': source['artist'], 'year': source['year'],
            'tracks': [{'position': position, 'title': f'Track {position}',
                        'artist': 'Synthetic artist', 'duration_ms': 180000}
                       for position in range(1, count + 1)]}
        captured = {'source': {'selected_local_album_id': final['selected_local_album_id'],
            'selected_source_ref': final['selected_source_ref'],
            'selected_library_root_id': case.metadata_root}, 'metadata': metadata,
            'evidence_digest': evidence.digest(['C1 trusted SQL track-budget fixture',
                final['selected_source_ref'], build['metadata_generation'], metadata])}
        presentation = evidence.admit_presentation(connection, case.db.library,
                                                   build['metadata_generation'], captured)
        mappings.append({'curator_position': final['curator_position'],
            'item_ref': final['item_ref'], 'original_position': final['original_position'],
            'presentation_ref': presentation, 'descriptor_witness': None})
    build['mapping'] = mappings


def _publication_track_totals(connection, publication_ref):
    actual = connection.execute('''select count(*) as n from app.album_list_publication_items i
        join catalog.album_presentation_tracks t on t.presentation_ref=i.presentation_ref
        where i.publication_ref=%s''', (publication_ref,)).fetchone()['n']
    sealed = connection.execute('''select coalesce(sum(s.track_count),0) as n
        from app.album_list_publication_items i
        join library.album_presentation_seals s on s.presentation_ref=i.presentation_ref
        where i.publication_ref=%s and s.sealed_at is not null''',
        (publication_ref,)).fetchone()['n']
    return actual, sealed


@pytest.mark.parametrize('excess', [0, 1], ids=['exact-100000-tracks', 'one-track-over'])
def test_publication_seal_exact_track_aggregate_with_trusted_sql_presentations(publication_case, excess):
    # Twenty individually legal 5,000-track presentations establish equality;
    # the extra presentation has one genuine SQL child row, not a forged count.
    counts = [5000] * 20 + ([1] if excess else [])
    case = publication_case.build(len(counts), excluded=range(len(counts)))
    staged = case.stage()
    before = durable_snapshot(case)
    context = uncommitted if excess else runtime
    with context(case) as connection:
        build = case.start_build(connection, staged)
        case.apply(connection, build)
        _track_budget_mapping(case, connection, build, counts)
        case.map_pages(connection, build)
        assert _publication_track_totals(connection, build['ref']) == (100000 + excess,) * 2
        if excess:
            # Scope the expected error to the C-1 seal itself. Each preceding
            # presentation and mapping must have succeeded under the real role.
            with pytest.raises(psycopg.errors.CheckViolation) as caught:
                case.seal(connection, build)
            assert caught.value.diag.constraint_name == 'top_artwork_publication_budget'
        else:
            case.seal(connection, build)
            case.point(connection, build)
            case.receipt(connection, build)
            case.consume(connection, build)
    if excess:
        assert durable_snapshot(case) == before
        with runtime(case) as connection:
            assert _publication_track_totals(connection, build['ref']) == (0, 0)
        assert_staging_budget(case, 1, len(counts), 1024 + len(counts) * 1024)
    else:
        with runtime(case) as connection:
            assert _publication_track_totals(connection, build['ref']) == (100000, 100000)
            consumed = connection.execute('''select removed_items from app.album_top_artwork_publication_consumptions
                where publication_ref=%s''', (build['ref'],)).fetchone()
            assert consumed['removed_items'] == len(counts)
        assert_staging_budget(case, 0, 0, 0)
