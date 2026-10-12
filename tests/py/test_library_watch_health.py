from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import importlib
import json
from pathlib import Path
from threading import Event, Thread
from types import SimpleNamespace

import pytest

from tests.py.asgi_testing import decode_json, run_asgi_request


def _health_module():
    return importlib.import_module("music_app.services.library_watch_health")


def test_destructive_publication_rejects_failed_pending_health_write():
    from contextlib import nullcontext
    health = _health_module()
    connection = _HealthConnection()
    store = health.PostgresLibraryWatchHealthStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://health-test"}, connect=lambda _url: connection,
    )
    service = health.LibraryWatchHealthService(store)
    store.upsert = lambda _problem: (_ for _ in ()).throw(OSError("store unavailable"))
    with pytest.raises(OSError):
        service.record_event(health.LibraryEvent(health.LibraryEventKind.OVERFLOW, "destination", Path("C:/Music")))
    # Missing boundary must fail the regression, without relying on a missing import.
    guard = getattr(service, "publication_guard", lambda *_args: nullcontext())
    entered = False
    try:
        with guard(connection, ("source", "destination")):
            entered = True
    except RuntimeError:
        pass
    assert not entered, "a pending failed health write must prevent destructive publication"


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
    second_pending = Event()
    failures = []

    class ObservedPending(dict):
        def __setitem__(self, key, value):
            super().__setitem__(key, value)
            if first_started.is_set():
                second_pending.set()

    service._pending = ObservedPending()

    def record_second():
        try:
            service.record_event(event)
        except RuntimeError as error:
            failures.append(str(error))

    first.start()
    second = Thread(target=record_second)
    try:
        assert first_started.wait(2)
        second.start()
        assert second_pending.wait(2)
        assert not service.root_allows_destructive_reconciliation("main-root")
    finally:
        release_first.set()
        first.join(2)
        if second.ident is not None:
            second.join(2)

    assert not first.is_alive() and not second.is_alive()
    assert failures == ["second write failed"]
    assert [problem.root_id for problem in service.load_problems()] == ["main-root"]
    assert not service.root_allows_destructive_reconciliation("main-root")


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
            if "event_id" in received:
                self.problems[str(received["root_id"])]["event_id"] = received["event_id"]
            return _Rows([])
        if "watch_health_load" in normalized:
            return _Rows([{"library_watch_health": dict(self.problems)}])
        raise AssertionError(f"Unexpected health SQL: {normalized}")


def test_legacy_health_without_event_identity_remains_readable_and_stable():
    from music_app.services.library_warning_dismissals import warning_token

    health = _health_module()
    connection = _HealthConnection()
    connection.problems["legacy-root"] = {"state": "overflow", "detected_at": "2026-09-10T00:00:00+00:00"}
    tokens = []
    for _ in range(2):
        store = health.PostgresLibraryWatchHealthStore(
            {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://health-test"},
            connect=lambda _url: connection,
        )
        [problem] = store.load()
        assert (problem.root_id, problem.state, problem.detected_at) == (
            "legacy-root", "overflow", "2026-09-10T00:00:00+00:00",
        )
        tokens.append(warning_token({"state": "warning", "problems": [problem.as_public_dict()]}))
    assert tokens == ["7e6f8fac103a94d5ab7e07922ed27a4f7405502bd337563fdc4ed3374be6584c"] * 2


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


def test_reconciliation_failure_persists_path_free_warning():
    from music_app.services.allowed_actions import AllowedActions
    from music_app.services.library_event_coordinator import CoordinatorProblem
    from music_app.services.view_payloads import project_library_watch_health

    module = _health_module()
    connection = _HealthConnection()
    service = module.LibraryWatchHealthService(
        module.PostgresLibraryWatchHealthStore(
            {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://health-test"},
            connect=lambda _database_url: connection,
        )
    )

    assert service.record_problem(
        CoordinatorProblem("reconciliation_failed", "main-root")
    ) is True

    [problem] = service.load_problems()
    assert problem.root_id == "main-root"
    assert problem.state == "reconciliation_failed"
    assert service.root_allows_destructive_reconciliation("main-root") is False
    projected = project_library_watch_health(
        [problem],
        AllowedActions(("library.refresh",)),
    )
    assert projected == {
        "state": "warning",
        "problems": [
            {
                "state": "reconciliation_failed",
                "root_key": module.opaque_root_key("main-root"),
                "detected_at": problem.detected_at,
                "event_id": problem.event_id,
                "message": "Some library changes may have been missed.",
                "allowed_actions": {"library.refresh": True},
            }
        ],
    }
    assert "repair_required" not in projected or projected["repair_required"] is False
    assert "main-root" not in json.dumps(projected)
    assert service.root_allows_destructive_reconciliation("main-root") is False


def test_reconciliation_admission_overflow_blocks_destructive_work():
    from music_app.services.library_event_coordinator import CoordinatorProblem

    module = _health_module()
    connection = _HealthConnection()
    service = module.LibraryWatchHealthService(
        module.PostgresLibraryWatchHealthStore(
            {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://health-test"},
            connect=lambda _database_url: connection,
        )
    )

    assert service.record_problem(CoordinatorProblem("overflow", "main-root")) is True
    [problem] = service.load_problems()
    assert problem.root_id == "main-root"
    assert problem.state == "overflow"
    assert service.root_allows_destructive_reconciliation("main-root") is False


def test_app_wires_coordinator_health_and_durable_reconciliation_admission(monkeypatch):
    from music_app import create_asgi_app
    from music_app.services import (
        cover_preview_backfill, library_event_coordinator, library_reconciliation,
        library_roots,
        library_watch_health, log_history, postgres_connections, runtime_shutdown,
        scan_jobs_postgres, state,
        watcher_recovery_postgres,
    )
    from music_app.services.library_watch import LibraryEvent, LibraryEventKind

    callbacks, watcher_calls = {}, []
    recovery_reports = []
    fail_dirty = {"enabled": False}
    library_id = {"value": 19}
    health = _health_module()
    connection = _HealthConnection()
    service = health.LibraryWatchHealthService(
        health.PostgresLibraryWatchHealthStore(
            {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://health-test"},
            connect=lambda _url: connection,
        )
    )

    class Repository:
        def __init__(self, *, database_url):
            assert database_url == "postgresql://health-test"

        def resolve_local_library_id(self):
            return library_id["value"]

    class WatcherRepository:
        def __init__(self, *, database_url):
            assert database_url == "postgresql://health-test"

        def accept_event(self, **values):
            watcher_calls.append(("accept", values))

        def record_problem(self, **values):
            watcher_calls.append(("problem", values))
            if fail_dirty["enabled"]:
                raise RuntimeError("durable watcher admission unavailable")
            service.record_problem(values["problem"])

        def mark_dirty(self, **values):
            assert values["reason_code"] in {"root_unavailable", "overflow"}
            watcher_calls.append(("dirty", values))
            if fail_dirty["enabled"]:
                raise RuntimeError("durable watcher admission unavailable")

    class Backfill:
        def __init__(self, *_args, **_kwargs):
            pass

        def start(self):
            return True

        def stop(self):
            return True

    class WatchService:
        def __init__(self, _source, _emit_event):
            callbacks["emit_event"] = _emit_event

        def start(self):
            return True

        def stop(self, *, timeout=None):
            return True

        def replace_roots(self, roots):
            if any(root.get("id") == "attach-failed" for root in roots):
                raise OSError("watch attachment unavailable")

    from music_app.services import watcher_session_recovery

    class SessionController:
        def __init__(self, _repository):
            pass

        def start(self, **values):
            assert values["library_id"] == 19
            return ()

        def expand_participants(self, root_ids):
            pass

        def set_participants(self, root_ids):
            pass

        def report_admission_failure(self, *, logical_root_ids):
            recovery_reports.append(logical_root_ids)

        def stop_retry_and_flush(self, *, deadline):
            pass

        def finish(self):
            return True

    monkeypatch.setattr(watcher_session_recovery, "WatcherSessionRecoveryController", SessionController)
    monkeypatch.setattr(library_watch_health, "LibraryWatchHealthService", lambda _store: service)
    monkeypatch.setattr(cover_preview_backfill, "CoverPreviewBackfill", Backfill)
    monkeypatch.setattr(scan_jobs_postgres, "PostgresScanJobRepository", Repository)
    monkeypatch.setattr(
        watcher_recovery_postgres,
        "PostgresWatcherRecoveryRepository",
        WatcherRepository,
    )
    monkeypatch.setattr(library_reconciliation, "LibraryWatchService", WatchService)
    monkeypatch.setattr(library_reconciliation, "WatchdogLibraryEventSource", lambda _roots, **_kwargs: object())
    monkeypatch.setattr(library_roots, "get_library_roots", lambda _config: ())
    monkeypatch.setattr(log_history, "resolve_media_host_history_scope", lambda _config: None)
    monkeypatch.setattr(state, "hydrate_runtime_library_state_on_startup", lambda _runtime: True)
    monkeypatch.setattr(
        state,
        "hydrate_runtime_scan_metadata_on_startup",
        lambda _runtime: True,
    )
    monkeypatch.setattr(
        state,
        "recover_runtime_library_persistence_on_startup",
        lambda _runtime: True,
    )
    monkeypatch.setattr(state, "ensure_runtime_relation_projection_ready", lambda _runtime: None)
    monkeypatch.setattr(
        postgres_connections,
        "prewarm_connection_pool",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(runtime_shutdown, "request_runtime_shutdown", lambda _runtime: True)

    app = create_asgi_app()
    app.state.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://health-test"
    observed_at = datetime.now(timezone.utc)
    created = LibraryEvent(
        LibraryEventKind.CREATED,
        "main-root",
        Path("C:/Source/01.flac"),
        observed_at=observed_at,
    )

    async def exercise_callbacks():
        async with app.router.lifespan_context(app):
            callbacks["emit_event"](created)
            library_id["value"] = None
            callbacks["emit_event"](created)
            library_id["value"] = 19
            callbacks["emit_event"](
                LibraryEvent(
                    LibraryEventKind.OVERFLOW,
                    "main-root",
                    Path("C:/Source"),
                    observed_at=observed_at,
                    is_directory=True,
                )
            )
            fail_dirty["enabled"] = True
            with pytest.raises(
                RuntimeError,
                match="durable watcher admission unavailable",
            ):
                callbacks["emit_event"](
                    LibraryEvent(
                        LibraryEventKind.ROOT_UNAVAILABLE,
                        "database-outage",
                        Path("C:/Unavailable"),
                        observed_at=observed_at,
                        is_directory=True,
                    )
                )
            fail_dirty["enabled"] = False
            with pytest.raises(OSError, match="attachment"):
                app.state.replace_library_watch_roots([
                    {"id": "attach-failed", "path": "C:/Unattached"},
                ])
            assert "_LIBRARY_WATCH_MANUAL_RECOVERY_CALLBACK" not in app.state.config

    asyncio.run(exercise_callbacks())

    assert {(problem.root_id, problem.state) for problem in service.load_problems()} == {
        ("main-root", "overflow"),
    }
    assert service.root_allows_destructive_reconciliation("main-root") is False
    assert recovery_reports == [("database-outage",), ("attach-failed",)]
    assert watcher_calls[:2] == [
        (
            "accept",
            {
                "library_id": 19,
                "event": created,
                "accepted_at": observed_at,
            },
        ),
    ] * 2
    assert [
        (kind, {key: value for key, value in values.items() if key != "observed_at"})
        for kind, values in watcher_calls[2:]
    ] == [
        (
            "problem",
            {
                "library_id": 19,
                "problem": library_event_coordinator.CoordinatorProblem(
                    "overflow", "main-root"
                ),
            },
        ),
        (
            "problem",
            {
                "library_id": 19,
                "problem": library_event_coordinator.CoordinatorProblem(
                    "root_unavailable", "database-outage"
                ),
            },
        ),
    ]
    assert all(
        values["observed_at"].utcoffset() is not None
        for _kind, values in watcher_calls[2:]
    )


def test_postgres_health_queries_use_library_metadata_without_path_columns():
    module = _health_module()
    sql = " ".join(
        (
            module._UPSERT_LIBRARY_WATCH_HEALTH_SQL,
            module._LOAD_LIBRARY_WATCH_HEALTH_SQL,
        )
    ).casefold()

    assert not hasattr(module, "_CLEAR_LIBRARY_WATCH_HEALTH_SQL")
    assert "library.libraries" in sql
    assert "library_watch_health" in sql
    assert "library.load_local_watcher_incidents()" in sql
    assert "metadata" in sql
    assert "private_path" not in sql
    assert "local_track_files" not in sql


def test_postgres_health_upsert_keeps_the_newest_detected_timestamp():
    module = _health_module()
    sql = " ".join(module._UPSERT_LIBRARY_WATCH_HEALTH_SQL.split()).casefold()

    assert "#>> array['library_watch_health', %(root_id)s::text, 'detected_at']" in sql
    assert ")::timestamptz <= %(detected_at)s::timestamptz" in sql


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


def test_timestamp_manual_recovery_callback_is_removed():
    import music_app

    assert not hasattr(music_app, "_recover_library_watch_after_manual_scan")
    service = _health_module().LibraryWatchHealthService(SimpleNamespace())
    for obsolete_name in (
        "clear_after_scan",
        "_recovered_before",
        "_recovery_generation",
    ):
        assert not hasattr(service, obsolete_name)


@pytest.mark.parametrize(
    ("scan_mode", "repair_id", "expected"),
    (
        ("manual_full_rescan", 613, True),
        ("background", 613, False),
        ("manual_full_rescan", None, False),
    ),
)
def test_watch_health_completion_is_manual_and_repair_id_gated(
    scan_mode, repair_id, expected
):
    module = _health_module()
    calls = []
    now = datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc)

    class Repository:
        def complete_repair(self, **values):
            calls.append(values)
            return True

    claim = SimpleNamespace(
        job_id=901,
        attempt=3,
        worker_id="worker-full",
        lease_token="lease-full",
    )
    service = module.LibraryWatchHealthService(Repository())

    assert service.complete_repair(
        scan_mode=scan_mode,
        repair_id=repair_id,
        inventory_revision=41,
        claim=claim,
        now=now,
    ) is expected
    assert calls == (
        [
            {
                "claim": claim,
                "repair_id": 613,
                "inventory_revision": 41,
                "now": now,
            }
        ]
        if expected
        else []
    )


@pytest.mark.parametrize("as_mapping", [False, True])
def test_public_health_projection_preserves_same_clock_event_identity(as_mapping):
    from music_app.services.allowed_actions import AllowedActions
    from music_app.services.library_warning_dismissals import warning_token
    from music_app.services.view_payloads import project_library_watch_health

    health = _health_module()
    tokens = []
    for event_id in ("52bbe3c4-cdd0-42cc-a742-a4c1d722fb1f", "ae42b32c-ad81-4059-ba51-ea6e9d6684ad"):
        fields = {"root_id": "C:/Private Music/Main", "state": "overflow",
                  "detected_at": "2026-09-10T00:00:00+00:00", "event_id": event_id}
        problem = fields if as_mapping else health.LibraryWatchHealthProblem(**fields)
        projected = project_library_watch_health([problem], AllowedActions(()))
        assert projected["problems"][0]["event_id"] == event_id
        assert projected["problems"][0]["allowed_actions"] == {}
        assert "Private Music" not in json.dumps(projected)
        tokens.append(warning_token(projected))
    assert tokens[0] != tokens[1]


def test_durable_health_projection_exposes_stable_identity_without_private_values():
    from music_app.services.allowed_actions import AllowedActions
    from music_app.services.library_watch_health import (
        LibraryWatchHealthProblem,
        WATCH_HEALTH_MESSAGE,
        opaque_root_key,
    )
    from music_app.services.view_payloads import project_library_watch_health

    private_root = r"D:\Private Music\Secret Library"
    private_token = "22222222-2222-2222-2222-222222222222"
    problem = LibraryWatchHealthProblem(
        root_id=private_root,
        state="root_unavailable",
        detected_at="2026-10-09T12:00:00+00:00",
        incident_id="11111111-1111-1111-1111-111111111111",
        warning_token=private_token,
        occurrence_count=2,
        acknowledged=True,
    )

    payload = project_library_watch_health(
        [problem],
        AllowedActions(("library.refresh",)),
    )

    assert payload == {
        "state": "warning",
        "repair_required": True,
        "problems": [
            {
                "root_key": opaque_root_key(private_root),
                "state": "root_unavailable",
                "detected_at": "2026-10-09T12:00:00+00:00",
                "incident_id": "11111111-1111-1111-1111-111111111111",
                "message": WATCH_HEALTH_MESSAGE,
                "acknowledged": True,
                "allowed_actions": {"library.refresh": True},
            }
        ],
    }
    encoded = json.dumps(payload)
    assert private_root not in encoded
    assert "Private Music" not in encoded
    assert "Secret Library" not in encoded
    assert private_token not in encoded
    assert "path" not in encoded.casefold()
    assert "exception" not in encoded.casefold()
