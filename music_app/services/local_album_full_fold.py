"""Compact local-version geometry, fed only by the actual admitted-span reader.

No raw checkpoint copies, timestamps, provider jobs or content-proof claims.
Every closed monotone segment is admitted once; equivalent geometry stores a
capacity, not a growing list of raw IDs. Original candidate APIs stay unchanged.
"""
from copy import deepcopy
from fractions import Fraction
import json
from music_app.services.album_listening_metrics import (
    _CandidateGeometryFold, _candidate_actual_overlap, _candidate_flow_oracle,
    LOCAL_FULL_POLICY)

PAGE_RUNS = 256
MAX_GROUPS = 128
MAX_STATE_BYTES = 4 * 1024 * 1024
MAX_VALUE = 2**53 - 1


class LocalFullCapacity(Exception):
    """No page is committed when compact state cannot retain all leftovers."""


def _integer(value, minimum=0):
    return type(value) is int and minimum <= value <= MAX_VALUE


def new_geometry(track_ids, anchors):
    return dict(track_ids=track_ids, anchors=anchors, pending=None, groups=[],
                uninterrupted=0, seen_runs=0, unsupported_runs=0, pruned_segments=0, completed_versions=[])


def _close(state):
    pending = state['pending']
    if pending is None:
        return
    state['pending'] = None
    ids = state['track_ids']
    spans = pending['spans']
    # A whole uninterrupted traversal needs every track but need not use the
    # selected overlap cohort. Its own per-track admitted extents are sufficient.
    complete = len(spans) == len(ids) and [s['track_id'] for s in spans] == ids
    if complete:
        for span in spans:
            extent = span['extent_frames48']
            margin = min(Fraction(24000), Fraction(extent, 400))
            complete = complete and span['start'] <= margin and span['end'] >= extent - margin
    if complete:
        state['uninterrupted'] += 1
        state['completed_versions']=sorted(set(state['completed_versions'])|{s['local_version'] for s in spans})
        return  # Never reuse these spans in overlapping allocation.
    anchors = state['anchors']
    if any(str(track) not in anchors or anchors[str(track)].get('extent_frames48') is None for track in ids):
        return
    if any(s['local_version'] != anchors[str(s['track_id'])]['version'] for s in spans):
        return
    required = {track: anchors[str(track)]['extent_frames48'] for track in ids}
    fold = _CandidateGeometryFold(required, ids, span_limit=512, local_total_tolerance=True)
    fold.begin((0,))
    for span in spans:
        fold.add(span['track_id'], span['start'], span['end'])
    fold.end()
    _, _, _, groups, _, _ = fold.finish()
    for group in groups:
        packed = dict(a=[group['a'].numerator, group['a'].denominator],
                      b=[group['b'].numerator, group['b'].denominator],
                      actual=[list(value) for value in group['actual']])
        for old in state['groups']:
            if all(old[key] == packed[key] for key in packed):
                old['count'] += 1
                break
        else:
            if len(state['groups']) >= MAX_GROUPS:
                state['pruned_segments'] += 1
            else:
                state['groups'].append(dict(packed, count=1))


def advance_geometry(original, runs, *, owner_finished=False):
    """Atomic page fold. A thrown capacity error leaves the caller state intact.

    Rows must arrive in one owner/ordinal sequence at a time. The reader supplies
    exact source/selection/extent joins and loss flags; unknown rows break runs.
    Only the preceding endpoint and <=512 coalesced track spans cross a page.
    """
    if type(runs) is not list or len(runs) > PAGE_RUNS:
        raise ValueError('invalid_page')
    state = deepcopy(original)
    order = {track: index for index, track in enumerate(state['track_ids'])}
    for run in runs:
        state['seen_runs'] += 1
        required = ('id','owner_id','parent_id','binding_serial','generation','stream_id','epoch',
                    'continuity_serial','frames','extent_frames48')
        usable = (all(_integer(run.get(key),1) for key in required)
            and all(_integer(run.get(key)) for key in ('ordinal_start','output_start','source_start48','source_base48'))
            and run.get('track_id') in order and run.get('local_version') is not None
            and run['source_base48'] == 0 and run.get('has_loss') is False
            and run['source_start48'] + run['frames'] <= run['extent_frames48'])
        if not usable:
            _close(state)
            state['unsupported_runs'] += 1
            continue
        pending = state['pending']
        prior = pending['last'] if pending else None
        adjacent = (prior is not None and all(prior[key] == run[key] for key in
            ('owner_id','generation','epoch','continuity_serial'))
            and prior['ordinal_end'] == run['ordinal_start'] and prior['output_end'] == run['output_start'])
        same = adjacent and prior['track_id'] == run['track_id']
        contiguous = (same and prior['source_end'] == run['source_start48']
            and prior['local_version'] == run['local_version']
            and prior['extent_frames48'] == run['extent_frames48']
            and all(prior[key] == run[key] for key in ('parent_id','binding_serial','stream_id')))
        if adjacent and not same and order[run['track_id']] == order[prior['track_id']] + 1:
            contiguous = (prior['source_end'] >= prior['extent_frames48'] - min(Fraction(24000),Fraction(prior['extent_frames48'],400))
                and run['source_start48'] <= min(Fraction(24000),Fraction(run['extent_frames48'],400)))
        if not contiguous:
            _close(state)
            pending = state['pending'] = dict(spans=[],last=None)
        if contiguous and same:
            pending['spans'][-1]['end'] = run['source_start48'] + run['frames']
        else:
            pending['spans'].append(dict(track_id=run['track_id'],start=run['source_start48'],
                end=run['source_start48']+run['frames'],local_version=run['local_version'],
                extent_frames48=run['extent_frames48']))
        # Endpoint identity is bounded derived continuity state, not a raw copy.
        pending['last'] = {key:run[key] for key in ('owner_id','parent_id','binding_serial','generation',
            'stream_id','epoch','continuity_serial','track_id','local_version','extent_frames48')}
        pending['last'].update(ordinal_end=run['ordinal_start']+run['frames'],
            output_end=run['output_start']+run['frames'],source_end=run['source_start48']+run['frames'])
    if owner_finished:
        _close(state)
    if any(state[key] > MAX_VALUE for key in ('uninterrupted','seen_runs','unsupported_runs')):
        raise LocalFullCapacity('counter_capacity')
    # Only derived unallocated geometry is pruned, newest group first. Raw
    # evidence and the pending contiguous boundary remain untouched. Independent
    # later uninterrupted plays must never be starved by unusual old partials.
    while state['groups'] and len(json.dumps(state).encode()) > MAX_STATE_BYTES - 1024*1024:
        state['pruned_segments'] += state['groups'].pop()['count']
    if len(json.dumps(state).encode()) > MAX_STATE_BYTES - 1024*1024:
        raise LocalFullCapacity('state_capacity')
    return state


def geometry_lower_bound(state):
    """One existing cold flow oracle on <=128 counted geometries, no raw replay.

    Unlike canonical witness extraction, a count-only result needs no expanded
    token identities. Capacities conserve evidence exactly and can grow beyond
    4096. No count from an earlier snapshot is added to this result.
    """
    ids = state['track_ids']; anchors = state['anchors']
    overlap = 0; used_stretches = 0
    if all(str(track) in anchors and anchors[str(track)].get('extent_frames48') is not None for track in ids):
        extents = {track:anchors[str(track)]['extent_frames48'] for track in ids}
        core = _CandidateGeometryFold(extents,ids,local_total_tolerance=True).core_length
        groups = [dict(a=Fraction(*g['a']),b=Fraction(*g['b']),actual=tuple(tuple(v) for v in g['actual'])) for g in state['groups']]
        capacities = [g['count'] for g in state['groups']]
        outgoing = [[] for _ in groups]
        for i,left in enumerate(groups):
            for j,right in enumerate(groups):
                if right['b'] <= left['b'] or right['a'] > left['b']:
                    continue
                measured = _candidate_actual_overlap(left['actual'],right['actual'])
                if measured > 0:
                    outgoing[i].append((j,measured))
        overlap,cost = _candidate_flow_oracle(groups,capacities,outgoing,core)
        used_stretches = cost[0]
    return dict(full=state['uninterrupted']+overlap, uninterrupted_full=state['uninterrupted'],
                partial_stretches=sum(g['count'] for g in state['groups'])-used_stretches,
                partial_incomplete=state['pruned_segments']>0 or state['unsupported_runs']>0,
                policy_version=LOCAL_FULL_POLICY,support_versions=sorted(set(state['completed_versions'])
                    | ({anchors[str(track)]['version'] for track in ids} if overlap else set())))
