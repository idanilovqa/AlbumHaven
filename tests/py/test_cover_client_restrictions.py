"""TV cover restrictions at the production route boundary, with unit repository doubles."""
import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request

from music_app.routes import api_wave_d_asgi_routes as routes


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
