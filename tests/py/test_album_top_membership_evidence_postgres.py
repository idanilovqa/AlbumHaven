"""Additional live SQL assertions. Retained opaque evidence is never invented into a publication."""
from contextlib import contextmanager
from uuid import uuid4

from tests.py.test_album_top_collaboration_postgres import member, write
from tests.py.test_owned_album_tops_postgres import assert_error
from tests.py.test_album_top_membership_postgres import db, urls, search


def test_retained_unresolved_binding_rejects_membership_save_without_mutation_or_viewer_exposure(db):
    top, _ = db.create()
    first = db.read(top)['items'][0]
    source_ref = str(uuid4())
    # A retained selection can outlive its source metadata. Keep that opaque
    # evidence, but do not claim it is currently eligible for publication.
    with db.connect() as connection:
        connection.execute('''insert into app.album_list_item_publication_sources
            (top_ref,item_ref,library_id,catalog_ref,selected_local_album_id,selected_source_ref)
            values(%s,%s,%s,%s,%s,%s)''', (top['top_ref'], first['ref'], db.library,
            first['catalog_ref'], db.album_ids[0], source_ref))
    owner = db.read(top)
    assert owner['edit_draft']['items'][0] == {'item_ref': first['ref'], 'album_ref': first['catalog_ref'],
        'selected_local_album_id': db.album_ids[0], 'selected_source_ref': source_ref}
    before = db.snapshot()
    command = db.command('save', top, title='Must not rename', items=owner['edit_draft']['items'])
    assert_error(lambda: db.service.execute(db.context(), command), 'evidence_unavailable', 409)
    assert db.snapshot() == before
    assert db.read(top)['edit_draft'] == owner['edit_draft']
    viewer = member(db)
    shared, _ = write(db, 'visibility', top, visibility='server_shared')
    viewed = db.service.read(db.context(viewer), top_ref=top['top_ref'])
    assert 'edit_draft' not in viewed
    assert source_ref not in str(viewed) and 'selected_local_album_id' not in str(viewed)


def test_private_title_only_omission_preserves_retained_binding_without_submitting_membership(db):
    top, _ = db.create()
    first = db.read(top)['items'][0]
    source_ref = str(uuid4())
    with db.connect() as connection:
        connection.execute('''insert into app.album_list_item_publication_sources
            (top_ref,item_ref,library_id,catalog_ref,selected_local_album_id,selected_source_ref)
            values(%s,%s,%s,%s,%s,%s)''', (top['top_ref'], first['ref'], db.library,
            first['catalog_ref'], db.album_ids[0], source_ref))
    owner = db.read(top)
    renamed, command = write(db, 'save', top, title='Metadata-only rename')
    assert 'items' not in command.data
    result = db.read(renamed)
    assert result['title'] == 'Metadata-only rename'
    assert result['edit_draft'] == owner['edit_draft']
    assert result['items'] == owner['items']


def test_preview_checks_owner_and_revision_without_durable_side_effects(db):
    top, _ = db.create(refs=[])
    before = db.snapshot()
    preview = db.service.publication_preview(db.context(), top_ref=top['top_ref'], payload={'revision': top['revision'], 'items': []})
    assert preview['top_ref'] == top['top_ref'] and preview['revision'] == top['revision']
    assert len(preview['evidence_revision']) == 64 and set(preview['evidence_revision']) <= set('0123456789abcdef')
    assert preview['items'] == [] and db.snapshot() == before
    editor = member(db)
    granted, _ = write(db, 'grant_editor', top, account_id=editor.account_id, role='editor')
    before = db.snapshot()
    assert_error(lambda: db.service.publication_preview(db.context(editor), top_ref=top['top_ref'],
        payload={'revision': granted['revision'], 'items': []}), 'forbidden', 403)
    assert_error(lambda: db.service.publication_preview(db.context(), top_ref=top['top_ref'],
        payload={'revision': top['revision'], 'items': []}), 'revision_conflict', 409)
    assert db.snapshot() == before


def test_search_never_reads_tracks_and_blank_search_never_traverses_inventory(db, monkeypatch):
    original_connect = db.service._connect
    statements = []
    class ObservedConnection:
        def __init__(self, connection): self.connection = connection
        def execute(self, statement, *args, **kwargs):
            statements.append(str(statement).lower())
            return self.connection.execute(statement, *args, **kwargs)
        def __getattr__(self, name): return getattr(self.connection, name)
    @contextmanager
    def connect(*args, **kwargs):
        with original_connect(*args, **kwargs) as connection:
            yield ObservedConnection(connection)
    monkeypatch.setattr(db.service, '_connect', connect)
    assert search(db, query='   ') == {'albums': [], 'next_cursor': None}
    assert not any('library.local_albums' in sql or 'library.local_artists' in sql for sql in statements)
    statements.clear()
    assert search(db, query='Literal')['albums']
    assert not any('library.local_tracks' in sql or 'library.local_track_files' in sql for sql in statements)
