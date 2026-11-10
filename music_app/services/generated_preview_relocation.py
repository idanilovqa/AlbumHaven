from __future__ import annotations

import asyncio
import errno
import hashlib
import logging
import os
from pathlib import Path
import shutil
import stat
import threading
import time
from typing import Iterable, Mapping
from uuid import uuid4

from PIL import Image, UnidentifiedImageError

from music_app.services.generated_preview_storage import (
    managed_preview_relative_path,
    remove_empty_album_preview_directories,
)


class GeneratedPreviewRelocationWorker:
    def __init__(
        self,
        repository,
        *,
        batch_size: int = 20,
        logger=None,
        on_state=None,
        discover_inventory=None,
        retry_seconds: float = 5.0,
        refresh_seconds: float = 5.0,
        sync_grace_seconds: float = 1.0,
    ) -> None:
        self._repository = repository
        self._batch_size = max(1, min(int(batch_size), 100))
        self._logger = logger or logging.getLogger("music_app")
        self._on_state = on_state
        self._discover_inventory = discover_inventory
        self._retry_seconds = max(0.01, float(retry_seconds))
        self._refresh_seconds = max(0.01, float(refresh_seconds))
        self._sync_grace_seconds = max(0.0, float(sync_grace_seconds))
        self._wake_requested = threading.Event()
        self._stop_requested = threading.Event()
        self._thread: threading.Thread | None = None
        # The last album-folder cleanup (owner, 11-09), shown on the Server page, and a pending pass for folders on
        # drives that were unreachable; the first pass after start also covers a move finished before a restart.
        self.cleanup_summary: dict[str, object] | None = None
        self._cleanup_pending: tuple[str, str] | None = None
        self._cleanup_checked_at_start = False
        self._next_cleanup_at = 0.0

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
            self._wake_requested.wait(timeout=self._refresh_seconds)
            self._wake_requested.clear()
            if self._stop_requested.is_set():
                return
            try:
                retry = self._drain()
            except Exception:
                self._logger.exception("Generated preview relocation failed.")
                retry = True
            if retry and not self._stop_requested.wait(self._retry_seconds):
                self._wake_requested.set()

    def _drain(self) -> bool:
        state = self._repository.load()
        if self._on_state is not None:
            self._on_state(state)
        operation_id = str(state.get("operation_id") or "").strip()
        operation_state = str(state.get("operation_state") or "idle")
        self._run_pending_cleanup(state, operation_id, operation_state)
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
            return False
        with self._repository.operation_lock() as acquired:
            if not acquired:
                return True
            self._logger.info(
                "Generated preview relocation acquired the operation lock.",
                extra={"operation_id": operation_id, "operation_state": operation_state},
            )
            if operation_state == "queued" and self._sync_grace_seconds:
                if self._stop_requested.wait(self._sync_grace_seconds):
                    return False
                state = self._repository.load()
                operation_state = str(state.get("operation_state") or "idle")
                if self._on_state is not None:
                    self._on_state(state)
            if operation_state == "running":
                self._repository.recover_interrupted_items(operation_id=operation_id)
            if state.get("cancel_requested") or operation_state == "cancel_requested":
                state = self._repository.finish_operation(operation_id)
                if self._on_state is not None:
                    self._on_state(state)
                return False
            if self._discover_inventory is not None:
                discovered_count = self._discover_inventory()
                staged_count = self._repository.stage_inventory(operation_id=operation_id)
                self._logger.info(
                    "Generated preview relocation staged inventory.",
                    extra={
                        "operation_id": operation_id,
                        "discovered_count": discovered_count,
                        "staged_count": staged_count,
                    },
                )
                state = self._repository.load()
                if (
                    state.get("cancel_requested")
                    or state.get("operation_state") == "cancel_requested"
                ):
                    state = self._repository.finish_operation(operation_id)
                    if self._on_state is not None:
                        self._on_state(state)
                    return False
            quiet_sweep_complete = False
            while not self._stop_requested.is_set():
                items = self._repository.claim_batch(
                    operation_id=operation_id,
                    limit=self._batch_size,
                )
                self._logger.info(
                    "Generated preview relocation claimed a batch.",
                    extra={"operation_id": operation_id, "claimed_count": len(items)},
                )
                if not items:
                    if not quiet_sweep_complete:
                        if self._sync_grace_seconds and self._stop_requested.wait(
                            self._sync_grace_seconds
                        ):
                            return False
                        quiet_sweep_complete = True
                        continue
                    previous_state = state
                    state = self._repository.load()
                    if state.get("requested_mode") == "custom" and state.get("requested_root"):
                        self._clean_album_folders(operation_id, str(state["requested_root"]))
                    state = self._repository.finish_operation(operation_id)
                    if self._on_state is not None:
                        self._on_state(state)
                    _remove_superseded_custom_previews(previous_state, state)
                    return False
                quiet_sweep_complete = False
                for item in items:
                    result = _relocate_item(item, operation_id=operation_id)
                    source_to_delete = result.pop("source_to_delete", None)
                    # The source is deleted only while it still holds exactly the bytes that were published.
                    if source_to_delete is not None and _matches(
                        source_to_delete,
                        int(result["byte_count"]),
                        str(result["sha256"]),
                    ):
                        try:
                            source_to_delete.unlink()
                        except OSError as exc:
                            result["status"] = "failed"
                            result["error"] = str(exc)
                            self._logger.exception(
                                "Generated preview source cleanup failed for %s.",
                                source_to_delete,
                            )
                    if result["status"] == "completed" and source_to_delete is not None:
                        for parent in source_to_delete.parents:
                            if parent.name == ".album-haven":
                                try:
                                    remove_empty_album_preview_directories(
                                        parent, emptied_directory=source_to_delete.parent,
                                    )
                                except OSError as exc:
                                    self._logger.warning(
                                        "Generated preview moved, but empty directory cleanup failed: %s",
                                        exc,
                                    )
                                break
                    self._repository.complete_item(operation_id=operation_id, **result)
                    if self._stop_requested.is_set():
                        return False
                state = self._repository.load()
                if state.get("cancel_requested"):
                    state = self._repository.finish_operation(operation_id)
                    if self._on_state is not None:
                        self._on_state(state)
                    return False
        return False


    def _run_pending_cleanup(self, state, operation_id: str, operation_state: str) -> None:
        if not self._cleanup_checked_at_start:
            self._cleanup_checked_at_start = True
            if (operation_id and state.get("mode") == "custom" and state.get("active_root")
                    and operation_state in {"completed", "completed_with_failures"}):
                self._cleanup_pending = (operation_id, str(state["active_root"]))
        if self._cleanup_pending is None or time.monotonic() < self._next_cleanup_at:
            return
        if operation_state in {"queued", "running", "cancel_requested"}:
            return
        pending_operation, root = self._cleanup_pending
        self._clean_album_folders(pending_operation, root)

    def _clean_album_folders(self, operation_id: str, root: str) -> None:
        directories = [
            directory for directory in (
                album_cache_directory(path)
                for path in self._repository.covered_source_paths(operation_id=operation_id)
            ) if directory is not None
        ]
        summary = clean_album_preview_folders(
            directories, Path(root), operation_id=operation_id, stop_requested=self._stop_requested.is_set,
        )
        self.cleanup_summary = {
            "cleaned_count": summary["cleaned"],
            "kept_count": len(summary["kept"]),
            "left_count": len(summary["left"]),
        }
        self._logger.info(
            "Generated preview relocation cleaned album folders: %s cleaned, %s kept (%s), %s left for later (%s).",
            summary["cleaned"], len(summary["kept"]), "; ".join(summary["kept"][:5]),
            len(summary["left"]), "; ".join(summary["left"][:5]),
        )
        # Folders on a drive that was unreachable are cleaned on a later pass.
        self._cleanup_pending = (operation_id, root) if summary["left"] else None
        self._next_cleanup_at = time.monotonic() + _CLEANUP_RETRY_SECONDS


_CLEANUP_RETRY_SECONDS = 300.0


def _remove_superseded_custom_previews(
    previous_state: Mapping[str, object],
    state: Mapping[str, object],
) -> None:
    """A finished move leaves this regenerable cache unreachable, including any late copy."""
    previous_root = previous_state.get("active_root")
    if (
        previous_state.get("mode") == "custom"
        and previous_root
        and state.get("operation_state") == "completed"
        and state.get("active_root") != previous_root
    ):
        shutil.rmtree(Path(str(previous_root)) / "v1" / "cover_variants", ignore_errors=True)


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
        # Owner (11-09, UI-8): previews are regenerable, so an inventory checksum that went stale (the preview was
        # regenerated after it was recorded) must not fail the owner's move. A valid preview moves with its current
        # checksum, which the move records; a missing or unreadable one is left to be regenerated.
        if _matches(source, expected_bytes, expected_sha256):
            current = (expected_bytes, expected_sha256)
        else:
            current = _fingerprint(source) if _is_valid_image(source) else None
        published = _fingerprint(target)
        if published is not None and published != current:
            # A copy this move published before a restart (its source already gone) is accepted as is.
            if current is None and _is_valid_image(target):
                result.update(status="completed", byte_count=published[0], sha256=published[1])
                return result
            raise ValueError("A different file already exists at the preview destination.")
        if current is None:
            result.update(status="skipped", byte_count=0)
            return result
        expected_bytes, expected_sha256 = current
        result.update(byte_count=expected_bytes, sha256=expected_sha256)
        target.parent.mkdir(parents=True, exist_ok=True)
        if _same_volume(source, target):
            try:
                source.replace(target)
                result["source_to_delete"] = source
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
    except OSError:
        return False
    return _fingerprint(path) == (expected_bytes, expected_sha256)


def _fingerprint(path: Path) -> tuple[int, str] | None:
    """The file's size and SHA-256, or None when it is missing or unreadable."""
    try:
        if not path.is_file():
            return None
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
                size += len(chunk)
        return size, digest.hexdigest()
    except OSError:
        return None


def _is_valid_image(path: Path) -> bool:
    try:
        with Image.open(path) as image:
            image.verify()
        return True
    except (OSError, UnidentifiedImageError, ValueError, SyntaxError):
        return False


def _same_volume(source: Path, target: Path) -> bool:
    if source.drive or target.drive:
        return source.drive.casefold() == target.drive.casefold()
    existing_parent = target.parent
    while not existing_parent.exists() and existing_parent != existing_parent.parent:
        existing_parent = existing_parent.parent
    return source.stat().st_dev == existing_parent.stat().st_dev


def album_cache_directory(source_path: object) -> Path | None:
    """The album folder's ``.album-haven`` directory that holds a preview, if it is one."""
    path = Path(str(source_path or ""))
    for parent in path.parents:
        if parent.name.casefold() == ".album-haven":
            return parent
    return None


def clean_album_preview_folders(
    cache_directories: Iterable[Path],
    target_root: Path,
    *,
    operation_id: str,
    stop_requested=None,
) -> dict[str, object]:
    """Owner (11-09): a move to a custom folder leaves no ``.album-haven`` folders behind in the album folders it
    covered. App previews still there (written after the move passed) move to the custom folder with the move's
    checksum handling; a broken one is dropped (it is regenerated); empty folders are removed. A folder holding
    anything else is kept and reported, and an unreachable drive is left for a later pass. User files are never
    deleted."""
    summary: dict[str, object] = {"cleaned": 0, "kept": [], "left": []}
    seen: set[str] = set()
    for directory in cache_directories:
        if stop_requested is not None and stop_requested():
            break
        key = os.path.normcase(str(directory))
        if key in seen:
            continue
        seen.add(key)
        try:
            if not _drive_reachable(directory):
                summary["left"].append(str(directory))
                continue
            if not directory.is_dir() or _is_link(directory):
                continue
            keep = False
            for file_path in _iter_regular_files(directory):
                relative = managed_preview_relative_path(file_path)
                if relative is None:
                    keep = True
                elif _move_leftover_preview(file_path, target_root / relative, operation_id) == "conflict":
                    keep = True
            remove_empty_album_preview_directories(directory)
            if directory.exists():
                summary["kept"].append(str(directory))
            elif not keep:
                summary["cleaned"] += 1
        except OSError:
            summary["left"].append(str(directory))
    return summary


def _drive_reachable(directory: Path) -> bool:
    return Path(directory.anchor or str(directory)).exists()


def _is_link(path: Path) -> bool:
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _iter_regular_files(directory: Path):
    # Never follow a link or junction out of the cache folder.
    for child in list(directory.iterdir()):
        if _is_link(child):
            continue
        if child.is_dir():
            yield from _iter_regular_files(child)
        elif child.is_file():
            yield child


def _move_leftover_preview(source: Path, target: Path, operation_id: str) -> str:
    current = _fingerprint(source)
    if current is None:
        return "gone"
    if not _is_valid_image(source):
        source.unlink(missing_ok=True)
        return "dropped"
    published = _fingerprint(target)
    if published is not None:
        if published != current:
            return "conflict"
        source.unlink(missing_ok=True)
        return "moved"
    target.parent.mkdir(parents=True, exist_ok=True)
    if _same_volume(source, target):
        source.replace(target)
    else:
        _copy_publish(source, target, operation_id, *current)
        if _matches(source, *current):
            source.unlink()
    return "moved"
