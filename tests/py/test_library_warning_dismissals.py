from music_app.services.library_warning_dismissals import warning_token


def test_warning_identity_changes_for_new_events_but_not_permissions_or_order():
    a = {"root_key": "a", "state": "overflow", "detected_at": "2026-09-12T10:00:00Z"}
    b = {"root_key": "b", "state": "root_unavailable", "detected_at": "2026-09-12T10:01:00Z"}
    token = warning_token({"state": "warning", "problems": [a, b]})
    assert token and len(token) == 64
    assert token == warning_token({"state": "warning", "problems": [b, {**a, "allowed_actions": {"library.refresh": True}}]})
    assert token != warning_token({"state": "warning", "problems": [a, {**b, "detected_at": "2026-09-12T10:02:00Z"}]})
    assert warning_token({"state": "healthy", "problems": []}) == ""
    assert warning_token({"state": "warning", "problems": []}) == ""


def test_durable_warning_identity_normalizes_postgres_timestamp_precision():
    problem = {
        "root_key": "root-key",
        "state": "overflow",
        "detected_at": "2026-10-09T20:27:01.13713-06:00",
        "event_id": "6ecc97df-bc41-4191-87fc-8ceb9ab0e80e",
    }
    padded = {**problem, "detected_at": "2026-10-09T20:27:01.137130-06:00"}

    assert warning_token({"state": "warning", "problems": [problem]}) == warning_token(
        {"state": "warning", "problems": [padded]}
    )


def test_durable_warning_identity_normalizes_equivalent_timezone_offsets():
    problem = {
        "root_key": "root-key",
        "state": "overflow",
        "detected_at": "2026-10-09T20:27:01.137130-06:00",
        "event_id": "6ecc97df-bc41-4191-87fc-8ceb9ab0e80e",
    }
    utc = {**problem, "detected_at": "2026-10-10T02:27:01.137130+00:00"}

    assert warning_token({"state": "warning", "problems": [problem]}) == warning_token(
        {"state": "warning", "problems": [utc]}
    )


def test_durable_warning_identity_uses_only_immutable_incident_identity():
    problem = {
        "root_key": "old-root-key",
        "state": "overflow",
        "detected_at": "2026-10-09T20:27:01.137130-06:00",
        "event_id": "6ecc97df-bc41-4191-87fc-8ceb9ab0e80e",
    }

    assert warning_token({"state": "warning", "problems": [problem]}) == warning_token(
        {
            "state": "warning",
            "problems": [
                {
                    **problem,
                    "root_key": "renamed-root-key",
                    "state": "root_unavailable",
                    "detected_at": "2026-10-10T02:31:45+00:00",
                }
            ],
        }
    )


def test_legacy_warning_identity_preserves_original_timestamp_text():
    legacy = {
        "root_key": "root-key",
        "state": "overflow",
        "detected_at": "2026-10-09T20:27:01-06:00",
    }
    equivalent = {**legacy, "detected_at": "2026-10-10T02:27:01+00:00"}

    assert warning_token({"state": "warning", "problems": [legacy]}) != warning_token(
        {"state": "warning", "problems": [equivalent]}
    )


def test_health_store_outages_remain_visible_and_cannot_be_dismissed():
    from types import SimpleNamespace
    from music_app.routes import api_read_asgi_routes as routes

    class UnavailableHealth:
        def load_problems(self):
            raise RuntimeError("database unavailable")

    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(library_watch_health_service=UnavailableHealth())
        )
    )
    for _attempt in range(2):
        health = routes._project_library_watch_health_for_request(request)
        assert health == {"state": "warning", "problems": []}
        assert warning_token(health) == ""


def test_repository_scopes_acknowledgements_to_the_authenticated_account():
    from music_app.services.library_warning_dismissals import PostgresLibraryWarningDismissals
    from music_app.services.library_watch_health import opaque_root_key
    acknowledged = {}
    calls = []

    class Connection:
        def __enter__(self): return self
        def __exit__(self, *_args): pass
        def execute(self, statement, params):
            calls.append((statement, params))
            if "acknowledge_local_watcher_incidents" in statement:
                acknowledged[params[0]] = [{
                    "root_id": "root-a",
                    "state": "overflow",
                    "detected_at": "2026-09-12T10:00:00Z",
                    "event_id": "6ecc97df-bc41-4191-87fc-8ceb9ab0e80e",
                }]
                self.rows = [{"acknowledged_count": 1}]
            else:
                self.rows = acknowledged.get(params[0], [])
            return self
        def fetchall(self): return self.rows
        def fetchone(self): return self.rows[0] if self.rows else None
        def commit(self): pass

    repo = PostgresLibraryWarningDismissals({}, connect=lambda _: Connection())
    warning_one = warning_token({"state": "warning", "problems": [{
        "root_key": opaque_root_key("root-a"),
        "state": "overflow",
        "detected_at": "2026-09-12T10:00:00Z",
        "event_id": "6ecc97df-bc41-4191-87fc-8ceb9ab0e80e",
    }]})
    warning_health = {"state": "warning", "problems": [{
        "root_key": opaque_root_key("root-a"),
        "state": "overflow",
        "detected_at": "2026-09-12T10:00:00Z",
        "event_id": "6ecc97df-bc41-4191-87fc-8ceb9ab0e80e",
    }]}
    repo.save(7, warning_one, warning_health)
    assert repo.load(7) == warning_one
    assert repo.load(8) == ""
    assert any("load_local_watcher_incident_acknowledgements" in sql for sql, _ in calls)
    assert all("library.libraries.metadata" not in sql for sql, _ in calls)


def test_repository_rejects_partial_durable_acknowledgement():
    import pytest
    from music_app.services.library_warning_dismissals import (
        PostgresLibraryWarningDismissals,
        warning_token,
    )

    committed = []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def execute(self, _statement, _params):
            return self

        def fetchone(self):
            return {"acknowledged_count": 0}

        def commit(self):
            committed.append(True)

    event_id = "6ecc97df-bc41-4191-87fc-8ceb9ab0e80e"
    health = {
        "state": "warning",
        "problems": [
            {
                "root_key": "root-key",
                "state": "overflow",
                "detected_at": "2026-10-09T20:27:01.137130-06:00",
                "event_id": event_id,
            }
        ],
    }
    repository = PostgresLibraryWarningDismissals(
        {}, connect=lambda _url: Connection()
    )

    with pytest.raises(RuntimeError, match="acknowledgement changed"):
        repository.save(7, warning_token(health), health)

    assert committed == []


def test_dismiss_route_rejects_a_newer_warning_and_uses_only_current_actor(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from music_app.routes import api_read_asgi_routes as routes
    health = {"state": "warning", "problems": [{"root_key": "root", "state": "overflow", "detected_at": "new"}]}
    saved = []
    repo = SimpleNamespace(save=lambda account, token, _health: saved.append((account, token)))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(library_warning_dismissals=repo)), state=SimpleNamespace(current_actor=SimpleNamespace(account_id=7)))
    payload = {"token": "a" * 64, "account_id": 8}
    async def read(_request): return payload
    monkeypatch.setattr(routes, "read_bounded_json_object", read)
    monkeypatch.setattr(routes, "_project_library_watch_health_for_request", lambda _: health)
    assert asyncio.run(routes.dismiss_library_warning(request)).status_code == 409
    assert saved == []
    payload["token"] = warning_token(health)
    assert asyncio.run(routes.dismiss_library_warning(request)).status_code == 200
    assert saved == [(7, warning_token(health))]
    payload["token"] = "invalid"
    assert asyncio.run(routes.dismiss_library_warning(request)).status_code == 400


def test_dismiss_route_rejects_recovered_same_clock_warning_from_stale_alert(monkeypatch):
    import asyncio
    from datetime import datetime, timezone
    from pathlib import Path
    from types import SimpleNamespace
    from music_app.routes import api_read_asgi_routes as routes
    from music_app.services import library_watch_health as health

    class Store:
        def __init__(self):
            self.problems = {}

        def upsert(self, problem):
            self.problems[problem.root_id] = problem

        def load(self):
            return list(self.problems.values())

        def clear(self, roots, *, detected_before):
            cleared = [root for root in roots if root in self.problems
                       and self.problems[root].detected_at <= detected_before]
            for root in cleared:
                del self.problems[root]
            return len(cleared)

    tick = datetime(2026, 9, 10, tzinfo=timezone.utc)
    service = health.LibraryWatchHealthService(Store(), now=lambda: tick)
    event = health.LibraryEvent(health.LibraryEventKind.OVERFLOW, "main", Path("C:/Music"))
    service.record_event(event)

    def projection(_request):
        return {"state": "warning", "problems": [
            problem.as_public_dict() for problem in service.load_problems()
        ]}

    saved = []
    repo = SimpleNamespace(save=lambda account, token, _health: saved.append((account, token)))
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(library_warning_dismissals=repo)),
        state=SimpleNamespace(current_actor=SimpleNamespace(account_id=7)),
    )
    payload = {"token": warning_token(projection(request))}

    async def read(_request):
        return payload

    monkeypatch.setattr(routes, "read_bounded_json_object", read)
    monkeypatch.setattr(routes, "_project_library_watch_health_for_request", projection)
    assert asyncio.run(routes.dismiss_library_warning(request)).status_code == 200
    acknowledged = saved[:]
    service.clear_after_scan(scan_mode="manual_full_rescan", observed_root_ids=["main"])
    service.record_event(event)

    assert asyncio.run(routes.dismiss_library_warning(request)).status_code == 409
    assert saved == acknowledged, "the old alert must not acknowledge the new same-clock event"
    payload["token"] = warning_token(projection(request))
    assert asyncio.run(routes.dismiss_library_warning(request)).status_code == 200
    assert saved[-1] == (7, payload["token"])
    assert saved[-1] != acknowledged[-1]
