from __future__ import annotations

import asyncio
import importlib
import json
from pathlib import Path
from threading import Event, Thread

import pytest

from tests.py.asgi_testing import decode_json, run_asgi_request


def _health_module():
    return importlib.import_module("music_app.services.library_watch_health")


def test_earlier_health_write_does_not_remove_later_failed_pending_event():
    health = _health_module()
    first_started = Event()
    release_first = Event()
    calls = 0

    class InterleavedStore:
        def upsert(self, _problem):
            nonlocal calls
            calls += 1
            if calls == 1:
                first_started.set()
                assert release_first.wait(2)
                return
            raise RuntimeError("second write failed")

        def load(self):
            return []

    service = health.LibraryWatchHealthService(InterleavedStore())
    event = health.LibraryEvent(
        health.LibraryEventKind.OVERFLOW,
        "main-root",
        Path("C:/Music"),
    )
    first = Thread(target=service.record_event, args=(event,))
    first.start()
    assert first_started.wait(2)

    with pytest.raises(RuntimeError, match="second write failed"):
        service.record_event(event)
    release_first.set()
    first.join(2)

    assert not first.is_alive()
    assert [problem.root_id for problem in service.load_problems()] == ["main-root"]


class _Rows:
    def __init__(self, rows):
        self._rows = list(rows)

    def fetchall(self):
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _HealthConnection:
    def __init__(self):
        self.problems: dict[str, dict[str, object]] = {}
        self.executed: list[tuple[str, dict[str, object]]] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=None):
        normalized = " ".join(str(sql).split()).casefold()
        received = dict(params or {})
        self.executed.append((normalized, received))
        if "watch_health_upsert" in normalized:
            self.problems[str(received["root_id"])] = {
                "state": str(received["state"]),
                "detected_at": str(received["detected_at"]),
            }
            return _Rows([])
        if "watch_health_clear" in normalized:
            detected_before = str(received.get("detected_before") or "")
            for root_id in received["root_ids"]:
                problem = self.problems.get(str(root_id))
                if problem is None:
                    continue
                if detected_before and str(problem["detected_at"]) > detected_before:
                    continue
                self.problems.pop(str(root_id), None)
            return _Rows([])
        if "watch_health_load" in normalized:
            return _Rows([{"library_watch_health": dict(self.problems)}])
        raise AssertionError(f"Unexpected health SQL: {normalized}")


def test_overflow_and_disconnect_persist_one_problem_for_the_same_root():
    module = _health_module()
    connection = _HealthConnection()
    store = module.PostgresLibraryWatchHealthStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://health-test"},
        connect=lambda _database_url: connection,
    )
    service = module.LibraryWatchHealthService(store)

    service.record_event(
        module.LibraryEvent(
            module.LibraryEventKind.OVERFLOW,
            "main-root",
            Path("C:/Private Music/Artist/Album/01.flac"),
            observed_at=1_725_000_000.0,
        )
    )
    service.record_event(
        module.LibraryEvent(
            module.LibraryEventKind.ROOT_UNAVAILABLE,
            "main-root",
            Path("C:/Private Music"),
            observed_at=1_725_000_100.0,
        )
    )

    problems = service.load_problems()
    assert len(problems) == 1
    assert problems[0].root_id == "main-root"
    assert problems[0].state == "root_unavailable"
    assert problems[0].message == "Some library changes may have been missed."
    assert service.root_allows_destructive_reconciliation("main-root") is False
    assert "Private Music" not in json.dumps(problems[0].as_public_dict())


def test_non_health_events_do_not_create_operational_problems():
    module = _health_module()
    connection = _HealthConnection()
    service = module.LibraryWatchHealthService(
        module.PostgresLibraryWatchHealthStore(
            {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://health-test"},
            connect=lambda _database_url: connection,
        )
    )

    recorded = service.record_event(
        module.LibraryEvent(
            module.LibraryEventKind.MODIFIED,
            "main-root",
            Path("C:/Private Music/Artist/Album/01.flac"),
            observed_at=1_725_000_000.0,
        )
    )

    assert recorded is False
    assert service.load_problems() == []


def test_successful_manual_full_scan_clears_only_observed_recovered_roots():
    module = _health_module()
    connection = _HealthConnection()
    service = module.LibraryWatchHealthService(
        module.PostgresLibraryWatchHealthStore(
            {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://health-test"},
            connect=lambda _database_url: connection,
        )
    )
    for root_id in ("main-root", "archive-root"):
        service.record_event(
            module.LibraryEvent(
                module.LibraryEventKind.ROOT_UNAVAILABLE,
                root_id,
                Path(f"C:/Private/{root_id}"),
                observed_at=1_725_000_000.0,
            )
        )

    assert service.clear_after_scan(
        scan_mode="background",
        observed_root_ids={"main-root"},
    ) == 0
    assert service.clear_after_scan(
        scan_mode="manual_full_rescan",
        observed_root_ids={"main-root"},
    ) == 1

    remaining = service.load_problems()
    assert [problem.root_id for problem in remaining] == ["archive-root"]
    assert service.root_allows_destructive_reconciliation("main-root") is True
    assert service.root_allows_destructive_reconciliation("archive-root") is False
    clear_params = next(
        params
        for sql, params in connection.executed
        if "watch_health_clear" in sql
    )
    assert clear_params["root_ids"] == ["main-root"]


def test_exhausted_stable_write_persists_warning_and_blocks_destructive_work_until_full_scan(
    tmp_path,
):
    from music_app.services.allowed_actions import AllowedActions
    from music_app.services.library_event_coordinator import LibraryEventCoordinator
    from music_app.services.library_reconciliation import LibraryEvent, LibraryEventKind
    from music_app.services.view_payloads import project_library_watch_health

    module = _health_module()
    connection = _HealthConnection()
    service = module.LibraryWatchHealthService(
        module.PostgresLibraryWatchHealthStore(
            {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://health-test"},
            connect=lambda _database_url: connection,
        )
    )
    coordinator = LibraryEventCoordinator(
        emit_request=lambda _request: None,
        emit_problem=service.record_problem,
        stat_path=lambda _path: (_ for _ in ()).throw(PermissionError("busy")),
        wait=lambda _seconds: None,
        max_stable_attempts=2,
    )

    coordinator.accept(
        LibraryEvent(
            LibraryEventKind.CREATED,
            "main-root",
            tmp_path / "Artist" / "Album" / "01.flac",
        )
    )
    coordinator.flush()

    [problem] = service.load_problems()
    assert problem.root_id == "main-root"
    assert problem.state == "stable_write_unavailable"
    projected = project_library_watch_health(
        [problem],
        AllowedActions(("library.refresh",)),
    )
    assert projected["state"] == "warning"
    assert projected["problems"][0]["message"] == (
        "Some library changes may have been missed."
    )
    assert projected["problems"][0]["allowed_actions"] == {
        "library.refresh": True
    }
    assert service.root_allows_destructive_reconciliation("main-root") is False

    assert service.clear_after_scan(
        scan_mode="background",
        observed_root_ids={"main-root"},
    ) == 0
    assert service.root_allows_destructive_reconciliation("main-root") is False

    assert service.clear_after_scan(
        scan_mode="manual_full_rescan",
        observed_root_ids={"main-root"},
    ) == 1
    assert service.load_problems() == []
    assert service.root_allows_destructive_reconciliation("main-root") is True


def test_app_wires_coordinator_problems_to_persistent_watcher_health(monkeypatch):
    from music_app import create_asgi_app
    from music_app.services import (
        lastfm_retry,
        exception_overrides,
        library_event_coordinator,
        library_reconciliation,
        library_roots,
        library_watch_health,
        runtime_shutdown,
        scan_cache_persistence,
        state,
        targeted_library_reconciliation,
    )

    callbacks = {}
    recorded = []
    reconciled = []

    class HealthService:
        def __init__(self, _store):
            self._unhealthy_roots = set()

        def record_problem(self, problem):
            recorded.append(problem)
            self._unhealthy_roots.add(problem.root_id)
            return True

        def root_allows_destructive_reconciliation(self, root_id):
            return root_id not in self._unhealthy_roots

    class CompletedFuture:
        def __init__(self, result):
            self._result = result

        def result(self):
            return self._result

        def add_done_callback(self, callback):
            callback(self)

    class InlineExecutor:
        def submit(self, function, *args):
            return CompletedFuture(function(*args))

        def shutdown(self, **_kwargs):
            return None

    class CapturingCoordinator:
        def __init__(self, **kwargs):
            callbacks.update(kwargs)

        def accept(self, _event):
            return True

        def stop(self):
            return True

    class WatchService:
        def __init__(self, _source, _emit_event):
            pass

        def start(self):
            return True

        def stop(self):
            return True

        def replace_roots(self, _roots):
            return None

    class TargetedReconciler:
        def __init__(self, *_args, **_kwargs):
            pass

        def reconcile(self, request, *, root_healthy):
            reconciled.append((request.root_id, root_healthy))
            return root_healthy

        def replace_roots(self, _roots):
            return None

    class ScanCacheRepository:
        backend = "postgres"

    monkeypatch.setattr(
        library_watch_health,
        "LibraryWatchHealthService",
        HealthService,
    )
    monkeypatch.setattr(
        library_event_coordinator,
        "LibraryEventCoordinator",
        CapturingCoordinator,
    )
    monkeypatch.setattr(library_reconciliation, "LibraryWatchService", WatchService)
    monkeypatch.setattr(
        library_reconciliation,
        "WatchdogLibraryEventSource",
        lambda _roots: object(),
    )
    monkeypatch.setattr(
        targeted_library_reconciliation,
        "TargetedLibraryReconciler",
        TargetedReconciler,
    )
    monkeypatch.setattr(
        library_roots,
        "get_library_roots",
        lambda _config: ({"id": "main-root", "path": "C:/Music"},),
    )
    monkeypatch.setattr(
        scan_cache_persistence,
        "select_scan_cache_adapter",
        lambda _config: ScanCacheRepository(),
    )
    monkeypatch.setattr(
        exception_overrides,
        "load_exception_overrides",
        lambda _config: {},
    )
    monkeypatch.setattr(
        state,
        "hydrate_runtime_library_state_on_startup",
        lambda _runtime: True,
    )
    monkeypatch.setattr(
        state,
        "ensure_runtime_relation_projection_ready",
        lambda _runtime: None,
    )
    monkeypatch.setattr(lastfm_retry, "start_lastfm_retry_worker", lambda _runtime: None)
    monkeypatch.setattr(lastfm_retry, "stop_lastfm_retry_worker", lambda _runtime: None)
    monkeypatch.setattr(
        runtime_shutdown,
        "request_runtime_shutdown",
        lambda _runtime: True,
    )
    monkeypatch.setattr(
        runtime_shutdown,
        "create_daemon_executor",
        lambda **_kwargs: InlineExecutor(),
    )

    app = create_asgi_app()
    problem = library_event_coordinator.CoordinatorProblem(
        "stable_write_unavailable",
        "main-root",
    )

    async def exercise_problem_callback():
        async with app.router.lifespan_context(app):
            callbacks["emit_problem"](problem)
            callbacks["emit_request"](
                library_event_coordinator.TargetedReconciliationRequest(
                    root_id="main-root"
                )
            )

    asyncio.run(exercise_problem_callback())

    assert recorded == [problem]
    assert reconciled == [("main-root", False)]


def test_manual_recovery_does_not_clear_health_detected_after_scan_started():
    module = _health_module()
    connection = _HealthConnection()
    service = module.LibraryWatchHealthService(
        module.PostgresLibraryWatchHealthStore(
            {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://health-test"},
            connect=lambda _database_url: connection,
        ),
        now=lambda: module.datetime.fromisoformat(
            "2026-09-04T12:00:10+00:00"
        ),
    )
    service.record_event(
        module.LibraryEvent(
            module.LibraryEventKind.OVERFLOW,
            "main-root",
            Path("C:/Private Music"),
        )
    )

    assert service.clear_after_scan(
        scan_mode="manual_full_rescan",
        observed_root_ids={"main-root"},
        scan_started_at="2026-09-04T12:00:00+00:00",
    ) == 0
    assert [problem.root_id for problem in service.load_problems()] == [
        "main-root"
    ]


def test_postgres_health_queries_use_library_metadata_without_path_columns():
    module = _health_module()
    sql = " ".join(
        (
            module._UPSERT_LIBRARY_WATCH_HEALTH_SQL,
            module._LOAD_LIBRARY_WATCH_HEALTH_SQL,
            module._CLEAR_LIBRARY_WATCH_HEALTH_SQL,
        )
    ).casefold()

    assert "library.libraries" in sql
    assert "library_watch_health" in sql
    assert "metadata" in sql
    assert "private_path" not in sql
    assert "local_track_files" not in sql


def test_problematic_files_endpoint_includes_path_free_operational_health_when_album_list_is_empty(
    monkeypatch,
):
    from music_app import create_asgi_app
    from music_app.routes import api_read_asgi_routes
    from music_app.services.allowed_actions import AllowedActions

    class FakeHealthService:
        def load_problems(self):
            return [
                {
                    "root_id": "C:/Private Music/Main Library",
                    "state": "overflow",
                    "detected_at": "2026-09-04T12:00:00+00:00",
                }
            ]

    app = create_asgi_app()
    app.state.library_watch_health_service = FakeHealthService()
    monkeypatch.setattr(
        api_read_asgi_routes,
        "select_runtime_persistence_adapter",
        lambda *_args, **_kwargs: type(
            "Selection", (), {"effective_backend": "unavailable"}
        )(),
    )
    monkeypatch.setattr(
        api_read_asgi_routes,
        "_hydrate_cached_library_for_asgi",
        lambda _request: None,
    )
    monkeypatch.setattr(
        api_read_asgi_routes,
        "build_problematic_albums_payload",
        lambda **_kwargs: {"count": 0, "items": [], "initial_detail": None},
    )
    monkeypatch.setattr(
        api_read_asgi_routes,
        "allowed_actions_for_request",
        lambda _request, _actions: AllowedActions(("library.refresh",)),
    )

    status, _headers, body = run_asgi_request(
        app,
        "GET",
        "/utilities/problematic-files",
    )

    payload = decode_json(body)
    assert status == 200
    assert payload["items"] == []
    assert payload["operational_count"] == 1
    assert payload["operational_items"][0]["message"] == (
        "Some library changes may have been missed."
    )
    assert payload["operational_items"][0]["allowed_actions"] == {
        "library.refresh": True
    }
    assert "Private Music" not in json.dumps(payload)


def test_manual_recovery_clears_observed_health_and_reattaches_current_roots():
    from music_app import _recover_library_watch_after_manual_scan

    calls = []

    class Health:
        def clear_after_scan(
            self,
            *,
            scan_mode,
            scan_started_at,
            observed_root_ids,
        ):
            calls.append(
                (
                    "clear",
                    scan_mode,
                    scan_started_at,
                    set(observed_root_ids),
                )
            )
            return 1

    class Replaceable:
        def __init__(self, name):
            self.name = name

        def replace_roots(self, roots):
            calls.append((self.name, tuple(roots)))

    roots = (
        {"id": "main-root", "path": "C:/Music"},
        {"id": "archive-root", "path": "D:/Archive"},
    )

    cleared = _recover_library_watch_after_manual_scan(
        health_service=Health(),
        targeted_reconciler=Replaceable("reconciler"),
        watch_service=Replaceable("watcher"),
        root_definitions=roots,
        scan_mode="manual_full_rescan",
        scan_started_at="2026-09-04T11:59:00+00:00",
        observed_root_ids={"main-root"},
    )

    assert cleared == 1
    assert calls[0] == (
        "clear",
        "manual_full_rescan",
        "2026-09-04T11:59:00+00:00",
        {"main-root"},
    )
    assert calls[1] == ("reconciler", roots)
    assert calls[2] == ("watcher", roots)
