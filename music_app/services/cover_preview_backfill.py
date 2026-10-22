from __future__ import annotations

import logging
from pathlib import Path
import threading
import time
from typing import Callable, Mapping

from music_app.services.covers import (
    display_cover_variant_cache_root,
    find_existing_cover_display_variant,
    resolve_cover_display_variant,
)
from music_app.services.postgres_connections import pooled_connection


_DISPLAY_COVER_SIZE = 480
_COVER_PATHS_SQL = """
    SELECT DISTINCT
           cover_path,
           NULLIF(BTRIM(metadata ->> 'cover_revision'), '') AS cover_revision
    FROM library.local_albums
    WHERE NULLIF(BTRIM(cover_path), '') IS NOT NULL
    ORDER BY cover_path, cover_revision
"""


class CoverPreviewBackfill:
    """Persist shared gallery previews while the application is idle."""

    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[..., object] = pooled_connection,
        generate: Callable[..., object] = resolve_cover_display_variant,
        quiet_seconds: float = 2.0,
        throttle_seconds: float = 0.1,
        rescan_seconds: float = 60.0,
        logger: logging.Logger | None = None,
    ) -> None:
        self._database_url = str(
            config.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
        ).strip()
        self._config = config
        self._data_dir = config.get("DATA_DIR")
        self._connect = connect
        self._generate = generate
        self._quiet_seconds = max(0.0, float(quiet_seconds))
        self._throttle_seconds = max(0.0, float(throttle_seconds))
        self._rescan_seconds = max(0.01, float(rescan_seconds))
        self._logger = logger or logging.getLogger("music_app")
        self._stop_requested = threading.Event()
        self._activity_changed = threading.Event()
        self._activity_lock = threading.Lock()
        self._last_foreground_activity = 0.0
        self._worker: threading.Thread | None = None

    @property
    def is_running(self) -> bool:
        worker = self._worker
        return bool(worker and worker.is_alive())

    def note_foreground_activity(self) -> None:
        with self._activity_lock:
            self._last_foreground_activity = time.monotonic()
        self._activity_changed.set()

    def _wait_until_idle(self) -> bool:
        while not self._stop_requested.is_set():
            with self._activity_lock:
                idle_for = time.monotonic() - self._last_foreground_activity
            remaining = self._quiet_seconds - idle_for
            if remaining <= 0:
                return True
            self._activity_changed.clear()
            self._activity_changed.wait(timeout=remaining)
        return False

    def _load_cover_paths(self) -> list[tuple[Path, str | None]]:
        if not self._database_url:
            return []
        with self._connect(self._database_url, workload="browse") as connection:
            rows = connection.execute(_COVER_PATHS_SQL).fetchall()
        return [
            (
                Path(str(row.get("cover_path") or "").strip()),
                str(row.get("cover_revision") or "").strip() or None,
            )
            for row in rows
            if str(row.get("cover_path") or "").strip()
        ]

    def run_once(self) -> int:
        generated = 0
        for source_path, cover_revision in self._load_cover_paths():
            if not self._wait_until_idle():
                break
            generation_options = {}
            recorder = self._config.get("_GENERATED_PREVIEW_INVENTORY_RECORDER")
            if recorder is not None:
                generation_options["on_published"] = recorder
            self._generate(
                source_path,
                cache_root=display_cover_variant_cache_root(
                    source_path,
                    data_dir=self._data_dir if cover_revision else None,
                    storage_policy=self._config.get(
                        "_GENERATED_PREVIEW_STORAGE_POLICY"
                    ),
                ),
                max_size=_DISPLAY_COVER_SIZE,
                priority="background",
                revision=cover_revision,
                **generation_options,
            )
            generated += 1
            if self._stop_requested.wait(self._throttle_seconds):
                break
        return generated

    def inventory_existing_previews(self) -> int:
        recorder = self._config.get("_GENERATED_PREVIEW_INVENTORY_RECORDER")
        if recorder is None:
            return 0
        recorded = 0
        for source_path, cover_revision in self._load_cover_paths():
            for cache_root in (
                source_path.parent / ".album-haven" / "cover_variants",
                source_path.parent / ".album-haven" / "v1" / "cover_variants",
            ):
                if not cache_root.is_dir():
                    continue
                for preview_path in cache_root.rglob("*"):
                    if preview_path.is_file():
                        recorder(source_path, preview_path)
                        recorded += 1
            if self._data_dir and cover_revision:
                preview_path = find_existing_cover_display_variant(
                    source_path,
                    cache_root=Path(str(self._data_dir)) / "display-cover-cache",
                    max_size=_DISPLAY_COVER_SIZE,
                    revision=cover_revision,
                )
                if preview_path is not None:
                    recorder(source_path, preview_path)
                    recorded += 1
        return recorded

    def _run_forever(self) -> None:
        while not self._stop_requested.is_set():
            try:
                self.run_once()
            except Exception:
                self._logger.exception("Cover preview backfill pass failed.")
            if self._stop_requested.wait(self._rescan_seconds):
                return

    def start(self) -> None:
        if not self._database_url or self.is_running:
            return
        self._stop_requested.clear()
        self._worker = threading.Thread(
            target=self._run_forever,
            name="albumhaven-cover-preview-backfill",
            daemon=True,
        )
        self._worker.start()

    def stop(self, *, timeout_seconds: float = 30.0) -> None:
        self._stop_requested.set()
        self._activity_changed.set()
        worker = self._worker
        if worker is None:
            return
        worker.join(timeout_seconds)
        if worker.is_alive():
            raise TimeoutError(
                "Cover preview backfill did not stop within "
                f"{timeout_seconds:g} seconds."
            )
