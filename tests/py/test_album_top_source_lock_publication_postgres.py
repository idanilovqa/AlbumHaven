"""The genuine artwork publication owner obeys structure locks, not a broad edit ban."""
import pytest

from music_app.services.owned_album_tops import AlbumTopError
from tests.py.test_top_artwork_publication_postgres import (
    c2_case, publication_case, db, urls, runtime, ready, review_command, execute,
    durable_snapshot, draft_command,
)


def locked(case):
    # Complete isolated fixture setup for a source-derived catalog-only Copy.
    # No fake review, proof, publication result or product configuration branch.
    with case.db.connect() as connection:
        connection.execute('update app.album_lists set source_derived=true,source_locked=true where ref=%s',
                           (case.top['top_ref'],))
    return case


def test_locked_top_allows_actual_unchanged_artwork_publication_and_metadata(c2_case):
    case = locked(c2_case.build(2, excluded=range(2)))
    before = case.db.read(case.top)
    state, payload = ready(case, 'saved')
    _, command = review_command(case, state, 'saved', payload)
    receipt = execute(case, command)
    after = case.db.read(receipt)
    assert receipt['publication']['state'] == 'enabled'
    assert after['source_locked'] and after['source_derived']
    assert [(row['ref'], row['catalog_ref'], row['original_position']) for row in after['items']] == [
        (row['ref'], row['catalog_ref'], row['original_position']) for row in before['items']]
    assert after['title'] == command.data['title']


def test_locked_top_rejects_reordered_membership_inside_actual_artwork_publication(c2_case):
    case = locked(c2_case.build(2, excluded=range(2)))
    state, payload = ready(case, 'draft', payload=draft_command(case, order=(1, 0)))
    _, command = review_command(case, state, 'draft', payload)
    before = durable_snapshot(case)
    with pytest.raises(AlbumTopError) as error:
        execute(case, command)
    assert error.value.code == 'source_locked'
    assert durable_snapshot(case) == before
    assert case.db.read(case.top)['source_locked']
