from __future__ import annotations

from music_app.services.opinion_read_seams import (
    build_album_popularity_payload,
    build_artist_popularity_payload,
    build_crowd_opinion_modal_payload,
    build_crowd_opinion_payload,
    build_friends_opinion_payload,
    build_popularity_browse_payload,
    build_track_popularity_payload,
    build_viewer_opinion_preferences_payload,
    resolve_viewer_opinion_preferences,
)


def test_opinion_payload_builders_do_not_treat_unrelated_dicts_as_visible_metrics():
    preferences = {
        "show_crowd_opinion": True,
        "show_friends_opinions": True,
    }

    assert build_crowd_opinion_payload(
        {"key": "album-1", "name": "Album One"},
        viewer_opinion_preferences=preferences,
    ) == {
        "is_visible": False,
        "blended_score_10": None,
        "display_stars": None,
        "source_count_used": None,
        "source_count_total": None,
        "freshness_state": "missing",
        "read_seam": {
            "source_kind": "external_album_crowd_opinion_snapshot",
            "visibility_scope": "viewer_scoped",
            "read_mode": "cache_first",
            "request_fetch_policy": "never",
            "background_refresh_policy": "background_only",
        },
    }
    assert build_friends_opinion_payload(
        {"key": "album-1", "name": "Album One"},
        viewer_opinion_preferences=preferences,
    ) == {
        "is_visible": False,
        "average_rating": None,
        "rating_count": None,
        "freshness_state": "missing",
        "read_seam": {
            "source_kind": "same_server_album_rating_projection",
            "visibility_scope": "same_server_viewer_scoped",
            "read_mode": "cache_first",
            "request_fetch_policy": "never",
            "background_refresh_policy": "projection_refresh",
        },
    }
    assert build_album_popularity_payload(
        {"key": "album-1", "name": "Album One"},
        viewer_opinion_preferences=preferences,
    ) == {
        "is_visible": False,
        "scrobble_count": None,
        "listener_count": None,
        "matched_track_count": None,
        "total_track_count": None,
        "available_sort_metrics": [],
        "freshness_state": "missing",
        "read_seam": {
            "source_kind": "lastfm_popularity_snapshot",
            "visibility_scope": "viewer_scoped_with_crowd_preference",
            "read_mode": "cache_first",
            "request_fetch_policy": "never",
            "background_refresh_policy": "scan_follow_up_or_stale_background",
        },
    }
    assert build_track_popularity_payload(
        {"path": "track.flac", "title": "Track One"},
        viewer_opinion_preferences=preferences,
    ) == {
        "is_visible": False,
        "scrobble_count": None,
        "listener_count": None,
        "loved_count": None,
        "match_key": None,
        "match_coverage_state": "missing",
        "metric_availability": {
            "scrobbles": False,
            "listeners": False,
            "loved": False,
        },
        "freshness_state": "missing",
        "read_seam": {
            "source_kind": "lastfm_popularity_snapshot",
            "visibility_scope": "viewer_scoped_with_crowd_preference",
            "read_mode": "cache_first",
            "request_fetch_policy": "never",
            "background_refresh_policy": "scan_follow_up_or_stale_background",
        },
    }


def test_opinion_payload_builders_still_accept_direct_metric_payloads():
    preferences = {
        "show_crowd_opinion": True,
        "show_friends_opinions": True,
    }

    assert build_crowd_opinion_payload(
        {"blended_score_10": 8.5, "source_count_used": "2"},
        viewer_opinion_preferences=preferences,
    )["is_visible"] is True
    assert build_friends_opinion_payload(
        {"average_rating": 7.5, "rating_count": "3"},
        viewer_opinion_preferences=preferences,
    )["is_visible"] is True
    assert build_album_popularity_payload(
        {"scrobble_count": "45"},
        viewer_opinion_preferences=preferences,
    )["is_visible"] is True
    assert build_track_popularity_payload(
        {"match_key": "artist::track"},
        viewer_opinion_preferences=preferences,
    )["is_visible"] is True


def test_opinion_payload_builders_hide_direct_metrics_when_preferences_are_disabled():
    assert build_crowd_opinion_payload(
        {"blended_score_10": 8.5, "source_count_used": "2"},
        viewer_opinion_preferences={"show_crowd_opinion": False},
    )["is_visible"] is False
    assert build_album_popularity_payload(
        {"scrobble_count": "45"},
        viewer_opinion_preferences={"show_crowd_opinion": False},
    )["is_visible"] is False
    assert build_track_popularity_payload(
        {"match_key": "artist::track"},
        viewer_opinion_preferences={"show_crowd_opinion": False},
    )["is_visible"] is False
    assert build_friends_opinion_payload(
        {"average_rating": 7.5, "rating_count": "3"},
        viewer_opinion_preferences={"show_friends_opinions": False},
    )["is_visible"] is False


def test_opinion_payload_builders_expose_cache_first_read_seams():
    preferences = {
        "show_crowd_opinion": True,
        "show_friends_opinions": True,
    }

    assert build_crowd_opinion_payload(
        {"blended_score_10": 8.5},
        viewer_opinion_preferences=preferences,
    )["read_seam"] == {
        "source_kind": "external_album_crowd_opinion_snapshot",
        "visibility_scope": "viewer_scoped",
        "read_mode": "cache_first",
        "request_fetch_policy": "never",
        "background_refresh_policy": "background_only",
    }
    assert build_friends_opinion_payload(
        {"average_rating": 7.5},
        viewer_opinion_preferences=preferences,
    )["read_seam"] == {
        "source_kind": "same_server_album_rating_projection",
        "visibility_scope": "same_server_viewer_scoped",
        "read_mode": "cache_first",
        "request_fetch_policy": "never",
        "background_refresh_policy": "projection_refresh",
    }
    popularity_read_seam = {
        "source_kind": "lastfm_popularity_snapshot",
        "visibility_scope": "viewer_scoped_with_crowd_preference",
        "read_mode": "cache_first",
        "request_fetch_policy": "never",
        "background_refresh_policy": "scan_follow_up_or_stale_background",
    }
    assert build_album_popularity_payload(
        {"scrobble_count": "45"},
        viewer_opinion_preferences=preferences,
    )["read_seam"] == popularity_read_seam
    assert build_track_popularity_payload(
        {"match_key": "artist::track"},
        viewer_opinion_preferences=preferences,
    )["read_seam"] == popularity_read_seam
    assert build_artist_popularity_payload(
        {"scrobble_count": "45"},
        viewer_opinion_preferences=preferences,
    )["read_seam"] == popularity_read_seam


def test_popularity_browse_payload_tracks_cache_first_visibility_and_supported_sorts():
    hidden_payload = build_popularity_browse_payload(
        viewer_opinion_preferences={"show_crowd_opinion": False},
    )
    visible_payload = build_popularity_browse_payload(
        viewer_opinion_preferences={"show_crowd_opinion": True},
    )

    assert hidden_payload["is_visible"] is False
    assert hidden_payload["surfaces"][0]["surface_id"] == "popular_albums"
    assert visible_payload == {
        "is_visible": True,
        "read_seam": {
            "source_kind": "lastfm_popularity_projection",
            "visibility_scope": "viewer_scoped_with_crowd_preference",
            "read_mode": "cache_first",
            "request_fetch_policy": "never",
            "background_refresh_policy": "scan_follow_up_or_stale_background",
        },
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


def test_viewer_opinion_preferences_payload_exposes_defaults_scope_and_read_contract():
    payload = build_viewer_opinion_preferences_payload(
        {
            "show_crowd_opinion": True,
            "show_friends_opinions": False,
        }
    )

    assert payload == {
        "show_crowd_opinion": True,
        "show_friends_opinions": False,
        "defaults": {
            "show_crowd_opinion": False,
            "show_friends_opinions": False,
        },
        "preference_scope": "viewer_scoped",
        "control_fields": [
            "show_crowd_opinion",
            "show_friends_opinions",
        ],
        "read_seam": {
            "source_kind": "viewer_opinion_preferences",
            "visibility_scope": "viewer_scoped",
            "read_mode": "state_backed_default",
            "request_fetch_policy": "never",
            "background_refresh_policy": "write_on_change_later",
        },
    }


def test_viewer_opinion_preferences_resolver_defaults_omitted_preferences_to_hidden():
    assert resolve_viewer_opinion_preferences() == {
        "show_crowd_opinion": False,
        "show_friends_opinions": False,
    }


def test_viewer_opinion_preferences_resolver_normalizes_explicit_truthy_preferences():
    assert resolve_viewer_opinion_preferences(
        {
            "show_crowd_opinion": "yes",
            "show_friends_opinions": 1,
        }
    ) == {
        "show_crowd_opinion": True,
        "show_friends_opinions": True,
    }


def test_crowd_opinion_modal_payload_normalizes_source_rows_for_cache_only_detail_reads():
    payload = build_crowd_opinion_modal_payload(
        " mono-1 ",
        {
            "crowd_opinion": {
                "blended_score_10": 8.4,
                "source_count_used": "2",
                "source_count_total": "3",
                "freshness_state": "fresh",
                "sources": [
                    {
                        "source_name": " ProgArchives ",
                        "raw_score": 4.2,
                        "raw_scale": "5",
                        "normalized_score_10": 8.4,
                        "rating_count": "125",
                        "source_type": "community",
                        "source_url": " https://example.com/progarchives/mono-1 ",
                        "freshness_state": "fresh",
                        "last_fetched_at": "2026-06-22T08:30:00Z",
                    }
                ],
            }
        },
    )

    assert payload == {
        "album_ref": "mono-1",
        "detail_kind": "crowd_opinion_modal",
        "blended_score_10": 8.4,
        "source_count_used": 2,
        "source_count_total": 3,
        "sources": [
            {
                "source_name": "ProgArchives",
                "raw_score": 4.2,
                "raw_scale": "5",
                "normalized_score_10": 8.4,
                "rating_count": 125,
                "source_type": "community",
                "source_url": "https://example.com/progarchives/mono-1",
                "freshness_state": "fresh",
                "last_fetched_at": "2026-06-22T08:30:00Z",
            }
        ],
        "freshness_state": "fresh",
        "read_seam": {
            "source_kind": "external_album_crowd_opinion_snapshot",
            "visibility_scope": "viewer_scoped",
            "read_mode": "cache_first",
            "request_fetch_policy": "never",
            "background_refresh_policy": "background_only",
        },
        "modal_contract": {
            "open_action": "crowd_rating_activate",
            "source_rows_field": "sources",
            "source_link_field": "source_url",
        },
    }
