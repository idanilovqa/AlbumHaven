from __future__ import annotations

from types import SimpleNamespace

from music_app.services.repair_previews import (
    _build_artist_alias_repairs_for_entry,
    _build_disc_marker_repairs_for_entry,
    _build_encoding_repair_preview,
    _collect_track_problem_rows,
)


def test_build_disc_marker_repairs_for_entry_extracts_clean_album_and_disc_number():
    repairs = _build_disc_marker_repairs_for_entry(
        {
            "album": "Kid A (disc 2)",
            "disc_number": "",
        }
    )

    assert repairs == {
        "album": "Kid A",
        "disc_number": "2",
    }


def test_build_artist_alias_repairs_for_entry_skips_collaboration_names():
    repairs = _build_artist_alias_repairs_for_entry(
        {"album_artist": "Artist A & Artist B"},
        {"Artist A & Artist B": "Artist A"},
    )

    assert repairs == {}


def test_collect_track_problem_rows_marks_mismatch_and_ignorable_rows():
    track_path = r"C:\Music\Artist\Album\song.mp3"
    album = SimpleNamespace(
        is_compilation=False,
        tracks=[SimpleNamespace(path=track_path)],
    )
    file_cache = {
        track_path: {
            "path": track_path,
            "album": "Album CD1",
            "album_artist": "Alias Artist",
            "artist": "Track Artist",
            "title": "Song",
            "year": "",
            "track_number": "",
        }
    }

    rows = _collect_track_problem_rows(
        album,
        file_cache,
        ignored_row_keys=set(),
        alias_to_canonical={"Alias Artist": "Canonical Artist"},
    )

    assert len(rows) == 1
    assert rows[0]["path"] == track_path
    assert "Disc marker in album name" in rows[0]["reasons"]
    assert "Artist name variant differs from canonical" in rows[0]["reasons"]
    assert "Missing year" in rows[0]["reasons"]
    assert "Missing track number" in rows[0]["reasons"]
    assert rows[0]["ignorable_reasons"] == [
        {
            "reason": "Missing year",
            "field": "year",
            "row_key": f"{track_path}::year",
        }
    ]


def test_collect_track_problem_rows_marks_missing_year_as_ignorable():
    album = SimpleNamespace(
        is_compilation=False,
        tracks=[SimpleNamespace(path="a.mp3")],
    )

    rows = _collect_track_problem_rows(
        album,
        {
            "a.mp3": {
                "path": "a.mp3",
                "album": "Test Album",
                "album_artist": "Test Artist",
                "artist": "Test Artist",
                "title": "Song",
                "year": "",
                "track_number": "1",
            },
        },
        ignored_row_keys=set(),
        alias_to_canonical={},
    )

    assert rows == [
        {
            "path": "a.mp3",
            "filename": "a.mp3",
            "file_type": "MP3",
            "reasons": ["Missing year"],
            "ignorable_reasons": [
                {
                    "reason": "Missing year",
                    "field": "year",
                    "row_key": "a.mp3::year",
                },
            ],
        },
    ]


def test_build_encoding_repair_preview_includes_alias_and_disc_marker_repairs():
    track_path = r"C:\Music\Artist\Album\song.mp3"
    album = SimpleNamespace(
        name="Album CD1",
        album_artist="Alias Artist",
        tracks=[SimpleNamespace(path=track_path)],
    )
    file_cache = {
        track_path: {
            "path": track_path,
            "album": "Album CD1",
            "album_artist": "Alias Artist",
            "artist": "Track Artist",
            "title": "Song",
            "year": "2001",
            "disc_number": "",
            "track_number": "1",
        }
    }

    preview = _build_encoding_repair_preview(
        album,
        file_cache,
        ignored_row_keys=set(),
        alias_to_canonical={"Alias Artist": "Canonical Artist"},
    )

    assert preview["has_repairs"] is True
    assert preview["raw_name"] == "Album CD1"
    assert preview["raw_album_artist"] == "Alias Artist"
    assert preview["preview_rows"] == [
        {
            "row_key": f"{track_path}::album_artist",
            "path": track_path,
            "track_title": "Song",
            "field": "album_artist",
            "original": "Alias Artist",
            "repaired": "Canonical Artist",
        },
        {
            "row_key": f"{track_path}::album_disc_marker",
            "path": track_path,
            "track_title": "Song",
            "field": "album_disc_marker",
            "original": "Album CD1",
            "repaired": "Album: Album; Disc Number: 1",
        },
    ]


def test_build_encoding_repair_preview_can_skip_preview_rows_for_summary_only_calls():
    track_path = r"C:\Music\Artist\Album\song.mp3"
    album = SimpleNamespace(
        name="Album CD1",
        album_artist="Alias Artist",
        tracks=[SimpleNamespace(path=track_path)],
    )
    file_cache = {
        track_path: {
            "path": track_path,
            "album": "Album CD1",
            "album_artist": "Alias Artist",
            "artist": "Track Artist",
            "title": "Song",
            "year": "2001",
            "disc_number": "",
            "track_number": "1",
        }
    }

    preview = _build_encoding_repair_preview(
        album,
        file_cache,
        ignored_row_keys=set(),
        alias_to_canonical={"Alias Artist": "Canonical Artist"},
        include_preview_rows=False,
    )

    assert preview == {
        "has_repairs": True,
        "raw_name": "Album CD1",
        "raw_album_artist": "Alias Artist",
        "preview_rows": [],
    }
