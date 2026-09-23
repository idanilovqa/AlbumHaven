"""Live duplicate SQL proof, restricted to an explicitly owned verification DB."""
from pathlib import Path
import uuid

import pytest
from psycopg.types.json import Jsonb

from tests.e2e.support import isolatedPostgres
from tests.py.test_library_source_appearance_live import database
from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository, invalidate_postgres_utility_projection_cache


@pytest.fixture
def inventory(database):
    setup, runtime = database
    prefix = "duplicate-verify-" + uuid.uuid4().hex
    account_id = None
    created_library_id = None
    track_ids = []
    album_ids = []
    artist_id = None
    release_keys = []
    try:
        with isolatedPostgres._connect(setup) as connection:
            owner = connection.execute("select account_id from app.bootstrap_owners where owner_key = 'local-bootstrap-owner'").fetchone()
            if owner is None:
                account_id = connection.execute(
                    "insert into app.accounts(display_name,username_display,username_normalized,contact_email,contact_email_normalized) values(%s,%s,%s,%s,%s) returning id",
                    (prefix, prefix, prefix, prefix + "@example.test", prefix + "@example.test"),
                ).fetchone()["id"]
                connection.execute("insert into app.bootstrap_owners(account_id,owner_key) values(%s,'local-bootstrap-owner')", (account_id,))
                owner_id = account_id
            else:
                owner_id = owner["account_id"]
            library = connection.execute("select id from library.libraries where owner_account_id=%s and name='Local Library' and library_kind='local'", (owner_id,)).fetchone()
            if library is None:
                created_library_id = connection.execute("insert into library.libraries(owner_account_id,name,library_kind) values(%s,'Local Library','local') returning id", (owner_id,)).fetchone()["id"]
                library_id = created_library_id
            else:
                library_id = library["id"]
            artist_name = prefix + " Artist"
            title = prefix + " Album"
            artist_id = connection.execute("insert into library.local_artists(library_id,artist_key,name) values(%s,%s,%s) returning id", (library_id, prefix, artist_name)).fetchone()["id"]
            keys = {}
            paths = {}
            for label, year, count, category in [("main", 2001, 1, "main_library_roots"), ("deluxe", 2001, 2, "hoarding_library_roots"), ("reissue", 2002, 1, "new_arrivals_roots"), ("unknown", None, 1, "hoarding_library_roots")]:
                key = artist_name.lower() + "::" + title.lower() + "::" + label
                keys[label] = key
                metadata = {"album_artist": artist_name, "artists": [artist_name], "edition": label, "local_cover_width": 1000, "local_cover_height": 1000}
                album_id = connection.execute("insert into library.local_albums(library_id,artist_id,album_key,title,release_year,cover_path,metadata) values(%s,%s,%s,%s,%s,%s,%s) returning id", (library_id, artist_id, key, title, year, prefix + "/cover.jpg", Jsonb(metadata))).fetchone()["id"]
                album_ids.append(album_id)
                paths[label] = []
                for number in range(1, count + 1):
                    path = str(Path("C:/multi-root-verification") / prefix / label / f"{number}.flac")
                    paths[label].append(path)
                    track_id = connection.execute("insert into library.local_tracks(library_id,album_id,artist_id,track_key,title,disc_number,track_number,duration_seconds) values(%s,%s,%s,%s,%s,1,%s,%s) returning id", (library_id, album_id, artist_id, key + f"::{number}", f"Track {number}", number, 100 + number)).fetchone()["id"]
                    track_ids.append(track_id)
                    entry = {"path": path, "title": f"Track {number}", "album": title, "album_artist": artist_name, "artist": artist_name, "year": year, "edition": label, "disc_number": 1, "track_number": number, "duration_seconds": 100 + number, "library_root_category": category}
                    connection.execute("insert into library.local_track_files(track_id,private_path,metadata) values(%s,%s,%s)", (track_id, path, Jsonb({"library_root_category": category, "scan_cache": {"file_entry": entry}})))
        def add_track(label, relative_path, *, year=2002, scan_tags=True, category="new_arrivals_roots"):
            path = str(Path(paths["main"][0]).parent / relative_path)
            with isolatedPostgres._connect(setup) as connection:
                album_id = connection.execute("select id from library.local_albums where library_id=%s and album_key=%s", (library_id, keys[label])).fetchone()["id"]
                track_id = connection.execute("insert into library.local_tracks(library_id,album_id,artist_id,track_key,title,disc_number,track_number,duration_seconds) values(%s,%s,%s,%s,'Extra',2,2,120) returning id", (library_id, album_id, artist_id, prefix + "::extra::" + uuid.uuid4().hex)).fetchone()["id"]
                track_ids.append(track_id)
                entry = {"path": path, "title": "Extra", "album": title, "album_artist": artist_name, "artist": artist_name, "year": year, "disc_number": 2, "track_number": 2, "library_root_category": category}
                connection.execute("insert into library.local_track_files(track_id,private_path,metadata) values(%s,%s,%s)", (track_id, path, Jsonb({"library_root_category": category, "scan_cache": {"file_entry": entry}} if scan_tags else {})))
            return path

        def separate(label):
            with isolatedPostgres._connect(setup) as connection:
                connection.execute("insert into library.separate_releases(library_id,release_key) values(%s,%s)", (library_id, keys[label]))
            release_keys.append(keys[label])

        # Direct fixture SQL does not emit the application's inventory invalidation.
        invalidate_postgres_utility_projection_cache(database_url=runtime)
        yield PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": runtime}), keys, paths, add_track, separate
    finally:
        with isolatedPostgres._connect(setup) as connection:
            connection.execute("delete from library.separate_releases where release_key = any(%s)", (release_keys,))
            connection.execute("delete from library.local_tracks where id = any(%s)", (track_ids,))
            connection.execute("delete from library.local_albums where id = any(%s)", (album_ids,))
            if artist_id is not None:
                connection.execute("delete from library.local_artists where id=%s", (artist_id,))
            if created_library_id is not None:
                connection.execute("delete from library.libraries where id=%s", (created_library_id,))
            if account_id is not None:
                connection.execute("delete from app.accounts where id=%s", (account_id,))
        invalidate_postgres_utility_projection_cache(database_url=runtime)


def test_live_duplicate_candidates_details_and_problematic_projection_agree(inventory):
    repository, keys, paths, _add_track, _separate = inventory
    summaries = {item["key"]: item for item in repository.build_problematic_files_payload()["items"]}
    for label in ("main", "deluxe"):
        assert "Duplicate files" in summaries[keys[label]]["problem_reasons"]
        detail = repository.build_album_detail_payload(keys[label])
        assert detail["has_duplicate_files"] is True
        assert sorted(source["track_count"] for source in detail["duplicate_sources"]) == [1, 2]
        assert {track["path"] for track in detail["tracks"]} == set(paths[label])
        problem = repository.build_problematic_file_detail_payload(keys[label])
        assert "Duplicate files" in problem["problem_reasons"]
        assert len(problem["duplicate_sources"]) == 2
    for label in ("reissue", "unknown"):
        detail = repository.build_album_detail_payload(keys[label])
        assert detail["has_duplicate_files"] is False
        assert "Duplicate files" not in summaries.get(keys[label], {}).get("problem_reasons", [])


@pytest.mark.parametrize("scan_tags", [False, True])
def test_candidate_container_includes_unknown_or_conflicting_multidisc_row(inventory, scan_tags):
    repository, keys, _paths, add_track, _separate = inventory
    add_track("reissue", "Disc 2/conflict.flac", year=2002, scan_tags=scan_tags)
    for label in ("main", "deluxe"):
        assert repository.build_album_detail_payload(keys[label])["has_duplicate_files"] is False
    summaries = {item["key"]: item for item in repository.build_problematic_files_payload()["items"]}
    for label in ("main", "deluxe"):
        assert "Duplicate files" not in summaries.get(keys[label], {}).get("problem_reasons", [])


def test_separated_release_lookup_scopes_duplicate_sources_to_displayed_year(inventory):
    repository, keys, _paths, add_track, separate = inventory
    new_paths = {
        add_track("main", "../release-2002-a/one.flac", year=2002),
        add_track("main", "../release-2002-b/one.flac", year=2002),
    }
    separate("main")
    detail = repository.build_album_detail_payload(keys["main"] + "::year::2002")
    assert detail is not None
    assert detail["has_duplicate_files"] is True
    assert len(detail["duplicate_sources"]) == 3  # Includes the existing 2002 reissue.
    assert all(track["year"] == 2002 for source in detail["duplicate_sources"] for track in source["tracks"])
    assert {track["path"] for track in detail["tracks"]} <= new_paths
    problem = repository.build_problematic_file_detail_payload(keys["main"] + "::year::2002")
    assert "Duplicate files" in problem["problem_reasons"]
    assert all(track["year"] == 2002 for source in problem["duplicate_sources"] for track in source["tracks"])


def test_separated_release_provenance_uses_only_displayed_year(inventory):
    repository, keys, _paths, add_track, separate = inventory
    add_track("main", "../release-2002-copy/one.flac", year=2002, category="new_arrivals_roots")
    add_track("main", "../release-2003-only/one.flac", year=2003, category="hoarding_library_roots")
    separate("main")
    old = repository.build_album_detail_payload(keys["main"] + "::year::2001")
    new = repository.build_album_detail_payload(keys["main"] + "::year::2002")
    assert set(old["root_provenance"]["categories"]) == {"main_library", "hoard"}
    assert set(new["root_provenance"]["categories"]) == {"new_arrivals"}
    solo = repository.build_album_detail_payload(keys["main"] + "::year::2003")
    assert solo["has_duplicate_files"] is False
    assert set(solo["root_provenance"]["categories"]) == {"hoard"}
    problem = repository.build_problematic_file_detail_payload(keys["main"] + "::year::2001")
    assert set(problem["root_provenance"]["categories"]) == {"main_library", "hoard"}


def test_candidate_year_matching_is_symmetric_across_catalogue_years(inventory):
    repository, keys, paths, add_track, _separate = inventory
    path = add_track("reissue", "../reissue-2001-copy/one.flac", year=2001)
    for label in ("main", "reissue"):
        detail = repository.build_album_detail_payload(keys[label])
        found = {track["path"] for source in detail["duplicate_sources"] for track in source["tracks"]}
        assert set(paths["main"]) | set(paths["deluxe"]) | {path} <= found
    problems = {item["key"]: item for item in repository.build_problematic_files_payload()["items"]}
    assert all("Duplicate files" in problems[keys[label]]["problem_reasons"] for label in ("main", "reissue"))
