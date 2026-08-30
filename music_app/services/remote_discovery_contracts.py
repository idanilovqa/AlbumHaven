from __future__ import annotations

from collections.abc import Callable


_SUPPORTED_RESULT_KINDS = ("artists", "albums", "tracks")
_SUPPORTED_TRACK_RESULT_MODES = ("raw_ranked", "artist_capped")
_SUPPORTED_LOOKUP_INTENTS = (
    "auto",
    "generic_genre",
    "soundtrack_collection",
    "soundtrack_score",
    "anime_soundtrack",
)
_DEFAULT_RESULT_KIND = "tracks"
_DEFAULT_TRACK_RESULT_MODE = "raw_ranked"
_DEFAULT_LOOKUP_INTENT = "auto"
_ROUTE_FAMILY = "/discovery-lookups"


def _normalize_text(value: object) -> str:
    return str(value or "").strip()


def normalize_remote_discovery_lookup_request(
    raw_payload: object,
    *,
    normalize_bool: Callable[..., bool],
) -> dict[str, object]:
    if not isinstance(raw_payload, dict):
        raw_payload = {}
    result_kind = _normalize_text(raw_payload.get("result_kind")).casefold()
    if result_kind not in _SUPPORTED_RESULT_KINDS:
        result_kind = _DEFAULT_RESULT_KIND
    lookup_intent = _normalize_text(raw_payload.get("lookup_intent")).casefold()
    if lookup_intent not in _SUPPORTED_LOOKUP_INTENTS:
        lookup_intent = _DEFAULT_LOOKUP_INTENT
    track_result_mode = _normalize_text(
        raw_payload.get("track_result_mode")
    ).casefold()
    if track_result_mode not in _SUPPORTED_TRACK_RESULT_MODES:
        track_result_mode = _DEFAULT_TRACK_RESULT_MODE
    try:
        max_tracks_per_artist = int(raw_payload.get("max_tracks_per_artist"))
    except (TypeError, ValueError):
        max_tracks_per_artist = None
    try:
        year_from = int(raw_payload.get("year_from"))
    except (TypeError, ValueError):
        year_from = None
    try:
        year_to = int(raw_payload.get("year_to"))
    except (TypeError, ValueError):
        year_to = None
    decade = _normalize_text(raw_payload.get("decade")) or None
    return {
        "result_kind": result_kind,
        "genre_query": _normalize_text(raw_payload.get("genre_query")),
        "lookup_intent": lookup_intent,
        "track_result_mode": track_result_mode,
        "max_tracks_per_artist": max_tracks_per_artist,
        "exclude_local_library": normalize_bool(
            raw_payload.get("exclude_local_library"),
            default=False,
        ),
        "year_from": year_from,
        "year_to": year_to,
        "decade": decade,
    }


def build_remote_discovery_request_contract() -> dict[str, object]:
    return {
        "supported_result_kinds": list(_SUPPORTED_RESULT_KINDS),
        "default_result_kind": _DEFAULT_RESULT_KIND,
        "supported_lookup_intents": list(_SUPPORTED_LOOKUP_INTENTS),
        "default_lookup_intent": _DEFAULT_LOOKUP_INTENT,
        "supported_track_result_modes": list(_SUPPORTED_TRACK_RESULT_MODES),
        "default_track_result_mode": _DEFAULT_TRACK_RESULT_MODE,
        "supports_year_range": True,
        "supports_decade_filter": True,
        "supports_local_library_exclusion": True,
    }


def build_remote_discovery_result_contract() -> dict[str, object]:
    return {
        "default_track_result_mode": _DEFAULT_TRACK_RESULT_MODE,
        "supported_track_result_modes": list(_SUPPORTED_TRACK_RESULT_MODES),
        "identity_fields": [
            "raw_name",
            "display_name",
            "normalized_name",
            "normalized_match_key",
        ],
        "transliteration_fields": [
            "transliteration_variants",
            "romanized_name",
        ],
        "normalization_flag_field": "normalization_flags",
        "match_confidence_field": "match_confidence",
        "album_context_fields": [
            "album_title",
            "album_ref",
            "album_match_state",
            "album_resolution_reason",
        ],
        "local_library_state_fields": [
            "local_match_state",
            "excluded_by_local_library",
        ],
        "viewer_scope": "visitor_safe",
        "track_row_mode": "raw_ranked_discovery_rows",
        "playlist_equivalence": "not_playlist_items",
    }


def build_shared_title_normalization_contract() -> dict[str, object]:
    return {
        "owner": "shared_title_normalization",
        "applies_to": [
            "remote_discovery",
            "artist_popularity",
            "lastfm_sync",
            "local_library_matching",
        ],
        "identity_fields": [
            "raw_name",
            "display_name",
            "normalized_name",
            "normalized_match_key",
        ],
        "preserved_variant_kinds": [
            "live",
            "demo",
            "acoustic",
            "instrumental",
            "karaoke",
        ],
        "packaging_noise_examples": [
            "remaster",
            "remastered",
            "deluxe edition",
            "bonus track",
            "mono",
            "stereo",
        ],
        "transliteration_overlay": {
            "artist_display": "always_when_trusted_and_cjk_only",
            "album_display": "global_setting_when_cjk_only",
            "track_display": "global_or_per_album_setting_when_cjk_only",
            "matching_query_modes": [
                "raw_script",
                "romanized",
                "dual_query_when_confidence_is_weak",
            ],
        },
    }


def build_remote_discovery_lookup_contract() -> dict[str, object]:
    return {
        "route_family": _ROUTE_FAMILY,
        "request_contract": build_remote_discovery_request_contract(),
        "result_contract": build_remote_discovery_result_contract(),
        "normalization_contract": build_shared_title_normalization_contract(),
    }


def build_remote_discovery_route_family(*, lookup_ref: str | None = None) -> dict[str, str]:
    payload = {
        "create": _ROUTE_FAMILY,
        "recent": f"{_ROUTE_FAMILY}/recent",
    }
    if lookup_ref:
        payload["detail"] = f"{_ROUTE_FAMILY}/{lookup_ref}"
    return payload
