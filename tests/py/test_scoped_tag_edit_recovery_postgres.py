"""Startup recovery uses the real scoped writer and durable intent transaction."""
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest

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
