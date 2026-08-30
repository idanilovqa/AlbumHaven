from __future__ import annotations

from threading import RLock
from time import monotonic

from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.rule_state_postgres import RuleStatePostgresAdapter


_CACHE_TTL_SECONDS = 5.0
_CACHE_LOCK = RLock()
_MANUAL_VERSION_LINKS_CACHE: dict[tuple[object, ...], tuple[float, dict[str, str]]] = {}


def _cache_key(config: dict) -> tuple[object, ...]:
    return (
        id(config),
        str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""),
        repr(config.get("PERSISTENCE_BACKENDS")),
        str(config.get("DATA_DIR") or ""),
    )


def _cached_manual_version_links(config: dict) -> dict[str, str] | None:
    key = _cache_key(config)
    now = monotonic()
    with _CACHE_LOCK:
        cached = _MANUAL_VERSION_LINKS_CACHE.get(key)
        if cached is None:
            return None
        cached_at, links = cached
        if now - cached_at > _CACHE_TTL_SECONDS:
            _MANUAL_VERSION_LINKS_CACHE.pop(key, None)
            return None
        return dict(links)


def _store_manual_version_links_cache(config: dict, manual_version_links: dict[str, str]) -> None:
    key = _cache_key(config)
    normalized_links = _normalize_manual_version_links(manual_version_links)
    with _CACHE_LOCK:
        _MANUAL_VERSION_LINKS_CACHE.clear()
        _MANUAL_VERSION_LINKS_CACHE[key] = (monotonic(), normalized_links)


def _normalize_manual_version_links(manual_version_links: dict[str, str]) -> dict[str, str]:
    normalized_links: dict[str, str] = {}
    for child_key, parent_key in (manual_version_links or {}).items():
        child = str(child_key or "").strip()
        parent = str(parent_key or "").strip()
        if child and parent and child != parent:
            normalized_links[child] = parent
    return normalized_links


def load_manual_version_links(config: dict) -> dict[str, str]:
    with _CACHE_LOCK:
        cached_links = _cached_manual_version_links(config)
        if cached_links is not None:
            return cached_links
        select_runtime_persistence_adapter("manual_versions", config)
        manual_version_links = RuleStatePostgresAdapter(config).load_manual_version_links()
        _store_manual_version_links_cache(config, manual_version_links)
        return dict(manual_version_links)


def save_manual_version_links(config: dict, manual_version_links: dict[str, str]) -> None:
    with _CACHE_LOCK:
        select_runtime_persistence_adapter("manual_versions", config)
        RuleStatePostgresAdapter(config).save_manual_version_links(manual_version_links)
        _store_manual_version_links_cache(config, manual_version_links)
