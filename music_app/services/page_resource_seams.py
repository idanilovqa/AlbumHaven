from __future__ import annotations

from datetime import date

from music_app.services.gallery_display import (
    normalize_gallery_display_mode,
    normalize_gallery_scale_percent,
)
from music_app.services.album_note_read_seams import build_album_note_payload, build_visible_album_notes_payload
from music_app.services.opinion_read_seams import (
    build_album_popularity_payload,
    build_artist_popularity_payload,
    build_crowd_opinion_payload,
    build_friends_opinion_payload,
)


_ARTIST_PERSON_PAGE_MODES = {"gallery", "info"}
_FAMILY_DISPLAY_MODES = {"grouped", "chronological"}
_ROLE_FOCUS_VALUES = {"default", "composer", "source_media"}
_SOUNDTRACK_COMPANY_PAGE_MODES = {"info", "gallery"}
_DEFAULT_ORIGINAL_MATERIAL_QUERY_SCOPE = "singles_compilations"
_DEFAULT_ORIGINAL_MATERIAL_QUERY_SCOPE_LABEL = "Singles + Compilations"


def _normalize_artist_person_page_mode(page_mode: object) -> str:
    normalized = str(page_mode or "").strip().casefold()
    return normalized if normalized in _ARTIST_PERSON_PAGE_MODES else "gallery"


def _normalize_family_display_mode(family_display_mode: object) -> str:
    normalized = str(family_display_mode or "").strip().casefold()
    return normalized if normalized in _FAMILY_DISPLAY_MODES else "grouped"


def _normalize_timeline_at(timeline_at: object) -> str | None:
    normalized = str(timeline_at or "").strip()
    if not normalized:
        return None
    try:
        date.fromisoformat(normalized)
    except ValueError:
        return None
    return normalized


def _normalize_role_focus(role_focus: object) -> str:
    normalized = str(role_focus or "").strip().casefold()
    return normalized if normalized in _ROLE_FOCUS_VALUES else "default"


def _normalize_soundtrack_company_page_mode(page_mode: object) -> str:
    normalized = str(page_mode or "").strip().casefold()
    return normalized if normalized in _SOUNDTRACK_COMPANY_PAGE_MODES else "info"


def build_gallery_bar_payload(
    *,
    page_modes: list[str],
    default_page_mode: str,
    active_page_mode: str,
) -> dict[str, object]:
    return {
        "component_kind": "gallery_bar",
        "surface_family": "resource_page",
        "page_mode_query_parameter": "page_mode",
        "page_modes": list(page_modes),
        "default_page_mode": default_page_mode,
        "active_page_mode": active_page_mode,
        "info_drawer_toggle": {
            "control_kind": "drawer_toggle",
            "drawer_slot": "resource_page_info",
        },
    }


def build_resource_page_info_drawer_payload(
    *,
    content_kind: str,
) -> dict[str, object]:
    return {
        "component_kind": "info_drawer",
        "surface_family": "resource_page",
        "drawer_slot": "resource_page_info",
        "placement": "right",
        "default_state": "closed",
        "content_kind": content_kind,
    }


def build_extra_original_material_query_payload(
    *,
    page_kind: str,
) -> dict[str, object]:
    confident_local_bridge_available = page_kind == "artist"
    return {
        "query_ref": None,
        "query_state": "idle",
        "trigger_mode": "user_triggered",
        "default_scope": _DEFAULT_ORIGINAL_MATERIAL_QUERY_SCOPE,
        "scope_label": _DEFAULT_ORIGINAL_MATERIAL_QUERY_SCOPE_LABEL,
        "supported_scopes": [
            {
                "scope": _DEFAULT_ORIGINAL_MATERIAL_QUERY_SCOPE,
                "label": _DEFAULT_ORIGINAL_MATERIAL_QUERY_SCOPE_LABEL,
            },
        ],
        "classification_rules": {
            "requires_at_least_one_original_track": True,
            "hide_cover_only_releases": True,
        },
        "temporary_result_identity_field": "original_material_query_ref",
        "temporary_result_posture": "temporary_read_model",
        "saved_overlay_side_effect": "none",
        "comparison_context": {
            "comparison_basis": (
                "local_library_artist_page"
                if confident_local_bridge_available
                else "confident_local_bridge_if_available"
            ),
            "confidence_state": (
                "available" if confident_local_bridge_available else "unknown"
            ),
        },
        "result_labels": {
            "preferred_when_confident_local_library_comparison_available": (
                "missing from your library"
            ),
            "fallback_when_confident_local_library_comparison_unavailable": (
                "contains original material"
            ),
            "default_label": (
                "missing from your library"
                if confident_local_bridge_available
                else "contains original material"
            ),
        },
        "results": [],
    }


def build_remote_release_overlay_read_contract() -> dict[str, object]:
    return {
        "supported_scopes": ["library_scoped", "user_scoped"],
        "scope_visibility": {
            "library_scoped": {
                "read_visibility": "shared_library_or_server_surface",
                "precedence_rank": 1,
            },
            "user_scoped": {
                "read_visibility": "viewer_private_surface",
                "precedence_rank": 2,
            },
        },
        "dedupe_policy": {
            "logical_release_unit": "one_card_per_logical_remote_release",
            "preferred_scope_order": ["library_scoped", "user_scoped"],
            "collapse_to_local_album_when_available": True,
        },
        "canonical_truth_boundary": {
            "canonical_album_card_source": "local_library_album",
            "overlay_posture": "supplemental_remote_release_only",
            "overlays_do_not_replace_canonical_album_identity": True,
        },
    }


def build_release_timing_contract() -> dict[str, object]:
    return {
        "release_fields": [
            "release_date",
            "release_date_precision",
            "release_timing_state",
            "countdown_target_at",
        ],
        "optional_fields": ["countdown_target_at"],
        "viewer_local_fields": ["countdown_target_at"],
    }


def build_source_attribution_payload(attribution: object) -> dict[str, object]:
    source = dict(attribution) if isinstance(attribution, dict) else {}
    payload: dict[str, object] = {}
    for key in (
        "provider_key",
        "provider_label",
        "source_url",
        "source_label",
        "creator_name",
        "license_label",
        "license_url",
        "attribution_text",
    ):
        value = str(source.get(key) or "").strip()
        payload[key] = value or None
    return payload


def _normalize_optional_text(value: object) -> str | None:
    normalized = str(value or "").strip()
    return normalized or None


def _normalize_virtual_release_artist_credit(
    value: object,
) -> list[dict[str, object]]:
    artist_credits: list[dict[str, object]] = []
    for item in list(value or []):
        if not isinstance(item, dict):
            continue
        name = _normalize_optional_text(item.get("name"))
        if not name:
            continue
        artist_credits.append({"name": name})
    return artist_credits


def _normalize_virtual_release_date_precision(value: object) -> str:
    normalized = str(value or "").strip().casefold()
    return normalized if normalized in {"day", "month", "year"} else "unknown"


def _normalize_virtual_release_timing_state(value: object) -> str:
    normalized = str(value or "").strip().casefold()
    return (
        normalized
        if normalized in {"upcoming", "released"}
        else "unknown"
    )


def _build_virtual_release_source_provenance(
    value: object,
) -> dict[str, object]:
    if not isinstance(value, dict):
        return {}
    payload: dict[str, object] = {}
    for key in (
        "provider",
        "provider_release_group_id",
        "provider_release_id",
        "capture_mode",
    ):
        normalized = _normalize_optional_text(value.get(key))
        if normalized:
            payload[key] = normalized
    return payload


def _normalize_album_info_item_kind(value: object) -> str:
    normalized = str(value or "").strip().casefold()
    return normalized if normalized == "trivia" else "fact"


def build_album_info_item_payload(item: object) -> dict[str, object]:
    source = dict(item) if isinstance(item, dict) else {}
    return {
        "item_kind": _normalize_album_info_item_kind(
            source.get("item_kind") or source.get("kind")
        ),
        "label": _normalize_optional_text(source.get("label")),
        "value_text": _normalize_optional_text(
            source.get("value_text") or source.get("value")
        ),
    }


def build_cached_resource_read_seam(source_kind: str) -> dict[str, object]:
    return {
        "source_kind": source_kind,
        "visibility_scope": "viewer_safe",
        "read_mode": "cache_first",
        "request_fetch_policy": "never",
        "background_refresh_policy": "enqueue_only",
    }


def build_visit_refresh_payload(entity_kind: str) -> dict[str, object]:
    return {
        "trigger": "page_visit",
        "enqueue_mode": "enqueue_only",
        "job_kind": "visit_deepen",
        "entity_kind": entity_kind,
        "blocking": "never",
    }


def build_cached_resource_metadata(
    *,
    source_kind: str,
    entity_kind: str,
) -> dict[str, object]:
    return {
        "freshness_state": "missing",
        "last_enriched_at": None,
        "queued_refresh_state": "not_queued",
        "source_attributions": [],
        "local_library_status": {
            "state": "unknown",
            "album_count": 0,
            "album_refs": [],
        },
        "read_seam": build_cached_resource_read_seam(source_kind),
        "visit_refresh": build_visit_refresh_payload(entity_kind),
    }


def build_album_info_payload(payload: object = None) -> dict[str, object]:
    source = dict(payload) if isinstance(payload, dict) else {}
    return {
        "summary_text": _normalize_optional_text(source.get("summary_text")),
        "items": [
            build_album_info_item_payload(item)
            for item in list(source.get("items") or [])
            if isinstance(item, dict)
        ],
        "source_attributions": [
            build_source_attribution_payload(attribution)
            for attribution in list(source.get("source_attributions") or [])
            if isinstance(attribution, dict)
        ],
        "freshness_state": _normalize_optional_text(source.get("freshness_state")) or "missing",
        "last_enriched_at": _normalize_optional_text(source.get("last_enriched_at")),
        "queued_refresh_state": (
            _normalize_optional_text(source.get("queued_refresh_state")) or "not_queued"
        ),
        "read_seam": build_cached_resource_read_seam("album_fact_snapshot"),
        "visit_refresh": build_visit_refresh_payload("album"),
    }


def build_album_ref_seam(album_ref: object) -> dict[str, object]:
    return {
        "album_ref": str(album_ref or "").strip(),
    }


def build_album_identity_payload(album_ref: object) -> dict[str, object]:
    return {
        "resource_kind": "generalized_album",
        "album_ref": str(album_ref or "").strip(),
        "identity_basis": "local_album_seed",
        "represents": "release_family",
        "canonical_release_group_ref": None,
        "canonical_release_ref": None,
        "provider": None,
    }


def build_album_page_versions_payload(album_ref: object) -> list[dict[str, object]]:
    normalized_album_ref = str(album_ref or "").strip()
    if not normalized_album_ref:
        return []
    return [
        {
            "version_ref": normalized_album_ref,
            "album_ref": normalized_album_ref,
            "label": "Original",
            "is_local_library_version": True,
            "local_library_status": "present",
            "remote_release_match": None,
            "remote_release_group_match": None,
        },
    ]


def build_album_release_family_payload(album_ref: object) -> dict[str, object]:
    version_refs = [version["version_ref"] for version in build_album_page_versions_payload(album_ref)]
    return {
        "content_kind": "album_release_family",
        "read_mode": "cache_first_empty",
        "known_variants": [],
        "absent_bonus_tracks": {
            "state": "unknown",
            "tracks": [],
            "source_release_refs": [],
        },
        "local_match_state": {
            "state": "unmatched",
            "matched_version_refs": [],
            "unmatched_version_refs": version_refs,
        },
        "source_attributions": [],
        "freshness_state": "missing",
        "last_enriched_at": None,
        "queued_refresh_state": "not_queued",
        "read_seam": build_cached_resource_read_seam("album_release_family_snapshot"),
    }


def build_album_release_info_payload(release_family: dict[str, object]) -> dict[str, object]:
    return {
        "drawer_slot": "resource_page_info",
        "drawer_content_kind": "album_release_drawer",
        "release_family_ref": None,
        "release_family": release_family,
    }


def build_album_page_seam(
    album_ref: object,
    *,
    album_info: object = None,
) -> dict[str, object]:
    page_modes = ["tracks", "info"]
    default_page_mode = "tracks"
    release_family = build_album_release_family_payload(album_ref)
    return {
        **build_album_ref_seam(album_ref),
        "album_identity": build_album_identity_payload(album_ref),
        "versions": build_album_page_versions_payload(album_ref),
        "release_family": release_family,
        "release_info": build_album_release_info_payload(release_family),
        "page_modes": page_modes,
        "default_page_mode": default_page_mode,
        "gallery_bar": build_gallery_bar_payload(
            page_modes=page_modes,
            default_page_mode=default_page_mode,
            active_page_mode=default_page_mode,
        ),
        "info_drawer": build_resource_page_info_drawer_payload(
            content_kind="album_release_drawer",
        ),
        "album_note": build_album_note_payload({}, album_ref=album_ref),
        "visible_album_notes": build_visible_album_notes_payload({}, album_ref=album_ref),
        "album_info": build_album_info_payload(album_info),
        "crowd_opinion": build_crowd_opinion_payload({}),
        "friends_opinion": build_friends_opinion_payload({}),
        "album_popularity": build_album_popularity_payload({}),
    }


def build_person_ref_seam(person_ref: object) -> dict[str, object]:
    return {
        "person_ref": str(person_ref or "").strip(),
    }


def build_artist_page_seam(
    artist_ref: object,
    *,
    page_mode: object = None,
    family_display_mode: object = None,
    gallery_display_mode: object = None,
    gallery_scale_percent: object = None,
    timeline_at: object = None,
    artist_popularity: object = None,
) -> dict[str, object]:
    return {
        **_build_artist_page_shell_payload(
            ref_key="artist_ref",
            ref_value=artist_ref,
            page_mode=page_mode,
            family_display_mode=family_display_mode,
            gallery_display_mode=gallery_display_mode,
            gallery_scale_percent=gallery_scale_percent,
            timeline_at=timeline_at,
        ),
        "release_overlay_scopes": ["library_scoped", "user_scoped"],
        "release_timing_contract": build_release_timing_contract(),
        "remote_release_overlay_read_contract": (
            build_remote_release_overlay_read_contract()
        ),
        "extra_original_material_query": build_extra_original_material_query_payload(
            page_kind="artist",
        ),
        "artist_popularity": (
            dict(artist_popularity)
            if isinstance(artist_popularity, dict)
            else build_artist_popularity_payload({})
        ),
    }


def build_virtual_artist_page_seam(
    virtual_artist_ref: object,
    *,
    page_mode: object = None,
    family_display_mode: object = None,
    gallery_display_mode: object = None,
    gallery_scale_percent: object = None,
    timeline_at: object = None,
) -> dict[str, object]:
    payload = _build_artist_page_shell_payload(
        page_kind="virtual_artist",
        include_page_kind=True,
        ref_key="virtual_artist_ref",
        ref_value=virtual_artist_ref,
        page_mode=page_mode,
        family_display_mode=family_display_mode,
        gallery_display_mode=gallery_display_mode,
        gallery_scale_percent=gallery_scale_percent,
        timeline_at=timeline_at,
    )
    payload["extra_original_material_query"] = (
        build_extra_original_material_query_payload(page_kind="virtual_artist")
    )
    return payload


def build_virtual_release_page_seam(
    virtual_release_ref: object,
    detail_payload: object = None,
) -> dict[str, object]:
    detail = dict(detail_payload) if isinstance(detail_payload, dict) else {}
    return {
        "page_kind": "virtual_release",
        "virtual_release_ref": str(virtual_release_ref or "").strip(),
        "missing_from_library": {
            "state": "missing",
            "posture": "remote_only",
            "local_album_ref": None,
            "can_play_locally": False,
        },
        "title": _normalize_optional_text(detail.get("title")),
        "artist_credit": _normalize_virtual_release_artist_credit(
            detail.get("artist_credit")
        ),
        "release_kind": _normalize_optional_text(detail.get("release_kind")),
        "release_date": _normalize_optional_text(detail.get("release_date")),
        "release_date_precision": _normalize_virtual_release_date_precision(
            detail.get("release_date_precision")
        ),
        "release_timing_state": _normalize_virtual_release_timing_state(
            detail.get("release_timing_state")
        ),
        "countdown_target_at": _normalize_optional_text(
            detail.get("countdown_target_at")
        ),
        "release_timing_contract": build_release_timing_contract(),
        "remote_release_overlay_read_contract": (
            build_remote_release_overlay_read_contract()
        ),
        "source_attributions": [
            build_source_attribution_payload(attribution)
            for attribution in list(detail.get("source_attributions") or [])
            if isinstance(attribution, dict)
        ],
        "source_provenance": _build_virtual_release_source_provenance(
            detail.get("source_provenance")
        ),
        "freshness_state": (
            _normalize_optional_text(detail.get("freshness_state")) or "missing"
        ),
        "last_enriched_at": _normalize_optional_text(
            detail.get("last_enriched_at")
        ),
        "queued_refresh_state": (
            _normalize_optional_text(detail.get("queued_refresh_state"))
            or "not_queued"
        ),
        "read_seam": build_cached_resource_read_seam("virtual_release_snapshot"),
        "visit_refresh": build_visit_refresh_payload("virtual_release"),
        "gallery_bar": build_gallery_bar_payload(
            page_modes=["info"],
            default_page_mode="info",
            active_page_mode="info",
        ),
        "info_drawer": build_resource_page_info_drawer_payload(
            content_kind="virtual_release_detail_drawer",
        ),
    }


def build_person_page_seam(
    person_ref: object,
    *,
    page_mode: object = None,
    family_display_mode: object = None,
    timeline_at: object = None,
    role_focus: object = None,
) -> dict[str, object]:
    return {
        **build_person_ref_seam(person_ref),
        "page_modes": ["gallery", "info"],
        "default_page_mode": "gallery",
        "active_page_mode": _normalize_artist_person_page_mode(page_mode),
        "family_display_mode": _normalize_family_display_mode(family_display_mode),
        "timeline_at": _normalize_timeline_at(timeline_at),
        "role_focus": _normalize_role_focus(role_focus),
    }


def build_work_page_seam(work_ref: object) -> dict[str, object]:
    return {
        "work_ref": str(work_ref or "").strip(),
        **build_cached_resource_metadata(
            source_kind="work_snapshot",
            entity_kind="work",
        ),
    }


def build_soundtrack_page_seam(
    soundtrack_ref: object,
    *,
    page_mode: object = None,
) -> dict[str, object]:
    active_page_mode = _normalize_soundtrack_company_page_mode(page_mode)
    return {
        "soundtrack_ref": str(soundtrack_ref or "").strip(),
        "page_modes": ["info", "gallery"],
        "default_page_mode": "info",
        "active_page_mode": active_page_mode,
        "gallery_bar": build_gallery_bar_payload(
            page_modes=["info", "gallery"],
            default_page_mode="info",
            active_page_mode=active_page_mode,
        ),
        "info_drawer": build_resource_page_info_drawer_payload(
            content_kind="soundtrack_source_media_drawer",
        ),
        "source_media": {
            "facts": [],
            "source_attributions": [],
        },
        **build_cached_resource_metadata(
            source_kind="soundtrack_snapshot",
            entity_kind="soundtrack",
        ),
    }


def build_exact_company_soundtrack_browse_payload(company_ref: object) -> dict[str, object]:
    return {
        "browse_kind": "exact_company_soundtracks",
        "scope_ref": str(company_ref or "").strip(),
        "scope_kind": "exact_company",
        "result_kind": "soundtrack_page",
        "rows": [],
        "row_fields": [
            "source_title",
            "release_year",
            "media_type",
            "primary_soundtrack_composer",
            "local_library_status",
            "local_soundtrack_album_refs",
        ],
    }


def build_company_page_seam(
    company_ref: object,
    *,
    page_mode: object = None,
) -> dict[str, object]:
    active_page_mode = _normalize_soundtrack_company_page_mode(page_mode)
    company_ref_value = str(company_ref or "").strip()
    return {
        "company_ref": company_ref_value,
        "page_modes": ["info", "gallery"],
        "default_page_mode": "info",
        "active_page_mode": active_page_mode,
        "gallery_bar": build_gallery_bar_payload(
            page_modes=["info", "gallery"],
            default_page_mode="info",
            active_page_mode=active_page_mode,
        ),
        "info_drawer": build_resource_page_info_drawer_payload(
            content_kind="company_soundtrack_drawer",
        ),
        "soundtrack_browse": build_exact_company_soundtrack_browse_payload(company_ref_value),
        **build_cached_resource_metadata(
            source_kind="company_soundtrack_snapshot",
            entity_kind="company",
        ),
    }


def _build_artist_page_shell_payload(
    *,
    page_kind: str | None = None,
    include_page_kind: bool = False,
    ref_key: str,
    ref_value: object,
    page_mode: object = None,
    family_display_mode: object = None,
    gallery_display_mode: object = None,
    gallery_scale_percent: object = None,
    timeline_at: object = None,
) -> dict[str, object]:
    page_modes = ["gallery", "info"]
    default_page_mode = "gallery"
    active_page_mode = _normalize_artist_person_page_mode(page_mode)
    payload = {
        ref_key: str(ref_value or "").strip(),
        "page_modes": page_modes,
        "default_page_mode": default_page_mode,
        "active_page_mode": active_page_mode,
        "family_display_mode": _normalize_family_display_mode(family_display_mode),
        "gallery_display_mode": normalize_gallery_display_mode(gallery_display_mode),
        "gallery_scale_percent": normalize_gallery_scale_percent(gallery_scale_percent),
        "timeline_at": _normalize_timeline_at(timeline_at),
        "gallery_bar": build_gallery_bar_payload(
            page_modes=page_modes,
            default_page_mode=default_page_mode,
            active_page_mode=active_page_mode,
        ),
        "info_drawer": build_resource_page_info_drawer_payload(
            content_kind="artist_release_drawer",
        ),
    }
    if include_page_kind and page_kind:
        payload["page_kind"] = page_kind
    return payload
