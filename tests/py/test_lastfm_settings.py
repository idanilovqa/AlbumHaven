from __future__ import annotations

import pytest

from music_app.services import lastfm
from music_app.services.lastfm_postgres import _upsert_lastfm_session_sql
from music_app.services.lastfm import (
    clear_lastfm_settings,
    load_lastfm_settings,
    save_lastfm_settings,
    save_lastfm_user_timezone,
)


@pytest.fixture
def fake_lastfm_settings_adapter(monkeypatch):
    stored: dict[str, object] = {}

    class PostgresSelection:
        effective_backend = "postgres"

    class FakeLastfmSettingsAdapter:
        def __init__(self, _config):
            pass

        def load_settings(self):
            return dict(stored)

        def save_settings(self, settings):
            stored.clear()
            stored.update(settings)
            return settings

    monkeypatch.setattr(
        lastfm,
        "select_runtime_persistence_adapter",
        lambda seam_id, config: PostgresSelection(),
    )
    monkeypatch.setattr(lastfm, "LastfmPostgresAdapter", FakeLastfmSettingsAdapter)
    return stored


def test_lastfm_settings_runtime_rejects_non_postgres_selection(tmp_path, monkeypatch):
    config = {"DATA_DIR": tmp_path}

    class FileSelection:
        effective_backend = "file"

    monkeypatch.setattr(
        lastfm,
        "select_runtime_persistence_adapter",
        lambda seam_id, config: FileSelection(),
    )

    with pytest.raises(ValueError, match="Postgres-only"):
        load_lastfm_settings(config)

    with pytest.raises(ValueError, match="Postgres-only"):
        save_lastfm_settings(config, {"user_timezone": "America/Denver"})


def test_save_lastfm_user_timezone_preserves_existing_session(tmp_path, fake_lastfm_settings_adapter):
    config = {"DATA_DIR": tmp_path, "LASTFM_API_ENABLED": True}
    save_lastfm_settings(
        config,
        {
            "username": "scrobbler",
            "session_key": "abc123",
            "connected_at": "2026-05-13T12:00:00+00:00",
        },
    )

    status = save_lastfm_user_timezone(config, "America/Denver")

    assert status["connected"] is True
    assert load_lastfm_settings(config) == {
        "username": "scrobbler",
        "session_key": "abc123",
        "connected_at": "2026-05-13T12:00:00+00:00",
        "user_timezone": "America/Denver",
    }


def test_build_lastfm_status_loads_settings_once_and_preserves_session_timezone(monkeypatch):
    config = {"LASTFM_API_ENABLED": True}
    load_calls: list[object] = []

    def fake_load_lastfm_settings(received_config):
        load_calls.append(received_config)
        return {
            "username": "demo-user",
            "session_key": "session-key",
            "connected_at": "2026-07-13T20:15:00+00:00",
            "user_timezone": "America/Denver",
        }

    monkeypatch.setattr(lastfm, "load_lastfm_settings", fake_load_lastfm_settings)

    status = lastfm.build_lastfm_status(config)

    assert load_calls == [config]
    assert status == {
        "key": "lastfm",
        "title": "Last.FM",
        "description": "Connect your LastFM account to scrobble and import your listening history",
        "api_configured": True,
        "connected": True,
        "username": "demo-user",
        "connected_at": "2026-07-13T20:15:00+00:00",
        "user_timezone": "America/Denver",
    }


def test_clear_lastfm_settings_preserves_valid_timezone(tmp_path, fake_lastfm_settings_adapter):
    config = {"DATA_DIR": tmp_path}
    save_lastfm_settings(
        config,
        {
            "username": "scrobbler",
            "session_key": "abc123",
            "connected_at": "2026-05-13T12:00:00+00:00",
            "user_timezone": "America/Denver",
        },
    )

    clear_lastfm_settings(config)

    assert load_lastfm_settings(config) == {"user_timezone": "America/Denver"}


def test_authenticate_lastfm_persists_session_and_timezone(
    tmp_path,
    monkeypatch,
    fake_lastfm_settings_adapter,
):
    config = {
        "DATA_DIR": tmp_path,
        "LASTFM_API_KEY": "key",
        "LASTFM_API_SECRET": "secret",
        "LASTFM_API_ROOT": "https://last.example/",
        "LASTFM_API_ENABLED": True,
    }

    class SessionNode:
        def findtext(self, name, default=""):
            return {"name": "demo-user", "key": "session-key"}.get(name, default)

    class Root:
        def find(self, name):
            return SessionNode() if name == "session" else None

    monkeypatch.setattr(lastfm, "_post_lastfm", lambda config, method, params: Root())

    status = lastfm.authenticate_lastfm(
        config,
        "demo-user",
        "demo-pass",
        connected_at="2026-05-13T12:00:00+00:00",
        user_timezone="America/Denver",
    )

    assert status["connected"] is True
    assert load_lastfm_settings(config) == {
        "username": "demo-user",
        "session_key": "session-key",
        "connected_at": "2026-05-13T12:00:00+00:00",
        "user_timezone": "America/Denver",
    }


def test_selected_postgres_lastfm_settings_leaves_stale_json_untouched(tmp_path, monkeypatch):
    config = {
        "DATA_DIR": tmp_path,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"lastfm_settings": "postgres"},
        "LASTFM_API_ENABLED": True,
    }
    settings_path = tmp_path / "lastfm_settings.json"
    settings_path.write_text('{"username":"stale","session_key":"old"}', encoding="utf-8")
    stored = {
        "username": "db-user",
        "session_key": "db-session",
        "connected_at": "2026-07-02T10:00:00+00:00",
    }

    class FakeLastfmSettingsAdapter:
        def __init__(self, _config):
            pass

        def load_settings(self):
            return dict(stored)

        def save_settings(self, settings):
            stored.clear()
            stored.update(settings)
            return settings

    class FakePsycopg:
        def connect(self):
            raise AssertionError("sentinel test should use the fake adapter")

    monkeypatch.setattr("music_app.services.lastfm_postgres.psycopg", FakePsycopg())
    monkeypatch.setattr(lastfm, "LastfmPostgresAdapter", FakeLastfmSettingsAdapter)

    status = save_lastfm_user_timezone(config, "America/Denver")

    assert status["connected"] is True
    assert load_lastfm_settings(config) == {
        "username": "db-user",
        "session_key": "db-session",
        "connected_at": "2026-07-02T10:00:00+00:00",
        "user_timezone": "America/Denver",
    }
    assert settings_path.read_text(encoding="utf-8") == '{"username":"stale","session_key":"old"}'


def test_postgres_lastfm_session_upsert_uses_stable_account_username_identity():
    sql = _upsert_lastfm_session_sql()

    assert "on conflict (account_id, provider_username)" in sql
    assert "where is_active" not in sql
    assert "is_active = true" in sql


def test_postgres_lastfm_save_stores_session_key_only_in_session_column(monkeypatch):
    from music_app.services import lastfm_postgres

    operations = []

    class Cursor:
        def fetchone(self):
            return {"bootstrap_context_ready": 1}

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, sql, params=None):
            operations.append((sql, params))
            return Cursor()

    monkeypatch.setattr(lastfm_postgres, "_jsonb", lambda value: value)
    adapter = lastfm_postgres.LastfmPostgresAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://pytest@localhost/pytest_lastfm_settings"},
        connect=lambda _url: Connection(),
    )

    adapter.save_settings(
        {
            "username": "listener",
            "session_key": "session-secret",
            "connected_at": "2026-07-14T00:00:00+00:00",
            "user_timezone": "America/Denver",
        }
    )

    settings_params = next(params for sql, params in operations if "insert into integration.lastfm_settings" in sql)
    session_params = next(params for sql, params in operations if "insert into integration.lastfm_sessions" in sql)
    assert "session_key" not in settings_params[2]["settings_payload"]
    assert session_params[1] == "session-secret"
    assert "session_key" not in session_params[2]["source_payload"]
