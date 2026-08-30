from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import unquote, urlparse
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
APPROVED_COVER_METADATA_PATH = ROOT / "tests" / "e2e" / "fixtures" / "approvedCoverFixtures.json"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.e2e.support.isolatedPostgres import IsolatedDatabaseOwnershipLock  # noqa: E402
from tests.e2e.support.privateFixtureData import (  # noqa: E402
    resolve_approved_cover_by_sha256,
)

try:
    from mutagen import File as MutagenFile
except ImportError:  # pragma: no cover - dependency is part of repo requirements
    MutagenFile = None

_TEMP_ROOT: Path | None = None
_TRACKS_PER_ALBUM = 3
_ARTIST_COUNT = 100
_ALBUMS_PER_ARTIST = 10
_TOTAL_ALBUMS = _ARTIST_COUNT * _ALBUMS_PER_ARTIST
_REAL_COVER_POOL_SIZE = 8
_TEMP_PREFIX = "album-haven-e2e-"
_SCAN_RUNTIME_DATABASE_ENV = "ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL"
_SCAN_SETUP_DATABASE_ENV = "ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL"
_SCAN_DATABASE_ALLOW_SHARED_ENV = "ALBUM_HAVEN_SCAN_PERFORMANCE_ALLOW_SHARED_DATABASE"
_SCAN_DATABASE_LABEL = "album_haven_scan_e2e"
_SCAN_SETUP_DATABASE_ROLE = "album_haven_migrator"
_SCAN_RUNTIME_DATABASE_ROLE = "album_haven_app"
_SCAN_SCENARIO_ENV = "ALBUM_HAVEN_SCAN_PERFORMANCE_SCENARIO"
_SCAN_STATUS_SAMPLES_ENV = "ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH"
_COVER_PROVIDER_GROUPS_ENV = "ALBUM_HAVEN_COVER_PROVIDER_GROUPS"
_NO_WINDOW_CREATION_FLAGS = (
    getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if os.name == "nt"
    else 0
)
_SCAN_SCENARIOS = frozenset({"cold", "cached", "add-album", "metadata"})
_CACHED_LAST_SCAN_MARKER = 1_609_459_200.0
_INCREMENTAL_CACHE_MAX_AGE_SECONDS = 3600
_RUNTIME_PATH_KEYS = (
    "MUSIC_DIR",
    "DATA_DIR",
    "CACHE_PATH",
    "COVER_CACHE_PATH",
    "LIBRARY_ROOTS_PATH",
)


def scan_cache_max_age_seconds(scenario: str) -> int:
    return 0 if str(scenario).strip().lower() == "cached" else _INCREMENTAL_CACHE_MAX_AGE_SECONDS


def _postgres_migration_names() -> tuple[str, ...]:
    migrations_root = ROOT / "migrations" / "postgres"
    return tuple(
        path.name
        for path in sorted(migrations_root.glob("*.sql"))
        if path.is_file()
    )


def cleanup_temp_root() -> None:
    global _TEMP_ROOT
    if _TEMP_ROOT is None:
        return
    temp_root = _TEMP_ROOT
    _TEMP_ROOT = None
    shutil.rmtree(temp_root, ignore_errors=True)


def install_shutdown_handlers() -> None:
    def handle_shutdown(_signum: int, _frame: Any) -> None:
        raise SystemExit(0)

    for signal_name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        signal_value = getattr(signal, signal_name, None)
        if signal_value is None:
            continue
        signal.signal(signal_value, handle_shutdown)


def _is_loopback_database_host(hostname: str) -> bool:
    if hostname.casefold() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _scan_database_contract(database_url: str) -> tuple[str, str, str]:
    parsed = urlparse(database_url)
    database_name = Path(parsed.path or "").name.casefold()
    if database_name == _SCAN_DATABASE_LABEL:
        return database_name, _SCAN_SETUP_DATABASE_ROLE, _SCAN_RUNTIME_DATABASE_ROLE
    if database_name.startswith("album_haven_ci_"):
        suffix = database_name.removeprefix("album_haven_ci_")
        if re.fullmatch(r"[a-z0-9]+(?:_[a-z0-9]+)*", suffix):
            return (
                database_name,
                f"{_SCAN_SETUP_DATABASE_ROLE}_{suffix}",
                f"{_SCAN_RUNTIME_DATABASE_ROLE}_{suffix}",
            )
    raise RuntimeError(
        "Scan performance databases must use the legacy album_haven_scan_e2e identity "
        "or a strict album_haven_ci_<suffix> identity."
    )


def _validate_scan_performance_database_url(env_name: str, database_url: str) -> str:
    if not database_url:
        raise RuntimeError(
            f"{env_name} is required for scan performance runs. "
            "Use a dedicated temporary/test Postgres database; do not point the "
            "scan benchmark at album_haven_core or owner data."
        )
    parsed = urlparse(database_url)
    database_name = Path(parsed.path or "").name.casefold()
    if database_name == "album_haven_core":
        raise RuntimeError(
            f"{env_name} must not target album_haven_core. "
            "Scan performance setup resets tables and requires a dedicated temporary/test Postgres database."
        )
    if parsed.password is not None:
        raise RuntimeError(
            f"{env_name} must not include a password; use pgpass instead."
        )
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise RuntimeError(f"{env_name} must use a PostgreSQL URL.")
    if not _is_loopback_database_host(parsed.hostname or ""):
        raise RuntimeError(f"{env_name} must use a loopback host.")
    if parsed.query or parsed.params or parsed.fragment:
        raise RuntimeError(f"{env_name} must not include connection parameters.")
    _scan_database_contract(database_url)
    return database_url


def _scan_database_identity(database_url: str) -> tuple[str, str, int, str]:
    parsed = urlparse(database_url)
    return (
        parsed.scheme.lower(),
        (parsed.hostname or "").lower(),
        parsed.port or 5432,
        Path(parsed.path or "").name.lower(),
    )


def _scan_database_username(database_url: str) -> str:
    return unquote(urlparse(database_url).username or "").casefold()


def _scan_database_lock(database_url: str) -> IsolatedDatabaseOwnershipLock:
    identity = _scan_database_identity(database_url)
    identity_digest = hashlib.sha256(repr(identity).encode("utf-8")).hexdigest()[:16]
    lock_path = Path(tempfile.gettempdir()) / f"{_SCAN_DATABASE_LABEL}-{identity_digest}.lock"
    return IsolatedDatabaseOwnershipLock(
        lock_path=lock_path,
        database_label=_SCAN_DATABASE_LABEL,
    )


def resolve_scan_performance_database_urls(environ: dict[str, str] | None = None) -> tuple[str, str]:
    env = os.environ if environ is None else environ
    if str(env.get(_SCAN_DATABASE_ALLOW_SHARED_ENV) or "").strip():
        raise RuntimeError(
            f"{_SCAN_DATABASE_ALLOW_SHARED_ENV} is not supported; scan performance runs "
            "must use a fixture-owned isolated database."
        )
    runtime_database_url = _validate_scan_performance_database_url(
        _SCAN_RUNTIME_DATABASE_ENV,
        str(env.get(_SCAN_RUNTIME_DATABASE_ENV) or "").strip(),
    )
    setup_database_url = _validate_scan_performance_database_url(
        _SCAN_SETUP_DATABASE_ENV,
        str(env.get(_SCAN_SETUP_DATABASE_ENV) or "").strip(),
    )
    setup_username = _scan_database_username(setup_database_url)
    runtime_username = _scan_database_username(runtime_database_url)
    setup_database_name, expected_setup_role, expected_runtime_role = (
        _scan_database_contract(setup_database_url)
    )
    runtime_database_name, runtime_setup_role, runtime_expected_role = (
        _scan_database_contract(runtime_database_url)
    )
    if setup_username != expected_setup_role:
        raise RuntimeError(
            f"{_SCAN_SETUP_DATABASE_ENV} must use the {expected_setup_role} setup role."
        )
    if runtime_username != runtime_expected_role:
        raise RuntimeError(
            f"{_SCAN_RUNTIME_DATABASE_ENV} must use the {runtime_expected_role} runtime role."
        )
    if runtime_username == setup_username:
        raise RuntimeError(
            f"{_SCAN_SETUP_DATABASE_ENV} must use setup/migrator credentials distinct from "
            f"{_SCAN_RUNTIME_DATABASE_ENV}; the app benchmark must run with runtime app credentials."
        )
    runtime_database_identity = _scan_database_identity(runtime_database_url)
    setup_database_identity = _scan_database_identity(setup_database_url)
    if runtime_database_identity != setup_database_identity:
        raise RuntimeError(
            f"{_SCAN_SETUP_DATABASE_ENV} and {_SCAN_RUNTIME_DATABASE_ENV} must point at the same "
            f"isolated database with different credentials. Got {setup_database_identity!r} and "
            f"{runtime_database_identity!r}."
        )
    if (
        setup_database_name != runtime_database_name
        or expected_setup_role != runtime_setup_role
        or expected_runtime_role != runtime_expected_role
    ):
        raise RuntimeError(
            "Scan performance database and role identities must share one exact job suffix."
        )
    return setup_database_url, runtime_database_url


def preflight_scan_performance_database_connections(
    environ: dict[str, str] | None = None,
    *,
    connect=None,
) -> None:
    setup_database_url, runtime_database_url = resolve_scan_performance_database_urls(environ)
    if connect is None:
        try:
            import psycopg
        except ImportError as exc:
            raise RuntimeError("psycopg is required for the scan performance database preflight.") from exc
        connect = psycopg.connect

    expected_connections = (
        (setup_database_url, True),
        (runtime_database_url, False),
    )
    for database_url, is_setup_connection in expected_connections:
        expected_database = _scan_database_identity(database_url)[3]
        expected_username = _scan_database_username(database_url)
        with connect(
            database_url,
            connect_timeout=10,
            options="-c default_transaction_read_only=on",
        ) as connection:
            row = connection.execute(
                "select current_database(), current_user, "
                "has_database_privilege(current_user, current_database(), 'CREATE')"
            ).fetchone()
        connected_database = str((row or (None, None))[0] or "").strip().lower()
        connected_username = str((row or (None, None))[1] or "").strip().lower()
        if (connected_database, connected_username) != (expected_database, expected_username):
            raise RuntimeError(
                "Scan performance database preflight identity mismatch; refusing to run destructive setup."
            )
        if is_setup_connection and not bool((row or (None, None, False))[2]):
            raise RuntimeError(
                "Scan performance setup role lacks CREATE privilege on the dedicated database."
            )


def resolve_scan_performance_database_url(environ: dict[str, str] | None = None) -> str:
    _setup_database_url, runtime_database_url = resolve_scan_performance_database_urls(environ)
    return runtime_database_url


def initialize_scan_performance_database(database_url: str) -> None:
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError("psycopg is required for Postgres-backed scan performance runs.") from exc

    migrations_root = ROOT / "migrations" / "postgres"
    with psycopg.connect(database_url) as connection:
        for migration_name in _postgres_migration_names():
            migration_sql = (migrations_root / migration_name).read_text(encoding="utf-8")
            connection.execute(migration_sql)
        connection.execute(_reset_scan_performance_database_sql())
        connection.execute(_seed_bootstrap_local_library_sql())


def persist_scan_performance_library_root(setup_database_url: str, music_dir: Path) -> dict[str, object]:
    from config import PERSISTENCE_BACKEND_POSTGRES
    from music_app.services.library_roots import save_library_root_settings

    resolved_music_dir = Path(music_dir).expanduser().resolve(strict=False)
    setup_config: dict[str, object] = {
        "ALBUM_HAVEN_APP_DATABASE_URL": setup_database_url,
        "MUSIC_DIR": resolved_music_dir,
        "PERSISTENCE_BACKENDS": {
            "library_roots": PERSISTENCE_BACKEND_POSTGRES,
        },
    }
    return save_library_root_settings(
        setup_config,
        {
            "main_library_roots": [
                {
                    "id": "scan-performance-root",
                    "path": str(resolved_music_dir),
                    "layout_mode": "artist",
                }
            ]
        },
    )


def _reset_scan_performance_database_sql() -> str:
    return """
        truncate table
          app.account_sessions,
          app.capabilities,
          app.bootstrap_owners,
          app.accounts,
          library.library_memberships,
          library.library_root_provenance,
          library.library_root_settings,
          library.move_policy_settings,
          library.local_artist_mbid_assertions,
          library.local_mbid_assertions,
          library.local_track_files,
          library.local_tracks,
          library.local_albums,
          library.local_artists,
          library.ignored_versions,
          library.ignored_repairs,
          library.manual_versions,
          library.separate_releases,
          library.exception_overrides,
          library.libraries,
          app.track_preferences,
          app.saved_loops,
          app.user_discovery_preferences,
          app.virtual_artist_snapshots,
          app.virtual_artist_recent_lookups,
          app.discovery_lookup_snapshots,
          app.e2e_problematic_file_fixture_seeds,
          integration.lastfm_settings,
          integration.lastfm_sessions,
          integration.pending_scrobbles,
          integration.scrobble_retry_state,
          integration.listen_history,
          integration.lastfm_loved_tracks,
          ops.cover_lookup_tasks,
          ops.virtual_release_snapshots,
          library.local_artist_family_links
        restart identity cascade;
    """


def _seed_bootstrap_local_library_sql() -> str:
    return """
        with owner_account as (
          insert into app.accounts (display_name, account_kind, metadata)
          values (
            'Scan Performance Owner',
            'bootstrap_owner',
            '{"source":"scan_performance_harness"}'::jsonb
          )
          returning id
        ),
        bootstrap_owner as (
          insert into app.bootstrap_owners (account_id, owner_key, metadata)
          select id, 'local-bootstrap-owner', '{"source":"scan_performance_harness"}'::jsonb
          from owner_account
          returning account_id
        )
        insert into library.libraries (owner_account_id, name, library_kind, metadata)
        select account_id, 'Local Library', 'local', '{"source":"scan_performance_harness"}'::jsonb
        from bootstrap_owner;
    """


def load_real_cover_manifest() -> dict[str, Any]:
    with APPROVED_COVER_METADATA_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def resolve_manifest_cover_path(cover: dict[str, Any]) -> Path:
    expected_hash = str(cover.get("sha256") or "").strip()
    if not expected_hash:
        raise RuntimeError("Approved cover metadata requires sha256.")
    return resolve_approved_cover_by_sha256(expected_hash)


def resolve_ffmpeg_executable() -> str | None:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    try:
        import imageio_ffmpeg
    except Exception:
        return None
    try:
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def ensure_base_mp3(path: Path) -> None:
    if path.exists():
        return
    ffmpeg = resolve_ffmpeg_executable()
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to generate scan benchmark fixture media.")
    path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "anoisesrc=color=white:amplitude=0.06:duration=2:sample_rate=44100",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "5",
        str(path),
    ]
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=False,
        creationflags=_NO_WINDOW_CREATION_FLAGS,
    )
    if result.returncode != 0:
        raise RuntimeError(
            result.stderr.strip()
            or "ffmpeg failed to generate the base scan benchmark MP3 fixture."
        )


def write_track_tags(path: Path, *, artist: str, album: str, title: str, track_number: int, year: int) -> None:
    if MutagenFile is None:
        raise RuntimeError("Mutagen is required to build tagged scan benchmark fixture media.")
    audio = MutagenFile(path, easy=True)
    if audio is None:
        raise RuntimeError(f"Mutagen could not open generated fixture track: {path}")
    if getattr(audio, "tags", None) is None:
        try:
            audio.add_tags()
        except Exception:
            pass
    audio["artist"] = [artist]
    audio["albumartist"] = [artist]
    audio["album"] = [album]
    audio["title"] = [title]
    audio["tracknumber"] = [str(track_number)]
    audio["date"] = [str(year)]
    audio.save()


def stage_real_cover_pool(staging_root: Path) -> list[dict[str, Any]]:
    manifest = load_real_cover_manifest()
    staged_dir = staging_root / "cover-pool"
    staged_dir.mkdir(parents=True, exist_ok=True)
    cover_specs: list[dict[str, Any]] = []
    for cover in list(manifest.get("covers") or [])[:_REAL_COVER_POOL_SIZE]:
        source_path = resolve_manifest_cover_path(cover)
        destination_path = staged_dir / f"{str(cover.get('assetId') or '').strip()}{source_path.suffix.lower()}"
        shutil.copy2(source_path, destination_path)
        cover_specs.append({
            "cover_id": source_path.stem,
            "staged_path": destination_path,
            "artist": str(cover.get("artist") or "").strip(),
            "album": str(cover.get("album") or "").strip(),
            "year": int(cover.get("year") or 0) or None,
        })
    return cover_specs


def link_or_copy(source_path: Path, destination_path: Path) -> None:
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    if destination_path.exists():
        destination_path.unlink()
    try:
        os.link(source_path, destination_path)
    except OSError:
        shutil.copy2(source_path, destination_path)


def album_folder_name(album_index: int) -> str:
    return f"Album {album_index + 1:03d}"


def artist_name(artist_index: int) -> str:
    return f"Scan Artist {artist_index + 1:03d}"


def build_album_fixture(
    *,
    library_root: Path,
    base_track_path: Path,
    cover_specs: list[dict[str, Any]],
    artist_index: int,
    album_index: int,
    track_count: int = _TRACKS_PER_ALBUM,
    reuse_existing: bool = False,
) -> dict[str, Any]:
    current_artist = artist_name(artist_index)
    current_album = album_folder_name(album_index)
    year = 1995 + (album_index % 25)
    album_dir = library_root / current_artist / current_album
    album_dir.mkdir(parents=True, exist_ok=True)

    cover_spec = cover_specs[album_index % len(cover_specs)]
    cover_destination = album_dir / "cover.jpg"
    if not reuse_existing or not cover_destination.is_file():
        link_or_copy(Path(cover_spec["staged_path"]), cover_destination)

    track_paths: list[str] = []
    for track_number in range(1, track_count + 1):
        track_path = album_dir / f"{track_number:02d} - Scan Track {track_number}.mp3"
        if not reuse_existing or not track_path.is_file():
            shutil.copy2(base_track_path, track_path)
            write_track_tags(
                track_path,
                artist=current_artist,
                album=current_album,
                title=f"{current_album} Track {track_number}",
                track_number=track_number,
                year=year,
            )
        track_paths.append(str(track_path))

    return {
        "artist": current_artist,
        "album": current_album,
        "year": year,
        "album_dir": str(album_dir),
        "track_paths": track_paths,
        "cover_path": str(cover_destination),
    }


def configure_environment(scenario: str = "cold") -> Path:
    global _TEMP_ROOT
    configured_temp_root = str(os.environ.get("ALBUM_HAVEN_E2E_TEMP_ROOT") or "").strip()
    tmp_root = (
        Path(configured_temp_root).expanduser().resolve(strict=False)
        if configured_temp_root
        else Path(tempfile.mkdtemp(prefix=_TEMP_PREFIX))
    )
    tmp_root.mkdir(parents=True, exist_ok=True)
    _TEMP_ROOT = tmp_root
    data_dir = tmp_root / "appdata"
    music_dir = tmp_root / "music"
    session_temp = tmp_root / "session-temp"
    for path in (data_dir, music_dir, session_temp):
        path.mkdir(parents=True, exist_ok=True)

    os.environ["MUSIC_DIR"] = str(music_dir)
    os.environ["MUSIC_APP_DATA_DIR"] = str(data_dir)
    os.environ["MUSIC_CACHE_PATH"] = str(data_dir / "library_cache.json")
    os.environ["MUSIC_COVER_CACHE_PATH"] = str(data_dir / "cover_search_cache.json")
    os.environ["MUSIC_LIBRARY_ROOTS_PATH"] = str(data_dir / "library_roots.json")
    os.environ["MUSIC_CACHE_MAX_AGE_SECONDS"] = str(scan_cache_max_age_seconds(scenario))
    os.environ["MUSICBRAINZ_ENABLED"] = "0"
    os.environ["SPOTIFY_CLIENT_ID"] = ""
    os.environ["SPOTIFY_CLIENT_SECRET"] = ""
    os.environ["LASTFM_API_KEY"] = ""
    os.environ["LASTFM_API_SECRET"] = ""
    for key in ("TMP", "TEMP", "TMPDIR"):
        os.environ[key] = str(session_temp)
    tempfile.tempdir = None
    setup_database_url, runtime_database_url = resolve_scan_performance_database_urls()
    os.environ["ALBUM_HAVEN_APP_DATABASE_URL"] = runtime_database_url
    os.environ["ALBUM_HAVEN_PERSISTENCE_SCAN_CACHE"] = "postgres"
    initialize_scan_performance_database(setup_database_url)
    persist_scan_performance_library_root(setup_database_url, music_dir)
    return music_dir


def assert_scan_performance_provider_isolation(
    environ: dict[str, str] | None = None,
) -> frozenset[str]:
    from music_app.services.cover_provider_groups import normalize_cover_provider_groups

    env = os.environ if environ is None else environ
    raw_provider_groups = str(env.get(_COVER_PROVIDER_GROUPS_ENV) or "").strip()
    enabled_provider_groups = normalize_cover_provider_groups(raw_provider_groups)
    if enabled_provider_groups != frozenset({"manual_urls"}):
        raise RuntimeError(
            "Scan performance setup requires an offline cover provider configuration; "
            f"set {_COVER_PROVIDER_GROUPS_ENV}=offline (or manual-only), not "
            f"{raw_provider_groups!r}."
        )
    return enabled_provider_groups


def restore_reused_scan_library_baseline(music_dir: Path) -> None:
    added_album = music_dir / artist_name(_TOTAL_ALBUMS // _ALBUMS_PER_ARTIST) / album_folder_name(_TOTAL_ALBUMS)
    shutil.rmtree(added_album, ignore_errors=True)
    first_album = music_dir / artist_name(0) / album_folder_name(0)
    for track_number in range(1, _TRACKS_PER_ALBUM + 1):
        track_path = first_album / f"{track_number:02d} - Scan Track {track_number}.mp3"
        if track_path.is_file():
            write_track_tags(
                track_path,
                artist=artist_name(0),
                album=album_folder_name(0),
                title=f"{album_folder_name(0)} Track {track_number}",
                track_number=track_number,
                year=1995,
            )


def build_scan_library(
    music_dir: Path,
    *,
    reuse_existing: bool = False,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], Path]:
    assets_root = (_TEMP_ROOT or music_dir.parent) / "fixture-assets"
    assets_root.mkdir(parents=True, exist_ok=True)
    cover_specs = stage_real_cover_pool(assets_root)
    base_track_path = assets_root / "base-track.mp3"
    ensure_base_mp3(base_track_path)

    manifest: list[dict[str, Any]] = []
    for album_index in range(_TOTAL_ALBUMS):
        artist_index = album_index // _ALBUMS_PER_ARTIST
        manifest.append(
            build_album_fixture(
                library_root=music_dir,
                base_track_path=base_track_path,
                cover_specs=cover_specs,
                artist_index=artist_index,
                album_index=album_index,
                reuse_existing=reuse_existing,
            )
        )
    return manifest, cover_specs, base_track_path


def resolve_scan_cache_selection(runtime_config: dict[str, Any]) -> dict[str, Any]:
    from music_app.services.persistence_selection import select_runtime_persistence_adapter

    selection = select_runtime_persistence_adapter("scan_cache", runtime_config)
    return {
        "requestedBackend": selection.requested_backend,
        "effectiveBackend": selection.effective_backend,
        "fallbackReason": selection.fallback_reason,
        "databaseUrlConfigured": bool(str(runtime_config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()),
    }


def assert_postgres_scan_cache_selected(runtime_config: dict[str, Any]) -> None:
    selection = resolve_scan_cache_selection(runtime_config)
    if selection["effectiveBackend"] != "postgres":
        raise RuntimeError(
            "Scan performance harness requires Postgres scan_cache persistence. "
            f"Selection telemetry: {selection!r}"
        )


def assert_scan_performance_runtime_paths(runtime_config: dict[str, Any], music_dir: Path) -> None:
    expected_root = Path(music_dir).expanduser().resolve(strict=False).parent
    for key in _RUNTIME_PATH_KEYS:
        raw_value = runtime_config.get(key)
        if not str(raw_value or "").strip():
            raise RuntimeError(f"Scan performance harness requires runtime config {key} under {expected_root}.")
        resolved_value = Path(str(raw_value)).expanduser().resolve(strict=False)
        try:
            resolved_value.relative_to(expected_root)
        except Exception as exc:
            raise RuntimeError(
                "Scan performance harness runtime config escaped the isolated temp root: "
                f"{key}={resolved_value} is not under {expected_root}."
            ) from exc


def update_album_tags(album_entry: dict[str, Any], *, new_album_name: str, new_year: int) -> None:
    for index, raw_track_path in enumerate(list(album_entry.get("track_paths") or []), start=1):
        track_path = Path(str(raw_track_path))
        write_track_tags(
            track_path,
            artist=str(album_entry["artist"]),
            album=new_album_name,
            title=f"{new_album_name} Track {index}",
            track_number=index,
            year=new_year,
        )
    album_entry["album"] = new_album_name
    album_entry["year"] = new_year


def _runtime_config() -> dict[str, Any]:
    from config import APP_NAME, APP_VERSION, Config

    config = {key: value for key, value in vars(Config).items() if key.isupper()}
    config["APP_NAME"] = APP_NAME
    config["APP_VERSION"] = APP_VERSION
    return config


def _seed_baseline_scan_snapshot(
    runtime_config: dict[str, Any],
    music_dir: Path,
    *,
    last_scan_marker: float,
) -> None:
    from music_app.services.library_indexing import scan_library_file_cache
    from music_app.services.library_roots import get_library_roots, library_root_cache_identity
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
    library_state: dict[str, Any] = {
        "albums": [],
        "file_cache": {},
        "separate_release_keys": set(),
        "scan_in_progress": True,
        "scan_generation": 1,
        "scan_started_at": time.time(),
    }
    root_definitions = get_library_roots(runtime_config)
    file_cache, _scanned_at = scan_library_file_cache(
        library_state,
        roots=[music_dir],
        supported_extensions=set(runtime_config["SUPPORTED_EXTENSIONS"]),
        image_extensions=set(runtime_config["IMAGE_EXTENSIONS"]),
        exception_overrides={},
        use_existing_cache=False,
        expected_scan_generation=1,
        root_definitions=root_definitions,
    )
    committed_relation_state = PostgresScanCacheAdapter(runtime_config).save_snapshot(
        Path(str(runtime_config["CACHE_PATH"])),
        file_cache,
        library_root_cache_identity(runtime_config),
        last_scan_marker,
        rebuild_relation_projection=True,
    )
    if not isinstance(committed_relation_state, dict) or not isinstance(
        committed_relation_state.get("relation_views"),
        dict,
    ):
        raise RuntimeError(
            "Scan performance baseline publication returned no canonical relation projection."
        )


def prepare_scan_scenario(
    scenario: str,
    music_dir: Path,
    library_manifest: list[dict[str, Any]],
    cover_specs: list[dict[str, Any]],
    base_track_path: Path,
) -> dict[str, Any]:
    normalized_scenario = str(scenario or "").strip().lower()
    if normalized_scenario not in _SCAN_SCENARIOS:
        raise ValueError(f"Unknown scan performance scenario: {scenario!r}.")
    runtime_config = _runtime_config()
    assert_scan_performance_runtime_paths(runtime_config, music_dir)
    assert_postgres_scan_cache_selected(runtime_config)
    if normalized_scenario != "cold":
        last_scan_marker = (
            _CACHED_LAST_SCAN_MARKER
            if normalized_scenario == "cached"
            else time.time()
        )
        _seed_baseline_scan_snapshot(
            runtime_config,
            music_dir,
            last_scan_marker=last_scan_marker,
        )
    if normalized_scenario == "add-album":
        next_index = len(library_manifest)
        added_album = build_album_fixture(
            library_root=music_dir,
            base_track_path=base_track_path,
            cover_specs=cover_specs,
            artist_index=next_index // _ALBUMS_PER_ARTIST,
            album_index=next_index,
        )
        added_cover_path = Path(str(added_album.get("cover_path") or "")).resolve(strict=False)
        if (
            added_cover_path.is_file()
            and added_cover_path.is_relative_to(music_dir.resolve(strict=False))
        ):
            added_cover_path.unlink()
        library_manifest.append(added_album)
    elif normalized_scenario == "metadata":
        update_album_tags(library_manifest[0], new_album_name="Album 001 Metadata Updated", new_year=2031)
    return {
        "scenario": normalized_scenario,
        "album_count": len(library_manifest),
        "changed_album_name": "Album 001 Metadata Updated" if normalized_scenario == "metadata" else "",
        "added_album_name": album_folder_name(_TOTAL_ALBUMS) if normalized_scenario == "add-album" else "",
    }


def create_scan_performance_asgi_app(scenario: str = "cold"):
    if MutagenFile is None:
        raise RuntimeError("Mutagen is required to prepare the scan performance app.")
    music_dir = configure_environment(scenario)
    assert_scan_performance_provider_isolation()
    reuse_existing = str(os.environ.get("ALBUM_HAVEN_E2E_REUSE_STATE") or "").strip() == "1"
    if reuse_existing:
        restore_reused_scan_library_baseline(music_dir)
    library_manifest, cover_specs, base_track_path = (
        build_scan_library(music_dir, reuse_existing=True)
        if reuse_existing
        else build_scan_library(music_dir)
    )
    prepare_scan_scenario(scenario, music_dir, library_manifest, cover_specs, base_track_path)

    from music_app import create_asgi_app
    return create_asgi_app()


class ProductionStatusFileSampler:
    def __init__(
        self,
        *,
        status_url: str,
        samples_path: Path,
        interval_seconds: float = 0.05,
        request_timeout_seconds: float = 2.0,
    ) -> None:
        self.status_url = status_url
        self.samples_path = samples_path
        self.interval_seconds = min(0.05, max(0.005, float(interval_seconds)))
        self.request_timeout_seconds = max(0.1, float(request_timeout_seconds))
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.error: Exception | None = None
        self._observed_response = False

    def start(self) -> None:
        self.samples_path.parent.mkdir(parents=True, exist_ok=True)
        self.samples_path.write_text("", encoding="utf-8")
        self._thread = threading.Thread(target=self._run, name="scan-production-status-sampler", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        try:
            with self.samples_path.open("a", encoding="utf-8", buffering=1) as stream:
                while not self._stop.is_set():
                    try:
                        with urllib.request.urlopen(
                            self.status_url,
                            timeout=self.request_timeout_seconds,
                        ) as response:
                            payload = json.loads(response.read().decode("utf-8"))
                        self._observed_response = True
                        stream.write(json.dumps({
                            "recordedAtEpochMs": int(time.time() * 1000),
                            "status": payload,
                        }, separators=(",", ":")) + "\n")
                    except (urllib.error.URLError, TimeoutError, ConnectionError):
                        if self._observed_response:
                            raise
                    self._stop.wait(self.interval_seconds)
        except Exception as exc:
            self.error = exc
            try:
                self._persist_error_event(exc)
            except Exception as persist_exc:
                self.error = RuntimeError(f"{exc}; error event persistence also failed: {persist_exc}")
        finally:
            if not self._stop.is_set() and self.error is None:
                unexpected_stop = RuntimeError("Production status sampler stopped unexpectedly.")
                self.error = unexpected_stop
                try:
                    self._persist_error_event(unexpected_stop)
                except Exception as persist_exc:
                    self.error = RuntimeError(
                        f"{unexpected_stop}; error event persistence also failed: {persist_exc}"
                    )

    def _persist_error_event(self, error: Exception) -> None:
        with self.samples_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({
                "recordedAtEpochMs": int(time.time() * 1000),
                "event": "error",
                "error": str(error),
            }, separators=(",", ":")) + "\n")
            stream.flush()
            os.fsync(stream.fileno())

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            if self._thread.is_alive():
                raise RuntimeError("Production status sampler did not stop within 2 seconds.")
            self._thread = None
        if self.error is not None:
            error = self.error
            self.error = None
            raise RuntimeError(f"Production status sampler failed: {error}") from error


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=4174)
    parser.add_argument("--scenario")
    parser.add_argument("--preflight-only", action="store_true")
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    if args.preflight_only:
        preflight_scan_performance_database_connections()
        print("Scan performance database preflight passed.", flush=True)
        return
    if args.prepare_only:
        music_dir = configure_environment("cold")
        assert_scan_performance_provider_isolation()
        build_scan_library(music_dir)
        print(f"Prepared scan performance fixture at {music_dir}.", flush=True)
        return
    environment_scenario = str(os.environ.pop(_SCAN_SCENARIO_ENV, "")).strip()
    scenario = str(args.scenario or environment_scenario or "cold").strip().lower()
    raw_samples_path = str(os.environ.pop(_SCAN_STATUS_SAMPLES_ENV, "")).strip()
    if not raw_samples_path:
        raise RuntimeError(f"{_SCAN_STATUS_SAMPLES_ENV} is required for scan performance launch sampling.")
    status_sampler = ProductionStatusFileSampler(
        status_url=f"http://127.0.0.1:{args.port}/status",
        samples_path=Path(raw_samples_path).expanduser().resolve(strict=False),
    )

    setup_database_url, _runtime_database_url = resolve_scan_performance_database_urls()
    database_lock = _scan_database_lock(setup_database_url)
    original_failure: BaseException | None = None
    cleanup_failure: Exception | None = None
    try:
        install_shutdown_handlers()
        database_lock.acquire()
        status_sampler.start()
        app = create_scan_performance_asgi_app(scenario)

        print(
            f"Album Haven scan benchmark app listening on http://127.0.0.1:{args.port} "
            f"with {_TOTAL_ALBUMS} albums across {_ARTIST_COUNT} artists and "
            f"{_TRACKS_PER_ALBUM} tracks per album for scenario {scenario}",
            flush=True,
        )
        import uvicorn

        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
    except BaseException as exc:
        original_failure = exc
        raise
    finally:
        try:
            status_sampler.stop()
        except Exception as sampler_exc:
            if original_failure is not None:
                print(f"Scan production status sampler cleanup failed: {sampler_exc}", file=sys.stderr)
            elif cleanup_failure is None:
                cleanup_failure = sampler_exc
        if str(os.environ.get("ALBUM_HAVEN_E2E_PRESERVE_ON_SHUTDOWN") or "").strip() != "1":
            cleanup_temp_root()
        try:
            database_lock.release()
        except Exception as cleanup_exc:
            cleanup_failure = cleanup_exc
            if original_failure is not None:
                print(f"Scan database lock cleanup failed: {cleanup_exc}", file=sys.stderr)
        if original_failure is None and cleanup_failure is not None:
            raise cleanup_failure


if __name__ == "__main__":
    main()
