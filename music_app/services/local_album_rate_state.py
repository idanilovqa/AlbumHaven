"""Private bounded continuation in the existing album metrics state row.

This is derived measurement state only. It neither opens nor changes playback.
The owning Full-state service supplies its authenticated transaction and frozen
checkpoint cut; this module never commits, reserves quota or creates a new cut.
"""
from copy import deepcopy
from datetime import datetime, timezone
from fractions import Fraction

from music_app.services.local_album_full_fold import LocalFullCapacity, geometry_lower_bound
from music_app.services.local_album_rate_full_fold import (
    new_rate_geometry, advance_rate_geometry, rate_geometry_lower_bound, _close,
)
from music_app.services.local_album_rate_reader import (
    RateCursor, next_rate_owner, read_rate_page, geometry_row,
)
from music_app.services.playback_rate_evidence import MAX_FRAME, exact_timebase, exact_ticks, pack_time, unpack_time

from music_app.services.local_album_rate_track_metrics import (
    new_rate_details, anchor_rate_details, advance_rate_details,
)

STATE_VERSION = 'rate-checkpoint-full-composition-v2'


def start_rate(state, facts, rates, *, prior=None):
    """Freeze explicit timebase and source facts with the parent's raw cut."""
    previous = prior.get('rate', {}) if prior else {}
    state['policy'] = STATE_VERSION
    state['rate'] = dict(version=STATE_VERSION, phase='anchors', owner=0, cursor=None,
        facts=[[file, version, rate, extent] for (file, version), (rate, extent) in sorted(facts.items())],
        timebase=str(exact_timebase(sorted(set(rates) | {48000}))),
        identity=True, identity_extents=[], anchors={}, geometry=None, mode=None,
        legacy_counts=None, best_facts=deepcopy(previous.get('best_facts', [])),
        fresh_streams={}, duration_seconds={str(track): ['0', '1'] for track in state['track_ids']},
        duration_versions=[], completed_duration=None,
        track_details=new_rate_details(state['track_ids']), completed_track_details=None)
    return state


def compatible_rate(state, facts, *, best_only=False):
    extension = state.get('rate')
    if extension is None:
        return best_only  # Retain old lower bound, but rebuild the derived cache.
    if extension.get('version') != STATE_VERSION:
        return False
    return all(facts.get((file, version)) == (rate, extent)
               for file, version, rate, extent in extension['best_facts' if best_only else 'facts'])


def observe_legacy_identity(state, rows):
    """Only proven original native48 can share source geometry with new rows."""
    extension = state.get('rate')
    if not extension or state['phase'] != 'anchors':
        return
    identities = {(file, version): extent for file, version, extent in extension['identity_extents']}
    for row in rows:
        extent = row.get('extent_frames48')
        if (row.get('local_version') is None or type(extent) is not int or extent <= 0
                or row.get('has_loss') is not False or row.get('source_base48') != 0
                or type(row.get('source_start48')) is not int or row['source_start48'] < 0
                or type(row.get('frames')) is not int or row['frames'] <= 0
                or row['source_start48'] + row['frames'] > extent):
            continue
        if row.get('observed_coordinate_basis') != 'decoded-output-absolute-wav48':
            extension['identity'] = False
            continue
        key = (row['observed_file'], row['local_version'])
        if key in identities and identities[key] != extent:
            extension['identity'] = False
        identities[key] = extent
    extension['identity_extents'] = [[file, version, extent] for (file, version), extent in sorted(identities.items())]


def _facts(extension):
    return {(file, version): (rate, extent) for file, version, rate, extent in extension['facts']}


def _capture_legacy(state):
    extension = state['rate']
    if extension['legacy_counts'] is not None:
        return
    extension['legacy_counts'] = (geometry_lower_bound(state['geometry']) if state.get('geometry')
        else dict(full=0, uninterrupted_full=0, partial_stretches=0, support_versions=[]))
    # Never reuse both the previous geometry and a raw joint replay.
    state['geometry'] = None


def _record_heard(state, rows):
    extension = state['rate']
    versions = {tuple(row[:3]): row[3] for row in state['versions']}
    for row in rows:
        if row.get('eligible') is not True:
            continue
        projected = row['projection']
        seconds = projected.eligible_source_seconds
        key = str(row['track_id'])
        total = unpack_time(extension['duration_seconds'][key]) + seconds
        extension['duration_seconds'][key] = pack_time(total)
        dependency = [row['track_id'], row['file_id'], row['root_id'], row['source_version']]
        if dependency not in extension['duration_versions']:
            extension['duration_versions'].append(dependency)
        opened = row.get('opened_at')
        if not isinstance(opened, datetime) or opened.tzinfo is None:
            continue
        stream = str(projected.parent_id) + ':' + projected.map_ref
        pending = extension['fresh_streams']
        if stream not in pending and len(pending) >= 128:
            pending.pop(next(iter(pending)))
            state['fresh_pruned'] = True
        pending[stream] = pack_time(min(Fraction(11), unpack_time(pending.get(stream, ['0', '1'])) + seconds))
        lower = opened.astimezone(timezone.utc).isoformat(timespec='microseconds')
        if (unpack_time(pending[stream]) > 10
                and (state['fresh_after'] is None or lower > state['fresh_after'])
                and versions.get(tuple(dependency[:3])) == dependency[3]):
            state['fresh_after'], state['fresh_versions'] = lower, [dependency]


def _finish(state):
    from music_app.services.local_album_full_state import _preserve_best
    extension = state['rate']
    counts = rate_geometry_lower_bound(extension['geometry'])
    if extension['mode'] == 'split':
        legacy = extension['legacy_counts']
        counts = dict(counts,
            full=counts['full'] + legacy['full'],
            uninterrupted_full=counts['uninterrupted_full'] + legacy['uninterrupted_full'],
            partial_stretches=counts['partial_stretches'] + legacy['partial_stretches'],
            support_versions=sorted(set(counts['support_versions']) | set(legacy['support_versions'])))
    if any(counts[key] > MAX_FRAME for key in ('full', 'uninterrupted_full', 'partial_stretches')):
        raise LocalFullCapacity('rate_counter_capacity')
    improving = counts['full'] > state['best_full'] or counts['uninterrupted_full'] > state['best_uninterrupted']
    _preserve_best(state, counts)
    if improving:
        support = set(counts['support_versions'])
        extension['best_facts'] = [list(row) for row in sorted(
            {tuple(row) for row in extension['best_facts']} |
            {tuple(row) for row in extension['facts'] if row[1] in support})]
    extension['counts'] = counts
    extension['completed_duration'] = dict(unit='exact-rational-seconds',
        tracks=deepcopy(extension['duration_seconds']), incomplete=True)
    if extension['track_details'] is not None:
        extension['track_details']['cutoff'] = None if state['cutoff'] is None else str(state['cutoff'])
    extension['completed_track_details'] = deepcopy(extension['track_details'])
    extension['phase'] = 'complete'
    state['phase'] = 'complete'
    state['completed_cutoff'] = state['cutoff']
    return state


def advance_rate_extension(connection, live, selected, state):
    """One <=256-span page. Caller deep-copies state before invoking."""
    extension = state['rate']
    _capture_legacy(state)
    if extension['phase'] == 'legacy_joint':
        return _advance_legacy_joint(connection, live, selected, state)
    phase, units = extension['phase'], int(extension['timebase'])
    versions = {tuple(row[:3]): row[3] for row in state['versions']}
    if extension['owner'] == 0 and state['cutoff'] is not None:
        extension['owner'] = next_rate_owner(connection, live, selected, state['cutoff']) or 0
    if extension['owner']:
        cursor = RateCursor(*extension['cursor']) if extension['cursor'] is not None else None
        page = read_rate_page(connection, live, selected, versions, _facts(extension),
            owner_id=extension['owner'], cutoff=state['cutoff'], cursor=cursor)
        rows, more = page.rows, page.has_more
        if page.cursor is not None:
            extension['cursor'] = [page.cursor.owner_id, page.cursor.checkpoint_id, page.cursor.span_index]
    else:
        rows, more = (), False
    identities = {(file, version): extent for file, version, extent in extension['identity_extents']}
    geometric = []
    for row in rows:
        if row.get('eligible') is not True:
            geometric.append({'eligible': False})
            continue
        projected = row['projection']
        geometry = geometry_row(projected, track_id=row['track_id'], source_version=row['source_version'],
            timebase=units, selection_and_version_qualified=True)
        geometric.append(geometry)
        identity = identities.get((row['file_id'], row['source_version']))
        if identity is not None and (row['source_rate_hz'] != 48000
                or projected.source_extent != Fraction(identity, 48000)):
            extension['identity'] = False
        if phase == 'anchors' and geometry['eligible']:
            key = str(row['track_id'])
            # First admitted row in the fixed owner/sequence pass anchors a cohort.
            extension['anchors'].setdefault(key, dict(version=row['source_version'], extent_ticks=geometry['extent_ticks']))
    if phase == 'anchors':
        anchor_rate_details(extension['track_details'], rows)
    else:
        advance_rate_details(extension['track_details'], rows)
        _record_heard(state, rows)
        if state.get('full_supported', True):
            extension['geometry'] = advance_rate_geometry(extension['geometry'], geometric, owner_finished=not more)
    if more:
        return state
    following = (next_rate_owner(connection, live, selected, state['cutoff'], extension['owner'])
                 if extension['owner'] else None)
    extension['owner'], extension['cursor'] = following or 0, None
    if following is not None:
        return state
    if phase == 'anchors':
        extension['mode'] = 'joint' if extension['identity'] and state.get('full_supported', True) else 'split'
        anchors = deepcopy(extension['anchors'])
        if extension['mode'] == 'joint':
            for key, anchor in state['anchors'].items():
                extent = anchor.get('extent_frames48')
                if extent is not None and any(version == anchor['version'] and old == extent
                        for _file, version, old in extension['identity_extents']):
                    anchors[key] = dict(version=anchor['version'], extent_ticks=str(exact_ticks(Fraction(extent, 48000), units)))
        extension['geometry'] = new_rate_geometry(state['track_ids'], anchors, units)
        extension['phase'] = 'legacy_joint' if extension['mode'] == 'joint' else 'fold'
        extension['legacy_ordinal'] = -1
        return state
    return _finish(state)


def _legacy_geometry_page(geometry, rows, *, finished):
    """Scale proven source geometry only; retain original legacy continuity."""
    order = {track: index for index, track in enumerate(geometry['track_ids'])}
    units = int(geometry['timebase'])
    for row in rows:
        geometry['seen_rows'] += 1
        usable = (row.get('local_version') is not None and row.get('has_loss') is False
            and row.get('observed_coordinate_basis') == 'decoded-output-absolute-wav48'
            and row.get('source_base48') == 0 and row.get('track_id') in order
            and all(type(row.get(key)) is int and 0 < row[key] <= MAX_FRAME for key in
                ('owner_id', 'parent_id', 'binding_serial', 'generation', 'stream_id', 'epoch',
                 'continuity_serial', 'frames', 'extent_frames48'))
            and all(type(row.get(key)) is int and 0 <= row[key] <= MAX_FRAME for key in
                ('ordinal_start', 'output_start', 'source_start48'))
            and row['source_start48'] + row['frames'] <= row['extent_frames48']
            and row['ordinal_start'] + row['frames'] <= MAX_FRAME
            and row['output_start'] + row['frames'] <= MAX_FRAME)
        if not usable:
            _close(geometry)
            geometry['unsupported_rows'] += 1
            continue
        pending = geometry['pending']
        prior = pending['last'] if pending else None
        adjacent = (prior is not None and prior.get('clock_kind') == 'legacy-v2-evidence48'
            and all(prior[key] == row[key] for key in ('owner_id', 'generation', 'epoch', 'continuity_serial'))
            and prior['ordinal_end'] == row['ordinal_start'] and prior['output_end'] == row['output_start'])
        same = adjacent and prior['track_id'] == row['track_id']
        contiguous = (same and prior['source_end48'] == row['source_start48']
            and all(prior[key] == row[key] for key in
                ('parent_id', 'binding_serial', 'stream_id', 'local_version', 'extent_frames48')))
        if adjacent and not same and order[row['track_id']] == order[prior['track_id']] + 1:
            contiguous = (prior['source_end48'] >= prior['extent_frames48'] - min(Fraction(24000), Fraction(prior['extent_frames48'], 400))
                and row['source_start48'] <= min(Fraction(24000), Fraction(row['extent_frames48'], 400)))
        if not contiguous:
            _close(geometry)
            pending = geometry['pending'] = dict(spans=[], last=None)
        end = str(exact_ticks(Fraction(row['source_start48'] + row['frames'], 48000), units))
        if contiguous and same:
            pending['spans'][-1]['end_ticks'] = end
        else:
            if len(pending['spans']) >= 512:
                raise LocalFullCapacity('rate_span_capacity')
            pending['spans'].append(dict(track_id=row['track_id'],
                start_ticks=str(exact_ticks(Fraction(row['source_start48'], 48000), units)),
                end_ticks=end, version=row['local_version'],
                extent_ticks=str(exact_ticks(Fraction(row['extent_frames48'], 48000), units))))
        pending['last'] = {key: row[key] for key in ('owner_id', 'parent_id', 'binding_serial',
            'generation', 'stream_id', 'epoch', 'continuity_serial', 'track_id', 'local_version', 'extent_frames48')}
        pending['last'].update(clock_kind='legacy-v2-evidence48',
            source_end48=row['source_start48'] + row['frames'],
            ordinal_end=row['ordinal_start'] + row['frames'], output_end=row['output_start'] + row['frames'])
    return advance_rate_geometry(geometry, [], owner_finished=finished)


def _advance_legacy_joint(connection, live, selected, state):
    from music_app.services.local_album_full_state import _runs, _next_owner
    extension = state['rate']
    if extension['owner'] == 0:
        extension['owner'] = _next_owner(connection, live, selected, dict(state, owner=0)) or 0
    if extension['owner'] == 0:
        extension['phase'] = 'fold'
        return state
    scoped = dict(state, owner=extension['owner'], ordinal=extension['legacy_ordinal'])
    rows = _runs(connection, live, selected, scoped)
    page, finished = rows[:256], len(rows) <= 256
    extension['geometry'] = _legacy_geometry_page(extension['geometry'], page, finished=finished)
    if page:
        extension['legacy_ordinal'] = page[-1]['ordinal_start']
    if finished:
        extension['owner'] = _next_owner(connection, live, selected, scoped) or 0
        extension['legacy_ordinal'] = -1
        if extension['owner'] == 0:
            extension['phase'] = 'fold'
    return state
