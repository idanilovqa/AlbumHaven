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
    from datetime import datetime, timezone

    from music_app.services.library_warning_dismissals import (
        PostgresLibraryWarningDismissals,
    )

    acknowledged = {}
    calls = []

    class Connection:
        def __enter__(self): return self
        def __exit__(self, *_args): pass
        def execute(self, statement, params):
            normalized = " ".join(statement.split())
            calls.append((normalized, params))
            if "acknowledge_watcher_incident" in normalized:
                acknowledged[params[1]] = params[2]
                self.rows = [(True,)]
            else:
                token = acknowledged.get(params[1])
                self.rows = ([{"warning_token": token}] if token else [])
            return self
        def fetchall(self): return self.rows
        def fetchone(self): return self.rows[0] if self.rows else None
        def commit(self): pass

    repo = PostgresLibraryWarningDismissals({}, connect=lambda _: Connection())
    repo.library_id = 19
    repo.now = lambda: datetime(2026, 10, 9, 12, tzinfo=timezone.utc)
    warning = "22222222-2222-2222-2222-222222222222"

    repo.save(7, warning)

    assert repo.load(7) == warning
    assert repo.load(8) == ""
    assert any("acknowledge_watcher_incident" in sql for sql, _ in calls)
    assert any("acknowledge_watcher_incident" not in sql for sql, _ in calls)
    assert all("library.libraries.metadata" not in sql for sql, _ in calls)


def test_repository_rejects_stale_durable_incident_token_without_committing():
    from datetime import datetime, timezone

    import pytest
    from music_app.services.library_warning_dismissals import (
        PostgresLibraryWarningDismissals,
    )

    committed = []
    executed = []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def execute(self, statement, params):
            executed.append((" ".join(statement.split()), params))
            return self

        def fetchone(self):
            return (False,)

        def commit(self):
            committed.append(True)

    repository = PostgresLibraryWarningDismissals(
        {}, connect=lambda _url: Connection()
    )
    repository.library_id = 19
    repository.now = lambda: datetime(2026, 10, 9, 12, tzinfo=timezone.utc)
    token = "22222222-2222-2222-2222-222222222222"

    with pytest.raises(ValueError, match="incident is not current"):
        repository.save(7, token)

    assert executed == [
        (
            "select library.acknowledge_watcher_incident(%s, %s, %s::uuid, %s)",
            (19, 7, token, repository.now()),
        )
    ]
    assert committed == []


def test_dismiss_route_rejects_a_newer_warning_and_uses_only_current_actor(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from music_app.routes import api_read_asgi_routes as routes
    health = {"state": "warning", "problems": [{"root_key": "root", "state": "overflow", "detected_at": "new"}]}
    saved = []
    repo = SimpleNamespace(
        save=lambda account, token, *_health: saved.append((account, token))
    )
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


def test_dismiss_route_returns_conflict_when_durable_token_is_stale(monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from music_app.routes import api_read_asgi_routes as routes

    incident_id = "11111111-1111-1111-1111-111111111111"
    durable_token = "22222222-2222-2222-2222-222222222222"
    health = {
        "state": "warning",
        "problems": [
            {
                "root_key": "root_opaque",
                "state": "overflow",
                "detected_at": "2026-10-09T12:00:00+00:00",
                "incident_id": incident_id,
                "event_id": incident_id,
                "warning_token": durable_token,
            }
        ],
    }
    token = warning_token(health)
    calls = []

    def reject_stale(*args):
        calls.append(args)
        raise ValueError("watcher incident is not current")

    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                library_warning_dismissals=SimpleNamespace(save=reject_stale)
            )
        ),
        state=SimpleNamespace(current_actor=SimpleNamespace(account_id=7)),
    )

    async def read(_request):
        return {"token": token}

    monkeypatch.setattr(routes, "read_bounded_json_object", read)
    monkeypatch.setattr(
        routes,
        "_project_library_watch_health_for_request",
        lambda _request: health,
    )

    response = asyncio.run(routes.dismiss_library_warning(request))

    assert response.status_code == 409
    assert calls
