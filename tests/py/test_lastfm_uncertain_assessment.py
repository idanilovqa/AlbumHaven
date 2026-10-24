"""New authored, UNRUN tests. Real model/assessment/Home chain; declared SQL double."""
from copy import deepcopy
import json
import pytest
from test_lastfm_home_snapshot import native,remote,run,SCOPE,KEY
from music_app.services.lastfm_history_model import uncertain_request_tuple,accepted_tuple


def uncertain(number=1):
    row=native(number);row['payload'].update(scrobbled=False,scrobble_submission_state='uncertain')
    row['payload']['scrobble_submission_identity']['reply']=None
    return row


def states(db):
    return [json.loads(args[0]) for sql,args in db.writes if "'{lastfm_assessment}'" in sql]


def test_bound_uncertain_request_never_becomes_accepted_echo():
    row=uncertain()
    assert uncertain_request_tuple(row,**SCOPE)==KEY
    assert accepted_tuple(row,**SCOPE) is None
    row=native()
    assert accepted_tuple(row,**SCOPE)==KEY
    assert uncertain_request_tuple(row,**SCOPE) is None


@pytest.mark.parametrize('change',[
    lambda r:r.update(account_id=99),lambda r:r.update(library_id=99),
    lambda r:r.update(source_entry_id='foreign'),lambda r:r.update(source_family='foobar_import'),
    lambda r:r['payload'].update(source_provenance={'kind':'lastfm_import','provider':'lastfm'}),
    lambda r:r['payload'].update(scrobble_retry_count=2),
    lambda r:r['payload']['scrobble_submission_identity'].update(provider_username='Other'),
    lambda r:r['payload']['scrobble_submission_identity'].update(connection_started_at='other'),
    lambda r:r['payload']['scrobble_submission_identity']['request'].update(timestamp=1.0),
    lambda r:r['payload']['scrobble_submission_identity'].update(reply={}),
])
def test_contradictory_or_foreign_attempt_never_uses_observed_title_time(change):
    row=uncertain();change(row)
    assert uncertain_request_tuple(row,**SCOPE) is None


@pytest.mark.parametrize('n,r,expected',[(1,1,'possible_observation'),(1,2,'ambiguous_observation'),
    (2,1,'ambiguous_observation'),(2,2,'ambiguous_observation'),(1,0,'not_observed')])
def test_actual_home_assessment_preserves_native_and_every_remote_occurrence(n,r,expected):
    own=[uncertain(i+1) for i in range(n)];before=deepcopy(own)
    result,db=run(own,[remote(i+1) for i in range(r)])
    reports=states(db)
    assert len(reports)==n and {x['state'] for x in reports}=={expected}
    assert all(x['accepted'] is False and x['proves_not_sent'] is False and x['can_resend'] is False for x in reports)
    assert result[0]==r and result[1]['matched_rows']==0
    assert own==before
    assert not any('delete' in sql.lower() or 'integration.listen_history set' in sql.lower() for sql,_ in db.writes)


@pytest.mark.parametrize('state',['reading','uncertain','connection_changed'])
def test_absent_or_present_remote_in_incomplete_bucket_is_never_negative_proof(state):
    for imported in ([],[remote()]):
        _,db=run([uncertain()],imported,state=state)
        assert states(db)[0]['state']=='incomplete_observation'


def test_missing_binding_and_duplicate_physical_attempt_stay_unbound():
    row=uncertain();row['payload'].pop('scrobble_submission_identity')
    _,db=run([row],[remote()]);assert states(db)[0]['state']=='unbound_attempt'
    first=uncertain();second=deepcopy(first);second['id']=2
    _,db=run([first,second],[remote()])
    assert {x['state'] for x in states(db)}=={'unbound_attempt'}


def test_already_accepted_competitor_makes_uncertain_tuple_ambiguous_without_hiding_it():
    result,db=run([uncertain(),native(2)],[remote()])
    assert states(db)[0]['state']=='ambiguous_observation'
    assert result[1]['matched_rows']==1  # only genuine accepted echo consumes one view link


def test_mutated_provider_bucket_invalidates_possible_assessment():
    _,db=run([uncertain()],[remote()],previous=[])
    assert states(db)[0]['state']=='incomplete_observation'


def test_never_imported_empty_bucket_is_not_a_negative_result():
    _,db=run([uncertain()],[],completed=0)
    assert states(db)[0]['state']=='incomplete_observation'


def test_dense_uncertain_group_uses_one_multiplicity_lookup_and_one_competitor_stream():
    result,db=run([uncertain(i+1) for i in range(300)],[remote(i+1) for i in range(513)])
    assert len(states(db))==300 and {r['state'] for r in states(db)}=={'ambiguous_observation'}
    assert db.assessment_counts==1
    assert len(db.cursor_queries)==4 and len(db.closed)==4
    assert result[0]==513 and result[1]['matched_rows']==0


def test_trusted_positive_column_never_becomes_uncertain_request_evidence():
    from music_app.services.lastfm_listen_sync import build_recent_scrobble_delivery
    row=uncertain();row['scrobble_status']='scrobbled'
    facts={**row['payload'],'scrobbled':True}
    dto=build_recent_scrobble_delivery(facts,source_family=row['source_family'],
        measurement_version=row['measurement_version'],connection_state='connected')
    assert dto['state']=='accepted' and dto['next_step']=='none'
    assert uncertain_request_tuple(row,**SCOPE) is None
