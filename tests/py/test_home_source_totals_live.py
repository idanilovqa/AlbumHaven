"""/home-data source totals serve published gallery scopes only (6.5's C ruling, 2026-11-23): a published scope's
totals equal what the whole-library recount gave, an unpublished one is pending, and home never counts the
library itself."""

from __future__ import annotations

from tests.e2e.support import isolatedPostgres
from tests.py.bounded_interactions import CountingConnection, OperationCounts
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (live fixture)

_SOURCES = ("main_library", "new_arrivals", "hoard")
_SMALL, _LARGE = 4, 40
_CUSTOM = {"gallery_scope": "all", "visible_library_categories": ["hoard"]}


def _home_view_states():
    return [
        {"gallery_scope": "all", "visible_library_categories": [
            source for index, source in enumerate(_SOURCES) if mask & (1 << index)]}
        for mask in range(1, 2 ** len(_SOURCES))
    ]


def _key(view_state):
    return "|".join(sorted(view_state["visible_library_categories"]))


def _seed(fixture, albums):
    from music_app.services.gallery_projection_postgres import ensure_gallery_projection_ready

    fixture.seed(*(
        fixture.entry(f"Artist {index:03d}/Album {index:03d}/01.flac", root=index % 2,
                      artist=f"Artist {index:03d}", album=f"Album {index:03d}")
        for index in range(albums)
    ))
    # A custom scope a paged request already built (queue_gallery_scope_first_build's one build).
    ensure_gallery_projection_ready(fixture.config, connect=isolatedPostgres._connect, view_state=_CUSTOM)


def _repository(fixture, counts=None):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    def connect(url):
        connection = isolatedPostgres._connect(url)
        return connection if counts is None else CountingConnection(connection, counts)

    return PostgresLibraryBrowseRepository(fixture.config, connect=connect)


def _counted_totals(repository, view_state):
    """What /home-data counted for a scope before 6.5's C ruling: the whole-library recount."""
    from music_app.services import library_browse_postgres as browse

    with isolatedPostgres._connect(repository._database_url) as connection:
        aliases = browse._root_browse_alias_to_canonical(
            repository._load_relation_alias_maps(connection=connection)["alias_to_canonical"])
        rows = browse._canonicalize_artist_rows(
            connection.execute(browse._root_sidebar_sql(), browse._root_sidebar_params(view_state)).fetchall(),
            aliases)
        missing = browse._missing_album_projection_payloads(
            repository._load_missing_album_rows(connection=connection), view_state=view_state)
    _displays, _sorts, artist_counts, album_count = browse._root_sidebar_aggregate(rows)
    for album in missing:
        artist_counts.setdefault(browse._row_artist_identity({"artist_name": browse._canonical_artist_name(
            album.get("album_artist") or "Unknown Artist", aliases)}), 0)
    return {"artist_count": len(artist_counts), "album_count": album_count + len(missing)}


def test_live_home_serves_published_scope_totals_equal_to_the_counted_ones_and_reports_the_rest_pending(
    watcher_repair_inventory,
):
    """(b) The common root scope and an already built custom scope serve their published totals, equal to the
    whole-library recount; every other source combination is pending."""
    fixture = watcher_repair_inventory
    _seed(fixture, _SMALL)
    repository = _repository(fixture)

    payload = repository.build_root_source_totals_payload()

    published = {_key(_CUSTOM), "hoard|main_library|new_arrivals"}
    assert sorted(payload["pending_source_scopes"]) == sorted(
        _key(state) for state in _home_view_states() if _key(state) not in published)
    assert payload["source_totals_by_scope"] == {
        "": {"artist_count": 0, "album_count": 0},
        **{_key(state): _counted_totals(repository, state)
           for state in _home_view_states() if _key(state) in published},
    }


def test_live_home_totals_statements_are_flat_in_library_size(watcher_repair_inventory):
    """(c) /home-data's source totals read the published headers only: the same statements at any size."""
    fixture = watcher_repair_inventory
    statements = {}
    for albums in (_SMALL, _LARGE):
        _seed(fixture, albums)
        counts = OperationCounts()
        _repository(fixture, counts).build_root_source_totals_payload()
        statements[albums] = counts.sql_statements
    print(f"home source totals statements by album count: {statements}")
    assert statements[_SMALL] == statements[_LARGE]
