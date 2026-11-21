"""Exact file locators survive the production projection publication path."""

import json

import pytest

from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
from tests.e2e.support import isolatedPostgres
from tests.py.problematic_projection_support import publish_problematic_fixture
from tests.py.test_problematic_projection_postgres import live_projection_database


@pytest.mark.parametrize("paths", [
    ("/music/A.flac", "/music/a.flac"),
    ("/music/a  b.flac", "/music/a b.flac"),
    ("/music/Ａ.flac", "/music/A.flac"),
])
def test_live_colliding_paths_survive_build_publication_and_detail(live_projection_database, paths):
    fixture = live_projection_database
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        root_id = connection.execute(
            "insert into library.library_roots(library_id, root_path, root_kind) "
            "values (%s, '/music', 'main') returning id",
            (fixture.library_id,),
        ).fetchone()["id"]
        artist_id = connection.execute(
            "insert into library.local_artists(library_id, artist_key, name) "
            "values (%s, 'locator-owner', 'Locator Owner') returning id",
            (fixture.library_id,),
        ).fetchone()["id"]
        album_id = connection.execute(
            "insert into library.local_albums(library_id, artist_id, album_key, title) "
            "values (%s, %s, 'locator-album', 'Locator Album') returning id",
            (fixture.library_id, artist_id),
        ).fetchone()["id"]
        for number, path in enumerate(paths, 1):
            track_id = connection.execute(
                "insert into library.local_tracks(library_id, album_id, artist_id, "
                "track_key, title, track_number, disc_number) "
                "values (%s, %s, %s, %s, %s, %s, 1) returning id",
                (fixture.library_id, album_id, artist_id, f"locator-{number}",
                 f"Track {number}", number),
            ).fetchone()["id"]
            entry = {"path": path, "album": "Locator Album", "album_artist": "Locator Owner",
                     "artist": "Locator Owner", "title": f"Track {number}",
                     "track_number": number, "disc_number": 1}
            connection.execute(
                "insert into library.local_track_files(track_id, private_path, library_root_id, metadata) "
                "values (%s, %s, %s, %s::jsonb)",
                (track_id, path, root_id, json.dumps({"scan_cache": {"file_entry": entry}})),
            )

    repository = PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": fixture.app_url})
    page = publish_problematic_fixture(repository)
    assert len(page["items"]) == 1
    projection_id = page["items"][0]["projection_id"]
    with isolatedPostgres._connect(fixture.app_url) as connection:
        locators = connection.execute(
            "select fact.normalized_text from ops.problematic_projection_search_facts fact "
            "join ops.problematic_projection_state state "
            "on state.library_id = fact.library_id and state.committed_revision = fact.revision "
            "where fact.library_id = %s and fact.item_key = %s "
            "and fact.fact_kind = 'private_path_locator'",
            (fixture.library_id, projection_id),
        ).fetchall()
    assert {row["normalized_text"] for row in locators} == set(paths)
    detail = repository.build_problematic_file_detail_payload(projection_id=projection_id)
    assert detail is not None
    assert {track["path"] for track in detail["tracks"]} == set(paths)
