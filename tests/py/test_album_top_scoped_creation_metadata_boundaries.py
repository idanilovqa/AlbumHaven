"""Real preference owner plus explicitly defensive post-read data-seam cases."""
import pytest
from music_app.services import album_preferences_postgres as preferences
from tests.py.test_album_top_scoped_creation_metadata_postgres import metadata_db,listing,only
from tests.py.test_owned_album_tops_postgres import assert_error


@pytest.mark.parametrize('malformed',[True,False,0,11,-1,1.5,'7',[],{}])
def test_defensive_reader_result_rating_is_unavailable_not_persisted_corruption(metadata_db,monkeypatch,malformed):
    # PostgreSQL constraints stay intact. Only the already-read return value is
    # changed to exercise defensive projection, not a reachable storage claim.
    db=metadata_db;actual=preferences.load_album_preferences_on_connection;seen=[]
    def read(connection,*,account_id,library_id,album_ids):
        ids=list(album_ids)
        assert connection.autocommit is False
        assert (account_id,library_id,ids)==(db.owner.account_id,db.library,[db.albums[0]['id']])
        result=actual(connection,account_id=account_id,library_id=library_id,album_ids=ids)
        assert result[ids[0]]['taste_state']=='available'
        seen.append(ids)
        return {key:{**value,'rating':malformed} for key,value in result.items()}
    monkeypatch.setattr(preferences,'load_album_preferences_on_connection',read)
    result=only(db)
    assert result['rating_state']=='unavailable' and result['rating'] is None
    assert seen==[[db.albums[0]['id']]] and db.rows()==[]


@pytest.fixture
def page_db(metadata_db):
    db=metadata_db;root=db.albums[0]['artist']
    extra=[db.add_album('page-b'),db.add_album('page-c')]
    ids=[album['id'] for album in extra]
    with db.connect() as con:
        for identity in ids:
            con.execute("insert into library.local_album_featured_artists(library_id,album_id,artist_id,featured_kind,metadata) values(%s,%s,%s,'featured_member','{}'::jsonb)",(db.library,identity,root))
    try:yield db
    finally:
        # Remove only this fixture's extra exact credit tuples. Inventory itself
        # remains registered in favorites_db and uses its existing teardown.
        with db.connect() as con:
            con.execute("delete from library.local_album_featured_artists where library_id=%s and album_id=any(%s::bigint[]) and artist_id=%s and featured_kind='featured_member'",(db.library,ids,root))


def test_page_metadata_reads_exact_page_ids_once_and_preserves_order(page_db,monkeypatch):
    db=page_db;actual=preferences.load_album_preferences_on_connection;calls=[]
    def read(connection,*,account_id,library_id,album_ids):
        ids=list(album_ids);assert connection.autocommit is False
        assert (account_id,library_id)==(db.owner.account_id,db.library)
        calls.append(ids)
        return actual(connection,account_id=account_id,library_id=library_id,album_ids=ids)
    monkeypatch.setattr(preferences,'load_album_preferences_on_connection',read)
    whole=listing(db,limit=3);expected=[row['local_album_id'] for row in whole['albums']]
    assert len(expected)==3 and set(expected)=={row['id'] for row in db.albums}
    assert calls==[expected] and whole['next_cursor'] is None
    calls.clear();cursor=None;collected=[]
    for index in range(3):
        page=listing(db,limit=1,cursor=cursor)
        assert [row['local_album_id'] for row in page['albums']]==expected[index:index+1]
        assert calls[-1]==expected[index:index+1] and len(calls)==index+1
        assert page['albums'][0]['creation_metadata']['rating_state']=='available'
        collected.extend(page['albums']);cursor=page['next_cursor']
        assert (cursor is None)==(index==2)
    assert collected==whole['albums'] and db.rows()==[]


def test_changed_cursor_query_rejects_before_preference_owner(page_db,monkeypatch):
    db=page_db;first=listing(db,limit=1);assert first['next_cursor'] is not None
    def forbidden(*args,**kwargs):raise AssertionError('invalid cursor reached preference owner')
    monkeypatch.setattr(preferences,'load_album_preferences_on_connection',forbidden)
    assert_error(lambda:listing(db,limit=1,cursor=first['next_cursor'],query='different'),'invalid_cursor',422)
    assert db.rows()==[]


def test_final_scope_recapture_after_actual_preference_read_rolls_back_credit_change(metadata_db,monkeypatch):
    db=metadata_db;album=db.albums[0];other=db.add_album('outside-scope');actual=preferences.load_album_preferences_on_connection;seen=[]
    def read(connection,**kwargs):
        result=actual(connection,**kwargs)
        changed=connection.execute("update library.local_album_featured_artists set artist_id=%s where library_id=%s and album_id=%s and artist_id=%s and featured_kind='owner' returning id",(other['artist'],db.library,album['id'],album['artist'])).fetchall()
        assert len(changed)==1;seen.append(True)
        return result
    monkeypatch.setattr(preferences,'load_album_preferences_on_connection',read)
    assert_error(lambda:listing(db),'artist_scope_changed',409)
    assert seen==[True] and db.rows()==[]
    with db.connect() as con:
        assert con.execute("select count(*) as n from library.local_album_featured_artists where library_id=%s and album_id=%s and artist_id=%s and featured_kind='owner'",(db.library,album['id'],album['artist'])).fetchone()['n']==1
