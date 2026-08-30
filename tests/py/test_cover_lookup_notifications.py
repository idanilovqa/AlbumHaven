from __future__ import annotations

import json

import pytest

from music_app.services.cover_lookup_tasks_postgres import (
    CoverLookupTasksPostgresAdapter,
    _task_row,
    _upsert_notification_sql,
)
from music_app.services.cover_lookup_notifications import (
    load_cover_lookup_notifications,
    save_cover_lookup_notifications,
)


def test_cover_lookup_notifications_load_uses_postgres_adapter_and_ignores_file(
    tmp_path,
    monkeypatch,
):
    config = {
        "DATA_DIR": tmp_path,
        "PERSISTENCE_BACKENDS": {"cover_lookup_tasks": "postgres"},
    }
    (tmp_path / "cover_lookup_notifications.json").write_text(
        json.dumps({"tasks": [{"id": "stale-file-task", "status": "completed"}]}),
        encoding="utf-8",
    )

    class FakeAdapter:
        def __init__(self, adapter_config):
            assert adapter_config is config

        def load_notifications(self):
            return [
                {"id": "postgres-task", "status": "completed"},
                {"id": "", "status": "failed"},
            ]

    monkeypatch.setattr(
        "music_app.services.cover_lookup_notifications.CoverLookupTasksPostgresAdapter",
        FakeAdapter,
    )
    monkeypatch.setattr(
        "music_app.services.cover_lookup_notifications.select_runtime_persistence_adapter",
        lambda seam_id, selected_config: type(
            "Selection",
            (),
            {
                "seam_id": seam_id,
                "requested_backend": "postgres",
                "effective_backend": "file",
                "fallback_reason": "",
            },
        )(),
    )

    assert load_cover_lookup_notifications(config) == [
        {"id": "postgres-task", "status": "completed"}
    ]


def test_cover_lookup_notifications_save_uses_postgres_adapter_and_leaves_file(
    tmp_path,
    monkeypatch,
):
    config = {
        "DATA_DIR": tmp_path,
        "PERSISTENCE_BACKENDS": {"cover_lookup_tasks": "postgres"},
    }
    notifications_path = tmp_path / "cover_lookup_notifications.json"
    notifications_path.write_text(
        json.dumps({"tasks": [{"id": "stale-file-task", "status": "completed"}]}),
        encoding="utf-8",
    )
    saved_tasks = []

    class FakeAdapter:
        def __init__(self, adapter_config):
            assert adapter_config is config

        def save_notifications(self, tasks):
            saved_tasks.extend(tasks)

    monkeypatch.setattr(
        "music_app.services.cover_lookup_notifications.CoverLookupTasksPostgresAdapter",
        FakeAdapter,
    )
    monkeypatch.setattr(
        "music_app.services.cover_lookup_notifications.select_runtime_persistence_adapter",
        lambda seam_id, selected_config: type(
            "Selection",
            (),
            {
                "seam_id": seam_id,
                "requested_backend": "postgres",
                "effective_backend": "file",
                "fallback_reason": "",
            },
        )(),
    )

    save_cover_lookup_notifications(
        config,
        [
            {"id": "postgres-task", "status": "completed"},
            {"id": "", "status": "failed"},
        ],
    )

    assert saved_tasks == [{"id": "postgres-task", "status": "completed"}]
    assert json.loads(notifications_path.read_text(encoding="utf-8")) == {
        "tasks": [{"id": "stale-file-task", "status": "completed"}]
    }


def test_postgres_cover_lookup_notification_upsert_uses_scoped_conflict_identity():
    sql = _upsert_notification_sql()

    assert "on conflict (library_id, (metadata->>'source_family'), task_key)" in sql
    assert "where library_id is not null" in sql
    assert "and metadata ? 'source_family'" in sql


def test_postgres_running_candidate_snapshot_does_not_synthesize_completion_from_creation():
    created_at = "2026-07-21T14:18:16.697629+00:00"

    row = _task_row(
        {
            "id": "running-candidate-task",
            "status": "running",
            "created_at": created_at,
            "finished_at": "",
            "notification_completed_at": "",
            "job_contract": {"job_kind": "candidate_lookup"},
        },
        source_index=0,
    )

    assert row["requested_at"] == created_at
    assert row["completed_at"] is None
    assert row["metadata"]["notification_completed_at"] is None


def test_postgres_running_save_snapshot_preserves_explicit_lookup_completion():
    completed_at = "2026-07-21T14:18:34.401339+00:00"

    row = _task_row(
        {
            "id": "running-save-task",
            "status": "running",
            "created_at": "2026-07-21T14:18:16.697629+00:00",
            "finished_at": completed_at,
            "notification_completed_at": completed_at,
            "job_contract": {"job_kind": "save_remote_selection"},
        },
        source_index=0,
    )

    assert row["completed_at"] == completed_at
    assert row["metadata"]["notification_completed_at"] == completed_at


class _FakeCursor:
    def __init__(self, rows=()):
        self._rows = list(rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _FakeTransaction:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        pass


class _LegacyNotificationConnection:
    def __init__(self, *, allow_delete: bool):
        self.allow_delete = allow_delete
        self.persisted_task_ids = {"legacy-metallica-kill-em-all"}
        self.operations = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        pass

    def transaction(self):
        return _FakeTransaction()

    def execute(self, sql, params=None):
        normalized_sql = " ".join(str(sql).lower().split())
        self.operations.append((normalized_sql, params))
        if "bootstrap_context_ready" in normalized_sql:
            return _FakeCursor([{"bootstrap_context_ready": 1}])
        if "delete from ops.cover_lookup_tasks" in normalized_sql:
            if not self.allow_delete:
                raise PermissionError("permission denied for table cover_lookup_tasks")
            retained_count, retained_task_ids = params
            if retained_count == 0:
                self.persisted_task_ids.clear()
            else:
                self.persisted_task_ids.intersection_update(retained_task_ids)
        return _FakeCursor()


def _postgres_adapter(connection):
    return CoverLookupTasksPostgresAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@example/test"},
        connect=lambda database_url: connection,
    )


def test_postgres_adapter_requires_delete_privilege_to_clear_legacy_terminal_notification(
):
    connection = _LegacyNotificationConnection(allow_delete=False)

    with pytest.raises(
        PermissionError,
        match="permission denied for table cover_lookup_tasks",
    ):
        _postgres_adapter(connection).save_notifications([])

    delete_operations = [
        (sql, params)
        for sql, params in connection.operations
        if "delete from ops.cover_lookup_tasks" in sql
    ]
    assert len(delete_operations) == 1
    assert delete_operations[0][1] == (0, [])
    assert connection.persisted_task_ids == {"legacy-metallica-kill-em-all"}


def test_postgres_adapter_clears_legacy_terminal_notification_when_delete_is_granted(
):
    connection = _LegacyNotificationConnection(allow_delete=True)

    _postgres_adapter(connection).save_notifications([])

    assert connection.persisted_task_ids == set()
