"""Explicit source review normalization and shared structure-lock contracts."""
from uuid import uuid4
import pytest

from music_app.services.owned_album_tops import AlbumTopError, normalize_top_command, command_actions
from music_app.services.album_top_source_finalization import normalize_review, selections, require_same_structure
from music_app.services.album_top_remote_membership import typed_command, pending_selectors


def review():
    return {'job_ref': str(uuid4()), 'revision': '3', 'rows': [
        {'row_ref': '1', 'selection': {'kind': 'local_catalog', 'album_ref': str(uuid4())}},
        {'row_ref': '2', 'selection': None}]}


def test_source_review_is_exact_explicit_and_has_one_save_identity():
    value = review()
    command = normalize_top_command('create', {'request_key': value['job_ref'], 'title': 'Source',
        'source_review': value})
    assert command.data['source_review'] == value
    assert typed_command(command) and pending_selectors(command) == []
    assert command_actions(command) == ('library.browse.read', 'library.album_tops.create')
    for extra in ({'request_key': str(uuid4())}, {'album_refs': []}, {'draft_ref': str(uuid4())}):
        with pytest.raises(AlbumTopError):
            normalize_top_command('create', {'request_key': value['job_ref'], 'title': 'Source',
                'source_review': value, **extra})


@pytest.mark.parametrize('field,value', [('job_ref', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'),
    ('revision', '3\n'), ('revision', '9223372036854775808'), ('rows', [])])
def test_review_rejects_noncanonical_scalars(field, value):
    data = review()
    data[field] = value
    with pytest.raises(AlbumTopError):
        normalize_review(data)


@pytest.mark.parametrize('row_ref', ['01', '1\n', '5001', 1, True])
def test_review_row_identity_is_bounded_exact_text(row_ref):
    data = review()
    data['rows'][0]['row_ref'] = row_ref
    with pytest.raises(AlbumTopError):
        normalize_review(data)


def test_duplicate_source_matches_are_retained_until_canonical_resolution():
    data = review()
    data['rows'][1]['selection'] = dict(data['rows'][0]['selection'])
    normalized = normalize_review(data)
    assert len(normalized['rows']) == 2 and len(selections(normalized)) == 1
    data['rows'][1]['row_ref'] = '1'
    with pytest.raises(AlbumTopError):
        normalize_review(data)


def test_shared_lock_allows_metadata_source_choice_but_not_membership_or_order():
    a, b, ca, cb = (str(uuid4()) for _ in range(4))
    current = [{'ref': a, 'catalog_ref': ca}, {'ref': b, 'catalog_ref': cb}]
    unchanged = [{'item_ref': a, 'album_ref': ca, 'selected_source_ref': str(uuid4())},
                 {'item_ref': b, 'album_ref': cb}]
    require_same_structure({'source_locked': True}, unchanged, current)
    for changed in (unchanged[::-1], unchanged[:1], [{**unchanged[0], 'album_ref': cb}, unchanged[1]],
                    [{**unchanged[0], 'item_ref': None}, unchanged[1]]):
        with pytest.raises(AlbumTopError) as error:
            require_same_structure({'source_locked': True}, changed, current)
        assert error.value.code == 'source_locked'
        require_same_structure({'source_locked': False}, changed, current)


def test_unlock_is_revisioned_existing_manage_authority():
    command = normalize_top_command('unlock_source', {'request_key': str(uuid4()), 'revision': '2'},
                                    top_ref=str(uuid4()))
    assert command_actions(command) == ('library.browse.read', 'library.album_tops.manage')
