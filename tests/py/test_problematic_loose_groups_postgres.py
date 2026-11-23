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
