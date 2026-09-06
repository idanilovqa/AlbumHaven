"""Closed durable handlers for scan-domain work."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from music_app.services.jobs.authorization import AuthorizationDecision
from music_app.services.jobs.models import ClaimedJob, JobKind, JobState, JobTransitionResult


def _claim_intent_id(claim: ClaimedJob) -> int | None:
    if (
        claim.kind not in {JobKind.TARGETED_RECONCILIATION, "targeted_reconciliation"}
        or claim.subject_kind != "targeted_reconciliation_intent"
        or not str(claim.subject_ref).isdigit()
    ):
        return None
    intent_id = int(claim.subject_ref)
    parameters_intent_id = claim.parameters.get("intent_id")
    if intent_id < 1 or parameters_intent_id != intent_id:
        return None
    return intent_id


def _current_roots_valid(
    roots: object,
    *,
    required_root_ids: set[str],
    library_id: int,
) -> bool:
    if not isinstance(roots, tuple) or not roots:
        return False
    seen: set[str] = set()
    for root in roots:
        if not isinstance(root, dict):
            return False
        root_id = str(root.get("id") or "").strip()
        if (
            not root_id
            or root_id in seen
            or root.get("library_id") != library_id
            or root.get("is_active") is not True
            or not str(root.get("path") or "").strip()
        ):
            return False
        seen.add(root_id)
    return required_root_ids.issubset(seen)


def build_targeted_reconciliation_resource_validator(
    *, scan_repository: Any
) -> Callable[[ClaimedJob, Any, datetime], AuthorizationDecision]:
    """Build the server-owned validator from the claim-scoped scan repository."""

    def validate(
        claim: ClaimedJob, _authorization_context: Any, now: datetime
    ) -> AuthorizationDecision:
        intent_id = _claim_intent_id(claim)
        if intent_id is None or claim.library_id is None:
            return AuthorizationDecision(False, "targeted_scope_invalid")
        try:
            scope = scan_repository.load_claimed_targeted_reconciliation_scope(
                intent_id=intent_id,
                library_id=claim.library_id,
                job_id=claim.job_id,
                attempt=claim.attempt,
                worker_id=claim.worker_id,
                lease_token=claim.lease_token,
                now=now,
            )
        except Exception:
            return AuthorizationDecision(False, "targeted_scope_invalid")
        if not getattr(scope, "roots", ()):
            return AuthorizationDecision(False, "targeted_root_invalid")
        if getattr(scope, "scope_complete", None) is not True:
            return AuthorizationDecision(False, "targeted_root_invalid")
        if getattr(scope, "root_healthy", None) is not True:
            return AuthorizationDecision(False, "targeted_root_unhealthy")
        return AuthorizationDecision(True, "targeted_scope_current")

    return validate


def build_targeted_reconciliation_handler(
    *,
    scan_repository: Any,
    reconciler: Any,
    invalidate_projections: Callable[[Any], object] | None = None,
    clock: Callable[[], datetime] | None = None,
) -> Callable[[ClaimedJob, Any], JobTransitionResult]:
    """Rehydrate and execute one watcher request under its live lease fence."""

    now = clock or (lambda: datetime.now(timezone.utc))
    invalidate = invalidate_projections or (lambda _result: None)

    def handle(claim: ClaimedJob, context: Any) -> JobTransitionResult:
        intent_id = _claim_intent_id(claim)
        if intent_id is None or claim.library_id is None:
            return JobTransitionResult(JobState.CANCELED, "targeted_scope_invalid")
        try:
            intent = scan_repository.load_claimed_targeted_reconciliation(
                job_id=claim.job_id,
                worker_id=claim.worker_id,
                lease_token=claim.lease_token,
            )
            scope = scan_repository.load_claimed_targeted_reconciliation_scope(
                intent_id=intent_id,
                library_id=claim.library_id,
                job_id=claim.job_id,
                attempt=claim.attempt,
                worker_id=claim.worker_id,
                lease_token=claim.lease_token,
                now=now(),
            )
        except Exception:
            return JobTransitionResult(JobState.CANCELED, "targeted_scope_invalid")
        request = getattr(intent, "request", intent)
        if (
            hasattr(intent, "intent_id")
            and (
                intent.intent_id != intent_id
                or getattr(intent, "library_id", None) != claim.library_id
            )
        ):
            return JobTransitionResult(JobState.CANCELED, "targeted_scope_invalid")
        if getattr(scope, "root_healthy", None) is not True:
            return JobTransitionResult(JobState.CANCELED, "targeted_root_unhealthy")
        if getattr(scope, "scope_complete", None) is not True:
            return JobTransitionResult(JobState.CANCELED, "targeted_root_invalid")

        required_root_ids = {request.root_id}
        for move in request.moves:
            required_root_ids.add(move.source_root_id)
            required_root_ids.add(move.destination_root_id)
        roots = getattr(scope, "roots", ())
        if not _current_roots_valid(
            roots,
            required_root_ids=required_root_ids,
            library_id=claim.library_id,
        ):
            return JobTransitionResult(JobState.CANCELED, "targeted_root_invalid")

        class PublicationGuard:
            def _authorized(self) -> bool:
                if context.cancel_requested or not context.lease_active:
                    return False
                decision = context.reauthorize()
                return bool(
                    decision.allowed
                    and not context.cancel_requested
                    and context.lease_active
                )

            def __call__(
                self, connection: Any, commit: Callable[[], object]
            ) -> object:
                if not self._authorized():
                    return None
                return scan_repository.fence_targeted_reconciliation_publication(
                    connection=connection,
                    claim=claim,
                    intent_id=intent_id,
                    commit=commit,
                    now=now(),
                )

            def publish_prepared(
                self,
                *,
                inventory: dict[str, object],
                stale_scopes: list[dict[str, object]],
            ) -> object:
                if not self._authorized():
                    return None
                return scan_repository.publish_claimed_targeted_reconciliation(
                    claim=claim,
                    intent_id=intent_id,
                    inventory=inventory,
                    stale_scopes=stale_scopes,
                    now=now(),
                )

        publication_guard = PublicationGuard()

        try:
            result = reconciler.reconcile(
                request,
                root_healthy=True,
                publication_guard=publication_guard,
                root_definitions=roots,
                exception_overrides=dict(
                    getattr(intent, "exception_overrides", {}) or {}
                ),
            )
        except Exception:
            return JobTransitionResult(JobState.FAILED, "targeted_reconciliation_failed")
        if context.cancel_requested or not context.lease_active:
            return JobTransitionResult(JobState.CANCELED, "targeted_reconciliation_canceled")
        if getattr(result, "health", "") == "already_published":
            return JobTransitionResult(JobState.SUCCEEDED, "targeted_reconciliation_completed")
        if getattr(result, "health", "healthy") != "healthy":
            return JobTransitionResult(JobState.CANCELED, "targeted_root_invalid")
        invalidate(result)
        return JobTransitionResult(JobState.SUCCEEDED, "targeted_reconciliation_completed")

    return handle


__all__ = [
    "build_targeted_reconciliation_handler",
    "build_targeted_reconciliation_resource_validator",
]
