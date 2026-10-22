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
    assert "insert into app.generated_preview_relocation_items" in sql
    assert "from app.generated_preview_inventory inventory" in sql
    assert "requested_mode = 'custom'" in sql
    assert "mode = 'custom'" in sql
    assert "select count(*) from app.generated_preview_inventory" in sql
    assert "select coalesce(sum(byte_count), 0)" in sql
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
        album_preview_path="D:/Music/Album/.album-haven/cover_variants/aa/aabb.jpg",
        managed_relative_path="v1/cover_variants/aa/aabb.jpg",
        byte_count=123,
        sha256="a" * 64,
    )

    sql, params = connection.calls[0]
    assert "insert into app.generated_preview_inventory" in sql
    assert "on conflict (managed_relative_path) do update" in sql
    assert params["byte_count"] == 123
    assert params["sha256"] == "a" * 64
    assert record["id"] == 9


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

    sql, _params = connection.calls[0]
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
    assert "status = 'failed'" in retry_connection.calls[0][0]


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
