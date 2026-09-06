"""Closed durable handlers for cover-domain jobs."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from typing import Any

from music_app.services.cover_provider_deadline import (
    cover_lookup_provider_deadline_at,
)
from music_app.services.jobs.authorization import AuthorizationDecision
from music_app.services.jobs.models import ClaimedJob, JobKind, JobState, JobTransitionResult


def _candidate_lookup_task_id(claim: ClaimedJob) -> int | None:
    task_key = str(claim.subject_ref or "").strip()
    task_id = claim.parameters.get("task_id")
    if (
        claim.kind not in {JobKind.COVER_LOOKUP, "cover_lookup"}
        or claim.subject_kind != "cover_lookup_task"
        or not task_key
        or len(task_key) > 128
        or isinstance(task_id, bool)
        or not isinstance(task_id, int)
        or task_id < 1
        or claim.library_id is None
        or claim.account_id is None
        or claim.capability_key != "library.covers.lookup"
        or claim.max_attempts != 2
        or claim.idempotency_key
        != f"cover-lookup:{claim.library_id}:{task_key}"
    ):
        return None
    return task_id


def _claim_parameters(claim: ClaimedJob, now: datetime) -> dict[str, object]:
    return {
        "task_key": str(claim.subject_ref),
        "task_id": int(claim.parameters["task_id"]),
        "library_id": int(claim.library_id or 0),
        "job_id": claim.job_id,
        "attempt": claim.attempt,
        "worker_id": claim.worker_id,
        "lease_token": claim.lease_token,
        "now": now,
    }


def build_cover_lookup_resource_validator(
    *, cover_repository: Any
) -> Callable[[ClaimedJob, Any, datetime], AuthorizationDecision]:
    """Revalidate a candidate lookup's task, album, root, and claim fence."""

    def validate(
        claim: ClaimedJob, _authorization_context: Any, now: datetime
    ) -> AuthorizationDecision:
        if _candidate_lookup_task_id(claim) is None:
            return AuthorizationDecision(False, "cover_lookup_scope_invalid")
        try:
            valid = cover_repository.validate_claimed_candidate_lookup(
                **_claim_parameters(claim, now)
            )
        except Exception:
            return AuthorizationDecision(False, "cover_lookup_scope_invalid")
        if valid is not True:
            return AuthorizationDecision(False, "cover_lookup_scope_stale")
        return AuthorizationDecision(True, "cover_lookup_scope_current")

    return validate


def build_cover_lookup_handler(
    *,
    cover_repository: Any,
    config: Mapping[str, object],
    logger: Any,
    run_lookup: Callable[..., object],
    build_deadline: Callable[[Mapping[str, object]], float] = cover_lookup_provider_deadline_at,
    clock: Callable[[], datetime] | None = None,
) -> Callable[[ClaimedJob, Any], JobTransitionResult]:
    """Execute one accepted lookup with durable cancellation and publication fences."""

    now = clock or (lambda: datetime.now(timezone.utc))

    def handle(claim: ClaimedJob, context: Any) -> JobTransitionResult:
        if _candidate_lookup_task_id(claim) is None:
            return JobTransitionResult(JobState.CANCELED, "cover_lookup_scope_invalid")
        try:
            scope = cover_repository.load_claimed_candidate_lookup(
                **_claim_parameters(claim, now())
            )
        except Exception:
            return JobTransitionResult(JobState.FAILED, "cover_lookup_scope_unavailable")
        if scope is None:
            return JobTransitionResult(JobState.CANCELED, "cover_lookup_scope_stale")

        expected_revision = int(scope.row_revision)
        task_payload = dict(scope.task_payload or {})
        publication_lost = False

        def durable_cancel_requested() -> bool:
            nonlocal expected_revision, publication_lost
            if publication_lost or not context.lease_active:
                return True
            if not context.reauthorize().allowed:
                return True
            try:
                cancellation_state = (
                    cover_repository.candidate_lookup_cancellation_state(
                        **_claim_parameters(claim, now())
                    )
                )
                if cancellation_state is None:
                    publication_lost = True
                    return True
                canceled, current_revision = cancellation_state
                expected_revision = int(current_revision)
                return bool(canceled or context.cancel_requested)
            except Exception:
                publication_lost = True
                return True

        def finalize_canceled() -> bool:
            nonlocal expected_revision, task_payload
            if publication_lost or not context.lease_active:
                return False
            try:
                updated = cover_repository.finalize_claimed_candidate_lookup_canceled(
                    **_claim_parameters(claim, now()),
                    expected_row_revision=expected_revision,
                )
            except Exception:
                updated = None
            if updated is None:
                return False
            expected_revision = int(updated.row_revision)
            task_payload = dict(updated.task_payload or task_payload)
            return True

        def publish(**changes: object) -> bool:
            nonlocal expected_revision, publication_lost, task_payload
            if durable_cancel_requested():
                return False
            next_payload = {**task_payload, **changes}
            try:
                updated = cover_repository.publish_claimed_candidate_lookup(
                    **_claim_parameters(claim, now()),
                    expected_row_revision=expected_revision,
                    task_payload=next_payload,
                )
            except Exception:
                updated = None
            if updated is None:
                publication_lost = True
                return False
            expected_revision = int(updated.row_revision)
            task_payload = dict(updated.task_payload or next_payload)
            return True

        if durable_cancel_requested():
            finalize_canceled()
            return JobTransitionResult(JobState.CANCELED, "cover_lookup_canceled")

        provider_deadline_at = build_deadline(config)
        try:
            run_lookup(
                task_id=str(scope.task_key),
                config=config,
                logger=logger,
                user_agent=str(config.get("MUSICBRAINZ_USER_AGENT") or ""),
                album=dict(scope.album),
                track_paths=set(scope.track_paths),
                manual_urls=list(scope.manual_urls),
                provider_deadline_at=provider_deadline_at,
                should_cancel=durable_cancel_requested,
                publish=publish,
            )
        except Exception:
            if publication_lost or not context.lease_active:
                return JobTransitionResult(JobState.CANCELED, "cover_lookup_lease_lost")
            return JobTransitionResult(JobState.FAILED, "cover_lookup_failed")

        if publication_lost or not context.lease_active:
            return JobTransitionResult(JobState.CANCELED, "cover_lookup_lease_lost")
        if durable_cancel_requested() or str(task_payload.get("status")) == "canceled":
            finalize_canceled()
            return JobTransitionResult(JobState.CANCELED, "cover_lookup_canceled")
        if str(task_payload.get("status")) == "failed":
            return JobTransitionResult(JobState.FAILED, "cover_lookup_failed")
        return JobTransitionResult(JobState.SUCCEEDED, "cover_lookup_completed")

    return handle


__all__ = ["build_cover_lookup_handler", "build_cover_lookup_resource_validator"]
