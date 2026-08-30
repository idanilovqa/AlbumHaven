from __future__ import annotations

from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.rule_state_postgres import (
    RuleStatePostgresAdapter,
    is_rule_state_postgres_available,
)


def migrate_legacy_album_exclusions(config: dict) -> dict[str, int]:
    result = {
        "migrated_album_count": 0,
        "removed_legacy_rule_count": 0,
        "created_album_rule_count": 0,
    }
    if not is_rule_state_postgres_available(config):
        return result

    from music_app.routes.api_rules_helpers import text_problem_reason
    from music_app.services.library_browse_postgres import (
        _problem_identity_row_key,
        invalidate_postgres_utility_projection_cache,
    )

    adapter = RuleStatePostgresAdapter(config)
    groups = adapter.load_complete_legacy_album_exclusion_groups()
    if not groups:
        return result

    existing_keys = adapter.load_ignored_repair_keys()
    legacy_keys_to_remove: set[str] = set()
    album_keys_by_repair_key: dict[str, str] = {}
    migrated_album_keys: set[str] = set()
    for group in groups:
        album_key = str(group.get("album_key") or "").strip()
        reason = text_problem_reason("Album", str(group.get("album_title") or ""))
        group_legacy_keys = {
            str(value or "").strip()
            for value in group.get("legacy_repair_keys") or []
            if str(value or "").strip() in existing_keys
        }
        if not album_key or not reason or not group_legacy_keys:
            continue
        album_rule_key = _problem_identity_row_key(album_key, reason, scope="album")
        legacy_keys_to_remove.update(group_legacy_keys)
        album_keys_by_repair_key[album_rule_key] = album_key
        migrated_album_keys.add(album_key)

    if not legacy_keys_to_remove:
        return result

    migrated_keys = existing_keys.difference(legacy_keys_to_remove)
    migrated_keys.update(album_keys_by_repair_key)
    adapter.save_ignored_repair_keys(
        migrated_keys,
        album_keys_by_repair_key=album_keys_by_repair_key,
    )
    invalidate_postgres_utility_projection_cache(
        database_url=config.get("ALBUM_HAVEN_APP_DATABASE_URL"),
        kinds=("problematic-files", "rules"),
    )
    return {
        "migrated_album_count": len(migrated_album_keys),
        "removed_legacy_rule_count": len(legacy_keys_to_remove),
        "created_album_rule_count": len(album_keys_by_repair_key),
    }


def load_ignored_repair_keys(config: dict) -> set[str]:
    select_runtime_persistence_adapter("ignored_repairs", config)
    return RuleStatePostgresAdapter(config).load_ignored_repair_keys()


def save_ignored_repair_keys(
    config: dict,
    ignored_row_keys: set[str],
    *,
    album_keys_by_repair_key: dict[str, str] | None = None,
) -> None:
    select_runtime_persistence_adapter("ignored_repairs", config)
    adapter = RuleStatePostgresAdapter(config)
    if album_keys_by_repair_key:
        adapter.save_ignored_repair_keys(
            ignored_row_keys,
            album_keys_by_repair_key=album_keys_by_repair_key,
        )
    else:
        adapter.save_ignored_repair_keys(ignored_row_keys)
    from music_app.services.library_browse_postgres import invalidate_postgres_utility_projection_cache

    invalidate_postgres_utility_projection_cache(
        database_url=config.get("ALBUM_HAVEN_APP_DATABASE_URL"),
        kinds=("problematic-files", "rules"),
    )


def create_ignored_repair_keys(
    config: dict,
    row_keys: set[str],
    *,
    album_keys_by_repair_key: dict[str, str] | None = None,
    remove_row_keys: set[str] | None = None,
) -> None:
    select_runtime_persistence_adapter("ignored_repairs", config)
    RuleStatePostgresAdapter(config).upsert_ignored_repair_keys(
        row_keys,
        album_keys_by_repair_key=album_keys_by_repair_key,
        remove_repair_keys=remove_row_keys or set(),
    )
    _invalidate_ignored_repair_projections(config)


def delete_ignored_repair_keys(config: dict, row_keys: set[str]) -> None:
    select_runtime_persistence_adapter("ignored_repairs", config)
    RuleStatePostgresAdapter(config).delete_ignored_repair_keys(row_keys)
    _invalidate_ignored_repair_projections(config)


def _invalidate_ignored_repair_projections(config: dict) -> None:
    from music_app.services.library_browse_postgres import invalidate_postgres_utility_projection_cache

    invalidate_postgres_utility_projection_cache(
        database_url=config.get("ALBUM_HAVEN_APP_DATABASE_URL"),
        kinds=("problematic-files", "rules"),
    )


def update_ignored_repair_key(config: dict, row_key: str, ignored: bool) -> set[str]:
    row_key = str(row_key or "").strip()
    ignored_row_keys = load_ignored_repair_keys(config)
    if not row_key:
        return ignored_row_keys
    if ignored:
        ignored_row_keys.add(row_key)
    else:
        ignored_row_keys.discard(row_key)
    save_ignored_repair_keys(config, ignored_row_keys)
    return ignored_row_keys
