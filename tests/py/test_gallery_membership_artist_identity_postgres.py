"""Gallery membership patches keep one artist row per artist.

A watcher catch-up overlapping a repair-scan publication failed on sandbox2
with a gallery_membership_artists_pkey violation: the patch aggregated by
(artist_id, artist_sort) while the table is keyed by artist_id.
"""
import json
import os
import threading
from uuid import uuid4

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_postgres_structural_tag_edit import (
    _CommitSuppressingConnection,
    _isolated_runtime_database_url_or_skip,
)


def _seed_artist_with_two_albums():
    import psycopg
    from music_app.services import gallery_projection_postgres as gallery
    from music_app.services import scan_cache_persistence as persistence

    database_url = _isolated_runtime_database_url_or_skip()
    setup_url = os.environ.get('ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL', '')
    if not setup_url:
        pytest.skip('An isolated migrator URL is required.')
    isolatedPostgres.prepare_isolated_database(setup_url, database_url)
    config = {'ALBUM_HAVEN_APP_DATABASE_URL': database_url, 'SHARED_LIBRARY_BROWSE_ONLY': True}
    token = uuid4().hex
    with psycopg.connect(database_url) as connection:
        library_id = connection.execute("""select libraries.id from app.bootstrap_owners owners
            join library.libraries on libraries.owner_account_id=owners.account_id
            where owners.owner_key='local-bootstrap-owner' and libraries.name='Local Library'
              and libraries.library_kind='local'""").fetchone()[0]
        root_id = connection.execute("""insert into library.library_roots(library_id,root_path,root_kind)
            values(%s,%s,'main_library') returning id""", (library_id, f'C:/artist-identity/{token}')).fetchone()[0]
        artist_id = connection.execute("""insert into library.local_artists(library_id,artist_key,name)
            values(%s,%s,%s) returning id""", (library_id, token, f'Artist {token}')).fetchone()[0]
        album_keys = []
        for index in range(2):
            album_key = f'{token}::album {index}'
            album_id = connection.execute("""insert into library.local_albums(library_id,artist_id,album_key,title)
                values(%s,%s,%s,%s) returning id""", (library_id, artist_id, album_key, f'Album {index}')).fetchone()[0]
            connection.execute("""insert into library.local_album_featured_artists
                (library_id,album_id,artist_id,featured_kind) values(%s,%s,%s,'owner')""",
                (library_id, album_id, artist_id))
            track_id = connection.execute("""insert into library.local_tracks(library_id,album_id,artist_id,track_key,title)
                values(%s,%s,%s,%s,'Track') returning id""", (library_id, album_id, artist_id, f'{token}-{index}')).fetchone()[0]
            connection.execute("""insert into library.local_track_files(track_id,library_root_id,private_path,relative_path)
                values(%s,%s,%s,%s)""", (track_id, root_id, f'C:/artist-identity/{token}/{index}.flac', f'{index}.flac'))
            album_keys.append(album_key)
        persistence._commit_structural_relation_projection(
            _CommitSuppressingConnection(connection), config, reason='test_fixture')
        connection.commit()
    gallery.initialize_gallery_membership(config)
    return database_url, library_id, str(artist_id), album_keys


def _patch_arguments(connection, library_id, artist_id, album_key, artist_sort):
    header = connection.execute("""select headers.scope_key, headers.source_generation, headers.builder_version,
            headers.view_state, state.generation
        from library.gallery_membership_headers headers
        join library.gallery_projection_state state on state.library_id=headers.library_id
        where headers.library_id=%s and exists (
          select 1 from library.gallery_membership_entries entry
          where entry.library_id=headers.library_id and entry.scope_key=headers.scope_key
            and entry.artist_id=%s and entry.album_key=%s)
        order by headers.scope_key limit 1""", (library_id, artist_id, album_key)).fetchone()
    assert header is not None, 'the seeded album must have gallery membership'
    scope_key, source_generation, builder_version, view_state, generation = header
    rows = [{
        'artist_id': row[0], 'album_key': row[1], 'artist_sort': artist_sort,
        'artist_display': row[2], 'album_year': row[3], 'album_sort': row[4], 'payload': row[5],
    } for row in connection.execute("""select artist_id, album_key, artist_display, album_year, album_sort, payload
        from library.gallery_membership_entries
        where library_id=%s and scope_key=%s and album_key=%s order by artist_id""",
        (library_id, scope_key, album_key)).fetchall()]
    return scope_key, (
        library_id, scope_key, source_generation, generation, builder_version, uuid4().hex * 2,
        json.dumps(view_state), [album_key], json.dumps(rows),
    )


def _patch(connection, arguments):
    return connection.execute(
        """select library.patch_gallery_membership(%s,%s,%s,%s,%s,%s,%s::jsonb,%s::text[],%s::jsonb)""",
        arguments,
    ).fetchone()[0]


def _artist_rows(connection, library_id, scope_key, artist_id):
    return connection.execute("""select artist_sort, occurrence_count from library.gallery_membership_artists
        where library_id=%s and scope_key=%s and artist_id=%s""", (library_id, scope_key, artist_id)).fetchall()


def test_patch_with_a_changed_artist_sort_keeps_one_artist_row():
    import psycopg

    database_url, library_id, artist_id, album_keys = _seed_artist_with_two_albums()
    with psycopg.connect(database_url) as connection:
        scope_key, arguments = _patch_arguments(connection, library_id, artist_id, album_keys[0], ['renamed sort'])
        assert _patch(connection, arguments) is True
        rows = _artist_rows(connection, library_id, scope_key, artist_id)
        connection.rollback()
    # The patched album carries the artist's current identity.
    assert rows == [(['renamed sort'], 2)]


def test_two_overlapping_patches_of_one_artist_never_violate_its_key():
    import psycopg

    database_url, library_id, artist_id, album_keys = _seed_artist_with_two_albums()
    first = psycopg.connect(database_url)
    second = psycopg.connect(database_url)
    try:
        scope_key, first_arguments = _patch_arguments(first, library_id, artist_id, album_keys[0], ['first sort'])
        _, second_arguments = _patch_arguments(second, library_id, artist_id, album_keys[1], ['second sort'])
        assert _patch(first, first_arguments) is True
        outcome = {}

        def run_second():
            try:
                outcome['result'] = _patch(second, second_arguments)
                second.commit()
            except Exception as error:  # surfaced by the assertion below
                second.rollback()
                outcome['error'] = error

        # The second publication waits on the first's row locks, then runs
        # against the first's committed membership.
        worker = threading.Thread(target=run_second)
        worker.start()
        worker.join(timeout=2)
        assert worker.is_alive(), 'the second patch must wait for the first publication'
        first.commit()
        worker.join(timeout=30)
        assert not worker.is_alive()
        assert 'error' not in outcome, outcome.get('error')
        assert outcome['result'] in (True, False)
        rows = _artist_rows(first, library_id, scope_key, artist_id)
        assert len(rows) == 1 and rows[0][1] == 2
    finally:
        first.close()
        second.close()
