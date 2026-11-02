"""Occurrence-aware exact-tick adapter over admitted rate-aware reader rows.

Ticks are an explicitly frozen measurement timebase, never playback samples.
The generic geometry/flow algorithms are reused with their units parameter;
no decoder, scheduling, source admission or legacy run conversion happens here.
"""
from copy import deepcopy
from fractions import Fraction
import json

from music_app.services.album_listening_metrics import (
    _CandidateGeometryFold, _candidate_actual_overlap, _candidate_flow_oracle,
)
from music_app.services.local_album_full_fold import LocalFullCapacity
from music_app.services.playback_rate_evidence import (
    MAX_FRAME, MAX_RATIONAL, MIN_RATE, MAX_RATE, pack_time, unpack_time,
)


PROFILE = 'rate-tagged-occurrence-geometry-v1'
PAGE_ROWS = 256
MAX_GROUPS = 128
MAX_STATE_BYTES = 4 * 1024 * 1024
MAX_TRACKS = 512
MAX_ENDPOINTS = 8192


def _tick(value):
    if (type(value) is not str or not value or len(value) > 39
            or not value.isascii() or not value.isdecimal()
            or len(value) > 1 and value[0] == '0'):
        raise ValueError('invalid_rate_geometry_tick')
    result = int(value)
    if result > MAX_RATIONAL:
        raise LocalFullCapacity('rate_geometry_capacity')
    return result


def _count(value, minimum=0):
    if type(value) is not int or not minimum <= value <= MAX_FRAME:
        raise ValueError('invalid_rate_geometry_identity')
    return value


def new_rate_geometry(track_ids, anchors, timebase):
    if (type(track_ids) is not list or not 1 <= len(track_ids) <= MAX_TRACKS
            or any(type(track) is not int or not 1 <= track <= MAX_FRAME for track in track_ids)
            or len(set(track_ids)) != len(track_ids)
            or type(anchors) is not dict or set(anchors) - {str(t) for t in track_ids}
            or type(timebase) is not int or not 1 <= timebase <= MAX_RATIONAL):
        raise ValueError('invalid_rate_geometry')
    for anchor in anchors.values():
        if (type(anchor) is not dict or set(anchor) != {'version', 'extent_ticks'}
                or type(anchor['version']) is not str or not anchor['version']):
            raise ValueError('invalid_rate_geometry_anchor')
        if anchor['extent_ticks'] is not None and _tick(anchor['extent_ticks']) == 0:
            raise ValueError('invalid_rate_geometry_anchor')
    return dict(profile=PROFILE, timebase=str(timebase), track_ids=list(track_ids),
                anchors=deepcopy(anchors), pending=None, groups=[],
                uninterrupted=0, seen_rows=0, unsupported_rows=0,
                completed_versions=[])


def _required(state):
    anchors = state['anchors']
    if any(str(track) not in anchors or anchors[str(track)]['extent_ticks'] is None
           for track in state['track_ids']):
        return None
    return {track: _tick(anchors[str(track)]['extent_ticks']) for track in state['track_ids']}


def _close(state, multiplicity=1):
    _count(multiplicity, 1)
    pending = state['pending']
    if pending is None:
        return
    state['pending'] = None
    spans, ids, units = pending['spans'], state['track_ids'], _tick(state['timebase'])
    complete = len(spans) == len(ids) and [s['track_id'] for s in spans] == ids
    if complete:
        for span in spans:
            extent = _tick(span['extent_ticks'])
            margin = min(Fraction(units, 2), Fraction(extent, 400))
            complete = complete and (_tick(span['start_ticks']) <= margin
                                     and _tick(span['end_ticks']) >= extent - margin)
    if complete:
        state['uninterrupted'] += multiplicity
        state['completed_versions'] = sorted(set(state['completed_versions'])
            | {span['version'] for span in spans})
        return  # These actual occurrences cannot also fund overlap allocation.
    required = _required(state)
    if required is None or any(span['version'] != state['anchors'][str(span['track_id'])]['version']
                               for span in spans):
        return
    fold = _CandidateGeometryFold(required, ids, span_limit=MAX_TRACKS,
                                  local_total_tolerance=True, units_per_second=units)
    fold.begin((0,))
    for span in spans:
        fold.add(span['track_id'], _tick(span['start_ticks']), _tick(span['end_ticks']))
    fold.end()
    _, _, _, groups, _, _ = fold.finish()
    for group in groups:
        packed = dict(a=pack_time(group['a']), b=pack_time(group['b']),
                      actual=[[track, str(start), str(end)] for track, start, end in group['actual']])
        for old in state['groups']:
            if all(old[key] == packed[key] for key in packed):
                old['count'] += multiplicity
                break
        else:
            if len(state['groups']) >= MAX_GROUPS:
                raise LocalFullCapacity('rate_group_capacity')
            state['groups'].append(dict(packed, count=multiplicity))


def _usable(row, order):
    if type(row) is not dict or row.get('eligible') is not True:
        return False
    try:
        for key in ('owner_id', 'parent_id', 'track_id', 'continuity_serial', 'coordinate_rate_hz',
                    'generation', 'stream_id', 'frame_count', 'repeat_count'):
            _count(row[key], 1)
        for key in ('output_start_frame', 'output_end_frame'):
            _count(row[key])
        start, end, extent = (_tick(row[key]) for key in ('start_ticks', 'end_ticks', 'extent_ticks'))
        return (row['track_id'] in order and 0 <= start < end <= extent
                and MIN_RATE <= row['coordinate_rate_hz'] <= MAX_RATE
                and row['frame_count'] * row['repeat_count'] <= MAX_FRAME
                and row['output_end_frame'] - row['output_start_frame'] == row['frame_count'] * row['repeat_count']
                and type(row['map_ref']) is str and bool(row['map_ref'])
                and type(row['version']) is str and bool(row['version']))
    except (KeyError, ValueError):
        return False


def _append_one(state, row, order, units):
    prior = state['pending']['last'] if state['pending'] else None
    adjacent = (prior is not None and all(prior[key] == row[key] for key in
        ('owner_id', 'coordinate_rate_hz', 'continuity_serial', 'generation'))
        and prior['output_end_frame'] == row['output_start_frame'])
    same = adjacent and prior['track_id'] == row['track_id']
    contiguous = (same and all(prior[key] == row[key] for key in
        ('parent_id', 'map_ref', 'stream_id', 'version', 'extent_ticks'))
        and prior['end_ticks'] == row['start_ticks'])
    if adjacent and not same and order[row['track_id']] == order[prior['track_id']] + 1:
        extent, start = _tick(prior['extent_ticks']), _tick(row['start_ticks'])
        contiguous = (_tick(prior['end_ticks']) >= extent - min(Fraction(units, 2), Fraction(extent, 400))
            and start <= min(Fraction(units, 2), Fraction(_tick(row['extent_ticks']), 400)))
    if not contiguous:
        _close(state)
        state['pending'] = dict(spans=[], last=None)
    pending = state['pending']
    if contiguous and same:
        pending['spans'][-1]['end_ticks'] = row['end_ticks']
    else:
        if len(pending['spans']) >= MAX_TRACKS:
            raise LocalFullCapacity('rate_span_capacity')
        pending['spans'].append({key: row[key] for key in
            ('track_id', 'start_ticks', 'end_ticks', 'version', 'extent_ticks')})
    pending['last'] = {key: row[key] for key in (
        'owner_id', 'parent_id', 'track_id', 'map_ref', 'coordinate_rate_hz', 'generation', 'stream_id',
        'continuity_serial', 'output_end_frame', 'end_ticks', 'extent_ticks', 'version')}


def advance_rate_geometry(original, rows, *, owner_finished=False):
    """Atomic bounded page: failure never mutates state or consumes its cursor."""
    if (original.get('profile') != PROFILE or type(rows) is not list
            or len(rows) > PAGE_ROWS or type(owner_finished) is not bool):
        raise ValueError('invalid_rate_geometry_page')
    state = deepcopy(original)
    units = _tick(state['timebase'])
    if units == 0:
        raise ValueError('invalid_rate_timebase')
    order = {track: index for index, track in enumerate(state['track_ids'])}
    for row in rows:
        state['seen_rows'] += 1
        if not _usable(row, order):
            _close(state)
            state['unsupported_rows'] += 1
            continue
        source_product = (_tick(row['end_ticks']) - _tick(row['start_ticks'])) * row['coordinate_rate_hz']
        output_product = row['frame_count'] * units
        if max(source_product, output_product).bit_length() > 255:
            raise LocalFullCapacity('rate_geometry_capacity')
        if source_product > output_product:
            raise ValueError('source_duration_exceeds_rendered_duration')
        repeats, period = row['repeat_count'], row['frame_count']
        first = dict(row, repeat_count=1,
                     output_end_frame=row['output_start_frame'] + period)
        _append_one(state, first, order, units)
        if repeats > 1:
            # A source wrap ends an occurrence, regardless of output continuity.
            _close(state)
            if repeats > 2:
                middle = dict(first, output_start_frame=first['output_end_frame'],
                              output_end_frame=first['output_end_frame'] + period)
                _append_one(state, middle, order, units)
                _close(state, multiplicity=repeats - 2)
            last = dict(first, output_start_frame=row['output_end_frame'] - period,
                        output_end_frame=row['output_end_frame'])
            _append_one(state, last, order, units)
    if owner_finished:
        _close(state)
    if any(state[key] > MAX_FRAME for key in ('uninterrupted', 'seen_rows', 'unsupported_rows')):
        raise LocalFullCapacity('rate_counter_capacity')
    if any(group['count'] > MAX_FRAME for group in state['groups']):
        raise LocalFullCapacity('rate_counter_capacity')
    endpoints = 2 * sum(len(group['actual']) for group in state['groups'])
    endpoints += 2 * len(state['pending']['spans']) if state['pending'] else 0
    if endpoints > MAX_ENDPOINTS or len(json.dumps(state).encode('utf-8')) > MAX_STATE_BYTES:
        raise LocalFullCapacity('rate_state_capacity')
    return state


def rate_geometry_lower_bound(state):
    if state.get('profile') != PROFILE:
        raise ValueError('invalid_rate_geometry')
    required = _required(state)
    overlap, used = 0, 0
    if required is not None:
        core = _CandidateGeometryFold(required, state['track_ids'], local_total_tolerance=True,
            units_per_second=_tick(state['timebase'])).core_length
        groups = [dict(a=unpack_time(group['a']), b=unpack_time(group['b']),
            actual=tuple((track, _tick(start), _tick(end)) for track, start, end in group['actual']))
            for group in state['groups']]
        outgoing = [[] for _ in groups]
        for index, left in enumerate(groups):
            for target, right in enumerate(groups):
                if right['b'] <= left['b'] or right['a'] > left['b']:
                    continue
                measured = _candidate_actual_overlap(left['actual'], right['actual'])
                if measured > 0:
                    outgoing[index].append((target, measured))
        overlap, cost = _candidate_flow_oracle(groups, [g['count'] for g in state['groups']], outgoing, core)
        used = cost[0]
    full = state['uninterrupted'] + overlap
    partial = sum(g['count'] for g in state['groups']) - used
    if not 0 <= full <= MAX_FRAME or not 0 <= partial <= MAX_FRAME:
        raise LocalFullCapacity('rate_counter_capacity')
    return dict(full=full, uninterrupted_full=state['uninterrupted'],
                partial_stretches=partial,
                partial_incomplete=state['unsupported_rows'] > 0, policy_version=PROFILE,
                support_versions=sorted(set(state['completed_versions']) |
                    ({anchor['version'] for anchor in state['anchors'].values()} if overlap else set())))
