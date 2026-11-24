"""Owner (2026-11-24): songs copied into a folder of random tracks are duplicates of their album's tracks.

A folder holding several albums never turns a proven copy into a mixed-folder problem: the scan's stored
membership problem and Album Details' own classification (the SQL twin) both keep the duplicate type.
Synthetic layout on a throwaway database only."""
from pathlib import Path

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401

DUPLICATE = "Duplicate track outside album folder"
ALBUMS = ("Album One", "Album Two", "Album Three")


def _seed_copy_folder_library(fixture):
    entries, copies, real = [], set(), set()
    for album_index, album in enumerate(ALBUMS, start=1):
        for number in (1, 2, 3):
            entry = fixture.entry(f"Owner/{album}/{number:02d}.flac", album=album)
            entry.update(title=f"{album} song {number}", track_number=number,
                         duration_seconds=170 + album_index * 10 + number)
            entries.append(entry)
        for number in (1, 2):
            copy = fixture.entry(f"Owner/Copied songs/{album_index}-{number:02d}.flac", album=album)
            copy.update(title=f"{album} song {number}", track_number=number,
                        duration_seconds=170 + album_index * 10 + number)
            entries.append(copy)
            copies.add(copy["path"])
    for album in ("Soundtrack A", "Soundtrack B"):
        for number in (1, 2):
            entry = fixture.entry(f"Owner/Soundtracks/{album[-1]}-{number:02d}.flac", album=album)
            entry.update(title=f"{album} theme {number}", track_number=number)
            entries.append(entry)
            real.add(entry["path"])
    fixture.seed(*entries)
    return copies, real


def _membership_sql():
    from music_app.services.album_local_membership import local_album_membership_ctes_sql

    return (
        """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library' and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        """
        + local_album_membership_ctes_sql(scope_album_key=True)
        + " select private_path, problem from local_album_membership"
    )


def test_live_a_copy_folder_keeps_every_copy_as_a_duplicate_track(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    copies, real = _seed_copy_folder_library(fixture)

    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        stored = {
            row["private_path"]: row["problem"]
            for row in connection.execute(
                """select private_path,
                     metadata #>> '{scan_cache,file_entry,local_album_membership_problem}' as problem
                   from library.local_track_files where scan_cache_stale is false"""
            ).fetchall()
        }
        album_keys = {row["title"]: row["album_key"] for row in connection.execute(
            "select title, album_key from library.local_albums where title = any(%s)", (list(ALBUMS),),
        ).fetchall()}
        # Album Details classifies the opened album's files (and their folder neighbours, for context):
        # each album's own copies are judged in that album's run.
        twin = {}
        for index, album in enumerate(ALBUMS, start=1):
            own = {path for path in copies if Path(path).name.startswith(f"{index}-")}
            rows = connection.execute(_membership_sql(), {"album_key": album_keys[album]}).fetchall()
            twin.update({row["private_path"]: row["problem"] for row in rows if row["private_path"] in own})

    assert {path: stored[path] for path in copies} == {path: DUPLICATE for path in copies}
    assert not any(stored[path] for path in real), "a real multi-album folder's songs exist nowhere else"
    assert len(album_keys) == len(ALBUMS)
    assert twin == {path: DUPLICATE for path in copies}, (
        "Album Details classifies a proven copy as a duplicate, not as a mixed-folder file"
    )


def test_live_the_real_album_links_each_copied_track_to_its_copy(watcher_repair_inventory):
    """Owner (2026-11-24): opening the real album shows the Problematic Files icon on exactly the tracks that
    have a copy outside the album folder, and the icon leads to the copy's entry."""
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    fixture = watcher_repair_inventory
    copies, _real = _seed_copy_folder_library(fixture)
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        album_key = connection.execute(
            "select album_key from library.local_albums where title = 'Album One'").fetchone()["album_key"]

    detail = PostgresLibraryBrowseRepository(fixture.config).build_album_detail_payload(album_key)

    marked = {track["title"]: track for track in detail["tracks"] if track.get("is_problematic")}
    assert set(marked) == {"Album One song 1", "Album One song 2"}, "only the copied tracks carry the icon"
    for title, track in marked.items():
        assert track["problem_track_path"] in copies
        assert track["problem_track_path"].endswith(f"1-0{title[-1]}.flac"), "the link opens that track's own copy"
        assert DUPLICATE in track["problem_reasons"]
