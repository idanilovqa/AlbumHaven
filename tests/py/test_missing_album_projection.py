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


def test_problematic_detail_reaches_missing_projection_after_empty_active_album(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    row = _missing_row()
    row.update({
        "album_key": "artist::release",
        "album_title": "Release",
        "artist_name": "Artist",
        "album_cover_path": "owned-cover.jpg",
        "album_metadata": {"album_artist": "Artist", "artists": ["Artist"]},
    })
    album_key = row["album_key"]
    repository = PostgresLibraryBrowseRepository({})
    monkeypatch.setattr(repository, "_load_problematic_file_rows", lambda **kwargs: [row])
    monkeypatch.setattr(repository, "_load_relation_alias_maps", lambda: {"alias_to_canonical": {}})
    requested_missing_keys = []

    def missing_rows(*, album_key):
        requested_missing_keys.append(album_key)
        return [row]

    monkeypatch.setattr(repository, "_load_missing_album_rows", missing_rows)
    detail = repository.build_problematic_file_detail_payload(album_key)

    assert detail is not None
    assert requested_missing_keys == [album_key]
    assert detail["key"] == album_key
    assert detail["detail_loaded"] is True
    assert detail["problem_reasons"] == ["Album not found"]
    assert detail["tracks"] == []
    assert not detail.get("open_directory_paths")


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
    assert "scan_cache_stale" in sql
    assert "min(" in sql and "stale_marked_at" in sql
    assert "bool_and" in sql


def test_search_loader_keeps_sql_wildcard_escape_semantics_and_alias_scope():
    from music_app.services.library_browse_postgres import (
        PostgresLibraryBrowseRepository,
        _root_sidebar_view_state,
    )

    calls = []

    class Cursor:
        def fetchall(self):
            return []

    class Connection:
        def execute(self, sql, params):
            calls.append((sql, params))
            return Cursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://fixture"}
    )
    repository._load_search_rows(
        r"100\%\_\\Mix",
        _root_sidebar_view_state({}),
        alias_to_canonical={"Stage Alias": "Canonical Artist"},
        canonical_to_aliases={"Canonical Artist": ["Canonical Artist", "Stage Alias"]},
        connection=Connection(),
    )

    assert len(calls) == 1
    _sql, params = calls[0]
    assert params["query_like"] == r"%100\%\_\\Mix%"
    assert params["search_artist_keys"] == []

    calls.clear()
    repository._load_search_rows(
        "Stage Alias",
        _root_sidebar_view_state({}),
        alias_to_canonical={"Stage Alias": "Canonical Artist"},
        canonical_to_aliases={"Canonical Artist": ["Canonical Artist", "Stage Alias"]},
        connection=Connection(),
    )
    assert calls[0][1]["search_artist_keys"] == ["canonical artist", "stage alias"]


def test_search_artist_key_expansion_normalizes_only_matching_families(monkeypatch):
    from music_app.services import library_browse_postgres as browse_module

    aliases = {
        **{f"Unrelated Alias {index}": f"Unrelated Canonical {index}" for index in range(100)},
        "Needle Alias": "Needle Canonical",
    }
    canonicals = {
        canonical: [alias]
        for alias, canonical in aliases.items()
    }
    original = browse_module.local_inventory_identity_key
    normalized = []

    def record(value):
        normalized.append(value)
        return original(value)

    monkeypatch.setattr(browse_module, "local_inventory_identity_key", record)

    keys = browse_module._missing_album_search_artist_keys(
        "Needle",
        aliases,
        canonicals,
    )

    assert keys == ["needle alias", "needle canonical"]
    assert set(normalized) == {"Needle Alias", "Needle Canonical"}
    assert len(normalized) == 2


def test_query_filter_still_excludes_wrong_category_and_partly_active_missing_albums():
    from music_app.services.library_browse_postgres import _missing_album_projection_payloads

    matching = _missing_row(album_key="matching", track_id=1)
    matching["album_title"] = "Needle Session"
    matching["file_library_root_category"] = "main_library"
    wrong_category = _missing_row(album_key="wrong-category", track_id=2)
    wrong_category["album_title"] = "Needle Session"
    wrong_category["file_library_root_category"] = "hoard"
    partly_active_stale = _missing_row(album_key="partly-active", track_id=3)
    partly_active_stale["album_title"] = "Needle Session"
    partly_active_stale["file_library_root_category"] = "main_library"
    partly_active_live = _missing_row(
        album_key="partly-active",
        track_id=4,
        stale=False,
        stale_marked_at="",
    )
    partly_active_live["album_title"] = "Needle Session"
    partly_active_live["file_library_root_category"] = "main_library"

    albums = _missing_album_projection_payloads(
        [matching, wrong_category, partly_active_stale, partly_active_live],
        view_state={"visible_library_categories": ["main_library"]},
        query="Needle",
    )

    assert [album["key"] for album in albums] == ["matching"]


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
