"""Release candidate authority must not depend on the current gallery page."""
import os
from uuid import uuid4

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_postgres_structural_tag_edit import _isolated_runtime_database_url_or_skip


def test_release_candidates_are_symmetric_and_exclude_empty_historical_identity():
    import psycopg
    from psycopg.rows import dict_row
    from music_app.services.album_release_candidates import load_release_candidates

    database_url = _isolated_runtime_database_url_or_skip()
    setup_url = os.environ.get('ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL', '')
    if not setup_url:
        pytest.skip('An isolated migrator URL is required.')
    isolatedPostgres.prepare_isolated_database(setup_url, database_url)
    token = uuid4().hex
    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        try:
            library_id = connection.execute("""select libraries.id from app.bootstrap_owners owners
                join library.libraries on libraries.owner_account_id=owners.account_id
                where owners.owner_key='local-bootstrap-owner' and libraries.name='Local Library'
                  and libraries.library_kind='local'""").fetchone()['id']
            artists = [connection.execute("""insert into library.local_artists(library_id,artist_key,name)
                values(%s,%s,%s) returning id""", (library_id, f'{token}-{n}', f'Candidate Artist {token}-{n}')).fetchone()['id'] for n in range(2)]
            releases = []
            specs = [(0, 'Symmetry Album', 1985, True), (0, 'Symmetry Album', 2021, True),
                     (0, 'Symmetry Album (Deluxe Edition)', 2021, True),
                     (0, 'Symmetry Album', 1984, False), (1, 'Symmetry Album', 2020, True),
                     (1, 'Manual Bonus Disc', 2022, True), (0, 'Unrelated Album', 2020, True)]
            for index, (artist, title, year, populated) in enumerate(specs):
                key = f'{token}::{index}'
                album_id = connection.execute("""insert into library.local_albums(library_id,artist_id,album_key,title,release_year)
                    values(%s,%s,%s,%s,%s) returning id""", (library_id, artists[artist], key, title, year)).fetchone()['id']
                if populated:
                    connection.execute("""insert into library.local_tracks(library_id,album_id,artist_id,track_key,title)
                        values(%s,%s,%s,%s,'Track')""", (library_id, album_id, artists[artist], f'{token}-track-{index}'))
                releases.append({'album_id': album_id, 'key': key, 'name': title})
            expected = {release['key'] for release in releases[:3]}
            for selected in releases[:3]:
                result = load_release_candidates(connection, selected, {})
                assert {release['key'] for release in result['release_candidates']} == expected
                assert all(release['tracks'] == [] and release['preview_only'] for release in result['release_candidates'])
            linked = load_release_candidates(connection, releases[0], {
                'manual_version_links': {releases[5]['key']: releases[0]['key']}})
            assert {release['key'] for release in linked['release_candidates']} == expected | {releases[5]['key']}
            assert releases[3]['key'] not in expected
        finally:
            connection.rollback()
