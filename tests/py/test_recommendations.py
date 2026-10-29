"""Portable contracts only: no real SQL, application startup or migrations."""
import asyncio
import json
import pytest
from music_app.services.recommendations import command, attribution_key, compact_label, RecommendationError
from music_app.services import recommendations_postgres as store
from music_app.routes import recommendations_asgi as routes
from music_app.services.owned_playlists import PlaylistError, BROWSE, ACCESS
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from music_app.services.owned_album_tops import AlbumTopError
from tests.py.owned_playlist_testing import context, playlist_row, ACCOUNT, LIBRARY, REQUEST
from tests.py.test_owned_playlist_route_boundary import request
FRIEND='20000000-0000-4000-8000-000000000009'
ITEM='30000000-0000-4000-8000-000000000009'
def payload(**changes):
    return {'kind':'track','resource_ref':f'inventory-track:{LIBRARY}:901','request_key':REQUEST,'recipient_account_ref':FRIEND,**changes}
def manual(by):return {k:v for k,v in payload(recommender=by).items() if k!='recipient_account_ref'}
def test_valid_commands():
    assert command(payload()).resource_id==901
    assert command(payload(kind='album',resource_ref=f'inventory-album:{LIBRARY}:81')).kind=='album'
    assert command(manual({'name':' A friend '}),manual=True).recommender_name=='A friend'
    assert command(manual({'account_ref':FRIEND}),manual=True).recommender_ref==FRIEND
@pytest.mark.parametrize('field',['sender_account_id','owner_account_id','library_id','attribution_kind','display_name'])
def test_no_client_authority(field):
    with pytest.raises(RecommendationError):command(payload(**{field:'forged'}))
@pytest.mark.parametrize('ref',['C:/Music/song.flac','inventory-album:73:1','inventory-track:0:1','inventory-track:73:-1','inventory-track:73:9223372036854775808','inventory-track:073:1',None,1,True])
def test_invalid_resources(ref):
    with pytest.raises(RecommendationError):command(payload(resource_ref=ref))
@pytest.mark.parametrize('by',[None,{}, {'name':''},{'name':'x','account_ref':FRIEND},{'name':'a\x00b'},{'name':'x'*101},{'name':'\ud800'},{'name':'a\u202eb'},{'account_ref':'bad'}])
def test_manual_identity_validation(by):
    with pytest.raises(RecommendationError):command(manual(by),manual=True)
def test_person_normalization_does_not_forge_account():
    assert attribution_key(name='Éli')==attribution_key(name=' e\u0301LI ')
    assert attribution_key(name=FRIEND)!=attribution_key(account_ref=FRIEND)
def test_digest_binds_payload_not_request_key():
    a=command(payload())
    assert a.digest==command(payload(request_key='10000000-0000-4000-8000-000000000009')).digest
    assert a.digest!=command(payload(resource_ref=f'inventory-track:{LIBRARY}:902')).digest
    assert a.digest!=command(manual({'name':'Friend'}),manual=True).digest
@pytest.mark.parametrize('count,label',[(0,''),(1,'Recommended by: Eli'),(2,'Recommended by: a few'),(3,'Recommended by: a few'),(4,'Recommended by: many')])
def test_compact_labels(count,label):assert compact_label([{'display_name':'Eli'}]*count)==label
@pytest.mark.parametrize('owner',[PostgresOwnedPlaylistsService,PostgresOwnedAlbumTopsService])
def test_private_system_collection_authority(owner):
    row=playlist_row(recommendation_collection=True)
    if owner is PostgresOwnedAlbumTopsService:
        error=AlbumTopError;method=owner({'ALBUM_HAVEN_APP_DATABASE_URL':'postgresql://synthetic-invalid/tests'})._require;access='library.album_tops.access.manage'
    else:error=PlaylistError;method=owner._require;access=ACCESS
    with pytest.raises(error):method(context(),(BROWSE,access),None,row)
    row['owner_account_id']=ACCOUNT+1
    with pytest.raises(error):method(context(),(BROWSE,),None,row)
class Service:
    def __init__(self):self.calls=[]
    def execute(self,ctx,payload,**kwargs):
        command(payload,manual=kwargs['manual']);self.calls.append((ctx,payload,kwargs))
        return {'status':'recommended','kind':'track','already_recommended':False}
def route_request(service,**kwargs):
    req=request(None,payload=payload(),**kwargs);req.app.state.recommendations_service=service;return req
def test_authenticated_transport():
    s=Service();r=asyncio.run(routes.recommend(route_request(s)))
    assert r.status_code==200 and r.headers['cache-control']=='private, no-store'
    assert s.calls[0][0].actor.account_id==ACCOUNT and json.loads(r.body)['context_ref']
@pytest.mark.parametrize('header',[None,'','0'*64])
def test_context_rejected_before_service(header):
    s=Service();r=asyncio.run(routes.recommend(route_request(s,header=header)))
    assert r.status_code==409 and not s.calls
def test_duplicate_context():
    s=Service();req=route_request(s);req.scope['headers'].append(next(p for p in req.scope['headers'] if p[0]==b'x-albumhaven-context'))
    assert asyncio.run(routes.recommend(req)).status_code==409 and not s.calls
def test_oversized_body():
    s=Service();r=asyncio.run(routes.recommend(route_request(s,raw=b' '*4097)))
    assert r.status_code==413 and not s.calls
def test_invalid_json():
    s=Service();r=asyncio.run(routes.recommend(route_request(s,raw=b'{')))
    assert r.status_code==422 and not s.calls
def test_errors_do_not_leak():
    class Broken(Service):
        def execute(self,*args,**kwargs):raise RuntimeError('private path and credentials')
    r=asyncio.run(routes.recommend(route_request(Broken())))
    assert r.status_code==503 and json.loads(r.body)=={'ok':False,'error':'recommendations_unavailable'}
class Result:
    def __init__(self,rows):self.rows=rows
    def fetchone(self):return self.rows[0] if self.rows else None
    def fetchall(self):return self.rows
def test_recipient_scoped_projection():
    class Connection:
        def execute(self,sql,params):
            assert 'recipient_account_id=%s' in sql and 'library_id=%s' in sql
            assert params==(ACCOUNT,LIBRARY,[ITEM]);return Result([{'item_ref':ITEM,'display_name':'Maya','account_ref':FRIEND}])
    assert store.load_attributions(Connection(),context(),kind='track',item_refs=[ITEM])=={ITEM:[{'display_name':'Maya','account_ref':FRIEND}]}
def test_no_schema_bootstrap():
    class Connection:
        def execute(self,sql):
            assert sql.startswith('select to_regclass(');return Result([{'installed':None}])
    with pytest.raises(RecommendationError) as e:store._ready(Connection())
    assert e.value.status_code==503

CATALOG='40000000-0000-4000-8000-000000000009'
TOP='50000000-0000-4000-8000-000000000009'
def catalog_payload(**changes):
    return payload(kind='album',resource_ref='catalog-album:'+CATALOG,
                   source={'top_ref':TOP,'item_ref':ITEM,'revision':'4'},**changes)
def test_catalog_command_binds_current_source():
    p=catalog_payload(); value=command(p)
    assert value.catalog_ref==CATALOG and value.library_id is None and value.resource_id is None
    assert value.source_top_ref==TOP and value.source_item_ref==ITEM and value.source_revision==4
    p['source']['revision']='5'
    assert command(p).digest!=value.digest
@pytest.mark.parametrize('source',[None,{}, {'top_ref':TOP,'item_ref':ITEM,'revision':4},
    {'top_ref':TOP,'item_ref':ITEM,'revision':'0'}, {'top_ref':TOP,'item_ref':ITEM,'revision':'04'},
    {'top_ref':TOP,'item_ref':ITEM,'revision':'9223372036854775808'},
    {'top_ref':TOP,'item_ref':ITEM,'revision':'4','playback_url':'https://invalid'},
    {'top_ref':'bad','item_ref':ITEM,'revision':'4'}])
def test_catalog_command_rejects_unbounded_source(source):
    p=catalog_payload();p['source']=source
    with pytest.raises(RecommendationError):command(p)
def test_catalog_track_is_not_invented():
    p=catalog_payload();p['kind']='track'
    with pytest.raises(RecommendationError):command(p)
@pytest.mark.parametrize('fault',[None,'owner','revision','item','retired','permission'])
def test_catalog_source_authority_and_metadata_only(monkeypatch,fault):
    from music_app.services import album_top_remote_membership as remote
    top={'owner_account_id':ACCOUNT+1 if fault=='owner' else ACCOUNT,'revision':5 if fault=='revision' else 4}
    calls=[]
    monkeypatch.setattr(PostgresOwnedAlbumTopsService,'_top',staticmethod(lambda *args:top))
    def require(*args,**kwargs):
        calls.append('authorize')
        if fault=='permission':raise AlbumTopError('forbidden',403)
    monkeypatch.setattr(PostgresOwnedAlbumTopsService,'_require',staticmethod(require))
    monkeypatch.setattr(remote,'bindings',lambda *args:{ITEM:{'retired_at':'retired' if fault=='retired' else None,'secret':'never forwarded'}})
    monkeypatch.setattr(remote,'lock_read_sources',lambda *args:calls.append('admission_lock'))
    class Connection:
        def execute(self,sql,params):
            assert 'for share' in sql and params==(TOP,LIBRARY,ITEM)
            return Result([] if fault=='item' else [{'ref':ITEM,'catalog_ref':CATALOG}])
    if fault:
        with pytest.raises((RecommendationError,AlbumTopError)):
            store.PostgresRecommendations._catalog_source(Connection(),context(),command(catalog_payload()),ACCOUNT,None)
    else:
        assert store.PostgresRecommendations._catalog_source(Connection(),context(),command(catalog_payload()),ACCOUNT,None)=={'catalog_ref':CATALOG,'metadata_only':True}
        assert calls==['authorize','admission_lock','authorize']
