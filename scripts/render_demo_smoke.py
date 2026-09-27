"""Verify demo provisioning with a disposable CI database and normal ASGI routes."""
import os
from pathlib import Path
import re
import secrets
import sys

from argon2 import PasswordHasher
import psycopg
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_demo

password = secrets.token_urlsafe(32)
settings = {
    "ALBUM_HAVEN_DEMO_DATABASE_URL": "postgresql://demo_owner:isolated-ci-owner@127.0.0.1:5432/album_haven_ci_render_demo",
    "ALBUM_HAVEN_DEMO_DATABASE_HOST": "127.0.0.1",
    "ALBUM_HAVEN_DEMO_APP_DB_PASSWORD": secrets.token_urlsafe(32),
    "ALBUM_HAVEN_DEMO_PASSWORD_HASH": PasswordHasher(time_cost=3, memory_cost=65536, parallelism=1).hash(password),
    "ALBUM_HAVEN_AUTH_HMAC_SECRET": secrets.token_hex(32),
    "ALBUM_HAVEN_PUBLIC_BASE_URL": "https://demo.example.test",
}
os.environ.update(settings)
render_demo.prepare(extended_media=False)
with psycopg.connect(os.environ["ALBUM_HAVEN_APP_DATABASE_URL"]) as connection:
    before = connection.execute("select count(*) from integration.listen_history").fetchone()[0]
    assert before == 8, before
    assert connection.execute("select count(*) from library.local_albums").fetchone()[0] == 8
    assert connection.execute("select count(*) from library.local_tracks").fetchone()[0] == 24
    credential = connection.execute("select encoded_hash from app.account_credentials").fetchone()[0]
    existing_albums = connection.execute("select id, album_key from library.local_albums order by id").fetchall()
    existing_tracks = connection.execute("select id, album_id from library.local_tracks order by id").fetchall()
    account_id = connection.execute("select account_id from app.bootstrap_owners where owner_key='local-bootstrap-owner'").fetchone()[0]
from music_app.services.client_layout_preferences import PostgresClientLayoutPreferences
preferences = PostgresClientLayoutPreferences({"ALBUM_HAVEN_APP_DATABASE_URL": os.environ["ALBUM_HAVEN_APP_DATABASE_URL"]})
preferences.save_changes(account_id=account_id, profile="mobile", changes={"mobileGridColumns": 3})
# Upgrade the original eight-album deployment, then repeat the expanded startup.
# Both passes retain the same existing account, IDs, preferences and listening history.
seeded_loops = None
for _ in range(2):
    os.environ.update(settings)
    render_demo.prepare()
    with psycopg.connect(os.environ["ALBUM_HAVEN_APP_DATABASE_URL"]) as connection:
        assert connection.execute("select count(*) from integration.listen_history").fetchone()[0] == before
        assert connection.execute("select encoded_hash from app.account_credentials").fetchone()[0] == credential
        assert connection.execute("select count(*) from library.local_albums").fetchone()[0] == 39
        assert connection.execute("select count(*) from library.local_tracks").fetchone()[0] == 130
        assert connection.execute("select id, album_key from library.local_albums where id = any(%s) order by id", ([row[0] for row in existing_albums],)).fetchall() == existing_albums
        assert connection.execute("select id, album_id from library.local_tracks where id = any(%s) order by id", ([row[0] for row in existing_tracks],)).fetchall() == existing_tracks
        assert connection.execute("select count(*) from (select album_id from library.local_tracks group by album_id having count(*)=16) albums").fetchone()[0] == 1
        assert connection.execute("select count(*) from library.local_artist_family_links").fetchone()[0] > 0
        assert connection.execute("select current_user").fetchone()[0] == "album_haven_app"
        assert not connection.execute("select has_schema_privilege(current_user,'app','CREATE')").fetchone()[0]
        loops = connection.execute("""select id,loop_key,loop_private_path,start_seconds,end_seconds
            from app.saved_loops where account_id=%s and loop_key like 'mobile-demo-loop-%%'
            order by loop_key""", (account_id,)).fetchall()
        assert len(loops) == 8, len(loops)
        # The owner requested four clips together in one song, not four separate pages.
        four_clip_song = connection.execute("""select count(distinct track_id), count(*)
            from app.saved_loops where account_id=%s and loop_key = any(%s)""",
            (account_id, ['mobile-demo-loop-opening-motif', 'mobile-demo-loop-rhythm-study',
                          'mobile-demo-loop-transition', 'mobile-demo-loop-bridge-study'])).fetchone()
        assert four_clip_song == (1, 4), four_clip_song
        for row in loops:
            media = Path(row[2])
            assert media.is_relative_to(render_demo.DEMO_ROOT / "app-data")
            assert media.is_file() and media.stat().st_size > 0
            assert float(row[4]) > float(row[3]) >= 0
        if seeded_loops is None:
            seeded_loops = loops
        else:
            assert loops == seeded_loops, "Repeated startup changed saved loop identities or ranges"
    assert preferences.load_profiles(account_id=account_id)["mobile"]["mobileGridColumns"] == 3

from music_app import create_asgi_app
with TestClient(create_asgi_app(), base_url=settings["ALBUM_HAVEN_PUBLIC_BASE_URL"]) as client:
    response = client.get("/", follow_redirects=False)
    assert response.status_code in (302, 303, 307), response.status_code
    assert response.headers["location"].startswith("/login")
    page = client.get("/login")
    assert page.status_code == 200
    token = re.search(r'name="csrf_token" value="([^"]+)"', page.text).group(1)
    response = client.post("/login", data={"username":"Rendref", "password":password, "csrf_token":token,"return_to":"/"}, headers={"Origin":settings["ALBUM_HAVEN_PUBLIC_BASE_URL"]}, follow_redirects=False)
    assert response.status_code == 303, (response.status_code, response.text[:200])
    assert "failed" not in response.headers.get("location", ""), response.headers.get("location")
    assert client.get("/account/layout-preferences").status_code == 200
    assert client.get("/").status_code == 200
    for row in seeded_loops:
        clip = client.get("/loops/media/" + row[1])
        assert clip.status_code == 200, clip.status_code
        assert clip.headers.get("content-type", "").startswith("audio/")
        assert len(clip.content) > 0
print("PASS: original 8-album library upgraded to 39 albums/130 tracks, sixteen-track album, family projection, repeated startup, preserved IDs/credentials/history/preferences, restricted DB role, real login, authenticated routes and eight retained playable demo loops including four in one song.")
