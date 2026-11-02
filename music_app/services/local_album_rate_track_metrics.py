"""Exact-seconds native track details composed without fictitious 48k frames."""
from copy import deepcopy
from fractions import Fraction
from music_app.services.playback_rate_evidence import MAX_FRAME, RateEvidenceError, pack_time, unpack_time
from music_app.services.local_album_track_metrics import project_details

POLICY = 'rate-recorded-track-depth-v1'
MAX_TRACK_POINTS = 128
MAX_ALBUM_POINTS = 8192


def new_rate_details(track_ids):
    return dict(tracks={str(track): dict(cohort=None, points={}, pruned=False) for track in track_ids},
                unsupported=0, cutoff=None)


def _key(time):
    return '/'.join(pack_time(time))


def _time(key):
    return unpack_time(key.split('/'))


def anchor_rate_details(snapshot, rows):
    if snapshot is None:
        return
    for row in rows:
        if row.get('eligible') is not True:
            continue
        projected = row['projection']
        track = snapshot['tracks'][str(row['track_id'])]
        if track['cohort'] is None and projected.source_extent is not None and projected.source_extent > 0:
            track['cohort'] = dict(file_id=row['file_id'], root_id=row['root_id'],
                version=row['source_version'], extent=pack_time(projected.source_extent))


def advance_rate_details(snapshot, rows):
    if snapshot is None:
        return
    points_count = sum(len(track['points']) for track in snapshot['tracks'].values())
    for row in rows:
        if row.get('eligible') is not True:
            snapshot['unsupported'] = min(MAX_FRAME, snapshot['unsupported'] + 1)
            continue
        projected = row['projection']
        track = snapshot['tracks'][str(row['track_id'])]
        cohort = track['cohort']
        if (cohort is None or projected.source_interval is None or projected.source_extent is None
                or cohort['file_id'] != row['file_id'] or cohort['root_id'] != row['root_id']
                or cohort['version'] != row['source_version']
                or unpack_time(cohort['extent']) != projected.source_extent):
            continue
        start, end = map(_key, projected.source_interval)
        additions = {start, end} - track['points'].keys()
        repeats = projected.repeat_count
        if (len(track['points']) + len(additions) > MAX_TRACK_POINTS
                or points_count + len(additions) > MAX_ALBUM_POINTS
                or any(abs(track['points'].get(key, 0)) > MAX_FRAME - repeats for key in (start, end))):
            track['pruned'] = True
            continue
        for key in additions:
            track['points'][key] = 0
        points_count += len(additions)
        track['points'][start] += repeats
        track['points'][end] -= repeats


def _sweep(points, extent, target):
    depth = 0
    previous = Fraction(0)
    covered = weighted = Fraction(0)
    minimum = None
    for coordinate, delta in sorted(points.items()):
        if coordinate > previous:
            minimum = depth if minimum is None else min(minimum, depth)
            if depth > 0:
                covered += coordinate - previous
            if target is not None:
                weighted += (coordinate - previous) * min(depth, target)
        depth += delta
        if not 0 <= depth <= MAX_FRAME:
            return None
        previous = coordinate
    if previous < extent:
        minimum = depth if minimum is None else min(minimum, depth)
    if previous > extent or depth != 0:
        return None
    return dict(extent=extent, covered=covered, minimum=0 if minimum is None else minimum,
                weighted=weighted, pruned=False)


def _legacy_geometry(track, target):
    cohort = track['cohort']
    if not cohort or cohort['extent'] is None or cohort['extent'] <= 0:
        return None
    geometry = _sweep({Fraction(int(key), 48000): delta for key, delta in track['points'].items()},
                      Fraction(cohort['extent'], 48000), target)
    if geometry is not None:
        geometry['pruned'] = track['coverage_pruned']
    return geometry


def _native_geometry(track, target):
    if track['cohort'] is None:
        return None
    geometry = _sweep({_time(key): delta for key, delta in track['points'].items()},
                      unpack_time(track['cohort']['extent']), target)
    if geometry is not None:
        geometry['pruned'] = track['pruned']
    return geometry


def _project_rate_details(state, target):
    """Compose only complete same-cut passes; select, never mix, depth cohorts.

    Time adds disjoint protocol occurrences. Position depth uses ONE supported
    cohort per track, selected by minimum depth then coverage fraction; separate
    legacy/native partial intervals never manufacture a higher depth together.
    Full occurrence composition remains the separately reviewed Full fold.
    """
    extension = state.get('rate')
    legacy = state.get('completed_details')
    if not extension or extension.get('phase') != 'complete':
        return project_details(legacy, target)
    native = extension.get('completed_track_details')
    if native is None:
        return project_details(legacy, target)
    legacy_available = legacy is not None and legacy['cutoff'] == native['cutoff']
    if not legacy_available:
        # Native-only lower bound: absent/older legacy details are not asserted
        # to contain zero listening, and are never added across snapshots.
        legacy = dict(unsupported=0, tracks={str(track): dict(frames=0, time_unknown=False,
            cohort=None, points={}, coverage_pruned=False) for track in state['track_ids']})
    if target is not None and (type(target) is not int or not 1 <= target <= MAX_FRAME):
        return None
    durations = extension['completed_duration']['tracks']
    tracks, geometries = [], []
    total = Fraction(0)
    unknown = False
    for track_id in state['track_ids']:
        key = str(track_id)
        old = legacy['tracks'][key]
        seconds = None if old['time_unknown'] else Fraction(old['frames'], 48000) + unpack_time(durations[key])
        if seconds is None:
            unknown = True
        else:
            total += seconds
        candidates = [value for value in (_legacy_geometry(old, target), _native_geometry(native['tracks'][key], target)) if value is not None]
        geometry = max(candidates, key=lambda value: (value['minimum'], value['covered'] / value['extent'])) if candidates else None
        geometries.append(geometry)
        tracks.append(dict(track_id=key, recorded_seconds=None if seconds is None else pack_time(seconds),
            extent_seconds=None if geometry is None else pack_time(geometry['extent']),
            position_coverage=None if geometry is None else pack_time(geometry['covered'] / geometry['extent']),
            minimum_position_depth=None if geometry is None else geometry['minimum'],
            tracks_target_reached=None if geometry is None or target is None else geometry['minimum'] >= target,
            coverage_pruned=False if geometry is None else geometry['pruned']))
    all_known = all(geometry is not None for geometry in geometries)
    target_coverage = None
    if target is not None and all_known:
        target_coverage = pack_time(sum((g['weighted'] for g in geometries), Fraction(0)) /
                                    (sum((g['extent'] for g in geometries), Fraction(0)) * target))
    unsupported = min(MAX_FRAME, legacy['unsupported'] + native['unsupported'])
    return dict(policy=POLICY, target=target, scope='processed-compatible-recorded-evidence',
        cutoff_checkpoint_id=native['cutoff'], history_complete=False,
        legacy_details_available=legacy_available,
        recorded_seconds=None if unknown else pack_time(total), tracks=tracks,
        target_coverage=target_coverage,
        tracks_at_target=None if target is None or not all_known else sum(g['minimum'] >= target for g in geometries),
        partial_stretches=extension['counts']['partial_stretches'], partial_incomplete=True,
        uneven_track_coverage=(len({g['minimum'] for g in geometries}) > 1 if all_known and legacy_available and unsupported == 0
            and not any(g['pruned'] for g in geometries) else None),
        coverage_pruned=any(track['coverage_pruned'] for track in tracks), unsupported_runs=unsupported)


def rate_details_compatible(state, versions, facts):
    extension = state.get('rate')
    if not extension or extension.get('completed_track_details') is None:
        return False
    if any(versions.get(tuple(row[:3])) != row[3] for row in extension['duration_versions']):
        return False
    for key, track in extension['completed_track_details']['tracks'].items():
        cohort = track['cohort']
        if cohort is None:
            continue
        fact = facts.get((cohort['file_id'], cohort['version']))
        if (versions.get((int(key), cohort['file_id'], cohort['root_id'])) != cohort['version']
                or fact is None or Fraction(fact[1], fact[0]) != unpack_time(cohort['extent'])):
            return False
    return True


def project_rate_details(state, target):
    # Optional precision/capacity must not disable supported Full progress.
    try:
        return _project_rate_details(state, target)
    except RateEvidenceError:
        return None
