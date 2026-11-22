"""One album's stored local-art listing: shown at once, refreshed for that album alone.

Ported from #65's local cover inventory, without its library-wide paths (owner's large-data rule, backlog case 50).
"""
import asyncio
from pathlib import Path
import threading
from types import SimpleNamespace

from PIL import Image
import pytest

from music_app.routes import api_wave_d_asgi_routes as routes
from music_app.services import cover_state, cover_workflow, covers
from music_app.services import local_cover_inventory as inventory


CONFIG = {"IMAGE_EXTENSIONS": {".jpg", ".png"}}


class Store:
    def __init__(self):
        self.rows, self.writes = {}, []

    def get(self, roots):
        keys = [inventory.root_key(root) for root in roots]
        return {key: dict(self.rows[key]) for key in keys if key in self.rows}

    def publish(self, root, candidates, *, expected_revision):
        key = inventory.root_key(root)
        if (self.rows.get(key) or {}).get("revision") != expected_revision:
            return False
        self.writes.append(key)
        self.rows[key] = {"candidates": candidates, "error": None, "available": True, "complete": True,
                          "revision": (expected_revision or 0) + 1}
        return True

    def mark_unreadable(self, root):
        key = inventory.root_key(root)
        self.rows.setdefault(key, {"candidates": [], "available": False, "complete": False, "revision": 1})
        self.rows[key]["error"] = inventory.STORAGE_UNAVAILABLE


class Album:
    """A real album on disk, in a shape the cover routes resolve, behind the real gallery path."""

    def __init__(self, tmp_path, monkeypatch, shape):
        library, copies = tmp_path / "Main", tmp_path / "Hoard"
        base = library / "Artist" / "Album"
        self.main = base / "CD1" if shape == "disc" else base
        self.copy = copies / "Artist" / "Album" if shape == "copy" else None
        (self.main / "Covers").mkdir(parents=True)
        (self.main / "01.mp3").touch()
        Image.new("RGB", (20, 20), "red").save(self.main / "cover.jpg")
        Image.new("RGB", (30, 30), "blue").save(self.main / "Covers" / "inside.jpg")
        self.tracks = {str(self.main / "01.mp3")}
        if shape == "disc":
            (base / "CD2").mkdir()  # Another album's disc: the gallery lists this album's own disc only.
        if self.copy:
            self.copy.mkdir(parents=True)
            (self.copy / "01.mp3").touch()
            Image.new("RGB", (40, 40), "green").save(self.copy / "copy.jpg")
            self.tracks.add(str(self.copy / "01.mp3"))
        roots = [{"path": str(library), "category": "main_library_roots", "layout": "artist_album"},
                 {"path": str(copies), "category": "hoard_roots", "layout": "artist_album"}]
        monkeypatch.setattr(cover_workflow, "get_library_roots", lambda config: roots)
        self.album_root = base
        self.store = Store()
        self.inventory = inventory.LocalCoverInventory(CONFIG, repository=self.store)
        entries = {track: {"cover_path": str(self.main / "cover.jpg")} for track in self.tracks}
        self.request = SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(local_cover_inventory=self.inventory)),
        )
        monkeypatch.setattr(routes, "_app_config", lambda request: dict(CONFIG))
        monkeypatch.setattr(routes, "_library_state", lambda request: {"file_cache": entries})
        monkeypatch.setattr(routes, "cover_lookup_result", lambda task_id: {})

    def gallery(self, *, stored_first=False):
        return asyncio.run(routes._serialize_cover_gallery_from_asgi(
            self.request, self.album_root, self.tracks, stored_first=stored_first,
        ))

    def shown(self, payload):
        return {Path(item["candidate_cover_path"]).name for item in payload["local_covers"] + payload["other_art"]}

    def stored(self, root):
        return {Path(item["path"]).name for item in self.store.rows[inventory.root_key(root)]["candidates"]}


@pytest.fixture(params=["plain", "disc", "copy"])
def album(request, tmp_path, monkeypatch):
    album = Album(tmp_path, monkeypatch, request.param)
    album.first = album.gallery(stored_first=True)
    return album


def refuse(monkeypatch, folder):
    scandir = cover_state.os.scandir

    def scan(path="."):
        if Path(path) == folder:
            raise PermissionError("denied")
        return scandir(path)

    monkeypatch.setattr(cover_state.os, "scandir", scan)


def test_a_first_open_lists_and_stores_every_folder_of_the_album(album):
    expected = {"cover.jpg", "inside.jpg", *(["copy.jpg"] if album.copy else [])}
    assert album.shown(album.first) == expected
    assert album.first["local_inventory_pending"] is False, "nothing stored yet: the folders were read"
    assert album.stored(album.main) == {"cover.jpg", "inside.jpg"}
    if album.copy:
        assert album.stored(album.copy) == {"copy.jpg"}


def test_a_whole_unchanged_open_is_one_walk_no_decode_no_hash_no_write(album, monkeypatch):
    monkeypatch.setattr(cover_state, "_file_sha256", lambda *a, **k: pytest.fail("hashed an unchanged image"))
    monkeypatch.setattr(covers, "image_dimensions", lambda *a, **k: pytest.fail("decoded an unchanged image"))
    monkeypatch.setattr(routes, "image_dimensions", lambda *a, **k: pytest.fail("decoded an unchanged image"))
    walks = []
    walk = cover_state._iter_local_image_paths
    monkeypatch.setattr(cover_state, "_iter_local_image_paths",
                        lambda root, *a, **k: walks.append(inventory.root_key(root)) or walk(root, *a, **k))
    album.store.writes.clear()

    opened = album.gallery(stored_first=True)
    assert opened["local_inventory_pending"] is True and walks == [], "the first answer reads no folder"
    followed = album.gallery()

    assert followed["local_inventory_pending"] is False
    assert album.shown(followed) == album.shown(opened) == album.shown(album.first)
    assert len(walks) == len(set(walks)) == (2 if album.copy else 1)
    assert album.store.writes == []


def test_a_change_the_watcher_missed_shows_on_the_next_open_hashing_only_that_file(album, monkeypatch):
    Image.new("RGB", (50, 50), "yellow").save(album.main / "back.jpg")
    hashed = []
    real_hash = cover_state._file_sha256
    monkeypatch.setattr(cover_state, "_file_sha256",
                        lambda path, **kwargs: hashed.append(path.name) or real_hash(path, **kwargs))

    assert "back.jpg" in album.shown(album.gallery())
    assert hashed == ["back.jpg"]


@pytest.mark.parametrize("unreadable", ["album folder", "subfolder"])
def test_an_unreadable_folder_keeps_the_covers_on_screen_and_says_so(album, monkeypatch, unreadable):
    refuse(monkeypatch, album.main if unreadable == "album folder" else album.main / "Covers")

    followed = album.gallery()

    assert album.shown(followed) == album.shown(album.first)
    assert followed["local_inventory_error"] == inventory.STORAGE_UNAVAILABLE
    assert followed["local_inventory_pending"] is False
    assert album.stored(album.main) == {"cover.jpg", "inside.jpg"}


@pytest.mark.parametrize("main_is_listed", [True, False])
def test_a_copy_that_is_away_keeps_its_covers_whatever_the_other_folders_have(tmp_path, monkeypatch, main_is_listed):
    album = Album(tmp_path, monkeypatch, "copy")
    first = album.gallery()
    if not main_is_listed:
        del album.store.rows[inventory.root_key(album.main)]
    album.copy.rename(album.copy.with_name("Album away"))

    for stored_first in (True, False):
        payload = album.gallery(stored_first=stored_first)
        assert album.shown(payload) == album.shown(first)
    assert payload["local_inventory_error"] == inventory.STORAGE_UNAVAILABLE


def test_a_deleted_cover_leaves_the_listing_of_the_folder_that_held_it(album):
    deleted = album.copy / "copy.jpg" if album.copy else album.main / "Covers" / "inside.jpg"
    deleted.unlink()

    payload = album.gallery()  # The delete route answers with this read.

    assert deleted.name not in album.shown(payload)
    assert deleted.name not in album.stored(album.copy or album.main)


def test_a_deleted_active_cover_gets_no_card(album):
    (album.main / "cover.jpg").unlink()
    assert "cover.jpg" not in album.shown(album.gallery())


def test_a_save_stores_the_new_cover_under_the_folder_the_gallery_lists(album):
    Image.new("RGB", (60, 60), "white").save(album.main / "cover-2.jpg")

    album.inventory.refresh_after_write(album.album_root, album.tracks)

    assert "cover-2.jpg" in album.stored(album.main)
    assert "cover-2.jpg" in album.shown(album.gallery(stored_first=True)), "the next open shows it at once"


def test_a_failed_listing_update_never_fails_the_save(album, monkeypatch):
    monkeypatch.setattr(album.store, "get", lambda roots: (_ for _ in ()).throw(RuntimeError("database away")))
    album.inventory.refresh_after_write(album.album_root, album.tracks)


def test_repeated_opens_share_one_walk_and_a_save_waits_for_a_walk_of_its_own(tmp_path, monkeypatch):
    listings = inventory.LocalCoverInventory(CONFIG, repository=Store())
    walks, entered, release = [], threading.Event(), threading.Event()

    def walk(root, *args, **kwargs):
        walks.append(root)
        entered.set()
        assert release.wait(5)
        return []

    monkeypatch.setattr(inventory, "discover_local_cover_inventory", walk)
    opens = [threading.Thread(target=listings.refresh, args=(tmp_path,)) for _ in range(5)]
    for thread in opens:
        thread.start()
    assert entered.wait(5)
    save = threading.Thread(target=listings.refresh, args=(tmp_path,), kwargs={"after_write": True})
    save.start()
    save.join(0.2)
    assert len(walks) == 1 and save.is_alive()
    release.set()
    for thread in [*opens, save]:
        thread.join(5)
    assert len(walks) == 2, "one shared walk, then one that sees what the save wrote"


def test_walks_of_different_albums_are_bounded(tmp_path, monkeypatch):
    listings = inventory.LocalCoverInventory(CONFIG, repository=Store())
    running, peak, lock, release = [], [], threading.Lock(), threading.Event()

    def walk(root, *args, **kwargs):
        with lock:
            running.append(root)
            peak.append(len(running))
        release.wait(0.05)
        with lock:
            running.remove(root)
        return []

    monkeypatch.setattr(inventory, "discover_local_cover_inventory", walk)
    threads = [threading.Thread(target=listings.refresh, args=(tmp_path / str(index),)) for index in range(12)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(5)
    assert len(peak) == 12 and max(peak) <= inventory.WALK_LIMIT


def test_there_is_no_background_worker_to_start_poll_or_stop():
    for name in ("start", "stop", "request", "rescan", "invalidate_paths", "request_context"):
        assert not hasattr(inventory.LocalCoverInventory, name)


def test_an_open_shows_the_stored_listing_of_every_copy_without_touching_the_disk(monkeypatch, tmp_path):
    # Owner 2026-11-22: the selected art first, and the correct number of local cards while the rest loads.
    main, copy = tmp_path / "Album", tmp_path / "Album copy"
    stored = lambda root, name, size, sha: {
        "path": str(root / name), "filename": name, "relative_path": name, "width": size, "height": size,
        "resolution": f"{size}x{size}", "is_squareish": True, "area": size * size, "depth": 1,
        "sha256": sha, "size": 9, "mtime_ns": 1,
    }
    listings = [
        (main, {"candidates": [stored(main, "cover.jpg", 500, "a" * 64), stored(main, "source.jpg", 400, "a" * 64)],
                "error": None}),
        (copy, {"candidates": [stored(copy, "cover.jpg", 300, "b" * 64)], "error": inventory.STORAGE_UNAVAILABLE}),
    ]
    monkeypatch.setattr(cover_state, "_iter_local_image_paths", lambda *a, **k: pytest.fail("walked the folder"))
    monkeypatch.setattr(cover_state, "_file_sha256", lambda *a, **k: pytest.fail("read an image"))
    monkeypatch.setattr(cover_state, "restrict_album_root_to_represented_disc", lambda root, paths: root)
    track = str(main / "01.mp3")

    payload = cover_state.serialize_cover_gallery_payload(
        album_root=main, track_paths={track},
        file_cache={track: {"cover_path": str(main / "cover.jpg"), "cover_revision": "a" * 64}},
        image_extensions={".jpg"}, image_dimensions=lambda path: pytest.fail("decoded an image"),
        is_squareish_cover=lambda width, height: True, stored_listings=listings, listings_pending=True,
    )

    covers_shown = payload["local_covers"]
    assert [Path(item["candidate_cover_path"]) for item in covers_shown] == [
        main / "cover.jpg", main / "source.jpg", copy / "cover.jpg",
    ]
    assert [item["is_active"] for item in covers_shown] == [True, False, False]
    assert Path(covers_shown[2]["relative_path"]) == Path("Album copy") / "cover.jpg", "copies can be told apart"
    assert all(not {"sha256", "size", "mtime_ns"} & set(item) for item in covers_shown)
    assert payload["selected_source_cover_path"] == str(main / "source.jpg")
    assert payload["local_inventory_pending"] is True
    assert payload["local_inventory_error"] == inventory.STORAGE_UNAVAILABLE



@pytest.mark.parametrize("neighbours", [4, 400])
def test_finding_an_albums_folders_on_open_is_flat_in_library_size(monkeypatch, tmp_path, neighbours):
    from music_app.services import cover_workflow

    library, copies = tmp_path / "Main", tmp_path / "Hoard"
    folders = [library / "Artist" / "Album" / "CD1", library / "Artist" / "Album" / "CD2", copies / "Artist" / "Album"]
    tracks = set()
    for folder in folders:
        folder.mkdir(parents=True)
        (folder / "01.mp3").touch()
        tracks.add(str(folder / "01.mp3"))
    for index in range(neighbours):
        (library / "Artist" / f"Other {index}").mkdir()
    monkeypatch.setattr(cover_workflow, "get_library_roots", lambda config: [
        {"path": str(library), "category": "main_library_roots", "layout": "artist_album"},
        {"path": str(copies), "category": "hoard_roots", "layout": "artist_album"},
    ])
    visited = []
    scandir = cover_workflow.os.scandir
    monkeypatch.setattr(cover_workflow.os, "scandir", lambda path=".": visited.append(Path(path)) or scandir(path))
    monkeypatch.setattr(cover_workflow.os, "listdir", lambda path=".": pytest.fail(f"listed {path}"))

    main_tracks = {path for path in tracks if path.startswith(str(library))}
    root = cover_workflow.resolve_album_root_from_track_paths({}, main_tracks)
    copy_roots = cover_workflow.resolve_album_copy_roots({}, root, tracks)

    assert root == (library / "Artist" / "Album").resolve()
    assert copy_roots == [(copies / "Artist" / "Album").resolve()]
    assert all(root == path or root in path.parents for path in visited), "only the album's own folders are listed"
    assert len(visited) <= len(folders)
