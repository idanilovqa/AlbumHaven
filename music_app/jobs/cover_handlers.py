"""Closed durable handlers for cover-domain jobs."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from music_app.services.cover_provider_deadline import (
    cover_lookup_provider_deadline_at,
)
from music_app.services.jobs.authorization import AuthorizationDecision
from music_app.services.jobs.models import ClaimedJob, JobKind, JobState, JobTransitionResult
from music_app.jobs.safe_logging import DurablePipelineLogger


_CANDIDATE_REPOSITORY_FACTORY_KEY = (
    "COVER_CANDIDATE_SNAPSHOT_REPOSITORY_FACTORY"
)
_CANDIDATE_PERSISTENCE_REQUIRED_KEY = (
    "COVER_CANDIDATE_SNAPSHOT_PERSISTENCE_REQUIRED"
)


class _ClaimedCandidateSnapshotRepository:
    """Adapt candidate publication to one already-authorized durable claim."""

    def __init__(
        self,
        *,
        mutate: Callable[..., bool],
        album_id: int,
        search_generation: str,
        search_kind: str,
    ) -> None:
        self._mutate = mutate
        self._album_id = int(album_id)
        self._candidate_generation = UUID(str(search_generation))
        self._search_kind = str(search_kind)

    def resolve_album_id_for_track_paths(self, *, track_paths: object) -> int:
        del track_paths
        return self._album_id

    def _scope(
        self,
        *,
        album_id: int,
        search_generation: str,
        search_kind: str | None = None,
    ) -> None:
        if (
            int(album_id) != self._album_id
            or UUID(str(search_generation)) != self._candidate_generation
            or (
                search_kind is not None
                and str(search_kind).casefold() != self._search_kind.casefold()
            )
        ):
            raise ValueError("candidate snapshot escaped its claimed scope")

    def publish_generation(self, **values: object) -> bool:
        self._scope(
            album_id=int(values["album_id"]),
            search_generation=str(values["search_generation"]),
            search_kind=str(values["search_kind"]),
        )
        return bool(
            self._mutate(
                album_id=self._album_id,
                candidate_generation=self._candidate_generation,
                operation="publish",
                search_kind=self._search_kind,
                search_started_at=str(values.get("search_started_at") or ""),
                candidates=values.get("candidates") or [],
                best_candidate_id=values.get("best_candidate_id"),
                automatic_improvement=bool(values.get("automatic_improvement")),
                candidate_id=None,
            )
        )

    def finish_generation(self, **values: object) -> bool:
        self._scope(
            album_id=int(values["album_id"]),
            search_generation=str(values["search_generation"]),
        )
        status = str(values.get("status") or "").casefold()
        if status not in {"completed", "failed"}:
            raise ValueError("candidate snapshot terminal status is invalid")
        return bool(
            self._mutate(
                album_id=self._album_id,
                candidate_generation=self._candidate_generation,
                operation=f"finish_{status}",
                search_kind=self._search_kind,
                search_started_at="",
                candidates=[],
                best_candidate_id=None,
                automatic_improvement=False,
                candidate_id=None,
            )
        )

    def mark_automatic_improvement(self, **values: object) -> bool:
        self._scope(
            album_id=int(values["album_id"]),
            search_generation=str(values["search_generation"]),
        )
        return bool(
            self._mutate(
                album_id=self._album_id,
                candidate_generation=self._candidate_generation,
                operation="mark_improvement",
                search_kind=self._search_kind,
                search_started_at="",
                candidates=[],
                best_candidate_id=None,
                automatic_improvement=False,
                candidate_id=values.get("candidate_id"),
            )
        )


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
    durable_logger = DurablePipelineLogger(logger, domain="cover")

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
        execution_config = dict(config)

        def candidate_repository_factory(**factory_values: object) -> object:
            album_id = int(factory_values.get("album_id") or 0)
            generation = str(factory_values.get("search_generation") or "")
            search_kind = str(factory_values.get("search_kind") or "")
            if (
                album_id != int(scope.album.get("id") or 0)
                or UUID(generation) != UUID(str(scope.task_key))
                or search_kind.casefold() != "manual"
            ):
                raise ValueError("candidate snapshot escaped its lookup claim")
            return _ClaimedCandidateSnapshotRepository(
                mutate=lambda **mutation: (
                    cover_repository.mutate_claimed_lookup_candidate_snapshot(
                        **_claim_parameters(claim, now()), **mutation
                    )
                ),
                album_id=album_id,
                search_generation=generation,
                search_kind=search_kind,
            )

        execution_config[_CANDIDATE_REPOSITORY_FACTORY_KEY] = (
            candidate_repository_factory
        )
        execution_config[_CANDIDATE_PERSISTENCE_REQUIRED_KEY] = True
        try:
            run_lookup(
                task_id=str(scope.task_key),
                config=execution_config,
                logger=durable_logger,
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


def _cover_refresh_claim_valid(claim: ClaimedJob) -> bool:
    if claim.library_id is None or claim.max_attempts != 2:
        return False
    if claim.kind in {
        JobKind.POST_SCAN_COVER_REFRESH,
        "post_scan_cover_refresh",
    }:
        revision = claim.resource_revision
        return bool(
            isinstance(revision, int)
            and revision >= 0
            and claim.subject_kind == "inventory_revision"
            and claim.subject_ref == f"revision-{revision}"
            and claim.parameters == {"inventory_revision": revision}
            and claim.idempotency_key
            == f"post-scan-cover-refresh:{claim.library_id}:{revision}"
            and claim.account_id is None
            and claim.capability_key is None
        )
    task_key = str(claim.subject_ref or "").strip()
    task_id = claim.parameters.get("task_id")
    mode = claim.parameters.get("mode")
    return bool(
        claim.kind in {JobKind.COVER_BULK_REFRESH, "cover_bulk_refresh"}
        and claim.subject_kind == "cover_bulk_refresh"
        and task_key
        and isinstance(task_id, int)
        and not isinstance(task_id, bool)
        and task_id > 0
        and mode in {"manual", "background"}
        and isinstance(claim.parameters.get("force_search"), bool)
        and claim.capability_key == "library.covers.fetch"
        and claim.account_id is not None
        and isinstance(claim.resource_revision, int)
        and claim.resource_revision >= 0
        and claim.idempotency_key
        == f"cover-bulk-refresh:{claim.library_id}:{task_key}"
    )


def _refresh_claim_parameters(claim: ClaimedJob, now: datetime) -> dict[str, object]:
    return {
        "library_id": int(claim.library_id or 0),
        "job_id": claim.job_id,
        "attempt": claim.attempt,
        "worker_id": claim.worker_id,
        "lease_token": claim.lease_token,
        "now": now,
    }


def build_cover_refresh_handler(
    *,
    cover_repository: Any,
    config: Mapping[str, object],
    logger: Any,
    run_refresh: Callable[..., Mapping[str, object]],
    clock: Callable[[], datetime] | None = None,
) -> Callable[[ClaimedJob, Any], JobTransitionResult]:
    """Run user and post-scan bulk refreshes through one durable core."""

    now = clock or (lambda: datetime.now(timezone.utc))
    durable_logger = DurablePipelineLogger(logger, domain="cover")

    def handle(claim: ClaimedJob, context: Any) -> JobTransitionResult:
        if not _cover_refresh_claim_valid(claim):
            return JobTransitionResult(JobState.CANCELED, "cover_refresh_scope_invalid")
        try:
            scope = cover_repository.begin_claimed_cover_refresh(
                **_refresh_claim_parameters(claim, now()),
                mode=(
                    "post_scan"
                    if claim.kind
                    in {JobKind.POST_SCAN_COVER_REFRESH, "post_scan_cover_refresh"}
                    else None
                ),
                inventory_revision=claim.resource_revision,
                task_key=str(claim.subject_ref),
            )
        except Exception:
            return JobTransitionResult(JobState.FAILED, "cover_refresh_scope_unavailable")
        if scope is None:
            return JobTransitionResult(JobState.CANCELED, "cover_refresh_scope_stale")

        row_revision = int(scope.row_revision)
        fence_lost = False

        def should_cancel() -> bool:
            nonlocal fence_lost
            if fence_lost or context.cancel_requested or not context.lease_active:
                return True
            if not context.reauthorize().allowed:
                return True
            try:
                return bool(
                    cover_repository.cover_refresh_cancel_requested(
                        **_refresh_claim_parameters(claim, now()),
                        task_id=scope.task_id,
                    )
                )
            except Exception:
                fence_lost = True
                return True

        def progress(
            *, current: int, total: int, downloaded: int, safe_label: str
        ) -> bool:
            nonlocal fence_lost, row_revision
            if should_cancel():
                return False
            try:
                next_revision = cover_repository.checkpoint_claimed_cover_refresh(
                    **_refresh_claim_parameters(claim, now()),
                    task_id=scope.task_id,
                    expected_row_revision=row_revision,
                    progress_current=current,
                    progress_total=total,
                    downloaded_count=downloaded,
                    safe_display_label=safe_label,
                )
            except Exception:
                next_revision = None
            if next_revision is None:
                fence_lost = True
                return False
            row_revision = int(next_revision)
            return True

        if should_cancel():
            return JobTransitionResult(JobState.CANCELED, "cover_refresh_canceled")
        execution_config = dict(config)

        def candidate_repository_factory(**factory_values: object) -> object:
            album_id = int(factory_values.get("album_id") or 0)
            generation = str(factory_values.get("search_generation") or "")
            search_kind = str(factory_values.get("search_kind") or "")
            if album_id <= 0 or search_kind.casefold() != "automatic":
                raise ValueError("candidate snapshot escaped its refresh claim")
            return _ClaimedCandidateSnapshotRepository(
                mutate=lambda **mutation: (
                    cover_repository.mutate_claimed_refresh_candidate_snapshot(
                        **_refresh_claim_parameters(claim, now()),
                        task_id=scope.task_id,
                        **mutation,
                    )
                ),
                album_id=album_id,
                search_generation=generation,
                search_kind=search_kind,
            )

        execution_config[_CANDIDATE_REPOSITORY_FACTORY_KEY] = (
            candidate_repository_factory
        )
        execution_config[_CANDIDATE_PERSISTENCE_REQUIRED_KEY] = True

        def persist_claimed_selection(
            track_paths: set[str], selected_cover_path: Any, **options: object
        ) -> dict[str, object]:
            if should_cancel():
                raise RuntimeError("cover refresh claim is no longer active")
            return cover_repository.persist_claimed_automatic_cover_selection(
                **_refresh_claim_parameters(claim, now()),
                task_id=scope.task_id,
                track_paths=track_paths,
                selected_cover_path=selected_cover_path,
                **options,
            )

        execution_config["CLAIMED_COVER_SELECTION_PERSISTER"] = (
            persist_claimed_selection
        )
        try:
            result = run_refresh(
                scope=scope,
                config=execution_config,
                logger=durable_logger,
                should_cancel=should_cancel,
                progress=progress,
            )
        except Exception:
            result = {"failed": 1}

        if fence_lost or not context.lease_active:
            return JobTransitionResult(JobState.CANCELED, "cover_refresh_lease_lost")
        canceled = should_cancel()
        failed = max(0, int(result.get("failed") or 0)) > 0
        next_status = "canceled" if canceled else ("failed" if failed else "completed")
        try:
            finished = cover_repository.finish_claimed_cover_refresh(
                **_refresh_claim_parameters(claim, now()),
                task_id=scope.task_id,
                expected_row_revision=row_revision,
                next_status=next_status,
                processed_count=max(0, int(result.get("processed") or 0)),
                downloaded_count=max(0, int(result.get("downloaded") or 0)),
                failed_count=max(0, int(result.get("failed") or 0)),
            )
        except Exception:
            finished = False
        if not finished:
            return JobTransitionResult(JobState.CANCELED, "cover_refresh_lease_lost")
        if canceled:
            return JobTransitionResult(JobState.CANCELED, "cover_refresh_canceled")
        if failed:
            return JobTransitionResult(JobState.FAILED, "cover_refresh_failed")
        return JobTransitionResult(JobState.SUCCEEDED, "cover_refresh_completed")

    return handle


def build_cover_bulk_refresh_resource_validator(
    *, cover_repository: Any
) -> Callable[[ClaimedJob, Any, datetime], AuthorizationDecision]:
    """Fail closed for malformed bulk claims; the handler loads live domain scope."""

    del cover_repository

    def validate(
        claim: ClaimedJob, _authorization_context: Any, _now: datetime
    ) -> AuthorizationDecision:
        if not _cover_refresh_claim_valid(claim):
            return AuthorizationDecision(False, "cover_refresh_scope_invalid")
        return AuthorizationDecision(True, "cover_refresh_scope_current")

    return validate


def _cover_remote_save_claim_valid(claim: ClaimedJob) -> bool:
    task_key = str(claim.subject_ref or "").strip()
    task_id = claim.parameters.get("task_id")
    generation = str(claim.parameters.get("candidate_generation") or "").strip()
    candidate_id = str(claim.parameters.get("candidate_id") or "").strip()
    return bool(
        claim.kind in {JobKind.COVER_REMOTE_SAVE, "cover_remote_save"}
        and claim.subject_kind == "cover_lookup_task"
        and task_key
        and isinstance(task_id, int)
        and not isinstance(task_id, bool)
        and task_id > 0
        and generation
        and candidate_id
        and claim.library_id is not None
        and claim.account_id is not None
        and claim.capability_key == "library.covers.write"
        and claim.max_attempts == 1
        and claim.idempotency_key
        == f"cover-remote-save:{claim.library_id}:{task_key}:{generation}:{candidate_id}"
    )


def build_cover_remote_save_resource_validator(
    *, cover_repository: Any
) -> Callable[[ClaimedJob, Any, datetime], AuthorizationDecision]:
    del cover_repository

    def validate(
        claim: ClaimedJob, _authorization_context: Any, _now: datetime
    ) -> AuthorizationDecision:
        return AuthorizationDecision(
            _cover_remote_save_claim_valid(claim),
            "cover_remote_save_scope_current"
            if _cover_remote_save_claim_valid(claim)
            else "cover_remote_save_scope_invalid",
        )

    return validate


def build_cover_remote_save_handler(
    *,
    cover_repository: Any,
    config: Mapping[str, object],
    logger: Any,
    run_save: Callable[..., Mapping[str, object]],
    clock: Callable[[], datetime] | None = None,
) -> Callable[[ClaimedJob, Any], JobTransitionResult]:
    """Execute one remote selection through private recovery checkpoints."""

    now = clock or (lambda: datetime.now(timezone.utc))
    durable_logger = DurablePipelineLogger(logger, domain="cover")

    def handle(claim: ClaimedJob, context: Any) -> JobTransitionResult:
        if not _cover_remote_save_claim_valid(claim):
            return JobTransitionResult(JobState.CANCELED, "cover_remote_save_scope_invalid")
        claim_values = _claim_parameters(claim, now())
        try:
            scope = cover_repository.load_claimed_remote_save(**claim_values)
        except Exception:
            return JobTransitionResult(JobState.FAILED, "cover_remote_save_scope_unavailable")
        if scope is None:
            return JobTransitionResult(JobState.CANCELED, "cover_remote_save_scope_stale")
        checkpoint_revision = int(scope.checkpoint_revision)
        fence_lost = False

        def should_cancel() -> bool:
            return bool(
                fence_lost
                or context.cancel_requested
                or not context.lease_active
                or not context.reauthorize().allowed
            )

        def checkpoint(
            next_checkpoint: str,
            *,
            artifact_key: Any = None,
            cover_revision: str | None = None,
            reason_code: str | None = None,
        ) -> int | None:
            nonlocal checkpoint_revision, fence_lost
            if should_cancel():
                return None
            try:
                next_revision = cover_repository.checkpoint_claimed_remote_save(
                    **_refresh_claim_parameters(claim, now()),
                    checkpoint_id=scope.checkpoint_id,
                    expected_row_revision=checkpoint_revision,
                    next_checkpoint=next_checkpoint,
                    artifact_key=artifact_key,
                    cover_revision=cover_revision,
                    reason_code=reason_code,
                )
            except Exception:
                next_revision = None
            if next_revision is None:
                fence_lost = True
                return None
            checkpoint_revision = int(next_revision)
            return checkpoint_revision

        def persist_selection(**options: object) -> int | None:
            nonlocal checkpoint_revision, fence_lost
            options.pop("expected_checkpoint_revision", None)
            if should_cancel():
                return None
            try:
                next_revision = cover_repository.persist_claimed_remote_cover_selection(
                    **_refresh_claim_parameters(claim, now()),
                    checkpoint_id=scope.checkpoint_id,
                    expected_checkpoint_revision=checkpoint_revision,
                    **options,
                )
            except Exception:
                next_revision = None
            if next_revision is None:
                fence_lost = True
                return None
            checkpoint_revision = int(next_revision)
            return checkpoint_revision

        def publish(**options: object) -> bool:
            nonlocal checkpoint_revision, fence_lost
            options.pop("expected_checkpoint_revision", None)
            if should_cancel():
                return False
            try:
                published = cover_repository.publish_claimed_remote_save(
                    **_refresh_claim_parameters(claim, now()),
                    checkpoint_id=scope.checkpoint_id,
                    task_id=int(claim.parameters["task_id"]),
                    expected_checkpoint_revision=checkpoint_revision,
                    expected_task_revision=int(scope.task_revision),
                    **options,
                )
            except Exception:
                published = None
            if published is None:
                fence_lost = True
                return False
            checkpoint_revision = int(published[0])
            return True

        if should_cancel():
            return JobTransitionResult(JobState.CANCELED, "cover_remote_save_canceled")
        try:
            result = run_save(
                scope=scope,
                config=dict(config),
                logger=durable_logger,
                should_cancel=should_cancel,
                checkpoint=checkpoint,
                persist_selection=persist_selection,
                publish=publish,
            )
        except Exception:
            result = {"status": "ambiguous" if checkpoint_revision > 0 else "failed"}
        status = str(result.get("status") or "failed")
        if fence_lost or status == "ambiguous":
            return JobTransitionResult(JobState.AMBIGUOUS, "cover_remote_save_ambiguous")
        if status == "succeeded":
            return JobTransitionResult(JobState.SUCCEEDED, "cover_remote_save_completed")
        if status == "canceled":
            return JobTransitionResult(JobState.CANCELED, "cover_remote_save_canceled")
        return JobTransitionResult(JobState.FAILED, "cover_remote_save_failed")

    return handle


__all__ = [
    "build_cover_lookup_handler",
    "build_cover_lookup_resource_validator",
    "build_cover_refresh_handler",
    "build_cover_bulk_refresh_resource_validator",
    "build_cover_remote_save_handler",
    "build_cover_remote_save_resource_validator",
]
