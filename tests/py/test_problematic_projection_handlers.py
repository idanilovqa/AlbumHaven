from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import pytest

from music_app.services.jobs.authorization import AuthorizationDecision
from music_app.services.jobs.models import ClaimedJob, JobKind, JobState


NOW = datetime(2026, 10, 28, 18, 0, tzinfo=timezone.utc)


def _claim(*, attempt: int = 1) -> ClaimedJob:
    return ClaimedJob(
        job_id=71,
        kind=JobKind.PROBLEMATIC_FILES_PROJECTION,
        subject_kind="problematic_files_projection",
        subject_ref="library:9",
        parameters={
            "projection_kind": "problematic_files",
            "source_generation": 12,
            "rebuild_epoch": 3,
        },
        account_id=None,
        library_id=9,
        capability_key=None,
        request_origin_id=None,
        deployment_mode="self_hosted",
        client_surface="server_worker",
        idempotency_key="problematic-files-projection:9:12:3",
        attempt=attempt,
        max_attempts=3,
        worker_id="worker-a",
        lease_token="lease-a",
        lease_expires_at=NOW,
        scheduled_at=NOW,
        scope_version=12,
        resource_revision=3,
    )


@dataclass
class _Context:
    cancel_requested: bool = False
    lease_active: bool = True
    allowed: bool = True
    library_current: bool = True
    reauthorizations: int = 0

    def reauthorize(self) -> AuthorizationDecision:
        self.reauthorizations += 1
        return AuthorizationDecision(
            self.allowed,
            "problematic_projection_scope_current"
            if self.allowed
            else "problematic_projection_scope_stale",
        )


class _TestAccumulator:
    def __init__(self, *, after_stage_id=0, next_batch_index=0, row_count=0):
        self.after_stage_id = after_stage_id
        self.next_batch_index = next_batch_index
        self.row_count = row_count

    @classmethod
    def from_checkpoint(cls, checkpoint):
        return cls(
            after_stage_id=checkpoint.after_stage_id,
            next_batch_index=checkpoint.next_batch_index,
            row_count=checkpoint.row_count,
        )

    def consume(self, entries):
        for stage_id, row in entries:
            key = str(row["key"])
            yield stage_id, "row", {
                "projection_id": f"{stage_id:020d}",
                "semantic_child_identity": key,
                "item": {"key": key},
            }

    def finalize(self, facts):
        for _stage_id, _fact_kind, fact in facts:
            yield _projected_item(fact["item"])


def _projected_item(item, *, reason_facts=None):
    from music_app.services.problematic_files_projection import (
        ProblematicProjectedItem,
        ProblematicProjectionReasonFact,
    )

    item = {**item, "item_key": str(item.get("item_key") or item.get("key") or "item")}
    facts = reason_facts
    if facts is None:
        facts = (
            ProblematicProjectionReasonFact(
                item_key=item["item_key"],
                normalized_reason="test reason",
                display_reason="Test reason",
                category_reason="Test reason",
            ),
        )
    return ProblematicProjectedItem(item=item, reason_facts=facts)


class _Repository:
    def __init__(self, pages: list[Any] | None = None) -> None:
        self.pages = list(pages or [])
        self.calls: list[tuple[Any, ...]] = []
        self.source_entries: dict[
            tuple[str, int | str], list[tuple[int, dict[str, Any]]]
        ] = {}
        self.group_facts: dict[
            tuple[str, int | str],
            dict[tuple[str, str, str], tuple[int, str, dict[str, Any]]],
        ] = {}
        self.accumulators: dict[tuple[str, int | str], Any] = {}
        self.source_complete: dict[tuple[str, int | str], bool] = {}
        self.next_stage_id = 1
        self.source_cursor = None
        self.publish_result = True
        self.current = True
        self.raise_from_prepare: Exception | None = None
        self.raise_from_load: Exception | None = None
        self.raise_from_terminal: Exception | None = None
        self.prepared_build = None
        self.projected_count = 0
        self.after_source_stage = lambda: None

    def prepare_claimed_build(self, *, claim, now):
        from music_app.services.problematic_projection_postgres import (
            ProblematicProjectionBuild,
        )

        self.calls.append(
            ("prepare", claim.job_id, claim.attempt, claim.lease_token, now)
        )
        if self.raise_from_prepare is not None:
            raise self.raise_from_prepare
        build = self.prepared_build or ProblematicProjectionBuild(
            9, 12, 3, "revision-a", None
        )
        if self.source_cursor is None:
            self.source_cursor = build.source_cursor
        return build

    def validate_claimed_build(self, *, claim, build, now):
        self.calls.append(
            (
                "validate",
                claim.job_id,
                build.source_generation,
                build.rebuild_epoch,
                now,
            )
        )
        return self.current

    def load_claimed_source_page(self, *, claim, build, limit, child_limit, now):
        self.calls.append(
            (
                "load",
                claim.job_id,
                build.source_generation,
                build.rebuild_epoch,
                self.source_cursor,
                limit,
                child_limit,
                now,
            )
        )
        if self.raise_from_load is not None:
            raise self.raise_from_load
        return self.pages.pop(0)

    def stage_claimed_source_chunk(
        self, *, claim, build, group_key, source_cursor, rows, complete, now
    ):
        rows = tuple(rows)
        self.calls.append(
            (
                "stage_source",
                claim.job_id,
                build.source_generation,
                build.rebuild_epoch,
                group_key,
                source_cursor,
                rows,
                complete,
                now,
            )
        )
        entries = self.source_entries.setdefault(group_key, [])
        for row in rows:
            entries.append((self.next_stage_id, dict(row)))
            self.next_stage_id += 1
        self.source_cursor = source_cursor
        self.source_complete[group_key] = complete
        self.after_source_stage()

    def load_claimed_group_accumulator(self, *, group_key, **_kwargs):
        from music_app.services.problematic_projection_postgres import (
            ProblematicProjectionGroupAccumulator,
        )

        return self.accumulators.get(
            group_key,
            ProblematicProjectionGroupAccumulator(
                0, 0, 0, self.source_complete.get(group_key, False)
            ),
        )

    def iter_claimed_source_group_entries(
        self, *, claim, build, group_key, after_stage_id, batch_limit, now
    ):
        self.calls.append(
            (
                "iter_source",
                claim.job_id,
                build.source_generation,
                build.rebuild_epoch,
                group_key,
                batch_limit,
                now,
            )
        )
        entries = self.source_entries.get(group_key, [])
        for offset in range(0, len(entries), batch_limit):
            yield from (
                entry
                for entry in entries[offset : offset + batch_limit]
                if entry[0] > after_stage_id
            )

    def checkpoint_claimed_group_facts(
        self,
        *,
        group_key,
        expected_after_stage_id,
        entries,
        next_batch_index,
        row_count,
        **_kwargs,
    ):
        from music_app.services.problematic_projection_postgres import (
            ProblematicProjectionGroupAccumulator,
        )

        entries = tuple(entries)
        current = self.load_claimed_group_accumulator(group_key=group_key)
        assert current.after_stage_id == expected_after_stage_id
        persisted = self.group_facts.setdefault(group_key, {})
        for stage_id, fact_kind, fact_value in entries:
            fact = dict(fact_value)
            key = (
                str(fact["projection_id"]),
                fact_kind,
                str(fact["semantic_child_identity"]),
            )
            persisted[key] = (stage_id, fact_kind, fact)
        accumulator = ProblematicProjectionGroupAccumulator(
            entries[-1][0],
            next_batch_index,
            row_count,
            self.source_complete.get(group_key, False),
        )
        self.accumulators[group_key] = accumulator
        return accumulator

    def iter_claimed_group_facts(self, *, group_key, **_kwargs):
        facts = self.group_facts.get(group_key, {})
        for key in sorted(facts):
            yield facts[key]

    def advance_claimed_group_accumulator(
        self,
        *,
        group_key,
        expected_after_stage_id,
        after_stage_id,
        next_batch_index,
        row_count,
        **_kwargs,
    ):
        from music_app.services.problematic_projection_postgres import (
            ProblematicProjectionGroupAccumulator,
        )

        current = self.load_claimed_group_accumulator(group_key=group_key)
        assert current.after_stage_id == expected_after_stage_id
        accumulator = ProblematicProjectionGroupAccumulator(
            after_stage_id,
            next_batch_index,
            row_count,
            self.source_complete.get(group_key, False),
        )
        self.accumulators[group_key] = accumulator
        return accumulator

    def stage_claimed_items(
        self, *, claim, build, group_key, items, batch_index, now
    ):
        self.calls.append(
            (
                "stage_item",
                claim.job_id,
                build.source_generation,
                build.rebuild_epoch,
                group_key,
                tuple(items),
                batch_index,
                self.projected_count,
                now,
            )
        )

    def stage_claimed_reason_facts(
        self, *, claim, build, group_key, facts, now
    ):
        self.calls.append(
            (
                "stage_reason",
                claim.job_id,
                build.source_generation,
                build.rebuild_epoch,
                group_key,
                tuple(facts),
                now,
            )
        )

    def stage_claimed_search_facts(
        self,
        *,
        claim,
        build,
        group_key,
        after_projection_id,
        after_fact_kind,
        after_semantic_child_identity,
        limit,
        now,
    ):
        self.calls.append(
            (
                "stage_search",
                claim.job_id,
                build.source_generation,
                build.rebuild_epoch,
                group_key,
                (
                    after_projection_id,
                    after_fact_kind,
                    after_semantic_child_identity,
                ),
                limit,
                now,
            )
        )
        return (
            after_projection_id,
            after_fact_kind,
            after_semantic_child_identity,
            0,
            True,
        )

    def complete_claimed_source_group(
        self, *, claim, build, group_key, source_cursor, now
    ):
        self.calls.append(
            (
                "complete_group",
                claim.job_id,
                build.source_generation,
                build.rebuild_epoch,
                group_key,
                source_cursor,
                now,
            )
        )

    def publish_claimed_snapshot(self, *, claim, build, now):
        self.calls.append(
            (
                "publish",
                claim.job_id,
                build.source_generation,
                build.rebuild_epoch,
                build.revision,
                now,
            )
        )
        return self.publish_result

    def record_claimed_terminal_failure(
        self, *, claim, build, reason_code, now
    ):
        self.calls.append(
            (
                "terminal_failure",
                claim.job_id,
                None if build is None else build.revision,
                reason_code,
                now,
            )
        )
        if self.raise_from_terminal is not None:
            raise self.raise_from_terminal

    def cancel_claimed_build(self, *, claim, build, reason_code, now):
        self.calls.append(
            (
                "cancel_build",
                claim.job_id,
                None if build is None else build.revision,
                reason_code,
                now,
            )
        )


def _cursor(
    source_identity: int | str,
    child_identity: int | str,
    *,
    source_kind: str = "album",
    child_kind: str = "track",
):
    return (source_kind, source_identity, child_kind, child_identity)


def _chunk(cursor, rows, *, complete: bool):
    from music_app.services.problematic_projection_postgres import (
        ProblematicProjectionSourceChunk,
    )

    return ProblematicProjectionSourceChunk(
        group_key=(cursor[0], cursor[1]),
        cursor=cursor,
        rows=tuple(rows),
        complete=complete,
    )


def _page(*chunks, complete: bool):
    from music_app.services.problematic_projection_postgres import (
        ProblematicProjectionSourcePage,
    )

    return ProblematicProjectionSourcePage(chunks=tuple(chunks), complete=complete)


def _handler(repository, projector):
    from music_app.jobs.problematic_projection_handlers import (
        build_problematic_projection_handler,
    )

    return build_problematic_projection_handler(
        repository=repository, project_group=projector, clock=lambda: NOW
    )


def _stream_items(_rows):
    raise AssertionError("the accumulator path must own projection")


_stream_items.accumulator_type = _TestAccumulator


class _TrackingReasonFacts:
    def __init__(self, facts):
        self._facts = iter(facts)
        self.closed = False

    def __iter__(self):
        return self

    def __next__(self):
        if self.closed:
            raise StopIteration
        return next(self._facts)

    def close(self):
        self.closed = True


def _reason_fact(index, *, item_key="item-a"):
    from music_app.services.problematic_files_projection import (
        ProblematicProjectionReasonFact,
    )

    return ProblematicProjectionReasonFact(
        item_key=item_key,
        normalized_reason=f"reason {index:03d}",
        display_reason=f"Reason {index:03d}",
        category_reason=f"Reason {index:03d}",
    )


def test_handler_stages_each_item_then_reason_batches_before_checkpointing():
    from music_app.services.problematic_projection_postgres import (
        ProblematicProjectionGroupAccumulator,
    )

    reason_facts = _TrackingReasonFacts(_reason_fact(index) for index in range(205))
    projected = _projected_item(
        {"item_key": "item-a"}, reason_facts=reason_facts
    )

    class Accumulator(_TestAccumulator):
        def finalize(self, facts):
            assert tuple(facts)
            yield projected

    def projector(_rows):
        raise AssertionError("the accumulator path must own projection")

    projector.accumulator_type = Accumulator

    class Repository(_Repository):
        def advance_claimed_group_accumulator(self, **kwargs):
            self.calls.append(("advance", kwargs["next_batch_index"]))
            return super().advance_claimed_group_accumulator(**kwargs)

    cursor = _cursor(2, 1)
    repository = Repository(
        [_page(_chunk(cursor, [{"key": "row"}], complete=True), complete=True)]
    )

    result = _handler(repository, projector)(_claim(), _Context())

    assert result.next_state is JobState.SUCCEEDED
    assert [
        call[0]
        for call in repository.calls
        if call[0] in {"stage_item", "stage_reason", "advance"}
    ] == ["stage_item", "stage_reason", "stage_reason", "stage_reason", "advance"]
    assert [
        len(call[5]) for call in repository.calls if call[0] == "stage_reason"
    ] == [100, 100, 5]
    assert reason_facts.closed
    assert repository.accumulators[("album", 2)] == ProblematicProjectionGroupAccumulator(
        1, 1, 1, True
    )


def test_handler_stops_between_reason_batches_without_advancing_checkpoint():
    reason_facts = _TrackingReasonFacts(_reason_fact(index) for index in range(205))
    projected = _projected_item(
        {"item_key": "item-a"}, reason_facts=reason_facts
    )

    class Accumulator(_TestAccumulator):
        def finalize(self, _facts):
            yield projected

    def projector(_rows):
        raise AssertionError("the accumulator path must own projection")

    projector.accumulator_type = Accumulator
    context = _Context()

    class Repository(_Repository):
        def stage_claimed_reason_facts(self, **kwargs):
            super().stage_claimed_reason_facts(**kwargs)
            context.cancel_requested = True

        def advance_claimed_group_accumulator(self, **kwargs):
            self.calls.append(("advance", kwargs["next_batch_index"]))
            return super().advance_claimed_group_accumulator(**kwargs)

    cursor = _cursor(2, 1)
    repository = Repository(
        [_page(_chunk(cursor, [{"key": "row"}], complete=True), complete=True)]
    )

    result = _handler(repository, projector)(_claim(), context)

    assert result.next_state is JobState.CANCELED
    assert result.reason_code == "problematic_projection_canceled"
    assert [
        len(call[5]) for call in repository.calls if call[0] == "stage_reason"
    ] == [100]
    assert not any(call[0] == "advance" for call in repository.calls)
    assert reason_facts.closed


def test_handler_pages_search_facts_and_restarts_from_claim_fenced_cursor():
    from music_app.services.problematic_projection_postgres import (
        ProblematicProjectionBuild,
    )

    class Accumulator(_TestAccumulator):
        def finalize(self, _facts):
            yield _projected_item({"item_key": "item-a"})

    def projector(_rows):
        raise AssertionError("the accumulator path must own projection")

    projector.accumulator_type = Accumulator
    first_context = _Context()

    class Repository(_Repository):
        cancel_after_first_search = True

        def stage_claimed_search_facts(self, **kwargs):
            super().stage_claimed_search_facts(**kwargs)
            if not kwargs["after_projection_id"]:
                if self.cancel_after_first_search:
                    first_context.cancel_requested = True
                return (
                    "projection-a",
                    "track_title_search",
                    "chunk-00000000000000000099",
                    100,
                    False,
                )
            return (
                "projection-b",
                "private_path_search",
                "chunk-00000000000000000100",
                1,
                True,
            )

    cursor = _cursor(2, 1)
    group_key = ("album", 2)
    repository = Repository(
        [_page(_chunk(cursor, [{"key": "row"}], complete=True), complete=True)]
    )

    first = _handler(repository, projector)(_claim(), first_context)

    assert first.next_state is JobState.CANCELED
    assert not any(call[0] == "complete_group" for call in repository.calls)
    assert [
        call[5] for call in repository.calls if call[0] == "stage_search"
    ] == [("", "", "")]

    repository.calls.clear()
    repository.cancel_after_first_search = False
    repository.prepared_build = ProblematicProjectionBuild(
        9, 12, 3, "revision-a", cursor, group_key
    )
    repository.pages.append(_page(complete=True))
    second = _handler(repository, projector)(_claim(attempt=2), _Context())

    assert second.next_state is JobState.SUCCEEDED
    assert [
        call[5] for call in repository.calls if call[0] == "stage_search"
    ] == [
        ("", "", ""),
        (
            "projection-a",
            "track_title_search",
            "chunk-00000000000000000099",
        ),
    ]
    assert any(call[0] == "complete_group" for call in repository.calls)


def test_handler_closes_reason_stream_when_reason_staging_fails():
    from music_app.services.problematic_projection_postgres import (
        ProblematicProjectionStorageError,
    )

    reason_facts = _TrackingReasonFacts(_reason_fact(index) for index in range(2))
    projected = _projected_item(
        {"item_key": "item-a"}, reason_facts=reason_facts
    )

    class Accumulator(_TestAccumulator):
        def finalize(self, _facts):
            yield projected

    def projector(_rows):
        raise AssertionError("the accumulator path must own projection")

    projector.accumulator_type = Accumulator

    class Repository(_Repository):
        def stage_claimed_reason_facts(self, **_kwargs):
            raise ProblematicProjectionStorageError("reason staging failed")

        def advance_claimed_group_accumulator(self, **kwargs):
            self.calls.append(("advance", kwargs["next_batch_index"]))
            return super().advance_claimed_group_accumulator(**kwargs)

    cursor = _cursor(2, 1)
    repository = Repository(
        [_page(_chunk(cursor, [{"key": "row"}], complete=True), complete=True)]
    )

    result = _handler(repository, projector)(_claim(), _Context())

    assert result.next_state is JobState.RETRY_WAIT
    assert not any(call[0] == "advance" for call in repository.calls)
    assert reason_facts.closed


def test_handler_closes_yielded_item_when_projection_stream_raises():
    yielded_streams = []

    class Accumulator(_TestAccumulator):
        def finalize(self, _facts):
            reason_facts = _TrackingReasonFacts((_reason_fact(0),))
            yielded_streams.append(reason_facts)
            yield _projected_item(
                {"item_key": "item-a"}, reason_facts=reason_facts
            )
            raise ValueError("projection stream failed")

    def projector(_rows):
        raise AssertionError("the accumulator path must own projection")

    projector.accumulator_type = Accumulator
    cursor = _cursor(2, 1)
    repository = _Repository(
        [_page(_chunk(cursor, [{"key": "row"}], complete=True), complete=True)]
    )

    with pytest.raises(ValueError, match="projection stream failed"):
        _handler(repository, projector)(_claim(), _Context())

    assert len(yielded_streams) == 1
    assert yielded_streams[0].closed


def test_handler_retry_skips_completed_item_and_resumes_next_item():
    from music_app.services.problematic_projection_postgres import (
        ProblematicProjectionBuild,
        ProblematicProjectionStorageError,
    )

    created_streams = []

    class Accumulator(_TestAccumulator):
        def finalize(self, _facts):
            for item_key, fact_count in (("item-a", 205), ("item-b", 2)):
                reason_facts = _TrackingReasonFacts(
                    _reason_fact(index, item_key=item_key)
                    for index in range(fact_count)
                )
                created_streams.append(reason_facts)
                yield _projected_item(
                    {"item_key": item_key}, reason_facts=reason_facts
                )

    def projector(_rows):
        raise AssertionError("the accumulator path must own projection")

    projector.accumulator_type = Accumulator

    class Repository(_Repository):
        fail_second_item = True

        def stage_claimed_reason_facts(self, **kwargs):
            facts = tuple(kwargs["facts"])
            super().stage_claimed_reason_facts(**{**kwargs, "facts": facts})
            if self.fail_second_item and facts[0].item_key == "item-b":
                raise ProblematicProjectionStorageError("second item failed")

        def advance_claimed_group_accumulator(self, **kwargs):
            self.calls.append(("advance", kwargs["next_batch_index"]))
            return super().advance_claimed_group_accumulator(**kwargs)

    cursor = _cursor(2, 1)
    group_key = ("album", 2)
    repository = Repository(
        [_page(_chunk(cursor, [{"key": "row"}], complete=True), complete=True)]
    )

    first_result = _handler(repository, projector)(_claim(), _Context())

    assert first_result.next_state is JobState.RETRY_WAIT
    assert repository.accumulators[group_key].next_batch_index == 1
    assert all(stream.closed for stream in created_streams)

    repository.calls.clear()
    repository.fail_second_item = False
    repository.prepared_build = ProblematicProjectionBuild(
        9, 12, 3, "revision-a", cursor, group_key
    )
    repository.pages.append(_page(complete=True))

    second_result = _handler(repository, projector)(_claim(attempt=2), _Context())

    assert second_result.next_state is JobState.SUCCEEDED
    staged_items = [
        item["item_key"]
        for call in repository.calls
        if call[0] == "stage_item"
        for item in call[5]
    ]
    assert staged_items == ["item-b"]
    staged_reason_items = [
        fact.item_key
        for call in repository.calls
        if call[0] == "stage_reason"
        for fact in call[5]
    ]
    assert staged_reason_items == ["item-b", "item-b"]
    assert repository.accumulators[group_key].next_batch_index == 2
    assert all(stream.closed for stream in created_streams)


def test_handler_spills_and_resumes_one_oversized_group_without_materializing_it():
    from music_app.jobs.problematic_projection_handlers import (
        PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT,
        PROBLEMATIC_PROJECTION_STAGE_BATCH_LIMIT,
    )

    first_rows = [
        {"key": f"row-{index}"}
        for index in range(PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT)
    ]
    second_rows = [
        {"key": f"row-{index}"}
        for index in range(
            PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT,
            PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT + 3,
        )
    ]
    first_cursor = _cursor(2, PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT)
    final_cursor = _cursor(2, PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT + 3)
    repository = _Repository([
        _page(_chunk(first_cursor, first_rows, complete=False), complete=False),
        _page(_chunk(final_cursor, second_rows, complete=True), complete=True),
    ])

    class StreamingAccumulator(_TestAccumulator):
        def finalize(self, facts):
            for item in super().finalize(facts):
                repository.projected_count += 1
                yield item

    def streaming_projector(_rows):
        raise AssertionError("the accumulator path must own projection")

    streaming_projector.accumulator_type = StreamingAccumulator

    result = _handler(repository, streaming_projector)(_claim(), _Context())

    assert result.next_state is JobState.SUCCEEDED
    loads = [call for call in repository.calls if call[0] == "load"]
    assert [call[4] for call in loads] == [None, first_cursor]
    assert all(call[6] == PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT for call in loads)
    assert len([call for call in repository.calls if call[0] == "stage_source"]) == 2
    assert len([call for call in repository.calls if call[0] == "iter_source"]) == 2
    item_stages = [call for call in repository.calls if call[0] == "stage_item"]
    assert all(len(call[5]) == 1 for call in item_stages)
    assert sum(len(call[5]) for call in item_stages) == len(first_rows) + len(second_rows)
    assert item_stages[0][7] == 1
    assert [call[4] for call in repository.calls if call[0] == "complete_group"] == [("album", 2)]


def test_production_projector_checkpoints_oversized_group_without_eager_materialization():
    """The real handler must checkpoint bounded projection work, not only source rows."""
    import inspect

    from music_app.jobs.problematic_projection_handlers import (
        build_problematic_projection_handler,
    )
    from music_app.services.problematic_files_projection import (
        project_problematic_files,
    )

    handler_source = inspect.getsource(build_problematic_projection_handler)
    projector_source = inspect.getsource(project_problematic_files)

    assert "project_group(rows)" not in handler_source
    assert "load_claimed_group_accumulator" in handler_source
    assert "advance_claimed_group_accumulator" in handler_source
    assert "list(rows)" not in projector_source


def test_production_projector_resumes_mid_group_from_persisted_accumulator():
    """A retry resumes after the last projected stage row and output batch."""
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
    )

    row = {
        "album_id": 11,
        "album_key": "album-a",
        "album_title": "Album A",
        "artist_name": "Artist A",
        "track_key": "track-a",
        "track_title": "Track A",
        "track_number": 1,
        "disc_number": 1,
        "duration_seconds": 180,
        "file_private_path": r"D:\Music\Album A\01.flac",
        "file_entry": {
            "path": r"D:\Music\Album A\01.flac",
            "album": "Album A",
            "album_artist": "Artist A",
            "artist": "Artist A",
            "title": "Track A",
            "year": 1988,
            "track_number": 1,
            "disc_number": 1,
        },
    }
    initial = ProblematicGroupAccumulator()
    persisted_facts = list(initial.consume(((1, row),)))
    checkpoint = initial.checkpoint()
    resumed = ProblematicGroupAccumulator.from_checkpoint(checkpoint)
    persisted_facts.extend(
        resumed.consume(
            (
                (
                    2,
                    {
                        **row,
                        "source_child_kind": "featured_artist",
                        "featured_artist_name": "Guest",
                    },
                ),
            )
        )
    )

    assert checkpoint.after_stage_id == 1
    assert checkpoint.next_batch_index == 0
    assert checkpoint.row_count == 1
    assert {fact_kind for _, fact_kind, _ in persisted_facts} >= {
        "row",
        "album_value",
        "artist_value",
        "raw_year",
        "valid_year",
        "track_number",
        "featured_artist",
    }
    assert resumed.checkpoint().after_stage_id == 2
    assert resumed.checkpoint().row_count == 2


def test_production_handler_publishes_healthy_exception_clear_without_staging_item():
    from music_app.services.problematic_files_projection import (
        project_problematic_files,
    )

    row = {
        "album_id": 11,
        "album_key": "healthy-album",
        "album_title": "Healthy Album",
        "album_release_year": 2026,
        "album_cover_path": r"D:\Music\Healthy Album\cover.jpg",
        "artist_name": "Healthy Artist",
        "track_key": "healthy-track",
        "track_title": "Healthy Track",
        "track_number": 1,
        "disc_number": 1,
        "duration_seconds": 180,
        "file_private_path": r"D:\Music\Healthy Album\01.flac",
        "file_entry": {
            "path": r"D:\Music\Healthy Album\01.flac",
            "album": "Healthy Album",
            "album_artist": "Healthy Artist",
            "artist": "Healthy Artist",
            "title": "Healthy Track",
            "year": 2026,
            "track_number": 1,
            "disc_number": 1,
            "exception_type": "Non-album rarity",
        },
        "exception_override_present": True,
        "exception_type": "",
    }
    cursor = _cursor(11, 1)
    repository = _Repository([
        _page(_chunk(cursor, (row,), complete=True), complete=True),
    ])

    result = _handler(repository, project_problematic_files)(_claim(), _Context())

    assert result.next_state is JobState.SUCCEEDED
    staged = [call for call in repository.calls if call[0] == "stage_item"]
    assert not staged, staged[0][5][0]["problem_reasons"]
    assert [call[0] for call in repository.calls].count("publish") == 1
    assert not [call for call in repository.calls if call[0] == "terminal_failure"]


def test_production_handler_has_no_unreachable_legacy_projection_fallback():
    import inspect

    from music_app.jobs.problematic_projection_handlers import (
        build_problematic_projection_handler,
    )

    source = inspect.getsource(build_problematic_projection_handler)

    assert "hasattr(repository, \"load_claimed_group_accumulator\")" not in source
    assert "iter_claimed_source_group_rows" not in source
    assert "project_group(source_rows)" not in source


def test_production_handler_has_exactly_one_accumulator_path():
    import inspect

    from music_app.jobs.problematic_projection_handlers import (
        build_problematic_projection_handler,
    )

    source = inspect.getsource(build_problematic_projection_handler)

    assert source.count("load_claimed_group_accumulator(") == 1
    assert source.count("iter_claimed_source_group_entries(") == 1
    assert source.count("advance_claimed_group_accumulator(") == 1
    assert source.count("complete_claimed_source_group(") == 1


def test_handler_finishes_same_build_after_publish_commit_reply_is_lost():
    from music_app.services.problematic_projection_postgres import (
        ProblematicProjectionStorageError,
    )

    class ReplayRepository(_Repository):
        def __init__(self):
            super().__init__([_page(complete=True), _page(complete=True)])
            self.committed_revision = None

        def publish_claimed_snapshot(self, *, claim, build, now):
            self.calls.append(("publish", claim.attempt, build.revision, now))
            if self.committed_revision is None:
                self.committed_revision = build.revision
                raise ProblematicProjectionStorageError("publish reply lost")
            return self.committed_revision == build.revision

    repository = ReplayRepository()
    handler = _handler(repository, _stream_items)

    first = handler(_claim(attempt=1), _Context())
    replay = handler(_claim(attempt=2), _Context())

    assert first.next_state is JobState.RETRY_WAIT
    assert replay.next_state is JobState.SUCCEEDED
    assert repository.committed_revision == "revision-a"
    assert [call[2] for call in repository.calls if call[0] == "publish"] == [
        "revision-a",
        "revision-a",
    ]


def test_incremental_projector_checkpoints_before_loading_next_source_page():
    from music_app.jobs.problematic_projection_handlers import (
        PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT,
    )
    from music_app.services.problematic_files_projection import (
        project_problematic_files,
    )
    first_rows = [
        {"key": f"row-{index}"}
        for index in range(PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT)
    ]
    final_rows = [{"key": "row-final"}]
    first_cursor = _cursor(21, PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT)
    final_cursor = _cursor(21, PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT + 1)

    class CheckpointingRepository(_Repository):
        def __init__(self):
            super().__init__([
                _page(_chunk(first_cursor, first_rows, complete=False), complete=False),
                _page(_chunk(final_cursor, final_rows, complete=True), complete=True),
            ])
            self.fact_checkpoints = 0

        def load_claimed_source_page(self, **kwargs):
            if len(self.pages) == 1:
                assert self.fact_checkpoints == 2, (
                    "the first bounded source chunk was not durably projected "
                    "before the next source page"
                )
            return super().load_claimed_source_page(**kwargs)

        def checkpoint_claimed_group_facts(self, **kwargs):
            entries = tuple(kwargs["entries"])
            assert 0 < len(entries) <= PROBLEMATIC_PROJECTION_SOURCE_CHILD_LIMIT
            assert all(entry[2].get("projection_id") for entry in entries)
            assert all(
                entry[2].get("semantic_child_identity") for entry in entries
            )
            self.fact_checkpoints += 1
            return super().checkpoint_claimed_group_facts(
                **{**kwargs, "entries": entries}
            )

    repository = CheckpointingRepository()
    result = _handler(repository, project_problematic_files)(_claim(), _Context())

    assert result.next_state is JobState.SUCCEEDED
    assert repository.fact_checkpoints == 3
    assert len([call for call in repository.calls if call[0] == "load"]) == 2
    assert len([call for call in repository.calls if call[0] == "complete_group"]) == 1


def test_handler_uses_repository_owned_source_cursor_only():
    first_cursor = _cursor(22, 1)
    final_cursor = _cursor(22, 2)

    class ServerCursorRepository(_Repository):
        def __init__(self):
            super().__init__([
                _page(_chunk(first_cursor, [{"key": "one"}], complete=False), complete=False),
                _page(_chunk(final_cursor, [{"key": "two"}], complete=True), complete=True),
            ])
            self.server_cursor = None
            self.loaded_after = []

        def load_claimed_source_page(
            self, *, claim, build, limit, child_limit, now
        ):
            self.loaded_after.append(self.server_cursor)
            return self.pages.pop(0)

        def stage_claimed_source_chunk(self, **kwargs):
            super().stage_claimed_source_chunk(**kwargs)
            self.server_cursor = kwargs["source_cursor"]

    repository = ServerCursorRepository()
    result = _handler(repository, _stream_items)(_claim(), _Context())

    assert result.next_state is JobState.SUCCEEDED
    assert repository.loaded_after == [None, first_cursor]
    assert len(repository.loaded_after) == 2
    assert len([call for call in repository.calls if call[0] == "complete_group"]) == 1


def test_handler_uses_typed_repository_cursor_without_python_lexical_ordering():
    repository = _Repository(
        [
            _page(
                _chunk(_cursor(10, 1), [{"key": "ten"}], complete=True),
                complete=True,
            )
        ]
    )

    result = _handler(repository, _stream_items)(_claim(), _Context())

    assert result.next_state is JobState.SUCCEEDED
    completed_group = next(
        call for call in repository.calls if call[0] == "complete_group"
    )
    assert completed_group[4] == ("album", 10)


def test_handler_resumes_partial_group_from_durable_child_cursor():
    from music_app.services.problematic_projection_postgres import (
        ProblematicProjectionBuild,
    )

    first_cursor = _cursor(11, 2)
    final_cursor = _cursor(11, 3)
    group_key = ("album", 11)
    repository = _Repository(
        [
            _page(
                _chunk(final_cursor, [{"key": "three"}], complete=True),
                complete=True,
            )
        ]
    )
    repository.prepared_build = ProblematicProjectionBuild(
        9,
        12,
        3,
        "revision-resumed",
        first_cursor,
        group_key,
    )
    repository.source_entries[group_key] = [
        (1, {"key": "one"}),
        (2, {"key": "two"}),
    ]
    repository.next_stage_id = 3
    repository.source_complete[group_key] = False

    result = _handler(repository, _stream_items)(_claim(attempt=2), _Context())

    assert result.next_state is JobState.SUCCEEDED
    load = next(call for call in repository.calls if call[0] == "load")
    assert load[4] == first_cursor
    staged = [call for call in repository.calls if call[0] == "stage_item"]
    assert [item["key"] for call in staged for item in call[5]] == [
        "one",
        "two",
        "three",
    ]


def test_handler_drains_completed_active_group_before_loading_another_page():
    from music_app.services.problematic_projection_postgres import (
        ProblematicProjectionBuild,
        ProblematicProjectionGroupAccumulator,
        ProblematicProjectionSourcePage,
    )

    group_key = ("album", 11)
    final_cursor = _cursor(11, 3, child_kind="file")

    class Accumulator:
        @classmethod
        def from_checkpoint(cls, checkpoint):
            assert checkpoint.after_stage_id == 1
            return cls()

        def consume(self, entries):
            assert tuple(entries) == ()
            return ()

        def finalize(self, facts):
            assert tuple(facts) == ((1, "row", {"projection_id": "item-a"}),)
            yield _projected_item({"item_key": "item-a"})

    def projector(_rows):
        raise AssertionError("active staged group must be drained without reloading")

    projector.accumulator_type = Accumulator

    class DrainRepository(_Repository):
        def __init__(self):
            super().__init__()
            self.prepared_build = ProblematicProjectionBuild(
                9, 12, 3, "revision-resumed", final_cursor, group_key
            )
            self.accumulator = ProblematicProjectionGroupAccumulator(1, 0, 1)
            self.group_completed = False

        def load_claimed_source_page(self, **kwargs):
            assert self.group_completed, "active group was not drained first"
            return ProblematicProjectionSourcePage((), True)

        def load_claimed_group_accumulator(self, **_kwargs):
            return self.accumulator

        def iter_claimed_source_group_entries(self, **kwargs):
            assert kwargs["after_stage_id"] == 1
            return iter(())

        def iter_claimed_group_facts(self, **_kwargs):
            yield 1, "row", {"projection_id": "item-a"}

        def advance_claimed_group_accumulator(
            self, *, after_stage_id, next_batch_index, row_count, **_kwargs
        ):
            self.accumulator = ProblematicProjectionGroupAccumulator(
                after_stage_id, next_batch_index, row_count
            )
            return self.accumulator

        def complete_claimed_source_group(self, **kwargs):
            self.group_completed = True
            super().complete_claimed_source_group(**kwargs)

    repository = DrainRepository()

    result = _handler(repository, projector)(_claim(attempt=2), _Context())

    assert result.next_state is JobState.SUCCEEDED
    assert repository.group_completed
    assert [call[0] for call in repository.calls if call[0] == "stage_item"] == [
        "stage_item"
    ]
    assert [call[0] for call in repository.calls if call[0] == "publish"] == [
        "publish"
    ]


def test_handler_claim_shape_passes_the_real_server_owned_validator():
    from music_app.services.jobs.authorization import (
        build_problematic_files_projection_resource_validator,
    )

    decision = build_problematic_files_projection_resource_validator()(
        _claim(), _Context(), NOW
    )

    assert decision == AuthorizationDecision(
        True, "problematic_projection_scope_current"
    )


def test_handler_reauthorizes_and_revalidates_fences_before_every_staged_batch():
    from music_app.jobs.problematic_projection_handlers import (
        PROBLEMATIC_PROJECTION_STAGE_BATCH_LIMIT,
    )

    row_count = PROBLEMATIC_PROJECTION_STAGE_BATCH_LIMIT * 2 + 1
    repository = _Repository(
        [
            _page(
                _chunk(
                    _cursor(3, 1),
                    [{"key": "source"}],
                    complete=True,
                ),
                complete=True,
            )
        ]
    )
    context = _Context()

    class ExpandedAccumulator(_TestAccumulator):
        def finalize(self, facts):
            assert tuple(facts)
            for index in range(row_count):
                yield _projected_item({"key": str(index)})

    def expanded_projector(_rows):
        raise AssertionError("the accumulator path must own projection")

    expanded_projector.accumulator_type = ExpandedAccumulator

    result = _handler(repository, expanded_projector)(_claim(), context)

    assert result.next_state is JobState.SUCCEEDED
    stage_indexes = [
        index
        for index, call in enumerate(repository.calls)
        if call[0] == "stage_item"
    ]
    assert len(stage_indexes) == row_count
    assert all(repository.calls[index - 1][0] == "validate" for index in stage_indexes)
    assert context.reauthorizations >= len(stage_indexes) + 2


def test_handler_rejects_a_source_page_larger_than_the_bounded_group_limit():
    from music_app.jobs.problematic_projection_handlers import (
        PROBLEMATIC_PROJECTION_SOURCE_PAGE_LIMIT,
    )

    chunks = [
        _chunk(_cursor(index, 1), [{"key": str(index)}], complete=True)
        for index in range(1, PROBLEMATIC_PROJECTION_SOURCE_PAGE_LIMIT + 2)
    ]
    repository = _Repository([_page(*chunks, complete=True)])

    result = _handler(repository, _stream_items)(_claim(attempt=3), _Context())

    assert result.next_state is JobState.FAILED
    assert result.reason_code == "problematic_projection_integrity_failed"
    assert not any(
        call[0] in {"stage_source", "stage_item", "publish"}
        for call in repository.calls
    )


@pytest.mark.parametrize(
    ("context_attribute", "reason_code"),
    [
        ("cancel_requested", "problematic_projection_canceled"),
        ("lease_active", "problematic_projection_lease_lost"),
    ],
)
def test_handler_stops_between_partial_source_pages_without_publication(
    context_attribute, reason_code
):
    first_cursor = _cursor(20, 1)
    final_cursor = _cursor(20, 2)
    repository = _Repository(
        [
            _page(
                _chunk(first_cursor, [{"key": "one"}], complete=False),
                complete=False,
            ),
            _page(
                _chunk(final_cursor, [{"key": "two"}], complete=True),
                complete=True,
            ),
        ]
    )
    context = _Context()

    def interrupt_after_partial_stage():
        setattr(context, context_attribute, context_attribute != "lease_active")

    repository.after_source_stage = interrupt_after_partial_stage

    result = _handler(repository, _stream_items)(_claim(), context)

    assert result.next_state is JobState.CANCELED
    assert result.reason_code == reason_code
    assert len([call for call in repository.calls if call[0] == "load"]) == 1
    assert len([call for call in repository.calls if call[0] == "stage_source"]) == 1
    assert not any(
        call[0] in {"stage_item", "complete_group", "publish"}
        for call in repository.calls
    )
    cleanup_calls = [call for call in repository.calls if call[0] == "cancel_build"]
    if context_attribute == "cancel_requested":
        assert len(cleanup_calls) == 1
        assert cleanup_calls[0][2] == "revision-a"
        assert cleanup_calls[0][3] == reason_code
    else:
        assert cleanup_calls == []


def test_handler_does_not_impersonate_a_lost_or_stale_claim_for_cleanup():
    for context in (
        _Context(lease_active=False),
        _Context(allowed=False),
    ):
        repository = _Repository(
            [
                _page(
                    _chunk(_cursor(21, 1), [{"key": "one"}], complete=True),
                    complete=True,
                )
            ]
        )

        result = _handler(repository, _stream_items)(_claim(), context)

        assert result.next_state is JobState.CANCELED
        assert not any(call[0] == "cancel_build" for call in repository.calls)


@pytest.mark.parametrize(
    ("cancel_requested", "lease_active", "allowed", "reason_code"),
    [
        (True, True, True, "problematic_projection_canceled"),
        (False, False, True, "problematic_projection_lease_lost"),
        (False, True, False, "problematic_projection_scope_stale"),
    ],
)
def test_handler_stops_before_storage_when_claim_is_not_active(
    cancel_requested, lease_active, allowed, reason_code
):
    repository = _Repository()
    context = _Context(
        cancel_requested=cancel_requested,
        lease_active=lease_active,
        allowed=allowed,
    )

    result = _handler(repository, _stream_items)(_claim(), context)

    assert result.next_state is JobState.CANCELED
    assert result.reason_code == reason_code
    assert repository.calls == []


def test_handler_stops_when_generation_or_epoch_fence_is_lost():
    repository = _Repository(
        [
            _page(
                _chunk(_cursor(4, 1), [{"key": "one"}], complete=True),
                complete=True,
            )
        ]
    )

    class FenceLosingAccumulator(_TestAccumulator):
        def consume(self, rows):
            repository.current = False
            return super().consume(rows)

    def lose_fence(_rows):
        raise AssertionError("the accumulator path must own projection")

    lose_fence.accumulator_type = FenceLosingAccumulator

    result = _handler(repository, lose_fence)(_claim(), _Context())

    assert result.next_state is JobState.CANCELED
    assert result.reason_code == "problematic_projection_stale"
    assert not any(call[0] == "stage_item" for call in repository.calls)


def test_typed_storage_failure_retries_then_records_only_exact_exhausted_claim():
    from music_app.services.problematic_projection_postgres import ProblematicProjectionStorageError

    retry_repository = _Repository()
    retry_repository.raise_from_load = ProblematicProjectionStorageError("unavailable")
    retry_result = _handler(retry_repository, _stream_items)(_claim(attempt=1), _Context())
    assert retry_result.next_state is JobState.RETRY_WAIT
    assert not any(call[0] == "terminal_failure" for call in retry_repository.calls)

    failed_repository = _Repository()
    failed_repository.raise_from_load = ProblematicProjectionStorageError("unavailable")
    claim = _claim(attempt=3)
    failed_result = _handler(failed_repository, _stream_items)(claim, _Context())
    assert failed_result.next_state is JobState.FAILED
    failures = [call for call in failed_repository.calls if call[0] == "terminal_failure"]
    assert len(failures) == 1
    assert failures[0][1:4] == (
        claim.job_id,
        "revision-a",
        "problematic_projection_storage_unavailable",
    )


def test_projector_exception_propagates_without_storage_retry_or_terminal_record():
    repository = _Repository(
        [
            _page(
                _chunk(_cursor(5, 1), [{"key": "one"}], complete=True),
                complete=True,
            )
        ]
    )

    class BrokenAccumulator(_TestAccumulator):
        def consume(self, _rows):
            raise ValueError("projector defect")

    def broken_projector(_rows):
        raise AssertionError("the accumulator path must own projection")

    broken_projector.accumulator_type = BrokenAccumulator

    with pytest.raises(ValueError, match="projector defect"):
        _handler(repository, broken_projector)(_claim(attempt=3), _Context())
    assert not any(call[0] == "terminal_failure" for call in repository.calls)


def test_bounded_fact_overflow_records_integrity_failure():
    from music_app.services.problematic_files_projection import (
        ProblematicProjectionFactLimitError,
    )

    repository = _Repository(
        [
            _page(
                _chunk(_cursor(5, 1), [{"key": "one"}], complete=True),
                complete=True,
            )
        ]
    )

    class OverflowAccumulator(_TestAccumulator):
        def consume(self, _rows):
            raise ProblematicProjectionFactLimitError("fact overflow")

    def overflow_projector(_rows):
        raise AssertionError("the accumulator path must own projection")

    overflow_projector.accumulator_type = OverflowAccumulator

    result = _handler(repository, overflow_projector)(
        _claim(attempt=3), _Context()
    )

    assert result.next_state is JobState.FAILED
    assert result.reason_code == "problematic_projection_integrity_failed"
    assert len(
        [call for call in repository.calls if call[0] == "terminal_failure"]
    ) == 1


def test_typed_integrity_failure_records_once_and_never_publishes():
    from music_app.services.problematic_projection_postgres import (
        ProblematicProjectionIntegrityError,
    )

    repository = _Repository()
    repository.raise_from_load = ProblematicProjectionIntegrityError("bad cursor")
    result = _handler(repository, _stream_items)(_claim(attempt=3), _Context())

    assert result.next_state is JobState.FAILED
    assert result.reason_code == "problematic_projection_integrity_failed"
    assert len([call for call in repository.calls if call[0] == "terminal_failure"]) == 1
    assert not any(call[0] == "publish" for call in repository.calls)


def test_final_prepare_failure_records_terminal_recovery_without_build():
    from music_app.services.problematic_projection_postgres import (
        ProblematicProjectionIntegrityError,
    )

    repository = _Repository()
    repository.raise_from_prepare = ProblematicProjectionIntegrityError(
        "prepare rejected"
    )
    claim = _claim(attempt=3)

    result = _handler(repository, _stream_items)(claim, _Context())

    assert result.next_state is JobState.FAILED
    assert result.reason_code == "problematic_projection_integrity_failed"
    assert [call for call in repository.calls if call[0] == "terminal_failure"] == [
        (
            "terminal_failure",
            claim.job_id,
            None,
            "problematic_projection_integrity_failed",
            NOW,
        )
    ]


def test_terminal_record_failure_is_attempted_once_and_propagates():
    from music_app.services.problematic_projection_postgres import ProblematicProjectionStorageError

    repository = _Repository()
    repository.raise_from_load = ProblematicProjectionStorageError("unavailable")
    repository.raise_from_terminal = RuntimeError("terminal unavailable")
    with pytest.raises(RuntimeError, match="terminal unavailable"):
        _handler(repository, _stream_items)(_claim(attempt=3), _Context())
    assert len([call for call in repository.calls if call[0] == "terminal_failure"]) == 1


def test_handler_rejects_stale_publication_without_reporting_success():
    repository = _Repository([_page(complete=True)])
    repository.publish_result = False
    result = _handler(repository, _stream_items)(_claim(), _Context())
    assert result.next_state is JobState.CANCELED
    assert result.reason_code == "problematic_projection_stale"
