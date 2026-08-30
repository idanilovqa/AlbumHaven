from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services import library_roots


def test_library_root_settings_uses_postgres_adapter_when_selected(tmp_path, monkeypatch):
    sentinel_path = tmp_path / "library_roots.json"
    sentinel_payload = '{"version": 1, "main_library_roots": []}'
    sentinel_path.write_text(sentinel_payload, encoding="utf-8")
    class FakePsycopg:
        def connect(self):
            raise AssertionError("availability should not open a database connection")

    monkeypatch.setattr("music_app.services.library_roots_postgres.psycopg", FakePsycopg())

    class FakePostgresStore:
        saved_payload = None

        def __init__(self, config):
            self.config = config

        def load_settings(self):
            return {
                "version": 1,
                "main_library_roots": [
                    {
                        "id": "pg-main",
                        "path": str((tmp_path / "Postgres Main").resolve(strict=False)),
                        "layout_mode": "artist",
                    }
                ],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
                "move_policy": {},
            }

        def save_settings(self, raw_payload):
            FakePostgresStore.saved_payload = raw_payload
            return {
                "version": 1,
                "main_library_roots": [
                    {
                        "id": "pg-main",
                        "path": str((tmp_path / "Postgres Main").resolve(strict=False)),
                        "layout_mode": "artist",
                    }
                ],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
                "move_policy": {},
            }

    monkeypatch.setattr(
        "music_app.services.library_roots.PostgresLibraryRootSettingsStore",
        FakePostgresStore,
    )
    config = {
        "MUSIC_DIR": tmp_path / "Music",
        "LIBRARY_ROOTS_PATH": sentinel_path,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"library_roots": "postgres"},
    }

    loaded = library_roots.load_library_root_settings(config)
    saved = library_roots.save_library_root_settings(
        config,
        {"main_library_roots": [{"id": "ignored", "path": str(tmp_path / "Ignored")}]},
    )

    assert loaded["main_library_roots"][0]["id"] == "pg-main"
    assert saved["main_library_roots"][0]["id"] == "pg-main"
    assert FakePostgresStore.saved_payload == {
        "main_library_roots": [{"id": "ignored", "path": str(tmp_path / "Ignored")}]
    }
    assert sentinel_path.read_text(encoding="utf-8") == sentinel_payload


def test_library_root_settings_raises_when_postgres_adapter_is_unavailable(tmp_path):
    config = {
        "MUSIC_DIR": tmp_path / "Music",
        "LIBRARY_ROOTS_PATH": tmp_path / "settings" / "library_roots.json",
        "PERSISTENCE_BACKENDS": {"library_roots": "postgres"},
    }

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        library_roots.load_library_root_settings(config)

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        library_roots.save_library_root_settings(
            config,
            {"main_library_roots": [{"id": "main", "path": str(tmp_path / "Music")}]},
        )


def test_library_root_settings_rejects_non_postgres_selection_without_json_fallback(
    tmp_path,
    monkeypatch,
):
    def select_file_backend(seam_id, config):
        assert seam_id == "library_roots"
        return SimpleNamespace(effective_backend="file")

    monkeypatch.setattr(
        "music_app.services.persistence_selection.select_runtime_persistence_adapter",
        select_file_backend,
    )

    config = {
        "MUSIC_DIR": tmp_path / "Music",
        "LIBRARY_ROOTS_PATH": tmp_path / "library_roots.json",
    }

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        library_roots.load_library_root_settings(config)

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        library_roots.save_library_root_settings(
            config,
            {
                "main_library_roots": [{
                    "id": "main-1",
                    "path": str(tmp_path / "Music"),
                    "layout_mode": "artist",
                }],
            },
        )


def test_runtime_library_root_helpers_use_postgres_settings_without_reading_json(tmp_path, monkeypatch):
    postgres_root = (tmp_path / "Postgres Music").resolve()
    sentinel_path = tmp_path / "library_roots.json"
    sentinel_payload = '{"main_library_roots": [{"id": "legacy-main"}]}'
    sentinel_path.write_text(sentinel_payload, encoding="utf-8")
    load_count = 0

    class FakePostgresStore:
        def __init__(self, config):
            assert config["LIBRARY_ROOTS_PATH"] == sentinel_path

        def load_settings(self):
            nonlocal load_count
            load_count += 1
            return {
                "version": 1,
                "main_library_roots": [{
                    "id": "postgres-main",
                    "path": str(postgres_root),
                    "layout_mode": "artist",
                }],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
                "move_policy": {},
            }

    monkeypatch.setattr(
        "music_app.services.library_roots.PostgresLibraryRootSettingsStore",
        FakePostgresStore,
    )
    config = {
        "MUSIC_DIR": tmp_path / "Music",
        "LIBRARY_ROOTS_PATH": sentinel_path,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"library_roots": "postgres"},
    }

    roots = library_roots.get_library_roots(config)
    root_identity = library_roots.library_root_cache_identity(config)
    primary_root = library_roots.get_primary_music_root(config)

    assert roots == [{
        "id": "postgres-main",
        "path": str(postgres_root),
        "layout_mode": "artist",
        "category": "main_library_roots",
    }]
    assert primary_root == postgres_root
    assert isinstance(root_identity, str)
    assert len(root_identity) == 64
    assert load_count == 3
    assert sentinel_path.read_text(encoding="utf-8") == sentinel_payload


def test_configured_library_root_paths_snapshot_reuses_durable_settings_loaded_for_authorization(
    tmp_path,
    monkeypatch,
):
    postgres_root = (tmp_path / "Postgres Music").resolve()
    load_count = 0

    class FakePostgresStore:
        def __init__(self, _config):
            pass

        def load_settings(self):
            nonlocal load_count
            load_count += 1
            return {
                "version": 1,
                "main_library_roots": [{
                    "id": "postgres-main",
                    "path": str(postgres_root),
                    "layout_mode": "artist",
                }],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
                "move_policy": {},
            }

    monkeypatch.setattr(
        "music_app.services.library_roots.PostgresLibraryRootSettingsStore",
        FakePostgresStore,
    )
    config = {
        "MUSIC_DIR": tmp_path / "Music",
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"library_roots": "postgres"},
    }

    library_roots.load_library_root_settings(config)
    root_paths = library_roots.configured_library_root_paths_snapshot(config)

    assert root_paths == (postgres_root,)
    assert load_count == 1


def test_save_library_root_settings_refreshes_authorization_snapshot(tmp_path, monkeypatch):
    original_root = (tmp_path / "Original").resolve()
    saved_root = (tmp_path / "Saved").resolve()

    class FakePostgresStore:
        def __init__(self, _config):
            pass

        def load_settings(self):
            return {
                "version": 1,
                "main_library_roots": [{"id": "main", "path": str(original_root)}],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
                "move_policy": {},
            }

        def save_settings(self, _raw_payload):
            return {
                "version": 1,
                "main_library_roots": [{"id": "main", "path": str(saved_root)}],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
                "move_policy": {},
            }

    monkeypatch.setattr(
        "music_app.services.library_roots.PostgresLibraryRootSettingsStore",
        FakePostgresStore,
    )
    config = {
        "MUSIC_DIR": tmp_path / "Music",
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"library_roots": "postgres"},
    }

    library_roots.load_library_root_settings(config)
    library_roots.save_library_root_settings(
        config,
        {"main_library_roots": [{"id": "main", "path": str(saved_root)}]},
    )

    assert library_roots.configured_library_root_paths_snapshot(config) == (saved_root,)


@pytest.mark.parametrize(
    "helper",
    [
        library_roots.get_library_roots,
        library_roots.get_primary_music_root,
        library_roots.library_root_cache_identity,
    ],
)
def test_runtime_library_root_helpers_fail_loudly_when_postgres_selection_is_unavailable(
    helper,
    tmp_path,
):
    config = {
        "MUSIC_DIR": tmp_path / "Music",
        "LIBRARY_ROOTS_PATH": tmp_path / "must-not-be-read.json",
        "PERSISTENCE_BACKENDS": {"library_roots": "postgres"},
    }

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        helper(config)


@pytest.mark.parametrize(
    "failure",
    [
        ConnectionError("library roots database unavailable"),
        ValueError("Invalid Postgres library root settings shape"),
    ],
    ids=["connection", "shape"],
)
def test_runtime_library_root_helpers_propagate_postgres_store_failures(
    failure,
    tmp_path,
    monkeypatch,
):
    class FailingPostgresStore:
        def __init__(self, _config):
            pass

        def load_settings(self):
            raise failure

    monkeypatch.setattr(
        "music_app.services.library_roots.PostgresLibraryRootSettingsStore",
        FailingPostgresStore,
    )
    config = {
        "MUSIC_DIR": tmp_path / "Music",
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"library_roots": "postgres"},
    }

    for helper in (
        library_roots.get_library_roots,
        library_roots.get_primary_music_root,
        library_roots.library_root_cache_identity,
    ):
        with pytest.raises(type(failure), match=str(failure)):
            helper(config)


def test_runtime_library_root_helpers_preserve_uninitialized_postgres_shape(tmp_path, monkeypatch):
    class EmptyPostgresStore:
        def __init__(self, _config):
            pass

        def load_settings(self):
            return library_roots.empty_library_root_settings()

    monkeypatch.setattr(
        "music_app.services.library_roots.PostgresLibraryRootSettingsStore",
        EmptyPostgresStore,
    )
    config = {
        "MUSIC_DIR": tmp_path / "must-not-become-a-root",
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"library_roots": "postgres"},
    }

    assert library_roots.get_library_roots(config) == []
    assert len(library_roots.library_root_cache_identity(config)) == 64
    with pytest.raises(ValueError, match="not initialized"):
        library_roots.get_primary_music_root(config)


def test_legacy_library_root_json_reading_is_owned_only_by_migration_script():
    repository_root = Path(__file__).resolve().parents[2]
    runtime_source = (
        repository_root / "music_app" / "services" / "library_roots.py"
    ).read_text(encoding="utf-8")
    migration_source = (
        repository_root / "scripts" / "migrate_app_data_to_postgres.py"
    ).read_text(encoding="utf-8")

    assert "library_roots.json" not in runtime_source
    assert "library_roots_settings_path" not in runtime_source
    assert "def _library_roots_settings_path_for_migration" in migration_source
    assert 'str(data_dir / "library_roots.json")' in migration_source
    assert "source_path.read_text" in migration_source


def test_library_root_settings_normalizes_move_policy_path_references(tmp_path):
    main_root = tmp_path / "Main"
    hoard_root = tmp_path / "Hoard"

    settings = library_roots.normalize_library_root_settings(
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(main_root),
                "layout_mode": "artist",
            }],
            "hoarding_library_roots": [{
                "id": "hoard-1",
                "path": str(hoard_root),
            }],
            "move_policy": {
                "preferred_main_write_root": str(main_root),
                "move_new_arrivals_to": str(hoard_root),
            },
        },
        fallback_main_root=tmp_path / "Fallback",
    )

    assert settings["move_policy"] == {
        "preferred_main_write_root": "main-1",
        "move_new_arrivals_to": "hoard-1",
    }


@pytest.mark.parametrize(
    "secondary_keys",
    [
        ("hoarding_library_roots",),
        ("new_arrivals_roots",),
        ("hoarding_library_roots", "new_arrivals_roots"),
    ],
    ids=["hoard-only", "arrivals-only", "both-secondary-only"],
)
def test_persisted_library_root_normalizer_requires_a_main_root(tmp_path, secondary_keys):
    payload = {
        key: [{"id": f"{key}-1", "path": str(tmp_path / key)}]
        for key in secondary_keys
    }

    with pytest.raises(ValueError, match="At least one Main Library root"):
        library_roots.normalize_persisted_library_root_settings(payload)


def test_persisted_library_root_normalizer_accepts_an_explicit_main_root(tmp_path):
    normalized = library_roots.normalize_persisted_library_root_settings(
        {"main_library_roots": [{"id": "main", "path": str(tmp_path / "Main")}]}
    )

    assert normalized["main_library_roots"][0]["id"] == "main"


def test_resolve_candidate_under_root_skips_permission_denied_paths(monkeypatch):
    root = Path(r"X:\SyntheticMusic")
    candidate = Path(r"X:\SyntheticMusic\Blocked\track.mp3")

    def fake_exists(self):
        raise PermissionError("access denied")

    monkeypatch.setattr(Path, "exists", fake_exists)

    resolved = library_roots._resolve_candidate_under_root(
        root=root,
        candidate=candidate,
        require_file=True,
        require_exists=True,
    )

    assert resolved is None


def test_resolve_candidate_under_root_skips_access_denied_oserror_paths(monkeypatch):
    root = Path(r"X:\SyntheticMusic")
    candidate = Path(r"X:\SyntheticMusic\Blocked\track.mp3")

    def fake_exists(self):
        raise OSError(5, "Access is denied")

    monkeypatch.setattr(Path, "exists", fake_exists)

    resolved = library_roots._resolve_candidate_under_root(
        root=root,
        candidate=candidate,
        require_file=True,
        require_exists=True,
    )

    assert resolved is None
