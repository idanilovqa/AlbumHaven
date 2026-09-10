from __future__ import annotations

import json

from music_app.services.allowed_actions import AllowedActions


def _missing_row(
    *,
    album_key: str = "transatlantic::smpte-the-roine-stolt-mixes",
    track_id: int = 101,
    stale: bool = True,
    stale_marked_at: str = "2026-09-03T18:45:00+00:00",
) -> dict[str, object]:
    return {
        "artist_id": 7,
        "artist_name": "Transatlantic",
        "artist_sort_name": "Transatlantic",
        "album_id": 41,
        "album_key": album_key,
        "album_title": "SMPTe - The Roine Stolt Mixes",
        "album_release_year": 2003,
        "album_cover_path": None,
        "album_metadata": {
            "album_artist": "Transatlantic",
            "artists": ["Transatlantic"],
            "edition": "Archive Series",
            "release_type": "ALBUM",
        },
        "track_id": track_id,
        "track_key": f"track-{track_id}",
        "track_title": f"Missing track {track_id}",
        "duration_seconds": 240,
        "file_scan_cache_stale": stale,
        "file_stale_marked_at": stale_marked_at,
        "file_library_root_id": 3,
        "file_library_root_category": "main_library",
    }


def test_all_stale_album_projects_as_non_playable_gallery_tombstone():
    from music_app.services.library_browse_postgres import (
        _missing_album_projection_payloads,
    )

    [album] = _missing_album_projection_payloads(
        [_missing_row(track_id=101), _missing_row(track_id=102)]
    )

    assert album["inventory_status"] == "missing"
    assert album["missing_since"] == "2026-09-03T18:45:00+00:00"
    assert album["track_count_preview"] == 0
    assert album["total_duration_seconds"] == 0
    assert album["tracks"] == []
    assert album["open_directory_paths"] == []
    assert album["cover_path"] is None
    assert album["edition"] == "Archive Series"
    assert album["release_type"] == "ALBUM"
    assert "file_private_path" not in album
    assert "track_paths" not in album


def test_missing_album_gallery_tombstone_is_json_serializable():
    from music_app.services.library_browse_postgres import (
        _missing_album_projection_payloads,
    )

    [album] = _missing_album_projection_payloads([_missing_row()])

    assert json.loads(json.dumps(album))["inventory_status"] == "missing"


def test_missing_album_tombstone_replaces_same_key_active_gallery_payload():
    from music_app.services.library_browse_postgres import (
        _merge_missing_albums_into_artist_groups,
    )

    album_key = "transatlantic::smpte-the-roine-stolt-mixes"
    groups = [
        {
            "artist": "Transatlantic",
            "albums": [{"key": album_key, "name": "SMPTe - The Roine Stolt Mixes"}],
            "sections": [],
        }
    ]
    missing = {
        "key": album_key,
        "name": "SMPTe - The Roine Stolt Mixes",
        "album_artist": "Transatlantic",
        "inventory_status": "missing",
    }

    _merge_missing_albums_into_artist_groups(groups, [missing])

    assert groups[0]["albums"] == [missing]


def test_missing_album_replacement_keeps_its_chronological_gallery_position():
    from music_app.services.library_browse_postgres import (
        _merge_missing_albums_into_artist_groups,
    )

    missing_key = "transatlantic::smpte-the-roine-stolt-mixes"
    groups = [{
        "artist": "Transatlantic",
        "albums": [
            {"key": "smpte", "name": "SMPTe", "year": 2000},
            {"key": "bridge", "name": "Bridge Across Forever", "year": 2001},
            {"key": missing_key, "name": "SMPTe • The Roine Stolt Mixes", "year": 2003},
            {"key": "whirlwind", "name": "The Whirlwind", "year": 2009},
        ],
        "sections": [],
    }]
    missing = {
        "key": missing_key,
        "name": "SMPTe • The Roine Stolt Mixes",
        "album_artist": "Transatlantic",
        "year": 2003,
        "inventory_status": "missing",
    }

    _merge_missing_albums_into_artist_groups(groups, [missing])

    assert [album["key"] for album in groups[0]["albums"]] == [
        "smpte", "bridge", missing_key, "whirlwind",
    ]


def test_selected_artist_missing_album_replacement_restores_chronological_order():
    from music_app.services.library_browse_postgres import (
        _replace_active_albums_with_missing,
    )

    missing_key = "transatlantic::smpte-the-roine-stolt-mixes"
    albums = [
        {"key": "smpte", "name": "SMPTe", "year": 2000},
        {"key": "bridge", "name": "Bridge Across Forever", "year": 2001},
        {"key": "whirlwind", "name": "The Whirlwind", "year": 2009},
    ]
    missing = {
        "key": missing_key,
        "name": "SMPTe • The Roine Stolt Mixes",
        "album_artist": "Transatlantic",
        "year": 2003,
        "inventory_status": "missing",
        "cover_path": None,
    }

    _replace_active_albums_with_missing(albums, [missing])

    assert [album["key"] for album in albums] == [
        "smpte", "bridge", missing_key, "whirlwind",
    ]
    assert albums[2]["inventory_status"] == "missing"
    assert albums[2]["cover_path"] is None


def test_album_with_any_active_file_is_not_projected_as_missing():
    from music_app.services.library_browse_postgres import (
        _missing_album_projection_payloads,
    )

    albums = _missing_album_projection_payloads(
        [
            _missing_row(track_id=101, stale=True),
            _missing_row(track_id=102, stale=False, stale_marked_at=""),
        ]
    )

    assert albums == []


def test_missing_album_sql_requires_every_known_file_to_be_stale():
    from music_app.services.library_browse_postgres import _missing_albums_sql

    sql = " ".join(_missing_albums_sql().casefold().split())

    assert "library.local_albums" in sql
    assert "library.local_track_files" in sql
    assert "bool_and" in sql
    assert "scan_cache_stale" in sql
    assert "min(" in sql and "stale_marked_at" in sql


def test_missing_album_detail_has_no_playback_or_file_actions():
    from music_app.services.library_browse_postgres import (
        _missing_album_detail_payload,
        _missing_album_projection_payloads,
    )

    [album] = _missing_album_projection_payloads([_missing_row()])

    detail = _missing_album_detail_payload(album)

    assert detail["inventory_status"] == "missing"
    assert detail["missing_since"] == "2026-09-03T18:45:00+00:00"
    assert detail["tracks"] == []
    assert detail["playback_available"] is False
    assert detail["file_actions_available"] is False
    assert detail["warning"] == (
        "It seems this album was deleted or is not found under the current library roots."
    )


def test_missing_album_problem_is_album_level_non_excludable_and_path_free():
    from music_app.services.library_browse_postgres import (
        _problematic_album_detail_payload,
        _problematic_album_summary_payload,
    )

    album = {
        "key": "transatlantic::smpte-the-roine-stolt-mixes",
        "name": "SMPTe - The Roine Stolt Mixes",
        "album_artist": "Transatlantic",
        "artists": ["Transatlantic"],
        "inventory_status": "missing",
        "missing_since": "2026-09-03T18:45:00+00:00",
        "tracks": [],
    }

    summary = _problematic_album_summary_payload(album)
    detail = _problematic_album_detail_payload(album)

    assert summary is not None
    assert summary["problem_reasons"] == ["Album not found"]
    assert summary["inventory_status"] == "missing"
    assert summary.get("track_paths", []) == []
    assert detail is not None
    assert detail["album_problem_rows"] == [
        {
            "row_key": "transatlantic::smpte-the-roine-stolt-mixes::album-not-found",
            "album_key": "transatlantic::smpte-the-roine-stolt-mixes",
            "reason": "Album not found",
            "display_reason": "Album not found",
            "excludable": False,
        }
    ]
    assert "path" not in detail["album_problem_rows"][0]


def test_missing_album_manage_action_is_derived_from_allowed_actions():
    from music_app.services.view_payloads import project_missing_album_actions

    album = {
        "key": "missing-album",
        "inventory_status": "missing",
    }

    managed = project_missing_album_actions(
        album,
        AllowedActions(("library.inventory.manage",)),
    )
    read_only = project_missing_album_actions(album, AllowedActions(()))

    assert managed["allowed_actions"] == {"library.inventory.manage": True}
    assert managed["removal_action_label"] == "Remove from Album Haven"
    assert read_only["allowed_actions"] == {}
    assert read_only["removal_guidance"] == (
        "Ask an owner or administrator to remove it."
    )
