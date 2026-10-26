"""Authored only. Actual fold module; no backend/runtime execution claimed."""
from music_app.services.local_album_track_metrics import (
    new_details, anchor_details, advance_details, project_details, compatible,
    MAX_TRACK_POINTS, MAX_ALBUM_POINTS, MAX_VALUE)


def run(track=1, *, frames=48000, start=0, extent=48000, version='a', file=10, basis='decoded-output-zero', id=1):
    return dict(id=id,track_id=track,frames=frames,source_start48=start,source_version=version,
        observed_file=file,observed_root=1,source_extent_frames48=extent,
        observed_coordinate_basis=basis,has_loss=False)


def fold(ids, rows, prior=None):
    state=new_details(ids,prior)
    anchor_details(state,rows);advance_details(state,rows)
    state['cutoff']='9'
    return state


def test_repeated_first_track_adds_time_without_covering_the_missing_long_last_track():
    rows=[run(frames=48000) for _ in range(14)]
    state=fold([1,2],rows)
    result=project_details(state,5)
    assert result['recorded_frames']==14*48000
    assert result['tracks'][0]['minimum_position_depth']==14
    assert result['tracks'][1]['position_coverage'] is None
    assert result['target_coverage'] is None
    assert result['uneven_track_coverage'] is None


def test_duration_weighted_target_sweep_never_fills_unheard_tail_from_replay():
    rows=[run(frames=24000,extent=48000) for _ in range(10)]
    state=fold([1],rows)
    result=project_details(state,5)
    assert result['target_coverage']=={'numerator':1,'denominator':2}
    assert result['tracks_at_target']==0
    assert result['tracks'][0]['minimum_position_depth']==0
    assert result['recorded_frames']==240000


def test_uneven_tracks_keep_the_rare_long_final_track_as_a_caveat():
    rows=[]
    for track,count in enumerate([12,20,14,15,2],1):
        extent=20*60*48000 if track==5 else 60*48000
        rows.extend(run(track,frames=extent,extent=extent,file=track+10) for _ in range(count))
    result=project_details(fold(list(range(1,6)),rows),5)
    assert result['tracks_at_target']==4
    assert result['uneven_track_coverage'] is True
    assert result['tracks'][-1]['minimum_position_depth']==2
    assert result['target_coverage']['numerator']<result['target_coverage']['denominator']


def test_decoder_local_time_and_alternate_source_time_cannot_borrow_position_depth():
    state=fold([1],[run(),run(basis='decoded-output-local'),run(version='b',file=11)])
    result=project_details(state,3)
    assert result['recorded_frames']==144000
    assert result['tracks'][0]['minimum_position_depth']==1
    assert result['target_coverage']=={'numerator':1,'denominator':3}


def test_loss_or_unverified_source_never_contributes_rendered_time_or_depth():
    rows=[run(),dict(run(),has_loss=True),dict(run(),source_version=None)]
    result=project_details(fold([1],rows),1)
    assert result['recorded_frames']==48000
    assert result['unsupported_runs']==2
    assert result['tracks'][0]['minimum_position_depth']==1


def test_rebuild_reserves_prior_coordinates_but_recomputes_counts_without_snapshot_sum():
    prior=fold([1],[run() for _ in range(5)])
    state=new_details([1],prior)
    assert all(value==0 for value in state['tracks']['1']['points'].values())
    anchor_details(state,[run()]);advance_details(state,[run() for _ in range(6)])
    result=project_details(state,5)
    assert result['recorded_frames']==6*48000
    assert result['tracks'][0]['minimum_position_depth']==6
    assert result['tracks_at_target']==1


def test_distinct_endpoint_capacity_prunes_derived_geometry_but_continues_time_and_known_points():
    rows=[run(start=i*2,frames=1,extent=100000) for i in range(200)]
    state=fold([1],rows)
    assert len(state['tracks']['1']['points'])<=MAX_TRACK_POINTS
    assert sum(len(row['points']) for row in state['tracks'].values())<=MAX_ALBUM_POINTS
    before=state['tracks']['1']['points']['0']
    advance_details(state,[run(frames=1,extent=100000)])
    assert state['tracks']['1']['points']['0']==before+1
    assert state['tracks']['1']['frames']==201
    assert state['tracks']['1']['coverage_pruned'] is True
    assert project_details(state,5)['uneven_track_coverage'] is None


def test_completed_snapshot_is_invalidated_by_source_or_extent_change():
    state=fold([1],[run()])
    assert compatible(state,{(1,10,1):'a'},{(10,'a'):48000})
    assert not compatible(state,{(1,10,1):'b'},{(10,'b'):48000})
    assert not compatible(state,{(1,10,1):'a'},{(10,'a'):96000})


def test_current_target_reprojects_depth_without_replaying_or_rewriting_raw_evidence():
    state=fold([1],[run() for _ in range(5)])
    assert project_details(state,5)['tracks_at_target']==1
    assert project_details(state,6)['tracks_at_target']==0
    assert project_details(state,6)['target_coverage']=={'numerator':5,'denominator':6}
    assert state['tracks']['1']['frames']==5*48000


def test_actual_resumable_state_counts_time_once_not_in_both_passes_and_keeps_snapshot_during_rebuild(monkeypatch):
    # The repository page/source facts are a declared reader seam; the genuine
    # state transition, geometry allocator and detail fold all execute together.
    from types import SimpleNamespace
    import json
    from music_app.services import local_album_full_state as state
    selected=SimpleNamespace(membership_revision='m'*64,canonical_membership=json.dumps(
        dict(order_status='supported',members=[dict(track_id='1')])))
    versions={(1,10,1):'a'};extents={(10,'a'):48000}
    history=dict(invalidation_revision=0,proof_revision=1,append_revision=1,raw_checkpoint_cut=9)
    rows=[dict(run(id=i+1),owner_id=1,parent_id=i+1,binding_serial=i+1,generation=1,
        stream_id=i+1,epoch=1,continuity_serial=i+1,ordinal_start=i*48000,
        output_start=i*48000,source_base48=0,local_version='a',extent_frames48=48000)
        for i in range(5)]
    monkeypatch.setattr(state,'_runs',lambda *args:rows)
    monkeypatch.setattr(state,'_next_owner',lambda c,l,s,work:1 if work['owner']==0 else None)
    work=state._new_pass(selected,versions,history,extents)
    for _ in range(3):work=state._advance(None,None,selected,work)
    assert work['phase']=='complete'
    value=state._projection({'state_revision':3},work,history,target=5)
    assert value['full']==5 and value['recorded_details']['recorded_frames']==5*48000
    assert value['recorded_details']['tracks_at_target']==1
    assert value['recorded_details']['partial_stretches']==0
    later=dict(history,append_revision=2,raw_checkpoint_cut=10)
    restarted=state._new_pass(selected,versions,later,extents,prior=work)
    pending=state._projection({'state_revision':4},restarted,later,target=5)
    assert pending['continuation'] is True
    assert pending['recorded_details']['recorded_frames']==5*48000
    assert pending['recorded_details']['cutoff_checkpoint_id']=='9'


def test_joint_optional_detail_capacity_never_blocks_full_or_spins_same_cut(monkeypatch):
    from types import SimpleNamespace
    from copy import deepcopy
    import json
    from music_app.services import local_album_full_state as state
    ids=list(range(1,513))
    selected=SimpleNamespace(membership_revision='m'*64,canonical_membership=json.dumps(
        dict(order_status='supported',members=[dict(track_id=str(i)) for i in ids])))
    versions={(i,i+1000,1):str(i).zfill(64) for i in ids}
    extents={(i+1000,str(i).zfill(64)):MAX_VALUE for i in ids}
    history=dict(invalidation_revision=0,proof_revision=1,append_revision=1,raw_checkpoint_cut=9)
    work=state._new_pass(selected,versions,history,extents)
    for track in ids:
        row=work['details']['tracks'][str(track)]
        row['cohort']=dict(version=str(track).zfill(64),file_id=track+1000,root_id=1,run_id=track,extent=MAX_VALUE)
        row['points']={str(MAX_VALUE-i):MAX_VALUE if i%2 else -MAX_VALUE for i in range(16)}
    work['details']['versions']=[[*key,value] for key,value in versions.items()]
    work['details']['extents']=[[*key,value] for key,value in extents.items()]
    work['completed_details']=deepcopy(work['details'])
    work.update(phase='complete',best_full=5,best_uninterrupted=3)
    state._bound_optional_details(work)
    assert len(json.dumps({key:work[key] for key in ('details','completed_details')}).encode())<=512*1024
    assert len(json.dumps(work).encode())<=state.MAX_STATE_BYTES
    assert work['details_pruned'] is True
    assert work['best_full']==5 and work['best_uninterrupted']==3
    monkeypatch.setattr(state,'_runs',lambda *a:(_ for _ in ()).throw(AssertionError('same-cut restart')))
    unchanged=state._advance(None,None,selected,work)
    projection=state._projection({'state_revision':5},unchanged,history,target=5)
    assert projection['continuation'] is False
    assert projection['recorded_details_reason']=='derived_detail_capacity'


def test_track_presentation_keeps_complete_edition_order_after_json_object_reordering():
    state=fold([12,3],[run(12,file=12),run(3,file=3)])
    state['tracks']=dict(reversed(list(state['tracks'].items())))
    assert list(state['tracks'])==['3','12']
    assert [row['track_id'] for row in project_details(state,5)['tracks']]==['12','3']
