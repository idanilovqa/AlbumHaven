from music_app.services import page_resource_seams
from music_app.services.page_resource_seams import (
    build_album_page_seam,
    build_artist_page_seam,
    build_person_page_seam,
    build_virtual_artist_page_seam,
    build_virtual_release_page_seam,
)


def test_build_artist_page_seam_normalizes_page_state_fields():
    payload = build_artist_page_seam(
        "  Mono  ",
        page_mode="info",
        family_display_mode="chronological",
        gallery_display_mode="covers",
        gallery_scale_percent="135",
        timeline_at="2009-03-24",
    )

    assert payload["artist_ref"] == "Mono"
    assert payload["page_modes"] == ["gallery", "info"]
    assert payload["default_page_mode"] == "gallery"
    assert payload["active_page_mode"] == "info"
    assert payload["family_display_mode"] == "chronological"
    assert payload["gallery_display_mode"] == "covers"
    assert payload["gallery_scale_percent"] == 135
    assert payload["timeline_at"] == "2009-03-24"
    assert payload["extra_original_material_query"] == {
        "query_ref": None,
        "query_state": "idle",
        "trigger_mode": "user_triggered",
        "default_scope": "singles_compilations",
        "scope_label": "Singles + Compilations",
        "supported_scopes": [
            {
                "scope": "singles_compilations",
                "label": "Singles + Compilations",
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
            "comparison_basis": "local_library_artist_page",
            "confidence_state": "available",
        },
        "result_labels": {
            "preferred_when_confident_local_library_comparison_available": (
                "missing from your library"
            ),
            "fallback_when_confident_local_library_comparison_unavailable": (
                "contains original material"
            ),
            "default_label": "missing from your library",
        },
        "results": [],
    }
    assert payload["gallery_bar"] == {
        "component_kind": "gallery_bar",
        "surface_family": "resource_page",
        "page_mode_query_parameter": "page_mode",
        "page_modes": ["gallery", "info"],
        "default_page_mode": "gallery",
        "active_page_mode": "info",
        "info_drawer_toggle": {
            "control_kind": "drawer_toggle",
            "drawer_slot": "resource_page_info",
        },
    }
    assert payload["info_drawer"] == {
        "component_kind": "info_drawer",
        "surface_family": "resource_page",
        "drawer_slot": "resource_page_info",
        "placement": "right",
        "default_state": "closed",
        "content_kind": "artist_release_drawer",
    }


def test_build_person_page_seam_exposes_person_ref_and_gallery_info_state():
    payload = build_person_page_seam(
        "  mike-portnoy  ",
        page_mode="invalid",
        family_display_mode="invalid",
        timeline_at="not-a-date",
    )

    assert payload == {
        "person_ref": "mike-portnoy",
        "page_modes": ["gallery", "info"],
        "default_page_mode": "gallery",
        "active_page_mode": "gallery",
        "family_display_mode": "grouped",
        "timeline_at": None,
        "role_focus": "default",
    }


def test_build_person_page_seam_normalizes_role_focus_for_soundtrack_first_people():
    payload = build_person_page_seam(
        "  hans-zimmer  ",
        page_mode="info",
        family_display_mode="chronological",
        timeline_at="2000-05-01",
        role_focus="SOURCE_MEDIA",
    )

    assert payload["person_ref"] == "hans-zimmer"
    assert payload["active_page_mode"] == "info"
    assert payload["family_display_mode"] == "chronological"
    assert payload["timeline_at"] == "2000-05-01"
    assert payload["role_focus"] == "source_media"


def test_build_virtual_artist_page_seam_reuses_artist_page_shell_without_local_only_fields():
    payload = build_virtual_artist_page_seam(
        "  virtual-mono  ",
        page_mode="info",
        family_display_mode="chronological",
        gallery_display_mode="list",
        gallery_scale_percent="80",
        timeline_at="2009-03-24",
    )

    assert payload == {
        "page_kind": "virtual_artist",
        "virtual_artist_ref": "virtual-mono",
        "page_modes": ["gallery", "info"],
        "default_page_mode": "gallery",
        "active_page_mode": "info",
        "family_display_mode": "chronological",
        "gallery_display_mode": "list",
        "gallery_scale_percent": 80,
        "timeline_at": "2009-03-24",
        "extra_original_material_query": {
            "query_ref": None,
            "query_state": "idle",
            "trigger_mode": "user_triggered",
            "default_scope": "singles_compilations",
            "scope_label": "Singles + Compilations",
            "supported_scopes": [
                {
                    "scope": "singles_compilations",
                    "label": "Singles + Compilations",
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
                "comparison_basis": "confident_local_bridge_if_available",
                "confidence_state": "unknown",
            },
            "result_labels": {
                "preferred_when_confident_local_library_comparison_available": (
                    "missing from your library"
                ),
                "fallback_when_confident_local_library_comparison_unavailable": (
                    "contains original material"
                ),
                "default_label": "contains original material",
            },
            "results": [],
        },
        "gallery_bar": {
            "component_kind": "gallery_bar",
            "surface_family": "resource_page",
            "page_mode_query_parameter": "page_mode",
            "page_modes": ["gallery", "info"],
            "default_page_mode": "gallery",
            "active_page_mode": "info",
            "info_drawer_toggle": {
                "control_kind": "drawer_toggle",
                "drawer_slot": "resource_page_info",
            },
        },
        "info_drawer": {
            "component_kind": "info_drawer",
            "surface_family": "resource_page",
            "drawer_slot": "resource_page_info",
            "placement": "right",
            "default_state": "closed",
            "content_kind": "artist_release_drawer",
        },
    }


def test_build_virtual_artist_page_seam_defaults_gallery_display_contract_when_values_are_invalid():
    payload = build_virtual_artist_page_seam(
        "virtual-mono",
        gallery_display_mode="poster",
        gallery_scale_percent="999",
    )

    assert payload["gallery_display_mode"] == "cards"
    assert payload["gallery_scale_percent"] == 100


def test_build_virtual_artist_page_seam_defaults_original_material_labels_to_remote_safe_fallback():
    payload = build_virtual_artist_page_seam("virtual-mono")

    assert payload["extra_original_material_query"]["comparison_context"] == {
        "comparison_basis": "confident_local_bridge_if_available",
        "confidence_state": "unknown",
    }
    assert payload["extra_original_material_query"]["result_labels"] == {
        "preferred_when_confident_local_library_comparison_available": (
            "missing from your library"
        ),
        "fallback_when_confident_local_library_comparison_unavailable": (
            "contains original material"
        ),
        "default_label": "contains original material",
    }


def test_build_virtual_release_page_seam_exposes_remote_only_cache_first_detail_contract():
    payload = build_virtual_release_page_seam(
        "  mb-release-group-123  ",
        {
            "title": "  Heligoland  ",
            "artist_credit": [{"name": " Massive Attack "}],
            "release_kind": " Album ",
            "release_date": "2026-07-10",
            "release_date_precision": "day",
            "release_timing_state": "upcoming",
            "countdown_target_at": "2026-07-10T00:00:00Z",
            "source_attributions": [
                {
                    "provider_key": "musicbrainz",
                    "provider_label": "MusicBrainz",
                    "source_url": " https://musicbrainz.org/release-group/rg-123 ",
                    "source_label": "Release group",
                }
            ],
            "source_provenance": {
                "provider": "musicbrainz",
                "provider_release_group_id": "rg-123",
                "provider_release_id": "rel-456",
                "capture_mode": "test_seed",
            },
            "freshness_state": "fresh",
            "last_enriched_at": "2026-06-22T12:00:00Z",
            "queued_refresh_state": "not_queued",
        },
    )

    assert payload == {
        "page_kind": "virtual_release",
        "virtual_release_ref": "mb-release-group-123",
        "missing_from_library": {
            "state": "missing",
            "posture": "remote_only",
            "local_album_ref": None,
            "can_play_locally": False,
        },
        "title": "Heligoland",
        "artist_credit": [{"name": "Massive Attack"}],
        "release_kind": "Album",
        "release_date": "2026-07-10",
        "release_date_precision": "day",
        "release_timing_state": "upcoming",
        "countdown_target_at": "2026-07-10T00:00:00Z",
        "release_timing_contract": {
            "release_fields": [
                "release_date",
                "release_date_precision",
                "release_timing_state",
                "countdown_target_at",
            ],
            "optional_fields": ["countdown_target_at"],
            "viewer_local_fields": ["countdown_target_at"],
        },
        "remote_release_overlay_read_contract": {
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
        },
        "source_attributions": [
            {
                "provider_key": "musicbrainz",
                "provider_label": "MusicBrainz",
                "source_url": "https://musicbrainz.org/release-group/rg-123",
                "source_label": "Release group",
                "creator_name": None,
                "license_label": None,
                "license_url": None,
                "attribution_text": None,
            }
        ],
        "source_provenance": {
            "provider": "musicbrainz",
            "provider_release_group_id": "rg-123",
            "provider_release_id": "rel-456",
            "capture_mode": "test_seed",
        },
        "freshness_state": "fresh",
        "last_enriched_at": "2026-06-22T12:00:00Z",
        "queued_refresh_state": "not_queued",
        "read_seam": {
            "source_kind": "virtual_release_snapshot",
            "visibility_scope": "viewer_safe",
            "read_mode": "cache_first",
            "request_fetch_policy": "never",
            "background_refresh_policy": "enqueue_only",
        },
        "visit_refresh": {
            "trigger": "page_visit",
            "enqueue_mode": "enqueue_only",
            "job_kind": "visit_deepen",
            "entity_kind": "virtual_release",
            "blocking": "never",
        },
        "gallery_bar": {
            "component_kind": "gallery_bar",
            "surface_family": "resource_page",
            "page_mode_query_parameter": "page_mode",
            "page_modes": ["info"],
            "default_page_mode": "info",
            "active_page_mode": "info",
            "info_drawer_toggle": {
                "control_kind": "drawer_toggle",
                "drawer_slot": "resource_page_info",
            },
        },
        "info_drawer": {
            "component_kind": "info_drawer",
            "surface_family": "resource_page",
            "drawer_slot": "resource_page_info",
            "placement": "right",
            "default_state": "closed",
            "content_kind": "virtual_release_detail_drawer",
        },
    }
    assert "playback_context" not in payload
    assert "tracks" not in payload
    assert "file_path" not in payload


def test_build_virtual_release_page_seam_defaults_detail_fields_when_snapshot_is_missing():
    payload = build_virtual_release_page_seam("mb-release-group-123")

    assert payload["title"] is None
    assert payload["artist_credit"] == []
    assert payload["release_kind"] is None
    assert payload["source_provenance"] == {}


def test_build_album_page_seam_exposes_cache_first_opinion_and_popularity_contracts():
    payload = build_album_page_seam("  album-1  ")

    assert payload["album_ref"] == "album-1"
    assert payload["album_identity"] == {
        "resource_kind": "generalized_album",
        "album_ref": "album-1",
        "identity_basis": "local_album_seed",
        "represents": "release_family",
        "canonical_release_group_ref": None,
        "canonical_release_ref": None,
        "provider": None,
    }
    assert payload["versions"] == [
        {
            "version_ref": "album-1",
            "album_ref": "album-1",
            "label": "Original",
            "is_local_library_version": True,
            "local_library_status": "present",
            "remote_release_match": None,
            "remote_release_group_match": None,
        },
    ]
    assert payload["release_family"] == {
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
            "unmatched_version_refs": ["album-1"],
        },
        "source_attributions": [],
        "freshness_state": "missing",
        "last_enriched_at": None,
        "queued_refresh_state": "not_queued",
        "read_seam": {
            "source_kind": "album_release_family_snapshot",
            "visibility_scope": "viewer_safe",
            "read_mode": "cache_first",
            "request_fetch_policy": "never",
            "background_refresh_policy": "enqueue_only",
        },
    }
    assert payload["release_info"] == {
        "drawer_slot": "resource_page_info",
        "drawer_content_kind": "album_release_drawer",
        "release_family_ref": None,
        "release_family": payload["release_family"],
    }
    assert payload["album_info"] == {
        "summary_text": None,
        "items": [],
        "source_attributions": [],
        "freshness_state": "missing",
        "last_enriched_at": None,
        "queued_refresh_state": "not_queued",
        "read_seam": {
            "source_kind": "album_fact_snapshot",
            "visibility_scope": "viewer_safe",
            "read_mode": "cache_first",
            "request_fetch_policy": "never",
            "background_refresh_policy": "enqueue_only",
        },
        "visit_refresh": {
            "trigger": "page_visit",
            "enqueue_mode": "enqueue_only",
            "job_kind": "visit_deepen",
            "entity_kind": "album",
            "blocking": "never",
        },
    }
    assert payload["crowd_opinion"]["read_seam"] == {
        "source_kind": "external_album_crowd_opinion_snapshot",
        "visibility_scope": "viewer_scoped",
        "read_mode": "cache_first",
        "request_fetch_policy": "never",
        "background_refresh_policy": "background_only",
    }
    assert payload["friends_opinion"]["read_seam"] == {
        "source_kind": "same_server_album_rating_projection",
        "visibility_scope": "same_server_viewer_scoped",
        "read_mode": "cache_first",
        "request_fetch_policy": "never",
        "background_refresh_policy": "projection_refresh",
    }
    assert payload["album_popularity"]["read_seam"] == {
        "source_kind": "lastfm_popularity_snapshot",
        "visibility_scope": "viewer_scoped_with_crowd_preference",
        "read_mode": "cache_first",
        "request_fetch_policy": "never",
        "background_refresh_policy": "scan_follow_up_or_stale_background",
    }


def test_build_artist_page_seam_exposes_remote_release_overlay_precedence_without_claiming_canonical_truth():
    payload = build_artist_page_seam("Mono")

    assert payload["release_overlay_scopes"] == ["library_scoped", "user_scoped"]
    assert payload["release_timing_contract"] == {
        "release_fields": [
            "release_date",
            "release_date_precision",
            "release_timing_state",
            "countdown_target_at",
        ],
        "optional_fields": ["countdown_target_at"],
        "viewer_local_fields": ["countdown_target_at"],
    }
    assert payload["remote_release_overlay_read_contract"] == {
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


def test_build_album_page_seam_threads_explicit_album_info_rows_and_attributions():
    payload = build_album_page_seam(
        "album-1",
        album_info={
            "summary_text": "  Short summary only.  ",
            "items": [
                {
                    "item_kind": "TRIVIA",
                    "label": "Recorded",
                    "value_text": "  Iceland, 1997  ",
                },
                {
                    "kind": "unknown",
                    "label": " Producer ",
                    "value": "  Steve Albini ",
                },
                "ignored",
            ],
            "source_attributions": [
                {
                    "provider_key": "wikipedia",
                    "provider_label": "Wikipedia",
                    "source_url": " https://example.test/wiki/album ",
                    "source_label": "Article",
                },
                "ignored",
            ],
            "freshness_state": "fresh",
            "last_enriched_at": "2026-06-22T14:00:00Z",
            "queued_refresh_state": "queued",
        },
    )

    assert payload["album_info"] == {
        "summary_text": "Short summary only.",
        "items": [
            {
                "item_kind": "trivia",
                "label": "Recorded",
                "value_text": "Iceland, 1997",
            },
            {
                "item_kind": "fact",
                "label": "Producer",
                "value_text": "Steve Albini",
            },
        ],
        "source_attributions": [
            {
                "provider_key": "wikipedia",
                "provider_label": "Wikipedia",
                "source_url": "https://example.test/wiki/album",
                "source_label": "Article",
                "creator_name": None,
                "license_label": None,
                "license_url": None,
                "attribution_text": None,
            },
        ],
        "freshness_state": "fresh",
        "last_enriched_at": "2026-06-22T14:00:00Z",
        "queued_refresh_state": "queued",
        "read_seam": {
            "source_kind": "album_fact_snapshot",
            "visibility_scope": "viewer_safe",
            "read_mode": "cache_first",
            "request_fetch_policy": "never",
            "background_refresh_policy": "enqueue_only",
        },
        "visit_refresh": {
            "trigger": "page_visit",
            "enqueue_mode": "enqueue_only",
            "job_kind": "visit_deepen",
            "entity_kind": "album",
            "blocking": "never",
        },
    }


def test_build_source_attribution_payload_normalizes_known_fields():
    builder = getattr(page_resource_seams, "build_source_attribution_payload", None)
    assert callable(builder)

    payload = builder({
        "provider_key": "wikimedia_commons",
        "provider_label": "Wikimedia Commons",
        "source_url": " https://commons.wikimedia.org/wiki/File:Example ",
        "source_label": "File page",
        "creator_name": "Jane Doe",
        "license_label": "CC BY-SA 4.0",
        "license_url": "https://creativecommons.org/licenses/by-sa/4.0/",
        "attribution_text": "Photo by Jane Doe",
    })

    assert payload == {
        "provider_key": "wikimedia_commons",
        "provider_label": "Wikimedia Commons",
        "source_url": "https://commons.wikimedia.org/wiki/File:Example",
        "source_label": "File page",
        "creator_name": "Jane Doe",
        "license_label": "CC BY-SA 4.0",
        "license_url": "https://creativecommons.org/licenses/by-sa/4.0/",
        "attribution_text": "Photo by Jane Doe",
    }


def test_build_album_info_item_payload_normalizes_fact_and_trivia_rows():
    builder = getattr(page_resource_seams, "build_album_info_item_payload", None)
    assert callable(builder)

    trivia_payload = builder(
        {
            "item_kind": "TRIVIA",
            "label": "  Pressing  ",
            "value_text": "  First Japanese CD issue  ",
        }
    )
    fact_payload = builder(
        {
            "kind": "unknown",
            "label": " Runtime ",
            "value": "  41:09 ",
        }
    )

    assert trivia_payload == {
        "item_kind": "trivia",
        "label": "Pressing",
        "value_text": "First Japanese CD issue",
    }
    assert fact_payload == {
        "item_kind": "fact",
        "label": "Runtime",
        "value_text": "41:09",
    }


def test_build_release_timing_contract_marks_countdown_as_optional_viewer_local():
    builder = getattr(page_resource_seams, "build_release_timing_contract", None)
    assert callable(builder)

    assert builder() == {
        "release_fields": [
            "release_date",
            "release_date_precision",
            "release_timing_state",
            "countdown_target_at",
        ],
        "optional_fields": ["countdown_target_at"],
        "viewer_local_fields": ["countdown_target_at"],
    }


def test_build_work_soundtrack_and_company_page_seams_expose_cache_only_contracts():
    work_builder = getattr(page_resource_seams, "build_work_page_seam", None)
    soundtrack_builder = getattr(page_resource_seams, "build_soundtrack_page_seam", None)
    company_builder = getattr(page_resource_seams, "build_company_page_seam", None)
    assert callable(work_builder)
    assert callable(soundtrack_builder)
    assert callable(company_builder)

    work_payload = work_builder("  work-123  ")
    soundtrack_payload = soundtrack_builder("  soundtrack-456  ", page_mode="gallery")
    company_payload = company_builder("  company-789  ", page_mode="invalid")

    assert work_payload == {
        "work_ref": "work-123",
        "freshness_state": "missing",
        "last_enriched_at": None,
        "queued_refresh_state": "not_queued",
        "source_attributions": [],
        "local_library_status": {
            "state": "unknown",
            "album_count": 0,
            "album_refs": [],
        },
        "read_seam": {
            "source_kind": "work_snapshot",
            "visibility_scope": "viewer_safe",
            "read_mode": "cache_first",
            "request_fetch_policy": "never",
            "background_refresh_policy": "enqueue_only",
        },
        "visit_refresh": {
            "trigger": "page_visit",
            "enqueue_mode": "enqueue_only",
            "job_kind": "visit_deepen",
            "entity_kind": "work",
            "blocking": "never",
        },
    }
    assert soundtrack_payload["soundtrack_ref"] == "soundtrack-456"
    assert soundtrack_payload["page_modes"] == ["info", "gallery"]
    assert soundtrack_payload["default_page_mode"] == "info"
    assert soundtrack_payload["active_page_mode"] == "gallery"
    assert soundtrack_payload["read_seam"]["source_kind"] == "soundtrack_snapshot"
    assert soundtrack_payload["visit_refresh"]["entity_kind"] == "soundtrack"
    assert soundtrack_payload["source_media"] == {
        "facts": [],
        "source_attributions": [],
    }
    assert company_payload["company_ref"] == "company-789"
    assert company_payload["default_page_mode"] == "info"
    assert company_payload["active_page_mode"] == "info"
    assert company_payload["read_seam"]["source_kind"] == "company_soundtrack_snapshot"
    assert company_payload["visit_refresh"]["entity_kind"] == "company"
    assert company_payload["soundtrack_browse"] == {
        "browse_kind": "exact_company_soundtracks",
        "scope_ref": "company-789",
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
