from __future__ import annotations

from copy import deepcopy
import logging
from pathlib import Path
from threading import Event, Thread
from types import SimpleNamespace

from config import Config
from music_app.services.library_roots import library_root_cache_identity, save_library_root_settings
from music_app.services import library_indexing, scan_state, state as state_module
from music_app.services.metadata import FILE_METADATA_SCHEMA_VERSION
from tests.py.runtime_testing import configure_test_app_paths

import pytest


class FakePsycopg:
    def connect(self):
        raise AssertionError("availability should not open a database connection")


class FakePostgresLibraryRootSettingsStore:
    _settings_by_config_id: dict[int, dict[str, object]] = {}

    def __init__(self, config):
        self.config = config

    @classmethod
    def reset(cls) -> None:
        cls._settings_by_config_id = {}

    def load_settings(self) -> dict[str, object]:
        return deepcopy(self._current_settings())

    def save_settings(self, raw_payload) -> dict[str, object]:
        from music_app.services.library_roots import normalize_library_root_settings

        settings = normalize_library_root_settings(
            raw_payload,
            fallback_main_root=Path(self.config["MUSIC_DIR"]).resolve(strict=False),
        )
        self._settings_by_config_id[id(self.config)] = settings
        return deepcopy(settings)

    def _current_settings(self) -> dict[str, object]:
        config_id = id(self.config)
        if config_id not in self._settings_by_config_id:
            self._settings_by_config_id[config_id] = {
                "version": 1,
                "main_library_roots": [{
                    "id": "main-library-root-1",
                    "path": str(Path(self.config["MUSIC_DIR"]).resolve(strict=False)),
                    "layout_mode": "artist",
                }],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
                "move_policy": {},
            }
        return self._settings_by_config_id[config_id]


class FakeScanCacheAdapter:
    backend = "postgres"

    def __init__(
        self,
        *,
        file_cache: dict[str, dict[str, object]] | None = None,
        last_scan: float = 0.0,
        relation_views: dict[str, object] | None = None,
        relations_last_built: float = 0.0,
        root_identity: str | None = None,
        error: str | None = None,
    ):
        self.file_cache = deepcopy(file_cache or {})
        self.last_scan = last_scan
        self.relation_views = deepcopy(relation_views or {})
        self.relations_last_built = relations_last_built
        self.root_identity = root_identity
        self.error = error
        self.calls: list[tuple[str, object]] = []

    def load_snapshot(self, cache_path, root_identity):
        self.calls.append(("load", cache_path, root_identity))
        if self.root_identity is not None and self.root_identity != root_identity:
            return {}, 0.0, {}, 0.0, None
        return (
            deepcopy(self.file_cache),
            self.last_scan,
            deepcopy(self.relation_views),
            self.relations_last_built,
            self.error,
        )

    def save_snapshot(self, cache_path, file_cache, root_identity, last_scan, **kwargs):
        self.calls.append(("save", cache_path, deepcopy(file_cache), root_identity, last_scan, kwargs))
        self.file_cache = deepcopy(file_cache)
        self.last_scan = last_scan
        self.root_identity = root_identity


@pytest.fixture
def runtime_config(tmp_path, monkeypatch):
    paths = configure_test_app_paths(tmp_path, monkeypatch)
    paths["data_dir"].mkdir(parents=True, exist_ok=True)
    paths["music_dir"].mkdir(parents=True, exist_ok=True)
    config = {
        name: getattr(Config, name)
        for name in dir(Config)
        if name.isupper()
    }
    config.update({
        "DATA_DIR": paths["data_dir"],
        "MUSIC_DIR": paths["music_dir"],
        "CACHE_PATH": paths["cache_path"],
        "COVER_CACHE_PATH": paths["cover_cache_path"],
        "LIBRARY_ROOTS_PATH": paths["library_roots_path"],
        "TESTING": True,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {
            **dict(config.get("PERSISTENCE_BACKENDS") or {}),
            "library_roots": "postgres",
            "scan_cache": "postgres",
        },
    })
    return config


@pytest.fixture
def runtime_logger():
    return logging.getLogger("tests.scan_state")


@pytest.fixture
def library_state(runtime_config, runtime_logger):
    carrier = SimpleNamespace(config=runtime_config, logger=runtime_logger)
    state_module.init_state(carrier)
    return carrier.library_state


@pytest.fixture(autouse=True)
def postgres_runtime_fakes(runtime_config, monkeypatch):
    FakePostgresLibraryRootSettingsStore.reset()
    runtime_config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    runtime_config["PERSISTENCE_BACKENDS"] = {
        **dict(runtime_config.get("PERSISTENCE_BACKENDS") or {}),
        "library_roots": "postgres",
        "scan_cache": "postgres",
    }
    monkeypatch.setattr("music_app.services.library_roots_postgres.psycopg", FakePsycopg())
    monkeypatch.setattr("music_app.services.scan_cache_persistence.psycopg", FakePsycopg())
    monkeypatch.setattr(
        "music_app.services.library_roots.PostgresLibraryRootSettingsStore",
        FakePostgresLibraryRootSettingsStore,
    )


def test_scan_state_tests_do_not_depend_on_flask_runtime_helpers():
    source = Path(__file__).read_text(encoding="utf-8")
    forbidden_terms = [
        "tests.py." "flask_" "fixtures",
        "from " "fl" "ask",
        "has_" "app_" "context",
        ".app_" "context(",
        "app." "config",
        "app." "logger",
        "app." "library_state",
        "cli" "ent",
    ]

    assert not [term for term in forbidden_terms if term in source]


def _install_scan_cache_adapter(monkeypatch, adapter: FakeScanCacheAdapter | None = None) -> FakeScanCacheAdapter:
    adapter = adapter or FakeScanCacheAdapter()
    monkeypatch.setattr(scan_state, "_scan_cache_adapter", lambda cfg: adapter)
    return adapter


def test_finalize_post_scan_actions_prefers_pending_manual_refresh(monkeypatch):
    manual_calls = []
    background_calls = []
    logged = []
    config = {"LOG_EVENTS": True}
    logger = SimpleNamespace(name="explicit-scan-logger")
    library_state = {
        "pending_cover_refresh_after_scan": True,
        "pending_cover_refresh_force_search": True,
        "albums": [SimpleNamespace(key="album-1")],
    }

    monkeypatch.setattr(scan_state, "log_app_event", lambda *args, **kwargs: logged.append((args, kwargs)))

    scan_state.finalize_post_scan_actions(
        library_state,
        config=config,
        logger=logger,
        previous_album_keys=set(),
        start_manual_cover_refresh=lambda *, force_search=False: manual_calls.append(force_search) or {"started": True},
        start_background_cover_refresh=lambda: background_calls.append(True),
    )

    assert manual_calls == [True]
    assert background_calls == []
    assert library_state["pending_cover_refresh_after_scan"] is False
    assert library_state["pending_cover_refresh_force_search"] is False
    assert logged == [(
        (config, logger, "Cover art refresh queued after indexing"),
        {"level": "info", "reason": "pending_manual_cover_refresh", "force_search": True},
    )]


def test_finalize_post_scan_actions_starts_background_refresh_for_new_albums(monkeypatch):
    background_calls = []
    logged = []
    config = {"LOG_EVENTS": True}
    logger = SimpleNamespace(name="explicit-scan-logger")
    library_state = {
        "pending_cover_refresh_after_scan": False,
        "pending_cover_refresh_force_search": False,
        "albums": [SimpleNamespace(key="album-1"), SimpleNamespace(key="album-2")],
    }

    monkeypatch.setattr(scan_state, "log_app_event", lambda *args, **kwargs: logged.append((args, kwargs)))

    scan_state.finalize_post_scan_actions(
        library_state,
        config=config,
        logger=logger,
        previous_album_keys={"album-1"},
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: background_calls.append(True),
    )

    assert background_calls == [True]
    assert logged == [(
        (config, logger, "Cover art refresh queued after indexing"),
        {"level": "info", "added_album_count": 1},
    )]


def test_finalize_post_scan_actions_checks_existing_albums_for_automatic_cover_candidates(monkeypatch):
    logged = []
    background_calls = []
    config = {"LOG_EVENTS": True}
    logger = SimpleNamespace(name="explicit-scan-logger")
    library_state = {
        "pending_cover_refresh_after_scan": False,
        "pending_cover_refresh_force_search": False,
        "albums": [SimpleNamespace(key="album-1")],
    }

    monkeypatch.setattr(scan_state, "log_app_event", lambda *args, **kwargs: logged.append((args, kwargs)))

    scan_state.finalize_post_scan_actions(
        library_state,
        config=config,
        logger=logger,
        previous_album_keys={"album-1"},
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: background_calls.append(True),
    )

    assert background_calls == [True]
    assert logged == [(
        (config, logger, "Cover art refresh queued after indexing"),
        {"level": "info", "reason": "automatic_candidate_refresh"},
    )]


def test_refresh_library_state_skips_scan_for_fresh_cache_and_repairs_relations(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    relation_calls = []
    scan_calls = []
    logged = []

    library_state.update({
        "file_cache": {"track-1": {"album": "Album"}},
        "albums": [SimpleNamespace(key="album-1")],
        "last_scan": scan_state.time.time(),
        "relation_views": {"artists": []},
    })

    _install_scan_cache_adapter(monkeypatch)
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda cfg: {"separate"})
    monkeypatch.setattr(scan_state, "log_app_event", lambda *args, **kwargs: logged.append(kwargs))

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=False,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **kwargs: scan_calls.append(kwargs) or ({}, 0.0),
        refresh_relation_views=lambda *, seed_missing_album_ratings=False, expected_scan_generation=None, publication_state=None: relation_calls.append(True),
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert scan_calls == []
    assert relation_calls == [True]
    assert library_state["scan_in_progress"] is False
    assert library_state["scan_outcome"] == "completed"
    assert library_state["separate_release_keys"] == {"separate"}
    assert logged == [
        {"level": "info", "force": False},
        {"level": "info", "reason": "cache_fresh"},
    ]


def test_refresh_library_state_skip_path_uses_explicit_dependencies_without_flask_context(runtime_config, monkeypatch):
    scan_calls = []
    logged = []
    logger = SimpleNamespace(name="explicit-scan-logger")
    library_state = {
        "file_cache": {"track-1": {"album": "Album"}},
        "albums": [SimpleNamespace(key="album-1")],
        "last_scan": scan_state.time.time(),
        "relation_views": {"artists": ["Artist"]},
        "scan_generation": 0,
        "scan_in_progress": True,
        "scan_mode": "background",
    }

    _install_scan_cache_adapter(monkeypatch)
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda cfg: {"separate"})
    monkeypatch.setattr(scan_state, "log_app_event", lambda *args, **kwargs: logged.append((args, kwargs)))

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=logger,
        force=False,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **kwargs: scan_calls.append(kwargs) or ({}, 0.0),
        refresh_relation_views=lambda *, seed_missing_album_ratings=False: None,
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert scan_calls == []
    assert library_state["scan_in_progress"] is False
    assert library_state["scan_outcome"] == "completed"
    assert library_state["separate_release_keys"] == {"separate"}
    assert logged == [
        ((runtime_config, logger, "Library indexing started"), {"level": "info", "force": False}),
        ((runtime_config, logger, "Library indexing skipped"), {"level": "info", "reason": "cache_fresh"}),
    ]


def test_refresh_library_state_skips_scan_for_fresh_disk_cache_after_restart(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    relation_calls = []
    scan_calls = []
    logged = []
    prewarm_calls = []
    rebuilt_albums = [SimpleNamespace(key="album-from-disk")]
    disk_last_scan = scan_state.time.time()

    track_path = runtime_config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"song-bytes")
    disk_file_cache = {
        str(track_path): {
            "path": str(track_path),
            "mtime": float(track_path.stat().st_mtime),
            "size": int(track_path.stat().st_size),
            "album": "Album",
            "album_artist": "Artist",
            "title": "Song",
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
            "artist": "Artist",
            "duration_seconds": 60,
            "cover_path": None,
            "local_cover_width": None,
            "local_cover_height": None,
            "remote_cover_url": None,
            "remote_cover_thumbnail_url": None,
            "remote_cover_source": None,
            "remote_cover_source_label": None,
            "remote_cover_album_url": None,
            "remote_cover_width": None,
            "remote_cover_height": None,
            "year": 1999,
            "edition": "",
            "album_rating": 0,
            "library_root_id": None,
            "library_root_category": None,
            "exception_type": None,
        }
    }
    _install_scan_cache_adapter(
        monkeypatch,
        FakeScanCacheAdapter(
            file_cache=disk_file_cache,
            last_scan=disk_last_scan,
            root_identity=library_root_cache_identity(runtime_config),
        ),
    )
    library_state.update({
        "file_cache": {},
        "albums": [],
        "last_scan": 0.0,
        "relation_views": {"artists": []},
        "scan_in_progress": True,
        "scan_mode": "background",
    })

    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda cfg: {"separate"})
    monkeypatch.setattr(scan_state, "build_albums_from_file_cache", lambda file_cache, separate_keys: rebuilt_albums)
    monkeypatch.setattr(scan_state, "log_app_event", lambda *args, **kwargs: logged.append(kwargs))

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=False,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **kwargs: scan_calls.append(kwargs) or ({}, 0.0),
        refresh_relation_views=lambda *, seed_missing_album_ratings=False, expected_scan_generation=None, publication_state=None: relation_calls.append(True),
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
        queue_problematic_albums_prewarm=lambda: prewarm_calls.append(True),
    )

    assert scan_calls == []
    assert relation_calls == [True]
    assert prewarm_calls == [True]
    assert library_state["file_cache"] == disk_file_cache
    assert library_state["albums"] == rebuilt_albums
    assert library_state["last_scan"] == disk_last_scan
    assert library_state["scan_in_progress"] is False
    assert library_state["scan_mode"] == "idle"
    assert library_state["scan_outcome"] == "completed"
    assert logged == [
        {"level": "info", "force": False},
        {"level": "info", "reason": "cache_fresh_on_disk"},
    ]


def test_refresh_library_state_reuses_persisted_relation_views_after_restart(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    relation_calls = []
    scan_calls = []
    rebuilt_albums = [SimpleNamespace(key="album-from-disk")]
    disk_last_scan = scan_state.time.time()
    persisted_relation_views = {
        "artists": ["Artist"],
        "artists_sidebar": [{"artist": "Artist", "count": 1}],
        "family_to_artists": {"Family": {"Artist", "Guest"}},
        "folder_related": {"Artist": {"Guest"}},
        "sidebar_families": [{"family": "Family", "artists": ["Artist", "Guest"], "count": 2}],
        "alias_to_canonical": {"Artist": "Artist"},
        "canonical_to_aliases": {"Artist": ["Artist"]},
    }

    track_path = runtime_config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"song-bytes")
    disk_file_cache = {
        str(track_path): {
            "path": str(track_path),
            "mtime": float(track_path.stat().st_mtime),
            "size": int(track_path.stat().st_size),
            "album": "Album",
            "album_artist": "Artist",
            "title": "Song",
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
            "artist": "Artist",
            "duration_seconds": 60,
            "cover_path": None,
            "local_cover_width": None,
            "local_cover_height": None,
            "remote_cover_url": None,
            "remote_cover_thumbnail_url": None,
            "remote_cover_source": None,
            "remote_cover_source_label": None,
            "remote_cover_album_url": None,
            "remote_cover_width": None,
            "remote_cover_height": None,
            "year": 1999,
            "edition": "",
            "album_rating": 0,
            "library_root_id": None,
            "library_root_category": None,
            "exception_type": None,
        }
    }
    _install_scan_cache_adapter(
        monkeypatch,
        FakeScanCacheAdapter(
            file_cache=disk_file_cache,
            last_scan=disk_last_scan,
            relation_views=persisted_relation_views,
            relations_last_built=21.0,
            root_identity=library_root_cache_identity(runtime_config),
        ),
    )
    library_state.update({
        "file_cache": {},
        "albums": [],
        "last_scan": 0.0,
        "relation_views": {"artists": []},
        "scan_in_progress": True,
        "scan_mode": "background",
    })

    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda cfg: {"separate"})
    monkeypatch.setattr(scan_state, "build_albums_from_file_cache", lambda file_cache, separate_keys: rebuilt_albums)

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=False,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **kwargs: scan_calls.append(kwargs) or ({}, 0.0),
        refresh_relation_views=lambda *, seed_missing_album_ratings=False, expected_scan_generation=None, publication_state=None: relation_calls.append(True),
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert scan_calls == []
    assert relation_calls == []
    assert library_state["relation_views"] == persisted_relation_views
    assert library_state["relations_last_built"] == 21.0
    assert library_state["albums"] == rebuilt_albums
    assert library_state["scan_in_progress"] is False
    assert library_state["scan_mode"] == "idle"


def test_refresh_library_state_skips_old_disk_cache_when_ttl_is_disabled(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    relation_calls = []
    scan_calls = []
    rebuilt_albums = [SimpleNamespace(key="album-from-disk")]

    track_path = runtime_config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"song-bytes")
    disk_file_cache = {
        str(track_path): {
            "path": str(track_path),
            "mtime": float(track_path.stat().st_mtime),
            "size": int(track_path.stat().st_size),
            "album": "Album",
            "album_artist": "Artist",
            "title": "Song",
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
            "artist": "Artist",
            "duration_seconds": 60,
            "cover_path": None,
            "local_cover_width": None,
            "local_cover_height": None,
            "remote_cover_url": None,
            "remote_cover_thumbnail_url": None,
            "remote_cover_source": None,
            "remote_cover_source_label": None,
            "remote_cover_album_url": None,
            "remote_cover_width": None,
            "remote_cover_height": None,
            "year": 1999,
            "edition": "",
            "album_rating": 0,
            "library_root_id": None,
            "library_root_category": None,
            "exception_type": None,
        }
    }
    stale_scan_time = scan_state.time.time() - 86_400
    _install_scan_cache_adapter(
        monkeypatch,
        FakeScanCacheAdapter(
            file_cache=disk_file_cache,
            last_scan=stale_scan_time,
            root_identity=library_root_cache_identity(runtime_config),
        ),
    )
    library_state.update({
        "file_cache": {},
        "albums": [],
        "last_scan": 0.0,
        "relation_views": {"artists": []},
        "scan_in_progress": True,
        "scan_mode": "background",
    })
    monkeypatch.setitem(runtime_config, "CACHE_MAX_AGE_SECONDS", 0)
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda cfg: {"separate"})
    monkeypatch.setattr(scan_state, "build_albums_from_file_cache", lambda file_cache, separate_keys: rebuilt_albums)

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=False,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **kwargs: scan_calls.append(kwargs) or ({}, 0.0),
        refresh_relation_views=lambda *, seed_missing_album_ratings=False, expected_scan_generation=None: relation_calls.append(True),
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert scan_calls == []
    assert relation_calls == [True]
    assert library_state["file_cache"] == disk_file_cache
    assert library_state["albums"] == rebuilt_albums
    assert library_state["scan_in_progress"] is False
    assert library_state["scan_mode"] == "idle"


def test_refresh_library_state_rescans_old_disk_cache_when_ttl_is_positive(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    relation_calls = []
    scan_calls = []
    rebuilt_albums = [SimpleNamespace(key="album-from-rescan")]

    track_path = runtime_config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"song-bytes")
    stale_scan_time = scan_state.time.time() - 86_400
    _install_scan_cache_adapter(
        monkeypatch,
        FakeScanCacheAdapter(
            file_cache={
                str(track_path): {
                    "path": str(track_path),
                    "mtime": float(track_path.stat().st_mtime),
                    "size": int(track_path.stat().st_size),
                    "album": "Album",
                    "album_artist": "Artist",
                    "title": "Song",
                    "track_number": 1,
                    "disc_number": 1,
                    "disc_number_raw": "1",
                    "artist": "Artist",
                    "duration_seconds": 60,
                    "cover_path": None,
                    "local_cover_width": None,
                    "local_cover_height": None,
                    "remote_cover_url": None,
                    "remote_cover_thumbnail_url": None,
                    "remote_cover_source": None,
                    "remote_cover_source_label": None,
                    "remote_cover_album_url": None,
                    "remote_cover_width": None,
                    "remote_cover_height": None,
                    "year": 1999,
                    "edition": "",
                    "album_rating": 0,
                    "library_root_id": None,
                    "library_root_category": None,
                    "exception_type": None,
                }
            },
            last_scan=stale_scan_time,
            root_identity=library_root_cache_identity(runtime_config),
        ),
    )
    library_state.update({
        "file_cache": {},
        "albums": [],
        "last_scan": 0.0,
        "relation_views": {"artists": []},
    })
    monkeypatch.setitem(runtime_config, "CACHE_MAX_AGE_SECONDS", 300)
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda cfg: set())
    monkeypatch.setattr(scan_state, "build_albums_from_file_cache", lambda file_cache, separate_keys: rebuilt_albums)

    new_file_cache = {
        str(track_path): {
            "path": str(track_path),
            "mtime": float(track_path.stat().st_mtime),
            "size": int(track_path.stat().st_size),
            "album": "Album",
            "album_artist": "Artist",
            "title": "Song",
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
            "artist": "Artist",
            "duration_seconds": 60,
            "cover_path": None,
            "local_cover_width": None,
            "local_cover_height": None,
            "remote_cover_url": None,
            "remote_cover_thumbnail_url": None,
            "remote_cover_source": None,
            "remote_cover_source_label": None,
            "remote_cover_album_url": None,
            "remote_cover_width": None,
            "remote_cover_height": None,
            "year": 2000,
            "edition": "",
            "album_rating": 0,
            "library_root_id": None,
            "library_root_category": None,
            "exception_type": None,
        }
    }

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=False,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **kwargs: scan_calls.append(kwargs) or (new_file_cache, 55.0),
        refresh_relation_views=lambda *, seed_missing_album_ratings=False, expected_scan_generation=None, publication_state=None: relation_calls.append(True),
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert len(scan_calls) == 1
    assert set(scan_calls[0]) == {
        "use_existing_cache",
        "expected_scan_generation",
        "publication_state",
        "publish_partial_snapshot",
    }
    assert scan_calls[0]["use_existing_cache"] is True
    assert scan_calls[0]["expected_scan_generation"] == 1
    assert callable(scan_calls[0]["publish_partial_snapshot"])
    assert relation_calls == [True, True]
    assert library_state["file_cache"] == new_file_cache
    assert library_state["albums"] == rebuilt_albums
    assert library_state["last_scan"] == 55.0


def test_forced_scan_preview_uses_newer_hydrated_disk_snapshot_not_pre_hydration_albums(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    pre_hydration_album = SimpleNamespace(key="artist::pre-hydration")
    hydrated_album = SimpleNamespace(key="artist::hydrated-disk")
    final_album = SimpleNamespace(key="artist::final-scan")
    hydrated_albums = [hydrated_album]
    final_albums = [final_album]
    disk_file_cache = {
        "disk-track": {"path": "disk-track", "album": "Hydrated Disk Album"},
    }
    final_file_cache = {
        "final-track": {"path": "final-track", "album": "Final Scan Album"},
    }
    disk_relation_views = {"artists": ["Hydrated Artist"]}
    separate_release_keys = {"current-release"}
    follow_up_previous_albums = []
    build_calls = []
    library_state.update({
        "file_cache": {},
        "albums": [pre_hydration_album],
        "last_scan": 1.0,
        "relation_views": {"artists": []},
    })
    _install_scan_cache_adapter(
        monkeypatch,
        FakeScanCacheAdapter(
            file_cache=disk_file_cache,
            last_scan=50.0,
            relation_views=disk_relation_views,
            relations_last_built=51.0,
            root_identity=library_root_cache_identity(runtime_config),
        ),
    )
    monkeypatch.setattr(
        scan_state,
        "load_separate_release_keys",
        lambda _cfg: separate_release_keys,
    )

    def build_albums(file_cache, _separate_release_keys):
        build_calls.append(file_cache)
        if file_cache == disk_file_cache:
            return hydrated_albums
        assert file_cache is final_file_cache
        return final_albums

    monkeypatch.setattr(scan_state, "build_albums_from_file_cache", build_albums)

    def scan_after_hydration(**kwargs):
        publication_state = kwargs["publication_state"]
        preview = library_state["active_scan_preview_state"]
        browse_snapshot = preview["browse_snapshot"]
        assert preview["publication_state"] is publication_state
        assert browse_snapshot["file_cache"] is publication_state["file_cache"]
        assert browse_snapshot["file_cache"] == disk_file_cache
        assert browse_snapshot["albums"] is hydrated_albums
        assert browse_snapshot["separate_release_keys"] is separate_release_keys
        assert browse_snapshot["albums"] != [pre_hydration_album]
        assert library_state["file_cache"] == disk_file_cache
        assert library_state["albums"] is hydrated_albums
        assert library_state["relation_views"] == disk_relation_views
        return final_file_cache, 55.0

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=True,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=scan_after_hydration,
        refresh_relation_views=lambda **_kwargs: None,
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
        queue_mbid_assertion_follow_up=lambda _state, *, previous_albums: (
            follow_up_previous_albums.append(previous_albums)
        ),
    )

    assert build_calls[0] == disk_file_cache
    assert build_calls[-1] is final_file_cache
    assert follow_up_previous_albums == [[pre_hydration_album]]
    assert library_state["file_cache"] is final_file_cache
    assert library_state["albums"] is final_albums
    assert "active_scan_preview_state" not in library_state


def test_refresh_library_state_defers_atomic_save_to_relation_refresh(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    relation_calls = []
    scan_calls = []
    adapter_calls = []
    rebuilt_albums = [SimpleNamespace(key="album-from-rescan")]

    class FakeScanCacheAdapter:
        backend = "fake"

        def load_snapshot(self, cache_path, root_identity):
            adapter_calls.append(("load", cache_path, root_identity))
            return {}, 0.0, {}, 0.0, None

        def save_snapshot(self, cache_path, file_cache, root_identity, last_scan, **kwargs):
            adapter_calls.append(("save", cache_path, dict(file_cache), root_identity, last_scan, kwargs))

    library_state.update({
        "file_cache": {},
        "albums": [],
        "last_scan": 0.0,
        "relation_views": {"artists": []},
    })
    monkeypatch.setattr(scan_state, "_scan_cache_adapter", lambda cfg: FakeScanCacheAdapter())
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda cfg: set())
    monkeypatch.setattr(scan_state, "build_albums_from_file_cache", lambda file_cache, separate_keys: rebuilt_albums)

    new_file_cache = {"track-1": {"path": "track-1", "album": "Album"}}
    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=False,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **kwargs: scan_calls.append(kwargs) or (new_file_cache, 55.0),
        refresh_relation_views=lambda *, seed_missing_album_ratings=False, expected_scan_generation=None, publication_state=None: relation_calls.append(True),
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert len(scan_calls) == 1
    assert set(scan_calls[0]) == {
        "use_existing_cache",
        "expected_scan_generation",
        "publication_state",
        "publish_partial_snapshot",
    }
    assert scan_calls[0]["use_existing_cache"] is True
    assert scan_calls[0]["expected_scan_generation"] == 1
    assert callable(scan_calls[0]["publish_partial_snapshot"])
    assert relation_calls == [True]
    assert [call[0] for call in adapter_calls] == ["load"]
    assert library_state["file_cache"] == new_file_cache
    assert library_state["albums"] == rebuilt_albums


def test_scan_cache_adapter_selects_postgres_when_adapter_is_available(runtime_config, monkeypatch):
    class FakePsycopg:
        def connect(self):
            raise AssertionError("availability should not open a database connection")

    monkeypatch.setattr("music_app.services.scan_cache_persistence.psycopg", FakePsycopg())

    runtime_config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    runtime_config["PERSISTENCE_BACKENDS"] = {"scan_cache": "postgres"}
    adapter = scan_state._scan_cache_adapter(runtime_config)

    assert adapter.backend == "postgres"


def test_scan_cache_adapter_fails_fast_when_postgres_requested_without_driver(runtime_config, monkeypatch):
    monkeypatch.setattr("music_app.services.scan_cache_persistence.psycopg", None)

    runtime_config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    runtime_config["PERSISTENCE_BACKENDS"] = {"scan_cache": "postgres"}

    try:
        scan_state._scan_cache_adapter(runtime_config)
    except ValueError as exc:
        message = str(exc)
    else:
        raise AssertionError("Postgres scan_cache selection should fail until the adapter exists")

    assert "Postgres runtime persistence adapter is unavailable for scan_cache" in message


def test_refresh_library_state_validates_scan_cache_adapter_before_in_memory_skip(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    scan_calls = []
    monkeypatch.setattr("music_app.services.scan_cache_persistence.psycopg", None)

    runtime_config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    runtime_config["PERSISTENCE_BACKENDS"] = {"scan_cache": "postgres"}
    library_state.update({
        "file_cache": {"track-1": {"album": "Album"}},
        "albums": [SimpleNamespace(key="album-1")],
        "last_scan": scan_state.time.time(),
        "relation_views": {"artists": ["Artist"]},
    })
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda cfg: set())

    try:
        scan_state.refresh_library_state(
            library_state,
            config=runtime_config,
            logger=runtime_logger,
            force=False,
            cache_lock=scan_state.Lock(),
            scan_music_incremental=lambda **kwargs: scan_calls.append(kwargs) or ({}, 0.0),
            refresh_relation_views=lambda *, seed_missing_album_ratings=False: None,
            start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
            start_background_cover_refresh=lambda: None,
        )
    except ValueError as exc:
        message = str(exc)
    else:
        raise AssertionError("Postgres scan_cache selection should be validated before warm-cache skip")

    assert scan_calls == []
    assert "Postgres runtime persistence adapter is unavailable for scan_cache" in message


def test_scan_music_incremental_uses_explicit_configured_library_roots_without_flask_context(
    runtime_config,
    runtime_logger,
    monkeypatch,
):
    secondary_root = (Path(runtime_config["DATA_DIR"]) / "secondary-library").resolve()
    secondary_root.mkdir(parents=True, exist_ok=True)
    library_state = {"file_cache": {}}
    captured_states = []
    captured_roots = []
    captured_configs = []
    captured_partial_publishers = []

    def publish_partial_snapshot():
        return None

    save_library_root_settings(
        runtime_config,
        {
            "main_library_roots": [{"id": "secondary", "path": str(secondary_root), "layout_mode": "artist"}],
        },
    )
    monkeypatch.setattr(
        state_module,
        "scan_library_file_cache",
        lambda library_state_arg, **kwargs: (
            captured_states.append(library_state_arg),
            captured_roots.append(kwargs["roots"]),
            captured_partial_publishers.append(kwargs["publish_partial_snapshot"]),
            ({}, 0.0),
        )[-1],
    )
    monkeypatch.setattr(
        state_module,
        "load_exception_overrides",
        lambda cfg: captured_configs.append(cfg) or {},
    )

    state_module.scan_music_incremental(
        config=runtime_config,
        logger=runtime_logger,
        library_state=library_state,
        publish_partial_snapshot=publish_partial_snapshot,
    )

    assert captured_states == [library_state]
    assert captured_roots == [[secondary_root]]
    assert captured_configs == [runtime_config]
    assert captured_partial_publishers == [publish_partial_snapshot]


def test_refresh_library_state_rescans_when_library_root_identity_changes(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    first_root = (Path(runtime_config["DATA_DIR"]) / "first-root").resolve()
    second_root = (Path(runtime_config["DATA_DIR"]) / "second-root").resolve()
    first_root.mkdir(parents=True, exist_ok=True)
    second_root.mkdir(parents=True, exist_ok=True)
    old_track = first_root / "Artist" / "Old Album" / "song.mp3"
    new_track = second_root / "Artist" / "New Album" / "song.mp3"
    old_track.parent.mkdir(parents=True, exist_ok=True)
    new_track.parent.mkdir(parents=True, exist_ok=True)
    old_track.write_bytes(b"old")
    new_track.write_bytes(b"new")

    relation_calls = []
    scan_calls = []
    rebuilt_albums = [SimpleNamespace(key="album-from-rescan")]

    save_library_root_settings(
        runtime_config,
        {
            "main_library_roots": [{"id": "first", "path": str(first_root), "layout_mode": "artist"}],
        },
    )
    _install_scan_cache_adapter(
        monkeypatch,
        FakeScanCacheAdapter(
            file_cache={
                str(old_track): {
                    "path": str(old_track),
                    "mtime": float(old_track.stat().st_mtime),
                    "size": int(old_track.stat().st_size),
                    "album": "Old Album",
                    "album_artist": "Artist",
                    "title": "Song",
                    "track_number": 1,
                    "disc_number": 1,
                    "disc_number_raw": "1",
                    "artist": "Artist",
                    "duration_seconds": 60,
                    "cover_path": None,
                    "remote_cover_url": None,
                    "remote_cover_thumbnail_url": None,
                    "remote_cover_source": None,
                    "remote_cover_source_label": None,
                    "remote_cover_album_url": None,
                    "remote_cover_width": None,
                    "remote_cover_height": None,
                    "year": 1999,
                    "edition": "",
                    "album_rating": 0,
                    "exception_type": None,
                }
            },
            last_scan=25.0,
            root_identity=library_root_cache_identity(runtime_config),
        ),
    )
    save_library_root_settings(
        runtime_config,
        {
            "main_library_roots": [{"id": "second", "path": str(second_root), "layout_mode": "artist"}],
        },
    )

    library_state.update({
        "file_cache": {},
        "albums": [],
        "last_scan": 0.0,
        "relation_views": {"artists": []},
    })

    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda cfg: set())
    monkeypatch.setattr(scan_state, "build_albums_from_file_cache", lambda file_cache, separate_keys: rebuilt_albums)

    new_file_cache = {
        str(new_track): {
            "path": str(new_track),
            "mtime": float(new_track.stat().st_mtime),
            "size": int(new_track.stat().st_size),
            "album": "New Album",
            "album_artist": "Artist",
            "title": "Song",
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
            "artist": "Artist",
            "duration_seconds": 60,
            "cover_path": None,
            "local_cover_width": None,
            "local_cover_height": None,
            "remote_cover_url": None,
            "remote_cover_thumbnail_url": None,
            "remote_cover_source": None,
            "remote_cover_source_label": None,
            "remote_cover_album_url": None,
            "remote_cover_width": None,
            "remote_cover_height": None,
            "year": 2000,
            "edition": "",
            "album_rating": 0,
            "exception_type": None,
        }
    }

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=False,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **kwargs: scan_calls.append(kwargs) or (new_file_cache, 55.0),
        refresh_relation_views=lambda *, seed_missing_album_ratings=False, expected_scan_generation=None, publication_state=None: relation_calls.append(True),
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert len(scan_calls) == 1
    assert set(scan_calls[0]) == {
        "use_existing_cache",
        "expected_scan_generation",
        "publication_state",
        "publish_partial_snapshot",
    }
    assert scan_calls[0]["use_existing_cache"] is True
    assert scan_calls[0]["expected_scan_generation"] == 1
    assert callable(scan_calls[0]["publish_partial_snapshot"])
    assert relation_calls == [True]
    assert library_state["file_cache"] == new_file_cache
    assert library_state["albums"] == rebuilt_albums
    assert library_state["last_scan"] == 55.0


def test_refresh_library_state_runs_mbid_follow_up_after_successful_publish(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    hook_calls = []
    order = []
    rebuilt_albums = [SimpleNamespace(key="new-album", album_artist="Stereolab", artists=["Stereolab"])]

    library_state.update({
        "file_cache": {},
        "albums": [SimpleNamespace(key="old-album", album_artist="Broadcast", artists=["Broadcast"])],
        "last_scan": 0.0,
        "relation_views": {"artists": ["Broadcast"]},
    })
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda cfg: set())
    monkeypatch.setattr(scan_state, "build_albums_from_file_cache", lambda file_cache, separate_keys: rebuilt_albums)
    _install_scan_cache_adapter(monkeypatch)
    monkeypatch.setattr(scan_state, "log_app_event", lambda *args, **kwargs: None)

    def refresh_relations(*, seed_missing_album_ratings=False, expected_scan_generation=None, publication_state=None) -> None:
        order.append("relations")

    def queue_mbid_follow_up(library_state_arg, *, previous_albums):
        hook_calls.append({
            "previous": previous_albums,
            "current": list(library_state_arg.get("albums") or []),
            "scan_in_progress": library_state_arg.get("scan_in_progress"),
        })
        order.append("mbid")

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=False,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **kwargs: ({"new": {"album": "New"}}, 55.0),
        refresh_relation_views=refresh_relations,
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: order.append("covers"),
        queue_mbid_assertion_follow_up=queue_mbid_follow_up,
    )

    assert order == ["relations", "covers", "mbid"]
    assert len(hook_calls) == 1
    assert hook_calls[0]["previous"][0].key == "old-album"
    assert hook_calls[0]["current"] == rebuilt_albums
    assert hook_calls[0]["scan_in_progress"] is False


def test_refresh_library_state_does_not_run_mbid_follow_up_for_skip_failure_or_cancel(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    hook_calls = []

    library_state.update({
        "file_cache": {"track-1": {"album": "Album"}},
        "albums": [SimpleNamespace(key="album-1")],
        "last_scan": scan_state.time.time(),
        "relation_views": {"artists": ["Artist"]},
    })
    _install_scan_cache_adapter(monkeypatch)
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda cfg: set())
    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=False,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **kwargs: ({}, 0.0),
        refresh_relation_views=lambda *, seed_missing_album_ratings=False, expected_scan_generation=None, publication_state=None: None,
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
        queue_mbid_assertion_follow_up=lambda *args, **kwargs: hook_calls.append("skip"),
    )

    library_state.update({
        "file_cache": {},
        "albums": [],
        "last_scan": 0.0,
        "last_error": None,
        "relation_views": {"artists": []},
    })
    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=True,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **kwargs: (_ for _ in ()).throw(RuntimeError("scan failed")),
        refresh_relation_views=lambda *, seed_missing_album_ratings=False: None,
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
        queue_mbid_assertion_follow_up=lambda *args, **kwargs: hook_calls.append("failure"),
    )

    library_state.update({
        "file_cache": {},
        "albums": [],
        "last_scan": 0.0,
        "last_error": None,
        "relation_views": {"artists": []},
    })
    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=True,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **kwargs: (_ for _ in ()).throw(scan_state.ScanCancelled()),
        refresh_relation_views=lambda *, seed_missing_album_ratings=False: None,
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
        queue_mbid_assertion_follow_up=lambda *args, **kwargs: hook_calls.append("cancel"),
    )

    assert hook_calls == []


def test_refresh_library_state_mbid_follow_up_exception_does_not_block_scan_completion(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    rebuilt_albums = [SimpleNamespace(key="new-album", album_artist="Stereolab", artists=["Stereolab"])]
    logged = []

    library_state.update({
        "file_cache": {},
        "albums": [],
        "last_scan": 0.0,
        "last_error": None,
        "relation_views": {"artists": []},
    })
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda cfg: set())
    monkeypatch.setattr(scan_state, "build_albums_from_file_cache", lambda file_cache, separate_keys: rebuilt_albums)
    _install_scan_cache_adapter(monkeypatch)
    monkeypatch.setattr(scan_state, "log_app_event", lambda *args, **kwargs: logged.append((args, kwargs)))

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=True,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **kwargs: ({"new": {"album": "New"}}, 55.0),
        refresh_relation_views=lambda *, seed_missing_album_ratings=False, expected_scan_generation=None, publication_state=None: None,
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
        queue_mbid_assertion_follow_up=lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("hook failed")),
    )

    assert library_state["scan_in_progress"] is False
    assert library_state["scan_phase"] == "idle"
    assert library_state["scan_mode"] == "idle"
    assert library_state["scan_outcome"] == "completed"
    assert library_state["last_error"] is None
    assert any(kwargs.get("reason") == "post_scan_mbid_assertion_hook_failed" for _args, kwargs in logged)


def test_refresh_library_state_marks_indexing_finalizing_before_relation_publication(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    observed = []
    library_state.update(
        {
            "file_cache": {},
            "albums": [],
            "last_scan": 0.0,
            "relation_views": {"artists": []},
        }
    )
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda cfg: set())
    monkeypatch.setattr(
        scan_state,
        "build_albums_from_file_cache",
        lambda file_cache, separate_keys: [SimpleNamespace(key="album")],
    )
    _install_scan_cache_adapter(monkeypatch)

    def refresh_relations(**kwargs):
        observed.append(
            {
                "scan_in_progress": library_state["scan_in_progress"],
                "scan_phase": library_state["scan_phase"],
            }
        )

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=True,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **kwargs: (
            {"track": {"album": "Album"}},
            55.0,
        ),
        refresh_relation_views=refresh_relations,
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert observed == [
        {"scan_in_progress": True, "scan_phase": "finalizing"},
    ]
    assert library_state["scan_in_progress"] is False
    assert library_state["scan_phase"] == "idle"
    assert library_state["scan_outcome"] == "completed"


def test_successful_current_generation_scan_is_published_with_rating_seed_intent(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    publication_intents = []
    library_state.update({
        "file_cache": {},
        "albums": [],
        "last_scan": 0.0,
        "relation_views": {"artists": []},
    })
    adapter = _install_scan_cache_adapter(monkeypatch)
    adapter.load_cover_mutation_revision = lambda: 41
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda _cfg: set())
    monkeypatch.setattr(
        scan_state,
        "build_albums_from_file_cache",
        lambda _file_cache, _separate_keys: [SimpleNamespace(key="artist::new album")],
    )

    def refresh_relations(
        *,
        seed_missing_album_ratings=False,
        expected_scan_generation=None,
        expected_cover_mutation_revision=None,
        publication_state=None,
    ):
        publication_intents.append(
            (seed_missing_album_ratings, expected_cover_mutation_revision)
        )

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=True,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **_kwargs: (
            {"track": {"path": "track", "album": "New Album"}},
            55.0,
        ),
        refresh_relation_views=refresh_relations,
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert publication_intents == [(True, 41)]


def test_force_scan_repairs_legacy_rating_metadata_before_guarded_seed_publication(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    track_path = runtime_config["MUSIC_DIR"] / "Artist" / "Rated Album" / "song.mp3"
    track_path.parent.mkdir(parents=True)
    track_path.write_bytes(b"generated-test-track")
    stat = track_path.stat()
    legacy_entry = {
        "path": str(track_path),
        "title": "Song",
        "album": "Rated Album",
        "artist": "Artist",
        "album_artist": "Artist",
        "album_rating": None,
        "mtime": stat.st_mtime,
        "size": stat.st_size,
        "cover_path": None,
    }
    library_state.update(
        {
            "file_cache": {str(track_path): legacy_entry},
            "albums": [],
            "last_scan": 5.0,
            "relation_views": {"artists": ["Artist"]},
        }
    )
    adapter = _install_scan_cache_adapter(
        monkeypatch,
        FakeScanCacheAdapter(
            file_cache={str(track_path): legacy_entry},
            last_scan=5.0,
            relation_views={"artists": ["Artist"]},
        ),
    )
    adapter.load_cover_mutation_revision = lambda: 11
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda _cfg: set())
    monkeypatch.setattr(library_indexing, "find_cover_for_track_folder", lambda *_args, **_kwargs: None)

    metadata_calls = []

    def read_metadata(path: Path):
        metadata_calls.append(path)
        return {
            **legacy_entry,
            "album_rating": 9,
            "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
        }

    monkeypatch.setattr(library_indexing, "read_metadata_for_file", read_metadata)
    publication_calls = []

    def scan_incrementally(**kwargs):
        return library_indexing.scan_library_file_cache(
            library_state,
            roots=[runtime_config["MUSIC_DIR"]],
            supported_extensions={".mp3"},
            image_extensions={".jpg"},
            exception_overrides={},
            use_existing_cache=kwargs["use_existing_cache"],
            expected_scan_generation=kwargs["expected_scan_generation"],
            publication_state=kwargs["publication_state"],
            publish_partial_snapshot=kwargs["publish_partial_snapshot"],
        )

    def publish_relations(
        *,
        seed_missing_album_ratings=False,
        expected_scan_generation=None,
        expected_cover_mutation_revision=None,
        publication_state=None,
    ):
        album = publication_state["albums"][0]
        publication_calls.append(
            {
                "seed": seed_missing_album_ratings,
                "generation": expected_scan_generation,
                "cover_revision": expected_cover_mutation_revision,
                "album_key": album.key,
                "tag_album_rating": album.album_rating,
            }
        )

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=True,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=scan_incrementally,
        refresh_relation_views=publish_relations,
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert metadata_calls == [track_path]
    assert publication_calls == [
        {
            "seed": True,
            "generation": 1,
            "cover_revision": 11,
            "album_key": "artist::rated album",
            "tag_album_rating": 9,
        }
    ]
    assert library_state["file_cache"][str(track_path)]["album_rating"] == 9


def test_current_scan_generation_registers_detached_preview_until_atomic_final_publish(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    old_album = SimpleNamespace(key="artist::old album")
    partial_album = SimpleNamespace(key="artist::partial album")
    partial_albums = [partial_album]
    final_album = SimpleNamespace(key="artist::final album")
    old_file_cache = {"old": {"path": "old", "album": "Old Album"}}
    partial_file_cache = {"partial": {"path": "partial", "album": "Partial Album"}}
    final_file_cache = {"final": {"path": "final", "album": "Final Album"}}
    old_relation_views = {"artists": ["Old Artist"]}
    old_album_ratings = {"artist::old album": 7}
    library_state.update({
        "file_cache": old_file_cache,
        "albums": [old_album],
        "last_scan": 10.0,
        "last_error": None,
        "scan_metadata_repair_required": True,
        "separate_release_keys": {"old-release"},
        "relation_views": old_relation_views,
        "album_ratings": old_album_ratings,
    })
    _install_scan_cache_adapter(monkeypatch)
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda _cfg: {"new-release"})
    monkeypatch.setattr(
        scan_state,
        "build_albums_from_file_cache",
        lambda file_cache, _separate_keys: (
            [final_album] if file_cache is final_file_cache else [partial_album]
        ),
    )

    def scan_and_publish_partial(**kwargs):
        publication_state = kwargs["publication_state"]
        preview = library_state["active_scan_preview_state"]
        assert preview["scan_generation"] == 1
        assert preview["publication_state"] is publication_state
        initial_browse_snapshot = preview["browse_snapshot"]
        assert initial_browse_snapshot["file_cache"] == old_file_cache
        assert initial_browse_snapshot["albums"] == [old_album]
        assert initial_browse_snapshot["separate_release_keys"] == {"new-release"}
        publication_state.update({
            "file_cache": partial_file_cache,
            "albums": partial_albums,
        })
        kwargs["publish_partial_snapshot"]()
        assert preview["browse_snapshot"] is not initial_browse_snapshot
        assert preview["browse_snapshot"] == {
            "file_cache": partial_file_cache,
            "albums": partial_albums,
            "separate_release_keys": {"new-release"},
        }
        assert library_state["file_cache"] is old_file_cache
        assert library_state["albums"] == [old_album]
        assert library_state["relation_views"] is old_relation_views
        assert library_state["album_ratings"] is old_album_ratings
        assert library_state["last_scan"] == 10.0
        return final_file_cache, 55.0

    def publish_final_relations(
        *,
        seed_missing_album_ratings=False,
        expected_scan_generation=None,
        publication_state=None,
    ):
        assert seed_missing_album_ratings is True
        assert expected_scan_generation == 1
        assert library_state["file_cache"] is old_file_cache
        assert library_state["albums"] == [old_album]
        publication_state["relation_views"] = {"artists": ["Final Artist"]}
        publication_state["album_ratings"] = {"artist::final album": 10}

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=True,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=scan_and_publish_partial,
        refresh_relation_views=publish_final_relations,
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert "active_scan_preview_state" not in library_state
    assert library_state["file_cache"] is final_file_cache
    assert library_state["albums"] == [final_album]
    assert library_state["relation_views"] == {"artists": ["Final Artist"]}
    assert library_state["album_ratings"] == {"artist::final album": 10}
    assert library_state["last_scan"] == 55.0
    assert library_state["scan_metadata_repair_required"] is False


def test_active_scan_preview_resolver_never_observes_half_staged_publication(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    old_album = SimpleNamespace(key="artist::old album")
    partial_albums = [SimpleNamespace(key="artist::partial album")]
    old_file_cache = {"old": {"path": "old", "album": "Old Album"}}
    partial_file_cache = {"partial": {"path": "partial", "album": "Partial Album"}}
    partial_release_keys = {"partial-release"}
    file_cache_staged = Event()
    allow_remaining_stage = Event()
    partial_published = Event()
    allow_scan_finish = Event()
    worker_errors = []
    library_state.update({
        "file_cache": old_file_cache,
        "albums": [old_album],
        "last_scan": 10.0,
        "separate_release_keys": {"old-release"},
        "relation_views": {"artists": ["Old Artist"]},
    })
    _install_scan_cache_adapter(monkeypatch)
    monkeypatch.setattr(
        scan_state,
        "load_separate_release_keys",
        lambda _cfg: {"initial-scan-release"},
    )
    monkeypatch.setattr(
        scan_state,
        "build_albums_from_file_cache",
        lambda _file_cache, _separate_keys: partial_albums,
    )

    def stage_with_deterministic_pause(**kwargs):
        publication_state = kwargs["publication_state"]
        publication_state["file_cache"] = partial_file_cache
        file_cache_staged.set()
        assert allow_remaining_stage.wait(timeout=3.0)
        publication_state["albums"] = partial_albums
        publication_state["separate_release_keys"] = partial_release_keys
        kwargs["publish_partial_snapshot"]()
        partial_published.set()
        assert allow_scan_finish.wait(timeout=3.0)
        return partial_file_cache, 55.0

    def run_scan():
        try:
            scan_state.refresh_library_state(
                library_state,
                config=runtime_config,
                logger=runtime_logger,
                force=True,
                cache_lock=scan_state.Lock(),
                scan_music_incremental=stage_with_deterministic_pause,
                refresh_relation_views=lambda **_kwargs: None,
                start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
                start_background_cover_refresh=lambda: None,
            )
        except Exception as exc:
            worker_errors.append(exc)

    worker = Thread(target=run_scan, daemon=True)
    worker.start()
    try:
        assert file_cache_staged.wait(timeout=3.0)
        preview = library_state["active_scan_preview_state"]
        initial_browse_snapshot = preview["browse_snapshot"]
        resolved_before_publish = scan_state.resolve_active_scan_browse_state(library_state)
        assert resolved_before_publish["file_cache"] == old_file_cache
        assert resolved_before_publish["albums"] == [old_album]
        assert resolved_before_publish["separate_release_keys"] == {"initial-scan-release"}
        assert preview["browse_snapshot"] is initial_browse_snapshot

        allow_remaining_stage.set()
        assert partial_published.wait(timeout=3.0)
        resolved_after_publish = scan_state.resolve_active_scan_browse_state(library_state)
        assert preview["browse_snapshot"] is not initial_browse_snapshot
        assert resolved_after_publish["file_cache"] is partial_file_cache
        assert resolved_after_publish["albums"] is partial_albums
        assert resolved_after_publish["separate_release_keys"] is partial_release_keys
    finally:
        allow_remaining_stage.set()
        allow_scan_finish.set()
        worker.join(timeout=3.0)

    assert not worker.is_alive()
    assert worker_errors == []
    assert "active_scan_preview_state" not in library_state
    assert library_state["file_cache"] is partial_file_cache
    assert library_state["albums"] is partial_albums


def test_cancelled_current_scan_rejects_and_clears_its_preview(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    rejection_types = []
    library_state["scan_metadata_repair_required"] = True
    _install_scan_cache_adapter(monkeypatch)
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda _cfg: set())

    def cancel_then_publish(**kwargs):
        preview = library_state["active_scan_preview_state"]
        assert preview["scan_generation"] == 1
        assert preview["publication_state"] is kwargs["publication_state"]
        assert set(preview["browse_snapshot"]) == {
            "file_cache",
            "albums",
            "separate_release_keys",
        }
        library_state["scan_in_progress"] = False
        try:
            kwargs["publish_partial_snapshot"]()
        except Exception as exc:
            rejection_types.append(type(exc))
            raise
        raise AssertionError("a cancelled scan must reject partial publication")

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=True,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=cancel_then_publish,
        refresh_relation_views=lambda **_kwargs: pytest.fail("cancelled scan published relations"),
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert rejection_types == [scan_state.ScanCancelled]
    assert "active_scan_preview_state" not in library_state
    assert library_state["scan_metadata_repair_required"] is True
    assert library_state["scan_outcome"] == "cancelled"


def test_obsolete_scan_rejects_partial_publish_without_clearing_newer_generation_preview(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    rejection_types = []
    library_state["scan_metadata_repair_required"] = True
    newer_publication_state = {"file_cache": {"newer": {}}, "albums": []}
    newer_preview = {
        "scan_generation": 2,
        "publication_state": newer_publication_state,
        "browse_snapshot": {
            "file_cache": newer_publication_state["file_cache"],
            "albums": newer_publication_state["albums"],
            "separate_release_keys": set(),
        },
    }
    _install_scan_cache_adapter(monkeypatch)
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda _cfg: set())

    def supersede_then_publish(**kwargs):
        assert library_state["active_scan_preview_state"]["publication_state"] is kwargs["publication_state"]
        library_state["scan_generation"] = 2
        library_state["active_scan_preview_state"] = newer_preview
        try:
            kwargs["publish_partial_snapshot"]()
        except Exception as exc:
            rejection_types.append(type(exc))
            raise
        raise AssertionError("an obsolete scan must reject partial publication")

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=True,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=supersede_then_publish,
        refresh_relation_views=lambda **_kwargs: pytest.fail("obsolete scan published relations"),
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert rejection_types == [scan_state.ScanCancelled]
    assert library_state["active_scan_preview_state"] is newer_preview
    assert library_state["scan_metadata_repair_required"] is True


def test_failed_relation_publication_keeps_prior_live_scan_state(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    old_album = SimpleNamespace(key="artist::old album")
    old_file_cache = {"old": {"path": "old", "album": "Old Album"}}
    partial_album = SimpleNamespace(key="artist::partial album")
    partial_file_cache = {
        "partial": {"path": "partial", "album": "Partial Album"},
    }
    new_file_cache = {"new": {"path": "new", "album": "New Album"}}
    rebuilt_albums = [SimpleNamespace(key="artist::new album")]
    library_state.update({
        "file_cache": old_file_cache,
        "albums": [old_album],
        "last_scan": 10.0,
        "scan_metadata_repair_required": True,
        "separate_release_keys": {"old-release"},
        "relation_views": {"artists": ["Old Artist"]},
        "scan_in_progress": True,
        "scan_mode": "background",
    })
    _install_scan_cache_adapter(monkeypatch)
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda _cfg: {"new-release"})
    monkeypatch.setattr(
        scan_state,
        "build_albums_from_file_cache",
        lambda _file_cache, _separate_keys: rebuilt_albums,
    )
    failed_history_events = []

    def capture_log_event(_config, _logger, action, **fields):
        if action == "Library indexing failed":
            failed_history_events.append({
                "last_error_when_recorded": library_state.get("last_error"),
                "action": action,
                **fields,
            })

    monkeypatch.setattr(scan_state, "log_app_event", capture_log_event)

    def reject_publication(
        *,
        seed_missing_album_ratings=False,
        expected_scan_generation=None,
        publication_state=None,
    ):
        assert seed_missing_album_ratings is True
        assert expected_scan_generation == 1
        assert library_state["file_cache"] is old_file_cache
        assert library_state["albums"] == [old_album]
        assert library_state["last_scan"] == 10.0
        assert publication_state["file_cache"] is new_file_cache
        assert publication_state["albums"] is rebuilt_albums
        assert publication_state["last_scan"] == 55.0
        preview = library_state["active_scan_preview_state"]
        assert preview["scan_generation"] == 1
        assert preview["publication_state"] is publication_state
        assert preview["browse_snapshot"] == {
            "file_cache": new_file_cache,
            "albums": rebuilt_albums,
            "separate_release_keys": {"new-release"},
        }
        raise RuntimeError("database publication failed")

    def scan_with_partial_publication(**kwargs):
        publication_state = kwargs["publication_state"]
        preview = library_state["active_scan_preview_state"]
        assert preview["scan_generation"] == 1
        assert preview["publication_state"] is publication_state
        initial_browse_snapshot = preview["browse_snapshot"]
        publication_state.update({
            "file_cache": partial_file_cache,
            "albums": [partial_album],
        })
        kwargs["publish_partial_snapshot"]()
        assert preview["browse_snapshot"] is not initial_browse_snapshot
        assert preview["browse_snapshot"]["file_cache"] is partial_file_cache
        assert preview["browse_snapshot"]["albums"] == [partial_album]
        assert library_state["file_cache"] is old_file_cache
        assert library_state["albums"] == [old_album]
        return new_file_cache, 55.0

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=True,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=scan_with_partial_publication,
        refresh_relation_views=reject_publication,
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert library_state["file_cache"] is old_file_cache
    assert library_state["albums"] == [old_album]
    assert library_state["last_scan"] == 10.0
    assert library_state["separate_release_keys"] == {"old-release"}
    assert library_state["last_error"] == "database publication failed"
    assert failed_history_events == [{
        "last_error_when_recorded": None,
        "action": "Library indexing failed",
        "level": "error",
        "history": True,
        "id": "library-status-error:1",
        "error": "database publication failed",
        "scan_generation": 1,
        "scan_phase": "finalizing",
        "scan_outcome": "failed",
    }]
    assert library_state["scan_in_progress"] is False
    assert "active_scan_preview_state" not in library_state
    assert library_state["scan_metadata_repair_required"] is True


def test_post_commit_logging_rejects_cancellation_until_scan_finally_completes(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    cache_lock = scan_state.Lock()
    cancellation_results = []
    completed_event_state = []
    library_state.update({
        "file_cache": {},
        "albums": [],
        "last_scan": 0.0,
        "relation_views": {"artists": []},
    })
    _install_scan_cache_adapter(monkeypatch)
    monkeypatch.setattr(state_module, "_CACHE_LOCK", cache_lock)
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda _cfg: set())
    monkeypatch.setattr(
        scan_state,
        "build_albums_from_file_cache",
        lambda _file_cache, _separate_keys: [SimpleNamespace(key="artist::new album")],
    )

    def mark_publication_committed(
        *,
        seed_missing_album_ratings=False,
        expected_scan_generation=None,
        publication_state=None,
    ):
        assert seed_missing_album_ratings is True
        assert expected_scan_generation == 1
        library_state["scan_committed_generation"] = expected_scan_generation

    def capture_log_event(_config, _logger, message, **_kwargs):
        if message != "Library indexing completed":
            return
        completed_event_state.append({
            "scan_generation": library_state["scan_generation"],
            "scan_in_progress": library_state["scan_in_progress"],
            "scan_committed_generation": library_state.get("scan_committed_generation"),
        })
        cancellation_results.append(
            state_module.cancel_background_refresh_for_state(library_state)
        )

    monkeypatch.setattr(scan_state, "log_app_event", capture_log_event)

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=True,
        cache_lock=cache_lock,
        scan_music_incremental=lambda **_kwargs: (
            {"new": {"path": "new", "album": "New Album"}},
            55.0,
        ),
        refresh_relation_views=mark_publication_committed,
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert cancellation_results == [False]
    assert completed_event_state == [{
        "scan_generation": 1,
        "scan_in_progress": True,
        "scan_committed_generation": 1,
    }]
    assert library_state["scan_generation"] == 1
    assert library_state["scan_in_progress"] is False
    assert "scan_committed_generation" not in library_state


def test_obsolete_scan_exception_does_not_overwrite_newer_generation_error(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    library_state.update({
        "file_cache": {},
        "albums": [],
        "last_scan": 0.0,
        "last_error": None,
        "relation_views": {"artists": []},
    })
    _install_scan_cache_adapter(monkeypatch)
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda _cfg: set())

    def fail_after_new_generation_starts(**_kwargs):
        library_state["scan_generation"] = 2
        library_state["last_error"] = "newer scan failed"
        raise RuntimeError("obsolete scan failed")

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=True,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=fail_after_new_generation_starts,
        refresh_relation_views=lambda **_kwargs: None,
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert library_state["scan_generation"] == 2
    assert library_state["last_error"] == "newer scan failed"


def test_obsolete_scan_skips_disk_relation_repair_and_incremental_scan(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    relation_calls = []
    scan_calls = []
    disk_file_cache = {"cached": {"path": "cached", "album": "Cached Album"}}
    _install_scan_cache_adapter(
        monkeypatch,
        FakeScanCacheAdapter(
            file_cache=disk_file_cache,
            last_scan=10.0,
            relation_views={},
            root_identity=library_root_cache_identity(runtime_config),
        ),
    )
    library_state.update({
        "file_cache": {},
        "albums": [],
        "last_scan": 0.0,
        "relation_views": {"artists": []},
    })
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda _cfg: set())

    def supersede_generation_while_rebuilding(_file_cache, _separate_keys):
        library_state["scan_generation"] = 2
        return [SimpleNamespace(key="artist::cached album")]

    monkeypatch.setattr(
        scan_state,
        "build_albums_from_file_cache",
        supersede_generation_while_rebuilding,
    )

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=True,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **kwargs: scan_calls.append(kwargs) or ({}, 0.0),
        refresh_relation_views=lambda **kwargs: relation_calls.append(kwargs),
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert library_state["scan_generation"] == 2
    assert relation_calls == []
    assert scan_calls == []


@pytest.mark.parametrize(
    "scan_result",
    [
        pytest.param(RuntimeError("scan failed"), id="failed"),
        pytest.param(scan_state.ScanCancelled(), id="cancelled"),
    ],
)
def test_unsuccessful_scan_never_publishes_rating_seed_intent(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
    scan_result,
):
    publication_intents = []
    library_state.update({
        "file_cache": {},
        "albums": [],
        "last_scan": 0.0,
        "relation_views": {"artists": []},
    })
    _install_scan_cache_adapter(monkeypatch)
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda _cfg: set())

    def fail_scan(**_kwargs):
        raise scan_result

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=True,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=fail_scan,
        refresh_relation_views=lambda *, seed_missing_album_ratings=False, expected_scan_generation=None: (
            publication_intents.append(seed_missing_album_ratings)
        ),
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert publication_intents == []


def test_stale_scan_generation_does_not_publish_rating_seed_intent(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    publication_intents = []
    library_state.update({
        "file_cache": {},
        "albums": [],
        "last_scan": 0.0,
        "relation_views": {"artists": []},
    })
    _install_scan_cache_adapter(monkeypatch)
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda _cfg: set())
    monkeypatch.setattr(
        scan_state,
        "build_albums_from_file_cache",
        lambda _file_cache, _separate_keys: [SimpleNamespace(key="artist::stale album")],
    )

    def finish_after_generation_changes(**_kwargs):
        library_state["scan_generation"] = int(library_state["scan_generation"]) + 1
        return {"track": {"path": "track", "album": "Stale Album"}}, 55.0

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=True,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=finish_after_generation_changes,
        refresh_relation_views=lambda *, seed_missing_album_ratings=False: (
            publication_intents.append(seed_missing_album_ratings)
        ),
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert publication_intents == []


def test_fresh_snapshot_hydration_rebuilds_relations_without_rating_seed_intent(
    runtime_config,
    runtime_logger,
    library_state,
    monkeypatch,
):
    publication_intents = []
    _install_scan_cache_adapter(
        monkeypatch,
        FakeScanCacheAdapter(
            file_cache={"track": {"path": "track", "album": "Cached Album"}},
            last_scan=scan_state.time.time(),
            relation_views={},
            root_identity=library_root_cache_identity(runtime_config),
        ),
    )
    library_state.update({
        "file_cache": {},
        "albums": [],
        "last_scan": 0.0,
        "relation_views": {"artists": []},
    })
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda _cfg: set())
    monkeypatch.setattr(
        scan_state,
        "build_albums_from_file_cache",
        lambda _file_cache, _separate_keys: [SimpleNamespace(key="artist::cached album")],
    )

    scan_state.refresh_library_state(
        library_state,
        config=runtime_config,
        logger=runtime_logger,
        force=False,
        cache_lock=scan_state.Lock(),
        scan_music_incremental=lambda **_kwargs: pytest.fail("fresh hydration must not scan"),
        refresh_relation_views=lambda *, seed_missing_album_ratings=False, expected_scan_generation=None: (
            publication_intents.append(seed_missing_album_ratings)
        ),
        start_manual_cover_refresh=lambda *, force_search=False: {"started": True},
        start_background_cover_refresh=lambda: None,
    )

    assert publication_intents == [False]
