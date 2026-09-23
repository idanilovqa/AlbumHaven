import asyncio
import json
from types import SimpleNamespace
import pytest
from music_app.routes import api_wave_b_asgi_routes as wave


@pytest.mark.parametrize('kind',['create','preview'])
def test_encoding_failure_does_not_expose_private_diagnostics(monkeypatch,tmp_path,kind):
    source=tmp_path/'owned.mp3';source.write_bytes(b'owned')
    async def scope(_request):return {'account_id':7,'library_id':9}
    async def body():return {'name':'Saved','source_path':str(source),'start_seconds':0,'end_seconds':1,'loop_id':'owned','semitones':2}
    request=SimpleNamespace(json=body)
    monkeypatch.setattr(wave,'saved_loop_scope',scope)
    monkeypatch.setattr(wave,'_app_config',lambda _request:{'DATA_DIR':tmp_path})
    monkeypatch.setattr(wave,'_library_state',lambda _request:{})
    monkeypatch.setattr(wave,'_app_logger',lambda _request:None)
    monkeypatch.setattr(wave,'resolve_loop_media_path',lambda *_args,**_scope:source)
    monkeypatch.setattr(wave,'resolve_loop_creation_source',lambda *_args,**_kwargs:({'source_path':source,'parent_loop_id':'','original_end_seconds':1},None))
    monkeypatch.setattr(wave,'probe_loop_source_duration',lambda _path:2)
    def fail(*_args,**_kwargs):raise RuntimeError('encoder C:/private/music/song.mp3 token=private-secret')
    monkeypatch.setattr(wave,'create_loop_file',fail)
    monkeypatch.setattr(wave,'create_pitch_preview_file',fail)
    response=asyncio.run(wave.create_saved_loop(request) if kind=='create' else wave.create_loop_pitch_preview(request))
    assert response.status_code==500
    data=json.loads(response.body)
    assert data['ok'] is False and data['error']
    assert 'private' not in response.body.decode() and 'token=' not in response.body.decode()


def test_scoped_direct_source_uses_authorized_metadata_cover_not_client_path(monkeypatch,tmp_path):
    from music_app.routes.api_loop_helpers import resolve_loop_creation_source
    from music_app.services.saved_loops_postgres import SavedLoopsPostgresAdapter
    source=(tmp_path/'owned.flac').resolve()
    owned_cover=str(tmp_path/'owned.jpg')
    calls=[]
    def resolve(_self,**values):
        assert values['account_id']==7 and values['library_id']==9
        assert values['item']['source_path']==str(source)
        calls.append('authorized')
        return 11,None
    monkeypatch.setattr(SavedLoopsPostgresAdapter,'resolve_scoped_source',resolve)
    result,error=resolve_loop_creation_source({'source_path':str(source),'start_seconds':0,'end_seconds':1,'cover_path':'C:/foreign/private/art.jpg'},
        config={},get_loop=lambda *_args:None,resolve_loop_media_path=lambda *_args:None,
        normalize_music_file_path=lambda _path:source,file_cache={str(source):{'cover_path':owned_cover}},scope={'account_id':7,'library_id':9})
    assert error is None and calls==['authorized']
    assert result['cover_path']==owned_cover
