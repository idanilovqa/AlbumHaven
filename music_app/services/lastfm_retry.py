from __future__ import annotations

import logging
import threading
from typing import Any

from music_app.services.app_logging import log_app_event
from music_app.services.log_history import HistoryScope
from music_app.services.listen_history_postgres import PendingListenEntry
from music_app.services.lastfm_listen_sync import record_retry_summary
from music_app.services.lastfm_sync_bridge import process_pending_scrobble_attempt, record_playback_session_complete
from music_app.services.listen_history import (load_pending_scrobble_entries, update_listen_history_entry,
    is_meaningful_listen_session, build_listen_history_status_counts)
from music_app.services.playback_session_payloads import normalize_playback_track_payload
from music_app.services.lastfm import (
    LastfmSubmissionOutcome,
    get_saved_lastfm_session,
    lastfm_api_enabled,
    scrobble_track,
)

_RETRY_INTERVAL_SECONDS = 30 * 60
_RETRY_BATCH_LIMIT = 100
_RETRY_LOCK = threading.Lock()
_WORKER_LOCK = threading.Lock()
_WORKER_THREAD: threading.Thread | None = None
_WORKER_APP_KEY = ""
_WORKER_STOP_EVENT: threading.Event | None = None


class LastfmRetryBatchError(RuntimeError):
    def __init__(self, summary: dict[str, int]) -> None:
        super().__init__("Last.fm retry batch failed.")
        self.summary = dict(summary)


def pending_scrobble_count(
    config: dict[str, Any], *, account_id: int | None = None, library_id: int | None = None,
) -> int:
    if account_id is not None and library_id is not None:
        return build_listen_history_status_counts(
            config, account_id=account_id, library_id=library_id,
        )["pending_scrobble_count"]
    if account_id is not None or library_id is not None:
        return len(load_pending_scrobble_entries(
            config,
            limit=1_000_000,
            eligible=lambda pending: (
                (account_id is None or pending.account_id == account_id)
                and (library_id is None or pending.library_id == library_id)
            ),
        ))
    return len(load_pending_scrobble_entries(config, limit=1_000_000))


def retry_pending_lastfm_scrobbles(
    config: dict[str, Any],
    *,
    limit: int = _RETRY_BATCH_LIMIT,
    reauthenticated: bool = False,
    account_id: int | None = None,
    library_id: int | None = None,
    bypass_backoff: bool = False,
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
        eligible_sessions = {}

        def retry_eligible(pending: PendingListenEntry) -> bool:
            if account_id is not None and pending.account_id != account_id:
                return False
            if library_id is not None and pending.library_id != library_id:
                return False
            if pending.account_id not in eligible_sessions:
                eligible_sessions[pending.account_id] = get_saved_lastfm_session(
                    config, account_id=pending.account_id,
                )
            return eligible_sessions[pending.account_id] is not None

        pending_entries = load_pending_scrobble_entries(
            config, limit=limit, eligible=retry_eligible,
        )
        summary["pending_before"] = len(pending_entries)
        summary["pending_after"] = summary["pending_before"]
        if not pending_entries:
            return summary

        try:
            for pending in pending_entries:
                if not isinstance(pending, PendingListenEntry):
                    continue
                entry = pending.entry
                if entry.get("measurement_version") == "rendered-pcm-v1":
                    session = eligible_sessions[pending.account_id]
                    payload = {**entry, **dict(entry.get("canonical_match") or {})}
                    scope = HistoryScope(
                        library_id=pending.library_id,
                        account_id=pending.account_id,
                        origin_kind="retry",
                    )

                    def submit_measured_scrobble(_config, _retry_payload, *, owner=pending):
                        body, _status = record_playback_session_complete(
                            config, payload,
                            account_id=owner.account_id, library_id=owner.library_id,
                            lastfm_session=session, user_timezone=str(entry.get("user_timezone") or "UTC"),
                            normalize_playback_track_payload=normalize_playback_track_payload,
                            is_meaningful_listen_session=is_meaningful_listen_session,
                            # Refresh the trusted receipt inside the provider guard. A retry
                            # must not revalidate an indexed path that may have changed.
                            append_listen_history_entry=lambda config, _entry, **row_scope: update_listen_history_entry(
                                config, owner.entry["id"], {}, row_id=owner.row_id, **row_scope,
                            ),
                            update_listen_history_entry=update_listen_history_entry,
                            scrobble_track=scrobble_track,
                            log_lastfm_scrobble_event=lambda *_args, **_kwargs: None,
                        )
                        stored = body.get("entry") if isinstance(body.get("entry"), dict) else {}
                        succeeded = bool(body.get("scrobbled"))
                        sent = succeeded or str(stored.get("scrobble_submission_state") or "") in {
                            "sent", "uncertain", "accepted",
                        }
                        return LastfmSubmissionOutcome(
                            sent=sent,
                            accepted=1 if succeeded else 0,
                            message=str(body.get("scrobble_error") or ""),
                            attempted=body.get("scrobble_attempted") is True,
                            reauthentication_required=bool(
                                stored.get("scrobble_reauthentication_required")
                            ),
                        )

                    result = process_pending_scrobble_attempt(
                        config,
                        entry,
                        update_listen_history_entry=lambda config, entry_id, updates, owner=pending: update_listen_history_entry(
                            config,
                            entry_id,
                            updates,
                            account_id=owner.account_id,
                            library_id=owner.library_id,
                            row_id=owner.row_id,
                        ),
                        scrobble_track=submit_measured_scrobble,
                        log_lastfm_scrobble_event=(
                            (lambda *_args, **_kwargs: None)
                            if bypass_backoff
                            else lambda action, *, level, payload, error="", retry_count=0: log_app_event(
                                config,
                                logging.getLogger("music_app"),
                                action,
                                level=level,
                                history=True,
                                history_scope=scope,
                                error=error,
                                retry_count=retry_count,
                            )
                        ),
                        reauthenticated=reauthenticated,
                        bypass_backoff=bypass_backoff,
                    )
                    if result["attempted"]:
                        summary["attempted"] += 1
                    if result["succeeded"]:
                        summary["succeeded"] += 1
                    elif result["failed"]:
                        summary["failed"] += 1
                    continue
                scope = HistoryScope(library_id=pending.library_id, account_id=pending.account_id, origin_kind='retry')
                result = process_pending_scrobble_attempt(
                    config,
                    entry,
                    update_listen_history_entry=lambda config, entry_id, updates, owner=pending: update_listen_history_entry(
                        config, entry_id, updates, account_id=owner.account_id, library_id=owner.library_id, row_id=owner.row_id),
                    scrobble_track=lambda cfg, payload, owner=pending: scrobble_track(
                        cfg, payload, session=eligible_sessions[owner.account_id]),
                    log_lastfm_scrobble_event=(
                        (lambda *_args, **_kwargs: None)
                        if bypass_backoff
                        else lambda action, *, level, payload, error="", retry_count=0, history_scope=scope: log_app_event(
                            config,
                            logging.getLogger("music_app"),
                            action,
                            level=level,
                            history=True,
                            history_scope=history_scope,
                            artist=payload.get("artist", ""),
                            album=payload.get("album", ""),
                            title=payload.get("track", ""),
                            error=error,
                            retry_count=retry_count,
                        )
                    ),
                    reauthenticated=reauthenticated,
                    bypass_backoff=bypass_backoff,
                )
                if result["attempted"]:
                    summary["attempted"] += 1
                if result["succeeded"]:
                    summary["succeeded"] += 1
                elif result["failed"]:
                    summary["failed"] += 1
        except Exception as exc:
            summary["failed"] += 1
            try:
                summary["pending_after"] = pending_scrobble_count(
                    config, account_id=account_id, library_id=library_id,
                ) if account_id is not None or library_id is not None else pending_scrobble_count(config)
            except Exception:
                pass
            raise LastfmRetryBatchError(summary) from exc

        summary["pending_after"] = pending_scrobble_count(
            config, account_id=account_id, library_id=library_id,
        ) if account_id is not None or library_id is not None else pending_scrobble_count(config)
        if account_id is None and any(item.entry.get("measurement_version") != "rendered-pcm-v1" for item in pending_entries):
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
