"""Task 7 root/picker boundary contracts; authored before production changes."""
import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from music_app.routes import api_wave_a_asgi_routes as wave
from music_app.services import current_actor_asgi, policy_asgi
from music_app.services.allowed_actions import AllowedActions


def invoke(endpoint, request, **kwargs):
    try:
        response=asyncio.run(endpoint(request,**kwargs))
        return response.status_code,json.loads(response.body or b'{}')
    except HTTPException as error:
        return error.status_code,{'error':str(error.detail)}


def context(monkeypatch,tmp_path,*,library=9,relationship=9,host=9,mode='self_hosted',grants=None):
    config={'ALBUM_HAVEN_DEPLOYMENT_MODE':mode,'ALBUM_HAVEN_LIBRARY_BROWSE_BASES':[str(tmp_path)],'_library_root_paths_snapshot':('unchanged',)}
    actor=SimpleNamespace(account_id=7,current_library_id=library,is_authenticated=True,
        library_relationships=() if relationship is None else (SimpleNamespace(library_id=relationship),))
    async def resolve(_request):return actor
    monkeypatch.setattr(current_actor_asgi,'current_actor_from_request',resolve)
    monkeypatch.setattr(wave,'current_actor_from_request',resolve,raising=False)
    allowed=AllowedActions(tuple(grants if grants is not None else ['library.filesystem.browse','library.paths.read']))
    monkeypatch.setattr(policy_asgi,'allowed_actions_for_request',lambda *_args,**_kwargs:allowed)
    monkeypatch.setattr(wave,'allowed_actions_for_request',lambda *_args,**_kwargs:allowed,raising=False)
    payload={'settings':{'main_library_roots':[]},'library_id':88,'media_host_library_id':88}
    async def body():return payload
    effects=[]
    request=SimpleNamespace(json=body,state=SimpleNamespace(current_actor=actor),query_params={},
        app=SimpleNamespace(state=SimpleNamespace(config=config,media_host_library_id=host,replace_library_watch_roots=lambda *_args:effects.append('watch'))))
    monkeypatch.setattr(wave,'_app_config',lambda _request:config)
    monkeypatch.setattr(wave,'_library_state',lambda _request:{})
    monkeypatch.setattr(wave,'_start_background_refresh_for_asgi_request',lambda _request:lambda:effects.append('refresh'))
    def read(_config,**scope):
        effects.append(('read',scope));return {'main_library_roots':[]}
    def save(_config,_payload,**scope):
        effects.append(('save',scope));return {'settings':{'main_library_roots':[]}}
    monkeypatch.setattr(wave,'load_library_root_settings',read)
    monkeypatch.setattr(wave,'save_library_settings_and_start_refresh',save)
    return request,effects,actor


@pytest.mark.parametrize('operation',['read','write'])
def test_matching_root_request_passes_captured_host_and_library_scope(monkeypatch,tmp_path,operation):
    request,effects,_actor=context(monkeypatch,tmp_path)
    before=copy.deepcopy(request.app.state.config)
    code,_body=invoke(getattr(wave,'library_settings_'+operation),request)
    assert code==200 and effects
    scope=effects[0][1]
    assert scope['library_id']==9 and scope['media_host_library_id']==9
    assert request.app.state.media_host_library_id==9 and request.app.state.config==before


@pytest.mark.parametrize('library,relationship,host',[(9,None,9),(9,88,9),(88,88,9),(9,9,None)])
@pytest.mark.parametrize('operation',['read','write'])
def test_root_denial_precedes_snapshot_persistence_watch_and_refresh(monkeypatch,tmp_path,library,relationship,host,operation):
    request,effects,_actor=context(monkeypatch,tmp_path,library=library,relationship=relationship,host=host)
    before=copy.deepcopy(request.app.state.config)
    code,_body=invoke(getattr(wave,'library_settings_'+operation),request)
    assert code in (403,404,409,503)
    assert effects==[] and request.app.state.config==before
    assert request.app.state.media_host_library_id==host


def test_interleaved_reader_cannot_rebind_host_or_replace_root_snapshot(monkeypatch,tmp_path):
    request,effects,actor=context(monkeypatch,tmp_path)
    assert invoke(wave.library_settings_read,request)[0]==200
    effects.clear();actor.current_library_id=88;actor.library_relationships=(SimpleNamespace(library_id=88),)
    assert invoke(wave.library_settings_read,request)[0] in (403,404)
    assert effects==[] and request.app.state.media_host_library_id==9
    actor.current_library_id=9;actor.library_relationships=(SimpleNamespace(library_id=9),)
    assert invoke(wave.library_settings_read,request)[0]==200
    assert effects[0][1]['library_id']==9


def picker():
    route=next((route for route in wave.router.routes if route.path=='/library-settings/browse' and 'GET' in route.methods),None)
    assert route is not None,'Approved bounded picker must live in the library-settings owner'
    return route.endpoint


@pytest.mark.parametrize('mode',['hosted_gateway','cloud','private_node','unknown',''])
def test_picker_rejects_every_mode_except_literal_self_hosted(monkeypatch,tmp_path,mode):
    request,_effects,_actor=context(monkeypatch,tmp_path,mode=mode)
    assert invoke(picker(),request,path=str(tmp_path))[0] in (403,404,409)


@pytest.mark.parametrize('grants',[[],['library.filesystem.browse'],['library.paths.read']])
def test_picker_requires_both_browse_and_path_disclosure_grants(monkeypatch,tmp_path,grants):
    request,_effects,_actor=context(monkeypatch,tmp_path,grants=grants)
    assert invoke(picker(),request,path=str(tmp_path))[0] in (403,404)


@pytest.mark.parametrize('bases',[[],None,'C:/',{'path':'C:/'}])
def test_picker_does_not_infer_bases_from_drives_or_music_roots(monkeypatch,tmp_path,bases):
    request,_effects,_actor=context(monkeypatch,tmp_path)
    request.app.state.config['ALBUM_HAVEN_LIBRARY_BROWSE_BASES']=bases
    request.app.state.config['MUSIC_DIR']=str(tmp_path)
    code,body=invoke(picker(),request,path=str(tmp_path))
    assert code in (400,403,404,409)
    assert str(tmp_path) not in json.dumps(body)


def test_picker_rejects_canonical_escape_from_allowed_base(monkeypatch,tmp_path):
    base=tmp_path/'base';base.mkdir();link=base/'escape';link.mkdir();foreign=tmp_path/'foreign';foreign.mkdir()
    request,_effects,_actor=context(monkeypatch,base)
    original=Path.resolve
    def canonical(path,*args,**kwargs):return foreign if path==link else original(path,*args,**kwargs)
    monkeypatch.setattr(Path,'resolve',canonical)
    code,body=invoke(picker(),request,path=str(link))
    assert code in (400,403,404)
    assert str(foreign) not in json.dumps(body)


def test_picker_lists_only_bounded_child_directories(monkeypatch,tmp_path):
    base=tmp_path/'base';base.mkdir();(base/'album').mkdir();(base/'track.flac').write_bytes(b'not-a-directory')
    request,_effects,_actor=context(monkeypatch,base)
    code,body=invoke(picker(),request,path=str(base))
    assert code==200
    assert 'album' in json.dumps(body) and 'track.flac' not in json.dumps(body)
    assert str(tmp_path/'foreign') not in json.dumps(body)
