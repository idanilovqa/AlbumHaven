from __future__ import annotations

import asyncio
from types import SimpleNamespace

from music_app.routes import api_wave_b_asgi_routes as routes
from tests.py.asgi_testing import decode_json


class Request:
    def __init__(self, payload=None):
        self.app = SimpleNamespace(state=SimpleNamespace(config={}))
        self.state = SimpleNamespace(current_actor=object())
        self.query_params = {"cue_segment_ref": "cue:track-2"}
        self._payload = payload

    async def json(self):
        return self._payload


def test_cue_editor_route_requires_edit_tags_and_returns_path_free_state(monkeypatch):
    checks = []

    async def allowed(request):
        checks.append(request)

    class Service:
        def __init__(self, _config):
            pass

        def load_editor(self, **kwargs):
            assert kwargs == {
                "actor": request.state.current_actor,
                "cue_segment_ref": "cue:track-2",
            }
            return {"base_revision_sha256": "a" * 64, "tracks": []}

    request = Request()
    monkeypatch.setattr(routes, "require_action", lambda action: allowed if action == "library.files.edit_tags" else None)
    monkeypatch.setattr(routes, "CueCorrectionService", Service)

    response = asyncio.run(routes.utilities_cue_editor(request))

    assert response.status_code == 200
    assert decode_json(response.body)["tracks"] == []
    assert checks == [request]


def test_cue_correction_route_applies_and_restores_through_one_endpoint(monkeypatch):
    calls = []

    async def allowed(_request):
        return None

    class Service:
        def __init__(self, _config):
            pass

        def apply(self, **kwargs):
            calls.append(("apply", kwargs))
            return {"ok": True, "correction_id": 9}

        def restore(self, **kwargs):
            calls.append(("restore", kwargs))
            return {"ok": True, "restored": True}

    monkeypatch.setattr(routes, "require_action", lambda _action: allowed)
    monkeypatch.setattr(routes, "CueCorrectionService", Service)

    apply_request = Request({"action": "apply", "kind": "boundary"})
    restore_request = Request({
        "action": "restore",
        "cue_segment_ref": "cue:track-2",
        "kind": "boundary",
    })
    applied = asyncio.run(routes.utilities_cue_corrections(apply_request))
    restored = asyncio.run(routes.utilities_cue_corrections(restore_request))

    assert decode_json(applied.body) == {"ok": True, "correction_id": 9}
    assert decode_json(restored.body) == {"ok": True, "restored": True}
    assert calls[0][0] == "apply"
    assert calls[0][1]["payload"] == {"kind": "boundary"}
    assert calls[1] == ("restore", {
        "actor": restore_request.state.current_actor,
        "cue_segment_ref": "cue:track-2",
        "kind": "boundary",
    })
