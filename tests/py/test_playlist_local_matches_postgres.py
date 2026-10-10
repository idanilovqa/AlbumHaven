"""Real PostgreSQL and generated files: explicit draft match to immutable Save."""
from dataclasses import replace
from datetime import timedelta
import hashlib
import json
from uuid import uuid4

import pytest

from music_app.services import playlist_local_matches as matches
from music_app.services import playlist_missing_sources as missing
from music_app.services.owned_playlists import PlaylistError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_owned_playlist_postgres_integration import db, urls
from tests.py.test_playlist_extended_sources_postgres import missing_playlist, create_command


def add_candidate(db,root,*,title='Track 0 (Remastered 2020)',artist=None,real=True):
    token=uuid4().hex
    with db.connect() as con:
        original=con.execute('select artist_id,album_id from library.local_tracks where id=%s',(db.tracks[0],)).fetchone()
        artist_id=original['artist_id']
        if artist is not None:
            artist_id=con.execute('insert into library.local_artists(library_id,artist_key,name) values(%s,%s,%s) returning id',
                (db.library,token,artist)).fetchone()['id']
        track=con.execute('''insert into library.local_tracks(library_id,artist_id,album_id,track_key,title,duration_seconds)
            values(%s,%s,%s,%s,%s,181) returning id''',(db.library,artist_id,original['album_id'],token,title)).fetchone()['id']
        root_id=con.execute('select id from library.library_roots where library_id=%s order by id limit 1',(db.library,)).fetchone()['id']
        path=root/(token+'.flac')
        con.execute('insert into library.local_track_files(track_id,library_root_id,private_path,content_signature) values(%s,%s,%s,%s)',
            (track,root_id,str(path),token))
    if real:path.write_bytes(b'generated candidate file')
    return track,path


@pytest.fixture
def draft(missing_playlist):
    db,root,playlist=missing_playlist
    first,path=add_candidate(db,root)
    second,other=add_candidate(db,root,title='Track 0 feat. Guest')
    data=missing.inspect(db.service,db.context(),playlist['playlist_id'],'1')['data']
    request={'source':data['source'],'entry_ref':data['entries'][0]['entry_ref']}
    return db,root,playlist,data,request,[(first,path),(second,other)]


def review(draft,**kwargs):
    db,_,_,_,request,_=draft
    return matches.review(db.service,db.context(),request,**kwargs)['data']


def acceptance(request,review,index=0):
    return {**request,'review_ref':review['review_ref'],'candidate_ref':review['candidates'][index]['candidate_ref']}


def accept(draft,review_data=None,index=0,**kwargs):
    db,_,_,_,request,_=draft
    reviewed=review_data or review(draft)
    payload=acceptance(request,reviewed,index)
    return matches.accept(db.service,db.context(),payload,**kwargs),payload


def deny_track(identity):
    def constraints(ctx):
        denied=(ctx.action=='library.browse.read' and ctx.resource is not None
            and ctx.resource.resource_kind=='track' and ctx.resource.resource_ref==str(identity))
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    return constraints


def test_explicit_match_is_unsaved_and_save_preserves_source_facts_and_lineage(draft):
    db,_,playlist,data,request,candidates=draft
    with db.connect() as con:
        original=con.execute('select * from app.playlist_creation_entries where ref=%s',(request['entry_ref'],)).fetchone()
    reviewed=review(draft)
    assert len(reviewed['candidates'])==2
    assert set(reviewed['candidates'][0])=={'candidate_ref','inventory_track_ref','title','artist','album_title','duration_seconds'}
    assert reviewed['source']==request['source'] and reviewed['entry_ref']==request['entry_ref']
    assert reviewed['suggestion_scope']=='bounded_local_inventory' and reviewed['suggestions_complete']
    result,payload=accept(draft,reviewed)
    entry=result['data']['entry']
    assert entry['entry_ref']==request['entry_ref'] and entry['match_state']=='accepted' and entry['availability']=='local'
    for key in ('title','artist','album_title','duration_seconds','selection_ref','allowed_actions','parent_album'):
        assert entry[key]==data['entries'][0][key]
    assert entry['inventory_track_ref']!=data['entries'][0]['inventory_track_ref']
    assert db.count('playlists')==db.count('playlist_operations')==1
    assert matches.accept(db.service,db.context(),payload)==result
    with db.connect() as con:
        assert con.execute('select * from app.playlist_creation_entries where ref=%s',(request['entry_ref'],)).fetchone()==original
        assert con.execute('select revision from app.playlists where ref=%s',(playlist['playlist_id'],)).fetchone()['revision']==1
    saved=db.service.execute(db.context(),create_command(data))
    chosen=int(entry['inventory_track_ref'].split(':')[-1])
    with db.connect() as con:
        rows=con.execute('select * from app.playlist_items where playlist_ref=%s order by position',(saved['playlist_id'],)).fetchall()
    assert rows[0]['original_local_track_id']==db.tracks[0] and rows[0]['local_track_id']==chosen
    for key in ('title','artist','album_title','duration_seconds','source_lineage','original_album_id'):
        assert rows[0][key]==original[key]
    assert rows[0]['source_entry_ref']==original['ref']
    assert rows[1]['local_track_id']==db.tracks[1]


def test_match_only_requires_browse_and_create_not_media(draft):
    def constraints(ctx):return PolicyEvaluationConstraints(request_origin_allowed=ctx.action!='library.media.read')
    reviewed=review(draft,constraints=constraints)
    assert reviewed['candidates']
    assert accept(draft,reviewed,constraints=constraints)[0]['data']['entry']['availability']=='local'


def test_superseded_reviews_and_choices_cannot_overwrite_current_match(draft):
    db,_,_,_,request,_=draft
    first=review(draft)
    second=review(draft)
    with pytest.raises(PlaylistError,match='match_review_changed'):
        matches.accept(db.service,db.context(),acceptance(request,first))
    current,payload=accept(draft,second)
    with pytest.raises(PlaylistError,match='match_review_changed'):
        accept(draft,second,1)
    third=review(draft)
    assert matches.accept(db.service,db.context(),payload)==current
    newer,_=accept(draft,third,1)
    assert newer['data']['entry']['inventory_track_ref']!=current['data']['entry']['inventory_track_ref']
    with pytest.raises(PlaylistError,match='match_review_changed'):
        matches.accept(db.service,db.context(),payload)


@pytest.mark.parametrize('change',['metadata','file_signature','file_deleted','file_replaced','root_unknown','stale'])
@pytest.mark.parametrize('phase',['accept','save','replay'])
def test_changed_or_unproven_candidate_never_applies_stale_choice(draft,change,phase):
    db,_,_,data,request,candidates=draft
    reviewed=review(draft)
    chosen=int(reviewed['candidates'][0]['inventory_track_ref'].split(':')[-1])
    path=dict(candidates)[chosen]
    payload=acceptance(request,reviewed)
    if phase in {'save','replay'}:matches.accept(db.service,db.context(),payload)
    if change=='file_deleted':path.unlink()
    elif change=='file_replaced':path.write_bytes(b'a different real file')
    else:
        with db.connect() as con:
            if change=='metadata':con.execute("update library.local_tracks set title='Other title' where id=%s",(chosen,))
            elif change=='file_signature':con.execute("update library.local_track_files set content_signature='changed' where track_id=%s",(chosen,))
            elif change=='stale':con.execute("update library.local_track_files set metadata=jsonb_build_object('scan_cache',jsonb_build_object('stale',true,'stale_marked_at',now()::text)) where track_id=%s",(chosen,))
            else:
                # A separate unknown root invalidates only this candidate, not the original missing evidence.
                root=con.execute('insert into library.library_roots(library_id,root_path) values(%s,%s) returning id',
                    (db.library,str(path.parent/'unknown-root'))).fetchone()['id']
                con.execute('update library.local_track_files set library_root_id=%s where track_id=%s',(root,chosen))
    with pytest.raises(PlaylistError,match='match_unavailable'):
        if phase=='save':db.service.execute(db.context(),create_command(data))
        else:matches.accept(db.service,db.context(),payload)
    assert db.count('playlists')==db.count('playlist_operations')==1


@pytest.mark.parametrize('phase',['review','accept','save'])
@pytest.mark.parametrize('change',['original_restored','original_denied','revision','expired','create_denied'])
def test_original_missing_source_and_authority_are_fresh_at_every_boundary(draft,phase,change):
    db,root,playlist,data,request,_=draft
    reviewed=review(draft)
    if phase=='save':accept(draft,reviewed)
    constraints=None
    if change=='original_restored':(root/'0.flac').write_bytes(b'restored original')
    elif change=='original_denied':constraints=deny_track(db.tracks[0])
    elif change=='create_denied':
        constraints=lambda ctx:PolicyEvaluationConstraints(request_origin_allowed=ctx.action!='library.playlists.create')
    else:
        with db.connect() as con:
            if change=='revision':con.execute('update app.playlists set revision=revision+1 where ref=%s',(playlist['playlist_id'],))
            else:con.execute("update app.playlist_creation_sources set expires_at=now()-interval '1 second' where library_id=%s",(db.library,))
    with pytest.raises(PlaylistError):
        if phase=='review':review(draft,constraints=constraints)
        elif phase=='accept':accept(draft,reviewed,constraints=constraints)
        else:db.service.execute(db.context(),create_command(data),constraints=constraints)
    assert db.count('playlists')==1


def test_candidate_browse_denial_is_independent_and_revalidated(draft):
    db,_,_,data,_,candidates=draft
    chosen=candidates[0][0]
    reviewed=review(draft)
    index=next(i for i,row in enumerate(reviewed['candidates']) if row['inventory_track_ref'].endswith(':'+str(chosen)))
    narrowed=review(draft,constraints=deny_track(chosen))
    assert all(not row['inventory_track_ref'].endswith(':'+str(chosen)) for row in narrowed['candidates'])
    reviewed=review(draft)
    with pytest.raises(PlaylistError,match='match_unavailable'):accept(draft,reviewed,index,constraints=deny_track(chosen))
    accept(draft,reviewed,index)
    with pytest.raises(PlaylistError,match='match_unavailable'):
        db.service.execute(db.context(),create_command(data),constraints=deny_track(chosen))


def test_metadata_without_file_and_wrong_artist_are_never_suggestions(draft):
    db,root,_,_,_,_=draft
    unavailable,_=add_candidate(db,root,real=False)
    foreign,_=add_candidate(db,root,artist='Unrelated Artist')
    reviewed=review(draft)
    ids={int(row['inventory_track_ref'].split(':')[-1]) for row in reviewed['candidates']}
    assert unavailable not in ids and foreign not in ids


def test_symlink_outside_authorized_root_cannot_be_a_match(draft,tmp_path):
    db,root,_,_,_,_=draft
    track,path=add_candidate(db,root,real=False)
    outside=tmp_path/'outside.flac';outside.write_bytes(b'outside library')
    path.symlink_to(outside)
    assert all(not row['inventory_track_ref'].endswith(':'+str(track)) for row in review(draft)['candidates'])


def test_pool_and_results_are_bounded_and_disclose_partial_suggestions(draft):
    db,root,_,_,_,_=draft
    for index in range(matches.CANDIDATE_POOL_LIMIT+2):add_candidate(db,root,title='Track 0')
    result=review(draft)
    assert len(result['candidates'])==matches.MAX_SUGGESTIONS
    assert result['suggestions_complete'] is False


def test_review_and_choice_are_bound_to_actor_session_and_entry(draft):
    db,_,_,data,request,_=draft
    reviewed=review(draft)
    payload=acceptance(request,reviewed)
    with db.connect() as con:
        other=db.member(con,db.actor(con))
        session=con.execute('''insert into app.account_sessions(account_id,session_token_hash,created_at,authenticated_at,
            last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,now(),now(),now(),now()+interval '1 hour',now()+interval '1 day') returning id''',
            (db.owner.account_id,hashlib.sha256(uuid4().bytes).digest())).fetchone()['id']
    for actor in (other,replace(db.owner,session_id=session)):
        with pytest.raises(PlaylistError,match='source_unavailable'):
            matches.accept(db.service,db.context(actor),payload)
    with pytest.raises(PlaylistError,match='match_review_changed'):
        matches.accept(db.service,db.context(),{**payload,'entry_ref':data['entries'][1]['entry_ref']})
    with pytest.raises(PlaylistError,match='match_unavailable'):
        matches.accept(db.service,db.context(),{**payload,'candidate_ref':str(uuid4())})


@pytest.mark.parametrize('stage',['review','accept'])
@pytest.mark.parametrize('expired',['source','session'])
def test_post_wait_clock_is_checked_before_receipt_mutation(draft,stage,expired):
    db,_,_,_,_,_=draft
    reviewed=review(draft)
    times=iter([db.now,db.now+timedelta(minutes=40 if expired=='source' else 120)])
    db.service._clock=lambda:next(times)
    with db.connect() as con:
        before=con.execute('select * from app.playlist_local_match_receipts where source_ref in (select ref from app.playlist_creation_sources where library_id=%s)',(db.library,)).fetchall()
    with pytest.raises(PlaylistError,match='source_expired' if expired=='source' else 'forbidden'):
        if stage=='review':review(draft)
        else:accept(draft,reviewed)
    with db.connect() as con:
        after=con.execute('select * from app.playlist_local_match_receipts where source_ref in (select ref from app.playlist_creation_sources where library_id=%s)',(db.library,)).fetchall()
    assert after==before


def test_no_private_path_evidence_or_identity_merge_leaks(draft):
    db,root,_,_,_,_=draft
    reviewed=review(draft)
    accepted,_=accept(draft,reviewed)
    wire=json.dumps([reviewed,accepted])
    assert str(root) not in wire
    for key in ('evidence_digest','private_path','chosen_track_id','original_local_track_id','source_lineage'):
        assert key not in wire
    assert accepted['data']['entry']['canonical_track_ref'] is None


def test_receipt_role_privileges_and_source_cleanup(draft):
    db,_,_,_,_,_=draft
    review(draft)
    with db.connect() as con:
        assert not con.execute("""select 1 from pg_class c, lateral aclexplode(c.relacl) acl
            where c.oid='app.playlist_local_match_receipts'::regclass and acl.grantee=0""").fetchone()
        for role in ('album_haven_readonly',):
            exists=con.execute('select 1 from pg_roles where rolname=%s',(role,)).fetchone()
            if exists:
                assert not con.execute("select has_table_privilege(%s,'app.playlist_local_match_receipts','SELECT') as allowed",(role,)).fetchone()['allowed']
        for privilege in ('SELECT','INSERT','UPDATE'):
            assert con.execute("select has_table_privilege('album_haven_app','app.playlist_local_match_receipts',%s) as allowed",(privilege,)).fetchone()['allowed']
        for privilege in ('DELETE','TRUNCATE','REFERENCES','TRIGGER'):
            assert not con.execute("select has_table_privilege('album_haven_app','app.playlist_local_match_receipts',%s) as allowed",(privilege,)).fetchone()['allowed']
        con.execute('delete from app.playlist_creation_sources where library_id=%s',(db.library,))
        assert con.execute('select count(*) as n from app.playlist_local_match_receipts where entry_ref=%s',(draft[4]['entry_ref'],)).fetchone()['n']==0


def test_sql_pool_uses_same_normalized_artist_including_unicode_and_punctuation(draft):
    db,root,_,_,_,_=draft
    track,_=add_candidate(db,root,artist='ＡＲＴＩＳＴ!!!')
    assert any(row['inventory_track_ref'].endswith(':'+str(track)) for row in review(draft)['candidates'])


def test_missing_draft_choices_do_not_leak_into_a_new_inspect_capture(draft):
    db,_,playlist,_,request,_=draft
    accept(draft)
    fresh=missing.inspect(db.service,db.context(),playlist['playlist_id'],'1')['data']
    assert all(row['entry_ref']!=request['entry_ref'] and row['availability']=='missing' for row in fresh['entries'])
    assert all('match_state' not in row for row in fresh['entries'])


def test_deleted_source_playlist_or_revoked_session_cannot_review_or_accept(draft):
    db,_,playlist,_,_,_=draft
    reviewed=review(draft)
    with db.connect() as con:
        con.execute('update app.playlists set deleted_at=now() where ref=%s',(playlist['playlist_id'],))
    with pytest.raises(PlaylistError,match='playlist_unavailable'):review(draft)
    with pytest.raises(PlaylistError,match='playlist_unavailable'):accept(draft,reviewed)
    with db.connect() as con:
        con.execute('update app.playlists set deleted_at=null where ref=%s',(playlist['playlist_id'],))
        con.execute('update app.account_sessions set revoked_at=now() where id=%s',(db.owner.session_id,))
    with pytest.raises(PlaylistError,match='forbidden'):review(draft)
    with pytest.raises(PlaylistError,match='forbidden'):accept(draft,reviewed)


def test_narrowed_suggestions_do_not_expose_hidden_pool_completeness(draft):
    hidden=draft[5][0][0]
    data=review(draft,constraints=deny_track(hidden))
    assert data['candidates']
    assert all(row['inventory_track_ref']!=f'inventory-track:{draft[0].library}:{hidden}' for row in data['candidates'])
    assert data['suggestions_complete'] is False
