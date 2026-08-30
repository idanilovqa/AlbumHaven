from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from config import (
    PERSISTENCE_BACKEND_FILE,
    PERSISTENCE_BACKEND_POSTGRES,
    PERSISTENCE_BACKEND_VALUES,
    PERSISTENCE_SEAM_IDS,
    persistence_backend_for,
)
from music_app.services.discovery_center_preferences_postgres import (
    is_discovery_center_preferences_postgres_available,
)
from music_app.services.discovery_lookup_snapshots_postgres import (
    is_discovery_lookup_snapshots_postgres_available,
)
from music_app.services.library_browse_postgres import is_library_browse_postgres_available
from music_app.services.library_inventory_postgres import is_library_inventory_postgres_available
from music_app.services.library_roots_postgres import is_library_roots_postgres_available
from music_app.services.lastfm_postgres import is_lastfm_postgres_available
from music_app.services.listen_history_postgres import is_listen_history_postgres_available
from music_app.services.cover_lookup_tasks_postgres import is_cover_lookup_tasks_postgres_available
from music_app.services.rule_state_postgres import is_rule_state_postgres_available
from music_app.services.saved_loops_postgres import is_saved_loops_postgres_available
from music_app.services.track_preferences_postgres import is_track_preferences_postgres_available


@dataclass(frozen=True)
class PersistenceAdapterSelection:
    seam_id: str
    requested_backend: str
    effective_backend: str
    fallback_reason: str = ""


_EMPTY_RUNTIME_PERSISTENCE_BACKENDS = {
    seam_id: frozenset() for seam_id in PERSISTENCE_SEAM_IDS
}

AVAILABLE_RUNTIME_PERSISTENCE_BACKENDS = MappingProxyType(_EMPTY_RUNTIME_PERSISTENCE_BACKENDS)


def _normalize_available_backends(
    available_backends: object,
) -> dict[str, frozenset[str]]:
    if available_backends is None:
        return dict(AVAILABLE_RUNTIME_PERSISTENCE_BACKENDS)
    if not isinstance(available_backends, dict):
        raise ValueError("available_backends must be a mapping of seam ids to backend sets.")
    normalized: dict[str, frozenset[str]] = {}
    for seam_id, backends in available_backends.items():
        normalized_seam_id = str(seam_id or "").strip()
        if normalized_seam_id not in PERSISTENCE_SEAM_IDS:
            raise ValueError(f"Unknown persistence seam: {normalized_seam_id}")
        if not isinstance(backends, (set, frozenset, tuple, list)):
            raise ValueError(f"Backends for {normalized_seam_id} must be a collection.")
        normalized_backends = frozenset(str(backend or "").strip().lower() for backend in backends)
        unsupported = sorted(normalized_backends - PERSISTENCE_BACKEND_VALUES)
        if unsupported:
            raise ValueError(
                f"Unsupported persistence backend for {normalized_seam_id}: {', '.join(unsupported)}"
            )
        normalized[normalized_seam_id] = normalized_backends
    return normalized


def _available_runtime_backends_for_config(config: dict[str, object] | None) -> dict[str, frozenset[str]]:
    from music_app.services.scan_cache_persistence import is_scan_cache_postgres_available

    available_backends = dict(AVAILABLE_RUNTIME_PERSISTENCE_BACKENDS)
    if is_rule_state_postgres_available(config):
        for seam_id in (
            "ignored_versions",
            "ignored_repairs",
            "manual_versions",
            "separate_releases",
            "exception_overrides",
        ):
            available_backends[seam_id] = frozenset(
                {PERSISTENCE_BACKEND_POSTGRES}
            )
    if is_track_preferences_postgres_available(config):
        available_backends["track_preferences"] = frozenset(
            {PERSISTENCE_BACKEND_POSTGRES}
        )
    if is_library_browse_postgres_available(config):
        available_backends["library_browse"] = frozenset(
            {PERSISTENCE_BACKEND_POSTGRES}
        )
    if is_library_inventory_postgres_available(config):
        available_backends["library_inventory"] = frozenset(
            {PERSISTENCE_BACKEND_POSTGRES}
        )
    if is_library_roots_postgres_available(config):
        available_backends["library_roots"] = frozenset(
            {PERSISTENCE_BACKEND_POSTGRES}
        )
    if is_scan_cache_postgres_available(config):
        available_backends["scan_cache"] = frozenset(
            {PERSISTENCE_BACKEND_POSTGRES}
        )
    if is_lastfm_postgres_available(config):
        for seam_id in ("lastfm_settings", "lastfm_sync_state"):
            available_backends[seam_id] = frozenset(
                {PERSISTENCE_BACKEND_POSTGRES}
            )
    if is_listen_history_postgres_available(config):
        available_backends["listen_history"] = frozenset(
            {PERSISTENCE_BACKEND_POSTGRES}
        )
    if is_cover_lookup_tasks_postgres_available(config):
        available_backends["cover_lookup_tasks"] = frozenset(
            {PERSISTENCE_BACKEND_POSTGRES}
        )
    if is_saved_loops_postgres_available(config):
        available_backends["saved_loops"] = frozenset(
            {PERSISTENCE_BACKEND_POSTGRES}
        )
    if is_discovery_center_preferences_postgres_available(config):
        available_backends["discovery_center_preferences"] = frozenset(
            {PERSISTENCE_BACKEND_POSTGRES}
        )
    if is_discovery_lookup_snapshots_postgres_available(config):
        available_backends["discovery_lookup_snapshots"] = frozenset(
            {PERSISTENCE_BACKEND_POSTGRES}
        )
    return available_backends


def select_runtime_persistence_adapter(
    seam_id: str,
    config: dict[str, object] | None = None,
    *,
    available_backends: object = None,
) -> PersistenceAdapterSelection:
    requested_backend = persistence_backend_for(seam_id, config)
    normalized_seam_id = str(seam_id or "").strip()
    runtime_available_backends = (
        _available_runtime_backends_for_config(config)
        if available_backends is None
        else available_backends
    )
    registered_backends = _normalize_available_backends(runtime_available_backends).get(
        normalized_seam_id,
        frozenset(),
    )
    if requested_backend in registered_backends:
        return PersistenceAdapterSelection(
            seam_id=normalized_seam_id,
            requested_backend=requested_backend,
            effective_backend=requested_backend,
        )
    if requested_backend == PERSISTENCE_BACKEND_POSTGRES:
        raise ValueError(
            f"Postgres runtime persistence adapter is unavailable for {normalized_seam_id}."
        )
    if requested_backend == PERSISTENCE_BACKEND_FILE:
        raise ValueError(
            f"File runtime persistence is not supported for {normalized_seam_id}; "
            "Album Haven runtime persistence is Postgres-only."
        )
    raise ValueError(
        f"{requested_backend} runtime persistence adapter is unavailable for {normalized_seam_id}."
    )


def create_runtime_library_inventory_repository(
    config: dict[str, object],
    *,
    connect: Callable[[str], Any] | None = None,
) -> object:
    selection = select_runtime_persistence_adapter("library_inventory", config)
    if selection.effective_backend != PERSISTENCE_BACKEND_POSTGRES:
        raise ValueError("Postgres is required for the selected library inventory repository.")
    from music_app.services.library_inventory_postgres import PostgresLibraryInventoryRepository

    return PostgresLibraryInventoryRepository(config, connect=connect)
