"""Detached old-writer edits must not strand shared gallery projections."""
import os
from uuid import uuid4

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_postgres_structural_tag_edit import (
    _CommitSuppressingConnection,
    _isolated_runtime_database_url_or_skip,
)


@pytest.mark.parametrize('diagnostic_update', ['none', 'timing', 'reason', 'patch_timestamp'])
def test_old_writer_detached_edit_replays_without_rebuilding_album_membership(monkeypatch, diagnostic_update):
    import psycopg
    from music_app.services import gallery_projection_postgres as gallery
    from music_app.services import library_browse_postgres as browse
    from music_app.services import relation_projection_postgres as relations
    from music_app.services import scan_cache_persistence as persistence
    from music_app.services import scoped_relation_projection as scoped

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
            values(%s,%s,'main_library') returning id""", (library_id, f'C:/detached-replay/{token}')).fetchone()[0]
        artist_id = connection.execute("""insert into library.local_artists(library_id,artist_key,name)
            values(%s,%s,%s) returning id""", (library_id, token, f'Artist {token}')).fetchone()[0]
        next_artist_id = connection.execute("""insert into library.local_artists(library_id,artist_key,name)
            values(%s,%s,%s) returning id""", (library_id, f'{token}-next', f'Next Artist {token}')).fetchone()[0]
        album_id = connection.execute("""insert into library.local_albums(library_id,artist_id,album_key,title)
            values(%s,%s,%s,'Retained Album') returning id""", (library_id, artist_id, token)).fetchone()[0]
        connection.execute("""insert into library.local_album_featured_artists
            (library_id,album_id,artist_id,featured_kind)
            values(%s,%s,%s,'owner')""", (library_id, album_id, artist_id))
        detached_id = None
        for index, owner in enumerate((album_id, None)):
            track_id = connection.execute("""insert into library.local_tracks(library_id,album_id,artist_id,track_key,title)
                values(%s,%s,%s,%s,'Original title') returning id""", (library_id, owner, artist_id, f'{token}-{index}')).fetchone()[0]
            connection.execute("""insert into library.local_track_files(track_id,library_root_id,private_path,relative_path)
                values(%s,%s,%s,%s)""", (track_id, root_id, f'C:/detached-replay/{token}/{index}.flac', f'{index}.flac'))
            if owner is None:
                detached_id = track_id
        persistence._commit_structural_relation_projection(
            _CommitSuppressingConnection(connection), config, reason='test_fixture')
        connection.commit()
        gallery.initialize_gallery_membership(config)

        def headers():
            return connection.execute("""select scope_key,source_generation,revision,album_count,occurrence_count
                from library.gallery_membership_headers where library_id=%s order by scope_key""", (library_id,)).fetchall()

        def membership():
            return connection.execute("""select scope_key,artist_id,album_key,payload
                from library.gallery_membership_entries where library_id=%s
                order by scope_key,artist_id,album_key""", (library_id,)).fetchall()

        before_headers = headers()
        before_membership = membership()
        assert before_headers and before_membership
        assert not connection.execute('select 1 from library.local_relation_dirty_albums where library_id=%s', (library_id,)).fetchone()
        if diagnostic_update != 'none':
            # Old serving processes still update these diagnostics directly.
            # None changes the rendered membership or its ordering.
            fields = {
                'timing': ('relation_projection,duration_ms', '123'),
                'reason': ('relation_projection,rebuild_reason', '"legacy-diagnostic"'),
                'patch_timestamp': ('relation_projection,targeted_patch_timestamp', '"2026-11-02T00:00:00Z"'),
            }
            suffix, value = fields[diagnostic_update]
            connection.execute("""update library.libraries set metadata=jsonb_set(metadata,
                %s::text[], %s::jsonb) where id=%s""",
                (['scan_cache', *suffix.split(',')], value, library_id))
            connection.commit()
            after_diagnostic = connection.execute(
                'select generation from library.gallery_projection_state where library_id=%s',
                (library_id,)).fetchone()[0]
            assert all(header[1] == after_diagnostic for header in before_headers)
            assert not connection.execute('select 1 from library.local_relation_dirty_albums where library_id=%s', (library_id,)).fetchone()
        # This bypasses new application helpers exactly as an older process does.
        connection.execute('update library.local_tracks set artist_id=%s,title=%s where id=%s',
                           (next_artist_id, 'Changed detached title', detached_id))
        connection.commit()
        generation = connection.execute('select generation from library.gallery_projection_state where library_id=%s', (library_id,)).fetchone()[0]
        assert all(header[1] < generation for header in before_headers)
        assert not connection.execute('select 1 from library.local_relation_dirty_albums where library_id=%s and album_id>0', (library_id,)).fetchone()
        assert connection.execute('select album_id from library.local_relation_dirty_albums where library_id=%s', (library_id,)).fetchall() == [(0,)]
        connection.commit()

        def forbidden(*_args, **_kwargs):
            pytest.fail('Detached replay must not rebuild relation sources or gallery memberships')

        monkeypatch.setattr(relations, 'build_postgres_relation_views', forbidden)
        monkeypatch.setattr(scoped, 'build_postgres_relation_views', forbidden)
        monkeypatch.setattr(browse, '_root_gallery_membership_sql', forbidden)
        source_sql = relations.load_relation_source_rows_sql

        def scoped_sources_only(*, scoped=False):
            assert scoped, 'Detached replay must not read full-library relation sources'
            return source_sql(scoped=True)

        monkeypatch.setattr(relations, 'load_relation_source_rows_sql', scoped_sources_only)
        replay_result = scoped.ensure_pending_relation_projection_ready(config)

        after_headers = headers()
        current_generation = connection.execute('select generation from library.gallery_projection_state where library_id=%s', (library_id,)).fetchone()[0]
        assert current_generation >= generation
        assert all(header[1] == current_generation for header in after_headers), {
            'before_replay': generation, 'after_replay': current_generation,
            'header_generations': [header[1] for header in after_headers],
            'initialized': replay_result.get('initialized'), 'updated': replay_result.get('updated'),
        }
        assert [(h[0], *h[2:]) for h in after_headers] == [(h[0], *h[2:]) for h in before_headers]
        assert membership() == before_membership
        assert not connection.execute('select 1 from library.local_relation_dirty_albums where library_id=%s', (library_id,)).fetchone()
        assert connection.execute('select title from library.local_tracks where id=%s', (detached_id,)).fetchone()[0] == 'Changed detached title'
        assert connection.execute('select artist_id from library.local_tracks where id=%s', (detached_id,)).fetchone()[0] == next_artist_id
        assert scoped.tag_edit_baseline_ready(config)
        # A deliberate full writer must publish the gallery atomically, not
        # clear its source journal and leave an older gallery behind.
        monkeypatch.undo()
        connection.execute('update library.local_albums set title=%s where id=%s',
                           ('Full publication title', album_id))
        persistence._commit_structural_relation_projection(
            _CommitSuppressingConnection(connection), config, reason='test_full_publication')
        current_generation = connection.execute('select generation from library.gallery_projection_state where library_id=%s', (library_id,)).fetchone()[0]
        assert all(header[1] == current_generation for header in headers())
        assert any(row[3]['album_title'] == 'Full publication title' for row in membership())
        assert not connection.execute('select 1 from library.local_relation_dirty_albums where library_id=%s', (library_id,)).fetchone()
        # Ownership alone must not exempt a later, different alias write in
        # the same transaction as the normalized publication.
        for path, replacement in (
            (['scan_cache', 'relation_views', 'alias_to_canonical'], '{"Unowned alias":"Different canonical"}'),
            (['scan_cache', 'relations_last_built'], '123'),
            (['scan_cache', 'relation_views', 'artists'], 'null'),
        ):
            with pytest.raises(RuntimeError, match='rollback metadata probe'):
                with connection.transaction():
                    connection.execute('update library.local_albums set title=%s where id=%s',
                                       ('Concurrent metadata probe', album_id))
                    connection.execute("""update library.libraries set metadata=jsonb_set(metadata,
                        %s::text[],%s::jsonb) where id=%s""", (path, replacement, library_id))
                    assert connection.execute('select 1 from library.local_relation_dirty_albums where library_id=%s', (library_id,)).fetchone()
                    with pytest.raises(RuntimeError, match='still being reconciled'):
                        scoped.publish_affected_relation_projection(
                            _CommitSuppressingConnection(connection), album_ids=[album_id], config=config)
                    raise RuntimeError('rollback metadata probe')
        for fingerprint_field in ('source_fingerprint', 'built_from_fingerprint'):
            with pytest.raises(RuntimeError, match='rollback fingerprint probe'):
                with connection.transaction():
                    connection.execute('update library.local_albums set title=%s where id=%s',
                                       ('Unrelated source change', album_id))
                    connection.execute("""update library.libraries set metadata=jsonb_set(metadata,
                        %s::text[],'"unproven-fingerprint"'::jsonb) where id=%s""",
                        (['scan_cache', 'relation_projection', fingerprint_field], library_id))
                    assert connection.execute('select 1 from library.local_relation_dirty_albums where library_id=%s and album_id=-1', (library_id,)).fetchone()
                    raise RuntimeError('rollback fingerprint probe')
        connection.commit()
        publication_xid = connection.execute('select last_publication_xid::text from library.local_relation_projection_state where library_id=%s', (library_id,)).fetchone()[0]
        committed_membership = membership()
        connection.execute('update library.local_albums set title=%s where id=%s',
                           ('Pending full publication', album_id))
        pending_journal = connection.execute('select album_id,first_gallery_generation from library.local_relation_dirty_albums where library_id=%s order by album_id', (library_id,)).fetchall()

        class FailedGalleryPublication(_CommitSuppressingConnection):
            def execute(self, statement, *args, **kwargs):
                if 'select library.patch_gallery_membership(' in statement:
                    raise RuntimeError('Injected gallery publication failure')
                return super().execute(statement, *args, **kwargs)

        with pytest.raises(RuntimeError, match='Injected gallery publication failure'):
            with connection.transaction():
                persistence._commit_structural_relation_projection(
                    FailedGalleryPublication(connection), config, reason='test_full_failure')
        assert membership() == committed_membership
        assert connection.execute('select album_id,first_gallery_generation from library.local_relation_dirty_albums where library_id=%s order by album_id', (library_id,)).fetchall() == pending_journal
        assert connection.execute('select last_publication_xid::text from library.local_relation_projection_state where library_id=%s', (library_id,)).fetchone()[0] == publication_xid


def test_tag_edit_publishes_with_another_albums_pending_change_and_refuses_its_own():
    # INT-018: a pending change to another album must not block a tag edit.
    import psycopg
    from music_app.services import gallery_projection_postgres as gallery
    from music_app.services import scan_cache_persistence as persistence
    from music_app.services import scoped_relation_projection as scoped

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
            values(%s,%s,'main_library') returning id""", (library_id, f'C:/pending-edit/{token}')).fetchone()[0]
        albums, paths = {}, {}
        for name in ('edited', 'pending'):
            artist_id = connection.execute("""insert into library.local_artists(library_id,artist_key,name)
                values(%s,%s,%s) returning id""", (library_id, f'{token}-{name}', f'{name} artist {token}')).fetchone()[0]
            albums[name] = connection.execute("""insert into library.local_albums(library_id,artist_id,album_key,title)
                values(%s,%s,%s,%s) returning id""", (library_id, artist_id, f'{token}-{name}', f'{name} album')).fetchone()[0]
            connection.execute("""insert into library.local_album_featured_artists(library_id,album_id,artist_id,featured_kind)
                values(%s,%s,%s,'owner')""", (library_id, albums[name], artist_id))
            track_id = connection.execute("""insert into library.local_tracks(library_id,album_id,artist_id,track_key,title)
                values(%s,%s,%s,%s,'Track') returning id""", (library_id, albums[name], artist_id, f'{token}-{name}')).fetchone()[0]
            paths[name] = f'C:/pending-edit/{token}/{name}.flac'
            connection.execute("""insert into library.local_track_files(track_id,library_root_id,private_path,relative_path)
                values(%s,%s,%s,%s)""", (track_id, root_id, paths[name], f'{name}.flac'))
        persistence._commit_structural_relation_projection(
            _CommitSuppressingConnection(connection), config, reason='test_fixture')
        connection.commit()
        gallery.initialize_gallery_membership(config)
        assert scoped.tag_edit_baseline_ready(config, track_paths=[paths['edited']])

        connection.execute('update library.local_albums set title=%s where id=%s', ('Pending retitle', albums['pending']))
        connection.commit()
        assert connection.execute('select album_id from library.local_relation_dirty_albums where library_id=%s',
                                  (library_id,)).fetchall() == [(albums['pending'],)]
        assert scoped.tag_edit_baseline_ready(config, track_paths=[paths['edited']])
        assert not scoped.tag_edit_baseline_ready(config, track_paths=[paths['pending']])

        connection.execute('update library.local_albums set title=%s where id=%s', ('Edited retitle', albums['edited']))
        scoped.publish_affected_relation_projection(
            _CommitSuppressingConnection(connection), album_ids=[albums['edited']], config=config)
        connection.commit()

        generation = connection.execute('select generation from library.gallery_projection_state where library_id=%s',
                                        (library_id,)).fetchone()[0]
        headers = connection.execute('select source_generation from library.gallery_membership_headers where library_id=%s',
                                     (library_id,)).fetchall()
        assert headers and all(header[0] == generation for header in headers)
        assert not connection.execute('select 1 from library.local_relation_dirty_albums where library_id=%s', (library_id,)).fetchone()
        titles = {row[0]['album_title'] for row in connection.execute(
            'select payload from library.gallery_membership_entries where library_id=%s', (library_id,)).fetchall()}
        assert {'Edited retitle', 'Pending retitle'} <= titles
        assert scoped.tag_edit_baseline_ready(config, track_paths=[paths['pending']])
