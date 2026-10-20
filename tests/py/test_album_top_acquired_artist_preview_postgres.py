"""Contract-first acquisition display projection through actual prepared owners."""
from uuid import UUID
import pytest
from music_app.services.owned_album_tops import AlbumTopError,BROWSE,CREATE
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.remote_preparation_postgres_support import preparations,db,urls
from tests.py.test_album_top_artist_scope_postgres import seed_scope,descriptor,create
from tests.py.test_album_top_remote_artist_scope_postgres import identity,ARTIST,OTHER,OUTSIDE
from tests.py.test_remote_album_credited_storage_postgres import credit_facts
from tests.py.test_owned_album_tops_postgres import assert_error


@pytest.fixture
def preview_case(preparations):
    case=preparations;case.db.scope_artists=seed_scope(case.db)
    for index,mbid in enumerate((ARTIST,OTHER,OUTSIDE)):identity(case,index,mbid)
    return case


def setup(case,credits=(ARTIST,),mode='artist',saved=False):
    case.facts=credit_facts(case,credits)
    top=create(case.db,mode=mode,refs=[])[0] if saved else None
    target={'kind':'top','top_ref':top['top_ref'],'revision':top['revision']} if saved else None
    parent,target=case.begin(target)
    return case.command(parent,target),descriptor(case.db,mode)


def acquire(case,command,scope,**options):
    return case.acquire(command,**({'artist_scope':scope} if scope is not None else {}),**options)


def expected(scope,result,main):
    return {'artist_scope':scope,'evidence_version':result['evidence_version'],'main_artist_match':main}


@pytest.mark.parametrize('mode,credits,main',[
    ('artist',(ARTIST,),True),('artist',(ARTIST,ARTIST),True),
    ('family',(OTHER,),False),('family',(OTHER,ARTIST),True)])
@pytest.mark.parametrize('replay',[False,True])
def test_fresh_and_same_key_replay_project_exact_acquired_facts(preview_case,mode,credits,main,replay):
    case=preview_case;command,scope=setup(case,credits,mode)
    first=acquire(case,command,scope)
    # Later search/provider metadata cannot replace the immutable acquired facts.
    case.facts=credit_facts(case,(OUTSIDE,))
    result=acquire(case,command,scope) if replay else first
    assert result['state']=='pending' and result['artist_scope_preview']==expected(scope,result,main)
    assert result['context_ref']==first['context_ref'] and result['destination']==command['destination']
    assert result['acquisition_ref']==first['acquisition_ref'] and result['expires_at']==first['expires_at']
    assert len(case.calls)==1 and len(case.rows())==1
    assert case.rows()[0]['credited_artist_ids']==[UUID(value) for value in credits]
    assert set(result['artist_scope_preview'])=={'artist_scope','evidence_version','main_artist_match'}
    assert not {'credited_artist_ids','mbid','identity_count'} & result['album'].keys()


@pytest.mark.parametrize('credits',[None,(OUTSIDE,)])
def test_unknown_or_outside_acquired_credits_preserve_pending_with_null_preview(preview_case,credits):
    case=preview_case;command,scope=setup(case,credits)
    result=acquire(case,command,scope)
    assert result['state']=='pending' and result['artist_scope_preview'] is None
    assert len(case.rows())==1 and len(case.calls)==1
    assert acquire(case,command,scope)==result and len(case.calls)==1


def test_family_positive_with_unknown_primary_reports_unknown_main(preview_case):
    case=preview_case;command,scope=setup(case,(OTHER,),'family')
    identity(case,0,None,'missing',None)
    result=acquire(case,command,scope)
    assert result['artist_scope_preview']==expected(scope,result,None)


def test_all_unknown_scope_is_optional_null_and_replay_can_refresh_without_dispatch(preview_case):
    case=preview_case;command,scope=setup(case)
    identity(case,0,None,'missing',None)
    first=acquire(case,command,scope)
    assert first['state']=='pending' and first['artist_scope_preview'] is None
    identity(case,0,ARTIST)
    second=acquire(case,command,scope)
    assert second['artist_scope_preview']==expected(scope,second,True)
    assert {key:value for key,value in first.items() if key!='artist_scope_preview'}=={key:value for key,value in second.items() if key!='artist_scope_preview'}
    assert len(case.calls)==1 and len(case.rows())==1


def test_saved_scope_derived_from_actual_top_and_override_rejected(preview_case):
    case=preview_case;command,scope=setup(case,(OTHER,),'family',saved=True)
    assert_error(lambda:acquire(case,command,scope),'invalid_command',422)
    assert case.calls==[] and case.rows()==[]
    result=acquire(case,command,None)
    assert result['artist_scope_preview']==expected(scope,result,False)


def test_ordinary_pending_has_no_field_or_artist_lock(preview_case):
    case=preview_case;command,_=setup(case);case.statements.clear()
    result=acquire(case,command,None)
    assert 'artist_scope_preview' not in result
    assert not any('local_artists' in sql and 'for share' in sql for sql in case.statements)


@pytest.mark.parametrize('bad',[{},False,[],{'root_artist_id':'0','mode':'artist'}, {'root_artist_id':'1','mode':'unknown'}])
def test_malformed_scope_refuses_without_provider_dispatch(preview_case,bad):
    case=preview_case;command,_=setup(case);before=case.state()
    assert_error(lambda:acquire(case,command,bad),'invalid_command',422)
    assert case.calls==[] and case.state()==before


@pytest.mark.parametrize('replay',[False,True])
@pytest.mark.parametrize('changed',['identity','family'])
def test_last_cancellation_callback_mutation_is_compared_without_callback_after_final_clock(preview_case,replay,changed):
    case=preview_case;command,scope=setup(case,(ARTIST,),'family')
    if replay:acquire(case,command,scope)
    locked=[];mutated=[];clock=[]
    def after(sql,connection):
        if 'library.local_artists' in sql and 'for share nowait' in sql:locked.append(connection)
        if mutated and sql.startswith('select clock_timestamp()'):clock.append(True)
    def cancelled():
        assert not clock,'cancellation callback after final SQL clock'
        if locked and not mutated:
            connection=locked[-1]
            if changed=='identity':
                connection.execute('update library.local_artists set mbid=%s::uuid where library_id=%s and id=%s',(OUTSIDE,case.db.library,case.db.scope_artists[0]))
            else:
                connection.execute('update library.local_artist_family_links set related_artist_id=%s where library_id=%s and artist_id=%s and related_artist_id=%s',(case.db.scope_artists[2],case.db.library,case.db.scope_artists[0],case.db.scope_artists[1]))
            mutated.append(True)
        return False
    case.after_statement=after
    try:result=acquire(case,command,scope,should_cancel=cancelled)
    finally:case.after_statement=None
    assert locked and mutated==[True] and clock
    assert result['state']=='pending' and result['artist_scope_preview'] is None
    assert len(case.calls)==1 and len(case.rows())==1
    # Optional savepoint rollback undoes even this same-transaction mutation.
    with case.db.connect() as con:
        assert str(con.execute('select mbid from library.local_artists where id=%s',(case.db.scope_artists[0],)).fetchone()['mbid'])==ARTIST
        assert con.execute('select related_artist_id from library.local_artist_family_links where library_id=%s and artist_id=%s',(case.db.library,case.db.scope_artists[0])).fetchone()['related_artist_id']==case.db.scope_artists[1]


@pytest.mark.parametrize('replay',[False,True])
@pytest.mark.parametrize('failure',['cancel','artist_denial','top_denial'])
def test_final_callbacks_are_fatal_not_optional_display_failure(preview_case,replay,failure):
    case=preview_case;command,scope=setup(case)
    if replay:acquire(case,command,scope)
    locked=[];denied=[]
    def after(sql,connection):
        if 'library.local_artists' in sql and 'for share nowait' in sql:locked.append(True)
    def cancelled():return bool(locked) and failure=='cancel'
    def constraints(context):
        reject=bool(locked) and ((failure=='top_denial' and context.action==CREATE) or
            (failure=='artist_denial' and context.action==BROWSE and context.resource is not None and context.resource.resource_kind=='artist'))
        if reject:denied.append(True)
        return PolicyEvaluationConstraints(request_origin_allowed=not reject)
    case.after_statement=after
    try:assert_error(lambda:acquire(case,command,scope,should_cancel=cancelled,constraints=constraints), 'provider_cancelled' if failure=='cancel' else 'forbidden',503 if failure=='cancel' else 403)
    finally:case.after_statement=None
    assert locked and (failure=='cancel' or denied)
    assert len(case.calls)==1 and len(case.rows())==(1 if replay else 0)
