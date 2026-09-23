"""Album projections must omit all known Loose Tracks exception types."""
import pytest
from psycopg.types.json import Jsonb

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory


@pytest.mark.parametrize("source, exception", [
    ("stored", "Interview"), ("stored", " non album rarity "),
    ("path_override", "INTERVIEW"), ("track_override", "Interview"),
    ("clear_null", "Interview"), ("clear_empty", "Interview"),
    ("stored", "Unknown exception"), ("path_override", "Unknown exception"),
])
def test_live_album_projections_keep_exceptions_only_in_loose_tracks(watcher_repair_inventory, source, exception):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
    fixture = watcher_repair_inventory
    excluded = fixture.entry("Owner/Interview/interview.flac", album="Interview Album", exception=None)
    normal = fixture.entry("Owner/Normal/song.flac", album="Normal Album")
    mixed_normal = fixture.entry("Owner/Mixed/song.flac", album="Mixed Album")
    mixed_interview = fixture.entry("Owner/Mixed/interview.flac", album="Mixed Album", exception=None)
    fixture.seed(excluded, normal, mixed_normal, mixed_interview)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("update library.local_track_files set metadata = jsonb_set(metadata, '{scan_cache,file_entry,exception_type}', %s::jsonb) where private_path = %s", (Jsonb("Interview"), mixed_interview["path"]))
        if source in {"stored", "clear_null", "clear_empty"}:
            connection.execute("update library.local_track_files set metadata = jsonb_set(metadata, '{scan_cache,file_entry,exception_type}', %s::jsonb) where private_path = %s", (Jsonb(exception), excluded["path"]))
    if source != "stored":
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            track_id = connection.execute("select id from library.local_tracks where track_key = %s", (excluded["path"],)).fetchone()["id"]
            value = None if source == "clear_null" else "" if source == "clear_empty" else exception
            connection.execute("""insert into library.exception_overrides(library_id, track_key, track_id, override_payload)
                select library_id, %s, %s::bigint, %s::jsonb from library.local_tracks where id = %s""",
                ("owned-track-override" if source == "track_override" else excluded["path"], track_id if source == "track_override" else None, Jsonb({"exception_type": value}), track_id))
    repository = PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    state = {"visible_library_categories": ["main_library", "new_arrivals", "hoard"]}
    ordinary_exception = source in {"clear_null", "clear_empty"} or exception == "Unknown exception"
    expected = {"owner::normal album", "owner::mixed album"} | ({"owner::interview album"} if ordinary_exception else set())
    startup_sidebar, startup_rows = repository._load_root_startup_rows(state, {})
    for rows in (startup_sidebar, repository._load_root_sidebar_rows(state)):
        assert sum(row["album_count"] for row in rows) == len(expected)
    surfaces = {
        "root": repository._load_root_album_browse_rows(state),
        "startup": startup_rows,
        "selected": repository._load_selected_artist_preview_rows(["Owner"], state),
        "family": repository._load_artist_preview_rows(["Owner"], state),
        "search": repository._load_search_rows("Owner", state),
    }
    errors = []
    for name, rows in surfaces.items():
        actual = {row["album_key"] for row in rows}
        if actual != expected:
            errors.append(f"{name}: {actual} != {expected}")
        mixed = [row for row in rows if row["album_key"] == "owner::mixed album"]
        for row in mixed:
            if "track_count" in row and row["track_count"] != 1:
                errors.append(f"{name}: mixed track_count={row['track_count']}")
    assert not errors, "\n".join(errors)
    loose = repository._load_non_album_entries(view_state=state, alias_to_canonical={}, canonical_to_aliases={})
    assert any(entry.get("path") == mixed_interview["path"] for entry in loose), ([(entry.get("album"), entry.get("exception_type")) for entry in loose], errors)
    assert any(entry.get("path") == excluded["path"] for entry in loose) is (source not in {"clear_null", "clear_empty"} and not (source == "stored" and exception == "Unknown exception"))
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("update library.local_track_files set metadata=jsonb_set(metadata, '{scan_cache,stale}', 'true'::jsonb)")
        assert connection.execute("select bool_and(scan_cache_stale) as stale from library.local_track_files").fetchone()["stale"] is True
    missing = {row["album_key"] for row in repository._load_missing_album_rows()}
    if missing != expected:
        errors.append(f"missing: {missing} != {expected}")
    assert not errors, "\n".join(errors)
