from __future__ import annotations

from concurrent.futures import Future
from collections.abc import Mapping
from datetime import datetime, timezone
import json
from threading import Event, Lock
import uuid

from music_app.services.cover_provider_candidates import (
    CURRENT_USE_LOOKUP_MATCH_FIELDS,
    normalize_remote_image_url,
)
from music_app.services.cover_lookup_notifications import (
    delete_cover_lookup_notifications,
    load_cover_lookup_notifications,
    save_cover_lookup_notifications,
    upsert_cover_lookup_notification,
)
from music_app.services.cover_lookup_jobs import build_cover_lookup_job_contract


_COVER_LOOKUP_TASKS: dict[str, dict[str, object]] = {}
_COVER_LOOKUP_TASKS_LOCK = Lock()
_COVER_LOOKUP_CANCEL_EVENTS: dict[str, Event] = {}
_COVER_LOOKUP_FUTURES: dict[str, set[Future]] = {}
_COVER_LOOKUP_TASK_REVISIONS: dict[str, int] = {}
_COVER_LOOKUP_PERSISTENCE_LOCKS: dict[str, Lock] = {}
_TERMINAL_COVER_LOOKUP_STATUSES = {"completed", "failed", "canceled"}
MAX_ACTIVE_COVER_LOOKUP_MATCHES = 64
ACTIVE_COVER_LOOKUP_MATCH_FIELDS = frozenset(CURRENT_USE_LOOKUP_MATCH_FIELDS - {"debug"})
MAX_ACTIVE_COVER_LOOKUP_STRING_CHARS = 2_048
MAX_ACTIVE_COVER_LOOKUP_MATCHES_JSON_BYTES = 256 * 1_024


def cover_lookup_result(task_id: str) -> dict[str, object]:
    with _COVER_LOOKUP_TASKS_LOCK:
        payload = _COVER_LOOKUP_TASKS.get(task_id, {})
        return {key: value for key, value in payload.items() if key != "cancel_event"}


def _sanitize_cover_lookup_value(value: object) -> object:
    if isinstance(value, dict):
        sanitized: dict[str, object] = {}
        for key, item in value.items():
            normalized_key = str(key or "")
            if normalized_key in {"prefetched_raw_bytes", "raw_bytes"}:
                continue
            if isinstance(item, bytes):
                continue
            sanitized[normalized_key] = _sanitize_cover_lookup_value(item)
        return sanitized
    if isinstance(value, list):
        return [_sanitize_cover_lookup_value(item) for item in value]
    if isinstance(value, tuple):
        return [_sanitize_cover_lookup_value(item) for item in value]
    if isinstance(value, bytes):
        return None
    return value


def _bounded_active_cover_lookup_matches(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    matches: list[dict[str, object]] = []
    seen_ids: set[str] = set()
    seen_urls: set[str] = set()
    for item in value:
        sanitized = _sanitize_cover_lookup_value(item)
        if not isinstance(sanitized, dict):
            continue
        bounded: dict[str, object] = {}
        for key, item_value in sanitized.items():
            if key not in ACTIVE_COVER_LOOKUP_MATCH_FIELDS:
                continue
            if isinstance(item_value, str):
                bounded[key] = item_value[:MAX_ACTIVE_COVER_LOOKUP_STRING_CHARS]
            elif item_value is None or isinstance(item_value, bool | int | float):
                bounded[key] = item_value
        candidate_id = str(bounded.get("id") or "").strip()
        normalized_url = normalize_remote_image_url(str(bounded.get("url") or ""))
        candidate_id_key = candidate_id.casefold()
        normalized_url_key = normalized_url.casefold()
        if not candidate_id_key and not normalized_url_key:
            continue
        if candidate_id_key and candidate_id_key in seen_ids:
            continue
        if normalized_url_key and normalized_url_key in seen_urls:
            continue
        if candidate_id:
            bounded["id"] = candidate_id
        if normalized_url:
            bounded["url"] = normalized_url
        candidate_matches = [*matches, bounded]
        if len(json.dumps(candidate_matches).encode("utf-8")) > MAX_ACTIVE_COVER_LOOKUP_MATCHES_JSON_BYTES:
            break
        if candidate_id:
            seen_ids.add(candidate_id_key)
        if normalized_url:
            seen_urls.add(normalized_url_key)
        matches.append(bounded)
        if len(matches) >= MAX_ACTIVE_COVER_LOOKUP_MATCHES:
            break
    return matches


def serialize_cover_lookup_task_payload(task_payload: dict[str, object] | None) -> dict[str, object] | None:
    if not isinstance(task_payload, dict):
        return None
    sanitized = _sanitize_cover_lookup_value(task_payload)
    if isinstance(sanitized, dict) and not is_terminal_cover_lookup_task(sanitized):
        if "possible_matches" in sanitized:
            sanitized["possible_matches"] = _bounded_active_cover_lookup_matches(
                sanitized.get("possible_matches")
            )
    return sanitized if isinstance(sanitized, dict) else None


def is_terminal_cover_lookup_task(task_payload: dict[str, object] | None) -> bool:
    status = str((task_payload or {}).get("status") or "").strip().casefold()
    return status in _TERMINAL_COVER_LOOKUP_STATUSES


def normalize_cover_lookup_notification_task(task_payload: dict[str, object] | None) -> dict[str, object] | None:
    serialized = serialize_cover_lookup_task_payload(task_payload)
    if not isinstance(serialized, dict):
        return None
    task_id = str(serialized.get("id") or "").strip()
    if not task_id or not is_terminal_cover_lookup_task(serialized):
        return None
    completed_at = (
        str(serialized.get("notification_completed_at") or "").strip()
        or str(serialized.get("finished_at") or "").strip()
        or str(serialized.get("updated_at") or "").strip()
        or str(serialized.get("created_at") or "").strip()
        or datetime.now(timezone.utc).isoformat()
    )
    serialized["id"] = task_id
    serialized["notification_action_taken"] = bool(serialized.get("notification_action_taken"))
    serialized["notification_completed_at"] = completed_at
    serialized["notification_expires_at"] = ""
    return serialized


def _normalize_cover_lookup_persisted_task(
    task_payload: dict[str, object] | None,
) -> dict[str, object] | None:
    normalized_notification = normalize_cover_lookup_notification_task(task_payload)
    if normalized_notification is not None:
        return normalized_notification
    serialized = serialize_cover_lookup_task_payload(task_payload)
    if not isinstance(serialized, dict):
        return None
    task_id = str(serialized.get("id") or "").strip()
    status = str(serialized.get("status") or "").strip().casefold()
    if not task_id or status not in {"pending", "running"}:
        return None
    serialized["id"] = task_id
    serialized["notification_action_taken"] = False
    serialized["notification_completed_at"] = ""
    serialized["notification_expires_at"] = ""
    return serialized


def _sort_cover_lookup_task_key(task_payload: dict[str, object]) -> tuple[str, str]:
    timestamp = (
        str(task_payload.get("notification_completed_at") or "").strip()
        or str(task_payload.get("finished_at") or "").strip()
        or str(task_payload.get("updated_at") or "").strip()
        or str(task_payload.get("created_at") or "").strip()
    )
    return (timestamp, str(task_payload.get("id") or ""))


def _save_cover_lookup_notification_task(
    task_payload: dict[str, object] | None,
    *,
    config: Mapping[str, object] | None = None,
    expected_revision: int | None = None,
) -> None:
    if isinstance(task_payload, dict) and bool(task_payload.get("internal")):
        return
    normalized = _normalize_cover_lookup_persisted_task(task_payload)
    if normalized is None or config is None:
        return
    task_id = str(normalized.get("id") or "")
    if expected_revision is None:
        with _COVER_LOOKUP_TASKS_LOCK:
            expected_revision = _COVER_LOOKUP_TASK_REVISIONS.get(task_id, 0)
    if str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip():
        with _COVER_LOOKUP_TASKS_LOCK:
            persistence_lock = _COVER_LOOKUP_PERSISTENCE_LOCKS.setdefault(task_id, Lock())
        with persistence_lock:
            with _COVER_LOOKUP_TASKS_LOCK:
                if _COVER_LOOKUP_TASK_REVISIONS.get(task_id, 0) != expected_revision:
                    return
            upsert_cover_lookup_notification(
                config,
                normalized,
                persistence_revision=expected_revision,
            )
        return
    persisted = load_cover_lookup_notifications(config)
    with _COVER_LOOKUP_TASKS_LOCK:
        if _COVER_LOOKUP_TASK_REVISIONS.get(task_id, 0) != expected_revision:
            return
    next_tasks = [item for item in persisted if str(item.get("id") or "") != task_id]
    next_tasks.append(normalized)
    next_tasks.sort(key=_sort_cover_lookup_task_key, reverse=True)
    save_cover_lookup_notifications(config, next_tasks)


def _remove_cover_lookup_notification_tasks(
    task_ids: set[str],
    *,
    config: Mapping[str, object] | None = None,
) -> set[str]:
    if not task_ids or config is None:
        return set()
    if str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip():
        removed_ids: set[str] = set()
        for task_id in sorted(task_ids):
            with _COVER_LOOKUP_TASKS_LOCK:
                persistence_lock = _COVER_LOOKUP_PERSISTENCE_LOCKS.setdefault(task_id, Lock())
            with persistence_lock:
                removed_ids.update(delete_cover_lookup_notifications(config, {task_id}))
        return removed_ids
    persisted = load_cover_lookup_notifications(config)
    removed_ids = {
        str(item.get("id") or "").strip()
        for item in persisted
        if str(item.get("id") or "").strip() in task_ids
    }
    if removed_ids:
        next_tasks = [item for item in persisted if str(item.get("id") or "").strip() not in removed_ids]
        save_cover_lookup_notifications(config, next_tasks)
    return removed_ids


def _merge_cover_lookup_task_with_notification(
    task_payload: dict[str, object] | None,
    notification_payload: dict[str, object] | None,
) -> dict[str, object] | None:
    serialized_task = serialize_cover_lookup_task_payload(task_payload) or {}
    serialized_notification = serialize_cover_lookup_task_payload(notification_payload) or {}
    combined = {
        **serialized_notification,
        **serialized_task,
    }
    if not combined:
        return None
    combined["notification_action_taken"] = bool(
        combined.get("notification_action_taken")
        or serialized_notification.get("notification_action_taken")
    )
    completed_at = (
        str(serialized_task.get("notification_completed_at") or "").strip()
        or str(serialized_task.get("finished_at") or "").strip()
        or str(serialized_notification.get("notification_completed_at") or "").strip()
        or str(serialized_task.get("updated_at") or "").strip()
        or str(serialized_notification.get("finished_at") or "").strip()
        or str(serialized_notification.get("updated_at") or "").strip()
        or str(serialized_task.get("created_at") or "").strip()
        or str(serialized_notification.get("created_at") or "").strip()
    )
    if is_terminal_cover_lookup_task(combined):
        combined["notification_completed_at"] = completed_at or datetime.now(timezone.utc).isoformat()
        combined["notification_expires_at"] = ""
    else:
        combined["possible_matches"] = _bounded_active_cover_lookup_matches(
            [
                *(serialized_task.get("possible_matches") or []),
                *(serialized_notification.get("possible_matches") or []),
            ]
        )
        combined["notification_completed_at"] = ""
        combined["notification_expires_at"] = ""
        combined["notification_action_taken"] = False
    return combined


def list_cover_lookup_tasks(*, config: Mapping[str, object] | None = None) -> list[dict[str, object]]:
    with _COVER_LOOKUP_TASKS_LOCK:
        live_items = [
            {
                key: value
                for key, value in task.items()
                if key not in {"cancel_event", "updated_albums", "updated_problematic_album", "service_job_result"}
            }
            for task in _COVER_LOOKUP_TASKS.values()
        ]
    live_items = [
        serialized
        for serialized in (serialize_cover_lookup_task_payload(item) for item in live_items)
        if serialized is not None and not bool(serialized.get("internal"))
    ]
    persisted_items = load_cover_lookup_notifications(config) if config is not None else []
    persisted_by_id = {
        str(item.get("id") or "").strip(): item
        for item in persisted_items
        if str(item.get("id") or "").strip()
    }
    merged_items: list[dict[str, object]] = []
    for item in live_items:
        task_id = str(item.get("id") or "").strip()
        merged = _merge_cover_lookup_task_with_notification(item, persisted_by_id.pop(task_id, None))
        if merged is not None:
            merged_items.append(merged)
    for item in persisted_by_id.values():
        merged = normalize_cover_lookup_notification_task(item)
        if merged is not None:
            merged_items.append(merged)
    merged_items.sort(key=_sort_cover_lookup_task_key, reverse=True)
    return merged_items


def update_cover_lookup_task(
    task_id: str,
    *,
    config: Mapping[str, object] | None = None,
    **changes,
) -> None:
    task_snapshot: dict[str, object] | None = None
    task_revision = 0
    with _COVER_LOOKUP_TASKS_LOCK:
        if task_id not in _COVER_LOOKUP_TASKS and _COVER_LOOKUP_TASK_REVISIONS.get(task_id, 0) > 0:
            return
        task = _COVER_LOOKUP_TASKS.setdefault(task_id, {"id": task_id, "status": "pending"})
        current_job_contract = task.get("job_contract")
        requested_job_contract = changes.get("job_contract")
        current_job_kind = str(
            current_job_contract.get("job_kind")
            if isinstance(current_job_contract, Mapping)
            else ""
        ).strip()
        requested_job_kind = str(
            requested_job_contract.get("job_kind")
            if isinstance(requested_job_contract, Mapping)
            else ""
        ).strip()
        if current_job_kind == "save_remote_selection" and requested_job_kind == "candidate_lookup":
            return
        if str(task.get("status") or "").strip().casefold() == "canceled":
            requested_status = str(changes.get("status") or "").strip().casefold()
            if requested_status != "canceled":
                return
        task.update(changes)
        task_snapshot = dict(task)
        task_revision = _COVER_LOOKUP_TASK_REVISIONS.get(task_id, 0) + 1
        _COVER_LOOKUP_TASK_REVISIONS[task_id] = task_revision
    if is_terminal_cover_lookup_task(task_snapshot) or "possible_matches" in changes:
        _save_cover_lookup_notification_task(
            task_snapshot,
            config=config,
            expected_revision=task_revision,
        )
    _reclaim_terminal_internal_cover_lookup_task(task_id, task_snapshot)


def _reclaim_terminal_internal_cover_lookup_task(
    task_id: str,
    task_snapshot: Mapping[str, object] | None,
) -> None:
    if not (
        isinstance(task_snapshot, Mapping)
        and bool(task_snapshot.get("internal"))
        and is_terminal_cover_lookup_task(task_snapshot)
    ):
        return
    with _COVER_LOOKUP_TASKS_LOCK:
        current_task = _COVER_LOOKUP_TASKS.get(task_id)
        if not (
            isinstance(current_task, Mapping)
            and bool(current_task.get("internal"))
            and is_terminal_cover_lookup_task(current_task)
        ):
            return
        _COVER_LOOKUP_TASKS.pop(task_id, None)
    _COVER_LOOKUP_CANCEL_EVENTS.pop(task_id, None)
    _reclaim_cleared_cover_lookup_task_state(task_id)


def create_cover_lookup_task(
    album: dict[str, object],
    requested_track_paths: set[str],
    manual_urls: list[str] | None = None,
    *,
    internal: bool = False,
) -> tuple[str, Event]:
    task_id = uuid.uuid4().hex
    cancel_event = Event()
    _COVER_LOOKUP_CANCEL_EVENTS[task_id] = cancel_event
    update_cover_lookup_task(
        task_id,
        id=task_id,
        status="pending",
        type="cover-art-lookup",
        internal=bool(internal),
        artist=str(album.get("album_artist") or ""),
        album=str(album.get("name") or album.get("album") or ""),
        year=album.get("year"),
        album_payload=album,
        track_paths=sorted(requested_track_paths),
        progress=0,
        progress_label="Queued",
        created_at=datetime.now(timezone.utc).isoformat(),
        finished_at="",
        message="",
        manual_urls=[str(item or "").strip() for item in (manual_urls or []) if str(item or "").strip()],
        job_contract=build_cover_lookup_job_contract("candidate_lookup"),
        possible_matches=[],
        selected_candidate_id="",
        caa_empty_notice=False,
        cancel_requested=False,
    )
    return task_id, cancel_event


def _reclaim_cleared_cover_lookup_task_state(task_id: str) -> None:
    with _COVER_LOOKUP_TASKS_LOCK:
        if task_id in _COVER_LOOKUP_TASKS or _COVER_LOOKUP_FUTURES.get(task_id):
            return
        persistence_lock = _COVER_LOOKUP_PERSISTENCE_LOCKS.get(task_id)
        if persistence_lock is None:
            _COVER_LOOKUP_TASK_REVISIONS.pop(task_id, None)
            return
    with persistence_lock:
        with _COVER_LOOKUP_TASKS_LOCK:
            if task_id in _COVER_LOOKUP_TASKS or _COVER_LOOKUP_FUTURES.get(task_id):
                return
            if _COVER_LOOKUP_PERSISTENCE_LOCKS.get(task_id) is not persistence_lock:
                return
            _COVER_LOOKUP_TASK_REVISIONS.pop(task_id, None)
            _COVER_LOOKUP_PERSISTENCE_LOCKS.pop(task_id, None)


def register_cover_lookup_future(task_id: str, future: Future) -> None:
    with _COVER_LOOKUP_TASKS_LOCK:
        _COVER_LOOKUP_FUTURES.setdefault(task_id, set()).add(future)
    future.add_done_callback(
        lambda completed_future: discard_cover_lookup_future(task_id, completed_future)
    )


def discard_cover_lookup_future(task_id: str, future: Future | None = None) -> None:
    with _COVER_LOOKUP_TASKS_LOCK:
        registered_futures = _COVER_LOOKUP_FUTURES.get(task_id)
        if registered_futures is not None:
            if future is not None:
                registered_futures.discard(future)
            else:
                completed_futures = {
                    registered_future
                    for registered_future in registered_futures
                    if registered_future.done()
                }
                registered_futures.difference_update(completed_futures)
            if not registered_futures:
                _COVER_LOOKUP_FUTURES.pop(task_id, None)
    _reclaim_cleared_cover_lookup_task_state(task_id)


def request_cover_lookup_task_stop(task_id: str) -> bool:
    cancel_event = _COVER_LOOKUP_CANCEL_EVENTS.get(str(task_id or "").strip())
    if cancel_event is None:
        return False
    cancel_event.set()
    return True


def cancel_cover_lookup_task(task_id: str, *, config: Mapping[str, object] | None = None) -> bool:
    cancel_event = _COVER_LOOKUP_CANCEL_EVENTS.get(task_id)
    if cancel_event is None:
        return False
    cancel_event.set()
    task = cover_lookup_result(task_id)
    status = str(task.get("status") or "").strip().casefold()
    with _COVER_LOOKUP_TASKS_LOCK:
        futures = list(_COVER_LOOKUP_FUTURES.get(task_id, set()))
    canceled_future = (
        next((future for future in futures if future.cancel()), None)
        if status == "pending"
        else None
    )
    if status == "pending" and canceled_future is not None:
        update_cover_lookup_task(
            task_id,
            config=config,
            cancel_requested=True,
            status="canceled",
            progress=100,
            progress_label="Canceled",
            finished_at=datetime.now(timezone.utc).isoformat(),
            message="Cover art lookup canceled before it started.",
        )
        discard_cover_lookup_future(task_id, canceled_future)
        return True
    if status == "pending":
        update_cover_lookup_task(
            task_id,
            config=config,
            cancel_requested=True,
            status="canceled",
            progress=100,
            progress_label="Canceled",
            finished_at=datetime.now(timezone.utc).isoformat(),
            message="Cover art lookup canceled.",
        )
        for future in futures:
            if future.done():
                discard_cover_lookup_future(task_id, future)
        return True
    update_cover_lookup_task(
        task_id,
        config=config,
        cancel_requested=True,
        progress_label="Canceling...",
        message="Cancel requested. Finishing the current step...",
    )
    return True


def cancel_cover_lookup_task_payload(
    task_id: str,
    *,
    config: Mapping[str, object] | None = None,
) -> dict[str, object] | None:
    normalized_task_id = str(task_id or "").strip()
    if not normalized_task_id:
        return None
    if not cancel_cover_lookup_task(normalized_task_id, config=config):
        return None
    return serialize_cover_lookup_task_payload(cover_lookup_result(normalized_task_id))


def clear_completed_cover_lookup_tasks(
    task_ids: list[str] | None = None,
    *,
    config: Mapping[str, object] | None = None,
) -> int:
    normalized_task_ids = {
        str(task_id or "").strip()
        for task_id in (task_ids or [])
        if str(task_id or "").strip()
    }
    if task_ids is not None and not normalized_task_ids:
        return 0
    removed_task_ids: list[str] = []
    with _COVER_LOOKUP_TASKS_LOCK:
        for task_id, task in list(_COVER_LOOKUP_TASKS.items()):
            if normalized_task_ids and task_id not in normalized_task_ids:
                continue
            status = str((task or {}).get("status") or "").strip().casefold()
            if status not in _TERMINAL_COVER_LOOKUP_STATUSES:
                continue
            removed_task_ids.append(task_id)
            _COVER_LOOKUP_TASKS.pop(task_id, None)
            _COVER_LOOKUP_TASK_REVISIONS[task_id] = _COVER_LOOKUP_TASK_REVISIONS.get(task_id, 0) + 1
    for task_id in removed_task_ids:
        _COVER_LOOKUP_CANCEL_EVENTS.pop(task_id, None)
    persisted_removed_ids = _remove_cover_lookup_notification_tasks(
        set(removed_task_ids) | normalized_task_ids,
        config=config,
    )
    cleared_task_ids = set(removed_task_ids) | persisted_removed_ids
    for task_id in cleared_task_ids:
        _reclaim_cleared_cover_lookup_task_state(task_id)
    return len(cleared_task_ids)


def mark_cover_lookup_task_notification_action_taken(
    task_id: str,
    *,
    config: Mapping[str, object] | None = None,
) -> dict[str, object] | None:
    normalized_task_id = str(task_id or "").strip()
    if not normalized_task_id:
        return None
    updated_task: dict[str, object] | None = None
    task_revision = 0
    with _COVER_LOOKUP_TASKS_LOCK:
        task = _COVER_LOOKUP_TASKS.get(normalized_task_id)
        if isinstance(task, dict) and is_terminal_cover_lookup_task(task):
            task["notification_action_taken"] = True
            if not str(task.get("notification_completed_at") or "").strip():
                task["notification_completed_at"] = (
                    str(task.get("finished_at") or "").strip()
                    or str(task.get("created_at") or "").strip()
                    or datetime.now(timezone.utc).isoformat()
                )
            task["notification_expires_at"] = ""
            updated_task = dict(task)
            task_revision = _COVER_LOOKUP_TASK_REVISIONS.get(normalized_task_id, 0) + 1
            _COVER_LOOKUP_TASK_REVISIONS[normalized_task_id] = task_revision
    persisted_items = load_cover_lookup_notifications(config) if config is not None else []
    persisted_match = next(
        (item for item in persisted_items if str(item.get("id") or "").strip() == normalized_task_id),
        None,
    )
    source_task = updated_task or persisted_match
    if source_task is None:
        return None
    merged = normalize_cover_lookup_notification_task(
        {
            **source_task,
            "notification_action_taken": True,
            "notification_expires_at": "",
        }
    )
    if merged is None:
        return None
    if task_revision == 0:
        with _COVER_LOOKUP_TASKS_LOCK:
            task_revision = _COVER_LOOKUP_TASK_REVISIONS.get(normalized_task_id, 0) + 1
            _COVER_LOOKUP_TASK_REVISIONS[normalized_task_id] = task_revision
    _save_cover_lookup_notification_task(
        merged,
        config=config,
        expected_revision=task_revision,
    )
    return merged


def finalize_cover_lookup_task_canceled(
    task_id: str,
    *,
    config: Mapping[str, object] | None = None,
) -> dict[str, object]:
    payload = cover_lookup_result(task_id)
    update_cover_lookup_task(
        task_id,
        config=config,
        job_contract=build_cover_lookup_job_contract("candidate_lookup"),
        status="canceled",
        progress=100,
        progress_label="Canceled",
        finished_at=datetime.now(timezone.utc).isoformat(),
        message=str(payload.get("message") or "Cover art lookup canceled."),
    )
    return cover_lookup_result(task_id)


def reset_cover_lookup_runtime_state() -> None:
    with _COVER_LOOKUP_TASKS_LOCK:
        _COVER_LOOKUP_TASKS.clear()
        _COVER_LOOKUP_TASK_REVISIONS.clear()
        _COVER_LOOKUP_PERSISTENCE_LOCKS.clear()
    _COVER_LOOKUP_CANCEL_EVENTS.clear()
    _COVER_LOOKUP_FUTURES.clear()
