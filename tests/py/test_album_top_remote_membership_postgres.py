"""Mixed membership through the actual owner, real roles and immutable SQL facts.

Provider calls are the explicit synthetic acquisition seam only. Membership,
Copy, read, replay and all authority/retirement/budget checks use real owners.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import timedelta
from threading import Barrier, get_ident
from uuid import uuid4

import pytest

from music_app.services.owned_album_tops import (
    BROWSE, CREATE, MANAGE, ITEMS, ACCESS, normalize_top_command,
)
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.remote_top_postgres_support import CONTEXT, evidence, payload, destination, remote, db, urls, sql_error
from tests.py.remote_top_retention_postgres_support import ATTACH, invoke, retained, runtime
from tests.py.postgres_runtime_role_contract import assert_runtime_role
from tests.py.test_owned_album_tops_postgres import assert_error
from tests.py.test_album_top_collaboration_postgres import member, new_session, write
from tests.py.test_album_top_owner_publication_postgres import configured, enable, sharing
from tests.py.test_owned_album_top_route_boundary import middleware_app, mutation_headers, asgi_response


def pending(receipt):
    return {'kind': 'remote_acquisition', 'acquisition_ref': receipt['acquisition_ref'],
            'evidence_version': receipt['evidence_version']}


COPY_DISCOVERY = 'select a.initiating_actor_account_id from app.album_list_item_remote_sources r'


@contextmanager
def record_owner_sql(database):
    """Record real SQL and parameters per worker, preserving the R-A observer."""
    connect = database.service._connect
    recorded = []

    class RecordedConnection:
        def __init__(self, real):
            self.real = real

        def execute(self, sql, params=None):
            result = self.real.execute(sql, params)
            recorded.append((get_ident(), ' '.join(sql.lower().split()), params))
            return result

        def __getattr__(self, name):
            return getattr(self.real, name)

    @contextmanager
    def observed(*args, **kwargs):
        with connect(*args, **kwargs) as connection:
            yield RecordedConnection(connection)

    database.service._connect = observed
    try:
        yield recorded
    finally:
        database.service._connect = connect


class MembershipCase:
    def __init__(self, storage):
        self.storage, self.remote, self.db = storage, storage.remote, storage.db
        self.external_ids = []
        self.fact_titles = []
        self.acquisitions = {}

    def acquire(self, top=None, *, actor=None, facts=None, target=None):
        self.remote.facts = facts or evidence(mbid=str(uuid4()), title='Remote album ' + uuid4().hex)
        self.external_ids.append(self.remote.facts.release_group_id)
        self.fact_titles.append(self.remote.facts.title)
        command = self.remote.prepare_v2(target or destination(top), actor=actor,
            mbid=self.remote.facts.release_group_id)
        receipt = self.remote.acquire(command, actor=actor)
        fact = next(row for row in self.remote.rows() if str(row['ref']) == receipt['acquisition_ref'])
        self.acquisitions[receipt['acquisition_ref']] = {'command': command, 'receipt': receipt,
            'fact': fact, 'actor': actor or self.db.owner}
        return receipt

    def execute(self, command, *, actor=None, **options):
        before = len(self.remote.calls)
        c2_before = self.remote.c2_state()
        try:
            result = self.db.service.execute(self.db.context(actor), command, context_ref=CONTEXT, **options)
            selections = command.data.get('selections', ()) if command.action in {'create', 'add'} else (
                [entry.get('source', {}) for entry in command.data.get('item_selections', ())]
                if command.action == 'save' else ())
            selected = {entry['acquisition_ref'] for entry in selections if entry.get('kind') == 'remote_acquisition'}
            fresh = [row for row in c2_before['album_top_remote_acquisitions'] if str(row['ref']) in selected
                and row['preparation_ref'] is not None]
            if fresh:
                self.assert_consumed(command, result, fresh, c2_before)
            return result
        finally:
            assert len(self.remote.calls) == before, 'Membership/replay must never call provider transport'

    def assert_consumed(self, command, result, facts, before):
        """Exact assertions over the real committed operation/bridge/terminal."""
        after = self.remote.c2_state()
        remaining = {str(row['ref']) for row in after['album_top_remote_acquisitions']}
        attempts = {str(row['acquisition_ref']): row for row in after['album_top_remote_attempts']}
        with self.db.connect() as connection:
            operation = connection.execute('select * from app.album_list_operations where actor_account_id=%s and request_key=%s',
                (facts[0]['actor_account_id'], command.request_key)).fetchone()
            assert operation is not None and operation['command_digest'] == command.digest
            assert operation['original_session_id'] == facts[0]['original_session_id']
            assert operation['action'] == command.action and operation['receipt'] == result
            for fact in facts:
                ref = str(fact['ref']); attempt = attempts[ref]
                assert ref not in remaining and attempt['state'] == 'consumed'
                assert attempt['evidence_version'] == fact['evidence_version']
                assert str(attempt['operation_request_key']) == command.request_key
                assert str(attempt['consumed_top_ref']) == result['top_ref']
                assert attempt['consumed_revision'] == int(result['revision'])
                bridge = connection.execute('select * from app.album_list_item_remote_sources where top_ref=%s and item_ref=%s',
                    (result['top_ref'], attempt['consumed_item_ref'])).fetchone()
                assert bridge is not None and bridge['admission_ref'] == attempt['consumed_admission_ref']
                assert bridge['catalog_ref'] == attempt['consumed_catalog_ref']
                admission = connection.execute('select * from app.album_top_remote_admissions where ref=%s',
                    (bridge['admission_ref'],)).fetchone()
                assert admission['evidence_version'] == fact['evidence_version'] and admission['retired_at'] is None
                parent = next(row for row in after['album_top_remote_preparations'] if row['ref'] == fact['preparation_ref'])
                assert parent['destination_ref'] == fact['destination_ref']
                assert parent['destination_revision'] == fact['destination_revision']
                assert parent['closed_at'] is None
                if command.action in {'add', 'save'}:
                    assert fact['destination_revision'] == int(command.data['revision'])
                    assert int(result['revision']) == fact['destination_revision'] + 1
                else:
                    assert fact['destination_revision'] is None
                    assert str(fact['destination_ref']) == command.data['draft_ref'] == result['draft_ref']
        for table, identity in (('album_top_remote_preparations', 'ref'), ('album_top_remote_pending_budgets', 'actor_account_id')):
            current = {row[identity]: row for row in after[table]}
            for old in before[table]:
                charged = [fact for fact in facts if (fact['preparation_ref'] if identity == 'ref'
                    else fact['actor_account_id']) == old[identity]]
                new = current[old[identity]]
                assert new['pending_count'] == old['pending_count'] - len(charged)
                assert new['pending_bytes'] == old['pending_bytes'] - sum(fact['facts_bytes'] for fact in charged)
                assert new['reservation_count'] == old['reservation_count']
                if identity == 'ref':
                    assert new['attempt_count'] == old['attempt_count']

    def command(self, action, top=None, **data):
        body = {'request_key': str(uuid4()), **data}
        if top is not None:
            body['revision'] = top['revision']
        return normalize_top_command(action, body, top_ref=top['top_ref'] if top else None)

    def create(self, *, local=True, acquired=None):
        acquired = acquired or self.acquire()
        selections = ([{'kind': 'local_catalog', 'album_ref': self.db.album_refs[0]}] if local else []) + [pending(acquired)]
        command = self.command('create', title='Mixed Top', draft_ref=acquired['destination']['draft_ref'], selections=selections)
        return self.execute(command), command

    def read(self, top, actor=None, **options):
        before = len(self.remote.calls)
        try:
            return self.db.service.read(self.db.context(actor), top_ref=top['top_ref'], context_ref=CONTEXT, **options)
        finally:
            assert len(self.remote.calls) == before, 'Reading retained facts must never call provider transport'

    def rows(self, table):
        order = {'album_top_remote_admissions': 'ref', 'album_list_item_remote_sources': 'top_ref,item_ref',
                 'album_top_remote_retained_budgets': 'top_ref', 'shared_links': 'ref',
                 'album_list_publications': 'ref', 'album_list_item_publication_sources': 'top_ref,item_ref',
                 'album_list_publication_items': 'publication_ref,curator_position'}
        assert table in order
        with self.db.connect() as connection:
            return connection.execute('select * from app.' + table + ' where library_id=any(%s) order by ' + order[table],
                                      (self.db.library_ids,)).fetchall()

    def snapshot(self):
        with self.db.connect() as connection:
            working = {key: connection.execute('select * from app.' + table + ' where library_id=any(%s) order by ' + order,
                (self.db.library_ids,)).fetchall() for key, table, order in (
                    ('tops', 'album_lists', 'ref'), ('items', 'album_list_items', 'ref'),
                    ('operations', 'album_list_operations', 'actor_account_id,request_key'))}
            identities = connection.execute('''select * from catalog.release_group_provider_identities
                where external_id=any(%s) order by external_id''', (self.external_ids,)).fetchall()
            catalogs = connection.execute('''select * from catalog.release_groups
                where ref=any(%s::uuid[]) or title=any(%s) or ref in (
                    select catalog_ref from catalog.release_group_provider_identities where external_id=any(%s))
                order by ref''', (self.db.album_refs, self.fact_titles, self.external_ids)).fetchall()
            seals = connection.execute('''select s.* from app.album_list_publication_seals s
                join app.album_list_publications p on p.ref=s.publication_ref
                where p.library_id=any(%s) order by s.publication_ref''', (self.db.library_ids,)).fetchall()
            presentations = connection.execute('''select * from catalog.album_presentation_versions
                where catalog_ref=any(%s::uuid[]) order by ref''', (self.db.album_refs,)).fetchall()
            presentation_tracks = connection.execute('''select t.* from catalog.album_presentation_tracks t
                join catalog.album_presentation_versions p on p.ref=t.presentation_ref
                where p.catalog_ref=any(%s::uuid[]) order by t.presentation_ref,t.position''', (self.db.album_refs,)).fetchall()
            presentation_evidence = connection.execute('''select * from library.album_presentation_evidence
                where library_id=any(%s) order by presentation_ref''', (self.db.library_ids,)).fetchall()
            presentation_seals = connection.execute('''select s.* from library.album_presentation_seals s
                join catalog.album_presentation_versions p on p.ref=s.presentation_ref
                where p.catalog_ref=any(%s::uuid[]) order by s.presentation_ref''', (self.db.album_refs,)).fetchall()
        return {**working, 'identities': identities, 'catalogs': catalogs, 'publication_seals': seals,
                'pending_acquisitions': self.remote.rows(), 'c2_state': self.remote.c2_state(),
                'presentations': presentations, 'presentation_tracks': presentation_tracks,
                'presentation_evidence': presentation_evidence, 'presentation_seals': presentation_seals,
                **{name: self.rows(name) for name in ('album_top_remote_admissions',
                    'album_list_item_remote_sources', 'album_top_remote_retained_budgets',
                    'shared_links', 'album_list_publications', 'album_list_publication_items',
                    'album_list_item_publication_sources')}}

    # Real 30-minute pending expiry belongs to the separately selected acceptance
    # owner. No synthetic expired/ten-second pending writer exists in this fixture.

    def retire(self, admission):
        with self.db.connect() as connection:
            connection.execute('update app.album_top_remote_admissions set retired_at=clock_timestamp() where ref=%s',
                               (admission,))

    def historical(self, *, actor=None):
        """Trusted fixture inserts valid, two-day-old acquired facts; app attaches.

        No immutable existing row is rewritten, no deadline constant or SQL clock
        is replaced, and every inserted history row charges the real budget.
        """
        top, _ = self.db.create(refs=[])
        actor = actor or self.db.owner
        if actor.account_id != self.db.owner.account_id:
            top, _ = write(self.db, 'grant_editor', top, account_id=actor.account_id, role='editor')
        facts = evidence(mbid=str(uuid4()))
        catalog, admission = str(uuid4()), str(uuid4())
        self.db.album_refs.append(catalog)
        with self.db.connect() as connection:
            connection.execute('insert into catalog.release_groups(ref,title,artist_display) values(%s,%s,%s)',
                               (catalog, facts.title, facts.artist_display))
            connection.execute('''insert into app.album_top_remote_admissions(ref,top_ref,library_id,owner_account_id,
                catalog_ref,provider,entity_kind,external_id,evidence_version,title,artist_display,first_release_date,
                primary_type,initiating_actor_account_id,original_session_id,original_acquisition_ref,
                original_destination_kind,original_destination_ref,original_context_ref,acquired_at,admission_deadline,admitted_at)
                values(%s,%s,%s,%s,%s,'musicbrainz','release-group',%s,%s,%s,%s,%s,%s,%s,%s,%s,'top',%s,%s,
                statement_timestamp()-interval '2 days',statement_timestamp()-interval '2 days'+interval '30 minutes',
                statement_timestamp()-interval '2 days'+interval '1 minute')''',
                (admission, top['top_ref'], self.db.library, self.db.owner.account_id, catalog,
                 facts.release_group_id, facts.digest, facts.title, facts.artist_display, facts.first_release_date,
                 facts.primary_type, actor.account_id, actor.session_id, str(uuid4()), top['top_ref'], CONTEXT))
        self.storage.member(top, catalog, admission, facts.digest)
        with self.db.connect() as connection:
            connection.execute('update app.album_lists set next_original_position=2 where ref=%s', (top['top_ref'],))
        return top, admission


@contextmanager
def membership_case(retained):
    case = MembershipCase(retained)
    clock = case.db.service._clock
    try:
        with runtime(case.db) as connection:
            assert_runtime_role(connection, case.db)
        yield case
    finally:
        case.remote.after_statement = None
        case.db.service._clock = clock
        # Only identities explicitly acquired by this synthetic fixture are
        # cleaned. Original db.close deletes their catalog rows after child
        # teardown has removed immutable admissions and Top membership.
        with case.db.connect() as connection:
            # Nonempty v1 publication retains presentations independently of its
            # Top. Remove only this synthetic library's exact dependent rows,
            # using the trusted fixture role, before the original db.close.
            assert connection.execute('select rolsuper from pg_roles where rolname=current_user').fetchone()['rolsuper'] is False
            connection.execute('delete from app.album_list_operations where library_id=any(%s)', (case.db.library_ids,))
            connection.execute('delete from app.shared_links where library_id=any(%s)', (case.db.library_ids,))
            connection.execute('delete from app.album_list_publications where library_id=any(%s)', (case.db.library_ids,))
            connection.execute('''delete from catalog.album_presentation_versions where ref in
                (select presentation_ref from library.album_presentation_evidence where library_id=any(%s))''',
                (case.db.library_ids,))
            rows = connection.execute('select catalog_ref from catalog.release_group_provider_identities where external_id=any(%s)',
                                      (case.external_ids,)).fetchall()
            for row in rows:
                if str(row['catalog_ref']) not in case.db.album_refs:
                    case.db.album_refs.append(str(row['catalog_ref']))
            connection.execute('delete from catalog.release_group_provider_identities where external_id=any(%s)',
                               (case.external_ids,))


@pytest.fixture
def mixed(retained):
    with membership_case(retained) as case:
        yield case


def test_mixed_create_commits_complete_order_typed_draft_and_truthful_summary(mixed):
    top, command = mixed.create()
    result = mixed.read(top)
    assert top['draft_ref'] == command.data['draft_ref']
    assert len(result['items']) == 2
    assert [row['original_position'] for row in result['items']] == [1, 2]
    assert [row['curator_position'] for row in result['items']] == [1, 2]
    assert result['items'][0]['catalog_ref'] == mixed.db.album_refs[0]
    remote_item = result['items'][1]
    assert remote_item['source_kind'] == 'remote_summary'
    assert remote_item['metadata_coverage'] == 'album_summary_only'
    assert remote_item['track_metadata_status'] == 'unavailable' and remote_item['track_count'] is None
    assert not {'tracks', 'artwork', 'media_ref', 'edition', 'original_context_ref', 'original_session_id'} & remote_item.keys()
    draft = result['edit_draft']
    assert 'items' not in draft and [row['source']['kind'] for row in draft['item_selections']] == ['unselected', 'remote_retained']
    assert mixed.rows('album_top_remote_retained_budgets')[0]['admission_count'] == 1
    before = mixed.snapshot()
    assert mixed.execute(command) == top and mixed.snapshot() == before


@pytest.mark.parametrize('mismatch', ['draft', 'actor', 'session', 'context', 'version', 'retired'])
def test_pending_binding_failure_rolls_back_destination_identity_retention_and_receipt(mixed, mismatch):
    acquired = mixed.acquire()
    command = mixed.command('create', title='Bound draft', draft_ref=acquired['destination']['draft_ref'], selections=[pending(acquired)])
    actor, context = None, CONTEXT
    if mismatch == 'draft':
        command = normalize_top_command('create', {**command.data, 'draft_ref': str(uuid4()), 'request_key': command.request_key})
    elif mismatch == 'actor':
        actor = member(mixed.db)
    elif mismatch == 'session':
        actor = new_session(mixed.db, mixed.db.owner)
    elif mismatch == 'context':
        context = 'b' * 64
    elif mismatch == 'version':
        command = normalize_top_command('create', {**command.data, 'request_key': command.request_key,
            'selections': [{**pending(acquired), 'evidence_version': 'b' * 64}]})
    else:
        with mixed.db.connect() as connection:
            connection.execute('update app.album_top_remote_acquisitions set retired_at=clock_timestamp() where ref=%s',
                               (acquired['acquisition_ref'],))
    before = mixed.snapshot()
    assert_error(lambda: mixed.db.service.execute(mixed.db.context(actor), command, context_ref=context),
                 'remote_evidence_unavailable', 409)
    assert mixed.snapshot() == before


def test_duplicate_resolved_local_remote_catalog_is_atomic(mixed):
    acquired = mixed.acquire()
    with mixed.db.connect() as connection:
        connection.execute("""insert into catalog.release_group_provider_identities(provider,entity_kind,external_id,catalog_ref)
            values('musicbrainz','release-group',%s,%s)""", (mixed.remote.facts.release_group_id, mixed.db.album_refs[0]))
    command = mixed.command('create', title='Collision', draft_ref=acquired['destination']['draft_ref'],
        selections=[{'kind': 'local_catalog', 'album_ref': mixed.db.album_refs[0]}, pending(acquired)])
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(command), 'duplicate_album', 409)
    assert mixed.snapshot() == before


def test_named_editor_add_charges_destination_owner_and_retains_after_editor_departure(mixed):
    database = mixed.db
    editor = member(database)
    top, _ = database.create(refs=[])
    top, _ = write(database, 'grant_editor', top, account_id=editor.account_id, role='editor')
    grant = top['grant_ref']
    acquired = mixed.acquire(top, actor=editor)
    command = mixed.command('add', top, selections=[pending(acquired)])
    mixed.remote.statements.clear()
    top = mixed.execute(command, actor=editor)
    admission = mixed.rows('album_top_remote_admissions')[0]
    assert admission['owner_account_id'] == database.owner.account_id
    assert admission['initiating_actor_account_id'] == editor.account_id
    assert mixed.rows('album_top_remote_retained_budgets')[0]['owner_account_id'] == database.owner.account_id
    statements = mixed.remote.statements
    account_lock = next(i for i, sql in enumerate(statements) if 'from app.accounts' in sql and 'for update' in sql)
    top_lock = next(i for i, sql in enumerate(statements) if sql.startswith('select * from app.album_lists') and 'for update' in sql)
    retain = next(i for i, sql in enumerate(statements) if 'app.retain_top_remote_acquisition' in sql)
    budget = next(i for i, sql in enumerate(statements) if 'app.lock_top_remote_pending_actor' in sql)
    sources = next(i for i, sql in enumerate(statements) if 'app.lock_top_remote_membership_sources' in sql)
    receipt = next(i for i, sql in enumerate(statements) if sql.startswith('insert into app.album_list_operations '))
    consume = next(i for i, sql in enumerate(statements) if 'app.consume_top_remote_acquisitions' in sql)
    assert account_lock < budget < top_lock < sources < retain < receipt < consume
    detail = mixed.read(top)
    source = detail['edit_draft']['item_selections'][0]['source']
    top = mixed.execute(mixed.command('remove', top, item_refs=[detail['items'][0]['ref']]))
    top, _ = write(database, 'revoke_editor', top, grant_ref=grant)
    with database.connect() as connection:
        connection.execute('delete from library.library_memberships where account_id=%s and library_id=%s',
                           (editor.account_id, database.library))
        connection.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s', (editor.session_id,))
    top = mixed.execute(mixed.command('add', top, selections=[source]))
    assert mixed.read(top)['items'][0]['catalog_ref'] == str(admission['catalog_ref'])
    assert mixed.rows('album_top_remote_retained_budgets')[0]['admission_count'] == 1
    assert_error(lambda: mixed.execute(command, actor=editor), 'forbidden', 403)


@pytest.mark.parametrize('change', ['revision', 'editor', 'deleted'])
def test_current_destination_fences_pending_after_acquisition(mixed, change):
    database = mixed.db
    editor = member(database)
    top, _ = database.create(refs=[])
    top, _ = write(database, 'grant_editor', top, account_id=editor.account_id, role='editor')
    acquired = mixed.acquire(top, actor=editor)
    command = mixed.command('add', top, selections=[pending(acquired)])
    if change == 'revision':
        write(database, 'save', top, title='Changed')
        expected = ('revision_conflict', 409)
    elif change == 'editor':
        write(database, 'revoke_editor', top, grant_ref=top['grant_ref'])
        expected = ('top_unavailable', 404)
    else:
        write(database, 'delete', top)
        expected = ('top_unavailable', 404)
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(command, actor=editor), *expected)
    assert mixed.snapshot() == before


def test_complete_save_reorders_removes_and_adds_without_erasing_retained_history(mixed):
    top, _ = mixed.create()
    before = mixed.read(top)
    acquired = mixed.acquire(top)
    old_remote = before['edit_draft']['item_selections'][1]
    command = mixed.command('save', top, title='Edited mixed Top', item_selections=[
        {'kind': 'new_remote', 'source': pending(acquired)}, old_remote,
        {'kind': 'new_local', 'album_ref': mixed.db.album_refs[1], 'source': {'kind': 'unselected'}}])
    saved = mixed.execute(command)
    result = mixed.read(saved)
    assert result['title'] == 'Edited mixed Top'
    assert [row['curator_position'] for row in result['items']] == [1, 2, 3]
    assert [row['original_position'] for row in result['items']] == [3, 2, 4]
    assert result['items'][1]['ref'] == old_remote['item_ref']
    assert result['items'][2]['catalog_ref'] == mixed.db.album_refs[1]
    assert mixed.rows('album_top_remote_retained_budgets')[0]['admission_count'] == 2
    emptied = mixed.execute(mixed.command('save', saved, item_selections=[]))
    assert mixed.read(emptied)['items'] == []
    assert len(mixed.rows('album_top_remote_admissions')) == 2


@pytest.mark.parametrize('legacy', [True, False])
def test_remote_provenance_cannot_be_silently_switched_to_unselected(mixed, legacy):
    top, _ = mixed.create(local=False)
    row = mixed.read(top)['items'][0]
    values = {'items': [{'item_ref': row['ref'], 'album_ref': row['catalog_ref']}]} if legacy else {
        'item_selections': [{'kind': 'existing', 'item_ref': row['ref'], 'album_ref': row['catalog_ref'],
                             'source': {'kind': 'unselected'}}]}
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(mixed.command('save', top, **values)), 'remote_source_required', 409)
    assert mixed.snapshot() == before


def test_current_valid_local_switch_is_exclusive_and_preserves_remote_readd(mixed):
    acquired = mixed.acquire()
    with mixed.db.connect() as connection:
        connection.execute("""insert into catalog.release_group_provider_identities(provider,entity_kind,external_id,catalog_ref)
            values('musicbrainz','release-group',%s,%s)""", (mixed.remote.facts.release_group_id, mixed.db.album_refs[0]))
    top, _ = mixed.create(local=False, acquired=acquired)
    draft = mixed.read(top)['edit_draft']['item_selections'][0]
    retained_source = draft['source']
    album, source = mixed.storage.local_source(mixed.db.album_refs[0])
    draft = {**draft, 'source': {'kind': 'local', 'selected_local_album_id': album, 'selected_source_ref': source}}
    top = mixed.execute(mixed.command('save', top, item_selections=[draft]))
    assert not mixed.rows('album_list_item_remote_sources')
    assert mixed.read(top)['edit_draft']['items'][0]['selected_source_ref'] == source
    top = mixed.execute(mixed.command('save', top, item_selections=[{**draft, 'source': retained_source}]))
    assert len(mixed.rows('album_list_item_remote_sources')) == 1
    with mixed.db.connect() as connection:
        assert connection.execute('select count(*) as n from app.album_list_item_publication_sources where top_ref=%s',
                                  (top['top_ref'],)).fetchone()['n'] == 0
    assert mixed.rows('album_top_remote_retained_budgets')[0]['admission_count'] == 1


@pytest.mark.parametrize('changed', ['version', 'foreign_top', 'retired'])
def test_retained_selector_requires_exact_destination_active_facts(mixed, changed):
    top, _ = mixed.create(local=False)
    detail = mixed.read(top)
    source = detail['edit_draft']['item_selections'][0]['source']
    top = mixed.execute(mixed.command('remove', top, item_refs=[detail['items'][0]['ref']]))
    if changed == 'version':
        source = {**source, 'evidence_version': 'b' * 64}
    elif changed == 'foreign_top':
        top, _ = mixed.db.create(refs=[])
    else:
        mixed.retire(source['admission_ref'])
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(mixed.command('add', top, selections=[source])), 'remote_evidence_unavailable', 409)
    assert mixed.snapshot() == before


def test_conflicting_new_facts_never_rewrite_first_retained_admission(mixed):
    top, _ = mixed.create(local=False)
    detail = mixed.read(top)
    first = mixed.rows('album_top_remote_admissions')[0]
    top = mixed.execute(mixed.command('remove', top, item_refs=[detail['items'][0]['ref']]))
    acquired = mixed.acquire(top, facts=evidence(mbid=first['external_id'], title='Different provider summary'))
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(mixed.command('add', top, selections=[pending(acquired)])), 'remote_evidence_conflict', 409)
    assert mixed.snapshot() == before


def test_retained_readd_and_copy_do_not_inherit_expired_acquisition_deadline(mixed):
    top, parent = mixed.historical()
    row = mixed.storage.row(parent)
    with mixed.db.connect() as connection:
        assert connection.execute('select clock_timestamp()>%s as expired', (row['admission_deadline'],)).fetchone()['expired']
    detail = mixed.read(top)
    source = detail['edit_draft']['item_selections'][0]['source']
    top = mixed.execute(mixed.command('remove', top, item_refs=[detail['items'][0]['ref']]))
    top = mixed.execute(mixed.command('add', top, selections=[source]))
    copied = mixed.execute(mixed.command('copy', top))
    children = [value for value in mixed.rows('album_top_remote_admissions') if str(value['top_ref']) == copied['top_ref']]
    assert len(children) == 1
    child = children[0]
    assert child['admission_kind'] == 'copy' and str(child['copied_from_admission_ref']) == parent
    assert child['admitted_at'] > child['admission_deadline']
    assert child['copy_actor_account_id'] == mixed.db.owner.account_id and child['copy_session_id'] == mixed.db.owner.session_id
    for field in ('original_acquisition_ref', 'initiating_actor_account_id', 'original_session_id',
                  'original_destination_kind', 'original_destination_ref', 'original_context_ref',
                  'acquired_at', 'admission_deadline', 'external_id', 'title', 'artist_display', 'evidence_version'):
        assert child[field] == row[field]
    assert mixed.read(copied)['items'][0]['catalog_ref'] == str(row['catalog_ref'])


def test_copy_is_independent_after_source_removal_grant_loss_and_parent_retirement(mixed):
    top, _ = mixed.create()
    viewer = member(mixed.db)
    top, _ = write(mixed.db, 'grant_viewer', top, account_id=viewer.account_id, role='viewer')
    grant = top['grant_ref']
    command = mixed.command('copy', top)
    copied = mixed.execute(command, actor=viewer)
    parent = next(row for row in mixed.rows('album_top_remote_admissions') if str(row['top_ref']) == top['top_ref'])
    child = next(row for row in mixed.rows('album_top_remote_admissions') if str(row['top_ref']) == copied['top_ref'])
    assert child['owner_account_id'] == viewer.account_id
    source_items = mixed.read(top)['items']
    assert [row['catalog_ref'] for row in mixed.read(copied, viewer)['items']] == [row['catalog_ref'] for row in source_items]
    top = mixed.execute(mixed.command('remove', top, item_refs=[row['ref'] for row in source_items]))
    top, _ = write(mixed.db, 'revoke_editor', top, grant_ref=grant)
    top, _ = write(mixed.db, 'delete', top)
    mixed.retire(parent['ref'])
    preparation = mixed.acquisitions[str(parent['original_acquisition_ref'])]['command']['preparation_ref']
    mixed.remote.service.close_preparation(mixed.db.context(), preparation_ref=preparation,
        payload={}, context_ref=CONTEXT)
    mixed.remote.service.maintain_preparations(mixed.db.context(), payload={'mode': 'reclaim'}, context_ref=CONTEXT)
    before = mixed.snapshot()
    mixed.remote.statements.clear()
    assert mixed.execute(command, actor=new_session(mixed.db, viewer)) == copied
    assert not any(sql.startswith(COPY_DISCOVERY) for sql in mixed.remote.statements)
    assert mixed.snapshot() == before
    assert len(mixed.read(copied, viewer)['items']) == 2
    mixed.retire(child['ref'])
    assert_error(lambda: mixed.read(copied, viewer), 'remote_evidence_unavailable', 409)


def test_retired_source_prevents_copy_without_partial_destination(mixed):
    top, _ = mixed.create()
    parent = mixed.rows('album_top_remote_admissions')[0]
    mixed.retire(parent['ref'])
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(mixed.command('copy', top)), 'remote_evidence_unavailable', 409)
    assert mixed.snapshot() == before


@pytest.mark.parametrize('action', [BROWSE, CREATE, ITEMS])
def test_late_policy_denial_after_retention_rolls_back_whole_create(mixed, action):
    acquired = mixed.acquire()
    command = mixed.command('create', title='Rollback', draft_ref=acquired['destination']['draft_ref'], selections=[pending(acquired)])
    blocked = False
    def after(sql, connection):
        nonlocal blocked
        if 'app.retain_top_remote_acquisition' in sql:
            blocked = True
    def constraints(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not (blocked and context.action == action))
    # Create does not require Items. Its absence must remain meaningful.
    mixed.remote.after_statement = after
    before = mixed.snapshot()
    if action == ITEMS:
        result = mixed.execute(command, constraints=constraints)
        assert mixed.read(result)['items']
    else:
        assert_error(lambda: mixed.execute(command, constraints=constraints), 'forbidden', 403)
        assert mixed.snapshot() == before
    assert blocked


def test_final_actual_session_expiry_rolls_back_retention_and_receipt(mixed):
    acquired = mixed.acquire()
    command = mixed.command('create', title='Expiry', draft_ref=acquired['destination']['draft_ref'], selections=[pending(acquired)])
    def after(sql, connection):
        if 'app.attach_top_remote_source' in sql:
            mixed.db.service._clock = lambda: mixed.db.now + timedelta(days=2)
    mixed.remote.after_statement = after
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(command), 'forbidden', 403)
    assert mixed.snapshot() == before


def test_enabled_link_remote_save_refuses_atomically_while_revoke_stays_available(mixed):
    configured(mixed.db)
    top, _ = mixed.db.create(refs=[])
    top, _ = enable(mixed.db, top)
    saved = sharing(mixed.db, top)['publication']
    acquired = mixed.acquire(top)
    top = mixed.execute(mixed.command('add', top, selections=[pending(acquired)]))
    before = mixed.snapshot()
    command = mixed.command('save', top, title='Must not silently save privately',
        item_selections=mixed.read(top)['edit_draft']['item_selections'])
    assert_error(lambda: mixed.execute(command), 'remote_publication_unavailable', 409)
    assert mixed.snapshot() == before and sharing(mixed.db, top)['publication'] == saved
    revoked, _ = write(mixed.db, 'revoke_external', top)
    assert sharing(mixed.db, revoked)['publication']['state'] == 'revoked'
    assert mixed.execute(mixed.command('save', revoked, title='Explicitly private now'))['revision'] != revoked['revision']


def test_all_local_empty_final_save_keeps_enabled_link_republish_semantics(mixed):
    configured(mixed.db)
    top, _ = mixed.db.create(refs=[])
    top, _ = enable(mixed.db, top)
    previous = sharing(mixed.db, top)['publication']
    acquired = mixed.acquire(top)
    top = mixed.execute(mixed.command('add', top, selections=[pending(acquired)]))
    # Explicit complete removal is a fully local final draft. It uses the
    # unchanged v1 review and owner Save contract, rather than silently keeping
    # the earlier publication or fabricating remote metadata.
    preview = mixed.db.service.publication_preview(mixed.db.context(), top_ref=top['top_ref'],
        payload={'revision': top['revision'], 'items': []})
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(mixed.command('save', top, item_selections=[])), 'evidence_unavailable', 409)
    assert mixed.snapshot() == before and sharing(mixed.db, top)['publication'] == previous
    saved = mixed.execute(mixed.command('save', top, item_selections=[], evidence_revision=preview['evidence_revision']))
    latest = sharing(mixed.db, saved)['publication']
    assert latest['share_ref'] == previous['share_ref'] and latest['publication_ref'] != previous['publication_ref']
    assert int(latest['publication_revision']) == int(previous['publication_revision']) + 1
    assert mixed.read(saved)['items'] == []
    assert len(mixed.rows('album_top_remote_admissions')) == 1
    with mixed.db.connect() as connection:
        assert connection.execute('select count(*) as n from app.album_list_publication_items where publication_ref=%s',
                                  (latest['publication_ref'],)).fetchone()['n'] == 0



@pytest.mark.parametrize('action', ['add', 'save', 'copy', 'remove', 'reorder', 'enable_external'])
def test_existing_generic_route_cannot_enter_remote_membership_branch(mixed, action):
    top, _ = mixed.create(local=False)
    item = mixed.read(top)['items'][0]
    extra = {'add': {'album_refs': [mixed.db.album_refs[0]]}, 'save': {'title': 'Blocked route'},
             'copy': {}, 'remove': {'item_refs': [item['ref']]}, 'reorder': {'item_order': [item['ref']]},
             'enable_external': {'items': [], 'evidence_revision': 'e' * 64}}[action]
    app = middleware_app(mixed.db.service, mixed.db.owner)
    before = mixed.snapshot()
    status, body, headers = asyncio.run(asgi_response(app, 'POST', '/album-tops/' + top['top_ref'] + '/' + action,
        headers=mutation_headers(app, mixed.db.owner),
        payload={'request_key': str(uuid4()), 'revision': top['revision'], **extra}))
    assert status == 409 and body['error'] == 'remote_membership_unavailable'
    assert headers[b'cache-control'] == b'private, no-store'
    assert mixed.snapshot() == before


def test_existing_read_route_never_supplies_an_incomplete_legacy_remote_draft(mixed):
    top, _ = mixed.create()
    app = middleware_app(mixed.db.service, mixed.db.owner)
    before = mixed.snapshot()
    status, body, _ = asyncio.run(asgi_response(app, 'GET', '/album-tops/' + top['top_ref'],
        headers=mutation_headers(app, mixed.db.owner)))
    assert status == 409 and body['error'] == 'remote_membership_unavailable'
    assert mixed.snapshot() == before


def prepare_mutation(mixed, action):
    """Prepare real sources before a test changes current authority or policy."""
    if action == 'create':
        acquired = mixed.acquire()
        return mixed.command('create', title='Current authority',
            draft_ref=acquired['destination']['draft_ref'], selections=[pending(acquired)])
    top, _ = mixed.create(local=False)
    if action == 'add':
        return mixed.command('add', top, selections=[pending(mixed.acquire(top))])
    if action == 'save':
        old = mixed.read(top)['edit_draft']['item_selections'][0]
        return mixed.command('save', top, title='Changed privately', item_selections=[old,
            {'kind': 'new_remote', 'source': pending(mixed.acquire(top))}])
    return mixed.command('copy', top)


@pytest.mark.parametrize('action', ['create', 'add', 'save', 'copy'])
@pytest.mark.parametrize('lost', ['session', 'account', 'membership', 'browse', 'all_grants'])
def test_pending_and_retained_facts_never_replace_current_database_authority(mixed, action, lost):
    command = prepare_mutation(mixed, action)
    with mixed.db.connect() as connection:
        if lost == 'session':
            connection.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s',
                               (mixed.db.owner.session_id,))
        elif lost == 'account':
            connection.execute('update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s',
                               (mixed.db.owner.account_id,))
        elif lost == 'membership':
            connection.execute('delete from library.library_memberships where account_id=%s and library_id=%s',
                               (mixed.db.owner.account_id, mixed.db.library))
        elif lost == 'browse':
            connection.execute('update app.capabilities set revoked_at=clock_timestamp() where account_id=%s and capability_key=%s',
                               (mixed.db.owner.account_id, BROWSE))
        else:
            connection.execute('update app.capabilities set revoked_at=clock_timestamp() where account_id=%s',
                               (mixed.db.owner.account_id,))
    # The stale in-memory actor still claims the old relationships/grants.
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(command), 'forbidden', 403)
    assert mixed.snapshot() == before


@pytest.mark.parametrize('action', ['create', 'add', 'save', 'copy'])
def test_final_actual_session_expiry_after_receipt_insert_rolls_back_all_writes(mixed, action):
    command = prepare_mutation(mixed, action)
    observed, consumed = [], []
    def after(sql, connection):
        if sql.startswith('insert into app.album_list_operations '):
            observed.append(sql)
            if action == 'copy':
                mixed.db.service._clock = lambda: mixed.db.now + timedelta(days=2)
        if 'app.consume_top_remote_acquisitions' in sql:
            consumed.append(connection.execute("select count(*) as n from app.album_top_remote_attempts where actor_account_id=%s and state='consumed'",
                (mixed.db.owner.account_id,)).fetchone()['n'])
            mixed.db.service._clock = lambda: mixed.db.now + timedelta(days=2)
    mixed.remote.after_statement = after
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(command), 'forbidden', 403)
    assert len(observed) == 1 and mixed.snapshot() == before
    assert (bool(consumed) and consumed[0] > 0) if action != 'copy' else not consumed


@pytest.mark.parametrize('action,denied', [
    ('create', BROWSE), ('create', CREATE), ('add', BROWSE), ('add', ITEMS),
    ('save', BROWSE), ('save', MANAGE), ('save', ITEMS), ('copy', BROWSE), ('copy', CREATE),
])
def test_policy_change_after_actual_receipt_insert_rolls_back_every_remote_mutation(mixed, action, denied):
    command = prepare_mutation(mixed, action)
    after_receipt = False
    after_consume = False
    def after(sql, connection):
        nonlocal after_receipt, after_consume
        if sql.startswith('insert into app.album_list_operations '):
            after_receipt = True
        if 'app.consume_top_remote_acquisitions' in sql:
            after_consume = True
    def constraints(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not ((after_receipt if action == 'copy' else after_consume) and context.action == denied))
    mixed.remote.after_statement = after
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(command, constraints=constraints), 'forbidden', 403)
    assert after_receipt and mixed.snapshot() == before
    assert after_consume is (action != 'copy')


def test_remote_read_rechecks_browse_after_actual_progress_overlay_read(mixed):
    top, _ = mixed.create()
    after_overlay = False
    def after(sql, connection):
        nonlocal after_overlay
        if 'left join app.album_list_item_progress p' in sql:
            after_overlay = True
    def constraints(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not (after_overlay and context.action == BROWSE))
    mixed.remote.after_statement = after
    before = mixed.snapshot()
    assert_error(lambda: mixed.read(top, constraints=constraints), 'forbidden', 403)
    assert after_overlay and mixed.snapshot() == before


# Moved exact expired Create/Add/Save, post-preload deadline, and landed-replay
# assertions to tests/py/remote_consumption_expiry_acceptance.py. They require
# real SQL elapsed time and remain unexecuted acceptance gaps until selected.


@pytest.mark.parametrize('action', ['create', 'add', 'save', 'copy'])
def test_changed_operation_body_never_reuses_existing_remote_receipt(mixed, action):
    command = prepare_mutation(mixed, action)
    mixed.execute(command)
    changes = {'title': 'Different request body'} if action in {'create', 'save', 'copy'} else {'revision': '999'}
    changed = normalize_top_command(action, {**command.data, **changes, 'request_key': command.request_key},
                                    top_ref=command.top_ref)
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(changed), 'request_key_conflict', 409)
    assert mixed.snapshot() == before


@pytest.mark.parametrize('action', ['save', 'copy'])
def test_remote_receipt_replay_rechecks_policy_after_retained_source_read(mixed, action):
    top, _ = mixed.db.create(refs=[])
    command = mixed.command(action, top, **({'title': 'Originally local'} if action == 'save' else {}))
    destination = mixed.execute(command)
    mixed.execute(mixed.command('add', destination, selections=[pending(mixed.acquire(destination))]))
    after_sources = False
    def after(sql, connection):
        nonlocal after_sources
        if 'from app.album_list_item_remote_sources r' in sql:
            after_sources = True
    # A source read on replay is not a provider/evidence admission, but it can
    # wait and therefore must precede the final resolver decision.
    def constraints(context):
        denied = MANAGE if action == 'save' else CREATE
        return PolicyEvaluationConstraints(request_origin_allowed=not (after_sources and context.action == denied))
    mixed.remote.after_statement = after
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(command, constraints=constraints), 'forbidden', 403)
    assert after_sources and mixed.snapshot() == before


@pytest.mark.parametrize('action', ['add', 'save'])
def test_late_invalid_member_rolls_back_prior_retention_in_complete_request(mixed, action):
    top, _ = mixed.create()
    acquired = mixed.acquire(top)
    invalid = {'kind': 'remote_retained', 'admission_ref': str(uuid4()), 'evidence_version': 'f' * 64}
    data = {'selections': [pending(acquired), invalid]} if action == 'add' else {
        'title': 'Not partially saved', 'item_selections': [
            {'kind': 'new_remote', 'source': pending(acquired)}, {'kind': 'new_remote', 'source': invalid}]}
    before = mixed.snapshot()
    mixed.remote.statements.clear()
    assert_error(lambda: mixed.execute(mixed.command(action, top, **data)), 'remote_evidence_unavailable', 409)
    # Complete canonical prevalidation may reject the absent retained selector
    # before retention. Actual prior-retention rollback is separately preserved
    # by test_late_local_member_failure_rolls_back_actual_prior_retention.
    assert not any('app.consume_top_remote_acquisitions' in sql for sql in mixed.remote.statements)
    assert mixed.snapshot() == before


@pytest.mark.parametrize('mismatch', ['item', 'album', 'local_source', 'inactive_source'])
def test_complete_save_requires_exact_current_item_catalog_and_local_source(mixed, mismatch):
    acquired = mixed.acquire()
    with mixed.db.connect() as connection:
        connection.execute('''insert into catalog.release_group_provider_identities(provider,entity_kind,external_id,catalog_ref)
            values('musicbrainz','release-group',%s,%s)''', (mixed.remote.facts.release_group_id, mixed.db.album_refs[0]))
    top, _ = mixed.create(local=False, acquired=acquired)
    row = mixed.read(top)['edit_draft']['item_selections'][0]
    expected = ('items_changed', 409)
    if mismatch == 'item':
        row = {**row, 'item_ref': str(uuid4())}
    elif mismatch == 'album':
        row = {**row, 'album_ref': mixed.db.album_refs[1]}
    else:
        album, source = mixed.storage.local_source(mixed.db.album_refs[1 if mismatch == 'local_source' else 0])
        row = {**row, 'source': {'kind': 'local', 'selected_local_album_id': album, 'selected_source_ref': source}}
        expected = ('evidence_unavailable', 409)
        if mismatch == 'inactive_source':
            with mixed.db.connect() as connection:
                connection.execute("update library.album_metadata_sources set state='invalid' where ref=%s", (source,))
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(mixed.command('save', top, item_selections=[row])), *expected)
    assert mixed.snapshot() == before


def test_complete_save_duplicate_resolved_catalog_rolls_back_new_retention(mixed):
    top, _ = mixed.create()
    acquired = mixed.acquire(top)
    with mixed.db.connect() as connection:
        connection.execute('''insert into catalog.release_group_provider_identities(provider,entity_kind,external_id,catalog_ref)
            values('musicbrainz','release-group',%s,%s)''', (mixed.remote.facts.release_group_id, mixed.db.album_refs[1]))
    before = mixed.snapshot()
    command = mixed.command('save', top, item_selections=[
        {'kind': 'new_local', 'album_ref': mixed.db.album_refs[1], 'source': {'kind': 'unselected'}},
        {'kind': 'new_remote', 'source': pending(acquired)}])
    assert_error(lambda: mixed.execute(command), 'duplicate_album', 409)
    assert mixed.snapshot() == before


@pytest.mark.parametrize('denied', [BROWSE, MANAGE, ITEMS])
def test_editor_complete_mixed_save_obeys_current_actions_and_preserves_publication(mixed, denied):
    configured(mixed.db)
    editor = member(mixed.db)
    top, _ = mixed.db.create(refs=[])
    top, _ = write(mixed.db, 'grant_editor', top, account_id=editor.account_id, role='editor')
    top, _ = enable(mixed.db, top)
    saved = sharing(mixed.db, top)['publication']
    top = mixed.execute(mixed.command('add', top, selections=[pending(mixed.acquire(top, actor=editor))]), actor=editor)
    acquired = mixed.acquire(top, actor=editor)
    draft = mixed.read(top, editor)['edit_draft']['item_selections']
    command = mixed.command('save', top, title='Editor private working change', item_selections=[
        {'kind': 'new_remote', 'source': pending(acquired)}, *draft])
    constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=context.action != denied)
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(command, actor=editor, constraints=constraints), 'forbidden', 403)
    assert mixed.snapshot() == before
    # Explicitly deny Access while allowing the editor's permitted private Save.
    constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=context.action != ACCESS)
    result = mixed.execute(command, actor=editor, constraints=constraints)
    assert len(mixed.read(result, editor)['items']) == 2
    assert sharing(mixed.db, result)['publication'] == saved
    assert 'publication' not in sharing(mixed.db, result, editor)
    assert mixed.snapshot()['publication_seals'] == before['publication_seals']


@pytest.mark.parametrize('change', ['removed_bridge', 'retired_after_bindings'])
def test_copy_revalidates_exact_current_source_bridge_and_retirement_before_retaining(mixed, change):
    top, _ = mixed.create(local=False)
    source = mixed.rows('album_top_remote_admissions')[0]
    item = mixed.read(top)['items'][0]
    observed = False
    def after(sql, connection):
        nonlocal observed
        if not observed and 'from app.album_list_items i left join app.album_list_item_publication_sources s' in sql:
            observed = True
            if change == 'removed_bridge':
                # The actual runtime role can remove membership. The cascade
                # removes its bridge, proving the copy definer rechecks both.
                connection.execute('delete from app.album_list_items where top_ref=%s and ref=%s',
                                   (top['top_ref'], item['ref']))
            else:
                # No retained SHARE fence exists yet. The trusted synthetic
                # retirement is committed independently before the copy SQL.
                mixed.retire(source['ref'])
    before = mixed.snapshot()
    mixed.remote.after_statement = after
    if change == 'removed_bridge':
        # The SELECT already produced the source row before its same-transaction
        # removal. The real definer must reject that now-missing exact bridge.
        assert_error(lambda: mixed.execute(mixed.command('copy', top)), 'remote_evidence_unavailable', 409)
        assert mixed.snapshot() == before
    else:
        assert_error(lambda: mixed.execute(mixed.command('copy', top)), 'remote_evidence_unavailable', 409)
        actual = mixed.snapshot()
        assert len(actual['album_top_remote_admissions']) == 1
        retired_at = actual['album_top_remote_admissions'][0]['retired_at']
        assert retired_at is not None
        before['album_top_remote_admissions'][0]['retired_at'] = retired_at
        assert actual == before
    assert observed


def test_retired_later_member_rolls_back_copy_of_earlier_active_member(mixed):
    top, _ = mixed.create(local=False)
    top = mixed.execute(mixed.command('add', top, selections=[pending(mixed.acquire(top))]))
    items = mixed.read(top)['items']
    sources = {str(row['catalog_ref']): row for row in mixed.rows('album_top_remote_admissions')}
    mixed.retire(sources[items[1]['catalog_ref']]['ref'])
    before = mixed.snapshot()
    mixed.remote.statements.clear()
    assert_error(lambda: mixed.execute(mixed.command('copy', top)), 'remote_evidence_unavailable', 409)
    assert sum('app.copy_top_remote_admission' in sql for sql in mixed.remote.statements) == 1
    assert mixed.snapshot() == before


def test_copy_replay_never_restores_removed_destination_members_or_retired_admissions(mixed):
    top, _ = mixed.create()
    command = mixed.command('copy', top)
    copied = mixed.execute(command)
    sources = [row for row in mixed.rows('album_top_remote_admissions') if str(row['top_ref']) == copied['top_ref']]
    removed = mixed.execute(mixed.command('remove', copied, item_refs=[row['ref'] for row in mixed.read(copied)['items']]))
    mixed.retire(sources[0]['ref'])
    before = mixed.snapshot()
    assert mixed.execute(command, actor=new_session(mixed.db, mixed.db.owner)) == copied
    assert mixed.snapshot() == before and mixed.read(removed)['items'] == []
    selector = {'kind': 'remote_retained', 'admission_ref': str(sources[0]['ref']),
                'evidence_version': sources[0]['evidence_version']}
    assert_error(lambda: mixed.execute(mixed.command('add', removed, selections=[selector])), 'remote_evidence_unavailable', 409)
    assert mixed.snapshot() == before


def test_expired_historical_admission_readds_after_initiating_editor_departure(mixed):
    editor = member(mixed.db)
    top, admission = mixed.historical(actor=editor)
    grant = top['grant_ref']
    detail = mixed.read(top)
    source = detail['edit_draft']['item_selections'][0]['source']
    original = mixed.storage.row(admission)
    top = mixed.execute(mixed.command('remove', top, item_refs=[detail['items'][0]['ref']]))
    top, _ = write(mixed.db, 'revoke_editor', top, grant_ref=grant)
    with mixed.db.connect() as connection:
        assert connection.execute('select clock_timestamp()>%s as expired',
            (original['admission_deadline'],)).fetchone()['expired']
        connection.execute('delete from library.library_memberships where account_id=%s and library_id=%s',
                           (editor.account_id, mixed.db.library))
        connection.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s', (editor.session_id,))
    readded = mixed.execute(mixed.command('add', top, selections=[source]))
    assert mixed.read(readded)['items'][0]['catalog_ref'] == str(original['catalog_ref'])
    assert mixed.storage.row(admission) == original
    assert mixed.rows('album_top_remote_retained_budgets')[0]['admission_count'] == 1
    copied = mixed.execute(mixed.command('copy', readded))
    child = next(row for row in mixed.rows('album_top_remote_admissions') if str(row['top_ref']) == copied['top_ref'])
    assert child['initiating_actor_account_id'] == editor.account_id and child['original_session_id'] == editor.session_id
    assert child['copy_actor_account_id'] == mixed.db.owner.account_id
    assert child['admitted_at'] > child['admission_deadline'] and mixed.read(copied)['items']


@pytest.mark.parametrize('explicit_draft', [False, True])
def test_unchanged_remote_source_metadata_save_does_not_invent_items_or_access_requirement(mixed, explicit_draft):
    top, _ = mixed.create()
    data = {'title': 'Metadata only'}
    if explicit_draft:
        data['item_selections'] = mixed.read(top)['edit_draft']['item_selections']
    before = mixed.snapshot()
    constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=context.action not in {ITEMS, ACCESS})
    saved = mixed.execute(mixed.command('save', top, **data), constraints=constraints)
    after = mixed.snapshot()
    assert mixed.read(saved)['title'] == 'Metadata only'
    for name in ('items', 'album_top_remote_admissions', 'album_top_remote_retained_budgets',
                 'album_list_item_remote_sources', 'album_list_item_publication_sources',
                 'shared_links', 'album_list_publications', 'publication_seals'):
        assert after[name] == before[name]
    operation = next(row for row in after['operations'] if str(row['request_key']) == saved['request_key'])
    assert set(operation['required_actions']) == {BROWSE, MANAGE}


def test_real_retained_budget_failure_rolls_back_candidate_catalog_and_operation(mixed):
    top, _ = mixed.db.create(refs=[])
    mixed.storage.seed(top, 20000, retired=True)
    assert mixed.storage.counts(top)['admission_count'] == 20000
    acquired = mixed.acquire(top)
    before = mixed.snapshot()
    command = mixed.command('add', top, selections=[pending(acquired)])
    assert_error(lambda: mixed.execute(command), 'remote_retention_limit', 429)
    assert mixed.snapshot() == before


def test_exact_fact_reacquisition_reuses_first_admission_without_budget_growth(mixed):
    top, _ = mixed.create(local=False)
    detail = mixed.read(top)
    original = mixed.rows('album_top_remote_admissions')[0]
    top = mixed.execute(mixed.command('remove', top, item_refs=[detail['items'][0]['ref']]))
    facts = evidence(mbid=original['external_id'], title=original['title'], artist=original['artist_display'])
    acquired = mixed.acquire(top, facts=facts)
    top = mixed.execute(mixed.command('add', top, selections=[pending(acquired)]))
    assert mixed.read(top)['edit_draft']['item_selections'][0]['source']['admission_ref'] == str(original['ref'])
    assert mixed.rows('album_top_remote_admissions') == [original]
    assert mixed.rows('album_top_remote_retained_budgets')[0]['admission_count'] == 1


def local_track_source(mixed, catalog):
    """Actual fixture-owned tag/source/file evidence accepted by unchanged v1."""
    album, source = mixed.storage.local_source(catalog)
    with mixed.db.connect() as connection:
        row = connection.execute('''select s.library_root_id,s.container_identity,a.artist_id
            from library.album_metadata_sources s join library.local_albums a
              on a.id=s.local_album_id and a.library_id=s.library_id where s.ref=%s''', (source,)).fetchone()
        track = connection.execute('''insert into library.local_tracks(library_id,artist_id,album_id,track_key,
            title,disc_number,track_number,duration_seconds,title_origin,artist_origin)
            values(%s,%s,%s,%s,'Independent local track',1,1,180,'tag_metadata','tag_metadata') returning id''',
            (mixed.db.library, row['artist_id'], album, uuid4().hex)).fetchone()['id']
        connection.execute('''insert into library.local_track_files(track_id,library_root_id,private_path,
            content_signature,metadata_source_ref,metadata) values(%s,%s,%s,'synthetic',%s,'{}')''',
            (track, row['library_root_id'], row['container_identity'] + '/1.flac', source))
    return album, source


@pytest.mark.parametrize('action', ['save', 'enable_external'])
def test_final_nonempty_local_switch_uses_exact_v1_preview_and_publication(mixed, action):
    configured(mixed.db)
    top, _ = mixed.db.create(refs=[])
    if action == 'save':
        top, _ = enable(mixed.db, top)
    previous = sharing(mixed.db, top)['publication']
    acquired = mixed.acquire(top)
    with mixed.db.connect() as connection:
        connection.execute('''insert into catalog.release_group_provider_identities(provider,entity_kind,external_id,catalog_ref)
            values('musicbrainz','release-group',%s,%s)''', (mixed.remote.facts.release_group_id, mixed.db.album_refs[0]))
    top = mixed.execute(mixed.command('add', top, selections=[pending(acquired)]))
    remote_row = mixed.read(top)['edit_draft']['item_selections'][0]
    album, source = local_track_source(mixed, mixed.db.album_refs[0])
    item = {'item_ref': remote_row['item_ref'], 'album_ref': remote_row['album_ref'],
            'selected_local_album_id': album, 'selected_source_ref': source}
    before = mixed.snapshot()
    preview = mixed.db.service.publication_preview(mixed.db.context(), top_ref=top['top_ref'],
        payload={'revision': top['revision'], 'items': [item]})
    assert preview['items'][0]['track_count'] == 1 and mixed.snapshot() == before
    # enable_external preserves its legacy wire. Save also exercises the new
    # complete typed wire before delegating final-local data to the v1 owner.
    values = {'items': [item]} if action == 'enable_external' else {'item_selections': [
        {**remote_row, 'source': {'kind': 'local', 'selected_local_album_id': album, 'selected_source_ref': source}}]}
    assert_error(lambda: mixed.execute(mixed.command(action, top, evidence_revision='0' * 64, **values)), 'evidence_stale', 409)
    assert mixed.snapshot() == before
    saved = mixed.execute(mixed.command(action, top, evidence_revision=preview['evidence_revision'], **values))
    latest = sharing(mixed.db, saved)['publication']
    assert latest['state'] == 'enabled' and latest['publication_ref'] != previous['publication_ref']
    if action == 'save':
        assert latest['share_ref'] == previous['share_ref']
        assert int(latest['publication_revision']) == int(previous['publication_revision']) + 1
    assert mixed.rows('album_list_item_remote_sources') == []
    assert len(mixed.rows('album_top_remote_admissions')) == 1
    assert mixed.read(saved)['edit_draft']['items'] == [item]
    with mixed.db.connect() as connection:
        row = connection.execute('''select p.contract_version,s.seal_contract_version,
            i.item_ref,e.selected_local_album_id,e.selected_source_ref
            from app.album_list_publications p join app.album_list_publication_seals s on s.publication_ref=p.ref
            join app.album_list_publication_items i on i.publication_ref=p.ref
            join library.album_presentation_evidence e on e.presentation_ref=i.presentation_ref
            where p.ref=%s''', (latest['publication_ref'],)).fetchone()
        assert row['contract_version'] == row['seal_contract_version'] == 1
        assert str(row['item_ref']) == item['item_ref']
        assert row['selected_local_album_id'] == album and str(row['selected_source_ref']) == source


@pytest.mark.parametrize('variant', ['create_pending', 'create_mixed', 'add_pending', 'add_retained',
    'save_empty', 'save_existing_remote', 'save_new_remote', 'save_new_local', 'save_existing_unselected', 'save_existing_local'])
def test_generic_route_refuses_every_new_typed_wire_even_with_valid_private_header(mixed, variant):
    top, _ = mixed.create()
    detail = mixed.read(top)
    retained_source = detail['edit_draft']['item_selections'][1]['source']
    action = variant.split('_', 1)[0]
    if action == 'create':
        acquired = mixed.acquire()
        values = {'title': 'Unavailable typed Create', 'draft_ref': acquired['destination']['draft_ref'],
                  'selections': [pending(acquired)]}
        if variant == 'create_mixed':
            values['selections'].insert(0, {'kind': 'local_catalog', 'album_ref': mixed.db.album_refs[0]})
        path = '/album-tops'
    elif action == 'add':
        # Remove the remote member so retained readd would otherwise be valid.
        top = mixed.execute(mixed.command('remove', top, item_refs=[detail['items'][1]['ref']]))
        values = {'selections': [retained_source if variant == 'add_retained' else pending(mixed.acquire(top))]}
        path = '/album-tops/' + top['top_ref'] + '/add'
    else:
        rows = []
        if variant == 'save_existing_remote':
            rows = detail['edit_draft']['item_selections']
        elif variant == 'save_new_remote':
            rows = [{'kind': 'new_remote', 'source': pending(mixed.acquire(top))}]
        elif variant == 'save_new_local':
            rows = [{'kind': 'new_local', 'album_ref': mixed.db.album_refs[2], 'source': {'kind': 'unselected'}}]
        elif variant == 'save_existing_unselected':
            rows = [detail['edit_draft']['item_selections'][0]]
        elif variant == 'save_existing_local':
            album, source = mixed.storage.local_source(mixed.db.album_refs[0])
            rows = [{**detail['edit_draft']['item_selections'][0], 'source': {'kind': 'local',
                'selected_local_album_id': album, 'selected_source_ref': source}}]
        values = {'item_selections': rows}
        path = '/album-tops/' + top['top_ref'] + '/save'
    app = middleware_app(mixed.db.service, mixed.db.owner)
    body = {'request_key': str(uuid4()), **values, **({'revision': top['revision']} if action != 'create' else {})}
    before = mixed.snapshot()
    calls = len(mixed.remote.calls)
    status, body, headers = asyncio.run(asgi_response(app, 'POST', path,
        headers=mutation_headers(app, mixed.db.owner), payload=body))
    assert (status, body) == (409, {'ok': False, 'error': 'remote_membership_unavailable'})
    assert headers[b'cache-control'] == b'private, no-store'
    assert mixed.snapshot() == before and len(mixed.remote.calls) == calls


@pytest.mark.parametrize('action', ['create', 'add', 'save', 'copy', 'enable_external'])
def test_browser_payload_cannot_supply_server_only_remote_context(mixed, action):
    top, _ = mixed.create()
    if action == 'create':
        acquired = mixed.acquire()
        values = {'title': 'Injected context', 'draft_ref': acquired['destination']['draft_ref'], 'selections': [pending(acquired)]}
        path = '/album-tops'
    else:
        values = {'revision': top['revision']}
        if action == 'add':
            values['selections'] = [pending(mixed.acquire(top))]
        elif action == 'save':
            values['item_selections'] = []
        elif action == 'enable_external':
            values.update(items=[], evidence_revision='e' * 64)
        path = '/album-tops/' + top['top_ref'] + '/' + action
    before = mixed.snapshot()
    app = middleware_app(mixed.db.service, mixed.db.owner)
    status, body, headers = asyncio.run(asgi_response(app, 'POST', path,
        headers=mutation_headers(app, mixed.db.owner),
        payload={'request_key': str(uuid4()), 'context_ref': CONTEXT, **values}))
    assert (status, body) == (422, {'ok': False, 'error': 'invalid_command'})
    assert headers[b'cache-control'] == b'private, no-store' and mixed.snapshot() == before


def test_generic_route_refuses_remote_copy_replay_after_destination_becomes_empty(mixed):
    top, _ = mixed.create(local=False)
    command = mixed.command('copy', top)
    copied = mixed.execute(command)
    mixed.execute(mixed.command('remove', copied, item_refs=[mixed.read(copied)['items'][0]['ref']]))
    app = middleware_app(mixed.db.service, mixed.db.owner)
    before = mixed.snapshot()
    status, body, _ = asyncio.run(asgi_response(app, 'POST', '/album-tops/' + top['top_ref'] + '/copy',
        headers=mutation_headers(app, mixed.db.owner), payload={**command.data, 'request_key': command.request_key}))
    assert (status, body) == (409, {'ok': False, 'error': 'remote_membership_unavailable'})
    assert mixed.snapshot() == before


def test_legacy_local_generic_route_still_commits_and_replays_exact_receipt(mixed):
    app = middleware_app(mixed.db.service, mixed.db.owner)
    request = {'request_key': str(uuid4()), 'title': 'Legacy local route', 'album_refs': mixed.db.album_refs[:1]}
    status, response, headers = asyncio.run(asgi_response(app, 'POST', '/album-tops',
        headers=mutation_headers(app, mixed.db.owner), payload=request))
    assert status == 200 and headers[b'cache-control'] == b'private, no-store'
    receipt = response['data']
    assert set(receipt) == {'top_ref', 'revision', 'action', 'request_key'}
    before = mixed.snapshot()
    status, repeated, _ = asyncio.run(asgi_response(app, 'POST', '/album-tops',
        headers=mutation_headers(app, mixed.db.owner), payload=request))
    assert status == 200 and repeated['data'] == receipt and mixed.snapshot() == before
    status, read, _ = asyncio.run(asgi_response(app, 'GET', '/album-tops/' + receipt['top_ref'],
        headers=mutation_headers(app, mixed.db.owner)))
    assert status == 200 and read['data']['edit_draft']['items'][0]['album_ref'] == mixed.db.album_refs[0]


def test_actual_copy_retirement_fence_lasts_through_receipt_and_outer_commit(mixed):
    top, _ = mixed.create(local=False)
    parent = mixed.rows('album_top_remote_admissions')[0]
    observations = []
    def after(sql, connection):
        if 'app.copy_top_remote_admission' in sql or sql.startswith('insert into app.album_list_operations '):
            with mixed.db.connect() as retiring:
                retiring.execute("set local lock_timeout='100ms'")
                sql_error(retiring, '55P03', lambda: retiring.execute(
                    'update app.album_top_remote_admissions set retired_at=clock_timestamp() where ref=%s',
                    (parent['ref'],)))
            observations.append(sql)
    mixed.remote.after_statement = after
    copied = mixed.execute(mixed.command('copy', top))
    mixed.remote.after_statement = None
    assert len(observations) == 2
    mixed.retire(parent['ref'])
    assert len(mixed.read(copied)['items']) == 1
    child = next(row for row in mixed.rows('album_top_remote_admissions') if str(row['top_ref']) == copied['top_ref'])
    assert child['retired_at'] is None and child['copied_from_admission_ref'] == parent['ref']


def test_remote_publication_remains_unavailable_with_valid_service_context(mixed):
    configured(mixed.db)
    top, _ = mixed.create(local=False)
    before = mixed.snapshot()
    command = mixed.command('enable_external', top, evidence_revision='e' * 64)
    assert_error(lambda: mixed.execute(command), 'remote_publication_unavailable', 409)
    assert mixed.snapshot() == before


def test_explicit_empty_final_enable_uses_unchanged_v1_contract(mixed):
    configured(mixed.db)
    top, _ = mixed.create(local=False)
    before = mixed.snapshot()
    preview = mixed.db.service.publication_preview(mixed.db.context(), top_ref=top['top_ref'],
        payload={'revision': top['revision'], 'items': []})
    assert mixed.snapshot() == before
    command = mixed.command('enable_external', top, items=[], evidence_revision=preview['evidence_revision'])
    published = mixed.execute(command)
    state = sharing(mixed.db, published)['publication']
    assert state['state'] == 'enabled' and state['publication_revision'] == '1'
    assert mixed.read(published)['items'] == []
    assert len(mixed.rows('album_top_remote_admissions')) == 1
    assert mixed.rows('album_list_publication_items') == []
    before = mixed.snapshot()
    assert mixed.execute(command) == published and mixed.snapshot() == before


@pytest.mark.parametrize('mismatch', ['fresh_revision', 'foreign_top', 'foreign_library'])
def test_pending_selector_cannot_move_to_a_new_current_destination(mixed, mismatch):
    actor = None
    if mismatch == 'foreign_library':
        acquired = mixed.acquire()
        with mixed.db.connect() as connection:
            library = mixed.db.library_for(connection, mixed.db.owner)
            actor = mixed.db.member(connection, mixed.db.owner, library)
        command = mixed.command('create', title='Different current library',
            draft_ref=acquired['destination']['draft_ref'], selections=[pending(acquired)])
    else:
        top, _ = mixed.db.create(refs=[])
        acquired = mixed.acquire(top)
        if mismatch == 'fresh_revision':
            top, _ = write(mixed.db, 'save', top, title='New working revision')
        else:
            top, _ = mixed.db.create(refs=[])
        command = mixed.command('add', top, selections=[pending(acquired)])
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(command, actor=actor), 'remote_evidence_unavailable', 409)
    assert mixed.snapshot() == before


@pytest.mark.parametrize('change', ['revision', 'grant', 'visibility', 'deleted'])
def test_new_copy_requires_current_source_revision_and_working_visibility(mixed, change):
    top, _ = mixed.create(local=False)
    viewer = member(mixed.db)
    if change == 'visibility':
        top, _ = write(mixed.db, 'visibility', top, visibility='server_shared')
    else:
        top, _ = write(mixed.db, 'grant_viewer', top, account_id=viewer.account_id, role='viewer')
    command = mixed.command('copy', top)
    if change == 'revision':
        mixed.execute(mixed.command('save', top, title='New source revision'))
        expected = ('revision_conflict', 409)
    elif change == 'grant':
        write(mixed.db, 'revoke_editor', top, grant_ref=top['grant_ref'])
        expected = ('top_unavailable', 404)
    elif change == 'visibility':
        write(mixed.db, 'visibility', top, visibility='private')
        expected = ('top_unavailable', 404)
    else:
        write(mixed.db, 'delete', top)
        expected = ('top_unavailable', 404)
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(command, actor=viewer), *expected)
    assert mixed.snapshot() == before


def test_mixed_copy_preserves_full_order_original_positions_and_next_position(mixed):
    top, _ = mixed.create()
    top = mixed.execute(mixed.command('add', top, selections=[pending(mixed.acquire(top)),
        {'kind': 'local_catalog', 'album_ref': mixed.db.album_refs[1]}]))
    items = mixed.read(top)['items']
    top = mixed.execute(mixed.command('remove', top, item_refs=[items[0]['ref']]))
    top = mixed.execute(mixed.command('reorder', top, item_order=[items[3]['ref'], items[2]['ref'], items[1]['ref']]))
    source = mixed.read(top)['items']
    copied = mixed.execute(mixed.command('copy', top))
    destination = mixed.read(copied)['items']
    for key in ('catalog_ref', 'original_position', 'curator_position'):
        assert [row[key] for row in destination] == [row[key] for row in source]
    assert not set(row['ref'] for row in source) & set(row['ref'] for row in destination)
    assert [row['original_position'] for row in destination] == [4, 3, 2]
    with mixed.db.connect() as connection:
        rows = connection.execute('select next_original_position from app.album_lists where ref=any(%s::uuid[])',
                                  ([top['top_ref'], copied['top_ref']],)).fetchall()
    assert len(rows) == 2 and all(row['next_original_position'] == 5 for row in rows)
    assert len([row for row in mixed.rows('album_top_remote_admissions') if str(row['top_ref']) == copied['top_ref']]) == 2


def test_retained_summary_never_inherits_catalog_display_changes(mixed):
    top, _ = mixed.create(local=False)
    source = mixed.rows('album_top_remote_admissions')[0]
    with mixed.db.connect() as connection:
        connection.execute('''update catalog.release_groups set title='Unrelated catalog label',
            artist_display='Unrelated catalog artist',release_year=2026 where ref=%s''', (source['catalog_ref'],))
    item = mixed.read(top)['items'][0]
    assert item['title'] == source['title'] and item['artist_display'] == source['artist_display']
    assert item['first_release_date'] == source['first_release_date'] and item['release_year'] == 2000
    assert item['track_count'] is None and item['track_metadata_status'] == 'unavailable'


def test_reciprocal_copy_locks_complete_sorted_actor_set_before_source_top(mixed):
    first_actor, second_actor = mixed.db.owner, member(mixed.db)
    first, _ = mixed.create(local=False)
    acquired = mixed.acquire(actor=second_actor)
    second = mixed.execute(mixed.command('create', title='Second owner remote Top',
        draft_ref=acquired['destination']['draft_ref'], selections=[pending(acquired)]), actor=second_actor)
    first, _ = write(mixed.db, 'grant_viewer', first, account_id=second_actor.account_id, role='viewer')
    second, _ = write(mixed.db, 'grant_viewer', second, actor=second_actor,
                      account_id=first_actor.account_id, role='viewer')
    gate = Barrier(2)

    def after(sql, connection):
        if sql.startswith(COPY_DISCOVERY):
            # Synchronize before account locks, never after a lock whose correct
            # acquisition deliberately serializes these reciprocal operations.
            gate.wait(timeout=10)

    def copy(actor, source):
        return get_ident(), mixed.execute(mixed.command('copy', source), actor=actor)

    mixed.remote.after_statement = after
    try:
        with record_owner_sql(mixed.db) as statements, ThreadPoolExecutor(max_workers=2) as executor:
            first_future = executor.submit(copy, first_actor, second)
            second_future = executor.submit(copy, second_actor, first)
            results = [first_future.result(timeout=30), second_future.result(timeout=30)]
    finally:
        mixed.remote.after_statement = None
    assert len({worker for worker, _ in results}) == 2
    assert len({receipt['top_ref'] for _, receipt in results}) == 2
    expected_accounts = sorted([first_actor.account_id, second_actor.account_id])
    for (worker, receipt), actor, source in zip(results, (first_actor, second_actor), (second, first)):
        trace = [(sql, params) for identity, sql, params in statements if identity == worker]
        discovery = [(index, params) for index, (sql, params) in enumerate(trace) if sql.startswith(COPY_DISCOVERY)]
        account_locks = [(index, params) for index, (sql, params) in enumerate(trace)
                         if sql == 'select id from app.accounts where id=any(%s) order by id for update']
        top_locks = [(index, params) for index, (sql, params) in enumerate(trace)
                     if sql.startswith('select * from app.album_lists where ref=%s and library_id=%s for update')]
        assert len(discovery) == len(account_locks) == 1 and len(top_locks) == 2
        assert discovery[0][1] == (source['top_ref'], mixed.db.library, 5001)
        assert account_locks[0][1] == (expected_accounts,)
        assert top_locks[0][1] == (source['top_ref'], mixed.db.library)
        assert top_locks[1][1] == (receipt['top_ref'], mixed.db.library)
        assert discovery[0][0] < account_locks[0][0] < top_locks[0][0]
        child = next(row for row in mixed.rows('album_top_remote_admissions') if str(row['top_ref']) == receipt['top_ref'])
        assert child['owner_account_id'] == child['copy_actor_account_id'] == actor.account_id
        assert child['initiating_actor_account_id'] == next(value for value in expected_accounts if value != actor.account_id)
        assert [item['catalog_ref'] for item in mixed.read(receipt, actor)['items']] == [
            item['catalog_ref'] for item in mixed.read(source, actor)['items']]


def test_copy_rejects_new_undiscovered_initiating_actor_before_destination_write(mixed):
    editor = member(mixed.db)
    top, _ = mixed.create(local=False)
    top, _ = write(mixed.db, 'grant_editor', top, account_id=editor.account_id, role='editor')
    top = mixed.execute(mixed.command('add', top, selections=[pending(mixed.acquire(top, actor=editor))]), actor=editor)
    admission = next(row for row in mixed.rows('album_top_remote_admissions')
                     if row['initiating_actor_account_id'] == editor.account_id)
    item = next(row for row in mixed.read(top)['items'] if row['catalog_ref'] == str(admission['catalog_ref']))
    top = mixed.execute(mixed.command('remove', top, item_refs=[item['ref']]))
    observed = False
    changed = None

    def after(sql, connection):
        nonlocal observed, changed
        if not observed and sql.startswith(COPY_DISCOVERY):
            observed = True
            # A real retained admission already exists. Attach its working
            # bridge after discovery using the actual runtime transition,
            # preserving this synthetic Top's revision and valid positions.
            # No old revision is restored and no query result is substituted.
            with runtime(mixed.db) as writer:
                assert_runtime_role(writer, mixed.db)
                owner = mixed.storage.locks(writer, top)
                position = writer.execute('select next_original_position from app.album_lists where ref=%s',
                                          (top['top_ref'],)).fetchone()['next_original_position']
                attached = str(uuid4())
                writer.execute('''insert into app.album_list_items
                    (ref,top_ref,library_id,catalog_ref,original_position,curator_position)
                    values(%s,%s,%s,%s,%s,2)''',
                    (attached, top['top_ref'], mixed.db.library, admission['catalog_ref'], position))
                invoke(writer, ATTACH, [top['top_ref'], mixed.db.library, owner, int(top['revision']),
                    attached, admission['catalog_ref'], admission['ref'], admission['evidence_version']])
                writer.execute('update app.album_lists set next_original_position=%s where ref=%s',
                               (position + 1, top['top_ref']))
            changed = mixed.snapshot()

    mixed.remote.statements.clear()
    mixed.remote.after_statement = after
    assert_error(lambda: mixed.execute(mixed.command('copy', top)), 'concurrent_change', 409)
    assert observed and changed is not None and mixed.snapshot() == changed
    assert not any(sql.startswith('insert into app.album_lists') for sql in mixed.remote.statements)
    assert len(mixed.read(top)['items']) == 2


def test_copy_preseen_receipt_disappearance_cannot_fall_through_to_new_copy(mixed):
    source, _ = mixed.create(local=False)
    command = mixed.command('copy', source)
    copied = mixed.execute(command)
    observed = False
    changed = None

    def after(sql, connection):
        nonlocal observed, changed
        if not observed and sql.startswith('select request_key from app.album_list_operations'):
            observed = True
            # Trusted fixture removes only the receipt already returned by the
            # real lookup, before the owner acquires its account lock.
            with mixed.db.connect() as writer:
                assert writer.execute('''delete from app.album_list_operations
                    where actor_account_id=%s and library_id=%s and request_key=%s returning request_key''',
                    (mixed.db.owner.account_id, mixed.db.library, command.request_key)).fetchone()
            changed = mixed.snapshot()

    mixed.remote.statements.clear()
    mixed.remote.after_statement = after
    assert_error(lambda: mixed.execute(command), 'concurrent_change', 409)
    assert observed and changed is not None and mixed.snapshot() == changed
    assert not any(sql.startswith(COPY_DISCOVERY) for sql in mixed.remote.statements)
    assert not any(sql.startswith('select * from app.album_lists where ref=%s') for sql in mixed.remote.statements)
    assert not any(sql.startswith('insert into app.album_lists') for sql in mixed.remote.statements)
    assert mixed.read(copied)['items']


@pytest.mark.parametrize('reader', ['owner', 'named_editor'])
@pytest.mark.parametrize('boundary', ['working_items', 'publication_link', 'progress_overlay'])
def test_remote_read_rechecks_manage_after_actual_blocking_reads(mixed, reader, boundary):
    """Keep readable facts but discard a typed draft after only Manage is lost."""
    top, _ = mixed.create()
    draft = mixed.read(top)['edit_draft']['item_selections']
    album, source = mixed.storage.local_source(mixed.db.album_refs[0])
    selected = {'kind': 'local', 'selected_local_album_id': album, 'selected_source_ref': source}
    top = mixed.execute(mixed.command('save', top, item_selections=[
        {**draft[0], 'source': selected}, draft[1]]))
    actor = mixed.db.owner
    if reader == 'named_editor':
        actor = member(mixed.db)
        top, _ = write(mixed.db, 'grant_editor', top, account_id=actor.account_id, role='editor')
    initial = mixed.read(top, actor)
    assert initial['allowed_actions'][MANAGE] is True
    assert initial['allowed_actions']['can_edit'] is True
    initial_draft = initial['edit_draft']['item_selections']
    assert initial_draft[0]['source'] == selected
    retained_source = initial_draft[1]['source']
    assert retained_source['kind'] == 'remote_retained'
    assert retained_source['admission_ref'] and retained_source['evidence_version']
    assert initial['items'][1]['source_kind'] == 'remote_summary'

    # These are distinct statements in the actual publication/progress owners.
    # The fixture observer fires only after the real SQL execute has returned;
    # neither the query result nor any production owner is replaced.
    markers = {
        'working_items': 's.selected_local_album_id,s.selected_source_ref from app.album_list_items i',
        'publication_link': 'link_revision from app.shared_links where top_ref=%s and library_id=%s for share',
        'progress_overlay': 'left join app.album_list_item_progress p',
    }
    phase = 'before_target'
    decisions, observed = [], []

    def after(sql, connection):
        nonlocal phase
        for name, marker in markers.items():
            if marker in sql:
                observed.append(name)
                if name == boundary:
                    assert phase == 'before_target'
                    assert ('before_target', MANAGE, True) in decisions
                    phase = 'after_target'

    def constraints(context):
        allowed = not (phase == 'after_target' and context.action == MANAGE)
        decisions.append((phase, context.action, allowed))
        return PolicyEvaluationConstraints(request_origin_allowed=allowed)

    before = mixed.snapshot()
    mixed.remote.after_statement = after
    try:
        with record_owner_sql(mixed.db) as statements:
            result = mixed.read(top, actor, constraints=constraints)
    finally:
        mixed.remote.after_statement = None

    assert phase == 'after_target'
    assert observed == ['working_items', 'publication_link', 'progress_overlay']
    assert ('before_target', MANAGE, True) in decisions
    assert ('after_target', MANAGE, False) in decisions
    assert ('before_target', BROWSE, True) in decisions
    assert ('after_target', BROWSE, True) in decisions
    assert all(allowed for seen_phase, action, allowed in decisions
               if seen_phase == 'before_target' or action != MANAGE)
    assert all(not allowed for seen_phase, action, allowed in decisions
               if seen_phase == 'after_target' and action == MANAGE)

    trace = [(sql, params) for worker, sql, params in statements if worker == get_ident()]
    assert len(trace) == len(statements)
    for name, marker in markers.items():
        matched = [(sql, params) for sql, params in trace if marker in sql]
        assert len(matched) == 1, (name, matched)
        params = matched[0][1]
        if name == 'progress_overlay':
            assert (params[0], str(params[1]), params[2]) == (
                actor.account_id, top['top_ref'], mixed.db.library)
        else:
            assert (str(params[0]), params[1]) == (top['top_ref'], mixed.db.library)
    # The unchanged authority owner locks accounts with one SELECT-only CTE.
    # Admit this exact statement, never arbitrary WITH (which may contain DML).
    account_lock = ('with locked_accounts as ( select id from app.accounts '
        'where id in (%s, %s) order by id for update ) select id from locked_accounts')
    account_locks = [(sql, params) for sql, params in trace if sql == account_lock]
    assert len(account_locks) == 1
    assert account_locks[0][1] == (actor.account_id, actor.account_id)
    assert trace and all(sql.startswith(('select ', 'set ')) or sql == account_lock for sql, _ in trace)
    functions = [sql for sql, _ in trace if sql.startswith('select app.')]
    assert len(functions) == 1 and functions[0].startswith('select app.lock_top_remote_admission_for_read(')
    assert mixed.snapshot() == before

    expected_actions = {key: value for key, value in initial['allowed_actions'].items() if key != MANAGE}
    expected_actions.update(can_edit=False, can_rename=False, can_delete=False)
    assert result['allowed_actions'] == expected_actions
    assert result['allowed_actions'][BROWSE] is True
    assert result['allowed_actions']['can_read'] is True
    assert result['allowed_actions']['can_edit'] is False
    assert 'edit_draft' not in result
    assert {key: value for key, value in result.items() if key != 'allowed_actions'} == {
        key: value for key, value in initial.items() if key not in {'allowed_actions', 'edit_draft'}}
