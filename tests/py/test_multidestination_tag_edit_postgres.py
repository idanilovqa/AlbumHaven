"""Multi-destination tag edits publish every result in one transaction."""
import json
import os
from uuid import uuid4

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_postgres_structural_tag_edit import (
    _CommitSuppressingConnection, _entries, _isolated_runtime_database_url_or_skip,
)


@pytest.fixture
def multi_destination_library(monkeypatch):
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
    name = f'Multi Artist {token}'
    source_cover = f'C:/multi/{token}/source.jpg'
    selected_cover = f'C:/multi/{token}/selected.jpg'
    template = next(iter(_entries()[1].values()))
    previous = {}
    for index in range(3):
        path = f'C:/multi/{token}/{index}.flac'
        previous[path] = {**template, 'path': path, 'album': 'Original', 'artist': name,
                          'album_artist': name, 'year': 2026, 'release_date': '2026',
                          'title': f'Track {index}', 'track_number': str(index + 1),
                          'cover_path': source_cover, 'cover_selection_origin': 'user',
                          'cover_selection_provenance': 'explicit'}
    paths = list(previous)
    updated = {paths[0]: {**previous[paths[0]], 'album': 'Existing'},
               paths[1]: {**previous[paths[1]], 'album': 'New'}}
    adapter = persistence.PostgresScanCacheAdapter(config)
    projections = {
        title: persistence._structural_destination_album_projection(
            adapter._build_albums, {path: entry}, frozenset({'album'}), set())
        for path, entry in updated.items() for title in [entry['album']]
    }
    connection = psycopg.connect(database_url)
    try:
        library_id = connection.execute("""select libraries.id from app.bootstrap_owners owners
            join library.libraries on libraries.owner_account_id=owners.account_id
            where owners.owner_key='local-bootstrap-owner' and libraries.name='Local Library'
              and libraries.library_kind='local'""").fetchone()[0]
        root_id = connection.execute("""insert into library.library_roots(library_id,root_path,root_kind,is_active)
            values(%s,%s,'main_library',true) returning id""", (library_id, f'C:/multi/{token}')).fetchone()[0]
        artist_id = connection.execute("""insert into library.local_artists(library_id,artist_key,name)
            values(%s,%s,%s) returning id""", (library_id, name.casefold(), name)).fetchone()[0]
        albums = {}
        for title, key, cover in [('Original', f'{name.casefold()}::original', source_cover),
                                  ('Existing', projections['Existing'].key, selected_cover)]:
            metadata = {'album_artist': name, 'artists': [name], 'cover_revision': title,
                        'cover_selection_origin': 'user', 'cover_selection_provenance': 'explicit',
                        'owner_note': title}
            albums[title] = connection.execute("""insert into library.local_albums
                (library_id,artist_id,album_key,title,release_year,cover_path,metadata)
                values(%s,%s,%s,%s,2026,%s,%s::jsonb) returning id""",
                (library_id, artist_id, key, title, cover, json.dumps(metadata))).fetchone()[0]
            connection.execute("""insert into library.local_album_featured_artists
                (library_id,album_id,artist_id,featured_kind,metadata)
                values(%s,%s,%s,'owner','{"source":"runtime_scan_cache"}')""", (library_id, albums[title], artist_id))
        track_ids = {}
        existing_path = f'C:/multi/{token}/existing.flac'
        existing_entry = {**template, 'path': existing_path, 'album': 'Existing', 'artist': name,
                          'album_artist': name, 'year': 2026, 'release_date': '2026',
                          'title': 'Existing track', 'cover_path': selected_cover}
        for index, (path, entry) in enumerate([*previous.items(), (existing_path, existing_entry)]):
            track_ids[path] = connection.execute("""insert into library.local_tracks
                (library_id,album_id,artist_id,track_key,title,track_number,metadata)
                values(%s,%s,%s,%s,%s,%s,%s::jsonb) returning id""",
                (library_id, albums[entry['album']], artist_id, f'{token}-{index}', entry['title'],
                 index + 1, json.dumps({'artist': name, 'album': entry['album']}))).fetchone()[0]
            connection.execute("""insert into library.local_track_files(track_id,library_root_id,private_path,metadata)
                values(%s,%s,%s,jsonb_build_object('scan_cache',jsonb_build_object(
                  'source','runtime_scan_cache','stale',false,'file_entry',%s::jsonb)))""",
                (track_ids[path], root_id, path, json.dumps(entry)))
        persistence._commit_structural_relation_projection(_CommitSuppressingConnection(connection), config, reason='test_fixture')
        connection.commit()
        gallery.initialize_gallery_membership(config)
        scheduler_calls = []
        monkeypatch.setattr(gallery, 'schedule_gallery_projection_refresh', lambda *_args, **kwargs: scheduler_calls.append(kwargs))
        yield {'connection': connection, 'config': config, 'adapter': adapter, 'library_id': library_id,
               'albums': albums, 'paths': paths, 'track_ids': track_ids, 'previous': previous,
               'updated': updated, 'projections': projections, 'source_cover': source_cover,
               'selected_cover': selected_cover, 'scheduler_calls': scheduler_calls,
               'existing_path': existing_path, 'existing_entry': existing_entry,
               'source_key': f'{name.casefold()}::original'}
    finally:
        connection.rollback()
        connection.close()


def _persist(fixture, **options):
    return fixture['adapter'].persist_structural_tag_edit(
        changed_paths=set(fixture['updated']), previous_file_entries=fixture['previous'],
        updated_file_entries=fixture['updated'], changed_field_names=fixture.get('changed_fields', {'album'}),
        rebuild_relation_projection=True, **options)


@pytest.mark.parametrize('field', ['artist', 'album'])
def test_same_album_tag_edit_preserves_distinct_file_covers(multi_destination_library, field):
    from music_app.services import gallery_projection_postgres as gallery
    from music_app.services import scan_cache_persistence as persistence

    fixture = multi_destination_library
    connection = fixture['connection']
    second = fixture['paths'][1]
    disc_cover = fixture['source_cover'].replace('source.jpg', 'disc-two.jpg')
    fixture['previous'][second]['cover_path'] = disc_cover
    connection.execute("""update library.local_track_files set metadata=jsonb_set(metadata,
        '{scan_cache,file_entry,cover_path}',to_jsonb(%s::text)) where private_path=%s""",
        (disc_cover, second))
    persistence._commit_structural_relation_projection(
        _CommitSuppressingConnection(connection), fixture['config'], reason='test_fixture')
    connection.commit()
    gallery.initialize_gallery_membership(fixture['config'])
    fixture['updated'] = {
        path: {**entry, field: 'Renamed album' if field == 'album' else 'New track artist'}
        for path, entry in fixture['previous'].items()
    }
    fixture['changed_fields'] = {field}

    result = _persist(fixture)

    assert result['destination_album_id'] == fixture['albums']['Original']
    rows = connection.execute("""select files.private_path,
        files.metadata #>> '{scan_cache,file_entry,cover_path}',
        files.metadata #>> '{scan_cache,file_entry,cover_selection_origin}',
        files.metadata #>> '{scan_cache,file_entry,cover_selection_provenance}'
        from library.local_track_files files where files.private_path=any(%s)""",
        (fixture['paths'],)).fetchall()
    assert {row[0]: row[1:] for row in rows} == {
        path: (entry['cover_path'], 'user', 'explicit')
        for path, entry in fixture['previous'].items()
    }
    assert connection.execute('select cover_path from library.local_albums where id=%s',
        (fixture['albums']['Original'],)).fetchone()[0] == fixture['source_cover']


def test_selected_file_loader_limits_sibling_context_to_requested_container(multi_destination_library, monkeypatch):
    fixture = multi_destination_library
    connection = fixture['connection']
    first = fixture['paths'][0]
    container = first.rsplit('/', 1)[0]
    excluded = {container + '-neighbor/unrelated.flac', container + '/Other Album/unrelated.flac',
                container + '/CD 1/Other Album/nested.flac'}
    disc_paths = {container + '/CD 1/disc-one.flac', container + '/Disc 2/disc-two.flac'}
    for path in excluded | disc_paths:
        entry = {**fixture['previous'][first], 'path': path}
        connection.execute("""insert into library.local_track_files(track_id,library_root_id,private_path,metadata)
            select track_id,library_root_id,%s,jsonb_build_object('scan_cache',jsonb_build_object(
              'source','runtime_scan_cache','stale',false,'file_entry',%s::jsonb))
            from library.local_track_files where private_path=%s""", (path, json.dumps(entry), first))
    connection.commit()
    monkeypatch.setattr(fixture['adapter'], 'load_snapshot',
                        lambda *_args, **_kwargs: pytest.fail('Selected recovery must not load the full snapshot'))
    assert set(fixture['adapter'].load_file_entries({first})) == {first}
    siblings = fixture['adapter'].load_file_entries({first}, include_siblings=True)
    assert set(siblings) == {*fixture['paths'], fixture['existing_path'], *disc_paths}
    assert siblings[first]['title'] == fixture['previous'][first]['title']
    assert not excluded & set(siblings)
    assert set(fixture['adapter'].load_file_entries({min(disc_paths)}, include_siblings=True)) == set(siblings)


@pytest.mark.parametrize('root_path', ['Z:/', '/'])
def test_selected_file_loader_handles_filesystem_root_without_descendant_inventory(multi_destination_library, root_path):
    fixture = multi_destination_library
    connection = fixture['connection']
    token = uuid4().hex
    direct = {f'{root_path}{token}-one.flac', f'{root_path}{token}-two.flac'}
    disc = f'{root_path}CD 1/{token}-disc.flac'
    nested = f'{root_path}Other-{token}/unrelated.flac'
    first = fixture['paths'][0]
    root_id = connection.execute("""insert into library.library_roots(library_id,root_path,root_kind,is_active)
        values(%s,%s,'main_library',true) returning id""", (fixture['library_id'], root_path)).fetchone()[0]
    for path in direct | {disc, nested}:
        entry = {**fixture['previous'][first], 'path': path}
        connection.execute("""insert into library.local_track_files(track_id,library_root_id,private_path,metadata)
            values(%s,%s,%s,jsonb_build_object('scan_cache',jsonb_build_object(
              'source','runtime_scan_cache','stale',false,'file_entry',%s::jsonb)))""",
            (fixture['track_ids'][first], root_id, path, json.dumps(entry)))
    connection.commit()
    assert set(fixture['adapter'].load_file_entries({min(direct)}, include_siblings=True)) == direct | {disc}


def test_multidestination_edit_keeps_remainder_covers_lineage_and_complete_results(multi_destination_library):
    from music_app.services.album_identity_lineage_postgres import AlbumIdentityLineageRepository
    fixture = multi_destination_library
    connection = fixture['connection']
    events = []
    fixture['adapter'].validate_structural_tag_edit(
        changed_paths=set(fixture['updated']), previous_file_entries=fixture['previous'],
        updated_file_entries=fixture['updated'], changed_field_names={'album'})
    result = _persist(fixture, before_commit=lambda _connection: events.append('before_commit'),
                      commit_guard=lambda commit: (events.append('commit'), commit()))
    assert events == ['before_commit', 'commit']
    assert len(fixture['scheduler_calls']) <= 1
    assert result['track_file_rows_updated'] == 2
    rows = connection.execute("""select tracks.id,tracks.album_id,albums.album_key,albums.cover_path,
        albums.metadata->>'cover_selection_origin',albums.metadata->>'cover_selection_provenance'
        from library.local_tracks tracks join library.local_albums albums on albums.id=tracks.album_id
        where tracks.id=any(%s)""", (list(fixture['track_ids'].values()),)).fetchall()
    by_track = {row[0]: row[1:] for row in rows}
    first, second, remainder = fixture['paths']
    first_row = by_track[fixture['track_ids'][first]]
    second_row = by_track[fixture['track_ids'][second]]
    remainder_row = by_track[fixture['track_ids'][remainder]]
    assert first_row == (fixture['albums']['Existing'], fixture['projections']['Existing'].key,
                         fixture['selected_cover'], 'user', 'explicit')
    assert second_row[1:] == (fixture['projections']['New'].key, fixture['source_cover'], 'user', 'explicit')
    assert remainder_row == (fixture['albums']['Original'], fixture['source_key'], fixture['source_cover'], 'user', 'explicit')
    assert by_track[fixture['track_ids'][fixture['existing_path']]][0] == fixture['albums']['Existing']
    assert set(result['source_album_ids']) == {fixture['albums']['Original']}
    assert set(result['destination_album_ids']) == {first_row[0], second_row[0]}
    assert set(result['affected_album_ids']) == {first_row[0], second_row[0], remainder_row[0]}
    assert set(result['affected_album_keys']) == {first_row[1], second_row[1], remainder_row[1]}
    assert set(result['cover_inherited_paths']) == {second}
    persisted = dict(connection.execute("""select private_path,metadata#>>'{scan_cache,file_entry,album}'
        from library.local_track_files where track_id=any(%s)""", (list(fixture['track_ids'].values()),)).fetchall())
    assert persisted == {first: 'Existing', second: 'New', remainder: 'Original', fixture['existing_path']: 'Existing'}
    covers = dict(connection.execute("""select private_path,metadata#>>'{scan_cache,file_entry,cover_path}'
        from library.local_track_files where track_id=any(%s)""", (list(fixture['track_ids'].values()),)).fetchall())
    assert covers == {first: fixture['selected_cover'], second: fixture['source_cover'],
                      remainder: fixture['source_cover'], fixture['existing_path']: fixture['selected_cover']}
    gallery_keys = {row[0] for row in connection.execute('select distinct album_key from library.gallery_membership_entries where library_id=%s', (fixture['library_id'],))}
    assert gallery_keys == {first_row[1], second_row[1], remainder_row[1]}
    lineage = AlbumIdentityLineageRepository(fixture['config'])
    for path, destination in [(first, first_row[0]), (second, second_row[0]), (remainder, remainder_row[0])]:
        resolved = lineage.resolve(album_id=fixture['albums']['Original'], album_key=fixture['source_key'], track_paths={path})
        assert resolved['status'] == ('current' if path == remainder else 'resolved')
        assert resolved['album']['album_id'] == destination


def test_complete_split_keeps_lookup_historical_identity_and_all_destinations(multi_destination_library):
    from music_app.services.album_identity_lineage_postgres import AlbumIdentityLineageRepository
    fixture = multi_destination_library
    connection = fixture['connection']
    task_key = f'multi-split-{uuid4().hex}'
    original_id = fixture['albums']['Original']
    original_key = fixture['source_key']
    connection.execute("""insert into ops.cover_lookup_tasks(library_id,task_key,status,album_key,metadata)
        values(%s,%s,'completed',%s,%s::jsonb)""", (
        fixture['library_id'], task_key, original_key,
        json.dumps({'source_payload': {'album_payload': {'id': original_id, 'key': original_key},
                                      'track_paths': fixture['paths']}})))
    connection.commit()
    fixture['updated'] = {
        path: {**fixture['previous'][path], 'album': 'Existing' if index == 0 else 'New'}
        for index, path in enumerate(fixture['paths'])
    }
    result = _persist(fixture)
    assert len(result['destination_album_ids']) == 2
    lookup = connection.execute("""select album_key, metadata#>>'{source_payload,album_payload,id}'
        from ops.cover_lookup_tasks where task_key=%s""", (task_key,)).fetchone()
    assert lookup == (original_key, str(original_id))
    lineage = AlbumIdentityLineageRepository(fixture['config'])
    for path in fixture['paths']:
        expected = connection.execute('select album_id from library.local_tracks where id=%s',
                                      (fixture['track_ids'][path],)).fetchone()[0]
        resolved = lineage.resolve(album_id=original_id, album_key=original_key, track_paths={path})
        assert resolved['status'] == 'resolved'
        assert resolved['album']['album_id'] == expected


def test_converging_groups_preserve_inherited_cover_for_every_destination_member(multi_destination_library):
    fixture = multi_destination_library
    first = fixture['paths'][0]
    existing = fixture['existing_path']
    fixture['previous'][existing] = fixture['existing_entry']
    fixture['updated'] = {
        path: {**fixture['previous'][path], 'album': 'New'} for path in (first, existing)
    }
    result = _persist(fixture)
    assert len(result['destination_album_ids']) == 1
    assert set(result['cover_inherited_paths']) == {first, existing}
    rows = fixture['connection'].execute("""select files.private_path, albums.cover_path,
        files.metadata#>>'{scan_cache,file_entry,cover_path}'
        from library.local_track_files files join library.local_tracks tracks on tracks.id=files.track_id
        join library.local_albums albums on albums.id=tracks.album_id
        where files.private_path=any(%s)""", ([first, existing],)).fetchall()
    assert {row[0] for row in rows} == {first, existing}
    assert {row[1:] for row in rows} == {(fixture['source_cover'], fixture['source_cover'])}
    inherited = dict(fixture['connection'].execute("""select private_path,
        metadata#>>'{scan_cache,file_entry,cover_inherited_from_structural_edit}'
        from library.local_track_files where private_path=any(%s)""", ([first, existing],)).fetchall())
    assert inherited == {first: 'true', existing: 'true'}


def test_second_group_failure_rolls_back_all_groups_and_never_commits(multi_destination_library, monkeypatch):
    fixture = multi_destination_library
    connection = fixture['connection']

    def snapshot():
        return {
            table: connection.execute(f'select to_jsonb(saved) from library.{table} saved order by to_jsonb(saved)::text').fetchall()
            for table in ('local_albums', 'local_tracks', 'local_track_files', 'gallery_membership_headers',
                          'gallery_membership_entries', 'local_relation_album_facts', 'local_relation_projection_entries',
                          'local_album_identity_transitions')
        }

    before = snapshot()
    adapter_type = type(fixture['adapter'])
    original = adapter_type._persist_structural_tag_edit_group
    calls = []

    def fail_second(self, **kwargs):
        calls.append(kwargs)
        if len(calls) == 2:
            raise RuntimeError('Injected second-group persistence failure')
        return original(self, **kwargs)

    monkeypatch.setattr(adapter_type, '_persist_structural_tag_edit_group', fail_second)
    callbacks = []
    with pytest.raises(RuntimeError, match='second-group persistence failure'):
        _persist(fixture, before_commit=lambda _connection: callbacks.append('before_commit'),
                 commit_guard=lambda commit: (callbacks.append('commit'), commit()))
    assert len(calls) == 2
    assert callbacks == []
    assert fixture['scheduler_calls'] == []
    assert snapshot() == before


def test_destination_that_is_also_a_source_keeps_newly_arrived_tracks(multi_destination_library):
    fixture = multi_destination_library
    first = fixture['paths'][0]
    existing = fixture['existing_path']
    fixture['previous'] = {**fixture['previous'], existing: fixture['existing_entry']}
    fixture['updated'] = {
        first: {**fixture['previous'][first], 'album': 'Existing'},
        existing: {**fixture['existing_entry'], 'album': 'New'},
    }
    result = _persist(fixture)
    connection = fixture['connection']
    actual = dict(connection.execute("""select files.private_path,albums.album_key
        from library.local_track_files files join library.local_tracks tracks on tracks.id=files.track_id
        join library.local_albums albums on albums.id=tracks.album_id
        where tracks.id=any(%s)""", (list(fixture['track_ids'].values()),)).fetchall())
    assert actual == {
        first: fixture['projections']['Existing'].key,
        existing: fixture['projections']['New'].key,
        fixture['paths'][1]: fixture['source_key'], fixture['paths'][2]: fixture['source_key'],
    }
    assert set(result['source_album_ids']) == set(fixture['albums'].values())
    assert connection.execute('select cover_path from library.local_albums where id=%s',
                              (fixture['albums']['Existing'],)).fetchone()[0] == fixture['selected_cover']


def _add_physical_copy(fixture):
    from music_app.services import scoped_relation_projection as scoped
    connection = fixture['connection']
    first = fixture['paths'][0]
    duplicate = first.removesuffix('.flac') + '-copy.flac'
    entry = {**fixture['previous'][first], 'path': duplicate}
    connection.execute("""insert into library.local_track_files(track_id,library_root_id,private_path,metadata)
        select track_id,library_root_id,%s,jsonb_build_object('scan_cache',jsonb_build_object(
          'source','runtime_scan_cache','stale',false,'file_entry',%s::jsonb))
        from library.local_track_files where private_path=%s""", (duplicate, json.dumps(entry), first))
    connection.commit()
    scoped.ensure_pending_relation_projection_ready(fixture['config'])
    fixture['previous'][duplicate] = entry
    return first, duplicate


@pytest.mark.parametrize('canonical_path_key', [False, True])
@pytest.mark.parametrize('edits', [{'album': 'New'}, {'title': 'Edited title'}, {'genre': 'Edited genre'}])
def test_editing_one_physical_copy_preserves_unselected_membership_and_provenance(
        multi_destination_library, canonical_path_key, edits):
    from music_app.services import scoped_relation_projection as scoped
    fixture = multi_destination_library
    first, duplicate = _add_physical_copy(fixture)
    connection = fixture['connection']
    shared_id = fixture['track_ids'][first]
    if canonical_path_key:
        connection.execute('update library.local_tracks set track_key=%s where id=%s', (first, shared_id))
    account_id = connection.execute('select owner_account_id from library.libraries where id=%s', (fixture['library_id'],)).fetchone()[0]
    for path, rating in ((first, 4), (duplicate, 2)):
        connection.execute('insert into library.exception_overrides(library_id,track_id,track_key,override_payload) values(%s,%s,%s,%s::jsonb)',
                           (fixture['library_id'], shared_id, path, json.dumps({'owner_note': path})))
        connection.execute('insert into app.track_preferences(account_id,library_id,track_id,track_key,rating,metadata) values(%s,%s,%s,%s,%s,%s::jsonb)',
                           (account_id, fixture['library_id'], shared_id, path, rating, json.dumps({'owner_note': path})))
    historical_key = 'historic:' + first
    connection.execute('insert into library.exception_overrides(library_id,track_id,track_key,override_payload) values(%s,%s,%s,%s::jsonb)',
                       (fixture['library_id'], shared_id, historical_key, json.dumps({'legacy': True})))
    connection.execute('insert into app.track_preferences(account_id,library_id,track_id,track_key,rating,metadata) values(%s,%s,%s,%s,3,%s::jsonb)',
                       (account_id, fixture['library_id'], shared_id, historical_key, json.dumps({'legacy': True})))
    connection.commit()
    scoped.ensure_pending_relation_projection_ready(fixture['config'])

    def copies():
        return {row[0]: row[1:] for row in connection.execute("""select files.private_path,
            files.id,files.library_root_id,tracks.id,tracks.track_key,tracks.album_id,
            tracks.title,tracks.metadata,files.metadata #> '{scan_cache,file_entry}'
            from library.local_track_files files join library.local_tracks tracks on tracks.id=files.track_id
            where files.private_path=any(%s)""", ([first, duplicate],)).fetchall()}

    before = copies()
    fixture['updated'] = {first: {**fixture['previous'][first], **edits}}
    fixture['changed_fields'] = set(edits)
    fixture['adapter'].validate_structural_tag_edit(
        changed_paths={first}, previous_file_entries=fixture['previous'],
        updated_file_entries=fixture['updated'], changed_field_names=set(edits))
    _persist(fixture)
    after = copies()
    assert (after[first][4] != fixture['albums']['Original']) is ('album' in edits)
    assert after[duplicate][4] == fixture['albums']['Original']
    assert after[first][2] != after[duplicate][2]
    assert after[duplicate][5:] == before[duplicate][5:]
    assert after[first][:2] == before[first][:2]
    assert after[duplicate][:2] == before[duplicate][:2]
    assert after[first][3] == first
    assert after[duplicate][3] == duplicate
    for field, value in edits.items():
        assert after[first][-1][field] == value
    assert after[duplicate][-1]['cover_path'] == fixture['source_cover']
    assert after[duplicate][-1]['cover_selection_provenance'] == 'explicit'
    for path, rating in ((first, 4), (duplicate, 2)):
        track_id = after[path][2]
        assert connection.execute('select track_id,override_payload from library.exception_overrides where library_id=%s and track_key=%s', (fixture['library_id'], path)).fetchone() == (track_id, {'owner_note': path})
        assert connection.execute('select track_id,rating,metadata from app.track_preferences where track_key=%s and account_id=%s', (path, account_id)).fetchone() == (track_id, rating, {'owner_note': path})
    assert connection.execute('select cover_path from library.local_albums where id=%s', (fixture['albums']['Original'],)).fetchone()[0] == fixture['source_cover']
    assert connection.execute('select track_id,override_payload from library.exception_overrides where library_id=%s and track_key=%s',
                              (fixture['library_id'], historical_key)).fetchone() == (shared_id, {'legacy': True})
    assert connection.execute('select track_id,rating,metadata from app.track_preferences where account_id=%s and track_key=%s',
                              (account_id, historical_key)).fetchone() == (shared_id, 3, {'legacy': True})


@pytest.mark.parametrize('canonical_path_key', [False, True])
def test_partial_copy_rebinds_path_proven_history_and_loops_only(multi_destination_library, canonical_path_key):
    from music_app.services import scoped_relation_projection as scoped
    fixture = multi_destination_library
    first, duplicate = _add_physical_copy(fixture)
    connection = fixture['connection']
    shared_id = fixture['track_ids'][first]
    account_id = connection.execute('select owner_account_id from library.libraries where id=%s', (fixture['library_id'],)).fetchone()[0]
    if canonical_path_key:
        connection.execute('update library.local_tracks set track_key=%s where id=%s', (first, shared_id))
    tables = {
        'integration.listen_history': ('track_key', 'played_at', 'now()'),
        'integration.pending_scrobbles': ('track_key', 'played_at', 'now()'),
        'integration.lastfm_loved_tracks': ('track_key', 'account_id', str(account_id)),
        'library.local_mbid_assertions': ('target_key', 'target_kind,evidence_source,mbid_assertion_state', "'track','local','unreviewed'"),
        'app.saved_loops': ('source_private_path', 'account_id,loop_key,start_seconds,end_seconds', f"{account_id},%s,0,10"),
    }
    paths = [first, duplicate, 'historic:' + first]
    owned = {}
    for table, (key, columns, values) in tables.items():
        for path in paths:
            parameters = [fixture['library_id'], shared_id, path]
            if table == 'app.saved_loops':
                parameters.append('loop:' + path)
            row = connection.execute(f'insert into {table}(library_id,track_id,{key},{columns}) values(%s,%s,%s,{values}) returning id', parameters).fetchone()
            owned[(table, path)] = row[0]
    clone_path = duplicate if canonical_path_key else first
    parent_id = owned[('app.saved_loops', clone_path)]
    loop_file = clone_path + '.loop.flac'
    connection.execute('update app.saved_loops set loop_private_path=%s where id=%s', (loop_file, parent_id))
    child_id = connection.execute('insert into app.saved_loops(account_id,library_id,track_id,loop_key,parent_loop_id,source_private_path,start_seconds,end_seconds) values(%s,%s,%s,%s,%s,%s,1,5) returning id',
                                  (account_id, fixture['library_id'], shared_id, 'child:' + first, parent_id, loop_file)).fetchone()[0]
    owned[('app.saved_loops', 'child')] = child_id
    connection.execute('insert into app.saved_loop_orders(account_id,library_id,track_id,revision) values(%s,%s,%s,7)', (account_id, fixture['library_id'], shared_id))
    connection.commit()
    scoped.ensure_pending_relation_projection_ready(fixture['config'])
    before = {(table, path): connection.execute(f'select to_jsonb(row) from {table} row where id=%s', (row_id,)).fetchone()[0] for (table, path), row_id in owned.items()}
    fixture['updated'] = {first: {**fixture['previous'][first], 'album': 'New'}}
    _persist(fixture)
    track_ids = dict(connection.execute('select private_path,track_id from library.local_track_files where private_path=any(%s)', ([first, duplicate],)).fetchall())
    track_ids['child'] = track_ids[clone_path]
    for (table, path), row_id in owned.items():
        after = connection.execute(f'select to_jsonb(row) from {table} row where id=%s', (row_id,)).fetchone()[0]
        assert after == {**before[(table, path)], 'track_id': track_ids.get(path, shared_id)}
    orders = dict(connection.execute('select track_id,revision from app.saved_loop_orders where account_id=%s and library_id=%s', (account_id, fixture['library_id'])).fetchall())
    assert orders[shared_id] == 8
    assert orders[next(track_id for track_id in track_ids.values() if track_id != shared_id)] == 1


def test_first_saved_loop_waits_for_partition_and_rejects_stale_source(multi_destination_library, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from pathlib import Path
    from music_app.services import saved_loops_postgres as loops
    from music_app.services import scoped_relation_projection as scoped
    fixture = multi_destination_library
    first, _duplicate = _add_physical_copy(fixture)
    connection = fixture['connection']
    connection.execute('update library.local_track_files set private_path=%s where private_path=%s',
                       (str(Path(first).resolve()), first))
    connection.execute('update library.local_tracks set duration_seconds=180 where id=%s', (fixture['track_ids'][first],))
    connection.commit()
    scoped.ensure_pending_relation_projection_ready(fixture['config'])
    account_id = connection.execute('select owner_account_id from library.libraries where id=%s', (fixture['library_id'],)).fetchone()[0]
    # Hold the same logical-track lock as partitioning while a first loop is
    # created. There is deliberately no ordering row yet to serialize on.
    connection.execute('select id from library.local_tracks where id=%s for update', (fixture['track_ids'][first],)).fetchone()
    entered = Event()
    original_lock = loops._lock_song
    def signalled_lock(*args):
        entered.set()
        return original_lock(*args)
    monkeypatch.setattr(loops, '_lock_song', signalled_lock)
    adapter = loops.SavedLoopsPostgresAdapter(fixture['config'])
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(adapter.add_scoped_loop, account_id=account_id,
                             library_id=fixture['library_id'], item={
                                 'id': 'first-loop', 'source_path': first, 'start_seconds': 1,
                                 'end_seconds': 3, 'name': 'First loop', 'path': first + '.loop.flac'})
        try:
            if not entered.wait(5):
                future.result(timeout=1)
                pytest.fail('Loop creation did not reach its track lock')
            fixture['updated'] = {first: {**fixture['previous'][first], 'album': 'New'}}
            from psycopg.rows import dict_row, tuple_row
            from music_app.services.scan_cache_persistence import _partition_edited_physical_copies
            connection.row_factory = dict_row
            _partition_edited_physical_copies(connection, {first}, {first: fixture['previous'][first]}, fixture['updated'], apply=True)
            connection.row_factory = tuple_row
            connection.commit()
        finally:
            connection.rollback()
        with pytest.raises(loops.LoopOrderError, match='Source song changed'):
            future.result(timeout=10)
    assert connection.execute('select count(*) from app.saved_loops where library_id=%s', (fixture['library_id'],)).fetchone()[0] == 0


def test_partial_copy_identity_collision_is_rejected_before_media_write(multi_destination_library):
    from music_app.services.scan_cache_persistence import StructuralTagEditDestinationConflict
    fixture = multi_destination_library
    first, duplicate = _add_physical_copy(fixture)
    connection = fixture['connection']
    connection.execute('update library.local_tracks set track_key=%s where id=%s',
                       (duplicate, fixture['track_ids'][fixture['paths'][1]]))
    connection.commit()
    before = connection.execute('select id,track_id,private_path from library.local_track_files order by id').fetchall()
    fixture['updated'] = {first: {**fixture['previous'][first], 'album': 'New'}}
    with pytest.raises(StructuralTagEditDestinationConflict, match='conflicting stored track identity'):
        fixture['adapter'].validate_structural_tag_edit(
            changed_paths={first}, previous_file_entries=fixture['previous'],
            updated_file_entries=fixture['updated'], changed_field_names={'album'})
    assert connection.execute('select id,track_id,private_path from library.local_track_files order by id').fetchall() == before


def test_selected_edit_reconciles_artist_metadata_used_by_search_and_hydration(multi_destination_library):
    from music_app.services import scoped_relation_projection as scoped
    from music_app.services.library_inventory_postgres import PostgresLibraryInventoryRepository
    from music_app.services.library_browse_postgres import _non_album_entry_from_inventory_candidate
    fixture = multi_destination_library
    first = fixture['paths'][0]
    connection = fixture['connection']
    artist = fixture['previous'][first]['artist']
    fixture['previous'][first]['exception_type'] = 'custom collection'
    connection.execute("""update library.local_track_files set metadata=jsonb_set(metadata,
        '{scan_cache,file_entry,exception_type}','\"custom collection\"'::jsonb) where private_path=%s""", (first,))
    connection.execute("""update library.local_tracks set metadata=metadata || %s::jsonb where id=%s""",
                       (json.dumps({'artist':'Unknown Artist','artists':['Unknown Artist'],'owner_note':'preserve'}),fixture['track_ids'][first]))
    connection.commit()
    scoped.ensure_pending_relation_projection_ready(fixture['config'])
    inventory = PostgresLibraryInventoryRepository(fixture['config'])
    assert inventory.load_non_album_candidates(artist_names=['Unknown Artist'])
    fixture['changed_fields'] = {'genre'}
    fixture['updated'] = {first: {**fixture['previous'][first], 'genre':'Changed genre'}}
    _persist(fixture)
    assert inventory.load_non_album_candidates(artist_names=['Unknown Artist']) == []
    rows = inventory.load_non_album_candidates(artist_names=[artist])
    selected = next(row for row in rows if row['private_path']==first)
    metadata = connection.execute('select metadata from library.local_tracks where id=%s', (fixture['track_ids'][first],)).fetchone()[0]
    assert metadata['artist'] == artist
    assert metadata['artists'] == [artist]
    assert metadata['owner_note'] == 'preserve'
    assert _non_album_entry_from_inventory_candidate({**selected, 'file_entry':{}, 'raw_file_artist':None, 'raw_track_artist':None, 'track_metadata':metadata})['artist'] == artist


@pytest.mark.parametrize('different_existing_genre', [False, True])
def test_compatible_physical_copies_update_one_track_and_both_files(multi_destination_library, different_existing_genre):
    fixture = multi_destination_library
    first, duplicate = _add_physical_copy(fixture)
    if different_existing_genre:
        from music_app.services import scoped_relation_projection as scoped
        fixture['previous'][duplicate]['genre'] = 'Different existing genre'
        fixture['connection'].execute("""update library.local_track_files
            set metadata=jsonb_set(metadata,'{scan_cache,file_entry,genre}',%s::jsonb)
            where private_path=%s""", (json.dumps('Different existing genre'), duplicate))
        fixture['connection'].commit()
        scoped.ensure_pending_relation_projection_ready(fixture['config'])
    original_artists = fixture['connection'].execute(
        'select id,name,sort_name from library.local_artists order by id').fetchall()
    assert all(row[2] is None for row in original_artists)
    fixture['updated'] = {path: {**fixture['previous'][path], 'album': 'New'} for path in (first, duplicate)}
    fixture['adapter'].validate_structural_tag_edit(
        changed_paths=set(fixture['updated']), previous_file_entries=fixture['previous'],
        updated_file_entries=fixture['updated'], changed_field_names={'album'})
    result = _persist(fixture)
    assert result['track_rows_updated'] == 1
    assert result['track_file_rows_updated'] == 2
    rows = fixture['connection'].execute("""select files.private_path,files.track_id,
        files.metadata#>>'{scan_cache,file_entry,album}',albums.album_key
        from library.local_track_files files join library.local_tracks tracks on tracks.id=files.track_id
        join library.local_albums albums on albums.id=tracks.album_id
        where files.private_path=any(%s) order by files.private_path""", ([first, duplicate],)).fetchall()
    assert {row[0] for row in rows} == {first, duplicate}
    assert {row[1] for row in rows} == {fixture['track_ids'][first]}
    assert {row[2:] for row in rows} == {('New', fixture['projections']['New'].key)}
    assert fixture['connection'].execute(
        'select id,name,sort_name from library.local_artists order by id').fetchall() == original_artists
    if different_existing_genre:
        assert fixture['connection'].execute("""select metadata#>>'{scan_cache,file_entry,genre}'
            from library.local_track_files where private_path=%s""", (duplicate,)).fetchone()[0] == 'Different existing genre'


def test_copy_deltas_with_same_final_values_update_logical_track_deterministically(multi_destination_library):
    from music_app.services import scoped_relation_projection as scoped
    fixture = multi_destination_library
    first, duplicate = _add_physical_copy(fixture)
    fixture['previous'][duplicate]['title'] = 'Unified title'
    fixture['connection'].execute("""update library.local_track_files
        set metadata=jsonb_set(metadata,'{scan_cache,file_entry,title}',%s::jsonb)
        where private_path=%s""", (json.dumps('Unified title'), duplicate))
    fixture['connection'].commit()
    scoped.ensure_pending_relation_projection_ready(fixture['config'])
    fixture['updated'] = {path: {**fixture['previous'][path], 'album': 'New',
                                'title': 'Unified title', 'genre': 'Rock'} for path in (first, duplicate)}
    fixture['changed_fields'] = {'album', 'title', 'genre'}
    _persist(fixture)
    assert fixture['connection'].execute('select title from library.local_tracks where id=%s',
        (fixture['track_ids'][first],)).fetchone()[0] == 'Unified title'
    rows = fixture['connection'].execute("""select metadata#>>'{scan_cache,file_entry,title}',
        metadata#>>'{scan_cache,file_entry,genre}' from library.local_track_files
        where private_path=any(%s)""", ([first, duplicate],)).fetchall()
    assert rows == [('Unified title', 'Rock'), ('Unified title', 'Rock')]


@pytest.mark.parametrize('other_field', ['genre', 'artist'])
def test_heterogeneous_edits_do_not_expand_copy_owned_fields(multi_destination_library, other_field):
    from music_app.services import scoped_relation_projection as scoped
    fixture = multi_destination_library
    first, duplicate = _add_physical_copy(fixture)
    other = fixture['paths'][1]
    fixture['previous'][duplicate]['genre'] = 'Distinct existing genre'
    connection = fixture['connection']
    connection.execute("""update library.local_track_files
        set metadata=jsonb_set(metadata,'{scan_cache,file_entry,genre}',%s::jsonb)
        where private_path=%s""", (json.dumps('Distinct existing genre'), duplicate))
    connection.commit()
    scoped.ensure_pending_relation_projection_ready(fixture['config'])
    original_artist = connection.execute('select artist_id from library.local_tracks where id=%s',
                                        (fixture['track_ids'][first],)).fetchone()[0]
    original_genres = dict(connection.execute("""select private_path,metadata#>>'{scan_cache,file_entry,genre}'
        from library.local_track_files where private_path=any(%s)""", ([first, duplicate],)).fetchall())
    fixture['updated'] = {path: {**fixture['previous'][path], 'title': 'Shared new title'}
                          for path in (first, duplicate)}
    fixture['updated'][other] = {**fixture['previous'][other], other_field: 'Independent new value'}
    fixture['changed_fields'] = {'title', other_field}
    fixture['adapter'].validate_structural_tag_edit(
        changed_paths=set(fixture['updated']), previous_file_entries=fixture['previous'],
        updated_file_entries=fixture['updated'], changed_field_names=fixture['changed_fields'])
    _persist(fixture)
    assert connection.execute('select title,artist_id from library.local_tracks where id=%s',
                              (fixture['track_ids'][first],)).fetchone() == ('Shared new title', original_artist)
    assert dict(connection.execute("""select private_path,metadata#>>'{scan_cache,file_entry,genre}'
        from library.local_track_files where private_path=any(%s)""", ([first, duplicate],)).fetchall()) == original_genres
    assert connection.execute("""select metadata#>>%s::text[] from library.local_track_files
        where private_path=%s""", (['scan_cache', 'file_entry', other_field], other)).fetchone()[0] == 'Independent new value'


@pytest.mark.parametrize('rename_attached', [True, False])
def test_mixed_attached_title_and_detached_exception_clear_use_own_operation_fields(multi_destination_library, rename_attached):
    from music_app.services import scoped_relation_projection as scoped
    fixture = multi_destination_library
    first, detached, _remainder = fixture['paths']
    connection = fixture['connection']
    fixture['previous'][detached]['exception_type'] = 'Non-album rarity'
    connection.execute('update library.local_tracks set album_id=null where id=%s',
                       (fixture['track_ids'][detached],))
    connection.execute("""update library.local_track_files
        set metadata=jsonb_set(metadata,'{scan_cache,file_entry,exception_type}',%s::jsonb)
        where private_path=%s""", (json.dumps('Non-album rarity'), detached))
    connection.commit()
    scoped.ensure_pending_relation_projection_ready(fixture['config'])
    expected_title = 'Changed attached title' if rename_attached else fixture['previous'][first]['title']
    fixture['updated'] = {
        first: {**fixture['previous'][first], 'title': expected_title},
        detached: {**fixture['previous'][detached], 'exception_type': ''},
    }
    fixture['changed_fields'] = {'title', 'exception_type'}
    fixture['adapter'].validate_structural_tag_edit(
        changed_paths=set(fixture['updated']), previous_file_entries=fixture['previous'],
        updated_file_entries=fixture['updated'], changed_field_names=fixture['changed_fields'])
    result = _persist(fixture)
    assert result['track_rows_updated'] == 2
    assert connection.execute('select title,album_id from library.local_tracks where id=%s',
                              (fixture['track_ids'][first],)).fetchone() == (expected_title, fixture['albums']['Original'])
    assert connection.execute('select album_id from library.local_tracks where id=%s',
                              (fixture['track_ids'][detached],)).fetchone()[0] == fixture['albums']['Original']
    assert connection.execute("""select metadata#>>'{scan_cache,file_entry,exception_type}'
        from library.local_track_files where private_path=%s""", (detached,)).fetchone()[0] == ''


def test_copy_destination_conflict_in_unchanged_owner_fails_before_persistence(multi_destination_library):
    from music_app.services import scoped_relation_projection as scoped
    from music_app.services.scan_cache_persistence import StructuralTagEditDestinationConflict
    fixture = multi_destination_library
    first, duplicate = _add_physical_copy(fixture)
    fixture['previous'][duplicate]['album_artist'] = 'Different unchanged owner'
    connection = fixture['connection']
    connection.execute("""update library.local_track_files
        set metadata=jsonb_set(metadata,'{scan_cache,file_entry,album_artist}',%s::jsonb)
        where private_path=%s""", (json.dumps('Different unchanged owner'), duplicate))
    connection.commit()
    scoped.ensure_pending_relation_projection_ready(fixture['config'])
    fixture['updated'] = {path: {**fixture['previous'][path], 'album': 'New'} for path in (first, duplicate)}
    with pytest.raises(StructuralTagEditDestinationConflict):
        fixture['adapter'].validate_structural_tag_edit(
            changed_paths={first, duplicate}, previous_file_entries=fixture['previous'],
            updated_file_entries=fixture['updated'], changed_field_names={'album'})
    assert connection.execute('select album_id from library.local_tracks where id=%s',
                              (fixture['track_ids'][first],)).fetchone()[0] == fixture['albums']['Original']


def test_conflicting_physical_copies_fail_preflight_before_any_media_write(multi_destination_library):
    from music_app.services.edit_workflows import handle_edit_tags_request
    from tests.py.test_edit_workflows import _logger_stub
    fixture = multi_destination_library
    first, duplicate = _add_physical_copy(fixture)
    calls = []

    def prevalidate(**options):
        calls.append('prevalidate')
        fixture['adapter'].validate_structural_tag_edit(**options)

    def forbidden(*_args, **_kwargs):
        pytest.fail('Conflicting physical copies must be rejected before media writes or save-task creation')

    payload, status = handle_edit_tags_request(
        album={'name': 'Original', 'album_artist': fixture['previous'][first]['album_artist'],
               'tracks': [{'path': first}, {'path': duplicate}]},
        updates={first: {'album': 'Existing'}, duplicate: {'album': 'New'}},
        requested_track_paths={first, duplicate}, config=fixture['config'], logger=_logger_stub(),
        get_state=lambda: {'file_cache': fixture['previous'], 'separate_release_keys': set()},
        create_save_task=forbidden, queue_finalize_save_task=forbidden, apply_repairs_worker=forbidden,
        update_cache_entry_after_repairs=lambda path, entry, repairs: {**entry, **repairs, 'path': str(path)},
        build_affected_album_dicts=forbidden, load_separate_release_keys=lambda _config: set(),
        normalize_exception_value=lambda value: str(value or '').strip(),
        append_log_history=lambda *_args, **_kwargs: None, log_app_event=lambda *_args, **_kwargs: None,
        structural_edit_fields={'album'}, edit_write_workers=1,
        save_track_exception_override=forbidden, prevalidate_structural_tag_edit=prevalidate,
    )
    assert calls == ['prevalidate']
    assert status in {400, 409}
    assert payload['ok'] is False
    assert 'share one track' in payload['error'].lower()
    assert 'different tags' in payload['error'].lower()
    assert fixture['connection'].execute('select album_id from library.local_tracks where id=%s',
                                        (fixture['track_ids'][first],)).fetchone()[0] == fixture['albums']['Original']


@pytest.mark.parametrize(('field', 'values'), [('year', (2028, 2030)), ('edition', ('Deluxe', 'Collector'))])
def test_per_track_year_and_edition_destinations_remain_distinct(multi_destination_library, field, values):
    from music_app.services import scan_cache_persistence as persistence
    fixture = multi_destination_library
    selected = fixture['paths'][:2]
    fixture['changed_fields'] = {field}
    fixture['updated'] = {
        path: {**fixture['previous'][path], field: value,
               **({'release_date': str(value)} if field == 'year' else {})}
        for path, value in zip(selected, values)
    }
    expected = {
        path: persistence._structural_destination_album_projection(
            fixture['adapter']._build_albums, {path: entry}, frozenset({field}), set()).key
        for path, entry in fixture['updated'].items()
    }
    fixture['adapter'].validate_structural_tag_edit(
        changed_paths=set(selected), previous_file_entries=fixture['previous'],
        updated_file_entries=fixture['updated'], changed_field_names={field})
    result = _persist(fixture)
    assert len(set(result['destination_album_ids'])) == 2
    rows = fixture['connection'].execute("""select files.private_path,albums.album_key,
        files.metadata#>'{scan_cache,file_entry}',albums.release_year,albums.metadata->>'edition'
        from library.local_track_files files join library.local_tracks tracks on tracks.id=files.track_id
        join library.local_albums albums on albums.id=tracks.album_id
        where files.private_path=any(%s)""", (selected,)).fetchall()
    assert {row[0]: row[1] for row in rows} == expected
    for path, _key, entry, year, edition in rows:
        assert entry[field] == fixture['updated'][path][field]
        assert (year if field == 'year' else edition) == fixture['updated'][path][field]
    assert fixture['connection'].execute('select album_id from library.local_tracks where id=%s',
        (fixture['track_ids'][fixture['paths'][2]],)).fetchone()[0] == fixture['albums']['Original']


@pytest.mark.parametrize('track_count', [1, 2])
def test_multiple_detached_tracks_restore_to_separate_albums_atomically(multi_destination_library, track_count):
    from music_app.services import scoped_relation_projection as scoped
    fixture = multi_destination_library
    connection = fixture['connection']
    selected = [fixture['paths'][0], fixture['existing_path']][:track_count]
    fixture['previous'] = {**fixture['previous'], fixture['existing_path']: fixture['existing_entry']}
    for path in selected:
        fixture['previous'][path] = {**fixture['previous'][path], 'album': ''}
        connection.execute("""update library.local_tracks set album_id=null,
            metadata=jsonb_set(metadata,'{album}','""') where id=%s""", (fixture['track_ids'][path],))
        connection.execute("""update library.local_track_files set metadata=jsonb_set(metadata,
            '{scan_cache,file_entry}',%s::jsonb) where private_path=%s""", (json.dumps(fixture['previous'][path]), path))
    connection.commit()
    scoped.ensure_pending_relation_projection_ready(fixture['config'])
    fixture['updated'] = {path: {**fixture['previous'][path], 'album': f'Restored {index}'}
                          for index, path in enumerate(selected)}
    fixture['adapter'].validate_structural_tag_edit(
        changed_paths=set(selected), previous_file_entries=fixture['previous'],
        updated_file_entries=fixture['updated'], changed_field_names={'album'})
    result = _persist(fixture)
    destination_ids = set(result.get('destination_album_ids') or [result['destination_album_id']])
    assert len(destination_ids) == track_count
    rows = connection.execute("""select files.private_path,tracks.album_id,albums.title
        from library.local_track_files files join library.local_tracks tracks on tracks.id=files.track_id
        join library.local_albums albums on albums.id=tracks.album_id
        where files.private_path=any(%s)""", (selected,)).fetchall()
    assert {row[0]: row[2] for row in rows} == {path: entry['album'] for path, entry in fixture['updated'].items()}
    assert {row[1] for row in rows} == destination_ids
    assert scoped.tag_edit_baseline_ready(fixture['config'])
    assert not connection.execute('select 1 from library.local_relation_dirty_albums where library_id=%s',
                                  (fixture['library_id'],)).fetchone()
@pytest.mark.parametrize('stale_identity', [False, True])
def test_selected_genre_edit_preserves_missing_identity_keys_and_unselected_rows(
    multi_destination_library, stale_identity,
):
    from music_app.services import scoped_relation_projection as scoped

    fixture = multi_destination_library
    connection = fixture['connection']
    first = fixture['paths'][0]
    track_id = fixture['track_ids'][first]
    artist = fixture['previous'][first]['artist']
    metadata = {'owner_note': 'preserve'}
    if stale_identity:
        metadata.update(artist='Unknown Artist', artists=['Unknown Artist'])
    connection.execute('update library.local_tracks set metadata=%s::jsonb where id=%s',
                       (json.dumps(metadata), track_id))
    connection.commit()
    scoped.ensure_pending_relation_projection_ready(fixture['config'])
    before_unselected = connection.execute(
        'select id,to_jsonb(tracks),xmin::text from library.local_tracks tracks where id<>%s order by id',
        (track_id,)).fetchall()
    fixture['changed_fields'] = {'genre'}
    fixture['updated'] = {first: {**fixture['previous'][first], 'genre': 'Changed genre'}}

    _persist(fixture)

    expected = {**metadata, 'genre': 'Changed genre'}
    if stale_identity:
        expected.update(artist=artist, artists=[artist])
    assert connection.execute('select metadata from library.local_tracks where id=%s',
                              (track_id,)).fetchone()[0] == expected
    assert connection.execute(
        'select id,to_jsonb(tracks),xmin::text from library.local_tracks tracks where id<>%s order by id',
        (track_id,)).fetchall() == before_unselected
