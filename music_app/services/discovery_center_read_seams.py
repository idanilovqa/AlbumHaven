from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import threading
from typing import Protocol
from uuid import uuid4

from music_app.services.discovery_center_preferences_postgres import (
    DiscoveryCenterPreferencesPostgresAdapter,
)
from music_app.services.discovery_lookup_snapshots_postgres import (
    PostgresDiscoveryLookupSnapshotStore,
)
from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.remote_discovery_contracts import (
    build_remote_discovery_lookup_contract,
    build_remote_discovery_route_family,
    normalize_remote_discovery_lookup_request,
)

_SUPPORTED_TABS = ("inbox", "history", "insights")
_SUPPORTED_SOURCES = ("all", "release", "suggestion", "research")
_SUPPORTED_INSIGHT_WINDOWS = ("week", "month", "6_months", "year", "lifetime")
_RECENT_LOOKUP_SNAPSHOT_LIMIT = 25
_LOOKUP_SNAPSHOT_ROWS_LOCK = threading.Lock()
_LOOKUP_SNAPSHOT_STORE_CONFIG_KEY = "DISCOVERY_LOOKUP_SNAPSHOT_STORE"

_DEFAULT_PREFERENCES = {
    "source_toggles": {
        "release": True,
        "suggestion": True,
        "research": True,
    },
    "delivery": {
        "toast_notifications_enabled": True,
        "quiet_hours": {
            "enabled": False,
            "start": "22:00",
            "end": "08:00",
        },
    },
}


class DiscoveryLookupSnapshotStore(Protocol):
    def load_snapshot_rows(self) -> list[dict[str, object]]:
        ...

    def save_snapshot_rows(self, rows: list[dict[str, object]]) -> None:
        ...


def _normalize_tab(tab: object) -> str:
    normalized = str(tab or "").strip().casefold()
    return normalized if normalized in _SUPPORTED_TABS else "inbox"


def _normalize_source(source: object) -> str:
    normalized = str(source or "").strip().casefold()
    return normalized if normalized in _SUPPORTED_SOURCES else "all"


def _normalize_insight_window(window: object) -> str:
    normalized = str(window or "").strip().casefold()
    return normalized if normalized in _SUPPORTED_INSIGHT_WINDOWS else "month"


def _normalize_bool(value: object, *, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().casefold()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return default


def build_discovery_center_entry_contract() -> dict[str, object]:
    return {
        "view_states": ["unseen", "seen", "cleared"],
        "entry_kinds": ["release", "suggestion", "research"],
        "release_fields": [
            "release_date",
            "release_date_precision",
            "release_timing_state",
            "countdown_target_at",
        ],
        "suggestion_fields": [
            "subject_key",
            "reason_payload",
            "action_taken_at",
        ],
    }


def build_discovery_center_summary_payload() -> dict[str, object]:
    return {
        "page_route": "/news",
        "badge": {
            "kind": "discovery_center",
            "unseen_count": 0,
            "has_unseen": False,
            "unseen_entry_refs": [],
        },
        "drawer_preview": {
            "content_kind": "discovery_center_preview",
            "active_tab": "inbox",
            "active_source": "all",
            "supported_sources": list(_SUPPORTED_SOURCES),
            "preview_limit": 5,
            "entries": [],
            "empty_state": {
                "headline": "Nothing is waiting in Discovery Center yet.",
                "detail": (
                    "Phase 3 now exposes the private route and payload seams for later "
                    "release, suggestion, and research entries."
                ),
            },
            "footer_cta": {
                "href": "/news?tab=inbox",
                "label": "Open Discovery Center",
            },
        },
        "entry_contract": build_discovery_center_entry_contract(),
    }


def build_discovery_center_entries_payload(
    *,
    tab: object = None,
    source: object = None,
) -> dict[str, object]:
    active_tab = _normalize_tab(tab)
    active_source = _normalize_source(source)
    if active_tab == "insights":
        active_source = "all"
    return {
        "page_kind": "discovery_center_entries",
        "page_route": "/news",
        "active_tab": active_tab,
        "active_source": active_source,
        "supported_tabs": list(_SUPPORTED_TABS),
        "supported_sources": list(_SUPPORTED_SOURCES),
        "entries": [],
        "empty_state": {
            "headline": "No Discovery Center entries yet.",
            "detail": (
                "This read seam is ready for later release alerts, local suggestions, "
                "and research rows without merging them into one source of truth."
            ),
        },
        "entry_contract": build_discovery_center_entry_contract(),
    }


def build_discovery_center_insights_payload(*, window: object = None) -> dict[str, object]:
    return {
        "page_kind": "discovery_center_insights",
        "active_window": _normalize_insight_window(window),
        "supported_windows": list(_SUPPORTED_INSIGHT_WINDOWS),
        "cards": [],
        "empty_state": {
            "headline": "Insights will arrive in later phases.",
            "detail": (
                "The full-page route seam exists now so later private listening insight "
                "reads do not have to piggyback on drawer preview payloads."
            ),
        },
    }


def build_discovery_center_page_payload(
    *,
    tab: object = None,
    source: object = None,
) -> dict[str, object]:
    active_tab = _normalize_tab(tab)
    active_source = _normalize_source(source)
    if active_tab == "insights":
        active_source = "all"
    return {
        "page_kind": "discovery_center",
        "page_route": "/news",
        "page_title": "Discovery Center",
        "page_subtitle": (
            "Private release, suggestion, and research seams live here while later "
            "phases add persistence, policy, and provider-backed jobs."
        ),
        "active_tab": active_tab,
        "active_source": active_source,
        "supported_tabs": list(_SUPPORTED_TABS),
        "supported_sources": list(_SUPPORTED_SOURCES),
        "summary_route": "/news-center/summary",
        "entries_route": f"/news-center/entries?tab={active_tab}&source={active_source}",
        "insights_route": "/news-center/insights?window=month",
        "preferences_route": "/news-center/preferences",
        "lookup_create_route": "/discovery-lookups",
        "recent_lookups_route": "/discovery-lookups/recent",
        "lookup_contract": build_remote_discovery_lookup_contract(),
        "summary": build_discovery_center_summary_payload(),
        "entries_preview": build_discovery_center_entries_payload(
            tab=active_tab,
            source=active_source,
        ),
        "insights_preview": build_discovery_center_insights_payload(),
    }


def _normalize_preferences(raw_payload: object) -> dict[str, object]:
    if not isinstance(raw_payload, dict):
        raw_payload = {}
    payload = deepcopy(_DEFAULT_PREFERENCES)
    raw_source_toggles = raw_payload.get("source_toggles")
    if isinstance(raw_source_toggles, dict):
        for key in ("release", "suggestion", "research"):
            payload["source_toggles"][key] = _normalize_bool(
                raw_source_toggles.get(key),
                default=payload["source_toggles"][key],
            )
    raw_delivery = raw_payload.get("delivery")
    if isinstance(raw_delivery, dict):
        payload["delivery"]["toast_notifications_enabled"] = _normalize_bool(
            raw_delivery.get("toast_notifications_enabled"),
            default=payload["delivery"]["toast_notifications_enabled"],
        )
        raw_quiet_hours = raw_delivery.get("quiet_hours")
        if isinstance(raw_quiet_hours, dict):
            payload["delivery"]["quiet_hours"] = {
                "enabled": _normalize_bool(
                    raw_quiet_hours.get("enabled"),
                    default=payload["delivery"]["quiet_hours"]["enabled"],
                ),
                "start": str(
                    raw_quiet_hours.get("start")
                    or payload["delivery"]["quiet_hours"]["start"]
                ).strip()
                or payload["delivery"]["quiet_hours"]["start"],
                "end": str(
                    raw_quiet_hours.get("end")
                    or payload["delivery"]["quiet_hours"]["end"]
                ).strip()
                or payload["delivery"]["quiet_hours"]["end"],
            }
    return payload


def build_discovery_center_preferences_payload(config: dict[str, object]) -> dict[str, object]:
    select_runtime_persistence_adapter("discovery_center_preferences", config)
    stored_payload = DiscoveryCenterPreferencesPostgresAdapter(config).load_preferences()
    normalized = _normalize_preferences(stored_payload)
    return {
        "preference_scope": "local_first_single_viewer",
        "supports_multi_user_persistence": False,
        **normalized,
    }


def save_discovery_center_preferences(
    config: dict[str, object],
    raw_payload: object,
) -> dict[str, object]:
    select_runtime_persistence_adapter("discovery_center_preferences", config)
    normalized = DiscoveryCenterPreferencesPostgresAdapter(config).save_preferences(raw_payload)
    return {
        "preference_scope": "local_first_single_viewer",
        "supports_multi_user_persistence": False,
        **_normalize_preferences(normalized),
    }


def _normalize_lookup_request(raw_payload: object) -> dict[str, object]:
    return normalize_remote_discovery_lookup_request(
        raw_payload,
        normalize_bool=_normalize_bool,
    )


def _load_lookup_snapshots(config: dict[str, object]) -> list[dict[str, object]]:
    return [
        item
        for item in _lookup_snapshot_store(config).load_snapshot_rows()
        if isinstance(item, dict)
    ]


def _save_lookup_snapshots(config: dict[str, object], items: list[dict[str, object]]) -> None:
    _lookup_snapshot_store(config).save_snapshot_rows(items)


def _lookup_snapshot_store(config: dict[str, object]) -> DiscoveryLookupSnapshotStore:
    configured_store = config.get(_LOOKUP_SNAPSHOT_STORE_CONFIG_KEY)
    if configured_store is not None:
        return configured_store  # type: ignore[return-value]
    select_runtime_persistence_adapter("discovery_lookup_snapshots", config)
    return PostgresDiscoveryLookupSnapshotStore(config)


def _build_lookup_snapshot_row(payload: dict[str, object]) -> dict[str, object]:
    return {
        "lookup_ref": str(payload.get("lookup_ref") or "").strip(),
        "created_at": str(payload.get("created_at") or "").strip(),
        "status": str(payload.get("status") or "").strip(),
        "request": dict(payload.get("request") or {})
        if isinstance(payload.get("request"), dict)
        else {},
        "results": list(payload.get("results") or [])
        if isinstance(payload.get("results"), list)
        else [],
    }


def _build_lookup_detail_from_snapshot(item: dict[str, object]) -> dict[str, object]:
    lookup_ref = str(item.get("lookup_ref") or "").strip()
    return {
        "lookup_ref": lookup_ref,
        "created_at": str(item.get("created_at") or "").strip(),
        "status": str(item.get("status") or "pending_source_integration").strip(),
        "request": dict(item.get("request") or {})
        if isinstance(item.get("request"), dict)
        else {},
        **build_remote_discovery_lookup_contract(),
        "results": list(item.get("results") or [])
        if isinstance(item.get("results"), list)
        else [],
        "empty_state": {
            "headline": "Discovery lookup transport is ready.",
            "detail": (
                "Phase 3 keeps this lookup user-invoked and temporary while later phases "
                "add provider-backed discovery and refresh policy."
            ),
        },
        "route_family": build_remote_discovery_route_family(lookup_ref=lookup_ref),
        "provenance": {
            "lookup_kind": "temporary_user_invoked",
            "refresh_model": "stale_on_read_placeholder",
        },
    }


def create_discovery_lookup_payload(
    config: dict[str, object],
    raw_payload: object,
) -> dict[str, object]:
    lookup_ref = f"lookup-{uuid4().hex[:12]}"
    created_at = datetime.now(timezone.utc).isoformat()
    request_payload = _normalize_lookup_request(raw_payload)
    payload = {
        "lookup_ref": lookup_ref,
        "created_at": created_at,
        "status": "pending_source_integration",
        "request": request_payload,
        **build_remote_discovery_lookup_contract(),
        "results": [],
        "empty_state": {
            "headline": "Discovery lookup transport is ready.",
            "detail": (
                "Phase 3 keeps this lookup user-invoked and temporary while later phases "
                "add provider-backed discovery and refresh policy."
            ),
        },
        "route_family": build_remote_discovery_route_family(lookup_ref=lookup_ref),
        "provenance": {
            "lookup_kind": "temporary_user_invoked",
            "refresh_model": "stale_on_read_placeholder",
        },
    }
    with _LOOKUP_SNAPSHOT_ROWS_LOCK:
        items = _load_lookup_snapshots(config)
        items.insert(0, _build_lookup_snapshot_row(payload))
        items = items[:_RECENT_LOOKUP_SNAPSHOT_LIMIT]
        _save_lookup_snapshots(config, items)
    return payload


def build_discovery_lookup_payload(
    config: dict[str, object],
    lookup_ref: object,
) -> dict[str, object] | None:
    normalized_ref = str(lookup_ref or "").strip()
    if not normalized_ref:
        return None
    with _LOOKUP_SNAPSHOT_ROWS_LOCK:
        for item in _load_lookup_snapshots(config):
            if str(item.get("lookup_ref") or "").strip() == normalized_ref:
                return _build_lookup_detail_from_snapshot(item)
    return None


def build_recent_discovery_lookup_payload(config: dict[str, object]) -> dict[str, object]:
    with _LOOKUP_SNAPSHOT_ROWS_LOCK:
        items = _load_lookup_snapshots(config)
    return {
        "lookups": [
            {
                "lookup_ref": str(item.get("lookup_ref") or "").strip(),
                "detail_route": build_remote_discovery_route_family(
                    lookup_ref=str(item.get("lookup_ref") or "").strip()
                ).get("detail", ""),
                "result_kind": str(item.get("request", {}).get("result_kind") or "").strip(),
                "genre_query": str(item.get("request", {}).get("genre_query") or "").strip(),
                "status": str(item.get("status") or "").strip(),
                "created_at": str(item.get("created_at") or "").strip(),
            }
            for item in items
        ]
    }
