"""Authored actual accumulator policy tests; never executed in this packet.

Rows below are the repository-reader input boundary, not proof that arbitrary
client fields establish server observation identity. Producer/SQL admission is
covered separately; these cases invoke the genuine same-state fold helper.
"""
from datetime import datetime,timezone,timedelta
from types import SimpleNamespace
import json
from music_app.services.local_album_full_state import (
    _advance_fresh,_new_pass,_projection,_fresh_compatible,MAX_FRESH_STREAMS)

V='a'*64
NOW=datetime(2026,10,23,tzinfo=timezone.utc)
H=dict(invalidation_revision=1,proof_revision=1,append_revision=1,raw_checkpoint_cut=1)

def selected(order='supported'):
    return SimpleNamespace(membership_revision='b'*64,canonical_membership=json.dumps(dict(
        order_status=order,members=[dict(track_id=1)])))

def fresh_state(order='supported'):
    return _new_pass(selected(order),{(1,2,3):V},H,{})

def run(frames=480001,**patch):
    return dict(parent_id=1,observed_ref='obs1',observed_opened_at=NOW,
        observed_file=2,observed_root=3,track_id=1,source_version=V,
        local_version=None,source_base48=0,extent_frames48=None,has_loss=False,frames=frames,**patch)

def test_fresh_track_needs_strictly_more_than_ten_actual_rendered_seconds_without_full_or_eof():
    state=fresh_state();_advance_fresh(state,[run(480000)])
    assert state['fresh_after'] is None
    _advance_fresh(state,[run(1)])
    assert datetime.fromisoformat(state['fresh_after'])==NOW
    assert state['best_full']==0 and state['geometry'] is None

def test_unordered_album_enters_fresh_only_phase_and_never_claims_full():
    state=fresh_state('unsupported');assert state['phase']=='fresh'
    _advance_fresh(state,[run()]);state['phase']='complete'
    result=_projection({'state_revision':1},state,H)
    assert result['full'] is None and result['uninterrupted_full'] is None
    assert result['fresh_play']['status']=='supported'
    assert result['status']=='not_started' and result['continuation'] is False

def test_repository_input_local_basis_can_qualify_time_without_absolute_coverage():
    state=fresh_state();row=run();row.update(observed_coordinate_basis='decoded-output-local',source_start48=0)
    _advance_fresh(state,[row])
    assert state['fresh_after'] is not None and state['best_full']==0

def test_missing_admission_loss_or_current_source_version_never_supplies_freshness():
    for change in ({'observed_ref':None},{'observed_opened_at':None},{'observed_opened_at':NOW.replace(tzinfo=None)},
                   {'source_version':None},{'source_version':'c'*64},{'has_loss':True},{'frames':True},{'frames':0}):
        state=fresh_state();row=run();row.update(change);_advance_fresh(state,[row])
        assert state['fresh_after'] is None

def test_distinct_streams_are_not_added_into_a_false_qualifying_play():
    state=fresh_state();first=run(300000);second=run(300000);second['observed_ref']='obs2'
    _advance_fresh(state,[first,second]);assert state['fresh_after'] is None

def test_server_open_lower_bound_not_late_receipt_time_is_retained():
    state=fresh_state();row=run();row['observed_opened_at']=NOW-timedelta(days=3)
    _advance_fresh(state,[row]);assert datetime.fromisoformat(state['fresh_after'])==row['observed_opened_at']

def test_pending_capacity_is_truthful_and_later_whole_qualifying_track_still_advances():
    state=fresh_state()
    for i in range(MAX_FRESH_STREAMS+20):
        row=run(1);row['observed_ref']=str(i);_advance_fresh(state,[row])
    assert len(state['fresh_streams'])==MAX_FRESH_STREAMS and state['fresh_pruned']
    _advance_fresh(state,[run()]);assert state['fresh_after'] is not None

def test_changed_source_invalidates_fresh_witness_without_relabeling_it():
    state=fresh_state();_advance_fresh(state,[run()])
    assert _fresh_compatible(state,{(1,2,3):V})
    assert not _fresh_compatible(state,{(1,2,3):'c'*64})
    assert not _fresh_compatible(state,{})


def test_default_full_read_keeps_unordered_unavailable_without_querying_storage():
    from music_app.services.local_album_full_state import read_full_state
    class NoQueries:
        def execute(self,*args,**kwargs):raise AssertionError('Default unordered read must not enter storage')
    assert read_full_state(NoQueries(),None,selected('unsupported'),{},H)=={
        'available':False,'reason':'membership_order_unavailable'}


def test_actual_run_projection_keeps_decoder_local_time_out_of_full_and_extent():
    from music_app.services.local_album_full_state import _runs
    class Result:
        def fetchall(self):return [dict(track_id=1,observed_file=2,observed_root=3,
            observed_version=V,selected_revision='b'*64,observed_coordinate_basis=basis)
            for basis in ('decoded-output-zero','decoded-output-local',None)]
    class Connection:
        def execute(self,sql,params):
            assert 'o.coordinate_basis as observed_coordinate_basis' in sql
            assert 'o.auth_session_guard=p.auth_session_guard' in sql
            return Result()
    state=fresh_state();state.update(owner=1,extents=[[2,V,480000]])
    live=SimpleNamespace(actor=SimpleNamespace(account_id=7),library_id=3)
    scope=selected();scope.album_id=9
    rows=_runs(Connection(),live,scope,state)
    assert rows[0]['local_version']==V and rows[0]['extent_frames48']==480000
    for row in rows[1:]:
        assert row['source_version']==V
        assert row['local_version'] is None and row['extent_frames48'] is None


def test_fresh_only_page_uses_no_full_geometry_or_allocation(monkeypatch):
    from music_app.services import local_album_full_state as module
    state=fresh_state('unsupported');state['owner']=1
    row=run();row.update(id=1,ordinal_start=0)
    monkeypatch.setattr(module,'_runs',lambda *args:[row])
    monkeypatch.setattr(module,'_next_owner',lambda *args:None)
    def forbidden(*args,**kwargs):raise AssertionError('Fresh-only scope cannot allocate Full')
    monkeypatch.setattr(module,'advance_geometry',forbidden)
    monkeypatch.setattr(module,'geometry_lower_bound',forbidden)
    result=module._advance(None,None,selected('unsupported'),state)
    assert result['phase']=='complete' and result['fresh_after'] is not None
    assert result['geometry'] is None and result['best_full']==0
