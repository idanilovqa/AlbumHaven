from __future__ import annotations

import ast
import asyncio
import importlib.util
import json
import logging
from pathlib import Path
import runpy
import subprocess
import sys
import threading
import types

import pytest
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from music_app.services.metadata import FILE_METADATA_SCHEMA_VERSION
from tests.py.asgi_testing import create_test_asgi_app
from tests.py.asgi_testing import run_asgi_request
from tests.py.asgi_testing import collect_route_methods as _collect_route_methods
from tests.py.asgi_testing import collect_route_paths as _collect_route_paths
from tests.py.asgi_testing import runtime_app_from_asgi_app


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class _FatalFlaskContextAccess:
    def __init__(self, runtime) -> None:
        self._runtime = runtime

    def __getattr__(self, name: str):
        if name in {"app_context", "test_request_context"}:
            raise AssertionError("Last.fm retry worker must not access Flask context methods")
        return getattr(self._runtime, name)


@pytest.fixture(autouse=True)
def _stub_relation_projection_startup(monkeypatch):
    from music_app.services import state

    def ensure_ready(runtime):
        runtime.library_state["relation_projection_ready"] = True
        runtime.library_state["relation_projection_rebuild_reason"] = "healthy"
        return {"ready": True, "relation_views": runtime.library_state.get("relation_views", {})}

    monkeypatch.setattr(state, "ensure_runtime_relation_projection_ready", ensure_ready)


@pytest.fixture
def app(tmp_path, monkeypatch):
    return runtime_app_from_asgi_app(create_test_asgi_app(tmp_path, monkeypatch))


def test_retained_dependency_manifests_do_not_declare_flask():
    manifest_paths = [REPOSITORY_ROOT / "requirements.txt"]
    forbidden_package = canonicalize_name("flask")
    offenders: list[str] = []

    for manifest_path in manifest_paths:
        for raw_line in manifest_path.read_text(encoding="utf-8").splitlines():
            requirement_line = raw_line.strip()
            if not requirement_line or requirement_line.startswith(("#", "-")):
                continue
            requirement_line = requirement_line.split(" #", maxsplit=1)[0].rstrip()
            if canonicalize_name(Requirement(requirement_line).name) == forbidden_package:
                offenders.append(str(manifest_path.relative_to(REPOSITORY_ROOT)))

    assert offenders == [], f"Flask dependency still declared by: {offenders!r}"


def test_active_python_surfaces_do_not_import_flask():
    tracked_files_result = subprocess.run(
        ["git", "ls-files", "--", "*.py"],
        cwd=REPOSITORY_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert tracked_files_result.returncode == 0, (
        "Unable to enumerate tracked root-level Python modules.\n"
        f"stdout:\n{tracked_files_result.stdout}\n"
        f"stderr:\n{tracked_files_result.stderr}"
    )
    source_paths = sorted(
        REPOSITORY_ROOT / relative_path
        for relative_path in map(Path, tracked_files_result.stdout.splitlines())
        if relative_path.parent == Path(".")
    )
    for source_root in (
        REPOSITORY_ROOT / "music_app",
        REPOSITORY_ROOT / "scripts",
        REPOSITORY_ROOT / "tests" / "py",
        REPOSITORY_ROOT / "tests" / "e2e" / "support",
    ):
        source_paths.extend(sorted(source_root.rglob("*.py")))

    offenders: list[str] = []
    for source_path in source_paths:
        source_tree = ast.parse(
            source_path.read_text(encoding="utf-8-sig"),
            filename=str(source_path),
        )
        for node in ast.walk(source_tree):
            if isinstance(node, ast.Import):
                imported_modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module is not None:
                imported_modules = [node.module]
            else:
                continue

            for module in imported_modules:
                if module == "flask" or module.startswith("flask."):
                    relative_path = source_path.relative_to(REPOSITORY_ROOT)
                    offenders.append(f"{relative_path}:{node.lineno}: {module}")

    assert offenders == [], f"Flask imports remain in active Python surfaces: {offenders!r}"


def test_asgi_factory_imports_and_initializes_when_flask_imports_are_blocked():
    child_script = """
import sys


class RejectFlaskImports:
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "flask" or fullname.startswith("flask."):
            raise ImportError(f"blocked Flask import: {fullname}")
        return None


sys.meta_path.insert(0, RejectFlaskImports())

import music_app

asgi_app = music_app.create_asgi_app()

from fastapi import FastAPI

assert isinstance(asgi_app, FastAPI)
assert asgi_app.state.config["APP_NAME"] == asgi_app.title
assert asgi_app.state.config["APP_VERSION"] == asgi_app.version
assert asgi_app.state.library_state["scan_phase"] == "idle"
assert not hasattr(asgi_app.state, "flask_app")
print("ASGI factory initialized without Flask imports")
"""

    result = subprocess.run(
        [sys.executable, "-c", child_script],
        cwd=REPOSITORY_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, (
        "Fresh-process ASGI factory check failed with Flask imports blocked.\n"
        f"stdout:\n{result.stdout}\n"
        f"stderr:\n{result.stderr}"
    )
    assert result.stdout.strip() == "ASGI factory initialized without Flask imports"


def test_asgi_route_and_app_factory_tests_do_not_import_flask_fixtures():
    forbidden_import = ".".join(("tests", "py", "flask_fixtures"))
    test_paths = [
        "tests/py/test_api_read_asgi_routes.py",
        "tests/py/test_api_wave_a_asgi_routes.py",
        "tests/py/test_api_wave_b_asgi_routes.py",
        "tests/py/test_api_wave_c_asgi_routes.py",
        "tests/py/test_api_wave_d_asgi_routes.py",
        "tests/py/test_web_asgi_routes.py",
        "tests/py/test_app_factory.py",
    ]

    offenders = [
        test_path
        for test_path in test_paths
        if forbidden_import in Path(test_path).read_text(encoding="utf-8")
    ]

    assert offenders == [], f"{forbidden_import} still imported by: {offenders!r}"


def test_runtime_app_scaffold_does_not_fabricate_flask_context_methods():
    scaffold_source = Path("tests/py/asgi_testing.py").read_text(encoding="utf-8")

    assert "app_context=" not in scaffold_source
    assert "test_request_context=" not in scaffold_source


def _run_asgi_http_get(app, path: str) -> tuple[int, dict[str, str], bytes]:
    return run_asgi_request(app, "GET", path)


def _run_asgi_lifespan(app) -> list[dict[str, object]]:
    async def call() -> list[dict[str, object]]:
        sent: list[dict[str, object]] = []
        events = iter(
            [
                {"type": "lifespan.startup"},
                {"type": "lifespan.shutdown"},
            ]
        )

        async def receive() -> dict[str, object]:
            return next(events)

        async def send(message: dict[str, object]) -> None:
            sent.append(message)

        await app({"type": "lifespan", "asgi": {"version": "3.0"}}, receive, send)
        return sent

    return asyncio.run(call())


def test_music_app_package_source_has_no_flask_factory_markers():
    package_path = Path(__file__).resolve().parents[2] / "music_app" / "__init__.py"
    package_source = package_path.read_text(encoding="utf-8")
    package_tree = ast.parse(package_source)
    imported_modules = {
        alias.name
        for node in ast.walk(package_tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    }
    imported_modules.update(
        node.module
        for node in ast.walk(package_tree)
        if isinstance(node, ast.ImportFrom) and node.module is not None
    )
    defined_functions = {
        node.name
        for node in ast.walk(package_tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }

    assert not any(
        module == "flask" or module.startswith("flask.")
        for module in imported_modules
    )
    assert {"create_app", "_create_flask_app"}.isdisjoint(defined_functions)


def test_asgi_runner_uses_import_factory_target_when_reloader_enabled(monkeypatch):
    calls: list[dict[str, object]] = []

    fake_uvicorn = types.SimpleNamespace(
        run=lambda app, **kwargs: calls.append({"app": app, **kwargs})
    )
    monkeypatch.setitem(sys.modules, "uvicorn", fake_uvicorn)
    monkeypatch.setenv("MUSIC_APP_SERVER", "asgi")
    monkeypatch.setenv("MUSIC_APP_RELOADER", "1")
    monkeypatch.setenv("MUSIC_APP_PORT", "5123")

    try:
        runpy.run_module("app", run_name="__main__")
    except SystemExit as exc:
        assert exc.code == 0

    assert calls == [
        {
            "app": "music_app:create_asgi_app",
            "host": "0.0.0.0",
            "port": 5123,
            "reload": True,
            "factory": True,
        }
    ]


def test_asgi_runner_is_default_server_kind(monkeypatch):
    calls: list[dict[str, object]] = []

    fake_uvicorn = types.SimpleNamespace(
        run=lambda app, **kwargs: calls.append({"app": app, **kwargs})
    )
    monkeypatch.setitem(sys.modules, "uvicorn", fake_uvicorn)
    monkeypatch.delenv("MUSIC_APP_SERVER", raising=False)
    monkeypatch.delenv("MUSIC_APP_RELOADER", raising=False)
    monkeypatch.setenv("MUSIC_APP_PORT", "5124")

    try:
        runpy.run_module("app", run_name="__main__")
    except SystemExit as exc:
        assert exc.code == 0

    assert calls == [
        {
            "app": "music_app:create_asgi_app",
            "host": "0.0.0.0",
            "port": 5124,
            "reload": False,
            "factory": True,
        }
    ]


def test_create_asgi_app_initializes_fastapi_runtime_state_without_flask_bridge():
    from config import APP_NAME, APP_VERSION
    from music_app import create_asgi_app

    asgi_app = create_asgi_app()

    assert asgi_app.title == APP_NAME
    assert asgi_app.version == APP_VERSION
    assert not hasattr(asgi_app.state, "flask_app")
    assert asgi_app.state.config["APP_NAME"] == APP_NAME
    assert asgi_app.state.config["APP_VERSION"] == APP_VERSION
    assert asgi_app.state.library_state["scan_phase"] == "idle"
    assert asgi_app.state.logger.propagate is True
    assert logging.getLogger().handlers


def test_create_asgi_app_exposes_static_mount_and_template_lookup():
    from music_app import create_asgi_app

    asgi_app = create_asgi_app()

    assert any(getattr(route, "path", "") == "/static" for route in asgi_app.routes)
    template = asgi_app.state.templates.get_template("index.html")
    assert template.name == "index.html"

    status, headers, body = _run_asgi_http_get(asgi_app, "/static/styles.css")
    assert status == 200
    assert headers["content-type"].startswith("text/css")
    assert b"css/runtime/" in body


def test_asgi_factory_does_not_export_flask_bridge_factories():
    import music_app

    assert not hasattr(music_app, "create_app")
    assert not hasattr(music_app, "_create_flask_app")
    assert not hasattr(music_app, "create_asgi_app_for_bridge")


def test_legacy_library_settings_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_library_settings_routes") is None


def test_legacy_album_note_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_album_note_routes") is None


def test_legacy_album_opinion_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_album_opinion_routes") is None


def test_legacy_playlist_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_playlist_routes") is None


def test_legacy_resource_page_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_resource_page_routes") is None


def test_legacy_discovery_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_discovery_routes") is None


def test_legacy_virtual_artist_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_virtual_artist_routes") is None


def test_legacy_track_preferences_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_track_preferences_routes") is None


def test_legacy_move_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_move_routes") is None


def test_legacy_utility_read_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_utility_read_routes") is None


def test_legacy_rules_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_rules_routes") is None


def test_legacy_edit_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_edit_routes") is None


def test_legacy_cover_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_cover_routes") is None


def test_legacy_loop_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_loop_routes") is None


def test_legacy_playback_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_playback_routes") is None


def test_legacy_read_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_read_routes") is None


def test_legacy_api_blueprint_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api") is None


def test_legacy_web_route_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.web") is None


def test_legacy_api_transport_helper_module_is_removed():
    assert importlib.util.find_spec("music_app.routes.api_transport_helpers") is None


def test_shared_pytest_conftest_does_not_export_flask_app_or_client_fixtures():
    from tests.py import conftest

    assert not hasattr(conftest, "app")
    assert not hasattr(conftest, "client")


def test_app_entrypoint_exports_fastapi_app(monkeypatch):
    import importlib
    import sys

    from fastapi import FastAPI

    sys.modules.pop("app", None)
    entrypoint = importlib.import_module("app")

    assert isinstance(entrypoint.app, FastAPI)


def test_create_asgi_app_lifespan_starts_retry_worker_and_shutdown(monkeypatch):
    from music_app import create_asgi_app
    from music_app.services import lastfm_retry, runtime_shutdown, state

    calls: list[tuple[str, object]] = []
    monkeypatch.setattr(
        state,
        "hydrate_runtime_library_state_on_startup",
        lambda app: calls.append(("hydrate", app)) or True,
    )
    monkeypatch.setattr(
        lastfm_retry,
        "start_lastfm_retry_worker",
        lambda app: calls.append(("startup", app)),
    )
    monkeypatch.setattr(
        lastfm_retry,
        "stop_lastfm_retry_worker",
        lambda app: calls.append(("stop", app)) or True,
    )
    monkeypatch.setattr(
        runtime_shutdown,
        "request_runtime_shutdown",
        lambda app: calls.append(("shutdown", app)) or True,
    )

    asgi_app = create_asgi_app()
    assert not hasattr(asgi_app.state, "flask_app")

    assert calls == []

    messages = _run_asgi_lifespan(asgi_app)

    assert messages == [
        {"type": "lifespan.startup.complete"},
        {"type": "lifespan.shutdown.complete"},
    ]
    assert [name for name, _runtime in calls] == ["hydrate", "startup", "stop", "shutdown"]
    for _name, runtime in calls:
        assert runtime.config is asgi_app.state.config
        assert runtime.logger is asgi_app.state.logger
        assert runtime.library_state is asgi_app.state.library_state


def test_create_asgi_app_lifespan_gates_startup_on_relation_projection_readiness(monkeypatch):
    from music_app import create_asgi_app
    from music_app.services import lastfm_retry, runtime_shutdown, state

    calls = []
    monkeypatch.setattr(
        state,
        "hydrate_runtime_library_state_on_startup",
        lambda _runtime: calls.append("hydrate") or True,
    )
    monkeypatch.setattr(
        state,
        "ensure_runtime_relation_projection_ready",
        lambda _runtime: calls.append("relations") or {"ready": True},
    )
    monkeypatch.setattr(
        lastfm_retry,
        "start_lastfm_retry_worker",
        lambda _runtime: calls.append("lastfm"),
    )
    monkeypatch.setattr(lastfm_retry, "stop_lastfm_retry_worker", lambda _runtime: None)
    monkeypatch.setattr(runtime_shutdown, "request_runtime_shutdown", lambda _runtime: None)

    assert _run_asgi_lifespan(create_asgi_app())[0] == {"type": "lifespan.startup.complete"}
    assert calls == ["hydrate", "relations", "lastfm"]


def test_create_asgi_app_lifespan_fails_before_retry_start_when_relation_projection_fails(monkeypatch):
    from music_app import create_asgi_app
    from music_app.services import lastfm_retry, state

    monkeypatch.setattr(state, "hydrate_runtime_library_state_on_startup", lambda _runtime: True)
    monkeypatch.setattr(
        state,
        "ensure_runtime_relation_projection_ready",
        lambda _runtime: (_ for _ in ()).throw(RuntimeError("projection failed")),
    )
    retry_calls = []
    monkeypatch.setattr(
        lastfm_retry,
        "start_lastfm_retry_worker",
        lambda _runtime: retry_calls.append("started"),
    )

    with pytest.raises(RuntimeError, match="projection failed"):
        _run_asgi_lifespan(create_asgi_app())

    assert retry_calls == []


def test_create_asgi_app_lifespan_marks_empty_startup_scan_pending_without_starting_it(monkeypatch):
    from music_app import create_asgi_app
    from music_app.services import lastfm_retry, runtime_shutdown, state

    calls = []
    monkeypatch.setattr(
        state,
        "hydrate_runtime_library_state_on_startup",
        lambda app: calls.append(("hydrate", app)) or False,
    )
    monkeypatch.setattr(
        state,
        "start_background_refresh_for_state",
        lambda library_state, config, logger, *, force=False, scan_mode="background": calls.append(
            ("scan", library_state, config, logger, force, scan_mode)
        ),
    )
    monkeypatch.setattr(lastfm_retry, "start_lastfm_retry_worker", lambda app: calls.append(("start", app)))
    monkeypatch.setattr(lastfm_retry, "stop_lastfm_retry_worker", lambda app: calls.append(("stop", app)))
    monkeypatch.setattr(runtime_shutdown, "request_runtime_shutdown", lambda app: calls.append(("shutdown", app)))

    asgi_app = create_asgi_app()

    assert _run_asgi_lifespan(asgi_app) == [
        {"type": "lifespan.startup.complete"},
        {"type": "lifespan.shutdown.complete"},
    ]
    assert [call[0] for call in calls] == ["hydrate", "start", "stop", "shutdown"]
    assert asgi_app.state.library_state["cold_scan_pending"] is True
    assert asgi_app.state.library_state["cold_scan_handoff_status"] == "pending"


@pytest.mark.parametrize(
    ("repair_required", "expected_scan_calls"),
    [
        (True, [(True, "background")]),
        (False, []),
    ],
)
def test_create_asgi_app_lifespan_schedules_only_incomplete_hydrated_metadata_repair(
    monkeypatch,
    repair_required,
    expected_scan_calls,
):
    from music_app import create_asgi_app
    from music_app.services import lastfm_retry, runtime_shutdown, state

    def hydrate(runtime):
        runtime.library_state["file_cache"] = {
            "C:/Generated/Artist/Album/song.mp3": {
                "path": "C:/Generated/Artist/Album/song.mp3",
                "metadata_schema_version": (
                    None if repair_required else FILE_METADATA_SCHEMA_VERSION
                ),
            }
        }
        runtime.library_state["albums"] = [object()]
        runtime.library_state["scan_metadata_repair_required"] = repair_required
        return True

    scan_calls = []
    monkeypatch.setattr(state, "hydrate_runtime_library_state_on_startup", hydrate)
    monkeypatch.setattr(
        state,
        "ensure_runtime_relation_projection_ready",
        lambda _runtime: {"ready": True},
    )
    monkeypatch.setattr(
        state,
        "start_background_refresh_for_state",
        lambda _library_state, _config, _logger, *, force=False, scan_mode="background": scan_calls.append(
            (force, scan_mode)
        ),
    )
    monkeypatch.setattr(lastfm_retry, "start_lastfm_retry_worker", lambda _runtime: None)
    monkeypatch.setattr(lastfm_retry, "stop_lastfm_retry_worker", lambda _runtime: None)
    monkeypatch.setattr(runtime_shutdown, "request_runtime_shutdown", lambda _runtime: None)

    assert _run_asgi_lifespan(create_asgi_app()) == [
        {"type": "lifespan.startup.complete"},
        {"type": "lifespan.shutdown.complete"},
    ]
    assert scan_calls == expected_scan_calls


def test_empty_postgres_startup_submits_one_scan_and_keeps_root_and_status_available(monkeypatch):
    from config import Config
    from music_app import create_asgi_app
    from music_app.routes import web_asgi
    from music_app.services import lastfm_retry, runtime_shutdown, state
    from music_app.services.library_roots import normalize_persisted_library_root_settings

    class MissingSnapshotAdapter:
        backend = "postgres"

        @staticmethod
        def load_snapshot_strict(_cache_path, _root_identity):
            return {}, 0.0, {}, 0.0, None

    class FakePsycopg:
        @staticmethod
        def connect(*_args, **_kwargs):
            raise AssertionError("empty Postgres startup test must not open a database connection")

    class FakePostgresLibraryRootSettingsStore:
        def __init__(self, config):
            self._config = config

        def load_settings(self):
            return normalize_persisted_library_root_settings(
                {
                    "main_library_roots": [
                        {
                            "id": "startup-main",
                            "path": str(Path(self._config["MUSIC_DIR"]).expanduser().resolve(strict=False)),
                            "layout_mode": "artist",
                        }
                    ]
                }
            )

    submissions = []
    monkeypatch.setattr(
        Config,
        "ALBUM_HAVEN_APP_DATABASE_URL",
        "postgresql://album_haven_app@localhost/app",
    )
    monkeypatch.setattr("music_app.services.library_roots_postgres.psycopg", FakePsycopg())
    monkeypatch.setattr(
        "music_app.services.library_roots.PostgresLibraryRootSettingsStore",
        FakePostgresLibraryRootSettingsStore,
    )
    monkeypatch.setattr(state, "select_scan_cache_adapter", lambda _config: MissingSnapshotAdapter())
    monkeypatch.setattr(state, "load_exception_overrides", lambda _config: {})
    monkeypatch.setattr(
        "music_app.services.tag_edit_recovery.reconcile_unfinished_tag_edit_intents_on_startup",
        lambda _runtime: {
            "completed": 0,
            "rolled_back": 0,
            "reconciled_external": 0,
            "failed": 0,
        },
    )
    monkeypatch.setattr(
        state._SCAN_EXECUTOR,
        "submit",
        lambda function, *args, **kwargs: submissions.append((function, args, kwargs)),
    )
    monkeypatch.setattr(lastfm_retry, "start_lastfm_retry_worker", lambda _app: None)
    monkeypatch.setattr(lastfm_retry, "stop_lastfm_retry_worker", lambda _app: None)
    monkeypatch.setattr(runtime_shutdown, "request_runtime_shutdown", lambda _app: None)
    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)
    monkeypatch.setattr(
        web_asgi,
        "PostgresLibraryBrowseRepository",
        lambda _config: types.SimpleNamespace(
            build_root_sidebar_payload=lambda **_kwargs: {
                "artists_sidebar": [],
                "artist_count": 0,
                "album_count": 0,
                "selected_artist": "",
                "payload_tier": "sidebar",
                "gallery_display_mode": "covers",
            },
        ),
    )

    asgi_app = create_asgi_app()

    assert _run_asgi_lifespan(asgi_app) == [
        {"type": "lifespan.startup.complete"},
        {"type": "lifespan.shutdown.complete"},
    ]
    assert submissions == []
    assert asgi_app.state.library_state["cold_scan_pending"] is True
    root_status, _root_headers, root_body = _run_asgi_http_get(asgi_app, "/")
    status_status, _status_headers, status_body = _run_asgi_http_get(asgi_app, "/status")

    assert root_status == 200
    assert b"window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__" in root_body
    assert b'"scanInProgress": true' in root_body
    assert b'"scanPhase": "discovering"' in root_body
    assert status_status == 200
    assert json.loads(status_body)["scan_in_progress"] is True
    assert len(submissions) == 1
    submitted_function, submitted_args, submitted_kwargs = submissions[0]
    assert submitted_function is state._refresh_library_worker
    assert submitted_args == (
        asgi_app.state.library_state,
        asgi_app.state.config,
        asgi_app.state.logger,
        False,
    )
    assert submitted_kwargs == {}


@pytest.mark.parametrize(
    ("hydrated", "state_patch"),
    [
        (True, {}),
        (False, {"albums": [{"key": "persisted-album"}]}),
        (False, {"file_cache": {"D:/Music/track.flac": {"title": "Track"}}}),
        (False, {"scan_in_progress": True, "scan_phase": "reading", "scan_mode": "background"}),
        (False, {"last_error": "Postgres startup inventory failed"}),
    ],
    ids=[
        "durable-inventory-hydrated",
        "runtime-albums-nonempty",
        "runtime-file-cache-nonempty",
        "scan-already-active",
        "startup-failure-visible",
    ],
)
def test_create_asgi_app_lifespan_does_not_start_duplicate_or_masked_scan(
    monkeypatch,
    hydrated,
    state_patch,
):
    from music_app import create_asgi_app
    from music_app.services import lastfm_retry, runtime_shutdown, state

    scan_calls = []

    def hydrate(runtime):
        runtime.library_state.update(state_patch)
        return hydrated

    monkeypatch.setattr(state, "hydrate_runtime_library_state_on_startup", hydrate)
    monkeypatch.setattr(
        state,
        "start_background_refresh_for_state",
        lambda *args, **kwargs: scan_calls.append((args, kwargs)),
    )
    monkeypatch.setattr(lastfm_retry, "start_lastfm_retry_worker", lambda _app: None)
    monkeypatch.setattr(lastfm_retry, "stop_lastfm_retry_worker", lambda _app: None)
    monkeypatch.setattr(runtime_shutdown, "request_runtime_shutdown", lambda _app: None)

    asgi_app = create_asgi_app()

    assert _run_asgi_lifespan(asgi_app) == [
        {"type": "lifespan.startup.complete"},
        {"type": "lifespan.shutdown.complete"},
    ]
    assert scan_calls == []
    for key, value in state_patch.items():
        assert asgi_app.state.library_state[key] == value


def test_create_asgi_app_lifespan_propagates_startup_hydration_exception(monkeypatch):
    from music_app import create_asgi_app
    from music_app.services import lastfm_retry, state

    failure = RuntimeError("strict Postgres query failed")
    retry_calls = []
    scan_calls = []

    def fail_hydration(_app):
        raise failure

    monkeypatch.setattr(state, "hydrate_runtime_library_state_on_startup", fail_hydration)
    monkeypatch.setattr(
        state,
        "start_background_refresh_for_state",
        lambda *args, **kwargs: scan_calls.append((args, kwargs)),
    )
    monkeypatch.setattr(lastfm_retry, "start_lastfm_retry_worker", lambda app: retry_calls.append(app))

    asgi_app = create_asgi_app()

    with pytest.raises(RuntimeError) as raised:
        _run_asgi_lifespan(asgi_app)

    assert raised.value is failure
    assert retry_calls == []
    assert scan_calls == []


def test_lastfm_retry_worker_stops_on_request(app, monkeypatch):
    from music_app.services import lastfm_retry

    attempts = 0
    attempted = threading.Event()

    def fake_retry(_config):
        nonlocal attempts
        attempts += 1
        attempted.set()
        return {
            "pending_before": 0,
            "attempted": 0,
            "succeeded": 0,
            "failed": 0,
            "pending_after": 0,
        }

    monkeypatch.setattr(lastfm_retry, "_RETRY_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(lastfm_retry, "retry_pending_lastfm_scrobbles", fake_retry)
    app.config["TESTING"] = False

    try:
        lastfm_retry.start_lastfm_retry_worker(app)
        assert attempted.wait(timeout=1)

        assert lastfm_retry.stop_lastfm_retry_worker(app, wait=True, timeout=1) is True
        assert lastfm_retry._WORKER_THREAD is None
        assert attempts >= 1
    finally:
        lastfm_retry.stop_lastfm_retry_worker(wait=True, timeout=1)


def test_lastfm_retry_worker_restarts_after_signal_only_stop(app, monkeypatch):
    from music_app.services import lastfm_retry

    attempts = 0
    attempted = threading.Event()

    def fake_retry(_config):
        nonlocal attempts
        attempts += 1
        attempted.set()
        return {
            "pending_before": 0,
            "attempted": 0,
            "succeeded": 0,
            "failed": 0,
            "pending_after": 0,
        }

    monkeypatch.setattr(lastfm_retry, "_RETRY_INTERVAL_SECONDS", 1)
    monkeypatch.setattr(lastfm_retry, "retry_pending_lastfm_scrobbles", fake_retry)
    app.config["TESTING"] = False

    try:
        lastfm_retry.start_lastfm_retry_worker(app)
        assert attempted.wait(timeout=1)
        first_thread = lastfm_retry._WORKER_THREAD

        assert lastfm_retry.stop_lastfm_retry_worker(app) is True
        attempted.clear()
        lastfm_retry.start_lastfm_retry_worker(app)

        assert attempted.wait(timeout=1)
        assert lastfm_retry._WORKER_THREAD is not first_thread
        assert attempts >= 2
    finally:
        lastfm_retry.stop_lastfm_retry_worker(wait=True, timeout=1)


def test_lastfm_retry_worker_pass_uses_captured_config_without_app_context(app, monkeypatch):
    from music_app.services import lastfm_retry

    class OnePassStopEvent:
        def __init__(self) -> None:
            self.stopped = False
            self.waited_interval: float | None = None

        def is_set(self) -> bool:
            return self.stopped

        def set(self) -> None:
            self.stopped = True

        def wait(self, interval: float) -> bool:
            self.waited_interval = interval
            self.stopped = True
            return True

    class SynchronousThread:
        def __init__(self, *, target, name: str, daemon: bool) -> None:
            self.target = target
            self.name = name
            self.daemon = daemon
            self.started = False

        def is_alive(self) -> bool:
            return False

        def start(self) -> None:
            self.started = True
            self.target()

        def join(self, timeout: float | None = None) -> None:
            return None

    retry_calls: list[object] = []
    log_calls: list[dict[str, object]] = []
    threads: list[SynchronousThread] = []
    stop_event = OnePassStopEvent()

    def fake_retry(config):
        retry_calls.append(config)
        return {
            "pending_before": 1,
            "attempted": 1,
            "succeeded": 1,
            "failed": 0,
            "pending_after": 0,
        }

    def fake_log_app_event(config, logger, action, **kwargs):
        log_calls.append({
            "config": config,
            "logger": logger,
            "action": action,
            **kwargs,
        })

    def make_thread(*, target, name: str, daemon: bool) -> SynchronousThread:
        thread = SynchronousThread(target=target, name=name, daemon=daemon)
        threads.append(thread)
        return thread

    monkeypatch.setattr(lastfm_retry.threading, "Event", lambda: stop_event)
    monkeypatch.setattr(lastfm_retry.threading, "Thread", make_thread)
    monkeypatch.setattr(lastfm_retry, "_RETRY_INTERVAL_SECONDS", 12.5)
    monkeypatch.setattr(lastfm_retry, "retry_pending_lastfm_scrobbles", fake_retry)
    monkeypatch.setattr(lastfm_retry, "log_app_event", fake_log_app_event)
    app.config["TESTING"] = False
    guarded_app = _FatalFlaskContextAccess(app)

    try:
        lastfm_retry.start_lastfm_retry_worker(guarded_app)
    finally:
        lastfm_retry.stop_lastfm_retry_worker(guarded_app, wait=True, timeout=1)

    assert retry_calls == [app.config]
    assert log_calls == [
        {
            "config": app.config,
            "logger": app.logger,
            "action": "Last.fm retry pass completed",
            "attempted": 1,
            "succeeded": 1,
            "failed": 0,
            "pending_after": 0,
        }
    ]
    assert stop_event.waited_interval == 12.5
    assert threads[0].name == "albumhaven-lastfm-retry"
    assert threads[0].daemon is True


def test_lastfm_retry_worker_exception_logging_uses_captured_config_without_app_context(app, monkeypatch):
    from music_app.services import lastfm_retry

    class OnePassStopEvent:
        def __init__(self) -> None:
            self.stopped = False

        def is_set(self) -> bool:
            return self.stopped

        def set(self) -> None:
            self.stopped = True

        def wait(self, _interval: float) -> bool:
            self.stopped = True
            return True

    class SynchronousThread:
        def __init__(self, *, target, name: str, daemon: bool) -> None:
            self.target = target
            self.name = name
            self.daemon = daemon

        def is_alive(self) -> bool:
            return False

        def start(self) -> None:
            self.target()

        def join(self, timeout: float | None = None) -> None:
            return None

    log_calls: list[dict[str, object]] = []

    def fail_retry(_config):
        raise RuntimeError("retry exploded")

    def fake_log_app_event(config, logger, action, **kwargs):
        log_calls.append({
            "config": config,
            "logger": logger,
            "action": action,
            **kwargs,
        })

    monkeypatch.setattr(lastfm_retry.threading, "Event", OnePassStopEvent)
    monkeypatch.setattr(lastfm_retry.threading, "Thread", SynchronousThread)
    monkeypatch.setattr(lastfm_retry, "retry_pending_lastfm_scrobbles", fail_retry)
    monkeypatch.setattr(lastfm_retry, "log_app_event", fake_log_app_event)
    app.config["TESTING"] = False
    guarded_app = _FatalFlaskContextAccess(app)

    try:
        lastfm_retry.start_lastfm_retry_worker(guarded_app)
    finally:
        lastfm_retry.stop_lastfm_retry_worker(guarded_app, wait=True, timeout=1)

    assert log_calls == [
        {
            "config": app.config,
            "logger": app.logger,
            "action": "Last.fm retry worker failed",
            "level": "error",
            "error": "retry exploded",
        }
    ]


def test_create_asgi_app_serves_status_without_http_flask_bridge():
    from music_app import create_asgi_app

    asgi_app = create_asgi_app()
    route_paths = _collect_route_paths(asgi_app)

    status, headers, body = _run_asgi_http_get(asgi_app, "/status")
    docs_status, _docs_headers, _docs_body = _run_asgi_http_get(asgi_app, "/docs")
    openapi_status, _openapi_headers, _openapi_body = _run_asgi_http_get(
        asgi_app, "/openapi.json"
    )

    assert "/status" in route_paths
    assert status == 200
    assert docs_status == 404
    assert openapi_status == 404
    assert headers["content-type"].startswith("application/json")
    payload = json.loads(body)
    assert payload["scan_in_progress"] is False
    assert payload["scan_phase"] == "idle"


def test_route_collection_walks_router_and_nested_mount_shapes():
    nested_route = types.SimpleNamespace(path="/status")
    nested_mount = types.SimpleNamespace(path="/api", app=types.SimpleNamespace(routes=[nested_route]))
    synthetic_app = types.SimpleNamespace(router=types.SimpleNamespace(routes=[nested_mount]))

    assert _collect_route_paths(synthetic_app) == ["/api", "/api/status"]


def test_route_method_collection_uses_prefixed_nested_paths():
    nested_route = types.SimpleNamespace(path="/status", methods={"GET"})
    nested_mount = types.SimpleNamespace(path="/api", app=types.SimpleNamespace(routes=[nested_route]))
    synthetic_app = types.SimpleNamespace(router=types.SimpleNamespace(routes=[nested_mount]))

    assert _collect_route_methods(synthetic_app) == {"/api/status": {"GET"}}
