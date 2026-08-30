from __future__ import annotations

import asyncio
import json
from pathlib import Path
from threading import Event, Timer
from types import SimpleNamespace

import pytest
from tests.py.asgi_testing import decode_json as _decode_json
from tests.py.asgi_testing import create_test_asgi_app
from tests.py.asgi_testing import collect_route_paths as _collect_route_paths
from tests.py.asgi_testing import run_asgi_request as _run_asgi_request
from tests.py.asgi_testing import run_asgi_request_async as _run_asgi_request_async
from tests.py.asgi_testing import runtime_app_from_asgi_app
from music_app.services.library_roots import normalize_library_root_settings


@pytest.fixture
def app(tmp_path, monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    class FakeTagEditIntentRepository:
        def __init__(self, config):
            self.config = config

        def prepare_intent(self, *, library_root_identity, changes):
            assert library_root_identity == "test-root"
            assert changes
            return "intent-test"

        def mark_files_verified(self, _intent_id):
            return None

        def complete(self, _intent_id, *, exception_updates=None, **_kwargs):
            if exception_updates:
                asgi_routes.set_track_exception_overrides(
                    self.config,
                    dict(exception_updates),
                )

        def complete_in_transaction(self, *_args, **_kwargs):
            return None

        def mark_terminal(self, *_args, **_kwargs):
            return None

        def mark_recovery_failed(self, *_args, **_kwargs):
            return None

    monkeypatch.setattr(
        asgi_routes,
        "PostgresTagEditIntentRepository",
        FakeTagEditIntentRepository,
    )
    monkeypatch.setattr(
        asgi_routes,
        "library_root_cache_identity",
        lambda _config: "test-root",
    )
    return runtime_app_from_asgi_app(create_test_asgi_app(tmp_path, monkeypatch))


def _make_asgi_app():
    from music_app import create_asgi_app

    return create_asgi_app()


def _complete_mocked_edit_tags_save_task(**kwargs):
    from music_app.services.save_tasks import update_save_task
    from music_app.services.exception_overrides import set_track_exception_overrides

    try:
        if kwargs.get("exception_updates"):
            set_track_exception_overrides(
                kwargs["config"],
                dict(kwargs["exception_updates"]),
            )
        update_save_task(
            kwargs["task_id"],
            status="completed",
        )
    finally:
        release = getattr(kwargs.get("structural_tag_edit_reservation"), "release", None)
        if callable(release):
            release()


def _album(**values):
    defaults = {
        "key": "album",
        "name": "Album",
        "album_artist": "Artist",
        "artists": ["Artist"],
        "cover_path": None,
        "year": "1999",
        "edition": "",
        "album_rating": 0,
        "total_duration_seconds": 0,
        "tracks": [],
        "is_compilation": False,
    }
    defaults.update(values)
    return SimpleNamespace(**defaults)


def test_asgi_wave_a_routes_register_natively(asgi_app):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    route_paths = _collect_route_paths(asgi_app)
    for route_path in (
        "/library-settings",
        "/library-settings/import-album-ratings",
        "/utilities/rules",
        "/utilities/rules/version-exceptions/revert",
        "/utilities/rules/problem-ignores",
        "/utilities/rules/problem-ignores/revert",
        "/versions/ignore",
        "/versions/mark",
        "/versions/unmark",
        "/utilities/move-album",
        "/utilities/save-task/{task_id}",
        "/utilities/repair-album",
        "/utilities/edit-tags",
    ):
        assert route_path in route_paths
    assert not hasattr(asgi_routes, "state")
    assert not hasattr(asgi_routes, "hydrate_library_from_disk")


def test_asgi_library_settings_routes_preserve_read_and_validation_payloads(app, monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    monkeypatch.setattr(
        asgi_routes,
        "load_library_root_settings",
        lambda _config: {
            "main_library_roots": [{"path": str(app.config["MUSIC_DIR"])}],
            "new_arrivals_roots": [],
            "hoard_roots": [],
        },
    )
    asgi_app = _make_asgi_app()

    read_status, _read_headers, read_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/library-settings",
    )
    invalid_status, _invalid_headers, invalid_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/library-settings",
        json_body={"settings": []},
    )

    assert read_status == 200
    read_payload = _decode_json(read_body)
    assert read_payload["ok"] is True
    assert read_payload["settings"]["main_library_roots"][0]["path"] == str(app.config["MUSIC_DIR"])
    assert invalid_status == 400
    assert _decode_json(invalid_body) == {
        "ok": False,
        "error": "Library settings payload must be an object.",
    }


def test_asgi_library_settings_read_uses_asgi_config_without_flask_bridge(app, asgi_app, monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    def fail_flask_app(_request):
        raise AssertionError("GET /library-settings must not read through the Flask bridge")

    def fake_load_library_root_settings(config):
        assert config is asgi_app.state.config
        return {
            "main_library_roots": [{"path": str(app.config["MUSIC_DIR"])}],
            "new_arrivals_roots": [],
            "hoard_roots": [],
        }

    assert not hasattr(asgi_routes, "_flask_app")
    monkeypatch.setattr(asgi_routes, "load_library_root_settings", fake_load_library_root_settings)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/library-settings",
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload == {
        "ok": True,
        "settings": {
            "main_library_roots": [{"path": str(app.config["MUSIC_DIR"])}],
            "new_arrivals_roots": [],
            "hoard_roots": [],
        },
    }


def test_asgi_library_settings_import_album_ratings_delegates_without_starting_scan(
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    calls: list[dict[str, object]] = []

    class FakePostgresAlbumRatingsService:
        def __init__(self, config):
            calls.append({"config": config})

        def import_missing_tag_ratings(self):
            calls[-1]["imported"] = True
            return {"created": 2, "authority_skipped": 3, "failed": 1}

    def fail_scan(*_args, **_kwargs):
        raise AssertionError("an explicit rating import must not start a library scan")

    monkeypatch.setattr(
        asgi_routes,
        "PostgresAlbumRatingsService",
        FakePostgresAlbumRatingsService,
        raising=False,
    )
    monkeypatch.setattr(asgi_routes, "start_background_refresh_for_state", fail_scan)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/library-settings/import-album-ratings",
    )

    assert status == 200
    assert _decode_json(body) == {
        "ok": True,
        "created": 2,
        "authority_skipped": 3,
        "failed": 1,
    }
    assert calls == [{"config": asgi_app.state.config, "imported": True}]


def test_asgi_library_settings_import_album_ratings_offloads_postgres_work(
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    services = []
    threadpool_calls = []

    class FakePostgresAlbumRatingsService:
        def __init__(self, config):
            assert config is asgi_app.state.config
            services.append(self)

        def import_missing_tag_ratings(self):
            return {"created": 2, "authority_skipped": 3, "failed": 1}

    async def fake_run_in_threadpool(function, *args, **kwargs):
        threadpool_calls.append((function, args, kwargs))
        return function(*args, **kwargs)

    monkeypatch.setattr(
        asgi_routes,
        "PostgresAlbumRatingsService",
        FakePostgresAlbumRatingsService,
    )
    monkeypatch.setattr(
        asgi_routes,
        "run_in_threadpool",
        fake_run_in_threadpool,
        raising=False,
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/library-settings/import-album-ratings",
    )

    assert status == 200
    assert _decode_json(body) == {
        "ok": True,
        "created": 2,
        "authority_skipped": 3,
        "failed": 1,
    }
    assert len(services) == 1
    assert len(threadpool_calls) == 1
    function, args, kwargs = threadpool_calls[0]
    assert function.__self__ is services[0]
    assert function.__func__ is FakePostgresAlbumRatingsService.import_missing_tag_ratings
    assert args == ()
    assert kwargs == {}


def test_asgi_library_settings_import_album_ratings_reports_service_failures(
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    class FailingPostgresAlbumRatingsService:
        def __init__(self, config):
            assert config is asgi_app.state.config

        def import_missing_tag_ratings(self):
            raise RuntimeError("database unavailable")

    monkeypatch.setattr(
        asgi_routes,
        "PostgresAlbumRatingsService",
        FailingPostgresAlbumRatingsService,
        raising=False,
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/library-settings/import-album-ratings",
    )

    assert status == 500
    response = _decode_json(body)
    assert response == {
        "ok": False,
        "error": "Failed to import album ratings.",
    }
    assert "database unavailable" not in response["error"]


def test_asgi_library_settings_write_uses_asgi_state_without_bridge_context(app, asgi_app, monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    class FailingAppContext:
        def __enter__(self):
            raise AssertionError("POST /library-settings must not enter Flask app_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_flask_app(_request):
        raise AssertionError("POST /library-settings must not read through _flask_app")

    class FatalFlaskBridge:
        def __getattr__(self, name):
            raise AssertionError(f"POST /library-settings must not read bridge app attribute {name}")

    calls: list[dict[str, object]] = []
    refresh_calls: list[dict[str, object]] = []

    def fake_start_background_refresh_for_state(library_state, config, logger, **kwargs):
        assert library_state is asgi_app.state.library_state
        assert config is asgi_app.state.config
        refresh_calls.append(
            {
                "library_state": library_state,
                "config": config,
                "logger": logger,
                "force": kwargs["force"],
                "scan_mode": kwargs["scan_mode"],
            }
        )
        library_state["scan_in_progress"] = True
        library_state["scan_mode"] = kwargs["scan_mode"]

    def fake_save_library_settings_and_start_refresh(config, settings_payload, **kwargs):
        assert config is asgi_app.state.config
        assert kwargs["library_state"] is asgi_app.state.library_state
        kwargs["start_background_refresh"](force=True, scan_mode="library_settings_update")
        calls.append(
            {
                "config": config,
                "settings_payload": settings_payload,
                "library_state": kwargs["library_state"],
                "status": kwargs["build_status_payload"](),
            }
        )
        return {
            "settings": {
                "main_library_roots": settings_payload["main_library_roots"],
                "new_arrivals_roots": [],
                "hoard_roots": [],
            },
            "status": kwargs["build_status_payload"](),
            "refresh_started": True,
        }

    assert not hasattr(asgi_routes, "_flask_app")
    asgi_logger = SimpleNamespace(name="asgi-library-settings-logger")
    asgi_app.state.logger = asgi_logger
    asgi_app.state.flask_app = FatalFlaskBridge()
    monkeypatch.setattr(
        asgi_routes,
        "start_background_refresh_for_state",
        fake_start_background_refresh_for_state,
    )
    monkeypatch.setattr(
        asgi_routes,
        "save_library_settings_and_start_refresh",
        fake_save_library_settings_and_start_refresh,
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/library-settings",
        json_body={
            "settings": {
                "main_library_roots": [{"path": str(app.config["MUSIC_DIR"])}],
                "new_arrivals_roots": [],
                "hoard_roots": [],
            }
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert payload["ok"] is True
    assert payload["settings"] == {
        "main_library_roots": [{"path": str(app.config["MUSIC_DIR"])}],
        "new_arrivals_roots": [],
        "hoard_roots": [],
    }
    assert payload["status"]["scan_in_progress"] is True
    assert payload["status"]["scan_mode"] == "library_settings_update"
    assert payload["refresh_started"] is True
    assert calls == [
        {
            "config": asgi_app.state.config,
            "settings_payload": {
                "main_library_roots": [{"path": str(app.config["MUSIC_DIR"])}],
                "new_arrivals_roots": [],
                "hoard_roots": [],
            },
            "library_state": asgi_app.state.library_state,
            "status": payload["status"],
        }
    ]
    assert refresh_calls == [
        {
            "library_state": asgi_app.state.library_state,
            "config": asgi_app.state.config,
            "logger": asgi_logger,
            "force": True,
            "scan_mode": "library_settings_update",
        }
    ]


def test_asgi_library_settings_post_persists_settings_and_starts_refresh(app, asgi_app, monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import library_roots as library_roots_module

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_roots": "postgres"}
    saved_settings: dict[str, object] = {}
    refresh_calls: list[dict[str, object]] = []

    class FakeLibraryRootSettingsStore:
        def __init__(self, config):
            assert config is asgi_app.state.config
            self._config = config

        def load_settings(self):
            return dict(saved_settings)

        def save_settings(self, raw_payload):
            normalized = normalize_library_root_settings(
                raw_payload,
                fallback_main_root=Path(self._config["MUSIC_DIR"]).resolve(strict=False),
            )
            saved_settings.clear()
            saved_settings.update(normalized)
            return dict(saved_settings)

    class FakeLibraryRootsPsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("library settings ASGI route test should not open a real database connection")

    def fake_start_background_refresh_for_state(library_state, config, logger, **kwargs):
        refresh_calls.append(
            {
                "library_state": library_state,
                "config": config,
                "logger": logger,
                "force": kwargs["force"],
                "scan_mode": kwargs["scan_mode"],
            }
        )
        library_state["scan_in_progress"] = True
        library_state["scan_mode"] = kwargs["scan_mode"]

    monkeypatch.setattr("music_app.services.library_roots_postgres.psycopg", FakeLibraryRootsPsycopg())
    monkeypatch.setattr(library_roots_module, "PostgresLibraryRootSettingsStore", FakeLibraryRootSettingsStore)
    monkeypatch.setattr(
        asgi_routes,
        "start_background_refresh_for_state",
        fake_start_background_refresh_for_state,
    )

    post_status, _post_headers, post_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/library-settings",
        json_body={
            "settings": {
                "main_library_roots": [
                    {
                        "id": "main-1",
                        "path": str(app.config["MUSIC_DIR"]),
                        "layout_mode": "artist",
                    }
                ],
            }
        },
    )
    get_status, _get_headers, get_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/library-settings",
    )

    post_payload = _decode_json(post_body)
    assert post_status == 200
    assert post_payload["ok"] is True
    assert post_payload["settings"] == saved_settings
    assert post_payload["refresh_started"] is True
    assert post_payload["status"]["scan_in_progress"] is True
    assert post_payload["status"]["scan_mode"] == "library_settings_update"
    assert asgi_app.state.library_state["pending_cover_refresh_after_scan"] is True
    assert refresh_calls == [
        {
            "library_state": asgi_app.state.library_state,
            "config": asgi_app.state.config,
            "logger": asgi_app.state.logger,
            "force": True,
            "scan_mode": "library_settings_update",
        }
    ]
    assert get_status == 200
    assert _decode_json(get_body) == {
        "ok": True,
        "settings": saved_settings,
    }


def test_asgi_library_settings_post_rejects_overlapping_roots(app, asgi_app, monkeypatch):
    from music_app.services import library_roots as library_roots_module

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_roots": "postgres"}
    nested_root = app.config["MUSIC_DIR"] / "Nested"
    nested_root.mkdir(parents=True, exist_ok=True)

    class FakeLibraryRootSettingsStore:
        def __init__(self, config):
            assert config is asgi_app.state.config
            self._config = config

        def save_settings(self, raw_payload):
            return normalize_library_root_settings(
                raw_payload,
                fallback_main_root=Path(self._config["MUSIC_DIR"]).resolve(strict=False),
            )

    class FakeLibraryRootsPsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("overlap validation must fail before connecting to Postgres")

    monkeypatch.setattr("music_app.services.library_roots_postgres.psycopg", FakeLibraryRootsPsycopg())
    monkeypatch.setattr(library_roots_module, "PostgresLibraryRootSettingsStore", FakeLibraryRootSettingsStore)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/library-settings",
        json_body={
            "settings": {
                "main_library_roots": [
                    {
                        "id": "main-1",
                        "path": str(app.config["MUSIC_DIR"]),
                        "layout_mode": "artist",
                    }
                ],
                "new_arrivals_roots": [
                    {
                        "id": "arrivals-1",
                        "path": str(nested_root),
                    }
                ],
            }
        },
    )

    payload = _decode_json(body)
    assert status == 400
    assert payload["ok"] is False
    assert "cannot overlap or nest" in payload["error"]


def test_asgi_library_settings_write_returns_scan_blocked_without_bridge_context(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    class FailingAppContext:
        def __enter__(self):
            raise AssertionError("scan-blocked POST /library-settings must not enter Flask app_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_flask_app(_request):
        raise AssertionError("scan-blocked POST /library-settings must not read through _flask_app")

    asgi_app.state.library_state["scan_in_progress"] = True
    assert not hasattr(asgi_routes, "_flask_app")

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/library-settings",
        json_body={
            "settings": {
                "main_library_roots": [{"path": str(app.config["MUSIC_DIR"])}],
                "new_arrivals_roots": [],
                "hoard_roots": [],
            }
        },
    )

    assert status == 409
    assert _decode_json(body) == {
        "ok": False,
        "error": "Wait for the current library scan to finish before saving library settings.",
    }


def test_asgi_rules_routes_preserve_payloads_mutations_and_cold_start_hydration(app, asgi_app, monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import ignored_versions as ignored_versions_module
    from music_app.services import state as state_service

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "ignored_versions": "postgres",
        "library_browse": "postgres",
    }
    stale_ignored_path = Path(app.config["DATA_DIR"]) / "ignored_versions.json"
    stale_ignored_path.write_text(
        json.dumps({"ignored_version_keys": ["z-album"]}),
        encoding="utf-8",
    )
    ignored_versions = {"z-album"}

    hydrate_calls: list[dict[str, object]] = []

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeLibraryBrowsePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real library-browse database connection")

    class FakeIgnoredVersionsAdapter:
        def __init__(self, _config):
            pass

        def load_ignored_version_keys(self):
            return set(ignored_versions)

        def save_ignored_version_keys(self, values):
            ignored_versions.clear()
            ignored_versions.update(str(value) for value in values)

    class FakePostgresBrowseRepository:
        def __init__(self, _config):
            pass

        def build_utility_rules_payload(self):
            return {
                "ok": True,
                "rules": [{"key": "version-exceptions", "count": len(ignored_versions), "albums": []}],
                "ignored_version_keys": sorted(ignored_versions),
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

    def fail_flask_global_lookup():
        raise AssertionError("ASGI rules routes must not read Flask global state")

    def fake_hydrate_library_state_for_config(
        library_state,
        _config,
        *,
        ensure_relations=True,
        validate_cache=True,
        logger_for_prewarm=None,
    ):
        hydrate_calls.append(
            {
                "ensure_relations": ensure_relations,
                "validate_cache": validate_cache,
                "logger_for_prewarm": logger_for_prewarm,
            }
        )
        library_state["albums"] = []
        library_state["relation_views"] = {}
        return True

    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", FakeLibraryBrowsePsycopg())
    monkeypatch.setattr(ignored_versions_module, "RuleStatePostgresAdapter", FakeIgnoredVersionsAdapter)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository, raising=False)
    monkeypatch.setattr(state_service, "state", fail_flask_global_lookup, raising=False)
    assert not hasattr(state_service, "hydrate_library_from_disk")
    monkeypatch.setattr(asgi_routes, "hydrate_library_state_for_config", fake_hydrate_library_state_for_config)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)

    rules_status, _rules_headers, rules_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/rules",
    )
    ignore_status, _ignore_headers, ignore_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/versions/ignore",
        json_body={"album_key": "a-album"},
    )
    mark_status, _mark_headers, mark_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/versions/mark",
        json_body={"album_key": "child", "parent_album_key": "parent"},
    )

    rules_payload = _decode_json(rules_body)
    assert rules_status == 200
    assert rules_payload["ok"] is True
    assert rules_payload["ignored_version_keys"] == ["z-album"]
    assert ignore_status == 200
    assert _decode_json(ignore_body) == {
        "ok": True,
        "ignored_version_keys": ["a-album", "z-album"],
    }
    assert mark_status == 404
    assert _decode_json(mark_body) == {"ok": False, "error": "Album could not be found"}
    assert hydrate_calls == [
        {
            "ensure_relations": False,
            "validate_cache": False,
            "logger_for_prewarm": asgi_app.state.logger,
        }
    ]
    assert json.loads(stale_ignored_path.read_text(encoding="utf-8")) == {
        "ignored_version_keys": ["z-album"]
    }


def test_asgi_ignore_album_version_uses_asgi_dependencies_without_flask_context(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    class FailingAppContext:
        def __enter__(self):
            raise AssertionError("POST /versions/ignore must not enter Flask app_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_flask_app(_request):
        raise AssertionError("POST /versions/ignore must not read through _flask_app")

    asgi_logger = object()
    asgi_library_state = {
        **app.library_state,
        "_utility_rules_payload_cache": {"stale": True},
        "_utility_rules_payload_cache_signature": ("stale",),
    }
    asgi_app.state.library_state = asgi_library_state
    asgi_app.state.logger = asgi_logger
    app.library_state["_utility_rules_payload_cache"] = {"bridge-cache": True}
    app.library_state["_utility_rules_payload_cache_signature"] = ("bridge-cache",)
    saved_ignored_versions: list[set[str]] = []
    log_calls: list[dict[str, object]] = []

    def fake_load_ignored_version_keys(config):
        assert config is asgi_app.state.config
        return {"album-existing"}

    def fake_save_ignored_version_keys(config, values):
        assert config is asgi_app.state.config
        saved_ignored_versions.append(set(values))

    def fake_log_app_event(config, logger, action, **kwargs):
        log_calls.append(
            {
                "config": config,
                "logger": logger,
                "action": action,
                "kwargs": dict(kwargs),
            }
        )

    assert not hasattr(asgi_routes, "_flask_app")
    monkeypatch.setattr(asgi_routes, "load_ignored_version_keys", fake_load_ignored_version_keys)
    monkeypatch.setattr(asgi_routes, "save_ignored_version_keys", fake_save_ignored_version_keys)
    monkeypatch.setattr(asgi_routes, "log_app_event", fake_log_app_event)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/versions/ignore",
        json_body={"album_key": " album-new "},
    )

    assert status == 200
    assert _decode_json(body) == {
        "ok": True,
        "ignored_version_keys": ["album-existing", "album-new"],
    }
    assert saved_ignored_versions == [{"album-existing", "album-new"}]
    assert "_utility_rules_payload_cache" not in asgi_library_state
    assert "_utility_rules_payload_cache_signature" not in asgi_library_state
    assert app.library_state["_utility_rules_payload_cache"] == {"bridge-cache": True}
    assert app.library_state["_utility_rules_payload_cache_signature"] == ("bridge-cache",)
    assert log_calls == [
        {
            "config": asgi_app.state.config,
            "logger": asgi_logger,
            "action": "Version exception created",
            "kwargs": {"level": "info", "album_key": "album-new"},
        }
    ]


def test_asgi_ignore_album_version_uses_selected_postgres_without_flask_context_or_json(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import ignored_versions as ignored_versions_module

    class FailingAppContext:
        def __enter__(self):
            raise AssertionError("selected Postgres POST /versions/ignore must not enter Flask app_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_flask_app(_request):
        raise AssertionError("selected Postgres POST /versions/ignore must not read through _flask_app")

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"ignored_versions": "postgres"}
    ignored_json_path = Path(app.config["DATA_DIR"]) / "ignored_versions.json"
    ignored_json_path.write_text(
        json.dumps({"ignored_version_keys": ["file-era-stale"]}),
        encoding="utf-8",
    )
    ignored_versions = {"postgres-existing"}

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeIgnoredVersionsAdapter:
        def __init__(self, config):
            assert config is asgi_app.state.config

        def load_ignored_version_keys(self):
            return set(ignored_versions)

        def save_ignored_version_keys(self, values):
            ignored_versions.clear()
            ignored_versions.update(str(value) for value in values)

    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr(ignored_versions_module, "RuleStatePostgresAdapter", FakeIgnoredVersionsAdapter)
    assert not hasattr(asgi_routes, "_flask_app")
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/versions/ignore",
        json_body={"album_key": "postgres-new"},
    )

    assert status == 200
    assert _decode_json(body) == {
        "ok": True,
        "ignored_version_keys": ["postgres-existing", "postgres-new"],
    }
    assert ignored_versions == {"postgres-existing", "postgres-new"}
    assert json.loads(ignored_json_path.read_text(encoding="utf-8")) == {
        "ignored_version_keys": ["file-era-stale"]
    }


def test_asgi_mark_album_version_uses_asgi_state_aliases_and_logging_without_flask_context(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import state as state_service

    class FailingAppContext:
        def __enter__(self):
            raise AssertionError("POST /versions/mark must not enter Flask app_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_flask_app(_request):
        raise AssertionError("POST /versions/mark must not read through _flask_app")

    def fail_flask_global_lookup():
        raise AssertionError("POST /versions/mark must not read Flask global state")

    asgi_logger = object()
    manual_links: dict[str, str] = {}
    saved_links: list[dict[str, str]] = []
    log_calls: list[dict[str, object]] = []
    asgi_app.state.logger = asgi_logger
    asgi_app.state.library_state = {
        **app.library_state,
        "albums": [
            _album(key="child", album_artist="Neal Morse", artists=["Neal Morse"]),
            _album(key="parent", album_artist="Neal Morse & Band", artists=["Neal Morse & Band"]),
        ],
        "relation_views": {
            "alias_to_canonical": {
                "Neal Morse": "Neal Morse",
                "Neal Morse & Band": "Neal Morse",
            }
        },
    }
    app.library_state["albums"] = [
        _album(key="bridge-child", album_artist="Different Artist", artists=["Different Artist"])
    ]
    app.library_state["relation_views"] = {"alias_to_canonical": {}}

    def fake_load_manual_version_links(config):
        assert config is asgi_app.state.config
        return dict(manual_links)

    def fake_save_manual_version_links(config, values):
        assert config is asgi_app.state.config
        manual_links.clear()
        manual_links.update({str(key): str(value) for key, value in values.items()})
        saved_links.append(dict(manual_links))

    def fake_log_app_event(config, logger, action, **kwargs):
        log_calls.append(
            {
                "config": config,
                "logger": logger,
                "action": action,
                "kwargs": dict(kwargs),
            }
        )

    assert not hasattr(asgi_routes, "_flask_app")
    monkeypatch.setattr(state_service, "state", fail_flask_global_lookup, raising=False)
    monkeypatch.setattr(asgi_routes, "load_manual_version_links", fake_load_manual_version_links)
    monkeypatch.setattr(asgi_routes, "save_manual_version_links", fake_save_manual_version_links)
    monkeypatch.setattr(asgi_routes, "log_app_event", fake_log_app_event)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/versions/mark",
        json_body={"album_key": "child", "parent_album_key": "parent"},
    )

    assert status == 200
    assert _decode_json(body) == {"ok": True, "manual_version_links": {"child": "parent"}}
    assert saved_links == [{"child": "parent"}]
    assert log_calls == [
        {
            "config": asgi_app.state.config,
            "logger": asgi_logger,
            "action": "Manual version link created",
            "kwargs": {"level": "info", "album_key": "child", "parent_album_key": "parent"},
        }
    ]


def test_asgi_mark_album_version_hydrates_cold_start_asgi_state_without_flask_globals(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import state as state_service

    class FailingAppContext:
        def __enter__(self):
            raise AssertionError("cold-start POST /versions/mark must not enter Flask app_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_flask_app(_request):
        raise AssertionError("cold-start POST /versions/mark must not read through _flask_app")

    def fail_flask_global_lookup():
        raise AssertionError("cold-start POST /versions/mark must not read Flask global state")

    hydrate_calls: list[dict[str, object]] = []
    manual_links: dict[str, str] = {}
    asgi_library_state = {
        **app.library_state,
        "albums": [],
        "relation_views": {},
        "scan_in_progress": False,
    }
    asgi_app.state.library_state = asgi_library_state
    app.library_state["albums"] = [
        _album(key="bridge-child", album_artist="Different Artist", artists=["Different Artist"])
    ]

    def fake_hydrate_library_state_for_config(library_state, config, **kwargs):
        hydrate_calls.append(
            {
                "library_state": library_state,
                "config": config,
                "kwargs": dict(kwargs),
            }
        )
        library_state["albums"] = [
            _album(key="child", album_artist="Neal Morse", artists=["Neal Morse"]),
            _album(key="parent", album_artist="Neal Morse & Band", artists=["Neal Morse & Band"]),
        ]
        library_state["relation_views"] = {
            "alias_to_canonical": {
                "Neal Morse": "Neal Morse",
                "Neal Morse & Band": "Neal Morse",
            }
        }
        return True

    def fake_load_manual_version_links(config):
        assert config is asgi_app.state.config
        return dict(manual_links)

    def fake_save_manual_version_links(config, values):
        assert config is asgi_app.state.config
        manual_links.clear()
        manual_links.update({str(key): str(value) for key, value in values.items()})

    assert not hasattr(asgi_routes, "_flask_app")
    monkeypatch.setattr(state_service, "state", fail_flask_global_lookup, raising=False)
    assert not hasattr(state_service, "hydrate_library_from_disk")
    monkeypatch.setattr(
        asgi_routes,
        "hydrate_library_state_for_config",
        fake_hydrate_library_state_for_config,
        raising=False,
    )
    monkeypatch.setattr(asgi_routes, "load_manual_version_links", fake_load_manual_version_links)
    monkeypatch.setattr(asgi_routes, "save_manual_version_links", fake_save_manual_version_links)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/versions/mark",
        json_body={"album_key": "child", "parent_album_key": "parent"},
    )

    assert status == 200
    assert _decode_json(body) == {"ok": True, "manual_version_links": {"child": "parent"}}
    assert hydrate_calls == [
        {
            "library_state": asgi_library_state,
            "config": asgi_app.state.config,
            "kwargs": {
                "ensure_relations": False,
                "validate_cache": False,
                "logger_for_prewarm": asgi_app.state.logger,
            },
        }
    ]
    assert asgi_library_state["albums"][0].key == "child"
    assert manual_links == {"child": "parent"}


def test_asgi_unmark_album_version_uses_asgi_config_and_logging_without_flask_context(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    class FailingAppContext:
        def __enter__(self):
            raise AssertionError("POST /versions/unmark must not enter Flask app_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_flask_app(_request):
        raise AssertionError("POST /versions/unmark must not read through _flask_app")

    asgi_logger = object()
    manual_links = {"child": "parent", "sibling": "parent"}
    saved_links: list[dict[str, str]] = []
    log_calls: list[dict[str, object]] = []
    asgi_app.state.logger = asgi_logger

    def fake_load_manual_version_links(config):
        assert config is asgi_app.state.config
        return dict(manual_links)

    def fake_save_manual_version_links(config, values):
        assert config is asgi_app.state.config
        manual_links.clear()
        manual_links.update({str(key): str(value) for key, value in values.items()})
        saved_links.append(dict(manual_links))

    def fake_log_app_event(config, logger, action, **kwargs):
        log_calls.append(
            {
                "config": config,
                "logger": logger,
                "action": action,
                "kwargs": dict(kwargs),
            }
        )

    assert not hasattr(asgi_routes, "_flask_app")
    monkeypatch.setattr(asgi_routes, "load_manual_version_links", fake_load_manual_version_links)
    monkeypatch.setattr(asgi_routes, "save_manual_version_links", fake_save_manual_version_links)
    monkeypatch.setattr(asgi_routes, "log_app_event", fake_log_app_event)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/versions/unmark",
        json_body={"album_key": " child "},
    )

    assert status == 200
    assert _decode_json(body) == {
        "ok": True,
        "manual_version_links": {"sibling": "parent"},
    }
    assert saved_links == [{"sibling": "parent"}]
    assert log_calls == [
        {
            "config": asgi_app.state.config,
            "logger": asgi_logger,
            "action": "Manual version link removed",
            "kwargs": {"level": "info", "album_key": "child"},
        }
    ]


def test_asgi_mark_album_version_uses_selected_postgres_manual_versions_without_json(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import manual_versions as manual_versions_module

    class FailingAppContext:
        def __enter__(self):
            raise AssertionError("selected Postgres POST /versions/mark must not enter Flask app_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_flask_app(_request):
        raise AssertionError("selected Postgres POST /versions/mark must not read through _flask_app")

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"manual_versions": "postgres"}
    manual_versions_json_path = Path(app.config["DATA_DIR"]) / "manual_versions.json"
    manual_versions_json_path.write_text(
        json.dumps({"manual_version_links": {"file-era-child": "file-era-parent"}}),
        encoding="utf-8",
    )
    manual_links = {"postgres-existing": "postgres-parent"}
    asgi_app.state.library_state = {
        **app.library_state,
        "albums": [
            _album(key="child", album_artist="Neal Morse", artists=["Neal Morse"]),
            _album(key="parent", album_artist="Neal Morse & Band", artists=["Neal Morse & Band"]),
        ],
        "relation_views": {
            "alias_to_canonical": {
                "Neal Morse": "Neal Morse",
                "Neal Morse & Band": "Neal Morse",
            }
        },
    }

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeManualVersionsAdapter:
        def __init__(self, config):
            assert config is asgi_app.state.config

        def load_manual_version_links(self):
            return dict(manual_links)

        def save_manual_version_links(self, values):
            manual_links.clear()
            manual_links.update({str(key): str(value) for key, value in values.items()})

    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr(manual_versions_module, "RuleStatePostgresAdapter", FakeManualVersionsAdapter)
    assert not hasattr(asgi_routes, "_flask_app")
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/versions/mark",
        json_body={"album_key": "child", "parent_album_key": "parent"},
    )

    assert status == 200
    assert _decode_json(body) == {
        "ok": True,
        "manual_version_links": {
            "child": "parent",
            "postgres-existing": "postgres-parent",
        },
    }
    assert manual_links == {"child": "parent", "postgres-existing": "postgres-parent"}
    assert json.loads(manual_versions_json_path.read_text(encoding="utf-8")) == {
        "manual_version_links": {"file-era-child": "file-era-parent"}
    }


def test_asgi_unmark_album_version_uses_selected_postgres_manual_versions_without_json(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import manual_versions as manual_versions_module

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"manual_versions": "postgres"}
    manual_versions_json_path = Path(app.config["DATA_DIR"]) / "manual_versions.json"
    manual_versions_json_path.write_text(
        json.dumps({"manual_version_links": {"file-era-child": "file-era-parent"}}),
        encoding="utf-8",
    )
    manual_links = {"child": "parent", "sibling": "parent"}

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeManualVersionsAdapter:
        def __init__(self, config):
            assert config is asgi_app.state.config

        def load_manual_version_links(self):
            return dict(manual_links)

        def save_manual_version_links(self, values):
            manual_links.clear()
            manual_links.update({str(key): str(value) for key, value in values.items()})

    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr(manual_versions_module, "RuleStatePostgresAdapter", FakeManualVersionsAdapter)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/versions/unmark",
        json_body={"album_key": "child"},
    )

    assert status == 200
    assert _decode_json(body) == {
        "ok": True,
        "manual_version_links": {"sibling": "parent"},
    }
    assert manual_links == {"sibling": "parent"}
    assert json.loads(manual_versions_json_path.read_text(encoding="utf-8")) == {
        "manual_version_links": {"file-era-child": "file-era-parent"}
    }


def test_asgi_utility_rules_legacy_get_uses_explicit_asgi_dependencies_without_flask_context(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    class FailingAppContext:
        def __enter__(self):
            raise AssertionError("legacy GET /utilities/rules must not enter Flask app_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_flask_app(_request):
        raise AssertionError("legacy GET /utilities/rules must not read through _flask_app")

    class LegacySelection:
        effective_backend = "legacy"

    calls: list[dict[str, object]] = []
    asgi_logger = object()
    asgi_library_state = {
        **app.library_state,
        "albums": [{"key": "explicit-state-album"}],
        "file_cache": {
            "C:/Music/Artist/Album/01 - Track.flac": {
                "album": "Album",
                "album_artist": "Artist",
            }
        },
        "relation_views": {"alias_to_canonical": {"Alias": "Canonical"}},
    }
    asgi_app.state.library_state = asgi_library_state
    asgi_app.state.logger = asgi_logger

    def fake_cached_rules_payload(**kwargs):
        calls.append(dict(kwargs))
        assert kwargs["library_state"] is asgi_library_state
        assert kwargs["config"] is asgi_app.state.config
        assert kwargs["logger"] is asgi_logger
        return {
            "ok": True,
            "rules": [{"key": "version-exceptions", "count": 0, "albums": []}],
            "ignored_version_keys": [],
        }

    assert not hasattr(asgi_routes, "_flask_app")
    monkeypatch.setattr(
        asgi_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, config: LegacySelection(),
    )
    monkeypatch.setattr(asgi_routes, "build_cached_utility_rules_payload", fake_cached_rules_payload)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/rules",
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["ok"] is True
    assert payload["rules"][0]["key"] == "version-exceptions"
    assert payload["ignored_version_keys"] == []
    assert len(calls) == 1


def test_asgi_utility_rules_legacy_get_returns_version_and_problem_ignore_payloads(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    class LegacySelection:
        effective_backend = "legacy"

    ignored_row_key = str((Path(app.config["MUSIC_DIR"]) / "Artist" / "Album" / "song.mp3").resolve()) + "::year"
    ignored_path = ignored_row_key.split("::", 1)[0]
    asgi_app.state.library_state = {
        **app.library_state,
        "albums": [_album(key="album-1", name="Test Album", album_artist="Artist One")],
        "file_cache": {
            ignored_path: {
                "path": ignored_path,
                "album": "Problem Album",
                "album_artist": "Problem Artist",
                "artist": "Problem Artist",
                "year": "",
            },
        },
        "relation_views": {},
    }

    monkeypatch.setattr(
        asgi_routes,
        "select_runtime_persistence_adapter",
        lambda _seam_id, _config: LegacySelection(),
    )
    monkeypatch.setattr(asgi_routes, "load_ignored_version_keys", lambda _config: {"album-1"})
    monkeypatch.setattr(asgi_routes, "load_ignored_repair_keys", lambda _config: {ignored_row_key})

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/rules",
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["ok"] is True
    assert payload["ignored_version_keys"] == ["album-1"]
    version_rule, problem_rule = payload["rules"]
    assert version_rule["key"] == "version-exceptions"
    assert version_rule["count"] == 1
    assert version_rule["albums"][0]["key"] == "album-1"
    assert problem_rule["key"] == "problem-ignores"
    assert problem_rule["count"] == 1
    assert problem_rule["items"][0]["row_key"] == ignored_row_key
    assert problem_rule["items"][0]["problem_reason"] == "Missing year"


def test_asgi_utility_rules_uses_postgres_projection_without_flask_context(app, asgi_app, monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    class FailingAppContext:
        def __enter__(self):
            raise AssertionError("Postgres utility rules path must not enter Flask app_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_flask_app(_request):
        raise AssertionError("Postgres utility rules path must not read through the Flask bridge")

    def fail_cached_rules_payload():
        raise AssertionError("Postgres utility rules path must not use the cached JSON-backed rules payload")

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://album_haven_app@localhost/app"

        def build_utility_rules_payload(self):
            return {
                "ok": True,
                "rules": [{"key": "version-exceptions", "count": 1, "albums": []}],
                "ignored_version_keys": ["album-1"],
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", type("FakePsycopg", (), {"connect": lambda self: None})())
    assert not hasattr(asgi_routes, "_flask_app")
    monkeypatch.setattr(asgi_routes, "build_cached_utility_rules_payload", fail_cached_rules_payload)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository, raising=False)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/rules",
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["ok"] is True
    assert payload["ignored_version_keys"] == ["album-1"]
    assert payload["view_data_source"] == "postgres_library_browse"
    assert payload["persistence_backend"] == "postgres"
    assert payload["persistence_seam"] == "library_browse"


def test_asgi_revert_version_exception_legacy_response_uses_asgi_dependencies_without_flask_context(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    class FailingAppContext:
        def __enter__(self):
            raise AssertionError("POST /utilities/rules/version-exceptions/revert must not enter Flask app_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_flask_app(_request):
        raise AssertionError("POST /utilities/rules/version-exceptions/revert must not read through _flask_app")

    class LegacySelection:
        effective_backend = "legacy"

    asgi_logger = object()
    asgi_library_state = {
        **app.library_state,
        "albums": [{"key": "explicit-version-state"}],
        "file_cache": {},
        "relation_views": {},
        "_utility_rules_payload_cache": {"stale": True},
        "_utility_rules_payload_cache_signature": ("stale",),
    }
    asgi_app.state.library_state = asgi_library_state
    asgi_app.state.logger = asgi_logger
    app.library_state["_utility_rules_payload_cache"] = {"bridge-cache": True}
    saved_ignored_versions: list[set[str]] = []
    cached_calls: list[dict[str, object]] = []

    def fake_select_runtime_persistence_adapter(seam_id, config):
        assert seam_id in {"library_browse", "ignored_versions"}
        assert config is asgi_app.state.config
        return LegacySelection()

    def fake_load_ignored_version_keys(config):
        assert config is asgi_app.state.config
        return {"album-old", "album-remove"}

    def fake_save_ignored_version_keys(config, values):
        assert config is asgi_app.state.config
        saved_ignored_versions.append(set(values))

    def fake_cached_rules_payload(**kwargs):
        cached_calls.append(dict(kwargs))
        assert kwargs["library_state"] is asgi_library_state
        assert kwargs["config"] is asgi_app.state.config
        assert kwargs["logger"] is asgi_logger
        assert "_utility_rules_payload_cache" not in asgi_library_state
        assert "_utility_rules_payload_cache_signature" not in asgi_library_state
        return {
            "ok": True,
            "rules": [{"key": "version-exceptions", "count": 1, "albums": []}],
            "ignored_version_keys": sorted(saved_ignored_versions[-1]),
        }

    assert not hasattr(asgi_routes, "_flask_app")
    monkeypatch.setattr(
        asgi_routes,
        "select_runtime_persistence_adapter",
        fake_select_runtime_persistence_adapter,
    )
    monkeypatch.setattr(asgi_routes, "load_ignored_version_keys", fake_load_ignored_version_keys)
    monkeypatch.setattr(asgi_routes, "save_ignored_version_keys", fake_save_ignored_version_keys)
    monkeypatch.setattr(asgi_routes, "build_cached_utility_rules_payload", fake_cached_rules_payload)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/rules/version-exceptions/revert",
        json_body={"album_key": "album-remove"},
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["ok"] is True
    assert payload["ignored_version_keys"] == ["album-old"]
    assert saved_ignored_versions == [{"album-old"}]
    assert len(cached_calls) == 1
    assert app.library_state["_utility_rules_payload_cache"] == {"bridge-cache": True}


def test_asgi_create_problem_ignores_returns_full_compact_ack_without_broad_projection(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    album_key = "neal morse::?"
    row_key = f"{album_key}::problem-album::undecoded-characters"
    canonical_item = {
        "row_key": row_key,
        "scope": "album",
        "path": "",
        "filename": "",
        "field": "problem-album",
        "album": "?",
        "artist": "Neal Morse",
        "year": "2005",
        "problem_reason": "Undecoded characters",
        "album_group_key": "Neal Morse :: ?",
    }
    calls: list[dict[str, object]] = []

    class FakeRepository:
        def __init__(self, config):
            assert config is asgi_app.state.config

        def resolve_problem_exclusion_items(self, items):
            resolved_owners = {
                (item.row_key, item.album_key, item.path)
                for item in items
            }
            assert resolved_owners == {(row_key, album_key, "")}
            calls.append({"resolved": resolved_owners})
            return [{**canonical_item, "album_key": album_key, "legacy_row_keys": []}]

        def build_utility_rules_payload(self):
            raise AssertionError("compact create must not build the broad Rules projection")

        def build_problematic_files_payload(self):
            raise AssertionError("compact create must not build Problematic Files")

    def fake_create(config, payload, *, resolve_items):
        assert config is asgi_app.state.config
        calls.append({"payload": dict(payload)})
        parsed_item = SimpleNamespace(
            row_key=row_key,
            scope="album",
            album_key=album_key,
            path="",
        )
        assert resolve_items((parsed_item,))[0]["row_key"] == row_key
        return SimpleNamespace(
            applied_items=[canonical_item],
            removed_legacy_row_keys=[],
        )

    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakeRepository)
    monkeypatch.setattr(asgi_routes, "create_problem_exclusions", fake_create, raising=False)
    monkeypatch.setattr(
        asgi_routes,
        "build_cached_utility_rules_payload",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("compact create must not build cached Rules")
        ),
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/rules/problem-ignores",
        json_body={
            "items": [{
                "row_key": row_key,
                "scope": "album",
                "album_key": album_key,
            }],
        },
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload == {
        "ok": True,
        "applied_items": [canonical_item],
        "removed_legacy_row_keys": [],
    }
    assert "rules" not in payload
    assert "updated_albums" not in payload
    assert "updated_problematic_album" not in payload
    assert calls == [
        {"payload": {
            "items": [{
                "row_key": row_key,
                "scope": "album",
                "album_key": album_key,
            }],
        }},
        {"resolved": {(row_key, album_key, "")}},
    ]


def test_asgi_create_problem_ignores_passes_mixed_album_and_file_batch_to_one_mutation(
    asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    album_row_key = "neal morse::?::problem-album::undecoded-characters"
    path = "C:/Music/Neal Morse/?/01 - The Temple.mp3"
    file_row_key = f"{path}::problem-file::missing-year"
    items = [
        {"row_key": album_row_key, "scope": "album", "album_key": "neal morse::?"},
        {"row_key": file_row_key, "scope": "file", "path": path},
    ]
    calls: list[list[dict[str, object]]] = []

    def fake_create(_config, payload, *, resolve_items):
        del resolve_items
        calls.append(list(payload["items"]))
        return SimpleNamespace(applied_items=[], removed_legacy_row_keys=[])

    monkeypatch.setattr(asgi_routes, "create_problem_exclusions", fake_create, raising=False)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/rules/problem-ignores",
        json_body={"items": items},
    )

    assert status == 200
    assert _decode_json(body) == {
        "ok": True,
        "applied_items": [],
        "removed_legacy_row_keys": [],
    }
    assert calls == [items]


@pytest.mark.parametrize(
    "extra_field,extra_value",
    (
        ("album", {"name": "?"}),
        ("selected_rows", []),
        ("changes", {}),
        ("confirmed", True),
        ("separate_release_keys", []),
    ),
)
def test_asgi_create_problem_ignores_rejects_tag_edit_payload(
    asgi_app, monkeypatch, extra_field, extra_value
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    row_key = "album::problem-album::missing-year"

    def fake_create(_config, payload, *, resolve_items):
        del resolve_items
        assert extra_field in payload
        raise ValueError("Problem exclusions do not accept tag-edit fields")

    monkeypatch.setattr(asgi_routes, "create_problem_exclusions", fake_create, raising=False)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/rules/problem-ignores",
        json_body={
            "items": [{
                "row_key": row_key,
                "scope": "album",
                "album_key": "album",
            }],
            extra_field: extra_value,
        },
    )

    assert status == 400
    assert _decode_json(body) == {
        "ok": False,
        "error": "Problem exclusions do not accept tag-edit fields",
    }


@pytest.mark.parametrize(
    "error",
    (
        "Problem exclusion scope does not match its identity",
        "Problem exclusion row is unknown or stale",
    ),
)
def test_asgi_create_problem_ignores_returns_400_for_invalid_or_stale_identity(
    asgi_app, monkeypatch, error
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    def fake_create(_config, _payload, *, resolve_items):
        del resolve_items
        raise ValueError(error)

    monkeypatch.setattr(asgi_routes, "create_problem_exclusions", fake_create, raising=False)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/rules/problem-ignores",
        json_body={
            "items": [{
                "row_key": "album::problem-album::missing-year",
                "scope": "album",
                "album_key": "album",
            }],
        },
    )

    assert status == 400
    assert _decode_json(body) == {"ok": False, "error": error}


def test_asgi_revert_problem_ignore_uses_targeted_delete_and_compact_ack(
    asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    row_key = "neal morse::?::problem-album::undecoded-characters"
    calls: list[tuple[object, object]] = []

    def fake_revert(config, raw_row_key):
        calls.append((config, raw_row_key))
        return row_key

    monkeypatch.setattr(asgi_routes, "revert_problem_exclusion", fake_revert, raising=False)
    monkeypatch.setattr(
        asgi_routes,
        "build_cached_utility_rules_payload",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("compact revert must not build cached Rules")
        ),
    )
    monkeypatch.setattr(
        asgi_routes,
        "PostgresLibraryBrowseRepository",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("compact revert must not build a broad projection")
        ),
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/rules/problem-ignores/revert",
        json_body={"row_key": row_key},
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload == {"ok": True, "reverted_row_key": row_key}
    assert "rules" not in payload
    assert "updated_albums" not in payload
    assert "updated_problematic_album" not in payload
    assert calls == [(asgi_app.state.config, row_key)]


def test_asgi_revert_version_exception_uses_selected_postgres_utility_rules_projection(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import ignored_versions as ignored_versions_module

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "ignored_versions": "postgres",
        "library_browse": "postgres",
    }
    ignored_json_path = Path(app.config["DATA_DIR"]) / "ignored_versions.json"
    ignored_json_path.write_text(
        json.dumps({"ignored_version_keys": ["file-era-stale"]}),
        encoding="utf-8",
    )

    class FakeRuleStatePsycopg:
        def connect(self):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeLibraryBrowsePsycopg:
        def connect(self):
            raise AssertionError("route tests should not open a real library-browse database connection")

    class FakeIgnoredVersionsAdapter:
        def __init__(self, _config):
            pass

        def load_ignored_version_keys(self):
            return {"postgres-existing", "postgres-remove"}

        def save_ignored_version_keys(self, values):
            saved_ignored_versions.append(set(values))

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://album_haven_app@localhost/app"

        def build_utility_rules_payload(self):
            return {
                "ok": True,
                "rules": [{"key": "version-exceptions", "count": 1, "albums": []}],
                "ignored_version_keys": ["postgres-existing"],
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

    def fail_cached_rules_payload(*_args, **_kwargs):
        raise AssertionError("revert response must not use the cached JSON-backed rules payload")

    saved_ignored_versions: list[set[str]] = []
    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", FakeLibraryBrowsePsycopg())
    monkeypatch.setattr(ignored_versions_module, "RuleStatePostgresAdapter", FakeIgnoredVersionsAdapter)
    monkeypatch.setattr(asgi_routes, "build_cached_utility_rules_payload", fail_cached_rules_payload)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository, raising=False)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/rules/version-exceptions/revert",
        json_body={"album_key": "postgres-remove"},
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["ok"] is True
    assert payload["ignored_version_keys"] == ["postgres-existing"]
    assert payload["view_data_source"] == "postgres_library_browse"
    assert payload["persistence_backend"] == "postgres"
    assert payload["persistence_seam"] == "library_browse"
    assert saved_ignored_versions == [{"postgres-existing"}]
    assert json.loads(ignored_json_path.read_text(encoding="utf-8")) == {
        "ignored_version_keys": ["file-era-stale"]
    }


def test_asgi_revert_version_exception_uses_selected_postgres_when_mutation_seam_defaults_to_postgres(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import ignored_versions as ignored_versions_module

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "ignored_versions": "postgres",
        "library_browse": "postgres",
    }
    ignored_json_path = Path(app.config["DATA_DIR"]) / "ignored_versions.json"
    ignored_json_path.write_text(
        json.dumps({"ignored_version_keys": ["file-era-stale"]}),
        encoding="utf-8",
    )
    ignored_versions = {"postgres-existing", "postgres-remove"}

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeLibraryBrowsePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real library-browse database connection")

    class FakeIgnoredVersionsAdapter:
        def __init__(self, _config):
            pass

        def load_ignored_version_keys(self):
            return set(ignored_versions)

        def save_ignored_version_keys(self, values):
            ignored_versions.clear()
            ignored_versions.update(str(value) for value in values)

    class FakePostgresBrowseRepository:
        def __init__(self, _config):
            pass

        def build_utility_rules_payload(self):
            return {
                "ok": True,
                "rules": [{"key": "version-exceptions", "count": 1, "albums": []}],
                "ignored_version_keys": sorted(ignored_versions),
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

    def fail_cached_rules_payload(*_args, **_kwargs):
        raise AssertionError("selected Postgres revert responses must not use cached JSON-backed rules payload")

    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", FakeLibraryBrowsePsycopg())
    monkeypatch.setattr(ignored_versions_module, "RuleStatePostgresAdapter", FakeIgnoredVersionsAdapter)
    monkeypatch.setattr(asgi_routes, "build_cached_utility_rules_payload", fail_cached_rules_payload)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository, raising=False)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/rules/version-exceptions/revert",
        json_body={"album_key": "postgres-remove"},
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["ok"] is True
    assert payload["ignored_version_keys"] == ["postgres-existing"]
    assert payload["view_data_source"] == "postgres_library_browse"
    assert payload["persistence_backend"] == "postgres"
    assert json.loads(ignored_json_path.read_text(encoding="utf-8")) == {
        "ignored_version_keys": ["file-era-stale"]
    }


def test_asgi_revert_problem_ignore_uses_selected_postgres_targeted_delete(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import ignored_repairs as ignored_repairs_module

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "ignored_repairs": "postgres",
        "library_browse": "postgres",
    }
    ignored_json_path = Path(app.config["DATA_DIR"]) / "ignored_repairs.json"
    ignored_json_path.write_text(
        json.dumps({"ignored_row_keys": ["file-era-stale::year"]}),
        encoding="utf-8",
    )

    class FakeRuleStatePsycopg:
        def connect(self):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeLibraryBrowsePsycopg:
        def connect(self):
            raise AssertionError("route tests should not open a real library-browse database connection")

    class FakeIgnoredRepairsAdapter:
        def __init__(self, _config):
            pass

        def delete_ignored_repair_keys(self, values):
            saved_ignored_repairs.append(set(values))

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://album_haven_app@localhost/app"

        def build_utility_rules_payload(self):
            raise AssertionError("compact revert must not build the Rules projection")

    def fail_cached_rules_payload(*_args, **_kwargs):
        raise AssertionError("revert response must not use the cached JSON-backed rules payload")

    saved_ignored_repairs: list[set[str]] = []
    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", FakeLibraryBrowsePsycopg())
    monkeypatch.setattr(ignored_repairs_module, "RuleStatePostgresAdapter", FakeIgnoredRepairsAdapter)
    monkeypatch.setattr(asgi_routes, "build_cached_utility_rules_payload", fail_cached_rules_payload)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository, raising=False)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/rules/problem-ignores/revert",
        json_body={"row_key": "postgres-remove::year"},
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload == {
        "ok": True,
        "reverted_row_key": "postgres-remove::year",
    }
    assert saved_ignored_repairs == [{"postgres-remove::year"}]
    assert json.loads(ignored_json_path.read_text(encoding="utf-8")) == {
        "ignored_row_keys": ["file-era-stale::year"]
    }


def test_asgi_revert_problem_ignore_uses_targeted_postgres_when_mutation_seam_defaults_to_postgres(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import ignored_repairs as ignored_repairs_module

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "ignored_repairs": "postgres",
        "library_browse": "postgres",
    }
    ignored_json_path = Path(app.config["DATA_DIR"]) / "ignored_repairs.json"
    ignored_json_path.write_text(
        json.dumps({"ignored_row_keys": ["file-era-stale::year"]}),
        encoding="utf-8",
    )
    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeLibraryBrowsePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real library-browse database connection")

    class FakeIgnoredRepairsAdapter:
        def __init__(self, _config):
            pass

        def delete_ignored_repair_keys(self, values):
            deleted_ignored_repairs.append(set(values))

    class FakePostgresBrowseRepository:
        def __init__(self, _config):
            pass

        def build_utility_rules_payload(self):
            raise AssertionError("compact revert must not build the Rules projection")

    def fail_cached_rules_payload(*_args, **_kwargs):
        raise AssertionError("selected Postgres revert responses must not use cached JSON-backed rules payload")

    deleted_ignored_repairs: list[set[str]] = []
    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", FakeLibraryBrowsePsycopg())
    monkeypatch.setattr(ignored_repairs_module, "RuleStatePostgresAdapter", FakeIgnoredRepairsAdapter)
    monkeypatch.setattr(asgi_routes, "build_cached_utility_rules_payload", fail_cached_rules_payload)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository, raising=False)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/rules/problem-ignores/revert",
        json_body={"row_key": "postgres-remove::year"},
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload == {
        "ok": True,
        "reverted_row_key": "postgres-remove::year",
    }
    assert deleted_ignored_repairs == [{"postgres-remove::year"}]
    assert json.loads(ignored_json_path.read_text(encoding="utf-8")) == {
        "ignored_row_keys": ["file-era-stale::year"]
    }


def test_asgi_repair_album_rejects_ignore_only_payload_instead_of_building_projections(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import ignored_repairs as ignored_repairs_module

    track_path = "C:/Music/Artist/Album/01 - Track.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "ignored_repairs": "postgres",
        "library_browse": "postgres",
    }
    ignored_json_path = Path(app.config["DATA_DIR"]) / "ignored_repairs.json"
    ignored_json_path.write_text(
        json.dumps({"ignored_row_keys": ["file-era-stale::year"]}),
        encoding="utf-8",
    )

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeLibraryBrowsePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real library-browse database connection")

    class FakeIgnoredRepairsAdapter:
        def __init__(self, _config):
            pass

        def load_ignored_repair_keys(self):
            return {"postgres-existing::album"}

        def save_ignored_repair_keys(self, values):
            saved_ignored_repairs.append(set(values))

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            repo_configs.append(config)

        def build_problematic_album_payload_by_track_paths(self, track_paths):
            seen_problematic_paths.append(set(track_paths))
            return {"key": "updated-problematic-album", "source": "postgres"}

        def build_album_payloads_by_track_paths(self, track_paths):
            seen_album_paths.append(set(track_paths))
            return [{"key": "updated-album", "source": "postgres"}]

    def fail_legacy_problematic(_track_paths):
        raise AssertionError("selected Postgres repair response must not use legacy problematic matcher")

    def fail_legacy_albums(_track_paths, *, library_state):
        assert library_state is asgi_app.state.library_state
        raise AssertionError("selected Postgres repair response must not use legacy album matcher")

    saved_ignored_repairs: list[set[str]] = []
    repo_configs: list[dict[str, object]] = []
    seen_problematic_paths: list[set[str]] = []
    seen_album_paths: list[set[str]] = []
    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", FakeLibraryBrowsePsycopg())
    monkeypatch.setattr(ignored_repairs_module, "RuleStatePostgresAdapter", FakeIgnoredRepairsAdapter)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository, raising=False)
    monkeypatch.setattr(asgi_routes, "_find_problematic_album_by_track_paths", fail_legacy_problematic)
    monkeypatch.setattr(asgi_routes, "_find_albums_by_track_paths", fail_legacy_albums)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/repair-album",
        json_body={
            "confirmed": True,
            "album": {"tracks": [{"path": track_path}]},
            "selected_rows": [],
            "ignored_row_keys": [f"{track_path}::year"],
        },
    )

    payload = _decode_json(body)
    assert status == 400
    assert payload["ok"] is False
    assert "exclusion" in str(payload.get("error") or "").casefold()
    assert saved_ignored_repairs == []
    assert seen_problematic_paths == []
    assert seen_album_paths == []
    assert repo_configs == []
    assert json.loads(ignored_json_path.read_text(encoding="utf-8")) == {
        "ignored_row_keys": ["file-era-stale::year"]
    }


def test_asgi_repair_album_separate_only_uses_selected_postgres_embedded_payloads_when_split_is_available(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import separate_releases as separate_releases_module

    track_path = "C:/Music/Artist/Album/02 - Track.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "library_browse": "postgres",
        "separate_releases": "postgres",
    }
    separate_json_path = Path(app.config["DATA_DIR"]) / "separate_releases.json"
    separate_json_path.write_text(
        json.dumps({"separate_release_keys": ["file-era-stale"]}),
        encoding="utf-8",
    )

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeSeparateReleasesAdapter:
        def __init__(self, _config):
            pass

        def load_separate_release_keys(self):
            return {"postgres-existing"}

        def save_separate_release_keys(self, values):
            saved_separate_releases.append(set(values))

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            repo_configs.append(config)

        def build_problematic_album_payload_by_track_paths(self, track_paths):
            seen_problematic_paths.append(set(track_paths))
            return {"key": "updated-problematic-album", "source": "postgres"}

        def build_album_payloads_by_track_paths(self, track_paths):
            seen_album_paths.append(set(track_paths))
            return [{"key": "updated-album", "source": "postgres"}]

    def fail_legacy_problematic(_track_paths):
        raise AssertionError("selected Postgres separate-only repair response must not use legacy problematic matcher")

    def fail_legacy_albums(_track_paths, *, library_state):
        assert library_state is asgi_app.state.library_state
        raise AssertionError("selected Postgres separate-only repair response must not use legacy album matcher")

    saved_separate_releases: list[set[str]] = []
    repo_configs: list[dict[str, object]] = []
    seen_problematic_paths: list[set[str]] = []
    seen_album_paths: list[set[str]] = []
    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr(separate_releases_module, "RuleStatePostgresAdapter", FakeSeparateReleasesAdapter)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository, raising=False)
    monkeypatch.setattr(asgi_routes, "_find_problematic_album_by_track_paths", fail_legacy_problematic)
    monkeypatch.setattr(asgi_routes, "_find_albums_by_track_paths", fail_legacy_albums)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/repair-album",
        json_body={
            "confirmed": True,
            "album": {"tracks": [{"path": track_path}]},
            "selected_rows": [],
            "separate_release_keys": ["postgres-release"],
        },
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["ok"] is True
    assert payload["changed_files"] == []
    assert payload["skipped_files"] == []
    assert payload["changed_count"] == 0
    assert payload["updated_problematic_album"] == {
        "key": "updated-problematic-album",
        "source": "postgres",
    }
    assert payload["updated_albums"] == [{"key": "updated-album", "source": "postgres"}]
    assert payload["requires_view_refresh"] is True
    assert saved_separate_releases == [{"postgres-existing", "postgres-release"}]
    assert seen_problematic_paths == [{track_path}]
    assert seen_album_paths == [{track_path}]
    assert len(repo_configs) == 1
    assert json.loads(separate_json_path.read_text(encoding="utf-8")) == {
        "separate_release_keys": ["file-era-stale"]
    }


def test_asgi_repair_album_rejects_mixed_ignored_and_separate_payload(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import ignored_repairs as ignored_repairs_module
    from music_app.services import separate_releases as separate_releases_module

    track_path = "C:/Music/Artist/Album/02 - Mixed.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "ignored_repairs": "postgres",
        "library_browse": "postgres",
        "separate_releases": "postgres",
    }

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeIgnoredRepairsAdapter:
        def __init__(self, _config):
            pass

        def load_ignored_repair_keys(self):
            return set()

        def save_ignored_repair_keys(self, values):
            saved_ignored_repairs.append(set(values))

    class FakeSeparateReleasesAdapter:
        def __init__(self, _config):
            pass

        def load_separate_release_keys(self):
            return set()

        def save_separate_release_keys(self, values):
            saved_separate_releases.append(set(values))

    class FakePostgresBrowseRepository:
        def __init__(self, _config):
            repo_created.append(True)

        def build_problematic_album_payload_by_track_paths(self, track_paths):
            seen_problematic_paths.append(set(track_paths))
            return {"key": "updated-problematic-album", "source": "postgres"}

        def build_album_payloads_by_track_paths(self, track_paths):
            seen_album_paths.append(set(track_paths))
            return [{"key": "updated-album", "source": "postgres"}]

    def fail_legacy_problematic(_track_paths):
        raise AssertionError("fully selected mixed repair response must not use legacy problematic matcher")

    def fail_legacy_albums(_track_paths, *, library_state):
        assert library_state is asgi_app.state.library_state
        raise AssertionError("fully selected mixed repair response must not use legacy album matcher")

    saved_ignored_repairs: list[set[str]] = []
    saved_separate_releases: list[set[str]] = []
    repo_created: list[bool] = []
    seen_problematic_paths: list[set[str]] = []
    seen_album_paths: list[set[str]] = []
    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr(ignored_repairs_module, "RuleStatePostgresAdapter", FakeIgnoredRepairsAdapter)
    monkeypatch.setattr(separate_releases_module, "RuleStatePostgresAdapter", FakeSeparateReleasesAdapter)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository, raising=False)
    monkeypatch.setattr(asgi_routes, "_find_problematic_album_by_track_paths", fail_legacy_problematic)
    monkeypatch.setattr(asgi_routes, "_find_albums_by_track_paths", fail_legacy_albums)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/repair-album",
        json_body={
            "confirmed": True,
            "album": {"tracks": [{"path": track_path}]},
            "selected_rows": [],
            "ignored_row_keys": [f"{track_path}::year"],
            "separate_release_keys": ["postgres-release"],
        },
    )

    payload = _decode_json(body)
    assert status == 400
    assert payload["ok"] is False
    assert "exclusion" in str(payload.get("error") or "").casefold()
    assert saved_ignored_repairs == []
    assert saved_separate_releases == []
    assert seen_problematic_paths == []
    assert seen_album_paths == []
    assert repo_created == []


def test_asgi_repair_album_rejects_mixed_ignored_and_separate_with_selected_postgres_seams(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import ignored_repairs as ignored_repairs_module
    from music_app.services import separate_releases as separate_releases_module

    track_path = "C:/Music/Artist/Album/02 - Mixed Selected Seams.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "ignored_repairs": "postgres",
        "library_browse": "postgres",
        "separate_releases": "postgres",
    }
    separate_json_path = Path(app.config["DATA_DIR"]) / "separate_releases.json"
    separate_json_path.write_text(
        json.dumps({"separate_release_keys": ["file-existing-release"]}),
        encoding="utf-8",
    )

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeIgnoredRepairsAdapter:
        def __init__(self, _config):
            pass

        def load_ignored_repair_keys(self):
            return {"postgres-existing::year"}

        def save_ignored_repair_keys(self, values):
            saved_ignored_repairs.append(set(values))

    class FakeSeparateReleasesAdapter:
        def __init__(self, _config):
            pass

        def load_separate_release_keys(self):
            return {"postgres-existing-release"}

        def save_separate_release_keys(self, values):
            saved_separate_releases.append(set(values))

    class FakePostgresBrowseRepository:
        def __init__(self, _config):
            repo_created.append(True)

        def build_problematic_album_payload_by_track_paths(self, track_paths):
            seen_problematic_paths.append(set(track_paths))
            return {"key": "postgres-problematic-album", "source": "postgres"}

        def build_album_payloads_by_track_paths(self, track_paths):
            seen_album_paths.append(set(track_paths))
            return [{"key": "postgres-album", "source": "postgres"}]

    def fail_legacy_problematic(_track_paths):
        raise AssertionError("selected Postgres mixed repair response must not use legacy problematic matcher")

    def fail_legacy_albums(_track_paths, *, library_state):
        assert library_state is asgi_app.state.library_state
        raise AssertionError("selected Postgres mixed repair response must not use legacy album matcher")

    saved_ignored_repairs: list[set[str]] = []
    saved_separate_releases: list[set[str]] = []
    repo_created: list[bool] = []
    seen_problematic_paths: list[set[str]] = []
    seen_album_paths: list[set[str]] = []
    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr(ignored_repairs_module, "RuleStatePostgresAdapter", FakeIgnoredRepairsAdapter)
    monkeypatch.setattr(separate_releases_module, "RuleStatePostgresAdapter", FakeSeparateReleasesAdapter)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository, raising=False)
    monkeypatch.setattr(asgi_routes, "_find_problematic_album_by_track_paths", fail_legacy_problematic)
    monkeypatch.setattr(asgi_routes, "_find_albums_by_track_paths", fail_legacy_albums)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/repair-album",
        json_body={
            "confirmed": True,
            "album": {"tracks": [{"path": track_path}]},
            "selected_rows": [],
            "ignored_row_keys": [f"{track_path}::year"],
            "separate_release_keys": ["postgres-new-release"],
        },
    )

    payload = _decode_json(body)
    assert status == 400
    assert payload["ok"] is False
    assert "exclusion" in str(payload.get("error") or "").casefold()
    assert saved_ignored_repairs == []
    assert saved_separate_releases == []
    assert seen_problematic_paths == []
    assert seen_album_paths == []
    assert repo_created == []
    assert json.loads(separate_json_path.read_text(encoding="utf-8")) == {
        "separate_release_keys": ["file-existing-release"]
    }


def test_asgi_repair_album_rejects_ignored_payload_when_mutation_seam_is_selected(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import ignored_repairs as ignored_repairs_module

    track_path = "C:/Music/Artist/Album/03 - Track.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "ignored_repairs": "postgres",
        "library_browse": "postgres",
    }
    ignored_json_path = Path(app.config["DATA_DIR"]) / "ignored_repairs.json"
    ignored_json_path.write_text(
        json.dumps({"ignored_row_keys": ["file-existing::album"]}),
        encoding="utf-8",
    )

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeIgnoredRepairsAdapter:
        def __init__(self, _config):
            pass

        def load_ignored_repair_keys(self):
            return {"postgres-existing::album"}

        def save_ignored_repair_keys(self, values):
            saved_ignored_repairs.append(set(values))

    class FakePostgresBrowseRepository:
        def __init__(self, _config):
            repo_created.append(True)

        def build_problematic_album_payload_by_track_paths(self, track_paths):
            seen_problematic_paths.append(set(track_paths))
            return {"key": "postgres-problematic-album", "source": "postgres"}

        def build_album_payloads_by_track_paths(self, track_paths):
            seen_album_paths.append(set(track_paths))
            return [{"key": "postgres-album", "source": "postgres"}]

    def fail_legacy_problematic(_track_paths):
        raise AssertionError("selected Postgres repair response must not use legacy problematic matcher")

    def fail_legacy_albums(_track_paths, *, library_state):
        assert library_state is asgi_app.state.library_state
        raise AssertionError("selected Postgres repair response must not use legacy album matcher")

    saved_ignored_repairs: list[set[str]] = []
    repo_created: list[bool] = []
    seen_problematic_paths: list[set[str]] = []
    seen_album_paths: list[set[str]] = []
    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr(ignored_repairs_module, "RuleStatePostgresAdapter", FakeIgnoredRepairsAdapter)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository, raising=False)
    monkeypatch.setattr(asgi_routes, "_find_problematic_album_by_track_paths", fail_legacy_problematic)
    monkeypatch.setattr(asgi_routes, "_find_albums_by_track_paths", fail_legacy_albums)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/repair-album",
        json_body={
            "confirmed": True,
            "album": {"tracks": [{"path": track_path}]},
            "selected_rows": [],
            "ignored_row_keys": [f"{track_path}::year"],
        },
    )

    payload = _decode_json(body)
    assert status == 400
    assert payload["ok"] is False
    assert "exclusion" in str(payload.get("error") or "").casefold()
    assert saved_ignored_repairs == []
    assert seen_problematic_paths == []
    assert seen_album_paths == []
    assert repo_created == []
    assert json.loads(ignored_json_path.read_text(encoding="utf-8")) == {
        "ignored_row_keys": ["file-existing::album"]
    }


def test_asgi_repair_album_selected_rows_require_refresh_without_legacy_fragments_with_postgres_browse(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    track_path = "C:/Music/Artist/Album/04 - Selected Repair.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "ignored_repairs": "postgres",
        "library_browse": "postgres",
        "separate_releases": "postgres",
    }
    app.library_state["file_cache"] = {
        track_path: {
            "path": track_path,
            "title": "Mojibake Title",
            "album": "Album",
            "album_artist": "Artist",
        }
    }
    app.library_state["relation_views"] = {"alias_to_canonical": {}}
    app.library_state["separate_release_keys"] = set()

    class FailingPostgresBrowseRepository:
        def __init__(self, _config):
            raise AssertionError("selected-row repairs must not instantiate Postgres projection")

    applied_repairs: list[tuple[str, dict[str, str]]] = []
    ignored_saves: list[set[str]] = []
    separate_saves: list[set[str]] = []
    queued_tasks: list[dict[str, object]] = []

    def fake_build_text_repairs(entry):
        assert entry["path"] == track_path
        return {"title": "Fixed Title"}

    def fake_apply_repairs_worker(path, repairs):
        applied_repairs.append((path, dict(repairs)))
        return path, True, ["title"]

    def fake_update_cache_entry_after_repairs(path, entry, repairs):
        updated = dict(entry)
        updated.update(repairs)
        updated["path"] = str(path)
        return updated

    def fail_legacy_album_builder(*_args, **_kwargs):
        raise AssertionError(
            "selected Postgres media-write repair responses must not use legacy file-cache album fragments"
        )

    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FailingPostgresBrowseRepository, raising=False)
    monkeypatch.setattr(asgi_routes, "build_text_repairs_for_entry", fake_build_text_repairs)
    monkeypatch.setattr(asgi_routes, "_build_artist_alias_repairs_for_entry", lambda _entry, _aliases: {})
    monkeypatch.setattr(asgi_routes, "_build_disc_marker_repairs_for_entry", lambda _entry: {})
    monkeypatch.setattr(asgi_routes, "_apply_repairs_worker", fake_apply_repairs_worker)
    monkeypatch.setattr(asgi_routes, "_update_cache_entry_after_repairs", fake_update_cache_entry_after_repairs)
    monkeypatch.setattr(asgi_routes, "_build_affected_album_dicts", fail_legacy_album_builder)
    monkeypatch.setattr(asgi_routes, "load_ignored_repair_keys", lambda _config: {"existing::year"})
    monkeypatch.setattr(asgi_routes, "save_ignored_repair_keys", lambda _config, values: ignored_saves.append(set(values)))
    monkeypatch.setattr(asgi_routes, "load_separate_release_keys", lambda _config: {"existing-release"})
    monkeypatch.setattr(asgi_routes, "save_separate_release_keys", lambda _config, values: separate_saves.append(set(values)))
    monkeypatch.setattr(asgi_routes, "append_log_history", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "create_save_task", lambda task_type: f"task-{task_type}")
    monkeypatch.setattr(
        asgi_routes,
        "_bridge_queue_finalize_save_task",
        lambda **kwargs: queued_tasks.append(dict(kwargs)),
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/repair-album",
        json_body={
            "confirmed": True,
            "album": {"name": "Album", "album_artist": "Artist", "tracks": [{"path": track_path}]},
            "selected_rows": [f"{track_path}::title"],
            "separate_release_keys": ["selected-row-release"],
        },
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["changed_files"] == [{"path": track_path, "fields": ["title"]}]
    assert payload["updated_album"] is None
    assert payload["updated_albums"] == []
    assert payload["updated_problematic_album"] is None
    assert payload["requires_view_refresh"] is True
    assert payload["save_task_id"] == "task-repair-tags"
    assert applied_repairs == [(track_path, {"title": "Fixed Title"})]
    assert ignored_saves == []
    assert separate_saves == [{"existing-release", "selected-row-release"}]
    assert queued_tasks and queued_tasks[0]["updated_file_cache"][track_path]["title"] == "Fixed Title"


def test_asgi_repair_album_selected_postgres_save_task_completion_requires_refresh_without_legacy_fragments(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services.save_tasks import update_save_task

    track_path = "C:/Music/Artist/Album/04 - Selected Repair Save Task.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "ignored_repairs": "postgres",
        "library_browse": "postgres",
        "separate_releases": "postgres",
    }
    app.library_state["file_cache"] = {
        track_path: {
            "path": track_path,
            "title": "Mojibake Title",
            "album": "Album",
            "album_artist": "Artist",
        }
    }
    app.library_state["relation_views"] = {"alias_to_canonical": {}}
    app.library_state["separate_release_keys"] = set()

    class FailingPostgresBrowseRepository:
        def __init__(self, _config):
            raise AssertionError("selected media-write repair save tasks must not instantiate Postgres fragments")

    def fake_build_text_repairs(entry):
        assert entry["path"] == track_path
        return {"title": "Fixed Title"}

    def fake_apply_repairs_worker(path, repairs):
        return path, True, ["title"]

    def fake_update_cache_entry_after_repairs(path, entry, repairs):
        updated = dict(entry)
        updated.update(repairs)
        updated["path"] = str(path)
        return updated

    def fake_find_albums_by_track_paths(_paths, *, library_state):
        assert library_state is asgi_app.state.library_state
        return [{"key": "legacy-save-task"}]

    def immediate_queue_finalize_save_task(**kwargs):
        track_paths = set(kwargs["requested_track_paths"])
        update_save_task(
            kwargs["task_id"],
            status="completed",
            updated_albums=kwargs["find_albums_by_track_paths"](track_paths),
            updated_problematic_album=kwargs["find_problematic_album_by_track_paths"](track_paths),
            requires_view_refresh=bool(
                set(kwargs["changed_field_names"]) & set(kwargs["structural_edit_fields"])
            ),
        )

    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FailingPostgresBrowseRepository, raising=False)
    monkeypatch.setattr(asgi_routes, "build_text_repairs_for_entry", fake_build_text_repairs)
    monkeypatch.setattr(asgi_routes, "_build_artist_alias_repairs_for_entry", lambda _entry, _aliases: {})
    monkeypatch.setattr(asgi_routes, "_build_disc_marker_repairs_for_entry", lambda _entry: {})
    monkeypatch.setattr(asgi_routes, "_apply_repairs_worker", fake_apply_repairs_worker)
    monkeypatch.setattr(asgi_routes, "_update_cache_entry_after_repairs", fake_update_cache_entry_after_repairs)
    monkeypatch.setattr(asgi_routes, "_build_affected_album_dicts", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(asgi_routes, "_find_albums_by_track_paths", fake_find_albums_by_track_paths)
    monkeypatch.setattr(
        asgi_routes,
        "_find_problematic_album_by_track_paths",
        lambda _paths: {"key": "legacy-problematic-save-task"},
    )
    monkeypatch.setattr(asgi_routes, "load_ignored_repair_keys", lambda _config: set())
    monkeypatch.setattr(asgi_routes, "save_ignored_repair_keys", lambda _config, _values: None)
    monkeypatch.setattr(asgi_routes, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(asgi_routes, "save_separate_release_keys", lambda _config, _values: None)
    monkeypatch.setattr(asgi_routes, "append_log_history", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "create_save_task", lambda _task_type: "task-repair-tags-postgres-media")
    monkeypatch.setattr(asgi_routes, "queue_finalize_save_task", immediate_queue_finalize_save_task)

    edit_status, _edit_headers, edit_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/repair-album",
        json_body={
            "confirmed": True,
            "album": {"name": "Album", "album_artist": "Artist", "tracks": [{"path": track_path}]},
            "selected_rows": [f"{track_path}::title"],
        },
    )
    save_status, _save_headers, save_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/save-task/task-repair-tags-postgres-media",
    )

    edit_payload = _decode_json(edit_body)
    save_payload = _decode_json(save_body)
    assert edit_status == 200
    assert edit_payload["save_task_id"] == "task-repair-tags-postgres-media"
    assert edit_payload["updated_albums"] == []
    assert edit_payload["requires_view_refresh"] is True
    assert save_status == 200
    assert save_payload["ok"] is True
    assert save_payload["updated_albums"] == []
    assert save_payload["updated_problematic_album"] is None
    assert save_payload["requires_view_refresh"] is True


def test_asgi_edit_tags_exception_only_uses_selected_postgres_album_fragments(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import exception_overrides as exception_overrides_module

    track_path = "C:/Music/Artist/Album/01 - Exception Only.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "exception_overrides": "postgres",
        "library_browse": "postgres",
    }
    app.library_state["file_cache"] = {
        track_path: {
            "path": track_path,
            "title": "Exception Only",
            "album": "Album",
            "album_artist": "Artist",
            "exception_type": "",
        }
    }
    stale_overrides_path = Path(app.config["DATA_DIR"]) / "exception_overrides.json"
    stale_overrides_path.write_text(
        json.dumps({"items": {"C:/file-only.flac": "Interview"}}),
        encoding="utf-8",
    )

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeLibraryBrowsePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real library-browse database connection")

    class FakeExceptionOverridesAdapter:
        def __init__(self, _config):
            pass

        def load_exception_overrides(self):
            return {"C:/postgres-existing.flac": "Single"}

        def upsert_exception_overrides(self, values):
            saved_overrides.append(dict(values))

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            repo_configs.append(config)

        def build_track_file_entries_by_paths(self, track_paths):
            return {
                track_path: {
                    "path": track_path,
                    "title": "Exception Only",
                    "album": "Album",
                    "album_artist": "Artist",
                    "exception_type": "",
                }
            }

        def build_album_payloads_by_track_paths(self, track_paths):
            seen_album_paths.append(set(track_paths))
            return [{"key": "postgres-updated-album", "source": "postgres"}]

    def fail_media_worker(*_args, **_kwargs):
        raise AssertionError("exception-only edits should not write media tags")

    def fail_legacy_album_builder(*_args, **_kwargs):
        raise AssertionError("selected Postgres exception-only edit-tags must not use legacy album fragments")

    saved_overrides: list[dict[str, str]] = []
    repo_configs: list[dict[str, object]] = []
    seen_album_paths: list[set[str]] = []
    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", FakeLibraryBrowsePsycopg())
    monkeypatch.setattr(exception_overrides_module, "RuleStatePostgresAdapter", FakeExceptionOverridesAdapter)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository, raising=False)
    monkeypatch.setattr(asgi_routes, "_apply_repairs_worker", fail_media_worker)
    monkeypatch.setattr(asgi_routes, "_build_affected_album_dicts", fail_legacy_album_builder)
    monkeypatch.setattr(asgi_routes, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(asgi_routes, "append_log_history", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "create_save_task", lambda task_type: f"task-{task_type}")
    monkeypatch.setattr(asgi_routes, "_bridge_queue_finalize_save_task", _complete_mocked_edit_tags_save_task)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={
            "confirmed": True,
            "album": {"name": "Album", "album_artist": "Artist", "tracks": [{"path": track_path}]},
            "updates": {track_path: {"exception_type": "Non-album rarity"}},
        },
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["ok"] is True
    assert payload["changed_files"] == [{"path": track_path, "fields": ["exception_type"]}]
    assert payload["updated_album"] == {"key": "postgres-updated-album", "source": "postgres"}
    assert payload["updated_albums"] == [{"key": "postgres-updated-album", "source": "postgres"}]
    assert payload["requires_view_refresh"] is True
    assert saved_overrides == [
        {
            track_path: "Non-album rarity",
        }
    ]
    assert seen_album_paths == [{track_path}]
    assert len(repo_configs) == 2
    assert json.loads(stale_overrides_path.read_text(encoding="utf-8")) == {
        "items": {"C:/file-only.flac": "Interview"}
    }


def test_asgi_edit_tags_exception_only_uses_selected_postgres_inventory_when_runtime_cache_is_empty(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import exception_overrides as exception_overrides_module

    track_path = "C:/Music/Artist/Album/01 - Persisted Inventory.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "exception_overrides": "postgres",
        "library_browse": "postgres",
    }
    app.library_state["file_cache"] = {}

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeLibraryBrowsePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real library-browse database connection")

    class FakeExceptionOverridesAdapter:
        def __init__(self, _config):
            pass

        def load_exception_overrides(self):
            return {}

        def upsert_exception_overrides(self, values):
            saved_overrides.append(dict(values))

    class FakePostgresBrowseRepository:
        def __init__(self, _config):
            pass

        def build_track_file_entries_by_paths(self, track_paths):
            selected_inventory_paths.append(set(track_paths))
            return {
                track_path: {
                    "path": track_path,
                    "title": "Persisted Inventory",
                    "album": "Album",
                    "album_artist": "Artist",
                    "exception_type": "",
                }
            }

        def build_album_payloads_by_track_paths(self, track_paths):
            selected_inventory_paths.append(set(track_paths))
            return [
                {
                    "key": "artist-album",
                    "tracks": [
                        {
                            "path": track_path,
                            "title": "Persisted Inventory",
                            "album": "Album",
                            "album_artist": "Artist",
                        }
                    ],
                    "source": "postgres",
                }
            ]

    saved_overrides: list[dict[str, str]] = []
    selected_inventory_paths: list[set[str]] = []
    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", FakeLibraryBrowsePsycopg())
    monkeypatch.setattr(exception_overrides_module, "RuleStatePostgresAdapter", FakeExceptionOverridesAdapter)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository, raising=False)
    monkeypatch.setattr(
        asgi_routes,
        "_apply_repairs_worker",
        lambda *_args, **_kwargs: pytest.fail("exception-only edits should not write media tags"),
    )
    monkeypatch.setattr(asgi_routes, "_build_affected_album_dicts", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(asgi_routes, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(asgi_routes, "append_log_history", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "create_save_task", lambda task_type: f"task-{task_type}")
    monkeypatch.setattr(asgi_routes, "_bridge_queue_finalize_save_task", _complete_mocked_edit_tags_save_task)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={
            "confirmed": True,
            "album": {"tracks": [{"path": track_path}]},
            "updates": {track_path: {"exception_type": "Non-album rarity"}},
        },
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["ok"] is True
    assert payload["changed_count"] == 1
    assert payload["changed_files"] == [{"path": track_path, "fields": ["exception_type"]}]
    assert payload["skipped_files"] == []
    assert payload["requires_view_refresh"] is True
    assert payload["save_task_id"] == "task-edit-tags"
    assert saved_overrides == [{track_path: "Non-album rarity"}]
    assert selected_inventory_paths
    assert all(paths == {track_path} for paths in selected_inventory_paths)
    assert app.library_state["file_cache"] == {}


def test_asgi_edit_tags_exception_only_uses_selected_postgres_fragments_when_exception_seam_is_selected(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import exception_overrides as exception_overrides_module

    track_path = "C:/Music/Artist/Album/02 - Selected Exception Seam.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "exception_overrides": "postgres",
        "library_browse": "postgres",
    }
    app.library_state["file_cache"] = {
        track_path: {
            "path": track_path,
            "title": "File Exception Seam",
            "album": "Album",
            "album_artist": "Artist",
            "exception_type": "",
        }
    }
    stale_overrides_path = Path(app.config["DATA_DIR"]) / "exception_overrides.json"
    stale_overrides_path.write_text(json.dumps({"items": {}}), encoding="utf-8")

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeLibraryBrowsePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real library-browse database connection")

    class FakeExceptionOverridesAdapter:
        def __init__(self, _config):
            pass

        def load_exception_overrides(self):
            return {}

        def upsert_exception_overrides(self, values):
            saved_overrides.append(dict(values))

    class FakePostgresBrowseRepository:
        def __init__(self, _config):
            repo_created.append(True)

        def build_track_file_entries_by_paths(self, track_paths):
            return {
                track_path: {
                    "path": track_path,
                    "title": "File Exception Seam",
                    "album": "Album",
                    "album_artist": "Artist",
                    "exception_type": "",
                }
            }

        def build_album_payloads_by_track_paths(self, track_paths):
            seen_album_paths.append(set(track_paths))
            return [{"key": "postgres-updated-album", "source": "postgres"}]

    def fail_legacy_album_builder(*_args, **_kwargs):
        raise AssertionError("selected Postgres exception edit-tags must not use legacy file-cache fragments")

    saved_overrides: list[dict[str, str]] = []
    repo_created: list[bool] = []
    seen_album_paths: list[set[str]] = []
    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", FakeLibraryBrowsePsycopg())
    monkeypatch.setattr(exception_overrides_module, "RuleStatePostgresAdapter", FakeExceptionOverridesAdapter)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository, raising=False)
    monkeypatch.setattr(asgi_routes, "_apply_repairs_worker", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("exception-only edits should not write media tags")))
    monkeypatch.setattr(asgi_routes, "_build_affected_album_dicts", fail_legacy_album_builder)
    monkeypatch.setattr(asgi_routes, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(asgi_routes, "append_log_history", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "create_save_task", lambda task_type: f"task-{task_type}")
    monkeypatch.setattr(asgi_routes, "_bridge_queue_finalize_save_task", _complete_mocked_edit_tags_save_task)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={
            "confirmed": True,
            "album": {"tracks": [{"path": track_path}]},
            "updates": {track_path: {"exception_type": "Single-only track"}},
        },
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["updated_albums"] == [{"key": "postgres-updated-album", "source": "postgres"}]
    assert saved_overrides == [{track_path: "Single-only track"}]
    assert seen_album_paths == [{track_path}]
    assert repo_created == [True, True]
    assert json.loads(stale_overrides_path.read_text(encoding="utf-8")) == {
        "items": {}
    }


def test_asgi_edit_tags_mixed_media_write_requires_refresh_without_legacy_fragments(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import exception_overrides as exception_overrides_module

    track_path = "C:/Music/Artist/Album/03 - Mixed Edit.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "exception_overrides": "postgres",
        "library_browse": "postgres",
    }
    app.library_state["file_cache"] = {
        track_path: {
            "path": track_path,
            "title": "Old Title",
            "album": "Album",
            "album_artist": "Artist",
            "exception_type": "",
        }
    }

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeLibraryBrowsePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real library-browse database connection")

    class FakeExceptionOverridesAdapter:
        def __init__(self, _config):
            pass

        def load_exception_overrides(self):
            return {}

        def upsert_exception_overrides(self, values):
            saved_overrides.append(dict(values))

    class FailingPostgresBrowseRepository:
        def __init__(self, _config):
            raise AssertionError("mixed media-write edit-tags must not instantiate Postgres projection")

    def fake_media_worker(path, repairs):
        media_jobs.append((path, dict(repairs)))
        return path, True, ["title"]

    def fake_update_cache_entry_after_repairs(path, entry, repairs):
        updated = dict(entry)
        updated.update(repairs)
        updated["path"] = str(path)
        return updated

    def fail_legacy_album_builder(*_args, **_kwargs):
        raise AssertionError(
            "selected Postgres media-write edit-tags responses must not use legacy file-cache album fragments"
        )

    saved_overrides: list[dict[str, str]] = []
    media_jobs: list[tuple[str, dict[str, str]]] = []
    queued_tasks: list[dict[str, object]] = []

    def capture_completed_save_task(**kwargs):
        from music_app.services.save_tasks import update_save_task

        queued_tasks.append(dict(kwargs))
        if kwargs.get("exception_updates"):
            asgi_routes.set_track_exception_overrides(
                kwargs["config"],
                dict(kwargs["exception_updates"]),
            )
        update_save_task(kwargs["task_id"], status="completed")
        kwargs["structural_tag_edit_reservation"].release()

    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", FakeLibraryBrowsePsycopg())
    monkeypatch.setattr(exception_overrides_module, "RuleStatePostgresAdapter", FakeExceptionOverridesAdapter)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FailingPostgresBrowseRepository, raising=False)
    monkeypatch.setattr(asgi_routes, "_apply_repairs_worker", fake_media_worker)
    monkeypatch.setattr(asgi_routes, "_update_cache_entry_after_repairs", fake_update_cache_entry_after_repairs)
    monkeypatch.setattr(asgi_routes, "_build_affected_album_dicts", fail_legacy_album_builder)
    monkeypatch.setattr(asgi_routes, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(asgi_routes, "append_log_history", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "create_save_task", lambda task_type: f"task-{task_type}")
    monkeypatch.setattr(
        asgi_routes,
        "_bridge_queue_finalize_save_task",
        capture_completed_save_task,
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={
            "confirmed": True,
            "album": {"tracks": [{"path": track_path}]},
            "updates": {
                track_path: {
                    "exception_type": "Non-album rarity",
                    "title": "New Title",
                }
            },
        },
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["updated_album"] is None
    assert payload["updated_albums"] == []
    assert payload["requires_view_refresh"] is True
    assert payload["save_task_id"] == "task-edit-tags"
    assert media_jobs == [(track_path, {"title": "New Title"})]
    assert saved_overrides == [{track_path: "Non-album rarity"}]
    assert queued_tasks
    assert queued_tasks[0]["find_albums_by_track_paths"]({track_path}) == []
    assert queued_tasks[0]["find_problematic_album_by_track_paths"]({track_path}) is None
    assert "title" in queued_tasks[0]["structural_edit_fields"]


def test_asgi_edit_tags_selected_postgres_targeted_inventory_save_task_completion_requires_refresh_without_legacy_fragments(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services.save_tasks import update_save_task

    track_path = "C:/Music/Artist/Album/03 - Media Save Task.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    app.library_state["file_cache"] = {
        track_path: {
            "path": track_path,
            "title": "Old Title",
            "album": "Album",
            "album_artist": "Artist",
            "exception_type": "",
        }
    }

    class FailingPostgresBrowseRepository:
        def __init__(self, _config):
            raise AssertionError("selected media-write edit-tags save tasks must not instantiate Postgres fragments")

    def fake_media_worker(path, repairs):
        return path, True, ["title"]

    def fake_update_cache_entry_after_repairs(path, entry, repairs):
        updated = dict(entry)
        updated.update(repairs)
        updated["path"] = str(path)
        return updated

    def fake_find_albums_by_track_paths(_paths, *, library_state):
        assert library_state is asgi_app.state.library_state
        return [{"key": "legacy-save-task"}]

    def immediate_queue_finalize_save_task(**kwargs):
        try:
            update_save_task(
                kwargs["task_id"],
                status="completed",
                updated_albums=[],
                updated_problematic_album=None,
                requires_view_refresh=True,
            )
        finally:
            kwargs["structural_tag_edit_reservation"].release()

    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FailingPostgresBrowseRepository, raising=False)
    monkeypatch.setattr(asgi_routes, "_apply_repairs_worker", fake_media_worker)
    monkeypatch.setattr(asgi_routes, "_update_cache_entry_after_repairs", fake_update_cache_entry_after_repairs)
    monkeypatch.setattr(asgi_routes, "_build_affected_album_dicts", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(asgi_routes, "_find_albums_by_track_paths", fake_find_albums_by_track_paths)
    monkeypatch.setattr(
        asgi_routes,
        "_find_problematic_album_by_track_paths",
        lambda _paths: {"key": "legacy-problematic-save-task"},
    )
    monkeypatch.setattr(asgi_routes, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(asgi_routes, "append_log_history", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "create_save_task", lambda _task_type: "task-edit-tags-postgres-media")
    monkeypatch.setattr(asgi_routes, "queue_finalize_save_task", immediate_queue_finalize_save_task)
    monkeypatch.setattr(
        asgi_routes,
        "_asgi_selected_postgres_structural_tag_edit_queue_finalize_save_task_builder",
        lambda _request: immediate_queue_finalize_save_task,
    )

    edit_status, _edit_headers, edit_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={
            "confirmed": True,
            "album": {"tracks": [{"path": track_path}]},
            "updates": {track_path: {"title": "New Title"}},
        },
    )
    save_status, _save_headers, save_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/save-task/task-edit-tags-postgres-media",
    )

    edit_payload = _decode_json(edit_body)
    save_payload = _decode_json(save_body)
    assert edit_status == 200
    assert edit_payload["save_task_id"] == "task-edit-tags-postgres-media"
    assert edit_payload["updated_albums"] == []
    assert edit_payload["requires_view_refresh"] is True
    assert save_status == 200
    assert save_payload["ok"] is True
    assert save_payload["updated_albums"] == []
    assert save_payload["updated_problematic_album"] is None
    assert save_payload["requires_view_refresh"] is True


def test_asgi_edit_tags_unsupported_fields_do_not_qualify_for_postgres_fragments(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import exception_overrides as exception_overrides_module

    track_path = "C:/Music/Artist/Album/03b - Unsupported Field.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "exception_overrides": "postgres",
        "library_browse": "postgres",
    }
    app.library_state["file_cache"] = {
        track_path: {
            "path": track_path,
            "title": "Unsupported Field",
            "album": "Album",
            "album_artist": "Artist",
            "exception_type": "",
        }
    }

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeLibraryBrowsePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real library-browse database connection")

    class FakeExceptionOverridesAdapter:
        def __init__(self, _config):
            pass

        def load_exception_overrides(self):
            return {}

        def upsert_exception_overrides(self, values):
            saved_overrides.append(dict(values))

    class FailingPostgresBrowseRepository:
        def __init__(self, _config):
            raise AssertionError("unsupported edit-tags fields must not instantiate Postgres projection")

    def fake_legacy_album_builder(*_args, **_kwargs):
        legacy_calls.append(True)
        return [{"key": "legacy-unsupported-field-album", "source": "file_cache"}]

    saved_overrides: list[dict[str, str]] = []
    legacy_calls: list[bool] = []
    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", FakeLibraryBrowsePsycopg())
    monkeypatch.setattr(exception_overrides_module, "RuleStatePostgresAdapter", FakeExceptionOverridesAdapter)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FailingPostgresBrowseRepository, raising=False)
    monkeypatch.setattr(asgi_routes, "_apply_repairs_worker", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("unsupported-field exception edit should not write media tags")))
    monkeypatch.setattr(asgi_routes, "_build_affected_album_dicts", fake_legacy_album_builder)
    monkeypatch.setattr(asgi_routes, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(asgi_routes, "append_log_history", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "create_save_task", lambda task_type: f"task-{task_type}")
    monkeypatch.setattr(asgi_routes, "_bridge_queue_finalize_save_task", _complete_mocked_edit_tags_save_task)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={
            "confirmed": True,
            "album": {"tracks": [{"path": track_path}]},
            "updates": {
                track_path: {
                    "exception_type": "Non-album rarity",
                    "unsupported_noop": "ignored",
                }
            },
        },
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["updated_albums"] == [{"key": "legacy-unsupported-field-album", "source": "file_cache"}]
    assert saved_overrides == [{track_path: "Non-album rarity"}]
    assert legacy_calls == [True]


def test_asgi_edit_tags_whitespace_or_cased_exception_field_names_use_legacy_fragments(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import exception_overrides as exception_overrides_module

    first_track_path = "C:/Music/Artist/Album/03c - Padded Exception Field.flac"
    second_track_path = "C:/Music/Artist/Album/03d - Cased Exception Field.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "exception_overrides": "postgres",
        "library_browse": "postgres",
    }
    app.library_state["file_cache"] = {
        first_track_path: {
            "path": first_track_path,
            "title": "Padded Exception Field",
            "album": "Album",
            "album_artist": "Artist",
            "exception_type": "",
        },
        second_track_path: {
            "path": second_track_path,
            "title": "Cased Exception Field",
            "album": "Album",
            "album_artist": "Artist",
            "exception_type": "",
        },
    }

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeLibraryBrowsePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real library-browse database connection")

    class FakeExceptionOverridesAdapter:
        def __init__(self, _config):
            pass

        def load_exception_overrides(self):
            return {}

        def upsert_exception_overrides(self, values):
            saved_overrides.append(dict(values))

    class FailingPostgresBrowseRepository:
        def __init__(self, _config):
            raise AssertionError("non-exact exception_type fields must not instantiate Postgres projection")

    def fake_legacy_album_builder(*_args, **_kwargs):
        legacy_calls.append(True)
        return [{"key": "legacy-non-exact-exception-field-album", "source": "file_cache"}]

    saved_overrides: list[dict[str, str]] = []
    legacy_calls: list[bool] = []
    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", FakeLibraryBrowsePsycopg())
    monkeypatch.setattr(exception_overrides_module, "RuleStatePostgresAdapter", FakeExceptionOverridesAdapter)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FailingPostgresBrowseRepository, raising=False)
    monkeypatch.setattr(asgi_routes, "_apply_repairs_worker", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("non-exact exception_type fields should not write media tags")))
    monkeypatch.setattr(asgi_routes, "_build_affected_album_dicts", fake_legacy_album_builder)
    monkeypatch.setattr(asgi_routes, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(asgi_routes, "append_log_history", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "create_save_task", lambda task_type: f"task-{task_type}")
    monkeypatch.setattr(asgi_routes, "_bridge_queue_finalize_save_task", _complete_mocked_edit_tags_save_task)

    cases = [
        (first_track_path, {" exception_type ": "Non-album rarity"}),
        (second_track_path, {"Exception_Type": "Non-album rarity"}),
    ]
    for track_path, updates in cases:
        status, _headers, body = _run_asgi_request(
            asgi_app,
            "POST",
            "/utilities/edit-tags",
            json_body={
                "confirmed": True,
                "album": {"tracks": [{"path": track_path}]},
                "updates": {track_path: updates},
            },
        )

        payload = _decode_json(body)
        assert status == 200
        assert payload["changed_files"] == []
        assert payload["updated_albums"] == [
            {"key": "legacy-non-exact-exception-field-album", "source": "file_cache"}
        ]

    assert saved_overrides == []
    assert legacy_calls == [True, True]


def test_asgi_edit_tags_noop_exception_only_update_uses_legacy_fragments(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import exception_overrides as exception_overrides_module

    track_path = "C:/Music/Artist/Album/03e - Noop Exception Field.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "exception_overrides": "postgres",
        "library_browse": "postgres",
    }
    app.library_state["file_cache"] = {
        track_path: {
            "path": track_path,
            "title": "Noop Exception Field",
            "album": "Album",
            "album_artist": "Artist",
            "exception_type": "Non-album rarity",
        }
    }

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeLibraryBrowsePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real library-browse database connection")

    class FakeExceptionOverridesAdapter:
        def __init__(self, _config):
            pass

        def load_exception_overrides(self):
            return {track_path: "Non-album rarity"}

        def upsert_exception_overrides(self, values):
            saved_overrides.append(dict(values))

    class FakePostgresBrowseRepository:
        def __init__(self, _config):
            pass

        def build_track_file_entries_by_paths(self, track_paths):
            return {
                track_path: {
                    "path": track_path,
                    "title": "Noop Exception Field",
                    "album": "Album",
                    "album_artist": "Artist",
                    "exception_type": "Non-album rarity",
                }
            }

        def build_album_payloads_by_track_paths(self, track_paths):
            return [{"key": "postgres-noop-exception-field-album", "source": "postgres"}]

    saved_overrides: list[dict[str, str]] = []
    queued_tasks: list[dict[str, object]] = []
    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", FakeLibraryBrowsePsycopg())
    monkeypatch.setattr(exception_overrides_module, "RuleStatePostgresAdapter", FakeExceptionOverridesAdapter)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository, raising=False)
    monkeypatch.setattr(asgi_routes, "_apply_repairs_worker", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("no-op exception-only edits should not write media tags")))
    monkeypatch.setattr(
        asgi_routes,
        "_build_affected_album_dicts",
        lambda *_args, **_kwargs: pytest.fail(
            "Postgres exception-only no-ops must not use file-cache album fragments"
        ),
    )
    monkeypatch.setattr(asgi_routes, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(asgi_routes, "append_log_history", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "create_save_task", lambda task_type: f"task-{task_type}")
    monkeypatch.setattr(asgi_routes, "_bridge_queue_finalize_save_task", lambda **kwargs: queued_tasks.append(dict(kwargs)))

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={
            "confirmed": True,
            "album": {"tracks": [{"path": track_path}]},
            "updates": {track_path: {"exception_type": " non album rarity "}},
        },
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["changed_files"] == []
    assert payload["updated_albums"] == [
        {"key": "postgres-noop-exception-field-album", "source": "postgres"}
    ]
    assert payload["save_task_id"] == ""
    assert saved_overrides == []
    assert queued_tasks == []


def test_asgi_edit_tags_exception_only_save_task_uses_selected_postgres_album_finder(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import exception_overrides as exception_overrides_module
    from music_app.services.save_tasks import update_save_task

    track_path = "C:/Music/Artist/Album/04 - Save Task.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "exception_overrides": "postgres",
        "library_browse": "postgres",
    }
    app.library_state["file_cache"] = {
        track_path: {
            "path": track_path,
            "title": "Save Task",
            "album": "Album",
            "album_artist": "Artist",
            "exception_type": "",
        }
    }

    class FakeRuleStatePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real rule-state database connection")

    class FakeLibraryBrowsePsycopg:
        def connect(self, *_args, **_kwargs):
            raise AssertionError("route tests should not open a real library-browse database connection")

    class FakeExceptionOverridesAdapter:
        def __init__(self, _config):
            pass

        def load_exception_overrides(self):
            return {}

        def upsert_exception_overrides(self, values):
            saved_overrides.append(dict(values))

    class FakePostgresBrowseRepository:
        def __init__(self, _config):
            repo_created.append(True)

        def build_track_file_entries_by_paths(self, track_paths):
            return {
                track_path: {
                    "path": track_path,
                    "title": "Save Task",
                    "album": "Album",
                    "album_artist": "Artist",
                    "exception_type": "",
                }
            }

        def build_album_payloads_by_track_paths(self, track_paths):
            seen_album_paths.append(set(track_paths))
            return [{"key": "postgres-save-task-album", "source": "postgres"}]

    def fail_legacy_album_builder(*_args, **_kwargs):
        raise AssertionError("selected Postgres exception-only edit-tags must not use legacy album fragments")

    def fail_legacy_save_task_finder(_track_paths, *, library_state):
        assert library_state is asgi_app.state.library_state
        raise AssertionError("save-task updated_albums must use the selected Postgres album finder")

    def immediate_queue_finalize_save_task(**kwargs):
        assert kwargs["scoped_postgres_exception_only"] is True
        assert (
            kwargs["find_problematic_album_by_track_paths"]
            is asgi_routes._empty_problematic_album_by_track_paths
        )
        finder = kwargs["find_albums_by_track_paths"]
        kwargs["complete_scoped_persistence"]()
        update_save_task(
            kwargs["task_id"],
            status="completed",
            updated_albums=finder(set(kwargs["requested_track_paths"])),
            updated_problematic_album=None,
            requires_view_refresh=True,
        )

    saved_overrides: list[dict[str, str]] = []
    repo_created: list[bool] = []
    seen_album_paths: list[set[str]] = []
    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakeRuleStatePsycopg())
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", FakeLibraryBrowsePsycopg())
    monkeypatch.setattr(exception_overrides_module, "RuleStatePostgresAdapter", FakeExceptionOverridesAdapter)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository, raising=False)
    monkeypatch.setattr(asgi_routes, "_apply_repairs_worker", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("exception-only edits should not write media tags")))
    monkeypatch.setattr(asgi_routes, "_build_affected_album_dicts", fail_legacy_album_builder)
    monkeypatch.setattr(asgi_routes, "_find_albums_by_track_paths", fail_legacy_save_task_finder)
    monkeypatch.setattr(asgi_routes, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(asgi_routes, "append_log_history", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "create_save_task", lambda _kind: "task-edit-tags-postgres")
    monkeypatch.setattr(asgi_routes, "queue_finalize_save_task", immediate_queue_finalize_save_task)

    edit_status, _edit_headers, edit_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={
            "confirmed": True,
            "album": {"tracks": [{"path": track_path}]},
            "updates": {track_path: {"exception_type": "Non-album rarity"}},
        },
    )
    save_status, _save_headers, save_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/save-task/task-edit-tags-postgres",
    )

    edit_payload = _decode_json(edit_body)
    save_payload = _decode_json(save_body)
    assert edit_status == 200
    assert edit_payload["save_task_id"] == "task-edit-tags-postgres"
    assert save_status == 200
    assert save_payload["ok"] is True
    assert save_payload["updated_albums"] == [{"key": "postgres-save-task-album", "source": "postgres"}]
    assert saved_overrides == [{track_path: "Non-album rarity"}]
    assert seen_album_paths == [{track_path}, {track_path}]
    assert repo_created == [True, True, True]


def test_problematic_files_origin_keeps_targeted_problem_refresh(monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    captured: dict[str, object] = {}
    monkeypatch.setattr(
        asgi_routes,
        "_is_selected_postgres_targeted_structural_edit_request",
        lambda *_args: False,
    )
    monkeypatch.setattr(
        asgi_routes,
        "_is_selected_postgres_library_browse_request",
        lambda *_args: False,
    )
    monkeypatch.setattr(
        asgi_routes,
        "_is_postgres_edit_tags_exception_only_response_request",
        lambda *_args: True,
    )
    monkeypatch.setattr(
        asgi_routes,
        "_postgres_album_finder_for_track_paths",
        lambda _request: lambda _paths: [],
    )
    monkeypatch.setattr(
        asgi_routes,
        "_bridge_queue_finalize_save_task",
        lambda **kwargs: captured.update(kwargs),
    )

    callback = asgi_routes._edit_tags_queue_finalize_save_task_builder(
        SimpleNamespace(),
        {"problematic_files_origin": True},
    )
    callback(task_id="problematic-origin")

    assert "find_problematic_album_by_track_paths" not in captured


def test_postgres_exception_edit_state_hydrates_requested_paths_without_replacing_full_runtime_cache(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    selected_path = "C:/Music/Artist/Album/05 - Selected.flac"
    unrelated_path = "C:/Music/Other/Album/01 - Unrelated.flac"
    app.library_state["file_cache"] = {
        selected_path: {
            "path": selected_path,
            "album": "Album",
            "exception_type": "",
        },
        unrelated_path: {
            "path": unrelated_path,
            "album": "Other Album",
            "exception_type": "Interview",
        },
    }

    class FakePostgresBrowseRepository:
        def __init__(self, _config):
            pass

        def build_track_file_entries_by_paths(self, track_paths):
            hydrated_paths.append(set(track_paths))
            return {
                selected_path: {
                    "path": selected_path,
                    "album": "Album",
                    "exception_type": "Non-album rarity",
                }
            }

        def build_album_payloads_by_track_paths(self, track_paths):
            return [
                {
                    "key": "artist-album",
                    "tracks": [
                        {
                            "path": selected_path,
                            "album": "Album",
                            "exception_type": "Non-album rarity",
                        }
                    ],
                }
            ]

    hydrated_paths: list[set[str]] = []
    monkeypatch.setattr(
        asgi_routes,
        "PostgresLibraryBrowseRepository",
        FakePostgresBrowseRepository,
    )

    state = asgi_routes._postgres_exception_only_edit_state(
        SimpleNamespace(app=asgi_app),
        {"updates": {selected_path: {"exception_type": ""}}},
    )

    assert hydrated_paths == [{selected_path}]
    assert state["file_cache"][selected_path]["exception_type"] == "Non-album rarity"
    assert state["file_cache"][unrelated_path]["exception_type"] == "Interview"


def test_asgi_edit_tags_clears_persisted_override_when_runtime_cache_is_stale(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import exception_overrides as exception_overrides_module

    track_path = "C:/Music/Artist/Album/06 - Persisted Override.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {
        "exception_overrides": "postgres",
        "library_browse": "postgres",
    }
    app.library_state["file_cache"] = {
        track_path: {
            "path": track_path,
            "album": "Album",
            "album_artist": "Artist",
            "exception_type": "",
        }
    }

    class FakeExceptionOverridesAdapter:
        def __init__(self, _config):
            pass

        def load_exception_overrides(self):
            return {track_path: "Non-album rarity"}

        def upsert_exception_overrides(self, values):
            saved_overrides.append(dict(values))

    class FakePostgresBrowseRepository:
        def __init__(self, _config):
            pass

        def build_track_file_entries_by_paths(self, track_paths):
            hydrated_paths.append(set(track_paths))
            return {
                track_path: {
                    "path": track_path,
                    "album": "Album",
                    "album_artist": "Artist",
                    "exception_type": "Non-album rarity",
                }
            }

        def build_album_payloads_by_track_paths(self, track_paths):
            return [{"key": "artist-album", "tracks": [{"path": track_path, "album": "Album", "exception_type": "Non-album rarity"}]}]

    saved_overrides: list[dict[str, str]] = []
    hydrated_paths: list[set[str]] = []
    monkeypatch.setattr(exception_overrides_module, "RuleStatePostgresAdapter", FakeExceptionOverridesAdapter)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository)
    monkeypatch.setattr(asgi_routes, "_apply_repairs_worker", lambda *_args, **_kwargs: pytest.fail("exception-only edits must not write media tags"))
    monkeypatch.setattr(asgi_routes, "_build_affected_album_dicts", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(asgi_routes, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(asgi_routes, "append_log_history", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "create_save_task", lambda _kind: "task-clear-override")
    monkeypatch.setattr(asgi_routes, "_bridge_queue_finalize_save_task", _complete_mocked_edit_tags_save_task)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={
            "confirmed": True,
            "album": {"tracks": [{"path": track_path}]},
            "updates": {track_path: {"exception_type": ""}},
        },
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["changed_files"] == [{"path": track_path, "fields": ["exception_type"]}]
    assert hydrated_paths and all(paths == {track_path} for paths in hydrated_paths)
    assert saved_overrides == [{track_path: ""}]


def test_asgi_edit_tags_rejects_mixed_resolved_and_missing_postgres_paths_without_partial_write(
    app, asgi_app, monkeypatch
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import exception_overrides as exception_overrides_module

    resolved_path = "C:/Music/Artist/Album/07 - Resolved.flac"
    missing_path = "C:/Music/Artist/Album/08 - Missing.flac"
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"exception_overrides": "postgres", "library_browse": "postgres"}
    app.library_state["file_cache"] = {}

    class FakeExceptionOverridesAdapter:
        def __init__(self, _config):
            pass

        def load_exception_overrides(self):
            return {}

        def upsert_exception_overrides(self, values):
            saved_overrides.append(dict(values))

    class FakePostgresBrowseRepository:
        def __init__(self, _config):
            pass

        def build_track_file_entries_by_paths(self, _track_paths):
            return {
                resolved_path: {
                    "path": resolved_path,
                    "album": "Album",
                    "exception_type": "",
                }
            }

        def build_album_payloads_by_track_paths(self, _track_paths):
            return [{"key": "artist-album", "tracks": [{"path": resolved_path, "album": "Album", "exception_type": ""}]}]

    saved_overrides: list[dict[str, str]] = []
    monkeypatch.setattr(exception_overrides_module, "RuleStatePostgresAdapter", FakeExceptionOverridesAdapter)
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository)
    monkeypatch.setattr(asgi_routes, "_apply_repairs_worker", lambda *_args, **_kwargs: pytest.fail("exception-only edits must not write media tags"))
    monkeypatch.setattr(asgi_routes, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(asgi_routes, "append_log_history", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "create_save_task", lambda _kind: "task-mixed-resolution")
    monkeypatch.setattr(asgi_routes, "_bridge_queue_finalize_save_task", _complete_mocked_edit_tags_save_task)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={
            "confirmed": True,
            "album": {"tracks": [{"path": resolved_path}, {"path": missing_path}]},
            "updates": {
                resolved_path: {"exception_type": "Non-album rarity"},
                missing_path: {"exception_type": "Non-album rarity"},
            },
        },
    )

    payload = _decode_json(body)
    assert 400 <= status < 500
    assert payload["ok"] is False
    assert missing_path in payload["error"]
    assert saved_overrides == []


def test_asgi_move_route_preserves_validation_and_service_call_contract(app, monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    class FailingAppContext:
        def __enter__(self):
            raise AssertionError("POST /utilities/move-album must not enter Flask app_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_flask_app(_request):
        raise AssertionError("POST /utilities/move-album must not read through _flask_app")

    called = {}
    sentinel_logger = SimpleNamespace(name="asgi-move-logger")

    def fake_execute_album_move(**kwargs):
        called.update(kwargs)
        assert kwargs["config"] is asgi_app.state.config
        assert kwargs["logger"] is sentinel_logger
        assert kwargs["get_state"]() is asgi_app.state.library_state
        return {"ok": True}

    monkeypatch.setattr(asgi_routes, "execute_album_move", fake_execute_album_move)
    assert not hasattr(asgi_routes, "_flask_app")

    asgi_app = _make_asgi_app()
    asgi_app.state.logger = sentinel_logger
    asgi_app.state.library_state = {**app.library_state, "albums": [], "file_cache": {}}
    missing_action_status, _missing_action_headers, missing_action_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/move-album",
        json_body={"confirmed": True, "album_key": "arrival-album"},
    )
    move_status, _move_headers, move_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/move-album",
        json_body={
            "confirmed": True,
            "album_key": "arrival-album",
            "action": "move_to_hoard",
        },
    )

    assert missing_action_status == 400
    assert _decode_json(missing_action_body) == {
        "ok": False,
        "error": "No move action was provided",
    }
    assert move_status == 200
    assert _decode_json(move_body) == {"ok": True}
    assert called["album_key"] == "arrival-album"
    assert called["requested_track_paths"] is None
    assert called["action"] == "move_to_hoard"
    assert called["find_albums_by_track_paths"] is not asgi_routes._find_albums_by_track_paths
    assert called["find_problematic_album_by_track_paths"] is not asgi_routes._find_problematic_album_by_track_paths


def test_asgi_move_route_returns_move_error_status_and_message(monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    def fake_execute_album_move(**_kwargs):
        raise asgi_routes.AlbumMoveError("Destination folder already exists", status_code=409)

    monkeypatch.setattr(asgi_routes, "execute_album_move", fake_execute_album_move)

    asgi_app = _make_asgi_app()

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/move-album",
        json_body={
            "confirmed": True,
            "album_key": "arrival-album",
            "action": "move_to_hoard",
        },
    )

    assert status == 409
    assert _decode_json(body) == {"ok": False, "error": "Destination folder already exists"}


def test_asgi_repair_album_route_uses_explicit_asgi_dependencies_without_flask_context(app, monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    class FailingAppContext:
        def __enter__(self):
            raise AssertionError("POST /utilities/repair-album must not enter Flask app_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_flask_app(_request):
        raise AssertionError("POST /utilities/repair-album must not read through _flask_app")

    called = {}
    sentinel_logger = SimpleNamespace(name="asgi-repair-logger")

    def fake_handle_repair_album_request(**kwargs):
        called.update(kwargs)
        assert kwargs["config"] is asgi_app.state.config
        assert kwargs["logger"] is sentinel_logger
        assert kwargs["get_state"]() is asgi_app.state.library_state
        return {"ok": True, "changed_files": [], "changed_count": 0}

    monkeypatch.setattr(asgi_routes, "handle_repair_album_request", fake_handle_repair_album_request)
    monkeypatch.setattr(
        asgi_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, config: SimpleNamespace(seam_id=seam_id, effective_backend="file"),
    )
    assert not hasattr(asgi_routes, "_flask_app")

    asgi_app = _make_asgi_app()
    asgi_app.state.logger = sentinel_logger
    asgi_app.state.library_state = {**app.library_state, "albums": [], "file_cache": {}}

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/repair-album",
        json_body={
            "confirmed": True,
            "album": {"name": "Album", "album_artist": "Artist", "tracks": [{"path": "track-1.flac"}]},
            "selected_rows": [],
        },
    )

    assert status == 200
    assert _decode_json(body) == {"ok": True, "changed_files": [], "changed_count": 0}
    assert called["requested_track_paths"] == {"track-1.flac"}
    assert called["queue_finalize_save_task"] is not asgi_routes._bridge_queue_finalize_save_task


def test_asgi_repair_album_keeps_suggestion_identity_unchanged(app, monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    suggestion_key = "C:/Music/Artist/Album/01 - Track.flac::title"
    captured_payloads: list[dict[str, object]] = []

    def fake_handle_repair_album_request(**kwargs):
        captured_payloads.append(dict(kwargs["payload"]))
        return {"ok": True, "changed_files": [], "changed_count": 0}

    monkeypatch.setattr(asgi_routes, "handle_repair_album_request", fake_handle_repair_album_request)
    monkeypatch.setattr(
        asgi_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, config: SimpleNamespace(seam_id=seam_id, effective_backend="file"),
    )

    asgi_app = _make_asgi_app()
    asgi_app.state.library_state = {**app.library_state, "albums": [], "file_cache": {}}

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/repair-album",
        json_body={
            "confirmed": True,
            "album": {
                "name": "Album",
                "album_artist": "Artist",
                "tracks": [{"path": "C:/Music/Artist/Album/01 - Track.flac"}],
            },
            "selected_rows": [suggestion_key],
        },
    )
    assert status == 200
    assert _decode_json(body)["ok"] is True

    assert captured_payloads[0]["selected_rows"] == [suggestion_key]
    assert "ignored_rows" not in captured_payloads[0]


def test_asgi_edit_tags_route_uses_explicit_asgi_dependencies_without_flask_context(monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    class FailingAppContext:
        def __enter__(self):
            raise AssertionError("POST /utilities/edit-tags must not enter Flask app_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_flask_app(_request):
        raise AssertionError("POST /utilities/edit-tags must not read through _flask_app")

    called = {}
    sentinel_logger = SimpleNamespace(name="asgi-edit-logger")

    def fake_handle_edit_tags_request(**kwargs):
        called.update(kwargs)
        assert kwargs["config"] is asgi_app.state.config
        assert kwargs["logger"] is sentinel_logger
        assert kwargs["get_state"]() is asgi_app.state.library_state
        kwargs["structural_tag_edit_reservation"].release()
        return {"ok": True, "changed_files": [], "changed_count": 0}

    monkeypatch.setattr(asgi_routes, "handle_edit_tags_request", fake_handle_edit_tags_request)
    monkeypatch.setattr(
        asgi_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, config: SimpleNamespace(seam_id=seam_id, effective_backend="file"),
    )
    assert not hasattr(asgi_routes, "_flask_app")

    asgi_app = _make_asgi_app()
    asgi_app.state.logger = sentinel_logger
    asgi_app.state.library_state = {"albums": [], "file_cache": {}}

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={
            "confirmed": True,
            "album": {"name": "Album", "album_artist": "Artist", "tracks": [{"path": "track-1.flac"}]},
            "updates": {"track-1.flac": {"title": "New Title"}},
        },
    )

    assert status == 200
    assert _decode_json(body) == {"ok": True, "changed_files": [], "changed_count": 0}
    assert called["requested_track_paths"] == {"track-1.flac"}
    assert called["queue_finalize_save_task"] is not asgi_routes._bridge_queue_finalize_save_task


@pytest.mark.parametrize(
    ("task_status", "task_error", "expected_error"),
    [
        ("pending", "", "authoritative persistence did not complete"),
        ("failed", "postgres commit failed", "postgres commit failed"),
    ],
)
def test_asgi_edit_tags_never_acknowledges_an_uncommitted_save_task(
    asgi_app,
    monkeypatch,
    task_status,
    task_error,
    expected_error,
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services.save_tasks import create_save_task, update_save_task

    task_log_entry = {
        "id": f"terminal-{task_status}-tag-edit-log",
        "action": "Tag edit failed",
        "error": task_error or expected_error,
    }

    def fake_handle_edit_tags_request(**kwargs):
        task_id = create_save_task("edit-tags")
        update_save_task(
            task_id,
            status=task_status,
            error=task_error,
            log_entry=task_log_entry,
        )
        kwargs["structural_tag_edit_reservation"].release()
        return {
            "ok": True,
            "changed_files": [{"path": "track-1.flac", "fields": ["title"]}],
            "changed_count": 1,
            "save_task_id": task_id,
        }

    monkeypatch.setattr(asgi_routes, "handle_edit_tags_request", fake_handle_edit_tags_request)
    monkeypatch.setattr(
        asgi_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, config: SimpleNamespace(
            seam_id=seam_id,
            effective_backend="file",
        ),
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={
            "confirmed": True,
            "album": {"tracks": [{"path": "track-1.flac"}]},
            "updates": {"track-1.flac": {"title": "New Title"}},
        },
    )

    payload = _decode_json(body)
    assert status == 500
    assert payload["ok"] is False
    assert expected_error in payload["error"]
    assert payload["save_task_status"] == task_status
    assert payload["log_entry"] == task_log_entry


def test_asgi_edit_tags_returns_committed_values_only_after_terminal_save_task(
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services.save_tasks import create_save_task, update_save_task

    committed_values = {
        "track-1.flac": {"title": "First"},
        "track-2.flac": {"title": "Second"},
        "track-3.flac": {"title": "Third"},
    }

    def fake_handle_edit_tags_request(**kwargs):
        task_id = create_save_task("edit-tags")
        update_save_task(
            task_id,
            status="completed",
            committed_values=committed_values,
            timings={"postgres_ms": 4.25},
            updated_albums=[],
            updated_problematic_album=None,
            requires_view_refresh=False,
        )
        kwargs["structural_tag_edit_reservation"].release()
        return {
            "ok": True,
            "changed_files": [
                {"path": path, "fields": ["title"]}
                for path in committed_values
            ],
            "changed_count": 3,
            "save_task_id": task_id,
        }

    monkeypatch.setattr(asgi_routes, "handle_edit_tags_request", fake_handle_edit_tags_request)
    monkeypatch.setattr(
        asgi_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, config: SimpleNamespace(
            seam_id=seam_id,
            effective_backend="file",
        ),
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={
            "confirmed": True,
            "album": {
                "tracks": [{"path": path} for path in committed_values]
            },
            "updates": {
                path: dict(fields) for path, fields in committed_values.items()
            },
        },
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["ok"] is True
    assert payload["save_task_status"] == "completed"
    assert payload["committed_values"] == committed_values
    assert payload["timings"]["postgres_ms"] == 4.25
    assert payload["timings"]["total_ms"] >= 0


def test_selected_postgres_media_compensation_is_path_scoped_and_restores_exception(
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    first_path = "C:/Music/Artist/Album/01 First.flac"
    second_path = "C:/Music/Artist/Album/02 Second.flac"
    applied_repairs: list[tuple[str, dict[str, str]]] = []
    restored_exceptions: list[dict[str, str]] = []
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        asgi_routes,
        "_apply_repairs_worker",
        lambda path, repairs: applied_repairs.append((path, dict(repairs))),
    )
    monkeypatch.setattr(
        asgi_routes,
        "set_track_exception_overrides",
        lambda _config, values: restored_exceptions.append(dict(values)),
    )
    monkeypatch.setattr(
        asgi_routes,
        "_selected_postgres_media_write_queue_finalize_save_task",
        lambda **kwargs: captured.update(kwargs),
    )

    callback = (
        asgi_routes._asgi_selected_postgres_media_write_queue_finalize_save_task_builder(
            SimpleNamespace(app=asgi_app)
        )
    )
    callback(config=asgi_app.state.config)
    captured["compensate_save_task"](
        changed_paths={first_path, second_path},
        previous_file_entries={
            first_path: {
                "title": "First",
                "genre": "Folk",
                "exception_type": "Non-album rarity",
            },
            second_path: {
                "title": "Second",
                "genre": "Rock",
                "exception_type": "",
            },
        },
        updated_file_entries={
            first_path: {
                "title": "Renamed First",
                "genre": "Folk",
                "exception_type": "",
            },
            second_path: {
                "title": "Second",
                "genre": "Metal",
                "exception_type": "",
            },
        },
        changed_field_names={"title", "genre", "exception_type"},
    )

    assert applied_repairs == [
        (first_path, {"title": "First"}),
        (second_path, {"genre": "Rock"}),
    ]
    assert restored_exceptions == [
        {first_path: "Non-album rarity"}
    ]


def test_selected_postgres_album_edit_skips_unrelated_relation_projection_rebuild(
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    captured: dict[str, object] = {}

    def fake_persist(_config, *, rebuild_relation_projection, **_options):
        captured["rebuild_relation_projection"] = rebuild_relation_projection
        return {}

    def run_finalizer(**kwargs):
        captured["relation_projection_edit_fields"] = kwargs.get(
            "relation_projection_edit_fields"
        )
        kwargs["persist_structural_tag_edit"](
            changed_paths={"track.mp3"},
            previous_file_entries={"track.mp3": {"album": ""}},
            updated_file_entries={"track.mp3": {"album": "Folkstone"}},
            changed_field_names={"album"},
        )

    monkeypatch.setattr(
        asgi_routes,
        "persist_structural_tag_edit_for_config",
        fake_persist,
    )
    monkeypatch.setattr(
        asgi_routes,
        "queue_finalize_structural_tag_edit_save_task",
        run_finalizer,
    )

    callback = (
        asgi_routes._asgi_selected_postgres_structural_tag_edit_queue_finalize_save_task_builder(
            SimpleNamespace(app=asgi_app)
        )
    )
    callback(config=asgi_app.state.config)

    assert captured == {
        "rebuild_relation_projection": False,
        "relation_projection_edit_fields": {"album_artist", "artist"},
    }


def test_asgi_bridge_finalize_default_problematic_matcher_uses_explicit_dependencies(app, monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    observed: dict[str, object] = {}
    sentinel_logger = SimpleNamespace(name="asgi-save-task-logger")
    library_state = {"albums": [], "file_cache": {"track-1.flac": {"path": "track-1.flac"}}}

    def fake_find_problematic_album_by_track_paths(track_paths, **kwargs):
        observed["track_paths"] = set(track_paths)
        observed.update(kwargs)
        return {"key": "problematic-from-explicit-deps"}

    def fake_queue_finalize_save_task(**kwargs):
        observed["matched_problematic_album"] = kwargs["find_problematic_album_by_track_paths"]({"track-1.flac"})

    monkeypatch.setattr(
        asgi_routes,
        "_find_problematic_album_by_track_paths",
        fake_find_problematic_album_by_track_paths,
    )
    monkeypatch.setattr(asgi_routes, "queue_finalize_save_task", fake_queue_finalize_save_task)

    asgi_routes._bridge_queue_finalize_save_task(
        task_id="task-1",
        config=app.config,
        logger=sentinel_logger,
        get_state=lambda: library_state,
        requested_track_paths={"track-1.flac"},
        changed_field_names={"title"},
    )

    assert observed["matched_problematic_album"] == {"key": "problematic-from-explicit-deps"}
    assert observed["track_paths"] == {"track-1.flac"}
    assert observed["config"] is app.config
    assert observed["library_state"] is library_state
    assert observed["logger"] is sentinel_logger


def test_asgi_bridge_artist_edit_requests_atomic_relation_projection_rebuild(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    scheduled: list[dict[str, object]] = []

    def fake_schedule(
        config,
        cache_path,
        changed_entries,
        *,
        baseline_file_cache,
        rebuild_relation_projection,
    ):
        scheduled.append(
            {
                "config": config,
                "cache_path": cache_path,
                "changed_entries": dict(changed_entries),
                "baseline_file_cache": dict(baseline_file_cache),
                "rebuild_relation_projection": rebuild_relation_projection,
            }
        )
        return None

    def run_finalizer(**kwargs):
        kwargs["schedule_cache_updates_save"](
            app.config["CACHE_PATH"],
            {"track-1.flac": {"path": "track-1.flac", "album_artist": "New Artist"}},
            {"track-1.flac": {"path": "track-1.flac", "album_artist": "Old Artist"}},
        )

    monkeypatch.setattr(
        asgi_routes,
        "schedule_cache_updates_save_for_config",
        fake_schedule,
    )
    monkeypatch.setattr(asgi_routes, "queue_finalize_save_task", run_finalizer)

    asgi_routes._bridge_queue_finalize_save_task(
        task_id="task-relation-rebuild",
        config=app.config,
        logger=SimpleNamespace(name="asgi-save-task-logger"),
        get_state=lambda: {"albums": [], "file_cache": {}},
        requested_track_paths={"track-1.flac"},
        changed_field_names={"album_artist"},
    )

    assert scheduled == [
        {
            "config": app.config,
            "cache_path": app.config["CACHE_PATH"],
            "changed_entries": {
                "track-1.flac": {
                    "path": "track-1.flac",
                    "album_artist": "New Artist",
                }
            },
            "baseline_file_cache": {
                "track-1.flac": {
                    "path": "track-1.flac",
                    "album_artist": "Old Artist",
                }
            },
            "rebuild_relation_projection": True,
        }
    ]


def test_asgi_edit_routes_preserve_task_and_validation_payloads(app):
    asgi_app = _make_asgi_app()

    save_task_status, _save_task_headers, save_task_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/save-task/missing-task",
    )
    repair_status, _repair_headers, repair_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/repair-album",
        json_body={"confirmed": False, "album": {"tracks": []}, "selected_rows": []},
    )
    edit_status, _edit_headers, edit_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={"confirmed": True, "album": {"tracks": []}, "updates": {}},
    )
    edit_unconfirmed_status, _edit_unconfirmed_headers, edit_unconfirmed_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={"confirmed": False, "album": {"tracks": []}, "updates": {"track-1.mp3": {"title": "Song"}}},
    )

    assert save_task_status == 404
    assert _decode_json(save_task_body) == {"ok": False, "error": "Save task not found"}
    assert repair_status == 400
    assert _decode_json(repair_body) == {"ok": False, "error": "Repair was not confirmed"}
    assert edit_status == 400
    assert _decode_json(edit_body) == {"ok": False, "error": "No tag edits were provided"}
    assert edit_unconfirmed_status == 400
    assert _decode_json(edit_unconfirmed_body) == {"ok": False, "error": "Tag edit was not confirmed"}


def test_asgi_edit_tags_returns_error_payload_on_write_failure(app, asgi_app, monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    track_path = str((app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve())
    app.library_state["file_cache"] = {
        track_path: {
            "path": track_path,
            "title": "Song",
            "album": "Test Album",
            "album_artist": "Test Artist",
        }
    }
    app.library_state["separate_release_keys"] = set()

    def fail_worker(raw_path, repairs):
        raise RuntimeError("boom")

    monkeypatch.setattr(asgi_routes, "_apply_repairs_worker", fail_worker)
    monkeypatch.setattr(
        asgi_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, config: SimpleNamespace(seam_id=seam_id, effective_backend="file"),
    )
    monkeypatch.setattr(asgi_routes, "append_log_history", lambda *args, **kwargs: None)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={
            "confirmed": True,
            "album": {"tracks": [{"path": track_path}]},
            "updates": {track_path: {"title": "New Song"}},
        },
    )

    assert status == 500
    payload = _decode_json(body)
    expected_error = f"Failed to edit tags for {track_path}: boom"
    assert payload["ok"] is False
    assert payload["error"] == expected_error
    assert payload["log_entry"]["action"] == "Tag edit failed"
    assert payload["log_entry"]["file_count"] == 1
    assert payload["log_entry"]["files"] == [track_path]
    assert payload["log_entry"]["error"] == expected_error


def test_waiting_structural_edit_does_not_block_unrelated_async_request(
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import save_tasks as save_tasks_module

    track_path = "C:/Music/Artist/Old Album/song.mp3"
    album_key = "artist::old album"
    resource_keys = save_tasks_module.structural_tag_edit_resource_keys(
        album_key,
        {track_path},
        {"artist::new album"},
    )
    blocker = save_tasks_module.acquire_structural_tag_edit_reservation(
        resource_keys
    )
    blocker_released = Event()
    waiting_handler_entered = Event()

    def release_blocker():
        blocker.release()
        blocker_released.set()

    def fake_handle_edit_tags_request(**kwargs):
        waiting_handler_entered.set()
        kwargs["structural_tag_edit_reservation"].release()
        return {"ok": True, "changed_files": [], "changed_count": 0}

    monkeypatch.setattr(
        asgi_routes,
        "_is_selected_postgres_library_browse_request",
        lambda _request: True,
    )
    monkeypatch.setattr(
        asgi_routes,
        "_is_postgres_edit_tags_exception_only_response_request",
        lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(
        asgi_routes,
        "handle_edit_tags_request",
        fake_handle_edit_tags_request,
    )

    timer = Timer(2.0, release_blocker)
    timer.daemon = True
    timer.start()

    async def exercise_routes():
        edit_request = asyncio.create_task(
            _run_asgi_request_async(
                asgi_app,
                "POST",
                "/utilities/edit-tags",
                json_body={
                    "confirmed": True,
                    "album": {
                        "key": album_key,
                        "name": "Old Album",
                        "album_artist": "Artist",
                        "tracks": [{"path": track_path}],
                    },
                    "updates": {track_path: {"album": "New Album"}},
                },
            )
        )
        for _attempt in range(100):
            if save_tasks_module._STRUCTURAL_TAG_EDIT_RESERVATIONS._waiting:
                break
            await asyncio.sleep(0.01)
        assert save_tasks_module._STRUCTURAL_TAG_EDIT_RESERVATIONS._waiting
        assert waiting_handler_entered.is_set() is False
        unrelated_request = asyncio.create_task(
            _run_asgi_request_async(
                asgi_app,
                "GET",
                "/utilities/save-task/missing-task",
            )
        )
        unrelated_result = await asyncio.wait_for(unrelated_request, timeout=1.0)
        assert blocker_released.is_set() is False
        release_blocker()
        edit_result = await edit_request
        assert waiting_handler_entered.is_set()
        return unrelated_result, edit_result

    try:
        unrelated_result, edit_result = asyncio.run(exercise_routes())
    finally:
        timer.cancel()
        if not blocker_released.is_set():
            release_blocker()

    assert unrelated_result[0] == 404
    assert edit_result[0] == 200


def test_non_album_media_edit_reserves_source_album_and_track_path(
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import save_tasks as save_tasks_module

    track_path = "C:/Music/Artist/Album/song.mp3"
    expected_keys = save_tasks_module.structural_tag_edit_resource_keys(
        "artist::album",
        {track_path},
    )
    acquired: list[set[str]] = []
    releases: list[str] = []

    class Lease:
        def release(self):
            releases.append("released")

    async def acquire(resource_keys):
        acquired.append(set(resource_keys))
        return Lease()

    def handle(**kwargs):
        assert kwargs["structural_tag_edit_reservation"] is not None
        kwargs["structural_tag_edit_reservation"].release()
        return {"ok": True, "changed_files": [], "changed_count": 0}

    monkeypatch.setattr(
        asgi_routes,
        "acquire_structural_tag_edit_reservation_async",
        acquire,
    )
    monkeypatch.setattr(
        asgi_routes,
        "_is_selected_postgres_library_browse_request",
        lambda _request: False,
    )
    monkeypatch.setattr(
        asgi_routes,
        "_is_postgres_edit_tags_exception_only_response_request",
        lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(asgi_routes, "handle_edit_tags_request", handle)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/edit-tags",
        json_body={
            "confirmed": True,
            "album": {
                "key": "artist::album",
                "name": "Album",
                "album_artist": "Artist",
                "tracks": [{"path": track_path}],
            },
            "updates": {track_path: {"title": "New Title"}},
        },
    )

    assert status == 200
    assert _decode_json(body)["ok"] is True
    assert acquired == [expected_keys]
    assert releases == ["released"]


def test_media_edit_reservation_includes_destination_album_identity_changes():
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes
    from music_app.services import save_tasks as save_tasks_module

    track_path = "C:/Music/Artist/Album/song.mp3"
    album = {
        "key": "artist::album",
        "name": "Album",
        "album_artist": "Artist",
        "year": "2000",
        "edition": "",
    }
    updates = {
        track_path: {
            "album": "Renamed",
            "album_artist": "New Artist",
            "year": "2026",
            "edition": "Deluxe",
        }
    }
    destination_key = asgi_routes._album_key(
        "New Artist",
        "Renamed",
        "Deluxe",
        "2026",
    )

    keys = asgi_routes._edit_tags_reservation_resource_keys(
        album,
        updates,
    )

    assert keys == save_tasks_module.structural_tag_edit_resource_keys(
        "artist::album",
        {track_path},
        {destination_key},
    )


def test_media_edit_reservation_releases_when_thread_handoff_never_starts(
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    releases: list[str] = []
    lease = SimpleNamespace(release=lambda: releases.append("released"))

    async def fail_before_start(_callback):
        raise RuntimeError("thread handoff unavailable")

    monkeypatch.setattr(
        asgi_routes,
        "run_in_threadpool",
        fail_before_start,
    )

    with pytest.raises(RuntimeError, match="thread handoff unavailable"):
        asyncio.run(
            asgi_routes._run_edit_tags_handler_with_reservation(
                {},
                lease,
            )
        )

    assert releases == ["released"]


def test_many_waiting_media_edits_do_not_starve_disjoint_edit(
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    release_shared = asyncio.Event()
    shared_waiters = 0
    shared_track = "C:/Music/Artist/Shared/song.mp3"
    disjoint_track = "C:/Music/Other/Disjoint/song.mp3"

    class Lease:
        def release(self):
            return None

    async def acquire(resource_keys):
        nonlocal shared_waiters
        if any("shared" in key.casefold() for key in resource_keys):
            shared_waiters += 1
            await release_shared.wait()
        return Lease()

    def handle(**kwargs):
        kwargs["structural_tag_edit_reservation"].release()
        return {"ok": True, "changed_files": [], "changed_count": 0}

    monkeypatch.setattr(
        asgi_routes,
        "acquire_structural_tag_edit_reservation_async",
        acquire,
    )
    monkeypatch.setattr(
        asgi_routes,
        "_is_selected_postgres_library_browse_request",
        lambda _request: False,
    )
    monkeypatch.setattr(
        asgi_routes,
        "_is_postgres_edit_tags_exception_only_response_request",
        lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(asgi_routes, "handle_edit_tags_request", handle)

    def edit_payload(album_key, album_name, artist, track_path):
        return {
            "confirmed": True,
            "album": {
                "key": album_key,
                "name": album_name,
                "album_artist": artist,
                "tracks": [{"path": track_path}],
            },
            "updates": {track_path: {"title": "New Title"}},
        }

    async def scenario():
        waiting_requests = [
            asyncio.create_task(
                _run_asgi_request_async(
                    asgi_app,
                    "POST",
                    "/utilities/edit-tags",
                    json_body=edit_payload(
                        "artist::shared",
                        "Shared",
                        "Artist",
                        shared_track,
                    ),
                )
            )
            for _index in range(48)
        ]
        for _attempt in range(100):
            if shared_waiters == 48:
                break
            await asyncio.sleep(0.01)
        assert shared_waiters == 48

        disjoint_result = await asyncio.wait_for(
            _run_asgi_request_async(
                asgi_app,
                "POST",
                "/utilities/edit-tags",
                json_body=edit_payload(
                    "other::disjoint",
                    "Disjoint",
                    "Other",
                    disjoint_track,
                ),
            ),
            timeout=1.0,
        )
        assert release_shared.is_set() is False
        release_shared.set()
        waiting_results = await asyncio.gather(*waiting_requests)
        return disjoint_result, waiting_results

    disjoint_result, waiting_results = asyncio.run(scenario())

    assert disjoint_result[0] == 200
    assert all(result[0] == 200 for result in waiting_results)


def test_same_track_non_album_media_writes_serialize(
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    track_path = "C:/Music/Artist/Album/song.mp3"
    first_entered = Event()
    second_entered = Event()
    release_first = Event()
    calls = 0

    def handle(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            first_entered.set()
            release_first.wait(timeout=2.0)
        else:
            second_entered.set()
        kwargs["structural_tag_edit_reservation"].release()
        return {"ok": True, "changed_files": [], "changed_count": 0}

    monkeypatch.setattr(
        asgi_routes,
        "_is_selected_postgres_library_browse_request",
        lambda _request: False,
    )
    monkeypatch.setattr(
        asgi_routes,
        "_is_postgres_edit_tags_exception_only_response_request",
        lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(asgi_routes, "handle_edit_tags_request", handle)
    payload = {
        "confirmed": True,
        "album": {
            "key": "artist::album",
            "name": "Album",
            "album_artist": "Artist",
            "tracks": [{"path": track_path}],
        },
        "updates": {track_path: {"title": "New Title"}},
    }

    async def scenario():
        first = asyncio.create_task(
            _run_asgi_request_async(
                asgi_app,
                "POST",
                "/utilities/edit-tags",
                json_body=payload,
            )
        )
        assert await asyncio.to_thread(first_entered.wait, 1.0)
        second = asyncio.create_task(
            _run_asgi_request_async(
                asgi_app,
                "POST",
                "/utilities/edit-tags",
                json_body=payload,
            )
        )
        assert await asyncio.to_thread(second_entered.wait, 0.2) is False
        release_first.set()
        first_result, second_result = await asyncio.gather(first, second)
        return first_result, second_result

    try:
        first_result, second_result = asyncio.run(scenario())
    finally:
        release_first.set()

    assert first_result[0] == 200
    assert second_result[0] == 200
    assert second_entered.is_set()


def test_disjoint_non_album_media_writes_overlap(
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as asgi_routes

    entered: list[str] = []
    both_entered = Event()
    release_handlers = Event()

    def handle(**kwargs):
        track_path = next(iter(kwargs["updates"]))
        entered.append(track_path)
        if len(entered) == 2:
            both_entered.set()
        release_handlers.wait(timeout=2.0)
        kwargs["structural_tag_edit_reservation"].release()
        return {"ok": True, "changed_files": [], "changed_count": 0}

    monkeypatch.setattr(
        asgi_routes,
        "_is_selected_postgres_library_browse_request",
        lambda _request: False,
    )
    monkeypatch.setattr(
        asgi_routes,
        "_is_postgres_edit_tags_exception_only_response_request",
        lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(asgi_routes, "handle_edit_tags_request", handle)

    def payload(album_key, album_name, artist, track_path):
        return {
            "confirmed": True,
            "album": {
                "key": album_key,
                "name": album_name,
                "album_artist": artist,
                "tracks": [{"path": track_path}],
            },
            "updates": {track_path: {"title": "New Title"}},
        }

    async def scenario():
        first = asyncio.create_task(
            _run_asgi_request_async(
                asgi_app,
                "POST",
                "/utilities/edit-tags",
                json_body=payload(
                    "artist::first",
                    "First",
                    "Artist",
                    "C:/Music/Artist/First/song.mp3",
                ),
            )
        )
        second = asyncio.create_task(
            _run_asgi_request_async(
                asgi_app,
                "POST",
                "/utilities/edit-tags",
                json_body=payload(
                    "other::second",
                    "Second",
                    "Other",
                    "C:/Music/Other/Second/song.mp3",
                ),
            )
        )
        assert await asyncio.to_thread(both_entered.wait, 1.0)
        release_handlers.set()
        return await asyncio.gather(first, second)

    try:
        results = asyncio.run(scenario())
    finally:
        release_handlers.set()

    assert len(entered) == 2
    assert all(result[0] == 200 for result in results)
