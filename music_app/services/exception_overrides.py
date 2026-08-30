from __future__ import annotations

from music_app.services.metadata import normalize_exception_value
from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.rule_state_postgres import RuleStatePostgresAdapter


def load_exception_overrides(config: dict[str, object]) -> dict[str, str]:
    select_runtime_persistence_adapter("exception_overrides", config)
    return RuleStatePostgresAdapter(config).load_exception_overrides()


def save_exception_overrides(config: dict[str, object], overrides: dict[str, str]) -> None:
    select_runtime_persistence_adapter("exception_overrides", config)
    RuleStatePostgresAdapter(config).save_exception_overrides(overrides)
    from music_app.services.library_browse_postgres import invalidate_postgres_utility_projection_cache

    invalidate_postgres_utility_projection_cache(
        database_url=config.get("ALBUM_HAVEN_APP_DATABASE_URL"),
        kinds=("problematic-files",),
    )


def set_track_exception_override(config: dict[str, object], track_path: str, exception_value: object) -> str:
    normalized_updates = set_track_exception_overrides(
        config,
        {track_path: exception_value},
    )
    return normalized_updates.get(str(track_path or "").strip(), "")


def set_track_exception_overrides(
    config: dict[str, object],
    updates: dict[str, object],
) -> dict[str, str]:
    normalized_updates: dict[str, str] = {}
    for track_path, exception_value in updates.items():
        path_key = str(track_path or "").strip()
        if not path_key:
            continue
        normalized_updates[path_key] = normalize_exception_value(exception_value)
    if not normalized_updates:
        return {}

    select_runtime_persistence_adapter("exception_overrides", config)
    RuleStatePostgresAdapter(config).upsert_exception_overrides(normalized_updates)
    from music_app.services.library_browse_postgres import invalidate_postgres_utility_projection_cache

    invalidate_postgres_utility_projection_cache(
        database_url=config.get("ALBUM_HAVEN_APP_DATABASE_URL"),
        kinds=("problematic-files",),
    )
    return normalized_updates


def apply_exception_override(entry: dict[str, object], overrides: dict[str, str]) -> dict[str, object]:
    if not isinstance(entry, dict):
        return entry
    path_key = str(entry.get("path") or "").strip()
    if path_key and path_key in overrides:
        entry["exception_type"] = overrides[path_key] or None
    return entry
