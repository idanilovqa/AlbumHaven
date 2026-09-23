"""Adapter from a durable full-scan claim to the existing scan pipeline."""

from __future__ import annotations

from datetime import datetime, timezone
import logging
from pathlib import Path
from types import SimpleNamespace
import threading
import time
from typing import Any

from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
from music_app.services import state as state_service
from music_app.jobs.safe_logging import DurablePipelineLogger


class DurableFullScanExecutor:
    """Run the established scanner with durable progress and publication fences."""

    def __init__(self, *, config: dict[str, object], scan_repository: Any) -> None:
        self._config = {**dict(config), "DURABLE_WORKER_SAFE_LOGGING": True}
        self._scan_repository = scan_repository
        self._local = threading.local()
        self._logger = DurablePipelineLogger(
            logging.getLogger("music_app.jobs.full_scan"), domain="scan"
        )

    def bind_claim(self, claim: Any) -> None:
        self._local.claim = claim

    def bind_scope(self, scope: Any) -> None:
        self._local.scope = scope

    def run(
        self,
        intent: Any,
        *,
        roots: tuple[dict[str, object], ...],
        checkpoint: Any,
        should_cancel: Any,
        expected_revision: int,
    ) -> SimpleNamespace:
        claim = getattr(self._local, "claim", None)
        scope = getattr(self._local, "scope", None)
        if claim is None:
            raise RuntimeError("full scan claim is unavailable")
        holder = SimpleNamespace()
        state_service.init_state(holder)
        library_state = holder.library_state
        library_state["scan_generation"] = 1
        library_state["scan_in_progress"] = True
        library_state["scan_started_at"] = time.time()
        library_state["scan_mode"] = str(intent.mode)
        library_state["rescan_ignore_existing_cache"] = bool(intent.force)
        root_definitions = [
            {
                **dict(root),
                "path": Path(str(root.get("path") or "")).resolve(strict=False),
            }
            for root in roots
        ]
        last_checkpoint_at = 0.0
        last_checkpoint: tuple[str, int, int, str] | None = None
        last_cancel_check_at = 0.0
        last_cancel_result = False

        def cancellation_requested(*, force: bool = False) -> bool:
            nonlocal last_cancel_check_at, last_cancel_result
            moment = time.monotonic()
            if force or moment - last_cancel_check_at >= 1.0:
                last_cancel_result = bool(should_cancel())
                last_cancel_check_at = time.monotonic()
            return last_cancel_result

        def publish_progress(
            *, phase: str, current: int, total: int, current_path: str
        ) -> None:
            nonlocal last_checkpoint_at, last_checkpoint
            snapshot = (phase, int(current), int(total), str(current_path or ""))
            moment = time.monotonic()
            terminal = total > 0 and current >= total
            phase_unchanged = last_checkpoint is not None and phase == last_checkpoint[0]
            minimum_progress_delta = max(100, total // 10) if total > 0 else 100
            progress_delta = (
                int(current) - last_checkpoint[1]
                if phase_unchanged and last_checkpoint is not None
                else minimum_progress_delta
            )
            if snapshot == last_checkpoint or (
                phase_unchanged
                and not terminal
                and (
                    progress_delta < minimum_progress_delta
                    or moment - last_checkpoint_at < 5.0
                )
            ):
                return
            if cancellation_requested(force=True):
                return
            checkpoint(
                phase=phase,
                current=current,
                total=total,
                current_path=current_path,
                elapsed_seconds=float(library_state.get("scan_elapsed_seconds") or 0.0),
                estimated_remaining_seconds=float(
                    library_state.get("scan_estimated_remaining_seconds") or 0.0
                ),
                files_per_second=float(library_state.get("scan_files_per_second") or 0.0),
                album_folders_processed=int(
                    library_state.get("scan_album_folders_processed") or 0
                ),
                album_folders_total=int(
                    library_state.get("scan_album_folders_total") or 0
                ),
            )
            last_checkpoint = snapshot
            # Measure the throttle window after the durable write. A slow
            # checkpoint must not make every immediately following file look
            # overdue and turn indexing into one database round trip per file.
            last_checkpoint_at = time.monotonic()

        publication_state: dict[str, object] = {}
        # ``force`` bypasses the cache-age early return for any explicit scan.
        # Only the dedicated full-rescan mode discards unchanged file metadata.
        use_existing_cache = str(intent.mode) != "manual_full_rescan"
        if use_existing_cache:
            existing_cache = self._scan_repository.load_claimed_full_scan_cache(
                claim=claim,
                intent_id=int(intent.intent_id),
                now=datetime.now(timezone.utc),
            )
            if existing_cache is None:
                raise state_service.ScanCancelled("Library indexing cancelled")
            publication_state["file_cache"] = existing_cache

        def publish_partial_snapshot() -> None:
            if cancellation_requested(force=True):
                raise state_service.ScanCancelled("Library indexing cancelled")
            accepted = self._scan_repository.publish_claimed_full_scan_preview(
                claim=claim,
                intent_id=int(intent.intent_id),
                file_cache=dict(publication_state.get("file_cache") or {}),
                separate_release_keys=tuple(
                    getattr(scope, "separate_release_keys", ()) or ()
                ),
                album_total=len(publication_state.get("albums") or ()),
                now=datetime.now(timezone.utc),
            )
            if not accepted:
                raise state_service.ScanCancelled("Library indexing cancelled")

        file_cache, _last_scan = state_service.scan_music_incremental(
            use_existing_cache=use_existing_cache,
            config=self._config,
            logger=self._logger,
            library_state=library_state,
            expected_scan_generation=1,
            publication_state=publication_state,
            publish_partial_snapshot=publish_partial_snapshot,
            root_definitions=root_definitions,
            progress_callback=publish_progress,
            should_cancel=cancellation_requested,
            exception_overrides=dict(getattr(scope, "exception_overrides", {}) or {}),
        )
        if cancellation_requested(force=True):
            return SimpleNamespace(canceled=True)
        publish_progress(
            phase="finalizing",
            current=int(library_state.get("scan_processed") or 0),
            total=int(library_state.get("scan_total") or 0),
            current_path="",
        )
        if cancellation_requested(force=True):
            return SimpleNamespace(canceled=True)
        adapter = PostgresScanCacheAdapter(self._config)
        inventory = adapter.prepare_full_scan_inventory(
            file_cache,
            separate_release_keys=set(
                getattr(scope, "separate_release_keys", ()) or ()
            ),
        )
        result = self._scan_repository.publish_claimed_full_scan(
            claim=claim,
            intent_id=intent.intent_id,
            expected_inventory_mutation_revision=expected_revision,
            inventory=inventory,
            observed_root_ids=tuple(root["id"] for root in root_definitions),
            now=datetime.now(timezone.utc),
        )
        if result.get("publication_won") is not True:
            raise RuntimeError("inventory revision conflict")
        return SimpleNamespace(
            canceled=False,
            inventory_mutation_revision=result["inventory_mutation_revision"],
        )


__all__ = ["DurableFullScanExecutor"]
