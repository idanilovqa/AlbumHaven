"""Existing unsupported remote publication boundaries stay closed for scoped Tops."""
from uuid import uuid4
import pytest
from music_app.services.album_top_artwork_draft import normalize as normalize_artwork_draft
from tests.py.remote_top_postgres_support import remote, db, urls
from tests.py.remote_top_retention_postgres_support import retained
from tests.py.test_album_top_remote_membership_postgres import mixed, pending
from tests.py.test_album_top_owner_publication_postgres import configured, enable, sharing
from tests.py.test_album_top_remote_artist_scope_postgres import artist_remote, scoped_command, acquire, create
from tests.py.test_owned_album_tops_postgres import assert_error


def test_scoped_remote_metadata_preview_cannot_introduce_typed_remote_payload(artist_remote):
    case = artist_remote
    command, _ = scoped_command(case)
    top = case.execute(command)
    draft = case.read(top)['edit_draft']['item_selections']
    before = case.snapshot()
    assert_error(lambda: case.db.service.publication_preview(case.db.context(), top_ref=top['top_ref'],
        payload={'revision': top['revision'], 'item_selections': draft}), 'invalid_command', 422)
    assert case.snapshot() == before


@pytest.mark.parametrize('kind', ['remote_acquisition', 'remote_retained'])
def test_artwork_draft_normalizer_rejects_remote_selection_without_local_source(kind):
    source = {'kind': kind, 'evidence_version': 'a'*64,
        'acquisition_ref' if kind == 'remote_acquisition' else 'admission_ref': str(uuid4())}
    payload = {'revision': '1', 'request_key': str(uuid4()), 'request_generation': 1,
        'draft_ref': str(uuid4()), 'draft_revision': '1',
        'rows': [{'row_ref': str(uuid4()), 'include_artwork': True,
                  'selection': {'kind': 'new_remote', 'source': source}}]}
    assert_error(lambda: normalize_artwork_draft(payload), 'invalid_command', 422)


def test_scoped_remote_enable_external_remains_unavailable_atomically(artist_remote):
    case = artist_remote
    configured(case.db)
    command, _ = scoped_command(case)
    top = case.execute(command)
    before = case.snapshot()
    assert_error(lambda: case.execute(case.command('enable_external', top, evidence_revision='e'*64)),
        'remote_publication_unavailable', 409)
    assert case.snapshot() == before


def test_enabled_local_publication_does_not_silently_publish_scoped_remote_save(artist_remote):
    case = artist_remote
    configured(case.db)
    top, _ = create(case.db, refs=[])
    top, _ = enable(case.db, top)
    publication = sharing(case.db, top)['publication']
    source = acquire(case, top)
    top = case.execute(case.command('add', top, selections=[pending(source)]))
    before = case.snapshot()
    command = case.command('save', top, title='Must remain private',
        item_selections=case.read(top)['edit_draft']['item_selections'])
    assert_error(lambda: case.execute(command), 'remote_publication_unavailable', 409)
    assert case.snapshot() == before
    assert sharing(case.db, top)['publication'] == publication
