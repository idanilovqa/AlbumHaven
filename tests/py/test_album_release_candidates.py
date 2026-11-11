import json
from pathlib import Path

import pytest

from music_app.services.album_release_candidates import (
    _manual_family_keys, _release_candidates_sql, load_release_candidates, normalize_release_base_title,
)


VECTORS = json.loads((Path(__file__).parents[1] / 'fixtures' / 'album-release-base-titles.json').read_text(encoding='utf-8'))


@pytest.mark.parametrize('title,expected', VECTORS)
def test_release_title_normalization_matches_client_contract(title, expected):
    assert normalize_release_base_title(title) == expected


def test_explicit_manual_family_includes_ancestors_siblings_and_cycles_without_inventory_walk():
    assert _manual_family_keys('child', {'child': 'parent', 'sibling': 'parent', 'unrelated': 'other'}) == ['child', 'parent', 'sibling']
    assert _manual_family_keys('one', {'one': 'two', 'two': 'one'}) == ['one', 'two']


def test_release_candidates_query_is_owner_title_and_explicit_link_scoped():
    sql = _release_candidates_sql()
    assert 'albums.artist_id=selected_album.artist_id' in sql
    assert 'starts_with(' in sql
    assert 'albums.album_key=any(%(manual_keys)s::text[])' in sql
    assert 'tracks.album_id=albums.id' in sql
    assert 'local_track_files' not in sql
    assert 'select tracks.' not in sql
    assert 'bootstrap_context.library_id=albums.library_id' in sql


def test_release_candidate_headers_keep_versions_lightweight_and_manual_links_complete():
    class Cursor:
        def fetchall(self):
            return [{'album_id': 11, 'key': 'artist::album', 'name': 'Album', 'album_artist': 'Artist', 'year': 1985,
                     'private_path': 'must not escape', 'tracks': [{'path': 'must not escape'}]}]

    class Titles:
        def fetchall(self):
            return []

    class Connection:
        def execute(self, sql, params):
            if 'local_tracks where album_id' in sql:
                return Titles()
            assert sql == _release_candidates_sql()
            assert params == {'album_id': 12, 'album_key': 'artist::album deluxe', 'base_title': 'album',
                              'manual_keys': ['artist::album deluxe', 'other::manual parent']}
            return Cursor()

    result = load_release_candidates(Connection(), {
        'album_id': 12, 'key': 'artist::album deluxe', 'name': 'Album (Deluxe Edition)',
    }, {'manual_version_links': {'artist::album deluxe': 'other::manual parent', 'unrelated': 'other'},
        'ignored_version_keys': ['artist::album', 'unrelated']})
    assert result['release_candidate_family_keys'] == ['artist::album deluxe', 'other::manual parent']
    assert result['release_candidate_rules'] == {
        'manual_version_links': {'artist::album deluxe': 'other::manual parent'},
        'ignored_version_keys': ['artist::album'],
    }
    result = result['release_candidates']
    assert result[0]['key'] == 'artist::album'
    assert result[0]['preview_only'] is True
    assert result[0]['tracks'] == []
    assert 'private_path' not in result[0]


def test_candidates_preserve_virtual_year_releases_already_resolved_from_selected_identity():
    class Cursor:
        def fetchall(self):
            return [{'album_id': 10, 'key': 'artist::album', 'name': 'Album', 'album_artist': 'Artist', 'year': 1985}]

    class Connection:
        def execute(self, _sql, _params):
            return Cursor()

    releases = [{'key': f'artist::album::year::{year}', 'name': 'Album', 'album_artist': 'Artist', 'year': year}
                for year in (1985, 2021)]
    result = load_release_candidates(Connection(), {'album_id': 10, **releases[0]}, {}, resolved_releases=releases)
    assert [release['key'] for release in result['release_candidates']] == [release['key'] for release in releases]
    assert {release['album_id'] for release in result['release_candidates']} == {10}


def test_same_name_albums_are_versions_only_when_they_share_half_their_tracks():
    from music_app.services.album_release_candidates import tracklists_share_half

    class Rows:
        def __init__(self, rows):
            self.rows = rows

        def fetchall(self):
            return self.rows

    titles = {1: ['Murderer', 'Warrior', 'Victim of Fate', 'Cry for Freedom', 'Starlight'],
              2: ['Out for the Glory', 'Fear of the Fallen', 'Best Time', 'Mass Pollution'],
              3: ['Starlight', 'Murderer (Remastered)', 'Warrior', 'Victim of Fate', 'Bonus']}

    class Connection:
        def execute(self, sql, params):
            if 'local_tracks where album_id' in sql:
                return Rows([{'album_id': album_id, 'title': title} for album_id in params['ids'] for title in titles[album_id]])
            return Rows([{'album_id': 1, 'key': 'helloween::1985', 'name': 'Helloween', 'year': 1985},
                         {'album_id': 2, 'key': 'helloween::2021', 'name': 'Helloween', 'year': 2021},
                         {'album_id': 3, 'key': 'helloween::2006', 'name': 'Helloween (Remastered 2006)', 'year': 2006}])

    result = load_release_candidates(Connection(), {'album_id': 1, 'key': 'helloween::1985', 'name': 'Helloween'}, {})
    assert {release['key']: release['shares_tracks'] for release in result['release_candidates']} == {
        'helloween::1985': True, 'helloween::2021': False, 'helloween::2006': True}
    assert tracklists_share_half(['A', 'B'], ['a!', 'C (Live)', 'D']) is True
    assert tracklists_share_half([], ['A']) is False
