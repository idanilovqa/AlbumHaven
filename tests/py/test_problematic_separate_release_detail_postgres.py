"""A separated release stored twice opens with the problems its list entry shows.

On sandbox2 (2026-11-24) one album was stored under its base key, emptied, and again under a separate-release
year key with its own small cover. The list built the year entry from the year row ("Poor art quality"); the
detail laid the emptied base row first, took its cover facts, found no problem and opened nothing.
Synthetic layout on a throwaway database only."""
from psycopg.types.json import Jsonb

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401
from tests.py.test_problematic_albums import _indexed_problematic_items, _ready_problematic_index


def _detail_reasons(detail):
    return {row["reason"] for row in detail.get("album_problem_rows") or []} | {
        reason for row in detail.get("track_problem_rows") or [] for reason in row.get("reasons") or []
    }


def test_live_a_year_entry_opens_from_its_own_stored_album_not_the_emptied_base(watcher_repair_inventory, monkeypatch):
    from music_app.services import problematic_index
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    fixture = watcher_repair_inventory
    entries = []
    for year, folder in ((1993, "1993 - Crown"), (2021, "2021 - Crown (RE)")):
        for number in (1, 2):
            entry = fixture.entry(f"Owner/{folder}/{number:02d}.flac", album="Crown")
            entry.update(year=year, track_number=number, title=f"Crown {number}")
            entries.append(entry)
    fixture.seed(*entries)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        albums = {row["release_year"]: row for row in connection.execute(
            "select id, album_key, library_id, artist_id, release_year from library.local_albums where title = 'Crown'"
        ).fetchall()}
        year_row = albums[1993]
        base_key = year_row["album_key"].split("::year::")[0]
        assert year_row["album_key"] == f"{base_key}::year::1993", "a full scan stores each year under its own key"
        # The year album's own cover is small; the emptied base album kept a cover path without its size.
        connection.execute(
            """update library.local_albums set cover_path = %s,
                 metadata = metadata || '{"local_cover_width": 300, "local_cover_height": 300}'::jsonb
               where id = %s""",
            ("crown-1993.jpg", year_row["id"]),
        )
        # The owner separated the releases; the base album keeps its own identity beside the year albums.
        connection.execute("insert into library.separate_releases(library_id, release_key) values (%s, %s)",
                           (year_row["library_id"], base_key))
        connection.execute(
            """insert into library.local_albums(library_id, artist_id, album_key, title, release_year, cover_path, metadata,
                 semantic_identity_discriminator)
               values (%s, %s, %s, 'Crown', 1993, 'crown-1993.jpg', %s, '')""",
            (year_row["library_id"], year_row["artist_id"], base_key, Jsonb({"album_artist": "Owner"})),
        )

    database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    _ready_problematic_index(database_url)
    problematic_index.wait_for_background_work()
    listed = {item["key"]: item for item in _indexed_problematic_items(database_url, limit=50)}
    year_key = f"{base_key}::year::1993"
    assert "Poor art quality" in listed[year_key]["problem_reasons"]

    repository = PostgresLibraryBrowseRepository({**fixture.config, problematic_index.ENABLED_KEY: "1"})
    # The rows' SQL has no order; on sandbox2 the emptied base album's row came first, as here.
    load_rows = repository._load_problematic_file_rows
    monkeypatch.setattr(repository, "_load_problematic_file_rows", lambda *args, **kwargs: sorted(
        load_rows(*args, **kwargs), key=lambda row: row["album_key"] != base_key))
    detail = repository.build_problematic_file_detail_payload(year_key)
    assert detail is not None, "the listed year entry opens"
    assert _detail_reasons(detail) == set(listed[year_key]["problem_reasons"])


def test_live_same_title_albums_years_apart_each_open_with_only_their_own_tracks(watcher_repair_inventory):
    """Owner (2026-11-24): the same artist and title years apart are different albums (an original and a
    re-recording). The list and every detail keep them apart, also once the owner separated the releases."""
    from music_app.services import problematic_index
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    fixture = watcher_repair_inventory
    paths = {}
    entries = []
    for year, folder, count in ((1993, "1993 - Crown", 3), (2021, "2021 - Crown (RE)", 2)):
        for number in range(1, count + 1):
            entry = fixture.entry(f"Owner/{folder}/{number:02d}.flac", album="Crown")
            entry.update(year=year, track_number=number + 1, title=f"Crown {year} {number}")  # no track 1
            entries.append(entry)
            paths.setdefault(year, set()).add(entry["path"])
    fixture.seed(*entries)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        albums = {row["release_year"]: row for row in connection.execute(
            "select album_key, library_id, release_year from library.local_albums where title = 'Crown'").fetchall()}
        base_key = albums[1993]["album_key"].split("::year::")[0]
        connection.execute("insert into library.separate_releases(library_id, release_key) values (%s, %s)",
                           (albums[1993]["library_id"], base_key))

    database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    _ready_problematic_index(database_url)
    problematic_index.wait_for_background_work()
    listed = {item["key"]: item for item in _indexed_problematic_items(database_url, limit=50)}
    repository = PostgresLibraryBrowseRepository({**fixture.config, problematic_index.ENABLED_KEY: "1"})
    for year in (1993, 2021):
        key = f"{base_key}::year::{year}"
        assert set(listed[key]["track_paths"]) == paths[year], f"{year}: the list entry holds only its album"
        detail = repository.build_problematic_file_detail_payload(key)
        assert detail is not None, f"{year}: the listed entry opens"
        assert {track["path"] for track in detail["tracks"]} == paths[year], f"{year}: only its own tracks"
        assert _detail_reasons(detail) == set(listed[key]["problem_reasons"]), f"{year}: the list's problems"
