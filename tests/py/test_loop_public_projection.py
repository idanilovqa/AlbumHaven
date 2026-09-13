from __future__ import annotations
import asyncio
import copy
import json
from types import SimpleNamespace
from music_app.services.current_actor import ActorState, CurrentActor, LibraryRelationship
import pytest
from starlette.responses import Response
from music_app.services import loops
from music_app.routes import api_read_asgi_routes as read, api_wave_b_asgi_routes as wave, web_asgi as web

PRIVATE = {'id':'same-id','name':'Saved','song_key':'track:11','original_start_seconds':4.5,'original_end_seconds':8.0,
    'path':'C:/private/loops/same-id.mp3','source_path':'C:/private/music/source.flac','cover_path':'C:/private/art.jpg',
    'arbitrary_payload':{'token':'private-secret'},'metadata':{'source_payload':{'path':'/private/source'}}}

def assert_public(item):
    assert item['id']=='same-id'
    assert item['original_start_seconds']==4.5 and item['original_end_seconds']==8.0
    assert item['cover_url']=='/cover?loop_id=same-id'
    for key in ('path','source_path','cover_path','arbitrary_payload','metadata','source_payload'): assert key not in item
    assert 'private' not in json.dumps(item)

@pytest.fixture
def context(monkeypatch):
    async def scope(_request): return {'account_id':7,'library_id':9}
    for module in (read,wave,web):
        monkeypatch.setattr(module,'saved_loop_scope',scope,raising=False)
        monkeypatch.setattr(module,'_app_config',lambda _request:{},raising=False)
    monkeypatch.setattr(read,'allowed_actions_for_request',lambda *_args:SimpleNamespace(as_payload=lambda:{}))
    payload={'loop_id':'same-id','song_key':'track:11','ordered_ids':['same-id'],'expected_revision':1}
    async def json_body(): return payload
    return SimpleNamespace(json=json_body,app=SimpleNamespace(state=SimpleNamespace(config={})),state=SimpleNamespace(current_actor=CurrentActor(state=ActorState.ACTIVE, account_id=7, current_library_id=9, library_relationships=(LibraryRelationship(9, 'owner', True),))))

def test_loop_projection_is_allowlisted_and_keeps_internal_record_unchanged():
    original=copy.deepcopy(PRIVATE)
    assert_public(loops.project_loop_for_client(PRIVATE))
    assert PRIVATE==original

@pytest.mark.parametrize('boundary',['read','delete','reorder','stale-reorder'])
def test_every_loop_snapshot_boundary_redacts_internal_records(monkeypatch,context,boundary):
    snapshot={'song_key':'track:11','ordered_ids':['same-id'],'order_revision':2,'loops':[copy.deepcopy(PRIVATE)]}
    if boundary=='read':
        monkeypatch.setattr(read,'load_loops',lambda *_args,**_scope:[copy.deepcopy(PRIVATE)])
        response=asyncio.run(read.utilities_loops(context))
    elif boundary=='delete':
        monkeypatch.setattr(wave,'delete_loop',lambda *_args,**_scope:(True,[copy.deepcopy(PRIVATE)]))
        response=asyncio.run(wave.delete_saved_loop(context))
    else:
        def reorder(*_args,**_scope):
            if boundary=='stale-reorder': raise wave.LoopOrderError(409,'Stale order',snapshot)
            return snapshot
        monkeypatch.setattr(wave,'reorder_loops',reorder)
        response=asyncio.run(wave.reorder_saved_loops(context))
    assert response.status_code==(409 if boundary=='stale-reorder' else 200)
    assert_public(json.loads(response.body)['loops'][0])

@pytest.mark.parametrize('available',[True,False])
def test_loop_cover_resolves_scope_before_bytes_and_hides_foreign_or_removed_ids(monkeypatch,context,available):
    calls=[]
    def get(_config,identity,**scope):
        assert identity=='same-id' and scope=={'account_id':7,'library_id':9}
        calls.append('scope')
        return copy.deepcopy(PRIVATE) if available else None
    def cover_response(_request,path,size):
        assert calls==['scope'] and path==PRIVATE['cover_path']
        calls.append('bytes')
        return Response(b'owned-cover',media_type='image/jpeg')
    monkeypatch.setattr(web,'get_loop',get,raising=False)
    monkeypatch.setattr(web,'_cover_response',cover_response)
    response=asyncio.run(web.cover(context,loop_id='same-id'))
    assert response.status_code==(200 if available else 404)
    assert calls==(['scope','bytes'] if available else ['scope'])

def test_create_response_projects_both_created_item_and_refreshed_collection(monkeypatch,context,tmp_path):
    source=tmp_path/'owned.flac'; source.write_bytes(b'owned')
    payload={'name':'Saved','source_path':str(source),'start_seconds':4.5,'end_seconds':8.0}
    async def json_body(): return payload
    context.json=json_body
    monkeypatch.setattr(wave,'_library_state',lambda _request:{})
    monkeypatch.setattr(wave,'_app_logger',lambda _request:None)
    monkeypatch.setattr(wave,'resolve_loop_creation_source',lambda *_args,**_kwargs:({'source_path':source,
        'artist':'Artist','title':'Title','album':'Album','cover_path':PRIVATE['cover_path'],'parent_loop_id':'',
        'original_start_seconds':4.5,'original_end_seconds':8.0},None))
    monkeypatch.setattr(wave,'probe_loop_source_duration',lambda _path:10,raising=False)
    monkeypatch.setattr(wave,'create_loop_file',lambda *_args,**_kwargs:source)
    monkeypatch.setattr(wave,'build_loop_item',lambda **_kwargs:copy.deepcopy(PRIVATE))
    monkeypatch.setattr(wave,'add_loop',lambda *_args,**_kwargs:copy.deepcopy(PRIVATE))
    monkeypatch.setattr(wave,'load_loops',lambda *_args,**_kwargs:[copy.deepcopy(PRIVATE)])
    monkeypatch.setattr(wave,'log_app_event',lambda *_args,**_kwargs:None)
    response=asyncio.run(wave.create_saved_loop(context)); assert response.status_code==200
    payload=json.loads(response.body); assert_public(payload['loop']); assert_public(payload['loops'][0])
