"""Logical ownership survives targeted edits, scan publication and cache reload."""
from pathlib import Path

from music_app.services import gallery_projection_postgres as gallery
from music_app.services import relation_projection_postgres as relations
from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory


def ready(fixture):
    relations.ensure_relation_projection_ready(fixture.config, connect=isolatedPostgres._connect)
    gallery.ensure_gallery_projection_ready(fixture.config, connect=isolatedPostgres._connect)


def album_state(fixture, title):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        album = connection.execute("""select albums.id,albums.album_key,albums.metadata,owner.name as owner
          from library.local_albums albums left join library.local_artists owner on owner.id=albums.artist_id
          where albums.title=%s""", (title,)).fetchone()
        assert album is not None
        credits = connection.execute("""select artist.name,credit.featured_kind
          from library.local_album_featured_artists credit join library.local_artists artist on artist.id=credit.artist_id
          where credit.album_id=%s order by artist.name,credit.featured_kind""", (album['id'],)).fetchall()
        return album, {(row['name'],row['featured_kind']) for row in credits}


def republish_loaded_snapshot(fixture):
    cache = fixture.adapter.load_snapshot(Path('unused-watcher-repair.json'), 'watcher-repair')[0]
    fixture.adapter.save_snapshot(Path('unused-watcher-repair.json'), cache, 'watcher-repair', 2.0,
        observed_library_root_ids={root['id'] for root in fixture.roots})
    ready(fixture)
    return cache


def test_named_owner_featured_partner_survives_targeted_and_full_publication(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    lead = fixture.entry('Control/Cross/one.flac', artist='Control Lead', album='Control Cross Credits')
    partner = fixture.entry('Control/Cross/two.flac', artist='Control Partner', album='Control Cross Credits')
    for entry in (lead,partner):
        entry.update(album_artist='Control Lead',is_compilation=False,compilation_tag=None)
    fixture.seed(lead,partner)
    ready(fixture)
    before, credits = album_state(fixture,'Control Cross Credits')
    assert before['owner'] == before['metadata']['album_artist'] == 'Control Lead'
    assert before['metadata']['is_split_album'] is False
    assert ('Control Partner','featured_member') in credits
    assert ('Control Partner','owner') not in credits
    updated = {**lead,'title':'Updated selected track'}
    fixture.adapter.persist_targeted_inventory_mutation(root_id=fixture.roots[0]['id'],
        active_file_entries={updated['path']:updated})
    ready(fixture)
    assert album_state(fixture,'Control Cross Credits')[1] == credits, 'Targeted publication changed stable credits'
    cache = republish_loaded_snapshot(fixture)
    after, after_credits = album_state(fixture,'Control Cross Credits')
    assert (after['id'],after['album_key'],after['owner']) == (before['id'],before['album_key'],'Control Lead')
    assert after['metadata']['album_artist'] == 'Control Lead'
    assert after_credits == credits
    assert {row['album_artist'] for row in cache.values()} == {'Control Lead'}


def test_single_various_artist_subset_retains_solo_owner_after_watch_and_reload(watcher_repair_inventory, monkeypatch):
    fixture = watcher_repair_inventory
    solo = fixture.entry('Various/Mixed/one.flac', artist='Solo Voice', album='Mixed Credits')
    other = fixture.entry('Various/Mixed/two.flac', artist='Other Voice', album='Mixed Credits')
    for entry in (solo,other):
        entry.update(album_artist='Various Artists',is_compilation=True,compilation_tag=None)
    fixture.seed(solo,other)
    ready(fixture)
    selected = {**solo,'album':'Solo Split'}
    fixture.adapter.persist_structural_tag_edit(changed_paths={solo['path']},
        previous_file_entries={solo['path']:solo},updated_file_entries={solo['path']:selected},
        changed_field_names={'album'},rebuild_relation_projection=True)
    before, credits = album_state(fixture,'Solo Split')
    assert before['owner'] == before['metadata']['album_artist'] == 'Solo Voice'
    assert ('Solo Voice','owner') in credits
    # Watcher metadata still contains the untouched physical VA credit and may
    # carry the old source album's derived compilation classification.
    fixture.adapter.persist_targeted_inventory_mutation(root_id=fixture.roots[0]['id'],
        active_file_entries={selected['path']:selected})
    ready(fixture)
    assert album_state(fixture,'Solo Split')[1] == credits, captured
    cache = republish_loaded_snapshot(fixture)
    after, after_credits = album_state(fixture,'Solo Split')
    assert (after['id'],after['album_key'],after['owner']) == (before['id'],before['album_key'],'Solo Voice')
    assert after['metadata']['album_artist'] == 'Solo Voice'
    assert after_credits == credits
    assert cache[selected['path']]['album_artist'] == 'Various Artists'
    assert cache[selected['path']]['compilation_tag'] is None



def test_e2e_album_inspection_helpers_resolve_ownerless_compilations_without_overriding_owners(
    watcher_repair_inventory,
):
    import base64

    fixture = watcher_repair_inventory
    first = fixture.entry('Various/Compilation/01.flac', artist='Belle Stars', album='Helper Compilation')
    second = fixture.entry('Various/Compilation/02.flac', artist='Guest Voice', album='Helper Compilation')
    for entry in (first, second):
        entry.update(album_artist='Various Artists', compilation_tag=True, is_compilation=True)
    named = fixture.entry('Named/Release/01.flac', artist='Helper Owner', album='Helper Named Release')
    named['album_artist'] = 'Helper Owner'
    fixture.seed(first, second, named)

    def inspect(helper, artist, album, *, year=2026, edition=''):
        sql = (Path(__file__).resolve().parents[1] / 'e2e' / 'helpers' / helper).read_text()
        params = {
            key + '_b64': base64.b64encode(value.encode('utf-8')).decode('ascii')
            for key, value in {'artist': artist, 'album': album, 'edition': edition}.items()
        }
        params['year'] = year
        for key in params:
            sql = sql.replace(":'" + key + "'", '%(' + key + ')s')
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            return connection.execute(sql, params).fetchone()['coalesce']

    identity = 'postgresAlbumIdentityQuery.sql'
    tracks = 'postgresAlbumTrackMetadataQuery.sql'
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        compilation = connection.execute(
            "select artist_id from library.local_albums where title='Helper Compilation'"
        ).fetchone()
        assert compilation['artist_id'] is None
    assert [row['track_count'] for row in inspect(identity, 'Various Artists', 'Helper Compilation')] == [2]
    assert {row['path'] for row in inspect(tracks, 'Various Artists', 'Helper Compilation')} == {
        first['path'], second['path'],
    }
    assert inspect(identity, 'Various Artists', 'Helper Compilation', year=2000) == []
    assert inspect(identity, 'Various Artists', 'Helper Compilation', edition='Deluxe') == []
    assert inspect(identity, 'Various Artists', 'Missing Release') == []
    assert inspect(identity, 'Guest Voice', 'Helper Compilation') == []
    assert inspect(tracks, 'Guest Voice', 'Helper Compilation') == []

    with isolatedPostgres._connect(fixture.setup_url) as connection:
        owner = connection.execute(
            "select artist_id from library.local_albums where title='Helper Named Release'"
        ).fetchone()
        assert owner['artist_id'] is not None
        connection.execute(
            """update library.local_albums set metadata=jsonb_set(
                   metadata, '{album_artist}', '"Conflicting Metadata Owner"'::jsonb)
               where title='Helper Named Release'"""
        )
    assert [row['track_count'] for row in inspect(identity, 'Helper Owner', 'Helper Named Release')] == [1]
    assert [row['path'] for row in inspect(tracks, 'Helper Owner', 'Helper Named Release')] == [named['path']]
    assert inspect(identity, 'Conflicting Metadata Owner', 'Helper Named Release') == []
    assert inspect(tracks, 'Conflicting Metadata Owner', 'Helper Named Release') == []
