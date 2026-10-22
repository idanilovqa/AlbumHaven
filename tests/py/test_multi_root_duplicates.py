"""Album identity, not equivalent encodes, defines multi-root duplicates."""

from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.models.library import Album, Track
from music_app.services.album_local_membership import (
    local_album_membership_ctes_sql,
    physical_album_root,
    rejected_local_album_paths,
)
from music_app.services.library import (
    _link_duplicate_album_sources,
    build_albums_from_file_cache,
    get_album_duplicate_sources,
)


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


def test_numeric_disc_folders_matching_disc_tags_are_one_physical_source():
    assert _sources(
        _track("main/original/1", disc_number=1, title="Disc One Track"),
        _track("main/original/2", disc_number=2, title="Disc Two Track"),
        _track("main/original/3", disc_number=3, title="Disc Three Track"),
        _track("main/original/4", disc_number=4, title="Disc Four Track"),
    ) == []


def test_single_numeric_album_folders_do_not_collapse_from_matching_disc_tags():
    sources = _sources(
        _track("main/1", disc_number=1),
        _track("hoard/1", disc_number=1),
    )

    assert len(sources) == 2
    assert {source["folder_path"] for source in sources} == {
        str(Path("main/1")),
        str(Path("hoard/1")),
    }


def test_numeric_disc_folders_do_not_collapse_with_mixed_disc_tags():
    sources = _sources(
        _track("main/original/1", 1, disc_number=1),
        _track("main/original/1", 2, disc_number=2),
        _track("main/original/2", 1, disc_number=2),
    )

    assert {source["folder_path"] for source in sources} == {
        str(Path("main/original/1")),
        str(Path("main/original/2")),
    }


def test_numeric_disc_folders_build_one_album_with_all_discs():
    tracks = [
        _track(f"main/original/{disc_number}", disc_number=disc_number)
        for disc_number in range(1, 5)
    ]

    albums = build_albums_from_file_cache(
        {str(track.path): asdict(track) for track in tracks}
    )

    assert len(albums) == 1
    assert [track.disc_number for track in albums[0].tracks] == [1, 2, 3, 4]


def test_postgres_projection_keeps_numeric_disc_folders_out_of_duplicates():
    from music_app.services.library_browse_postgres import _duplicate_sources_from_rows

    tracks = [
        _track(f"main/original/{disc_number}", disc_number=disc_number)
        for disc_number in range(1, 5)
    ]
    rows = [
        {
            "album_key": "album",
            "file_private_path": str(track.path),
            "file_entry": asdict(track),
            "duration_seconds": track.duration_seconds,
        }
        for track in tracks
    ]

    projection = _duplicate_sources_from_rows(rows)["album"]

    assert projection["has_duplicate_files"] is False
    assert projection["duplicate_sources"] == []


def test_separate_tagged_releases_in_sibling_disc_folders_are_not_mixed_metadata():
    entries = [
        {**asdict(_track("main/release/CD1", album="Main Album")), "library_root_id": 1},
        {
            **asdict(_track("main/release/CD2", album="Bonus Album")),
            "library_root_id": 1,
        },
    ]

    assert rejected_local_album_paths(entries) == {}


def test_multidisc_folders_remain_one_source_when_compared_with_flat_copy():
    entries = [
        {**asdict(_track("main/release/CD1", 1)), "library_root_id": 1},
        {**asdict(_track("main/release/CD2", 2)), "library_root_id": 1},
        {**asdict(_track("hoard/flat-copy", 1)), "library_root_id": 2},
        {**asdict(_track("hoard/flat-copy", 2)), "library_root_id": 2},
    ]

    assert rejected_local_album_paths(entries) == {}


def test_scoped_postgres_membership_checks_mixed_tags_within_each_disc_folder():
    sql = local_album_membership_ctes_sql(scope_album_key=True)

    assert "physical_folder" in sql
    assert "mixed.physical_folder = files.physical_folder" in sql


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


def test_release_type_misfiled_as_edition_does_not_create_a_second_card():
    tracks = [
        _track("main/original", number, album="Edge of Eternity")
        for number in range(1, 3)
    ] + [
        _track("hoard/copy", number, album="Edge of Eternity", edition="EP")
        for number in range(1, 3)
    ]

    albums = build_albums_from_file_cache({str(track.path): asdict(track) for track in tracks})

    assert len(albums) == 1
    assert albums[0].edition is None
    assert len(albums[0].tracks) == 4
    assert albums[0].total_duration_seconds == 720
    assert len(get_album_duplicate_sources(albums[0])) == 2


def test_optional_leading_article_variant_does_not_create_a_second_card():
    tracks = [
        _track("main/original", number, album="The Serpent's Egg")
        for number in range(1, 3)
    ] + [
        _track("hoard/copy", number, album="Serpent's Egg")
        for number in range(1, 3)
    ]

    albums = build_albums_from_file_cache({str(track.path): asdict(track) for track in tracks})

    assert len(albums) == 1
    assert albums[0].name == "The Serpent's Egg"
    assert len(get_album_duplicate_sources(albums[0])) == 2


def test_article_variant_joins_an_existing_multi_source_duplicate_card():
    tracks = [
        _track(folder, number, album=album)
        for folder, album in (
            ("main/original", "The Serpent's Egg"),
            ("hoard/exact-copy", "The Serpent's Egg"),
            ("arrivals/article-variant", "Serpent's Egg"),
        )
        for number in range(1, 3)
    ]

    albums = build_albums_from_file_cache({str(track.path): asdict(track) for track in tracks})

    assert len(albums) == 1
    assert len(get_album_duplicate_sources(albums[0])) == 3


def test_leading_article_variant_with_different_track_evidence_stays_separate():
    tracks = [
        _track("main/original", album="The Serpent's Egg"),
        _track("hoard/copy", album="Serpent's Egg", duration_seconds=240),
    ]

    albums = build_albums_from_file_cache({str(track.path): asdict(track) for track in tracks})

    assert len(albums) == 2


def test_leading_article_variant_with_conflicting_release_dates_stays_separate():
    tracks = [
        _track("main/original", album="The Serpent's Egg", release_date="1988-10-24"),
        _track("hoard/reissue", album="Serpent's Egg", release_date="2008-06-02"),
    ]

    albums = build_albums_from_file_cache({str(track.path): asdict(track) for track in tracks})

    assert len(albums) == 2


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


def test_postgres_projection_keeps_article_variant_sources_on_the_canonical_card():
    from music_app.services.library_browse_postgres import _duplicate_sources_from_rows

    rows = [
        {
            "album_key": "canonical",
            "album_title": "The Serpent's Egg",
            "album_metadata": {"album_artist": "Artist One"},
            "file_private_path": str(track.path),
            "file_entry": asdict(track),
            "duration_seconds": track.duration_seconds,
        }
        for track in (
            _track("main/original", album="The Serpent's Egg"),
            _track("hoard/article-variant", album="Serpent's Egg"),
        )
    ]

    result = _duplicate_sources_from_rows(rows)["canonical"]

    assert result["has_duplicate_files"] is True
    assert len(result["duplicate_sources"]) == 2


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
    assert len(albums) == 2
    albums_by_year = {album.year: album for album in albums}
    assert set(albums_by_year) == {2001, 2002}
    assert set(albums_by_year[2001].root_provenance["categories"]) == {"main_library", "hoard"}
    assert set(albums_by_year[2002].root_provenance["categories"]) == {"new_arrivals"}


def test_year_distinct_release_uses_the_bucket_year_when_its_first_track_has_none():
    tracks = [
        _track("main/original", year=None),
        _track("main/original", 2),
        _track("main/reissue", year=2002),
        _track("main/reissue", 2, year=2002),
    ]

    albums = build_albums_from_file_cache({str(track.path): asdict(track) for track in tracks})

    assert {album.year for album in albums} == {2001, 2002}
    assert {album.key.rsplit("::year::", 1)[-1] for album in albums} == {"2001", "2002"}


def test_conflicting_year_bucket_does_not_merge_into_resolved_release():
    tracks = [
        _track("main/clean"),
        _track("main/clean", 2),
        _track("main/clean", 3, year=None),
        _track("main/conflicting", 4),
        _track("main/conflicting", 5, year=2002),
    ]

    albums = build_albums_from_file_cache({str(track.path): asdict(track) for track in tracks})

    assert len(albums) == 2
    albums_by_key = {album.key.rsplit("::year::", 1)[-1]: album for album in albums}
    assert set(albums_by_key) == {"2001", "unresolved"}
    assert albums_by_key["2001"].year == 2001
    assert albums_by_key["unresolved"].year is None
    assert {track.year for track in albums_by_key["unresolved"].tracks} == {2001, 2002}


@pytest.mark.parametrize(
    ("duplicate_track_count", "expected_categories"),
    [
        (1, {"main_library"}),
        (2, {"main_library"}),
        (3, {"main_library", "hoard"}),
        (4, {"main_library", "hoard"}),
    ],
)
def test_linked_duplicate_source_category_requires_strict_majority_track_coverage(
    duplicate_track_count,
    expected_categories,
):
    main_tracks = [
        _track(
            "main/album",
            number,
            library_root_id=1,
            library_root_category="main_library_roots",
        )
        for number in range(1, 5)
    ]
    duplicate_tracks = [
        _track(
            "hoard/loose-copy",
            number,
            library_root_id=2,
            library_root_category="hoarding_library_roots",
        )
        for number in range(1, duplicate_track_count + 1)
    ]
    albums = [
        Album(key="main", name="Album One", album_artist="Artist One", tracks=main_tracks),
        Album(key="loose", name="Album One", album_artist="Artist One", tracks=duplicate_tracks),
    ]

    _link_duplicate_album_sources(albums)

    assert len(get_album_duplicate_sources(albums[0])) == 2
    assert set(albums[0].root_provenance["categories"]) == expected_categories


def test_membership_does_not_build_track_signatures_without_competing_sources(monkeypatch):
    from music_app.services import album_local_membership as membership

    entries = [
        {**asdict(_track(f"main/album-{album}", number, album=f"Album {album}")), "library_root_id": 1}
        for album in range(50) for number in range(1, 13)
    ]

    def unnecessary_signature(_value):
        pytest.fail("A single physical source cannot be a strict subset of another source")

    monkeypatch.setattr(membership, "_duration", unnecessary_signature)
    assert membership.rejected_local_album_paths(entries) == {}


def test_membership_derives_physical_root_once_for_sibling_files(monkeypatch):
    from music_app.services import album_local_membership as membership

    entries = [
        {**asdict(_track("main/album", number)), "library_root_id": 1}
        for number in range(1, 4)
    ]
    original = membership.physical_album_root
    calls = []

    def counted_physical_album_root(path):
        calls.append(path)
        return original(path)

    def repeated_folder_derivation(_path):
        pytest.fail("Memo identity must not repeat PurePath folder derivation")

    monkeypatch.setattr(membership, "physical_album_root", counted_physical_album_root)
    monkeypatch.setattr(membership, "physical_album_folder", repeated_folder_derivation)

    assert membership.rejected_local_album_paths(entries) == {}
    assert len(calls) == 1


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/music/Artist/Album/01.flac", "/music/Artist/Album"),
        (r"C:\Music\Artist\Album\01.flac", r"c:\music\artist\album"),
        (r"\\Server\Share\Artist\Album\01.flac", r"\\server\share\artist\album"),
        (r"C:Artist\Album\01.flac", r"c:artist\album"),
        ("/music/Artist/Album/", "/music/Artist"),
        ("C:\\Music\\Artist\\Album\\", r"c:\music\artist"),
        ("/music/Artist/Album/CD1/01.flac", "/music/Artist/Album"),
        (r"C:\Music\Artist\Album\Disc 02\01.flac", r"c:\music\artist\album"),
    ],
)
def test_physical_album_root_preserves_path_style_and_disc_folder_parity(path, expected):
    assert physical_album_root(path) == expected


def test_membership_still_rejects_only_strict_subset_from_competing_sources():
    entries = [
        {**asdict(_track(folder, number)), "library_root_id": root}
        for folder, root, numbers in [("main/full", 1, (1, 2)),
                                    ("hoard/subset", 2, (1,)),
                                    ("arrivals/equal", 3, (1, 2))]
        for number in numbers
    ]
    assert rejected_local_album_paths(entries) == {
        str(Path("hoard/subset/01.flac")): "Duplicate track outside album folder",
    }
