from __future__ import annotations

from music_app.services.source_helpers import field_from_source
from music_app.services.utils import safe_int


def _build_read_seam(
    *,
    source_kind: str,
    visibility_scope: str,
    background_refresh_policy: str,
) -> dict[str, str]:
    return {
        "source_kind": source_kind,
        "visibility_scope": visibility_scope,
        "read_mode": "cache_first",
        "request_fetch_policy": "never",
        "background_refresh_policy": background_refresh_policy,
    }


_CROWD_OPINION_READ_SEAM = _build_read_seam(
    source_kind="external_album_crowd_opinion_snapshot",
    visibility_scope="viewer_scoped",
    background_refresh_policy="background_only",
)
_FRIENDS_OPINION_READ_SEAM = _build_read_seam(
    source_kind="same_server_album_rating_projection",
    visibility_scope="same_server_viewer_scoped",
    background_refresh_policy="projection_refresh",
)
_POPULARITY_OVERLAY_READ_SEAM = _build_read_seam(
    source_kind="lastfm_popularity_snapshot",
    visibility_scope="viewer_scoped_with_crowd_preference",
    background_refresh_policy="scan_follow_up_or_stale_background",
)
_POPULARITY_BROWSE_READ_SEAM = _build_read_seam(
    source_kind="lastfm_popularity_projection",
    visibility_scope="viewer_scoped_with_crowd_preference",
    background_refresh_policy="scan_follow_up_or_stale_background",
)
_VIEWER_OPINION_PREFERENCE_READ_SEAM = {
    "source_kind": "viewer_opinion_preferences",
    "visibility_scope": "viewer_scoped",
    "read_mode": "state_backed_default",
    "request_fetch_policy": "never",
    "background_refresh_policy": "write_on_change_later",
}


def _bool_value(value: object, *, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().casefold() in {"1", "true", "yes", "on"}


def resolve_viewer_opinion_preferences(raw_preferences: object = None) -> dict[str, bool]:
    source = raw_preferences
    if not isinstance(source, dict):
        source = {}
    return {
        "show_crowd_opinion": _bool_value(source.get("show_crowd_opinion"), default=False),
        "show_friends_opinions": _bool_value(source.get("show_friends_opinions"), default=False),
    }


def build_viewer_opinion_preferences_payload(raw_preferences: object = None) -> dict[str, object]:
    resolved = resolve_viewer_opinion_preferences(raw_preferences)
    return {
        **resolved,
        "defaults": {
            "show_crowd_opinion": False,
            "show_friends_opinions": False,
        },
        "preference_scope": "viewer_scoped",
        "control_fields": [
            "show_crowd_opinion",
            "show_friends_opinions",
        ],
        "read_seam": dict(_VIEWER_OPINION_PREFERENCE_READ_SEAM),
    }


_CROWD_OPINION_DIRECT_KEYS = {
    "blended_score_10",
    "display_stars",
    "source_count_used",
    "source_count_total",
}
_FRIENDS_OPINION_DIRECT_KEYS = {"average_rating", "rating_count"}
_TRACK_POPULARITY_DIRECT_KEYS = {
    "scrobble_count",
    "listener_count",
    "loved_count",
    "match_key",
    "match_coverage_state",
    "metric_availability",
}
_ALBUM_POPULARITY_DIRECT_KEYS = {
    "scrobble_count",
    "listener_count",
    "matched_track_count",
    "total_track_count",
    "available_sort_metrics",
}
_ARTIST_POPULARITY_DIRECT_KEYS = {
    "scrobble_count",
    "listener_count",
    "available_sort_metrics",
}


def _nested_payload(source: object, field_name: str, *, direct_keys: set[str]) -> dict[str, object]:
    nested = field_from_source(source, field_name, None)
    if isinstance(nested, dict):
        return dict(nested)
    if isinstance(source, dict) and direct_keys.intersection(source):
        return dict(source)
    return {}


def build_crowd_opinion_payload(source: object, *, viewer_opinion_preferences: object = None) -> dict[str, object]:
    payload = _nested_payload(
        source,
        "crowd_opinion",
        direct_keys=_CROWD_OPINION_DIRECT_KEYS,
    )
    preferences = resolve_viewer_opinion_preferences(viewer_opinion_preferences)
    is_visible = preferences["show_crowd_opinion"] and bool(payload)
    return {
        "is_visible": is_visible,
        "blended_score_10": payload.get("blended_score_10") if is_visible else None,
        "display_stars": payload.get("display_stars") if is_visible else None,
        "source_count_used": safe_int(payload.get("source_count_used")) if is_visible else None,
        "source_count_total": safe_int(payload.get("source_count_total")) if is_visible else None,
        "freshness_state": str(payload.get("freshness_state") or "missing") if is_visible else "missing",
        "read_seam": dict(_CROWD_OPINION_READ_SEAM),
    }


def build_friends_opinion_payload(source: object, *, viewer_opinion_preferences: object = None) -> dict[str, object]:
    payload = _nested_payload(
        source,
        "friends_opinion",
        direct_keys=_FRIENDS_OPINION_DIRECT_KEYS,
    )
    preferences = resolve_viewer_opinion_preferences(viewer_opinion_preferences)
    is_visible = preferences["show_friends_opinions"] and bool(payload)
    return {
        "is_visible": is_visible,
        "average_rating": payload.get("average_rating") if is_visible else None,
        "rating_count": safe_int(payload.get("rating_count")) if is_visible else None,
        "freshness_state": str(payload.get("freshness_state") or "missing") if is_visible else "missing",
        "read_seam": dict(_FRIENDS_OPINION_READ_SEAM),
    }


def build_track_popularity_payload(source: object, *, viewer_opinion_preferences: object = None) -> dict[str, object]:
    payload = _nested_payload(
        source,
        "track_popularity",
        direct_keys=_TRACK_POPULARITY_DIRECT_KEYS,
    )
    preferences = resolve_viewer_opinion_preferences(viewer_opinion_preferences)
    is_visible = preferences["show_crowd_opinion"] and bool(payload)
    metric_availability = payload.get("metric_availability") if isinstance(payload.get("metric_availability"), dict) else {}
    return {
        "is_visible": is_visible,
        "scrobble_count": safe_int(payload.get("scrobble_count")) if is_visible else None,
        "listener_count": safe_int(payload.get("listener_count")) if is_visible else None,
        "loved_count": safe_int(payload.get("loved_count")) if is_visible else None,
        "match_key": payload.get("match_key") if is_visible else None,
        "match_coverage_state": str(payload.get("match_coverage_state") or "missing") if is_visible else "missing",
        "metric_availability": {
            "scrobbles": bool(metric_availability.get("scrobbles")) if is_visible else False,
            "listeners": bool(metric_availability.get("listeners")) if is_visible else False,
            "loved": bool(metric_availability.get("loved")) if is_visible else False,
        },
        "freshness_state": str(payload.get("freshness_state") or "missing") if is_visible else "missing",
        "read_seam": dict(_POPULARITY_OVERLAY_READ_SEAM),
    }


def build_album_popularity_payload(source: object, *, viewer_opinion_preferences: object = None) -> dict[str, object]:
    payload = _nested_payload(
        source,
        "album_popularity",
        direct_keys=_ALBUM_POPULARITY_DIRECT_KEYS,
    )
    preferences = resolve_viewer_opinion_preferences(viewer_opinion_preferences)
    is_visible = preferences["show_crowd_opinion"] and bool(payload)
    metrics = payload.get("available_sort_metrics")
    available_sort_metrics = [str(metric).strip() for metric in metrics or [] if str(metric).strip()] if is_visible else []
    return {
        "is_visible": is_visible,
        "scrobble_count": safe_int(payload.get("scrobble_count")) if is_visible else None,
        "listener_count": safe_int(payload.get("listener_count")) if is_visible else None,
        "matched_track_count": safe_int(payload.get("matched_track_count")) if is_visible else None,
        "total_track_count": safe_int(payload.get("total_track_count")) if is_visible else None,
        "available_sort_metrics": available_sort_metrics,
        "freshness_state": str(payload.get("freshness_state") or "missing") if is_visible else "missing",
        "read_seam": dict(_POPULARITY_OVERLAY_READ_SEAM),
    }


def build_artist_popularity_payload(source: object, *, viewer_opinion_preferences: object = None) -> dict[str, object]:
    payload = _nested_payload(
        source,
        "artist_popularity",
        direct_keys=_ARTIST_POPULARITY_DIRECT_KEYS,
    )
    preferences = resolve_viewer_opinion_preferences(viewer_opinion_preferences)
    is_visible = preferences["show_crowd_opinion"] and bool(payload)
    metrics = payload.get("available_sort_metrics")
    available_sort_metrics = [str(metric).strip() for metric in metrics or [] if str(metric).strip()] if is_visible else []
    return {
        "is_visible": is_visible,
        "scrobble_count": safe_int(payload.get("scrobble_count")) if is_visible else None,
        "listener_count": safe_int(payload.get("listener_count")) if is_visible else None,
        "available_sort_metrics": available_sort_metrics,
        "freshness_state": str(payload.get("freshness_state") or "missing") if is_visible else "missing",
        "read_seam": dict(_POPULARITY_OVERLAY_READ_SEAM),
    }


def build_popularity_browse_payload(*, viewer_opinion_preferences: object = None) -> dict[str, object]:
    preferences = resolve_viewer_opinion_preferences(viewer_opinion_preferences)
    return {
        "is_visible": preferences["show_crowd_opinion"],
        "read_seam": dict(_POPULARITY_BROWSE_READ_SEAM),
        "surfaces": [
            {
                "surface_id": "popular_albums",
                "label": "Popular Albums",
                "surface_kind": "album_top",
                "default_sort": "scrobbles_desc",
                "supported_sorts": ["scrobbles_desc", "listeners_desc"],
            },
            {
                "surface_id": "popular_artists",
                "label": "Popular Artists",
                "surface_kind": "artist_gallery",
                "default_sort": "scrobbles_desc",
                "supported_sorts": ["scrobbles_desc", "listeners_desc"],
            },
            {
                "surface_id": "popular_songs",
                "label": "Popular Songs",
                "surface_kind": "track_list",
                "default_sort": "scrobbles_desc",
                "supported_sorts": ["scrobbles_desc", "listeners_desc", "loved_desc"],
            },
        ],
    }


def build_crowd_opinion_modal_payload(
    album_ref: object,
    source: object = None,
) -> dict[str, object]:
    payload = _nested_payload(
        source,
        "crowd_opinion",
        direct_keys=_CROWD_OPINION_DIRECT_KEYS,
    )
    source_rows = payload.get("sources")
    if not isinstance(source_rows, list):
        source_rows = []
    return {
        "album_ref": str(album_ref or "").strip(),
        "detail_kind": "crowd_opinion_modal",
        "blended_score_10": payload.get("blended_score_10"),
        "source_count_used": safe_int(payload.get("source_count_used")),
        "source_count_total": safe_int(payload.get("source_count_total")),
        "sources": [
            {
                "source_name": str(row.get("source_name") or "").strip() or None,
                "raw_score": row.get("raw_score"),
                "raw_scale": str(row.get("raw_scale") or "").strip() or None,
                "normalized_score_10": row.get("normalized_score_10"),
                "rating_count": safe_int(row.get("rating_count")),
                "source_type": str(row.get("source_type") or "").strip() or None,
                "source_url": str(row.get("source_url") or "").strip() or None,
                "freshness_state": str(row.get("freshness_state") or "missing"),
                "last_fetched_at": row.get("last_fetched_at"),
            }
            for row in source_rows
            if isinstance(row, dict)
        ],
        "freshness_state": str(payload.get("freshness_state") or "missing"),
        "read_seam": dict(_CROWD_OPINION_READ_SEAM),
        "modal_contract": {
            "open_action": "crowd_rating_activate",
            "source_rows_field": "sources",
            "source_link_field": "source_url",
        },
    }
