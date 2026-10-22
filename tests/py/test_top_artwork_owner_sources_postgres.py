"""E owner reads over real restricted-role SQL and retained C2 publication.

Source-authored, NOT RUN. Existing source-choice rows are trusted metadata
fixtures for read-only discovery, not image provenance. Retained v2 cases use
the accepted actual C2 start/review/execute fixture and retained-aware teardown.
No SQL results, authority decisions, private context, clock or consent are forged.
"""
from contextlib import contextmanager
from copy import deepcopy
from time import sleep
from uuid import uuid4
import json

import pytest

from music_app.services import album_metadata_sources as inventory_sources
from music_app.services import album_top_publication_evidence as evidence
from music_app.services.album_top_artwork_owner import TopArtworkOwnerService
from music_app.services.owned_album_tops import ACCESS, BROWSE, ITEMS, MANAGE, AlbumTopError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.postgres_runtime_role_contract import assert_runtime_role
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error, CURSOR_SECRET
from tests.py.test_album_top_collaboration_postgres import member, new_session, write
from tests.py.test_album_top_publication_sources_postgres import choices, retained
from tests.py.test_top_artwork_publication_retention_postgres import publication_case, POSIX_CAPTURE
from tests.py.test_top_artwork_publication_postgres import (
    c2_case, ready, review_command, execute, publication_rows, trap_pixels, CONTEXT,
)

STATE_KEYS = {'version', 'top_ref', 'revision', 'publication',
              'publication_contract_version', 'prior_choices', 'request_generation'}
CHOICE_KEYS = {'item_ref', 'album_ref', 'selected_local_album_id',
               'selected_source_ref', 'position', 'included'}
SOURCE_KEYS = {'selected_local_album_id', 'selected_source_ref', 'title', 'artist', 'year'}
PAGE_KEYS = {'top_ref', 'revision', 'draft_ref', 'draft_revision', 'row_ref',
             'item_ref', 'album_ref', 'sources', 'next_cursor'}


@contextmanager
def maintenance(database):
    """Trusted fixture inspection/setup only, bounded immediately on connect."""
    with database.connect() as connection:
        connection.execute("set local lock_timeout='5s'")
        connection.execute("set local statement_timeout='120s'")
        yield connection


def source_payload(fixture, *, index=0, **changes):
    _, top, items, _, _ = fixture
    item = items[index]
    return {'revision': top['revision'], 'draft_ref': str(uuid4()), 'draft_revision': '1',
            'row_ref': str(uuid4()), 'item_ref': item['ref'], 'album_ref': item['catalog_ref'],
            'cursor': None, 'limit': 25, **changes}


def read_sources(fixture, payload, *, actor=None, context_ref=CONTEXT, secret=CURSOR_SECRET,
                 constraints=None, top_ref=None):
    database, top, _, _, _ = fixture
    return TopArtworkOwnerService(database.service).read_sources(database.context(actor),
        top_ref=top['top_ref'] if top_ref is None else top_ref, payload=payload,
        context_ref=context_ref, cursor_secret=secret, constraints=constraints)


def read_state(case, *, actor=None, context_ref=CONTEXT, constraints=None):
    return TopArtworkOwnerService(case.db.service).read_state(case.db.context(actor),
        top_ref=case.top['top_ref'], context_ref=context_ref, constraints=constraints)


@contextmanager
def observe_reads(database, *, after=None):
    """Forward every result; observe real runtime role after owner SET TRANSACTION.

    Existing ordered account-lock CTE is the sole accepted WITH statement.
    This read ledger explicitly forbids image/proof/track material and any DML.
    """
    connect = database.service._connect
    trace = {'sql': [], 'connections': 0, 'role_checks': 0}
    account_lock = ('with locked_accounts as ( select id from app.accounts '
                    'where id in (%s, %s) order by id for update ) '
                    'select id from locked_accounts')
    class Connection:
        def __init__(self, real):
            self.real, self.initialized = real, False
        def __getattr__(self, name):
            return getattr(self.real, name)
        def execute(self, sql, params=None):
            statement = ' '.join(str(sql).lower().split())
            if not self.initialized:
                assert statement == 'set transaction isolation level read committed'
            assert statement.startswith(('select ', 'set ', 'lock table ')) or statement == account_lock
            for forbidden in ('source_stamp', 'acquisition_stamp', 'from library.local_tracks',
                              'from library.local_track_files', 'from app.album_top_artwork_assets',
                              'from app.album_top_artwork_preparations',
                              'from app.album_top_artwork_preparation_items',
                              'from app.album_top_artwork_draft_items'):
                assert forbidden not in statement, statement
            result = self.real.execute(sql, params)
            if not self.initialized:
                assert_runtime_role(self.real, database)
                self.initialized = True
                trace['role_checks'] += 1
            trace['sql'].append(statement)
            if after is not None:
                after(self.real, statement, params, trace)
            return result
    @contextmanager
    def connected(*args, **kwargs):
        with connect(*args, **kwargs) as connection:
            connection.execute("set local lock_timeout='5s'")
            connection.execute("set local statement_timeout='120s'")
            trace['connections'] += 1
            yield Connection(connection)
    database.service._connect = connected
    try:
        yield trace
    finally:
        database.service._connect = connect


def forbidden(*args, **kwargs):
    raise AssertionError('Owner state/source discovery cannot capture or reconcile inventory')


def test_existing_row_has_exact_bounded_distinct_sources_and_no_writes(choices, monkeypatch):
    database, _, items, sources, _ = choices
    payload = source_payload(choices, limit=1)
    before = retained(database)
    monkeypatch.setattr(evidence, 'capture', forbidden)
    monkeypatch.setattr(inventory_sources, 'reconcile_album_metadata_sources', forbidden)
    pages, cursors = [], set()
    with observe_reads(database) as trace:
        for _ in range(3):
            value = read_sources(choices, payload)
            assert set(value) == PAGE_KEYS
            assert all(set(row) == SOURCE_KEYS for row in value['sources'])
            assert {key: value[key] for key in ('revision', 'draft_ref', 'draft_revision', 'row_ref',
                                                'item_ref', 'album_ref')} == {
                key: payload[key] for key in ('revision', 'draft_ref', 'draft_revision', 'row_ref',
                                               'item_ref', 'album_ref')}
            pages.append(value)
            if value['next_cursor'] is None:
                break
            assert value['next_cursor'] not in cursors
            cursors.add(value['next_cursor'])
            payload = {**payload, 'cursor': value['next_cursor']}
    assert pages[-1]['next_cursor'] is None, 'Three known physical copies need at most three pages'
    assert [page['sources'][0]['selected_source_ref'] for page in pages] == sorted(sources[:3])
    assert trace['connections'] == trace['role_checks'] == 3
    assert retained(database) == before
    serialized = json.dumps(pages)
    for private in ('/synthetic-choices/', 'container_identity', 'private_path', 'library_root_id',
                    'track_key', 'source_stamp', 'acquisition_stamp'):
        assert private not in serialized


def test_null_new_row_discovers_existing_catalog_without_temporary_membership(choices):
    database, top, items, sources, root = choices
    top = database.service.execute(database.context(), database.command('remove', top,
        item_refs=[items[0]['ref']]))
    fixture = database, top, items, sources, root
    payload = source_payload(fixture, item_ref=None)
    before = retained(database)
    with observe_reads(database) as trace:
        value = read_sources(fixture, payload)
    assert value['item_ref'] is None and value['row_ref'] == payload['row_ref']
    assert value['album_ref'] == items[0]['catalog_ref'] and len(value['sources']) == 3
    assert trace['connections'] == trace['role_checks'] == 1
    assert retained(database) == before


@pytest.mark.parametrize('foreign', [False, True])
def test_null_new_row_rejects_unlinked_and_actual_foreign_library_catalog(choices, foreign):
    database = choices[0]
    catalog_ref = str(uuid4())
    if foreign:
        with maintenance(database) as connection:
            library = database.library_for(connection, database.owner)
            other_actor = database.member(connection, database.owner, library)
            artist = connection.execute('''insert into library.local_artists(library_id,artist_key,name)
                values(%s,%s,'Distinct foreign artist') returning id''', (library, str(uuid4()))).fetchone()['id']
            album = connection.execute('''insert into library.local_albums
                (library_id,artist_id,album_key,title,release_year,metadata)
                values(%s,%s,%s,'Distinct foreign album',2000,'{}') returning id''',
                (library, artist, str(uuid4()))).fetchone()['id']
        catalog_ref = database.service.admit_inventory_album(database.context(other_actor), album_id=album)['album_ref']
        database.album_refs.append(catalog_ref)
    payload = source_payload(choices, item_ref=None, album_ref=catalog_ref)
    before = retained(database)
    assert_error(lambda: read_sources(choices, payload), 'item_unavailable', 404)
    assert retained(database) == before


def test_linked_catalog_without_eligible_source_returns_an_empty_read_only_page(choices):
    database = choices[0]
    # Third existing admitted local catalog has no source fixture and is not a
    # saved Top member. This is distinct from an unknown or foreign catalog.
    payload = source_payload(choices, item_ref=None, album_ref=database.album_refs[2])
    before = retained(database)
    result = read_sources(choices, payload)
    assert result['sources'] == [] and result['next_cursor'] is None
    assert result['item_ref'] is None and result['album_ref'] == database.album_refs[2]
    assert retained(database) == before


@pytest.mark.parametrize('change', ['missing_saved', 'foreign_saved', 'wrong_catalog', 'null_existing'])
def test_row_identity_cannot_impersonate_saved_membership(choices, change):
    database, top, items, _, _ = choices
    payload = source_payload(choices)
    if change == 'missing_saved':
        payload['item_ref'] = str(uuid4())
    elif change == 'foreign_saved':
        other, _ = database.create(refs=database.album_refs[2:])
        payload['item_ref'] = database.read(other)['items'][0]['ref']
    elif change == 'wrong_catalog':
        payload['album_ref'] = items[1]['catalog_ref']
    else:
        payload['item_ref'] = None
    before = retained(database)
    with pytest.raises(AlbumTopError) as caught:
        read_sources(choices, payload)
    assert (caught.value.code, caught.value.status_code) == (
        ('items_changed', 409) if change == 'null_existing' else ('item_unavailable', 404))
    assert retained(database) == before


@pytest.mark.parametrize('field,value', [
    ('revision', 1), ('revision', '0'), ('revision', '01'), ('draft_revision', True),
    ('draft_revision', '0'), ('draft_ref', '00000000-0000-0000-0000-000000000000'),
    ('row_ref', 'invalid'), ('item_ref', ''), ('album_ref', 'invalid'), ('limit', True),
    ('limit', 0), ('limit', 101), ('cursor', ''), ('cursor', 'x' * 4097),
])
def test_source_request_shape_is_strict_before_authorization_connection(choices, field, value):
    payload = source_payload(choices, **{field: value})
    with observe_reads(choices[0]) as trace:
        assert_error(lambda: read_sources(choices, payload), 'invalid_query', 422)
    assert trace['connections'] == 0


@pytest.mark.parametrize('field', ['draft_ref', 'draft_revision', 'row_ref', 'item_ref',
                                 'album_ref', 'revision', 'context', 'session', 'limit', 'secret'])
def test_source_cursor_binds_full_draft_row_owner_context_and_generation(choices, field):
    database, _, _, _, _ = choices
    payload = source_payload(choices, limit=1)
    cursor = read_sources(choices, payload)['next_cursor']
    assert cursor
    payload = {**payload, 'cursor': cursor}
    options = {}
    if field == 'context': options['context_ref'] = 'b' * 64
    elif field == 'session': options['actor'] = new_session(database, database.owner)
    elif field == 'secret': options['secret'] = 'different-synthetic-e-source-key-32-bytes'
    elif field == 'limit': payload['limit'] = 2
    elif field in ('draft_revision', 'revision'): payload[field] = '2'
    else: payload[field] = str(uuid4())
    code, status = (('revision_conflict', 409) if field == 'revision' else
                    ('item_unavailable', 404) if field in ('item_ref', 'album_ref') else
                    ('invalid_cursor', 422))
    assert_error(lambda: read_sources(choices, payload, **options), code, status)


def test_real_source_generation_change_invalidates_prior_cursor(choices):
    database, _, _, sources, _ = choices
    payload = source_payload(choices, limit=1)
    cursor = read_sources(choices, payload)['next_cursor']
    with maintenance(database) as connection:
        connection.execute('update library.album_metadata_sources set year=2001 where ref=%s', (sources[0],))
    assert_error(lambda: read_sources(choices, {**payload, 'cursor': cursor}), 'invalid_cursor', 422)


@pytest.mark.parametrize('scope', ['album', 'album_metadata_source', 'library_root'])
def test_metadata_scope_denial_filters_sources_without_leaking_labels(choices, scope):
    seen = []
    def constraints(context):
        resource = context.resource
        if resource is not None: seen.append((context.action, resource.resource_kind, resource.resource_ref))
        return PolicyEvaluationConstraints(request_origin_allowed=not (
            resource is not None and resource.resource_kind == scope))
    value = read_sources(choices, source_payload(choices), constraints=constraints)
    assert value['sources'] == []
    assert any(action == BROWSE and kind == scope for action, kind, _ in seen)


@pytest.mark.parametrize('action', [BROWSE, MANAGE, ITEMS, ACCESS])
def test_source_discovery_still_requires_each_owner_gate(choices, action):
    def constraints(context):
        return PolicyEvaluationConstraints(request_origin_allowed=context.action != action)
    assert_error(lambda: read_sources(choices, source_payload(choices), constraints=constraints), 'forbidden', 403)


def test_late_source_policy_rechecks_earlier_candidate_before_return(choices):
    seen = set()
    def constraints(context):
        resource = context.resource
        if resource is not None and resource.resource_kind == 'album_metadata_source':
            seen.add(resource.resource_ref)
        return PolicyEvaluationConstraints(request_origin_allowed=len(seen) < 3)
    assert_error(lambda: read_sources(choices, source_payload(choices), constraints=constraints), 'forbidden', 403)
    assert len(seen) == 3


def test_nonowner_cannot_use_owner_draft_source_discovery(choices):
    database, top, items, sources, root = choices
    editor = member(database)
    top, _ = write(database, 'grant_editor', top, account_id=editor.account_id, role='editor')
    fixture = database, top, items, sources, root
    assert_error(lambda: read_sources(fixture, source_payload(fixture), actor=editor), 'forbidden', 403)


@pytest.mark.parametrize('count', [0, 1, 100, 101, 250, 5000])
def test_current_state_issuance_is_real_database_time_and_read_only(c2_case, count, monkeypatch):
    case = c2_case.build(count, excluded=range(count))
    before = retained(case.db)
    trap_pixels(monkeypatch, all_observation=True)
    with maintenance(case.db) as connection:
        lower = connection.execute('select floor(extract(epoch from clock_timestamp()))::bigint as n').fetchone()['n']
    with observe_reads(case.db) as trace:
        value = read_state(case)
    with maintenance(case.db) as connection:
        upper = connection.execute('select floor(extract(epoch from clock_timestamp()))::bigint as n').fetchone()['n']
    assert set(value) == STATE_KEYS and value['version'] == 1
    assert value['top_ref'] == case.top['top_ref'] and value['revision'] == case.top['revision']
    assert value['publication_contract_version'] is None and value['prior_choices'] == []
    assert type(value['request_generation']) is int and lower <= value['request_generation'] <= upper
    assert trace['connections'] == trace['role_checks'] == 1
    assert retained(case.db) == before


def test_existing_saved_source_api_keeps_its_original_pairing_and_cursor_contract(choices):
    database, top, items, _, _ = choices
    original = database.service.read_publication_sources(database.context(),
        top_ref=top['top_ref'], item_ref=items[0]['ref'], revision=top['revision'],
        context_ref=CONTEXT, cursor_secret=CURSOR_SECRET, limit=1)
    new = read_sources(choices, source_payload(choices, limit=1))
    assert set(original) == {'top_ref', 'revision', 'item_ref', 'album_ref', 'sources', 'next_cursor'}
    assert original['sources'] == new['sources']
    # Distinct scoped domains cannot accidentally interchange saved and draft pages.
    assert_error(lambda: read_sources(choices, source_payload(choices, limit=1,
        cursor=original['next_cursor'])), 'invalid_cursor', 422)


@pytest.mark.parametrize('state', ['v1', 'revoked_v2'])
def test_state_discovery_distinguishes_legacy_and_revoked_without_prior_choice_authority(c2_case, state):
    case = c2_case.build(1, excluded=(0,))
    if state == 'v1':
        items = [{key: value for key, value in row.items() if key != 'include_artwork'} for row in case.items]
        preview = case.db.service.publication_preview(case.db.context(), top_ref=case.top['top_ref'],
            payload={'revision': case.top['revision'], 'items': items})
        case.top = case.db.service.execute(case.db.context(), case.db.command('enable_external', case.top,
            title='Existing metadata-only publication', description='', items=items,
            evidence_revision=preview['evidence_revision']))
    else:
        prepared, payload = ready(case, 'saved')
        _, command = review_command(case, prepared, 'saved', payload)
        case.top = execute(case, command)
        case.top = case.db.service.execute(case.db.context(), case.db.command('revoke_external', case.top))
    with observe_reads(case.db):
        value = read_state(case)
    assert value['publication_contract_version'] == (1 if state == 'v1' else None)
    assert value['prior_choices'] == []
    assert value['publication']['state'] == ('enabled' if state == 'v1' else 'revoked')


@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('count', [0, 1, 100, 101, 250, 5000])
def test_active_v2_prior_choices_are_complete_retained_rows_not_current_join(c2_case, kind, count, monkeypatch):
    case = c2_case.build(count, excluded=range(count))
    state, payload = ready(case, kind)
    _, command = review_command(case, state, kind, payload)
    case.top = execute(case, command)
    retained_rows = publication_rows(case, case.top)[2]
    if count:
        # A legitimate later ordinary remove does not invalidate retained closure.
        working = case.db.service.execute(case.db.context(), case.db.command('remove', case.top,
            item_refs=[str(retained_rows[-1]['item_ref'])]))
        case.top = {**case.top, **working}
    before = retained(case.db)
    trap_pixels(monkeypatch, all_observation=True)
    with observe_reads(case.db) as trace:
        value = read_state(case)
    assert value['publication_contract_version'] == 2
    assert len(value['prior_choices']) == count
    assert all(set(row) == CHOICE_KEYS for row in value['prior_choices'])
    assert [row['position'] for row in value['prior_choices']] == list(range(1, count + 1))
    assert [row['item_ref'] for row in value['prior_choices']] == [str(row['item_ref']) for row in retained_rows]
    assert [row['album_ref'] for row in value['prior_choices']] == [str(row['catalog_ref']) for row in retained_rows]
    assert all(row['included'] is False for row in value['prior_choices'])
    assert trace['connections'] == trace['role_checks'] == 1
    assert len(trace['sql']) <= 40, 'Source-chosen statement bound, not measured latency or RSS'
    assert retained(case.db) == before


@POSIX_CAPTURE
@pytest.mark.parametrize('kind', ['saved', 'draft'])
def test_removed_previously_included_row_remains_visible_in_retained_prior_choices(c2_case, kind, monkeypatch):
    case = c2_case.build(2, excluded=(1,))
    state, payload = ready(case, kind)
    _, command = review_command(case, state, kind, payload)
    case.top = execute(case, command)
    case.top = case.db.service.execute(case.db.context(), case.db.command('remove', case.top,
        item_refs=[case.items[0]['item_ref']]))
    trap_pixels(monkeypatch, all_observation=True)
    with observe_reads(case.db):
        value = read_state(case)
    assert [row['included'] for row in value['prior_choices']] == [True, False]
    assert [row['item_ref'] for row in value['prior_choices']] == [row['item_ref'] for row in case.items]
    assert [row['album_ref'] for row in value['prior_choices']] == case.catalog_refs
    assert [row['selected_local_album_id'] for row in value['prior_choices']] == case.album_ids
    assert [row['selected_source_ref'] for row in value['prior_choices']] == case.source_refs
    assert value['revision'] == case.top['revision']


@POSIX_CAPTURE
@pytest.mark.parametrize('scope', ['metadata_album', 'metadata_source', 'metadata_root', 'artwork_album', 'artwork_root'])
def test_current_state_rechecks_retained_metadata_and_actual_artwork_scope(c2_case, scope):
    case = c2_case.build(2)
    state, payload = ready(case, 'saved')
    _, command = review_command(case, state, 'saved', payload)
    case.top = execute(case, command)
    target = {'metadata_album': (BROWSE, 'album', str(case.album_ids[1])),
              'metadata_source': (BROWSE, 'album_metadata_source', case.source_refs[1]),
              'metadata_root': (BROWSE, 'library_root', str(case.metadata_root)),
              'artwork_album': ('library.artwork.read', 'album', str(case.album_ids[1])),
              'artwork_root': (BROWSE, 'library_root', str(case.artwork_root))}[scope]
    seen = []
    def constraints(context):
        resource = context.resource
        actual = (context.action, resource.resource_kind, resource.resource_ref) if resource else None
        seen.append(actual)
        return PolicyEvaluationConstraints(request_origin_allowed=actual != target)
    with pytest.raises(AlbumTopError) as caught:
        read_state(case, constraints=constraints)
    assert (caught.value.code, caught.value.status_code) == ('forbidden', 403)
    assert target in seen and case.metadata_root != case.artwork_root


@pytest.mark.parametrize('operation', ['state', 'sources'])
@pytest.mark.parametrize('failure', ['session', 'membership', 'owner', 'top'])
def test_current_persisted_owner_session_library_and_top_gate_every_read(c2_case, operation, failure):
    case = c2_case.build(1, excluded=(0,))
    fixture = case.db, case.top, case.db.read(case.top)['items'], case.source_refs, case.metadata_root
    payload = source_payload(fixture)
    with maintenance(case.db) as connection:
        if failure == 'session':
            connection.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s',
                               (case.db.owner.session_id,))
        elif failure == 'membership':
            connection.execute('delete from library.library_memberships where library_id=%s and account_id=%s',
                               (case.db.library, case.db.owner.account_id))
        elif failure == 'owner':
            connection.execute('update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s',
                               (case.db.owner.account_id,))
        else:
            connection.execute('update app.album_lists set deleted_at=clock_timestamp() where ref=%s',
                               (case.top['top_ref'],))
    callback = (lambda: read_state(case)) if operation == 'state' else (lambda: read_sources(fixture, payload))
    assert_error(callback, 'top_unavailable' if failure == 'top' else 'forbidden',
                 404 if failure == 'top' else 403)


@pytest.mark.parametrize('operation', ['state', 'sources'])
def test_real_held_session_expiry_after_read_work_cannot_escape(c2_case, operation, record_property):
    case = c2_case.build(1, excluded=(0,))
    fixture = case.db, case.top, case.db.read(case.top)['items'], case.source_refs, case.metadata_root
    payload = source_payload(fixture)
    with maintenance(case.db) as connection:
        deadline = connection.execute("""update app.account_sessions
            set idle_expires_at=clock_timestamp()+interval '15 seconds'
            where id=%s returning idle_expires_at""", (case.db.owner.session_id,)).fetchone()['idle_expires_at']
    waits = []
    def after(connection, sql, params, trace):
        marker = ('select floor(extract(epoch from clock_timestamp()))' if operation == 'state'
                  else 'select s.ref,s.local_album_id from library.album_metadata_sources')
        if not waits and sql.startswith(marker):
            now = connection.execute('select clock_timestamp() as now').fetchone()['now']
            assert now < deadline, 'Fixture must reach the intended late wait before expiry'
            delay = (deadline - now).total_seconds() + 0.05
            assert 0 < delay <= 15.05
            waits.append(delay)
            sleep(delay)
    with observe_reads(case.db, after=after):
        callback = (lambda: read_state(case)) if operation == 'state' else (lambda: read_sources(fixture, payload))
        assert_error(callback, 'forbidden', 403)
    assert len(waits) == 1
    record_property('e_owner_' + operation + '_real_session_wait_seconds', waits[0])


@POSIX_CAPTURE
@pytest.mark.parametrize('actor_scope', ['held_requester', 'durable_owner'])
@pytest.mark.parametrize('scope', ['metadata_source', 'metadata_root', 'artwork_album', 'artwork_root'])
def test_policy_change_during_real_issuance_select_rechecks_complete_retained_scope(c2_case, actor_scope, scope):
    case = c2_case.build(2)
    state, payload = ready(case, 'saved')
    _, command = review_command(case, state, 'saved', payload)
    case.top = execute(case, command)
    target = {'metadata_source': (BROWSE, 'album_metadata_source', case.source_refs[1]),
              'metadata_root': (BROWSE, 'library_root', str(case.metadata_root)),
              'artwork_album': ('library.artwork.read', 'album', str(case.album_ids[1])),
              'artwork_root': (BROWSE, 'library_root', str(case.artwork_root))}[scope]
    after_issuance, denied = [], []
    def after(connection, sql, params, trace):
        if sql.startswith('select floor(extract(epoch from clock_timestamp()))'):
            after_issuance.append(True)
    def constraints(context):
        resource = context.resource
        actual = (context.action, resource.resource_kind, resource.resource_ref) if resource else None
        session = context.actor.session_id
        exact_actor = (session == case.db.owner.session_id if actor_scope == 'held_requester' else session is None)
        reject = bool(after_issuance) and exact_actor and actual == target
        if reject:
            denied.append((context.actor.account_id, session, actual))
        return PolicyEvaluationConstraints(request_origin_allowed=not reject)
    before = durable_snapshot_for_owner_read(case)
    with observe_reads(case.db, after=after):
        assert_error(lambda: read_state(case, constraints=constraints), 'forbidden', 403)
    assert after_issuance == [True] and denied
    expected_session = case.db.owner.session_id if actor_scope == 'held_requester' else None
    assert all(entry == (case.db.owner.account_id, expected_session, target) for entry in denied)
    assert case.metadata_root != case.artwork_root
    assert durable_snapshot_for_owner_read(case) == before


def durable_snapshot_for_owner_read(case):
    # Existing accepted retained-aware complete snapshot; no response data or
    # SQL result is substituted. Imported locally to keep the r1 prefix intact.
    from tests.py.test_top_artwork_publication_retention_postgres import durable_snapshot
    return durable_snapshot(case)


@pytest.mark.parametrize('action', [BROWSE, ACCESS])
def test_policy_change_during_real_issuance_select_rechecks_unpublished_owner_gate(c2_case, action):
    case = c2_case.build(1, excluded=(0,))
    after_issuance, denied = [], []
    def after(connection, sql, params, trace):
        if sql.startswith('select floor(extract(epoch from clock_timestamp()))'):
            after_issuance.append(True)
    def constraints(context):
        resource = context.resource
        target = (context.action, resource.resource_kind, resource.resource_ref) if resource else None
        reject = bool(after_issuance) and context.actor.session_id == case.db.owner.session_id and target == (
            action, 'album_top', case.top['top_ref'])
        if reject: denied.append(target)
        return PolicyEvaluationConstraints(request_origin_allowed=not reject)
    before = durable_snapshot_for_owner_read(case)
    with observe_reads(case.db, after=after):
        assert_error(lambda: read_state(case, constraints=constraints), 'forbidden', 403)
    assert after_issuance == [True] and denied
    assert set(denied) == {(action, 'album_top', case.top['top_ref'])}
    assert durable_snapshot_for_owner_read(case) == before
