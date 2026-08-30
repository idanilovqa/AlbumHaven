from __future__ import annotations

from types import SimpleNamespace

import pytest

from music_app.services.track_rows import (
    build_favorite_song_track_rows,
    build_playlist_track_row_payload,
    build_playlist_track_rows,
    build_track_row_payload,
    build_track_rows,
)


def test_build_track_row_payload_returns_server_owned_album_detail_shape():
    track = SimpleNamespace(
        path=r"C:\Music\Artist One\Album One\01 Track.flac",
        title="Track One",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Guest Singer",
        album_artist="Artist One",
        duration_seconds=245,
    )

    assert build_track_row_payload(track) == {
        "track_ref": r"C:\Music\Artist One\Album One\01 Track.flac",
        "path": r"C:\Music\Artist One\Album One\01 Track.flac",
        "track_number": 1,
        "disc_number": 1,
        "disc_number_raw": "1",
        "title": "Track One",
        "secondary_artist": "Guest Singer",
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
        "duration_seconds": 245,
        "duration_display": "4m 05s",
        "track_preference": {
            "rating": None,
            "love_tier": "off",
            "allowed_actions": {
                "client_surface_class": "private_web",
                "can_rate": False,
                "can_set_love_tier": False,
            },
        },
        "track_stats": {
            "scrobble_count": 0,
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
        "can_edit_preferences": False,
    }


def test_build_track_rows_keeps_album_artist_matches_out_of_secondary_artist():
    track = SimpleNamespace(
        path=r"C:\Music\Artist One\Album One\01 Track.flac",
        title="Track One",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Artist One",
        album_artist="Artist One",
        duration_seconds=245,
    )

    rows = build_track_rows([track])

    assert rows[0]["secondary_artist"] is None


@pytest.mark.parametrize(
    "raw_title",
    [
        "Штиль (feat. U.D.O.)",
        "Штиль [featured U.D.O.]",
        "Штиль (featuring U.D.O.)",
        "Штиль [feature U.D.O.]",
    ],
)
def test_build_track_row_payload_uses_album_context_for_terminal_feature_credit(raw_title):
    album = SimpleNamespace(album_artist="Ария")
    track = SimpleNamespace(
        path=rf"C:\Music\Ария\Штиль\{raw_title}.flac",
        title=raw_title,
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Ария",
        album_artist="Ария",
        duration_seconds=311,
    )

    row = build_track_row_payload(track, album=album)

    assert row["title"] == "Штиль"
    assert row["secondary_artist"] == "feat. U.D.O."
    assert track.title == raw_title
    assert track.artist == "Ария"


@pytest.mark.parametrize(
    ("album_artist", "track_artist", "expected_secondary"),
    [
        ("Ария", "Ария, U.D.O.", "Ария, U.D.O."),
        ("Various Artists", "U.D.O.", "U.D.O."),
    ],
)
def test_build_track_row_payload_preserves_explicit_credit_ownership(
    album_artist,
    track_artist,
    expected_secondary,
):
    album = SimpleNamespace(album_artist=album_artist)
    track = SimpleNamespace(
        path=r"C:\Music\Credit Fixture\01.flac",
        title="Штиль",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist=track_artist,
        album_artist=album_artist,
        duration_seconds=311,
    )

    row = build_track_row_payload(track, album=album)

    assert row["title"] == "Штиль"
    assert row["secondary_artist"] == expected_secondary
    assert track.title == "Штиль"
    assert track.artist == track_artist


def test_build_track_row_payload_prefers_persisted_secondary_credit_metadata():
    album = SimpleNamespace(album_artist="Ария")
    track = SimpleNamespace(
        path=r"C:\Music\Ария\Tribute To Harley-Davidson\03.flac",
        title="Штиль",
        track_number=3,
        disc_number=1,
        disc_number_raw="1",
        artist="Ария, U.D.O.",
        album_artist="Ария",
        secondary_credit="feat. U.D.O.",
        duration_seconds=311,
    )

    row = build_track_row_payload(track, album=album)

    assert row["title"] == "Штиль"
    assert row["secondary_artist"] == "feat. U.D.O."


@pytest.mark.parametrize(
    "raw_title",
    [
        "Signal (feat. Featured Voice)",
        "Signal (feat Featured Voice)",
        "Signal (featured Featured Voice)",
        "Signal (featuring Featured Voice)",
        "Signal (feature Featured Voice)",
        "Signal feat. Featured Voice",
        "Signal - featuring Featured Voice",
        "Signal [featured Featured Voice]",
    ],
)
def test_build_track_rows_cleans_explicit_featured_artist_markers_and_combines_track_credit(raw_title):
    track = SimpleNamespace(
        path=r"C:\Music\Various Artists\Signals\01 Signal.flac",
        title=raw_title,
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Solo Voice",
        album_artist="Various Artists",
        duration_seconds=245,
    )

    rows = build_track_rows([track])

    assert track.title == raw_title
    assert rows[0]["title"] == "Signal"
    assert rows[0]["secondary_artist"] == "Solo Voice / feat. Featured Voice"


@pytest.mark.parametrize(
    "raw_title",
    [
        "Signal featured Featured Voice",
        "Signal feature Featured Voice",
    ],
)
def test_build_track_rows_cleans_unbracketed_plain_feature_markers_with_matching_track_credit(raw_title):
    track = SimpleNamespace(
        path=r"C:\Music\Various Artists\Signals\01 Signal.flac",
        title=raw_title,
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Solo Voice / Featured Voice",
        album_artist="Various Artists",
        duration_seconds=245,
    )

    rows = build_track_rows([track])

    assert track.title == raw_title
    assert rows[0]["title"] == "Signal"
    assert rows[0]["secondary_artist"] == "Solo Voice / feat. Featured Voice"


@pytest.mark.parametrize("marker", ["feature", "featured", "featuring"])
def test_build_track_rows_cleans_lowercase_bare_feature_marker_with_distinct_primary_artist(marker):
    raw_title = f"Signal {marker} Guest"
    track = SimpleNamespace(
        path=r"C:\Music\Various Artists\Signals\01 Signal.flac",
        title=raw_title,
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Solo Voice",
        album_artist="Various Artists",
        duration_seconds=245,
    )

    rows = build_track_rows([track])

    assert track.title == raw_title
    assert rows[0]["title"] == "Signal"
    assert rows[0]["secondary_artist"] == "Solo Voice / feat. Guest"


@pytest.mark.parametrize("marker", ["feature", "featured", "featuring"])
def test_build_track_rows_cleans_lowercase_bare_feature_marker_for_ordinary_album_artist(marker):
    raw_title = f"Signal {marker} Guest"
    track = SimpleNamespace(
        path=r"C:\Music\Artist Alpha\Signals\01 Signal.flac",
        title=raw_title,
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Artist Alpha",
        album_artist="Artist Alpha",
        duration_seconds=245,
    )

    rows = build_track_rows([track])

    assert track.title == raw_title
    assert rows[0]["title"] == "Signal"
    assert rows[0]["secondary_artist"] == "feat. Guest"


@pytest.mark.parametrize(
    ("raw_title", "track_artist", "album_artist", "expected_secondary_artist"),
    [
        ("A Feature Film", "Film", "Various Artists", "Film"),
        ("A feature Film", "Film", "Various Artists", "Film"),
        ("A Feature Film", "A Feature Film", "A Feature Film", None),
        ("Ordinary Signal", "A Feature Film", "Various Artists", "A Feature Film"),
    ],
)
def test_build_track_rows_preserves_natural_feature_words(
    raw_title,
    track_artist,
    album_artist,
    expected_secondary_artist,
):
    track = SimpleNamespace(
        path=r"C:\Music\Various Artists\Signals\01 Signal.flac",
        title=raw_title,
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist=track_artist,
        album_artist=album_artist,
        duration_seconds=245,
    )

    rows = build_track_rows([track])

    assert track.title == raw_title
    assert rows[0]["title"] == raw_title
    assert rows[0]["secondary_artist"] == expected_secondary_artist


@pytest.mark.parametrize(
    "raw_title",
    [
        "A Feature Film",
        "The Featured Artist",
    ],
)
def test_build_track_rows_preserves_ordinary_non_va_feature_words(raw_title):
    track = SimpleNamespace(
        path=rf"C:\Music\Artist Alpha\Signals\{raw_title}.flac",
        title=raw_title,
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Artist Alpha",
        album_artist="Artist Alpha",
        duration_seconds=245,
    )

    rows = build_track_rows([track])

    assert track.title == raw_title
    assert rows[0]["title"] == raw_title
    assert rows[0]["secondary_artist"] is None


def test_build_track_rows_preserves_ordinary_various_artists_feature_title_without_credit_metadata():
    track = SimpleNamespace(
        path=r"C:\Music\Various Artists\Signals\01 A Feature Film.flac",
        title="A Feature Film",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Solo Voice",
        album_artist="Various Artists",
        duration_seconds=245,
    )

    rows = build_track_rows([track])

    assert track.title == "A Feature Film"
    assert rows[0]["title"] == "A Feature Film"
    assert rows[0]["secondary_artist"] == "Solo Voice"


def test_build_track_rows_preserves_feature_words_in_a_track_artist_name():
    track = SimpleNamespace(
        path=r"C:\Music\Various Artists\Signals\01 Ordinary Signal.flac",
        title="Ordinary Signal",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="A Feature Film",
        album_artist="Various Artists",
        duration_seconds=245,
    )

    rows = build_track_rows([track])

    assert rows[0]["title"] == "Ordinary Signal"
    assert rows[0]["secondary_artist"] == "A Feature Film"


@pytest.mark.parametrize(
    "track_artist",
    [
        "Featured Voice",
        "Featured Voice / Solo Voice",
    ],
)
def test_build_track_rows_requires_a_distinct_primary_and_terminal_guest_for_plain_title_markers(
    track_artist,
):
    track = SimpleNamespace(
        path=r"C:\Music\Various Artists\Signals\01 Signal.flac",
        title="Signal feature Featured Voice",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist=track_artist,
        album_artist="Various Artists",
        duration_seconds=245,
    )

    rows = build_track_rows([track])

    assert rows[0]["title"] == "Signal feature Featured Voice"
    assert rows[0]["secondary_artist"] == track_artist


def test_build_track_rows_omits_album_artist_from_featured_track_artist_credit():
    track = SimpleNamespace(
        path=r"C:\Music\Artist Alpha\Signals\01 Signal.flac",
        title="Signal",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Artist Alpha feat. Guest",
        album_artist="Artist Alpha",
        duration_seconds=245,
    )

    rows = build_track_rows([track])

    assert rows[0]["title"] == "Signal"
    assert rows[0]["secondary_artist"] == "feat. Guest"


def test_build_track_rows_deduplicates_featured_artist_already_present_in_track_credit():
    track = SimpleNamespace(
        path=r"C:\Music\Various Artists\Signals\01 Signal.flac",
        title="Signal (featuring Solo Voice)",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Solo Voice",
        album_artist="Various Artists",
        duration_seconds=245,
    )

    rows = build_track_rows([track])

    assert rows[0]["title"] == "Signal"
    assert rows[0]["secondary_artist"] == "feat. Solo Voice"


def test_build_track_rows_deduplicates_title_guest_already_in_composite_track_artist_credit():
    track = SimpleNamespace(
        path=r"C:\Music\Various Artists\Signals\01 Signal.flac",
        title="Signal (feat. Featured Voice)",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Solo Voice / Featured Voice",
        album_artist="Various Artists",
        duration_seconds=245,
    )

    rows = build_track_rows([track])

    assert rows[0]["title"] == "Signal"
    assert rows[0]["secondary_artist"] == "Solo Voice / feat. Featured Voice"


def test_build_track_row_payload_normalizes_viewer_scoped_track_preference_overlay():
    track = SimpleNamespace(
        path=r"C:\Music\Artist One\Album One\01 Track.flac",
        title="Track One",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Guest Singer",
        album_artist="Artist One",
        duration_seconds=245,
        track_preference_overlay={
            "rating": "5",
            "love_tier": "Obsessed",
            "allowed_actions": {
                "can_rate": True,
                "can_set_love_tier": False,
            },
            "LastFMLoved": True,
        },
    )

    payload = build_track_row_payload(track)

    assert payload["track_preference"] == {
        "rating": 5,
        "love_tier": "obsessed",
        "allowed_actions": {
            "client_surface_class": "private_web",
            "can_rate": True,
            "can_set_love_tier": False,
        },
    }
    assert payload["can_edit_preferences"] is True
    assert "LastFMLoved" not in payload["track_preference"]


def test_build_track_row_payload_threads_normalized_client_surface_class_into_allowed_actions():
    track = SimpleNamespace(
        path=r"C:\Music\Artist One\Album One\01 Track.flac",
        title="Track One",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Artist One",
        album_artist="Artist One",
        duration_seconds=245,
        track_preference_overlay={
            "rating": 4,
            "love_tier": "Loved",
            "allowed_actions": {
                "can_rate": True,
                "can_set_love_tier": True,
            },
        },
    )

    payload = build_track_row_payload(track, client_surface_class="TV")

    assert payload["track_preference"]["allowed_actions"] == {
        "client_surface_class": "tv",
        "can_rate": True,
        "can_set_love_tier": True,
    }


def test_build_track_row_payload_uses_server_owned_scrobble_count_resolver():
    track = SimpleNamespace(
        path=r"C:\Music\Artist One\Album One\01 Track.flac",
        title="Track One",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Guest Singer",
        album_artist="Artist One",
        duration_seconds=245,
    )

    payload = build_track_row_payload(track, scrobble_count_resolver=lambda source: 7)

    assert payload["track_stats"]["scrobble_count"] == 7


def test_build_track_row_payload_gates_track_popularity_with_show_crowd_opinion():
    track = SimpleNamespace(
        path=r"C:\Music\Artist One\Album One\01 Track.flac",
        title="Track One",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Artist One",
        album_artist="Artist One",
        duration_seconds=245,
        track_popularity={
            "scrobble_count": 456,
            "listener_count": 123,
            "loved_count": 9,
            "match_key": "artist one::track one",
            "match_coverage_state": "matched",
            "metric_availability": {
                "scrobbles": True,
                "listeners": True,
                "loved": True,
            },
            "freshness_state": "fresh",
        },
    )

    hidden_payload = build_track_row_payload(track)
    visible_payload = build_track_row_payload(
        track,
        viewer_opinion_preferences={"show_crowd_opinion": True},
    )

    assert hidden_payload["track_popularity"]["is_visible"] is False
    assert hidden_payload["track_popularity"]["scrobble_count"] is None
    assert visible_payload["track_popularity"] == {
        "is_visible": True,
        "scrobble_count": 456,
        "listener_count": 123,
        "loved_count": 9,
        "match_key": "artist one::track one",
        "match_coverage_state": "matched",
        "metric_availability": {
            "scrobbles": True,
            "listeners": True,
            "loved": True,
        },
        "freshness_state": "fresh",
        "read_seam": {
            "source_kind": "lastfm_popularity_snapshot",
            "visibility_scope": "viewer_scoped_with_crowd_preference",
            "read_mode": "cache_first",
            "request_fetch_policy": "never",
            "background_refresh_policy": "scan_follow_up_or_stale_background",
        },
    }


def test_build_track_row_payload_normalizes_source_playback_state_overlay():
    track = SimpleNamespace(
        path=r"C:\Music\Artist One\Album One\01 Track.flac",
        title="Track One",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Guest Singer",
        album_artist="Artist One",
        duration_seconds=245,
        playback_state_overlay={
            "is_playing_here": 1,
            "is_playing_elsewhere": "yes",
            "elsewhere_client_kind": "desktop",
            "status_label": "Playing in desktop app",
            "can_start_here": 0,
        },
    )

    payload = build_track_row_payload(track)

    assert payload["playback_state"] == {
        "is_playing_here": True,
        "is_playing_elsewhere": True,
        "elsewhere_client_kind": "desktop",
        "status_label": "Playing in desktop app",
        "can_start_here": False,
    }


def test_build_favorite_song_track_rows_projects_only_loved_and_obsessed_tiers():
    tracks = [
        SimpleNamespace(
            path=r"C:\Music\Artist One\Album One\01 Track.flac",
            title="Track One",
            track_number=1,
            disc_number=1,
            disc_number_raw="1",
            artist="Artist One",
            album_artist="Artist One",
            duration_seconds=245,
            track_preference_overlay={
                "love_tier": "off",
            },
            favorite_tracks=True,
        ),
        SimpleNamespace(
            path=r"C:\Music\Artist One\Album One\02 Track.flac",
            title="Track Two",
            track_number=2,
            disc_number=1,
            disc_number_raw="1",
            artist="Artist One",
            album_artist="Artist One",
            duration_seconds=187,
            track_preference_overlay={
                "love_tier": "loved",
            },
        ),
        SimpleNamespace(
            path=r"C:\Music\Artist One\Album One\03 Track.flac",
            title="Track Three",
            track_number=3,
            disc_number=1,
            disc_number_raw="1",
            artist="Guest Singer",
            album_artist="Artist One",
            duration_seconds=301,
            track_preference_overlay={
                "love_tier": "obsessed",
            },
        ),
    ]

    rows = build_favorite_song_track_rows(tracks)

    assert [row["track_ref"] for row in rows] == [
        r"C:\Music\Artist One\Album One\02 Track.flac",
        r"C:\Music\Artist One\Album One\03 Track.flac",
    ]
    assert [row["track_preference"]["love_tier"] for row in rows] == [
        "loved",
        "obsessed",
    ]


def test_build_favorite_song_track_rows_can_limit_results_to_one_love_tier():
    tracks = [
        SimpleNamespace(
            path=r"C:\Music\Artist One\Album One\02 Track.flac",
            title="Track Two",
            track_number=2,
            disc_number=1,
            disc_number_raw="1",
            artist="Artist One",
            album_artist="Artist One",
            duration_seconds=187,
            track_preference_overlay={
                "love_tier": "loved",
            },
        ),
        SimpleNamespace(
            path=r"C:\Music\Artist One\Album One\03 Track.flac",
            title="Track Three",
            track_number=3,
            disc_number=1,
            disc_number_raw="1",
            artist="Guest Singer",
            album_artist="Artist One",
            duration_seconds=301,
            track_preference_overlay={
                "love_tier": "obsessed",
            },
        ),
    ]

    rows = build_favorite_song_track_rows(tracks, love_tier="obsessed")

    assert [row["track_ref"] for row in rows] == [
        r"C:\Music\Artist One\Album One\03 Track.flac",
    ]
    assert rows[0]["track_preference"]["love_tier"] == "obsessed"


def test_build_playlist_track_row_payload_wraps_shared_track_row_contract():
    playlist_entry = {
        "playlist_item_id": "playlist-item-1",
        "playlist_position": 3,
        "album_title": "Album One",
        "path": r"C:\Music\Artist One\Album One\03 Track.flac",
        "title": "Track Three",
        "track_number": 3,
        "disc_number": 1,
        "disc_number_raw": "1",
        "artist": "Guest Singer",
        "album_artist": "Artist One",
        "duration_seconds": 187,
    }

    assert build_playlist_track_row_payload(playlist_entry) == {
        "playlist_item_id": "playlist-item-1",
        "playlist_position": 3,
        "album_title": "Album One",
        "track_ref": r"C:\Music\Artist One\Album One\03 Track.flac",
        "path": r"C:\Music\Artist One\Album One\03 Track.flac",
        "track_number": 3,
        "disc_number": 1,
        "disc_number_raw": "1",
        "title": "Track Three",
        "secondary_artist": "Guest Singer",
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
        "duration_seconds": 187,
        "duration_display": "3m 07s",
        "track_preference": {
            "rating": None,
            "love_tier": "off",
            "allowed_actions": {
                "client_surface_class": "private_web",
                "can_rate": False,
                "can_set_love_tier": False,
            },
        },
        "track_stats": {
            "scrobble_count": 0,
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
        "can_edit_preferences": False,
    }


def test_build_playlist_track_rows_supports_object_backed_entries():
    playlist_entry = SimpleNamespace(
        playlist_item_id="playlist-item-2",
        playlist_position="7",
        album_title="Album Two",
        path=r"C:\Music\Artist Two\Album Two\07 Track.flac",
        title="Track Seven",
        track_number=7,
        disc_number=2,
        disc_number_raw="2",
        artist="Artist Two",
        album_artist="Artist Two",
        duration_seconds=301,
    )

    rows = build_playlist_track_rows([playlist_entry])

    assert rows == [
        {
            "playlist_item_id": "playlist-item-2",
            "playlist_position": 7,
            "album_title": "Album Two",
            "track_ref": r"C:\Music\Artist Two\Album Two\07 Track.flac",
            "path": r"C:\Music\Artist Two\Album Two\07 Track.flac",
            "track_number": 7,
            "disc_number": 2,
            "disc_number_raw": "2",
            "title": "Track Seven",
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
            "duration_seconds": 301,
            "duration_display": "5m 01s",
            "track_preference": {
                "rating": None,
                "love_tier": "off",
                "allowed_actions": {
                    "client_surface_class": "private_web",
                    "can_rate": False,
                    "can_set_love_tier": False,
                },
            },
                "track_stats": {
                    "scrobble_count": 0,
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
            "can_edit_preferences": False,
        },
    ]
