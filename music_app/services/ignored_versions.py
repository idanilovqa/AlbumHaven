from __future__ import annotations

from collections.abc import Iterable
from threading import RLock
from time import monotonic

from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.rule_state_postgres import RuleStatePostgresAdapter


_CACHE_TTL_SECONDS = 5.0
_CACHE_LOCK = RLock()
_IGNORED_VERSION_KEYS_CACHE: dict[tuple[object, ...], tuple[float, set[str]]] = {}


def _cache_key(config: dict) -> tuple[object, ...]:
    return (
        id(config),
        str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""),
        repr(config.get("PERSISTENCE_BACKENDS")),
        str(config.get("DATA_DIR") or ""),
    )


def _cached_ignored_version_keys(config: dict) -> set[str] | None:
    key = _cache_key(config)
    now = monotonic()
    with _CACHE_LOCK:
        cached = _IGNORED_VERSION_KEYS_CACHE.get(key)
        if cached is None:
            return None
        cached_at, keys = cached
        if now - cached_at > _CACHE_TTL_SECONDS:
            _IGNORED_VERSION_KEYS_CACHE.pop(key, None)
            return None
        return set(keys)


def _store_ignored_version_keys_cache(config: dict, ignored_version_keys: Iterable[object]) -> None:
    key = _cache_key(config)
    normalized_keys = _normalize_ignored_version_keys(ignored_version_keys)
    with _CACHE_LOCK:
        _IGNORED_VERSION_KEYS_CACHE.clear()
        _IGNORED_VERSION_KEYS_CACHE[key] = (monotonic(), normalized_keys)


def _normalize_ignored_version_keys(ignored_version_keys: Iterable[object] | None) -> set[str]:
    if ignored_version_keys is None:
        return set()
    return {
        key
        for value in ignored_version_keys
        if (key := str(value or "").strip())
    }


def load_ignored_version_keys(config: dict) -> set[str]:
    with _CACHE_LOCK:
        cached_keys = _cached_ignored_version_keys(config)
        if cached_keys is not None:
            return cached_keys
        select_runtime_persistence_adapter("ignored_versions", config)
        ignored_version_keys = RuleStatePostgresAdapter(config).load_ignored_version_keys()
        _store_ignored_version_keys_cache(config, ignored_version_keys)
        return set(ignored_version_keys)


def save_ignored_version_keys(config: dict, ignored_version_keys: set[str]) -> None:
    with _CACHE_LOCK:
        select_runtime_persistence_adapter("ignored_versions", config)
        RuleStatePostgresAdapter(config).save_ignored_version_keys(ignored_version_keys)
        _store_ignored_version_keys_cache(config, ignored_version_keys)
    from music_app.services.library_browse_postgres import invalidate_postgres_utility_projection_cache

    invalidate_postgres_utility_projection_cache(
        database_url=config.get("ALBUM_HAVEN_APP_DATABASE_URL"),
        kinds=("rules",),
    )
