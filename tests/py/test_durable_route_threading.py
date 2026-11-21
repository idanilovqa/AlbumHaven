import asyncio
import threading
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize("route_name", ["refresh_api", "cancel_refresh_api", "refresh"])
def test_durable_scan_routes_offload_database_calls(monkeypatch, route_name):
    from music_app.routes import web_asgi as routes

    loop_thread = threading.get_ident()
    calls = []

    def database_call(**_values):
        calls.append(threading.get_ident())
        return SimpleNamespace(created=True)

    async def payload(_request):
        return {}

    evaluation = SimpleNamespace(audit=SimpleNamespace(library_id=9))
    repository = SimpleNamespace(
        enqueue_authorized_full_scan=database_call,
        cancel_authorized_full_scan=database_call,
    )
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(
            scan_job_repository=repository, config={}, library_state={},
        )),
        state=SimpleNamespace(policy_evaluation=evaluation), query_params={},
    )
    monkeypatch.setattr(routes, "_json_payload", payload)
    monkeypatch.setattr(routes, "_authorized_scan_request", lambda _request: (
        evaluation, 9, "network:origin", ("root-a",),
    ))

    response = asyncio.run(getattr(routes, route_name)(request))
    assert response.status_code in {200, 302}
    assert calls and all(thread_id != loop_thread for thread_id in calls)


@pytest.mark.parametrize("route_name", [
    "utilities_cover_lookup_tasks", "utilities_cancel_cover_scan",
    "utilities_fetch_covers_unsuccessful",
])
def test_durable_cover_routes_offload_database_calls(monkeypatch, route_name):
    from music_app.routes import api_wave_d_asgi_routes as routes

    loop_thread = threading.get_ident()
    calls = []

    def record(result):
        def execute(**_values):
            calls.append(threading.get_ident())
            return result
        return execute

    async def payload(_request):
        return {}

    async def history(_request, **_kwargs):
        return None

    repository = SimpleNamespace(
        list_candidate_lookup_tasks=record([]),
        request_bulk_refresh_cancellation=record({"cancelled": True}),
        current_inventory_revision=record(3),
        accept_bulk_refresh=record(SimpleNamespace(already_running=False)),
    )
    audit = SimpleNamespace(library_id=9, account_id=7,
                            deployment_mode="self_hosted", client_surface_class="private_web")
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(config={}, library_state={})))
    monkeypatch.setattr(routes, "_durable_cover_request_context", lambda _request: (repository, audit))
    monkeypatch.setattr(routes, "request_origin_ref_for_request", lambda _request: "network:origin")
    monkeypatch.setattr(routes, "list_cover_lookup_tasks", lambda **_kwargs: [])
    monkeypatch.setattr(routes, "_json_payload", payload)
    monkeypatch.setattr(routes, "history_scope_for_request", history)

    response = asyncio.run(getattr(routes, route_name)(request))
    assert response.status_code == 200
    assert calls and all(thread_id != loop_thread for thread_id in calls)
