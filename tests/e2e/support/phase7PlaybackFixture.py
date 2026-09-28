"""Generated media and normal Postgres inventory for the isolated admin suite."""
from __future__ import annotations

from pathlib import Path
import time
import shutil

from isolatedLibraryApp import generate_playback_start_fixture_audio


def prepare_settings_playback_media(library_root: Path) -> dict[str, dict[str, object]]:
    from music_app.services.metadata import FILE_METADATA_SCHEMA_VERSION
    from PIL import Image

    artist = "Settings Navigation Fixture"
    album = "Uninterrupted Session"
    title = "Continuous Signal"
    track = generate_playback_start_fixture_audio(
        library_root,
        library_root / artist / album / "01 - Continuous Signal.mp3",
        duration_seconds=180,
        frequency_hz=440,
    ).resolve()
    cover = track.parent / "cover.png"
    Image.new("RGB", (32, 32), (40, 120, 180)).save(cover)
    stat = track.stat()
    inventory = {
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
            "cover_path": str(cover),
            "library_root_id": "isolated-e2e-root",
            "library_root_category": "main_library",
            "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
        }
    }
    arrival = library_root.parent / "arrivals" / artist / "Boundary Arrival" / "01 - Arrival Signal.mp3"
    arrival.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(track, arrival)
    inventory[str(arrival)] = {**inventory[str(track)], "path": str(arrival),
        "album": "Boundary Arrival", "title": "Arrival Signal", "cover_path": None,
        "library_root_id": "boundary-arrivals", "library_root_category": "new_arrivals"}
    return inventory



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
        "new_arrivals_roots": [{"id": "boundary-arrivals",
            "path": str((library_root.parent / "arrivals").resolve()), "layout_mode": "artist"}],
    })
    if not file_cache:
        PostgresScanCacheAdapter(config).save_snapshot(
            config["CACHE_PATH"], file_cache, library_root_cache_identity(config), time.time(),
        )
        return
    # Missing inventory is a real prior scan observation, followed by an observed
    # disappearance before ASGI starts. The application receives normal rows only.
    existing_path, existing = next(iter(file_cache.items()))
    missing_path = library_root / "Settings Navigation Fixture" / "Missing Boundary Session" / "01 - Missing Signal.mp3"
    missing_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(existing_path, missing_path)
    missing = {**existing, "path": str(missing_path), "album": "Missing Boundary Session",
               "title": "Missing Signal", "cover_path": None}
    adapter = PostgresScanCacheAdapter(config)
    root_identity = library_root_cache_identity(config)
    adapter.save_snapshot(config["CACHE_PATH"], {**file_cache, str(missing_path): missing}, root_identity, time.time())
    missing_path.unlink()
    missing_path.parent.rmdir()
    adapter.save_snapshot(
        config["CACHE_PATH"], file_cache, root_identity, time.time(),
        observed_library_root_ids={"isolated-e2e-root"},
    )


def prepare_settings_cover_specs(temp_root: Path) -> list[dict[str, object]]:
    from PIL import Image

    covers = temp_root / "provider-covers"
    covers.mkdir(parents=True, exist_ok=True)
    specs = []
    for name, color in (("phase7-provider", (180, 60, 40)), ("phase7-manual", (40, 180, 80))):
        path = covers / f"{name}.jpg"
        Image.new("RGB", (1024, 1024), color).save(path)
        specs.append({"cover_id": name, "staged_path": str(path),
                      "other_art_staged_path": str(path), "width": 1024, "height": 1024,
                      "artist": "Settings Navigation Fixture", "album": "Uninterrupted Session",
                      "year": 2026,
                      "candidate_fixture_mode": "manual-source" if name == "phase7-manual" else ""})
    return specs
