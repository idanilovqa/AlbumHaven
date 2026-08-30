from __future__ import annotations

from music_app.services.cover_lookup_tasks_postgres import CoverLookupTasksPostgresAdapter
from music_app.services.persistence_selection import select_runtime_persistence_adapter


_SEAM_ID = "cover_lookup_tasks"


def _cover_lookup_notifications_adapter(
    config: dict[str, object],
) -> CoverLookupTasksPostgresAdapter:
    select_runtime_persistence_adapter(_SEAM_ID, config)
    return CoverLookupTasksPostgresAdapter(config)


def load_cover_lookup_notifications(config: dict[str, object]) -> list[dict[str, object]]:
    return _filter_notification_tasks(
        _cover_lookup_notifications_adapter(config).load_notifications()
    )


def save_cover_lookup_notifications(config: dict[str, object], tasks: list[dict[str, object]]) -> None:
    filtered_tasks = _filter_notification_tasks(tasks)
    _cover_lookup_notifications_adapter(config).save_notifications(filtered_tasks)


def upsert_cover_lookup_notification(
    config: dict[str, object],
    task: dict[str, object],
    *,
    persistence_revision: int,
) -> None:
    if not isinstance(task, dict) or not str(task.get("id") or "").strip():
        return
    adapter = _cover_lookup_notifications_adapter(config)
    upsert_notification = getattr(adapter, "upsert_notification", None)
    if callable(upsert_notification):
        upsert_notification(task, persistence_revision=persistence_revision)
        return
    task_id = str(task.get("id") or "").strip()
    retained = [
        item
        for item in adapter.load_notifications()
        if str(item.get("id") or "").strip() != task_id
    ]
    adapter.save_notifications([*retained, task])


def delete_cover_lookup_notifications(
    config: dict[str, object],
    task_ids: set[str],
) -> set[str]:
    normalized_ids = {
        str(task_id or "").strip()
        for task_id in task_ids
        if str(task_id or "").strip()
    }
    if not normalized_ids:
        return set()
    adapter = _cover_lookup_notifications_adapter(config)
    delete_notifications = getattr(adapter, "delete_notifications", None)
    if callable(delete_notifications):
        return delete_notifications(normalized_ids)
    persisted = adapter.load_notifications()
    removed_ids = {
        str(item.get("id") or "").strip()
        for item in persisted
        if str(item.get("id") or "").strip() in normalized_ids
    }
    if removed_ids:
        adapter.save_notifications([
            item
            for item in persisted
            if str(item.get("id") or "").strip() not in removed_ids
        ])
    return removed_ids


def _filter_notification_tasks(items: object) -> list[dict[str, object]]:
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict) and str(item.get("id") or "").strip()]
