"""Additive source-authored regressions, UNRUN. No real network/database calls."""
import json
import pytest
from music_app.services.lastfm import LastfmError
from music_app.services.lastfm_history_reader import parse_history_page, HistoryRangeTooLarge
from test_lastfm_history_route import rig  # unchanged accepted S2 route/perimeter fixture


def oversized_xml(*,total=20001,pages=101,track='Track'):
    row=f'<track><artist>Artist</artist><name>{track}</name><album>Album</album><date uts="10">date</date></track>'
    return (f'<lfm status="ok"><recenttracks user="Owner" page="1" perPage="200" totalPages="{pages}" total="{total}">'+row*200+'</recenttracks></lfm>').encode()


def test_over_budget_envelope_retains_validated_raw_page_for_adaptive_split():
    body=oversized_xml()
    with pytest.raises(HistoryRangeTooLarge) as caught:
        parse_history_page(body,username='Owner',range_start=0,range_end=20,page=1)
    evidence=caught.value.evidence
    assert evidence.raw_xml.encode()==body and len(evidence.tracks)==200
    assert evidence.total_pages==101 and evidence.total==20001


@pytest.mark.parametrize('body',[oversized_xml(pages=100),oversized_xml(track='Track<child/>')])
def test_malformed_page_is_not_evidence_for_adaptive_splitting(body):
    with pytest.raises(LastfmError) as caught:
        parse_history_page(body,username='Owner',range_start=0,range_end=20,page=1)
    assert not isinstance(caught.value,HistoryRangeTooLarge)


@pytest.mark.parametrize('command,extra',[
    ('backfill_begin',{}),('backfill_pending',{}),
    ('backfill_advance',{'plan':'11111111-1111-4111-8111-111111111111','revision':1}),
    ('backfill_pause',{'plan':'11111111-1111-4111-8111-111111111111','revision':1}),
    ('backfill_resume',{'plan':'11111111-1111-4111-8111-111111111111','revision':1})])
def test_actual_registered_backfill_commands_keep_context_csrf_and_fixed_action(rig,monkeypatch,command,extra):
    from music_app.services import lastfm_history_backfill
    calls=[]
    class Plan:
        def __init__(self,config):pass
        def invoke(self,context,**kwargs):calls.append(kwargs);return {'state':'active'}
        begin=pending=advance=pause=resume=invoke
    monkeypatch.setattr(lastfm_history_backfill,'LastfmHistoryBackfill',Plan)
    response=rig.request(body=json.dumps({'command':command,**extra}))
    assert response.status_code==200 and len(calls)==1
    assert calls[0]=={**extra,'constraints':'synthetic-constraints'}
    assert rig.actions==['account.self.lastfm.history.write'] and rig.csrf_checks


def test_backfill_route_rejects_extra_identity_or_provider_fields(rig,monkeypatch):
    response=rig.request(body=json.dumps({'command':'backfill_begin','username':'foreign'}))
    assert response.status_code==422 and not rig.calls


def test_existing_manual_range_owner_accepts_zero_but_not_negative_bound(monkeypatch):
    from music_app.services.lastfm_history_postgres import LastfmHistoryRepository
    from music_app.services.lastfm_history_model import HistoryStale
    repository=LastfmHistoryRepository({'ALBUM_HAVEN_APP_DATABASE_URL':'unused'})
    class TransactionReached(Exception):pass
    def stopped(*args,**kwargs):raise TransactionReached()
    monkeypatch.setattr(repository,'transaction',stopped)
    with pytest.raises(TransactionReached):repository.begin(None,range_start=0,range_end=100)
    with pytest.raises(HistoryStale):repository.begin(None,range_start=-1,range_end=100)


def test_dense_single_second_page_101_preserves_repeated_occurrence():
    body=oversized_xml().replace(b'page="1"',b'page="101"')
    start=body.index(b'<track>');end=body.index(b'</recenttracks>')
    row=body[start:body.index(b'</track>',start)+8]
    body=body[:start]+row+body[end:]
    result=parse_history_page(body,username='Owner',range_start=10,range_end=10,page=101,allow_dense=True)
    assert result.page==101 and result.total==20001 and len(result.tracks)==1
    assert result.tracks[0].timestamp==10
    with pytest.raises(LastfmError):
        parse_history_page(body,username='Owner',range_start=10,range_end=10,page=101)


def test_dense_permission_cannot_expand_to_multi_second_range():
    with pytest.raises(LastfmError):
        parse_history_page(oversized_xml(),username='Owner',range_start=9,range_end=10,page=1,allow_dense=True)
