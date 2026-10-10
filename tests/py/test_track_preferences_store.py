from __future__ import annotations

from types import SimpleNamespace

import pytest

from music_app.services.track_preferences import (
    normalize_track_preferences_store, save_track_preference,
)
from music_app.services.track_preferences_postgres import is_track_preferences_postgres_available


@pytest.mark.parametrize("rating,expected", [("5", 5), ("4/5", 4), ([3], 3), (9, None)])
def test_offline_normalizer_retains_artifact_coercion_independent_of_live_write(rating, expected):
    result = normalize_track_preferences_store({"actors": {"local": {"track_preferences": {
        " K ": {"rating": rating, "love_tier": "Loved"},
    }}}})
    assert result["actors"]["local"]["track_preferences"]["K"] == {
        "rating": expected, "love_tier": "loved"}


def test_service_patches_one_explicit_scope_without_loading_a_snapshot(monkeypatch):
    calls = []
    class Repository:
        def __init__(self, config):
            self.config = config
        def patch_preference(self, track_ref, patch, **scope):
            calls.append((track_ref, patch, scope))
            return {"track_id": 31, "track_ref": track_ref, "track_key": "K",
                    "preference_id": 7, "preference_key": "K", "rating": None,
                    "love_tier": "loved", "is_active_path": True}
    monkeypatch.setattr("music_app.services.track_preferences.PostgresTrackPreferencesStore", Repository)
    monkeypatch.setattr("music_app.services.track_preferences.select_runtime_persistence_adapter",
                        lambda *_args: SimpleNamespace(effective_backend="postgres"))
    result = save_track_preference({}, " /fixture/music.flac ", {"rating": None},
        account_id=11, library_id=21, expected_track_id=31, client_surface_class="TV")
    assert calls == [("/fixture/music.flac", {"rating": None},
                      {"account_id": 11, "library_id": 21, "expected_track_id": 31})]
    assert result["actor_id"] == "11" and result["library_id"] == 21
    assert result["track_preference"]["rating"] is None
    assert result["track_preference"]["love_tier"] == "loved"
    assert result["track_preference"]["allowed_actions"]["client_surface_class"] == "tv"


def test_runtime_file_selection_is_rejected_without_reading_json(tmp_path, monkeypatch):
    path = tmp_path / "track_preferences.json"
    path.write_text("{not-json", encoding="utf-8")
    monkeypatch.setattr("music_app.services.track_preferences.select_runtime_persistence_adapter",
                        lambda *_args: SimpleNamespace(effective_backend="file"))
    with pytest.raises(RuntimeError, match="Postgres-only"):
        save_track_preference({"DATA_DIR": tmp_path}, "K", {"rating": 4},
            account_id=11, library_id=21, expected_track_id=31)
    assert path.read_text(encoding="utf-8") == "{not-json"


def test_live_service_requires_explicit_account_library_and_authorized_track():
    with pytest.raises(TypeError):
        save_track_preference({}, "K", {"rating": 4})


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
