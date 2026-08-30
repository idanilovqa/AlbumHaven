from __future__ import annotations

from datetime import datetime, timezone
import uuid

from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter
from music_app.services.persistence_selection import select_runtime_persistence_adapter

_MIN_RECORDED_LISTEN_SECONDS = 10.0


def load_listen_history(config: dict) -> list[dict[str, object]]:
    return _listen_history_adapter(config).load_items()


def save_listen_history(config: dict, items: list[dict[str, object]]) -> None:
    _listen_history_adapter(config).save_items(items)


def _listen_history_adapter(config: dict) -> PostgresListenHistoryAdapter:
    selection = select_runtime_persistence_adapter("listen_history", config)
    if selection.effective_backend != "postgres":
        raise ValueError(
            "File runtime persistence is not supported for listen_history; "
            "Album Haven runtime persistence is Postgres-only."
        )
    return PostgresListenHistoryAdapter(config)


def count_scrobbled_listen_history_entries(config: dict) -> int:
    return sum(1 for item in load_listen_history(config) if is_scrobbled_listen_history_entry(item))


def build_listen_history_status_counts(config: dict) -> dict[str, int]:
    items = load_listen_history(config)
    return {
        "listen_history_count": sum(1 for item in items if is_scrobbled_listen_history_entry(item)),
        "pending_scrobble_count": sum(1 for item in items if is_pending_scrobble_entry(item)),
    }


def is_scrobbled_listen_history_entry(item: object) -> bool:
    return isinstance(item, dict) and bool(item.get("scrobbled"))


def is_pending_scrobble_entry(item: object) -> bool:
    return (
        isinstance(item, dict)
        and bool(item.get("scrobble_eligible"))
        and not bool(item.get("scrobbled"))
        and bool(item.get("scrobble_retryable", True))
    )


def is_meaningful_listen_session(entry: object) -> bool:
    if not isinstance(entry, dict):
        return False
    total_listened_seconds = round(float(entry.get("total_listened_seconds") or 0), 3)
    max_contiguous_seconds = round(float(entry.get("max_contiguous_seconds") or 0), 3)
    return max(total_listened_seconds, max_contiguous_seconds) > _MIN_RECORDED_LISTEN_SECONDS


def append_listen_history_entry(config: dict, entry: dict[str, object]) -> dict[str, object]:
    items = load_listen_history(config)
    normalized = dict(entry)
    if not normalized.get("id"):
        normalized["id"] = uuid.uuid4().hex
    if not normalized.get("recorded_at"):
        normalized["recorded_at"] = datetime.now(timezone.utc).isoformat()
    items.append(normalized)
    save_listen_history(config, items)
    return normalized


def update_listen_history_entry(config: dict, entry_id: str, updates: dict[str, object]) -> dict[str, object] | None:
    normalized_id = str(entry_id or "").strip()
    if not normalized_id:
        return None
    items = load_listen_history(config)
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        if str(item.get("id") or "").strip() != normalized_id:
            continue
        updated = {**item, **dict(updates)}
        items[index] = updated
        save_listen_history(config, items)
        return updated
    return None


def load_pending_scrobble_entries(config: dict, *, limit: int = 25) -> list[dict[str, object]]:
    pending: list[dict[str, object]] = []
    for item in load_listen_history(config):
        if not is_pending_scrobble_entry(item):
            continue
        pending.append(item)
        if len(pending) >= max(1, int(limit or 25)):
            break
    return pending
