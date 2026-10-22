"""Real ASGI disconnect must reach the worker callback, not just cancel an await."""
import asyncio
import json
from threading import Event
from time import monotonic
from test_library_mix_route_boundary import boundary, SESSION_TOKEN
from music_app.services.auth_session_csrf import issue_session_csrf
from test_sample_facet_routes import COUNTRY, body, instrument


def test_request_disconnect_sets_running_country_worker_cancellation_event(boundary, monkeypatch):
    instrument(monkeypatch, boundary, COUNTRY)
    entered, observed, exited = Event(), Event(), Event()
    def worker(context, selector, selection_method, targets, constraints=None, should_cancel=None):
        assert callable(should_cancel)
        entered.set(); deadline = monotonic() + 5
        try:
            while monotonic() < deadline:
                if should_cancel():
                    observed.set()
                    return {"status": "ready", "data": {"selection_method": selection_method,
                        "results": [{**targets[0], "status": "cancelled"}]}}
                observed.wait(0.001)
            raise AssertionError("Disconnect cancelled an await but never signalled the running worker")
        finally:
            exited.set()
    monkeypatch.setattr(boundary.owner, "enrich_sample_country_metadata", worker)
    csrf = issue_session_csrf(SESSION_TOKEN, boundary.app.state.auth_policy_config)
    raw = json.dumps(body(COUNTRY)).encode()
    headers = {"host": "music.test", "origin": "https://music.test", "content-type": "application/json",
        "content-length": str(len(raw)), "x-album-haven-csrf": csrf,
        "cookie": f"__Host-album_haven_session={SESSION_TOKEN}; __Host-album_haven_csrf={csrf}",
        "x-albumhaven-context": boundary.context_ref()}
    async def run():
        initial = True; messages = []
        async def receive():
            nonlocal initial
            if initial:
                initial = False
                return {"type": "http.request", "body": raw, "more_body": False}
            assert await asyncio.to_thread(entered.wait, 5)
            return {"type": "http.disconnect"}
        async def send(message):
            messages.append(message)
        await asyncio.wait_for(boundary.app({"type": "http", "asgi": {"version": "3.0"},
            "http_version": "1.1", "method": "POST", "scheme": "https", "path": COUNTRY,
            "raw_path": COUNTRY.encode(), "query_string": b"",
            "headers": [(k.encode(), v.encode()) for k, v in headers.items()],
            "client": ("192.0.2.10", 50000), "server": ("music.test", 443)}, receive, send), timeout=10)
        assert await asyncio.to_thread(exited.wait, 5)
    asyncio.run(run())
    assert entered.is_set() and observed.is_set() and exited.is_set()
