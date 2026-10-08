"""Album identity, not equivalent encodes, defines multi-root duplicates."""

from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.models.library import Album, Track
from music_app.services.library import build_albums_from_file_cache, get_album_duplicate_sources


def _track(folder, number=1, **changes):
    values = {
        "path": Path(folder) / f"{number:02d}.flac",
        "title": f"Track {number}",
        "track_number": number,
        "disc_number": 1,
        "artist": "Artist One",
        "album_artist": "Artist One",
        "album": "Album One",
        "year": 2001,
        "duration_seconds": 180,
    }
    values.update(changes)
    return Track(**values)


def _sources(*tracks):
    return get_album_duplicate_sources(
        Album(key="artist one::album one", name="Album One", album_artist="Artist One", tracks=list(tracks))
    )


@pytest.mark.parametrize("change", [
    {"duration_seconds": 240},
    {"title": "A different tagged title"},
    {"edition": "Deluxe"},
    {"artist": "Guest Performer"},
    {"path": Path("hoard/copy/01.mp3")},
])
def test_duplicate_identity_ignores_track_and_encoding_differences(change):
    sources = _sources(_track("main/original"), _track("hoard/copy", **change))

    assert len(sources) == 2
    assert {source["track_count"] for source in sources} == {1}


def test_bonus_tracks_do_not_hide_duplicates_or_concatenate_source_queues():
    sources = _sources(
        _track("main/original"),
        _track("hoard/copy"),
        _track("hoard/copy", 2, title="Bonus track"),
        _track("arrivals/new-copy", duration_seconds=200),
    )

    assert len(sources) == 3
    assert sorted(source["track_count"] for source in sources) == [1, 1, 2]
    for source in sources:
        assert all(Path(track["path"]).parent == Path(source["folder_path"]) for track in source["tracks"])
        assert len(source["tracks"]) == source["track_count"]


@pytest.mark.parametrize("change", [
    {"year": 2002},
    {"album_artist": "Another Artist"},
    {"album": "Album-One"},
    {"album": "Album One Live"},
])
def test_different_precise_album_identity_is_not_duplicate(change):
    assert _sources(_track("main/original"), _track("hoard/copy", **change)) == []


@pytest.mark.parametrize("change", [
    {"year": None}, {"year": 0}, {"year": 99999},
    {"album_artist": ""}, {"album": ""},
])
def test_matching_unknown_or_invalid_identity_is_not_evidence_of_duplication(change):
    assert _sources(_track("main/original", **change), _track("hoard/copy", **change)) == []


@pytest.mark.parametrize("change", [{"year": 2002}, {"album_artist": "Another Artist"}, {"album": "Another Album"}])
def test_conflicting_metadata_within_both_containers_does_not_establish_identity(change):
    assert _sources(
        _track("main/original"), _track("main/original", 2, **change),
        _track("hoard/copy"), _track("hoard/copy", 2, **change),
    ) == []


def test_identity_normalizes_unicode_case_and_whitespace():
    sources = _sources(
        _track("main/original", album_artist="Beyonc\u00e9", album="The Album"),
        _track("hoard/copy", album_artist=" BEYONCE\u0301 ", album=" the   album "),
    )

    assert len(sources) == 2


def test_multidisc_album_is_one_physical_source():
    assert _sources(
        _track("main/original/CD1", disc_number=1),
        _track("main/original/CD2", disc_number=2),
    ) == []


def test_multidisc_copy_keeps_all_discs_in_its_own_source():
    sources = _sources(
        _track("main/original/CD1", disc_number=1),
        _track("main/original/CD2", disc_number=2),
        _track("hoard/copy", duration_seconds=360),
    )

    assert len(sources) == 2
    original = next(source for source in sources if Path(source["folder_path"]).name == "original")
    assert [track["disc_number"] for track in original["tracks"]] == [1, 2]


def test_separate_edition_records_cross_reference_all_duplicate_sources():
    tracks = [_track("main/original"), _track("hoard/copy", edition="Deluxe")]
    entries = {str(track.path): {**asdict(track), "path": str(track.path)} for track in tracks}

    albums = build_albums_from_file_cache(entries)

    assert len(albums) == 2, "Duplicate linking must not erase distinct edition records"
    for album in albums:
        assert len(get_album_duplicate_sources(album)) == 2
        assert len(album.tracks) == 1, "Linking duplicate copies must preserve the album's own queue"


def test_postgres_projection_uses_album_identity_not_repeated_track_ids():
    from music_app.services.library_browse_postgres import _duplicate_sources_from_rows

    rows = [
        {"album_key": "original", "album_title": "Album One", "album_metadata": {"album_artist": "Artist One"},
         "file_private_path": "main/original/01.flac", "file_entry": asdict(_track("main/original"))},
        {"album_key": "deluxe", "album_title": "Album One", "album_metadata": {"album_artist": "Artist One"},
         "file_private_path": "hoard/copy/01.flac", "file_entry": asdict(_track("hoard/copy", edition="Deluxe", duration_seconds=240))},
    ]
    sources = _duplicate_sources_from_rows(rows)
    assert set(sources) == {"original", "deluxe"}
    assert len(sources["original"]["duplicate_sources"]) == 2
    assert sources["original"]["has_duplicate_files"] is True
    rows[1]["file_entry"]["year"] = 2002
    assert all(not item["has_duplicate_files"] for item in _duplicate_sources_from_rows(rows).values())


def test_duplicate_projection_excludes_rejected_sources_without_changing_diagnostic_rows():
    from copy import deepcopy
    from music_app.services.library_browse_postgres import _duplicate_sources_from_rows

    tracks = [
        _track(folder, number)
        for folder in ("main/Album/CD1", "hoard/Complete copy/CD1")
        for number in (1, 2)
    ]
    tracks.extend([
        _track("main/Orphan", 1, track_number=45),
        _track("main/Random songs", 1),
        _track("main/Random songs", 2, album="Other Album"),
    ])
    rows = [
        {"album_key": "album", "file_private_path": str(track.path),
         "file_entry": asdict(track), "duration_seconds": track.duration_seconds}
        for track in tracks
    ]
    original_rows = deepcopy(rows)
    sources = _duplicate_sources_from_rows(rows)["album"]["duplicate_sources"]

    assert {source["folder_path"] for source in sources} == {
        str(Path("main/Album")), str(Path("hoard/Complete copy")),
    }
    assert [source["track_count"] for source in sources] == [2, 2]
    assert rows == original_rows, "Diagnostic projection must retain rejected physical files"


@pytest.mark.parametrize("excluded_field, excluded_value", [
    ("local_album_membership_problem", "Duplicate track outside album folder"),
    ("exception_type", "single"),
])
def test_duplicate_projection_respects_persisted_loose_membership_in_partial_row_set(excluded_field, excluded_value):
    from music_app.services.library_browse_postgres import _duplicate_sources_from_rows

    rows = [
        {"album_key": "album", "file_private_path": str(track.path),
         "file_entry": asdict(track), "duration_seconds": track.duration_seconds}
        for track in (_track("main/Album"), _track("hoard/Complete copy"), _track("main/Orphan"))
    ]
    rows[-1]["file_entry"][excluded_field] = excluded_value
    sources = _duplicate_sources_from_rows(rows)["album"]["duplicate_sources"]
    assert {source["folder_path"] for source in sources} == {
        str(Path("main/Album")), str(Path("hoard/Complete copy")),
    }


@pytest.mark.parametrize("clear_source", ["row", "entry"])
def test_duplicate_projection_respects_authoritative_cleared_membership_marker(clear_source):
    from music_app.services.library_browse_postgres import _duplicate_sources_from_rows

    rows = [
        {"album_key": "album", "file_private_path": str(track.path),
         "file_entry": asdict(track), "duration_seconds": track.duration_seconds}
        for track in (_track("main/Album"), _track("hoard/Complete copy"))
    ]
    rows[-1]["file_entry"]["local_album_membership_problem"] = "Duplicate track outside album folder"
    entries = None
    if clear_source == "row":
        rows[-1]["local_album_membership_problem"] = None
    else:
        entry = {**rows[-1]["file_entry"], "local_album_membership_problem": None}
        entries = {rows[-1]["file_private_path"]: entry}
    sources = _duplicate_sources_from_rows(rows, file_entries_by_path=entries)["album"]["duplicate_sources"]
    assert {source["folder_path"] for source in sources} == {
        str(Path("main/Album")), str(Path("hoard/Complete copy")),
    }


def test_a_different_year_does_not_hide_a_valid_duplicate_subgroup():
    sources = _sources(_track("main/original"), _track("hoard/copy"), _track("main/reissue", year=2002))
    assert len(sources) == 2
    assert {source["folder_path"] for source in sources} == {str(Path("main/original")), str(Path("hoard/copy"))}


def test_postgres_projection_cannot_infer_duplicate_identity_from_missing_scan_tags():
    from music_app.services.library_browse_postgres import _duplicate_sources_from_rows

    rows = [{"album_key": key, "album_title": "Album One", "artist_name": "Artist One",
             "album_release_year": 2001, "file_private_path": path}
            for key, path in [("one", "main/original/1.flac"), ("two", "hoard/copy/1.flac")]]
    assert all(not result["has_duplicate_files"] for result in _duplicate_sources_from_rows(rows).values())


@pytest.mark.parametrize("can_read_paths", [False, True])
def test_duplicate_source_paths_require_explicit_path_read_permission(monkeypatch, can_read_paths):
    from music_app.routes import api_read_asgi_routes as routes

    monkeypatch.setattr(routes, "allowed_actions_for_request", lambda *args: SimpleNamespace(as_payload=lambda: {"library.paths.read": can_read_paths}))
    source = {"folder_path": "private/copy", "tracks": [{"path": "private/copy/one.flac"}]}
    payload = {"has_duplicate_files": True, "duplicate_sources": [source]}
    routes._project_missing_album_actions_for_request(SimpleNamespace(), payload)
    assert payload["has_duplicate_files"] is True
    assert payload["duplicate_sources"] == ([source] if can_read_paths else [])
    if not can_read_paths:
        assert payload["duplicate_source_count"] == 1


def test_partial_duplicate_group_preserves_all_own_source_categories():
    tracks = [
        _track("main/one", library_root_category="main_library_roots"),
        _track("hoard/two", library_root_category="hoarding_library_roots"),
        _track("arrivals/other-year", year=2002, library_root_category="new_arrivals_roots"),
    ]
    albums = build_albums_from_file_cache({str(track.path): asdict(track) for track in tracks})
    assert len(albums) == 1
    assert set(albums[0].root_provenance["categories"]) == {"main_library", "hoard", "new_arrivals"}
