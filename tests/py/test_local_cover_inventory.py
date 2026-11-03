from __future__ import annotations

from pathlib import Path
from contextlib import nullcontext
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


def test_discovery_cancellation_does_not_return_partial_inventory(tmp_path):
    (tmp_path / "cover.jpg").write_bytes(b"image")
    with pytest.raises(InterruptedError, match="cancelled"):
        inventory.discover_local_cover_inventory(tmp_path, {"IMAGE_EXTENSIONS": {".jpg"}}, cancel_requested=lambda: True)


def test_unreadable_refresh_never_publishes_empty_inventory(monkeypatch):
    calls = []
    worker = inventory.LocalCoverInventoryWorker({}, repository=SimpleNamespace(work_slot=lambda: nullcontext(True)))
    worker._wake.set()
    worker.repository.next_context = lambda **kwargs: None
    worker.repository.next_pending = lambda **kwargs: {"root_path": "missing", "revision": 7, "foreground_requested": True}
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
    worker.repository.next_context = lambda **kwargs: None
    worker.repository.next_pending = lambda **kwargs: {"root_path": "root", "revision": 1, "foreground_requested": True}
    worker.repository.publish = lambda *args: pytest.fail("Shutdown must not publish incomplete inventory")
    released = []
    worker.repository.defer = lambda *args, **kwargs: released.append((args, kwargs))
    def discover(*args, **kwargs):
        worker._stop.set()
        return [{"path": "partial.jpg"}]
    monkeypatch.setattr(inventory, "discover_local_cover_inventory", discover)

    worker._run()
    assert released == [(("root", 1), {"delay_seconds": 0})]


def test_foreground_activity_holds_background_invalidations_and_backfill():
    calls = []
    worker = inventory.LocalCoverInventoryWorker({}, repository=SimpleNamespace(work_slot=lambda: nullcontext(True)))
    worker._wake.set()
    worker.repository.next_context = lambda **kwargs: calls.append(("context", kwargs))
    def pending(**kwargs):
        calls.append(("inventory", kwargs))
        worker._stop.set()
    worker.repository.next_pending = pending
    worker.repository.next_album = lambda *args: pytest.fail("Backfill competes with foreground work")

    worker._run()

    assert calls == [("context", {"background": False}), ("inventory", {"background": False})]


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
    worker.repository.has_foreground_requests = lambda: False
    worker.repository.next_context = lambda **kwargs: None
    worker.repository.next_pending = lambda **kwargs: {"root_path": "background", "revision": 3, "foreground_requested": False}
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
    def resolve(config, value, **kwargs):
        calls.append(value)
        return Path(value)
    monkeypatch.setattr(cover_workflow, "resolve_configured_media_path", resolve)

    with pytest.raises(InterruptedError, match="context resolution cancelled"):
        cover_workflow.resolve_album_root_from_track_paths({}, {str(first), str(second)}, cancel_requested=lambda: bool(calls))

    assert len(calls) == 1


@pytest.mark.parametrize("unreadable", [False, True])
def test_context_shutdown_and_read_error_do_not_publish_a_root(monkeypatch, unreadable):
    from music_app.services import cover_workflow

    deferred = []
    worker = inventory.LocalCoverInventoryWorker({}, repository=SimpleNamespace(work_slot=lambda: nullcontext(True)))
    worker._wake.set()
    worker.repository.next_context = lambda **kwargs: {
        "context_key": "context", "revision": 4, "track_paths": ["album/song.mp3"],
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
        invalidate_paths=lambda *args, **kwargs: calls.append((args, kwargs)),
    ))
    worker.invalidate_paths(["library/artist"], subtree_paths=["library/artist"], context_changed=True)
    assert calls == [((["library/artist"],), {
        "subtree_paths": ["library/artist"], "context_changed": True,
    })]
    assert worker._wake.is_set()
