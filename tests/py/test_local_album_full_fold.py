"""Authored canonical product arithmetic tests. No runtime execution claimed."""
from copy import deepcopy
from music_app.services.local_album_full_fold import new_geometry,advance_geometry,geometry_lower_bound,MAX_GROUPS

V='a'*64
W='b'*64
EXTENT=480000


def run(identity,track,*,owner=1,ordinal=0,start=0,frames=EXTENT,version=V,extent=EXTENT):
    return dict(id=identity,owner_id=owner,parent_id=track+owner*100,binding_serial=track,
        generation=1,stream_id=track,epoch=1,continuity_serial=1,frames=frames,
        track_id=track,ordinal_start=ordinal,output_start=ordinal,source_base48=0,
        source_start48=start,local_version=version,extent_frames48=extent,has_loss=False)


def state(n):
    return new_geometry(list(range(1,n+1)),{str(i):dict(version=V,extent_frames48=EXTENT) for i in range(1,n+1)})


def session(current,tracks,owner,*,version=V):
    rows=[run(owner*100+i,track,owner=owner,ordinal=i*EXTENT,version=version) for i,track in enumerate(tracks)]
    return advance_geometry(current,rows,owner_finished=True)


def test_user_overlapping_one_to_five_four_to_nine_eight_to_twelve():
    value=state(12)
    for repeat in range(5):
        for offset,tracks in enumerate((range(1,6),range(4,10),range(8,13))):
            value=session(value,tracks,repeat*3+offset+1)
    assert geometry_lower_bound(value)['full']==5
    assert geometry_lower_bound(value)['uninterrupted_full']==0


def test_first_track_repetition_does_not_hide_missing_last_track():
    value=state(5)
    for owner in range(1,21):value=session(value,[1],owner)
    assert geometry_lower_bound(value)['full']==0


def test_rare_long_final_track_limits_full_but_not_recorded_time():
    value=state(5)
    value['anchors']['5']['extent_frames48']=20*EXTENT
    for owner in range(1,15):value=session(value,range(1,5),owner)
    # First four tracks are less than20% of this long edition, and isolated last
    # track never overlaps them. Aggregate counts cannot invent a full session.
    for owner in (20,21):
        value=advance_geometry(value,[run(owner,5,owner=owner,frames=20*EXTENT,extent=20*EXTENT)],owner_finished=True)
    assert geometry_lower_bound(value)['full']==0


def test_no_overlap_at_shared_boundary_cannot_join_sessions():
    value=session(state(6),[1,2,3],1)
    value=session(value,[4,5,6],2)
    assert geometry_lower_bound(value)['full']==0


def test_overlap_evidence_cannot_be_reused_for_more_fulls():
    value=state(6)
    for owner in range(1,6):value=session(value,[1,2,3,4],owner)
    value=session(value,[3,4,5,6],10)
    assert geometry_lower_bound(value)['full']==1


def test_secondary_current_file_whole_traversal_is_not_discarded():
    value=session(state(5),range(1,6),1,version=W)
    assert geometry_lower_bound(value)['full']==1
    assert geometry_lower_bound(value)['uninterrupted_full']==1
    assert value['groups']==[]


def test_heavier_alternate_partials_cannot_remove_prior_full():
    value=session(state(5),range(1,6),1)
    for owner in range(2,30):value=session(value,[1,2,3],owner,version=W)
    assert geometry_lower_bound(value)['full']==1


def test_contiguous_session_survives_more_than4096_fragments_and_many_pages():
    value=state(1);value['anchors']['1']['extent_frames48']=5000
    for start in range(0,5000,256):
        rows=[run(i+1,1,ordinal=i,start=i,frames=1,extent=5000) for i in range(start,min(start+256,5000))]
        value=advance_geometry(value,rows,owner_finished=start+256>=5000)
    assert geometry_lower_bound(value)['full']==1
    assert value['uninterrupted']==1
    assert value['pending'] is None


def test_thousands_identical_partial_geometries_use_counted_capacity():
    value=state(6)
    for owner in range(1,5002):value=session(value,[1,2,3,4],owner)
    value=session(value,[3,4,5,6],6000)
    assert len(value['groups'])==2
    assert max(g['count'] for g in value['groups'])==5001
    assert geometry_lower_bound(value)['full']==1


def test_one_total_endpoint_tolerance_not_one_allowance_per_gap():
    value=state(1)
    #0.5% total =2400frames, split1200each endpoint. Exceed just one side.
    value=advance_geometry(value,[run(1,1,start=1201,frames=EXTENT-1201)],owner_finished=True)
    assert geometry_lower_bound(value)['full']==0


def test_internal_gap_is_not_erased_by_endpoint_tolerance():
    value=state(1)
    value=advance_geometry(value,[run(1,1,frames=200000),
        run(2,1,ordinal=200000,start=200001,frames=EXTENT-200001)],owner_finished=True)
    assert geometry_lower_bound(value)['full']==0


def test_unknown_extent_or_nonzero_fast_seek_never_qualifies():
    for updates in ({'extent_frames48':None},{'source_base48':100},{'has_loss':True}):
        row=run(1,1);row.update(updates)
        value=advance_geometry(state(1),[row],owner_finished=True)
        assert geometry_lower_bound(value)['full']==0


def test_owner_and_continuity_breaks_do_not_create_uninterrupted_full():
    rows=[run(1,1,frames=EXTENT//2),run(2,1,ordinal=EXTENT//2,start=EXTENT//2,frames=EXTENT//2)]
    rows[1]['continuity_serial']=2
    value=advance_geometry(state(1),rows,owner_finished=True)
    assert geometry_lower_bound(value)['full']==0


def test_geometry_pruning_keeps_later_whole_traversals_and_original_state():
    value=state(2)
    # Distinct measured start boundaries produce more than MAX_GROUPS geometries without fulls.
    for owner in range(1,600):
        value=advance_geometry(value,[run(owner,1,owner=owner,start=owner,frames=EXTENT-owner)],owner_finished=True)
    assert value['pruned_segments']>0
    before=deepcopy(value)
    value=session(value,[1,2],1000)
    assert geometry_lower_bound(value)['full']==1
    assert before['uninterrupted']==0
    assert len(value['groups'])<=MAX_GROUPS


def test_three_overlapping_sessions_consume_exactly_three_qualifying_stretches():
    value=state(12)
    for owner,tracks in enumerate((range(1,6),range(4,10),range(8,13)),1):
        value=session(value,tracks,owner)
    result=geometry_lower_bound(value)
    assert result['full']==1
    assert result['partial_stretches']==0
    assert sum(group['count'] for group in value['groups'])==3


def test_excess_qualifying_stretches_are_reported_without_reusing_full_evidence():
    value=state(12)
    for owner,tracks in enumerate((range(1,6),range(4,10),range(8,13),range(1,6)),1):
        value=session(value,tracks,owner)
    result=geometry_lower_bound(value)
    assert result['full']==1 and result['partial_stretches']==1


def test_later_overlap_can_reduce_processed_partial_count_while_full_increases():
    value=session(state(12),range(1,6),1)
    value=session(value,range(8,13),2)
    before=geometry_lower_bound(value)
    assert before['full']==0 and before['partial_stretches']==2
    value=session(value,range(4,10),3)
    after=geometry_lower_bound(value)
    assert after['full']==1 and after['partial_stretches']==0
