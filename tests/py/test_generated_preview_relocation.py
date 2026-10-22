from __future__ import annotations

import asyncio
import hashlib
import time
from pathlib import Path

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
        self.completed = []
        self.finished = []
        self.claims = 0

    def load(self):
        return {
            "operation_id": self.operation_id,
            "operation_state": self.operation_state,
            "cancel_requested": self.operation_state == "cancel_requested",
        }

    def claim_batch(self, *, operation_id, limit):
        assert operation_id == self.operation_id
        self.claims += 1
        claimed, self.items = self.items[:limit], self.items[limit:]
        return claimed

    def complete_item(self, **result):
        self.completed.append(result)

    def finish_operation(self, operation_id):
        self.finished.append(operation_id)
        self.operation_state = "completed"
        return self.load()


def run_worker(repository):
    worker = GeneratedPreviewRelocationWorker(repository, batch_size=2)
    worker.start()
    worker.wake()
    deadline = time.monotonic() + 3
    while not repository.finished and time.monotonic() < deadline:
        time.sleep(0.01)
    asyncio.run(worker.stop(timeout_seconds=2))
    assert repository.finished == [repository.operation_id]


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


def test_cross_volume_copy_checkpoints_before_source_deletion(tmp_path, monkeypatch):
    content = b"cross-volume-preview"
    source = tmp_path / "source.webp"
    target = tmp_path / "managed/v1/cover_variants/ab/abcdef.webp"
    source.write_bytes(content)
    repository = FakeRepository([item(source, target, content)])
    original_complete = repository.complete_item

    def complete_item(**result):
        assert target.read_bytes() == content
        assert source.read_bytes() == content
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
