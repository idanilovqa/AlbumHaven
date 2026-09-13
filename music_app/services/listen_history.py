from __future__ import annotations

from datetime import datetime, timezone
import uuid
import math

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


def build_listen_history_status_counts(config: dict, *, account_id=None, library_id=None) -> dict[str, int]:
    if account_id is not None or library_id is not None:
        if any(type(value) is not int or value <= 0 for value in (account_id, library_id)):
            raise ValueError("Exact listen status scope is required")
        adapter = _listen_history_adapter(config)
        with adapter._connect_to_database() as connection:
            row = connection.execute("""
                with scoped as (
                    select metadata,
                        coalesce(case when metadata->'source_payload' ? 'scrobbled'
                            then metadata->'source_payload'->>'scrobbled' = 'true'
                            else scrobble_status = 'scrobbled' end, false) as accepted
                    from integration.listen_history where account_id = %s and library_id = %s
                )
                select count(*) filter (where accepted) as scrobbled,
                    count(*) filter (
                        where metadata->'source_payload'->>'scrobble_eligible' = 'true'
                        and not accepted
                        and coalesce(metadata->'source_payload'->>'scrobble_retryable', 'true') = 'true'
                        and coalesce(metadata->'source_payload'->>'scrobble_submission_state', '')
                            not in ('attempting', 'sent', 'uncertain', 'accepted')
                    ) as pending
                from scoped
            """, (account_id, library_id)).fetchone()
        return {"listen_history_count": int(row["scrobbled"]), "pending_scrobble_count": int(row["pending"])}
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
    if entry.get("measurement_version") == "rendered-pcm-v1":
        value = entry.get("measured_listened_seconds")
        return type(value) in (int, float) and math.isfinite(value) and value > _MIN_RECORDED_LISTEN_SECONDS
    total_listened_seconds = round(float(entry.get("total_listened_seconds") or 0), 3)
    max_contiguous_seconds = round(float(entry.get("max_contiguous_seconds") or 0), 3)
    return max(total_listened_seconds, max_contiguous_seconds) > _MIN_RECORDED_LISTEN_SECONDS


def append_listen_history_entry(config: dict, entry: dict[str, object], *, account_id=None, library_id=None) -> dict[str, object]:
    if entry.get("measurement_version") is not None:
        from music_app.services.measured_listen_history import append_measured
        return append_measured(_listen_history_adapter(config), entry, account_id=account_id, library_id=library_id)
    if account_id is not None or library_id is not None:
        raise ValueError("Scoped completions require a supported measurement version")
    items = load_listen_history(config)
    normalized = dict(entry)
    if not normalized.get("id"):
        normalized["id"] = uuid.uuid4().hex
    if not normalized.get("recorded_at"):
        normalized["recorded_at"] = datetime.now(timezone.utc).isoformat()
    items.append(normalized)
    save_listen_history(config, items)
    return normalized


def update_listen_history_entry(config: dict, entry_id: str, updates: dict[str, object], *, account_id=None, library_id=None, row_id=None) -> dict[str, object] | None:
    if row_id is not None or account_id is not None or library_id is not None:
        return _listen_history_adapter(config).update_scoped_entry(account_id=account_id, library_id=library_id, row_id=row_id, entry_id=entry_id, updates=updates)
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


def load_pending_scrobble_entries(config: dict, *, limit: int = 25):
    return _listen_history_adapter(config).load_pending_entries(limit=limit)


def build_measured_playback_statistics(config, *, account_id, library_id):
    if any(type(value) is not int or value <= 0 for value in (account_id, library_id)):
        raise ValueError("Authenticated statistics scope is required")
    with _listen_history_adapter(config)._connect_to_database() as connection:
        row = connection.execute("""select count(*) as local_playcount,
            coalesce(sum(measured_listened_seconds),0) as total_listening_seconds
            from integration.listen_history where account_id=%s and library_id=%s
              and measurement_version='rendered-pcm-v1' and finalized=true
              and measured_listened_seconds>10""", (account_id, library_id)).fetchone()
    return {"local_playcount": int(row["local_playcount"]),
            "total_listening_seconds": float(row["total_listening_seconds"])}
