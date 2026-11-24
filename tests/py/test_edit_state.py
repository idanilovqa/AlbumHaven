from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.routes import api_view_payload_helpers
from music_app.services import edit_state as edit_state_module
from music_app.services.edit_state import (
    build_affected_album_dicts,
    find_album_dicts_by_track_paths,
    rebuild_affected_albums_in_state,
    update_cache_entry_after_repairs,
)


def test_find_album_dicts_by_track_paths_returns_matching_album_dicts(tmp_path):
    track_path = str((tmp_path / "Artist" / "Album" / "song.mp3").resolve())
    track = SimpleNamespace(
        path=track_path,
        title="Song",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Test Artist",
        album="Test Album",
        album_artist="Test Artist",
        year="2001",
        release_date=None,
        edition="",
        album_rating=0,
        exception_type=None,
        cover_path=None,
        duration_seconds=0,
    )
    matching_album = SimpleNamespace(
        tracks=[track],
        key="album-1",
        name="Test Album",
        album_artist="Test Artist",
        artists=["Test Artist"],
        cover_path=None,
        year="2001",
        edition="",
        album_rating=0,
        total_duration_seconds=0,
        is_compilation=False,
    )

    matches = find_album_dicts_by_track_paths([matching_album], {track_path})

    assert len(matches) == 1
    assert matches[0]["key"] == "album-1"
    assert matches[0]["album_artist"] == "Test Artist"
    assert matches[0]["name"] == "Test Album"
    assert matches[0]["tracks"][0]["path"] == track_path
    assert matches[0]["tracks"][0]["title"] == "Song"


def test_partial_rebuild_replaces_automatically_year_split_albums(tmp_path):
    paths = [
        str(tmp_path / str(year) / "song.flac")
        for year in (2001, 2011)
    ]
    previous_file_cache = {
        path: {
            "path": path,
            "title": f"Song {year}",
            "track_number": 1,
            "disc_number": 1,
            "artist": "Test Artist",
            "album_artist": "Test Artist",
            "album": "Test Album",
            "year": year,
            "duration_seconds": 180,
        }
        for path, year in zip(paths, (2001, 2011), strict=True)
    }
    existing_albums = edit_state_module.build_albums_from_file_cache(previous_file_cache)
    updated_file_cache = {
        **previous_file_cache,
        paths[0]: {**previous_file_cache[paths[0]], "title": "Updated Song"},
    }
    state = {"albums": existing_albums}

    rebuild_affected_albums_in_state(
        state,
        previous_file_cache,
        updated_file_cache,
        {paths[0]},
        set(),
    )

    assert [(album.year, album.key) for album in state["albums"]] == [
        (2001, "test artist::test album::year::2001"),
        (2011, "test artist::test album::year::2011"),
    ]
    assert [
        (album["year"], album["key"])
        for album in build_affected_album_dicts(
            previous_file_cache,
            updated_file_cache,
            {paths[0]},
            {paths[0]},
            set(),
            library_state=state,
        )
    ] == [(2001, "test artist::test album::year::2001")]


def test_partial_rebuild_places_an_album_by_the_published_sort_order(tmp_path):
    # Same artist and year: the published order is by release date before name.
    releases = (("2001-01-01", "Bravo"), ("2001-06-01", "Charlie"), ("2001-12-01", "Alpha"))
    file_cache = {
        str(tmp_path / name / "song.flac"): {
            "path": str(tmp_path / name / "song.flac"), "title": "Song", "track_number": 1,
            "disc_number": 1, "artist": "Test Artist", "album_artist": "Test Artist", "album": name,
            "year": 2001, "release_date": release_date, "duration_seconds": 180,
        }
        for release_date, name in releases
    }
    state = {"albums": edit_state_module.build_albums_from_file_cache(file_cache)}
    assert [album.name for album in state["albums"]] == ["Bravo", "Charlie", "Alpha"]
    changed = str(tmp_path / "Charlie" / "song.flac")
    updated_file_cache = {**file_cache, changed: {**file_cache[changed], "title": "Updated Song"}}

    rebuild_affected_albums_in_state(state, file_cache, updated_file_cache, {changed}, set())

    assert [album.name for album in state["albums"]] == ["Bravo", "Charlie", "Alpha"]
    assert state["albums"][1].tracks[0].title == "Updated Song"


def test_partial_rebuild_keeps_explicit_year_siblings(tmp_path):
    paths = [str(tmp_path / str(year) / "song.flac") for year in (2001, 2011)]
    file_cache = {
        path: {
            "path": path,
            "title": f"Song {year}",
            "track_number": 1,
            "disc_number": 1,
            "artist": "Test Artist",
            "album_artist": "Test Artist",
            "album": "Test Album",
            "year": year,
            "duration_seconds": 180,
        }
        for path, year in zip(paths, (2001, 2011), strict=True)
    }
    separate_release_keys = {"test artist::test album"}
    state = {
        "albums": edit_state_module.build_albums_from_file_cache(
            file_cache, separate_release_keys
        )
    }
    updated_file_cache = {
        **file_cache,
        paths[0]: {**file_cache[paths[0]], "title": "Updated Song"},
    }

    rebuild_affected_albums_in_state(
        state,
        file_cache,
        updated_file_cache,
        {paths[0]},
        separate_release_keys,
    )

    assert [(album.year, album.key) for album in state["albums"]] == [
        (2001, "test artist::test album::year::2001"),
        (2011, "test artist::test album::year::2011"),
    ]


def test_edit_state_module_does_not_expose_flask_state_fallbacks():
    assert not hasattr(edit_state_module, "state")
    assert not hasattr(edit_state_module, "find_albums_by_track_paths")


def test_cache_entry_album_key_uses_service_owned_loose_track_album_detection(monkeypatch):
    monkeypatch.setattr(api_view_payload_helpers, "_is_loose_track_album_value", lambda _value: False)

    album_key = edit_state_module._cache_entry_album_key(
        {
            "album": "!Non album",
            "album_artist": "Mono",
            "exception_type": "",
        },
        set(),
    )

    assert album_key is None


def test_update_cache_entry_after_repairs_uses_module_logger_without_flask_context(monkeypatch):
    warnings: list[tuple[str, tuple[object, ...]]] = []

    class CapturingLogger:
        def warning(self, message, *args):
            warnings.append((message, args))

    monkeypatch.setattr(edit_state_module, "logger", CapturingLogger())

    updated = update_cache_entry_after_repairs(
        Path("missing-song.mp3"),
        {"title": "Old", "exception_type": ""},
        {"title": "New"},
    )

    assert updated["title"] == "New"
    assert warnings == [
        (
            "Could not stat repaired file %s: %s",
            (Path("missing-song.mp3"), warnings[0][1][1]),
        )
    ]


def test_update_cache_entry_after_year_repair_keeps_precise_release_date_in_sync(
    tmp_path,
):
    track_path = tmp_path / "song.mp3"
    track_path.write_bytes(b"audio")

    updated = update_cache_entry_after_repairs(
        track_path,
        {
            "year": 2004,
            "release_date": "2004-07-16",
        },
        {"year": "2014"},
    )

    assert updated["year"] == "2014"
    assert updated["release_date"] == "2014"


def test_replaced_album_index_keeps_order_and_lookups_without_reindexing():
    from music_app.services.library_album_index import LibraryAlbumIndex

    def album(key, artist, path):
        return SimpleNamespace(key=key, album_artist=artist, year=None, name=key, tracks=[SimpleNamespace(path=path)])

    first, middle, last = album("a::x", "A", "a.mp3"), album("m::x", "M", "m.mp3"), album("z::x", "Z", "z.mp3")
    index = LibraryAlbumIndex([first, middle, last])
    rebuilt = [album("m::x::year::2001", "M", "m.mp3"), album("n::x", "N", "n.mp3")]

    derived = index.replaced([middle], rebuilt, sort_key=edit_state_module.album_sort_key)

    assert derived.albums == [first, *rebuilt, last]
    assert derived.albums_with_any_track({"z.mp3", "n.mp3", "m.mp3"}) == [*rebuilt, last]
    assert derived.album("m::x") is None and derived.album("n::x") is rebuilt[1]
    assert derived.albums_of_releases({"m::x"}) == [rebuilt[0]]
    # The source index is untouched.
    assert index.albums == [first, middle, last] and index.album("m::x") is middle


def test_a_written_field_clears_its_display_correction(tmp_path):
    path = tmp_path / "track.mp3"
    path.write_bytes(b"audio")
    entry = {"artist": "A", "album_artist": "B", "text_corrections": {
        "artist": {"original": "??", "corrected": "A", "kind": "lost_characters"},
        "album_artist": {"original": "\u00c3\u00a9", "corrected": "B", "kind": "decoded"}}}
    partly = edit_state_module.update_cache_entry_after_repairs(path, entry, {"artist": "A"})
    assert set(partly["text_corrections"]) == {"album_artist"}
    fully = edit_state_module.update_cache_entry_after_repairs(path, partly, {"album_artist": "B"})
    assert fully["text_corrections"] is None


def test_a_tag_write_is_hidden_from_the_library_watcher(tmp_path, monkeypatch):
    from music_app.services.library_watch_suppression import is_library_watch_event_suppressed

    path = tmp_path / "track.mp3"
    observed = []

    def write(target, repairs):
        observed.append(is_library_watch_event_suppressed(target))
        return True, sorted(repairs)

    monkeypatch.setattr(edit_state_module, "apply_text_repairs_to_file", write)

    assert edit_state_module.apply_repairs_worker(str(path), {"album": "B"}) == (str(path), True, ["album"])
    assert observed == [True]


def test_a_failed_tag_write_leaves_the_file_visible_to_the_library_watcher(tmp_path, monkeypatch):
    """FTC-TAGS-008 (run 45470185804, diagnostic run 45494961464): the save's write failed, the file was put
    back within the grace period, and the watcher dropped that restore, so the album kept only its other track."""
    from music_app.services.library_watch_suppression import is_library_watch_event_suppressed

    path = tmp_path / "track.mp3"

    def write(_target, _repairs):
        raise PermissionError("the file cannot be written")

    monkeypatch.setattr(edit_state_module, "apply_text_repairs_to_file", write)

    with pytest.raises(PermissionError):
        edit_state_module.apply_repairs_worker(str(path), {"album": "B"})
    assert is_library_watch_event_suppressed(path) is False
