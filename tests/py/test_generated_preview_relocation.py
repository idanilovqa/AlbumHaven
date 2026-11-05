from __future__ import annotations

import asyncio
from contextlib import nullcontext
import hashlib
import time
from pathlib import Path

import pytest

from music_app.services import generated_preview_relocation as relocation
from music_app.services.generated_preview_relocation import (
    GeneratedPreviewRelocationWorker,
)


def item(source: Path, target: Path, content: bytes, **overrides):
    values = {
        "id": 1,
        "source_path": str(source),
        "target_path": str(target),
        "expected_bytes": len(content),
        "expected_sha256": hashlib.sha256(content).hexdigest(),
        "status": "running",
    }
    values.update(overrides)
    return values


class FakeRepository:
    def __init__(self, items, *, operation_state="running"):
        self.items = list(items)
        self.operation_id = "10e2fc89-439a-4f74-a508-97596cf20771"
        self.operation_state = operation_state
        self.mode = "album_folders"
        self.active_root = None
        self.completed = []
        self.finished = []
        self.recovered = []
        self.claims = 0
        self.staged = []
        self.cleanup_failures = []

    def load(self):
        return {
            "mode": self.mode,
            "active_root": self.active_root,
            "operation_id": self.operation_id,
            "operation_state": self.operation_state,
            "cancel_requested": self.operation_state == "cancel_requested",
        }

    def operation_lock(self):
        return nullcontext(True)

    def stage_inventory(self, *, operation_id):
        self.staged.append(operation_id)

    def claim_batch(self, *, operation_id, limit):
        assert operation_id == self.operation_id
        self.claims += 1
        claimed, self.items = self.items[:limit], self.items[limit:]
        return claimed

    def recover_interrupted_items(self, *, operation_id):
        assert operation_id == self.operation_id
        self.recovered.append(operation_id)

    def complete_item(self, **result):
        self.completed.append(result)

    def fail_item_cleanup(self, **result):
        self.cleanup_failures.append(result)

    def finish_operation(self, operation_id):
        self.finished.append(operation_id)
        self.operation_state = "completed"
        return self.load()


def run_worker(repository):
    worker = GeneratedPreviewRelocationWorker(
        repository,
        batch_size=2,
        sync_grace_seconds=0,
    )
    worker.start()
    worker.wake()
    deadline = time.monotonic() + 3
    while not repository.finished and time.monotonic() < deadline:
        time.sleep(0.01)
    asyncio.run(worker.stop(timeout_seconds=2))
    assert repository.finished == [repository.operation_id]


@pytest.mark.parametrize(
    ("final_state", "cache_removed"),
    [("completed", True), ("completed_with_failures", False)],
)
def test_finished_move_off_a_custom_root_clears_only_its_preview_cache(
    tmp_path, final_state, cache_removed,
):
    root = tmp_path / "custom"
    late_copy = root / "v1/cover_variants/ab/late.webp"
    late_copy.parent.mkdir(parents=True)
    late_copy.write_bytes(b"late")
    unrelated = root / "keep.txt"
    unrelated.write_bytes(b"keep")
    repository = FakeRepository([])
    repository.mode = "custom"
    repository.active_root = str(root)
    finish_operation = repository.finish_operation

    def finish_with_new_root(operation_id):
        repository.mode = "album_folders"
        repository.active_root = None
        finish_operation(operation_id)
        repository.operation_state = final_state
        return repository.load()

    repository.finish_operation = finish_with_new_root

    run_worker(repository)

    assert late_copy.exists() is not cache_removed
    assert unrelated.exists()


def test_same_volume_move_is_atomic_and_checkpointed(tmp_path):
    content = b"preview-bytes"
    source = tmp_path / "source.webp"
    target = tmp_path / "managed/v1/cover_variants/ab/abcdef.webp"
    source.write_bytes(content)
    repository = FakeRepository([item(source, target, content)])

    run_worker(repository)

    assert target.read_bytes() == content
    assert not source.exists()
    assert repository.completed[0]["status"] == "completed"


def test_relocation_removes_empty_album_preview_tree_and_preserves_music(tmp_path):
    album = tmp_path / "album"
    source = album / ".album-haven/cover_variants/ab/preview.webp"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"preview")
    music = album / "song.mp3"
    music.write_bytes(b"music")
    target = tmp_path / "ssd/v1/cover_variants/ab/preview.webp"
    repository = FakeRepository([item(source, target, b"preview")])
    run_worker(repository)
    assert target.read_bytes() == b"preview"
    assert not (album / ".album-haven").exists()
    assert music.read_bytes() == b"music"


def test_relocation_prunes_only_moved_preview_ancestors_without_scanning_siblings(tmp_path, monkeypatch):
    root = tmp_path / "album/.album-haven"
    source = root / "cover_variants/ab/preview.webp"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"preview")
    sibling = root / "cover_variants/cd/keep.webp"
    sibling.parent.mkdir(parents=True)
    sibling.write_bytes(b"keep")
    target = tmp_path / "ssd/preview.webp"

    def unexpected_listing(_path):
        raise AssertionError("Relocating one preview must not enumerate cache siblings")

    monkeypatch.setattr(Path, "iterdir", unexpected_listing)
    run_worker(FakeRepository([item(source, target, b"preview")]))
    assert not source.parent.exists()
    assert sibling.read_bytes() == b"keep"
    assert target.read_bytes() == b"preview"


@pytest.mark.parametrize("same_volume", [True, False])
def test_pruning_failure_preserves_verified_relocation(tmp_path, monkeypatch, caplog, same_volume):
    source = tmp_path / "album/.album-haven/cover_variants/ab/preview.webp"
    source.parent.mkdir(parents=True)
    content = b"verified-preview"
    source.write_bytes(content)
    target = tmp_path / "ssd/preview.webp"
    repository = FakeRepository([item(source, target, content)])
    monkeypatch.setattr(relocation, "_same_volume", lambda _source, _target: same_volume)

    def fail_pruning(directory, *, emptied_directory):
        assert directory == source.parents[2]
        assert emptied_directory == source.parent
        assert not source.exists()
        assert target.read_bytes() == content
        raise PermissionError("empty preview directory is locked")

    monkeypatch.setattr(relocation, "remove_empty_album_preview_directories", fail_pruning)
    run_worker(repository)

    assert not source.exists()
    assert target.read_bytes() == content
    assert repository.completed == [{
        "operation_id": repository.operation_id,
        "item_id": 1,
        "status": "completed",
        "byte_count": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "error": None,
    }]
    assert "empty preview directory is locked" in caplog.text


def test_relocation_preserves_unrecognized_files_in_preview_directory(tmp_path):
    source = tmp_path / "album/.album-haven/cover_variants/ab/preview.webp"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"preview")
    keep = source.parents[2] / "keep.txt"
    keep.write_text("keep")
    target = tmp_path / "ssd/preview.webp"
    run_worker(FakeRepository([item(source, target, b"preview")]))
    assert keep.read_text() == "keep"
    assert not source.parent.exists()


def test_previous_relocation_empty_directories_are_pruned(tmp_path):
    from music_app.services.generated_preview_storage import remove_empty_album_preview_directories
    root = tmp_path / "album/.album-haven"
    (root / "v1/cover_variants/ab").mkdir(parents=True)
    remove_empty_album_preview_directories(root)
    assert not root.exists()
    assert root.parent.exists()


def test_same_volume_move_preserves_source_recreated_after_terminal_checkpoint(tmp_path):
    content = b"preview-recreated-during-relocation"
    source = tmp_path / "source.webp"
    target = tmp_path / "managed/v1/cover_variants/ab/abcdef.webp"
    source.write_bytes(content)
    repository = FakeRepository([item(source, target, content)])
    original_complete = repository.complete_item

    def complete_item(**result):
        original_complete(**result)
        source.write_bytes(content)

    repository.complete_item = complete_item

    run_worker(repository)

    assert target.read_bytes() == content
    assert source.read_bytes() == content
    assert repository.completed[0]["status"] == "completed"
    assert repository.cleanup_failures == []


def test_cross_volume_copy_deletes_source_before_terminal_checkpoint(tmp_path, monkeypatch):
    content = b"cross-volume-preview"
    source = tmp_path / "source.webp"
    target = tmp_path / "managed/v1/cover_variants/ab/abcdef.webp"
    source.write_bytes(content)
    repository = FakeRepository([item(source, target, content)])
    original_complete = repository.complete_item

    def complete_item(**result):
        assert target.read_bytes() == content
        assert not source.exists()
        original_complete(**result)

    repository.complete_item = complete_item
    monkeypatch.setattr(relocation, "_same_volume", lambda _source, _target: False)

    run_worker(repository)

    assert not source.exists()
    assert repository.completed[0]["status"] == "completed"


def test_hash_mismatch_fails_without_deleting_source_or_publishing_target(tmp_path):
    source = tmp_path / "source.webp"
    target = tmp_path / "managed/v1/cover_variants/ab/abcdef.webp"
    source.write_bytes(b"unexpected")
    repository = FakeRepository([item(source, target, b"expected")])

    run_worker(repository)

    assert source.read_bytes() == b"unexpected"
    assert not target.exists()
    assert repository.completed[0]["status"] == "failed"


def test_restart_accepts_verified_target_when_source_already_disappeared(tmp_path):
    content = b"already-published"
    source = tmp_path / "missing.webp"
    target = tmp_path / "managed/v1/cover_variants/ab/abcdef.webp"
    target.parent.mkdir(parents=True)
    target.write_bytes(content)
    repository = FakeRepository([item(source, target, content)])

    run_worker(repository)

    assert target.read_bytes() == content
    assert repository.completed[0]["status"] == "completed"


def test_interrupted_partial_copy_is_replaced_and_unrelated_files_survive(
    tmp_path, monkeypatch
):
    content = b"complete-preview"
    source = tmp_path / "source.webp"
    target = tmp_path / "managed/v1/cover_variants/ab/abcdef.webp"
    unrelated = target.parent / "keep.txt"
    source.write_bytes(content)
    target.parent.mkdir(parents=True)
    unrelated.write_text("keep", encoding="utf-8")
    repository = FakeRepository([item(source, target, content)])
    temp = target.with_name(
        f".{target.name}.relocating-{repository.operation_id}"
    )
    temp.write_bytes(b"partial")
    monkeypatch.setattr(relocation, "_same_volume", lambda _source, _target: False)

    run_worker(repository)

    assert target.read_bytes() == content
    assert unrelated.read_text(encoding="utf-8") == "keep"
    assert not temp.exists()


def test_source_cleanup_failure_is_durable_and_retryable(tmp_path, monkeypatch):
    content = b"already-published"
    source = tmp_path / "source.webp"
    target = tmp_path / "target.webp"
    source.write_bytes(content)
    target.write_bytes(content)
    repository = FakeRepository([item(source, target, content)])
    original_unlink = Path.unlink

    def fail_source_unlink(path, *args, **kwargs):
        if path == source:
            raise PermissionError("source is locked")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_source_unlink)
    run_worker(repository)

    assert source.exists()
    assert target.read_bytes() == content
    assert repository.completed[0]["status"] == "failed"
    assert repository.completed[0]["error"] == "source is locked"
    assert repository.cleanup_failures == []


def test_cancellation_stops_at_file_boundary_without_claiming(tmp_path):
    content = b"preview"
    source = tmp_path / "source.webp"
    target = tmp_path / "target.webp"
    source.write_bytes(content)
    repository = FakeRepository(
        [item(source, target, content)], operation_state="cancel_requested"
    )

    run_worker(repository)

    assert repository.claims == 0
    assert repository.completed == []
    assert source.read_bytes() == content
    assert not target.exists()


def test_worker_recovers_interrupted_claims_before_resuming():
    repository = FakeRepository([])

    run_worker(repository)

    assert repository.recovered == [repository.operation_id]


def test_worker_does_not_recover_or_claim_without_database_operation_lock():
    repository = FakeRepository([])
    repository.operation_lock = lambda: nullcontext(False)
    worker = GeneratedPreviewRelocationWorker(
        repository,
        retry_seconds=0.01,
        sync_grace_seconds=0,
    )
    worker.start()
    time.sleep(0.03)
    asyncio.run(worker.stop(timeout_seconds=2))

    assert repository.recovered == []
    assert repository.claims == 0


def test_worker_discovers_existing_previews_before_claiming(tmp_path):
    content = b"existing-preview"
    source = tmp_path / "source.webp"
    target = tmp_path / "target.webp"
    source.write_bytes(content)
    repository = FakeRepository([])
    discovered = []

    def discover():
        discovered.append(True)
        repository.items.append(item(source, target, content))

    worker = GeneratedPreviewRelocationWorker(
        repository,
        discover_inventory=discover,
        retry_seconds=0.01,
        sync_grace_seconds=0,
    )
    worker.start()
    deadline = time.monotonic() + 2
    while not repository.finished and time.monotonic() < deadline:
        time.sleep(0.01)
    asyncio.run(worker.stop(timeout_seconds=2))

    assert discovered == [True]
    assert repository.staged == [repository.operation_id]
    assert target.read_bytes() == content


def test_worker_sweeps_previews_published_while_finishing(tmp_path):
    content = b"late-preview"
    source = tmp_path / "source.webp"
    target = tmp_path / "managed/v1/cover_variants/ab/abcdef.webp"
    late_item = item(source, target, content)

    class LatePublishRepository(FakeRepository):
        published = False

        def claim_batch(self, *, operation_id, limit):
            claimed = super().claim_batch(operation_id=operation_id, limit=limit)
            if not claimed and not self.published:
                source.write_bytes(content)
                self.items.append(late_item)
                self.published = True
            return claimed

    repository = LatePublishRepository([])

    worker = GeneratedPreviewRelocationWorker(
        repository,
        retry_seconds=0.01,
        sync_grace_seconds=0,
    )
    worker.start()
    deadline = time.monotonic() + 2
    while not repository.finished and time.monotonic() < deadline:
        time.sleep(0.01)
    asyncio.run(worker.stop(timeout_seconds=2))

    assert repository.finished == [repository.operation_id]
    assert target.read_bytes() == content
    assert not source.exists()


def test_cancellation_during_inventory_discovery_stops_before_claiming():
    repository = FakeRepository([])

    def discover():
        repository.operation_state = "cancel_requested"

    worker = GeneratedPreviewRelocationWorker(
        repository,
        discover_inventory=discover,
        retry_seconds=0.01,
        sync_grace_seconds=0,
    )
    worker.start()
    deadline = time.monotonic() + 2
    while not repository.finished and time.monotonic() < deadline:
        time.sleep(0.01)
    asyncio.run(worker.stop(timeout_seconds=2))

    assert repository.claims == 0
    assert repository.finished == [repository.operation_id]


def test_idle_worker_refreshes_policy_changed_by_another_process():
    repository = FakeRepository([], operation_state="idle")
    observed = []
    worker = GeneratedPreviewRelocationWorker(
        repository,
        on_state=lambda state: observed.append(state["mode"]),
        refresh_seconds=0.01,
        sync_grace_seconds=0,
    )
    worker.start()
    deadline = time.monotonic() + 1
    while not observed and time.monotonic() < deadline:
        time.sleep(0.005)
    repository.mode = "custom"
    deadline = time.monotonic() + 1
    while "custom" not in observed and time.monotonic() < deadline:
        time.sleep(0.005)
    asyncio.run(worker.stop(timeout_seconds=2))

    assert "custom" in observed


def test_worker_recovers_requested_location_left_before_operation_start():
    class InterruptedRequestRepository(FakeRepository):
        def __init__(self):
            super().__init__([], operation_state="idle")
            self.operation_id = None
            self.started = []

        def load(self):
            return {
                "operation_id": self.operation_id,
                "operation_state": self.operation_state,
                "requested_mode": "custom",
                "requested_root": "C:/previews",
                "cancel_requested": False,
            }

        def begin_operation(self, *, operation_id):
            self.started.append(operation_id)
            self.operation_id = operation_id
            self.operation_state = "queued"
            return self.load()

    repository = InterruptedRequestRepository()

    run_worker(repository)

    assert len(repository.started) == 1
    assert repository.finished == [repository.operation_id]
