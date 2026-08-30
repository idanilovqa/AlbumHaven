from __future__ import annotations

import logging
import threading
from typing import Any

from music_app.services.app_logging import log_app_event
from music_app.services.lastfm_listen_sync import record_retry_summary
from music_app.services.lastfm_sync_bridge import process_pending_scrobble_attempt
from music_app.services.listen_history import load_pending_scrobble_entries, update_listen_history_entry
from music_app.services.lastfm import lastfm_api_enabled, scrobble_track

_RETRY_INTERVAL_SECONDS = 30 * 60
_RETRY_BATCH_LIMIT = 100
_RETRY_LOCK = threading.Lock()
_WORKER_LOCK = threading.Lock()
_WORKER_THREAD: threading.Thread | None = None
_WORKER_APP_KEY = ""
_WORKER_STOP_EVENT: threading.Event | None = None


def pending_scrobble_count(config: dict[str, Any]) -> int:
    return len(load_pending_scrobble_entries(config, limit=1_000_000))


def retry_pending_lastfm_scrobbles(
    config: dict[str, Any],
    *,
    limit: int = _RETRY_BATCH_LIMIT,
    reauthenticated: bool = False,
) -> dict[str, int]:
    summary = {
        "pending_before": 0,
        "attempted": 0,
        "succeeded": 0,
        "failed": 0,
        "pending_after": 0,
    }
    if not lastfm_api_enabled(config):
        return summary

    with _RETRY_LOCK:
        pending_entries = load_pending_scrobble_entries(config, limit=limit)
        summary["pending_before"] = len(pending_entries)
        if not pending_entries:
            return summary

        for entry in pending_entries:
            if not isinstance(entry, dict):
                continue
            result = process_pending_scrobble_attempt(
                config,
                entry,
                update_listen_history_entry=update_listen_history_entry,
                scrobble_track=scrobble_track,
                log_lastfm_scrobble_event=lambda action, *, level, payload, error="", retry_count=0: log_app_event(
                    config,
                    logging.getLogger("music_app"),
                    action,
                    level=level,
                    history=True,
                    artist=payload.get("artist", ""),
                    album=payload.get("album", ""),
                    title=payload.get("track", ""),
                    error=error,
                    retry_count=retry_count,
                ),
                reauthenticated=reauthenticated,
            )
            if not result["attempted"]:
                continue
            summary["attempted"] += 1
            if result["succeeded"]:
                summary["succeeded"] += 1
            elif result["failed"]:
                summary["failed"] += 1

        summary["pending_after"] = pending_scrobble_count(config)
        record_retry_summary(config, summary)
        return summary


def start_lastfm_retry_worker(app) -> None:
    config = app.config
    logger = app.logger

    global _WORKER_THREAD, _WORKER_APP_KEY, _WORKER_STOP_EVENT
    app_key = str(config.get("DATA_DIR") or "")
    with _WORKER_LOCK:
        if (
            _WORKER_THREAD
            and _WORKER_THREAD.is_alive()
            and _WORKER_APP_KEY == app_key
            and (_WORKER_STOP_EVENT is None or not _WORKER_STOP_EVENT.is_set())
        ):
            return

        if _WORKER_STOP_EVENT is not None:
            _WORKER_STOP_EVENT.set()

        stop_event = threading.Event()

        def worker() -> None:
            while not stop_event.is_set():
                try:
                    summary = retry_pending_lastfm_scrobbles(config)
                    if summary["attempted"]:
                        log_app_event(
                            config,
                            logger,
                            "Last.fm retry pass completed",
                            attempted=summary["attempted"],
                            succeeded=summary["succeeded"],
                            failed=summary["failed"],
                            pending_after=summary["pending_after"],
                        )
                except Exception as exc:
                    log_app_event(
                        config,
                        logger,
                        "Last.fm retry worker failed",
                        level="error",
                        error=str(exc),
                    )
                stop_event.wait(_RETRY_INTERVAL_SECONDS)

        _WORKER_APP_KEY = app_key
        _WORKER_STOP_EVENT = stop_event
        _WORKER_THREAD = threading.Thread(
            target=worker,
            name="albumhaven-lastfm-retry",
            daemon=True,
        )
        _WORKER_THREAD.start()


def stop_lastfm_retry_worker(app=None, *, wait: bool = False, timeout: float = 5.0) -> bool:
    global _WORKER_THREAD, _WORKER_APP_KEY, _WORKER_STOP_EVENT

    app_key = str(app.config.get("DATA_DIR") or "") if app is not None else ""
    thread: threading.Thread | None = None
    with _WORKER_LOCK:
        if app is not None and app_key != _WORKER_APP_KEY:
            return False
        if _WORKER_STOP_EVENT is None:
            return False

        _WORKER_STOP_EVENT.set()
        thread = _WORKER_THREAD

    if wait and thread is not None:
        thread.join(timeout=timeout)

    with _WORKER_LOCK:
        if _WORKER_THREAD is thread and (thread is None or not thread.is_alive()):
            _WORKER_THREAD = None
            _WORKER_APP_KEY = ""
            _WORKER_STOP_EVENT = None

    return True
