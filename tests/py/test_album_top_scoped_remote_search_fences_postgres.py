"""Separate actual-role scoped search lifecycle and resource-bound regressions."""
import pytest
from tests.py.test_album_top_scoped_remote_search_postgres import (
    artist_remote,mixed,retained,remote,db,urls,facts,install,search,descriptor,create,ARTIST,OTHER)
from tests.py.test_album_top_remote_artist_scope_bounds_postgres import expand_family
from tests.py.remote_top_postgres_support import sql_error, destination, CONTEXT
from tests.py.test_album_top_remote_membership_postgres import record_owner_sql
from tests.py.test_album_top_collaboration_postgres import member,write
from tests.py.test_owned_album_tops_postgres import assert_error


@pytest.mark.parametrize('total',[5000,5001])
def test_complete_identity_vector_bound_precedes_provider_and_final_locks(artist_remote,total):
    case=artist_remote;expand_family(case,total);calls=install(case,[facts(case,(ARTIST,))]);before=case.snapshot()
    with record_owner_sql(case.db) as sql:
        if total==5000:
            assert len(search(case,scope=descriptor(case.db,'family'))['candidates'])==1
        else:
            assert_error(lambda:search(case,scope=descriptor(case.db,'family')),'artist_scope_unavailable',409)
    assert len(calls)==(1 if total==5000 else 0)
    assert case.snapshot()==before
    if total>5000:
        assert not any('local_artists' in text and 'for share' in text for _,text,_ in sql)


@pytest.mark.parametrize('changed',['family','root_key','root_name'])
def test_provider_gap_rejects_changed_root_or_relation_witness(artist_remote,changed):
    case=artist_remote
    def change():
        with case.db.connect() as con:
            if changed=='family':
                con.execute('delete from library.local_artist_family_links where library_id=%s and artist_id=%s',
                    (case.db.library,case.db.scope_artists[0]))
            else:
                field='artist_key' if changed=='root_key' else 'name'
                con.execute('update library.local_artists set '+field+'=%s where library_id=%s and id=%s',
                    ('Changed '+case.db.token,case.db.library,case.db.scope_artists[0]))
    calls=install(case,[facts(case,(ARTIST,))],change)
    assert_error(lambda:search(case,scope=descriptor(case.db,'family')),'artist_scope_changed',409)
    assert len(calls)==1


@pytest.mark.parametrize('changed',['session','account','editor','deleted'])
def test_saved_scope_rechecks_actual_caller_and_destination_after_provider(artist_remote,changed):
    case=artist_remote;editor=member(case.db);top,_=create(case.db,refs=[])
    top,_=write(case.db,'grant_editor',top,account_id=editor.account_id,role='editor');grant=top['grant_ref']
    def change():
        if changed=='deleted':
            write(case.db,'delete',top);return
        with case.db.connect() as con:
            if changed=='session':con.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s',(editor.session_id,))
            elif changed=='account':con.execute('update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s',(editor.account_id,))
            else:con.execute('delete from app.album_list_access_grants where ref=%s',(grant,))
    calls=install(case,[facts(case,(ARTIST,))],change)
    callback=lambda:case.remote.service.search_candidates(case.db.context(editor),destination=destination(top),
        title='Album',artist='',context_ref=CONTEXT)
    assert_error(callback,*(('top_unavailable',404) if changed in ('editor','deleted') else ('forbidden',403)))
    assert len(calls)==1


def test_final_identity_lock_is_held_through_returning_transaction(artist_remote):
    case=artist_remote;install(case,[facts(case,(ARTIST,))]);observed=[]
    def after(sql,connection):
        if 'library.local_artists' in sql and 'for share' in sql and 'nowait' in sql and not observed:
            with case.db.connect() as writer:
                writer.execute("set local lock_timeout='100ms'")
                writer.execute("set local statement_timeout='2s'")
                sql_error(writer,'55P03',lambda:writer.execute(
                    'update library.local_artists set mbid=%s::uuid where library_id=%s and id=%s',
                    (OTHER,case.db.library,case.db.scope_artists[0])))
            observed.append(True)
    case.remote.after_statement=after
    try:assert len(search(case)['candidates'])==1
    finally:case.remote.after_statement=None
    assert observed==[True]
