"""Actual final callback/session and foreign-library boundaries; no helper stubs."""
from datetime import timedelta
from tests.py.test_album_top_scoped_remote_search_postgres import (
    artist_remote,mixed,retained,remote,db,urls,facts,install,search,descriptor,ARTIST,OTHER)
from tests.py.test_album_top_remote_artist_scope_postgres import identity
from tests.py.test_owned_album_tops_postgres import assert_error


def test_final_cancellation_observer_cannot_change_identity_after_second_capture(artist_remote):
    case=artist_remote;calls=install(case,[facts(case,(ARTIST,))])
    captures=[];mutated=[];events=[]
    def after(sql,connection):
        if sql.startswith('select id,artist_key,name,mbid,mbid_assertion_state,evidence_source') and 'library.local_artists' in sql:
            if 'for share' not in sql:
                captures.append(True);events.append('capture')
            else:events.append('final_lock')
    def cancelled():
        if len(captures)==2 and not mutated:
            identity(case,0,OTHER);mutated.append(True);events.append('callback_mutation')
        return False
    case.remote.after_statement=after
    try:
        assert_error(lambda:search(case,should_cancel=cancelled),'artist_scope_changed',409)
    finally:case.remote.after_statement=None
    assert len(calls)==1 and mutated==[True]
    assert events.count('capture')==2
    assert events.index('callback_mutation')>max(i for i,value in enumerate(events) if value=='capture')
    assert events.index('final_lock')>events.index('callback_mutation')


def test_foreign_library_root_is_unavailable_even_with_exact_matching_credits(artist_remote):
    case=artist_remote
    with case.db.connect() as con:
        other=case.db.actor(con);library=case.db.library_for(con,other)
        foreign=con.execute('''insert into library.local_artists(library_id,artist_key,name,mbid,mbid_assertion_state,evidence_source)
            values(%s,%s,%s,%s::uuid,'asserted','synthetic_verified_credit') returning id''',
            (library,'foreign-'+case.db.token,'Foreign Artist',ARTIST)).fetchone()['id']
    calls=install(case,[facts(case,(ARTIST,))]);before=case.snapshot()
    assert_error(lambda:search(case,scope=descriptor(case.db,root=foreign)),'artist_scope_unavailable',404)
    assert calls==[] and case.snapshot()==before


def test_session_expiry_after_final_artist_lock_rejects_candidate_response(artist_remote):
    case=artist_remote;clock=[case.db.now];case.db.service._clock=lambda:clock[0]
    calls=install(case,[facts(case,(ARTIST,))]);locked=[];before=case.snapshot()
    def after(sql,connection):
        if 'library.local_artists' in sql and 'for share nowait' in sql and not locked:
            locked.append(True);clock[0]+=timedelta(days=2)
    case.remote.after_statement=after
    try:assert_error(lambda:search(case),'forbidden',403)
    finally:case.remote.after_statement=None
    assert len(calls)==1 and locked==[True]
    assert case.snapshot()==before
