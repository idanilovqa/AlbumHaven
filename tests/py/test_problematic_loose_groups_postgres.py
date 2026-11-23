"""Case 55 (0294): a loose change re-checks only its group, never every loose track.

A loose file has no artist tag ("Missing artist"); its group is (root, physical parent folder).
"""
from __future__ import annotations

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import (  # noqa: F401 (live fixture)
    _finish_live_reconciliation, watcher_repair_inventory,
)
from tests.py.test_problematic_albums import (
    _as_served, _evaluated_problematic_items, _indexed_problematic_items, _ready_problematic_index, _watcher_pass,
)


@pytest.fixture
def loose_library(watcher_repair_inventory, monkeypatch):
    from music_app.services import problematic_index

    fixture = watcher_repair_inventory

    def stray(folder, *, root=0, title="01"):
        entry = fixture.entry(f"Owner/{folder}/{title}.flac", root=root, artist="")
        entry["album_artist"] = ""
        return entry

    fixture.stray = stray
    fixture.strays = {"A": stray("Strays A"), "B": stray("Strays B"), "Hoard": stray("Strays H", root=1)}
    fixture.seed(*(fixture.entry(f"Owner/Album/{track}.flac") for track in ("01", "02", "03")),
                 *fixture.strays.values())
    fixture.database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    # The first backfill runs in the background, so it may run before this; afterwards marks stay where a test
    # can read them: nothing drains in the background.
    _ready_problematic_index(fixture.database_url)
    problematic_index.wait_for_background_work()
    monkeypatch.setattr(problematic_index, "queue_maintenance", lambda _repository: None)
    return fixture


def _rows(fixture, sql, params=()):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        cursor = connection.execute(sql, params)
        return cursor.fetchall() if cursor.description is not None else []


def _marked_groups(fixture):
    """Marked groups by folder name, casefolded: the stored folder is the path key's (lower case)."""
    return {row["folder"].rsplit("/", 1)[-1].casefold() for row in _rows(
        fixture, "select folder from library.problematic_loose_groups where marked_xid is not null")}


def _named(*names):
    return {name.casefold() for name in names}


def _loose_items(fixture):
    from music_app.services import library_browse_postgres as browse

    return {item["key"]: item for item in _indexed_problematic_items(fixture.database_url, limit=50)
            if browse._is_problematic_loose_tracks_key(item["key"])}


def test_live_a_loose_edit_marks_its_group_only_and_a_read_matches_a_full_rebuild(loose_library):
    fixture = loose_library
    assert len(_loose_items(fixture)) == 3
    assert _marked_groups(fixture) == set()

    edited = {**fixture.strays["A"], "title": "Renamed stray"}
    _watcher_pass(fixture, active=[edited])

    assert _marked_groups(fixture) == _named("Strays A"), "A loose edit marks exactly its own group."
    assert _rows(fixture, "select count(*) as n from library.problematic_index_dirty_albums where album_id <= 0")[0]["n"] == 0
    assert _as_served(_indexed_problematic_items(fixture.database_url, limit=50)) == _as_served(
        _evaluated_problematic_items(fixture.config))
    assert _marked_groups(fixture) == set(), "The read drained the group's mark."


def test_live_a_group_whose_last_loose_file_joins_an_album_loses_its_item_and_keeps_its_row(loose_library):
    fixture = loose_library
    before = _loose_items(fixture)
    rows_before = _rows(fixture, "select count(*) as n from library.problematic_loose_groups")[0]["n"]

    # An album of its own: tagged as the three-track album elsewhere, it would be a redundant subset copy,
    # which the scan keeps loose.
    tagged = {**fixture.strays["B"], "artist": "Owner", "album_artist": "Owner", "album": "Strays B Album"}
    _watcher_pass(fixture, active=[tagged])
    _finish_live_reconciliation(fixture.config)  # the new album's relations publish, as production queues them

    after = _loose_items(fixture)
    assert len(after) == len(before) - 1, "The group with no loose file left keeps no item."
    assert _rows(fixture, "select count(*) as n from library.problematic_loose_groups")[0]["n"] == rows_before
    assert _marked_groups(fixture) == set()
    assert _as_served(_indexed_problematic_items(fixture.database_url, limit=50)) == _as_served(
        _evaluated_problematic_items(fixture.config))


def test_live_deactivating_a_root_hides_its_groups_and_writes_nothing(loose_library):
    fixture = loose_library
    visible = _loose_items(fixture)
    stored = _rows(fixture, "select item_key, root_id, item from library.problematic_index_items order by item_key")

    _rows(fixture, "update library.library_roots set is_active = false where root_path = %s",
          (fixture.roots[1]["path"],))

    hidden = _loose_items(fixture)
    assert len(hidden) == len(visible) - 1, "The inactive root's group is not served."
    assert _rows(fixture, "select item_key, root_id, item from library.problematic_index_items order by item_key") == stored
    assert _marked_groups(fixture) == set(), "A root change marks no group."

    _rows(fixture, "update library.library_roots set is_active = true where root_path = %s",
          (fixture.roots[1]["path"],))
    assert _loose_items(fixture) == visible


def test_live_readiness_counts_waiting_loose_groups(loose_library):
    from music_app.services import library_browse_postgres as browse, problematic_index

    fixture = loose_library
    repository = browse.PostgresLibraryBrowseRepository({**fixture.config, problematic_index.ENABLED_KEY: "1"})
    _watcher_pass(fixture, active=[{**fixture.strays["A"], "title": "Waiting"}])

    assert problematic_index.serving_readiness(repository)["changed_loose_groups_waiting"] == 1
    problematic_index.prepare_for_serving(repository)
    assert problematic_index.serving_readiness(repository)["changed_loose_groups_waiting"] == 0


def _rows_read_for_a_page(fixture, limit):
    """Rows every scan of the items table returned for one page, from EXPLAIN ANALYZE."""
    import json

    from music_app.services import problematic_index

    with isolatedPostgres._connect(fixture.setup_url) as connection:
        plan = connection.execute(
            "explain (analyze, format json) " + problematic_index._READ_PAGE_SQL,
            {"after": None, "needle": "", "limit": limit + 1},
        ).fetchone()
    plan = plan[0] if isinstance(plan, (list, tuple)) else next(iter(plan.values()))
    plan = json.loads(plan) if isinstance(plan, str) else plan
    read = 0

    def walk(node):
        nonlocal read
        if node.get("Relation Name") == "problematic_index_items":
            read += int(node.get("Actual Rows", 0)) * int(node.get("Actual Loops", 1))
        for child in node.get("Plans", []):
            walk(child)

    walk(plan[0]["Plan"])
    return read


def test_live_a_page_reads_a_bounded_number_of_items_past_an_inactive_root(loose_library):
    """6.5's correction c: groups under an inactive root that sort before every item shown are never read,
    so a page reads the same number of rows with 20 or 400 of them."""
    fixture = loose_library
    root_id = _rows(fixture, "select id from library.library_roots where root_path = %s",
                    (fixture.roots[1]["path"],))[0]["id"]
    library_id = _rows(fixture, "select library_id from library.library_roots where id = %s", (root_id,))[0]["library_id"]
    _rows(fixture, "update library.library_roots set is_active = false where id = %s", (root_id,))

    def hide(numbers):
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            connection.cursor().executemany(
                """insert into library.problematic_index_items
                     (library_id, item_key, album_id, root_id, sort_name, sort_artist, sort_year, sort_key,
                      search_text, duplicate_identities, item)
                   values (%s, %s, null, %s, %s, '', '', %s, '', '{}', '{}'::jsonb)""",
                [(library_id, f"loose-source::hidden{number:06}", root_id, f"!{number:06}", f"hidden{number:06}")
                 for number in numbers],
            )

    reads = {}
    hide(range(20))
    reads[20] = _rows_read_for_a_page(fixture, limit=2)
    hide(range(20, 400))
    reads[400] = _rows_read_for_a_page(fixture, limit=2)

    assert reads[20] == reads[400], f"Rows read grew with the hidden items: {reads}."
    assert reads[400] <= 3 * 3, f"A page of 2 read {reads[400]} items."


# 6.5's first condition: a key mismatch would leave marks that never clear an item.
KEY_PATHS = [
    pytest.param(r"C:\Music\Artist\Album\01 - Song.flac", id="windows-backslashes"),
    pytest.param(r"c:\MUSIC\artist\ALBUM\01 - Song.flac", id="windows-mixed-case"),
    pytest.param("D:/Music/Artist/Album/01.flac", id="windows-forward-slashes"),
    pytest.param(r"C:\Music/Mixed\Separators/01.flac", id="windows-mixed-separators"),
    pytest.param("C:\\Music\\Artist\\Album\\", id="windows-trailing-separator"),
    pytest.param(r"C:\01.flac", id="windows-drive-root"),
    pytest.param("/music/artist/album/01.flac", id="posix"),
    pytest.param("/Music/Artist/Album/", id="posix-trailing-separator"),
    pytest.param("/01.flac", id="posix-root"),
    pytest.param("/music/Caf\u00e9/01.flac", id="non-ascii-nfc"),
    pytest.param("/music/Cafe\u0301/01.flac", id="non-ascii-nfd"),
    pytest.param(r"C:\Музыка\ДДТ\Ремиксы\01.flac", id="cyrillic"),
    pytest.param("/music/天門/She and Her Cat/01.flac", id="cjk"),
]


@pytest.mark.parametrize("path", KEY_PATHS)
def test_live_the_sql_group_key_equals_the_loaders_for_every_path_shape(watcher_repair_inventory, path):
    """The group a trigger marks (0294's key over the stored scan_physical_parent) is the group the loader
    builds an item for (_problematic_loose_group_key over its identity), for every path shape."""
    from music_app.services import library_browse_postgres as browse
    from music_app.services.library_inventory_postgres import _membership_problem_group_identity_sql

    fixture = watcher_repair_inventory
    root_id = 7
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        # The stored column's own expression, read from the catalog, never retyped here.
        generated = connection.execute(
            """select pg_get_expr(defaults.adbin, defaults.adrelid) as expression
               from pg_attrdef defaults
               join pg_attribute columns on columns.attrelid = defaults.adrelid and columns.attnum = defaults.adnum
               where defaults.adrelid = 'library.local_track_files'::regclass
                 and columns.attname = 'scan_physical_parent'""",
        ).fetchone()["expression"]
        connection.execute(
            f"""create temp table key_paths (private_path text,
                  scan_physical_parent text generated always as ({generated}) stored)""")
        connection.execute("insert into key_paths (private_path) values (%s)", (path,))
        row = connection.execute(
            f"""select scan_physical_parent as stored_folder,
                  library.problematic_loose_group_key(%(root)s, scan_physical_parent) as sql_key,
                  {_membership_problem_group_identity_sql("%(root)s", "private_path")} as loader_identity,
                  split_part({_membership_problem_group_identity_sql("%(root)s", "private_path")}, chr(1), 2)
                    as loader_folder
                from key_paths""",
            {"root": root_id},
        ).fetchone()

    assert row["loader_folder"] == row["stored_folder"], "The trigger and the loader name different folders."
    assert row["sql_key"] == browse._problematic_loose_group_key(row["loader_identity"]), (
        "The marked group's key is not the item's key.")


def _library_id(fixture):
    return _rows(fixture, "select id from library.libraries where library_kind = 'local' limit 1")[0]["id"]


def _event_move_between_folders(fixture):
    moved = fixture.stray("Strays C")
    _watcher_pass(fixture, active=[moved], deleted=[fixture.strays["A"]["path"]])
    return {"Strays A", "Strays C"}


def _event_override(fixture):
    _rows(fixture, """insert into library.exception_overrides (library_id, track_key, override_payload)
                      values (%s, %s, '{"exception_type": "Non-album rarity"}'::jsonb)""",
          (_library_id(fixture), fixture.strays["A"]["path"]))
    return {"Strays A"}


def _event_rule_added_then_reverted(fixture):
    from music_app.services import library_browse_postgres as browse

    key = browse._problem_identity_row_key(fixture.strays["B"]["path"], "Missing artist", scope="file")
    _rows(fixture, "insert into library.ignored_repairs (library_id, repair_key) values (%s, %s)",
          (_library_id(fixture), key))
    _assert_read_is_a_full_rebuild(fixture)
    _rows(fixture, "delete from library.ignored_repairs where repair_key = %s", (key,))
    return {"Strays B"}


def _event_root_renamed(fixture):
    _rows(fixture, "update library.library_roots set metadata = metadata || '{\"label\": \"Renamed\"}'::jsonb "
                   "where root_path = %s", (fixture.roots[1]["path"],))
    return set()


def _event_root_deleted(fixture):
    _rows(fixture, "delete from library.library_roots where root_path = %s", (fixture.roots[1]["path"],))
    return {"Strays H"}


def _event_stale_and_back(fixture):
    path = fixture.strays["A"]["path"]
    stale = """update library.local_track_files
               set metadata = jsonb_set(metadata, '{scan_cache,stale}', to_jsonb(%s::boolean))
               where private_path = %s"""
    _rows(fixture, stale, (True, path))  # scan_cache_stale is generated from metadata.scan_cache.stale
    assert _marked_groups(fixture) <= _named("Strays A")
    _assert_read_is_a_full_rebuild(fixture)
    _rows(fixture, stale, (False, path))
    return {"Strays A"}


def _event_artist_renamed(fixture):
    _rows(fixture, "update library.local_artists set name = name || ' (renamed)', sort_name = sort_name || 'z'")
    # Loose files have no artist tag; a group is marked only if one of its tracks names a renamed artist.
    return {row["folder"].rsplit("/", 1)[-1] for row in _rows(fixture, """
        select distinct files.scan_physical_parent as folder from library.local_track_files files
        join library.local_tracks tracks on tracks.id = files.track_id
        where tracks.album_id is null and tracks.artist_id is not null""")}


def _assert_read_is_a_full_rebuild(fixture):
    assert _as_served(_indexed_problematic_items(fixture.database_url, limit=50)) == _as_served(
        _evaluated_problematic_items(fixture.config))


EVENTS = [
    pytest.param(_event_move_between_folders, id="move-between-folders"),
    pytest.param(_event_override, id="override"),
    pytest.param(_event_rule_added_then_reverted, id="rule-added-then-reverted"),
    pytest.param(_event_root_renamed, id="root-renamed"),
    pytest.param(_event_root_deleted, id="root-deleted"),
    pytest.param(_event_stale_and_back, id="stale-and-back"),
    pytest.param(_event_artist_renamed, id="artist-renamed"),
]


@pytest.mark.parametrize("event", EVENTS)
def test_live_each_event_marks_only_its_groups_and_a_read_equals_a_full_rebuild(loose_library, event):
    fixture = loose_library
    _assert_read_is_a_full_rebuild(fixture)
    assert _marked_groups(fixture) == set()

    affected = _named(*event(fixture))

    assert _marked_groups(fixture) <= affected, f"Unaffected groups marked: {_marked_groups(fixture) - affected}."
    _finish_live_reconciliation(fixture.config)  # what production publishes after the event's writes
    _assert_read_is_a_full_rebuild(fixture)
    assert _marked_groups(fixture) == set()


def test_live_0294_applies_over_existing_loose_rows_and_reruns_idempotently(loose_library):
    """6.5's third condition: on a library that already has loose files and items, 0294 builds one group row
    per loose group and gives every loose item its root; running it again changes nothing."""
    from pathlib import Path

    fixture = loose_library
    migration = (Path(__file__).resolve().parents[2] / "migrations" / "postgres"
                 / "0294_mark_loose_groups_for_problematic_index.sql").read_text(encoding="utf-8")

    def state():
        return (
            _rows(fixture, "select item_key, root_id, folder, marked_xid is not null as marked "
                           "from library.problematic_loose_groups order by item_key"),
            _rows(fixture, "select item_key, root_id from library.problematic_index_items "
                           "where album_id is null order by item_key"),
            _rows(fixture, """select indexname, indexdef from pg_indexes where schemaname = 'library'
                              and indexname in ('problematic_loose_groups_marked_idx',
                                'problematic_index_items_root_order_idx', 'local_track_files_loose_group_idx')
                              order by indexname"""),
        )

    built = state()
    loose_groups = _rows(fixture, """select count(distinct (library_root_id, scan_physical_parent)) as n
        from library.local_track_files where scan_cache_stale is false
          and nullif(metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null""")[0]["n"]
    assert len(built[0]) == loose_groups == 3
    assert all(row["root_id"] is not None for row in built[1])

    # As a library looked before 0294: no group rows, and loose items without a root.
    _rows(fixture, "delete from library.problematic_loose_groups")
    _rows(fixture, "update library.problematic_index_items set root_id = null")
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute(migration)
    groups, items, indexes = state()
    assert [(row["item_key"], row["root_id"], row["folder"]) for row in groups] == [
        (row["item_key"], row["root_id"], row["folder"]) for row in built[0]]
    assert items == built[1] and indexes == built[2]

    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute(migration)
    assert state() == (groups, items, indexes), "0294 is not idempotent."


def _table_rows(fixture, drain_connection):
    """Rows read and written per library table so far, after the drain's backend has flushed its stats."""
    import time

    drain_connection.execute("select pg_stat_force_next_flush()")
    drain_connection.execute("select 1")  # idle after this: the forced flush happens
    previous = None
    for _ in range(40):
        with isolatedPostgres._connect(fixture.setup_url) as reader:
            reader.execute("select pg_stat_clear_snapshot()")
            current = {row["relname"]: (int(row["read"]), int(row["written"])) for row in reader.execute(
                """select relname, coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0) as read,
                          n_tup_ins + n_tup_upd + n_tup_del as written
                   from pg_stat_user_tables where schemaname = 'library'""").fetchall()}
        if current == previous:
            return current
        previous = current
        time.sleep(0.05)
    return previous


def _one_loose_edit_drain(fixture, title, phase=lambda _name: None):
    """Rows the drain of one loose file's edit read and wrote, per table."""
    import psycopg
    from psycopg.rows import dict_row

    from music_app.services import library_browse_postgres as browse, problematic_index

    repository = browse.PostgresLibraryBrowseRepository({**fixture.config, problematic_index.ENABLED_KEY: "1"})
    # Nothing waits before the edit: the deploy step drains every group the bulk add marked.
    import time
    phase("deploy step start")
    problematic_index.prepare_for_serving(repository)
    phase("deploy step done")
    _assert_read_is_a_full_rebuild(fixture)
    phase("full-rebuild comparison done")
    _watcher_pass(fixture, active=[{**fixture.strays["A"], "title": title}])
    with psycopg.connect(fixture.database_url, row_factory=dict_row, autocommit=True) as connection:
        library_id = _library_id(fixture)
        groups = connection.execute(problematic_index._MARKED_GROUPS_SQL, (library_id, "", 100)).fetchall()
        assert len(groups) == 1
        before = _table_rows(fixture, connection)
        phase("drain start")
        problematic_index._drain_groups(repository, connection, library_id, groups)
        phase("drain done")
        after = _table_rows(fixture, connection)
    return {table: (after[table][0] - before.get(table, (0, 0))[0], after[table][1] - before.get(table, (0, 0))[1])
            for table in after if after[table] != before.get(table)}


def _seed_loose_files(fixture, prefix, count):
    """``count`` loose files, each in a folder of its own, in one INSERT per table (generate_series): clones
    of stray A's track and file rows, every column but the identity and generated ones read from the catalog.
    Every row trigger still fires; only the per-file scan path is skipped."""
    source_path = fixture.strays["A"]["path"]

    def columns(connection, table):
        return [row["column_name"] for row in connection.execute(
            """select column_name from information_schema.columns
               where table_schema = 'library' and table_name = %s
                 and is_generated = 'NEVER' and is_identity = 'NO' order by ordinal_position""", (table,)).fetchall()]

    with isolatedPostgres._connect(fixture.setup_url) as connection:
        track_columns, file_columns = columns(connection, "local_tracks"), columns(connection, "local_track_files")
        source = connection.execute(
            "select id, track_id from library.local_track_files where private_path = %s", (source_path,)).fetchone()
        folder = "'" + prefix + " ' || lpad(n::text, 4, '0')"
        track_values = ", ".join(
            f"source.track_key || '::{prefix}::' || n" if column == "track_key" else f"source.{column}"
            for column in track_columns)
        connection.execute(
            f"""insert into library.local_tracks ({", ".join(track_columns)})
                select {track_values} from library.local_tracks source, generate_series(1, %(count)s) n
                where source.id = %(track)s""",
            {"count": count, "track": source["track_id"]})
        overrides = {
            "track_id": "tracks.id",
            "private_path": f"replace(source.private_path, 'Strays A', {folder})",
            "relative_path": f"replace(source.relative_path, 'Strays A', {folder})",
        }
        file_values = ", ".join(overrides.get(column, f"source.{column}") for column in file_columns)
        connection.execute(
            f"""insert into library.local_track_files ({", ".join(file_columns)})
                select {file_values}
                from library.local_track_files source
                cross join generate_series(1, %(count)s) n
                join library.local_tracks tracks on tracks.track_key = (
                  select track_key from library.local_tracks where id = source.track_id) || '::{prefix}::' || n
                where source.id = %(file)s""",
            {"count": count, "file": source["id"]})
    _finish_live_reconciliation(fixture.config)  # what production publishes after such a write


def test_live_one_loose_edit_drains_the_same_rows_at_20_and_2000_loose_tracks(loose_library):
    """6.5's fourth condition, counted from the database's own table statistics. Seeding is set-based."""
    import faulthandler
    import sys
    import time

    # Fail fast: a hang dumps every thread's stack and ends the run instead of using up the slot.
    faulthandler.dump_traceback_later(600, exit=True)
    fixture = loose_library
    began = time.perf_counter()

    def phase(name):
        print(f"timing: {name} at {time.perf_counter() - began:.1f} s", file=sys.stderr, flush=True)

    try:
        _seed_loose_files(fixture, "Small", 17)
        phase("17 loose files seeded")
        small = _one_loose_edit_drain(fixture, "Edited at 20", phase)
        phase("drain at 20 done")
        _seed_loose_files(fixture, "Large", 2000)
        phase("2,000 loose files seeded")
        large = _one_loose_edit_drain(fixture, "Edited at 2020", phase)
        phase("drain at 2,020 done")
    finally:
        faulthandler.cancel_dump_traceback_later()

    totals = {name: (sum(read for read, _ in rows.values()), sum(written for _, written in rows.values()))
              for name, rows in (("20", small), ("2020", large))}
    print("drain contract (rows read, rows written):", totals, "per table at 20:", small, "at 2020:", large,
          "ignored_repairs read:", small.get("ignored_repairs", (0, 0))[0], large.get("ignored_repairs", (0, 0))[0])
    assert abs(totals["2020"][0] - totals["20"][0]) <= 25, f"Rows read grew with the library: {small} vs {large}."
    assert totals["2020"][1] == totals["20"][1], f"Rows written grew with the library: {small} vs {large}."


# Rows a 200-folder batch's loader may read beyond the same batch at a 10x larger library: index pages and the
# bootstrap rows, never a pass over the library's tracks, files or overrides.
_BATCH_ROWS_READ_SLACK = 50
# Shared buffers a one-page exception_overrides Seq Scan may touch per batch-key probe (6.5): its page, plus
# one for a visibility or hint-bit lookup.
_OVERRIDE_PROBE_BUFFERS_PER_KEY = 2
# The first 500-folder batch of a drain right after a bulk add, with no statistics, took over 120 s before.
_FIRST_BATCH_SECONDS = 5.0


class _ExplainingConnection:
    """The drain's own connection, which first runs EXPLAIN (ANALYZE) of the candidate statement it is given,
    so the plan checked is the executed one: a plan flat in estimate but not in execution cannot hide. The
    analyzed run reads the same rows as the real one, so each size's rows-read count doubles alike."""

    def __init__(self, connection, plans):
        self._connection, self._plans = connection, plans

    def execute(self, sql, params=None):
        if "eligible_track_file_ids" in str(sql):
            self._plans.append(
                self._connection.execute("explain (analyze, buffers, format json) " + sql, params).fetchone())
        return self._connection.execute(sql, params)

    def __getattr__(self, name):
        return getattr(self._connection, name)


def _plan_nodes(plan):
    nodes = [plan]
    for child in plan.get("Plans", []):
        nodes.extend(_plan_nodes(child))
    return nodes


def _seed_overrides(fixture, prefix, count):
    """``count`` exception overrides on the prefix's loose files, by path, none with an exception type: the
    files stay membership problems and the override ranking has rows to rank."""
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute(
            """insert into library.exception_overrides (library_id, track_id, track_key, override_payload)
               select tracks.library_id, tracks.id, files.private_path, '{"custom_collection_name": ""}'::jsonb
               from library.local_track_files files
               join library.local_tracks tracks on tracks.id = files.track_id
               where files.private_path like %(pattern)s
               order by files.id limit %(count)s""",
            {"pattern": f"%{prefix} %", "count": count})


@pytest.mark.parametrize("statistics", [False, True], ids=["never-analyzed", "analyzed"])
@pytest.mark.parametrize("overrides", [False, True], ids=["no-overrides", "overrides"])
def test_live_a_drain_batch_reads_only_its_folders_without_statistics(loose_library, overrides, statistics):
    """Case 55, plan-robust drain (6.5). Right after a bulk add of loose groups, before any ANALYZE (reltuples
    -1, asserted), and again with every table analyzed, a 200-folder batch's loader uses 0294's
    local_track_files_loose_group_idx, scans no track or file table sequentially, and reads the same number of
    table rows with 200 and 2,000 loose groups in the library, with or without about 1,000 exception overrides.
    The first 500-folder drain batch then finishes within _FIRST_BATCH_SECONDS. A statement timeout ends a bad
    plan fast."""
    import time

    import psycopg
    from psycopg.rows import dict_row

    from music_app.services import library_browse_postgres as browse, problematic_index

    fixture = loose_library
    tables = ("local_track_files", "local_tracks", "problematic_loose_groups", "exception_overrides")
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        for table in tables:  # this disposable database only: no ANALYZE may run behind the test
            connection.execute(f"alter table library.{table} set (autovacuum_enabled = false)")
    repository = browse.PostgresLibraryBrowseRepository({**fixture.config, problematic_index.ENABLED_KEY: "1"})
    library_id = _library_id(fixture)
    measured = {}

    def batch_rows_read(size):
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            if statistics:
                for table in tables:
                    connection.execute(f"analyze library.{table}")
            reltuples = {row["relname"]: float(row["reltuples"]) for row in connection.execute(
                "select relname, reltuples from pg_class where relnamespace = 'library'::regnamespace"
                " and relname = any(%s)", (list(tables[:3]),)).fetchall()}
            # The override table's real size in pages (not pg_class.relpages, which only ANALYZE updates).
            override_pages = int(connection.execute(
                "select pg_relation_size('library.exception_overrides')"
                " / current_setting('block_size')::bigint as pages").fetchone()["pages"])
            connection.execute("update library.problematic_loose_groups set marked_xid = pg_current_xact_id()")
        if statistics:
            assert -1.0 not in reltuples.values(), f"the tables must be analyzed: {reltuples}"
        else:
            assert set(reltuples.values()) == {-1.0}, f"the tables must have no statistics: {reltuples}"
        plans = []
        with psycopg.connect(fixture.database_url, row_factory=dict_row) as connection:
            connection.execute("set statement_timeout = '20s'")
            folders = {(int(row["root_id"]), str(row["folder"])) for row in connection.execute(
                problematic_index._MARKED_GROUPS_SQL, (library_id, "", 200)).fetchall()}
            assert len(folders) == 200
            with connection.transaction(force_rollback=True):
                read = "select coalesce(sum(coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0)), 0) as rows" \
                       " from pg_stat_xact_user_tables where schemaname = 'library'"
                before = int(connection.execute(read).fetchone()["rows"])
                loaded = repository._load_problematic_loose_file_rows(
                    connection=_ExplainingConnection(connection, plans), limit=None,
                    membership_folders=folders, all_roots=True)
                rows_read = int(connection.execute(read).fetchone()["rows"]) - before
        assert loaded, "the batch's loose files are loaded"
        nodes = _plan_nodes(plans[0]["QUERY PLAN"][0]["Plan"])
        assert any(node.get("Index Name") == "local_track_files_loose_group_idx" for node in nodes), (
            "the folder lookup uses 0294's index")
        # 6.5's rule: a per-key probe of exception_overrides may be a Seq Scan only while the table is one page
        # (scanning one page is cheaper than an index probe, and its rows are arithmetic, not I/O), and then it
        # touches at most _OVERRIDE_PROBE_BUFFERS_PER_KEY shared buffers per probe. Any other Seq Scan on a
        # library table, or on exception_overrides once it has more than one page, fails.
        sequential = []
        for node in nodes:
            if node["Node Type"] != "Seq Scan" or node.get("Relation Name") not in tables:
                continue
            if node["Relation Name"] == "exception_overrides" and override_pages <= 1:
                buffers = node.get("Shared Hit Blocks", 0) + node.get("Shared Read Blocks", 0)
                loops = max(1, node.get("Actual Loops", 1))
                assert buffers <= _OVERRIDE_PROBE_BUFFERS_PER_KEY * loops, (
                    f"the one-page override probe touched {buffers} buffers over {loops} probes")
                continue
            sequential.append(node["Relation Name"])
        assert sequential == [], (
            f"no pass over a library table (exception_overrides: {override_pages} pages): {sequential}")
        measured[size] = rows_read

    _seed_loose_files(fixture, "Small", 200)
    if overrides:
        _seed_overrides(fixture, "Small", 100)
    batch_rows_read("200")
    _seed_loose_files(fixture, "Large", 1800)
    if overrides:
        _seed_overrides(fixture, "Large", 900)
    batch_rows_read("2000")
    print(f"[case55-drain-batch] statistics={statistics} overrides={overrides}"
          f" rows read for a 200-folder batch: {measured}")
    assert abs(measured["2000"] - measured["200"]) <= _BATCH_ROWS_READ_SLACK, (
        f"the batch read grew with the library: {measured}")

    with psycopg.connect(fixture.database_url, row_factory=dict_row, autocommit=True) as connection:
        connection.execute("set statement_timeout = '20s'")
        groups = connection.execute(problematic_index._MARKED_GROUPS_SQL,
                                    (library_id, "", problematic_index.BACKFILL_BATCH)).fetchall()
        assert len(groups) == problematic_index.BACKFILL_BATCH
        started = time.perf_counter()
        problematic_index._drain_groups(repository, connection, library_id, groups)
        seconds = time.perf_counter() - started
    print(f"[case55-drain-batch] statistics={statistics} overrides={overrides}"
          f" first {len(groups)}-folder drain batch: {seconds:.2f} s")
    assert seconds < _FIRST_BATCH_SECONDS, f"the first drain batch took {seconds:.1f} s"


def test_no_app_code_deletes_a_library_root():
    """Settings only deactivates a root; nothing deletes one. A root deleted by hand leaves its loose items
    stored but unserved (the read joins active roots). A delete path in the app would need to remove that
    root's index items in its transaction first (6.5's backlog: an FK with ON DELETE CASCADE)."""
    import re
    from pathlib import Path

    app = Path(__file__).resolve().parents[2] / "music_app"
    deleting = re.compile(r"delete\s+from\s+(?:only\s+)?library\.library_roots\b", re.IGNORECASE)
    offenders = [str(path.relative_to(app)) for path in app.rglob("*.py")
                 if deleting.search(path.read_text(encoding="utf-8", errors="replace"))]
    assert offenders == []
