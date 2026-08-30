from __future__ import annotations

from pathlib import Path

from music_app.services.album_details import build_album_detail_payload
from music_app.services.non_album_view_payloads import (
    build_non_album_album_groups,
    build_non_album_track_list,
    infer_blank_album_membership,
)
from music_app.services.scan_cache_persistence import (
    _file_cache_with_inferred_blank_album_memberships,
)


def test_blank_album_membership_requires_numbered_sibling_consensus_adjacent_number_and_folder():
    target_path = r"C:\Music\Mono\Hymn to the Immortal Wind\02 - Burial at Sea.flac"
    entries = {
        target_path: {"path": target_path, "album": "", "artist": "Mono", "track_number": 2},
        r"C:\Music\Mono\Hymn to the Immortal Wind\01 - Ashes in the Snow.flac": {
            "path": r"C:\Music\Mono\Hymn to the Immortal Wind\01 - Ashes in the Snow.flac",
            "album": "Hymn to the Immortal Wind", "artist": "Mono", "track_number": 1,
        },
        r"C:\Music\Mono\Hymn to the Immortal Wind\03 - Silent Flight.flac": {
            "path": r"C:\Music\Mono\Hymn to the Immortal Wind\03 - Silent Flight.flac",
            "album": "Hymn to the Immortal Wind", "artist": "Mono", "track_number": 3,
        },
    }

    assert infer_blank_album_membership(entries[target_path], entries.values()) == "Hymn to the Immortal Wind"
    projected = _file_cache_with_inferred_blank_album_memberships(entries)
    assert entries[target_path]["album"] == ""
    assert projected[target_path]["album"] == "Hymn to the Immortal Wind"

    for path, track_number in ((next(path for path in entries if path.endswith("01 - Ashes in the Snow.flac")), 8), (next(path for path in entries if path.endswith("03 - Silent Flight.flac")), 9)):
        entries[path]["track_number"] = track_number
    assert infer_blank_album_membership(entries[target_path], entries.values()) is None


def test_blank_album_membership_rejects_one_sibling_conflicting_album_or_missing_folder_signal():
    target = {"path": r"C:\Music\Mono\Unsorted\02 - Burial at Sea.flac", "album": "", "artist": "Mono", "track_number": 2}
    one_sibling = {"path": r"C:\Music\Mono\Unsorted\01 - Ashes.flac", "album": "Hymn to the Immortal Wind", "artist": "Mono", "track_number": 1}
    conflicting_sibling = {"path": r"C:\Music\Mono\Unsorted\03 - Silent.flac", "album": "For My Parents", "artist": "Mono", "track_number": 3}

    assert infer_blank_album_membership(target, [target, one_sibling]) is None
    assert infer_blank_album_membership(target, [target, one_sibling, conflicting_sibling]) is None

def test_build_non_album_album_groups_collects_loose_and_exception_entries():
    entries = [
        {
            "path": r"C:\Music\Mono\Singles\01 - Com(?).mp3",
            "album": "!Non album",
            "artist": "Mono",
            "album_artist": "Mono",
            "title": "Com(?)",
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
            "year": 2001,
            "edition": "",
            "album_rating": 0,
            "duration_seconds": 125,
            "cover_path": None,
            "remote_cover_url": None,
            "remote_cover_thumbnail_url": None,
            "remote_cover_source": None,
            "remote_cover_source_label": None,
            "remote_cover_album_url": None,
            "remote_cover_width": None,
            "remote_cover_height": None,
            "exception_type": "Non-album rarity",
        },
        {
            "path": r"C:\Music\Mono\Singles\02 - Halo.mp3",
            "album": "Singles",
            "artist": "Mono",
            "album_artist": "Mono",
            "title": "Halo",
            "track_number": 2,
            "disc_number": 1,
            "disc_number_raw": "1",
            "year": 2001,
            "edition": "",
            "album_rating": 0,
            "duration_seconds": 245,
            "cover_path": None,
            "remote_cover_url": None,
            "remote_cover_thumbnail_url": None,
            "remote_cover_source": None,
            "remote_cover_source_label": None,
            "remote_cover_album_url": None,
            "remote_cover_width": None,
            "remote_cover_height": None,
            "exception_type": "Single-only track",
        },
        {
            "path": r"C:\Music\Mono\Albums\For My Parents\03 - Legend.mp3",
            "album": "For My Parents",
            "artist": "Mono",
            "album_artist": "Mono",
            "title": "Legend",
            "track_number": 3,
            "disc_number": 1,
            "disc_number_raw": "1",
            "year": 2012,
            "edition": "",
            "album_rating": 0,
            "duration_seconds": 300,
            "cover_path": None,
            "remote_cover_url": None,
            "remote_cover_thumbnail_url": None,
            "remote_cover_source": None,
            "remote_cover_source_label": None,
            "remote_cover_album_url": None,
            "remote_cover_width": None,
            "remote_cover_height": None,
            "exception_type": None,
        },
    ]

    groups = build_non_album_album_groups(entries)

    assert [group["artist"] for group in groups] == ["Mono"]
    assert [album["name"] for album in groups[0]["albums"]] == [
        "Non-album rarity",
        "Singles",
    ]
    assert groups[0]["albums"][0]["tracks"][0]["title"] == "Com(?)"
    assert groups[0]["albums"][1]["tracks"][0]["title"] == "Halo"
    assert groups[0]["albums"][1]["total_duration_display"] == "4:05"


def test_build_non_album_track_list_keeps_direct_artist_files_and_sorts_titles():
    entries = [
        {
            "path": r"C:\Music\Mono\A Track.mp3",
            "album": "For My Parents",
            "artist": "Mono",
            "album_artist": "Mono",
            "title": "A Track",
            "duration_seconds": 123,
            "exception_type": None,
        },
        {
            "path": r"C:\Music\Mono\B Track.mp3",
            "album": "!Non album",
            "artist": "Mono",
            "album_artist": "Mono",
            "title": "",
            "duration_seconds": 456,
            "exception_type": None,
        },
        {
            "path": r"C:\Music\Mono\Albums\For My Parents\03 - Legend.mp3",
            "album": "For My Parents",
            "artist": "Mono",
            "album_artist": "Mono",
            "title": "Legend",
            "duration_seconds": 789,
            "exception_type": None,
        },
    ]

    loose_tracks = build_non_album_track_list(entries)

    assert [track["title"] for track in loose_tracks] == ["A Track", "B Track"]
    assert [track["reason_label"] for track in loose_tracks] == ["Unmarked", "Unmarked"]
    assert loose_tracks[1]["display_path"] == r"C:\Music\Mono\B Track.mp3"


def test_build_non_album_track_list_sorts_by_artist_year_and_title():
    entries = [
        {
            "path": r"C:\Music\Stereolab\Loose\Bravo.mp3",
            "album": "!Non album",
            "artist": "Stereolab",
            "album_artist": "Stereolab",
            "title": "Bravo",
            "year": 1999,
            "exception_type": None,
        },
        {
            "path": r"C:\Music\Stereolab\Loose\Alpha.mp3",
            "album": "!Non album",
            "artist": "Stereolab",
            "album_artist": "Stereolab",
            "title": "Alpha",
            "year": 1999,
            "exception_type": "Non-album rarity",
        },
        {
            "path": r"C:\Music\Stereolab\Loose\Gamma.mp3",
            "album": "!Non album",
            "artist": "Stereolab",
            "album_artist": "Stereolab",
            "title": "Gamma",
            "year": None,
            "exception_type": None,
        },
        {
            "path": r"C:\Music\Broadcast\Loose\Come On Let's Go.mp3",
            "album": "!Non album",
            "artist": "Broadcast",
            "album_artist": "Broadcast",
            "title": "Come On Let's Go",
            "year": 2000,
            "exception_type": "Single-only track",
        },
    ]

    tracks = build_non_album_track_list(entries)

    assert [track["artist"] for track in tracks] == [
        "Broadcast",
        "Stereolab",
        "Stereolab",
        "Stereolab",
    ]
    assert [track["title"] for track in tracks] == [
        "Come On Let's Go",
        "Alpha",
        "Bravo",
        "Gamma",
    ]
    assert tracks[0]["year_label"] == "2000"
    assert tracks[1]["reason_label"] == "Non-album rarity"
    assert tracks[3]["year_label"] == "Unknown"
    assert tracks[3]["display_path"] == r"C:\Music\Stereolab\Loose\Gamma.mp3"


def test_build_non_album_track_list_preserves_editable_tag_values():
    tracks = build_non_album_track_list([
        {
            "path": r"C:\Music\Stereolab\Loose\Alpha.mp3",
            "album": "Switched On",
            "artist": "Stereolab",
            "album_artist": "Stereolab Family",
            "title": "Alpha",
            "genre": "Indie",
            "year": 1999,
            "track_number": 3,
            "disc_number": 2,
            "exception_type": "Non-album rarity",
            "edition": "Bonus",
            "album_rating": 8,
        },
    ])

    assert tracks == [{
        "path": r"C:\Music\Stereolab\Loose\Alpha.mp3",
        "artist": "Stereolab Family",
        "tag_artist": "Stereolab",
        "album_artist": "Stereolab Family",
        "album": "Switched On",
        "title": "Alpha",
        "genre": "Indie",
        "year": 1999,
        "year_label": "1999",
        "track_number": 3,
        "disc_number": 2,
        "exception_type": "Non-album rarity",
        "edition": "Bonus",
        "album_rating": 8,
        "reason_label": "Non-album rarity",
        "display_path": r"C:\Music\Stereolab\Loose\Alpha.mp3",
        "duration_seconds": None,
    }]


def test_build_non_album_track_list_uses_one_lexical_root_snapshot_without_filesystem_probes(
    monkeypatch,
):
    from music_app.services import non_album_view_payloads

    snapshot_calls = []

    monkeypatch.setattr(
        non_album_view_payloads,
        "configured_library_root_paths_snapshot",
        lambda config: snapshot_calls.append(config) or (Path(r"X:\SyntheticMusic"),),
    )
    monkeypatch.setattr(
        non_album_view_payloads,
        "relative_parts_within_roots",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("display-only path shaping must not probe the filesystem")
        ),
        raising=False,
    )

    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app/library"}
    tracks = build_non_album_track_list(
        [
            {
                "path": r"X:\SyntheticMusic\Mono\Loose Track.flac",
                "album": "!Non album",
                "artist": "Mono",
                "album_artist": "Mono",
                "title": "Loose Track",
                "exception_type": None,
            },
            {
                "path": r"X:\SyntheticMusic\Stereolab\Loose\Rarity.flac",
                "album": "!Non album",
                "artist": "Stereolab",
                "album_artist": "Stereolab",
                "title": "Rarity",
                "exception_type": "Non-album rarity",
            },
        ],
        config=config,
    )

    assert snapshot_calls == [config]
    assert [track["title"] for track in tracks] == ["Loose Track", "Rarity"]
    assert [track["display_path"] for track in tracks] == [
        r"Mono\Loose Track.flac",
        r"Stereolab\Loose\Rarity.flac",
    ]


def test_build_non_album_track_list_accepts_caller_root_snapshot(monkeypatch):
    from music_app.services import non_album_view_payloads

    monkeypatch.setattr(
        non_album_view_payloads,
        "configured_library_root_paths_snapshot",
        lambda _config: (_ for _ in ()).throw(
            AssertionError("caller root snapshot must be reused")
        ),
    )

    tracks = build_non_album_track_list(
        [
            {
                "path": r"X:\SyntheticMusic\Mono\Loose Track.flac",
                "album": "!Non album",
                "artist": "Mono",
                "album_artist": "Mono",
                "title": "Loose Track",
                "exception_type": None,
            },
        ],
        config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app/library"},
        configured_root_paths=(Path(r"X:\SyntheticMusic"),),
    )

    assert tracks[0]["display_path"] == r"Mono\Loose Track.flac"


def test_build_album_detail_payload_reads_non_album_album_groups_from_service():
    library_state = {
        "albums": [],
        "file_cache": {
            "mono-rarity": {
                "path": r"C:\Music\Mono\Singles\01 - Com(?).mp3",
                "album": "!Non album",
                "artist": "Mono",
                "album_artist": "Mono",
                "title": "Com(?)",
                "track_number": 1,
                "disc_number": 1,
                "disc_number_raw": "1",
                "year": 2001,
                "edition": "",
                "album_rating": 0,
                "duration_seconds": 125,
                "cover_path": None,
                "remote_cover_url": None,
                "remote_cover_thumbnail_url": None,
                "remote_cover_source": None,
                "remote_cover_source_label": None,
                "remote_cover_album_url": None,
                "remote_cover_width": None,
                "remote_cover_height": None,
                "exception_type": "Non-album rarity",
            },
        },
        "scan_in_progress": False,
    }

    payload = build_album_detail_payload(
        "non-album::mono::type::non-album rarity::",
        library_state=library_state,
    )

    assert payload is not None
    assert payload["name"] == "Non-album rarity"
    assert payload["tracks"][0]["title"] == "Com(?)"


def test_build_album_detail_payload_adds_shared_track_rows_for_non_album_groups():
    track_path = r"C:\Music\Mono\Singles\01 - Com(?).mp3"

    library_state = {
        "albums": [],
        "file_cache": {
            "mono-rarity": {
                "path": track_path,
                "album": "!Non album",
                "artist": "Guest Singer",
                "album_artist": "Mono",
                "title": "Com(?)",
                "track_number": 1,
                "disc_number": 1,
                "disc_number_raw": "1",
                "year": 2001,
                "edition": "",
                "album_rating": 0,
                "duration_seconds": 125,
                "cover_path": None,
                "remote_cover_url": None,
                "remote_cover_thumbnail_url": None,
                "remote_cover_source": None,
                "remote_cover_source_label": None,
                "remote_cover_album_url": None,
                "remote_cover_width": None,
                "remote_cover_height": None,
                "exception_type": "Non-album rarity",
            },
        },
        "scan_in_progress": False,
    }

    payload = build_album_detail_payload(
        "non-album::mono::type::non-album rarity::",
        library_state=library_state,
    )

    assert payload is not None
    assert payload["track_rows"] == [
        {
            "track_ref": track_path,
            "path": track_path,
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
            "title": "Com(?)",
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
            "duration_seconds": 125,
            "duration_display": "2m 05s",
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
    assert payload["gallery_list_block"] == {
        "block_kind": "album",
        "album_key": "non-album::mono::type::non-album rarity::",
        "summary": {
            "title": "Non-album rarity",
            "album_artist": "Mono",
            "year": None,
            "album_rating": 0,
            "album_preference": {
                "rating": None,
                "favorite_override": None,
                "is_favorite": False,
                "favorite_source": None,
                "can_edit": False,
                "to_listen": False,
                "is_relisten": False,
                "can_toggle_to_listen": False,
            },
            "tag_album_rating": None,
            "tag_album_rating_source": None,
             "track_count": 1,
             "total_duration_seconds": 125,
             "total_duration_display": "2m 05s",
             "crowd_opinion": {
                 "is_visible": False,
                 "blended_score_10": None,
                 "display_stars": None,
                 "source_count_used": None,
                 "source_count_total": None,
                 "freshness_state": "missing",
             },
             "friends_opinion": {
                 "is_visible": False,
                 "average_rating": None,
                 "rating_count": None,
                 "freshness_state": "missing",
             },
             "album_popularity": {
                 "is_visible": False,
                 "scrobble_count": None,
                 "listener_count": None,
                 "matched_track_count": None,
                 "total_track_count": None,
                 "available_sort_metrics": [],
                 "freshness_state": "missing",
             },
         },
        "track_rows_source": "inline",
        "track_rows": payload["track_rows"],
        "trailing_divider": {
            "total_duration_seconds": 125,
            "total_duration_display": "2m 05s",
        },
    }
