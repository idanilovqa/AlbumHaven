from __future__ import annotations

import ast
import asyncio
import importlib.util
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
import runpy
import subprocess
import sys
import threading
import types
from uuid import UUID

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
@pytest.fixture(autouse=True)
def _stub_relation_projection_startup(monkeypatch):
    from music_app.services import (
        exception_overrides,
        library_roots,
        scan_cache_persistence,
        state,
    )

    class _TargetedRepositoryStub:
        backend = "postgres"

    def ensure_ready(runtime, **_kwargs):
        runtime.library_state["relation_projection_ready"] = True
        runtime.library_state["relation_projection_rebuild_reason"] = "healthy"
        return {"ready": True, "relation_views": runtime.library_state.get("relation_views", {})}

    monkeypatch.setattr(state, "ensure_runtime_relation_projection_ready", ensure_ready)
    monkeypatch.setattr(state, "recover_runtime_library_persistence_on_startup", lambda _runtime: None)
    monkeypatch.setattr(
        scan_cache_persistence,
        "select_scan_cache_adapter",
        lambda _config: _TargetedRepositoryStub(),
    )
    monkeypatch.setattr(
        library_roots,
        "get_library_roots",
        lambda config: [{
            "id": "app-factory-root",
            "path": str(config["MUSIC_DIR"]),
            "layout_mode": "artist",
            "category": "main_library",
        }],
    )
    monkeypatch.setattr(
        exception_overrides,
        "load_exception_overrides",
        lambda _config: {},
    )


@pytest.fixture(autouse=True)
def _preserve_process_global_executors(monkeypatch):
    from music_app.services import runtime_shutdown

    monkeypatch.setattr(runtime_shutdown, "request_runtime_shutdown", lambda _runtime: None)


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
    monkeypatch.setenv("MUSIC_APP_TLS_MODE", "off")
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
    monkeypatch.setenv("MUSIC_APP_TLS_MODE", "off")
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


def test_create_asgi_app_lifespan_hydrates_and_shuts_down(monkeypatch):
    from music_app import create_asgi_app
    from music_app.services import runtime_shutdown, state

    calls: list[tuple[str, object]] = []
    monkeypatch.setattr(
        state,
        "hydrate_runtime_library_state_on_startup",
        lambda app: calls.append(("hydrate", app)) or True,
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
    assert [name for name, _runtime in calls] == ["hydrate", "shutdown"]
    for _name, runtime in calls:
        assert runtime.config is asgi_app.state.config
        assert runtime.logger is asgi_app.state.logger
        assert runtime.library_state is asgi_app.state.library_state


def _watcher_session_lifecycle_harness(
    monkeypatch, *, host_library_id=41, resolve_error=None, session_state=None
):
    import music_app
    from music_app.services import (
        cover_preview_backfill,
        library_event_coordinator,
        library_reconciliation,
        library_roots,
        library_watch_health,
        log_history,
        runtime_shutdown,
        scan_jobs_postgres,
        watcher_recovery_postgres,
        watcher_session_recovery,
    )

    events = []
    callbacks = {}
    failures = {"begin": None, "expand": None, "replace": None, "set": None}
    state = session_state if session_state is not None else {
        "open": False,
        "overflow_occurrences": 0,
        "participants": set(),
    }
    expected_library_id = host_library_id if host_library_id is not None else 52

    class ScanJobs:
        def __init__(self, *, database_url):
            assert database_url == "postgresql://watcher-session-test"

        @staticmethod
        def resolve_local_library_id():
            events.append("library.resolve")
            if resolve_error is not None:
                raise resolve_error
            return 52

    class WatcherRepository:
        def __init__(self, *, database_url):
            assert database_url == "postgresql://watcher-session-test"

        @staticmethod
        def record_problem(**_values):
            return True

    class SessionController:
        def __init__(self, repository):
            assert isinstance(repository, WatcherRepository)
            callbacks["controller"] = self

        def start(
            self, *, library_id, session_token, logical_root_ids, started_at
        ):
            assert library_id == expected_library_id
            assert isinstance(session_token, UUID)
            assert logical_root_ids == ("root-a",)
            assert isinstance(started_at, datetime)
            assert started_at.tzinfo is not None
            assert started_at.utcoffset() == timezone.utc.utcoffset(started_at)
            events.append("session.begin")
            if failures["begin"] is not None:
                raise failures["begin"]
            if state["open"]:
                state["overflow_occurrences"] += 1
            state["open"] = True
            state["participants"] = set(logical_root_ids)
            return ()

        def expand_participants(self, logical_root_ids):
            events.append(("session.expand", logical_root_ids))
            if failures["expand"] is not None:
                raise failures["expand"]
            state["participants"].update(logical_root_ids)

        def set_participants(self, logical_root_ids):
            events.append(("session.set", logical_root_ids))
            if failures["set"] is not None:
                raise failures["set"]
            state["participants"] = set(logical_root_ids)

        def report_admission_failure(self, *, logical_root_ids):
            assert isinstance(logical_root_ids, tuple)
            assert all(isinstance(root_id, str) for root_id in logical_root_ids)
            events.append(("session.report", logical_root_ids))
            callbacks.setdefault("reporters", []).append(id(self))

        def stop_retry_and_flush(self, *, deadline):
            assert isinstance(deadline, float)
            events.append("retry.cancel_join_flush")

        def finish(self):
            events.append("session.finish")
            state["open"] = False
            state["participants"] = set()
            return True

    class Coordinator:
        def __init__(
            self,
            _accept_event,
            *,
            record_problem,
            report_admission_failure=None,
        ):
            assert callable(record_problem)
            callbacks["coordinator"] = report_admission_failure
            events.append("coordinator.construct")

        @staticmethod
        def accept(_event):
            return True

        def stop(self):
            events.append("coordinator.stop")
            return True

    class Source:
        def __init__(self, _roots, *, report_unattributed_failure=None):
            callbacks["source"] = report_unattributed_failure
            events.append("source.construct")

    class WatchService:
        def __init__(self, _source, _publish):
            callbacks["watch"] = self
            self.root_ids = ("root-a",)

        def start(self):
            events.append("watch.start")
            return True

        def stop(self, *, timeout=None):
            events.append("watch.stop")
            return True

        def replace_roots(self, roots):
            events.append(
                ("watch.replace", tuple(root["id"] for root in roots))
            )
            if failures["replace"] is not None:
                raise failures["replace"]
            self.root_ids = tuple(root["id"] for root in roots)
            return True

    monkeypatch.setattr(
        library_watch_health,
        "LibraryWatchHealthService",
        lambda _store: types.SimpleNamespace(
            uses_durable_repository=lambda _repository, _library_id: True
        ),
    )
    monkeypatch.setattr(
        cover_preview_backfill,
        "CoverPreviewBackfill",
        lambda *_args, **_kwargs: types.SimpleNamespace(
            start=lambda: True, stop=lambda: True
        ),
    )
    monkeypatch.setattr(scan_jobs_postgres, "PostgresScanJobRepository", ScanJobs)
    monkeypatch.setattr(
        watcher_recovery_postgres,
        "PostgresWatcherRecoveryRepository",
        WatcherRepository,
    )
    monkeypatch.setattr(
        watcher_session_recovery,
        "WatcherSessionRecoveryController",
        SessionController,
    )
    monkeypatch.setattr(library_event_coordinator, "LibraryEventCoordinator", Coordinator)
    monkeypatch.setattr(library_reconciliation, "LibraryWatchService", WatchService)
    monkeypatch.setattr(library_reconciliation, "WatchdogLibraryEventSource", Source)
    monkeypatch.setattr(
        library_roots,
        "get_library_roots",
        lambda _config: ({"id": "root-a", "path": "C:/Music"},),
    )
    monkeypatch.setattr(
        log_history,
        "resolve_media_host_history_scope",
        lambda _config: (
            None
            if host_library_id is None
            else types.SimpleNamespace(library_id=host_library_id)
        ),
    )
    monkeypatch.setattr(music_app, "_start_library_warmup", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runtime_shutdown, "request_runtime_shutdown", lambda _runtime: None)

    app = music_app.create_asgi_app()
    app.state.config["ALBUM_HAVEN_APP_DATABASE_URL"] = (
        "postgresql://watcher-session-test"
    )
    return types.SimpleNamespace(
        app=app,
        callbacks=callbacks,
        events=events,
        failures=failures,
        state=state,
    )


def test_watcher_session_startup_resolves_library_then_wires_one_controller(
    monkeypatch,
):
    harness = _watcher_session_lifecycle_harness(monkeypatch, host_library_id=None)

    async def exercise():
        async with harness.app.router.lifespan_context(harness.app):
            assert harness.events == [
                "library.resolve",
                "session.begin",
                "coordinator.construct",
                "source.construct",
                "watch.start",
            ]
            assert callable(harness.callbacks["coordinator"])
            assert callable(harness.callbacks["source"])
            harness.callbacks["coordinator"](("root-a",))
            harness.callbacks["source"](("root-a", "root-b"))
            assert harness.events[-2:] == [
                ("session.report", ("root-a",)),
                ("session.report", ("root-a", "root-b")),
            ]
            assert harness.callbacks["reporters"] == [
                id(harness.callbacks["controller"]),
                id(harness.callbacks["controller"]),
            ]

    asyncio.run(exercise())

    assert harness.events[-4:] == [
        "watch.stop",
        "retry.cancel_join_flush",
        "session.finish",
        "coordinator.stop",
    ]


@pytest.mark.parametrize("failed_stage", ("library-resolution", "session-begin"))
def test_watcher_session_startup_failure_prevents_runtime_construction(
    monkeypatch, failed_stage
):
    failure = RuntimeError(f"{failed_stage} unavailable")
    if failed_stage == "library-resolution":
        harness = _watcher_session_lifecycle_harness(
            monkeypatch, host_library_id=None, resolve_error=failure
        )
        expected_events = ["library.resolve"]
    else:
        harness = _watcher_session_lifecycle_harness(monkeypatch)
        harness.failures["begin"] = failure
        expected_events = ["session.begin"]

    async def exercise():
        with pytest.raises(RuntimeError, match=f"{failed_stage} unavailable"):
            async with harness.app.router.lifespan_context(harness.app):
                raise AssertionError("failed watcher startup must not yield")

    asyncio.run(exercise())
    assert harness.events == expected_events


def test_watcher_session_clean_shutdown_prevents_recovery_on_next_start(monkeypatch):
    state = {"open": False, "overflow_occurrences": 0, "participants": set()}

    for _ in range(2):
        harness = _watcher_session_lifecycle_harness(
            monkeypatch, session_state=state
        )

        async def exercise():
            async with harness.app.router.lifespan_context(harness.app):
                pass

        asyncio.run(exercise())
        assert harness.events.count("session.begin") == 1
        assert harness.events.count("session.finish") == 1

    assert state == {"open": False, "overflow_occurrences": 0, "participants": set()}


@pytest.mark.parametrize("stale_token", (False, True), ids=("storage", "stale-token"))
def test_watcher_session_expand_failure_leaves_existing_observer_running(
    monkeypatch, stale_token
):
    from music_app.services.watcher_recovery_postgres import (
        WatcherSessionReplacedError,
    )

    harness = _watcher_session_lifecycle_harness(monkeypatch)
    error_type = WatcherSessionReplacedError if stale_token else RuntimeError
    harness.failures["expand"] = error_type("session expansion unavailable")

    async def exercise():
        async with harness.app.router.lifespan_context(harness.app):
            harness.events.clear()
            with pytest.raises(error_type, match="session expansion unavailable"):
                harness.app.state.replace_library_watch_roots(
                    ({"id": "root-b", "path": "D:/Music"},)
                )
            assert harness.events == [("session.expand", ("root-b",))]
            assert harness.state["participants"] == {"root-a"}

    asyncio.run(exercise())


def test_watcher_session_replacement_failures_retain_union_until_successful_set(
    monkeypatch,
):
    harness = _watcher_session_lifecycle_harness(monkeypatch)

    async def exercise():
        async with harness.app.router.lifespan_context(harness.app):
            harness.events.clear()
            harness.failures["set"] = RuntimeError("session set unavailable")
            with pytest.raises(RuntimeError, match="session set unavailable"):
                harness.app.state.replace_library_watch_roots(
                    ({"id": "root-b", "path": "D:/Music"},)
                )
            assert harness.events[-1] == (
                "session.report",
                ("root-a", "root-b"),
            )
            assert harness.state["participants"] == {"root-a", "root-b"}

            harness.events.clear()
            harness.failures["set"] = None
            harness.failures["replace"] = RuntimeError(
                "watch replace unavailable"
            )
            with pytest.raises(RuntimeError, match="watch replace unavailable"):
                harness.app.state.replace_library_watch_roots(
                    ({"id": "root-c", "path": "E:/Music"},)
                )
            assert harness.events[-1] == (
                "session.report",
                ("root-b", "root-c"),
            )
            assert harness.state["participants"] == {"root-a", "root-b", "root-c"}

            harness.events.clear()
            harness.failures["replace"] = None
            harness.app.state.replace_library_watch_roots(
                ({"id": "root-c", "path": "E:/Music"},)
            )
            assert harness.events == [
                ("session.expand", ("root-c",)),
                ("watch.replace", ("root-c",)),
                ("session.set", ("root-c",)),
            ]
            assert harness.state["participants"] == {"root-c"}

    asyncio.run(exercise())


def test_watcher_session_concurrent_replacements_serialize_complete_transition(
    monkeypatch,
):
    harness = _watcher_session_lifecycle_harness(monkeypatch)
    first_entered = threading.Event()
    release_first = threading.Event()
    second_started = threading.Event()
    second_completed = threading.Event()
    errors = []

    async def exercise():
        async with harness.app.router.lifespan_context(harness.app):
            harness.events.clear()
            watch = harness.callbacks["watch"]
            replace_roots = watch.replace_roots

            def blocked_replace(roots):
                if roots[0]["id"] == "root-b":
                    first_entered.set()
                    assert release_first.wait(5), "first replacement was not released"
                return replace_roots(roots)

            monkeypatch.setattr(watch, "replace_roots", blocked_replace)

            def replace(root_id, *, second=False):
                if second:
                    second_started.set()
                try:
                    harness.app.state.replace_library_watch_roots(
                        ({"id": root_id, "path": f"C:/Music/{root_id}"},)
                    )
                except BaseException as exc:
                    errors.append(exc)
                finally:
                    if second:
                        second_completed.set()

            first = threading.Thread(target=replace, args=("root-b",))
            second = threading.Thread(
                target=replace, args=("root-c",), kwargs={"second": True}
            )
            first.start()
            try:
                assert first_entered.wait(5), "first replacement did not enter observer"
                second.start()
                assert second_started.wait(5), "second replacement did not start"
                assert not second_completed.wait(0.1), "replacement interleaved"
                assert harness.events == [("session.expand", ("root-b",))]
            finally:
                release_first.set()
                first.join(5)
                if second.ident is not None:
                    second.join(5)
                assert not first.is_alive()
                assert not second.is_alive()

            assert errors == []
            assert harness.events == [
                ("session.expand", ("root-b",)),
                ("watch.replace", ("root-b",)),
                ("session.set", ("root-b",)),
                ("session.expand", ("root-c",)),
                ("watch.replace", ("root-c",)),
                ("session.set", ("root-c",)),
            ]
            assert watch.root_ids == ("root-c",)
            assert harness.state["participants"] == {"root-c"}

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "failed_stage",
    (
        "observer-stop",
        "callback-cancel",
        "callback-join",
        "final-flush",
        "session-finish",
        "session-finish-false",
    ),
)
def test_watcher_session_shutdown_failure_surfaces_and_leaves_session_open(
    failed_stage, monkeypatch,
):
    import time
    from music_app import _stop_library_watch_runtime

    monkeypatch.setattr(time, "monotonic", lambda: 120.0)
    calls = []

    def stop_watch(*, timeout=None):
        calls.append("watch.stop")
        if failed_stage == "observer-stop":
            raise RuntimeError(failed_stage)

    stop_failures = {"callback-cancel", "callback-join", "final-flush"}
    flush_label = (
        f"retry.cancel_join_flush:{failed_stage}"
        if failed_stage in stop_failures
        else "retry.cancel_join_flush"
    )

    def stop_retry_and_flush(*, deadline):
        assert deadline == 123.0
        calls.append(flush_label)
        if failed_stage in stop_failures:
            raise RuntimeError(failed_stage)

    def finish():
        calls.append("session.finish")
        if failed_stage == "session-finish":
            raise RuntimeError(failed_stage)
        return failed_stage != "session-finish-false"

    with pytest.raises(
        RuntimeError,
        match=("finish" if failed_stage == "session-finish-false" else failed_stage),
    ):
        _stop_library_watch_runtime(
            watch_service=types.SimpleNamespace(stop=stop_watch),
            watcher_session_controller=types.SimpleNamespace(
                stop_retry_and_flush=stop_retry_and_flush,
                finish=finish,
            ),
            event_coordinator=types.SimpleNamespace(
                stop=lambda: calls.append("coordinator.stop")
            ),
            deadline=123.0,
        )

    expected = ["watch.stop"]
    if failed_stage != "observer-stop":
        expected.append(flush_label)
    if failed_stage.startswith("session-finish"):
        expected.append("session.finish")
    assert calls == expected


@pytest.mark.parametrize("now", (120.0, 124.0))
def test_watcher_session_shutdown_observer_uses_remaining_deadline(monkeypatch, now):
    import time
    from music_app import _stop_library_watch_runtime

    monkeypatch.setattr(time, "monotonic", lambda: now)
    calls = []

    def stop_watch(*, timeout):
        calls.append(("watch.stop", timeout))
        assert timeout == max(0.0, 123.0 - now)
        if timeout == 0:
            raise TimeoutError("observer deadline exhausted")

    def stop_retry_and_flush(*, deadline):
        assert deadline == 123.0
        calls.append("retry.cancel_join_flush")

    def finish():
        calls.append("session.finish")
        return True

    def stop():
        _stop_library_watch_runtime(
            watch_service=types.SimpleNamespace(stop=stop_watch),
            watcher_session_controller=types.SimpleNamespace(
                stop_retry_and_flush=stop_retry_and_flush, finish=finish
            ),
            event_coordinator=types.SimpleNamespace(
                stop=lambda: calls.append("coordinator.stop")
            ),
            deadline=123.0,
        )

    if now > 123.0:
        with pytest.raises(TimeoutError, match="observer deadline exhausted"):
            stop()
        assert calls == [("watch.stop", 0.0)]
    else:
        stop()
        assert calls == [
            ("watch.stop", 3.0),
            "retry.cancel_join_flush",
            "session.finish",
            "coordinator.stop",
        ]


def test_create_asgi_app_lifespan_requests_warmup_stop_before_worker_shutdown(
    monkeypatch,
):
    import music_app
    from music_app.services import runtime_shutdown

    calls = []

    class WarmupHandle:
        def request_stop(self):
            pass

        async def stop(self):
            calls.append("warmup-stop")

    monkeypatch.setattr(
        music_app,
        "_start_library_warmup",
        lambda *_args, **_kwargs: WarmupHandle(),
    )
    monkeypatch.setattr(
        runtime_shutdown,
        "request_runtime_shutdown",
        lambda _runtime: calls.append("runtime-stop"),
    )

    assert _run_asgi_lifespan(music_app.create_asgi_app()) == [
        {"type": "lifespan.startup.complete"},
        {"type": "lifespan.shutdown.complete"},
    ]
    assert calls == ["warmup-stop", "runtime-stop"]


def test_create_asgi_app_lifespan_starts_and_stops_cover_preview_backfill(
    monkeypatch,
):
    import music_app
    from music_app.services import cover_preview_backfill

    calls = []

    class FakeBackfill:
        def __init__(self, config, *, logger):
            calls.append(("create", config, logger))

        def start(self):
            calls.append(("start",))

        def stop(self):
            calls.append(("stop",))

        def note_foreground_activity(self):
            calls.append(("activity",))

    monkeypatch.setattr(
        cover_preview_backfill,
        "CoverPreviewBackfill",
        FakeBackfill,
    )

    asgi_app = music_app.create_asgi_app()
    messages = _run_asgi_lifespan(asgi_app)

    assert messages == [
        {"type": "lifespan.startup.complete"},
        {"type": "lifespan.shutdown.complete"},
    ]
    assert [call[0] for call in calls] == ["create", "start", "stop"]
    assert calls[0][1] is asgi_app.state.config
    assert calls[0][2] is asgi_app.state.logger


def test_dynamic_request_notifies_cover_preview_backfill(monkeypatch):
    import music_app

    asgi_app = music_app.create_asgi_app()
    activities = []
    asgi_app.state.cover_preview_backfill = type(
        "Backfill",
        (),
        {"note_foreground_activity": lambda self: activities.append("activity")},
    )()

    status, _headers, _body = run_asgi_request(asgi_app, "GET", "/status")

    assert status == 200
    assert activities == ["activity"]


def test_library_warmup_stop_during_postgres_prewarm_skips_relation_projection():
    from music_app import _start_library_warmup

    prewarm_started = threading.Event()
    release_prewarm = threading.Event()
    stop_returned = threading.Event()
    stop_errors = []
    relation_calls = []
    existing_thread_ids = {thread.ident for thread in threading.enumerate()}
    runtime = types.SimpleNamespace(
        config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        logger=logging.getLogger("test-library-warmup-stop"),
        library_state={},
    )

    def prewarm(_database_url):
        prewarm_started.set()
        assert release_prewarm.wait(timeout=5)

    handle = _start_library_warmup(
        runtime,
        lambda _runtime: (_ for _ in ()).throw(AssertionError("hydrate must not run")),
        lambda _runtime: relation_calls.append("relations"),
        prewarm,
    )
    assert prewarm_started.wait(timeout=2)
    warmup_thread = next(
        thread
        for thread in threading.enumerate()
        if thread.name == "albumhaven-library-warmup"
        and thread.ident not in existing_thread_ids
    )

    def request_stop():
        try:
            handle.request_stop()
        except BaseException as exc:
            stop_errors.append(exc)
        finally:
            stop_returned.set()

    stop_request = threading.Thread(target=request_stop, daemon=True)
    stop_request.start()
    request_was_nonblocking = stop_returned.wait(timeout=1)
    release_prewarm.set()

    warmup_thread.join(timeout=2)
    stop_request.join(timeout=2)
    assert request_was_nonblocking, "request_stop blocked on the warmup worker"
    assert not warmup_thread.is_alive()
    assert stop_errors == []
    assert relation_calls == []


def test_create_asgi_app_lifespan_starts_when_background_relation_projection_fails(monkeypatch):
    monkeypatch.setattr(
        "music_app.services.state.hydrate_runtime_scan_metadata_on_startup",
        lambda _runtime: None,
    )
    from config import Config
    from music_app import create_asgi_app
    from music_app.services import postgres_connections, state

    monkeypatch.setattr(state, "hydrate_runtime_library_state_on_startup", lambda _runtime: True)
    monkeypatch.setattr(
        state,
        "ensure_runtime_relation_projection_ready",
        lambda _runtime, **_kwargs: (_ for _ in ()).throw(RuntimeError("projection failed")),
    )

    monkeypatch.setattr(
        Config,
        "ALBUM_HAVEN_APP_DATABASE_URL",
        "postgresql://album_haven_app@localhost/app",
    )
    monkeypatch.setattr(
        postgres_connections,
        "prewarm_connection_pool",
        lambda _database_url: None,
    )
    assert _run_asgi_lifespan(create_asgi_app()) == [
        {"type": "lifespan.startup.complete"},
        {"type": "lifespan.shutdown.complete"},
    ]


def test_postgres_lifespan_cancels_relation_projection_warmup_before_shutdown(monkeypatch):
    monkeypatch.setattr(
        "music_app.services.state.hydrate_runtime_scan_metadata_on_startup",
        lambda _runtime: None,
    )
    import music_app
    from config import Config
    from music_app import create_asgi_app
    from music_app.services import postgres_connections, runtime_shutdown, state

    calls = []
    projection_started = threading.Event()
    projection_finished = threading.Event()
    shutdown_requested = threading.Event()
    original_request_stop = music_app._LibraryWarmupHandle.request_stop

    def request_stop(handle):
        shutdown_requested.set()
        original_request_stop(handle)

    def warm_projection(_runtime, *, cancel_requested):
        calls.append("relations")
        projection_started.set()
        try:
            assert cancel_requested.wait(timeout=5)
        finally:
            projection_finished.set()
        raise InterruptedError("relation projection readiness cancelled")

    monkeypatch.setattr(
        Config,
        "ALBUM_HAVEN_APP_DATABASE_URL",
        "postgresql://album_haven_app@localhost/app",
    )
    monkeypatch.setattr(
        state,
        "hydrate_runtime_library_state_on_startup",
        lambda _runtime: calls.append("hydrate") or True,
    )
    monkeypatch.setattr(
        state,
        "ensure_runtime_relation_projection_ready",
        warm_projection,
    )
    monkeypatch.setattr(
        state,
        "start_background_refresh_for_state",
        lambda *_args, **_kwargs: calls.append("scan"),
    )
    monkeypatch.setattr(
        postgres_connections,
        "prewarm_connection_pool",
        lambda database_url: calls.append(("prewarm", database_url)),
        raising=False,
    )
    monkeypatch.setattr(runtime_shutdown, "request_runtime_shutdown", lambda _runtime: None)
    monkeypatch.setattr(music_app._LibraryWarmupHandle, "request_stop", request_stop)

    # This case owns relation-worker cancellation; unrelated cover I/O must
    # not contact the deliberately nonexistent database or delay teardown.
    from music_app.services.cover_preview_backfill import CoverPreviewBackfill
    monkeypatch.setattr(CoverPreviewBackfill, "start", lambda _self: None)
    monkeypatch.setattr(CoverPreviewBackfill, "stop", lambda _self: None)

    asgi_app = create_asgi_app()

    messages = []
    lifespan_finished = threading.Event()

    def run_lifespan():
        try:
            messages.extend(_run_asgi_lifespan(asgi_app))
        finally:
            lifespan_finished.set()

    lifespan_thread = threading.Thread(target=run_lifespan)
    lifespan_thread.start()
    try:
        assert projection_started.wait(timeout=2)
        assert shutdown_requested.wait(timeout=2)
        assert lifespan_finished.wait(timeout=2)
        assert calls == [
            ("prewarm", "postgresql://album_haven_app@localhost/app"),
            "relations",
        ]
        assert asgi_app.state.library_warmup_thread is not None
        assert asgi_app.state.library_warmup_thread.daemon is True
        assert projection_finished.is_set()
    finally:
        lifespan_thread.join(timeout=2)

    assert projection_finished.is_set()
    assert not lifespan_thread.is_alive()
    assert messages == [
        {"type": "lifespan.startup.complete"},
        {"type": "lifespan.shutdown.complete"},
    ]


def test_postgres_lifespan_logs_pool_prewarm_failure_and_continues_relations(
    monkeypatch,
    caplog,
):
    from config import Config
    from music_app import create_asgi_app
    from music_app.services import postgres_connections, runtime_shutdown, state

    monkeypatch.setattr(state, "hydrate_runtime_scan_metadata_on_startup", lambda _runtime: None)
    calls = []
    database_url = "postgresql://album_haven_app@localhost/app"

    def fail_prewarm(url):
        calls.append(("prewarm", url))
        raise RuntimeError("pool unavailable")

    monkeypatch.setattr(Config, "ALBUM_HAVEN_APP_DATABASE_URL", database_url)
    monkeypatch.setattr(
        postgres_connections,
        "prewarm_connection_pool",
        fail_prewarm,
        raising=False,
    )
    monkeypatch.setattr(
        state,
        "hydrate_runtime_library_state_on_startup",
        lambda _runtime: calls.append("hydrate") or True,
    )
    monkeypatch.setattr(
        state,
        "ensure_runtime_relation_projection_ready",
        lambda _runtime, **_kwargs: calls.append("relations"),
    )
    monkeypatch.setattr(
        state,
        "start_background_refresh_for_state",
        lambda *_args, **_kwargs: calls.append("scan"),
    )
    monkeypatch.setattr(runtime_shutdown, "request_runtime_shutdown", lambda _runtime: None)

    with caplog.at_level(logging.ERROR):
        messages = _run_asgi_lifespan(create_asgi_app())

    assert messages == [
        {"type": "lifespan.startup.complete"},
        {"type": "lifespan.shutdown.complete"},
    ]
    assert calls == [("prewarm", database_url), "relations"]
    assert "Postgres connection pool prewarm failed." in caplog.text


def test_create_asgi_app_lifespan_marks_empty_startup_scan_pending_without_starting_it(monkeypatch):
    from music_app import create_asgi_app
    from music_app.services import runtime_shutdown, state

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
    monkeypatch.setattr(runtime_shutdown, "request_runtime_shutdown", lambda app: calls.append(("shutdown", app)))

    asgi_app = create_asgi_app()

    assert _run_asgi_lifespan(asgi_app) == [
        {"type": "lifespan.startup.complete"},
        {"type": "lifespan.shutdown.complete"},
    ]
    assert [call[0] for call in calls] == ["hydrate", "shutdown"]
    assert asgi_app.state.library_state["cold_scan_pending"] is True
    assert asgi_app.state.library_state["cold_scan_handoff_status"] == "pending"


@pytest.mark.parametrize(
    ("repair_required", "expected_pending"),
    [
        (True, True),
        (False, False),
    ],
)
def test_create_asgi_app_lifespan_hands_incomplete_metadata_repair_to_durable_scan(
    monkeypatch,
    repair_required,
    expected_pending,
):
    from music_app import create_asgi_app
    from music_app.services import runtime_shutdown, state

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
        lambda _runtime, **_kwargs: {"ready": True},
    )
    monkeypatch.setattr(
        state,
        "start_background_refresh_for_state",
        lambda _library_state, _config, _logger, *, force=False, scan_mode="background": scan_calls.append(
            (force, scan_mode)
        ),
    )
    monkeypatch.setattr(runtime_shutdown, "request_runtime_shutdown", lambda _runtime: None)

    asgi_app = create_asgi_app()
    assert _run_asgi_lifespan(asgi_app) == [
        {"type": "lifespan.startup.complete"},
        {"type": "lifespan.shutdown.complete"},
    ]
    assert scan_calls == []
    assert asgi_app.state.library_state["cold_scan_pending"] is expected_pending
    assert asgi_app.state.library_state["cold_scan_force"] is expected_pending
    assert asgi_app.state.library_state["cold_scan_is_cold_start"] is not expected_pending
    assert asgi_app.state.library_state["cold_scan_handoff_status"] == (
        "pending" if expected_pending else "idle"
    )


@pytest.mark.parametrize("root_query", [{}, {"surface": "albums"}], ids=["home", "albums"])
def test_empty_postgres_startup_submits_one_scan_and_keeps_root_and_status_available(monkeypatch, root_query):
    from config import Config
    from music_app import create_asgi_app
    from music_app.routes import web_asgi
    from music_app.services import runtime_shutdown, state
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

    durable_enqueues = []

    class FakeScanJobRepository:
        def __init__(self, *, database_url):
            assert database_url == "postgresql://album_haven_app@localhost/app"

        @staticmethod
        def resolve_local_library_id():
            return 1

        @staticmethod
        def enqueue_targeted_reconciliation(**_kwargs):
            raise AssertionError("startup without watcher events must not enqueue")

        @staticmethod
        def enqueue_authorized_full_scan(**kwargs):
            durable_enqueues.append(kwargs)
            return types.SimpleNamespace(created=True, job_id=901, intent_id=85)

        @staticmethod
        def load_authorized_full_scan_status(**_kwargs):
            return {
                "state": "idle",
                "progress_current": 0,
                "progress_total": 0,
                "phase": "idle",
                "mode": "idle",
            }

    monkeypatch.setattr(
        "music_app.routes.api_read_asgi_routes.load_database_identity_status",
        lambda *_args, **_kwargs: {},
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
    monkeypatch.setattr(
        "music_app.services.scan_jobs_postgres.PostgresScanJobRepository",
        FakeScanJobRepository,
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
    monkeypatch.setattr(runtime_shutdown, "request_runtime_shutdown", lambda _app: None)
    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)
    policy_evaluation = types.SimpleNamespace(
        decision=types.SimpleNamespace(allowed=True),
        audit=types.SimpleNamespace(library_id=1),
    )

    def fake_require_action(_action):
        async def dependency(request):
            request.state.policy_evaluation = policy_evaluation
            return policy_evaluation

        return dependency

    monkeypatch.setattr(web_asgi, "require_action", fake_require_action)
    monkeypatch.setattr(
        web_asgi,
        "_authorized_scan_request",
        lambda _request: (
            policy_evaluation,
            1,
            "network:test-origin",
            ("startup-main",),
        ),
    )
    monkeypatch.setattr(
        web_asgi,
        "PostgresLibraryBrowseRepository",
        lambda _config: types.SimpleNamespace(
            build_root_startup_preview_payload=lambda **_kwargs: {
                "artists_sidebar": [],
                "artist_groups": [],
                "artist_count": 0,
                "album_count": 0,
                "selected_artist": "",
                "payload_tier": "sidebar",
                "gallery_display_mode": "covers",
            },
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
    assert asgi_app.state.library_state["cold_scan_pending"] is False
    root_status, _root_headers, root_body = run_asgi_request(asgi_app, "GET", "/", query=root_query)
    status_status, _status_headers, status_body = _run_asgi_http_get(asgi_app, "/status")

    assert root_status == 200
    assert asgi_app.state.library_state["cold_scan_handoff_status"] == "started"
    assert b"window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__" in root_body
    assert b'"scanInProgress": true' in root_body
    assert b'"scanPhase": "discovering"' in root_body
    assert status_status == 200
    assert "scan_in_progress" in json.loads(status_body)
    assert submissions == []
    assert len(durable_enqueues) == 1
    assert durable_enqueues[0]["library_id"] == 1
    assert durable_enqueues[0]["force"] is False
    assert durable_enqueues[0]["mode"] == "background"


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
    from music_app.services import runtime_shutdown, state

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
    monkeypatch.setattr(runtime_shutdown, "request_runtime_shutdown", lambda _app: None)

    asgi_app = create_asgi_app()

    assert _run_asgi_lifespan(asgi_app) == [
        {"type": "lifespan.startup.complete"},
        {"type": "lifespan.shutdown.complete"},
    ]
    assert scan_calls == []
    for key, value in state_patch.items():
        assert asgi_app.state.library_state[key] == value


def test_create_asgi_app_lifespan_reports_background_hydration_exception_without_blocking_startup(
    monkeypatch,
):
    from music_app import create_asgi_app
    from music_app.services import state

    failure = RuntimeError("strict Postgres query failed")
    hydration_attempted = threading.Event()
    scan_calls = []

    def fail_hydration(_app):
        hydration_attempted.set()
        raise failure

    monkeypatch.setattr(state, "hydrate_runtime_library_state_on_startup", fail_hydration)
    monkeypatch.setattr(
        state,
        "start_background_refresh_for_state",
        lambda *args, **kwargs: scan_calls.append((args, kwargs)),
    )
    asgi_app = create_asgi_app()

    assert _run_asgi_lifespan(asgi_app) == [
        {"type": "lifespan.startup.complete"},
        {"type": "lifespan.shutdown.complete"},
    ]
    assert hydration_attempted.wait(timeout=2)
    assert scan_calls == []


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


def test_postgres_warmup_loads_scan_timestamp_without_inventory_hydration():
    import asyncio
    from music_app import _start_library_warmup

    completed = threading.Event()
    calls = []
    runtime = types.SimpleNamespace(
        config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://test/isolated"},
        logger=logging.getLogger("test-metadata-only-warmup"),
        library_state={"last_scan": 0.0, "file_cache": {}},
    )

    def load_metadata(app):
        calls.append("metadata")
        app.library_state["last_scan"] = 1609459200.0

    def ensure_relations(app, **_options):
        calls.append("relations")
        assert app.library_state["last_scan"] == 1609459200.0
        completed.set()

    def unexpected_inventory_hydration(_app):
        raise AssertionError("PostgreSQL startup must not load full inventory")

    handle = _start_library_warmup(
        runtime, unexpected_inventory_hydration, ensure_relations,
        lambda _url: None,
        hydrate_metadata=load_metadata,
    )
    try:
        assert completed.wait(5)
        assert calls == ["metadata", "relations"]
        assert runtime.library_state["file_cache"] == {}
    finally:
        asyncio.run(handle.stop())


def test_postgres_warmup_metadata_failure_does_not_skip_relation_initialization():
    import asyncio
    from music_app import _start_library_warmup

    completed = threading.Event()
    runtime = types.SimpleNamespace(
        config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://test/isolated"},
        logger=logging.getLogger("test-metadata-failure-warmup"), library_state={},
    )

    def broken_metadata(_runtime):
        raise RuntimeError("metadata unavailable")

    handle = _start_library_warmup(
        runtime, lambda _app: None, lambda *_args, **_kwargs: completed.set(),
        lambda _url: None, hydrate_metadata=broken_metadata,
    )
    try:
        assert completed.wait(2), "Optional timestamp failure must not skip relation initialization"
    finally:
        asyncio.run(handle.stop())


def test_postgres_warmup_runs_recovery_before_metadata_without_full_hydration():
    from types import SimpleNamespace
    from unittest.mock import Mock
    from music_app import _start_library_warmup

    calls = []
    runtime = SimpleNamespace(config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://isolated/test"}, logger=Mock())
    handle = _start_library_warmup(
        runtime,
        lambda _runtime: calls.append("full_hydrate"),
        lambda _runtime, **_kwargs: calls.append("relations"),
        lambda _url: calls.append("prewarm"),
        hydrate_metadata=lambda _runtime: calls.append("metadata"),
        recover_persistence=lambda _runtime: calls.append("recovery"),
    )
    handle._worker.join(timeout=2)
    assert not handle._worker.is_alive()
    assert calls == ["prewarm", "recovery", "metadata", "relations"]

def test_lifespan_compiles_templates_without_rendering_before_first_request(monkeypatch):
    from jinja2 import DictLoader, Template
    from music_app import create_asgi_app

    app = create_asgi_app()
    environment = app.state.templates.env
    environment.loader = DictLoader({
        "index.html": "{% include 'fragment.html' %}",
        "fragment.html": "{{ viewer }}",
    })
    def unexpected_render(*_args, **_kwargs):
        raise AssertionError("Startup must compile templates without rendering request data")
    with monkeypatch.context() as startup_patch:
        startup_patch.setattr(Template, "render", unexpected_render)
        assert _run_asgi_lifespan(app) == [
            {"type": "lifespan.startup.complete"},
            {"type": "lifespan.shutdown.complete"},
        ]
    def unexpected_compile(*_args, **_kwargs):
        raise AssertionError("First request should reuse templates compiled at startup")
    monkeypatch.setattr(environment, "compile", unexpected_compile)
    assert environment.get_template("index.html").render(viewer="first viewer") == "first viewer"


def test_lifespan_template_warmup_preserves_template_reload():
    from jinja2 import DictLoader
    from music_app import create_asgi_app

    app = create_asgi_app()
    environment = app.state.templates.env
    source = {"index.html": "before"}
    environment.loader = DictLoader(source)
    assert environment.auto_reload is True
    assert _run_asgi_lifespan(app)[0] == {"type": "lifespan.startup.complete"}
    before = environment.get_template("index.html")
    source["index.html"] = "after"
    after = environment.get_template("index.html")
    assert after is not before
    assert after.render() == "after"
