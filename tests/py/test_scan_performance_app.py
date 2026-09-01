from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest


def _load_module():
    path = Path(__file__).resolve().parents[2] / "tests" / "e2e" / "support" / "scanPerformanceApp.py"
    spec = importlib.util.spec_from_file_location("scanPerformanceApp", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_support_is_a_prestart_preparer_without_asgi_runtime_augmentation():
    source = Path("tests/e2e/support/scanPerformanceApp.py").read_text(encoding="utf-8")
    forbidden = (
        "/__" + "e2e",
        "@app." + "middleware",
        "app." + "state",
        "TEST" + "ING",
        "install_debug" + "_routes",
        "start_" + "sampler",
        "hydrate_library_state" + "_for_config",
        "start_background_refresh" + "_for_state",
    )
    assert all(term not in source for term in forbidden)


def test_bootstrap_seed_uses_the_current_required_account_identity_shape():
    module = _load_module()
    sql = module._seed_bootstrap_local_library_sql()

    assert "username_display" in sql
    assert "username_normalized" in sql
    assert "contact_email_normalized" in sql
    assert "scan-performance-owner@example.test" in sql


def test_performance_auth_environment_is_loopback_scoped(monkeypatch):
    module = _load_module()
    monkeypatch.delenv("ALBUM_HAVEN_BOOTSTRAP_USERNAME", raising=False)

    module.configure_performance_auth_environment(4293)

    assert os.environ["ALBUM_HAVEN_BOOTSTRAP_USERNAME"] == "Rendref"
    assert os.environ["ALBUM_HAVEN_BOOTSTRAP_EMAIL"] == "rendref@example.test"
    assert os.environ["ALBUM_HAVEN_PUBLIC_BASE_URL"] == "https://127.0.0.1:4293"
    assert len(os.environ["ALBUM_HAVEN_AUTH_HMAC_SECRET"]) >= 32


def test_scan_ffmpeg_helper_hides_its_windows_process(tmp_path, monkeypatch):
    module = _load_module()
    recorded = {}

    def fake_run(command, **kwargs):
        recorded["command"] = command
        recorded["kwargs"] = kwargs
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(module, "resolve_ffmpeg_executable", lambda: "ffmpeg-test")
    monkeypatch.setattr(module.subprocess, "run", fake_run)

    module.ensure_base_mp3(tmp_path / "base.mp3")

    assert recorded["command"][0] == "ffmpeg-test"
    assert recorded["kwargs"]["creationflags"] == module._NO_WINDOW_CREATION_FLAGS
    assert recorded["kwargs"]["capture_output"] is True
    assert recorded["kwargs"]["check"] is False


def test_database_urls_are_required_and_must_be_isolated():
    module = _load_module()
    with pytest.raises(RuntimeError, match="required"):
        module.resolve_scan_performance_database_urls({})
    env = {
        "ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL": "postgresql://setup@localhost/album_haven_core",
        "ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL": "postgresql://app@localhost/album_haven_core",
    }
    with pytest.raises(RuntimeError, match="must not target album_haven_core"):
        module.resolve_scan_performance_database_urls(env)

    env = {
        "ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL":
            "postgresql://album_haven_migrator@localhost/album_haven_contest",
        "ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL":
            "postgresql://album_haven_app@localhost/album_haven_contest",
    }
    with pytest.raises(RuntimeError, match="album_haven_scan_e2e"):
        module.resolve_scan_performance_database_urls(env)


def test_database_urls_require_setup_and_runtime_role_split():
    module = _load_module()
    env = {
        "ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL": "postgresql://album_haven_migrator@localhost/album_haven_scan_e2e",
        "ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL": "postgresql://album_haven_migrator@localhost/album_haven_scan_e2e",
    }
    with pytest.raises(RuntimeError, match="album_haven_app"):
        module.resolve_scan_performance_database_urls(env)

    env["ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL"] = "postgresql://album_haven_app@localhost/album_haven_scan_e2e"
    assert module.resolve_scan_performance_database_urls(env) == (
        env["ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL"],
        env["ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL"],
    )


@pytest.mark.parametrize(
    ("database_name", "setup_role", "runtime_role"),
    [
        ("album_haven_scan_e2e", "album_haven_migrator", "album_haven_app"),
        (
            "album_haven_ci_perf_123",
            "album_haven_migrator_perf_123",
            "album_haven_app_perf_123",
        ),
    ],
)
def test_database_urls_accept_only_the_legacy_or_exact_ci_suffixed_triple(
    database_name, setup_role, runtime_role
):
    module = _load_module()
    setup_url = f"postgresql://{setup_role}@127.0.0.1:5432/{database_name}"
    runtime_url = f"postgresql://{runtime_role}@127.0.0.1:5432/{database_name}"

    assert module.resolve_scan_performance_database_urls(
        {
            "ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL": setup_url,
            "ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL": runtime_url,
        }
    ) == (setup_url, runtime_url)


@pytest.mark.parametrize(
    ("setup_url", "runtime_url", "extra_env"),
    [
        (
            "postgresql://album_haven_migrator_perf_123@localhost/album_haven_ci_perf_123",
            "postgresql://album_haven_app_perf_456@localhost/album_haven_ci_perf_123",
            {},
        ),
        (
            "postgresql://album_haven_migrator@localhost/album_haven_shared",
            "postgresql://album_haven_app@localhost/album_haven_shared",
            {"ALBUM_HAVEN_SCAN_PERFORMANCE_ALLOW_SHARED_DATABASE": "1"},
        ),
        (
            "postgresql://album_haven_migrator@localhost/album_haven_core",
            "postgresql://album_haven_app@localhost/album_haven_core",
            {},
        ),
        (
            "postgresql://album_haven_migrator_perf_123@db.example.test/album_haven_ci_perf_123",
            "postgresql://album_haven_app_perf_123@db.example.test/album_haven_ci_perf_123",
            {},
        ),
        (
            "postgresql://album_haven_migrator_perf_123:secret@localhost/album_haven_ci_perf_123",
            "postgresql://album_haven_app_perf_123:secret@localhost/album_haven_ci_perf_123",
            {},
        ),
        (
            "postgresql://album_haven_migrator_perf_123@localhost/album_haven_ci_perf_123?host=db.example.test",
            "postgresql://album_haven_app_perf_123@localhost/album_haven_ci_perf_123?host=db.example.test",
            {},
        ),
    ],
)
def test_database_urls_reject_unsafe_or_nonmatching_ci_identity(
    setup_url, runtime_url, extra_env
):
    module = _load_module()
    env = {
        "ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL": setup_url,
        "ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL": runtime_url,
        **extra_env,
    }

    with pytest.raises(RuntimeError):
        module.resolve_scan_performance_database_urls(env)


def test_database_urls_require_documented_least_privilege_roles():
    module = _load_module()
    env = {
        "ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL":
            "postgresql://postgres@localhost/album_haven_scan_e2e",
        "ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL":
            "postgresql://runtime@localhost/album_haven_scan_e2e",
    }
    with pytest.raises(RuntimeError, match="album_haven_migrator"):
        module.resolve_scan_performance_database_urls(env)


def test_read_only_database_preflight_verifies_both_connected_identities():
    module = _load_module()
    env = {
        "ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL":
            "postgresql://album_haven_migrator@localhost/album_haven_scan_e2e",
        "ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL":
            "postgresql://album_haven_app@localhost/album_haven_scan_e2e",
    }
    events = []

    class FakeConnection:
        def __init__(self, identity):
            self.identity = identity

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            events.append(("closed", self.identity))

        def execute(self, sql):
            events.append(("execute", sql, self.identity))
            return self

        def fetchone(self):
            return self.identity

    identities = iter((
        ("album_haven_scan_e2e", "album_haven_migrator", True),
        ("album_haven_scan_e2e", "album_haven_app", False),
    ))

    def connect(database_url, **kwargs):
        events.append(("connect", database_url, kwargs))
        return FakeConnection(next(identities))

    module.preflight_scan_performance_database_connections(env, connect=connect)

    assert [event[0] for event in events].count("connect") == 2
    assert all("default_transaction_read_only=on" in event[2]["options"] for event in events if event[0] == "connect")
    assert all(event[1].lower().startswith("select") for event in events if event[0] == "execute")


def test_read_only_database_preflight_verifies_exact_ci_suffixed_connected_identities():
    module = _load_module()
    env = {
        "ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL":
            "postgresql://album_haven_migrator_perf_123@localhost/album_haven_ci_perf_123",
        "ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL":
            "postgresql://album_haven_app_perf_123@localhost/album_haven_ci_perf_123",
    }
    identities = iter(
        (
            ("album_haven_ci_perf_123", "album_haven_migrator_perf_123", True),
            ("album_haven_ci_perf_123", "album_haven_app_perf_123", False),
        )
    )

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, _sql):
            return self

        def fetchone(self):
            return next(identities)

    module.preflight_scan_performance_database_connections(
        env,
        connect=lambda *_args, **_kwargs: FakeConnection(),
    )


def test_read_only_database_preflight_rejects_connected_identity_mismatch():
    module = _load_module()
    env = {
        "ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL":
            "postgresql://album_haven_migrator@localhost/album_haven_scan_e2e",
        "ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL":
            "postgresql://album_haven_app@localhost/album_haven_scan_e2e",
    }

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, _sql):
            return self

        def fetchone(self):
            return ("album_haven_core", "album_haven_migrator", True)

    with pytest.raises(RuntimeError, match="identity mismatch"):
        module.preflight_scan_performance_database_connections(
            env,
            connect=lambda *_args, **_kwargs: FakeConnection(),
        )


def test_read_only_database_preflight_rejects_setup_without_create_privilege():
    module = _load_module()
    env = {
        "ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL":
            "postgresql://album_haven_migrator@localhost/album_haven_scan_e2e",
        "ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL":
            "postgresql://album_haven_app@localhost/album_haven_scan_e2e",
    }

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, _sql):
            return self

        def fetchone(self):
            return ("album_haven_scan_e2e", "album_haven_migrator", False)

    with pytest.raises(RuntimeError, match="lacks CREATE privilege"):
        module.preflight_scan_performance_database_connections(
            env,
            connect=lambda *_args, **_kwargs: FakeConnection(),
        )


def test_database_identity_normalizes_default_postgres_port():
    module = _load_module()
    assert module._scan_database_identity("postgresql://app@localhost/db") == module._scan_database_identity(
        "postgresql://app@localhost:5432/db"
    )


def test_reset_sql_clears_product_tables_and_not_migration_history():
    module = _load_module()
    sql = module._reset_scan_performance_database_sql().lower()
    assert "restart identity cascade" in sql
    assert "library.libraries" in sql
    assert "library_root_settings" in sql
    assert "schema_migrations" not in sql


def test_runtime_path_guard_rejects_paths_outside_temp_root(tmp_path):
    module = _load_module()
    music_dir = (tmp_path / "music").resolve()
    data_dir = (tmp_path / "data").resolve()
    music_dir.mkdir()
    data_dir.mkdir()
    with pytest.raises(RuntimeError, match="DATA_DIR"):
        module.assert_scan_performance_runtime_paths(
            {
                "MUSIC_DIR": music_dir,
                "DATA_DIR": tmp_path.parent / "outside",
                "CACHE_PATH": data_dir / "cache.json",
                "COVER_CACHE_PATH": data_dir / "covers.json",
                "LIBRARY_ROOTS_PATH": data_dir / "roots.json",
            },
            music_dir,
        )


@pytest.mark.parametrize("provider_groups", ("offline", "manual-only", "manual_only", "manual_urls"))
def test_scan_provider_isolation_accepts_manual_only_production_provider_groups(provider_groups):
    module = _load_module()

    assert module.assert_scan_performance_provider_isolation({
        "ALBUM_HAVEN_COVER_PROVIDER_GROUPS": provider_groups,
    }) == frozenset({"manual_urls"})


@pytest.mark.parametrize(
    "provider_groups",
    ("", "all", "music_services", "discogs", "cover_art_archive", "manual_urls,bandcamp"),
)
def test_scan_provider_isolation_rejects_blank_default_and_network_capable_groups(provider_groups):
    module = _load_module()

    with pytest.raises(RuntimeError, match="offline cover provider configuration"):
        module.assert_scan_performance_provider_isolation({
            "ALBUM_HAVEN_COVER_PROVIDER_GROUPS": provider_groups,
        })


def test_configure_environment_uses_explicit_runner_owned_temp_root(tmp_path, monkeypatch):
    module = _load_module()
    leased_root = (tmp_path / 'runner-owned-scan-root').resolve()
    leased_root.mkdir()
    expected_music_dir = leased_root / 'music'
    environment_keys = (
        'MUSIC_DIR',
        'MUSIC_APP_DATA_DIR',
        'MUSIC_CACHE_PATH',
        'MUSIC_COVER_CACHE_PATH',
        'MUSIC_LIBRARY_ROOTS_PATH',
        'MUSIC_CACHE_MAX_AGE_SECONDS',
        'MUSICBRAINZ_ENABLED',
        'SPOTIFY_CLIENT_ID',
        'SPOTIFY_CLIENT_SECRET',
        'LASTFM_API_KEY',
        'LASTFM_API_SECRET',
        'TMP',
        'TEMP',
        'TMPDIR',
        'ALBUM_HAVEN_APP_DATABASE_URL',
        'ALBUM_HAVEN_PERSISTENCE_SCAN_CACHE',
    )
    previous_environment = {key: os.environ.get(key) for key in environment_keys}
    previous_tempdir = module.tempfile.tempdir
    calls = []
    monkeypatch.setenv('ALBUM_HAVEN_E2E_TEMP_ROOT', str(leased_root))
    monkeypatch.setattr(
        module,
        'resolve_scan_performance_database_urls',
        lambda: ('setup-url', 'runtime-url'),
    )
    monkeypatch.setattr(
        module,
        'initialize_scan_performance_database',
        lambda database_url: calls.append(('initialize', database_url)),
    )
    monkeypatch.setattr(
        module,
        'persist_scan_performance_library_root',
        lambda database_url, music_dir: calls.append(('persist', database_url, music_dir)),
    )
    monkeypatch.setattr(
        module,
        'configure_performance_auth_environment',
        lambda app_port: calls.append(('auth-environment', app_port)),
    )
    monkeypatch.setattr(
        module,
        'provision_performance_auth_owner',
        lambda database_url: calls.append(('auth-owner', database_url)),
    )

    try:
        music_dir = module.configure_environment('add-album')

        assert music_dir == expected_music_dir
        assert module._TEMP_ROOT == leased_root
        assert calls == [
            ('initialize', 'setup-url'),
            ('persist', 'setup-url', expected_music_dir),
            ('auth-environment', 4174),
            ('auth-owner', 'runtime-url'),
        ]
    finally:
        module.cleanup_temp_root()
        module.shutil.rmtree(leased_root, ignore_errors=True)
        module.tempfile.tempdir = previous_tempdir
        for key, value in previous_environment.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _scenario_inputs(tmp_path: Path):
    music_dir = tmp_path / "music"
    music_dir.mkdir()
    base_track = tmp_path / "base.mp3"
    base_track.write_bytes(b"track")
    manifest = [{"artist": "Scan Artist 001", "album": "Album 001", "track_paths": []}]
    return music_dir, manifest, [], base_track


def _patch_scenario_guards(module, monkeypatch, events):
    monkeypatch.setattr(module, "_runtime_config", lambda: {"CACHE_PATH": "unused"})
    monkeypatch.setattr(module, "assert_scan_performance_runtime_paths", lambda *_args: events.append("paths"))
    monkeypatch.setattr(module, "assert_postgres_scan_cache_selected", lambda *_args: events.append("postgres"))
    monkeypatch.setattr(
        module,
        "_seed_baseline_scan_snapshot",
        lambda *_args, **_kwargs: events.append("seed"),
    )


@pytest.mark.parametrize(
    ("scenario", "expected_events"),
    (("cold", ["paths", "postgres"]), ("cached", ["paths", "postgres", "seed"])),
)
def test_cold_and_cached_scenarios_prepare_only_before_startup(tmp_path, monkeypatch, scenario, expected_events):
    module = _load_module()
    inputs = _scenario_inputs(tmp_path)
    events: list[str] = []
    _patch_scenario_guards(module, monkeypatch, events)
    result = module.prepare_scan_scenario(scenario, *inputs)
    assert events == expected_events
    assert result["scenario"] == scenario


def test_add_album_scenario_seeds_then_mutates_filesystem(tmp_path, monkeypatch):
    module = _load_module()
    music_dir, manifest, covers, base_track = _scenario_inputs(tmp_path)
    events: list[str] = []
    _patch_scenario_guards(module, monkeypatch, events)

    def fake_build(**_kwargs):
        events.append("add")
        cover_path = music_dir / "Scan Artist 101" / "Album 1001" / "cover.jpg"
        cover_path.parent.mkdir(parents=True)
        cover_path.write_bytes(b"cover")
        return {"album": "Album 1001", "track_paths": [], "cover_path": str(cover_path)}

    monkeypatch.setattr(module, "build_album_fixture", fake_build)
    result = module.prepare_scan_scenario("add-album", music_dir, manifest, covers, base_track)
    assert events == ["paths", "postgres", "seed", "add"]
    assert manifest[-1]["album"] == "Album 1001"
    assert not Path(manifest[-1]["cover_path"]).exists()
    assert result["added_album_name"] == "Album 1001"


def test_metadata_scenario_seeds_then_changes_fixture_tags(tmp_path, monkeypatch):
    module = _load_module()
    inputs = _scenario_inputs(tmp_path)
    events: list[str] = []
    _patch_scenario_guards(module, monkeypatch, events)

    def fake_update(album, **kwargs):
        events.append("metadata")
        album["album"] = kwargs["new_album_name"]

    monkeypatch.setattr(module, "update_album_tags", fake_update)
    result = module.prepare_scan_scenario("metadata", *inputs)
    assert events == ["paths", "postgres", "seed", "metadata"]
    assert inputs[1][0]["album"] == "Album 001 Metadata Updated"
    assert result["changed_album_name"] == "Album 001 Metadata Updated"


def test_unknown_scenario_is_rejected_before_runtime_setup(tmp_path):
    module = _load_module()
    with pytest.raises(ValueError, match="Unknown scan performance scenario"):
        module.prepare_scan_scenario("unexpected", *_scenario_inputs(tmp_path))


def test_reused_scan_baseline_repairs_owned_mutations_before_scenario(tmp_path, monkeypatch):
    module = _load_module()
    music_dir = tmp_path / "music"
    first_album = music_dir / "Scan Artist 001" / "Album 001"
    first_album.mkdir(parents=True)
    first_tracks = []
    for track_number in range(1, 4):
        track_path = first_album / f"{track_number:02d} - Scan Track {track_number}.mp3"
        track_path.write_bytes(b"changed")
        first_tracks.append(track_path)
    added_album = music_dir / "Scan Artist 101" / "Album 1001"
    added_album.mkdir(parents=True)
    (added_album / "01 - Scan Track 1.mp3").write_bytes(b"added")
    writes = []
    monkeypatch.setattr(
        module,
        "write_track_tags",
        lambda path, **metadata: writes.append((Path(path), metadata)),
    )

    module.restore_reused_scan_library_baseline(music_dir)

    assert not added_album.exists()
    assert [entry[0] for entry in writes] == first_tracks
    assert all(entry[1]["album"] == "Album 001" for entry in writes)
    assert all(entry[1]["year"] == 1995 for entry in writes)


def test_reused_scan_library_skips_existing_album_media_generation(tmp_path, monkeypatch):
    module = _load_module()
    monkeypatch.setattr(module, "_TOTAL_ALBUMS", 2)
    music_dir = tmp_path / "music"
    music_dir.mkdir()
    calls = []
    monkeypatch.setattr(module, "stage_real_cover_pool", lambda _root: [{"staged_path": tmp_path / "cover.jpg"}])
    monkeypatch.setattr(module, "ensure_base_mp3", lambda path: path.write_bytes(b"base"))
    monkeypatch.setattr(
        module,
        "build_album_fixture",
        lambda **kwargs: calls.append(kwargs) or {"album": module.album_folder_name(kwargs["album_index"])},
    )

    manifest, _covers, _base_track = module.build_scan_library(music_dir, reuse_existing=True)

    assert len(manifest) == 2
    assert all(call["reuse_existing"] is True for call in calls)


def test_factory_prepares_scenario_then_returns_production_factory_result(tmp_path, monkeypatch):
    module = _load_module()
    music_dir, manifest, covers, base_track = _scenario_inputs(tmp_path)
    sentinel = object()
    events: list[str] = []
    monkeypatch.setenv("ALBUM_HAVEN_COVER_PROVIDER_GROUPS", "offline")
    monkeypatch.setattr(
        module,
        "configure_environment",
        lambda selected: events.append(f"environment:{selected}") or music_dir,
    )
    monkeypatch.setattr(module, "build_scan_library", lambda _root: events.append("fixtures") or (manifest, covers, base_track))
    monkeypatch.setattr(module, "prepare_scan_scenario", lambda scenario, *_args: events.append(f"scenario:{scenario}"))
    monkeypatch.setattr("music_app.create_asgi_app", lambda: events.append("factory") or sentinel)
    assert module.create_scan_performance_asgi_app("cached") is sentinel
    assert events == ["environment:cached", "fixtures", "scenario:cached", "factory"]


def test_factory_rejects_explicit_network_capable_provider_groups_before_fixture_setup(
    tmp_path,
    monkeypatch,
):
    module = _load_module()
    events: list[str] = []
    monkeypatch.setenv("ALBUM_HAVEN_COVER_PROVIDER_GROUPS", "music_services")
    monkeypatch.setattr(
        module,
        "configure_environment",
        lambda selected: events.append(f"environment:{selected}") or tmp_path,
    )
    monkeypatch.setattr(
        module,
        "build_scan_library",
        lambda _root: pytest.fail("fixture setup must not start with live providers enabled"),
    )

    with pytest.raises(RuntimeError, match="offline cover provider configuration"):
        module.create_scan_performance_asgi_app("add-album")

    assert events == ["environment:add-album"]


def test_factory_fails_before_setup_when_mutagen_is_missing(monkeypatch):
    module = _load_module()
    monkeypatch.setattr(module, "MutagenFile", None)
    monkeypatch.setattr(
        module,
        "configure_environment",
        lambda: pytest.fail("environment setup must not start without Mutagen"),
    )
    with pytest.raises(RuntimeError, match="Mutagen is required"):
        module.create_scan_performance_asgi_app("cold")


def test_baseline_snapshot_persists_the_supplied_scan_marker(tmp_path, monkeypatch):
    module = _load_module()
    captured: dict[str, object] = {}

    def fake_scan(state, **_kwargs):
        state["albums"] = [{"artist": "Scan Artist 001", "album": "Album 001"}]
        return {"track": {"path": "track.mp3"}}, 9_999_999_999.0

    class Adapter:
        def __init__(self, config):
            captured["config"] = config

        def save_snapshot(self, *args, **kwargs):
            captured["args"] = args
            captured["kwargs"] = kwargs
            return {
                "relation_views": {"artists": {}},
                "relations_last_built": 123.0,
            }

    monkeypatch.setattr("music_app.services.library_indexing.scan_library_file_cache", fake_scan)
    monkeypatch.setattr("music_app.services.library_roots.get_library_roots", lambda _config: [])
    monkeypatch.setattr("music_app.services.library_roots.library_root_cache_identity", lambda _config: "roots")
    monkeypatch.setattr("music_app.services.scan_cache_persistence.PostgresScanCacheAdapter", Adapter)
    runtime_config = {
        "CACHE_PATH": tmp_path / "unused.json",
        "SUPPORTED_EXTENSIONS": {".mp3"},
        "IMAGE_EXTENSIONS": {".jpg"},
    }

    module._seed_baseline_scan_snapshot(
        runtime_config,
        tmp_path,
        last_scan_marker=module._CACHED_LAST_SCAN_MARKER,
    )

    assert captured["args"][3] == module._CACHED_LAST_SCAN_MARKER
    assert captured["kwargs"] == {"rebuild_relation_projection": True}
    assert 0 < module._CACHED_LAST_SCAN_MARKER < 9_999_999_999.0


def test_scan_scenario_cache_age_policy_distinguishes_cached_and_incremental_runs():
    module = _load_module()
    assert module.scan_cache_max_age_seconds("cached") == 0
    assert module.scan_cache_max_age_seconds("add-album") == module._INCREMENTAL_CACHE_MAX_AGE_SECONDS
    assert module.scan_cache_max_age_seconds("metadata") == module._INCREMENTAL_CACHE_MAX_AGE_SECONDS
    assert time.time() - module._CACHED_LAST_SCAN_MARKER > module._INCREMENTAL_CACHE_MAX_AGE_SECONDS


@pytest.mark.parametrize("scenario", ["add-album", "metadata"])
def test_incremental_scenarios_seed_a_fresh_snapshot_before_mutation(
    tmp_path,
    monkeypatch,
    scenario,
):
    module = _load_module()
    inputs = _scenario_inputs(tmp_path)
    markers: list[float] = []
    monkeypatch.setattr(module, "_runtime_config", lambda: {"CACHE_PATH": "unused"})
    monkeypatch.setattr(module, "assert_scan_performance_runtime_paths", lambda *_args: None)
    monkeypatch.setattr(module, "assert_postgres_scan_cache_selected", lambda *_args: None)
    monkeypatch.setattr(
        module,
        "_seed_baseline_scan_snapshot",
        lambda *_args, last_scan_marker: markers.append(last_scan_marker),
    )
    monkeypatch.setattr(module.time, "time", lambda: 2_000_000_000.0)
    monkeypatch.setattr(
        module,
        "build_album_fixture",
        lambda **_kwargs: {"album": "Album 1001", "track_paths": []},
    )
    monkeypatch.setattr(module, "update_album_tags", lambda *_args, **_kwargs: None)

    module.prepare_scan_scenario(scenario, *inputs)

    assert markers == [2_000_000_000.0]
    assert 2_000_000_000.0 - markers[0] < module._INCREMENTAL_CACHE_MAX_AGE_SECONDS


def test_launch_sampler_records_only_production_status_responses(tmp_path, monkeypatch):
    module = _load_module()
    calls = 0

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b'{"scan_in_progress":true,"scan_phase":"discovering"}'

    def fake_urlopen(request, timeout):
        nonlocal calls
        assert request.full_url == "http://127.0.0.1:4174/status"
        assert request.get_header("Cookie") == "test-session"
        assert timeout == 2.0
        calls += 1
        if calls == 1:
            raise module.urllib.error.URLError("not listening yet")
        return Response()

    monkeypatch.setattr(module.urllib.request, "urlopen", fake_urlopen)
    samples_path = tmp_path / "status.jsonl"
    sampler = module.ProductionStatusFileSampler(
        status_url="http://127.0.0.1:4174/status",
        samples_path=samples_path,
        interval_seconds=0.005,
    )
    sampler._session_cookie = "test-session"
    sampler.start()
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        if sampler.error is not None:
            break
        if samples_path.exists() and samples_path.stat().st_size > 0:
            break
        time.sleep(0.005)
    sampler.stop()

    assert samples_path.exists(), "Sampler did not create its output file within 1 second."
    lines = samples_path.read_text(encoding="utf-8").splitlines()
    assert lines, "Sampler did not record a production status response within 1 second."
    entry = json.loads(lines[0])
    assert entry["status"]["scan_phase"] == "discovering"
    assert entry["recordedAtEpochMs"] > 0


def test_launch_sampler_defaults_to_low_overhead_bounded_polling(tmp_path):
    module = _load_module()
    sampler = module.ProductionStatusFileSampler(
        status_url="http://127.0.0.1:4174/status",
        samples_path=tmp_path / "status.jsonl",
    )
    sampler._session_cookie = "test-session"
    assert sampler.interval_seconds == 0.05
    assert sampler.request_timeout_seconds == 2.0

    configured = module.ProductionStatusFileSampler(
        status_url="http://127.0.0.1:4174/status",
        samples_path=tmp_path / "configured.jsonl",
        interval_seconds=0.02,
        request_timeout_seconds=0.75,
    )
    assert configured.interval_seconds == 0.02
    assert configured.request_timeout_seconds == 0.75


def test_launch_sampler_persists_error_event_after_successful_prefix(tmp_path, monkeypatch):
    module = _load_module()
    calls = 0

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b'{"scan_in_progress":true}' if calls == 1 else b'not-json'

    def fake_urlopen(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return Response()

    monkeypatch.setattr(module.urllib.request, "urlopen", fake_urlopen)
    samples_path = tmp_path / "status-error.jsonl"
    sampler = module.ProductionStatusFileSampler(
        status_url="http://127.0.0.1:4174/status",
        samples_path=samples_path,
        interval_seconds=0.005,
    )
    sampler._session_cookie = "test-session"
    sampler.start()
    deadline = time.time() + 1
    while time.time() < deadline and sampler.error is None:
        time.sleep(0.005)
    with pytest.raises(RuntimeError, match="Production status sampler failed"):
        sampler.stop()

    entries = [json.loads(line) for line in samples_path.read_text(encoding="utf-8").splitlines()]
    assert entries[0]["status"]["scan_in_progress"] is True
    assert entries[-1]["event"] == "error"
    assert entries[-1]["error"]


@pytest.mark.parametrize("setup_fails", [False, True])
def test_launcher_holds_database_lock_through_server_and_cleanup(setup_fails, monkeypatch):
    module = _load_module()
    events: list[str] = []

    class Lock:
        def __init__(self, **_kwargs):
            pass

        def acquire(self):
            events.append("lock.acquire")

        def release(self):
            events.append("lock.release")

    def factory(scenario):
        assert module._SCAN_STATUS_SAMPLES_ENV not in os.environ
        assert module._SCAN_SCENARIO_ENV not in os.environ
        events.append(f"factory:{scenario}")
        if setup_fails:
            raise RuntimeError("setup failed")
        return object()

    monkeypatch.setattr(sys, "argv", ["scanPerformanceApp.py", "--scenario", "cold"])
    monkeypatch.setenv(module._SCAN_SCENARIO_ENV, "metadata")
    monkeypatch.setenv(module._SCAN_STATUS_SAMPLES_ENV, "C:/tmp/scan-status.jsonl")
    monkeypatch.setattr(module, "resolve_scan_performance_database_urls", lambda: ("setup-url", "runtime-url"))
    monkeypatch.setattr(module, "_scan_database_lock", lambda _url: Lock())
    monkeypatch.setattr(module, "install_shutdown_handlers", lambda: events.append("handlers"))
    monkeypatch.setattr(module, "create_scan_performance_asgi_app", factory)
    monkeypatch.setattr("uvicorn.run", lambda *_args, **_kwargs: events.append("server"))
    monkeypatch.setattr(module, "cleanup_temp_root", lambda: events.append("cleanup"))

    class Sampler:
        def __init__(self, **_kwargs):
            pass

        def start(self):
            events.append("sampler.start")

        def stop(self):
            events.append("sampler.stop")

    monkeypatch.setattr(module, "ProductionStatusFileSampler", Sampler)

    if setup_fails:
        with pytest.raises(RuntimeError, match="setup failed"):
            module.main()
    else:
        module.main()
    assert module._SCAN_SCENARIO_ENV not in os.environ
    assert events[:4] == ["handlers", "lock.acquire", "sampler.start", "factory:cold"]
    assert "sampler.stop" in events
    assert events[-2:] == ["cleanup", "lock.release"]
    assert ("server" in events) is (not setup_fails)


def test_launcher_preserves_caller_owned_scan_profile_root(monkeypatch):
    module = _load_module()
    events: list[str] = []

    class Lock:
        def acquire(self):
            events.append("lock.acquire")

        def release(self):
            events.append("lock.release")

    class Sampler:
        def __init__(self, **_kwargs):
            pass

        def start(self):
            events.append("sampler.start")

        def stop(self):
            events.append("sampler.stop")

    monkeypatch.setattr(sys, "argv", ["scanPerformanceApp.py", "--scenario", "cold"])
    monkeypatch.setenv(module._SCAN_STATUS_SAMPLES_ENV, "C:/tmp/scan-status.jsonl")
    monkeypatch.setenv("ALBUM_HAVEN_E2E_PRESERVE_ON_SHUTDOWN", "1")
    monkeypatch.setattr(module, "resolve_scan_performance_database_urls", lambda: ("setup-url", "runtime-url"))
    monkeypatch.setattr(module, "_scan_database_lock", lambda _url: Lock())
    monkeypatch.setattr(module, "install_shutdown_handlers", lambda: None)
    monkeypatch.setattr(module, "create_scan_performance_asgi_app", lambda _scenario: object())
    monkeypatch.setattr(module, "ProductionStatusFileSampler", Sampler)
    monkeypatch.setattr("uvicorn.run", lambda *_args, **_kwargs: events.append("server"))
    monkeypatch.setattr(module, "cleanup_temp_root", lambda: events.append("cleanup"))

    module.main()

    assert "cleanup" not in events
    assert events[-1] == "lock.release"
