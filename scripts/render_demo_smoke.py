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
render_demo.prepare()
with psycopg.connect(os.environ["ALBUM_HAVEN_APP_DATABASE_URL"]) as connection:
    before = connection.execute("select count(*) from integration.listen_history").fetchone()[0]
    assert before == 8, before
    assert connection.execute("select count(*) from library.local_albums").fetchone()[0] == 8
    assert connection.execute("select count(*) from library.local_tracks").fetchone()[0] == 24
    credential = connection.execute("select encoded_hash from app.account_credentials").fetchone()[0]
os.environ.update(settings)
render_demo.prepare()
with psycopg.connect(os.environ["ALBUM_HAVEN_APP_DATABASE_URL"]) as connection:
    assert connection.execute("select count(*) from integration.listen_history").fetchone()[0] == before
    assert connection.execute("select encoded_hash from app.account_credentials").fetchone()[0] == credential
    assert connection.execute("select current_user").fetchone()[0] == "album_haven_app"
    assert not connection.execute("select has_schema_privilege(current_user,'app','CREATE')").fetchone()[0]

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
print("PASS: 8 albums, 24 tracks, idempotent startup, preserved credentials/history, restricted DB role, real login and authenticated routes.")
