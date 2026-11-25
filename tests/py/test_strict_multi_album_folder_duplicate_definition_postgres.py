"""Guards two DUPLICATE DEFINITIONS that must never drift (6.5's backlog deletes the Python copies).

1. The strict multi-album folder rule: multi_album_folders.strict_multi_album_folders (Python, for the in-memory
   cover paths) and the strict CTE in the Problematic Files row SQL (what every page, detail and index batch reads).
2. The local album membership label: album_local_membership.rejected_local_album_paths (the scan) and its SQL twin
   (local_album_membership_ctes_sql, which Album Details reads live). Only files the rule rejects carry a label;
   a file that forms an album never says its folder is mixed.

One case table runs through both sides of each.
"""
from __future__ import annotations

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (live fixture)

MIXED = "Mixed album metadata in one folder"


def _cases(fixture):
    """(folder, strict?, entries) per case; every case has its own album artist so cases never meet."""
    def entry(case, folder, album, number, *, total=None, title=None, exception=None):
        made = fixture.entry(f"{case}/{folder}/{album} {number:02d} {title or ''}.flac".replace(" .", "."),
                             artist=case, album=album, exception=exception)
        return {**made, "album_artist": case, "track_number": number, "total_tracks": total,
                "title": title or f"{album} {number}", "duration_seconds": 100 + number}

    return {
        # Two tracks of a 14-track album beside a complete one: a folder of covers.
        "covers": ("Covers", False, [entry("covers", "Covers", "Post Album", 13), entry("covers", "Covers", "Post Album", 14),
                                     entry("covers", "Covers", "Other Album", 1, total=2),
                                     entry("covers", "Covers", "Other Album", 2, total=2)]),
        "strict": ("Split", True, [entry("strict", "Split", "Left Album", 1, total=2),
                                   entry("strict", "Split", "Left Album", 2, total=2),
                                   entry("strict", "Split", "Right Album", 1, total=2),
                                   entry("strict", "Split", "Right Album", 2, total=2)]),
        # One release split by disc tags is one album.
        "disc split": ("Discs", False, [entry("discs", "Discs", "Twin (Disc 1)", 1, total=2),
                                        entry("discs", "Discs", "Twin (Disc 1)", 2, total=2),
                                        entry("discs", "Discs", "Twin (Disc 2)", 1, total=2),
                                        entry("discs", "Discs", "Twin (Disc 2)", 2, total=2)]),
        # A song with an exception type makes the folder a collection.
        "loose song": ("Loose", False, [entry("loose", "Loose", "Alpha", 1, total=2), entry("loose", "Loose", "Alpha", 2, total=2),
                                        entry("loose", "Loose", "Beta", 1, total=2), entry("loose", "Loose", "Beta", 2, total=2),
                                        entry("loose", "Loose", "Gamma", 1, exception="non-album rarity"),
                                        # No album tag: the membership rule rejects it, and it keeps its label.
                                        {**entry("loose", "Loose", "Untagged", 9), "album": ""}]),
        # An album with files in another folder.
        "elsewhere": ("Here", False, [entry("elsewhere", "Here", "Delta", 1, total=2), entry("elsewhere", "Here", "Delta", 2, total=2),
                                      entry("elsewhere", "Here", "Epsilon", 1, total=3),
                                      entry("elsewhere", "Here", "Epsilon", 2, total=3),
                                      entry("elsewhere", "There", "Epsilon", 3, total=3)]),
        # A proven copy of another album's track does not count against two complete albums.
        "copy": ("Pair", True, [entry("copy", "Pair", "Mu", 1, total=2), entry("copy", "Pair", "Mu", 2, total=2),
                                entry("copy", "Pair", "Nu", 1, total=2), entry("copy", "Pair", "Nu", 2, total=2),
                                entry("copy", "Pair", "Xi", 1, total=2, title="Xi 1"),
                                entry("copy", "Home", "Xi", 1, total=2, title="Xi 1"),
                                entry("copy", "Home", "Xi", 2, total=2, title="Xi 2")]),
    }


@pytest.fixture
def seeded(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    cases = _cases(fixture)
    fixture.seed(*(entry for _folder, _strict, entries in cases.values() for entry in entries))
    return fixture, cases


def _album_ids(fixture):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        return {(row["artist"], row["title"]): (row["id"], row["album_key"]) for row in connection.execute(
            """select albums.id, albums.album_key, albums.title, artists.name as artist from library.local_albums albums
               join library.local_artists artists on artists.id = albums.artist_id""").fetchall()}


def test_the_strict_rule_in_sql_and_in_python_agree_on_every_case(seeded):
    from music_app.services.album_local_membership import physical_album_folder, rejected_local_album_paths
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository, _row_json_mapping, _row_mapping
    from music_app.services.multi_album_folders import strict_multi_album_folders

    fixture, cases = seeded
    every = [entry for _folder, _strict, entries in cases.values() for entry in entries]
    rejected = rejected_local_album_paths(every)
    python_strict = strict_multi_album_folders(
        {**entry, "local_album_membership_problem": rejected.get(entry["path"])} for entry in every)
    repository = PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    rows = [_row_mapping(row) for row in repository._load_problematic_file_rows(
        album_ids=sorted(album_id for album_id, _key in _album_ids(fixture).values()))]
    sql_strict = {physical_album_folder(row["file_private_path"]) for row in rows
                  if row.get("file_mixed_album_folder") is True and row.get("file_private_path")}

    verdicts = {}
    for name, (_folder, expected, entries) in cases.items():
        folder = physical_album_folder(entries[0]["path"])
        verdicts[name] = (expected, folder in python_strict, folder in sql_strict)
    assert {name: verdict for name, verdict in verdicts.items() if len(set(verdict)) > 1} == {}, (
        "(expected, python, sql) per case")


def test_the_membership_label_in_sql_and_in_python_agree_and_no_formed_album_track_says_mixed(seeded):
    from music_app.services.album_local_membership import physical_album_folder, rejected_local_album_paths
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository, _row_json_mapping, _row_mapping

    fixture, cases = seeded
    every = [entry for _folder, _strict, entries in cases.values() for entry in entries]
    python_labels = rejected_local_album_paths(every)
    # A real multi-album folder's tracks say so by the strict rule; the membership label never does.
    strict_folders = {physical_album_folder(entries[0]["path"]) for _folder, strict, entries in cases.values() if strict}
    repository = PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    sql_labels, mixed_on_album_tracks = {}, []
    for _album_id, album_key in _album_ids(fixture).values():
        detail = repository.build_album_detail_payload(album_key) or {}
        for track in detail.get("tracks") or []:
            if MIXED in (track.get("problem_reasons") or []) and physical_album_folder(
                    str(track.get("path") or "")) not in strict_folders:
                mixed_on_album_tracks.append(track.get("path"))
        for row in map(_row_mapping, repository._load_album_detail_rows(album_key)):
            entry = _row_json_mapping(row.get("file_entry"))
            path = entry.get("path") or row.get("private_path")
            if path and entry.get("local_album_membership_problem"):
                sql_labels[str(path)] = entry["local_album_membership_problem"]

    assert mixed_on_album_tracks == [], "a track of a formed album outside a multi-album folder says mixed"
    formed = set(sql_labels) | {path for path in python_labels if path in sql_labels}
    assert {path: sql_labels.get(path) for path in formed} == {path: python_labels.get(path) for path in formed}


def test_only_files_the_membership_rule_rejects_carry_a_label_and_they_keep_it(seeded):
    """The stored label Loose Tracks and the gallery read (file_entry.local_album_membership_problem): set by the
    scan for files the membership rule rejects, never for a file that forms an album."""
    from music_app.services.album_local_membership import rejected_local_album_paths

    fixture, cases = seeded
    every = [entry for _folder, _strict, entries in cases.values() for entry in entries]
    rejected = rejected_local_album_paths(every)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        stored = {row["private_path"]: row["label"] for row in connection.execute(
            """select private_path, metadata #>> '{scan_cache,file_entry,local_album_membership_problem}' as label
               from library.local_track_files
               where nullif(metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null"""
        ).fetchall()}
    assert {path: label for path, label in stored.items() if label != rejected.get(path)} == {}
    untagged = next(entry["path"] for entry in cases["loose song"][2] if not entry["album"])
    assert rejected.get(untagged) and stored.get(untagged) == rejected[untagged], (
        "a file the membership rule rejects keeps its label")
