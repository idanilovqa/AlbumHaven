import pytest

from music_app.services import cover_lookup_tasks
from music_app.services import cover_lookup_notifications
from music_app.services import cover_lookup_tasks_postgres


@pytest.fixture(autouse=True)
def isolate_cover_lookup_runtime_state():
    cover_lookup_tasks.reset_cover_lookup_runtime_state()
    yield
    cover_lookup_tasks.reset_cover_lookup_runtime_state()


def test_cover_lookup_task_summary_counts_active_and_unactioned_without_task_bodies(monkeypatch):
    monkeypatch.setattr(
        cover_lookup_tasks,
        "load_cover_lookup_notification_summaries",
        lambda _config: [
            {"id": "running", "status": "running", "notification_action_taken": False},
            {"id": "new", "status": "completed", "notification_action_taken": False},
            {"id": "seen", "status": "failed", "notification_action_taken": True},
        ],
        raising=False,
    )

    assert cover_lookup_tasks.get_cover_lookup_task_summary(config={}) == {
        "active_count": 1,
        "pending_notification_count": 1,
        "badge_count": 2,
    }


def test_notification_summary_query_excludes_task_bodies():
    sql = cover_lookup_tasks_postgres._load_notification_summaries_sql()

    assert "task_key" in sql
    assert "status" in sql
    assert "notification_action_taken" in sql
    assert "provider_payload" not in sql
    assert "source_payload" not in sql
    assert "selected_cover_private_path" not in sql


def test_notification_summaries_use_the_bounded_postgres_projection(monkeypatch):
    config = {"PERSISTENCE_BACKENDS": {"cover_lookup_tasks": "postgres"}}

    class FakeAdapter:
        def __init__(self, adapter_config):
            assert adapter_config is config

        def load_notification_summaries(self):
            return [
                {"id": "pending", "status": "running", "notification_action_taken": False},
                {"id": "", "status": "failed", "notification_action_taken": False},
            ]

    monkeypatch.setattr(cover_lookup_notifications, "CoverLookupTasksPostgresAdapter", FakeAdapter)
    monkeypatch.setattr(
        cover_lookup_notifications,
        "select_runtime_persistence_adapter",
        lambda _seam_id, _config: object(),
    )

    assert cover_lookup_notifications.load_cover_lookup_notification_summaries(config) == [
        {"id": "pending", "status": "running", "notification_action_taken": False},
    ]
