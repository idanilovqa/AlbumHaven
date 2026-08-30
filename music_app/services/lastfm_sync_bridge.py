from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from music_app.services.lastfm import LastfmError
from music_app.services.lastfm_listen_sync import (
    build_playback_complete_entry,
    build_scrobble_result_updates,
    clear_pending_scrobble,
    load_lastfm_sync_state,
    record_pending_scrobble,
)

JsonDict = dict[str, object]
ConfigDict = dict[str, object]
PlaybackTrackNormalizer = Callable[[JsonDict], JsonDict]
ListenHistoryMeaningChecker = Callable[[object], bool]
ListenHistoryAppender = Callable[[ConfigDict, JsonDict], JsonDict]
ListenHistoryUpdater = Callable[[ConfigDict, str, JsonDict], JsonDict | None]
LastfmScrobbler = Callable[[ConfigDict, JsonDict], object]
LastfmScrobbleLogger = Callable[..., None]

_MAX_SCROBBLE_ATTEMPTS = 5
_BASE_RETRY_DELAY_SECONDS = 60
_MAX_RETRY_DELAY_SECONDS = 30 * 60


def build_lastfm_integration_status(
    config: ConfigDict,
    *,
    base_status: JsonDict,
    listen_history_count: int,
    pending_scrobble_count: int,
) -> JsonDict:
    sync_state = load_lastfm_sync_state(config)
    sync_problems = sync_state.get("sync_problems")
    last_retry_summary = sync_state.get("last_retry_summary")

    payload = dict(base_status)
    payload["listen_history_count"] = int(listen_history_count)
    payload["pending_scrobble_count"] = int(pending_scrobble_count)
    payload["sync_state_mode"] = "local_postgres_orchestration"
    payload["sync_problem_count"] = len(sync_problems) if isinstance(sync_problems, dict) else 0
    payload["last_retry_summary"] = dict(last_retry_summary) if isinstance(last_retry_summary, dict) else {}
    return payload


def record_playback_session_complete(
    config: ConfigDict,
    payload: JsonDict,
    *,
    user_timezone: str,
    normalize_playback_track_payload: PlaybackTrackNormalizer,
    is_meaningful_listen_session: ListenHistoryMeaningChecker,
    append_listen_history_entry: ListenHistoryAppender,
    update_listen_history_entry: ListenHistoryUpdater,
    scrobble_track: LastfmScrobbler,
    log_lastfm_scrobble_event: LastfmScrobbleLogger,
) -> tuple[JsonDict, int]:
    entry = build_playback_complete_entry({
        **payload,
        "user_timezone": user_timezone,
    })
    if not is_meaningful_listen_session(entry):
        return ({
            "ok": True,
            "entry": None,
            "scrobbled": False,
            "scrobble_error": "",
            "ignored": True,
        }, 200)

    stored_entry = append_listen_history_entry(config, entry)
    scrobbled = bool(payload.get("scrobbled"))
    scrobble_error = ""
    scrobble_retryable = False
    reauthentication_required = False
    submission: object | None = None

    if entry["scrobble_eligible"] and not scrobbled:
        try:
            submission = scrobble_track(config, normalize_playback_track_payload(payload))
            scrobbled = submission is None or bool(getattr(submission, "succeeded", False))
            if not scrobbled:
                scrobble_error = str(getattr(submission, "message", "") or "Last.fm scrobble was not accepted.")
                scrobble_retryable = not bool(getattr(submission, "sent", False))
        except LastfmError as exc:
            scrobble_error = str(exc)
            scrobble_retryable = bool(exc.retryable or exc.reauthentication_required)
            reauthentication_required = exc.reauthentication_required
            log_lastfm_scrobble_event(
                "Last.fm scrobble queued",
                level="warning",
                payload=payload,
                error=scrobble_error,
                retry_count=1,
            )

    if entry["scrobble_eligible"] and scrobbled:
        log_lastfm_scrobble_event(
            "Last.fm scrobble succeeded",
            level="info",
            payload=payload,
            retry_count=1,
        )

    submission_sent = bool(submission is None or getattr(submission, "sent", False))
    attempted_at = datetime.now(timezone.utc).isoformat() if entry["scrobble_eligible"] and submission_sent else ""
    retry_count = 1 if entry["scrobble_eligible"] and submission_sent else 0
    scrobble_updates = build_scrobble_result_updates(
        scrobbled=scrobbled,
        scrobble_error=scrobble_error,
        attempted_at=attempted_at,
        retry_count=retry_count,
    )
    if entry["scrobble_eligible"] and not scrobbled:
        scrobble_updates.update(
            {
                "scrobble_retryable": scrobble_retryable,
                "scrobble_reauthentication_required": reauthentication_required,
                "sync_problem": {
                    "provider": "lastfm",
                    "kind": "scrobble",
                    "status": (
                        "reauthentication_required"
                        if reauthentication_required
                        else "pending_retry"
                        if scrobble_retryable
                        else "permanent_failure"
                    ),
                    "message": scrobble_error,
                },
            }
        )
    stored_entry = update_listen_history_entry(
        config,
        str(stored_entry.get("id") or ""),
        scrobble_updates,
    ) or stored_entry
    listen_id = str(stored_entry.get("id") or "")

    if entry["scrobble_eligible"] and scrobbled:
        clear_pending_scrobble(config, listen_id=listen_id)
    elif entry["scrobble_eligible"] and scrobble_error and scrobble_retryable:
        record_pending_scrobble(
            config,
            listen_id=listen_id,
            entry=stored_entry,
            retry_count=retry_count,
            error=scrobble_error,
        )
    elif entry["scrobble_eligible"] and scrobble_error:
        clear_pending_scrobble(config, listen_id=listen_id)

    return ({
        "ok": True,
        "entry": stored_entry,
        "scrobbled": scrobbled,
        "scrobble_error": scrobble_error,
    }, 200)


def build_pending_scrobble_payload(entry: JsonDict) -> JsonDict:
    return {
        "artist": str(entry.get("artist") or "").strip(),
        "track": str(entry.get("title") or entry.get("track") or "").strip(),
        "album": str(entry.get("album") or "").strip(),
        "album_artist": str(entry.get("album_artist") or entry.get("albumArtist") or "").strip(),
        "duration": int(entry.get("duration_seconds") or entry.get("duration") or 0) or 0,
        "track_number": str(entry.get("track_number") or entry.get("trackNumber") or "").strip(),
        "timestamp": int(entry.get("started_at_unix") or entry.get("timestamp") or 0) or 0,
    }


def validate_pending_scrobble_payload(payload: JsonDict) -> str:
    if not str(payload.get("artist") or "").strip():
        return "Missing artist for queued scrobble."
    if not str(payload.get("track") or "").strip():
        return "Missing track title for queued scrobble."
    if int(payload.get("timestamp") or 0) <= 0:
        return "Missing listen timestamp for queued scrobble."
    return ""


def process_pending_scrobble_attempt(
    config: ConfigDict,
    entry: JsonDict,
    *,
    update_listen_history_entry: ListenHistoryUpdater,
    scrobble_track: LastfmScrobbler,
    log_lastfm_scrobble_event: LastfmScrobbleLogger,
    reauthenticated: bool = False,
) -> dict[str, object]:
    entry_id = str(entry.get("id") or "").strip()
    if not entry_id:
        return {"attempted": False, "succeeded": False, "failed": False}

    previous_attempts = int(entry.get("scrobble_retry_count") or 0)
    if previous_attempts >= _MAX_SCROBBLE_ATTEMPTS:
        update_listen_history_entry(
            config,
            entry_id,
            {
                "scrobble_retryable": False,
                "scrobble_retry_exhausted": True,
                "sync_problem": {
                    "provider": "lastfm",
                    "kind": "scrobble",
                    "status": "retry_exhausted",
                    "message": str(entry.get("scrobble_error") or "Last.fm retry limit reached."),
                },
            },
        )
        clear_pending_scrobble(config, listen_id=entry_id)
        return {"attempted": False, "succeeded": False, "failed": True}
    if bool(entry.get("scrobble_reauthentication_required")) and not reauthenticated:
        return {"attempted": False, "succeeded": False, "failed": False}
    last_attempt_text = str(entry.get("last_scrobble_attempt_at") or "").strip()
    if previous_attempts and last_attempt_text and not reauthenticated:
        try:
            last_attempt_at = datetime.fromisoformat(last_attempt_text.replace("Z", "+00:00"))
            if last_attempt_at.tzinfo is None:
                last_attempt_at = last_attempt_at.replace(tzinfo=timezone.utc)
            delay_seconds = min(
                _MAX_RETRY_DELAY_SECONDS,
                _BASE_RETRY_DELAY_SECONDS * (2 ** max(0, previous_attempts - 1)),
            )
            if datetime.now(timezone.utc) < last_attempt_at + timedelta(seconds=delay_seconds):
                return {"attempted": False, "succeeded": False, "failed": False}
        except ValueError:
            pass

    attempted_at = datetime.now(timezone.utc).isoformat()
    retry_count = previous_attempts + 1
    payload = build_pending_scrobble_payload(entry)
    validation_error = validate_pending_scrobble_payload(payload)
    if validation_error:
        _record_failed_pending_scrobble(
            config,
            entry_id=entry_id,
            entry=entry,
            attempted_at=attempted_at,
            retry_count=retry_count,
            payload=payload,
            error=validation_error,
            retryable=False,
            update_listen_history_entry=update_listen_history_entry,
            log_lastfm_scrobble_event=log_lastfm_scrobble_event,
        )
        return {"attempted": True, "succeeded": False, "failed": True}

    try:
        submission = scrobble_track(config, payload)
    except LastfmError as exc:
        _record_failed_pending_scrobble(
            config,
            entry_id=entry_id,
            entry=entry,
            attempted_at=attempted_at,
            retry_count=retry_count,
            payload=payload,
            error=str(exc),
            retryable=bool(exc.retryable or exc.reauthentication_required),
            reauthentication_required=exc.reauthentication_required,
            update_listen_history_entry=update_listen_history_entry,
            log_lastfm_scrobble_event=log_lastfm_scrobble_event,
        )
        return {"attempted": True, "succeeded": False, "failed": True}

    if submission is not None and not bool(getattr(submission, "succeeded", False)):
        _record_failed_pending_scrobble(
            config,
            entry_id=entry_id,
            entry=entry,
            attempted_at=attempted_at,
            retry_count=retry_count,
            payload=payload,
            error=str(getattr(submission, "message", "") or "Last.fm scrobble was not accepted."),
            retryable=not bool(getattr(submission, "sent", False)),
            update_listen_history_entry=update_listen_history_entry,
            log_lastfm_scrobble_event=log_lastfm_scrobble_event,
        )
        return {"attempted": bool(getattr(submission, "sent", False)), "succeeded": False, "failed": True}

    update_listen_history_entry(
        config,
        entry_id,
        build_scrobble_result_updates(
            scrobbled=True,
            scrobble_error="",
            attempted_at=attempted_at,
            retry_count=retry_count,
        ),
    )
    clear_pending_scrobble(config, listen_id=entry_id)
    log_lastfm_scrobble_event(
        "Last.fm scrobble retry succeeded",
        level="info",
        payload=payload,
        retry_count=retry_count,
    )
    return {"attempted": True, "succeeded": True, "failed": False}


def _record_failed_pending_scrobble(
    config: ConfigDict,
    *,
    entry_id: str,
    entry: JsonDict,
    attempted_at: str,
    retry_count: int,
    payload: JsonDict,
    error: str,
    retryable: bool,
    reauthentication_required: bool = False,
    update_listen_history_entry: ListenHistoryUpdater,
    log_lastfm_scrobble_event: LastfmScrobbleLogger,
) -> None:
    exhausted = retry_count >= _MAX_SCROBBLE_ATTEMPTS
    should_retry = bool(retryable and not exhausted)
    updates = build_scrobble_result_updates(
        scrobbled=False,
        scrobble_error=error,
        attempted_at=attempted_at,
        retry_count=retry_count,
    )
    updates.update(
        {
            "scrobble_retryable": should_retry,
            "scrobble_retry_exhausted": exhausted,
            "scrobble_reauthentication_required": bool(reauthentication_required),
            "sync_problem": {
                "provider": "lastfm",
                "kind": "scrobble",
                "status": (
                    "reauthentication_required"
                    if reauthentication_required
                    else "pending_retry"
                    if should_retry
                    else "retry_exhausted"
                    if exhausted
                    else "permanent_failure"
                ),
                "message": error,
            },
        }
    )
    updated_entry = update_listen_history_entry(
        config,
        entry_id,
        updates,
    )
    if should_retry:
        record_pending_scrobble(
            config,
            listen_id=entry_id,
            entry=updated_entry or {**entry, **updates},
            retry_count=retry_count,
            error=error,
        )
    else:
        clear_pending_scrobble(config, listen_id=entry_id)
    log_lastfm_scrobble_event(
        "Last.fm scrobble retry failed",
        level="warning",
        payload=payload,
        error=error,
        retry_count=retry_count,
    )
