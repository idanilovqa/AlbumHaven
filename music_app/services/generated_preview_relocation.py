from __future__ import annotations

import asyncio
import errno
import hashlib
import logging
import os
from pathlib import Path
import shutil
import threading
from typing import Mapping
from uuid import uuid4


class GeneratedPreviewRelocationWorker:
    def __init__(
        self,
        repository,
        *,
        batch_size: int = 20,
        logger=None,
        on_state=None,
    ) -> None:
        self._repository = repository
        self._batch_size = max(1, min(int(batch_size), 100))
        self._logger = logger or logging.getLogger("music_app")
        self._on_state = on_state
        self._wake_requested = threading.Event()
        self._stop_requested = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._run,
            name="albumhaven-preview-relocation",
            daemon=True,
        )
        self._thread.start()
        self.wake()

    def wake(self) -> None:
        self._wake_requested.set()

    async def stop(self, *, timeout_seconds: float = 30.0) -> None:
        self._stop_requested.set()
        self._wake_requested.set()
        if self._thread is None:
            return
        await asyncio.to_thread(self._thread.join, timeout_seconds)
        if self._thread.is_alive():
            raise TimeoutError("Generated preview relocation did not stop in time.")

    def _run(self) -> None:
        while not self._stop_requested.is_set():
            self._wake_requested.wait()
            self._wake_requested.clear()
            if self._stop_requested.is_set():
                return
            try:
                self._drain()
            except Exception:
                self._logger.exception("Generated preview relocation failed.")

    def _drain(self) -> None:
        state = self._repository.load()
        if self._on_state is not None:
            self._on_state(state)
        operation_id = str(state.get("operation_id") or "").strip()
        operation_state = str(state.get("operation_state") or "idle")
        if (
            not operation_id
            and state.get("requested_mode")
            and operation_state == "idle"
        ):
            state = self._repository.begin_operation(operation_id=str(uuid4()))
            if self._on_state is not None:
                self._on_state(state)
            operation_id = str(state.get("operation_id") or "").strip()
            operation_state = str(state.get("operation_state") or "idle")
        if not operation_id or operation_state not in {
            "queued",
            "running",
            "cancel_requested",
        }:
            return
        if operation_state == "running":
            self._repository.recover_interrupted_items(operation_id=operation_id)
        if state.get("cancel_requested") or operation_state == "cancel_requested":
            state = self._repository.finish_operation(operation_id)
            if self._on_state is not None:
                self._on_state(state)
            return
        while not self._stop_requested.is_set():
            items = self._repository.claim_batch(
                operation_id=operation_id,
                limit=self._batch_size,
            )
            if not items:
                state = self._repository.finish_operation(operation_id)
                if self._on_state is not None:
                    self._on_state(state)
                return
            for item in items:
                result = _relocate_item(item, operation_id=operation_id)
                source_to_delete = result.pop("source_to_delete", None)
                self._repository.complete_item(operation_id=operation_id, **result)
                if source_to_delete is not None and _matches(
                    source_to_delete,
                    int(item["expected_bytes"]),
                    str(item["expected_sha256"]),
                ):
                    source_to_delete.unlink()
                if self._stop_requested.is_set():
                    return
            state = self._repository.load()
            if state.get("cancel_requested"):
                state = self._repository.finish_operation(operation_id)
                if self._on_state is not None:
                    self._on_state(state)
                return


def _relocate_item(item: Mapping[str, object], *, operation_id: str) -> dict[str, object]:
    source = Path(str(item["source_path"]))
    target = Path(str(item["target_path"]))
    expected_bytes = int(item["expected_bytes"])
    expected_sha256 = str(item["expected_sha256"]).casefold()
    result = {
        "item_id": int(item["id"]),
        "byte_count": expected_bytes,
        "sha256": expected_sha256,
        "error": None,
        "source_to_delete": None,
    }
    try:
        if _matches(target, expected_bytes, expected_sha256):
            result["status"] = "completed"
            result["source_to_delete"] = source if source != target else None
            return result
        if not _matches(source, expected_bytes, expected_sha256):
            raise ValueError("Source preview is missing or does not match its inventory checksum.")
        target.parent.mkdir(parents=True, exist_ok=True)
        if _same_volume(source, target):
            try:
                source.replace(target)
            except OSError as exc:
                if exc.errno != errno.EXDEV:
                    raise
                _copy_publish(source, target, operation_id, expected_bytes, expected_sha256)
                result["source_to_delete"] = source
        else:
            _copy_publish(source, target, operation_id, expected_bytes, expected_sha256)
            result["source_to_delete"] = source
        if not _matches(target, expected_bytes, expected_sha256):
            raise OSError("Published preview failed checksum verification.")
        result["status"] = "completed"
    except Exception as exc:
        result["status"] = "failed"
        result["error"] = str(exc)
        result["source_to_delete"] = None
    return result


def _copy_publish(
    source: Path,
    target: Path,
    operation_id: str,
    expected_bytes: int,
    expected_sha256: str,
) -> None:
    temporary = target.with_name(f".{target.name}.relocating-{operation_id}")
    try:
        with source.open("rb") as source_file, temporary.open("wb") as target_file:
            shutil.copyfileobj(source_file, target_file, length=1024 * 1024)
            target_file.flush()
            os.fsync(target_file.fileno())
        if not _matches(temporary, expected_bytes, expected_sha256):
            raise OSError("Copied preview failed checksum verification.")
        temporary.replace(target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _matches(path: Path, expected_bytes: int, expected_sha256: str) -> bool:
    try:
        if not path.is_file() or path.stat().st_size != expected_bytes:
            return False
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest() == expected_sha256
    except OSError:
        return False


def _same_volume(source: Path, target: Path) -> bool:
    if source.drive or target.drive:
        return source.drive.casefold() == target.drive.casefold()
    existing_parent = target.parent
    while not existing_parent.exists() and existing_parent != existing_parent.parent:
        existing_parent = existing_parent.parent
    return source.stat().st_dev == existing_parent.stat().st_dev
