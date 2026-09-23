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


def _full_scan_intent_id(claim: ClaimedJob) -> int | None:
    if (
        claim.kind not in {JobKind.FULL_SCAN, "full_scan"}
        or claim.subject_kind != "full_scan_intent"
        or not str(claim.subject_ref).isdigit()
    ):
        return None
    intent_id = int(claim.subject_ref)
    if intent_id < 1 or claim.parameters.get("intent_id") != intent_id:
        return None
    return intent_id


def _post_scan_inventory_revision(claim: ClaimedJob) -> int | None:
    prefix = "revision-"
    subject_ref = str(claim.subject_ref or "")
    if (
        claim.kind
        not in {JobKind.POST_SCAN_COVER_REFRESH, "post_scan_cover_refresh"}
        or claim.subject_kind != "inventory_revision"
        or not subject_ref.startswith(prefix)
        or not subject_ref[len(prefix) :].isdigit()
    ):
        return None
    revision = int(subject_ref[len(prefix) :])
    if (
        revision < 0
        or claim.library_id is None
        or claim.parameters != {"inventory_revision": revision}
        or claim.resource_revision != revision
        or claim.idempotency_key
        != f"post-scan-cover-refresh:{claim.library_id}:{revision}"
        or claim.max_attempts != 2
        or claim.account_id is not None
        or claim.capability_key is not None
        or claim.request_origin_id is not None
    ):
        return None
    return revision


def build_post_scan_cover_refresh_resource_validator(
    *, scan_repository: Any
) -> Callable[[ClaimedJob, Any, datetime], AuthorizationDecision]:
    """Validate a revision-keyed server-owned cover handoff."""

    def validate(
        claim: ClaimedJob, _authorization_context: Any, now: datetime
    ) -> AuthorizationDecision:
        revision = _post_scan_inventory_revision(claim)
        if revision is None:
            return AuthorizationDecision(False, "post_scan_cover_scope_invalid")
        try:
            current = scan_repository.validate_claimed_post_scan_cover_refresh(
                library_id=claim.library_id,
                inventory_revision=revision,
                job_id=claim.job_id,
                attempt=claim.attempt,
                worker_id=claim.worker_id,
                lease_token=claim.lease_token,
                now=now,
            )
        except Exception:
            return AuthorizationDecision(False, "post_scan_cover_scope_invalid")
        if current is not True:
            return AuthorizationDecision(False, "post_scan_cover_scope_stale")
        return AuthorizationDecision(True, "post_scan_cover_scope_current")

    return validate


def build_post_scan_cover_refresh_handler(
    *, run_cover_refresh: Callable[..., object]
) -> Callable[[ClaimedJob, Any], JobTransitionResult]:
    """Bridge a committed scan revision into the existing cover domain."""

    def handle(claim: ClaimedJob, context: Any) -> JobTransitionResult:
        revision = _post_scan_inventory_revision(claim)
        if revision is None:
            return JobTransitionResult(
                JobState.CANCELED, "post_scan_cover_scope_invalid"
            )
        authorization_denied = False

        def stop_reason() -> str | None:
            nonlocal authorization_denied
            if authorization_denied:
                return "post_scan_cover_scope_stale"
            if context.cancel_requested:
                return "post_scan_cover_refresh_canceled"
            if not context.lease_active:
                return "post_scan_cover_refresh_lease_lost"
            if not context.reauthorize().allowed:
                authorization_denied = True
                return "post_scan_cover_scope_stale"
            return None

        reason = stop_reason()
        if reason is not None:
            return JobTransitionResult(JobState.CANCELED, reason)

        def should_cancel() -> bool:
            return stop_reason() is not None

        try:
            completed = run_cover_refresh(
                library_id=claim.library_id,
                inventory_revision=revision,
                should_cancel=should_cancel,
            )
        except Exception:
            return JobTransitionResult(
                JobState.FAILED, "post_scan_cover_refresh_failed"
            )
        if completed is not True:
            reason = stop_reason()
            if reason is not None:
                return JobTransitionResult(JobState.CANCELED, reason)
            return JobTransitionResult(
                JobState.FAILED, "post_scan_cover_refresh_failed"
            )
        # True means the cover-domain publication committed; later cancellation,
        # lease loss, or revision advance cannot undo that completed side effect.
        return JobTransitionResult(
            JobState.SUCCEEDED, "post_scan_cover_refresh_completed"
        )

    return handle


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


def build_full_scan_resource_validator(
    *, scan_repository: Any
) -> Callable[[ClaimedJob, Any, datetime], AuthorizationDecision]:
    """Revalidate the private roots captured by a claimed full scan."""

    def validate(
        claim: ClaimedJob, _authorization_context: Any, now: datetime
    ) -> AuthorizationDecision:
        intent_id = _full_scan_intent_id(claim)
        if intent_id is None or claim.library_id is None:
            return AuthorizationDecision(False, "full_scan_scope_invalid")
        try:
            intent = scan_repository.load_claimed_full_scan(
                job_id=claim.job_id,
                worker_id=claim.worker_id,
                lease_token=claim.lease_token,
            )
            scope = scan_repository.load_claimed_full_scan_scope(
                intent_id=intent_id,
                library_id=claim.library_id,
                job_id=claim.job_id,
                attempt=claim.attempt,
                worker_id=claim.worker_id,
                lease_token=claim.lease_token,
                now=now,
            )
        except Exception:
            return AuthorizationDecision(False, "full_scan_scope_invalid")
        required_root_ids = set(getattr(intent, "root_ids", ()) or ())
        if getattr(scope, "scope_complete", None) is not True:
            return AuthorizationDecision(False, "full_scan_root_invalid")
        roots = getattr(scope, "roots", ())
        observed_root_ids = {str(root.get("id") or "") for root in roots}
        if (
            getattr(intent, "intent_id", None) != intent_id
            or getattr(intent, "library_id", None) != claim.library_id
            or getattr(scope, "inventory_mutation_revision", None)
            != getattr(intent, "inventory_mutation_revision", None)
            or not _current_roots_valid(
                roots,
                required_root_ids=required_root_ids,
                library_id=claim.library_id,
            )
            or observed_root_ids != required_root_ids
        ):
            return AuthorizationDecision(False, "full_scan_root_invalid")
        return AuthorizationDecision(True, "full_scan_scope_current")

    return validate


def build_full_scan_handler(
    *,
    scan_repository: Any,
    scan_executor: Any,
    watcher_coordinator: Any | None = None,
    clock: Callable[[], datetime] | None = None,
    log_event: Callable[[str], object] | None = None,
) -> Callable[[ClaimedJob, Any], JobTransitionResult]:
    """Execute a full scan while keeping authority, lease, and roots live."""

    now = clock or (lambda: datetime.now(timezone.utc))
    log = log_event or (lambda _message: None)

    def handle(claim: ClaimedJob, context: Any) -> JobTransitionResult:
        intent_id = _full_scan_intent_id(claim)
        if intent_id is None or claim.library_id is None:
            return JobTransitionResult(JobState.CANCELED, "full_scan_scope_invalid")

        def stop_reason() -> str | None:
            if context.cancel_requested:
                return "full_scan_canceled"
            if not context.lease_active:
                return "full_scan_lease_lost"
            decision = context.reauthorize()
            if not decision.allowed:
                return "full_scan_authority_revoked"
            if context.cancel_requested:
                return "full_scan_canceled"
            if not context.lease_active:
                return "full_scan_lease_lost"
            return None

        reason = stop_reason()
        if reason is not None:
            return JobTransitionResult(JobState.CANCELED, reason)
        try:
            intent = scan_repository.load_claimed_full_scan(
                job_id=claim.job_id,
                worker_id=claim.worker_id,
                lease_token=claim.lease_token,
            )
        except Exception:
            return JobTransitionResult(JobState.CANCELED, "full_scan_scope_invalid")
        if getattr(intent, "committed_inventory_revision", None) is not None:
            return JobTransitionResult(JobState.SUCCEEDED, "full_scan_completed")
        try:
            scope = scan_repository.load_claimed_full_scan_scope(
                intent_id=intent_id,
                library_id=claim.library_id,
                job_id=claim.job_id,
                attempt=claim.attempt,
                worker_id=claim.worker_id,
                lease_token=claim.lease_token,
                now=now(),
            )
        except Exception:
            return JobTransitionResult(JobState.CANCELED, "full_scan_scope_invalid")
        roots = getattr(scope, "roots", ())
        required_root_ids = set(getattr(intent, "root_ids", ()) or ())
        if (
            getattr(intent, "intent_id", None) != intent_id
            or getattr(intent, "library_id", None) != claim.library_id
            or getattr(scope, "scope_complete", None) is not True
            or getattr(scope, "inventory_mutation_revision", None)
            != getattr(intent, "inventory_mutation_revision", None)
            or not _current_roots_valid(
                roots,
                required_root_ids=required_root_ids,
                library_id=claim.library_id,
            )
            or {str(root.get("id") or "") for root in roots} != required_root_ids
        ):
            return JobTransitionResult(JobState.CANCELED, "full_scan_root_invalid")

        checkpoint_failed = False

        def checkpoint(
            *, current: int, total: int, current_path: str = "",
            phase: str = "indexing", elapsed_seconds: float = 0.0,
            estimated_remaining_seconds: float = 0.0,
            files_per_second: float = 0.0,
            album_folders_processed: int = 0, album_folders_total: int = 0,
        ) -> None:
            nonlocal checkpoint_failed
            reason = stop_reason()
            if reason is not None:
                checkpoint_failed = True
                return
            accepted = scan_repository.checkpoint_claimed_full_scan(
                intent_id=intent_id,
                job_id=claim.job_id,
                attempt=claim.attempt,
                worker_id=claim.worker_id,
                lease_token=claim.lease_token,
                current=current,
                total=total,
                current_path=current_path,
                phase=phase,
                elapsed_seconds=elapsed_seconds,
                estimated_remaining_seconds=estimated_remaining_seconds,
                files_per_second=files_per_second,
                album_folders_processed=album_folders_processed,
                album_folders_total=album_folders_total,
                now=now(),
            )
            if accepted is not True:
                checkpoint_failed = True

        def should_cancel() -> bool:
            return checkpoint_failed or stop_reason() is not None

        if watcher_coordinator is not None:
            watcher_coordinator.suspend_targeted_reconciliation()
        try:
            bind_claim = getattr(scan_executor, "bind_claim", None)
            if callable(bind_claim):
                bind_claim(claim)
            bind_scope = getattr(scan_executor, "bind_scope", None)
            if callable(bind_scope):
                bind_scope(scope)
            result = scan_executor.run(
                intent,
                roots=roots,
                checkpoint=checkpoint,
                should_cancel=should_cancel,
                expected_revision=intent.inventory_mutation_revision,
            )
        except Exception as exc:
            if "revision conflict" in str(exc).lower():
                return JobTransitionResult(JobState.FAILED, "full_scan_revision_conflict")
            diagnostic_code = "unclassified"
            normalized_error = str(exc).casefold()
            for marker, code in (
                ("full scan publication input is invalid", "publication_input_invalid"),
                ("full scan publication file scope is invalid", "publication_file_scope_invalid"),
                ("full scan publication hierarchy is invalid", "publication_hierarchy_invalid"),
            ):
                if marker in normalized_error:
                    diagnostic_code = code
                    break
            log(f"Full scan execution failed ({diagnostic_code}).")
            return JobTransitionResult(JobState.FAILED, "full_scan_failed")
        finally:
            if watcher_coordinator is not None:
                watcher_coordinator.resume_targeted_reconciliation()

        if getattr(result, "inventory_mutation_revision", None) is not None or getattr(
            result, "publication_won", False
        ):
            return JobTransitionResult(JobState.SUCCEEDED, "full_scan_completed")
        reason = stop_reason()
        if checkpoint_failed and reason is None:
            reason = "full_scan_lease_lost"
        if reason is not None:
            return JobTransitionResult(JobState.CANCELED, reason)
        if getattr(result, "canceled", False):
            return JobTransitionResult(JobState.CANCELED, "full_scan_canceled")
        return JobTransitionResult(JobState.SUCCEEDED, "full_scan_completed")

    return handle


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
            preparation_scope = (
                scan_repository.load_claimed_targeted_reconciliation_preparation(
                    intent_id=intent_id,
                    library_id=claim.library_id,
                    job_id=claim.job_id,
                    attempt=claim.attempt,
                    worker_id=claim.worker_id,
                    lease_token=claim.lease_token,
                    now=now(),
                )
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
                preparation_scope=preparation_scope,
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
    "build_full_scan_handler",
    "build_full_scan_resource_validator",
    "build_post_scan_cover_refresh_handler",
    "build_post_scan_cover_refresh_resource_validator",
    "build_targeted_reconciliation_handler",
    "build_targeted_reconciliation_resource_validator",
]
