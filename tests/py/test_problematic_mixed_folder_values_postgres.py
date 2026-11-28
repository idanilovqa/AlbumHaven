"""Owner (2026-11-25): a "Mixed album metadata in one folder" row says what is mixed. Its current values are
the fields that differ across its folder, read by folder for the opened entry, never across the library.

Synthetic layout on a throwaway database only: one folder holding two complete albums."""
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401
from tests.py.test_problematic_albums import _indexed_problematic_items, _ready_problematic_index

MIXED = "Mixed album metadata in one folder"


def test_live_a_mixed_folder_row_names_the_fields_that_differ_across_its_folder(watcher_repair_inventory):
    from music_app.services import problematic_index
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    fixture = watcher_repair_inventory
    entries = []
    for album, year in (("Soundtrack A", 2026), ("Soundtrack B", 2025)):
        for number in (1, 2):
            entry = fixture.entry(f"Owner/Soundtracks/{album[-1]}-{number:02d}.flac", album=album)
            entry.update(title=f"{album} theme {number}", track_number=number, year=year)
            entries.append(entry)
    fixture.seed(*entries)
    database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    _ready_problematic_index(database_url)
    problematic_index.wait_for_background_work()
    entry = next(item for item in _indexed_problematic_items(database_url, limit=50)
                 if item["name"] == "Soundtrack A" and MIXED in item["problem_reasons"])

    detail = PostgresLibraryBrowseRepository({**fixture.config, problematic_index.ENABLED_KEY: "1"}) \
        .build_problematic_file_detail_payload(entry["key"])

    mixed_rows = [row for row in detail["track_problem_rows"] if MIXED in row["reasons"]]
    assert len(mixed_rows) == 2
    for row in mixed_rows:
        # The album artist is the same across the folder; the album and the year differ.
        assert [(value["label"], value["value"]) for value in row["current_values"]
                if value["field"] in ("album_artist", "album", "year")] == [("Album", "Soundtrack A"), ("Year", 2026)]
