from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
import uuid
import math

from music_app.services.listen_history_postgres import (
    LASTFM_SCROBBLE_SOURCE_FAMILIES,
    PendingListenEntry,
    PostgresListenHistoryAdapter,
    _validated_recent_window,
)
from music_app.services.persistence_selection import select_runtime_persistence_adapter

_MIN_RECORDED_LISTEN_SECONDS = 10.0


def load_listen_history(config: dict) -> list[dict[str, object]]:
    return _listen_history_adapter(config).load_items()


def load_recent_listen_history(
    config: dict, *, account_id: int, library_id: int,
    window_start: datetime, window_end: datetime,
) -> list[dict[str, object]]:
    """Normalize a scoped ledger read without trusting identity in source JSON."""
    start, end = _validated_recent_window(account_id, library_id, window_start, window_end)
    rows = _listen_history_adapter(config).load_recent_items(
        account_id=account_id, library_id=library_id, window_start=start, window_end=end,
    )
    return normalize_listen_history_rows(
        rows, account_id=account_id, library_id=library_id,
        window_start=start, window_end=end,
    )


def normalize_listen_history_rows(
    rows, *, account_id: int, library_id: int,
    window_start: datetime, window_end: datetime, end_inclusive: bool = True,
) -> list[dict[str, object]]:
    """Qualify ledger rows once for Recent and immutable activity projections."""
    start, end = _validated_recent_window(account_id, library_id, window_start, window_end)
    if type(end_inclusive) is not bool:
        raise ValueError("Listen window inclusivity must be explicit")
    entries = []
    for row in rows:
        if (type(row.get("account_id")) is not int or type(row.get("library_id")) is not int
                or row["account_id"] != account_id or row["library_id"] != library_id
                or type(row.get("id")) is not int or row["id"] <= 0):
            continue
        played_at = row.get("played_at")
        if not isinstance(played_at, datetime) or played_at.tzinfo is None or played_at.utcoffset() is None:
            continue
        played_at = played_at.astimezone(timezone.utc)
        if not (start <= played_at and (played_at <= end if end_inclusive else played_at < end)):
            continue
        metadata = row.get("metadata")
        payload = metadata.get("source_payload") if isinstance(metadata, dict) else None
        payload = payload if isinstance(payload, dict) else {}
        source = row.get("source_family")
        version = row.get("measurement_version")
        if source == "rendered_local_listen_session" and version == "rendered-pcm-v1":
            seconds = row.get("measured_listened_seconds")
            if (row.get("finalized") is not True or type(seconds) not in (int, float)
                    or not math.isfinite(seconds) or seconds <= _MIN_RECORDED_LISTEN_SECONDS):
                continue
            provenance = "measured_started_at"
        elif source in {"runtime_listen_history_adapter", "phase_6_json_file_backfill"} and version is None:
            seconds = _finite_legacy_seconds(payload.get("total_listened_seconds", 0))
            contiguous = _finite_legacy_seconds(payload.get("max_contiguous_seconds", 0))
            if seconds is None or contiguous is None or max(round(seconds, 3), round(contiguous, 3)) <= _MIN_RECORDED_LISTEN_SECONDS:
                continue
            provenance = "legacy_recorded_at"
        else:
            continue
        entry = {key: payload[key] for key in (
            "track_ref", "path", "title", "artist", "album", "album_artist", "track_number",
            "album_track_count", "album_duration_seconds", "source_provenance",
            "remote_cover_url", "remote_cover_thumbnail_url",
        ) if key in payload}
        entry.update(
            row_id=row["id"], account_id=account_id, library_id=library_id,
            track_id=row.get("track_id"), track_key=row.get("track_key"),
            album_id=row.get("album_id"), played_at=played_at, source_family=source,
            measurement_version=version, listened_seconds=float(seconds), time_provenance=provenance,
        )
        if version == "rendered-pcm-v1":
            entry["source_provenance"] = {"kind": "local_playback", "provider": "album_haven"}
        entries.append(entry)
    return sorted(entries, key=lambda entry: (entry["played_at"], entry["row_id"]))


def _finite_legacy_seconds(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        seconds = float(value or 0)
    except (TypeError, ValueError, OverflowError):
        return None
    return seconds if math.isfinite(seconds) and seconds >= 0 else None


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
                    from integration.listen_history
                    where account_id = %s and library_id = %s
                      and source_family = any(%s)
                )
                select count(*) filter (where accepted) as scrobbled,
                    count(*) filter (
                        where metadata->'source_payload'->>'scrobble_eligible' = 'true'
                        and not accepted
                        and coalesce(metadata->'source_payload'->>'scrobble_retryable', 'true') = 'true'
                        and coalesce(metadata->'source_payload'->>'scrobble_retry_exhausted', 'false') != 'true'
                        and coalesce(metadata->'source_payload'->>'scrobble_submission_state', '')
                            not in ('attempting', 'sent', 'uncertain', 'accepted')
                    ) as pending
                from scoped
            """, (account_id, library_id, list(LASTFM_SCROBBLE_SOURCE_FAMILIES))).fetchone()
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
        and not bool(item.get("scrobble_retry_exhausted"))
        and str(item.get("scrobble_submission_state") or "")
            not in {"attempting", "sent", "uncertain", "accepted"}
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


def load_pending_scrobble_entries(
    config: dict,
    *,
    limit: int = 25,
    eligible: Callable[[PendingListenEntry], bool] | None = None,
):
    adapter = _listen_history_adapter(config)
    if eligible is None:
        return adapter.load_pending_entries(limit=limit)
    return adapter.load_pending_entries(limit=limit, eligible=eligible)


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
