"""One album's stored local-art listing: shown at once, refreshed for that album alone.

Ported from #65's local cover inventory, without its library-wide paths (owner's large-data rule, backlog case 50).
"""
from pathlib import Path

from PIL import Image
import pytest

from music_app.services import cover_state, covers
from music_app.services import local_cover_inventory as inventory


CONFIG = {"IMAGE_EXTENSIONS": {".jpg", ".png"}}


class Store:
    def __init__(self):
        self.rows, self.writes, self.reads = {}, [], []

    def get(self, roots):
        keys = [inventory.root_key(root) for root in roots]
        self.reads.append(keys)
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


@pytest.fixture
def album(tmp_path):
    root = tmp_path / "Album"
    (root / "Covers").mkdir(parents=True)
    Image.new("RGB", (20, 20), "red").save(root / "cover.jpg")
    Image.new("RGB", (30, 20), "blue").save(root / "Covers" / "booklet.png")
    store = Store()
    worker = inventory.LocalCoverInventoryWorker(CONFIG, repository=store)
    worker.refresh(root)
    return root, store, worker


def listed(store, root):
    return {Path(item["path"]).name for item in store.rows[inventory.root_key(root)]["candidates"]}


def test_a_first_listing_records_every_image_with_dimensions_and_hash(album):
    root, store, _worker = album
    assert listed(store, root) == {"cover.jpg", "booklet.png"}
    assert all(item["sha256"] and item["width"] and item["size"]
               for item in store.rows[inventory.root_key(root)]["candidates"])


def test_an_unchanged_open_reads_no_image_bytes_and_writes_nothing(album, monkeypatch):
    root, store, worker = album
    monkeypatch.setattr(cover_state, "_file_sha256", lambda *a, **k: pytest.fail("hashed an unchanged image"))
    monkeypatch.setattr(covers, "image_dimensions", lambda *a, **k: pytest.fail("decoded an unchanged image"))
    store.writes.clear()

    worker.refresh(root)

    assert store.writes == []


def test_a_change_the_watcher_missed_heals_on_the_next_open_hashing_only_that_file(album, monkeypatch):
    root, store, worker = album
    Image.new("RGB", (40, 40), "green").save(root / "back.jpg")
    hashed = []
    real_hash = cover_state._file_sha256
    monkeypatch.setattr(cover_state, "_file_sha256",
                        lambda path, **kwargs: hashed.append(path.name) or real_hash(path, **kwargs))

    worker.refresh(root)

    assert listed(store, root) == {"cover.jpg", "booklet.png", "back.jpg"}
    assert hashed == ["back.jpg"]


def test_an_offline_folder_keeps_its_listing_and_says_so(album):
    root, store, worker = album
    root.rename(root.with_name("Album offline"))

    worker.refresh(root)

    assert listed(store, root) == {"cover.jpg", "booklet.png"}
    assert store.rows[inventory.root_key(root)]["error"] == inventory.STORAGE_UNAVAILABLE


def test_an_unreadable_subfolder_never_publishes_a_shorter_listing(album, monkeypatch):
    root, store, worker = album
    scandir = cover_state.os.scandir

    def refuse_covers(path):
        if Path(path).name == "Covers":
            raise PermissionError("denied")
        return scandir(path)

    monkeypatch.setattr(cover_state.os, "scandir", refuse_covers)

    worker.refresh(root)

    assert listed(store, root) == {"cover.jpg", "booklet.png"}


def test_a_deleted_cover_leaves_the_listing_at_once(album):
    root, store, worker = album

    worker.remove_path(root, root / "cover.jpg")

    assert listed(store, root) == {"booklet.png"}


def test_a_listing_changed_during_a_refresh_is_read_again_not_overwritten(album, monkeypatch):
    root, store, worker = album
    Image.new("RGB", (40, 40), "green").save(root / "back.jpg")
    discover = inventory.discover_local_cover_inventory

    def delete_meanwhile(*args, **kwargs):
        found = discover(*args, **kwargs)
        store.rows[inventory.root_key(root)]["revision"] += 1
        return found

    monkeypatch.setattr(inventory, "discover_local_cover_inventory", delete_meanwhile)

    worker.refresh(root)

    assert listed(store, root) == {"cover.jpg", "booklet.png"}
    assert worker.take_next() == root


def test_repeated_opens_queue_one_walk_and_the_queue_is_bounded(tmp_path):
    worker = inventory.LocalCoverInventoryWorker(CONFIG, repository=Store())
    for _ in range(5):
        worker.request(tmp_path / "same")
    assert worker.take_next() == tmp_path / "same"
    assert worker.take_next() is None

    for index in range(inventory.QUEUE_LIMIT + 10):
        worker.request(tmp_path / f"album-{index}")
    taken = []
    while (root := worker.take_next()) is not None:
        taken.append(root)
    assert len(taken) == inventory.QUEUE_LIMIT
    assert taken[0] == tmp_path / f"album-{inventory.QUEUE_LIMIT + 9}", "the album just opened comes first"


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
        is_squareish_cover=lambda width, height: True, stored_listings=listings,
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


@pytest.mark.parametrize("stored_first, stored", [(True, True), (True, False), (False, True)])
def test_the_gallery_uses_the_stored_listing_only_for_an_open_and_always_refreshes_it(
    monkeypatch, tmp_path, stored_first, stored,
):
    import asyncio
    from types import SimpleNamespace

    from music_app.routes import api_wave_d_asgi_routes as routes

    main, copy = tmp_path / "Album", tmp_path / "Album copy"
    main.mkdir()
    copy.mkdir()
    rows = {inventory.root_key(root): {"candidates": [], "error": None, "available": True} for root in (main, copy)}
    if not stored:
        del rows[inventory.root_key(copy)]  # One copy without a listing: the folders are read, nothing is half shown.
    queued, served = [], []
    worker = SimpleNamespace(repository=SimpleNamespace(get=lambda roots: rows), request=queued.append)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(local_cover_inventory=worker)))
    monkeypatch.setattr(routes, "_app_config", lambda request: dict(CONFIG))
    monkeypatch.setattr(routes, "_library_state", lambda request: {"file_cache": {}})
    monkeypatch.setattr(routes, "resolve_album_copy_roots", lambda *args: [copy])
    monkeypatch.setattr(routes, "cover_lookup_result", lambda task_id: {})
    monkeypatch.setattr(routes, "serialize_cover_gallery_payload",
                        lambda **kwargs: served.append(kwargs["stored_listings"]) or {"ok": True})

    asyncio.run(routes._serialize_cover_gallery_from_asgi(
        request, main, {str(main / "01.mp3")}, stored_first=stored_first,
    ))

    if stored_first and stored:
        assert [root for root, _row in served[0]] == [main, copy]
    else:
        assert served == [None]
    assert queued == [main, copy]


def test_an_offline_album_keeps_its_stored_covers_on_the_follow_up_read_too(monkeypatch, tmp_path):
    import asyncio
    from types import SimpleNamespace

    from music_app.routes import api_wave_d_asgi_routes as routes

    parent, disc = tmp_path / "Album", tmp_path / "Album" / "CD1"  # Offline: neither folder is there.
    row = {"candidates": [], "error": None, "available": True}
    asked = []
    worker = SimpleNamespace(
        repository=SimpleNamespace(get=lambda roots: asked.extend(roots) or {inventory.root_key(disc): row}),
        request=lambda root: None,
    )
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(local_cover_inventory=worker)))
    monkeypatch.setattr(routes, "restrict_album_root_to_represented_disc", lambda root, paths: disc, raising=False)

    listings = asyncio.run(routes._album_local_listings(request, parent, [], {"track"}, stored_first=False))

    assert asked == [disc], "the folder of the album's own disc, as the gallery lists it"
    [(root, shown)] = listings
    assert root == disc and shown["error"] == inventory.STORAGE_UNAVAILABLE and shown["unreadable"] is True
    payload = cover_state.serialize_cover_gallery_payload(
        album_root=disc, track_paths={str(disc / "01.mp3")}, file_cache={}, image_extensions={".jpg"},
        image_dimensions=lambda path: (0, 0), is_squareish_cover=lambda width, height: True, stored_listings=listings,
    )
    assert payload["local_inventory_pending"] is False, "nothing better follows while the folder is away"
    assert payload["local_inventory_error"] == inventory.STORAGE_UNAVAILABLE


def test_an_idle_worker_never_asks_postgres_for_work():
    store = Store()
    worker = inventory.LocalCoverInventoryWorker(CONFIG, repository=store)
    worker.start()
    worker.close()
    assert store.reads == [] and store.writes == []
    for name in ("rescan", "invalidate_paths", "request_context"):
        assert not hasattr(worker, name)


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
