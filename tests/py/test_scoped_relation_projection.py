from copy import deepcopy

import pytest

from music_app.services import scoped_relation_projection as scoped
from music_app.services.relation_projection_builder import build_postgres_relation_views
from music_app.services.relation_projection_postgres import load_relation_source_rows_sql


def test_initialized_stale_readiness_never_falls_back_to_full_inventory(monkeypatch):
    import pytest
    from contextlib import nullcontext
    from music_app.services import relation_projection_postgres as relations

    class Snapshot:
        def execute(self, statement, *_args):
            assert statement == relations._load_relation_projection_sql()
            return self

        def fetchone(self):
            return {'normalized_relation_initialized': True,
                    'normalized_relation_ready': False,
                    'normalized_relation_dirty': False}

    def forbidden(*_args, **_kwargs):
        pytest.fail('An initialized stale read must not load the full inventory')

    monkeypatch.setattr(relations, 'load_relation_source_rows_sql', forbidden)
    with pytest.raises(RuntimeError, match='explicit startup reconciliation'):
        relations._ensure_relation_projection_ready(
            {'ALBUM_HAVEN_APP_DATABASE_URL': 'isolated'},
            connect=lambda _url: nullcontext(Snapshot()))


@pytest.mark.parametrize('started_owned,current_generation,current_owned,accepted', [
    (False, 4, False, True), (False, 5, True, True),
    (False, 5, False, False), (False, 6, True, False), (True, 5, True, False),
])
def test_scoped_publication_rejects_concurrent_legacy_generation_changes(
        monkeypatch, started_owned, current_generation, current_owned, accepted):
    from music_app.services import gallery_projection_postgres as gallery
    publications = []
    monkeypatch.setattr(gallery, 'patch_gallery_membership_in_transaction',
                        lambda *args, **kwargs: publications.append(kwargs))

    class Cursor:
        def fetchone(self):
            return {'generation': current_generation, 'owned': current_owned}

    class Connection:
        def execute(self, statement, params):
            return Cursor()

    def publish():
        scoped._finish_publication(Connection(), {
            'library_id': 1, 'gallery_generation': 4, 'gallery_owned': started_owned,
        }, {'source_fingerprint': 'version'}, {
            'processed_relation_album_ids': [1], 'affected_relation_album_ids': [1, 9],
            'affected_relation_album_keys': ['one', 'support'], 'affected_relation_aliases': {},
            'first_gallery_generation': 3,
            'relations_last_built': 123.0,
        }, reason='test', config={}, copy_legacy_views=False)

    if accepted:
        publish()
        assert publications[0]['expected_target_generation'] == current_generation
    else:
        with pytest.raises(RuntimeError, match='sources changed during scoped publication'):
            publish()
        assert not publications


def source(album_id, artist, folder, *, member=None):
    return {
        'album_id': album_id, 'owner_artist_name': artist, 'album_artist': artist,
        'member_artist_name': member, 'root_kind': 'main_library', 'library_root_id': '1',
        'root_path': 'C:/Music', 'relative_path': f'Rock/{folder}/Album/track.flac',
    }


def test_normalized_folder_relations_use_canonical_order_for_legacy_comparison():
    entries = scoped._view_entries({'folder_related': {'Owner': {'Zulu', 'Alpha'}}})
    assert entries[0]['payload'] == ['Alpha', 'Zulu']


def test_fact_connections_include_complete_folder_and_artist_alias_components():
    rows = [source(1, 'Artist', 'Family/Artist'), source(2, 'Artist & Guest', 'Family/Guest')]
    facts = scoped._fact_records(rows, {1: 'artist::album', 2: 'guest::album'})
    assert 'artist:artist' in facts[0]['connection_keys']
    assert 'signature:artist' in facts[0]['connection_keys']
    assert 'container:["1","rock","family"]' in facts[0]['connection_keys']
    assert 'container:["1","rock","family"]' in facts[1]['connection_keys']


def test_common_unknown_and_various_artists_do_not_join_unrelated_album_components():
    rows = [source(1, 'Various Artists', 'One', member='Unknown Artist'),
            source(2, 'Various Artists', 'Two', member='Unknown Artist')]
    first, second = scoped._fact_records(rows, {1: 'va::one', 2: 'va::two'})
    assert not set(first['connection_keys']) & set(second['connection_keys'])
    assert first['low_value_keys'] == ['unknown artist', 'various artists']
    assert first['low_value_artists'] == [
        {'name': 'Unknown Artist', 'key': 'unknown artist'},
        {'name': 'Various Artists', 'key': 'various artists'},
    ]


def test_projection_entries_do_not_expand_all_families_through_unknown_artist():
    views = build_postgres_relation_views([
        source(1, 'Unknown Artist', 'Family/Unknown'), source(2, 'Known Artist', 'Family/Known'),
    ])
    entries = scoped._view_entries(views)
    family = next(entry for entry in entries if entry['section'] == 'family_to_artists')
    assert family['artist_names'] == ['Known Artist']
    assert family['connection_keys'] == ['container:["1","rock","family"]']
    assert family['low_value_keys'] == ['unknown artist']
    known = next(entry for entry in entries if entry['section'] == 'folder_related' and entry['entry_key'] == 'Known Artist')
    assert known['artist_names'] == ['Known Artist']
    assert known['low_value_keys'] == ['unknown artist']


def test_projection_entry_sort_keys_use_python_casefold_including_unicode():
    views = build_postgres_relation_views([source(1, 'Straße', 'One'), source(2, 'ёж', 'Two')])
    entries = scoped._view_entries(views)
    assert next(entry for entry in entries if entry['section'] == 'artists' and entry['entry_key'] == 'Straße')['sort_key'] == 'strasse'


def test_committed_delta_preserves_unrelated_artists_aliases_counts_and_families():
    current = build_postgres_relation_views([
        source(1, 'Old', 'Old'), source(2, 'Unrelated', 'Unrelated/One'),
        source(3, 'Other', 'Unrelated/Two'),
    ])
    original = deepcopy(current)
    changed = build_postgres_relation_views([source(1, 'New', 'New')])
    removal = {entry['section']: [entry['entry_key']] for entry in scoped._view_entries(
        build_postgres_relation_views([source(1, 'Old', 'Old')]))}
    result = scoped.apply_relation_view_patch(current, {'remove': removal, 'upsert': changed})
    assert current == original
    assert result['artists'] == ['New', 'Other', 'Unrelated']
    assert result['artists_sidebar'] == [
        {'artist': 'New', 'count': 1}, {'artist': 'Other', 'count': 1}, {'artist': 'Unrelated', 'count': 1},
    ]
    assert result['family_to_artists'] == original['family_to_artists']
    assert result['folder_related']['Unrelated'] == original['folder_related']['Unrelated']
    assert result['alias_to_canonical']['Unrelated'] == 'Unrelated'
    assert 'Old' not in result['alias_to_canonical']


def test_late_runtime_delta_cannot_overwrite_a_more_recent_committed_change():
    state = {'relation_views': build_postgres_relation_views([source(1, 'Current', 'Current')]),
             'relations_last_built': 10.0, 'relation_patch_revision': 8}
    before = deepcopy(state)
    scoped.apply_committed_relation_state(state, {
        'relation_patch_revision': 7, 'relations_last_built': 9,
        'relation_view_patch': {'remove': {'artists': ['Current']}, 'upsert': {}},
    })
    assert state == before


def test_revision_gap_reloads_current_view_instead_of_losing_another_instances_edit(monkeypatch):
    current = build_postgres_relation_views([source(1, 'First Instance', 'One'), source(2, 'Second Instance', 'Two')])
    state = {'relation_views': build_postgres_relation_views([source(1, 'Old', 'One')]), 'relation_patch_revision': 1}
    calls = []
    monkeypatch.setattr(scoped, 'load_current_relation_state', lambda config: calls.append(config) or {
        'relation_views': current, 'relations_last_built': 10, 'relation_patch_revision': 4,
    })
    config = {'ALBUM_HAVEN_APP_DATABASE_URL': 'configured'}
    scoped.apply_committed_relation_state(state, {
        'relation_patch_revision': 3, 'relation_view_patch': {'remove': {}, 'upsert': {}},
    }, config=config)
    assert calls == [config]
    assert state['relation_views']['artists'] == ['First Instance', 'Second Instance']
    assert state['relation_patch_revision'] == 4


def test_scoped_family_publication_deletes_only_affected_owner_links():
    from music_app.services.artist_family_postgres import _replace_artist_family_projection_sql
    sql = _replace_artist_family_projection_sql(scoped=True)
    delete_clause = sql[sql.index('delete_existing as'):sql.index('input_row as')]
    assert 'artist_key=any(%(affected_keys)s::text[])' in delete_clause
    assert 'library_id=bootstrap_context.library_id' in delete_clause
    assert 'source_family = %(relationship_source)s' in delete_clause
    assert 'affected_keys' not in _replace_artist_family_projection_sql()


def test_scoped_source_query_restricts_album_ids_before_locations_and_artist_aggregation():
    full, targeted = load_relation_source_rows_sql(), load_relation_source_rows_sql(scoped=True)
    assert 'where library.local_tracks.album_id is not null' in full
    assert 'where library.local_tracks.album_id = any(%(album_ids)s::bigint[])' in targeted
    assert targeted.index('album_id = any(%(album_ids)s') < targeted.index('relation_locations as materialized')
    assert 'album_id is not null' not in targeted


def test_low_value_counts_restore_global_display_without_rebuilding_other_sources():
    class Cursor:
        def fetchall(self):
            return [{'name': 'Unknown Artist', 'key': 'unknown artist', 'count': 20},
                    {'name': 'unknown artist', 'key': 'unknown artist', 'count': 1}]

    class Connection:
        def execute(self, sql, params):
            assert 'low_value_keys &&' in sql
            assert params == (1, ['unknown artist'], ['unknown artist'])
            return Cursor()

    views = build_postgres_relation_views([
        source(1, 'unknown artist', 'Family/Unknown'), source(2, 'Known', 'Family/Known'),
    ])
    canonical = scoped._restore_low_value_counts(Connection(), 1, views, {'unknown artist'})
    assert canonical == {'unknown artist': 'Unknown Artist'}
    assert next(row['count'] for row in views['artists_sidebar'] if row['artist'] == 'Unknown Artist') == 21
    assert views['folder_related']['Known'] == {'Unknown Artist'}
    assert next(iter(views['family_to_artists'].values())) == {'Known', 'Unknown Artist'}


class IndexedFactsConnection:
    def __init__(self, records, previous_views):
        self.records = records
        self.entries = scoped._view_entries(previous_views)
        self.loaded_ids = set()

    def execute(self, sql, params):
        class Cursor:
            def __init__(self, rows):
                self.rows = rows
            def fetchall(self):
                return self.rows
        if 'local_relation_projection_entries' in sql:
            _, names, connections = params
            return Cursor([row for row in self.entries
                           if row['section'] in {'canonical_to_aliases', 'family_to_artists'}
                           and (set(row['artist_names']).intersection(names)
                                or set(row['connection_keys']).intersection(connections))])
        assert 'local_relation_album_facts' in sql
        _, keys = params
        rows = [row for row in self.records if set(row['connection_keys']).intersection(keys)]
        self.loaded_ids.update(row['album_id'] for row in rows)
        return Cursor(rows)


def test_compilation_coappearance_does_not_traverse_guest_discographies():
    rows = [source(1, 'A', 'A'),
            source(2, 'Various Artists', 'Soundtrack', member='A'),
            source(2, 'Various Artists', 'Soundtrack', member='B'),
            source(3, 'B', 'B'),
            source(4, 'Various Artists', 'Compilation', member='B'),
            source(4, 'Various Artists', 'Compilation', member='C'),
            source(5, 'C', 'C')]
    rows.extend(source(i, f'Unrelated {i}', f'Unrelated {i}') for i in range(6, 1006))
    records = scoped._fact_records(rows, {row['album_id']: str(row['album_id']) for row in rows})
    current = build_postgres_relation_views(rows)
    connection = IndexedFactsConnection(records, current)
    _, names, _, views = scoped._load_affected_component(connection, 1, [records[0]], [records[0]], None)
    assert connection.loaded_ids == {1, 2}
    assert names == {'A'}
    assert views['artists_sidebar'] == [{'artist': 'A', 'count': 2}]
    assert views['alias_to_canonical'] == {'A': 'A'}
    assert views['family_to_artists'] == {}


def test_actual_folder_family_expands_and_preserves_complete_artist_counts():
    rows = [source(1, 'A', 'Family/A'), source(2, 'B', 'Family/B'), source(3, 'B', 'Solo'),
            source(4, 'Various Artists', 'Soundtrack', member='B'),
            source(4, 'Various Artists', 'Soundtrack', member='C'), source(5, 'C', 'C')]
    records = scoped._fact_records(rows, {row['album_id']: str(row['album_id']) for row in rows})
    current = build_postgres_relation_views(rows)
    connection = IndexedFactsConnection(records, current)
    _, names, _, views = scoped._load_affected_component(connection, 1, [records[0]], [records[0]], None)
    assert connection.loaded_ids == {1, 2, 3, 4}
    assert names == {'A', 'B'}
    assert views['artists_sidebar'] == [{'artist': 'A', 'count': 1}, {'artist': 'B', 'count': 3}]
    assert views['family_to_artists'] == current['family_to_artists']
    assert views['folder_related'] == current['folder_related']


def test_foreground_edit_does_not_consume_unrelated_dirty_backlog():
    import pytest
    from music_app.services.relation_projection_postgres import RELATION_PROJECTION_BUILDER_VERSION

    class Cursor:
        def __init__(self, rows):
            self.rows = rows
        def fetchone(self):
            return self.rows[0] if self.rows else None
        def fetchall(self):
            return self.rows

    class Connection:
        def execute(self, sql, params=None):
            if sql == scoped._CONTEXT:
                return Cursor([{'library_id': 1, 'normalized_builder_version': RELATION_PROJECTION_BUILDER_VERSION,
                                'normalized_source_fingerprint': 'source',
                                'normalized_publication_xid': '1',
                                'metadata': {'builder_version': RELATION_PROJECTION_BUILDER_VERSION,
                                             'source_fingerprint': 'source',
                                             'built_from_fingerprint': 'source'}}])
            if 'from library.local_relation_compatibility_state' in sql:
                return Cursor([{'legacy_semantics': scoped.LEGACY_ALIAS_POLICY,
                                'current_semantics': scoped.CURRENT_ALIAS_POLICY,
                                'source_fingerprint': 'source', 'publication_xid': '1'}])
            if 'from library.local_albums' in sql:
                return Cursor([{'id': 1, 'album_key': 'one'}])
            if 'from library.local_relation_album_facts' in sql:
                return Cursor([])
            if 'select 1 from library.local_relation_dirty_albums' in sql:
                assert params == (1, [1])
                return Cursor([{'exists': 1}])
            if 'select album_id,first_inventory_revision' in sql:
                assert 'from library.local_relation_dirty_albums' in sql
                assert 'order by album_id limit 5' in sql
                assert params == (1, [1])
                return Cursor([{'album_id': 2, 'first_inventory_revision': 1,
                                'first_gallery_generation': 1, 'first_change_xid': '1',
                                'publication_xid': '2'}])
            raise AssertionError(f'Foreground must not read backlog sources or write projections: {sql}')

    with pytest.raises(RuntimeError, match='still being reconciled'):
        scoped.publish_affected_relation_projection(Connection(), album_ids=[1])


def test_tag_edit_admission_reads_only_projection_markers():
    class Cursor:
        def fetchone(self):
            return {'ready': True}

    class Connection:
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            return False
        def execute(self, sql, params):
            assert 'local_tracks' not in sql
            assert 'local_albums' not in sql
            assert 'local_relation_album_facts' not in sql
            assert 'local_relation_dirty_albums' in sql
            assert 'header.source_generation<>gallery.generation' in sql
            return Cursor()

    assert scoped.tag_edit_baseline_ready({'ALBUM_HAVEN_APP_DATABASE_URL': 'isolated'}, connect=lambda _: Connection())


def test_removed_canonical_recomputes_surviving_alias_without_guest_expansion():
    original = [source(1, 'Artist', 'One'), source(2, 'Artist', 'Two'),
                source(3, 'Various Artists', 'Soundtrack', member='artist'),
                source(3, 'Various Artists', 'Soundtrack', member='Guest'), source(4, 'Guest', 'Guest')]
    old = scoped._fact_records(original[:2], {1: 'one', 2: 'two'})
    remaining = scoped._fact_records(original[2:], {3: 'soundtrack', 4: 'guest'})
    connection = IndexedFactsConnection(remaining, build_postgres_relation_views(original))
    _, names, _, views = scoped._load_affected_component(connection, 1, old, [], None)
    assert connection.loaded_ids == {3}
    assert names == {'Artist', 'artist'}
    assert views['artists_sidebar'] == [{'artist': 'artist', 'count': 1}]
    assert views['alias_to_canonical'] == {'artist': 'artist'}
    assert views['canonical_to_aliases'] == {'artist': ['artist']}


def test_publication_clears_only_locked_journal_rows_not_support_albums():
    calls = []

    class Cursor:
        def fetchall(self):
            return []

    class Connection:
        def execute(self, sql, params):
            calls.append((sql, params))
            return Cursor()

    scoped._finish_publication(Connection(), {'library_id': 1}, {'source_fingerprint': 'version'}, {
        'processed_relation_album_ids': [1],
        'affected_relation_album_ids': [1, 9],
        'relations_last_built': 123.0,
    }, reason='test', config=None, copy_legacy_views=False)
    deletions = [(sql, params) for sql, params in calls if sql.startswith('delete')]
    assert len(deletions) == 1
    assert deletions[0][1] == (1, [1])


def test_support_gallery_artist_keeps_existing_canonical_alias_without_source_expansion():
    from music_app.services.library_browse_postgres import _prepare_root_gallery_snapshot

    class Cursor:
        def fetchall(self):
            return [{'entry_key': 'A', 'payload': 'A'},
                    {'entry_key': 'guest alias', 'payload': 'Guest Canonical'}]

    class Connection:
        def execute(self, sql, params):
            assert 'local_relation_projection_entries' in sql
            assert "section='alias_to_canonical'" in sql
            assert 'entry_key=any' in sql
            assert params == (1, ['A', 'guest alias'])
            return Cursor()

    aliases = scoped._published_aliases(Connection(), 1, {'A', 'guest alias'})
    snapshot = _prepare_root_gallery_snapshot([
        {'artist_name': 'A', 'album_id': 2, 'album_key': 'various artists::soundtrack',
         'album_title': 'Soundtrack', 'album_release_year': 2026},
        {'artist_name': 'guest alias', 'album_id': 2, 'album_key': 'various artists::soundtrack',
         'album_title': 'Soundtrack', 'album_release_year': 2026},
    ], [], aliases, {})
    assert {row['artist_name'] for row in snapshot['ordered']} == {'A', 'Guest Canonical'}
    assert {entry['artist'] for entry in snapshot['sidebar']} == {'A', 'Guest Canonical'}


def test_atomic_multigroup_delta_uses_its_exact_base_without_summary_reload(monkeypatch):
    original = build_postgres_relation_views([source(1, 'Old', 'One'), source(2, 'Unrelated', 'Two')])
    updated = build_postgres_relation_views([source(1, 'New', 'One')])
    state = {'relation_views': original, 'relation_patch_revision': 7}
    def unexpected_reload(*_args, **_kwargs):
        raise AssertionError('An exact atomic baseline must not reload the full summary')

    monkeypatch.setattr(scoped, 'load_current_relation_state', unexpected_reload)
    scoped.apply_committed_relation_state(state, {
        'relation_patch_base_revision': 7, 'relation_patch_revision': 10,
        'relation_view_patch': {'remove': {'artists': ['Old']}, 'upsert': updated},
    }, config={})
    assert state['relation_patch_revision'] == 10
    assert state['relation_views']['artists'] == ['New', 'Unrelated']


def test_atomic_multigroup_delta_with_wrong_base_still_reloads_current_state(monkeypatch):
    for base in (None, 6, 11):
        state = {'relation_views': {}, 'relation_patch_revision': 7}
        calls = []
        monkeypatch.setattr(scoped, 'load_current_relation_state', lambda config: calls.append(config) or {
            'relation_views': {'artists': ['Authoritative']}, 'relation_patch_revision': 10})
        scoped.apply_committed_relation_state(state, {
            'relation_patch_base_revision': base, 'relation_patch_revision': 10,
            'relation_view_patch': {'remove': {}, 'upsert': {}},
        }, config={'owner': 'test'})
        assert calls == [{'owner': 'test'}]
        assert state['relation_views'] == {'artists': ['Authoritative']}
