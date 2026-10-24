"""Authored only: actual read/route/worker owners over controlled DB boundaries."""
from dataclasses import replace
import json
from hashlib import sha256
import pytest
from music_app.services import foobar_account_track_evidence as reader
from tests.py.foobar_account_history_native_testing import *
from tests.py.test_foobar_enhanced_native_consumers import enhanced_row


def evidence_driver(monkeypatch, db, rows):
    execute=db.execute
    state={'index':True,'key':'synthetic-stable-track-key','rows':rows}
    def call(sql,params=None,**kwargs):
        if sql==reader._INDEX:
            selected=[{'ready':state['index']}]
        elif sql==reader._TRACK:
            assert params==(7,21)
            selected=[{'id':21,'track_key':state['key']}]
        elif sql in reader._QUERIES.values():
            frame=json.loads(params[0]);assert frame[:3]==[1,7,21]
            selected=state['rows']
            if frame[3] is not None:
                selected=[r for r in selected if (r['source_ref'],r['observation_ref'])>(frame[3],frame[4])]
            selected=selected[:21]
        else:return execute(sql,params,**kwargs)
        db.calls.append(sql);cursor=Cursor(db,sql,selected);db.cursors.append(cursor);return cursor
    monkeypatch.setattr(db,'execute',call)
    monkeypatch.setattr(reader,'datetime',native.datetime)
    return state


def row(db,projection=None,ordinal=1):
    return dict(projection or enhanced_row(),**db.binding,source_ref=SOURCE,
        source_created_at=NOW,observation_ref='00000000-0000-4000-8000-%012x'%ordinal)


def read(db,*,family='standard',cursor=None,constraints=read_constraints):
    return reader.read_track_evidence(URL,context(),reader.TrackEvidenceRequest(21,family,cursor),constraints=constraints)


def test_exact_source_count_kinds_are_not_added_or_lifetime_claims(monkeypatch):
    db=install(monkeypatch)
    evidence_driver(monkeypatch,db,[row(db,bound_row(projection(play_count=4,play_count_enhanced=8)),1),row(db,enhanced_row(),2)])
    page=read(db)
    assert [(x.evidence_kind,x.count) for x in page.items]==[('tsv_snapshot',4),('enhanced_store',1)]
    assert page.next_cursor is None and not db.physical
    assert page.consistency=='current_page_refresh_to_restart'
    assert read(db,family='enhanced').items[0].count==8


def test_more_than_thirty_two_source_observations_are_reachable(monkeypatch):
    db=install(monkeypatch)
    evidence_driver(monkeypatch,db,[row(db,ordinal=i) for i in range(1,56)])
    one=read(db);two=read(db,cursor=one.next_cursor);three=read(db,cursor=two.next_cursor)
    assert [len(p.items) for p in (one,two,three)]==[20,20,15]
    assert three.next_cursor is None
    identities=[x.observation_ref for p in (one,two,three) for x in p.items]
    assert len(set(identities))==55 and identities==sorted(identities)


@pytest.mark.parametrize('fault',['index','target','header','head','source_date'])
def test_missing_index_and_stale_proofs_fail_closed(monkeypatch,fault):
    db=install(monkeypatch);rows=[row(db)]
    state=evidence_driver(monkeypatch,db,rows)
    if fault=='index':state['index']=False
    elif fault=='target':state['key']=None
    elif fault=='header':rows[0]['current_effective_sha256']='0'*64
    elif fault=='head':rows[0]['head_track_id']=22
    else:rows[0]['source_created_at']=None
    with pytest.raises((reader.SourceUnavailable,reader.FoobarHistoryStale)):read(db)
    assert not db.physical


def test_cursor_cannot_cross_account_library_target_or_family(monkeypatch):
    db=install(monkeypatch)
    state=evidence_driver(monkeypatch,db,[row(db,ordinal=i) for i in range(1,22)])
    cursor=read(db).next_cursor
    for changed in (replace(cursor,account_id=2),replace(cursor,library_id=8),replace(cursor,track_sha256='0'*64)):
        with pytest.raises(reader.FoobarHistoryStale):read(db,cursor=changed)
    with pytest.raises(reader.FoobarHistoryInvalid):read(db,cursor=replace(cursor,family='enhanced'))
    state['key']='changed-current-track-key'
    with pytest.raises(reader.FoobarHistoryStale):read(db,cursor=cursor)


def test_per_track_browse_not_media_required_and_no_write(monkeypatch):
    db=install(monkeypatch);evidence_driver(monkeypatch,db,[row(db)])
    def no_media(target):
        return PolicyEvaluationConstraints(client_surface_allowed=target.action!=MEDIA,
            request_origin_allowed=target.action!='account.self.foobar.write')
    assert read(db,constraints=no_media).items[0].count==1
    def no_browse(target):
        return PolicyEvaluationConstraints(client_surface_allowed=not(target.action==BROWSE and target.resource is not None))
    with pytest.raises(authority.PrivateLibraryAuthorityError):read(db,constraints=no_browse)
    assert not db.physical and not any('insert into' in sql.lower() for sql in db.calls)


def test_unavailable_vector_is_not_zero(monkeypatch):
    db=install(monkeypatch);evidence_driver(monkeypatch,db,[row(db,enhanced_row(unavailable=True))])
    item=read(db).items[0]
    assert item.count is None and item.count_state=='unavailable' and item.status=='unavailable'


def test_reader_queries_limit_before_payload_join_and_never_fetch_vectors():
    for query in reader._QUERIES.values():
        assert query.index('limit 21')<query.index('projection_bytes')
        assert 'octet_length(p.projection_bytes) between 1 and 8192' in query
        assert 'entry_bytes' not in query and 'raw_bytes' not in query
    assert 21*3*(8192+2048)+262144+65536==972800<reader.TRACK_EVIDENCE_PHASE_BYTES


def test_later_count_correction_is_read_current_without_accumulating_old_total(monkeypatch):
    db=install(monkeypatch)
    state=evidence_driver(monkeypatch,db,[row(db,bound_row(projection(play_count=9)))])
    old=read(db)
    state['rows']=[row(db,bound_row(projection(play_count=2)))]
    current=read(db)
    assert old.items[0].count==9 and current.items[0].count==2
    assert not hasattr(current,'total') and current.consistency=='current_page_refresh_to_restart'
    state['rows']=[]
    assert read(db).items==()  # Current detached/deleted association is not cached evidence.


def test_previous_page_cursor_does_not_claim_new_earlier_records_absent(monkeypatch):
    db=install(monkeypatch)
    state=evidence_driver(monkeypatch,db,[row(db,ordinal=i) for i in range(2,24)])
    first=read(db)
    state['rows'].insert(0,row(db,ordinal=1))
    remaining=read(db,cursor=first.next_cursor)
    assert len(remaining.items)==2 and remaining.next_cursor is None
    restarted=read(db)
    assert restarted.items[0].observation_ref.endswith('000000000001')
    assert restarted.consistency=='current_page_refresh_to_restart'
