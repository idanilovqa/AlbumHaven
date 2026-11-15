"""Old full writers remain compatible without a foreground inventory rebuild."""
import pytest
from psycopg.types.json import Jsonb

from tests.py.test_multidestination_tag_edit_postgres import multi_destination_library
from tests.py.test_postgres_structural_tag_edit import _CommitSuppressingConnection


@pytest.mark.parametrize('publication', ['valid', 'wrong_untouched_component', 'journal_gap'])
def test_background_replay_verifies_complete_legacy_contract(multi_destination_library, monkeypatch, publication):
    from music_app.services import relation_projection_postgres as relations
    from music_app.services import scoped_relation_projection as scoped
    from music_app.services.cache import serialize_relation_views

    fixture = multi_destination_library
    connection = fixture['connection']
    wrapped = _CommitSuppressingConnection(connection)
    library_id = fixture['library_id']
    previous_fingerprint = connection.execute('select source_fingerprint from library.local_relation_projection_state where library_id=%s', (library_id,)).fetchone()[0]
    previous_headers = connection.execute('select scope_key,source_generation,revision from library.gallery_membership_headers where library_id=%s order by scope_key', (library_id,)).fetchall()
    connection.execute("""update library.local_artists set name=name || ' legacy'
        where id=(select artist_id from library.local_albums where id=%s)""", (fixture['albums']['Original'],))
    rows = wrapped.execute(relations.load_relation_source_rows_sql()).fetchall()
    if publication == 'wrong_untouched_component':
        rows.append({**rows[0], 'album_id': 999999999, 'owner_artist_name': 'Invented untouched artist',
                     'album_artist': 'Invented untouched artist', 'member_artist_name': None})
    from music_app.services.relation_projection_builder import LEGACY_ALIAS_POLICY
    views = relations.build_postgres_relation_views(rows, alias_policy=LEGACY_ALIAS_POLICY)
    fingerprint = relations.relation_source_fingerprint(rows)
    metadata = relations.build_ready_relation_projection_metadata(
        fingerprint, reason='legacy_full_writer', duration_ms=0, source_row_count=len(rows))
    cache = connection.execute("select metadata->'scan_cache' from library.libraries where id=%s", (library_id,)).fetchone()[0]
    stamp = float(cache.get('relations_last_built') or 0) + 1
    cache.update(relation_views=serialize_relation_views(views), relations_last_built=stamp,
                 relation_projection=metadata)
    relations.replace_artist_family_projection_in_transaction(wrapped, views, relations_last_built=stamp, legacy=True)
    relations.replace_artist_search_projection_in_transaction(wrapped, views, metadata=metadata, relations_last_built=stamp, legacy=True)
    wrapped.execute(relations._save_scan_cache_sql(), {'scan_cache': Jsonb(cache)})
    if publication == 'journal_gap':
        connection.execute('update library.local_relation_dirty_albums set first_gallery_generation=first_gallery_generation+1 where library_id=%s', (library_id,))
    connection.commit()
    journal = connection.execute('select album_id,first_gallery_generation from library.local_relation_dirty_albums where library_id=%s order by album_id', (library_id,)).fetchall()
    assert any(row[0] == -1 for row in journal)
    connection.commit()
    source_sql = relations.load_relation_source_rows_sql

    def bounded_sources(*, scoped=False):
        assert scoped, 'Background legacy adoption must not reload the full inventory'
        return source_sql(scoped=True)

    monkeypatch.setattr(relations, 'load_relation_source_rows_sql', bounded_sources)
    if publication == 'valid':
        result = scoped.ensure_pending_relation_projection_ready(fixture['config'])
        assert result['updated']
        assert connection.execute('select library.local_relation_views(%s,true)', (library_id,)).fetchone()[0] == cache['relation_views']
        assert not connection.execute('select 1 from library.local_relation_dirty_albums where library_id=%s', (library_id,)).fetchone()
        current = connection.execute('select generation from library.gallery_projection_state where library_id=%s', (library_id,)).fetchone()[0]
        assert all(row[0] == current for row in connection.execute('select source_generation from library.gallery_membership_headers where library_id=%s', (library_id,)).fetchall())
    else:
        with pytest.raises(RuntimeError, match='differs from the scoped source rebuild|baseline is unavailable'):
            scoped.ensure_pending_relation_projection_ready(fixture['config'])
        assert connection.execute('select album_id,first_gallery_generation from library.local_relation_dirty_albums where library_id=%s order by album_id', (library_id,)).fetchall() == journal
        assert connection.execute('select source_fingerprint from library.local_relation_projection_state where library_id=%s', (library_id,)).fetchone()[0] == previous_fingerprint
        assert connection.execute('select scope_key,source_generation,revision from library.gallery_membership_headers where library_id=%s order by scope_key', (library_id,)).fetchall() == previous_headers
