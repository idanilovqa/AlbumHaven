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


def _hold_background_owners(monkeypatch):
    """Record, instead of run, the background owners a write queues (the journal owner's drain and the
    gallery refresh), so a check observes the user's write alone and never races its owner. ``run_owners``
    then runs what was recorded, as the owners would have, after the write committed."""
    from music_app.services import gallery_projection_postgres
    from music_app.services.cache import _CACHE_WRITE_EXECUTOR

    class Queued(list):
        pass

    schedule_refresh = gallery_projection_postgres.schedule_gallery_projection_refresh
    queued = Queued()

    def run_owners():
        for kwargs in queued:
            schedule_refresh(kwargs.pop("config"), **kwargs)
        queued.clear()
        for _ in range(3):
            _CACHE_WRITE_EXECUTOR.submit(lambda: None).result(timeout=60)

    monkeypatch.setattr(gallery_projection_postgres, "queue_journaled_relation_drain",
                        lambda config: queued.append({"config": config, "incremental_membership": True}))
    monkeypatch.setattr(gallery_projection_postgres, "schedule_gallery_projection_refresh",
                        lambda config, **kwargs: queued.append({"config": config, **kwargs}))
    queued.run_owners = run_owners
    return queued


def _hold_library_wide_marker(fixture, monkeypatch):
    """Another transaction journals a library-wide change (album 0, as a detached-track write does) and
    commits it. Its owner hasn't drained it yet; the user's write alone is observed."""
    queued = _hold_background_owners(monkeypatch)
    _rows(fixture, "select library.mark_relation_album_dirty(%s, 0)", (_library_id(fixture),))
    assert _markers(fixture) == 1
    return queued


def _owner_drain_clears_marker(fixture, queued):
    """6.5's ruling (A): the journaled drain owns marker 0. The save's transaction left it (asserted before
    this); the drain the save queued runs after commit, off the save's path, and clears it."""
    assert queued, "The write queued no drain for marker 0's owner."
    queued.run_owners()
    assert _markers(fixture) == 0, "The drain the write queued left marker 0."


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

def test_live_a_structural_save_commits_while_another_transaction_holds_a_library_wide_marker(library, monkeypatch):
    queued = _hold_library_wide_marker(library, monkeypatch)

    result = _rename(library, "Renamed Album")

    assert result["track_rows_updated"] == 3
    assert _album_titles(library) == {"Renamed Album"}, "The save's rows did not commit."
    assert _markers(library) == 1, "The save's own transaction drained marker 0."
    _owner_drain_clears_marker(library, queued)


# (b) The same for move-album, confirm-removal and keep-missing.

def test_live_a_move_commits_while_another_transaction_holds_a_library_wide_marker(library, monkeypatch):
    fixture = library
    main = Path(fixture.roots[0]["path"])
    source, destination = main / "Owner" / ALBUM, main / "Owner" / f"{ALBUM} (Moved)"
    shutil.move(str(source), str(destination))
    moved = {}
    for entry in fixture.tracks:
        path = str(destination / Path(entry["path"]).name)
        moved[path] = {**entry, "path": path}
    queued = _hold_library_wide_marker(fixture, monkeypatch)

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
    assert _markers(fixture) == 1, "The move's own transaction drained marker 0."
    _owner_drain_clears_marker(fixture, queued)


def _missing_album(fixture):
    """The album's files gone from disk and marked stale, as a scan leaves a missing album."""
    for entry in fixture.tracks:
        Path(entry["path"]).unlink()
    _rows(fixture, """update library.local_track_files
                      set metadata = jsonb_set(metadata, '{scan_cache,stale}', 'true'::jsonb)""")
    return _rows(fixture, "select album_key from library.local_albums where title = %s", (ALBUM,))[0]["album_key"]


def test_live_confirming_a_removal_commits_while_another_transaction_holds_a_library_wide_marker(library, monkeypatch):
    from music_app.services.missing_album_removal_postgres import PostgresMissingAlbumRemovalService

    album_key = _missing_album(library)
    queued = _hold_library_wide_marker(library, monkeypatch)

    result = PostgresMissingAlbumRemovalService(
        library.config, connect=isolatedPostgres._connect, root_health_check=lambda _root: True,
    ).confirm_removal(album_key)

    assert result["removed_album_key"] == album_key
    assert not _rows(library, "select 1 from library.local_albums where album_key = %s", (album_key,))
    assert _markers(library) == 1, "The removal's own transaction drained marker 0."
    _owner_drain_clears_marker(library, queued)


# A guard, not a red: keeping a missing album never reached the publication gate, so it already
# commits at 5ffbaba62. (b)'s reds are the move and the confirmed removal above.
def test_live_keeping_a_missing_album_commits_while_another_transaction_holds_a_library_wide_marker(library, monkeypatch):
    from music_app.services.missing_album_removal_postgres import PostgresMissingAlbumRemovalService

    album_key = _missing_album(library)
    queued = _hold_library_wide_marker(library, monkeypatch)

    PostgresMissingAlbumRemovalService(library.config, connect=isolatedPostgres._connect).keep_missing(album_key)

    assert _markers(library) == 1, "Keeping the album drained marker 0 in its own transaction."
    _owner_drain_clears_marker(library, queued)


# (c) The baseline isn't ready: no full preparation, no wait, and the save commits.

def test_live_a_save_with_the_baseline_not_ready_commits_with_no_full_prepare_and_no_wait(library, monkeypatch):
    from music_app.services import gallery_projection_postgres, scoped_relation_projection

    _hold_background_owners(monkeypatch)
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


# (d) The save's statements and rows read stay flat at 1, 2,001 and 6,001 albums, with several custom gallery
# scopes published, so the per-header membership patch is counted too (6.5's R4 condition).

def _set_statistics(fixture, analysed):
    """6.5: both statistics states. ``analysed`` gives the inventory tables statistics, as production's have
    after autovacuum. Otherwise autovacuum is off on them (the throwaway test database only) and they must
    have never been analysed, as after a bulk change (case 55)."""
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        if analysed:
            connection.execute("analyze " + ", ".join(INVENTORY_TABLES))
            return
        for table in INVENTORY_TABLES:
            connection.execute(f"alter table {table} set (autovacuum_enabled = false)")
    _assert_never_analysed(fixture)


def _assert_never_analysed(fixture):
    never = _rows(fixture, """select relname, reltuples from pg_class
        where oid = any(array[%s, %s, %s, %s]::regclass[])""", INVENTORY_TABLES)
    assert all(row["reltuples"] == -1 for row in never), f"The tables were analysed: {never}."


SIZE_GROWTH_ROWS = 25


@pytest.mark.parametrize("analysed", [False, True], ids=["never-analysed", "analysed"])
def test_live_a_structural_save_reads_and_runs_the_same_at_three_library_sizes_with_custom_scopes(
        library, analysed, monkeypatch):
    """Both statistics states: a save right after a bulk change runs on missing statistics in production
    (case 55), so the save's reads must stay flat without ANALYZE too, by keyed lookups, not by statistics.

    6.5 (11-23): with statistics, 1 -> 2,001 albums may take a one-time planner step; 2,001 -> 6,001 must
    add 25 rows or fewer, which shows that step is not growth."""
    fixture = library
    # The save and then the journal owner's drain it queues are both counted, in that order on this thread.
    _hold_background_owners(monkeypatch)
    adapter, counted = _counting_adapter(fixture)
    # Several custom gallery scopes published, so the per-header membership patch is counted too (R4).
    _publish_custom_scopes(fixture)
    if not analysed:
        _set_statistics(fixture, analysed=False)

    small = _measure_save(fixture, "First Size", adapter, counted)
    _seed_albums(fixture, 2000, analyse=analysed)
    if not analysed:
        _assert_never_analysed(fixture)
    _gallery_state(fixture, "before the 2,001-album save")
    large = _measure_save(fixture, "Second Size", adapter, counted)
    _gallery_state(fixture, "after the 2,001-album save")
    _seed_albums(fixture, 4000, tag="more", analyse=analysed)
    if not analysed:
        _assert_never_analysed(fixture)
    largest = _measure_save(fixture, "Third Size", adapter, counted)

    print("edits always save, (statements, rows read, seconds, per table) at 1, 2,001 and 6,001 albums:",
          small, large, largest)
    assert small[0] == large[0] == largest[0], (
        f"The save's statements grew with the library: {small[0]}, {large[0]}, {largest[0]}.")
    assert largest[1] - large[1] <= SIZE_GROWTH_ROWS, (
        f"The save's rows read grew from 2,001 to 6,001 albums: {large} vs {largest}.")
    if not analysed:
        assert abs(large[1] - small[1]) <= SIZE_GROWTH_ROWS, (
            f"The save's rows read grew with the library: {small} vs {large}.")


# (e) 6.5: a save reads its album's relation component (every album of the same artist). That is affected-set
# work: it grows with that artist's albums at a small constant per album, never with the library. The
# unrelated library is the same 500 one-artist albums in both measurements.

COMPONENT_ROWS_PER_ALBUM = 25


def test_live_a_save_reads_its_artist_component_at_a_small_constant_per_album(library, monkeypatch):
    fixture = library
    # The save and then the journal owner's drain it queues are both counted, in that order on this thread.
    _hold_background_owners(monkeypatch)
    adapter, counted = _counting_adapter(fixture)
    _seed_albums(fixture, 500, tag="unrelated")
    _seed_albums(fixture, 10, tag="family", own_artist=False)
    small = _measure_save(fixture, "Ten Siblings", adapter, counted)
    _seed_albums(fixture, 490, tag="relatives", own_artist=False)
    large = _measure_save(fixture, "Five Hundred Siblings", adapter, counted)

    per_album = (large[1] - small[1]) / 490
    print("edits always save, component class (statements, rows read, seconds, per table) at N=10 and N=500:",
          small, large, f"rows per added album={per_album:.1f}")
    if large[2] > 1.0:
        print(f"FINDING (not this fix's blocker): a save on an artist with 500 albums took {large[2]:.2f} s.")
    assert small[0] == large[0], f"The save's statements grew with the artist's albums: {small[:2]} vs {large[:2]}."
    assert per_album <= COMPONENT_ROWS_PER_ALBUM, (
        f"The component read costs {per_album:.1f} rows per album: {small} vs {large}.")


def _app_caller():
    """The innermost application frame that issued a statement, as file:line function."""
    import traceback

    for frame in reversed(traceback.extract_stack()[:-2]):
        if "music_app" in frame.filename.replace("\\", "/"):
            return f"{Path(frame.filename).name}:{frame.lineno} {frame.name}"
    return "?"


def _counting_adapter(fixture):
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

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

        def _inventory_rows_read(self):
            # This transaction's own reads of the inventory tables, visible at once in the same session.
            return self._connection.execute(
                """select coalesce(sum(coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0)), 0)::bigint as n
                   from pg_stat_xact_user_tables
                   where schemaname = 'library' and relname in ('local_albums', 'local_tracks', 'local_track_files', 'local_artists',
                                       'local_album_featured_artists')"""
            ).fetchone()["n"]

        def execute(self, sql, *args, **kwargs):
            statement = " ".join(str(sql).split())
            counted.append(statement[:80])
            try:
                before = self._inventory_rows_read()
            except Exception:
                before = None
            cursor = self._connection.execute(sql, *args, **kwargs)
            if before is not None:
                try:
                    read = self._inventory_rows_read() - before
                except Exception:
                    read = 0
                if read >= 20:
                    counted.heavy.append((read, f"{_app_caller()} | {statement[:200]}"))
            return cursor

    class Counted(list):
        def clear(self):
            super().clear()
            self.heavy = []

    counted = Counted()
    counted.clear()
    adapter = PostgresScanCacheAdapter(fixture.config, connect=lambda url: Counting(isolatedPostgres._connect(url)))
    return adapter, counted


def _measure_save(fixture, title, adapter, counted):
    """(statements, rows read, seconds, rows read per table) for one album rename and the journal owner's
    drain it queues (the gallery shows a non-artist edit when that drain runs), both on counted connections."""
    counted.clear()
    before = _rows_read(fixture)
    began = time.perf_counter()
    _rename(fixture, title, adapter=adapter)
    from music_app.services.scoped_relation_projection import ensure_pending_relation_projection_ready
    ensure_pending_relation_projection_ready(fixture.config, connect=adapter._connect)
    seconds = round(time.perf_counter() - began, 3)
    after = _rows_read(fixture)
    tables = {table: after.get(table, 0) - before.get(table, 0) for table in after}
    for read, statement in sorted(counted.heavy, reverse=True):
        print(f"edits always save, {title!r}: {read} inventory rows read by: {statement}")
    statements = list(counted)
    return len(statements), sum(tables.values()), seconds, {table: rows for table, rows in tables.items() if rows}


INVENTORY_TABLES = ("library.local_artists", "library.local_albums", "library.local_tracks",
                    "library.local_track_files")


CUSTOM_SCOPES = (
    {"gallery_scope": "all", "visible_library_categories": ["main_library"]},
    {"gallery_scope": "all", "visible_library_categories": ["hoard"]},
    {"gallery_scope": "all", "visible_library_categories": ["main_library", "hoard"]},
)


def _publish_custom_scopes(fixture):
    from music_app.services.gallery_projection_postgres import ensure_gallery_projection_ready

    for view_state in CUSTOM_SCOPES:
        ensure_gallery_projection_ready(fixture.config, connect=isolatedPostgres._connect, view_state=view_state)
    headers = _rows(fixture, "select count(distinct scope_key) as n from library.gallery_membership_headers")[0]["n"]
    assert headers >= len(CUSTOM_SCOPES) + 1, "The custom scopes were not published."


def _catalog_columns(connection, table):
    return [row["column_name"] for row in connection.execute(
        """select column_name from information_schema.columns
           where table_schema = 'library' and table_name = %s
             and is_generated = 'NEVER' and is_identity = 'NO' order by ordinal_position""", (table,)).fetchall()]


def _seed_albums(fixture, count, *, tag="bulk", own_artist=True, analyse=True):
    """``count`` one-track albums in one INSERT per table (generate_series): clones of the saved album's
    rows, every column but the identity and generated ones read from the catalog. Each clone has its own
    key, title and folder that share no prefix with the saved album's, so (d) measures the save and not a
    lookup that matches clones by prefix. ``tag`` keeps each batch apart; ``own_artist=False`` keeps the
    saved album's artist (its relation component, which (e) measures) but still its own folder."""
    artist_name = f"'{tag} artist ' || n"
    album_title = f"'{tag} album ' || n"
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        source = connection.execute(
            """select files.id as file_id, tracks.id as track_id, tracks.album_id from library.local_track_files files
               join library.local_tracks tracks on tracks.id = files.track_id where files.private_path = %s""",
            (fixture.tracks[0]["path"],)).fetchone()
        if own_artist:
            clone = {"artist_key": artist_name, "name": artist_name}
            artists = _catalog_columns(connection, "local_artists")
            connection.execute(
                f"""insert into library.local_artists ({", ".join(artists)})
                    select {", ".join(clone.get(column, f"source.{column}") for column in artists)}
                    from library.local_artists source, generate_series(1, %(count)s) n
                    where source.id = (select artist_id from library.local_albums where id = %(album)s)""",
                {"count": count, "album": source["album_id"]})
            album_key = f"{artist_name} || '::' || {album_title}"
        else:
            album_key = f"split_part(source.album_key, '::', 1) || '::' || {album_title}"
        clone = {"album_key": album_key, "title": album_title}
        if own_artist:
            clone["artist_id"] = f"""(select bulk.id from library.local_artists bulk
                where bulk.library_id = source.library_id and bulk.artist_key = {artist_name})"""
            clone["metadata"] = f"""case when source.metadata ? 'album_artist'
                then jsonb_set(source.metadata, '{{album_artist}}', to_jsonb({artist_name}))
                else source.metadata end"""
        albums = _catalog_columns(connection, "local_albums")
        connection.execute(
            f"""insert into library.local_albums ({", ".join(albums)})
                select {", ".join(clone.get(column, f"source.{column}") for column in albums)}
                from library.local_albums source, generate_series(1, %(count)s) n where source.id = %(album)s""",
            {"count": count, "album": source["album_id"]})
        track_key = f"'{tag} track ' || n"
        clone = {"track_key": track_key, "album_id": "albums.id",
                 "artist_id": "coalesce(albums.artist_id, source.artist_id)"}
        tracks = _catalog_columns(connection, "local_tracks")
        connection.execute(
            f"""insert into library.local_tracks ({", ".join(tracks)})
                select {", ".join(clone.get(column, f"source.{column}") for column in tracks)}
                from library.local_tracks source cross join generate_series(1, %(count)s) n
                join library.local_albums albums on albums.library_id = source.library_id
                 and albums.title = {album_title}
                where source.id = %(track)s""", {"count": count, "track": source["track_id"]})
        # Its own artist folder and album folder: no folder prefix shared with the saved album.
        folder = f"'{ALBUM}', '{tag} album ' || n"
        if own_artist:
            moved = f"replace(replace({{path}}, {folder}), 'Owner', '{tag} artist ' || n)"
        else:
            moved = f"replace({{path}}, {folder})"
        clone = {"track_id": "tracks.id", "private_path": moved.format(path="source.private_path"),
                 "relative_path": moved.format(path="source.relative_path")}
        files = _catalog_columns(connection, "local_track_files")
        connection.execute(
            f"""insert into library.local_track_files ({", ".join(files)})
                select {", ".join(clone.get(column, f"source.{column}") for column in files)}
                from library.local_track_files source cross join generate_series(1, %(count)s) n
                join library.local_tracks tracks on tracks.library_id = (
                  select library_id from library.local_tracks where id = source.track_id)
                 and tracks.track_key = {track_key}
                where source.id = %(file)s""", {"count": count, "file": source["file_id"]})
        if analyse:
            # Statistics, as production's tables have after autovacuum; (d) also runs without them.
            connection.execute("analyze " + ", ".join(INVENTORY_TABLES))
    _finish_live_reconciliation(fixture.config)


def _rows_read(fixture):
    """Rows read per table so far, once every backend's pending statistics have flushed."""
    previous = None
    for _ in range(60):
        with isolatedPostgres._connect(fixture.setup_url) as reader:
            reader.execute("select pg_stat_clear_snapshot()")
            current = {row["relname"]: int(row["read"]) for row in reader.execute(
                """select relname, coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0) as read
                   from pg_stat_user_tables where schemaname in ('library', 'app', 'ops')""").fetchall()}
        if current == previous:
            return current
        previous = current
        time.sleep(0.25)
    return previous


# R3/R4 (6.5's ruling): headers at different generations. A save shows the edit in every header. A header the
# journal covers (at or after its earliest generation) is patched to the current generation. A header behind
# that floor keeps its generation and the journal stays for its owner. The owner's drain then realigns every
# header and empties the journal.

def _headers(fixture):
    return {row["scope_key"]: row["source_generation"] for row in _rows(
        fixture, "select scope_key, source_generation from library.gallery_membership_headers")}


def _generation(fixture):
    return _rows(fixture, "select generation from library.gallery_projection_state")[0]["generation"]


def _gallery_state(fixture, label):
    """Printed when a header test fails: header generations, the current generation, the journal and each
    scope's albums, so a skipped patch is located from one run."""
    print(f"edits always save, gallery state {label}:",
          "current", _generation(fixture), "headers", _headers(fixture),
          "journal", [(row["album_id"], row["first_gallery_generation"]) for row in _rows(fixture,
              "select album_id, first_gallery_generation from library.local_relation_dirty_albums order by 1")],
          "albums", [(row["id"], row["album_key"], row["title"]) for row in _rows(fixture,
              "select id, album_key, title from library.local_albums order by id limit 5")],
          "entries", sorted((row["scope_key"][:8], row["album_key"]) for row in _rows(fixture,
              "select scope_key, album_key from library.gallery_membership_entries order by 1, 2 limit 20")))


def _scopes_showing(fixture, title):
    return {row["scope_key"] for row in _rows(fixture, """
        select distinct entries.scope_key from library.gallery_membership_entries entries
        join library.local_albums albums on albums.album_key = entries.album_key
        where albums.title = %s""", (title,))}


@pytest.mark.parametrize("analysed", [False, True], ids=["never-analysed", "analysed"])
def test_live_a_saved_edit_reaches_every_scope_through_its_queued_drain(library, analysed):
    """R4 (orchestrator, 11-23): the client shows the edit at the Save click; the server's gallery follows
    when the drain the save queues runs. A reload or another tab sees the old value until then, so the gap
    from the save's commit to the edit in every scope holding the album, with the journal empty, is
    measured and reported, in both statistics states (6.5)."""
    _set_statistics(library, analysed)
    _publish_custom_scopes(library)
    holding = _scopes_showing(library, ALBUM)
    assert holding, "The album is in no gallery scope before the save."

    _rename(library, "Reached By The Drain")
    gap = _seconds_until_shown(library, holding, "Reached By The Drain")
    print(f"edits always save, R4 gap from the save's commit to the edit in every scope: {gap * 1000:.0f} ms")

    assert holding <= _scopes_showing(library, "Reached By The Drain"), (
        f"The drain the save queued did not publish the edit within {gap:.1f} s.")
    assert _journal_rows(library) == 0, "The drain the save queued left the journal."
    # A reload or another tab sees the old value for this long (the saving screen updates at the click).
    assert gap < R4_GAP_BOUND, f"The save-to-gallery gap regressed: {gap * 1000:.0f} ms."


R4_GAP_BOUND = 1.0


def _seconds_until_shown(fixture, scopes, title, *, timeout=10):
    """Seconds from now until every one of ``scopes`` shows the album titled ``title`` and the journal is
    empty (or the timeout)."""
    began = time.perf_counter()
    while not (scopes <= _scopes_showing(fixture, title) and _journal_rows(fixture) == 0) and (
            time.perf_counter() - began < timeout):
        time.sleep(0.005)
    return time.perf_counter() - began


def _journal_rows(fixture):
    return _rows(fixture, "select count(*) as n from library.local_relation_dirty_albums")[0]["n"]


def _lower_one_header(fixture):
    _publish_custom_scopes(fixture)
    headers = _headers(fixture)
    behind = sorted(headers)[0]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""update library.gallery_membership_headers set source_generation = source_generation - 1
            where scope_key = %s""", (behind,))
    return behind


@pytest.mark.parametrize("analysed", [False, True], ids=["never-analysed", "analysed"])
def test_live_a_save_shows_in_every_header_the_journal_covers(library, analysed):
    """Rewritten for R4 (orchestrator, 11-23): the save, then the drain it queues. With one header behind the
    journal, the edit still reaches every scope that held the album, within the R4 bound."""
    _set_statistics(library, analysed)
    behind = _lower_one_header(library)
    holding = _scopes_showing(library, ALBUM) - {behind}
    assert holding, "No header the journal covers holds the album."

    _rename(library, "Shown Everywhere")
    gap = _seconds_until_shown(library, holding, "Shown Everywhere")

    assert holding <= _scopes_showing(library, "Shown Everywhere"), (
        "The edit is missing from a header the journal covers after the save's drain.")
    assert _journal_rows(library) == 0, "The drain the save queued left the journal."
    assert gap < R4_GAP_BOUND, f"The covered headers showed the edit after {gap * 1000:.0f} ms."


@pytest.mark.parametrize("analysed", [False, True], ids=["never-analysed", "analysed"])
def test_live_a_save_shows_in_a_header_behind_the_journal_after_its_drain(library, analysed):
    """Rewritten for R4: a header behind the journal (a restored database) is realigned by the drain the save
    queues, and then shows the edit at the current generation, within the R4 bound."""
    _set_statistics(library, analysed)
    behind = _lower_one_header(library)
    assert behind in _scopes_showing(library, ALBUM), "The lowered header does not hold the album."

    _rename(library, "Shown Behind Too")
    gap = _seconds_until_shown(library, {behind}, "Shown Behind Too")

    assert behind in _scopes_showing(library, "Shown Behind Too"), (
        "The edit never reached the header behind the journal.")
    assert _headers(library)[behind] == _generation(library), "The drain left the header behind."
    assert _journal_rows(library) == 0, "The drain the save queued left the journal."
    assert gap < R4_GAP_BOUND, f"The header behind the journal showed the edit after {gap * 1000:.0f} ms."


def test_live_the_owners_drain_realigns_every_header_and_empties_the_journal(library, monkeypatch):
    queued = _hold_background_owners(monkeypatch)
    _publish_custom_scopes(library)
    with isolatedPostgres._connect(library.setup_url) as connection:
        connection.execute("update library.gallery_membership_headers set source_generation = source_generation - 1")
    _rename(library, "Realigned By The Owner")
    assert _rows(library, "select count(*) as n from library.local_relation_dirty_albums where album_id > 0")[0]["n"] >= 1, (
        "The save emptied the journal ahead of the headers (R3).")

    showing_before = _scopes_showing(library, "Realigned By The Owner")
    # The journal owner's drain the save queued, as queue_journaled_relation_drain schedules it.
    assert any(kwargs.get("incremental_membership") for kwargs in queued), "The save queued no journaled drain."
    queued.run_owners()

    current = _generation(library)
    assert set(_headers(library).values()) == {current}, f"A header stayed behind after the owner's drain: {_headers(library)}."
    assert _rows(library, "select count(*) as n from library.local_relation_dirty_albums")[0]["n"] == 0
    assert showing_before <= _scopes_showing(library, "Realigned By The Owner")
    assert _scopes_showing(library, "Realigned By The Owner"), "The owner's drain did not publish the edit."


# 6.5's conditions on R1 and R5.

# A guard, not a red: the journaled drain was already single-flight at 5ffbaba62. It holds R1's
# deferral to that one owner.
def test_repeated_publication_failures_make_no_back_to_back_drains(library, monkeypatch):
    import threading

    from music_app.services import gallery_projection_postgres, scoped_relation_projection
    from music_app.services.cache import _CACHE_WRITE_EXECUTOR

    drains, release = [], threading.Event()

    def failing(*_args, **_kwargs):
        drains.append(time.monotonic())
        release.wait(2)
        raise RuntimeError("publication failed")

    monkeypatch.setattr(scoped_relation_projection, "ensure_pending_relation_projection_ready", failing)
    for _ in range(5):
        gallery_projection_postgres.queue_journaled_relation_drain(library.config)
    release.set()
    for _ in range(3):
        _CACHE_WRITE_EXECUTOR.submit(lambda: None).result(timeout=30)
    time.sleep(0.5)

    assert len(drains) == 1, f"Failures were retried back to back: {len(drains)} drains."


# A guard, not a red: no ordinary event started the one-time build at 5ffbaba62 (R5).
def test_live_no_save_request_or_watcher_event_starts_the_one_time_build(library, monkeypatch):
    from music_app.services import gallery_projection_postgres, relation_projection_postgres
    from music_app.services.cache import _CACHE_WRITE_EXECUTOR
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
    from tests.py.test_problematic_albums import _watcher_pass

    started = []
    monkeypatch.setattr(relation_projection_postgres, "ensure_relation_projection_ready",
                        lambda *_a, **_k: started.append("relation build") or {"ready": True})
    monkeypatch.setattr(gallery_projection_postgres, "initialize_gallery_membership",
                        lambda *_a, **_k: started.append("gallery build"))

    _rename(library, "Saved Once")
    PostgresLibraryBrowseRepository(library.config).build_root_startup_preview_payload(
        query_params={}, sidebar_only=True, queue_projection_refresh=True)
    _watcher_pass(library, active=[{**library.tracks[0], "title": "Watcher Title"}])
    for _ in range(3):
        _CACHE_WRITE_EXECUTOR.submit(lambda: None).result(timeout=60)

    assert started == [], f"An ordinary event started the one-time build: {started}."


# A guard, not a red: a structural save already committed when its publication raised at
# 5ffbaba62. It holds R1's savepoint to the same outcome.
# Paired with the owner's next drain publishing the deferred edit (6.5).
def test_live_a_rolled_back_publication_leaves_the_edit_committed(library, monkeypatch):
    from music_app.services import scoped_relation_projection

    def failing(*_args, **_kwargs):
        raise RuntimeError("Library changes are still being reconciled.")

    publish = scoped_relation_projection.publish_affected_relation_projection
    monkeypatch.setattr(scoped_relation_projection, "publish_affected_relation_projection", failing)

    _rename(library, "Committed Despite Publication")

    assert _album_titles(library) == {"Committed Despite Publication"}, "The publication's failure lost the edit."
    journaled = _rows(library, "select count(*) as n from library.local_relation_dirty_albums where album_id > 0")[0]["n"]
    assert journaled >= 1, "The edit's albums were not left in the journal for their owner."

    # Deferred never means never: the journal owner's next drain publishes the edit with no other action.
    from music_app.services.cache import _CACHE_WRITE_EXECUTOR
    from music_app.services.gallery_projection_postgres import queue_journaled_relation_drain

    monkeypatch.setattr(scoped_relation_projection, "publish_affected_relation_projection", publish)
    queue_journaled_relation_drain(library.config)
    for _ in range(3):
        _CACHE_WRITE_EXECUTOR.submit(lambda: None).result(timeout=60)
    left = _rows(library, "select count(*) as n from library.local_relation_dirty_albums where album_id > 0")[0]["n"]
    assert left == 0, f"The owner's drain left {left} journaled album(s) unpublished."
    shown = _rows(library, """select count(*) as n from library.gallery_membership_entries entries
        join library.local_albums albums on albums.album_key = entries.album_key
        where albums.title = 'Committed Despite Publication'""")[0]["n"]
    assert shown >= 1, "The owner's drain did not publish the saved album to the gallery."
