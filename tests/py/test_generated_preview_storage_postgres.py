from __future__ import annotations

from contextlib import contextmanager, nullcontext
from uuid import UUID

import pytest

from music_app.services.generated_preview_storage_postgres import (
    PostgresGeneratedPreviewStorageRepository,
    PreviewStorageConflict,
    serialize_preview_storage,
)


DATABASE_URL = "postgresql://album_haven_app@localhost/album_haven_test"


class FakeCursor:
    def __init__(self, *, row=None, rows=None, rowcount=1):
        self._row = row
        self._rows = list(rows or [])
        self.rowcount = rowcount

    def fetchone(self):
        return self._row

    def fetchall(self):
        return list(self._rows)


class FakeConnection:
    def __init__(self, cursors):
        self.cursors = list(cursors)
        self.calls = []
        self.events = []

    def execute(self, sql, params=None):
        self.calls.append((" ".join(sql.lower().split()), dict(params or {})))
        return self.cursors.pop(0)

    @contextmanager
    def transaction(self):
        self.events.append("transaction-enter")
        try:
            yield
        except BaseException:
            self.events.append("transaction-rollback")
            raise
        self.events.append("transaction-commit")


def repository_for(connection):
    return PostgresGeneratedPreviewStorageRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL},
        connect=lambda database_url: (
            nullcontext(connection)
            if database_url == DATABASE_URL
            else pytest.fail(f"unexpected database URL: {database_url}")
        ),
    )


def storage_row(**overrides):
    row = {
        "storage_key": 1,
        "mode": "album_folders",
        "active_root": None,
        "requested_mode": None,
        "requested_root": None,
        "operation_id": None,
        "operation_state": "idle",
        "revision": 0,
        "total_count": 0,
        "completed_count": 0,
        "failed_count": 0,
        "total_bytes": 0,
        "completed_bytes": 0,
        "cancel_requested": False,
        "failure_summary": [],
    }
    row.update(overrides)
    return row


def test_load_returns_the_singleton_storage_state():
    connection = FakeConnection([FakeCursor(row=storage_row())])

    state = repository_for(connection).load()

    assert state["mode"] == "album_folders"
    assert state["revision"] == 0
    assert "where storage_key = 1" in connection.calls[0][0]
    assert "inventory_count" in connection.calls[0][0]
    assert "inventory_bytes" in connection.calls[0][0]
    assert connection.calls[0][0].count("from app.generated_preview_inventory") == 1


def test_request_location_is_revision_guarded_and_records_requested_target():
    connection = FakeConnection(
        [FakeCursor(row=storage_row(requested_mode="custom", requested_root="D:/previews", revision=4))]
    )

    state = repository_for(connection).request_location(
        mode="custom",
        root="D:/previews",
        expected_revision=3,
    )

    sql, params = connection.calls[0]
    assert "revision = revision + 1" in sql
    assert "revision = %(expected_revision)s" in sql
    assert "requested_mode is null" in sql
    assert "operation_state <> 'canceled'" in sql
    assert params == {
        "requested_mode": "custom",
        "requested_root": "D:/previews",
        "expected_revision": 3,
    }
    assert state["revision"] == 4
    assert connection.events == ["transaction-enter", "transaction-commit"]


def test_request_location_raises_conflict_when_revision_is_stale():
    connection = FakeConnection([FakeCursor(row=None, rowcount=0)])

    with pytest.raises(PreviewStorageConflict):
        repository_for(connection).request_location(
            mode="album_folders",
            root=None,
            expected_revision=8,
        )


def test_begin_operation_has_identity_and_bounded_counters():
    operation_id = "10e2fc89-439a-4f74-a508-97596cf20771"
    connection = FakeConnection(
        [FakeCursor(row=storage_row(operation_id=operation_id, operation_state="queued", total_count=12, total_bytes=44))]
    )

    state = repository_for(connection).begin_operation(
        operation_id=operation_id,
    )

    UUID(str(state["operation_id"]))
    sql, params = connection.calls[0]
    assert "operation_state = 'queued'" in sql
    assert "total_count = 0" in sql
    assert "total_bytes = 0" in sql
    assert params == {"operation_id": operation_id}


def test_record_inventory_upserts_only_published_preview_metadata():
    connection = FakeConnection(
        [
            FakeCursor(
                row={
                    "id": 9,
                    "album_preview_path": "D:/Music/Album/.album-haven/cover_variants/aa/aabb.jpg",
                    "managed_relative_path": "v1/cover_variants/aa/aabb.jpg",
                    "byte_count": 123,
                    "sha256": "a" * 64,
                }
            )
        ]
    )

    record = repository_for(connection).record_inventory(
        current_path="D:/Music/Album/.album-haven/cover_variants/aa/aabb.jpg",
        album_preview_path="D:/Music/Album/.album-haven/cover_variants/aa/aabb.jpg",
        managed_relative_path="v1/cover_variants/aa/aabb.jpg",
        byte_count=123,
        sha256="a" * 64,
    )

    sql, params = connection.calls[0]
    assert "insert into app.generated_preview_inventory" in sql
    assert "on conflict (managed_relative_path) do update" in sql
    assert "current_path = excluded.current_path" in sql
    assert "insert into app.generated_preview_relocation_items" in sql
    assert "for update" in sql
    assert "reopened as" in sql
    assert "status = 'pending'" in sql
    assert "reconciliation_requested as" in sql
    assert "requested_mode = storage.mode" in sql
    assert "requested_root = storage.active_root" in sql
    assert "operation_id = gen_random_uuid()" in sql
    assert "operation_state = 'queued'" in sql
    assert "total_count = total_count +" in sql
    assert params["current_path"].endswith("aabb.jpg")
    assert params["byte_count"] == 123
    assert params["sha256"] == "a" * 64
    assert record["id"] == 9


def test_operation_lock_holds_one_database_advisory_lock_for_context():
    connection = FakeConnection(
        [
            FakeCursor(row={"acquired": True}),
            FakeCursor(row={"unlocked": True}),
        ]
    )

    with repository_for(connection).operation_lock() as acquired:
        assert acquired is True
        assert len(connection.calls) == 1

    assert "pg_try_advisory_lock" in connection.calls[0][0]
    assert "pg_advisory_unlock" in connection.calls[1][0]


def test_stage_inventory_adds_only_missing_items_to_active_operation():
    operation_id = "10e2fc89-439a-4f74-a508-97596cf20771"
    connection = FakeConnection([FakeCursor(row={"staged_count": 3})])

    staged = repository_for(connection).stage_inventory(operation_id=operation_id)

    sql, params = connection.calls[0]
    assert "on conflict (operation_id, inventory_id) do nothing" in sql
    assert "for update" in sql
    assert "total_count = total_count +" in sql
    assert params == {"operation_id": operation_id}
    assert staged == 3


def test_cleanup_failure_reopens_completed_item_and_counters():
    operation_id = "10e2fc89-439a-4f74-a508-97596cf20771"
    connection = FakeConnection([FakeCursor(row={"id": 7})])

    repository_for(connection).fail_item_cleanup(
        operation_id=operation_id,
        item_id=7,
        error="source is locked",
    )

    sql, params = connection.calls[0]
    assert "set status = 'failed'" in sql
    assert "completed_count = completed_count - 1" in sql
    assert "completed_bytes = completed_bytes - finished.actual_bytes" in sql
    assert params["last_error"] == "source is locked"


def test_claim_batch_uses_skip_locked_and_returns_item_checkpoints():
    connection = FakeConnection(
        [
            FakeCursor(
                rows=[
                    {
                        "id": 7,
                        "inventory_id": 4,
                        "source_path": "D:/album/.album-haven/cover_variants/aa/aabb.webp",
                        "target_path": "C:/previews/v1/cover_variants/aa/aabb.webp",
                        "expected_bytes": 123,
                        "expected_sha256": "a" * 64,
                        "status": "running",
                    }
                ]
            )
        ]
    )

    items = repository_for(connection).claim_batch(
        operation_id="10e2fc89-439a-4f74-a508-97596cf20771",
        limit=10,
    )

    sql, params = connection.calls[0]
    assert "for update skip locked" in sql
    assert "status = 'running'" in sql
    assert "operation_state = 'running'" in sql
    assert params["limit"] == 10
    assert items[0]["expected_sha256"] == "a" * 64


def test_recover_interrupted_items_returns_claims_to_pending():
    operation_id = "10e2fc89-439a-4f74-a508-97596cf20771"
    connection = FakeConnection([FakeCursor(rowcount=10)])

    recovered = repository_for(connection).recover_interrupted_items(
        operation_id=operation_id,
    )

    sql, params = connection.calls[0]
    assert "update app.generated_preview_relocation_items" in sql
    assert "set status = 'pending'" in sql
    assert "status = 'running'" in sql
    assert params == {"operation_id": operation_id}
    assert recovered == 10


@pytest.mark.parametrize("status", ["completed", "failed", "skipped"])
def test_complete_item_records_one_terminal_checkpoint(status):
    connection = FakeConnection([FakeCursor(row={"id": 7})])

    repository_for(connection).complete_item(
        operation_id="10e2fc89-439a-4f74-a508-97596cf20771",
        item_id=7,
        status=status,
        byte_count=123,
        sha256="a" * 64,
        error="copy failed" if status == "failed" else None,
    )

    sql, params = connection.calls[0]
    assert "update app.generated_preview_relocation_items" in sql
    assert "finished_at = now()" in sql
    assert params["status"] == status


def test_finish_operation_marks_pending_items_skipped_when_canceling():
    operation_id = "10e2fc89-439a-4f74-a508-97596cf20771"
    connection = FakeConnection(
        [
            FakeCursor(row={"storage_key": 1}),
            FakeCursor(
                row=storage_row(
                    operation_id=operation_id,
                    operation_state="canceled",
                    cancel_requested=True,
                )
            )
        ]
    )

    state = repository_for(connection).finish_operation(operation_id)

    lock_sql, _params = connection.calls[0]
    sql, _params = connection.calls[1]
    assert "for update" in lock_sql
    assert "status in ('pending', 'running')" in lock_sql
    assert "set status = 'skipped'" in sql
    assert "status = 'pending'" in sql
    assert "when cancel_requested then 'canceled'" in sql
    assert state["operation_state"] == "canceled"


def test_cancel_and_retry_are_idempotent_state_transitions():
    cancel_connection = FakeConnection(
        [FakeCursor(row=storage_row(operation_state="cancel_requested", cancel_requested=True))]
    )
    retry_connection = FakeConnection(
        [FakeCursor(row=storage_row(operation_state="queued", failed_count=0))]
    )

    canceled = repository_for(cancel_connection).cancel(
        "10e2fc89-439a-4f74-a508-97596cf20771"
    )
    retried = repository_for(retry_connection).retry_failed(
        "10e2fc89-439a-4f74-a508-97596cf20771"
    )

    assert canceled["cancel_requested"] is True
    assert retried["operation_state"] == "queued"
    assert "in ('queued', 'running', 'cancel_requested')" in cancel_connection.calls[0][0]
    assert "item.status in ('failed', 'skipped')" in retry_connection.calls[0][0]


def test_retry_resumes_canceled_items_before_another_destination_can_replace_them():
    operation_id = "10e2fc89-439a-4f74-a508-97596cf20771"
    connection = FakeConnection(
        [FakeCursor(row=storage_row(operation_id=operation_id, operation_state="queued"))]
    )

    state = repository_for(connection).retry_failed(operation_id)

    sql, _params = connection.calls[0]
    assert "item.status in ('failed', 'skipped')" in sql
    assert "operation_state in ('completed_with_failures', 'failed', 'canceled')" in sql
    assert state["operation_state"] == "queued"


def test_retry_can_finalize_canceled_operation_after_last_item_completed():
    operation_id = "10e2fc89-439a-4f74-a508-97596cf20771"
    connection = FakeConnection(
        [FakeCursor(row=storage_row(operation_id=operation_id, operation_state="queued"))]
    )

    repository_for(connection).retry_failed(operation_id)

    sql, _params = connection.calls[0]
    assert "or storage.operation_state = 'canceled'" in sql


def test_non_owner_serialization_never_exposes_server_paths():
    state = storage_row(
        active_root="C:/private/previews",
        requested_root="D:/private/previews",
    )

    public = serialize_preview_storage(state, include_paths=False)
    owner = serialize_preview_storage(state, include_paths=True)

    assert "active_root" not in public
    assert "requested_root" not in public
    assert owner["active_root"] == "C:/private/previews"
    assert owner["requested_root"] == "D:/private/previews"
