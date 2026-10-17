"""Real PostgreSQL only. Requires root's admitted configuration and migrations.

Each mutating case owns a fresh library/account. Current intrinsic personal
permissions are derived from capability.view; no retired Album Top grants are
seeded and no database/config substitute is installed.
"""
from dataclasses import replace
import json
from uuid import uuid4

import pytest

from music_app.services.current_actor import CapabilityGrant, LibraryRelationship
from music_app.services.owned_album_tops import BROWSE, AlbumTopError, normalize_top_command
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_owned_album_tops_postgres import Database, urls, assert_error, CURSOR_SECRET
from tests.py.test_album_top_collaboration_postgres import member, new_session, write


@pytest.fixture
def db(urls):
    database = Database(urls)
    try:
        with database.connect() as connection:
            owner = database.actor(connection)
            database.library = database.library_for(connection, owner)
            connection.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'member')", (owner.account_id, database.library))
            connection.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,'capability.view','library',%s)", (owner.account_id, database.library))
            database.owner = replace(owner, current_library_id=database.library,
                library_relationships=(LibraryRelationship(database.library, 'member', False),),
                capability_grants=(CapabilityGrant('capability.view', 'library', database.library),))
            artist = connection.execute("insert into library.local_artists(library_id,artist_key,name) values(%s,%s,'Synthetic catalog artist') returning id", (database.library, database.token)).fetchone()['id']
            for index, title in enumerate(['Literal %_ Album', 'Literal %_ Edition', 'Literal wildcard decoy']):
                album_id = connection.execute("""insert into library.local_albums(library_id,artist_id,album_key,title,release_year,metadata)
                    values(%s,%s,%s,%s,2001,'{}'::jsonb) returning id""", (database.library, artist, f'{database.token}:{index}', title)).fetchone()['id']
                database.album_ids.append(album_id)
        for album_id in database.album_ids:
            result = database.service.admit_inventory_album(database.context(), album_id=album_id)
            database.album_refs.append(result['album_ref'])
        yield database
    finally:
        database.close()


def search(db, *, actor=None, **options):
    return db.service.search_inventory_albums(db.context(actor), cursor_secret=CURSOR_SECRET, **options)


def test_literal_keyset_search_is_safe_metadata_only_and_does_not_mutate(db):
    before = db.snapshot()
    first = search(db, query='Literal %_', limit=1)
    second = search(db, query='Literal %_', limit=1, cursor=first['next_cursor'])
    assert first['next_cursor'] and second['next_cursor'] is None
    assert [row['local_album_id'] for page in [first, second] for row in page['albums']] == db.album_ids[:2]
    assert [row['album_ref'] for page in [first, second] for row in page['albums']] == db.album_refs[:2]
    for page in [first, second]:
        for row in page['albums']:
            assert set(row) == {'local_album_id', 'album_ref', 'title', 'artist', 'year'}
            assert row['artist'] == 'Synthetic catalog artist' and row['year'] == 2001
    assert search(db, query='   ') == {'albums': [], 'next_cursor': None}
    assert db.snapshot() == before


@pytest.mark.parametrize('scope', ['query', 'session', 'top', 'purpose', 'tamper'])
def test_search_cursor_binds_actor_session_query_purpose_and_target(db, scope):
    top, _ = db.create()
    other, _ = db.create()
    first = search(db, query='Literal', limit=1, top_ref=top['top_ref'])
    assert first['next_cursor']
    options = {'query': 'Literal', 'limit': 1, 'top_ref': top['top_ref'], 'cursor': first['next_cursor']}
    actor = db.owner
    if scope == 'query': options['query'] = 'different'
    elif scope == 'session': actor = new_session(db, actor)
    elif scope == 'top': options['top_ref'] = other['top_ref']
    elif scope == 'purpose': del options['top_ref']
    else: options['cursor'] = ('A' if options['cursor'][0] != 'A' else 'B') + options['cursor'][1:]
    assert_error(lambda: search(db, actor=actor, **options), 'invalid_cursor', 422)


def test_per_album_denial_never_exposes_metadata_and_continuation_can_cross_filtered_rows(db):
    def constraints(context):
        resource = context.resource
        return PolicyEvaluationConstraints(request_origin_allowed=not (context.action == BROWSE and resource
            and resource.resource_kind == 'album' and resource.resource_ref == str(db.album_ids[0])))
    first = search(db, query='Literal', limit=1, constraints=constraints)
    assert first['albums'] == [] and first['next_cursor']
    second = search(db, query='Literal', limit=1, cursor=first['next_cursor'], constraints=constraints)
    assert [row['local_album_id'] for row in second['albums']] == [db.album_ids[1]]


def test_editor_admission_is_bound_to_current_top_without_a_create_grant(db):
    editor = member(db)
    top, _ = db.create()
    granted, _ = write(db, 'grant_editor', top, account_id=editor.account_id, role='editor')
    before = db.snapshot()
    assert search(db, actor=editor, query='Literal', top_ref=top['top_ref'])['albums']
    assert db.service.admit_inventory_album(db.context(editor), album_id=db.album_ids[2], top_ref=top['top_ref']) == {'album_ref': db.album_refs[2]}
    assert db.snapshot() == before
    revoked, _ = write(db, 'revoke_editor', granted, grant_ref=granted['grant_ref'])
    with pytest.raises(AlbumTopError) as caught:
        search(db, actor=editor, query='Literal', top_ref=top['top_ref'])
    assert caught.value.status_code in (403, 404)
    before = db.snapshot()
    with pytest.raises(AlbumTopError):
        db.service.admit_inventory_album(db.context(editor), album_id=db.album_ids[2], top_ref=top['top_ref'])
    assert db.snapshot() == before


def test_editor_gets_exact_ordered_draft_projection_while_viewer_gets_no_edit_evidence(db):
    viewer = member(db)
    top, _ = db.create()
    shared, _ = write(db, 'visibility', top, visibility='server_shared')
    owner = db.read(shared)
    assert owner['edit_draft'] == {'items': [{'item_ref': row['ref'], 'album_ref': row['catalog_ref']} for row in owner['items']], 'publication_preview_required': False}
    viewed = db.service.read(db.context(viewer), top_ref=top['top_ref'])
    assert 'edit_draft' not in viewed
    granted, _ = write(db, 'grant_editor', shared, account_id=viewer.account_id, role='editor')
    edited = db.service.read(db.context(viewer), top_ref=top['top_ref'])
    assert edited['edit_draft'] == owner['edit_draft']


def test_atomic_save_retains_nonlocal_identity_and_original_positions_with_one_revision_and_receipt(db):
    top, _ = db.create()
    before = db.read(top)
    first, second = before['items']
    with db.connect() as connection:
        connection.execute('delete from library.catalog_album_links where library_id=%s and local_album_id=%s', (db.library, db.album_ids[1]))
    command = db.command('save', top, title='One atomic edit', description='Updated subtitle', items=[
        {'item_ref': second['ref'], 'album_ref': second['catalog_ref']},
        {'item_ref': None, 'album_ref': db.album_refs[2]},
        {'item_ref': first['ref'], 'album_ref': first['catalog_ref']},
    ])
    receipt = db.service.execute(db.context(), command)
    after = db.read(receipt)
    assert after['title'] == 'One atomic edit' and after['description'] == 'Updated subtitle'
    assert after['revision'] == str(int(top['revision']) + 1)
    assert [row['catalog_ref'] for row in after['items']] == [db.album_refs[1], db.album_refs[2], db.album_refs[0]]
    assert [row['original_position'] for row in after['items']] == [second['original_position'], 3, first['original_position']]
    assert after['items'][0]['ref'] == second['ref'] and after['items'][2]['ref'] == first['ref']
    accepted = db.snapshot()
    assert db.service.execute(db.context(), command) == receipt
    assert db.snapshot() == accepted


def test_invalid_new_identity_and_revision_conflict_roll_back_every_part_of_save(db):
    top, _ = db.create()
    before = db.snapshot()
    command = db.command('save', top, title='Must roll back', description='Must roll back', items=[{'item_ref': None, 'album_ref': str(uuid4())}])
    assert_error(lambda: db.service.execute(db.context(), command), 'album_unavailable', 409)
    assert db.snapshot() == before
    saved, _ = write(db, 'save', top, title='Intervening owner edit')
    before = db.snapshot()
    command = db.command('save', top, title='Stale replacement', items=[])
    assert_error(lambda: db.service.execute(db.context(), command), 'revision_conflict', 409)
    assert db.snapshot() == before
