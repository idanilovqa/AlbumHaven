"""Real candidate filtering without losing complete-file stale classification."""

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory


def test_missing_artist_scope_preserves_aliases_and_complete_membership(watcher_repair_inventory):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    fixture = watcher_repair_inventory
    owner = fixture.entry("Owner/Missing/one.flac", album="Missing")
    alias = {**fixture.entry("Alias/Missing/one.flac", album="Alias Missing"),
             "album_artist": "Former Name", "artist": "Former Name"}
    unrelated = {**fixture.entry("Other/Missing/one.flac", album="Unrelated"),
                 "album_artist": "Other", "artist": "Other"}
    stale_member = fixture.entry("Owner/Mixed/stale.flac", album="Mixed")
    active_member = fixture.entry("Owner/Mixed/active.flac", root=1, album="Mixed")
    fixture.seed(owner, alias, unrelated, stale_member, active_member)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""
            update library.local_track_files
            set metadata = jsonb_set(metadata, '{scan_cache,stale}', 'true'::jsonb)
            where private_path <> %s
        """, (active_member["path"],))

    repository = PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    scoped = repository._load_missing_album_rows(artist_names=["Owner", "Former Name"])
    assert {row["album_key"] for row in scoped} == {"owner::missing", "former name::alias missing"}
    assert {row["file_private_path"] for row in scoped} == {owner["path"], alias["path"]}
    assert repository._load_missing_album_rows(artist_names=[]) == []
    assert {row["album_key"] for row in repository._load_missing_album_rows()} == {
        "owner::missing", "former name::alias missing", "other::unrelated",
    }
    assert {row["album_key"] for row in repository._load_missing_album_rows("other::unrelated")} == {
        "other::unrelated",
    }
