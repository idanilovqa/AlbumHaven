"""Real completion route must retain authenticated scope through its bridge."""
import asyncio
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from uuid import uuid4
from pathlib import Path
from tests.py.test_settings_measured_listen_ledger import ledger
from music_app.services.playback_claims_postgres import PostgresPlaybackClaims
from music_app.services.playback_references import PlaybackReferenceService
from music_app.routes import api_wave_b_asgi_routes as wave
from music_app.services import current_actor_asgi


def authorized_playback(store):
    owner = store['own']
    config = {**store['config'], 'hmac': {'secret': 'test-playback-reference-secret-at-least-32-bytes', 'key_version': 1}}
    actor = SimpleNamespace(account_id=owner['account_id'], is_authenticated=True,
        current_library_id=owner['library_id'], library_relationships=(SimpleNamespace(library_id=owner['library_id']),))
    with store['connect']() as connection:
        connection.execute("insert into library.library_memberships (library_id, account_id, membership_role) values (%s, %s, 'owner')",
            (owner['library_id'], owner['account_id']))
        root = connection.execute("insert into library.library_roots (library_id, root_path) values (%s, %s) returning id",
            (owner['library_id'], str(Path(owner['path']).parent))).fetchone()['id']
        connection.execute("update library.local_track_files set library_root_id = %s where track_id = %s",
            (root, owner['track_id']))
    reference = PlaybackReferenceService(config).issue_batch(actor, [{'clientKey': 'track', 'path': owner['path']}])['tracks'][0]['playbackRef']
    client_id = str(uuid4())
    claim = PostgresPlaybackClaims(config).acquire(actor, client_id=client_id, client_surface='private_web',
        track={'playbackRef': reference, 'title': 'Track', 'artist': 'Owner', 'album': 'Album', 'artworkUrl': None})
    return actor, config, {'clientId': client_id, 'claimToken': claim['claimToken']}


@pytest.mark.parametrize('library,relationship,allowed',[(9,9,True),(9,None,False),(9,88,False),(None,None,False)])
def test_completion_scope_is_server_derived_before_history_callbacks(monkeypatch,ledger,library,relationship,allowed):
    actor, config, claim = authorized_playback(ledger)
    owner = ledger['own']
    actor.current_library_id = owner['library_id'] if library == 9 else None
    actor.library_relationships = () if relationship is None else (SimpleNamespace(library_id=owner['library_id'] if relationship == 9 else ledger['other']['library_id']),)
    async def resolve(_request):return actor
    monkeypatch.setattr(current_actor_asgi,'current_actor_from_request',resolve)
    monkeypatch.setattr(wave,'current_actor_from_request',resolve,raising=False)
    monkeypatch.setattr(wave,'_app_config',lambda _request:config)
    monkeypatch.setattr(wave,'_app_logger',lambda _request:None)
    monkeypatch.setattr(wave,'get_lastfm_user_timezone',lambda _config:'UTC')
    monkeypatch.setattr(wave,'get_saved_lastfm_session',lambda _config,**_scope:None)
    payload={'measurement_version':'rendered-pcm-v1','measured_listened_seconds':12.5,'max_measured_contiguous_seconds':12.5,
        'account_id':99,'library_id':88,'device_id':'cb94994e-b97e-4f92-968a-f9cb552a0694','session_id':'45d9facc-f9f8-46e0-a590-6743394144f5','sequence':1}
    payload.update(claim)
    async def body():return payload
    request=SimpleNamespace(json=body,state=SimpleNamespace(current_actor=actor),app=SimpleNamespace(state=SimpleNamespace(config=config,auth_policy_config={})))
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
        assert code==200 and calls==[{'account_id':owner['account_id'],'library_id':owner['library_id']}]
    else:
        assert code in (403,404) and calls==[]


def test_unversioned_authenticated_completion_cannot_reach_bootstrap_history(monkeypatch,ledger):
    actor, config, claim = authorized_playback(ledger)
    async def resolve(request): return actor
    async def body(): return {"total_listened_seconds":100, **claim}
    monkeypatch.setattr(current_actor_asgi,"current_actor_from_request",resolve)
    monkeypatch.setattr(wave,"_app_config",lambda request:config)
    monkeypatch.setattr(wave,"_app_logger",lambda request:None)
    monkeypatch.setattr(wave,"get_lastfm_user_timezone",lambda config:"UTC")
    called=[]
    monkeypatch.setattr(wave,"record_playback_session_complete",lambda *args,**kwargs:(called.append(True) or {"ok":True},200))
    request=SimpleNamespace(json=body,state=SimpleNamespace(current_actor=actor),app=SimpleNamespace(state=SimpleNamespace(config=config,auth_policy_config={})))
    response=asyncio.run(wave.playback_session_complete(request))
    assert response.status_code==400 and called==[]
    assert b"unsupported_measurement" in response.body
