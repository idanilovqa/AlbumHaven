"""Real completion route must retain authenticated scope through its bridge."""
import asyncio
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from music_app.routes import api_wave_b_asgi_routes as wave
from music_app.services import current_actor_asgi


@pytest.mark.parametrize('library,relationship,allowed',[(9,9,True),(9,None,False),(9,88,False),(None,None,False)])
def test_completion_scope_is_server_derived_before_history_callbacks(monkeypatch,library,relationship,allowed):
    actor=SimpleNamespace(account_id=7,is_authenticated=True,current_library_id=library,
        library_relationships=() if relationship is None else (SimpleNamespace(library_id=relationship),))
    async def resolve(_request):return actor
    monkeypatch.setattr(current_actor_asgi,'current_actor_from_request',resolve)
    monkeypatch.setattr(wave,'current_actor_from_request',resolve,raising=False)
    monkeypatch.setattr(wave,'_app_config',lambda _request:{})
    monkeypatch.setattr(wave,'_app_logger',lambda _request:None)
    monkeypatch.setattr(wave,'get_lastfm_user_timezone',lambda _config:'UTC')
    monkeypatch.setattr(wave,'get_saved_lastfm_session',lambda _config,**_scope:None)
    payload={'measurement_version':'rendered-pcm-v1','measured_listened_seconds':12.5,'max_measured_contiguous_seconds':12.5,
        'account_id':99,'library_id':88,'device_id':'cb94994e-b97e-4f92-968a-f9cb552a0694','session_id':'45d9facc-f9f8-46e0-a590-6743394144f5','sequence':1}
    async def body():return payload
    request=SimpleNamespace(json=body,state=SimpleNamespace(current_actor=actor),app=SimpleNamespace(state=SimpleNamespace(config={})))
    calls=[]
    def append(_config,entry,**scope):calls.append(scope);return {'id':'owned'}
    monkeypatch.setattr(wave,'append_listen_history_entry',append)
    def bridge(config,entry,**dependencies):
        scope={key:dependencies[key] for key in ('account_id','library_id') if key in dependencies}
        dependencies['append_listen_history_entry'](config,entry,**scope)
        return {'ok':True},200
    monkeypatch.setattr(wave,'record_playback_session_complete',bridge)
    try:code=asyncio.run(wave.playback_session_complete(request)).status_code
    except HTTPException as error:code=error.status_code
    if allowed:
        assert code==200 and calls==[{'account_id':7,'library_id':9}]
    else:
        assert code in (403,404) and calls==[]


def test_unversioned_authenticated_completion_cannot_reach_bootstrap_history(monkeypatch):
    actor = SimpleNamespace(account_id=7,is_authenticated=True,current_library_id=9,
        library_relationships=(SimpleNamespace(library_id=9),))
    async def resolve(request): return actor
    async def body(): return {"total_listened_seconds":100}
    monkeypatch.setattr(current_actor_asgi,"current_actor_from_request",resolve)
    monkeypatch.setattr(wave,"_app_config",lambda request:{})
    monkeypatch.setattr(wave,"_app_logger",lambda request:None)
    monkeypatch.setattr(wave,"get_lastfm_user_timezone",lambda config:"UTC")
    called=[]
    monkeypatch.setattr(wave,"record_playback_session_complete",lambda *args,**kwargs:(called.append(True) or {"ok":True},200))
    request=SimpleNamespace(json=body,state=SimpleNamespace(current_actor=actor),app=SimpleNamespace(state=SimpleNamespace(config={})))
    response=asyncio.run(wave.playback_session_complete(request))
    assert response.status_code==400 and called==[]
    assert b"unsupported_measurement" in response.body
