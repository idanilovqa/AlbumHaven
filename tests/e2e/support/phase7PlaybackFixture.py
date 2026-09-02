"""Generated media and normal Postgres inventory for the isolated admin suite."""
from __future__ import annotations

from pathlib import Path
import time

from isolatedLibraryApp import generate_playback_start_fixture_audio


def prepare_settings_playback_media(library_root: Path) -> dict[str, dict[str, object]]:
    from music_app.services.metadata import FILE_METADATA_SCHEMA_VERSION

    artist = "Settings Navigation Fixture"
    album = "Uninterrupted Session"
    title = "Continuous Signal"
    track = generate_playback_start_fixture_audio(
        library_root,
        library_root / artist / album / "01 - Continuous Signal.mp3",
        duration_seconds=180,
        frequency_hz=440,
    ).resolve()
    stat = track.stat()
    return {
        str(track): {
            "path": str(track),
            "mtime": stat.st_mtime,
            "size": stat.st_size,
            "artist": artist,
            "album_artist": artist,
            "album": album,
            "title": title,
            "year": 2026,
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
            "duration_seconds": 180,
            "duration_display": "3:00",
            "cover_path": None,
            "library_root_id": "isolated-e2e-root",
            "library_root_category": "main_library",
            "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
        }
    }


def persist_settings_playback_inventory(
    setup_database_url: str,
    library_root: Path,
    file_cache: dict[str, dict[str, object]],
) -> None:
    from config import PERSISTENCE_BACKEND_POSTGRES
    from music_app.services.library_roots import (
        library_root_cache_identity,
        save_library_root_settings,
    )
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": setup_database_url,
        "MUSIC_DIR": library_root.resolve(),
        "CACHE_PATH": library_root.parent / "app-data" / "inert-library-cache.json",
        "LIBRARY_ROOTS_PATH": library_root.parent / "app-data" / "inert-library-roots.json",
        "PERSISTENCE_BACKENDS": {
            "library_roots": PERSISTENCE_BACKEND_POSTGRES,
            "scan_cache": PERSISTENCE_BACKEND_POSTGRES,
        },
    }
    save_library_root_settings(config, {
        "main_library_roots": [{
            "id": "isolated-e2e-root",
            "path": str(library_root.resolve()),
            "layout_mode": "artist",
        }],
    })
    PostgresScanCacheAdapter(config).save_snapshot(
        config["CACHE_PATH"], file_cache, library_root_cache_identity(config), time.time(),
    )
