"""G1 actual PostgreSQL/C1/selector/native-owner tests, source-only authored.

Uses corrected R6 guarded bootstrap fixture; no policy/ranking fake. Mutations
inside resolver observers use the real current transaction and fixture-owned rows.
They prove final-probe rejection when run, not two-connection lock isolation.
"""
from datetime import timedelta
import re
import pytest
from starlette.datastructures import QueryParams
from tests.py.popularity_search_postgres_support import (
    mix_urls, popular_db, owner, SECRET, CONTEXT, error, read, native, assert_wire, assert_native,
    deny_resource, set_genre, grant_media,
)
from music_app.services.private_search_contract import normalize_private_search_request
from music_app.services.private_popularity_search_cursor import PopularitySearchCodec
from music_app.services.private_native_targets import PrivateNativeTargets
from music_app.services import private_popularity_search_postgres as search


def gallery(db, *, query=':popular', limit=100, cursor=None, constraints=None):
    pairs = [('q',query),('search_presentation','albums'),('search_page_size',str(limit))]
    if cursor is not None: pairs.append(('search_cursor',cursor))
    return owner(db).read(db.context(), request=normalize_private_search_request(QueryParams(pairs)),
        context_ref=CONTEXT,cursor_secret=SECRET,constraints=constraints)


def target(db, page, *, ref=None, constraints=None):
    return owner(db).resolve_album_target(db.context(),result_token=page['native']['result_token'],
        album_ref=ref or page['albums'][0]['id'],context_ref=CONTEXT,cursor_secret=SECRET,constraints=constraints)


def witness(db, page, key, tracks, *, constraints=None):
    albums = page['presentation'] == 'albums'
    source = {'kind':'album-publication' if albums else 'track-publication',
        'result_token':page['native']['result_token'],
        'album_ref' if albums else 'row_ref':page['albums' if albums else 'tracks'][0]['id']}
    rows = [{'slot':f'search-detail-row-{i+1}','inventory_track_ref':f'inventory-track:{db.library}:{track}'}
            for i,track in enumerate(tracks)]
    return owner(db).album_matches(db.context(),source=source,native_album_ref=key,
        page_key='search-detail-page-1',rows=rows,context_ref=CONTEXT,cursor_secret=SECRET,constraints=constraints)


def lifetime(value, db, original=None):
    got = value['lifetime']
    assert set(got) == {'issued_at','expires_at','server_now'}
    assert all(type(v) is int for v in got.values())
    assert got['expires_at'] == got['issued_at']+1800
    assert got['issued_at'] <= got['server_now'] < got['expires_at']
    assert got['server_now'] == int(db.clock_time.timestamp())
    if original:
        assert (got['issued_at'],got['expires_at']) == (original['issued_at'],original['expires_at'])


def album_wire(value, db):
    assert set(value) == {'status','private_search','contract_version','context_ref','query',
        'criteria','presentation','albums','page','popularity','native','lifetime'}
    assert value['status'] == 'ready' and value['private_search'] is True
    assert value['contract_version'] == 'popularity-search-albums-v1'
    assert value['presentation'] == 'albums'
    assert set(value['native']) == {'result_token'}
    for row in value['albums']:
        assert set(row) == {'id','kind','name','artist','year','edition','matches_search','allowed_actions'}
        assert re.fullmatch('popular_album_[0-9a-f]{64}',row['id'])
        assert row['kind'] == 'album' and row['matches_search'] is True
        assert row['allowed_actions'] == {'can_read':True,'can_view_details':True}
    lifetime(value,db)


def test_album_grouping_is_after_complete_selection_and_before_page(popular_db):
    db = popular_db
    first = gallery(db,limit=1)
    album_wire(first,db)
    assert [a['name'] for a in first['albums']] == ['Mix Album 0']
    assert first['page']['total_matches'] == 2
    assert first['popularity']['selected_recordings'] == 6
    second = gallery(db,limit=1,cursor=first['page']['next_cursor'])
    assert [a['name'] for a in second['albums']] == ['Mix Album 1']
    assert second['page']['has_more'] is False and second['page']['next_cursor'] is None
    capped = gallery(db,query=':tracks :popular per_artist:1',limit=1)
    assert capped['page']['total_matches'] == 2 and capped['popularity']['selected_recordings'] == 2
    with db.connect() as con: db.observe(con,db.tracks[3],999)
    assert [a['name'] for a in gallery(db)['albums']] == ['Mix Album 1','Mix Album 0']


@pytest.mark.parametrize('track_source', [False,True])
def test_exact_sibling_admission_full_post_cap_membership_no_child_resolution(popular_db,monkeypatch,track_source):
    db = popular_db
    page = read(db,query=':popular per_artist:1') if track_source else gallery(db,query=':popular per_artist:1')
    # Fresh source-native proof precedes the observed witness operation.
    native_result = native(db,page,operation='single',intent='details') if track_source else target(db,page)
    key = native_result['data']['native_target']['album_ref']
    calls = {'capture':0,'selection':0,'album':0}
    for container,name,label in [(search.inventory,'capture','capture'),
            (search,'select_local_popular_tracks','selection'),(PrivateNativeTargets,'resolve_album','album')]:
        actual = getattr(container,name)
        def observe(*args,_actual=actual,_label=label,**kwargs):
            calls[_label] += 1
            return _actual(*args,**kwargs)
        monkeypatch.setattr(container,name,observe)
    def forbidden(*args,**kwargs): raise AssertionError('Per-child native metadata resolution')
    monkeypatch.setattr(PrivateNativeTargets,'resolve',forbidden)
    result = witness(db,page,key,[db.tracks[0],db.tracks[1],db.tracks[3],9223372036854775807])
    assert set(result) == {'private_search','contract_version','context_ref','page_key','data','lifetime'}
    assert result['contract_version'] == 'popularity-search-album-matches-v1'
    assert result['page_key'] == 'search-detail-page-1' and set(result['data']) == {'items'}
    assert result['data']['items'] == [
        {'slot':'search-detail-row-1','match_state':'known','matches_search':True},
        {'slot':'search-detail-row-2','match_state':'known','matches_search':False},
        {'slot':'search-detail-row-3','match_state':'unavailable','matches_search':None},
        {'slot':'search-detail-row-4','match_state':'unavailable','matches_search':None}]
    assert calls == {'capture':1,'selection':1,'album':1}
    lifetime(result,db)


def test_unmatched_readable_sibling_is_false_and_denied_is_unavailable(popular_db):
    db = popular_db
    with db.connect() as con: set_genre(con,db.tracks[1],'rock')
    page = gallery(db,query='genre:jazz :popular')
    key = target(db,page)['data']['native_target']['album_ref']
    assert witness(db,page,key,[db.tracks[1]])['data']['items'][0]['matches_search'] is False
    constraints = deny_resource('track',db.tracks[1])
    page = gallery(db,query='genre:jazz :popular',constraints=constraints)
    key = target(db,page,constraints=constraints)['data']['native_target']['album_ref']
    assert witness(db,page,key,[db.tracks[1]],constraints=constraints)['data']['items'] == [
        {'slot':'search-detail-row-1','match_state':'unavailable','matches_search':None}]


def test_publication_interval_and_fresh_native_key_proof(popular_db,monkeypatch):
    db = popular_db
    first = gallery(db,limit=1)
    second = gallery(db,limit=1,cursor=first['page']['next_cursor'])
    real = PrivateNativeTargets.resolve_album
    calls = []
    def observe(*args,**kwargs):
        calls.append(True); return real(*args,**kwargs)
    monkeypatch.setattr(PrivateNativeTargets,'resolve_album',observe)
    error(403,lambda:target(db,first,ref=second['albums'][0]['id']))
    assert calls == []
    error(409,lambda:witness(db,first,'wrong-native-key',[db.tracks[0]]))
    assert len(calls) == 1


def test_original_expiry_survives_continuation_target_and_witness(popular_db):
    db = popular_db
    first = gallery(db,limit=1)
    db.clock_time += timedelta(seconds=1799)
    second = gallery(db,limit=1,cursor=first['page']['next_cursor'])
    lifetime(second,db,first['lifetime'])
    resolved = target(db,second)
    assert set(resolved) == {'private_search','contract_version','context_ref','result_token','data','lifetime'}
    assert resolved['result_token'] == second['native']['result_token']
    lifetime(resolved,db,first['lifetime'])
    proof = witness(db,second,resolved['data']['native_target']['album_ref'],[db.tracks[3]])
    lifetime(proof,db,first['lifetime'])
    db.clock_time += timedelta(seconds=1)
    error(409,lambda:target(db,second))
    error(409,lambda:witness(db,second,resolved['data']['native_target']['album_ref'],[db.tracks[3]]))


@pytest.mark.parametrize('change',['unmatched_genre','unmatched_title','unmatched_parent','artist_name','album_metadata','alias_frame','cache'])
@pytest.mark.parametrize('operation',['target','matches'])
def test_final_full_source_fence_after_actual_native_resolution(popular_db,monkeypatch,change,operation):
    db = popular_db
    with db.connect() as con: set_genre(con,db.tracks[1],'rock')
    page = gallery(db,query='genre:jazz :popular')
    key = target(db,page)['data']['native_target']['album_ref']
    real = PrivateNativeTargets.resolve_album
    def changed(self,connection,live,album_id,**kwargs):
        result = real(self,connection,live,album_id,**kwargs)
        if change == 'unmatched_genre': set_genre(connection,db.tracks[1],'blues')
        elif change == 'unmatched_title': connection.execute('update library.local_tracks set title=title || %s where id=%s',(' changed',db.tracks[1]))
        elif change == 'unmatched_parent': connection.execute('update library.local_tracks set album_id=%s where id=%s',(db.albums[1],db.tracks[1]))
        elif change == 'artist_name': connection.execute('update library.local_artists set name=name || %s where id=%s',(' changed',db.artists[1]))
        elif change == 'album_metadata': connection.execute("update library.local_albums set metadata=metadata || '{\"edition\":\"changed\"}'::jsonb where id=%s",(db.albums[1],))
        elif change == 'alias_frame': connection.execute("""update library.libraries set metadata=jsonb_set(metadata,
            '{scan_cache,relation_projection}',coalesce(metadata#>'{scan_cache,relation_projection}','{}'::jsonb)
            || '{\"g1_probe\":true}'::jsonb) where id=%s""",(db.library,))
        else: connection.execute('update catalog.popularity_source_slots set current_revision=null where source_entity_id=%s',(db.source_ids[db.tracks[5]],))
        return result
    monkeypatch.setattr(PrivateNativeTargets,'resolve_album',changed)
    error(409,lambda:target(db,page) if operation == 'target' else witness(db,page,key,[db.tracks[0],db.tracks[1]]))


@pytest.mark.parametrize('operation',['target','matches'])
def test_expiry_crossed_after_native_resolution_never_returns_lifetime(popular_db,monkeypatch,operation):
    db = popular_db
    page = gallery(db)
    key = target(db,page)['data']['native_target']['album_ref']
    real = PrivateNativeTargets.resolve_album
    def delayed(*args,**kwargs):
        result = real(*args,**kwargs); db.clock_time += timedelta(seconds=1800); return result
    monkeypatch.setattr(PrivateNativeTargets,'resolve_album',delayed)
    error(409,lambda:target(db,page) if operation == 'target' else witness(db,page,key,[db.tracks[0]]))


def test_empty_selection_still_runs_full_final_facet_gate(popular_db,monkeypatch):
    db = popular_db
    page = gallery(db,query='genre:absent :popular')
    album_wire(page,db)
    assert page['albums'] == [] and page['page'] == {'limit':100,'returned_count':0,'has_more':False,'next_cursor':None,'total_matches':0}
    error(403,lambda:target(db,page,ref='popular_album_'+'0'*64))
    actual = search.PostgresPopularitySearch._finalize_album_source
    def drift(self,connection,live,captured,request,expires_at,constraints):
        assert captured.matched_rows == {}
        set_genre(connection,db.tracks[1],'blues')
        return actual(self,connection,live,captured,request,expires_at,constraints)
    monkeypatch.setattr(search.PostgresPopularitySearch,'_finalize_album_source',drift)
    error(409,lambda:gallery(db,query='genre:absent :popular'))


def test_v1_tracks_and_native_envelopes_remain_unchanged(popular_db):
    page = read(popular_db)
    assert_wire(page)
    assert 'lifetime' not in page
    result = native(popular_db,page,operation='single')
    assert_native(result,page,'single',[page['tracks'][0]['id']])
    assert 'lifetime' not in result
    codec = PopularitySearchCodec(SECRET)
    decoded = codec.decode(page['native']['result_token'],'publication',int(popular_db.clock_time.timestamp()))
    assert decoded['version'] == 1 and 'presentation' not in decoded


@pytest.mark.parametrize('previously_allowed',[True,False])
def test_final_decision_drift_including_previously_denied_sibling(popular_db,monkeypatch,previously_allowed):
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    db = popular_db
    changed = [False]
    def constraints(ctx):
        hit = (ctx.action == 'library.browse.read' and ctx.resource is not None
            and ctx.resource.resource_kind == 'track' and ctx.resource.resource_ref == str(db.tracks[1]))
        allow = (not previously_allowed if changed[0] else previously_allowed) if hit else True
        return PolicyEvaluationConstraints(request_origin_allowed=allow)
    page = gallery(db,query=':popular per_artist:1',constraints=constraints)
    key = target(db,page,constraints=constraints)['data']['native_target']['album_ref']
    real = PrivateNativeTargets.resolve_album
    def drift(*args,**kwargs):
        value = real(*args,**kwargs); changed[0] = True; return value
    monkeypatch.setattr(PrivateNativeTargets,'resolve_album',drift)
    error(409,lambda:witness(db,page,key,[db.tracks[0],db.tracks[1]],constraints=constraints))


def test_final_media_permission_loss_downgrades_album_target(popular_db,monkeypatch):
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    db = popular_db
    grant_media(db)
    page = gallery(db)
    changed = [False]
    def constraints(ctx):
        return PolicyEvaluationConstraints(request_origin_allowed=not (changed[0] and ctx.action == 'library.media.read'))
    real = PrivateNativeTargets.resolve_album
    def drift(*args,**kwargs):
        value = real(*args,**kwargs); changed[0] = True; return value
    monkeypatch.setattr(PrivateNativeTargets,'resolve_album',drift)
    result = target(db,page,constraints=constraints)
    assert result['data']['native_target']['allowed_actions'] == {'can_view_details':True,'can_play_album':False}


def test_other_physical_recording_copy_never_acquires_membership(popular_db):
    from psycopg.types.json import Jsonb
    from tests.py.test_private_popularity_search_postgres import _append_mapping
    db = popular_db
    with db.connect() as con:
        con.execute('update library.local_tracks set album_id=%s where id=%s',(db.albums[1],db.tracks[1]))
        con.execute("""update library.local_track_files set metadata=jsonb_set(metadata,
            '{scan_cache,file_entry,musicbrainz_recording_id}',%s) where track_id=%s""",
            (Jsonb(db.recordings[db.tracks[0]]),db.tracks[1]))
        _append_mapping(con,db,db.tracks[1],recording=db.recordings[db.tracks[0]],
            source=db.source_ids[db.tracks[1]],artist=db.artist_mbids[0])
        db.observe(con,db.tracks[1],999)
    page = gallery(db,limit=1)
    assert page['popularity']['selected_recordings'] == 5
    assert page['albums'][0]['name'] == 'Mix Album 0'
    second = gallery(db,limit=1,cursor=page['page']['next_cursor'])
    assert second['albums'][0]['name'] == 'Mix Album 1'
    key = target(db,second)['data']['native_target']['album_ref']
    assert witness(db,second,key,[db.tracks[1]])['data']['items'] == [
        {'slot':'search-detail-row-1','match_state':'known','matches_search':False}]


def test_same_parent_sibling_requires_its_own_track_artist_admission(popular_db):
    db = popular_db
    with db.connect() as con:
        con.execute('update library.local_tracks set artist_id=%s where id=%s',(db.artists[1],db.tracks[1]))
        db.rebind_mappings(con,[db.tracks[1]])
    constraints = deny_resource('artist',db.artists[1])
    page = gallery(db,constraints=constraints)
    assert [row['name'] for row in page['albums']] == ['Mix Album 0']
    key = target(db,page,constraints=constraints)['data']['native_target']['album_ref']
    assert witness(db,page,key,[db.tracks[0],db.tracks[1]],constraints=constraints)['data']['items'] == [
        {'slot':'search-detail-row-1','match_state':'known','matches_search':True},
        {'slot':'search-detail-row-2','match_state':'unavailable','matches_search':None}]
