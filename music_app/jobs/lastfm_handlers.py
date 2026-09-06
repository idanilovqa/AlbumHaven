"""Typed Last.fm provider handling for one-attempt durable retry jobs."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Mapping

from music_app.services.jobs.models import ClaimedJob, JobState, JobTransitionResult
from music_app.services.lastfm import LastfmError, LastfmSubmissionOutcome
from music_app.services.lastfm_listen_sync import build_scrobble_result_updates
from music_app.services.lastfm_sync_bridge import build_pending_scrobble_payload


class LastfmProviderDisposition(str, Enum):
    ACCEPTED = "accepted"
    KNOWN_NOT_SENT_RETRYABLE = "known_not_sent_retryable"
    REAUTHENTICATION_REQUIRED = "reauthentication_required"
    PERMANENT_REJECTION = "permanent_rejection"
    POSSIBLE_SEND_AMBIGUOUS = "possible_send_ambiguous"
    CANCELED_BEFORE_SEND = "canceled_before_send"


@dataclass(frozen=True)
class LastfmProviderResult:
    disposition: LastfmProviderDisposition
    reason_code: str


def retry_delay_seconds(previous_attempts: int) -> int:
    if isinstance(previous_attempts, bool) or not isinstance(previous_attempts, int):
        raise ValueError("previous_attempts must be a nonnegative integer")
    if previous_attempts < 0:
        raise ValueError("previous_attempts must be a nonnegative integer")
    return min(30 * 60, 60 * (2 ** max(0, previous_attempts - 1)))


def classify_lastfm_provider_outcome(outcome: LastfmSubmissionOutcome) -> LastfmProviderResult:
    if outcome.sent and outcome.accepted > 0:
        return LastfmProviderResult(LastfmProviderDisposition.ACCEPTED, "accepted")
    if not outcome.sent:
        return LastfmProviderResult(
            LastfmProviderDisposition.KNOWN_NOT_SENT_RETRYABLE,
            "provider_did_not_send",
        )
    return LastfmProviderResult(
        LastfmProviderDisposition.PERMANENT_REJECTION,
        "provider_rejected_scrobble",
    )


def classify_lastfm_provider_error(error: BaseException) -> LastfmProviderResult:
    if isinstance(error, LastfmError):
        if error.reauthentication_required:
            return LastfmProviderResult(
                LastfmProviderDisposition.REAUTHENTICATION_REQUIRED,
                "lastfm_reauthentication_required",
            )
        if error.error_kind in {"network_error", "malformed_response"}:
            return LastfmProviderResult(
                LastfmProviderDisposition.POSSIBLE_SEND_AMBIGUOUS,
                "provider_outcome_unknown",
            )
        if error.retryable:
            return LastfmProviderResult(
                LastfmProviderDisposition.KNOWN_NOT_SENT_RETRYABLE,
                "provider_rejected_before_send",
            )
        return LastfmProviderResult(
            LastfmProviderDisposition.PERMANENT_REJECTION,
            "provider_rejected_scrobble",
        )
    return LastfmProviderResult(
        LastfmProviderDisposition.POSSIBLE_SEND_AMBIGUOUS,
        "provider_outcome_unknown",
    )


def _claim_values(claim: ClaimedJob, now: datetime) -> dict[str, object]:
    return {
        "pending_scrobble_id": int(claim.subject_ref),
        "active_session_id": int(claim.parameters["active_session_ref"]),
        "job_id": claim.job_id,
        "attempt": claim.attempt,
        "worker_id": claim.worker_id,
        "lease_token": claim.lease_token,
        "now": now,
    }


def _history_updates(
    disposition: LastfmProviderDisposition,
    *,
    attempted_at: datetime,
    retry_count: int,
) -> dict[str, object]:
    timestamp = attempted_at.isoformat()
    if disposition is LastfmProviderDisposition.ACCEPTED:
        return build_scrobble_result_updates(
            scrobbled=True,
            scrobble_error="",
            attempted_at=timestamp,
            retry_count=retry_count,
        )
    status = {
        LastfmProviderDisposition.KNOWN_NOT_SENT_RETRYABLE: "pending_retry",
        LastfmProviderDisposition.REAUTHENTICATION_REQUIRED: "reauthentication_required",
        LastfmProviderDisposition.PERMANENT_REJECTION: "permanent_failure",
        LastfmProviderDisposition.POSSIBLE_SEND_AMBIGUOUS: "ambiguous",
    }[disposition]
    updates = build_scrobble_result_updates(
        scrobbled=False,
        scrobble_error="Last.fm scrobble was not accepted.",
        attempted_at=timestamp,
        retry_count=retry_count,
    )
    updates.update(
        {
            "scrobble_retryable": disposition
            is LastfmProviderDisposition.KNOWN_NOT_SENT_RETRYABLE,
            "scrobble_reauthentication_required": disposition
            is LastfmProviderDisposition.REAUTHENTICATION_REQUIRED,
            "sync_problem": {
                "provider": "lastfm",
                "kind": "scrobble",
                "status": status,
                "message": "Last.fm scrobble was not accepted.",
            },
        }
    )
    return updates


def build_lastfm_retry_handler(
    *,
    retry_repository: Any,
    config: Mapping[str, object],
    scrobble_with_session: Callable[[dict[str, Any], dict[str, Any], str], LastfmSubmissionOutcome],
    clock: Callable[[], datetime] | None = None,
) -> Callable[[ClaimedJob, Any], JobTransitionResult]:
    now = clock or (lambda: datetime.now(timezone.utc))
    provider_config = dict(config)

    def cancel(claim: ClaimedJob, reason: str, observed_at: datetime) -> JobTransitionResult:
        retry_repository.cancel_claimed_before_send(
            **_claim_values(claim, observed_at), reason_code=reason
        )
        return JobTransitionResult(JobState.CANCELED, reason)

    def handle(claim: ClaimedJob, context: Any) -> JobTransitionResult:
        observed_at = now()
        if context.cancel_requested:
            return cancel(claim, "lastfm_retry_canceled_before_send", observed_at)
        if not context.lease_active:
            return cancel(claim, "lastfm_retry_lease_lost_before_send", observed_at)
        decision = context.reauthorize()
        if not decision.allowed:
            return cancel(claim, decision.reason_code, observed_at)

        values = _claim_values(claim, observed_at)
        secret = retry_repository.load_claimed_session_secret(**values)
        if not secret:
            return cancel(claim, "lastfm_session_unavailable", observed_at)
        if context.cancel_requested:
            return cancel(claim, "lastfm_retry_canceled_before_send", observed_at)
        if not context.lease_active:
            return cancel(claim, "lastfm_retry_lease_lost_before_send", observed_at)
        scope = retry_repository.begin_claimed_attempt(**values)
        provider_payload = dict(scope.payload)
        if not str(provider_payload.get("track") or "").strip() and str(
            provider_payload.get("title") or ""
        ).strip():
            provider_payload = build_pending_scrobble_payload(provider_payload)
        try:
            provider_result = classify_lastfm_provider_outcome(
                scrobble_with_session(provider_config, provider_payload, secret)
            )
        except Exception as error:
            provider_result = classify_lastfm_provider_error(error)

        finalization = retry_repository.finalize_claimed_attempt(
            **values,
            expected_row_revision=scope.row_revision,
            disposition=provider_result.disposition.value,
            reason_code=provider_result.reason_code,
            history_updates=_history_updates(
                provider_result.disposition,
                attempted_at=observed_at,
                retry_count=scope.accepted_attempt,
            ),
        )
        if provider_result.disposition is LastfmProviderDisposition.ACCEPTED:
            return JobTransitionResult(JobState.SUCCEEDED, "lastfm_scrobble_accepted")
        if provider_result.disposition is LastfmProviderDisposition.POSSIBLE_SEND_AMBIGUOUS:
            return JobTransitionResult(JobState.AMBIGUOUS, "lastfm_scrobble_ambiguous")
        if getattr(finalization, "next_job_id", None) is not None:
            return JobTransitionResult(JobState.SUCCEEDED, "lastfm_retry_scheduled")
        reason = {
            LastfmProviderDisposition.REAUTHENTICATION_REQUIRED: "lastfm_reauthentication_required",
            LastfmProviderDisposition.PERMANENT_REJECTION: "lastfm_scrobble_rejected",
            LastfmProviderDisposition.KNOWN_NOT_SENT_RETRYABLE: "lastfm_retry_exhausted",
        }[provider_result.disposition]
        return JobTransitionResult(JobState.SUCCEEDED, reason)

    return handle


__all__ = [
    "LastfmProviderDisposition",
    "LastfmProviderResult",
    "build_lastfm_retry_handler",
    "classify_lastfm_provider_error",
    "classify_lastfm_provider_outcome",
    "retry_delay_seconds",
]
