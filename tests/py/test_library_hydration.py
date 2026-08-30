from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services import library_hydration
from music_app.services.metadata import FILE_METADATA_SCHEMA_VERSION
from music_app.services.library_hydration import (
    find_cover_for_track_folder,
    hydrate_library_state_from_disk,
    repair_cover_paths_in_cache,
    refresh_cached_cover_paths_in_library_state,
    sanitize_hydrated_file_cache,
)


class FakeSelectedScanCacheAdapter:
    backend = "postgres"

    def __init__(
        self,
        file_cache: dict[str, dict[str, object]],
        last_scan: float,
        relation_views: dict[str, object] | None = None,
        relations_last_built: float = 0.0,
        error: str | None = None,
    ) -> None:
        self.file_cache = file_cache
        self.last_scan = last_scan
        self.relation_views = relation_views or {}
        self.relations_last_built = relations_last_built
        self.error = error
        self.load_calls: list[tuple[Path, object]] = []
        self.strict_load_calls: list[tuple[Path, object]] = []
        self.save_calls: list[tuple[Path, dict[str, dict[str, object]], object, float, dict[str, object]]] = []

    def load_snapshot(self, cache_path: Path, root_identity: object):
        self.load_calls.append((cache_path, root_identity))
        return self.file_cache, self.last_scan, self.relation_views, self.relations_last_built, self.error

    def load_snapshot_strict(self, cache_path: Path, root_identity: object):
        self.strict_load_calls.append((cache_path, root_identity))
        return self.load_snapshot(cache_path, root_identity)

    def save_snapshot(
        self,
        cache_path: Path,
        file_cache: dict[str, dict[str, object]],
        root_identity: object,
        last_scan: float,
        **kwargs,
    ) -> None:
        self.save_calls.append((cache_path, dict(file_cache), root_identity, last_scan, dict(kwargs)))


def test_find_cover_for_track_folder_checks_parent_for_disc_subfolders(tmp_path: Path):
    album_root = tmp_path / "Artist" / "Album"
    disc_root = album_root / "Disc 1"
    disc_root.mkdir(parents=True)
    cover_path = album_root / "cover.jpg"
    cover_path.write_bytes(b"cover")

    assert find_cover_for_track_folder(disc_root, {".jpg"}) == cover_path


def test_repair_cover_paths_in_cache_updates_missing_cover_paths(tmp_path: Path):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    track_path = album_root / "song.mp3"
    cover_path = album_root / "folder.jpg"
    track_path.write_bytes(b"track")
    cover_path.write_bytes(b"cover")

    file_cache = {
        str(track_path): {
            "path": str(track_path),
            "cover_path": None,
        }
    }

    changed_entries = repair_cover_paths_in_cache(file_cache, {".jpg"})

    assert changed_entries == {
        str(track_path): {
            "path": str(track_path),
            "cover_path": str(cover_path),
        }
    }
    assert file_cache[str(track_path)]["cover_path"] == str(cover_path)


def test_sanitize_hydrated_file_cache_filters_missing_files_and_applies_repairs(tmp_path: Path):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    track_path = album_root / "song.mp3"
    missing_path = album_root / "missing.mp3"
    cover_path = album_root / "cover.jpg"
    track_path.write_bytes(b"track")
    cover_path.write_bytes(b"cover")

    file_cache = {
        str(track_path): {
            "path": str(track_path),
            "album": "Album",
            "album_artist": "Artist",
            "artist": "Artist",
            "title": "Song",
            "cover_path": None,
            "exception_type": None,
        },
        str(missing_path): {
            "path": str(missing_path),
            "album": "Album",
            "album_artist": "Artist",
            "artist": "Artist",
            "title": "Missing Song",
            "cover_path": None,
            "exception_type": None,
        },
    }

    sanitized_file_cache, changed_entries = sanitize_hydrated_file_cache(
        file_cache,
        {str(track_path): "Non-album rarity"},
        {".jpg"},
        root_definitions=[{"id": "arrivals-1", "path": str(tmp_path), "category": "new_arrivals_roots"}],
    )

    assert list(sanitized_file_cache) == [str(track_path)]
    assert sanitized_file_cache[str(track_path)]["exception_type"] == "Non-album rarity"
    assert sanitized_file_cache[str(track_path)]["cover_path"] == str(cover_path)
    assert changed_entries == {
        str(track_path): {
            "path": str(track_path),
            "album": "Album",
            "album_artist": "Artist",
            "artist": "Artist",
            "title": "Song",
            "cover_path": str(cover_path),
            "library_root_id": "arrivals-1",
            "library_root_category": "new_arrivals",
            "exception_type": "Non-album rarity",
        }
    }


def test_sanitize_hydrated_file_cache_reports_directory_read_failure(
    tmp_path: Path,
    monkeypatch,
):
    album_root = tmp_path / "Artist" / "Album"
    track_path = album_root / "song.mp3"
    failures = []

    def fail_directory_read(path):
        assert path == album_root
        raise PermissionError("directory access denied")

    monkeypatch.setattr(library_hydration.Path, "iterdir", fail_directory_read)

    sanitized, changed = sanitize_hydrated_file_cache(
        {str(track_path): {"path": str(track_path), "cover_path": None}},
        {},
        {".jpg"},
        record_file_error=lambda action, **fields: failures.append({
            "action": action,
            **fields,
        }),
    )

    assert sanitized == {}
    assert changed == {}
    assert failures == [{
        "action": "Library hydration directory read failed",
        "path": str(album_root),
        "error": "directory access denied",
        "error_type": "PermissionError",
    }]


def test_sanitize_hydrated_file_cache_reports_directory_entry_inspection_failure(
    tmp_path: Path,
    monkeypatch,
):
    album_root = tmp_path / "Artist" / "Album"
    track_path = album_root / "song.mp3"
    failures = []

    class FailingChild:
        name = track_path.name

        @staticmethod
        def is_file():
            raise OSError("file attributes unavailable")

    def list_directory(path):
        assert path == album_root
        return iter([FailingChild()])

    monkeypatch.setattr(library_hydration.Path, "iterdir", list_directory)

    sanitized, changed = sanitize_hydrated_file_cache(
        {str(track_path): {"path": str(track_path), "cover_path": None}},
        {},
        {".jpg"},
        record_file_error=lambda action, **fields: failures.append({
            "action": action,
            **fields,
        }),
    )

    assert sanitized == {}
    assert changed == {}
    assert failures == [{
        "action": "Library hydration directory entry inspection failed",
        "path": str(track_path),
        "error": "file attributes unavailable",
        "error_type": "OSError",
    }]


def test_sanitize_hydrated_file_cache_reports_corrupt_cover_decode_failure(
    tmp_path: Path,
):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    track_path = album_root / "song.mp3"
    cover_path = album_root / "cover.jpg"
    track_path.write_bytes(b"track")
    cover_path.write_bytes(b"not-an-image")
    failures = []

    sanitized, changed = sanitize_hydrated_file_cache(
        {
            str(track_path): {
                "path": str(track_path),
                "cover_path": str(cover_path),
                "local_cover_width": 1200,
                "local_cover_height": 1200,
            }
        },
        {},
        {".jpg"},
        record_file_error=lambda action, **fields: failures.append({
            "action": action,
            **fields,
        }),
    )

    assert sanitized[str(track_path)]["local_cover_width"] is None
    assert sanitized[str(track_path)]["local_cover_height"] is None
    assert changed[str(track_path)]["local_cover_width"] is None
    assert failures
    assert failures[0]["action"] == "Library hydration cover image decode failed"
    assert failures[0]["path"] == str(cover_path)
    assert failures[0]["error"]
    assert failures[0]["error_type"]

def test_sanitize_hydrated_file_cache_reuses_cover_dimension_and_root_resolution_work(tmp_path: Path, monkeypatch):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    first_track_path = album_root / "01 - First.mp3"
    second_track_path = album_root / "02 - Second.mp3"
    cover_path = album_root / "cover.jpg"
    first_track_path.write_bytes(b"track-1")
    second_track_path.write_bytes(b"track-2")
    cover_path.write_bytes(b"cover")

    image_dimension_calls = 0
    root_resolution_calls = 0
    original_root_definition_for_path = (
        __import__("music_app.services.library_hydration", fromlist=["root_definition_for_path"]).root_definition_for_path
    )

    def counting_image_dimensions(path: Path, **_kwargs):
        nonlocal image_dimension_calls
        image_dimension_calls += 1
        return (1200, 1200)

    def counting_root_definition_for_path(roots, path):
        nonlocal root_resolution_calls
        root_resolution_calls += 1
        return original_root_definition_for_path(roots, path)

    monkeypatch.setattr("music_app.services.library_hydration.image_dimensions", counting_image_dimensions)
    monkeypatch.setattr(
        "music_app.services.library_hydration.root_definition_for_path",
        counting_root_definition_for_path,
    )

    file_cache = {
        str(first_track_path): {
            "path": str(first_track_path),
            "album": "Album",
            "album_artist": "Artist",
            "artist": "Artist",
            "title": "First",
            "cover_path": str(cover_path),
            "exception_type": None,
        },
        str(second_track_path): {
            "path": str(second_track_path),
            "album": "Album",
            "album_artist": "Artist",
            "artist": "Artist",
            "title": "Second",
            "cover_path": str(cover_path),
            "exception_type": None,
        },
    }

    sanitize_hydrated_file_cache(
        file_cache,
        {},
        {".jpg"},
        root_definitions=[{"id": "arrivals-1", "path": str(tmp_path), "category": "new_arrivals_roots"}],
    )

    assert image_dimension_calls == 1
    assert root_resolution_calls == 1


def test_refresh_cached_cover_paths_in_library_state_rebuilds_albums_and_schedules_save(tmp_path: Path, monkeypatch):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    track_path = album_root / "song.mp3"
    cover_path = album_root / "cover.jpg"
    track_path.write_bytes(b"track")
    cover_path.write_bytes(b"cover")

    scheduled = []
    rebuilt = []
    monkeypatch.setattr(
        "music_app.services.library_hydration.schedule_cache_updates_save_for_config",
        lambda config, cache_path, changed_entries: scheduled.append((config, cache_path, changed_entries)),
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.build_albums_from_file_cache",
        lambda file_cache, separate_release_keys: rebuilt.append((dict(file_cache), set(separate_release_keys))) or [SimpleNamespace(key="album-1")],
    )

    library_state = {
        "file_cache": {str(track_path): {"path": str(track_path), "cover_path": None}},
        "separate_release_keys": {"separate"},
        "scan_in_progress": False,
        "covers_in_progress": False,
        "cover_path_refresh_at": 0.0,
    }
    config = {"IMAGE_EXTENSIONS": {".jpg"}, "CACHE_PATH": tmp_path / "cache.json"}

    changed = refresh_cached_cover_paths_in_library_state(
        library_state,
        config,
        min_interval_seconds=5.0,
        now=10.0,
    )

    assert changed is True
    assert library_state["cover_path_refresh_at"] == 10.0
    assert library_state["albums"][0].key == "album-1"
    assert rebuilt and rebuilt[0][1] == {"separate"}
    assert scheduled == [
        (
            config,
            tmp_path / "cache.json",
            {str(track_path): {"path": str(track_path), "cover_path": str(cover_path)}},
        )
    ]


def test_hydrate_library_state_from_disk_loads_cache_and_relations(tmp_path: Path, monkeypatch):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    track_path = album_root / "song.mp3"
    cover_path = album_root / "cover.jpg"
    track_path.write_bytes(b"track")
    cover_path.write_bytes(b"cover")

    relations = []
    scheduled = []
    prewarm_calls = []
    adapter = FakeSelectedScanCacheAdapter(
        {
            str(track_path): {
                "path": str(track_path),
                "album": "Album",
                "artist": "Artist",
                "cover_path": None,
                "exception_type": None,
            }
        },
        12.5,
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.select_scan_cache_adapter",
        lambda config: adapter,
    )
    monkeypatch.setattr("music_app.services.library_hydration.library_root_cache_identity", lambda config: "root-identity")
    monkeypatch.setattr(
        "music_app.services.library_hydration.get_library_roots",
        lambda config: [{"id": "main-library-root-1", "path": str(tmp_path), "category": "main_library_roots"}],
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.select_runtime_persistence_adapter",
        lambda seam_id, config: SimpleNamespace(effective_backend="postgres"),
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.load_separate_release_keys",
        lambda config: {"separate"},
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.build_albums_from_file_cache",
        lambda file_cache, separate_release_keys: [SimpleNamespace(key="album-1", tracks=[])],
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.schedule_cache_updates_save_for_config",
        lambda config, cache_path, changed_entries: scheduled.append((config, cache_path, changed_entries)),
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.save_cache_to_disk_for_config",
        lambda *args, **kwargs: None,
    )

    library_state = {"albums": []}
    loaded = hydrate_library_state_from_disk(
        library_state,
        {"CACHE_PATH": tmp_path / "cache.json", "MUSIC_DIR": tmp_path, "IMAGE_EXTENSIONS": {".jpg"}},
        ensure_relations=True,
        ensure_relation_views=lambda state, config: relations.append((state, config)),
        load_exception_overrides=lambda config: {str(track_path): "Non-album rarity"},
        queue_problematic_albums_prewarm=lambda: prewarm_calls.append(True),
    )

    assert loaded is True
    assert library_state["last_scan"] == 12.5
    assert library_state["separate_release_keys"] == {"separate"}
    assert library_state["file_cache"][str(track_path)]["cover_path"] == str(cover_path)
    assert library_state["file_cache"][str(track_path)]["exception_type"] == "Non-album rarity"
    assert relations == [(library_state, {"CACHE_PATH": tmp_path / "cache.json", "MUSIC_DIR": tmp_path, "IMAGE_EXTENSIONS": {".jpg"}})]
    assert prewarm_calls == []
    assert scheduled == []
    assert len(adapter.save_calls) == 1
    saved_cache_path, saved_file_cache, saved_root_identity, saved_last_scan, saved_kwargs = adapter.save_calls[0]
    assert saved_cache_path == tmp_path / "cache.json"
    assert saved_root_identity == "root-identity"
    assert saved_last_scan == 12.5
    assert saved_kwargs == {"relation_views": {}, "relations_last_built": 0.0}
    assert saved_file_cache[str(track_path)]["cover_path"] == str(cover_path)
    assert saved_file_cache[str(track_path)]["library_root_id"] == "main-library-root-1"
    assert saved_file_cache[str(track_path)]["library_root_category"] == "main_library"
    assert saved_file_cache[str(track_path)]["exception_type"] == "Non-album rarity"


def test_hydrate_library_state_from_disk_propagates_selected_postgres_strict_load_error(tmp_path, monkeypatch):
    database_error = RuntimeError("scan cache query failed")

    class FailingPostgresAdapter:
        backend = "postgres"

        def load_snapshot(self, cache_path, root_identity):
            raise AssertionError("selected Postgres hydration must not use compatibility loading")

        def load_snapshot_strict(self, cache_path, root_identity):
            raise database_error

    monkeypatch.setattr(
        "music_app.services.library_hydration.select_scan_cache_adapter",
        lambda config: FailingPostgresAdapter(),
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.library_root_cache_identity",
        lambda config: "root-identity",
    )

    with pytest.raises(RuntimeError) as raised:
        hydrate_library_state_from_disk(
            {"albums": []},
            {"CACHE_PATH": tmp_path / "must-not-be-read.json"},
        )

    assert raised.value is database_error


def test_hydrate_library_state_from_disk_recognizes_completed_empty_postgres_snapshot(tmp_path, monkeypatch):
    adapter = FakeSelectedScanCacheAdapter({}, 123.0)
    monkeypatch.setattr(
        "music_app.services.library_hydration.library_root_cache_identity",
        lambda _config: "root-identity",
    )
    library_state = {
        "albums": [],
        "file_cache": {"stale-track": {"album": "Stale Album"}},
        "last_scan": 0.0,
        "last_error": None,
        "relation_views": {
            "artists": ["Stale Artist"],
            "family_to_artists": {"Stale Family": {"Stale Artist"}},
            "folder_related": {"Stale Artist": set()},
            "sidebar_families": [{"family": "Stale Family"}],
        },
        "relations_last_built": 91.0,
        "separate_release_keys": {"stale-release"},
    }

    hydrated = hydrate_library_state_from_disk(
        library_state,
        {"CACHE_PATH": tmp_path / "unused.json"},
        ensure_relations=False,
        load_exception_overrides=lambda _config: {},
        scan_cache_adapter=adapter,
        strict_scan_cache_load=True,
    )

    assert hydrated is True
    assert library_state["albums"] == []
    assert library_state["file_cache"] == {}
    assert library_state["relation_views"] == {
        "artists": [],
        "family_to_artists": {},
        "folder_related": {},
        "sidebar_families": [],
    }
    assert library_state["relations_last_built"] == 0.0
    assert library_state["separate_release_keys"] == set()
    assert library_state["last_scan"] == 123.0
    assert library_state["last_error"] is None


def test_hydrate_library_state_from_disk_treats_missing_postgres_snapshot_as_unhydrated(tmp_path, monkeypatch):
    adapter = FakeSelectedScanCacheAdapter({}, 0.0)
    monkeypatch.setattr(
        "music_app.services.library_hydration.library_root_cache_identity",
        lambda _config: "root-identity",
    )
    library_state = {"albums": [], "file_cache": {}, "last_scan": 91.0, "last_error": None}

    hydrated = hydrate_library_state_from_disk(
        library_state,
        {"CACHE_PATH": tmp_path / "unused.json"},
        ensure_relations=False,
        load_exception_overrides=lambda _config: {},
        scan_cache_adapter=adapter,
        strict_scan_cache_load=True,
    )

    assert hydrated is False
    assert library_state["last_scan"] == 0.0


def test_hydrate_library_state_from_disk_skips_file_prewarm_when_library_browse_is_postgres(tmp_path: Path, monkeypatch):
    from config import PERSISTENCE_BACKEND_POSTGRES

    class FakePsycopg:
        @staticmethod
        def connect(*args, **kwargs):
            raise AssertionError("availability checks must not open a database connection")

    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    track_path = album_root / "song.mp3"
    track_path.write_bytes(b"track")

    adapter = FakeSelectedScanCacheAdapter(
        {
            str(track_path): {
                "path": str(track_path),
                "album": "Album",
                "artist": "Artist",
                "cover_path": None,
                "exception_type": None,
            }
        },
        12.5,
        {"artists": ["Artist"]},
        22.0,
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.select_scan_cache_adapter",
        lambda config: adapter,
    )
    monkeypatch.setattr("music_app.services.library_hydration.library_root_cache_identity", lambda config: "root-identity")
    monkeypatch.setattr(
        "music_app.services.library_hydration.load_separate_release_keys",
        lambda config: set(),
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.build_albums_from_file_cache",
        lambda file_cache, separate_release_keys: [SimpleNamespace(key="album-1", tracks=[])],
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.schedule_cache_updates_save_for_config",
        lambda config, cache_path, changed_entries: None,
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.save_cache_to_disk_for_config",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.library_root_cache_identity",
        lambda config: "root-identity",
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.get_library_roots",
        lambda config: [{"path": str(tmp_path), "category": "main_library_roots"}],
    )
    monkeypatch.setattr(
        "music_app.services.library_browse_postgres.psycopg",
        FakePsycopg(),
    )

    prewarm_calls = []
    library_state = {"albums": []}
    loaded = hydrate_library_state_from_disk(
        library_state,
        {
            "CACHE_PATH": tmp_path / "cache.json",
            "MUSIC_DIR": tmp_path,
            "IMAGE_EXTENSIONS": {".jpg"},
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "PERSISTENCE_BACKENDS": {
                "library_browse": PERSISTENCE_BACKEND_POSTGRES,
            },
        },
        ensure_relations=True,
        ensure_relation_views=lambda state, config: None,
        load_exception_overrides=lambda config: {},
        queue_problematic_albums_prewarm=lambda: prewarm_calls.append("problematic"),
        queue_utility_rules_prewarm=lambda: prewarm_calls.append("rules"),
    )

    assert loaded is True
    assert prewarm_calls == []


def test_hydrate_library_state_from_disk_skips_relation_rebuild_when_relations_already_exist(tmp_path: Path, monkeypatch):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    track_path = album_root / "song.mp3"
    track_path.write_bytes(b"track")

    monkeypatch.setattr(
        "music_app.services.library_hydration.select_scan_cache_adapter",
        lambda config: FakeSelectedScanCacheAdapter(
            {
                str(track_path): {
                    "path": str(track_path),
                    "album": "Album",
                    "artist": "Artist",
                    "cover_path": None,
                    "exception_type": None,
                }
            },
            12.5,
        ),
    )
    monkeypatch.setattr("music_app.services.library_hydration.library_root_cache_identity", lambda config: "root-identity")
    monkeypatch.setattr(
        "music_app.services.library_hydration.get_library_roots",
        lambda config: [{"id": "main-library-root-1", "path": str(tmp_path), "category": "main_library_roots"}],
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.select_runtime_persistence_adapter",
        lambda seam_id, config: SimpleNamespace(effective_backend="postgres"),
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.load_separate_release_keys",
        lambda config: set(),
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.build_albums_from_file_cache",
        lambda file_cache, separate_release_keys: [SimpleNamespace(key="album-1", tracks=[])],
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.schedule_cache_updates_save_for_config",
        lambda config, cache_path, changed_entries: None,
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.save_cache_to_disk_for_config",
        lambda *args, **kwargs: None,
    )

    relation_calls = []
    library_state = {
        "albums": [],
        "relation_views": {"artists": ["Artist"]},
    }
    loaded = hydrate_library_state_from_disk(
        library_state,
        {"CACHE_PATH": tmp_path / "cache.json", "MUSIC_DIR": tmp_path, "IMAGE_EXTENSIONS": {".jpg"}},
        ensure_relations=True,
        ensure_relation_views=lambda state, config: relation_calls.append(True),
        load_exception_overrides=lambda config: {},
    )

    assert loaded is True
    assert relation_calls == []


def test_hydrate_library_state_from_disk_reuses_persisted_relation_views(tmp_path: Path, monkeypatch):
    album_root = tmp_path / "Artist" / "Album"
    album_root.mkdir(parents=True)
    track_path = album_root / "song.mp3"
    track_path.write_bytes(b"track")

    persisted_relation_views = {
        "artists": ["Artist"],
        "artists_sidebar": [{"artist": "Artist", "count": 1}],
        "family_to_artists": {"Family": {"Artist", "Guest"}},
        "folder_related": {"Artist": {"Guest"}},
        "sidebar_families": [{"family": "Family", "artists": ["Artist", "Guest"], "count": 2}],
        "alias_to_canonical": {"Artist": "Artist"},
        "canonical_to_aliases": {"Artist": ["Artist"]},
    }

    monkeypatch.setattr(
        "music_app.services.library_hydration.select_scan_cache_adapter",
        lambda config: FakeSelectedScanCacheAdapter(
            {
                str(track_path): {
                    "path": str(track_path),
                    "album": "Album",
                    "artist": "Artist",
                    "cover_path": None,
                    "exception_type": None,
                }
            },
            12.5,
            persisted_relation_views,
            22.0,
        ),
    )
    monkeypatch.setattr("music_app.services.library_hydration.library_root_cache_identity", lambda config: "root-identity")
    monkeypatch.setattr(
        "music_app.services.library_hydration.get_library_roots",
        lambda config: [{"id": "main-library-root-1", "path": str(tmp_path), "category": "main_library_roots"}],
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.select_runtime_persistence_adapter",
        lambda seam_id, config: SimpleNamespace(effective_backend="postgres"),
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.load_separate_release_keys",
        lambda config: set(),
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.build_albums_from_file_cache",
        lambda file_cache, separate_release_keys: [SimpleNamespace(key="album-1", tracks=[])],
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.schedule_cache_updates_save_for_config",
        lambda config, cache_path, changed_entries: None,
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.save_cache_to_disk_for_config",
        lambda *args, **kwargs: None,
    )

    sync_calls = []
    relation_calls = []
    library_state = {"albums": [], "relation_views": {}}
    loaded = hydrate_library_state_from_disk(
        library_state,
        {"CACHE_PATH": tmp_path / "cache.json", "MUSIC_DIR": tmp_path, "IMAGE_EXTENSIONS": {".jpg"}},
        ensure_relations=True,
        ensure_relation_views=lambda state, config: relation_calls.append(True),
        load_exception_overrides=lambda config: {},
    )

    assert loaded is True
    assert relation_calls == []
    assert library_state["relation_views"] == persisted_relation_views
    assert library_state["relations_last_built"] == 22.0
    assert "artist_family_projection_relations_last_built" not in library_state
    assert sync_calls == []


def test_hydrate_library_state_from_disk_does_not_sync_projection_after_relation_rebuild(tmp_path: Path, monkeypatch):
    track_path = tmp_path / "Artist" / "Album" / "song.mp3"
    track_path.parent.mkdir(parents=True)
    track_path.write_bytes(b"track")

    selected_file_cache = {
        str(track_path): {
            "path": str(track_path),
            "mtime": float(track_path.stat().st_mtime),
            "size": int(track_path.stat().st_size),
            "album": "Album",
            "album_artist": "Artist",
            "artist": "Artist",
            "title": "Song",
            "track_number": 1,
            "disc_number": None,
            "disc_number_raw": None,
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
    rebuilt_relation_views = {
        "artists": ["Artist", "Guest Artist"],
        "folder_related": {"Artist": {"Guest Artist"}},
        "alias_to_canonical": {"Artist": "Artist", "Guest Artist": "Guest Artist"},
        "canonical_to_aliases": {"Artist": ["Artist"], "Guest Artist": ["Guest Artist"]},
    }
    adapter = FakeSelectedScanCacheAdapter(
        selected_file_cache,
        123.0,
        relation_views={},
        relations_last_built=0.0,
    )
    config = {
        "CACHE_PATH": tmp_path / "cache.json",
        "IMAGE_EXTENSIONS": {".jpg"},
        "LIBRARY_ROOTS_PATH": tmp_path / "library_roots.json",
        "MUSIC_DIR": tmp_path,
    }
    monkeypatch.setattr(
        "music_app.services.library_hydration.select_scan_cache_adapter",
        lambda selected_config, **kwargs: adapter,
        raising=False,
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.library_root_cache_identity",
        lambda selected_config: "root-identity",
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.get_library_roots",
        lambda selected_config: [{"id": "main-library-root-1", "path": str(tmp_path), "category": "main_library"}],
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.select_runtime_persistence_adapter",
        lambda seam_id, selected_config: SimpleNamespace(effective_backend="postgres"),
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.load_separate_release_keys",
        lambda selected_config: set(),
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.build_albums_from_file_cache",
        lambda file_cache, separate_release_keys: [SimpleNamespace(key="album-1", tracks=[])],
    )

    sync_calls = []

    def ensure_relation_views(state, selected_config):
        state["relation_views"] = rebuilt_relation_views
        state["relations_last_built"] = 456.0

    library_state = {"albums": []}
    hydrated = hydrate_library_state_from_disk(
        library_state,
        config,
        ensure_relations=True,
        validate_cache=False,
        ensure_relation_views=ensure_relation_views,
    )

    assert hydrated is True
    assert library_state["relation_views"] == rebuilt_relation_views
    assert library_state["relations_last_built"] == 456.0
    assert "artist_family_projection_relations_last_built" not in library_state
    assert sync_calls == []


def test_hydrate_library_state_from_disk_does_not_seed_artist_family_projection_when_postgres_browse_is_selected(
    tmp_path: Path,
    monkeypatch,
):
    track_path = tmp_path / "Artist" / "Album" / "song.mp3"
    track_path.parent.mkdir(parents=True)
    track_path.write_bytes(b"track")

    selected_file_cache = {
        str(track_path): {
            "path": str(track_path),
            "mtime": float(track_path.stat().st_mtime),
            "size": int(track_path.stat().st_size),
            "album": "Album",
            "album_artist": "Artist",
            "artist": "Artist",
            "title": "Song",
            "track_number": 1,
            "disc_number": None,
            "disc_number_raw": None,
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
    adapter = FakeSelectedScanCacheAdapter(
        selected_file_cache,
        123.0,
        relation_views={},
        relations_last_built=0.0,
    )
    config = {
        "CACHE_PATH": tmp_path / "cache.json",
        "IMAGE_EXTENSIONS": {".jpg"},
        "LIBRARY_ROOTS_PATH": tmp_path / "library_roots.json",
        "MUSIC_DIR": tmp_path,
    }
    monkeypatch.setattr(
        "music_app.services.library_hydration.select_scan_cache_adapter",
        lambda selected_config, **kwargs: adapter,
        raising=False,
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.library_root_cache_identity",
        lambda selected_config: "root-identity",
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.get_library_roots",
        lambda selected_config: [{"id": "main-library-root-1", "path": str(tmp_path), "category": "main_library"}],
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.select_runtime_persistence_adapter",
        lambda seam_id, selected_config: SimpleNamespace(effective_backend="postgres"),
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.load_separate_release_keys",
        lambda selected_config: set(),
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.build_albums_from_file_cache",
        lambda file_cache, separate_release_keys: [SimpleNamespace(key="album-1", tracks=[])],
    )

    library_state = {"albums": []}
    hydrated = hydrate_library_state_from_disk(
        library_state,
        config,
        ensure_relations=False,
        validate_cache=False,
    )

    assert hydrated is True
    assert "artist_family_projection_relations_last_built" not in library_state


def test_hydrate_library_state_uses_selected_postgres_scan_cache_adapter(tmp_path: Path, monkeypatch):
    from config import PERSISTENCE_BACKEND_POSTGRES

    track_path = tmp_path / "Artist" / "Album" / "song.mp3"
    track_path.parent.mkdir(parents=True)
    track_path.write_bytes(b"track")
    cache_path = tmp_path / "library_cache.json"

    selected_file_cache = {
        str(track_path): {
            "path": str(track_path),
            "mtime": float(track_path.stat().st_mtime),
            "size": int(track_path.stat().st_size),
            "album": "Album",
            "album_artist": "Artist",
            "artist": "Artist",
            "title": "Song",
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
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

    class FakePostgresScanCacheAdapter:
        backend = PERSISTENCE_BACKEND_POSTGRES

        def __init__(self):
            self.load_calls = []

        def load_snapshot(self, cache_path_arg, root_identity):
            self.load_calls.append((cache_path_arg, root_identity))
            return (
                selected_file_cache,
                123.0,
                {"artists": ["Artist"], "artists_sidebar": [{"artist": "Artist", "count": 1}]},
                456.0,
                None,
            )

        def save_snapshot(self, *args, **kwargs):
            raise AssertionError("valid selected Postgres cache hydration should not rewrite persistence")

    adapter = FakePostgresScanCacheAdapter()
    config = {
        "CACHE_PATH": cache_path,
        "IMAGE_EXTENSIONS": {".jpg"},
        "LIBRARY_ROOTS_PATH": tmp_path / "library_roots.json",
        "MUSIC_DIR": tmp_path,
        "PERSISTENCE_BACKENDS": {"scan_cache": PERSISTENCE_BACKEND_POSTGRES},
    }
    monkeypatch.setattr(
        "music_app.services.library_hydration.select_scan_cache_adapter",
        lambda selected_config, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit Postgres startup hydration must not select file/JSON fallback")
        ),
        raising=False,
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.library_root_cache_identity",
        lambda selected_config: "root-identity",
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.select_runtime_persistence_adapter",
        lambda seam_id, selected_config: SimpleNamespace(effective_backend="postgres"),
    )
    monkeypatch.setattr("music_app.services.library_hydration.load_separate_release_keys", lambda selected_config: set())

    library_state = {"albums": []}
    hydrated = hydrate_library_state_from_disk(
        library_state,
        config,
        ensure_relations=False,
        validate_cache=False,
        scan_cache_adapter=adapter,
    )

    hydrated_again = hydrate_library_state_from_disk(
        library_state,
        config,
        ensure_relations=False,
        validate_cache=False,
        scan_cache_adapter=adapter,
    )

    assert hydrated is True
    assert hydrated_again is True
    assert adapter.load_calls == [(cache_path, "root-identity")]
    assert library_state["file_cache"] == selected_file_cache
    assert library_state["last_scan"] == 123.0
    assert library_state["relation_views"]["artists"] == ["Artist"]
    assert library_state["relations_last_built"] == 456.0
    assert len(library_state["albums"]) == 1


@pytest.mark.parametrize(
    ("metadata_schema_version", "expected_repair_required"),
    [
        (None, True),
        (1, True),
        (FILE_METADATA_SCHEMA_VERSION, False),
    ],
)
def test_postgres_hydration_marks_incomplete_file_metadata_for_automatic_repair_scan(
    tmp_path: Path,
    monkeypatch,
    metadata_schema_version,
    expected_repair_required,
):
    from config import PERSISTENCE_BACKEND_POSTGRES

    track_path = tmp_path / "Artist" / "Album" / "song.mp3"
    track_path.parent.mkdir(parents=True)
    track_path.write_bytes(b"track")
    file_entry = {
        "path": str(track_path),
        "mtime": float(track_path.stat().st_mtime),
        "size": int(track_path.stat().st_size),
        "album": "Album",
        "album_artist": "Artist",
        "artist": "Artist",
        "title": "Song",
        "album_rating": None,
        "cover_path": None,
    }
    if metadata_schema_version is not None:
        file_entry["metadata_schema_version"] = metadata_schema_version
    if metadata_schema_version == FILE_METADATA_SCHEMA_VERSION:
        file_entry["release_date"] = None

    adapter = FakeSelectedScanCacheAdapter({str(track_path): file_entry}, 123.0)
    adapter.backend = PERSISTENCE_BACKEND_POSTGRES
    config = {
        "CACHE_PATH": tmp_path / "unused-cache.json",
        "IMAGE_EXTENSIONS": {".jpg"},
        "MUSIC_DIR": tmp_path,
    }
    monkeypatch.setattr(
        "music_app.services.library_hydration.library_root_cache_identity",
        lambda _config: "root-identity",
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.load_separate_release_keys",
        lambda _config: set(),
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.select_runtime_persistence_adapter",
        lambda _seam_id, _config: SimpleNamespace(effective_backend="postgres"),
    )

    library_state = {"albums": []}
    hydrated = hydrate_library_state_from_disk(
        library_state,
        config,
        ensure_relations=False,
        validate_cache=False,
        scan_cache_adapter=adapter,
    )

    assert hydrated is True
    assert (
        bool(library_state.get("scan_metadata_repair_required"))
        is expected_repair_required
    )


def test_postgres_hydration_exposes_album_owned_cover_selection_origin(
    tmp_path: Path,
    monkeypatch,
):
    from config import PERSISTENCE_BACKEND_POSTGRES

    track_path = tmp_path / "Artist" / "Album" / "song.mp3"
    track_path.parent.mkdir(parents=True)
    track_path.write_bytes(b"track")
    file_entry = {
        "path": str(track_path),
        "mtime": float(track_path.stat().st_mtime),
        "size": int(track_path.stat().st_size),
        "album": "Album",
        "album_artist": "Artist",
        "artist": "Artist",
        "title": "Song",
        "cover_path": str(track_path.parent / "cover.jpg"),
        "cover_selection_origin": "user",
        "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
        "release_date": None,
    }
    adapter = FakeSelectedScanCacheAdapter({str(track_path): file_entry}, 123.0)
    adapter.backend = PERSISTENCE_BACKEND_POSTGRES
    config = {
        "CACHE_PATH": tmp_path / "unused-cache.json",
        "IMAGE_EXTENSIONS": {".jpg"},
        "MUSIC_DIR": tmp_path,
    }
    monkeypatch.setattr(
        "music_app.services.library_hydration.library_root_cache_identity",
        lambda _config: "root-identity",
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.load_separate_release_keys",
        lambda _config: set(),
    )
    monkeypatch.setattr(
        "music_app.services.library_hydration.select_runtime_persistence_adapter",
        lambda _seam_id, _config: SimpleNamespace(effective_backend="postgres"),
    )

    library_state = {"albums": []}
    assert hydrate_library_state_from_disk(
        library_state,
        config,
        ensure_relations=False,
        validate_cache=False,
        scan_cache_adapter=adapter,
    ) is True
    assert library_state["albums"][0].cover_selection_origin == "user"
