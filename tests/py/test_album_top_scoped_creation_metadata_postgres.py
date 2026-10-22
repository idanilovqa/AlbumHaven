"""Actual caller preference/source owners for scoped creation metadata."""
from dataclasses import replace
from datetime import timedelta
import pytest
from psycopg.types.json import Jsonb
from music_app.services.current_actor import CapabilityGrant
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from music_app.services.owned_album_tops import CREATE
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.album_favorites_postgres_support import favorites_db,observed,deny
from tests.py.test_owned_album_tops_postgres import assert_error
SECRET=b'scoped-creation-metadata-test-secret'


@pytest.fixture
def metadata_db(favorites_db):
    db=favorites_db
    with db.connect() as con:
        for actor in (db.owner,db.peer):
            con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)",
                (actor.account_id,CREATE,db.library))
    for key in ('owner','peer'):
        actor=getattr(db,key);setattr(db,key,replace(actor,capability_grants=(*actor.capability_grants,CapabilityGrant(CREATE,'library',db.library))))
    db.top_service=PostgresOwnedAlbumTopsService(db.config,connect=db.app_connect,clock=lambda:db.clock_time)
    return db


def listing(db,*,actor=None,constraints=None,**kwargs):
    return db.top_service.search_inventory_albums(db.context(actor),cursor_secret=SECRET,
        artist_scope={'root_artist_id':str(db.albums[0]['artist']),'mode':'artist'},constraints=constraints,**kwargs)


def only(db,**kwargs):
    rows=listing(db,**kwargs)['albums'];assert len(rows)==1
    assert rows[0]['local_album_id']==db.albums[0]['id']
    return rows[0]['creation_metadata']


def set_metadata(db,value):
    with db.connect() as con:
        con.execute('update library.local_albums set metadata=%s where id=%s',(Jsonb(value),db.albums[0]['id']))


@pytest.mark.parametrize('rating',[None,1,10])
def test_real_current_account_rating_never_uses_peer_taste(metadata_db,rating):
    db=metadata_db;album=db.albums[0]
    db.patch(album,{'rating':rating},actor=db.owner);db.patch(album,{'rating':7},actor=db.peer)
    before=db.rows();own=only(db);peer=only(db,actor=db.peer)
    assert (own['rating_state'],own['rating'])==('available',rating)
    assert (peer['rating_state'],peer['rating'])==('available',7)
    assert set(own)=={'release_type','rating_state','rating','artwork_url'}
    assert db.rows()==before


def test_known_unrated_is_distinct_from_no_active_file(metadata_db):
    db=metadata_db;album=db.albums[0]
    assert only(db)['rating_state']=='available' and only(db)['rating'] is None
    with db.connect() as con:
        con.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true') where id=%s",(album['file'],))
    result=only(db)
    assert result['rating_state']=='unavailable' and result['rating'] is None
    assert db.rows()==[]


@pytest.mark.parametrize('value,expected',[
    ({},None),({'release_type':'Album'},None),({'release_type':'Other'},None),({'release_type':False},None),
    *[({'release_type':'  '+kind.upper()+'  '},kind) for kind in ('studio','ep','live','demo','compilation','single')],
    ({'is_compilation':True},'compilation'),({'release_type':'Other','is_compilation':True},'compilation'),
    ({'release_type':'compilation','is_compilation':True},'compilation'),
    ({'release_type':'studio','is_compilation':True},None),({'release_type':'ep','is_compilation':True},None),
    ({'release_type':'studio','is_compilation':'true'},'studio'),({'is_compilation':1},None)])
def test_only_explicit_verified_type_evidence_is_projected(metadata_db,value,expected):
    db=metadata_db;set_metadata(db,value)
    assert only(db)['release_type']==expected


def test_artwork_uses_actual_current_library_and_row_authority(metadata_db):
    db=metadata_db;album=db.albums[0]
    assert only(db)['artwork_url']==f'/library/album-artwork/inventory-album:{db.library}:{album["id"]}'
    value=only(db,constraints=deny('library.artwork.read','album',album['id']))
    assert value['artwork_url'] is None and value['rating_state']=='available'


def test_ordinary_query_has_no_new_metadata_or_preference_read(metadata_db):
    db=metadata_db;queries=[]
    db.top_service._connect=observed(db,after=lambda sql,params,con:queries.append(sql))
    rows=db.top_service.search_inventory_albums(db.context(),query='Favorite',cursor_secret=SECRET)['albums']
    assert rows and all('creation_metadata' not in row for row in rows)
    assert not any('app.album_ratings' in sql for sql in queries)


@pytest.mark.parametrize('failure',['browse','artwork','session'])
def test_real_preference_read_is_followed_by_current_authority_and_clock_fences(metadata_db,failure):
    db=metadata_db;read=[];album=db.albums[0]
    def after(sql,params,con):
        if 'left join app.album_ratings' in sql:
            read.append(True)
            if failure=='session':db.clock_time+=timedelta(days=2)
    db.top_service._connect=observed(db,after=after)
    def constraints(context):
        blocked=bool(read) and context.action==('library.artwork.read' if failure=='artwork' else 'library.browse.read') and context.resource is not None and context.resource.resource_kind=='album' and context.resource.resource_ref==str(album['id'])
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)
    if failure=='artwork':assert only(db,constraints=constraints)['artwork_url'] is None
    else:assert_error(lambda:listing(db,constraints=constraints), 'forbidden' if failure=='session' else 'artist_scope_changed',403 if failure=='session' else 409)
    assert len(read)==1 and db.rows()==[]
