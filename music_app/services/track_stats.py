from __future__ import annotations

from collections import Counter
from collections.abc import Iterable

from music_app.services.listen_history_postgres import (
    PostgresListenHistoryAdapter,
    is_listen_history_postgres_available,
)
from music_app.services.listen_history import (
    is_scrobbled_listen_history_entry,
    load_listen_history,
)
from music_app.services.utils import safe_int


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
) -> dict[str, int]:
    normalized_track_refs = sorted({
        normalize_track_ref(track_ref)
        for track_ref in track_refs
        if normalize_track_ref(track_ref)
    })
    if not normalized_track_refs:
        return {}

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
