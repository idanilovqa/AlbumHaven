from __future__ import annotations

from types import SimpleNamespace

from music_app.services.private_track_search import (
    build_private_track_search_contract,
    filter_private_track_sources,
)


def test_build_private_track_search_contract_extends_shared_query_grammar_for_track_rows():
    contract = build_private_track_search_contract()

    assert contract["shared_surfaces"] == [
        "favorite_songs",
        "playlist_detail",
    ]
    assert contract["supported_result_kinds"] == [
        "favorite_song_rows",
        "playlist_rows",
    ]
    assert contract["draft_commit_model"] == {
        "draft_state_owner": "client",
        "committed_state_owner": "server",
        "commit_triggers": ["debounce", "enter"],
        "debounce_ms": 150,
        "draft_sync_policy": "preserve_local_draft_until_committed_view_catches_up",
        "empty_query_behavior": "restore_root_browse",
        "in_flight_request_policy": "interrupt_previous_search_commit",
    }
    assert contract["grammar"]["shortcut_tokens"] == [
        ":loved",
        ":obsessed",
        ":returns_to",
        ":not_often",
    ]
    assert contract["grammar"]["field_terms"]["title"]["availability"] == "shared"
    assert contract["grammar"]["field_terms"]["album"]["availability"] == "shared"
    assert contract["grammar"]["field_terms"]["love"]["availability"] == "authorized_private_track_search"
    assert contract["unsupported_filter_policy"] == {
        "behavior": "fail_closed",
        "returns_feedback": True,
    }


def test_filter_private_track_sources_supports_shared_favorite_song_and_playlist_detail_grammar():
    tracks = [
        SimpleNamespace(
            path=r"C:\Music\Rush\Signals\01 - Subdivisions.flac",
            title="Subdivisions",
            artist="Rush",
            album="Signals",
            album_artist="Rush",
            duration_seconds=321,
            genre=["Progressive Rock"],
            track_preference_overlay={"love_tier": "loved"},
        ),
        SimpleNamespace(
            path=r"C:\Music\Rush\Grace Under Pressure\02 - Afterimage.flac",
            title="Afterimage",
            artist="Rush",
            album="Grace Under Pressure",
            album_artist="Rush",
            duration_seconds=269,
            genre=["Progressive Rock"],
            track_preference_overlay={"love_tier": "obsessed"},
        ),
        SimpleNamespace(
            path=r"C:\Music\Rush\Grace Under Pressure\03 - Red Sector A.flac",
            title="Red Sector A",
            artist="Rush",
            album="Grace Under Pressure",
            album_artist="Rush",
            duration_seconds=287,
            genre=["Synth Rock"],
            track_preference_overlay={"love_tier": "obsessed"},
        ),
    ]

    favorite_result = filter_private_track_sources(
        tracks,
        query=':obsessed genre:"Progressive Rock" duration:<5m',
        surface="favorite_songs",
        authorized_private=True,
    )
    playlist_result = filter_private_track_sources(
        tracks,
        query='artist:"Rush" love:loved album:Signals',
        surface="playlist_detail",
        authorized_private=True,
    )

    assert [track.path for track in favorite_result["matched_sources"]] == [
        r"C:\Music\Rush\Grace Under Pressure\02 - Afterimage.flac",
    ]
    assert favorite_result["unsupported_filters"] == []
    assert [track.path for track in playlist_result["matched_sources"]] == [
        r"C:\Music\Rush\Signals\01 - Subdivisions.flac",
    ]
    assert playlist_result["unsupported_filters"] == []


def test_filter_private_track_sources_fails_closed_for_replay_filters_until_projection_exists():
    tracks = [
        SimpleNamespace(
            path=r"C:\Music\Rush\Grace Under Pressure\02 - Afterimage.flac",
            title="Afterimage",
            artist="Rush",
            album="Grace Under Pressure",
            album_artist="Rush",
            duration_seconds=269,
            genre=["Progressive Rock"],
            track_preference_overlay={"love_tier": "obsessed"},
        ),
    ]

    result = filter_private_track_sources(
        tracks,
        query=":returns_to replay:not_often",
        surface="favorite_songs",
        authorized_private=True,
    )

    assert result["matched_sources"] == []
    assert result["unsupported_filters"] == [
        {
            "token": ":returns_to",
            "field": "return",
            "value": "returns_to",
            "reason": "projection_unavailable",
        },
        {
            "token": "replay:not_often",
            "field": "replay",
            "value": "not_often",
            "reason": "projection_unavailable",
        },
    ]
