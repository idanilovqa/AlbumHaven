"""Bounded orchestration for durable Problematic Files projections."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from datetime import datetime, timedelta, timezone
from enum import Enum
import logging
from typing import Any

from music_app.services.jobs.models import ClaimedJob, JobState, JobTransitionResult
from music_app.services.problematic_files_projection import (
    ProblematicProjectionFactLimitError,
)
from music_app.services.problematic_projection_postgres import (
    ProblematicProjectionBuild,
    ProblematicProjectionGroupKey,
    ProblematicProjectionIntegrityError,
    ProblematicProjectionSourceChunk,
    ProblematicProjectionStorageError,
)


PROBLEMATIC_PROJECTION_SOURCE_PAGE_LIMIT = 32
PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT = 100
PROBLEMATIC_PROJECTION_STAGE_BATCH_LIMIT = 100

_STORAGE_RETRY_DELAY = timedelta(seconds=5)


class _GroupProjectionResult(Enum):
    COMPLETED = "completed"
    INCOMPLETE = "incomplete"
    STOPPED = "stopped"


def _context_stop_reason(context: Any) -> str | None:
    if context.cancel_requested:
        return "problematic_projection_canceled"
    if not context.lease_active:
        return "problematic_projection_lease_lost"
    if not context.reauthorize().allowed:
        return "problematic_projection_scope_stale"
    if context.cancel_requested:
        return "problematic_projection_canceled"
    if not context.lease_active:
        return "problematic_projection_lease_lost"
    if getattr(context, "shutdown_requested", False):
        return "problematic_projection_worker_shutdown"
    return None


def _validate_chunk(
    chunk: ProblematicProjectionSourceChunk,
    active_group_key: ProblematicProjectionGroupKey | None,
) -> None:
    cursor = chunk.cursor
    if (
        not isinstance(cursor, tuple)
        or len(cursor) != 4
        or not isinstance(cursor[0], str)
        or not cursor[0]
        or not isinstance(cursor[2], str)
        or not cursor[2]
        or chunk.group_key != (cursor[0], cursor[1])
        or (active_group_key is not None and chunk.group_key != active_group_key)
        or (
            not chunk.rows
            and not chunk.complete
            and chunk.cursor[2] != "duplicate_lookup"
        )
        or len(chunk.rows) > PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT
    ):
        raise ProblematicProjectionIntegrityError("invalid source chunk")


def _bounded_batches(
    items: Iterable[Any],
) -> Iterable[tuple[Any, ...]]:
    batch: list[Any] = []
    for item in items:
        batch.append(item)
        if len(batch) == PROBLEMATIC_PROJECTION_STAGE_BATCH_LIMIT:
            yield tuple(batch)
            batch.clear()
    if batch:
        yield tuple(batch)


def _bounded_fact_batches(items: Iterable[tuple[int, str, Mapping[str, Any]]]):
    batch: list[tuple[int, str, Mapping[str, Any]]] = []
    stage: list[tuple[int, str, Mapping[str, Any]]] = []
    stage_id: int | None = None

    def append_stage():
        nonlocal batch, stage
        if len(stage) > PROBLEMATIC_PROJECTION_STAGE_BATCH_LIMIT:
            raise ProblematicProjectionIntegrityError(
                "one source row exceeds the normalized fact limit"
            )
        if batch and len(batch) + len(stage) > PROBLEMATIC_PROJECTION_STAGE_BATCH_LIMIT:
            ready = tuple(batch)
            batch = list(stage)
            stage = []
            return ready
        batch.extend(stage)
        stage = []
        return None

    for item in items:
        item_stage_id = int(item[0])
        if stage_id is not None and item_stage_id != stage_id:
            if (ready := append_stage()) is not None:
                yield ready
        stage_id = item_stage_id
        stage.append(item)
    if stage:
        if (ready := append_stage()) is not None:
            yield ready
    if batch:
        yield tuple(batch)


def build_problematic_projection_handler(
    *,
    repository: Any,
    project_group: Callable[
        [Iterable[Mapping[str, Any]]], Iterable[Mapping[str, Any]]
    ],
    clock: Callable[[], datetime] | None = None,
) -> Callable[[ClaimedJob, Any], JobTransitionResult]:
    """Build one retry-safe handler with bounded source and output ownership."""

    now = clock or (lambda: datetime.now(timezone.utc))
    accumulator_type = getattr(project_group, "accumulator_type", None)

    def interruption_outcome(reason: str) -> JobTransitionResult:
        if reason == "problematic_projection_worker_shutdown":
            return JobTransitionResult(
                JobState.RETRY_WAIT,
                reason,
                scheduled_at=now() + _STORAGE_RETRY_DELAY,
                preserve_attempt=True,
            )
        return JobTransitionResult(JobState.CANCELED, reason)

    def failure_outcome(
        claim: ClaimedJob,
        build: ProblematicProjectionBuild | None,
        reason_code: str,
    ) -> JobTransitionResult:
        if claim.attempt < claim.max_attempts:
            return JobTransitionResult(
                JobState.RETRY_WAIT,
                reason_code,
                scheduled_at=now() + _STORAGE_RETRY_DELAY,
            )
        repository.record_claimed_terminal_failure(
            claim=claim,
            build=build,
            reason_code=reason_code,
            now=now(),
        )
        return JobTransitionResult(JobState.FAILED, reason_code)

    def handle(claim: ClaimedJob, context: Any) -> JobTransitionResult:
        reason = _context_stop_reason(context)
        if reason is not None:
            return interruption_outcome(reason)

        build: ProblematicProjectionBuild | None = None

        def claimed_build_stop_reason() -> str | None:
            context_reason = _context_stop_reason(context)
            if context_reason is not None:
                if (
                    context_reason == "problematic_projection_canceled"
                    and build is not None
                    and context.lease_active
                    and context.reauthorize().allowed
                    and repository.validate_claimed_build(
                        claim=claim, build=build, now=now()
                    )
                ):
                    repository.cancel_claimed_build(
                        claim=claim,
                        build=build,
                        reason_code=context_reason,
                        now=now(),
                    )
                return context_reason
            if build is None or not repository.validate_claimed_build(
                claim=claim, build=build, now=now()
            ):
                return "problematic_projection_stale"
            return None

        def project_active_group(
            group_key: ProblematicProjectionGroupKey,
            source_cursor: tuple[str, int | str, str, int | str],
            source_complete: bool | None = None,
        ) -> tuple[_GroupProjectionResult, str | None]:
            if accumulator_type is None or build is None:
                raise ProblematicProjectionIntegrityError(
                    "problematic projection accumulator type is required"
                )
            persisted = repository.load_claimed_group_accumulator(
                claim=claim,
                build=build,
                group_key=group_key,
                now=now(),
            )
            projection = accumulator_type.from_checkpoint(persisted)
            facts = projection.consume(
                repository.iter_claimed_source_group_entries(
                    claim=claim,
                    build=build,
                    group_key=group_key,
                    after_stage_id=persisted.after_stage_id,
                    batch_limit=PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT,
                    now=now(),
                )
            )
            for fact_batch in _bounded_fact_batches(facts):
                reason = claimed_build_stop_reason()
                if reason is not None:
                    return _GroupProjectionResult.STOPPED, reason
                fact_stage_count = 1 + sum(
                    fact_batch[index - 1][0] != fact_batch[index][0]
                    for index in range(1, len(fact_batch))
                )
                persisted = repository.checkpoint_claimed_group_facts(
                    claim=claim,
                    build=build,
                    group_key=group_key,
                    expected_after_stage_id=persisted.after_stage_id,
                    entries=fact_batch,
                    next_batch_index=persisted.next_batch_index,
                    row_count=persisted.row_count + fact_stage_count,
                    now=now(),
                )
            if source_complete is None:
                source_complete = persisted.source_complete
            if not source_complete:
                return _GroupProjectionResult.INCOMPLETE, None
            projection = accumulator_type.from_checkpoint(persisted)
            projected_items = projection.finalize(
                repository.iter_claimed_group_facts(
                    claim=claim,
                    build=build,
                    group_key=group_key,
                    after_stage_id=0,
                    batch_limit=PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT,
                    now=now(),
                )
            )
            for item_index, projected in enumerate(projected_items):
                with projected:
                    if item_index < persisted.next_batch_index:
                        continue
                    reason = claimed_build_stop_reason()
                    if reason is not None:
                        return _GroupProjectionResult.STOPPED, reason
                    repository.stage_claimed_items(
                        claim=claim,
                        build=build,
                        group_key=group_key,
                        items=(projected,),
                        batch_index=item_index,
                        now=now(),
                    )
                    for reason_batch in _bounded_batches(projected.reason_facts):
                        reason = claimed_build_stop_reason()
                        if reason is not None:
                            return _GroupProjectionResult.STOPPED, reason
                        repository.stage_claimed_reason_facts(
                            claim=claim,
                            build=build,
                            group_key=group_key,
                            facts=reason_batch,
                            now=now(),
                        )
                    persisted = repository.advance_claimed_group_accumulator(
                        claim=claim,
                        build=build,
                        group_key=group_key,
                        expected_after_stage_id=persisted.after_stage_id,
                        after_stage_id=persisted.after_stage_id,
                        next_batch_index=item_index + 1,
                        row_count=persisted.row_count,
                        now=now(),
                    ) or type(persisted)(
                        persisted.after_stage_id,
                        item_index + 1,
                        persisted.row_count,
                        persisted.source_complete,
                    )
            search_cursor = ("", "", "")
            while True:
                reason = claimed_build_stop_reason()
                if reason is not None:
                    return _GroupProjectionResult.STOPPED, reason
                staged_search = repository.stage_claimed_search_facts(
                    claim=claim,
                    build=build,
                    group_key=group_key,
                    after_projection_id=search_cursor[0],
                    after_fact_kind=search_cursor[1],
                    after_semantic_child_identity=search_cursor[2],
                    limit=PROBLEMATIC_PROJECTION_STAGE_BATCH_LIMIT,
                    now=now(),
                )
                next_search_cursor = staged_search[:3]
                staged_search_count = staged_search[3]
                search_complete = staged_search[4]
                if (
                    not search_complete
                    and (
                        staged_search_count == 0
                        or next_search_cursor <= search_cursor
                    )
                ):
                    raise ProblematicProjectionIntegrityError(
                        "search fact staging cursor did not advance"
                    )
                search_cursor = next_search_cursor
                if search_complete:
                    break
            reason = claimed_build_stop_reason()
            if reason is not None:
                return _GroupProjectionResult.STOPPED, reason
            repository.complete_claimed_source_group(
                claim=claim,
                build=build,
                group_key=group_key,
                source_cursor=source_cursor,
                now=now(),
            )
            return _GroupProjectionResult.COMPLETED, None

        try:
            build = repository.prepare_claimed_build(claim=claim, now=now())
            if build.committed:
                reason = _context_stop_reason(context)
                if reason is not None:
                    return interruption_outcome(reason)
                if repository.publish_claimed_snapshot(
                    claim=claim, build=build, now=now()
                ):
                    return JobTransitionResult(
                        JobState.SUCCEEDED, "problematic_projection_completed"
                    )
                return JobTransitionResult(
                    JobState.CANCELED, "problematic_projection_stale"
                )
            active_group_key = build.source_group_key
            if active_group_key is not None:
                if build.source_cursor is None:
                    raise ProblematicProjectionIntegrityError(
                        "active projection group lacks source cursor"
                    )
                group_result, reason = project_active_group(
                    active_group_key, build.source_cursor
                )
                if group_result is _GroupProjectionResult.STOPPED:
                    return interruption_outcome(reason)
                if group_result is _GroupProjectionResult.COMPLETED:
                    active_group_key = None

            while True:
                reason = claimed_build_stop_reason()
                if reason is not None:
                    return interruption_outcome(reason)
                page = repository.load_claimed_source_page(
                    claim=claim,
                    build=build,
                    limit=PROBLEMATIC_PROJECTION_SOURCE_PAGE_LIMIT,
                    child_limit=PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT,
                    now=now(),
                )
                if len(page.chunks) > PROBLEMATIC_PROJECTION_SOURCE_PAGE_LIMIT:
                    raise ProblematicProjectionIntegrityError(
                        "source page exceeds group limit"
                    )
                while not page.complete and not page.chunks:
                    reason = claimed_build_stop_reason()
                    if reason is not None:
                        return interruption_outcome(reason)
                    page = repository.load_claimed_source_page(
                        claim=claim,
                        build=build,
                        limit=PROBLEMATIC_PROJECTION_SOURCE_PAGE_LIMIT,
                        child_limit=PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT,
                        now=now(),
                    )
                    if len(page.chunks) > PROBLEMATIC_PROJECTION_SOURCE_PAGE_LIMIT:
                        raise ProblematicProjectionIntegrityError(
                            "source page exceeds group limit"
                        )

                for chunk in page.chunks:
                    if accumulator_type is None:
                        raise ProblematicProjectionIntegrityError(
                            "problematic projection accumulator type is required"
                        )
                    _validate_chunk(chunk, active_group_key)
                    reason = claimed_build_stop_reason()
                    if reason is not None:
                        return interruption_outcome(reason)
                    repository.stage_claimed_source_chunk(
                        claim=claim,
                        build=build,
                        group_key=chunk.group_key,
                        source_cursor=chunk.cursor,
                        rows=chunk.rows,
                        complete=chunk.complete,
                        now=now(),
                    )
                    reason = claimed_build_stop_reason()
                    if reason is not None:
                        return interruption_outcome(reason)
                    active_group_key = chunk.group_key
                    group_result, reason = project_active_group(
                        chunk.group_key,
                        chunk.cursor,
                        source_complete=chunk.complete,
                    )
                    if group_result is _GroupProjectionResult.STOPPED:
                        return interruption_outcome(reason)
                    if group_result is _GroupProjectionResult.COMPLETED:
                        active_group_key = None
                    continue

                if page.complete:
                    if active_group_key is not None:
                        raise ProblematicProjectionIntegrityError(
                            "source ended inside a group"
                        )
                    break

            reason = claimed_build_stop_reason()
            if reason is not None:
                return interruption_outcome(reason)
            if not repository.publish_claimed_snapshot(
                claim=claim, build=build, now=now()
            ):
                return JobTransitionResult(
                    JobState.CANCELED, "problematic_projection_stale"
                )
            return JobTransitionResult(
                JobState.SUCCEEDED, "problematic_projection_completed"
            )
        except (
            ProblematicProjectionIntegrityError,
            ProblematicProjectionFactLimitError,
        ):
            logging.getLogger(__name__).exception(
                "Problematic Files projection integrity failure."
            )
            return failure_outcome(
                claim, build, "problematic_projection_integrity_failed"
            )
        except ProblematicProjectionStorageError:
            logging.getLogger(__name__).exception(
                "Problematic Files projection storage failure."
            )
            return failure_outcome(
                claim, build, "problematic_projection_storage_unavailable"
            )

    return handle


__all__ = [
    "PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT",
    "PROBLEMATIC_PROJECTION_SOURCE_PAGE_LIMIT",
    "PROBLEMATIC_PROJECTION_STAGE_BATCH_LIMIT",
    "build_problematic_projection_handler",
]
