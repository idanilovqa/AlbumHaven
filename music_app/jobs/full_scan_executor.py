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


class DurableFullScanExecutor:
    """Run the established scanner with durable progress and publication fences."""

    def __init__(self, *, config: dict[str, object], scan_repository: Any) -> None:
        self._config = dict(config)
        self._scan_repository = scan_repository
        self._local = threading.local()
        self._logger = logging.getLogger("music_app.jobs.full_scan")

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

        def publish_progress(
            *, phase: str, current: int, total: int, current_path: str
        ) -> None:
            nonlocal last_checkpoint_at, last_checkpoint
            if should_cancel():
                return
            snapshot = (phase, int(current), int(total), str(current_path or ""))
            moment = time.monotonic()
            terminal = total > 0 and current >= total
            if snapshot == last_checkpoint or (
                not terminal and moment - last_checkpoint_at < 0.5
            ):
                return
            checkpoint(
                phase=phase,
                current=current,
                total=total,
                current_path=current_path,
            )
            last_checkpoint = snapshot
            last_checkpoint_at = moment

        publication_state: dict[str, object] = {}
        file_cache, _last_scan = state_service.scan_music_incremental(
            use_existing_cache=False,
            config=self._config,
            logger=self._logger,
            library_state=library_state,
            expected_scan_generation=1,
            publication_state=publication_state,
            root_definitions=root_definitions,
            progress_callback=publish_progress,
            should_cancel=should_cancel,
            exception_overrides=dict(getattr(scope, "exception_overrides", {}) or {}),
        )
        if should_cancel():
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
