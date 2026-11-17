from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import unicodedata

from music_app.services.lastfm import LastfmError
from music_app.services.listen_history import is_unverified_scrobble_entry
from music_app.services.measured_listen_history import (
    MeasuredListenError,
    load_measured,
    measured_provider_guard,
    normalize_measurement,
    playback_handoff_completion_digest,
    validate_playback_completion,
)
from music_app.services.lastfm_listen_sync import (
    build_lastfm_sync_problem,
    build_playback_complete_entry,
    build_scrobble_result_updates,
    clear_pending_scrobble,
    load_lastfm_sync_state,
    playback_scrobble_threshold_seconds,
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

_BASE_RETRY_DELAY_SECONDS = 30
_MAX_RETRY_DELAY_SECONDS = 15 * 60


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


def prepare_measured_playback_completion(
    payload: JsonDict,
    *,
    user_timezone: str,
    account_id: int,
    library_id: int,
    is_meaningful_listen_session: ListenHistoryMeaningChecker,
) -> JsonDict | None:
    validate_playback_completion(payload)
    entry = build_playback_complete_entry({**payload, "user_timezone": user_timezone})
    for key in ("measurement_version", "device_id", "session_id", "sequence",
                "measured_listened_seconds", "max_measured_contiguous_seconds"):
        entry[key] = payload.get(key)
    entry["finalized"] = payload.get("finalized", True)
    entry = normalize_measurement(entry, account_id=account_id, library_id=library_id)
    threshold = playback_scrobble_threshold_seconds(entry.get("duration_seconds"))
    entry["scrobble_eligible"] = (
        threshold > 0 and entry["measured_listened_seconds"] >= threshold
    )
    return entry if is_meaningful_listen_session(entry) else None


def prepare_handoff_completion(
    payload: JsonDict | None,
    *,
    user_timezone: str,
    account_id: int,
    library_id: int,
    is_meaningful_listen_session: ListenHistoryMeaningChecker,
) -> tuple[JsonDict | None, bytes]:
    """The measured entry a reload handoff persists (None without a completion) and its fingerprint.

    A handoff ends its listen, so a completion must be finalized."""
    if payload is None:
        return None, playback_handoff_completion_digest(None)
    entry = prepare_measured_playback_completion(
        payload,
        user_timezone=user_timezone,
        account_id=account_id,
        library_id=library_id,
        is_meaningful_listen_session=is_meaningful_listen_session,
    )
    if payload.get("finalized") is not True:
        raise MeasuredListenError("Listen handoff completion must be finalized")
    if entry is None:
        raise MeasuredListenError("Listen completion is below the persistence threshold")
    return entry, playback_handoff_completion_digest(entry)


_CREDENTIAL_UNAVAILABLE = "Account-scoped Last.fm credential is unavailable"


def _seed_measured_playback_completion(entry: JsonDict) -> JsonDict:
    seeded = dict(entry)
    eligible = bool(entry["scrobble_eligible"])
    seeded.update({
        "scrobbled": False,
        "scrobble_error": _CREDENTIAL_UNAVAILABLE if eligible else "",
        "scrobble_retryable": eligible,
        "sync_problem": {
            "provider": "lastfm",
            "kind": "scrobble",
            "status": "account_credential_unavailable",
            "message": _CREDENTIAL_UNAVAILABLE,
        } if eligible else None,
    })
    return seeded


def persist_measured_playback_completion(
    config: ConfigDict,
    entry: JsonDict,
    *,
    account_id: int,
    library_id: int,
    connection,
    append_listen_history_entry: ListenHistoryAppender,
) -> JsonDict:
    """Appends a prepared handoff entry, not yet scrobbled, inside the caller's transaction."""
    return append_listen_history_entry(
        config,
        _seed_measured_playback_completion(entry),
        account_id=account_id,
        library_id=library_id,
        connection=connection,
    )


def record_playback_session_complete(
    config: ConfigDict,
    payload: JsonDict,
    *,
    user_timezone: str,
    account_id: int | None = None,
    library_id: int | None = None,
    lastfm_session=None,
    normalize_playback_track_payload: PlaybackTrackNormalizer,
    is_meaningful_listen_session: ListenHistoryMeaningChecker,
    append_listen_history_entry: ListenHistoryAppender,
    update_listen_history_entry: ListenHistoryUpdater,
    scrobble_track: LastfmScrobbler,
    log_lastfm_scrobble_event: LastfmScrobbleLogger,
    persisted_entry: JsonDict | None = None,
) -> tuple[JsonDict, int]:
    """``persisted_entry`` is the prepared measured entry a caller already committed; its stored
    row is reloaded under the provider guard instead of being appended again."""
    if payload.get("measurement_version") is not None:
        entry = persisted_entry if persisted_entry is not None else prepare_measured_playback_completion(
            payload,
            user_timezone=user_timezone,
            account_id=account_id,
            library_id=library_id,
            is_meaningful_listen_session=is_meaningful_listen_session,
        )
        if entry is None:
            return {"ok": True, "entry": None, "scrobbled": False, "scrobble_error": "", "ignored": True}, 200
        with measured_provider_guard(config, account_id=account_id, library_id=library_id,
                                     device_id=entry["device_id"], session_id=entry["session_id"]) as provider_connection:
            provider_attempted = False
            error = _CREDENTIAL_UNAVAILABLE if entry["scrobble_eligible"] else ""
            if persisted_entry is not None:
                stored = load_measured(
                    provider_connection,
                    account_id=account_id,
                    library_id=library_id,
                    device_id=entry["device_id"],
                    session_id=entry["session_id"],
                )
            else:
                stored = append_listen_history_entry(
                    config,
                    _seed_measured_playback_completion(entry),
                    account_id=account_id,
                    library_id=library_id,
                )
            scrobbled = bool(stored.get("scrobbled"))
            if scrobbled:
                error = ""
            elif stored.get("scrobble_submission_state") in ("attempting", "sent", "uncertain"):
                error = str(stored.get("scrobble_error") or "Previous Last.fm submission outcome is uncertain")
            elif entry["scrobble_eligible"] and lastfm_session is not None:
                retryable = False
                reauthentication_required = False
                submission_state = "uncertain"
                stored = update_listen_history_entry(
                    config, stored["id"], attempting_updates(datetime.now(timezone.utc)),
                    account_id=account_id, library_id=library_id,
                ) or stored
                try:
                    normalized_payload = normalize_playback_track_payload(payload)
                    provider_attempted = True
                    submission = scrobble_track(config, normalized_payload, session=lastfm_session)
                    scrobbled = submission is None or bool(getattr(submission, "succeeded", False))
                    error = "" if scrobbled else str(getattr(submission, "message", "Last.fm did not accept this listen"))
                    sent = submission is None or bool(getattr(submission, "sent", False))
                    submission_state = "accepted" if scrobbled else "sent" if sent else "not_sent"
                    retryable = not sent
                except LastfmError as exc:
                    error = str(exc)
                    reauthentication_required = exc.reauthentication_required
                    retryable, submission_state = failed_batch_disposition(exc)
                stored = update_listen_history_entry(config, stored["id"], scrobble_attempt_updates(
                    stored, attempted_at=datetime.now(timezone.utc), error=error, retryable=retryable,
                    reauthentication_required=reauthentication_required, submission_state=submission_state,
                ), account_id=account_id, library_id=library_id) or stored
                log_lastfm_scrobble_event(
                    "Last.fm scrobble succeeded" if scrobbled else "Last.fm scrobble failed",
                    level="info" if scrobbled else "warning", payload=payload, error=error,
                )
            if entry["scrobble_eligible"] and not scrobbled:
                wake_lastfm_retry()
            public = {key: value for key, value in stored.items() if key not in ("path", "track_ref")}
            return {
                "ok": True,
                "entry": public,
                "scrobbled": scrobbled,
                "scrobble_error": error,
                "scrobble_attempted": provider_attempted,
            }, 200
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
                "sync_problem": _scrobble_sync_problem(
                    scrobble_error, retryable=scrobble_retryable,
                    reauthentication_required=reauthentication_required,
                ),
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
    if entry["scrobble_eligible"] and not scrobbled:
        wake_lastfm_retry()

    return ({
        "ok": True,
        "entry": stored_entry,
        "scrobbled": scrobbled,
        "scrobble_error": scrobble_error,
    }, 200)


def wake_lastfm_retry() -> None:
    """Tells the background retry worker a listen is waiting, so it is sent once Last.fm allows."""
    # Imported here: the retry worker builds on this module.
    from music_app.services.lastfm_retry import wake_lastfm_retry_worker
    wake_lastfm_retry_worker()


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


@dataclass(frozen=True)
class PendingScrobblePlan:
    """What a retry does with one pending listen: send ``payload``, or store ``updates`` unsent."""
    payload: JsonDict | None = None
    updates: JsonDict | None = None


_BLOCKED_SUBMISSION_STATES = frozenset({"attempting", "sent", "uncertain", "accepted"})


def attempting_updates(claimed_at: datetime) -> JsonDict:
    """Claims a listen for one submission. The claim time tells a later verification
    when a submission that never stored its result started."""
    return {
        "scrobble_submission_state": "attempting",
        "scrobble_retryable": False,
        "scrobble_error": "Last.fm submission outcome is uncertain",
        "last_scrobble_attempt_at": claimed_at.isoformat(),
    }


def plan_pending_scrobble(
    entry: JsonDict,
    *,
    now: datetime,
    reauthenticated: bool = False,
    bypass_backoff: bool = False,
) -> PendingScrobblePlan | None:
    """The next step for one pending listen; None leaves it untouched for a later retry."""
    if (
        not str(entry.get("id") or "").strip()
        or bool(entry.get("scrobbled"))
        or not bool(entry.get("scrobble_eligible", True))
        or not bool(entry.get("scrobble_retryable", True))
        or bool(entry.get("scrobble_retry_exhausted"))
        or str(entry.get("scrobble_submission_state") or "") in _BLOCKED_SUBMISSION_STATES
    ):
        return None
    if bool(entry.get("scrobble_reauthentication_required")) and not reauthenticated:
        return None
    if not (reauthenticated or bypass_backoff) and now < scrobble_due_at(entry, now=now):
        return None
    payload = build_pending_scrobble_payload(entry)
    validation_error = validate_pending_scrobble_payload(payload)
    if validation_error:
        return PendingScrobblePlan(updates=scrobble_attempt_updates(
            entry, attempted_at=now, error=validation_error, retryable=False, submission_state="not_sent",
        ))
    return PendingScrobblePlan(payload=payload)


def scrobble_due_at(entry: JsonDict, *, now: datetime) -> datetime:
    """When a pending listen may be sent again: ``now`` until it has failed once, then
    after its backoff from the last attempt."""
    attempts = int(entry.get("scrobble_retry_count") or 0)
    last_attempt_at = _stored_time(entry.get("last_scrobble_attempt_at"))
    if not attempts or last_attempt_at is None:
        return now
    return last_attempt_at + timedelta(seconds=scrobble_retry_delay_seconds(attempts))


def _stored_time(value: object) -> datetime | None:
    text = str(value or "").strip()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00")) if text else None
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed is not None and parsed.tzinfo is None else parsed


def scrobble_retry_delay_seconds(attempts: int) -> float:
    """How long a listen waits after its ``attempts``-th failed submission: 30 s, doubling
    to a 15-minute cap, so a long Last.fm or network outage is retried until it ends."""
    return min(_MAX_RETRY_DELAY_SECONDS, _BASE_RETRY_DELAY_SECONDS * (2 ** max(0, attempts - 1)))


# Last.fm can list a scrobble some time after it accepted it, most of all while it is failing,
# which is when submission outcomes are lost. Five minutes is far past the 12 s request timeout,
# so the lost submission can no longer be on its way, and keeps the answer within one 15-minute
# retry cap.
SCROBBLE_VERIFICATION_DELAY_SECONDS = 5 * 60
NOT_ON_LASTFM = "Last.fm has no record of this listen, so it will be sent again."


def scrobble_verification_due(
    entry: JsonDict, *, now: datetime, reauthenticated: bool = False, bypass_backoff: bool = False,
) -> bool:
    """Whether a listen whose submission outcome is unknown may be looked up on Last.fm now."""
    if not is_unverified_scrobble_entry(entry):
        return False
    if bool(entry.get("scrobble_reauthentication_required")) and not reauthenticated:
        return False
    return now >= scrobble_verification_due_at(entry, now=now, bypass_backoff=reauthenticated or bypass_backoff)


def scrobble_verification_due_at(entry: JsonDict, *, now: datetime, bypass_backoff: bool = False) -> datetime:
    """Five minutes after the listen's last submission started (without one, after it was
    recorded); after a failed lookup, also its backoff, as for a failed submission."""
    started = _stored_time(entry.get("last_scrobble_attempt_at")) or _stored_time(entry.get("recorded_at"))
    due = now if started is None else started + timedelta(seconds=SCROBBLE_VERIFICATION_DELAY_SECONDS)
    failures = int(entry.get("scrobble_verification_failures") or 0)
    last_lookup = _stored_time(entry.get("last_scrobble_verification_at"))
    if failures and last_lookup is not None and not bypass_backoff:
        due = max(due, last_lookup + timedelta(seconds=scrobble_retry_delay_seconds(failures)))
    return due


def scrobble_identity(timestamp: object, artist: object, track: object) -> tuple[int, str, str]:
    """What makes a Last.fm scrobble the same listen: its Unix second, and its artist and track
    names compared without case, Unicode compatibility forms, or extra spaces ("ДДТ" is "ддт")."""
    return int(timestamp or 0), _comparable_name(artist), _comparable_name(track)


def _comparable_name(value: object) -> str:
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).casefold().split())


def listen_scrobble_identity(entry: JsonDict) -> tuple[int, str, str]:
    """The identity of the scrobble a submission of this listen sends."""
    payload = build_pending_scrobble_payload(entry)
    return scrobble_identity(payload["timestamp"], payload["artist"], payload["track"])


def verified_scrobble_updates(entry: JsonDict, *, listed: bool, verified_at: datetime) -> JsonDict:
    """Ends a listen's unknown outcome. Listed on Last.fm, it is accepted as if Last.fm had
    answered its submission; otherwise it returns to the send queue, due after the backoff of
    its last submission."""
    settled = {
        "scrobble_verification_failures": 0,
        "last_scrobble_verification_at": "",
        "scrobble_reauthentication_required": False,
        "scrobble_retryable": not listed,
    }
    if listed:
        return {
            **build_scrobble_result_updates(
                scrobbled=True, scrobble_error="",
                attempted_at=str(entry.get("last_scrobble_attempt_at") or verified_at.isoformat()),
                retry_count=int(entry.get("scrobble_retry_count") or 0),
            ),
            **settled,
            "scrobble_submission_state": "accepted",
        }
    return {
        **settled,
        "scrobble_submission_state": "not_sent",
        "scrobble_error": NOT_ON_LASTFM,
        "sync_problem": _scrobble_sync_problem(NOT_ON_LASTFM, retryable=True, reauthentication_required=False),
    }


def failed_verification_updates(
    entry: JsonDict, *, looked_up_at: datetime, reauthentication_required: bool,
) -> JsonDict:
    """A lookup that failed leaves the outcome unknown; the next waits for its backoff, or for
    the account to reconnect."""
    return {
        "scrobble_verification_failures": int(entry.get("scrobble_verification_failures") or 0) + 1,
        "last_scrobble_verification_at": looked_up_at.isoformat(),
        "scrobble_reauthentication_required": bool(reauthentication_required),
    }


def scrobble_attempt_updates(
    entry: JsonDict,
    *,
    attempted_at: datetime,
    error: str = "",
    retryable: bool = False,
    reauthentication_required: bool = False,
    submission_state: str,
) -> JsonDict:
    """The stored result of one submission attempt; Last.fm counted the listen only when
    ``submission_state`` is ``"accepted"``."""
    retry_count = int(entry.get("scrobble_retry_count") or 0) + 1
    accepted = submission_state == "accepted"
    updates = build_scrobble_result_updates(
        scrobbled=accepted, scrobble_error=error, attempted_at=attempted_at.isoformat(), retry_count=retry_count,
    )
    should_retry = bool(retryable and not accepted)
    updates.update({
        "scrobble_submission_state": submission_state,
        "scrobble_retryable": should_retry,
        "scrobble_reauthentication_required": bool(reauthentication_required),
    })
    if not accepted:
        updates["sync_problem"] = _scrobble_sync_problem(
            error, retryable=should_retry, reauthentication_required=reauthentication_required,
        )
    return updates


def _scrobble_sync_problem(error: str, *, retryable: bool, reauthentication_required: bool) -> JsonDict:
    return build_lastfm_sync_problem(message=error, status=(
        "reauthentication_required" if reauthentication_required
        else "pending_retry" if retryable
        else "permanent_failure"
    ))


# Last.fm error codes that refuse the request itself (invalid service, method, format,
# parameters or resource), so it recorded none of its scrobbles and the same request fails again.
_REJECTED_REQUEST_ERROR_CODES = frozenset({2, 3, 5, 6, 7})
# Statuses that mean Last.fm did not process the request.
_UNPROCESSED_HTTP_STATUSES = frozenset({408, 425, 429, 503})
# Statuses after which Last.fm may have recorded the scrobbles, whatever error code the body carries:
# a 502 comes from a gateway that may have passed the request on before it failed.
_UNCERTAIN_HTTP_STATUSES = frozenset({500, 502, 504})


def failed_batch_disposition(error: LastfmError) -> tuple[bool, str]:
    """Whether listens whose Last.fm call failed may be sent again, and their submission state.

    A listen is retried when Last.fm answered with an error code or a status that
    means it did not process the request (rate limited, unavailable), the request
    never fully left the server (network down, Last.fm unreachable), or the account
    must reconnect. Any other failure (a timeout, a 500, 502 or 504 even when its body
    carries a Last.fm error code, or an unreadable answer after the POST) may have
    been recorded, so its outcome stays uncertain until the account's scrobbles on
    Last.fm show whether it arrived; it is never sent again blindly. A request Last.fm
    refused outright is final."""
    if error.http_status in _UNCERTAIN_HTTP_STATUSES and not error.reauthentication_required:
        return False, "uncertain"
    retryable = bool(
        error.reauthentication_required
        or not error.request_sent
        or (error.retryable and error.error_kind == "configuration_error")
        or (error.retryable and error.error_kind == "provider_error" and error.code is not None)
        or (error.retryable and error.http_status in _UNPROCESSED_HTTP_STATUSES)
    )
    if retryable:
        return True, "not_sent"
    if error.error_kind == "provider_error" and error.code in _REJECTED_REQUEST_ERROR_CODES:
        # Like an ignored scrobble, a refused request is final; verifying it would resend it forever.
        return False, "sent"
    return False, "uncertain"
