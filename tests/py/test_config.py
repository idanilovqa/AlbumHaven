from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

import pytest

from config import (
    PERSISTENCE_BACKEND_POSTGRES,
    PERSISTENCE_SEAM_IDS,
    _parse_env_value,
    _resolve_data_dir,
    _resolve_data_file_path,
    build_persistence_backend_config,
    persistence_backend_for,
)


def test_music_dir_has_no_machine_specific_default():
    environment = dict(os.environ)
    environment["MUSIC_DIR"] = ""
    result = subprocess.run(
        [sys.executable, "-c", "from config import Config; assert Config.MUSIC_DIR is None"],
        cwd=Path(__file__).resolve().parents[2],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def test_parse_env_value_strips_matching_quotes():
    assert _parse_env_value('"hello"') == "hello"
    assert _parse_env_value("'hello'") == "hello"


def test_parse_env_value_keeps_unquoted_text():
    assert _parse_env_value("hello") == "hello"
    assert _parse_env_value(" hello ") == "hello"


def test_resolve_data_dir_falls_back_when_preferred_directory_is_blocked(tmp_path, monkeypatch):
    preferred_dir = (tmp_path / "blocked-data").resolve()
    fallback_dir = (tmp_path / "fallback-data").resolve()
    original_mkdir = Path.mkdir

    def raise_permission_error(self: Path, *args, **kwargs) -> None:
        if self == preferred_dir:
            raise PermissionError("blocked")
        return original_mkdir(self, *args, **kwargs)

    monkeypatch.setattr("config._repo_local_data_dir", lambda: fallback_dir)
    monkeypatch.setattr(Path, "mkdir", raise_permission_error)

    resolved = _resolve_data_dir(preferred_dir)

    assert resolved == fallback_dir
    assert fallback_dir.is_dir()


def test_resolve_data_file_path_falls_back_when_preferred_file_is_inaccessible(tmp_path, monkeypatch):
    preferred_file = (tmp_path / "blocked" / "library_cache.json").resolve()
    fallback_file = (tmp_path / "fallback" / "library_cache.json").resolve()
    original_exists = Path.exists

    def raise_permission_error(self: Path) -> bool:
        if self == preferred_file:
            raise PermissionError("blocked")
        return original_exists(self)

    monkeypatch.setattr(Path, "exists", raise_permission_error)

    resolved = _resolve_data_file_path(preferred_file, fallback_file, kind="library cache")

    assert resolved == fallback_file
    assert fallback_file.parent.is_dir()


def test_runtime_persistence_backend_config_defaults_all_seams_to_postgres():
    backends = build_persistence_backend_config({})

    assert set(backends) == set(PERSISTENCE_SEAM_IDS)
    assert all(value == PERSISTENCE_BACKEND_POSTGRES for value in backends.values())


def test_runtime_persistence_backend_config_rejects_file_override():
    with pytest.raises(ValueError, match="ALBUM_HAVEN_PERSISTENCE_LISTEN_HISTORY"):
        build_persistence_backend_config(
            {
                "ALBUM_HAVEN_PERSISTENCE_DEFAULT": "postgres",
                "ALBUM_HAVEN_PERSISTENCE_LISTEN_HISTORY": "file",
            }
        )


def test_persistence_backend_config_allows_global_postgres_default():
    backends = build_persistence_backend_config(
        {"ALBUM_HAVEN_PERSISTENCE_DEFAULT": "postgres"}
    )

    assert all(value == "postgres" for value in backends.values())


def test_persistence_backend_config_rejects_global_file_default():
    with pytest.raises(ValueError, match="ALBUM_HAVEN_PERSISTENCE_DEFAULT"):
        build_persistence_backend_config({"ALBUM_HAVEN_PERSISTENCE_DEFAULT": "file"})


def test_persistence_backend_config_allows_per_seam_postgres_override_over_default():
    backends = build_persistence_backend_config(
        {
            "ALBUM_HAVEN_PERSISTENCE_DEFAULT": "postgres",
            "ALBUM_HAVEN_PERSISTENCE_LISTEN_HISTORY": "postgres",
        }
    )

    assert backends["listen_history"] == "postgres"
    assert backends["lastfm_settings"] == "postgres"


@pytest.mark.parametrize(
    ("env_key", "env_value"),
    [
        ("ALBUM_HAVEN_PERSISTENCE_DEFAULT", "json"),
        ("ALBUM_HAVEN_PERSISTENCE_LISTEN_HISTORY", ""),
        ("ALBUM_HAVEN_PERSISTENCE_TRACK_PREFERENCES", "pg"),
    ],
)
def test_persistence_backend_config_rejects_invalid_backend_values(env_key, env_value):
    with pytest.raises(ValueError, match=env_key):
        build_persistence_backend_config({env_key: env_value})


def test_persistence_backend_for_rejects_unknown_seam():
    with pytest.raises(ValueError, match="unknown-seam"):
        persistence_backend_for("unknown-seam", {"PERSISTENCE_BACKENDS": {}})


def test_runtime_app_database_url_is_separate_from_migration_database_url(monkeypatch):
    monkeypatch.setenv("ALBUM_HAVEN_DATABASE_URL", "postgresql://migrator/album_haven_core")
    monkeypatch.delenv("ALBUM_HAVEN_APP_DATABASE_URL", raising=False)

    from config import runtime_app_database_url_from_env

    assert runtime_app_database_url_from_env() == ""

    monkeypatch.setenv("ALBUM_HAVEN_APP_DATABASE_URL", "postgresql://app/album_haven_core")

    assert runtime_app_database_url_from_env() == "postgresql://app/album_haven_core"
