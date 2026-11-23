"""Startup recovery uses the real scoped writer and durable intent transaction."""
import logging
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

from tests.py.test_isolated_postgres_live import watcher_repair_inventory
from tests.py.test_multidestination_tag_edit_postgres import multi_destination_library


@pytest.mark.parametrize('requested_field', ['album_artist', 'title'])
def test_album_artist_recovery_commits_identity_cover_and_intent_without_full_snapshot(
    multi_destination_library, monkeypatch, requested_field,
):
    from music_app.services import library_roots, metadata, scan_cache_persistence
    from music_app.services.tag_edit_intents_postgres import PostgresTagEditIntentRepository
    from music_app.services.tag_edit_recovery import reconcile_unfinished_tag_edit_intents_on_startup
    from music_app.services.album_identity_lineage_postgres import AlbumIdentityLineageRepository

    fixture = multi_destination_library
    paths = fixture['paths']
    previous = fixture['previous']
    artist = previous[paths[0]]['album_artist'] + ' Recovered'
    refreshed = {Path(path): {**entry, 'album_artist': artist} for path, entry in previous.items()}
    if requested_field == 'title':
        for entry in refreshed.values():
            entry.update(title='Recovered title', year=2025, release_date='2025')
    root_identity = 'recovery-' + fixture['source_key']
    repository = PostgresTagEditIntentRepository(fixture['config'])
    intent_id = repository.prepare_intent(library_root_identity=root_identity, changes=[
        {'path': path, 'old_values': {requested_field: previous[path][requested_field]},
         'requested_values': {requested_field: refreshed[Path(path)][requested_field]}}
        for path in paths
    ])
    repository.mark_files_verified(intent_id)
    monkeypatch.setattr(library_roots, 'library_root_cache_identity', lambda _config: root_identity)
    monkeypatch.setattr(library_roots, 'resolve_configured_media_path', lambda _config, path: Path(path))
    monkeypatch.setattr(metadata, 'read_editable_tag_values', lambda path, fields: {
        field: refreshed[path][field] for field in fields
    })
    monkeypatch.setattr(metadata, 'read_metadata_for_file', lambda path: refreshed[path])
    monkeypatch.setattr(metadata, 'apply_text_repairs_to_file',
                        lambda *_args: pytest.fail('Verified files must not be rewritten during forward recovery'))
    monkeypatch.setattr(scan_cache_persistence.PostgresScanCacheAdapter, 'load_snapshot',
                        lambda *_args: pytest.fail('Recovery loaded the full library snapshot'))

    result = reconcile_unfinished_tag_edit_intents_on_startup(SimpleNamespace(
        config=fixture['config'], logger=logging.getLogger(__name__),
    ))

    assert result == {'completed': 1, 'rolled_back': 0, 'reconciled_external': 0, 'failed': 0}
    connection = fixture['connection']
    connection.rollback()
    rows = connection.execute("""select tracks.id, artists.name, albums.cover_path,
        albums.metadata->>'cover_selection_origin', albums.metadata->>'cover_selection_provenance'
        from library.local_tracks tracks join library.local_albums albums on albums.id=tracks.album_id
        join library.local_artists artists on artists.id=albums.artist_id
        where tracks.id=any(%s) order by tracks.id""",
        ([fixture['track_ids'][path] for path in paths],)).fetchall()
    assert len(rows) == 3
    assert all(row[1:] == (artist, fixture['source_cover'], 'user', 'explicit') for row in rows)
    assert connection.execute('select status from library.tag_edit_intents where id=%s',
                              (intent_id,)).fetchone()[0] == 'completed'
    assert connection.execute('select cover_path from library.local_albums where id=%s',
                              (fixture['albums']['Existing'],)).fetchone()[0] == fixture['selected_cover']
    destination_id = connection.execute('select album_id from library.local_tracks where id=%s',
                                       (fixture['track_ids'][paths[0]],)).fetchone()[0]
    historical = AlbumIdentityLineageRepository(fixture['config']).resolve(
        album_id=fixture['albums']['Original'], album_key=fixture['source_key'], track_paths=set(paths),
    )
    assert historical['status'] in {'current', 'resolved'}
    assert historical['album']['album_id'] == destination_id
    assert connection.execute('select release_year from library.local_albums where id=%s',
                              (destination_id,)).fetchone()[0] == (2025 if requested_field == 'title' else 2026)


def test_startup_recovery_touches_only_the_journal_albums_at_any_library_size(watcher_repair_inventory, monkeypatch):
    """Case 56 (b), real Postgres: recovering one unfinished title edit costs the same counted statements and
    returned rows with 5 and 60 other albums in the library. Only the journal's album is journaled for the
    relation owner, which recovery queues and never runs or waits on."""
    from concurrent.futures import Future

    from music_app.services import cache, library_roots, metadata, postgres_connections
    from music_app.services.tag_edit_intents_postgres import PostgresTagEditIntentRepository
    from music_app.services.tag_edit_recovery import reconcile_unfinished_tag_edit_intents_on_startup
    from tests.e2e.support import isolatedPostgres
    from tests.py.bounded_interactions import CountingConnection, OperationCounts

    fixture = watcher_repair_inventory
    held = []

    class Executor:
        """Holds the relation owner the save queues: recovery never runs or waits on it."""

        def submit(self, action):
            future = Future()
            held.append((action, future))
            return future

    monkeypatch.setattr(cache, '_CACHE_WRITE_EXECUTOR', Executor())
    monkeypatch.setattr(library_roots, 'resolve_media_path_within_roots', lambda raw, _roots, **_k: Path(raw))
    monkeypatch.setattr(metadata, 'apply_text_repairs_to_file',
                        lambda *_args: pytest.fail('verified files are not rewritten in forward recovery'))
    measured = {}

    def run(other_albums, size):
        edited = fixture.entry(f'Edited {size}/Album/01.flac', artist=f'Edited {size}', album='Edited album')
        others = [fixture.entry(f'Other {size} {index:03d}/Album/01.flac', artist=f'Other {size} {index:03d}',
                                album='Other album') for index in range(other_albums)]
        fixture.seed(edited, *others)
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            assert connection.execute('select count(*) as rows from library.local_relation_dirty_albums').fetchone()['rows'] == 0
            album_id = connection.execute("""
                select tracks.album_id from library.local_tracks tracks
                join library.local_track_files files on files.track_id=tracks.id where files.private_path=%s
            """, (edited['path'],)).fetchone()['album_id']
        identity = f'recovery-size-{size}'
        repository = PostgresTagEditIntentRepository(fixture.config)
        intent_id = repository.prepare_intent(library_root_identity=identity, changes=[{
            'path': edited['path'], 'old_values': {'title': edited['title']},
            'requested_values': {'title': 'Recovered title'},
        }])
        repository.mark_files_verified(intent_id)
        recovered = {**edited, 'title': 'Recovered title'}
        monkeypatch.setattr(library_roots, 'library_root_cache_identity', lambda _config: identity)
        monkeypatch.setattr(metadata, 'read_editable_tag_values',
                            lambda _path, fields: {field: recovered[field] for field in fields})
        monkeypatch.setattr(metadata, 'read_metadata_for_file', lambda _path: dict(recovered))

        counts = OperationCounts()
        pooled = postgres_connections.pooled_connection

        class CountedLease:
            def __init__(self, lease):
                self._lease = lease

            def __enter__(self):
                return CountingConnection(self._lease.__enter__(), counts)

            def __exit__(self, *failure):
                return self._lease.__exit__(*failure)

        with monkeypatch.context() as counting:
            counting.setattr(postgres_connections, 'pooled_connection',
                             lambda *args, **kwargs: CountedLease(pooled(*args, **kwargs)))
            result = reconcile_unfinished_tag_edit_intents_on_startup(SimpleNamespace(
                config=fixture.config, logger=logging.getLogger(__name__)))
        assert result == {'completed': 1, 'rolled_back': 0, 'reconciled_external': 0, 'failed': 0}
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            assert connection.execute('select status from library.tag_edit_intents where id=%s',
                                      (intent_id,)).fetchone()['status'] == 'completed'
            assert connection.execute('select title from library.local_tracks tracks join library.local_track_files files'
                                      ' on files.track_id=tracks.id where files.private_path=%s',
                                      (edited['path'],)).fetchone()['title'] == 'Recovered title'
            dirty = [row['album_id'] for row in connection.execute(
                'select album_id from library.local_relation_dirty_albums order by album_id').fetchall()]
        assert dirty == [album_id], f"only the journal's album waits for the relation owner: {dirty}"
        assert len(held) == 1, 'the relation owner is queued after the commit'
        measured[size] = counts
        # Outside the measurement, the owner runs: it drains the album and releases its single-flight slot, so
        # the next size's save queues its own owner instead of coalescing into this one.
        action, future = held.pop()
        future.set_result(action())
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            assert connection.execute('select count(*) as rows from library.local_relation_dirty_albums').fetchone()['rows'] == 0

    run(5, 'small')
    run(60, 'large')
    small, large = measured['small'], measured['large']
    sizes = (f'5 other albums: {small.sql_statements} statements, {small.returned_rows} rows; '
             f'60: {large.sql_statements} statements, {large.returned_rows} rows')
    print(f'[case56-recovery-counts] {sizes}', file=sys.__stderr__, flush=True)
    assert small.sql_statements == large.sql_statements, f'statements grew with the library: {sizes}'
    assert small.returned_rows == large.returned_rows, f'returned rows grew with the library: {sizes}'
