"""Edits always save (owner, 2026-11-22: "Any edits user makes should be saved despite any background indexing
or rescanning").

A user's write commits its own rows and hands its albums to the relation owner. It is never refused because
another transaction holds a library-wide marker or the baseline isn't ready, never waits for or runs a full
gallery preparation, and never drains a marker it doesn't own (6.5's four reds, a-d).
"""
from __future__ import annotations

import shutil
import time
from pathlib import Path

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import (  # noqa: F401 (live fixture)
    _finish_live_reconciliation, watcher_repair_inventory,
)

ALBUM = "Saved Album"


@pytest.fixture
def library(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    fixture.tracks = [fixture.entry(f"Owner/{ALBUM}/{number:02}.flac", album=ALBUM) for number in (1, 2, 3)]
    fixture.seed(*fixture.tracks)
    return fixture


def _rows(fixture, sql, params=()):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        cursor = connection.execute(sql, params)
        return cursor.fetchall() if cursor.description is not None else []


def _library_id(fixture):
    return _rows(fixture, "select id from library.libraries where library_kind = 'local' limit 1")[0]["id"]


def _hold_library_wide_marker(fixture):
    """Another transaction journals a library-wide change (album 0, as a detached-track write does) and
    commits it. Its owner hasn't drained it yet."""
    _rows(fixture, "select library.mark_relation_album_dirty(%s, 0)", (_library_id(fixture),))
    assert _markers(fixture) == 1


def _markers(fixture):
    return _rows(fixture, "select count(*) as n from library.local_relation_dirty_albums where album_id <= 0")[0]["n"]


def _rename(fixture, title, *, adapter=None):
    """A structural Edit Tags save as the route runs it: validation, then persistence."""
    adapter = adapter or fixture.adapter
    previous = {entry["path"]: dict(entry) for entry in fixture.tracks}
    updated = {path: {**entry, "album": title} for path, entry in previous.items()}
    options = dict(changed_paths=set(previous), previous_file_entries=previous, updated_file_entries=updated,
                   changed_field_names={"album"})
    adapter.validate_structural_tag_edit(**options)
    result = adapter.persist_structural_tag_edit(**options)
    fixture.tracks = list(updated.values())
    return result


def _album_titles(fixture):
    return {row["title"] for row in _rows(fixture, """
        select distinct albums.title from library.local_albums albums
        join library.local_tracks tracks on tracks.album_id = albums.id
        join library.local_track_files files on files.track_id = tracks.id
        where files.scan_cache_stale is false""")}


# (a) A structural tag save while another transaction holds the library-wide marker.

def test_live_a_structural_save_commits_while_another_transaction_holds_a_library_wide_marker(library):
    _hold_library_wide_marker(library)

    result = _rename(library, "Renamed Album")

    assert result["track_rows_updated"] == 3
    assert _album_titles(library) == {"Renamed Album"}, "The save's rows did not commit."
    assert _markers(library) == 1, "A user's save drained a marker it doesn't own."


# (b) The same for move-album, confirm-removal and keep-missing.

def test_live_a_move_commits_while_another_transaction_holds_a_library_wide_marker(library):
    fixture = library
    main = Path(fixture.roots[0]["path"])
    source, destination = main / "Owner" / ALBUM, main / "Owner" / f"{ALBUM} (Moved)"
    shutil.move(str(source), str(destination))
    moved = {}
    for entry in fixture.tracks:
        path = str(destination / Path(entry["path"]).name)
        moved[path] = {**entry, "path": path}
    _hold_library_wide_marker(fixture)

    persisted = fixture.adapter.persist_moved_album_inventory(
        root_id=fixture.roots[0]["id"], active_file_entries=moved,
        moves=({"source_path": str(source), "destination_path": str(destination),
                "source_root_id": fixture.roots[0]["id"], "destination_root_id": fixture.roots[0]["id"],
                "is_directory": True},),
    )

    assert persisted["inventory_mutation_revision"] > 0
    paths = {row["private_path"] for row in _rows(
        fixture, "select private_path from library.local_track_files where scan_cache_stale is false")}
    assert set(moved) <= paths, "The move's rows did not commit."
    assert _markers(fixture) == 1


def _missing_album(fixture):
    """The album's files gone from disk and marked stale, as a scan leaves a missing album."""
    for entry in fixture.tracks:
        Path(entry["path"]).unlink()
    _rows(fixture, """update library.local_track_files
                      set metadata = jsonb_set(metadata, '{scan_cache,stale}', 'true'::jsonb)""")
    return _rows(fixture, "select album_key from library.local_albums where title = %s", (ALBUM,))[0]["album_key"]


def test_live_confirming_a_removal_commits_while_another_transaction_holds_a_library_wide_marker(library):
    from music_app.services.missing_album_removal_postgres import PostgresMissingAlbumRemovalService

    album_key = _missing_album(library)
    _hold_library_wide_marker(library)

    result = PostgresMissingAlbumRemovalService(
        library.config, connect=isolatedPostgres._connect, root_health_check=lambda _root: True,
    ).confirm_removal(album_key)

    assert int(result.get("removed_album_count") or 0) == 1
    assert not _rows(library, "select 1 from library.local_albums where album_key = %s", (album_key,))
    assert _markers(library) == 1


def test_live_keeping_a_missing_album_commits_while_another_transaction_holds_a_library_wide_marker(library):
    from music_app.services.missing_album_removal_postgres import PostgresMissingAlbumRemovalService

    album_key = _missing_album(library)
    _hold_library_wide_marker(library)

    PostgresMissingAlbumRemovalService(library.config, connect=isolatedPostgres._connect).keep_missing(album_key)

    assert _markers(library) == 1


# (c) The baseline isn't ready: no full preparation, no wait, and the save commits.

def test_live_a_save_with_the_baseline_not_ready_commits_with_no_full_prepare_and_no_wait(library, monkeypatch):
    from music_app.services import gallery_projection_postgres, scoped_relation_projection

    calls = []
    monkeypatch.setattr(scoped_relation_projection, "tag_edit_baseline_ready", lambda *_a, **_k: False)
    monkeypatch.setattr(gallery_projection_postgres, "ensure_gallery_projection_ready",
                        lambda *_a, **_k: calls.append("full gallery preparation"))
    monkeypatch.setattr(scoped_relation_projection, "ensure_pending_relation_projection_ready",
                        lambda *_a, **_k: calls.append("inline publication"))

    began = time.perf_counter()
    _rename(library, "Saved Anyway")
    elapsed = time.perf_counter() - began

    assert calls == [], f"A user's save ran library-wide preparation: {calls}."
    assert elapsed < 1.0, f"The save waited {elapsed:.2f} s for indexing."
    assert _album_titles(library) == {"Saved Anyway"}


# (d) The save's statements are the same at two library sizes.

def test_live_a_structural_save_runs_the_same_statements_at_two_library_sizes(library):
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    fixture = library
    counted = []

    class Counting:
        def __init__(self, connection):
            self._connection = connection

        def __getattr__(self, name):
            return getattr(self._connection, name)

        def __enter__(self):
            self._connection.__enter__()
            return self

        def __exit__(self, *exc):
            return self._connection.__exit__(*exc)

        def execute(self, sql, *args, **kwargs):
            counted.append(" ".join(str(sql).split())[:80])
            return self._connection.execute(sql, *args, **kwargs)

    adapter = PostgresScanCacheAdapter(fixture.config, connect=lambda url: Counting(isolatedPostgres._connect(url)))

    def statements(title):
        counted.clear()
        _rename(fixture, title, adapter=adapter)
        return len(counted)

    small = statements("First Size")
    fixture.seed(*fixture.tracks, *(fixture.entry(f"Other/Album {number:03}/01.flac", artist="Other",
                                                   album=f"Album {number:03}") for number in range(200)))
    _finish_live_reconciliation(fixture.config)
    large = statements("Second Size")

    assert small == large, f"The save's statements grew with the library: {small} vs {large}."
