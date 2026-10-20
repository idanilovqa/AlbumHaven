"""Contract-first saved Artist/Family tests through actual app-role transactions.

Fixture SQL only seeds uniquely owned inventory. It never substitutes admission,
family resolution, command execution, or SQL results. Requires the normal fully
migrated synthetic PostgreSQL fixture; source authored without execution.
"""
from copy import deepcopy
from uuid import uuid4

import pytest
from psycopg.types.json import Jsonb

from music_app.services.owned_album_tops import BROWSE, normalize_top_command
from music_app.services.library_inventory_postgres import local_inventory_identity_key
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.relation_projection_postgres import RELATION_PROJECTION_BUILDER_VERSION
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error, CURSOR_SECRET


def seed_scope(database):
    with database.connect() as con:
        root = con.execute('select artist_id from library.local_albums where id=%s',
                           (database.album_ids[0],)).fetchone()['artist_id']
        ids = [root]
        for suffix in ('family', 'outside'):
            name = 'Scope ' + suffix + ' ' + database.token
            ids.append(con.execute('''insert into library.local_artists(library_id,artist_key,name)
                values(%s,%s,%s) returning id''',
                (database.library, local_inventory_identity_key(name), name)).fetchone()['id'])
        for index, (album, artist) in enumerate(zip(database.album_ids, ids)):
            name = con.execute('select name from library.local_artists where id=%s', (artist,)).fetchone()['name']
            con.execute('update library.local_albums set artist_id=%s,metadata=%s where id=%s',
                        (artist, Jsonb({'album_artist': name, 'artists': [name]}), album))
            con.execute('''insert into library.local_album_featured_artists
                (library_id,album_id,artist_id,featured_kind) values(%s,%s,%s,'owner')
                on conflict do nothing''', (database.library, album, artist))
        relation = {'alias_to_canonical': {}, 'canonical_to_aliases': {}, 'family_to_artists': {},
                    'folder_related': {}, 'artists': [], 'artists_sidebar': [], 'sidebar_families': []}
        projection = {'status': 'ready', 'builder_version': RELATION_PROJECTION_BUILDER_VERSION,
                      'source_fingerprint': database.token, 'built_from_fingerprint': database.token}
        con.execute('update library.libraries set metadata=%s where id=%s',
                    (Jsonb({'scan_cache': {'relation_views': relation, 'relation_projection': projection}}), database.library))
        con.execute('''insert into library.local_artist_family_links
            (library_id,artist_id,related_artist_id,relationship_weight,source_family,source_ref)
            values(%s,%s,%s,1,'folder_derived_runtime','relation_views.folder_related')''',
            (database.library, root, ids[1]))
    return ids


@pytest.fixture
def scoped_db(db):
    db.scope_artists = seed_scope(db)
    return db


def descriptor(database, mode='artist', root=None):
    return {'root_artist_id': str(database.scope_artists[0] if root is None else root), 'mode': mode}


def create(database, *, mode='artist', refs=None, root=None, constraints=None):
    command = normalize_top_command('create', {'request_key': str(uuid4()), 'title': 'Scoped collection',
        'album_refs': database.album_refs[:1] if refs is None else refs,
        'artist_scope': descriptor(database, mode, root)})
    return database.service.execute(database.context(), command, constraints=constraints), command


def search(database, *, scope=None, top=None, **options):
    return database.service.search_inventory_albums(database.context(), cursor_secret=CURSOR_SECRET,
        **({'artist_scope': descriptor(database) if scope is None else scope} if top is None else {'top_ref': top}),
        **options)


def refs(database, receipt):
    return [row['catalog_ref'] for row in database.read(receipt)['items']]


def deny(kind, identity):
    def constraints(context):
        blocked = (context.action == BROWSE and context.resource is not None
                   and context.resource.resource_kind == kind and context.resource.resource_ref == str(identity))
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)
    return constraints


def test_empty_scoped_create_persists_descriptor_but_never_populates_saved_members(scoped_db):
    database = scoped_db
    receipt, command = create(database, refs=[])
    assert refs(database, receipt) == []
    assert database.read(receipt)['artist_scope'] == descriptor(database)
    listed = database.service.list(database.context(), cursor_secret=CURSOR_SECRET)['tops']
    assert next(row for row in listed if row['top_ref'] == receipt['top_ref'])['artist_scope'] == descriptor(database)
    before = database.snapshot()
    assert database.service.execute(database.context(), command) == receipt
    assert database.snapshot() == before
    assert set(receipt) == {'top_ref', 'revision', 'request_key', 'action'}


@pytest.mark.parametrize('mode,indices', [('artist', [0]), ('family', [1, 0])])
def test_explicit_membership_uses_exact_artist_or_family_without_media_permission(scoped_db, mode, indices):
    database = scoped_db
    selected = [database.album_refs[index] for index in indices]
    receipt, _ = create(database, mode=mode, refs=selected)
    assert refs(database, receipt) == selected
    assert database.read(receipt)['artist_scope'] == descriptor(database, mode)
    assert all('play' not in grant.capability_key for grant in database.owner.capability_grants)


@pytest.mark.parametrize('mode,index', [('artist', 1), ('artist', 2), ('family', 2)])
def test_unrelated_new_canonical_member_rejects_atomically(scoped_db, mode, index):
    database = scoped_db
    before = database.snapshot()
    assert_error(lambda: create(database, mode=mode, refs=[database.album_refs[0], database.album_refs[index]]),
                 'album_outside_artist_scope', 409)
    assert database.snapshot() == before


@pytest.mark.parametrize('kind', ['missing', 'foreign', 'denied'])
def test_empty_create_still_validates_exact_current_caller_root(scoped_db, kind):
    database = scoped_db
    root, constraints = 9223372036854775807, None
    if kind == 'denied':
        root = database.scope_artists[0]
        constraints = deny('artist', root)
    elif kind == 'foreign':
        with database.connect() as con:
            library = database.library_for(con, database.owner)
            root = con.execute('''insert into library.local_artists(library_id,artist_key,name)
                values(%s,%s,'Synthetic artist') returning id''', (library, database.token)).fetchone()['id']
    before = database.snapshot()
    assert_error(lambda: create(database, refs=[], root=root, constraints=constraints), 'artist_scope_unavailable', 404)
    assert database.snapshot() == before


def test_stale_relation_projection_fails_closed_without_writes(scoped_db):
    database = scoped_db
    with database.connect() as con:
        con.execute("update library.libraries set metadata=jsonb_set(metadata,'{scan_cache,relation_projection,status}',%s) where id=%s",
                    (Jsonb('stale'), database.library))
    before = database.snapshot()
    assert_error(lambda: create(database, mode='family'), 'artist_scope_unavailable', 503)
    assert database.snapshot() == before


def test_family_change_does_not_rewrite_saved_members_and_retained_edits_copy_work(scoped_db):
    database = scoped_db
    receipt, _ = create(database, mode='family', refs=database.album_refs[:2])
    with database.connect() as con:
        con.execute('delete from library.local_artist_family_links where library_id=%s', (database.library,))
        con.execute('''insert into library.local_artist_family_links
            (library_id,artist_id,related_artist_id,relationship_weight,source_family,source_ref)
            values(%s,%s,%s,1,'folder_derived_runtime','relation_views.folder_related')''',
            (database.library, database.scope_artists[0], database.scope_artists[2]))
    before = database.snapshot()
    assert refs(database, receipt) == database.album_refs[:2]
    database.service.list(database.context(), cursor_secret=CURSOR_SECRET)
    assert database.snapshot() == before
    rows = database.read(receipt)['items']
    receipt = database.service.execute(database.context(), database.command('reorder', receipt,
        item_order=[row['ref'] for row in reversed(rows)]))
    assert refs(database, receipt) == list(reversed(database.album_refs[:2]))
    receipt = database.service.execute(database.context(), database.command('save', receipt, title='Still explicit'))
    copied = database.service.execute(database.context(), database.command('copy', receipt))
    assert refs(database, copied) == refs(database, receipt)
    assert database.read(copied)['artist_scope'] == descriptor(database, 'family')
    receipt = database.service.execute(database.context(), database.command('remove', receipt, item_refs=[rows[1]['ref']]))
    assert refs(database, receipt) == database.album_refs[:1]
    assert database.album_refs[2] not in refs(database, copied)


def test_root_deletion_and_same_name_replacement_never_rebind_saved_provenance(scoped_db):
    database = scoped_db
    receipt, _ = create(database, mode='family', refs=[database.album_refs[1]])
    old = database.scope_artists[0]
    with database.connect() as con:
        original = con.execute('select artist_key,name from library.local_artists where id=%s', (old,)).fetchone()
        # Preserve unrelated inventory while removing the exact provenance root.
        con.execute('update library.local_albums set artist_id=%s where artist_id=%s', (database.scope_artists[2], old))
        con.execute('delete from library.local_artists where id=%s', (old,))
        replacement = con.execute('''insert into library.local_artists(library_id,artist_key,name)
            values(%s,%s,%s) returning id''', (database.library, original['artist_key'], original['name'])).fetchone()['id']
    assert replacement != old
    assert refs(database, receipt) == [database.album_refs[1]]
    receipt = database.service.execute(database.context(), database.command('save', receipt, title='Retained'))
    copy = database.service.execute(database.context(), database.command('copy', receipt))
    assert database.read(copy)['artist_scope'] == descriptor(database, 'family')
    assert refs(database, copy) == [database.album_refs[1]]
    before = database.snapshot()
    assert_error(lambda: database.service.execute(database.context(), database.command('add', receipt,
        album_refs=[database.album_refs[2]])), 'artist_scope_unavailable', 404)
    assert database.snapshot() == before


@pytest.mark.parametrize('typed', [False, True])
def test_save_new_member_rejection_rolls_back_title_membership_and_receipt(scoped_db, typed):
    database = scoped_db
    receipt, _ = create(database)
    row = database.read(receipt)['items'][0]
    if typed:
        values = {'item_selections': [
            {'kind': 'existing', 'item_ref': row['ref'], 'album_ref': row['catalog_ref'], 'source': {'kind': 'unselected'}},
            {'kind': 'new_local', 'album_ref': database.album_refs[2], 'source': {'kind': 'unselected'}}]}
    else:
        values = {'items': [{'item_ref': row['ref'], 'album_ref': row['catalog_ref']},
                            {'item_ref': None, 'album_ref': database.album_refs[2]}]}
    command = database.command('save', receipt, title='Must roll back', **values)
    before = database.snapshot()
    assert_error(lambda: database.service.execute(database.context(), command, context_ref='a' * 64), 'album_outside_artist_scope', 409)
    assert database.snapshot() == before


def test_any_readable_in_scope_edition_is_sufficient_without_playback_binding(scoped_db):
    database = scoped_db
    with database.connect() as con:
        # Two distinct physical editions share canonical membership. The outside
        # edition cannot veto the readable root edition or become its authority.
        con.execute('update library.catalog_album_links set catalog_ref=%s where library_id=%s and local_album_id=%s',
                    (database.album_refs[0], database.library, database.album_ids[2]))
    receipt, _ = create(database, constraints=deny('album', database.album_ids[2]))
    assert refs(database, receipt) == database.album_refs[:1]
    before = database.snapshot()
    assert_error(lambda: create(database, constraints=deny('album', database.album_ids[0])),
                 'album_outside_artist_scope', 409)
    assert database.snapshot() == before


def test_scoped_empty_search_filters_before_response_and_saved_scope_cannot_be_overridden(scoped_db):
    database = scoped_db
    assert database.service.search_inventory_albums(database.context(), query='', cursor_secret=CURSOR_SECRET) == {
        'albums': [], 'next_cursor': None}
    result = search(database, query='')
    assert [row['local_album_id'] for row in result['albums']] == database.album_ids[:1]
    assert set(result['albums'][0]) == {'local_album_id', 'album_ref', 'title', 'artist', 'year', 'creation_metadata'}
    family = search(database, scope=descriptor(database, 'family'), query='')
    assert {row['local_album_id'] for row in family['albums']} == set(database.album_ids[:2])
    receipt, _ = create(database)
    assert [row['local_album_id'] for row in search(database, top=receipt['top_ref'], query='')['albums']] == database.album_ids[:1]
    assert_error(lambda: database.service.search_inventory_albums(database.context(), query='', cursor_secret=CURSOR_SECRET,
        top_ref=receipt['top_ref'], artist_scope=descriptor(database, 'family')), 'invalid_command', 422)


def test_ordinary_top_dtos_remain_unscoped_and_catalog_admission_unchanged(scoped_db):
    database = scoped_db
    receipt, _ = database.create(refs=database.album_refs)
    assert 'artist_scope' not in database.read(receipt)
    assert 'artist_scope' not in database.service.list(database.context(), cursor_secret=CURSOR_SECRET)['tops'][0]
    assert refs(database, receipt) == database.album_refs
    assert database.service.admit_inventory_album(database.context(), album_id=database.album_ids[2]) == {
        'album_ref': database.album_refs[2]}


def test_cursor_binds_scope_descriptor_and_current_family_membership(scoped_db):
    database = scoped_db
    first = search(database, scope=descriptor(database, 'family'), query='', limit=1)
    assert len(first['albums']) == 1 and first['next_cursor'] is not None
    assert_error(lambda: search(database, query='', limit=1, cursor=first['next_cursor']), 'invalid_cursor', 422)
    with database.connect() as con:
        con.execute('delete from library.local_artist_family_links where library_id=%s', (database.library,))
    assert_error(lambda: search(database, scope=descriptor(database, 'family'), query='', limit=1,
                               cursor=first['next_cursor']), 'invalid_cursor', 422)


@pytest.mark.parametrize('saved', [False, True])
def test_inventory_admission_rejects_outside_before_creating_any_catalog_mapping(scoped_db, saved):
    database = scoped_db
    options = {'artist_scope': descriptor(database)}
    if saved:
        receipt, _ = create(database)
        options = {'top_ref': receipt['top_ref']}
    with database.connect() as con:
        con.execute('delete from library.catalog_album_links where library_id=%s and local_album_id=%s',
                    (database.library, database.album_ids[2]))
        con.execute('update library.local_albums set title=%s where id=%s',
                    (database.token + '-outside', database.album_ids[2]))
        before = con.execute('select ref from catalog.release_groups where title=%s order by ref',
                             (database.token + '-outside',)).fetchall()
    assert_error(lambda: database.service.admit_inventory_album(database.context(), album_id=database.album_ids[2], **options),
                 'album_outside_artist_scope', 409)
    with database.connect() as con:
        assert con.execute('select ref from catalog.release_groups where title=%s order by ref',
                           (database.token + '-outside',)).fetchall() == before
        assert con.execute('select * from library.catalog_album_links where library_id=%s and local_album_id=%s',
                           (database.library, database.album_ids[2])).fetchall() == []


def test_actual_typed_local_create_uses_same_scope_and_canonical_membership(scoped_db):
    database = scoped_db
    command = normalize_top_command('create', {'request_key': str(uuid4()), 'draft_ref': str(uuid4()),
        'title': 'Typed scope', 'artist_scope': descriptor(database),
        'selections': [{'kind': 'local_catalog', 'album_ref': database.album_refs[0]}]})
    receipt = database.service.execute(database.context(), command, context_ref='a' * 64)
    assert refs(database, receipt) == database.album_refs[:1]
    assert database.read(receipt)['artist_scope'] == descriptor(database)


def test_missing_remote_selection_rejects_through_actual_source_owner(scoped_db):
    from tests.py.test_album_top_remote_membership_postgres import record_owner_sql
    database = scoped_db
    command = normalize_top_command('create', {'request_key': str(uuid4()), 'draft_ref': str(uuid4()),
        'title': 'Remote scope', 'artist_scope': descriptor(database), 'selections': [
            {'kind': 'remote_acquisition', 'acquisition_ref': str(uuid4()), 'evidence_version': 'a' * 64}]})

    def remote_state():
        with database.connect() as connection:
            return {table: connection.execute('select * from app.' + table
                + ' where library_id=%s order by ' + order, (database.library,)).fetchall()
                for table, order in (
                    ('album_top_remote_admissions', 'ref'),
                    ('album_list_item_remote_sources', 'top_ref,item_ref'),
                    ('album_top_remote_retained_budgets', 'top_ref'))}

    before, retained_before = database.snapshot(), remote_state()
    with record_owner_sql(database) as recorded:
        assert_error(lambda: database.service.execute(database.context(), command, context_ref='a' * 64),
                     'remote_evidence_unavailable', 409)
    assert database.snapshot() == before
    assert remote_state() == retained_before
    # Observe the real resolver, without replacing any admission or SQL result.
    # A nonexistent acquisition cannot reach catalog mapping or retention.
    assert not any('insert into catalog.' in sql or 'update catalog.' in sql
                   or 'retain_top_remote_acquisition' in sql for _, sql, _ in recorded)


def test_changed_family_after_real_receipt_insert_rolls_back_all_writes(scoped_db, monkeypatch):
    database = scoped_db
    original = database.service._insert_operation
    observed = []
    def inserted(connection, live, command, receipt, required_actions):
        result = original(connection, live, command, receipt, required_actions)
        observed.append(receipt['top_ref'])
        # Existing scope locks do not lock family-link rows. A separate fixture
        # writer changes only its own relation after the real receipt insert.
        with database.connect() as writer:
            writer.execute("set local lock_timeout='2s'")
            writer.execute("set local statement_timeout='5s'")
            writer.execute('delete from library.local_artist_family_links where library_id=%s', (database.library,))
        return result
    monkeypatch.setattr(database.service, '_insert_operation', inserted)
    before = database.snapshot()
    assert_error(lambda: create(database, mode='family', refs=database.album_refs[:2]), 'artist_scope_changed', 409)
    assert len(observed) == 1
    assert database.snapshot() == before
    with database.connect() as con:
        assert con.execute('select count(*) as n from library.local_artist_family_links where library_id=%s',
                           (database.library,)).fetchone()['n'] == 0


def test_alias_membership_uses_existing_canonical_identity_owner(scoped_db):
    database = scoped_db
    with database.connect() as con:
        root_name = con.execute('select name from library.local_artists where id=%s',
                                (database.scope_artists[0],)).fetchone()['name']
        alias_name = con.execute('select name from library.local_artists where id=%s',
                                 (database.scope_artists[1],)).fetchone()['name']
        con.execute("update library.libraries set metadata=jsonb_set(jsonb_set(metadata,'{scan_cache,relation_views,alias_to_canonical}',%s),'{scan_cache,relation_views,canonical_to_aliases}',%s) where id=%s",
                    (Jsonb({alias_name: root_name}), Jsonb({root_name: [alias_name]}), database.library))
    receipt, _ = create(database, refs=database.album_refs[:2])
    assert refs(database, receipt) == database.album_refs[:2]


def test_copy_keeps_scope_but_new_add_uses_copiers_actual_album_authority(scoped_db):
    from tests.py.test_album_top_collaboration_postgres import member
    database = scoped_db
    receipt, _ = create(database, mode='family', refs=database.album_refs[:1])
    viewer = member(database)
    receipt = database.service.execute(database.context(), database.command('visibility', receipt, visibility='server_shared'))
    copied = database.service.execute(database.context(viewer), database.command('copy', receipt))
    detail = database.service.read(database.context(viewer), top_ref=copied['top_ref'])
    assert detail['artist_scope'] == descriptor(database, 'family')
    assert [row['catalog_ref'] for row in detail['items']] == database.album_refs[:1]
    observed = []
    def constraints(context):
        observed.append(context.actor.account_id)
        return deny('album', database.album_ids[1])(context)
    before = database.snapshot()
    assert_error(lambda: database.service.execute(database.context(viewer), database.command('add', copied,
        album_refs=[database.album_refs[1]]), constraints=constraints), 'album_outside_artist_scope', 409)
    assert observed and set(observed) == {viewer.account_id}
    assert database.snapshot() == before


def test_session_expiry_after_real_receipt_insert_rolls_back_scoped_create(scoped_db, monkeypatch):
    from datetime import timedelta
    database = scoped_db
    original = database.service._insert_operation
    observed = []
    def inserted(connection, live, command, receipt, required_actions):
        result = original(connection, live, command, receipt, required_actions)
        observed.append(receipt['top_ref'])
        # Advance only the injected existing clock beyond the actual persisted
        # session bounds; no fabricated live actor/session or database result.
        monkeypatch.setattr(database.service, '_clock', lambda: database.now + timedelta(days=2))
        return result
    monkeypatch.setattr(database.service, '_insert_operation', inserted)
    before = database.snapshot()
    assert_error(lambda: create(database), 'forbidden', 403)
    assert len(observed) == 1 and database.snapshot() == before


def test_stale_revision_and_actual_top_denial_still_precede_membership_writes(scoped_db):
    database = scoped_db
    first, _ = create(database)
    latest = database.service.execute(database.context(), database.command('save', first, title='Revision two'))
    before = database.snapshot()
    assert_error(lambda: database.service.execute(database.context(), database.command('add', first,
        album_refs=[database.album_refs[2]])), 'revision_conflict', 409)
    assert_error(lambda: database.service.execute(database.context(), database.command('save', latest, title='Denied'),
        constraints=deny('album_top', latest['top_ref'])), 'forbidden', 403)
    assert database.snapshot() == before


@pytest.mark.parametrize('identity,mode', [(None, 'artist'), (1, None), (0, 'artist'),
                                          (-1, 'family'), (1, 'all'), (1, '')])
def test_persisted_descriptor_pair_is_database_constrained(scoped_db, identity, mode):
    from psycopg.errors import CheckViolation
    database = scoped_db
    receipt, _ = create(database, refs=[])
    with database.connect() as con:
        with pytest.raises(CheckViolation):
            with con.transaction():
                con.execute('''update app.album_lists set listen_through_artist_id=%s,
                    listen_through_scope_mode=%s where ref=%s''', (identity, mode, receipt['top_ref']))
    assert database.read(receipt)['artist_scope'] == descriptor(database)
