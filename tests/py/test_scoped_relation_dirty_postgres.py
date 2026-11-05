"""Old-writer changes must retain a scoped publication journal."""
import os
from uuid import uuid4

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_postgres_structural_tag_edit import _isolated_runtime_database_url_or_skip


@pytest.mark.parametrize('mutation', [
    'file_exception', 'artist_sort', 'root_active', 'featured_evidence',
    'exception_insert', 'exception_update', 'exception_delete',
])
def test_old_writer_gallery_dependency_journals_only_affected_album(mutation):
    import psycopg
    database_url = _isolated_runtime_database_url_or_skip()
    setup_url = os.environ.get('ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL', '')
    if not setup_url:
        pytest.skip('An isolated migrator URL is required.')
    isolatedPostgres.prepare_isolated_database(setup_url, database_url)
    token = uuid4().hex
    with psycopg.connect(database_url) as connection:
        try:
            library_id = connection.execute("""select libraries.id from app.bootstrap_owners owners
                join library.libraries on libraries.owner_account_id=owners.account_id
                where owners.owner_key='local-bootstrap-owner' and libraries.name='Local Library'
                  and libraries.library_kind='local'""").fetchone()[0]
            root_id = connection.execute("""insert into library.library_roots(library_id,root_path,root_kind)
                values(%s,%s,'main_library') returning id""", (library_id, f'C:/journal/{token}')).fetchone()[0]
            artist_id = connection.execute("""insert into library.local_artists(library_id,artist_key,name)
                values(%s,%s,%s) returning id""", (library_id, token, f'Journal {token}')).fetchone()[0]
            album_id = connection.execute("""insert into library.local_albums(library_id,artist_id,album_key,title)
                values(%s,%s,%s,'Journal') returning id""", (library_id, artist_id, token)).fetchone()[0]
            track_id = connection.execute("""insert into library.local_tracks(library_id,album_id,artist_id,track_key,title)
                values(%s,%s,%s,%s,'Track') returning id""", (library_id, album_id, artist_id, token)).fetchone()[0]
            file_id = connection.execute("""insert into library.local_track_files(track_id,library_root_id,private_path)
                values(%s,%s,%s) returning id""", (track_id, root_id, f'C:/journal/{token}/track.flac')).fetchone()[0]
            connection.execute("""insert into library.local_album_featured_artists
                (library_id,album_id,artist_id,featured_kind)
                values(%s,%s,%s,'featured_track_artist')""", (library_id, album_id, artist_id))
            override_id = connection.execute("""insert into library.exception_overrides(library_id,track_key,override_payload)
                values(%s,%s,'{"exception_type":"non_album"}') returning id""", (library_id, token)).fetchone()[0]
            connection.execute('delete from library.local_relation_dirty_albums where library_id=%s', (library_id,))
            if mutation == 'file_exception':
                connection.execute("""update library.local_track_files set metadata=
                    '{"scan_cache":{"file_entry":{"exception_type":"custom_collection"}}}' where id=%s""", (file_id,))
            elif mutation == 'artist_sort':
                connection.execute("update library.local_artists set sort_name='Changed sort' where id=%s", (artist_id,))
            elif mutation == 'root_active':
                connection.execute('update library.library_roots set is_active=false where id=%s', (root_id,))
            elif mutation == 'featured_evidence':
                connection.execute("""update library.local_album_featured_artists set metadata=jsonb_set(metadata,'{relation_evidence_kind}','\"soundtrack_root\"')
                    where library_id=%s and album_id=%s and artist_id=%s""", (library_id, album_id, artist_id))
            elif mutation == 'exception_insert':
                connection.execute('delete from library.exception_overrides where id=%s', (override_id,))
                connection.execute('delete from library.local_relation_dirty_albums where library_id=%s', (library_id,))
                connection.execute("""insert into library.exception_overrides(library_id,track_id,override_payload)
                    values(%s,%s,'{"exception_type":"custom_collection"}')""", (library_id, track_id))
            elif mutation == 'exception_update':
                connection.execute("""update library.exception_overrides set override_payload=
                    '{"exception_type":"custom_collection"}' where id=%s""", (override_id,))
            else:
                connection.execute('delete from library.exception_overrides where id=%s', (override_id,))
            dirty = connection.execute("""select album_id,album_keys,first_gallery_generation
                from library.local_relation_dirty_albums where library_id=%s""", (library_id,)).fetchall()
            assert len(dirty) == 1
            assert dirty[0][0] == album_id
            assert dirty[0][1] == [token]
            assert dirty[0][2] is not None
        finally:
            connection.rollback()


@pytest.mark.parametrize('source', ['local_artists', 'library_roots'])
@pytest.mark.parametrize('operation', ['insert', 'update', 'delete'])
def test_ownerless_source_change_keeps_explicit_empty_membership_journal(source, operation):
    import psycopg
    database_url = _isolated_runtime_database_url_or_skip()
    setup_url = os.environ.get('ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL', '')
    if not setup_url:
        pytest.skip('An isolated migrator URL is required.')
    isolatedPostgres.prepare_isolated_database(setup_url, database_url)
    token = uuid4().hex
    # Root removal is an administrative operation; the app role correctly lacks it.
    with psycopg.connect(setup_url if operation == 'delete' else database_url) as connection:
        try:
            library_id = connection.execute("""select libraries.id from app.bootstrap_owners owners
                join library.libraries on libraries.owner_account_id=owners.account_id
                where owners.owner_key='local-bootstrap-owner' and libraries.name='Local Library'
                  and libraries.library_kind='local'""").fetchone()[0]
            connection.execute('delete from library.local_relation_dirty_albums where library_id=%s', (library_id,))
            if source == 'local_artists':
                row_id = connection.execute("""insert into library.local_artists(library_id,artist_key,name)
                    values(%s,%s,%s) returning id""", (library_id, token, token)).fetchone()[0]
            else:
                row_id = connection.execute("""insert into library.library_roots(library_id,root_path,root_kind)
                    values(%s,%s,'main_library') returning id""", (library_id, f'C:/empty/{token}')).fetchone()[0]
            if operation != 'insert':
                connection.execute('delete from library.local_relation_dirty_albums where library_id=%s', (library_id,))
                if operation == 'delete':
                    connection.execute(f'delete from library.{source} where id=%s', (row_id,))
                elif source == 'local_artists':
                    connection.execute('update library.local_artists set name=%s where id=%s', (token + ' renamed', row_id))
                else:
                    connection.execute('update library.library_roots set is_active=false where id=%s', (row_id,))
            dirty = connection.execute('select album_id,album_keys,first_gallery_generation from library.local_relation_dirty_albums where library_id=%s', (library_id,)).fetchall()
            assert len(dirty) == 1
            assert dirty[0][0:2] == (0, [])
            assert dirty[0][2] is not None
        finally:
            connection.rollback()


@pytest.mark.parametrize('old_maps', [None, 'malformed', []])
def test_full_initializer_can_replace_malformed_legacy_alias_maps(old_maps):
    import psycopg
    from psycopg.types.json import Jsonb
    database_url = _isolated_runtime_database_url_or_skip()
    setup_url = os.environ.get('ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL', '')
    if not setup_url:
        pytest.skip('An isolated migrator URL is required.')
    isolatedPostgres.prepare_isolated_database(setup_url, database_url)
    with psycopg.connect(database_url) as connection:
        try:
            library_id, metadata = connection.execute("""select libraries.id,libraries.metadata
                from app.bootstrap_owners owners join library.libraries on libraries.owner_account_id=owners.account_id
                where owners.owner_key='local-bootstrap-owner' and libraries.name='Local Library'
                  and libraries.library_kind='local'""").fetchone()
            scan_cache = metadata.setdefault('scan_cache', {})
            views = scan_cache.setdefault('relation_views', {})
            for field in ('family_to_artists', 'folder_related'):
                views.setdefault(field, {})
            for field in ('artists', 'artists_sidebar', 'sidebar_families'):
                views.setdefault(field, [])
            views.update(alias_to_canonical=old_maps, canonical_to_aliases=old_maps)
            connection.execute('update library.libraries set metadata=%s where id=%s', (Jsonb(metadata), library_id))
            views.update(alias_to_canonical={}, canonical_to_aliases={})
            connection.execute('update library.libraries set metadata=%s where id=%s', (Jsonb(metadata), library_id))
            assert connection.execute("select metadata #> '{scan_cache,relation_views,alias_to_canonical}' from library.libraries where id=%s", (library_id,)).fetchone()[0] == {}
        finally:
            connection.rollback()
