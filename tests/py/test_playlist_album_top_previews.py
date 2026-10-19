"""Conversion selection and command contracts; no application startup required."""
from uuid import uuid4

import pytest

from music_app.services.owned_album_tops import AlbumTopError, normalize_top_command
from music_app.services.playlist_album_top_previews import ordered_snapshot
from music_app.services.private_route_boundary import csrf_mode_for_route, private_action_for_route


def row(position, album, **changes):
    return {'ref': str(uuid4()), 'position': position, 'local_track_id': position, 'original_local_track_id': position,
            'track_id': position, 'album_id': position, 'catalog_ref': album,
            'title': 'Same display name', 'artist_display': 'Same artist', 'release_year': 2000,
            **changes}


def test_first_source_order_and_canonical_dedupe_do_not_use_display_names():
    first, second = str(uuid4()), str(uuid4())
    rows = [row(1, second), row(2, first), row(3, second),
            row(4, None), row(5, None, local_track_id=None, original_local_track_id=None), row(6, first)]
    result = ordered_snapshot(rows, readable=lambda kind, identity: identity != 6)
    assert [album['album_ref'] for album in result['albums']] == [second, first]
    assert [item['reason'] for item in result['report']] == [
        'included', 'included', 'duplicate', 'unresolved', 'unsupported', 'unavailable']
    assert [item['playlist_item_ref'] for item in result['report']] == [item['ref'] for item in rows]
    assert all(set(item) == {'playlist_item_ref', 'position', 'reason'} for item in result['report'])
    assert all('local_track_id' not in item for item in result['albums'])


@pytest.mark.parametrize('rows,code', [([], 'playlist_empty'), ([{}] * 5001, 'playlist_too_large')])
def test_empty_and_oversized_sources_fail_without_partial_selection(rows, code):
    with pytest.raises(AlbumTopError, match=code):
        ordered_snapshot(rows, readable=lambda *_: True)


def test_preview_save_has_one_idempotency_identity_and_no_client_membership():
    ref = str(uuid4())
    payload = {'request_key': ref, 'playlist_preview_ref': ref, 'title': 'Preview', 'description': ''}
    command = normalize_top_command('create', payload)
    assert command.data == {'playlist_preview_ref': ref, 'title': 'Preview', 'description': ''}
    assert normalize_top_command('create', payload).digest == command.digest
    for extra in ({'request_key': str(uuid4())}, {'album_refs': []}, {'selections': []}, {'draft_ref': str(uuid4())}):
        with pytest.raises(AlbumTopError, match='invalid_command'):
            normalize_top_command('create', {**payload, **extra})


def test_preview_routes_reuse_existing_authority_and_require_csrf():
    for method, route, action in [
        ('POST', '/album-tops/playlist-previews/{playlist_ref}', 'library.album_tops.create'),
        ('DELETE', '/album-tops/playlist-previews/{preview_ref}', 'library.browse.read'),
    ]:
        assert private_action_for_route(method, route) == action
        assert csrf_mode_for_route(method, route) == 'session_header'
