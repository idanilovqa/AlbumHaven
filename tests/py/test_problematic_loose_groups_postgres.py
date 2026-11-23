"""Case 55 (0294): a loose change re-checks only its group, never every loose track.

A loose file has no artist tag ("Missing artist"); its group is (root, physical parent folder).
"""
from __future__ import annotations

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (live fixture)
from tests.py.test_problematic_albums import (
    _as_served, _evaluated_problematic_items, _indexed_problematic_items, _ready_problematic_index, _watcher_pass,
)


@pytest.fixture
def loose_library(watcher_repair_inventory, monkeypatch):
    from music_app.services import problematic_index

    fixture = watcher_repair_inventory
    # Marks stay where a test can read them: nothing drains in the background.
    monkeypatch.setattr(problematic_index, "queue_maintenance", lambda _repository: None)

    def stray(folder, *, root=0, title="01"):
        entry = fixture.entry(f"Owner/{folder}/{title}.flac", root=root, artist="")
        entry["album_artist"] = ""
        return entry

    fixture.stray = stray
    fixture.strays = {"A": stray("Strays A"), "B": stray("Strays B"), "Hoard": stray("Strays H", root=1)}
    fixture.seed(*(fixture.entry(f"Owner/Album/{track}.flac") for track in ("01", "02", "03")),
                 *fixture.strays.values())
    fixture.database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    _ready_problematic_index(fixture.database_url)
    return fixture


def _rows(fixture, sql, params=()):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        return connection.execute(sql, params).fetchall()


def _marked_groups(fixture):
    return {row["folder"].rsplit("/", 1)[-1].rsplit("\\", 1)[-1] for row in _rows(
        fixture, "select folder from library.problematic_loose_groups where marked_xid is not null")}


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

    assert _marked_groups(fixture) == {"Strays A"}, "A loose edit marks exactly its own group."
    assert _rows(fixture, "select count(*) as n from library.problematic_index_dirty_albums where album_id <= 0")[0]["n"] == 0
    assert _as_served(_indexed_problematic_items(fixture.database_url, limit=50)) == _as_served(
        _evaluated_problematic_items(fixture.config))
    assert _marked_groups(fixture) == set(), "The read drained the group's mark."


def test_live_a_group_whose_last_loose_file_joins_an_album_loses_its_item_and_keeps_its_row(loose_library):
    fixture = loose_library
    before = _loose_items(fixture)
    rows_before = _rows(fixture, "select count(*) as n from library.problematic_loose_groups")[0]["n"]

    tagged = {**fixture.strays["B"], "artist": "Owner", "album_artist": "Owner", "album": "Repair Album"}
    _watcher_pass(fixture, active=[tagged])

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
