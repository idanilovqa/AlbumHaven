"""Connection lifecycle must use the authenticated credential owner."""
import asyncio
from types import SimpleNamespace
import pytest
from music_app.routes import api_wave_b_asgi_routes as wave
from music_app.services import current_actor_asgi


@pytest.mark.parametrize("action", ["disconnect", "timezone", "connect"])
def test_connection_lifecycle_forwards_account_scope_not_payload(monkeypatch, action):
    actor = SimpleNamespace(is_authenticated=True, account_id=7, current_library_id=9,
        library_relationships=(SimpleNamespace(library_id=9),))
    async def resolve(request): return actor
    payload = {"account_id":99,"username":"own","password":"fixture-only","timezone":"UTC"}
    if action == "disconnect": payload["disconnect"] = True
    if action == "timezone": payload["save_timezone_only"] = True
    async def body(): return payload
    request = SimpleNamespace(json=body,state=SimpleNamespace(current_actor=actor),app=SimpleNamespace(state=SimpleNamespace(config={})))
    calls = []
    def capture(*args, **kwargs): calls.append(kwargs.get("account_id")); return {"key":"lastfm"}
    monkeypatch.setattr(current_actor_asgi,"current_actor_from_request",resolve)
    monkeypatch.setattr(wave,"_app_config",lambda request:{})
    monkeypatch.setattr(wave,"_app_logger",lambda request:None)
    monkeypatch.setattr(wave,"lastfm_api_enabled",lambda config:True)
    monkeypatch.setattr(wave,"clear_lastfm_settings",capture)
    monkeypatch.setattr(wave,"save_lastfm_user_timezone",capture)
    monkeypatch.setattr(wave,"authenticate_lastfm",capture)
    monkeypatch.setattr(wave,"build_lastfm_status",lambda *args,**kwargs:{"key":"lastfm"})
    monkeypatch.setattr(wave,"_enrich_lastfm_status",lambda config,status,**kwargs:status)
    monkeypatch.setattr(wave,"retry_pending_lastfm_scrobbles",lambda *args,**kwargs:None)
    response = asyncio.run(wave.utilities_lastfm_settings(request))
    assert response.status_code == 200 and calls == [7]
