from __future__ import annotations
import asyncio
from pathlib import Path
from types import SimpleNamespace
import pytest
from music_app.services import loops

@pytest.mark.parametrize('kind', ['media','preview'])
def test_saved_media_resolution_checks_exact_scope_before_opening_bytes(tmp_path,monkeypatch,kind):
    root=tmp_path/('loops' if kind=='media' else 'loop_previews'); root.mkdir()
    identity='same-id' if kind=='media' else 'same-id_pplus2'
    (root/f'{identity}.mp3').write_bytes(b'other-actor-bytes')
    calls=[]
    def scoped_get(config,loop_id,**scope): calls.append((loop_id,scope)); return None
    monkeypatch.setattr(loops,'get_loop',scoped_get)
    resolver=loops.resolve_loop_media_path if kind=='media' else loops.resolve_loop_preview_path
    assert resolver({'DATA_DIR':tmp_path},identity,account_id=7,library_id=9) is None
    assert calls==[('same-id',{'account_id':7,'library_id':9})]

@pytest.mark.parametrize('preview_id',['same-id_pplus2!','same-id_pplus99','same-id_pminus99','same-id_pplus2/','../same-id_pplus2','same-id_pplus2_extra'])
def test_preview_identifiers_are_rejected_without_sanitizing_to_valid_file(tmp_path,monkeypatch,preview_id):
    root=tmp_path/'loop_previews'; root.mkdir()
    (root/'same-id_pplus2.mp3').write_bytes(b'private-bytes')
    monkeypatch.setattr(loops,'get_loop',lambda *args,**kwargs: {'id':'same-id'})
    assert loops.resolve_loop_preview_path({'DATA_DIR':tmp_path},preview_id,account_id=7,library_id=9) is None

def test_scoped_media_uses_owned_stored_path_before_same_key_global_filename(tmp_path,monkeypatch):
    root=tmp_path/'loops'; owned=root/'account-7'/'library-9'; owned.mkdir(parents=True)
    path=owned/'same-id.mp3'; path.write_bytes(b'owned')
    (root/'same-id.mp3').write_bytes(b'foreign')
    monkeypatch.setattr(loops,'get_loop',lambda *args,**kwargs: {'id':'same-id','path':str(path)})
    assert loops.resolve_loop_media_path({'DATA_DIR':tmp_path},'same-id',account_id=7,library_id=9)==path.resolve()

def request_for(payload=None):
    async def json(): return payload or {}
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(config={})),state=SimpleNamespace(),json=json)

@pytest.mark.parametrize('boundary',['media','preview','waveform','preview-create','create','delete','reorder','read'])
def test_every_saved_loop_boundary_uses_request_actor_not_payload_scope(monkeypatch,boundary):
    from music_app.routes import web_asgi,playback_stream_asgi,api_wave_b_asgi_routes as wave,api_read_asgi_routes as read
    from music_app.services import current_actor_asgi
    actor=SimpleNamespace(account_id=7,current_library_id=9,is_authenticated=True,library_relationships=(SimpleNamespace(library_id=9,membership_role='owner',is_primary_owner=True),))
    async def resolve_actor(_request): return actor
    monkeypatch.setattr(current_actor_asgi,'current_actor_from_request',resolve_actor)
    for module in [web_asgi,playback_stream_asgi,wave,read]:
        monkeypatch.setattr(module,'current_actor_from_request',resolve_actor,raising=False)
        monkeypatch.setattr(module,'_app_config',lambda _request:{},raising=False)
    payload={'loop_id':'same-id','semitones':2,'song_key':'track:11','expected_revision':0,'ordered_ids':['b','a'],'account_id':99,'library_id':88}
    payload.update(name='Nested',source_loop_id='same-id',start_seconds=1,end_seconds=3)
    request=request_for(payload); calls=[]
    def missing(_config,identity,**scope): calls.append(scope); return None
    if boundary=='media':
        monkeypatch.setattr(web_asgi,'resolve_loop_media_path',missing)
        response=asyncio.run(web_asgi.saved_loop_media(request,'same-id'))
    elif boundary=='preview':
        monkeypatch.setattr(web_asgi,'resolve_loop_preview_path',missing)
        response=asyncio.run(web_asgi.saved_loop_pitch_preview(request,'same-id_pplus2'))
    elif boundary=='waveform':
        monkeypatch.setattr(playback_stream_asgi,'resolve_loop_media_path',missing)
        response=asyncio.run(playback_stream_asgi.playback_waveform(request,loop_id='same-id'))
    elif boundary=='preview-create':
        monkeypatch.setattr(wave,'resolve_loop_media_path',missing)
        response=asyncio.run(wave.create_loop_pitch_preview(request))
    elif boundary=='create':
        monkeypatch.setattr(wave,'_library_state',lambda _request:{})
        monkeypatch.setattr(wave,'_app_logger',lambda _request:None)
        monkeypatch.setattr(wave,'get_loop',missing)
        response=asyncio.run(wave.create_saved_loop(request))
    elif boundary=='delete':
        def delete(_config,identity,**scope): calls.append(scope); return False,[]
        monkeypatch.setattr(wave,'delete_loop',delete)
        response=asyncio.run(wave.delete_saved_loop(request))
    elif boundary=='reorder':
        def reorder(_config,ids=None,**scope): calls.append(scope); return {'ordered_ids':['b','a'],'order_revision':1,'loops':[]}
        monkeypatch.setattr(wave,'reorder_loops',reorder)
        response=asyncio.run(wave.reorder_saved_loops(request))
    else:
        def load(_config,**scope): calls.append(scope); return []
        monkeypatch.setattr(read,'load_loops',load)
        monkeypatch.setattr(read,'allowed_actions_for_request',lambda *_args:SimpleNamespace(as_payload=lambda:{}))
        response=asyncio.run(read.utilities_loops(request))
    assert calls, f'{boundary} must resolve a scoped saved-loop service'
    assert all(call.get('account_id')==7 and call.get('library_id')==9 for call in calls)
    if boundary in {'media','preview','waveform','preview-create','delete'}: assert response.status_code==404
    if boundary=='reorder':
        assert calls[0]['song_key']=='track:11' and calls[0]['expected_revision']==0
@pytest.mark.parametrize('relationship_library', [None,88])
def test_loop_read_cannot_claim_missing_or_foreign_current_library_membership(monkeypatch,relationship_library):
    from fastapi import HTTPException
    from music_app.routes import api_read_asgi_routes as read
    from music_app.services import current_actor_asgi
    relationships=() if relationship_library is None else (SimpleNamespace(library_id=relationship_library,membership_role='owner',is_primary_owner=True),)
    actor=SimpleNamespace(account_id=7,current_library_id=9,is_authenticated=True,library_relationships=relationships)
    async def resolve_actor(_request): return actor
    monkeypatch.setattr(current_actor_asgi,'current_actor_from_request',resolve_actor)
    monkeypatch.setattr(read,'current_actor_from_request',resolve_actor,raising=False)
    monkeypatch.setattr(read,'_app_config',lambda _request:{})
    monkeypatch.setattr(read,'allowed_actions_for_request',lambda *_args:SimpleNamespace(as_payload=lambda:{}))
    monkeypatch.setattr(read,'load_loops',lambda *_args,**_kwargs:pytest.fail('invalid membership reached saved-loop persistence'))
    try:
        response=asyncio.run(read.utilities_loops(request_for()))
    except HTTPException as error:
        assert error.status_code in (403,404)
    else:
        assert response.status_code in (403,404)