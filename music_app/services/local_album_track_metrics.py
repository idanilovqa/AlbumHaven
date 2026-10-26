"""Bounded derived track time/depth inside the existing album page fold.

Actual rendered time and source-position depth are deliberately separate.
No raw spans, source paths, import aggregates or second acquisition pipeline.
"""
from copy import deepcopy

from music_app.services.album_listening_metrics import _candidate_target

DETAIL_POLICY = 'local-recorded-track-depth-v1'
MAX_TRACK_POINTS = 128
MAX_ALBUM_POINTS = 8192
MAX_VALUE = 2**53 - 1


def _int(value, low=0):
    return type(value) is int and low <= value <= MAX_VALUE


def compatible(snapshot, versions, extents):
    if not snapshot or snapshot.get('policy') != DETAIL_POLICY:
        return False
    return (all(versions.get(tuple(row[:3])) == row[3] for row in snapshot['versions'])
        and all(row['cohort'] is None or versions.get((int(key),row['cohort']['file_id'],row['cohort']['root_id']))==row['cohort']['version']
                for key,row in snapshot['tracks'].items())
        and all(row['cohort'] is None or row['cohort']['extent'] is None
                or extents.get((row['cohort']['file_id'],row['cohort']['version']))==row['cohort']['extent']
                for row in snapshot['tracks'].values())
        and all(extents.get((row[0],row[1])) == row[2] for row in snapshot['extents']))


def new_details(track_ids, prior=None):
    tracks = {}
    for track in track_ids:
        old = prior['tracks'].get(str(track)) if prior else None
        # Reserve old supported coordinates before discovering new earlier EOF
        # facts. Rebuild counts from raw evidence, never add old snapshot totals.
        tracks[str(track)] = dict(frames=0, time_unknown=False,
            cohort=deepcopy(old['cohort']) if old else None,
            points={key:0 for key in old['points']} if old else {},
            coverage_pruned=old['coverage_pruned'] if old else False)
    return dict(policy=DETAIL_POLICY,track_ids=list(track_ids),tracks=tracks,versions=[],extents=[],partial_stretches=None,
        partial_incomplete=True,seen=0,unsupported=0,cutoff=None)


def anchor_details(state, runs):
    for run in runs:
        row=state['tracks'][str(run['track_id'])]
        if row['cohort'] is None and run.get('source_version') is not None:
            row['cohort']=dict(version=run['source_version'],file_id=run['observed_file'],
                root_id=run['observed_root'],run_id=run['id'],extent=run.get('source_extent_frames48'))
        elif row['cohort'] is not None and row['cohort'].get('extent') is None:
            cohort=row['cohort']
            if (cohort['version']==run.get('source_version') and cohort['file_id']==run['observed_file']
                and run.get('source_extent_frames48') is not None):cohort['extent']=run['source_extent_frames48']


def advance_details(state, runs):
    points_count=sum(len(row['points']) for row in state['tracks'].values())
    for run in runs:
        state['seen']+=1
        row=state['tracks'][str(run['track_id'])]
        version=run.get('source_version')
        if version is None or run.get('has_loss') is not False or not _int(run.get('frames'),1):
            state['unsupported']+=1
            continue
        source=[run['track_id'],run['observed_file'],run['observed_root'],version]
        if source not in state['versions']:state['versions'].append(source)
        if row['frames'] <= MAX_VALUE-run['frames']:row['frames']+=run['frames']
        else:row['time_unknown']=True
        cohort=row['cohort']
        extent=run.get('source_extent_frames48')
        if (not cohort or cohort['version']!=version or cohort['file_id']!=run['observed_file']
            or run.get('observed_coordinate_basis') not in ('decoded-output-zero','decoded-output-absolute-wav48')
            or not _int(extent,1) or cohort['extent']!=extent
            or not _int(run.get('source_start48')) or run['source_start48']+run['frames']>extent):continue
        donor=[run['observed_file'],version,extent]
        if donor not in state['extents']:state['extents'].append(donor)
        start,end=run['source_start48'],run['source_start48']+run['frames']
        additions={str(start),str(end)}-row['points'].keys()
        if len(row['points'])+len(additions)>MAX_TRACK_POINTS or points_count+len(additions)>MAX_ALBUM_POINTS:
            row['coverage_pruned']=True
            continue
        if any(abs(row['points'].get(str(point),0))>=MAX_VALUE for point in (start,end)):
            row['coverage_pruned']=True
            continue
        for point in additions:row['points'][point]=0
        points_count+=len(additions)
        row['points'][str(start)]+=1;row['points'][str(end)]-=1


def project_details(snapshot, target):
    if not snapshot or snapshot.get('policy')!=DETAIL_POLICY or target is not None and not _int(target,1):return None
    tracks=[];required={};layers={};depths=[];recorded=0;time_unknown=False
    for track in snapshot['track_ids']:
        row=snapshot['tracks'][str(track)];cohort=row['cohort'];extent=cohort.get('extent') if cohort else None
        points={int(k):v for k,v in row['points'].items()}
        known=_int(extent,1)
        coverage=None;at_target=None;minimum=None
        if known:
            required[track]=extent;layers[track]=points
            depth=0;previous=0;covered=0;minimum=MAX_VALUE
            for coordinate in sorted(points):
                if coordinate>previous:
                    minimum=min(minimum,depth)
                    if depth>0:covered+=coordinate-previous
                depth+=points[coordinate];previous=coordinate
            if previous<extent:minimum=min(minimum,depth)
            minimum=0 if minimum==MAX_VALUE else minimum
            coverage={'numerator':covered,'denominator':extent};at_target=minimum>=target if target is not None else None;depths.append(minimum)
        time_unknown=time_unknown or row['time_unknown'] or recorded>MAX_VALUE-row['frames']
        recorded=min(MAX_VALUE,recorded+row['frames'])
        tracks.append(dict(track_id=str(track),recorded_frames=None if row['time_unknown'] else row['frames'],
            position_coverage=coverage,tracks_target_reached=at_target,minimum_position_depth=minimum,
            coverage_pruned=row['coverage_pruned'],extent_frames=extent if known else None))
    target_coverage=None;at_target=None
    if target is not None and len(required)==len(tracks) and required:
        denominator=sum(required.values())
        # The existing exact integer sweep caps replay depth at the current
        # target; unheard positions remain zero. Reject numeric overflow rather
        # than coercing into an apparently qualified result.
        if denominator*target<=MAX_VALUE:
            target_coverage,at_target=_candidate_target(layers,required,target,denominator)
    return dict(policy=DETAIL_POLICY,target=target,scope='processed-compatible-recorded-evidence',
        cutoff_checkpoint_id=snapshot['cutoff'],history_complete=False,
        recorded_frames=None if time_unknown else recorded,tracks=tracks,
        target_coverage=target_coverage,tracks_at_target=at_target,
        partial_stretches=snapshot['partial_stretches'],partial_incomplete=snapshot['partial_incomplete'],
        uneven_track_coverage=(len(set(depths))>1 if tracks and len(depths)==len(tracks)
            and snapshot['unsupported']==0 and not any(row['coverage_pruned'] for row in snapshot['tracks'].values()) else None),
        coverage_pruned=any(row['coverage_pruned'] for row in snapshot['tracks'].values()),
        unsupported_runs=snapshot['unsupported'])
