"""Real persistence checks for complete targeted album aggregates."""

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory


@pytest.mark.parametrize("other_root", [False, True])
@pytest.mark.parametrize("mutation", ["retag", "delete"])
def test_targeted_album_metadata_uses_every_retained_member(watcher_repair_inventory, other_root, mutation):
    fixture = watcher_repair_inventory
    changed = fixture.entry("Owner/First/song.flac", artist="Owner feat. Old Guest")
    retained = fixture.entry("Owner/Other/song.flac", root=int(other_root), artist="Owner feat. Retained Guest")
    unrelated = fixture.entry("Other/Unrelated/song.flac", artist="Owner feat. Unrelated Guest", album="Unrelated")
    fixture.seed(changed, retained, unrelated)

    def albums():
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            return {row["album_key"]: row for row in connection.execute(
                "select album_key, artist_id, metadata from library.local_albums order by album_key"
            ).fetchall()}

    before = albums()
    replacement = {**changed, "artist": "Owner feat. New Guest"}
    fixture.adapter.persist_targeted_inventory_mutation(
        root_id="repair-main",
        active_file_entries={changed["path"]: replacement} if mutation == "retag" else {},
        deleted_paths=(changed["path"],) if mutation == "delete" else (),
    )
    after = albums()
    album = after["owner::repair album"]
    expected_artists = {"Retained Guest", "New Guest"} if mutation == "retag" else {"Retained Guest"}
    assert album["metadata"]["artists"] == ["Owner"]
    assert set(album["metadata"]["featured_artists"]) == expected_artists
    categories = {"hoard"} if other_root and mutation == "delete" else {"main_library", "hoard"} if other_root else {"main_library"}
    assert set(album["metadata"]["root_provenance"]["categories"]) == categories
    assert album["artist_id"] == before["owner::repair album"]["artist_id"]
    assert after["owner::unrelated"] == before["owner::unrelated"]


@pytest.mark.parametrize("mixed_album", [False, True])
def test_watcher_cleanup_removes_all_owned_albums_or_refuses_mixed_ownership(watcher_repair_inventory, mixed_album):
    from pathlib import Path
    from tests.e2e.support import watcherFixture

    fixture = watcher_repair_inventory
    owned = fixture.entry("cases/watcher-reconciliation/Owner/Target/song.flac", album="Target")
    sibling = fixture.entry("cases/watcher-reconciliation/Owner/Sibling/song.flac", album="Sibling")
    outside = fixture.entry("cases/watcher-reconciliation-other/Owner/Outside/song.flac", album="Target" if mixed_album else "Outside")
    fixture.seed(owned, sibling, outside)
    owned_root = Path(fixture.roots[0]["path"]) / "cases" / "watcher-reconciliation"
    for item in (owned, sibling):
        Path(item["path"]).unlink()

    def inventory():
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            return connection.execute("select private_path, metadata from library.local_track_files order by private_path").fetchall()

    before = inventory()
    if mixed_album:
        with pytest.raises(RuntimeError, match="outside"):
            watcherFixture.remove_watched_inventory(owned_root)
        assert inventory() == before, "the entire cleanup must roll back before mutating mixed ownership"
    else:
        watcherFixture.remove_watched_inventory(owned_root)
        assert [row["private_path"] for row in inventory()] == [outside["path"]]
        assert Path(outside["path"]).exists(), "prefix collision is outside fixture ownership"
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            assert [row["album_key"] for row in connection.execute("select album_key from library.local_albums").fetchall()] == ["owner::outside"]
            revision = connection.execute("select metadata ->> 'inventory_mutation_revision' as revision from library.libraries where library_kind = 'local'").fetchone()["revision"]
        watcherFixture.remove_watched_inventory(owned_root)
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            assert connection.execute("select metadata ->> 'inventory_mutation_revision' as revision from library.libraries where library_kind = 'local'").fetchone()["revision"] == revision
