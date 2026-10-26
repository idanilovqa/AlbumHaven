from __future__ import annotations

from datetime import datetime, timezone

from music_app.services.lastfm_postgres import LastfmPostgresAdapter
from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.playback_session_payloads import normalize_playback_request_origin

_LONG_TRACK_SCROBBLE_SECONDS = 300.0
_LONG_TRACK_SCROBBLE_DURATION_SECONDS = 600.0


def _float_payload_value(payload: dict[str, object], key: str) -> float:
    try:
        return round(float(payload.get(key) or 0), 3)
    except (TypeError, ValueError):
        return 0.0


def playback_scrobble_threshold_seconds(duration_seconds: object) -> float:
    try:
        duration = max(0.0, float(duration_seconds or 0))
    except (TypeError, ValueError):
        return 0.0
    if duration <= 0:
        return 0.0
    if duration < _LONG_TRACK_SCROBBLE_DURATION_SECONDS:
        return duration * 0.5
    return _LONG_TRACK_SCROBBLE_SECONDS


def is_playback_complete_scrobble_eligible(payload: dict[str, object]) -> bool:
    threshold = playback_scrobble_threshold_seconds(payload.get("duration_seconds"))
    if threshold <= 0:
        return bool(payload.get("scrobble_eligible"))
    listened = max(
        _float_payload_value(payload, "total_listened_seconds"),
        _float_payload_value(payload, "max_contiguous_seconds"),
    )
    return listened >= threshold or bool(payload.get("scrobble_eligible"))


def _empty_sync_state() -> dict[str, object]:
    return {
        "pending_scrobbles": {},
        "sync_problems": {},
        "last_retry_summary": {},
    }


def load_lastfm_sync_state(config: dict[str, object]) -> dict[str, object]:
    return _lastfm_sync_state_adapter(config).load_sync_state()


def save_lastfm_sync_state(config: dict[str, object], sync_state: dict[str, object]) -> dict[str, object]:
    return _lastfm_sync_state_adapter(config).save_sync_state(sync_state)


def _lastfm_sync_state_adapter(config: dict[str, object]) -> LastfmPostgresAdapter:
    selection = select_runtime_persistence_adapter("lastfm_sync_state", config)
    if selection.effective_backend != "postgres":
        raise ValueError(
            "File runtime persistence is not supported for lastfm_sync_state; "
            "Album Haven runtime persistence is Postgres-only."
        )
    return LastfmPostgresAdapter(config)


def build_playback_complete_entry(payload: dict[str, object]) -> dict[str, object]:
    segments = payload.get("segments")
    normalized_segments = segments if isinstance(segments, list) else []
    track_ref = str(payload.get("path") or "").strip()
    return {
        "path": track_ref,
        "track_ref": track_ref,
        "title": str(payload.get("title") or "").strip(),
        "artist": str(payload.get("artist") or "").strip(),
        "album": str(payload.get("album") or "").strip(),
        "album_artist": str(payload.get("album_artist") or "").strip(),
        "track_number": str(payload.get("track_number") or payload.get("trackNumber") or "").strip(),
        "started_at": str(payload.get("started_at") or "").strip(),
        "ended_at": str(payload.get("ended_at") or "").strip(),
        "started_at_unix": int(payload.get("started_at_unix") or 0) or 0,
        "duration_seconds": _float_payload_value(payload, "duration_seconds"),
        "total_listened_seconds": _float_payload_value(payload, "total_listened_seconds"),
        "max_contiguous_seconds": _float_payload_value(payload, "max_contiguous_seconds"),
        "finished_fully": bool(payload.get("finished_fully")),
        "skipped": bool(payload.get("skipped")),
        "completion_reason": str(payload.get("completion_reason") or "").strip(),
        "scrobble_eligible": is_playback_complete_scrobble_eligible(payload),
        "scrobbled": bool(payload.get("scrobbled")),
        "user_timezone": str(payload.get("user_timezone") or "").strip(),
        "request_origin": normalize_playback_request_origin(payload),
        "segments": [segment for segment in normalized_segments if isinstance(segment, dict)],
        "canonical_match": {
            "library_track_id": str(payload.get("library_track_id") or "").strip(),
            "canonical_track_id": str(payload.get("canonical_track_id") or "").strip(),
            "canonical_release_id": str(payload.get("canonical_release_id") or "").strip(),
        },
        "source_provenance": {
            "kind": "local_playback",
            "provider": "album_haven",
        },
        "sync_problem": None,
    }


def build_lastfm_sync_problem(
    *,
    message: str,
    status: str = "pending_retry",
    kind: str = "scrobble",
) -> dict[str, str]:
    return {
        "provider": "lastfm",
        "kind": kind,
        "status": status,
        "message": str(message or "").strip(),
    }


def build_scrobble_result_updates(
    *,
    scrobbled: bool,
    scrobble_error: str,
    attempted_at: str,
    retry_count: int,
) -> dict[str, object]:
    normalized_error = str(scrobble_error or "").strip()
    return {
        "scrobbled": bool(scrobbled),
        "scrobble_error": normalized_error,
        "last_scrobble_attempt_at": str(attempted_at or "").strip(),
        "scrobble_retry_count": max(0, int(retry_count or 0)),
        "scrobbled_at": str(attempted_at or "").strip() if scrobbled else "",
        "sync_problem": None if scrobbled else build_lastfm_sync_problem(message=normalized_error),
    }


def record_pending_scrobble(
    config: dict[str, object],
    *,
    listen_id: str,
    entry: dict[str, object],
    retry_count: int,
    error: str,
) -> None:
    normalized_listen_id = str(listen_id or "").strip()
    if not normalized_listen_id:
        return
    sync_state = load_lastfm_sync_state(config)
    pending_scrobbles = dict(sync_state.get("pending_scrobbles") or {})
    sync_problems = dict(sync_state.get("sync_problems") or {})
    pending_scrobbles[normalized_listen_id] = {
        "retry_count": max(0, int(retry_count or 0)),
        "last_error": str(error or "").strip(),
        "track_ref": str(entry.get("track_ref") or entry.get("path") or "").strip(),
    }
    sync_problems[normalized_listen_id] = build_lastfm_sync_problem(message=error)
    sync_state["pending_scrobbles"] = pending_scrobbles
    sync_state["sync_problems"] = sync_problems
    save_lastfm_sync_state(config, sync_state)


def clear_pending_scrobble(config: dict[str, object], *, listen_id: str) -> None:
    normalized_listen_id = str(listen_id or "").strip()
    if not normalized_listen_id:
        return
    sync_state = load_lastfm_sync_state(config)
    pending_scrobbles = dict(sync_state.get("pending_scrobbles") or {})
    sync_problems = dict(sync_state.get("sync_problems") or {})
    pending_scrobbles.pop(normalized_listen_id, None)
    sync_problems.pop(normalized_listen_id, None)
    sync_state["pending_scrobbles"] = pending_scrobbles
    sync_state["sync_problems"] = sync_problems
    save_lastfm_sync_state(config, sync_state)


def record_retry_summary(config: dict[str, object], summary: dict[str, int]) -> None:
    sync_state = load_lastfm_sync_state(config)
    sync_state["last_retry_summary"] = {
        "pending_before": int(summary.get("pending_before") or 0),
        "attempted": int(summary.get("attempted") or 0),
        "succeeded": int(summary.get("succeeded") or 0),
        "failed": int(summary.get("failed") or 0),
        "pending_after": int(summary.get("pending_after") or 0),
        "recorded_at": datetime.now(timezone.utc).isoformat(),
    }
    save_lastfm_sync_state(config, sync_state)


def build_recent_scrobble_delivery(
    entry: dict[str, object],
    *,
    source_family: str,
    measurement_version: str | None,
    connection_state: str,
) -> dict[str, object]:
    """Project stored delivery facts, never authorize or perform a submission.

    The caller must authorize the occurrence and supply provenance from its
    trusted ledger row, not from source_payload. Keep the original occurrence
    envelope: this closed DTO deliberately contains no ID, path or provider text.
    Disconnected suppresses delivery chrome, not the underlying app listen.

    ``retry_check`` is only a hint to the existing scoped retry owner. That owner
    must refresh the receipt under its provider guard and check session/API,
    payload, original timestamp, retry budget, reauthentication and backoff.
    Missing legacy submission facts cannot prove that a play was never sent.
    """
    if not isinstance(entry, dict):
        raise ValueError("Stored listen facts must be a dictionary")
    if type(connection_state) is not str or connection_state not in (
        "connected", "disconnected", "unavailable", "unknown",
    ):
        raise ValueError("Explicit Last.fm connection state is required")

    native = (
        source_family == "rendered_local_listen_session"
        and measurement_version == "rendered-pcm-v1"
    )
    legacy = (
        source_family in ("runtime_listen_history_adapter", "phase_6_json_file_backfill")
        and measurement_version is None
    )
    provenance = entry.get("source_provenance")
    if "source_provenance" in entry and (
        not isinstance(provenance, dict)
        or provenance.get("kind") != "local_playback"
        or provenance.get("provider") != "album_haven"
    ):
        native = legacy = False
    if not (native or legacy):
        return {"state": "not_eligible", "next_step": "none", "show_status": False}

    submission = entry.get("scrobble_submission_state")
    # Positive acceptance and possible delivery dominate contradictory retry,
    # eligibility or problem flags. The bridge's 'sent' is not proof of success.
    if entry.get("scrobbled") is True or submission == "accepted":
        state = "accepted"
    elif submission in ("attempting", "sent", "uncertain"):
        state = "delivery_unconfirmed"
    elif entry.get("scrobble_eligible") is False:
        state = "not_eligible"
    elif (
        entry.get("scrobble_eligible") is not True
        or entry.get("scrobbled") is not False
        or submission != "not_sent"
    ):
        state = "unknown"
    elif entry.get("scrobble_reauthentication_required") is True:
        state = "reauthentication_required"
    elif entry.get("scrobble_retry_exhausted") is True or (
        type(entry.get("scrobble_retry_count")) is int
        and entry["scrobble_retry_count"] >= 5
    ):
        # Existing process_pending_scrobble_attempt caps attempts at five.
        state = "retry_exhausted"
    elif entry.get("scrobble_retryable") is False:
        state = "rejected"
    else:
        state = "not_sent"

    next_step = "none"
    if connection_state == "connected":
        if state == "delivery_unconfirmed":
            next_step = "check_delivery"
        elif state == "reauthentication_required":
            next_step = "reauthenticate"
        elif state in ("rejected", "retry_exhausted"):
            next_step = "review_failure"
        elif state == "not_sent":
            count = entry.get("scrobble_retry_count", 0)
            if (
                entry.get("scrobble_retryable") is True
                and entry.get("scrobble_retry_exhausted", False) is False
                and entry.get("scrobble_reauthentication_required", False) is False
                and type(count) is int and 0 <= count < 5
            ):
                next_step = "retry_check"
    elif connection_state in ("unavailable", "unknown") and state in (
        "delivery_unconfirmed", "reauthentication_required", "rejected",
        "retry_exhausted", "not_sent",
    ):
        next_step = "check_connection"
    return {
        "state": state,
        "next_step": next_step,
        "show_status": connection_state != "disconnected",
    }
