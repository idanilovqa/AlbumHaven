from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import threading
import uuid

_LOG_HISTORY_LOCK = threading.RLock()
_MAX_LOG_HISTORY_ITEMS = 250
_LOG_HISTORY_ITEMS: list[dict[str, object]] = []
_LOG_HISTORY_REVISION = 0
_LOG_HISTORY_EPOCH = uuid.uuid4().hex


def _log_history_revision_token() -> str:
    return f"{_LOG_HISTORY_EPOCH}:{_LOG_HISTORY_REVISION}"


def load_log_history_snapshot(config: dict) -> dict[str, object]:
    del config
    with _LOG_HISTORY_LOCK:
        return {
            "items": deepcopy(_LOG_HISTORY_ITEMS),
            "revision": _log_history_revision_token(),
        }


def load_log_history(config: dict) -> list[dict[str, object]]:
    return list(load_log_history_snapshot(config)["items"])


def load_log_history_revision(config: dict) -> str:
    del config
    with _LOG_HISTORY_LOCK:
        return _log_history_revision_token()


def append_log_history(config: dict, entry: dict[str, object]) -> list[dict[str, object]]:
    global _LOG_HISTORY_REVISION
    del config
    with _LOG_HISTORY_LOCK:
        normalized = _normalize_log_history_item(entry)
        normalized_id = normalized["id"]
        _LOG_HISTORY_REVISION += 1
        _LOG_HISTORY_ITEMS[:] = [
            normalized,
            *(
                item
                for item in _LOG_HISTORY_ITEMS
                if item.get("id") != normalized_id
            ),
        ][:_MAX_LOG_HISTORY_ITEMS]
        return deepcopy(_LOG_HISTORY_ITEMS)


def _normalize_log_history_item(entry: dict[str, object]) -> dict[str, object]:
    normalized = deepcopy(entry)
    normalized_id = str(normalized.get("id") or "").strip()
    normalized["id"] = normalized_id or uuid.uuid4().hex

    timestamp = normalized.get("timestamp")
    if isinstance(timestamp, datetime):
        normalized_timestamp = timestamp.isoformat()
    else:
        normalized_timestamp = str(timestamp or "").strip()
    normalized["timestamp"] = (
        normalized_timestamp
        or datetime.now(timezone.utc).isoformat()
    )
    recorded_at = normalized.get("recorded_at")
    if isinstance(recorded_at, datetime):
        normalized_recorded_at = recorded_at.isoformat()
    else:
        normalized_recorded_at = str(recorded_at or "").strip()
    normalized["recorded_at"] = (
        normalized_recorded_at
        or datetime.now(timezone.utc).isoformat()
    )
    return normalized


def _reset_log_history_for_tests() -> None:
    global _LOG_HISTORY_REVISION
    with _LOG_HISTORY_LOCK:
        _LOG_HISTORY_ITEMS.clear()
        _LOG_HISTORY_REVISION = 0
