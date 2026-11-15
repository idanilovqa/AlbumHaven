"""Missing albums are marked, never removed: deleted from disk, or their drive or share unreachable.

Owner decision 2026-11-08: an album whose files were deleted or became inaccessible is marked
Missing by every scan source, keeps all its data until the user confirms removal, and returns
as it was when its files come back. Album Details "Re-scan" restores one album, also from a
moved folder.
"""
import os
import shutil
from pathlib import Path
from types import SimpleNamespace

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (fixture)


def _scan(fixture, entries, *, unreachable_root_ids=(), unreachable_paths=()):
    """A full scan publication: the walk reported `entries`; some roots or folders could not be read."""
    from music_app.services.relation_projection_postgres import ensure_relation_projection_ready

    unreachable = set(unreachable_root_ids)
    fixture.adapter.save_snapshot(
        Path("unused-watcher-repair.json"), {item["path"]: item for item in entries}, "watcher-repair", 1.0,
        observed_library_root_ids={root["id"] for root in fixture.roots} - unreachable,
        unreachable_scope={"root_ids": sorted(unreachable), "paths": [str(path) for path in unreachable_paths]},
    )
    # As after every scan, the scan's relation publication is reconciled before the next writer.
    assert ensure_relation_projection_ready(fixture.config).get("ready")


def _files(fixture):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        return {
            row["private_path"]: (row["scan_cache_stale"], row["reason"], row["album_key"], row["track_id"])
            for row in connection.execute(
                """select files.private_path, files.scan_cache_stale,
                          files.metadata #>> '{scan_cache,missing_reason}' as reason,
                          albums.album_key, files.track_id
                   from library.local_track_files files
                   join library.local_tracks tracks on tracks.id = files.track_id
                   left join library.local_albums albums on albums.id = tracks.album_id"""
            ).fetchall()
        }


def _rate(fixture, album_key, rating):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute(
            """insert into app.album_ratings (account_id, library_id, album_key, rating, provenance)
               select owners.account_id, albums.library_id, albums.album_key, %s, 'user'
               from library.local_albums albums
               join library.libraries libraries on libraries.id = albums.library_id
               join app.bootstrap_owners owners on owners.account_id = libraries.owner_account_id
               where albums.album_key = %s""",
            (rating, album_key),
        )


def _rating(fixture, album_key):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        row = connection.execute("select rating from app.album_ratings where album_key = %s", (album_key,)).fetchone()
    return row["rating"] if row else None


def _gallery(fixture):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    payload = repository.build_root_album_browse_payload()
    tree = [item["artist"] for item in repository.build_root_sidebar_payload()["artists_sidebar"]]
    cards = [
        (group.get("artist"), album.get("name"), album.get("inventory_status") or "present")
        for group in payload.get("artist_groups") or []
        for album in group.get("albums") or []
    ]
    return tree, cards


def _detail(fixture, album_key):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    return PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect).build_album_detail_payload(album_key)


def _reconcile(fixture, entries):
    from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler

    reconciler = TargetedLibraryReconciler(
        fixture.config, repository=fixture.adapter, root_definitions=fixture.roots,
        metadata_reader=lambda path: dict(entries[str(path)]), wait=lambda _seconds: None,
    )
    return lambda request: reconciler.reconcile(request, root_healthy=True)


def _rescan(fixture, album_key, entries=None):
    from music_app.services.missing_album_rescan import MissingAlbumRescan

    return MissingAlbumRescan(
        fixture.config, reconcile=_reconcile(fixture, entries or {}), roots=fixture.roots,
        connect=isolatedPostgres._connect, search_seconds=10,
    ).rescan(album_key)


def test_live_dropped_drive_marks_its_albums_unreachable_without_changing_gallery_or_tree(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    kept = fixture.entry("Owner/Kept/01.flac", album="Kept Album")
    hoarded = {**fixture.entry("Hoarder/Hoarded/01.flac", root=1, artist="Hoarder", album="Hoarded Album"),
               "album_artist": "Hoarder"}
    fixture.seed(kept, hoarded)
    hoarded_key = _files(fixture)[hoarded["path"]][2]
    _rate(fixture, hoarded_key, 9)
    tree_before, cards_before = _gallery(fixture)

    # The hoard drive drops: the walk cannot reach that root at all.
    shutil.rmtree(fixture.roots[1]["path"])
    _scan(fixture, [kept], unreachable_root_ids={"repair-hoard"})

    files = _files(fixture)
    assert files[hoarded["path"]][:3] == (True, "unreachable", hoarded_key)
    assert files[kept["path"]][:2] == (False, None)
    tree, cards = _gallery(fixture)
    assert tree == tree_before, "a dropped drive never empties or reshuffles the artist tree"
    assert [(artist, name) for artist, name, _status in cards] == [(a, n) for a, n, _s in cards_before]
    assert ("Hoarder", "Hoarded Album", "missing") in cards
    assert _detail(fixture, hoarded_key)["missing_reason"] == "unreachable"
    assert _rating(fixture, hoarded_key) == 9

    # The drive returns: the next scan restores the album as it was.
    restored = fixture.entry("Hoarder/Hoarded/01.flac", root=1, artist="Hoarder", album="Hoarded Album")
    _scan(fixture, [kept, {**restored, "album_artist": "Hoarder"}])
    assert _files(fixture)[hoarded["path"]][:3] == (False, None, hoarded_key)
    assert _gallery(fixture) == (tree_before, cards_before)
    assert _rating(fixture, hoarded_key) == 9


def test_live_vanished_folder_under_a_reachable_root_is_deleted_and_an_unreadable_one_unreachable(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    gone = fixture.entry("Owner/Gone/01.flac", album="Gone Album")
    locked = fixture.entry("Owner/Locked/01.flac", album="Locked Album")
    stay = fixture.entry("Owner/Stay/01.flac", album="Stay Album")
    fixture.seed(gone, locked, stay)
    # Rated, so the deleted album stays as Missing instead of being removed as untouched.
    _rate(fixture, _files(fixture)[gone["path"]][2], 5)

    shutil.rmtree(Path(gone["path"]).parent)
    # The walk saw Stay; listing the Locked folder failed, so its files were not reported.
    _scan(fixture, [stay], unreachable_paths=[Path(locked["path"]).parent])

    files = _files(fixture)
    assert files[gone["path"]][:2] == (True, "deleted")
    assert files[locked["path"]][:2] == (True, "unreachable")
    assert files[stay["path"]][:2] == (False, None)
    assert _detail(fixture, files[gone["path"]][2])["missing_reason"] == "deleted"


def test_live_watcher_deletion_marks_the_album_missing_and_keeps_its_data(watcher_repair_inventory):
    # Owner example: an album whose files went away must not stay listed as present.
    fixture = watcher_repair_inventory
    demos = fixture.entry("Transatlantic/The Transatlantic Demos/01.flac", artist="Transatlantic",
                          album="The Transatlantic Demos")
    demos["album_artist"] = "Transatlantic"
    fixture.seed(demos)
    album_key = _files(fixture)[demos["path"]][2]
    _rate(fixture, album_key, 8)

    folder = Path(demos["path"]).parent
    shutil.rmtree(folder)
    result = _reconcile(fixture, {})(SimpleNamespace(
        root_id="repair-main", paths=(), deleted_paths=(), deleted_subtrees=(folder,), moves=(),
    ))

    assert result.revision > 0
    assert _files(fixture)[demos["path"]][:3] == (True, "deleted", album_key)
    assert ("Transatlantic", "The Transatlantic Demos", "missing") in _gallery(fixture)[1]
    assert _rating(fixture, album_key) == 8


def _link_folder(link, target):
    """A folder that lives elsewhere: a junction on Windows, a symlink elsewhere."""
    target.mkdir(parents=True, exist_ok=True)
    link.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
    else:
        os.symlink(target, link, target_is_directory=True)


def test_live_album_on_a_dropped_subfolder_share_is_unreachable_while_the_root_is_up(watcher_repair_inventory, tmp_path):
    fixture = watcher_repair_inventory
    share = tmp_path / "Share"
    _link_folder(Path(fixture.roots[0]["path"]) / "Owner" / "On Share", share)
    kept = fixture.entry("Owner/Kept/01.flac", album="Kept Album")
    shared = fixture.entry("Owner/On Share/Shared/01.flac", album="Shared Album")
    fixture.seed(kept, shared)
    shared_key = _files(fixture)[shared["path"]][2]
    _rate(fixture, shared_key, 6)

    # The share drops out; the root and its other folders still answer.
    shutil.rmtree(share)
    _scan(fixture, [kept])

    files = _files(fixture)
    assert files[shared["path"]][:2] == (True, "unreachable")
    assert files[kept["path"]][:2] == (False, None)
    assert _detail(fixture, shared_key)["missing_reason"] == "unreachable"

    # The share returns: the album comes back as it was.
    share.mkdir()
    restored = fixture.entry("Owner/On Share/Shared/01.flac", album="Shared Album")
    _scan(fixture, [kept, restored])
    assert _files(fixture)[shared["path"]][:3] == (False, None, shared_key)
    assert _rating(fixture, shared_key) == 6


def test_live_watcher_deletes_while_the_drive_drops_are_unreachable_and_recovery_rechecks_them(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    root = Path(fixture.roots[0]["path"])
    going = fixture.entry("Owner/Going Down/01.flac", album="Going Down Album")
    back = fixture.entry("Owner/Back Again/01.flac", album="Back Again Album")
    gone = fixture.entry("Owner/Really Gone/01.flac", album="Really Gone Album")
    fixture.seed(going, back, gone)
    # Rated, so deleted albums stay as Missing instead of being removed as untouched.
    for entry in (going, back, gone):
        _rate(fixture, _files(fixture)[entry["path"]][2], 5)
    reconcile = _reconcile(fixture, {})

    def deleted(*folders):
        return SimpleNamespace(root_id="repair-main", paths=(), deleted_paths=(),
                               deleted_subtrees=tuple(Path(folder) for folder in folders), moves=())

    # An ordinary deletion under a readable root is "deleted"; the user then puts the files back.
    reconcile(deleted(Path(back["path"]).parent))
    assert _files(fixture)[back["path"]][:2] == (True, "deleted")

    # Delete events still arriving while the drive goes down.
    offline = root.with_name(root.name + "-offline")
    root.rename(offline)
    reconcile(deleted(Path(going["path"]).parent))
    assert _files(fixture)[going["path"]][:2] == (True, "unreachable")

    # The drive returns; one album really was deleted meanwhile. The recovery catch-up
    # re-reads the root, restoring every file that is there and rechecking every reason.
    offline.rename(root)
    shutil.rmtree(Path(gone["path"]).parent)
    _reconcile(fixture, {going["path"]: going, back["path"]: back})(SimpleNamespace(
        root_id="repair-main", paths=(root,), deleted_paths=(), deleted_subtrees=(root,), moves=(),
    ))
    files = _files(fixture)
    assert files[going["path"]][:2] == (False, None)
    assert files[back["path"]][:2] == (False, None)
    assert files[gone["path"]][:2] == (True, "deleted")


def test_live_rescan_restores_a_moved_album_with_its_identity_and_data(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    moved = fixture.entry("Owner/Moved Album/01.flac", album="Moved Album")
    fixture.seed(moved)
    album_key, track_id = _files(fixture)[moved["path"]][2:]
    _rate(fixture, album_key, 7)
    shutil.rmtree(Path(moved["path"]).parent)
    _scan(fixture, [])
    assert _files(fixture)[moved["path"]][:2] == (True, "deleted")

    # The user moved the folder to the hoard drive.
    destination = fixture.entry("Owner/Moved Album/01.flac", root=1, album="Moved Album")
    result = _rescan(fixture, album_key, {destination["path"]: destination})

    assert result["status"] == "moved"
    files = _files(fixture)
    assert files[destination["path"]][:4] == (False, None, album_key, track_id)
    assert moved["path"] not in files
    assert _rating(fixture, album_key) == 7
    assert _detail(fixture, album_key).get("inventory_status") != "missing"


def test_live_rescan_restores_files_back_in_place_and_reports_a_deleted_album(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    back = fixture.entry("Owner/Back/01.flac", album="Back Album")
    deleted = fixture.entry("Owner/Deleted/01.flac", album="Deleted Album")
    fixture.seed(back, deleted)
    keys = {path: row[2] for path, row in _files(fixture).items()}
    _scan(fixture, [], unreachable_root_ids={"repair-main"})
    assert {row[1] for row in _files(fixture).values()} == {"unreachable"}

    shutil.rmtree(Path(deleted["path"]).parent)
    assert _rescan(fixture, keys[back["path"]], {back["path"]: back})["status"] == "restored"
    assert _files(fixture)[back["path"]][:2] == (False, None)

    assert _rescan(fixture, keys[deleted["path"]]) == {"status": "missing", "reason": "deleted"}
    assert _files(fixture)[deleted["path"]][:2] == (True, "deleted")
    assert _detail(fixture, keys[deleted["path"]])["missing_reason"] == "deleted"


def test_live_rescan_uses_retained_root_identity_when_root_link_is_missing(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    release = fixture.entry("Howard Shore/The Hobbit/01.flac", album="The Hobbit")
    fixture.seed(release)
    album_key = _files(fixture)[release["path"]][2]

    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute(
            "update library.local_track_files set library_root_id = null where private_path = %s",
            (release["path"],),
        )

    assert _rescan(fixture, album_key, {release["path"]: release})["status"] == "restored"
