"""Bounded saved-cover browse metadata, without source or transport access."""
from copy import deepcopy
from importlib import import_module
import json
from pathlib import Path
import urllib.request

import pytest

from music_app.services import library_browse_postgres as browse
from tests.py.cover_unit_safety import cover_unit_transports  # noqa: F401


def saved_metadata():
    return {
        "selected_covers": [
            {"selection_id": "back", "kind": "local", "path": "/PRIVATE_SOURCE/release/back.png"},
            {"selection_id": "remote", "kind": "remote", "url": "https://covers.example.test/PRIVATE_SOURCE.png",
             "source": "PRIVATE_PROVIDER", "candidate_id": "PRIVATE_CANDIDATE", "candidate_generation": 9},
            {"selection_id": "front", "kind": "local", "path": "/PRIVATE_SOURCE/release/front.png"},
        ],
        "selected_covers_revision": 7,
        "selected_covers_last_request": {"mutation_id": "93c9e45b-022e-4336-8e11-32f155591b74", "request_hash": "a" * 64},
    }


def projection(metadata, *, album_id=72, library_id=23):
    service = import_module("music_app.services.ordered_cover_presentation")
    return service.project_ordered_covers_for_browse(metadata, album_id=album_id, library_id=library_id)


def expected_projection():
    return {"selected_covers": [{"selection_id": item["selection_id"], "kind": item["kind"]}
                                for item in saved_metadata()["selected_covers"]],
            "selected_covers_revision": 7, "selected_covers_library_id": 23, "selected_covers_album_id": 72, "selected_covers_loaded": True}


def album_row():
    return {"album_id": 72, "album_library_id": 23, "album_key": "artist::release", "album_title": "Release",
            "album_metadata": {"album_artist": "Artist", **saved_metadata()}, "artist_name": "Artist",
            "album_cover_path": None, "album_release_year": 2001, "track_count": 1,
            "track_id": 81, "track_key": "track-81", "track_title": "Song", "duration_seconds": 181,
            "file_private_path": "/synthetic/release/song.flac", "file_entry": {},
            "file_scan_cache_stale": True, "file_library_root_category": "main"}


def test_projection_retains_order_and_revision_without_source_io(monkeypatch):
    original = saved_metadata()
    before = deepcopy(original)
    # Import before denying I/O so the guard concerns projection, not importlib.
    service = import_module("music_app.services.ordered_cover_presentation")
    def forbidden(*args, **kwargs):
        raise AssertionError("Browse projection must not inspect files or fetch sources")
    with monkeypatch.context() as patch:
        patch.setattr("builtins.open", forbidden)
        patch.setattr(Path, "open", forbidden)
        patch.setattr(Path, "stat", forbidden)
        patch.setattr(urllib.request, "urlopen", forbidden)
        result = service.project_ordered_covers_for_browse(original, album_id=72, library_id=23)
    assert result == expected_projection()
    assert "PRIVATE_" not in json.dumps(result)
    assert "selected_covers_last_request" not in result
    result["selected_covers"][0]["selection_id"] = "changed"
    assert original == before


@pytest.mark.parametrize("legacy", [{}, None, [], {"cover_selection_origin": "user", "selected_cover_path": "/legacy.png"},
    {"remote_cover_url": "https://covers.example.test/legacy.png", "selected_covers_revision": 88}])
def test_legacy_is_explicitly_loaded_empty_without_fabricating_primary(legacy):
    assert projection(legacy) == {"selected_covers": [], "selected_covers_revision": 0,
                                  "selected_covers_library_id": 23, "selected_covers_album_id": 72, "selected_covers_loaded": True}


@pytest.mark.parametrize("change", [
    {"selected_covers": []}, {"selected_covers": None}, {"selected_covers": [{"kind": "local"}]},
    {"selected_covers_revision": -1}, {"selected_covers_revision": True},
    {"selected_covers": saved_metadata()["selected_covers"] * 2},
    {"selected_covers_last_request": {"mutation_id": "invalid", "request_hash": "secret"}},
])
def test_corrupt_saved_list_is_not_reported_as_loaded_legacy_or_partial_selection(change):
    assert projection({**saved_metadata(), **change}) == {"selected_covers_loaded": False}


@pytest.mark.parametrize("field,value", [("album_id", None), ("album_id", True), ("album_id", 0),
    ("album_id", "72"), ("library_id", None), ("library_id", False), ("library_id", -1), ("library_id", "23")])
def test_missing_or_nonconcrete_scope_never_hydrates_selected_sources(field, value):
    assert projection(saved_metadata(), **{field: value}) == {"selected_covers_loaded": False}


@pytest.mark.parametrize("owner", ["root", "selected-artist", "missing"])
def test_existing_row_owners_carry_bounded_saved_selection(owner):
    row = album_row()
    before = deepcopy(row)
    if owner == "root":
        albums = browse._root_album_browse_album_payloads([row], "Artist")
    elif owner == "selected-artist":
        albums = browse._selected_artist_album_payloads([row], "Artist")
    else:
        albums = browse._missing_album_projection_payloads([row])
    assert len(albums) == 1
    assert albums[0]["album_id"] == 72
    assert {key: albums[0][key] for key in expected_projection()} == expected_projection()
    assert "PRIVATE_" not in json.dumps(albums)
    assert row == before


def test_album_detail_owner_preserves_the_same_concrete_selection(monkeypatch):
    row = album_row()
    repository = browse.PostgresLibraryBrowseRepository({}, connect=lambda _: pytest.fail("No extra query permitted"))
    monkeypatch.setattr(repository, "_load_album_detail_rows", lambda *args, **kwargs: [deepcopy(row)])
    monkeypatch.setattr(repository, "_attach_duplicate_sources", lambda *args, **kwargs: None)
    monkeypatch.setattr(repository, "_apply_private_album_rating_overlays", lambda *args, **kwargs: None)
    result = repository._build_album_detail_payload_with_connection(
        "artist::release", client_surface_class="private_web", connection=object())
    assert result["album_id"] == 72
    assert {key: result[key] for key in expected_projection()} == expected_projection()
    assert "PRIVATE_" not in json.dumps(result)


@pytest.mark.parametrize("builder,kwargs,outer_scope", [
    ("_selected_artist_sql", {}, "selected_artist_albums.album_library_id"),
    ("_album_detail_sql", {}, "library.local_albums.library_id as album_library_id"),
    ("_root_album_browse_sql", {}, "album_rows.album_library_id"),
    ("_root_gallery_page_rows_sql", {}, "album_rows.album_library_id"),
    ("_root_startup_payload_sql", {"artist_limit": 4}, "matched_album_rows.album_library_id"),
    ("_selected_artist_preview_sql", {}, "matched_album_rows.album_library_id"),
    ("_selected_artist_preview_sql", {"album_limit": 5, "balance_across_artists": True}, "matched_album_rows.album_library_id"),
    ("_artist_preview_rows_sql", {}, "matched_album_rows.album_library_id"),
    ("_artist_preview_rows_sql", {"family_only": True}, "matched_album_rows.album_library_id"),
    ("_search_preview_sql", {}, "matched_album_rows.album_library_id"),
    ("_search_preview_sql", {"album_limit": 5, "use_utf8_prefilter": True}, "matched_album_rows.album_library_id"),
    ("_album_rows_by_track_paths_sql", {}, "library.local_albums.library_id as album_library_id"),
    ("_missing_albums_sql", {}, "library.local_albums.library_id as album_library_id"),
    ("_missing_albums_sql", {"scoped_artists": True, "scoped_albums": True, "bounded": True}, "library.local_albums.library_id as album_library_id"),
])
def test_sql_row_contract_carries_album_library_identity_through_projection(builder, kwargs, outer_scope):
    # Structural contract only: executing SQL needs the separate isolated-Postgres gate.
    sql = " ".join(getattr(browse, builder)(**kwargs).lower().split())
    assert "library.local_albums.library_id as album_library_id" in sql
    assert outer_scope in sql
    assert "album_metadata" in sql


@pytest.mark.parametrize("track_paths", [[], ["/synthetic/release/track.flac"]])
def test_artwork_repository_loads_saved_metadata_even_without_active_local_tracks(track_paths):
    saved = saved_metadata()
    record = {"album_id": 72, "library_id": 23, "metadata": saved, "track_paths": track_paths}
    calls = []
    class Connection:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def execute(self, sql, params):
            calls.append((sql, params))
            return self
        def fetchone(self):
            return deepcopy(record)
    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/selected_artwork"},
        connect=lambda _: Connection())
    result = repository.load_selected_cover_artwork(album_id=72, library_id=23)
    assert result == record
    assert len(calls) == 1
    sql, params = calls[0]
    assert params == {"album_id": 72, "library_id": 23}
    normalized = " ".join(sql.lower().split())
    assert "left join" in normalized
    assert "local_albums" in normalized and "scan_cache_stale" in normalized
    assert "%(album_id)s" in normalized and "%(library_id)s" in normalized
    assert normalized.startswith("select ") or normalized.startswith("with ")


@pytest.mark.parametrize("album_id,library_id", [(None, 23), (True, 23), (72, None), (72, False), (0, 23), (72, -1)])
def test_artwork_repository_rejects_nonconcrete_scope_before_opening_connection(album_id, library_id):
    repository = browse.PostgresLibraryBrowseRepository({}, connect=lambda _: pytest.fail("Invalid scope reached persistence"))
    assert repository.load_selected_cover_artwork(album_id=album_id, library_id=library_id) is None
