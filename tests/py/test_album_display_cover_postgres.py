"""The display cover: a coverless album shows its folder-album's image, and nothing else."""
from __future__ import annotations

import json

import pytest
from psycopg.types.json import Jsonb

from music_app.services.album_display_cover import album_display_cover_sql
from scripts.mark_folder_cover_albums import mark_folder_cover_albums
from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory

ROOT = "C:/display-cover"


@pytest.fixture
def library(watcher_repair_inventory):
    with isolatedPostgres._connect(watcher_repair_inventory.setup_url) as connection:
        library_id = _value(connection.execute(
            "select id from library.libraries where name = 'Local Library'").fetchone())
        root_id = _value(connection.execute(
            "insert into library.library_roots (library_id, root_path) values (%s, %s) returning id",
            (library_id, ROOT)).fetchone())
        yield connection, library_id, root_id


def _value(row):
    return next(iter(row.values())) if hasattr(row, "values") else row[0]


def _album(library, name, files, *, cover=None, metadata=None):
    connection, library_id, root_id = library
    album_id = _value(connection.execute(
        """insert into library.local_albums (library_id, album_key, title, cover_path, metadata)
           values (%s, %s, %s, %s, %s) returning id""",
        (library_id, name, name, cover, Jsonb({"cover_revision": "r1"} if metadata is None else metadata)),
    ).fetchone())
    for number, (path, image) in enumerate(files, 1):
        track_id = _value(connection.execute(
            """insert into library.local_tracks (library_id, album_id, track_key, title, track_number)
               values (%s, %s, %s, %s, %s) returning id""",
            (library_id, album_id, f"{name}-{number}", f"Song {number}", number),
        ).fetchone())
        connection.execute(
            """insert into library.local_track_files (track_id, library_root_id, private_path, metadata)
               values (%s, %s, %s, %s)""",
            (track_id, root_id, path, Jsonb({"scan_cache": {"file_entry": {"cover_path": image}}})),
        )
    return album_id


def _display(library, album_id):
    return _value(library[0].execute(
        f"select {album_display_cover_sql('albums')} as cover from library.local_albums albums where albums.id = %s",
        (album_id,),
    ).fetchone())


OWN = f"{ROOT}/Artist/Album"
OTHER = f"{ROOT}/Artist/Other"
CASES = {
    "the folder's image": ([(f"{OWN}/1.flac", f"{OWN}/cover.jpg")], None, None, f"{OWN}/cover.jpg"),
    "the image above two discs": (
        [(f"{OWN}/CD1/1.flac", f"{OWN}/cover.jpg"), (f"{OWN}/CD2/1.flac", f"{OWN}/cover.jpg")],
        None, None, f"{OWN}/cover.jpg",
    ),
    "never a moved-in minority's image": (
        [(f"{OTHER}/1.flac", f"{OTHER}/old.jpg"), (f"{OWN}/2.flac", ""), (f"{OWN}/3.flac", "")], None, None, None,
    ),
    "never an image outside the track's folder": ([(f"{OWN}/1.flac", f"{OTHER}/old.jpg")], None, None, None),
    "never the library root's image": ([(f"{ROOT}/Loose/1.flac", f"{ROOT}/cover.jpg")], None, None, None),
    "never a cleared cover": ([(f"{OWN}/1.flac", f"{OWN}/cover.jpg")], None, {}, None),
    "never over a linked cover": (
        [(f"{OWN}/1.flac", f"{OWN}/cover.jpg")], None,
        {"cover_revision": "r1", "remote_cover_url": "https://example.test/cover.jpg"}, None,
    ),
    "the stored cover first": (
        [(f"{OWN}/1.flac", f"{OWN}/cover.jpg")], f"{OWN}/chosen.jpg", None, f"{OWN}/chosen.jpg",
    ),
}


@pytest.mark.parametrize("case", CASES)
def test_display_cover_follows_the_folder_album_rule(library, case):
    files, cover, metadata, expected = CASES[case]
    album_id = _album(library, "Album", files, cover=cover, metadata=metadata)
    assert _display(library, album_id) == expected


def test_recheck_marks_only_the_albums_the_fallback_fills_and_repairs_nothing(library):
    connection, library_id, _root_id = library
    filled = _album(library, "Filled", [(f"{OWN}/1.flac", f"{OWN}/cover.jpg")])
    cleared = _album(library, "Cleared", [(f"{OTHER}/1.flac", f"{OTHER}/cover.jpg")], metadata={})
    covered = _album(library, "Covered", [(f"{ROOT}/B/1.flac", "")], cover=f"{ROOT}/B/cover.jpg")
    connection.execute("delete from library.problematic_index_dirty_albums where library_id = %s", (library_id,))

    assert mark_folder_cover_albums(connection, mark=False) == 1
    assert connection.execute("select album_id from library.problematic_index_dirty_albums").fetchall() == []
    assert mark_folder_cover_albums(connection, mark=True) == 1

    marked = connection.execute("select album_id from library.problematic_index_dirty_albums").fetchall()
    assert [_value(row) for row in marked] == [filled]
    stored = connection.execute(
        "select cover_path from library.local_albums where id = any(%s) order by id", ([filled, cleared, covered],),
    ).fetchall()
    assert [_value(row) for row in stored] == [None, None, f"{ROOT}/B/cover.jpg"]


def _plan_nodes(connection, query, params):
    document = _value(connection.execute(f"explain (analyze, format json) {query}", params).fetchone())
    pending = [(json.loads(document) if isinstance(document, str) else document)[0]["Plan"]]
    while pending:
        node = pending.pop()
        pending.extend(node.get("Plans", ()))
        if node.get("Relation Name") in ("local_tracks", "local_track_files") and node.get("Actual Loops"):
            yield node


@pytest.mark.parametrize("fallbacks", (0, 1, 15))
def test_display_cover_reads_only_the_pages_fallback_albums_at_both_library_sizes(library, fallbacks):
    connection, library_id, _root_id = library
    page = [
        _album(
            library, f"Page {index}",
            [(f"{ROOT}/Page/{index}/{number}.flac", f"{ROOT}/Page/{index}/cover.jpg") for number in (1, 2)],
            cover=None if index < fallbacks else f"{ROOT}/Page/{index}/cover.jpg",
        )
        for index in range(20)
    ]
    query = f"""select {album_display_cover_sql('albums')} as cover
                from library.local_albums albums where albums.id = any(%s)"""
    reads = []
    added = 0
    for albums in (50, 1000):
        for index in range(added, albums):
            _album(library, f"Other {index}", [
                (f"{ROOT}/Other/{index}/{number}.flac", "") for number in (1, 2)
            ])
        added = albums
        for table in ("local_albums", "local_tracks", "local_track_files"):
            connection.execute(f"analyze library.{table}")
        nodes = list(_plan_nodes(connection, query, (page,)))
        if albums == 1000:
            assert not [node for node in nodes if node["Node Type"] == "Seq Scan"], nodes
        reads.append(sum(node["Actual Rows"] * node["Actual Loops"] for node in nodes))
        covers = [_value(row) for row in connection.execute(query, (page,)).fetchall()]
        assert sum(cover is not None for cover in covers) == 20

    # Two tracks and two files for each fallback album on the page, whatever the library holds.
    assert reads[1] <= 4 * fallbacks
    if not fallbacks:
        assert reads == [0, 0]
