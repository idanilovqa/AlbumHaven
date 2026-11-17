"""Same-name artists split per album by their MusicBrainz artist (D2 item 3, approved b3-3).

Database-free rules, each with its negative: the split happens once in SQL (the 0192 view,
for ``per_album`` artists only), a split group is addressed by its label, and every other
artist's queries and rows stay as they were. The real-Postgres cases live in
test_isolated_postgres_live.py (test_live_*same_name* / *split*).
"""
from __future__ import annotations

import re

import pytest

from music_app.services import library_browse_postgres as browse


def _normalized(sql: str) -> str:
    return " ".join(sql.lower().split())


# Rule 1: every tree, gallery, selection, search and album-details query takes the split
# group from the one CTE, which reads only per_album artists' proven groups.

_SPLIT_QUERIES = {
    "tree": browse._root_sidebar_sql,
    "gallery membership": browse._root_gallery_membership_sql,
    "gallery page rows": browse._root_gallery_page_rows_sql,
    "root album browse": browse._root_album_browse_sql,
    "startup tree": lambda: browse._root_startup_payload_sql(12),
    "selected artist": browse._selected_artist_sql,
    "selected artist preview": lambda: browse._selected_artist_preview_sql(12, balance_across_artists=True),
    "artist preview": browse._artist_preview_rows_sql,
    "search": browse._search_preview_sql,
    "album details": browse._album_detail_sql,
}


@pytest.mark.parametrize("name", list(_SPLIT_QUERIES))
def test_each_browse_query_reads_the_split_groups_once_through_the_per_album_cte(name):
    sql = _normalized(_SPLIT_QUERIES[name]())
    assert sql.count("split_album_groups as materialized") == 1
    # The view (with its window functions) is joined once, inside the CTE, never per row.
    assert sql.count("library.local_album_artist_groups") == 1
    cte = sql[sql.index("split_album_groups as materialized"):]
    cte = cte[:cte.index(") ,") if ") ," in cte else cte.index("),")]
    assert "split_match.state = 'per_album'" in cte
    assert "starts_with(artist_groups.group_key, 'musicbrainz:')" in cte
    assert "left join split_album_groups artist_group" in sql
    # Album details keep the tag as the album's artist; their header label comes from
    # _album_musicbrainz_artist, and only the artist projection here follows the group.
    assert ("artist_group.group_label" in sql) is (name != "album details")


def test_album_details_name_the_group_of_a_proven_split_album_only():
    mbid = "6b1f0c2e-1111-4000-8000-000000000001"
    split = _Connection([{"mbid": mbid, "canonical_name": "Amarok", "disambiguation": None,
                          "tag_differs": False, "split": True, "group_label": "Amarok (Poland)"}])
    matched = _Connection([{"mbid": mbid, "canonical_name": "Angra", "disambiguation": None,
                            "tag_differs": False, "split": False, "group_label": None}])
    assert browse._album_musicbrainz_artist(split, 1)["group_label"] == "Amarok (Poland)"
    assert "group_label" not in browse._album_musicbrainz_artist(matched, 2)
    sql = _normalized(split.sql[0])
    assert "where artist_match.state = 'per_album'" in sql
    assert "starts_with(artist_groups.group_key, 'musicbrainz:')" in sql


def test_a_matched_artist_is_never_split_and_undecided_albums_keep_the_plain_name():
    cte = _normalized(browse._split_album_groups_cte_sql())
    # Only per_album artists; 'matched' (one identity) never enters the CTE.
    assert "state = 'per_album'" in cte and "'matched'" not in cte
    # Undecided albums ('artist:<id>' groups) are left out, so they keep the local name.
    assert "starts_with(artist_groups.group_key, 'musicbrainz:')" in cte
    for factory in (browse._root_sidebar_sql, browse._root_gallery_membership_sql, browse._selected_artist_sql):
        assert re.search(r"coalesce\(artist_group\.group_label, [a-z_.]+\) as artist_name", _normalized(factory()))


def test_the_tree_groups_a_split_name_per_label_and_the_album_details_show_the_group():
    sidebar = _normalized(browse._root_sidebar_sql())
    assert "group by artist_id, artist_name" in sidebar
    startup = _normalized(browse._root_startup_payload_sql(12))
    assert "group by artist_album_rows.artist_id, artist_album_rows.artist_name" in startup
    # A preview row of "Amarok (Poland)" takes only its own albums, plain "Amarok" only the undecided.
    assert "where artist_group.group_label is not distinct from preview_artists.artist_group_label" in startup


def test_a_proven_group_takes_its_own_musicbrainz_artist_and_skips_the_identity_list():
    joins = _normalized(browse._artist_musicbrainz_projection_joins_sql(
        library_id="rows.library_id", artist_id="rows.artist_id", album_id="rows.album_id"))
    columns = _normalized(browse._artist_musicbrainz_projection_columns_sql())
    assert "coalesce(artist_match.artist_mbid, artist_group.artist_mbid)::text as artist_mbid" in columns
    assert "musicbrainz_artist.mbid = coalesce(artist_match.artist_mbid, artist_group.artist_mbid)" in joins
    assert "artist_match.state = 'matched'" in joins, "a matched artist keeps its own match"
    assert "and artist_group.artist_mbid is null" in joins, "only undecided rows list the identities"


# Rule 2: a split group is addressed by its label; the selection loads its local name and
# keeps only the label's albums. "Amarok", "Amarok (Poland)" and "Amarok (Spain)" stay apart.

def test_a_split_label_names_its_possible_local_names():
    assert browse._split_label_base_keys("Amarok (Poland)") == ["amarok"]
    assert browse._split_label_base_keys("Alice Cooper (US band, 1964-1975)") == ["alice cooper"]
    assert browse._split_label_base_keys("Foo (Live) (Japan)") == ["foo", "foo (live)"]
    assert browse._split_label_base_keys("Angra") == []
    assert browse._split_label_base_keys("(Hed) P.E.") == []


def test_a_label_selection_also_loads_its_local_name_and_a_plain_one_loads_nothing_else():
    assert browse._selected_artist_query_keys(["Amarok (Poland)"]) == (
        ["amarok (poland)", "amarok"], {"amarok (poland)"}, {"amarok"})
    assert browse._selected_artist_query_keys(["Amarok", "Amarok (Spain)"]) == (
        ["amarok", "amarok (spain)"], {"amarok", "amarok (spain)"}, set())
    assert browse._selected_artist_query_keys(["Angra", "Angra"]) == (["angra", "angra"], {"angra"}, set())


_ROWS = [
    {"artist_name": "Amarok (Poland)", "artist_group_label": "Amarok (Poland)", "album_key": "hunt"},
    {"artist_name": "Amarok (Spain)", "artist_group_label": "Amarok (Spain)", "album_key": "sol"},
    {"artist_name": "Amarok", "artist_group_label": None, "album_key": "open"},
]


def test_a_split_label_keeps_only_its_albums_and_the_plain_name_only_the_undecided():
    poland = browse._selected_split_group_rows(_ROWS, {"amarok (poland)"}, {"amarok"})
    plain = browse._selected_split_group_rows(_ROWS, {"amarok"}, set())
    assert [row["album_key"] for row in poland] == ["hunt"]
    assert [row["album_key"] for row in plain] == ["open"]


def test_rows_of_an_artist_nobody_splits_pass_unchanged():
    rows = [{"artist_name": "Angra", "album_key": "angels"}, {"artist_name": "Angra", "album_key": "holy"}]
    assert browse._selected_split_group_rows(rows, {"angra"}, set()) == rows


class _Connection:
    def __init__(self, rows):
        self.rows, self.sql, self.params = rows, [], []

    def execute(self, sql, params=None):
        self.sql.append(sql)
        self.params.append(params)
        return self

    def fetchall(self):
        return list(self.rows)


@pytest.mark.parametrize("loader", ["_load_selected_artist_rows", "_load_selected_artist_preview_rows",
                                    "_load_artist_preview_rows"])
def test_every_selection_loader_resolves_a_label_and_leaves_plain_requests_as_they_were(loader):
    repository = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"})
    view_state = browse._root_sidebar_view_state({})
    split = _Connection(_ROWS)
    rows = getattr(repository, loader)(["Amarok (Poland)"], view_state, connection=split)
    assert split.params[0]["artist_keys"] == ["amarok (poland)", "amarok"]
    assert [row["album_key"] for row in rows] == ["hunt"]

    unsplit_rows = [{"artist_name": "Angra", "album_key": "angels"}]
    unsplit = _Connection(unsplit_rows)
    assert getattr(repository, loader)(["Angra"], view_state, connection=unsplit) == unsplit_rows
    assert unsplit.params[0]["artist_keys"] == ["angra"]


def test_the_tree_start_keeps_every_group_of_a_name_it_asked_for_by_local_name():
    repository = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"})
    connection = _Connection(_ROWS)
    rows = repository._load_selected_artist_preview_rows(
        ["Amarok"], browse._root_sidebar_view_state({}), keep_split_groups=True, connection=connection)
    assert [row["album_key"] for row in rows] == ["hunt", "sol", "open"]


# Rule 3: the gallery and tree group per label, and the stored projection is rebuilt once.

def test_the_gallery_snapshot_gives_each_label_its_own_tree_row_and_group():
    rows = [
        {"artist_id": 7, "artist_name": "Amarok (Poland)", "album_id": 1, "album_key": "amarok::hunt",
         "album_title": "Hunt", "album_release_year": 2017, "featured_kind": "owner"},
        {"artist_id": 7, "artist_name": "Amarok (Spain)", "album_id": 2, "album_key": "amarok::sol",
         "album_title": "Sol", "album_release_year": 2001, "featured_kind": "owner"},
        {"artist_id": 7, "artist_name": "Amarok", "album_id": 3, "album_key": "amarok::open",
         "album_title": "Open", "album_release_year": 2010, "featured_kind": "owner"},
        {"artist_id": 8, "artist_name": "Angra", "album_id": 4, "album_key": "angra::angels cry",
         "album_title": "Angels Cry", "album_release_year": 1993, "featured_kind": "owner"},
    ]
    snapshot = browse._prepare_root_gallery_snapshot(rows, [], {}, browse._root_sidebar_view_state({}))
    assert snapshot["sidebar"] == [
        {"artist": "Amarok", "artist_display": "Amarok", "count": 1},
        {"artist": "Amarok (Poland)", "artist_display": "Amarok (Poland)", "count": 1},
        {"artist": "Amarok (Spain)", "artist_display": "Amarok (Spain)", "count": 1},
        {"artist": "Angra", "artist_display": "Angra", "count": 1},
    ]
    assert len({row["artist_id"] for row in snapshot["ordered"]}) == 4


def test_the_stored_gallery_projection_is_rebuilt_for_the_split():
    from music_app.services.gallery_projection_postgres import BUILDER_VERSION

    assert BUILDER_VERSION == "root-gallery-v5"
