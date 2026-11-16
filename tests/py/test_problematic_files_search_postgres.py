"""Problematic Files search reaches every album, not only the first page."""
import os
from uuid import uuid4

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_postgres_structural_tag_edit import _isolated_runtime_database_url_or_skip

# Mojibake (Cyrillic read as cp1251-in-UTF-8) makes every seeded album problematic.
_MOJIBAKE_TITLE = "Р“Р°РјРјР°"


def _seed_problematic_albums(count):
    import psycopg

    database_url = _isolated_runtime_database_url_or_skip()
    setup_url = os.environ.get("ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL", "")
    if not setup_url:
        pytest.skip("An isolated migrator URL is required.")
    isolatedPostgres.prepare_isolated_database(setup_url, database_url)
    token = uuid4().hex[:12]
    with psycopg.connect(database_url) as connection:
        library_id = connection.execute("""select libraries.id from app.bootstrap_owners owners
            join library.libraries on libraries.owner_account_id=owners.account_id
            where owners.owner_key='local-bootstrap-owner' and libraries.name='Local Library'
              and libraries.library_kind='local'""").fetchone()[0]
        root_id = connection.execute("""insert into library.library_roots(library_id,root_path,root_kind)
            values(%s,%s,'main_library') returning id""", (library_id, f"C:/pf-search/{token}")).fetchone()[0]
        artist_id = connection.execute("""insert into library.local_artists(library_id,artist_key,name)
            values(%s,%s,%s) returning id""", (library_id, token, f"Artist {token}")).fetchone()[0]
        for index in range(count):
            title = f"{_MOJIBAKE_TITLE} {index:03d}"
            album_id = connection.execute("""insert into library.local_albums(library_id,artist_id,album_key,title)
                values(%s,%s,%s,%s) returning id""", (library_id, artist_id, f"{token}::{index:03d}", title)).fetchone()[0]
            track_title = "Needle Track" if index == count - 1 else f"Track {index:03d}"
            track_id = connection.execute("""insert into library.local_tracks(library_id,album_id,artist_id,track_key,title)
                values(%s,%s,%s,%s,%s) returning id""",
                (library_id, album_id, artist_id, f"{token}-{index}", track_title)).fetchone()[0]
            connection.execute("""insert into library.local_track_files(track_id,library_root_id,private_path,relative_path)
                values(%s,%s,%s,%s)""",
                (track_id, root_id, f"C:/pf-search/{token}/{index:03d}/01.flac", f"{index:03d}/01.flac"))
        connection.commit()
    return database_url


def test_search_finds_a_problematic_album_beyond_the_first_page():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    database_url = _seed_problematic_albums(60)
    repository = PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": database_url})
    first_page_keys = {item["key"] for item in repository.build_problematic_files_page(limit=50)["items"]}

    by_track = repository.build_problematic_files_search("needle track")
    by_album = repository.build_problematic_files_search(f"{_MOJIBAKE_TITLE} 059")

    assert len(first_page_keys) == 50
    assert len(by_track["items"]) == 1
    assert by_track["items"][0]["key"].endswith("::059")
    assert by_track["items"][0]["key"] not in first_page_keys
    assert [item["key"] for item in by_album["items"]] == [item["key"] for item in by_track["items"]]
    assert by_track["projection_cache_status"] == "search"
    # The search answer equals the complete list filtered by the same text.
    complete = repository.build_problematic_files_payload()
    assert [item["key"] for item in complete["items"] if "Needle Track" in item.get("search_text", "")] \
        == [item["key"] for item in by_track["items"]]


def test_a_restarted_server_answers_the_first_page_from_the_stored_last_list():
    """Migration 0117 keeps the last complete list; a cold process reads it
    instead of the ~5 s whole-library candidate pass."""
    import json

    from music_app.services import library_browse_postgres as browse

    import psycopg

    database_url = _seed_problematic_albums(8)
    writer = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": database_url})
    complete = writer._build_problematic_files_payload_uncached()
    fingerprint = complete.pop(browse._SNAPSHOT_FINGERPRINT_KEY)
    writer._store_problematic_files_snapshot(json.dumps({
        **complete,
        browse._SNAPSHOT_FINGERPRINT_KEY: fingerprint,
        browse._PROBLEMATIC_SNAPSHOT_VERSION_KEY: browse._PROBLEMATIC_SNAPSHOT_VERSION,
    }, default=str))
    cache_key = (database_url, "problematic-files")

    def restart_and_open_first_page():
        # A "restart": nothing in memory for this database.
        for registry in (browse._UTILITY_PROJECTION_CACHE, browse._UTILITY_PROJECTION_STALE):
            registry.pop(cache_key, None)
        browse._PROBLEMATIC_SNAPSHOT_CHECKED.discard(cache_key)
        return browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": database_url}) \
            .build_problematic_files_page(limit=5)

    page = restart_and_open_first_page()
    assert page["projection_cache_status"] == "stale"
    assert [item["key"] for item in page["items"]] == [item["key"] for item in complete["items"][:5]]
    assert browse._SNAPSHOT_FINGERPRINT_KEY not in page

    # Any later library change (a tag edit bumps the inventory revision) makes
    # the stored full list unusable; only its first-page keys may be revalidated.
    with psycopg.connect(database_url) as connection:
        connection.execute("""update library.libraries set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb),
            '{inventory_mutation_revision}', to_jsonb(coalesce((metadata ->> 'inventory_mutation_revision')::bigint, 0) + 1))
            where library_kind = 'local' and name = 'Local Library'""")
        connection.commit()
    assert restart_and_open_first_page()["projection_cache_status"] == "revalidated"
    browse._UTILITY_PROJECTION_STALE.pop(cache_key, None)


def test_an_outdated_stored_list_is_replaced_in_the_background_without_prewarm():
    """Prewarm is off by default: a stale first page an open tab asks for starts one
    complete rebuild, so an album that became problematic after the stored list
    appears. A background reload (after a tag edit) never starts one."""
    import json
    import time

    from music_app.services import library_browse_postgres as browse

    import psycopg

    database_url = _seed_problematic_albums(3)
    writer = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": database_url})
    complete = writer._build_problematic_files_payload_uncached()
    fingerprint = complete.pop(browse._SNAPSHOT_FINGERPRINT_KEY)
    writer._store_problematic_files_snapshot(json.dumps({
        **complete,
        browse._SNAPSHOT_FINGERPRINT_KEY: fingerprint,
        browse._PROBLEMATIC_SNAPSHOT_VERSION_KEY: browse._PROBLEMATIC_SNAPSHOT_VERSION,
    }, default=str))
    with psycopg.connect(database_url) as connection:
        library_id, artist_id, root_id = connection.execute("""select albums.library_id, albums.artist_id, files.library_root_id
            from library.local_albums albums join library.local_tracks tracks on tracks.album_id = albums.id
            join library.local_track_files files on files.track_id = tracks.id limit 1""").fetchone()
        token = uuid4().hex[:12]
        album_id = connection.execute("""insert into library.local_albums(library_id,artist_id,album_key,title)
            values(%s,%s,%s,%s) returning id""", (library_id, artist_id, f"{token}::late", f"{_MOJIBAKE_TITLE} Late")).fetchone()[0]
        track_id = connection.execute("""insert into library.local_tracks(library_id,album_id,artist_id,track_key,title)
            values(%s,%s,%s,%s,%s) returning id""", (library_id, album_id, artist_id, f"{token}-late", "Late Track")).fetchone()[0]
        connection.execute("""insert into library.local_track_files(track_id,library_root_id,private_path,relative_path)
            values(%s,%s,%s,%s)""", (track_id, root_id, f"C:/pf-search/{token}/late/01.flac", "late/01.flac"))
        connection.commit()
    cache_key = (database_url, "problematic-files")
    for registry in (browse._UTILITY_PROJECTION_CACHE, browse._UTILITY_PROJECTION_STALE):
        registry.pop(cache_key, None)
    browse._PROBLEMATIC_SNAPSHOT_CHECKED.discard(cache_key)
    revision = browse.problematic_files_complete_list_revision()
    repository = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": database_url})
    assert repository._allow_background_prewarm is False

    background = repository.build_problematic_files_page(limit=50)
    time.sleep(0.5)
    assert background["projection_cache_status"] in {"stale", "revalidated"}
    assert browse._UTILITY_PROJECTION_CACHE.get(cache_key) is None, "a background reload rebuilt the list"
    assert cache_key not in browse._UTILITY_PROJECTION_PREWARM_INFLIGHT

    started = time.perf_counter()
    page = repository.build_problematic_files_page(limit=50, rebuild_outdated=True)
    search = repository.build_problematic_files_search("late track", rebuild_outdated=True)

    assert page["projection_cache_status"] in {"stale", "revalidated"}
    assert f"{token}::late" not in {item["key"] for item in page["items"]}
    deadline = time.monotonic() + 30
    while browse._UTILITY_PROJECTION_CACHE.get(cache_key) is None and time.monotonic() < deadline:
        time.sleep(0.05)
    rebuilt = browse._UTILITY_PROJECTION_CACHE.get(cache_key)
    assert rebuilt is not None, "the outdated list was never replaced"
    assert f"{token}::late" in {item["key"] for item in rebuilt["items"]}
    assert browse.problematic_files_complete_list_revision() > revision
    assert search["projection_cache_status"] in {"stale", "search"}
    fresh = repository.build_problematic_files_search("late track")
    assert [item["key"] for item in fresh["items"]] == [f"{token}::late"]
    assert fresh["projection_cache_status"] == "hit"
    assert repository.build_problematic_files_page(limit=50)["projection_cache_status"] == "bounded"
    assert time.perf_counter() - started < 30
    browse._UTILITY_PROJECTION_CACHE.pop(cache_key, None)
