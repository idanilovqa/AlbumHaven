"""Owner (2026-11-24, BUGFIX-30): an open Problematic Files entry lists, in its per-track table, the tracks that
carry an album-level problem wherever the files say which, as Incomplete track order lists its tracks."""
from music_app.services.library_browse_postgres import _problematic_track_problem_rows


def _album(**overrides):
    tracks = [
        {"key": "t1", "path": "A/01.flac", "title": "One"},
        {"key": "t2", "path": "A/02.flac", "title": "Two"},
        {"key": "t3", "path": "B/03.flac", "title": "Three"},
    ]
    entries = [
        {"path": track["path"], "title": track["title"], "album": "Tales", "album_artist": "Juha", "artist": "Juha",
         "year": 2013, "track_number": index + 1, "album_rating": 8}
        for index, track in enumerate(tracks)
    ]
    album = {"key": "juha::tales", "name": "Tales", "album_artist": "Juha", "year": 2013, "tracks": tracks,
             "_file_entries": entries, "_ignored_repair_keys": set(), "_duplicate_file_counts": {}}
    for path, changes in overrides.pop("entries", {}).items():
        next(entry for entry in entries if entry["path"] == path).update(changes)
    return {**album, **overrides}


def _rows_with(album, reason):
    return {row["path"] for row in _problematic_track_problem_rows(album) if reason in row["reasons"]}


def test_album_name_mismatch_lists_the_tracks_whose_album_tag_differs():
    album = _album(entries={"B/03.flac": {"album": "Tales -"}})
    assert _rows_with(album, "Album name mismatch") == {"B/03.flac"}


def test_album_artist_mismatch_lists_the_tracks_whose_album_artist_differs():
    album = _album(entries={"A/02.flac": {"album_artist": "J. K."}})
    assert _rows_with(album, "Album artist mismatch") == {"A/02.flac"}


def test_file_rating_mismatch_lists_the_tracks_whose_rating_tag_differs_from_the_app_rating():
    album = _album(file_rating_mismatch=True, _app_album_rating=6, entries={"A/01.flac": {"album_rating": 6}})
    assert _rows_with(album, "File rating mismatch") == {"A/02.flac", "B/03.flac"}


def test_duplicate_files_lists_the_tracks_held_twice():
    album = _album(has_duplicate_files=True)
    album["tracks"][2]["key"] = "t1"  # B/03 is a second file of track one
    assert _rows_with(album, "Duplicate files") == {"A/01.flac", "B/03.flac"}


def test_an_album_without_those_problems_lists_no_such_tracks():
    album = _album()
    assert not _problematic_track_problem_rows(album)


def _current(album, path):
    row = next(row for row in _problematic_track_problem_rows(album) if row["path"] == path)
    return [(value["label"], value["value"]) for value in row["current_values"]]


def test_a_problem_row_carries_the_current_values_of_the_fields_its_problems_concern():
    album = _album(entries={"A/02.flac": {"year": None}})
    assert _current(album, "A/02.flac") == [("Year", None)]


def test_a_mixed_folder_row_carries_the_values_that_differ_across_its_folder():
    """Owner (2026-11-25): a Mixed album metadata row says what is mixed: the fields that differ."""
    album = _album(entries={
        "A/01.flac": {"_mixed_album_folder": True},
        "A/02.flac": {"_mixed_album_folder": True, "album": "Crown", "year": 1993},
    })
    assert _current(album, "A/01.flac") == [("Album", "Tales"), ("Year", 2013)]
    assert _current(album, "A/02.flac") == [("Album", "Crown"), ("Year", 1993)]


def test_a_mixed_row_uses_the_fields_its_folder_read_found():
    album = _album(entries={"A/01.flac": {"_mixed_album_folder": True}},
                   _mixed_folder_fields={"A/01.flac": ["album_artist", "album"]})
    assert _current(album, "A/01.flac") == [("Album artist", "Juha"), ("Album", "Tales")]
