from __future__ import annotations

from types import SimpleNamespace

from music_app.services import listen_history
from music_app.services.private_track_rows import build_private_track_row_read


def test_build_private_track_row_read_projects_favorite_song_rows_with_shared_contract(monkeypatch):
    loved_path = r"C:\Music\Rush\Signals\01 - Subdivisions.flac"
    obsessed_path = r"C:\Music\Rush\Grace Under Pressure\02 - Afterimage.flac"
    config = {"PERSISTENCE_BACKENDS": {"listen_history": "postgres"}}
    history_items = [
        {"id": "1", "path": loved_path, "scrobbled": True},
        {"id": "2", "path": loved_path, "scrobbled": True},
        {"id": "3", "path": obsessed_path, "scrobbled": True},
        {"id": "4", "path": obsessed_path, "scrobble_eligible": True, "scrobbled": False},
    ]

    class PostgresSelection:
        effective_backend = "postgres"

    class FakeListenHistoryAdapter:
        def __init__(self, _config):
            pass

        def load_items(self):
            return [dict(item) for item in history_items]

    monkeypatch.setattr(
        listen_history,
        "select_runtime_persistence_adapter",
        lambda seam_id, config: PostgresSelection(),
    )
    monkeypatch.setattr(listen_history, "PostgresListenHistoryAdapter", FakeListenHistoryAdapter)

    tracks = [
        SimpleNamespace(
            path=loved_path,
            title="Subdivisions",
            artist="Rush",
            album="Signals",
            album_artist="Rush",
            track_number=1,
            disc_number=1,
            disc_number_raw="1",
            duration_seconds=321,
            genre=["Progressive Rock"],
            track_preference_overlay={
                "rating": 5,
                "love_tier": "loved",
                "allowed_actions": {
                    "can_rate": True,
                    "can_set_love_tier": True,
                },
            },
        ),
        SimpleNamespace(
            path=obsessed_path,
            title="Afterimage",
            artist="Rush",
            album="Grace Under Pressure",
            album_artist="Rush",
            track_number=2,
            disc_number=1,
            disc_number_raw="1",
            duration_seconds=269,
            genre=["Progressive Rock"],
            track_preference_overlay={
                "rating": 4,
                "love_tier": "obsessed",
                "allowed_actions": {
                    "can_rate": True,
                    "can_set_love_tier": True,
                },
            },
        ),
    ]

    read = build_private_track_row_read(
        tracks,
        surface="favorite_songs",
        query=':loved genre:"Progressive Rock"',
        authorized_private=True,
        config=config,
    )

    assert read["surface"] == "favorite_songs"
    assert read["result_kind"] == "favorite_song_rows"
    assert read["query"] == ':loved genre:"Progressive Rock"'
    assert read["unsupported_filters"] == []
    assert read["track_rows"] == [
        {
            "track_ref": loved_path,
            "path": loved_path,
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
            "title": "Subdivisions",
            "secondary_artist": None,
            "title_display": {
                "active_mode": "local_tags",
                "supported_modes": ["local_tags", "provider_title"],
                "provider_title": None,
                "provider_title_state": "unavailable",
                "mismatch_state": "hidden",
                "apply_provider_to_tags_action": {
                    "is_available": False,
                    "action_kind": "apply_provider_title_to_tags",
                    "request_route": None,
                    "request_method": None,
                    "action_state": "noop",
                },
            },
            "duration_seconds": 321,
            "duration_display": "5m 21s",
            "track_preference": {
                "rating": 5,
                "love_tier": "loved",
                "allowed_actions": {
                    "client_surface_class": "private_web",
                    "can_rate": True,
                    "can_set_love_tier": True,
                },
            },
             "track_stats": {
                 "scrobble_count": 2,
             },
             "track_popularity": {
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
            },
             "playback_state": {
                 "is_playing_here": False,
                 "is_playing_elsewhere": False,
                "elsewhere_client_kind": None,
                "status_label": "",
                "can_start_here": True,
            },
            "can_edit_preferences": True,
        }
    ]


def test_build_private_track_row_read_wraps_playlist_rows_without_changing_shared_payload():
    tracks = [
        {
            "playlist_item_id": "playlist-item-1",
            "playlist_position": 3,
            "album_title": "Signals",
            "path": r"C:\Music\Rush\Signals\01 - Subdivisions.flac",
            "title": "Subdivisions",
            "artist": "Rush",
            "album": "Signals",
            "album_artist": "Rush",
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
            "duration_seconds": 321,
            "track_preference_overlay": {
                "rating": 5,
                "love_tier": "loved",
                "allowed_actions": {
                    "can_rate": True,
                    "can_set_love_tier": True,
                },
            },
            "track_scrobble_count": 7,
        }
    ]

    read = build_private_track_row_read(
        tracks,
        surface="playlist_detail",
        query='album:"Signals"',
        authorized_private=True,
    )

    assert read["surface"] == "playlist_detail"
    assert read["result_kind"] == "playlist_rows"
    assert read["unsupported_filters"] == []
    assert read["track_rows"] == [
        {
            "playlist_item_id": "playlist-item-1",
            "playlist_position": 3,
            "album_title": "Signals",
            "track_ref": r"C:\Music\Rush\Signals\01 - Subdivisions.flac",
            "path": r"C:\Music\Rush\Signals\01 - Subdivisions.flac",
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
            "title": "Subdivisions",
            "secondary_artist": None,
            "title_display": {
                "active_mode": "local_tags",
                "supported_modes": ["local_tags", "provider_title"],
                "provider_title": None,
                "provider_title_state": "unavailable",
                "mismatch_state": "hidden",
                "apply_provider_to_tags_action": {
                    "is_available": False,
                    "action_kind": "apply_provider_title_to_tags",
                    "request_route": None,
                    "request_method": None,
                    "action_state": "noop",
                },
            },
            "duration_seconds": 321,
            "duration_display": "5m 21s",
            "track_preference": {
                "rating": 5,
                "love_tier": "loved",
                "allowed_actions": {
                    "client_surface_class": "private_web",
                    "can_rate": True,
                    "can_set_love_tier": True,
                },
            },
             "track_stats": {
                 "scrobble_count": 7,
             },
             "track_popularity": {
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
            },
             "playback_state": {
                 "is_playing_here": False,
                 "is_playing_elsewhere": False,
                "elsewhere_client_kind": None,
                "status_label": "",
                "can_start_here": True,
            },
            "can_edit_preferences": True,
        }
    ]
