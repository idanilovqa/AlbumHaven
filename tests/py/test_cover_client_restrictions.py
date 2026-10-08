"""TV cover restrictions at the production route boundary, with unit repository doubles."""
import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request

from music_app.routes import api_wave_d_asgi_routes as routes


@pytest.mark.parametrize("source", ["task", "snapshot"])
@pytest.mark.parametrize("group", ["manual_links", "local", None])
def test_tv_remote_selection_rejects_nonprovider_server_candidate_before_mutation(monkeypatch, source, group):
    app = FastAPI()
    request = Request({"type": "http", "method": "POST", "path": "/utilities/cover-lookup/save-remote",
        "headers": [(b"user-agent", b"SMART-TV Tizen")], "app": app})
    match = {"id": "candidate", "lookup_group": group, "source": "spotify", "source_label": "Spotify"}
    payload = {"album": {"artist": "Fixture", "album": "Album"}, "task_id": "task",
        "candidate_id": "candidate", "snapshot_generation": "generation",
        "lookup_group": "services", "source": "spotify"}
    async def json_payload(_request):
        return payload
    monkeypatch.setattr(routes, "_json_payload", json_payload)
    monkeypatch.setattr(routes, "_app_config", lambda request: {})
    monkeypatch.setattr(routes, "_app_logger", lambda request: None)
    monkeypatch.setattr(routes, "_library_state", lambda request: None)
    monkeypatch.setattr(routes, "resolve_album_context", lambda *args: SimpleNamespace(
        track_paths=["fixture.mp3"], album_root=Path("fixture")))
    monkeypatch.setattr(routes, "cover_lookup_result", lambda task_id:
        {"possible_matches": [match]} if source == "task" else None)
    repository = SimpleNamespace(get_for_album_context=lambda **kwargs:
        {"search_generation": "generation", "candidates": [match]})
    monkeypatch.setattr(routes, "_resolved_snapshot_album_context", lambda *args: (repository, 41, None))
    monkeypatch.setattr(routes, "_task_matches_album_context", lambda *args, **kwargs: True)
    def forbidden(*args, **kwargs):
        pytest.fail("Denied TV selection must not create tasks, mutate state, or queue downloads")
    for name in ["create_cover_lookup_task", "update_cover_lookup_task", "queue_cover_lookup_save_remote_task"]:
        monkeypatch.setattr(routes, name, forbidden)
    response = asyncio.run(routes.utilities_cover_lookup_save_remote(request))
    assert response.status_code == 403
    assert b"Only provider cover candidates" in response.body


def test_tv_local_cover_selection_is_rejected_before_reading_album_or_files(monkeypatch):
    request = Request({"type": "http", "method": "POST", "path": "/utilities/cover-lookup/local-select",
        "headers": [(b"user-agent", b"SMART-TV Tizen")]})
    def forbidden(*args, **kwargs):
        pytest.fail("TV local selection must be denied before album resolution")
    monkeypatch.setattr(routes, "_app_config", forbidden)
    response = asyncio.run(routes.utilities_cover_lookup_local_select(request))
    assert response.status_code == 403


def test_tv_manual_urls_are_rejected_before_starting_lookup(monkeypatch):
    request = Request({"type": "http", "method": "POST", "path": "/utilities/cover-lookup/start",
        "headers": [(b"user-agent", b"SMART-TV Tizen")]})
    async def history_scope(*args, **kwargs):
        return None
    async def payload(_request):
        return {"album": {"artist": "Fixture", "album": "Album"},
            "manual_urls": ["https://i.scdn.co/image/a"]}
    monkeypatch.setattr(routes, "history_scope_for_request", history_scope)
    monkeypatch.setattr(routes, "_json_payload", payload)
    monkeypatch.setattr(routes, "_app_config", lambda request: {})
    monkeypatch.setattr(routes, "_app_logger", lambda request: None)
    def forbidden(*args, **kwargs):
        pytest.fail("Manual TV URLs must be denied before resolving or creating a lookup")
    monkeypatch.setattr(routes, "resolve_album_context", forbidden)
    response = asyncio.run(routes.utilities_cover_lookup_start(request))
    assert response.status_code == 403
