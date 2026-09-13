"""Measured completions cannot borrow the configured host Last.fm credential."""
import pytest
from music_app.services import lastfm_sync_bridge as bridge
from music_app.services import listen_history


def measured_payload(**changes):
    return {"measurement_version": "rendered-pcm-v1", "measured_listened_seconds": 12.5,
        "max_measured_contiguous_seconds": 12.5, "device_id": "cb94994e-b97e-4f92-968a-f9cb552a0694",
        "session_id": "45d9facc-f9f8-46e0-a590-6743394144f5", "sequence": 1, "finalized": True,
        "title": "Song", "artist": "Artist", "duration_seconds": 180,
        "total_listened_seconds": 100, "max_contiguous_seconds": 100,
        "started_at": "2026-09-09T12:00:00+00:00", "started_at_unix": 1788955200,
        "library_track_id": "11", "account_id": 99, "library_id": 88, **changes}


def invoke(payload, monkeypatch, *, lastfm_session=None):
    from contextlib import nullcontext
    monkeypatch.setattr(bridge, "measured_provider_guard", lambda *_args, **_kwargs: nullcontext())
    calls = []
    def forbidden(*args, **kwargs):
        pytest.fail("measured completion touched configured host provider or legacy sync state")
    monkeypatch.setattr(bridge, "clear_pending_scrobble", forbidden)
    monkeypatch.setattr(bridge, "record_pending_scrobble", forbidden)
    def append(config, entry, **scope):
        calls.append((dict(entry), scope))
        return {**entry, "id": "scoped-measured-row"}
    def update(config, entry_id, values, **scope):
        assert scope == {"account_id": 7, "library_id": 9}
        return {**calls[-1][0], **values, "id": entry_id}
    def own_provider(config, payload, *, session):
        assert session is lastfm_session and session is not None
        return None
    result = bridge.record_playback_session_complete(
        {"LASTFM_API_ENABLED": True}, payload, account_id=7, library_id=9, user_timezone="UTC",
        normalize_playback_track_payload=lambda item: item,
        is_meaningful_listen_session=listen_history.is_meaningful_listen_session,
        append_listen_history_entry=append, update_listen_history_entry=update,
        scrobble_track=own_provider if lastfm_session else forbidden, log_lastfm_scrobble_event=lambda *args, **kwargs: None,
        lastfm_session=lastfm_session)
    return result, calls


@pytest.mark.parametrize("client_scrobbled", [False, True])
def test_measured_completion_stays_pending_without_account_credential(monkeypatch, client_scrobbled):
    (body, status), calls = invoke(measured_payload(scrobbled=client_scrobbled), monkeypatch)
    assert status == 200 and len(calls) == 1
    entry, scope = calls[0]
    assert scope == {"account_id": 7, "library_id": 9}
    assert entry["measurement_version"] == "rendered-pcm-v1"
    assert entry["measured_listened_seconds"] == 12.5
    assert entry["device_id"] == measured_payload()["device_id"]
    assert not entry.get("scrobbled") and not body["scrobbled"]
    assert "credential" in str(body["scrobble_error"]).lower()
    assert body["entry"].get("sync_problem")


@pytest.mark.parametrize("changes", [
    {"measured_listened_seconds": float("nan")},
    {"measured_listened_seconds": -1},
    {"max_measured_contiguous_seconds": 13},
    {"sequence": True}, {"session_id": "invalid"},
])
def test_malformed_measured_completion_is_rejected_before_legacy_meaningful_shortcut(monkeypatch, changes):
    payload = measured_payload(total_listened_seconds=0, max_contiguous_seconds=0, **changes)
    try:
        (body, status), calls = invoke(payload, monkeypatch)
    except ValueError as error:
        assert getattr(error, "status_code", 400) == 400
    else:
        assert status == 400 and calls == []


@pytest.mark.parametrize("route_name", ["playback_session_now_playing", "playback_session_scrobble"])
def test_measured_live_provider_routes_do_not_use_host_credentials(monkeypatch, route_name):
    import asyncio
    import json
    from types import SimpleNamespace
    from music_app.routes import api_wave_b_asgi_routes as wave
    from music_app.services import current_actor_asgi
    actor = SimpleNamespace(account_id=7, is_authenticated=True, current_library_id=9,
                            library_relationships=(SimpleNamespace(library_id=9),))
    async def resolve(_request): return actor
    async def body(): return measured_payload()
    monkeypatch.setattr(current_actor_asgi, "current_actor_from_request", resolve)
    monkeypatch.setattr(wave, "current_actor_from_request", resolve, raising=False)
    monkeypatch.setattr(wave, "_app_config", lambda _request: {"LASTFM_API_ENABLED": True})
    monkeypatch.setattr(wave, "_app_logger", lambda _request: None)
    monkeypatch.setattr(wave, "get_saved_lastfm_session", lambda _config, *, account_id: None, raising=False)
    def forbidden(*args, **kwargs): pytest.fail("measured route used configured host Last.fm credential")
    monkeypatch.setattr(wave, "update_now_playing", forbidden)
    monkeypatch.setattr(wave, "scrobble_track", forbidden)
    request = SimpleNamespace(json=body, state=SimpleNamespace(current_actor=actor),
                              app=SimpleNamespace(state=SimpleNamespace(config={})))
    response = asyncio.run(getattr(wave, route_name)(request))
    payload = json.loads(response.body)
    assert response.status_code == 409
    assert payload == {"ok": False, "error": "account_scoped_scrobble_unavailable", "retryable": False}


def test_measured_completion_preserves_existing_own_account_scrobbling(monkeypatch):
    from music_app.services.lastfm import LastfmSession
    session = LastfmSession('own-user', 'own-test-session', '')
    (body, status), calls = invoke(measured_payload(scrobbled=False), monkeypatch, lastfm_session=session)
    assert status == 200 and body['scrobbled'] is True
    assert calls[0][1] == {'account_id': 7, 'library_id': 9}
    assert body['entry']['id'] == 'scoped-measured-row'


@pytest.mark.parametrize("route_name, provider_name", [
    ("playback_session_now_playing", "update_now_playing"),
    ("playback_session_scrobble", "scrobble_track"),
])
def test_measured_live_provider_uses_only_current_actor_session(monkeypatch, route_name, provider_name):
    import asyncio
    from types import SimpleNamespace
    from music_app.routes import api_wave_b_asgi_routes as wave
    from music_app.services import current_actor_asgi
    from music_app.services.lastfm import LastfmSession
    actor = SimpleNamespace(account_id=7,is_authenticated=True,current_library_id=9,
                            library_relationships=(SimpleNamespace(library_id=9),))
    async def resolve(_request): return actor
    async def body(): return measured_payload(account_id=99)
    session = LastfmSession('own-user', 'own-test-session', '')
    def credential(config, *, account_id):
        assert account_id == 7
        return session
    calls = []
    def provider(config, payload, *, session): calls.append(session); return None
    monkeypatch.setattr(current_actor_asgi, 'current_actor_from_request', resolve)
    monkeypatch.setattr(wave, 'current_actor_from_request', resolve, raising=False)
    monkeypatch.setattr(wave, '_app_config', lambda _request: {})
    monkeypatch.setattr(wave, '_app_logger', lambda _request: SimpleNamespace(log=lambda *args:None))
    monkeypatch.setattr(wave, 'get_saved_lastfm_session', credential, raising=False)
    monkeypatch.setattr(wave, provider_name, provider)
    if route_name == 'playback_session_scrobble':
        def scoped_bridge(config, entry, **dependencies):
            assert dependencies['account_id'] == 7 and dependencies['library_id'] == 9
            assert entry['finalized'] is False
            dependencies['scrobble_track'](config, entry, session=dependencies['lastfm_session'])
            return {'ok': True, 'scrobbled': True}, 200
        monkeypatch.setattr(wave, 'record_playback_session_complete', scoped_bridge)
    monkeypatch.setattr(wave, '_log_lastfm_scrobble_event', lambda *args,**kwargs:None)
    request=SimpleNamespace(json=body,state=SimpleNamespace(current_actor=actor),app=SimpleNamespace(state=SimpleNamespace(config={})))
    response=asyncio.run(getattr(wave,route_name)(request))
    assert response.status_code == 200 and calls == [session]


@pytest.mark.parametrize('provider_name',['update_now_playing','scrobble_track'])
def test_explicit_missing_provider_session_cannot_fall_back_to_host(monkeypatch, provider_name):
    from music_app.services import lastfm
    monkeypatch.setattr(lastfm,'get_saved_lastfm_session',lambda *_args,**_kwargs:pytest.fail('explicit missing account session fell back to host'))
    result=getattr(lastfm,provider_name)({}, {'artist':'Artist','track':'Song','timestamp':1}, session=None)
    assert result.sent is False
