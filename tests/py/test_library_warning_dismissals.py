from music_app.services.library_warning_dismissals import warning_token


def test_warning_identity_changes_for_new_events_but_not_permissions_or_order():
    a = {"root_key": "a", "state": "overflow", "detected_at": "2026-09-12T10:00:00Z"}
    b = {"root_key": "b", "state": "root_unavailable", "detected_at": "2026-09-12T10:01:00Z"}
    token = warning_token({"state": "warning", "problems": [a, b]})
    assert token and len(token) == 64
    assert token == warning_token({"state": "warning", "problems": [b, {**a, "allowed_actions": {"library.refresh": True}}]})
    assert token != warning_token({"state": "warning", "problems": [a, {**b, "detected_at": "2026-09-12T10:02:00Z"}]})
    assert warning_token({"state": "healthy", "problems": []}) == ""


def test_repository_scopes_acknowledgements_to_the_authenticated_account():
    from music_app.services.library_warning_dismissals import PostgresLibraryWarningDismissals
    saved = {}
    class Connection:
        def __enter__(self): return self
        def __exit__(self, *_args): pass
        def execute(self, statement, params):
            if "update library.libraries" in statement:
                saved[params[0]] = params[1]
            else:
                self.row = {"token": saved.get(params[0])}
            return self
        def fetchone(self): return self.row
        def commit(self): pass
    repo = PostgresLibraryWarningDismissals({}, connect=lambda _: Connection())
    repo.save(7, "warning-one")
    assert repo.load(7) == "warning-one"
    assert repo.load(8) == ""
    repo.save(8, "warning-two")
    assert repo.load(7) == "warning-one"


def test_dismiss_route_rejects_a_newer_warning_and_uses_only_current_actor(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from music_app.routes import api_read_asgi_routes as routes
    health = {"state": "warning", "problems": [{"root_key": "root", "state": "overflow", "detected_at": "new"}]}
    saved = []
    repo = SimpleNamespace(save=lambda account, token: saved.append((account, token)))
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
    repo = SimpleNamespace(save=lambda account, token: saved.append((account, token)))
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
