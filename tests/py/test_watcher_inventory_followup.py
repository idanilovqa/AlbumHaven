"""Causal watcher recovery and complete membership regressions from PR review."""

from pathlib import Path

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory


@pytest.mark.parametrize("failure_at", ["initial", "replacement"])
@pytest.mark.parametrize("explicit_stop", [False, True])
def test_failed_watcher_attachment_retries_on_recovery_unless_explicitly_stopped(failure_at, explicit_stop):
    from music_app.services.library_watch import LibraryWatchService

    class Source:
        is_alive = False
        fail_next = failure_at == "initial"
        starts = 0
        roots = ()

        def start(self, publish):
            self.starts += 1
            if self.fail_next:
                self.fail_next = False
                raise OSError("temporary native attachment failure")
            self.is_alive = True
            publish(tuple(self.roots))

        def stop(self, *, timeout):
            self.is_alive = False

        def replace_roots(self, roots):
            assert not self.is_alive
            self.roots = tuple(root["id"] for root in roots)

    source, published = Source(), []
    service = LibraryWatchService(source, published.append)
    roots = [{"id": "restored", "path": "unused-injected-source"}]
    if failure_at == "replacement":
        assert service.start()
        source.fail_next = True
    with pytest.raises(OSError, match="temporary native attachment"):
        service.start() if failure_at == "initial" else service.replace_roots(roots)
    assert not service.is_alive
    attempts = source.starts
    if explicit_stop:
        service.stop()
    assert service.replace_roots(roots)
    assert source.starts == attempts + (0 if explicit_stop else 1)
    assert service.is_alive is not explicit_stop
    if not explicit_stop:
        assert published[-1] == ("restored",)
    service.stop()


@pytest.mark.parametrize("other_root", [False, True])
def test_live_in_place_retag_reconciles_previous_album_credits(watcher_repair_inventory, other_root):
    fixture = watcher_repair_inventory
    changed = fixture.entry("Owner/First Copy/one.flac", artist="Owner feat. Departing Guest")
    retained = fixture.entry("Owner/Other Copy/two.flac", root=int(other_root), artist="Owner feat. Retained Guest")
    unrelated = fixture.entry("Owner/Unrelated/three.flac", artist="Owner feat. Unrelated Guest", album="Unrelated")
    fixture.seed(changed, retained, unrelated)
    moved = {**changed, "album": "Destination Album"}
    fixture.adapter.persist_targeted_inventory_mutation(
        root_id="repair-main", active_file_entries={changed["path"]: moved},
    )
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        rows = connection.execute("""
            select album.album_key, artist.name from library.local_album_featured_artists membership
            join library.local_albums album on album.id = membership.album_id
            join library.local_artists artist on artist.id = membership.artist_id
            where membership.featured_kind = 'featured_track_artist'
        """).fetchall()
        tracks = connection.execute("""
            select file.private_path, album.album_key, file.scan_cache_stale
            from library.local_track_files file
            join library.local_tracks track on track.id = file.track_id
            join library.local_albums album on album.id = track.album_id
        """).fetchall()
    credits = {}
    for row in rows:
        credits.setdefault(row["album_key"], set()).add(row["name"])
    assert credits["owner::repair album"] == {"Owner", "Retained Guest"}
    assert credits["owner::destination album"] == {"Owner", "Departing Guest"}
    assert credits["owner::unrelated"] == {"Owner", "Unrelated Guest"}
    memberships = {row["private_path"]: row for row in tracks}
    assert memberships[changed["path"]]["album_key"] == "owner::destination album"
    assert memberships[retained["path"]]["album_key"] == "owner::repair album"
    assert all(not row["scan_cache_stale"] for row in tracks)
