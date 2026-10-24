"""Authored additive tests. Not executed/collected in source-only preparation."""
from copy import deepcopy
import hashlib
from datetime import datetime, timezone

import pytest

from music_app.services.lastfm_history_model import accepted_tuple, multiset, reconcile_observed, tuple_digest
from music_app.services.lastfm_history_postgres import public_combined_view

TIME = 1700000000
LINEAGE = '2023-01-01T00:00:00+00:00'
KEY = (TIME,'Artist','Track','Album')
SCOPE = dict(account_id=1,library_id=2,provider_username='Owner',connection_started_at=LINEAGE)


def native(number=1):
    request = dict(timestamp=TIME,artist='Artist',track='Track',album='Album',album_artist='',track_number='')
    reply = {key:value for key,value in request.items() if key!='track_number'}
    reply['corrected'] = {key:False for key in ('artist','track','album','album_artist')}
    device='11111111-1111-4111-8111-111111111111'
    session=f'22222222-2222-4222-8222-{number:012d}'
    physical=f'1:2:{device}:{session}'
    identity = dict(version=1,provider='lastfm',account_id=1,library_id=2,
        occurrence_id=hashlib.sha256(physical.encode()).hexdigest(),attempt=1,provider_username='Owner',connection_started_at=LINEAGE,
        request=request,reply=reply)
    return dict(id=number,account_id=1,library_id=2,device_id=device,session_id=session,
        source_entry_id=physical,source_family='rendered_local_listen_session',
        measurement_version='rendered-pcm-v1',played_at=datetime.fromtimestamp(TIME,timezone.utc),
        display=dict(id=f'opaque{number}',source_label='Album Haven',last_listened_at='2023-11-14T22:13:20+00:00',
            artist='Safe Artist',title='Safe Track',album_title='Safe Album'),
        payload=dict(id=identity['occurrence_id'],scrobble_retry_count=1,scrobbled=True,
            source_provenance={'kind':'local_playback','provider':'album_haven'},
            scrobble_submission_state='accepted',scrobble_submission_identity=identity,
            title='Track',artist='Artist',album='Album',path='/private/not-exposed'))


def remote(ordinal=1):
    return dict(account_id=1,provider_username='Owner',connection_started_at=LINEAGE,
        played_at=TIME,artist='Artist',track='Track',album='Album',tuple_digest=tuple_digest(KEY),ordinal=ordinal)


def combine(own, imported, uncertain=()):
    return reconcile_observed(own,imported,**SCOPE,uncertain_timestamps=set(uncertain))


def test_exact_accepted_echo_reconciles_without_mutating_or_deleting_sources():
    own, imported = [native()],[remote()]
    original = deepcopy((own,imported))
    result = combine(own,imported)
    assert result['combined_count']==1
    assert result['links'][0]['kind']=='exact_observed_tuple'
    assert result['native']==own and result['imported']==imported
    assert (own,imported)==original


@pytest.mark.parametrize('own_count,remote_count,expected',[(1,2,2),(2,1,2),(2,2,2),(3,2,3)])
def test_same_second_repeated_plays_are_multisets(own_count,remote_count,expected):
    result=combine([native(i+1) for i in range(own_count)],[remote(i+1) for i in range(remote_count)])
    assert len(result['links'])==min(own_count,remote_count)
    assert result['combined_count']==expected


@pytest.mark.parametrize('field,value',[
    ('account_id',3),('library_id',3),('version',True),('account_id',True),
    ('provider_username','owner'),('connection_started_at','2024-01-01T00:00:00+00:00'),
    ('attempt',2),('reply',None),('occurrence_id','a'*64)])
def test_unbound_foreign_reconnected_or_malformed_evidence_stays_separate(field,value):
    row=native();row['payload']['scrobble_submission_identity'][field]=value
    assert combine([row],[remote()])['combined_count']==2


@pytest.mark.parametrize('state',['attempting','uncertain','sent','not_sent'])
def test_unknown_and_known_not_sent_never_turn_into_acceptance_or_send(state):
    row=native();row['payload']['scrobble_submission_state']=state;row['payload']['scrobbled']=False
    result=combine([row],[remote()])
    assert result['links']==[] and result['combined_count']==2
    assert public_combined_view(result)['send_actions']==[]
    assert row['payload']['scrobble_submission_state']==state


def test_foobar_and_bad_measurement_version_cannot_supply_native_evidence():
    row=native();row['source_family']='foobar_import';assert accepted_tuple(row,**SCOPE) is None
    row=native();row['measurement_version']='legacy';assert accepted_tuple(row,**SCOPE) is None


def test_column_acceptance_without_bound_reply_is_not_enough_to_merge():
    row=native();row['scrobble_status']='scrobbled';row['payload'].pop('scrobble_submission_identity')
    assert combine([row],[remote()])['links']==[]


def test_changed_or_partial_bucket_invalidates_only_derived_links():
    result=combine([native()],[remote()],uncertain=[TIME])
    assert result['links']==[] and result['combined_count']==2
    assert len(result['native'])==len(result['imported'])==1
    assert public_combined_view(result)['imported'][0]['uncertain'] is True


def test_duplicate_native_identity_and_duplicate_remote_ordinal_are_not_consumed_twice():
    row=native(2);row['payload']['id']=native()['payload']['id']
    row['payload']['scrobble_submission_identity']['occurrence_id']=row['payload']['id']
    for field in ('device_id','session_id','source_entry_id'):row[field]=native()[field]
    assert combine([native(),row],[remote(),remote(2)])['links']==[]
    assert combine([native(),native(2)],[remote(),remote()])['links']==[]


def test_corrected_reply_matches_returned_names_not_original_title():
    row=native();reply=row['payload']['scrobble_submission_identity']['reply']
    reply['track']='Corrected';reply['corrected']['track']=True
    observed=remote();observed['track']='Corrected'
    observed['tuple_digest']=tuple_digest((TIME,'Artist','Corrected','Album'))
    assert len(combine([row],[observed])['links'])==1
    reply['corrected']['track']=False
    assert combine([row],[observed])['links']==[]


def test_provider_seconds_must_equal_original_occurrence_seconds():
    row=native();row['played_at']=datetime.fromtimestamp(TIME+1,timezone.utc)
    assert combine([row],[remote()])['links']==[]


def test_public_dto_does_not_expose_raw_source_or_receipt_identity():
    dto=public_combined_view(combine([native()],[remote()]))
    assert 'private' not in repr(dto)
    assert 'scrobble_submission_identity' not in repr(dto)
    assert 'connection_started_at' not in repr(dto)
    assert 'provider_username' not in repr(dto)


def test_page_boundary_ties_preserve_both_observations():
    track=dict(timestamp=TIME,artist='Artist',track='Track',album='Album')
    counts=multiset([{'tracks':[track]},{'tracks':[dict(track)]}])
    assert counts[KEY]==2


def test_public_native_display_uses_authorized_home_projection_not_raw_payload():
    row=native();row['payload']['title']='/private/file.flac';row['payload']['artist']={'path':'secret'}
    dto=public_combined_view(combine([row],[remote()]))
    assert dto['native'][0]['track']=='Safe Track'
    assert dto['native'][0]['artist']=='Safe Artist'
    assert '/private/' not in repr(dto)
    assert dto['links'][0]['native_id']=='opaque1'


@pytest.mark.parametrize('metadata',[None,[],False,'broken',{'source_payload':None},{'source_payload':[]}])
def test_qualified_native_rows_retain_malformed_payload_as_unmatched(metadata):
    from types import SimpleNamespace
    from music_app.services.lastfm_history_postgres import qualified_native_rows
    row=native();row.pop('payload');row['metadata']=metadata
    projection=SimpleNamespace(events=[{'event_id':1}],groups={'listen:event:1':{'row':row['display']}})
    rows=qualified_native_rows([row],projection)
    assert len(rows)==1 and rows[0]['payload']=={}
    assert combine(rows,[remote()])['links']==[]


@pytest.mark.parametrize('provenance',[None,{},'local_playback',
    {'kind':'lastfm_import','provider':'lastfm'}, {'kind':'foobar_import','provider':'foobar'},
    {'kind':'local_playback','provider':'foobar'},
    {'kind':'local_playback','provider':'album_haven','untrusted':True}])
def test_only_exact_genuine_measured_payload_provenance_can_correlate(provenance):
    row=native();row['payload']['source_provenance']=provenance
    assert combine([row],[remote()])['links']==[]


def test_missing_payload_provenance_is_unbound_not_repaired_by_row_family():
    row=native();row['payload'].pop('source_provenance')
    assert combine([row],[remote()])['links']==[]


def test_copied_json_receipt_cannot_rebind_a_different_physical_occurrence():
    row=native(2);row['payload']=deepcopy(native(1)['payload'])
    assert combine([row],[remote()])['links']==[]


@pytest.mark.parametrize('field,value',[('device_id',None),('session_id','invalid'),
    ('source_entry_id','wrong'),('device_id','11111111-1111-4111-8111-111111111112')])
def test_physical_ledger_identity_is_required_and_rederived(field,value):
    row=native();row[field]=value
    assert combine([row],[remote()])['links']==[]
