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

    assert result["removed_album_key"] == album_key
    assert not _rows(library, "select 1 from library.local_albums where album_key = %s", (album_key,))
    assert _markers(library) == 1


# A guard, not a red: keeping a missing album never reached the publication gate, so it already
# commits at 5ffbaba62. (b)'s reds are the move and the confirmed removal above.
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


# (d) The save's statements and rows read are the same at 1 and 2,001 albums, with several custom gallery
# scopes published, so the per-header membership patch is counted too (6.5's R4 condition).

def test_live_a_structural_save_reads_and_runs_the_same_at_two_library_sizes_with_custom_scopes(library):
    fixture = library
    adapter, counted = _counting_adapter(fixture)
    # Several custom gallery scopes published, so the per-header membership patch is counted too (R4).
    _publish_custom_scopes(fixture)

    small = _measure_save(fixture, "First Size", adapter, counted)
    _seed_albums(fixture, 2000)
    large = _measure_save(fixture, "Second Size", adapter, counted)

    print("edits always save, (statements, rows read, seconds, per table) at 1 and 2,001 albums:", small, large)
    assert small[0] == large[0], f"The save's statements grew with the library: {small[:2]} vs {large[:2]}."
    assert abs(large[1] - small[1]) <= 25, (
        f"The save's rows read grew with the library: {small} vs {large}.")


# (e) 6.5: a save reads its album's relation component (every album of the same artist). That is affected-set
# work: it grows with that artist's albums at a small constant per album, never with the library. The
# unrelated library is the same 500 one-artist albums in both measurements.

COMPONENT_ROWS_PER_ALBUM = 40


def test_live_a_save_reads_its_artist_component_at_a_small_constant_per_album(library):
    fixture = library
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
                   where schemaname = 'library' and relname in ('local_albums', 'local_tracks', 'local_track_files')"""
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
                if read >= 200:
                    counted.heavy.append((read, statement[:240]))
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
    """(statements, rows read, seconds, rows read per table) for one album rename."""
    counted.clear()
    before = _rows_read(fixture)
    began = time.perf_counter()
    _rename(fixture, title, adapter=adapter)
    seconds = round(time.perf_counter() - began, 3)
    after = _rows_read(fixture)
    tables = {table: after.get(table, 0) - before.get(table, 0) for table in after}
    for read, statement in sorted(counted.heavy, reverse=True):
        print(f"edits always save, {title!r}: {read} inventory rows read by: {statement}")
    statements = list(counted)
    return len(statements), sum(tables.values()), seconds, {table: rows for table, rows in tables.items() if rows}


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


def _seed_albums(fixture, count, *, tag="bulk", own_artist=True):
    """``count`` one-track albums in one INSERT per table (generate_series): clones of the saved album's
    rows, every column but the identity and generated ones read from the catalog. ``tag`` keeps each
    batch's keys and folders apart; ``own_artist=False`` keeps the saved album's artist (its component)."""
    suffix = f"'::{tag}::'"
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        source = connection.execute(
            """select files.id as file_id, tracks.id as track_id, tracks.album_id from library.local_track_files files
               join library.local_tracks tracks on tracks.id = files.track_id where files.private_path = %s""",
            (fixture.tracks[0]["path"],)).fetchone()
        # By default each clone has its own artist: a shared one puts every clone in the saved album's relation
        # component, which is per-artist work ((e) measures it), not the library-wide reading (d) is about.
        if own_artist:
            clone = {"artist_key": f"source.artist_key || {suffix} || n", "name": f"source.name || ' {tag} ' || n"}
            artists = _catalog_columns(connection, "local_artists")
            connection.execute(
                f"""insert into library.local_artists ({", ".join(artists)})
                    select {", ".join(clone.get(column, f"source.{column}") for column in artists)}
                    from library.local_artists source, generate_series(1, %(count)s) n
                    where source.id = (select artist_id from library.local_albums where id = %(album)s)""",
                {"count": count, "album": source["album_id"]})
        bulk_artist = f"""(select bulk.id from library.local_artists bulk where bulk.library_id = source.library_id
                and bulk.artist_key = (select artist_key from library.local_artists where id = source.artist_id)
                  || {suffix} || n)"""
        clone = {"album_key": f"source.album_key || {suffix} || n", "title": f"source.title || ' {tag} ' || n"}
        if own_artist:
            clone["artist_id"] = bulk_artist
            clone["metadata"] = f"""case when source.metadata ? 'album_artist' then jsonb_set(source.metadata,
                     '{{album_artist}}', to_jsonb((source.metadata ->> 'album_artist') || ' {tag} ' || n))
                     else source.metadata end"""
        albums = _catalog_columns(connection, "local_albums")
        connection.execute(
            f"""insert into library.local_albums ({", ".join(albums)})
                select {", ".join(clone.get(column, f"source.{column}") for column in albums)}
                from library.local_albums source, generate_series(1, %(count)s) n where source.id = %(album)s""",
            {"count": count, "album": source["album_id"]})
        clone = {"track_key": f"source.track_key || {suffix} || n", "album_id": "albums.id",
                 "artist_id": "coalesce(albums.artist_id, source.artist_id)"}
        tracks = _catalog_columns(connection, "local_tracks")
        connection.execute(
            f"""insert into library.local_tracks ({", ".join(tracks)})
                select {", ".join(clone.get(column, f"source.{column}") for column in tracks)}
                from library.local_tracks source cross join generate_series(1, %(count)s) n
                join library.local_albums albums on albums.album_key = (
                  select album_key from library.local_albums where id = source.album_id) || {suffix} || n
                where source.id = %(track)s""", {"count": count, "track": source["track_id"]})
        moved = f"'{ALBUM}', '{tag} ' || n"
        clone = {"track_id": "tracks.id", "private_path": f"replace(source.private_path, {moved})",
                 "relative_path": f"replace(source.relative_path, {moved})"}
        files = _catalog_columns(connection, "local_track_files")
        connection.execute(
            f"""insert into library.local_track_files ({", ".join(files)})
                select {", ".join(clone.get(column, f"source.{column}") for column in files)}
                from library.local_track_files source cross join generate_series(1, %(count)s) n
                join library.local_tracks tracks on tracks.track_key = (
                  select track_key from library.local_tracks where id = source.track_id) || {suffix} || n
                where source.id = %(file)s""", {"count": count, "file": source["file_id"]})
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
