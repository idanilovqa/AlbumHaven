"""Contract-first scoped search through actual service, authority and PostgreSQL.

Only provider facts/search callback are synthetic. No product helper is replaced.
"""
from dataclasses import replace
from uuid import uuid4
import pytest
from music_app.services.owned_album_tops import CREATE, ITEMS, BROWSE, AlbumTopError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.remote_top_postgres_support import remote, db, urls, evidence, destination, CONTEXT
from tests.py.remote_top_retention_postgres_support import retained
from tests.py.test_album_top_remote_membership_postgres import mixed, record_owner_sql
from tests.py.test_album_top_artist_scope_postgres import seed_scope, descriptor, create, deny
from tests.py.test_album_top_remote_artist_scope_postgres import artist_remote, identity, ARTIST, OTHER, OUTSIDE
from tests.py.test_remote_album_credited_storage_postgres import credit_facts
from tests.py.test_owned_album_tops_postgres import assert_error


def facts(case, ids):
    case.remote.facts = evidence(mbid=str(uuid4()))
    return credit_facts(case.remote, ids)


def search(case, *, scope=True, top=None, constraints=None, should_cancel=None):
    return case.remote.service.search_candidates(case.db.context(), destination=destination(top),
        title='Remote album', artist='Remote artist', context_ref=CONTEXT,
        constraints=constraints, should_cancel=should_cancel,
        **({'artist_scope': descriptor(case.db)} if scope is True else {} if scope is False else {'artist_scope': scope}))


def install(case, values, hook=None):
    calls=[]
    def searcher(title, artist, **options):
        case.remote.outside_authority()
        # No Artist lock from the first pass may survive into provider I/O.
        with case.db.connect() as con:
            con.execute('select id from library.local_artists where library_id=%s and id=any(%s) for update nowait',
                (case.db.library, list(case.db.scope_artists))).fetchall()
        calls.append((title,artist,options))
        if hook is not None:
            hook()
        return tuple(values)
    case.remote.service.searcher=searcher
    return calls


@pytest.mark.parametrize('mode', ['artist','family'])
def test_scoped_search_filters_before_scalar_projection_without_source_writes(artist_remote, mode):
    case=artist_remote
    values=[facts(case,(OTHER,)),facts(case,None),facts(case,(ARTIST,ARTIST)),facts(case,(OUTSIDE,)),facts(case,(ARTIST,))]
    calls=install(case,values);before=case.snapshot()
    with record_owner_sql(case.db) as sql:
        result=search(case,scope=descriptor(case.db,mode))
    expected=[values[i].release_group_id for i in ([0,2,4] if mode=='family' else [2,4])]
    assert [row['release_group_id'] for row in result['candidates']]==expected
    assert len(calls)==1 and calls[0][:2]==('Remote album','Remote artist')
    assert result['limit']==10 and result['context_ref']==CONTEXT
    for row in result['candidates']:
        assert set(row)=={'source_kind','provider','entity_kind','release_group_id','title','artist_display',
            'first_release_date','primary_type','metadata_coverage','track_metadata_status','track_count'}
    assert case.snapshot()==before
    assert not any('insert into' in text.lower() or 'retain_top_remote' in text.lower() or 'consume_top_remote' in text.lower() for _,text,_ in sql)


def test_saved_scope_is_derived_without_client_descriptor(artist_remote):
    case=artist_remote;top,_=create(case.db,mode='family',refs=[])
    values=[facts(case,(OTHER,)),facts(case,(OUTSIDE,))];calls=install(case,values)
    result=search(case,scope=False,top=top)
    assert [row['release_group_id'] for row in result['candidates']]==[values[0].release_group_id]
    assert len(calls)==1


def test_saved_scope_override_rejects_before_provider(artist_remote):
    case=artist_remote;top,_=create(case.db,refs=[]);calls=install(case,[])
    assert_error(lambda:search(case,top=top),'invalid_command',422)
    assert calls==[]


@pytest.mark.parametrize('credits', [None,(OUTSIDE,)])
def test_no_proven_candidate_match_is_empty_not_an_admission_error(artist_remote,credits):
    case=artist_remote;calls=install(case,[facts(case,credits)])
    assert search(case)['candidates']==[];assert len(calls)==1


def test_known_match_survives_other_unknown_family_rows(artist_remote):
    case=artist_remote;identity(case,1,None,'missing',None)
    value=facts(case,(ARTIST,));install(case,[value])
    assert search(case,scope=descriptor(case.db,'family'))['candidates'][0]['release_group_id']==value.release_group_id


@pytest.mark.parametrize('state', ['missing','ambiguous','conflicting','low_confidence'])
def test_all_unknown_scope_rejects_before_provider(artist_remote,state):
    case=artist_remote;identity(case,0,None if state=='missing' else ARTIST,state,None if state=='missing' else 'synthetic_verified_credit')
    calls=install(case,[]);before=case.snapshot()
    assert_error(lambda:search(case),'artist_scope_unavailable',409)
    assert calls==[] and case.snapshot()==before


@pytest.mark.parametrize('value', [None,(OUTSIDE,)])
def test_ordinary_search_keeps_legacy_and_unrelated_candidates_without_artist_queries(artist_remote,value):
    case=artist_remote;candidate=facts(case,value);install(case,[candidate])
    with record_owner_sql(case.db) as sql:
        result=search(case,scope=False)
    assert result['candidates'][0]['release_group_id']==candidate.release_group_id
    assert not any('local_artists' in text or 'local_artist_family_links' in text for _,text,_ in sql)


@pytest.mark.parametrize('bad', ['duplicate_candidate','wrong_digest','empty_credits','list_credits'])
def test_invalid_provider_facts_fail_before_filtering(artist_remote,bad):
    case=artist_remote;value=facts(case,(OUTSIDE,))
    values=[value,value] if bad=='duplicate_candidate' else [replace(value,**(
        {'digest':'0'*64} if bad=='wrong_digest' else {'credited_artist_ids':() if bad=='empty_credits' else [OUTSIDE]}))]
    install(case,values);before=case.snapshot()
    assert_error(lambda:search(case),'invalid_provider_metadata',503)
    assert case.snapshot()==before


@pytest.mark.parametrize('changed', ['identity','unknown_family_identity'])
def test_provider_time_identity_changes_retire_entire_result(artist_remote,changed):
    case=artist_remote;mode='artist' if changed=='identity' else 'family'
    if changed=='unknown_family_identity':identity(case,1,None,'missing',None)
    value=facts(case,(ARTIST,))
    install(case,[value],lambda:identity(case,0 if changed=='identity' else 1,OUTSIDE))
    assert_error(lambda:search(case,scope=descriptor(case.db,mode)),'artist_scope_changed',409)


@pytest.mark.parametrize('capability',[BROWSE,CREATE])
def test_actual_capability_denial_precedes_provider(artist_remote,capability):
    case=artist_remote;calls=install(case,[])
    def constraints(context):
        return PolicyEvaluationConstraints(request_origin_allowed=context.action!=capability)
    with pytest.raises(AlbumTopError) as caught:search(case,constraints=constraints)
    assert caught.value.status_code in (403,404)
    assert calls==[]


def test_exact_artist_denial_precedes_provider(artist_remote):
    case=artist_remote;calls=install(case,[])
    assert_error(lambda:search(case,constraints=deny('artist',case.db.scope_artists[0])), 'artist_scope_unavailable',404)
    assert calls==[]


def test_cancellation_after_provider_rejects_without_source_writes(artist_remote):
    case=artist_remote;cancelled=[False];before=case.snapshot()
    install(case,[facts(case,(ARTIST,))],lambda:cancelled.__setitem__(0,True))
    assert_error(lambda:search(case,should_cancel=lambda:cancelled[0]),'provider_cancelled',503)
    assert case.snapshot()==before


@pytest.mark.parametrize('scope', [{},False,[],{'root_artist_id':'0','mode':'artist'},
    {'root_artist_id':'1','mode':'wrong'},{'root_artist_id':'1','mode':'artist','extra':True}])
def test_invalid_direct_scope_rejects_without_provider(artist_remote,scope):
    case=artist_remote;calls=install(case,[])
    # False is tested directly, because search() uses False to mean omission.
    assert_error(lambda:case.remote.service.search_candidates(case.db.context(),destination=destination(),
        title='Album',artist='',context_ref=CONTEXT,artist_scope=scope),'invalid_command',422)
    assert calls==[]


def test_final_artist_nowait_conflict_rejects_instead_of_waiting_or_returning_candidates(artist_remote):
    case=artist_remote;value=facts(case,(ARTIST,));held=[]
    def lock_after_provider_admission():
        manager=case.db.connect();con=manager.__enter__();held.append(manager)
        con.execute('select id from library.local_artists where library_id=%s and id=%s for update',
            (case.db.library,case.db.scope_artists[0])).fetchone()
    install(case,[value],lock_after_provider_admission)
    before=case.snapshot()
    try:
        assert_error(lambda:search(case),'artist_scope_changed',409)
    finally:
        for manager in reversed(held):manager.__exit__(None,None,None)
    assert case.snapshot()==before


def test_saved_revision_change_during_provider_rejects(artist_remote):
    case=artist_remote;top,_=create(case.db,refs=[])
    def mutate():
        with case.db.connect() as con:
            con.execute('update app.album_lists set revision=revision+1 where ref=%s',(top['top_ref'],))
    install(case,[facts(case,(ARTIST,))],mutate)
    assert_error(lambda:search(case,scope=False,top=top),'revision_conflict',409)
