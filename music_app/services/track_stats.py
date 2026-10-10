from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping

from music_app.services.listen_history_postgres import (
    PostgresListenHistoryAdapter,
    is_listen_history_postgres_available,
)
from music_app.services.listen_history import (
    is_scrobbled_listen_history_entry,
    load_listen_history,
)
from music_app.services.utils import safe_int


_UNSCOPED = object()


def normalize_track_ref(value: object) -> str:
    return str(value or "").strip()


def track_scrobble_count_from_source(source: object) -> int:
    if isinstance(source, dict):
        raw_value = source.get("track_scrobble_count", source.get("scrobble_count", 0))
    else:
        raw_value = getattr(source, "track_scrobble_count", getattr(source, "scrobble_count", 0))
    return max(0, safe_int(raw_value) or 0)


def build_scrobbled_play_count_lookup(
    config: dict[str, object],
    track_refs: Iterable[object],
    *,
    account_id: object = _UNSCOPED,
    library_id: object = _UNSCOPED,
    expected_track_ids: Mapping[str, object] | None = None,
    require_active_paths: bool = False,
) -> dict[str, int]:
    scoped = (account_id is not _UNSCOPED or library_id is not _UNSCOPED
              or expected_track_ids is not None or require_active_paths)
    if scoped and any(type(value) is not int or value <= 0 for value in (account_id, library_id)):
        raise ValueError("Exact scrobble count account and library scope is required")
    normalized_track_refs = sorted({
        normalize_track_ref(track_ref)
        for track_ref in track_refs
        if normalize_track_ref(track_ref)
    })
    if not normalized_track_refs:
        return {}

    if scoped:
        if not is_listen_history_postgres_available(config):
            return {}
        return PostgresListenHistoryAdapter(config).load_scrobbled_play_count_lookup(
            normalized_track_refs, account_id=account_id, library_id=library_id,
            expected_track_ids=expected_track_ids, require_active_paths=require_active_paths,
        )

    if is_listen_history_postgres_available(config):
        return PostgresListenHistoryAdapter(config).load_scrobbled_play_count_lookup(
            normalized_track_refs
        )

    counts: Counter[str] = Counter()
    for item in load_listen_history(config):
        if not is_scrobbled_listen_history_entry(item):
            continue
        track_ref = ""
        if isinstance(item, dict):
            track_ref = normalize_track_ref(item.get("track_ref") or item.get("path"))
        if not track_ref or track_ref not in normalized_track_refs:
            continue
        counts[track_ref] += 1
    return dict(counts)
