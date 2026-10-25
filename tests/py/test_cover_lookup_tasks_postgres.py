from __future__ import annotations

from datetime import datetime

import pytest

import music_app.services.cover_lookup_tasks_postgres as cover_lookup_tasks_postgres
from music_app.services.cover_lookup_tasks_postgres import CoverLookupTasksPostgresAdapter


class _Cursor:
    def __init__(self, rows=()):
        self._rows = list(rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class _Connection:
    def __init__(self, *, count_rows=(), page_rows=()):
        self.count_rows = list(count_rows)
        self.page_rows = list(page_rows)
        self.operations = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return None

    def execute(self, sql, params=None):
        normalized_sql = " ".join(str(sql).lower().split())
        self.operations.append((normalized_sql, params))
        if "bootstrap_context_ready" in normalized_sql:
            return _Cursor([{"bootstrap_context_ready": 1}])
        if "as active_count" in normalized_sql:
            return _Cursor(self.count_rows)
        return _Cursor(self.page_rows)


def _adapter(connection):
    return CoverLookupTasksPostgresAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://example/test"},
        connect=lambda _database_url: connection,
    )


def test_adapter_uses_prewarmed_default_pool_when_connector_not_injected(monkeypatch):
    database_url = "postgresql://example/test"
    connection = _Connection(
        count_rows=[{"total_count": 528, "active_count": 3, "finished_count": 525}]
    )
    pool_calls = []

    def pooled_connection(actual_database_url, *, workload):
        pool_calls.append((actual_database_url, workload))
        return connection

    monkeypatch.setattr(
        cover_lookup_tasks_postgres,
        "_pooled_connection",
        pooled_connection,
        raising=False,
    )
    monkeypatch.setattr(
        cover_lookup_tasks_postgres,
        "_connect",
        lambda _database_url: pytest.fail("direct connection should not be opened"),
    )

    adapter = CoverLookupTasksPostgresAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": database_url}
    )

    assert adapter.count_notifications()["total_count"] == 528
    assert pool_calls == [(database_url, "default")]


def _row(task_id: str, timestamp: str, *, status: str = "completed"):
    return {
        "task_key": task_id,
        "effective_timestamp": datetime.fromisoformat(timestamp),
        "task_summary": {
            "id": task_id,
            "status": status,
            "artist": "Artist",
            "album_payload": {"name": "Album"},
        },
    }


def test_count_notifications_uses_one_filtered_aggregate_query():
    connection = _Connection(
        count_rows=[{"total_count": 528, "active_count": 3, "finished_count": 525}]
    )

    counts = _adapter(connection).count_notifications()

    assert counts == {"total_count": 528, "active_count": 3, "finished_count": 525}
    count_operations = [
        item for item in connection.operations if "as active_count" in item[0]
    ]
    assert len(count_operations) == 1
    sql, params = count_operations[0]
    assert "count(*) filter ( where" in sql
    assert "source_family" in sql
    assert params == (
        ["pending", "running"],
        ["completed", "failed", "canceled"],
        ["cover_lookup_notifications", "runtime_cover_lookup_notifications_adapter"],
    )


def test_interrupt_stale_notifications_atomically_terminalizes_active_rows():
    connection = _Connection(
        page_rows=[{"task_key": "orphaned-task"}],
    )
    stale_before = datetime.fromisoformat("2026-10-17T17:45:00+00:00")
    completed_at = datetime.fromisoformat("2026-10-17T18:00:00+00:00")

    interrupted = _adapter(connection).interrupt_stale_notifications(
        stale_before=stale_before,
        completed_at=completed_at,
    )

    assert interrupted == {"orphaned-task"}
    sql, params = connection.operations[-1]
    assert "update ops.cover_lookup_tasks" in sql
    assert "status = 'failed'" in sql
    assert "source_family" in sql
    assert "candidate_updated_at" in sql
    assert "greatest(" in sql
    assert "'message', %s::text" in sql
    assert "returning ops.cover_lookup_tasks.task_key" in sql
    assert ["pending", "running"] in params
    assert stale_before in params
    assert completed_at in params


def test_load_notification_summary_page_returns_newest_first_page_and_counts():
    rows = [
        _row("newest", "2026-10-17T18:00:02+00:00"),
        _row("middle", "2026-10-17T18:00:01+00:00"),
        _row("oldest", "2026-10-17T18:00:00+00:00"),
    ]
    connection = _Connection(
        count_rows=[{"total_count": 3, "active_count": 0, "finished_count": 3}],
        page_rows=rows,
    )

    page = _adapter(connection).load_notification_summary_page(
        limit=2, cursor=None, active_only=False
    )

    assert [item["id"] for item in page["items"]] == ["newest", "middle"]
    assert page["next_cursor"]
    assert page["counts"] == {
        "total_count": 3,
        "active_count": 0,
        "finished_count": 3,
    }
    page_sql, page_params = connection.operations[-1]
    assert "offset" not in page_sql
    assert "order by coalesce(" in page_sql
    assert "ops.cover_lookup_tasks.task_key desc" in page_sql
    assert page_params[-1] == 3


def test_duplicate_timestamp_cursor_uses_timestamp_and_task_key():
    timestamp = "2026-10-17T18:00:00+00:00"
    first_connection = _Connection(
        count_rows=[{"total_count": 3, "active_count": 0, "finished_count": 3}],
        page_rows=[
            _row("task-c", timestamp),
            _row("task-b", timestamp),
            _row("task-a", timestamp),
        ],
    )
    first_page = _adapter(first_connection).load_notification_summary_page(
        limit=2, cursor=None, active_only=False
    )

    second_connection = _Connection(
        count_rows=[{"total_count": 3, "active_count": 0, "finished_count": 3}],
        page_rows=[_row("task-a", timestamp)],
    )
    second_page = _adapter(second_connection).load_notification_summary_page(
        limit=2, cursor=first_page["next_cursor"], active_only=False
    )

    assert [item["id"] for item in second_page["items"]] == ["task-a"]
    page_sql, page_params = second_connection.operations[-1]
    assert (
        "ops.cover_lookup_tasks.requested_at), ops.cover_lookup_tasks.task_key) "
        "< (%s::timestamptz, %s)"
    ) in page_sql
    assert page_params[-3:-1] == (timestamp, "task-b")


def test_active_only_page_filters_pending_and_running_and_caps_limit_at_50():
    connection = _Connection(
        count_rows=[{"total_count": 4, "active_count": 2, "finished_count": 2}],
        page_rows=[_row("running", "2026-10-17T18:00:00+00:00", status="running")],
    )

    page = _adapter(connection).load_notification_summary_page(
        limit=500, cursor=None, active_only=True
    )

    assert [item["id"] for item in page["items"]] == ["running"]
    page_sql, page_params = connection.operations[-1]
    assert "status = any(%s::text[])" in page_sql
    assert page_params[0] == [
        "cover_lookup_notifications",
        "runtime_cover_lookup_notifications_adapter",
    ]
    assert page_params[-2] == ["pending", "running"]
    assert page_params[-1] == 51


@pytest.mark.parametrize(
    "cursor",
    [
        "not-base64!",
        "e30",  # {}
        "eyJ0aW1lc3RhbXAiOiJub3QtYS10aW1lIiwidGFza19rZXkiOiJ4In0",
        "eyJ0aW1lc3RhbXAiOiIyMDI2LTEwLTE3VDE4OjAwOjAwIiwidGFza19rZXkiOiJ4In0",
        "eyJ0aW1lc3RhbXAiOiIyMDI2LTEwLTE3VDE4OjAwOjAwKzAwOjAwIiwidGFza19rZXkiOiIifQ",
    ],
)
def test_notification_summary_page_rejects_malformed_cursor(cursor):
    with pytest.raises(ValueError, match="cursor"):
        _adapter(_Connection()).load_notification_summary_page(
            limit=50, cursor=cursor, active_only=False
        )


def test_notification_summary_page_items_omit_tracks_and_local_paths():
    row = _row("compact", "2026-10-17T18:00:00+00:00")
    row["task_summary"].update(
        {
            "track_paths": ["C:/Music/Artist/Album/01.flac"],
            "selected_cover_private_path": "C:/Music/Artist/Album/cover.jpg",
            "album_payload": {
                "album_id": 41,
                "name": "Album",
                "cover_path": "C:/Music/Artist/Album/cover.jpg",
                "tracks": [{"path": "C:/Music/Artist/Album/01.flac"}],
            },
        }
    )
    connection = _Connection(
        count_rows=[{"total_count": 1, "active_count": 0, "finished_count": 1}],
        page_rows=[row],
    )

    page = _adapter(connection).load_notification_summary_page(
        limit=50, cursor=None, active_only=False
    )

    item = page["items"][0]
    assert "track_paths" not in item
    assert "selected_cover_private_path" not in item
    assert "cover_path" not in item.get("album_payload", {})
    assert "tracks" not in item.get("album_payload", {})
    assert item["album_payload"]["album_id"] == 41
    page_sql = connection.operations[-1][0]
    assert "'tracks'" not in page_sql
    assert "'cover_path'" not in page_sql
    assert "'album_id', coalesce(" in page_sql
    assert "album_payload' -> 'id'" in page_sql
    assert "album_payload' -> 'album_id'" in page_sql
