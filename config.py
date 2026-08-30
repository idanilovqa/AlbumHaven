import os
import sys
from pathlib import Path

from music_app.services.musicbrainz_http import default_user_agent
from music_app.services.cover_provider_groups import (
    normalize_cover_provider_groups,
    normalize_enabled_music_services,
)
from music_app.services.cover_provider_deadline import (
    DEFAULT_COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS,
)
from version import RELEASE_VERSION

APP_NAME = "Album Haven"
APP_VERSION = RELEASE_VERSION
PERSISTENCE_BACKEND_FILE = "file"
PERSISTENCE_BACKEND_POSTGRES = "postgres"
PERSISTENCE_BACKEND_VALUES = frozenset(
    {PERSISTENCE_BACKEND_FILE, PERSISTENCE_BACKEND_POSTGRES}
)
PERSISTENCE_SEAM_IDS = (
    "library_roots",
    "ignored_versions",
    "ignored_repairs",
    "manual_versions",
    "separate_releases",
    "exception_overrides",
    "lastfm_settings",
    "lastfm_sync_state",
    "listen_history",
    "track_preferences",
    "library_inventory",
    "library_browse",
    "scan_cache",
    "cover_lookup_tasks",
    "saved_loops",
    "discovery_center_preferences",
    "discovery_lookup_snapshots",
)


def _persistence_env_key(seam_id: str) -> str:
    return f"ALBUM_HAVEN_PERSISTENCE_{seam_id.upper()}"


def _normalize_persistence_backend(value: object, *, env_key: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized not in PERSISTENCE_BACKEND_VALUES:
        allowed = ", ".join(sorted(PERSISTENCE_BACKEND_VALUES))
        raise ValueError(f"{env_key} must be one of: {allowed}.")
    if normalized == PERSISTENCE_BACKEND_FILE:
        raise ValueError(
            f"{env_key}=file is not supported for runtime persistence; "
            "Album Haven runtime persistence is Postgres-only."
        )
    return normalized


def build_persistence_backend_config(environ: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ if environ is None else environ
    default_backend = _normalize_persistence_backend(
        env.get("ALBUM_HAVEN_PERSISTENCE_DEFAULT", PERSISTENCE_BACKEND_POSTGRES),
        env_key="ALBUM_HAVEN_PERSISTENCE_DEFAULT",
    )
    backends = {seam_id: default_backend for seam_id in PERSISTENCE_SEAM_IDS}
    for seam_id in PERSISTENCE_SEAM_IDS:
        env_key = _persistence_env_key(seam_id)
        if env_key not in env:
            continue
        backends[seam_id] = _normalize_persistence_backend(env.get(env_key), env_key=env_key)
    return backends


def persistence_backend_for(seam_id: str, config: dict[str, object] | None = None) -> str:
    normalized_seam_id = str(seam_id or "").strip()
    if normalized_seam_id not in PERSISTENCE_SEAM_IDS:
        raise ValueError(f"Unknown persistence seam: {normalized_seam_id}")
    source = Config if config is None else config
    backends = (
        source.get("PERSISTENCE_BACKENDS")
        if isinstance(source, dict)
        else getattr(source, "PERSISTENCE_BACKENDS", None)
    )
    if not isinstance(backends, dict):
        backends = build_persistence_backend_config()
    return _normalize_persistence_backend(
        backends.get(normalized_seam_id, PERSISTENCE_BACKEND_POSTGRES),
        env_key=_persistence_env_key(normalized_seam_id),
    )


def runtime_app_database_url_from_env(environ: dict[str, str] | None = None) -> str:
    env = os.environ if environ is None else environ
    return str(env.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()


def _parse_env_value(raw_value: str) -> str:
    value = str(raw_value or "").strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def load_dotenv_file(dotenv_path: Path) -> None:
    try:
        if not dotenv_path.is_file():
            return
        for raw_line in dotenv_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env_key = str(key or "").strip()
            if not env_key or env_key in os.environ:
                continue
            os.environ[env_key] = _parse_env_value(value)
    except Exception:
        pass


load_dotenv_file(Path(__file__).resolve().with_name(".env"))


def _resolved_path(path: Path) -> Path:
    return path.expanduser().resolve(strict=False)


def _repo_local_data_dir() -> Path:
    return Path(__file__).resolve().with_name(".localappdata") / APP_NAME


def _warn_path_fallback(kind: str, preferred_path: Path, fallback_path: Path, exc: Exception) -> None:
    print(
        (
            f"{APP_NAME} {kind} path fallback: "
            f"{preferred_path!s} -> {fallback_path!s} "
            f"because {exc!r}"
        ),
        file=sys.stderr,
    )


def _ensure_usable_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    if not path.is_dir():
        raise NotADirectoryError(path)
    probe_path = path / ".album_haven_write_probe"
    probe_path.write_text("ok", encoding="utf-8")
    probe_path.unlink()
    return path


def _resolve_data_dir(preferred_path: Path) -> Path:
    resolved_preferred = _resolved_path(preferred_path)
    try:
        return _ensure_usable_directory(resolved_preferred)
    except (FileExistsError, PermissionError, OSError) as exc:
        fallback_path = _resolved_path(_repo_local_data_dir())
        _warn_path_fallback("data", resolved_preferred, fallback_path, exc)
        return _ensure_usable_directory(fallback_path)


def _resolve_data_file_path(preferred_path: Path, fallback_path: Path, *, kind: str) -> Path:
    resolved_preferred = _resolved_path(preferred_path)
    try:
        _ensure_usable_directory(resolved_preferred.parent)
        if resolved_preferred.exists() and not resolved_preferred.is_file():
            raise IsADirectoryError(resolved_preferred)
        return resolved_preferred
    except (FileExistsError, PermissionError, OSError) as exc:
        resolved_fallback = _resolved_path(fallback_path)
        _warn_path_fallback(kind, resolved_preferred, resolved_fallback, exc)
        _ensure_usable_directory(resolved_fallback.parent)
        return resolved_fallback

def get_default_data_dir() -> Path:
    if sys.platform.startswith("win"):
        local_appdata = os.environ.get("LOCALAPPDATA")
        if local_appdata:
            return Path(local_appdata) / APP_NAME
    xdg_data_home = os.environ.get("XDG_DATA_HOME")
    if xdg_data_home:
        return Path(xdg_data_home) / APP_NAME.lower()
    return Path.home() / ".local" / "share" / APP_NAME.lower()

class Config:
    _configured_music_dir = str(os.environ.get("MUSIC_DIR") or "").strip()
    MUSIC_DIR = _resolved_path(Path(_configured_music_dir)) if _configured_music_dir else None
    DATA_DIR = _resolve_data_dir(Path(os.environ.get("MUSIC_APP_DATA_DIR", str(get_default_data_dir()))))
    CACHE_PATH = _resolve_data_file_path(
        Path(os.environ.get("MUSIC_CACHE_PATH", str(DATA_DIR / "library_cache.json"))),
        DATA_DIR / "library_cache.json",
        kind="library cache",
    )
    COVER_CACHE_PATH = _resolve_data_file_path(
        Path(os.environ.get("MUSIC_COVER_CACHE_PATH", str(DATA_DIR / "cover_search_cache.json"))),
        DATA_DIR / "cover_search_cache.json",
        kind="cover cache",
    )
    BULK_COVER_NEGATIVE_CACHE_TTL_SECONDS = max(
        0.0,
        float(os.environ.get("MUSIC_BULK_COVER_NEGATIVE_CACHE_TTL_SECONDS", str(60 * 60 * 12))),
    )
    BULK_COVER_JOB_WORKERS = max(
        1,
        int(os.environ.get("MUSIC_BULK_COVER_JOB_WORKERS", "1")),
    )
    LIBRARY_ROOTS_PATH = _resolve_data_file_path(
        Path(os.environ.get("MUSIC_LIBRARY_ROOTS_PATH", str(DATA_DIR / "library_roots.json"))),
        DATA_DIR / "library_roots.json",
        kind="library roots",
    )
    CACHE_MAX_AGE_SECONDS = int(os.environ.get("MUSIC_CACHE_MAX_AGE_SECONDS", "0"))
    SUPPORTED_EXTENSIONS = {".mp3", ".flac", ".m4a", ".aac", ".ogg", ".wav"}
    IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
    COVER_PROVIDER_GROUPS = normalize_cover_provider_groups(
        os.environ.get("ALBUM_HAVEN_COVER_PROVIDER_GROUPS")
    )
    COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS = float(
        os.environ.get(
            "COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS",
            str(DEFAULT_COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS),
        )
    )
    ENABLED_MUSIC_SERVICES = normalize_enabled_music_services(
        os.environ.get("ALBUM_HAVEN_ENABLED_MUSIC_SERVICES")
    )
    MUSICBRAINZ_ENABLED = os.environ.get("MUSICBRAINZ_ENABLED", "1").strip().lower() not in {"0", "false", "no"}
    MUSICBRAINZ_CONTACT_EMAIL = os.environ.get("MUSICBRAINZ_CONTACT_EMAIL", "albumhaven@example.com").strip()
    MUSICBRAINZ_USER_AGENT = os.environ.get(
        "MUSICBRAINZ_USER_AGENT",
        default_user_agent(APP_NAME, APP_VERSION, MUSICBRAINZ_CONTACT_EMAIL),
    ).strip()
    APPLE_API_BASE_URL = os.environ.get("APPLE_API_BASE_URL", "https://itunes.apple.com").strip().rstrip("/")
    DUCKDUCKGO_SEARCH_BASE_URL = os.environ.get(
        "DUCKDUCKGO_SEARCH_BASE_URL",
        "https://duckduckgo.com/html/",
    ).strip()
    BING_SEARCH_BASE_URL = os.environ.get(
        "BING_SEARCH_BASE_URL",
        "https://www.bing.com/search",
    ).strip()
    MUSICBRAINZ_BASE_URL = os.environ.get(
        "MUSICBRAINZ_BASE_URL",
        "https://musicbrainz.org/ws/2",
    ).strip().rstrip("/")
    COVER_ART_ARCHIVE_BASE_URL = os.environ.get(
        "COVER_ART_ARCHIVE_BASE_URL",
        "https://coverartarchive.org",
    ).strip().rstrip("/")
    DISCOGS_API_BASE_URL = os.environ.get(
        "DISCOGS_API_BASE_URL",
        "https://api.discogs.com",
    ).strip().rstrip("/")
    DISCOGS_CONSUMER_KEY = os.environ.get("DISCOGS_CONSUMER_KEY", "").strip()
    DISCOGS_CONSUMER_SECRET = os.environ.get("DISCOGS_CONSUMER_SECRET", "").strip()
    DISCOGS_AUTH_ENABLED = bool(DISCOGS_CONSUMER_KEY and DISCOGS_CONSUMER_SECRET)
    SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "").strip()
    SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "").strip()
    SPOTIFY_MARKET = os.environ.get("SPOTIFY_MARKET", "US").strip().upper() or "US"
    SPOTIFY_API_ENABLED = bool(SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET)
    LASTFM_API_KEY = os.environ.get("LASTFM_API_KEY", "").strip()
    LASTFM_API_SECRET = os.environ.get("LASTFM_API_SECRET", "").strip()
    LASTFM_API_ROOT = os.environ.get("LASTFM_API_ROOT", "https://ws.audioscrobbler.com/2.0/").strip()
    LASTFM_API_ENABLED = bool(LASTFM_API_KEY and LASTFM_API_SECRET)
    ALBUM_HAVEN_UTILITY_PROJECTION_PREWARM_ENABLED = (
        os.environ.get("ALBUM_HAVEN_UTILITY_PROJECTION_PREWARM_ENABLED", "1")
        .strip()
        .lower()
        not in {"0", "false", "no"}
    )
    ALBUM_HAVEN_APP_DATABASE_URL = runtime_app_database_url_from_env()
    PERSISTENCE_BACKENDS = build_persistence_backend_config()
