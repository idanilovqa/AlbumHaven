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
    _drain_background_work()
    browse._UTILITY_PROJECTION_STALE.pop(cache_key, None)


def _bump_inventory_revision(connection):
    connection.execute("""update library.libraries set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb),
        '{inventory_mutation_revision}', to_jsonb(coalesce((metadata ->> 'inventory_mutation_revision')::bigint, 0) + 1))
        where library_kind = 'local' and name = 'Local Library'""")


def _drain_background_work():
    from music_app.services import library_browse_postgres as browse

    # A refresh queues its snapshot store behind itself on the same single worker.
    for _ in range(3):
        browse._UTILITY_PROJECTION_PREWARM_EXECUTOR.submit(lambda: None).result(timeout=120)


def test_a_restarted_server_answers_the_first_page_from_the_stored_first_page(monkeypatch):
    """sandbox2 (11-18): the complete list is no longer built, so nothing was stored and
    every restart paid the 22-55 s whole-library candidate query for the first page."""
    from music_app.services import library_browse_postgres as browse

    import psycopg

    database_url = _seed_problematic_albums(8)
    _drain_background_work()
    page_key = (database_url, browse._PROBLEMATIC_FILES_PAGE_KIND)

    def restart_and_open_first_page(*, candidate_query_allowed):
        for registry in (browse._UTILITY_PROJECTION_CACHE, browse._UTILITY_PROJECTION_STALE):
            registry.pop(page_key, None)
            registry.pop((database_url, "problematic-files"), None)
        browse._PROBLEMATIC_SNAPSHOT_CHECKED.discard((database_url, "problematic-files"))
        repository = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": database_url})
        if not candidate_query_allowed:
            monkeypatch.setattr(repository, "_load_problematic_candidate_ids",
                                lambda **_options: pytest.fail("the whole-library candidate query must not run"))
        return repository.build_problematic_files_page(limit=5)

    with psycopg.connect(database_url) as connection:
        connection.execute("delete from library.problematic_files_snapshots")
        connection.commit()
    fresh = restart_and_open_first_page(candidate_query_allowed=True)
    _drain_background_work()
    reader = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": database_url})
    assert fresh["projection_cache_status"] == "bounded"
    assert reader._load_problematic_files_snapshot() is None, "A first page is never served as the complete list."
    assert reader._load_problematic_files_snapshot(allow_outdated=True) is None, "Search never reads a first page."

    unchanged = restart_and_open_first_page(candidate_query_allowed=False)
    assert unchanged["projection_cache_status"] == "revalidated"
    assert [item["key"] for item in unchanged["items"]] == [item["key"] for item in fresh["items"]]
    assert unchanged["has_more"]

    # While the server was down, a new album sorting first became problematic.
    with psycopg.connect(database_url) as connection:
        album = connection.execute("""select library_id, artist_id from library.local_albums
            where album_key = %s""", (fresh["items"][0]["key"],)).fetchone()
        root_id = connection.execute("select id from library.library_roots where library_id = %s limit 1",
                                     (album[0],)).fetchone()[0]
        token = uuid4().hex[:12]
        album_id = connection.execute("""insert into library.local_albums(library_id,artist_id,album_key,title)
            values(%s,%s,%s,%s) returning id""", (*album, f"{token}::new", f"{_MOJIBAKE_TITLE} -01")).fetchone()[0]
        track_id = connection.execute("""insert into library.local_tracks(library_id,album_id,artist_id,track_key,title)
            values(%s,%s,%s,%s,'New') returning id""", (album[0], album_id, album[1], token)).fetchone()[0]
        connection.execute("""insert into library.local_track_files(track_id,library_root_id,private_path,relative_path)
            values(%s,%s,%s,%s)""", (track_id, root_id, f"C:/pf-search/{token}/new/01.flac", "new/01.flac"))
        _bump_inventory_revision(connection)
        connection.commit()

    outdated = restart_and_open_first_page(candidate_query_allowed=True)
    assert outdated["projection_cache_status"] == "revalidated"
    assert f"{token}::new" not in [item["key"] for item in outdated["items"]]
    _drain_background_work()
    refreshed = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": database_url}) \
        .build_problematic_files_page(limit=5)
    assert refreshed["items"][0]["key"] == f"{token}::new", "The background refresh adds what the snapshot missed."
    assert restart_and_open_first_page(candidate_query_allowed=False)["items"][0]["key"] == f"{token}::new"
    _drain_background_work()
