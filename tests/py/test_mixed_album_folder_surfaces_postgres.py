"""Every surface says "Mixed album metadata in one folder" by the same strict rule (owner, 2026-11-24).

A folder is a multi-album folder only when it holds two or more complete albums and nothing else
(multi_album_folders.strict_multi_album_folders). A folder of covers, where one album has just a few of its
tracks, is not: none of its tracks may say the folder is mixed, in Album Details, the artist's gallery, the
albums a save or Cover Look Up reads by track path, or Problematic Files. A strict folder says it on each of them.
(Loose Tracks reads the stored membership label, guarded in test_strict_multi_album_folder_duplicate_definition_postgres.)
"""
from __future__ import annotations

import json

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (live fixture)

MIXED = "Mixed album metadata in one folder"


def _entry(fixture, folder, album, number, *, total=None):
    entry = fixture.entry(f"Owner/{folder}/{album} {number:02d}.flac", album=album)
    return {**entry, "track_number": number, "total_tracks": total, "title": f"{album} {number}"}


def _album_keys(fixture):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        return {row["title"]: row["album_key"] for row in connection.execute(
            "select title, album_key from library.local_albums").fetchall()}


def _surfaces(fixture, album, paths):
    """Each surface's payload for that album, as JSON text."""
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    key = _album_keys(fixture)[album]
    artist_gallery = repository.build_selected_artist_payload(query_params={"artist": "Owner", "surface": "albums"})
    return {
        "album details": repository.build_album_detail_payload(key),
        "artist gallery": [
            candidate for group in artist_gallery.get("primary_artist_groups") or artist_gallery.get("artist_groups") or []
            for candidate in group.get("albums") or [] if candidate.get("name") == album
        ],
        "albums by track path": repository.build_album_payloads_by_track_paths(set(paths)),
        "problematic files": repository.build_problematic_file_detail_payload(key),
    }


def _saying_mixed(surfaces):
    return sorted(name for name, payload in surfaces.items() if MIXED in json.dumps(payload, default=str))


def test_a_folder_of_covers_says_mixed_on_no_surface_and_a_real_multi_album_folder_on_every_one(
    watcher_repair_inventory,
):
    fixture = watcher_repair_inventory
    # Covers: two tracks (13 and 14) of a 14-track album beside a complete one. Not a multi-album folder.
    covers = [_entry(fixture, "Covers", "Post Album", 13), _entry(fixture, "Covers", "Post Album", 14),
              _entry(fixture, "Covers", "Other Album", 1, total=2), _entry(fixture, "Covers", "Other Album", 2, total=2)]
    # Two complete albums and nothing else: a multi-album folder.
    split = [_entry(fixture, "Split", "Left Album", 1, total=2), _entry(fixture, "Split", "Left Album", 2, total=2),
             _entry(fixture, "Split", "Right Album", 1, total=2), _entry(fixture, "Split", "Right Album", 2, total=2)]
    fixture.seed(*covers, *split)

    covers_surfaces = _surfaces(fixture, "Post Album", [entry["path"] for entry in covers[:2]])
    split_surfaces = _surfaces(fixture, "Left Album", [entry["path"] for entry in split[:2]])

    assert _saying_mixed(covers_surfaces) == [], "a folder of covers is not a multi-album folder"
    # The track "!" in Album Details: a complete album in a folder of covers has none; a real multi-album
    # folder's tracks have it, for that reason.
    other = _surfaces(fixture, "Other Album", [entry["path"] for entry in covers[2:]])["album details"]
    assert [track.get("is_problematic") for track in other["tracks"]] == [False, False]
    left_tracks = split_surfaces["album details"]["tracks"]
    assert all(track.get("is_problematic") and MIXED in (track.get("problem_reasons") or []) for track in left_tracks)
    assert {"album details", "problematic files"} <= set(_saying_mixed(split_surfaces)), (
        f"a real multi-album folder says so: {_saying_mixed(split_surfaces)}"
    )


def test_a_stale_stored_mixed_label_from_an_older_scan_says_mixed_on_no_surface(watcher_repair_inventory):
    """Older scans stored "Mixed album metadata in one folder" in a file's scan entry for any folder of two album
    names. The strict rule owns that reason now (owner, fix A, 2026-11-25): a stored copy of the old label in a
    folder that is not a multi-album folder shows on no surface, and nothing rewrites the stored scan entry."""
    fixture = watcher_repair_inventory
    covers = [_entry(fixture, "Covers", "Post Album", 13), _entry(fixture, "Covers", "Post Album", 14),
              _entry(fixture, "Covers", "Other Album", 1, total=2), _entry(fixture, "Covers", "Other Album", 2, total=2)]
    fixture.seed(*covers)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        stamped = connection.execute(
            """update library.local_track_files
               set metadata = jsonb_set(metadata, '{scan_cache,file_entry,local_album_membership_problem}', to_jsonb(%s::text))
               where private_path = any(%s) returning id""", (MIXED, [entry["path"] for entry in covers])).fetchall()
    assert len(stamped) == len(covers)

    for album, entries in (("Post Album", covers[:2]), ("Other Album", covers[2:])):
        surfaces = _surfaces(fixture, album, [entry["path"] for entry in entries])
        assert _saying_mixed(surfaces) == [], f"{album}: a stale stored label says mixed"
    other = _surfaces(fixture, "Other Album", [entry["path"] for entry in covers[2:]])["album details"]
    assert [track.get("is_problematic") for track in other["tracks"]] == [False, False], "the complete album has no \"!\""
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        kept = connection.execute(
            """select count(*) as kept from library.local_track_files
               where metadata #>> '{scan_cache,file_entry,local_album_membership_problem}' = %s""", (MIXED,)).fetchone()
    assert kept["kept"] == len(covers), "the stored scan entries are not rewritten"


def test_a_file_whose_only_label_is_the_stale_mixed_one_counts_in_its_album_card_and_not_in_loose_tracks(
    watcher_repair_inventory,
):
    """The obsolete stored mixed-folder label (owner, fix A, 2026-11-25) takes no file out of its album: the
    artist gallery card counts it and Loose Tracks does not list it."""
    from music_app.services import library_browse_postgres as browse, loose_track_store

    fixture = watcher_repair_inventory
    album = [_entry(fixture, "Plain", "Whole Album", 1, total=2), _entry(fixture, "Plain", "Whole Album", 2, total=2)]
    fixture.seed(*album)
    stale = album[0]["path"]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute(
            """update library.local_track_files
               set metadata = jsonb_set(metadata, '{scan_cache,file_entry,local_album_membership_problem}', to_jsonb(%s::text))
               where private_path = %s""", (MIXED, stale))

    repository = browse.PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    gallery = repository.build_selected_artist_payload(query_params={"artist": "Owner", "surface": "albums"})
    cards = [candidate for group in gallery.get("primary_artist_groups") or gallery.get("artist_groups") or []
             for candidate in group.get("albums") or [] if candidate.get("name") == "Whole Album"]
    assert [card.get("track_count", card.get("track_count_preview")) for card in cards] == [2], (
        "the album card counts the file with the stale label")
    loose_track_store.prepare(repository._inventory_repository, repository._owned_connection_context)
    loose = repository.build_library_loose_tracks_payload(query_params={})
    assert stale not in json.dumps(loose, default=str), "Loose Tracks lists a file of a formed album"


def test_an_albumless_file_whose_only_label_is_the_stale_mixed_one_stays_in_loose_tracks(watcher_repair_inventory):
    """A file never vanishes (6, 2026-11-25): a file without an album whose only stored label is the obsolete
    mixed-folder one stays a Loose Tracks candidate, listed without that reason."""
    from music_app.services import library_browse_postgres as browse, loose_track_store

    fixture = watcher_repair_inventory
    home = [_entry(fixture, "Home", "Xi", 1, total=2), _entry(fixture, "Home", "Xi", 2, total=2)]
    # A song without an album tag: the scan gives it no album.
    copy = {**_entry(fixture, "Loose", "Untagged", 9), "album": ""}
    fixture.seed(*home, copy)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        albumless = connection.execute(
            """select tracks.album_id from library.local_track_files files
               left join library.local_tracks tracks on tracks.id = files.track_id
               where files.private_path = %s""", (copy["path"],)).fetchone()
        assert albumless is not None and albumless["album_id"] is None, "precondition: the copy has no album"
        connection.execute(
            """update library.local_track_files
               set metadata = jsonb_set(metadata, '{scan_cache,file_entry,local_album_membership_problem}', to_jsonb(%s::text))
               where private_path = %s""", (MIXED, copy["path"]))

    repository = browse.PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    loose_track_store.prepare(repository._inventory_repository, repository._owned_connection_context)
    loose = repository.build_library_loose_tracks_payload(query_params={})
    listed = [track for track in loose.get("library_non_album_tracks") or []
              if copy["path"] in json.dumps(track, default=str)]
    assert len(listed) == 1, "the albumless file vanished from Loose Tracks"
    assert MIXED not in json.dumps(listed, default=str)


@pytest.fixture(autouse=True)
def _problematic_index_off(monkeypatch):
    # Problematic Files' own read (the persisted index is proven elsewhere).
    monkeypatch.setenv("ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED", "0")

