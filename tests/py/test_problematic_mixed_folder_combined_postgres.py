"""Owner (2026-11-25): an entry labelled "Mixed album metadata in one folder" lists every track of that folder in
one table, its own tracks first, then the other album(s) in the folder, each row with its own values and
problems. Read by the folder, never across the library. Synthetic layout on a throwaway database only."""
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401
from tests.py.test_problematic_albums import _indexed_problematic_items, _ready_problematic_index

MIXED = "Mixed album metadata in one folder"


def _seed_two_album_folder(fixture):
    paths = {}
    entries = []
    for album, album_artist, titles in (("Are You There", "Michał Łapaj", ("Intro", "Hope", "Rise")),
                                         ("Breathe", "Are You There", ("Breathe",))):
        for number, title in enumerate(titles, start=1):
            entry = fixture.entry(f"Shared/Are You There/{album_artist} - {number:02d}.flac", album=album,
                                  artist=album_artist)
            entry.update(album_artist=album_artist, title=title, track_number=number, year=2026)
            entries.append(entry)
            paths.setdefault(album, []).append(entry["path"])
    fixture.seed(*entries)
    return paths


def test_live_each_mixed_entry_lists_the_whole_folder_with_its_own_tracks_first(watcher_repair_inventory):
    from music_app.services import problematic_index
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    fixture = watcher_repair_inventory
    paths = _seed_two_album_folder(fixture)
    database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    _ready_problematic_index(database_url)
    problematic_index.wait_for_background_work()
    listed = {item["name"]: item for item in _indexed_problematic_items(database_url, limit=50)
              if MIXED in item["problem_reasons"]}
    assert set(listed) == {"Are You There", "Breathe"}
    repository = PostgresLibraryBrowseRepository({**fixture.config, problematic_index.ENABLED_KEY: "1"})

    for own, other, other_artist in (("Are You There", "Breathe", "Are You There"),
                                     ("Breathe", "Are You There", "Michał Łapaj")):
        detail = repository.build_problematic_file_detail_payload(listed[own]["key"])
        assert {row["path"] for row in detail["track_problem_rows"]} == set(paths[own]), f"{own}: its own rows"
        neighbors = detail["folder_neighbor_rows"]
        assert {row["path"] for row in neighbors} == set(paths[other]), f"{own}: then the folder's other album"
        for row in neighbors:
            assert row["album_title"] == other and MIXED in row["reasons"], "each row keeps its own problems"
            values = {value["label"]: value["value"] for value in row["current_values"]}
            assert values.get("Album artist") == other_artist and values.get("Album") == other
        # The entry's own problems stay the list's: the other album's rows are listed apart.
        reasons = {row["reason"] for row in detail["album_problem_rows"]} | {
            reason for row in detail["track_problem_rows"] for reason in row["reasons"]}
        assert reasons == set(listed[own]["problem_reasons"])
