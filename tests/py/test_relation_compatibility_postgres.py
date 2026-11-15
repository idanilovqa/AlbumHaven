"""Mixed-version contracts stay exact without whole-inventory reconciliation."""
import pytest
from psycopg.types.json import Jsonb

from music_app.services import gallery_projection_postgres as gallery
from music_app.services import relation_projection_postgres as relations
from music_app.services import scoped_relation_projection as scoped
from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory


@pytest.fixture
def compatibility_inventory(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    fixture.joint = fixture.entry('Shared/Era/Joint/one.flac', artist="Luca Turilli's Rhapsody", album='Joint')
    fixture.solo = fixture.entry('Shared/Era/Solo/two.flac', artist='Rhapsody', album='Solo')
    fixture.unrelated = fixture.entry('Unrelated/Third/three.flac', artist='Unrelated', album='Third')
    for entry in (fixture.joint, fixture.solo, fixture.unrelated):
        entry['album_artist'] = entry['artist']
    fixture.seed(fixture.joint, fixture.solo, fixture.unrelated)
    relations.ensure_relation_projection_ready(fixture.config, connect=isolatedPostgres._connect)
    gallery.ensure_gallery_projection_ready(fixture.config, connect=isolatedPostgres._connect)
    return fixture


def contracts(connection):
    return connection.execute(
        """select library.local_relation_views(library.id,true) as current,
          library.local_relation_compatibility_views(library.id) as legacy,
          library.metadata #> '{scan_cache,relation_views}' as shared
          from library.libraries library where library.library_kind='local'"""
    ).fetchone()


def forbid_global_sources(monkeypatch):
    original = relations.load_relation_source_rows_sql
    def only_scoped(*args, **kwargs):
        assert kwargs.get('scoped') is True, 'Compatibility attempted a global source inventory read'
        return original(*args, **kwargs)
    monkeypatch.setattr(relations, 'load_relation_source_rows_sql', only_scoped)


def test_scoped_edit_maintains_distinct_exact_legacy_and_current_contracts(compatibility_inventory, monkeypatch):
    fixture = compatibility_inventory
    forbid_global_sources(monkeypatch)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        before = contracts(connection)
    assert before['current']['alias_to_canonical']["Luca Turilli's Rhapsody"] == "Luca Turilli's Rhapsody"
    assert before['legacy']['alias_to_canonical']["Luca Turilli's Rhapsody"] == 'Rhapsody'
    assert before['shared'] == before['legacy']
    updated = {**fixture.joint, 'title': 'Updated title'}
    PostgresScanCacheAdapter(fixture.config, connect=isolatedPostgres._connect).persist_targeted_inventory_mutation(
        root_id=fixture.roots[0]['id'], active_file_entries={updated['path']: updated})
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        after = contracts(connection)
        assert after == before
        assert connection.execute('select count(*) as count from library.local_relation_dirty_albums').fetchone()['count'] == 0
        assert connection.execute(
            """select current.last_publication_xid=legacy.last_publication_xid as same
            from library.local_relation_projection_state current
            join library.local_relation_compatibility_state legacy using(library_id)"""
        ).fetchone()['same'] is True


def test_scoped_dual_publication_does_not_dirty_itself_and_next_edit_succeeds(compatibility_inventory, monkeypatch):
    fixture = compatibility_inventory
    forbid_global_sources(monkeypatch)
    added = fixture.entry('New Partnership/one.flac', artist="Luca Turilli's Rhapsody / New Partner", album='New Joint')
    adapter = PostgresScanCacheAdapter(fixture.config, connect=isolatedPostgres._connect)
    adapter.persist_targeted_inventory_mutation(
        root_id=fixture.roots[0]['id'], active_file_entries={added['path']: added})
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute('select album_id from library.local_relation_dirty_albums').fetchall() == []
        published = contracts(connection)
        assert published['shared'] == published['legacy']
        assert published['current']['alias_to_canonical'] != published['legacy']['alias_to_canonical']
    changed = {**added, 'title': 'Second scoped update'}
    adapter.persist_targeted_inventory_mutation(
        root_id=fixture.roots[0]['id'], active_file_entries={changed['path']: changed})
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute('select album_id from library.local_relation_dirty_albums').fetchall() == []


@pytest.mark.parametrize('fault', [
    None, 'compatibility_xid', 'normalized_xid', 'fingerprint', 'builder',
    'stamp', 'missing_section', 'extra_section', 'aliases', 'pending_receipt',
    'preexisting_journal', 'later_conflict', 'normalized_null', 'missing_compatibility',
    'null_payload', 'wrong_section_type', 'normalized_valid',
    'normalized_forged_folder', 'normalized_forged_artists',
])
def test_dual_publication_proof_fails_closed_and_preserves_prior_journal(compatibility_inventory, fault):
    fixture = compatibility_inventory
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        library_id = connection.execute("select id from library.libraries where name='Local Library'").fetchone()['id']
        views = contracts(connection)['legacy']
        # Arrange a different old payload without retaining this test-only setup write.
        connection.execute("update library.libraries set metadata=jsonb_set(metadata,'{scan_cache,relation_views,alias_to_canonical}','{}') where id=%s", (library_id,))
        connection.execute('delete from library.local_relation_dirty_albums where library_id=%s and album_id in (-1,0)', (library_id,))
        connection.execute('update library.local_relation_projection_state set last_publication_xid=pg_current_xact_id() where library_id=%s', (library_id,))
        connection.execute('update library.local_relation_compatibility_state set last_publication_xid=pg_current_xact_id() where library_id=%s', (library_id,))
        if fault == 'compatibility_xid':
            connection.execute("update library.local_relation_compatibility_state set last_publication_xid='1'::xid8 where library_id=%s", (library_id,))
        elif fault == 'normalized_xid':
            connection.execute("update library.local_relation_projection_state set last_publication_xid='1'::xid8 where library_id=%s", (library_id,))
        elif fault == 'normalized_null':
            connection.execute('update library.local_relation_projection_state set last_publication_xid=null where library_id=%s', (library_id,))
        elif fault == 'missing_compatibility':
            connection.execute('delete from library.local_relation_compatibility_state where library_id=%s', (library_id,))
        elif fault == 'fingerprint':
            connection.execute("update library.local_relation_compatibility_state set source_fingerprint='forged' where library_id=%s", (library_id,))
        elif fault == 'stamp':
            connection.execute('update library.local_relation_compatibility_state set relations_last_built=relations_last_built+1 where library_id=%s', (library_id,))
        elif fault == 'pending_receipt':
            connection.execute("update library.local_relation_compatibility_state set pending_scan_receipt='{}',pending_scan_xid=pg_current_xact_id() where library_id=%s", (library_id,))
        elif fault == 'builder':
            connection.execute("update library.local_relation_projection_state set builder_version='forged' where library_id=%s", (library_id,))
        elif fault == 'missing_section':
            views.pop('folder_related')
        elif fault == 'extra_section':
            views['unproven_section'] = []
        elif fault == 'aliases':
            views['alias_to_canonical'] = {'Forged': 'Unrelated'}
        elif fault == 'null_payload':
            views = None
        elif fault == 'wrong_section_type':
            views['folder_related'] = []
        elif fault in ('normalized_valid', 'normalized_forged_folder', 'normalized_forged_artists'):
            views = contracts(connection)['current']
            if fault == 'normalized_forged_folder':
                views['folder_related'] = {'Forged': ['Unrelated']}
            elif fault == 'normalized_forged_artists':
                views['artists'] = ['Forged artist']
        elif fault == 'preexisting_journal':
            connection.execute('select library.mark_relation_album_dirty(%s,-1)', (library_id,))
        prior = connection.execute('select * from library.local_relation_dirty_albums where library_id=%s and album_id=-1', (library_id,)).fetchall()
        connection.execute("update library.libraries set metadata=jsonb_set(metadata,'{scan_cache,relation_views}',%s) where id=%s", (Jsonb(views), library_id))
        if fault == 'later_conflict':
            assert connection.execute('select album_id from library.local_relation_dirty_albums where library_id=%s and album_id=-1', (library_id,)).fetchall() == []
            connection.execute("update library.libraries set metadata=jsonb_set(metadata,'{scan_cache,relation_views,alias_to_canonical}',%s) where id=%s", (Jsonb({'Forged': 'Unrelated'}), library_id))
        after = connection.execute('select * from library.local_relation_dirty_albums where library_id=%s and album_id=-1', (library_id,)).fetchall()
        if fault is None or fault == 'normalized_valid':
            assert connection.execute('select album_id from library.local_relation_dirty_albums where library_id=%s and album_id<=0', (library_id,)).fetchall() == []
        elif fault in ('normalized_forged_folder', 'normalized_forged_artists'):
            assert connection.execute('select album_id from library.local_relation_dirty_albums where library_id=%s and album_id=0', (library_id,)).fetchall()
        elif fault == 'preexisting_journal':
            assert after == prior and len(after) == 1
        else:
            assert len(after) == 1


def test_explicit_compatibility_preparation_uses_cached_facts_and_is_idempotent(compatibility_inventory, monkeypatch):
    fixture = compatibility_inventory
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute('delete from library.local_relation_compatibility_entries')
        connection.execute('delete from library.local_relation_compatibility_state')
        assert connection.execute("select library.local_relation_views(id) is null as unproven from library.libraries where library_kind='local'").fetchone()['unproven'] is True
    forbid_global_sources(monkeypatch)
    assert scoped.prepare_relation_compatibility(fixture.config, connect=isolatedPostgres._connect)['compatibility_prepared'] is True
    assert scoped.prepare_relation_compatibility(fixture.config, connect=isolatedPostgres._connect)['compatibility_prepared'] is False
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        result = contracts(connection)
        assert result['shared'] == result['legacy']
        assert result['current'] != result['legacy']


def test_compatibility_preparation_rejects_forged_untouched_alias(compatibility_inventory, monkeypatch):
    fixture = compatibility_inventory
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        before = contracts(connection)
        forged = {**before['shared'], 'alias_to_canonical': {**before['shared']['alias_to_canonical'], 'Forged': 'Unrelated'}}
        connection.execute('delete from library.local_relation_compatibility_entries')
        connection.execute('delete from library.local_relation_compatibility_state')
        connection.execute(
            "update library.libraries set metadata=jsonb_set(metadata,'{scan_cache,relation_views}',%s::jsonb) where library_kind='local'",
            (Jsonb(forged),))
    forbid_global_sources(monkeypatch)
    with pytest.raises(RuntimeError, match='Legacy publication differs'):
        scoped.prepare_relation_compatibility(fixture.config, connect=isolatedPostgres._connect)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute('select count(*) as count from library.local_relation_compatibility_state').fetchone()['count'] == 0
        assert contracts(connection)['shared'] == forged


def test_old_search_writer_cannot_overwrite_current_search_index(compatibility_inventory):
    fixture = compatibility_inventory
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        current_before = connection.execute('select * from library.local_artist_search_projection_current order by normalized_artist_key').fetchall()
        connection.execute(
            "update library.local_artist_search_projection set canonical_artist_name='Legacy-only overwrite'")
        assert connection.execute('select * from library.local_artist_search_projection_current order by normalized_artist_key').fetchall() == current_before
        assert current_before


def test_compatibility_preparation_rolls_back_shadow_rows_on_failure(compatibility_inventory, monkeypatch):
    fixture = compatibility_inventory
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        before = contracts(connection)
        connection.execute('delete from library.local_relation_compatibility_entries')
        connection.execute('delete from library.local_relation_compatibility_state')
    def fail_state(*args, **kwargs):
        raise RuntimeError('Injected compatibility state publication failure')
    monkeypatch.setattr(scoped, '_store_compatibility_state', fail_state)
    with pytest.raises(RuntimeError, match='Injected compatibility state'):
        scoped.prepare_relation_compatibility(fixture.config, connect=isolatedPostgres._connect)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute('select count(*) as count from library.local_relation_compatibility_entries').fetchone()['count'] == 0
        assert connection.execute('select count(*) as count from library.local_relation_compatibility_state').fetchone()['count'] == 0
        assert contracts(connection)['shared'] == before['shared']


def test_compatibility_preparation_rejects_fingerprint_change_without_journal(compatibility_inventory):
    fixture = compatibility_inventory
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        metadata = connection.execute("select metadata #> '{scan_cache,relation_projection}' as value from library.libraries where library_kind='local'").fetchone()['value']
        changed = {**metadata, 'source_fingerprint': 'f' * 64, 'built_from_fingerprint': 'f' * 64}
        connection.execute("update library.libraries set metadata=jsonb_set(metadata,'{scan_cache,relation_projection}',%s::jsonb) where library_kind='local'", (Jsonb(changed),))
        connection.execute('delete from library.local_relation_dirty_albums')
    with pytest.raises(RuntimeError, match='without journal evidence'):
        scoped.prepare_relation_compatibility(fixture.config, connect=isolatedPostgres._connect)


def test_family_reader_isolates_legacy_links_and_keeps_manual_links(compatibility_inventory):
    from music_app.services.artist_family_postgres import load_selected_artist_family_artists
    fixture = compatibility_inventory
    joint = "Luca Turilli's Rhapsody"
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        current_before = connection.execute("select * from library.local_artist_family_links_current where source_family='folder_derived_current_v11' order by id").fetchall()
        assert current_before
        connection.execute("""insert into library.local_artist_family_links
          (library_id,artist_id,related_artist_id,source_family)
          select owner.library_id,owner.id,related.id,'folder_derived_runtime'
          from library.local_artists owner join library.local_artists related on related.library_id=owner.library_id
          where owner.name=%s and related.name='Unrelated'
          on conflict(library_id,artist_id,related_artist_id,relationship_weight,source_family) do nothing""", (joint,))
    assert 'Unrelated' not in load_selected_artist_family_artists(fixture.config, joint, connect=isolatedPostgres._connect)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("update library.local_artist_family_links set source_family='manual_test' where source_family='folder_derived_runtime'")
        assert connection.execute("select * from library.local_artist_family_links_current where source_family='folder_derived_current_v11' order by id").fetchall() == current_before
    assert 'Unrelated' in load_selected_artist_family_artists(fixture.config, joint, connect=isolatedPostgres._connect)


@pytest.mark.parametrize('pending_native_scan', [False, True])
def test_old_full_publication_replays_only_affected_sources_with_isolated_current_indexes(compatibility_inventory, monkeypatch, pending_native_scan):
    from music_app.services.cache import serialize_relation_views
    from music_app.services.relation_projection_builder import build_postgres_relation_views, LEGACY_ALIAS_POLICY
    fixture = compatibility_inventory
    if pending_native_scan:
        queue_mixed_policy_native_scan(fixture)
    changed_artist = 'Unrelated'
    updated_name = changed_artist + ' Updated'
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        unchanged = connection.execute("select to_jsonb(entries) as payload, xmin::text as revision from library.local_artist_search_projection_current_entries entries where normalized_artist_key=%s", ("luca turilli's rhapsody",)).fetchone()
        assert unchanged is not None
        connection.execute("update library.local_artists set name=%s, artist_key=%s where name=%s", (updated_name, updated_name.casefold(), changed_artist))
        rows = connection.execute(relations.load_relation_source_rows_sql()).fetchall()
        legacy = build_postgres_relation_views(rows, alias_policy=LEGACY_ALIAS_POLICY)
        expected_current = serialize_relation_views(build_postgres_relation_views(rows))
        expected_legacy = serialize_relation_views(legacy)
        metadata = relations.build_ready_relation_projection_metadata(
            relations.relation_source_fingerprint(rows), reason='legacy_full_writer', duration_ms=0, source_row_count=len(rows))
        cache = connection.execute("select metadata->'scan_cache' as cache from library.libraries where library_kind='local'").fetchone()['cache']
        stamp = float(cache['relations_last_built']) + 1
        cache.update(relation_views=serialize_relation_views(legacy), relations_last_built=stamp, relation_projection=metadata)
        relations.replace_artist_family_projection_in_transaction(connection, legacy, relations_last_built=stamp, legacy=True)
        relations.replace_artist_search_projection_in_transaction(connection, legacy, metadata=metadata, relations_last_built=stamp, legacy=True)
        connection.execute(relations._save_scan_cache_sql(), {'scan_cache': Jsonb(cache)})
        visible = connection.execute("select library.local_relation_views(id) as views from library.libraries where library_kind='local'").fetchone()['views']
        assert visible['alias_to_canonical']["Luca Turilli's Rhapsody"] == "Luca Turilli's Rhapsody"
        readiness = connection.execute(relations._load_relation_projection_sql()).fetchone()
        assert readiness['normalized_relation_ready'] is False
        assert readiness['normalized_relation_dirty'] is True
    patch_calls = []
    patch_search = scoped._patch_search_rows
    def record_patch(*args, **kwargs):
        patch_calls.append({'legacy': kwargs.get('legacy', False), 'names': sorted(args[2])})
        return patch_search(*args, **kwargs)
    monkeypatch.setattr(scoped, '_patch_search_rows', record_patch)
    forbid_global_sources(monkeypatch)
    result = relations.ensure_relation_projection_ready(fixture.config, connect=isolatedPostgres._connect)
    assert result['ready'] is True
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        current = contracts(connection)
        assert current['current']['alias_to_canonical']["Luca Turilli's Rhapsody"] == "Luca Turilli's Rhapsody"
        assert current['current'] == expected_current
        assert current['legacy'] == expected_legacy
        assert current['current']['alias_to_canonical'][updated_name] == updated_name
        current_names = {name for call in patch_calls if not call['legacy'] for name in call['names']}
        assert "Luca Turilli's Rhapsody" not in current_names
        assert current['shared'] == current['legacy']
        assert connection.execute("select to_jsonb(entries) as payload, xmin::text as revision from library.local_artist_search_projection_current_entries entries where normalized_artist_key=%s", ("luca turilli's rhapsody",)).fetchone() == unchanged, patch_calls
        projected_metadata = connection.execute(
            'select source_fingerprint, relations_last_built from library.local_artist_search_projection_current where normalized_artist_key=%s',
            ("luca turilli's rhapsody",)).fetchone()
        assert projected_metadata == {'source_fingerprint': metadata['source_fingerprint'], 'relations_last_built': stamp}
        assert unchanged['payload']['source_fingerprint'] != metadata['source_fingerprint']
        assert connection.execute('select count(*) as count from library.local_relation_dirty_albums').fetchone()['count'] == 0

        assert connection.execute('select pending_scan_receipt,pending_scan_xid from library.local_relation_compatibility_state').fetchone() == {'pending_scan_receipt': None, 'pending_scan_xid': None}


def test_legacy_family_reader_cannot_see_current_automatic_links(compatibility_inventory):
    fixture = compatibility_inventory
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        old_rows = connection.execute("""select related.name from library.local_artist_family_links links
          join library.local_artists owner on owner.id=links.artist_id
          join library.local_artists related on related.id=links.related_artist_id
          where owner.name=%s""", ("Luca Turilli's Rhapsody",)).fetchall()
        current_rows = connection.execute("""select related.name from library.local_artist_family_links_current links
          join library.local_artists owner on owner.id=links.artist_id
          join library.local_artists related on related.id=links.related_artist_id
          where owner.name=%s""", ("Luca Turilli's Rhapsody",)).fetchall()
        assert 'Rhapsody' in {row['name'] for row in current_rows}
        assert 'Rhapsody' not in {row['name'] for row in old_rows}


def test_targeted_artist_edit_removes_legacy_only_edge_without_rewriting_current_mapping(compatibility_inventory, monkeypatch):
    from music_app.services.cache import serialize_relation_views
    from music_app.services.relation_projection_builder import build_postgres_relation_views, LEGACY_ALIAS_POLICY
    fixture = compatibility_inventory
    source_sql = relations.load_relation_source_rows_sql()
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        before = connection.execute("select to_jsonb(entries) as payload, xmin::text as revision from library.local_artist_search_projection_current_entries entries where normalized_artist_key=%s", ("luca turilli's rhapsody",)).fetchone()
        assert contracts(connection)['legacy']['alias_to_canonical']["Luca Turilli's Rhapsody"] == 'Rhapsody'
    calls = []
    patch_search = scoped._patch_search_rows
    def record_patch(*args, **kwargs):
        calls.append({'legacy': kwargs.get('legacy', False), 'names': sorted(args[2])})
        return patch_search(*args, **kwargs)
    monkeypatch.setattr(scoped, '_patch_search_rows', record_patch)
    forbid_global_sources(monkeypatch)
    updated = {**fixture.solo, 'artist': 'Rhapsody Updated', 'album_artist': 'Rhapsody Updated'}
    PostgresScanCacheAdapter(fixture.config, connect=isolatedPostgres._connect).persist_targeted_inventory_mutation(
        root_id=fixture.roots[0]['id'], active_file_entries={updated['path']: updated})
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        rows = connection.execute(source_sql).fetchall()
        actual = contracts(connection)
        assert actual['current'] == serialize_relation_views(build_postgres_relation_views(rows))
        assert actual['legacy'] == serialize_relation_views(build_postgres_relation_views(rows, alias_policy=LEGACY_ALIAS_POLICY))
        assert actual['shared'] == actual['legacy']
        assert actual['legacy']['alias_to_canonical']["Luca Turilli's Rhapsody"] == "Luca Turilli's Rhapsody"
        assert 'Unrelated' not in {name for call in calls for name in call['names']}
        assert connection.execute("select to_jsonb(entries) as payload, xmin::text as revision from library.local_artist_search_projection_current_entries entries where normalized_artist_key=%s", ("luca turilli's rhapsody",)).fetchone() == before, calls


def test_current_search_replace_rejects_null_fingerprint_before_deleting_rows(compatibility_inventory):
    import psycopg
    fixture = compatibility_inventory
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        query = 'select to_jsonb(entries) as payload, xmin::text as revision from library.local_artist_search_projection_current_entries entries order by normalized_artist_key'
        before = connection.execute(query).fetchall()
        assert before
        with pytest.raises(psycopg.Error):
            with connection.transaction():
                connection.execute('select library.replace_local_artist_search_projection_current(%s::jsonb,%s,%s,%s)',
                                   (Jsonb([]), relations.RELATION_PROJECTION_BUILDER_VERSION, None, 123.0))
        assert connection.execute(query).fetchall() == before


def test_current_search_patch_rejects_null_fingerprint_before_deleting_rows(compatibility_inventory):
    import psycopg
    fixture = compatibility_inventory
    key = "luca turilli's rhapsody"
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        before = connection.execute(
            'select to_jsonb(entries) as payload, xmin::text as revision from library.local_artist_search_projection_current_entries entries where normalized_artist_key=%s', (key,)).fetchone()
        assert before is not None
        valid = ([key], Jsonb([]), relations.RELATION_PROJECTION_BUILDER_VERSION, 'a' * 64, 123.0)
        for index in (3, 2, 4, 0, 1):
            args = list(valid)
            args[index] = None
            with pytest.raises(psycopg.Error, match='projection_source_fingerprint' if index == 3 else None):
                with connection.transaction():
                    connection.execute(
                        'select library.patch_local_artist_search_projection_current(%s,%s::jsonb,%s,%s,%s)', args)
            assert connection.execute(
                'select to_jsonb(entries) as payload, xmin::text as revision from library.local_artist_search_projection_current_entries entries where normalized_artist_key=%s', (key,)).fetchone() == before


def queue_mixed_policy_native_scan(fixture):
    added = fixture.entry('Added/Fourth/four.flac', artist='Added Artist', album='Fourth')
    added['album_artist'] = added['artist']
    fixture.seed(fixture.joint, fixture.solo, fixture.unrelated, added)


@pytest.mark.parametrize('fail_first', [False, True])
def test_native_scan_preserves_proven_legacy_baseline_and_replays_receipted_changes(compatibility_inventory, monkeypatch, fail_first):
    from music_app.services.cache import serialize_relation_views
    from music_app.services.relation_projection_builder import build_postgres_relation_views, LEGACY_ALIAS_POLICY
    fixture = compatibility_inventory
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        before = contracts(connection)
    queue_mixed_policy_native_scan(fixture)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        pending = contracts(connection)
        state_before = connection.execute('select * from library.local_relation_compatibility_state').fetchone()
        dirty_before = connection.execute('select * from library.local_relation_dirty_albums order by album_id').fetchall()
        rows = connection.execute(relations.load_relation_source_rows_sql()).fetchall()
        assert pending['shared'] == before['legacy']
        assert state_before['pending_scan_receipt'] is not None
    forbid_global_sources(monkeypatch)
    def forbidden_preparation(*args, **kwargs):
        pytest.fail('Native scan replay must not bootstrap all cached facts')
    monkeypatch.setattr(scoped, '_prepare_compatibility_in_transaction', forbidden_preparation)
    if fail_first:
        upsert = scoped._upsert_entries
        calls = []
        def fail_once(*args, **kwargs):
            if not calls:
                calls.append(True)
                raise RuntimeError('Injected native replay failure')
            return upsert(*args, **kwargs)
        monkeypatch.setattr(scoped, '_upsert_entries', fail_once)
        with pytest.raises(RuntimeError, match='Injected native replay failure'):
            relations.ensure_relation_projection_ready(fixture.config, connect=isolatedPostgres._connect)
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            assert connection.execute('select * from library.local_relation_compatibility_state').fetchone() == state_before
            assert connection.execute('select * from library.local_relation_dirty_albums order by album_id').fetchall() == dirty_before
            assert contracts(connection) == pending
    result = relations.ensure_relation_projection_ready(fixture.config, connect=isolatedPostgres._connect)
    assert result['ready'] is True
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        actual = contracts(connection)
        assert actual['current'] == serialize_relation_views(build_postgres_relation_views(rows))
        assert actual['legacy'] == serialize_relation_views(build_postgres_relation_views(rows, alias_policy=LEGACY_ALIAS_POLICY))
        assert actual['shared'] == actual['legacy']
        assert connection.execute('select pending_scan_receipt from library.local_relation_compatibility_state').fetchone()['pending_scan_receipt'] is None
        assert connection.execute('select count(*) as count from library.local_relation_dirty_albums').fetchone()['count'] == 0


@pytest.mark.parametrize('corruption', ['raw_legacy', 'shadow', 'deleted_journal', 'recreated_journal', 'extra_journal', 'receipt', 'capture_xid'])
def test_native_scan_receipt_rejects_changed_evidence(compatibility_inventory, monkeypatch, corruption):
    fixture = compatibility_inventory
    queue_mixed_policy_native_scan(fixture)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        if corruption == 'raw_legacy':
            connection.execute("update library.libraries set metadata=jsonb_set(metadata,'{scan_cache,relation_views,alias_to_canonical,Forged}', '\"Unrelated\"'::jsonb) where library_kind='local'")
        elif corruption == 'shadow':
            connection.execute("update library.local_relation_compatibility_entries set payload='\"Forged\"'::jsonb where section='alias_to_canonical' and entry_key='Unrelated'")
        elif corruption in {'deleted_journal', 'recreated_journal'}:
            record = connection.execute('delete from library.local_relation_dirty_albums where album_id=(select max(album_id) from library.local_relation_dirty_albums where album_id>0) returning *').fetchone()
            assert record is not None
            if corruption == 'recreated_journal':
                connection.execute("""insert into library.local_relation_dirty_albums
                    (library_id,album_id,album_keys,first_inventory_revision,first_gallery_generation,first_change_xid)
                    values (%s,%s,%s,%s,%s,pg_current_xact_id())""",
                    (record['library_id'], record['album_id'], record['album_keys'], record['first_inventory_revision'], record['first_gallery_generation']))
        elif corruption == 'extra_journal':
            connection.execute("""insert into library.local_relation_dirty_albums
                (library_id,album_id,album_keys,first_inventory_revision,first_gallery_generation,first_change_xid)
                select library_id,999999999,'{}',0,0,pg_current_xact_id() from library.local_relation_compatibility_state""")
        elif corruption == 'capture_xid':
            connection.execute("update library.local_relation_compatibility_state set pending_scan_receipt=jsonb_set(pending_scan_receipt,'{capture_xid}', '\"forged-transaction\"'::jsonb)")
        else:
            connection.execute("update library.local_relation_compatibility_state set pending_scan_receipt=jsonb_set(pending_scan_receipt,'{source_fingerprint}', to_jsonb(repeat('f',64)))")
        before = contracts(connection)
        state_before = connection.execute('select * from library.local_relation_compatibility_state').fetchone()
        dirty_before = connection.execute('select * from library.local_relation_dirty_albums order by album_id').fetchall()
    forbid_global_sources(monkeypatch)
    with pytest.raises(RuntimeError, match='[Pp]ending scan|[Rr]etained legacy'):
        relations.ensure_relation_projection_ready(fixture.config, connect=isolatedPostgres._connect)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert contracts(connection) == before
        assert connection.execute('select * from library.local_relation_compatibility_state').fetchone() == state_before
        assert connection.execute('select * from library.local_relation_dirty_albums order by album_id').fetchall() == dirty_before


def test_native_scan_receipt_includes_final_commit_hook_journal(compatibility_inventory, monkeypatch):
    from pathlib import Path
    fixture = compatibility_inventory
    added = fixture.entry('Added/Fourth/four.flac', artist='Added Artist', album='Fourth')
    added['album_artist'] = added['artist']
    hook_ids = []

    def final_hook(connection):
        row = connection.execute("""insert into library.local_relation_dirty_albums
          (library_id,album_id,album_keys,first_inventory_revision,first_gallery_generation,first_change_xid)
          select library_id,-42,'{}',first_inventory_revision,first_gallery_generation,pg_current_xact_id()
          from library.local_relation_dirty_albums order by album_id limit 1 returning album_id""").fetchone()
        hook_ids.append(row['album_id'])

    fixture.adapter.save_snapshot(Path('unused-watcher-repair.json'),
        {item['path']: item for item in (fixture.joint, fixture.solo, fixture.unrelated, added)},
        'watcher-repair', 1.0, observed_library_root_ids={root['id'] for root in fixture.roots},
        before_commit=final_hook)
    assert hook_ids == [-42]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        receipt = connection.execute('select pending_scan_receipt from library.local_relation_compatibility_state').fetchone()['pending_scan_receipt']
        assert -42 in {row['album_id'] for row in receipt['journal']}
    forbid_global_sources(monkeypatch)
    assert relations.ensure_relation_projection_ready(fixture.config, connect=isolatedPostgres._connect)['ready']
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute('select count(*) as count from library.local_relation_dirty_albums').fetchone()['count'] == 0
        state = connection.execute('select pending_scan_receipt,pending_scan_xid from library.local_relation_compatibility_state').fetchone()
        assert state == {'pending_scan_receipt': None, 'pending_scan_xid': None}
