"""Independent contract-first command coverage; no persistence or discovery mocks."""
from copy import deepcopy

import pytest

from music_app.services.owned_album_tops import AlbumTopError, command_actions, normalize_top_command

REQUEST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
TOP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
ALBUM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
ITEM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'


def create(**changes):
    return {'request_key': REQUEST, 'title': ' Artist collection ', 'album_refs': [ALBUM], **changes}


def invalid(payload, *, action='create'):
    with pytest.raises(AlbumTopError) as caught:
        normalize_top_command(action, payload, top_ref=None if action == 'create' else TOP)
    assert (caught.value.code, caught.value.status_code) == ('invalid_command', 422)


@pytest.mark.parametrize('mode', ['artist', 'family'])
@pytest.mark.parametrize('identity', ['1', '9223372036854775807'])
def test_scope_is_explicit_detached_create_metadata_with_existing_capabilities(mode, identity):
    scope = {'root_artist_id': identity, 'mode': mode}
    payload = create(artist_scope=scope)
    command = normalize_top_command('create', payload)
    assert command.data == {'title': 'Artist collection', 'description': '',
                            'album_refs': [ALBUM], 'artist_scope': scope}
    assert set(command_actions(command)) == {'library.browse.read', 'library.album_tops.create'}
    before, digest = deepcopy(command.data), command.digest
    scope['mode'] = 'family' if mode == 'artist' else 'artist'
    scope['root_artist_id'] = '7'
    payload['album_refs'].clear()
    assert command.data == before and command.digest == digest


@pytest.mark.parametrize('identity', [None, True, False, 1, 1.0, '', '0', '-1', '+1', '01',
    ' 1', '1 ', '1\n', '1.0', '١', '１', '9223372036854775808', '9' * 1000, [], {}])
def test_scope_requires_canonical_positive_bigint_string(identity):
    invalid(create(artist_scope={'root_artist_id': identity, 'mode': 'artist'}))


@pytest.mark.parametrize('scope', [None, True, [], 'artist', {}, {'root_artist_id': '1'},
    {'mode': 'artist'}, {'root_artist_id': '1', 'mode': 'artist', 'name': 'Untrusted'},
    {'root_artist_id': '1', 'mode': None}, {'root_artist_id': '1', 'mode': True},
    {'root_artist_id': '1', 'mode': 'Artist'}, {'root_artist_id': '1', 'mode': 'family '},
    {'root_artist_id': '1', 'mode': 'all'}])
def test_scope_shape_and_mode_are_exact(scope):
    invalid(create(artist_scope=scope))


def test_ordinary_create_retains_exact_shape_and_scope_changes_operation_digest():
    ordinary = normalize_top_command('create', create())
    assert ordinary.data == {'title': 'Artist collection', 'description': '', 'album_refs': [ALBUM]}
    artist = normalize_top_command('create', create(artist_scope={'root_artist_id': '1', 'mode': 'artist'}))
    family = normalize_top_command('create', create(artist_scope={'root_artist_id': '1', 'mode': 'family'}))
    other = normalize_top_command('create', create(artist_scope={'root_artist_id': '2', 'mode': 'artist'}))
    assert len({ordinary.digest, artist.digest, family.digest, other.digest}) == 4


@pytest.mark.parametrize('mode', ['artist', 'family'])
def test_scoped_typed_local_catalog_create_is_supported_without_remote_selection(mode):
    payload = {'request_key': REQUEST, 'title': 'Local', 'draft_ref': TOP,
               'selections': [{'kind': 'local_catalog', 'album_ref': ALBUM}],
               'artist_scope': {'root_artist_id': '1', 'mode': mode}}
    command = normalize_top_command('create', payload)
    assert command.data['selections'] == payload['selections']
    assert command.data['artist_scope'] == payload['artist_scope']
    assert command.data['draft_ref'] == TOP
    assert 'album_refs' not in command.data


@pytest.mark.parametrize('extra', [
    {'playlist_preview_ref': REQUEST},
    {'source_review': {'job_ref': REQUEST, 'revision': '1',
                      'rows': [{'row_ref': '1', 'selection': None}]}},
])
def test_scope_cannot_be_combined_with_other_creation_origins(extra):
    # Positive control ensures each competing origin is independently legal.
    base = {'request_key': REQUEST, 'title': 'Imported', **deepcopy(extra)}
    normalize_top_command('create', base)
    invalid({**base, 'artist_scope': {'root_artist_id': '1', 'mode': 'artist'}})


@pytest.mark.parametrize('action,changes', [
    ('save', {'title': 'Renamed'}), ('copy', {}), ('unlock_source', {}),
    ('add', {'album_refs': [ALBUM]}), ('remove', {'item_refs': [ITEM]}),
    ('reorder', {'item_order': [ITEM]}), ('delete', {}),
    ('enable_external', {'evidence_revision': 'a' * 64}),
])
@pytest.mark.parametrize('value', [None, {'root_artist_id': '1', 'mode': 'artist'}])
def test_saved_scope_cannot_be_replaced_or_removed_by_any_mutation(action, changes, value):
    base = {'request_key': REQUEST, 'revision': '1', **changes}
    normalize_top_command(action, base, top_ref=TOP)
    invalid({**base, 'artist_scope': value}, action=action)
