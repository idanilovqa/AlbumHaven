from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from music_app.services.track_preferences import (
    build_track_preference_overlay_lookup,
    load_track_preferences_store,
    normalize_track_preferences_store,
    save_track_preference,
    save_track_preferences_store,
)
from music_app.services.track_preferences_postgres import (
    PostgresTrackPreferencesStore,
    is_track_preferences_postgres_available,
)


class _FakeCursor:
    def __init__(self, rows=None):
        self._rows = list(rows or [])

    def fetchone(self):
        if not self._rows:
            return None
        return self._rows[0]

    def fetchall(self):
        return list(self._rows)


class _FakeConnection:
    def __init__(self, *, rows=None, bootstrap_ready=True, upsert_returns=True):
        self.rows = list(rows or [])
        self.bootstrap_ready = bootstrap_ready
        self.upsert_returns = upsert_returns
        self.operations: list[dict[str, object]] = []
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.closed = True
        return False

    def execute(self, sql, params=None):
        self.operations.append({"sql": str(sql), "params": params})
        if "bootstrap_context_ready" in str(sql).lower():
            return _FakeCursor([{"bootstrap_context_ready": 1}] if self.bootstrap_ready else [])
        if "insert into app.track_preferences" in str(sql).lower():
            return _FakeCursor([{"saved": 1}] if self.upsert_returns else [])
        if "from app.track_preferences" in str(sql).lower():
            return _FakeCursor(self.rows)
        return _FakeCursor()


def test_track_preferences_store_missing_and_malformed_behavior(tmp_path):
    config = {"DATA_DIR": tmp_path}

    assert not (tmp_path / "track_preferences.json").exists()
    with pytest.raises(ValueError, match="Postgres runtime persistence adapter is unavailable"):
        load_track_preferences_store(config)

    (tmp_path / "track_preferences.json").write_text("{not-json", encoding="utf-8")
    with pytest.raises(ValueError, match="Postgres runtime persistence adapter is unavailable"):
        load_track_preferences_store(config)


def test_track_preferences_store_rejects_legacy_file_selection_without_reading_json(
    tmp_path,
    monkeypatch,
):
    (tmp_path / "track_preferences.json").write_text(
        json.dumps(
            {
                "version": 1,
                "actors": {
                    "local": {
                        "track_preferences": {
                            "C:/Music/stale.mp3": {"rating": 5, "love_tier": "obsessed"},
                        },
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "music_app.services.track_preferences.select_runtime_persistence_adapter",
        lambda seam_id, config: SimpleNamespace(effective_backend="file"),
    )

    with pytest.raises(RuntimeError, match="Postgres-only"):
        load_track_preferences_store({"DATA_DIR": tmp_path})
    with pytest.raises(RuntimeError, match="Postgres-only"):
        save_track_preferences_store(
            {"DATA_DIR": tmp_path},
            {"actors": {"local": {"track_preferences": {"C:/Music/new.mp3": {"rating": 4}}}}},
        )


def test_local_track_preference_write_normalizes_and_clear_removes_overlay(tmp_path, monkeypatch):
    monkeypatch.setattr("music_app.services.track_preferences_postgres.psycopg", object())

    class FakePostgresStore:
        payload = {"version": 1, "actors": {}}

        def __init__(self, config):
            self.config = config

        def load_store(self):
            return self.payload

        def save_store(self, payload):
            type(self).payload = payload
            return payload

    monkeypatch.setattr(
        "music_app.services.track_preferences.PostgresTrackPreferencesStore",
        FakePostgresStore,
    )
    config = {
        "DATA_DIR": tmp_path,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"track_preferences": "postgres"},
    }

    saved = save_track_preference(
        config,
        " C:/Music/song.mp3 ",
        {"rating": 5, "love_tier": "Obsessed"},
    )
    assert saved["track_ref"] == "C:/Music/song.mp3"
    assert saved["track_preference"]["rating"] == 5
    assert saved["track_preference"]["love_tier"] == "obsessed"

    cleared = save_track_preference(
        config,
        "C:/Music/song.mp3",
        {"rating": None, "love_tier": "off"},
    )
    assert cleared["track_preference"]["rating"] is None
    assert cleared["track_preference"]["love_tier"] == "off"
    assert load_track_preferences_store(config)["actors"]["local"]["track_preferences"] == {}


def test_track_preferences_store_normalizes_malformed_saved_rating_without_dropping_love_tier():
    payload = normalize_track_preferences_store(
        {
            "version": 1,
            "actors": {
                "local": {
                    "track_preferences": {
                        "C:/Music/Artist One/Album One/01 Track.flac": {
                            "rating": 9,
                            "love_tier": "Loved",
                        },
                    },
                },
            },
        }
    )

    assert payload["actors"]["local"]["track_preferences"][
        "C:/Music/Artist One/Album One/01 Track.flac"
    ] == {
        "rating": None,
        "love_tier": "loved",
    }


def test_postgres_track_preferences_availability_requires_runtime_app_database_url(monkeypatch):
    monkeypatch.setattr("music_app.services.track_preferences_postgres.psycopg", object())

    assert not is_track_preferences_postgres_available({})
    assert is_track_preferences_postgres_available(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"}
    )


def test_postgres_track_preferences_availability_requires_driver(monkeypatch):
    monkeypatch.setattr("music_app.services.track_preferences_postgres.psycopg", None)

    assert not is_track_preferences_postgres_available(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"}
    )


def test_postgres_track_preferences_store_loads_actor_store_shape():
    connection = _FakeConnection(
        rows=[
            {"track_key": "C:/Music/one.mp3", "rating": 5, "love_tier": "loved"},
            {"track_key": "C:/Music/two.mp3", "rating": None, "love_tier": "obsessed"},
        ]
    )
    store = PostgresTrackPreferencesStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda database_url: connection,
    )

    payload = store.load_store()

    assert payload == {
        "version": 1,
        "actors": {
            "local": {
                "track_preferences": {
                    "C:/Music/one.mp3": {"rating": 5, "love_tier": "loved"},
                    "C:/Music/two.mp3": {"rating": None, "love_tier": "obsessed"},
                }
            }
        },
    }
    assert any("app.bootstrap_owners" in operation["sql"] for operation in connection.operations)
    assert connection.closed


def test_postgres_track_preferences_store_loads_scoped_track_preferences():
    connection = _FakeConnection(
        rows=[
            {"track_key": "C:/Music/one.mp3", "rating": 5, "love_tier": "loved"},
        ]
    )
    store = PostgresTrackPreferencesStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda database_url: connection,
    )

    payload = store.load_track_preferences([" C:/Music/one.mp3 "])

    assert payload == {
        "C:/Music/one.mp3": {"rating": 5, "love_tier": "loved"},
    }
    assert any(
        "where app.track_preferences.track_key = any" in operation["sql"].lower()
        for operation in connection.operations
    )
    assert connection.closed


def test_selected_postgres_ignores_stale_json_and_projects_overlay_shape(
    tmp_path,
    monkeypatch,
):
    postgres_track_ref = "C:/Music/Artist/Album/01 Track.flac"
    stale_track_ref = "C:/Music/Artist/Album/99 Stale.flac"
    data_dir = tmp_path / "runtime"
    data_dir.mkdir()
    stale_path = data_dir / "track_preferences.json"
    stale_path.write_text(
        json.dumps(
            {
                "version": 1,
                "actors": {
                    "local": {
                        "track_preferences": {
                            stale_track_ref: {"rating": 1, "love_tier": "Obsessed"},
                        },
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    postgres_connection = _FakeConnection(
        rows=[
            {"track_key": postgres_track_ref, "rating": 5, "love_tier": "loved"},
        ]
    )

    class FakePostgresTrackPreferencesStore(PostgresTrackPreferencesStore):
        def __init__(self, config):
            super().__init__(config, connect=lambda database_url: postgres_connection)

    monkeypatch.setattr("music_app.services.track_preferences_postgres.psycopg", object())
    monkeypatch.setattr(
        "music_app.services.track_preferences.PostgresTrackPreferencesStore",
        FakePostgresTrackPreferencesStore,
    )
    postgres_config = {
        "DATA_DIR": data_dir,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"track_preferences": "postgres"},
    }

    assert load_track_preferences_store(postgres_config)["actors"]["local"]["track_preferences"] == {
        postgres_track_ref: {"rating": 5, "love_tier": "loved"}
    }
    assert build_track_preference_overlay_lookup(
        postgres_config,
        client_surface_class="mobile",
    ) == {
        postgres_track_ref: {
            "rating": 5,
            "love_tier": "loved",
            "allowed_actions": {
                "client_surface_class": "mobile",
                "can_rate": True,
                "can_set_love_tier": True,
            },
        },
    }
    assert stale_track_ref not in build_track_preference_overlay_lookup(postgres_config)
    assert stale_path.exists()


def test_postgres_track_preferences_store_replaces_local_store_rows():
    connection = _FakeConnection()
    store = PostgresTrackPreferencesStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda database_url: connection,
    )

    saved = store.save_store(
        {
            "version": 1,
            "actors": {
                "local": {
                    "track_preferences": {
                        " C:/Music/one.mp3 ": {"rating": 5, "love_tier": "Loved"},
                        "C:/Music/clear.mp3": {"rating": None, "love_tier": "off"},
                    }
                },
                "remote": {"track_preferences": {"ignored.mp3": {"rating": 4}}},
            },
        }
    )

    assert saved["actors"]["local"]["track_preferences"] == {
        "C:/Music/one.mp3": {"rating": 5, "love_tier": "loved"}
    }
    neutralize_operations = [
        operation
        for operation in connection.operations
        if "update app.track_preferences" in operation["sql"].lower()
        and "love_tier = 'off'" in operation["sql"].lower()
    ]
    insert_operations = [
        operation
        for operation in connection.operations
        if "insert into app.track_preferences" in operation["sql"].lower()
    ]
    assert not any(
        "delete from app.track_preferences" in operation["sql"].lower()
        for operation in connection.operations
    )
    assert len(neutralize_operations) == 1
    assert len(insert_operations) == 1
    assert insert_operations[0]["params"] == ("C:/Music/one.mp3", 5, "loved")
    assert "metadata - 'cleared'" in insert_operations[0]["sql"]
    assert connection.closed


def test_postgres_track_preferences_store_raises_when_bootstrap_context_is_missing():
    connection = _FakeConnection(bootstrap_ready=False)
    store = PostgresTrackPreferencesStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda database_url: connection,
    )

    with pytest.raises(RuntimeError, match="bootstrap local owner/library"):
        store.save_store(
            {
                "version": 1,
                "actors": {
                    "local": {
                        "track_preferences": {
                            "C:/Music/one.mp3": {"rating": 5, "love_tier": "loved"},
                        }
                    }
                },
            }
        )

    assert not any(
        "insert into app.track_preferences" in operation["sql"].lower()
        for operation in connection.operations
    )
    assert connection.closed


def test_postgres_track_preferences_store_raises_when_upsert_does_not_write_row():
    connection = _FakeConnection(upsert_returns=False)
    store = PostgresTrackPreferencesStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda database_url: connection,
    )

    with pytest.raises(RuntimeError, match="did not write"):
        store.save_store(
            {
                "version": 1,
                "actors": {
                    "local": {
                        "track_preferences": {
                            "C:/Music/one.mp3": {"rating": 5, "love_tier": "loved"},
                        }
                    }
                },
            }
        )

    assert connection.closed


def test_track_preferences_service_uses_postgres_adapter_when_selected(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr("music_app.services.track_preferences_postgres.psycopg", object())

    class FakePostgresStore:
        saved_payload = None

        def __init__(self, config):
            self.config = config

        def load_store(self):
            return {
                "version": 1,
                "actors": {
                    "local": {
                        "track_preferences": {
                            "C:/Music/postgres.mp3": {"rating": 4, "love_tier": "loved"}
                        }
                    }
                },
            }

        def save_store(self, payload):
            FakePostgresStore.saved_payload = payload
            return payload

    monkeypatch.setattr(
        "music_app.services.track_preferences.PostgresTrackPreferencesStore",
        FakePostgresStore,
    )
    config = {
        "DATA_DIR": tmp_path,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"track_preferences": "postgres"},
    }

    loaded = load_track_preferences_store(config)
    saved = save_track_preference(config, "C:/Music/postgres.mp3", {"rating": 5})

    assert loaded["actors"]["local"]["track_preferences"]["C:/Music/postgres.mp3"] == {
        "rating": 4,
        "love_tier": "loved",
    }
    assert saved["track_preference"]["rating"] == 5
    assert saved["track_preference"]["love_tier"] == "loved"
    assert FakePostgresStore.saved_payload["actors"]["local"]["track_preferences"] == {
        "C:/Music/postgres.mp3": {"rating": 5, "love_tier": "loved"}
    }
    assert not (tmp_path / "track_preferences.json").exists()


def test_track_preference_overlay_lookup_uses_scoped_postgres_lookup_when_track_refs_provided(
    tmp_path,
    monkeypatch,
):
    class FakePostgresStore:
        def __init__(self, config):
            self.config = config

        def load_track_preferences(self, track_refs):
            assert self.config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://album_haven_app@localhost/app"
            assert list(track_refs) == ["C:/Music/postgres.mp3"]
            return {
                "C:/Music/postgres.mp3": {"rating": 5, "love_tier": "loved"},
            }

    monkeypatch.setattr("music_app.services.track_preferences.is_track_preferences_postgres_available", lambda config: True)
    monkeypatch.setattr(
        "music_app.services.track_preferences.PostgresTrackPreferencesStore",
        FakePostgresStore,
    )
    monkeypatch.setattr(
        "music_app.services.track_preferences.load_track_preferences_store",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("full store load should not run")),
    )

    lookup = build_track_preference_overlay_lookup(
        {
            "DATA_DIR": tmp_path,
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        },
        client_surface_class="mobile",
        track_refs=[" C:/Music/postgres.mp3 "],
    )

    assert lookup == {
        "C:/Music/postgres.mp3": {
            "rating": 5,
            "love_tier": "loved",
            "allowed_actions": {
                "client_surface_class": "mobile",
                "can_rate": True,
                "can_set_love_tier": True,
            },
        },
    }
