from __future__ import annotations

from pathlib import Path
from contextlib import nullcontext
from threading import Event, Thread
from types import SimpleNamespace

import pytest

from music_app.services import local_cover_inventory as inventory


def test_discovery_persists_dimensions_and_hashes_without_generated_previews(tmp_path):
    from PIL import Image
    from music_app.services.cover_state import _file_sha256

    Image.new("RGB", (64, 64)).save(tmp_path / "front.png")
    Image.new("RGB", (64, 32)).save(tmp_path / "booklet.png")
    generated = tmp_path / ".album-haven"
    generated.mkdir()
    Image.new("RGB", (16, 16)).save(generated / "preview.png")

    candidates = inventory.discover_local_cover_inventory(tmp_path, {"IMAGE_EXTENSIONS": {".png"}})

    assert {item["filename"] for item in candidates} == {"front.png", "booklet.png"}
    assert [(item["width"], item["height"], item["is_squareish"]) for item in candidates] == [(64, 64, True), (64, 32, False)]
    assert all(item["sha256"] == _file_sha256(Path(item["path"])) for item in candidates)


@pytest.mark.skipif(not __import__("os").path.normcase("A") == "a", reason="case-folded keys exist only on Windows")
def test_discovery_lists_paths_in_the_folder_real_spelling(tmp_path):
    from PIL import Image

    album = tmp_path / "Mastodon" / "Crack The Skye"
    album.mkdir(parents=True)
    Image.new("RGB", (64, 64)).save(album / "cover.jpg")

    candidates = inventory.discover_local_cover_inventory(inventory.root_key(album), {"IMAGE_EXTENSIONS": {".jpg"}})

    assert [item["path"] for item in candidates] == [str(album / "cover.jpg")]


def test_discovery_cancellation_does_not_return_partial_inventory(tmp_path):
    (tmp_path / "cover.jpg").write_bytes(b"image")
    with pytest.raises(InterruptedError, match="cancelled"):
        inventory.discover_local_cover_inventory(tmp_path, {"IMAGE_EXTENSIONS": {".jpg"}}, cancel_requested=lambda: True)


def test_unreadable_refresh_never_publishes_empty_inventory(monkeypatch):
    calls = []
    worker = inventory.LocalCoverInventoryWorker({}, repository=SimpleNamespace(work_slot=lambda: nullcontext(True)))
    worker._wake.set()
    worker._listings.add(["missing"], foreground=True)
    worker.repository.next_pending = lambda key: {"root_path": key, "revision": 7, "foreground_requested": True}
    worker.repository.publish = lambda *args: pytest.fail("Unreadable inventory must not become complete/empty")
    def defer(*args):
        calls.append(args)
        worker._stop.set()
    worker.repository.defer = defer
    monkeypatch.setattr(inventory, "discover_local_cover_inventory", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("offline")))

    worker._run()

    assert calls == [("missing", 7)]


def test_canceled_worker_never_publishes_partial_inventory(monkeypatch):
    worker = inventory.LocalCoverInventoryWorker({}, repository=SimpleNamespace(work_slot=lambda: nullcontext(True)))
    worker._wake.set()
    worker._listings.add(["root"], foreground=True)
    worker.repository.next_pending = lambda key: {"root_path": key, "revision": 1, "foreground_requested": True}
    worker.repository.publish = lambda *args: pytest.fail("Shutdown must not publish incomplete inventory")
    released = []
    worker.repository.defer = lambda *args, **kwargs: released.append((args, kwargs))
    def discover(*args, **kwargs):
        worker._stop.set()
        return [{"path": "partial.jpg"}]
    monkeypatch.setattr(inventory, "discover_local_cover_inventory", discover)

    worker._run()
    assert released == [(("root", 1), {"delay_seconds": 0})]


def test_foreground_activity_holds_background_invalidations():
    calls = []
    worker = inventory.LocalCoverInventoryWorker({}, repository=SimpleNamespace(work_slot=lambda: nullcontext(True)))
    worker._wake.set()
    worker._contexts.add(["changed-album"])
    worker._contexts.add(["opened-album"], foreground=True)
    worker._listings.add(["changed-folder"])
    worker._listings.add(["opened-folder"], foreground=True)
    worker.repository.next_context = lambda key: calls.append(("context", key))
    def pending(key):
        calls.append(("inventory", key))
        worker._stop.set()
    worker.repository.next_pending = pending

    worker._run()

    assert calls == [("context", "opened-album"), ("inventory", "opened-folder")]


def test_an_idle_worker_reads_nothing_and_takes_no_work_slot(monkeypatch):
    # The large-data rule: a restart never works through a stored backlog or the library's albums.
    worker = inventory.LocalCoverInventoryWorker({}, repository=SimpleNamespace())
    worker._foreground_at -= 3600
    waits = []

    def wait(_timeout):
        waits.append(True)
        if len(waits) == 3:
            worker._stop.set()

    monkeypatch.setattr(worker._wake, "wait", wait)
    worker._logger = SimpleNamespace(exception=lambda *args: pytest.fail("An idle worker must not reach Postgres"))
    worker._run()

    assert len(waits) == 3


def test_a_waiting_open_preempts_background_work_without_a_database_poll():
    worker = inventory.LocalCoverInventoryWorker({}, repository=SimpleNamespace(request=lambda root: None))
    worker._foreground_at -= 10
    assert not worker._cancel_requested(False)
    worker.request("album")
    assert worker._cancel_requested(False)
    assert not worker._cancel_requested(True)


@pytest.mark.parametrize(("kind", "held_by"), [
    ("context", "an open during the deferral"), ("context", "a stopped process's claim"),
    ("listing", "an open during the deferral"), ("listing", "a stopped process's claim"),
])
def test_deferred_work_waits_for_when_its_row_is_due_and_is_never_dropped(monkeypatch, kind, held_by):
    now = [100.0]
    claims = []
    monkeypatch.setattr(inventory.time, "monotonic", lambda: now[0])
    worker = inventory.LocalCoverInventoryWorker({}, repository=SimpleNamespace(work_slot=lambda: nullcontext(True)))
    queue = worker._contexts if kind == "context" else worker._listings
    if held_by.startswith("an open"):
        queue.add(["album"], delay=30)  # deferred by this process
    queue.add(["album"], foreground=True)

    def claim(key):
        claims.append((key, now[0]))
        worker._stop.set()
        return {"retry_in": 20.0, "context_key": key, "root_path": key, "track_paths": [], "revision": 1,
                "foreground_requested": True}

    monkeypatch.setattr(worker.repository, "next_context" if kind == "context" else "next_pending", claim, raising=False)
    worker._wake.set()
    worker._run()

    assert claims == [("album", 100.0)]
    assert not queue.waiting(background=True), "it is not asked again before its row is due"
    now[0] = 120.0
    assert queue.waiting(background=False), "the album someone opened is checked again when due"


def test_changed_work_stops_after_its_first_unavailable_answer(monkeypatch):
    from music_app.services import cover_workflow

    now = [100.0]
    calls = []
    albums = [f"album-{index}" for index in range(200)]

    class Repository:
        def work_slot(self):
            calls.append("slot")
            return nullcontext(True)

        def next_context(self, key):
            calls.append("claim context")
            return {"context_key": key, "track_paths": [f"{key}/01.mp3"], "revision": 1, "foreground_requested": True}

        def next_pending(self, root):
            calls.append("claim listing")
            return {"root_path": root, "revision": 1, "foreground_requested": True}

        def defer_context(self, *_args, **_kwargs):
            calls.append("defer context")

        def defer(self, *_args, **_kwargs):
            calls.append("defer listing")

    def deleted(*_args, **_kwargs):
        raise FileNotFoundError("the album folder was deleted")

    monkeypatch.setattr(inventory.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(cover_workflow, "resolve_album_root_from_track_paths", lambda *args, **kwargs: None)
    monkeypatch.setattr(inventory, "local_inventory_root_for_tracks", lambda config, paths: None)
    monkeypatch.setattr(inventory, "local_inventory_tracks_exist", lambda paths: False)
    monkeypatch.setattr(inventory, "discover_local_cover_inventory", deleted)
    worker = inventory.LocalCoverInventoryWorker({}, repository=Repository())
    # A change found them. Their rows still carry an older open's flag, which is not an open now.
    worker._contexts.add(albums)
    worker._listings.add(albums)
    worker._foreground_at = now[0] - 3600
    passes = []

    def wait(_timeout):
        passes.append(True)
        if len(passes) == len(albums) + 2:
            assert calls.count("defer context") == calls.count("defer listing") == len(albums)
            now[0] += 7200  # every deferral has passed
            calls.clear()
        if len(passes) == len(albums) + 6:
            worker._stop.set()

    monkeypatch.setattr(worker._wake, "wait", wait)
    worker._run()

    assert calls == [], "it waits for the next change or open, without a slot, a read or a write"


def test_a_failed_change_mark_still_marks_the_removed_tracks():
    calls = []
    worker = SimpleNamespace(invalidate_or_retry=lambda paths, **kwargs: calls.append((paths, kwargs)) and False)
    check = inventory.LocalCoverScanCheck(1000.0, {"main": 500.0})

    advanced = check.apply(
        worker,
        previous={"edited.mp3": {"mtime": 1, "size": 1}, "gone.mp3": {"library_root_id": "main"}},
        scanned={"edited.mp3": {"mtime": 2, "size": 1}},
        readable_root_ids={"main"},
    )

    assert [(list(paths), kwargs) for paths, kwargs in calls] == [
        (["edited.mp3"], {}), (["gone.mp3"], {"context_changed": True}),
    ], "the next scan cannot find a removed track again"
    assert advanced == {}


def test_candidates_outside_the_configured_roots_are_never_read_back(tmp_path):
    root = tmp_path / "main"
    reached = []

    def connect(_url):
        reached.append(True)
        raise RuntimeError("only a folder below a configured root is read")

    repository = inventory.LocalCoverInventoryRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://inventory.invalid/unit",
         "_library_root_paths_snapshot": (root, root / "Artist" / "nested")},
        connect=connect,
    )
    for folder in (tmp_path / "removed" / "Album", root, tmp_path, root / "Artist"):
        assert repository.get(folder) is None, "removed, at a root, or above any root"
    assert reached == []
    with pytest.raises(RuntimeError, match="below a configured root"):
        repository.get(root / "Artist" / "Album")


def test_exact_track_set_context_keys_do_not_alias_sibling_albums(tmp_path):
    first = {str(tmp_path / "Album One" / "track.mp3")}
    second = {str(tmp_path / "Album Two" / "track.mp3")}
    assert inventory.context_key(first) != inventory.context_key(second)
    assert inventory.context_key(first | second) not in {inventory.context_key(first), inventory.context_key(second)}
    assert inventory.context_key(first | second) == inventory.context_key(list(reversed(sorted(first | second))))


def test_foreground_request_preempts_an_already_running_background_scan(monkeypatch):
    worker = inventory.LocalCoverInventoryWorker({}, repository=SimpleNamespace(work_slot=lambda: nullcontext(True)))
    worker._foreground_at -= 10
    worker._wake.set()
    worker._listings.add(["background"])
    worker.repository.next_pending = lambda key: {"root_path": key, "revision": 3, "foreground_requested": False}
    worker.repository.publish = lambda *args: pytest.fail("Preempted inventory must not be published")
    released = []
    def defer(*args, **kwargs):
        released.append((args, kwargs))
        worker._stop.set()
    worker.repository.defer = defer
    def discover(*args, cancel_requested):
        assert not cancel_requested()
        worker.note_foreground_activity()
        assert cancel_requested()
        raise InterruptedError("yield to user")
    monkeypatch.setattr(inventory, "discover_local_cover_inventory", discover)

    worker._run()

    assert released == [(("background", 3), {"delay_seconds": 0})]


def test_context_resolution_honors_cancellation_between_tracks(monkeypatch, tmp_path):
    from music_app.services import cover_workflow
    first, second = tmp_path / "first.mp3", tmp_path / "second.mp3"
    first.touch()
    second.touch()
    calls = []
    monkeypatch.setattr(cover_workflow, "get_library_roots", lambda config: [{"path": str(tmp_path)}])
    # Each track resolves under one snapshot of the roots since 8128ee152.
    def resolve(value, _root_paths, **kwargs):
        calls.append(value)
        return Path(value)
    monkeypatch.setattr(cover_workflow, "resolve_media_path_within_roots", resolve)

    with pytest.raises(InterruptedError, match="context resolution cancelled"):
        cover_workflow.resolve_album_root_from_track_paths({}, {str(first), str(second)}, cancel_requested=lambda: bool(calls))

    assert len(calls) == 1


@pytest.mark.parametrize("unreadable", [False, True])
def test_context_shutdown_and_read_error_do_not_publish_a_root(monkeypatch, unreadable):
    from music_app.services import cover_workflow

    deferred = []
    worker = inventory.LocalCoverInventoryWorker({}, repository=SimpleNamespace(work_slot=lambda: nullcontext(True)))
    worker._wake.set()
    worker._contexts.add(["context"], foreground=True)
    worker.repository.next_context = lambda key: {
        "context_key": key, "revision": 4, "track_paths": ["album/song.mp3"],
        "foreground_requested": True,
    }
    worker.repository.publish_context = lambda *args, **kwargs: pytest.fail("An unresolved or canceled root must not be published")
    worker.repository.defer_context = lambda *args, **kwargs: deferred.append((args, kwargs))
    worker.repository.next_pending = lambda **kwargs: pytest.fail("Shutdown must stop further inventory work")

    def resolve(*args, cancel_requested):
        assert not cancel_requested()
        worker._stop.set()
        if unreadable:
            raise OSError("Storage unavailable")
        return Path("album")

    monkeypatch.setattr(cover_workflow, "resolve_album_root_from_track_paths", resolve)
    worker._run()

    assert deferred == [(("context", 4), {} if unreadable else {"delay_seconds": 0})]


def test_worker_forwards_deleted_subtree_without_filesystem_discovery():
    calls = []
    worker = inventory.LocalCoverInventoryWorker({}, repository=SimpleNamespace(
        invalidate_paths=lambda *args, **kwargs: calls.append((args, kwargs)) or (["album"], ["context"]),
    ))
    worker.invalidate_paths(["library/artist"], subtree_paths=["library/artist"], context_changed=True)
    assert calls == [((["library/artist"],), {
        "subtree_paths": ["library/artist"], "context_changed": True,
        "pending_contexts_below": worker._unresolved.below,
    })]
    assert worker._listings.take(background=True) == "album", "what changed is what the worker re-lists"
    assert worker._contexts.take(background=True) == "context"
    assert worker._wake.is_set()


def test_invalidation_retry_coalesces_backs_off_and_eventually_drains(monkeypatch):
    now = [100.0]
    attempts = []

    def invalidate_paths(paths, **kwargs):
        attempts.append((tuple(paths), kwargs))
        if len(attempts) in {1, 3}:
            raise RuntimeError("database unavailable")
        return [], []

    monkeypatch.setattr(inventory.time, "monotonic", lambda: now[0])
    worker = inventory.LocalCoverInventoryWorker(
        {},
        repository=SimpleNamespace(
            last_roots=("library",),
            invalidate_paths_under=lambda _roots, paths, **kwargs: invalidate_paths(paths, **kwargs),
        ),
    )
    worker.schedule_invalidation_retry(["library/artist/cover.jpg"])
    worker.schedule_invalidation_retry(["library/artist/cover.jpg"])

    assert len(worker._invalidation_retries) == 1
    worker._retry_scheduled_invalidation()
    assert len(attempts) == 1

    worker._retry_scheduled_invalidation()
    assert len(attempts) == 1, "backoff must prevent a hot retry loop"

    now[0] += worker._INVALIDATION_RETRY_BASE_SECONDS
    worker._retry_scheduled_invalidation()
    assert len(attempts) == 2
    assert worker._invalidation_retries == {}

    worker.schedule_invalidation_retry(["library/artist/cover.jpg"])
    key = next(iter(worker._invalidation_retries))
    worker._invalidation_retries[key] = (now[0], 100)
    worker._retry_scheduled_invalidation()
    next_attempt_at, _attempt_count = worker._invalidation_retries[key]
    assert next_attempt_at - now[0] == worker._INVALIDATION_RETRY_MAX_SECONDS

    now[0] = next_attempt_at
    worker._retry_scheduled_invalidation()
    assert len(attempts) == 4
    assert worker._invalidation_retries == {}


@pytest.mark.parametrize("roots_were_read", [True, False])
def test_a_scheduled_invalidation_retry_uses_the_roots_it_was_scheduled_under(roots_were_read):
    """A retry runs from the worker's scheduler: it never loads the root settings (freeze guard BI-15)."""
    retried = []

    class Repository:
        last_roots = None

        def _roots(self):
            raise AssertionError("a retry never loads the root settings")

        def invalidate_paths(self, paths, **_kwargs):
            if roots_were_read:
                self.last_roots = ("/music",)  # read before the database failed
            raise RuntimeError("database unavailable")

        def invalidate_paths_under(self, roots, paths, **_kwargs):
            retried.append((roots, tuple(paths)))
            return [], []

    worker = inventory.LocalCoverInventoryWorker({}, repository=Repository(), logger=SimpleNamespace(exception=lambda *_a: None))

    assert worker.invalidate_or_retry(["/music/a/cover.jpg"]) is False
    worker._retry_scheduled_invalidation()

    if roots_were_read:
        assert retried == [(("/music",), (inventory.root_key("/music/a/cover.jpg"),))]
        assert worker._invalidation_retries == {}
    else:
        assert retried == [], "with no roots known it waits, without loading them"
        assert len(worker._invalidation_retries) == 1


def test_failed_invalidation_retry_does_not_starve_normal_inventory_work():
    normal_work_reached = Event()
    invalidation_attempts = []

    def invalidate_paths(paths, **_kwargs):
        invalidation_attempts.append(tuple(paths))
        raise RuntimeError("database unavailable")

    worker = inventory.LocalCoverInventoryWorker(
        {},
        repository=SimpleNamespace(
            work_slot=lambda: nullcontext(True),
            last_roots=("library",),
            invalidate_paths_under=lambda _roots, paths, **kwargs: invalidate_paths(paths, **kwargs),
            next_pending=lambda _key: normal_work_reached.set() or None,
        ),
    )
    worker._listings.add(["opened-folder"], foreground=True)
    worker.schedule_invalidation_retry(["library/artist/cover.jpg"])
    thread = Thread(target=worker._run, daemon=True)
    thread.start()
    try:
        assert normal_work_reached.wait(1), "retry failure must not block normal inventory work"
    finally:
        worker._stop.set()
        worker._wake.set()
        thread.join(2)

    assert not thread.is_alive()
    assert invalidation_attempts == [(inventory.root_key("library/artist/cover.jpg"),)]


def _scan_check(checked_at, **options):
    calls = []
    worker = SimpleNamespace(
        invalidate_or_retry=lambda paths, **kwargs: calls.append((sorted(paths), kwargs)) or options.get("saved", True),
    )
    check = inventory.LocalCoverScanCheck(1000.0, checked_at, full_rescan=options.get("full_rescan", False))
    return check, worker, calls


def test_a_scan_advances_the_check_time_only_of_roots_it_could_read():
    check, worker, _calls = _scan_check({"main": 500.0, "offline": 500.0})
    assert check.apply(worker, previous={}, scanned={}, readable_root_ids={"main"}) == {"main": 1000.0}


def test_a_scan_whose_invalidation_failed_advances_no_check_time():
    check, worker, _calls = _scan_check({"main": 500.0}, saved=False)
    assert check.apply(
        worker, previous={"a.mp3": {"mtime": 1, "size": 1}}, scanned={"a.mp3": {"mtime": 2, "size": 1}},
        readable_root_ids={"main"},
    ) == {}


def test_no_recorded_check_time_uses_the_changed_tracks_only():
    check, worker, calls = _scan_check({})
    assert check.changed_since("main") is None
    previous = {
        "same.mp3": {"mtime": 1, "size": 1}, "edited.mp3": {"mtime": 1, "size": 1},
        "gone.mp3": {"mtime": 1, "size": 1, "library_root_id": "main"},
        "unreachable.mp3": {"mtime": 1, "size": 1, "library_root_id": "offline"},
    }
    scanned = {"same.mp3": {"mtime": 1, "size": 1}, "edited.mp3": {"mtime": 2, "size": 1}, "new.mp3": {"mtime": 3, "size": 1}}

    check.apply(worker, previous=previous, scanned=scanned, readable_root_ids={"main"})

    assert calls == [(["edited.mp3", "new.mp3"], {}), (["gone.mp3"], {"context_changed": True})]


def test_an_unreadable_check_time_advances_nothing():
    check, worker, calls = _scan_check(None)
    changed = check.apply(
        worker, previous={"a.mp3": {"mtime": 1, "size": 1}}, scanned={"a.mp3": {"mtime": 2, "size": 1}},
        readable_root_ids={"main"},
    )
    assert calls == [(["a.mp3"], {})], "the changed tracks are still re-listed"
    assert changed == {}, "the images nobody looked at must be looked for by the next scan"


def test_a_published_scan_merges_its_check_times_beside_the_scan_cache():
    from music_app.services import scan_cache_persistence

    sql = " ".join(scan_cache_persistence._save_scan_snapshot_sql(record_cover_check=True).split())
    assert "coalesce(library.libraries.metadata -> 'cover_inventory_checked_at', '{}'::jsonb) || %(cover_inventory_checked_at)s::jsonb" in sql
    assert "cover_inventory_checked_at" not in scan_cache_persistence._save_scan_snapshot_sql()


def test_an_empty_previous_cache_never_counts_every_track_as_changed():
    check, worker, calls = _scan_check({})
    check.apply(worker, previous={}, scanned={"a.mp3": {"mtime": 1, "size": 1}}, readable_root_ids={"main"})
    assert calls == []


def test_a_scan_check_reaches_behind_the_last_one_for_clock_granularity(tmp_path):
    check, worker, calls = _scan_check({"main": 500.0})
    since = check.changed_since("main")
    assert since == 500.0 - inventory._SCAN_CHECK_OVERLAP_SECONDS
    for name, modified_at in (("edge.jpg", since), ("older.jpg", since - 1)):
        check.note(tmp_path / name, tmp_path, since, lambda: SimpleNamespace(st_mtime=modified_at))

    check.apply(worker, previous={}, scanned={}, readable_root_ids={"main"})

    assert calls == [([str(tmp_path / "edge.jpg")], {})]


def test_generated_previews_are_not_a_changed_album_folder(tmp_path):
    check, worker, calls = _scan_check({"main": 500.0})
    preview = tmp_path / "Album" / ".album-haven" / "preview.jpg"
    check.note(preview, tmp_path, 1.0, lambda: SimpleNamespace(st_mtime=2.0))
    check.apply(worker, previous={}, scanned={}, readable_root_ids={"main"})
    assert calls == []


def _touch(*paths):
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"audio")


def test_multi_folder_albums_get_a_truthful_local_art_folder(tmp_path):
    root = tmp_path / "music"
    other_root = tmp_path / "new"
    config = {"_library_root_paths_snapshot": (root, other_root)}
    album = root / "Magenta" / "2016 - Sign of IV"
    discs = [album / "cd1" / "01.mp3", album / "cd2 (bonus)" / "01.mp3"]
    copy_a = [other_root / "Prog" / "Hot Rats" / f"0{n}.mp3" for n in range(1, 4)]
    copy_b = [root / "Zappa" / "1969 - Hot Rats" / "01.mp3"]
    loose = [root / "track.mp3"]
    _touch(*discs, *copy_a, *copy_b, *loose)

    key = lambda path: Path(inventory.root_key(path))
    assert inventory.local_inventory_root_for_tracks(config, [str(p) for p in discs]) == key(album)
    assert inventory.local_inventory_root_for_tracks(config, [str(p) for p in copy_a + copy_b]) == key(copy_a[0].parent)
    assert inventory.local_inventory_root_for_tracks(config, [str(p) for p in loose]) is None, "never a whole library root"
    assert inventory.local_inventory_root_for_tracks(config, [str(root / "gone" / "01.mp3")]) is None


@pytest.mark.parametrize(("files_exist", "fallback", "expected"), [
    (True, Path("album"), ("publish", Path("album"))),
    (True, None, ("defer", {"delay_seconds": 3600, "error": None})),
    (False, None, ("defer", {})),
])
def test_unresolved_context_reports_storage_unavailable_only_when_files_are_missing(monkeypatch, files_exist, fallback, expected):
    from music_app.services import cover_workflow

    calls = []
    worker = inventory.LocalCoverInventoryWorker({}, repository=SimpleNamespace(work_slot=lambda: nullcontext(True)))
    worker._wake.set()
    worker._contexts.add(["context"], foreground=True)
    worker.repository.next_context = lambda key: {
        "context_key": key, "revision": 4, "track_paths": ["a/cd1/01.mp3", "a/cd2/01.mp3"], "foreground_requested": True,
    }

    def publish(key, revision, root, **kwargs):
        calls.append(("publish", root))
        worker._stop.set()

    def defer(key, revision, **kwargs):
        calls.append(("defer", kwargs))
        worker._stop.set()

    worker.repository.publish_context = publish
    worker.repository.defer_context = defer
    monkeypatch.setattr(cover_workflow, "resolve_album_root_from_track_paths", lambda *args, **kwargs: None)
    monkeypatch.setattr(inventory, "local_inventory_root_for_tracks", lambda config, paths: fallback)
    monkeypatch.setattr(inventory, "local_inventory_tracks_exist", lambda paths: files_exist)
    worker._run()

    assert calls == [expected]


def test_rewritten_tracks_keep_their_album_art_folder_but_moved_or_removed_tracks_do_not():
    """BUGFIX-19 (owner): a cover or tag save rewrites the tracks in place; reopening Cover Look Up
    must still find the album's art folder at once instead of rediscovering it."""
    from music_app.services.library_event_coordinator import TargetedMove, TargetedReconciliationRequest

    images = {".jpg", ".png"}
    track = Path("library/artist/album/01.mp3")
    rewritten = TargetedReconciliationRequest(root_id="r", paths=frozenset({track, track.with_name("cover.jpg")}))
    assert not inventory.watch_request_relocates_tracks(rewritten, images)

    removed = TargetedReconciliationRequest(root_id="r", deleted_paths=frozenset({track}))
    assert inventory.watch_request_relocates_tracks(removed, images)
    removed_image = TargetedReconciliationRequest(root_id="r", deleted_paths=frozenset({track.with_name("cover.jpg")}))
    assert not inventory.watch_request_relocates_tracks(removed_image, images)
    moved = TargetedReconciliationRequest(
        root_id="r", moves=(TargetedMove(track, Path("library/artist/other/01.mp3"), "r", "r"),),
    )
    assert inventory.watch_request_relocates_tracks(moved, images)
    removed_folder = TargetedReconciliationRequest(root_id="r", deleted_subtrees=frozenset({track.parent}))
    assert inventory.watch_request_relocates_tracks(removed_folder, images)


def test_a_request_waiting_for_a_folder_is_woken_when_the_worker_lists_it():
    import threading
    import time
    from music_app.services.local_cover_inventory import LocalCoverInventoryWorker, root_key

    worker = LocalCoverInventoryWorker({}, repository=object())
    started = time.monotonic()
    waiter = threading.Thread(target=worker.wait_for_listing, args=("C:/Music/Album", 5.0))
    waiter.start()
    # The worker may finish before or after the request starts waiting; it keeps publishing until woken.
    while waiter.is_alive() and time.monotonic() - started < 2.0:
        worker._mark_finished(("root", root_key("C:/Music/Other")))
        worker._mark_finished(("root", root_key("C:/Music/Album")))
        time.sleep(0.01)
    waiter.join(0.5)
    assert not waiter.is_alive()
    assert time.monotonic() - started < 2.0


def test_a_first_open_is_not_held_to_the_cap_when_the_worker_lists_the_folder_before_the_request_waits(monkeypatch):
    """FTC-COVERS-019P: the worker resolved the folder, then listed it while the request was still reading
    Postgres. The request began waiting after that listing finished and slept to the 1.5 s cap (a missed
    wake-up). A finish after the request began counts, so the open returns as soon as the folder is listed."""
    import asyncio
    import time
    from music_app.routes import api_wave_d_asgi_routes as routes
    from music_app.services import cover_workflow

    folder, track = "C:/Music/Artist/Album", "C:/Music/Artist/Album/01.mp3"
    listing = [{"path": folder + "/front.jpg", "filename": "front.jpg"}]
    read_before_listing, published, state, reads = Event(), Event(), {}, []

    def get(root):
        reads.append(root)
        stored = state.get("listing")
        if len(reads) == 1:
            # This read finds no listing; the worker publishes it before the request starts waiting.
            read_before_listing.set()
            assert published.wait(5.0)
        return stored

    def discover(*_args, **_kwargs):
        assert read_before_listing.wait(5.0)
        return listing

    def publish(root, revision, candidates):
        state["listing"] = {"available": True, "complete": True, "candidates": candidates}
        published.set()
        return True

    repository = SimpleNamespace(
        work_slot=lambda: nullcontext(True),
        request_context=lambda paths: {},
        next_context=lambda key: {"context_key": key, "track_paths": [track], "revision": 1, "retry_in": None},
        publish_context=lambda key, revision, root, *, foreground: state.setdefault("root", Path(root)),
        root_for_tracks=lambda paths: state.get("root"),
        get=get,
        request=lambda root: None,
        next_pending=lambda root: None if published.is_set() else {"root_path": root, "revision": 1, "retry_in": None},
        publish=publish,
    )
    monkeypatch.setattr(cover_workflow, "resolve_album_root_from_track_paths", lambda *_args, **_kwargs: Path(folder))
    monkeypatch.setattr(inventory, "discover_local_cover_inventory", discover)
    worker = inventory.LocalCoverInventoryWorker({}, repository=repository)
    worker.start()
    try:
        started = time.monotonic()
        album_root, listed = asyncio.run(routes._gallery_local_inventory(worker, None, {track}))
        elapsed = time.monotonic() - started
    finally:
        asyncio.run(worker.stop())

    assert album_root == Path(folder)
    assert listed["candidates"] == listing
    assert len(reads) == 2, "one read before the wait and one after, no polling (BI-05)"
    assert elapsed < routes._UNLISTED_INVENTORY_WAIT_SECONDS / 3, f"held {elapsed:.2f} s for a listed folder"


def test_a_wait_reports_how_it_ended_and_what_was_queued_for_the_request_diagnostics():
    """6.5 (FTC-COVERS-019P): passive diagnostics say whether the worker woke the request or the deadline did."""
    import threading
    import time
    from music_app.services.local_cover_inventory import LocalCoverInventoryWorker, root_key

    worker = LocalCoverInventoryWorker({}, repository=object())
    worker._listings.add([root_key("C:/Music/Opened")], foreground=True)
    worker._listings.add([root_key("C:/Music/Changed"), root_key("C:/Music/Other")])
    worker._contexts.add(["context"], foreground=True)
    assert worker.queue_depth() == {
        "working": None, "contexts_opened": 1, "contexts_changed": 0,
        "listings_opened": 1, "listings_changed": 2, "rechecks_opened": 0, "rechecks_changed": 0,
    }

    timed_out = worker.wait_for_listing("C:/Music/Album", 0.05)
    assert timed_out["outcome"] == "deadline"
    assert timed_out["waited_ms"] >= 40 and timed_out["last_finished_before_wait_ms"] is None

    threading.Timer(0.05, worker._mark_finished, args=[("root", root_key("C:/Music/Album"))]).start()
    woken = worker.wait_for_listing("C:/Music/Album", 5.0)
    assert woken["outcome"] == "woken" and woken["waited_ms"] < 1000

    time.sleep(0.02)
    again = worker.wait_for_listing("C:/Music/Album", 0.01)
    assert again["outcome"] == "deadline" and again["last_finished_before_wait_ms"] >= 15


class _SessionLease:
    """A session lease: records its statements and whether it was closed."""

    def __init__(self, acquired):
        self.acquired, self.statements, self.closed = acquired, [], False

    def __enter__(self):
        return self

    def __exit__(self, *_failure):
        self.closed = True
        return False

    def execute(self, sql, _params=None):
        self.statements.append(sql)
        return SimpleNamespace(fetchone=lambda: {"acquired": self.acquired})

    def commit(self):
        pass


@pytest.mark.parametrize("acquired", [True, False])
@pytest.mark.parametrize("slot_fails", [False, True])
def test_the_work_slot_holds_its_session_lock_on_a_session_lease_and_releases_it_on_every_path(
    monkeypatch, acquired, slot_fails,
):
    """BI-15 (6.5): the one-reader work slot is a session advisory lock, so it is taken on a session lease
    nobody borrows next (session_connection), never a pooled one; it is unlocked whether the slot's work ends
    or raises, and the lease is closed."""
    leases = []

    def session_connection(url):
        leases.append(_SessionLease(acquired))
        return leases[-1]

    monkeypatch.setattr(inventory, "session_connection", session_connection, raising=False)
    monkeypatch.setattr(inventory, "pooled_connection",
                        lambda *_a, **_k: pytest.fail("the work slot's session lock was taken on a pooled lease"))
    repository = inventory.LocalCoverInventoryRepository({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://work-slot"})

    if slot_fails:
        with pytest.raises(RuntimeError, match="slot work failed"):
            with repository.work_slot() as admitted:
                assert admitted is acquired
                raise RuntimeError("slot work failed")
    else:
        with repository.work_slot() as admitted:
            assert admitted is acquired

    assert len(leases) == 1 and leases[0].closed
    unlocks = [sql for sql in leases[0].statements if "pg_advisory_unlock" in sql]
    assert unlocks == (["select pg_advisory_unlock(hashtextextended('albumhaven-local-cover-inventory', 0))"]
                       if acquired else [])
