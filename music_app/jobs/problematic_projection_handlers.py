"""Bounded orchestration for durable Problematic Files projections."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from enum import Enum
import heapq
import logging
from typing import Any

from music_app.services.jobs.models import ClaimedJob, JobState, JobTransitionResult
from music_app.services.problematic_files_projection import (
    ProblematicProjectionFactLimitError,
    _derive_problematic_topology_address,
    _derive_problematic_topology_numeric_bucket,
    _derive_problematic_topology_own_rank,
    _prepare_problematic_topology_parent_partition,
    _problematic_topology_seed,
    _problematic_topology_work,
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


class _TopologyStopped(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@contextmanager
def _owned_topology_iterator(owner):
    def close():
        operation = getattr(owner, "close", None)
        if callable(operation):
            operation()

    try:
        yield owner
    except BaseException as error:
        try:
            close()
        except BaseException as cleanup_error:
            error.add_note(f"topology iterator cleanup failed: {cleanup_error!r}")
        raise
    else:
        close()


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
        if claim.attempt < claim.max_attempts and reason_code != "problematic_projection_topology_unknown":
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

        def check_topology_stop() -> None:
            reason = claimed_build_stop_reason()
            if reason is not None:
                raise _TopologyStopped(reason)

        topology_work = _problematic_topology_work(check_topology_stop)

        def topology_descriptors(group_key):
            return repository.iter_claimed_topology_descriptors(
                claim=claim, build=build, group_key=group_key,
                batch_limit=PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT, now=now(),
            )

        def topology_inputs(group_key, after_stage_id=0):
            return repository.iter_claimed_source_group_entries(
                claim=claim, build=build, group_key=group_key, after_stage_id=after_stage_id,
                batch_limit=PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT, now=now(),
            )

        def checkpoint_topology(group_key, batches):
            persisted = repository.load_claimed_group_accumulator(
                claim=claim, build=build, group_key=group_key, now=now(),
            )
            with _owned_topology_iterator(batches):
                for batch in batches:
                    check_topology_stop()
                    row_count = persisted.row_count + len({
                        stage for stage, _kind, _value in batch if stage > persisted.after_stage_id
                    })
                    for _stage, kind, value in batch:
                        if kind in ("topology_numeric_bucket_result", "topology_own_rank_result", "topology_address_result"):
                            row_count = int(value["input_count"])
                    persisted = repository.checkpoint_claimed_group_facts(
                        claim=claim, build=build, group_key=group_key,
                        expected_after_stage_id=persisted.after_stage_id, entries=batch,
                        next_batch_index=persisted.next_batch_index, row_count=row_count, now=now(),
                    )
            return persisted

        def resolve_topology_references(group_key):
            with _owned_topology_iterator(topology_descriptors(group_key)) as descriptors:
                for descriptor in descriptors:
                    if descriptor["fact_kind"] in ("topology_reference", "topology_physical_reference", "topology_rank_reference"):
                        value = descriptor["fact_value"]
                        ensure_topology_node((value["node_kind"], value["node_identity"]))

        def register_topology(group_key):
            persisted = repository.load_claimed_group_accumulator(
                claim=claim, build=build, group_key=group_key, now=now(),
            )
            cursor = 0
            own_dependencies_resolved = False
            maximum_steps = 2 * ((persisted.row_count + 99) // 100) + 4
            for _step in range(maximum_steps):
                check_topology_stop()
                next_cursor, complete = repository.register_claimed_topology_nodes(
                    claim=claim, build=build, group_key=group_key, after_seed_stage_id=cursor,
                    limit=PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT, now=now(),
                )
                if complete:
                    resolve_topology_references(group_key)
                    return
                if next_cursor == cursor and not own_dependencies_resolved:
                    resolve_topology_references(group_key)
                    own_dependencies_resolved = True
                cursor = next_cursor
            raise ProblematicProjectionIntegrityError("topology registration did not close")

        def ensure_topology_node(node_key):
            check_topology_stop()
            while True:
                page = repository.load_claimed_topology_node(
                    claim=claim, build=build, node_key=node_key,
                    limit=PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT, now=now(),
                )
                if page["sealed"]:
                    return
                definition = page["definition"]
                if page["expected_cursor"].get("relation") == "dependency":
                    ensure_topology_node(("topology_numeric_bucket", page["expected_cursor"]["input_owner"]))
                    continue
                if page["expected_cursor"].get("relation") == "done":
                    break
                rows = page["rows"]
                if page["expected_cursor"].get("relation") in ("numeric_parent", "parent"):
                    from music_app.services.library import _numeric_album_container_candidate

                    classified = []
                    for row in rows:
                        topology_work(len(str(row).encode("utf-8")))
                        try:
                            candidate = _numeric_album_container_candidate(row["path"], 0, None, None)
                        except ValueError:
                            # Some isdigit glyphs cannot represent a decimal ordinal.
                            candidate = None
                        classified.append({**row, "retain": candidate is not None})
                    rows = classified
                repository.stage_claimed_topology_node(
                    claim=claim, build=build, node_key=node_key, expected_cursor=page["expected_cursor"],
                    rows=rows, complete=page["complete"], now=now(),
                )
                check_topology_stop()

            persisted = repository.load_claimed_group_accumulator(
                claim=claim, build=build, group_key=node_key, now=now(),
            )
            if definition.get("subordinate_input"):
                with _owned_topology_iterator(topology_inputs(node_key, persisted.after_stage_id)) as entries:
                    with _owned_topology_iterator(_prepare_problematic_topology_parent_partition(
                        entries, definition["key"][1], work=topology_work,
                    )) as partitions:
                        checkpoint_topology(node_key, _bounded_fact_batches(partitions))
            elif definition.get("subordinate_own_rank") or node_key[0] == "topology_numeric_bucket":
                result_kind = ("topology_own_rank_result" if definition.get("subordinate_own_rank")
                               else "topology_numeric_bucket_result")
                previous = None
                with _owned_topology_iterator(topology_descriptors(node_key)) as descriptors:
                    for descriptor in descriptors:
                        if descriptor["fact_kind"] == result_kind:
                            previous = descriptor["fact_value"]
                if not (result_kind == "topology_numeric_bucket_result" and previous and previous.get("complete")):
                    derive = (_derive_problematic_topology_own_rank if definition.get("subordinate_own_rank")
                              else _derive_problematic_topology_numeric_bucket)
                    with _owned_topology_iterator(topology_inputs(node_key, persisted.after_stage_id)) as entries:
                        with _owned_topology_iterator(derive(entries, definition["key"], previous=previous,
                                                            work=topology_work)) as results:
                            checkpoint_topology(node_key, ((result,) for result in results))
            else:
                with _owned_topology_iterator(topology_inputs(node_key, persisted.after_stage_id)) as entries:
                    def seed_facts():
                        for stage_id, row in entries:
                            topology_work(len(str(row).encode("utf-8")))
                            seed = _problematic_topology_seed(row)
                            if seed is None:
                                raise ProblematicProjectionIntegrityError("topology input lacks file identity")
                            yield stage_id, "topology_seed", {
                                **seed, "projection_id": "topology", "semantic_child_identity": f"{stage_id:020d}",
                            }
                    checkpoint_topology(node_key, _bounded_fact_batches(seed_facts()))
                register_topology(node_key)
                if node_key[0] == "topology_address":
                    def values(kind):
                        with _owned_topology_iterator(topology_descriptors(node_key)) as descriptors:
                            for descriptor in descriptors:
                                if descriptor["fact_kind"] == kind:
                                    yield descriptor["fact_value"]
                    with _owned_topology_iterator(topology_inputs(node_key)) as entries:
                        with _owned_topology_iterator(values("topology_numeric_descriptor")) as numeric:
                            with _owned_topology_iterator(values("topology_rank_descriptor")) as ranks:
                                with _owned_topology_iterator(_derive_problematic_topology_address(
                                    entries, definition["key"], numeric, ranks, work=topology_work,
                                )) as results:
                                    checkpoint_topology(node_key, _bounded_fact_batches(results))
            check_topology_stop()
            repository.complete_claimed_topology_node(claim=claim, build=build, node_key=node_key, now=now())

        def final_topology_facts(group_key):
            yield 0, "topology_descriptor", {"projection_id": "topology", "semantic_child_identity": "!start",
                                            "descriptor_kind": "topology_descriptor_start", "descriptor": {}}
            with _owned_topology_iterator(topology_descriptors(group_key)) as descriptors:
                for descriptor in descriptors:
                    if descriptor["fact_kind"] in ("topology_numeric_descriptor", "topology_address_descriptor",
                                                   "topology_companion_descriptor", "topology_folder_descriptor", "topology_descriptor_end"):
                        yield 0, "topology_descriptor", {
                            "projection_id": "topology", "semantic_child_identity": descriptor["reference_key"],
                            "descriptor_kind": descriptor["fact_kind"], "descriptor": descriptor["fact_value"],
                        }

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
            def source_facts():
                entries = repository.iter_claimed_source_group_entries(
                    claim=claim,
                    build=build,
                    group_key=group_key,
                    after_stage_id=persisted.after_stage_id,
                    batch_limit=PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT,
                    now=now(),
                )
                with _owned_topology_iterator(entries):
                    with _owned_topology_iterator(projection.consume(entries)) as facts:
                        yield from facts

            with _owned_topology_iterator(source_facts()) as facts:
                with _owned_topology_iterator(_bounded_fact_batches(facts)) as batches:
                    for fact_batch in batches:
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
            try:
                register_topology(group_key)
            except _TopologyStopped as stopped:
                return _GroupProjectionResult.STOPPED, stopped.reason
            except (ValueError, TypeError) as error:
                raise ProblematicProjectionIntegrityError(str(error)) from error
            projection = accumulator_type.from_checkpoint(persisted)

            def finalized_topology_items():
                raw_facts = repository.iter_claimed_group_facts(
                    claim=claim,
                    build=build,
                    group_key=group_key,
                    after_stage_id=0,
                    batch_limit=PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT,
                    now=now(),
                )
                with _owned_topology_iterator(raw_facts):
                    with _owned_topology_iterator(final_topology_facts(group_key)) as descriptors:
                        merged = heapq.merge(raw_facts, descriptors, key=lambda fact: (
                            str(fact[2].get("projection_id") or ""), fact[1],
                            str(fact[2].get("semantic_child_identity") or ""),
                        ))
                        with _owned_topology_iterator(merged):
                            with _owned_topology_iterator(projection.finalize(
                                merged, check_stop=check_topology_stop,
                            )) as items:
                                yield from items

            projected_items = finalized_topology_items()
            try:
                for item_index, projected in enumerate(projected_items):
                    try:
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
                            for search_batch in _bounded_batches(projected.search_facts):
                                reason = claimed_build_stop_reason()
                                if reason is not None:
                                    return _GroupProjectionResult.STOPPED, reason
                                repository.stage_claimed_main_search_facts(
                                    claim=claim, build=build, group_key=group_key,
                                    facts=search_batch, now=now(),
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
                    finally:
                        close_item = getattr(projected, "close", None)
                        if callable(close_item):
                            close_item()
            except _TopologyStopped as stopped:
                return _GroupProjectionResult.STOPPED, stopped.reason
            except (ValueError, TypeError) as error:
                raise ProblematicProjectionIntegrityError(str(error)) from error
            finally:
                close_items = getattr(projected_items, "close", None)
                if callable(close_items):
                    close_items()
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
        ) as error:
            logging.getLogger(__name__).exception(
                "Problematic Files projection integrity failure."
            )
            return failure_outcome(claim, build,
                "problematic_projection_topology_unknown" if str(error) == "problematic_projection_topology_unknown"
                else "problematic_projection_integrity_failed")
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
