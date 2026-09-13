"""Family album groups follow album-level credit ownership."""
from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory


def test_family_preview_excludes_guest_only_album_but_keeps_shared_album(watcher_repair_inventory):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
    fixture = watcher_repair_inventory
    own = fixture.entry("Simone/Vermillion/song.flac", artist="Simone Simons", album="Vermillion")
    own["album_artist"] = "Simone Simons"
    guest = fixture.entry("Charlotte/The Obsession/song.flac", artist="Charlotte Wessels / Simone Simons", album="The Obsession")
    guest["album_artist"] = "Charlotte Wessels"
    shared = fixture.entry("Charlotte/Shared/song.flac", artist="Charlotte Wessels", album="Shared Album")
    shared["album_artist"] = "Charlotte Wessels"
    fixture.seed(own, guest, shared)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""insert into library.local_album_featured_artists(library_id, album_id, artist_id, featured_kind)
            select a.library_id, a.id, ar.id, 'featured_member'
            from library.local_albums a join library.local_artists ar on ar.library_id=a.library_id
            where a.title='Shared Album' and ar.name='Simone Simons'""")
    repository = PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    state = {"visible_library_categories": ["main_library", "new_arrivals", "hoard"]}
    family = repository._load_artist_preview_rows(["Simone Simons"], state, family_only=True)
    assert {row["album_title"] for row in family} == {"Vermillion", "Shared Album"}
    selected = repository._load_selected_artist_preview_rows(["Simone Simons"], state)
    assert {row["album_title"] for row in selected} == {"Vermillion", "Shared Album", "The Obsession"}
